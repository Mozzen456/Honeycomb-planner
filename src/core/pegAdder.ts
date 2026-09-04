/**
 * Bolt honeycomb pegs onto somebody else's model.
 *
 * `binModel.ts` generates a whole part. This one takes a part that already
 * exists — an STL or 3MF somebody uploaded — turns it so a face of it meets the
 * wall, works out which lattice cells that face could actually carry a peg in,
 * and welds a peg into each cell the person picks.
 *
 * ---------------------------------------------------------------------------
 * "Only where they fit the pattern"
 * ---------------------------------------------------------------------------
 *
 * Two separate constraints, and they are easy to confuse.
 *
 * THE LATTICE is the easy one and it is absolute: a peg has to sit on a cell
 * centre, so the pick is a `Hex` and never a millimetre. Any set of cells is
 * mountable — the wall is the same lattice everywhere — so the constraint is on
 * the cells RELATIVE to each other and not on where the lattice sits under the
 * part. Which is why `latticeOffset` is free millimetres: sliding the lattice
 * moves every peg together, and a rigid translation cannot take them off it.
 *
 * THE PART is the other one, and it is ADVICE rather than a rule. A peg welded
 * to 0.4 mm of skin comes off with the first load and a peg over nothing prints
 * as a loose piece — so `candidateCells` measures how well each cell is backed
 * and says so, in three grades, and the UI colours them. It does not refuse
 * them. There is no rule here that can know about a part it has never seen: a
 * boss the raster reads as an intrusion, a cell you mean to bridge with your
 * own filler, a peg deliberately outside the silhouette. Every cell the lattice
 * reaches is clickable, cells past the part's own edge included, and what the
 * tool owes you is a straight answer about what you just did.
 *
 * ---------------------------------------------------------------------------
 * Adding is OVERLAP, not a boolean
 * ---------------------------------------------------------------------------
 *
 * There is no polygon boolean in this codebase and D108 is not the place to
 * introduce one. A peg is a SECOND closed solid that overlaps the part by
 * `PEG_SEAT_MM` — which is what putting two objects in a 3MF does, and which
 * every slicer unions. The output is therefore several closed shells rather
 * than one, and `meshIsClosed` still passes: every directed edge has exactly
 * one opposite within its own shell. What it is NOT is one connected component,
 * and that is deliberate rather than an oversight.
 *
 * Overlap and not abut: two solids that merely touch share a zero-thickness
 * contact, and a slicer is entitled to read that as two parts leaning on each
 * other. Hence the seat, and hence `candidateCells` demanding material for the
 * whole of it.
 */

import { PEG, PEG_RADIUS, PITCH } from './constants';
import { hexCoverage, rasterise, type Axis, type Raster } from './detect';
import { hexKey, hexToMm, mmToHex } from './hex';
import type { SolidMesh } from './honeycomb';
import { buildPegSolid, PEG_SEAT_MM } from './pegMesh';
import type { MeshData } from './stl';
import type { Hex } from './types';

// ---------------------------------------------------------------------------
// Which way up the part goes
// ---------------------------------------------------------------------------

/** A rotation, 3x3 row-major. Nine numbers rather than a class, like `Matrix`. */
export type Mat3 = readonly number[];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export interface Orientation {
  /** Which axis of the FILE meets the wall. */
  wallFaceAxis: Axis;
  /** Which end of that axis: `low` is the minimum. */
  matingEnd: 'low' | 'high';
  /** Quarter turns about the wall normal, so the part stands up the right way. */
  quarterTurns: number;
  /**
   * A FREE rotation, in the oriented frame, between the axis choice and the
   * quarter turn. Absent means none, and absent is the ordinary case.
   *
   * The six axis buttons can only ever say "one of these six flats meets the
   * wall", and plenty of models have no such flat: a bracket with a 15° back, a
   * curved shell, anything exported from a scan. So the face you CLICK is laid
   * on the wall at whatever angle it actually is, and that is what this holds.
   *
   * Between the two on purpose. The axis choice is a fact about the FILE, so it
   * belongs innermost; the quarter turn is "which way up does it read once it is
   * on the wall", so it belongs outermost — it must stay a turn about the wall
   * normal even after a tilt has moved which direction that is.
   */
  tilt?: Mat3;
}

