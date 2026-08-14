/**
 * The inside edge of a blocked zone, held to the printed plate.
 *
 * `inner box.jpeg` is a plate with a light switch through it: the aperture is a
 * straight rectangle closed by a THIN, EVEN wall, and the open cells run right
 * up to that wall — the cut goes through them, leaving partial hexagons.
 *
 * We used to remove any cell a zone touched and fill the gap with border, which
 * gave a straight aperture with an apron up to a WHOLE CELL deep behind it,
 * hexagons paved over and showing through as bumps. Straight, and nothing like
 * the photograph.
 *
 * Cells the zone eats are now printed CLIPPED (D81). The planner still treats
 * them as gone — a cell a switch passes through is not somewhere to mount
 * anything — so this is the planner-versus-printer split (D56) doing the job it
 * exists for. These are the properties that has to keep.
 *
 * The wall itself is the cut cell's, not the border's (D83): the outline is cut
 * at the zone and the bores a rail further out, which is the only arrangement in
 * which one piece of geometry owns that edge. It is measured here on the mesh —
 * a slice through the plate and a scanline across it — because every proxy for
 * it let the wall be 0.00 mm somewhere while the tests stayed green.
 */

import { describe, expect, it } from 'vitest';

import { hexKey, hexToMm, panelCells } from '../src/core/hex';
import { buildHoneycombMesh, meshIsClosed } from '../src/core/honeycomb';
import { obstructedCells } from '../src/core/obstacles';
import { panelModelSpec } from '../src/core/panelModel';
import type { Hex, Obstacle, PlacedPanel, WallFrame } from '../src/core/types';

const FRAME: WallFrame = {
  left: true, right: true, bottom: true, top: true, holes: true, thicknessMm: 3.6,
};

const ZONE: Obstacle = {
  id: 'z', label: 'Light switch', xMm: 88, yMm: 105,
  widthMm: 86, heightMm: 120, clearanceMm: 0,
};

function plate(zone: Obstacle = ZONE) {
  // Big enough that the switch is surrounded by honeycomb on all four sides:
  // a zone running off the top of the plate has no aperture wall there to
  // measure, and the measurements below are the point of this file.
  const base = { id: 'p0', partId: 'x', origin: { q: 0, r: 0 }, columns: 16, rows: 14 };
  const all = panelCells(base.origin, base.columns, base.rows);
  const cut = obstructedCells([zone], all);
  const panel: PlacedPanel = { ...base, omit: all.filter((c) => cut.has(hexKey(c))) };
  return { panel, spec: panelModelSpec(panel, [panel], FRAME, [zone]), all };
}

