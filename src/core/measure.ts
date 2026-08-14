/**
 * Measuring on the plan, and snapping while you do it.
 *
 * A wall is planned against a room, and a room is measured with a tape: "the
 * switch is 320 from the corner", "there is 1140 between the door frame and the
 * cupboard". Until now the app could tell you the wall was 2400 wide and nothing
 * else — you could not ask it how far it was between any two things on it.
 *
 * Pure geometry over millimetres, so it can be tested without a canvas. The
 * renderer supplies the points and draws the answer; every decision about what a
 * point means is made here.
 *
 * Snapping matters more than it looks. A blocked zone drawn by eye lands a
 * fraction of a cell off, and a fraction of a cell is the difference between
 * cutting one hexagon and cutting two — so the same snapping serves the measure
 * tool and the zone tool, and both agree about where things are.
 */

import { PITCH, ROW_STEP } from './constants';
import { hexToMm, mmToHex, type Point } from './hex';
import { obstacleBounds } from './obstacles';
import type { Hex, LayoutDoc, Obstacle, ZoneRect } from './types';

/** What a snapped point latched onto. Drives the readout and the marker. */
export type SnapKind = 'cell' | 'wall' | 'zone' | 'free';

export interface Snap {
  x: number;
  y: number;
  kind: SnapKind;
  /** Human wording for the readout: "cell centre", "wall corner", "Light switch". */
  label: string;
}

/**
 * How good a target is, low wins, before distance is even considered.
 *
 * A POINT beats a LINE. Ranking by distance alone makes a wall corner
 * unreachable — standing 3 mm right and 4 mm up from it, the bottom edge is 4 mm
 * away and the corner 5, so the edge always takes the pointer and you can never
 * measure from the corner of your own wall.
 */
const SNAP_RANK = {
  cell: 0,
  zoneCorner: 1,
  wallCorner: 2,
  zoneEdge: 3,
  wallEdge: 4,
} as const;

/**
 * How close the pointer has to be, in millimetres, before a target takes it.
 *
 * In millimetres rather than pixels so the behaviour does not change with zoom
 * — but the caller scales it by the view, because 8 mm at 10 % zoom is under a
 * pixel and would never catch.
 */
export const SNAP_RADIUS_MM = 8;

export interface SnapOptions {
  /** Cells worth snapping to. The panels' cells; empty on a bare wall. */
  cells?: readonly Hex[];
  obstacles?: readonly Obstacle[];
  wall?: { widthMm: number; heightMm: number };
  radiusMm?: number;
  /** Turn snapping off entirely — what a modifier key does. */
  enabled?: boolean;
}

/**
 * The nearest thing worth latching onto, or the point itself.
 *
 * Ordered by usefulness rather than by distance alone: a cell centre beats a
 * zone edge beats the wall outline, because a tie between them means the user is
 * pointing at a cell that happens to sit under a zone edge, and the cell is what
 * they can act on. Ties inside one kind go to whichever is closer.
 */
