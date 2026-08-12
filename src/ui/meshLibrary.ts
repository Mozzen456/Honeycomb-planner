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
import { parseStl, type MeshData } from '../core/stl';
import type { CatalogPart } from '../core/types';
import { getModelBytes, isImported } from '../core/userCatalog';

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
  const detection = detect(mesh);
  return { geometry: orient(mesh, detection), depthMm: detection.projectionMm };
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

    // A flat-drawn part must be spun 90° to sit on a pointy-top wall — the same
    // (u, v) -> (-v, u) turn `toAxial` applies to its cells.
    if (spin) {
      const t = u;
      u = -v;
      v = t;
    }
    // The mating face has to end up at the low end of w. Turning the part over
    // is a 180° rotation about u, NOT a negation of w on its own: negating one
    // axis is a reflection.
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
