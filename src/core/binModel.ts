/**
 * The parametric wall BIN: an open-top box that hangs on hexagonal pegs.
 *
 * `honeycomb.ts` generates the WALL. This generates something to hang on it, on
 * the same lattice and out of the same constants, so a bin somebody typed a
 * width into lands on the cells a plate somebody printed actually has.
 *
 * ---------------------------------------------------------------------------
 * The one thing this module exists to get right
 * ---------------------------------------------------------------------------
 *
 * The peg centres. Everything else here is a box.
 *
 * A peg has to sit on a CELL CENTRE, and the only horizontal step that keeps two
 * cells at the same height is `SAME_ROW_STEP` — 2·ROW_STEP = 40.876 mm — because
 * the columns stagger by half a pitch. One column across would put the next peg
 * 11.8 mm up: a real lattice position, but not one a level row of pegs can use.
 * The four shipped shelves are the proof — they differ in width by exactly
 * 2·ROW_STEP each, and shelf-2's two pegs measure 4·ROW_STEP = 81.752 mm apart.
 *
 * Vertically the step is `PITCH`, 23.6 mm, straight up a column.
 *
 * How far apart to space them is `pegStep`, and it is the widest whole number of
 * same-row steps the bin's own width allows. That was arrived at from the
 * mechanics — two pegs 41 mm apart in the middle of a 187 mm bin let it rock —
 * and then found to be what the designer already did on all four shelves.
 *
 * So the peg grid is `SAME_ROW_STEP × PITCH`, it is a genuine sub-lattice of the
 * honeycomb, and `cellsFor` names those cells in the app's own axial coordinates
 * rather than reconstructing them from millimetres. `tests/bin-model.test.ts`
 * closes the loop the other way: it puts every peg centre through `hexToMm` and
 * demands an exact match. Never write `q * 20.438` in this file — see the
 * standing rule in CLAUDE.md about re-deriving the embedding.
 *
 * ---------------------------------------------------------------------------
 * Which way up it is drawn, and why that is not arbitrary
 * ---------------------------------------------------------------------------
 *
 * File frame: +x OUT of the wall, +y across it, +z UP it, with z = 0 at the
 * bottom of the part. That is the PRINT orientation — drop the STL in a slicer
 * and it is already sitting on the bed the way it should be printed — and it is
 * also a legal mounting for this app: `wallFaceAxis: 'x'`, `matingEnd: 'low'`.
 *
 * Those two agreeing is a constraint, not a coincidence. `AXES` in `detect.ts`
 * offers only the three CYCLIC permutations, because an acyclic one is a
 * reflection and a mirrored accessory is a left-hand hook on a right-hand wall.
 * Of the three, this is the one that puts up-the-wall on +z.
 *
 * The print orientation itself is forced by the peg. Mounted, a peg is a
 * horizontal hexagonal prism, so it prints without support only when its bottom
 * FLAT is on the bed — which is exactly why the shipped shelves are drawn lying
 * down with their pegs' bottom flats at z = 0, and why `PEG_PROFILE` drafts five
 * faces and leaves the sixth alone. This keeps that: the bottom row of pegs sits
 * on the bed and prints with nothing whatever in the air. The top row cannot —
 * see `topRowBridgesMm`, which says so rather than hiding it.
 *
 * ---------------------------------------------------------------------------
 * The shape: one outline, extruded
 * ---------------------------------------------------------------------------
 *
 * Everything except the flat back panel is a single rounded-rectangle OUTLINE
 * extruded up the wall (`roundedProfile`, and section 3). That is what makes the
 * corners free: the build direction is up the wall, so a fillet on the outline
 * is a fillet on four VERTICAL edges and every face stays vertical. Rounding the
 * horizontal edges would cost an overhang, and is not done.
 *
 * The outline's closing segment is the flat part of the back panel — the one
 * stretch that is not a plain wall, because it carries the peg holes. So
 * `backHalf = halfW − r` and NOT `halfW` bounds every peg, hole and split in
 * this file: past that line the panel is curving away and there is nothing there
 * to hold a peg. `minWidthMm` carries `2 × CORNER_RADIUS_MM` for the same
 * reason.
 *
 * ---------------------------------------------------------------------------
 * Watertight, and why the arithmetic is written the way it is
 * ---------------------------------------------------------------------------
 *
 * `meshIsClosed` compares vertices EXACTLY, on purpose (see its note). So two
 * faces that meet have to be built from bit-identical expressions, not from two
 * algebraically equal ones: `(A - 2*s + b)/√3` and `(A - s)/√3` agree to the last
 * bit when s and b are 0 and would not if either were computed a different way.
 *
 * That is why `pegRing` uses closed forms rather than intersecting planes, and
 * why the back panel's holes read their outline OFF the peg's own d = 0 ring
 * instead of recomputing a half-width. It is the same discipline
 * `cornerPositions` applies in `honeycomb.ts`, for the same reason: a mesh full
 * of 1e-16 cracks is one a slicer refuses or silently "repairs".
 */

