/**
 * Pegs bolted onto somebody else's model.
 *
 * Three questions, and they fail in different ways:
 *
 *   - is the part TURNED or MIRRORED? A mirrored part's pegs still land on the
 *     lattice, so nothing downstream would notice — the signed volume is what
 *     notices;
 *   - are the offered cells the ones with part behind them? Checked against a
 *     mesh with a known hole in it, not against the rule that produced it;
 *   - are the pegs where the cells say? Measured on the finished mesh, through
 *     `hexToMm`, the same way `bin-model.test.ts` does it.
 */

import { describe, expect, it } from 'vitest';

import { PEG, PEG_RADIUS } from '../src/core/constants';
import { hexToMm } from '../src/core/hex';
import { meshIsClosed, type SolidMesh } from '../src/core/honeycomb';
import { parseModelFile } from '../src/core/modelFile';
import { toBinaryStl } from '../src/core/honeycomb';
import { measureMesh, parseStl } from '../src/core/stl';
import { make3mf, modelXml } from './fixtures/threemf';
import {
  bestFace,
  buildPeggedMesh,
  candidateCells,
  cellAtMm,
  cellPointMm,
  DEFAULT_ORIENTATION,
  faceTowardWall,
  orientForPegs,
  reviewPegs,
  type Orientation,
  type OrientedPart,
  type PegPlan,
} from '../src/core/pegAdder';
import { buildPegSolid, PEG_SEAT_MM } from '../src/core/pegMesh';
import type { MeshData } from '../src/core/stl';

// ---------------------------------------------------------------------------
// A stand-in for an upload
// ---------------------------------------------------------------------------

/** One axis-aligned box, closed and wound outward. */
function box(
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
): number[] {
  const v = (x: number, y: number, z: number): number[] => [x, y, z];
  const quad = (
    a: number[], b: number[], c: number[], d: number[],
  ): number[] => [...a, ...b, ...c, ...a, ...c, ...d];
  const p = [
    v(x0, y0, z0), v(x1, y0, z0), v(x1, y1, z0), v(x0, y1, z0),
    v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1),
  ];
  return [
    ...quad(p[0]!, p[3]!, p[2]!, p[1]!), // z0, facing −z
    ...quad(p[4]!, p[5]!, p[6]!, p[7]!), // z1, facing +z
    ...quad(p[0]!, p[1]!, p[5]!, p[4]!), // y0
    ...quad(p[1]!, p[2]!, p[6]!, p[5]!), // x1
    ...quad(p[2]!, p[3]!, p[7]!, p[6]!), // y1
    ...quad(p[3]!, p[0]!, p[4]!, p[7]!), // x0
  ];
}

const mesh = (...parts: number[][]): MeshData => {
  const all = parts.flat();
  return { positions: Float32Array.from(all), triangleCount: all.length / 9, format: 'binary' };
};

/** A plain plate: 120 across, 90 up, 6 thick, its face on z = 0. */
const PLATE = mesh(box(-60, 60, -45, 45, 0, 6));

/** The same plate with a 40 mm gap down the middle of it. */
const SPLIT = mesh(box(-60, -20, -45, 45, 0, 6), box(20, 60, -45, 45, 0, 6));

