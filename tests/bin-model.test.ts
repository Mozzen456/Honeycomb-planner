/**
 * The generated bin: is it on the lattice, and is it printable?
 *
 * Two questions and they are not the same one. "On the lattice" is checked
 * against `hexToMm` — the app's own embedding — rather than against 40.876,
 * because a number restated in a test only proves the test was written from the
 * same misunderstanding as the code. "Printable" is `meshIsClosed` plus a SIGNED
 * volume: a mesh wound inside out is closed and slices as a hole.
 */

import { describe, expect, it } from 'vitest';

import {
  buildBinMesh,
  cellsFor,
  cornerRadii,
  CORNER_RADIUS_MM,
  drawOffsetYMm,
  MAX_PEGS,
  MIN_PEGS,
  MAX_WIDTH_MM,
  maxHeightMm,
  MIN_PEG_MARGIN_MM,
  bridgingPegs,
  cellPointMm,
  backPanelCells,
  latticeOffsetMm,
  panelExtentMm,
  minWidthMm,
  normaliseBinSpec,
  outerMm,
  pegStep,
  pegCentres,
  previewPatch,
  topPegRow,
  type BinSpec,
} from '../src/core/binModel';
import { PEG, PEG_RADIUS, PITCH, SAME_ROW_STEP } from '../src/core/constants';
import { hexKey, hexToMm, panelCells } from '../src/core/hex';
import { meshIsClosed, toBinaryStl, type SolidMesh } from '../src/core/honeycomb';
import { measureMesh, parseStl } from '../src/core/stl';

/**
 * A spec is the INSIDE of the bin. Everything the model builds is one wall
 * bigger, and `outerMm` is the only thing allowed to say so — which is why the
 * assertions below reach for it rather than adding 2·t themselves.
 */
const WALL = 2.4;
const spec = (over: Partial<BinSpec> = {}): BinSpec =>
  normaliseBinSpec({
    pegs: 3,
    innerWidthMm: 135,
    innerHeightMm: 78,
    innerDepthMm: 55,
    wallMm: WALL,
    ...over,
  });

/**
 * Every shape a person can ask for, coarsely swept.
 *
 * Both width regimes on purpose: `minWidthMm + 7` is a bin whose pegs sit at the
 * closest legal spacing, and the wider ones are where `pegStep` spreads them.
 * A sweep of only the first would never exercise the spreading at all.
 */
const SHAPES: BinSpec[] = [];
for (const pegs of [1, 2, 3, 5, 8]) {
  for (const innerHeightMm of [14, 28, 35, 38, 59, 78, 119, 300]) {
    for (const innerDepthMm of [10, 55, 250]) {
      const narrow = minWidthMm(pegs, WALL);
      for (const innerWidthMm of [narrow + 7, narrow * 2 + 13, MAX_WIDTH_MM]) {
        SHAPES.push(spec({ pegs, innerHeightMm, innerDepthMm, innerWidthMm }));
      }
    }
  }
}

