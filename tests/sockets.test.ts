/**
 * Mounting positions ON a part: cells you can install something else into.
 *
 * `insert-for-countersunk-hole-3` is the case that named this. It spans four
 * cells, ties four plates together and takes one wall screw — and three of those
 * four cells are open 13.2 mm hexagonal sockets, measured off the mating face by
 * matching each enclosed hole's centroid to a cell of the footprint. The planner
 * treated all four as filled and refused everything in them, which is the right
 * rule for a plain insert and the wrong one for a part that IS the hole.
 *
 * Two properties this file exists to hold:
 *   1. a socket accepts ONE thing, and the next is refused;
 *   2. an accessory hung over a hole does not make the hole look empty.
 *
 * (2) is a bug this work found rather than a feature it added: the occupancy
 * index kept one item id per cell, so a hook dropped on an insert HID it, and
 * the cell then took a second insert as if it were bare wall.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import overridesJson from '../src/catalog/overrides.json';
import { itemSocketCells } from '../src/core/bom';
import { hexKey } from '../src/core/hex';
import { applyOverrides, socketsOf } from '../src/core/overrides';
import { Store, emptyDoc } from '../src/core/store';
import type { Catalog } from '../src/core/types';

const catalog = applyOverrides(catalogJson as unknown as Catalog, overridesJson);
const JUNCTION = 'insert-for-countersunk-hole-3';
const at = { q: 4, r: 4 };

const junction = catalog.parts.find((p) => p.id === JUNCTION)!;

describe('the shipped junction fastener', () => {
  /**
   * Measured, not chosen: three 13.2 mm across-flats holes and one 3.2 mm bore
   * for the wall screw, each landing dead centre of a different cell.
   */
  it('carries three sockets and one screw cell', () => {
    expect(junction.footprint).toHaveLength(4);
    expect(socketsOf(junction).map(hexKey).sort()).toEqual(['0,0', '1,0', '2,-1'].sort());
    // The fourth cell — the wall screw — is deliberately NOT a socket.
    expect(socketsOf(junction).map(hexKey)).not.toContain('1,-1');
  });

  it('marks the whole hollow family, which is sockets all the way across', () => {
    for (const [id, count] of [
      ['insert-hollow-dual', 2], ['insert-hollow-tre', 3], ['insert-hollow-for', 4],
    ] as const) {
      const part = catalog.parts.find((p) => p.id === id)!;
      expect(socketsOf(part), id).toHaveLength(count);
      expect(socketsOf(part).length, id).toBe(part.footprint.length);
    }
  });

  /** A socket is placed by the same transform as the cell it belongs to. */
  it('puts its sockets on the wall where its cells are', () => {
    const store = new Store(emptyDoc(), catalog);
    store.addItem(JUNCTION, at, 0);
    const item = store.getState().doc.items[0]!;
    const sockets = itemSocketCells(item, catalog).map(hexKey);
    expect(sockets.sort()).toEqual(['4,4', '5,4', '6,3'].sort());
  });
});

