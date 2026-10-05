/**
 * A blocked zone DRAWN as an outline — a sloping ceiling, a stair (D118).
 *
 * The plate is cut along the drawn line rather than stepped round it, by the
 * same cutter that cuts a rectangle: an outline is handed over as convex pieces
 * with straight edges at any angle, and a rectangle is the special case with
 * four axis-aligned ones. These tests hold the outline to what the rectangle has
 * always been held to — measured on the MESH, never on the polygons meant to
 * produce it — plus the three things that only went wrong once edges could
 * slant: a bore ring starting on a different corner at each level (an open
 * mesh), whole plates set aside under a slope taking their bottom row with them
 * (a notch in the line), and slivers left joined to nothing (loose shards).
 */
import { describe, expect, it } from 'vitest';

import { WALL_AT_MOUTH } from '../src/core/constants';
import { hexToMm, mmToHex } from '../src/core/hex';
import { buildHoneycombMesh, meshBoundsMm, meshIsClosed, type SolidMesh } from '../src/core/honeycomb';
import {
  editZone, moveZone, resizeZone, zoneFromOutline, zoneHit,
} from '../src/core/measure';
import { cellClashes, obstacleRects, obstacleRegions } from '../src/core/obstacles';
import { panelModelSpecFor } from '../src/core/panelModel';
import { deserialize, serialize } from '../src/core/persist';
import { emptyDoc, Store } from '../src/core/store';
import { solveTiling, type PanelSize } from '../src/core/tiling';
import type { Catalog, LayoutDoc, Obstacle, PlacedPanel, WallFrame } from '../src/core/types';
import {
  convexParts, growConvex, edgesOf, normaliseOutline, outlineProblem, pointInOutline,
  signedArea2, simplifyPath, simplifyStroke, type Pt,
} from '../src/core/zonePolygon';

import catalogJson from '../src/catalog/catalog.json';
import SUPAHWALL from './fixtures/supahwall.json';

const catalog = catalogJson as unknown as Catalog;

const FRAME: WallFrame = {
  left: true, right: true, bottom: true, top: true, holes: true, thicknessMm: 3.6,
};

const sizes: PanelSize[] = catalog.parts
  .filter((p) => p.type === 'panel' && p.panel)
  .map((p) => ({
    partId: p.id,
    columns: p.panel!.columns,
    rows: p.panel!.rows,
    widthMm: p.panel!.widthMm,
    heightMm: p.panel!.heightMm,
  }));

const solved = (wall: { widthMm: number; heightMm: number }): PlacedPanel[] =>
  solveTiling({ wall, bedId: 'bed256', available: sizes })
    .panels.map((p, i) => ({ ...p, id: `p${i}` }));

const P = (pts: [number, number][]): Pt[] => pts.map(([x, y]) => ({ x, y }));

const outlineZone = (pts: [number, number][], clearanceMm = 0, id = 'z'): Obstacle => {
  const made = zoneFromOutline(P(pts), id, 'Drawn', clearanceMm);
  if ('problem' in made) throw new Error(made.problem);
  return made.zone;
};

function wallWith(
  wall: { widthMm: number; heightMm: number },
  zones: Obstacle[],
  /**
   * `null` for no border. Not `undefined`: that takes the default, and two
   * "no border" tests here were quietly measuring a bordered wall that way.
   */
  frame: WallFrame | null = FRAME,
): LayoutDoc {
  const store = new Store({ ...emptyDoc(), wall, bedId: 'bed256', panels: solved(wall) }, catalog);
  if (frame) store.setFrame(frame);
  store.setObstacles(zones);
  return store.getState().doc;
}

const plate = (p: PlacedPanel, doc: LayoutDoc): SolidMesh =>
  buildHoneycombMesh({ ...panelModelSpecFor(p, doc), originAtZero: false });

/**
 * Triangles with their centre, or any corner, inside the outline by more than
 * 0.05 mm every way. Corners as well as centres: a sliver of plastic poking
 * into the zone can have its centre outside it.
 */
function plasticInside(mesh: SolidMesh, outline: readonly Pt[]): number {
  const pos = mesh.positions;
  const deep = (x: number, y: number) => [[0.05, 0], [-0.05, 0], [0, 0.05], [0, -0.05]]
    .every(([dx, dy]) => pointInOutline(outline, { x: x + dx!, y: y + dy! }));
  let n = 0;
  for (let i = 0; i < pos.length; i += 9) {
    const x = (pos[i]! + pos[i + 3]! + pos[i + 6]!) / 3;
    const y = (pos[i + 1]! + pos[i + 4]! + pos[i + 7]!) / 3;
    if (deep(x, y) || [0, 3, 6].some((o) => deep(pos[i + o]!, pos[i + o + 1]!))) n++;
  }
  return n;
}

