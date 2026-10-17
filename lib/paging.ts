// Server-driven paging (see paging below), and the links a response gives to the rest of
// a collection: the next page's, and a delta link's (see delta.ts).

import type { ODataVersion, QueryNode, ResponseOptions, Row } from "./model.ts";

// Server-driven paging: a response holds at most a page of the rows the query options
// leave, and links to the next page with a $skiptoken, the offset where it starts among
// those rows. The token is the client's to send back as it is, in the link; $skip and $top
// stay as they were, so the pages add up to what the query asks for. A $skiptoken also
// works without paging: the rows from that offset on.
function paging(
  rows: Row[],
  q: QueryNode,
  opts: ResponseOptions,
): { rows: Row[]; nextLink?: string } {
  const start = q.skiptoken ?? 0;
  if (!opts.page) return { rows: rows.slice(start) };
  const end = start + opts.page.size;
  return {
    rows: rows.slice(start, end),
    nextLink: end < rows.length ? opts.page.link(end) : undefined,
  };
}

// The request's URL with some of its query options changed (undefined: left out): its path
// from the root, and its query options as they came, which are kept readable ($, commas,
// slashes and colons unescaped)
function requestLink(
  path: string,
  query: Record<string, unknown>,
  changes: Record<string, unknown>,
): string {
  const options = Object.entries({ ...query, ...changes })
    .filter(([, value]) => value !== undefined)
    .map(
      ([name, value]) =>
        `${name}=${encodeURIComponent(String(value)).replace(/%(24|2C|2F|3A)/g, (e) => decodeURIComponent(e))}`,
    );
  return `${encodeURI(path)}?${options.join("&")}`;
}

// The page size of a GET (see paging): the server's, or the smaller one a V4 client asks for
// with Prefer: odata.maxpagesize=N. applied: the client's is the one used, which the
// response confirms in Preference-Applied.
function pageSizeFor(
  serverSize: number,
  version: ODataVersion,
  prefer: string,
): { size: number; applied: boolean } {
  const asked =
    version === "4.0"
      ? Number(/odata\.maxpagesize=(\d+)/i.exec(prefer)?.[1] || 0)
      : 0;
  if (asked && (!serverSize || asked < serverSize))
    return { size: asked, applied: true };
  return { size: serverSize, applied: false };
}

export { paging, requestLink, pageSizeFor };
