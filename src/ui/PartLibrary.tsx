/**
 * The parts library — the shop you go to before you plan a wall.
 *
 * A wall is built from about six parts. The catalogue holds fifty-one shipped
 * ones plus everything the user imported, and the rail used to show all of it
 * at once: a scrolling list of names, most of which will never be used, in
 * which "which of these am I actually printing" was answered by reading the
 * parts list. So the two questions are now in two places (D71) — this is
 * *browsing*, the rail is *this project*, and the button on every card here is
 * what moves a part from one to the other.
 *
 * Laid out as a gallery rather than a list because the deciding evidence is a
 * PICTURE. Twenty-seven of the fifty-one shipped parts are named for their
 * fixing rather than their shape ("hook-to-empty", "insert-hollow-tre"), and
 * telling two of them apart from the names alone is not possible. A card is a
 * photograph if the part has one and a render of its own mesh otherwise, at a
 * size you can actually see.
 *
 * Pure presentation, like `CatalogPanel`: it reads a catalogue and a document,
 * and hands every decision back to the parent. It owns the search box, the
 * filter and the sort, because those are properties of this view and of nothing
 * else.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { MODEL_ACCEPT } from '../core/modelFile';
import { inProject } from '../core/projectParts';
import type { Catalog, CatalogPart, LayoutDoc, PartType } from '../core/types';
import { isImported } from '../core/userCatalog';
import { PartImage } from './PartImage';
import { listPhotoIds } from './partPhotos';
import './PartLibrary.css';

export interface PartLibraryProps {
  catalog: Catalog;
  doc: LayoutDoc;
  /** Put a part in the project, so it shows up in the rail. */
  onAdd: (partId: string) => void;
  /** Take it back out. Refused by the store while placements use it. */
  onRemove: (partId: string) => void;
  /** Open the alignment dialog on this part. */
  onInspect: (partId: string) => void;
  /** Delete an imported part from the catalogue entirely. */
  onDelete: (partId: string) => void;
  /** Start a model import — the header button. STL or 3MF. */
  onUpload: (files: FileList) => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Filters and sorting
// ---------------------------------------------------------------------------

type Shelf = 'all' | 'project' | 'mine' | PartType;

const SHELVES: readonly { id: Shelf; label: string; note: string }[] = [
  { id: 'all', label: 'Everything', note: 'Every part in the catalogue' },
  { id: 'project', label: 'In this project', note: 'The parts this wall already uses' },
  { id: 'mine', label: 'My uploads', note: 'STLs you added yourself' },
  { id: 'accessory', label: 'Accessories', note: 'Hooks, holders, shelves, bins' },
  { id: 'insert', label: 'Inserts', note: 'Printed hardware that clips into a cell' },
  { id: 'fastener', label: 'Fasteners', note: 'Printed screws and wall clips' },
  { id: 'panel', label: 'Panels', note: 'The wall plates themselves' },
];

type Sort = 'name' | 'quick' | 'light' | 'small';

const SORTS: readonly { id: Sort; label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'quick', label: 'Quickest to print' },
  { id: 'light', label: 'Least filament' },
  { id: 'small', label: 'Fewest cells' },
];

const finite = (v: number | undefined | null): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

const cellCount = (part: CatalogPart): number =>
  Array.isArray(part.footprint) && part.footprint.length > 0 ? part.footprint.length : 1;

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

const TYPE_LABEL: Record<PartType, string> = {
  panel: 'Panel',
  accessory: 'Accessory',
  insert: 'Insert',
  fastener: 'Fastener',
  unknown: 'Unclassified',
};

/** Does this part belong on the chosen shelf? */
function onShelf(part: CatalogPart, shelf: Shelf, doc: LayoutDoc): boolean {
  if (shelf === 'all') return true;
  if (shelf === 'project') return inProject(doc, part.id);
  if (shelf === 'mine') return isImported(part);
  return part.type === shelf;
}

