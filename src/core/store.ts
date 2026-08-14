/**
 * Editor state, commands, and undo/redo.
 *
 * The document is immutable and every command returns a new one, which makes
 * undo a list of snapshots rather than a reconstruction problem. Snapshots are
 * cheap here — even a full garage wall is ~60 panels and a few hundred items —
 * and a snapshot cannot drift out of sync with an inverse operation the way a
 * hand-written undo command can.
 *
 * Selection travels WITH the snapshot. "Undo restores exactly" has to include
 * what was selected, or undoing a group drag leaves you holding nothing.
 */

import { computeBom, fixingPlanFor, itemCells, itemSocketCells, validate } from './bom';
import { bedFor, clampBedMm, CUSTOM_BED_ID } from './constants';
import { hasColors, normaliseColor } from './colors';
import { hexKey, hexRotate, panelCells, placedPanelCells, placeFootprint } from './hex';
import { obstructedCells } from './obstacles';
import { borderCutCells, frameIsOn } from './panelModel';
import { placementsOf, withPartAdded, withPartRemoved, withPartsAdded } from './projectParts';
import { crossesSeam } from './tiling';
import type { FixingPlan } from './fixings';
import type {
  Bom,
  Catalog,
  CatalogPart,
  FixingEdits,
  Hex,
  Issue,
  LayoutDoc,
  PlacedItem,
  Rotation,
  WallColors,
  WallFrame,
  WallPhoto,
} from './types';

export interface Snapshot {
  doc: LayoutDoc;
  selection: string[];
}

export interface EditorState extends Snapshot {
  /** Human-readable label of the action that produced this state. */
  lastAction: string;
  canUndo: boolean;
  canRedo: boolean;
}

export interface DropResult {
  ok: boolean;
  /** Why the drop was refused — shown to the user, never swallowed. */
  reason?: string;
  /** Cells that caused the refusal, so the canvas can highlight them. */
  blockedCells?: readonly Hex[];
  /** Non-blocking advisories, e.g. crossing a panel seam. */
  warnings?: string[];
}

const HISTORY_LIMIT = 200;