import { PEG, PEG_RADIUS, PITCH, SAME_ROW_STEP } from './constants';
import { hexToMm, mmToHex } from './hex';
import { buildPegSolid, PEG_SEAT_MM } from './pegMesh';
import type { SolidMesh } from './honeycomb';
import type { Hex } from './types';

// ---------------------------------------------------------------------------
// What a bin may be
// ---------------------------------------------------------------------------

/**
 * What a person asks for, and it is the INSIDE of the bin.
 *
 * Every dimension here is the usable cavity, because that is the question
 * somebody sizing a bin is actually asking — will the box of screws go in it,
 * does it clear the shelf above. The outside is a consequence, and `outerMm`
 * is the one place that derives it.
 *
 * The fields are named `inner…` on purpose. This started out as outside
 * measurements, and a rename is what forces every reader to say which it meant
 * rather than carrying on with a field that quietly changed meaning underneath
 * it — the failure mode this repo keeps paying for (D50, D52, D66, D71).
 */
export interface BinSpec {
  /** Pegs across, ≥ 2. One peg is a pivot, not a mounting. */
  pegs: number;
  /** Usable width INSIDE. Free millimetres — only the PEGS hit the lattice. */
  innerWidthMm: number;
  /** Usable height inside, floor to rim. */
  innerHeightMm: number;
  /** Usable depth inside, back wall to front wall. */
  innerDepthMm: number;
  /** Wall, floor and back thickness. */
  wallMm: number;
  /**
   * The cells the pegs go in, when somebody has placed them by hand.
   *
   * Absent means AUTOMATIC: `pegs` across, spread by `pegStep`, on the bottom
   * row and the top one. Present means those numbers no longer decide anything
   * and this list does — which is why `latticeOffset` comes with it.
   */
  cells?: readonly Hex[];
  /**
   * Where cell (0, 0) sits on the back panel, in millimetres, FROZEN at the
   * moment the pegs were taken over by hand.
   *
   * The automatic layout's origin moves with the peg count and with the width
   * (a wider bin spreads the pegs further, which slides the first one). Hand-
   * placed cells must not move when the bin is resized, so the offset stops
   * being derived and starts being remembered. Same idea as the peg adder's:
   * the offset is free millimetres, and only the cells relative to each other
   * have to be on the lattice.
   */
  latticeOffset?: { x: number; y: number };
}

export const MIN_PEGS = 2;
export const MAX_PEGS = 8;

/** Material each side of the outermost peg, so the corner is not a knife edge. */
export const MIN_PEG_MARGIN_MM = 4;

/** Material above the top peg, for the same reason. */
export const PEG_TOP_MARGIN_MM = 2;

/**
 * Radius of the four VERTICAL edges.
 *
 * Rounded corners are how the reference generator's bins look, and here they are
 * free: the build direction is up the wall, so the corners are a fillet on an
 * EXTRUSION PROFILE — every face stays vertical and nothing overhangs. Rounding
 * the horizontal edges would not be free, and is not done.
 *
 * A fixed radius rather than a fraction of the width, because it is a physical
 * thing — how the corner feels in the hand, and how much material is behind it —
 * not a proportion. It costs `2 × CORNER_RADIUS_MM` off the flat part of the
 * back panel, which is why `minWidthMm` carries it.
 */
export const CORNER_RADIUS_MM = 8;

/** Straight segments per 90° of corner. Six reads as a curve at any size. */
const ARC_STEPS = 6;

/* All four are INSIDE measurements, like the spec. */
export const MIN_DEPTH_MM = 10;
export const MAX_DEPTH_MM = 250;
export const MAX_WIDTH_MM = 400;
export const MAX_HEIGHT_MM = 300;

export const MIN_WALL_MM = 1.6;
export const MAX_WALL_MM = 5;
export const DEFAULT_WALL_MM = 2.4;

/**
 * The narrowest INSIDE a bin with this many pegs may have.
 *
 * Not a style choice: the pegs are placed first and the box drawn round them, so
 * below this the outermost hexagon runs off the flat part of the back panel and
 * the panel is open at the corner. Stated inside, so it takes the wall off
 * again — the constraint is really on the outside, and this is the one place
 * that translates it.
 */
