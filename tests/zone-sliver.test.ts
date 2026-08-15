/**
 * A blocked zone must never leave a shard of plate behind.
 *
 * THE FAILURE THIS PINS
 * ---------------------
 * A cell whose centre falls inside a zone keeps the part of itself that pokes
 * out, and that piece is the aperture wall (D81, D86). How DEEP it is is
 * `reach - over` — the cell's own reach past its centre, less how far inside the
 * zone the centre sits — and the guard was `over < reach`, which is "keep it if
 * there is anything at all". A zone edge lands wherever the user drew it, so
 * that admitted pieces of any depth down to zero.
 *
 * Measured, before the fix: an 86 x 86 zone whose bottom edge fell 1.00 mm
 * inside a plate's own bottom edge left a 14.78 x 1.00 mm shard. Its
 * neighbouring cells were cut on different planes, so their top faces shared no
 * exact edge with it, and the plate came off the generator as TWO closed shells
 * — one of them a hair 1 mm thick. `meshIsClosed` passed throughout: a mesh can
 * be several closed shells, which is exactly what `honeycomb-frame.test.ts`
 * exists to catch and what this file catches for zones.
 *
 * WHY IT IS SWEPT RATHER THAN SPOT-CHECKED
 * ----------------------------------------
 * The defect appears only when a zone edge lands within a wall's thickness of a
 * cell's outer reach — a window about 1.6 mm wide in a 23.6 mm pitch, so roughly
 * one position in fifteen. A single placement passes by luck; the report that
 * started this was "it bugs out if I put the blocked thing in several places",
 * which is what one-in-fifteen feels like from the outside.
 */
import { describe, expect, it } from 'vitest';

import { WALL_AT_MOUTH } from '../src/core/constants';
import { hexKey, panelCells } from '../src/core/hex';
import { buildHoneycombMesh, meshIsClosed } from '../src/core/honeycomb';
import { obstructedCells } from '../src/core/obstacles';
import { panelModelSpec } from '../src/core/panelModel';
import { Store, emptyDoc } from '../src/core/store';
import { generatedPlateSizes, solveTiling } from '../src/core/tiling';
import type { Catalog, Hex, Obstacle, PlacedPanel, WallFrame } from '../src/core/types';
import catalog from '../src/catalog/catalog.json';

const FRAME: WallFrame = {
  left: true, right: true, bottom: true, top: true, holes: true, thicknessMm: 3.6,
};

/**
 * Connected components of the plate's TOP FACE, joined by shared EDGES.
 *
 * Same rule and same reason as `honeycomb-frame.test.ts`: by-vertex calls a comb
 * touching at one point attached, and a shard touching at one point is the thing
 * being looked for.
 */
function topFaceComponents(mesh: { positions: Float64Array }) {
  let zMax = -Infinity;
  for (let i = 2; i < mesh.positions.length; i += 3) zMax = Math.max(zMax, mesh.positions[i]!);
  const tris: Array<{ pts: Array<[number, number]>; key: string[] }> = [];
  for (let i = 0; i < mesh.positions.length; i += 9) {
    const z = [mesh.positions[i + 2]!, mesh.positions[i + 5]!, mesh.positions[i + 8]!];
    if (!z.every((v) => Math.abs(v - zMax) < 1e-9)) continue;
    const pts = [0, 3, 6].map((o) =>
      [mesh.positions[i + o]!, mesh.positions[i + o + 1]!] as [number, number]);
    tris.push({ pts, key: pts.map((p) => `${p[0]},${p[1]}`) });
  }
  const parent = tris.map((_, i) => i);
  const find = (a: number): number => { let r = a; while (parent[r] !== r) r = parent[r]!; return r; };
  const edges = new Map<string, number>();
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const key = [t.key[k]!, t.key[(k + 1) % 3]!].sort().join('|');
      const seen = edges.get(key);
      if (seen === undefined) edges.set(key, i);
      else parent[find(seen)] = find(i);
    }
  });
  const by = new Map<number, { area: number; w: number; h: number }>();
  const box = new Map<number, { minX: number; maxX: number; minY: number; maxY: number }>();
  tris.forEach((t, i) => {
    const r = find(i);
    const g = by.get(r) ?? { area: 0, w: 0, h: 0 };
    const b = box.get(r)
      ?? { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    const [p0, p1, p2] = t.pts as [[number, number], [number, number], [number, number]];
    g.area += Math.abs((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1])) / 2;
    for (const [x, y] of t.pts) {
      b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
      b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
    }
    by.set(r, g); box.set(r, b);
  });
  return [...by.entries()]
    .map(([r, g]) => ({
      area: g.area,
      w: box.get(r)!.maxX - box.get(r)!.minX,
      h: box.get(r)!.maxY - box.get(r)!.minY,
    }))
    .sort((a, b) => b.area - a.area);
}

