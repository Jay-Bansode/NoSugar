import { describe, expect, it } from 'vitest';
import { lineKey, planMerge, variantDemand } from './cart-lines.js';

const v = (variantId: string, quantity = 1, id = `id-${variantId}`) => ({
  id,
  variantId,
  bundleId: null,
  selection: null,
  quantity,
});
const b = (
  bundleId: string,
  selection: string[],
  quantity = 1,
  id = `id-${bundleId}-${selection.join('')}`,
) => ({
  id,
  variantId: null,
  bundleId,
  selection,
  quantity,
});

describe('lineKey', () => {
  it('treats bundles with the same picks in any order as the same item', () => {
    expect(lineKey(b('B', ['x', 'y']))).toBe(lineKey(b('B', ['y', 'x'])));
    expect(lineKey(b('B', ['x', 'x']))).not.toBe(lineKey(b('B', ['x', 'y'])));
    expect(lineKey(v('x'))).not.toBe(lineKey(b('x', [])));
  });
});

describe('variantDemand', () => {
  it('counts each bundle pick once per bundle ordered', () => {
    const demand = variantDemand([v('x', 2), b('B', ['x', 'y'], 3), b('C', ['y', 'y'], 1)]);
    expect(Object.fromEntries(demand)).toEqual({ x: 5, y: 5 });
  });
});

describe('planMerge', () => {
  const options = { maxLines: 3, maxQuantity: () => 99 };

  it('adds quantities of the same item and appends new ones', () => {
    const plan = planMerge([v('x', 2, 't1')], [v('x', 3), v('y', 1)], options);
    expect(plan.updates).toEqual([{ id: 't1', quantity: 5 }]);
    expect(plan.creates).toEqual([expect.objectContaining({ variantId: 'y', quantity: 1 })]);
    expect(plan.dropped).toBe(0);
  });

  it('matches bundles regardless of pick order', () => {
    const plan = planMerge([b('B', ['x', 'y'], 1, 't1')], [b('B', ['y', 'x'], 2)], options);
    expect(plan.updates).toEqual([{ id: 't1', quantity: 3 }]);
    expect(plan.creates).toEqual([]);
  });

  it('caps quantities per line (the trial kit stays at 1)', () => {
    const plan = planMerge([v('trial', 1, 't1')], [v('trial', 1), v('x', 120)], {
      maxLines: 10,
      maxQuantity: (line) => (line.variantId === 'trial' ? 1 : 99),
    });
    expect(plan.updates).toEqual([]); // already at the cap
    expect(plan.creates).toEqual([expect.objectContaining({ variantId: 'x', quantity: 99 })]);
  });

  it('drops new items beyond the line limit but still merges existing ones', () => {
    const plan = planMerge(
      [v('a', 1, 't1'), v('b', 1, 't2')],
      [v('c'), v('d'), v('a', 1)],
      options,
    );
    expect(plan.creates.map((l) => l.variantId)).toEqual(['c']);
    expect(plan.dropped).toBe(1);
    expect(plan.updates).toEqual([{ id: 't1', quantity: 2 }]);
  });

  it('combines duplicate lines within the guest cart', () => {
    const plan = planMerge([], [v('x', 1, 'g1'), v('x', 2, 'g2')], options);
    expect(plan.creates).toEqual([expect.objectContaining({ variantId: 'x', quantity: 3 })]);
  });
});