/**
 * Solids, by triangles joined along exact shared edges, with the plastic in
 * each, biggest first.
 *
 * Over the WHOLE WALL rather than one plate: a cut cell can be loose within its
 * own plate and still sit flush against the next plate's whole cell — the top
 * row of a plate a zone has eaten below, which is part of the aperture's wall —
 * and the generator keeps those on purpose. What must not exist is a fleck
 * touching nothing at all. Plates meet along identical snapped corners, so the
 * seam faces share edges exactly and one wall reads as one solid.
 */
function solids(meshes: readonly SolidMesh[]): number[] {
  const all = new Float64Array(meshes.reduce((n, m) => n + m.positions.length, 0));
  let at = 0;
  for (const m of meshes) { all.set(m.positions, at); at += m.positions.length; }
  const pos = all;
  const key = (i: number) => `${pos[i]},${pos[i + 1]},${pos[i + 2]}`;
  const n = pos.length / 9;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  const seen = new Map<string, number>();
  for (let t = 0; t < n; t++) {
    for (let e = 0; e < 3; e++) {
      const a = key(t * 9 + e * 3);
      const b = key(t * 9 + ((e + 1) % 3) * 3);
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      const o = seen.get(k);
      if (o === undefined) seen.set(k, t);
      else parent[find(t)] = find(o);
    }
  }
  const vol = new Map<number, number>();
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const v = (pos[i]! * (pos[i + 4]! * pos[i + 8]! - pos[i + 5]! * pos[i + 7]!) -
      pos[i + 1]! * (pos[i + 3]! * pos[i + 8]! - pos[i + 5]! * pos[i + 6]!) +
      pos[i + 2]! * (pos[i + 3]! * pos[i + 7]! - pos[i + 4]! * pos[i + 6]!)) / 6;
    const r = find(t);
    vol.set(r, (vol.get(r) ?? 0) + v);
  }
  return [...vol.values()].map(Math.abs).sort((a, b) => b - a);
}

/** Where the plate stops below a line, sliced in the mouth band. */
function topAlong(doc: LayoutDoc, xs: readonly number[]): number[] {
  const segs: [number, number, number, number][] = [];
  const z = 1;
  for (const p of doc.panels) {
    const pos = plate(p, doc).positions;
    for (let i = 0; i < pos.length; i += 9) {
      const h: [number, number][] = [];
      for (let e = 0; e < 3; e++) {
        const a = i + e * 3, b = i + ((e + 1) % 3) * 3;
        const az = pos[a + 2]!, bz = pos[b + 2]!;
        if ((az - z) * (bz - z) < 0) {
          const f = (z - az) / (bz - az);
          h.push([pos[a]! + f * (pos[b]! - pos[a]!), pos[a + 1]! + f * (pos[b + 1]! - pos[a + 1]!)]);
        }
      }
      if (h.length === 2) segs.push([h[0]![0], h[0]![1], h[1]![0], h[1]![1]]);
    }
  }
  return xs.map((x) => {
    let top = -Infinity;
    for (const [ax, ay, bx, by] of segs) {
      if ((ax - x) * (bx - x) < 0) top = Math.max(top, ay + ((x - ax) / (bx - ax)) * (by - ay));
    }
    return top;
  });
}

// ---------------------------------------------------------------------------