export const minWidthMm = (pegs: number, wallMm: number): number =>
  (pegs - 1) * SAME_ROW_STEP +
  PEG.acrossCorners +
  2 * (MIN_PEG_MARGIN_MM + CORNER_RADIUS_MM) -
  2 * wallMm;

/**
 * The shallowest INSIDE that still leaves a back panel covering a whole peg.
 *
 * The outside is this plus the floor, so a peg — 13.45 mm tall, sitting its
 * bottom flat on the bed — is covered with material to spare. Below it the hole
 * would run off the top of the panel, which the band code does not model and a
 * printer could not use.
 */
export const minHeightMm = (): number => PEG.acrossFlats;

/**
 * The OUTSIDE of the box, derived from the inside. The only place that does.
 *
 * Width and depth take a wall on each side; height takes the floor and nothing
 * at the top, because the top is open.
 */
export function outerMm(spec: BinSpec): {
  widthMm: number;
  depthMm: number;
  heightMm: number;
} {
  const s = normaliseBinSpec(spec);
  return {
    widthMm: s.innerWidthMm + 2 * s.wallMm,
    depthMm: s.innerDepthMm + 2 * s.wallMm,
    heightMm: s.innerHeightMm + s.wallMm,
  };
}

/**
 * The two corner radii: the outer silhouette's, and the cavity's.
 *
 * The inner one is the outer less the wall, so the wall keeps its thickness
 * round the corner — clamped off zero, because a cavity with a mathematically
 * sharp corner would put two profile points on top of each other and every
 * triangle between them would come out degenerate. Both are clamped to the room
 * the box actually has, so a 15 mm-deep bin gets a smaller radius rather than a
 * profile that has turned itself inside out.
 */
export function cornerRadii(spec: BinSpec): { outer: number; inner: number } {
  const s = normaliseBinSpec(spec);
  const box = outerMm(s);
  // A THIRD of the smaller side, not a half: at a half a shallow bin comes out a
  // lozenge with a millimetre of flat front, which is not what a rounded corner
  // is meant to look like. A third leaves the flat a third of the side.
  const outer = Math.max(0.6, Math.min(CORNER_RADIUS_MM, Math.min(box.widthMm, box.depthMm) / 3));
  const room = Math.min(s.innerWidthMm, s.innerDepthMm) / 2 - 0.6;
  const inner = Math.max(0.6, Math.min(outer - s.wallMm, room));
  return { outer, inner };
}

export class BinModelError extends Error {}

/**
 * A spec brought into range, and the ONE place the limits are applied.
 *
 * The UI clamps as a slider moves and the model clamps again on the way in,
 * because a spec also arrives from a stored document and from a test. Same
 * function both times, so a bin can never be built from numbers the UI would
 * have refused.
 */
export function normaliseBinSpec(spec: BinSpec): BinSpec {
  const clamp = (v: number, lo: number, hi: number): number =>
    !Number.isFinite(v) ? lo : Math.min(hi, Math.max(lo, v));

  const pegs = Math.round(clamp(spec.pegs, MIN_PEGS, MAX_PEGS));
  const wallMm = clamp(spec.wallMm, MIN_WALL_MM, MAX_WALL_MM);
  const innerWidthMm = clamp(spec.innerWidthMm, minWidthMm(pegs, wallMm), MAX_WIDTH_MM);
  const innerHeightMm = clamp(spec.innerHeightMm, minHeightMm(), MAX_HEIGHT_MM);
  const innerDepthMm = clamp(spec.innerDepthMm, MIN_DEPTH_MM, MAX_DEPTH_MM);
  const out: BinSpec = { pegs, innerWidthMm, innerHeightMm, innerDepthMm, wallMm };
  // Carried through untouched: a hand-placed cell is a decision, and clamping a
  // decision is how the offset would silently stop matching the cells.
  if (spec.cells) out.cells = [...spec.cells];
  if (spec.latticeOffset) out.latticeOffset = { ...spec.latticeOffset };
  return out;
}

// ---------------------------------------------------------------------------
// Where the pegs go
// ---------------------------------------------------------------------------

/**
 * Which lattice ROW the top pegs sit in, counting up from the bottom row.
 *
 * The highest row that still leaves material above it. Zero means the bin is too
 * short for a second row and hangs on one.
 *
 * Two rows rather than one is a load decision as much as a drawing one. A bin
 * held only at the bottom hangs off the peg's own resistance to being levered
 * out of its socket — all the shipped shelves have, and fine for a 43 mm ledge.
 * Add a top row and the couple closes: the top pegs take the pull, the bottom of
 * the back panel bears on the wall. SKÅDIS bins are hooked top and bottom for
 * exactly this reason.
 *
 * It is also what keeps `drawOffsetYMm` small — see there.
 */
