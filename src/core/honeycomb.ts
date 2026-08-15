/**
 * The parametric model maker: a set of cells becomes a printable honeycomb plate.
 *
 * A stock panel is one of the seven shipped STLs. A panel cut round a light
 * switch is not, and neither is one with a frame down its edge — those have to be
 * GENERATED. Until now the app could only hand you parameters to paste into the
 * OpenSCAD customiser; this file makes the plate itself, in the browser, as
 * triangles you can download and print.
 *
 * ## Everything here is measured, not copied
 *
 * `Customiser/Cadcode.rtf` — the supplied customiser plus borders — expresses the
 * bore as one extruded polygon per wall:
 *
 *     polygon([[0,0],[0,8],[0.8,8],[0.8,6],[1.8,5.1],[1.8,0.5],[1.62,0]])
 *
 * Read as thickness-against-height that is: 1.8 mm of wall from z 0.5 to 5.1,
 * tapering to 0.8 mm between 5.1 and 6.0, then 0.8 mm to the top. Against
 * HSW-SPEC §3, measured off `wall-honeycomb-part.stl` with a standard deviation
 * of 0.00000 mm across all 56 cells, the two agree on every band **except the
 * entry flare**: the customiser chamfers 0.18 mm (a 20.36 mouth), the shipped
 * plates measure **20.8 across flats over 0.5 mm**. The measurement wins (D54),
 * so the profile below is built from `constants.ts` and the customiser settles
 * only the things a measurement cannot: where a border goes and how thick it is.
 *
 * The model is checked against the plates it claims to reproduce —
 * `tests/honeycomb-model.test.ts` generates all seven and compares volume and
 * bounding box with the figures `tools/scan.py` measured off the real files.
 *
 * ## How the solid is built
 *
 * A plate is the union of unit cells (HSW-SPEC §4: its outline is a zig-zag, not
 * a rectangle), and each cell is an ANNULUS — the cell hexagon minus the bore.
 * Both rings are convex, so the whole solid is:
 *
 *   - a bottom cap and a top cap, each the annulus between the two rings;
 *   - an inner skin following the bore's four bands;
 *   - an outer skin: one vertical quad per outline edge.
 *
 * No polygon boolean is needed anywhere, because a border is also just a pair of
 * half-planes — one clipping the cell ring, one clipping the bore ring — and a
 * convex polygon clipped by a half-plane stays convex.
 *
 * ## The snapping rule, which is not optional
 *
 * `ROW_STEP` is the designer's typed 20.438, not 23.6·√3/2 (D4), so unit
 * hexagons do NOT tile exactly: two cells compute their shared corner about
 * 0.0003 mm apart. Left alone that is a mesh full of 0.0003 mm cracks — not
 * watertight, and rejected or "repaired" by slicers. Every shared corner is
 * therefore resolved through `cornerPositions` to ONE canonical point, keyed on
 * the three cells that meet there, so adjacent cells emit bit-identical vertices
 * and the internal edges cancel exactly.
 */

import {
  CELL, MARGIN_X, MARGIN_Y, PANEL_DEPTH, PITCH, ROW_STEP,
  WALL_AT_MOUTH, WALL_AT_THROAT,
} from './constants';
import { hexCorners, hexKey, hexToMm, type Point } from './hex';
import type { Hex } from './types';

// ---------------------------------------------------------------------------
// The bore
// ---------------------------------------------------------------------------

/** One height in the bore, and how wide the hole is there. */
export interface ProfileLevel {
  /** Height above the printed bottom / wall face, mm. */
  zMm: number;
  /** Hexagon width across flats at that height, mm. */
  acrossFlatsMm: number;
}

/**
 * The stepped bore, from the WALL FACE (z = 0) out to the room face (z = 8).
 *
 * Straight out of `constants.ts`, which is straight out of the measurement. The
 * four band depths sum to exactly `PANEL_DEPTH` — 2.0 + 0.9 + 4.6 + 0.5 = 8.0 —
 * and `assertProfile` below refuses to let that drift.
 *
 * **The 22.0 mouth goes against the WALL, and the 20.8 flare faces the room.**
 * It was the other way round, and the app drew every plate turned over, which is
 * what "the tapered part should be towards the wall" was reporting. The proof is
 * the INSERT, not the plate: an insert's flange is 0.3–2.5 mm, its body 2.5–6.5,
 * and its snap barbs peak at 20.735 mm across flats at z = 8.2–8.6 (HSW-SPEC §5).
 * With the flange seated on the face, those barbs sit 5.7–6.1 mm into the plate.
 * Entered from the FLARE face that is 0.5 flare + 4.6 throat + 0.9 chamfer = the
 * point where the bore opens to 21.3–22.0, so the barbs spring out and catch —
 * which is the sentence the spec already had. Entered from the MOUTH face the
 * same barbs sit at 5.7–6.1 mm, which is inside the 20.0 throat: compressed,
 * gripping nothing, and the insert would not stay in.
 *
 * So z = 0 here is the face against the wall AND the face on the printer's bed;
 * the plate is printed mouth-down. That trades the 38.7° entry flare for the 48°
 * lead-in as the only overhang, over 0.9 mm — steep, short and unsupported by
 * nothing, and the alternative is a plate you cannot clip an insert into.
 */
export const BORE_PROFILE: readonly ProfileLevel[] = [
  { zMm: 0, acrossFlatsMm: CELL.mouthAcrossFlats },
  { zMm: CELL.mouthDepth, acrossFlatsMm: CELL.mouthAcrossFlats },
  {
    zMm: CELL.mouthDepth + CELL.chamferDepth,
    acrossFlatsMm: CELL.throatAcrossFlats,
  },
  {
    zMm: CELL.mouthDepth + CELL.chamferDepth + CELL.throatDepth,
    acrossFlatsMm: CELL.throatAcrossFlats,
  },
  {
    zMm: CELL.mouthDepth + CELL.chamferDepth + CELL.throatDepth + CELL.entryFlareDepth,
    acrossFlatsMm: CELL.entryFlareAcrossFlats,
  },
];

/**
 * Half the material between two cells at the throat: 1.8 mm.
 *
 * Derived rather than typed, because it is the same number three different ways
 * — the customiser's `wall_thickness`, half of `WALL_AT_THROAT`, and
 * `(PITCH − throat) / 2` — and only one of them is measured.
 */
export const WALL_THICKNESS = WALL_AT_THROAT / 2;

/**
 * How thick a cell wall is at height `z`, measured from the cell boundary
 * inward: `(PITCH − bore) / 2`. 1.8 at the throat, 0.8 at the mouth, 1.4 at the
 * flare. This is what makes a border wall follow the same taper as every other
 * wall instead of standing up as a flat slab.
 */
export function wallThicknessAt(acrossFlatsMm: number): number {
  return (PITCH - acrossFlatsMm) / 2;
}

function assertProfile(): void {
  const last = BORE_PROFILE[BORE_PROFILE.length - 1];
  if (!last || Math.abs(last.zMm - PANEL_DEPTH) > 1e-9) {
    throw new Error(
      `The bore profile is ${last?.zMm ?? 0} mm deep but a plate is ${PANEL_DEPTH} mm. ` +
        'One of the two changed without the other; see HSW-SPEC §3.',
    );
  }
}

// ---------------------------------------------------------------------------
// Border
// ---------------------------------------------------------------------------

/**
 * A straight, closed edge round the outside of the honeycomb.
 *
 * Measured off the reference plate in `Customiser/borders.webp`, and it is NOT
 * what the customiser's `*_Border` options do. The customiser CUTS: it slices the
 * outermost cells along their own centre line and walls off the halves, which
 * costs you a whole column of mountable cells. The printed reference does the
 * opposite — every cell is whole and open, the walls BETWEEN cells run out to a
 * straight line, and the triangular notches between the honeycomb's zig-zag and
 * that line are filled solid. Nothing is lost; material is added.
 *
 * So the border is additive, and it builds from one extra ring:
 *
 *   1. Take every empty lattice position touching the plate.
 *   2. Draw its hexagon SOLID — no bore — because it is border, not a cell.
 *   3. Clip it to a straight line `thicknessMm` beyond the outermost extent of
 *      the real cells around it.
 *
 * Step 3 is what makes a straight edge out of a staggered lattice: along a run,
 * every phantom computes the same line from its own neighbours, so the run comes
 * out flush without anyone having to find the run first. At a step in an
 * L-shaped plate the neighbours differ, the lines differ, and the border follows
 * the step. Local rule, global result.
 *
 * **`occupied` is the whole ASSEMBLY, not this plate.** A position on a seam is
 * filled by the plate next door, so it is never a border position and the two
 * plates still interlock. Only the outside of the whole wall gets an edge.
 */
export interface BorderSpec {
  /** How far the plate reaches past the outermost cell extent, mm. */
  thicknessMm: number;
  /**
   * Every cell in the assembly, as `hexKey`s.
   *
   * The reason a border never appears on a seam: the position is taken.
   */
  occupied: ReadonlySet<string>;
  /** Which outward sides of the assembly get an edge. */
  sides: FrameSides;
  /**
   * Border the inside edges too — round a blocked zone, or a step.
   *
   * Separate from `sides` because they answer different questions: the sides are
   * where the wall stops, a hole is where it goes round something.
   */
  holes: boolean;
  /** Cell-centre extents of the assembly, for telling a side from a hole. */
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /**
   * Rectangles the plate must not reach into, in wall millimetres — the blocked
   * zones, each already grown by its clearance.
   *
   * The generator otherwise knows only CELLS, and a cell is cut the moment it
   * clashes with a zone, so the aperture left behind is bigger than the zone and
   * lands on no straight line. That is why a hole's edge could not come out like
   * the outer one: the outside has the assembly's own bounds to clip to, and a
   * hole had nothing. This is the hole's equivalent, and giving it to the
   * generator is what turns the aperture into a straight-edged rectangle
   * instead of a rim following the honeycomb's steps (D77).
   *
   * Absent means no zones, which is the standalone and the plain-wall case.
   */
  keepClear?: readonly { minX: number; maxX: number; minY: number; maxY: number }[];
  /**
   * Does the plate being generated own this piece of edge?
   *
   * A position on the outside can touch two plates at once — the corner where
   * they butt — and without an owner BOTH grow it. Printed, they overlap by a
   * whole cell and the wall will not assemble. Absent means "one plate, it owns
   * all of it", which is the standalone case.
   */
  owns?: (cell: Hex) => boolean;
}

export const FRAME_SIDES = ['left', 'right', 'bottom', 'top'] as const;
export type FrameSide = (typeof FRAME_SIDES)[number];

/** Which sides of the wall assembly carry a border. Stored on the document. */
export type FrameSides = Readonly<Record<FrameSide, boolean>>;

export const NO_FRAME: FrameSides = { left: false, right: false, bottom: false, top: false };

export const hasFrame = (f: FrameSides | undefined): boolean =>
  f !== undefined && FRAME_SIDES.some((s) => f[s]);

