/**
 * Axial hex coordinate math for the pointy-top HSW lattice.
 *
 * Pure functions only — no DOM, no state, no side effects. Every position in the
 * document is a Hex; millimetres appear only when crossing into the renderer.
 *
 * Convention (pointy-top, "axial" / "trapezoidal" layout):
 *   x = PITCH·(q + r/2)
 *   y = ROW_STEP·r
 * so +q moves one cell right along a row and +r moves one row down-right.
 */

import { LATTICE_ANCHOR, PITCH, ROW_STEP, MARGIN_X, MARGIN_Y } from './constants';
import type { Hex, Rotation } from './types';

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

export const hex = (q: number, r: number): Hex => ({ q, r });

export const hexEq = (a: Hex, b: Hex): boolean => a.q === b.q && a.r === b.r;

export const hexAdd = (a: Hex, b: Hex): Hex => ({ q: a.q + b.q, r: a.r + b.r });

export const hexSub = (a: Hex, b: Hex): Hex => ({ q: a.q - b.q, r: a.r - b.r });

/**
 * Stable string key for map/set membership.
 * Deliberately not JSON.stringify: key order would be a latent correctness bug.
 */
export const hexKey = (h: Hex): string => `${h.q},${h.r}`;

export const keyToHex = (key: string): Hex => {
  const comma = key.indexOf(',');
  return { q: Number(key.slice(0, comma)), r: Number(key.slice(comma + 1)) };
};

// ---------------------------------------------------------------------------
// Cube coordinates — only used internally for distance and rounding, where the
// third axis makes the maths trivial and the alternatives error-prone.
// ---------------------------------------------------------------------------

interface Cube {
  x: number;
  y: number;
  z: number;
}

const toCube = (h: Hex): Cube => ({ x: h.q, z: h.r, y: -h.q - h.r });

/**
 * Normalise -0 to 0.
 *
 * `-q - r` is -0 when both are 0, and the cube rotation step propagates that
 * negated zero into the result. It is invisible to `===`, `hexKey` and
 * `JSON.stringify`, but NOT to `Object.is`, to deep-equality memoisation, or to
 * a Map keyed on the raw object — and `expect(-0).toEqual(0)` fails. Cheaper to
 * kill it here than to debug a rotation that is "equal but not equal" later.
 */
const z0 = (n: number): number => (n === 0 ? 0 : n);

const fromCube = (c: Cube): Hex => ({ q: z0(c.x), r: z0(c.z) });

/** Number of steps between two cells. */
export function hexDistance(a: Hex, b: Hex): number {
  const ac = toCube(a);
  const bc = toCube(b);
  return Math.max(Math.abs(ac.x - bc.x), Math.abs(ac.y - bc.y), Math.abs(ac.z - bc.z));
}

/** The six neighbour directions, in order of increasing angle. */
export const HEX_DIRECTIONS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 0, r: 1 },
  { q: -1, r: 1 },
  { q: -1, r: 0 },
  { q: 0, r: -1 },
  { q: 1, r: -1 },
] as const;

/**
 * Neighbour in direction `dir`, which is taken modulo 6.
 *
 * A non-integer or non-finite direction is a caller bug, so it throws with a
 * useful message rather than indexing to `undefined` and dying inside `hexAdd`
 * with "cannot read property q".
 */
export function hexNeighbour(h: Hex, dir: number): Hex {
  if (!Number.isInteger(dir)) {
    throw new TypeError(`hexNeighbour: direction must be an integer, got ${dir}`);
  }
  const d = HEX_DIRECTIONS[((dir % 6) + 6) % 6];
  if (!d) throw new TypeError(`hexNeighbour: no direction ${dir}`);
  return hexAdd(h, d);
}

export const hexNeighbours = (h: Hex): Hex[] => HEX_DIRECTIONS.map((d) => hexAdd(h, d));

/**
 * The two corners of `hexCorners` that bound the edge shared with neighbour
 * `dir`: corners `dir` and `dir + 1`.
 *
 * A lattice fact, and one that has now been got wrong twice — once in
 * `WallView3D`'s `unionOutline`, which drew edge k as corners k+1 → k+2 and
 * turned the plate into a scatter of open wedges, and once in `WallCanvas`,
 * which drew every part outline and every panel seam one edge round. It is
 * FORCED by the corner angles: with corners at 0°, 60°, … the neighbour at
 * `HEX_DIRECTIONS[0]` sits up and to the right, across the edge between corner 0
 * and corner 1. Named here so nobody derives it a third time — the two off-by-one
 * versions look entirely plausible on screen.
 */
export const edgeCorners = (dir: number): [number, number] => {
  const d = ((Math.trunc(dir) % 6) + 6) % 6;
  return [d, (d + 1) % 6];
};

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/**
 * Rotate a cell about the origin by `steps` × 60° clockwise on screen.
 *
 * In cube space one 60° step is (x,y,z) -> (-z,-x,-y). Doing it this way rather
 * than with a 2×2 matrix keeps everything in exact integers, so a shape rotated
 * six times is bit-identical to the original — which is what makes rotate-then-
 * undo safe.
 */
