/**
 * Small rendered previews of a part, for the catalogue rail.
 *
 * A name and a cell count do not tell you what a part IS. "hook-to-empty" and
 * "hook-side" are two hooks; "insert-hollow-tre" and "insert-hollow-for" differ
 * only in cell count; and 27 of the 51 shipped parts have names that describe
 * their fixing rather than their shape. Picking the right one meant dragging it
 * onto the wall to look at it, which is a slow way to browse a shelf.
 *
 * ---------------------------------------------------------------------------
 * One renderer, not one per tile
 * ---------------------------------------------------------------------------
 *
 * A browser allows on the order of sixteen live WebGL contexts and the
 * catalogue has fifty-one tiles, so a canvas per tile is not an option — the
 * oldest contexts get killed and those tiles go blank. Instead there is a single
 * offscreen renderer here: each part is drawn into it in turn and read out as a
 * PNG data URL, which is an ordinary `<img>` from then on. The GPU cost is one
 * context and one small draw per part, once.
 *
 * Renders are serialised through a promise chain because they all share that one
 * renderer and one scene. They are cheap — a few hundred triangles at 128 px —
 * and the queue only ever holds parts whose tiles are actually on screen.
 *
 * The mesh is the ORIENTED one from `meshLibrary`, the same geometry the wall
 * draws, so the preview shows the part the way it will sit rather than the way
 * it happens to be drawn in its file.
 */

import * as THREE from 'three';

import type { CatalogPart } from '../core/types';
import { loadPartMesh } from './meshLibrary';

const SIZE = 128;

const cache = new Map<string, Promise<string | null>>();

interface Rig {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  holder: THREE.Group;
}

let rig: Rig | null = null;

function getRig(): Rig | null {
  if (rig) return rig;
  if (typeof document === 'undefined') return null;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      // Required for `toDataURL`: without it the buffer is undefined after the
      // draw call returns and the read comes back blank or black.
      preserveDrawingBuffer: true,
    });
  } catch {
    // No WebGL — a headless test runner, or a machine with it disabled. The
    // catalogue falls back to its text-only tiles.
    return null;
  }
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.72));
  const key = new THREE.DirectionalLight(0xffffff, 0.85);
  key.position.set(0.6, 0.9, 1);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.25);
  fill.position.set(-0.8, -0.4, 0.6);
  scene.add(fill);

  const holder = new THREE.Group();
  scene.add(holder);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  rig = { renderer, scene, camera, holder };
  return rig;
}

/**
 * A mid-tone that reads on both themes.
 *
 * The tile behind it is `--surface-2`, which is near-black in dark and
 * near-white in light, and the preview has a transparent background so it sits
 * directly on that. A single mid-blue keeps contrast either way, where taking
 * the theme's own part colour would vanish into one of them.
 */
const MATERIAL = new THREE.MeshLambertMaterial({ color: 0x7fa8cc });

let queue: Promise<unknown> = Promise.resolve();

/** Render one part and read it back. Serialised — see the note at the top. */
async function render(part: CatalogPart): Promise<string | null> {
  const mesh = await loadPartMesh(part);
  if (mesh === null) return null;
  const r = getRig();
  if (r === null) return null;

  const body = new THREE.Mesh(mesh.geometry, MATERIAL);
  r.holder.add(body);

  // Centre the part on the origin, then frame it.
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox ?? new THREE.Box3(
    new THREE.Vector3(-25, -25, -25), new THREE.Vector3(25, 25, 25),
  );
  const centre = box.getCenter(new THREE.Vector3());
  body.position.set(-centre.x, -centre.y, -centre.z);

  // Three-quarter view: a part seen dead-on reads as a flat blob, and the whole
  // point here is to tell a hook from a shelf at a glance.
  const dir = new THREE.Vector3(0.42, -0.62, 0.66).normalize();

  /*
   * Fit the eight corners of the bounding BOX, not the bounding sphere.
   *
   * A sphere fit is the obvious thing and it wastes most of the frame on this
   * part set: a panel is a wide flat plate, its sphere radius is half its
   * DIAGONAL, and framing that leaves the plate a smudge in the middle of a
   * 48 px tile. Projecting the corners onto the camera's own axes and fitting
   * the widest of those is exact for any proportion, so a plate fills the frame
   * and a hook still fits.
   */
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const up = new THREE.Vector3(0, 0, 1);
  const right = new THREE.Vector3().crossVectors(dir, up).normalize();
  const trueUp = new THREE.Vector3().crossVectors(right, dir).normalize();
  let extent = 0;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const c = new THREE.Vector3(half.x * sx, half.y * sy, half.z * sz);
    extent = Math.max(extent, Math.abs(c.dot(right)), Math.abs(c.dot(trueUp)));
  }
  const dist = (extent > 0 ? extent : 50) / Math.tan((35 * Math.PI) / 360) * 1.12;

  r.camera.position.copy(dir).multiplyScalar(dist);
  r.camera.up.set(0, 0, 1);
  r.camera.lookAt(0, 0, 0);
  r.camera.updateProjectionMatrix();

  r.renderer.render(r.scene, r.camera);
  const url = r.renderer.domElement.toDataURL('image/png');

  r.holder.remove(body);
  return url;
}

/**
 * A PNG data URL for the part, or null if it cannot be drawn.
 *
 * Cached per part id and shared between every tile asking for the same one, so
 * a filter that shows a part twice costs one render.
 */
export function thumbnailFor(part: CatalogPart): Promise<string | null> {
  const hit = cache.get(part.id);
  if (hit !== undefined) return hit;
  const pending = queue.then(() => render(part)).catch(() => null);
  queue = pending;
  cache.set(part.id, pending);
  return pending;
}

/** Drop a part's preview — used when an imported part is removed or replaced. */
export function forgetThumbnail(partId: string): void {
  cache.delete(partId);
}
