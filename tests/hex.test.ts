/**
 * Adversarial verification of src/core/hex.ts.
 *
 * Written by an independent verifier whose brief was "assume there is a bug".
 * These tests are deliberately property-style and brute-force: nearly every
 * geometric claim is checked against an independently computed answer
 * (Euclidean distance in millimetres over an exhaustive candidate window)
 * rather than against a hand-picked expected value, because a hand-picked
 * expected value only re-states whatever the implementation happens to do.
 *
 * Ground truth used here:
 *   HSW-SPEC.md §2  — x = PITCH·(q + r/2), y = ROW_STEP·r; horizontal neighbours
 *                     23.60000 mm apart, diagonal neighbours 23.59983 mm apart.
 *   HSW-SPEC.md §4  — W = PITCH·(columns + 0.5), H = (rows−1)·20.438 + 27.25093,
 *                     margins 11.8 (flats axis) and 13.6254664 = PITCH/√3 (rows axis).
 *   DECISIONS.md D4 — ROW_STEP is the typed constant 20.438, NOT PITCH·√3/2
 *                     (= 20.43819952931275). The lattice is therefore very
 *                     slightly non-equilateral, on purpose. A test that demanded
 *                     23.6 for the diagonal would be asserting the bug.
 */

import { describe, it, expect } from 'vitest';

import {
  hex,
  hexEq,
  hexAdd,
  hexSub,
  hexKey,
  keyToHex,
  hexDistance,
  HEX_DIRECTIONS,
  hexNeighbour,
  hexNeighbours,
  hexRotate,
  rotateFootprint,
  placeFootprint,
  hexToMm,
  mmToHex,
  hexRound,
  hexCorners,
  panelCells,
  cellsBoundsMm,
  Occupancy,
  footprintsOverlap,
  type Point,
} from '../src/core/hex';
import {
  PITCH,
  ROW_STEP,
  STAGGER,
  MARGIN_X,
  MARGIN_Y,
  DIAGONAL_NEIGHBOUR,
  LATTICE_ANCHOR,
} from '../src/core/constants';
import type { Hex, Rotation } from '../src/core/types';

// ---------------------------------------------------------------------------
// Tolerances — chosen from measurement, not from taste
// ---------------------------------------------------------------------------

/**
 * Float64 tolerance for millimetre arithmetic.
 *
 * Every coordinate exercised below stays under ~1e4 mm, where one ulp of a
 * float64 is ~1.8e-12. hexToMm is two operations and the comparisons here are a
 * handful more, so the worst honest accumulation is order 1e-11 mm. 1e-9 gives
 * ~100× headroom over that while still being 5 orders of magnitude tighter than
 * the smallest physically meaningful quantity in this project (the 2e-4 mm D4
 * rounding) — so it cannot paper over a real geometric error.
 */
const EPS = 1e-9;

/**
 * How far from the *true* nearest centre cube rounding is allowed to land.
 *
 * Cube rounding is provably exact on a perfectly equilateral lattice. This
 * lattice is not: ROW_STEP (20.438) sits 1.9953e-4 mm below PITCH·√3/2
 * (20.43819952931275), so the real perpendicular bisectors are displaced from
 * the ones cube rounding assumes by ~1e-4 mm. I searched for the supremum of the
 * resulting error by hill-climbing 500k perturbations around the triple points
 * where it is worst: the measured maximum is 9.976e-5 mm, and it occurs only in
 * a sliver of measure ~0 (3,000,000 uniformly random points produced ZERO
 * disagreements at all). 2e-4 is that measured bound, doubled.
 *
 * This tolerance still has enormous discriminating power: the classic bug it
 * guards against — naive independent rounding of the fractional axial
 * coordinates — is wrong on ~17% of random points and by up to 8.58 mm, i.e.
 * 43,000× this bound. The `canary` test at the end proves that.
 */
const ANISOTROPY_MM = 2e-4;

// ---------------------------------------------------------------------------
// Helpers — all independent re-derivations, none of them call into hex.ts
// beyond hexToMm (the forward map, which is asserted directly against the spec
// formula before anything else relies on it).
// ---------------------------------------------------------------------------

/** Deterministic PRNG so any failure is reproducible from the seed alone. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mmDist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

const centreDist = (p: Point, h: Hex): number => mmDist(p, hexToMm(h));

/**
 * The genuinely nearest lattice cell to `p`, found by exhaustive search of a
 * window around a starting guess. Independent of hexRound entirely.
 */
function trueNearest(p: Point, around: Hex, radius = 3): { cell: Hex; dist: number } {
  let cell: Hex = around;
  let best = Infinity;
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = -radius; dr <= radius; dr++) {
      const h: Hex = { q: around.q + dq, r: around.r + dr };
      const d = centreDist(p, h);
      if (d < best) {
        best = d;
        cell = h;
      }
    }
  }
  return { cell, dist: best };
}

/** Exact circumcentre of three cell centres — a true lattice "corner" in mm. */
function circumcentreMm(a: Hex, b: Hex, c: Hex): Point {
  const A = hexToMm(a);
  const B = hexToMm(b);
  const C = hexToMm(c);
  const d = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
  const sa = A.x * A.x + A.y * A.y;
  const sb = B.x * B.x + B.y * B.y;
  const sc = C.x * C.x + C.y * C.y;
  return {
    x: (sa * (B.y - C.y) + sb * (C.y - A.y) + sc * (A.y - B.y)) / d,
    y: (sa * (C.x - B.x) + sb * (A.x - C.x) + sc * (B.x - A.x)) / d,
  };
}

const dir = (i: number): Hex => HEX_DIRECTIONS[i]!;

const keysOf = (cells: readonly Hex[]): string[] => cells.map(hexKey);

/**
 * Normalise signed zero. Needed only because hexRotate can return -0 (see the
 * dedicated test below); vitest's toEqual treats -0 and 0 as different values.
 */
const norm0 = (h: Hex): Hex => ({ q: h.q === 0 ? 0 : h.q, r: h.r === 0 ? 0 : h.r });

/** Cast helper: hexRotate accepts any number, the footprint APIs are typed to 0–5. */
const asRotation = (n: number): Rotation => n as Rotation;

const ORIGIN: Hex = { q: 0, r: 0 };

// ---------------------------------------------------------------------------
// 0. Constants and the forward map agree with the measured spec
// ---------------------------------------------------------------------------

