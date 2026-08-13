/**
 * Which lattice cells does this mesh occupy? — the browser-side detector.
 *
 * This is the same three-tier answer `tools/footprint.py` gives, reached with a
 * raster instead of trimesh + shapely, because a browser has neither:
 *
 *   1. PANEL      — many hexagonal holes on the 23.6 mm lattice. The holes are
 *                   found as enclosed empty regions in the projection and the
 *                   lattice is checked against them, not fitted to them.
 *   2. WALL-CLIP  — the bounding box decomposes exactly onto the lattice, which
 *                   is the sharp test for "this mates with the wall". Which
 *                   cells inside that block are filled then comes from the
 *                   silhouette of the band nearest the mating face.
 *   3. INSERT-FED — no wall interface on any axis. These bolt or plug into an
 *                   insert, and geometry cannot say which cells their installer
 *                   will choose. They get a BOUND from the bounding box and are
 *                   flagged for review, never asserted.
 *
 * The honesty rule from PARKED.md P1 carries over unchanged: tier 3 is a bound,
 * it says so, and the import dialog then lets a human draw the real footprint —
 * which is what turns an unanswerable measurement into a two-click authoring
 * job.
 *
 * Pure functions over a MeshData. No DOM, no three.js.
 */

import { PITCH, ROW_STEP } from './constants';
import { panelCells } from './hex';
import type { MeshData } from './stl';
import type { Hex, PartType } from './types';

/** One cell's flange envelope: 22.5 mm across flats, 25.9808 across corners. */
export const ENV_FLATS = 22.5;
export const ENV_CORNERS = 25.9808;

/** Across-flats widths that mean "this mates with the wall". */
const WALL_INTERFACE = [22.5, 22.02, 20.735, 20.0, 19.7, 22.0];

/** Metric clearance holes, narrowest section, from HSW-SPEC.md §1. */
const BORES: readonly { tag: 'M3' | 'M4' | 'M5'; diameter: number }[] = [
  { tag: 'M3', diameter: 3.2 },
  { tag: 'M4', diameter: 4.2 },
  { tag: 'M5', diameter: 5.1 },
];

export type Tier = 'panel' | 'wall-clip' | 'insert-fed';
export type Axis = 'x' | 'y' | 'z';

export interface Detection {
  cells: Hex[];
  anchor: Hex;
  drawnOrientation: 'pointy' | 'flat' | 'n/a';
  matingAxis: Axis | 'n/a';
  wallFaceAxis: Axis | 'n/a';
  /**
   * Which END of the wall-face axis goes against the wall.
   *
   * Needed to hang the real mesh the right way round in 3D: the wall face sits
   * on the panel and the body stands proud of it. Getting it wrong does not
   * mirror the part — it buries it in the plate.
   */
  matingEnd: 'low' | 'high';
  /** How far the part stands off the wall, mm. */
  projectionMm: number;
  projectionBasis: 'mating-axis' | 'contact-area' | 'fallback-min-extent';
  tier: Tier;
  /** Geometry's own reading of the type, before any filename evidence. */
  geometryType: PartType;
  method: string;
  confidence: number;
  needsReview: boolean;
  notes: string[];
  interfaceWidths: number[];
  /** Mounting holes found on the wall-face axis, by thread. */
  bores: Partial<Record<'M3' | 'M4' | 'M5', number>>;
  /** Panels only — the block the cells form. */
  panel?: { columns: number; rows: number; widthMm: number; heightMm: number };
}

// ---------------------------------------------------------------------------
// Raster
// ---------------------------------------------------------------------------

/**
 * A binary coverage grid of the mesh projected along one axis.
 *
 * Rasterising is what replaces shapely here. Every question the Python detector
 * asks a polygon — is this cell filled, is that hole hexagonal, how much of the
 * probe is covered — is a question about area, and area is exactly what a
 * raster answers without a boolean-geometry library.
 */
export interface Raster {
  minU: number;
  minV: number;
  cols: number;
  rows: number;
  cellMm: number;
  data: Uint8Array;
}

/**
 * Axis -> (u, v, w) index triple, chosen so each is a CYCLIC permutation.
 *
 * Cyclic matters: a cyclic permutation of the axes is a rotation, an acyclic one
 * is a reflection. Reflecting here would mirror the footprint, which is the same
 * class of bug as the stagger-parity trap in `panelCells` — six of the seven
 * shipped panels are chiral, so a mirrored footprint is silently wrong rather
 * than obviously wrong.
 */
export const AXES: Record<Axis, [number, number, number]> = {
  z: [0, 1, 2],
  x: [1, 2, 0],
  y: [2, 0, 1],
};

export interface Slab {
  lo: number;
  hi: number;
}

/**
 * Project the mesh along `axis` and scan-convert it into a coverage grid.
 *
 * `slab` restricts the triangles to those crossing a band along the projection
 * axis, which is how a flange is measured without the body behind it filling in
 * its holes. A triangle that merely touches the band is included whole: the
 * bands that matter here are 2–3 mm of a prismatic feature, where the error is
 * nil, and clipping every triangle to the slab would cost more than it buys.
 */