export function topPegRow(spec: BinSpec): number {
  // The OUTSIDE height: the back panel runs the full height of the box, and the
  // peg has to be covered by the panel, not by the cavity. Taking a spec rather
  // than a number is what stops the inside being passed to it by mistake.
  const h = outerMm(spec).heightMm;
  return Math.max(0, Math.floor((h - PEG.acrossFlats - PEG_TOP_MARGIN_MM) / PITCH));
}

/** Which rows carry pegs: the bottom one, and the top one when there is room. */
const pegRowsOf = (spec: BinSpec): number[] =>
  topPegRow(spec) > 0 ? [0, topPegRow(spec)] : [0];

/**
 * How many SAME_ROW_STEPs there are between one peg and the next.
 *
 * The pegs are spread as WIDE as the bin allows rather than bunched at the
 * minimum spacing, and the difference is not cosmetic: two pegs 40.9 mm apart in
 * the middle of a 187 mm bin let it rock about its own centre, which is a bin
 * that falls off the wall. Widen it and the same two pegs go to 122.6 mm apart.
 *
 * Every value this returns is a whole number of same-row steps, so the pegs stay
 * on the lattice however wide the bin is — that is the entire reason the spacing
 * is chosen as a COUNT of steps rather than as a fraction of the width.
 */
export function pegStep(spec: BinSpec): number {
  const s = normaliseBinSpec(spec);
  if (s.pegs < 2) return 1;
  // The flat part of the back panel, which is what a peg can sit on — measured
  // on the OUTSIDE, because that is where the panel is.
  const room =
    outerMm(s).widthMm - PEG.acrossCorners - 2 * (MIN_PEG_MARGIN_MM + cornerRadii(s).outer);
  return Math.max(1, Math.floor(room / ((s.pegs - 1) * SAME_ROW_STEP)));
}

/**
 * The cells the pegs land in, as offsets from the anchor.
 *
 * Peg `i` is `i` SAME_ROW_STEPs to the right, which is `2i` COLUMNS; the `−i` on
 * `r` is what cancels the stagger and keeps the row level. Row `j` is `j` up a
 * column, which is `+j` on `r`. Both facts belong to `hex.ts`'s embedding, and
 * the test checks them against it rather than restating them here.
 */
export function cellsFor(spec: BinSpec): Hex[] {
  const s = normaliseBinSpec(spec);
  if (s.cells) return [...s.cells];
  const k = pegStep(s);
  const cells: Hex[] = [];
  for (const j of pegRowsOf(s)) {
    for (let i = 0; i < s.pegs; i++) cells.push({ q: 2 * i * k, r: j - i * k });
  }
  return cells;
}

/**
 * Where cell (0, 0) sits on the back panel.
 *
 * Derived from the automatic layout — the first peg of the bottom row — until
 * somebody places pegs by hand, at which point it is whatever was FROZEN into
 * the spec. It has to be free millimetres rather than a lattice position:
 * an even number of pegs spread symmetrically about the panel's centre sits
 * half a step off any cell, and centring the layout matters more than a tidy
 * origin. Only the cells relative to each other have to be on the lattice, and
 * a rigid translation cannot take them off it.
 */
export function latticeOffsetMm(spec: BinSpec): { x: number; y: number } {
  const s = normaliseBinSpec(spec);
  if (s.latticeOffset) return s.latticeOffset;
  return {
    x: (-(s.pegs - 1) / 2) * pegStep(s) * SAME_ROW_STEP,
    y: PEG.acrossFlats / 2,
  };
}

/**
 * Where a cell sits on the back panel: across it, and up it.
 *
 * A DIFFERENCE of two `hexToMm`s, which is anchor-free and always safe (D76),
 * and it goes through `hexToMm` rather than multiplying by ROW_STEP.
 */
export function cellPointMm(
  cell: Hex,
  offset: { x: number; y: number },
): { acrossMm: number; upMm: number } {
  const zero = hexToMm({ q: 0, r: 0 });
  const p = hexToMm(cell);
  return { acrossMm: p.x - zero.x + offset.x, upMm: p.y - zero.y + offset.y };
}

/**
 * Peg centres in the part's own frame: across the wall, and up it.
 *
 * Through `cellsFor` and `cellPointMm`, so the automatic layout and a hand-
 * placed one land by the same route. They used to be two formulas — the auto
 * one in millimetres here and the cells derived separately — which is exactly
 * the "two readers of one fact" this repo keeps paying for.
 */
