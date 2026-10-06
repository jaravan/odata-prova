// Draft handling, as SAP Fiori uses it and CAP and RAP serve it. An entity set annotated with
// Common.DraftRoot (or Common.DraftNode, for the entities composed into a root) keeps its
// drafts as rows of its own, told apart from the active entities by the IsActiveEntity key
// property. HasActiveEntity and HasDraftEntity tell whether the other version exists.
//
// Every draft entity type also carries two navigations the metadata gives no join for:
//   SiblingEntity            the draft of an active entity, or the active entity of a draft
//   DraftAdministrativeData  who edits the draft and since when
// They are resolved here into type.draftNavigations, apart from type.navigations, so the
// emitters and the mock data generator never see them.
//
// The Drafts class at the end implements the edit flow on top of the generic service:
// draftEdit, PATCH on the draft, POST of new draft children, draftPrepare, draftActivate,
// and DELETE (discarding a draft).

const { randomUUID } = require("crypto");
const { HttpError } = require("./query");

const COMMON = "com.sap.vocabularies.Common.v1";
const DRAFT_NAVIGATIONS = ["SiblingEntity", "DraftAdministrativeData"];

// What a seeded or generated row of a draft entity set is: an active entity with no draft
const ACTIVE = {
  IsActiveEntity: true,
  HasActiveEntity: false,
  HasDraftEntity: false,
};

const list = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

// Reads Common.DraftRoot and Common.DraftNode on entity sets, inline or in an <Annotations>
// block targeting the set, into es.draft = { root, actions: { activate, edit, prepare, new } }
// (qualified action names; a node only has prepare). edmx and schemas are the parsed document.
function parseDraftAnnotations(model, edmx, schemas) {
  const aliases = {};
  for (const ref of list(edmx.Reference))
    for (const inc of list(ref.Include))
      if (inc.Alias) aliases[inc.Alias] = inc.Namespace;
  for (const schema of schemas)
    if (schema.Alias) aliases[schema.Alias] = schema.Namespace;
  // "Common.DraftRoot" -> "com.sap.vocabularies.Common.v1.DraftRoot"
  const qualify = (name) => {
    if (!name) return name;
    const dot = name.lastIndexOf(".");
    const prefix = name.slice(0, dot);
    return `${aliases[prefix] || prefix}${name.slice(dot)}`;
  };
  const container = `${model.container.namespace}.${model.container.name}`;

  const annotate = (setName, annotations) => {
    for (const a of list(annotations)) {
      if (a.Qualifier) continue;
      const term = qualify(a.Term);
      const root = term === `${COMMON}.DraftRoot`;
      if (!root && term !== `${COMMON}.DraftNode`) continue;
      const values = Object.fromEntries(
        list(a.Record?.PropertyValue).map((pv) => [
          pv.Property,
          qualify(pv.String),
        ])
      );
      model.entitySets[setName].draft = {
        root,
        actions: {
          activate: values.ActivationAction,
          edit: values.EditAction,
          prepare: values.PreparationAction,
          new: values.NewAction,
        },
      };
    }
  };

  for (const schema of schemas) {
    for (const c of schema.EntityContainer || [])
      for (const es of c.EntitySet || []) annotate(es.Name, es.Annotation);
    for (const block of list(schema.Annotations)) {
      const [path, setName, ...rest] = String(block.Target).split("/");
      if (
        rest.length ||
        qualify(path) !== container ||
        !model.entitySets[setName]
      )
        continue;
      annotate(setName, block.Annotation);
    }
  }

  for (const es of Object.values(model.entitySets)) {
    if (!es.draft) continue;
    const et = model.entityTypes[es.entityType];
    if (!et?.keys.includes("IsActiveEntity")) {
      model.warnings.push(
        `draft ignored: ${es.name} has no IsActiveEntity key property`
      );
      delete es.draft;
    }
  }
}

function isDraftType(model, et) {
  return Object.values(model.entitySets).some(
    (es) => es.draft && es.entityType === et.fullName
  );
}

// SiblingEntity and DraftAdministrativeData of a draft entity type: left out of the generic
// navigation resolution, see resolveDraftNavigations
function isDraftNavigation(model, et, nav) {
  return DRAFT_NAVIGATIONS.includes(nav.name) && isDraftType(model, et);
}

