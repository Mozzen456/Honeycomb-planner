/**
 * BOM tests.
 *
 * Every fixture here is small enough to check by hand — the numbers in the
 * assertions are arithmetic you can do on paper, which is the only way a BOM
 * test is worth anything.
 */

import { describe, expect, it } from 'vitest';

import { computeBom, itemCells, validate } from '../src/core/bom';
import type {
  Catalog,
  CatalogPart,
  Hex,
  LayoutDoc,
  PlacedItem,
  PlacedPanel,
  PrintEstimate,
  Rotation,
} from '../src/core/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEstimate(over: Partial<PrintEstimate> = {}): PrintEstimate {
  return {
    minutes: 0,
    grams: 0,
    metres: 0,
    profile: 'test-0.20mm-pla',
    supports: false,
    source: 'sliced',
    ...over,
  };
}

/** Overrides for a fake part. `print` takes a partial estimate; the rest is filled in. */
type PartOverrides = Partial<Omit<CatalogPart, 'print'>> & {
  id: string;
  print?: Partial<PrintEstimate>;
};

function makePart(over: PartOverrides): CatalogPart {
  const { print, ...rest } = over;
  return {
    name: `Part ${over.id}`,
    file: `models/${over.id}.stl`,
    type: 'accessory',
    group: 'test',
    footprint: [{ q: 0, r: 0 }],
    anchor: { q: 0, r: 0 },
    drawnOrientation: 'pointy',
    bboxMm: [23.6, 23.6, 8],
    volumeMm3: 1000,
    requires: [],
    hardware: [],
    print: makeEstimate(print),
    provenance: { basis: 'geometry', confidence: 1, notes: [] },
    sha256: `sha-${over.id}`,
    ...rest,
  };
}

function makeCatalog(parts: CatalogPart[]): Catalog {
  return {
    schemaVersion: 1,
    generatedAt: '2024-01-01T00:00:00.000Z',
    slicerProfile: 'test-0.20mm-pla',
    parts,
    unresolved: [],
  };
}

function makeDoc(over: Partial<LayoutDoc> = {}): LayoutDoc {
  return {
    schemaVersion: 1,
    id: 'doc-1',
    name: 'Test wall',
    wall: { widthMm: 2400, heightMm: 1200 },
    bedId: 'bed256',
    panels: [],
    items: [],
    groups: [],
    ...over,
  };
}

const item = (id: string, partId: string, q: number, r: number, rotation: Rotation = 0): PlacedItem => ({
  id,
  partId,
  at: { q, r },
  rotation,
});

const panel = (
  id: string,
  partId: string,
  q: number,
  r: number,
  columns: number,
  rows: number,
): PlacedPanel => ({ id, partId, origin: { q, r }, columns, rows });

/** Place `n` copies of a part in distinct cells along a row. */
const repeat = (partId: string, n: number, r = 0): PlacedItem[] =>
  Array.from({ length: n }, (_, i) => item(`${partId}-${i}`, partId, i, r));

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// The standard cast: a shelf that needs two clips, a clip, and a panel.
const SHELF = makePart({
  id: 'shelf',
  name: 'Shelf',
  type: 'accessory',
  print: { minutes: 42.4, grams: 12.34, metres: 4.06, supports: true },
});

const CLIP = makePart({
  id: 'clip',
  name: 'Clip insert',
  type: 'insert',
  print: { minutes: 3.5, grams: 1.2, metres: 0.4 },
});

const PANEL = makePart({
  id: 'panel3',
  name: 'Panel 3x3',
  type: 'panel',
  print: { minutes: 300, grams: 100, metres: 33.3 },
  panel: { columns: 3, rows: 3, widthMm: 100, heightMm: 100, fitsBeds: ['bed256'] },
});

const cells = (hexes: Hex[]): string[] => hexes.map((h) => `${h.q},${h.r}`).sort();

// ---------------------------------------------------------------------------

