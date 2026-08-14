/**
 * Plate size against the printer, and against the plates that were printed.
 *
 * The app now sizes plates itself, so `plateFootprintMm` decides what goes on a
 * bed. That arithmetic is checked against the SHIPPED files rather than against
 * itself: `wall-honeycomb-part` is 8 × 7 and measures 170.3171 × 177.0, so if
 * the formula agrees with all seven it is the same formula the designer used.
 *
 * The bed cases matter because the failure is quiet in both directions — too
 * generous and you print a plate that will not fit; too mean and you get more
 * seams than you need for no reason you can see.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { BEDS, MARGIN_X, PITCH, ROW_STEP } from '../src/core/constants';
import { cellsBoundsMm, placedPanelCells } from '../src/core/hex';
import {
  generatedPlateSizes, generatedSizeId, maxPlateForBed, plateFootprintMm, solveTiling,
} from '../src/core/tiling';
import type { Catalog } from '../src/core/types';

const catalog = catalogJson as unknown as Catalog;
const panels = catalog.parts.filter((p) => p.type === 'panel' && p.panel);

describe('the printed size of a block', () => {
  it('reproduces every shipped plate from its cell count alone', () => {
    expect(panels.length).toBe(7);
    for (const part of panels) {
      const p = part.panel!;
      const mine = plateFootprintMm(p.columns, p.rows);
      // The catalogue's bbox is in the FILE's frame and four of the seven are
      // drawn 90° round, so compare the sorted pair.
      const a = [mine.widthMm, mine.heightMm].sort((x, y) => x - y);
      const b = [part.bboxMm[0], part.bboxMm[1]].sort((x, y) => x - y);
      expect(a[0]!, part.id).toBeCloseTo(b[0]!, 2);
      expect(a[1]!, part.id).toBeCloseTo(b[1]!, 2);
    }
  });

  it('grows by exactly the border on each side', () => {
    const bare = plateFootprintMm(6, 5);
    const edged = plateFootprintMm(6, 5, 3);
    expect(edged.widthMm - bare.widthMm).toBeCloseTo(6, 9);
    expect(edged.heightMm - bare.heightMm).toBeCloseTo(6, 9);
  });
});

describe('the biggest plate a bed can take', () => {
  it('actually fits, and one more cell would not', () => {
    // The only thing that matters, stated for every bed the app offers.
    for (const bed of BEDS) {
      const max = maxPlateForBed(bed);
      const fits = plateFootprintMm(max.columns, max.rows);
      expect(fits.widthMm, bed.id).toBeLessThanOrEqual(bed.width + 1e-9);
      expect(fits.heightMm, bed.id).toBeLessThanOrEqual(bed.depth + 1e-9);
      expect(plateFootprintMm(max.columns + 1, max.rows).widthMm, bed.id)
        .toBeGreaterThan(bed.width);
      expect(plateFootprintMm(max.columns, max.rows + 1).heightMm, bed.id)
        .toBeGreaterThan(bed.depth);
    }
  });

  it('gives the Prusa Mini exactly the shipped 8 × 7 plate', () => {
    // A real cross-check rather than a tautology: the smallest listed bed is
    // 180 × 180, and the designer's own smallest full plate is 8 × 7. The
    // formula finding the same answer is evidence it is the designer's.
    const mini = BEDS.find((b) => b.id === 'mini')!;
    expect(maxPlateForBed(mini)).toEqual({ columns: 8, rows: 7 });
  });

  it('gets bigger with a bigger printer and smaller with a smaller one', () => {
    // The user-visible promise, as an ordering over every bed.
    const byArea = BEDS.map((b) => ({
      id: b.id,
      bed: b.width * b.depth,
      cells: (({ columns, rows }) => columns * rows)(maxPlateForBed(b)),
    })).sort((a, b) => a.bed - b.bed);
    for (let i = 1; i < byArea.length; i++) {
      expect(byArea[i]!.cells, `${byArea[i]!.id} vs ${byArea[i - 1]!.id}`)
        .toBeGreaterThanOrEqual(byArea[i - 1]!.cells);
    }
    expect(byArea[byArea.length - 1]!.cells).toBeGreaterThan(byArea[0]!.cells);
  });

  it('leaves room for the border, so a bordered plate still fits', () => {
    for (const bed of BEDS) {
      const max = maxPlateForBed(bed, 3);
      const fits = plateFootprintMm(max.columns, max.rows, 3);
      expect(fits.widthMm, bed.id).toBeLessThanOrEqual(bed.width + 1e-9);
      expect(fits.heightMm, bed.id).toBeLessThanOrEqual(bed.depth + 1e-9);
    }
    // ...and asking for a border costs you cells, which it must, or the border
    // would be free and the plate would not fit.
    const big = BEDS.find((b) => b.id === 'bed350')!;
    const bare = maxPlateForBed(big);
    const edged = maxPlateForBed(big, 6);
    expect(edged.columns * edged.rows).toBeLessThan(bare.columns * bare.rows);
  });
});

describe('the candidate sizes it offers the solver', () => {
  it('offers the biggest first, and every one of them fits', () => {
    const sizes = generatedPlateSizes('bed256');
    expect(sizes.length).toBeGreaterThan(1);
    const bed = BEDS.find((b) => b.id === 'bed256')!;
    for (const s of sizes) {
      expect(s.widthMm).toBeLessThanOrEqual(bed.width + 1e-9);
      expect(s.heightMm).toBeLessThanOrEqual(bed.depth + 1e-9);
      expect(s.partId).toBe(generatedSizeId(s.columns, s.rows));
    }
    const first = sizes[0]!;
    expect(first.columns * first.rows).toBe(
      (({ columns, rows }) => columns * rows)(maxPlateForBed(bed)),
    );
  });

  it('offers smaller sizes too, or the edges of a wall cannot be filled', () => {
    const sizes = generatedPlateSizes('bed256');
    expect(sizes.some((s) => s.columns === 1)).toBe(true);
    expect(sizes.some((s) => s.rows === 1)).toBe(true);
  });

  it('says nothing at all for a bed it does not know', () => {
    expect(generatedPlateSizes('no-such-bed')).toEqual([]);
  });

  it('stays bounded, so the solver does not choke on a big bed', () => {
    for (const bed of BEDS) expect(generatedPlateSizes(bed.id).length).toBeLessThanOrEqual(120);
  });
});

describe('the lattice constants it rests on', () => {
  it('uses the measured ROW_STEP, not the closed form', () => {
    // A 13-column plate is 0.0024 mm out if anyone "simplifies" this to
    // PITCH·√3/2, which is exactly the drift that stops plates lining up (D4).
    expect(plateFootprintMm(13, 1).widthMm).toBeCloseTo(12 * ROW_STEP + 2 * MARGIN_X, 9);
    expect(plateFootprintMm(1, 13).heightMm).toBeCloseTo(PITCH * 13.5, 9);
  });
});

describe('solving a real wall with plates sized to the printer', () => {
  /** The same wall on every bed the app offers. */
  const solveOn = (bedId: string) =>
    solveTiling({
      wall: { widthMm: 1400, heightMm: 1000 },
      bedId,
      available: generatedPlateSizes(bedId),
      allowRotation: false,
    });

  it('gives a bigger printer fewer, larger plates for the same wall', () => {
    // The user-visible promise, end to end rather than as arithmetic: pick a
    // bigger printer and the parts get bigger; pick a smaller one and they get
    // smaller. Asserted as an ORDERING over the real beds, so it cannot be
    // satisfied by a lucky pair.
    const byBed = BEDS.map((b) => {
      const res = solveOn(b.id);
      return {
        id: b.id,
        area: b.width * b.depth,
        biggest: Math.max(0, ...res.panels.map((p) => p.columns * p.rows)),
        panels: res.panels.length,
        coverage: res.coverage,
      };
    }).sort((a, b) => a.area - b.area);

    for (let i = 1; i < byBed.length; i++) {
      const prev = byBed[i - 1]!;
      const here = byBed[i]!;
      expect(here.biggest, `${here.id} vs ${prev.id}`).toBeGreaterThanOrEqual(prev.biggest);
      expect(here.panels, `${here.id} vs ${prev.id}`).toBeLessThanOrEqual(prev.panels);
    }
    // And the range is real, not a rounding: the smallest bed prints many more
    // plates than the largest.
    expect(byBed[0]!.panels).toBeGreaterThan(byBed[byBed.length - 1]!.panels * 3);
  });

  it('covers the wall just as well whichever printer you pick', () => {
    // Bigger plates must not mean a worse fit — the point is fewer seams for the
    // same wall, not less wall.
    for (const bed of BEDS) expect(solveOn(bed.id).coverage, bed.id).toBeGreaterThan(0.9);
  });

  it('uses the biggest plate the bed can hold', () => {
    for (const bed of BEDS) {
      const max = maxPlateForBed(bed);
      const biggest = Math.max(0, ...solveOn(bed.id).panels.map((p) => p.columns * p.rows));
      expect(biggest, bed.id).toBe(max.columns * max.rows);
    }
  });

  it('stays fast enough to run on every keystroke of the wall size', () => {
    const started = Date.now();
    for (const bed of BEDS) solveOn(bed.id);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('where the honeycomb sits in the wall', () => {
  /**
   * Nothing checked this, and it was wrong the whole time.
   *
   * The solver counts columns from `ROW_STEP·q + MARGIN_X` — a lattice anchored
   * so the bottom-left plate's OUTLINE starts at x = 0 — while `hexToMm` put
   * cell (0, 0)'s CENTRE there. The honeycomb therefore hung 13.63 mm off the
   * left-hand edge of every wall, with the slack showing as a gap on the right.
   * `tests/tiling.test.ts` had `+ MARGIN_X` written into its expectation, so it
   * agreed with the intent while the app did the other thing (D63).
   *
   * Stated here against real solves, on both plate sources, with no fudge.
   */
  const walls: ReadonlyArray<readonly [number, number]> = [
    [500, 400], [700, 500], [900, 700], [1200, 900], [2400, 1200],
  ];

  const solvedBounds = (w: number, h: number, available: ReturnType<typeof generatedPlateSizes>) => {
    const res = solveTiling({
      wall: { widthMm: w, heightMm: h }, bedId: 'bed256', available, allowRotation: false,
    });
    const cells = res.panels.flatMap((p) =>
      placedPanelCells({ origin: p.origin, columns: p.columns, rows: p.rows }));
    return { bounds: cellsBoundsMm(cells), panels: res.panels.length };
  };

  const shipped = () =>
    panels.map((p) => ({
      partId: p.id,
      columns: p.panel!.columns,
      rows: p.panel!.rows,
      widthMm: p.panel!.widthMm,
      heightMm: p.panel!.heightMm,
    }));

  it('starts flush against the left-hand edge, never outside it', () => {
    for (const [w, h] of walls) {
      for (const [what, available] of [
        ['shipped', shipped()], ['fit to printer', generatedPlateSizes('bed256')],
      ] as const) {
        const { bounds, panels: n } = solvedBounds(w, h, available);
        expect(n, `${w}×${h} ${what}`).toBeGreaterThan(0);
        expect(bounds.minX, `${w}×${h} ${what} left edge`).toBeCloseTo(0, 6);
      }
    }
  });

  it('never runs off any edge of the wall', () => {
    // The other half, and the reason the anchor is X-only: putting it on Y as
    // well pushed the top row 8.6 mm past the top of a 1200 × 900 wall.
    for (const [w, h] of walls) {
      for (const [what, available] of [
        ['shipped', shipped()], ['fit to printer', generatedPlateSizes('bed256')],
      ] as const) {
        const { bounds } = solvedBounds(w, h, available);
        expect(bounds.minX, `${w}×${h} ${what}`).toBeGreaterThanOrEqual(-1e-6);
        expect(bounds.minY, `${w}×${h} ${what}`).toBeGreaterThanOrEqual(-1e-6);
        expect(bounds.maxX, `${w}×${h} ${what}`).toBeLessThanOrEqual(w + 1e-6);
        expect(bounds.maxY, `${w}×${h} ${what}`).toBeLessThanOrEqual(h + 1e-6);
      }
    }
  });

  it('leaves less than a cell unused on the left, whatever the wall', () => {
    // A gap smaller than one cell cannot be filled and is honest slack. A gap
    // BIGGER than a cell means the solver stopped early — which is what the
    // right-hand edge used to show, because the left was overhanging.
    for (const [w, h] of walls) {
      const { bounds } = solvedBounds(w, h, generatedPlateSizes('bed256'));
      expect(bounds.minX, `${w}×${h}`).toBeLessThan(2 * MARGIN_X);
    }
  });
});
