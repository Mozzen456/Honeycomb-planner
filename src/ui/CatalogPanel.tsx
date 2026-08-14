/**
 * The rail — the parts THIS wall is built from, and the shelf you drag them off.
 *
 * It used to be the whole catalogue: fifty-one shipped parts plus every import,
 * scrolled past to find the six a wall actually uses. Browsing and building are
 * two different jobs, so they are now two places (D71) — `PartLibrary` is the
 * shop, and this is what came home from it. Which means the rail answers a
 * question it never could before: what is this wall made of?
 *
 * Pure presentation. It is handed the parts already resolved, groups them,
 * filters them and hands every gesture back to the parent through `onDragStart`.
 * It knows nothing about the wall, the document, or how a drag ends — and
 * deliberately does not know how a part came to be in the project either, which
 * is `projectParts.ts`'s single answer for everyone.
 *
 * The only state it owns is which groups are folded shut, which is a property of
 * this view and of nothing else.
 */

import { useMemo, useState } from 'react';

import { isImported } from '../core/userCatalog';
import { PartImage } from './PartImage';
import type { CatalogPart, PartType } from '../core/types';

import './CatalogPanel.css';

export interface CatalogPanelProps {
  /**
   * The project's parts, already resolved against the catalogue and in the
   * order they were chosen. Resolving happens once, in `resolveProjectParts`,
   * so the rail and the library cannot come to different views about what the
   * project contains.
   */
  parts: readonly CatalogPart[];
  /**
   * Ids in the document that this catalogue has no part for — a shared layout
   * naming somebody else's import. Reported rather than dropped: a rail that is
   * quietly shorter than the file it loaded is indistinguishable from a bug.
   */
  missing?: readonly string[];
  /** How many parts there are to choose from, for the browse button. */
  catalogSize: number;
  /** Open the library. The rail's primary action when the project is empty. */
  onBrowse: () => void;
  /**
   * Fired for an HTML5 `dragstart`, for a `pointerdown`, and for keyboard
   * activation of a tile. A mouse produces both a pointerdown and a dragstart —
   * discriminate on `event.type` if the parent needs to pick one.
   */
  onDragStart: (partId: string, event: React.DragEvent | React.PointerEvent) => void;
  /**
   * Keyboard activation of a tile: place the part outright. Deliberately NOT
   * folded into `onDragStart` — see `activateFromKeyboard`.
   */
  onActivate?: (partId: string) => void;
  selectedPartId?: string;
  filter?: string;
  onFilterChange?: (value: string) => void;
  /**
   * Take a part back out of the project. Offered on every part, not just
   * imports: this removes it from the RAIL, not from the catalogue — deleting
   * an upload for good is the library's job, where the consequence is visible.
   */
  onRemovePart?: (partId: string) => void;
  /**
   * Open the mounting-face inspector for a part. Offered on EVERY part, not
   * just the flagged ones: the detector's answer can be wrong as well as
   * absent, and a part that looks wrong on the wall is the reason someone comes
   * looking for this.
   */
  onInspect?: (partId: string) => void;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/**
 * Build order, not alphabetical order: nothing mounts without a panel, and the
 * hardware that holds an accessory on is more useful next to it than under it.
 */
const GROUPS: readonly { type: PartType; label: string; note: string }[] = [
  { type: 'panel', label: 'Panels', note: 'The wall itself' },
  { type: 'accessory', label: 'Accessories', note: 'Hooks, holders, shelves' },
  { type: 'insert', label: 'Inserts', note: 'Printed hardware that clips in' },
  { type: 'fastener', label: 'Fasteners', note: 'Printed screws and clips' },
  { type: 'unknown', label: 'Unclassified', note: 'The scanner could not place these' },
];

// ---------------------------------------------------------------------------
// Formatting — display only
// ---------------------------------------------------------------------------

function finite(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatMinutes(value: number | undefined | null): string {
  const total = Math.round(finite(value));
  if (total <= 0) return '0 m';
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} m`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} m`;
}

function formatGrams(value: number | undefined | null): string {
  const fixed = finite(value).toFixed(1);
  return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed} g`;
}

const cellCount = (part: CatalogPart): number =>
  Array.isArray(part.footprint) && part.footprint.length > 0 ? part.footprint.length : 1;

// ---------------------------------------------------------------------------
// Keyboard activation
// ---------------------------------------------------------------------------

const ACTIVATION_KEYS = new Set([' ', 'Enter', 'Spacebar']);

/**
 * Enter or Space PLACES the part. It does not start a drag.
 *
 * It used to. The tile dispatched a real `pointerdown` on itself marked
 * `pointerType: 'keyboard'`, so the parent got a fully-formed event to measure —
 * which was tidy, and which handed the keyboard a gesture it could not finish. A
 * drag ends on `pointerup` over the wall; there is no Enter-to-drop, and the
 * arrow keys move the SELECTION, not a pending drag. So Enter drew a ghost that
 * only Escape could get rid of, while the tile's own tooltip promised otherwise.
 *
 * Placing outright is the shorter path and reuses the keys that already exist:
 * the part arrives selected, and arrows move it, R rotates it, Delete removes
 * it. `onActivate` is therefore a separate prop from `onDragStart` — the two
 * mean different things, and blurring them is what caused this.
 */
function activateFromKeyboard(
  event: React.KeyboardEvent<HTMLElement>,
  partId: string,
  onActivate: CatalogPanelProps['onActivate'],
): void {
  if (!ACTIVATION_KEYS.has(event.key)) return;
  event.preventDefault();
  onActivate?.(partId);
}

// ---------------------------------------------------------------------------
// Tile
// ---------------------------------------------------------------------------

interface TileProps {
  part: CatalogPart;
  selected: boolean;
  onDragStart: CatalogPanelProps['onDragStart'];
  onActivate: CatalogPanelProps['onActivate'];
  onRemove?: (partId: string) => void;
  onInspect?: (partId: string) => void;
}

function CatalogTile(
  { part, selected, onDragStart, onActivate, onRemove, onInspect }: TileProps,
): JSX.Element {
  const cells = cellCount(part);
  const name = part.name.length > 0 ? part.name : part.id;
  const imported = isImported(part);
  const estimated = part.print?.source === 'volume';

  return (
    <li className="catalog-tile__slot">
      {/*
        A div rather than a button so focus, activation and the coarse-pointer
        target behave identically for mouse, pen and touch. base.css styles
        [role="button"] to match.

        NOT draggable, and the native drag is actively cancelled below. The
        gesture is implemented with Pointer Events, which already cover mouse,
        pen and touch. Leaving HTML5 drag enabled as well was not a harmless
        belt-and-braces: on a mouse the browser promoted the gesture to a native
        drag mid-move, which swallows all pointermove/pointerup events, so the
        drop never arrived and the page sat in a modal drag loop that looked
        exactly like a hang.
      */}
      <div
        role="button"
        tabIndex={0}
        draggable={false}
        className="catalog-tile"
        data-selected={selected ? 'true' : undefined}
        aria-current={selected ? 'true' : undefined}
        title={`${part.file} — drag onto the wall, or press Enter to place it`}
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => onDragStart(part.id, event)}
        onKeyDown={(event) => activateFromKeyboard(event, part.id, onActivate)}
      >
        <PartImage part={part} className="catalog-tile__preview" />
        <span className="catalog-tile__name">
          {name}
          {imported ? <span className="catalog-tile__mine" title="You uploaded this">•</span> : null}
        </span>
        <span className="catalog-tile__cells tabular-nums">
          {cells}
          <span className="visually-hidden"> cells</span>
        </span>
        <span className="catalog-tile__metrics tabular-nums">
          {/* An imported part's print numbers are modelled, not sliced. The
              marker is on the tile as well as in the parts list, because this
              is where the choice between two parts is actually made. */}
          {estimated ? <span className="catalog-tile__est">est.</span> : null}
          {formatMinutes(part.print?.minutes)}
          <span className="catalog-tile__dot" aria-hidden="true">
            ·
          </span>
          {formatGrams(part.print?.grams)}
        </span>
      </div>
      {onInspect !== undefined ? (
        <button
          type="button"
          className="catalog-tile__inspect hit-area"
          /* Not inside the tile div: that one owns pointerdown for the drag
             gesture, and a button nested in it would have its click swallowed. */
          title={`Set which face of ${part.name} goes against the wall — click the surface in 3D`}
          aria-label={`Set the mounting face for ${part.name}`}
          onClick={() => onInspect(part.id)}
        >
          ⌖
        </button>
      ) : null}
      {onRemove !== undefined ? (
        <button
          type="button"
          className="catalog-tile__remove hit-area"
          aria-label={`Take ${name} out of this project`}
          title="Take this part out of the project — it stays in the library"
          onClick={() => onRemove(part.id)}
        >
          ×
        </button>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function CatalogPanel(props: CatalogPanelProps): JSX.Element {
  const {
    parts, missing = [], catalogSize, onBrowse, onDragStart, onActivate, selectedPartId,
    filter, onFilterChange, onRemovePart, onInspect,
  } = props;

  const [collapsed, setCollapsed] = useState<ReadonlySet<PartType>>(() => new Set<PartType>());

  const query = (filter ?? '').trim().toLowerCase();
  const filtering = query.length > 0;

  /** Name and file path, both lower-cased, both matched as plain substrings. */
  const matches = useMemo(() => {
    if (query.length === 0) return parts;
    return parts.filter(
      (part) =>
        part.name.toLowerCase().includes(query) || part.file.toLowerCase().includes(query),
    );
  }, [parts, query]);

  const groups = useMemo(() => {
    const buckets = new Map<PartType, CatalogPart[]>();
    for (const group of GROUPS) buckets.set(group.type, []);
    for (const part of matches) {
      const bucket = buckets.get(part.type) ?? buckets.get('unknown');
      bucket?.push(part);
    }
    return GROUPS.map((group) => ({
      ...group,
      parts: buckets.get(group.type) ?? [],
    })).filter((group) => group.parts.length > 0);
  }, [matches]);

  const toggle = (type: PartType): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const empty = parts.length === 0;

  return (
    <aside className="catalog-panel" aria-label="Parts in this project">
      <header className="catalog-panel__head">
        <h2 className="catalog-panel__title">This project</h2>

        <button
          type="button"
          className="button button--primary catalog-panel__browse"
          onClick={onBrowse}
          title={`Browse all ${catalogSize} parts and add the ones you want`}
        >
          Browse parts…
        </button>

        {/* The filter is for a rail with twenty parts in it, not for one with
            three, so it goes away when it cannot earn its line. */}
        {parts.length > 6 && (
          <div className="catalog-panel__search">
            <input
              type="search"
              className="catalog-panel__filter"
              value={filter ?? ''}
              readOnly={onFilterChange === undefined}
              placeholder="Filter your parts"
              aria-label="Filter this project's parts by name or file path"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onFilterChange?.(event.target.value)}
            />
            {filtering && onFilterChange !== undefined ? (
              <button
                type="button"
                className="catalog-panel__clear hit-area"
                aria-label="Clear the filter"
                title="Clear the filter"
                onClick={() => onFilterChange('')}
              >
                ×
              </button>
            ) : null}
          </div>
        )}

        {!empty && (
          <p className="catalog-panel__count tabular-nums">
            {filtering
              ? `${matches.length} of ${parts.length} parts`
              : `${parts.length} part${parts.length === 1 ? '' : 's'}`}
          </p>
        )}
      </header>

      <div className="catalog-panel__scroll">
        {empty ? (
          <div className="catalog-panel__start">
            <p className="catalog-panel__starttitle">Nothing here yet</p>
            <p className="catalog-panel__startbody">
              Go shopping: pick the hooks, shelves and bins you want on this wall, and they
              land here ready to drag on.
            </p>
            <button type="button" className="button button--primary" onClick={onBrowse}>
              Browse {catalogSize} parts
            </button>
            <p className="catalog-panel__startnote">
              Got your own model? Drop an STL or 3MF anywhere on this window — you measure it, give it
              a photo and line it up, and it joins your library.
            </p>
          </div>
        ) : groups.length === 0 ? (
          <p className="catalog-panel__empty">
            Nothing in this project matches “{filter ?? ''}”.
          </p>
        ) : (
          groups.map((group) => {
            /* While filtering, every group with a hit is open: a match you cannot
               see is the same as no match at all. */
            const open = filtering || !collapsed.has(group.type);
            const regionId = `catalog-group-${group.type}`;
            return (
              <section className="catalog-group" key={group.type}>
                <h3 className="catalog-group__heading">
                  <button
                    type="button"
                    className="catalog-group__toggle"
                    aria-expanded={open}
                    aria-controls={regionId}
                    onClick={() => toggle(group.type)}
                    title={group.note}
                  >
                    <span className="catalog-group__chevron" aria-hidden="true">
                      {open ? '▾' : '▸'}
                    </span>
                    <span className="catalog-group__label">{group.label}</span>
                    <span className="catalog-group__count tabular-nums">{group.parts.length}</span>
                  </button>
                </h3>

                <ul className="catalog-group__list" id={regionId} role="list" hidden={!open}>
                  {group.parts.map((part) => (
                    <CatalogTile
                      key={part.id}
                      part={part}
                      selected={part.id === selectedPartId}
                      onDragStart={onDragStart}
                      onActivate={onActivate}
                      onInspect={onInspect}
                      onRemove={onRemovePart}
                    />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>

      {missing.length > 0 ? (
        <footer className="catalog-panel__foot">
          <p className="catalog-panel__unresolved tabular-nums">
            {missing.length} part{missing.length === 1 ? '' : 's'} in this layout{' '}
            {missing.length === 1 ? 'is' : 'are'} not in your library — it was saved by someone
            with their own uploads.
          </p>
        </footer>
      ) : null}
    </aside>
  );
}
