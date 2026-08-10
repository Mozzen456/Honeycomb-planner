/**
 * Wall tiling — decide which printed panels cover a wall rectangle, and where.
 *
 * Pure functions only: no DOM, no clock, no randomness, no I/O. The same request
 * always produces a deeply-equal result, because the whole solver is integer
 * arithmetic over the lattice plus a fixed, total ordering of the candidates.
 *
 * ---------------------------------------------------------------------------
 * The two frames, and which one owns which number
 * ---------------------------------------------------------------------------
 *
 * A panel carries two independent sizes and confusing them is the classic bug:
 *
 *   - `columns` / `rows` are the panel's footprint on the WALL lattice. They are
 *     handed straight to `panelCells()` and they are the only thing that decides
 *     where the panel sits. The lattice is continuous across the whole wall, so a
 *     panel's wall extent is a property of the lattice, never of its bounding box.
 *
 *   - `widthMm` / `heightMm` are the panel's printed BED footprint, as measured
 *     (build/panel_sizes.json — see D5: measured verbatim, never re-derived). They
 *     are used for exactly one thing: does this thing fit on the printer.
 *
 * Some shipped STLs are drawn flat-top and need a 90° spin to suit the wall
 * (see `CatalogPart.drawnOrientation`). That spin swaps BOTH pairs: the lattice
 * footprint becomes rows × columns and the bed footprint becomes height × width.
 * `allowRotation` (default true) is what permits the solver to consider that
 * rotated form as a separate candidate.
 *
 * ---------------------------------------------------------------------------
 * Why panels butt at exactly `rows` rows and `columns` columns
 * ---------------------------------------------------------------------------
 *
 * Panel outlines are interlocking zig-zags, not rectangles (D6). Stacking two
 * panels one row-step apart looks like a 6.8 mm bounding-box overlap, but it is
 * not: the top edge of a row dips to MARGIN_Y/2 = 6.813 between cell corners, and
 * the row above puts its bottom corners at ROW_STEP − MARGIN_Y = 6.812. They mesh.
 * So the next band starts at absolute lattice row `r0 + rows`, full stop, and the
 * next panel along a band starts at column `col + columns`. Disjointness is then
 * structural rather than something we have to test for at runtime — but the tests
 * assert it anyway, because it is the property everything else depends on.
 *
 * One consequence worth stating: a band whose first absolute row is odd cannot
 * have its left edge at the same x as an even band. `panelCells` shifts by
 * −floor(r/2), so the band's left edge sits at PITCH·(q0 + r0/2) − MARGIN_X and
 * that is only a whole number of pitches when r0 is even. Odd bands are therefore
 * inset by exactly half a pitch (11.8 mm). That is the honeycomb stagger, not an
 * error, and `maxColumnsInBand` accounts for it so a band never overruns the wall.
 */

import { PITCH, ROW_STEP, MARGIN_X, MARGIN_Y, BEDS } from './constants';
import type { Bed } from './constants';
import type { Hex } from './types';
import { cellsBoundsMm, hexKey, hexNeighbours, panelCells } from './hex';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface PanelSize {
  partId: string;
  /** Lattice footprint on the wall. */
  columns: number;
  rows: number;
  /** Printed bed footprint, as measured. Used only for bed fitting. */
  widthMm: number;
  heightMm: number;
}

export interface TilingRequest {
  wall: { widthMm: number; heightMm: number };
  /** Id from BEDS in constants.ts. */
  bedId: string;
  available: PanelSize[];
  /** Default true: a panel may be used 90° rotated, which swaps both footprints. */
  allowRotation?: boolean;
}

export interface TiledPanel {
  partId: string;
  /** Lattice position of the panel's lowest-left cell. */
  origin: Hex;
  columns: number;
  rows: number;
}

/** Cells that touch a panel boundary, from both sides of it. */
export interface Seam {
  a: string;
  b: string;
  cells: Hex[];
}

