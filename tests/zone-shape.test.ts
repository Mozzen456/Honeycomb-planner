/**
 * A blocked zone that is not a rectangle.
 *
 * A consumer unit with a trunking spur, a pipe with a branch, a boxed-in corner:
 * none of them is one rectangle, and forcing them to be one either blocks
 * honeycomb the user wanted or leaves the thing they were avoiding half
 * uncovered.
 *
 * The shape is a UNION OF RECTANGLES and that is a geometry decision, not a UI
 * one. The border generator clips convex pieces with half-planes and has no
 * polygon boolean anywhere by design (D59); a rectangle hands it four
 * half-planes directly, while a concave polygon cannot be clipped against in
 * one piece at all. So the representation is chosen to keep every clip convex,
 * and these tests hold it to the two things that follow: the honeycomb is cut
 * to the SHAPE, and the border keeps out of the SHAPE.
 */

import { describe, expect, it } from 'vitest';

import { MARGIN_X } from '../src/core/constants';
import { cellsBoundsMm, hexKey, hexToMm, panelCells } from '../src/core/hex';
import { borderPolygons, buildHoneycombMesh, meshIsClosed, NO_FRAME } from '../src/core/honeycomb';
import { cellClashes, obstacleBounds, obstacleRects, obstructedCells } from '../src/core/obstacles';
import { moveZone, withZonePart, zoneHit, zoneParts } from '../src/core/measure';
import { panelModelSpec } from '../src/core/panelModel';
import { deserialize, serialize } from '../src/core/persist';
import { emptyDoc } from '../src/core/store';
import type { Hex, LayoutDoc, Obstacle } from '../src/core/types';

/** An L: a tall arm up the left, a short foot along the bottom. */
const ell = (over: Partial<Obstacle> = {}): Obstacle => ({
  id: 'z1',
  label: 'Consumer unit',
  xMm: 100,
  yMm: 100,
  widthMm: 160,
  heightMm: 160,
  clearanceMm: 0,
  shape: [
    { xMm: 100, yMm: 100, widthMm: 60, heightMm: 160 },
    { xMm: 100, yMm: 100, widthMm: 160, heightMm: 60 },
  ],
  ...over,
});

const plain = (over: Partial<Obstacle> = {}): Obstacle => ({
  id: 'z0', label: 'Light switch', xMm: 100, yMm: 100,
  widthMm: 86, heightMm: 86, clearanceMm: 5, ...over,
});

describe('the shape is one list, read two ways', () => {
  it('a zone with no shape is exactly the rectangle it always was', () => {
    expect(zoneParts(plain())).toEqual([
      { xMm: 100, yMm: 100, widthMm: 86, heightMm: 86 },
    ]);
    expect(obstacleRects(plain({ clearanceMm: 5 }))).toEqual([
      { minX: 95, minY: 95, maxX: 191, maxY: 191 },
    ]);
  });

  it('a shaped zone yields one rectangle per part, each grown by the clearance', () => {
    const rects = obstacleRects(ell({ clearanceMm: 4 }));
    expect(rects).toHaveLength(2);
    expect(rects[0]).toEqual({ minX: 96, minY: 96, maxX: 164, maxY: 264 });
    expect(rects[1]).toEqual({ minX: 96, minY: 96, maxX: 264, maxY: 164 });
  });

  it('the bounding box spans the whole shape, and is NOT what gets blocked', () => {
    // Kept apart on purpose: the box is what the tag reads and what a resize
    // handle grabs. Blocking by it would eat the hollow of the L.
    expect(obstacleBounds(ell())).toEqual({ minX: 100, minY: 100, maxX: 260, maxY: 260 });
    // A point in the hollow — inside the box, outside the shape.
    expect(zoneHit(ell(), { x: 220, y: 220 })).toBe(false);
    expect(zoneHit(ell(), { x: 120, y: 220 })).toBe(true);
    expect(zoneHit(ell(), { x: 220, y: 120 })).toBe(true);
  });
});

