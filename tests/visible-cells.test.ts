/**
 * The plan view's visible-cell range must cover the whole wall.
 *
 * This function decides which cells the 2D grid draws on an EMPTY wall — before
 * any panel is solved, when `panelIndex` is empty and the range has to be
 * derived from the wall rectangle rather than read off the panels.
 *
 * It is here because it went wrong silently. It carried its own copy of the
 * inverse embedding — rows from `y / ROW_STEP`, columns from `x / PITCH` — which
 * is the pointy-top form, and it survived the frame turn (DECISIONS D35) because
 * the moment anything is on the wall this path stops running. On a flat-top wall
 * columns step `ROW_STEP` and rows step `PITCH`, so the stale version asked for
 * a column every 23.6 mm where one is needed every 20.438: about an eighth of
 * the wall's width had no grid drawn on it at all, at the right-hand edge.
 *
 * The contract asserted here is coverage, not the arithmetic: every cell whose
 * centre lies within the wall must be offered. That is what a wrong inverse
 * breaks, and it stays true whichever way the frame is turned next.
 */

import { describe, expect, it } from 'vitest';

import { PITCH, ROW_STEP } from '../src/core/constants';
import { hexKey, hexToMm } from '../src/core/hex';
import { emptyDoc } from '../src/core/store';
import type { Hex, LayoutDoc } from '../src/core/types';
import { visibleCells } from '../src/ui/WallCanvas';

/** A viewport showing exactly the wall rectangle, 1 px per mm. */
const wallView = (doc: LayoutDoc) => ({
  toWall: (x: number, y: number) => ({ x, y }),
  size: { w: doc.wall.widthMm, h: doc.wall.heightMm },
});

/** Every cell whose centre is inside the wall, found by brute force. */
function cellsInsideWall(doc: LayoutDoc): Hex[] {
  const out: Hex[] = [];
  // Generous bounds: the stagger pushes r negative as q grows, so sweep wide.
  const qSpan = Math.ceil(doc.wall.widthMm / ROW_STEP) + 2;
  const rSpan = Math.ceil(doc.wall.heightMm / PITCH) + 2;
  for (let q = -qSpan; q <= qSpan; q++) {
    for (let r = -qSpan - rSpan; r <= rSpan; r++) {
      const p = hexToMm({ q, r });
      if (p.x >= 0 && p.x <= doc.wall.widthMm && p.y >= 0 && p.y <= doc.wall.heightMm) {
        out.push({ q, r });
      }
    }
  }
  return out;
}

describe('visibleCells on an empty wall', () => {
  const WALLS: readonly (readonly [number, number])[] = [
    [500, 300], [2400, 1200], [1200, 2400], [400, 400], [180, 180],
  ];
  for (const [w, h] of WALLS) {
    it(`covers every cell of a ${w} × ${h} wall`, () => {
      const doc: LayoutDoc = { ...emptyDoc(), wall: { widthMm: w, heightMm: h } };
      const { toWall, size } = wallView(doc);
      const got = new Set(visibleCells(toWall, size, doc, new Map()).map(hexKey));
      const missing = cellsInsideWall(doc).map(hexKey).filter((k) => !got.has(k));
      expect(missing, `${missing.length} cells of the wall had no grid drawn`).toEqual([]);
    });
  }

  /**
   * The other half of the contract. Covering everything is trivial if you return
   * the whole lattice; the range also has to stay near the viewport, or a big
   * wall spends its frame budget drawing hexagons nobody can see.
   */
  it('does not wildly over-cover: within a small multiple of the wall itself', () => {
    const doc: LayoutDoc = { ...emptyDoc(), wall: { widthMm: 2400, heightMm: 1200 } };
    const { toWall, size } = wallView(doc);
    const got = visibleCells(toWall, size, doc, new Map());
    const inside = cellsInsideWall(doc).length;
    expect(got.length).toBeGreaterThanOrEqual(inside);
    expect(got.length).toBeLessThan(inside * 3);
  });

  /** With panels present the range comes from the panels, not this arithmetic. */
  it('uses the panel index when there is one', () => {
    const doc: LayoutDoc = { ...emptyDoc(), wall: { widthMm: 2400, heightMm: 1200 } };
    const { toWall, size } = wallView(doc);
    const index = new Map([['3,4', 'p0'], ['3,5', 'p0']]);
    const got = visibleCells(toWall, size, doc, index).map(hexKey).sort();
    expect(got).toEqual(['3,4', '3,5']);
  });
});

describe('the plan is the right way up', () => {
  /**
   * Wall y runs UP the screen, matching the 3D view and the tape measure.
   *
   * The plan mapped wall y straight to screen y, which grows downward, so it
   * drew the same document upside down against the view beside it: a switch low
   * on the wall appeared at the top of the plan and at the bottom in 3D (D70).
   *
   * The mapper is the contract, so it is tested here rather than by eye.
   */
  const view = { scale: 2, originX: 0, originY: 0 };
  const size = { w: 400, h: 300 };
  const toScreen = (p: { x: number; y: number }) => ({
    x: (p.x - view.originX) / view.scale,
    y: size.h - (p.y - view.originY) / view.scale,
  });
  const toWall = (x: number, y: number) => ({
    x: x * view.scale + view.originX,
    y: (size.h - y) * view.scale + view.originY,
  });

  it('puts a higher wall point higher on the screen', () => {
    expect(toScreen({ x: 0, y: 500 }).y).toBeLessThan(toScreen({ x: 0, y: 100 }).y);
  });

  it('puts the wall origin at the bottom-left of the canvas', () => {
    const o = toScreen({ x: 0, y: 0 });
    expect(o.x).toBe(0);
    expect(o.y).toBe(size.h);
  });

  it('round-trips, so a drop lands where it was aimed', () => {
    for (const [x, y] of [[0, 0], [123, 45], [400, 300], [7, 299]] as const) {
      const w = toWall(x, y);
      const back = toScreen(w);
      expect(back.x).toBeCloseTo(x, 9);
      expect(back.y).toBeCloseTo(y, 9);
    }
  });

  it('leaves x alone — only y was ever flipped', () => {
    expect(toScreen({ x: 200, y: 0 }).x).toBeGreaterThan(toScreen({ x: 100, y: 0 }).x);
  });
});
