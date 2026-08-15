/**
 * The walls you have saved, and the one you were in the middle of.
 *
 * Two separate jobs, deliberately, because they answer two different fears:
 *
 *   - THE SESSION is the wall currently on screen, written back on every edit.
 *     It exists so that closing the tab, reloading, or a browser crash does not
 *     throw away an afternoon. It is not a save; nobody asked for it and nobody
 *     names it. It is the working copy.
 *   - THE SHELF is the walls you deliberately kept, each with a name. It exists
 *     so a person can plan the garage and the workshop without one destroying
 *     the other.
 *
 * Keeping them apart is what lets "New wall" be safe. If the session WERE the
 * save, starting a blank one would silently overwrite the thing you had; with
 * two stores, the shelf is untouched by anything you do to the working copy.
 *
 * A saved wall is the same text `serialize` writes to a file and `deserialize`
 * reads back, so a wall on the shelf, a wall in a downloaded `.json` and a wall
 * in a share link are one format with one migration path. Nothing here parses a
 * document: it stores text and a SUMMARY beside it.
 *
 * The summary is not a denormalisation for speed alone. `pruneWallPhotos` bounds
 * the photo store as a cache and needs to know which pictures are still spoken
 * for — and until there was a shelf, "no open document claims it" was the only
 * available answer, which is why D88 had to treat a layout on disk as
 * unknowable. Now the shelf can say. Recording `photoId` on the entry means that
 * question is answered without parsing every wall on the shelf at startup.
 *
 * Everything above the storage functions is pure and takes its clock as an
 * argument, so the ordering rules can be tested without a browser or a fake
 * timer.
 */

import type { LayoutDoc } from './types';

/** The shelf. */
export const WALLS_KEY = 'hsw.walls.v1';
/** The working copy. */
export const SESSION_KEY = 'hsw.session.v1';

/**
 * How many walls the shelf holds.
 *
 * A bound rather than a cliff: going over REFUSES the save and says so, and
 * never evicts. Dropping somebody's oldest wall to make room for their newest
 * is the one behaviour a shelf must not have — the whole point of it is that
 * things stay where you put them.
 */
export const MAX_SAVED_WALLS = 50;

export interface SavedWall {
  /** The document's own id, so saving twice replaces rather than duplicates. */
  id: string;
  name: string;
  /** Epoch milliseconds. Supplied by the caller; nothing here reads a clock. */
  savedAt: number;
  /** Enough to list the shelf without deserialising every wall on it. */
  widthMm: number;
  heightMm: number;
  plates: number;
  items: number;
  /** The wall photograph this layout still needs, if it has one. */
  photoId?: string;
  /** `serialize(doc)` — the same text a downloaded `.json` contains. */
  text: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Read the shelf back, entry by entry.
 *
 * A stored value is user input by the time it comes back — hand-edited, written
 * by an older build, or truncated by a browser that ran out of room mid-write —
 * so every field is checked and a MALFORMED ENTRY IS DROPPED ON ITS OWN. The
 * alternative, failing the whole list, would turn one bad row into "all your
 * walls are gone", which is the failure this module exists to prevent.
 */
export function readWalls(raw: unknown): SavedWall[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedWall[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const id = str(e['id']);
    const text = str(e['text']);
    if (id === undefined || id === '' || text === undefined || text === '') continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: str(e['name']) ?? 'Untitled wall',
      savedAt: num(e['savedAt']) ?? 0,
      widthMm: num(e['widthMm']) ?? 0,
      heightMm: num(e['heightMm']) ?? 0,
      plates: num(e['plates']) ?? 0,
      items: num(e['items']) ?? 0,
      ...(str(e['photoId']) !== undefined ? { photoId: str(e['photoId'])! } : {}),
      text,
    });
  }
  return sortWalls(out);
}

