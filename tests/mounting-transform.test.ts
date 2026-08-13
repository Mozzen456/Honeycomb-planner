/**
 * The six seating numbers, and the one transform they mean.
 *
 * A `MountingOverride` is a rigid transform: three slides and three turns that
 * put a part exactly where a person says it goes. TWO places consume it — the
 * geometry `meshLibrary` bakes for the wall, and the preview `PartInspector`
 * draws while the part is still in the file's own frame — and if they disagree
 * about the order, or about a sign, you line a part up in the dialog and find it
 * somewhere else on the wall. Three surviving copies of the hex inverse are what
 * that costs (CLAUDE.md); this is the guard against a fourth.
 *
 * Nothing here needs a browser: it is matrix arithmetic over a plain object.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { INSERT } from '../src/core/constants';
import { AXES } from '../src/core/detect';
import type { MountingOverride } from '../src/core/overrides';
import {
  depthMm, fileToScene, mountingMatrix, mountingMatrixInFileFrame, spinRadians, wallBasis,
} from '../src/ui/mountingTransform';

const face = (over: Partial<MountingOverride> = {}): MountingOverride =>
  ({ wallFaceAxis: 'z', matingEnd: 'low', ...over });

/** Where a point ends up, rounded past the noise of a 90° sine. */
const move = (m: THREE.Matrix4, x: number, y: number, z: number): number[] => {
  const v = new THREE.Vector3(x, y, z).applyMatrix4(m);
  return [v.x, v.y, v.z].map((n) => Math.round(n * 1e6) / 1e6);
};

describe('the correction as a transform', () => {
  it('is the identity when nothing has been corrected', () => {
    expect(mountingMatrix(face()).equals(new THREE.Matrix4())).toBe(true);
    expect(mountingMatrix(undefined).equals(new THREE.Matrix4())).toBe(true);
  });

  /**
   * Turn, THEN move. The two do not commute, and "turn it, then put it where I
   * want it" is the order a person can predict — the other way round, every
   * slide would be re-aimed by whatever spin happened to be set.
   */
  it('rotates before it translates', () => {
    const m = mountingMatrix(face({ spinSteps: 3, offsetXMm: 10 }));
    expect(move(m, 1, 0, 0)).toEqual([10, 1, 0]);
    // Translating first would put the same point at (0, 11, 0).
  });

  it('adds the fine trim to the lattice steps', () => {
    expect(spinRadians(face({ spinSteps: 1, spinDeg: 15 }))).toBeCloseTo(Math.PI / 4, 12);
    expect(spinRadians(undefined)).toBe(0);
  });

  /** The two tilts, in the directions their field comments promise. */
  it('tilts the top out of the wall, and the right edge into it', () => {
    // About the across axis: +Y (up the wall) swings to +Z (out of it).
    expect(move(mountingMatrix(face({ tiltXDeg: 90 })), 0, 1, 0)).toEqual([0, 0, 1]);
    // About the up axis: +X (the right edge) swings to −Z (into the wall).
    expect(move(mountingMatrix(face({ tiltYDeg: 90 })), 1, 0, 0)).toEqual([0, 0, -1]);
  });

  it('slides in millimetres of wall, not of file', () => {
    expect(move(mountingMatrix(face({ offsetXMm: 2, offsetYMm: -3, offsetMm: 4 })), 0, 0, 0))
      .toEqual([2, -3, 4]);
  });

  /**
   * Seated on its inserts, a part stands off by the whole flange.
   *
   * HSW is two-level: the insert clips into the cell, the part pegs into the
   * insert, and the 22.5 mm flange cannot enter the 22.0 mm mouth — so it seats
   * proud and the part rests on it. `orient` puts every mating face at z = 0,
   * which is where a part sits only if nothing is fastening it.
   */
  it('stands a part off by the insert flange when it is seated on inserts', () => {
    expect(depthMm(face({ seat: 'insert' }))).toBe(INSERT.flangeThickness);
    expect(depthMm(face({ seat: 'wall' }))).toBe(0);
    expect(depthMm(face())).toBe(0);
    // The trim is measured FROM the seat, not instead of it.
    expect(depthMm(face({ seat: 'insert', offsetMm: -1 }))).toBeCloseTo(
      INSERT.flangeThickness - 1, 10,
    );
    expect(move(mountingMatrix(face({ seat: 'insert' })), 0, 0, 0))
      .toEqual([0, 0, INSERT.flangeThickness]);
  });
});

