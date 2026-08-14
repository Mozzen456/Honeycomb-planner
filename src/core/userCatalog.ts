/**
 * The parts the user imported, and how they join the generated catalogue.
 *
 * `src/catalog/catalog.json` is generated and read-only — the scanner owns it,
 * and hand-editing it is the one thing CLAUDE.md says never to do. So imported
 * parts live beside it instead: this module keeps them, validates them on the
 * way back in, and merges the two into a single `Catalog` that every other
 * module consumes without knowing the difference.
 *
 * Three storage decisions, each for a reason:
 *
 *   - metadata in localStorage, because it is small, synchronous, and wanted
 *     before the first render;
 *   - the STL bytes in IndexedDB, because they are megabytes and localStorage
 *     is not; losing them costs the 3D mesh and nothing else, so a browser that
 *     refuses IndexedDB still gets a working part;
 *   - the merged catalogue is memoised on identity, because `bom.ts` caches its
 *     part index in a WeakMap keyed on the Catalog object. A fresh merge on
 *     every render would rebuild that index on every render.
 *
 * Photos live in IndexedDB too, in their own store, keyed by part id and by
 * NOTHING else. That is deliberate: it means a photo can be attached to a
 * shipped part as well as an imported one, without a second table saying which
 * parts have pictures. Absence is the answer to "is there a photo" — one `get`
 * that comes back undefined — rather than a flag somebody has to keep true.
 */

import type { ImportedPart } from './importPart';
import type { Catalog, CatalogPart } from './types';

const PARTS_KEY = 'hsw.userParts.v1';
const DB_NAME = 'hsw-models';
const DB_STORE = 'stl';
const PHOTO_STORE = 'photos';
/**
 * Bumped from 1 when photos arrived. `onupgradeneeded` creates whichever stores
 * are missing rather than assuming a fresh database, so a browser that already
 * holds someone's imported STLs gains the photo store and keeps the models.
 */
const DB_VERSION = 2;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isHex = (v: unknown): boolean =>
  isObject(v) && Number.isFinite(v['q']) && Number.isFinite(v['r']);

/**
 * Is this stored blob still a usable part?
 *
 * localStorage is user-editable, survives upgrades, and is shared with whatever
 * else is on the origin. A part that fails here is dropped with a message
 * rather than allowed to reach the BOM as `undefined.length`.
 */
export function isUsablePart(value: unknown): value is ImportedPart {
  if (!isObject(value)) return false;
  if (typeof value['id'] !== 'string' || value['id'].length === 0) return false;
  if (typeof value['name'] !== 'string') return false;
  if (!Array.isArray(value['footprint']) || !value['footprint'].every(isHex)) return false;
  if (!Array.isArray(value['bboxMm']) || value['bboxMm'].length !== 3) return false;
  if (!isObject(value['print'])) return false;
  const type = value['type'];
  return (
    type === 'panel' || type === 'insert' || type === 'fastener' ||
    type === 'accessory' || type === 'unknown'
  );
}

export interface LoadResult {
  parts: ImportedPart[];
  /** Parts that were stored but could not be read back. Never silent. */
  dropped: string[];
  /**
   * Did we actually get to read the store?
   *
   * "No imports" and "could not look" are the same empty list and must not be
   * the same answer. Safari in private mode throws on `localStorage` access, and
   * an empty list read from a store that refused to open would tell
   * `sweepOrphans` that every model and photo in IndexedDB belongs to nothing —
   * deleting a person's uploads because the metadata hiccuped once. Anything
   * DESTRUCTIVE must check this; a reader that just shows a shorter list need
   * not.
   */
  readable: boolean;
}

