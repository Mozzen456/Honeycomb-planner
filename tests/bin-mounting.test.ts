/**
 * Does a generated bin land on the wall where its own cells are?
 *
 * `bin-model.test.ts` proves the pegs are on the lattice in the PART's frame.
 * This proves the rest of the chain — the file frame, `detect`'s forced axis,
 * `orient`'s centring, the mounting matrix and where `WallView3D` puts the
 * result — actually delivers them onto those cells. Every one of those steps is
 * a place a part can end up half a cell out, and D53's lesson is that the wall
 * and the dialog disagreeing is only ever found by measuring, not by looking.
 *
 * The numbers are taken from the same constants the app uses, and the transform
 * is the app's own functions rather than a copy of them.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  buildBinMesh,
  cellsFor,
  drawOffsetYMm,
  minWidthMm,
  normaliseBinSpec,
  type BinSpec,
} from '../src/core/binModel';
import { INSERT, PANEL_DEPTH, PEG } from '../src/core/constants';
import { detect } from '../src/core/detect';
import { cellsCentreMm, hexToMm } from '../src/core/hex';
import type { MountingOverride } from '../src/core/overrides';
import { orient } from '../src/ui/meshLibrary';
import { mountingMatrix } from '../src/ui/mountingTransform';

/**
 * The mounting `App.tsx` writes for a generated bin.
 *
 * Restated here rather than imported, because it lives inside a React callback —
 * and if the two ever part company this test is what says so. Keep them in step.
 */
const mountingFor = (model: { offsetYMm: number }): MountingOverride => ({
  wallFaceAxis: 'x',
  matingEnd: 'low',
  seat: 'insert',
  offsetMm: -PEG.lengthMm,
  offsetYMm: model.offsetYMm,
});

/**
 * Every vertex of the bin in WALL coordinates, exactly as the 3D view draws it.
 *
 * `orient` with the forced axis, then the mounting matrix, then the placement
 * `WallView3D` applies: the box centre of the part's cells, at `PANEL_DEPTH`
 * because a bin is an accessory and only an insert seats INTO the wall.
 */
function onTheWall(spec: BinSpec): { positions: Float32Array; cells: ReturnType<typeof cellsFor> } {
  const model = buildBinMesh(spec);
  const mesh = {
    positions: Float32Array.from(model.mesh.positions),
    triangleCount: model.mesh.triangleCount,
    format: 'binary' as const,
  };
  const mounting = mountingFor(model);
  const detection = detect(mesh, {
    forceAxis: mounting.wallFaceAxis,
    forceEnd: mounting.matingEnd,
  });
  const geometry = orient(mesh, detection);
  geometry.applyMatrix4(mountingMatrix(mounting));

  const centre = cellsCentreMm(model.cells);
  const out = Float32Array.from(geometry.getAttribute('position').array as Float32Array);
  for (let i = 0; i < out.length; i += 3) {
    out[i] = out[i]! + centre.x;
    out[i + 1] = out[i + 1]! + centre.y;
    out[i + 2] = out[i + 2]! + PANEL_DEPTH;
  }
  return { positions: out, cells: model.cells };
}

/** Points at a given wall depth, to a tolerance. */
const atDepth = (p: Float32Array, z: number): { x: number; y: number }[] => {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < p.length; i += 3) {
    if (Math.abs(p[i + 2]! - z) < 0.01) out.push({ x: p[i]!, y: p[i + 1]! });
  }
  return out;
};

/** Split points into clusters no more than `gap` apart. */
function clusters(points: { x: number; y: number }[], gap: number): { x: number; y: number }[][] {
  const left = [...points];
  const out: { x: number; y: number }[][] = [];
  while (left.length > 0) {
    const group = [left.pop()!];
    for (let grew = true; grew; ) {
      grew = false;
      for (let i = left.length - 1; i >= 0; i--) {
        if (group.some((g) => Math.hypot(g.x - left[i]!.x, g.y - left[i]!.y) < gap)) {
          group.push(...left.splice(i, 1));
          grew = true;
        }
      }
    }
    out.push(group);
  }
  return out;
}

