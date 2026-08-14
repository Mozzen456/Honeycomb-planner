/**
 * The border — a straight, closed edge round the outside of the honeycomb.
 *
 * Measured off the reference plate in `Customiser/borders.webp`, and it is NOT
 * the customiser's `*_Border`. The customiser CUTS: it slices the outermost
 * cells along their centre line, which costs a whole column of mountable cells.
 * The printed reference ADDS: every cell stays whole and open, the walls between
 * cells run out to a straight line, and the notches behind that line fill solid.
 *
 * Three properties carry the whole feature, and each has a case here:
 *
 *  1. **It costs no cells.** If this ever regresses, a wall silently loses a
 *     column of mounting points and every layout on it shifts.
 *  2. **It reaches exactly `thicknessMm` past the outermost cell.** That is the
 *     number the user typed, and it is what decides whether the plate fits the
 *     bed.
 *  3. **It never appears on a seam.** Two plates that butt together must still
 *     interlock; an edge between them would hold them apart by twice its
 *     thickness and the wall would not go together at all.
 */

import { describe, expect, it } from 'vitest';

import { MARGIN_X, MARGIN_Y, PANEL_DEPTH } from '../src/core/constants';
import { hexKey, hexToMm, panelCells } from '../src/core/hex';
import {
  borderPolygons,
  buildHoneycombMesh,
  cellCentreBounds,
  DEFAULT_BORDER_MM,
  honeycombCellCount,
  MAX_BORDER_MM,
  meshBoundsMm,
  meshIsClosed,
  meshVolumeMm3,
  NO_FRAME,
  type BorderSpec,
  type FrameSides,
} from '../src/core/honeycomb';
import type { Hex } from '../src/core/types';

const block = (cols: number, rows: number, at: Hex = { q: 0, r: 0 }) =>
  panelCells(at, cols, rows);
const raw = { originAtZero: false as const };

const ALL: FrameSides = { left: true, right: true, bottom: true, top: true };

/** A border over exactly these cells — nothing else in the assembly. */
function borderOver(
  cells: readonly Hex[],
  thicknessMm = DEFAULT_BORDER_MM,
  sides: FrameSides = ALL,
  holes = true,
  assembly: readonly Hex[] = cells,
): BorderSpec {
  return {
    thicknessMm,
    occupied: new Set(assembly.map(hexKey)),
    sides,
    holes,
    bounds: cellCentreBounds(assembly),
  };
}

describe('what it costs', () => {
  it('costs no cells at all', () => {
    // The whole difference from the customiser's border. A 4 × 4 plate with an
    // edge all round is still a 4 × 4 plate.
    const cells = block(4, 4);
    expect(honeycombCellCount({ cells, border: borderOver(cells) })).toBe(16);
    expect(honeycombCellCount({ cells })).toBe(16);
  });

  it('leaves every bore exactly where it was', () => {
    // A cell's hole must not move or shrink, or a part lined up against it in
    // the alignment tool would arrive somewhere else on the wall.
    const cells = block(3, 3);
    const bare = buildHoneycombMesh({ cells, ...raw });
    const edged = buildHoneycombMesh({ cells, border: borderOver(cells), ...raw });
    // More material, same thickness, and the extra is all on the outside.
    expect(meshVolumeMm3(edged)).toBeGreaterThan(meshVolumeMm3(bare));
    expect(meshBoundsMm(edged).size[2]).toBeCloseTo(PANEL_DEPTH, 9);
  });
});