export function pegCentres(spec: BinSpec): { acrossMm: number; upMm: number }[] {
  const s = normaliseBinSpec(spec);
  const offset = latticeOffsetMm(s);
  return cellsFor(s).map((cell) => cellPointMm(cell, offset));
}

/**
 * How far up the wall the part has to be nudged when it is drawn ON the wall.
 *
 * `meshLibrary.orient` centres every part on its own wall-plane BOUNDING box and
 * `WallView3D` puts that centre on the box centre of the part's CELLS (D73). A
 * bin's box centre is halfway up the bin; its cells' box centre is halfway
 * between the peg rows. Those are different points, and this is the difference.
 *
 * It is bounded by a little over half a pitch, and that is a consequence of
 * `topPegRow` taking the highest row that FITS: the top row is always within one
 * pitch of the top, so the two centres cannot drift more than half of one apart.
 * Which matters, because `MAX_OFFSET_MM` clamps a mounting correction at 40 mm
 * on read — and a silently clamped offset would draw the bin where it is not.
 */
export function drawOffsetYMm(spec: BinSpec): number {
  const s = normaliseBinSpec(spec);
  const ups = pegCentres(s).map((c) => c.upMm);
  if (ups.length === 0) return 0;
  const pegsCentre = (Math.min(...ups) + Math.max(...ups)) / 2;
  return outerMm(s).heightMm / 2 - pegsCentre;
}

/**
 * How far the top row of pegs has to bridge when printed, or 0 for a bin that
 * hangs on one row and prints with nothing in the air at all.
 *
 * Stated rather than hidden. The bottom pegs put their bottom flats on the bed;
 * the top ones cannot, and there is nowhere to put a support that is not inside
 * the wall's own socket. It is a short one-sided bridge, full width from the
 * back panel and roofed by the hexagon's own 60° faces — but somebody choosing a
 * profile deserves to be told rather than to find out.
 */
export const topRowBridgesMm = (spec: BinSpec): number =>
  bridgingPegs(spec) > 0 ? PEG.lengthMm : 0;

/**
 * How many pegs have to bridge when the bin is printed.
 *
 * A peg prints with no support only when its bottom flat is ON the bed, which
 * means its centre half a peg above the bin's own bottom — the bottom row, and
 * only the bottom row. Counted from the pegs themselves rather than from
 * `topPegRow`, because pegs placed by hand are not rows.
 */
export function bridgingPegs(spec: BinSpec): number {
  const seat = PEG.acrossFlats / 2;
  return pegCentres(spec).filter((c) => Math.abs(c.upMm - seat) > 0.2).length;
}

// ---------------------------------------------------------------------------
// Peg cross-sections
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The mesh
// ---------------------------------------------------------------------------

interface P {
  a: number;
  u: number;
  d: number;
}

const at = (a: number, u: number, d: number): P => ({ a, u, d });

/**
 * Triangles, in the file frame.
 *
 * Everything below reasons in (across, up, out) — the frame anyone describes a
 * wall bin in — and this is the one place it becomes (x, y, z). The permutation
 * `(a, u, d) -> (d, a, u)` is CYCLIC and therefore a rotation; an acyclic one
 * would mirror the part, which is the trap `AXES` in `detect.ts` carries the
 * same warning about.
 */
class Sink {
  private readonly xs: number[] = [];
  private n = 0;

  tri(p0: P, p1: P, p2: P): void {
    for (const q of [p0, p1, p2]) this.xs.push(q.d, q.a, q.u);
    this.n++;
  }

  /** Four corners, counter-clockwise seen from OUTSIDE. */
  quad(p0: P, p1: P, p2: P, p3: P): void {
    this.tri(p0, p1, p2);
    this.tri(p0, p2, p3);
  }

  done(): SolidMesh {
    return { positions: Float64Array.from(this.xs), triangleCount: this.n };
  }
}

/*
 * Winding, stated once.
 *
 * (a, u, d) is right-handed — it is the wall frame (across, up, out) under
 * another name. Two consequences are used throughout:
 *
 *   - a face in the plane `d = const` is wound counter-clockwise in (a, u) for a
 *     normal along +d, so the back panel, which looks along −d, is drawn
 *     clockwise;
 *   - a wall extruded up from a segment `P -> Q` of a COUNTER-CLOCKWISE outline
 *     in (a, d) has its normal pointing out of the solid when the quad runs
 *     `(P, u0) (P, u1) (Q, u1) (Q, u0)`. Every wall in section 3 is that, and
 *     the cavity is the same thing reversed.
 *
 * Getting one backwards leaves a hole a slicer will "repair" into something
 * nobody drew, which is why the test checks both `meshIsClosed` and a SIGNED
 * volume — a mesh wound inside out is closed and slices as a void.
 */

