import { describe, it, expect } from 'vitest';

import {
  solveTiling,
  seamCells,
  crossesSeam,
  panelKey,
  type PanelSize,
  type TilingRequest,
  type TiledPanel,
} from '../src/core/tiling';
import { hexKey, panelCells, cellsBoundsMm } from '../src/core/hex';
import { PITCH, ROW_STEP, MARGIN_X, MARGIN_Y, BEDS } from '../src/core/constants';
import type { Hex } from '../src/core/types';

/**
 * The seven shipped panels, verbatim from build/panel_sizes.json — measured sizes,
 * not the closed form (D5). `columns`/`rows` and `widthMm`/`heightMm` are carried
 * exactly as the scan reported them, including the flat-drawn ones where the two
 * disagree about which way round the panel is; sorting that out is the solver's job.
 */
const SHIPPED: PanelSize[] = [
  { partId: 'wall-honeycomb-part', columns: 7, rows: 8, widthMm: 177.0, heightMm: 170.3183 },
  { partId: 'wall-honeycomb-106x89', columns: 4, rows: 4, widthMm: 88.5655, heightMm: 106.2 },
  { partId: 'wall-honeycomb-mk3s', columns: 9, rows: 9, widthMm: 224.2, heightMm: 190.7565 },
  { partId: 'wall-honeycomb-big', columns: 14, rows: 11, widthMm: 292.9475, heightMm: 271.4 },
  { partId: 'wall-honeycomb-bambu', columns: 10, rows: 10, widthMm: 247.8, heightMm: 211.1947 },
  { partId: 'wall-honeycomb-k1', columns: 10, rows: 8, widthMm: 211.1947, heightMm: 200.6 },
  { partId: 'wall-honeycomb-375x389', columns: 18, rows: 16, widthMm: 374.7003, heightMm: 389.4 },
];

const cellsOf = (p: TiledPanel): Hex[] => panelCells(p.origin, p.columns, p.rows);

/** Every cell of every panel, as keys. Duplicates survive — that is the point. */
const allCellKeys = (panels: readonly TiledPanel[]): string[] =>
  panels.flatMap((p) => cellsOf(p).map(hexKey));

const request = (
  widthMm: number,
  heightMm: number,
  overrides: Partial<TilingRequest> = {},
): TilingRequest => ({
  wall: { widthMm, heightMm },
  bedId: 'bed256',
  available: SHIPPED,
  ...overrides,
});

