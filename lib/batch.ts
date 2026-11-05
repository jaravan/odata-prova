// UI5's ODataModel batches by default, so most reads and writes arrive here as one
// multipart POST instead of hitting the service directly. We unpack each part, run it
// through service.dispatch(), and combine the results back into a multipart response.
// Changesets are atomic - one store transaction, rolled back if any part fails -
// and within one, `$<Content-ID>/Nav` can reference an entity a prior part just created.
import type { Request, Response } from "express";
import type { ODataResponse } from "./model.ts";
import { HttpError, decodeUrl, own } from "./query.ts";
import { keepLongNumbers } from "./types.ts";
import { MAX_RESPONSE, responseText, tooMuch } from "./work.ts";
import type { ODataService } from "./service.ts";
import type { Protocol } from "./protocol.ts";

// One application/http part: the request line, its headers (lower-cased) and body. spaced is
// the line, when its URL holds a space.
interface HttpRequestPart {
  method: string;
  rawUrl: string;
  spaced?: string;
  headers: Record<string, string>;
  bodyText: string;
}

// A batch part's results: one for a single request, one per member for a changeset (up to
// the first that failed)
interface ProcessedPart {
  changeset: boolean;
  results: { result: ODataResponse; contentId?: string }[];
}

// Splits a multipart body on "--<boundary>", dropping the leading preamble and the
// trailing "--" epilogue that follows the closing "--<boundary>--" delimiter. A delimiter
// starts a line (RFC 2046), so a body holding the boundary's text isn't split.
function splitMultipart(
  bodyText: string,
  boundary: string | undefined,
): string[] {
  const escaped = String(boundary).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const delimiter = new RegExp(
    `(?:^|\\r?\\n)--${escaped}(?:--)?[ \\t]*(?=\\r?\\n|$)`,
  );
  // Cut short: what's after the last delimiter may be half a request, so none of it runs
  if (
    !new RegExp(`(?:^|\\r?\\n)--${escaped}--[ \\t]*(?=\\r?\\n|$)`).test(
      bodyText,
    )
  )
    throw new HttpError(
      400,
      `The multipart body has no closing --${boundary}--`,
    );
  const segments = bodyText.split(delimiter);
  return segments
    .slice(1, -1)
    .map((s) => s.replace(/^\r?\n/, "").replace(/\r?\n$/, ""));
}

function splitOnceOnBlankLine(text: string): [string, string] {
  const match = text.match(/\r?\n\r?\n/);
  if (!match) return [text, ""];
  return [
    text.slice(0, match.index),
    text.slice(match.index! + match[0].length),
  ];
}

function parseHeaders(headBlock: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of headBlock.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > -1)
      headers[line.slice(0, idx).trim().toLowerCase()] = line
        .slice(idx + 1)
        .trim();
  }
  return headers;
}

function extractBoundary(contentType: string | undefined): string | undefined {
  const match = (contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? (match[1] || match[2]).trim() : undefined;
}

// Parses the "METHOD url HTTP/1.1\r\nHeader: ...\r\n\r\n<body>" text embedded in an
// application/http batch part. A URL has no spaces: what follows one isn't dropped, which would
// run another request than the one sent, say $orderby=Amount for $orderby=Amount desc.
function parseHttpRequestPart(text: string): HttpRequestPart {
  const [headBlock, bodyText] = splitOnceOnBlankLine(text);
  const lines = headBlock.split(/\r?\n/);
  const line = (lines[0] || "").trim();
  const [method, rawUrl, ...rest] = line.split(/[ \t]+/);
  const version = rest.length === 1 && /^HTTP\/\d/i.test(rest[0]);
  return {
    method: (method || "GET").toUpperCase(),
    rawUrl: rawUrl || "",
    spaced: rest.length && !version ? line : undefined,
    headers: parseHeaders(lines.slice(1).join("\r\n")),
    bodyText: bodyText.trim(),
  };
}

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  500: "Internal Server Error",
};

function renderHttpResponsePart(
  result: ODataResponse,
  protocol: Protocol,
  contentId?: string,
): string {
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
    // A multipart body is text, so bytes go in it as base64 and say so
    if (Buffer.isBuffer(result.body))
      headers += "Content-Transfer-Encoding: base64\r\n";
    bodyText = Buffer.isBuffer(result.body)
      ? result.body.toString("base64")
      : typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body);
  }
  return `HTTP/1.1 ${result.status} ${STATUS_TEXT[result.status] || ""}\r\n${headers}\r\n${bodyText}`;
}

// A body with its @odata.bind links to $<content id> as the URLs of what those requests made
function withContentIds(body: unknown, refs: Record<string, string>): unknown {
  if (!body || typeof body !== "object") return body;
  const resolve = (url: unknown) =>
    (typeof url === "string" &&
      url.startsWith("$") &&
      own(refs, url.slice(1))) ||
    url;
  return Object.fromEntries(
    Object.entries(body).map(([name, value]: [string, unknown]) => [
      name,
      !/@(?:odata\.)?bind$/.test(name)
        ? value
        : Array.isArray(value)
          ? value.map(resolve)
          : resolve(value),
    ]),
  );
}

// What $name is in a URL when no request of the changeset has that Content-ID: the service's
// own resource, answered as it is outside a $batch, not a mistaken reference
const SERVICE_RESOURCE = /^(?:metadata|batch|all|entity|crossjoin(?:\(.*\))?)$/;