export function hexRotate(h: Hex, steps: number): Hex {
  const n = ((steps % 6) + 6) % 6;
  let c = toCube(h);
  for (let i = 0; i < n; i++) c = { x: -c.z, y: -c.x, z: -c.y };
  return fromCube(c);
}

/** Rotate a whole footprint about its anchor. */
export const rotateFootprint = (cells: readonly Hex[], steps: Rotation): Hex[] =>
  cells.map((c) => hexRotate(c, steps));

/** Place a footprint: rotate about the anchor, then translate to `at`. */
export function placeFootprint(cells: readonly Hex[], at: Hex, rotation: Rotation): Hex[] {
  const n = ((rotation % 6) + 6) % 6;
  const out: Hex[] = new Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const c = hexRotate(cells[i]!, n);
    out[i] = { q: c.q + at.q, r: c.r + at.r };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Millimetres <-> cells
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

/**
 * Centre of a cell in wall millimetres. FLAT-TOP (DECISIONS D35).
 *
 * Columns step `ROW_STEP` across; cells within a column step `PITCH` down, and
 * each column sits half a `PITCH` below its neighbour. That is the designer's
 * own frame: `23.6` vertical and `40.88 = 2 × ROW_STEP` horizontal are the two
 * numbers dimensioned on the insert drawing (HSW-SPEC §10.2).
 *
 * The previous embedding was this turned 90°, which is why every panel measured
 * transposed against its own source — `wall-honeycomb-part` came out 177 × 170.32
 * where the drawing says 170.32 × 177.
 */
export const hexToMm = (h: Hex): Point => ({
  x: ROW_STEP * h.q + LATTICE_ANCHOR.x,
  y: PITCH * (h.r + h.q / 2) + LATTICE_ANCHOR.y,
});

/**
 * Nearest cell to a point in wall millimetres.
 *
 * Rounds in cube space so the result is always the true nearest cell — naive
 * rounding of fractional axial coordinates picks the wrong hexagon near the
 * corners, which shows up as a drop landing one cell off.
 */
export function mmToHex(p: Point): Hex {
  const q = (p.x - LATTICE_ANCHOR.x) / ROW_STEP;
  const r = (p.y - LATTICE_ANCHOR.y) / PITCH - q / 2;
  return hexRound(q, r);
}

/** Round fractional axial coordinates to the nearest cell. */
export function hexRound(qf: number, rf: number): Hex {
  const xf = qf;
  const zf = rf;
  const yf = -qf - rf;

  let x = Math.round(xf);
  let y = Math.round(yf);
  let z = Math.round(zf);

  const dx = Math.abs(x - xf);
  const dy = Math.abs(y - yf);
  const dz = Math.abs(z - zf);

  // Fix up whichever axis moved most, so x + y + z stays 0.
  if (dx > dy && dx > dz) x = -y - z;
  else if (dy > dz) y = -x - z;
  else z = -x - y;

  return { q: x, r: z };
}

/**
 * The six corners of a cell, in wall millimetres, starting at the right-hand
 * corner. FLAT-TOP: a corner at 0° and 180°, a flat edge across the top.
 *
 * The `− 90` that used to be here is what made the cell pointy-top. It went with
 * the frame (D35); every reference photograph shows a flat top.
 */
export function hexCorners(h: Hex, acrossFlats: number = PITCH): Point[] {
  const c = hexToMm(h);
  const R = acrossFlats / Math.sqrt(3);
  const pts: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i);
    pts.push({ x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

/**
 * The cells of a rectangular panel: `columns` × `rows`, staggered, with the
 * left-hand column starting at `origin`.
 *
 * The stagger is the whole point — column q is offset half a pitch from column
 * q−1, and in axial coordinates that offset is already baked into the basis, so
 * a "rectangle" on the wall is a sheared range in (q, r).
 *
 * Built along q, and the shear is undone on r. Both are consequences of the
 * flat-top frame (D35): a column is now the vertical run, so the block is
 * generated column by column.
 */
export function panelCells(origin: Hex, columns: number, rows: number): Hex[] {
  // `c < columns` never terminates for +Infinity, so a corrupted document could
  // hang the tab rather than render badly. Clamp to whole, finite, sane counts.
  const cols = Number.isFinite(columns) ? Math.floor(columns) : 0;
  const rowCount = Number.isFinite(rows) ? Math.floor(rows) : 0;
  if (cols <= 0 || rowCount <= 0) return [];

  const out: Hex[] = [];
  for (let c = 0; c < cols; c++) {
    // Undo half the axial shear so the block stays visually rectangular.
    //
    // FLOOR, not ceil — and the flip is not cosmetic. Both keep the block
    // rectangular but they choose opposite parities, and the wrong one MIRRORS
    // the panel: a panel is not symmetric (one face is the 20 mm insert throat,
    // the other the 22 mm mouth), so every per-cell instruction would land on
    // the wrong side, invisibly until it is printed.
    //
    // It was CEIL in the pointy-top frame. The parity that keeps a block
    // unmirrored depends on the frame, so turning the wall flipped it. Not
    // chosen: `floor` is the value that reproduces all seven measured panel
    // footprints under the D35 relabel, and `ceil` reproduces none of them.
    // tests/panel-parity.test.ts is the guard.
    const rShift = -Math.floor(c / 2);
    for (let r = 0; r < rowCount; r++) {
      out.push({ q: origin.q + c, r: origin.r + r + rShift });
    }
  }
  return out;
}

/**
 * The cells a PLACED panel actually covers.
 *
 * The block minus whatever it omits. Every consumer must go through this rather
 * than calling `panelCells` on the panel's origin/columns/rows, or a custom
 * panel with a hole cut for a light switch would be treated as solid by
 * whichever module forgot — and the two most likely to forget are the ones that
 * decide where fixings go and whether an accessory is off-panel.
 */
export function placedPanelCells(panel: {
  origin: Hex;
  columns: number;
  rows: number;
  omit?: readonly Hex[];
}): Hex[] {
  const cells = panelCells(panel.origin ?? { q: 0, r: 0 }, panel.columns, panel.rows);
  if (!panel.omit || panel.omit.length === 0) return cells;
  const cut = new Set(panel.omit.map(hexKey));
  return cells.filter((c) => !cut.has(hexKey(c)));
}

/** Bounding box of a set of cells, in wall millimetres, including cell extents. */
export function cellsBoundsMm(cells: readonly Hex[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  if (cells.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of cells) {
    const p = hexToMm(c);
    if (p.x - MARGIN_X < minX) minX = p.x - MARGIN_X;
    if (p.x + MARGIN_X > maxX) maxX = p.x + MARGIN_X;
    if (p.y - MARGIN_Y < minY) minY = p.y - MARGIN_Y;
    if (p.y + MARGIN_Y > maxY) maxY = p.y + MARGIN_Y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Where to put a part's mesh so it lands on the cells it claims.
 *
 * The BOUNDING-BOX centre of the cells, and emphatically NOT their mean.
 *
 * `meshLibrary.orient` centres a part's geometry on its own wall-plane bounding
 * box — `(min + max) / 2` on each axis. So the point in lattice space that the
 * mesh's middle corresponds to is the middle of the cells' bounding box. Those
 * two agree for a symmetric footprint and diverge for anything else: on the
 * L-shaped `insert-hollow-tre` (cells (0,0), (0,1), (1,0)) the mean sits
 * 3.406 mm to the left of the box centre, so the part was drawn 3.4 mm off the
 * holes it goes into — on the wall, in the hover outline, and in the alignment
 * dialog, all three having independently taken the mean.
 *
 * One function so they cannot drift apart again. The margins in
 * `cellsBoundsMm` are equal on opposite sides and would cancel, so this
 * computes from the centres directly and gets the same answer more cheaply.
 */
export function cellsCentreMm(cells: readonly Hex[]): { x: number; y: number } {
  if (cells.length === 0) return { x: 0, y: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of cells) {
    const p = hexToMm(c);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

/**
 * Which cells are taken, and by what. Built fresh from the document on every
 * change: it is O(cells) and removes any chance of a stale index disagreeing
 * with the document, which is the classic source of "it let me drop it there".
 */
export class Occupancy {
  private readonly map = new Map<string, string>();

  /** @returns the id already occupying a cell, or null if all cells were free. */
  add(id: string, cells: readonly Hex[]): string | null {
    for (const c of cells) {
      const existing = this.map.get(hexKey(c));
      if (existing !== undefined && existing !== id) return existing;
    }
    for (const c of cells) this.map.set(hexKey(c), id);
    return null;
  }

  remove(cells: readonly Hex[]): void {
    for (const c of cells) this.map.delete(hexKey(c));
  }

  occupantOf(c: Hex): string | undefined {
    return this.map.get(hexKey(c));
  }

  /** Cells of `candidate` that are already taken by someone other than `ignoreId`. */
  conflicts(cells: readonly Hex[], ignoreId?: string): Hex[] {
    const out: Hex[] = [];
    for (const c of cells) {
      const occ = this.map.get(hexKey(c));
      if (occ !== undefined && occ !== ignoreId) out.push(c);
    }
    return out;
  }

  get size(): number {
    return this.map.size;
  }
}

/** Convenience: does `a` share any cell with `b`? */
export function footprintsOverlap(a: readonly Hex[], b: readonly Hex[]): boolean {
  const seen = new Set(a.map(hexKey));
  return b.some((c) => seen.has(hexKey(c)));
}