/** Newest first, and a stable tie-break so the shelf never shuffles under you. */
export function sortWalls(list: readonly SavedWall[]): SavedWall[] {
  return [...list].sort((a, b) =>
    b.savedAt - a.savedAt || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The listable facts about a document, taken once at save time. */
export function wallSummary(doc: LayoutDoc): Omit<SavedWall, 'text' | 'savedAt'> {
  return {
    id: doc.id,
    name: doc.name.trim().length > 0 ? doc.name.trim() : 'Untitled wall',
    widthMm: doc.wall?.widthMm ?? 0,
    heightMm: doc.wall?.heightMm ?? 0,
    plates: doc.panels?.length ?? 0,
    items: doc.items?.length ?? 0,
    ...(doc.photo?.id !== undefined ? { photoId: doc.photo.id } : {}),
  };
}

export interface PutResult {
  walls: SavedWall[];
  /** Absent on success. A sentence to show the user, never a code. */
  refused?: string;
}

/**
 * Put a wall on the shelf, replacing any wall with the same id.
 *
 * Keyed on the DOCUMENT's id and not on its name: saving the same wall twice is
 * one wall, and two walls a person happened to give the same name are still two
 * walls. Naming is how you tell them apart, not how the shelf does.
 */
export function putWall(
  list: readonly SavedWall[], doc: LayoutDoc, text: string, savedAt: number,
): PutResult {
  const summary = wallSummary(doc);
  const without = list.filter((w) => w.id !== summary.id);
  if (without.length >= MAX_SAVED_WALLS) {
    return {
      walls: sortWalls(list),
      refused: `The shelf holds ${MAX_SAVED_WALLS} walls. Delete one you have finished with, `
        + 'or download this layout instead — nothing has been lost.',
    };
  }
  return { walls: sortWalls([...without, { ...summary, savedAt, text }]) };
}

export function removeWall(list: readonly SavedWall[], id: string): SavedWall[] {
  return sortWalls(list.filter((w) => w.id !== id));
}

/**
 * Every photograph the shelf still needs kept.
 *
 * Handed to `pruneWallPhotos` so its cache bound cannot throw away the picture
 * belonging to a wall somebody saved three weeks ago.
 */
export function protectedPhotoIds(
  list: readonly SavedWall[], openPhotoId?: string,
): string[] {
  const ids = new Set<string>();
  for (const w of list) if (w.photoId !== undefined && w.photoId !== '') ids.add(w.photoId);
  if (openPhotoId !== undefined && openPhotoId !== '') ids.add(openPhotoId);
  return [...ids];
}

// ---------------------------------------------------------------------------
// Storage. Everything below touches the browser; everything above does not.
// ---------------------------------------------------------------------------

/**
 * `localStorage`, or null.
 *
 * Behind a `try` because Safari THROWS on the property access itself in private
 * mode rather than returning null. A browser refusing storage is not a reason to
 * refuse to run — it costs the session and the shelf, and the app still works.
 */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadWalls(): SavedWall[] {
  const store = storage();
  if (store === null) return [];
  try {
    const text = store.getItem(WALLS_KEY);
    return text === null ? [] : readWalls(JSON.parse(text));
  } catch {
    return [];
  }
}

/**
 * Write the shelf. `false` means the browser refused — almost always the quota,
 * which a wall with a few hundred plates can genuinely reach.
 *
 * Reported rather than swallowed: a save that silently did not happen is the
 * worst outcome this module can produce, because the wall is still on screen and
 * looks kept.
 */
export function storeWalls(list: readonly SavedWall[]): boolean {
  const store = storage();
  if (store === null) return false;
  try {
    store.setItem(WALLS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function loadSession(): string | null {
  const store = storage();
  if (store === null) return null;
  try {
    const text = store.getItem(SESSION_KEY);
    return text !== null && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Silent on failure: the working copy is a convenience, not a promise. */
export function storeSession(text: string): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(SESSION_KEY, text);
  } catch {
    /* quota or privacy mode — the wall on screen is unaffected */
  }
}

export function clearSession(): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(SESSION_KEY);
  } catch {
    /* nothing to do, and nothing worth telling anyone */
  }
}
