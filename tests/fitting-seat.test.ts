/**
 * View-built hexagons have to seat in a wall cell.
 *
 * `FITTING_SEAT_RADIANS` is gone (D35). It compensated the 30° between flat-top
 * parts and a pointy-top wall, and turning the wall removed the difference — a
 * mesh loaded from a file now lands in its hole unturned.
 *
 * The opposite correction is what survives, and it is the reason this file still
 * exists. `CylinderGeometry(…, 6).rotateX(90°)` puts its corners at 30°/90°/…,
 * which fitted a pointy-top cell exactly and is half a face out from a flat-top
 * one. So the collar and the placeholder prisms need the turn that real meshes
 * no longer do. `cellPrism` in WallView3D is where that lives.
 *
 * Getting it wrong is invisible in a still: a hexagon looks like a hexagon at any
 * angle, and it is only wrong relative to the cell under it. That is exactly how
 * it shipped in two of four places once already. So it is pinned here in
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
 * The corners of a FLAT-TOP cell, straight out of `hexCorners` in hex.ts and
 * `corner()` in WallView3D: `60k` degrees. A corner at 0° is the point on the
 * right, which puts a flat edge across the top.
 */
const FLAT_TOP_CORNERS = [0, 1, 2, 3, 4, 5]
  .map((k) => ((60 * k) % 360 + 360) % 360)
  .sort((a, b) => a - b);

describe('fitting seat', () => {
  it('a raw prism is half a face out from the cell, which is why cellPrism exists', () => {
    const g = new THREE.CylinderGeometry(10, 10, 5, 6);
    g.rotateX(Math.PI / 2);
    expect(vertexAngles(g)).not.toEqual(FLAT_TOP_CORNERS);
  });

  it('cellPrism lands on the cell exactly', () => {
    // The same two turns `cellPrism` applies, kept here as arithmetic so this
    // does not become a test of itself.
    const g = new THREE.CylinderGeometry(10, 10, 5, 6);
    g.rotateX(Math.PI / 2);
    g.rotateZ(Math.PI / 6);
    expect(vertexAngles(g)).toEqual(FLAT_TOP_CORNERS);
  });

  /**
   * The regression proper. Turning the placeholder by the seat correction puts
   * its vertices where the cell's EDGE midpoints are — a fitting lying across
   * two cell walls rather than seated in the hole.
   */
  it('turning it a further 30° misaligns it again — the correction is not a nudge', () => {
    const g = new THREE.CylinderGeometry(10, 10, 5, 6);
    g.rotateX(Math.PI / 2);
    const turned = vertexAngles(g);
    expect(turned).not.toEqual(FLAT_TOP_CORNERS);
    // Exactly half a face out — the worst case available, not a graze.
    const circular = (a: number, b: number): number => {
      const d = Math.abs(a - b) % 360;
      return d > 180 ? 360 - d : d;
    };
    for (const a of turned) {
      expect(Math.min(...FLAT_TOP_CORNERS.map((c) => circular(a, c)))).toBe(30);
    }
  });

  it('30° is half a face, so the correction is its own inverse over 60°', () => {
    expect((Math.PI / 6) * 2).toBeCloseTo(Math.PI / 3, 12);
  });
});