export interface PegPlan extends Orientation {
  /**
   * Where cell (0, 0) sits in the wall plane, in millimetres.
   *
   * FREE, and that is the point: sliding the lattice moves every peg together,
   * so it cannot take them off the lattice. Only the cells relative to one
   * another are constrained.
   */
  latticeOffset: { x: number; y: number };
  /** The cells that carry a peg. */
  cells: Hex[];
}

export const DEFAULT_ORIENTATION: Orientation = {
  wallFaceAxis: 'z',
  matingEnd: 'low',
  quarterTurns: 0,
};

// ---------------------------------------------------------------------------
// Rotations
// ---------------------------------------------------------------------------

/** `a` applied AFTER `b` — the order composition actually reads in. */
export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return out;
}

/** A rotation's inverse is its transpose, and saying so avoids a solver. */
export const mat3Transpose = (m: Mat3): Mat3 => [
  m[0]!, m[3]!, m[6]!,
  m[1]!, m[4]!, m[7]!,
  m[2]!, m[5]!, m[8]!,
];

export const mat3Apply = (m: Mat3, v: readonly number[]): [number, number, number] => [
  m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!,
  m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!,
  m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!,
];

const isIdentity3 = (m: Mat3): boolean =>
  IDENTITY3.every((x, i) => Math.abs((m[i] ?? 0) - x) < 1e-12);

/**
 * The exact permutation that puts `wallFaceAxis`/`matingEnd` against the wall.
 *
 * Entries are 0 and ±1, so composing with it is bit-exact — which is why the
 * six buttons still produce the same numbers they always did, matrix or no
 * matrix. A `high` end is a 180° TURN and not a negated axis: negating one on
 * its own is a reflection, and a mirrored part is a left-hand hook on a
 * right-hand wall.
 */
export function permutationFor(axis: Axis, end: 'low' | 'high'): Mat3 {
  const [ui, vi, wi] = AXIS_INDEX[axis];
  const flip = end === 'high' ? -1 : 1;
  const row = (index: number, scale: number): number[] => {
    const r = [0, 0, 0];
    r[index] = scale;
    return r;
  };
  // Rows are the oriented frame's own order: out, across, up.
  return [...row(wi, flip), ...row(ui, 1), ...row(vi, flip)];
}

/**
 * `n` quarter turns about the wall normal, in the oriented frame.
 *
 * Out is untouched and (across, up) go to (−up, across), which is exactly what
 * the old inline loop did to (a, v) — the turn was always a rotation about out,
 * so moving it outside the permutation changes nothing and lets it stay a turn
 * about the wall normal once a tilt is in between.
 */
export function turnMatrix(quarterTurns: number): Mat3 {
  const t = ((quarterTurns % 4) + 4) % 4;
  let m: Mat3 = IDENTITY3;
  const one: Mat3 = [1, 0, 0, 0, 0, -1, 0, 1, 0];
  for (let i = 0; i < t; i++) m = mat3Mul(one, m);
  return m;
}

/** File to oriented, in one matrix: the turn, then the tilt, then the axis. */
export function orientationMatrix(o: Orientation): Mat3 {
  const base = permutationFor(o.wallFaceAxis, o.matingEnd);
  const tilted = o.tilt === undefined ? base : mat3Mul(o.tilt, base);
  return mat3Mul(turnMatrix(o.quarterTurns), tilted);
}

