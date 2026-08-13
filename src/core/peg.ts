/**
 * Find the hexagonal PEG a part mounts through.
 *
 * ---------------------------------------------------------------------------
 * Why this exists alongside `detect.ts`
 * ---------------------------------------------------------------------------
 *
 * `detect.ts` answers "which cells does this occupy", and for 27 of the 51
 * shipped parts it cannot: they have no wall interface on any axis, because they
 * do not touch the wall at all. They plug into an INSERT, and the insert clips
 * into the cell (HSW-SPEC §5). For those parts `insertFed` falls back to picking
 * the face with the most material just under the surface — which for a shelf is
 * the underside of the tray, not the end the pegs come out of. That guess is
 * where "the detector says Bottom (−Z) and the pegs are on another face
 * entirely" comes from.
 *
 * The peg is a different question and it IS measurable. It is a hexagonal prism
 * of a known size — the insert's socket — and a hexagonal prism has a signature
 * nothing else in these models has: every one of its side faces is parallel to
 * the prism axis, and their normals fall on six directions exactly 60° apart.
 * Finding that costs one pass over the triangles and needs no raster, no
 * sectioning and no shapely.
 *
 * ---------------------------------------------------------------------------
 * What it does NOT do
 * ---------------------------------------------------------------------------
 *
 * It does not produce a footprint. Which CELLS an installer puts the part's
 * inserts in is their choice and no measurement can recover it — that is
 * PARKED P1 and it stands. This narrows the question to the one part of it
 * geometry can actually answer: which way round the part goes.
 *
 * Pure functions over a `MeshData`. No DOM, no three.js.
 */

import type { MeshData } from './stl';
import type { Axis } from './detect';

export interface PegDetection {
  /** The axis the peg runs along — the wall normal. */
  axis: Axis;
  /** Which end of that axis the peg protrudes from. */
  end: 'low' | 'high';
  /**
   * Share of the side-face area that lies on the hexagon's six normals, 0..1.
   *
   * This is the honest part. A clean hexagonal peg scores near 1; a part whose
   * "peg" is really a chamfered boss or a rounded lug scores low, and a low
   * score is reported rather than rounded up to a confident answer.
   */
  confidence: number;
}

/*
 * NO WIDTH IS REPORTED, deliberately.
 *
 * The obvious next number is the prism's across-flats, to say whether it matches
 * an insert socket. It was tried and removed. A face's plane offset is
 * `centroid · n`, and two opposite faces of ONE prism have offsets that sum to
 * the width — but these parts carry many instances of the same feature (a panel
 * has 56 identical holes), so averaging offsets over a normal direction mixes
 * features that are centimetres apart and returns a number that means nothing.
 * It produced widths of 2.2 mm and −0.96 mm on real parts.
 *
 * Separating the instances first is a clustering problem, and doing it badly
 * would put a confident wrong measurement in front of a person deciding how to
 * mount something. The axis is what this module is for; the width can come later
 * with the clustering it needs.
 */

const AXIS_ORDER: readonly Axis[] = ['x', 'y', 'z'];
const INDEX: Record<Axis, [number, number, number]> = {
  x: [0, 1, 2],
  y: [1, 2, 0],
  z: [2, 0, 1],
};

interface Face {
  /** Unit normal, as the three components. */
  nx: number;
  ny: number;
  nz: number;
  area: number;
  /** Centroid along the candidate axis. */
  along: number;
  /** Centroid in the plane perpendicular to the axis. */
  cu: number;
  cv: number;
}