export interface TilingResult {
  panels: TiledPanel[];
  /** Fraction of the wall rectangle covered, 0..1. See `coverageOf`. */
  coverage: number;
  cellCount: number;
  seams: Seam[];
  unusedMm: { right: number; top: number };
  warnings: string[];
}

/**
 * Stable identifier for a placed panel, used as `Seam.a` / `Seam.b`.
 *
 * Placed panels have no id of their own and occupy disjoint cells, so
 * part + origin is unique by construction and — unlike an array index — survives
 * the panel list being re-ordered or filtered by the caller.
 */
export const panelKey = (p: { partId: string; origin: Hex }): string =>
  `${p.partId}@${p.origin.q},${p.origin.r}`;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Slack for the millimetre comparisons that decide how many cells fit.
 * Every such comparison is `floor(x + EPS)`: without it a wall stated as exactly
 * n whole pitches can lose its last column to a 1-ulp rounding of a float divide.
 * It is not a tolerance on the geometry — 1e-9 mm is a picometre.
 */
const EPS = 1e-9;

/**
 * Area of one lattice fundamental domain. The honeycomb is a lattice with basis
 * (PITCH, 0) and (STAGGER, ROW_STEP), so each cell owns exactly PITCH · ROW_STEP
 * of wall regardless of how the hexagons are drawn. This is the honest unit for
 * "how much of the wall did we cover": summing panel bounding boxes would
 * double-count the interlock, and summing hexagon areas would ignore the webbing
 * between cells that is just as much panel.
 */
const CELL_AREA_MM2 = PITCH * ROW_STEP;

interface Variant {
  partId: string;
  columns: number;
  rows: number;
  cells: number;
  /** True if this is the 90°-rotated form of the supplied size. */
  rotated: boolean;
}

const isPositiveFinite = (n: number): boolean => Number.isFinite(n) && n > 0;

const isUsableSize = (p: PanelSize): boolean =>
  typeof p.partId === 'string' &&
  Number.isInteger(p.columns) &&
  Number.isInteger(p.rows) &&
  p.columns >= 1 &&
  p.rows >= 1 &&
  isPositiveFinite(p.widthMm) &&
  isPositiveFinite(p.heightMm);

const fitsBed = (widthMm: number, depthMm: number, bed: Bed): boolean =>
  widthMm <= bed.width + EPS && depthMm <= bed.depth + EPS;

/**
 * Preference order. Largest first, so the greedy fill reaches for the biggest
 * panel it can use — fewer panels means fewer seams and fewer joiners. Every
 * later key exists purely to make the order total, and therefore the result
 * reproducible whatever order the caller listed `available` in.
 */
function compareVariants(a: Variant, b: Variant): number {
  if (a.cells !== b.cells) return b.cells - a.cells;
  if (a.columns !== b.columns) return b.columns - a.columns;
  if (a.rows !== b.rows) return b.rows - a.rows;
  if (a.partId !== b.partId) return a.partId < b.partId ? -1 : 1;
  return (a.rotated ? 1 : 0) - (b.rotated ? 1 : 0);
}

/**
 * Highest absolute lattice row whose cells still sit inside the wall.
 * Cell (q, r) has its centre at y = ROW_STEP·r + MARGIN_Y in wall millimetres
 * (the lattice is anchored so the bottom-left panel's outline starts at y = 0),
 * so its top corner is at ROW_STEP·r + 2·MARGIN_Y. Negative means "no rows".
 */
function maxRowIndex(wallHeightMm: number): number {
  return Math.floor((wallHeightMm - 2 * MARGIN_Y) / ROW_STEP + EPS);
}

/** Half-pitch inset of a band that begins at absolute row `r0`: 0 or 0.5 pitches. */
const bandShift = (r0: number): number => r0 / 2 - Math.floor(r0 / 2);