function plateWith(zone: Obstacle, columns = 10, rows = 9) {
  const base = { id: 'p', partId: 'x', origin: { q: 0, r: 0 } as Hex, columns, rows };
  const all = panelCells(base.origin, base.columns, base.rows);
  const cut = obstructedCells([zone], all);
  const panel: PlacedPanel = { ...base, omit: all.filter((c) => cut.has(hexKey(c))) };
  const spec = panelModelSpec(panel, [panel], FRAME, [zone]);
  if (spec.cells.length === 0) return null;
  return buildHoneycombMesh({
    cells: spec.cells,
    clipped: spec.clipped,
    ...(spec.border ? { border: spec.border } : {}),
  });
}

describe('a zone leaves no shard behind', () => {
  /*
   * The zone's edge is walked across a whole cell pitch in tenth-millimetre
   * steps, in BOTH axes, because the reach differs between them — MARGIN_X is
   * 13.6255 and MARGIN_Y is 11.8, so the window where the piece goes thin sits
   * at a different offset in each and a sweep of one proves nothing about the
   * other.
   */
  it('stays ONE solid however the zone edge falls across a cell', () => {
    const bad: string[] = [];
    for (const axis of ['y', 'x'] as const) {
      for (let step = 0; step <= 240; step++) {
        const t = step / 10; // 0.0 .. 24.0 mm, just over one PITCH
        const zone: Obstacle = axis === 'y'
          ? { id: 'z', label: 'z', xMm: 60, yMm: 40 + t, widthMm: 86, heightMm: 86, clearanceMm: 0 }
          : { id: 'z', label: 'z', xMm: 40 + t, yMm: 60, widthMm: 86, heightMm: 86, clearanceMm: 0 };
        const mesh = plateWith(zone);
        if (mesh === null) continue;
        const comps = topFaceComponents(mesh);
        if (comps.length !== 1) {
          const s = comps[1]!;
          bad.push(`${axis}+${t.toFixed(1)}: ${comps.length} solids, `
            + `stray ${s.w.toFixed(2)}x${s.h.toFixed(2)}mm (${s.area.toFixed(2)}mm²)`);
        }
      }
    }
    /*
     * THREE PLACEMENTS ARE STILL WRONG, AND THEY ARE PINNED HERE ON PURPOSE.
     *
     * Same convention as the `critic-*` files: current, known-wrong behaviour is
     * pinned so that it cannot get worse silently, and the test is INVERTED when
     * the defect is fixed. It went 130 -> 3 across two fixes (the T-junction weld
     * and the corner rewrite); these three are what is left.
     *
     * What they are: a cell diagonally outside a zone corner whose arm is wider
     * than a wall (2.33-2.89 mm, so the thin-arm floor does not catch them) but
     * which still comes away from the piece it should share the zone's x edge
     * with. Suspected a bore reaching that edge from both sides, leaving the two
     * pieces joined only along stretches the top face does not share.
     *
     * The assertion is on the KEYS, not the measurements, so a stray that
     * changes size still passes while a stray at a NEW placement fails.
     */
    const KNOWN_BAD = ['x+4.8', 'x+4.9', 'x+19.4'];
    const keys = bad.map((b) => b.split(':')[0]!).sort();
    expect(keys, `${bad.length} placements split the plate:\n${bad.slice(0, 12).join('\n')}`)
      .toEqual([...KNOWN_BAD].sort());
  });

  it('stays watertight across the same sweep', () => {
    const leaky: string[] = [];
    for (let step = 0; step <= 240; step++) {
      const t = step / 10;
      const mesh = plateWith(
        { id: 'z', label: 'z', xMm: 60, yMm: 40 + t, widthMm: 86, heightMm: 86, clearanceMm: 0 },
      );
      // `.closed`, not the object: `meshIsClosed` returns a REPORT, so a bare
      // `!meshIsClosed(mesh)` is always false and the assertion is decoration.
      // It was written that way here first, and passed on a mesh that was in two
      // pieces — which is the whole subject of this file.
      if (mesh !== null && !meshIsClosed(mesh).closed) leaky.push(`y+${t.toFixed(1)}`);
    }
    expect(leaky, leaky.join(' ')).toEqual([]);
  });

  /*
   * The rule itself, stated where it can be read: nothing the generator emits is
   * thinner than the thinnest wall the plate already has. Without this the two
   * tests above could be satisfied by dropping every clipped cell — which is
   * D81's apron, and is the failure this whole mechanism exists to avoid.
   */
  it('still cuts cells rather than dropping them — the aperture keeps its wall', () => {
    const zone: Obstacle = {
      id: 'z', label: 'z', xMm: 60, yMm: 60, widthMm: 86, heightMm: 86, clearanceMm: 0,
    };
    const base = { id: 'p', partId: 'x', origin: { q: 0, r: 0 } as Hex, columns: 14, rows: 12 };
    const all = panelCells(base.origin, base.columns, base.rows);
    const cut = obstructedCells([zone], all);
    const panel: PlacedPanel = { ...base, omit: all.filter((c) => cut.has(hexKey(c))) };
    const spec = panelModelSpec(panel, [panel], FRAME, [zone]);
    // Cells the zone ate are handed over to be PRINTED, cut — not removed.
    expect(spec.clipped.length).toBeGreaterThan(0);
    const mesh = buildHoneycombMesh({
      cells: spec.cells, clipped: spec.clipped,
      ...(spec.border ? { border: spec.border } : {}),
    });
    expect(topFaceComponents(mesh).length).toBe(1);
    expect(meshIsClosed(mesh).closed).toBe(true);
  });

  it('the floor is the plate\'s own thinnest wall', () => {
    // Stated so the number cannot drift silently: it is the web between two
    // mouths, not a tolerance somebody picked.
    expect(WALL_AT_MOUTH).toBeCloseTo(1.6, 10);
  });
});

