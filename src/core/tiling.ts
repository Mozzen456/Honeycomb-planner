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
 * ---------------------------------------------------------------------------
 * Why every band wants to start on an EVEN column
 * ---------------------------------------------------------------------------
 *
 * `panelCells` staggers relative column `dq` by −floor(dq/2), so inside a block
 * the odd columns sit half a pitch UP from the even ones. In wall millimetres a
 * band beginning at absolute column q0 puts the lowest cell of column q at
 *
 *   y / PITCH = k + frac((q − q0)/2),   k an integer,
 *
 * and frac((q − q0)/2) is frac(q/2) when q0 is even and its OPPOSITE when q0 is
 * odd. An odd-origin band therefore carries the other phase of the same lattice:
 * its odd columns hang half a pitch down exactly where an even-origin band's odd
 * columns reach half a pitch up. No choice of k repairs that — k is a whole row
 * and the error is half of one — so the two bands' silhouettes differ by a whole
 * PITCH (23.6 mm) at the top and at the bottom. On screen it reads as "the
 * honeycomb runs one cell high for a few columns, then one cell low for the next
 * few", which is the same defect at both ends of the wall.
 *
 * So the solver prefers the band width that leaves the NEXT band on an even
 * column (`BandPlan.keepsPhase`); starting from q0 = 0 that keeps the whole wall
 * in one phase, at a cost of at most one column of plate width. It is a
 * PREFERENCE, not a rule: where only odd widths fit — possible with the shipped
 * plates, never with generated ones — a step is better than bare wall, so
 * `isBetterBand` falls through to covering the most cells.
 */

import { PITCH, ROW_STEP, MARGIN_X, MARGIN_Y, bedFor } from './constants';
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
  /** Id from BEDS in constants.ts, or `custom` with `customBed` beside it. */
  bedId: string;
  /** The typed build plate, when `bedId` is `custom`. Resolved by `bedFor`. */
  customBed?: { widthMm: number; depthMm: number };
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
// Plates the app sizes itself
// ---------------------------------------------------------------------------

/** Ids of plates generated to fit the printer, rather than taken from `models/`. */
export const GENERATED_PREFIX = 'generated/';

export const generatedSizeId = (columns: number, rows: number): string =>
  `${GENERATED_PREFIX}${columns}x${rows}`;

/**
 * The printed size of a cell block, before any border.
 *
 * Derived from the lattice, and checked against the shipped plates: 8 × 7 gives
 * 170.317 × 177.0, which is `wall-honeycomb-part` to four decimals, and 4 × 4
 * gives 88.565 × 106.2, which is `wall-honeycomb-106x89-fixed`. Both are in
 * `tests/plate-size.test.ts` — this is the arithmetic that decides whether a
 * plate fits the bed, so it is held to the real files rather than to itself.
 */
export function plateFootprintMm(
  columns: number,
  rows: number,
  borderMm = 0,
): { widthMm: number; heightMm: number } {
  return {
    widthMm: (columns - 1) * ROW_STEP + 2 * MARGIN_X + 2 * borderMm,
    heightMm: PITCH * (rows + 0.5) + 2 * borderMm,
  };
}

/** The biggest block that fits a bed. Whole cells only — half a cell is no cell. */
export function maxPlateForBed(
  bed: Bed,
  borderMm = 0,
): { columns: number; rows: number } {
  const usableW = bed.width - 2 * MARGIN_X - 2 * borderMm;
  const usableH = bed.depth - 2 * borderMm;
  const columns = Math.floor(usableW / ROW_STEP + EPS) + 1;
  const rows = Math.floor(usableH / PITCH - 0.5 + EPS);
  return { columns: Math.max(0, columns), rows: Math.max(0, rows) };
}

/**
 * Every block size this printer can make, largest first.
 *
 * The WHOLE grid up to the maximum, not just the maximum: the solver fills a
 * wall greedily and needs the smaller sizes to finish the right-hand edge and
 * the top of every band. Offering only the biggest plate leaves a strip of bare
 * wall exactly one plate wide.
 *
 * It used to keep only the 120 largest, on the grounds that the solver tries
 * every variant at every position. That is the wrong axis to economise on: a
 * band's WIDTH is chosen once, but its heights have to STACK to the top of the
 * wall exactly, so dropping the short plates leaves a band unable to finish.
 * Measured on a 2400 × 1200 wall with a 350 mm bed: the shortest 5-column plate
 * offered was 9 rows, the last band had 7 rows of room, and the right-hand strip
 * of that wall ended 165 mm below every other band — a ragged top, from a cap
 * that was never load-bearing. The grid is small anyway: the biggest bed the app
 * knows about makes 19 × 16, and the solver's own loop is an array scan.
 */