/**
 * How many columns wide a band may be before it overruns the wall.
 *
 * Within a band, row `i` sits half a pitch right of row `i − 1`, so the rightmost
 * material belongs to an odd row — which only exists once the band is at least two
 * rows tall. A one-row band is therefore half a pitch narrower for the same column
 * count, and gets its own case rather than being rounded away.
 */
function maxColumnsInBand(wallWidthMm: number, r0: number, bandRows: number): number {
  const shift = bandShift(r0) + (bandRows >= 2 ? 0.5 : 0);
  // PITCH·(shift + columns − 1) + 2·MARGIN_X <= wallWidthMm
  const columns = (wallWidthMm - 2 * MARGIN_X) / PITCH - shift + 1;
  return Math.max(0, Math.floor(columns + EPS));
}

/**
 * Lay one band of uniform height across the wall, left to right, always taking the
 * widest candidate that still fits the space left. Falling back down the list is
 * what stops us leaving a gap a smaller panel could have filled.
 */
function fillBand(
  r0: number,
  bandRows: number,
  byRows: ReadonlyMap<number, readonly Variant[]>,
  wallWidthMm: number,
): TiledPanel[] {
  const usable = byRows.get(bandRows);
  if (usable === undefined) return [];

  const qOrigin = -Math.floor(r0 / 2);
  const maxColumns = maxColumnsInBand(wallWidthMm, r0, bandRows);

  const out: TiledPanel[] = [];
  let col = 0;
  for (;;) {
    const room = maxColumns - col;
    const pick = usable.find((v) => v.columns <= room);
    if (pick === undefined) break;
    out.push({
      partId: pick.partId,
      origin: { q: qOrigin + col, r: r0 },
      columns: pick.columns,
      rows: pick.rows,
    });
    col += pick.columns;
  }
  return out;
}

interface BandPlan {
  rows: number;
  cells: number;
  panels: TiledPanel[];
}

/**
 * Band plans are compared on cells covered first, then on panel count — given two
 * plans that cover the same wall, the one made of fewer, larger pieces is the one
 * with fewer seams. `rows` breaks the last tie and is unique per plan, so the order
 * is total.
 */
function isBetterBand(candidate: BandPlan, incumbent: BandPlan | null): boolean {
  if (incumbent === null) return true;
  if (candidate.cells !== incumbent.cells) return candidate.cells > incumbent.cells;
  if (candidate.panels.length !== incumbent.panels.length) {
    return candidate.panels.length < incumbent.panels.length;
  }
  return candidate.rows > incumbent.rows;
}

/** Is cell `c` inside `p`? The arithmetic inverse of `panelCells`, allocation-free. */
function panelContains(p: TiledPanel, c: Hex): boolean {
  const dr = c.r - p.origin.r;
  if (dr < 0 || dr >= p.rows) return false;
  const dc = c.q - p.origin.q + Math.floor(dr / 2);
  return dc >= 0 && dc < p.columns;
}