/*
 * Winding, stated once.
 *
 * (a, u, d) is right-handed — it is the wall frame (across, up, out) under
 * another name. The one consequence used throughout: a wall extruded up from a
 * segment `P -> Q` of a COUNTER-CLOCKWISE outline in (a, d) has its normal
 * pointing out of the solid when the quad runs `(P, u0) (P, u1) (Q, u1) (Q, u0)`.
 * Every wall in section 1 is that, and the cavity is the same thing reversed.
 *
 * Getting one backwards leaves a hole a slicer will "repair" into something
 * nobody drew, which is why the test checks both `meshIsClosed` and a SIGNED
 * volume — a mesh wound inside out is closed and slices as a void.
 */

/** A point on the box's horizontal outline: across the wall, and out of it. */
interface Pt {
  a: number;
  d: number;
}

/**
 * The box's horizontal outline as a rounded rectangle, counter-clockwise in
 * (a, d), starting at the RIGHT-HAND END OF THE FLAT BACK EDGE.
 *
 * The cardinal points are written out rather than evaluated from the arc,
 * because `cos(−π/2)` is 6.1e-17 and not 0 — and `meshIsClosed` compares
 * vertices EXACTLY. Every shared coordinate here is spelled once.
 *
 * The same function builds the cavity's outline, so the two have the same number
 * of points in the same order and the rim between them is a quad strip.
 */
function roundedProfile(halfW: number, d0: number, d1: number, r: number): Pt[] {
  const pts: Pt[] = [];
  const arc = (ca: number, cd: number, fromDeg: number): void => {
    for (let i = 1; i < ARC_STEPS; i++) {
      const th = ((fromDeg + (90 * i) / ARC_STEPS) * Math.PI) / 180;
      pts.push({ a: ca + r * Math.cos(th), d: cd + r * Math.sin(th) });
    }
  };
  pts.push({ a: halfW - r, d: d0 }); // the flat back edge ends here
  arc(halfW - r, d0 + r, -90);
  pts.push({ a: halfW, d: d0 + r });
  pts.push({ a: halfW, d: d1 - r });
  arc(halfW - r, d1 - r, 0);
  pts.push({ a: halfW - r, d: d1 });
  pts.push({ a: -halfW + r, d: d1 });
  arc(-halfW + r, d1 - r, 90);
  pts.push({ a: -halfW, d: d1 - r });
  pts.push({ a: -halfW, d: d0 + r });
  arc(-halfW + r, d0 + r, 180);
  pts.push({ a: -halfW + r, d: d0 }); // ...and starts here, closing the loop
  return pts;
}

/**
 * A horizontal cap over a closed outline — the underside, or the cavity's floor.
 *
 * A fan, which is valid because a rounded rectangle is convex, and it is fanned
 * from POINT 1: that is always a point on an arc, so it lies on none of the
 * straight edges' lines and no triangle in the fan can come out degenerate.
 * Fanning from a corner of the back edge would flatten every triangle along it.
 *
 * `up` flips the winding rather than reversing the loop, so the apex rule holds
 * either way round.
 */
function capU(s: Sink, pts: readonly Pt[], u: number, up: boolean): void {
  const n = pts.length;
  const apex = pts[1]!;
  for (let i = 2; i < n; i++) {
    const q = pts[i]!;
    const r = pts[(i + 1) % n]!;
    const A = at(apex.a, u, apex.d);
    const B = at(q.a, u, q.d);
    const C = at(r.a, u, r.d);
    if (up) s.tri(C, B, A);
    else s.tri(A, B, C);
  }
}

export interface BinModel {
  mesh: SolidMesh;
  /** The spec actually built, after clamping. */
  spec: BinSpec;
  /** Peg cells as offsets from the anchor — the part's footprint. */
  cells: Hex[];
  anchor: Hex;
  /** Bounding box of the mesh in FILE axes: out, across, up. */
  bboxMm: [number, number, number];
  /** Nudge up the wall when the part is drawn on it. See `drawOffsetYMm`. */
  offsetYMm: number;
  /** 0 when the whole part prints with nothing in the air. */
  bridgeMm: number;
}

/**
 * Build the bin.
 *
 * Triangles come back counter-clockwise seen from outside — the convention
 * `honeycomb.ts` returns and `toBinaryStl` writes.
 */
