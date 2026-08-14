/**
 * Bill of materials, and the validation that keeps it honest.
 *
 * This is the module the user's printer eats. Everything here is pure: it reads
 * a LayoutDoc and a Catalog, and returns new objects. No DOM, no I/O, no clock,
 * no randomness, and nothing passed in is ever mutated.
 *
 * The rules that matter, and why:
 *
 *  R1. Full precision is kept in the accumulators and rounded exactly once, at
 *      the boundary. Totals are summed from unrounded per-unit values, never
 *      from the rounded numbers on the lines — 60 lines each rounded to a tenth
 *      of a gram drift by grams, which is a wrong BOM that looks right. Grams ->
 *      1 dp, metres -> 2 dp. Counts (quantity, printed, to print) are whole
 *      things and are never rounded at all: they are counted.
 *
 *  R2. A part appears on exactly one line. Inserts and fasteners (catalogue
 *      `type` of 'insert' or 'fastener') go to `Bom.fasteners`, everything else
 *      to `Bom.printed`, whether the quantity came from a direct placement, from
 *      another part's `requires[]`, or from both. Splitting the same STL across
 *      two lines is exactly how someone prints the wrong number of them.
 *
 *  R3. Requirements are expanded one level: a placed part pulls in its
 *      `requires[]`. A required part's own `requires[]` is NOT expanded — no
 *      shipped part nests, and one level makes a requirement cycle structurally
 *      impossible rather than silently truncated. `hardware[]` IS collected from
 *      every part in the BOM, placed or required, so the screws that come with
 *      an insert are counted once per insert.
 *
 *  R4. Nothing throws. A partId missing from the catalogue is reported as an
 *      `unknown-part` issue and contributes nothing; the rest of the BOM is
 *      still computed and still usable.
 *
 *  R5. Output order is deterministic and independent of placement order:
 *      lines by name then partId, shopping by item name, issues grouped by code.
 */

import { colorOfLine as lineColor } from './colors';
import { customPanelGroups, isCustomPanel } from './customiser';
import { fastenerCells, fixingsFor, JUNCTION_FIXING_ID, type FixingPlan } from './fixings';
import { fastenersNeedReview, socketProvidesOf, socketsOf } from './overrides';
import { hexKey, hexSub, keyToHex, placedPanelCells, placeFootprint } from './hex';
import { borderCutCells, isGeneratedSize, panelFrameKey, panelFrameSides } from './panelModel';
import { crossesSeam } from './tiling';
import type {
  Bom,
  BomLine,
  Catalog,
  CatalogPart,
  Hex,
  Issue,
  LayoutDoc,
  PlacedItem,
  PlacedPanel,
  Rotation,
} from './types';

// ---------------------------------------------------------------------------
// Small, boring helpers. Defensive because the catalogue is generated JSON:
// a field that is missing on disk must degrade to zero, not to NaN in a total.
// ---------------------------------------------------------------------------

const ORIGIN: Hex = { q: 0, r: 0 };

/** Locale-independent string order, so sorting is identical everywhere. */
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Reading order for reported cells: down the rows, then along a row. */
const byCell = (a: Hex, b: Hex): number => a.r - b.r || a.q - b.q;

function asArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

