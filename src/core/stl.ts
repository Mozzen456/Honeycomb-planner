/**
 * STL reading and mesh measurement, in the browser.
 *
 * This is the front half of "drop an STL on the app and get a usable part": it
 * turns a file into triangles, and triangles into the numbers the catalogue
 * schema wants. It is deliberately the same arithmetic `tools/*.py` performs
 * with trimesh, so an imported part and a scanned one are measured the same
 * way and can sit in the same list without a footnote:
 *
 *   - volume by the signed-tetrahedron sum (agrees with trimesh to 1e-9
 *     relative across all 51 shipped models — see tests/stl.test.ts);
 *   - the supports heuristic is `tools/scan.py:overhang_report`, facet for
 *     facet: normal within 45° of straight down, excluding the bed face.
 *
 * Pure functions over an ArrayBuffer. No DOM, no three.js — the whole file is
 * testable under node, which is where its agreement with the Python side is
 * checked.
 */

export interface MeshData {
  /**
   * Triangle corners, 9 floats per triangle, in the model's own frame and in
   * MILLIMETRES. An STL carries no unit and is taken as mm; a 3MF declares one
   * and is converted on the way in (`threemf.ts`), so that by the time a mesh
   * reaches this shape the question is already settled.
   */
  positions: Float32Array;
  triangleCount: number;
  /** How it arrived. `3mf` meshes come from `threemf.ts`, not from this module. */
  format: 'binary' | 'ascii' | '3mf';
}

export interface MeshMeasure {
  /** Extent along x, y, z of the STL as drawn. */
  bboxMm: [number, number, number];
  minMm: [number, number, number];
  maxMm: [number, number, number];
  volumeMm3: number;
  areaMm2: number;
  triangles: number;
  /** Downward-facing area steeper than 45°, excluding the bed face. */
  overhangAreaMm2: number;
  overhangFraction: number;
  supports: boolean;
}

/** A binary STL is 84 bytes of header plus exactly 50 bytes per triangle. */
const BINARY_HEADER = 84;
const BINARY_STRIDE = 50;

export class StlParseError extends Error {}

/**
 * Read an STL, binary or ASCII.
 *
 * The format sniff is by *size*, not by the leading "solid" token. Plenty of
 * binary STLs in the wild — including several in `./models/` — begin with the
 * word "solid" in their 80-byte header because the exporter wrote a name there,
 * and every reader that trusts that token reads them as ASCII and returns zero
 * triangles. Checking whether the declared triangle count accounts for the file
 * length exactly cannot be fooled that way.
 */
export function parseStl(buffer: ArrayBuffer): MeshData {
  if (buffer.byteLength < 15) throw new StlParseError('File is too small to be an STL');

  if (buffer.byteLength >= BINARY_HEADER) {
    const view = new DataView(buffer);
    const count = view.getUint32(80, true);
    if (BINARY_HEADER + count * BINARY_STRIDE === buffer.byteLength && count > 0) {
      return parseBinary(view, count);
    }
  }
  return parseAscii(buffer);
}

function parseBinary(view: DataView, count: number): MeshData {
  const positions = new Float32Array(count * 9);
  let out = 0;
  for (let i = 0; i < count; i++) {
    // 12 bytes of facet normal are skipped deliberately: it is advisory, often
    // zero, and frequently disagrees with the winding. Normals are recomputed.
    let at = BINARY_HEADER + i * BINARY_STRIDE + 12;
    for (let k = 0; k < 9; k++) {
      positions[out++] = view.getFloat32(at, true);
      at += 4;
    }
  }
  return { positions, triangleCount: count, format: 'binary' };
}

function parseAscii(buffer: ArrayBuffer): MeshData {
  const text = new TextDecoder().decode(buffer);
  const numbers: number[] = [];
  // One pass, one regex: `vertex x y z`, whitespace-tolerant, exponent-tolerant.
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    numbers.push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  if (numbers.length === 0 || numbers.length % 9 !== 0) {
    throw new StlParseError(
      numbers.length === 0
        ? 'No triangles found — this does not look like an STL'
        : `Truncated ASCII STL: ${numbers.length / 3} vertices is not a whole number of triangles`,
    );
  }
  const positions = Float32Array.from(numbers);
  return { positions, triangleCount: numbers.length / 9, format: 'ascii' };
}

/**
 * Everything the catalogue schema needs that can be read straight off the mesh.
 *
 * One pass over the triangles for all of it — these files reach 19k triangles
 * and the import dialog measures on the main thread while the user watches.
 */
