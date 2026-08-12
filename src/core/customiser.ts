/**
 * Custom panels, as parameters for the OpenSCAD honeycomb customiser.
 *
 * A stock panel is a rectangle of cells and one of the seven shipped STLs. A
 * panel that has to go round a light switch is not: it is the same block with
 * cells missing, and no shipped file has that shape. The customiser in
 * `Customiser/` generates exactly that, and — checked, not assumed — it works on
 * the same lattice this app measures:
 *
 *   | quantity      | customiser                        | measured spec |
 *   |---------------|-----------------------------------|---------------|
 *   | cell pitch    | hole_width + 2·wall = 23.600000   | 23.6          |
 *   | column step   | 1.5·hex_s        = 20.438200      | 20.438        |
 *   | hexagon side  | hex_h/√3         = 13.625466      | 13.6254664    |
 *   | stagger       | hex_h/2          = 11.800000      | 11.8          |
 *   | depth         | 8                                 | 8             |
 *
 * The one difference is the column step: the customiser computes the closed
 * form 20.4382 where the shipped panels use the typed 20.438. That is DECISIONS
 * D4's 0.0002 mm, 0.0024 mm across a 13-column panel — far below print
 * tolerance, and noted rather than adopted. This app stays on the measured
 * constant.
 *
 * ORIENTATION. The customiser is flat-top: its COLUMNS step along 20.438 and
 * its cells step 23.6 within a column, with alternate columns dropped half a
 * pitch. On a pointy-top wall those are the wall's ROWS. The mapping is derived
 * below and pinned in tests/customiser.test.ts against `panelCells` itself, for
 * the same reason panel-parity.test.ts exists: get the stagger parity wrong and
 * the panel is a mirror image of what you asked for, which is invisible until
 * it is printed.
 */

import { PITCH, ROW_STEP } from './constants';
import { hexKey, placedPanelCells } from './hex';
import type { Hex, PlacedPanel } from './types';

export interface CustomiserPanel {
  /** Number_of_Columns. */
  columns: number;
  /** Column_N: how many hexagons in each column. */
  columnHeights: number[];
  /** Gap_Column_N: 1-based row numbers to skip, as the customiser's string. */
  gaps: string[];
  /** Column_Offset_N. */
  offsets: number[];
  flipStaggering: boolean;
  /**
   * Where this shape sat on the wall lattice.
   *
   * The generated plate is position-free — the customiser makes a shape and the
   * app decides where it hangs — but the conversion has to carry the base or it
   * cannot be checked. Parity depends on the ABSOLUTE column index, so a shape
   * translated by an odd number of columns is a different set of parameters,
   * not the same ones moved: that is the mirror-image trap.
   */
  colBase: number;
  rowBase: number;
  /** Cells the panel really has, for cross-checking against the app. */
  cellCount: number;
}

/** The customiser's own limits, from its `[1:13]` / `[0:12]` annotations. */
export const CUSTOMISER_MAX_COLUMNS = 13;
export const CUSTOMISER_MAX_ROWS = 12;

/**
 * A placed panel as customiser (column, row) pairs.
 *
 * Derivation. The app's wall frame is pointy-top:
 *     x = PITCH·(q + r/2)      y = ROW_STEP·r
 * The customiser lays its columns along its own x at ROW_STEP each, and steps
 * 23.6 down a column:
 *     X = ROW_STEP·col         Y = PITCH·(row + lo/2),  lo = (col + flip) % 2
 *
 * Those are the same lattice with the axes swapped: the app's `r` IS the
 * customiser's column, and the app's `q` carries the row. Equating the two and
 * solving for `row` gives the expression below; the half-step term is the
 * stagger, and it is why `lo` has to be computed rather than assumed.
 */
function toCustomiser(cell: Hex, flip: boolean): { col: number; row: number } {
  const col = cell.r;
  const lo = ((col + (flip ? 1 : 0)) % 2 + 2) % 2;
  // app x = PITCH·q + (PITCH/2)·r  must equal  PITCH·row + (PITCH/2)·lo
  const row = cell.q + (cell.r - lo) / 2;
  return { col, row };
}

/**
 * Turn a placed panel — including one with cells cut out — into customiser
 * parameters.
 *
 * Returns null when the shape cannot be expressed: the customiser tops out at
 * 13 columns of 12, and a panel whose cells do not land on integer rows is not
 * one of its panels at all. Refusing beats emitting parameters that generate
 * the wrong plate.
 */