export function rasterise(
  mesh: MeshData,
  axis: Axis,
  cellMm: number,
  slab?: Slab,
): Raster {
  const [ui, vi, wi] = AXES[axis];
  const p = mesh.positions;
  const n = mesh.triangleCount;

  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    for (let k = 0; k < 3; k++) {
      const u = p[i + k * 3 + ui]!;
      const v = p[i + k * 3 + vi]!;
      if (u < minU) minU = u;
      if (v < minV) minV = v;
      if (u > maxU) maxU = u;
      if (v > maxV) maxV = v;
    }
  }

  // One cell of margin all round, so the flood fill in `enclosedRegions` always
  // has a ring of empty cells to start from.
  const cols = Math.max(1, Math.ceil((maxU - minU) / cellMm) + 3);
  const rows = Math.max(1, Math.ceil((maxV - minV) / cellMm) + 3);
  const originU = minU - cellMm;
  const originV = minV - cellMm;
  const data = new Uint8Array(cols * rows);

  for (let t = 0; t < n; t++) {
    const i = t * 9;
    if (slab) {
      const w0 = p[i + wi]!, w1 = p[i + 3 + wi]!, w2 = p[i + 6 + wi]!;
      if (Math.max(w0, w1, w2) < slab.lo || Math.min(w0, w1, w2) > slab.hi) continue;
    }
    const ax = (p[i + ui]! - originU) / cellMm;
    const ay = (p[i + vi]! - originV) / cellMm;
    const bx = (p[i + 3 + ui]! - originU) / cellMm;
    const by = (p[i + 3 + vi]! - originV) / cellMm;
    const cx = (p[i + 6 + ui]! - originU) / cellMm;
    const cy = (p[i + 6 + vi]! - originV) / cellMm;
    fillTriangle(data, cols, rows, ax, ay, bx, by, cx, cy);
  }

  return { minU: originU, minV: originV, cols, rows, cellMm, data };
}

/** Half-open scan conversion with an edge function; robust to winding. */
function fillTriangle(
  data: Uint8Array, cols: number, rows: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
): void {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const x1 = Math.min(cols - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const y1 = Math.min(rows - 1, Math.ceil(Math.max(ay, by, cy)));
  if (x1 < x0 || y1 < y0) return;

  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area === 0) {
    // A degenerate (edge-on) triangle still covers a line of cells, and those
    // lines are what close the outline of a part seen exactly side-on.
    line(data, cols, rows, ax, ay, bx, by);
    line(data, cols, rows, bx, by, cx, cy);
    line(data, cols, rows, cx, cy, ax, ay);
    return;
  }
  const sign = area > 0 ? 1 : -1;

  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * sign;
      const w1 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * sign;
      const w2 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * sign;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) data[y * cols + x] = 1;
    }
  }
  // Thin slivers can fall between sample points; their edges must still close.
  line(data, cols, rows, ax, ay, bx, by);
  line(data, cols, rows, bx, by, cx, cy);
  line(data, cols, rows, cx, cy, ax, ay);
}

function line(
  data: Uint8Array, cols: number, rows: number,
  x0: number, y0: number, x1: number, y1: number,
): void {
  const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
  if (steps === 0) return;
  for (let s = 0; s <= steps; s++) {
    const x = Math.floor(x0 + ((x1 - x0) * s) / steps);
    const y = Math.floor(y0 + ((y1 - y0) * s) / steps);
    if (x >= 0 && y >= 0 && x < cols && y < rows) data[y * cols + x] = 1;
  }
}

export interface Region {
  /** Cells in the region. */
  count: number;
  /** Centroid in millimetres. */
  u: number;
  v: number;
  areaMm2: number;
  widthMm: number;
  heightMm: number;
}

/**
 * Empty regions fully enclosed by material — the holes.
 *
 * Flood fill from the border marks everything reachable from outside; whatever
 * empty cells are left are interior. This is the raster spelling of "polygon
 * interiors", and it is what finds a panel's hexagonal bores and an accessory's
 * bolt holes with the same code.
 */
export function enclosedRegions(r: Raster): Region[] {
  const { cols, rows, data, cellMm } = r;
  const outside = new Uint8Array(cols * rows);
  const stack: number[] = [];
  for (let x = 0; x < cols; x++) {
    stack.push(x, x + (rows - 1) * cols);
  }
  for (let y = 0; y < rows; y++) {
    stack.push(y * cols, y * cols + cols - 1);
  }
  while (stack.length > 0) {
    const idx = stack.pop()!;
    if (idx < 0 || idx >= data.length) continue;
    if (outside[idx] === 1 || data[idx] === 1) continue;
    outside[idx] = 1;
    const x = idx % cols;
    if (x > 0) stack.push(idx - 1);
    if (x < cols - 1) stack.push(idx + 1);
    stack.push(idx - cols, idx + cols);
  }

  const seen = new Uint8Array(cols * rows);
  const out: Region[] = [];
  for (let start = 0; start < data.length; start++) {
    if (data[start] === 1 || outside[start] === 1 || seen[start] === 1) continue;
    let count = 0, sumX = 0, sumY = 0;
    let minX = cols, maxX = -1, minY = rows, maxY = -1;
    const queue = [start];
    seen[start] = 1;
    while (queue.length > 0) {
      const idx = queue.pop()!;
      const x = idx % cols;
      const y = (idx - x) / cols;
      count++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbours = [idx - 1, idx + 1, idx - cols, idx + cols];
      for (const nb of neighbours) {
        if (nb < 0 || nb >= data.length) continue;
        if (nb === idx - 1 && x === 0) continue;
        if (nb === idx + 1 && x === cols - 1) continue;
        if (data[nb] === 1 || outside[nb] === 1 || seen[nb] === 1) continue;
        seen[nb] = 1;
        queue.push(nb);
      }
    }
    out.push({
      count,
      u: r.minU + ((sumX / count) + 0.5) * cellMm,
      v: r.minV + ((sumY / count) + 0.5) * cellMm,
      areaMm2: count * cellMm * cellMm,
      widthMm: (maxX - minX + 1) * cellMm,
      heightMm: (maxY - minY + 1) * cellMm,
    });
  }
  return out;
}

/** The raster with its enclosed holes filled in — the true silhouette. */
export function filledSilhouette(r: Raster): Raster {
  const { cols, rows, data } = r;
  const outside = new Uint8Array(cols * rows);
  const stack: number[] = [];
  for (let x = 0; x < cols; x++) stack.push(x, x + (rows - 1) * cols);
  for (let y = 0; y < rows; y++) stack.push(y * cols, y * cols + cols - 1);
  while (stack.length > 0) {
    const idx = stack.pop()!;
    if (idx < 0 || idx >= data.length) continue;
    if (outside[idx] === 1 || data[idx] === 1) continue;
    outside[idx] = 1;
    const x = idx % cols;
    if (x > 0) stack.push(idx - 1);
    if (x < cols - 1) stack.push(idx + 1);
    stack.push(idx - cols, idx + cols);
  }
  const filled = new Uint8Array(cols * rows);
  for (let i = 0; i < filled.length; i++) filled[i] = outside[i] === 1 ? 0 : 1;
  return { ...r, data: filled };
}