export function snapPoint(p: Point, opts: SnapOptions = {}): Snap {
  if (opts.enabled === false) return { x: p.x, y: p.y, kind: 'free', label: 'free' };
  const r = opts.radiusMm ?? SNAP_RADIUS_MM;
  const r2 = r * r;

  const candidates: (Snap & { rank: number })[] = [];

  // 1. Cell centres, and only cells that exist. On a bare wall the lattice is
  //    arithmetic everywhere and real nowhere, so an empty list snaps to none.
  if (opts.cells && opts.cells.length > 0) {
    const near = mmToHex(p);
    const key = `${near.q},${near.r}`;
    const has = opts.cells.some((c) => `${c.q},${c.r}` === key);
    if (has) {
      const c = hexToMm(near);
      candidates.push({ x: c.x, y: c.y, kind: 'cell', label: 'cell centre', rank: SNAP_RANK.cell });
    }
  }

  // 2. Zone corners, then zone edges.
  for (const o of opts.obstacles ?? []) {
    const b = { minX: o.xMm, minY: o.yMm, maxX: o.xMm + o.widthMm, maxY: o.yMm + o.heightMm };
    for (const x of [b.minX, b.maxX]) {
      for (const y of [b.minY, b.maxY]) {
        candidates.push({ x, y, kind: 'zone', label: `${o.label} corner`, rank: SNAP_RANK.zoneCorner });
      }
    }
    const edge = SNAP_RANK.zoneEdge;
    candidates.push(
      { x: clamp(p.x, b.minX, b.maxX), y: b.minY, kind: 'zone', label: `${o.label} edge`, rank: edge },
      { x: clamp(p.x, b.minX, b.maxX), y: b.maxY, kind: 'zone', label: `${o.label} edge`, rank: edge },
      { x: b.minX, y: clamp(p.y, b.minY, b.maxY), kind: 'zone', label: `${o.label} edge`, rank: edge },
      { x: b.maxX, y: clamp(p.y, b.minY, b.maxY), kind: 'zone', label: `${o.label} edge`, rank: edge },
    );
  }

  // 3. The wall itself.
  if (opts.wall) {
    const { widthMm: w, heightMm: h } = opts.wall;
    for (const x of [0, w]) {
      for (const y of [0, h]) {
        candidates.push({ x, y, kind: 'wall', label: 'wall corner', rank: SNAP_RANK.wallCorner });
      }
    }
    const edge = SNAP_RANK.wallEdge;
    candidates.push(
      { x: clamp(p.x, 0, w), y: 0, kind: 'wall', label: 'wall edge', rank: edge },
      { x: clamp(p.x, 0, w), y: h, kind: 'wall', label: 'wall edge', rank: edge },
      { x: 0, y: clamp(p.y, 0, h), kind: 'wall', label: 'wall edge', rank: edge },
      { x: w, y: clamp(p.y, 0, h), kind: 'wall', label: 'wall edge', rank: edge },
    );
  }

  let best: (Snap & { rank: number }) | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
    if (d > r2) continue;
    if (best === null || c.rank < best.rank || (c.rank === best.rank && d < bestD)) {
      best = c;
      bestD = d;
    }
  }
  if (!best) return { x: p.x, y: p.y, kind: 'free', label: 'free' };
  return { x: best.x, y: best.y, kind: best.kind, label: best.label };
}

export interface Measurement {
  from: Snap;
  to: Snap;
  distanceMm: number;
  dxMm: number;
  dyMm: number;
  /** Degrees anticlockwise from the +x axis, −180 to 180. */
  angleDeg: number;
  /** How many cell pitches the run is, across and up. Reads as "3 cells over". */
  cellsAcross: number;
  cellsUp: number;
}

/** The numbers a measurement gives you. */
export function measure(from: Snap, to: Snap): Measurement {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return {
    from,
    to,
    distanceMm: Math.hypot(dx, dy),
    dxMm: dx,
    dyMm: dy,
    angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
    // The two lattice steps, named — NOT `MARGIN_X · 1.5` and `MARGIN_Y · 2`,
    // which are the same numbers re-derived and differ from the measured
    // ROW_STEP in the fourth decimal (D4). That closed form is exactly the
    // "simplification" `constants.ts` warns against.
    cellsAcross: dx / ROW_STEP,
    cellsUp: dy / PITCH,
  };
}

/**
 * A narrow no-break space, the typographic thousands separator.
 *
 * Exported because it is INVISIBLE: a test that types a plain space instead
 * fails with `expected '1 240' to be '1 240'`, which nobody can read. No-break,
 * so a wall width never wraps between its thousands and its hundreds.
 */
export const THOUSANDS_SEPARATOR = '\u202f';

/** "1\u202f240" — the readout, grouped so a four-figure number is readable. */
export function formatMm(mm: number, decimals = 1): string {
  const rounded = Number(mm.toFixed(decimals));
  const [whole, frac] = Math.abs(rounded).toFixed(decimals).split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS_SEPARATOR);
  const sign = rounded < 0 ? '−' : '';
  return frac && Number(frac) !== 0 ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

// ---------------------------------------------------------------------------
// Blocked zones
// ---------------------------------------------------------------------------

/** The smallest zone worth keeping, in mm. Below this it was a stray click. */
export const MIN_ZONE_MM = 5;

/**
 * A zone from two dragged corners.
 *
 * Normalised so a rectangle dragged right-to-left or bottom-to-top is the same
 * rectangle — a drag has no preferred direction and the document should not
 * remember which way the hand went.
 */
export function zoneFromDrag(
  a: Point,
  b: Point,
  id: string,
  label = 'Blocked zone',
  clearanceMm = 0,
): Obstacle | null {
  const xMm = Math.min(a.x, b.x);
  const yMm = Math.min(a.y, b.y);
  const widthMm = Math.abs(b.x - a.x);
  const heightMm = Math.abs(b.y - a.y);
  if (widthMm < MIN_ZONE_MM || heightMm < MIN_ZONE_MM) return null;
  return { id, label, xMm, yMm, widthMm, heightMm, clearanceMm };
}