describe('the honeycomb is cut to the shape', () => {
  const block = panelCells({ q: 0, r: 0 }, 14, 12);

  it('leaves the hollow of an L uncut', () => {
    const cut = obstructedCells([ell()], block);
    const inHollow = block.filter((c) => {
      const m = hexToMm(c);
      return m.x > 175 && m.x < 245 && m.y > 175 && m.y < 245;
    });
    expect(inHollow.length).toBeGreaterThan(0);
    for (const c of inHollow) expect(cut.has(hexKey(c))).toBe(false);
  });

  it('cuts both arms', () => {
    const cut = obstructedCells([ell()], block);
    const onAnArm = (c: Hex) => {
      const m = hexToMm(c);
      return (m.x > 110 && m.x < 150 && m.y > 110 && m.y < 250) ||
             (m.x > 110 && m.x < 250 && m.y > 110 && m.y < 150);
    };
    const arms = block.filter(onAnArm);
    expect(arms.length).toBeGreaterThan(0);
    for (const c of arms) expect(cut.has(hexKey(c))).toBe(true);
  });

  it('would over-cut if it used the bounding box — which is the point of the shape', () => {
    // Guards the two above from passing on a zone that happens to be square.
    const box = plain({ xMm: 100, yMm: 100, widthMm: 160, heightMm: 160, clearanceMm: 0 });
    const byShape = obstructedCells([ell()], block);
    const byBox = obstructedCells([box], block);
    expect(byBox.size).toBeGreaterThan(byShape.size);
  });

  it('goes through the same cellClashes every rectangular zone does', () => {
    // One cutter. A second path is how `omit` and the parts list drift apart.
    const c = block.find((x) => cellClashes(x, ell()))!;
    expect(obstructedCells([ell()], [c]).has(hexKey(c))).toBe(true);
  });
});

describe('the border keeps out of the shape', () => {
  /** Area of border polygons inside a rectangle, sampled at 0.5 mm. */
  function areaInside(
    polys: readonly { x: number; y: number }[][],
    R: { minX: number; maxX: number; minY: number; maxY: number },
  ): number {
    const step = 0.5;
    const inside = (x: number, y: number) => polys.some((poly) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i]!, b = poly[j]!;
        if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
      }
      return c;
    });
    let hits = 0;
    for (let x = R.minX + step; x < R.maxX; x += step) {
      for (let y = R.minY + step; y < R.maxY; y += step) if (inside(x, y)) hits++;
    }
    return hits * step * step;
  }

  /**
   * A wall of one plate with the zone cut out of it, bordered all round —
   * through `panelModelSpec`, which is the way the app builds one.
   *
   * It matters that this is the real path and not a hand-assembled spec: the
   * cells a zone eats are PRINTED, cut (D81), so the material nearest the
   * aperture belongs to those cells and not to any border piece. Assembled by
   * hand with the eaten cells simply dropped, the arm of an L is empty for the
   * wrong reason and the test has no teeth.
   */
  function walled(zone: Obstacle) {
    const all = panelCells({ q: 0, r: 0 }, 14, 12);
    const cut = obstructedCells([zone], all);
    const panel = {
      id: 'p0', partId: 'x', origin: { q: 0, r: 0 }, columns: 14, rows: 12,
      omit: all.filter((c) => cut.has(hexKey(c))),
    };
    const spec = panelModelSpec(
      panel,
      [panel],
      { left: true, right: true, bottom: true, top: true, holes: true, thicknessMm: 3.6 },
      [zone],
    );
    return { spec, cells: spec.cells, border: spec.border!, cut };
  }

  it('puts nothing inside either arm of an L', () => {
    /*
     * Measured on the MESH, because that is where the plate's material is. It
     * used to be measured on the border polygons, which was right while a hole's
     * edge was the border's job; it is the CUT CELL's now (D83), and the outside
     * of the plate is a cut too (D86), so on a plate like this there are no
     * border polygons left to measure and the old check passed by measuring
     * nothing.
     *
     * The arm of an L is the case the bounding box gets wrong: block by the box
     * and the hollow goes as well, clip by the box and material lands in the
     * arm. Only `obstacleRects` gives the right answer, and this is where it
     * shows.
     */
    const zone = ell();
    const { spec } = walled(zone);
    const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
    expect(spec.clipped.length).toBeGreaterThan(0);
    const p = mesh.positions;
    for (const r of obstacleRects(zone)) {
      let inside = 0;
      for (let i = 0; i < p.length; i += 3) {
        if (
          p[i]! > r.minX + 1e-6 && p[i]! < r.maxX - 1e-6 &&
          p[i + 1]! > r.minY + 1e-6 && p[i + 1]! < r.maxY - 1e-6
        ) inside++;
      }
      expect(inside).toBe(0);
    }
  });

  it('still fills the hollow side of the L, which is honeycomb and not a hole', () => {
    // The inside corner of an L is real wall. Nothing should be cut there and
    // the border has no business closing it off.
    const { cut } = walled(ell());
    const hollow = panelCells({ q: 0, r: 0 }, 14, 12).filter((c) => {
      const m = hexToMm(c);
      return m.x > 185 && m.x < 235 && m.y > 185 && m.y < 235;
    });
    for (const c of hollow) expect(cut.has(hexKey(c))).toBe(false);
  });

  it('a plate cut round an L is still a closed mesh', () => {
    const { spec } = walled(ell());
    const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
    expect(meshIsClosed(mesh).unmatchedEdges).toBe(0);
  });

  it('and so is one cut round a plain rectangle', () => {
    const { spec } = walled(plain({ xMm: 140, yMm: 140 }));
    const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
    expect(meshIsClosed(mesh).unmatchedEdges).toBe(0);
  });

  it('without the zone the same hole is NOT clear — so the check has teeth', () => {
    const zone = ell();
    const { cells } = walled(zone);
    const blind = borderPolygons(cells, {
      thicknessMm: 3.6,
      occupied: new Set(cells.map(hexKey)),
      sides: NO_FRAME,
      holes: true,
      bounds: (() => {
        const b = cellsBoundsMm(cells);
        return { minX: b.minX + MARGIN_X, maxX: b.maxX - MARGIN_X, minY: b.minY, maxY: b.maxY };
      })(),
    });
    const worst = Math.max(...obstacleRects(zone).map((r) => areaInside(blind, r)));
    expect(worst).toBeGreaterThan(100);
  });
});

