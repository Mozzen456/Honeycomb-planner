/**
 * Reading a 3MF, and landing in exactly the same place an STL does.
 *
 * A 3MF carries three things an STL does not, and every one of them is a way to
 * be wrong without looking wrong:
 *
 *   - a DECLARED UNIT, which may be inches. A part read at face value out of an
 *     inch file is 25.4× too big — it would not fit the wall, and no number in
 *     the app would say why;
 *   - TRANSFORMS, per build item and per nested component. Ignoring them moves
 *     a part and, worse, turns it — and orientation is the one thing this app
 *     cannot detect its way out of, since `detect()` reads the mounting face
 *     off the geometry it is handed;
 *   - MIRRORING, when a transform has a negative determinant. A mirrored
 *     accessory is a left-hand hook on a right-hand wall: the exact failure the
 *     cyclic axis permutation in `meshLibrary.orient` exists to prevent.
 *
 * The fixtures are built here rather than committed, because a 3MF is a ZIP and
 * a binary fixture cannot be read in a diff. `makeZip` writes a real archive —
 * correct CRCs, both compression methods — so what is under test is the reader,
 * not a mock of one.
 */

import { describe, expect, it } from 'vitest';

import { proposeFromMesh, proposePart } from '../src/core/importPart';
import { isModelFile, looksLikeZip, parseModelFile } from '../src/core/modelFile';
import { measureMesh, parseStl } from '../src/core/stl';
import {
  compose, determinant, IDENTITY, modelPathIn, parse3mf, ThreeMfError, UNIT_SCALE,
} from '../src/core/threemf';
import { readDirectory, ZipError } from '../src/core/zip';
import type { Catalog } from '../src/core/types';

import catalogJson from '../src/catalog/catalog.json';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const catalog = catalogJson as unknown as Catalog;

// ---------------------------------------------------------------------------
// A real ZIP, written by hand
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** A genuine ZIP archive of `{name: text}`, stored or deflated. */
async function makeZip(
  files: Record<string, string>,
  { deflate = false }: { deflate?: boolean } = {},
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const raw = encoder.encode(text);
    const data = deflate ? await deflateRaw(raw) : raw;
    const nameBytes = encoder.encode(name);
    const crc = crc32(raw);
    const method = deflate ? 8 : 0;

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) { out.set(part, at); at += part.length; }
  return out.buffer;
}

// ---------------------------------------------------------------------------
// A 10 mm cube, wound outwards
// ---------------------------------------------------------------------------