/** The eight handles round a zone, for resizing. `0,0` is the lower-left. */
export const ZONE_HANDLES: readonly { hx: -1 | 0 | 1; hy: -1 | 0 | 1 }[] = [
  { hx: -1, hy: -1 }, { hx: 0, hy: -1 }, { hx: 1, hy: -1 },
  { hx: -1, hy: 0 }, { hx: 1, hy: 0 },
  { hx: -1, hy: 1 }, { hx: 0, hy: 1 }, { hx: 1, hy: 1 },
];

export function handlePoint(o: Obstacle, hx: number, hy: number): Point {
  return {
    x: o.xMm + (o.widthMm * (hx + 1)) / 2,
    y: o.yMm + (o.heightMm * (hy + 1)) / 2,
  };
}

/**
 * Drag one handle to a point and get the new rectangle.
 *
 * Kept here rather than in the canvas because it is where the rectangle can go
 * inside out — drag the left edge past the right one — and that has to resolve
 * to a valid rectangle rather than to a negative width the document then stores.
 */
export function resizeZone(o: Obstacle, hx: number, hy: number, to: Point): Obstacle {
  let x1 = o.xMm;
  let x2 = o.xMm + o.widthMm;
  let y1 = o.yMm;
  let y2 = o.yMm + o.heightMm;
  if (hx < 0) x1 = to.x;
  if (hx > 0) x2 = to.x;
  if (hy < 0) y1 = to.y;
  if (hy > 0) y2 = to.y;
  return {
    ...o,
    xMm: Math.min(x1, x2),
    yMm: Math.min(y1, y2),
    widthMm: Math.max(MIN_ZONE_MM, Math.abs(x2 - x1)),
    heightMm: Math.max(MIN_ZONE_MM, Math.abs(y2 - y1)),
  };
}

/**
 * Is this point on the zone itself (not its clearance)?
 *
 * On the SHAPE, not the bounding box. The hollow of an L is inside the box and
 * is not part of the zone — clicking there must fall through to the honeycomb,
 * which is still there and still takes parts.
 */
export function zoneHit(o: Obstacle, p: Point): boolean {
  return zoneParts(o).some(
    (r) => p.x >= r.xMm && p.x <= r.xMm + r.widthMm &&
           p.y >= r.yMm && p.y <= r.yMm + r.heightMm,
  );
}

/**
 * The rectangles a zone is drawn from, WITHOUT clearance.
 *
 * `obstacleRects` is the same list grown by the clearance, which is what the
 * cutter and the border want; the plan wants the zone as measured. One list,
 * two readings, and neither re-derives the other.
 */
export function zoneParts(o: Obstacle): ZoneRect[] {
  return o.shape && o.shape.length > 0
    ? o.shape
    : [{ xMm: o.xMm, yMm: o.yMm, widthMm: o.widthMm, heightMm: o.heightMm }];
}

/**
 * Add a rectangle to a zone, and grow its bounding box to match.
 *
 * The box is what the tag reads and what the resize handles work on, so it has
 * to follow the parts rather than be a stale memory of the first drag.
 */
export function withZonePart(o: Obstacle, part: ZoneRect): Obstacle {
  const shape = [...zoneParts(o), part];
  const minX = Math.min(...shape.map((r) => r.xMm));
  const minY = Math.min(...shape.map((r) => r.yMm));
  const maxX = Math.max(...shape.map((r) => r.xMm + r.widthMm));
  const maxY = Math.max(...shape.map((r) => r.yMm + r.heightMm));
  return {
    ...o, shape,
    xMm: minX, yMm: minY, widthMm: maxX - minX, heightMm: maxY - minY,
  };
}

/**
 * Move a zone by a delta, parts and box together.
 *
 * A zone with a shape cannot be moved by writing x/y alone: the box would move
 * and the rectangles would stay, which is a zone that blocks somewhere it is
 * not drawn.
 */
export function moveZone(o: Obstacle, dx: number, dy: number): Obstacle {
  const moved: Obstacle = { ...o, xMm: o.xMm + dx, yMm: o.yMm + dy };
  if (o.shape && o.shape.length > 0) {
    moved.shape = o.shape.map((r) => ({ ...r, xMm: r.xMm + dx, yMm: r.yMm + dy }));
  }
  return moved;
}

/** Every zone under a point, nearest-drawn last so the caller can take the top. */
export function zonesAt(doc: LayoutDoc, p: Point): Obstacle[] {
  return (doc.obstacles ?? []).filter((o) => zoneHit(o, p));
}

/** The zone plus its clearance, for drawing the ring the honeycomb keeps clear of. */
export const zoneOuterBounds = obstacleBounds;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