describe('the outline itself', () => {
  it('is stored counter-clockwise, without repeats or straight-through corners', () => {
    const pts = normaliseOutline(P([[0, 0], [0, 100], [0, 100], [50, 100], [100, 100], [100, 0], [0, 0]]));
    expect(signedArea2(pts)).toBeGreaterThan(0);
    expect(pts).toHaveLength(4);
  });

  it('refuses a shape it cannot cut, in words', () => {
    expect(outlineProblem(P([[0, 0], [100, 0]]))).toMatch(/three corners/);
    expect(outlineProblem(P([[0, 0], [5, 0], [0, 5]]))).toMatch(/too small/);
    // A bow tie: its two halves cross.
    expect(outlineProblem(P([[0, 0], [100, 100], [100, 0], [0, 100]]))).toMatch(/crosses itself/);
    expect(outlineProblem(P([[0, 0], [300, 0], [300, 200], [0, 120]]))).toBeNull();
  });

  it('comes apart into convex pieces that cover it exactly', () => {
    const roof = P([[0, 700], [2400, 1150], [2400, 1300], [0, 1300]]);
    expect(convexParts(roof)).toHaveLength(1);

    const ell = P([[0, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]]);
    const parts = convexParts(ell);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    const area = parts.reduce((s, p) => s + signedArea2(p.points) / 2, 0);
    expect(area).toBeCloseTo(signedArea2(normaliseOutline(ell)) / 2, 6);
    for (const p of parts) {
      for (let i = 0; i < p.points.length; i++) {
        const a = p.points[i]!, b = p.points[(i + 1) % p.points.length]!, c = p.points[(i + 2) % p.points.length]!;
        expect((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)).toBeGreaterThanOrEqual(-1e-9);
      }
      // Every piece has at least one diagonal it shares with another.
      expect(p.internal.some(Boolean)).toBe(true);
    }
  });

  it('grows by its clearance with a cap on a sharp tip, and none on a square corner', () => {
    const tip = P([[0, 0], [200, 30], [0, 60]]);
    const grown = growConvex(edgesOf(tip), tip, 5);
    // The tip at (200, 30) is pushed out by 5 along its bisector — not by the
    // 5 / sin(8.5°) ≈ 34 mm of a mitre.
    const reach = Math.max(...grown.map((e) => (e.nx * 200 + e.ny * 30) - e.d));
    expect(reach).toBeCloseTo(-5, 6);
    const square = P([[0, 0], [100, 0], [100, 100], [0, 100]]);
    expect(growConvex(edgesOf(square), square, 5)).toHaveLength(4);
  });

  it('reduces a hand-drawn trail to its corners', () => {
    const ring: Pt[] = [];
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * Math.PI * 2;
      ring.push({ x: 500 + 200 * Math.cos(a), y: 400 + 120 * Math.sin(a) });
    }
    const lasso = simplifyStroke(ring, 3);
    expect(lasso.length).toBeGreaterThan(8);
    expect(lasso.length).toBeLessThan(40);
    expect(outlineProblem(lasso)).toBeNull();
    const line = simplifyPath(P([[0, 0], [10, 0.1], [20, -0.1], [30, 0]]), 1);
    expect(line).toEqual(P([[0, 0], [30, 0]]));
  });
});

describe('an outline zone on the plan', () => {
  const roof = outlineZone([[0, 700], [2400, 1150], [2400, 1300], [0, 1300]]);

  it('is hit on its shape, not its box', () => {
    expect(zoneHit(roof, { x: 100, y: 1250 })).toBe(true);
    // Inside the box, below the slope.
    expect(zoneHit(roof, { x: 2000, y: 800 })).toBe(false);
  });

  it('moves, resizes and takes a typed size with its outline, not just its box', () => {
    const moved = moveZone(roof, 10, -20);
    expect(moved.outline![0]).toEqual({ xMm: roof.outline![0]!.xMm + 10, yMm: roof.outline![0]!.yMm - 20 });

    const halfWide = resizeZone(roof, 1, 0, { x: 1200, y: 0 });
    expect(Math.max(...halfWide.outline!.map((p) => p.xMm))).toBeCloseTo(1200, 6);
    expect(zoneHit(halfWide, { x: 1800, y: 1250 })).toBe(false);

    const typed = editZone(roof, { heightMm: 300 });
    expect(Math.min(...typed.outline!.map((p) => p.yMm))).toBeCloseTo(roof.yMm, 6);
    expect(Math.max(...typed.outline!.map((p) => p.yMm))).toBeCloseTo(roof.yMm + 300, 6);
    // A rename touches neither.
    expect(editZone(roof, { label: 'Eaves' }).outline).toBe(roof.outline);
  });

  it('also stretches an L with its box — the shape used to stay where it was', () => {
    const ell: Obstacle = {
      id: 'l', label: 'L', xMm: 100, yMm: 100, widthMm: 160, heightMm: 160, clearanceMm: 0,
      shape: [
        { xMm: 100, yMm: 100, widthMm: 60, heightMm: 160 },
        { xMm: 100, yMm: 100, widthMm: 160, heightMm: 60 },
      ],
    };
    const wide = editZone(ell, { widthMm: 320 });
    expect(Math.max(...wide.shape!.map((r) => r.xMm + r.widthMm))).toBeCloseTo(420, 6);
  });

  it('blocks a cell only where it overlaps the HEXAGON', () => {
    const c = { q: 10, r: 10 };
    const m = hexToMm(c);
    // A zone whose corner pokes into the empty corner of a cell's box without
    // reaching the cell: a rectangle's box test would cut it, an outline must
    // not. The box's upper-right corner is (13.6, 11.8) from the centre; the
    // hexagon's edge there runs from (13.6, 0) to (6.8, 11.8), so (12.5, 10) is
    // in the box and 4 mm outside the hexagon.
    const graze = outlineZone([
      [m.x + 12.5, m.y + 10], [m.x + 300, m.y + 10], [m.x + 300, m.y + 300], [m.x + 12.5, m.y + 300],
    ]);
    expect(cellClashes(c, graze)).toBe(false);
    expect(cellClashes(mmToHex({ x: m.x + 40, y: m.y + 40 }), graze)).toBe(true);
  });

  it('gives a rectangle zone exactly the rectangles it always had', () => {
    const rect: Obstacle = { id: 'r', label: 'r', xMm: 10, yMm: 20, widthMm: 30, heightMm: 40, clearanceMm: 5 };
    expect(obstacleRegions(rect)).toEqual(obstacleRects(rect));
    expect(obstacleRegions(rect)[0]!.edges).toBeUndefined();
  });
});

