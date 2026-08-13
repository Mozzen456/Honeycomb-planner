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

import { INSERT } from './constants';
import type { Catalog, CatalogPart, Hex, InsertRequirement } from './types';

/**
 * Which face of a part goes against the wall, and exactly where it sits on it —
 * decided by a person looking at the model rather than by the detector guessing.
 *
 * The detector picks the wall face from whichever candidate scores best, and
 * for 27 of the 51 shipped parts it declines to answer at all (PARKED P1). This
 * is the channel for answering it by hand: pick the face in the 3D inspector
 * and the whole detection is re-derived from that constraint, so the footprint,
 * the projection and the mesh all follow from the same decision.
 *
 * Picking the face fixes two degrees of freedom. The other four used to be one
 * and a half — a spin in 30° steps and a depth — which is enough to say "this
 * face, that way up" and not enough to seat a part that is drawn a few degrees
 * off, or whose mating feature is not centred in its own bounding box. So the
 * correction is now a full rigid transform: three translations and three
 * rotations, in WALL coordinates (+X across the wall, +Y up it, +Z out of it),
 * applied in the order `mountingTransform.mountingMatrix` documents.
 *
 * None of the six touch the DETECTION. The cells a part covers, its projection
 * and its tier still come from `detect()` under the chosen face — a seating
 * correction says where the mesh sits, and a tier-3 part's footprint is still
 * the bound PARKED P1 describes.
 */
export interface MountingOverride {
  wallFaceAxis: 'x' | 'y' | 'z';
  matingEnd: 'low' | 'high';
  /**
   * Turn about the wall normal, in 30° steps. Normalised to 0–11.
   *
   * 30° and not 60° on purpose: a hexagon repeats every 60°, so 60° steps could
   * never express the half-face offset between a pointy-top and a flat-top
   * frame (DECISIONS D31). Kept as whole steps because those are the turns the
   * lattice itself has; `spinDeg` is the trim between them.
   */
  spinSteps?: number;
  /** Fine turn about the wall normal, degrees, ON TOP of `spinSteps × 30°`. */
  spinDeg?: number;
  /**
   * Turn about the wall's across axis, degrees: the part's top swings OUT of
   * the wall for a positive angle.
   */
  tiltXDeg?: number;
  /**
   * Turn about the wall's up axis, degrees: the part's right edge swings INTO
   * the wall for a positive angle.
   */
  tiltYDeg?: number;
  /**
   * How far the part sits along the wall normal, mm. Positive stands it further
   * OUT of the wall, negative sinks it IN.
   *
   * The one that is not an orientation. `orient` seats every part with its
   * mating face at z = 0, which is right when the detector found the real mating
   * face and wrong when it settled for the flattest surface — the part then
   * floats off the wall or buries itself in it. Nothing in the geometry can
   * distinguish those two cases, so this is a person's correction and it is
   * stored as one.
   *
   * Clamped to ±40 mm on read: beyond that it is not a seating correction, it is
   * a part in the wrong place, and silently accepting 400 would hide it.
   */
  offsetMm?: number;
  /** Slide across the wall, mm, +X to the right. Clamped like the depth. */
  offsetXMm?: number;
  /** Slide up the wall, mm, +Y up. Clamped like the depth. */
  offsetYMm?: number;
  /**
   * What the depth is measured FROM — the wall's own face, or the face of the
   * inserts the part hangs on.
   *
   * HSW is two-level (HSW-SPEC §5): an insert clips into a cell and the
   * accessory pegs into the insert. The insert's 22.5 mm flange cannot enter the
   * 22.0 mm mouth, so it seats PROUD, and an accessory resting on it stands
   * `INSERT.flangeThickness` off the wall — 2.5 mm, measured, not chosen.
   * `orient` knows nothing about that: it puts every mating face at z = 0, i.e.
   * flat on the wall, which is where a part sits only if nothing is fastening it.
   *
   * A datum rather than a number, because 2.5 mm typed into the depth says
   * "somebody nudged it" while `seat: "insert"` says "it rests on its inserts",
   * and only the second stays true if the flange is ever re-measured.
   *
   * Default `wall`, so nothing moves until a person says it should.
   */
  seat?: 'wall' | 'insert';
}

/**
 * How far a seat lifts a part off the wall, mm.
 *
 * The whole of the insert's flange: it sits ON the wall face and the part sits
 * on IT. Read from `constants.ts` rather than written here as 2.5 — one
 * definition of every measured number is the rule this repo runs on.
 */
export const seatOffsetMm = (seat: MountingOverride['seat']): number =>
  seat === 'insert' ? INSERT.flangeThickness : 0;

/**
 * How far a seating correction may move a part, mm.
 *
 * The same bound in all three directions, and for the same reason it was
 * introduced for depth: past 40 mm — under two cell pitches — the part is not
 * badly seated, it is in the wrong CELL, and moving a part to another cell is
 * what placement is for. Exported so the inspector clamps to the number the
 * reader clamps to, rather than to its own copy of it.
 */
export const MAX_OFFSET_MM = 40;