describe('constants and the forward map match HSW-SPEC §2/§4', () => {
  it('holds the measured lattice constants, NOT the idealised closed forms (D4)', () => {
    expect(PITCH).toBe(23.6);
    expect(ROW_STEP).toBe(20.438);
    expect(STAGGER).toBe(PITCH / 2);

    // The whole point of D4: ROW_STEP must NOT be the regular-lattice value.
    const idealRowStep = (PITCH * Math.sqrt(3)) / 2; // 20.43819952931275
    expect(ROW_STEP).not.toBe(idealRowStep);
    expect(idealRowStep - ROW_STEP).toBeCloseTo(1.9953e-4, 8);

    // D4's stated consequence: 18 columns is 17 steps, drifting 0.0034 mm.
    // The exact figure is 0.00339200; D4 quotes it to 2 significant figures, so
    // 4 decimal places (tolerance 5e-5) is the honest comparison, not 5.
    expect(17 * (idealRowStep - ROW_STEP)).toBeCloseTo(0.0034, 4);
    expect(17 * (idealRowStep - ROW_STEP)).toBeCloseTo(0.003392, 8);
  });

  it('margins match their closed forms in §4', () => {
    // The two values are unchanged; which axis carries which swapped with the
    // frame (D35). On a flat-top wall the left/right boundary sits at a hexagon
    // CORNER and the top/bottom at a FLAT — the opposite of pointy-top.
    expect(MARGIN_Y).toBe(PITCH / 2);
    // PITCH/√3 = 13.62546637... ; the constant is the 7-dp value from the scan.
    expect(MARGIN_X).toBeCloseTo(PITCH / Math.sqrt(3), 6);
    // §4's width constant 27.25093 is 2·MARGIN_X.
    expect(2 * MARGIN_X).toBeCloseTo(27.25093, 5);
  });

  it('hexToMm is x = ROW_STEP·q, y = PITCH·(r + q/2), anchored into the wall', () => {
    for (let q = -50; q <= 50; q++) {
      for (let r = -50; r <= 50; r++) {
        const p = hexToMm({ q, r });
        expect(p.x).toBeCloseTo(ROW_STEP * q + LATTICE_ANCHOR.x, 9);
        expect(p.y).toBeCloseTo(PITCH * r + STAGGER * q + LATTICE_ANCHOR.y, 9);
      }
    }
  });

  it('is anchored so a plate starts at the wall corner, not half a cell outside it', () => {
    // The anchor is the whole point: the wall's origin is its CORNER and the
    // lattice's is a cell CENTRE, and until `LATTICE_ANCHOR` existed nothing
    // said so — cell (0, 0) sat at (0, 0), so the plate's outline began at
    // −13.63 mm and the honeycomb hung off the left-hand edge of the wall (D63).
    const origin = hexToMm({ q: 0, r: 0 });
    expect(origin.x - MARGIN_X).toBeCloseTo(0, 9);

    // X only, and the asymmetry is load-bearing. A column step cannot absorb
    // the offset, so it has to come from the anchor...
    expect(Number.isInteger(MARGIN_X / ROW_STEP)).toBe(false);
    // ...while in Y the solver already lands the outline on zero by choosing
    // which row a band starts at, because the stagger puts centres on every
    // half pitch and MARGIN_Y IS half a pitch. Anchoring Y as well pushes every
    // band up and the top row off the wall.
    expect(LATTICE_ANCHOR.y).toBe(0);
    expect(MARGIN_Y).toBe(PITCH / 2);
    expect(hexToMm({ q: 1, r: 0 }).y).toBeCloseTo(MARGIN_Y, 9);
  });

  it('hexToMm is affine: differences add exactly', () => {
    // Linear in the DIFFERENCES, which is the property everything relies on —
    // rotations, footprints, seams and the generator all work in offsets. The
    // anchor is a constant term and is deliberately not part of that.
    const rng = makeRng(0xc0ffee);
    const zero = hexToMm(ORIGIN);
    let worst = 0;
    for (let i = 0; i < 5000; i++) {
      const a: Hex = { q: Math.floor(rng() * 200) - 100, r: Math.floor(rng() * 200) - 100 };
      const b: Hex = { q: Math.floor(rng() * 200) - 100, r: Math.floor(rng() * 200) - 100 };
      const pa = hexToMm(a);
      const pb = hexToMm(b);
      const pab = hexToMm(hexAdd(a, b));
      worst = Math.max(
        worst,
        Math.abs(pab.x - zero.x - (pa.x - zero.x) - (pb.x - zero.x)),
        Math.abs(pab.y - zero.y - (pa.y - zero.y) - (pb.y - zero.y)),
      );
    }
    expect(worst).toBeLessThan(EPS);
  });
});

// ---------------------------------------------------------------------------
// 1. Round trip — a failure here is "the drop lands one cell off"
// ---------------------------------------------------------------------------