function createBatchHandler(
  service: ODataService,
): (req: Request, res: Response) => Promise<void> {
  const { store, protocol } = service;

  // contentIdRefs: { "1": "/odata/v4/Srv/PurchaseOrderSet('x')" } within the current changeset.
  async function executeHttpPart(
    { method, rawUrl, spaced, headers, bodyText }: HttpRequestPart,
    contentIdRefs: Record<string, string>,
  ): Promise<ODataResponse> {
    if (spaced)
      return protocol.error(
        400,
        `The URL of "${spaced}" holds a space: write it as %20`,
      );
    let url = rawUrl.replace(/^https?:\/\/[^/]+/i, "");
    const ref = url.match(/^\$([^/?]+)(.*)$/);
    if (ref) {
      const target = own(contentIdRefs, ref[1]);
      if (target) url = target + ref[2];
      else if (!SERVICE_RESOURCE.test(ref[1]))
        return protocol.error(400, `Unknown Content-ID reference $${ref[1]}`);
    }
    if (!url.startsWith("/")) url = `${service.servicePath}/${url}`;
    // Only the first ? starts the query: one in a value is the value's
    const at = url.indexOf("?");
    const pathOnly = at === -1 ? url : url.slice(0, at);
    const params = new URLSearchParams(at === -1 ? "" : url.slice(at + 1));
    // An option given twice is a list, as the Express parser's are (see rejectUnsupported)
    const query = Object.fromEntries(
      [...params.keys()].map((name) => {
        const values = params.getAll(name);
        return [name, values.length > 1 ? values : values[0]];
      }),
    );

    let parsedBody: unknown;
    if (bodyText) {
      try {
        parsedBody = withContentIds(
          JSON.parse(bodyText, keepLongNumbers),
          contentIdRefs,
        );
      } catch {
        parsedBody = undefined;
      }
    }
    let resourcePath: string;
    try {
      resourcePath = decodeUrl(pathOnly);
    } catch (e) {
      // decodeUrl throws only HttpErrors
      const err = e as HttpError;
      return protocol.error(err.status, err.message, err.code);
    }
    const result = await service.execute(
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
  async function processBatchPart(rawPart: string): Promise<ProcessedPart> {
    const [outerHeadBlock, remainder] = splitOnceOnBlankLine(rawPart);
    const outerContentType = parseHeaders(outerHeadBlock)["content-type"] || "";

    if (/multipart\/mixed/i.test(outerContentType)) {
      const innerBoundary = extractBoundary(outerContentType);
      let members: string[];
      try {
        members = splitMultipart(remainder, innerBoundary);
      } catch (e) {
        const { status, message, code } = e as HttpError;
        return {
          changeset: true,
          results: [{ result: protocol.error(status, message, code) }],
        };
      }
      const mark = store.begin();
      // No prototype: a Content-ID is any text, __proto__ included
      const refs = Object.create(null) as Record<string, string>;
      const results: ProcessedPart["results"] = [];
      let failed = false;
      try {
        for (const p of members) {
          // Each changeset member is itself an "application/http"-wrapped part, so its own
          // Content-Type/Content-ID header block has to be peeled off first.
          const [innerHead, innerRemainder] = splitOnceOnBlankLine(p);
          const request = parseHttpRequestPart(innerRemainder);
          const contentId =
            parseHeaders(innerHead)["content-id"] ||
            request.headers["content-id"];
          if (contentId) request.headers["content-id"] = contentId;
          const result = await executeHttpPart(request, refs);
          results.push({ result, contentId });
          if (result.status >= 400) {
            failed = true;
            break;
          }
        }
      } catch (e) {
        store.rollback(mark);
        throw e;
      }
      if (failed) store.rollback(mark);
      else {
        // Saved as one: a changeset that can't be is undone, and answers as a failed one
        const error = await service.save(store.commit(mark)!);
        if (error) results.push({ result: error });
      }
      return { changeset: true, results };
    }
    return {
      changeset: false,
      results: [
        { result: await executeHttpPart(parseHttpRequestPart(remainder), {}) },
      ],
    };
  }

  // Turns a result's body to text, leaving the rows behind it to be freed, and returns its size
  function asText(result: ODataResponse): number {
    if (result.status === 204 || result.body === undefined) return 0;
    if (Buffer.isBuffer(result.body)) return result.body.length;
    if (typeof result.body !== "string")
      result.body = responseText(result.body);
    return (result.body as string).length;
  }

  function buildBatchResponseBody(
    processedParts: ProcessedPart[],
    boundary: string,
  ): string {
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
  return async (req: Request, res: Response) => {
    const contentType = req.headers["content-type"] ?? "";
    const boundary = extractBoundary(contentType);
    if (!boundary) {
      // OData 4.01's JSON format for $batch, which UI5 doesn't send: its V4 model batches as
      // multipart too
      const err = /^application\/json/i.test(contentType)
        ? protocol.error(
            501,
            "A JSON $batch (OData 4.01) is not supported: send it as multipart/mixed, as UI5 does",
          )
        : protocol.error(400, "Missing multipart boundary on $batch request");
      res
        .status(err.status)
        .set(protocol.headers)
        .setHeader("Content-Type", err.contentType!); // error() answers JSON
      res.end(JSON.stringify(err.body));
      return;
    }
    const bodyText = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : String(req.body || "");
    // The whole batch takes one turn in the queue, and runs its parts in order: one outside
    // a changeset is saved before the next runs, and sees what the ones before it saved
    const processedParts = await service.queue.run(async () => {
      const out: ProcessedPart[] = [];
      let size = 0;
      for (const part of splitMultipart(bodyText, boundary)) {
        const processed = await processBatchPart(part);
        out.push(processed);
        try {
          for (const { result } of processed.results) size += asText(result);
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          size = Infinity;
          processed.results.length = 0;
          out.pop();
        }
        // The parts after it aren't run: their answers wouldn't fit either
        if (size > MAX_RESPONSE) {
          const { status, message, code } = tooMuch();
          out.push({
            changeset: false,
            results: [{ result: protocol.error(status, message, code) }],
          });
          break;
        }
      }
      return out;
    });

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
