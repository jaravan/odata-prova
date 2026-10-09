// The generic OData request handler, one instance per (protocol, service path), all
// sharing one store. Everything here is driven by the parsed model; the protocol object
// decides how literals are read and how responses are written.
//
// dispatch(method, path, query, body, headers) -> { status, body?, contentType?, headers? }
// is the single entry point, used both by the Express routes and by $batch parts.
const {
  toInternal,
  propToInternal,
  toComparable,
  specialFloat,
} = require("./types");
const { compileFilter } = require("./filter");
const { HttpError, decodeUrl, splitTopLevel } = require("./query");
const { draftMatch, draftAction, Drafts } = require("./draft");

// Neutral value of a (property-shaped) type: the result of an operation that returns no
// entity, since the mock can't compute the real one.
function defaultValue(p, depth = 0) {
  if (p.isCollection) return [];
  if (p.complexType) {
    if (depth > 3) return null; // a complex type that contains itself
    const out = {};
    for (const c of Object.values(p.complexType.properties))
      out[c.name] = defaultValue(c, depth + 1);
    return out;
  }
  if (p.enumType) return p.enumType.members[0]?.name ?? null;
  switch (p.elementType) {
    case "Edm.Boolean":
      return false;
    case "Edm.Byte":
    case "Edm.SByte":
    case "Edm.Int16":
    case "Edm.Int32":
    case "Edm.Double":
    case "Edm.Single":
      return 0;
    case "Edm.Int64":
    case "Edm.Decimal":
      return "0";
    case "Edm.Guid":
      return "00000000-0000-0000-0000-000000000000";
    case "Edm.Date":
      return new Date().toISOString().slice(0, 10);
    case "Edm.DateTimeOffset":
      return new Date().toISOString().replace(/\.\d+Z$/, "Z");
    case "Edm.TimeOfDay":
      return "00:00:00";
    case "Edm.Duration":
      return "PT0S";
    case "Edm.String":
      return "";
    default:
      return null;
  }
}

