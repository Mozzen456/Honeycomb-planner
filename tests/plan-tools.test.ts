/**
 * The Plan section's two new tools, as pure geometry.
 *
 * Measuring and drawing a blocked zone are both "a point on the wall means
 * something", and both are worth holding to a contract outside a canvas: a
 * snap that latches onto the wrong thing puts a zone half a cell out, and half a
 * cell is the difference between cutting one hexagon and cutting two.
 *
 * The `edgeCorners` case is here because finding it is what prompted the
 * function: the plan view drew every part outline and every panel seam one edge
 * round the hexagon, the same off-by-one already fixed once in `WallView3D`.
 */

import { describe, expect, it } from 'vitest';

import { PITCH, ROW_STEP } from '../src/core/constants';
import { edgeCorners, hexCorners, hexToMm, HEX_DIRECTIONS, type Point } from '../src/core/hex';
import {
  formatMm,
  handlePoint,
  measure,
  MIN_ZONE_MM,
  resizeZone,
  SNAP_RADIUS_MM,
  snapPoint,
  THOUSANDS_SEPARATOR,
  zoneFromDrag,
  zoneHit,
} from '../src/core/measure';
import type { Obstacle } from '../src/core/types';

const zone = (over: Partial<Obstacle> = {}): Obstacle => ({
  id: 'z1', label: 'Light switch', xMm: 100, yMm: 200, widthMm: 86, heightMm: 86,
  clearanceMm: 5, ...over,
});

describe('which corners an edge runs between', () => {
  it('is corners dir and dir+1 — checked against where the neighbour actually is', () => {
    // The edge shared with a neighbour must have its MIDPOINT exactly halfway
    // between the two cell centres. That is the whole test: it cannot be
    // satisfied by an off-by-one, and it needs no hand-written expectation.
    const me = { q: 0, r: 0 };
    const corners = hexCorners(me);
    for (let dir = 0; dir < 6; dir++) {
      const d = HEX_DIRECTIONS[dir]!;
      const mine = hexToMm(me);
      const them = hexToMm({ q: me.q + d.q, r: me.r + d.r });
      const [a, b] = edgeCorners(dir);
      const mid = {
        x: (corners[a]!.x + corners[b]!.x) / 2,
        y: (corners[a]!.y + corners[b]!.y) / 2,
      };
      // Halfway between the two CENTRES — written from both, not from the
      // origin, so it says the same thing wherever the lattice is anchored.
      expect(mid.x, `dir ${dir}`).toBeCloseTo((mine.x + them.x) / 2, 3);
      expect(mid.y, `dir ${dir}`).toBeCloseTo((mine.y + them.y) / 2, 3);
    }
  });

  it('takes any integer, positive or negative', () => {
    expect(edgeCorners(6)).toEqual([0, 1]);
    expect(edgeCorners(-1)).toEqual([5, 0]);
  });
});

describe('snapping', () => {
  const wall = { widthMm: 1000, heightMm: 800 };

  it('latches onto a cell centre when the pointer is near one', () => {
    const cells = [{ q: 2, r: 3 }];
    const centre = hexToMm(cells[0]!);
    const snap = snapPoint({ x: centre.x + 2, y: centre.y - 1 }, { cells, wall });
    expect(snap.kind).toBe('cell');
    expect(snap.x).toBeCloseTo(centre.x, 9);
    expect(snap.y).toBeCloseTo(centre.y, 9);
  });

  it('will not snap to a cell that is not there', () => {
    // A bare wall has cells everywhere arithmetically and nowhere in fact.
    const centre = hexToMm({ q: 2, r: 3 });
    const snap = snapPoint({ x: centre.x + 2, y: centre.y }, { cells: [], wall });
    expect(snap.kind).not.toBe('cell');
  });

  it('latches onto a zone corner', () => {
    const o = zone();
    const snap = snapPoint({ x: o.xMm + 3, y: o.yMm + 2 }, { obstacles: [o], wall });
    expect(snap.kind).toBe('zone');
    expect(snap.x).toBeCloseTo(o.xMm, 9);
    expect(snap.y).toBeCloseTo(o.yMm, 9);
    expect(snap.label).toContain('Light switch');
  });

  it('latches onto a wall corner', () => {
    const snap = snapPoint({ x: 3, y: 4 }, { wall });
    expect(snap.kind).toBe('wall');
    expect(snap.x).toBe(0);
    expect(snap.y).toBe(0);
  });

  it('prefers a cell centre to a zone edge running through it', () => {
    // A tie means the pointer is on a cell that happens to sit under a zone
    // edge, and the cell is the thing you can act on.
    const cell = { q: 4, r: 4 };
    const c = hexToMm(cell);
    const o = zone({ xMm: c.x, yMm: c.y - 50, widthMm: 100, heightMm: 100 });
    const snap = snapPoint({ x: c.x + 1, y: c.y + 1 }, { cells: [cell], obstacles: [o], wall });
    expect(snap.kind).toBe('cell');
  });

  it('gives the point back untouched when nothing is close', () => {
    const snap = snapPoint({ x: 500, y: 400 }, { wall });
    expect(snap.kind).toBe('free');
    expect(snap.x).toBe(500);
    expect(snap.y).toBe(400);
  });

  it('gives the point back untouched when snapping is off', () => {
    // What the modifier key does: sometimes 3 mm off a corner is where you mean.
    const snap = snapPoint({ x: 2, y: 2 }, { wall, enabled: false });
    expect(snap.kind).toBe('free');
    expect(snap.x).toBe(2);
  });

  it('respects the radius rather than snapping across the wall', () => {
    const just = snapPoint({ x: SNAP_RADIUS_MM - 0.5, y: 0 }, { wall });
    const past = snapPoint({ x: SNAP_RADIUS_MM + 0.5, y: 0 }, { wall });
    expect(just.kind).toBe('wall');
    expect(past.kind).toBe('wall'); // still on the bottom EDGE, which is legitimate
    expect(past.x).toBeCloseTo(SNAP_RADIUS_MM + 0.5, 9);
    expect(snapPoint({ x: 500, y: 400 }, { wall }).kind).toBe('free');
  });
});

