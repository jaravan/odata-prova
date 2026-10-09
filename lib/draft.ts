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

import { randomUUID } from "node:crypto";
import type {
  AnyNavigation,
  DraftInfo,
  DraftNavigation,
  EntityType,
  JoinPair,
  Key,
  Model,
  NavigationProperty,
  Operation,
  PropertyValue,
  Row,
} from "./model.ts";
import type { Qualify, Xml } from "./metadata.ts";
import type { Store } from "./store.ts";
import { HttpError } from "./query.ts";

// The draft actions an entity set's annotation can name
export type DraftKind = keyof DraftInfo["actions"];

// A navigation's related rows and their type, as the service's related() answers
interface Related {
  type: EntityType;
  rows: Row[];
}

// What Drafts uses of the service (the ODataService in service.ts)
export interface DraftHost {
  model: Model;
  store: Store;
  keyOf(type: EntityType, row: Row): Key;
  related(row: Row, type: EntityType, nav: AnyNavigation): Related;
  checkRequired(
    type: EntityType,
    row: Row,
    names: string[],
    creating: boolean,
  ): void;
  create(
    setName: string,
    type: EntityType,
    body: unknown,
    preset: Row,
    draft: boolean,
  ): Row;
}

// The entity a POST under Parent(...)/Nav is made under
interface Parent {
  row: Row;
  type: EntityType;
  nav: AnyNavigation;
}

// A row of a draft tree, with where it lives
interface TreeNode {
  setName: string;
  type: EntityType;
  row: Row;
}

const COMMON = "com.sap.vocabularies.Common.v1";
const DRAFT_NAVIGATIONS = ["SiblingEntity", "DraftAdministrativeData"];

// What a seeded or generated row of a draft entity set is: an active entity with no draft
const ACTIVE = {
  IsActiveEntity: true,
  HasActiveEntity: false,
  HasDraftEntity: false,
};

const list = (x: Xml): Xml[] =>
  x === undefined ? [] : Array.isArray(x) ? x : [x];