/**
 * What a bordered plate can carry beyond its own cells.
 *
 * The wall's edge is one continuous strip and the plates share it out, so the
 * plate at a corner can end up owning a piece that reaches a full lattice step
 * past its own block. Budgeted here rather than discovered at the printer:
 * without it a bordered wall plans plates to exactly the bed and then three of
 * them do not fit. Costs a column when a border is on, and nothing when it is
 * not.
 */
const BORDER_OVERHANG_X = ROW_STEP;
const BORDER_OVERHANG_Y = PITCH / 2;

export function generatedPlateSizes(
  bedId: string,
  borderMm = 0,
  customBed?: { widthMm: number; depthMm: number },
): PanelSize[] {
  const bed = bedFor(bedId, customBed);
  if (bed === undefined) return [];
  const allowance = borderMm > 0
    ? { width: BORDER_OVERHANG_X, depth: BORDER_OVERHANG_Y }
    : { width: 0, depth: 0 };
  const max = maxPlateForBed(
    { ...bed, width: bed.width - allowance.width, depth: bed.depth - allowance.depth },
    borderMm,
  );
  if (max.columns < 1 || max.rows < 1) return [];

  const out: PanelSize[] = [];
  for (let c = 1; c <= max.columns; c++) {
    for (let r = 1; r <= max.rows; r++) {
      const size = plateFootprintMm(c, r, borderMm);
      out.push({
        partId: generatedSizeId(c, r),
        columns: c,
        rows: r,
        widthMm: size.widthMm + allowance.width,
        heightMm: size.heightMm + allowance.depth,
      });
    }
  }
  out.sort((a, b) => b.columns * b.rows - a.columns * a.rows);
  return out;
}


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
 * Highest absolute lattice COLUMN whose cells still sit inside the wall.
 *
 * Cell (q, r) has its centre at x = ROW_STEP·q + MARGIN_X in wall millimetres
 * (the lattice is anchored so the bottom-left panel's outline starts at x = 0),
 * so its right corner is at ROW_STEP·q + 2·MARGIN_X. Negative means "no columns".
 *
 * A band runs VERTICALLY since the wall turned flat-top (D35): panels stack
 * along q across the wall, and each band is a full-height strip of columns. Every
 * name in this section transposed with the frame — the arithmetic is the same
 * argument, read along the other axis.
 */
function maxColumnIndex(wallWidthMm: number): number {
  return Math.floor((wallWidthMm - 2 * MARGIN_X) / ROW_STEP + EPS);
}

/** Half-pitch inset of a band that begins at absolute column `q0`: 0 or 0.5 pitches. */
const bandShift = (q0: number): number => q0 / 2 - Math.floor(q0 / 2);

/**
 * Whole-pitch nudge that lands a band's LOWEST cell on the wall.
 *
 * `panelCells` staggers by −floor(dq/2), which is the parity the meshes actually
 * use (tests/panel-parity.test.ts checks the generated map against the measured
 * footprints), so the odd relative columns lean UP and the band's lowest cell is
 * always in its first column, centred `PITCH·bandShift(q0)` above the wall's
 * bottom edge. Half a cell of plate hangs below that centre, so a band at an even
 * origin (shift 0) has to come up a whole row — `r` is an integer, and a whole
 * pitch is the only correction there is.
 *
 * It used to ask for `bandColumns >= 2` as well, reasoning about the odd columns
 * at the TOP. That is the same arithmetic read at the wrong end: a ONE-column
 * band has no odd column, so it was left unbumped with its cells centred on
 * y = 0 and half of every one of them below the wall (measured: −11.8 mm on a
 * 360 mm wall, whose last band is a single column). A one-column band is exactly
 * what finishes a wall whose width does not divide, so it was on screen often.
 */
const bandBump = (q0: number): number => (bandShift(q0) < 0.5 ? 1 : 0);

/**
 * How many rows tall a band may be before it overruns the wall.
 *
 * The topmost material belongs to an ODD relative column (they lean up), so the
 * limit allows for that half pitch — including for a one-column band, which has
 * none and could take half a row more. The allowance is kept uniform on purpose:
 * it is what makes every band finish at the same height, and spending it would
 * leave one narrow band standing a row proud of its neighbours.
 */
function maxRowsInBand(wallHeightMm: number, q0: number): number {
  const shift = bandShift(q0) + bandBump(q0);
  // PITCH·(shift + rows − 1) + 2·MARGIN_Y <= wallHeightMm
  const rows = (wallHeightMm - 2 * MARGIN_Y) / PITCH - shift + 1;
  return Math.max(0, Math.floor(rows + EPS));
}

/**
 * Lay one band of uniform width up the wall, bottom to top, always taking the
 * tallest candidate that still fits the space left. Falling back down the list is
 * what stops us leaving a gap a smaller panel could have filled.
 */
function fillBand(
  q0: number,
  bandColumns: number,
  byColumns: ReadonlyMap<number, readonly Variant[]>,
  wallHeightMm: number,
): TiledPanel[] {
  const usable = byColumns.get(bandColumns);
  if (usable === undefined) return [];

  const rOrigin = -Math.floor(q0 / 2) + bandBump(q0);
  const maxRows = maxRowsInBand(wallHeightMm, q0);

  const out: TiledPanel[] = [];
  let row = 0;
  for (;;) {
    const room = maxRows - row;
    const pick = usable.find((v) => v.rows <= room);
    if (pick === undefined) break;
    out.push({
      partId: pick.partId,
      origin: { q: q0, r: rOrigin + row },
      columns: pick.columns,
      rows: pick.rows,
    });
    row += pick.rows;
  }
  return out;
}

interface BandPlan {
  columns: number;
  cells: number;
  /** Does the band after this one start on an even column — or is there none? */
  keepsPhase: boolean;
  panels: TiledPanel[];
}

/**
 * Band plans are compared on phase first, then on cells covered, then on panel
 * count — given two plans that cover the same wall, the one made of fewer, larger
 * pieces is the one with fewer seams. `columns` breaks the last tie and is unique
 * per plan, so the order is total.
 *
 * Phase outranks coverage because an out-of-phase band is a 23.6 mm step in the
 * honeycomb along the whole height of the wall (see the header), while the cost
 * of staying in phase is one column of plate width. When nothing keeps phase
 * every candidate scores the same here and the comparison falls through, which is
 * the whole of the fallback.
 */
function isBetterBand(candidate: BandPlan, incumbent: BandPlan | null): boolean {
  if (incumbent === null) return true;
  if (candidate.keepsPhase !== incumbent.keepsPhase) return candidate.keepsPhase;
  if (candidate.cells !== incumbent.cells) return candidate.cells > incumbent.cells;
  if (candidate.panels.length !== incumbent.panels.length) {
    return candidate.panels.length < incumbent.panels.length;
  }
  return candidate.columns > incumbent.columns;
}

/** Is cell `c` inside `p`? The arithmetic inverse of `panelCells`, allocation-free. */
function panelContains(p: TiledPanel, c: Hex): boolean {
  const dq = c.q - p.origin.q;
  if (dq < 0 || dq >= p.columns) return false;
  // Mirrors panelCells' -floor(q/2) stagger; ceil here would mis-test odd columns.
  const dr = c.r - p.origin.r + Math.floor(dq / 2);
  return dr >= 0 && dr < p.rows;
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

  const bed = bedFor(req.bedId, req.customBed);
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

  const byColumns = new Map<number, Variant[]>();
  for (const v of variants) {
    const bucket = byColumns.get(v.columns);
    if (bucket === undefined) byColumns.set(v.columns, [v]);
    else bucket.push(v);
  }
  // Ascending so band-width selection is order-independent; `isBetterBand` decides.
  const columnCounts = [...byColumns.keys()].sort((a, b) => a - b);

  // --- band-by-band fill, left to right -----------------------------------
  // Bands run vertically since the wall turned flat-top (D35).
  const qMax = maxColumnIndex(wallWidthMm);
  const panels: TiledPanel[] = [];
  let q0 = 0;

  while (q0 <= qMax) {
    const remainingColumns = qMax - q0 + 1;
    let best: BandPlan | null = null;

    for (const columns of columnCounts) {
      if (columns > remainingColumns) break; // ascending, so nothing later fits either
      const band = fillBand(q0, columns, byColumns, wallHeightMm);
      if (band.length === 0) continue;
      let cells = 0;
      for (const p of band) cells += p.columns * p.rows;
      // A band that finishes the wall is in phase by default: there is no next
      // band to put out, so an odd width is free at the right-hand edge.
      const next = q0 + columns;
      const plan: BandPlan = {
        columns,
        cells,
        keepsPhase: next > qMax || next % 2 === 0,
        panels: band,
      };
      if (isBetterBand(plan, best)) best = plan;
    }

    if (best === null) break;
    for (const p of best.panels) panels.push(p);
    q0 += best.columns;
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