describe('itemCells', () => {
  it('translates a multi-cell footprint to the placed position', () => {
    const wide = makePart({ id: 'wide', footprint: [{ q: 0, r: 0 }, { q: 1, r: 0 }] });
    const catalog = makeCatalog([wide]);
    expect(cells(itemCells(item('a', 'wide', 3, 2), catalog))).toEqual(['3,2', '4,2']);
  });

  it('rotates about the anchor', () => {
    const wide = makePart({ id: 'wide', footprint: [{ q: 0, r: 0 }, { q: 1, r: 0 }] });
    const catalog = makeCatalog([wide]);
    // One 60° step takes {1,0} to {0,1}; the anchor cell stays put.
    expect(cells(itemCells(item('a', 'wide', 5, 5, 1), catalog))).toEqual(['5,5', '5,6']);
  });

  it('returns no cells for an unknown part instead of throwing', () => {
    expect(itemCells(item('a', 'ghost', 0, 0), makeCatalog([SHELF]))).toEqual([]);
  });
});

describe('computeBom quantities', () => {
  it('aggregates the same part placed five times into one line', () => {
    const doc = makeDoc({ items: repeat('shelf', 5) });
    const bom = computeBom(doc, makeCatalog([SHELF]));

    expect(bom.printed).toHaveLength(1);
    const line = bom.printed[0]!;
    expect(line.partId).toBe('shelf');
    expect(line.name).toBe('Shelf');
    expect(line.file).toBe('models/shelf.stl');
    expect(line.type).toBe('accessory');
    expect(line.supports).toBe(true);
    expect(line.quantity).toBe(5);
    expect(line.grams).toBe(61.7); // 12.34 × 5
    expect(line.metres).toBe(20.3); // 4.06 × 5

    expect(bom.totals.parts).toBe(5);
    expect(bom.totals.distinctParts).toBe(1);
    expect(bom.totals.grams).toBe(61.7);
    expect(bom.totals.metres).toBe(20.3);
  });

  it('counts panels as printed parts too', () => {
    const doc = makeDoc({
      panels: [panel('p1', 'panel3', 0, 0, 3, 3), panel('p2', 'panel3', 10, 0, 3, 3)],
    });
    const bom = computeBom(doc, makeCatalog([PANEL]));

    expect(bom.printed).toHaveLength(1);
    expect(bom.printed[0]!.quantity).toBe(2);
    expect(bom.totals.grams).toBe(200);
    expect(bom.totals.metres).toBe(66.6);
  });
});

describe('requirements', () => {
  it('multiplies insert requirements by placement count', () => {
    const shelf = makePart({ ...SHELF, requires: [{ partId: 'clip', count: 2 }] });
    const doc = makeDoc({ items: repeat('shelf', 3) });
    const bom = computeBom(doc, makeCatalog([shelf, CLIP]));

    expect(bom.printed.map((l) => [l.partId, l.quantity])).toEqual([['shelf', 3]]);
    expect(bom.fasteners.map((l) => [l.partId, l.quantity])).toEqual([['clip', 6]]);
  });

  it('includes fastener filament in the grand totals', () => {
    const shelf = makePart({ ...SHELF, requires: [{ partId: 'clip', count: 2 }] });
    const bom = computeBom(makeDoc({ items: repeat('shelf', 3) }), makeCatalog([shelf, CLIP]));

    const clip = bom.fasteners[0]!;
    expect(clip.grams).toBe(7.2); // 1.2 × 6
    expect(clip.metres).toBe(2.4); // 0.4 × 6

    expect(bom.totals.parts).toBe(9); // 3 shelves + 6 clips
    expect(bom.totals.distinctParts).toBe(2);
    expect(bom.totals.grams).toBe(44.2); // 12.34×3 + 1.2×6 = 44.22
    expect(bom.totals.metres).toBe(14.58); // 4.06×3 + 0.4×6 = 14.58
  });

  it('rolls up requirements from panels as well as items', () => {
    const mounted = makePart({ ...PANEL, requires: [{ partId: 'clip', count: 4 }] });
    const doc = makeDoc({ panels: [panel('p1', 'panel3', 0, 0, 3, 3)] });
    const bom = computeBom(doc, makeCatalog([mounted, CLIP]));

    expect(bom.fasteners.map((l) => [l.partId, l.quantity])).toEqual([['clip', 4]]);
  });

  it('keeps one line per part when an insert is also placed directly', () => {
    const shelf = makePart({ ...SHELF, requires: [{ partId: 'clip', count: 2 }] });
    const doc = makeDoc({ items: [...repeat('shelf', 3), item('c1', 'clip', 0, 5)] });
    const bom = computeBom(doc, makeCatalog([shelf, CLIP]));

    expect(bom.fasteners).toHaveLength(1);
    expect(bom.fasteners[0]!.quantity).toBe(7); // 6 required + 1 placed
    expect(bom.printed.map((l) => l.partId)).toEqual(['shelf']);
    expect(bom.totals.distinctParts).toBe(2);
  });
});