// Reads Common.DraftRoot and Common.DraftNode on entity sets, inline or in an <Annotations>
// block targeting the set, into es.draft = { root, actions: { activate, edit, prepare, new } }
// (a node only has prepare). An action is a qualified name (V4: "Srv.draftEdit") or a
// function import path (V2 from SAP Gateway: "Srv.Srv_Entities/TravelEdit"). V2 documents
// carry these V4 annotations too. schemas are the parsed document's; qualify resolves an
// alias (see termQualifier in metadata.ts).
// Reads the raw XML, which is untyped (see Xml in metadata.ts).
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
function parseDraftAnnotations(
  model: Model,
  schemas: Xml[],
  qualify: Qualify,
): void {
  const container = `${model.container.namespace}.${model.container.name}`;

  const annotate = (setName: string, annotations: Xml) => {
    for (const a of list(annotations)) {
      if (a.Qualifier) continue;
      const term = qualify(a.Term);
      const root = term === `${COMMON}.DraftRoot`;
      if (!root && term !== `${COMMON}.DraftNode`) continue;
      const values: Record<string, string> = Object.fromEntries(
        list(a.Record?.PropertyValue).map((pv: Xml) => [
          pv.Property,
          qualify(pv.String),
        ]),
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
        `draft ignored: ${es.name} has no IsActiveEntity key property`,
      );
      delete es.draft;
    }
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

// The entity type a navigation leads to: V4 names it, V2 has the association say
function navTargetType(
  model: Model,
  nav: NavigationProperty,
): string | undefined {
  if ("type" in nav) return nav.type.replace(/^Collection\((.+)\)$/, "$1");
  const assoc = model.associations[nav.relationship];
  return assoc?.ends.find((e) => e.role === nav.toRole)?.type;
}

function isDraftType(model: Model, et: EntityType): boolean {
  return Object.values(model.entitySets).some(
    (es) => es.draft && es.entityType === et.fullName,
  );
}

// SiblingEntity and DraftAdministrativeData of a draft entity type: left out of the generic
// navigation resolution, see resolveDraftNavigations
function isDraftNavigation(
  model: Model,
  et: EntityType,
  nav: NavigationProperty,
): boolean {
  return DRAFT_NAVIGATIONS.includes(nav.name) && isDraftType(model, et);
}

// After the generic navigations are resolved (partners included):
// - a navigation inside a draft tree (a composition, either way) also joins on
//   IsActiveEntity, so an active entity reaches active children and a draft its drafts;
// - any other navigation into a draft entity set (draft: "active") reaches active entities only;
// - SiblingEntity and DraftAdministrativeData go into type.draftNavigations.
function resolveDraftNavigations(model: Model): void {
  for (const et of Object.values(model.entityTypes)) {
    const sourceIsDraft = isDraftType(model, et);
    const sourceIsNode = Object.values(model.entitySets).some(
      (es) => es.draft && !es.draft.root && es.entityType === et.fullName,
    );
    for (const nav of Object.values(et.navigations)) {
      const target = model.entitySets[nav.targetSet];
      if (!target?.draft) continue;
      const partner = nav.partner
        ? model.entityTypes[nav.targetType].navigations[nav.partner]
        : undefined;
      // A composition, either way: one end is a node, or the metadata says the children
      // go with their parent. A node's way back to its parent has a partner.
      const inTree =
        sourceIsDraft &&
        (nav.cascadeDelete ||
          partner?.cascadeDelete ||
          !target.draft.root ||
          (sourceIsNode && !!partner));
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

    // A draft type has a draft entity set
    const draftSet = Object.values(model.entitySets).find(
      (es) => es.draft && es.entityType === et.fullName,
    )!.name;
    et.draftNavigations = {};
    for (const nav of et.navigationProperties) {
      if (nav.name === "SiblingEntity") {
        et.draftNavigations[nav.name] = {
          name: nav.name,
          draft: "sibling",
          targetSet: draftSet,
          targetType: et.fullName,
          isCollection: false,
          join: et.keys
            .filter((k) => k !== "IsActiveEntity")
            .map((k): JoinPair => [k, k]),
        };
      } else if (nav.name === "DraftAdministrativeData") {
        const targetType = navTargetType(model, nav);
        if (!targetType || !model.entityTypes[targetType]) {
          const reason = `${et.name}.${nav.name}: unknown target type ${targetType}`;
          (et.disabledNavigations ??= {})[nav.name] = reason;
          model.warnings.push(`navigation disabled: ${reason}`);
          continue;
        }
        // Read-only. Its rows are draft.ts's own; the set only names them in URLs: the
        // entity set of the type (RAP has one), or a path contained in the draft's
        et.draftNavigations[nav.name] = {
          name: nav.name,
          draft: "admin",
          targetSet:
            Object.values(model.entitySets).find(
              (es) => es.entityType === targetType,
            )?.name || `${draftSet}/${nav.name}`,
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
function asActive(row: Row, force = false): Row {
  for (const [name, value] of Object.entries(ACTIVE))
    if (force || row[name] === null || row[name] === undefined)
      row[name] = value;
  return row;
}

// The extra condition a draft navigation puts on a related row t of row
function draftMatch(nav: AnyNavigation, row: Row, t: Row): boolean {
  if (nav.draft === "sibling") return t.IsActiveEntity !== row.IsActiveEntity;
  if (nav.draft === "active") return t.IsActiveEntity === true;
  return true;
}

// Which draft action (activate, edit, prepare, new) op is for the entity set, if any. A
// function import path matches the operation of that name (the V4 view of a V2 import
// keeps it).
function draftAction(
  model: Model,
  setName: string,
  op: Operation,
): DraftKind | undefined {
  const actions: DraftInfo["actions"] =
    model.entitySets[setName]?.draft?.actions || {};
  // In the order parseDraftAnnotations sets them
  const kinds: DraftKind[] = ["activate", "edit", "prepare", "new"];
  return kinds.find((kind) => {
    const ref = actions[kind];
    return (
      ref &&
      (ref === op.fullName ||
        (ref.includes("/") && ref.split("/").pop() === op.name))
    );
  });
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
// A draft of an entity that has no active version yet
const NEW_DRAFT = {
  IsActiveEntity: false,
  HasActiveEntity: false,
  HasDraftEntity: false,
};
const INTEGER_TYPES = [
  "Edm.Byte",
  "Edm.SByte",
  "Edm.Int16",
  "Edm.Int32",
  "Edm.Int64",
];

const now = () => new Date().toISOString();

class Drafts {
  svc: DraftHost;
  model: Model;
  store: Store;

  constructor(svc: DraftHost) {
    this.svc = svc;
    this.model = svc.model;
    this.store = svc.store;
  }

  draftOf(setName: string): DraftInfo | undefined {
    return this.model.entitySets[setName]?.draft;
  }

  // Rows of a whole draft operation: all of them or, when one fails, none
  atomic<T>(fn: () => T): T {
    const snapshot = this.store.snapshot();
    try {
      return fn();
    } catch (e) {
      this.store.restore(snapshot);
      throw e;
    }
  }

  // The other version of row: its draft (active false) or its active entity
  sibling(
    setName: string,
    type: EntityType,
    row: Row,
    active: boolean,
  ): Row | undefined {
    return this.store.find(setName, type, {
      ...this.svc.keyOf(type, row),
      IsActiveEntity: active,
    });
  }

  // row and its composition descendants, parents first: [{ setName, type, row }]
  tree(setName: string, type: EntityType, row: Row): TreeNode[] {
    const out: TreeNode[] = [{ setName, type, row }];
    for (const nav of Object.values(type.navigations)) {
      if (nav.draft !== "composition") continue;
      const related = this.svc.related(row, type, nav);
      for (const child of related.rows)
        out.push(...this.tree(nav.targetSet, related.type, child));
    }
    return out;
  }

  // The key without IsActiveEntity, as text: what a draft row and its active entity share
  sharedKey(type: EntityType, row: Row): string {
    return JSON.stringify(
      type.keys.filter((k) => k !== "IsActiveEntity").map((k) => row[k]),
    );
  }

  // --- Administrative data ---

  admins(): Row[] {
    return (this.store.data[ADMIN] ||= []);
  }

  // The record for row: its own for a draft, its draft's for an active entity being edited
  admin(setName: string, type: EntityType, row: Row): Row | undefined {
    const uuid = row.IsActiveEntity
      ? this.sibling(setName, type, row, false)?.[UUID]
      : row[UUID];
    if (!uuid) return undefined;
    return this.admins().find((a) => a.DraftUUID === uuid);
  }

  newAdmin(): string {
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

  touch(row: Row): void {
    const record = this.admins().find((a) => a.DraftUUID === row[UUID]);
    if (record) record.LastChangeDateTime = now();
  }

  removeAdmin(uuid: PropertyValue | undefined): void {
    const list = this.admins();
    const idx = list.findIndex((a) => a.DraftUUID === uuid);
    if (idx !== -1) list.splice(idx, 1);
  }

  // DraftAdministrativeData of row, as related() answers a navigation
  adminRows(
    setName: string,
    type: EntityType,
    nav: DraftNavigation,
    row: Row,
  ): Related {
    const record = this.admin(setName, type, row);
    return {
      type: this.model.entityTypes[nav.targetType],
      rows: record ? [record] : [],
    };
  }

  // --- Actions ---

  // The draft action `kind` on binding.row (on the collection, for new); returns the
  // entity to answer with
  action(
    kind: DraftKind,
    op: Operation,
    { setName, type, row }: { setName: string; type: EntityType; row?: Row },
    params: Record<string, PropertyValue>,
    body: unknown,
  ): Row {
    if (kind === "new") {
      // The new entity's values: the action's parameters, or the whole body
      const values = Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== null),
      );
      const input = body && typeof body === "object" ? body : {};
      return this.create(setName, type, undefined, { ...input, ...values });
    }
    if (!row) throw new HttpError(400, `${op.name} is called on an entity`);
    const wantActive = kind === "edit";
    if (row.IsActiveEntity !== wantActive)
      throw new HttpError(
        400,
        `${op.name} is called on ${wantActive ? "an active entity" : "a draft"}`,
      );
    switch (kind) {
      case "edit":
        return this.atomic(() =>
          this.edit(setName, type, row, params.PreserveChanges),
        );
      case "activate":
        return this.atomic(() => this.activate(setName, type, row));
      default:
        return row; // prepare: activate does the validating
    }
  }

  // Copies the active entity and its compositions into a new draft. An existing draft is
  // discarded first, unless the client asked to keep it (PreserveChanges): then 409.
  edit(
    setName: string,
    type: EntityType,
    row: Row,
    preserveChanges: PropertyValue,
  ): Row {
    const existing = this.sibling(setName, type, row, false);
    if (existing) {
      if (preserveChanges)
        throw new HttpError(409, `A draft of this ${type.name} already exists`);
      this.discard(setName, type, existing);
    }
    const uuid = this.newAdmin();
    const drafts = this.tree(setName, type, row).map((n) => {
      n.row.HasDraftEntity = true;
      const draft: Row = {
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
  // and removes the draft. A draft may be incomplete, its active entity may not: the required
  // values of the whole tree are checked first (see checkRequired in service.ts).
  activate(setName: string, type: EntityType, draft: Row): Row {
    for (const n of this.tree(setName, type, draft))
      this.svc.checkRequired(
        n.type,
        n.row,
        Object.keys(n.type.properties),
        !n.row.HasActiveEntity,
      );
    const uuid = draft[UUID];
    const active = this.activateRow(setName, type, draft);
    this.removeAdmin(uuid);
    return active;
  }

  activateRow(setName: string, type: EntityType, draft: Row): Row {
    let active = this.sibling(setName, type, draft, true);
    const compositions = Object.values(type.navigations).filter(
      (nav) => nav.draft === "composition",
    );
    const before = compositions.map((nav): Related =>
      active
        ? this.svc.related(active, type, nav)
        : { type: this.model.entityTypes[nav.targetType], rows: [] },
    );
    const drafts = compositions.map((nav) =>
      this.svc.related(draft, type, nav),
    );

    this.store.remove(setName, type, this.svc.keyOf(type, draft));
    const values: Row = { ...draft, ...ACTIVE };
    delete values[UUID];
    if (active) Object.assign(active, values);
    else this.store.insert(setName, (active = values));

    compositions.forEach((nav, i) => {
      const kept = new Set(
        drafts[i].rows.map((r) => this.sharedKey(drafts[i].type, r)),
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
  discard(setName: string, type: EntityType, draft: Row): void {
    for (const n of this.tree(setName, type, draft)) {
      this.store.remove(n.setName, n.type, this.svc.keyOf(n.type, n.row));
      const active = this.sibling(n.setName, n.type, n.row, true);
      if (active) active.HasDraftEntity = false;
    }
    this.removeAdmin(draft[UUID]);
  }

  removeTree(setName: string, type: EntityType, row: Row): void {
    for (const n of this.tree(setName, type, row))
      this.store.remove(n.setName, n.type, this.svc.keyOf(n.type, n.row));
  }

  // --- Writes through the generic routes ---

  // DELETE: a draft root is discarded, a draft node removed with its compositions, an active
  // root deleted with its draft. An active node changes through its root's draft only.
  delete(setName: string, type: EntityType, row: Row): void {
    const root = this.draftOf(setName)?.root;
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
  beforeUpdate(type: EntityType, row: Row, body: unknown): unknown {
    if (row.IsActiveEntity)
      throw new HttpError(
        400,
        `${type.name} is draft-enabled: change its draft, not the active entity`,
      );
    if (!body || typeof body !== "object") return body;
    const out: Record<string, unknown> = { ...body };
    for (const name of DRAFT_COLUMNS)
      if (name in type.properties) out[name] = row[name];
    return out;
  }

  afterUpdate(row: Row): void {
    this.touch(row);
  }

  // POST: a new entity is a draft with no active entity yet. On a root's collection it
  // starts a draft tree of its own; on Parent(...)/Composition it joins the parent's draft
  // (which must be one). preset: the foreign key from the parent, as the generic create
  // takes it. Returns the created row.
  create(
    setName: string,
    type: EntityType,
    parent: Parent | undefined,
    body: unknown,
    preset: Row = {},
  ): Row {
    // The parent, when the new entity is one of its compositions
    const composed = parent?.nav.draft === "composition" ? parent : undefined;
    if (!composed && !this.draftOf(setName)?.root)
      throw new HttpError(
        400,
        `${type.name} is part of a draft-enabled entity: create it under its parent's draft`,
      );
    if (composed && composed.row.IsActiveEntity)
      throw this.activeNodeError(type);
    return this.atomic(() => {
      const uuid = composed ? composed.row[UUID] : this.newAdmin();
      const input = (body && typeof body === "object" ? body : {}) as Record<
        string,
        unknown
      >;
      const row = this.svc.create(
        setName,
        type,
        { ...input, ...this.newKey(setName, type, input), ...NEW_DRAFT },
        preset,
        true,
      );
      // Deep-inserted compositions join the draft too
      for (const n of this.tree(setName, type, row))
        Object.assign(n.row, NEW_DRAFT, { [UUID]: uuid });
      if (composed) this.touch(composed.row);
      return row;
    });
  }

  // Fiori Elements sends no key for a new entity: a missing Guid, integer or long enough
  // string key is generated (IsActiveEntity is set by the caller)
  newKey(
    setName: string,
    type: EntityType,
    input: Record<string, unknown>,
  ): Row {
    const key: Row = {};
    for (const k of type.keys) {
      if (input[k] !== undefined && input[k] !== null) continue;
      const prop = type.properties[k];
      if (
        prop.type === "Edm.Guid" ||
        (prop.type === "Edm.String" && !(Number(prop.maxLength) < 36))
      )
        key[k] = randomUUID();
      else if (INTEGER_TYPES.includes(prop.type))
        key[k] =
          Math.max(
            0,
            ...this.store.rows(setName).map((r) => Number(r[k]) || 0),
          ) + 1;
    }
    return key;
  }

  activeNodeError(type: EntityType): HttpError {
    return new HttpError(
      400,
      `${type.name} is part of a draft-enabled entity: change it in its root's draft`,
    );
  }
}

export {
  parseDraftAnnotations,
  isDraftNavigation,
  resolveDraftNavigations,
  asActive,
  draftMatch,
  draftAction,
  Drafts,
};