/**
 * The shortest rotation taking unit `from` to unit `to`.
 *
 * Shortest because there is no other information: the click says which way the
 * surface faces and nothing about how the part should be spun around it, so any
 * extra rotation would be invented. Rodrigues, with the antiparallel case taken
 * by hand — there the axis is undefined and any perpendicular one is a correct
 * 180° turn, so one is chosen from whichever coordinate of `from` is smallest,
 * which cannot be parallel to it.
 */
export function shortestArc(from: readonly number[], to: readonly number[]): Mat3 {
  const norm = (v: readonly number[]): [number, number, number] => {
    const len = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
    return [v[0]! / len, v[1]! / len, v[2]! / len];
  };
  const f = norm(from);
  const t = norm(to);
  const dot = f[0] * t[0] + f[1] * t[1] + f[2] * t[2];
  if (dot > 1 - 1e-12) return IDENTITY3;

  let axis: [number, number, number] = [
    f[1] * t[2] - f[2] * t[1],
    f[2] * t[0] - f[0] * t[2],
    f[0] * t[1] - f[1] * t[0],
  ];
  let angle = Math.acos(Math.max(-1, Math.min(1, dot)));
  if (Math.hypot(...axis) < 1e-9) {
    // Antiparallel: half a turn about anything perpendicular to `from`.
    const abs = [Math.abs(f[0]), Math.abs(f[1]), Math.abs(f[2])];
    const k = abs.indexOf(Math.min(...abs));
    const other = [0, 0, 0];
    other[k] = 1;
    axis = [
      f[1] * other[2]! - f[2] * other[1]!,
      f[2] * other[0]! - f[0] * other[2]!,
      f[0] * other[1]! - f[1] * other[0]!,
    ];
    angle = Math.PI;
  }
  const [x, y, z] = norm(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = 1 - c;
  return [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
}

/**
 * The part in the WALL's frame, and in the file frame the output is written in:
 * +x out of the wall, +y across it, +z up it.
 *
 * The wall face is at x = 0 and the part is at x ≥ 0, so a peg runs to negative
 * x. Across is centred on the part; up starts at zero, because that is where a
 * printer's bed is and the file is written to sit on it.
 */
export interface OrientedPart {
  positions: Float64Array;
  triangleCount: number;
  /** Out of the wall, across it, up it. */
  sizeMm: [number, number, number];
}

/**
 * The six axis permutations, as `detect.AXES` gives them: (u, v, w) where w is
 * the axis that meets the wall. Cyclic, therefore rotations — an acyclic
 * permutation is a reflection, and a mirrored part is a left-hand hook on a
 * right-hand wall.
 */
const AXIS_INDEX: Record<Axis, [number, number, number]> = {
  z: [0, 1, 2],
  x: [1, 2, 0],
  y: [2, 0, 1],
};

/**
 * Put an uploaded mesh into the wall frame.
 *
 * A `high` mating end is a 180° TURN and not a negated w: negating one axis on
 * its own is a reflection. Same rule, same reason, as `meshLibrary.orient`.
 */
export function orientForPegs(mesh: MeshData, o: Orientation): OrientedPart {
  const m = orientationMatrix(o);
  const src = mesh.positions;
  const n = mesh.triangleCount * 3;

  const across = new Float64Array(n);
  const up = new Float64Array(n);
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const i = k * 3;
    const x = src[i]!;
    const y = src[i + 1]!;
    const z = src[i + 2]!;
    // One matrix, whose rows ARE the oriented frame: out, across, up. With no
    // tilt every entry is 0 or ±1, so this is the same arithmetic the axis
    // permutation and the quarter-turn loop did, to the bit.
    out[k] = m[0]! * x + m[1]! * y + m[2]! * z;
    across[k] = m[3]! * x + m[4]! * y + m[5]! * z;
    up[k] = m[6]! * x + m[7]! * y + m[8]! * z;
  }

  const span = (arr: Float64Array): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of arr) {
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    return [lo, hi];
  };
  const [a0, a1] = span(across);
  const [u0, u1] = span(up);
  const [w0, w1] = span(out);
  const aMid = (a0 + a1) / 2;

  const positions = new Float64Array(n * 3);
  for (let k = 0; k < n; k++) {
    positions[k * 3] = out[k]! - w0; // wall face at zero
    positions[k * 3 + 1] = across[k]! - aMid; // centred
    positions[k * 3 + 2] = up[k]! - u0; // standing on the bed
  }
  return {
    positions,
    triangleCount: mesh.triangleCount,
    sizeMm: [w1 - w0, a1 - a0, u1 - u0],
  };
}