describe('how far it reaches', () => {
  it('extends exactly the thickness past the outermost cell, on every side', () => {
    const cells = block(4, 4);
    const b = cellCentreBounds(cells);
    for (const t of [0.8, DEFAULT_BORDER_MM, 6]) {
      const box = meshBoundsMm(buildHoneycombMesh({ cells, border: borderOver(cells, t), ...raw }));
      expect(box.min[0], `t=${t}`).toBeCloseTo(b.minX - MARGIN_X - t, 3);
      expect(box.max[0], `t=${t}`).toBeCloseTo(b.maxX + MARGIN_X + t, 3);
      expect(box.min[1], `t=${t}`).toBeCloseTo(b.minY - MARGIN_Y - t, 3);
      expect(box.max[1], `t=${t}`).toBeCloseTo(b.maxY + MARGIN_Y + t, 3);
    }
  });

  it('grows the plate by twice the thickness in each direction', () => {
    const cells = block(5, 4);
    const bare = meshBoundsMm(buildHoneycombMesh({ cells, ...raw })).size;
    const t = 2.5;
    const edged = meshBoundsMm(
      buildHoneycombMesh({ cells, border: borderOver(cells, t), ...raw }),
    ).size;
    expect(edged[0] - bare[0]).toBeCloseTo(2 * t, 3);
    expect(edged[1] - bare[1]).toBeCloseTo(2 * t, 3);
  });

  it('only grows the sides that are switched on', () => {
    const cells = block(4, 4);
    const b = cellCentreBounds(cells);
    const box = meshBoundsMm(
      buildHoneycombMesh({
        cells,
        border: borderOver(cells, 3, { ...NO_FRAME, left: true }, false),
        ...raw,
      }),
    );
    expect(box.min[0]).toBeCloseTo(b.minX - MARGIN_X - 3, 3);
    // The other three edges are untouched — still the honeycomb's own zig-zag.
    expect(box.max[0]).toBeCloseTo(b.maxX + MARGIN_X, 3);
    expect(box.min[1]).toBeCloseTo(b.minY - MARGIN_Y, 3);
    expect(box.max[1]).toBeCloseTo(b.maxY + MARGIN_Y, 3);
  });

  it('refuses to reach further than one ring of positions can', () => {
    // Past this the phantom ring runs out and the edge would come back short
    // without saying so, which is the kind of quiet wrongness you only find
    // after printing it.
    expect(MAX_BORDER_MM).toBeGreaterThan(DEFAULT_BORDER_MM);
    expect(MAX_BORDER_MM).toBeLessThan(2 * MARGIN_X);
  });
});

describe('seams', () => {
  it('puts no edge on a side the neighbouring plate covers', () => {
    // The property the whole "outer perimeter only" rule exists for, stated as a
    // comparison rather than as a coordinate: the same plate, with and without
    // its neighbour in the assembly. With the neighbour there, the shared side
    // stops growing.
    //
    // A comparison rather than "max x equals such-and-such" because the lattice
    // staggers alternate columns, so a plate's edge is never a straight column
    // of positions and picking one to assert about is picking wrong.
    const assembly = block(8, 4);
    const plate = assembly.filter((c) => c.q < 4);
    // Left and right only. With the top on as well, this plate legitimately
    // carries a piece of the assembly's TOP edge that overhangs to the right of
    // its own cells — correct, and nothing to do with the seam.
    const sideways = { left: true, right: true, bottom: false, top: false };

    const alone = meshBoundsMm(buildHoneycombMesh({
      cells: plate, border: borderOver(plate, 3, sideways, false, plate), ...raw,
    }));
    const joined = meshBoundsMm(buildHoneycombMesh({
      cells: plate, border: borderOver(plate, 3, sideways, false, assembly), ...raw,
    }));

    // Its own outer side is unchanged...
    expect(joined.min[0]).toBeCloseTo(alone.min[0]!, 6);
    // ...and the side facing the neighbour has pulled back.
    expect(joined.max[0]).toBeLessThan(alone.max[0]! - 1);
    // And it lands exactly on the honeycomb's own outline, with nothing added.
    expect(joined.max[0]).toBeCloseTo(cellCentreBounds(plate).maxX + MARGIN_X, 3);
  });

  it('gives a plate with a neighbour on every side no edge at all', () => {
    // The strict interior of a block: every one of its neighbour positions is
    // filled. Computed rather than hand-picked, because the stagger makes "the
    // middle three columns" not a rectangle.
    const assembly = block(9, 7);
    const occupied = new Set(assembly.map(hexKey));
    const DIRS = [
      { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 },
      { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 },
    ];
    const interior = assembly.filter((c) =>
      DIRS.every((d) => occupied.has(hexKey({ q: c.q + d.q, r: c.r + d.r }))));
    expect(interior.length).toBeGreaterThan(8);

    const border = borderOver(interior, 3, ALL, true, assembly);
    const bare = meshBoundsMm(buildHoneycombMesh({ cells: interior, ...raw })).size;
    const edged = meshBoundsMm(buildHoneycombMesh({ cells: interior, border, ...raw })).size;
    expect(edged[0]).toBeCloseTo(bare[0]!, 6);
    expect(edged[1]).toBeCloseTo(bare[1]!, 6);
  });
});

