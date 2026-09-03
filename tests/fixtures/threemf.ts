/**
 * A 3MF, written by hand, for whichever test needs one.
 *
 * Built rather than committed, because a 3MF is a ZIP and a binary fixture
 * cannot be read in a diff. `makeZip` writes a REAL archive — correct CRCs,
 * both compression methods — so what a test using this exercises is the reader,
 * not a fixture that happens to agree with it.
 *
 * Shared by `threemf.test.ts`, which tests the reader, and `peg-adder.test.ts`,
 * which needs a genuine 3MF to prove one converts to STL. Two copies of a ZIP
 * writer is two chances to write it wrong.
 */

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

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
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

/**
 * A genuine ZIP archive of `{name: text}`, stored or deflated.
 *
 * `zip64` writes the archive the way a writer that ALWAYS emits ZIP64 does:
 * every size and offset in the central directory replaced by the 0xFFFFFFFF
 * sentinel, the real 64-bit values in each entry's extra field, and a ZIP64
 * end-of-directory record with its locator before the ordinary one. That is not
 * a hypothetical — it is byte-for-byte the shape of a 195 kB model downloaded
 * from Printables, which is why the reader has to follow it.
 *
 * The LOCAL headers keep their ordinary 32-bit sizes, exactly as they may: the
 * reader takes an entry's sizes from the directory and only its name and extra
 * LENGTHS from the local header.
 */
export async function makeZip(
  files: Record<string, string>,
  { deflate = false, zip64 = false }: { deflate?: boolean; zip64?: boolean } = {},
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

    const extraLen = zip64 ? 28 : 0;
    const central = new Uint8Array(46 + nameBytes.length + extraLen);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, zip64 ? 0xffffffff : data.length, true);
    cv.setUint32(24, zip64 ? 0xffffffff : raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, extraLen, true);
    cv.setUint32(42, zip64 ? 0xffffffff : offset, true);
    central.set(nameBytes, 46);
    if (zip64) {
      const at = 46 + nameBytes.length;
      cv.setUint16(at, 0x0001, true);
      cv.setUint16(at + 2, 24, true);
      // Order is fixed by the spec: uncompressed, compressed, local offset.
      cv.setBigUint64(at + 4, BigInt(raw.length), true);
      cv.setBigUint64(at + 12, BigInt(data.length), true);
      cv.setBigUint64(at + 20, BigInt(offset), true);
    }
    centrals.push(central);

    offset += local.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);

  const tail: Uint8Array[] = [];
  if (zip64) {
    const record = new Uint8Array(56);
    const rv = new DataView(record.buffer);
    rv.setUint32(0, 0x06064b50, true);
    rv.setBigUint64(4, BigInt(44), true); // size of the rest of this record
    rv.setUint16(12, 45, true);
    rv.setUint16(14, 45, true);
    rv.setBigUint64(24, BigInt(centrals.length), true);
    rv.setBigUint64(32, BigInt(centrals.length), true);
    rv.setBigUint64(40, BigInt(cdSize), true);
    rv.setBigUint64(48, BigInt(offset), true);
    tail.push(record);

    const locator = new Uint8Array(20);
    const lv = new DataView(locator.buffer);
    lv.setUint32(0, 0x07064b50, true);
    lv.setBigUint64(8, BigInt(offset + cdSize), true);
    lv.setUint32(16, 1, true);
    tail.push(locator);
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, zip64 ? 0xffffffff : offset, true);
  tail.push(eocd);

  const total = offset + cdSize + tail.reduce((n, t) => n + t.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...locals, ...centrals, ...tail]) { out.set(part, at); at += part.length; }
  return out.buffer;
}

// ---------------------------------------------------------------------------
// A 10 mm cube, wound outwards
// ---------------------------------------------------------------------------

export const CUBE_VERTICES = [
  [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
  [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
];
export const CUBE_TRIANGLES = [
  [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
  [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
];

export function meshXml(id = '1'): string {
  const v = CUBE_VERTICES.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('');
  const t = CUBE_TRIANGLES.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('');
  return `<object id="${id}" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`;
}

export function modelXml(
  { unit = 'millimeter', objects = meshXml(), build = '<item objectid="1"/>' } = {},
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>${objects}</resources>
  <build>${build}</build>
</model>`;
}

export const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

export const make3mf = (
  xml: string,
  opts?: { deflate?: boolean; zip64?: boolean },
): Promise<ArrayBuffer> => makeZip({ '_rels/.rels': RELS, '3D/3dmodel.model': xml }, opts);

/**
 * A 3MF written the way Bambu Studio writes one: the model part holds no mesh
 * at all, only a component pointing at a SECOND part in the archive through the
 * production extension's `p:path`.
 *
 * Both parts number their object `1`, on purpose. Ids are per PART, so a
 * collision is ordinary — and a reader that keys an object on the id alone then
 * reads the component as a reference to itself and cuts the "loop", losing the
 * geometry. With different ids that bug passes unnoticed.
 */
export function makeMultiPart3mf(
  { transform = '', deflate = true }: { transform?: string; deflate?: boolean } = {},
): Promise<ArrayBuffer> {
  const root = modelXml({
    objects:
      '<object id="1" type="model"><components>' +
      `<component objectid="1" p:path="/3D/Objects/object_1.model"${transform}/>` +
      '</components></object>',
    build: '<item objectid="1"/>',
  }).replace(
    '<model unit=',
    '<model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" unit=',
  );
  const part = modelXml({ objects: meshXml('1'), build: '' });
  return makeZip(
    {
      '_rels/.rels': RELS,
      '3D/3dmodel.model': root,
      '3D/Objects/object_1.model': part,
    },
    { deflate },
  );
}
