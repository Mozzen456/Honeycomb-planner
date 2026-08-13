/**
 * Real geometry for the 3D view.
 *
 * The wall used to draw every accessory as a box the size of its bounding box.
 * That is enough to answer "does it fit", which is what the plan view is for,
 * and useless for the question the 3D view exists to answer: what will this
 * actually look like on my wall, and does this hook foul the one next to it.
 * A 20-slot SD-card holder and a coat hook are the same grey cuboid.
 *
 * So each placed part is drawn from its own STL. Loading is lazy (only parts
 * actually on the wall), cached per part id, and falls back to the box if the
 * file is missing — a planner that cannot fetch a model still plans.
 *
 * Orientation is the whole difficulty and it is not guesswork: the detector
 * already works out which axis of the file faces the wall, which end of that
 * axis it is, and whether the part is drawn flat-top and so must be spun 90° to
 * sit on a pointy-top wall. This applies exactly that, so the mesh lands the way
 * the footprint says it does.
 */

import * as THREE from 'three';

import { AXES, detect, type Detection } from '../core/detect';
import { mountingOf } from '../core/overrides';
import { parseStl, type MeshData } from '../core/stl';
import type { CatalogPart } from '../core/types';
import { getModelBytes, isImported } from '../core/userCatalog';
import { mountingMatrix } from './mountingTransform';

export interface PartMesh {
  geometry: THREE.BufferGeometry;
  /** Extent along the wall normal, after orientation. */
  depthMm: number;
}

const cache = new Map<string, Promise<PartMesh | null>>();

/** Drop everything — used when an imported part is removed or replaced. */
export function forgetPartMesh(partId: string): void {
  const pending = cache.get(partId);
  cache.delete(partId);
  void pending?.then((m) => m?.geometry.dispose());
}

/**
 * The oriented geometry for a part, or null if its model cannot be had.
 *
 * Null is a normal answer, not an error: the app is built with `base: './'` and
 * may be opened from a file:// URL or a host that does not carry `models/`.
 */
export function loadPartMesh(part: CatalogPart): Promise<PartMesh | null> {
  const existing = cache.get(part.id);
  if (existing !== undefined) return existing;
  const pending = build(part).catch(() => null);
  cache.set(part.id, pending);
  return pending;
}

async function build(part: CatalogPart): Promise<PartMesh | null> {
  const bytes = await bytesFor(part);
  if (bytes === null) return null;

  const mesh = parseStl(bytes);
  // Re-detecting is what keeps the mesh and the footprint in step: the same
  // function that decided which cells this part covers decides which way up it
  // is drawn. The alternative — a second orientation rule here — is a second
  // thing to keep true. It costs a few hundred milliseconds once per part id.
  //
  // A hand-picked wall face is fed in as a CONSTRAINT on that same detection,
  // not applied afterwards, so the cells and the mesh still come from one
  // decision. See `MountingOverride`.
  const mounting = mountingOf(part);
  const detection = detect(
    mesh,
    mounting ? { forceAxis: mounting.wallFaceAxis, forceEnd: mounting.matingEnd } : {},
  );
  const geometry = orient(mesh, detection);

  /*
   * A PANEL drawn pointy-top is spun 90°, unlike everything else.
   *
   * `orient` refuses the drawn-orientation spin on purpose, and that rule is
   * right for an accessory: a part is drawn in the orientation it is USED, and
   * spinning an SD-card holder points its slots sideways so the cards fall out.
   * The argument turns on the part having a meaningful up.
   *
   * A plate has none. It is a rectangle of honeycomb, and what it must match is
   * its own CELL BLOCK — which `toAxial` derives by spinning a pointy-drawn
   * part's cells onto the flat-top lattice. Leave the mesh unspun and the two
   * disagree by 90°: `wall-honeycomb-part` draws 177 × 170.32 where its block
   * needs 170.32 × 177.
   *
   * It hid because it is invisible on a wall built from ONE pointy panel — every
   * plate is wrong the same way, the boundaries fall inside a continuous
   * honeycomb, and it reads as fine. Mix a pointy plate with a flat one, as the
   * 256 bed does with mk3s and 106x89, and correct plates sit beside turned ones.
   * Prusa Mini looked right for exactly that reason: it uses one panel type.
   */
  if (part.type === 'panel' && detection.drawnOrientation === 'pointy') {
    // The same +90° `toAxial` applies to the cells: (u, v) -> (−v, u).
    geometry.rotateZ(Math.PI / 2);
  }

  /*
   * The seating correction, which is the one part that is not a detection: six
   * numbers a person set by eye in the inspector to put the part exactly where
   * it goes. Applied as ONE matrix from `mountingTransform`, which is also what
   * the inspector previews with — two copies of the order would mean lining a
   * part up in the dialog and finding it somewhere else on the wall.
   *
   * `depthMm` stays the DETECTED projection. It measures the part along the
   * wall normal for the layout, and that is a property of the part under the
   * chosen face, not of how far someone nudged it afterwards.
   */
  if (mounting) geometry.applyMatrix4(mountingMatrix(mounting));
  return { geometry, depthMm: detection.projectionMm };
}