describe('shopping list', () => {
  it('sums bought hardware by name and sorts it', () => {
    const shelf = makePart({
      ...SHELF,
      requires: [{ partId: 'clip', count: 2 }],
      hardware: [{ item: 'M4 screw', count: 2 }],
    });
    const clip = makePart({ ...CLIP, hardware: [{ item: 'M4 screw', count: 1 }] });
    const panelPart = makePart({
      ...PANEL,
      hardware: [
        { item: 'Wall plug', count: 4 },
        { item: 'Anchor bolt', count: 2 },
      ],
    });
    const doc = makeDoc({
      panels: [panel('p1', 'panel3', 0, 0, 3, 3)],
      items: repeat('shelf', 3),
    });
    const bom = computeBom(doc, makeCatalog([shelf, clip, panelPart]));

    // 3 shelves × 2 = 6 screws, plus 6 required clips × 1 = 6 → 12, sorted by name.
    expect(bom.shopping).toEqual([
      { item: 'Anchor bolt', count: 2 },
      { item: 'M4 screw', count: 12 },
      { item: 'Wall plug', count: 4 },
    ]);
  });

  it('has an empty shopping list when nothing needs buying', () => {
    expect(computeBom(makeDoc({ items: repeat('shelf', 2) }), makeCatalog([SHELF])).shopping).toEqual(
      [],
    );
  });
});

