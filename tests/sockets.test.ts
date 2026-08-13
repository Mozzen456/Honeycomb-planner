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
import { fixingPlanFor, isEmptyInsert, itemSocketCells } from '../src/core/bom';
import { hexKey } from '../src/core/hex';
import { applyOverrides, socketsOf } from '../src/core/overrides';
import { solveTiling } from '../src/core/tiling';
import { Store, emptyDoc } from '../src/core/store';
import type { Catalog, LayoutDoc } from '../src/core/types';

const catalog = applyOverrides(catalogJson as unknown as Catalog, overridesJson);
const JUNCTION = 'insert-for-countersunk-hole-3';
const at = { q: 4, r: 4 };

const junction = catalog.parts.find((p) => p.id === JUNCTION)!;

describe('the shipped junction fastener', () => {
  /**
   * Measured, not chosen: three 13.2 mm across-flats holes and one 3.2 mm bore
   * for the wall screw, each landing dead centre of a different cell.
   *
   * Measured on the mesh AS THE WALL DRAWS IT — through the mating flip, placed
   * at the mean of its cells. Measuring the raw file instead swaps the middle
   * two, because a `high` mating end mirrors the mesh and `toAxial` does not
   * mirror the footprint with it (PARKED P10). That shipped once: the app then
   * offered the countersunk hole as a socket and refused the real one, which is
   * the exact opposite of the part.
   */
  it('carries three sockets and one screw cell', () => {
    expect(junction.footprint).toHaveLength(4);
    expect(socketsOf(junction).map(hexKey).sort()).toEqual(['0,0', '1,-1', '2,-1'].sort());
    // The wall screw's cell is deliberately NOT a socket: a part over it is in
    // the way of the screwdriver.
    expect(socketsOf(junction).map(hexKey)).not.toContain('1,0');
  });

  /** The same three cells on its M3 sibling, from the same measurement. */
  it('says the same about insert-countersunk-with-m3x3', () => {
    const m3 = catalog.parts.find((p) => p.id === 'insert-countersunk-with-m3x3')!;
    expect(socketsOf(m3).map(hexKey).sort()).toEqual(['0,0', '1,-1', '2,-1'].sort());
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
    expect(sockets.sort()).toEqual(['4,4', '5,3', '6,3'].sort());
  });
});

