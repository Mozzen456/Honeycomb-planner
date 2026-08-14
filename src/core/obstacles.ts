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

/**
 * The rectangles a zone actually blocks, each grown by its clearance.
 *
 * ONE reader of `shape`, so a zone made of several rectangles cannot be cut one
 * way by the honeycomb and clipped another way by the border. Every consumer —
 * the cell cutter, the border's `keepClear`, the plan's drawing — goes through
 * here, and a zone with no `shape` yields exactly the one rectangle it always
 * did.
 */
export function obstacleRects(o: Obstacle): {
  minX: number; minY: number; maxX: number; maxY: number;
}[] {
  const c = Number.isFinite(o.clearanceMm) ? Math.max(0, o.clearanceMm) : 0;
  const parts = o.shape && o.shape.length > 0
    ? o.shape
    : [{ xMm: o.xMm, yMm: o.yMm, widthMm: o.widthMm, heightMm: o.heightMm }];
  return parts.map((r) => {
    const w = Math.max(0, r.widthMm);
    const h = Math.max(0, r.heightMm);
    return { minX: r.xMm - c, minY: r.yMm - c, maxX: r.xMm + w + c, maxY: r.yMm + h + c };
  });
}

/**
 * The zone's overall extent, grown by its clearance.
 *
 * The BOUNDING box of the whole shape. Right for "is this anywhere near", wrong
 * for "is this blocked" once a zone is an L — the inside of the L is within the
 * bounds and is not blocked — so anything deciding what to cut or clip must use
 * `obstacleRects` instead.
 */
export function obstacleBounds(o: Obstacle): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  const rects = obstacleRects(o);
  return {
    minX: Math.min(...rects.map((r) => r.minX)),
    minY: Math.min(...rects.map((r) => r.minY)),
    maxX: Math.max(...rects.map((r) => r.maxX)),
    maxY: Math.max(...rects.map((r) => r.maxY)),
  };
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
  const p = hexToMm(cell);
  // ANY of the zone's rectangles, not its bounding box: the inside of an L is
  // not blocked, and cutting it would take cells the user did not ask for.
  return obstacleRects(o).some(
    ({ minX, minY, maxX, maxY }) =>
      p.x + MARGIN_X > minX && p.x - MARGIN_X < maxX &&
      p.y + MARGIN_Y > minY && p.y - MARGIN_Y < maxY,
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