describe('a shaped zone moves and round-trips', () => {
  it('moves its parts with its box', () => {
    const moved = moveZone(ell(), 10, -5);
    expect(moved.xMm).toBe(110);
    expect(moved.yMm).toBe(95);
    expect(moved.shape![0]).toEqual({ xMm: 110, yMm: 95, widthMm: 60, heightMm: 160 });
    expect(moved.shape![1]).toEqual({ xMm: 110, yMm: 95, widthMm: 160, heightMm: 60 });
  });

  it('adding a part grows the bounding box to match', () => {
    const grown = withZonePart(plain({ clearanceMm: 0 }), {
      xMm: 186, yMm: 100, widthMm: 40, heightMm: 40,
    });
    expect(grown.shape).toHaveLength(2);
    expect(grown.xMm).toBe(100);
    expect(grown.widthMm).toBe(126);
  });

  it('survives save and load', () => {
    const doc: LayoutDoc = { ...emptyDoc(), obstacles: [ell()] };
    const back = deserialize(serialize(doc)).doc!;
    expect(back.obstacles![0]!.shape).toEqual(ell().shape);
  });

  it('a plain zone still serialises with no shape key at all', () => {
    // The absent-key rule: every layout saved before this must round-trip to
    // the bytes it always had.
    const doc: LayoutDoc = { ...emptyDoc(), obstacles: [plain()] };
    const text = serialize(doc);
    expect(text).not.toContain('shape');
    expect(deserialize(text).doc!.obstacles![0]!.shape).toBeUndefined();
  });

  it('drops a junk part rather than the whole zone', () => {
    const doc = JSON.parse(serialize({ ...emptyDoc(), obstacles: [ell()] }));
    doc.obstacles[0].shape.push({ xMm: 'no', yMm: 1, widthMm: 1, heightMm: 1 });
    const res = deserialize(JSON.stringify(doc));
    expect(res.doc!.obstacles![0]!.shape).toHaveLength(2);
    expect(res.errors.join(' ')).toMatch(/shape\[2\]/);
  });
});
