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

import { computeBom, itemCells, itemSocketCells, validate } from './bom';
import { hexKey, hexRotate, panelCells, placedPanelCells, placeFootprint } from './hex';
import { obstructedCells } from './obstacles';
import { frameIsOn } from './panelModel';
import { placementsOf, withPartAdded, withPartRemoved, withPartsAdded } from './projectParts';
import { crossesSeam } from './tiling';
import type {
  Bom,
  Catalog,
  CatalogPart,
  Hex,
  Issue,
  LayoutDoc,
  PlacedItem,
  Rotation,
  WallFrame,
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

export function emptyDoc(): LayoutDoc {
  return {
    schemaVersion: 1,
    id: 'layout',
    name: 'Untitled wall',
    wall: { widthMm: 2400, heightMm: 1200 },
    bedId: 'bed256',
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

  setBed(bedId: string): void {
    this.commit('Change printer', {
      doc: { ...this.current.doc, bedId },
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
      doc: { ...doc, panels: cutAroundObstacles(panels, doc.obstacles) },
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
        panels: cutAroundObstacles(doc.panels, obstacles),
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
    this.commit(label, { doc: next, selection: this.current.selection });
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
): LayoutDoc['panels'] {
  // Obstacles only. The BORDER cuts nothing — it adds material outside the
  // honeycomb rather than slicing cells in half — so unlike the cut-based frame
  // this replaced, it never touches `omit` and every cell stays mountable.
  const noObstacles = !obstacles || obstacles.length === 0;
  if (noObstacles) {
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
    const cut = block.filter((c) => blocked.has(hexKey(c)));
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