function compare(a: CatalogPart, b: CatalogPart, sort: Sort): number {
  if (sort === 'quick') return finite(a.print?.minutes) - finite(b.print?.minutes);
  if (sort === 'light') return finite(a.print?.grams) - finite(b.print?.grams);
  if (sort === 'small') return cellCount(a) - cellCount(b);
  return a.name.localeCompare(b.name);
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface CardProps {
  part: CatalogPart;
  chosen: boolean;
  hasPhoto: boolean;
  onAdd: (partId: string) => void;
  onRemove: (partId: string) => void;
  onInspect: (partId: string) => void;
  onDelete: (partId: string) => void;
}

function PartCard(
  { part, chosen, hasPhoto, onAdd, onRemove, onInspect, onDelete }: CardProps,
): JSX.Element {
  const mine = isImported(part);
  const estimated = part.print?.source === 'volume';
  const cells = cellCount(part);

  return (
    <li className="lib-card" data-chosen={chosen ? 'true' : undefined}>
      <PartImage part={part} className="lib-card__shot" hasPhoto={hasPhoto} />

      <div className="lib-card__body">
        <h3 className="lib-card__name" title={part.file}>{part.name}</h3>
        <p className="lib-card__tags">
          <span className="lib-card__tag">{TYPE_LABEL[part.type]}</span>
          {mine && <span className="lib-card__tag lib-card__tag--mine">Yours</span>}
          {/* `needsReview` lives outside the CatalogPart contract, read
              structurally by whoever cares — as `overrides.ts` sets it. */}
          {(part as unknown as { needsReview?: boolean }).needsReview === true && (
            <span className="lib-card__tag lib-card__tag--check" title="The cells are a bounding box, not a measurement — open ⌖ and draw the real ones">
              Check cells
            </span>
          )}
        </p>
        <p className="lib-card__stats tabular-nums">
          {cells} cell{cells === 1 ? '' : 's'}
          <span aria-hidden="true"> · </span>
          {estimated && <span className="lib-card__est" title="Modelled, not sliced">est.</span>}
          {formatMinutes(part.print?.minutes)}
          <span aria-hidden="true"> · </span>
          {formatGrams(part.print?.grams)}
        </p>
      </div>

      <div className="lib-card__actions">
        {chosen ? (
          <button
            type="button"
            className="button lib-card__added"
            onClick={() => onRemove(part.id)}
            title="Take this part back out of the project"
          >
            ✓ In project
          </button>
        ) : (
          <button
            type="button"
            className="button button--primary"
            onClick={() => onAdd(part.id)}
            title={`Add ${part.name} to this project — it appears in the rail on the left`}
          >
            Add to project
          </button>
        )}
        <button
          type="button"
          className="button lib-card__icon"
          onClick={() => onInspect(part.id)}
          title={`Line ${part.name} up against the wall — which face mounts, which cells it takes`}
          aria-label={`Line up ${part.name}`}
        >
          ⌖
        </button>
        {mine && (
          <button
            type="button"
            className="button lib-card__icon"
            onClick={() => onDelete(part.id)}
            title="Delete this upload from the library"
            aria-label={`Delete ${part.name} from the library`}
          >
            ×
          </button>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

export function PartLibrary(props: PartLibraryProps): JSX.Element {
  const { catalog, doc, onAdd, onRemove, onInspect, onDelete, onUpload, onClose } = props;

  const [query, setQuery] = useState('');
  const [shelf, setShelf] = useState<Shelf>('all');
  const [sort, setSort] = useState<Sort>('name');
  const [photos, setPhotos] = useState<ReadonlySet<string>>(() => new Set());
  const dialogRef = useRef<HTMLDivElement | null>(null);

  /**
   * Which parts have photos, in ONE read.
   *
   * Re-read whenever the catalogue changes, which is what happens the moment an
   * import finishes — otherwise the part you just uploaded with a photograph
   * comes back drawn as a render until the next reload.
   */
  useEffect(() => {
    let live = true;
    void listPhotoIds().then((ids) => { if (live) setPhotos(ids); });
    return () => { live = false; };
  }, [catalog]);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const parts = catalog.parts ?? [];

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = parts.filter((part) => {
      if (!onShelf(part, shelf, doc)) return false;
      if (needle.length === 0) return true;
      return (
        part.name.toLowerCase().includes(needle) ||
        part.file.toLowerCase().includes(needle) ||
        part.group.toLowerCase().includes(needle)
      );
    });
    return [...matches].sort((a, b) => compare(a, b, sort));
  }, [parts, query, shelf, sort, doc]);

  const chosenCount = useMemo(
    () => parts.filter((p) => p.type !== 'panel' && inProject(doc, p.id)).length,
    [parts, doc],
  );

  return (
    <div className="modal-scrim lib-scrim" role="presentation" onPointerDown={onClose}>
      <div
        className="lib"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lib-title"
        tabIndex={-1}
        ref={dialogRef}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="lib__head">
          <div className="lib__headline">
            <h2 className="lib__title" id="lib-title">Parts library</h2>
            <p className="lib__sub tabular-nums">
              {parts.length} part{parts.length === 1 ? '' : 's'} to choose from ·{' '}
              {chosenCount} in this project
            </p>
          </div>

          <div className="lib__headtools">
            <input
              type="search"
              className="lib__search"
              value={query}
              placeholder="Search parts"
              aria-label="Search the library by name or file"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="lib__sort">
              <span className="visually-hidden">Sort by</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                {SORTS.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </label>
            <label className="button button--primary lib__upload">
              Upload a model
              <input
                type="file"
                accept={MODEL_ACCEPT}
                multiple
                onChange={(e) => {
                  if (e.target.files) onUpload(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
            <button
              type="button"
              className="lib__close"
              onClick={onClose}
              aria-label="Close the library"
              title="Close (Esc)"
            >
              ×
            </button>
          </div>
        </header>

        <nav className="lib__shelves" aria-label="Filter the library">
          {SHELVES.map((s) => (
            <button
              key={s.id}
              type="button"
              className="lib__shelf"
              data-active={shelf === s.id ? 'true' : undefined}
              aria-pressed={shelf === s.id}
              title={s.note}
              onClick={() => setShelf(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="lib__scroll">
          {shown.length === 0 ? (
            <p className="lib__empty">
              {query.trim().length > 0
                ? `Nothing matches “${query.trim()}”. Try part of a file name, or a word from the model’s title.`
                : shelf === 'mine'
                  ? 'You have not uploaded anything yet. Press Upload a model, or drop an STL or 3MF anywhere on this window.'
                  : shelf === 'project'
                    ? 'No parts in this project yet. Switch to Everything and add the ones you want to print.'
                    : 'Nothing on this shelf.'}
            </p>
          ) : (
            <ul className="lib__grid" role="list">
              {shown.map((part) => (
                <PartCard
                  key={part.id}
                  part={part}
                  chosen={inProject(doc, part.id)}
                  hasPhoto={photos.has(part.id)}
                  onAdd={onAdd}
                  onRemove={onRemove}
                  onInspect={onInspect}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          )}
        </div>

        <footer className="lib__foot">
          <p className="lib__hint">
            Adding a part puts it in the rail on the left, ready to drag onto the wall. What
            you place is what the parts list says to print.
          </p>
          <button type="button" className="button button--primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
