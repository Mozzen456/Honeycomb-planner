/**
 * Saving, loading and sharing a layout.
 *
 * The governing rule of this module: **losing the user's layout is the worst
 * thing this app can do.** Everything here is therefore written to salvage
 * rather than to reject. `deserialize` never throws — not on truncated JSON,
 * not on a 50 MB blob, not on `{"items": "banana"}` — it returns whatever it
 * could rescue plus one human-readable line per problem it found. A layout that
 * comes back with 3 of 200 items dropped and 3 explanations is recoverable; an
 * exception that bubbles into a file-open handler is not.
 *
 * Pure functions. No DOM, no fetch, no storage: callers own the I/O.
 */

import { BEDS, clampBedMm, CUSTOM_BED_ID, MAX_BED_MM, MIN_BED_MM } from './constants';
import { hasColors, readColors } from './colors';
import { DEFAULT_BORDER_MM, MAX_BORDER_MM } from './honeycomb';
import { MAX_PROJECT_PARTS } from './projectParts';
import { clampMmPerPixel, clampPhotoOpacity, DEFAULT_PHOTO_OPACITY } from './wallPhoto';
import type {
  FixingEdits, Group, Hex, LayoutDoc, Obstacle, PlacedItem, PlacedPanel, Rotation, WallColors,
  WallFrame, WallPhoto, WallSpec, ZoneRect,
} from './types';

/** Schema version this build writes. Bumped whenever the document shape changes. */
export const CURRENT_SCHEMA = 1;