/** The default edge: two cell walls thick, which is what the reference looks like. */
export const DEFAULT_BORDER_MM = WALL_AT_THROAT;

/**
 * The thickest edge the phantom ring can express.
 *
 * The border is drawn from ONE ring of empty positions, so it can only reach as
 * far as that ring does — `ROW_STEP` sideways, and a cell's own half-height up.
 * Past that the ring runs out and the edge would come back short without saying
 * so. Bounded here rather than in the UI, because a stored document is user
 * input by the time it is read back.
 */
export const MAX_BORDER_MM = ROW_STEP - MARGIN_X;

/**
 * The thinnest edge worth printing: one extrusion width at a common nozzle.
 *
 * Below this the border is a line the slicer may drop entirely, which prints as
 * no border at all with nothing to say why.
 */
export const MIN_BORDER_MM = 0.4;

/** Cell-centre extents of a set of cells. */
export function cellCentreBounds(cells: readonly Hex[]): {
  minX: number; maxX: number; minY: number; maxY: number;
} {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of cells) {
    const p = hexToMm(c);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return { minX, maxX, minY, maxY };
}

/** One piece of border: a phantom cell, drawn solid and cut to the edge lines. */
interface BorderPiece {
  cell: Hex;
  planes: HalfPlane[];
}

const OUTSIDE_EPS = 1e-6;

/**
 * The border pieces for one plate.
 *
 * Walks the plate's own cells and collects the empty positions around them, so a
 * plate only ever generates the border along its own share of the outside — four
 * plates down one edge each contribute their part of one straight run.
 */
function borderPieces(cells: readonly Hex[], border: BorderSpec): BorderPiece[] {
  const t = Math.max(0, border.thicknessMm);

  /** The reach a phantom is allowed, from the real cells it leans on. */
  interface Reach { minX: number; maxX: number; minY: number; maxY: number }

  const outwardOf = (p: Hex): FrameSide[] => {
    const centre = hexToMm(p);
    const outward: FrameSide[] = [];
    if (centre.x < border.bounds.minX - OUTSIDE_EPS) outward.push('left');
    if (centre.x > border.bounds.maxX + OUTSIDE_EPS) outward.push('right');
    if (centre.y < border.bounds.minY - OUTSIDE_EPS) outward.push('bottom');
    if (centre.y > border.bounds.maxY + OUTSIDE_EPS) outward.push('top');
    return outward;
  };

  const wanted = (p: Hex): boolean => {
    const outward = outwardOf(p);
    // Beyond the assembly on some side: that side has to be switched on.
    // Inside it: this is a hole or a step, which is the other switch.
    return outward.length === 0 ? border.holes : outward.every((s) => border.sides[s]);
  };

  const grow = (into: Reach, from: Hex): void => {
    const q = hexToMm(from);
    if (q.x - MARGIN_X < into.minX) into.minX = q.x - MARGIN_X;
    if (q.x + MARGIN_X > into.maxX) into.maxX = q.x + MARGIN_X;
    if (q.y - MARGIN_Y < into.minY) into.minY = q.y - MARGIN_Y;
    if (q.y + MARGIN_Y > into.maxY) into.maxY = q.y + MARGIN_Y;
  };

  // Ring one: positions touching a real cell. Each takes its lines from the
  // cells it leans on, which is what makes a straight run come out flush.
  const reach = new Map<string, Reach>();
  const at = new Map<string, Hex>();
  for (const c of cells) {
    for (const d of DIRS) {
      const p = { q: c.q + d.q, r: c.r + d.r };
      const key = hexKey(p);
      if (border.occupied.has(key)) continue;
      let r = reach.get(key);
      if (r === undefined) {
        if (!wanted(p)) continue;
        r = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
        reach.set(key, r);
        at.set(key, p);
      }
      grow(r, c);
    }
  }

  // Further rings: the OUTSIDE CORNERS.
  //
  // Where two straight runs meet, the positions that square the corner off touch
  // no real cell at all — they sit diagonally past the corner one — so ring one
  // never reaches them and the corner comes out nicked. Measured before this
  // existed: a constant 131.3 mm² missing per plate however big the plate was,
  // which is what a corner defect looks like and what an edge defect does not.
  //
  // Each new position takes the LOOSEST line its existing neighbours allow in
  // each direction: the left line from the piece down the left-hand run, the top
  // line from the piece along the top. That is exactly the corner, and it cannot
  // overshoot — every line it can inherit is one some neighbour already reaches,
  // and the clip planes bound the result regardless.
  //
  // Repeated until nothing new lands inside the lines. One ring is not enough:
  // a hexagon does not cover a square corner, so the last few square millimetres
  // belong to positions two steps out. The cap is a backstop, not a limit that
  // is expected to bite — growth stops on its own because a piece past the lines
  // clips to nothing.
  const MAX_RINGS = 4;
  for (let ring = 0; ring < MAX_RINGS; ring++) {
    const added: Array<[string, Hex, Reach]> = [];
    for (const [key, r] of reach) {
      const p = at.get(key)!;
      for (const d of DIRS) {
        const n = { q: p.q + d.q, r: p.r + d.r };
        const nk = hexKey(n);
        if (border.occupied.has(nk) || reach.has(nk)) continue;
        if (!wanted(n)) continue;
        // Nothing of it would survive the clip: stop growing this way.
        const centre = hexToMm(n);
        if (
          centre.x + MARGIN_X <= r.minX - t || centre.x - MARGIN_X >= r.maxX + t ||
          centre.y + MARGIN_Y <= r.minY - t || centre.y - MARGIN_Y >= r.maxY + t
        ) continue;
        const found = added.find((a) => a[0] === nk);
        if (found === undefined) added.push([nk, n, { ...r }]);
        else {
          found[2].minX = Math.min(found[2].minX, r.minX);
          found[2].maxX = Math.max(found[2].maxX, r.maxX);
          found[2].minY = Math.min(found[2].minY, r.minY);
          found[2].maxY = Math.max(found[2].maxY, r.maxY);
        }
      }
    }
    if (added.length === 0) break;
    for (const [key, p, r] of added) {
      reach.set(key, r);
      at.set(key, p);
    }
  }

  const out: BorderPiece[] = [];
  /** Pieces facing into a hole, held back for the rail check at the end. */
  const holePieces: BorderPiece[] = [];
  /** The straight lines the whole plate ends on, per switched-on side. */
  const plateLine = {
    minX: border.bounds.minX - MARGIN_X - t,
    maxX: border.bounds.maxX + MARGIN_X + t,
    minY: border.bounds.minY - MARGIN_Y - t,
    maxY: border.bounds.maxY + MARGIN_Y + t,
  };

  for (const [key, r] of reach) {
    const p = at.get(key)!;
    if (border.owns !== undefined && !border.owns(p)) continue;

    const outward = outwardOf(p);
    /*
     * The OUTSIDE of the plate is cut, not grown (D86), so nothing is raised
     * beyond it. A position past the assembly's bounds would stand outside the
     * plate's own straight edge — which is now `bounds ± t`, inside where these
     * phantoms live.
     *
     * What is left for this walk is the case the cut cannot reach: a hole the
     * plate goes round that belongs to no zone. A step, or the gap where a plate
     * does not cover. Those have no straight line to be cut against, and the
     * rail below is still how they get an edge.
     */
    if (outward.length > 0) continue;

    /*
     * ALONG its own run, a band ends where the PLATE does, not where its own
     * neighbours do (D85).
     *
     * The reach is the right rule ACROSS a band — it is what sets the thickness
     * to `t` and what makes an L-shaped plate step in where its cells step in.
     * Along the run it is wrong at the ends, and the flat-top stagger guarantees
     * an end that is wrong: the outermost COLUMN is half a pitch shorter than
     * its neighbour, so the side band stopped `t` past the last cell of its own
     * column while the plate carried on for another half pitch above it. The
     * silhouette stepped in by up to 30.8 mm at two of the four corners —
     * chirally, so which two depended on the block.
     *
     * So a band that runs in Y takes its Y limits from the plate's own lines,
     * and a band that runs in X takes its X limits from them; each still takes
     * the ACROSS direction from its reach. Only where that side is switched on
     * — with no top edge there is no top line to run to.
     *
     * Bounded by the piece's own hexagon, which is what keeps this from filling
     * the inside of an L: a phantom reaches at most half a cell past its own
     * centre, and the ring walk never puts a centre more than one step from a
     * real cell. The lines are a ceiling, not a licence to grow.
     */
    const runsInX = outward.includes('top') || outward.includes('bottom');
    const runsInY = outward.includes('left') || outward.includes('right');
    const loX = runsInX && border.sides.left ? Math.min(r.minX - t, plateLine.minX) : r.minX - t;
    const hiX = runsInX && border.sides.right ? Math.max(r.maxX + t, plateLine.maxX) : r.maxX + t;
    const loY = runsInY && border.sides.bottom ? Math.min(r.minY - t, plateLine.minY) : r.minY - t;
    const hiY = runsInY && border.sides.top ? Math.max(r.maxY + t, plateLine.maxY) : r.maxY + t;

    const planes: HalfPlane[] = [
      { nx: -1, ny: 0, d: -loX },
      { nx: 1, ny: 0, d: hiX },
      { nx: 0, ny: -1, d: -loY },
      { nx: 0, ny: 1, d: hiY },
    ];

    /*
     * A rail of CONSTANT thickness along the TOP and BOTTOM, and only there.
     *
     * The wall is flat-top, so along a top or bottom edge adjacent columns sit
     * half a pitch apart. Filling everything between the honeycomb and the
     * straight outer line therefore makes the band `t` thick above one column
     * and `t + 11.8` above the next — flat on the outside, stepped on the
     * inside, which is what it looks like and what it is. Clipping the inside as
     * well makes it a rail of one thickness, and the half-cell pockets between
     * the rail and the lower columns are left OPEN rather than filled. That is a
     * choice, not a derivation: it keeps every cell mountable, at the cost of a
     * rail attached at every other column rather than continuously (D69). The
     * attachment is real — a cell's top FLAT is 13.6 mm of shared edge.
     *
     * The LEFT and RIGHT sides are filled, and railing them too was a mistake
     * that shipped (D84). The reasoning was that the rail should be the same
     * width the whole way round, and the sides looked fatter than the top. What
     * it did not account for is what the honeycomb offers to hold on to: a
     * column of flat-top cells reaches its straight outer line at ONE POINT per
     * cell, the hexagon's corner, and not along any edge at all. A uniform strip
     * there touches the plate at a chain of isolated points — printed, a comb
     * hanging off nothing. Measured on a plain bordered plate: the left and right
     * strips came out as separate solids from the honeycomb.
     *
     * So a side is filled out to its straight line, which is what the reference
     * plate in `Customiser/borders.webp` does and what D68 already described:
     * the band is `t` where a cell corner reaches it and up to `t + 6.8` in the
     * scallop between two cells. That is not a defect and it cannot be designed
     * away — a straight edge, whole cells and a constant width are three things
     * a hexagon lattice will only give you two of.
     */
    for (const side of outward) {
      // A CORNER position is outward on two sides at once, and it is solid out
      // to both lines: intersecting two rails there leaves a `t x t` square
      // touching neither run, which is how two of the four corners of every
      // bordered plate came off as loose 3.6 mm blocks (D84).
      //
      // KNOWN DEFECT (see the note in DECISIONS.md): given neither clip it keeps
      // its whole hexagon, so the top/bottom rail swells from `t` to a half cell
      // at each end. The L-split that fixes the width detaches on small plates —
      // it is the third rule tried here and none of the three is right yet.
      if (outward.length > 1) break;
      if (side === 'top') planes.push({ nx: 0, ny: -1, d: -r.maxY });
      else if (side === 'bottom') planes.push({ nx: 0, ny: 1, d: r.minY });
    }

    /*
     * A HOLE has no side of the assembly to be outward of, so the rule above
     * gives it nothing and its pieces were left as whole solid hexagons — the
     * border round a blocked zone came out a ragged ring of lumps where the
     * outer edge gets a clean rail (D77).
     *
     * The two are not the same question, which is why one rule cannot serve
     * both. An outer edge has an absolute reference — the straight line the
     * assembly ends on — and clipping to it is what makes four plates down one
     * side produce one flush run. A hole has no such line: the generator sees
     * cells, never the rectangle that was blocked out, and the only thing a
     * piece inside a hole can be measured against is the honeycomb it is
     * attached to.
     *
     * So it is measured against exactly that. A piece whose centre lies past
     * `r.maxY` rests only on cells below it, so its material belongs in the
     * band just above them — the same band, of the same thickness `t`, that the
     * outer rail occupies. Facing into the hole rather than out of the wall is
     * the whole difference.
     *
     * Tried and rejected: using this test for the outer edge too, to have one
     * rule. It doubles the top rail. An edge piece can lean on cells half a
     * pitch apart (the flat-top stagger), so `r.maxY` is the higher of them and
     * the piece no longer reads as being above everything it rests on —
     * `tests/honeycomb-frame.test.ts` caught it at 1164 mm² against an expected
     * 536.
     */
    if (outward.length === 0) {
      const centre = hexToMm(p);
      if (centre.y > r.maxY) planes.push({ nx: 0, ny: -1, d: -r.maxY });
      if (centre.y < r.minY) planes.push({ nx: 0, ny: 1, d: r.minY });
      if (centre.x < r.minX) planes.push({ nx: 1, ny: 0, d: r.minX });
      if (centre.x > r.maxX) planes.push({ nx: -1, ny: 0, d: -r.maxX });
      holePieces.push({ cell: p, planes });
      continue;
    }

    out.push({ cell: p, planes });
  }

  /*
   * How far a piece can reach from its centre: the CELL's corner radius, not
   * the mouth's.
   *
   * A piece is the whole hexagonal position (23.6 across the flats, 13.6 to a
   * corner), never just the bore. Using the mouth's 12.7 here skipped pieces
   * that really did overlap a zone by up to 0.9 mm — enough for a border rail
   * to be left lying inside a switch aperture, which is exactly what it did.
   */
  const reachMm = PITCH / Math.sqrt(3);

  /*
   * An OUTER piece has to keep out of a zone too.
   *
   * Not obvious, and it cost a test: a zone can overrun the edge of the plate —
   * a switch near the top of the wall, a pipe running off it — and the rail
   * along that edge then runs straight through the zone. Outer pieces take
   * their planes from the assembly bounds and never looked at `keepClear`, so
   * the rail was drawn across the aperture with nothing to stop it.
   *
   * Their rail clip is KEPT and the zone planes are added to it — an outer
   * piece is still a rail, it just stops where the zone starts. No L-split
   * here: an outer piece at a zone's corner keeps the intersection, which can
   * only remove material, and a zone cornering exactly on a plate's outer edge
   * is rare enough not to be worth two pieces.
   */
  const outerKept: BorderPiece[] = [];
  for (const piece of out) {
    const centre = hexToMm(piece.cell);
    let buriedOut = false;
    for (const z of border.keepClear ?? []) {
      if (centre.x + reachMm <= z.minX || centre.x - reachMm >= z.maxX ||
          centre.y + reachMm <= z.minY || centre.y - reachMm >= z.maxY) continue;
      let sides = 0;
      if (centre.x <= z.minX) { piece.planes.push({ nx: 1, ny: 0, d: z.minX }); sides++; }
      else if (centre.x >= z.maxX) { piece.planes.push({ nx: -1, ny: 0, d: -z.maxX }); sides++; }
      if (centre.y <= z.minY) { piece.planes.push({ nx: 0, ny: 1, d: z.minY }); sides++; }
      else if (centre.y >= z.maxY) { piece.planes.push({ nx: 0, ny: -1, d: -z.maxY }); sides++; }
      // Its centre is inside the zone, so there is no side of the zone to push
      // it to: the rail is IN the aperture and goes. Happens where a zone
      // overruns the plate's own edge.
      if (sides === 0) { buriedOut = true; break; }
    }
    if (!buriedOut) outerKept.push(piece);
  }
  out.length = 0;
  out.push(...outerKept);

  /*
   * The edge of an APERTURE is not the border's to print. The cut cells print
   * it (D83).
   *
   * This is a single-owner rule, and it was learnt by having two. The border
   * used to fill the band between a zone and the honeycomb, while the cells the
   * zone ate were cut back by `t` to leave room for it — and the two halves
   * never met, because a border piece only ever grows on a position the plate
   * has left EMPTY and every position round an aperture is a cell the plate
   * prints CUT. So the filling was dropped as an overlap, the cutting was not,
   * and the aperture came out the zone grown by `t` on a good side and by most
   * of a cell on a bad one, walled by whatever happened to be left of each
   * hexagon. Measured on an 86 × 120 switch: the wall varied from 0.00 mm — a
   * bore opening straight onto the aperture — to 26 mm.
   *
   * So the cut cell now carries its own rail: its OUTLINE is cut at the zone
   * and its BORES `t` further out, which walls the aperture with exactly `t` of
   * plate and needs nobody else's help. See `clipPlanesFor` in
   * `buildHoneycombMesh`. A border piece here would print on top of that, so it
   * goes — including across a seam, where the plate growing the piece and the
   * plate printing the cell are not even the same plate.
   *
   * A hole that belongs to NO zone — a step, or a gap where a plate does not
   * reach — has no cut cells and keeps the reach rail the clip above produced.
   */
  for (const piece of holePieces) {
    const centre = hexToMm(piece.cell);
    const meetsZone = (border.keepClear ?? []).some(
      (z) =>
        centre.x + reachMm > z.minX - t && centre.x - reachMm < z.maxX + t &&
        centre.y + reachMm > z.minY - t && centre.y - reachMm < z.maxY + t,
    );
    if (!meetsZone) out.push(piece);
  }
  return out;
}

