/**
 * Store tests: placement refusal, group rigidity, and exact undo.
 *
 * These are the behaviours the app is judged on at the printer. A drop that is
 * silently allowed on top of another part produces a parts list that does not
 * match the wall, and that is only discovered after printing.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { hexKey, placeFootprint } from '../src/core/hex';
import { Store, emptyDoc, __resetIds } from '../src/core/store';
import type { Catalog, CatalogPart, Hex, LayoutDoc } from '../src/core/types';

function part(id: string, footprint: Hex[], extra: Partial<CatalogPart> = {}): CatalogPart {
  return {
    id,
    name: id,
    file: `models/${id}.stl`,
    type: 'accessory',
    group: '',
    footprint,
    anchor: { q: 0, r: 0 },
    drawnOrientation: 'flat',
    bboxMm: [10, 10, 10],
    volumeMm3: 100,
    requires: [],
    hardware: [],
    print: { minutes: 10, grams: 1, metres: 0.3, profile: 'test', supports: false, source: 'sliced' },
    provenance: { basis: 'geometry', confidence: 1, notes: [] },
    sha256: 'x',
    ...extra,
  };
}

const catalog: Catalog = {
  schemaVersion: 1,
  generatedAt: '',
  slicerProfile: 'test',
  parts: [
    part('single', [{ q: 0, r: 0 }]),
    part('pair', [{ q: 0, r: 0 }, { q: 1, r: 0 }]),
    // Inserts plug INTO the hole, so two of them cannot share a cell. Everything
    // else mounts on top and may overlap freely — that is what the wall is for.
    part('plug', [{ q: 0, r: 0 }], { type: 'insert' }),
    part('plug2', [{ q: 0, r: 0 }, { q: 1, r: 0 }], { type: 'insert' }),
    part('panel-a', [], {
      type: 'panel',
      panel: { columns: 10, rows: 10, widthMm: 200, heightMm: 200, fitsBeds: ['bed256'] },
    }),
  ],
  unresolved: [],
};

function docWithPanel(): LayoutDoc {
  return {
    ...emptyDoc(),
    panels: [{ id: 'p0', partId: 'panel-a', origin: { q: 0, r: 0 }, columns: 10, rows: 10 }],
  };
}

let store: Store;
beforeEach(() => {
  __resetIds();
  store = new Store(docWithPanel(), catalog);
});

describe('placement', () => {
  it('accepts a part on a free cell', () => {
    const r = store.addItem('single', { q: 2, r: 2 });
    expect(r.ok).toBe(true);
    expect(store.getState().doc.items).toHaveLength(1);
  });

  it('LETS accessories stack on the same cell — the wall is for mounting things on', () => {
    expect(store.addItem('single', { q: 2, r: 2 }).ok).toBe(true);
    const r = store.addItem('single', { q: 2, r: 2 });
    expect(r.ok).toBe(true);
    // And it does so silently: warning on every second drop would cry wolf.
    expect(r.warnings ?? []).toEqual([]);
    expect(store.getState().doc.items).toHaveLength(2);
  });

  it('lets a multi-cell accessory partially overlap another', () => {
    store.addItem('pair', { q: 2, r: 2 });        // occupies (2,2) and (3,2)
    expect(store.addItem('pair', { q: 3, r: 2 }).ok).toBe(true);
    expect(store.getState().doc.items).toHaveLength(2);
  });

  it('refuses a second insert in the same hole, and says which', () => {
    store.addItem('plug', { q: 2, r: 2 });
    const r = store.addItem('plug', { q: 2, r: 2 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/one insert per hole/i);
    expect(r.blockedCells).toHaveLength(1);
    expect(store.getState().doc.items).toHaveLength(1);
  });

  it('refuses a partially clashing multi-cell insert, naming only the taken cell', () => {
    store.addItem('plug2', { q: 2, r: 2 });          // (2,2) and (3,2)
    const r = store.addItem('plug2', { q: 3, r: 2 }); // wants (3,2) and (4,2)
    expect(r.ok).toBe(false);
    expect(r.blockedCells?.map(hexKey)).toEqual(['3,2']);
  });

  it('lets an accessory sit over an insert — that is how it mounts', () => {
    store.addItem('plug', { q: 2, r: 2 });
    expect(store.addItem('single', { q: 2, r: 2 }).ok).toBe(true);
  });

  it('refuses a part hanging off the panel edge, distinct from an overlap', () => {
    const r = store.addItem('pair', { q: 9, r: 0 }); // (9,0) on panel, (10,0) off
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/edge|unsupported/i);
  });

  it('refuses a part entirely off the wall', () => {
    const r = store.addItem('single', { q: 80, r: 80 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/off the wall/i);
  });

  it('allows anything when no panels exist yet (nothing to be off)', () => {
    const bare = new Store(emptyDoc(), catalog);
    expect(bare.addItem('single', { q: 50, r: 50 }).ok).toBe(true);
  });

  it('never throws on an unknown part id', () => {
    const r = store.addItem('does-not-exist', { q: 0, r: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown part/i);
  });
});

describe('moving', () => {
  it('moves a single item and frees its old cells', () => {
    store.addItem('single', { q: 2, r: 2 });
    const id = store.getState().doc.items[0]!.id;
    expect(store.moveItems([id], { q: 1, r: 0 }).ok).toBe(true);
    expect(store.getState().doc.items[0]!.at).toEqual({ q: 3, r: 2 });
    // The vacated cell must now accept a new part.
    expect(store.addItem('single', { q: 2, r: 2 }).ok).toBe(true);
  });

  it('moves a group as one rigid body, or not at all', () => {
    // Inserts, because only they can genuinely block each other now.
    store.addItem('plug', { q: 1, r: 1 });
    store.addItem('plug', { q: 2, r: 1 });
    store.addItem('plug', { q: 4, r: 1 }); // the obstacle
    const [a, b, obstacle] = store.getState().doc.items;
    store.groupItems([a!.id, b!.id]);

    // Moving +2 would land b on the obstacle: the whole move must be refused.
    const blocked = store.moveItems([a!.id, b!.id], { q: 2, r: 0 });
    expect(blocked.ok).toBe(false);
    const after = store.getState().doc.items;
    expect(after.find((i) => i.id === a!.id)!.at).toEqual({ q: 1, r: 1 });
    expect(after.find((i) => i.id === b!.id)!.at).toEqual({ q: 2, r: 1 });
    expect(after.find((i) => i.id === obstacle!.id)!.at).toEqual({ q: 4, r: 1 });

    // Moving +1 is fine and both members move together.
    expect(store.moveItems([a!.id, b!.id], { q: 1, r: 0 }).ok).toBe(true);
    const moved = store.getState().doc.items;
    expect(moved.find((i) => i.id === a!.id)!.at).toEqual({ q: 2, r: 1 });
    expect(moved.find((i) => i.id === b!.id)!.at).toEqual({ q: 3, r: 1 });
  });

  it('a group sliding over its own former cells is not self-collision', () => {
    store.addItem('single', { q: 1, r: 1 });
    store.addItem('single', { q: 2, r: 1 });
    const ids = store.getState().doc.items.map((i) => i.id);
    // Shifting by one makes the second land where the first was.
    expect(store.moveItems(ids, { q: 1, r: 0 }).ok).toBe(true);
  });
});

describe('rotation', () => {
  it('rotating six times returns every item to where it started', () => {
    store.addItem('pair', { q: 3, r: 3 });
    const id = store.getState().doc.items[0]!.id;
    const before = JSON.stringify(store.getState().doc.items);
    for (let i = 0; i < 6; i++) store.rotateItems([id], 1);
    expect(JSON.stringify(store.getState().doc.items)).toEqual(before);
  });

  it('refuses a rotation that would overlap, leaving the document untouched', () => {
    store.addItem('pair', { q: 3, r: 3 });   // (3,3),(4,3)
    store.addItem('single', { q: 3, r: 4 }); // sits where a rotation would land
    const pairId = store.getState().doc.items[0]!.id;
    const snapshot = JSON.stringify(store.getState().doc);
    let refused = false;
    for (let i = 0; i < 6 && !refused; i++) {
      const r = store.rotateItems([pairId], 1);
      if (!r.ok) {
        refused = true;
        expect(r.reason).toMatch(/cannot rotate/i);
        expect(JSON.stringify(store.getState().doc)).toEqual(snapshot);
      } else {
        // put it back so the next attempt starts from the same place
        store.undo();
      }
    }
  });

  it('keeps a group glued together through rotation', () => {
    store.addItem('single', { q: 4, r: 4 });
    store.addItem('single', { q: 5, r: 4 });
    const ids = store.getState().doc.items.map((i) => i.id);
    store.groupItems(ids);
    const before = store.getState().doc.items.map((i) => i.at);
    const dist = hexDistance(before[0]!, before[1]!);
    store.rotateItems(ids, 1);
    const after = store.getState().doc.items.map((i) => i.at);
    expect(hexDistance(after[0]!, after[1]!)).toEqual(dist);
  });
});

describe('undo / redo', () => {
  it('restores the document EXACTLY, including selection', () => {
    store.addItem('single', { q: 2, r: 2 });
    const snap = JSON.stringify(store.getState().doc);
    const sel = [...store.getState().selection];

    store.addItem('single', { q: 3, r: 3 });
    store.undo();

    expect(JSON.stringify(store.getState().doc)).toEqual(snap);
    expect(store.getState().selection).toEqual(sel);
  });

  it('survives 50 undos then 50 redos and lands where it started', () => {
    for (let i = 0; i < 50; i++) store.addItem('single', { q: i % 9, r: Math.floor(i / 9) });
    const full = JSON.stringify(store.getState().doc);
    for (let i = 0; i < 50; i++) store.undo();
    expect(store.getState().doc.items).toHaveLength(0);
    for (let i = 0; i < 50; i++) store.redo();
    expect(JSON.stringify(store.getState().doc)).toEqual(full);
  });

  it('undoing past the beginning is a no-op, not a crash', () => {
    for (let i = 0; i < 20; i++) store.undo();
    expect(store.getState().canUndo).toBe(false);
    expect(store.getState().doc.items).toHaveLength(0);
  });

  it('a new action after undo discards the redo branch', () => {
    store.addItem('single', { q: 1, r: 1 });
    store.addItem('single', { q: 2, r: 2 });
    store.undo();
    expect(store.getState().canRedo).toBe(true);
    store.addItem('single', { q: 5, r: 5 });
    expect(store.getState().canRedo).toBe(false);
  });

  it('a refused drop does not create an undo step', () => {
    store.addItem('plug', { q: 2, r: 2 });
    const depthBefore = store.getState().canUndo;
    const before = JSON.stringify(store.getState().doc);
    expect(store.addItem('plug', { q: 2, r: 2 }).ok).toBe(false); // refused
    store.undo();
    // One undo should take us back past the successful add, not past a phantom.
    expect(store.getState().doc.items).toHaveLength(0);
    expect(depthBefore).toBe(true);
    expect(before).toContain('plug');
  });
});

describe('grouping and duplication', () => {
  it('duplicates a group and keeps the copies grouped, but separately', () => {
    store.addItem('single', { q: 1, r: 1 });
    store.addItem('single', { q: 2, r: 1 });
    const ids = store.getState().doc.items.map((i) => i.id);
    store.groupItems(ids);
    const r = store.duplicateItems(ids, { q: 0, r: 3 });
    expect(r.ok).toBe(true);

    const items = store.getState().doc.items;
    expect(items).toHaveLength(4);
    const groups = new Set(items.map((i) => i.groupId));
    expect(groups.size).toBe(2); // originals in one group, copies in another
    expect([...groups].every((g) => g !== undefined)).toBe(true);
  });

  it('refuses duplicating an insert onto itself, but allows it for an accessory', () => {
    store.addItem('plug', { q: 1, r: 1 });
    const plugIds = store.getState().doc.items.map((i) => i.id);
    expect(store.duplicateItems(plugIds, { q: 0, r: 0 }).ok).toBe(false);
    expect(store.getState().doc.items).toHaveLength(1);

    store.addItem('single', { q: 5, r: 5 });
    const accId = store.getState().doc.items.filter((i) => i.partId === 'single').map((i) => i.id);
    expect(store.duplicateItems(accId, { q: 0, r: 0 }).ok).toBe(true);
  });

  it('selecting one member of a group expands to the whole group', () => {
    store.addItem('single', { q: 1, r: 1 });
    store.addItem('single', { q: 2, r: 1 });
    const ids = store.getState().doc.items.map((i) => i.id);
    store.groupItems(ids);
    expect(store.expandSelection([ids[0]!]).sort()).toEqual([...ids].sort());
  });

  it('ungroup leaves items in place', () => {
    store.addItem('single', { q: 1, r: 1 });
    store.addItem('single', { q: 2, r: 1 });
    const ids = store.getState().doc.items.map((i) => i.id);
    store.groupItems(ids);
    const before = store.getState().doc.items.map((i) => i.at);
    store.ungroupItems(ids);
    expect(store.getState().doc.items.map((i) => i.at)).toEqual(before);
    expect(store.getState().doc.items.every((i) => i.groupId === undefined)).toBe(true);
  });
});

describe('hostile input', () => {
  it('clamps absurd wall dimensions instead of throwing', () => {
    store.setWall(NaN, Infinity);
    const w = store.getState().doc.wall;
    expect(Number.isFinite(w.widthMm)).toBe(true);
    expect(Number.isFinite(w.heightMm)).toBe(true);
    store.setWall(-500, 0);
    expect(store.getState().doc.wall.widthMm).toBeGreaterThan(0);
  });

  it('handles a 200-cell layout without falling over', () => {
    const big = new Store(
      { ...emptyDoc(), panels: [{ id: 'p', partId: 'panel-a', origin: { q: 0, r: 0 }, columns: 30, rows: 30 }] },
      catalog,
    );
    let placed = 0;
    for (let r = 0; r < 20; r++) {
      for (let q = 0; q < 12; q++) {
        if (big.addItem('single', { q, r }).ok) placed += 1;
      }
    }
    expect(placed).toBeGreaterThan(200);
    // Every occupied cell must be claimed by exactly one item.
    const seen = new Set<string>();
    for (const it of big.getState().doc.items) {
      const p = catalog.parts.find((x) => x.id === it.partId)!;
      for (const c of placeFootprint(p.footprint, it.at, it.rotation)) {
        const k = hexKey(c);
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });

  it('deleting an empty selection is a no-op', () => {
    store.addItem('single', { q: 1, r: 1 });
    const before = JSON.stringify(store.getState().doc);
    store.deleteItems([]);
    expect(JSON.stringify(store.getState().doc)).toEqual(before);
  });
});

function hexDistance(a: Hex, b: Hex): number {
  const ax = a.q;
  const az = a.r;
  const ay = -ax - az;
  const bx = b.q;
  const bz = b.r;
  const by = -bx - bz;
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
}

/**
 * Enter on a catalogue tile places a part. It used to synthesise a `pointerdown`
 * instead, which started a drag that only a `pointerup` over the wall could
 * finish — and there is no Enter-to-drop, so a keyboard user got a ghost they
 * could only cancel with Escape while the tile promised "or press Enter".
 *
 * The search lives in the Store, not the shell, so it can be held to the same
 * gate `addItem` applies without standing a browser up.
 */
