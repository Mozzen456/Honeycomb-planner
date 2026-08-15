/*
 * The aperture round a blocked zone opens on the zone RECTANGLE, on a real wall.
 *
 * D81/D83 say the cells a zone eats are printed CUT, so the aperture is the
 * rectangle exactly and the plate reaches it on every side. The failure this
 * file was written for was the opposite: some zone edges came out cut dead
 * straight with whole hexagons beside them and others stepped, which for a
 * rectangle cannot both be a cut — one of them was a cell removed WHOLE, the
 * apron D81 exists to prevent.
 *
 * The cause was `px`/`py` in `clipPlanesFor` being chosen from where a cell's
 * CENTRE sits rather than from where its MATERIAL does. A cell whose centre
 * landed 0.04 mm inside the zone's x range but outside it in y got no x plane,
 * so it was cut on y alone and the 13.6 mm of plate it still had past the
 * zone's x edge was discarded — a whole quadrant, leaving a hexagonal hole in
 * the aperture wall. Measured before the fix, on this wall: 13.41, 13.45 and
 * 13.38 mm on one side of each of the three zones, and 0.00 on every other.
 *
 * Measured on the MESH, sliced in the mouth band (z 0.0-2.0 since D97) and
 * scanned, because every proxy for this — border polygons, cell centres,
 * bounding boxes — is what let the wall be 0.00 mm somewhere while the suite
 * stayed green.
 *
 * The wall is the one exported from the app: 2400 x 1200, a 256 bed, a border
 * on all four sides, and three zones, one of which runs off the top.
 */
import { describe, expect, it } from 'vitest';

import { buildHoneycombMesh } from '../src/core/honeycomb';
import { panelModelSpecFor } from '../src/core/panelModel';
import { deserialize } from '../src/core/persist';
import type { LayoutDoc, Obstacle, PlacedPanel } from '../src/core/types';

import WALL from './fixtures/supahwall.json';

const SIDES = ['left', 'right', 'bottom', 'top'] as const;
type Side = typeof SIDES[number];

interface Seg { ax: number; ay: number; bx: number; by: number }

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

/** Solid runs where the line `along = at` crosses ONE plate's section. */
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
 * The runs across the whole assembly, per plate then merged.
 *
 * Never by pooling the sections: plates INTERLOCK, so a ray crosses a shared
 * stretch twice at one x and the even-odd parity never flips. Each plate is
 * counted on its own and the intervals are unioned afterwards.
 */
function assemblyRuns(
  sections: readonly Seg[][], axis: 'x' | 'y', at: number,
): [number, number][] {
  const all: [number, number][] = [];
  for (const segs of sections) all.push(...runs(segs, axis, at));
  all.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const iv of all) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/**
 * How far the plate stops SHORT of each side of the zone, per scanline, in
 * scanline order. Zero all the way along is the whole point.
 */
function apron(sections: readonly Seg[][], zone: Obstacle, step: number) {
  const x0 = zone.xMm, x1 = zone.xMm + zone.widthMm;
  const y0 = zone.yMm, y1 = zone.yMm + zone.heightMm;
  const gaps: Record<Side, number[]> = { left: [], right: [], bottom: [], top: [] };

  for (let y = y0 + step; y < y1; y += step) {
    const iv = assemblyRuns(sections, 'x', y);
    const l = iv.filter((s) => s[1] <= x0 + 1e-6).pop();
    const r = iv.find((s) => s[0] >= x1 - 1e-6);
    if (l) gaps.left.push(x0 - l[1]);
    if (r) gaps.right.push(r[0] - x1);
  }
  for (let x = x0 + step; x < x1; x += step) {
    const iv = assemblyRuns(sections, 'y', x);
    const b = iv.filter((s) => s[1] <= y0 + 1e-6).pop();
    const t = iv.find((s) => s[0] >= y1 - 1e-6);
    if (b) gaps.bottom.push(y0 - b[1]);
    if (t) gaps.top.push(t[0] - y1);
  }
  return gaps;
}

/**
 * The longest run of CONSECUTIVE scanlines that found a gap.
 *
 * The metric is a run rather than a maximum because a single gapped scanline is
 * not evidence of a hole. An even-odd crossing is degenerate where the line
 * lands on a flat or through a vertex, and one such line reported 10.52 mm on a
 * side that re-measured at 0.00 the moment the phase or the slice height moved.
 * A missing quadrant is not like that: it is ~11 mm of aperture, thirty-odd
 * consecutive lines, and it does not care where the scanlines fall.
 */
function longestGappedRun(gaps: readonly number[], tol = 0.5): number {
  let best = 0, cur = 0;
  for (const g of gaps) {
    cur = g > tol ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return best;
}

function stat(v: readonly number[]) {
  if (v.length === 0) return { n: 0, min: NaN, max: NaN, mean: NaN };
  return {
    n: v.length,
    min: Math.min(...v),
    max: Math.max(...v),
    mean: v.reduce((a, b) => a + b, 0) / v.length,
  };
}

describe('the aperture round a zone, on the exported wall', () => {
  const doc = deserialize(JSON.stringify(WALL)).doc as LayoutDoc;

  /** Every plate's section through the mouth band, in wall coordinates. */
  function sections(z: number): Seg[][] {
    return doc.panels.map((panel: PlacedPanel) => {
      const spec = panelModelSpecFor(panel, doc);
      const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
      return sliceAt(mesh.positions, z);
    });
  }

  it('opens on the zone rectangle exactly, on every side of every zone', () => {
    const secs = sections(1.0);
    const lines: string[] = [];
    for (const zone of doc.obstacles ?? []) {
      const gaps = apron(secs, zone, 0.37);
      lines.push(`zone ${zone.xMm} ${zone.yMm} ${zone.widthMm} x ${zone.heightMm}`);
      for (const side of SIDES) {
        const s = stat(gaps[side]);
        const run = longestGappedRun(gaps[side]);
        lines.push(
          `  ${side.padEnd(6)} n=${String(s.n).padStart(4)}` +
          `  mean=${s.mean.toFixed(2).padStart(6)}` +
          `  max=${s.max.toFixed(2).padStart(6)}  gapped-run=${run}`,
        );
        // A whole cell dropped instead of cut is ~30 consecutive lines.
        expect(run).toBeLessThanOrEqual(1);
      }
      // Every side that is measurable at all must be measured densely, or the
      // assertion above passes on a side nothing crossed.
      const seen = SIDES.filter((s) => gaps[s].length > 0);
      expect(seen.length).toBeGreaterThanOrEqual(3);
      for (const s of seen) expect(gaps[s].length).toBeGreaterThan(100);
    }
    console.log('\n' + lines.join('\n'));
  });

  it('is the same answer at another scanline phase and slice height', () => {
    /*
     * The guard on the guard. The measurement above is even-odd counting on a
     * lattice, which is degenerate exactly where a line meets a flat or a
     * vertex — so a result that only holds at one phase is a coincidence, and
     * during this fix one genuinely was. Re-measured off different multiples
     * and at a different height in the mouth band, every side must still be
     * clean, and here that is strict: no gapped scanline at all.
     */
    const secs = sections(0.8);
    for (const zone of doc.obstacles ?? []) {
      const gaps = apron(secs, zone, 0.31);
      for (const side of SIDES) {
        const s = stat(gaps[side]);
        if (s.n === 0) continue;
        expect(s.max).toBeCloseTo(0, 6);
      }
    }
  });
});