const CUBE_VERTICES = [
  [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
  [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
];
const CUBE_TRIANGLES = [
  [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
  [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
];

function meshXml(id = '1'): string {
  const v = CUBE_VERTICES.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('');
  const t = CUBE_TRIANGLES.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('');
  return `<object id="${id}" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`;
}

function modelXml(
  { unit = 'millimeter', objects = meshXml(), build = '<item objectid="1"/>' } = {},
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>${objects}</resources>
  <build>${build}</build>
</model>`;
}

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

const make3mf = (xml: string, opts?: { deflate?: boolean }): Promise<ArrayBuffer> =>
  makeZip({ '_rels/.rels': RELS, '3D/3dmodel.model': xml }, opts);

// ---------------------------------------------------------------------------

describe('reading the archive', () => {
  it('reads a stored entry and a deflated one identically', async () => {
    const stored = await parse3mf(await make3mf(modelXml()));
    const packed = await parse3mf(await make3mf(modelXml(), { deflate: true }));
    expect(stored.mesh.triangleCount).toBe(12);
    expect([...packed.mesh.positions]).toEqual([...stored.mesh.positions]);
  });

  it('finds the model part through _rels/.rels', async () => {
    const names = ['_rels/.rels', '3D/somewhere-else.model', '[Content_Types].xml'];
    const rels = RELS.replace('/3D/3dmodel.model', '/3D/somewhere-else.model');
    expect(modelPathIn(names, rels)).toBe('3D/somewhere-else.model');
  });

  it('falls back to the conventional path, then to any .model', async () => {
    expect(modelPathIn(['3D/3dmodel.model'], null)).toBe('3D/3dmodel.model');
    expect(modelPathIn(['odd/place.model'], null)).toBe('odd/place.model');
    expect(modelPathIn(['thumbnail.png'], null)).toBeNull();
  });

  it('refuses a file that is not a zip, by name rather than by crashing', async () => {
    const junk = new TextEncoder().encode('definitely not a zip').buffer as ArrayBuffer;
    await expect(parse3mf(junk)).rejects.toThrow(ThreeMfError);
    expect(() => readDirectory(junk)).toThrow(ZipError);
  });

  it('refuses a zip with no model part', async () => {
    const zip = await makeZip({ 'readme.txt': 'hello' });
    await expect(parse3mf(zip)).rejects.toThrow(/no model part/i);
  });
});

describe('units — the 25.4× mistake', () => {
  it('reads a millimetre file at face value', async () => {
    const { mesh, unit } = await parse3mf(await make3mf(modelXml()));
    expect(unit).toBe('millimeter');
    expect(measureMesh(mesh).bboxMm).toEqual([10, 10, 10]);
  });

  it('converts inches to millimetres, and says so', async () => {
    const { mesh, warnings } = await parse3mf(await make3mf(modelXml({ unit: 'inch' })));
    const { bboxMm, volumeMm3 } = measureMesh(mesh);
    expect(bboxMm[0]).toBeCloseTo(254, 6);
    // Volume scales with the CUBE of the unit — a part converted twice, or on
    // one axis only, would still pass a bounding-box check.
    expect(volumeMm3).toBeCloseTo(254 ** 3, 3);
    // "inches", not "inchs" — the first run on a real file said the latter,
    // because the message pluralised by appending an s.
    expect(warnings.join(' ')).toContain('Drawn in inches');
  });

  it('names every unit in English rather than appending an s', async () => {
    const said = async (unit: string): Promise<string> =>
      (await parse3mf(await make3mf(modelXml({ unit })))).warnings.join(' ');
    expect(await said('inch')).toContain('inches');
    expect(await said('foot')).toContain('feet');
    expect(await said('micron')).toContain('microns');
    expect(await said('centimeter')).toContain('centimetres');
    // Millimetres are the app's own unit, so there is nothing to report.
    expect(await said('millimeter')).toBe('');
  });

  it('handles every unit the format allows', async () => {
    for (const [unit, scale] of Object.entries(UNIT_SCALE)) {
      const { mesh } = await parse3mf(await make3mf(modelXml({ unit })));
      expect(measureMesh(mesh).bboxMm[0]).toBeCloseTo(10 * scale, 6);
    }
  });

  it('refuses a unit it does not know rather than assuming millimetres', async () => {
    // Silently assuming mm is how a part ends up the wrong size with nothing
    // on screen to say why.
    await expect(parse3mf(await make3mf(modelXml({ unit: 'furlong' }))))
      .rejects.toThrow(/furlong/);
  });
});

describe('transforms', () => {
  it('applies a build item transform', async () => {
    const xml = modelXml({ build: '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 20 5"/>' });
    const { mesh } = await parse3mf(await make3mf(xml));
    const { minMm, maxMm } = measureMesh(mesh);
    expect(minMm).toEqual([100, 20, 5]);
    expect(maxMm).toEqual([110, 30, 15]);
  });

  it('composes a nested component transform with its parent', async () => {
    // Object 2 holds the cube; object 1 places it, and the build places object 1.
    const objects =
      meshXml('2') +
      '<object id="1" type="model"><components>' +
      '<component objectid="2" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>' +
      '</components></object>';
    const xml = modelXml({
      objects,
      build: '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 0 0"/>',
    });
    const { mesh } = await parse3mf(await make3mf(xml));
    // 5 from the component, 100 from the item: both, not one of them.
    expect(measureMesh(mesh).minMm[0]).toBeCloseTo(105, 6);
  });

  it('rotating 90° about z turns the part rather than moving it', async () => {
    const tall = modelXml({
      objects: meshXml(),
      build: '<item objectid="1" transform="0 1 0 -1 0 0 0 0 1 0 0 0"/>',
    });
    const { mesh } = await parse3mf(await make3mf(tall));
    const { minMm, maxMm } = measureMesh(mesh);
    // The 0..10 cube spun about z lands on −10..0 in x, 0..10 in y.
    expect(minMm[0]).toBeCloseTo(-10, 6);
    expect(maxMm[0]).toBeCloseTo(0, 6);
    expect(minMm[1]).toBeCloseTo(0, 6);
  });

  /**
   * A negative determinant MIRRORS, and a mirrored part is the failure that
   * looks fine.
   *
   * Asserted on a SIGNED volume computed here, deliberately not on
   * `measureMesh`, which takes the absolute value (`stl.ts`) — through it, a
   * mesh wound inside out measures exactly like a correct one and this test
   * would pass whether the winding were flipped or not. The bounding box is
   * no use either: mirroring a symmetric cube does not move it. The sign of the
   * enclosed volume is the only thing that actually changes.
   */
  const signedVolume = (positions: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < positions.length; i += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = [
        positions[i]!, positions[i + 1]!, positions[i + 2]!,
        positions[i + 3]!, positions[i + 4]!, positions[i + 5]!,
        positions[i + 6]!, positions[i + 7]!, positions[i + 8]!,
      ];
      sum += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    return sum;
  };

  it('flips winding under a mirroring transform, so the part is not inside out', async () => {
    const plain = await parse3mf(await make3mf(modelXml()));
    expect(signedVolume(plain.mesh.positions)).toBeCloseTo(1000, 2);

    const mirror = [-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    expect(determinant(mirror)).toBeLessThan(0);
    const { mesh } = await parse3mf(
      await make3mf(modelXml({ build: `<item objectid="1" transform="${mirror.join(' ')}"/>` })),
    );
    // Positive, not −1000: without the winding flip this is the same cube
    // turned inside out, and every normal-based reading — the overhang area,
    // `detect`'s choice of wall face — would be reversed.
    expect(signedVolume(mesh.positions)).toBeCloseTo(1000, 2);
    expect(measureMesh(mesh).bboxMm).toEqual([10, 10, 10]);
  });

  it('leaves winding alone when the transform does NOT mirror', async () => {
    // The flip must be conditional on the determinant, not applied to every
    // transform: flipping a rotation would break the parts that are fine now.
    const spin = [0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0];
    expect(determinant(spin)).toBeGreaterThan(0);
    const { mesh } = await parse3mf(
      await make3mf(modelXml({ build: `<item objectid="1" transform="${spin.join(' ')}"/>` })),
    );
    expect(signedVolume(mesh.positions)).toBeCloseTo(1000, 2);
  });

  it('composes in the right order — child first, then parent', () => {
    const move = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0];
    const scale = [2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0];
    // Move then scale doubles the offset; scale then move does not.
    expect(compose(scale, move).slice(9)).toEqual([20, 0, 0]);
    expect(compose(move, scale).slice(9)).toEqual([10, 0, 0]);
    expect(compose(IDENTITY, move)).toEqual(move);
  });
});

describe('what a 3MF may contain', () => {
  it('merges several build items and reports how many', async () => {
    const xml = modelXml({
      build: '<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 50 0 0"/>',
    });
    const { mesh, itemCount } = await parse3mf(await make3mf(xml));
    expect(itemCount).toBe(2);
    expect(mesh.triangleCount).toBe(24);
    expect(measureMesh(mesh).bboxMm[0]).toBeCloseTo(60, 6);
  });

  it('warns the caller when it merged a whole plate', async () => {
    const xml = modelXml({
      build: '<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 50 0 0"/>',
    });
    const { warnings } = await parseModelFile('plate.3mf', await make3mf(xml));
    expect(warnings.join(' ')).toMatch(/2 placed objects/);
    expect(warnings.join(' ')).toMatch(/build plate/);
  });

  it('uses the objects when there is no build section at all', async () => {
    const xml = `<model unit="millimeter"><resources>${meshXml()}</resources></model>`;
    const { mesh } = await parse3mf(await make3mf(xml));
    expect(mesh.triangleCount).toBe(12);
  });

  /**
   * The loop must be CUT, not merely survived.
   *
   * Object 2 carries real geometry as well as the back-reference, so a reader
   * that cut the loop still returns a cube — where one that simply ran out of
   * objects would return nothing. Asserting "it threw" would pass either way,
   * and would also pass if the reader hung until the test timed out.
   */
  it('cuts a component loop and still returns the geometry it did find', async () => {
    const objects =
      '<object id="1"><components><component objectid="2"/></components></object>' +
      meshXml('2').replace('<mesh>', '<components><component objectid="1"/></components><mesh>');
    const { mesh, warnings } = await parse3mf(await make3mf(modelXml({ objects })));
    expect(mesh.triangleCount).toBe(12);
    expect(warnings.join(' ')).toMatch(/refers to itself|loop was cut/i);
  });

  it('names an object that is referenced but missing, rather than failing silently', async () => {
    const xml = modelXml({ build: '<item objectid="1"/><item objectid="404"/>' });
    const { warnings, mesh } = await parse3mf(await make3mf(xml));
    expect(mesh.triangleCount).toBe(12);
    expect(warnings.join(' ')).toMatch(/"404"/);
  });

  it('reads a namespaced document', async () => {
    const xml = modelXml().replace(/<(\/?)(model|object|mesh|vertices|vertex|triangles|triangle|build|item|resources)/g, '<$1m:$2');
    const { mesh } = await parse3mf(await make3mf(xml));
    expect(mesh.triangleCount).toBe(12);
  });

  it('does not read geometry out of an XML comment', async () => {
    const xml = modelXml().replace(
      '<build>',
      '<!-- <vertex x="999" y="999" z="999"/> --><build>',
    );
    const { mesh } = await parse3mf(await make3mf(xml));
    expect(measureMesh(mesh).bboxMm).toEqual([10, 10, 10]);
  });
});

describe('the dispatcher', () => {
  it('accepts both extensions and nothing else', () => {
    expect(isModelFile('hook.stl')).toBe(true);
    expect(isModelFile('hook.3MF')).toBe(true);
    expect(isModelFile('layout.json')).toBe(false);
    expect(isModelFile('hook.step')).toBe(false);
  });

  it('trusts the BYTES over the name — a 3MF called .stl still reads', async () => {
    const zip = await make3mf(modelXml());
    expect(looksLikeZip(zip)).toBe(true);
    const { mesh, warnings } = await parseModelFile('actually-a-3mf.stl', zip);
    expect(mesh.triangleCount).toBe(12);
    expect(warnings.join(' ')).toMatch(/named as an STL but is really a 3MF/);
  });

  it('leaves an STL alone, with no warnings and no async surprises', async () => {
    const file = catalog.parts.find((p) => p.id === 'hook-side')!.file;
    const buf = readFileSync(resolve(__dirname, '..', file));
    const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    expect(looksLikeZip(bytes)).toBe(false);
    const { mesh, warnings } = await parseModelFile('hook-side.stl', bytes);
    expect(warnings).toEqual([]);
    expect(mesh.format).not.toBe('3mf');
  });
});

/**
 * The promise the feature actually makes.
 *
 * "You can upload a 3MF" means the part you get is the part you would have got
 * from the STL of the same model — same cells, same type, same size — not
 * merely that the file opens. So a real shipped model is converted to a 3MF and
 * put through the whole import, and the two results are compared.
 */
describe('a 3MF lands in the same place as the STL of the same model', () => {
  it('agrees on footprint, type and measurements', async () => {
    const original = catalog.parts.find((p) => p.id === '20-micro-sd-card-holder')!;
    const buf = readFileSync(resolve(__dirname, '..', original.file));
    const stlBytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const stlMesh = parseStl(stlBytes);

    // The same triangles, expressed the way a 3MF expresses them: an indexed
    // mesh in a build item, rather than a soup.
    const p = stlMesh.positions;
    const vertices: string[] = [];
    const triangles: string[] = [];
    for (let i = 0; i < stlMesh.triangleCount; i++) {
      const b = i * 9;
      for (let k = 0; k < 3; k++) {
        vertices.push(`<vertex x="${p[b + k * 3]}" y="${p[b + k * 3 + 1]}" z="${p[b + k * 3 + 2]}"/>`);
      }
      triangles.push(`<triangle v1="${i * 3}" v2="${i * 3 + 1}" v3="${i * 3 + 2}"/>`);
    }
    const objects =
      `<object id="1" type="model"><mesh><vertices>${vertices.join('')}</vertices>` +
      `<triangles>${triangles.join('')}</triangles></mesh></object>`;
    const zip = await make3mf(modelXml({ objects }), { deflate: true });

    const fromStl = proposeFromMesh('20-micro-sd-card-holder.stl', stlMesh, catalog);
    const from3mf = await proposePart('20-micro-sd-card-holder.3mf', zip, catalog);

    expect(from3mf.part.footprint).toEqual(fromStl.part.footprint);
    expect(from3mf.part.type).toBe(fromStl.part.type);
    expect(from3mf.detection.tier).toBe(fromStl.detection.tier);
    expect(from3mf.detection.wallFaceAxis).toBe(fromStl.detection.wallFaceAxis);
    expect(from3mf.part.bboxMm[0]).toBeCloseTo(fromStl.part.bboxMm[0]!, 3);
    expect(from3mf.part.volumeMm3).toBeCloseTo(fromStl.part.volumeMm3, 2);
    // ...and it is recognisably the same part in the catalogue, too.
    expect(from3mf.part.footprint).toEqual(original.footprint);
  });
});
