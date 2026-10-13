// Resolves each entity type's navigation properties into navigations (see model.ts): the
// target entity set, and the join between the two sides' rows. A V2 document says it in
// associations, a V4 document in referential constraints; without either, the join is
// guessed from the property names (see joinByNaming).

import type {
  EntityType,
  JoinPair,
  Model,
  NavigationProperty,
  V2NavigationProperty,
  V4NavigationProperty,
} from "./model.ts";
import { isDraftNavigation } from "./draft.ts";

// How a navigation's rows join: which side holds the foreign key, and the property pairs
interface Join {
  dependentSide: "source" | "target";
  pairs: JoinPair[];
}

function setsByType(model: Model): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const es of Object.values(model.entitySets))
    (out[es.entityType] ||= []).push(es.name);
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
    // Deleting a principal takes its dependents with it when they cannot exist on their
    // own, i.e. when the foreign key is part of the dependent's key (an order's items,
    // keyed by order id + position). A plain lookup reference is left alone. V4 can also
    // say so explicitly (OnDelete Cascade / ContainsTarget).
    cascadeDelete:
      cascadeHint ||
      (dependentIsTarget &&
        join.pairs.every(([, targetProp]) =>
          targetType.keys.includes(targetProp),
        )),
  };
}

function resolveNavigationsV2(model: Model): void {
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
          join = joinByNaming(
            model,
            et,
            nav,
            targetType,
            assoc.name,
            fromEnd.multiplicity === "*",
          );
        }
        finishNavigation(et, nav, targetType, targetSet, join, false);
      });
  }
}

function resolveNavigationsV4(model: Model): void {
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
// Every join found this way is logged: it's a guess.
function joinByNaming(
  model: Model,
  sourceType: EntityType,
  nav: NavigationProperty,
  targetType: EntityType,
  relationshipName: string,
  sourceIsMany: boolean,
): Join {
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
  throw new Error(
    `${sourceType.name}.${nav.name}: cannot derive join condition for ${relationshipName} - ` +
      `add a ReferentialConstraint to metadata.xml`,
  );
}

// Marks navigations that are each other's inverse, so V2 emission can share one
// Association between them and V4 emission can write Partner.
function resolvePartners(model: Model): void {
  for (const et of Object.values(model.entityTypes)) {
    for (const nav of Object.values(et.navigations)) {
      const target = model.entityTypes[nav.targetType];
      const reverse = nav.join.map(([s, t]) => [t, s]);
      const partner = Object.values(target.navigations).find(
        (back) =>
          back.targetType === et.fullName &&
          JSON.stringify(back.join) === JSON.stringify(reverse) &&
          back !== nav,
      );
      nav.partner = partner?.name;
    }
  }
}

export {
  setsByType,
  resolveNavigationsV2,
  resolveNavigationsV4,
  resolvePartners,
};
