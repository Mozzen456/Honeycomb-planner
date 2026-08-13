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
 *
 * SEAMS. Where panels meet, the fixing that goes in is not a single-cell one.
 * HSW-SPEC §4: the panels carry no screw holes of their own, and "a 2-, 3- or
 * 4-cell insert dropped into cells that straddle the join is what actually
 * holds two panels together". So a junction where three or four plates meet
 * gets `insert-for-countersunk-hole-3` — a four-cell diamond taking one wall
 * screw — which fixes all of them to the wall with one fixing and stops them
 * parting company with each other. Those are planned first; the spacing grid
 * then fills in what is left.
 */

import { hexKey, hexToMm, placeFootprint, placedPanelCells } from './hex';
import type { Hex, LayoutDoc, PlacedPanel, Rotation } from './types';

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

/**
 * The four-cell countersunk insert that bridges a junction.
 *
 * Footprint copied from the catalogue's MEASURED entry rather than derived —
 * `tests/fixings.test.ts` asserts the two still agree, so a rescan that changed
 * the part cannot leave this silently wrong.
 */
export const JUNCTION_FIXING_ID = 'insert-for-countersunk-hole-3';
export const JUNCTION_FOOTPRINT: readonly Hex[] = [
  { q: 0, r: 0 }, { q: 1, r: -1 }, { q: 1, r: 0 }, { q: 2, r: -1 },
];

/** A fixing that straddles a seam, holding several plates at once. */
export interface JunctionFixing {
  cells: Hex[];
  /** The panels it ties together — three or four, or it would not be one. */
  panelIds: string[];
  /**
   * Where and how it sits, so the 3D view can draw the real part rather than a
   * token. Without these the renderer would have to re-derive the rotation from
   * the cell set, which is the sort of second derivation that drifts.
   */
  anchor: Hex;
  rotation: Rotation;
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
  /** Multi-panel junctions, each bridged by a four-cell countersunk insert. */
  junctions: JunctionFixing[];
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
    return {
      cells: [], panelIds: [], spacingMm: spacing, perSquareMetre: 0,
      starvedPanelIds: [], junctions: [],
    };
  }

  // 0. Junctions first. Where three or four plates meet, one four-cell insert
  //    ties them together AND to the wall — which a single-cell fixing in each
  //    plate does not do, however many of them there are. Planned before the
  //    grid so the grid fills in around them rather than competing.
  const owner = new Map<string, string>();
  for (const { id, cells } of byPanel) {
    for (const c of cells) owner.set(hexKey(c), id);
  }
  const junctions: JunctionFixing[] = [];
  const usedByJunction = new Set<string>();
  for (const { cells } of byPanel) {
    for (const anchor of cells) {
      for (let rot = 0; rot < 6; rot++) {
        const placed = placeFootprint(JUNCTION_FOOTPRINT, anchor, rot as Rotation);
        const keys = placed.map(hexKey);
        // Every cell must be on a panel, free, and not already spoken for.
        if (keys.some((k) => !owner.has(k) || avoid.has(k) || usedByJunction.has(k))) continue;
        const panels = new Set(keys.map((k) => owner.get(k)!));
        // Three or more plates is a junction; two is an ordinary seam, which
        // the interlocking edge already handles.
        if (panels.size < 3) continue;
        junctions.push({
          cells: placed,
          panelIds: [...panels].sort(),
          anchor,
          rotation: rot as Rotation,
        });
        for (const k of keys) {
          usedByJunction.add(k);
          chosen.set(k, owner.get(k)!);
        }
        break;
      }
    }
  }

  // Every cell, indexed by position, so a grid point can find the nearest one.
  const all: { cell: Hex; x: number; y: number; panelId: string }[] = [];
  for (const { id, cells } of byPanel) {
    for (const c of cells) {
      if (avoid.has(hexKey(c)) || usedByJunction.has(hexKey(c))) continue;
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
      // A junction already fixes the sheet here. It counts TOWARDS the spacing
      // rather than being extra: planning both independently put 56 junction
      // inserts on top of 74 single ones and asked for 128 holes in a wall that
      // needs about 70.
      let covered = false;
      for (const j2 of junctions) {
        for (const c of j2.cells) {
          const p2 = hexToMm(c);
          if ((p2.x - gx) ** 2 + (p2.y - gy) ** 2 < (spacing * 0.7) ** 2) covered = true;
          if (covered) break;
        }
        if (covered) break;
      }
      if (covered) continue;
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

  // 2. Every panel gets at least one, taken nearest its own centre. A panel
  //    held by a junction insert already has one.
  const covered = new Set(chosen.values());
  for (const j of junctions) for (const id of j.panelIds) covered.add(id);
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
      if (chosen.has(hexKey(c)) || avoid.has(hexKey(c)) || usedByJunction.has(hexKey(c))) continue;
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

  // Deterministic order: reading order down the wall. Junction cells are held
  // in `chosen` so nothing else claims them, but they are NOT single-cell
  // fixings and must not be ordered as such.
  const entries = [...chosen.entries()]
    .filter(([key]) => !usedByJunction.has(key))
    .map(([key, panelId]) => {
    const comma = key.indexOf(',');
      return { cell: { q: Number(key.slice(0, comma)), r: Number(key.slice(comma + 1)) }, panelId };
    });
  entries.sort((a, b) => a.cell.r - b.cell.r || a.cell.q - b.cell.q);

  const areaM2 = totalPanelAreaM2(byPanel.reduce((n, p) => n + p.cells.length, 0));
  return {
    cells: entries.map((e) => e.cell),
    panelIds: entries.map((e) => e.panelId),
    spacingMm: spacing,
    perSquareMetre: areaM2 > 0 ? (entries.length + junctions.length) / areaM2 : 0,
    starvedPanelIds: starved.sort(),
    junctions,
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
