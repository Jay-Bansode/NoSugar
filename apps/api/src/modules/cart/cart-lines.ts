/**
 * Pure cart-line rules: identity (when two lines are "the same item"), stock demand and
 * merging a guest cart into a customer's cart. No database access, so fully unit-tested.
 */

export interface LineIdentity {
  variantId: string | null;
  bundleId: string | null;
  selection: readonly string[] | null;
}

export interface StoredLine extends LineIdentity {
  id: string;
  quantity: number;
}

export interface NewLine extends LineIdentity {
  quantity: number;
}

/**
 * Two lines are the same item if they are the same variant, or the same bundle with the same
 * picks in any order ([A, B] and [B, A] are the same box).
 */
export function lineKey(line: LineIdentity): string {
  if (line.variantId) return `v:${line.variantId}`;
  return `b:${line.bundleId}:${[...(line.selection ?? [])].sort().join(',')}`;
}

/** Packs needed per variant: a bundle line needs one of each pick per bundle ordered. */
export function variantDemand(
  lines: readonly (LineIdentity & { quantity: number })[],
): Map<string, number> {
  const demand = new Map<string, number>();
  const add = (variantId: string, quantity: number) =>
    demand.set(variantId, (demand.get(variantId) ?? 0) + quantity);
  for (const line of lines) {
    if (line.variantId) add(line.variantId, line.quantity);
    else for (const pick of line.selection ?? []) add(pick, line.quantity);
  }
  return demand;
}

export interface MergePlan {
  updates: { id: string; quantity: number }[];
  creates: NewLine[];
  /** Guest lines dropped because the customer's cart was full. */
  dropped: number;
}

/**
 * Plans merging `source` (guest cart) into `target` (customer's cart): same items add up,
 * capped per line by `maxQuantity`; new items are appended up to `maxLines`.
 */
export function planMerge(
  target: readonly StoredLine[],
  source: readonly NewLine[],
  options: { maxLines: number; maxQuantity: (line: LineIdentity) => number },
): MergePlan {
  const byKey = new Map(target.map((line) => [lineKey(line), { ...line }]));
  const created = new Map<string, NewLine>();
  const updated = new Set<string>();
  let dropped = 0;

  for (const line of source) {
    const key = lineKey(line);
    const cap = options.maxQuantity(line);
    const existing = byKey.get(key);
    if (existing) {
      const quantity = Math.min(existing.quantity + line.quantity, cap);
      if (quantity !== existing.quantity) {
        existing.quantity = quantity;
        updated.add(existing.id);
      }
      continue;
    }
    const pending = created.get(key);
    if (pending) {
      pending.quantity = Math.min(pending.quantity + line.quantity, cap);
      continue;
    }
    if (byKey.size + created.size >= options.maxLines) {
      dropped++;
      continue;
    }
    created.set(key, { ...line, quantity: Math.min(line.quantity, cap) });
  }

  return {
    updates: [...byKey.values()]
      .filter((line) => updated.has(line.id))
      .map(({ id, quantity }) => ({ id, quantity })),
    creates: [...created.values()],
    dropped,
  };
}