export function parseUserParts(raw: string | null): LoadResult {
  // Nothing stored is a perfectly good, complete answer: no imports yet.
  if (raw === null || raw.length === 0) return { parts: [], dropped: [], readable: true };
  let decoded: unknown;
  /*
   * A store we cannot make sense of is NOT readable, even though we held the
   * bytes in our hand. The distinction matters to `sweepOrphans` alone: if the
   * list is corrupt we cannot say which models belong to a part, and deleting
   * them would turn a recoverable mess into lost uploads. Individual junk
   * ENTRIES are different — we read the list, one row was rubbish, and that
   * row's bytes really are orphaned.
   */
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { parts: [], dropped: ['the stored parts file is not valid JSON'], readable: false };
  }
  if (!Array.isArray(decoded)) {
    return { parts: [], dropped: ['the stored parts file is not a list'], readable: false };
  }

  const parts: ImportedPart[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const entry of decoded) {
    if (!isUsablePart(entry)) {
      dropped.push(
        isObject(entry) && typeof entry['id'] === 'string' ? entry['id'] : 'an unnamed entry',
      );
      continue;
    }
    if (seen.has(entry.id)) {
      dropped.push(`${entry.id} (duplicate id)`);
      continue;
    }
    seen.add(entry.id);
    parts.push(entry);
  }
  return { parts, dropped, readable: true };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const mergeCache = new WeakMap<Catalog, WeakMap<object, Catalog>>();

/**
 * The generated catalogue plus the user's own parts, as one catalogue.
 *
 * Imported ids carry a `user/` prefix, so a collision with a generated part is
 * structurally impossible and the merge never has to choose a winner.
 */
export function mergeCatalog(base: Catalog, userParts: readonly ImportedPart[]): Catalog {
  if (userParts.length === 0) return base;

  let inner = mergeCache.get(base);
  if (inner === undefined) {
    inner = new WeakMap<object, Catalog>();
    mergeCache.set(base, inner);
  }
  const cached = inner.get(userParts as unknown as object);
  if (cached !== undefined) return cached;

  const merged: Catalog = {
    ...base,
    parts: [...base.parts, ...(userParts as unknown as CatalogPart[])],
  };
  inner.set(userParts as unknown as object, merged);
  return merged;
}

/** Is this part one the user imported? */
export const isImported = (part: CatalogPart | undefined): boolean =>
  part !== undefined &&
  (part as Partial<ImportedPart>).measurement?.imported === true;

// ---------------------------------------------------------------------------
// localStorage
// ---------------------------------------------------------------------------

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Safari in private mode throws on access rather than returning null.
    return null;
  }
}

export function loadUserParts(): LoadResult {
  const store = storage();
  // Not `{parts: []}` with a shrug: a store that will not open is the case
  // `readable` exists for. See `LoadResult.readable`.
  if (store === null) return { parts: [], dropped: [], readable: false };
  try {
    return parseUserParts(store.getItem(PARTS_KEY));
  } catch {
    return { parts: [], dropped: ['the stored parts could not be read'], readable: false };
  }
}