/** Signed volume by the divergence theorem. Negative means wound inside out. */
function signedVolume(mesh: SolidMesh): number {
  const p = mesh.positions;
  let v = 0;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const i = t * 9;
    const ax = p[i]!, ay = p[i + 1]!, az = p[i + 2]!;
    const bx = p[i + 3]!, by = p[i + 4]!, bz = p[i + 5]!;
    const cx = p[i + 6]!, cy = p[i + 7]!, cz = p[i + 8]!;
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

describe('the pegs are on the lattice', () => {
  it('builds one compact peg and one insert at the minimum size', () => {
    const s = spec({ pegs: 1, innerWidthMm: 0, innerHeightMm: 0, innerDepthMm: 0 });
    const model = buildBinMesh(s);
    expect(model.cells).toEqual([{ q: 0, r: 0 }]);
    expect(model.bridgeMm).toBe(0);
    expect(outerMm(s).widthMm).toBeLessThanOrEqual(27.25);
    expect(backPanelCells(s).some((c) => c.cell.q === 0 && c.cell.r === 0 && c.whole)).toBe(true);
    expect(meshIsClosed(model.mesh).closed).toBe(true);
    expect(signedVolume(model.mesh)).toBeGreaterThan(0);
  });

  it('keeps a tall one-peg bin on one mount', () => {
    const s = spec({ pegs: 1, innerHeightMm: 120 });
    expect(s.innerHeightMm).toBe(maxHeightMm(1));
    expect(cellsFor(s)).toEqual([{ q: 0, r: 0 }]);
    expect(buildBinMesh(s).cells).toHaveLength(1);
    expect(Math.abs(drawOffsetYMm(s))).toBeLessThan(40);
    const thick = spec({ pegs: 1, wallMm: 5, innerHeightMm: 300 });
    expect(Math.abs(drawOffsetYMm(thick))).toBeLessThan(40);
  });

  it('places every peg on a cell centre, measured through hexToMm', () => {
    for (const s of SHAPES) {
      const cells = cellsFor(s);
      const centres = pegCentres(s);
      expect(cells).toHaveLength(centres.length);

      const originCell = hexToMm(cells[0]!);
      const originPeg = centres[0]!;
      for (let i = 0; i < cells.length; i++) {
        const cell = hexToMm(cells[i]!);
        // The part has no opinion about where the wall's origin is, so both
        // sides are compared as DISPLACEMENTS from the anchor. A displacement of
        // two `hexToMm`s is anchor-free and always safe (D76).
        expect(cell.x - originCell.x).toBeCloseTo(centres[i]!.acrossMm - originPeg.acrossMm, 9);
        expect(cell.y - originCell.y).toBeCloseTo(centres[i]!.upMm - originPeg.upMm, 9);
      }
    }
  });

  it('steps two columns across, so a row of pegs stays level', () => {
    const cells = cellsFor(spec({ pegs: 4 }));
    const level = cells.slice(0, 4).map(hexToMm);
    for (let i = 1; i < level.length; i++) {
      expect(level[i]!.y).toBeCloseTo(level[0]!.y, 12);
      expect(level[i]!.x - level[i - 1]!.x).toBeCloseTo(SAME_ROW_STEP, 12);
    }
  });

  it('steps one PITCH between the two rows, in the same columns', () => {
    const s = spec({ pegs: 3, innerHeightMm: 90 });
    expect(topPegRow(s)).toBeGreaterThan(0);
    const cells = cellsFor(s);
    for (let i = 0; i < 3; i++) {
      const low = hexToMm(cells[i]!);
      const high = hexToMm(cells[i + 3]!);
      expect(high.x).toBeCloseTo(low.x, 12);
      expect(high.y - low.y).toBeCloseTo(topPegRow(s) * PITCH, 9);
    }
  });

  it('spreads the pegs as wide as the bin allows, in whole lattice steps', () => {
    // Two pegs bunched in the middle of a wide bin let it rock about its own
    // centre. Widening must never leave the lattice, so the spacing has to stay
    // a whole number of same-row steps.
    for (const s of SHAPES) {
      const cells = cellsFor(s);
      if (s.pegs < 2) continue;
      const gap = hexToMm(cells[1]!).x - hexToMm(cells[0]!).x;
      expect(gap / SAME_ROW_STEP).toBeCloseTo(Math.round(gap / SAME_ROW_STEP), 9);
      expect(hexToMm(cells[1]!).y).toBeCloseTo(hexToMm(cells[0]!).y, 9);
      // ...and as wide as it goes: one more step would not fit on the FLAT part
      // of the back panel, which is what the rounded corners leave.
      const edge = 2 * (MIN_PEG_MARGIN_MM + cornerRadii(s).outer);
      const span = (s.pegs - 1) * (pegStep(s) + 1) * SAME_ROW_STEP;
      expect(span + PEG.acrossCorners + edge).toBeGreaterThan(outerMm(s).widthMm);
    }
  });

  it('leaves real material outside the outermost peg', () => {
    for (const s of SHAPES) {
      const centres = pegCentres(s);
      const outer = Math.max(...centres.map((c) => Math.abs(c.acrossMm)));
      // Measured to the flat back panel's edge, not the silhouette's: past that
      // line the panel is curving away and there is nothing to hold a peg.
      const backHalf = outerMm(s).widthMm / 2 - cornerRadii(s).outer;
      expect(backHalf - outer - PEG_RADIUS).toBeGreaterThanOrEqual(
        MIN_PEG_MARGIN_MM - 1e-9,
      );
    }
  });

  /**
   * The four shipped shelves, measured off `models/shelves/*.stl`.
   *
   *   part      tray width   pegs   gap        gap / ROW_STEP
   *   shelf-1    56.4072      2     40.876      2
   *   shelf-2    97.2833      2     81.752      4
   *   shelf-3   138.1598      2    122.626      6
   *   shelf-4   179.0352      3     81.752      4
   *
   * Read them as `pegStep`: each shelf puts its pegs as far apart as its own
   * width allows, in whole same-row steps. That rule was arrived at here from
   * the mechanics — two pegs bunched in the middle of a wide bin let it rock —
   * and then found to be what the designer already did. So it is worth pinning
   * against the real parts rather than against itself.
   *
   * The widths carry `2 × (MIN_PEG_MARGIN_MM + CORNER_RADIUS_MM)` because a
   * shelf's outermost peg IS the end of the tray, while a bin's is a hexagon in
   * the middle of the FLAT part of a back panel — which has to have material
   * round it, and stops a corner radius short of the silhouette on each side.
   */
  const SHELVES = [
    { name: 'shelf-1', widthMm: 56.4072, pegs: 2, steps: 1 },
    { name: 'shelf-2', widthMm: 97.2833, pegs: 2, steps: 2 },
    { name: 'shelf-3', widthMm: 138.1598, pegs: 2, steps: 3 },
    { name: 'shelf-4', widthMm: 179.0352, pegs: 3, steps: 2 },
  ];

  it('spaces its pegs the way all four shipped shelves do', () => {
    for (const shelf of SHELVES) {
      // The shelf's number is a TRAY width, which is an outside; a spec is an
      // inside. So the margin and the radius go on and the two walls come off.
      const s = spec({
        pegs: shelf.pegs,
        innerWidthMm:
          shelf.widthMm + 2 * (MIN_PEG_MARGIN_MM + CORNER_RADIUS_MM) - 2 * WALL,
        innerHeightMm: 30,
      });
      expect({ name: shelf.name, steps: pegStep(s) }).toEqual({
        name: shelf.name, steps: shelf.steps,
      });
      const cells = cellsFor(s).slice(0, shelf.pegs).map(hexToMm);
      for (let i = 1; i < cells.length; i++) {
        expect(cells[i]!.x - cells[i - 1]!.x).toBeCloseTo(shelf.steps * SAME_ROW_STEP, 9);
      }
    }
  });

  it('matches the two pegs of the shipped shelf-2 exactly', () => {
    // shelf-2 measures 81.752 mm between peg centres — 4 columns, 2 same-row
    // steps — so a 3-peg bin's outer pair must be the same distance apart.
    const cells = cellsFor(spec({ pegs: 3 }));
    const a = hexToMm(cells[0]!);
    const c = hexToMm(cells[2]!);
    expect(c.x - a.x).toBeCloseTo(81.752, 6);
    expect(c.y - a.y).toBeCloseTo(0, 12);
  });
});

/**
 * Is this point inside the solid? Parity of crossings along a SKEW ray.
 *
 * Skew on purpose. An axis-aligned ray through this geometry runs along faces
 * and through edges, and then registers a crossing twice or not at all — the
 * same degeneracy CLAUDE.md records against point-in-section tests on the
 * lattice. A direction sharing no plane with the model cannot do that.
 */
function inside(mesh: SolidMesh, px: number, py: number, pz: number): boolean {
  const dir = [0.7213, 0.4271, 0.5449];
  const p = mesh.positions;
  let hits = 0;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const i = t * 9;
    const e1 = [p[i + 3]! - p[i]!, p[i + 4]! - p[i + 1]!, p[i + 5]! - p[i + 2]!];
    const e2 = [p[i + 6]! - p[i]!, p[i + 7]! - p[i + 1]!, p[i + 8]! - p[i + 2]!];
    const h = [
      dir[1]! * e2[2]! - dir[2]! * e2[1]!,
      dir[2]! * e2[0]! - dir[0]! * e2[2]!,
      dir[0]! * e2[1]! - dir[1]! * e2[0]!,
    ];
    const det = e1[0]! * h[0]! + e1[1]! * h[1]! + e1[2]! * h[2]!;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const s0 = [px - p[i]!, py - p[i + 1]!, pz - p[i + 2]!];
    const u = inv * (s0[0]! * h[0]! + s0[1]! * h[1]! + s0[2]! * h[2]!);
    if (u < 0 || u > 1) continue;
    const q = [
      s0[1]! * e1[2]! - s0[2]! * e1[1]!,
      s0[2]! * e1[0]! - s0[0]! * e1[2]!,
      s0[0]! * e1[1]! - s0[1]! * e1[0]!,
    ];
    const v = inv * (dir[0]! * q[0]! + dir[1]! * q[1]! + dir[2]! * q[2]!);
    if (v < 0 || u + v > 1) continue;
    if (inv * (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) > 1e-9) hits++;
  }
  return hits % 2 === 1;
}