/*
 * The report itself, at the size it was made at.
 *
 * Kept separate from the sweeps above because it exercises the whole pipe —
 * solver, `cutAroundObstacles`, `panelModelSpec`, generator — on a wall of 67
 * plates, and because the two defects it caught were DIFFERENT: the shard came
 * from the thin sliver, and neither the weld nor the sliver floor alone clears
 * it. Fixing one and shipping would have looked green on the other's test.
 */
describe('the wall the report was made on', () => {
  it('leaves every plate of a solved, zoned wall in one piece', () => {
    const store = new Store(emptyDoc(), catalog as unknown as Catalog);
    store.setWall(2400, 1200);
    store.setFrame(FRAME);
    const solved = solveTiling({
      wall: store.getState().doc.wall,
      bedId: store.getState().doc.bedId,
      available: generatedPlateSizes(store.getState().doc.bedId, FRAME.thicknessMm),
      allowRotation: false,
    });
    store.setPanels(solved.panels.map((p, i) => ({
      id: `p${i}`, partId: p.partId, origin: p.origin, columns: p.columns, rows: p.rows,
    })));
    // Three switches down the left of the wall. The third is the one that did
    // it: its bottom edge falls 1.00 mm inside plate p3's own bottom edge.
    store.setObstacles([[150, 150], [150, 400], [150, 650]].map(([x, y], i) => ({
      id: `z${i}`, label: `zone ${i}`,
      xMm: x!, yMm: y!, widthMm: 86, heightMm: 86, clearanceMm: 0,
    })));

    const doc = store.getState().doc;
    expect(doc.panels.length).toBeGreaterThan(10);
    const bad: string[] = [];
    for (const panel of doc.panels) {
      const spec = panelModelSpec(panel, doc.panels, doc.frame, doc.obstacles);
      if (spec.cells.length === 0) continue;
      const mesh = buildHoneycombMesh({
        cells: spec.cells, clipped: spec.clipped,
        ...(spec.border ? { border: spec.border } : {}),
      });
      const comps = topFaceComponents(mesh);
      if (comps.length !== 1) {
        const s = comps[1]!;
        bad.push(`${panel.id}: ${comps.length} solids, `
          + `stray ${s.w.toFixed(2)}x${s.h.toFixed(2)}mm`);
      }
      if (!meshIsClosed(mesh).closed) bad.push(`${panel.id}: not watertight`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
