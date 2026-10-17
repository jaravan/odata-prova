// Resolves each entity type's navigation properties into navigations (see model.ts): the
// target entity set, and the join between the two sides' rows. A V2 document says it in
// associations, a V4 document in referential constraints; without either, the join is
// guessed from the property names (see joinByNaming), unless joins are strict. A
// single-valued navigation with no join at all gets a foreign key of its own (see
// hiddenKey), and a collection one a link set (see linkSet).

import type {
  EntityType,
  EntitySet,
  JoinPair,
  LinkSet,
  Model,
  NavigationProperty,
  V2NavigationProperty,
  V4NavigationProperty,
} from "./model.ts";
import { isDraftNavigation } from "./draft.ts";

// How a navigation without a ReferentialConstraint is joined:
//   guess   (the default) by naming convention (see joinByNaming), logged as a guess
//   strict  not at all: the navigation is disabled, like one the server can't join, so a
//           wrong guess can't show the wrong rows
const JOIN_MODES = ["guess", "strict"] as const;
type JoinMode = (typeof JOIN_MODES)[number];

// How a navigation's rows join: which side holds the foreign key, and the property pairs
interface Join {
  dependentSide: "source" | "target";
  pairs: JoinPair[];
  hidden?: boolean;
  links?: { set: string; from: 0 | 1 };
}

// contained: with the contained sets (see resolveContainment)
function setsByType(model: Model, contained = true): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const es of Object.values(model.entitySets))
    if (contained || !es.contained) (out[es.entityType] ||= []).push(es.name);
  return out;
}

function finishNavigation(
  et: EntityType,
  nav: NavigationProperty,
  targetType: EntityType,
  targetSet: string,
  join: Join,
  cascadeHint: boolean,
): void {
  const dependentIsTarget = join.dependentSide === "target";
  et.navigations[nav.name] = {
    name: nav.name,
    targetSet,
    targetType: targetType.fullName,
    isCollection: nav.isCollection ?? false,
    dependentSide: join.dependentSide,
    join: join.pairs,
    ...(join.hidden ? { hidden: true } : {}),
    ...(join.links ? { links: join.links } : {}),
    // Deleting a principal takes its dependents with it when they cannot exist on their
    // own, i.e. when the foreign key is part of the dependent's key (an order's items,
    // keyed by order id + position). A plain lookup reference is left alone. V4 can also
    // say so explicitly (OnDelete Cascade / ContainsTarget).
    cascadeDelete:
      cascadeHint ||
      (dependentIsTarget &&
        join.pairs.length > 0 &&
        join.pairs.every(([, targetProp]) =>
          targetType.keys.includes(targetProp),
        )),
  };
}

function resolveNavigationsV2(model: Model, joins: JoinMode): void {
  const byType = setsByType(model);
  for (const et of Object.values(model.entityTypes)) {
    et.navigations = {};
    et.disabledNavigations = {};
    // SiblingEntity and DraftAdministrativeData: see resolveDraftNavigations. A V2
    // document has only V2 navigation properties.
    const navs = (et.navigationProperties as V2NavigationProperty[]).filter(
      (nav) => !isDraftNavigation(model, et, nav),
    );
    for (const nav of navs)
      disableOnError(model, et, nav, () => {
        const assoc = model.associations[nav.relationship];
        if (!assoc)
          throw new Error(
            `${et.name}.${nav.name}: unknown association ${nav.relationship}`,
          );
        const fromEnd = assoc.ends.find((e) => e.role === nav.fromRole);
        const toEnd = assoc.ends.find((e) => e.role === nav.toRole);
        if (!fromEnd || !toEnd)
          throw new Error(
            `${et.name}.${nav.name}: roles not found in ${assoc.name}`,
          );
        const targetType = model.entityTypes[toEnd.type];
        if (!targetType)
          throw new Error(
            `${et.name}.${nav.name}: unknown target type ${toEnd.type}`,
          );

        // Prefer the AssociationSet to pick the target entity set; fall back to "main" set of that type.
        const assocSet = model.associationSets.find(
          (as) => as.association === assoc.fullName,
        );
        const targetSet =
          assocSet?.ends.find((e) => e.role === nav.toRole)?.entitySet ||
          (byType[toEnd.type] || [])[0];
        if (!targetSet)
          throw new Error(
            `${et.name}.${nav.name}: no entity set for ${toEnd.type}`,
          );

        nav.isCollection = toEnd.multiplicity === "*";
        const rc = assoc.referentialConstraint;
        let join: Join;
        if (rc && rc.principal.role === nav.fromRole) {
          join = {
            dependentSide: "target",
            pairs: rc.principal.properties.map((p, i): JoinPair => [
              p,
              rc.dependent.properties[i],
            ]),
          };
        } else if (rc) {
          join = {
            dependentSide: "source",
            pairs: rc.dependent.properties.map((p, i): JoinPair => [
              p,
              rc.principal.properties[i],
            ]),
          };
        } else {
          // The navigation back, on the association's other end
          const back = (
            targetType.navigationProperties as V2NavigationProperty[]
          ).find(
            (p) =>
              p.relationship === nav.relationship && p.fromRole === nav.toRole,
          );
          join = joinByNaming(
            model,
            et,
            nav,
            targetType,
            assoc.name,
            fromEnd.multiplicity === "*",
            joins,
            { back, targetSet },
          );
        }
        finishNavigation(et, nav, targetType, targetSet, join, false);
      });
  }
}

