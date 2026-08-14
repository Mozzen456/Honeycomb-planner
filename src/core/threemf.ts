/**
 * Read a 3MF into the same triangle soup an STL gives us.
 *
 * A 3MF is a ZIP holding an XML model (`zip.ts` does the ZIP). Downstream —
 * `measureMesh`, `detect`, `meshLibrary` — wants exactly what `parseStl`
 * returns: 9 floats per triangle, in millimetres. So this file's whole job is
 * to get from the one to the other without losing anything that matters.
 *
 * Three things matter, and each is a way to be silently wrong:
 *
 * **1. Units.** An STL has none and this app assumes millimetres throughout.
 * A 3MF DECLARES its unit, and it is allowed to be inches. A part read at face
 * value out of an inch file is 25.4× too big — it would not fit the wall, and
 * nothing about the number would say why. Every coordinate is scaled on the way
 * through, and the unit is reported so the import dialog can say which one it
 * found.
 *
 * **2. Transforms.** An STL's coordinates are final. A 3MF's are per-object,
 * placed by a `<build><item>` transform and possibly nested through
 * `<components>`. Ignoring them puts a part at the wrong place and, worse, in
 * the wrong ORIENTATION — which is the one thing this app cannot detect its way
 * out of, because `detect()` reads the mounting face off the geometry it is
 * given.
 *
 * **3. Winding.** A negative-determinant transform mirrors the mesh, and a
 * mirrored accessory is a left-hand hook on a right-hand wall — wrong in a way
 * that looks fine, which is the same failure `meshLibrary.orient` guards
 * against with its cyclic axis permutation. Triangles under a mirroring
 * transform have their winding flipped back.
 *
 * The XML is read with a tag scanner rather than a DOM, because `DOMParser` is
 * a browser API and the rule in this repo is that load-bearing code is testable
 * without a browser. The scanner's limits are stated at `scanTags`.
 */

import type { MeshData } from './stl';
import { readDirectory, readEntry, ZipError, type ZipEntry } from './zip';

export class ThreeMfError extends Error {}

/** The relationship type that names the archive's root model part. */
const MODEL_REL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const DEFAULT_MODEL_PATH = '3D/3dmodel.model';

/**
 * Millimetres per 3MF unit. `millimeter` is the spec default and by far the
 * common case; the rest exist because CAD exports them.
 */
export const UNIT_SCALE: Readonly<Record<string, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/**
 * How to say each unit to a person.
 *
 * A map rather than `${unit}s`, which produced "Drawn in inchs" the first time
 * this ran on a real file. English plurals are irregular and the spec's names
 * are American; the wall is measured in millimetres everywhere else in this
 * app, so the message says millimetres too.
 */
const UNIT_NAME: Readonly<Record<string, string>> = {
  micron: 'microns',
  millimeter: 'millimetres',
  centimeter: 'centimetres',
  inch: 'inches',
  foot: 'feet',
  meter: 'metres',
};

/** Guard against a cyclic `<components>` graph, which the spec forbids and files still contain. */
const MAX_DEPTH = 12;

/** The same ceiling `stl.ts` would hit on a hostile file, stated here too. */
const MAX_TRIANGLES = 20_000_000;

export interface ThreeMfResult {
  mesh: MeshData;
  /** As declared in the file, before scaling. Reported so a person can check it. */
  unit: string;
  /** How many build items were merged into the one mesh. */
  itemCount: number;
  /** Things worth saying out loud, in the import dialog's own warning list. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// XML, scanned
// ---------------------------------------------------------------------------

interface Tag {
  name: string;
  attrs: string;
  /** `<foo/>` — open and close in one. */
  selfClosing: boolean;
  closing: boolean;
}