/**
 * The lines the plate's own EDGE is cut on, pulled `insetMm` further in (D86).
 *
 * The single definition of where a bordered plate stops. `buildHoneycombMesh`
 * cuts the outlines at `insetMm = 0` and every bore at `insetMm = t`; the plan
 * draws the same two sets through `plateEdgeShapes`. One rule, because the plan
 * showing an edge the plate does not have is this repo's most repeated bug
 * (D65, D66, D68).
 *
 * A side is skipped where the assembly is one cell wide across it: both cuts
 * would land on the same line and take the whole plate. Better the un-cut
 * outline than an empty file.
 */
function plateEdgePlanes(border: BorderSpec | undefined, insetMm: number): HalfPlane[] {
  if (border === undefined) return [];
  const out: HalfPlane[] = [];
  const { bounds, sides } = border;
  const wideX = bounds.maxX - bounds.minX > 1e-6;
  const wideY = bounds.maxY - bounds.minY > 1e-6;
  if (sides.left && (wideX || !sides.right)) {
    out.push({ nx: -1, ny: 0, d: -(bounds.minX + insetMm) });
  }
  if (sides.right && (wideX || !sides.left)) {
    out.push({ nx: 1, ny: 0, d: bounds.maxX - insetMm });
  }
  if (sides.bottom && (wideY || !sides.top)) {
    out.push({ nx: 0, ny: -1, d: -(bounds.minY + insetMm) });
  }
  if (sides.top && (wideY || !sides.bottom)) {
    out.push({ nx: 0, ny: 1, d: bounds.maxY - insetMm });
  }
  return out;
}

/**
 * The cells the plate's edge cuts through, as the shapes they really print.
 *
 * `borderPolygons`' replacement for the outside of the plate, and it exists for
 * the same reason: the plan has to draw what the plate will be, from the
 * generator's own rule rather than from a second reading of it.
 *
 * Since D86 there is nothing added beyond the honeycomb to draw — the edge is a
 * CUT, so the material at the rim belongs to the outermost cells themselves.
 * Those cells are in `omit`, which is how they leave the PLANNER (nothing mounts
 * in half a cell), so the plan cannot find them among the cells it draws and
 * would show a plate a whole ring smaller than the one you download.
 *
 * `outline` is the cut hexagon and `bore` is what is left of its mouth, so a
 * caller can fill one and punch the other and get the plate.
 */
export function plateEdgeShapes(
  cells: readonly Hex[],
  border: BorderSpec | undefined,
): { outline: Point[]; bore: Point[] }[] {
  const outlinePlanes = plateEdgePlanes(border, 0);
  if (outlinePlanes.length === 0 || border === undefined) return [];
  const borePlanes = plateEdgePlanes(border, Math.max(0, border.thicknessMm));
  const corners = cornerPositions();
  const out: { outline: Point[]; bore: Point[] }[] = [];
  for (const c of dedupe(cells)) {
    const full = corners.ringOf(c);
    // Only the cells the lines actually pass through: everything inside is an
    // ordinary cell and the plan already draws it.
    const touched = full.some((p) =>
      outlinePlanes.some((pl) => pl.nx * p.x + pl.ny * p.y - pl.d > SAME));
    if (!touched) continue;
    const outline = clipConvex(full, outlinePlanes);
    if (outline.length < 3) continue;
    out.push({ outline, bore: clipConvex(hexCorners(c, CELL.mouthAcrossFlats), borePlanes) });
  }
  return out;
}

/**
 * The border as flat shapes, in wall millimetres.
 *
 * For anything that has to DRAW the border rather than print it. It comes out of
 * `borderPieces` — the same walk the mesh is built from — because the plan and
 * the plate must not have two readings of where the edge is.
 *
 * The plan learnt this the hard way: it drew one segment per exposed hexagon
 * edge, so the border came out as the honeycomb's zig-zag while the plate it
 * generated had a straight edge. The picture disagreed with the file (D65).
 */