/**
 * Where a FILE-frame direction points once the part has been oriented.
 *
 * The same signed permutation `orientForPegs` applies to positions, on a
 * direction: no centring, because a direction has no position. Written as its
 * own function rather than inlined so the two cannot drift — an orientation
 * that moved the mesh one way and its normals another would be the hardest kind
 * of bug to see, since everything would still look like a part.
 */
export function orientedDirection(
  o: Orientation,
  dir: readonly [number, number, number],
): [number, number, number] {
  return mat3Apply(orientationMatrix(o), dir);
}

/**
 * Point at a face, and get the orientation that lays it on the wall.
 *
 * `normal` is the clicked surface's normal in the ORIENTED frame — which is
 * what the view has, since it draws the oriented part.
 *
 * **At whatever angle it actually is.** The first version of this snapped to
 * the nearest of the six axis faces, and that is the same tool the six buttons
 * already were: it cannot help the models that need help. A bracket with a 15°
 * back, a curved shell, anything off a scanner — none of them has a flat square
 * to the file's axes, so "nearest" always meant "wrong by up to 45°". The
 * surface you clicked goes flat on the wall.
 *
 * The rotation is the SHORTEST arc taking that normal to −out, because the
 * click carries no information about how the part should be spun around it —
 * anything more would be invented. Spinning it is what the quarter turn is for,
 * which is why the turn stays OUTSIDE the tilt and keeps meaning "about the
 * wall normal"; the conjugation here is what preserves that while leaving the
 * turn the person chose alone.
 *
 * Clicking the face already against the wall is exactly the identity — the
 * commonest accidental click has to be a no-op — and the tilt collapses back to
 * absent when it is, so an untilted orientation stays untilted.
 */
export function faceTowardWall(
  o: Orientation,
  normal: readonly [number, number, number],
): Orientation {
  const turn = turnMatrix(o.quarterTurns);
  const q = shortestArc(normal, [-1, 0, 0]);
  const tilt = mat3Mul(
    mat3Mul(mat3Transpose(turn), q),
    mat3Mul(turn, o.tilt ?? IDENTITY3),
  );
  return isIdentity3(tilt) ? { ...o, tilt: undefined } : { ...o, tilt };
}

/**
 * The face with the most cells on it, tried rather than guessed.
 *
 * Opening on an arbitrary face and reporting "0 of 13 can take a peg" is a tool
 * that looks broken on its first screen. Six rasters is cheap, and the answer is
 * the same thing the person would have found by pressing all six buttons.
 *
 * The quarter turn is NOT searched. It does change which cells land on the part
 * — a hex lattice has no 90° symmetry — but it is the one part of the
 * orientation that is a human judgement: which way up the part reads.
 */
export function bestFace(mesh: MeshData): Orientation {
  let best = DEFAULT_ORIENTATION;
  let most = -1;
  for (const wallFaceAxis of ['x', 'y', 'z'] as const) {
    for (const matingEnd of ['low', 'high'] as const) {
      const o: Orientation = { wallFaceAxis, matingEnd, quarterTurns: 0 };
      const part = orientForPegs(mesh, o);
      const offset = { x: 0, y: part.sizeMm[2] / 2 };
      const count = candidateCells(part, offset).filter((c) => c.backing === 'solid').length;
      if (count > most) {
        most = count;
        best = o;
      }
    }
  }
  return best;
}

