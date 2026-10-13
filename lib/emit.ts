// What emit-v2.ts and emit-v4.ts share: XML escaping, and the model's types by namespace

import type { ComplexType, EntityType, EnumType, Model } from "./model.ts";

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}
// [name, value] pairs; empty values are left out
function attrs(pairs: [string, unknown][]): string {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
}
interface NamespaceTypes {
  enumTypes: EnumType[];
  complexTypes: ComplexType[];
  entityTypes: EntityType[];
}

function typesByNamespace(model: Model): Record<string, NamespaceTypes> {
  const out: Record<string, NamespaceTypes> = {};
  const ns = (name: string) =>
    (out[name] ||= { enumTypes: [], complexTypes: [], entityTypes: [] });
  for (const t of Object.values(model.enumTypes))
    ns(t.namespace).enumTypes.push(t);
  for (const t of Object.values(model.complexTypes))
    ns(t.namespace).complexTypes.push(t);
  for (const t of Object.values(model.entityTypes))
    ns(t.namespace).entityTypes.push(t);
  ns(model.container.namespace);
  return out;
}

export { esc, attrs, typesByNamespace };