describe('the sizes are the INSIDE', () => {
  /*
   * The point of the whole spec being inner, checked on the solid rather than on
   * the arithmetic that produced it.
   *
   * Six probes just inside the cavity's faces and six just outside them. That
   * pins the hollow to exactly `innerWidth × innerDepth × innerHeight` — a wall
   * thickness applied twice, or once where it should be twice, moves one of the
   * twelve and nothing else would notice.
   *
   * All the probes sit on the mid-planes, clear of the rounded corners, which is
   * where the walls are flat and the claim is a plain distance.
   */
  const PROBES = [
    spec({ pegs: 2, innerWidthMm: 80, innerHeightMm: 70, innerDepthMm: 55 }),
    spec({ pegs: 3, innerWidthMm: 200, innerHeightMm: 40, innerDepthMm: 120, wallMm: 4 }),
    spec({ pegs: 5, innerWidthMm: 300, innerHeightMm: 150, innerDepthMm: 10, wallMm: 1.6 }),
    spec({ pegs: 2, innerWidthMm: minWidthMm(2, 5), innerHeightMm: 14, innerDepthMm: 30, wallMm: 5 }),
  ];

  it('hollows out exactly the box the sliders describe', () => {
    for (const s of PROBES) {
      const { mesh } = buildBinMesh(s);
      const t = s.wallMm;
      const e = Math.min(0.3, t / 3);

      /*
       * The claim, written from the SPEC and the wall alone.
       *
       * Deliberately not from `outerMm`: probes placed relative to the outside
       * would move with a wrong conversion and agree with it. Stated this way
       * the cavity has to be where a person reading the sliders would expect to
       * find it, whatever the box around it turns out to be.
       *
       * File frame: x out of the wall, y across it, z up it.
       */
      const x0 = t;
      const x1 = t + s.innerDepthMm;
      const y1 = s.innerWidthMm / 2;
      const z0 = t;
      const z1 = t + s.innerHeightMm;
      const midOut = (x0 + x1) / 2;
      const midUp = (z0 + z1) / 2;

      const hollow: [number, number, number][] = [
        [midOut, 0, midUp], //        the middle of it
        [x0 + e, 0, midUp], //        just clear of the back
        [x1 - e, 0, midUp], //        ...of the front
        [midOut, y1 - e, midUp], //   ...of the right wall
        [midOut, -(y1 - e), midUp], // ...of the left
        [midOut, 0, z0 + e], //       ...of the floor
        [midOut, 0, z1 - e], //       ...and still hollow just under the rim
      ];
      const solid: [number, number, number][] = [
        [x0 - e, 0, midUp], //        into the back panel
        [x1 + e, 0, midUp], //        ...the front wall
        [midOut, y1 + e, midUp], //   ...the right wall
        [midOut, -(y1 + e), midUp], // ...the left
        [midOut, 0, z0 - e], //       ...the floor
        [midOut, y1 + e, z1 - e], //  ...the wall just below the rim
      ];

      for (const [x, y, z] of hollow) {
        expect({ at: [x, y, z], solid: inside(mesh, x, y, z) })
          .toEqual({ at: [x, y, z], solid: false });
      }
      for (const [x, y, z] of solid) {
        expect({ at: [x, y, z], solid: inside(mesh, x, y, z) })
          .toEqual({ at: [x, y, z], solid: true });
      }
      // The rim is the top of the box: nothing at all above it, wall included.
      expect(inside(mesh, midOut, y1 + e, z1 + e)).toBe(false);
      expect(inside(mesh, midOut, 0, z1 + e)).toBe(false);
    }
  });
});