// After the generic navigations are resolved (partners included):
// - a navigation inside a draft tree (a composition, either way) also joins on
//   IsActiveEntity, so an active entity reaches active children and a draft its drafts;
// - any other navigation into a draft entity set (draft: "active") reaches active entities only;
// - SiblingEntity and DraftAdministrativeData go into type.draftNavigations.
function resolveDraftNavigations(model) {
  for (const et of Object.values(model.entityTypes)) {
    const sourceIsDraft = isDraftType(model, et);
    for (const nav of Object.values(et.navigations)) {
      const target = model.entitySets[nav.targetSet];
      if (!target?.draft) continue;
      const partner =
        nav.partner &&
        model.entityTypes[nav.targetType].navigations[nav.partner];
      const inTree =
        sourceIsDraft &&
        (nav.cascadeDelete || partner?.cascadeDelete || !target.draft.root);
      if (!inTree) {
        nav.draft = "active";
        continue;
      }
      if (!nav.join.some(([src]) => src === "IsActiveEntity"))
        nav.join.push(["IsActiveEntity", "IsActiveEntity"]);
      // Parent to children: what draftEdit copies and draftActivate writes back
      if (nav.dependentSide === "target" && !target.draft.root)
        nav.draft = "composition";
    }
    if (!sourceIsDraft) continue;

    et.draftNavigations = {};
    for (const nav of et.navigationProperties) {
      if (nav.name === "SiblingEntity") {
        et.draftNavigations[nav.name] = {
          name: nav.name,
          draft: "sibling",
          targetSet: Object.values(model.entitySets).find(
            (es) => es.draft && es.entityType === et.fullName
          ).name,
          targetType: et.fullName,
          isCollection: false,
          join: et.keys
            .filter((k) => k !== "IsActiveEntity")
            .map((k) => [k, k]),
        };
      } else if (nav.name === "DraftAdministrativeData") {
        const targetType = String(nav.type || "");
        if (!model.entityTypes[targetType]) {
          const reason = `${et.name}.${nav.name}: unknown target type ${targetType}`;
          et.disabledNavigations[nav.name] = reason;
          model.warnings.push(`navigation disabled: ${reason}`);
          continue;
        }
        et.draftNavigations[nav.name] = {
          name: nav.name,
          draft: "admin",
          targetType,
          isCollection: false,
          join: [],
        };
      }
    }
  }
}

// Seeded rows have no draft columns: they are active entities. Generated ones (force) get
// the columns overwritten, since the generator fills them at random.
function asActive(row, force = false) {
  for (const [name, value] of Object.entries(ACTIVE))
    if (force || row[name] === null || row[name] === undefined)
      row[name] = value;
  return row;
}

// The extra condition a draft navigation puts on a related row t of row
function draftMatch(nav, row, t) {
  if (nav.draft === "sibling") return t.IsActiveEntity !== row.IsActiveEntity;
  if (nav.draft === "active") return t.IsActiveEntity === true;
  return true;
}

// Which draft action (activate, edit, prepare, new) op is for the entity set, if any
function draftAction(model, setName, op) {
  const actions = model.entitySets[setName]?.draft?.actions || {};
  return Object.keys(actions).find((kind) => actions[kind] === op.fullName);
}

// --- Editing ------------------------------------------------------------------------------
//
// A draft row carries a hidden $draftUUID (not a property, so never serialized): the
// DraftUUID of the administrative data its draft tree shares, kept in the store as
// ADMIN rows. The mock has one user, who owns every draft.

const ADMIN = "$DraftAdministrativeData";
const UUID = "$draftUUID";
const USER = "anonymous";
const DRAFT_COLUMNS = Object.keys(ACTIVE);

const now = () => new Date().toISOString();

class Drafts {
  constructor(svc) {
    this.svc = svc;
    this.model = svc.model;
    this.store = svc.store;
  }

  draftOf(setName) {
    return this.model.entitySets[setName]?.draft;
  }

  // Rows of a whole draft operation: all of them or, when one fails, none
  atomic(fn) {
    const snapshot = this.store.snapshot();
    try {
      return fn();
    } catch (e) {
      this.store.restore(snapshot);
      throw e;
    }
  }

  // The other version of row: its draft (active false) or its active entity
  sibling(setName, type, row, active) {
    return this.store.find(setName, type, {
      ...this.svc.keyOf(type, row),
      IsActiveEntity: active,
    });
  }

