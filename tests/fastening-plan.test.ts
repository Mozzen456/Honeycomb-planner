/**
 * Where an accessory's OWN fastener goes — one plan, drawn and counted.
 *
 * The 3D view drew the fixings holding the plates up and nothing holding the
 * things ON them, so a part seated against an insert in the alignment tool
 * arrived on the wall with no insert under it. `fasteningPlanFor` answers that,
 * and the point of it being one function is that `computeBom` reads the same
 * answer: an insert in the picture is an insert on the list, and the reverse.
 *
 * Two properties, and they are the ones that have gone wrong before:
 *
 *   1. the COUNT is the part's fastener count, never its cell count — one
 *      insert per cell is the seven-inserts-for-two-pegs error made into a
 *      picture (CLAUDE.md);
 *   2. a socket the wall already carries supplies one rather than adding one,
 *      exactly as the parts list deducts it (D47), so nothing is drawn twice.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import overridesJson from '../src/catalog/overrides.json';
import { computeBom, fasteningPlanFor, itemCells } from '../src/core/bom';
import { fastenerCells } from '../src/core/fixings';
import { hexKey } from '../src/core/hex';
import { applyOverrides } from '../src/core/overrides';
import { Store, emptyDoc } from '../src/core/store';
import type { Catalog, Hex } from '../src/core/types';

const catalog = applyOverrides(catalogJson as unknown as Catalog, overridesJson);
const JUNCTION = 'insert-for-countersunk-hole-3';
const ORIGIN: Hex = { q: 0, r: 0 };

describe('fastenerCells — which cells carry the fastener', () => {
  // A part covering a run of seven cells, hanging on two pegs.
  const seven: Hex[] = [0, 1, 2, 3, 4, 5, 6].map((r) => ({ q: 0, r }));

  it('places the part\'s COUNT, not one per cell', () => {
    expect(fastenerCells(seven, ORIGIN, [ORIGIN], 2)).toHaveLength(2);
    expect(fastenerCells(seven, ORIGIN, [ORIGIN], 1)).toHaveLength(1);
    // Nothing at all is a real answer: plenty of parts hook over the wall.
    expect(fastenerCells(seven, ORIGIN, [ORIGIN], 0)).toEqual([]);
  });

  it('never places more than there are cells', () => {
    expect(fastenerCells([ORIGIN], ORIGIN, [ORIGIN], 5)).toHaveLength(1);
  });

  it('works out from the anchor, and repeats exactly', () => {
    const once = fastenerCells(seven, { q: 0, r: 3 }, [ORIGIN], 3).map(hexKey);
    expect(once).toEqual(['0,3', '0,2', '0,4']);
    // Same input, same answer — this decides where an insert is DRAWN in two
    // views, so it cannot wander between them.
    expect(fastenerCells([...seven].reverse(), { q: 0, r: 3 }, [ORIGIN], 3).map(hexKey))
      .toEqual(once);
  });

  it('lets a multi-cell fastener claim the cells it covers', () => {
    // A two-cell fastener spanning (0,0) and (0,1): the second one cannot start
    // in a cell the first is already in.
    const placed = fastenerCells(seven, ORIGIN, [ORIGIN, { q: 0, r: 1 }], 3).map(hexKey);
    expect(placed).toEqual(['0,0', '0,2', '0,4']);
  });

  it('skips cells that already have one', () => {
    const taken = new Set(['0,0', '0,1']);
    expect(fastenerCells(seven, ORIGIN, [ORIGIN], 2, taken).map(hexKey)).toEqual(['0,2', '0,3']);
  });
});

describe('fasteningPlanFor — over a real placement', () => {
  /** A part that takes one insert, dropped on bare wall. */
  const bare = () => {
    const store = new Store(emptyDoc(), catalog);
    store.addItem('box', { q: 4, r: 4 }, 0);
    return store.getState().doc;
  };

  /**
   * A part that wants a PLAIN insert, for the socket case.
   *
   * `box` wants an M4 one, and a plain socket does not answer that — no thread
   * (`answers` in bom.ts). Which is the right rule, and it makes `box` the
   * wrong part to test a socket with.
   */
  const PEGGED = 'hook-keyboard-bottom';

  it('gives the part its fastener, in one of its own cells', () => {
    const doc = bare();
    const item = doc.items[0]!;
    const want = catalog.parts.find((p) => p.id === 'box')!.requires ?? [];
    expect(want.length, 'box takes a fastener').toBeGreaterThan(0);

    const plan = fasteningPlanFor(doc, catalog);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.partId).toBe(want[0]!.partId);
    expect(plan[0]!.itemId).toBe(item.id);
    expect(plan[0]!.cells).toHaveLength(want[0]!.count);
    expect(plan[0]!.supplied).toEqual([]);

    // In cells the part actually covers — an insert beside the part holds
    // nothing up.
    const covered = new Set(itemCells(item, catalog).map(hexKey));
    for (const c of plan[0]!.cells) expect(covered.has(hexKey(c))).toBe(true);
  });

  it('agrees with the parts list about how many are printed', () => {
    const doc = bare();
    const plan = fasteningPlanFor(doc, catalog);
    const bom = computeBom(doc, catalog);
    for (const f of plan) {
      const line = [...bom.printed, ...bom.fasteners].find((l) => l.partId === f.partId);
      expect(line, f.partId).toBeDefined();
      expect(line!.quantity).toBeGreaterThanOrEqual(f.cells.length);
    }
  });

  /**
   * Hung on a junction fixing's own socket: the wall already HAS the insert, so
   * the plan reports it supplied and draws nothing. Drawing one here would put
   * a second insert in a hole that is full — and contradict the list, which
   * deducts it (D47).
   */
  it('takes a socket instead of adding an insert', () => {
    const store = new Store(emptyDoc(), catalog);
    store.addItem(JUNCTION, { q: 4, r: 4 }, 0);
    // (1,-1) of the junction: one of its three open sockets.
    store.addItem(PEGGED, { q: 5, r: 3 }, 0);
    // ...and a second one on bare wall, which has to buy its own.
    store.addItem(PEGGED, { q: 9, r: 9 }, 0);
    const doc = store.getState().doc;

    const plan = fasteningPlanFor(doc, catalog);
    const onSocket = plan.find((f) => f.supplied.length > 0);
    expect(onSocket, 'the pegged part still appears in the plan').toBeDefined();
    expect(onSocket!.itemPartId).toBe(PEGGED);
    expect(onSocket!.supplied.map(hexKey)).toContain('5,3');
    expect(onSocket!.cells, 'nothing extra is drawn in a full hole').toHaveLength(0);

    // The one on bare wall gets its own, drawn in its own cell.
    const onWall = plan.find((f) => f.supplied.length === 0 && f.itemPartId === PEGGED);
    expect(onWall!.cells).toHaveLength(1);

    // ...and the list says the same thing, from the same plan: one printed,
    // one already in the wall.
    const bom = computeBom(doc, catalog);
    const line = [...bom.printed, ...bom.fasteners]
      .find((l) => l.partId === onSocket!.partId);
    expect(line?.quantity).toBe(1);
    expect(line?.providedBySockets).toBe(1);
  });

  it('says nothing about an empty wall', () => {
    expect(fasteningPlanFor(emptyDoc(), catalog)).toEqual([]);
  });
});
