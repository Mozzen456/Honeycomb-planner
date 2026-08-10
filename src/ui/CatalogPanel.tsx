/**
 * The catalogue rail — the left-hand shelf you drag parts off.
 *
 * Pure presentation. It reads a `Catalog`, groups it, filters it and hands every
 * gesture back to the parent through `onDragStart`. It knows nothing about the
 * wall, the document or how a drag ends.
 *
 * The only state it owns is which groups are folded shut, which is a property of
 * this view and of nothing else.
 */

import { useMemo, useState } from 'react';

import type { Catalog, CatalogPart, PartType } from '../core/types';

import './CatalogPanel.css';

export interface CatalogPanelProps {
  catalog: Catalog;
  /**
   * Fired for an HTML5 `dragstart`, for a `pointerdown`, and for keyboard
   * activation of a tile. A mouse produces both a pointerdown and a dragstart —
   * discriminate on `event.type` if the parent needs to pick one.
   */
  onDragStart: (partId: string, event: React.DragEvent | React.PointerEvent) => void;
  selectedPartId?: string;
  filter?: string;
  onFilterChange?: (value: string) => void;
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
 * Enter or Space starts a drag.
 *
 * `onDragStart` takes a drag or a pointer event, and a keyboard has neither. So
 * rather than hand the parent a keyboard event wearing a pointer event's type —
 * which would give it a `clientX` of `undefined` the first time it looked — the
 * tile dispatches a real `pointerdown` on itself, centred on the tile and marked
 * `pointerType: 'keyboard'`. React's own listener picks it up, the tile's
 * `onPointerDown` runs, and the parent receives a genuine, fully-formed event it
 * can measure and discriminate on.
 */
function activateFromKeyboard(event: React.KeyboardEvent<HTMLElement>): void {
  if (!ACTIVATION_KEYS.has(event.key)) return;

  const element = event.currentTarget;
  const view = element.ownerDocument.defaultView;
  if (view === null || typeof view.PointerEvent !== 'function') return;

  event.preventDefault();
  const box = element.getBoundingClientRect();
  element.dispatchEvent(
    new view.PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
      pointerId: -1,
      pointerType: 'keyboard',
      isPrimary: true,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tile
// ---------------------------------------------------------------------------

interface TileProps {
  part: CatalogPart;
  selected: boolean;
  onDragStart: CatalogPanelProps['onDragStart'];
}

function CatalogTile({ part, selected, onDragStart }: TileProps): JSX.Element {
  const cells = cellCount(part);
  const name = part.name.length > 0 ? part.name : part.id;

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
        title={`${part.file} — drag onto the wall, or press Enter`}
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => onDragStart(part.id, event)}
        onKeyDown={activateFromKeyboard}
      >
        <span className="catalog-tile__name">{name}</span>
        <span className="catalog-tile__cells tabular-nums">
          {cells}
          <span className="visually-hidden"> cells</span>
        </span>
        <span className="catalog-tile__metrics tabular-nums">
          {formatMinutes(part.print?.minutes)}
          <span className="catalog-tile__dot" aria-hidden="true">
            ·
          </span>
          {formatGrams(part.print?.grams)}
        </span>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function CatalogPanel(props: CatalogPanelProps): JSX.Element {
  const { catalog, onDragStart, selectedPartId, filter, onFilterChange } = props;

  const [collapsed, setCollapsed] = useState<ReadonlySet<PartType>>(() => new Set<PartType>());

  const query = (filter ?? '').trim().toLowerCase();
  const filtering = query.length > 0;

  const parts = catalog.parts ?? [];

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

  const unresolved = catalog.unresolved ?? [];

  return (
    <aside className="catalog-panel" aria-label="Part catalogue">
      <header className="catalog-panel__head">
        <h2 className="catalog-panel__title">Catalogue</h2>

        <div className="catalog-panel__search">
          <input
            type="search"
            className="catalog-panel__filter"
            value={filter ?? ''}
            readOnly={onFilterChange === undefined}
            placeholder="Filter by name or file"
            aria-label="Filter the catalogue by name or file path"
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

        <p className="catalog-panel__count tabular-nums">
          {filtering ? `${matches.length} of ${parts.length} parts` : `${parts.length} parts`}
        </p>
      </header>

      <div className="catalog-panel__scroll">
        {groups.length === 0 ? (
          <p className="catalog-panel__empty">
            {parts.length === 0
              ? 'The catalogue is empty. Run the scanner over the model folder to fill it.'
              : `Nothing matches “${filter ?? ''}”. Try part of a file name, or a word from the model’s title.`}
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
                    />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>

      {unresolved.length > 0 ? (
        <footer className="catalog-panel__foot">
          <p className="catalog-panel__unresolved tabular-nums">
            {unresolved.length} model {unresolved.length === 1 ? 'file' : 'files'} could not be
            classified and are not shown.
          </p>
        </footer>
      ) : null}
    </aside>
  );
}