  // row and its composition descendants, parents first: [{ setName, type, row }]
  tree(setName, type, row) {
    const out = [{ setName, type, row }];
    for (const nav of Object.values(type.navigations)) {
      if (nav.draft !== "composition") continue;
      const related = this.svc.related(row, type, nav);
      for (const child of related.rows)
        out.push(...this.tree(nav.targetSet, related.type, child));
    }
    return out;
  }

  // The key without IsActiveEntity, as text: what a draft row and its active entity share
  sharedKey(type, row) {
    return JSON.stringify(
      type.keys.filter((k) => k !== "IsActiveEntity").map((k) => row[k])
    );
  }

  // --- Administrative data ---

  admins() {
    return (this.store.data[ADMIN] ||= []);
  }

  // The record for row: its own for a draft, its draft's for an active entity being edited
  admin(setName, type, row) {
    const uuid = row.IsActiveEntity
      ? this.sibling(setName, type, row, false)?.[UUID]
      : row[UUID];
    return uuid && this.admins().find((a) => a.DraftUUID === uuid);
  }

  newAdmin() {
    const time = now();
    const record = {
      DraftUUID: randomUUID(),
      CreationDateTime: time,
      CreatedByUser: USER,
      DraftIsCreatedByMe: true,
      LastChangeDateTime: time,
      LastChangedByUser: USER,
      InProcessByUser: USER,
      DraftIsProcessedByMe: true,
    };
    this.admins().push(record);
    return record.DraftUUID;
  }

  touch(row) {
    const record = this.admins().find((a) => a.DraftUUID === row[UUID]);
    if (record) record.LastChangeDateTime = now();
  }

  removeAdmin(uuid) {
    const list = this.admins();
    const idx = list.findIndex((a) => a.DraftUUID === uuid);
    if (idx !== -1) list.splice(idx, 1);
  }

  // DraftAdministrativeData of row, as related() answers a navigation
  adminRows(setName, type, nav, row) {
    const record = this.admin(setName, type, row);
    return {
      type: this.model.entityTypes[nav.targetType],
      rows: record ? [record] : [],
    };
  }

  // --- Actions ---

  // The draft action `kind` on binding.row; returns the entity to answer with
  action(kind, op, { setName, type, row }, params) {
    if (!row) throw new HttpError(400, `${op.name} is called on an entity`);
    const wantActive = kind === "edit";
    if (row.IsActiveEntity !== wantActive)
      throw new HttpError(
        400,
        `${op.name} is called on ${wantActive ? "an active entity" : "a draft"}`
      );
    switch (kind) {
      case "edit":
        return this.atomic(() =>
          this.edit(setName, type, row, params.PreserveChanges)
        );
      case "activate":
        return this.atomic(() => this.activate(setName, type, row));
      case "prepare":
        return row; // nothing to validate in a mock
      default:
        throw new HttpError(
          501,
          `${op.name}: draft action ${kind} is not supported yet`
        );
    }
  }

  // Copies the active entity and its compositions into a new draft. An existing draft is
  // discarded first, unless the client asked to keep it (PreserveChanges): then 409.
  edit(setName, type, row, preserveChanges) {
    const existing = this.sibling(setName, type, row, false);
    if (existing) {
      if (preserveChanges)
        throw new HttpError(409, `A draft of this ${type.name} already exists`);
      this.discard(setName, type, existing);
    }
    const uuid = this.newAdmin();
    const drafts = this.tree(setName, type, row).map((n) => {
      n.row.HasDraftEntity = true;
      const draft = {
        ...n.row,
        IsActiveEntity: false,
        HasActiveEntity: true,
        HasDraftEntity: false,
        [UUID]: uuid,
      };
      this.store.insert(n.setName, draft);
      return draft;
    });
    return drafts[0];
  }

  // Writes the draft tree over the active one (children deleted in the draft are deleted)
  // and removes the draft
  activate(setName, type, draft) {
    const uuid = draft[UUID];
    const active = this.activateRow(setName, type, draft);
    this.removeAdmin(uuid);
    return active;
  }

