// The generic OData request handler, one instance per (protocol, service path), all
// sharing one store. Everything here is driven by the parsed model; the protocol object
// decides how literals are read and how responses are written.
//
// dispatch(method, path, query, body, headers) -> { status, body?, contentType?, headers? }
// is the single entry point, used both by the Express routes and by $batch parts.
const { toInternal, propToInternal, toComparable } = require("./types");
const { compileFilter } = require("./filter");
const { HttpError } = require("./query");

class ODataService {
  constructor({ model, store, protocol, servicePath, metadataXml }) {
    this.model = model;
    this.store = store;
    this.protocol = protocol;
    this.servicePath = servicePath;
    this.metadataXml = metadataXml;
  }

  entitySet(name) {
    const es = this.model.entitySets[name];
    if (!es) throw new HttpError(404, `Entity set ${name} not found`);
    return { set: es, type: this.model.entityTypes[es.entityType] };
  }

  // --- URL parsing -----------------------------------------------------------------------

  // "PurchaseOrderSet('4500000001')/Items(PurchaseOrderId='4500000001',ItemPosition='0001')/$count"
  // -> [{ name: "PurchaseOrderSet", keyText: "'4500000001'" }, { name: "Items", keyText: "..." }, { name: "$count" }]
  parseSegments(resourcePath) {
    const segments = [];
    const re = /([^/(]+)(?:\(((?:[^()']|'(?:[^']|'')*')*)\))?/g;
    let m;
    while ((m = re.exec(resourcePath))) {
      segments.push({ name: decodeURIComponent(m[1]), keyText: m[2] });
    }
    return segments;
  }

  // "'4500000001'" or "PurchaseOrderId='4500000001',ItemPosition='0001'" -> { PurchaseOrderId, ItemPosition }
  parseKey(keyText, entityType) {
    if (keyText === undefined) return undefined;
    const parts = [];
    let cur = "",
      inStr = false;
    for (const c of keyText) {
      if (c === "'") inStr = !inStr;
      if (c === "," && !inStr) {
        parts.push(cur);
        cur = "";
        continue;
      }
      cur += c;
    }
    parts.push(cur);

    const key = {};
    if (
      parts.length === 1 &&
      !/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0].trim())
    ) {
      if (entityType.keys.length !== 1) {
        throw new HttpError(
          400,
          `${entityType.name} has a composite key; use (Prop1=...,Prop2=...)`,
        );
      }
      const k = entityType.keys[0];
      key[k] = toInternal(
        this.protocol.parseLiteral(parts[0]).value,
        entityType.properties[k].type,
      );
      return key;
    }
    for (const part of parts) {
      const eq = part.indexOf("=");
      const name = part.slice(0, eq).trim();
      const prop = entityType.properties[name];
      if (!prop || !entityType.keys.includes(name))
        throw new HttpError(
          400,
          `${name} is not a key property of ${entityType.name}`,
        );
      key[name] = toInternal(
        this.protocol.parseLiteral(part.slice(eq + 1)).value,
        prop.type,
      );
    }
    for (const k of entityType.keys) {
      if (!(k in key)) throw new HttpError(400, `Key property ${k} missing`);
    }
    return key;
  }

  keyOf(entityType, row) {
    return Object.fromEntries(entityType.keys.map((k) => [k, row[k]]));
  }

  entityUri(setName, entityType, row) {
    const lit = (k) =>
      this.protocol.keyLiteral(row[k], entityType.properties[k]);
    const keyText =
      entityType.keys.length === 1
        ? lit(entityType.keys[0])
        : entityType.keys.map((k) => `${k}=${lit(k)}`).join(",");
    return `${this.servicePath}/${setName}(${keyText})`;
  }

  // --- Navigation ------------------------------------------------------------------------

  related(row, entityType, nav) {
    const target = this.entitySet(nav.targetSet);
    const rows = this.store
      .rows(nav.targetSet)
      .filter((t) =>
        nav.join.every(([src, tgt]) => String(row[src]) === String(t[tgt])),
      );
    return { ...target, rows };
  }

  // Related rows for an $expand node, with the node's own $filter/$orderby/$top/$skip applied.
  expandRows(row, entityType, nav, node) {
    const { rows, type } = this.related(row, entityType, nav);
    const { results, count } = this.applyQuery(rows, type, {
      ...node,
      count: node.count,
    });
    return { rows: results, count, type };
  }

  // --- Query options ---------------------------------------------------------------------

  // The navigation called `name`, or undefined. One the metadata declares but the server
  // had to switch off (see disableOnError in metadata.js) is a 501, with the reason.
  navigation(type, name) {
    const reason = type.disabledNavigations?.[name];
    if (reason)
      throw new HttpError(501, `Navigation ${name} is not supported: ${reason}`);
    return type.navigations[name];
  }

  // Property-path resolver for $filter/$orderby: "Prop" or "Nav/Prop" (single-valued nav only).
  resolver(entityType) {
    return (row, path) => {
      const parts = path.split("/");
      let currentRow = row,
        currentType = entityType;
      for (let i = 0; i < parts.length - 1; i++) {
        const nav = this.navigation(currentType, parts[i]);
        if (!nav || nav.isCollection)
          throw new HttpError(400, `Cannot filter on path ${path}`);
        const { rows, type } = this.related(currentRow, currentType, nav);
        if (rows.length === 0) return { value: null, type: null };
        currentRow = rows[0];
        currentType = type;
      }
      const prop = currentType.properties[parts[parts.length - 1]];
      if (!prop)
        throw new HttpError(
          400,
          `Unknown property ${path} on ${currentType.name}`,
        );
      return { value: currentRow[prop.name], type: prop.type };
    };
  }

  // opts: { filter, orderby, top, skip, count, search } (a parsed query or an $expand node).
  applyQuery(rows, entityType, opts) {
    const resolve = this.resolver(entityType);
    let results = rows;

    if (opts.filter) {
      let predicate;
      try {
        predicate = compileFilter(opts.filter, this.protocol);
      } catch (e) {
        throw new HttpError(400, `Invalid $filter: ${e.message}`);
      }
      results = results.filter((row) => predicate(row, resolve));
    }

    if (opts.search) {
      // Case-insensitive substring match over every string property; quotes optional.
      const term = opts.search.replace(/^"(.*)"$/, "$1").toLowerCase();
      const stringProps = Object.values(entityType.properties)
        .filter((p) => p.type === "Edm.String")
        .map((p) => p.name);
      results = results.filter((row) =>
        stringProps.some(
          (p) => row[p] !== null && String(row[p]).toLowerCase().includes(term),
        ),
      );
    }

    const count = opts.count ? results.length : undefined;

    if (opts.orderby) {
      const terms = opts.orderby.split(",").map((t) => {
        const [path, dir] = t.trim().split(/\s+/);
        return { path, desc: (dir || "asc").toLowerCase() === "desc" };
      });
      results = [...results].sort((a, b) => {
        for (const { path, desc } of terms) {
          const va = resolve(a, path),
            vb = resolve(b, path);
          const ca = toComparable(va.value, va.type),
            cb = toComparable(vb.value, vb.type);
          let cmp = 0;
          if (ca === null && cb !== null) cmp = -1;
          else if (ca !== null && cb === null) cmp = 1;
          else if (ca !== null && cb !== null)
            cmp = ca < cb ? -1 : ca > cb ? 1 : 0;
          if (cmp !== 0) return desc ? -cmp : cmp;
        }
        return 0;
      });
    }

    if (opts.skip !== undefined) results = results.slice(opts.skip);
    if (opts.top !== undefined) results = results.slice(0, opts.top);

    return { results, count };
  }

  // --- Writes ----------------------------------------------------------------------------

  create(setName, entityType, body, presetValues = {}) {
    if (!body || typeof body !== "object")
      throw new HttpError(400, "Request body must be a JSON object");
    const row = this.store.normalize(entityType, { ...body, ...presetValues });
    for (const k of entityType.keys) {
      if (row[k] === null)
        throw new HttpError(400, `Key property ${k} is required`);
    }
    if (this.store.find(setName, entityType, this.keyOf(entityType, row))) {
      throw new HttpError(
        409,
        `${entityType.name} with this key already exists`,
      );
    }
    this.store.insert(setName, row);

    // Deep insert: navigation payloads become related entities with the foreign key filled
    // in. V4 sends arrays, V2 either arrays or { results: [...] }.
    for (const nav of Object.values(entityType.navigations)) {
      const payload = body[nav.name];
      if (!payload) continue;
      const children = nav.isCollection
        ? Array.isArray(payload)
          ? payload
          : payload.results || []
        : [payload];
      const target = this.entitySet(nav.targetSet);
      const fk = Object.fromEntries(
        nav.join.map(([src, tgt]) => [tgt, row[src]]),
      );
      for (const child of children)
        this.create(nav.targetSet, target.type, child, fk);
    }
    return row;
  }

  // PATCH/MERGE merge the given properties; PUT replaces the entity (absent properties
  // become null). Key properties are immutable either way.
  update(setName, entityType, key, body, replace) {
    const row = this.store.find(setName, entityType, key);
    if (!row) throw new HttpError(404, `${entityType.name} not found`);
    if (!body || typeof body !== "object")
      throw new HttpError(400, "Request body must be a JSON object");
    for (const p of Object.values(entityType.properties)) {
      if (entityType.keys.includes(p.name)) continue;
      if (p.name in body) row[p.name] = propToInternal(body[p.name], p);
      else if (replace) row[p.name] = null;
    }
    return row;
  }

  delete(setName, entityType, key) {
    const row = this.store.find(setName, entityType, key);
    if (!row) throw new HttpError(404, `${entityType.name} not found`);
    for (const nav of Object.values(entityType.navigations)) {
      if (!nav.cascadeDelete) continue;
      const { rows, type } = this.related(row, entityType, nav);
      for (const child of rows)
        this.delete(nav.targetSet, type, this.keyOf(type, child));
    }
    this.store.remove(setName, entityType, key);
  }

  // --- Dispatch --------------------------------------------------------------------------

  dispatch(method, path, query = {}, body, headers = {}) {
    try {
      return this.handle(method, path, query, body, headers);
    } catch (e) {
      if (e instanceof HttpError)
        return this.protocol.error(e.status, e.message);
      console.error(e);
      return this.protocol.error(500, e.message);
    }
  }

  handle(method, path, query, body, headers) {
    if (!path.startsWith(this.servicePath))
      throw new HttpError(404, `Not found: ${path}`);
    const resourcePath = path
      .slice(this.servicePath.length)
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    const protocol = this.protocol;
    const opts = {
      ieee754: /IEEE754Compatible=true/i.test(headers.accept || ""),
      prefer: String(headers.prefer || ""),
    };
    const wantsMinimal = /return=minimal/i.test(opts.prefer);
    const wantsRepresentation = /return=representation/i.test(opts.prefer);

    if (resourcePath === "") {
      if (method !== "GET") throw new HttpError(405, "Method not allowed");
      return protocol.serviceDocument(this);
    }
    if (resourcePath === "$metadata") {
      if (method !== "GET") throw new HttpError(405, "Method not allowed");
      return {
        status: 200,
        contentType: "application/xml",
        body: this.metadataXml,
      };
    }

    const q = protocol.parseQueryOptions(query);
    const segments = this.parseSegments(resourcePath);
    let wantCount = false,
      wantValue = false;
    if (segments[segments.length - 1]?.name === "$count") {
      wantCount = true;
      segments.pop();
    }
    if (segments[segments.length - 1]?.name === "$value") {
      wantValue = true;
      segments.pop();
    }

    // Walk: entity set, then navigation properties, keeping the current row/collection.
    let { set, type } = this.entitySet(segments[0].name);
    let setName = set.name;
    let rows = this.store.rows(setName);
    let row = undefined; // defined when the current position is a single entity
    let key = this.parseKey(segments[0].keyText, type);
    let parentForCreate = undefined; // { row, type, nav } when POSTing to Parent(key)/Nav
    if (key) {
      row = this.store.find(setName, type, key);
      if (!row) throw new HttpError(404, `${type.name} not found`);
    }

    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      if (row === undefined)
        throw new HttpError(400, `Cannot navigate ${seg.name} on a collection`);
      const nav = this.navigation(type, seg.name);
      if (!nav) {
        // Plain property access: Set(key)/Prop or Set(key)/Prop/$value
        const prop = type.properties[seg.name];
        if (!prop || i !== segments.length - 1)
          throw new HttpError(
            404,
            `${seg.name} is not a property or navigation of ${type.name}`,
          );
        if (method !== "GET") throw new HttpError(405, "Method not allowed");
        const value = row[prop.name];
        if (wantValue)
          return {
            status: 200,
            contentType: "text/plain",
            body: value === null ? "" : String(value),
          };
        return protocol.property(
          this,
          this.entityUri(setName, type, row),
          prop,
          value,
          opts,
        );
      }
      const related = this.related(row, type, nav);
      parentForCreate = { row, type, nav };
      setName = nav.targetSet;
      type = related.type;
      rows = related.rows;
      row = undefined;
      key = this.parseKey(seg.keyText, type);
      if (key) {
        row = rows.find((r) => this.store.matchesKey(type, r, key));
        if (!row) throw new HttpError(404, `${type.name} not found`);
      } else if (!nav.isCollection) {
        row = rows[0];
        if (!row && method === "GET") return protocol.nullEntity();
      }
    }

    if (wantCount) {
      if (method !== "GET") throw new HttpError(405, "Method not allowed");
      const { results } = this.applyQuery(rows, type, {
        ...q,
        top: undefined,
        skip: undefined,
      });
      return {
        status: 200,
        contentType: "text/plain",
        body: String(results.length),
      };
    }

    if (row === undefined) {
      // Collection
      switch (method) {
        case "GET": {
          const { results, count } = this.applyQuery(rows, type, q);
          return protocol.collection(
            this,
            { rows: results, count },
            setName,
            type,
            q,
            opts,
          );
        }
        case "POST": {
          const preset = parentForCreate
            ? Object.fromEntries(
                parentForCreate.nav.join.map(([src, tgt]) => [
                  tgt,
                  parentForCreate.row[src],
                ]),
              )
            : {};
          const created = this.create(setName, type, body, preset);
          const location = this.entityUri(setName, type, created);
          if (wantsMinimal)
            return {
              status: 204,
              headers: {
                Location: location,
                "Preference-Applied": "return=minimal",
              },
            };
          return protocol.entity(
            this,
            created,
            setName,
            type,
            q,
            201,
            { Location: location },
            opts,
          );
        }
        default:
          throw new HttpError(405, `${method} not allowed on a collection`);
      }
    }

    // Single entity
    switch (method) {
      case "GET":
        return protocol.entity(
          this,
          row,
          setName,
          type,
          q,
          200,
          undefined,
          opts,
        );
      case "PUT":
      case "PATCH":
      case "MERGE": {
        const updated = this.update(
          setName,
          type,
          this.keyOf(type, row),
          body,
          method === "PUT",
        );
        if (wantsRepresentation)
          return protocol.entity(
            this,
            updated,
            setName,
            type,
            q,
            200,
            { "Preference-Applied": "return=representation" },
            opts,
          );
        return {
          status: 204,
          headers: wantsMinimal
            ? { "Preference-Applied": "return=minimal" }
            : undefined,
        };
      }
      case "DELETE":
        this.delete(setName, type, this.keyOf(type, row));
        return { status: 204 };
      default:
        throw new HttpError(405, `${method} not allowed on an entity`);
    }
  }
}

module.exports = { ODataService, HttpError };