/** Inside measurements, like the spec. */
const SPECS: BinSpec[] = [
  normaliseBinSpec({
    pegs: 2, innerWidthMm: 80, innerHeightMm: 70, innerDepthMm: 55, wallMm: 2.4,
  }),
  normaliseBinSpec({
    pegs: 3, innerWidthMm: 300, innerHeightMm: 200, innerDepthMm: 120, wallMm: 3,
  }),
  normaliseBinSpec({
    pegs: 5, innerWidthMm: minWidthMm(5, 1.6), innerHeightMm: 26, innerDepthMm: 20, wallMm: 1.6,
  }),
  normaliseBinSpec({
    pegs: 8, innerWidthMm: 400, innerHeightMm: 121, innerDepthMm: 250, wallMm: 5,
  }),
];

describe('a generated bin, mounted on the wall', () => {
  it('puts every peg centre exactly on its own cell', () => {
    for (const spec of SPECS) {
      const { positions, cells } = onTheWall(spec);
      /*
       * The ring 4 mm along the peg: the last one of the full, undrafted
       * section, so its bounding box centre IS the peg's axis. A ring nearer the
       * tip would not do — `PEG_PROFILE` leaves the bottom face alone while the
       * other five come in, so a tapered section is deliberately not symmetric
       * about the axis and its box centre sits low.
       */
      const ring = PANEL_DEPTH - (PEG.lengthMm - INSERT.flangeThickness) + 4;
      const found = clusters(atDepth(positions, ring), PEG.acrossCorners * 1.5);
      expect(found).toHaveLength(cells.length);

      const centres = found
        .map((g) => ({
          x: (Math.min(...g.map((p) => p.x)) + Math.max(...g.map((p) => p.x))) / 2,
          y: (Math.min(...g.map((p) => p.y)) + Math.max(...g.map((p) => p.y))) / 2,
        }))
        .sort((a, b) => a.y - b.y || a.x - b.x);
      const wanted = cells
        .map(hexToMm)
        .sort((a, b) => a.y - b.y || a.x - b.x);

      for (let i = 0; i < wanted.length; i++) {
        expect(centres[i]!.x).toBeCloseTo(wanted[i]!.x, 3);
        expect(centres[i]!.y).toBeCloseTo(wanted[i]!.y, 3);
      }
    }
  });

  it('sinks the pegs into the plate and rests the back on the insert flanges', () => {
    for (const spec of SPECS) {
      const { positions } = onTheWall(spec);
      let minZ = Infinity;
      for (let i = 2; i < positions.length; i += 3) minZ = Math.min(minZ, positions[i]!);

      // The tip. A whole peg in, less the flange the back panel rests on — so
      // it is INSIDE the 8 mm plate and does not come out of the back of it.
      const tip = PANEL_DEPTH - (PEG.lengthMm - INSERT.flangeThickness);
      expect(minZ).toBeCloseTo(tip, 5);
      expect(minZ).toBeGreaterThan(0);
      expect(minZ).toBeLessThan(PANEL_DEPTH);

      // ...and the back panel's outer face on the flanges, 2.5 mm proud.
      expect(atDepth(positions, PANEL_DEPTH + INSERT.flangeThickness).length).toBeGreaterThan(0);
    }
  });

  it('needs a nudge no bigger than the override reader will keep', () => {
    // `readTrim` clamps a stored offset at MAX_OFFSET_MM = 40, silently. A bin
    // whose correction was clamped would be drawn somewhere it is not.
    for (const spec of SPECS) expect(Math.abs(drawOffsetYMm(spec))).toBeLessThan(40);
  });

  it('is not mirrored: the transform is a rotation', () => {
    // A mirrored bin's pegs still land on the lattice, so nothing above would
    // catch it — the same reason `AXES` is cyclic and `wallBasis` is held to
    // determinant +1.
    const m = mountingMatrix(mountingFor({ offsetYMm: 3 }));
    expect(m.determinant()).toBeCloseTo(1, 12);
    expect(new THREE.Matrix4().extractRotation(m).determinant()).toBeCloseTo(1, 12);
  });
});
