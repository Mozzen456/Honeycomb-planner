/**
 * What a mounting correction DOES to a part, as one matrix.
 *
 * A `MountingOverride` is six numbers — three to slide the part and three to
 * turn it — and two consumers have to agree exactly on what they mean:
 * `meshLibrary`, which bakes them into the geometry the wall draws, and
 * `PartInspector`, which has to show the same result while the part is still in
 * the FILE's own frame. Two copies of "rotate, then rotate, then translate" is
 * the repeat offender in this repo (three surviving copies of the hex inverse,
 * CLAUDE.md), and a copy that disagreed here would mean lining a part up in the
 * dialog and finding it somewhere else on the wall.
 *
 * So the order lives here, once:
 *
 *     spin about the wall normal (Z) → tilt about X → tilt about Y → translate
 *
 * Rotation before translation, because the two do not commute and "turn it,
 * then put it where I want it" is the one a person can predict. The pivot is
 * the origin of wall coordinates, which `orient` puts at the centre of the
 * mating face — so a tilt hinges on the wall surface rather than swinging the
 * part off it.
 *
 * Wall coordinates throughout: +X across the wall, +Y up it, +Z out of it.
 */

import * as THREE from 'three';

import { AXES } from '../core/detect';
import { seatOffsetMm, type MountingOverride } from '../core/overrides';

const DEG = Math.PI / 180;

/** The whole turn about the wall normal: 30° lattice steps plus the fine trim. */
export function spinRadians(m: MountingOverride | undefined): number {
  if (m === undefined) return 0;
  return (Math.PI / 6) * (m.spinSteps ?? 0) + DEG * (m.spinDeg ?? 0);
}

/**
 * How far out of the wall the part stands: the seat, plus the person's own trim.
 *
 * The seat is the DATUM — flat on the wall, or resting on the flanges of the
 * inserts that hold it (HSW-SPEC §5). Adding it here rather than folding it into
 * `offsetMm` at the point of saving is what keeps "it sits on its inserts" a
 * fact about the part instead of a 2.5 that somebody would later wonder about.
 */
export function depthMm(m: MountingOverride | undefined): number {
  if (m === undefined) return 0;
  return seatOffsetMm(m.seat) + (m.offsetMm ?? 0);
}

/**
 * The correction as a rigid transform in wall coordinates.
 *
 * Identity when nothing is corrected, which is what lets callers apply it
 * unconditionally instead of testing each field.
 */
export function mountingMatrix(m: MountingOverride | undefined): THREE.Matrix4 {
  const out = new THREE.Matrix4();
  if (m === undefined) return out;
  out.makeTranslation(m.offsetXMm ?? 0, m.offsetYMm ?? 0, depthMm(m));
  out.multiply(new THREE.Matrix4().makeRotationY(DEG * (m.tiltYDeg ?? 0)));
  out.multiply(new THREE.Matrix4().makeRotationX(DEG * (m.tiltXDeg ?? 0)));
  out.multiply(new THREE.Matrix4().makeRotationZ(spinRadians(m)));
  return out;
}

/**
 * Wall axes expressed in the FILE's axes, for a part mounted on `axis`/`end`.
 *
 * The columns are the wall's X, Y and Z as vectors in file coordinates, so the
 * matrix maps a wall-frame vector to a file-frame one. It is exactly the
 * transform `meshLibrary.orient` performs, read the other way round:
 *
 *   - `AXES[axis]` is the (u, v, w) permutation, cyclic and therefore a
 *     rotation — an acyclic one would be a reflection, and a mirrored part is a
 *     left-hand hook on a right-hand wall.
 *   - a `high` mating end negates v AND w, which is a 180° turn about u rather
 *     than a negation of w on its own. Same reason: negating one axis mirrors.
 *
 * Its determinant is therefore +1 for all six faces, and `tests/mounting.test.ts`
 * holds it to that.
 */
export function wallBasis(axis: 'x' | 'y' | 'z', end: 'low' | 'high'): THREE.Matrix4 {
  const [ui, vi, wi] = AXES[axis];
  const flip = end === 'high' ? -1 : 1;
  const x = new THREE.Vector3().setComponent(ui, 1);
  const y = new THREE.Vector3().setComponent(vi, flip);
  const z = new THREE.Vector3().setComponent(wi, flip);
  return new THREE.Matrix4().makeBasis(x, y, z);
}

/**
 * Wall coordinates as a viewer's scene draws them: UP THE WALL IS UP.
 *
 *     wall +X (across the wall) -> scene +X, right on screen
 *     wall +Y (up the wall)     -> scene +Z, up on screen and the orbit's pole
 *     wall +Z (out of the wall) -> scene −Y, toward the default camera
 *
 * The inspector models a part in the FILE's frame on purpose — the question it
 * asks is which axis of the STL faces the wall, so a click has to land on an
 * axis of the STL. But nobody hangs a shelf in the file's frame, and while "up
 * the wall" was whichever way the modeller drew, the one judgement the dialog
 * exists for could not be made by looking. Turning the stage rather than the
 * part keeps both: the geometry inside stays in file coordinates, so
 * `face.normal` still names a file axis.
 *
 * A rotation, never a mirror — `tests/mounting-transform.test.ts` holds it to
 * determinant +1 for all six faces, for the same reason `wallBasis` is held.
 */
export const wallToScene = (): THREE.Matrix4 => new THREE.Matrix4().makeBasis(
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, -1, 0),
);

/** File coordinates to that scene, for a part mounted on `axis`/`end`. */
export function fileToScene(axis: 'x' | 'y' | 'z', end: 'low' | 'high'): THREE.Matrix4 {
  return wallToScene().multiply(wallBasis(axis, end).transpose());
}

/**
 * The same correction, for a mesh still drawn in the FILE's own frame and
 * centred on its own bounding box — which is what the inspector shows.
 *
 * `halfAlongNormal` is that box's half extent along the mounting axis, so the
 * pivot can be put on the mating FACE rather than at the part's middle. Without
 * it a tilt would hinge about the centre of the part and lift it off the plate,
 * while on the wall the same tilt hinges at the wall surface — the preview would
 * be a different transform wearing the same numbers.
 *
 *     M_file = T(pivot) · B · M_wall · Bᵀ · T(−pivot)
 *
 * `Bᵀ` and not an inverse: `B` is orthonormal by construction.
 */
export function mountingMatrixInFileFrame(
  m: MountingOverride | undefined,
  axis: 'x' | 'y' | 'z',
  end: 'low' | 'high',
  halfAlongNormal: number,
): THREE.Matrix4 {
  const basis = wallBasis(axis, end);
  const inverse = basis.clone().transpose();
  // The mating face sits at −halfAlongNormal along the wall normal, so that is
  // where wall (0, 0, 0) lands in the centred file frame.
  const pivot = new THREE.Vector3(0, 0, -halfAlongNormal).applyMatrix4(basis);

  return new THREE.Matrix4()
    .makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(basis)
    .multiply(mountingMatrix(m))
    .multiply(inverse)
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
}