describe('the measurement', () => {
  const at = (x: number, y: number): Point => ({ x, y });
  const free = (p: Point) => ({ ...p, kind: 'free' as const, label: 'free' });

  it('gives distance, run and rise', () => {
    const m = measure(free(at(0, 0)), free(at(300, 400)));
    expect(m.distanceMm).toBeCloseTo(500, 9);
    expect(m.dxMm).toBe(300);
    expect(m.dyMm).toBe(400);
    expect(m.angleDeg).toBeCloseTo(53.13, 2);
  });

  it('counts lattice steps with the measured constants, not a closed form', () => {
    // 4 columns across and 3 rows up. If this ever reads 3.99996 the caller has
    // gone back to `MARGIN_X · 1.5`, which is ROW_STEP re-derived and 0.0002 out.
    const m = measure(free(at(0, 0)), free(at(4 * ROW_STEP, 3 * PITCH)));
    expect(m.cellsAcross).toBe(4);
    expect(m.cellsUp).toBeCloseTo(3, 9);
  });

  it('is signed, so a measurement taken backwards reads backwards', () => {
    const m = measure(free(at(300, 0)), free(at(0, 0)));
    expect(m.dxMm).toBe(-300);
    expect(m.distanceMm).toBeCloseTo(300, 9);
  });
});

describe('the readout', () => {
  it('groups thousands and drops a pointless decimal', () => {
    // Built from the exported separator, never typed: it is a narrow no-break
    // space, so a hand-typed plain space fails with two strings that look
    // identical in the diff.
    const sep = THOUSANDS_SEPARATOR;
    expect(formatMm(1240)).toBe(`1${sep}240`);
    expect(formatMm(86)).toBe('86');
    expect(formatMm(1240.5)).toBe(`1${sep}240.5`);
    expect(formatMm(-300)).toBe('−300');
  });
});

describe('drawing a blocked zone', () => {
  it('normalises a drag whichever way the hand went', () => {
    const a = zoneFromDrag({ x: 400, y: 300 }, { x: 100, y: 100 }, 'z');
    const b = zoneFromDrag({ x: 100, y: 100 }, { x: 400, y: 300 }, 'z');
    expect(a).toEqual(b);
    expect(a!.xMm).toBe(100);
    expect(a!.yMm).toBe(100);
    expect(a!.widthMm).toBe(300);
    expect(a!.heightMm).toBe(200);
  });

  it('refuses a stray click', () => {
    expect(zoneFromDrag({ x: 100, y: 100 }, { x: 101, y: 180 }, 'z')).toBeNull();
    expect(zoneFromDrag({ x: 100, y: 100 }, { x: 100, y: 100 }, 'z')).toBeNull();
  });

  it('keeps a zone that is only just big enough', () => {
    const z = zoneFromDrag({ x: 0, y: 0 }, { x: MIN_ZONE_MM, y: MIN_ZONE_MM }, 'z');
    expect(z).not.toBeNull();
  });
});

describe('resizing a zone', () => {
  it('moves the edge the handle belongs to and nothing else', () => {
    const o = zone();
    const next = resizeZone(o, -1, 0, { x: 50, y: 999 });
    expect(next.xMm).toBe(50);
    expect(next.widthMm).toBe(136);
    expect(next.yMm).toBe(o.yMm);
    expect(next.heightMm).toBe(o.heightMm);
  });

  it('resolves a rectangle dragged inside out', () => {
    // Drag the left edge past the right one: the answer is a rectangle, not a
    // negative width the document then stores and every consumer trips over.
    const o = zone();
    const next = resizeZone(o, -1, 0, { x: o.xMm + o.widthMm + 40, y: o.yMm });
    expect(next.widthMm).toBe(40);
    expect(next.xMm).toBe(o.xMm + o.widthMm);
  });

  it('never collapses below the minimum', () => {
    const o = zone();
    const next = resizeZone(o, 1, 0, { x: o.xMm, y: o.yMm });
    expect(next.widthMm).toBeGreaterThanOrEqual(MIN_ZONE_MM);
  });

  it('puts its handles on the corners and edge middles', () => {
    const o = zone();
    expect(handlePoint(o, -1, -1)).toEqual({ x: o.xMm, y: o.yMm });
    expect(handlePoint(o, 1, 1)).toEqual({ x: o.xMm + o.widthMm, y: o.yMm + o.heightMm });
    expect(handlePoint(o, 0, -1)).toEqual({ x: o.xMm + o.widthMm / 2, y: o.yMm });
  });
});

describe('hitting a zone', () => {
  it('is the rectangle itself, not its clearance', () => {
    // The clearance ring is advice about where the honeycomb stops; grabbing it
    // would make a zone bigger to click than it is to build.
    const o = zone();
    expect(zoneHit(o, { x: o.xMm + 1, y: o.yMm + 1 })).toBe(true);
    expect(zoneHit(o, { x: o.xMm - 2, y: o.yMm + 1 })).toBe(false);
  });
});
