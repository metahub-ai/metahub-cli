/**
 * `metahub_get` — fetch one full artifact record by kind+slug.
 */
import type { ItemKind, RegistryItem } from "../types.js";

export interface GetInput {
  kind: ItemKind;
  slug: string;
}

export function getItem(items: RegistryItem[], input: GetInput): RegistryItem | null {
  return items.find((i) => i.kind === input.kind && i.slug === input.slug) ?? null;
}