describe('the cells a zone eats are printed, cut', () => {
  it('hands the generator the eaten cells separately from the kept ones', () => {
    const { spec, all } = plate();
    expect(spec.clipped.length).toBeGreaterThan(0);
    // The two together are the whole block, and neither overlaps the other.
    expect(spec.cells.length + spec.clipped.length).toBe(all.length);
    const kept = new Set(spec.cells.map(hexKey));
    for (const c of spec.clipped) expect(kept.has(hexKey(c))).toBe(false);
  });

  it('leaves the PLANNER seeing exactly what it saw before', () => {
    // The whole point of the split: a half cell must never be offered as
    // somewhere to mount something, so `cells` — which the parts list, the file
    // name and the fixing plan all count — is untouched.
    const { panel, spec } = plate();
    expect(spec.cells.length).toBe(
      panelCells(panel.origin, panel.columns, panel.rows).length - (panel.omit?.length ?? 0),
    );
  });

  it('is still a closed, orientable mesh', () => {
    // The outline cut is a function of the ZONE alone, so two clipped
    // neighbours truncate identically along the edge they share and it still
    // cancels. Their bores are cut a rail further out and are private to a cell,
    // so they can differ without touching that.
    const { spec } = plate();
    const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
    expect(meshIsClosed(mesh).unmatchedEdges).toBe(0);
  });

  it('puts no material inside the aperture', () => {
    // Checked on the MESH, not on the border polygons: the clipped cells are
    // plate too now, and they are the ones nearest the switch.
    const { spec } = plate();
    const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
    const p = mesh.positions;
    let inside = 0;
    for (let i = 0; i < p.length; i += 3) {
      if (
        p[i]! > ZONE.xMm + 1e-6 && p[i]! < ZONE.xMm + ZONE.widthMm - 1e-6 &&
        p[i + 1]! > ZONE.yMm + 1e-6 && p[i + 1]! < ZONE.yMm + ZONE.heightMm - 1e-6
      ) inside++;
    }
    expect(inside).toBe(0);
  });

  /*
   * The aperture, measured on the PLATE rather than argued about.
   *
   * The mesh is a prism, so a horizontal slice through it is the plate's own
   * cross-section: cut every triangle at one height, and a scanline across the
   * segments gives the solid runs exactly, edges and all. That is the only way
   * to state "the wall round the switch is 3.6 mm" as a number — every proxy for
   * it (border polygons, cell centres, bounding boxes) was what let the wall be
   * 0.00 mm in places while the tests stayed green.
   */
  interface Seg { ax: number; ay: number; bx: number; by: number }

  function sliceAt(positions: ArrayLike<number>, z: number): Seg[] {
    const segs: Seg[] = [];
    for (let i = 0; i < positions.length; i += 9) {
      const v = [0, 3, 6].map((o) => ({
        x: positions[i + o]!, y: positions[i + o + 1]!, z: positions[i + o + 2]!,
      }));
      const hits: { x: number; y: number }[] = [];
      for (let e = 0; e < 3; e++) {
        const a = v[e]!, b = v[(e + 1) % 3]!;
        if ((a.z - z) * (b.z - z) < 0) {
          const f = (z - a.z) / (b.z - a.z);
          hits.push({ x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) });
        }
      }
      if (hits.length === 2) {
        segs.push({ ax: hits[0]!.x, ay: hits[0]!.y, bx: hits[1]!.x, by: hits[1]!.y });
      }
    }
    return segs;
  }

  /** Solid runs where the line `along = at` crosses the section. */
  function runs(segs: readonly Seg[], axis: 'x' | 'y', at: number): [number, number][] {
    const hits: number[] = [];
    for (const s of segs) {
      const [a0, b0, a1, b1] = axis === 'x'
        ? [s.ay, s.by, s.ax, s.bx]
        : [s.ax, s.bx, s.ay, s.by];
      if ((a0 - at) * (b0 - at) < 0) hits.push(a1 + ((at - a0) / (b0 - a0)) * (b1 - a1));
    }
    hits.sort((a, b) => a - b);
    const out: [number, number][] = [];
    for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i]!, hits[i + 1]!]);
    return out;
  }

  /**
   * Every side of the aperture, as (where the plate stops, how thick the wall
   * is there) pairs. `sign` is which way the material lies from the zone.
   *
   * Sampled off the lattice's own multiples on purpose: a scanline landing
   * exactly on a hexagon's flat is degenerate for even-odd counting and reports
   * a hole where the plate is solid.
   */
  function apertureWall(positions: ArrayLike<number>, zone: Obstacle, z: number) {
    const segs = sliceAt(positions, z);
    const x0 = zone.xMm, x1 = zone.xMm + zone.widthMm;
    const y0 = zone.yMm, y1 = zone.yMm + zone.heightMm;
    const sides: Record<string, { edge: number; wall: number }[]> = {
      left: [], right: [], bottom: [], top: [],
    };
    for (let y = y0 + 0.37; y < y1; y += 0.37) {
      const iv = runs(segs, 'x', y);
      const l = iv.filter((s) => s[1] <= x0 + 1e-6).pop();
      const r = iv.find((s) => s[0] >= x1 - 1e-6);
      if (l) sides.left!.push({ edge: l[1], wall: l[1] - l[0] });
      if (r) sides.right!.push({ edge: r[0], wall: r[1] - r[0] });
    }
    for (let x = x0 + 0.37; x < x1; x += 0.37) {
      const iv = runs(segs, 'y', x);
      const b = iv.filter((s) => s[1] <= y0 + 1e-6).pop();
      const t = iv.find((s) => s[0] >= y1 - 1e-6);
      if (b) sides.bottom!.push({ edge: b[1], wall: b[1] - b[0] });
      if (t) sides.top!.push({ edge: t[0], wall: t[1] - t[0] });
    }
    return { sides, want: { left: x0, right: x1, bottom: y0, top: y1 } };
  }

  it('opens the aperture on the zone rectangle exactly, on all four sides', () => {
    /*
     * A straight line per side, wherever the lattice happens to fall against
     * the switch. Cut at `zone + t` instead — the previous rule — the aperture
     * came out 3.6 mm oversize on a good side and, where a cell whose centre
     * landed inside the zone was dropped whole, 6.2 mm on one side of this
     * switch and 10.0 mm on the other.
     */
    const { spec } = plate();
    const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
    const { sides, want } = apertureWall(mesh.positions, ZONE, 0.2);
    for (const side of ['left', 'right', 'bottom', 'top'] as const) {
      expect(sides[side]!.length).toBeGreaterThan(100);
      for (const { edge } of sides[side]!) expect(edge).toBeCloseTo(want[side], 6);
    }
  });

  it('walls it with a rail of exactly the border thickness, never less', () => {
    /*
     * The property the photograph shows, and the one this file exists for: the
     * wall round the switch is the same thickness as the wall round the plate.
     *
     * `t` is a floor, not an equality. The outline is cut at the zone and the
     * BORES `t` further out, so the wall is exactly `t` wherever the cut passes
     * through a bore — which is most of the way round — and thicker where it
     * happens to fall in the web between two of them. Thicker is material that
     * was always there; thinner would be a bore opened onto the aperture, which
     * is what a single cut line at the zone produced: measured 0.00 mm.
     */
    const { spec } = plate();
    const t = FRAME.thicknessMm;
    const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
    const { sides } = apertureWall(mesh.positions, ZONE, 0.2);
    for (const side of ['left', 'right', 'bottom', 'top'] as const) {
      const walls = sides[side]!.map((s) => s.wall);
      expect(Math.min(...walls)).toBeGreaterThanOrEqual(t - 1e-6);
    }
    // ...and it really is a rail somewhere, not a slab everywhere: at least one
    // side comes out at `t` on the nose.
    const thinnest = Math.min(
      ...(['left', 'right', 'bottom', 'top'] as const)
        .flatMap((s) => sides[s]!.map((v) => v.wall)),
    );
    expect(thinnest).toBeCloseTo(t, 6);
  });

  it('leaves the honeycomb round the aperture HOLLOW, not paved over', () => {
    /*
     * The apron, one last time. D81 removed it by printing the eaten cells cut
     * instead of dropping them, and then put a band of it back through its own
     * guard: a cell whose bore the cut passed the centre of printed SOLID, and
     * every cell whose centre fell inside the zone's rail is such a cell. The
     * result was a ring of filled hexagons round the switch where the printed
     * reference has open ones running right up to the wall.
     *
     * Stated as: most of the way along each side of the aperture, the plate
     * stops within a rail and a cell wall of it. Paved, the wall runs out to
     * whole cells and this collapses — with the guard put back, the right-hand
     * side measures ZERO scanlines that thin.
     */
    const { spec } = plate();
    const t = FRAME.thicknessMm;
    const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
    const { sides } = apertureWall(mesh.positions, ZONE, 0.2);
    for (const side of ['left', 'right', 'bottom', 'top'] as const) {
      const walls = sides[side]!.map((s) => s.wall);
      const thin = walls.filter((w) => w <= t + 1.6).length / walls.length;
      expect(thin, `${side}`).toBeGreaterThan(0.4);
    }
  });

  it('is the same rail the OUTSIDE of the plate gets', () => {
    /*
     * Stated as a comparison rather than a second copy of 3.6, because that is
     * the request: the same border thickness inside as outside. Both are read
     * off the same slice of the same plate.
     *
     * Measured on the TOP and BOTTOM, where the border is a free-standing rail
     * (D69) and a scanline crossing it therefore measures the rail and nothing
     * else. The left and right edges are FILLED to the honeycomb instead (D84) —
     * a column of flat-top cells reaches its straight outer line at one point
     * per cell, so a rail there would hang off the plate at a chain of points —
     * and the band beyond the envelope is still exactly `t`, but a scanline
     * across it also crosses the scallops behind it and cannot tell the two
     * apart. `tests/honeycomb-frame.test.ts` measures the sides as a bounding
     * box instead, which is the shape that question has an answer in.
     */
    const { spec } = plate();
    const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
    const segs = sliceAt(mesh.positions, 0.2);
    let minX = Infinity, maxX = -Infinity;
    for (const s of segs) {
      minX = Math.min(minX, s.ax, s.bx);
      maxX = Math.max(maxX, s.ax, s.bx);
    }
    const outer: number[] = [];
    for (let x = minX + (maxX - minX) * 0.2; x < minX + (maxX - minX) * 0.8; x += 0.37) {
      const iv = runs(segs, 'y', x);
      if (iv.length === 0) continue;
      outer.push(iv[0]![1] - iv[0]![0], iv[iv.length - 1]![1] - iv[iv.length - 1]![0]);
    }
    const { sides } = apertureWall(mesh.positions, ZONE, 0.2);
    const inner = Math.min(
      ...(['left', 'right', 'bottom', 'top'] as const).flatMap((s) => sides[s]!.map((v) => v.wall)),
    );
    expect(Math.min(...outer)).toBeCloseTo(inner, 6);
    expect(inner).toBeCloseTo(FRAME.thicknessMm, 6);
  });

  /**
   * The property the photograph actually shows, and the one the old plate
   * failed: open honeycomb close to the wall the whole way round.
   *
   * Measured as how near the nearest clipped cell CENTRE gets to each side of
   * the aperture. Whole-cell removal leaves the nearest surviving cell centre
   * more than half a cell out on the worst side; cutting brings a cell centre
   * to within a few millimetres, because a cell only has to overlap the zone to
   * be clipped rather than removed.
   */
  it('brings open cells CLOSER to the aperture than removing them whole did', () => {
    // Stated as a comparison rather than a millimetre bound, because the right
    // bound depends on where the lattice happens to fall against the switch.
    // The claim that matters is scale-free: cutting a cell puts honeycomb
    // nearer the wall than dropping it ever could.
    const { spec } = plate();
    const sides = [
      { pick: (m: { x: number; y: number }) => Math.abs(m.x - ZONE.xMm),
        within: (m: { x: number; y: number }) => m.y > ZONE.yMm && m.y < ZONE.yMm + ZONE.heightMm },
      { pick: (m: { x: number; y: number }) => Math.abs(m.x - (ZONE.xMm + ZONE.widthMm)),
        within: (m: { x: number; y: number }) => m.y > ZONE.yMm && m.y < ZONE.yMm + ZONE.heightMm },
      { pick: (m: { x: number; y: number }) => Math.abs(m.y - ZONE.yMm),
        within: (m: { x: number; y: number }) => m.x > ZONE.xMm && m.x < ZONE.xMm + ZONE.widthMm },
      { pick: (m: { x: number; y: number }) => Math.abs(m.y - (ZONE.yMm + ZONE.heightMm)),
        within: (m: { x: number; y: number }) => m.x > ZONE.xMm && m.x < ZONE.xMm + ZONE.widthMm },
    ];
    const nearest = (cells: readonly Hex[], side: typeof sides[number]) =>
      Math.min(...cells.map(hexToMm).filter(side.within).map(side.pick), Infinity);
    for (const side of sides) {
      const cut = nearest(spec.clipped, side);
      const kept = nearest(spec.cells, side);
      expect(cut).toBeLessThan(kept);
    }
  });

  it('fills the corners of the aperture instead of notching them', () => {
    /*
     * The last thing wrong with it. A cell diagonally outside a zone's CORNER
     * wants hexagon-minus-quadrant, which is an L; taking both planes keeps
     * only their intersection and bites a notch out of each corner.
     *
     * The arm is filled by a second, SOLID piece at the same position — solid
     * because splitting the cell along the zone's edge would split its BORE
     * too, and two half-bores meeting on that line would grow a membrane across
     * the hole. So the test is: more material near the corners than the
     * intersection alone leaves, and still nothing inside the zone.
     */
    const { spec } = plate();
    const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
    const p = mesh.positions;
    // A box just outside one corner of the aperture, half a cell square.
    const box = {
      minX: ZONE.xMm - 12, maxX: ZONE.xMm,
      minY: ZONE.yMm - 12, maxY: ZONE.yMm,
    };
    let near = 0;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i]! >= box.minX && p[i]! <= box.maxX &&
          p[i + 1]! >= box.minY && p[i + 1]! <= box.maxY) near++;
    }
    expect(near).toBeGreaterThan(0);
  });

  it('does the same round a custom L-shaped zone', () => {
    const L: Obstacle = {
      id: 'z2', label: 'Consumer unit', xMm: 70, yMm: 90, widthMm: 150, heightMm: 150,
      clearanceMm: 0,
      shape: [
        { xMm: 70, yMm: 90, widthMm: 55, heightMm: 150 },
        { xMm: 70, yMm: 90, widthMm: 150, heightMm: 55 },
      ],
    };
    const { spec } = plate(L);
    expect(spec.clipped.length).toBeGreaterThan(0);
    const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
    expect(meshIsClosed(mesh).unmatchedEdges).toBe(0);
    const p = mesh.positions;
    for (const r of L.shape!) {
      let inside = 0;
      for (let i = 0; i < p.length; i += 3) {
        if (
          p[i]! > r.xMm + 1e-6 && p[i]! < r.xMm + r.widthMm - 1e-6 &&
          p[i + 1]! > r.yMm + 1e-6 && p[i + 1]! < r.yMm + r.heightMm - 1e-6
        ) inside++;
      }
      expect(inside).toBe(0);
    }
  });

  it('stays watertight wherever the zone lands on the lattice', () => {
    /*
     * The cut is a function of the ZONE alone, so two cells that both meet it
     * truncate identically along the edge they share and it still cancels. That
     * argument holds for any offset or none, which is what makes a sweep the
     * right test: a single position can be watertight by luck.
     */
    for (let dx = 0; dx < 21; dx += 5) {
      for (let dy = 0; dy < 24; dy += 6) {
        const { spec } = plate({ ...ZONE, xMm: 60 + dx, yMm: 90 + dy });
        const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
        expect({ dx, dy, unmatched: meshIsClosed(mesh).unmatchedEdges })
          .toEqual({ dx, dy, unmatched: 0 });
      }
    }
  });

  it('a plate with no zone is untouched — nothing to clip, nothing changes', () => {
    const base = { id: 'p0', partId: 'x', origin: { q: 0, r: 0 }, columns: 6, rows: 5 };
    const panel: PlacedPanel = { ...base };
    const spec = panelModelSpec(panel, [panel], FRAME, []);
    expect(spec.clipped).toEqual([] as Hex[]);
    const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
    expect(meshIsClosed(mesh).unmatchedEdges).toBe(0);
  });
});