export function buildBinMesh(input: BinSpec): BinModel {
  const spec = normaliseBinSpec(input);
  // The spec is the INSIDE; everything below builds the outside. One conversion,
  // here, so no line further down has to remember which it is holding.
  const { widthMm: W, heightMm: H, depthMm: D } = outerMm(spec);
  const t = spec.wallMm;

  const halfW = W / 2;
  const { outer: rOut, inner: rIn } = cornerRadii(spec);

  const s = new Sink();

  // =========================================================================
  // 1. The outside, as one extruded outline
  // =========================================================================
  /*
   * The box's silhouette is a rounded rectangle in (a, d) and the whole outside
   * is that outline extruded up the wall. One loop, every segment, the flat back
   * panel included — the corners come out of it for free, which is the reason
   * the profile exists rather than a `cornerRadius` bolted onto four rectangles.
   *
   * The back panel used to be drawn separately, cut into horizontal bands with
   * a hexagonal hole per peg so the peg grew out of the panel as ONE SOLID. That
   * is gone (D110). It could only ever cut a regular grid of holes — every peg
   * row sharing the same columns — because two pegs one column apart sit half a
   * pitch up from each other and their hexagons interleave in the very bands the
   * cutting is organised by. Pegs you place by hand are not a grid, so the pegs
   * became overlapping solids instead, exactly as `pegAdder` welds them onto an
   * upload, and 90 lines of banding, splitting and T-junction bookkeeping went
   * with them.
   */
  const outer = roundedProfile(halfW, 0, D, rOut);
  const inner = roundedProfile(halfW - t, t, D - t, rIn);

  for (let i = 0; i < outer.length; i++) {
    const p = outer[i]!;
    const q = outer[(i + 1) % outer.length]!;
    s.quad(at(p.a, 0, p.d), at(p.a, H, p.d), at(q.a, H, q.d), at(q.a, 0, q.d));
  }

  // The underside.
  capU(s, outer, 0, false);

  // =========================================================================
  // 2. The rim, and the cavity under it
  // =========================================================================
  /*
   * The rim is a quad strip between the two outlines, which is why they are
   * built by the same function with the same `ARC_STEPS`: point i of one belongs
   * with point i of the other. Cut into rectangles instead, the ring would need
   * vertices the walls and the cavity do not have — a T-junction at every one.
   */
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length;
    s.quad(
      at(outer[i]!.a, H, outer[i]!.d),
      at(inner[i]!.a, H, inner[i]!.d),
      at(inner[j]!.a, H, inner[j]!.d),
      at(outer[j]!.a, H, outer[j]!.d),
    );
  }

  // The cavity: the inner outline from the floor to the rim, wound the other way
  // round because its normals point INTO the hollow, which is out of the solid.
  for (let i = 0; i < inner.length; i++) {
    const p = inner[i]!;
    const q = inner[(i + 1) % inner.length]!;
    s.quad(at(q.a, t, q.d), at(q.a, H, q.d), at(p.a, H, p.d), at(p.a, t, p.d));
  }
  capU(s, inner, t, true);

  const mesh = s.done();

  // =========================================================================
  // 3. The pegs, as solids that OVERLAP the back panel
  // =========================================================================
  /*
   * Seated `PEG_SEAT_MM` into the panel, or as deep as the panel is thick less a
   * skin — a seat deeper than the wall would push the peg's root cap through
   * into the bin, which is a hexagonal pimple on the inside face.
   */
  const seat = Math.max(0.6, Math.min(PEG_SEAT_MM, t - 0.4));
  const pegs = pegCentres(spec).map((c) =>
    buildPegSolid({ a: c.acrossMm, u: c.upMm }, seat),
  );

  const extra = pegs.reduce((n, p) => n + p.positions.length, 0);
  const positions = new Float64Array(mesh.positions.length + extra);
  positions.set(mesh.positions, 0);
  let atIndex = mesh.positions.length;
  for (const peg of pegs) {
    positions.set(peg.positions, atIndex);
    atIndex += peg.positions.length;
  }
  const withPegs: SolidMesh = {
    positions,
    triangleCount: mesh.triangleCount + pegs.reduce((n, p) => n + p.triangleCount, 0),
  };

  return {
    mesh: withPegs,
    spec,
    cells: cellsFor(spec),
    anchor: { q: 0, r: 0 },
    bboxMm: [D + PEG.lengthMm, W, H],
    offsetYMm: drawOffsetYMm(spec),
    bridgeMm: topRowBridgesMm(spec),
  };
}

/**
 * A block of plate big enough to show the bin sitting in it, and CERTAIN to
 * contain every peg cell.
 *
 * Here rather than in the view because it is a claim about the lattice, and a
 * claim about the lattice belongs where a test can hold it: the whole point of
 * drawing the bin against a real plate is that the pegs land in real holes, and
 * a patch that quietly missed them would draw the pegs onto the web between
 * cells and look almost right.
 *
 * `panelCells` staggers column q by −floor(q/2), so starting the block two
 * columns to the left puts peg column i at block column 2i + 2, whose shift is
 * i + 1; row r' = j + 2 then lands it exactly. Two columns and two rows of plate
 * spare on every side.
 */