// ---------------------------------------------------------------------------
// Hexagon probes
// ---------------------------------------------------------------------------

/** Is (du, dv) inside a hexagon of the given width, drawn at `phaseDeg`? */
function insideHex(du: number, dv: number, acrossFlats: number, phaseDeg: number): boolean {
  const half = acrossFlats / 2;
  for (let k = 0; k < 3; k++) {
    const a = ((phaseDeg - 30 + 60 * k) * Math.PI) / 180;
    if (Math.abs(du * Math.cos(a) + dv * Math.sin(a)) > half) return false;
  }
  return true;
}

const phaseOf = (drawn: 'pointy' | 'flat'): number => (drawn === 'flat' ? 0 : 30);

/**
 * How HEXAGONAL is the silhouette here — not merely how covered.
 *
 * `hexCoverage` cannot tell a flange from a block: a rectangle contains the
 * hexagon inscribed in it, so it scores ~1.0 on both. That is why every
 * clip-in part came out with its mating face at the wrong end and was mounted
 * back-to-front — the 20-slot SD holder is a 26 × 22.5 prism for its whole
 * length, both ends scored the same, and the tie went to whichever was tested
 * first.
 *
 * The discriminator is the material OUTSIDE the hexagon but inside its bounding
 * box: the six corners. A real hexagonal flange leaves them empty; a
 * rectangular block fills them.
 */
function hexagonality(
  r: Raster, cu: number, cv: number, acrossFlats: number, drawn: 'pointy' | 'flat',
): number {
  const phase = phaseOf(drawn);
  const reach = acrossFlats / Math.sqrt(3);
  const x0 = Math.max(0, Math.floor((cu - reach - r.minU) / r.cellMm));
  const x1 = Math.min(r.cols - 1, Math.ceil((cu + reach - r.minU) / r.cellMm));
  const y0 = Math.max(0, Math.floor((cv - reach - r.minV) / r.cellMm));
  const y1 = Math.min(r.rows - 1, Math.ceil((cv + reach - r.minV) / r.cellMm));

  let outsideCells = 0;
  let outsideFilled = 0;
  for (let y = y0; y <= y1; y++) {
    const v = r.minV + (y + 0.5) * r.cellMm;
    for (let x = x0; x <= x1; x++) {
      const u = r.minU + (x + 0.5) * r.cellMm;
      const du = u - cu;
      const dv = v - cv;
      // Inside the hexagon's bounding box but outside the hexagon itself.
      if (Math.abs(du) > acrossFlats / 2 + 0.01 || Math.abs(dv) > reach + 0.01) continue;
      if (insideHex(du, dv, acrossFlats, phase)) continue;
      outsideCells++;
      if (r.data[y * r.cols + x] === 1) outsideFilled++;
    }
  }
  if (outsideCells === 0) return 1;
  return 1 - outsideFilled / outsideCells;
}

/** Fraction of a hexagonal probe that the raster covers. */
function hexCoverage(
  r: Raster, cu: number, cv: number, acrossFlats: number, drawn: 'pointy' | 'flat',
): number {
  const phase = phaseOf(drawn);
  const reach = acrossFlats / Math.sqrt(3);
  const x0 = Math.max(0, Math.floor((cu - reach - r.minU) / r.cellMm));
  const x1 = Math.min(r.cols - 1, Math.ceil((cu + reach - r.minU) / r.cellMm));
  const y0 = Math.max(0, Math.floor((cv - reach - r.minV) / r.cellMm));
  const y1 = Math.min(r.rows - 1, Math.ceil((cv + reach - r.minV) / r.cellMm));
  let inside = 0;
  let covered = 0;
  for (let y = y0; y <= y1; y++) {
    const v = r.minV + (y + 0.5) * r.cellMm;
    for (let x = x0; x <= x1; x++) {
      const u = r.minU + (x + 0.5) * r.cellMm;
      if (!insideHex(u - cu, v - cv, acrossFlats, phase)) continue;
      inside++;
      if (r.data[y * r.cols + x] === 1) covered++;
    }
  }
  return inside === 0 ? 0 : covered / inside;
}

// ---------------------------------------------------------------------------
// The bounding-box gate
// ---------------------------------------------------------------------------

/**
 * Does this in-plane bounding box decompose exactly onto the cell lattice?
 *
 * Ported unchanged from `tools/footprint.py:envelope_block`, including why it is
 * the gate: every extra cell adds a whole lattice step along one axis and a HALF
 * pitch along the other, so a genuine wall part measures
 *
 *     flat-drawn:   25.9808 + a·20.438  by  22.5 + b·11.8
 *     pointy-drawn: 22.5    + a·11.8    by  25.9808 + b·20.438
 *
 * for non-negative integers a, b. Real parts hit this within 0.03 mm; a box or a
 * shelf misses it by millimetres. Area-overlap scoring cannot tell them apart,
 * because a plain rectangle is ~70% coverable by hexagons.
 */