describe('an outline zone in a saved layout', () => {
  const roof = outlineZone([[0, 700], [2400, 1150], [2400, 1300], [0, 1300]], 4);

  it('round-trips, and its box follows the outline', () => {
    const doc = { ...emptyDoc(), obstacles: [roof] };
    const back = deserialize(serialize(doc));
    expect(back.errors).toEqual([]);
    expect(back.doc!.obstacles![0]!.outline).toEqual(roof.outline);
    expect(back.doc!.obstacles![0]!.widthMm).toBe(2400);
  });

  it('a self-crossing outline is refused on load and the zone keeps its box', () => {
    const doc = JSON.parse(serialize({ ...emptyDoc(), obstacles: [roof] }));
    doc.obstacles[0].outline = [
      { xMm: 0, yMm: 0 }, { xMm: 100, yMm: 100 }, { xMm: 100, yMm: 0 }, { xMm: 0, yMm: 100 },
    ];
    const back = deserialize(JSON.stringify(doc));
    expect(back.errors.join(' ')).toMatch(/outline was dropped/);
    const z = back.doc!.obstacles![0]!;
    expect(z.outline).toBeUndefined();
    expect([z.xMm, z.yMm, z.widthMm, z.heightMm]).toEqual([roof.xMm, roof.yMm, roof.widthMm, roof.heightMm]);
  });
});

describe('a wall under a sloping roof', () => {
  const WALL = { widthMm: 2400, heightMm: 1200 };
  const line = (x: number) => 700 + (450 * x) / 2400;
  const roofPts: [number, number][] = [[0, 700], [2400, 1150], [2400, 1300], [0, 1300]];
  const doc = wallWith(WALL, [outlineZone(roofPts)]);
  const roof = P(roofPts);

  it('every plate is closed and has no plastic above the line, and nothing is loose', () => {
    const wrong: string[] = [];
    const meshes = doc.panels.map((p) => plate(p, doc));
    doc.panels.forEach((p, i) => {
      const open = meshIsClosed(meshes[i]!).unmatchedEdges;
      const inside = plasticInside(meshes[i]!, roof);
      if (open || inside) wrong.push(`${p.id}: open ${open}, inside ${inside}`);
    });
    expect(wrong).toEqual([]);
    expect(solids(meshes).slice(1).filter((v) => v < 1500)).toEqual([]);
  });

  it('the plate runs right up to the line along its whole length', () => {
    // Every half millimetre across the wall, clear of its two ends.
    const xs: number[] = [];
    for (let x = 20.123; x < WALL.widthMm - 20; x += 0.5) xs.push(x);
    const tops = topAlong(doc, xs);
    let worst = 0;
    let over = 0;
    tops.forEach((top, i) => {
      worst = Math.max(worst, line(xs[i]!) - top);
      over = Math.max(over, top - line(xs[i]!));
    });
    // Nothing past the line, and never short of it by more than the thinnest
    // plate worth printing — a cut cell keeping less than one wall is dropped,
    // by the same rule as at a rectangle. Before stranded cells were adopted
    // (D119) a set-aside plate's bottom row left notches up to 14.6 mm deep.
    expect(over).toBeLessThan(1e-6);
    expect(worst).toBeLessThanOrEqual(WALL_AT_MOUTH + 1e-6);
  });

  it('does not cut the wall at all without a border, and steps whole cells instead', () => {
    const plain = wallWith(WALL, [outlineZone(roofPts)], null);
    for (const p of plain.panels) {
      expect(plasticInside(plate(p, plain), roof)).toBe(0);
    }
  });
});