export function measureMesh(mesh: MeshData): MeshMeasure {
  const p = mesh.positions;
  const n = mesh.triangleCount;
  if (n === 0) throw new StlParseError('The mesh has no triangles');

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let volume = 0;
  let area = 0;

  for (let i = 0; i < n * 9; i += 3) {
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  // Second pass needs zmin, which the first pass just found.
  let overhang = 0;
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const ax = p[i]!, ay = p[i + 1]!, az = p[i + 2]!;
    const bx = p[i + 3]!, by = p[i + 4]!, bz = p[i + 5]!;
    const cx = p[i + 6]!, cy = p[i + 7]!, cz = p[i + 8]!;

    volume +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const twice = Math.hypot(nx, ny, nz);
    if (twice === 0) continue; // degenerate facet: no area, no normal
    const faceArea = twice / 2;
    area += faceArea;

    // Same rule as tools/scan.py:overhang_report — within 45° of straight down,
    // and not the face the part is printed on.
    const unitZ = nz / twice;
    const centroidZ = (az + bz + cz) / 3;
    if (unitZ < -Math.SQRT1_2 && centroidZ > minZ + 0.25) overhang += faceArea;
  }

  volume = Math.abs(volume);
  const fraction = area > 0 ? overhang / area : 0;

  return {
    bboxMm: [maxX - minX, maxY - minY, maxZ - minZ],
    minMm: [minX, minY, minZ],
    maxMm: [maxX, maxY, maxZ],
    volumeMm3: volume,
    areaMm2: area,
    triangles: n,
    overhangAreaMm2: overhang,
    overhangFraction: fraction,
    supports: overhang > 20 && fraction > 0.02,
  };
}

// ---------------------------------------------------------------------------
// Print estimate
// ---------------------------------------------------------------------------

/**
 * Filament and time for a part nobody has sliced.
 *
 * A scanned part carries a real PrusaSlicer result. An imported one cannot —
 * there is no slicer in a browser — so the honest options are to leave the
 * numbers blank or to model them and say so. This models them, and every part
 * built this way is stamped `source: 'volume'`, which the BOM and all three
 * exporters print as an estimate rather than a measurement.
 *
 * The model is shell-plus-infill, not volume × density: a hook is mostly
 * perimeter, and multiplying its solid volume by a constant is wrong by up to
 * 109% on this model set.
 *
 * **Fitted on 73 real slices, not on the 51 HSW parts alone.** The first
 * version was fitted only on the shipped catalogue, and that set is entirely
 * thin-walled — every part is a hook, a clip or a perforated plate. It had
 * therefore learned that family rather than the physics, and on geometry
 * outside it (a solid cube, a sphere, a flat plate) it predicted print time
 * **54–59% too slow**. That was only visible once those shapes were actually
 * sliced. `tests/fixtures/estimator-calibration.json` holds 27 such shapes with
 * their real results, so the failure cannot come back unnoticed.
 *
 * Measured error against real slices, with the shipped-then and now figures:
 *
 * |                    | first version | now |
 * |--------------------|---------------|-----|
 * | HSW parts, mass    | RMS 6.9%, worst 20% | RMS 7.0%, worst 21% |
 * | HSW parts, time    | RMS 15%, worst 42%  | RMS **13%**, worst **31%** |
 * | other geometry, time | worst **60%**     | worst **47%** |
 *
 * It is an estimate and the app says so everywhere it appears. Treat ±30% as
 * the working figure for HSW-like parts and ±50% for anything very unlike them.
 *
 * Refit with `python tools/calibrate_estimator.py`; the constants are specific
 * to the slicer profile recorded in HSW-SPEC.md §7.
 */
export const ESTIMATOR = {
  /** 2 perimeters at a 0.4 mm nozzle, as extruded width. */
  shellThicknessMm: 0.8,
  /** Effective solid fraction of the interior: 15% grid infill plus solid layers. */
  infillFraction: 0.17,
  /** PLA, g/cm³. */
  densityGPerCm3: 1.24,
  /**
   * Minutes per mm³ of shell and of infill, separately.
   *
   * They differ by more than 2× because perimeters print at 45 mm/s and infill
   * at 80 mm/s. One blended rate is what made a solid cube come out an hour
   * slow: nothing in the fitted family had any infill to speak of.
   */
  minutesPerShellMm3: 0.00789,
  minutesPerInfillMm3: 0.00374,
  /** Fixed cost per layer — travel, retraction, the first-layer slowdown. */
  minutesPerLayer: 0.0407,
  layerHeightMm: 0.2,
  /** Cross-section of 1.75 mm filament, mm². */
  filamentAreaMm2: Math.PI * 0.875 * 0.875,
} as const;

export interface PrintEstimateInput {
  volumeMm3: number;
  areaMm2: number;
  /** Height along the axis the part is printed on — the STL's own z. */
  heightMm: number;
  supports: boolean;
}

export function estimatePrint(input: PrintEstimateInput): {
  minutes: number;
  grams: number;
  metres: number;
  supports: boolean;
  source: 'volume';
} {
  const { volumeMm3, areaMm2, heightMm, supports } = input;
  // A thin-walled part is all shell; the cap stops the shell term exceeding the
  // solid it is made of, which it otherwise does for anything under ~1.6 mm.
  const shell = Math.min(areaMm2 * ESTIMATOR.shellThicknessMm, volumeMm3 * 0.95);
  const infill = Math.max(0, volumeMm3 - shell) * ESTIMATOR.infillFraction;
  const filamentMm3 = shell + infill;
  const layers = Math.max(1, heightMm / ESTIMATOR.layerHeightMm);

  return {
    minutes:
      shell * ESTIMATOR.minutesPerShellMm3 +
      infill * ESTIMATOR.minutesPerInfillMm3 +
      layers * ESTIMATOR.minutesPerLayer,
    grams: (filamentMm3 / 1000) * ESTIMATOR.densityGPerCm3,
    metres: filamentMm3 / ESTIMATOR.filamentAreaMm2 / 1000,
    supports,
    source: 'volume',
  };
}
