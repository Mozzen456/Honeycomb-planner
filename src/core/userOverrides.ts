/**
 * Corrections a person made in this browser, before they reach the repo.
 *
 * `src/catalog/overrides.json` is the documented home for a human correction,
 * and it is read by BOTH the app and `tools/scan.py` — which is what makes a
 * correction survive a rescan. But a browser cannot write into the repository,
 * so a correction made in the 3D inspector would either take effect immediately
 * and never persist, or persist and never take effect until someone edited a
 * file by hand.
 *
 * This is the bridge: corrections are kept in localStorage so they apply on the
 * next render and survive a reload, and `toOverrideFile` renders them in exactly
 * the shape `overrides.json` expects, so they can be committed and the scanner
 * then agrees. The two layers are merged with the shipped file taking the LOWER
 * precedence — once a correction is committed, the local copy is saying the same
 * thing, and if they ever disagree the newer local decision is the one the
 * person just made.
 *
 * Deliberately separate from `userCatalog.ts`: that stores parts the user
 * ADDED, this stores corrections to parts that already exist. Merging them
 * would mean a correction disappearing when a part was removed.
 */

import {
  readFootprint, readMounting, readRequires, readSockets,
  type MountingOverride, type OverrideFile, type PartOverride,
} from './overrides';
import type { Hex, InsertRequirement } from './types';

const KEY = 'hsw.overrides.v1';

export interface UserOverrides {
  /** Keyed by part id, exactly as `overrides.json` is. */
  parts: Record<string, PartOverride>;
}

const empty = (): UserOverrides => ({ parts: {} });

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // Blocked by a privacy setting. A planner that cannot persist still plans.
    return null;
  }
}

export function loadUserOverrides(): UserOverrides {
  const store = storage();
  if (store === null) return empty();
  try {
    const text = store.getItem(KEY);
    if (text === null) return empty();
    return readUserOverrides(JSON.parse(text));
  } catch {
    return empty();
  }
}

/**
 * A stored document, re-validated field by field.
 *
 * Split from `loadUserOverrides` so it can be tested without a browser, which
 * is where the rule that matters lives: every field is read back explicitly, and
 * one that nobody reads is a correction that applies for a session and vanishes
 * on reload. That is precisely what happened to the chosen fastener.
 */
export function readUserOverrides(raw: unknown): UserOverrides {
  if (typeof raw !== 'object' || raw === null) return empty();
  const parts = (raw as Record<string, unknown>)['parts'];
  if (typeof parts !== 'object' || parts === null) return empty();

  // Re-validated on the way IN, not trusted because we wrote it: a stored
  // document is user input by the time it comes back, and a hand-edited or
  // half-migrated entry must not orient a part off a face nobody chose.
  const out: Record<string, PartOverride> = {};
  for (const [id, value] of Object.entries(parts as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const mounting = readMounting((value as Record<string, unknown>)['mounting']);
    const footprint = readFootprint((value as Record<string, unknown>)['footprint']);
    // Validated against the footprint stored alongside it — a socket in a cell
    // the part does not cover is a hole in solid material.
    const sockets = readSockets(
      (value as Record<string, unknown>)['socketCells'], footprint ?? [],
    );
    // Read back too, or a fastener chosen by hand would apply for one session
    // and vanish on reload — which is exactly what "saved" must not mean.
    const requires = readRequires((value as Record<string, unknown>)['requires']);
    const note = (value as Record<string, unknown>)['_note'];
    const entry: PartOverride = {};
    if (mounting !== undefined) entry.mounting = mounting;
    if (footprint !== undefined) entry.footprint = footprint;
    if (sockets !== undefined && sockets.length > 0) entry.socketCells = sockets;
    if (requires !== undefined) entry.requires = requires;
    if (typeof note === 'string' && note.length > 0) entry._note = note;
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return { parts: out };
}

function save(value: UserOverrides): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(KEY, JSON.stringify(value));
  } catch {
    /* quota or privacy mode — the correction still applies this session */
  }
}

/**
 * Record which face of `partId` mounts against the wall, and where it sits.
 *
 * MERGED onto whatever is already recorded for that part, not written over it.
 * The mounting and the footprint are two different answers about the same part
 * — "which way round" and "how much wall" — and replacing the entry meant
 * saving one silently discarded the other.
 */
export function setMounting(
  current: UserOverrides,
  partId: string,
  mounting: MountingOverride,
  note?: string,
): UserOverrides {
  const entry: PartOverride = { ...current.parts[partId], mounting };
  if (note !== undefined && note.length > 0) entry._note = note;
  const next: UserOverrides = { parts: { ...current.parts, [partId]: entry } };
  save(next);
  return next;
}