// Containment (ContainsTarget) whose target no entity set holds, as TripPin's Person.Trips:
// each such navigation of an entity set's type gets an entity set of the server's own,
// <set>-<navigation> (People-Trips), and so on down (People-Trips-PlanItems). Its type keeps
// its parent's keys in hidden columns, named <ParentType>_<key> (Person_UserName), or as
// the parent has them when it's contained too, so a data file fills them like any column.
// Returns the contained set of each navigation, by "<type>/<navigation>".
function resolveContainment(model: Model): Record<string, string> {
  const setOf: Record<string, string> = {};
  const bound = new Set(
    Object.values(model.entitySets).flatMap((es) =>
      es.bindings.map((b) => b.target),
    ),
  );
  const contain = (parent: EntitySet, chain: string[]) => {
    const type = model.entityTypes[parent.entityType];
    for (const nav of type.navigationProperties as V4NavigationProperty[]) {
      // CAP's DraftAdministrativeData is contained, and draft.ts's
      if (!nav.containsTarget || isDraftNavigation(model, type, nav)) continue;
      const targetName = nav.type.replace(/^Collection\((.+)\)$/, "$1");
      const target = model.entityTypes[targetName];
      const binding = parent.bindings.find((b) => b.path === nav.name);
      // A target with an entity set of its own, or a type that would contain itself
      if (!target || (binding && bound.has(binding.target))) continue;
      if (chain.includes(targetName)) continue;
      // The parent's keys as the child keeps them
      const identity = [...(type.parentKeys ?? []), ...type.keys];
      const columns = identity.map((k) =>
        type.parentKeys?.includes(k) ? k : `${type.name}_${k}`,
      );
      for (const [i, column] of columns.entries()) {
        const prop =
          type.hiddenKeys?.[identity[i]] ?? type.properties[identity[i]];
        (target.hiddenKeys ??= {})[column] = {
          ...prop,
          name: column,
          nullable: true,
        };
        if (!(target.parentKeys ??= []).includes(column))
          target.parentKeys.push(column);
      }
      const set: EntitySet = {
        name: `${parent.name}-${nav.name}`,
        entityType: targetName,
        bindings: [],
        contained: { parentSet: parent.name, navigation: nav.name },
      };
      model.entitySets[set.name] = set;
      setOf[`${type.fullName}/${nav.name}`] ??= set.name;
      model.warnings.push(
        `navigation with an entity set of its own: ${type.name}.${nav.name} in ${set.name} (containment; a data file can fill it)`,
      );
      contain(set, [...chain, targetName]);
    }
  };
  for (const es of Object.values(model.entitySets))
    contain(es, [es.entityType]);
  return setOf;
}