/**
 * Every tag in document order.
 *
 * A scanner, not a parser. It is enough here because a 3MF model part is
 * machine-written XML with a fixed, shallow shape, and it is honest about what
 * it does not do: no entity expansion (3MF coordinates are numbers), no
 * namespace resolution beyond dropping the prefix, no DTD. Quoted attribute
 * values are handled properly, so a `>` inside an attribute cannot end a tag
 * early, and comments are removed first so a commented-out `<vertex>` cannot be
 * read as geometry.
 */
function* scanTags(xml: string): Generator<Tag> {
  const text = xml.replace(/<!--[\s\S]*?-->/g, '');
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    yield {
      // Namespace prefixes are dropped: the core elements are usually
      // unprefixed, but a file that prefixes them is still the same file.
      name: (m[2] ?? '').split(':').pop() ?? '',
      attrs: m[3] ?? '',
      selfClosing: m[4] === '/',
      closing: m[1] === '/',
    };
  }
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return m ? (m[2] ?? m[3] ?? '') : null;
}

const num = (attrs: string, name: string): number => {
  const raw = attr(attrs, name);
  if (raw === null) return Number.NaN;
  return Number.parseFloat(raw);
};

// ---------------------------------------------------------------------------
// Transforms — 3×4, row-major, row-vector convention
// ---------------------------------------------------------------------------

/** `[m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32]`; the last triple translates. */
export type Matrix = readonly number[];

export const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export function parseMatrix(raw: string | null): Matrix {
  if (raw === null) return IDENTITY;
  const parts = raw.trim().split(/\s+/).map(Number);
  if (parts.length !== 12 || parts.some((v) => !Number.isFinite(v))) return IDENTITY;
  return parts;
}

/** `child` applied first, then `parent` — the order nesting actually means. */
export function compose(parent: Matrix, child: Matrix): number[] {
  const out = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        child[r * 3]! * parent[c]! +
        child[r * 3 + 1]! * parent[3 + c]! +
        child[r * 3 + 2]! * parent[6 + c]!;
    }
  }
  for (let c = 0; c < 3; c++) {
    out[9 + c] =
      child[9]! * parent[c]! +
      child[10]! * parent[3 + c]! +
      child[11]! * parent[6 + c]! +
      parent[9 + c]!;
  }
  return out;
}

/** Negative means the transform MIRRORS, and the winding has to be put back. */
export function determinant(m: Matrix): number {
  return (
    m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
    m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
    m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!)
  );
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

interface MeshObject {
  id: string;
  vertices: number[];
  /** Vertex INDICES, three per triangle — a 3MF is indexed where an STL is soup. */
  indices: number[];
  components: { objectid: string; transform: Matrix }[];
}

interface ParsedModel {
  unit: string;
  objects: Map<string, MeshObject>;
  build: { objectid: string; transform: Matrix }[];
}