describe('pegs placed by hand', () => {
  /*
   * The automatic layout is a grid — every row on the same columns. A person
   * picking cells is not, and the interesting case is a STAGGERED pair: two
   * cells one column apart sit half a pitch up from each other, which the old
   * hole-cutting could not express at all (D110).
   */
  const byHand = (cells: { q: number; r: number }[]): BinSpec =>
    normaliseBinSpec({
      ...spec({ pegs: 3, innerWidthMm: 200, innerHeightMm: 120 }),
      cells,
      latticeOffset: { x: 0, y: PEG.acrossFlats / 2 },
    });

  it('puts a peg at every cell asked for and nowhere else', () => {
    const s = byHand([{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 4, r: -1 }, { q: 0, r: 3 }]);
    expect(cellsFor(s)).toHaveLength(4);
    const { mesh } = buildBinMesh(s);

    // Section 2 mm along the pegs: they are the only thing out there.
    const section = sectionAtX(mesh, -2);
    const offset = { x: 0, y: PEG.acrossFlats / 2 };
    for (const cell of cellsFor(s)) {
      const want = cellPointMm(cell, offset);
      const near = section.filter(
        (p) => Math.hypot(p.y - want.acrossMm, p.z - want.upMm) < PEG_RADIUS + 0.01,
      );
      expect({ cell, found: near.length > 5 }).toEqual({ cell, found: true });
      const zs = near.map((p) => p.z);
      expect((Math.min(...zs) + Math.max(...zs)) / 2).toBeCloseTo(want.upMm, 6);
      expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(PEG.acrossFlats, 6);
    }
    // Four pegs and no more: every section point belongs to one of them.
    const stray = section.filter((p) =>
      cellsFor(s).every((cell) => {
        const w = cellPointMm(cell, offset);
        return Math.hypot(p.y - w.acrossMm, p.z - w.upMm) > PEG_RADIUS + 0.01;
      }),
    );
    expect(stray).toEqual([]);
  });

  it('stays closed and outward with staggered cells the grid could not express', () => {
    for (const cells of [
      [{ q: 0, r: 0 }, { q: 1, r: 0 }],
      [{ q: 0, r: 0 }, { q: 1, r: 1 }, { q: 3, r: -1 }, { q: 2, r: 2 }],
      [{ q: 0, r: 0 }],
      [],
    ]) {
      const { mesh } = buildBinMesh(byHand(cells));
      expect({ cells, ...meshIsClosed(mesh) })
        .toEqual({ cells, closed: true, unmatchedEdges: 0, degenerate: 0 });
      expect(signedVolume(mesh)).toBeGreaterThan(0);
    }
  });

  it('keeps hand-placed pegs where they were put when the bin is resized', () => {
    /*
     * The automatic origin moves with the peg count and the width — a wider bin
     * spreads its pegs, which slides the first one. A frozen `latticeOffset` is
     * what stops a resize walking somebody's chosen cells across the panel.
     */
    const cells = [{ q: 0, r: 0 }, { q: 2, r: -1 }];
    const narrow = byHand(cells);
    const wide = normaliseBinSpec({ ...narrow, innerWidthMm: 340, pegs: 7 });
    expect(pegCentres(wide)).toEqual(pegCentres(narrow));
  });

  it('and the automatic layout still moves with the width, as it should', () => {
    const narrow = spec({ pegs: 2, innerWidthMm: 90 });
    const wide = spec({ pegs: 2, innerWidthMm: 300 });
    expect(pegCentres(wide)[0]!.acrossMm).toBeLessThan(pegCentres(narrow)[0]!.acrossMm);
  });

  it('counts what bridges from the pegs, not from the rows', () => {
    // Only a peg sitting its flat on the bed prints unsupported.
    expect(bridgingPegs(byHand([{ q: 0, r: 0 }, { q: 2, r: -1 }]))).toBe(0);
    expect(bridgingPegs(byHand([{ q: 0, r: 0 }, { q: 0, r: 2 }]))).toBe(1);
    expect(bridgingPegs(byHand([{ q: 1, r: 0 }]))).toBe(1); // staggered: half a pitch up
  });
});