describe('drawn outlines anywhere, on a bordered wall', () => {
  const WALL = { widthMm: 1300, heightMm: 900 };

  /*
   * The corner of a seven-sided outline where two slanted edges meet at a cell
   * whose bore rings start on different corners at different depths. Before the
   * rings were lined up the inner skin was built joining each corner to its
   * neighbour's partner, and the plate had 8 unmatched edges.
   */
  it('stays watertight where two slanted edges meet inside a cell', () => {
    const doc = wallWith(WALL, [outlineZone([
      [307.09, 304.08], [261.65, 344.9], [155.8, 368.21], [84.34, 281.23],
      [101.19, 196.47], [208.47, 158.62], [275.26, 171.19],
    ], 1)], { ...FRAME, thicknessMm: 3.203 });
    for (const p of doc.panels) expect(meshIsClosed(plate(p, doc)).unmatchedEdges, p.id).toBe(0);
  });

  /*
   * Two outlines found by sweeping, each leaving a fleck of plastic (25 and 28
   * mm³) joined to nothing — not to its own plate, not to the next. A slicer
   * prints that as a loose bit. The generator now checks the plate as a whole
   * and drops a piece that small and that alone.
   */
  it('leaves no fleck of plastic touching nothing', () => {
    const cases: { pts: [number, number][]; clearance: number; t: number }[] = [
      {
        pts: [[721.568, 674.2], [650.24, 711.893], [581.884, 764.936], [556.827, 707.652],
          [520.001, 657.832], [587.852, 621.593], [647.231, 588.079], [662.988, 644.107]],
        clearance: 5, t: 3.2323067966999055,
      },
      {
        pts: [[1242.173, 632.125], [885.655, 724.996], [573.857, 704.387], [733.566, 329.32],
          [1033.619, 191.632]],
        clearance: 0, t: 3.8221067422172554,
      },
    ];
    for (const { pts, clearance, t } of cases) {
      const doc = wallWith(WALL, [outlineZone(pts, clearance)], { ...FRAME, thicknessMm: t });
      const loose = solids(doc.panels.map((p) => plate(p, doc))).slice(1).filter((v) => v < 1500);
      expect(loose).toEqual([]);
    }
  });

  it('closed, clear of the zone and free of loose shards over a seeded sweep', () => {
    let seed = 9;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const wrong: string[] = [];
    let plates = 0;
    for (let t = 0; t < 10; t++) {
      // A star-shaped outline, every other corner pulled in for a concave one.
      const cx = 200 + rnd() * 900, cy = 150 + rnd() * 600, k = 3 + Math.floor(rnd() * 6);
      const R = 80 + rnd() * 300, concave = rnd() < 0.5;
      const pts: [number, number][] = Array.from({ length: k }, (_, i) => {
        const a = (i / k) * Math.PI * 2 + rnd() * 0.4;
        const r = R * (concave && i % 2 ? 0.45 + rnd() * 0.3 : 0.85 + rnd() * 0.3);
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      });
      const thickness = 2 + rnd() * 2;
      const clearance = rnd() < 0.5 ? 0 : Math.round(rnd() * 8);
      const zone = outlineZone(pts, clearance);
      const doc = wallWith(WALL, [zone], { ...FRAME, thicknessMm: thickness });
      const outline = zone.outline!.map((p) => ({ x: p.xMm, y: p.yMm }));
      const meshes = doc.panels.map((p) => plate(p, doc));
      doc.panels.forEach((p, i) => {
        plates++;
        const open = meshIsClosed(meshes[i]!).unmatchedEdges;
        const inside = plasticInside(meshes[i]!, outline);
        if (open || inside) wrong.push(`t=${t} ${p.id}: open ${open}, inside ${inside}`);
      });
      // A shard is a solid with under ~two cells of plastic, touching nothing.
      const loose = solids(meshes).slice(1).filter((v) => v < 1500);
      if (loose.length) wrong.push(`t=${t}: shards ${loose.map(Math.round)}`);
    }
    expect(plates).toBeGreaterThan(150);
    expect(wrong).toEqual([]);
  });
});

