/**
 * The OUTSIDE of the plate, measured on the mesh.
 *
 * `tests/zone-aperture.test.ts` does this for the edge round a blocked zone and
 * says why: every proxy for "how thick is the wall here" — border polygons, cell
 * centres, bounding boxes — let the wall be 0.00 mm somewhere while the suite
 * stayed green. The plate's own rim is the same question and had no such test at
 * all; every border test measured the bounding BOX, which cannot tell a `t` band
 * from a `t` band with a whole extra column of solid plastic behind it.
 *
 * It could not, and there was: the outer ring of positions was drawn SOLID and
 * clipped to the straight line, so between two cells of the outermost column —
 * where their flats meet and there is no hole — the plate ran 26.7 mm deep
 * before the first opening. That is a whole cell of material more than the
 * border asked for, and it is what "the border looks chunky" kept meaning.
 *
 * Stated as a bound rather than an equality, because a band is honestly uneven:
 * it is `t` where a scanline crosses a bore and thicker where it crosses the web
 * between two, exactly as the aperture's wall is. What it must never be is
 * deeper than the cell it stands on — `MARGIN + t`, one cell's own reach plus
 * the edge that was asked for.
 */

import { describe, expect, it } from 'vitest';

import { MARGIN_X, MARGIN_Y } from '../src/core/constants';
import { hexKey, hexToMm, panelCells } from '../src/core/hex';
import {
  buildHoneycombMesh, cellCentreBounds, DEFAULT_BORDER_MM, MAX_BORDER_MM,
  meshBoundsMm, MIN_BORDER_MM,
  type BorderSpec, type FrameSides,
} from '../src/core/honeycomb';
import type { Hex } from '../src/core/types';

const ALL: FrameSides = { left: true, right: true, bottom: true, top: true };

const borderOver = (cells: readonly Hex[], t: number): BorderSpec => ({
  thicknessMm: t,
  occupied: new Set(cells.map(hexKey)),
  sides: ALL,
  holes: true,
  bounds: cellCentreBounds(cells),
});

interface Seg { ax: number; ay: number; bx: number; by: number }

/** The plate's own cross-section at height `z`: every triangle cut at one plane. */
function sliceAt(positions: ArrayLike<number>, z: number): Seg[] {
  const segs: Seg[] = [];
  for (let i = 0; i < positions.length; i += 9) {
    const v = [0, 3, 6].map((o) => ({
      x: positions[i + o]!, y: positions[i + o + 1]!, z: positions[i + o + 2]!,
    }));
    const hits: { x: number; y: number }[] = [];
    for (let e = 0; e < 3; e++) {
      const a = v[e]!, b = v[(e + 1) % 3]!;
      if ((a.z - z) * (b.z - z) < 0) {
        const f = (z - a.z) / (b.z - a.z);
        hits.push({ x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) });
      }
    }
    if (hits.length === 2) {
      segs.push({ ax: hits[0]!.x, ay: hits[0]!.y, bx: hits[1]!.x, by: hits[1]!.y });
    }
  }
  return segs;
}

/** Solid runs where the line `along = at` crosses the section. */
function runs(segs: readonly Seg[], axis: 'x' | 'y', at: number): [number, number][] {
  const hits: number[] = [];
  for (const s of segs) {
    const [a0, b0, a1, b1] = axis === 'x'
      ? [s.ay, s.by, s.ax, s.bx]
      : [s.ax, s.bx, s.ay, s.by];
    if ((a0 - at) * (b0 - at) < 0) hits.push(a1 + ((at - a0) / (b0 - a0)) * (b1 - a1));
  }
  hits.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i]!, hits[i + 1]!]);
  return out;
}

/**
 * The band on each side: the solid run between the plate's outer edge and the
 * first opening behind it, at its worst along the whole run.
 *
 * Two things about the sampling, both of which cost a wrong answer first.
 *
 * The scanlines are ANCHORED ON CELL CENTRES and swept across one cell's own
 * span, rather than stepped across the bounding box. A scanline landing on a
 * hexagon's flat or through its corner vertex registers no crossing there —
 * `(a - at) * (b - at) < 0` is false when an endpoint is exactly on the line —
 * so two runs merge and the band reads as most of the plate. Stepped blind from
 * the bounding box that happens somewhere on every plate: it reported 274 mm on
 * a 12 × 11.
 *
 * And the CORNER cells are left out. A corner is where two bands meet, so a
 * scanline there crosses the perpendicular one and measures both at once. The
 * bands' evenness is a statement about the straight runs; what happens at a
 * corner is a separate question with its own tests.
 */