/**
 * The part's mesh in the STL's OWN coordinates, unoriented.
 *
 * The inspector needs this rather than the oriented geometry: picking a
 * mounting face means naming an axis of the FILE, and mapping a click on an
 * already-turned mesh back through the permutation and the flip is a second
 * inverse to keep true. Cached separately from the oriented mesh because the
 * two have different lifetimes — the oriented one is dropped whenever a
 * correction changes it, this one never changes.
 */
const rawCache = new Map<string, Promise<MeshData | null>>();

export function loadRawMesh(part: CatalogPart): Promise<MeshData | null> {
  const existing = rawCache.get(part.id);
  if (existing !== undefined) return existing;
  const pending = bytesFor(part)
    .then((bytes) => (bytes === null ? null : parseStl(bytes)))
    .catch(() => null);
  rawCache.set(part.id, pending);
  return pending;
}

async function bytesFor(part: CatalogPart): Promise<ArrayBuffer | null> {
  if (isImported(part)) return getModelBytes(part.id);
  if (typeof fetch !== 'function' || !part.file) return null;
  const response = await fetch(encodeURI(part.file));
  if (!response.ok) return null;
  return response.arrayBuffer();
}

/**
 * Put the mesh into wall coordinates: +Z out of the wall, the mating face at
 * z = 0, and the part centred on its own wall-plane bounding box.
 *
 * Centring on the bounding box rather than on a cell is deliberate — it is the
 * same convention the box placeholder used, so a part does not jump when its
 * real mesh finishes loading, and it is the only convention that behaves for a
 * tier-3 part, whose cells are a bound rather than a measurement.
 */
function orient(mesh: MeshData, detection: Detection): THREE.BufferGeometry {
  const axis = detection.wallFaceAxis === 'n/a' ? 'z' : detection.wallFaceAxis;
  const [ui, vi, wi] = AXES[axis];
  const spin = detection.drawnOrientation === 'flat';
  const flip = detection.matingEnd === 'high';

  const src = mesh.positions;
  const out = new Float32Array(src.length);
  let minU = Infinity, minV = Infinity, minW = Infinity;
  let maxU = -Infinity, maxV = -Infinity, maxW = -Infinity;

  for (let i = 0; i < src.length; i += 3) {
    // (u, v, w) is a cyclic permutation, so this is a rotation and never a
    // mirror. A mirrored accessory would be a left-hand hook on a right-hand
    // wall: wrong in a way that looks fine.
    let u = src[i + ui]!;
    let v = src[i + vi]!;
    let w = src[i + wi]!;

    // NO 90° SPIN. `toAxial` spins a flat-drawn part's CELLS by 90° so its
    // footprint lands on a pointy-top lattice, and applying the same turn to
    // the mesh was the obvious thing to do — but it is wrong, and the
    // photographs are what show it.
    //
    // A part is drawn in the orientation it is USED: the SD-card holder's slots
    // are cut into its −y face, and the reference photograph of one mounted on
    // a real wall has those slots pointing straight up, cards standing in them.
    // Spinning the mesh 90° pointed them sideways and cards would fall out.
    //
    // The residue is that the part's own hexagon then reads 30° off the cell
    // drawn under it. That is a genuine discrepancy and it is the app's wall
    // frame, not this transform: the wall is drawn pointy-top (HSW-SPEC §2)
    // while every reference photograph of a mounted part shows a flat-top
    // plug going into the wall. Which of the two is turned is a much bigger
    // question than how a mesh is drawn — see PARKED. Between a part whose
    // hexagon is 30° out and a part whose contents fall on the floor, this
    // draws the one that is usable.
    void spin;

    // The mating face has to end up at the low end of w, so the plug goes INTO
    // the wall and the body stands out into the room.
    //
    // Turning the part over is a 180° rotation, NOT a negation of w on its own:
    // negating one axis is a reflection, and a mirrored hook is a left-hand
    // hook on a right-hand wall. About U, which keeps the part's own up (v)
    // pointing up — about V it would arrive upside down.
    if (flip) {
      v = -v;
      w = -w;
    }

    out[i] = u;
    out[i + 1] = v;
    out[i + 2] = w;
    if (u < minU) minU = u;
    if (v < minV) minV = v;
    if (w < minW) minW = w;
    if (u > maxU) maxU = u;
    if (v > maxV) maxV = v;
    if (w > maxW) maxW = w;
  }

  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;
  for (let i = 0; i < out.length; i += 3) {
    out[i] = out[i]! - cu;
    out[i + 1] = out[i + 1]! - cv;
    out[i + 2] = out[i + 2]! - minW;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(out, 3));
  geometry.computeVertexNormals();
  return geometry;
}