describe('solveTiling — a real wall', () => {
  const result = solveTiling(request(2400, 1200));

  it('places panels', () => {
    expect(result.panels.length).toBeGreaterThan(0);
    expect(result.warnings).not.toContain(
      'Unknown bed id "bed256" — no panel can be checked for printability.',
    );
  });

  it('never lets two panels share a cell', () => {
    const keys = allCellKeys(result.panels);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('reports cellCount as the true number of occupied cells', () => {
    expect(result.cellCount).toBe(new Set(allCellKeys(result.panels)).size);
    expect(result.cellCount).toBe(
      result.panels.reduce((n, p) => n + p.columns * p.rows, 0),
    );
  });

  it('covers more than 85% of the wall', () => {
    expect(result.coverage).toBeGreaterThan(0.85);
    expect(result.coverage).toBeLessThanOrEqual(1);
  });

  it('only uses panels that fit the chosen bed, in some orientation', () => {
    const bed = BEDS.find((b) => b.id === 'bed256');
    expect(bed).toBeDefined();
    const byId = new Map(SHIPPED.map((p) => [p.partId, p]));
    for (const placed of result.panels) {
      const size = byId.get(placed.partId);
      expect(size).toBeDefined();
      if (size === undefined || bed === undefined) continue;
      const asDrawn = size.widthMm <= bed.width && size.heightMm <= bed.depth;
      const spun = size.heightMm <= bed.width && size.widthMm <= bed.depth;
      expect(asDrawn || spun).toBe(true);
    }
  });

  it('keeps every panel inside the wall rectangle', () => {
    for (const p of result.panels) {
      const b = cellsBoundsMm(cellsOf(p));
      // The lattice is anchored so the bottom-left panel's outline starts at (0, 0).
      expect(b.minX + MARGIN_X).toBeGreaterThanOrEqual(-1e-9);
      expect(b.minY + MARGIN_Y).toBeGreaterThanOrEqual(-1e-9);
      expect(b.maxX + MARGIN_X).toBeLessThanOrEqual(2400 + 1e-9);
      expect(b.maxY + MARGIN_Y).toBeLessThanOrEqual(1200 + 1e-9);
    }
  });

  it('leaves less than one cell of slack it could have filled', () => {
    expect(result.unusedMm.right).toBeGreaterThanOrEqual(0);
    expect(result.unusedMm.top).toBeGreaterThanOrEqual(0);
    // Whatever is left over is narrower than the smallest panel that fits the bed
    // (4 columns × 4 rows), or the greedy would have kept going.
    expect(result.unusedMm.right).toBeLessThan(4 * PITCH);
    expect(result.unusedMm.top).toBeLessThan(4 * ROW_STEP);
  });

  it('prefers few large panels over many small ones', () => {
    // 25 of the 4×4 panel would cover the same band as 10 of the 10×10.
    const smallest = result.panels.filter((p) => p.columns * p.rows <= 16);
    expect(smallest.length).toBe(0);
  });
});

describe('solveTiling — degenerate walls', () => {
  it('handles a tiny wall without crashing', () => {
    const result = solveTiling(request(200, 200));
    expect(result.panels.length).toBeGreaterThanOrEqual(1);
    const keys = allCellKeys(result.panels);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('returns zero panels and a warning when the wall is smaller than any panel', () => {
    const result = solveTiling(request(50, 50));
    expect(result.panels).toEqual([]);
    expect(result.cellCount).toBe(0);
    expect(result.coverage).toBe(0);
    expect(result.seams).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('does not throw on zero or negative dimensions', () => {
    for (const [w, h] of [
      [0, 0],
      [0, 1200],
      [2400, 0],
      [-2400, 1200],
      [2400, -1200],
      [-1, -1],
      [Number.NaN, 100],
      [Number.POSITIVE_INFINITY, 100],
    ] as Array<[number, number]>) {
      const result = solveTiling(request(w, h));
      expect(result.panels).toEqual([]);
      expect(result.cellCount).toBe(0);
      expect(result.coverage).toBe(0);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.unusedMm.right).toBeGreaterThanOrEqual(0);
      expect(result.unusedMm.top).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns zero panels and a warning for an unknown bed', () => {
    const result = solveTiling(request(2400, 1200, { bedId: 'no-such-bed' }));
    expect(result.panels).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('drops the panels that will not fit a small bed, and says so', () => {
    const result = solveTiling(request(2400, 1200, { bedId: 'mini' }));
    // A 180 × 180 bed takes only 177.0 × 170.3 and 88.6 × 106.2; five are too big.
    expect(result.warnings.some((w) => w.includes('mini'))).toBe(true);
    const printable = new Set(['wall-honeycomb-part', 'wall-honeycomb-106x89']);
    for (const p of result.panels) expect(printable.has(p.partId)).toBe(true);
    expect(result.panels.length).toBeGreaterThan(0);
  });

  it('warns rather than throws when nothing at all fits the bed', () => {
    const result = solveTiling(
      request(2400, 1200, {
        bedId: 'mini',
        available: [
          { partId: 'wall-honeycomb-375x389', columns: 18, rows: 16, widthMm: 374.7003, heightMm: 389.4 },
        ],
      }),
    );
    expect(result.panels).toEqual([]);
    expect(result.cellCount).toBe(0);
    expect(result.warnings.some((w) => w.includes('mini'))).toBe(true);
  });

  it('ignores malformed panel sizes instead of placing them', () => {
    const result = solveTiling(
      request(2400, 1200, {
        available: [
          { partId: 'bad-cols', columns: 0, rows: 4, widthMm: 100, heightMm: 100 },
          { partId: 'bad-frac', columns: 3.5, rows: 4, widthMm: 100, heightMm: 100 },
          { partId: 'bad-mm', columns: 4, rows: 4, widthMm: 0, heightMm: 100 },
          ...SHIPPED,
        ],
      }),
    );
    expect(result.panels.some((p) => p.partId.startsWith('bad-'))).toBe(false);
    expect(result.warnings.some((w) => w.includes('non-integer'))).toBe(true);
  });
});

describe('solveTiling — rotation', () => {
  it('uses the rotated footprint when that is what suits the wall', () => {
    // 10 columns × 8 rows only exists as the 90° spin of the 8 × 10 panel.
    //
    // Drawn TALLER than it is wide, deliberately. Bands run vertically on the
    // flat-top wall (D35) and `fillBand` packs each band by `rows`, so the
    // variant that leaves less unused height wins — which is the one with the
    // FEWER rows. A panel drawn wider than tall is therefore already the better
    // of its two forms and rotation has nothing to offer it. Before the turn the
    // same argument ran along the other axis and picked the opposite variant.
    const available: PanelSize[] = [
      { partId: 'wall-honeycomb-k1', columns: 8, rows: 10, widthMm: 200.6, heightMm: 211.1947 },
    ];
    const rotated = solveTiling(request(2400, 1200, { available, allowRotation: true }));
    const fixed = solveTiling(request(2400, 1200, { available, allowRotation: false }));

    expect(rotated.panels.some((p) => p.columns === 10 && p.rows === 8)).toBe(true);
    expect(fixed.panels.every((p) => p.columns === 8 && p.rows === 10)).toBe(true);
  });

  it('rejects a panel whose bed footprint only fits when spun, if rotation is off', () => {
    // 250 × 210: fits the MK3S bed as drawn, not the other way round.
    const available: PanelSize[] = [
      { partId: 'tall', columns: 9, rows: 9, widthMm: 190.7565, heightMm: 224.2 },
    ];
    const off = solveTiling(request(2400, 1200, { available, bedId: 'mk3s', allowRotation: false }));
    const on = solveTiling(request(2400, 1200, { available, bedId: 'mk3s', allowRotation: true }));
    expect(off.panels).toEqual([]);
    expect(on.panels.length).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('gives deeply equal results for the same request', () => {
    const req = request(2400, 1200);
    const before = JSON.stringify(req);
    const a = solveTiling(req);
    const b = solveTiling(req);
    expect(a).toEqual(b);
    expect(JSON.stringify(req)).toBe(before);
  });

  it('does not depend on the order of `available`', () => {
    const a = solveTiling(request(2400, 1200));
    const b = solveTiling(request(2400, 1200, { available: [...SHIPPED].reverse() }));
    expect(a.panels).toEqual(b.panels);
    expect(a.cellCount).toBe(b.cellCount);
  });

  it('gives deeply equal results for a partial wall too', () => {
    const req = request(613, 447, { bedId: 'bed300' });
    expect(solveTiling(req)).toEqual(solveTiling(req));
  });
});

describe('seams', () => {
  /**
   * Two 4 × 4 panels side by side, and a third stacked on the left one. The third
   * origin is q = −2 because a band starting at row 4 carries the lattice's
   * −floor(r/2) shear; see the note in tiling.ts.
   */
  const A: TiledPanel = { partId: 'p', origin: { q: 0, r: 0 }, columns: 4, rows: 4 };
  const B: TiledPanel = { partId: 'p', origin: { q: 4, r: 0 }, columns: 4, rows: 4 };
  const C: TiledPanel = { partId: 'p', origin: { q: -2, r: 4 }, columns: 4, rows: 4 };
  const layout = [A, B, C];

  it('gives each placed panel a distinct key', () => {
    expect(new Set(layout.map(panelKey)).size).toBe(layout.length);
  });

  it('finds the seams between adjacent panels', () => {
    const seams = seamCells(layout);
    expect(seams.length).toBeGreaterThan(0);
    for (const seam of seams) {
      expect(seam.a < seam.b).toBe(true);
      const members = new Set(
        layout
          .filter((p) => panelKey(p) === seam.a || panelKey(p) === seam.b)
          .flatMap((p) => cellsOf(p).map(hexKey)),
      );
      for (const c of seam.cells) expect(members.has(hexKey(c))).toBe(true);
      expect(seam.cells.length).toBeGreaterThan(0);
    }
  });

  it('lists seam cells in a stable order', () => {
    expect(seamCells(layout)).toEqual(seamCells(layout));
    expect(seamCells([...layout].reverse())).toEqual(seamCells(layout));
  });

  it('is true for a footprint straddling two panels side by side', () => {
    expect(crossesSeam([{ q: 3, r: 0 }, { q: 4, r: 0 }], layout)).toBe(true);
  });

  it('is true for a footprint straddling two stacked panels', () => {
    // (0, 3) is in A's top row; (0, 4) is in C's bottom row.
    expect(crossesSeam([{ q: 0, r: 3 }, { q: 0, r: 4 }], layout)).toBe(true);
  });

  it('is false for a footprint wholly inside one panel', () => {
    expect(crossesSeam([{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 0, r: 1 }], layout)).toBe(false);
    expect(crossesSeam([{ q: 4, r: 0 }, { q: 5, r: 0 }], layout)).toBe(false);
    expect(crossesSeam([{ q: 0, r: 0 }], layout)).toBe(false);
  });

  it('is false for an empty footprint and for cells on no panel at all', () => {
    expect(crossesSeam([], layout)).toBe(false);
    expect(crossesSeam([{ q: 900, r: 900 }, { q: 901, r: 900 }], layout)).toBe(false);
    // One cell on a panel, one out in space, is off-panel — not a seam crossing.
    expect(crossesSeam([{ q: 0, r: 0 }, { q: 900, r: 900 }], layout)).toBe(false);
  });

  it('agrees with the seams a real solve reports', () => {
    const result = solveTiling(request(2400, 1200));
    expect(result.seams.length).toBeGreaterThan(0);
    expect(result.seams).toEqual(seamCells(result.panels));

    const seam = result.seams[0];
    expect(seam).toBeDefined();
    if (seam === undefined) return;

    const left = result.panels.find((p) => panelKey(p) === seam.a);
    const right = result.panels.find((p) => panelKey(p) === seam.b);
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    if (left === undefined || right === undefined) return;

    const leftKeys = new Set(cellsOf(left).map(hexKey));
    const rightKeys = new Set(cellsOf(right).map(hexKey));
    const fromLeft = seam.cells.find((c) => leftKeys.has(hexKey(c)));
    const fromRight = seam.cells.find((c) => rightKeys.has(hexKey(c)));
    expect(fromLeft).toBeDefined();
    expect(fromRight).toBeDefined();
    if (fromLeft === undefined || fromRight === undefined) return;

    expect(crossesSeam([fromLeft, fromRight], result.panels)).toBe(true);
    expect(crossesSeam([fromLeft], result.panels)).toBe(false);
    expect(crossesSeam(cellsOf(left), result.panels)).toBe(false);
  });

  it('has no seams to report for a single panel', () => {
    expect(seamCells([A])).toEqual([]);
    expect(seamCells([])).toEqual([]);
  });
});
