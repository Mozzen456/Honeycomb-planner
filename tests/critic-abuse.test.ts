/**
 * CRITIC / BAD-USER PASS.
 *
 * Written by an independent reviewer who did not write the app. The bar is:
 *   1. nothing throws, for any input, ever;
 *   2. nothing silently discards the user's layout.
 * A loud refusal is a pass. A quiet loss is a failure.
 *
 * Timings are printed to stdout so the report can quote real milliseconds.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { computeBom, itemCells, validate } from '../src/core/bom';
import { hexKey, panelCells, placeFootprint } from '../src/core/hex';
import {
  CURRENT_SCHEMA,
  decodeShareUrl,
  deserialize,
  encodeShareUrl,
  migrate,
  serialize,
} from '../src/core/persist';
import { Store, __resetIds, emptyDoc } from '../src/core/store';
import { solveTiling } from '../src/core/tiling';
import type { Catalog, CatalogPart, Hex, LayoutDoc, PlacedItem, Rotation } from '../src/core/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    part('pair', [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
    ]),
    part('panel-a', [], {
      type: 'panel',
      panel: { columns: 10, rows: 10, widthMm: 200, heightMm: 200, fitsBeds: ['bed256'] },
    }),
    // A catalogue that names a non-zero anchor. bom.itemCells honours it; the
    // store's placement check does not — see the "anchor" test below.
    part(
      'anchored',
      [
        { q: 0, r: 0 },
        { q: 1, r: 0 },
      ],
      { anchor: { q: 1, r: 0 } },
    ),
  ],
  unresolved: [],
};

function docWith(cols: number, rows: number): LayoutDoc {
  return {
    ...emptyDoc(),
    panels: [{ id: 'p0', partId: 'panel-a', origin: { q: 0, r: 0 }, columns: cols, rows }],
  };
}

const ms = (t: number): string => `${t.toFixed(1)} ms`;
const now = (): number => performance.now();

function timed<T>(label: string, fn: () => T): { value: T; t: number } {
  const t0 = now();
  const value = fn();
  const t = now() - t0;
  // eslint-disable-next-line no-console
  console.log(`[timing] ${label}: ${ms(t)}`);
  return { value, t };
}

const snap = (s: Store): string =>
  JSON.stringify({ doc: s.getState().doc, selection: s.getState().selection });

let store: Store;
beforeEach(() => {
  __resetIds();
  store = new Store(docWith(10, 10), catalog);
});

// ---------------------------------------------------------------------------
// 1. SCALE
// ---------------------------------------------------------------------------

describe('scale', () => {
  it('200 items: placement, validation, BOM, save and load', () => {
    const s = new Store(docWith(40, 40), catalog);
    const place = timed('place 200 items', () => {
      let placed = 0;
      for (let i = 0; i < 200; i++) {
        const row = Math.floor(i / 20);
        const r = s.addItem('single', { q: (i % 20) - Math.floor(row / 2), r: row });
        if (r.ok) placed++;
      }
      return placed;
    });
    expect(place.value).toBe(200);

    const v = timed('validate 200', () => validate(s.getState().doc, catalog));
    expect(v.value).toEqual([]);
    const b = timed('bom 200', () => computeBom(s.getState().doc, catalog));
    expect(b.value.totals.parts).toBe(201); // 200 items + the panel they sit on

    const text = timed('serialize 200', () => serialize(s.getState().doc));
    const back = timed('deserialize 200', () => deserialize(text.value));
    expect(back.value.errors).toEqual([]);
    expect(back.value.doc?.items).toHaveLength(200);

    const url = timed('encodeShareUrl 200', () => encodeShareUrl(s.getState().doc, 'https://x/#'));
    const dec = timed('decodeShareUrl 200', () => decodeShareUrl(url.value));
    expect(dec.value.doc?.items).toHaveLength(200);
  }, 60_000);

  it('2000 items: reports how the cost scales against 200', () => {
    const s = new Store(docWith(50, 40), catalog);
    const cell = (i: number): Hex => {
      const row = Math.floor(i / 50);
      return { q: (i % 50) - Math.floor(row / 2), r: row };
    };
    const t200 = timed('place first 200 of 2000', () => {
      for (let i = 0; i < 200; i++) s.addItem('single', cell(i));
    }).t;
    const tRest = timed('place remaining 1800', () => {
      for (let i = 200; i < 2000; i++) s.addItem('single', cell(i));
    }).t;
    const doc = s.getState().doc;
    expect(doc.items).toHaveLength(2000);
    // eslint-disable-next-line no-console
    console.log(
      `[timing] per-item cost: first 200 = ${(t200 / 200).toFixed(3)} ms/item, ` +
        `items 201..2000 = ${(tRest / 1800).toFixed(3)} ms/item ` +
        `(ratio ${(tRest / 1800 / (t200 / 200)).toFixed(1)}x — 10x would be pure O(n^2))`,
    );

    timed('validate 2000', () => expect(validate(doc, catalog)).toEqual([]));
    timed('bom 2000', () => expect(computeBom(doc, catalog).totals.parts).toBe(2001));
    const text = timed('serialize 2000', () => serialize(doc));
    // eslint-disable-next-line no-console
    console.log(`[size] 2000-item document is ${(text.value.length / 1024).toFixed(0)} kB of JSON`);
    const back = timed('deserialize 2000', () => deserialize(text.value));
    expect(back.value.doc?.items).toHaveLength(2000);
    const url = timed('encodeShareUrl 2000', () => encodeShareUrl(doc, 'https://x/#'));
    // eslint-disable-next-line no-console
    console.log(`[size] share link is ${url.value.length} chars`);
    timed('decodeShareUrl 2000', () => expect(decodeShareUrl(url.value).doc?.items).toHaveLength(2000));
  }, 300_000);

  it('a 20000 x 20000 mm wall solved for the smallest bed still finishes', () => {
    const available = [
      { partId: 'p-small', columns: 4, rows: 4, widthMm: 88.6, heightMm: 106.2 },
      { partId: 'p-big', columns: 16, rows: 18, widthMm: 374.7, heightMm: 389.4 },
    ];
    // Baseline at 1/10 the size, so the growth rate is measurable rather than guessed.
    const small = timed('tile 2000x2000 on "mini"', () =>
      solveTiling({ wall: { widthMm: 2000, heightMm: 2000 }, bedId: 'mini', available }),
    );
    const big = timed('tile 20000x20000 on "mini"', () =>
      solveTiling({ wall: { widthMm: 20000, heightMm: 20000 }, bedId: 'mini', available }),
    );
    // eslint-disable-next-line no-console
    console.log(
      `[scale] 2000mm: ${small.value.panels.length} panels / ${small.value.cellCount} cells / ` +
        `${small.value.seams.length} seams; 20000mm: ${big.value.panels.length} panels / ` +
        `${big.value.cellCount} cells / ${big.value.seams.length} seams; ` +
        `area x100, time x${(big.t / Math.max(small.t, 0.001)).toFixed(1)}`,
    );
    expect(big.value.panels.length).toBeGreaterThan(0);
    expect(big.value.coverage).toBeLessThanOrEqual(1);
    // A UI action must not take longer than a user will wait. 10 s is already awful.
    expect(big.t).toBeLessThan(10_000);
  }, 600_000);

  it('absurd coordinates (q,r = +/-1e9) do not throw anywhere', () => {
    const s = new Store(emptyDoc(), catalog); // no panels: everything is "on the wall"
    const far = s.addItem('pair', { q: 1e9, r: -1e9 });
    expect(far.ok).toBe(true);
    const doc = s.getState().doc;
    expect(() => validate(doc, catalog)).not.toThrow();
    expect(() => computeBom(doc, catalog)).not.toThrow();
    expect(() => itemCells(doc.items[0]!, catalog)).not.toThrow();
    expect(() => s.rotateItems([doc.items[0]!.id], 1)).not.toThrow();

    // DEFECT CHECK: the store accepted it, so persist must be able to store it.
    // Whatever the store accepts must survive a save/load, or the store should
    // have refused the placement in the first place.
    const round = deserialize(serialize(s.getState().doc));
    expect(
      round.doc?.items.length,
      `item at q=1e9 was accepted by the store but dropped on reload: ${round.errors.join(' | ')}`,
    ).toBe(1);
  });

  it('a panel with a plausible-but-huge cell count is not allowed to become an unbounded workload', () => {
    // Cost of panel expansion, measured, so the extrapolation below is honest.
    const t1 = timed('panelCells 300x300 (90k cells)', () => panelCells({ q: 0, r: 0 }, 300, 300));
    const t2 = timed('panelCells 1000x1000 (1M cells)', () => panelCells({ q: 0, r: 0 }, 1000, 1000));
    // eslint-disable-next-line no-console
    console.log(
      `[scale] panelCells: 9e4 cells in ${ms(t1.t)}, 1e6 cells in ${ms(t2.t)} ` +
        `=> a 10000x10000 panel (1e8 cells) would cost about ${(t2.t * 100).toFixed(0)} ms ` +
        `and ~${((1e8 * 32) / 1e9).toFixed(1)} GB of Hex objects, per call, and validate() calls it twice`,
    );
    expect(t2.value).toHaveLength(1e6);

    // migrate() is the gate between a hostile share link and that workload.
    const hostile = migrate({
      ...emptyDoc(),
      panels: [{ id: 'p', partId: 'panel-a', origin: { q: 0, r: 0 }, columns: 10000, rows: 10000 }],
    });
    expect(hostile.doc).not.toBeNull();
    const p = hostile.doc!.panels[0];
    expect(
      p === undefined || p.columns * p.rows <= 5e6,
      `migrate accepted a single panel of ${p ? p.columns * p.rows : 0} cells; ` +
        `rendering or validating that document will hang the tab`,
    ).toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 2. PLACEMENT ABUSE
// ---------------------------------------------------------------------------

describe('placement abuse', () => {
  it('refuses a drop that hangs half off the panel edge, and says which cells', () => {
    const r = store.addItem('pair', { q: 9, r: 0 }); // second cell is at q=10, off the 10-wide panel
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/hangs off/i);
    expect(r.blockedCells).toHaveLength(1);
    expect(store.getState().doc.items).toHaveLength(0);
  });

  it('refuses a drop entirely off the wall', () => {
    const r = store.addItem('single', { q: 500, r: 500 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/off the wall/i);
    expect(store.getState().doc.items).toHaveLength(0);
  });

  it('accepts a drop that sits exactly on the boundary', () => {
    const r = store.addItem('pair', { q: 8, r: 0 }); // cells 8 and 9: the last column
    expect(r.ok, `boundary drop refused: ${r.reason}`).toBe(true);
    const last = store.addItem('single', { q: -4, r: 9 }); // bottom-left-most cell of row 9
    expect(panelCells({ q: 0, r: 0 }, 10, 10).some((c) => c.q === -4 && c.r === 9)).toBe(true);
    expect(last.ok, `boundary drop refused: ${last.reason}`).toBe(true);
  });

  it('an accepted drop never produces an overlap that validate() then reports', () => {
    // The store's own contract: "Overlap is refused at drop time rather than
    // allowed and discovered later."
    const s = new Store(docWith(20, 20), catalog);
    expect(s.addItem('single', { q: 4, r: 5 }).ok).toBe(true);
    const r = s.addItem('anchored', { q: 5, r: 5 });
    if (r.ok) {
      const overlaps = s.issues().filter((i) => i.code === 'overlap');
      expect(
        overlaps,
        'the store accepted a drop that validate() immediately calls an overlap — ' +
          'checkPlacement ignores CatalogPart.anchor while bom.itemCells honours it',
      ).toEqual([]);
    } else {
      // The other half of the same bug: a legal position refused.
      const cells = itemCells({ id: 'x', partId: 'anchored', at: { q: 5, r: 5 }, rotation: 0 }, catalog);
      const clash = cells.some((c) => hexKey(c) === hexKey({ q: 4, r: 5 }));
      expect(clash, `drop refused (${r.reason}) although the real footprint is free`).toBe(true);
    }
  });

  it('refuses a rotation that would collide, and leaves the document untouched', () => {
    const s = new Store(docWith(20, 20), catalog);
    s.addItem('pair', { q: 4, r: 4 });
    const id = s.getState().doc.items[0]!.id;
    s.addItem('single', { q: 4, r: 3 }); // where the pair's tail lands after one step
    const before = snap(s);
    const r = s.rotateItems([id], 1);
    if (!r.ok) {
      expect(r.reason).toMatch(/cannot rotate/i);
      expect(snap(s)).toBe(before);
    }
    expect(s.issues().filter((i) => i.code === 'overlap')).toEqual([]);
  });

  it('rotating a group six times returns it exactly where it started', () => {
    // The pivot is the ROUNDED centroid, so a shape whose centroid is not a
    // lattice point rotates about a slightly different centre each time. If that
    // drifts, six 60-degree steps translate the user's group without telling them.
    const shapes: Array<[string, Hex[]]> = [
      ['single cell', [{ q: 10, r: 10 }]],
      ['pair', [{ q: 10, r: 10 }, { q: 11, r: 10 }]],
      ['L of three', [{ q: 10, r: 10 }, { q: 11, r: 10 }, { q: 10, r: 11 }]],
      ['diagonal pair', [{ q: 10, r: 10 }, { q: 11, r: 11 }]],
      ['four in a row', [
        { q: 8, r: 12 },
        { q: 9, r: 12 },
        { q: 10, r: 12 },
        { q: 11, r: 12 },
      ]],
      ['scattered five', [
        { q: 6, r: 6 },
        { q: 9, r: 7 },
        { q: 7, r: 11 },
        { q: 12, r: 9 },
        { q: 10, r: 13 },
      ]],
    ];
    const drifted: string[] = [];
    const refused: string[] = [];
    for (const [label, cells] of shapes) {
      const s = new Store(docWith(40, 40), catalog);
      for (const c of cells) expect(s.addItem('single', c).ok, `${label}: setup`).toBe(true);
      const ids = s.getState().doc.items.map((i) => i.id);
      if (ids.length > 1) s.groupItems(ids);
      const before = s.getState().doc.items.map((i) => `${i.at.q},${i.at.r}`).join(' ');
      for (let i = 0; i < 6; i++) {
        const r = s.rotateItems(ids, 1);
        if (!r.ok) refused.push(`${label} step ${i}: ${r.reason}`);
      }
      const after = s.getState().doc.items.map((i) => `${i.at.q},${i.at.r}`).join(' ');
      if (after !== before) drifted.push(`${label}: [${before}] -> [${after}]`);
    }
    expect(refused, 'a rotation in open space was refused').toEqual([]);
    expect(
      drifted,
      'six 60-degree rotations must be the identity; these groups were silently moved ' +
        '(rotateItems pivots on the ROUNDED centroid, which changes every step)',
    ).toEqual([]);
  });

  it('survives negative, zero and absurd rotation step counts without corrupting rotation', () => {
    const s = new Store(docWith(40, 40), catalog);
    s.addItem('pair', { q: 5, r: 10 });
    const id = s.getState().doc.items[0]!.id;
    for (const steps of [0, -1, -7, 6, 12, 1e9, -1e9, 2 ** 40]) {
      expect(() => s.rotateItems([id], steps), `steps=${steps} threw`).not.toThrow();
      const it0 = s.getState().doc.items.find((i) => i.id === id)!;
      expect(
        Number.isInteger(it0.rotation) && it0.rotation >= 0 && it0.rotation <= 5,
        `steps=${steps} left rotation = ${String(it0.rotation)}`,
      ).toBe(true);
      expect(Number.isInteger(it0.at.q) && Number.isInteger(it0.at.r), `steps=${steps} broke at`).toBe(
        true,
      );
    }
  });

  it('a non-finite rotation step must not be written into the document', () => {
    const s = new Store(docWith(40, 40), catalog);
    s.addItem('pair', { q: 5, r: 10 });
    const id = s.getState().doc.items[0]!.id;
    for (const steps of [NaN, Infinity, -Infinity, 0.5]) {
      expect(() => s.rotateItems([id], steps), `steps=${steps} threw`).not.toThrow();
      const it0 = s.getState().doc.items.find((i) => i.id === id)!;
      expect(
        Number.isInteger(it0.rotation) && it0.rotation >= 0 && it0.rotation <= 5,
        `rotateItems(ids, ${String(steps)}) stored rotation = ${String(it0.rotation)} — ` +
          `an unrepresentable document that save/load will silently rewrite`,
      ).toBe(true);
    }
  });

  it('a group move that collides for one member moves nobody', () => {
    const s = new Store(docWith(30, 30), catalog);
    s.addItem('single', { q: 2, r: 2 });
    s.addItem('single', { q: 3, r: 2 });
    s.addItem('single', { q: 4, r: 2 });
    const ids = s.getState().doc.items.map((i) => i.id);
    s.groupItems(ids);
    s.addItem('single', { q: 5, r: 2 }); // blocker one step right of the group's right edge
    const before = snap(s);
    const r = s.moveItems(ids, { q: 1, r: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/overlap/i);
    expect(snap(s), 'a refused group move left the document changed').toBe(before);
    expect(s.getState().canRedo).toBe(false);
  });

  it('a move by a non-integer or non-finite delta must not create an unsaveable document', () => {
    const s = new Store(docWith(30, 30), catalog);
    s.addItem('single', { q: 3, r: 3 });
    const id = s.getState().doc.items[0]!.id;
    for (const delta of [{ q: 0.5, r: 0 }, { q: NaN, r: 0 }, { q: Infinity, r: 1 }]) {
      const s2 = new Store(docWith(30, 30), catalog);
      s2.addItem('single', { q: 3, r: 3 });
      const id2 = s2.getState().doc.items[0]!.id;
      const r = s2.moveItems([id2], delta as Hex);
      const round = deserialize(serialize(s2.getState().doc));
      expect(
        !r.ok || round.doc?.items.length === 1,
        `moveItems by ${JSON.stringify(delta)} was accepted but the item is dropped on reload: ` +
          round.errors.join(' | '),
      ).toBe(true);
    }
    expect(id).toBeTruthy();
  });

  it('place, delete, undo, redo, move, undo x50, redo x50 is byte-identical throughout', () => {
    const s = new Store(docWith(20, 20), catalog);
    const s0 = snap(s);
    expect(s.addItem('pair', { q: 3, r: 3 }).ok).toBe(true);
    const id = s.getState().doc.items[0]!.id;
    const s1 = snap(s);
    expect(s.getState().selection).toEqual([id]);

    s.deleteItems([id]);
    const s2 = snap(s);
    expect(s.getState().doc.items).toHaveLength(0);

    s.undo();
    expect(snap(s), 'undo of a delete did not restore the exact prior state').toBe(s1);
    s.redo();
    expect(snap(s), 'redo did not reproduce the deleted state').toBe(s2);
    s.undo();
    expect(snap(s)).toBe(s1);

    expect(s.moveItems([id], { q: 2, r: 1 }).ok).toBe(true);
    const s3 = snap(s);

    for (let i = 0; i < 50; i++) s.undo();
    expect(snap(s), 'fifty undos did not land on the original document').toBe(s0);
    expect(s.getState().canUndo).toBe(false);

    for (let i = 0; i < 50; i++) s.redo();
    expect(snap(s), 'fifty redos did not land back on the latest document').toBe(s3);
    expect(s.getState().canRedo).toBe(false);
    // Selection travels with the snapshot, per the module contract.
    expect(JSON.parse(s3).selection).toEqual(s.getState().selection);
  });

  it('undo restores the selection as it was immediately before the undone command', () => {
    const s = new Store(docWith(20, 20), catalog);
    s.addItem('single', { q: 3, r: 3 });
    const id = s.getState().doc.items[0]!.id;
    s.select([id]);
    const beforeDelete = snap(s);
    s.deleteItems([id]);
    expect(s.getState().selection).toEqual([]);
    s.undo();
    expect(snap(s), 'undo of a delete lost the selection that was live at the time').toBe(
      beforeDelete,
    );

    // A selection-only change is deliberately not an undo step; the next undo
    // must therefore restore the selection as it stood when the command ran.
    s.select([]);
    const beforeSecond = snap(s);
    s.addItem('single', { q: 5, r: 5 });
    s.undo();
    expect(snap(s)).toBe(beforeSecond);
  });

  it('duplicating a group onto itself is refused, not silently merged', () => {
    const s = new Store(docWith(20, 20), catalog);
    s.addItem('single', { q: 3, r: 3 });
    s.addItem('single', { q: 4, r: 3 });
    const ids = s.getState().doc.items.map((i) => i.id);
    s.groupItems(ids);
    const before = snap(s);
    const r = s.duplicateItems(ids, { q: 0, r: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cannot duplicate/i);
    expect(snap(s)).toBe(before);

    const ok = s.duplicateItems(ids, { q: 0, r: 4 });
    expect(ok.ok, `clear duplicate refused: ${ok.reason}`).toBe(true);
    const doc = s.getState().doc;
    expect(doc.items).toHaveLength(4);
    const gids = new Set(doc.items.map((i) => i.groupId));
    expect(gids.size, 'the copy joined the original group instead of getting its own').toBe(2);
    expect(validate(doc, catalog).filter((i) => i.code === 'overlap')).toEqual([]);
  });

  it('commands with empty, unknown or repeated ids are no-ops rather than crashes', () => {
    const s = new Store(docWith(20, 20), catalog);
    s.addItem('single', { q: 3, r: 3 });
    const id = s.getState().doc.items[0]!.id;
    const before = snap(s);
    expect(() => {
      s.moveItems([], { q: 1, r: 1 });
      s.moveItems(['nope'], { q: 1, r: 1 });
      s.rotateItems(['nope'], 1);
      s.deleteItems(['nope']);
      s.duplicateItems(['nope'], { q: 1, r: 1 });
      s.groupItems(['nope']);
      s.ungroupItems(['nope']);
      s.moveItems([id, id, id], { q: 0, r: 0 });
      s.select(['nope', 'nope']);
      s.expandSelection(['nope']);
      s.addItem('does-not-exist', { q: 0, r: 0 });
    }).not.toThrow();
    expect(JSON.parse(snap(s)).doc).toEqual(JSON.parse(before).doc);
  });
});

// ---------------------------------------------------------------------------
// 3. PERSISTENCE ABUSE
// ---------------------------------------------------------------------------

function hostile(label: string, text: string): void {
  it(`deserialize(${label}) neither throws nor lies`, () => {
    let res: ReturnType<typeof deserialize> | undefined;
    expect(() => {
      res = deserialize(text);
    }, `${label} threw`).not.toThrow();
    expect(res).toBeDefined();
    if (res!.doc === null) {
      expect(res!.errors.length, `${label} refused without explaining why`).toBeGreaterThan(0);
      expect(res!.errors.join(' ').length).toBeGreaterThan(10);
    } else {
      // If a document came back, it must be structurally sound.
      expect(Array.isArray(res!.doc.items)).toBe(true);
      expect(Array.isArray(res!.doc.panels)).toBe(true);
      expect(Array.isArray(res!.doc.groups)).toBe(true);
      expect(typeof res!.doc.wall.widthMm).toBe('number');
    }
  });
}

const goodDoc: LayoutDoc = {
  schemaVersion: CURRENT_SCHEMA,
  id: 'doc-1',
  name: 'Garage wall',
  wall: { widthMm: 2400, heightMm: 1200 },
  bedId: 'bed256',
  panels: [{ id: 'p1', partId: 'panel-a', origin: { q: -3, r: 0 }, columns: 7, rows: 8 }],
  items: [
    { id: 'i1', partId: 'single', at: { q: 2, r: 3 }, rotation: 1 },
    { id: 'i2', partId: 'pair', at: { q: -4, r: -7 }, rotation: 5, groupId: 'g1' },
  ],
  groups: [{ id: 'g1', label: 'Screwdrivers' }],
};

describe('persistence abuse', () => {
  hostile('""', '');
  hostile('"   "', '   \n\t ');
  hostile('"null"', 'null');
  hostile('"{"', '{');
  hostile('"[]"', '[]');
  hostile('"42"', '42');
  hostile('"true"', 'true');
  hostile('a bare string', '"just some text"');
  hostile('truncated JSON', serialize(goodDoc).slice(0, 120));
  hostile('JSON with a trailing comma', '{"items":[],}');
  hostile('NUL bytes', '\u0000\u0000\u0000');
  hostile('lone surrogate', '"\ud800"');
  hostile('{"items":"banana"}', '{"items":"banana"}');
  hostile('items as a number', '{"items":42,"panels":null,"groups":false}');
  hostile('everything wrong', '{"schemaVersion":"x","id":1,"name":[],"wall":7,"bedId":null}');

  it('an 8 MB blob is refused quickly and does not throw', () => {
    const junk = 'a'.repeat(8 * 1024 * 1024);
    const t = timed('deserialize 8 MB of junk', () => deserialize(junk));
    expect(t.value.doc).toBeNull();
    expect(t.value.errors.length).toBeGreaterThan(0);
    expect(t.t).toBeLessThan(5000);

    const bigString = timed('deserialize 8 MB JSON string', () =>
      deserialize(JSON.stringify('x'.repeat(8 * 1024 * 1024))),
    );
    expect(bigString.value.doc).toBeNull();
    expect(bigString.value.errors.length).toBeGreaterThan(0);
  }, 120_000);

  it('10k-deep nested arrays do not blow the stack, as text or as a live object', () => {
    const deepText = '['.repeat(10_000) + ']'.repeat(10_000);
    let a: unknown = [];
    for (let i = 0; i < 10_000; i++) a = [a];
    const t1 = timed('deserialize 10k-deep array text', () => deserialize(deepText));
    expect(t1.value.doc).toBeNull();
    expect(t1.value.errors.length).toBeGreaterThan(0);

    let live: ReturnType<typeof migrate> | undefined;
    expect(() => {
      live = migrate({ ...goodDoc, name: 'deep', items: [{ id: 'x', partId: 'single', at: a }] } as never);
    }, 'migrate blew the stack on a 10k-deep live object').not.toThrow();
    expect(live!.doc).not.toBeNull();
    expect(live!.errors.length).toBeGreaterThan(0);
  }, 120_000);

  it('items missing "at", or with a broken "at", are dropped with an explanation', () => {
    const cases: Array<[string, unknown]> = [
      ['missing at', { id: 'a', partId: 'single', rotation: 0 }],
      ['at = NaN', { id: 'b', partId: 'single', at: { q: NaN, r: 0 }, rotation: 0 }],
      ['at = Infinity', { id: 'c', partId: 'single', at: { q: 0, r: Infinity }, rotation: 0 }],
      ['at = 1.5', { id: 'd', partId: 'single', at: { q: 1.5, r: 0 }, rotation: 0 }],
      ['at = "3"', { id: 'e', partId: 'single', at: { q: '3', r: '4' }, rotation: 0 }],
      ['at = null', { id: 'f', partId: 'single', at: null, rotation: 0 }],
      ['at = [1,2]', { id: 'g', partId: 'single', at: [1, 2], rotation: 0 }],
      ['at = 1e9', { id: 'h', partId: 'single', at: { q: 1e9, r: 0 }, rotation: 0 }],
      ['missing partId', { id: 'i', at: { q: 0, r: 0 }, rotation: 0 }],
      ['rotation = 99', { id: 'j', partId: 'single', at: { q: 1, r: 1 }, rotation: 99 }],
      ['rotation = "x"', { id: 'k', partId: 'single', at: { q: 2, r: 2 }, rotation: 'x' }],
      ['item is a string', 'banana'],
      ['item is null', null],
    ];
    for (const [label, item] of cases) {
      let res: ReturnType<typeof migrate> | undefined;
      expect(() => {
        res = migrate({ ...goodDoc, items: [item] } as never);
      }, `${label} threw`).not.toThrow();
      expect(res!.doc, label).not.toBeNull();
      expect(res!.errors.length, `${label} produced no explanation`).toBeGreaterThan(0);
      const kept = res!.doc!.items;
      // Anything kept must be a well-formed item.
      for (const it0 of kept) {
        expect(Number.isInteger(it0.at.q) && Number.isInteger(it0.at.r), label).toBe(true);
        expect(it0.rotation >= 0 && it0.rotation <= 5, label).toBe(true);
      }
      // Panels and groups must survive the loss of one item.
      expect(res!.doc!.panels, label).toHaveLength(1);
      expect(res!.doc!.groups, label).toHaveLength(1);
    }
  });

  it('duplicate ids are renamed, never merged away', () => {
    const res = migrate({
      ...goodDoc,
      items: [
        { id: 'same', partId: 'single', at: { q: 0, r: 0 }, rotation: 0 },
        { id: 'same', partId: 'single', at: { q: 1, r: 0 }, rotation: 0 },
        { id: 'same', partId: 'single', at: { q: 2, r: 0 }, rotation: 0 },
      ],
    } as never);
    expect(res.doc!.items).toHaveLength(3);
    expect(new Set(res.doc!.items.map((i) => i.id)).size).toBe(3);
    expect(res.errors.some((e) => /used twice/i.test(e))).toBe(true);
  });

  it('__proto__ / constructor / prototype keys do not pollute Object.prototype', () => {
    const probe = {} as Record<string, unknown>;
    const payloads = [
      '{"__proto__":{"polluted":"yes"},"items":[]}',
      '{"constructor":{"prototype":{"polluted":"yes"}},"items":[]}',
      '{"items":[{"id":"a","partId":"single","at":{"q":0,"r":0},"rotation":0,"__proto__":{"polluted":"yes"}}]}',
      '{"prototype":{"polluted":"yes"},"groups":[{"id":"g","__proto__":{"polluted":"yes"}}]}',
    ];
    for (const p of payloads) {
      expect(() => deserialize(p), p).not.toThrow();
    }
    // And through the live-object path, which JSON.parse's reviver never sees.
    const live = JSON.parse('{"__proto__":{"polluted":"yes"}}');
    Object.defineProperty(live, '__proto__', {
      value: { polluted: 'yes' },
      enumerable: true,
      configurable: true,
    });
    expect(() => migrate({ ...goodDoc, ...live })).not.toThrow();
    expect(migrate(live).doc).not.toBeNull();

    expect((probe as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(([] as unknown as { polluted?: unknown }).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('a 50k-item document loads, and reports what it dropped', () => {
    const items = Array.from({ length: 50_000 }, (_, i) => ({
      id: `it-${i}`,
      partId: 'single',
      at: { q: i % 200, r: Math.floor(i / 200) },
      rotation: (i % 6) as Rotation,
    }));
    const doc: LayoutDoc = { ...goodDoc, items };
    const text = timed('serialize 50k items', () => serialize(doc));
    // eslint-disable-next-line no-console
    console.log(`[size] 50k-item file is ${(text.value.length / (1024 * 1024)).toFixed(1)} MB`);
    const back = timed('deserialize 50k items', () => deserialize(text.value));
    expect(back.value.doc?.items).toHaveLength(50_000);
    expect(back.value.errors).toEqual([]);
    timed('validate 50k items', () => validate(back.value.doc!, catalog));
    timed('bom 50k items', () => computeBom(back.value.doc!, catalog));
  }, 300_000);

  it('an over-long array is truncated loudly, not silently', () => {
    const items = Array.from({ length: 250_000 }, (_, i) => ({
      id: `it-${i}`,
      partId: 'single',
      at: { q: 0, r: i },
      rotation: 0,
    }));
    const res = migrate({ ...goodDoc, items } as never);
    expect(res.doc).not.toBeNull();
    if (res.doc!.items.length < items.length) {
      expect(
        res.errors.some((e) => /200|limit|too many|truncat|dropp/i.test(e)),
        `${items.length - res.doc!.items.length} items were removed with no error mentioning it: ` +
          JSON.stringify(res.errors.slice(0, 5)),
      ).toBe(true);
    }
  }, 120_000);

  it('a real file with more than 200k items does not lose the overflow in silence', () => {
    // The realistic path: a saved file, not a hand-built object.
    const items = Array.from({ length: 210_000 }, (_, i) => ({
      id: `x${i}`,
      partId: 's',
      at: { q: 0, r: i },
      rotation: 0,
    }));
    const text = JSON.stringify({ ...goodDoc, items });
    // eslint-disable-next-line no-console
    console.log(`[size] 210k-item file is ${(text.length / (1024 * 1024)).toFixed(1)} MB`);
    const res = timed('deserialize 210k items', () => deserialize(text));
    expect(res.value.doc).not.toBeNull();
    const kept = res.value.doc!.items.length;
    if (kept < items.length) {
      expect(
        res.value.errors.length,
        `${items.length - kept} of ${items.length} items vanished with no error at all — ` +
          `this is the exact failure mode persist.ts says it exists to prevent`,
      ).toBeGreaterThan(0);
    }
  }, 300_000);

  it('an over-long name is not truncated in silence', () => {
    const long = 'N'.repeat(10_000);
    const res = deserialize(serialize({ ...goodDoc, name: long }));
    expect(res.doc).not.toBeNull();
    if (res.doc!.name.length < long.length) {
      expect(
        res.errors.length,
        `the layout name was cut from ${long.length} to ${res.doc!.name.length} characters ` +
          `without a word to the user`,
      ).toBeGreaterThan(0);
    }
  });

  it('share links: broken hash, wrong base64, wrong scheme, future schema', () => {
    const bad = [
      'https://x/planner',
      'https://x/planner#',
      'https://x/planner#d=',
      'https://x/planner#d=!!!!not base64!!!!',
      'https://x/planner#d=ééé',
      'https://x/planner#d=A', // one base64 char: impossible length
      'https://x/planner#d=AAAA', // valid base64, scheme byte 0 then empty
      'https://x/planner#d=' + 'QUJD', // scheme 0x41, unknown
      'https://x/planner#a=1&b=2',
      '#d=zzzz',
      '',
    ];
    for (const url of bad) {
      let res: ReturnType<typeof decodeShareUrl> | undefined;
      expect(() => {
        res = decodeShareUrl(url);
      }, `${url} threw`).not.toThrow();
      expect(res!.errors.length, `${url} gave no reason`).toBeGreaterThan(0);
    }

    // Corrupting the middle of a real link must not crash the unpacker.
    const real = encodeShareUrl({ ...goodDoc, items: Array.from({ length: 60 }, (_, i) => ({
      id: `i${i}`,
      partId: 'single',
      at: { q: i, r: i },
      rotation: 0 as Rotation,
    })) }, 'https://x/planner');
    for (let cut = 10; cut < real.length; cut += Math.max(1, Math.floor(real.length / 40))) {
      const mangled = real.slice(0, cut) + 'A' + real.slice(cut + 1);
      expect(() => decodeShareUrl(mangled), `mangled at ${cut} threw`).not.toThrow();
      const r = decodeShareUrl(mangled);
      if (r.doc === null) expect(r.errors.length).toBeGreaterThan(0);
    }
    for (let cut = 10; cut < real.length; cut += 7) {
      expect(() => decodeShareUrl(real.slice(0, cut)), `truncated at ${cut} threw`).not.toThrow();
    }

    // A link written by a future build: read what is recognisable, say so.
    const future = encodeShareUrl({ ...goodDoc, schemaVersion: 99 }, 'https://x/planner');
    const res = decodeShareUrl(future);
    expect(res.doc, 'a future-schema link lost the whole layout').not.toBeNull();
    expect(res.doc!.items).toHaveLength(2);
    expect(res.errors.some((e) => /newer version/i.test(e))).toBe(true);
  }, 120_000);

  it('round-trips several documents exactly', () => {
    const docs: LayoutDoc[] = [
      goodDoc,
      { ...emptyDoc() },
      {
        ...goodDoc,
        name: 'unicode — é中🔧',
        items: [
          { id: 'neg', partId: 'single', at: { q: -1000, r: -1000 }, rotation: 0 },
          { id: 'rot', partId: 'pair', at: { q: 0, r: 0 }, rotation: 5, groupId: 'g1' },
          { id: 'rot2', partId: 'pair', at: { q: 9, r: -9 }, rotation: 3, groupId: 'g1' },
        ],
        groups: [{ id: 'g1' }, { id: 'g2', label: 'empty group' }],
      },
      {
        ...goodDoc,
        panels: Array.from({ length: 12 }, (_, i) => ({
          id: `p${i}`,
          partId: 'panel-a',
          // 0 - 0 is -0, which JSON writes as 0: a cosmetic round-trip
          // infidelity, kept out of this fixture so it does not mask real ones.
          origin: { q: i === 0 ? 0 : -i, r: i * 8 },
          columns: 7,
          rows: 8,
        })),
      },
    ];
    for (const d of docs) {
      const res = deserialize(serialize(d));
      expect(res.errors, `round trip of "${d.name}" reported problems`).toEqual([]);
      expect(res.doc, `round trip of "${d.name}" lost the document`).toEqual(d);
      const viaLink = decodeShareUrl(encodeShareUrl(d, 'https://x/p'));
      expect(viaLink.doc, `share link round trip of "${d.name}" changed it`).toEqual(d);
      expect(viaLink.errors).toEqual([]);
    }
  });

  it('a store round-trips whatever it produced, after real editing', () => {
    const s = new Store(docWith(20, 20), catalog);
    s.addItem('pair', { q: 2, r: 2 });
    s.addItem('single', { q: 5, r: 5 });
    s.addItem('single', { q: 6, r: 5 });
    const ids = s.getState().doc.items.map((i) => i.id).slice(1);
    s.groupItems(ids);
    s.rotateItems([s.getState().doc.items[0]!.id], 2);
    s.duplicateItems(ids, { q: 0, r: 4 });
    s.setName('  spaces  and   control chars \n');
    s.setWall(-5, Infinity);
    const doc = s.getState().doc;
    const res = deserialize(serialize(doc));
    expect(res.errors, 'a document produced by the store does not round-trip cleanly').toEqual([]);
    expect(res.doc).toEqual(doc);
  });
});

// ---------------------------------------------------------------------------
// 4. CATALOGUE ABUSE
// ---------------------------------------------------------------------------

describe('catalogue abuse', () => {
  const nasty: Catalog = {
    schemaVersion: 1,
    generatedAt: '',
    slicerProfile: 'test',
    parts: [
      part('dup', [{ q: 0, r: 0 }], { name: 'First wins' }),
      part('dup', [{ q: 0, r: 0 }], {
        name: 'Second',
        print: { minutes: 999, grams: 999, metres: 9, profile: 'x', supports: true, source: 'sliced' },
      }),
      part('empty-fp', []),
      part('needs-ghost', [{ q: 0, r: 0 }], { requires: [{ partId: 'ghost', count: 2 }] }),
      part('nan-print', [{ q: 0, r: 0 }], {
        print: {
          minutes: NaN,
          grams: Infinity,
          metres: -0,
          profile: 'x',
          supports: true,
          source: 'volume',
        },
        hardware: [{ item: 'M3 screw', count: NaN }, { item: '', count: 3 }],
        requires: [{ partId: 'dup', count: NaN }],
      }),
      part('panel-a', [], { type: 'panel' }),
    ],
    unresolved: [],
  };

  const doc: LayoutDoc = {
    ...emptyDoc(),
    panels: [{ id: 'p0', partId: 'panel-a', origin: { q: 0, r: 0 }, columns: 10, rows: 10 }],
    items: [
      { id: 'a', partId: 'dup', at: { q: 0, r: 0 }, rotation: 0 },
      { id: 'b', partId: 'empty-fp', at: { q: 1, r: 0 }, rotation: 0 },
      { id: 'c', partId: 'needs-ghost', at: { q: 2, r: 0 }, rotation: 0 },
      { id: 'd', partId: 'nan-print', at: { q: 3, r: 0 }, rotation: 0 },
      { id: 'e', partId: 'not-in-catalogue', at: { q: 4, r: 0 }, rotation: 0 },
    ],
  };

  it('still produces a usable BOM with numbers that are not NaN', () => {
    let bom: ReturnType<typeof computeBom> | undefined;
    expect(() => {
      bom = computeBom(doc, nasty);
    }).not.toThrow();
    const b = bom!;
    for (const line of [...b.printed, ...b.fasteners]) {
      expect(Number.isFinite(line.minutes), `${line.partId}.minutes = ${line.minutes}`).toBe(true);
      expect(Number.isFinite(line.grams), `${line.partId}.grams = ${line.grams}`).toBe(true);
      expect(Number.isFinite(line.metres), `${line.partId}.metres = ${line.metres}`).toBe(true);
      expect(line.quantity).toBeGreaterThan(0);
    }
    for (const v of Object.values(b.totals)) expect(Number.isFinite(v)).toBe(true);
    // Duplicate ids: one line, first entry wins.
    expect(b.printed.filter((l) => l.partId === 'dup')).toHaveLength(1);
    expect(b.printed.find((l) => l.partId === 'dup')!.name).toBe('First wins');
    // Missing requirement and missing part are both reported, once each.
    const unknown = b.issues.filter((i) => i.code === 'unknown-part').map((i) => i.message);
    expect(unknown.join(' ')).toMatch(/ghost/);
    expect(unknown.join(' ')).toMatch(/not-in-catalogue/);
    // Empty shopping keys are not smuggled in.
    expect(b.shopping.every((s) => s.item.length > 0 && Number.isFinite(s.count))).toBe(true);
  });

  it('a part with an empty footprint can still be placed on a panel', () => {
    const s = new Store(
      { ...emptyDoc(), panels: [{ id: 'p', partId: 'panel-a', origin: { q: 0, r: 0 }, columns: 10, rows: 10 }] },
      nasty,
    );
    const r = s.addItem('empty-fp', { q: 3, r: 3 });
    expect(
      r.ok,
      `a part whose catalogue footprint is empty cannot be placed anywhere on a panel: "${r.reason}". ` +
        `bom.itemCells treats an empty footprint as one cell; store.addItem treats it as no cells.`,
    ).toBe(true);
  });

  it('an item whose footprint is empty is not invisible to the collision check', () => {
    const s = new Store({ ...emptyDoc() }, nasty); // no panels, so placement is unconstrained
    expect(s.addItem('empty-fp', { q: 3, r: 3 }).ok).toBe(true);
    const second = s.addItem('dup', { q: 3, r: 3 });
    expect(second.ok, 'two parts were allowed to occupy the same cell').toBe(false);
    expect(validate(s.getState().doc, nasty).filter((i) => i.code === 'overlap')).toEqual([]);
  });

  it('a catalogue that is empty, null-ish or malformed does not crash the BOM', () => {
    const broken: unknown[] = [
      { schemaVersion: 1, generatedAt: '', slicerProfile: '', parts: [], unresolved: [] },
      { parts: null },
      { parts: [null, undefined, 42, { id: 5 }, { id: 'ok' }] },
      {},
    ];
    for (const c of broken) {
      expect(() => computeBom(doc, c as Catalog), JSON.stringify(c)).not.toThrow();
      expect(() => validate(doc, c as Catalog), JSON.stringify(c)).not.toThrow();
      const b = computeBom(doc, c as Catalog);
      expect(Number.isFinite(b.totals.minutes)).toBe(true);
      expect(b.issues.length).toBeGreaterThan(0);
    }
  });

  it('the tiler refuses nonsense sizes with a warning rather than an exception', () => {
    const cases = [
      { wall: { widthMm: 0, heightMm: 0 }, bedId: 'bed256', available: [] },
      { wall: { widthMm: NaN, heightMm: 1000 }, bedId: 'bed256', available: [] },
      { wall: { widthMm: -1, heightMm: -1 }, bedId: 'nope', available: [] },
      { wall: { widthMm: Infinity, heightMm: Infinity }, bedId: 'bed256', available: [] },
      {
        wall: { widthMm: 1000, heightMm: 1000 },
        bedId: 'bed256',
        available: [
          { partId: 'x', columns: 0, rows: 0, widthMm: 0, heightMm: 0 },
          { partId: 'y', columns: 1.5, rows: NaN, widthMm: NaN, heightMm: 1 },
          { partId: 'z', columns: Infinity, rows: 1, widthMm: 10, heightMm: 10 },
        ],
      },
    ];
    for (const req of cases) {
      let out: ReturnType<typeof solveTiling> | undefined;
      expect(() => {
        out = solveTiling(req as never);
      }, JSON.stringify(req)).not.toThrow();
      expect(out!.panels).toEqual([]);
      expect(out!.warnings.length, `no warning for ${JSON.stringify(req)}`).toBeGreaterThan(0);
      expect(Number.isFinite(out!.coverage)).toBe(true);
      expect(Number.isFinite(out!.unusedMm.right)).toBe(true);
    }
  });

  it('placeFootprint and itemCells tolerate rubbish without throwing', () => {
    expect(() => placeFootprint([], { q: 0, r: 0 }, 0)).not.toThrow();
    expect(() => placeFootprint([{ q: 1, r: 1 }], { q: NaN, r: NaN }, 3)).not.toThrow();
    const junkItems: PlacedItem[] = [
      { id: 'a', partId: 'single', at: undefined as never, rotation: 0 },
      { id: 'b', partId: 'single', at: { q: NaN, r: 0 }, rotation: 9 as Rotation },
      { id: 'c', partId: undefined as never, at: { q: 0, r: 0 }, rotation: 0 },
    ];
    for (const it0 of junkItems) {
      expect(() => itemCells(it0, catalog), it0.id).not.toThrow();
    }
  });
});