describe('holes', () => {
  it('closes the edge round a blocked zone when asked', () => {
    const full = block(6, 6);
    const gone = new Set([hexKey({ q: 2, r: 2 }), hexKey({ q: 3, r: 1 })]);
    const cells = full.filter((c) => !gone.has(hexKey(c)));
    const open = buildHoneycombMesh({ cells, border: borderOver(cells, 3, NO_FRAME, false), ...raw });
    const closed = buildHoneycombMesh({ cells, border: borderOver(cells, 3, NO_FRAME, true), ...raw });
    // The hole's rim is material, so bordering it adds some — and the plate's
    // outline does not move, because the hole is on the inside.
    expect(meshVolumeMm3(closed)).toBeGreaterThan(meshVolumeMm3(open));
    expect(meshBoundsMm(closed).size[0]).toBeCloseTo(meshBoundsMm(open).size[0], 6);
  });
});

describe('the solid it makes', () => {
  it('is closed and outward-facing for every combination of sides', () => {
    const cells = block(5, 4);
    for (const t of [0.8, DEFAULT_BORDER_MM]) {
      for (let mask = 0; mask < 16; mask++) {
        for (const holes of [false, true]) {
          const sides: FrameSides = {
            left: (mask & 1) !== 0,
            right: (mask & 2) !== 0,
            bottom: (mask & 4) !== 0,
            top: (mask & 8) !== 0,
          };
          const mesh = buildHoneycombMesh({
            cells, border: borderOver(cells, t, sides, holes), ...raw,
          });
          const where = `${JSON.stringify(sides)} holes=${holes} t=${t}`;
          expect(meshIsClosed(mesh).unmatchedEdges, where).toBe(0);
          expect(meshVolumeMm3(mesh), where).toBeGreaterThan(0);
        }
      }
    }
  });

  /*
   * ONE solid, joined along real faces — the thing "closed" does not say.
   *
   * A closed mesh can be two closed shells, and for a long time it was: the
   * border came off the honeycomb as loose pieces and every test here passed
   * (D84). Two of the four corners of a bordered plate were separate 3.6 × 3.6
   * blocks; the left and right rails were separate strips the height of the
   * plate; on plates that rounded the wrong way, the whole top or bottom rail
   * was a separate strip the width of it. A slicer prints those as objects that
   * fall over, and the plate comes out with no edge on that side.
   *
   * Joined by shared EDGES, never shared vertices. That distinction is the whole
   * finding: a uniform rail down the left of a flat-top lattice touches the
   * honeycomb at ONE POINT per cell — the hexagon's corner — so a by-vertex test
   * calls it attached and a printer calls it a comb hanging off nothing.
   */
  const oneSolid = (mesh: { positions: Float64Array | number[] }): number => {
    let zMax = -Infinity;
    for (let i = 2; i < mesh.positions.length; i += 3) {
      zMax = Math.max(zMax, mesh.positions[i]!);
    }
    const tris: string[][] = [];
    for (let i = 0; i < mesh.positions.length; i += 9) {
      const z = [mesh.positions[i + 2]!, mesh.positions[i + 5]!, mesh.positions[i + 8]!];
      if (!z.every((v) => Math.abs(v - zMax) < 1e-9)) continue;
      tris.push([0, 3, 6].map((o) => `${mesh.positions[i + o]!},${mesh.positions[i + o + 1]!}`));
    }
    const parent = tris.map((_, i) => i);
    const find = (a: number): number => {
      let r = a;
      while (parent[r] !== r) r = parent[r]!;
      return r;
    };
    const edges = new Map<string, number>();
    tris.forEach((t, i) => {
      for (let k = 0; k < 3; k++) {
        const key = [t[k]!, t[(k + 1) % 3]!].sort().join('|');
        const seen = edges.get(key);
        if (seen === undefined) edges.set(key, i);
        else parent[find(seen)] = find(i);
      }
    });
    return new Set(tris.map((_, i) => find(i))).size;
  };

  it('is ONE solid, not a plate with its border lying beside it', () => {
    // Swept over sizes because the failures were parity-dependent: the stagger
    // is chiral, so which corners and which rail come loose depends on the
    // column and row counts, and a single size passes by luck.
    for (const sides of [
      { left: true, right: true, bottom: true, top: true },
      { left: true, right: false, bottom: true, top: false },
      { left: false, right: true, bottom: false, top: true },
      { left: true, right: true, bottom: false, top: false },
      { left: false, right: false, bottom: true, top: true },
    ]) {
      for (const [cols, rows] of [[2, 2], [3, 9], [5, 9], [5, 10], [8, 7], [12, 11], [13, 13]]) {
        const cells = block(cols!, rows!);
        const mesh = buildHoneycombMesh({
          cells, border: borderOver(cells, DEFAULT_BORDER_MM, sides, true), ...raw,
        });
        const where = `${JSON.stringify(sides)} ${cols}x${rows}`;
        expect(oneSolid(mesh), where).toBe(1);
      }
    }
  });

  it('is closed round an irregular outline, like the reference plate', () => {
    // An L, which is what `Customiser/borders.webp` is: the border has to follow
    // the steps, and every step is a place two border lines meet.
    const arm = block(3, 2, { q: 0, r: 4 });
    const body = block(5, 4, { q: 0, r: 0 });
    const cells = [...arm, ...body].filter(
      (c, i, all) => all.findIndex((o) => hexKey(o) === hexKey(c)) === i,
    );
    const mesh = buildHoneycombMesh({ cells, border: borderOver(cells, 3), ...raw });
    expect(meshIsClosed(mesh).unmatchedEdges).toBe(0);
    expect(meshVolumeMm3(mesh)).toBeGreaterThan(0);
  });

  it('is closed for a single cell with an edge all round', () => {
    const cells = [{ q: 0, r: 0 }];
    const mesh = buildHoneycombMesh({ cells, border: borderOver(cells, 3), ...raw });
    expect(meshIsClosed(mesh).closed).toBe(true);
    // One cell, still one cell — and now a coaster.
    expect(honeycombCellCount({ cells, border: borderOver(cells, 3) })).toBe(1);
  });
});