export function envelopeBlock(
  sizeU: number, sizeV: number,
): { drawn: 'pointy' | 'flat'; a: number; b: number } | null {
  const options = [
    { drawn: 'flat' as const, eu: ENV_CORNERS, ev: ENV_FLATS, stepU: ROW_STEP, stepV: PITCH / 2 },
    { drawn: 'pointy' as const, eu: ENV_FLATS, ev: ENV_CORNERS, stepU: PITCH / 2, stepV: ROW_STEP },
  ];
  for (const o of options) {
    const a = (sizeU - o.eu) / o.stepU;
    const b = (sizeV - o.ev) / o.stepV;
    if (a < -0.03 || b < -0.03) continue;
    const ra = Math.round(a);
    const rb = Math.round(b);
    if (Math.abs(a - ra) < 0.03 && Math.abs(b - rb) < 0.03) {
      return { drawn: o.drawn, a: ra, b: rb };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lattice points <-> axial cells
// ---------------------------------------------------------------------------

/**
 * Basis vectors of the lattice in the plane, for a given drawn orientation.
 *
 * The FLAT basis is now the wall's own (D35) — `hexToMm` is exactly
 * `[[ROW_STEP, PITCH/2], [0, PITCH]]`. That is the whole content of the frame
 * turn as far as this module is concerned.
 */
function basis(drawn: 'pointy' | 'flat'): [[number, number], [number, number]] {
  return drawn === 'flat'
    ? [[ROW_STEP, PITCH / 2], [0, PITCH]]
    : [[PITCH, 0], [PITCH / 2, ROW_STEP]];
}

/**
 * Millimetre cell centres -> axial cells, normalised so the lowest cell is the
 * origin. Returns null if the points are not on one lattice, which is the
 * detector's way of refusing rather than guessing.
 */
export function toAxial(
  points: readonly { u: number; v: number }[],
  drawn: 'pointy' | 'flat',
): Hex[] | null {
  if (points.length === 0) return null;
  // A POINTY-drawn part must be spun 90° to sit on a flat-top wall. Physical
  // requirement, not bookkeeping: the wall is flat-top by definition (D35).
  // It was the flat-drawn part that needed spinning while the wall was pointy —
  // the rule did not change, the wall did.
  const pts = points.map((p) => (drawn === 'pointy' ? { u: -p.v, v: p.u } : { u: p.u, v: p.v }));
  const first = pts[0]!;
  const cells: Hex[] = [];
  for (const p of pts) {
    const du = p.u - first.u;
    const dv = p.v - first.v;
    // The inverse of `hexToMm`, flat-top: columns step ROW_STEP across, cells
    // step PITCH down a column, each column half a PITCH off its neighbour.
    const qf = du / ROW_STEP;
    const rf = dv / PITCH - qf / 2;
    const q = Math.round(qf);
    const r = Math.round(rf);
    if (Math.abs(qf - q) > 0.2 || Math.abs(rf - r) > 0.2) return null;
    cells.push({ q, r });
  }
  const unique = new Map<string, Hex>();
  for (const c of cells) unique.set(`${c.q},${c.r}`, c);
  // Normalised COLUMN-major, matching the frame: the (q, r)-least cell becomes
  // the origin. The old rule sorted (r, q) for a row-major wall. Whichever rule
  // is used, `tools/turn_frame.py` must use the same one or the detector and the
  // catalogue disagree about a translation — which `tests/detect.test.ts`
  // compares exactly, not up to a shift.
  const list = [...unique.values()].sort((x, y) => x.q - y.q || x.r - y.r);
  const base = list[0]!;
  return list.map((c) => ({ q: c.q - base.q, r: c.r - base.r }));
}

// ---------------------------------------------------------------------------
// Tier 1 — panel
// ---------------------------------------------------------------------------

function detectPanel(mesh: MeshData, axis: Axis, cellMm: number): Detection | null {
  const raster = rasterise(mesh, axis, cellMm);
  const holes = enclosedRegions(raster);

  // A cell's hole is 20.0–22.0 mm across flats: 346–419 mm². Accept a generous
  // band around that and reject on shape, not just size.
  const hexes = holes.filter((h) => {
    if (h.areaMm2 < 250 || h.areaMm2 > 560) return false;
    const span = Math.max(h.widthMm, h.heightMm);
    const thin = Math.min(h.widthMm, h.heightMm);
    return span > 18 && span < 28 && thin / span > 0.8;
  });
  if (hexes.length < 3) return null;

  for (const drawn of ['pointy', 'flat'] as const) {
    const cells = toAxial(hexes.map((h) => ({ u: h.u, v: h.v })), drawn);
    if (cells === null || cells.length !== hexes.length) continue;

    const block = blockOf(cells);
    const notes = [
      `${hexes.length} hexagonal bores on the ${drawn}-drawn lattice, mean hole ` +
        `${(hexes.reduce((s, h) => s + h.areaMm2, 0) / hexes.length).toFixed(1)} mm²`,
    ];
    if (block === null) {
      notes.push(
        'FLAGGED: the bores do not form a rectangular block, so columns × rows ' +
          'cannot describe this panel. The cell map is still exact.',
      );
    } else if (block.hang180) {
      notes.push(
        'This panel is drawn with the opposite stagger parity, so it must be ' +
          'hung 180° round to line up with its neighbours. Its cell map is the ' +
          'same set either way.',
      );
    }
    const [su, sv, sw] = spanOf(mesh, axis);
    return {
      cells,
      anchor: { q: 0, r: 0 },
      drawnOrientation: drawn,
      matingAxis: axis,
      wallFaceAxis: axis,
      // A panel is symmetric enough about its plate for either face to be "the"
      // wall face as far as drawing goes; which face the builder turns towards
      // the room is not something geometry can say (DECISIONS.md D7).
      matingEnd: 'low',
      projectionMm: sw,
      projectionBasis: 'mating-axis',
      tier: 'panel',
      geometryType: 'panel',
      method: 'hole-lattice',
      confidence: block === null ? 0.7 : 0.97,
      needsReview: block === null,
      notes,
      interfaceWidths: [],
      bores: {},
      ...(block === null
        ? {}
        : { panel: { columns: block.columns, rows: block.rows, widthMm: su, heightMm: sv } }),
    };
  }
  return null;
}

/**
 * Do these cells form the staggered rectangle `panelCells` generates?
 *
 * The tiler places panels by columns × rows, so a panel whose cells are not that
 * shape cannot be tiled — better to say so than to ship a cell count that does
 * not match the part.
 *
 * The comparison runs against `panelCells` itself rather than re-deriving the
 * stagger here, because re-deriving it is exactly how the app and the meshes
 * came to disagree once already (see the note on `panelCells`, and
 * tests/panel-parity.test.ts).
 *
 * A match FLIPPED 180° counts. Hanging a plate the other way up is free, and a
 * 180° turn is three 60° steps — a symmetry of the lattice. One of the seven
 * shipped panels is drawn with the opposite stagger parity and only matches
 * flipped; that is a fitting instruction, not a defect, so it is returned as
 * one.
 */
function blockOf(
  cells: readonly Hex[],
): { columns: number; rows: number; hang180: boolean } | null {
  // Grouped by COLUMN since the wall turned flat-top (D35): `panelCells` builds
  // along q, so it is q that indexes the block's long axis.
  const byColumn = new Map<number, number[]>();
  for (const c of cells) {
    const list = byColumn.get(c.q);
    if (list) list.push(c.r);
    else byColumn.set(c.q, [c.r]);
  }
  const columns = byColumn.size;
  if (columns === 0 || cells.length % columns !== 0) return null;
  const rows = cells.length / columns;

  const want = normalise(cells);
  const flipped = normalise(cells.map((c) => ({ q: -c.q, r: -c.r })));
  const generated = normalise(panelCells({ q: 0, r: 0 }, columns, rows));
  if (generated === want) return { columns, rows, hang180: false };
  if (generated === flipped) return { columns, rows, hang180: true };
  return null;
}

/**
 * Cell set as a stable string, translated so its lowest cell is the origin.
 * Column-major, matching `toAxial` and `tools/turn_frame.py` — all three have to
 * agree on which cell is "lowest" or they disagree by a translation.
 */
function normalise(cells: readonly Hex[]): string {
  const sorted = [...cells].sort((a, b) => a.q - b.q || a.r - b.r);
  const first = sorted[0];
  if (!first) return '';
  return sorted
    .map((c) => `${c.q - first.q},${c.r - first.r}`)
    .sort()
    .join(' ');
}

// ---------------------------------------------------------------------------
// Tier 2 — wall clip
// ---------------------------------------------------------------------------

/** Extents of the mesh along (u, v, w) for a projection axis. */
function spanOf(mesh: MeshData, axis: Axis): [number, number, number] {
  const [ui, vi, wi] = AXES[axis];
  const p = mesh.positions;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.triangleCount * 9; i += 3) {
    const vals = [p[i + ui]!, p[i + vi]!, p[i + wi]!];
    for (let k = 0; k < 3; k++) {
      if (vals[k]! < lo[k]!) lo[k] = vals[k]!;
      if (vals[k]! > hi[k]!) hi[k] = vals[k]!;
    }
  }
  return [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!];
}

function boundsAlong(mesh: MeshData, axis: Axis): { lo: number; hi: number } {
  const wi = AXES[axis][2];
  const p = mesh.positions;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < mesh.triangleCount * 9; i += 3) {
    const w = p[i + wi]!;
    if (w < lo) lo = w;
    if (w > hi) hi = w;
  }
  return { lo, hi };
}

const PHASE_STEPS = 8;

/**
 * Cells covered by a silhouette, with the lattice phase solved for rather than
 * guessed.
 *
 * Every shortcut for guessing the phase is wrong on some real part, and all of
 * them fail the same silent way — every probe lands on a cell wall and the part
 * reports zero cells instead of an error. Sweeping one fundamental domain costs
 * 64 candidate origins and removes the whole family.
 */
function cellsInSilhouette(
  sil: Raster, drawn: 'pointy' | 'flat',
): { u: number; v: number }[] {
  const [e1, e2] = basis(drawn);
  const spanU = sil.cols * sil.cellMm;
  const spanV = sil.rows * sil.cellMm;
  const n = Math.ceil(Math.max(spanU, spanV) / Math.min(PITCH, ROW_STEP)) + 3;

  let best: { u: number; v: number }[] = [];
  let bestKey = [-1, -1];

  for (let ia = 0; ia < PHASE_STEPS; ia++) {
    for (let ib = 0; ib < PHASE_STEPS; ib++) {
      const fa = ia / PHASE_STEPS;
      const fb = ib / PHASE_STEPS;
      const u0 = sil.minU + fa * e1[0] + fb * e2[0];
      const v0 = sil.minV + fa * e1[1] + fb * e2[1];
      const found: { u: number; v: number }[] = [];
      for (let i = -n; i <= n; i++) {
        for (let j = -n; j <= n; j++) {
          const u = u0 + i * e1[0] + j * e2[0];
          const v = v0 + i * e1[1] + j * e2[1];
          if (u < sil.minU - 0.5 || u > sil.minU + spanU + 0.5) continue;
          if (v < sil.minV - 0.5 || v > sil.minV + spanV + 0.5) continue;
          // Require most of an inner probe to be covered, so a cell merely
          // clipped by a connecting web does not count as occupied.
          if (hexCoverage(sil, u, v, ENV_FLATS * 0.62, drawn) >= 0.8) found.push({ u, v });
        }
      }
      if (found.length === 0) continue;
      let fill = 0;
      for (const c of found) fill += hexCoverage(sil, c.u, c.v, ENV_FLATS, drawn);
      fill /= found.length;
      const key = [found.length, Math.round(fill * 1000)];
      if (key[0]! > bestKey[0]! || (key[0] === bestKey[0] && key[1]! > bestKey[1]!)) {
        bestKey = key;
        best = found;
      }
    }
  }
  return best;
}

function detectWallClip(mesh: MeshData, axis: Axis, cellMm: number): Detection | null {
  const [su, sv, sw] = spanOf(mesh, axis);
  const gate = envelopeBlock(su, sv);
  if (gate === null) return null;

  const { lo, hi } = boundsAlong(mesh, axis);
  // The mating face is at one end or the other. Try both bands — the flange is
  // 2.5 mm thick, and a band deeper than that starts to include the body.
  const bands: { slab: Slab; where: 'low' | 'high' }[] = [
    { slab: { lo, hi: lo + Math.min(2.5, sw * 0.4) }, where: 'low' },
    { slab: { lo: hi - Math.min(2.5, sw * 0.4), hi }, where: 'high' },
  ];

  let best: {
    cells: Hex[];
    coverage: number;
    hexness: number;
    where: 'low' | 'high';
    points: { u: number; v: number }[];
  } | null = null;

  for (const band of bands) {
    const sil = filledSilhouette(rasterise(mesh, axis, cellMm, band.slab));
    const points = cellsInSilhouette(sil, gate.drawn);
    if (points.length === 0) continue;
    let coverage = 0;
    let hexness = 0;
    for (const p of points) {
      coverage += hexCoverage(sil, p.u, p.v, ENV_FLATS, gate.drawn);
      hexness += hexagonality(sil, p.u, p.v, ENV_FLATS, gate.drawn);
    }
    coverage /= points.length;
    hexness /= points.length;
    if (coverage < 0.7) continue;
    const cells = toAxial(points, gate.drawn);
    if (cells === null) continue;
    /**
     * More cells wins first — that is which cells the part occupies. Between
     * two ends claiming the same cells, the flange is the one that both FILLS
     * a cell hexagon and IS one.
     *
     * Both halves are needed. Coverage alone cannot tell a flange from the
     * rectangular end of a card block, because a rectangle contains the
     * hexagon inscribed in it. Hexagonality alone prefers whichever end is
     * SMALLER — a narrow tip has nothing outside the hexagon either, which is
     * how an insert came out mounted tip-first. The product is high only for a
     * silhouette that is full-size and hexagonal, which is what a flange is.
     */
    const score = coverage * hexness;
    const bestScore = best === null ? -1 : best.coverage * best.hexness;
    if (
      best === null ||
      cells.length > best.cells.length ||
      (cells.length === best.cells.length && score > bestScore)
    ) {
      best = { cells, coverage, hexness, where: band.where, points };
    }
  }
  if (best === null) return null;

  const notes = [
    `bbox decomposes exactly onto the lattice (${gate.drawn}-drawn, ` +
      `${gate.a}+1 × ${gate.b}+1 half-steps); mating face on the ${best.where} ` +
      `${axis} end; ${best.cells.length} cell(s) filled, hexagons ` +
      `${(best.coverage * 100).toFixed(1)}% solid, silhouette ` +
      `${(best.hexness * 100).toFixed(0)}% hexagonal`,
  ];

  return {
    cells: best.cells,
    anchor: { q: 0, r: 0 },
    drawnOrientation: gate.drawn,
    matingAxis: axis,
    wallFaceAxis: axis,
    matingEnd: best.where,
    projectionMm: sw,
    projectionBasis: 'mating-axis',
    tier: 'wall-clip',
    // The threshold is the shipped scanner's: anything standing 12.5 mm or less
    // off the wall is hardware, anything deeper is a thing you hang stuff on.
    geometryType: sw <= 12.5 ? 'insert' : 'accessory',
    method: 'bbox-gate+silhouette',
    confidence: 0.95,
    needsReview: false,
    notes,
    interfaceWidths: WALL_INTERFACE.filter(() => false),
    bores: {},
  };
}

// ---------------------------------------------------------------------------
// Bores
// ---------------------------------------------------------------------------

/**
 * Mounting holes on the wall-face axis, by thread.
 *
 * Sized by the hole's equivalent diameter, matched against the measured metric
 * clearances in HSW-SPEC.md §1. Only holes that pass straight through the
 * projection are seen, which is the honest limit of a projection: a blind
 * counterbore is invisible here and the import dialog is where a human adds it.
 */
export function detectBores(
  mesh: MeshData, axis: Axis, cellMm: number,
): Partial<Record<'M3' | 'M4' | 'M5', number>> {
  const holes = enclosedRegions(rasterise(mesh, axis, Math.min(cellMm, 0.25)));
  const out: Partial<Record<'M3' | 'M4' | 'M5', number>> = {};
  for (const h of holes) {
    const d = 2 * Math.sqrt(h.areaMm2 / Math.PI);
    const round = Math.min(h.widthMm, h.heightMm) / Math.max(h.widthMm, h.heightMm);
    if (round < 0.75) continue;
    for (const b of BORES) {
      if (Math.abs(d - b.diameter) <= 0.45) {
        out[b.tag] = (out[b.tag] ?? 0) + 1;
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Raster resolution: fine enough to size an M3 hole, capped so a 390 mm panel
 *  still rasterises in a few milliseconds. */
function resolutionFor(mesh: MeshData): number {
  const [su, sv] = spanOf(mesh, 'z');
  const span = Math.max(su, sv, 1);
  return Math.min(0.4, Math.max(0.12, span / 640));
}

/**
 * The full three-tier answer for one mesh.
 *
 * Tries every axis as the candidate wall normal, because parts are drawn lying
 * on whichever face suited the print bed.
 */
/**
 * A human's answer to the question the detector is guessing at.
 *
 * `forceAxis` narrows the search to one candidate face instead of picking the
 * best of three; `forceEnd` says which end of it mates. Both are corrections a
 * person made by looking at the model — see `mounting` in `overrides.json`.
 *
 * Deliberately a constraint on the search rather than a value stapled onto the
 * result: the footprint, projection and tier all follow from which face is
 * against the wall, so forcing the face and then re-deriving is what makes
 * "where it sits" agree with "which way it faces". Stapling would leave a part
 * whose cells were measured off one face and whose mesh is hung off another.
 */
export interface DetectOptions {
  forceAxis?: Axis;
  forceEnd?: 'low' | 'high';
}

export function detect(mesh: MeshData, opts: DetectOptions = {}): Detection {
  const cellMm = resolutionFor(mesh);
  const axes: Axis[] = opts.forceAxis ? [opts.forceAxis] : ['z', 'x', 'y'];

  const finish = (d: Detection): Detection => {
    if (opts.forceEnd !== undefined && d.matingEnd !== opts.forceEnd) {
      d.matingEnd = opts.forceEnd;
      d.notes = [...d.notes, `mating end set to ${opts.forceEnd} by hand`];
    }
    if (opts.forceAxis !== undefined) {
      d.notes = [...d.notes, `wall face set to ${opts.forceAxis} by hand`];
    }
    return d;
  };

  for (const axis of axes) {
    const panel = detectPanel(mesh, axis, Math.min(0.5, Math.max(cellMm, 0.3)));
    if (panel !== null) return finish(panel);
  }

  const clips: Detection[] = [];
  for (const axis of axes) {
    const clip = detectWallClip(mesh, axis, cellMm);
    if (clip !== null) clips.push(clip);
  }
  if (clips.length > 0) {
    const best = clips.reduce((a, b) => (b.cells.length > a.cells.length ? b : a));
    best.bores = detectBores(mesh, best.matingAxis as Axis, cellMm);
    return finish(best);
  }

  // Tier 3 picks its own face by material-under-the-surface, which is exactly
  // the guess a human is overruling here, so the forced face has to reach it.
  return finish(insertFed(mesh, cellMm, opts.forceAxis));
}

/**
 * Tier 3. The cell span is a BOUND from the bounding box, not an answer.
 *
 * Deliberately not cleverer than that: an insert-fed part gives no geometric
 * clue which cells its mounting screws land in, because that is the installer's
 * choice. Guessing produces a confident wrong footprint, which is worse than a
 * flagged one — see PARKED.md P1.
 */
function insertFed(mesh: MeshData, cellMm: number, forceAxis?: Axis): Detection {
  const size = spanOf(mesh, 'z');
  const sorted = [...size].sort((a, b) => b - a);
  const longest = sorted[0]!;
  const span =
    longest > ENV_CORNERS
      ? Math.max(1, Math.ceil((longest - ENV_CORNERS) / ROW_STEP) + 1)
      : 1;

  // Which face goes against the wall: the one with the most material just under
  // the surface. A guess, and recorded as one.
  let bestAxis: Axis = 'z';
  let bestArea = -1;
  let bestExtent = sorted[sorted.length - 1]!;
  let bestEnd: 'low' | 'high' = 'low';
  for (const axis of (forceAxis ? [forceAxis] : (['z', 'x', 'y'] as Axis[]))) {
    const { lo, hi } = boundsAlong(mesh, axis);
    const ext = hi - lo;
    if (ext <= 1e-6) continue;
    for (const end of ['low', 'high'] as const) {
      const at = end === 'low' ? lo + ext * 0.03 : hi - ext * 0.03;
      const r = rasterise(mesh, axis, cellMm, { lo: at - ext * 0.02, hi: at + ext * 0.02 });
      let covered = 0;
      for (let i = 0; i < r.data.length; i++) covered += r.data[i]!;
      const area = covered * r.cellMm * r.cellMm;
      if (area > bestArea) {
        bestArea = area;
        bestAxis = axis;
        bestExtent = ext;
        bestEnd = end;
      }
    }
  }

  // Laid along r, down a column. The bound is rotated with everything else by
  // the frame turn (D35) rather than special-cased, so `turn_frame.py` could
  // relabel all 51 parts with one rule and no knowledge of tier.
  //
  // The long-standing wart is preserved, not introduced: `span` is counted in
  // ROW_STEP while the cells are laid at PITCH spacing. It was the same
  // mismatch the other way round before the turn. It is a BOUND (PARKED P1),
  // flagged `needsReview`, and never asserted — tightening it would mean
  // claiming a measurement this function cannot make.
  const cells: Hex[] = [];
  for (let i = 0; i < span; i++) cells.push({ q: 0, r: i });

  return {
    cells,
    anchor: { q: 0, r: 0 },
    drawnOrientation: 'n/a',
    matingAxis: 'n/a',
    wallFaceAxis: bestAxis,
    matingEnd: bestEnd,
    projectionMm: bestExtent,
    projectionBasis: 'contact-area',
    tier: 'insert-fed',
    geometryType: 'accessory',
    method: 'bbox-span',
    confidence: 0.35,
    needsReview: true,
    notes: [
      `no wall interface on any axis; longest bbox edge ${longest.toFixed(2)} mm ` +
        `spans at most ${span} cell(s) at ${ROW_STEP} mm per step`,
      'FLAGGED: the cell footprint is a bound from the bounding box, not a ' +
        'measurement. Draw the real one below before relying on it.',
    ],
    interfaceWidths: [],
    bores: detectBores(mesh, bestAxis, cellMm),
  };
}

// ---------------------------------------------------------------------------
// Mounting points
// ---------------------------------------------------------------------------

/**
 * How many places this part is actually fixed to the wall.
 *
 * This is the measurement that was missing, and its absence was the worst
 * defect in the parts list. `tools/scan.py` had no way to count a part's
 * mounting bosses, so it did two wrong things instead: where it found a bolt
 * bore it ordered one insert, and where it found nothing it either ordered
 * NOTHING AT ALL — ten accessories, including both 200 mm wrench racks, came
 * with no fastener whatsoever — or fell back to `insert-empty × cells`, where
 * `cells` is the bounding-box BOUND that PARKED P1 explicitly says is not a
 * measurement. A 7-cell shelf with two pegs ordered seven inserts.
 *
 * A tier-3 part is fixed by discrete bosses on its wall face: a peg into an
 * insert's 13.4 mm socket (15.47 mm across corners), or a bolt through it. Both
 * are separate lumps of material sitting on lattice positions, which is exactly
 * what a raster can count.
 *
 * Answers with a confidence, and the caller is expected to respect it. A count
 * that is not stable across depth is reported as unknown rather than guessed —
 * the same rule the footprint bound follows.
 */
export interface MountPoints {
  count: number;
  confident: boolean;
  /** Across-corners size of each boss found, mm. */
  spansMm: number[];
  notes: string[];
}

/** A boss for the 13.4 mm socket measures ~15.5 across corners; a 19.7 mm wall
 *  body ~22.7. Outside this band it is the part's body, or a card slot. */
const BOSS_MIN_SPAN = 11;
const BOSS_MAX_SPAN = 26;

export function mountPoints(mesh: MeshData, detection: Detection): MountPoints {
  // A wall-clipping part carries its own interface: it needs no insert at all,
  // and its mounting points ARE its cells.
  if (detection.tier === 'wall-clip' || detection.tier === 'panel') {
    return {
      count: detection.cells.length,
      confident: true,
      spansMm: [],
      notes: ['clips straight into the wall; no separate insert needed'],
    };
  }

  const axis = detection.wallFaceAxis === 'n/a' ? 'z' : detection.wallFaceAxis;
  const { lo, hi } = boundsAlong(mesh, axis);
  const extent = hi - lo;
  if (extent <= 0) return { count: 0, confident: false, spansMm: [], notes: ['no extent'] };

  const cellMm = Math.min(0.3, Math.max(0.15, extent / 200));

  /**
   * Both ends, not just the one `matingEnd` names.
   *
   * For a tier-3 part `matingEnd` comes from the contact-area heuristic, which
   * is a guess by construction — the part carries no wall interface to measure
   * from. Scanning both ends and keeping whichever gives the more stable count
   * costs two rasters and removes that guess from the answer: shelf-4 read 1
   * boss from the guessed end and 3 from the other.
   */
  let tally = new Map<number, { hits: number; spans: number[] }>();
  let bestEndHits = -1;
  const ends: ('low' | 'high')[] =
    detection.matingEnd === 'high' ? ['high', 'low'] : ['low', 'high'];

  for (const end of ends) {
    const local = new Map<number, { hits: number; spans: number[] }>();
    for (let d = 0.3; d < Math.min(10, extent * 0.6); d += 0.4) {
      const at = end === 'low' ? lo + d : hi - d - 0.5;
      const found = materialBlobs(mesh, axis, { lo: at, hi: at + 0.5 }, cellMm).filter(
        (b) => b.span >= BOSS_MIN_SPAN && b.span <= BOSS_MAX_SPAN && b.areaMm2 > 50,
      );
      if (found.length === 0) continue;
      if (!separatedOnLattice(found)) continue;
      const entry = local.get(found.length) ?? { hits: 0, spans: [] };
      entry.hits += 1;
      if (entry.spans.length === 0) entry.spans = found.map((f) => f.span);
      local.set(found.length, entry);
    }
    // Prefer the end that agrees with itself most often, and on a tie the one
    // that found more mounting points — a merged boss reads as fewer, never
    // as more, so the larger count is the one that resolved them.
    let hits = 0;
    let count = 0;
    for (const [n, entry] of local) {
      if (entry.hits > hits || (entry.hits === hits && n > count)) {
        hits = entry.hits;
        count = n;
      }
    }
    const score = hits * 100 + count;
    if (score > bestEndHits) {
      bestEndHits = score;
      tally = local;
    }
  }

  let best = 0;
  let bestHits = 0;
  let spans: number[] = [];
  for (const [count, entry] of tally) {
    if (entry.hits > bestHits || (entry.hits === bestHits && count > best)) {
      best = count;
      bestHits = entry.hits;
      spans = entry.spans;
    }
  }

  // Stability is the whole test. One depth agreeing with itself proves nothing;
  // a boss is a prism several millimetres long and shows the same count at
  // several depths.
  const confident = bestHits >= 2 && best > 0;
  return {
    count: best,
    confident,
    spansMm: spans.map((s) => Math.round(s * 10) / 10),
    notes: confident
      ? [`${best} mounting boss(es) on the ${axis} wall face, stable across ${bestHits} depths, ` +
         `${spans.map((s) => s.toFixed(1)).join('/')} mm across corners`]
      : ['could not count the mounting bosses reliably — the fastener count needs checking'],
  };
}

/** Connected components of MATERIAL in a slab — the inverse of enclosedRegions. */
function materialBlobs(
  mesh: MeshData, axis: Axis, slab: Slab, cellMm: number,
): { areaMm2: number; span: number; u: number; v: number }[] {
  const r = rasterise(mesh, axis, cellMm, slab);
  const { cols, rows, data } = r;
  const seen = new Uint8Array(cols * rows);
  const out: { areaMm2: number; span: number; u: number; v: number }[] = [];
  for (let start = 0; start < data.length; start++) {
    if (data[start] !== 1 || seen[start] === 1) continue;
    let n = 0, su = 0, sv = 0, minX = cols, maxX = -1, minY = rows, maxY = -1;
    const queue = [start];
    seen[start] = 1;
    while (queue.length > 0) {
      const i = queue.pop()!;
      const x = i % cols;
      const y = (i - x) / cols;
      n++; su += x; sv += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const nb of [i - 1, i + 1, i - cols, i + cols]) {
        if (nb < 0 || nb >= data.length || seen[nb] === 1 || data[nb] !== 1) continue;
        if (nb === i - 1 && x === 0) continue;
        if (nb === i + 1 && x === cols - 1) continue;
        seen[nb] = 1;
        queue.push(nb);
      }
    }
    out.push({
      areaMm2: n * cellMm * cellMm,
      span: Math.max(maxX - minX + 1, maxY - minY + 1) * cellMm,
      u: r.minU + (su / n + 0.5) * cellMm,
      v: r.minV + (sv / n + 0.5) * cellMm,
    });
  }
  return out;
}

/**
 * Are these bosses far enough apart, and on lattice steps?
 *
 * Two lumps 3 mm apart are one feature the raster split, not two mounting
 * points. Two lumps a whole pitch apart are two cells, which is what a
 * multi-point part looks like.
 */
function separatedOnLattice(pts: readonly { u: number; v: number }[]): boolean {
  if (pts.length < 2) return true;
  const steps = [PITCH, ROW_STEP, PITCH / 2];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const du = Math.abs(pts[i]!.u - pts[j]!.u);
      const dv = Math.abs(pts[i]!.v - pts[j]!.v);
      if (Math.hypot(du, dv) < 12) return false;
      const fits = (d: number): boolean =>
        d < 1 || steps.some((s) => Math.abs(d / s - Math.round(d / s)) < 0.2);
      if (!fits(du) || !fits(dv)) return false;
    }
  }
  return true;
}
