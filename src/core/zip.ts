/**
 * Just enough ZIP to read a 3MF.
 *
 * A 3MF is a ZIP archive with an XML model inside it, so reading one means
 * reading a ZIP. This is the smallest correct reader for that job and nothing
 * more: it lists the central directory and inflates one named entry.
 *
 * **No dependency, on purpose.** `DecompressionStream('deflate-raw')` is a
 * platform API in both browsers and Node, which is exactly the two places this
 * has to work — the app and a `vitest` run with `environment: 'node'`. The
 * alternative was three's bundled `fflate`, reached through
 * `three/examples/jsm/libs/…`, which is a transitive path that npm is free to
 * hoist differently and that three is free to move between versions. A hundred
 * lines of header parsing is the cheaper of the two.
 *
 * What it does NOT do, stated rather than discovered later: no ZIP64 (an entry
 * or archive over 4 GB), no encryption, no compression method other than stored
 * and deflate, no multi-disk archives. Each of those is refused by name — a
 * 3MF written by any slicer uses stored or deflate and is measured in
 * megabytes, and a reader that guesses at the rest would be guessing about
 * somebody's model.
 */

/** Signatures, little-endian. */
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** A ZIP comment is a 16-bit length, so the EOCD is never deeper than this. */
const MAX_COMMENT = 0xffff;

/** The marker both sizes and offsets use to mean "see the ZIP64 record". */
const ZIP64_SENTINEL = 0xffffffff;

/**
 * Ceiling on a single inflated entry. A 3MF model part is a few MB of XML; a
 * hundred is already absurd. Without a bound, a 40 kB archive can ask for all
 * the memory in the tab — the same decompression-bomb defence `persist.ts`
 * applies to share links.
 */
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. Anything else is refused when read. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the LOCAL header, which is where the data actually lives. */
  localOffset: number;
}

// ---------------------------------------------------------------------------

/**
 * Where the end-of-central-directory record starts, or −1.
 *
 * Scanned BACKWARDS, because the record is at the end and a trailing comment
 * of arbitrary length sits after it. Searching forwards would match the bytes
 * `PK\x05\x06` anywhere they happen to occur inside compressed data.
 */
function findEocd(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const earliest = Math.max(0, bytes.length - MAX_COMMENT - 22);
  for (let i = bytes.length - 22; i >= earliest; i--) {
    if (view.getUint32(i, true) === EOCD) return i;
  }
  return -1;
}

/** Every entry in the archive, by name. Throws if this is not a readable ZIP. */
export function readDirectory(buffer: ArrayBuffer): Map<string, ZipEntry> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 22) throw new ZipError('The file is too small to be a zip archive');

  const eocd = findEocd(bytes);
  if (eocd < 0) {
    throw new ZipError('No zip directory found — the file is truncated, or is not a zip archive');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(eocd + 10, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  if (dirOffset === ZIP64_SENTINEL || count === 0xffff) {
    throw new ZipError('This is a ZIP64 archive, which this reader does not handle');
  }
  if (dirOffset >= bytes.length) throw new ZipError('The zip directory points outside the file');

  const entries = new Map<string, ZipEntry>();
  let at = dirOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length) throw new ZipError('The zip directory is truncated');
    if (view.getUint32(at, true) !== CENTRAL) {
      throw new ZipError(`Corrupt zip directory at entry ${i + 1}`);
    }
    const flags = view.getUint16(at + 8, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const name = decodeName(bytes.subarray(at + 46, at + 46 + nameLen), flags);
    entries.set(name, {
      name,
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      uncompressedSize: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Names are UTF-8 when bit 11 is set and CP437 otherwise. Every 3MF writer
 * sets it; the fallback treats the bytes as Latin-1, which is right for the
 * ASCII paths a 3MF actually uses and wrong only for accented legacy names.
 */
function decodeName(raw: Uint8Array, flags: number): string {
  if ((flags & 0x800) !== 0) return new TextDecoder().decode(raw);
  let out = '';
  for (const b of raw) out += String.fromCharCode(b);
  return out;
}

/** The bytes of one entry, inflated if it needs it. */
export async function readEntry(buffer: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (entry.localOffset + 30 > bytes.length) {
    throw new ZipError(`"${entry.name}" points outside the file`);
  }
  if (view.getUint32(entry.localOffset, true) !== LOCAL) {
    throw new ZipError(`"${entry.name}" has no local header`);
  }
  /*
   * The data offset comes from the LOCAL header's own name and extra lengths,
   * not the central directory's. They are allowed to differ — many writers put
   * a Zip64 or timestamp extra field in one and not the other — and using the
   * central directory's extra length here reads from a few bytes off, which
   * inflates to garbage rather than failing cleanly.
   */
  const nameLen = view.getUint16(entry.localOffset + 26, true);
  const extraLen = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new ZipError(`"${entry.name}" is truncated`);
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new ZipError(
      `"${entry.name}" unpacks to ${Math.round(entry.uncompressedSize / (1024 * 1024))} MB, ` +
        `beyond the ${MAX_ENTRY_BYTES / (1024 * 1024)} MB limit`,
    );
  }

  const raw = bytes.subarray(start, end);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) {
    throw new ZipError(`"${entry.name}" uses compression method ${entry.method}, which is not supported`);
  }
  return inflateRaw(raw);
}

/**
 * Raw DEFLATE, through the platform.
 *
 * `deflate-raw` rather than `deflate`: a ZIP entry carries no zlib header, and
 * asking for `deflate` fails on the very first byte.
 */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new ZipError('This browser cannot decompress zip archives');
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(
    new DecompressionStream('deflate-raw'),
  );
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    // Checked while unpacking as well as from the header: the declared
    // uncompressed size is a claim made by the file being defended against.
    if (total > MAX_ENTRY_BYTES) {
      void reader.cancel();
      throw new ZipError('A zip entry unpacked to more than the size it declared');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