function signedVolume(positions: ArrayLike<number>, triangles: number): number {
  let v = 0;
  for (let t = 0; t < triangles; t++) {
    const i = t * 9;
    const ax = positions[i]!, ay = positions[i + 1]!, az = positions[i + 2]!;
    const bx = positions[i + 3]!, by = positions[i + 4]!, bz = positions[i + 5]!;
    const cx = positions[i + 6]!, cy = positions[i + 7]!, cz = positions[i + 8]!;
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

const ORIENTATIONS: Orientation[] = [];
for (const wallFaceAxis of ['x', 'y', 'z'] as const) {
  for (const matingEnd of ['low', 'high'] as const) {
    for (const quarterTurns of [0, 1, 2, 3]) {
      ORIENTATIONS.push({ wallFaceAxis, matingEnd, quarterTurns });
    }
  }
}

// ---------------------------------------------------------------------------

describe('turning the upload', () => {
  it('is a rotation and never a mirror, on all 24 orientations', () => {
    // A reflection negates the signed volume, and it is the ONLY thing here
    // that would notice: a mirrored part's pegs still sit on the lattice, still
    // print, and are a left-hand hook on a right-hand wall.
    const before = signedVolume(PLATE.positions, PLATE.triangleCount);
    expect(before).toBeGreaterThan(0);
    for (const o of ORIENTATIONS) {
      const part = orientForPegs(PLATE, o);
      const after = signedVolume(part.positions, part.triangleCount);
      expect({ o, sign: Math.sign(after) }).toEqual({ o, sign: 1 });
      expect(after).toBeCloseTo(before, 3);
    }
  });

  it('puts the wall face on zero, stands the part on the bed and centres it', () => {
    for (const o of ORIENTATIONS) {
      const part = orientForPegs(PLATE, o);
      let minOut = Infinity;
      let minUp = Infinity;
      let minAcross = Infinity;
      let maxAcross = -Infinity;
      for (let i = 0; i < part.positions.length; i += 3) {
        minOut = Math.min(minOut, part.positions[i]!);
        minAcross = Math.min(minAcross, part.positions[i + 1]!);
        maxAcross = Math.max(maxAcross, part.positions[i + 1]!);
        minUp = Math.min(minUp, part.positions[i + 2]!);
      }
      expect(minOut).toBeCloseTo(0, 9); // the wall face
      expect(minUp).toBeCloseTo(0, 9); // the printer's bed
      expect(minAcross + maxAcross).toBeCloseTo(0, 9); // centred across
    }
  });

  it('reports the size in the order it is drawn: out, across, up', () => {
    const flat = orientForPegs(PLATE, { wallFaceAxis: 'z', matingEnd: 'low', quarterTurns: 0 });
    expect(flat.sizeMm[0]).toBeCloseTo(6, 6);
    expect(flat.sizeMm[1]).toBeCloseTo(120, 6);
    expect(flat.sizeMm[2]).toBeCloseTo(90, 6);
    // A quarter turn swaps across and up, and leaves the depth alone.
    const turned = orientForPegs(PLATE, { wallFaceAxis: 'z', matingEnd: 'low', quarterTurns: 1 });
    expect(turned.sizeMm[0]).toBeCloseTo(6, 6);
    expect(turned.sizeMm[1]).toBeCloseTo(90, 6);
    expect(turned.sizeMm[2]).toBeCloseTo(120, 6);
  });
});

describe('the lattice under the part', () => {
  it('spaces cells exactly as hexToMm does, wherever the lattice is slid', () => {
    for (const offset of [{ x: 0, y: 45 }, { x: -13.7, y: 3.25 }, { x: 101, y: -8 }]) {
      for (const cell of [{ q: 0, r: 0 }, { q: 2, r: -1 }, { q: 1, r: 3 }, { q: -3, r: 2 }]) {
        const here = cellPointMm(cell, offset);
        const zero = cellPointMm({ q: 0, r: 0 }, offset);
        const want = hexToMm(cell);
        const wantZero = hexToMm({ q: 0, r: 0 });
        expect(here.x - zero.x).toBeCloseTo(want.x - wantZero.x, 9);
        expect(here.y - zero.y).toBeCloseTo(want.y - wantZero.y, 9);
      }
    }
  });

  it('round-trips a cell through the point it sits at', () => {
    const offset = { x: 7.5, y: -2.25 };
    for (const cell of [{ q: 0, r: 0 }, { q: 4, r: -2 }, { q: -1, r: 5 }]) {
      expect(cellAtMm(cellPointMm(cell, offset), offset)).toEqual(cell);
    }
  });
});

describe('how well a cell is backed', () => {
  const offset = { x: 0, y: 45 };
  const plate = orientForPegs(PLATE, { wallFaceAxis: 'z', matingEnd: 'low', quarterTurns: 0 });

  it('grades a cell wholly on the part as solid', () => {
    const found = candidateCells(plate, offset);
    expect(found.some((c) => c.backing === 'solid')).toBe(true);

    for (const c of found) {
      // The part is 120 × 90 with its face on the plane, so a hexagon wholly
      // inside that rectangle is solid. Checked against the RECTANGLE, not
      // against the rule the code used.
      const inside =
        c.atMm.x - PEG_RADIUS >= -60 &&
        c.atMm.x + PEG_RADIUS <= 60 &&
        c.atMm.y - PEG.acrossFlats / 2 >= 0 &&
        c.atMm.y + PEG.acrossFlats / 2 <= 90;
      if (inside) {
        expect({ at: c.atMm, backing: c.backing }).toEqual({ at: c.atMm, backing: 'solid' });
      }
    }
  });

  it('offers cells OUTSIDE the part, graded bare', () => {
    /*
     * The tool does not refuse a peg off the silhouette — that is a decision,
     * and the person making it can see the part. What it must do is offer the
     * cell and say what it is.
     */
    const found = candidateCells(plate, offset);
    const outside = found.filter(
      (c) => c.atMm.x - PEG_RADIUS > 60 || c.atMm.x + PEG_RADIUS < -60,
    );
    expect(outside.length).toBeGreaterThan(0);
    for (const c of outside) {
      expect({ at: c.atMm, backing: c.backing }).toEqual({ at: c.atMm, backing: 'bare' });
    }
  });

  it('grades a cell over a hole as anything but solid', () => {
    const split = orientForPegs(SPLIT, { wallFaceAxis: 'z', matingEnd: 'low', quarterTurns: 0 });
    const found = candidateCells(split, offset);
    // The gap runs from −20 to +20 across the middle, so anything whose hexagon
    // reaches into it has less than solid material to weld to.
    for (const c of found) {
      if (Math.abs(c.atMm.x) < 20 + PEG_RADIUS - 1) {
        expect({ at: c.atMm, solid: c.backing === 'solid' })
          .toEqual({ at: c.atMm, solid: false });
      }
    }
    expect(found.filter((c) => c.backing === 'solid').length).toBeGreaterThan(3);
  });

  it('grades skin as partial, not solid — it is attached but thin', () => {
    // 1 mm of plate: the face is fully covered, so it is not bare, and the back
    // face falls inside the seat, so it is not solid either. A single raster at
    // the wall face would call this solid and the peg would come off.
    const skin = orientForPegs(
      mesh(box(-60, 60, -45, 45, 0, 1)),
      { wallFaceAxis: 'z', matingEnd: 'low', quarterTurns: 0 },
    );
    const over = candidateCells(skin, offset).filter((c) => c.coverage > 0.99);
    expect(over.length).toBeGreaterThan(0);
    expect(over.every((c) => c.backing === 'partial')).toBe(true);
    expect(PEG_SEAT_MM).toBeGreaterThan(1);
  });
});

describe('a 3MF in, an STL out', () => {
  /*
   * The tool reads both formats and writes one, so it doubles as a converter —
   * and since the download used to be refused until a cell was picked, that was
   * the one thing it could not do.
   *
   * Checked on a REAL 3MF: a genuine ZIP with correct CRCs, built by the same
   * fixture `threemf.test.ts` uses. A hand-made `MeshData` would prove the STL
   * writer works and nothing about the format this is meant to accept.
   */
  it('converts with no pegs at all, and the geometry survives', async () => {
    const { mesh, warnings } = await parseModelFile('cube.3mf', await make3mf(modelXml()));
    expect(mesh.format).toBe('3mf');
    expect(warnings).toEqual([]);

    const part = orientForPegs(mesh, bestFace(mesh));
    const plan: PegPlan = { ...bestFace(mesh), latticeOffset: { x: 0, y: 5 }, cells: [] };

    // Nothing stops it. That is the whole change.
    expect(reviewPegs(part, plan).errors).toEqual([]);

    const out = buildPeggedMesh(part, plan);
    expect(out.triangleCount).toBe(mesh.triangleCount);

    // ...and what comes out is a binary STL a slicer will take.
    const stl = toBinaryStl(out, 'cube');
    expect(stl.byteLength).toBe(84 + 50 * out.triangleCount);
    const read = parseStl(stl);
    expect(read.triangleCount).toBe(12);
    const measured = measureMesh(read);
    // The fixture is a 10 mm cube. Turned, not resized, and not mirrored.
    expect([...measured.bboxMm].sort((a, b) => a - b)).toEqual([10, 10, 10]);
    expect(measured.volumeMm3).toBeCloseTo(1000, 3);
    expect(signedVolume(out.positions, out.triangleCount)).toBeGreaterThan(0);
  });

  it('converts an inch 3MF at the size it really is', async () => {
    // A 3MF DECLARES its unit and this one is inches, so the cube is 254 mm.
    // Conversion has to carry that through — a silently 25.4× wrong STL is the
    // failure `threemf.ts` exists to prevent, and it must survive this path too.
    const { mesh } = await parseModelFile('inch.3mf', await make3mf(modelXml({ unit: 'inch' })));
    const part = orientForPegs(mesh, DEFAULT_ORIENTATION);
    const out = buildPeggedMesh(part, {
      ...DEFAULT_ORIENTATION, latticeOffset: { x: 0, y: 0 }, cells: [],
    });
    const measured = measureMesh(parseStl(toBinaryStl(out)));
    expect(measured.bboxMm[0]).toBeCloseTo(254, 3);
  });

  it('still welds pegs into a 3MF, so converting is not a separate path', async () => {
    const { mesh } = await parseModelFile('cube.3mf', await make3mf(modelXml()));
    const part = orientForPegs(mesh, DEFAULT_ORIENTATION);
    const plan: PegPlan = {
      ...DEFAULT_ORIENTATION,
      latticeOffset: { x: 0, y: 5 },
      cells: [{ q: 0, r: 0 }],
    };
    const out = buildPeggedMesh(part, plan);
    expect(out.triangleCount).toBe(
      mesh.triangleCount + buildPegSolid({ a: 0, u: 0 }).triangleCount,
    );
  });
});

describe('the face it opens on', () => {
  it('picks the face with the most cells on it, not the first axis', () => {
    // A plate lying in the x/y plane: only its two big faces can hold a peg, and
    // the four edges are 6 mm strips. Opening on an edge and reporting "0 of 13
    // can take a peg" is a tool that looks broken on its first screen.
    const flat = mesh(box(-60, 60, -45, 45, 0, 6));
    expect(bestFace(flat).wallFaceAxis).toBe('z');

    // ...and it follows the plate when the plate moves. Same solid, standing on
    // its edge: now the big faces are the y ones.
    const standing = mesh(box(-60, 60, 0, 6, -45, 45));
    expect(bestFace(standing).wallFaceAxis).toBe('y');
  });

  it('is a real search and not a guess: it beats the default', () => {
    const standing = mesh(box(-60, 60, 0, 6, -45, 45));
    const chosen = orientForPegs(standing, bestFace(standing));
    const fallback = orientForPegs(standing, { wallFaceAxis: 'z', matingEnd: 'low', quarterTurns: 0 });
    const count = (p: ReturnType<typeof orientForPegs>): number =>
      candidateCells(p, { x: 0, y: p.sizeMm[2] / 2 })
        .filter((c) => c.backing === 'solid').length;
    expect(count(chosen)).toBeGreaterThan(count(fallback));
  });
});

describe('the peg itself', () => {
  it('is a closed solid, wound outward', () => {
    const peg = buildPegSolid({ a: 0, u: 0 });
    const solid: SolidMesh = {
      positions: Float64Array.from(peg.positions),
      triangleCount: peg.triangleCount,
    };
    expect(meshIsClosed(solid)).toEqual({ closed: true, unmatchedEdges: 0, degenerate: 0 });
    expect(signedVolume(solid.positions, solid.triangleCount)).toBeGreaterThan(0);
  });

  it('measures 13.45 across flats where it grips, and reaches the seat', () => {
    const peg = buildPegSolid({ a: 0, u: 0 });
    let minOut = Infinity;
    let maxOut = -Infinity;
    const flats: number[] = [];
    for (let i = 0; i < peg.positions.length; i += 3) {
      const out = peg.positions[i]!;
      minOut = Math.min(minOut, out);
      maxOut = Math.max(maxOut, out);
      // The straight section: the wall face out to 4 mm along.
      if (out <= 0 && out >= -4) flats.push(peg.positions[i + 2]!);
    }
    expect(maxOut).toBeCloseTo(PEG_SEAT_MM, 9); // buried in the part
    expect(minOut).toBeCloseTo(-PEG.lengthMm, 9); // ...and a whole peg out
    expect(Math.max(...flats) - Math.min(...flats)).toBeCloseTo(PEG.acrossFlats, 6);
  });
});

describe('the file that comes out', () => {
  const plate = orientForPegs(PLATE, { wallFaceAxis: 'z', matingEnd: 'low', quarterTurns: 0 });
  const plan: PegPlan = {
    wallFaceAxis: 'z',
    matingEnd: 'low',
    quarterTurns: 0,
    latticeOffset: { x: 0, y: 45 },
    cells: [{ q: 0, r: 0 }, { q: 2, r: -1 }, { q: 0, r: 1 }, { q: 2, r: 0 }],
  };

  it('closes, even though it is several shells', () => {
    // Adding a peg is an OVERLAP, not a boolean: the output is the part plus one
    // closed solid per peg, which is what a slicer unions. Every directed edge
    // still has exactly one opposite, so this holds — what it is NOT is one
    // connected component, and that is on purpose.
    const out = buildPeggedMesh(plate, plan);
    expect(meshIsClosed(out)).toEqual({ closed: true, unmatchedEdges: 0, degenerate: 0 });
    expect(out.triangleCount).toBe(plate.triangleCount + 4 * buildPegSolid({ a: 0, u: 0 }).triangleCount);
  });

  it('puts every peg exactly on its own cell, measured on the mesh', () => {
    const out = buildPeggedMesh(plate, plan);
    // The pegs are the only thing outside the part, so a section beyond the wall
    // face cuts them and nothing else.
    const at = -2;
    const hits: { y: number; z: number }[] = [];
    for (let t = 0; t < out.triangleCount; t++) {
      const i = t * 9;
      for (let k = 0; k < 3; k++) {
        const a = { x: out.positions[i + k * 3]!, y: out.positions[i + k * 3 + 1]!, z: out.positions[i + k * 3 + 2]! };
        const j = (k + 1) % 3;
        const b = { x: out.positions[i + j * 3]!, y: out.positions[i + j * 3 + 1]!, z: out.positions[i + j * 3 + 2]! };
        if ((a.x < at) === (b.x < at)) continue;
        const f = (at - a.x) / (b.x - a.x);
        hits.push({ y: a.y + f * (b.y - a.y), z: a.z + f * (b.z - a.z) });
      }
    }
    for (const cell of plan.cells) {
      const want = cellPointMm(cell, plan.latticeOffset);
      const mine = hits.filter(
        (h) => Math.hypot(h.y - want.x, h.z - want.y) < PEG_RADIUS + 0.01,
      );
      expect(mine.length).toBeGreaterThan(5);
      const y = mine.map((h) => h.y);
      const z = mine.map((h) => h.z);
      expect((Math.min(...y) + Math.max(...y)) / 2).toBeCloseTo(want.x, 6);
      expect((Math.min(...z) + Math.max(...z)) / 2).toBeCloseTo(want.y, 6);
      expect(Math.max(...z) - Math.min(...z)).toBeCloseTo(PEG.acrossFlats, 6);
    }
  });

  it('refuses nothing at all, and warns about everything', () => {
    /*
     * No errors, ever — including for a plan with no pegs, which used to be
     * refused and which is exactly the plain 3MF-to-STL conversion somebody
     * would most want from a tool that reads both formats and writes one.
     */
    expect(reviewPegs(plate, { ...plan, cells: [] }).errors).toEqual([]);
    expect(reviewPegs(plate, plan).errors).toEqual([]);
    expect(reviewPegs(plate, { ...plan, cells: [{ q: 0, r: 0 }] }).warnings[0])
      .toMatch(/pivot/);
  });

  it('counts how the chosen pegs are backed, and never blocks on it', () => {
    // A cell far off the side of the plate: allowed, graded bare, warned about.
    const off = { ...plan, cells: [{ q: 0, r: 0 }, { q: 8, r: -4 }] };
    const review = reviewPegs(plate, off);
    expect(review.errors).toHaveLength(0);
    expect(review).toMatchObject({ solid: 1, bare: 1 });
    expect(review.warnings.join(' ')).toMatch(/loose piece/);
  });

  it('welds a peg into a bare cell exactly like any other', () => {
    // The promise of letting every cell be picked: the peg really is put where
    // it was asked for, even with nothing behind it.
    const off = { ...plan, cells: [{ q: 8, r: -4 }] };
    const out = buildPeggedMesh(plate, off);
    expect(out.triangleCount).toBe(
      plate.triangleCount + buildPegSolid({ a: 0, u: 0 }).triangleCount,
    );
    const want = cellPointMm(off.cells[0]!, off.latticeOffset);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = plate.positions.length; i < out.positions.length; i += 3) {
      minY = Math.min(minY, out.positions[i + 1]!);
      maxY = Math.max(maxY, out.positions[i + 1]!);
    }
    expect((minY + maxY) / 2).toBeCloseTo(want.x, 6);
  });

  it('counts which pegs sit on the bed and which bridge', () => {
    // Only a peg whose centre is half a peg above the part's own bottom prints
    // with its flat ON the bed; the rest bridge, and the note has to say so.
    const onBed = { ...plan, latticeOffset: { x: 0, y: PEG.acrossFlats / 2 }, cells: [{ q: 0, r: 0 }, { q: 2, r: -1 }] };
    expect(reviewPegs(plate, onBed)).toMatchObject({ onBed: 2, bridging: 0 });
    const high = { ...onBed, cells: [{ q: 0, r: 0 }, { q: 0, r: 2 }] };
    expect(reviewPegs(plate, high)).toMatchObject({ onBed: 1, bridging: 1 });
  });
});

/**
 * Picking the face by pointing at it.
 *
 * The six axis buttons ask in the file's own words, which mean nothing about a
 * model somebody just downloaded. This asks in the words of the thing on
 * screen: click the face you can see, and it turns to meet the wall.
 *
 * Every check here is stated on the MESH — where the clicked face ends up after
 * the orientation comes back — rather than on the returned axis and end, which
 * would only restate the function's own arithmetic.
 */
const FACE_LIST: { wallFaceAxis: Orientation['wallFaceAxis']; matingEnd: 'low' | 'high' }[] = [
  { wallFaceAxis: 'x', matingEnd: 'low' },
  { wallFaceAxis: 'x', matingEnd: 'high' },
  { wallFaceAxis: 'y', matingEnd: 'low' },
  { wallFaceAxis: 'y', matingEnd: 'high' },
  { wallFaceAxis: 'z', matingEnd: 'low' },
  { wallFaceAxis: 'z', matingEnd: 'high' },
];

describe('turning a face toward the wall', () => {
  /**
   * A box with a different length on every axis — so a wrong AXIS cannot pass
   * by symmetry — and with each face's triangles known, so a wrong END cannot
   * either. Wound outwards, like everything else this repo writes.
   */
  const [X, Y, Z] = [30, 50, 70];
  const CORNERS = [
    [0, 0, 0], [X, 0, 0], [X, Y, 0], [0, Y, 0],
    [0, 0, Z], [X, 0, Z], [X, Y, Z], [0, Y, Z],
  ];
  const TRIS = [
    [0, 2, 1], [0, 3, 2], // z low
    [4, 5, 6], [4, 6, 7], // z high
    [0, 1, 5], [0, 5, 4], // y low
    [1, 2, 6], [1, 6, 5], // x high
    [2, 3, 7], [2, 7, 6], // y high
    [3, 0, 4], [3, 4, 7], // x low
  ];
  /** Which triangle sits on each face, and which corners lie in its plane. */
  const FACE_TRIS: Record<string, { tri: number; onFace: (v: number[]) => boolean }> = {
    'z-low': { tri: 0, onFace: (v) => v[2] === 0 },
    'z-high': { tri: 2, onFace: (v) => v[2] === Z },
    'y-low': { tri: 4, onFace: (v) => v[1] === 0 },
    'x-high': { tri: 6, onFace: (v) => v[0] === X },
    'y-high': { tri: 8, onFace: (v) => v[1] === Y },
    'x-low': { tri: 10, onFace: (v) => v[0] === 0 },
  };

  const box = (): MeshData => {
    const positions = new Float32Array(TRIS.length * 9);
    TRIS.forEach((tri, t) => {
      tri.forEach((i, k) => positions.set(CORNERS[i]!, t * 9 + k * 3));
    });
    return { positions, triangleCount: TRIS.length, format: 'binary' };
  };

  /**
   * The outward normal of triangle `t` of the ORIENTED part, straight off the
   * geometry.
   *
   * Deliberately NOT `orientedDirection`: that is the function under test, and
   * generating the input with it would make the assertion algebraically true
   * whether the transform were right or wrong. This is what a raycast on the
   * drawn mesh hands the view, which is the real input.
   */
  const faceNormal = (part: OrientedPart, t: number): [number, number, number] => {
    const p = (k: number): number[] => [
      part.positions[t * 9 + k * 3]!,
      part.positions[t * 9 + k * 3 + 1]!,
      part.positions[t * 9 + k * 3 + 2]!,
    ];
    const [a, b, c] = [p(0), p(1), p(2)];
    const u = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!];
    const v = [c![0]! - a![0]!, c![1]! - a![1]!, c![2]! - a![2]!];
    const n: [number, number, number] = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    const len = Math.hypot(...n);
    return [n[0] / len, n[1] / len, n[2] / len];
  };

  it('lays the face you pointed at flat against the wall', () => {
    const mesh = box();
    // Every target face, from every starting orientation INCLUDING a quarter
    // turn: the click arrives in whatever frame the view happens to be showing,
    // so the answer has to be right from all of them.
    for (const from of FACE_LIST) {
      for (const quarterTurns of [0, 1, 2, 3]) {
        const start: Orientation = { ...from, quarterTurns };
        const shown = orientForPegs(mesh, start);

        for (const [label, face] of Object.entries(FACE_TRIS)) {
          const next = faceTowardWall(start, faceNormal(shown, face.tri));
          const part = orientForPegs(mesh, next);

          /*
           * The whole claim, on the mesh: after the turn, the corners lying in
           * the clicked face's plane are EXACTLY the ones now at out = 0 — the
           * wall face. Vertex order survives `orientForPegs`, so corner k of
           * the file is corner k of the oriented part.
           */
          for (let t = 0; t < TRIS.length; t++) {
            for (let k = 0; k < 3; k++) {
              const corner = CORNERS[TRIS[t]![k]!]!;
              const out = part.positions[t * 9 + k * 3]!;
              expect(out < 1e-9, `${label} from ${from.wallFaceAxis}${from.matingEnd}+${quarterTurns}`)
                .toBe(face.onFace(corner));
            }
          }
        }
      }
    }
  });

  it('snaps a normal that is not quite square', () => {
    // Real faces are rarely exactly axis-aligned, and the lattice has six
    // choices anyway. A click 12° off must land on the face it is on.
    const start = DEFAULT_ORIENTATION;
    expect(faceTowardWall(start, [-0.96, 0.2, 0.19]))
      .toEqual(faceTowardWall(start, [-1, 0, 0]));
  });

  it('is the identity when you point at the face already on the wall', () => {
    // The commonest accidental click has to be a no-op rather than a spin.
    for (const from of FACE_LIST) {
      for (const quarterTurns of [0, 1, 2, 3]) {
        const start: Orientation = { ...from, quarterTurns };
        expect(faceTowardWall(start, [-1, 0, 0])).toEqual(start);
      }
    }
  });

  it('carries the quarter turn, as the six buttons do', () => {
    // It is a separate judgement — which way up the part reads — and clearing
    // it would undo a choice somebody made on purpose.
    const start: Orientation = { wallFaceAxis: 'z', matingEnd: 'low', quarterTurns: 3 };
    expect(faceTowardWall(start, [0, 1, 0]).quarterTurns).toBe(3);
  });
});