export function borderPolygons(
  cells: readonly Hex[],
  border: BorderSpec,
): Point[][] {
  const corners = cornerPositions();
  const out: Point[][] = [];
  for (const piece of borderPieces(dedupe(cells), border)) {
    const ring = clipConvex(corners.ringOf(piece.cell), piece.planes);
    if (ring.length >= 3) out.push(ring);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mesh
// ---------------------------------------------------------------------------

/**
 * A triangle soup in double precision.
 *
 * Deliberately not `MeshData` from `stl.ts`, which is `Float32Array` because
 * that is what an STL file holds. Building in float32 loses about 1e-5 mm on a
 * 400 mm plate, which is the same order as the 0.0003 mm the snapping exists to
 * remove — the exactness would be thrown away on the way out.
 */
export interface SolidMesh {
  positions: Float64Array;
  triangleCount: number;
}

export interface HoneycombSpec {
  cells: readonly Hex[];
  /**
   * Cells the plate still PRINTS but the planner has given up — the ones a
   * blocked zone ate.
   *
   * They are drawn clipped to stay out of every `border.keepClear` rectangle,
   * so the honeycomb runs right up to the aperture and the wall round it is
   * thin and even, the way a printed plate with a switch through it looks. The
   * planner meanwhile goes on treating them as gone, because a half cell must
   * never be offered as somewhere to mount something.
   *
   * That divergence is deliberate and it is D56's: `panelModelSpec` is the one
   * place allowed to know that the plate a person prints and the plate the
   * planner reasons about are not the same set of cells.
   */
  clipped?: readonly Hex[];
  /** A straight edge round the outside. Absent means open hexagons, as shipped. */
  border?: BorderSpec;
  /** Plate thickness. Only ever `PANEL_DEPTH`; a parameter so a test can vary it. */
  depthMm?: number;
  /**
   * Move the plate so its bounding box starts at the origin — what you want in a
   * slicer. Off when the caller is drawing the plate on the wall.
   */
  originAtZero?: boolean;
}

export class HoneycombModelError extends Error {}

/**
 * Build the plate.
 *
 * Returns triangles wound counter-clockwise seen from outside, which is what
 * every slicer and `measureMesh`'s signed-tetrahedron volume assume.
 */
export function buildHoneycombMesh(spec: HoneycombSpec): SolidMesh {
  assertProfile();
  const depth = spec.depthMm ?? PANEL_DEPTH;
  const cells = dedupe(spec.cells);
  if (cells.length === 0) throw new HoneycombModelError('A plate needs at least one cell');

  const levels = BORE_PROFILE.map((l) => ({
    z: (l.zMm / PANEL_DEPTH) * depth,
    acrossFlats: l.acrossFlatsMm,
  }));

  const corners = cornerPositions();
  const tris = new TriangleSink();

  /*
   * The cells a zone ate, kept as PARTIAL cells.
   *
   * Removing them whole and filling the gap with border left an apron up to a
   * full cell deep round the aperture — straight on the inside, lumpy behind,
   * with paved-over hexagons showing through. A printed plate cut for a switch
   * does not look like that: the open cells run right up to the wall and the
   * wall is thin and even, because the cut goes THROUGH the cells (D81).
   *
   * Two neighbouring cells that both meet a zone are truncated identically
   * along their shared edge, so the edge still cancels and no wall is drawn
   * inside the solid. That is what keeps the plate watertight, and it is why the
   * cut is a function of the ZONE alone and never of which cell is asking.
   */
  /*
   * Zones are the only thing a clipped cell can be cut against, so with none of
   * them there is nothing to clip and the eaten cells must stay OUT of the
   * plate — which is what a plate with the frame switched off has always been.
   * Drawing them unclipped would fill the aperture solid.
   */
  /*
   * The cut goes to the ZONE; the BORE stops a rail short of it (D83).
   *
   * Two lines, not one, and that is the whole trick. The outline is cut at the
   * zone rectangle itself, so the aperture is that rectangle exactly — one
   * straight line per side, however the lattice happens to fall against it. The
   * four bore levels are cut at the zone grown by `t`, so between the aperture
   * and the nearest opening there is `t` of solid plate: a rail of exactly the
   * border thickness, bounded by two straight parallel lines, made of the cell's
   * own material and owned by nobody else.
   *
   * Cut both at `zone + t` (the previous attempt) the rail was left to the
   * border, which never printed it — every position round an aperture is a cell
   * the plate prints CUT, and a border piece only grows where the plate has left
   * a position EMPTY. Cut both at the zone, the wall was whatever survived of
   * each hexagon: thick in the web between bores, nothing at all where the line
   * grazed one open.
   *
   * The two sets stay in step. Neighbouring cells cut their OUTLINES with the
   * same planes, which is what keeps their shared edge cancelling and the mesh
   * watertight; the bores are private to a cell and sit strictly inside its
   * outline because `t >= 0` moves their line the safe way.
   */
  const zoneRects = spec.border?.keepClear ?? [];
  const railMm = Math.max(0, spec.border?.thicknessMm ?? 0);
  const zones = zoneRects.map((z) => ({
    minX: z.minX - railMm, maxX: z.maxX + railMm,
    minY: z.minY - railMm, maxY: z.maxY + railMm,
  }));

  /*
   * The plate's EDGE, cut the way `inner box.jpeg` shows it (D86).
   *
   * The photograph is a plate round a light switch, and the same thing happens
   * at its outside as at its aperture: the honeycomb is cut off flat, the cells
   * it cuts are left OPEN as half-hexagons, and a thin even band closes them.
   * There is no ring of whole cells at the edge and no scalloped fill behind the
   * band — the border and the honeycomb are one piece of plastic with a straight
   * line through it.
   *
   * So the outside is built exactly as the aperture is (D83), with the zone's
   * complement replaced by the plate's own rectangle:
   *
   *   - the cells' OUTLINES are cut at `bounds`, the outermost cells' own centre
   *     lines, which IS the plate's edge;
   *   - every BORE is cut `t` inside that, so between the edge and the nearest
   *     opening there is `t` of plate — the same rail the aperture gets.
   *
   * **The line has to be `bounds` and not `bounds ± t`, and that is the whole
   * lesson of this pass.** Cut further out, the edge is not straight: the
   * honeycomb's own silhouette reaches `bounds` everywhere along a side and no
   * further, because the outermost COLUMN is half a pitch shorter than its
   * neighbour and a column's cells meet at a flat that is `MARGIN_X − PITCH/2`
   * short of their corners. Measured at `bounds + t`, the top came out scalloped
   * `t` deep between columns and the sides stepped in 12.1 mm at every corner,
   * where the side's own column has no cell that high. At `bounds` the union of
   * the cells covers the line at every point on all four sides, so the cut is a
   * straight edge with square corners and there is nothing left to fill.
   *
   * Cutting the bores `t` INSIDE rather than the outline `t` outside also fixes
   * what neither rail could reach: the second column's top cell is half a pitch
   * lower, so its bore came within 1.56 mm of the plate's line and no rail was
   * involved. Every bore is cut against the same planes, so any hole that comes
   * within `t` of the edge is trimmed by exactly the amount it overreached.
   *
   * `bounds` is cell CENTRES, so only the outermost column or row is touched at
   * all; everything inside is untouched. This is what the whole phantom
   * apparatus was for, and it replaces it: no rail to attach, no scallop to
   * fill, no corner to square off, because there is nothing to attach — the band
   * is the cut cell's own material, continuous with the plate by construction.
   *
   * It costs the outer ring, which is the trade D59 refused and the photograph
   * makes: those cells are half-cells and nothing mounts in one.
   */
  const edgeT = Math.max(0, spec.border?.thicknessMm ?? 0);
  const edgeOutline = plateEdgePlanes(spec.border, 0);
  const edgeBore = plateEdgePlanes(spec.border, edgeT);

  /*
   * A cell handed over CUT is cut by everything that cuts it — the zones it
   * meets and the plate's own lines, in the same clip.
   *
   * The two arrive by different routes and land in the same list. A zone puts a
   * cell in `clipped` because a switch passes through it; the border puts the
   * outermost ring there because the plate's edge halves it (D86). A cell can be
   * both — a socket at the edge of the wall — and taking only one of the two cuts
   * is a defect either way round: only the zone's, and the plate runs past its
   * own straight edge; only the edge's, and there is plate inside the switch.
   *
   * With NEITHER there is nothing to cut against, and an eaten cell must stay
   * out of the plate rather than be drawn whole — which is what a plate with no
   * border and no zones has always been, and what stops the aperture filling
   * solid.
   */
  const clipCells = zoneRects.length > 0 || edgeOutline.length > 0
    ? (spec.clipped ?? [])
    : [];
  /**
   * How a cell is cut back from the zones it meets.
   *
   * `planes` cut the outline, `bore` the four bore levels — the same cuts moved
   * out by the rail. `corner` is the one case a single convex piece cannot
   * express: a cell diagonally outside a zone's corner wants
   * hexagon-minus-quadrant, which is an L. Taking both planes keeps only their
   * intersection and bites a notch out of each corner of the aperture — the
   * last thing wrong with it.
   *
   * So the corner is handed back for the caller to fill with a second, SOLID
   * piece. Solid on purpose: splitting the cell along the zone's edge would
   * split its BORE too, and two half-bores meeting on that line would grow a
   * membrane across the hole. The offcut is a sliver in the outer margin of one
   * cell, where a hole would do nothing anyway.
   */
  interface CellClip {
    planes: HalfPlane[];
    bore: HalfPlane[];
    /**
     * The four lines of the ONE zone corner this cell sits diagonally outside,
     * handed over whole so the caller can build the L in three pieces.
     *
     * `px`/`py` are the zone's own edges — where the OUTLINE stops. `bx`/`by`
     * are the same edges moved out by the rail — where the BORE stops, which is
     * what leaves `t` of plate between the aperture and the nearest opening.
     */
    corner: { px: HalfPlane; py: HalfPlane; bx: HalfPlane; by: HalfPlane } | null;
  }

  const clipPlanesFor = (c: Hex): CellClip | null => {
    const m = hexToMm(c);
    const planes: HalfPlane[] = [];
    const bore: HalfPlane[] = [];
    let corner: CellClip['corner'] = null;
    for (let i = 0; i < zoneRects.length; i++) {
      const z = zoneRects[i]!;
      const g = zones[i]!;
      if (m.x + PITCH <= z.minX || m.x - PITCH >= z.maxX ||
          m.y + PITCH <= z.minY || m.y - PITCH >= z.maxY) continue;
      /*
       * Which side of the zone this cell has MATERIAL outside on — never which
       * side its CENTRE is.
       *
       * The centre is a proxy that fails at a corner, and it failed measurably.
       * A cell whose centre sits 0.04 mm INSIDE the zone's x range but outside
       * it in y got no x plane at all, so it was cut on y alone and the 13.6 mm
       * of plate it still had past the zone's x edge was thrown away — a whole
       * quadrant, leaving a hexagonal hole in the aperture wall. Measured on a
       * three-zone wall: one side of every zone stepped back by up to 13.45 mm
       * (`tests/zone-apron.test.ts`), which is what "the honeycomb is cut
       * straight here and steps out there" was.
       *
       * A hexagon is 27.25 across and a zone edge lands wherever it was drawn,
       * so the centre being a hair inside an edge says nothing about whether
       * the cell reaches past it. Ask about the reach instead.
       *
       * The floor is `WALL_AT_MOUTH`, and it is the same floor, for the same
       * reason, as the sliver rule below: what survives on that side is
       * `reach - over` deep, and below one wall's thickness there is no plate
       * worth expressing — a zone edge landing a few tenths inside a cell used
       * to leave a 14.78 x 1.00 mm shard, detached, so the plate came off the
       * generator as two closed shells. Ties go to the deeper side, which is
       * what the centre test did wherever it had an opinion at all.
       */
      const side = (c: number, reach: number, lo: number, hi: number): -1 | 0 | 1 => {
        const below = lo - (c - reach);
        const above = (c + reach) - hi;
        if (below >= WALL_AT_MOUTH && below >= above) return -1;
        if (above >= WALL_AT_MOUTH) return 1;
        return 0;
      };
      const sx = side(m.x, MARGIN_X, z.minX, z.maxX);
      const sy = side(m.y, MARGIN_Y, z.minY, z.maxY);

      const px = sx < 0
        ? { nx: 1, ny: 0, d: z.minX }
        : sx > 0 ? { nx: -1, ny: 0, d: -z.maxX } : null;
      const bx = sx < 0
        ? { nx: 1, ny: 0, d: g.minX }
        : sx > 0 ? { nx: -1, ny: 0, d: -g.maxX } : null;
      const py = sy < 0
        ? { nx: 0, ny: 1, d: z.minY }
        : sy > 0 ? { nx: 0, ny: -1, d: -z.maxY } : null;
      const by = sy < 0
        ? { nx: 0, ny: 1, d: g.minY }
        : sy > 0 ? { nx: 0, ny: -1, d: -g.maxY } : null;

      /*
       * A plane that removes NOTHING means the zone removes nothing.
       *
       * What the cell keeps is `ring ∩ (px ∪ py)`, so if either plane holds
       * over the whole hexagon the union is the whole hexagon and there is
       * nothing to cut — the zone does not reach this cell at all. Skipping the
       * zone here is not a shortcut, it is the difference between one piece and
       * three: taken through the corner path anyway, the cell comes out as an
       * L split on two lines whose union is the hexagon it started as, and the
       * pieces then draw their bore walls against each other along both split
       * lines — a membrane of zero thickness standing across an open bore,
       * which reads as a stripe running down through the cell.
       *
       * It bit at a zone's far corners as soon as `sx`/`sy` started answering
       * about the cell's REACH (D105): a cell wholly past a zone's edge has
       * material outside on that axis — all of it — so it now gets a plane
       * where the centre test gave it none, and a second plane it does not
       * need turns one whole cell into three pieces.
       *
       * Every plane here is axis-aligned with a unit normal, so the hexagon's
       * far point along it is the centre plus the reach on that axis: the
       * corner radius across x, the flat across y.
       */
      const removesNothing = (p: { nx: number; ny: number; d: number } | null) =>
        p !== null &&
        p.nx * m.x + p.ny * m.y +
          Math.abs(p.nx) * MARGIN_X + Math.abs(p.ny) * MARGIN_Y <= p.d + SAME;
      if (removesNothing(px) || removesNothing(py)) continue;

      /*
       * Neither axis reaches out of the zone by a wall's worth: wholly inside
       * it, or poking out by less than plate. Nothing of this cell survives
       * that is worth printing.
       *
       * This is NOT a return to D81's apron, where cells were dropped whole
       * whenever their CENTRE fell inside the zone and the aperture lost up to
       * a corner-to-flat — measured 6.2 mm on one side of an 86 × 120 switch
       * and 10.0 mm on the other. A cell that pokes out at all now keeps what
       * it has, on both axes if it reaches out of both; what is dropped here is
       * at most `WALL_AT_MOUTH` deep on every side, which is thinner than the
       * web between two mouths and so is not a wall the plate was designed to
       * have. Kept, it arrives as a detached shard — a zone edge falling 1.00 mm
       * inside a plate's own edge left a 14.78 x 1.00 mm one, sharing no exact
       * edge with its neighbours, so the plate came off the generator as two
       * closed shells. That is the "border bugs out when I put a blocked zone
       * here" report.
       */
      if (px === null && py === null) return null;
      if (px !== null && py !== null && corner === null) {
        /*
         * Diagonally outside the zone's corner: the cell wants
         * hexagon-minus-quadrant, which is an L. Handed over whole — the caller
         * splits it, because the split has to be the SAME for the outline and
         * the bore or the hole grows a membrane (see the note there).
         *
         * ...unless the arm of that L is too thin to be plate. The arm reaches
         * from the zone's x edge out to the cell's own edge, so it is
         * `MARGIN_X − |centre − edge|` wide, and a zone edge lands wherever it
         * was drawn: measured 2.89, 0.89 and 0.59 mm across the sweep, each
         * arriving as a detached shard. Below one wall's thickness there is no L
         * worth expressing and the cell is simply cut on x — the same floor, and
         * for the same reason, as the sliver rule above.
         */
        // Off `sx`, not off the centre again: the side the cell is KEPT on is
        // the side the arm runs from, and since the centre no longer chooses
        // that side the two can disagree on a zone thinner than a cell.
        const overhangX = sx < 0
          ? m.x + MARGIN_X - z.minX
          : z.maxX - (m.x - MARGIN_X);
        if (overhangX >= WALL_AT_MOUTH) {
          corner = { px, py, bx: bx!, by: by! };
          continue;
        }
        planes.push(px);
        bore.push(bx!);
        continue;
      }
      if (px !== null && py !== null) { planes.push(px, py); bore.push(bx!, by!); continue; }
      planes.push((px ?? py)!);
      bore.push((bx ?? by)!);
    }
    return { planes, bore, corner };
  };

  const clippedOuter = new Map<string, Point[]>();
  const clippedInner = new Map<string, Point[][]>();
  const clippedKeys = new Set<string>();
  for (const c of dedupe(clipCells)) {
    const key = hexKey(c);
    clippedKeys.add(key);
    const clip = clipPlanesFor(c);
    if (clip === null) continue;
    // Both cuts, or this piece is wrong in one direction or the other.
    const planes = [...clip.planes, ...edgeOutline];
    if (planes.length === 0) continue;
    /*
     * A cell diagonally outside a ZONE'S CORNER, in three pieces.
     *
     * It wants hexagon-minus-quadrant — an L — and there is no polygon boolean
     * here by design, so the L has to be convex pieces. It used to be two: the
     * cell kept on the x side with its bore, and the arm beyond it printed
     * SOLID. That solid arm IS the chunky inner corner: the straight runs of an
     * aperture get a `t` wall because the bore stops a rail short of the
     * outline, and the corner instead got a whole cell's worth of plate, where
     * `inner box.jpeg` shows a thin even wall all the way round.
     *
     * The arm could not simply be given a bore. Its bore would start at the
     * zone's edge while the main piece's stops a rail short of it, so the strip
     * between them prints as a `t` MEMBRANE straight across the hole — which is
     * the trap D81 recorded and the reason the arm was solid.
     *
     * The way out is to split the OUTLINE and the BORE on the same two lines, so
     * every internal face is shared by exactly two pieces and cancels:
     *
     *     piece      outline                   bore
     *     A          ring ∩ bx                 hex ∩ bx
     *     B          ring ∩ ¬bx ∩ px           hex ∩ ¬bx ∩ px ∩ by
     *     C          ring ∩ ¬px ∩ py           hex ∩ ¬px ∩ by
     *
     * The outlines union to `ring ∩ (px ∪ py)` — the same L as before — and the
     * bores to `hex ∩ (bx ∪ by)`, the hexagon minus the quadrant grown by the
     * rail. A and B meet on `bx` and both reach it; B and C meet on `px` and
     * both reach it. No membrane, and the wall is `t` round the corner because
     * that is what `bx`/`by` are.
     */
    let outer = clipConvex(corners.ringOf(c), planes);
    const boreCut = [...clip.bore, ...edgeBore];
    if (clip.corner !== null) {
      const { px, py, bx, by } = clip.corner;
      const not = (p: HalfPlane): HalfPlane => ({ nx: -p.nx, ny: -p.ny, d: -p.d });
      const emit = (k: string, cut: HalfPlane[], boreOf: HalfPlane[]) => {
        const ring = clipConvex(corners.ringOf(c), [...planes, ...cut]);
        if (ring.length < 3) return;
        const rings = levels.map((lv) =>
          clipConvex(hexCorners(c, lv.acrossFlats), [...boreCut, ...boreOf]));
        clippedOuter.set(k, ring);
        clippedInner.set(k, rings.every((r) => r.length >= 3)
          ? rings
          : levels.map(() => [] as Point[]));
      };
      emit(key, [bx], [bx]);
      emit(`${key}#cx`, [not(bx), px], [not(bx), px, by]);
      emit(`${key}#cy`, [not(px), py], [not(px), by]);
      continue;
    }
    if (outer.length < 3) continue;
    // The bore stops a rail short of where the outline reaches, which IS the
    // wall round the aperture. Never `planes`: that opens the bore onto it.
    const bores = levels.map((lv) => clipConvex(hexCorners(c, lv.acrossFlats), boreCut));
    /*
     * A cut bore is still a HOLE, however little of it is left (D86).
     *
     * It used to print SOLID once the cut passed the cell's own centre, on the
     * reasoning that the skirt merge below needs both rings to wrap that point.
     * That reasoning was about the wrong point: `addSkirt` and `addAnnulus` both
     * merge by bearing around the INNER RING's own centroid, which a convex
     * sliver always contains, and the levels are all cut by the same planes so
     * the smaller ring stays inside the larger. Nothing needed the cell centre.
     *
     * What the rule cost was visible on the plate. Every cell whose centre fell
     * within the rail of a zone came out paved over, so the honeycomb round a
     * switch was a band of filled hexagons where the printed reference has open
     * ones right up to the wall — the apron D81 set out to remove, put back by
     * its own guard.
     *
     * A ring with fewer than three points is a different thing: the cut took all
     * of it, and that cell really is solid plate.
     */
    const open = bores.every((r) => r.length >= 3);
    clippedOuter.set(key, outer);
    clippedInner.set(key, open ? bores : levels.map(() => [] as Point[]));
  }


  // Border phantoms are only for a HOLE the plate goes round that no zone owns —
  // a step, or a gap where a plate does not reach. The outside is cut, not
  // grown, so a piece beyond the plate would stand outside its own edge.
  const border = (spec.border !== undefined && spec.border.thicknessMm >= 0
    ? borderPieces(cells, spec.border)
    : []
  // A position now filled by a partial cell must not ALSO grow a border piece,
  // or the two would overlap and the solid would self-intersect.
  ).filter((b) => !clippedKeys.has(hexKey(b.cell)));

  /** Outer ring per piece. Constant in z — a border never tapers the outline. */
  const outerRings = new Map<string, Point[]>();
  for (const c of cells) {
    const ring = edgeOutline.length > 0
      ? clipConvex(corners.ringOf(c), edgeOutline)
      : corners.ringOf(c);
    if (ring.length >= 3) outerRings.set(hexKey(c), ring);
  }
  for (const [key, ring] of clippedOuter) outerRings.set(key, ring);
  // Keyed per PIECE, not per position: a corner phantom is two halves of an L at
  // one position (D84), and keying on the cell alone silently kept the second.
  border.forEach((b, i) => {
    const ring = clipConvex(corners.ringOf(b.cell), b.planes);
    if (ring.length >= 3) outerRings.set(`${hexKey(b.cell)}#b${i}`, ring);
  });

  weldTJunctions(outerRings);

  /**
   * Inner rings per CELL per bore level. Border pieces have none: they are the
   * edge, not a cell, and a hole in them would be a hole nothing can mount in.
   */
  const innerRings = new Map<string, Point[][]>();
  for (const c of cells) {
    if (!outerRings.has(hexKey(c))) continue;
    const bores = levels.map((lv) => {
      const ring = hexCorners(c, lv.acrossFlats);
      return edgeBore.length > 0 ? clipConvex(ring, edgeBore) : ring;
    });
    // A bore the edge has cut to nothing is not a hole: that cell is entirely
    // in the band and prints solid.
    innerRings.set(hexKey(c), bores.every((r) => r.length >= 3)
      ? bores
      : levels.map(() => [] as Point[]));
  }
  for (const [key, rings] of clippedInner) innerRings.set(key, rings);

  /*
   * The bores need the same T-junction weld the outlines get, LEVEL BY LEVEL.
   *
   * The top face is bounded by a piece's outer ring AND by its bores, so a
   * mismatched stretch on a bore edge splits the face exactly as one on an
   * outline does. It shows up the moment a cell is cut into more than one piece
   * at a zone corner: the two pieces' bores meet along the zone's own edge and
   * both reach it, but they reach it with different vertices. Welding the
   * outlines alone left 5 of 241 placements still splitting the plate.
   *
   * Per level, because the levels are different sizes — a vertex from the mouth
   * ring is nowhere near the throat ring's edge, and pooling them would be
   * looking for collinearity that cannot exist.
   */
  for (let lv = 0; lv < levels.length; lv++) {
    const at = new Map<string, Point[]>();
    for (const [key, rings] of innerRings) {
      const r = rings[lv];
      if (r !== undefined && r.length >= 3) at.set(key, r);
    }
    if (at.size === 0) continue;
    weldTJunctions(at);
    for (const [key, welded] of at) innerRings.get(key)![lv] = welded;
  }

  /*
   * A bore face shared by two PIECES of one cell is internal and must not be
   * drawn.
   *
   * The outer skin has always cancelled these — `boundaryEdges` drops any
   * directed edge whose opposite turns up — but the inner skin is emitted per
   * piece, unconditionally, so at a zone corner the pieces each draw their own
   * bore wall along the split lines. Solid on NEITHER side, both sides being
   * open bore, what stands there is a membrane of ZERO thickness: reported as a
   * one-pixel stripe running down through the hexagons, which is what a surface
   * with no thickness looks like at any zoom.
   *
   * Through `boundaryEdges` rather than a plain set of opposites, because
   * multiplicity matters: a clipped bore can double back so one ring holds an
   * edge AND its reverse, and matched naively that cancels against ITSELF —
   * both sides drop their band and the hole in the plate becomes a hole in the
   * mesh, measured as 8 unmatched edges on a closed loop along the rail line.
   *
   * After the weld above, never before it: two pieces meeting along PART of an
   * edge share no exact endpoints until the T-junctions are split. Per level
   * for the same reason the weld is.
   */
  const edgeId = (p: Point) => `${p.x},${p.y}`;
  const boreBoundary = levels.map(() => new Set<string>());
  const boreHolders = levels.map(() => new Map<string, string[]>());
  for (let lv = 0; lv < levels.length; lv++) {
    const at = new Map<string, Point[]>();
    for (const [key, rings] of innerRings) {
      const r = rings[lv];
      if (r !== undefined && r.length >= 3) at.set(key, r);
    }
    for (const [a, b] of boundaryEdges(at)) {
      boreBoundary[lv]!.add(`${edgeId(a)}>${edgeId(b)}`);
    }
    for (const [key, r] of at) {
      for (let k = 0; k < r.length; k++) {
        const e = `${edgeId(r[k]!)}>${edgeId(r[(k + 1) % r.length]!)}`;
        const held = boreHolders[lv]!.get(e);
        if (held) held.push(key); else boreHolders[lv]!.set(e, [key]);
      }
    }
  }

  /*
   * A band may only be dropped where BOTH pieces tessellate it the same way.
   *
   * `addSkirt` merges two rings by bearing, so where the levels have different
   * vertex counts the two pieces of a shared stretch are cut into triangles
   * differently. Dropping the same geometric area from each then leaves a crack
   * along the seam between kept and dropped triangles — measured as a single
   * missing skirt triangle, four unmatched edges, at one placement in the
   * sweep. So the cancellation is confined to level pairs where every piece
   * holding the edge is index-matched, which is the only case in which the two
   * sides are guaranteed to remove exactly the same triangles. A skirt piece
   * keeps its wall, membrane and all: a stripe is a blemish, an open plate is
   * not printable.
   */
  const indexMatched: Set<string>[] = [];
  for (let j = 0; j + 1 < levels.length; j++) {
    const ok = new Set<string>();
    for (const [key, rings] of innerRings) {
      const a = rings[j];
      const b = rings[j + 1];
      if (a !== undefined && b !== undefined &&
          a.length >= 3 && a.length === b.length) ok.add(key);
    }
    indexMatched.push(ok);
  }

  /** Hole on both sides here, and both sides will cut it away identically. */
  const internalBore = (pair: number, lv: number, e: string): boolean => {
    if (boreBoundary[lv]!.has(e)) return false;
    const cut = e.indexOf('>');
    const mine = boreHolders[lv]!.get(e) ?? [];
    const theirs = boreHolders[lv]!.get(`${e.slice(cut + 1)}>${e.slice(0, cut)}`) ?? [];
    if (mine.length === 0 || theirs.length === 0) return false;
    const ok = indexMatched[pair]!;
    return mine.every((k) => ok.has(k)) && theirs.every((k) => ok.has(k));
  };

  const first = 0;
  const last = levels.length - 1;

  for (const key of outerRings.keys()) {
    const outer = outerRings.get(key)!;
    // Missing means a border piece: solid, so its "hole" is empty and
    // `addAnnulus` falls back to a fan.
    const inner = innerRings.get(key) ?? levels.map(() => [] as Point[]);
    const zLo = levels[first]!.z;
    const zHi = levels[last]!.z;

    // Caps. The bottom faces −z, so its annulus is wound the other way round.
    addAnnulus(tris, outer, inner[first]!, zLo, false);
    addAnnulus(tris, outer, inner[last]!, zHi, true);

    // Inner skin: one band per step of the bore, facing into the hole.
    for (let j = 0; j < levels.length - 1; j++) {
      const a = inner[j]!;
      const b = inner[j + 1]!;
      if (a.length < 3 || b.length < 3) continue;
      const za = levels[j]!.z;
      const zb = levels[j + 1]!.z;
      if (a.length === b.length) {
        for (let k = 0; k < a.length; k++) {
          const k2 = (k + 1) % a.length;
          // On the boundary of no bore at either level: hole on both sides, so
          // this band is not a surface. Both pieces drop it, which is what
          // leaves the bore closed instead of opening the mesh.
          if (internalBore(j, j, `${edgeId(a[k]!)}>${edgeId(a[k2]!)}`) &&
              internalBore(j, j + 1, `${edgeId(b[k]!)}>${edgeId(b[k2]!)}`)) continue;
          // Wound so the normal points at the cell centre: the hole's surface
          // is the outside of the solid.
          tris.quad(
            { ...a[k]!, z: za }, { ...b[k]!, z: zb },
            { ...b[k2]!, z: zb }, { ...a[k2]!, z: za },
          );
        }
      } else {
        /*
         * A CLIPPED bore. Matching ring j to ring j+1 by index is only valid
         * while every level is the same hexagon with the same six corners — cut
         * by a zone, one level can lose a corner the next keeps, and the strip
         * folds back on itself. `addSkirt` merges them by bearing instead, the
         * way `addAnnulus` already merges a cap.
         */
        addSkirt(tris, a, za, b, zb);
      }
    }
  }

  // Outer skin. An edge shared by two cells is internal and must not be drawn;
  // finding those by cancelling opposite directed edges also catches the ones a
  // border cut in half, which no neighbour test would.
  for (const [a, b] of boundaryEdges(outerRings)) {
    // a -> b is the cell ring's own order, which is counter-clockwise, so this
    // winding puts the normal on the outside. Reversed, the plate slices
    // inside-out along its edge.
    tris.quad(
      { ...a, z: levels[first]!.z }, { ...b, z: levels[first]!.z },
      { ...b, z: levels[last]!.z }, { ...a, z: levels[last]!.z },
    );
  }

  const mesh = tris.build();
  if (spec.originAtZero !== false) moveToOrigin(mesh);
  return mesh;
}

/**
 * How many mountable cells the plate has.
 *
 * Just the cells. A border takes none of them — that is the whole difference
 * between this border and the customiser's, which cuts a column in half — so
 * this is here to say so rather than to compute anything.
 */
export function honeycombCellCount(spec: HoneycombSpec): number {
  return dedupe(spec.cells).length;
}

// ---------------------------------------------------------------------------
// Shared corners
// ---------------------------------------------------------------------------

/** Neighbour order matching `hexCorners`: edge `i` spans corners `i` and `i+1`. */
const DIRS: readonly Hex[] = [
  { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 },
  { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 },
];

/**
 * One canonical position per lattice corner, shared by the three cells that meet
 * there.
 *
 * Three cells meet at every corner, and each computes it from its own centre, so
 * on a lattice whose `ROW_STEP` is rounded they disagree by ~0.0003 mm. Keyed on
 * the unordered triple of cells, the first one to ask decides — so whichever
 * order the cells are visited in, every one of them emits the same vertex and
 * the shared edges cancel to the bit.
 */
function cornerPositions() {
  const cache = new Map<string, Point>();
  const rings = new Map<string, Point[]>();

  const cornerAt = (c: Hex, i: number): Point => {
    const n1 = { q: c.q + DIRS[i]!.q, r: c.r + DIRS[i]!.r };
    const back = DIRS[(i + 5) % 6]!;
    const n2 = { q: c.q + back.q, r: c.r + back.r };
    const key = [hexKey(c), hexKey(n1), hexKey(n2)].sort().join('|');
    const seen = cache.get(key);
    if (seen) return seen;
    // The same point three ways: corner i of this cell is corner i+4 of the
    // neighbour across edge i, and corner i+2 of the neighbour across edge i−1.
    const a = hexCorners(c)[i]!;
    const b = hexCorners(n1)[(i + 4) % 6]!;
    const d = hexCorners(n2)[(i + 2) % 6]!;
    const p = { x: (a.x + b.x + d.x) / 3, y: (a.y + b.y + d.y) / 3 };
    cache.set(key, p);
    return p;
  };

  return {
    ringOf(c: Hex): Point[] {
      const key = hexKey(c);
      const seen = rings.get(key);
      if (seen) return seen;
      const ring = [0, 1, 2, 3, 4, 5].map((i) => cornerAt(c, i));
      rings.set(key, ring);
      return ring;
    },
  };
}

/**
 * The plate's outline, as directed edges with no opposite.
 *
 * Cancelling opposites rather than asking "is the neighbour cell present?"
 * because with a border the answer is not enough: the neighbour can be present
 * and yet share only part of the edge, or none of it.
 */
function boundaryEdges(rings: ReadonlyMap<string, Point[]>): Array<[Point, Point]> {
  const seen = new Map<string, { a: Point; b: Point; count: number }>();
  // Exact, not rounded. `cornerPositions` exists so that two cells produce the
  // same corner to the bit; a tolerance here would let a crack cancel on paper
  // and still be a crack in the file.
  const id = (p: Point) => `${p.x},${p.y}`;
  for (const ring of rings.values()) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const ka = id(a);
      const kb = id(b);
      if (ka === kb) continue;
      const forward = `${ka}>${kb}`;
      const backward = `${kb}>${ka}`;
      const opposite = seen.get(backward);
      if (opposite && opposite.count > 0) {
        opposite.count--;
        continue;
      }
      const mine = seen.get(forward);
      if (mine) mine.count++;
      else seen.set(forward, { a, b, count: 1 });
    }
  }
  const out: Array<[Point, Point]> = [];
  for (const e of seen.values()) {
    for (let k = 0; k < e.count; k++) out.push([e.a, e.b]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Convex geometry
// ---------------------------------------------------------------------------

interface HalfPlane {
  nx: number;
  ny: number;
  d: number;
}

/**
 * Sutherland–Hodgman, with the endpoints put in a canonical order first.
 *
 * Two cells that share an edge clip that same edge from opposite ends. Computed
 * as written, `A + t·(B − A)` and `B + s·(A − B)` land a couple of ULPs apart —
 * enough for the two cells to emit different vertices and for the edge to stop
 * cancelling, which is a crack in the plate. Sorting the pair first makes the
 * arithmetic identical whichever cell asks.
 */
export function clipConvex(poly: readonly Point[], planes: readonly HalfPlane[]): Point[] {
  let out = poly.slice();
  for (const pl of planes) {
    if (out.length === 0) return out;
    const next: Point[] = [];
    for (let i = 0; i < out.length; i++) {
      const cur = out[i]!;
      const prev = out[(i + out.length - 1) % out.length]!;
      const dCur = pl.nx * cur.x + pl.ny * cur.y - pl.d;
      const dPrev = pl.nx * prev.x + pl.ny * prev.y - pl.d;
      /*
       * ON the plane counts as INSIDE, to within `SAME` (D84).
       *
       * Every plane here is axis-aligned with a unit normal, so `d` is a signed
       * distance in millimetres and the tolerance is a real one. It is not
       * fussiness: a rail's line is `cellCentre ± MARGIN`, recomputed, while the
       * corners it lands on come from `cornerPositions`, which averages three
       * cells to snap them. The two agree to about 3e-15 mm, with the sign of
       * the disagreement decided by rounding.
       *
       * Tested exactly, one corner of a shared edge then reads as outside and
       * the other as inside, and the cut is interpolated between two distances
       * of ±1.8e-15 — which puts it at t = 0.5, the MIDDLE of the edge. The
       * piece comes out with an extra vertex halfway along a face it shares with
       * a cell, so that face never cancels against the cell's, a wall is drawn
       * between two solids that are touching, and the border prints as a
       * separate object: measured, a bordered plate's whole bottom rail as a
       * loose strip. A tolerance here keeps the edge whole and identical on both
       * sides, which is the only thing that makes them one solid.
       */
      const curIn = dCur <= SAME;
      const prevIn = dPrev <= SAME;
      if (curIn !== prevIn) next.push(cutEdge(prev, cur, pl));
      if (curIn) next.push(cur);
    }
    out = dropRepeats(next);
  }
  return out;
}

function cutEdge(a: Point, b: Point, pl: HalfPlane): Point {
  // Canonical order, so the same physical edge gives the same point from either
  // side. See the note on `clipConvex`.
  const [p, q] = a.x < b.x || (a.x === b.x && a.y <= b.y) ? [a, b] : [b, a];
  const dp = pl.nx * p.x + pl.ny * p.y - pl.d;
  const dq = pl.nx * q.x + pl.ny * q.y - pl.d;
  const denom = dp - dq;
  if (denom === 0) return { x: p.x, y: p.y };
  const t = dp / denom;
  const cut = { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) };
  /*
   * A cut landing ON a corner IS that corner (D84).
   *
   * The rail lines are recomputed — `cellCentre + MARGIN_Y` — while the corner
   * they are meant to fall on comes out of `cornerPositions`, which averages
   * three cells to snap it. The two agree to about 3e-14 mm and no further, so
   * whether a corner counts as inside its own rail line is decided by rounding.
   * Counted outside, `clipConvex` drops it and inserts a fresh vertex a few ULPs
   * away — and a border that meets the honeycomb along that line then shares no
   * vertex with it, so the edge never cancels and the two are separate solids.
   *
   * Printed: a bordered plate whose whole top rail came off as a loose 3.6 mm
   * strip the width of the plate, on any plate whose top row rounded the wrong
   * way. Snapping the cut back onto the corner moves it by less than 1e-9 mm and
   * restores the shared vertex. Both ends are tested because the canonical order
   * above decides which is which, not the caller.
   *
   * This is the same rule `cornerPositions` exists for, applied one level up:
   * anything matching vertices by coordinate on this lattice must snap first.
   */
  if (Math.abs(cut.x - p.x) < SAME && Math.abs(cut.y - p.y) < SAME) return { x: p.x, y: p.y };
  if (Math.abs(cut.x - q.x) < SAME && Math.abs(cut.y - q.y) < SAME) return { x: q.x, y: q.y };
  return cut;
}

const SAME = 1e-9;

/**
 * Put `points` onto `poly` as vertices wherever one lies along one of its edges.
 *
 * `boundaryEdges` cancels a shared face only on an EXACT endpoint match, which
 * is right — a tolerance there would let a real crack cancel on paper. The cost
 * is that two pieces meeting along PART of an edge cancel nothing: the longer
 * face and the shorter face are different edges, both survive, and a wall is
 * drawn between two solids that are touching. The mesh stays closed — it is
 * simply two closed shells now — so `meshIsClosed` cannot see it and only a
 * connected-component test can.
 *
 * That is a T-junction, and this is the standard repair: give the longer edge a
 * vertex where the shorter one ends, so the two coincident stretches become
 * identical edges and cancel. It moves no boundary — an inserted point is
 * collinear with the edge it splits, to within `SAME` — so the solid is
 * unchanged and only its vertex set grows.
 */
/**
 * Give every piece a vertex wherever a neighbour's vertex lands mid-edge.
 *
 * WHY EVERY PIECE AND NOT JUST THE ONE THAT CAUSED THE REPORT
 * ----------------------------------------------------------
 * `boundaryEdges` cancels a shared face only when both sides present the SAME
 * edge, so two pieces meeting along part of an edge cancel nothing and a wall is
 * drawn between two solids that are touching. Unclipped cells never hit it —
 * `cornerPositions` makes neighbours agree to the bit — but the moment a zone
 * clips two neighbours on DIFFERENT planes their shared stretch stops matching,
 * and that is ordinary rather than exotic: a zone edge lands where the user drew
 * it, and every cell along it is cut by a slightly different set of planes.
 *
 * Fixed one case at a time this reappeared four times in one sitting (the corner
 * arm, then a clipped cell against an unclipped neighbour, then the plate's own
 * edge, then two zones meeting). Measured over 45,066 single-zone placements,
 * case-by-case fixes left 11.7% of them splitting the plate; this pass leaves
 * none, because it addresses the mechanism rather than the instances.
 *
 * It moves NOTHING. An inserted point is collinear with the edge it splits to
 * within `SAME`, so every piece keeps its exact shape and only its vertex set
 * grows — which is the whole reason this is safe to do everywhere.
 *
 * The grid keeps it linear-ish: a vertex can only split an edge it is within
 * `SAME` of, so only pieces in the neighbouring buckets can possibly be
 * involved, and a plate's pieces are spread over its whole area.
 */
function weldTJunctions(rings: Map<string, Point[]>): void {
  // One PITCH per bucket: an edge is at most a cell across, so a vertex that
  // splits it is in this bucket or one beside it.
  const bucket = (v: number) => Math.floor(v / PITCH);
  const grid = new Map<string, Point[]>();
  for (const ring of rings.values()) {
    for (const p of ring) {
      const k = `${bucket(p.x)},${bucket(p.y)}`;
      const at = grid.get(k);
      if (at) at.push(p);
      else grid.set(k, [p]);
    }
  }

  for (const [key, ring] of rings) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of ring) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const near: Point[] = [];
    for (let bx = bucket(minX) - 1; bx <= bucket(maxX) + 1; bx++) {
      for (let by = bucket(minY) - 1; by <= bucket(maxY) + 1; by++) {
        const at = grid.get(`${bx},${by}`);
        if (at) near.push(...at);
      }
    }
    if (near.length === 0) continue;
    const welded = weldCollinear(ring, near);
    if (welded.length !== ring.length) rings.set(key, welded);
  }
}