export function toCustomiserPanel(panel: PlacedPanel): CustomiserPanel | null {
  const cells = placedPanelCells(panel);
  if (cells.length === 0) return null;

  // Both parities are legal panels; pick whichever puts every cell on a whole
  // row. Exactly one of them does, and which one depends on the block's origin.
  for (const flip of [false, true]) {
    const mapped = cells.map((c) => ({ cell: c, ...toCustomiser(c, flip) }));
    if (mapped.some((m) => !Number.isInteger(m.row))) continue;

    const minCol = Math.min(...mapped.map((m) => m.col));
    const byCol = new Map<number, number[]>();
    for (const m of mapped) {
      const key = m.col - minCol;
      const list = byCol.get(key);
      if (list) list.push(m.row);
      else byCol.set(key, [m.row]);
    }

    const columns = Math.max(...byCol.keys()) + 1;
    if (columns > CUSTOMISER_MAX_COLUMNS) return null;

    const columnHeights: number[] = [];
    const gaps: string[] = [];
    const offsets: number[] = [];
    for (let c = 0; c < columns; c++) {
      const rows = (byCol.get(c) ?? []).slice().sort((a, b) => a - b);
      if (rows.length === 0) {
        columnHeights.push(0);
        gaps.push('');
        offsets.push(0);
        continue;
      }
      const first = rows[0]!;
      const last = rows[rows.length - 1]!;
      const span = last - first + 1;
      if (span > CUSTOMISER_MAX_ROWS) return null;

      // The customiser counts rows down from the top of each column, so a gap
      // is the 1-based index of a missing row within that column's span.
      const present = new Set(rows);
      const missing: number[] = [];
      for (let r = first; r <= last; r++) {
        if (!present.has(r)) missing.push(r - first + 1);
      }
      columnHeights.push(span);
      gaps.push(missing.join(','));
      // Column_Offset shifts a whole column, which is how columns of different
      // lengths line up with each other.
      offsets.push(first);
    }

    // Offsets are relative to the shallowest column; the absolute row of that
    // column travels separately as `rowBase`, so the shape can be checked
    // against the wall it came from without the customiser needing to know.
    const rowBase = Math.min(...offsets.filter((_, i) => (byCol.get(i) ?? []).length > 0));
    for (let i = 0; i < offsets.length; i++) offsets[i] = offsets[i]! - rowBase;
    if (offsets.some((o) => Math.abs(o) > CUSTOMISER_MAX_COLUMNS)) return null;

    return {
      columns,
      columnHeights,
      gaps,
      offsets,
      flipStaggering: flip,
      colBase: minCol,
      rowBase,
      cellCount: cells.length,
    };
  }
  return null;
}

/** Is this panel a stock rectangle, or has it been cut about? */
export const isCustomPanel = (panel: PlacedPanel): boolean =>
  Array.isArray(panel.omit) && panel.omit.length > 0;

/**
 * The customiser's parameter block, ready to paste into the Customizer panel or
 * to prepend to the .scad file.
 *
 * Emitted as the customiser's own syntax rather than a JSON blob, because the
 * thing a user actually does with it is paste it.
 */
export function toCustomiserScad(panel: CustomiserPanel, label: string): string {
  const lines: string[] = [];
  lines.push(`/* ${label} — ${panel.cellCount} cells */`);
  lines.push(`Number_of_Columns = ${panel.columns};`);
  lines.push(`Flip_Staggering = ${panel.flipStaggering ? 'true' : 'false'};`);
  lines.push('');
  for (let i = 0; i < CUSTOMISER_MAX_COLUMNS; i++) {
    lines.push(`Column_${i} = ${panel.columnHeights[i] ?? 0};`);
  }
  lines.push('');
  for (let i = 0; i < CUSTOMISER_MAX_COLUMNS; i++) {
    lines.push(`Gap_Column_${i} = "${panel.gaps[i] ?? ''}";`);
  }
  lines.push('');
  for (let i = 0; i < CUSTOMISER_MAX_COLUMNS; i++) {
    lines.push(`Column_Offset_${i} = ${panel.offsets[i] ?? 0};`);
  }
  return lines.join('\n');
}

/**
 * Group identical custom panels, so a wall with four panels round one switch
 * does not ask you to configure four separate plates.
 */
export function customPanelGroups(
  panels: readonly PlacedPanel[],
): { key: string; panels: PlacedPanel[]; params: CustomiserPanel | null }[] {
  const groups = new Map<string, PlacedPanel[]>();
  for (const panel of panels) {
    if (!isCustomPanel(panel)) continue;
    // Shape, not position: the same block with the same holes is the same plate
    // wherever it hangs.
    const cut = (panel.omit ?? [])
      .map((c) => hexKey({ q: c.q - panel.origin.q, r: c.r - panel.origin.r }))
      .sort()
      .join(' ');
    const key = `${panel.columns}x${panel.rows}|${cut}`;
    const list = groups.get(key);
    if (list) list.push(panel);
    else groups.set(key, [panel]);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({ key, panels: list, params: toCustomiserPanel(list[0]!) }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Millimetre size of a custom panel, for the printer-fit check. */
export function customPanelSizeMm(panel: CustomiserPanel): { widthMm: number; heightMm: number } {
  const tallest = Math.max(1, ...panel.columnHeights);
  return {
    widthMm: (panel.columns - 1) * ROW_STEP + 27.25093,
    heightMm: PITCH * (tallest + 0.5),
  };
}
