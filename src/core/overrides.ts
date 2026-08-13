/**
 * Human corrections to the generated catalogue.
 *
 * `src/catalog/catalog.json` is generated and must never be hand-edited — the
 * next `python tools/scan.py --rescan` would erase the edit. The documented
 * channel for a correction has always been `src/catalog/overrides.json`, which
 * the scanner reads and never writes.
 *
 * The gap this closes: only the SCANNER read that file, so a correction did
 * nothing until someone with Python, trimesh and a slicer re-ran it. Now the
 * app applies the same file at load time. Both readers apply the same
 * corrections to the same ids, so a rescan produces a catalogue that already
 * contains them and applying them again is a no-op — idempotent by
 * construction, not by luck.
 *
 * What is in there today is the fastener count. `tools/scan.py` had no way to
 * count a part's mounting bosses, so it ordered one insert per bolt bore, or
 * nothing at all, or `insert-empty × cells` — where `cells` is the bounding-box
 * BOUND that PARKED P1 explicitly says is not a measurement. Ten accessories
 * came with no fastener whatsoever; a 7-cell shelf with two pegs ordered seven
 * inserts.
 */

import type { Catalog, CatalogPart, InsertRequirement } from './types';

/**
 * Which face of a part goes against the wall, decided by a person looking at
 * the model rather than by the detector guessing.
 *
 * The detector picks the wall face from whichever candidate scores best, and
 * for 27 of the 51 shipped parts it declines to answer at all (PARKED P1). This
 * is the channel for answering it by hand: pick the face in the 3D inspector
 * and the whole detection is re-derived from that constraint, so the footprint,
 * the projection and the mesh all follow from the same decision.
 *
 * `spinSteps` is the third degree of freedom, in 30° steps about the wall
 * normal. 30° and not 60° on purpose: a hexagon repeats every 60°, so 60° steps
 * could never express the half-face offset between the app's pointy-top wall
 * and the flat-top frame every photograph shows (DECISIONS D31). Until that
 * frame question is settled this is how a part is made to look right.
 */
export interface MountingOverride {
  wallFaceAxis: 'x' | 'y' | 'z';
  matingEnd: 'low' | 'high';
  /** Turn about the wall normal, in 30° steps. Normalised to 0–11. */
  spinSteps?: number;
}

export interface PartOverride {
  /** Human answer to "which face mounts against the wall". */
  mounting?: MountingOverride;
  /** Replaces the part's requirements outright. An empty array means "nothing". */
  requires?: InsertRequirement[];
  hardware?: { item: string; count: number }[];
  /** The footprint is a bound rather than a measurement. */
  needsReview?: boolean;
  /**
   * The number of fixings this part takes could not be measured, so whatever
   * the catalogue says about it is a guess. Surfaced on the part, in the parts
   * list and in every export — never silently accepted.
   */
  fastenersNeedReview?: boolean;
  name?: string;
  type?: CatalogPart['type'];
  /** Why the correction exists. Carried into the part's provenance notes. */
  _note?: string;
}

export interface OverrideFile {
  parts?: Record<string, PartOverride>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A requirement is only usable if it names a part and a positive whole count. */
function readRequires(value: unknown): InsertRequirement[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: InsertRequirement[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const partId = entry['partId'];
    const count = entry['count'];
    if (typeof partId !== 'string' || partId.length === 0) continue;
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) continue;
    out.push({ partId, count: Math.round(count) });
  }
  return out;
}

/**
 * A mounting correction is only usable if it names a real axis and end. A
 * half-written one is discarded rather than half-applied: orienting a part off
 * a face nobody chose is the failure this whole channel exists to remove.
 */
export function readMounting(value: unknown): MountingOverride | undefined {
  if (!isObject(value)) return undefined;
  const axis = value['wallFaceAxis'];
  const end = value['matingEnd'];
  if (axis !== 'x' && axis !== 'y' && axis !== 'z') return undefined;
  if (end !== 'low' && end !== 'high') return undefined;
  const out: MountingOverride = { wallFaceAxis: axis, matingEnd: end };
  const spin = value['spinSteps'];
  if (typeof spin === 'number' && Number.isFinite(spin)) {
    // Normalised, so a caller cannot store 13 steps and get a different answer
    // from a caller who stored 1. Twelve 30° steps make a full turn.
    out.spinSteps = ((Math.round(spin) % 12) + 12) % 12;
  }
  return out;
}

/** The hand-picked mounting for a part, if one has been applied to it. */
export function mountingOf(part: CatalogPart): MountingOverride | undefined {
  return (part as unknown as Record<string, unknown>)['mounting'] as
    | MountingOverride
    | undefined;
}

/**
 * Apply corrections to a catalogue, returning a new one.
 *
 * Memoised on the identity of both inputs: `bom.ts` caches its part index in a
 * WeakMap keyed on the Catalog object, so handing it a fresh object per render
 * would rebuild that index per render.
 */
const cache = new WeakMap<Catalog, WeakMap<object, Catalog>>();

export function applyOverrides(base: Catalog, file: unknown): Catalog {
  if (!isObject(file) || !isObject(file['parts'])) return base;
  const table = file['parts'] as Record<string, unknown>;
  if (Object.keys(table).length === 0) return base;

  let inner = cache.get(base);
  if (inner === undefined) {
    inner = new WeakMap<object, Catalog>();
    cache.set(base, inner);
  }
  const hit = inner.get(file as object);
  if (hit !== undefined) return hit;

  const parts = base.parts.map((part) => {
    const raw = table[part.id];
    if (!isObject(raw)) return part;

    const next: CatalogPart = { ...part };
    const requires = readRequires(raw['requires']);
    if (requires !== undefined) next.requires = requires;
    if (Array.isArray(raw['hardware'])) {
      next.hardware = (raw['hardware'] as { item: string; count: number }[]).filter(
        (h) => isObject(h) && typeof h.item === 'string' && typeof h.count === 'number',
      );
    }
    if (typeof raw['name'] === 'string') next.name = raw['name'];

    // Flags live outside the CatalogPart contract, exactly as `needsReview`
    // already does — read structurally by whoever cares.
    const flagged = next as unknown as Record<string, unknown>;
    if (raw['needsReview'] === true || raw['needsReview'] === false) {
      flagged['needsReview'] = raw['needsReview'];
    }
    if (raw['fastenersNeedReview'] === true) flagged['fastenersNeedReview'] = true;

    // The hand-picked wall face. Carried on the part so `meshLibrary` and the
    // inspector read it from the same place the BOM does, rather than each
    // reaching back into the override file on its own.
    const mounting = readMounting(raw['mounting']);
    if (mounting !== undefined) flagged['mounting'] = mounting;

    const note = raw['_note'];
    if (typeof note === 'string' && note.length > 0) {
      next.provenance = {
        ...part.provenance,
        notes: [...(part.provenance?.notes ?? []), `override: ${note}`],
      };
    }
    return next;
  });

  const merged: Catalog = { ...base, parts };
  inner.set(file as object, merged);
  return merged;
}

/** Is this part's fastener count a guess rather than a measurement? */
export const fastenersNeedReview = (part: CatalogPart | undefined): boolean =>
  (part as unknown as { fastenersNeedReview?: unknown })?.fastenersNeedReview === true;