class ODataService {
  // rules: what operations change, by operation name (see operationRules in app.js):
  // { ApprovePurchaseOrder: { set: { Status: "Approved" } } }
  constructor({
    model,
    store,
    protocol,
    servicePath,
    metadataXml,
    log = () => {},
    rules = {},
  }) {
    this.model = model;
    this.store = store;
    this.protocol = protocol;
    this.servicePath = servicePath;
    this.metadataXml = metadataXml;
    this.log = log;
    this.rules = rules;
    // The operations as this protocol serves them (see operationViews in metadata.js)
    this.operations = model.operationViews[protocol.version];
    this.drafts = new Drafts(this);
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
      segments.push({
        name: decodeUrl(m[1], decodeURIComponent),
        keyText: m[2],
      });
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
          `${entityType.name} has a composite key; use (Prop1=...,Prop2=...)`
        );
      }
      const k = entityType.keys[0];
      key[k] = toInternal(
        this.protocol.parseLiteral(parts[0]).value,
        entityType.properties[k].type
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
          `${name} is not a key property of ${entityType.name}`
        );
      key[name] = toInternal(
        this.protocol.parseLiteral(part.slice(eq + 1)).value,
        prop.type
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

  // The draft entity set of a draft entity type (draft.js keeps one per type)
  setOf(entityType) {
    return Object.values(this.model.entitySets).find(
      (es) => es.draft && es.entityType === entityType.fullName
    )?.name;
  }

  related(row, entityType, nav) {
    if (nav.draft === "admin")
      return this.drafts.adminRows(
        this.setOf(entityType),
        entityType,
        nav,
        row
      );
    const target = this.entitySet(nav.targetSet);
    const rows = this.store
      .rows(nav.targetSet)
      .filter(
        (t) =>
          nav.join.every(([src, tgt]) => String(row[src]) === String(t[tgt])) &&
          draftMatch(nav, row, t)
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

  // The navigation called `name` (SiblingEntity and DraftAdministrativeData included, see
  // draft.js), or undefined. One the metadata declares but the server had to switch off (see
  // disableOnError in metadata.js) is a 501, with the reason.
  navigation(type, name) {
    const reason = type.disabledNavigations?.[name];
    if (reason)
      throw new HttpError(
        501,
        `Navigation ${name} is not supported: ${reason}`
      );
    return type.navigations[name] || type.draftNavigations?.[name];
  }

  // Property-path resolver for $filter/$orderby: "Prop" or "Nav/Prop" (single-valued nav only).
  // resolve.collection(row, path), for the lambda operators: a path ending in a collection
  // navigation (after single-valued ones) gives { rows, resolve } for the related rows and
  // their type; one ending in a collection-valued property gives { values, prop }.
  resolver(entityType) {
    // Follows the single-valued navigations in parts; null when one of them leads nowhere
    const walk = (row, parts, path) => {
      let currentRow = row,
        currentType = entityType;
      for (const part of parts) {
        const nav = this.navigation(currentType, part);
        if (!nav || nav.isCollection)
          throw new HttpError(400, `Cannot filter on path ${path}`);
        const { rows, type } = this.related(currentRow, currentType, nav);
        if (rows.length === 0) return null;
        currentRow = rows[0];
        currentType = type;
      }
      return { row: currentRow, type: currentType };
    };
    const resolve = (row, path) => {
      const parts = path.replace(/^\$it\//, "").split("/");
      const at = walk(row, parts.slice(0, -1), path);
      if (!at) return { value: null, type: null };
      const prop = at.type.properties[parts[parts.length - 1]];
      if (!prop)
        throw new HttpError(400, `Unknown property ${path} on ${at.type.name}`);
      return { value: at.row[prop.name], type: prop.type };
    };
    resolve.collection = (row, path) => {
      const parts = path.replace(/^\$it\//, "").split("/");
      const last = parts[parts.length - 1];
      const at = walk(row, parts.slice(0, -1), path);
      const type = at?.type;
      const nav = type && this.navigation(type, last);
      if (nav?.isCollection) {
        const related = this.related(at.row, type, nav);
        return { rows: related.rows, resolve: this.resolver(related.type) };
      }
      const prop = type?.properties[last];
      if (prop?.isCollection) return { values: at.row[prop.name] || [], prop };
      if (!at) return { values: [] };
      throw new HttpError(400, `${path} is not a collection: any/all need one`);
    };
    return resolve;
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
      try {
        results = results.filter((row) => predicate(row, resolve));
      } catch (e) {
        // Errors found only while evaluating (unknown function, lambda over a
        // non-collection) are 400s too
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, `Invalid $filter: ${e.message}`);
      }
    }

    if (opts.search) {
      // Case-insensitive substring match over every string property; quotes optional.
      const term = opts.search.replace(/^"(.*)"$/, "$1").toLowerCase();
      const stringProps = Object.values(entityType.properties)
        .filter((p) => p.type === "Edm.String")
        .map((p) => p.name);
      results = results.filter((row) =>
        stringProps.some(
          (p) => row[p] !== null && String(row[p]).toLowerCase().includes(term)
        )
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

  // A Nullable="false" property a write leaves null is a 400. Keys are checked on their own,
  // and a property the client may not set (Core.Computed, sap:creatable or sap:updatable
  // "false") is left to the server. Only `names` are checked: an update can't fail on a
  // value it didn't touch.
  checkRequired(entityType, row, names, creating) {
    const settable = creating ? "creatable" : "updatable";
    for (const name of names) {
      const p = entityType.properties[name];
      if (p.nullable || entityType.keys.includes(name)) continue;
      if (p.computed || p.sap?.[settable] === "false") continue;
      if (row[name] === null)
        throw new HttpError(400, `Property ${name} is required`);
    }
  }

  // A deep insert is all or nothing: when a related entity fails (a duplicate key, an
  // invalid value), the rows this request already inserted are removed again.
  // draft: a draft may be incomplete until it is activated, so required values aren't checked.
  create(setName, entityType, body, presetValues = {}, draft = false) {
    const inserted = [];
    try {
      return this.insertTree(
        setName,
        entityType,
        body,
        presetValues,
        inserted,
        draft
      );
    } catch (e) {
      for (const { setName, type, row } of inserted.reverse())
        this.store.remove(setName, type, this.keyOf(type, row));
      throw e;
    }
  }

  // inserted: collects { setName, type, row } for every row inserted, for create's rollback
  insertTree(setName, entityType, body, presetValues, inserted, draft) {
    if (!body || typeof body !== "object")
      throw new HttpError(400, "Request body must be a JSON object");
    const row = this.store.normalize(entityType, { ...body, ...presetValues });
    for (const k of entityType.keys) {
      if (row[k] === null)
        throw new HttpError(400, `Key property ${k} is required`);
    }
    if (!draft) this.checkRequired(entityType, row, Object.keys(row), true);
    if (this.store.find(setName, entityType, this.keyOf(entityType, row))) {
      throw new HttpError(
        409,
        `${entityType.name} with this key already exists`
      );
    }
    this.store.insert(setName, row);
    inserted.push({ setName, type: entityType, row });

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
        nav.join.map(([src, tgt]) => [tgt, row[src]])
      );
      for (const child of children)
        this.insertTree(nav.targetSet, target.type, child, fk, inserted, draft);
    }
    return row;
  }

  // PATCH/MERGE merge the given properties; PUT replaces the entity (absent properties
  // become null, or an empty collection). Key properties are immutable either way. Every value is converted before
  // any is written, so an invalid one leaves the entity as it was. draft: as for create.
  update(setName, entityType, key, body, replace, draft = false) {
    const row = this.store.find(setName, entityType, key);
    if (!row) throw new HttpError(404, `${entityType.name} not found`);
    if (!body || typeof body !== "object")
      throw new HttpError(400, "Request body must be a JSON object");
    const changes = {};
    for (const p of Object.values(entityType.properties)) {
      if (entityType.keys.includes(p.name)) continue;
      if (p.name in body) changes[p.name] = propToInternal(body[p.name], p);
      else if (replace) changes[p.name] = propToInternal(undefined, p);
    }
    if (!draft)
      this.checkRequired(entityType, changes, Object.keys(changes), false);
    return Object.assign(row, changes);
  }

  // deleting: the rows this DELETE is already removing. Cascades can lead back to one (a
  // one-to-one link whose ends both cascade), which is then left to the delete in progress.
  delete(setName, entityType, key, deleting = new Set()) {
    const row = this.store.find(setName, entityType, key);
    if (!row) throw new HttpError(404, `${entityType.name} not found`);
    deleting.add(row);
    for (const nav of Object.values(entityType.navigations)) {
      if (!nav.cascadeDelete) continue;
      const { rows, type } = this.related(row, entityType, nav);
      for (const child of rows)
        if (!deleting.has(child))
          this.delete(nav.targetSet, type, this.keyOf(type, child), deleting);
    }
    this.store.remove(setName, entityType, key);
  }

  // --- Operations ------------------------------------------------------------------------

  operationImport(name) {
    return this.operations.imports[name];
  }

  // The operation `name` (qualified or not) bound to `type` or a base type, on an entity
  // or a collection.
  boundOperation(name, type, onCollection) {
    const types = new Set();
    for (let t = type; t; t = this.model.entityTypes[t.baseType])
      types.add(t.fullName);
    return this.operations.bound.find(
      (op) =>
        (op.fullName === name || op.name === name) &&
        types.has(op.binding.elementType) &&
        op.binding.isCollection === onCollection
    );
  }

  // Parameters: V4 actions from the JSON body, V4 functions from the path (Fn(a=1,b='x')),
  // V2 from the query string (?a=1&b='x'). Missing ones are null.
  operationParameters(op, paramText, body, query) {
    const params = {};
    if (this.protocol.version === "4.0" && op.kind === "action") {
      const input = body && typeof body === "object" ? body : {};
      for (const p of op.parameters)
        params[p.name] = propToInternal(input[p.name], p);
      return params;
    }
    let raw = query;
    if (this.protocol.version === "4.0") {
      raw = {};
      for (const part of splitTopLevel(paramText || "", ",")) {
        const eq = part.indexOf("=");
        if (eq === -1)
          throw new HttpError(400, `Invalid parameter ${part} for ${op.name}`);
        raw[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      }
    }
    for (const p of op.parameters) {
      const text = raw[p.name];
      if (text === undefined) params[p.name] = null;
      else if (text.startsWith("@"))
        throw new HttpError(
          501,
          `Parameter aliases (${p.name}=${text}) are not supported`
        );
      else if (p.complexType || p.isCollection)
        params[p.name] = propToInternal(text, p);
      else
        params[p.name] = toInternal(
          this.protocol.parseLiteral(text).value,
          p.type
        );
    }
    return params;
  }

  // binding: { setName, type, row, rows } a bound operation was called on. A V2 import with
  // bindsTo gets its entity from the key parameters instead. Logs the call, applies the
  // model's rule for the operation if any, and answers per operationResult.
  callOperation(method, op, binding, paramText, body, query, q, opts) {
    const expected = op.httpMethod || (op.kind === "action" ? "POST" : "GET");
    if (method !== expected)
      throw new HttpError(
        405,
        `${op.name} is ${
          op.kind === "action" ? "an action" : "a function"
        }: call it with ${expected}`
      );
    const params = this.operationParameters(op, paramText, body, query);
    if (op.bindsTo) {
      const { type, setName, isCollection } = op.bindsTo;
      if (isCollection)
        binding = { setName, type, rows: this.store.rows(setName) };
      else {
        const row = this.store.find(setName, type, this.keyOf(type, params));
        if (!row) throw new HttpError(404, `${type.name} not found`);
        binding = { setName, type, row, rows: [row] };
      }
    }
    const on = binding?.row
      ? ` on ${this.entityUri(binding.setName, binding.type, binding.row)}`
      : "";
    this.log(`${op.kind} ${op.name}${on} ${JSON.stringify(params)}`);
    const draftKind = binding && draftAction(this.model, binding.setName, op);
    if (draftKind) {
      const row = this.drafts.action(draftKind, op, binding, params, body);
      return this.protocol.entity(
        this,
        row,
        binding.setName,
        binding.type,
        q,
        draftKind === "new" ? 201 : 200,
        undefined,
        opts
      );
    }
    const rule = this.rules[op.name];
    if (rule?.set && binding?.row)
      for (const [name, value] of Object.entries(rule.set))
        binding.row[name] = propToInternal(
          value,
          binding.type.properties[name]
        );
    return this.operationResult(op, binding, params, q, opts);
  }

  // Response by return type: none -> 204; the binding's entity type -> that entity (Approve
  // returns the order); an entity type whose key the parameters carry -> that entity; any
  // other entity type, or a collection of one -> rows of its entity set, query options
  // applied; anything else -> defaultValue.
  operationResult(op, binding, params, q, opts) {
    const rt = op.returnType;
    if (!rt) return { status: 204 };
    if (!rt.entityType)
      return this.protocol.operationValue(this, op, rt, defaultValue(rt), opts);

    const type = rt.entityType;
    let setName, rows;
    if (binding && binding.type.fullName === type.fullName) {
      setName = binding.setName;
      rows = binding.row ? [binding.row] : binding.rows;
    } else {
      setName =
        op.entitySet ||
        Object.values(this.model.entitySets).find(
          (es) => es.entityType === type.fullName
        )?.name;
      rows = setName ? this.store.rows(setName) : [];
      setName ||= type.name; // no entity set of that type: only ever an empty result
    }
    if (rt.isCollection) {
      const { results, count } = this.applyQuery(rows, type, q);
      return this.protocol.collection(
        this,
        { rows: results, count },
        setName,
        type,
        q,
        opts
      );
    }
    let row = rows[0];
    if (
      !binding &&
      type.keys.length &&
      type.keys.every((k) => params[k] != null)
    ) {
      row = rows.find((r) => this.store.matchesKey(type, r, params));
      if (!row) throw new HttpError(404, `${type.name} not found`);
    }
    if (!row) return this.protocol.nullEntity();
    return this.protocol.entity(
      this,
      row,
      setName,
      type,
      q,
      200,
      undefined,
      opts
    );
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

    // Operation imports: /Name, /Name(a=1) (V4 functions), /Name?a=1 (V2)
    const first = segments[0].name;
    const imported =
      !this.model.entitySets[first] && this.operationImport(first);
    if (imported) {
      if (segments.length > 1 || wantCount || wantValue)
        throw new HttpError(
          501,
          `Path segments after ${first} are not supported`
        );
      return this.callOperation(
        method,
        imported,
        undefined,
        segments[0].keyText,
        body,
        query,
        q,
        opts
      );
    }
    if (!this.model.entitySets[first])
      throw new HttpError(404, `${first} is not an entity set or operation`);

    // Walk: entity set, then navigation properties, keeping the current row/collection.
    let { set, type } = this.entitySet(first);
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
      // Bound operations: Set(key)/NS.Name or Set/NS.Name, with (a=1) for V4 functions
      const op =
        !this.navigation(type, seg.name) &&
        !type.properties[seg.name] &&
        this.boundOperation(seg.name, type, row === undefined);
      if (op) {
        if (i !== segments.length - 1 || wantCount || wantValue)
          throw new HttpError(
            501,
            `Path segments after ${seg.name} are not supported`
          );
        return this.callOperation(
          method,
          op,
          { setName, type, row, rows },
          seg.keyText,
          body,
          query,
          q,
          opts
        );
      }
      if (row === undefined)
        throw new HttpError(400, `Cannot navigate ${seg.name} on a collection`);
      const nav = this.navigation(type, seg.name);
      if (!nav) {
        // Plain property access: Set(key)/Prop or Set(key)/Prop/$value
        const prop = type.properties[seg.name];
        if (!prop || i !== segments.length - 1)
          throw new HttpError(
            404,
            `${seg.name} is not a property or navigation of ${type.name}`
          );
        if (method !== "GET") throw new HttpError(405, "Method not allowed");
        const value = row[prop.name];
        if (wantValue)
          return {
            status: 200,
            contentType: "text/plain",
            body: value === null ? "" : specialFloat(value) || String(value),
          };
        return protocol.property(
          this,
          this.entityUri(setName, type, row),
          prop,
          value,
          opts
        );
      }
      if (nav.draft === "admin" && method !== "GET")
        throw new HttpError(405, `${nav.name} is read-only`);
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
            opts
          );
        }
        case "POST": {
          const preset = parentForCreate
            ? Object.fromEntries(
                parentForCreate.nav.join.map(([src, tgt]) => [
                  tgt,
                  parentForCreate.row[src],
                ])
              )
            : {};
          const created = this.model.entitySets[setName].draft
            ? this.drafts.create(setName, type, parentForCreate, body, preset)
            : this.create(setName, type, body, preset);
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
            opts
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
          opts
        );
      case "PUT":
      case "PATCH":
      case "MERGE": {
        const draft = this.model.entitySets[setName].draft;
        const updated = this.update(
          setName,
          type,
          this.keyOf(type, row),
          draft ? this.drafts.beforeUpdate(type, row, body) : body,
          method === "PUT",
          !!draft
        );
        if (draft) this.drafts.afterUpdate(updated);
        if (wantsRepresentation)
          return protocol.entity(
            this,
            updated,
            setName,
            type,
            q,
            200,
            { "Preference-Applied": "return=representation" },
            opts
          );
        return {
          status: 204,
          headers: wantsMinimal
            ? { "Preference-Applied": "return=minimal" }
            : undefined,
        };
      }
      case "DELETE":
        if (this.model.entitySets[setName].draft)
          this.drafts.delete(setName, type, row);
        else this.delete(setName, type, this.keyOf(type, row));
        return { status: 204 };
      default:
        throw new HttpError(405, `${method} not allowed on an entity`);
    }
  }
}

module.exports = { ODataService, HttpError };