function weldCollinear(poly: readonly Point[], points: readonly Point[]): Point[] {
  if (poly.length < 3 || points.length === 0) return [...poly];
  let out = [...poly];
  for (const p of points) {
    // Already a vertex: nothing to split, and re-inserting would make a repeat.
    if (out.some((v) => Math.abs(v.x - p.x) < SAME && Math.abs(v.y - p.y) < SAME)) continue;
    for (let i = 0; i < out.length; i++) {
      const a = out[i]!;
      const b = out[(i + 1) % out.length]!;
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const apx = p.x - a.x;
      const apy = p.y - a.y;
      const len = Math.hypot(abx, aby);
      if (len < SAME) continue;
      // Off the line, or off the end of it: not this edge.
      if (Math.abs(abx * apy - aby * apx) / len > SAME) continue;
      const t = (apx * abx + apy * aby) / (len * len);
      if (t <= SAME || t >= 1 - SAME) continue;
      out = [...out.slice(0, i + 1), { x: p.x, y: p.y }, ...out.slice(i + 1)];
      break;
    }
  }
  return out;
}

function dropRepeats(poly: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < SAME && Math.abs(last.y - p.y) < SAME) continue;
    out.push(p);
  }
  const head = out[0];
  const tail = out[out.length - 1];
  if (out.length > 1 && head && tail &&
      Math.abs(head.x - tail.x) < SAME && Math.abs(head.y - tail.y) < SAME) {
    out.pop();
  }
  return out;
}

