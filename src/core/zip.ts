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
 * **ZIP64 is not about size.** It was refused here at first on the reasoning
 * that a 3MF is measured in megabytes and ZIP64 begins at four gigabytes — true
 * about the format and false about the files. A writer is free to emit the
 * ZIP64 records ALWAYS, and some do: a 195 kB model downloaded from Printables
 * has every size and offset in its directory set to the 0xFFFFFFFF sentinel
 * with the real values in each entry's extra field. Refusing it read as "this
 * is a ZIP64 archive", which is a correct sentence about a file that is nowhere
 * near 4 GB. So the sentinels are followed, and the 64-bit values are still
 * bounded by `MAX_ENTRY_BYTES` when they are read.
 *
 * What it does NOT do, stated rather than discovered later: no encryption, no
 * compression method other than stored and deflate, no multi-disk archives.
 * Each is refused by name — a 3MF written by any slicer uses stored or deflate,
 * and a reader that guessed at the rest would be guessing about somebody's
 * model.
 */

/** Signatures, little-endian. */
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;

/** The ZIP64 end-of-central-directory LOCATOR is a fixed 20 bytes. */
const ZIP64_LOCATOR_SIZE = 20;

/** Extra-field header id for the ZIP64 extended information record. */
const ZIP64_EXTRA_ID = 0x0001;

/** A ZIP comment is a 16-bit length, so the EOCD is never deeper than this. */
const MAX_COMMENT = 0xffff;

/** The marker both sizes and offsets use to mean "see the ZIP64 record". */
const ZIP64_SENTINEL = 0xffffffff;
/** ...and the 16-bit one, for a count. */
const ZIP64_COUNT_SENTINEL = 0xffff;

/**
 * A 64-bit field, as a number this runtime can index with.
 *
 * A ZIP64 value is allowed to be larger than `Number.MAX_SAFE_INTEGER`, where
 * arithmetic silently stops being exact — so it is refused rather than rounded.
 * Nothing this reader opens is anywhere near it; the check is there so that if
 * one ever is, it fails with a sentence instead of reading the wrong bytes.
 */
function u64(view: DataView, at: number, what: string): number {
  const value = view.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipError(`The zip's ${what} is larger than this reader can address`);
  }
  return Number(value);
}

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
  let count = view.getUint16(eocd + 10, true);
  let dirOffset = view.getUint32(eocd + 16, true);

  /*
   * A sentinel in either field means the real value is in the ZIP64 record,
   * which is found through a locator sitting immediately before this one. Some
   * writers emit all of this on a file of a few hundred kilobytes.
   */
  if (dirOffset === ZIP64_SENTINEL || count === ZIP64_COUNT_SENTINEL) {
    const locator = eocd - ZIP64_LOCATOR_SIZE;
    if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR) {
      throw new ZipError('This zip says it is ZIP64 but has no ZIP64 locator');
    }
    const record = u64(view, locator + 8, 'ZIP64 directory position');
    if (record + 56 > bytes.length || view.getUint32(record, true) !== ZIP64_EOCD) {
      throw new ZipError('This zip\'s ZIP64 directory record is missing or corrupt');
    }
    count = u64(view, record + 32, 'entry count');
    dirOffset = u64(view, record + 48, 'directory position');
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
    const entry: ZipEntry = {
      name,
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      uncompressedSize: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    };
    applyZip64Extra(view, at + 46 + nameLen, extraLen, entry);
    entries.set(name, entry);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Fill in whichever of an entry's three numbers were sentinelled.
 *
 * The ZIP64 extra field is a packed list, NOT a struct with fixed slots: it
 * holds only the fields that were sentinelled, in the fixed order uncompressed,
 * compressed, local offset, disk. Reading it at fixed positions is the classic
 * way to get an offset that is really a size, which then inflates to garbage
 * rather than failing — so each value is consumed only if its own field asked
 * for it.
 */
function applyZip64Extra(view: DataView, start: number, length: number, entry: ZipEntry): void {
  const needs =
    entry.uncompressedSize === ZIP64_SENTINEL ||
    entry.compressedSize === ZIP64_SENTINEL ||
    entry.localOffset === ZIP64_SENTINEL;
  if (!needs) return;

  const end = start + length;
  for (let at = start; at + 4 <= end; ) {
    const id = view.getUint16(at, true);
    const size = view.getUint16(at + 2, true);
    let field = at + 4;
    if (field + size > end) break;
    if (id === ZIP64_EXTRA_ID) {
      const take = (what: string): number | null => {
        if (field + 8 > at + 4 + size) return null;
        const value = u64(view, field, what);
        field += 8;
        return value;
      };
      if (entry.uncompressedSize === ZIP64_SENTINEL) {
        entry.uncompressedSize = take(`size of "${entry.name}"`) ?? entry.uncompressedSize;
      }
      if (entry.compressedSize === ZIP64_SENTINEL) {
        entry.compressedSize = take(`packed size of "${entry.name}"`) ?? entry.compressedSize;
      }
      if (entry.localOffset === ZIP64_SENTINEL) {
        entry.localOffset = take(`position of "${entry.name}"`) ?? entry.localOffset;
      }
      return;
    }
    at += 4 + size;
  }
  throw new ZipError(`"${entry.name}" is marked ZIP64 but carries no ZIP64 record`);
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