export interface LoadResult {
  doc: LayoutDoc | null;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Limits. Hostile input is assumed; every unbounded loop gets a ceiling.
// ---------------------------------------------------------------------------

/** Longest text we will even attempt to parse. A 200-item layout is ~25 kB. */
const MAX_TEXT_CHARS = 32 * 1024 * 1024;
/** Ceiling on decompressed share-link payloads — a decompression bomb defence. */
const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
/** Recursion ceiling for the sanitiser, so deeply nested junk cannot blow the stack. */
const MAX_DEPTH = 64;
/** Longest name/id we keep. Beyond this the value is data smuggling, not a name. */
const MAX_STRING = 4096;
/** Rectangles in one zone. An L needs 2; a comb of 64 is not a light switch. */
const MAX_ZONE_RECTS = 64;
/** Sanity ceiling on collection sizes, so a hostile file cannot allocate forever. */
const MAX_ARRAY = 200_000;

/** Ceiling on a single panel's cell count — see the check in `migrate`. */
const MAX_PANEL_CELLS = 20_000;

/**
 * Bounds on the printed counts. Lines: a wall of a few hundred distinct parts is
 * already extraordinary. Per line: 100k of one part is not a build, it is a file
 * trying to make a number field render forever.
 */
const MAX_PRINTED_KEYS = 5_000;

/** Hand edits to the fixing plan. A wall of a few hundred fixings is a big one. */
const MAX_FIXING_EDITS = 5_000;

const MAX_PRINTED_COUNT = 100_000;

/** Coloured lines or items. Past this the file is not a layout any more. */
const MAX_COLOR_KEYS = 20_000;

/** Keys that must never reach an object we build. Prototype pollution vector. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const DEFAULT_WALL: WallSpec = { widthMm: 2400, heightMm: 1200 };
const DEFAULT_BED = BEDS[0]?.id ?? 'bed220';

// ---------------------------------------------------------------------------
// serialize — stable, pretty, diff-friendly
// ---------------------------------------------------------------------------

/**
 * The printed counts as a canonical `{printed: …}` fragment, or nothing at all.
 *
 * Only whole positive counts survive: a zero is the absence of progress and has
 * no business taking up a line in the file, and the reader would drop it again
 * on the way back in — which would make a saved document differ from its reload.
 */
function canonicalPrinted(counts: LayoutDoc['printed']): Record<string, unknown> {
  if (!counts) return {};
  const out: Record<string, number> = {};
  for (const key of Object.keys(counts).sort()) {
    const value = counts[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const whole = Math.floor(value);
    if (whole > 0) out[key] = whole;
  }
  return Object.keys(out).length > 0 ? { printed: out } : {};
}

/**
 * The wall's colours, canonically — or nothing at all when nothing is coloured.
 *
 * Every value goes through `normaliseColor` on the way OUT as well as on the way
 * in: the document is the thing that gets shared, and a colour that reached it
 * before this reader existed must not leave in a shape the reader would refuse.
 */
function canonicalColors(colors: LayoutDoc['colors']): Record<string, unknown> {
  const read = readColors(colors);
  if (!hasColors(read)) return {};
  const out: Record<string, unknown> = {};
  if (read.panels !== undefined) out['panels'] = read.panels;
  if (read.parts !== undefined) out['parts'] = read.parts;
  for (const field of ['lines', 'items'] as const) {
    const source = read[field];
    if (!source) continue;
    const sorted: Record<string, string> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = source[key]!;
    out[field] = sorted;
  }
  return { colors: out };
}

/**
 * The hand edits to the fixing plan, or nothing at all. An empty list is the
 * absence of an edit and must not be written: `{"fixingEdits":{}}` in a file is
 * a document that differs from its own reload.
 */
function canonicalFixingEdits(edits: LayoutDoc['fixingEdits']): Record<string, unknown> {
  if (!edits) return {};
  const cells = (list: Hex[] | undefined): Record<string, number>[] =>
    (list ?? []).map((c) => ({ q: c.q, r: c.r }));
  const out: Record<string, unknown> = {};
  const removed = cells(edits.removed);
  const added = cells(edits.added);
  if (removed.length > 0) out['removed'] = removed;
  if (added.length > 0) out['added'] = added;
  return Object.keys(out).length > 0 ? { fixingEdits: out } : {};
}

/**
 * Canonical form: keys always emitted in declaration order, never in whatever
 * order the object happened to be built. Two identical layouts therefore
 * produce byte-identical text, which is what makes "is this file dirty?" and
 * git diffs honest.
 */
function canonicalDoc(doc: LayoutDoc): Record<string, unknown> {
  return {
    schemaVersion: doc.schemaVersion,
    id: doc.id,
    name: doc.name,
    wall: { widthMm: doc.wall.widthMm, heightMm: doc.wall.heightMm },
    bedId: doc.bedId,
    // Only when there is one. A layout on a preset printer must round-trip to
    // the same bytes it always did.
    ...(doc.customBed
      ? { customBed: { widthMm: doc.customBed.widthMm, depthMm: doc.customBed.depthMm } }
      : {}),
    panels: doc.panels.map((p) => {
      const out: Record<string, unknown> = {
        id: p.id,
        partId: p.partId,
        origin: { q: p.origin.q, r: p.origin.r },
        columns: p.columns,
        rows: p.rows,
      };
      // Only when the panel really is cut: a stock plate must round-trip to the
      // same bytes it always did.
      if (p.omit && p.omit.length > 0) {
        out['omit'] = p.omit.map((c) => ({ q: c.q, r: c.r }));
      }
      return out;
    }),
    items: doc.items.map((it) => {
      const out: Record<string, unknown> = {
        id: it.id,
        partId: it.partId,
        at: { q: it.at.q, r: it.at.r },
        rotation: it.rotation,
      };
      // Only present when set — an explicit `undefined` would round-trip to a
      // key that was never there.
      if (it.groupId !== undefined) out['groupId'] = it.groupId;
      return out;
    }),
    groups: doc.groups.map((g) => {
      const out: Record<string, unknown> = { id: g.id };
      if (g.label !== undefined) out['label'] = g.label;
      return out;
    }),
    // Same rule as `obstacles`: only when set, so a layout saved before frames
    // existed round-trips to the bytes it always had.
    ...(doc.frame
      ? {
          frame: {
            left: doc.frame.left,
            right: doc.frame.right,
            bottom: doc.frame.bottom,
            top: doc.frame.top,
            holes: doc.frame.holes,
            thicknessMm: doc.frame.thicknessMm,
          },
        }
      : {}),
    // The parts shopped for this wall. Same rule again: only when there are
    // any, so a layout saved before the library existed round-trips unchanged.
    ...(doc.library && doc.library.length > 0 ? { library: [...doc.library] } : {}),
    // The colours things get printed in. Keys SORTED, for the same reason the
    // printed counts are: the canonical form is a function of the content, not
    // of the order somebody happened to click the swatches in.
    ...canonicalColors(doc.colors),
    // Wall fixings a person moved or took out. Order is kept as edited — these
    // are a log of decisions, not a set, and re-sorting them would churn the
    // file for no reason. Same absent-key rule as everything above.
    ...canonicalFixingEdits(doc.fixingEdits),
    // How far through the printing you are. Keys SORTED, because the canonical
    // form has to be a function of the content and not of the order the counts
    // happened to be typed in — otherwise "is this file dirty?" answers yes for
    // two identical builds. Same absent-key rule as everything above.
    ...canonicalPrinted(doc.printed),
    ...(doc.obstacles && doc.obstacles.length > 0
      ? {
          obstacles: doc.obstacles.map((o) => {
            const out: Record<string, unknown> = {
              id: o.id,
              label: o.label,
              xMm: o.xMm,
              yMm: o.yMm,
              widthMm: o.widthMm,
              heightMm: o.heightMm,
              clearanceMm: o.clearanceMm,
            };
            // Same absent-key rule as everywhere else: a plain rectangular zone
            // must serialise to the bytes it always did.
            if (o.shape && o.shape.length > 0) {
              out['shape'] = o.shape.map((r) => ({
                xMm: r.xMm, yMm: r.yMm, widthMm: r.widthMm, heightMm: r.heightMm,
              }));
            }
            return out;
          }),
        }
      : {}),
    // The wall photograph — its ALIGNMENT, not its pixels. Same absent-key rule
    // as everything above. The image itself is in IndexedDB under `photo.id`,
    // for the reason given on `WallPhoto`: this file has to stay small enough to
    // paste into a message, and a photograph is not.
    ...(doc.photo
      ? {
          photo: {
            id: doc.photo.id,
            name: doc.photo.name,
            pixelWidth: doc.photo.pixelWidth,
            pixelHeight: doc.photo.pixelHeight,
            mmPerPixel: doc.photo.mmPerPixel,
            calibrated: doc.photo.calibrated,
            xMm: doc.photo.xMm,
            yMm: doc.photo.yMm,
            opacity: doc.photo.opacity,
            depth: doc.photo.depth,
            visible: doc.photo.visible,
          },
        }
      : {}),
  };
}

/** Pretty, stable JSON with a trailing newline — a well-behaved text file. */
export function serialize(doc: LayoutDoc): string {
  return JSON.stringify(canonicalDoc(doc), null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// deserialize
// ---------------------------------------------------------------------------

/** Strips pollution keys during parsing: returning undefined deletes the key. */
function safeReviver(key: string, value: unknown): unknown {
  return DANGEROUS_KEYS.has(key) ? undefined : value;
}

/**
 * A `{key: value}` map out of a stored document, bounded and shallow.
 *
 * The values are not checked here — `readColors` refuses anything that is not a
 * colour — but the SIZE is, before that runs: a map of a million keys is not a
 * layout, and validating it one entry at a time is exactly what a hostile file
 * would want.
 */
function boundedMap(
  value: unknown,
  path: string,
  errors: string[],
): Record<string, string> | undefined {
  if (!isPlainObject(value)) {
    if (value !== undefined) errors.push(`${path} is ${describe(value)}; dropped.`);
    return undefined;
  }
  const out: Record<string, string> = {};
  let kept = 0;
  for (const [key, v] of Object.entries(value)) {
    if (kept >= MAX_COLOR_KEYS) {
      errors.push(`${path} has more than ${MAX_COLOR_KEYS} entries; the rest were dropped.`);
      break;
    }
    if (key.length === 0 || key.length > MAX_STRING) continue;
    if (typeof v !== 'string') continue;
    out[key] = v;
    kept += 1;
  }
  return out;
}

function errorText(e: unknown): string {
  if (e instanceof Error && typeof e.message === 'string') return e.message;
  return String(e);
}

/**
 * Parse text into a document. Never throws, for any input whatsoever.
 */
export function deserialize(text: string): LoadResult {
  if (typeof text !== 'string') {
    return { doc: null, errors: [`Expected text to read, but got ${describe(text)}.`] };
  }
  if (text.length === 0) {
    return { doc: null, errors: ['The file is empty — there is nothing to load.'] };
  }
  if (text.trim().length === 0) {
    return { doc: null, errors: ['The file contains only whitespace — there is nothing to load.'] };
  }
  if (text.length > MAX_TEXT_CHARS) {
    return {
      doc: null,
      errors: [
        `The file is ${Math.round(text.length / (1024 * 1024))} MB, which is far larger than any ` +
          `layout (the limit is ${MAX_TEXT_CHARS / (1024 * 1024)} MB). Refusing to parse it.`,
      ],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text, safeReviver);
  } catch (e) {
    return { doc: null, errors: [`This is not valid JSON: ${errorText(e)}`] };
  }
  return migrate(raw);
}

// ---------------------------------------------------------------------------
// Sanitising — turn arbitrary input into inert plain data
// ---------------------------------------------------------------------------

/**
 * Deep-copy `value` into plain objects/arrays/primitives, dropping dangerous
 * keys, cycles, functions and anything past `MAX_DEPTH`.
 *
 * `JSON.parse` already handles most of this, but `migrate` is public and may be
 * handed a live object (from `structuredClone`, an old localStorage shim, a
 * test), so the guarantee has to live here rather than in the reviver.
 */
function sanitize(value: unknown, seen: WeakSet<object>, depth: number, report: string[]): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    if (s.length <= MAX_STRING) return s;
    // Silence here is the one failure mode this module exists to prevent.
    report.push(
      `A text value of ${s.length} characters was shortened to ${MAX_STRING}.`,
    );
    return s.slice(0, MAX_STRING);
  }
  if (t === 'number' || t === 'boolean') return value;
  if (t !== 'object') return undefined; // function, symbol, bigint, undefined
  if (depth >= MAX_DEPTH) return undefined;

  const obj = value as object;
  if (seen.has(obj)) return undefined; // cycle
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const n = Math.min(obj.length, MAX_ARRAY);
      if (obj.length > n) {
        report.push(
          `A list of ${obj.length} entries was cut to the ${MAX_ARRAY} entry limit; ` +
            `${obj.length - n} were dropped.`,
        );
      }
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) out.push(sanitize(obj[i], seen, depth + 1, report));
      return out;
    }
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.keys(obj)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      if (++count > MAX_ARRAY) break;
      const child = sanitize((obj as Record<string, unknown>)[key], seen, depth + 1, report);
      if (child !== undefined) out[key] = child;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `a list of ${value.length} entries`;
  const t = typeof value;
  if (t === 'string') return `text (${JSON.stringify((value as string).slice(0, 24))})`;
  if (t === 'number') return `the number ${String(value)}`;
  if (t === 'boolean') return `the value ${String(value)}`;
  if (t === 'undefined') return 'nothing';
  return `a ${t}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Field readers. Each one reports its own problem and returns null on failure,
// so the caller decides between "drop the record" and "use a default".
// ---------------------------------------------------------------------------

function readString(v: unknown, path: string, errors: string[]): string | null {
  if (typeof v === 'string') return v;
  if (v === undefined) {
    errors.push(`${path} is missing.`);
    return null;
  }
  errors.push(`${path} should be text but is ${describe(v)}.`);
  return null;
}

function readCoord(v: unknown, path: string, errors: string[]): number | null {
  if (typeof v !== 'number') {
    errors.push(`${path} should be a whole number but is ${describe(v)}.`);
    return null;
  }
  if (!Number.isFinite(v)) {
    errors.push(`${path} is ${String(v)}, which is not a position.`);
    return null;
  }
  if (!Number.isInteger(v)) {
    errors.push(`${path} is ${String(v)}; hex coordinates must be whole numbers.`);
    return null;
  }
  if (Math.abs(v) > 1e7) {
    errors.push(`${path} is ${String(v)}, which is far outside any real wall.`);
    return null;
  }
  return v;
}

/**
 * A millimetre measurement on the wall: finite, and inside the same envelope
 * `readCoord` allows for cells. An obstacle 1e9 mm wide would blank the wall.
 */
function readCoordMm(v: unknown, path: string, errors: string[]): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.push(`${path} should be a number of millimetres but is ${describe(v)}.`);
    return null;
  }
  if (Math.abs(v) > 100000) {
    errors.push(`${path} is ${String(v)} mm, which is far outside any real wall.`);
    return null;
  }
  return Math.round(v * 10) / 10;
}

function readHex(v: unknown, path: string, errors: string[]): Hex | null {
  if (!isPlainObject(v)) {
    errors.push(`${path} should be a {q, r} coordinate but is ${describe(v)}.`);
    return null;
  }
  const q = readCoord(v['q'], `${path}.q`, errors);
  const r = readCoord(v['r'], `${path}.r`, errors);
  if (q === null || r === null) return null;
  return { q, r };
}

function readPositiveInt(v: unknown, path: string, errors: string[]): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.push(`${path} should be a whole number but is ${describe(v)}.`);
    return null;
  }
  if (!Number.isInteger(v) || v <= 0) {
    errors.push(`${path} is ${String(v)}; it must be a whole number of at least 1.`);
    return null;
  }
  if (v > 10000) {
    errors.push(`${path} is ${String(v)}, which is impossibly large.`);
    return null;
  }
  return v;
}

function readSize(v: unknown, path: string, errors: string[]): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    errors.push(`${path} should be a positive measurement in mm but is ${describe(v)}.`);
    return null;
  }
  return v;
}

/** Rotation is normalised rather than rejected: 7 clearly means 1, and losing
 *  the item over it would be a worse answer than fixing it. */
function readRotation(v: unknown, path: string, errors: string[]): Rotation {
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)) {
    if (v >= 0 && v <= 5) return v as Rotation;
    const wrapped = (((v % 6) + 6) % 6) as Rotation;
    errors.push(`${path} is ${String(v)}; rotations are 0–5, so it was wrapped to ${wrapped}.`);
    return wrapped;
  }
  errors.push(`${path} should be a rotation of 0–5 but is ${describe(v)}; using 0.`);
  return 0;
}

function readArray(v: unknown, path: string, errors: string[]): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined) {
    errors.push(`${path} is missing; treating it as empty.`);
    return [];
  }
  errors.push(`${path} should be a list but is ${describe(v)}; ignoring it and keeping the rest.`);
  return [];
}

/** Guarantees the returned document has no duplicate ids, whatever came in. */
function uniqueId(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  for (let n = 2; ; n++) {
    const next = `${candidate}-${n}`;
    if (!used.has(next)) {
      used.add(next);
      return next;
    }
  }
}

// ---------------------------------------------------------------------------
// migrate — the only path from unknown data to a LayoutDoc
// ---------------------------------------------------------------------------

/**
 * Validate, repair and upgrade arbitrary data into a `LayoutDoc`.
 * Returns `{doc: null}` only when the input is not a document at all.
 */
export function migrate(raw: unknown): LoadResult {
  const errors: string[] = [];

  let value: unknown;
  try {
    // Truncation notes go straight into `errors`. Sanitising used to cap array
    // and string lengths with no way to say so, which meant a 210,000-item file
    // came back with 10,000 items silently missing and `errors: []` — exactly
    // the "silently discard my layout" failure this module exists to prevent.
    value = sanitize(raw, new WeakSet(), 0, errors);
  } catch (e) {
    return { doc: null, errors: [`This data could not be read: ${errorText(e)}`] };
  }

  if (!isPlainObject(value)) {
    return { doc: null, errors: [`Expected a layout object, but found ${describe(value)}.`] };
  }

  // --- schema version -----------------------------------------------------
  const rawVersion = value['schemaVersion'];
  let version = CURRENT_SCHEMA;
  if (typeof rawVersion === 'number' && Number.isFinite(rawVersion)) {
    version = Math.trunc(rawVersion);
  } else if (rawVersion !== undefined) {
    errors.push(`schemaVersion should be a number but is ${describe(rawVersion)}; assuming ${CURRENT_SCHEMA}.`);
  } else {
    errors.push(`schemaVersion is missing; assuming ${CURRENT_SCHEMA}.`);
  }
  if (version > CURRENT_SCHEMA) {
    errors.push(
      `This layout was saved by a newer version of the planner (schema ${version}; this build ` +
        `understands ${CURRENT_SCHEMA}). Reading what is recognisable — anything newer is dropped.`,
    );
  } else if (version < CURRENT_SCHEMA) {
    errors.push(`Upgraded this layout from schema ${version} to ${CURRENT_SCHEMA}.`);
  }

  // --- scalars ------------------------------------------------------------
  let id = readString(value['id'], 'id', errors);
  if (id === null || id === '') {
    if (id === '') errors.push('id is empty; using "layout".');
    id = 'layout';
  }

  let name = readString(value['name'], 'name', errors);
  if (name === null) name = 'Untitled layout';

  let bedId = readString(value['bedId'], 'bedId', errors);
  if (bedId === null || bedId === '') {
    if (bedId === '') errors.push('bedId is empty.');
    errors.push(`Defaulted the printer bed to "${DEFAULT_BED}".`);
    bedId = DEFAULT_BED;
  }

  /*
   * The typed build plate.
   *
   * Read field by field and CLAMPED rather than rejected: a stored document is
   * user input by the time it comes back, and a bed of 1e9 mm would have the
   * solver offering half a million plate sizes. A `custom` bed with no size at
   * all cannot be honoured, so it falls back to a real printer and says so —
   * `bedFor` would otherwise return undefined and the wall would come back with
   * "unknown bed" and no panels.
   */
  let customBed: { widthMm: number; depthMm: number } | undefined;
  const rawBed = value['customBed'];
  if (rawBed !== undefined && rawBed !== null) {
    if (isPlainObject(rawBed)) {
      const w = readSize(rawBed['widthMm'], 'customBed.widthMm', errors);
      const d = readSize(rawBed['depthMm'], 'customBed.depthMm', errors);
      if (w !== null && d !== null) {
        customBed = { widthMm: clampBedMm(w), depthMm: clampBedMm(d) };
        if (customBed.widthMm !== w || customBed.depthMm !== d) {
          errors.push(
            `customBed ${w} × ${d} mm is outside ${MIN_BED_MM}–${MAX_BED_MM}; ` +
              `brought to ${customBed.widthMm} × ${customBed.depthMm}.`,
          );
        }
      }
    } else {
      errors.push(`customBed should be a {widthMm, depthMm} object but is ${describe(rawBed)}; ignored.`);
    }
  }
  if (bedId === CUSTOM_BED_ID && customBed === undefined) {
    errors.push(`bedId is "${CUSTOM_BED_ID}" with no customBed size; defaulted the printer to "${DEFAULT_BED}".`);
    bedId = DEFAULT_BED;
  }

  // --- wall ---------------------------------------------------------------
  let wall: WallSpec;
  const rawWall = value['wall'];
  if (isPlainObject(rawWall)) {
    const w = readSize(rawWall['widthMm'], 'wall.widthMm', errors);
    const h = readSize(rawWall['heightMm'], 'wall.heightMm', errors);
    wall = {
      widthMm: w ?? DEFAULT_WALL.widthMm,
      heightMm: h ?? DEFAULT_WALL.heightMm,
    };
    if (w === null || h === null) {
      errors.push(`Defaulted the missing wall dimensions to ${DEFAULT_WALL.widthMm} × ${DEFAULT_WALL.heightMm} mm.`);
    }
  } else {
    errors.push(
      `wall should be a {widthMm, heightMm} object but is ${describe(rawWall)}; ` +
        `defaulted to ${DEFAULT_WALL.widthMm} × ${DEFAULT_WALL.heightMm} mm.`,
    );
    wall = { ...DEFAULT_WALL };
  }

  const usedIds = new Set<string>();

  // --- panels -------------------------------------------------------------
  const panels: PlacedPanel[] = [];
  const rawPanels = readArray(value['panels'], 'panels', errors);
  for (let i = 0; i < rawPanels.length; i++) {
    const p = rawPanels[i];
    const where = `panels[${i}]`;
    if (!isPlainObject(p)) {
      errors.push(`${where} is ${describe(p)}, not a panel; dropped.`);
      continue;
    }
    const local: string[] = [];
    const partId = readString(p['partId'], `${where}.partId`, local);
    const origin = readHex(p['origin'], `${where}.origin`, local);
    const columns = readPositiveInt(p['columns'], `${where}.columns`, local);
    const rows = readPositiveInt(p['rows'], `${where}.rows`, local);
    if (partId === null || partId === '' || origin === null || columns === null || rows === null) {
      errors.push(...local);
      errors.push(`${where} was dropped because it is not a usable panel.`);
      continue;
    }
    // Bounding each factor is not enough: 10000 x 10000 passes both checks and
    // is 100 million cells. `panelCells` costs ~70 ms per million and is called
    // several times per render, so a single pasted share link could freeze or
    // OOM the tab. The largest real panel is 288 cells; 20000 leaves enormous
    // headroom while keeping the workload bounded.
    if (columns * rows > MAX_PANEL_CELLS) {
      errors.push(...local);
      errors.push(
        `${where} claims ${columns} × ${rows} = ${columns * rows} cells, far beyond the ` +
          `${MAX_PANEL_CELLS} cell limit; dropped.`,
      );
      continue;
    }
    errors.push(...local);
    let pid = typeof p['id'] === 'string' ? (p['id'] as string) : '';
    if (pid === '') {
      errors.push(`${where}.id is missing or empty; named it "panel-${i}".`);
      pid = `panel-${i}`;
    }
    const finalId = uniqueId(pid, usedIds);
    if (finalId !== pid) errors.push(`${where}.id "${pid}" is used twice; renamed this one to "${finalId}".`);
    const panel: PlacedPanel = { id: finalId, partId, origin, columns, rows };
    // Cut-outs for a light switch or a socket. A cell that is not a legal
    // coordinate is dropped rather than taking the whole panel with it: the
    // worst case is a plate with one hole too few, which is visible, against a
    // plate that vanished, which is not.
    const rawOmit = p['omit'];
    if (Array.isArray(rawOmit)) {
      const omit: Hex[] = [];
      for (let k = 0; k < rawOmit.length; k++) {
        const cell = readHex(rawOmit[k], `${where}.omit[${k}]`, errors);
        if (cell !== null) omit.push(cell);
      }
      if (omit.length > 0) panel.omit = omit;
    }
    panels.push(panel);
  }

  // --- items --------------------------------------------------------------
  const items: PlacedItem[] = [];
  const rawItems = readArray(value['items'], 'items', errors);
  for (let i = 0; i < rawItems.length; i++) {
    const raw2 = rawItems[i];
    const where = `items[${i}]`;
    if (!isPlainObject(raw2)) {
      errors.push(`${where} is ${describe(raw2)}, not a placed part; dropped.`);
      continue;
    }
    const local: string[] = [];
    const partId = readString(raw2['partId'], `${where}.partId`, local);
    const at = readHex(raw2['at'], `${where}.at`, local);
    if (partId === null || partId === '' || at === null) {
      errors.push(...local);
      errors.push(`${where} was dropped: without a part id and a position it cannot be placed.`);
      continue;
    }
    errors.push(...local);
    const rotation = readRotation(raw2['rotation'], `${where}.rotation`, errors);
    let iid = typeof raw2['id'] === 'string' ? (raw2['id'] as string) : '';
    if (iid === '') {
      errors.push(`${where}.id is missing or empty; named it "item-${i}".`);
      iid = `item-${i}`;
    }
    const finalId = uniqueId(iid, usedIds);
    if (finalId !== iid) errors.push(`${where}.id "${iid}" is used twice; renamed this one to "${finalId}".`);

    const item: PlacedItem = { id: finalId, partId, at, rotation };
    const groupId = raw2['groupId'];
    if (typeof groupId === 'string' && groupId !== '') item.groupId = groupId;
    else if (groupId !== undefined) errors.push(`${where}.groupId is ${describe(groupId)}; the part was kept, ungrouped.`);
    items.push(item);
  }

  // --- groups -------------------------------------------------------------
  const groups: Group[] = [];
  const groupIds = new Set<string>();
  const rawGroups = readArray(value['groups'], 'groups', errors);
  for (let i = 0; i < rawGroups.length; i++) {
    const g = rawGroups[i];
    const where = `groups[${i}]`;
    if (!isPlainObject(g)) {
      errors.push(`${where} is ${describe(g)}, not a group; dropped.`);
      continue;
    }
    const gid = typeof g['id'] === 'string' ? (g['id'] as string) : '';
    if (gid === '') {
      errors.push(`${where}.id is missing or empty; the group was dropped (its parts are kept).`);
      continue;
    }
    if (groupIds.has(gid)) {
      errors.push(`${where}.id "${gid}" is a duplicate group; dropped.`);
      continue;
    }
    groupIds.add(gid);
    const group: Group = { id: gid };
    const label = g['label'];
    if (typeof label === 'string') group.label = label;
    else if (label !== undefined) errors.push(`${where}.label is ${describe(label)}; the label was dropped.`);
    groups.push(group);
  }

  // --- obstacles ----------------------------------------------------------
  const obstacles: Obstacle[] = [];
  if (value['obstacles'] !== undefined) {
    const rawObstacles = readArray(value['obstacles'], 'obstacles', errors);
    for (let i = 0; i < rawObstacles.length; i++) {
      const o = rawObstacles[i];
      const where = `obstacles[${i}]`;
      if (!isPlainObject(o)) {
        errors.push(`${where} is ${describe(o)}, not an obstacle; dropped.`);
        continue;
      }
      const local: string[] = [];
      const x = readCoordMm(o['xMm'], `${where}.xMm`, local);
      const y = readCoordMm(o['yMm'], `${where}.yMm`, local);
      const w = readCoordMm(o['widthMm'], `${where}.widthMm`, local);
      const h = readCoordMm(o['heightMm'], `${where}.heightMm`, local);
      if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) {
        errors.push(...local);
        errors.push(`${where} was dropped because it is not a usable obstacle.`);
        continue;
      }
      errors.push(...local);
      const clearance = readCoordMm(o['clearanceMm'], `${where}.clearanceMm`, []) ?? 0;
      /*
       * A zone made of several rectangles. Read part by part, and a part that
       * does not parse is DROPPED rather than taking the zone with it: the
       * worst case is a zone missing one of its arms, which is visible on the
       * plan, against a zone that vanished, which is not.
       */
      const shape: ZoneRect[] = [];
      if (Array.isArray(o['shape'])) {
        const raw = o['shape'] as unknown[];
        for (let k = 0; k < raw.length && shape.length < MAX_ZONE_RECTS; k++) {
          const part = raw[k];
          if (!isPlainObject(part)) {
            errors.push(`${where}.shape[${k}] is ${describe(part)}, not a rectangle; dropped.`);
            continue;
          }
          const local: string[] = [];
          const px = readCoordMm(part['xMm'], `${where}.shape[${k}].xMm`, local);
          const py = readCoordMm(part['yMm'], `${where}.shape[${k}].yMm`, local);
          const pw = readCoordMm(part['widthMm'], `${where}.shape[${k}].widthMm`, local);
          const ph = readCoordMm(part['heightMm'], `${where}.shape[${k}].heightMm`, local);
          if (px === null || py === null || pw === null || ph === null || pw <= 0 || ph <= 0) {
            errors.push(...local);
            errors.push(`${where}.shape[${k}] was dropped because it is not a usable rectangle.`);
            continue;
          }
          shape.push({ xMm: px, yMm: py, widthMm: pw, heightMm: ph });
        }
      }
      obstacles.push({
        id: typeof o['id'] === 'string' && o['id'] !== '' ? (o['id'] as string) : `obstacle-${i}`,
        label: typeof o['label'] === 'string' ? (o['label'] as string) : 'Obstacle',
        xMm: x,
        yMm: y,
        widthMm: w,
        heightMm: h,
        clearanceMm: Math.max(0, clearance),
        ...(shape.length > 0 ? { shape } : {}),
      });
    }
  }

  // --- frame ----------------------------------------------------------------
  // Read field by field, like everything else out of a stored document: a field
  // nobody reads back is a setting that applies for one session and vanishes on
  // reload, which is exactly how the chosen fastener was lost (D44).
  let frame: WallFrame | undefined;
  const rawFrame = value['frame'];
  if (rawFrame !== undefined) {
    if (!isPlainObject(rawFrame)) {
      errors.push(`frame is ${describe(rawFrame)}, not a frame; dropped.`);
    } else {
      const side = (k: keyof WallFrame): boolean => {
        const v = rawFrame[k];
        if (typeof v === 'boolean') return v;
        if (v !== undefined) errors.push(`frame.${k} is ${describe(v)}; treated as off.`);
        return false;
      };
      // The thickness is a MEASUREMENT out of a stored document, so it goes
      // through the same coordinate reader every other millimetre does — an
      // edge 1e9 mm thick would swallow the wall.
      const thickness = readCoordMm(rawFrame['thicknessMm'], 'frame.thicknessMm', errors);
      const read: WallFrame = {
        left: side('left'),
        right: side('right'),
        bottom: side('bottom'),
        top: side('top'),
        holes: side('holes'),
        thicknessMm:
          thickness !== null && thickness > 0 && thickness <= MAX_BORDER_MM
            ? thickness
            : DEFAULT_BORDER_MM,
      };
      // An edge on no side at all is no edge. Storing one would make an
      // untouched document differ from its own reload.
      if (read.left || read.right || read.bottom || read.top || read.holes) frame = read;
    }
  }

  // --- library --------------------------------------------------------------
  // The parts shopped for this wall. Read back field by field like everything
  // else out of a stored document, and NOT reconciled against a catalogue: a
  // layout naming an import you do not have is a fact about the layout, and
  // dropping the id here would rewrite the document on the way through. The
  // rail reports what it cannot resolve instead (see `resolveProjectParts`).
  const library: string[] = [];
  if (value['library'] !== undefined) {
    const rawLibrary = readArray(value['library'], 'library', errors);
    const seen = new Set<string>();
    for (let i = 0; i < rawLibrary.length; i++) {
      const id = readString(rawLibrary[i], `library[${i}]`, errors);
      if (id === null || id === '') continue;
      if (seen.has(id)) {
        errors.push(`library[${i}] "${id}" is listed twice; kept once.`);
        continue;
      }
      if (seen.size >= MAX_PROJECT_PARTS) {
        errors.push(
          `library lists more than ${MAX_PROJECT_PARTS} parts; the rest were dropped.`,
        );
        break;
      }
      seen.add(id);
      library.push(id);
    }
  }

  // --- colours ------------------------------------------------------------------
  // What things get printed in. `readColors` drops anything that is not a hex
  // colour, key by key — the values end up in a canvas `fillStyle` and a
  // `THREE.Color`, both of which accept arbitrary strings and do something
  // unhelpful with the ones they cannot parse.
  let colors: WallColors | undefined;
  const rawColors = value['colors'];
  if (rawColors !== undefined) {
    if (!isPlainObject(rawColors)) {
      errors.push(`colors is ${describe(rawColors)}, not a set of colours; dropped.`);
    } else {
      const bounded: WallColors = {
        panels: rawColors['panels'] as string | undefined,
        parts: rawColors['parts'] as string | undefined,
        lines: boundedMap(rawColors['lines'], 'colors.lines', errors),
        items: boundedMap(rawColors['items'], 'colors.items', errors),
      };
      const read = readColors(bounded);
      if (hasColors(read)) colors = read;
    }
  }

  // --- fixing edits -----------------------------------------------------------
  // Where a person overruled the wall-fixing plan. Cell by cell through the same
  // reader every other coordinate uses, and NOT reconciled against the plan: a
  // removal for a cell the planner no longer chooses is a decision about this
  // wall, and re-solving may well bring that cell back.
  let fixingEdits: FixingEdits | undefined;
  const rawEdits = value['fixingEdits'];
  if (rawEdits !== undefined) {
    if (!isPlainObject(rawEdits)) {
      errors.push(`fixingEdits is ${describe(rawEdits)}, not a set of edits; dropped.`);
    } else {
      const readCells = (field: 'removed' | 'added'): Hex[] => {
        const out: Hex[] = [];
        const raw = rawEdits[field];
        if (raw === undefined) return out;
        const list = readArray(raw, `fixingEdits.${field}`, errors);
        const seen = new Set<string>();
        for (let i = 0; i < list.length && out.length < MAX_FIXING_EDITS; i++) {
          const cell = readHex(list[i], `fixingEdits.${field}[${i}]`, errors);
          if (cell === null) continue;
          const key = `${cell.q},${cell.r}`;
          // Twice is once: the plan reads these as a set, so a duplicate would
          // survive a round trip while changing nothing.
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(cell);
        }
        if (list.length > MAX_FIXING_EDITS) {
          errors.push(
            `fixingEdits.${field} lists more than ${MAX_FIXING_EDITS} cells; the rest were dropped.`,
          );
        }
        return out;
      };
      const removed = readCells('removed');
      const added = readCells('added');
      if (removed.length > 0 || added.length > 0) {
        fixingEdits = {
          ...(removed.length > 0 ? { removed } : {}),
          ...(added.length > 0 ? { added } : {}),
        };
      }
    }
  }

  // --- printed counts ---------------------------------------------------------
  // How many of each line have come off the printer. Read key by key like
  // everything else out of a stored document, and NOT reconciled against the
  // parts list: a count for a part this layout no longer uses is a fact about
  // what has been printed, and `bom.ts` caps it when it builds the line. Zero
  // and rubbish are dropped rather than kept as noise, which is also what keeps
  // a saved file identical to its own reload.
  const printedCounts: Record<string, number> = {};
  const rawPrinted = value['printed'];
  if (rawPrinted !== undefined) {
    if (!isPlainObject(rawPrinted)) {
      errors.push(`printed is ${describe(rawPrinted)}, not a set of counts; dropped.`);
    } else {
      let kept = 0;
      for (const key of Object.keys(rawPrinted)) {
        if (key.length === 0 || key.length > MAX_STRING) {
          errors.push(`printed has a key that is not a part id; dropped.`);
          continue;
        }
        if (kept >= MAX_PRINTED_KEYS) {
          errors.push(
            `printed lists more than ${MAX_PRINTED_KEYS} parts; the rest were dropped.`,
          );
          break;
        }
        const raw = rawPrinted[key];
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          errors.push(`printed["${key}"] is ${describe(raw)}, not a count; dropped.`);
          continue;
        }
        const count = Math.floor(raw);
        if (count <= 0) continue;
        if (count > MAX_PRINTED_COUNT) {
          errors.push(
            `printed["${key}"] is ${String(raw)}, which is more than anyone has printed; ` +
              `kept at ${MAX_PRINTED_COUNT}.`,
          );
        }
        printedCounts[key] = Math.min(count, MAX_PRINTED_COUNT);
        kept += 1;
      }
    }
  }

  // --- photo -----------------------------------------------------------------
  // The wall photograph's alignment. Field by field like the frame above, and
  // for the same reason: a field nobody reads back is a setting that survives
  // one session. Nothing here is reconciled against storage — whether the image
  // bytes are on THIS machine is not a fact about the layout, and the panel
  // reports the absence rather than the loader quietly deleting the alignment.
  let photo: WallPhoto | undefined;
  const rawPhoto = value['photo'];
  if (rawPhoto !== undefined) {
    if (!isPlainObject(rawPhoto)) {
      errors.push(`photo is ${describe(rawPhoto)}, not a photo; dropped.`);
    } else {
      const photoId = readString(rawPhoto['id'], 'photo.id', errors);
      const pixelWidth = readPositiveInt(rawPhoto['pixelWidth'], 'photo.pixelWidth', errors);
      const pixelHeight = readPositiveInt(rawPhoto['pixelHeight'], 'photo.pixelHeight', errors);
      const xMm = readCoordMm(rawPhoto['xMm'], 'photo.xMm', errors);
      const yMm = readCoordMm(rawPhoto['yMm'], 'photo.yMm', errors);
      const rawScale = rawPhoto['mmPerPixel'];
      // NOT through `readCoordMm`: that rounds to a tenth of a millimetre, which
      // is right for a position on the wall and ruinous for a scale — a photo at
      // 0.5859 mm per pixel would come back at 0.6, a 2.4 % error, so a 2 m wall
      // would be drawn 49 mm wide of itself.
      const scale =
        typeof rawScale === 'number' && Number.isFinite(rawScale) && rawScale > 0
          ? rawScale
          : null;
      if (scale === null) {
        errors.push(`photo.mmPerPixel is ${describe(rawScale)}; the photo was dropped.`);
      }
      if (photoId !== null && photoId !== '' && pixelWidth !== null && pixelHeight !== null &&
          scale !== null && xMm !== null && yMm !== null) {
        const rawOpacity = rawPhoto['opacity'];
        photo = {
          id: photoId,
          name: readString(rawPhoto['name'], 'photo.name', errors) ?? photoId,
          pixelWidth,
          pixelHeight,
          mmPerPixel: clampMmPerPixel(scale, pixelWidth, pixelHeight),
          calibrated: rawPhoto['calibrated'] === true,
          xMm,
          yMm,
          opacity: clampPhotoOpacity(
            typeof rawOpacity === 'number' ? rawOpacity : DEFAULT_PHOTO_OPACITY,
          ),
          depth: rawPhoto['depth'] === 'front' ? 'front' : 'behind',
          // Absent means shown: a photo that is in the document at all was put
          // there to be looked at, and a missing flag must not hide it.
          visible: rawPhoto['visible'] !== false,
        };
      } else {
        errors.push('photo was dropped because it is not a usable photo.');
      }
    }
  }

  const doc: LayoutDoc = {
    schemaVersion: CURRENT_SCHEMA,
    id,
    name,
    wall,
    bedId,
    ...(customBed ? { customBed } : {}),
    panels,
    items,
    groups,
    ...(library.length > 0 ? { library } : {}),
    ...(colors ? { colors } : {}),
    ...(fixingEdits ? { fixingEdits } : {}),
    ...(Object.keys(printedCounts).length > 0 ? { printed: printedCounts } : {}),
    // Only when there are any. An absent key must round-trip to an absent key,
    // or every layout saved before obstacles existed fails an equality check
    // against its own reload.
    ...(obstacles.length > 0 ? { obstacles } : {}),
    ...(frame ? { frame } : {}),
    ...(photo ? { photo } : {}),
  };
  return { doc, errors };
}

// ---------------------------------------------------------------------------
// UTF-8. TextEncoder/TextDecoder where available (browser + Node ≥ 11), with a
// hand-rolled fallback so this module needs neither Buffer nor the DOM.
// ---------------------------------------------------------------------------

function utf8Encode(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else cp = 0xfffd;
    } else if (cp >= 0xdc00 && cp <= 0xdfff) cp = 0xfffd;

    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
  }
  return Uint8Array.from(out);
}

function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  let out = '';
  let chunk: number[] = [];
  const push = (cp: number): void => {
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      chunk.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else chunk.push(cp);
    if (chunk.length > 4096) {
      out += String.fromCharCode(...chunk);
      chunk = [];
    }
  };
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i]!;
    let cp: number;
    let size: number;
    if (b0 < 0x80) {
      cp = b0;
      size = 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      cp = b0 & 0x1f;
      size = 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      cp = b0 & 0x0f;
      size = 3;
    } else if ((b0 & 0xf8) === 0xf0) {
      cp = b0 & 0x07;
      size = 4;
    } else {
      push(0xfffd);
      i++;
      continue;
    }
    if (i + size > bytes.length) {
      push(0xfffd);
      i++;
      continue;
    }
    let ok = true;
    for (let k = 1; k < size; k++) {
      const bk = bytes[i + k]!;
      if ((bk & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (bk & 0x3f);
    }
    if (!ok || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      push(0xfffd);
      i++;
      continue;
    }
    push(cp);
    i += size;
  }
  if (chunk.length) out += String.fromCharCode(...chunk);
  return out;
}

// ---------------------------------------------------------------------------
// base64url, hand-rolled so neither btoa nor Buffer is assumed
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const B64_INV: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t['+'.charCodeAt(0)] = 62; // accept standard base64 too
  t['/'.charCodeAt(0)] = 63;
  return t;
})();

function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
  } else if (left === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]!;
  }
  return out;
}

/** @returns the decoded bytes, or null if the text is not base64url at all. */
function base64urlDecode(text: string): Uint8Array | null {
  const sixes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 61) continue; // '=' padding
    if (c === 32 || c === 10 || c === 13 || c === 9) continue; // stray whitespace
    if (c >= 128) return null;
    const v = B64_INV[c]!;
    if (v < 0) return null;
    sixes.push(v);
  }
  if (sixes.length % 4 === 1) return null; // impossible base64 length
  const out = new Uint8Array(Math.floor((sixes.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < sixes.length; i++) {
    acc = (acc << 6) | sixes[i]!;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// LZSS. A share link is a URL someone pastes into a chat window, so the JSON
// gets squeezed first. Layout JSON is extremely repetitive ("partId":"hook-…"
// two hundred times) so a 4 kB window with 3–18 byte matches typically takes
// 70–80% off. No dependency; both halves live here and are round-trip tested.
// ---------------------------------------------------------------------------

const WINDOW = 4096;
const MIN_MATCH = 3;
const MAX_MATCH = 18;

function lzssCompress(src: Uint8Array): Uint8Array {
  const n = src.length;
  let out = new Uint8Array(Math.max(64, n + (n >> 3) + 16));
  let o = 0;
  const push = (b: number): void => {
    if (o >= out.length) {
      const bigger = new Uint8Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }
    out[o++] = b;
  };

  const head = new Int32Array(1 << 16).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const hashAt = (i: number): number =>
    ((src[i]! << 10) ^ (src[i + 1]! << 5) ^ src[i + 2]!) & 0xffff;

  let flagPos = -1;
  let flagBit = 8;
  let i = 0;
  while (i < n) {
    if (flagBit === 8) {
      flagPos = o;
      push(0);
      flagBit = 0;
    }
    let bestLen = 0;
    let bestDist = 0;
    if (i + MIN_MATCH <= n) {
      const h = hashAt(i);
      let cand = head[h]!;
      let tries = 0;
      const limit = Math.min(MAX_MATCH, n - i);
      while (cand >= 0 && tries < 64) {
        const dist = i - cand;
        if (dist > WINDOW) break;
        let len = 0;
        while (len < limit && src[cand + len] === src[i + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = dist;
          if (len === limit) break;
        }
        cand = prev[cand]!;
        tries++;
      }
    }
    if (bestLen >= MIN_MATCH) {
      out[flagPos] = out[flagPos]! | (1 << flagBit);
      const d = bestDist - 1;
      const l = bestLen - MIN_MATCH;
      push((d >> 4) & 0xff);
      push(((d & 0x0f) << 4) | l);
      for (let k = 0; k < bestLen; k++) {
        if (i + k + MIN_MATCH <= n) {
          const h = hashAt(i + k);
          prev[i + k] = head[h]!;
          head[h] = i + k;
        }
      }
      i += bestLen;
    } else {
      push(src[i]!);
      if (i + MIN_MATCH <= n) {
        const h = hashAt(i);
        prev[i] = head[h]!;
        head[h] = i;
      }
      i++;
    }
    flagBit++;
  }
  return out.slice(0, o);
}

/** @returns the original bytes, or null if the stream is corrupt. */
function lzssDecompress(src: Uint8Array): Uint8Array | null {
  let out = new Uint8Array(Math.max(64, src.length * 3));
  let o = 0;
  const ensure = (extra: number): boolean => {
    if (o + extra <= out.length) return true;
    let size = out.length;
    while (size < o + extra) size *= 2;
    if (size > MAX_DECOMPRESSED_BYTES) return false;
    const bigger = new Uint8Array(size);
    bigger.set(out.subarray(0, o));
    out = bigger;
    return true;
  };

  let i = 0;
  while (i < src.length) {
    const flags = src[i++]!;
    for (let bit = 0; bit < 8 && i < src.length; bit++) {
      if ((flags >> bit) & 1) {
        if (i + 1 >= src.length) return null; // truncated match token
        const b0 = src[i++]!;
        const b1 = src[i++]!;
        const dist = ((b0 << 4) | (b1 >> 4)) + 1;
        const len = (b1 & 0x0f) + MIN_MATCH;
        if (dist > o) return null; // points before the start of the stream
        if (!ensure(len)) return null;
        let from = o - dist;
        for (let k = 0; k < len; k++) out[o++] = out[from++]!;
      } else {
        if (!ensure(1)) return null;
        out[o++] = src[i++]!;
      }
    }
  }
  return out.slice(0, o);
}

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

/** Payload scheme byte, so the format can change without breaking old links. */
const SCHEME_RAW = 0x00;
const SCHEME_LZSS = 0x01;

const HASH_KEY = 'd';

/**
 * Pack a document into a link.
 *
 * The payload lives in the URL **hash**, which browsers never send to a server:
 * a shared layout stays between the two people who have the link. Compact JSON
 * → UTF-8 → LZSS → base64url, and if compression fails to help (tiny layouts)
 * the raw scheme is used instead — smaller of the two always wins.
 */
export function encodeShareUrl(doc: LayoutDoc, base: string): string {
  const json = JSON.stringify(canonicalDoc(doc));
  const bytes = utf8Encode(json);
  const packed = lzssCompress(bytes);

  const useLzss = packed.length < bytes.length;
  const body = useLzss ? packed : bytes;
  const payload = new Uint8Array(body.length + 1);
  payload[0] = useLzss ? SCHEME_LZSS : SCHEME_RAW;
  payload.set(body, 1);

  const stem = (() => {
    const hash = base.indexOf('#');
    return hash === -1 ? base : base.slice(0, hash);
  })();
  return `${stem}#${HASH_KEY}=${base64urlEncode(payload)}`;
}

