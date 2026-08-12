/**
 * The parts list — the thing the user actually carries to the printer.
 *
 * Pure presentation: it takes a computed `Bom`, the catalogue it was computed
 * against and the document it describes, and renders them. It fetches nothing,
 * stores nothing and derives no numbers of its own beyond formatting. Every
 * action leaves through a callback.
 *
 * Two conventions inherited from `core/bom.ts` and worth restating, because
 * getting either wrong produces a list that looks right and is not:
 *
 *   - `BomLine.minutes | grams | metres` are LINE TOTALS. The catalogue's
 *     per-unit estimate has already been multiplied by `quantity`. Nothing here
 *     multiplies again.
 *   - Rounding is for display only. `bom.ts` rounds once at its own boundary;
 *     this file never feeds a rounded number back into anything.
 */

import { useMemo } from 'react';

import type { Bom, BomLine, Catalog, CatalogPart, Issue, LayoutDoc } from '../core/types';

import './BomPanel.css';

export type BomExportFormat = 'csv' | 'markdown' | 'print' | 'json';

export interface BomPanelProps {
  bom: Bom;
  catalog: Catalog;
  doc: LayoutDoc;
  onExport: (format: BomExportFormat) => void;
  /** Rendered under the parts list: obstacles, and the custom panels they force. */
  extras?: JSX.Element;
  /** Clicking a line highlights that part on the wall. */
  onSelectPart?: (partId: string) => void;
  /** Index into `bom.issues` as given — not the display order. */
  onDismissIssue?: (index: number) => void;
}

// ---------------------------------------------------------------------------
// Formatting. Display only: round late, round once, never round back into a sum.
// ---------------------------------------------------------------------------

function finite(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Whole things: parts, quantities, millimetres of wall. */
function formatCount(value: number | undefined | null): string {
  return String(Math.round(finite(value)));
}

/** One decimal, with the trailing `.0` dropped — 12.70 becomes "12.7", 8.0 "8". */
function formatDecimal(value: number | undefined | null): string {
  const fixed = finite(value).toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/**
 * Minutes as a print job is read: `5 h 15 m`, never `315.12 minutes`. Nobody
 * plans an afternoon in minutes, and a slicer's two decimal places are noise at
 * this scale.
 */
function formatMinutes(value: number | undefined | null): string {
  const total = Math.round(finite(value));
  if (total <= 0) return '0 m';
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} m`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} m`;
}

const formatGrams = (value: number | undefined | null): string => `${formatDecimal(value)} g`;
const formatMetres = (value: number | undefined | null): string => `${formatDecimal(value)} m`;

/** Last path segment of a repo-relative model path, for a link that has to fit. */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter((segment) => segment.length > 0);
  return parts.length === 0 ? path : (parts.at(-1) ?? path);
}

/**
 * A link the browser can follow. Paths are repo-relative (`models/…`) and are
 * kept relative here so the link survives the app being served from a subpath,
 * which is how it is built (`vite.config.ts`, `base: './'`).
 */
const fileHref = (path: string): string => encodeURI(path);

// ---------------------------------------------------------------------------
// Issues, in plain language
// ---------------------------------------------------------------------------

interface IssueCopy {
  /** What is wrong, in the user's words. The `code` is never shown. */
  title: string;
  /** What to do about it. */
  advice: string;
}

const ISSUE_COPY: Record<Issue['code'], IssueCopy> = {
  overlap: {
    title: 'Two parts are trying to use the same cell',
    advice: 'Move one of them to a free cell — only one part can occupy a cell.',
  },
  'off-panel': {
    title: 'A part hangs off the edge of the panels',
    advice: 'Drag it back over a panel, or add a panel underneath it.',
  },
  'crosses-seam': {
    title: 'A part straddles the join between two panels',
    advice:
      'Move it fully onto one panel, unless it is a bridging part meant to span the join.',
  },
  'no-panel': {
    title: 'There are no panels to mount anything on',
    advice: 'Place a wall panel first; everything else clips into a panel’s cells.',
  },
  'unknown-part': {
    title: 'A placed part is missing from the catalogue',
    advice:
      'The model file was renamed or removed. Re-run the catalogue scan, or delete the placement — it counts for nothing in this list.',
  },
  'no-room-for-mounts': {
    title: 'The panel has no free cells left for its own wall mounts',
    advice:
      'A panel hangs on the wall through its own cells. Clear enough of them for the countersunk inserts in the list below, or fit those first and plan around them.',
  },
  'panel-overlap': {
    title: 'Two panels cover the same cells',
    advice: 'Panels butt up against each other; slide one aside so they only touch.',
  },
};