describe('what a plate file carries', () => {
  /**
   * The solids in ONE plate's file, biggest first. A second small one is a
   * fleck that prints loose, whatever it sits against on the wall.
   */
  const fileParts = (mesh: SolidMesh) => solids([mesh]);

  /*
   * A cut cell loose in its own plate but flush against the next plate's whole
   * cell — the top row of a plate a zone ate from below, the arm of a cell at a
   * concave corner — is printed BY the next plate, where it is joined on
   * (D120). Before that, the 3-zone fixture's plates carried such flecks in
   * their files, and the concave outline below left a 438 mm³ one.
   */
  it('has no loose fleck on the 3-zone wall or at a concave corner', () => {
    const concave = wallWith({ widthMm: 2400, heightMm: 1200 }, [outlineZone([
      [1112.199, 760.363], [798.623, 936.987], [517.002, 1174.443], [385.351, 880.251],
      [207.899, 647.53], [515.505, 493.228], [728.745, 251.492], [810.126, 573.506],
    ])], { ...FRAME, thicknessMm: 3.6516 });
    const fixture = deserialize(JSON.stringify(SUPAHWALL)).doc!;
    for (const doc of [concave, fixture]) {
      const loose = doc.panels.flatMap((p) =>
        fileParts(plate(p, doc)).slice(1).filter((v) => v < 1500).map((v) => `${p.id}: ${Math.round(v)}`));
      expect(loose).toEqual([]);
    }
  });

  /*
   * Taking cells from another plate — stranded (D119) or held (D120) — must
   * never make a plate the printer cannot print. On a 3000 × 2000 wall of
   * shipped plates under a long roof, the first version grew one 211 × 248
   * plate to 211 × 259.6 on a 256 bed.
   */
  it('never grows a plate past the printer bed', () => {
    const doc = wallWith({ widthMm: 3000, heightMm: 2000 },
      [outlineZone([[-50, 885], [3050, 1815], [3050, 2200], [-50, 2200]])]);
    const big: string[] = [];
    for (const p of doc.panels) {
      const s = meshBoundsMm(plate(p, doc)).size;
      const [w, h] = [Math.max(s[0]!, s[1]!), Math.min(s[0]!, s[1]!)];
      if (w > 256 + 1e-6 || h > 256 + 1e-6) big.push(`${p.id}: ${w.toFixed(1)} × ${h.toFixed(1)}`);
    }
    expect(big).toEqual([]);
  });

  /*
   * With no border a zone does not cut a plate — it takes cells out whole — and
   * can leave a plate as a few separate cells. Each is a real cell the planner
   * offers for mounting, and each is under the shard size, so the first shard
   * rule printed one of them and dropped the rest: 903 mm³ of a 4513 mm³ plate
   * (found by the independent check). A group with a whole cell in it is never
   * a shard. Measured as solids per file against groups of planner cells.
   */
  it('prints every cell of a plate a zone breaks into pieces', () => {
    const doc = wallWith({ widthMm: 1600, heightMm: 900 }, [{
      id: 'z', label: 'z', xMm: 242.77, yMm: 278.06, widthMm: 882.35, heightMm: 718.47, clearanceMm: 0,
    }], null);
    const groupsOf = (cells: readonly { q: number; r: number }[]) => {
      const left = new Set(cells.map((c) => `${c.q},${c.r}`));
      let n = 0;
      for (const start of [...left]) {
        if (!left.has(start)) continue;
        n++;
        const stack = [start];
        left.delete(start);
        while (stack.length) {
          const [q, r] = stack.pop()!.split(',').map(Number) as [number, number];
          for (const [dq, dr] of [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]) {
            const k = `${q + dq!},${r + dr!}`;
            if (left.delete(k)) stack.push(k);
          }
        }
      }
      return n;
    };
    let broken = 0;
    const short: string[] = [];
    for (const p of doc.panels) {
      const spec = panelModelSpecFor(p, doc);
      const groups = groupsOf(spec.cells);
      if (groups > 1) broken++;
      const pieces = solids([plate(p, doc)]).length;
      if (pieces < groups) short.push(`${p.id}: ${pieces} solids for ${groups} groups of cells`);
    }
    // The fixture has to be able to fail: some plate really is in pieces.
    expect(broken).toBeGreaterThan(0);
    expect(short).toEqual([]);
  });
});