describe('the cells you can click', () => {
  it('puts every pad exactly where its cell is on the wall', () => {
    /*
     * The preview draws a pad per cell at `place + (acrossMm, upMm)`, where
     * `place` takes the bin's own frame into the wall's. If those two drift you
     * click one pad and a peg appears at a different cell — which looks like a
     * broken raycast and is actually arithmetic.
     *
     * `place` is stated here the way the view states it, and checked against
     * `hexToMm` rather than against the expression that produced it.
     */
    for (const s of [
      spec({ pegs: 2 }),
      spec({ pegs: 5, innerWidthMm: 320 }),
      normaliseBinSpec({
        ...spec({ pegs: 3 }),
        cells: [{ q: 1, r: 1 }],
        latticeOffset: { x: -7.5, y: 9 },
      }),
    ]) {
      const zero = hexToMm({ q: 0, r: 0 });
      const offset = latticeOffsetMm(s);
      const place = { x: zero.x - offset.x, y: zero.y - offset.y };
      const pads = backPanelCells(s);
      expect(pads.length).toBeGreaterThan(0);
      for (const pad of pads) {
        const want = hexToMm(pad.cell);
        expect(place.x + pad.acrossMm).toBeCloseTo(want.x, 9);
        expect(place.y + pad.upMm).toBeCloseTo(want.y, 9);
      }
    }
  });

  it('offers a cell whose peg overhangs the panel, and marks it', () => {
    // Allowed, because the width is a slider away — the same rule the peg adder
    // arrived at. Marked, because it is worth seeing before it is printed.
    const s = spec({ pegs: 2, innerHeightMm: 70 });
    const pads = backPanelCells(s);
    const { heightMm } = panelExtentMm(s);
    for (const pad of pads) {
      const fits = pad.upMm - PEG.acrossFlats / 2 >= -1e-9
        && pad.upMm + PEG.acrossFlats / 2 <= heightMm + 1e-9
        && Math.abs(pad.acrossMm) + PEG_RADIUS <= panelExtentMm(s).halfWidthMm + 1e-9;
      expect({ at: pad.upMm, whole: pad.whole }).toEqual({ at: pad.upMm, whole: fits });
    }
    expect(pads.some((p) => !p.whole)).toBe(true);
  });
});