const FALLBACK_COPY: IssueCopy = {
  title: 'Something in this layout needs attention',
  advice: 'Check the placement described below.',
};

const LEVEL_WORD: Record<Issue['level'], string> = {
  error: 'Error',
  warning: 'Warning',
};

// ---------------------------------------------------------------------------
// Catalogue lookups
// ---------------------------------------------------------------------------

/**
 * `needsReview` is written into every catalogue entry by `tools/scan.py`, but it
 * is not part of the `CatalogPart` contract in `core/types.ts` — which this
 * component does not own and must not edit. Read it structurally instead, and
 * treat anything other than an explicit `true` as "measured".
 */
function needsReview(part: CatalogPart | undefined): boolean {
  if (part === undefined) return false;
  return (part as unknown as { needsReview?: unknown }).needsReview === true;
}

const REVIEW_TOOLTIP =
  'The cell footprint for this part is a bounding-box estimate, not a measured ' +
  'cell-by-cell fit. Check it against the wall before you print a batch.';

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface SectionProps {
  title: string;
  lines: BomLine[];
  index: ReadonlyMap<string, CatalogPart>;
  onSelectPart?: (partId: string) => void;
  emptyText: string;
}

function BomSection({ title, lines, index, onSelectPart, emptyText }: SectionProps): JSX.Element {
  return (
    <section className="bom-section">
      <h3 className="bom-section__title">
        {title}
        <span className="bom-section__count tabular-nums">{formatCount(lines.length)}</span>
      </h3>

      {lines.length === 0 ? (
        <p className="bom-section__empty">{emptyText}</p>
      ) : (
        <table className="bom-table">
          <colgroup>
            <col className="bom-table__col--qty" />
            <col />
            <col className="bom-table__col--time" />
            <col className="bom-table__col--filament" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="bom-table__num">
                Qty
              </th>
              <th scope="col">Part</th>
              <th scope="col" className="bom-table__num">
                Time
              </th>
              <th scope="col" className="bom-table__num">
                Filament
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const part = index.get(line.partId);
              const label = line.name.length > 0 ? line.name : line.partId;
              return (
                <tr key={line.partId} className="bom-line">
                  <td className="bom-table__num bom-line__qty">{formatCount(line.quantity)}</td>
                  <td className="bom-line__part">
                    <span className="bom-line__heading">
                      {onSelectPart === undefined ? (
                        <span className="bom-line__name">{label}</span>
                      ) : (
                        <button
                          type="button"
                          className="bom-line__name bom-line__name--button"
                          onClick={() => onSelectPart(line.partId)}
                          title={`Highlight ${label} on the wall`}
                        >
                          {label}
                        </button>
                      )}
                      {needsReview(part) ? (
                        <abbr className="bom-line__review" title={REVIEW_TOOLTIP}>
                          est.
                        </abbr>
                      ) : null}
                    </span>
                    <span className="bom-line__meta">
                      {line.file.length > 0 ? (
                        <a className="bom-line__file" href={fileHref(line.file)} title={line.file}>
                          {fileName(line.file)}
                        </a>
                      ) : null}
                      {line.supports ? (
                        <span className="bom-line__flag">needs supports</span>
                      ) : null}
                    </span>
                  </td>
                  <td className="bom-table__num bom-line__time">{formatMinutes(line.minutes)}</td>
                  <td className="bom-table__num bom-line__filament">
                    {formatGrams(line.grams)}
                    <span className="bom-line__sub">{formatMetres(line.metres)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface ShoppingProps {
  items: { item: string; count: number }[];
}

function ShoppingSection({ items }: ShoppingProps): JSX.Element {
  return (
    <section className="bom-section">
      <h3 className="bom-section__title">
        Shopping list
        <span className="bom-section__count tabular-nums">{formatCount(items.length)}</span>
      </h3>
      <p className="bom-section__note">Bought, not printed.</p>

      {items.length === 0 ? (
        <p className="bom-section__empty">Nothing to buy for this layout.</p>
      ) : (
        <table className="bom-table">
          <colgroup>
            <col className="bom-table__col--qty" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="bom-table__num">
                Qty
              </th>
              <th scope="col">Item</th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.item} className="bom-line">
                <td className="bom-table__num bom-line__qty">{formatCount(entry.count)}</td>
                <td className="bom-line__part">
                  <span className="bom-line__name">{entry.item}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const EXPORTS: readonly { format: BomExportFormat; label: string; hint: string }[] = [
  { format: 'print', label: 'Print', hint: 'Open a printable sheet for the workshop wall' },
  { format: 'csv', label: 'CSV', hint: 'Download for a spreadsheet' },
  { format: 'markdown', label: 'Markdown', hint: 'Download a checklist you can tick off' },
  { format: 'json', label: 'JSON', hint: 'Download the layout file itself' },
];

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function BomPanel(props: BomPanelProps): JSX.Element {
  const { bom, catalog, doc, onExport, onSelectPart, onDismissIssue, extras } = props;

  const index = useMemo(() => {
    const map = new Map<string, CatalogPart>();
    for (const part of catalog.parts ?? []) {
      if (!map.has(part.id)) map.set(part.id, part);
    }
    return map;
  }, [catalog]);

  /**
   * Errors first, warnings after, original order preserved within a level — and
   * carrying the index the caller knows the issue by, which is its position in
   * `bom.issues`, not its position on screen.
   */
  const issues = useMemo(() => {
    const numbered = (bom.issues ?? []).map((issue, index_) => ({ issue, index: index_ }));
    const rank = (issue: Issue): number => (issue.level === 'error' ? 0 : 1);
    return numbered.sort((a, b) => rank(a.issue) - rank(b.issue));
  }, [bom.issues]);

  const printed = bom.printed ?? [];
  const fasteners = bom.fasteners ?? [];
  const shopping = bom.shopping ?? [];
  const totals = bom.totals;
  const isEmpty = printed.length === 0 && fasteners.length === 0 && shopping.length === 0;

  const errorCount = issues.filter((entry) => entry.issue.level === 'error').length;
  const warningCount = issues.length - errorCount;

  return (
    <aside className="bom-panel" aria-label="Parts list">
      <header className="bom-panel__head">
        <div className="bom-panel__identity">
          <h2 className="bom-panel__title">Parts list</h2>
          <p className="bom-panel__doc" title={doc.name}>
            {doc.name.length > 0 ? doc.name : 'Untitled layout'}
          </p>
          <p className="bom-panel__wall tabular-nums">
            {formatCount(doc.wall?.widthMm)} × {formatCount(doc.wall?.heightMm)} mm ·{' '}
            {formatCount(doc.panels?.length)} panels · {formatCount(doc.items?.length)} placed
          </p>
        </div>

        <div className="bom-panel__exports" role="group" aria-label="Export the parts list">
          {EXPORTS.map((entry) => (
            <button
              key={entry.format}
              type="button"
              className={
                entry.format === 'print'
                  ? 'button button--primary bom-export'
                  : 'button bom-export'
              }
              title={entry.hint}
              onClick={() => onExport(entry.format)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </header>

      <div className="bom-panel__scroll">
        {issues.length > 0 ? (
          <section className="bom-issues" aria-label="Problems with this layout">
            <h3 className="bom-issues__title">
              {errorCount > 0
                ? `${formatCount(errorCount)} to fix${
                    warningCount > 0 ? `, ${formatCount(warningCount)} to check` : ''
                  }`
                : `${formatCount(warningCount)} to check`}
            </h3>
            <ul className="bom-issues__list" role="list">
              {issues.map(({ issue, index: originalIndex }) => {
                const copy = ISSUE_COPY[issue.code] ?? FALLBACK_COPY;
                return (
                  <li
                    key={`${issue.code}-${originalIndex}`}
                    className={`bom-issue bom-issue--${issue.level}`}
                  >
                    <div className="bom-issue__body">
                      <p className="bom-issue__level">{LEVEL_WORD[issue.level]}</p>
                      <p className="bom-issue__title">{copy.title}</p>
                      <p className="bom-issue__detail">{issue.message}</p>
                      <p className="bom-issue__advice">{copy.advice}</p>
                    </div>
                    {onDismissIssue === undefined ? null : (
                      <button
                        type="button"
                        className="bom-issue__dismiss hit-area"
                        aria-label={`Dismiss: ${copy.title}`}
                        title="Dismiss"
                        onClick={() => onDismissIssue(originalIndex)}
                      >
                        ×
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {isEmpty ? (
          <div className="bom-empty">
            <h3 className="bom-empty__title">Nothing to print yet</h3>
            <p className="bom-empty__body">
              Drag a wall panel from the catalogue onto the wall, then drop hooks, shelves and
              bins into its cells. Everything you place is counted here — quantities, print time
              and filament — ready to take to the printer.
            </p>
            <p className="bom-empty__hint tabular-nums">
              {formatCount(catalog.parts?.length)} parts in the catalogue · wall{' '}
              {formatCount(doc.wall?.widthMm)} × {formatCount(doc.wall?.heightMm)} mm
            </p>
          </div>
        ) : (
          <>
            <BomSection
              title="Panels & accessories"
              lines={printed}
              index={index}
              onSelectPart={onSelectPart}
              emptyText="No panels or accessories placed yet."
            />
            <BomSection
              title="Inserts & fasteners"
              lines={fasteners}
              index={index}
              onSelectPart={onSelectPart}
              emptyText="Nothing here yet — inserts are added automatically by the parts that need them."
            />
            <ShoppingSection items={shopping} />
            {/* Fixings are an assembly figure, not a per-plate one: the spacing
                is what a builder has to sanity-check against their own wall. */}
            {bom.fixings.count > 0 && (
              <p className="bom-panel__fixings tabular-nums">
                {formatCount(bom.fixings.count)} wall fixings, spaced about{' '}
                {formatCount(bom.fixings.spacingMm)} mm apart
                {bom.fixings.perSquareMetre > 0
                  ? ` (${bom.fixings.perSquareMetre.toFixed(0)} per m²)`
                  : ''}
                {bom.fixings.junctions > 0
                  ? `, of which ${formatCount(bom.fixings.junctions)} are four-cell inserts bridging where panels meet`
                  : ''}
                .
              </p>
            )}
          </>
        )}
        {extras}
      </div>

      <footer className="bom-totals" aria-label="Totals">
        <dl className="bom-totals__list">
          <div className="bom-totals__item bom-totals__item--lead">
            <dt className="bom-totals__label">Print time</dt>
            <dd className="bom-totals__value bom-totals__value--lead tabular-nums">
              {formatMinutes(totals?.minutes)}
            </dd>
          </div>
          <div className="bom-totals__item">
            <dt className="bom-totals__label">Parts</dt>
            <dd className="bom-totals__value tabular-nums">
              {formatCount(totals?.parts)}
              <span className="bom-totals__sub tabular-nums">
                {formatCount(totals?.distinctParts)} distinct
              </span>
            </dd>
          </div>
          <div className="bom-totals__item">
            <dt className="bom-totals__label">Filament</dt>
            <dd className="bom-totals__value tabular-nums">
              {formatGrams(totals?.grams)}
              <span className="bom-totals__sub tabular-nums">{formatMetres(totals?.metres)}</span>
            </dd>
          </div>
        </dl>
        <p className="bom-totals__note" title={catalog.slicerProfile}>
          Slicer estimates · {catalog.slicerProfile}
        </p>
      </footer>
    </aside>
  );
}