/** How far it may be turned, degrees. A half turn either way reaches everything. */
export const MAX_TILT_DEG = 180;

export interface PartOverride {
  /** Human answer to "which face mounts against the wall". */
  mounting?: MountingOverride;
  /**
   * Human answer to "how much wall does it take" — the cells it occupies, as
   * offsets from its anchor. Replaces the detected footprint outright.
   */
  footprint?: Hex[];
  /**
   * Cells of this part that are MOUNTING POSITIONS: something else may be
   * installed into them, even though this part fills the cell.
   *
   * `insert-for-countersunk-hole-3` is the case that named it. It spans four
   * cells, ties four plates together and takes one wall screw — and three of
   * those four cells are open 13.2 mm hexagonal sockets, measured. Without this
   * the planner treated all four as filled and refused anything at all in them:
   * one insert per hole is the right rule for a plain insert and the wrong one
   * for a part that IS the hole.
   */
  socketCells?: Hex[];
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
export function readRequires(value: unknown): InsertRequirement[] | undefined {
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
 * One of the six seating numbers: finite, a tenth of its unit, and clamped.
 *
 * Rounded AWAY from zero, not with `Math.round`, which rounds half toward +∞ and
 * so turns −3.25 into −3.2 while turning 3.25 into 3.3. Every one of these is
 * symmetric about zero — the same nudge each way should round by the same amount
 * — and an asymmetry there shows up as a part that will not return to where it
 * was. Clamped rather than accepted: past the bound it is not a seating
 * correction, and taking 400 silently would hide that.
 */
function readTrim(value: unknown, limit: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const tenths = Math.sign(value) * Math.round(Math.abs(value) * 10);
  const clamped = Math.max(-limit, Math.min(limit, tenths / 10));
  // `−0` is a number that compares equal to 0 and fails `Object.is`, which is
  // what a test — and a dirty check — uses. Normalise it away at the door.
  return clamped === 0 ? 0 : clamped;
}

/**
 * A mounting correction is only usable if it names a real axis and end. A
 * half-written one is discarded rather than half-applied: orienting a part off
 * a face nobody chose is the failure this whole channel exists to remove.
 *
 * The six seating numbers are all optional and all independent — an old
 * correction carrying only `spinSteps` and `offsetMm` reads back as exactly
 * itself, with the four new ones absent rather than zeroed.
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
  const spinDeg = readTrim(value['spinDeg'], MAX_TILT_DEG);
  if (spinDeg !== undefined) out.spinDeg = spinDeg;
  const tiltX = readTrim(value['tiltXDeg'], MAX_TILT_DEG);
  if (tiltX !== undefined) out.tiltXDeg = tiltX;
  const tiltY = readTrim(value['tiltYDeg'], MAX_TILT_DEG);
  if (tiltY !== undefined) out.tiltYDeg = tiltY;
  const offset = readTrim(value['offsetMm'], MAX_OFFSET_MM);
  if (offset !== undefined) out.offsetMm = offset;
  const offsetX = readTrim(value['offsetXMm'], MAX_OFFSET_MM);
  if (offsetX !== undefined) out.offsetXMm = offsetX;
  const offsetY = readTrim(value['offsetYMm'], MAX_OFFSET_MM);
  if (offsetY !== undefined) out.offsetYMm = offsetY;
  const seat = value['seat'];
  if (seat === 'wall' || seat === 'insert') out.seat = seat;
  return out;
}

/**
 * The cells a person says a part covers.
 *
 * `detect()` gives a footprint for every part, but for the 27 with no wall
 * interface it is the BOUNDING BOX of the part laid over the lattice — a bound,
 * not a measurement (PARKED P1), and it is why a 7-cell shelf reads as seven
 * cells when the installer only ever uses two. Nothing in the geometry can fix
 * that, because which cells get used is a CHOICE. This is where the choice is
 * recorded.
 *
 * Validated hard, because it decides where a part may be dropped and what the
 * BOM says it overlaps:
 *   - whole numbers only, within a wall's worth of reach;
 *   - deduplicated, so a repeated cell cannot inflate a count;
 *   - the anchor is always a member — `partCells` puts the anchor under the
 *     cursor, and a footprint with nothing at the origin has no cell to drag by.
 */
const MAX_FOOTPRINT_CELLS = 64;
const MAX_FOOTPRINT_REACH = 32;

export function readFootprint(value: unknown): Hex[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: Hex[] = [{ q: 0, r: 0 }];
  seen.add('0,0');
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const q = entry['q'];
    const r = entry['r'];
    if (typeof q !== 'number' || !Number.isFinite(q)) continue;
    if (typeof r !== 'number' || !Number.isFinite(r)) continue;
    const cell = { q: Math.round(q), r: Math.round(r) };
    if (Math.abs(cell.q) > MAX_FOOTPRINT_REACH || Math.abs(cell.r) > MAX_FOOTPRINT_REACH) continue;
    const key = `${cell.q},${cell.r}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cell);
    if (out.length >= MAX_FOOTPRINT_CELLS) break;
  }
  return out;
}

/** A catalogue footprint, defensively: a hand-edited file may carry anything. */
const asCells = (value: unknown): Hex[] => (Array.isArray(value) ? (value as Hex[]) : []);

/** Same cells, in any order? Used to tell an EDIT from a re-statement. */
const sameCells = (a: readonly Hex[], b: readonly Hex[]): boolean => {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map((c) => `${c.q},${c.r}`));
  return b.every((c) => keys.has(`${c.q},${c.r}`));
};

/**
 * The cells of a part that something can be installed INTO, validated against
 * the cells it actually covers.
 *
 * A socket outside the footprint is meaningless — it would open a hole in a cell
 * the part is not in — so it is dropped rather than honoured. The anchor is not
 * special here: on `insert-for-countersunk-hole-3` the anchor cell IS one of the
 * three sockets.
 */
export function readSockets(value: unknown, footprint: readonly Hex[]): Hex[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const covered = new Set(footprint.map((c) => `${c.q},${c.r}`));
  const seen = new Set<string>();
  const out: Hex[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const q = entry['q'];
    const r = entry['r'];
    if (typeof q !== 'number' || !Number.isFinite(q)) continue;
    if (typeof r !== 'number' || !Number.isFinite(r)) continue;
    const key = `${Math.round(q)},${Math.round(r)}`;
    if (!covered.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ q: Math.round(q), r: Math.round(r) });
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
 * The cells of a part that accept something installed into them.
 *
 * Read structurally, like `needsReview` and `mounting`: `catalog.json` is
 * generated and its schema is the scanner's, so a fact a person supplied lives
 * beside it rather than inside it.
 */
export function socketsOf(part: CatalogPart | undefined): Hex[] {
  const value = (part as unknown as Record<string, unknown> | undefined)?.['sockets'];
  return Array.isArray(value) ? (value as Hex[]) : [];
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

    /*
     * The cells, drawn by hand.
     *
     * Everything downstream reads `part.footprint` — `store.partCells` for what
     * a drop covers, `bom.itemCells` for what the parts list reconciles, the
     * ghost for what the drag shows — so replacing it here is the whole change.
     * The anchor goes back to the origin with it, because that is what the
     * editor draws around and what `partCells` puts under the cursor.
     *
     * NOT the fastener count. That comes from the pegs `detect.mountPoints()`
     * measured on the wall face (HSW-SPEC §5), and deriving it from cells is the
     * exact mistake that had a 7-cell shelf with two pegs ordering seven
     * inserts. Cells are how much wall a part covers; pegs are what holds it up.
     */
    const footprint = readFootprint(raw['footprint']);
    const edited = footprint !== undefined && !sameCells(footprint, asCells(part.footprint));
    if (footprint !== undefined) {
      next.footprint = footprint;
      next.anchor = { q: 0, r: 0 };
    }
    if (Array.isArray(raw['hardware'])) {
      next.hardware = (raw['hardware'] as { item: string; count: number }[]).filter(
        (h) => isObject(h) && typeof h.item === 'string' && typeof h.count === 'number',
      );
    }
    if (typeof raw['name'] === 'string') next.name = raw['name'];

    // Flags live outside the CatalogPart contract, exactly as `needsReview`
    // already does — read structurally by whoever cares.
    const flagged = next as unknown as Record<string, unknown>;
    /*
     * Drawing the cells clears `needsReview`; re-stating them does not.
     *
     * This is the same line `withFootprint` draws for an imported part, and for
     * the same reason: the flag says "these cells are a bounding box, not a
     * measurement", and an actual EDIT replaces the bound with a decision.
     * Clicking a cell and clicking it back is not a decision, and promoting a
     * bound by round-tripping the editor is the dishonesty PARKED P1 exists to
     * prevent.
     */
    if (edited) flagged['needsReview'] = false;
    if (raw['needsReview'] === true || raw['needsReview'] === false) {
      flagged['needsReview'] = raw['needsReview'];
    }
    if (raw['fastenersNeedReview'] === true) flagged['fastenersNeedReview'] = true;

    // The hand-picked wall face. Carried on the part so `meshLibrary` and the
    // inspector read it from the same place the BOM does, rather than each
    // reaching back into the override file on its own.
    const mounting = readMounting(raw['mounting']);
    if (mounting !== undefined) flagged['mounting'] = mounting;

    // Validated against the footprint AFTER any footprint override, so drawing
    // the cells and marking the sockets in one edit agree with each other.
    const sockets = readSockets(raw['socketCells'], next.footprint);
    if (sockets !== undefined) flagged['sockets'] = sockets;

    const notes = [...(part.provenance?.notes ?? [])];
    if (edited) notes.push(`footprint set by hand to ${next.footprint.length} cell(s)`);
    const note = raw['_note'];
    if (typeof note === 'string' && note.length > 0) notes.push(`override: ${note}`);
    if (notes.length !== (part.provenance?.notes?.length ?? 0)) {
      next.provenance = { ...part.provenance, notes };
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
