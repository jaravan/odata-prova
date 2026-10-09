// UI5's ODataModel batches by default, so most reads and writes arrive here as one
// multipart POST instead of hitting the service directly. We unpack each part, run it
// through service.dispatch(), and combine the results back into a multipart response.
// Changesets are atomic - we snapshot the store first and roll back if any part fails -
// and within one, `$<Content-ID>/Nav` can reference an entity a prior part just created.
import { HttpError, decodeUrl } from "./query.ts";

// Splits a multipart body on "--<boundary>", dropping the leading preamble and the
// trailing "--" epilogue that follows the closing "--<boundary>--" delimiter.
function splitMultipart(bodyText, boundary) {
  const segments = bodyText.split(`--${boundary}`);
  return segments
    .slice(1, -1)
    .map((s) => s.replace(/^\r?\n/, "").replace(/\r?\n$/, ""));
}

function splitOnceOnBlankLine(text) {
  const match = text.match(/\r?\n\r?\n/);
  if (!match) return [text, ""];
  return [
    text.slice(0, match.index),
    text.slice(match.index + match[0].length),
  ];
}

function parseHeaders(headBlock) {
  const headers = {};
  for (const line of headBlock.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > -1)
      headers[line.slice(0, idx).trim().toLowerCase()] = line
        .slice(idx + 1)
        .trim();
  }
  return headers;
}

function extractBoundary(contentType) {
  const match = (contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? (match[1] || match[2]).trim() : undefined;
}

// Parses the "METHOD url HTTP/1.1\r\nHeader: ...\r\n\r\n<body>" text embedded in an
// application/http batch part.
function parseHttpRequestPart(text) {
  const [headBlock, bodyText] = splitOnceOnBlankLine(text);
  const lines = headBlock.split(/\r?\n/);
  const [method, rawUrl] = (lines[0] || "").trim().split(" ");
  return {
    method: (method || "GET").toUpperCase(),
    rawUrl: rawUrl || "",
    headers: parseHeaders(lines.slice(1).join("\r\n")),
    bodyText: bodyText.trim(),
  };
}

const STATUS_TEXT = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  500: "Internal Server Error",
};

function renderHttpResponsePart(result, protocol, contentId) {
  let headers = "";
  for (const [k, v] of Object.entries({
    ...protocol.headers,
    ...(result.headers || {}),
  }))
    headers += `${k}: ${v}\r\n`;
  if (contentId) headers += `Content-ID: ${contentId}\r\n`;
  let bodyText = "";
  if (result.status !== 204 && result.body !== undefined) {
    headers += `Content-Type: ${result.contentType || "application/json"}\r\n`;
    bodyText =
      typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body);
  }
  return `HTTP/1.1 ${result.status} ${STATUS_TEXT[result.status] || ""}\r\n${headers}\r\n${bodyText}`;
}

function createBatchHandler(service) {
  const { store, protocol } = service;

  // contentIdRefs: { "1": "/odata/v4/Srv/PurchaseOrderSet('x')" } within the current changeset.
  function executeHttpPart(
    { method, rawUrl, headers, bodyText },
    contentIdRefs,
  ) {
    let url = rawUrl.replace(/^https?:\/\/[^/]+/i, "");
    const ref = url.match(/^\$([^/?]+)(.*)$/);
    if (ref) {
      const target = contentIdRefs[ref[1]];
      if (!target)
        return protocol.error(400, `Unknown Content-ID reference $${ref[1]}`);
      url = target + ref[2];
    }
    if (!url.startsWith("/")) url = `${service.servicePath}/${url}`;
    const [pathOnly, queryString] = url.split("?");
    const query = Object.fromEntries(new URLSearchParams(queryString || ""));

    let parsedBody;
    if (bodyText) {
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        parsedBody = undefined;
      }
    }
    let resourcePath;
    try {
      resourcePath = decodeUrl(pathOnly);
    } catch (e) {
      return protocol.error(e.status, e.message);
    }
    const result = service.dispatch(
      method,
      resourcePath,
      query,
      parsedBody,
      headers,
    );
    if (headers["content-id"] && result.headers?.Location)
      contentIdRefs[headers["content-id"]] = result.headers.Location;
    return result;
  }

  // A batch part is either a single "application/http" request, or a nested
  // "multipart/mixed" changeset containing several write requests.
  function processBatchPart(rawPart) {
    const [outerHeadBlock, remainder] = splitOnceOnBlankLine(rawPart);
    const outerContentType = parseHeaders(outerHeadBlock)["content-type"] || "";

    if (/multipart\/mixed/i.test(outerContentType)) {
      const innerBoundary = extractBoundary(outerContentType);
      const snapshot = store.snapshot();
      const refs = {};
      const results = [];
      for (const p of splitMultipart(remainder, innerBoundary)) {
        // Each changeset member is itself an "application/http"-wrapped part, so its own
        // Content-Type/Content-ID header block has to be peeled off first.
        const [innerHead, innerRemainder] = splitOnceOnBlankLine(p);
        const request = parseHttpRequestPart(innerRemainder);
        const contentId =
          parseHeaders(innerHead)["content-id"] ||
          request.headers["content-id"];
        if (contentId) request.headers["content-id"] = contentId;
        const result = executeHttpPart(request, refs);
        results.push({ result, contentId });
        if (result.status >= 400) {
          store.restore(snapshot);
          break;
        }
      }
      return { changeset: true, results };
    }
    return {
      changeset: false,
      results: [
        { result: executeHttpPart(parseHttpRequestPart(remainder), {}) },
      ],
    };
  }

  function buildBatchResponseBody(processedParts, boundary) {
    const chunks = processedParts.map((part) => {
      // A changeset is atomic: if any member request fails, the whole changeset reports as
      // a single error instead of a nested multipart.
      const failed = part.changeset
        ? part.results.find((r) => r.result.status >= 400)
        : undefined;

      if (part.changeset && !failed) {
        const csBoundary = `changesetresponse_${Math.random().toString(36).slice(2)}`;
        const csBody = part.results
          .map(
            ({ result, contentId }) =>
              `--${csBoundary}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n${renderHttpResponsePart(result, protocol, contentId)}\r\n`,
          )
          .join("");
        return `--${boundary}\r\nContent-Type: multipart/mixed; boundary=${csBoundary}\r\n\r\n${csBody}--${csBoundary}--\r\n`;
      }

      const { result } = failed || part.results[0];
      return `--${boundary}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n${renderHttpResponsePart(result, protocol)}\r\n`;
    });
    chunks.push(`--${boundary}--\r\n`);
    return chunks.join("");
  }

  // Express handler for POST $batch (expects express.raw() to have run first).
  return (req, res) => {
    const boundary = extractBoundary(req.headers["content-type"]);
    if (!boundary) {
      const err = protocol.error(
        400,
        "Missing multipart boundary on $batch request",
      );
      res
        .status(err.status)
        .set(protocol.headers)
        .setHeader("Content-Type", err.contentType);
      return res.end(JSON.stringify(err.body));
    }
    const bodyText = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : String(req.body || "");
    const processedParts = splitMultipart(bodyText, boundary).map(
      processBatchPart,
    );

    const responseBoundary = `batchresponse_${Math.random().toString(36).slice(2)}`;
    res
      .status(200)
      .set(protocol.headers)
      .setHeader(
        "Content-Type",
        `multipart/mixed;boundary=${responseBoundary}`,
      );
    res.end(buildBatchResponseBody(processedParts, responseBoundary));
  };
}

export { createBatchHandler };