describe('the plate the preview draws it against', () => {
  it('always contains every peg cell', () => {
    // The preview's whole argument is that the pegs land in real holes. A patch
    // that missed them would put a peg on the WEB between two cells and look
    // very nearly right, so it is checked here rather than by eye.
    for (const s of SHAPES) {
      const { origin, columns, rows } = previewPatch(s);
      const patch = new Set(panelCells(origin, columns, rows).map(hexKey));
      for (const cell of cellsFor(s)) expect(patch.has(hexKey(cell))).toBe(true);
    }
  });

  it('leaves plate showing on every side of the bin', () => {
    for (const s of SHAPES) {
      const { origin, columns, rows } = previewPatch(s);
      const patch = panelCells(origin, columns, rows).map(hexToMm);
      const pegs = cellsFor(s).map(hexToMm);
      expect(Math.min(...patch.map((p) => p.x))).toBeLessThan(Math.min(...pegs.map((p) => p.x)));
      expect(Math.max(...patch.map((p) => p.x))).toBeGreaterThan(Math.max(...pegs.map((p) => p.x)));
      expect(Math.min(...patch.map((p) => p.y))).toBeLessThan(Math.min(...pegs.map((p) => p.y)));
      expect(Math.max(...patch.map((p) => p.y))).toBeGreaterThan(Math.max(...pegs.map((p) => p.y)));
    }
  });
});

