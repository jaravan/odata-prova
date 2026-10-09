const path = require("path");
const { createApp } = require("../lib/app");

// A frozen copy of examples/PurchaseOrderSrv, so the example data can change without
// breaking assertions on it
const PO_MODEL = path.join(__dirname, "fixtures", "PurchaseOrderSrv");
const SALES_MODEL = path.join(__dirname, "fixtures", "SalesSrv");

// The Nullable="false" values of PO_MODEL's order and item other than their keys, for a
// write to start from
const ORDER = {
  Supplier: "Supplier",
  CompanyCode: "1000",
  OrderDate: "2025-01-01",
  Status: "Open",
  Currency: "EUR",
  TotalAmount: "1.00",
};
const ITEM = {
  Material: "M",
  Description: "d",
  Quantity: "1.000",
  Unit: "EA",
  NetPrice: "1.00",
  Currency: "EUR",
};

// Starts the app on an ephemeral port with both protocols mounted under /odata/v2/T and
// /odata/v4/T, and returns small fetch wrappers that parse the response for you. options go
// to createApp (mockRows).
async function start(modelDir = PO_MODEL, options = {}) {
  const built = createApp({
    modelDir,
    v2Path: "/odata/v2/T",
    v4Path: "/odata/v4/T",
    log: () => {},
    ...options,
  });
  const server = await new Promise((resolve) => {
    const s = built.app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ...built,
    base,
    v2: `${base}/odata/v2/T`,
    v4: `${base}/odata/v4/T`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function parse(res) {
  const text = await res.text();
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") && text ? JSON.parse(text) : text;
}

async function get(url, headers = {}) {
  const res = await fetch(url, { headers });
  return { status: res.status, headers: res.headers, body: await parse(res) };
}

async function send(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await parse(res) };
}

// Builds a multipart $batch body. parts: array of either a request { method, url, body,
// headers } or a changeset (array of requests).
function batchBody(parts, boundary = "batch_test") {
  const http = (r) => {
    const headers = Object.entries(r.headers || {})
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    const body = r.body === undefined ? "" : JSON.stringify(r.body);
    return `Content-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n${
      r.contentId ? `Content-ID: ${r.contentId}\r\n` : ""
    }\r\n${r.method} ${r.url} HTTP/1.1\r\n${headers}${
      body ? "Content-Type: application/json\r\n" : ""
    }\r\n${body}\r\n`;
  };
  let out = "";
  parts.forEach((part, i) => {
    if (Array.isArray(part)) {
      const cs = `changeset_${i}`;
      out += `--${boundary}\r\nContent-Type: multipart/mixed; boundary=${cs}\r\n\r\n`;
      for (const r of part) out += `--${cs}\r\n${http(r)}`;
      out += `--${cs}--\r\n`;
    } else {
      out += `--${boundary}\r\n${http(part)}`;
    }
  });
  return {
    body: out + `--${boundary}--\r\n`,
    contentType: `multipart/mixed; boundary=${boundary}`,
  };
}

async function batch(serviceRoot, parts) {
  const { body, contentType } = batchBody(parts);
  const res = await fetch(`${serviceRoot}/$batch`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

// Pulls the "HTTP/1.1 <status>" lines and JSON bodies out of a multipart batch response.
function batchResponses(text) {
  const out = [];
  const re =
    /HTTP\/1\.1 (\d{3})[^\r\n]*\r\n([\s\S]*?)\r\n\r\n([\s\S]*?)(?=\r\n--|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const headers = Object.fromEntries(
      m[2]
        .split(/\r\n/)
        .filter(Boolean)
        .map((l) => l.split(/:\s*/, 2))
        .map(([k, v]) => [k.toLowerCase(), v]),
    );
    let body = m[3];
    try {
      body = JSON.parse(body);
    } catch {
      /* text or empty */
    }
    out.push({ status: Number(m[1]), headers, body });
  }
  return out;
}

module.exports = {
  PO_MODEL,
  SALES_MODEL,
  ORDER,
  ITEM,
  start,
  get,
  send,
  batch,
  batchResponses,
};