function emptyResult(widthMm: number, heightMm: number, warnings: string[]): TilingResult {
  return {
    panels: [],
    coverage: 0,
    cellCount: 0,
    seams: [],
    unusedMm: {
      right: Number.isFinite(widthMm) ? Math.max(0, widthMm) : 0,
      top: Number.isFinite(heightMm) ? Math.max(0, heightMm) : 0,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

/**
 * Greedy bottom-left fill of `wall` with the largest panels that fit `bedId`.
 *
 * Never throws. A wall that cannot be tiled — degenerate, too small, no panel that
 * fits the bed — comes back as zero panels and a warning, because the caller is a
 * UI that has to render *something* and an exception is not a layout.
 */
export function solveTiling(req: TilingRequest): TilingResult {
  const warnings: string[] = [];
  const wallWidthMm = req.wall.widthMm;
  const wallHeightMm = req.wall.heightMm;

  if (!isPositiveFinite(wallWidthMm) || !isPositiveFinite(wallHeightMm)) {
    warnings.push(
      `Wall is ${wallWidthMm} × ${wallHeightMm} mm; both dimensions must be positive.`,
    );
    return emptyResult(wallWidthMm, wallHeightMm, warnings);
  }

  const bed = BEDS.find((b) => b.id === req.bedId);
  if (bed === undefined) {
    // Without a bed we cannot certify that anything here is printable, and
    // quietly guessing one would put unprintable panels on someone's BOM.
    warnings.push(`Unknown bed id "${req.bedId}" — no panel can be checked for printability.`);
    return emptyResult(wallWidthMm, wallHeightMm, warnings);
  }

  const allowRotation = req.allowRotation !== false;

  // --- candidate variants -------------------------------------------------
  const variants: Variant[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  let tooBigForBed = 0;

  for (const size of req.available) {
    if (!isUsableSize(size)) {
      ignored++;
      continue;
    }
    const forms: Variant[] = [
      { partId: size.partId, columns: size.columns, rows: size.rows, cells: 0, rotated: false },
    ];
    const bedFootprints: Array<[number, number]> = [[size.widthMm, size.heightMm]];
    if (allowRotation) {
      forms.push({
        partId: size.partId,
        columns: size.rows,
        rows: size.columns,
        cells: 0,
        rotated: true,
      });
      bedFootprints.push([size.heightMm, size.widthMm]);
    }

    let anyFit = false;
    for (let i = 0; i < forms.length; i++) {
      const form = forms[i]!;
      const footprint = bedFootprints[i]!;
      if (!fitsBed(footprint[0], footprint[1], bed)) continue;
      anyFit = true;
      // A square panel's rotation is the same panel; keep one so the greedy does
      // not thrash between two indistinguishable candidates.
      const key = `${form.partId}|${form.columns}x${form.rows}`;
      if (seen.has(key)) continue;
      seen.add(key);
      variants.push({ ...form, cells: form.columns * form.rows });
    }
    if (!anyFit) tooBigForBed++;
  }

  if (ignored > 0) {
    warnings.push(`Ignored ${ignored} panel size(s) with a non-integer or non-positive footprint.`);
  }
  if (tooBigForBed > 0) {
    warnings.push(`${tooBigForBed} panel size(s) do not fit bed "${bed.id}" (${bed.label}).`);
  }
  if (variants.length === 0) {
    warnings.push(`No available panel fits bed "${bed.id}" (${bed.label}).`);
    return emptyResult(wallWidthMm, wallHeightMm, warnings);
  }

  variants.sort(compareVariants);

  const byRows = new Map<number, Variant[]>();
  for (const v of variants) {
    const bucket = byRows.get(v.rows);
    if (bucket === undefined) byRows.set(v.rows, [v]);
    else bucket.push(v);
  }
  // Ascending so band-height selection is order-independent; `isBetterBand` decides.
  const rowCounts = [...byRows.keys()].sort((a, b) => a - b);

  // --- band-by-band fill, bottom to top ----------------------------------
  const rMax = maxRowIndex(wallHeightMm);
  const panels: TiledPanel[] = [];
  let r0 = 0;

  while (r0 <= rMax) {
    const remainingRows = rMax - r0 + 1;
    let best: BandPlan | null = null;

    for (const rows of rowCounts) {
      if (rows > remainingRows) break; // ascending, so nothing later fits either
      const band = fillBand(r0, rows, byRows, wallWidthMm);
      if (band.length === 0) continue;
      let cells = 0;
      for (const p of band) cells += p.columns * p.rows;
      const plan: BandPlan = { rows, cells, panels: band };
      if (isBetterBand(plan, best)) best = plan;
    }

    if (best === null) break;
    for (const p of best.panels) panels.push(p);
    r0 += best.rows;
  }

  if (panels.length === 0) {
    warnings.push(
      `Wall is ${wallWidthMm} × ${wallHeightMm} mm — too small for the smallest panel that fits bed "${bed.id}".`,
    );
    return emptyResult(wallWidthMm, wallHeightMm, warnings);
  }

  // --- derived numbers ----------------------------------------------------
  let cellCount = 0;
  const allCells: Hex[] = [];
  for (const p of panels) {
    cellCount += p.columns * p.rows;
    for (const c of panelCells(p.origin, p.columns, p.rows)) allCells.push(c);
  }

  // The lattice is anchored so that the first band's outline starts at (0, 0) in
  // wall millimetres, which is exactly one margin out from `cellsBoundsMm`.
  const bounds = cellsBoundsMm(allCells);
  const unusedMm = {
    right: Math.max(0, wallWidthMm - (bounds.maxX + MARGIN_X)),
    top: Math.max(0, wallHeightMm - (bounds.maxY + MARGIN_Y)),
  };

  const coverage = Math.min(1, (cellCount * CELL_AREA_MM2) / (wallWidthMm * wallHeightMm));

  if (unusedMm.right > PITCH) {
    warnings.push(
      `${unusedMm.right.toFixed(1)} mm of wall width left unfilled: no available panel is narrow enough.`,
    );
  }
  if (unusedMm.top > ROW_STEP) {
    warnings.push(
      `${unusedMm.top.toFixed(1)} mm of wall height left unfilled: no available panel is short enough.`,
    );
  }

  return { panels, coverage, cellCount, seams: seamCells(panels), unusedMm, warnings };
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Every cell that touches a panel boundary, grouped by the pair of panels the
 * boundary separates. Both sides of the boundary are included: a joiner and an
 * accessory both care about the cells on their own panel as well as the ones over
 * the line.
 *
 * Done in cell space, never by comparing rectangles — panel outlines interlock, so
 * the seam is a zig-zag through the grid (D6).
 */
export function seamCells(panels: TilingResult['panels']): Seam[] {
  const owner = new Map<string, string>();
  const cellsOf = new Map<string, Hex[]>();

  for (const p of panels) {
    const key = panelKey(p);
    const cells = panelCells(p.origin, p.columns, p.rows);
    cellsOf.set(key, cells);
    for (const c of cells) owner.set(hexKey(c), key);
  }

  const groups = new Map<string, { a: string; b: string; cells: Map<string, Hex> }>();

  for (const [key, cells] of cellsOf) {
    for (const c of cells) {
      for (const n of hexNeighbours(c)) {
        const other = owner.get(hexKey(n));
        if (other === undefined || other === key) continue;
        const a = key < other ? key : other;
        const b = key < other ? other : key;
        const groupKey = `${a} ${b}`;
        let group = groups.get(groupKey);
        if (group === undefined) {
          group = { a, b, cells: new Map<string, Hex>() };
          groups.set(groupKey, group);
        }
        group.cells.set(hexKey(c), c);
        group.cells.set(hexKey(n), n);
      }
    }
  }

  const seams: Seam[] = [];
  for (const group of groups.values()) {
    const cells = [...group.cells.values()].sort((x, y) => (x.r !== y.r ? x.r - y.r : x.q - y.q));
    seams.push({ a: group.a, b: group.b, cells });
  }
  seams.sort((x, y) => (x.a !== y.a ? (x.a < y.a ? -1 : 1) : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  return seams;
}

/**
 * Does this footprint span more than one panel? The check the UI runs before it
 * warns that an accessory would have to bridge a joint.
 *
 * Cells that land on no panel at all are ignored here: hanging off the edge of the
 * wall is a different complaint ('off-panel'), and reporting it as a seam crossing
 * would send the user looking for a seam that is not there.
 */
export function crossesSeam(cells: readonly Hex[], panels: TilingResult['panels']): boolean {
  let first: TiledPanel | undefined;
  for (const c of cells) {
    const holder = panels.find((p) => panelContains(p, c));
    if (holder === undefined) continue;
    if (first === undefined) first = holder;
    else if (holder !== first) return true;
  }
  return false;
}
