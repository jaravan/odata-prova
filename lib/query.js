// Once we parse a request's query options, this is what they look like (regardless of
// which protocol version sent them):
//
//   { filter, orderby, top, skip, count, search, select, expand }
//
// `expand`: it's a tree, not a flat list, because expanded collections can have their own query options
// V4 lets a client write $expand=Items($select=Material;$top=2) directly whereas
// V2 does this by nesting $select paths like Items/Material. Either way, we end up with one node
// per expanded navigation, and each node looks just like the top-level options plus its own children:
//
//   node = { expand: { <navName>: node }, select?: Set<string>, filter?, orderby?, top?, skip?, count? }

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function newNode() {
  return { expand: {}, select: undefined };
}

// "Items/PurchaseOrder" -> ensures node.expand.Items.expand.PurchaseOrder exists; returns the leaf.
function addExpandPath(root, path) {
  let node = root;
  for (const seg of path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean))
    node = node.expand[seg] ||= newNode();
  return node;
}

// "Material" -> root.select; "Items/Material" -> node(Items).select. A path's intermediate
// segments must be expanded to matter, but recording them is harmless if they are not.
function addSelectPath(root, path) {
  const segs = path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs.length === 0) return;
  let node = root;
  for (const seg of segs.slice(0, -1)) node = node.expand[seg] ||= newNode();
  (node.select ||= new Set()).add(segs[segs.length - 1]);
}

// Splits on `sep` at parenthesis depth 0, ignoring separators inside quotes.
function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0,
    cur = "",
    inStr = false;
  for (const c of text) {
    if (c === "'") inStr = !inStr;
    if (!inStr) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === sep && depth === 0) {
        parts.push(cur);
        cur = "";
        continue;
      }
    }
    cur += c;
  }
  if (cur.trim() !== "" || parts.length) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// Query options the server does not implement. Rejecting them with 501
// instead of silently ignoring them: an $apply=groupby(...) that comes back as the plain
// collection looks like a working response to the caller and is wrong.
const UNSUPPORTED_OPTIONS = ["$apply", "$compute", "$skiptoken", "$deltatoken"];

function rejectUnsupported(query) {
  for (const name of UNSUPPORTED_OPTIONS) {
    if (query[name] !== undefined)
      throw new HttpError(501, `${name} is not supported`);
  }
  if (
    query.$format !== undefined &&
    !/^(json|application\/json)$/i.test(String(query.$format).trim())
  ) {
    throw new HttpError(
      501,
      `$format=${query.$format} is not supported (JSON only)`,
    );
  }
}

function parseInt10(text, name) {
  if (text === undefined || text === "") return undefined;
  const n = parseInt(text, 10);
  if (Number.isNaN(n) || n < 0)
    throw new HttpError(400, `Invalid ${name}: ${text}`);
  return n;
}

module.exports = {
  HttpError,
  newNode,
  addExpandPath,
  addSelectPath,
  splitTopLevel,
  parseInt10,
  rejectUnsupported,
};
