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

import { PITCH, ROW_STEP, MARGIN_X, MARGIN_Y } from './constants';
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

/** Centre of a cell in wall millimetres. */
export const hexToMm = (h: Hex): Point => ({
  x: PITCH * (h.q + h.r / 2),
  y: ROW_STEP * h.r,
});

/**
 * Nearest cell to a point in wall millimetres.
 *
 * Rounds in cube space so the result is always the true nearest cell — naive
 * rounding of fractional axial coordinates picks the wrong hexagon near the
 * corners, which shows up as a drop landing one cell off.
 */
export function mmToHex(p: Point): Hex {
  const r = p.y / ROW_STEP;
  const q = p.x / PITCH - r / 2;
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

/** The six corners of a cell, in wall millimetres, starting at the top corner. */
export function hexCorners(h: Hex, acrossFlats: number = PITCH): Point[] {
  const c = hexToMm(h);
  const R = acrossFlats / Math.sqrt(3);
  const pts: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 90);
    pts.push({ x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

/**
 * The cells of a rectangular panel: `columns` × `rows`, staggered, with the
 * lowest row starting at `origin`.
 *
 * The stagger is the whole point — row r is offset half a pitch from row r-1,
 * and in axial coordinates that offset is already baked into the basis, so a
 * "rectangle" on the wall is a sheared range in (q, r).
 */
export function panelCells(origin: Hex, columns: number, rows: number): Hex[] {
  // `c < columns` never terminates for +Infinity, so a corrupted document could
  // hang the tab rather than render badly. Clamp to whole, finite, sane counts.
  const cols = Number.isFinite(columns) ? Math.floor(columns) : 0;
  const rowCount = Number.isFinite(rows) ? Math.floor(rows) : 0;
  if (cols <= 0 || rowCount <= 0) return [];

  const out: Hex[] = [];
  for (let r = 0; r < rowCount; r++) {
    // Undo half the axial shear so the block stays visually rectangular.
    const qShift = -Math.floor(r / 2);
    for (let c = 0; c < cols; c++) {
      out.push({ q: origin.q + c + qShift, r: origin.r + r });
    }
  }
  return out;
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