function parseModelXml(xml: string): ParsedModel {
  const objects = new Map<string, MeshObject>();
  const build: ParsedModel['build'] = [];
  let unit = 'millimeter';
  let current: MeshObject | null = null;
  let inBuild = false;

  for (const tag of scanTags(xml)) {
    const { name, attrs, closing, selfClosing } = tag;

    if (name === 'model' && !closing) {
      unit = (attr(attrs, 'unit') ?? 'millimeter').toLowerCase();
      continue;
    }
    if (name === 'build') {
      inBuild = !closing;
      continue;
    }
    if (name === 'item' && !closing && inBuild) {
      const objectid = attr(attrs, 'objectid');
      if (objectid !== null) {
        build.push({ objectid, transform: parseMatrix(attr(attrs, 'transform')) });
      }
      continue;
    }
    if (name === 'object') {
      if (closing) {
        if (current !== null) objects.set(current.id, current);
        current = null;
      } else {
        const id = attr(attrs, 'id');
        current = id === null ? null : { id, vertices: [], indices: [], components: [] };
        // `<object id="1"/>` with no body is legal and empty; store it so a
        // build item referencing it resolves to nothing rather than to "missing".
        if (selfClosing && current !== null) {
          objects.set(current.id, current);
          current = null;
        }
      }
      continue;
    }
    if (current === null || closing) continue;

    if (name === 'vertex') {
      const x = num(attrs, 'x');
      const y = num(attrs, 'y');
      const z = num(attrs, 'z');
      // A vertex that does not parse would shift every index after it, so the
      // slot is kept and filled with zero rather than dropped.
      current.vertices.push(
        Number.isFinite(x) ? x : 0,
        Number.isFinite(y) ? y : 0,
        Number.isFinite(z) ? z : 0,
      );
    } else if (name === 'triangle') {
      const a = num(attrs, 'v1');
      const b = num(attrs, 'v2');
      const c = num(attrs, 'v3');
      if (Number.isInteger(a) && Number.isInteger(b) && Number.isInteger(c)) {
        current.indices.push(a, b, c);
      }
    } else if (name === 'component') {
      const objectid = attr(attrs, 'objectid');
      if (objectid !== null) {
        current.components.push({ objectid, transform: parseMatrix(attr(attrs, 'transform')) });
      }
    }
  }
  return { unit, objects, build };
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/**
 * Walk one object, emitting world-space triangles.
 *
 * `scale` folds the file's unit in here rather than in a second pass, so every
 * coordinate is converted exactly once — a part scaled twice is a part 645×
 * too big, and it would look like a parsing failure rather than a unit one.
 */
function emit(
  model: ParsedModel,
  objectid: string,
  transform: Matrix,
  scale: number,
  out: number[],
  seen: Set<string>,
  depth: number,
  warnings: string[],
): void {
  if (depth > MAX_DEPTH) {
    warnings.push('This model nests components more deeply than expected; the deepest were skipped.');
    return;
  }
  if (seen.has(objectid)) {
    warnings.push(`Object "${objectid}" refers to itself; the loop was cut.`);
    return;
  }
  const object = model.objects.get(objectid);
  if (object === undefined) {
    warnings.push(`This model refers to object "${objectid}", which is not in the file.`);
    return;
  }

  seen.add(objectid);
  for (const component of object.components) {
    emit(model, component.objectid, compose(transform, component.transform), scale, out, seen, depth + 1, warnings);
  }
  seen.delete(objectid);

  const { vertices, indices } = object;
  if (indices.length === 0) return;

  // A mirroring transform reverses which way a triangle faces. Left alone, the
  // whole part reads inside out: `measureMesh` gets a negative volume and every
  // normal-based test — the overhang area, `detect`'s wall face — is inverted.
  const flip = determinant(transform) < 0;
  const m = transform;

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const tri = flip
      ? [indices[i]!, indices[i + 2]!, indices[i + 1]!]
      : [indices[i]!, indices[i + 1]!, indices[i + 2]!];
    for (const index of tri) {
      const v = index * 3;
      if (v < 0 || v + 2 >= vertices.length + 1) {
        // An index past the end is a corrupt file; emit the origin so the
        // triangle count stays honest rather than silently shrinking.
        out.push(0, 0, 0);
        continue;
      }
      const x = vertices[v] ?? 0;
      const y = vertices[v + 1] ?? 0;
      const z = vertices[v + 2] ?? 0;
      out.push(
        (x * m[0]! + y * m[3]! + z * m[6]! + m[9]!) * scale,
        (x * m[1]! + y * m[4]! + z * m[7]! + m[10]!) * scale,
        (x * m[2]! + y * m[5]! + z * m[8]! + m[11]!) * scale,
      );
    }
  }
}

// ---------------------------------------------------------------------------