/**
 * Triangulate the ring between two convex polygons, the inner strictly inside
 * the outer, using only the vertices they already have.
 *
 * Adding vertices is what would break the seal: the outer ring's vertices are
 * shared with the neighbouring cell, and a Steiner point on a shared edge would
 * exist on one side of it and not the other. So the two rings are walked
 * together by angle about the inner ring's centroid — which is inside both,
 * because both are convex — and every step emits one triangle.
 */
function addAnnulus(
  tris: TriangleSink,
  outer: readonly Point[],
  inner: readonly Point[],
  z: number,
  faceUp: boolean,
): void {
  if (outer.length < 3) return;
  if (inner.length < 3) {
    // No hole here at all: a fan is enough. Happens only when a border wall has
    // swallowed the bore completely.
    for (let i = 1; i + 1 < outer.length; i++) {
      tris.tri(
        { ...outer[0]!, z }, { ...outer[i]!, z }, { ...outer[i + 1]!, z }, faceUp,
      );
    }
    return;
  }
  let cx = 0;
  let cy = 0;
  for (const p of inner) { cx += p.x; cy += p.y; }
  cx /= inner.length;
  cy /= inner.length;

  // Both rings are convex and contain this point, so going round either one the
  // bearing increases monotonically. That turns the strip into a merge of two
  // sorted lists — no search, no folded triangles.
  const zero = Math.atan2(outer[0]!.y - cy, outer[0]!.x - cx);
  const bearings = (ring: readonly Point[]) =>
    ring.map((p) => wrap(Math.atan2(p.y - cy, p.x - cx) - zero));

  const outerAng = bearings(outer);
  const innerRaw = bearings(inner);
  // Rotate the inner ring so its walk starts at the same bearing as the outer's.
  let start = 0;
  for (let k = 1; k < innerRaw.length; k++) {
    if (innerRaw[k]! < innerRaw[start]!) start = k;
  }
  const m = inner.length;
  const innerRing = Array.from({ length: m }, (_, k) => inner[(start + k) % m]!);
  const innerAng = Array.from({ length: m }, (_, k) => innerRaw[(start + k) % m]!);

  const n = outer.length;
  const TAU = Math.PI * 2;
  const nextOuter = (k: number) => (k + 1 < n ? outerAng[k + 1]! : TAU);
  const nextInner = (k: number) => (k + 1 < m ? innerAng[k + 1]! : TAU);

  let oi = 0;
  let ii = 0;
  while (oi < n || ii < m) {
    const takeOuter = ii >= m || (oi < n && nextOuter(oi) <= nextInner(ii));
    if (takeOuter) {
      tris.tri(
        { ...outer[oi]!, z }, { ...outer[(oi + 1) % n]!, z }, { ...innerRing[ii % m]!, z },
        faceUp,
      );
      oi++;
    } else {
      tris.tri(
        { ...outer[oi % n]!, z }, { ...innerRing[(ii + 1) % m]!, z }, { ...innerRing[ii]!, z },
        faceUp,
      );
      ii++;
    }
  }
}