function resolveNavigationsV4(model: Model, joins: JoinMode): void {
  const contained = resolveContainment(model);
  const byType = setsByType(model);
  for (const et of Object.values(model.entityTypes)) {
    et.navigations = {};
    et.disabledNavigations = {};
    // SiblingEntity and DraftAdministrativeData have no join: see resolveDraftNavigations.
    // A V4 document has only V4 navigation properties.
    const navs = (et.navigationProperties as V4NavigationProperty[]).filter(
      (nav) => !isDraftNavigation(model, et, nav),
    );
    for (const nav of navs)
      disableOnError(model, et, nav, () => {
        const m = nav.type.match(/^Collection\((.+)\)$/);
        nav.isCollection = !!m;
        const targetTypeName = m ? m[1] : nav.type;
        const targetType = model.entityTypes[targetTypeName];
        if (!targetType)
          throw new Error(
            `${et.name}.${nav.name}: unknown target type ${targetTypeName}`,
          );

        // Into a contained set: joined on its parent's keys, which it keeps (see
        // resolveContainment)
        const containedSet = contained[`${et.fullName}/${nav.name}`];
        if (containedSet) {
          const identity = [...(et.parentKeys ?? []), ...et.keys];
          const pairs = identity.map((k): JoinPair => [
            k,
            et.parentKeys?.includes(k) ? k : `${et.name}_${k}`,
          ]);
          finishNavigation(
            et,
            nav,
            targetType,
            containedSet,
            { dependentSide: "target", pairs, hidden: true },
            true,
          );
          et.navigations[nav.name].contained = true;
          return;
        }

        let targetSet: string | undefined;
        for (const setName of byType[et.fullName] || []) {
          const binding = model.entitySets[setName].bindings.find(
            (b) => b.path === nav.name,
          );
          if (binding) {
            targetSet = binding.target;
            break;
          }
        }
        targetSet ||= (byType[targetTypeName] || [])[0];
        if (!targetSet)
          throw new Error(
            `${et.name}.${nav.name}: no entity set for ${targetTypeName}`,
          );

        let join: Join;
        if (nav.constraints.length) {
          join = {
            dependentSide: "source",
            pairs: nav.constraints.map((c): JoinPair => [
              c.property,
              c.referencedProperty,
            ]),
          };
        } else {
          // The constraint lives on the dependent side; for the other direction look at the partner.
          const targetNavs =
            targetType.navigationProperties as V4NavigationProperty[];
          const partner = nav.partner
            ? targetNavs.find((p) => p.name === nav.partner)
            : targetNavs.find(
                (p) =>
                  p.type.replace(/^Collection\((.+)\)$/, "$1") ===
                    et.fullName && p.constraints.length,
              );
          if (partner && partner.constraints.length) {
            join = {
              dependentSide: "target",
              pairs: partner.constraints.map((c): JoinPair => [
                c.referencedProperty,
                c.property,
              ]),
            };
          } else {
            // Many on the source's end: the partner (named, or else any navigation back) is a collection
            const back =
              targetNavs.find((p) => p.name === nav.partner) ||
              targetNavs.find(
                (p) =>
                  p.type.replace(/^Collection\((.+)\)$/, "$1") === et.fullName,
              );
            join = joinByNaming(
              model,
              et,
              nav,
              targetType,
              nav.name,
              /^Collection\(/.test(back?.type || ""),
              joins,
              { back, targetSet },
            );
          }
        }
        finishNavigation(
          et,
          nav,
          targetType,
          targetSet,
          join,
          nav.onDeleteCascade || nav.containsTarget,
        );
      });
  }
}

// A navigation the server cannot resolve (unknown association, no join condition, ...) is
// switched off instead of failing the whole model: real services often have a few, e.g.
// many-to-many links. Requests that use it get a 501; everything else keeps working.
function disableOnError(
  model: Model,
  et: EntityType,
  nav: NavigationProperty,
  resolve: () => void,
): void {
  try {
    resolve();
  } catch (e) {
    const message = (e as Error).message;
    (et.disabledNavigations ??= {})[nav.name] = message;
    model.warnings.push(`navigation disabled: ${message}`);
  }
}

// Join condition by naming convention, for a navigation with no ReferentialConstraint on
// either side. The first that fits wins:
//   1. the target carries the source's key names (parent -> children: an item keyed by
//      SalesOrder + ItemNo under a sales order keyed by SalesOrder)
//   2. the source carries the target's key names (child -> parent)
//   3. a foreign key named after the other side, for a single key K: <Source>K or
//      <Source>_K on the target (Item.OrderID), <nav>K, <nav>_K, <Target>K or <Target>_K
//      on the source (Item.OrderID, CAP's author_ID)
// A match of 1 or 2 that is the other side's whole key too joins the two keys to each other,
// one row to one row. That suits a one-to-one link, but not a navigation with a "many" side
// (an order's ID is not its items' ID) or one from a type to itself, so it is skipped there.
// sourceIsMany: whether the source's end is "many" (V2's multiplicity, V4's partner).
// Every join found this way is logged: it's a guess. With strict joins there is no guess.
// Without a join either way, a single-valued navigation gets a key of its own, and so does a
// collection whose navigation back (single-valued) is one (see hiddenKey), and any other
// collection a link set (see linkSet). other: the navigation back from the target, if any,
// and the target's entity set
function joinByNaming(
  model: Model,
  sourceType: EntityType,
  nav: NavigationProperty,
  targetType: EntityType,
  relationshipName: string,
  sourceIsMany: boolean,
  joins: JoinMode,
  other: { back?: NavigationProperty; targetSet: string },
): Join {
  const { back, targetSet } = other;
  const own = (): Join | undefined => {
    if (!nav.isCollection) return hiddenKey(model, sourceType, nav, targetType);
    if (back && !sourceIsMany) {
      const pairs = hiddenKey(model, targetType, back, sourceType).pairs.map(
        ([column, k]): JoinPair => [k, column],
      );
      return { dependentSide: "target", pairs, hidden: true };
    }
    return linkSet(model, sourceType, nav, targetType, targetSet, back);
  };
  const logged = (join: Join | undefined) => {
    if (join?.links)
      model.warnings.push(
        `navigation with links of its own: ${sourceType.name}.${nav.name} in ${join.links.set} (no ReferentialConstraint; a data file can fill it)`,
      );
    else if (join)
      model.warnings.push(
        `navigation with a key of its own: ${sourceType.name}.${nav.name} on ${join.pairs
          .map(([s, t]) =>
            join.dependentSide === "source" ? s : `${targetType.name}.${t}`,
          )
          .join(", ")} (no ReferentialConstraint; a data file can fill it)`,
      );
    return join;
  };
  if (joins === "strict") {
    const join = logged(own());
    if (join) return join;
    throw new Error(
      `${sourceType.name}.${nav.name}: no ReferentialConstraint for ${relationshipName}, ` +
        `and joins are strict (not guessed) - add one to metadata.xml`,
    );
  }
  const many = nav.isCollection || sourceIsMany || sourceType === targetType;
  // Joins one side's whole key to the other's: the props, all of `type`'s keys
  const isWholeKey = (type: EntityType, props: string[]) =>
    props.length === type.keys.length &&
    type.keys.every((k) => props.includes(k));
  const found = (dependentSide: Join["dependentSide"], pairs: JoinPair[]) => {
    const on = pairs
      .map(([s, t]) => `${sourceType.name}.${s} = ${targetType.name}.${t}`)
      .join(", ");
    model.warnings.push(
      `navigation joined by naming: ${sourceType.name}.${nav.name} on ${on} (no ReferentialConstraint)`,
    );
    return { dependentSide, pairs };
  };

  // An empty key list would "match" by default and join every row to every row
  if (
    sourceType.keys.length &&
    sourceType.keys.every((k) => targetType.properties[k]) &&
    !(many && isWholeKey(targetType, sourceType.keys))
  )
    return found(
      "target",
      sourceType.keys.map((k): JoinPair => [k, k]),
    );
  if (
    targetType.keys.length &&
    targetType.keys.every((k) => sourceType.properties[k]) &&
    !(many && isWholeKey(sourceType, targetType.keys))
  )
    return found(
      "source",
      targetType.keys.map((k): JoinPair => [k, k]),
    );

  // Gateway entity types are often named <Entity>Type
  const base = (type: EntityType) => type.name.replace(/Type$/, "");
  const named = (type: EntityType, names: string[]) =>
    names.find((n) => type.properties[n] && !type.keys.includes(n));
  if (sourceType.keys.length === 1) {
    const k = sourceType.keys[0];
    const fk = named(targetType, [
      `${base(sourceType)}${k}`,
      `${base(sourceType)}_${k}`,
    ]);
    if (fk) return found("target", [[k, fk]]);
  }
  if (targetType.keys.length === 1) {
    const k = targetType.keys[0];
    const fk = named(sourceType, [
      `${nav.name}${k}`,
      `${nav.name}_${k}`,
      `${base(targetType)}${k}`,
      `${base(targetType)}_${k}`,
    ]);
    if (fk) return found("source", [[fk, k]]);
  }
  const join = logged(own());
  if (join) return join;
  throw new Error(
    `${sourceType.name}.${nav.name}: cannot derive join condition for ${relationshipName} - ` +
      `add a ReferentialConstraint to metadata.xml`,
  );
}

// A single-valued navigation that nothing joins (TripPin's Person.Photo) gets a foreign key
// of its own: a hidden column for each of the target's keys, <nav>_<key> (Photo_Id), the
// name joinByNaming would have taken. A data file fills it in that column, and generated
// rows point it at real ones, like any foreign key. It's not a guess: the server keeps it.
// Its partner, a collection (an order's Items, for an item's Order), joins back on it.
function hiddenKey(
  model: Model,
  sourceType: EntityType,
  nav: NavigationProperty,
  targetType: EntityType,
): Join {
  if (!targetType.keys.length)
    throw new Error(
      `${sourceType.name}.${nav.name}: ${targetType.name} has no key to point at`,
    );
  const pairs = targetType.keys.map((k): JoinPair => [`${nav.name}_${k}`, k]);
  for (const [column, k] of pairs)
    (sourceType.hiddenKeys ??= {})[column] = {
      ...targetType.properties[k],
      name: column,
      nullable: true,
    };
  return { dependentSide: "source", pairs, hidden: true };
}

// A collection navigation no key can join (a many-to-many link, Person.Friends, or one with no
// navigation back) is joined through a link set: pairs of the two sides' keys, which a data
// file fills (data/People-Friends.csv: UserName;Friends_UserName), and generated data links
// at random. It's named after the source's entity set and the navigation; a navigation and
// its partner, a collection too, share one, named after whichever of the two sorts first.
// Undefined when the source has no entity set to link (a contained one).
function linkSet(
  model: Model,
  sourceType: EntityType,
  nav: NavigationProperty,
  targetType: EntityType,
  targetSet: string,
  back: NavigationProperty | undefined,
): Join | undefined {
  const sourceSet = setsByType(model)[sourceType.fullName]?.[0];
  if (!sourceSet || !sourceType.keys.length || !targetType.keys.length)
    return undefined;
  const mine = `${sourceType.fullName}/${nav.name}`;
  const theirs = back && `${targetType.fullName}/${back.name}`;
  const owned = !theirs || mine <= theirs;
  // The owner's source end first, with its keys as they are; the other's columns are named
  // after the owner's navigation
  const [first, second, ownerNav] = owned
    ? [
        { set: sourceSet, type: sourceType },
        { set: targetSet, type: targetType },
        nav.name,
      ]
    : [
        { set: targetSet, type: targetType },
        { set: sourceSet, type: sourceType },
        back.name,
      ];
  // A contained entity's keys include its parent's (see resolveContainment)
  const identity = (type: EntityType) => [
    ...(type.parentKeys ?? []),
    ...type.keys,
  ];
  const set: LinkSet = {
    name: `${first.set}-${ownerNav}`,
    ends: [
      {
        set: first.set,
        keys: identity(first.type),
        columns: identity(first.type),
      },
      {
        set: second.set,
        keys: identity(second.type),
        columns: identity(second.type).map((k) => `${ownerNav}_${k}`),
      },
    ],
  };
  model.linkSets[set.name] ??= set;
  return {
    dependentSide: "target",
    pairs: [],
    hidden: true,
    links: { set: set.name, from: owned ? 0 : 1 },
  };
}

// Marks navigations that are each other's inverse, so V2 emission can share one
// Association between them and V4 emission can write Partner.
function resolvePartners(model: Model): void {
  for (const et of Object.values(model.entityTypes)) {
    for (const nav of Object.values(et.navigations)) {
      const target = model.entityTypes[nav.targetType];
      const reverse = nav.join.map(([s, t]) => [t, s]);
      // Through a link set: the other navigation through it, from its other end
      const partner = Object.values(target.navigations).find((back) =>
        nav.links
          ? back.links?.set === nav.links.set &&
            back.links.from !== nav.links.from
          : !back.links &&
            back.targetType === et.fullName &&
            JSON.stringify(back.join) === JSON.stringify(reverse) &&
            back !== nav,
      );
      nav.partner = partner?.name;
    }
  }
}

export type { JoinMode };
export {
  JOIN_MODES,
  setsByType,
  resolveNavigationsV2,
  resolveNavigationsV4,
  resolvePartners,
};