/** @returns null on success, or a message explaining why nothing was saved. */
export function saveUserParts(parts: readonly ImportedPart[]): string | null {
  const store = storage();
  if (store === null) return 'This browser is not storing data for this page, so imports last only until you reload.';
  try {
    store.setItem(PARTS_KEY, JSON.stringify(parts));
    return null;
  } catch (err) {
    return `Could not save the imported parts: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// IndexedDB — the STL bytes, for the 3D view
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      if (!db.objectStoreNames.contains(PHOTO_STORE)) db.createObjectStore(PHOTO_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/**
 * One implementation for both stores.
 *
 * Every path resolves rather than rejecting: IndexedDB is a nice-to-have here —
 * it carries the 3D mesh and the photograph, and the planner works without
 * either — so a browser refusing it must degrade, not throw into a React event
 * handler. The boolean from `put` is the only report, and callers say so.
 */
async function put(store: string, id: string, value: unknown): Promise<boolean> {
  const db = await openDb();
  if (db === null) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function get<T>(store: string, id: string): Promise<T | null> {
  const db = await openDb();
  if (db === null) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(id);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function remove(store: string, id: string): Promise<void> {
  const db = await openDb();
  if (db === null) return;
  try {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
  } catch {
    // The part is already gone from the catalogue; orphaned bytes are harmless.
  }
}

export const putModelBytes = (id: string, bytes: ArrayBuffer): Promise<boolean> =>
  put(DB_STORE, id, bytes);

export const getModelBytes = (id: string): Promise<ArrayBuffer | null> =>
  get<ArrayBuffer>(DB_STORE, id);

export const deleteModelBytes = (id: string): Promise<void> => remove(DB_STORE, id);

// ---------------------------------------------------------------------------
// Photos — a picture of the printed part, for the library
// ---------------------------------------------------------------------------

/**
 * A photograph of the part, as an image Blob.
 *
 * Keyed on part id and nothing else, so this works for a shipped part as well
 * as an imported one. Downscaled before it gets here (`src/ui/partPhotos.ts`):
 * a browser's storage quota is shared with the STL bytes and a phone photo is
 * 4 MB, which is twenty parts before anything else can be saved.
 */
export const putPhoto = (id: string, image: Blob): Promise<boolean> =>
  put(PHOTO_STORE, id, image);

export const getPhoto = (id: string): Promise<Blob | null> => get<Blob>(PHOTO_STORE, id);

export const deletePhoto = (id: string): Promise<void> => remove(PHOTO_STORE, id);

/**
 * Which parts have a photo, in one read.
 *
 * The library shows fifty-one cards and each one wants to know whether to draw
 * a photograph or a render. Asking per card is fifty-one round trips through a
 * transaction each; asking once is a list of keys, which is what a gallery
 * actually needs to decide what to draw.
 */
export async function listPhotoIds(): Promise<ReadonlySet<string>> {
  return keysOf(PHOTO_STORE);
}

async function keysOf(store: string): Promise<ReadonlySet<string>> {
  const db = await openDb();
  if (db === null) return new Set();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAllKeys();
      req.onsuccess = () => resolve(new Set(req.result.map(String)));
      req.onerror = () => resolve(new Set());
    } catch {
      resolve(new Set());
    }
  });
}

// ---------------------------------------------------------------------------
// Sweeping up after an abandoned import
// ---------------------------------------------------------------------------

/**
 * Which stored ids belong to no part, and are therefore rubbish.
 *
 * Pure, so the rule is testable without a database. It is deliberately
 * one-directional: a part with no bytes is NOT rubbish — the model may simply
 * have failed to store on a browser that refuses IndexedDB, and the part still
 * plans, costs and exports. Only the reverse — bytes with no part — is dead
 * weight.
 */
export function orphanedIds(
  stored: Iterable<string>,
  parts: readonly { id: string }[],
): string[] {
  const alive = new Set(parts.map((p) => p.id));
  const out: string[] = [];
  for (const id of stored) if (!alive.has(id)) out.push(id);
  return out.sort();
}

/**
 * Delete stored models and photos that belong to no part, and report how many.
 *
 * An import writes its STL bytes into IndexedDB BEFORE the alignment step,
 * because that step draws the real mesh and `meshLibrary` reads an imported
 * part's bytes from exactly there. Cancelling sweeps them; closing the tab
 * cannot. Neither can a browser that dies, nor a `saveUserParts` that hits the
 * quota after the bytes are already down. So an abandoned import leaves a few
 * megabytes behind, and the quota it eats is the same one the 3D view needs.
 *
 * Run ONCE at startup, when no import can be in flight — mid-session it would
 * race the pending part, whose bytes are stored and whose entry deliberately
 * does not exist yet.
 *
 * `parts` must be the WHOLE catalogue, not just the imports. A photo is keyed
 * on part id and on nothing else, precisely so a shipped part can have one —
 * sweeping photos against the imported parts alone would delete it. Passing
 * everything is also correct for the model store, since a shipped part keeps
 * its mesh in `models/` and never appears there to begin with.
 */
export async function sweepOrphans(parts: readonly { id: string }[]): Promise<number> {
  const [models, photos] = await Promise.all([keysOf(DB_STORE), keysOf(PHOTO_STORE)]);
  const dead = [
    ...orphanedIds(models, parts).map((id) => remove(DB_STORE, id)),
    ...orphanedIds(photos, parts).map((id) => remove(PHOTO_STORE, id)),
  ];
  await Promise.all(dead);
  return dead.length;
}