/**
 * Record the cells `partId` covers, and which of them are sockets. Merged, for
 * the same reason.
 *
 * The two travel together because a socket is a property OF a cell: saving the
 * footprint without the sockets would leave holes marked in cells the part no
 * longer covers, which `readSockets` would then quietly drop.
 */
export function setFootprint(
  current: UserOverrides,
  partId: string,
  footprint: readonly Hex[],
  sockets: readonly Hex[] = [],
  note?: string,
): UserOverrides {
  const entry: PartOverride = {
    ...current.parts[partId],
    footprint: footprint.map((c) => ({ q: c.q, r: c.r })),
    socketCells: sockets.map((c) => ({ q: c.q, r: c.r })),
  };
  if (note !== undefined && note.length > 0) entry._note = note;
  const next: UserOverrides = { parts: { ...current.parts, [partId]: entry } };
  save(next);
  return next;
}

/**
 * Record which fastener holds `partId` on, and how many. Merged, like the rest.
 *
 * An empty list is a real answer — "this part needs no insert of its own" — and
 * is stored as such rather than deleted, because `applyOverrides` reads an empty
 * array as "replace the catalogue's guess with nothing". Deleting the key would
 * silently restore the guess.
 */
export function setRequires(
  current: UserOverrides,
  partId: string,
  requires: readonly InsertRequirement[],
  note?: string,
): UserOverrides {
  const entry: PartOverride = {
    ...current.parts[partId],
    requires: requires.map((r) => ({ partId: r.partId, count: Math.max(0, Math.round(r.count)) })),
  };
  if (note !== undefined && note.length > 0) entry._note = note;
  const next: UserOverrides = { parts: { ...current.parts, [partId]: entry } };
  save(next);
  return next;
}

/** Forget the correction for one part, falling back to whatever ships. */
export function clearMounting(current: UserOverrides, partId: string): UserOverrides {
  if (!(partId in current.parts)) return current;
  const parts = { ...current.parts };
  delete parts[partId];
  const next: UserOverrides = { parts };
  save(next);
  return next;
}

/**
 * The shipped overrides with the local ones layered on top, as one file-shaped
 * object that `applyOverrides` can consume.
 *
 * Merged per part rather than per file, so a local mounting correction does not
 * discard the shipped fastener count for the same part — those are different
 * facts about it, decided by different people at different times.
 */
export function mergeOverrideFiles(shipped: unknown, user: UserOverrides): OverrideFile {
  const base =
    typeof shipped === 'object' && shipped !== null
      ? ((shipped as Record<string, unknown>)['parts'] as Record<string, PartOverride> | undefined)
      : undefined;
  const parts: Record<string, PartOverride> = { ...(base ?? {}) };
  for (const [id, entry] of Object.entries(user.parts)) {
    parts[id] = { ...(parts[id] ?? {}), ...entry };
  }
  return { parts };
}

/**
 * The local corrections in `overrides.json`'s own shape, ready to commit.
 *
 * Only the parts actually corrected here — emitting the whole merged file would
 * mean a person pasting back the shipped entries as though they were new
 * decisions, and a diff nobody can read is a diff nobody checks.
 */
export function toOverrideFile(user: UserOverrides): string {
  const parts: Record<string, PartOverride> = {};
  for (const id of Object.keys(user.parts).sort()) parts[id] = user.parts[id]!;
  return `${JSON.stringify({ parts }, null, 1)}\n`;
}

/**
 * The WHOLE setup: every part that carries a correction, shipped or local, as
 * one file to drop over `src/catalog/overrides.json` and commit.
 *
 * The narrow export above answers "what did I change"; this one answers "what
 * should this project's setup be", which is the thing you push. Both are needed
 * and they are not the same file: a person who has corrected four parts in this
 * browser still wants the other forty-seven decisions to travel with them.
 *
 * Written to diff cleanly against the file it replaces. Parts are sorted by id
 * and an untouched entry is the shipped object itself, so it serialises byte for
 * byte as it already reads; the preamble (`_why`, `_rule`, `_applied_by`,
 * `_regenerate`) is carried through in place, because it is the explanation of
 * why the file exists and dropping it would leave the next reader guessing.
 */
export function toSetupFile(shipped: unknown, user: UserOverrides): string {
  const merged = mergeOverrideFiles(shipped, user).parts ?? {};
  const parts: Record<string, PartOverride> = {};
  for (const id of Object.keys(merged).sort()) parts[id] = merged[id]!;

  const preamble: Record<string, unknown> = {};
  if (typeof shipped === 'object' && shipped !== null) {
    for (const [key, value] of Object.entries(shipped as Record<string, unknown>)) {
      if (key !== 'parts') preamble[key] = value;
    }
  }
  return `${JSON.stringify({ ...preamble, parts }, null, 1)}\n`;
}

export const OVERRIDES_STORAGE_KEY = KEY;