export function previewPatch(spec: BinSpec): { origin: Hex; columns: number; rows: number } {
  const s = normaliseBinSpec(spec);
  return {
    origin: { q: -2, r: -1 },
    columns: 2 * (s.pegs - 1) * pegStep(s) + 5,
    rows: topPegRow(s) + 5,
  };
}

/** A cell the back panel offers, and whether the whole peg lands on it. */
export interface BinCell {
  cell: Hex;
  acrossMm: number;
  upMm: number;
  /** Is the whole hexagon on the flat part of the back panel? */
  whole: boolean;
}

/**
 * Every cell the BACK PANEL reaches, for picking pegs by hand.
 *
 * Not `hex.panelCells`, which is the cell block of a wall PLATE. Two different
 * things, and they were briefly the same word.
 *
 * Offered by CENTRE, not by fit: a cell whose hexagon overhangs the panel's flat
 * part is still offered and marked `whole: false`, because the panel's edge is a
 * slider away and refusing the click is refusing to have the conversation — the
 * same rule the peg adder arrived at.
 *
 * The panel's flat part stops a corner radius short of the silhouette on each
 * side, which is what `backHalf` is; past that the panel is curving away.
 */
/** The flat part of the back panel — what the cell map draws on. */
export function panelExtentMm(spec: BinSpec): { halfWidthMm: number; heightMm: number } {
  const s = normaliseBinSpec(spec);
  const box = outerMm(s);
  return {
    halfWidthMm: box.widthMm / 2 - cornerRadii(s).outer,
    heightMm: box.heightMm,
  };
}

export function backPanelCells(spec: BinSpec): BinCell[] {
  const s = normaliseBinSpec(spec);
  const { halfWidthMm: backHalf, heightMm } = panelExtentMm(s);
  const offset = latticeOffsetMm(s);
  const zero = hexToMm({ q: 0, r: 0 });

  // The q/r window that covers the panel, from its corners and a ring of slack.
  const corners = [
    { x: -backHalf, y: 0 },
    { x: backHalf, y: 0 },
    { x: -backHalf, y: heightMm },
    { x: backHalf, y: heightMm },
  ].map((p) => mmToHex({ x: p.x - offset.x + zero.x, y: p.y - offset.y + zero.y }));

  const qs = corners.map((c) => c.q);
  const rs = corners.map((c) => c.r);
  const out: BinCell[] = [];
  for (let q = Math.min(...qs) - 2; q <= Math.max(...qs) + 2; q++) {
    for (let r = Math.min(...rs) - 2; r <= Math.max(...rs) + 2; r++) {
      const cell = { q, r };
      const { acrossMm, upMm } = cellPointMm(cell, offset);
      if (Math.abs(acrossMm) > backHalf || upMm < 0 || upMm > heightMm) continue;
      const whole =
        Math.abs(acrossMm) + PEG_RADIUS <= backHalf &&
        upMm - PEG.acrossFlats / 2 >= 0 &&
        upMm + PEG.acrossFlats / 2 <= heightMm;
      out.push({ cell, acrossMm, upMm, whole });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Saying it in words
// ---------------------------------------------------------------------------

/**
 * The peg layout in a sentence, for the panel whose job is to prove it fits.
 *
 * Reads the spacing back off `hexToMm` rather than restating the constants, so
 * if the two ever parted company the label would say so out loud.
 */
export function pegSpacingNote(spec: BinSpec): string {
  const s = normaliseBinSpec(spec);
  const cells = cellsFor(s);
  if (cells.length === 0) return 'no pegs';
  if (cells.length === 1) return '1 peg';

  /*
   * Placed by hand, the automatic layout's vocabulary is a lie — there is no
   * "across" and no "rows", just cells. So say what is actually there: how far
   * apart the outermost pegs are, read back through `hexToMm` rather than
   * restated from the constants.
   */
  const points = cells.map((c) => hexToMm(c));
  const w = Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x));
  const h = Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y));
  if (s.cells) {
    return `${cells.length} pegs, spanning ${w.toFixed(3)} × ${h.toFixed(3)} mm on the lattice`;
  }

  const rows = topPegRow(s) > 0 ? 2 : 1;
  return (
    `${s.pegs} pegs across, ${(w / (s.pegs - 1)).toFixed(3)} mm apart` +
    (rows === 2 ? `, in 2 rows ${h.toFixed(1)} mm apart` : ', in 1 row')
  );
}

