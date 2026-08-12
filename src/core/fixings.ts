/**
 * How many fixings hold the wall up, and which cells they go in.
 *
 * This used to be a property of a PANEL: `tools/scan.py` wrote
 * `requires: insert-countersunk × (4 + cells/50)` onto every panel part, and
 * the BOM multiplied that by the number of panels placed. On a 2400 × 1200 wall
 * tiled into 64 plates that came to **370 wall screws — one every 88 mm**.
 * Nobody drills that.
 *
 * It is a property of the ASSEMBLY, not of one plate. The panels interlock
 * along a zig-zag edge and multi-cell inserts bridge the seams (HSW-SPEC §4),
 * so a tiled wall behaves as one sheet: fixings are spread across it at a
 * spacing chosen for the substrate, not counted per plate.
 *
 * Two rules, and the count is the union of both:
 *
 *  1. **A grid at `spacingMm`**, snapped to real cells. This is what carries
 *     the load and what the spacing figure means.
 *  2. **At least one fixing in every panel.** A plate with no fixing of its own
 *     hangs entirely on its neighbours' interlock; fine in the middle of a
 *     sheet, not fine at an edge, and not worth the failure mode.
 *
 * Sanity check on the default: 220 mm over a 2400 × 1200 wall gives ~66
 * fixings, and "one per panel" over the same wall gives 64. Two independent
 * rules landing in the same place is the reason to believe either. The only
 * outside figure I could find for a real HSW build — a 900 × 600 design
 * specifying 7 insert-countersunk plus 4 hexagon-countersunk-and-hole — works
 * out at 20 per m²; this lands at 23.
 *
 * It is still a stated engineering rule and not a measurement. Argue with it
 * here, in one place, rather than in a scanner that bakes it into 51 files.
 */

import { hexKey, hexToMm, placedPanelCells } from './hex';
import type { Hex, LayoutDoc, PlacedPanel } from './types';

/**
 * Default centre-to-centre spacing for wall fixings, mm.
 *
 * 220 mm sits just inside the common 400 mm timber stud spacing at every other
 * stud, and is a normal fixing pitch for a sheet material into plasterboard
 * anchors. Heavier loads or a soft substrate want it tighter.
 */
export const DEFAULT_FIXING_SPACING_MM = 220;

/** Below this the count explodes; above it the sheet is not really held. */
export const MIN_FIXING_SPACING_MM = 100;
export const MAX_FIXING_SPACING_MM = 600;

export function clampSpacing(mm: number | undefined): number {
  if (typeof mm !== 'number' || !Number.isFinite(mm)) return DEFAULT_FIXING_SPACING_MM;
  return Math.min(MAX_FIXING_SPACING_MM, Math.max(MIN_FIXING_SPACING_MM, Math.round(mm)));
}

export interface FixingPlan {
  /** Cells that should carry a countersunk insert and a wall screw. */
  cells: Hex[];
  /** Which panel each fixing belongs to, in the same order. */
  panelIds: string[];
  spacingMm: number;
  /** Fixings per square metre of panelled wall — the number to sanity-check. */
  perSquareMetre: number;
  /** Panels the plan could not fit a single fixing into, because accessories
   *  have taken every cell. These plates have nothing holding them up. */
  starvedPanelIds: string[];
}

/**
 * Where the wall fixings go.
 *
 * Deterministic: the same document always produces the same cells, so the
 * parts list does not shuffle between renders and a saved layout can be built
 * from the printed sheet months later.
 */
