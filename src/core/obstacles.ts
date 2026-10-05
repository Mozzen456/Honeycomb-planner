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
import type { Hex, Obstacle, ZonePoint } from './types';
import {
  convexParts, edgesOf, growConvex, regionPoints, type Pt, type ZoneEdge,
} from './zonePolygon';

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
  // A drawn outline is not rectangles at all; what is returned is each piece's
  // BOUNDING box, for "is this anywhere near" and nothing else. Cutting goes
  // through `obstacleRegions`.
  if (hasOutline(o)) return obstacleRegions(o).map(({ minX, minY, maxX, maxY }) => ({ minX, minY, maxX, maxY }));
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
 * One convex piece of a blocked zone, grown by its clearance: a bounding box,
 * and — for a drawn outline — the straight edges that bound it.
 *
 * `edges` absent means the box IS the piece, an axis-aligned rectangle, which
 * is every zone that is not a drawn outline. The generator reads both the same
 * way (`BorderSpec.keepClear`), turning a bare box into its four edges, so a
 * rectangle and a polygon are cut by one piece of code (D109).
 */
export interface ZoneRegion {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  edges?: readonly ZoneEdge[];
}

export const hasOutline = (o: Obstacle): boolean =>
  Array.isArray(o.outline) && o.outline.length >= 3;

const toPts = (outline: readonly ZonePoint[]): Pt[] => outline.map((p) => ({ x: p.xMm, y: p.yMm }));

/** Decomposition is the expensive part, and an outline array never changes. */
const partsCache = new WeakMap<readonly ZonePoint[], { points: Pt[]; internal: boolean[] }[]>();

function outlineParts(outline: readonly ZonePoint[]): { points: Pt[]; internal: boolean[] }[] {
  const hit = partsCache.get(outline);
  if (hit) return hit;
  const parts = convexParts(toPts(outline));
  partsCache.set(outline, parts);
  return parts;
}

/**
 * What a zone blocks, as convex regions grown by its clearance.
 *
 * The ONE reader the cutter, the border and the clash test share. A rectangle
 * zone gives its rectangles (`obstacleRects`) with no edges; a drawn outline
 * gives its convex pieces, each pushed out by the clearance with a bevel at any
 * sharp corner (`growConvex`).
 */
export function obstacleRegions(o: Obstacle): ZoneRegion[] {
  if (!hasOutline(o)) return obstacleRects(o);
  const c = Number.isFinite(o.clearanceMm) ? Math.max(0, o.clearanceMm) : 0;
  const out: ZoneRegion[] = [];
  for (const part of outlineParts(o.outline!)) {
    const edges = growConvex(edgesOf(part.points, part.internal), part.points, c);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of part.points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    // The grown piece's own corners, found by clipping a box that certainly
    // holds it — a bevel can only make it smaller than the mitre.
    const reach = c * 4 + 1;
    const corners = regionPoints(edges, {
      minX: minX - reach, minY: minY - reach, maxX: maxX + reach, maxY: maxY + reach,
    });
    if (corners.length < 3) continue;
    out.push({
      minX: Math.min(...corners.map((p) => p.x)),
      minY: Math.min(...corners.map((p) => p.y)),
      maxX: Math.max(...corners.map((p) => p.x)),
      maxY: Math.max(...corners.map((p) => p.y)),
      edges,
    });
  }
  return out;
}

/** A region's corners — for drawing it, never for cutting with. */
export function regionOutline(r: ZoneRegion): Pt[] {
  if (!r.edges) {
    return [
      { x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY },
      { x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY },
    ];
  }
  return regionPoints(r.edges, {
    minX: r.minX - 1, minY: r.minY - 1, maxX: r.maxX + 1, maxY: r.maxY + 1,
  });
}

/** Does a cell's HEXAGON overlap a convex region by any real area? */
function hexMeetsRegion(centre: { x: number; y: number }, r: ZoneRegion): boolean {
  if (centre.x + MARGIN_X <= r.minX || centre.x - MARGIN_X >= r.maxX ||
      centre.y + MARGIN_Y <= r.minY || centre.y - MARGIN_Y >= r.maxY) return false;
  if (!r.edges) return true;
  // Flat-top: corners at 0°, 60° ... with the corner radius across x.
  let poly: Pt[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 3) * k;
    poly.push({ x: centre.x + MARGIN_X * Math.cos(a), y: centre.y + MARGIN_X * Math.sin(a) });
  }
  for (const e of r.edges) {
    const next: Pt[] = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i]!;
      const prev = poly[(i + poly.length - 1) % poly.length]!;
      const dc = e.nx * cur.x + e.ny * cur.y - e.d;
      const dp = e.nx * prev.x + e.ny * prev.y - e.d;
      if ((dc <= 0) !== (dp <= 0)) {
        const t = dp / (dp - dc);
        next.push({ x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) });
      }
      if (dc <= 0) next.push(cur);
    }
    poly = next;
    if (poly.length < 3) return false;
  }
  let area2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    area2 += p.x * q.y - q.x * p.y;
  }
  // A hundredth of a square millimetre: a region touching a cell along a line
  // or at a point blocks nothing in it.
  return Math.abs(area2) / 2 > 0.01;
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
  /*
   * A drawn outline is tested against the cell's real HEXAGON.
   *
   * The box test below over-selects at the box's four empty corners. For a
   * rectangle that is harmless — the cutter is handed a cell the zone only
   * grazes and splits it into pieces whose union is the whole cell. A slanted
   * edge can pass a box corner without touching the hexagon at all, and the
   * cutter, finding the whole hexagon outside that edge, has nothing to cut —
   * and a cut cell with nothing to cut it by is not drawn. A hole in the plate
   * where the zone never reached. Testing the real overlap keeps those cells
   * whole and in the planner.
   */
  if (hasOutline(o)) return obstacleRegions(o).some((r) => hexMeetsRegion(p, r));
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