describe('the mesh', () => {
  it('is closed and consistently wound at every size', () => {
    for (const s of SHAPES) {
      const { mesh } = buildBinMesh(s);
      const closed = meshIsClosed(mesh);
      expect({ ...closed, s }).toEqual({ closed: true, unmatchedEdges: 0, degenerate: 0, s });
    }
  });

  it('is wound outward, not inside out', () => {
    for (const s of SHAPES) {
      const { mesh } = buildBinMesh(s);
      expect(signedVolume(mesh)).toBeGreaterThan(0);
    }
  });

  it('encloses roughly the shell it should, corners included', () => {
    const s = spec({ pegs: 2, innerWidthMm: 90, innerHeightMm: 60, innerDepthMm: 50 });
    const { mesh } = buildBinMesh(s);
    const { outer: rOut, inner: rIn } = cornerRadii(s);
    const box3 = outerMm(s);
    // A rounded rectangle is the rectangle less what four quarter-circles leave
    // in the corners of their own squares: (4 − π)·r². Including that here is
    // what makes this a check on the ROUNDING and not just on the box.
    const round = (w: number, d: number, r: number): number => w * d - (4 - Math.PI) * r * r;
    const box = round(box3.widthMm, box3.depthMm, rOut) * box3.heightMm;
    // The cavity is the SPEC, which is the inside — that is the whole point of
    // the spec being inner, and this line is where it is checked.
    const cavity = round(s.innerWidthMm, s.innerDepthMm, rIn) * s.innerHeightMm;
    /*
     * A regular hexagon of across-flats w has area w²·√3/2, and a peg is that by
     * its whole length INCLUDING the seat buried in the back panel.
     *
     * The seat is counted twice on purpose: a peg is a separate solid that
     * overlaps the panel (D110), so a signed volume over the raw triangles adds
     * it to both. That is the honest number for this mesh, and saying so here is
     * what keeps the test a measurement rather than a fudge — a slicer unions
     * the two and prints the smaller figure.
     */
    const seat = Math.min(2, s.wallMm - 0.4);
    const oneP = ((PEG.acrossFlats ** 2 * Math.sqrt(3)) / 2) * (PEG.lengthMm + seat);
    const pegs = pegCentres(s).length * oneP;
    // The arcs are 6 chords each, so the mesh holds a shade less than the true
    // rounded rectangle — a percent, not a corner's worth.
    expect(signedVolume(mesh)).toBeGreaterThan((box - cavity + pegs) * 0.98);
    expect(signedVolume(mesh)).toBeLessThan(box - cavity + pegs);
  });

  it('rounds all four vertical corners, measured on the silhouette', () => {
    /*
     * A corner radius is only visible off-axis: `w × d` is unchanged by it, so a
     * bounding box says nothing. The DIAGONAL does. For a rounded rectangle the
     * furthest point toward the corner is the arc centre plus r along (1,1)/√2,
     * so `max(a + d)` comes out `halfW + D − r(2 − √2)` — and a sharp box would
     * read `halfW + D` exactly.
     *
     * It lands on a vertex rather than between two: 90° in six steps puts one at
     * 45°.
     */
    for (const s of SHAPES) {
      const { mesh } = buildBinMesh(s);
      const r = cornerRadii(s).outer;
      const box = outerMm(s);
      const half = box.widthMm / 2;
      let far = -Infinity;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        // File axes: x is out of the wall, y across it.
        far = Math.max(far, mesh.positions[i]! + mesh.positions[i + 1]!);
      }
      expect(far).toBeCloseTo(half + box.depthMm - r * (2 - Math.SQRT2), 6);
      expect(far).toBeLessThan(half + box.depthMm - 0.5);
    }
  });

  it('puts the bottom pegs flat on the bed and nothing below them', () => {
    const { mesh } = buildBinMesh(spec());
    let minZ = Infinity;
    let onBed = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const z = mesh.positions[i + 2]!;
      if (z < minZ) minZ = z;
      if (Math.abs(z) < 1e-9) onBed++;
    }
    expect(minZ).toBe(0);
    // The underside of the box and the bottom flats of the bottom pegs.
    expect(onBed).toBeGreaterThan(12);
  });

  it('makes the peg 13.45 across flats where it grips', () => {
    const { mesh } = buildBinMesh(spec({ pegs: 2 }));
    const centres = pegCentres(spec({ pegs: 2 }));
    // A cut 2 mm along the peg, inside the straight section.
    // The BOTTOM-left peg: a section at this depth cuts every peg, and the top
    // row sits directly above this one.
    const section = sectionAtX(mesh, -2);
    const left = section.filter(
      (p) => Math.abs(p.y - centres[0]!.acrossMm) < PEG_RADIUS + 1 && p.z < PEG.acrossFlats + 1,
    );
    const zs = left.map((p) => p.z);
    const ys = left.map((p) => p.y);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(PEG.acrossFlats, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(PEG.acrossCorners, 6);
  });

  it('tapers the peg on five faces and leaves the bottom on the bed', () => {
    const { mesh } = buildBinMesh(spec({ pegs: 2 }));
    // 7.7 mm along: the shipped peg measures its sides drawn in 0.278 and its
    // bottom flat still at zero. Reproduce that, not a cone.
    const section = sectionAtX(mesh, -7.6);
    const zs = section.filter((p) => p.z < PEG.acrossFlats + 1).map((p) => p.z);
    expect(Math.min(...zs)).toBeCloseTo(0, 3);
    expect(Math.max(...zs)).toBeLessThan(PEG.acrossFlats);
    expect(Math.max(...zs)).toBeGreaterThan(PEG.acrossFlats - 0.6);
  });
});