describe('rounding', () => {
  it('totals from unrounded values: 0.05 g placed 40 times is 2.0 g, not 0.0', () => {
    const tiny = makePart({
      id: 'tiny',
      print: { minutes: 0.4, grams: 0.05, metres: 0.017 },
    });
    const doc = makeDoc({ items: repeat('tiny', 40) });
    const bom = computeBom(doc, makeCatalog([tiny]));

    expect(bom.printed[0]!.quantity).toBe(40);
    expect(bom.printed[0]!.grams).toBe(2); // 0.05 × 40
    expect(bom.totals.grams).toBe(2);
    expect(bom.totals.metres).toBe(0.68); // 0.017 × 40
  });

  it('does not sum the rounded line values', () => {
    // Two parts whose lines each round to zero, but which together are not zero.
    const a = makePart({ id: 'a', print: { minutes: 0.4, grams: 0.04, metres: 0.004 } });
    const b = makePart({ id: 'b', print: { minutes: 0.4, grams: 0.04, metres: 0.004 } });
    const doc = makeDoc({ items: [item('i1', 'a', 0, 0), item('i2', 'b', 1, 0)] });
    const bom = computeBom(doc, makeCatalog([a, b]));

    expect(bom.printed.map((l) => [l.grams, l.metres])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(bom.totals.grams).toBe(0.1); // 0.08
    expect(bom.totals.metres).toBe(0.01); // 0.008
  });
});

describe('validate', () => {
  // Two cells wide, and of catalogue `type: 'insert'` — which is what makes a
  // shared cell an error at all. Overlap is only impossible when both parts go
  // INTO the hexagonal hole; accessories bolt on in front of it and are allowed
  // to share cells (see the accessory case below).
  const wide = makePart({ id: 'wide', type: 'insert', footprint: [{ q: 0, r: 0 }, { q: 1, r: 0 }] });

  it('reports both item ids and the shared cells of an overlap', () => {
    const catalog = makeCatalog([wide, PANEL]);
    const doc = makeDoc({
      panels: [panel('p1', 'panel3', 0, 0, 5, 5)],
      items: [item('left', 'wide', 0, 0), item('right', 'wide', 1, 0)],
    });
    const issues = validate(doc, catalog);
    const overlap = issues.filter((i) => i.code === 'overlap');

    expect(overlap).toHaveLength(1);
    expect(overlap[0]!.level).toBe('error');
    expect(overlap[0]!.itemIds.slice().sort()).toEqual(['left', 'right']);
    expect(overlap[0]!.cells).toEqual([{ q: 1, r: 0 }]);
  });

  it('does NOT report two accessories sharing a cell — mounting things on top is the point', () => {
    // Same geometry as the case above, with the parts typed 'accessory'. The
    // wall exists to carry things in front of it, so a shared cell is ordinary
    // and gets no issue at all — not even a warning.
    const shelfy = makePart({ id: 'shelfy', type: 'accessory', footprint: [{ q: 0, r: 0 }, { q: 1, r: 0 }] });
    const doc = makeDoc({
      panels: [panel('p1', 'panel3', 0, 0, 5, 5)],
      items: [item('left', 'shelfy', 0, 0), item('right', 'shelfy', 1, 0)],
    });
    expect(validate(doc, makeCatalog([shelfy, PANEL]))).toEqual([]);
  });

  it('reports an item that no panel covers', () => {
    const catalog = makeCatalog([SHELF, PANEL]);
    const doc = makeDoc({
      panels: [panel('p1', 'panel3', 0, 0, 3, 3)],
      items: [item('on', 'shelf', 1, 1), item('off', 'shelf', 40, 40)],
    });
    const offPanel = validate(doc, catalog).filter((i) => i.code === 'off-panel');

    expect(offPanel).toHaveLength(1);
    expect(offPanel[0]!.level).toBe('error');
    expect(offPanel[0]!.itemIds).toEqual(['off']);
    expect(offPanel[0]!.cells).toEqual([{ q: 40, r: 40 }]);
  });

  it('warns once when there are items but no panels', () => {
    const doc = makeDoc({ items: repeat('shelf', 2) });
    const issues = validate(doc, makeCatalog([SHELF]));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('no-panel');
    expect(issues[0]!.level).toBe('warning');
    expect(issues[0]!.itemIds).toEqual(['shelf-0', 'shelf-1']);
  });

  it('does not warn about panels when the layout is empty', () => {
    expect(validate(makeDoc(), makeCatalog([SHELF]))).toEqual([]);
  });

  it('reports overlapping panels with both ids and every shared cell', () => {
    const doc = makeDoc({
      panels: [panel('p1', 'panel3', 0, 0, 2, 2), panel('p2', 'panel3', 1, 0, 2, 2)],
    });
    const issues = validate(doc, makeCatalog([PANEL]));
    const clash = issues.filter((i) => i.code === 'panel-overlap');

    expect(clash).toHaveLength(1);
    expect(clash[0]!.itemIds).toEqual(['p1', 'p2']);
    // panelCells staggers column q by -floor(q/2) on the flat-top wall (D35), so
    // the two 2x2 blocks one column apart overlap down their shared column:
    //   p1 covers (0,0),(0,1) and (1,0),(1,1)
    //   p2 covers (1,0),(1,1) and (2,0),(2,1)
    // which share the whole of column 1.
    expect(cells(clash[0]!.cells ?? [])).toEqual(['1,0', '1,1']);
  });

  it('reports an unknown partId once, listing every placement that wants it', () => {
    const doc = makeDoc({
      items: [item('g1', 'ghost', 0, 0), item('g2', 'ghost', 1, 0), item('s1', 'shelf', 2, 0)],
      panels: [panel('p1', 'panel3', 0, 0, 5, 5)],
    });
    const unknown = validate(doc, makeCatalog([SHELF, PANEL])).filter(
      (i) => i.code === 'unknown-part',
    );

    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.level).toBe('error');
    expect(unknown[0]!.itemIds).toEqual(['g1', 'g2']);
    expect(unknown[0]!.message).toContain('ghost');
  });

  it('reports a requirement that points at a missing part', () => {
    const shelf = makePart({ ...SHELF, requires: [{ partId: 'gone', count: 2 }] });
    const doc = makeDoc({
      panels: [panel('p1', 'panel3', 0, 0, 5, 5)],
      items: [item('s1', 'shelf', 0, 0)],
    });
    const unknown = validate(doc, makeCatalog([shelf, PANEL])).filter(
      (i) => i.code === 'unknown-part',
    );

    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.message).toContain('gone');
    expect(unknown[0]!.itemIds).toEqual(['s1']);
  });

  it('emits no crosses-seam issue — that belongs to the tiling module', () => {
    const doc = makeDoc({
      panels: [panel('p1', 'panel3', 0, 0, 3, 3), panel('p2', 'panel3', 3, 0, 3, 3)],
      items: [item('s1', 'shelf', 2, 0)],
    });
    expect(validate(doc, makeCatalog([SHELF, PANEL])).some((i) => i.code === 'crosses-seam')).toBe(
      false,
    );
  });
});

