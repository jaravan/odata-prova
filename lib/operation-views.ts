// The operations as each protocol serves them (model.operationViews), the one the metadata
// wasn't written in translated from the other.
//
// V2 has no bound operations: SAP Gateway models an operation on an entity as a function
// import that takes the entity's key as parameters and names its type in sap:action-for.
// The views map between the protocols and keep the names:
//   V2 import with sap:action-for and all key parameters <-> V4 operation bound to that type
//   any other V2 function import                         <-> V4 action or function import
// In a V2 view, an operation on an entity has bindsTo: { type, setName, isCollection }; the
// service finds the entity from the key parameters.

import type {
  EntityType,
  Model,
  Operation,
  OperationView,
  TypedElement,
} from "./model.ts";

function firstSetOf(model: Model, typeName: string): string | undefined {
  return Object.values(model.entitySets).find(
    (es) => es.entityType === typeName,
  )?.name;
}

function bindingParameter(et: EntityType, isCollection = false): TypedElement {
  const type = isCollection ? `Collection(${et.fullName})` : et.fullName;
  return {
    name: "_it",
    type,
    v2Type: type,
    sap: {},
    elementType: et.fullName,
    isCollection,
    entityType: et,
    nullable: false,
  };
}

function v2ViewOfV2(model: Model): OperationView {
  const imports: Record<string, Operation> = {};
  for (const op of Object.values(model.operations.imports)) {
    const et = op.actionFor ? model.entityTypes[op.actionFor] : undefined;
    const byKey =
      et && et.keys.every((k) => op.parameters.some((p) => p.name === k));
    const setName =
      et &&
      byKey &&
      (op.entitySet &&
      model.entitySets[op.entitySet]?.entityType === et.fullName
        ? op.entitySet
        : firstSetOf(model, et.fullName));
    imports[op.name] =
      et && setName
        ? { ...op, bindsTo: { type: et, setName, isCollection: false } }
        : op;
  }
  return { bound: [], imports };
}

function v4ViewOfV2(model: Model): OperationView {
  const ns = model.container.namespace;
  const view: OperationView = { bound: [], imports: {} };
  for (const op of Object.values(v2ViewOfV2(model).imports)) {
    const base = {
      name: op.name,
      fullName: `${ns}.${op.name}`,
      // V4 functions need a return type: a V2 GET import without one becomes an action
      kind:
        op.kind === "function" && !op.returnType
          ? ("action" as const)
          : op.kind,
      returnType: op.returnType,
    };
    if (op.bindsTo) {
      const keys = op.bindsTo.type.keys;
      view.bound.push({
        ...base,
        isBound: true,
        binding: bindingParameter(op.bindsTo.type),
        parameters: op.parameters.filter((p) => !keys.includes(p.name)),
      });
    } else {
      view.imports[op.name] = {
        ...base,
        isBound: false,
        parameters: op.parameters,
        entitySet: op.entitySet,
      };
    }
  }
  return view;
}

function v2ViewOfV4(model: Model): OperationView {
  const imports: Record<string, Operation> = {};
  const skip = (op: Operation, why: string) =>
    model.warnings.push(`not in V2: ${op.kind} ${op.name}: ${why}`);
  const returnSet = (op: Operation) =>
    op.returnType?.entityType
      ? firstSetOf(model, op.returnType.elementType)
      : undefined;
  const uniqueName = (name: string, suffix: string) =>
    imports[name] ? `${name}_${suffix}` : name;
  // V2 function import parameters are primitive
  const primitiveParams = (op: Operation) =>
    op.parameters.every((p) => !p.complexType && !p.isCollection);

  for (const op of model.operations.bound) {
    // A bound operation has one (see parseOperations in metadata.ts)
    const binding = op.binding!;
    const et = binding.entityType;
    if (!et) {
      skip(op, `bound to ${binding.type}, not an entity type`);
      continue;
    }
    const setName = firstSetOf(model, et.fullName);
    if (!setName) {
      skip(op, `no entity set for ${et.name}`);
      continue;
    }
    if (!primitiveParams(op)) {
      skip(op, "complex or collection parameters");
      continue;
    }
    const keys = binding.isCollection
      ? []
      : et.keys.map((k) => et.properties[k]);
    if (op.parameters.some((p) => keys.some((k) => k.name === p.name))) {
      skip(op, `a parameter has the name of a key property of ${et.name}`);
      continue;
    }
    const name = uniqueName(op.name, et.name);
    imports[name] = {
      ...op,
      name,
      isBound: false,
      binding: undefined,
      httpMethod: op.kind === "action" ? "POST" : "GET",
      parameters: [...keys, ...op.parameters],
      entitySet: returnSet(op),
      bindsTo: { type: et, setName, isCollection: binding.isCollection },
      actionFor: binding.isCollection ? undefined : et.fullName,
    };
  }
  for (const op of Object.values(model.operations.imports)) {
    if (!primitiveParams(op)) {
      skip(op, "complex or collection parameters");
      continue;
    }
    const name = uniqueName(op.name, "Import");
    imports[name] = {
      ...op,
      name,
      importName: op.name,
      httpMethod: op.kind === "action" ? "POST" : "GET",
      entitySet: op.entitySet || returnSet(op),
    };
  }
  return { bound: [], imports };
}

export { v2ViewOfV2, v4ViewOfV2, v2ViewOfV4 };
