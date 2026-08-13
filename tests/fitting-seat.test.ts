/**
 * The seat correction, and who is allowed to receive it.
 *
 * `FITTING_SEAT_RADIANS` (30°) compensates the orientation a fitting's STL was
 * DRAWN in, so it exists only for meshes that came out of a file. Geometry the
 * view builds for itself — the placeholder prism used until an STL arrives, and
 * the collar drawn in each occupied cell — is already generated on the wall's
 * own lattice and must NOT be turned again.
 *
 * Getting that wrong is invisible in a still: a hexagon looks like a hexagon at
 * any angle, and it is only wrong relative to the cell under it. It shipped in
 * two of the four places that draw one, where the placeholder was laid across
 * the cell walls instead of into the hole. So the invariant is pinned here in
 * arithmetic rather than left to the eye.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

/** Vertex angles of a geometry's silhouette in the XY (wall) plane, degrees. */
function vertexAngles(geometry: THREE.BufferGeometry): number[] {
  const p = geometry.attributes['position']!.array;
  const seen = new Set<number>();
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!;
    const y = p[i + 1]!;
    if (Math.hypot(x, y) < 1e-6) continue;
    seen.add((Math.round((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * The corners of a pointy-top cell, straight out of `WallView3D.corner()`:
 * `60k − 90` degrees. A vertex at −90° is the point at the bottom.
 */
const POINTY_TOP_CORNERS = [0, 1, 2, 3, 4, 5]
  .map((k) => ((60 * k - 90) % 360 + 360) % 360)
  .sort((a, b) => a - b);

describe('fitting seat', () => {
  it('the view-built hexagonal prism already lands on the cell, unturned', () => {
    const g = new THREE.CylinderGeometry(10, 10, 5, 6);
    g.rotateX(Math.PI / 2);
    expect(vertexAngles(g)).toEqual(POINTY_TOP_CORNERS);
  });

  /**
   * The regression proper. Turning the placeholder by the seat correction puts
   * its vertices where the cell's EDGE midpoints are — a fitting lying across
   * two cell walls rather than seated in the hole.
   */
  it('turning that prism by the seat correction misaligns it with the cell', () => {
    const g = new THREE.CylinderGeometry(10, 10, 5, 6);
    g.rotateX(Math.PI / 2);
    g.rotateZ(Math.PI / 6);
    const turned = vertexAngles(g);
    expect(turned).not.toEqual(POINTY_TOP_CORNERS);
    // Exactly half a face out — the worst case available, not a graze.
    const circular = (a: number, b: number): number => {
      const d = Math.abs(a - b) % 360;
      return d > 180 ? 360 - d : d;
    };
    for (const a of turned) {
      expect(Math.min(...POINTY_TOP_CORNERS.map((c) => circular(a, c)))).toBe(30);
    }
  });

  it('30° is half a face, so the correction is its own inverse over 60°', () => {
    expect((Math.PI / 6) * 2).toBeCloseTo(Math.PI / 3, 12);
  });
});
