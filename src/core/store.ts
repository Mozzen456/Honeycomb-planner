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

import { computeBom, itemCells, validate } from './bom';
import { hexKey, hexRotate, panelCells, placeFootprint } from './hex';
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

  constructor(doc: LayoutDoc, readonly catalog: Catalog) {
    this.current = { doc, selection: [] };
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

  /** Cells covered by every item except the ones named — the collision set. */
  occupiedCells(exclude: ReadonlySet<string> = new Set()): Map<string, string> {
    const map = new Map<string, string>();
    for (const item of this.current.doc.items) {
      if (exclude.has(item.id)) continue;
      for (const c of itemCells(item, this.catalog)) map.set(hexKey(c), item.id);
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
      for (const c of panelCellsOf(p.origin, p.columns, p.rows)) set.add(hexKey(c));
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
  checkPlacement(cells: readonly Hex[], ignoreIds: ReadonlySet<string> = new Set()): DropResult {
    const occupied = this.occupiedCells(ignoreIds);
    const blocked: Hex[] = [];
    let blockerName = '';
    for (const c of cells) {
      const other = occupied.get(hexKey(c));
      if (other !== undefined) {
        blocked.push(c);
        if (!blockerName) {
          const it = this.current.doc.items.find((i) => i.id === other);
          const p = it ? this.part(it.partId) : undefined;
          blockerName = p?.name ?? 'another item';
        }
      }
    }
    if (blocked.length > 0) {
      return {
        ok: false,
        reason: `Overlaps ${blockerName} — ${blocked.length} cell${blocked.length > 1 ? 's' : ''} already taken`,
        blockedCells: blocked,
      };
    }

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
    this.commit(label, {
      doc: { ...this.current.doc, panels },
      selection: this.current.selection,
    });
  }

  addItem(partId: string, at: Hex, rotation: Rotation = 0): DropResult {
    const part = this.part(partId);
    if (!part) return { ok: false, reason: `Unknown part "${partId}"` };
    const cells = placeFootprint(part.footprint, at, rotation);
    const check = this.checkPlacement(cells);
    if (!check.ok) return check;

    const item: PlacedItem = { id: newId('i'), partId, at, rotation };
    this.commit(`Place ${part.name}`, {
      doc: { ...this.current.doc, items: [...this.current.doc.items, item] },
      selection: [item.id],
    });
    return check;
  }

  /** Move a set of items by a lattice delta, all-or-nothing. */
  moveItems(ids: readonly string[], delta: Hex): DropResult {
    if (ids.length === 0) return { ok: true };
    const moving = new Set(ids);
    const next: PlacedItem[] = [];
    const allCells: Hex[] = [];
    for (const item of this.current.doc.items) {
      if (!moving.has(item.id)) {
        next.push(item);
        continue;
      }
      const at = { q: item.at.q + delta.q, r: item.at.r + delta.r };
      const moved = { ...item, at };
      next.push(moved);
      const part = this.part(item.partId);
      if (part) allCells.push(...placeFootprint(part.footprint, at, item.rotation));
    }
    // A group moves as one rigid body: if any member cannot land, none do.
    const check = this.checkPlacement(allCells, moving);
    if (!check.ok) return check;

    this.commit(ids.length > 1 ? `Move ${ids.length} items` : 'Move item', {
      doc: { ...this.current.doc, items: next },
      selection: this.current.selection,
    });
    return check;
  }

  /**
   * Rotate a selection about the centroid of its anchors.
   *
   * Rotating each item about its own anchor would tear a group apart; rotating
   * the whole selection about a shared pivot is what "it feels like a physical
   * object" means.
   */
  rotateItems(ids: readonly string[], steps: number): DropResult {
    if (ids.length === 0) return { ok: true };
    const set = new Set(ids);
    const members = this.current.doc.items.filter((i) => set.has(i.id));
    if (members.length === 0) return { ok: true };

    const pivot = centroidOf(members.map((m) => m.at));
    const next: PlacedItem[] = [];
    const allCells: Hex[] = [];
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
      if (part) allCells.push(...placeFootprint(part.footprint, at, rotation));
    }
    const check = this.checkPlacement(allCells, set);
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
    for (const m of members) {
      const at = { q: m.at.q + delta.q, r: m.at.r + delta.r };
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
      if (part) allCells.push(...placeFootprint(part.footprint, at, m.rotation));
    }
    const check = this.checkPlacement(allCells);
    if (!check.ok) return { ...check, reason: `Cannot duplicate — ${check.reason ?? 'no room'}` };

    const groups = [...this.current.doc.groups, ...[...groupMap.values()].map((id) => ({ id }))];
    this.commit(`Duplicate ${copies.length} item${copies.length > 1 ? 's' : ''}`, {
      doc: { ...this.current.doc, items: [...this.current.doc.items, ...copies], groups },
      selection: copies.map((c) => c.id),
    });
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

function clampDim(v: number): number {
  if (!Number.isFinite(v)) return 100;
  return Math.min(20000, Math.max(50, Math.round(v)));
}

function centroidOf(cells: readonly Hex[]): Hex {
  if (cells.length === 0) return { q: 0, r: 0 };
  let q = 0;
  let r = 0;
  for (const c of cells) {
    q += c.q;
    r += c.r;
  }
  return { q: Math.round(q / cells.length), r: Math.round(r / cells.length) };
}

const rotateAxial = hexRotate;
const panelCellsOf = panelCells;