describe('the file that comes out', () => {
  it('round-trips through the STL writer with the same solid in it', () => {
    // What the Download button hands over is these bytes, so the check is on the
    // bytes and not on the mesh they were made from.
    const s = spec({ pegs: 3, innerHeightMm: 90 });
    const built = buildBinMesh(s);
    const read = parseStl(toBinaryStl(built.mesh, 'bin'));
    expect(read.triangleCount).toBe(built.mesh.triangleCount);
    const measured = measureMesh(read);
    // Float32 on the way out, so relative and not absolute.
    expect(measured.volumeMm3 / signedVolume(built.mesh)).toBeCloseTo(1, 5);
    // Written in the print orientation: standing on the bed, height on z — and
    // it is the OUTSIDE height, floor included, that a bed has to clear.
    expect(measured.bboxMm[2]).toBeCloseTo(outerMm(s).heightMm, 3);
    expect(measured.minMm[2]).toBeCloseTo(0, 6);
  });

  it('overhangs nothing at all when it hangs on one row of pegs', () => {
    /*
     * The claim the panel makes in words, measured. `measureMesh` counts
     * downward faces steeper than 45° and excludes the one the part is printed
     * on — so a bin whose only pegs are the bottom row, with their flats ON the
     * bed, must come out at exactly zero. It is the reason `PEG_PROFILE` leaves
     * the bottom face undrafted, checked from the other end.
     */
    for (const s of SHAPES) {
      const built = buildBinMesh(s);
      const measured = measureMesh(parseStl(toBinaryStl(built.mesh)));
      if (built.bridgeMm === 0) {
        expect(measured.overhangAreaMm2).toBeCloseTo(0, 6);
      } else {
        /*
         * ...and when there IS a top row, what overhangs is its pegs' bottom
         * flats and NOTHING ELSE. The flat is `PEG_RADIUS` wide — corner 4 to
         * corner 5 — by the peg's whole length, seat included.
         *
         * The seat is buried in the back panel, so that part of the flat is not
         * a real overhang; `measureMesh` counts triangles and cannot see that
         * the panel is on the other side of it. `topRowBridgesMm` reports the 8
         * mm that actually bridges, which is the number the panel shows.
         */
        const seat = Math.min(2, s.wallMm - 0.4);
        const flat = PEG_RADIUS * (PEG.lengthMm + seat) * (built.cells.length / 2);
        expect(measured.overhangAreaMm2).toBeGreaterThan(flat * 0.88);
        expect(measured.overhangAreaMm2).toBeLessThan(flat * 1.02);
      }
    }
  });
});

describe('how it is drawn on the wall', () => {
  it('never needs a nudge the override reader would clamp', () => {
    for (const s of SHAPES) {
      // MAX_OFFSET_MM is 40. Anything approaching it means `topPegRow` has
      // stopped keeping the top row near the top of the bin.
      expect(Math.abs(drawOffsetYMm(s))).toBeLessThan(s.pegs === 1 ? 40 : 13);
    }
  });

  it('hangs a short bin on one row and a tall one on two', () => {
    expect(cellsFor(spec({ pegs: 2, innerHeightMm: 20 }))).toHaveLength(2);
    expect(cellsFor(spec({ pegs: 2, innerHeightMm: 200 }))).toHaveLength(4);
  });
});

describe('the limits', () => {
  it('refuses a bin too narrow for its pegs by widening it', () => {
    for (let pegs = MIN_PEGS; pegs <= MAX_PEGS; pegs++) {
      const s = normaliseBinSpec({
        pegs, innerWidthMm: 1, innerHeightMm: 60, innerDepthMm: 60, wallMm: WALL,
      });
      expect(s.innerWidthMm).toBe(minWidthMm(pegs, WALL));
      // ...and the widened bin still holds its outermost peg whole.
      const { mesh } = buildBinMesh(s);
      expect(meshIsClosed(mesh).closed).toBe(true);
    }
  });

  it('takes nonsense without producing nonsense', () => {
    const s = normaliseBinSpec({
      pegs: Number.NaN,
      innerWidthMm: -5,
      innerHeightMm: Infinity,
      innerDepthMm: 0,
      wallMm: 900,
    });
    expect(s.pegs).toBe(MIN_PEGS);
    expect(s.innerWidthMm).toBeGreaterThanOrEqual(minWidthMm(MIN_PEGS, s.wallMm));
    expect(Number.isFinite(s.innerHeightMm)).toBe(true);
    expect(meshIsClosed(buildBinMesh(s).mesh).closed).toBe(true);
  });
});

/**
 * Where a plane x = value cuts the mesh, as points.
 *
 * Only the crossing points, so a section through the straight part of a peg
 * gives that peg's hexagon and nothing else in that neighbourhood.
 */
function sectionAtX(mesh: SolidMesh, value: number): { y: number; z: number }[] {
  const p = mesh.positions;
  const out: { y: number; z: number }[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    const i = t * 9;
    const v = [0, 1, 2].map((k) => ({
      x: p[i + k * 3]!, y: p[i + k * 3 + 1]!, z: p[i + k * 3 + 2]!,
    }));
    for (let k = 0; k < 3; k++) {
      const a = v[k]!;
      const b = v[(k + 1) % 3]!;
      if ((a.x < value) === (b.x < value)) continue;
      const f = (value - a.x) / (b.x - a.x);
      out.push({ y: a.y + f * (b.y - a.y), z: a.z + f * (b.z - a.z) });
    }
  }
  return out;
}