/** Per-triangle normals, areas and centroids — one pass, reused per axis. */
function faces(mesh: MeshData, axis: Axis): Face[] {
  const [ai, ui, vi] = INDEX[axis];
  const p = mesh.positions;
  const out: Face[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    const i = t * 9;
    const ax = p[i]!, ay = p[i + 1]!, az = p[i + 2]!;
    const bx = p[i + 3]!, by = p[i + 4]!, bz = p[i + 5]!;
    const cx = p[i + 6]!, cy = p[i + 7]!, cz = p[i + 8]!;
    const e1 = [bx - ax, by - ay, bz - az];
    const e2 = [cx - ax, cy - ay, cz - az];
    const nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
    const ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    const nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    const centroid = [(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3];
    out.push({
      nx: nx / len,
      ny: ny / len,
      nz: nz / len,
      area: len / 2,
      along: centroid[ai]!,
      cu: centroid[ui]!,
      cv: centroid[vi]!,
    });
  }
  return out;
}

/**
 * The best hexagonal prism in the mesh, or null if there is not one.
 *
 * Scored per axis and the winner taken on confidence × area, so a large clean
 * hexagon beats a small clean one — the peg is the feature that matters, and on
 * these parts it is the biggest prismatic thing on its axis.
 */
export function detectPeg(mesh: MeshData): PegDetection | null {
  let best: PegDetection | null = null;
  let bestScore = 0;

  for (const axis of AXIS_ORDER) {
    const [ai, ui, vi] = INDEX[axis];
    const fs = faces(mesh, axis);

    // Side faces of a prism on this axis: normal perpendicular to the axis.
    const comp = (f: Face): number => (ai === 0 ? f.nx : ai === 1 ? f.ny : f.nz);
    const u = (f: Face): number => (ui === 0 ? f.nx : ui === 1 ? f.ny : f.nz);
    const v = (f: Face): number => (vi === 0 ? f.nx : vi === 1 ? f.ny : f.nz);

    const side = fs.filter((f) => Math.abs(comp(f)) < 0.05);
    let sideArea = 0;
    for (const f of side) sideArea += f.area;
    if (sideArea <= 1) continue;

    // Bin the in-plane normal angle modulo 60°. A hexagonal prism puts all of
    // its side area into one bin; a cylinder spreads evenly across all of them.
    const BINS = 60;
    const bins = new Float64Array(BINS);
    for (const f of side) {
      const deg = ((Math.atan2(u(f), v(f)) * 180) / Math.PI + 360) % 60;
      bins[Math.min(BINS - 1, Math.floor(deg))]! += f.area;
    }
    let peak = 0;
    let peakArea = 0;
    for (let b = 0; b < BINS; b++) {
      // A degree either side, so a mesh whose normals sit a hair off exact does
      // not get split across two bins.
      const near = bins[(b + BINS - 1) % BINS]! + bins[b]! + bins[(b + 1) % BINS]!;
      if (near > peakArea) { peakArea = near; peak = b; }
    }
    // Clamped: the three-bin window can sum to a hair over the total through
    // float rounding, and a SHARE above 1 is nonsense to show anyone.
    const confidence = Math.min(1, peakArea / sideArea);
    if (confidence < 0.25) continue;

    const onPeak = side.filter((f) => {
      const deg = ((Math.atan2(u(f), v(f)) * 180) / Math.PI + 360) % 60;
      const d = Math.abs(deg - peak);
      return Math.min(d, 60 - d) <= 2;
    });
    if (onPeak.length === 0) continue;



    /*
     * Which END the peg is on.
     *
     * The peg protrudes, so its material sits beyond the body's own middle.
     * Comparing the peg faces' mean position along the axis with the mesh's
     * midpoint says which way it sticks out, and needs no assumption about
     * which end is "front".
     */
    let lo = Infinity;
    let hi = -Infinity;
    for (const f of fs) {
      if (f.along < lo) lo = f.along;
      if (f.along > hi) hi = f.along;
    }
    let pegAlong = 0;
    let pegArea = 0;
    for (const f of onPeak) { pegAlong += f.along * f.area; pegArea += f.area; }
    pegAlong /= pegArea || 1;
    const end: 'low' | 'high' = pegAlong < (lo + hi) / 2 ? 'low' : 'high';

    const score = confidence * peakArea;
    if (score > bestScore) {
      bestScore = score;
      best = { axis, end, confidence };
    }
  }

  return best;
}