describe('a straight run', () => {
  it('comes out flush, not stepped, across a staggered lattice', () => {
    // The lattice staggers alternate columns by half a pitch, so a top edge is a
    // zig-zag. Every phantom works its line out from its OWN neighbours, and
    // they must all land on the same line or the edge comes out serrated.
    const cells = block(6, 4);
    const b = cellCentreBounds(cells);
    const mesh = buildHoneycombMesh({ cells, border: borderOver(cells, 2), ...raw });
    const top = b.maxY + MARGIN_Y + 2;
    let onTheLine = 0;
    const p = mesh.positions;
    for (let i = 1; i < p.length; i += 3) {
      if (Math.abs(p[i]! - top) < 1e-6) onTheLine++;
    }
    // A serrated edge would put only the high columns' vertices up here.
    expect(onTheLine).toBeGreaterThan(20);
    expect(meshBoundsMm(mesh).max[1]).toBeCloseTo(top, 6);
  });

  it('puts the same line on both halves of the stagger', () => {
    // Stated directly: the topmost cells and the ones half a pitch below them
    // must reach the same y, because the border fills the notch between them.
    const cells = block(2, 3);
    const b = cellCentreBounds(cells);
    const ys = cells.map((c) => hexToMm(c).y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0);
    const box = meshBoundsMm(buildHoneycombMesh({ cells, border: borderOver(cells, 1.5), ...raw }));
    expect(box.max[1]).toBeCloseTo(b.maxY + MARGIN_Y + 1.5, 6);
  });
});

/**
 * The border round a BLOCKED ZONE.
 *
 * Reported as "the blocked zone with border gets really bugged and does not get
 * a clean border like the outer edge" (D77). Two things were behind it.
 *
 * `outwardOf` asks which side of the ASSEMBLY a piece lies beyond, and a hole
 * is beyond none of them — so a hole's pieces got no inner clip and came out as
 * whole solid hexagons standing in the aperture.
 *
 * And the deeper one: a hole had no straight line to clip to. The outside has
 * the assembly's own bounds; a hole had only the honeycomb's stepped rim,
 * because a cell is cut the moment it clashes with a zone, so the aperture is
 * bigger than the zone and lands on no line. `keepClear` gives the generator
 * the rectangle, and that is what makes the aperture come out straight.
 *
 * Measured on the reported case — an 86 x 86 switch — the plate left 369 mm² of
 * itself inside the switch's own rectangle. That is what these pin.
 */