  activateRow(setName, type, draft) {
    let active = this.sibling(setName, type, draft, true);
    const compositions = Object.values(type.navigations).filter(
      (nav) => nav.draft === "composition"
    );
    const before = compositions.map((nav) =>
      active ? this.svc.related(active, type, nav) : { rows: [] }
    );
    const drafts = compositions.map((nav) =>
      this.svc.related(draft, type, nav)
    );

    this.store.remove(setName, type, this.svc.keyOf(type, draft));
    const values = { ...draft, ...ACTIVE };
    delete values[UUID];
    if (active) Object.assign(active, values);
    else this.store.insert(setName, (active = values));

    compositions.forEach((nav, i) => {
      const kept = new Set(
        drafts[i].rows.map((r) => this.sharedKey(drafts[i].type, r))
      );
      for (const child of before[i].rows)
        if (!kept.has(this.sharedKey(before[i].type, child)))
          this.removeTree(nav.targetSet, before[i].type, child);
      for (const child of drafts[i].rows)
        this.activateRow(nav.targetSet, drafts[i].type, child);
    });
    return active;
  }

  // Removes a draft tree; its active entities have no draft any more
  discard(setName, type, draft) {
    for (const n of this.tree(setName, type, draft)) {
      this.store.remove(n.setName, n.type, this.svc.keyOf(n.type, n.row));
      const active = this.sibling(n.setName, n.type, n.row, true);
      if (active) active.HasDraftEntity = false;
    }
    this.removeAdmin(draft[UUID]);
  }

  removeTree(setName, type, row) {
    for (const n of this.tree(setName, type, row))
      this.store.remove(n.setName, n.type, this.svc.keyOf(n.type, n.row));
  }

  // --- Writes through the generic routes ---

  // DELETE: a draft root is discarded, a draft node removed with its compositions, an active
  // root deleted with its draft. An active node changes through its root's draft only.
  delete(setName, type, row) {
    const root = this.draftOf(setName).root;
    this.atomic(() => {
      if (!row.IsActiveEntity) {
        if (root) return this.discard(setName, type, row);
        this.removeTree(setName, type, row);
        return this.touch(row);
      }
      if (!root) throw this.activeNodeError(type);
      const draft = this.sibling(setName, type, row, false);
      if (draft) this.discard(setName, type, draft);
      this.removeTree(setName, type, row);
    });
  }

  // PATCH/PUT: drafts only. The draft columns are the server's to set: they keep their
  // values, a PUT included. Returns the body to apply.
  beforeUpdate(type, row, body) {
    if (row.IsActiveEntity)
      throw new HttpError(
        400,
        `${type.name} is draft-enabled: change its draft, not the active entity`
      );
    if (!body || typeof body !== "object") return body;
    const out = { ...body };
    for (const name of DRAFT_COLUMNS)
      if (name in type.properties) out[name] = row[name];
    return out;
  }

  afterUpdate(row) {
    this.touch(row);
  }

  // POST to Parent(...)/Composition: into a draft parent only, as a new draft (no active
  // entity yet) of its draft tree. Fiori Elements sends no key: a missing Guid or integer
  // key is generated. Returns the body to create.
  beforeCreate(setName, type, parent, body) {
    if (parent.IsActiveEntity) throw this.activeNodeError(type);
    const out = {
      ...(body && typeof body === "object" ? body : {}),
      IsActiveEntity: false,
      HasActiveEntity: false,
      HasDraftEntity: false,
    };
    for (const k of type.keys) {
      if (out[k] !== undefined && out[k] !== null) continue;
      const prop = type.properties[k];
      if (prop.type === "Edm.Guid") out[k] = randomUUID();
      else if (
        [
          "Edm.Int16",
          "Edm.Int32",
          "Edm.Int64",
          "Edm.Byte",
          "Edm.SByte",
        ].includes(prop.type)
      )
        out[k] =
          Math.max(
            0,
            ...this.store.rows(setName).map((r) => Number(r[k]) || 0)
          ) + 1;
    }
    return out;
  }

  // The created row and any deep-inserted compositions join the parent's draft
  afterCreate(setName, type, parent, row) {
    for (const n of this.tree(setName, type, row)) {
      Object.assign(n.row, {
        IsActiveEntity: false,
        HasActiveEntity: false,
        HasDraftEntity: false,
      });
      n.row[UUID] = parent[UUID];
    }
    this.touch(parent);
  }

  activeNodeError(type) {
    return new HttpError(
      400,
      `${type.name} is part of a draft-enabled entity: change it in its root's draft`
    );
  }
}

module.exports = {
  parseDraftAnnotations,
  isDraftNavigation,
  resolveDraftNavigations,
  asActive,
  draftMatch,
  draftAction,
  Drafts,
};