describe('mmToHex ∘ hexToMm is the identity', () => {
  it('round-trips every cell in −40..40 exactly (6,561 cells)', () => {
    const failures: Array<[Hex, Hex]> = [];
    for (let q = -40; q <= 40; q++) {
      for (let r = -40; r <= 40; r++) {
        const got = mmToHex(hexToMm({ q, r }));
        if (got.q !== q || got.r !== r) failures.push([{ q, r }, got]);
      }
    }
    expect(failures).toEqual([]);
  });

  it('round-trips a coarse sweep out to ±400 cells (≈9.4 m of wall)', () => {
    const failures: Array<[Hex, Hex]> = [];
    for (let q = -400; q <= 400; q += 7) {
      for (let r = -400; r <= 400; r += 7) {
        const got = mmToHex(hexToMm({ q, r }));
        if (got.q !== q || got.r !== r) failures.push([{ q, r }, got]);
      }
    }
    expect(failures).toEqual([]);
  });

  it('round-trips extreme but still finite lattice positions', () => {
    const extremes: Hex[] = [
      { q: 0, r: 0 },
      { q: 1e5, r: -1e5 },
      { q: -1e5, r: 1e5 },
      { q: 1e6, r: 1e6 },
      { q: -1e6, r: -1e6 },
      { q: 123456, r: -654321 },
    ];
    for (const h of extremes) {
      expect(mmToHex(hexToMm(h))).toEqual(h);
    }
  });

  it('survives jitter: any point within 35% of a cell radius returns that cell', () => {
    // 35% of the inradius (PITCH/2) is comfortably inside every hexagon, so this
    // is a strict identity, not a tolerance.
    const rng = makeRng(1234);
    const jitter = 0.35 * (PITCH / 2);
    const failures: Array<{ h: Hex; p: Point; got: Hex }> = [];
    for (let i = 0; i < 20000; i++) {
      const h: Hex = { q: Math.floor(rng() * 120) - 60, r: Math.floor(rng() * 120) - 60 };
      const c = hexToMm(h);
      const a = rng() * Math.PI * 2;
      const rad = rng() * jitter;
      const p: Point = { x: c.x + rad * Math.cos(a), y: c.y + rad * Math.sin(a) };
      const got = mmToHex(p);
      if (got.q !== h.q || got.r !== h.r) failures.push({ h, p, got });
    }
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. hexRound at boundaries — the single most likely bug
// ---------------------------------------------------------------------------

describe('hexRound returns the genuinely nearest centre', () => {
  /** Shared driver: returns the worst "excess distance" over a set of points. */
  function worstExcess(points: Iterable<Point>): { excess: number; at: Point | null; got: Hex | null; best: Hex | null } {
    let excess = 0;
    let at: Point | null = null;
    let got: Hex | null = null;
    let best: Hex | null = null;
    for (const p of points) {
      const g = mmToHex(p);
      const t = trueNearest(p, g);
      const e = centreDist(p, g) - t.dist;
      if (e > excess) {
        excess = e;
        at = p;
        got = g;
        best = t.cell;
      }
    }
    return { excess, at, got, best };
  }

  it('is nearest for 40,000 uniformly random points across a 2.4 m wall', () => {
    const rng = makeRng(20240815);
    const pts: Point[] = [];
    for (let i = 0; i < 40000; i++) {
      pts.push({ x: (rng() - 0.5) * 2400, y: (rng() - 0.5) * 2400 });
    }
    const w = worstExcess(pts);
    // Uniformly random points never land in the anisotropy sliver, so this is
    // an exact result and deserves the exact tolerance.
    expect(w.excess).toBeLessThan(EPS);
  });

  it('is nearest ON the shared edge between every cell and each of its 6 neighbours', () => {
    // The exact mm midpoint of two centres lies on their shared edge — the worst
    // possible place for a rounding rule. Nudged either side by 1e-12..1e-3 of
    // the separation so that both "just inside" and "just outside" are covered.
    const pts: Point[] = [];
    for (let q = -12; q <= 12; q++) {
      for (let r = -12; r <= 12; r++) {
        const a = hexToMm({ q, r });
        for (let d = 0; d < 6; d++) {
          const dd = dir(d);
          const b = hexToMm({ q: q + dd.q, r: r + dd.r });
          const mid: Point = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          for (const t of [0, 1e-12, -1e-12, 1e-9, -1e-9, 1e-6, -1e-6, 1e-3, -1e-3]) {
            pts.push({ x: mid.x + (b.x - a.x) * t, y: mid.y + (b.y - a.y) * t });
          }
        }
      }
    }
    expect(pts.length).toBeGreaterThan(30000);
    const w = worstExcess(pts);
    // Measured: exactly 0 over this family. Edge midpoints are unaffected by the
    // D4 anisotropy because the two centres are symmetric about the midpoint.
    expect(w.excess).toBeLessThan(EPS);
  });

  it('is nearest at and around every triple point (lattice corner)', () => {
    // The circumcentre of three mutually adjacent cells is a true hexagon corner:
    // three cells exactly equidistant. Naive axial rounding fails in a whole
    // region around these; this is the specific place it goes wrong.
    const pts: Point[] = [];
    for (let q = -10; q <= 10; q++) {
      for (let r = -10; r <= 10; r++) {
        for (let k = 0; k < 6; k++) {
          const d0 = dir(k);
          const d1 = dir((k + 1) % 6);
          const cc = circumcentreMm(
            { q, r },
            { q: q + d0.q, r: r + d0.r },
            { q: q + d1.q, r: r + d1.r },
          );
          for (const eps of [0, 1e-12, 1e-9, 1e-6, 1e-3, 1e-2, 0.1, 1]) {
            for (const [sx, sy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
              [0.7071, 0.7071],
              [-0.7071, 0.7071],
            ] as const) {
              pts.push({ x: cc.x + sx * eps, y: cc.y + sy * eps });
            }
          }
        }
      }
    }
    expect(pts.length).toBeGreaterThan(100000);
    const w = worstExcess(pts);
    // This is the ONLY family where cube rounding is not exact, and the residual
    // is the D4 anisotropy, not a logic error. Measured supremum 9.976e-5 mm
    // (0.1 µm) — see the ANISOTROPY_MM comment above.
    expect(w.excess).toBeLessThan(ANISOTROPY_MM);
    // Pin the magnitude: if this ever exceeded 1e-3 mm it would mean the rounding
    // rule, not the constant, had changed.
    expect(w.excess).toBeLessThan(1e-3);
  });

  it('is nearest along the full perimeter of every drawn cell', () => {
    // hexCorners draws the cell; walk its six edges and both sides of its corners.
    const pts: Point[] = [];
    for (let q = -8; q <= 8; q++) {
      for (let r = -8; r <= 8; r++) {
        const c = hexToMm({ q, r });
        const cs = hexCorners({ q, r });
        for (let i = 0; i < 6; i++) {
          const a = cs[i]!;
          const b = cs[(i + 1) % 6]!;
          for (let t = 0; t <= 16; t++) {
            const u = t / 16;
            pts.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
          }
          for (const eps of [1e-9, 1e-4, 1e-2]) {
            pts.push({ x: c.x + (a.x - c.x) * (1 - eps), y: c.y + (a.y - c.y) * (1 - eps) });
            pts.push({ x: c.x + (a.x - c.x) * (1 + eps), y: c.y + (a.y - c.y) * (1 + eps) });
          }
        }
      }
    }
    const w = worstExcess(pts);
    expect(w.excess).toBeLessThan(ANISOTROPY_MM);
  });

  it('hexRound agrees with mmToHex for fractional axial input directly', () => {
    const rng = makeRng(777);
    for (let i = 0; i < 5000; i++) {
      const qf = (rng() - 0.5) * 100;
      const rf = (rng() - 0.5) * 100;
      const h = hexRound(qf, rf);
      // The cube constraint the fix-up exists to preserve.
      expect(Number.isInteger(h.q)).toBe(true);
      expect(Number.isInteger(h.r)).toBe(true);
      const y = -h.q - h.r;
      expect(h.q + y + h.r).toBe(0);
      // ...and it must be within one step of the naive truncation.
      expect(Math.abs(h.q - qf)).toBeLessThanOrEqual(1);
      expect(Math.abs(h.r - rf)).toBeLessThanOrEqual(1);
    }
  });

  it('CANARY: a naive axial rounding fails the exact same check', () => {
    // Proof that the assertions above have teeth. If someone "simplified"
    // hexRound to independent Math.round on q and r, this is what it would cost.
    const naive = (p: Point): Hex => {
      const rf = p.y / ROW_STEP;
      return { q: Math.round(p.x / PITCH - rf / 2), r: Math.round(rf) };
    };
    const rng = makeRng(999);
    let wrong = 0;
    let worst = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const p: Point = { x: (rng() - 0.5) * 2400, y: (rng() - 0.5) * 2400 };
      const g = naive(p);
      const t = trueNearest(p, g);
      const e = centreDist(p, g) - t.dist;
      if (e > ANISOTROPY_MM) {
        wrong++;
        worst = Math.max(worst, e);
      }
    }
    expect(wrong / N).toBeGreaterThan(0.1); // measured ≈ 17%
    expect(worst).toBeGreaterThan(5); // measured ≈ 8.58 mm — 43,000× the tolerance
  });
});

// ---------------------------------------------------------------------------
// 3. Rotation
// ---------------------------------------------------------------------------

describe('hexRotate is exact, closed and integer', () => {
  const sweep: Hex[] = [];
  for (let q = -20; q <= 20; q++) for (let r = -20; r <= 20; r++) sweep.push({ q, r });

  it('six steps is the identity for all 1,681 cells in −20..20', () => {
    const failures: Array<[Hex, Hex]> = [];
    for (const h of sweep) {
      const got = hexRotate(h, 6);
      if (got.q !== h.q || got.r !== h.r) failures.push([h, got]);
    }
    expect(failures).toEqual([]);
  });

  it('six steps is the identity by deep equality too (after normalising −0)', () => {
    // norm0 is required ONLY because of the signed-zero quirk pinned in the next
    // test; without it vitest's toEqual reports { q: -0 } ≠ { q: 0 }.
    for (const h of sweep) {
      expect(norm0(hexRotate(h, 6))).toEqual(h);
    }
  });

  it('applying one step six times returns the original', () => {
    for (const h of sweep) {
      let c = h;
      for (let i = 0; i < 6; i++) c = hexRotate(c, 1);
      expect(c.q === h.q && c.r === h.r).toBe(true);
    }
  });

  it('never leaves the integer lattice', () => {
    for (const h of sweep) {
      for (let s = -13; s <= 13; s++) {
        const g = hexRotate(h, s);
        expect(Number.isInteger(g.q) && Number.isInteger(g.r)).toBe(true);
      }
    }
  });

  it('preserves hexDistance from the origin', () => {
    for (const h of sweep) {
      const d = hexDistance(h, ORIGIN);
      for (let s = 0; s < 6; s++) {
        expect(hexDistance(hexRotate(h, s), ORIGIN)).toBe(d);
      }
    }
  });

  it('preserves hexDistance between arbitrary pairs (it is an isometry in cell space)', () => {
    const rng = makeRng(31337);
    for (let i = 0; i < 4000; i++) {
      const a: Hex = { q: Math.floor(rng() * 80) - 40, r: Math.floor(rng() * 80) - 40 };
      const b: Hex = { q: Math.floor(rng() * 80) - 40, r: Math.floor(rng() * 80) - 40 };
      const d = hexDistance(a, b);
      const s = Math.floor(rng() * 6);
      expect(hexDistance(hexRotate(a, s), hexRotate(b, s))).toBe(d);
    }
  });

  it('normalises negative and out-of-range step counts', () => {
    for (const h of sweep) {
      for (let s = -18; s <= 18; s++) {
        const canonical = hexRotate(h, ((s % 6) + 6) % 6);
        const got = hexRotate(h, s);
        expect(got.q === canonical.q && got.r === canonical.r).toBe(true);
      }
    }
  });

  it('composes: rotate(a) then rotate(b) === rotate(a+b)', () => {
    for (const h of sweep) {
      for (let a = -6; a <= 6; a++) {
        for (let b = -6; b <= 6; b += 3) {
          const twice = hexRotate(hexRotate(h, a), b);
          const once = hexRotate(h, a + b);
          expect(twice.q === once.q && twice.r === once.r).toBe(true);
        }
      }
    }
  });

  it('is a bijection: distinct cells never collide after rotation', () => {
    for (let s = 0; s < 6; s++) {
      const seen = new Set<string>();
      for (const h of sweep) seen.add(hexKey(hexRotate(h, s)));
      expect(seen.size).toBe(sweep.length);
    }
  });

  it('one step maps direction i to direction i+1 (clockwise on screen, matching HEX_DIRECTIONS)', () => {
    for (let i = 0; i < 6; i++) {
      const got = hexRotate(dir(i), 1);
      const want = dir((i + 1) % 6);
      expect(got.q === want.q && got.r === want.r).toBe(true);
    }
  });

  it('never returns −0 (regression: it used to, in 29 of 150 cases)', () => {
    // toCube computes y = -q - r, which is -0 whenever q and r are both 0, and
    // the cube step (x,y,z) -> (-z,-x,-y) propagated that negated zero into the
    // result. It was invisible to ===, hexKey and JSON.stringify, but NOT to
    // Object.is, to a deep-equality memo, or to a Map keyed on the raw object —
    // and `expect(-0).toEqual(0)` fails, so "rotate six times returns the
    // original" was false as written. fromCube now normalises it.
    expect(Object.is(hexRotate({ q: 0, r: 0 }, 1).q, -0)).toBe(false);
    expect(Object.is(hexRotate({ q: 1, r: 0 }, 3).r, -0)).toBe(false);

    let count = 0;
    for (let q = -2; q <= 2; q++) {
      for (let r = -2; r <= 2; r++) {
        for (let s = 0; s < 6; s++) {
          const g = hexRotate({ q, r }, s);
          if (Object.is(g.q, -0) || Object.is(g.r, -0)) count++;
        }
      }
    }
    expect(count).toBe(0);

    // Now that the sign is clean at source, the brief's literal requirement
    // holds under deep equality rather than only under ===.
    for (let q = -3; q <= 3; q++) {
      for (let r = -3; r <= 3; r++) {
        expect(hexRotate({ q, r }, 6)).toEqual({ q, r });
      }
    }

    const placed = placeFootprint([{ q: 0, r: 0 }], ORIGIN, 1);
    expect(Object.is(placed[0]!.q, -0)).toBe(false);
    expect(Object.is(placed[0]!.r, -0)).toBe(false);
  });
});

describe('rotateFootprint', () => {
  const footprint: Hex[] = [
    { q: 0, r: 0 },
    { q: 1, r: 0 },
    { q: 2, r: 0 },
    { q: 0, r: 1 },
    { q: -1, r: 2 },
  ];

  it('preserves size and distinctness for every rotation', () => {
    for (let s = 0; s < 6; s++) {
      const out = rotateFootprint(footprint, asRotation(s));
      expect(out).toHaveLength(footprint.length);
      expect(new Set(keysOf(out)).size).toBe(footprint.length);
    }
  });

  it('preserves all pairwise hexDistances', () => {
    for (let s = 0; s < 6; s++) {
      const out = rotateFootprint(footprint, asRotation(s));
      for (let i = 0; i < footprint.length; i++) {
        for (let j = 0; j < footprint.length; j++) {
          expect(hexDistance(out[i]!, out[j]!)).toBe(hexDistance(footprint[i]!, footprint[j]!));
        }
      }
    }
  });

  it('NOTE: rotation is exact in cells but only ~1.7e-4 mm-accurate in millimetres', () => {
    // Direct consequence of D4: the lattice is not equilateral, so a rigid
    // rotation in cell space is not quite a rigid rotation in millimetres.
    // A 3-cell horizontal span is 70.80000 mm; rotated 60° it is 70.79948 mm.
    // Down a column: (0,1) is the exact-PITCH direction in the flat-top frame.
    const span: Hex[] = [
      { q: 0, r: 0 },
      { q: 0, r: 3 },
    ];
    const flat = mmDist(hexToMm(span[0]!), hexToMm(span[1]!));
    const spun = rotateFootprint(span, 1);
    const turned = mmDist(hexToMm(spun[0]!), hexToMm(spun[1]!));
    expect(flat).toBeCloseTo(3 * PITCH, 9);
    expect(turned).toBeCloseTo(3 * DIAGONAL_NEIGHBOUR, 9);
    expect(flat - turned).toBeGreaterThan(0);
    expect(flat - turned).toBeLessThan(1e-3); // 5.2e-4 mm — 0.5 µm, physically nil
  });
});

// ---------------------------------------------------------------------------
// 4. placeFootprint
// ---------------------------------------------------------------------------

describe('placeFootprint', () => {
  const footprints: Hex[][] = [
    [{ q: 0, r: 0 }],
    [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
    ],
    [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 0, r: 1 },
      { q: 1, r: 1 },
    ],
    [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 2, r: 0 },
      { q: 3, r: 0 },
      { q: -1, r: 1 },
      { q: 2, r: -2 },
      { q: -3, r: 4 },
    ],
  ];
  const anchors: Hex[] = [
    { q: 0, r: 0 },
    { q: 5, r: 0 },
    { q: 0, r: 5 },
    { q: -7, r: 3 },
    { q: 400, r: -400 },
    { q: -1000, r: -1000 },
  ];

  it('rotate-then-translate === translate-the-rotated-cells, for every combination', () => {
    for (const fp of footprints) {
      for (const at of anchors) {
        for (let s = 0; s < 6; s++) {
          const placed = placeFootprint(fp, at, asRotation(s));
          const manual = rotateFootprint(fp, asRotation(s)).map((c) => hexAdd(c, at));
          expect(placed.map(norm0)).toEqual(manual.map(norm0));
        }
      }
    }
  });

  it('never changes the number of cells and never creates a duplicate', () => {
    for (const fp of footprints) {
      const inputDistinct = new Set(keysOf(fp)).size;
      expect(inputDistinct).toBe(fp.length); // the fixtures really are duplicate-free
      for (const at of anchors) {
        for (let s = 0; s < 6; s++) {
          const placed = placeFootprint(fp, at, asRotation(s));
          expect(placed).toHaveLength(fp.length);
          expect(new Set(keysOf(placed)).size).toBe(fp.length);
        }
      }
    }
  });

  it('is the identity at rotation 0 and the origin anchor', () => {
    for (const fp of footprints) {
      expect(placeFootprint(fp, ORIGIN, 0).map(norm0)).toEqual(fp.map(norm0));
    }
  });

  it('translation composes: place(at a) then shift by b === place(at a+b)', () => {
    const fp = footprints[3]!;
    for (let s = 0; s < 6; s++) {
      const a: Hex = { q: 3, r: -4 };
      const b: Hex = { q: -11, r: 2 };
      const viaSum = placeFootprint(fp, hexAdd(a, b), asRotation(s));
      const viaShift = placeFootprint(fp, a, asRotation(s)).map((c) => hexAdd(c, b));
      expect(viaSum).toEqual(viaShift);
    }
  });

  it('normalises out-of-range rotation the same way hexRotate does', () => {
    const fp = footprints[3]!;
    for (let s = -13; s <= 13; s++) {
      const got = placeFootprint(fp, { q: 2, r: 2 }, asRotation(s));
      const want = placeFootprint(fp, { q: 2, r: 2 }, asRotation(((s % 6) + 6) % 6));
      expect(got).toEqual(want);
    }
  });

  it('preserves the internal shape: pairwise distances survive rotate + translate', () => {
    for (const fp of footprints) {
      for (const at of anchors) {
        for (let s = 0; s < 6; s++) {
          const placed = placeFootprint(fp, at, asRotation(s));
          for (let i = 0; i < fp.length; i++) {
            for (let j = i + 1; j < fp.length; j++) {
              expect(hexDistance(placed[i]!, placed[j]!)).toBe(hexDistance(fp[i]!, fp[j]!));
            }
          }
        }
      }
    }
  });

  it('accepts an empty footprint without throwing', () => {
    expect(placeFootprint([], { q: 4, r: 4 }, 3)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const fp = footprints[3]!.map((c) => ({ ...c }));
    const snapshot = JSON.stringify(fp);
    placeFootprint(fp, { q: 9, r: -9 }, 4);
    expect(JSON.stringify(fp)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// 5. Neighbours
// ---------------------------------------------------------------------------

describe('neighbours', () => {
  it('there are exactly 6 directions and they are distinct and non-zero', () => {
    expect(HEX_DIRECTIONS).toHaveLength(6);
    expect(new Set(keysOf(HEX_DIRECTIONS)).size).toBe(6);
    for (const d of HEX_DIRECTIONS) expect(hexDistance(d, ORIGIN)).toBe(1);
  });

  it('the directions are ordered by increasing screen angle, as documented', () => {
    let previous = -Infinity;
    const centre = hexToMm(ORIGIN);
    for (const d of HEX_DIRECTIONS) {
      const p = hexToMm(d);
      // Measured from the cell we are stepping AWAY from, not from the mm
      // origin — the lattice is anchored into the wall, so those differ.
      // Screen y is down, so this sweeps clockwise from due east.
      const angle = Math.atan2(p.y - centre.y, p.x - centre.x);
      const norm = angle < -1e-12 ? angle + 2 * Math.PI : angle;
      expect(norm).toBeGreaterThan(previous);
      previous = norm;
    }
  });

  it('all 6 neighbours of any cell are at hexDistance 1 and are 6 distinct cells', () => {
    for (let q = -30; q <= 30; q += 3) {
      for (let r = -30; r <= 30; r += 3) {
        const h: Hex = { q, r };
        const ns = hexNeighbours(h);
        expect(ns).toHaveLength(6);
        expect(new Set(keysOf(ns)).size).toBe(6);
        for (const n of ns) {
          expect(hexDistance(h, n)).toBe(1);
          expect(hexEq(n, h)).toBe(false);
          // symmetry: h must be one of n's neighbours
          expect(keysOf(hexNeighbours(n))).toContain(hexKey(h));
        }
      }
    }
  });

  it('there is nothing else at distance 1: the neighbour set is complete', () => {
    // Exhaustive: scan a window and confirm exactly the 6 known cells are at
    // distance 1. Guards against a wrong direction table.
    for (let q = -5; q <= 5; q++) {
      for (let r = -5; r <= 5; r++) {
        const h: Hex = { q, r };
        const found: string[] = [];
        for (let dq = -3; dq <= 3; dq++) {
          for (let dr = -3; dr <= 3; dr++) {
            const c: Hex = { q: q + dq, r: r + dr };
            if (hexDistance(h, c) === 1) found.push(hexKey(c));
          }
        }
        expect(found.sort()).toEqual(keysOf(hexNeighbours(h)).sort());
      }
    }
  });

  it('hexNeighbour handles negative and out-of-range direction indices', () => {
    const h: Hex = { q: 3, r: -2 };
    for (let d = -30; d <= 30; d++) {
      const expected = hexAdd(h, dir(((d % 6) + 6) % 6));
      expect(hexNeighbour(h, d)).toEqual(expected);
    }
    // and agrees with hexNeighbours for 0..5
    for (let d = 0; d < 6; d++) {
      expect(hexNeighbour(h, d)).toEqual(hexNeighbours(h)[d]!);
    }
  });

  it('FINDING (documented): hexNeighbour throws on a non-integer or NaN direction', () => {
    // ((1.5 % 6) + 6) % 6 === 1.5, HEX_DIRECTIONS[1.5] is undefined, and the
    // non-null assertion on line 71 only silences the compiler. Arguably correct
    // (a fractional direction is meaningless) but it is an unchecked crash, not a
    // deliberate throw, and the `!` hides it from the type system.
    expect(() => hexNeighbour({ q: 0, r: 0 }, 1.5)).toThrow();
    expect(() => hexNeighbour({ q: 0, r: 0 }, NaN)).toThrow();
    expect(() => hexNeighbour({ q: 0, r: 0 }, Infinity)).toThrow();
  });

  it('hexDistance is a metric: symmetric, zero only on equality, triangle inequality', () => {
    const rng = makeRng(2468);
    for (let i = 0; i < 5000; i++) {
      const a: Hex = { q: Math.floor(rng() * 60) - 30, r: Math.floor(rng() * 60) - 30 };
      const b: Hex = { q: Math.floor(rng() * 60) - 30, r: Math.floor(rng() * 60) - 30 };
      const c: Hex = { q: Math.floor(rng() * 60) - 30, r: Math.floor(rng() * 60) - 30 };
      expect(hexDistance(a, b)).toBe(hexDistance(b, a));
      expect(hexDistance(a, a)).toBe(0);
      if (!hexEq(a, b)) expect(hexDistance(a, b)).toBeGreaterThan(0);
      expect(hexDistance(a, c)).toBeLessThanOrEqual(hexDistance(a, b) + hexDistance(b, c));
      // translation invariance
      expect(hexDistance(hexAdd(a, c), hexAdd(b, c))).toBe(hexDistance(a, b));
      // and hexSub is the inverse of hexAdd
      expect(hexSub(hexAdd(a, b), b)).toEqual(a);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Physical distances — the D4 property
// ---------------------------------------------------------------------------

describe('physical neighbour distances (HSW-SPEC §2, DECISIONS D4)', () => {
  /** VERTICAL now — the distance is the same 23.6, the axis turned (D35). */
  it('vertical neighbours are EXACTLY 23.6 mm apart, everywhere on the wall', () => {
    let worst = 0;
    for (let q = -60; q <= 60; q++) {
      for (let r = -60; r <= 60; r++) {
        const d = mmDist(hexToMm({ q, r }), hexToMm({ q, r: r + 1 }));
        worst = Math.max(worst, Math.abs(d - PITCH));
      }
    }
    expect(worst).toBeLessThan(EPS);
  });

  it('diagonal neighbours are 23.59983 mm apart — NOT 23.6', () => {
    // The four that are NOT the exact-PITCH pair. In the flat-top frame that
    // exact pair is ±(0,1), so the diagonals are the other four directions.
    const diagonals = [dir(0), dir(2), dir(3), dir(5)]; // (1,0) (-1,1) (-1,0) (1,-1)
    let worst = 0;
    for (let q = -40; q <= 40; q++) {
      for (let r = -40; r <= 40; r++) {
        for (const d of diagonals) {
          const dist = mmDist(hexToMm({ q, r }), hexToMm({ q: q + d.q, r: r + d.r }));
          worst = Math.max(worst, Math.abs(dist - DIAGONAL_NEIGHBOUR));
        }
      }
    }
    expect(worst).toBeLessThan(EPS);

    expect(DIAGONAL_NEIGHBOUR).toBeCloseTo(23.59983, 5);
    // constants.ts builds it as sqrt(a²+b²) (23.599827202757226) while this file
    // measures with Math.hypot (23.59982720275723). Those disagree in the last
    // ulp — 3.55e-15 mm — because hypot uses a scaled algorithm. Not a defect,
    // but it is why this cannot be an exact toBe.
    expect(Math.abs(DIAGONAL_NEIGHBOUR - Math.hypot(STAGGER, ROW_STEP))).toBeLessThan(1e-12);
    expect(DIAGONAL_NEIGHBOUR).toBe(Math.sqrt(STAGGER ** 2 + ROW_STEP ** 2));

    // The point of the whole test: it is measurably LESS than the pitch.
    expect(DIAGONAL_NEIGHBOUR).toBeLessThan(PITCH);
    expect(PITCH - DIAGONAL_NEIGHBOUR).toBeCloseTo(1.7279724e-4, 9);
    // ...and a test that demanded 23.6 here would be asserting the bug D4 warns
    // about, so assert the inequality explicitly rather than a loose closeTo.
    expect(Math.abs(DIAGONAL_NEIGHBOUR - PITCH)).toBeGreaterThan(1e-5);
  });

  it('exactly 2 of the 6 neighbours are at PITCH and 4 are at the diagonal distance', () => {
    const c = hexToMm({ q: 7, r: -3 });
    const ds = hexNeighbours({ q: 7, r: -3 }).map((n) => mmDist(c, hexToMm(n)));
    expect(ds.filter((d) => Math.abs(d - PITCH) < EPS)).toHaveLength(2);
    expect(ds.filter((d) => Math.abs(d - DIAGONAL_NEIGHBOUR) < EPS)).toHaveLength(4);
  });

  it('columns are exactly ROW_STEP apart and staggered by exactly PITCH/2', () => {
    for (let q = -50; q <= 50; q++) {
      expect(hexToMm({ q: q + 1, r: 0 }).x - hexToMm({ q, r: 0 }).x).toBeCloseTo(ROW_STEP, 9);
      expect(hexToMm({ q: q + 1, r: 0 }).y - hexToMm({ q, r: 0 }).y).toBeCloseTo(STAGGER, 9);
    }
  });

  it('hexCorners draws a regular hexagon of the right size, centred on the cell', () => {
    const R = PITCH / Math.sqrt(3);
    for (let q = -4; q <= 4; q++) {
      for (let r = -4; r <= 4; r++) {
        const c = hexToMm({ q, r });
        const cs = hexCorners({ q, r });
        expect(cs).toHaveLength(6);
        for (const p of cs) expect(mmDist(c, p)).toBeCloseTo(R, 9);
        // First corner is the right-hand one: flat-top puts a corner at 0°.
        expect(cs[0]!.x).toBeCloseTo(c.x + R, 9);
        expect(cs[0]!.y).toBeCloseTo(c.y, 9);
        // Across-flats really is PITCH, and on a flat-top cell that is the
        // VERTICAL measurement — the flats are top and bottom.
        const ys = cs.map((p) => p.y);
        expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(PITCH, 9);
        // Side length equals the circumradius, and equals MARGIN_X (§4) — the
        // corner-side margin, which is the X one on a flat-top wall.
        expect(mmDist(cs[0]!, cs[1]!)).toBeCloseTo(R, 9);
        expect(R).toBeCloseTo(MARGIN_X, 6);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. panelCells
// ---------------------------------------------------------------------------

describe('panelCells', () => {
  it('produces exactly columns × rows distinct cells for all 400 combos in 1..20', () => {
    const bad: string[] = [];
    for (let columns = 1; columns <= 20; columns++) {
      for (let rows = 1; rows <= 20; rows++) {
        const cells = panelCells({ q: 3, r: -2 }, columns, rows);
        if (cells.length !== columns * rows) bad.push(`${columns}x${rows} length ${cells.length}`);
        if (new Set(keysOf(cells)).size !== columns * rows) {
          bad.push(`${columns}x${rows} duplicates`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('1×1 is exactly the origin cell', () => {
    expect(panelCells({ q: -4, r: 9 }, 1, 1)).toEqual([{ q: -4, r: 9 }]);
  });

  it('is translation-equivariant in the origin', () => {
    for (let columns = 1; columns <= 12; columns += 3) {
      for (let rows = 1; rows <= 12; rows += 3) {
        const at: Hex = { q: 17, r: -23 };
        const shifted = panelCells(at, columns, rows);
        const base = panelCells(ORIGIN, columns, rows).map((c) => hexAdd(c, at));
        expect(shifted).toEqual(base);
      }
    }
  });

  it('ANTI-SHEAR: the mm width does not grow with the row count', () => {
    // This is the bug that would make big panels overlap. In axial coordinates a
    // "rectangle" is a sheared range, and forgetting the qShift makes the block
    // lean by STAGGER per row.
    for (let columns = 1; columns <= 20; columns++) {
      const widths: number[] = [];
      for (let rows = 2; rows <= 20; rows++) {
        const b = cellsBoundsMm(panelCells({ q: 2, r: 2 }, columns, rows));
        widths.push(b.maxX - b.minX);
      }
      const first = widths[0]!;
      for (const w of widths) expect(Math.abs(w - first)).toBeLessThan(EPS);

      // And what the sheared version WOULD have produced, for contrast:
      const shearedWidth20 = (columns - 1) * PITCH + 19 * STAGGER + 2 * MARGIN_X;
      if (columns <= 19) expect(first).toBeLessThan(shearedWidth20 - 1);
    }
  });

  it('the mm bounding box matches the §4 size formula exactly', () => {
    // Transposed with the frame (D35): the block now runs ROW_STEP across its
    // columns and PITCH down its rows.
    // W = (columns − 1)·ROW_STEP + 2·MARGIN_X and H = PITCH·(rows + 0.5).
    for (let columns = 2; columns <= 20; columns++) {
      for (let rows = 1; rows <= 20; rows++) {
        const b = cellsBoundsMm(panelCells({ q: -5, r: 4 }, columns, rows));
        expect(b.maxX - b.minX).toBeCloseTo((columns - 1) * ROW_STEP + 2 * MARGIN_X, 9);
        expect(b.maxY - b.minY).toBeCloseTo(PITCH * (rows + 0.5), 9);
      }
    }
  });

  it('reproduces the shipped panel at the DESIGNER\'s dimensions: 170.32 wide × 177 tall', () => {
    // wall-honeycomb-part.stl. The block is 8 columns of 7 in the flat-top frame
    // (it was 7 × 8 pointy-top), and this is the whole point of D35: the app now
    // measures this plate the way its own drawing dimensions it — 170.32 wide by
    // 177 tall — where it used to come out transposed at 177 × 170.32.
    const b = cellsBoundsMm(panelCells(ORIGIN, 8, 7));
    expect(b.maxX - b.minX).toBeCloseTo(170.31693, 4);
    expect(b.maxY - b.minY).toBeCloseTo(177.0, 9);
    expect(panelCells(ORIGIN, 8, 7)).toHaveLength(56); // D8: 56 cells, not 28
  });

  it('columns alternate between offset 0 and offset STAGGER — and never drift further', () => {
    const columns = 20;
    const rows = 9;
    const cells = panelCells(ORIGIN, columns, rows);
    const originY = hexToMm(ORIGIN).y;
    for (let q = 0; q < columns; q++) {
      const colCells = cells.filter((c) => c.q === q);
      expect(colCells).toHaveLength(rows);
      const ys = colCells.map((c) => hexToMm(c).y);
      const minY = Math.min(...ys);
      // Odd columns sit half a pitch UP: panelCells staggers by -floor(q/2),
      // which is the parity the meshes actually use in the flat-top frame. See
      // tests/panel-parity.test.ts, which checks the generated cell map against
      // the footprints measured from the STLs.
      const expected = originY + (q % 2 === 0 ? 0 : STAGGER);
      expect(minY).toBeCloseTo(expected, 9);
      // each column is a contiguous run of `rows` cells at exactly PITCH spacing
      ys.sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) {
        expect(ys[i]! - ys[i - 1]!).toBeCloseTo(PITCH, 9);
      }
    }
  });

  it('is a connected block: every cell touches the rest of the panel', () => {
    for (const [columns, rows] of [
      [1, 1],
      [1, 20],
      [20, 1],
      [4, 4],
      [7, 8],
      [20, 20],
    ] as const) {
      const cells = panelCells({ q: 1, r: 1 }, columns, rows);
      const set = new Set(keysOf(cells));
      const seen = new Set<string>([hexKey(cells[0]!)]);
      const queue: Hex[] = [cells[0]!];
      while (queue.length > 0) {
        const cur = queue.pop()!;
        for (const n of hexNeighbours(cur)) {
          const k = hexKey(n);
          if (set.has(k) && !seen.has(k)) {
            seen.add(k);
            queue.push(n);
          }
        }
      }
      expect(seen.size).toBe(columns * rows);
    }
  });

  it('DEGENERATE: zero and negative columns/rows yield an empty panel, no throw', () => {
    for (const [columns, rows] of [
      [0, 0],
      [0, 5],
      [5, 0],
      [-1, 5],
      [5, -1],
      [-7, -9],
      [-0, 3],
    ] as const) {
      expect(() => panelCells(ORIGIN, columns, rows)).not.toThrow();
      expect(panelCells(ORIGIN, columns, rows)).toEqual([]);
    }
  });

  it('DEGENERATE: fractional and non-finite sizes do not hang or throw', () => {
    // A panel is a whole number of cells, so fractional counts floor rather
    // than rounding up: 3.7 columns is 3 columns, not 4.
    expect(panelCells(ORIGIN, 3.7, 1)).toHaveLength(3);
    expect(panelCells(ORIGIN, 0.9, 5)).toEqual([]);
    expect(panelCells(ORIGIN, NaN, 5)).toEqual([]);
    expect(panelCells(ORIGIN, 5, NaN)).toEqual([]);
    expect(panelCells(ORIGIN, -Infinity, 5)).toEqual([]);

    // +Infinity used to spin forever on `c < columns`, so a corrupted document
    // could hang the tab instead of rendering badly. Now bounded — and this
    // test would time out rather than pass if that regressed.
    expect(panelCells(ORIGIN, Infinity, 5)).toEqual([]);
    expect(panelCells(ORIGIN, 5, Infinity)).toEqual([]);
  });
});

describe('cellsBoundsMm', () => {
  it('returns a zero box for an empty set rather than Infinities', () => {
    expect(cellsBoundsMm([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });

  it('a single cell is one full cell wide and one full cell tall', () => {
    const b = cellsBoundsMm([{ q: 5, r: -3 }]);
    expect(b.maxX - b.minX).toBeCloseTo(2 * MARGIN_X, 9);
    expect(b.maxY - b.minY).toBeCloseTo(2 * MARGIN_Y, 9);
  });

  it('contains every cell centre it was given', () => {
    const cells = panelCells({ q: -3, r: 6 }, 11, 7);
    const b = cellsBoundsMm(cells);
    for (const c of cells) {
      const p = hexToMm(c);
      expect(p.x).toBeGreaterThanOrEqual(b.minX);
      expect(p.x).toBeLessThanOrEqual(b.maxX);
      expect(p.y).toBeGreaterThanOrEqual(b.minY);
      expect(p.y).toBeLessThanOrEqual(b.maxY);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Occupancy
// ---------------------------------------------------------------------------

describe('Occupancy', () => {
  const A: Hex[] = [
    { q: 0, r: 0 },
    { q: 1, r: 0 },
  ];
  const B: Hex[] = [
    { q: 1, r: 0 },
    { q: 2, r: 0 },
  ];
  const C: Hex[] = [
    { q: 5, r: 5 },
    { q: 6, r: 5 },
  ];

  it('reports size, occupancy and non-occupancy correctly', () => {
    const occ = new Occupancy();
    expect(occ.size).toBe(0);
    expect(occ.add('a', A)).toBeNull();
    expect(occ.size).toBe(2);
    expect(occ.occupantOf({ q: 0, r: 0 })).toBe('a');
    expect(occ.occupantOf({ q: 9, r: 9 })).toBeUndefined();
  });

  it('rejects an overlapping add and names the incumbent', () => {
    const occ = new Occupancy();
    occ.add('a', A);
    expect(occ.add('b', B)).toBe('a');
  });

  it('a rejected add is atomic — it writes nothing at all', () => {
    // B overlaps A on its FIRST cell here, and on its second in the reverse
    // order; both must leave the map untouched.
    const occ = new Occupancy();
    occ.add('a', A);
    expect(occ.size).toBe(2);
    expect(occ.add('b', B)).toBe('a');
    expect(occ.size).toBe(2);
    expect(occ.occupantOf({ q: 2, r: 0 })).toBeUndefined();

    expect(occ.add('b', [...B].reverse())).toBe('a');
    expect(occ.size).toBe(2);
    expect(occ.occupantOf({ q: 2, r: 0 })).toBeUndefined();
  });

  it('adding an id over its OWN cells is not a conflict', () => {
    const occ = new Occupancy();
    expect(occ.add('a', A)).toBeNull();
    expect(occ.add('a', A)).toBeNull();
    expect(occ.size).toBe(2);
    // ...including a partial overlap with itself, which grows the claim
    expect(occ.add('a', [{ q: 1, r: 0 }, { q: 2, r: 0 }])).toBeNull();
    expect(occ.size).toBe(3);
    expect(occ.occupantOf({ q: 2, r: 0 })).toBe('a');
  });

  it('conflicts() lists the taken cells, and ignoreId excuses the owner', () => {
    const occ = new Occupancy();
    occ.add('a', A);
    occ.add('c', C);
    expect(occ.conflicts(B)).toEqual([{ q: 1, r: 0 }]);
    expect(occ.conflicts(B, 'a')).toEqual([]);
    expect(occ.conflicts(B, 'someone-else')).toEqual([{ q: 1, r: 0 }]);
    expect(occ.conflicts([...A, ...C])).toHaveLength(4);
    expect(occ.conflicts([...A, ...C], 'a')).toHaveLength(2);
    expect(occ.conflicts([])).toEqual([]);
    expect(occ.conflicts([{ q: 99, r: 99 }])).toEqual([]);
  });

  it('remove then re-add is clean, and repeated removal is idempotent', () => {
    const occ = new Occupancy();
    occ.add('a', A);
    occ.remove(A);
    expect(occ.size).toBe(0);
    expect(occ.occupantOf({ q: 0, r: 0 })).toBeUndefined();
    occ.remove(A); // no throw, no negative size
    expect(occ.size).toBe(0);
    expect(occ.add('b', A)).toBeNull();
    expect(occ.occupantOf({ q: 0, r: 0 })).toBe('b');
    expect(occ.size).toBe(2);
  });

  it('treats −0 and +0 coordinates as the same cell (via hexKey)', () => {
    const occ = new Occupancy();
    occ.add('a', [{ q: -0, r: 0 }]);
    expect(occ.occupantOf({ q: 0, r: -0 })).toBe('a');
    expect(occ.size).toBe(1);
  });

  it('FINDING (documented): remove() is unguarded — it will delete another id’s cells', () => {
    // `remove(cells)` never checks who owns the cells. Nothing in the app does
    // this today (removal always passes the item's own footprint back), but the
    // API makes silent cross-deletion a one-line mistake away, and unlike add()
    // there is no return value to notice it.
    const occ = new Occupancy();
    occ.add('a', A);
    occ.remove([{ q: 0, r: 0 }]); // 'b' removing a cell it does not own
    expect(occ.size).toBe(1);
    expect(occ.occupantOf({ q: 0, r: 0 })).toBeUndefined();
  });

  it('matches a reference model over 4,000 randomised operations', () => {
    const occ = new Occupancy();
    const model = new Map<string, string>();
    const rng = makeRng(555);
    const ids = ['a', 'b', 'c', 'd'];
    for (let step = 0; step < 4000; step++) {
      const id = ids[Math.floor(rng() * ids.length)]!;
      const q0 = Math.floor(rng() * 12) - 6;
      const r0 = Math.floor(rng() * 12) - 6;
      const cells: Hex[] = [
        { q: q0, r: r0 },
        { q: q0 + 1, r: r0 },
      ];
      if (rng() < 0.6) {
        // model: reject if any cell is held by someone else
        let blocker: string | null = null;
        for (const c of cells) {
          const held = model.get(hexKey(c));
          if (held !== undefined && held !== id) {
            blocker = held;
            break;
          }
        }
        const got = occ.add(id, cells);
        expect(got).toBe(blocker);
        if (blocker === null) for (const c of cells) model.set(hexKey(c), id);
      } else {
        occ.remove(cells);
        for (const c of cells) model.delete(hexKey(c));
      }
      expect(occ.size).toBe(model.size);
    }
    // and every cell agrees at the end
    for (const [k, v] of model) expect(occ.occupantOf(keyToHex(k))).toBe(v);
  });
});

describe('footprintsOverlap', () => {
  it('agrees with a set intersection over randomised footprints', () => {
    const rng = makeRng(4242);
    for (let i = 0; i < 3000; i++) {
      const mk = (): Hex[] => {
        const n = Math.floor(rng() * 5);
        const out: Hex[] = [];
        for (let j = 0; j < n; j++) {
          out.push({ q: Math.floor(rng() * 6), r: Math.floor(rng() * 6) });
        }
        return out;
      };
      const a = mk();
      const b = mk();
      const expected = a.some((x) => b.some((y) => hexEq(x, y)));
      expect(footprintsOverlap(a, b)).toBe(expected);
      expect(footprintsOverlap(b, a)).toBe(expected); // symmetric
    }
  });

  it('DEGENERATE: empty arrays are false, never a throw', () => {
    expect(footprintsOverlap([], [])).toBe(false);
    expect(footprintsOverlap([], [{ q: 0, r: 0 }])).toBe(false);
    expect(footprintsOverlap([{ q: 0, r: 0 }], [])).toBe(false);
    expect(footprintsOverlap([{ q: 0, r: 0 }], [{ q: 0, r: 0 }])).toBe(true);
    expect(footprintsOverlap([{ q: -0, r: 0 }], [{ q: 0, r: -0 }])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Keys, and hostile input
// ---------------------------------------------------------------------------

describe('hexKey / keyToHex', () => {
  it('round-trips every cell in −40..40, including negatives', () => {
    const failures: string[] = [];
    for (let q = -40; q <= 40; q++) {
      for (let r = -40; r <= 40; r++) {
        const back = keyToHex(hexKey({ q, r }));
        if (back.q !== q || back.r !== r) failures.push(hexKey({ q, r }));
      }
    }
    expect(failures).toEqual([]);
  });

  it('round-trips large magnitudes and both signs', () => {
    for (const h of [
      { q: -1, r: -1 },
      { q: -999999, r: 999999 },
      { q: 1234567, r: -7654321 },
      { q: 0, r: -1 },
      { q: -1, r: 0 },
    ]) {
      expect(keyToHex(hexKey(h))).toEqual(h);
    }
  });

  it('is injective: 6,561 distinct cells give 6,561 distinct keys', () => {
    const keys = new Set<string>();
    for (let q = -40; q <= 40; q++) for (let r = -40; r <= 40; r++) keys.add(hexKey({ q, r }));
    expect(keys.size).toBe(81 * 81);
  });

  it('normalises −0 to "0" so it cannot split a map bucket', () => {
    expect(hexKey({ q: -0, r: -0 })).toBe('0,0');
    expect(keyToHex('0,0')).toEqual({ q: 0, r: 0 });
  });
});

describe('hostile input', () => {
  it('mmToHex does not throw on NaN or ±Infinity, and never invents a finite cell', () => {
    const hostile: Point[] = [
      { x: NaN, y: 0 },
      { x: 0, y: NaN },
      { x: NaN, y: NaN },
      { x: Infinity, y: Infinity },
      { x: -Infinity, y: -Infinity },
      { x: Infinity, y: -Infinity },
      { x: 0, y: Infinity },
      { x: Infinity, y: 0 },
    ];
    for (const p of hostile) {
      expect(() => mmToHex(p)).not.toThrow();
      const h = mmToHex(p);
      // Every one of these degenerates to NaN or ±Infinity. That is honest — a
      // caller can test Number.isFinite, which is what the comment always said
      // to do — but note it is NOT clamped, so a hostile pointer position
      // produces a non-finite cell rather than being rejected at source.
      //
      // Asserted as "not finite" rather than "NaN" since D35. The turn changed
      // the ORDER of the divide and the subtract, so `{x: 0, y: Infinity}` now
      // yields r = Infinity where it used to yield NaN. Both are non-finite and
      // neither is a plausible cell, which is the property that matters.
      expect(!Number.isFinite(h.q) || !Number.isFinite(h.r)).toBe(true);
    }
  });

  it('mmToHex handles ±1e9 mm without throwing and stays on the integer lattice', () => {
    for (const v of [1e9, -1e9, 1e6, -1e6]) {
      for (const p of [{ x: v, y: 0 }, { x: 0, y: v }, { x: v, y: v }, { x: v, y: -v }]) {
        expect(() => mmToHex(p)).not.toThrow();
        const h = mmToHex(p);
        expect(Number.isInteger(h.q)).toBe(true);
        expect(Number.isInteger(h.r)).toBe(true);
        // and it really is a nearest cell, even a kilometre off the wall
        const t = trueNearest(p, h);
        expect(centreDist(p, h) - t.dist).toBeLessThan(ANISOTROPY_MM);
      }
    }
  });

  it('hexRound does not throw on non-finite input', () => {
    for (const [qf, rf] of [
      [NaN, 0],
      [0, NaN],
      [Infinity, 0],
      [0, -Infinity],
      [Infinity, -Infinity],
    ] as const) {
      expect(() => hexRound(qf, rf)).not.toThrow();
    }
  });

  it('hexCorners tolerates a zero or negative across-flats without throwing', () => {
    expect(() => hexCorners(ORIGIN, 0)).not.toThrow();
    expect(hexCorners(ORIGIN, 0)).toHaveLength(6);
    expect(() => hexCorners(ORIGIN, -5)).not.toThrow();
  });

  it('hexAdd / hexSub / hexEq behave on the degenerate cases', () => {
    expect(hexAdd(ORIGIN, ORIGIN)).toEqual(ORIGIN);
    expect(hexSub(ORIGIN, ORIGIN)).toEqual(ORIGIN);
    expect(hexEq(hex(1, 2), { q: 1, r: 2 })).toBe(true);
    expect(hexEq(hex(1, 2), { q: 2, r: 1 })).toBe(false);
    expect(hexEq({ q: -0, r: 0 }, { q: 0, r: 0 })).toBe(true);
    expect(hex(3, -4)).toEqual({ q: 3, r: -4 });
  });

  it('cellsBoundsMm on non-finite cells produces non-finite bounds rather than throwing', () => {
    expect(() => cellsBoundsMm([{ q: NaN, r: 0 }])).not.toThrow();
    const b = cellsBoundsMm([{ q: NaN, r: 0 }]);
    // NaN comparisons are all false, so the Infinity seeds survive untouched.
    // Documented, and a caller that trusts this box will draw nothing.
    expect(Number.isFinite(b.minX)).toBe(false);
  });
});