function finite(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A count of physical things: finite and never negative. */
function countOf(value: number | undefined | null): number {
  const n = finite(value);
  return n > 0 ? n : 0;
}

/**
 * Round at the boundary only.
 *
 * The nudge absorbs binary representation error — 0.05 × 40 is 2.0000000000000004
 * and 1.15 × 100 is 114.99999999999999 — so a value that is decimally exact
 * rounds to itself instead of to a neighbour. 1e-9 is far below any real print
 * estimate and far above the representation error at these magnitudes.
 */
function roundTo(value: number, dp: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** dp;
  const scaled = value * factor;
  const rounded = Math.round(scaled + (scaled < 0 ? -1e-9 : 1e-9)) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

const roundGrams = (v: number): number => roundTo(v, 1);
const roundMetres = (v: number): number => roundTo(v, 2);

/**
 * How many of this line are already printed, read off the document.
 *
 * Whole things only, never negative, and CAPPED at what the layout asks for —
 * the document is allowed to remember that you printed eight of something the
 * wall currently needs three of (see `LayoutDoc.printed`), but a line saying
 * "8 of 3 printed, −5 to go" is not a fact about anything. The cap lives here,
 * at the one place a line is built, so the panel, the exports and the totals
 * cannot each pick a different answer.
 */
function printedOf(
  progress: Record<string, number> | undefined,
  partId: string,
  quantity: number,
): { printed: number; toPrint: number } {
  const raw = progress?.[partId];
  const done = Math.min(quantity, Math.max(0, Math.floor(finite(raw))));
  return { printed: done, toPrint: Math.max(0, quantity - done) };
}

function bump(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

// ---------------------------------------------------------------------------
// Catalogue index
// ---------------------------------------------------------------------------

/**
 * partId -> part, memoised per Catalog object so that validating 200 items does
 * not rebuild the index 200 times. The catalogue is read-only by contract (it is
 * generated by tools/scan.py and consumed, never edited), so this is a cache of
 * a pure function, not hidden state. First entry wins on a duplicate id.
 */
const indexCache = new WeakMap<Catalog, ReadonlyMap<string, CatalogPart>>();

function partIndex(catalog: Catalog): ReadonlyMap<string, CatalogPart> {
  const cached = indexCache.get(catalog);
  if (cached !== undefined) return cached;

  const map = new Map<string, CatalogPart>();
  for (const part of asArray(catalog?.parts)) {
    if (part && typeof part.id === 'string' && !map.has(part.id)) map.set(part.id, part);
  }
  indexCache.set(catalog, map);
  return map;
}

/**
 * The biggest shipped plate, used as the per-cell yardstick for a plate the app
 * sized itself. Biggest because it has the most cells to average over, so its
 * per-cell figure carries the least edge effect.
 */
function biggestPanel(index: ReadonlyMap<string, CatalogPart>): CatalogPart | undefined {
  let best: CatalogPart | undefined;
  for (const part of index.values()) {
    if (part.type !== 'panel' || !part.panel) continue;
    const cells = asArray(part.footprint).length;
    if (best === undefined || cells > asArray(best.footprint).length) best = part;
  }
  return best;
}

const isFastener = (part: CatalogPart): boolean =>
  part.type === 'insert' || part.type === 'fastener';

/**
 * What one of these costs to print. Filament only: the catalogue still carries
 * the slicer's `minutes`, and the parts list deliberately does not report it —
 * a time is a property of the machine and the profile, not of the build, and
 * what the list is asked is what is LEFT to print (see `LayoutDoc.printed`).
 */
function estimateOf(part: CatalogPart): {
  grams: number;
  metres: number;
  supports: boolean;
} {
  const print = part.print;
  return {
    grams: finite(print?.grams),
    metres: finite(print?.metres),
    supports: print?.supports === true,
  };
}

/**
 * Is this part's footprint a bound rather than a measurement?
 *
 * `needsReview` is written by `tools/scan.py` and by the browser importer, but
 * it is not part of the `CatalogPart` contract, so it is read structurally and
 * anything other than an explicit `true` counts as measured.
 */
const needsReviewOf = (part: CatalogPart): boolean =>
  (part as unknown as { needsReview?: unknown }).needsReview === true;

/** Modelled print figures rather than a real slice. */
const isEstimated = (part: CatalogPart): boolean => part.print?.source === 'volume';

/**
 * Does this part take a screw into the WALL, as opposed to a bolt into another
 * printed part? Read from the hardware it asks for, not from its name.
 */
const isWallMount = (part: CatalogPart): boolean =>
  asArray(part.hardware).some((h) => /wall (screw|plug)/i.test(h?.item ?? ''));

/**
 * The catalogue's wall-mount fastener: the lightest one-cell insert that takes
 * a wall screw.
 *
 * The type check is load-bearing, not defensive. A PANEL may legitimately carry
 * `Wall plug` in its own hardware — that is the fallback `tools/scan.py` writes
 * when the catalogue has no countersunk insert to require — and without this,
 * the fixing plan picked the panel as its own fastener and multiplied the
 * panel's hardware by the fixing count. A test fixture caught it; a real
 * catalogue would have too, one panel at a time.
 */
function wallMountPart(index: ReadonlyMap<string, CatalogPart>): CatalogPart | undefined {
  let best: CatalogPart | undefined;
  for (const part of index.values()) {
    if (part.type !== 'insert' && part.type !== 'fastener') continue;
    if (!isWallMount(part)) continue;
    // One cell each, so the plan's cell count and the order agree. A two-cell
    // wall fastener would need the plan to reserve two cells per fixing.
    if (asArray(part.footprint).length > 1) continue;
    if (best === undefined || finite(part.print?.grams) < finite(best.print?.grams)) best = part;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Footprints
// ---------------------------------------------------------------------------

function dedupeCells(cells: Hex[]): Hex[] {
  const seen = new Set<string>();
  const out: Hex[] = [];
  for (const c of cells) {
    const key = hexKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * An EMPTY insert: one that is nothing but a socket.
 *
 * Derived, not listed: an insert or fastener that asks for no hardware takes no
 * bolt and no wall screw, so all it offers is the hexagonal socket a peg plugs
 * into. That is `insert-empty` and the whole hollow family, and it excludes
 * every M3/M4/M5 insert and every countersunk one — which is what "an empty
 * insert of any kind" means.
 */
export function isEmptyInsert(part: CatalogPart | undefined): boolean {
  if (part === undefined) return false;
  if (part.type !== 'insert' && part.type !== 'fastener') return false;
  return asArray(part.hardware).length === 0;
}

/** Does this part hang on a plain socket, rather than on a bolt or a screw? */
function mountsThroughSocket(
  part: CatalogPart | undefined,
  index: ReadonlyMap<string, CatalogPart>,
): boolean {
  return asArray(part?.requires).some((r) => r && isEmptyInsert(index.get(r.partId)));
}

/**
 * Which PLATES a parts-list line is talking about, by panel id.
 *
 * The answer is not "the panels with that partId", and that is the whole reason
 * this exists. A plate cut round a switch, sized for the printer, or carrying an
 * edge leaves the stock line and is reported on a generated one keyed
 * `custom/<shape>|<frame>` (D56, D66) — so a stock line means the plates that
 * are still the shipped file, and a custom line means one group of generated
 * ones. Splitting that rule between `computeBom` and whatever wants to
 * highlight them would let a click light up a plate the line does not count.
 *
 * Returns ids so a caller can match placements without re-deriving anything;
 * empty for an accessory line, which is answered by `doc.items` instead.
 */
export function panelsForLine(doc: LayoutDoc | undefined, partId: string): string[] {
  if (typeof partId !== 'string' || partId.length === 0) return [];
  const out: string[] = [];
  for (const [panelId, line] of panelLineKeys(doc)) if (line === partId) out.push(panelId);
  return out;
}

/**
 * The reverse, and the one that actually does the work: panel id -> the line it
 * is counted on.
 *
 * One walk of the assembly answers it for every plate, which matters because the
 * colour of every plate is looked up on every frame. It is also the only place
 * the stock-versus-generated split is decided, so `panelsForLine` and anything
 * colouring a plate cannot come to different conclusions about which line a
 * plate belongs to.
 */
export function panelLineKeys(doc: LayoutDoc | undefined): ReadonlyMap<string, string> {
  const panels = asArray(doc?.panels);
  const out = new Map<string, string>();
  if (panels.length === 0) return out;

  const frameKeys = new Map<string, string>();
  const frameKeyOf = (panel: PlacedPanel): string => {
    const seen = frameKeys.get(panel.id);
    if (seen !== undefined) return seen;
    const key = panelFrameKey(panel, panels, doc?.frame);
    frameKeys.set(panel.id, key);
    return key;
  };

  // The generated plates first, since a plate on one of those lines is exactly
  // a plate that is NOT on its own stock one.
  for (const group of customPanelGroups(panels, frameKeyOf)) {
    for (const panel of group.panels) out.set(panel.id, `custom/${group.key}`);
  }
  for (const panel of panels) {
    if (out.has(panel.id)) continue;
    if (isCustomPanel(panel) || frameKeyOf(panel) !== '') continue;
    out.set(panel.id, panel.partId);
  }
  return out;
}

/**
 * The fixing plan for a document, with the ONE reading of "occupied" that the
 * parts list and the 3D view must share.
 *
 * Two sets, because a cell can be busy in two different ways. Anything on a
 * cell keeps the spacing grid out of it — a wall screw needs a hole and a
 * screwdriver needs to reach it. But a part that mounts through a plain socket
 * sitting on a JUNCTION's socket cell is not in the way of anything: that
 * socket is what it is pegged into. Treating those the same made the wall mount
 * disappear the moment you hung a hook on one of its open holes (D48).
 */
export function fixingPlanFor(
  doc: LayoutDoc | undefined,
  catalog: Catalog,
  spacingMm?: number,
): FixingPlan {
  const index = partIndex(catalog);
  const avoid = new Set<string>();
  const shared = new Set<string>();
  for (const item of asArray(doc?.items)) {
    const part = index.get(item.partId);
    const pegged = mountsThroughSocket(part, index);
    for (const cell of itemCells(item, catalog)) {
      const key = hexKey(cell);
      avoid.add(key);
      if (pegged) shared.add(key);
    }
  }
  const junction = index.get(JUNCTION_FIXING_ID);
  const anchor = junction?.anchor ?? ORIGIN;
  const junctionSockets = socketsOf(junction).map((c) => hexSub(c, anchor));
  return fixingsFor(doc as LayoutDoc, spacingMm, avoid, { cells: shared, junctionSockets });
}

/** One requirement of one placed item, resolved into cells on the wall. */
export interface ItemFastening {
  /** The item that needs it. */
  itemId: string;
  /** That item's part — what the BOM counts against. */
  itemPartId: string;
  /** The fastener itself. */
  partId: string;
  /**
   * The item's own rotation, carried so a multi-cell fastener turns with the
   * part it holds — the cells it must span are the part's cells.
   */
  rotation: Rotation;
  /** Cells that get one installed: one instance anchored at each. */
  cells: Hex[];
  /** Cells where the wall already carries one, so nothing extra is printed. */
  supplied: Hex[];
}

/**
 * Where every placed accessory's OWN fastener goes.
 *
 * The wall drew the fixings that hold the PLATES up and nothing that holds the
 * things ON them: you could seat a hook against an insert in the alignment tool
 * and then find no insert under it in the big view. A fastening you cannot see
 * is one you cannot check, which is the same argument that put the wall fixings
 * in the picture in the first place.
 *
 * It is one plan for two consumers, deliberately. `computeBom` reads the
 * `supplied` cells to know what NOT to order and the 3D view reads `cells` to
 * know what to draw, so a fastener in the picture is a fastener on the list and
 * the reverse. Splitting them is how the wall mount once vanished from the plan
 * but stayed in the drawing (D48).
 *
 * INSERTS THE WALL ALREADY HAS. The combined wall fastener is one screw hole and
 * three open sockets, and those sockets ARE inserts: an accessory hung on one
 * does not also need an `insert-empty` printed for it. Only where somebody has
 * SAID the socket does that job (`socketProvides`) — two sockets being the same
 * size is not proof they are interchangeable, and this is a shopping list.
 * Sockets come from placed items and from the junction fixings at the seams,
 * which are in the wall whether or not anybody dropped one by hand. Each is
 * consumed at most once, in document order, so two accessories over the same
 * socket cannot both claim it.
 */
export function fasteningPlanFor(
  doc: LayoutDoc | undefined,
  catalog: Catalog,
  fixings: FixingPlan = fixingPlanFor(doc, catalog),
): ItemFastening[] {
  const index = partIndex(catalog);

  const socketAt = new Map<string, { provides: string; by: string }>();
  const noteSocket = (item: PlacedItem, provides: string): void => {
    for (const cell of itemSocketCells(item, catalog)) {
      const key = hexKey(cell);
      if (!socketAt.has(key)) socketAt.set(key, { provides, by: item.id });
    }
  };
  for (const item of asArray(doc?.items)) {
    const provides = socketProvidesOf(index.get(item.partId));
    if (provides !== undefined) noteSocket(item, provides);
  }
  const junctionPart = index.get(JUNCTION_FIXING_ID);
  const junctionProvides = socketProvidesOf(junctionPart);
  if (junctionPart !== undefined && junctionProvides !== undefined) {
    for (const [n, junction] of fixings.junctions.entries()) {
      // Through `itemSocketCells`, so a planned fixing and a placed one place
      // their sockets by the same transform.
      noteSocket(
        {
          id: `fixing/${n}`,
          partId: JUNCTION_FIXING_ID,
          at: junction.anchor,
          rotation: junction.rotation,
        },
        junctionProvides,
      );
    }
  }

  /**
   * Does a socket that provides `has` satisfy a part that asks for `wants`?
   *
   * The same id, obviously. And any EMPTY insert answers any other: they are
   * all just a hexagonal socket for a peg, so a part that asks for
   * `insert-empty` is as well served by the hollow family's socket as by its
   * own — which is what "an empty insert of any kind" means, and what a person
   * choosing a fastener in the inspector expects when they then hang the part
   * on a wall fastener's open hole.
   *
   * It is NOT symmetric with the bolted ones: an M3 bore answers only a part
   * that wants an M3 insert. A plain socket has no thread, and a part that
   * needs one still needs it.
   */
  const answers = (has: string, wants: string): boolean =>
    has === wants || (isEmptyInsert(index.get(has)) && isEmptyInsert(index.get(wants)));

  const out: ItemFastening[] = [];
  const spent = new Set<string>();
  for (const item of asArray(doc?.items)) {
    const part = index.get(item.partId);
    if (part === undefined) continue;
    const wants = asArray(part.requires);
    if (wants.length === 0) continue;
    const cells = itemCells(item, catalog);
    for (const req of wants) {
      const fastener = req && index.get(req.partId);
      if (!req || fastener === undefined) continue;
      let left = countOf(req.count);
      const supplied: Hex[] = [];
      for (const cell of cells) {
        if (left <= 0) break;
        const key = hexKey(cell);
        const socket = socketAt.get(key);
        // Never its own socket, and never one already claimed.
        if (socket === undefined || socket.by === item.id || spent.has(key)) continue;
        if (!answers(socket.provides, req.partId)) continue;
        spent.add(key);
        left -= 1;
        supplied.push(cell);
      }
      /*
       * The rest go in cells of this item that nothing is already in — nearest
       * its anchor first, by the same rule the alignment tool draws them with
       * (`fastenerCells`), so the insert a person seated their part against is
       * the insert that appears under it on the wall.
       */
      const anchor = fastener.anchor ?? ORIGIN;
      const spread = asArray(fastener.footprint).map((c) => hexSub(c, anchor));
      const placed = fastenerCells(
        cells, item.at ?? ORIGIN, spread, left, new Set(supplied.map(hexKey)),
      );
      if (placed.length === 0 && supplied.length === 0) continue;
      out.push({
        itemId: item.id,
        itemPartId: item.partId,
        partId: req.partId,
        rotation: item.rotation ?? 0,
        cells: placed,
        supplied,
      });
    }
  }
  return out;
}

/**
 * The cells a placed item actually covers on the wall.
 *
 * The footprint is stored as offsets from the part's anchor and normally has the
 * anchor at {0,0} (hex.ts rotates about the origin for exactly that reason). A
 * catalogue that nevertheless names a non-zero anchor is honoured by shifting the
 * footprint first, so the anchor is what lands on `item.at` and what the shape
 * rotates about either way.
 *
 * An unknown partId has no known footprint, so it covers nothing: it cannot be
 * off-panel and it cannot overlap. The missing part is reported once, by
 * `validate`, rather than as a cascade of geometry errors.
 */
export function itemCells(item: PlacedItem, catalog: Catalog): Hex[] {
  const part = partIndex(catalog).get(item.partId);
  if (part === undefined) return [];

  const footprint = asArray(part.footprint);
  const cells = footprint.length > 0 ? footprint : [ORIGIN];
  const anchor = part.anchor ?? ORIGIN;
  const local =
    anchor.q === 0 && anchor.r === 0 ? cells : cells.map((c) => hexSub(c, anchor));

  return dedupeCells(placeFootprint(local, item.at ?? ORIGIN, item.rotation));
}

/**
 * The cells of a placed item that something can be installed INTO — its
 * mounting positions, on the wall rather than in the part's own frame.
 *
 * Exactly `itemCells`'s transform applied to a different list, and deliberately
 * written as the same three steps: the anchor shift, the placement, the dedupe.
 * A socket that landed one cell from the part it belongs to would let an insert
 * be installed into solid material, and the two lists disagreeing is precisely
 * how `partCells` and `itemCells` once came apart.
 */
export function itemSocketCells(item: PlacedItem, catalog: Catalog): Hex[] {
  const part = partIndex(catalog).get(item.partId);
  if (part === undefined) return [];
  const sockets = socketsOf(part);
  if (sockets.length === 0) return [];

  const anchor = part.anchor ?? ORIGIN;
  const local =
    anchor.q === 0 && anchor.r === 0 ? sockets : sockets.map((c) => hexSub(c, anchor));

  return dedupeCells(placeFootprint(local, item.at ?? ORIGIN, item.rotation));
}

/** The cells a placed panel covers. The document's own columns/rows are authoritative. */
function panelCellsOf(panel: PlacedPanel): Hex[] {
  return placedPanelCells({
    origin: panel.origin ?? ORIGIN,
    columns: Math.floor(countOf(panel.columns)),
    rows: Math.floor(countOf(panel.rows)),
    omit: panel.omit,
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface Collision {
  a: string;
  b: string;
  cells: Hex[];
}

/** Every pair of ids that share at least one cell, with the cells they share. */
function collisions(occupants: Map<string, string[]>): Collision[] {
  const pairs = new Map<string, Map<string, Hex[]>>();

  for (const [key, ids] of occupants) {
    if (ids.length < 2) continue;
    const unique = [...new Set(ids)].sort(byString);
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const a = unique[i]!;
        const b = unique[j]!;
        let inner = pairs.get(a);
        if (inner === undefined) {
          inner = new Map<string, Hex[]>();
          pairs.set(a, inner);
        }
        const cells = inner.get(b);
        if (cells === undefined) inner.set(b, [keyToHex(key)]);
        else cells.push(keyToHex(key));
      }
    }
  }

  const out: Collision[] = [];
  for (const [a, inner] of pairs) {
    for (const [b, cells] of inner) out.push({ a, b, cells: cells.sort(byCell) });
  }
  return out.sort((x, y) => byString(x.a, y.a) || byString(x.b, y.b));
}

function occupancyOf(entries: { id: string; cells: Hex[] }[]): Map<string, string[]> {
  const occupants = new Map<string, string[]>();
  for (const entry of entries) {
    for (const cell of entry.cells) {
      const key = hexKey(cell);
      const ids = occupants.get(key);
      if (ids === undefined) occupants.set(key, [entry.id]);
      else ids.push(entry.id);
    }
  }
  return occupants;
}

/**
 * Everything wrong with the layout that this module can see.
 *
 * Seam detection itself belongs to the tiling module; this function calls it
 * rather than reimplementing it, so the warning a file raises on load and the
 * warning a drop raises in the editor are the same test.
 */
export function validate(doc: LayoutDoc, catalog: Catalog): Issue[] {
  const index = partIndex(catalog);
  const panels = asArray(doc?.panels);
  const items = asArray(doc?.items);
  const issues: Issue[] = [];

  // --- unknown-part -------------------------------------------------------
  // One issue per missing partId, listing every placement that wants it. Forty
  // copies of the same missing shelf is one problem, not forty.
  const unknown = new Map<string, Set<string>>();
  const noteUnknown = (partId: string, byId: string): void => {
    const label = typeof partId === 'string' ? partId : String(partId);
    const ids = unknown.get(label);
    if (ids === undefined) unknown.set(label, new Set([byId]));
    else ids.add(byId);
  };
  const scanRefs = (id: string, partId: string): void => {
    // A plate the app sized itself has no catalogue entry and never will —
    // that is what "generated" means. Reporting it as missing would put an
    // error on every plate of a wall tiled to the printer.
    if (isGeneratedSize(partId)) return;
    const part = index.get(partId);
    if (part === undefined) {
      noteUnknown(partId, id);
      return;
    }
    for (const req of asArray(part.requires)) {
      if (req && !index.has(req.partId)) noteUnknown(req.partId, id);
    }
  };
  for (const panel of panels) scanRefs(panel.id, panel.partId);
  for (const item of items) scanRefs(item.id, item.partId);

  for (const partId of [...unknown.keys()].sort(byString)) {
    const ids = [...(unknown.get(partId) ?? [])].sort(byString);
    issues.push({
      level: 'error',
      code: 'unknown-part',
      message: `Part "${partId}" is not in the catalogue (referenced by ${ids.length} placement${
        ids.length === 1 ? '' : 's'
      }). It contributes nothing to the BOM.`,
      itemIds: ids,
    });
  }

  // --- panel-overlap ------------------------------------------------------
  const panelFootprints = panels.map((panel) => ({ id: panel.id, cells: panelCellsOf(panel) }));
  for (const clash of collisions(occupancyOf(panelFootprints))) {
    issues.push({
      level: 'error',
      code: 'panel-overlap',
      message: `Panels "${clash.a}" and "${clash.b}" overlap on ${clash.cells.length} cell${
        clash.cells.length === 1 ? '' : 's'
      }.`,
      itemIds: [clash.a, clash.b],
      cells: clash.cells,
    });
  }

  // --- overlap ------------------------------------------------------------
  const itemFootprints = items.map((item) => ({ id: item.id, cells: itemCells(item, catalog) }));

  // Sharing a cell is only an ERROR when both things plug INTO it — there is
  // one hexagonal hole and one insert can sit in it. Accessories bolt onto an
  // insert and stand proud of the panel, and mounting things on top of one
  // another is what the system is for, so those overlaps are advisory.
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const plugsIn = (itemId: string): boolean => {
    const it = itemsById.get(itemId);
    const p = it ? catalog.parts.find((x) => x.id === it.partId) : undefined;
    return p !== undefined && (p.type === 'insert' || p.type === 'fastener');
  };

  /**
   * Cells one item OFFERS to another: its sockets, on the wall.
   *
   * The store lets a part be installed into one of these, so the validator has
   * to know about them too — otherwise the app accepts a drop and the parts list
   * immediately calls it an error, which is the exact split `partCells` and
   * `itemCells` were unified to prevent. It surfaced within a minute of the
   * store learning the rule: a junction insert, an insert dropped into one of
   * its three sockets, and a red panel saying only one part can occupy a cell.
   */
  const socketsById = new Map(items.map((i) => [i.id, itemSocketCells(i, catalog).map(hexKey)]));
  const hosts = (itemId: string, cells: readonly Hex[]): boolean => {
    const offered = socketsById.get(itemId);
    if (offered === undefined || offered.length === 0) return false;
    return cells.every((c) => offered.includes(hexKey(c)));
  };

  for (const clash of collisions(occupancyOf(itemFootprints))) {
    // Only the impossible case is reported. Two accessories sharing cells is
    // ordinary — they bolt on at different depths — and reporting it would put
    // a warning on the parts list for a layout that is perfectly fine.
    if (!plugsIn(clash.a) || !plugsIn(clash.b)) continue;
    // ...and neither is one thing installed INTO another's socket, which is a
    // mounting position doing its job.
    if (hosts(clash.a, clash.cells) || hosts(clash.b, clash.cells)) continue;
    const n = clash.cells.length;
    issues.push({
      level: 'error',
      code: 'overlap',
      message:
        `Two inserts share the same hole: "${clash.a}" and "${clash.b}" ` +
        `on ${n} cell${n === 1 ? '' : 's'}.`,
      itemIds: [clash.a, clash.b],
      cells: clash.cells,
    });
  }

  // --- off-panel ----------------------------------------------------------
  // Only meaningful once there is a panel: with none, every item is trivially
  // off-panel, and the one no-panel warning below says it better than N errors.
  if (panels.length > 0) {
    const covered = new Set<string>();
    for (const panel of panelFootprints) for (const cell of panel.cells) covered.add(hexKey(cell));

    for (const footprint of itemFootprints) {
      const outside = footprint.cells.filter((c) => !covered.has(hexKey(c))).sort(byCell);
      if (outside.length === 0) continue;
      issues.push({
        level: 'error',
        code: 'off-panel',
        message: `Item "${footprint.id}" sits on ${outside.length} cell${
          outside.length === 1 ? '' : 's'
        } that no panel covers.`,
        itemIds: [footprint.id],
        cells: outside,
      });
    }
  }

  // --- crosses-seam -------------------------------------------------------
  // The editor warns about this at drop time, which covers a layout you built
  // by hand and nothing else: a layout that arrived by file, by share link, or
  // by a wall resize that moved the panels under it was never advised at all.
  // Spanning a seam is legal — some inserts exist to do it — so it stays a
  // warning, one per item.
  if (panels.length > 1) {
    for (const footprint of itemFootprints) {
      if (footprint.cells.length < 2) continue;
      if (!crossesSeam(footprint.cells, panels)) continue;
      issues.push({
        level: 'warning',
        code: 'crosses-seam',
        message: `Item "${footprint.id}" spans the join between two panels.`,
        itemIds: [footprint.id],
        cells: [...footprint.cells].sort(byCell),
      });
    }
  }

  // --- no-panel -----------------------------------------------------------
  if (panels.length === 0 && items.length > 0) {
    issues.push({
      level: 'warning',
      code: 'no-panel',
      message: `The layout has ${items.length} item${
        items.length === 1 ? '' : 's'
      } but no panels to mount them on.`,
      itemIds: items.map((item) => item.id).sort(byString),
    });
  }

  // --- no-room-for-mounts -------------------------------------------------
  // A panel hangs on the wall through its own cells: a countersunk insert drops
  // into one and takes a wall screw. Fill every cell with accessories and there
  // is nowhere left to put one — a parts list that is correct about what to
  // print and silent about what cannot be built.
  //
  // The fixing planner routes around occupied cells, so the only panels left
  // are the ones with NO free cell at all. That is a much sharper warning than
  // the old free-cells-versus-a-quota arithmetic, and it comes from the same
  // plan that ordered the fixings, so the two cannot drift apart.
  const taken = new Set<string>();
  for (const footprint of itemFootprints) {
    for (const cell of footprint.cells) taken.add(hexKey(cell));
  }
  const fixings = fixingPlanFor(doc, catalog);
  for (const panelId of fixings.starvedPanelIds) {
    issues.push({
      level: 'warning',
      code: 'no-room-for-mounts',
      message:
        `Panel "${panelId}" has no free cell left for the fixing that holds it to the ` +
        `wall — accessories occupy all of them. Clear one cell, or fit its fixing first.`,
      itemIds: [panelId],
    });
  }
  /*
   * A different problem with the same symptom, and it needs its own words: the
   * planner DID give this plate a fixing and somebody took it out. Telling them
   * to clear a cell would be nonsense — the cells are clear, the fixing is gone.
   */
  for (const panelId of fixings.unfixedPanelIds) {
    issues.push({
      level: 'warning',
      code: 'panel-unfixed',
      message:
        `Panel "${panelId}" has no wall fixing left — the one holding it was removed. ` +
        `It hangs on its neighbours' interlock alone.`,
      itemIds: [panelId],
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// BOM
// ---------------------------------------------------------------------------

/**
 * The print list.
 *
 * Always returns a usable BOM: issues are reported alongside, and anything the
 * catalogue cannot explain is left out of the numbers rather than guessed at or
 * thrown over.
 */
export function computeBom(doc: LayoutDoc, catalog: Catalog): Bom {
  const index = partIndex(catalog);
  const issues = validate(doc, catalog);

  /**
   * Which border sides each plate touches, worked out ONCE.
   *
   * `panelFrameKey` walks the whole assembly to answer, and it is needed twice —
   * to keep a bordered plate out of the stock count, and to group the generated
   * plates — so asking per call would walk the wall twice per panel. Memoised on
   * the panel id, which is unique within a document.
   */
  const docPanels = asArray(doc?.panels);
  const frameKeys = new Map<string, string>();
  const frameKeyOf = (panel: PlacedPanel): string => {
    const seen = frameKeys.get(panel.id);
    if (seen !== undefined) return seen;
    const key = panelFrameKey(panel, docPanels, doc?.frame);
    frameKeys.set(panel.id, key);
    return key;
  };

  // How many times each partId was placed on the wall (panels and items alike).
  const placements = new Map<string, number>();
  const asPanel = new Map<string, number>();
  for (const panel of asArray(doc?.panels)) {
    // A panel cut round a light switch is NOT the stock plate any more, and
    // counting it as one would have you print 50 copies of a file when four of
    // them will not fit. Custom panels are reported on their own lines below.
    // A plate carrying an EDGE is not the stock file either, and it is reported
    // on its own generated line below. Counted here as well, a bordered wall
    // orders every plate twice — once as a shipped STL and once as a download.
    if (isCustomPanel(panel) || frameKeyOf(panel) !== '') continue;
    bump(placements, panel.partId, 1);
    bump(asPanel, panel.partId, 1);
  }
  for (const item of asArray(doc?.items)) bump(placements, item.partId, 1);

  // partId -> total physical count, placements plus rolled-up requirements.
  const quantities = new Map<string, number>();
  for (const [partId, times] of placements) {
    if (index.has(partId)) bump(quantities, partId, times);
  }

  /**
   * Wall fixings are a property of the ASSEMBLY, not of one plate.
   *
   * `tools/scan.py` writes `requires: insert-countersunk × (4 + cells/50)` onto
   * every panel part, and multiplying that by the number of plates gave 370
   * wall screws for a 2400 × 1200 wall — one every 88 mm. The panels interlock
   * and multi-cell inserts bridge the seams, so the sheet takes fixings at a
   * spacing, and `fixings.ts` decides where. A panel's own requirement for a
   * wall-mount fastener is therefore superseded here rather than expanded.
   *
   * Superseded only for panels placed AS PANELS. A panel part dropped as a
   * loose item is not part of the assembly the plan covers, so it keeps its own
   * declared requirement — otherwise its fixings would vanish entirely.
   *
   * A rescan will stop emitting the per-panel requirement (see the note in
   * tools/scan.py), at which point this becomes a no-op rather than a
   * correction.
   */
  const fixings = fixingPlanFor(doc, catalog);
  const isWallMountOf = (requiredId: string): boolean => {
    const required = index.get(requiredId);
    return (
      required !== undefined &&
      (required.type === 'fastener' || required.type === 'insert') &&
      isWallMount(required)
    );
  };

  // Where every accessory's own fastener goes, and which of them the wall
  // already carries — one plan, drawn by the 3D view and counted here.
  const fastenings = fasteningPlanFor(doc, catalog, fixings);

  /** partId -> requiredId -> how many the wall already provides. */
  const provided = new Map<string, Map<string, number>>();
  for (const f of fastenings) {
    if (f.supplied.length === 0) continue;
    const forPart = provided.get(f.itemPartId) ?? new Map<string, number>();
    forPart.set(f.partId, (forPart.get(f.partId) ?? 0) + f.supplied.length);
    provided.set(f.itemPartId, forPart);
  }
  /** How many of each insert the wall provided, for the lines to say so. */
  const providedTotals = new Map<string, number>();

  for (const [partId, times] of placements) {
    const part = index.get(partId);
    if (part === undefined) continue;
    // Placements of this part that the fixing plan already covers.
    const covered = part.type === 'panel' ? countOf(asPanel.get(partId)) : 0;
    const expand = times - covered;
    for (const req of asArray(part.requires)) {
      if (!req || !index.has(req.partId)) continue;
      const uses = isWallMountOf(req.partId) ? expand : times;
      const already = provided.get(partId)?.get(req.partId) ?? 0;
      const needed = countOf(req.count) * uses - already;
      if (already > 0) {
        providedTotals.set(req.partId, (providedTotals.get(req.partId) ?? 0) + already);
      }
      if (needed > 0) bump(quantities, req.partId, needed);
    }
  }

  // ...and the plan's own fixings go in once, for the whole wall.
  if (fixings.cells.length > 0) {
    const mount = wallMountPart(index);
    if (mount !== undefined) bump(quantities, mount.id, fixings.cells.length);
  }
  /**
   * Junctions get the four-cell countersunk insert, not four single-cell ones.
   *
   * HSW-SPEC §4: the panels have no screw holes of their own, and a multi-cell
   * insert straddling the join is what holds them to each other as well as to
   * the wall. Four separate fixings, one per plate, fix each plate and leave
   * the join itself unsupported.
   */
  if (fixings.junctions.length > 0 && index.has(JUNCTION_FIXING_ID)) {
    bump(quantities, JUNCTION_FIXING_ID, fixings.junctions.length);
  }

  // Bought hardware, from every part in the BOM — including the inserts that
  // only got there via someone else's requires[].
  const shoppingTotals = new Map<string, number>();
  for (const [partId, quantity] of quantities) {
    const part = index.get(partId);
    if (part === undefined) continue;
    for (const hw of asArray(part.hardware)) {
      if (!hw || typeof hw.item !== 'string' || hw.item.length === 0) continue;
      const needed = countOf(hw.count) * quantity;
      if (needed > 0) bump(shoppingTotals, hw.item, needed);
    }
  }

  // Lines. Unrounded running totals; rounding happens once, below.
  const printed: BomLine[] = [];
  const fasteners: BomLine[] = [];
  const progress = doc?.printed;
  let totalParts = 0;
  let totalPrinted = 0;
  let totalGrams = 0;
  let totalMetres = 0;

  for (const [partId, quantity] of quantities) {
    const part = index.get(partId);
    if (part === undefined || quantity <= 0) continue;
    const est = estimateOf(part);
    const done = printedOf(progress, partId, quantity);

    totalParts += quantity;
    totalPrinted += done.printed;
    totalGrams += est.grams * quantity;
    totalMetres += est.metres * quantity;

    const line: BomLine = {
      partId,
      name: part.name ?? partId,
      file: part.file ?? '',
      type: part.type ?? 'unknown',
      quantity,
      printed: done.printed,
      toPrint: done.toPrint,
      grams: roundGrams(est.grams * quantity),
      metres: roundMetres(est.metres * quantity),
      // Per-unit figures come from the catalogue, never from total ÷ quantity:
      // that division reads back a number that has already been rounded.
      gramsEach: roundGrams(est.grams),
      metresEach: roundMetres(est.metres),
      supports: est.supports,
      // The line's own colour: what this gets printed in, if anything was said.
      // Through `colorOfLine`, so the sheet and the wall cannot disagree about
      // which of the four levels applies.
      ...(lineColor(doc?.colors, partId, part.type === 'panel') !== undefined
        ? { color: lineColor(doc?.colors, partId, part.type === 'panel') }
        : {}),
      needsReview: needsReviewOf(part),
      estimated: isEstimated(part),
      fastenersUnknown: fastenersNeedReview(part),
      providedBySockets: providedTotals.get(partId) ?? 0,
    };
    (isFastener(part) ? fasteners : printed).push(line);
  }

  /**
   * Custom panels: the same block with cells cut out, generated rather than
   * printed from a shipped STL.
   *
   * The print estimate is the stock plate's, scaled by the fraction of cells
   * that survive. That is a model, not a slice — a hole removes plate as well as
   * a bore, so the true saving is slightly larger — and it is marked estimated
   * like every other modelled figure.
   */
  // Keyed on the frame as well as the shape, or two plates that differ only in
  // which edge is bordered collapse into one line here while the panel that
  // offers the downloads lists them separately — and you print one twice and
  // the other never. Same rule, one function, both callers.
  const panels = docPanels;
  const frame = doc?.frame;
  const groups = customPanelGroups(panels, frameKeyOf);
  // The reference a generated plate is costed against: the biggest shipped
  // plate, per cell. A plate the app sized itself has no catalogue entry to
  // scale from, and left at zero it would report a wall that prints in no time
  // out of no filament — which is worse than an estimate, because it looks like
  // an answer. Every cell of every plate is the same 8 mm block with the same
  // bore, so per-cell is the honest unit, and the line is marked `estimated`
  // like every other modelled figure.
  const reference = biggestPanel(index);
  const refCells = Math.max(1, asArray(reference?.footprint).length);
  const refEst = reference
    ? estimateOf(reference)
    : { grams: 0, metres: 0, supports: false };

  for (const [index_, group] of groups.entries()) {
    const first = group.panels[0]!;
    const stock = index.get(first.partId);
    /*
     * The plate's OWN cells, counted here rather than asked of the customiser.
     *
     * It used to read `group.params?.cellCount`, falling back to the stock
     * file's footprint. Both arms are absent for a big generated plate:
     * `toCustomiserPanel` returns null above 13 × 12 (the customiser's own
     * limit) and a `generated/…` id has no catalogue entry by design (D61) — so
     * `kept` fell through to 1, and an 18 × 13 plate was reported as "1 cells"
     * and costed at 5.1 g of filament instead of 234 cells and 4 kg. It needed
     * a bed big enough to make plates the customiser cannot express, which is
     * why a 256 mm printer never showed it and a 400 mm one always did.
     *
     * `params.cellCount` was only ever `placedPanelCells(panel).length` anyway —
     * `customPanelGroups` builds the parameters from exactly those cells.
     */
    const kept = Math.max(1, placedPanelCells(first).length);

    // Scale from the plate's OWN stock file where there is one, and from the
    // reference where there is not.
    const base = stock ?? reference;
    const baseCells = stock ? Math.max(1, asArray(stock.footprint).length) : refCells;
    const est = stock ? estimateOf(stock) : refEst;
    const share = base ? kept / baseCells : 0;
    const quantity = group.panels.length;
    const label = `Custom panel ${String.fromCharCode(65 + index_)}`;
    // Keyed on the group's KEY, which is the plate's shape and its edge — not on
    // the letter, which is a position in this list and changes the moment
    // another custom plate appears. Re-solve a wall and the plates you have
    // already printed are still the same plates.
    const partId = `custom/${group.key}`;
    const done = printedOf(progress, partId, quantity);

    totalParts += quantity;
    totalPrinted += done.printed;
    totalGrams += est.grams * share * quantity;
    totalMetres += est.metres * share * quantity;

    /*
     * Say WHY it is custom. "Cut round an obstacle" on a plate that has no
     * obstacle near it sends someone hunting the wall for a switch that is not
     * there — which is what `omit` alone now says, because the EDGE cuts too
     * (D86) and every bordered plate has a ring in `omit`. The two reasons share
     * one field and have to be told apart by asking which cells the edge took.
     */
    const sides = panelFrameSides(first, panels, frame);
    const edged = (['top', 'bottom', 'left', 'right'] as const).filter((s) => sides[s]);
    if (sides.holes) edged.push('holes' as never);
    const byEdge = borderCutCells(panels, frame);
    const byZone = (first.omit ?? []).filter((c) => !byEdge.has(hexKey(c)));
    const reasons: string[] = [];
    if (edged.length > 0) reasons.push(`edged ${edged.join(' + ')}`);
    if (byZone.length > 0) reasons.push('cut round an obstacle');
    if (isGeneratedSize(first.partId)) reasons.push('sized for your printer');
    const why = reasons.length > 0 ? reasons.join(', ') : 'generated';

    printed.push({
      partId,
      name: `${label} — ${kept} cells, ${why}`,
      file: '',
      type: 'panel',
      quantity,
      printed: done.printed,
      toPrint: done.toPrint,
      grams: roundGrams(est.grams * share * quantity),
      metres: roundMetres(est.metres * share * quantity),
      gramsEach: roundGrams(est.grams * share),
      metresEach: roundMetres(est.metres * share),
      supports: est.supports,
      ...(lineColor(doc?.colors, partId, true) !== undefined
        ? { color: lineColor(doc?.colors, partId, true) }
        : {}),
      needsReview: false,
      estimated: true,
      fastenersUnknown: false,
      providedBySockets: 0,
    });
  }

  const byNameThenId = (a: BomLine, b: BomLine): number =>
    byString(a.name, b.name) || byString(a.partId, b.partId);
  printed.sort(byNameThenId);
  fasteners.sort(byNameThenId);

  const shopping = [...shoppingTotals.entries()]
    .map(([item, count]) => ({ item, count }))
    .sort((a, b) => byString(a.item, b.item));

  return {
    printed,
    fasteners,
    shopping,
    totals: {
      parts: totalParts,
      printed: totalPrinted,
      toPrint: Math.max(0, totalParts - totalPrinted),
      grams: roundGrams(totalGrams),
      metres: roundMetres(totalMetres),
      distinctParts: printed.length + fasteners.length,
    },
    fixings: {
      count: fixings.cells.length + fixings.junctions.length,
      junctions: fixings.junctions.length,
      spacingMm: fixings.spacingMm,
      perSquareMetre: roundTo(fixings.perSquareMetre, 1),
      starvedPanelIds: fixings.starvedPanelIds,
    },
    issues,
  };
}