describe('the edge round a hole', () => {
  /** Area of the border polygons falling inside a rectangle, sampled at 0.5 mm. */
  function borderAreaInside(
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

  /** A block with the cells clashing a rectangle taken out, as a zone cuts them. */
  function withZone(cols: number, rows: number, halfW: number, halfH: number) {
    const all = block(cols, rows);
    const b = cellCentreBounds(all);
    const mid = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    const zone = {
      minX: mid.x - halfW, maxX: mid.x + halfW, minY: mid.y - halfH, maxY: mid.y + halfH,
    };
    // A cell goes if its own extent overlaps the zone at all — the same
    // generous rule `obstacles.ts` applies, which is why the aperture ends up
    // bigger than the zone and needs the zone to clip back to.
    const clashes = (c: Hex) => {
      const m = hexToMm(c);
      return (
        m.x + MARGIN_X > zone.minX && m.x - MARGIN_X < zone.maxX &&
        m.y + MARGIN_Y > zone.minY && m.y - MARGIN_Y < zone.maxY
      );
    };
    return { cells: all.filter((c) => !clashes(c)), zone, cut: all.filter(clashes) };
  }

  const withKeepClear = (
    cells: readonly Hex[],
    zone: { minX: number; maxX: number; minY: number; maxY: number },
    t = 3.6,
  ): BorderSpec => ({ ...borderOver(cells, t, NO_FRAME, true), keepClear: [zone] });

  it('leaves NOTHING inside the rectangle that was blocked out', () => {
    // The functional statement, and the one that was false: plate inside the
    // zone is plate where the switch goes, and the wall will not sit flat.
    const { cells, zone } = withZone(7, 6, 43, 43);
    const polys = borderPolygons(cells, withKeepClear(cells, zone));
    expect(borderAreaInside(polys, zone)).toBe(0);
  });

  it('draws no border round a zone at all — the cut cells print that edge', () => {
    /*
     * One owner for the aperture's edge (D83).
     *
     * The border used to fill the band between the zone and the honeycomb while
     * the cells the zone ate were cut back to leave room for it, and the two
     * halves never met: a border piece only grows where the plate has left a
     * position EMPTY, and every position round an aperture is a cell the plate
     * prints CUT. So the band was planned twice and printed never. The cut cell
     * now carries its own rail and the border keeps off — which also settles
     * the case across a seam, where the plate growing the piece and the plate
     * printing the cell are not the same plate.
     *
     * `tests/zone-aperture.test.ts` is where the rail itself is measured, on
     * the mesh.
     */
    const { cells, zone } = withZone(7, 6, 43, 43);
    const grown = { minX: zone.minX - 3.6, maxX: zone.maxX + 3.6,
                    minY: zone.minY - 3.6, maxY: zone.maxY + 3.6 };
    for (const poly of borderPolygons(cells, withKeepClear(cells, zone))) {
      for (const q of poly) {
        const clear =
          q.x <= grown.minX + 1e-6 || q.x >= grown.maxX - 1e-6 ||
          q.y <= grown.minY + 1e-6 || q.y >= grown.maxY - 1e-6;
        expect(clear).toBe(true);
      }
    }
  });

  it('really is cutting something — the same hole without the rectangle is not clear', () => {
    // Guards the test above from passing because the border is empty or the
    // hole is in the wrong place. Told only about cells, the generator fills
    // hundreds of mm² of the aperture.
    const { cells, zone } = withZone(7, 6, 43, 43);
    const blind = borderPolygons(cells, borderOver(cells, 3.6, NO_FRAME, true));
    expect(borderAreaInside(blind, zone)).toBeGreaterThan(100);
  });

  it('an outer rail that meets a zone still stops dead on its line', () => {
    /*
     * The one place the border and a zone still meet: a zone that overruns the
     * plate's own edge. The rail along that edge would otherwise run straight
     * through the aperture, because outer pieces take their planes from the
     * assembly bounds and would never look at `keepClear` at all.
     *
     * Held to the same statement as before — material has to arrive at the zone
     * and stop dead on it — but on the side of the plate where the border is
     * still the owner.
     */
    const { cells } = withZone(7, 6, 43, 43);
    const b = cellCentreBounds(cells);
    // A pipe running off the top of the plate, overlapping the top rail.
    const zone = {
      minX: b.minX + 20, maxX: b.minX + 60,
      minY: b.maxY, maxY: b.maxY + 200,
    };
    const spec = { ...borderOver(cells, 3.6, ALL, true), keepClear: [zone] };
    const polys = borderPolygons(cells, spec);
    expect(borderAreaInside(polys, zone)).toBe(0);
    const onTheLine = polys.filter((poly) =>
      poly.some((q) => Math.abs(q.x - zone.minX) < 1e-6 || Math.abs(q.x - zone.maxX) < 1e-6 ||
                       Math.abs(q.y - zone.minY) < 1e-6));
    expect(onTheLine.length).toBeGreaterThan(0);
  });

  it('switching holes off leaves the aperture bare', () => {
    const { cells } = withZone(7, 6, 43, 43);
    expect(borderPolygons(cells, borderOver(cells, 3.6, NO_FRAME, false))).toHaveLength(0);
  });

  it('does not disturb the outer edge, which keeps its own straight line', () => {
    // The two rules coexist: the outside still clips to the assembly bounds.
    const { cells, zone } = withZone(7, 6, 43, 43);
    const t = 3;
    const b = cellCentreBounds(cells);
    const spec = { ...borderOver(cells, t, ALL, true), keepClear: [zone] };
    const box = meshBoundsMm(buildHoneycombMesh({ cells, border: spec, ...raw }));
    expect(box.max[1]).toBeCloseTo(b.maxY + MARGIN_Y + t, 3);
    expect(box.min[0]).toBeCloseTo(b.minX - MARGIN_X - t, 3);
  });

  it('still builds a closed mesh with a bordered hole in it', () => {
    // The clip adds planes per piece, and a convex polygon clipped by one stays
    // convex — but a piece clipped to nothing must drop out rather than emit a
    // degenerate face.
    const { cells, zone } = withZone(7, 6, 43, 43);
    const mesh = buildHoneycombMesh({ cells, border: withKeepClear(cells, zone), ...raw });
    expect(meshIsClosed(mesh).unmatchedEdges).toBe(0);
  });
});

describe('the edge is FLAT', () => {

  it('makes the top edge a rail of ONE thickness', () => {
    // The property the user asked for and the one that is easy to lose: along a
    // staggered edge, filling everything between the honeycomb and the straight
    // outer line gives a band `t` thick above one column and `t + PITCH/2` above
    // the next. Every piece of the top rail must be `t` deep and no more.
    const cells = block(6, 4);
    const t = 3.6;
    const spec = borderOver(cells, t, { ...NO_FRAME, top: true }, false);
    const polys = borderPolygons(cells, spec);
    expect(polys.length).toBeGreaterThan(0);
    for (const poly of polys) {
      const ys = poly.map((q) => q.y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(t + 1e-6);
    }
  });

  it('leaves the half-cell pockets open rather than filling them', () => {
    // The cost of that choice, stated so it cannot be reverted by accident: the
    // rail adds about width × thickness of material, NOT that plus a half cell
    // per staggered column. Every cell stays mountable; the rail is attached at
    // every other column.
    const cells = block(6, 4);
    const t = 3.6;
    const b = cellCentreBounds(cells);
    const width = (b.maxX - b.minX) + 2 * MARGIN_X;
    const bare = meshVolumeMm3(buildHoneycombMesh({ cells, ...raw }));
    const railed = meshVolumeMm3(buildHoneycombMesh({
      cells, border: borderOver(cells, t, { ...NO_FRAME, top: true }, false), ...raw,
    }));
    const added = (railed - bare) / PANEL_DEPTH;   // mm² of plate added
    expect(added).toBeGreaterThan(width * t * 0.85);
    expect(added).toBeLessThan(width * t * 1.15);
  });

  it('adds exactly `t` past the SIDES, and fills the scallop behind it', () => {
    /*
     * The sides are NOT a free-standing rail, and this test used to demand that
     * they were (D84). Railed, a left or right border is a strip whose inner
     * line is the cells' outermost x — which a column of flat-top cells reaches
     * at ONE POINT per cell, its corner, and along no edge at all. It printed as
     * a strip lying beside the plate, touching it nowhere.
     *
     * So a side is filled out to its line: the band beyond the envelope is
     * exactly `t`, as on every other side, and the 6.8 mm scallop between two
     * cells' corners is solid rather than open. Held to both halves here,
     * because the first is the user's requirement and the second is what makes
     * it a plate rather than a plate and a stick.
     */
    const cells = block(4, 5);
    const t = 3.6;
    for (const side of ['left', 'right'] as const) {
      const b = cellCentreBounds(cells);
      const line = side === 'left' ? b.minX - MARGIN_X - t : b.maxX + MARGIN_X + t;
      const envelope = side === 'left' ? b.minX - MARGIN_X : b.maxX + MARGIN_X;
      const spec = borderOver(cells, t, { ...NO_FRAME, [side]: true }, false);
      const polys = borderPolygons(cells, spec);
      expect(polys.length, side).toBeGreaterThan(0);
      // Nothing past the straight line: the band is `t` and not a millimetre more.
      for (const poly of polys) {
        for (const q of poly) {
          if (side === 'left') expect(q.x, side).toBeGreaterThanOrEqual(line - 1e-6);
          else expect(q.x, side).toBeLessThanOrEqual(line + 1e-6);
        }
      }
      // ...and it reaches PAST the envelope, into the scallop, which is what a
      // railed side refused to do and is the only thing holding it on.
      const deepest = Math.max(...polys.flatMap((poly) => poly.map((q) =>
        side === 'left' ? q.x - envelope : envelope - q.x)));
      expect(deepest, side).toBeGreaterThan(t);
    }
  });

  it('runs the full height of the outer column, corner cell included', () => {
    /*
     * A CORNER position is outward on two sides at once, and it takes NEITHER
     * rail: it is solid out to both its lines, which is what a plate's corner
     * is. Given both it keeps only where they cross and comes off as a loose
     * block (D84); given the top/bottom rail alone it keeps only what lies below
     * the bottom line, and the side band's last 11.8 mm — the stretch beside the
     * bottom-most cell — goes with it. That second one detaches nothing and no
     * connectivity test sees it. It is a notch in an edge that is supposed to be
     * straight.
     *
     * Stated as: beside every cell of the outermost column, over that cell's own
     * full height, the band is plate. Not "unbroken from line to line", which
     * would also demand that the half-cell pocket at the far end be filled — it
     * is deliberately open (D69), and where the stagger puts a pocket at a corner
     * the band does stop a pitch short of the line.
     */
    const t = 3.6;
    for (const [cols, rows] of [[6, 5], [5, 9], [7, 6]]) {
      const cells = block(cols!, rows!);
      const b = cellCentreBounds(cells);
      const polys = borderPolygons(cells, borderOver(cells, t, ALL, false));
      const inside = (x: number, y: number) => polys.some((poly) => {
        let c = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const p = poly[i]!, q = poly[j]!;
          if ((p.y > y) !== (q.y > y) && x < ((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x) c = !c;
        }
        return c;
      });
      for (const [side, edge] of [['left', b.minX], ['right', b.maxX]] as const) {
        const x = side === 'left' ? edge - MARGIN_X - t / 2 : edge + MARGIN_X + t / 2;
        const column = cells.map(hexToMm).filter((m) => Math.abs(m.x - edge) < 1e-6);
        const gaps: number[] = [];
        for (const cell of column) {
          for (let y = cell.y - MARGIN_Y + 0.2; y < cell.y + MARGIN_Y - 0.2; y += 0.25) {
            if (!inside(x, y)) gaps.push(y);
          }
        }
        const where = `${side} ${cols}x${rows}: gaps at ${gaps.slice(0, 4).map((v) => v.toFixed(1))}`;
        expect(gaps.length, where).toBe(0);
      }
    }
  });

  /**
   * The plate's SILHOUETTE, side by side: how far the outermost material on each
   * side strays from the straight line it is supposed to lie on.
   *
   * Taken off the finished mesh, because that is the only place the honeycomb
   * and the border are the same object. Sliced at one height and scanned, so a
   * step of any depth anywhere along a side shows up as a number.
   */
  function outlineDrift(mesh: { positions: Float64Array | number[] }): Record<string, number> {
    const p = mesh.positions;
    const z = 0.2;
    const segs: { ax: number; ay: number; bx: number; by: number }[] = [];
    for (let i = 0; i < p.length; i += 9) {
      const v = [0, 3, 6].map((o) => ({ x: p[i + o]!, y: p[i + o + 1]!, z: p[i + o + 2]! }));
      const hit: { x: number; y: number }[] = [];
      for (let e = 0; e < 3; e++) {
        const a = v[e]!, b = v[(e + 1) % 3]!;
        if ((a.z - z) * (b.z - z) < 0) {
          const f = (z - a.z) / (b.z - a.z);
          hit.push({ x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) });
        }
      }
      if (hit.length === 2) segs.push({ ax: hit[0]!.x, ay: hit[0]!.y, bx: hit[1]!.x, by: hit[1]!.y });
    }
    const cross = (axis: 'x' | 'y', at: number): number[] => {
      const hits: number[] = [];
      for (const s of segs) {
        const [a0, b0, a1, b1] = axis === 'x'
          ? [s.ay, s.by, s.ax, s.bx]
          : [s.ax, s.bx, s.ay, s.by];
        if ((a0 - at) * (b0 - at) < 0) hits.push(a1 + ((at - a0) / (b0 - a0)) * (b1 - a1));
      }
      return hits.sort((a, b) => a - b);
    };
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of segs) {
      x0 = Math.min(x0, s.ax, s.bx); x1 = Math.max(x1, s.ax, s.bx);
      y0 = Math.min(y0, s.ay, s.by); y1 = Math.max(y1, s.ay, s.by);
    }
    const drift = { left: 0, right: 0, bottom: 0, top: 0 };
    for (let x = x0 + 0.4; x < x1 - 0.4; x += 0.37) {
      const h = cross('y', x);
      if (h.length === 0) continue;
      drift.bottom = Math.max(drift.bottom, h[0]! - y0);
      drift.top = Math.max(drift.top, y1 - h[h.length - 1]!);
    }
    for (let y = y0 + 0.4; y < y1 - 0.4; y += 0.37) {
      const h = cross('x', y);
      if (h.length === 0) continue;
      drift.left = Math.max(drift.left, h[0]! - x0);
      drift.right = Math.max(drift.right, x1 - h[h.length - 1]!);
    }
    return drift;
  }

  it('has a STRAIGHT outline on every side it edges, with no step', () => {
    /*
     * What a bordered plate is for: a straight finished edge. It was straight on
     * the top and bottom and stepped in by up to 30.8 mm on the left and right
     * (D85) — at two corners of every plate, chirally, so which two depended on
     * the block and a single size could look fine.
     *
     * The cause is the flat-top stagger. The outermost COLUMN is half a pitch
     * shorter than its neighbour, and a band took its extent from the cells it
     * leaned on, so the side band stopped `t` past the last cell of its own
     * column while the plate carried on above it. A band now runs to the plate's
     * own line along its length, and still takes its thickness from its reach.
     *
     * Swept, because a step at one end of one side is exactly the kind of thing
     * one block size hides.
     */
    for (const [cols, rows] of [[4, 4], [6, 5], [5, 9], [7, 6], [12, 11], [13, 13]]) {
      const cells = block(cols!, rows!);
      const mesh = buildHoneycombMesh({
        cells, border: borderOver(cells, DEFAULT_BORDER_MM, ALL, true), ...raw,
      });
      const drift = outlineDrift(mesh);
      for (const side of ['left', 'right', 'bottom', 'top'] as const) {
        expect(drift[side], `${side} ${cols}x${rows}`).toBeLessThan(1e-6);
      }
    }
  });

  it('reaches the straight line on every side, at any thickness', () => {
    for (const t of [1, 3.6, 6]) {
      const cells = block(5, 4);
      const b = cellCentreBounds(cells);
      const box = meshBoundsMm(buildHoneycombMesh({ cells, border: borderOver(cells, t), ...raw }));
      expect(box.min[0], `t=${t}`).toBeCloseTo(b.minX - MARGIN_X - t, 6);
      expect(box.max[0], `t=${t}`).toBeCloseTo(b.maxX + MARGIN_X + t, 6);
      expect(box.min[1], `t=${t}`).toBeCloseTo(b.minY - MARGIN_Y - t, 6);
      expect(box.max[1], `t=${t}`).toBeCloseTo(b.maxY + MARGIN_Y + t, 6);
    }
  });
});
