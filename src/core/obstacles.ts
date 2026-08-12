/**
 * Things on the wall the honeycomb has to go round.
 *
 * A light switch, a socket, a thermostat, a pipe. You cannot cut a stock panel,
 * so the planner leaves those cells out of the block and the panel becomes a
 * CUSTOM one, generated from the OpenSCAD customiser rather than printed from a
 * shipped STL. `src/core/customiser.ts` does that conversion; this file decides
 * which cells are affected.
 *
 * Rectangles in wall millimetres, because that is how an obstacle is measured
 * in the room. Everything downstream works in cells.
 */

import { MARGIN_X, MARGIN_Y } from './constants';
import { hexKey, hexToMm } from './hex';
import type { Hex, Obstacle } from './types';

/** Common UK/EU faceplates, so the defaults are not invented. */
export const OBSTACLE_PRESETS: readonly { label: string; widthMm: number; heightMm: number }[] = [
  { label: 'Light switch', widthMm: 86, heightMm: 86 },
  { label: 'Single socket', widthMm: 86, heightMm: 86 },
  { label: 'Double socket', widthMm: 146, heightMm: 86 },
  { label: 'Thermostat', widthMm: 120, heightMm: 80 },
  { label: 'Pipe / conduit', widthMm: 40, heightMm: 600 },
];

export const DEFAULT_CLEARANCE_MM = 5;

/** The obstacle's rectangle, grown by its clearance. */
export function obstacleBounds(o: Obstacle): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  const c = Number.isFinite(o.clearanceMm) ? Math.max(0, o.clearanceMm) : 0;
  const w = Math.max(0, o.widthMm);
  const h = Math.max(0, o.heightMm);
  return { minX: o.xMm - c, minY: o.yMm - c, maxX: o.xMm + w + c, maxY: o.yMm + h + c };
}

/**
 * Does a cell clash with an obstacle?
 *
 * The cell is treated as its full hexagon, not its centre: a switch plate that
 * covers half a hexagon still stops an insert going into it. `MARGIN_X` and
 * `MARGIN_Y` are the measured half-extents of a cell (11.8 and 13.6255), so
 * this is the real envelope rather than a circle around the middle.
 */
export function cellClashes(cell: Hex, o: Obstacle): boolean {
  const { minX, minY, maxX, maxY } = obstacleBounds(o);
  const p = hexToMm(cell);
  return (
    p.x + MARGIN_X > minX && p.x - MARGIN_X < maxX &&
    p.y + MARGIN_Y > minY && p.y - MARGIN_Y < maxY
  );
}

/**
 * Every cell any obstacle blocks, as a key set.
 *
 * Returned as keys rather than Hexes because every caller asks "is this cell
 * blocked" rather than "list them", and a Set of strings is the only shape that
 * answers that in constant time.
 */
export function obstructedCells(
  obstacles: readonly Obstacle[] | undefined,
  candidates: readonly Hex[],
): Set<string> {
  const out = new Set<string>();
  if (!obstacles || obstacles.length === 0) return out;
  for (const cell of candidates) {
    for (const o of obstacles) {
      if (cellClashes(cell, o)) {
        out.add(hexKey(cell));
        break;
      }
    }
  }
  return out;
}

/** A new obstacle, placed at a point, from a preset. */
export function makeObstacle(
  id: string,
  preset: { label: string; widthMm: number; heightMm: number },
  xMm: number,
  yMm: number,
): Obstacle {
  return {
    id,
    label: preset.label,
    xMm: Math.round(xMm),
    yMm: Math.round(yMm),
    widthMm: preset.widthMm,
    heightMm: preset.heightMm,
    clearanceMm: DEFAULT_CLEARANCE_MM,
  };
}