describe('the wall basis', () => {
  const faces = (['x', 'y', 'z'] as const).flatMap((axis) =>
    (['low', 'high'] as const).map((end) => ({ axis, end })));

  /**
   * A rotation for all six, never a reflection. `AXES` is cyclic on purpose and
   * a `high` mating end negates v AND w — a 180° turn about u rather than a
   * negation of w on its own. Negating one axis would mirror the part, which is
   * a left-hand hook on a right-hand wall: wrong in a way that looks fine.
   */
  it('is a rotation for every face', () => {
    for (const { axis, end } of faces) {
      expect(wallBasis(axis, end).determinant()).toBeCloseTo(1, 12);
    }
  });

  /** ...and it is `meshLibrary.orient`'s own permutation, read the other way. */
  it('sends the wall axes to the file axes orient uses', () => {
    for (const { axis, end } of faces) {
      const [ui, vi, wi] = AXES[axis];
      const flip = end === 'high' ? -1 : 1;
      const basis = wallBasis(axis, end);
      expect(move(basis, 1, 0, 0)[ui]).toBe(1);
      expect(move(basis, 0, 1, 0)[vi]).toBe(flip);
      expect(move(basis, 0, 0, 1)[wi]).toBe(flip);
    }
  });
});

/**
 * Up the wall is up on screen.
 *
 * The inspector models a part in the FILE's frame — the question it asks is
 * which axis of the STL faces the wall, so a click has to land on an axis of the
 * STL. Nobody judges a shelf in that frame, though: the whole point is how it
 * will hang, and while "up the wall" was whichever way the modeller drew, a
 * green arrow was the only way to tell. Turning the STAGE fixes the view without
 * touching the geometry, so a raycast still names a file axis.
 */
describe('the frame the inspector draws in', () => {
  const faces = (['x', 'y', 'z'] as const).flatMap((axis) =>
    (['low', 'high'] as const).map((end) => ({ axis, end })));

  it('sends up-the-wall to up-the-screen, on every face', () => {
    for (const { axis, end } of faces) {
      const [, vi] = AXES[axis];
      // The file axis `orient` maps to the wall's +Y, negated by the flip.
      const up = new THREE.Vector3().setComponent(vi, end === 'high' ? -1 : 1);
      expect(move(fileToScene(axis, end), up.x, up.y, up.z), `${axis}:${end}`)
        .toEqual([0, 0, 1]);
    }
  });

  it('sends out-of-the-wall toward the camera, on every face', () => {
    for (const { axis, end } of faces) {
      const wi = AXES[axis][2];
      const out = new THREE.Vector3().setComponent(wi, end === 'high' ? -1 : 1);
      expect(move(fileToScene(axis, end), out.x, out.y, out.z), `${axis}:${end}`)
        .toEqual([0, -1, 0]);
    }
  });

  /** A rotation, never a mirror — the same rule `wallBasis` is held to. */
  it('is a rotation for every face', () => {
    for (const { axis, end } of faces) {
      expect(fileToScene(axis, end).determinant()).toBeCloseTo(1, 12);
    }
  });
});

describe('the same correction, in the file frame the inspector draws in', () => {
  it('reduces to the wall transform on the face the file is already drawn for', () => {
    const m = face({ spinSteps: 2, offsetXMm: 3, tiltYDeg: 12 });
    expect(mountingMatrixInFileFrame(m, 'z', 'low', 0).equals(mountingMatrix(m))).toBe(true);
  });

  /**
   * The pivot is the mating FACE, not the middle of the part.
   *
   * On the wall, `orient` puts the mating face at z = 0, so a tilt hinges on the
   * wall surface. The inspector's mesh is centred on its own bounding box
   * instead, so without moving the pivot the same numbers would swing the part
   * off the plate — a different transform wearing the same six figures.
   */
  it('hinges a tilt on the mating face', () => {
    const half = 12.5;
    const m = mountingMatrixInFileFrame(face({ tiltXDeg: 30, tiltYDeg: -20 }), 'z', 'low', half);
    expect(move(m, 0, 0, -half)).toEqual([0, 0, -half]);
  });

  /**
   * Depth is OUT of the wall whichever end mates. The plate sits on the chosen
   * face, so "out" is the direction that face does not point — getting it
   * backwards put "+4 mm out" visibly into the plate, which is the one thing the
   * preview exists to show.
   */
  it('sends a positive depth away from the wall on both ends', () => {
    expect(move(mountingMatrixInFileFrame(face({ offsetMm: 4 }), 'z', 'low', 10), 0, 0, 0))
      .toEqual([0, 0, 4]);
    expect(move(
      mountingMatrixInFileFrame(face({ matingEnd: 'high', offsetMm: 4 }), 'z', 'high', 10), 0, 0, 0,
    )).toEqual([0, 0, -4]);
  });

  /** And a slide across the wall is across the wall, whichever file axis that is. */
  it('slides along the wall for a part mounted on its side', () => {
    const m = mountingMatrixInFileFrame(face({ wallFaceAxis: 'x', offsetXMm: 5 }), 'x', 'low', 8);
    // AXES.x = [1, 2, 0]: the wall's across axis is the file's Y.
    expect(move(m, 0, 0, 0)).toEqual([0, 5, 0]);
  });
});