let idCounter = 0;
/** Monotonic ids. Not random: a deterministic id keeps tests and diffs stable. */
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${idCounter.toString(36)}`;
}

/** Reset the id counter — tests only, so ids don't leak between cases. */
export function __resetIds(): void {
  idCounter = 0;
}

/** The printer a new layout starts on, and the seed for a custom bed. */
export const DEFAULT_BED_ID = 'bed256';

export function emptyDoc(): LayoutDoc {
  return {
    schemaVersion: 1,
    id: 'layout',
    name: 'Untitled wall',
    wall: { widthMm: 2400, heightMm: 1200 },
    bedId: DEFAULT_BED_ID,
    panels: [],
    items: [],
    groups: [],
  };
}

// ---------------------------------------------------------------------------

type Listener = (s: EditorState) => void;

export class Store {
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private current: Snapshot;
  private label = 'Opened';
  private listeners = new Set<Listener>();

  constructor(doc: LayoutDoc, private catalogRef: Catalog) {
    this.current = { doc, selection: [] };
  }

  get catalog(): Catalog {
    return this.catalogRef;
  }

  /**
   * Swap in a wider catalogue — the user imported a part.
   *
   * Deliberately NOT an undo step: the catalogue is not part of the document.
   * Undoing a placement must not un-import the part it used, and importing must
   * not clear the redo stack. The two histories are separate, which is why this
   * assigns and emits rather than committing.
   */
  setCatalog(next: Catalog): void {
    if (next === this.catalogRef) return;
    this.catalogRef = next;
    this.emit();
  }

  getState(): EditorState {
    return {
      doc: this.current.doc,
      selection: this.current.selection,
      lastAction: this.label,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const s = this.getState();
    for (const fn of this.listeners) fn(s);
  }

  /** Apply a change and push the previous state onto the undo stack. */
  private commit(label: string, next: Snapshot): void {
    this.past.push(this.current);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this.current = next;
    this.label = label;
    this.emit();
  }

  /** Selection-only change: visible, but not worth an undo step of its own. */
  private touch(selection: string[]): void {
    this.current = { doc: this.current.doc, selection };
    this.emit();
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.current);
    this.current = prev;
    this.label = 'Undo';
    this.emit();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.current);
    this.current = next;
    this.label = 'Redo';
    this.emit();
  }

  // -- queries -------------------------------------------------------------

  part(partId: string): CatalogPart | undefined {
    return this.catalog.parts.find((p) => p.id === partId);
  }

  bom(): Bom {
    return computeBom(this.current.doc, this.catalog);
  }

  issues(): Issue[] {
    return validate(this.current.doc, this.catalog);
  }

  /**
   * cell -> item id for every placed item. Cached on the identity of the items
   * array and of the catalogue, both of which are immutable, so the cache can
   * never serve a stale answer.
   *
   * `checkPlacement` runs on every pointer move of every drag, and it used to
   * rebuild this from scratch each time: 0.039 ms per item at 200 items and
   * 0.216 ms at 2000, i.e. the cost per item grew with the number of items.
   * Building it once per document state makes a drag O(footprint) again.
   */
  private occupancyCache: {
    items: LayoutDoc['items'];
    catalog: Catalog;
    map: Map<string, string>;
    /**
     * cell -> every item IN that hole, in placement order.
     *
     * A second index, and it has to be one. `map` keeps a single id per cell, so
     * the last item placed wins — and an accessory hung over an insert therefore
     * HID it from the one-insert-per-hole check: drop a hook on a cell and the
     * cell would take a second insert as if it were empty. A list, and only of
     * the things that go into the hole, is what the rule was always describing.
     */
    plugs: Map<string, string[]>;
  } | null = null;

  private occupancyIndex(): ReadonlyMap<string, string> {
    return this.indices().map;
  }

  /** cell -> the items plugged into it, innermost first. */
  private plugIndex(): ReadonlyMap<string, string[]> {
    return this.indices().plugs;
  }

  private indices(): { map: Map<string, string>; plugs: Map<string, string[]> } {
    const items = this.current.doc.items;
    const cache = this.occupancyCache;
    if (cache && cache.items === items && cache.catalog === this.catalogRef) return cache;

    const map = new Map<string, string>();
    const plugs = new Map<string, string[]>();
    for (const item of items) {
      for (const c of itemCells(item, this.catalogRef)) map.set(hexKey(c), item.id);
      addPlugs(plugs, item, this.catalogRef);
    }
    const built = { items, catalog: this.catalogRef, map, plugs };
    this.occupancyCache = built;
    return built;
  }

  /**
   * Carry the index forward across an append, instead of rebuilding it.
   *
   * Every command replaces the items array, so a cache keyed on that array's
   * identity is invalidated by each placement — which makes placing n items
   * cost O(n²) even with the cache. Adding is the only bulk path that matters
   * (a paste, a duplicate, a scripted fill), and an append only ever adds
   * cells, so it can be applied to the existing map directly. Everything else
   * — move, delete, rotate, undo — lets the cache miss and rebuild once.
   */
  private extendOccupancy(items: LayoutDoc['items'], added: readonly PlacedItem[]): void {
    const cache = this.occupancyCache;
    if (!cache || cache.catalog !== this.catalogRef) return;
    for (const item of added) {
      for (const c of itemCells(item, this.catalogRef)) cache.map.set(hexKey(c), item.id);
      addPlugs(cache.plugs, item, this.catalogRef);
    }
    cache.items = items;
  }

  /**
   * Cells covered by every item except the ones named — the collision set.
   *
   * Kept as a public query returning a fresh Map, because callers outside this
   * class treat it as theirs. The shared index above is what makes it cheap.
   */
  occupiedCells(exclude: ReadonlySet<string> = new Set()): Map<string, string> {
    const map = new Map<string, string>();
    for (const [cell, id] of this.occupancyIndex()) {
      if (exclude.has(id)) continue;
      map.set(cell, id);
    }
    return map;
  }

  /**
   * Cells covered by any panel — anything outside this is off-wall.
   *
   * Cached on the identity of the panels array. This is consulted on every
   * pointer move during a drag, and rebuilding 5,800 keys sixty times a second
   * is exactly the sort of quiet cost that turns a drag into a slideshow. The
   * document is immutable, so array identity is a sound cache key.
   */
  private panelSetCache: { panels: LayoutDoc['panels']; set: Set<string> } | null = null;

  panelCellSet(): Set<string> {
    const panels = this.current.doc.panels;
    if (this.panelSetCache && this.panelSetCache.panels === panels) {
      return this.panelSetCache.set;
    }
    const set = new Set<string>();
    for (const p of panels) {
      // Reuse the same generator the tiler used, so the two can never disagree.
      for (const c of placedPanelCells(p)) set.add(hexKey(c));
    }
    this.panelSetCache = { panels, set };
    return set;
  }

  // -- validation ----------------------------------------------------------

  /**
   * Can this footprint go here? Answers with a REASON, always.
   *
   * Overlap is refused at drop time rather than allowed and discovered later —
   * the whole value of the app is that the parts list matches reality.
   */
  checkPlacement(
    cells: readonly Hex[],
    ignoreIds: ReadonlySet<string> = new Set(),
    exclusiveCells: ReadonlySet<string> = new Set(),
  ): DropResult {
    // The shared index, read directly: a drag asks this question on every
    // pointer move, and copying the whole map first just to skip a handful of
    // ids would put the O(items) cost straight back.
    const index = this.occupancyIndex();
    const occupied = {
      get: (key: string): string | undefined => {
        const id = index.get(key);
        return id !== undefined && ignoreIds.has(id) ? undefined : id;
      },
    };
    const overlapping: Hex[] = [];
    const clashing: Hex[] = [];
    let overlapName = '';
    let clashName = '';
    let clashReason = 'one insert per hole';

    const plugs = this.plugIndex();
    for (const c of cells) {
      const key = hexKey(c);
      const other = occupied.get(key);

      /*
       * Two things that plug INTO a cell cannot share it — there is one hole.
       * Anything else is mounted ON the wall and simply stands in front of what
       * is behind it, which is how the system is meant to be used.
       *
       * Unless the thing already there OFFERS the hole. `insert-for-countersunk-
       * hole-3` spans four cells, ties four plates together and takes one wall
       * screw; three of those cells are open 13.2 mm sockets, measured. Refusing
       * everything in them treated a mounting position as solid material. So a
       * lone occupant with a free socket at this cell is not a clash, it is what
       * you install INTO — and once something is in it, the socket is full and
       * the next one is refused as before.
       */
      if (exclusiveCells.has(key)) {
        const inHole = (plugs.get(key) ?? []).filter((id) => !ignoreIds.has(id));
        if (inHole.length > 0) {
          const host = this.current.doc.items.find((i) => i.id === inHole[0]);
          const hostPart = host ? this.part(host.partId) : undefined;
          const socket = host !== undefined
            && itemSocketCells(host, this.catalogRef).some((s) => hexKey(s) === key);
          if (socket && inHole.length === 1) continue;   // an install, not a clash
          clashing.push(c);
          if (!clashName) {
            const blockerId = socket ? inHole[inHole.length - 1] : inHole[0];
            const blocker = this.current.doc.items.find((i) => i.id === blockerId);
            clashName = (blocker ? this.part(blocker.partId)?.name : hostPart?.name)
              ?? 'another item';
            if (socket) clashReason = 'that socket is already taken';
          }
          continue;
        }
      }

      if (other === undefined) continue;
      const it = this.current.doc.items.find((i) => i.id === other);
      const p = it ? this.part(it.partId) : undefined;
      overlapping.push(c);
      if (!overlapName) overlapName = p?.name ?? 'another item';
    }

    if (clashing.length > 0) {
      return {
        ok: false,
        reason: `${clashName} already fills ${clashing.length === 1 ? 'that cell' : `${clashing.length} of those cells`} — ${clashReason}`,
        blockedCells: clashing,
      };
    }

    // No warning for a plain overlap. Mounting things on top of each other is
    // what the wall is FOR, so flagging it would cry wolf on every second drop
    // and bury the advisories that do matter. `overlapName` is kept for the
    // error path above, which is the case that is genuinely impossible.
    void overlapName;
    void overlapping;
    const warnings: string[] = [];
    const panelCells = this.panelCellSet();
    if (panelCells.size > 0) {
      const outside = cells.filter((c) => !panelCells.has(hexKey(c)));
      if (outside.length === cells.length) {
        return { ok: false, reason: 'Off the wall — no panel underneath', blockedCells: cells };
      }
      if (outside.length > 0) {
        return {
          ok: false,
          reason: `Hangs off the panel edge — ${outside.length} cell${outside.length > 1 ? 's' : ''} unsupported`,
          blockedCells: outside,
        };
      }
      if (crossesSeam(cells, this.current.doc.panels)) {
        warnings.push('Spans a panel seam — fine if the panels are joined, but check it');
      }
    }
    return { ok: true, warnings };
  }

  // -- commands ------------------------------------------------------------

  setWall(widthMm: number, heightMm: number): void {
    const w = clampDim(widthMm);
    const h = clampDim(heightMm);
    this.commit('Resize wall', {
      doc: { ...this.current.doc, wall: { widthMm: w, heightMm: h } },
      selection: this.current.selection,
    });
  }

  /**
   * Choose a printer.
   *
   * Picking `custom` SEEDS the typed size from the bed that was chosen before,
   * so the fields open on a real printer's numbers rather than on nothing — and
   * so a person who only wants to widen their bed by 20 mm does not have to type
   * both numbers from scratch. An existing custom size is kept.
   *
   * Switching back to a preset keeps `customBed` too: it is remembered, not
   * discarded, so flipping between "my printer" and "a Mini" is not destructive.
   * A document that has never had one still serialises without the key.
   */
  setBed(bedId: string): void {
    const doc = this.current.doc;
    const seed = bedFor(doc.bedId, doc.customBed) ?? bedFor(DEFAULT_BED_ID);
    const next: LayoutDoc = bedId === CUSTOM_BED_ID && doc.customBed === undefined && seed
      ? { ...doc, bedId, customBed: { widthMm: seed.width, depthMm: seed.depth } }
      : { ...doc, bedId };
    this.commit('Change printer', { doc: next, selection: this.current.selection });
  }

  /**
   * The typed build plate. Clamped, like the wall, by whoever owns the clamp.
   *
   * Setting a size implies choosing the custom printer: the fields only exist
   * while it is chosen, and a size that did not take effect would be a control
   * that does nothing.
   */
  setCustomBed(widthMm: number, depthMm: number): void {
    this.commit('Change build plate', {
      doc: {
        ...this.current.doc,
        bedId: CUSTOM_BED_ID,
        customBed: { widthMm: clampBedMm(widthMm), depthMm: clampBedMm(depthMm) },
      },
      selection: this.current.selection,
    });
  }

  setName(name: string): void {
    this.commit('Rename', {
      doc: { ...this.current.doc, name },
      selection: this.current.selection,
    });
  }

  setPanels(panels: LayoutDoc['panels'], label = 'Lay out panels'): void {
    const doc = this.current.doc;
    this.commit(label, {
      doc: { ...doc, panels: cutAroundObstacles(panels, doc.obstacles, doc.frame) },
      selection: this.current.selection,
    });
  }

  /**
   * Switches, sockets and pipes the wall has to go round.
   *
   * Re-cuts the panels immediately: an obstacle you add after solving has to
   * take effect without pressing Solve again, or the wall on screen is a lie.
   */
  setObstacles(obstacles: LayoutDoc['obstacles'], label = 'Change obstacles'): void {
    const doc = this.current.doc;
    this.commit(label, {
      doc: {
        ...doc,
        obstacles,
        panels: cutAroundObstacles(doc.panels, obstacles, doc.frame),
      },
      selection: this.current.selection,
    });
  }

  /**
   * Put an edge round the wall, or take it off.
   *
   * Does NOT re-cut the panels, and that is the point: this border is additive,
   * so every cell stays where it was and anything already mounted stays mounted.
   * The plates change shape — they are generated rather than stock now — but the
   * layout on top of them is untouched.
   */
  setFrame(frame: WallFrame | undefined, label = 'Change border'): void {
    const doc = this.current.doc;
    const next: LayoutDoc = frameIsOn(frame)
      ? { ...doc, frame: frame as WallFrame }
      : (() => {
          const { frame: _drop, ...rest } = doc;
          return rest as LayoutDoc;
        })();
    // The edge CUTS (D86), so changing it changes which cells the wall has.
    // Re-cut here or the plates on screen keep a ring the plate no longer prints.
    this.commit(label, {
      doc: { ...next, panels: cutAroundObstacles(next.panels, next.obstacles, next.frame) },
      selection: this.current.selection,
    });
  }

  /**
   * The photograph laid under the plan, or none.
   *
   * An ordinary undoable edit, like everything else on the document — which is
   * the reason the alignment lives there rather than in component state. You
   * calibrate a photo once, drag a dozen zones onto it, and the one thing that
   * must not happen is losing the calibration to a stray drag with no way back.
   *
   * Cuts nothing. A photo is a reference, not an obstruction: it changes where
   * you decide to put a zone, and never what the honeycomb does.
   */
  setPhoto(photo: WallPhoto | undefined, label = 'Change wall photo'): void {
    const doc = this.current.doc;
    const next: LayoutDoc = photo
      ? { ...doc, photo }
      : (() => {
          // Deleted, not set to undefined: an absent key has to round-trip to an
          // absent key, and `{photo: undefined}` serialises as neither.
          const { photo: _drop, ...rest } = doc;
          return rest as LayoutDoc;
        })();
    this.commit(label, { doc: next, selection: this.current.selection });
  }

  // --- colours ---------------------------------------------------------------

  /**
   * The default colour for the plates, or for everything that clips into them.
   *
   * `undefined` REMOVES it — back to the theme's own tone — rather than storing
   * a colour that happens to look like the default. The distinction is real: a
   * layout with no colours is a layout somebody has not made that decision
   * about, and it stays that way through a save and a reload.
   */
  setDefaultColor(kind: 'panels' | 'parts', color: string | undefined, label?: string): void {
    const colour = color === undefined ? undefined : normaliseColor(color);
    if (color !== undefined && colour === undefined) return;
    const doc = this.current.doc;
    if ((doc.colors?.[kind] ?? undefined) === colour) return;
    const next: WallColors = { ...doc.colors };
    if (colour === undefined) delete next[kind];
    else next[kind] = colour;
    this.commit(
      label ?? (colour === undefined ? 'Clear colour' : 'Change colour'),
      { doc: withColors(doc, next), selection: this.current.selection },
    );
  }

  /**
   * Colour everything on one parts-list line — every plate of that shape, or
   * every placement of that part. Keyed by the line, which is what the list
   * shows and what gets printed together.
   */
  setLineColor(lineKey: string, color: string | undefined, label = 'Colour parts'): void {
    if (typeof lineKey !== 'string' || lineKey.length === 0) return;
    const colour = color === undefined ? undefined : normaliseColor(color);
    if (color !== undefined && colour === undefined) return;
    const doc = this.current.doc;
    if ((doc.colors?.lines?.[lineKey] ?? undefined) === colour) return;
    const lines = { ...(doc.colors?.lines ?? {}) };
    if (colour === undefined) delete lines[lineKey];
    else lines[lineKey] = colour;
    this.commit(label, {
      doc: withColors(doc, { ...doc.colors, lines }),
      selection: this.current.selection,
    });
  }

  /**
   * Colour the placed items themselves — this hook, not every hook.
   *
   * Takes a LIST because that is how the wall is used: you select three bins and
   * paint them, and it costs one undo step rather than three. Unknown ids are
   * ignored rather than stored, or deleting an item would leave its colour
   * behind for ever.
   */
  setItemColor(itemIds: readonly string[], color: string | undefined, label = 'Colour parts'): void {
    const colour = color === undefined ? undefined : normaliseColor(color);
    if (color !== undefined && colour === undefined) return;
    const doc = this.current.doc;
    const known = new Set(doc.items.map((i) => i.id));
    const ids = [...new Set(itemIds)].filter((id) => known.has(id));
    if (ids.length === 0) return;

    const items = { ...(doc.colors?.items ?? {}) };
    let changed = false;
    for (const id of ids) {
      if ((items[id] ?? undefined) === colour) continue;
      if (colour === undefined) delete items[id];
      else items[id] = colour;
      changed = true;
    }
    if (!changed) return;
    this.commit(label, {
      doc: withColors(doc, { ...doc.colors, items }),
      selection: this.current.selection,
    });
  }

  /** Every colour back to the theme's. */
  clearColors(label = 'Clear colours'): void {
    if (!hasColors(this.current.doc.colors)) return;
    this.commit(label, {
      doc: withColors(this.current.doc, {}),
      selection: this.current.selection,
    });
  }

  // --- the wall fixings, by hand -------------------------------------------

  /**
   * The fixing plan as it stands, edits included — the one the wall draws and
   * the one the parts list orders.
   *
   * Through `bom.fixingPlanFor`, never through a second reading of which cells
   * are free: two readings put a fixing in the picture that is not on the list,
   * which is the failure D48 and D53 are both about.
   */
  fixingPlan(): FixingPlan {
    return fixingPlanFor(this.current.doc, this.catalogRef);
  }

  /**
   * Take a planned fixing out.
   *
   * `at` is the cell for a single fixing, or the ANCHOR for a junction. A
   * fixing the USER added is forgotten rather than recorded as a removal —
   * otherwise adding one and taking it away again leaves two entries that
   * cancel, and a document that is not equal to the one you started with.
   */
  removeFixing(at: Hex, label = 'Remove wall fixing'): DropResult {
    const plan = this.fixingPlan();
    const key = hexKey(at);
    const isSingle = plan.cells.some((c) => hexKey(c) === key);
    const isJunction = plan.junctions.some((j) => hexKey(j.anchor) === key);
    if (!isSingle && !isJunction) {
      return { ok: false, reason: 'There is no wall fixing there.' };
    }

    const edits = this.current.doc.fixingEdits;
    if (plan.manual.has(key)) {
      const added = (edits?.added ?? []).filter((c) => hexKey(c) !== key);
      this.commit(label, {
        doc: withFixingEdits(this.current.doc, { ...edits, added }),
        selection: this.current.selection,
      });
      return { ok: true };
    }

    const removed = [...(edits?.removed ?? []), { q: at.q, r: at.r }];
    this.commit(label, {
      doc: withFixingEdits(this.current.doc, { ...edits, removed }),
      selection: this.current.selection,
    });
    return { ok: true };
  }

  /**
   * Put a fixing in a cell yourself.
   *
   * Refused off the plates, and refused where another fixing already is — one
   * screw per hole. NOT refused where an accessory sits: overlap is allowed
   * everywhere else in this app, the planner keeps clear of accessories because
   * it is guessing at a screwdriver's reach, and someone pointing at a cell is
   * not guessing.
   */
  addFixing(at: Hex, label = 'Add wall fixing'): DropResult {
    const doc = this.current.doc;
    const key = hexKey(at);
    const onPanel = doc.panels.some((p) =>
      placedPanelCells(p).some((c) => hexKey(c) === key));
    if (!onPanel) {
      return { ok: false, reason: 'A wall fixing has to go in a cell of a panel.' };
    }
    const plan = this.fixingPlan();
    const taken = plan.cells.some((c) => hexKey(c) === key)
      || plan.junctions.some((j) => j.cells.some((c) => hexKey(c) === key));
    if (taken) {
      return { ok: false, reason: 'That cell already carries a wall fixing.', blockedCells: [at] };
    }
    // A part PLUGGED into the hole is the one genuine clash: two things cannot
    // occupy the same hexagon. An accessory standing proud of it is fine.
    const plugged = this.plugIndex().get(key)?.[0];
    if (plugged !== undefined) {
      const item = doc.items.find((i) => i.id === plugged);
      const part = item ? this.part(item.partId) : undefined;
      return {
        ok: false,
        reason: `${part?.name ?? 'Something'} is already in that hole.`,
        blockedCells: [at],
      };
    }

    const edits = doc.fixingEdits;
    /*
     * Putting one back where the planner had it is UNDOING a removal, not
     * adding an override. Recorded as an addition instead, the cell would carry
     * both a removal and an addition for ever, and re-solving the wall — which
     * moves the plan — would leave a fixing pinned to a cell the planner no
     * longer chose while its removal quietly did nothing.
     */
    const wasRemoved = (edits?.removed ?? []).some((c) => hexKey(c) === key);
    const next: FixingEdits = wasRemoved
      ? { ...edits, removed: (edits?.removed ?? []).filter((c) => hexKey(c) !== key) }
      : { ...edits, added: [...(edits?.added ?? []), { q: at.q, r: at.r }] };
    this.commit(label, {
      doc: withFixingEdits(doc, next),
      selection: this.current.selection,
    });
    return { ok: true };
  }

  /**
   * Drag a fixing from one cell to another: ONE undo step, not two.
   *
   * A junction fastener cannot be moved, and that is not a limitation to work
   * around — it is a four-cell insert whose whole job is to straddle the corner
   * where three or four plates meet (HSW-SPEC §4). Somewhere else it is just a
   * big single fixing in the wrong part. It can be removed.
   */
  moveFixing(from: Hex, to: Hex, label = 'Move wall fixing'): DropResult {
    if (hexKey(from) === hexKey(to)) return { ok: true };
    const plan = this.fixingPlan();
    if (plan.junctions.some((j) => hexKey(j.anchor) === hexKey(from))) {
      return {
        ok: false,
        reason: 'That one bridges the corner where the plates meet, so it stays there. It can be removed.',
      };
    }
    const before = this.current;
    const taken = this.removeFixing(from, label);
    if (!taken.ok) return taken;
    const put = this.addFixing(to, label);
    if (!put.ok) {
      // Both halves or neither: a refused destination must not leave the fixing
      // deleted. Restored in place rather than undone, so the user's own undo
      // stack does not gain a step for a move that did not happen.
      this.current = before;
      this.past.pop();
      this.emit();
      return put;
    }
    // Two commits went on the stack; fold them into one so a drag costs one undo.
    this.past.pop();
    this.label = label;
    this.emit();
    return { ok: true };
  }

  /** Give every fixing back to the planner. */
  resetFixings(label = 'Reset wall fixings'): void {
    if (this.current.doc.fixingEdits === undefined) return;
    this.commit(label, {
      doc: withFixingEdits(this.current.doc, {}),
      selection: this.current.selection,
    });
  }

  /**
   * How many of a parts-list line have been printed.
   *
   * An ordinary undoable edit on the document, for the same reasons the photo's
   * alignment is one: it belongs to this wall, it travels down a share link, and
   * a mis-click on a count you built up over three printing sessions has to be
   * recoverable.
   *
   * Zero DELETES the key, and the last key deletes the map — an absent key must
   * round-trip to an absent key, or a layout you have not started printing stops
   * being byte-identical to its own reload. The count is NOT capped at what the
   * layout currently needs: the cap belongs to the line that reads it
   * (`bom.printedOf`), so that deleting a shelf and putting it back does not
   * quietly forget the four you already printed.
   */
  setPrinted(partId: string, count: number, label = 'Update printed count'): void {
    if (typeof partId !== 'string' || partId.length === 0) return;
    const doc = this.current.doc;
    const wanted = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    const current = doc.printed?.[partId] ?? 0;
    if (wanted === current) return;

    const next: Record<string, number> = { ...(doc.printed ?? {}) };
    if (wanted === 0) delete next[partId];
    else next[partId] = wanted;

    this.commit(label, {
      doc: withPrinted(doc, next),
      selection: this.current.selection,
    });
  }

  /**
   * One more, or one fewer, printed — read from the DOCUMENT, not from a number
   * the caller is holding.
   *
   * It exists because `setPrinted` cannot serve a stepper. A button in a
   * rendered list knows the count as of its last render, so three quick clicks
   * all compute `0 + 1` and the third overwrites the first two: measured in the
   * running app, `+ + +` on a 12-plate line recorded ONE. Same shape as D58 —
   * state is only visible after a render, and the pointer does not wait — and
   * the same fix: whoever holds the truth does the arithmetic.
   *
   * `max` is the line's quantity, so a burst of clicks cannot run the count off
   * past what the wall needs. It is the caller's because the quantity is the
   * parts list's answer, not the store's; it is stable across a click storm
   * because only an edit to the layout changes it.
   */
  bumpPrinted(partId: string, delta: number, max = Number.POSITIVE_INFINITY): void {
    if (typeof partId !== 'string' || partId.length === 0) return;
    if (!Number.isFinite(delta)) return;
    const current = this.current.doc.printed?.[partId] ?? 0;
    const ceiling = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : Number.POSITIVE_INFINITY;
    this.setPrinted(partId, Math.min(ceiling, current + delta));
  }

  /** Start the build again: every count back to none. */
  clearPrinted(label = 'Clear printed counts'): void {
    const doc = this.current.doc;
    if (doc.printed === undefined) return;
    this.commit(label, { doc: withPrinted(doc, {}), selection: this.current.selection });
  }

  // --- the project's parts --------------------------------------------------

  /**
   * Put parts in the project, so they appear in the rail.
   *
   * An undo step, unlike `setCatalog`: the catalogue is the shop and is not part
   * of the document, but WHICH parts this wall is built from is a decision about
   * this wall, and a decision you can take back. Adding what is already there
   * commits nothing, so a double-click on Add does not cost an undo.
   */
  addToProject(partIds: readonly string[]): void {
    const next = withPartsAdded(this.current.doc, partIds);
    if (next === this.current.doc) return;
    const added = (next.library ?? []).length - (this.current.doc.library ?? []).length;
    this.commit(
      added === 1 ? 'Add part to project' : `Add ${added} parts to project`,
      { doc: next, selection: this.current.selection },
    );
  }

  /**
   * Take a part back out of the project.
   *
   * Refused while it is on the wall: `projectPartIds` unions the list with what
   * is placed, so the rail would put it straight back and the click would look
   * broken. Refusing with a count says what to do instead.
   */
  removeFromProject(partId: string): DropResult {
    const placed = placementsOf(this.current.doc, partId);
    if (placed > 0) {
      return {
        ok: false,
        reason: `${placed} placement${placed === 1 ? '' : 's'} on the wall use${placed === 1 ? 's' : ''} that part — delete ${placed === 1 ? 'it' : 'them'} first`,
      };
    }
    const next = withPartRemoved(this.current.doc, partId);
    if (next === this.current.doc) return { ok: true };
    this.commit('Remove part from project', { doc: next, selection: this.current.selection });
    return { ok: true };
  }

  /**
   * The first cell of the wall, in reading order, where `partId` would be a
   * legal placement — or null if there is nowhere it fits.
   *
   * This is what Enter on a catalogue tile uses. It reuses `partCells` +
   * `exclusiveCellsOf` + `checkPlacement`, which is the exact gate `addItem`
   * applies, so the keyboard and the pointer cannot come to different views
   * about which cells are legal: an accessory may overlap freely, two things
   * that plug INTO a cell may not.
   *
   * Reading order rather than nearest-to-centre because it has to be
   * deterministic — the same part on the same wall must always land in the same
   * place, or an undo/redo pair stops being a round trip.
   *
   * COLUMN-major since the wall turned flat-top (D35), matching `panelCells`,
   * `toAxial` and `normalise`. Row-major here would start from whichever cell
   * happens to have the least `r`, which on a staggered block is somewhere up
   * the right-hand edge rather than the corner a person would call first.
   */
  firstFittingCell(partId: string): Hex | null {
    const part = this.part(partId);
    if (!part) return null;
    const seen = new Set<string>();
    const cells: Hex[] = [];
    for (const panel of this.current.doc.panels) {
      for (const cell of placedPanelCells(panel)) {
        const key = hexKey(cell);
        if (seen.has(key)) continue;
        seen.add(key);
        cells.push(cell);
      }
    }
    cells.sort((a, b) => a.q - b.q || a.r - b.r);
    for (const at of cells) {
      const covered = partCells(part, at, 0);
      if (covered.length === 0) return null;
      if (this.checkPlacement(covered, new Set(), exclusiveCellsOf(part, covered)).ok) return at;
    }
    return null;
  }

  addItem(partId: string, at: Hex, rotation: Rotation = 0): DropResult {
    const part = this.part(partId);
    if (!part) return { ok: false, reason: `Unknown part "${partId}"` };
    if (!withinLattice(at)) {
      // The store used to accept coordinates that `persist` then refused, so a
      // document could be legal in memory and illegal on disk: the item was
      // dropped on reload with a message, which is loud but still a
      // disagreement about what a legal document is. The store is the
      // permissive one, so the store is where it is fixed.
      return {
        ok: false,
        reason: `That is ${Math.max(Math.abs(at.q), Math.abs(at.r)).toExponential(0)} cells from the origin — far outside any real wall`,
      };
    }
    const cells = partCells(part, at, rotation);
    const check = this.checkPlacement(cells, new Set(), exclusiveCellsOf(part, cells));
    if (!check.ok) return check;

    const item: PlacedItem = { id: newId('i'), partId, at, rotation };
    const items = [...this.current.doc.items, item];
    this.commit(`Place ${part.name}`, {
      // Placing a part puts it in the project, so the rail keeps it after the
      // placement is deleted. Dropping something straight onto the wall is a
      // way of shopping for it — a shorter one than opening the library —
      // and the two paths must not disagree about what the project uses.
      doc: withPartAdded({ ...this.current.doc, items }, partId),
      selection: [item.id],
    });
    this.extendOccupancy(items, [item]);
    return check;
  }

  /** Move a set of items by a lattice delta, all-or-nothing. */
  moveItems(ids: readonly string[], delta: Hex): DropResult {
    if (ids.length === 0) return { ok: true };
    const moving = new Set(ids);
    const next: PlacedItem[] = [];
    const allCells: Hex[] = [];
    const excl = new Set<string>();
    for (const item of this.current.doc.items) {
      if (!moving.has(item.id)) {
        next.push(item);
        continue;
      }
      const at = { q: item.at.q + delta.q, r: item.at.r + delta.r };
      if (!withinLattice(at)) {
        return { ok: false, reason: 'That would move it off the lattice entirely' };
      }
      const moved = { ...item, at };
      next.push(moved);
      const part = this.part(item.partId);
      if (part) {
        const cs = partCells(part, at, item.rotation);
        allCells.push(...cs);
        for (const k of exclusiveCellsOf(part, cs)) excl.add(k);
      }
    }
    // A group moves as one rigid body: if any member cannot land, none do.
    const check = this.checkPlacement(allCells, moving, excl);
    if (!check.ok) return check;

    this.commit(ids.length > 1 ? `Move ${ids.length} items` : 'Move item', {
      doc: { ...this.current.doc, items: next },
      selection: this.current.selection,
    });
    return check;
  }

  /**
   * Rotate a selection about a fixed member of that selection.
   *
   * Rotating each item about its own anchor would tear a group apart, so the
   * whole selection turns about one shared pivot.
   *
   * The pivot is the first selected item's cell, NOT the centroid. The centroid
   * of an even-sized selection falls on a half-cell, which is not a lattice
   * point, so it has to be rounded — and the rounded pivot then moves with the
   * items on every step. Six 60° rotations stopped being the identity: a pair
   * at (10,10),(11,10) walked to (14,8),(15,8), every step returning ok, with
   * nothing to tell the user their wall had been rearranged.
   *
   * Pivoting on a member is exact: that item cannot move, so the pivot is the
   * same on every step and six rotations are provably the identity.
   *
   * The member chosen is the one nearest the true (unrounded) centroid, so the
   * selection still turns about its middle rather than orbiting a corner —
   * pivoting on an arbitrary member swept a wide arc and pushed groups off the
   * panel edge for rotations that ought to be free.
   */
  rotateItems(ids: readonly string[], steps: number): DropResult {
    if (ids.length === 0) return { ok: true };
    if (!Number.isFinite(steps) || !Number.isInteger(steps)) {
      // NaN would survive `((s % 6) + 6) % 6` and be written into the document
      // as an unrepresentable rotation that save/load silently rewrites.
      return { ok: false, reason: 'Rotation must be a whole number of steps' };
    }
    const set = new Set(ids);
    const members = this.current.doc.items.filter((i) => set.has(i.id));
    if (members.length === 0) return { ok: true };

    const pivot = pivotNearestCentroid(members);
    const next: PlacedItem[] = [];
    const allCells: Hex[] = [];
    const excl = new Set<string>();
    for (const item of this.current.doc.items) {
      if (!set.has(item.id)) {
        next.push(item);
        continue;
      }
      const rel = { q: item.at.q - pivot.q, r: item.at.r - pivot.r };
      const spun = rotateAxial(rel, steps);
      const at = { q: spun.q + pivot.q, r: spun.r + pivot.r };
      const rotation = (((item.rotation + steps) % 6) + 6) % 6 as Rotation;
      next.push({ ...item, at, rotation });
      const part = this.part(item.partId);
      if (part) {
        const cs = partCells(part, at, rotation);
        allCells.push(...cs);
        for (const k of exclusiveCellsOf(part, cs)) excl.add(k);
      }
    }
    const check = this.checkPlacement(allCells, set, excl);
    if (!check.ok) {
      return { ...check, reason: `Cannot rotate — ${check.reason ?? 'no room'}` };
    }
    this.commit('Rotate', {
      doc: { ...this.current.doc, items: next },
      selection: this.current.selection,
    });
    return check;
  }

  deleteItems(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const set = new Set(ids);
    const items = this.current.doc.items.filter((i) => !set.has(i.id));
    if (items.length === this.current.doc.items.length) return;
    this.commit(ids.length > 1 ? `Delete ${ids.length} items` : 'Delete item', {
      doc: { ...this.current.doc, items },
      selection: [],
    });
  }

  /** Copy a selection offset by `delta`, keeping any grouping intact. */
  duplicateItems(ids: readonly string[], delta: Hex): DropResult {
    if (ids.length === 0) return { ok: true };
    const set = new Set(ids);
    const members = this.current.doc.items.filter((i) => set.has(i.id));
    if (members.length === 0) return { ok: true };

    const groupMap = new Map<string, string>();
    const copies: PlacedItem[] = [];
    const allCells: Hex[] = [];
    const excl = new Set<string>();
    for (const m of members) {
      const at = { q: m.at.q + delta.q, r: m.at.r + delta.r };
      if (!withinLattice(at)) {
        return { ok: false, reason: 'Cannot duplicate — that would land off the lattice' };
      }
      let groupId = m.groupId;
      if (groupId !== undefined) {
        let mapped = groupMap.get(groupId);
        if (mapped === undefined) {
          mapped = newId('g');
          groupMap.set(groupId, mapped);
        }
        groupId = mapped;
      }
      const copy: PlacedItem = { id: newId('i'), partId: m.partId, at, rotation: m.rotation };
      if (groupId !== undefined) copy.groupId = groupId;
      copies.push(copy);
      const part = this.part(m.partId);
      if (part) {
        const cs = partCells(part, at, m.rotation);
        allCells.push(...cs);
        for (const k of exclusiveCellsOf(part, cs)) excl.add(k);
      }
    }
    const check = this.checkPlacement(allCells, new Set(), excl);
    if (!check.ok) return { ...check, reason: `Cannot duplicate — ${check.reason ?? 'no room'}` };

    const groups = [...this.current.doc.groups, ...[...groupMap.values()].map((id) => ({ id }))];
    const items = [...this.current.doc.items, ...copies];
    this.commit(`Duplicate ${copies.length} item${copies.length > 1 ? 's' : ''}`, {
      doc: { ...this.current.doc, items, groups },
      selection: copies.map((c) => c.id),
    });
    this.extendOccupancy(items, copies);
    return check;
  }

  groupItems(ids: readonly string[]): void {
    if (ids.length < 2) return;
    const set = new Set(ids);
    const groupId = newId('g');
    const items = this.current.doc.items.map((i) =>
      set.has(i.id) ? { ...i, groupId } : i,
    );
    this.commit(`Group ${ids.length} items`, {
      doc: { ...this.current.doc, items, groups: [...this.current.doc.groups, { id: groupId }] },
      selection: [...ids],
    });
  }

  ungroupItems(ids: readonly string[]): void {
    const set = new Set(ids);
    const touched = this.current.doc.items.some((i) => set.has(i.id) && i.groupId !== undefined);
    if (!touched) return;
    const items = this.current.doc.items.map((i) => {
      if (!set.has(i.id) || i.groupId === undefined) return i;
      const { groupId: _drop, ...rest } = i;
      return rest;
    });
    this.commit('Ungroup', { doc: { ...this.current.doc, items }, selection: [...ids] });
  }

  /** Replace the whole document — load, import, share link. */
  replaceDoc(doc: LayoutDoc, label = 'Load layout'): void {
    this.commit(label, { doc, selection: [] });
  }

  // -- selection -----------------------------------------------------------

  select(ids: readonly string[]): void {
    this.touch([...new Set(ids)]);
  }

  toggleSelect(id: string): void {
    const s = new Set(this.current.selection);
    if (s.has(id)) s.delete(id); else s.add(id);
    this.touch([...s]);
  }

  /** Selecting one member of a group selects the whole group. */
  expandSelection(ids: readonly string[]): string[] {
    const wanted = new Set(ids);
    const groups = new Set<string>();
    for (const item of this.current.doc.items) {
      if (wanted.has(item.id) && item.groupId !== undefined) groups.add(item.groupId);
    }
    if (groups.size === 0) return [...wanted];
    for (const item of this.current.doc.items) {
      if (item.groupId !== undefined && groups.has(item.groupId)) wanted.add(item.id);
    }
    return [...wanted];
  }
}

// ---------------------------------------------------------------------------

/**
 * What a wall dimension may be, in millimetres.
 *
 * Exported because the INPUT has to know the same range: a field that only
 * commits in-range values is what lets you clear it and type a new number
 * without the half-typed first digit collapsing the wall to its minimum. Two
 * copies of this range and the field would silently refuse a size the store
 * would have accepted.
 */
export const MIN_WALL_MM = 50;
export const MAX_WALL_MM = 20000;

function clampDim(v: number): number {
  if (!Number.isFinite(v)) return 100;
  return Math.min(MAX_WALL_MM, Math.max(MIN_WALL_MM, Math.round(v)));
}

/**
 * The furthest a cell may sit from the origin, matching `persist.readCoord`.
 *
 * One number, two modules: if these ever disagree again, a document is legal in
 * memory and illegal on disk. 1e7 cells is 236 km of wall, so nothing real is
 * excluded.
 */
export const MAX_CELL_COORD = 1e7;

const withinLattice = (h: Hex): boolean =>
  Number.isFinite(h.q) && Number.isFinite(h.r) &&
  Math.abs(h.q) <= MAX_CELL_COORD && Math.abs(h.r) <= MAX_CELL_COORD;

/**
 * Does this part go INTO a cell, or ON the wall in front of it?
 *
 * Inserts and wall fasteners occupy the hexagonal hole itself, so two of them
 * cannot share a cell. Accessories bolt or clip onto an insert and stand proud
 * of the panel — the whole point of the system is mounting things on top, so
 * their footprints are allowed to overlap and the app only advises.
 */
export function isExclusive(part: CatalogPart): boolean {
  return part.type === 'insert' || part.type === 'fastener';
}

/**
 * The document with new colours, or with the field GONE when nothing is
 * coloured any more. Empty maps are dropped as well as an empty object: an
 * absent key has to round-trip to an absent key.
 */
function withColors(doc: LayoutDoc, colors: WallColors): LayoutDoc {
  const next: WallColors = {};
  if (colors.panels !== undefined) next.panels = colors.panels;
  if (colors.parts !== undefined) next.parts = colors.parts;
  if (colors.lines && Object.keys(colors.lines).length > 0) next.lines = colors.lines;
  if (colors.items && Object.keys(colors.items).length > 0) next.items = colors.items;
  if (!hasColors(next)) {
    const { colors: _drop, ...rest } = doc;
    return rest as LayoutDoc;
  }
  return { ...doc, colors: next };
}

/**
 * The document with new fixing edits, or with the field GONE when there is
 * nothing left in it. Empty ARRAYS are dropped as well as an empty object: an
 * absent key has to round-trip to an absent key, and `{removed: []}` is a
 * document that says something when it means nothing.
 */
function withFixingEdits(doc: LayoutDoc, edits: FixingEdits): LayoutDoc {
  const next: FixingEdits = {};
  if (edits.removed && edits.removed.length > 0) next.removed = edits.removed;
  if (edits.added && edits.added.length > 0) next.added = edits.added;
  if (next.removed === undefined && next.added === undefined) {
    const { fixingEdits: _drop, ...rest } = doc;
    return rest as LayoutDoc;
  }
  return { ...doc, fixingEdits: next };
}

/**
 * The document with a new set of printed counts, or with the field GONE when
 * there are none left. `{printed: {}}` is not the same document as one that has
 * never had a count on it: it serialises differently, so an untouched layout
 * would stop matching its own reload.
 */
function withPrinted(doc: LayoutDoc, counts: Record<string, number>): LayoutDoc {
  if (Object.keys(counts).length === 0) {
    const { printed: _drop, ...rest } = doc;
    return rest as LayoutDoc;
  }
  return { ...doc, printed: counts };
}

/**
 * Cut every panel around the obstacles, and drop any panel left with nothing.
 *
 * `omit` is recomputed from scratch each time rather than accumulated, so
 * moving a switch back where it was restores the cells it had taken — an
 * accumulated cut would leave the wall permanently pockmarked by every position
 * an obstacle had ever occupied.
 */
export function cutAroundObstacles(
  panels: readonly LayoutDoc['panels'][number][],
  obstacles: LayoutDoc['obstacles'],
  /**
   * The wall's border, because it CUTS now (D86).
   *
   * It used to add material outside the honeycomb and take nothing, so it never
   * touched `omit`. The edge is a straight cut through the outermost cells now —
   * what the printed reference does — and a half cell is not somewhere to mount
   * anything, so the ring has to leave the planner exactly the way a switch's
   * cells do. Omitted, it re-cuts whenever the border is switched on, off or
   * resized.
   */
  frame?: WallFrame,
): LayoutDoc['panels'] {
  const edge = borderCutCells(panels, frame);
  const noObstacles = !obstacles || obstacles.length === 0;
  if (noObstacles && edge.size === 0) {
    return panels.map((p) => {
      if (p.omit === undefined) return p;
      const { omit: _drop, ...rest } = p;
      return rest;
    });
  }
  const out: LayoutDoc['panels'] = [];
  for (const panel of panels) {
    const block = panelCells(panel.origin, panel.columns, panel.rows);
    const blocked = obstructedCells(obstacles, block);
    const cut = block.filter((c) => blocked.has(hexKey(c)) || edge.has(hexKey(c)));
    if (cut.length === 0) {
      const { omit: _drop, ...rest } = panel;
      out.push(rest);
      continue;
    }
    // Every cell taken: there is no plate left to print here at all.
    if (cut.length >= block.length) continue;
    out.push({ ...panel, omit: cut });
  }
  return out;
}

/** Cells of a placement that need a hole to themselves. */
export function exclusiveCellsOf(part: CatalogPart, cells: readonly Hex[]): Set<string> {
  return isExclusive(part) ? new Set(cells.map(hexKey)) : new Set<string>();
}

/**
 * Record an item in the cell -> things-in-the-hole index.
 *
 * Only parts that go INTO a cell are recorded, which is the whole point: an
 * accessory stands in front of a hole and does not fill it, and treating it as
 * an occupant is what let a second insert into an occupied cell.
 */
function addPlugs(
  plugs: Map<string, string[]>,
  item: PlacedItem,
  catalog: Catalog,
): void {
  const part = catalog.parts.find((p) => p.id === item.partId);
  if (part === undefined || !isExclusive(part)) return;
  for (const c of itemCells(item, catalog)) {
    const key = hexKey(c);
    const list = plugs.get(key);
    if (list === undefined) plugs.set(key, [item.id]);
    else list.push(item.id);
  }
}

/**
 * The member of a selection nearest its exact centroid, as the rotation pivot.
 *
 * Deterministic (ties break on id) and always a real cell, which is what makes
 * six 60° steps exactly the identity — the pivot is an item, so it never moves,
 * so it is the same pivot on every step.
 */
function pivotNearestCentroid(members: readonly PlacedItem[]): Hex {
  const first = members[0];
  if (!first) return { q: 0, r: 0 };
  let sq = 0;
  let sr = 0;
  for (const m of members) {
    sq += m.at.q;
    sr += m.at.r;
  }
  const cq = sq / members.length;
  const cr = members.length === 0 ? 0 : sr / members.length;
  let best = first;
  let bestD = Infinity;
  for (const m of members) {
    // Distance in the skewed axial basis is fine here: we only need a stable
    // "most central" choice, not a metric.
    const d = (m.at.q - cq) ** 2 + (m.at.r - cr) ** 2;
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && m.id < best.id)) {
      bestD = d;
      best = m;
    }
  }
  return best.at;
}

/**
 * Cells a catalogue part covers when placed — the SINGLE definition.
 *
 * This has to agree with `bom.itemCells` exactly, or the editor and the parts
 * list disagree about reality: a drop the editor accepts is then reported as an
 * overlap by the BOM (or the reverse, refusing a legal placement). Two rules
 * matter and both were previously handled here differently from bom.ts:
 *
 *  - a non-zero `anchor` shifts the footprint so the anchor lands on `at`;
 *  - an empty footprint counts as one cell, not zero. Treating it as zero cells
 *    made `outside.length === cells.length` true as `0 === 0`, so a malformed
 *    part was reported "off the wall" wherever it was dropped.
 */
export function partCells(part: CatalogPart, at: Hex, rotation: Rotation): Hex[] {
  const anchor = part.anchor ?? { q: 0, r: 0 };
  const base =
    part.footprint.length > 0
      ? part.footprint.map((c) => ({ q: c.q - anchor.q, r: c.r - anchor.r }))
      : [{ q: 0, r: 0 }];
  return placeFootprint(base, at, rotation);
}

const rotateAxial = hexRotate;