/** Pull the payload out of a hash, tolerating `#d=…`, `#…` and `#a=1&d=…`. */
function payloadFromUrl(url: string): string | null {
  const at = url.indexOf('#');
  if (at === -1) return null;
  const hash = url.slice(at + 1);
  if (hash.length === 0) return null;
  for (const part of hash.split('&')) {
    if (part.startsWith(`${HASH_KEY}=`)) return part.slice(HASH_KEY.length + 1);
  }
  return hash.includes('=') ? null : hash;
}

/**
 * Read a document back out of a share link. Never throws: a mangled link is a
 * message to the user, not a crash.
 */
export function decodeShareUrl(url: string): LoadResult {
  if (typeof url !== 'string' || url.length === 0) {
    return { doc: null, errors: ['That is not a link.'] };
  }
  if (url.length > MAX_TEXT_CHARS) {
    return { doc: null, errors: ['That link is implausibly long; refusing to read it.'] };
  }
  const payload = payloadFromUrl(url);
  if (payload === null) {
    return {
      doc: null,
      errors: ['This link has no layout in it — a share link looks like "…#d=<code>".'],
    };
  }
  if (payload.length === 0) {
    return { doc: null, errors: ['This link carries an empty layout code.'] };
  }

  const bytes = base64urlDecode(payload);
  if (bytes === null || bytes.length === 0) {
    return {
      doc: null,
      errors: ['The layout code in this link is damaged — it is not valid base64url text.'],
    };
  }

  const scheme = bytes[0]!;
  let body: Uint8Array | null;
  if (scheme === SCHEME_RAW) body = bytes.subarray(1);
  else if (scheme === SCHEME_LZSS) body = lzssDecompress(bytes.subarray(1));
  else {
    return {
      doc: null,
      errors: [`This link uses layout format ${scheme}, which this build does not understand.`],
    };
  }
  if (body === null) {
    return {
      doc: null,
      errors: ['The layout code in this link is truncated or corrupt and could not be unpacked.'],
    };
  }

  let text: string;
  try {
    text = utf8Decode(body);
  } catch (e) {
    return { doc: null, errors: [`The layout code in this link is not readable text: ${errorText(e)}`] };
  }
  const result = deserialize(text);
  if (result.doc === null) {
    return {
      doc: null,
      errors: ['This link did not contain a readable layout.', ...result.errors],
    };
  }
  return result;
}