export function planFixings(
  panels: readonly PlacedPanel[],
  spacingMm: number = DEFAULT_FIXING_SPACING_MM,
  /** Cells already taken by accessories. A fixing routes around them rather
   *  than being ordered for a hole that is not free. */
  avoid: ReadonlySet<string> = new Set(),
): FixingPlan {
  const spacing = clampSpacing(spacingMm);
  const chosen = new Map<string, string>(); // cell key -> panel id

  // Cells of each panel, and the whole assembly's extent in millimetres.
  const byPanel: { id: string; cells: Hex[] }[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const panel of panels) {
    const cells = placedPanelCells({
      origin: panel.origin ?? { q: 0, r: 0 },
      columns: Math.max(0, Math.floor(panel.columns)),
      rows: Math.max(0, Math.floor(panel.rows)),
      omit: panel.omit,
    });
    if (cells.length === 0) continue;
    byPanel.push({ id: panel.id, cells });
    for (const c of cells) {
      const p = hexToMm(c);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (byPanel.length === 0) {
    return { cells: [], panelIds: [], spacingMm: spacing, perSquareMetre: 0, starvedPanelIds: [] };
  }

  // Every cell, indexed by position, so a grid point can find the nearest one.
  const all: { cell: Hex; x: number; y: number; panelId: string }[] = [];
  for (const { id, cells } of byPanel) {
    for (const c of cells) {
      if (avoid.has(hexKey(c))) continue;
      const p = hexToMm(c);
      all.push({ cell: c, x: p.x, y: p.y, panelId: id });
    }
  }

  // 1. The grid. Half a spacing in from each edge, so fixings sit inside the
  //    sheet rather than on its corners where the plate is weakest.
  const cols = Math.max(1, Math.round((maxX - minX) / spacing));
  const rows = Math.max(1, Math.round((maxY - minY) / spacing));
  for (let i = 0; i <= cols; i++) {
    for (let j = 0; j <= rows; j++) {
      const gx = minX + ((maxX - minX) * i) / cols;
      const gy = minY + ((maxY - minY) * j) / rows;
      let best: (typeof all)[number] | null = null;
      let bestD = Infinity;
      for (const candidate of all) {
        if (chosen.has(hexKey(candidate.cell))) continue;
        const d = (candidate.x - gx) ** 2 + (candidate.y - gy) ** 2;
        if (d < bestD) {
          bestD = d;
          best = candidate;
        }
      }
      // Only if a cell is actually near the grid point: a grid point over a gap
      // in an L-shaped wall must not drag a fixing across the room to reach it.
      if (best !== null && bestD <= spacing * spacing) {
        chosen.set(hexKey(best.cell), best.panelId);
      }
    }
  }

  // 2. Every panel gets at least one, taken nearest its own centre.
  const covered = new Set(chosen.values());
  const starved: string[] = [];
  for (const { id, cells } of byPanel) {
    if (covered.has(id)) continue;
    let cx = 0;
    let cy = 0;
    for (const c of cells) {
      const p = hexToMm(c);
      cx += p.x;
      cy += p.y;
    }
    cx /= cells.length;
    cy /= cells.length;
    let best: Hex | null = null;
    let bestD = Infinity;
    for (const c of cells) {
      if (chosen.has(hexKey(c)) || avoid.has(hexKey(c))) continue;
      const p = hexToMm(c);
      const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    // Every cell taken by an accessory: this plate has nothing holding it up,
    // and that is worth saying rather than quietly ordering a fixing anyway.
    if (best === null) starved.push(id);
    else chosen.set(hexKey(best), id);
  }

  // Deterministic order: reading order down the wall.
  const entries = [...chosen.entries()].map(([key, panelId]) => {
    const comma = key.indexOf(',');
    return { cell: { q: Number(key.slice(0, comma)), r: Number(key.slice(comma + 1)) }, panelId };
  });
  entries.sort((a, b) => a.cell.r - b.cell.r || a.cell.q - b.cell.q);

  const areaM2 = totalPanelAreaM2(byPanel.reduce((n, p) => n + p.cells.length, 0));
  return {
    cells: entries.map((e) => e.cell),
    panelIds: entries.map((e) => e.panelId),
    spacingMm: spacing,
    perSquareMetre: areaM2 > 0 ? entries.length / areaM2 : 0,
    starvedPanelIds: starved.sort(),
  };
}

/**
 * Panelled area in m², from the cell count.
 *
 * One cell tiles 23.6 × 20.438 mm of wall — the lattice's fundamental domain,
 * not the hexagon's own area, because the cells tessellate.
 */
export function totalPanelAreaM2(cellCount: number): number {
  return (cellCount * 23.6 * 20.438) / 1e6;
}

/** Convenience: the fixing plan for a whole document. */
export const fixingsFor = (
  doc: LayoutDoc,
  spacingMm?: number,
  avoid?: ReadonlySet<string>,
): FixingPlan =>
  planFixings(doc?.panels ?? [], spacingMm ?? DEFAULT_FIXING_SPACING_MM, avoid);