describe('installing into a socket', () => {
  const socket = { q: 5, r: 3 };   // (1,-1) of the junction placed at (4,4)
  const screw = { q: 5, r: 4 };    // (1,0) — the wall screw, not a socket

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
    expect(second.blockedCells?.map(hexKey)).toEqual(['5,3']);
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
    expect(store.addItem('insert-empty', { q: 5, r: 3 }, 0).ok).toBe(true);
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

/**
 * A socket in the wall IS an insert.
 *
 * The combined wall fastener is one screw hole and three open sockets, and each
 * of those is the same 13.2 mm socket `insert-empty` provides. So a part hung on
 * one of them must not ALSO have an `insert-empty` printed for it — that is a
 * part you print and then find already in the wall.
 */
describe('an accessory hung on a socket', () => {
  const socket = { q: 5, r: 3 };   // (1,-1) of the junction placed at (4,4)

  /** A one-cell part that wants exactly one plain insert. */
  const hook = catalog.parts.find(
    (p) => p.type === 'accessory'
      && p.footprint.length === 1
      && p.requires?.some((r) => r.partId === 'insert-empty'),
  );

  it('is a case the shipped catalogue actually has', () => {
    expect(hook, 'a one-cell accessory requiring insert-empty').toBeDefined();
  });

  it('uses the one that is there instead of ordering another', () => {
    const store = new Store(emptyDoc(), catalog);
    store.addItem(JUNCTION, at, 0);
    const alone = store.bom().fasteners.find((l) => l.partId === 'insert-empty')?.quantity ?? 0;

    store.addItem(hook!.id, socket, 0);
    const after = store.bom().fasteners.find((l) => l.partId === 'insert-empty');
    const wanted = hook!.requires.find((r) => r.partId === 'insert-empty')!.count;

    // The hook's own requirement did not arrive: the wall already had it.
    expect(after?.quantity ?? 0).toBe(Math.max(0, alone + wanted - 1));
    if ((after?.quantity ?? 0) > 0) expect(after!.providedBySockets).toBe(1);
  });

  /** Away from the socket, the same hook orders its insert as it always did. */
  it('orders its own when it is not on a socket', () => {
    const store = new Store(emptyDoc(), catalog);
    store.addItem(JUNCTION, at, 0);
    const alone = store.bom().fasteners.find((l) => l.partId === 'insert-empty')?.quantity ?? 0;

    store.addItem(hook!.id, { q: 20, r: 20 }, 0);
    const after = store.bom().fasteners.find((l) => l.partId === 'insert-empty');
    const wanted = hook!.requires.find((r) => r.partId === 'insert-empty')!.count;
    expect(after?.quantity ?? 0).toBe(alone + wanted);
    expect(after?.providedBySockets ?? 0).toBe(0);
  });

  /** One socket, one claim: two parts over it cannot both save an insert. */
  it('is claimed by one part only', () => {
    const store = new Store(emptyDoc(), catalog);
    store.addItem(JUNCTION, at, 0);
    const alone = store.bom().fasteners.find((l) => l.partId === 'insert-empty')?.quantity ?? 0;
    store.addItem(hook!.id, socket, 0);
    store.addItem(hook!.id, socket, 0);
    const after = store.bom().fasteners.find((l) => l.partId === 'insert-empty');
    const wanted = hook!.requires.find((r) => r.partId === 'insert-empty')!.count;
    // Two hooks want two; one socket answers one of them.
    expect(after?.quantity ?? 0).toBe(alone + wanted * 2 - 1);
  });

  /**
   * An empty insert of ANY kind answers a part that wants an empty insert.
   *
   * They are all the same thing — a hexagonal socket for a peg — so a part set
   * to `insert-hollow-dual` in the inspector is as well served by the junction's
   * own socket as one set to `insert-empty`. Anything else would make the
   * saving depend on which of several identical sockets somebody happened to
   * pick from the picker.
   */
  it('answers a part that wants any other empty insert', () => {
    const store = new Store(emptyDoc(), catalog);
    store.addItem(JUNCTION, at, 0);
    const alone = store.bom().fasteners
      .find((l) => l.partId === 'insert-hollow-dual')?.quantity ?? 0;

    // The same hook, told to hang on a different plain socket.
    const swapped = applyOverrides(catalogJson as unknown as Catalog, {
      parts: {
        ...(overridesJson as { parts: Record<string, unknown> }).parts,
        [hook!.id]: { requires: [{ partId: 'insert-hollow-dual', count: 1 }] },
      },
    });
    const other = new Store(emptyDoc(), swapped);
    other.addItem(JUNCTION, at, 0);
    other.addItem(hook!.id, socket, 0);
    const line = other.bom().fasteners.find((l) => l.partId === 'insert-hollow-dual');
    expect(line?.quantity ?? 0).toBe(alone);   // nothing extra to print
  });

  /** A bolted insert is not interchangeable: a plain socket has no thread. */
  it('does not answer a part that wants a bolted insert', () => {
    const bolted = applyOverrides(catalogJson as unknown as Catalog, {
      parts: {
        ...(overridesJson as { parts: Record<string, unknown> }).parts,
        [hook!.id]: { requires: [{ partId: 'insert-m4', count: 1 }] },
      },
    });
    const store = new Store(emptyDoc(), bolted);
    store.addItem(JUNCTION, at, 0);
    store.addItem(hook!.id, socket, 0);
    expect(store.bom().fasteners.find((l) => l.partId === 'insert-m4')?.quantity).toBe(1);
  });

  /**
   * Stated, never inferred. A part with sockets but no `socketProvides` offers
   * somewhere to install something and orders nothing away — two sockets being
   * the same size is not proof they do the same job.
   */
  it('deducts nothing where the equivalence has not been stated', () => {
    const quiet = applyOverrides(catalogJson as unknown as Catalog, {
      parts: {
        [JUNCTION]: { socketCells: [{ q: 0, r: 0 }, { q: 1, r: -1 }, { q: 2, r: -1 }] },
      },
    });
    const store = new Store(emptyDoc(), quiet);
    store.addItem(JUNCTION, at, 0);
    const alone = store.bom().fasteners.find((l) => l.partId === 'insert-empty')?.quantity ?? 0;
    store.addItem(hook!.id, socket, 0);
    const after = store.bom().fasteners.find((l) => l.partId === 'insert-empty');
    const wanted = hook!.requires.find((r) => r.partId === 'insert-empty')!.count;
    expect(after?.quantity ?? 0).toBe(alone + wanted);
  });
});

/**
 * Hanging a part on a junction's open hole must not DELETE the junction.
 *
 * The fixing planner refuses any cell an accessory covers — right for the
 * spacing grid, where a wall screw needs a hole and a screwdriver needs to
 * reach it, and wrong for the four-cell fastener whose three open cells are
 * sockets. It checks all four cells, so one hook on one socket dropped the
 * whole placement and the wall mount vanished from the plan, the parts list and
 * the picture.
 */
describe('a part pegged into a junction fixing', () => {
  /** A wall big enough that the tiler makes junctions at all. */
  const wall = (): LayoutDoc => {
    const doc = emptyDoc();
    const sizes = catalog.parts
      .filter((p) => p.type === 'panel' && p.panel)
      .map((p) => ({
        partId: p.id,
        columns: p.panel!.columns,
        rows: p.panel!.rows,
        widthMm: p.panel!.widthMm,
        heightMm: p.panel!.heightMm,
      }));
    const wallMm = { widthMm: 900, heightMm: 700 };
    return {
      ...doc,
      wall: wallMm,
      // Ids as the app assigns them: `planFixings` groups cells BY PANEL ID, so
      // panels without one all read as the same plate and no junction is ever
      // found — which is a broken fixture, not a broken planner.
      panels: solveTiling({ wall: wallMm, bedId: 'bed256', available: sizes })
        .panels.map((panel, i) => ({ ...panel, id: `p${i}` })),
    };
  };

  const plainSocketPart = catalog.parts.find(
    (p) => p.type === 'accessory' && p.footprint.length === 1
      && p.requires?.some((r) => r.partId === 'insert-empty'),
  )!;

  it('leaves the junction where it was', () => {
    const store = new Store(wall(), catalog);
    const before = fixingPlanFor(store.getState().doc, catalog);
    expect(before.junctions.length, 'the fixture needs a junction').toBeGreaterThan(0);

    // Onto one of that junction's sockets — never its wall-screw cell.
    const junction = before.junctions[0]!;
    const sockets = itemSocketCells(
      { id: 'j', partId: JUNCTION, at: junction.anchor, rotation: junction.rotation },
      catalog,
    );
    expect(sockets.length).toBe(3);
    expect(store.addItem(plainSocketPart.id, sockets[0]!, 0).ok).toBe(true);

    const after = fixingPlanFor(store.getState().doc, catalog);
    expect(after.junctions.length).toBe(before.junctions.length);
    expect(after.junctions[0]!.anchor).toEqual(junction.anchor);
  });

  /** The screw cell is different: a screwdriver has to reach it. */
  it('gives the junction up when something covers its screw cell', () => {
    const store = new Store(wall(), catalog);
    const before = fixingPlanFor(store.getState().doc, catalog);
    const junction = before.junctions[0]!;
    const sockets = new Set(
      itemSocketCells(
        { id: 'j', partId: JUNCTION, at: junction.anchor, rotation: junction.rotation },
        catalog,
      ).map(hexKey),
    );
    const screwCell = junction.cells.find((c) => !sockets.has(hexKey(c)))!;
    store.addItem(plainSocketPart.id, screwCell, 0);

    const after = fixingPlanFor(store.getState().doc, catalog);
    const stillThere = after.junctions.some(
      (j) => j.anchor.q === junction.anchor.q && j.anchor.r === junction.anchor.r
        && j.rotation === junction.rotation,
    );
    expect(stillThere).toBe(false);
  });

  /**
   * ...and so is a part that mounts on something other than a plain socket. The
   * hole is offered to what pegs into it, not to whatever happens to be on top.
   */
  it('gives it up for a part that does not mount through an empty insert', () => {
    const bolted = catalog.parts.find(
      (p) => p.type === 'accessory'
        && p.requires?.length === 1
        && p.requires.every((r) => !isEmptyInsert(catalog.parts.find((x) => x.id === r.partId))),
    );
    if (bolted === undefined) return;   // nothing in the catalogue to check with

    const store = new Store(wall(), catalog);
    const before = fixingPlanFor(store.getState().doc, catalog);
    const junction = before.junctions[0]!;
    const sockets = itemSocketCells(
      { id: 'j', partId: JUNCTION, at: junction.anchor, rotation: junction.rotation },
      catalog,
    );
    store.addItem(bolted.id, sockets[0]!, 0);

    const after = fixingPlanFor(store.getState().doc, catalog);
    const stillThere = after.junctions.some(
      (j) => j.anchor.q === junction.anchor.q && j.anchor.r === junction.anchor.r
        && j.rotation === junction.rotation,
    );
    expect(stillThere).toBe(false);
  });

  /** "An empty insert of any kind" is derived, not a list of ids. */
  it('counts every socket-only insert as empty, and nothing else', () => {
    const byId = (id: string) => catalog.parts.find((p) => p.id === id);
    for (const id of ['insert-empty', 'insert-hollow-dual', 'insert-hollow-tre', 'insert-hollow-for']) {
      expect(isEmptyInsert(byId(id)), id).toBe(true);
    }
    for (const id of ['insert-with-m3', 'insert-m4', 'insert-m5', 'insert-countersunk', JUNCTION]) {
      expect(isEmptyInsert(byId(id)), id).toBe(false);
    }
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
    store.addItem('insert-empty', { q: 5, r: 3 }, 0);
    const bom = store.bom();
    const lines = [...bom.printed, ...bom.fasteners];
    expect(lines.find((l) => l.partId === 'insert-empty')?.quantity).toBe(1);
  });
});