/** Which archive entry holds the model, following `_rels/.rels` when it can. */
export function modelPathIn(names: Iterable<string>, relsXml: string | null): string | null {
  const all = [...names];
  if (relsXml !== null) {
    for (const tag of scanTags(relsXml)) {
      if (tag.name !== 'Relationship' || tag.closing) continue;
      const type = attr(tag.attrs, 'Type');
      const target = attr(tag.attrs, 'Target');
      if (type === MODEL_REL && target !== null && target.length > 0) {
        const clean = target.replace(/^\/+/, '');
        if (all.includes(clean)) return clean;
      }
    }
  }
  if (all.includes(DEFAULT_MODEL_PATH)) return DEFAULT_MODEL_PATH;
  // Last resort: any part that looks like a model. A file whose relationships
  // are missing is still readable, and refusing it would be pedantry.
  return all.find((n) => n.toLowerCase().endsWith('.model')) ?? null;
}

/**
 * Read a 3MF as one mesh in millimetres.
 *
 * Every build item is merged. A 3MF can hold a whole build PLATE — six unrelated
 * parts arranged for printing — and this app's unit is one part, so merging is
 * the wrong answer for that file and the right one for the far commoner case of
 * a single object assembled from components. It is therefore done, and SAID:
 * the item count comes back and the caller warns when it is more than one,
 * because a person who dropped a plate in needs to know why their hook is six
 * hooks rather than finding out at the printer.
 */
export async function parse3mf(buffer: ArrayBuffer): Promise<ThreeMfResult> {
  let entries: Map<string, ZipEntry>;
  try {
    entries = readDirectory(buffer);
  } catch (e) {
    throw new ThreeMfError(
      e instanceof ZipError ? `This is not a readable 3MF: ${e.message}` : String(e),
    );
  }

  const decoder = new TextDecoder();
  const relsEntry = entries.get('_rels/.rels');
  const relsXml = relsEntry ? decoder.decode(await readEntry(buffer, relsEntry)) : null;

  const path = modelPathIn(entries.keys(), relsXml);
  if (path === null) throw new ThreeMfError('This 3MF contains no model part');
  const entry = entries.get(path);
  if (entry === undefined) throw new ThreeMfError(`This 3MF names a model part ("${path}") it does not contain`);

  let xml: string;
  try {
    xml = decoder.decode(await readEntry(buffer, entry));
  } catch (e) {
    throw new ThreeMfError(e instanceof ZipError ? e.message : String(e));
  }

  const model = parseModelXml(xml);
  const warnings: string[] = [];

  const scale = UNIT_SCALE[model.unit];
  if (scale === undefined) {
    throw new ThreeMfError(
      `This 3MF declares its unit as "${model.unit}", which is not one of the six the format allows. ` +
        'Re-export it in millimetres.',
    );
  }
  if (model.unit !== 'millimeter') {
    warnings.push(
      `Drawn in ${UNIT_NAME[model.unit] ?? model.unit} — every measurement below has been ` +
        `converted to millimetres (×${scale}).`,
    );
  }

  /*
   * No `<build>` is not an error. Plenty of files written as a plain mesh
   * container omit it, and the objects are still the model — so every object
   * that has triangles of its own is used, untransformed.
   */
  const items = model.build.length > 0
    ? model.build
    : [...model.objects.values()]
        .filter((o) => o.indices.length > 0)
        .map((o) => ({ objectid: o.id, transform: IDENTITY }));

  if (items.length === 0) throw new ThreeMfError('This 3MF contains no geometry');

  const out: number[] = [];
  for (const item of items) {
    emit(model, item.objectid, item.transform, scale, out, new Set(), 0, warnings);
  }

  const triangleCount = Math.floor(out.length / 9);
  if (triangleCount === 0) throw new ThreeMfError('This 3MF contains no triangles');
  if (triangleCount > MAX_TRIANGLES) {
    throw new ThreeMfError(`This 3MF has ${triangleCount.toLocaleString()} triangles, which is beyond what can be handled`);
  }

  return {
    mesh: { positions: new Float32Array(out), triangleCount, format: '3mf' },
    unit: model.unit,
    itemCount: items.length,
    warnings,
  };
}