/** The oriented part as a `MeshData`, for the raster. */
const asMesh = (part: OrientedPart): MeshData => ({
  positions: Float32Array.from(part.positions),
  triangleCount: part.triangleCount,
  format: 'binary',
});

// ---------------------------------------------------------------------------
// Where a peg could go
// ---------------------------------------------------------------------------

/**
 * Where cell `c` sits in the wall plane, given where the lattice has been slid.
 *
 * A DIFFERENCE of two `hexToMm`s, which is anchor-free and always safe (D76) —
 * and it goes through `hexToMm` rather than multiplying by ROW_STEP, because
 * every private copy of this embedding in the repo's history has been wrong.
 */
export function cellPointMm(cell: Hex, offset: { x: number; y: number }): { x: number; y: number } {
  const zero = hexToMm({ q: 0, r: 0 });
  const p = hexToMm(cell);
  return { x: p.x - zero.x + offset.x, y: p.y - zero.y + offset.y };
}

/** The inverse: which cell is nearest this point. */
export function cellAtMm(point: { x: number; y: number }, offset: { x: number; y: number }): Hex {
  const zero = hexToMm({ q: 0, r: 0 });
  return mmToHex({ x: point.x - offset.x + zero.x, y: point.y - offset.y + zero.y });
}

/**
 * How much of the peg hexagon the wall face has to cover to count as SOLID.
 *
 * Not 1.0. The check is a raster at `PROBE_MM`, so the hexagon's own boundary
 * lands mid-sample and a perfectly solid face reads a shade under — 0.98 is
 * inside that noise and still separates a whole hexagon from one hanging a
 * fifth of itself over an edge.
 */
export const MIN_BACKING = 0.98;

/**
 * ...and how much of it may have anything else inside the seat depth.
 *
 * See `candidateCells` for what "anything else" is and why its ABSENCE is the
 * test. A couple of per cent for raster noise at a boundary the hexagon happens
 * to graze.
 */
export const MAX_INTRUSION = 0.03;

/** Below this the face is bare: a peg there would print as a loose piece. */
const TOUCHING = 0.02;

const PROBE_MM = 0.4;

/**
 * How far past the part's own silhouette cells are still offered.
 *
 * One lattice row. Enough for a peg that overhangs an edge on purpose, or that
 * bridges to something the person will add themselves; not so far that the
 * lattice fills the screen with cells nothing could ever use.
 */
export const OUTSIDE_MM = PITCH;

/**
 * How well a cell is backed. NOT whether it is allowed — every cell is.
 *
 *   - `solid`   the part is solid across the whole hexagon for the whole seat;
 *   - `partial` some of the hexagon is on the part, some is not, or something
 *               is in the way inside the seat depth. It will hold, less well;
 *   - `bare`    nothing under it. The peg prints as a separate piece.
 */
export type Backing = 'solid' | 'partial' | 'bare';

export interface Candidate {
  cell: Hex;
  /** Wall-plane position, for drawing. */
  atMm: { x: number; y: number };
  backing: Backing;
  /** How much of the hexagon the face covers, 0–1. For the tooltip. */
  coverage: number;
}

/**
 * Every cell the lattice reaches, and how well the part backs each one.
 *
 * Reaches, not covers: the range runs `OUTSIDE_MM` past the silhouette, because
 * a peg outside the part is a legitimate thing to ask for and refusing to draw
 * the cell is refusing to have the conversation.
 *
 * TWO probes, and the second one is the interesting half.
 *
 *   - the FACE probe is a slab at the wall face. A triangle crossing it fills
 *     the raster there, so this says "the part's surface is under the whole
 *     hexagon" — a cell over a hole, or off the edge, or over a region that
 *     never reaches the wall plane, fails it;
 *   - the SEAT probe is a slab from just behind the face to `PEG_SEAT_MM`, and
 *     the cell passes when that slab is EMPTY.
 *
 * The second one reads backwards until you remember what a mesh is. A solid
 * has no triangles inside it — only on its surface — so a part that really is
 * solid through the seat depth has NOTHING in that slab. Anything the raster
 * does find there is a surface where there should be material: a back face
 * (the part is skin), the wall of a hole, or the part's own rim. That is why the
 * first version of this asked for coverage in the deep slab and offered no cell
 * anywhere: it was measuring the silhouette's outline and calling it solidity.
 *
 * It is deliberately a shade STRICT — a rib or a countersink within 3 mm of the
 * face will refuse cells that would in fact hold — because the two ways of being
 * wrong are not equal. Refusing a good cell costs a nudge of the lattice;
 * offering a bad one costs a peg that comes off the part under load.
 */
