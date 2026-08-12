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
 */

import type { ImportedPart } from './importPart';
import type { Catalog, CatalogPart } from './types';

const PARTS_KEY = 'hsw.userParts.v1';
const DB_NAME = 'hsw-models';
const DB_STORE = 'stl';

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
}

export function parseUserParts(raw: string | null): LoadResult {
  if (raw === null || raw.length === 0) return { parts: [], dropped: [] };
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { parts: [], dropped: ['the stored parts file is not valid JSON'] };
  }
  if (!Array.isArray(decoded)) return { parts: [], dropped: ['the stored parts file is not a list'] };

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
  return { parts, dropped };
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
  if (store === null) return { parts: [], dropped: [] };
  try {
    return parseUserParts(store.getItem(PARTS_KEY));
  } catch {
    return { parts: [], dropped: ['the stored parts could not be read'] };
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
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

export async function putModelBytes(id: string, bytes: ArrayBuffer): Promise<boolean> {
  const db = await openDb();
  if (db === null) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(bytes, id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function getModelBytes(id: string): Promise<ArrayBuffer | null> {
  const db = await openDb();
  if (db === null) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(id);
      req.onsuccess = () => resolve((req.result as ArrayBuffer | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function deleteModelBytes(id: string): Promise<void> {
  const db = await openDb();
  if (db === null) return;
  try {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(id);
  } catch {
    // The part is already gone from the catalogue; orphaned bytes are harmless.
  }
}