/**
 * A wall between two convex rings at different heights, merged by BEARING.
 *
 * The ordinary bore wall pairs vertex k of one ring with vertex k of the next,
 * which is exact while every level is the same hexagon at a different size. A
 * zone clip breaks that: one level can lose a corner the next one keeps, so the
 * counts differ and index pairing folds the strip through itself.
 *
 * Both rings are convex and both wrap the cell centre — the caller drops the
 * bore entirely when that stops being true — so walking either one from the
 * same origin gives monotonically increasing bearings, and the strip is a merge
 * of two sorted lists. The same argument `addAnnulus` makes for a flat cap,
 * stood up on its side.
 */
function addSkirt(
  tris: TriangleSink,
  lo: readonly Point[],
  zLo: number,
  hi: readonly Point[],
  zHi: number,
): void {
  if (lo.length < 3 || hi.length < 3) return;
  let cx = 0;
  let cy = 0;
  for (const p of lo) { cx += p.x; cy += p.y; }
  cx /= lo.length;
  cy /= lo.length;

  const zero = Math.atan2(lo[0]!.y - cy, lo[0]!.x - cx);
  const ang = (ring: readonly Point[]) =>
    ring.map((p) => wrap(Math.atan2(p.y - cy, p.x - cx) - zero));

  const aAng = ang(lo);
  const bRaw = ang(hi);
  let start = 0;
  for (let k = 1; k < bRaw.length; k++) if (bRaw[k]! < bRaw[start]!) start = k;
  const m = hi.length;
  const bRing = Array.from({ length: m }, (_, k) => hi[(start + k) % m]!);
  const bAng = Array.from({ length: m }, (_, k) => bRaw[(start + k) % m]!);

  const n = lo.length;
  const TAU = Math.PI * 2;
  const nextA = (k: number) => (k + 1 < n ? aAng[k + 1]! : TAU);
  const nextB = (k: number) => (k + 1 < m ? bAng[k + 1]! : TAU);

  let ai = 0;
  let bi = 0;
  while (ai < n || bi < m) {
    // Wound so the normal points at the cell centre, matching the un-clipped
    // wall above: the hole's surface is the outside of the solid.
    if (bi >= m || (ai < n && nextA(ai) <= nextB(bi))) {
      tris.tri(
        { ...lo[ai]!, z: zLo }, { ...bRing[bi % m]!, z: zHi },
        { ...lo[(ai + 1) % n]!, z: zLo },
      );
      ai++;
    } else {
      tris.tri(
        { ...lo[ai % n]!, z: zLo }, { ...bRing[bi]!, z: zHi },
        { ...bRing[(bi + 1) % m]!, z: zHi },
      );
      bi++;
    }
  }
}