export function candidateCells(
  part: OrientedPart,
  offset: { x: number; y: number },
): Candidate[] {
  const mesh = asMesh(part);
  const face: Raster = rasterise(mesh, 'x', PROBE_MM, { lo: 0, hi: 0.6 });
  const seat: Raster = rasterise(mesh, 'x', PROBE_MM, { lo: 0.6, hi: PEG_SEAT_MM });

  const halfA = part.sizeMm[1] / 2;
  const corners = [
    { x: -halfA - OUTSIDE_MM, y: -OUTSIDE_MM },
    { x: halfA + OUTSIDE_MM, y: -OUTSIDE_MM },
    { x: -halfA - OUTSIDE_MM, y: part.sizeMm[2] + OUTSIDE_MM },
    { x: halfA + OUTSIDE_MM, y: part.sizeMm[2] + OUTSIDE_MM },
  ].map((p) => cellAtMm(p, offset));

  const qs = corners.map((c) => c.q);
  const rs = corners.map((c) => c.r);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (let q = Math.min(...qs) - 2; q <= Math.max(...qs) + 2; q++) {
    for (let r = Math.min(...rs) - 2; r <= Math.max(...rs) + 2; r++) {
      const cell = { q, r };
      if (seen.has(hexKey(cell))) continue;
      seen.add(hexKey(cell));
      const atMm = cellPointMm(cell, offset);
      // Far enough outside that nobody could mean it.
      if (
        atMm.x + PEG_RADIUS < -halfA - OUTSIDE_MM ||
        atMm.x - PEG_RADIUS > halfA + OUTSIDE_MM ||
        atMm.y + PEG_RADIUS < -OUTSIDE_MM ||
        atMm.y - PEG_RADIUS > part.sizeMm[2] + OUTSIDE_MM
      ) {
        continue;
      }
      const coverage = hexCoverage(face, atMm.x, atMm.y, PEG.acrossFlats, 'flat');
      const intruding = hexCoverage(seat, atMm.x, atMm.y, PEG.acrossFlats, 'flat');
      const backing: Backing =
        coverage >= MIN_BACKING && intruding <= MAX_INTRUSION
          ? 'solid'
          : coverage > TOUCHING
            ? 'partial'
            : 'bare';
      out.push({ cell, atMm, backing, coverage });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The output
// ---------------------------------------------------------------------------

/**
 * The part with its pegs, ready for `toBinaryStl`.
 *
 * A concatenation. See the note at the top about why that is the answer and not
 * a shortcut: the pegs overlap the part by the seat, and the slicer unions them.
 */
export function buildPeggedMesh(part: OrientedPart, plan: PegPlan): SolidMesh {
  const pegs = plan.cells.map((cell) => {
    const at = cellPointMm(cell, plan.latticeOffset);
    return buildPegSolid({ a: at.x, u: at.y });
  });
  const extra = pegs.reduce((n, p) => n + p.positions.length, 0);
  const positions = new Float64Array(part.positions.length + extra);
  positions.set(part.positions, 0);
  let at = part.positions.length;
  for (const peg of pegs) {
    positions.set(peg.positions, at);
    at += peg.positions.length;
  }
  return {
    positions,
    triangleCount: part.triangleCount + pegs.reduce((n, p) => n + p.triangleCount, 0),
  };
}

// ---------------------------------------------------------------------------
// Saying what is wrong with it
// ---------------------------------------------------------------------------

export interface PegReview {
  /**
   * Stops the download. NOTHING does, any more.
   *
   * It used to refuse a plan with no pegs — and that turned out to block the
   * most ordinary thing anybody would want from a tool that reads 3MF and
   * writes STL: converting a file. No pegs is a legitimate answer, and what
   * comes out is the model in the orientation on screen, as an STL. Kept as a
   * field because a future rule might need it, and because the UI already reads
   * it.
   */
  errors: string[];
  /** Worth reading first. */
  warnings: string[];
  /** How many pegs put their bottom flat on the bed, and how many bridge. */
  onBed: number;
  bridging: number;
  /** How the chosen pegs are backed. */
  solid: number;
  partial: number;
  bare: number;
}

/**
 * What is wrong with this plan, in the order somebody needs to hear it.
 *
 * The printing note is the same fact `binModel.topRowBridgesMm` reports and is
 * measured the same way: a peg prints without support only when its bottom flat
 * is ON the bed, which for an arbitrary part means only the lowest row of pegs,
 * and only when the part's own lowest point is at that height.
 */
export function reviewPegs(part: OrientedPart, plan: PegPlan): PegReview {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (plan.cells.length === 1) {
    warnings.push('One peg is a pivot. Two or more stop the part turning on the wall.');
  }

  /*
   * How the pegs somebody actually picked are backed.
   *
   * Said, never refused. The `bare` line matters most and is the one thing here
   * that changes what comes out of the printer rather than how well it holds: a
   * peg with nothing under it is a separate object in the file.
   */
  const grade = new Map(
    candidateCells(part, plan.latticeOffset).map((c) => [hexKey(c.cell), c.backing]),
  );
  let solid = 0;
  let partial = 0;
  let bare = 0;
  for (const cell of plan.cells) {
    const backing = grade.get(hexKey(cell)) ?? 'bare';
    if (backing === 'solid') solid++;
    else if (backing === 'partial') partial++;
    else bare++;
  }
  if (bare > 0) {
    warnings.push(
      bare === 1
        ? 'One peg has no part behind it and will come out as a loose piece, unless something '
          + 'else in your file reaches it.'
        : `${bare} pegs have no part behind them and will come out as loose pieces, unless `
          + 'something else in your file reaches them.',
    );
  }
  if (partial > 0) {
    warnings.push(
      `${partial} peg${partial === 1 ? ' is' : 's are'} only partly on the part. ` +
        'That will hold, less well than a peg with solid material all round it.',
    );
  }

  const seat = PEG.acrossFlats / 2;
  let onBed = 0;
  for (const cell of plan.cells) {
    if (Math.abs(cellPointMm(cell, plan.latticeOffset).y - seat) < 0.2) onBed++;
  }
  const bridging = plan.cells.length - onBed;
  if (bridging > 0) {
    warnings.push(
      `${bridging} peg${bridging === 1 ? '' : 's'} will bridge ${PEG.lengthMm} mm when printed ` +
        'in this orientation — there is nowhere to support a peg that is not inside the ' +
        "wall's own socket. Print with part cooling on.",
    );
  }
  return { errors, warnings, onBed, bridging, solid, partial, bare };
}

/** The peg layout in a sentence, read back off `hexToMm`. */
export function pegLayoutNote(plan: PegPlan): string {
  if (plan.cells.length === 0) return 'no pegs yet';
  if (plan.cells.length === 1) return '1 peg';
  const points = plan.cells.map((c) => hexToMm(c));
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  return (
    `${plan.cells.length} pegs, spanning ${w.toFixed(3)} × ${h.toFixed(3)} mm ` +
    'on the lattice'
  );
}