function bandWidths(cols: number, rows: number, t: number) {
  const cells = panelCells({ q: 0, r: 0 }, cols, rows);
  const mesh = buildHoneycombMesh({ cells, border: borderOver(cells, t), originAtZero: false });
  const segs = sliceAt(mesh.positions, 0.2);
  const b = cellCentreBounds(cells);

  const worst = { left: 0, right: 0, bottom: 0, top: 0 };
  const thinnest = { left: Infinity, right: Infinity, bottom: Infinity, top: Infinity };
  const at = { left: 0, right: 0, bottom: 0, top: 0 };
  const on = (v: number, edge: number) => Math.abs(v - edge) < 1e-6;
  const centres = cells.map(hexToMm);
  const isCorner = (m: { x: number; y: number }) =>
    (on(m.x, b.minX) || on(m.x, b.maxX)) && (on(m.y, b.minY) || on(m.y, b.maxY));

  const take = (side: keyof typeof worst, v: number, where: number) => {
    if (v > worst[side]) { worst[side] = v; at[side] = where; }
    if (v < thinnest[side]) thinnest[side] = v;
  };

  for (const c of centres.filter((m) => !isCorner(m))) {
    // A scanline with no hole in it is not measuring a band — it is the plate's
    // solid rim seen end-on, past where the outermost cell reaches.
    if (on(c.x, b.minX) || on(c.x, b.maxX)) {
      for (let y = c.y - MARGIN_Y + 0.37; y < c.y + MARGIN_Y; y += 0.37) {
        const iv = runs(segs, 'x', y);
        if (iv.length < 2) continue;
        if (on(c.x, b.minX)) take('left', iv[0]![1] - iv[0]![0], y);
        else take('right', iv[iv.length - 1]![1] - iv[iv.length - 1]![0], y);
      }
    }
    if (on(c.y, b.minY) || on(c.y, b.maxY)) {
      for (let x = c.x - MARGIN_X + 0.37; x < c.x + MARGIN_X; x += 0.37) {
        const iv = runs(segs, 'y', x);
        if (iv.length < 2) continue;
        if (on(c.y, b.minY)) take('bottom', iv[0]![1] - iv[0]![0], x);
        else take('top', iv[iv.length - 1]![1] - iv[iv.length - 1]![0], x);
      }
    }
  }
  return { worst, thinnest, at };
}

describe('the band round the plate', () => {
  it('is never deeper than the cell it stands on plus the edge asked for', () => {
    /*
     * The bound is per axis because the lattice is: a cell reaches `MARGIN_X` to
     * its left and right (its corner) and `MARGIN_Y` up and down (its flat), so
     * the deepest honest band on each side is that reach plus `t`.
     *
     * Swept over sizes because every failure in this file's subject matter has
     * been parity-dependent — one block size passes by luck.
     */
    const t = DEFAULT_BORDER_MM;
    for (const [cols, rows] of [[4, 4], [6, 5], [8, 7], [12, 11]]) {
      const { worst, at } = bandWidths(cols!, rows!, t);
      const where = (s: keyof typeof worst) =>
        `${cols}x${rows} ${s}: ${worst[s].toFixed(2)} mm at ${at[s].toFixed(2)}`;
      for (const s of ['left', 'right'] as const) {
        expect(worst[s], where(s)).toBeGreaterThan(0);
        expect(worst[s], where(s)).toBeLessThanOrEqual(MARGIN_X + t + 1e-6);
      }
      for (const s of ['bottom', 'top'] as const) {
        expect(worst[s], where(s)).toBeGreaterThan(0);
        expect(worst[s], where(s)).toBeLessThanOrEqual(MARGIN_Y + t + 1e-6);
      }
    }
  });

  it('is exactly the thickness asked for at its thinnest, on every side', () => {
    /*
     * The other half, and the reason the bound above cannot be met by deleting
     * material: the rim still has to close the plate. Stated as an EQUALITY
     * because it is one — the outline is cut on the cell-centre line and every
     * bore `t` inside it, so wherever a scanline crosses a bore the plate
     * between it and the edge is `t` to the bit. Thicker elsewhere is material
     * that was always in the web; thinner is a bore opened onto the outside.
     *
     * Swept across the whole legal range rather than at the default, because a
     * rim that ignored `t` would satisfy the bound above and be wrong
     * everywhere. It held at 0.4 and at 6.8 while the plate's own size never
     * moved, which is the point: `t` is the wall now, not how far the plate
     * sticks out.
     */
    for (const t of [MIN_BORDER_MM, 1, DEFAULT_BORDER_MM, 5, MAX_BORDER_MM]) {
      const { thinnest } = bandWidths(8, 7, t);
      for (const side of ['left', 'right', 'bottom', 'top'] as const) {
        expect(thinnest[side], `${side} t=${t}`).toBeCloseTo(t, 9);
      }
    }
  });

  it('puts the plate on the outermost cell centres exactly — hexagons up to the line', () => {
    /*
     * Where the straight line falls, which is the whole difference between this
     * and every border before it.
     *
     * The edge used to be `bounds + t`: material ADDED past the honeycomb, so
     * the plate's size moved with the thickness and the outermost cells stayed
     * whole. It could not come out straight, because the honeycomb's own
     * silhouette only reaches `bounds` — the outermost column is half a pitch
     * shorter than its neighbour and two cells in a column meet at a flat
     * `MARGIN_X − PITCH/2` short of their corners. Everything past that line had
     * to be invented, and every attempt (rail, fill, corner piece) was a
     * different guess at the same missing material.
     *
     * On the line there is nothing to invent: the cells cover it at every point
     * on all four sides, so the cut IS the plate and the corners are square.
     * Held to 1e-9, not a tolerance — the clip plane and the bound are the same
     * number.
     */
    for (const [cols, rows] of [[4, 4], [6, 5], [5, 9], [8, 7], [12, 11]]) {
      for (const t of [1, DEFAULT_BORDER_MM, MAX_BORDER_MM]) {
        const cells = panelCells({ q: 0, r: 0 }, cols!, rows!);
        const b = cellCentreBounds(cells);
        const box = meshBoundsMm(
          buildHoneycombMesh({ cells, border: borderOver(cells, t), originAtZero: false }),
        );
        const at = `${cols}x${rows} t=${t}`;
        expect(box.min[0]!, `left ${at}`).toBeCloseTo(b.minX, 9);
        expect(box.max[0]!, `right ${at}`).toBeCloseTo(b.maxX, 9);
        expect(box.min[1]!, `bottom ${at}`).toBeCloseTo(b.minY, 9);
        expect(box.max[1]!, `top ${at}`).toBeCloseTo(b.maxY, 9);
      }
    }
  });
});