function wrap(a: number): number {
  const TAU = Math.PI * 2;
  let x = a % TAU;
  if (x < 0) x += TAU;
  return x;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface P3 { x: number; y: number; z: number }

class TriangleSink {
  private readonly xs: number[] = [];

  /**
   * A triangle. `faceUp` flips the winding for a downward-facing cap, so both
   * caps are wound outward from the solid.
   */
  tri(a: P3, b: P3, c: P3, faceUp = true): void {
    if (faceUp) this.push(a, b, c);
    else this.push(a, c, b);
  }

  /** Four corners in order round the quad; split along a–c. */
  quad(a: P3, b: P3, c: P3, d: P3): void {
    this.push(a, b, c);
    this.push(a, c, d);
  }

  private push(a: P3, b: P3, c: P3): void {
    this.xs.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }

  build(): SolidMesh {
    return { positions: Float64Array.from(this.xs), triangleCount: this.xs.length / 9 };
  }
}

function dedupe(cells: readonly Hex[]): Hex[] {
  const seen = new Set<string>();
  const out: Hex[] = [];
  for (const c of cells) {
    const k = hexKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

function moveToOrigin(mesh: SolidMesh): void {
  const p = mesh.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i]! < minX) minX = p[i]!;
    if (p[i + 1]! < minY) minY = p[i + 1]!;
    if (p[i + 2]! < minZ) minZ = p[i + 2]!;
  }
  for (let i = 0; i < p.length; i += 3) {
    p[i] = p[i]! - minX;
    p[i + 1] = p[i + 1]! - minY;
    p[i + 2] = p[i + 2]! - minZ;
  }
}

// ---------------------------------------------------------------------------
// Measurement and export
// ---------------------------------------------------------------------------

export function meshBoundsMm(mesh: SolidMesh): {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
} {
  const p = mesh.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}

/** Signed-tetrahedron volume, the same sum `measureMesh` uses. */
export function meshVolumeMm3(mesh: SolidMesh): number {
  const p = mesh.positions;
  let v = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i]!, ay = p[i + 1]!, az = p[i + 2]!;
    const bx = p[i + 3]!, by = p[i + 4]!, bz = p[i + 5]!;
    const cx = p[i + 6]!, cy = p[i + 7]!, cz = p[i + 8]!;
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

/**
 * Is the surface closed and consistently wound?
 *
 * Every directed edge must have exactly one opposite. That is stronger than
 * "watertight" — it also rejects a mesh whose triangles are wound inconsistently,
 * which slices as a solid with its inside and outside swapped in places.
 *
 * Vertices are compared exactly, on purpose: the snapping in `cornerPositions`
 * exists so they ARE exact, and a tolerance here would hide it failing.
 */
export function meshIsClosed(mesh: SolidMesh): {
  closed: boolean;
  unmatchedEdges: number;
  degenerate: number;
} {
  const p = mesh.positions;
  const balance = new Map<string, number>();
  const id = (i: number) => `${p[i]!},${p[i + 1]!},${p[i + 2]!}`;
  let degenerate = 0;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const i = t * 9;
    const v = [id(i), id(i + 3), id(i + 6)];
    if (v[0] === v[1] || v[1] === v[2] || v[2] === v[0]) { degenerate++; continue; }
    for (let k = 0; k < 3; k++) {
      const a = v[k]!;
      const b = v[(k + 1) % 3]!;
      const forward = a < b ? `${a}|${b}` : `${b}|${a}`;
      const sign = a < b ? 1 : -1;
      balance.set(forward, (balance.get(forward) ?? 0) + sign);
    }
  }
  let unmatched = 0;
  for (const n of balance.values()) if (n !== 0) unmatched++;
  return { closed: unmatched === 0, unmatchedEdges: unmatched, degenerate };
}

/**
 * A binary STL.
 *
 * Binary, not ASCII: a 400 mm plate is ~90,000 triangles, which is 4.5 MB binary
 * against ~25 MB of text, and `parseStl` reads binary by size so the round trip
 * is exact rather than re-parsed from decimal.
 */
export function toBinaryStl(mesh: SolidMesh, header = 'honeycomb planner'): ArrayBuffer {
  const n = mesh.triangleCount;
  const buffer = new ArrayBuffer(84 + n * 50);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const name = new TextEncoder().encode(header.slice(0, 79));
  bytes.set(name.subarray(0, 80), 0);
  view.setUint32(80, n, true);

  const p = mesh.positions;
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const ax = p[i]!, ay = p[i + 1]!, az = p[i + 2]!;
    const bx = p[i + 3]!, by = p[i + 4]!, bz = p[i + 5]!;
    const cx = p[i + 6]!, cy = p[i + 7]!, cz = p[i + 8]!;
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    let at = 84 + t * 50;
    view.setFloat32(at, nx, true);
    view.setFloat32(at + 4, ny, true);
    view.setFloat32(at + 8, nz, true);
    at += 12;
    for (const v of [ax, ay, az, bx, by, bz, cx, cy, cz]) {
      view.setFloat32(at, v, true);
      at += 4;
    }
    view.setUint16(at, 0, true);
  }
  return buffer;
}