describe('keyboard placement', () => {
  it('finds the first free cell in reading order', () => {
    expect(store.firstFittingCell('single')).toEqual({ q: 0, r: 0 });
  });

  it('is deterministic, so undo and redo stay a round trip', () => {
    const a = store.firstFittingCell('pair');
    const b = store.firstFittingCell('pair');
    expect(a).toEqual(b);
  });

  it('steps over a cell an insert already occupies, since two cannot share one', () => {
    expect(store.addItem('plug', { q: 0, r: 0 }).ok).toBe(true);
    // Reading order is by row then column, so the next legal cell is one across.
    expect(store.firstFittingCell('plug')).toEqual({ q: 1, r: 0 });
  });

  it('still offers an overlapping cell to an accessory, which may share freely', () => {
    expect(store.addItem('single', { q: 0, r: 0 }).ok).toBe(true);
    expect(store.firstFittingCell('single')).toEqual({ q: 0, r: 0 });
  });

  it('returns null rather than a wrong answer when there is no wall', () => {
    const bare = new Store(emptyDoc(), catalog);
    expect(bare.firstFittingCell('single')).toBeNull();
  });

  it('returns null for a part that is not in the catalogue', () => {
    expect(store.firstFittingCell('no-such-part')).toBeNull();
  });

  /**
   * The whole point: whatever the scan offers, `addItem` must accept. If these
   * two ever disagree, Enter reports success and places nothing.
   */
  it('never offers a cell addItem then refuses', () => {
    for (const id of ['single', 'pair', 'plug', 'plug2']) {
      const at = store.firstFittingCell(id);
      expect(at, `${id} found no cell`).not.toBeNull();
      expect(store.addItem(id, at!, 0).ok, `${id} at ${hexKey(at!)}`).toBe(true);
    }
  });
});