describe('computeBom robustness', () => {
  it('still returns a usable BOM when a partId is unknown, and never throws', () => {
    const doc = makeDoc({
      panels: [panel('p1', 'panel3', 0, 0, 5, 5)],
      items: [item('s1', 'shelf', 0, 0), item('g1', 'ghost', 1, 0)],
    });

    let bom = undefined as ReturnType<typeof computeBom> | undefined;
    expect(() => {
      bom = computeBom(doc, makeCatalog([SHELF, PANEL]));
    }).not.toThrow();

    const result = bom!;
    expect(result.issues.some((i) => i.code === 'unknown-part')).toBe(true);
    expect(result.printed.map((l) => l.partId).sort()).toEqual(['panel3', 'shelf']);
    expect(result.totals.parts).toBe(2); // the ghost contributes nothing
  });

  it('returns zeroed totals for an empty document', () => {
    const bom = computeBom(makeDoc(), makeCatalog([SHELF, CLIP]));

    expect(bom.printed).toEqual([]);
    expect(bom.fasteners).toEqual([]);
    expect(bom.shopping).toEqual([]);
    expect(bom.issues).toEqual([]);
    expect(bom.totals).toEqual({
      parts: 0,
      printed: 0,
      toPrint: 0,
      grams: 0,
      metres: 0,
      distinctParts: 0,
    });
  });

  it('survives an empty catalogue', () => {
    const doc = makeDoc({ items: repeat('shelf', 2) });
    const bom = computeBom(doc, makeCatalog([]));

    expect(bom.printed).toEqual([]);
    expect(bom.totals.parts).toBe(0);
    expect(bom.issues.map((i) => i.code).sort()).toEqual(['no-panel', 'unknown-part']);
  });

  it('carries the issues from validate', () => {
    // Typed 'insert' so the shared cell is the one overlap that IS an error —
    // two inserts cannot share one hexagonal hole. An insert lands on the
    // `fasteners` section of the list rather than `printed` (R2).
    const wide = makePart({ id: 'wide', type: 'insert', footprint: [{ q: 0, r: 0 }, { q: 1, r: 0 }] });
    const doc = makeDoc({
      panels: [panel('p1', 'panel3', 0, 0, 5, 5)],
      items: [item('left', 'wide', 0, 0), item('right', 'wide', 1, 0)],
    });
    const bom = computeBom(doc, makeCatalog([wide, PANEL]));

    expect(bom.issues.some((i) => i.code === 'overlap')).toBe(true);
    // Overlapping or not, the user still gets a print list.
    expect(bom.fasteners.find((l) => l.partId === 'wide')!.quantity).toBe(2);
  });

  it('sorts lines by name so output does not depend on placement order', () => {
    const zed = makePart({ id: 'zed', name: 'Aardvark hook' });
    const abe = makePart({ id: 'abe', name: 'Zebra bin' });
    const doc = makeDoc({ items: [item('i1', 'abe', 0, 0), item('i2', 'zed', 1, 0)] });
    const bom = computeBom(doc, makeCatalog([abe, zed]));

    expect(bom.printed.map((l) => l.name)).toEqual(['Aardvark hook', 'Zebra bin']);
  });

  it('does not mutate the document or the catalogue', () => {
    const shelf = makePart({
      ...SHELF,
      requires: [{ partId: 'clip', count: 2 }],
      hardware: [{ item: 'M4 screw', count: 2 }],
    });
    const doc = deepFreeze(
      makeDoc({
        panels: [panel('p1', 'panel3', 0, 0, 3, 3)],
        items: [...repeat('shelf', 2), item('far', 'shelf', 40, 40)],
      }),
    );
    const catalog = deepFreeze(makeCatalog([shelf, CLIP, PANEL]));
    const docBefore = JSON.stringify(doc);
    const catalogBefore = JSON.stringify(catalog);

    expect(() => computeBom(doc, catalog)).not.toThrow();

    expect(JSON.stringify(doc)).toBe(docBefore);
    expect(JSON.stringify(catalog)).toBe(catalogBefore);
  });
});
