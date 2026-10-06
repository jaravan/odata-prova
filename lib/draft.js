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

const COMMON = "com.sap.vocabularies.Common.v1";
const DRAFT_NAVIGATIONS = ["SiblingEntity", "DraftAdministrativeData"];

// What a seeded or generated row of a draft entity set is: an active entity with no draft
const ACTIVE = { IsActiveEntity: true, HasActiveEntity: false, HasDraftEntity: false };

const list = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

// Reads Common.DraftRoot and Common.DraftNode on entity sets, inline or in an <Annotations>
// block targeting the set, into es.draft = { root, actions: { activate, edit, prepare, new } }
// (qualified action names; a node only has prepare). edmx and schemas are the parsed document.
function parseDraftAnnotations(model, edmx, schemas) {
  const aliases = {};
  for (const ref of list(edmx.Reference))
    for (const inc of list(ref.Include)) if (inc.Alias) aliases[inc.Alias] = inc.Namespace;
  for (const schema of schemas) if (schema.Alias) aliases[schema.Alias] = schema.Namespace;
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
        list(a.Record?.PropertyValue).map((pv) => [pv.Property, qualify(pv.String)]),
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
      if (rest.length || qualify(path) !== container || !model.entitySets[setName]) continue;
      annotate(setName, block.Annotation);
    }
  }

  for (const es of Object.values(model.entitySets)) {
    if (!es.draft) continue;
    const et = model.entityTypes[es.entityType];
    if (!et?.keys.includes("IsActiveEntity")) {
      model.warnings.push(`draft ignored: ${es.name} has no IsActiveEntity key property`);
      delete es.draft;
    }
  }
}

function isDraftType(model, et) {
  return Object.values(model.entitySets).some((es) => es.draft && es.entityType === et.fullName);
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
      const partner = nav.partner && model.entityTypes[nav.targetType].navigations[nav.partner];
      const inTree = sourceIsDraft && (nav.cascadeDelete || partner?.cascadeDelete || !target.draft.root);
      if (!inTree) nav.draft = "active";
      else if (!nav.join.some(([src]) => src === "IsActiveEntity"))
        nav.join.push(["IsActiveEntity", "IsActiveEntity"]);
    }
    if (!sourceIsDraft) continue;

    et.draftNavigations = {};
    for (const nav of et.navigationProperties) {
      if (nav.name === "SiblingEntity") {
        et.draftNavigations[nav.name] = {
          name: nav.name,
          draft: "sibling",
          targetSet: Object.values(model.entitySets).find((es) => es.draft && es.entityType === et.fullName).name,
          targetType: et.fullName,
          isCollection: false,
          join: et.keys.filter((k) => k !== "IsActiveEntity").map((k) => [k, k]),
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
    if (force || row[name] === null || row[name] === undefined) row[name] = value;
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

module.exports = {
  parseDraftAnnotations,
  isDraftNavigation,
  resolveDraftNavigations,
  asActive,
  draftMatch,
  draftAction,
};