describe('installing into a socket', () => {
  const socket = { q: 5, r: 4 };   // (1,0) of the junction placed at (4,4)
  const screw = { q: 5, r: 3 };    // (1,-1) — the wall screw, not a socket

  const wall = (): Store => {
    const store = new Store(emptyDoc(), catalog);
    store.addItem(JUNCTION, at, 0);
    return store;
  };

  it('takes an insert, which is the whole point', () => {
    const store = wall();
    expect(store.addItem('insert-empty', socket, 0).ok).toBe(true);
  });

  it('still refuses the cell that carries the wall screw', () => {
    const store = wall();
    const result = store.addItem('insert-empty', screw, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/one insert per hole/);
  });

  /** One socket, one thing in it. */
  it('refuses a second insert in the same socket', () => {
    const store = wall();
    expect(store.addItem('insert-empty', socket, 0).ok).toBe(true);
    const second = store.addItem('insert-with-m3', socket, 0);
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/socket is already taken/);
    expect(second.blockedCells?.map(hexKey)).toEqual(['5,4']);
  });

  /** Accessories were never the problem: they mount ON the wall, not in it. */
  it('lets an accessory hang over any of it, as before', () => {
    const store = wall();
    expect(store.addItem('hook-side', socket, 0).ok).toBe(true);
    expect(store.addItem('shelf-1', screw, 0).ok).toBe(true);
  });

  /**
   * The bug this found. `occupancyIndex` keeps ONE item id per cell, so an
   * accessory placed over an insert replaced it there and the cell read as
   * empty to the one-insert-per-hole check.
   */
  it('is not fooled by an accessory hung over a filled hole', () => {
    const store = wall();
    expect(store.addItem('hook-side', screw, 0).ok).toBe(true);
    const result = store.addItem('insert-empty', screw, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/one insert per hole/);
  });

  it('is not fooled by an accessory hung over a filled socket either', () => {
    const store = wall();
    expect(store.addItem('insert-empty', socket, 0).ok).toBe(true);
    expect(store.addItem('hook-side', socket, 0).ok).toBe(true);
    expect(store.addItem('insert-with-m3', socket, 0).ok).toBe(false);
  });

  /**
   * Moving the thing out of the socket frees it again — the index is rebuilt
   * from the document, not accumulated.
   */
  it('frees the socket when what was in it moves away', () => {
    const store = wall();
    store.addItem('insert-empty', socket, 0);
    const plug = store.getState().doc.items.at(-1)!;
    expect(store.moveItems([plug.id], { q: 6, r: 6 }).ok).toBe(true);
    expect(store.addItem('insert-with-m3', socket, 0).ok).toBe(true);
  });
});

/**
 * The store and the validator have to agree, or the app accepts a drop and the
 * parts list then calls it an error. This is the same class of split that
 * `partCells` and `itemCells` were unified to prevent, and it appeared within a
 * minute of the store learning the socket rule.
 */
describe('the parts list agrees with the drop', () => {
  it('does not report an insert installed in a socket as a clash', () => {
    const store = new Store(emptyDoc(), catalog);
    store.addItem(JUNCTION, at, 0);
    expect(store.addItem('insert-empty', { q: 5, r: 4 }, 0).ok).toBe(true);
    expect(store.issues().filter((i) => i.code === 'overlap')).toEqual([]);
  });

  /** ...while a genuine double-fill is still an error, wherever it came from. */
  it('still reports two inserts in one plain cell', () => {
    const store = new Store(emptyDoc(), catalog);
    store.addItem('insert-empty', { q: 1, r: 1 }, 0);
    // Around the store's refusal, as a hand-edited document could be.
    const doc = store.getState().doc;
    const forced = {
      ...doc,
      items: [...doc.items, { id: 'forced', partId: 'insert-with-m3', at: { q: 1, r: 1 }, rotation: 0 as const }],
    };
    const hacked = new Store(forced, catalog);
    expect(hacked.issues().some((i) => i.code === 'overlap')).toBe(true);
  });
});

describe('what a socket does NOT do', () => {
  /**
   * Cells are how much wall a part covers; pegs are what holds a part up. A
   * socket says "something can go here", not "something is ordered" — deriving a
   * fastener count from cells is the seven-inserts-for-two-pegs bug, and it
   * stays out of this.
   */
  it('changes nothing in the parts list on its own', () => {
    const store = new Store(emptyDoc(), catalog);
    store.addItem(JUNCTION, at, 0);
    const bom = store.bom();
    const lines = [...bom.printed, ...bom.fasteners];
    expect(lines.find((l) => l.partId === JUNCTION)?.quantity).toBe(1);
    // Three sockets do not become three inserts on the list.
    expect(lines.find((l) => l.partId === 'insert-empty')).toBeUndefined();
  });

  /** ...and installing into one orders exactly what was installed. */
  it('orders only what is actually placed in it', () => {
    const store = new Store(emptyDoc(), catalog);
    store.addItem(JUNCTION, at, 0);
    store.addItem('insert-empty', { q: 5, r: 4 }, 0);
    const bom = store.bom();
    const lines = [...bom.printed, ...bom.fasteners];
    expect(lines.find((l) => l.partId === 'insert-empty')?.quantity).toBe(1);
  });
});
