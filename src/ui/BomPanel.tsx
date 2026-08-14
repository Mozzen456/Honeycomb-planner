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
 *   - `BomLine.grams | metres` are LINE TOTALS. The catalogue's per-unit
 *     estimate has already been multiplied by `quantity`. Nothing here
 *     multiplies again.
 *   - Rounding is for display only. `bom.ts` rounds once at its own boundary;
 *     this file never feeds a rounded number back into anything.
 *
 * The counts are the same: `printed` and `toPrint` arrive already capped at the
 * quantity, so nothing here compares, clamps or subtracts. It reports what the
 * user did — a number typed, or a step up or down — and draws what comes back.
 */

import { useMemo } from 'react';

import { colorsInUse } from '../core/colors';
import { ColorSwatch } from './ColorSwatch';
import { Icon } from './Icon';
import { NumberField } from './NumberField';
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
  /**
   * The line whose parts are currently lit on the wall, by partId.
   *
   * Passed back in rather than tracked here, because the shell owns it: the
   * wall is what the highlight is FOR, and Escape clears it from a keyboard
   * handler this component knows nothing about. Marking the row is how you find
   * your way back to it in a sixty-line list.
   */
  litLine?: string | null;
  /** Colour everything on a line — every plate of that shape, every hook. */
  onSetLineColor?: (lineKey: string, color: string | undefined) => void;
  /** Every colour back to the theme's. Shown only once something is coloured. */
  onClearColors?: () => void;
  /** Index into `bom.issues` as given — not the display order. */
  onDismissIssue?: (index: number) => void;
  /**
   * How many of a line have been printed, as an absolute count. For the typed
   * field and for `all` / `none`, where the number IS what the user said.
   */
  onSetPrinted?: (partId: string, count: number) => void;
  /**
   * One more, or one fewer — as a CHANGE, not as a number.
   *
   * The two are not interchangeable and this is the load-bearing half. A button
   * in a rendered list only knows the count as of its last render, so three
   * quick clicks each compute `printed + 1` from the same starting value and
   * the third overwrites the first two: driving the running app, `+ + +` on a
   * 12-plate line recorded ONE. The store owns the count, so the store does the
   * arithmetic. `max` is the line's quantity.
   */
  onBumpPrinted?: (partId: string, delta: number, max: number) => void;
  /** Back to nothing printed — the start of a second wall from the same plan. */
  onResetPrinted?: () => void;
  /**
   * Give the wall fixings back to the planner, undoing every move and removal.
   * Shown only once there is something to undo — the count comes off the
   * document, so the button cannot appear on a plan nobody has touched.
   */
  onResetFixings?: () => void;
}

/**
 * The ceiling on a typed count. Not a rule about printing — it is the same
 * bound the loader puts on a stored count, so a number typed here and a number
 * read out of a file cannot disagree about what is a count.
 */
const MAX_PRINTED = 100_000;

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
  'panel-unfixed': {
    title: 'A panel has no wall fixing left',
    advice:
      'You removed the one holding it. Drag another fixing onto it, or press Reset fixings below to give the plan back its own.',
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

/**
 * The count of a line that have been printed: type it, or step it.
 *
 * The two arrive by different routes on purpose. Typing, `all` and `none` state
 * a NUMBER, so they go through `onSetPrinted`. The ± buttons state a CHANGE and
 * go through `onBumpPrinted`, because this component only knows the count as of
 * its last render and a fast hand does not wait for one — see the note on the
 * prop. `NumberField` on `confirm` for the same reason a zone's size uses it:
 * every commit is an undo step, and typing `12` over `2` should not leave `1`
 * and `12` behind it in the history.
 */
interface PrintedProps {
  line: BomLine;
  onSetPrinted: (partId: string, count: number) => void;
  onBumpPrinted?: (partId: string, delta: number, max: number) => void;
}

function PrintedControl({ line, onSetPrinted, onBumpPrinted }: PrintedProps): JSX.Element {
  const label = line.name.length > 0 ? line.name : line.partId;
  const set = (count: number): void => onSetPrinted(line.partId, count);
  const step = (delta: number): void =>
    onBumpPrinted === undefined
      ? set(line.printed + delta)
      : onBumpPrinted(line.partId, delta, line.quantity);
  return (
    <div className="bom-printed">
      <button
        type="button"
        className="bom-printed__step hit-area"
        onClick={() => step(-1)}
        disabled={line.printed <= 0}
        title={`One fewer ${label} printed`}
        aria-label={`One fewer ${label} printed`}
      >
        −
      </button>
      <NumberField
        className="bom-printed__field tabular-nums"
        value={line.printed}
        min={0}
        max={MAX_PRINTED}
        step={1}
        commitOn="confirm"
        onCommit={set}
        title={`How many ${label} you have printed`}
        aria-label={`How many ${label} you have printed`}
      />
      <button
        type="button"
        className="bom-printed__step hit-area"
        onClick={() => step(1)}
        disabled={line.toPrint <= 0}
        title={
          line.toPrint <= 0
            ? `All ${formatCount(line.quantity)} printed`
            : `One more ${label} printed`
        }
        aria-label={`One more ${label} printed`}
      >
        +
      </button>
      {/* The one button that gets used most: a plate goes on the bed as a batch,
          and nobody wants to click + eleven times. */}
      <button
        type="button"
        className="bom-printed__all"
        onClick={() => set(line.toPrint <= 0 ? 0 : line.quantity)}
        title={
          line.toPrint <= 0
            ? `Mark ${label} as not printed yet`
            : `Mark all ${formatCount(line.quantity)} ${label} as printed`
        }
      >
        {line.toPrint <= 0 ? 'none' : 'all'}
      </button>
    </div>
  );
}

interface SectionProps {
  title: string;
  lines: BomLine[];
  index: ReadonlyMap<string, CatalogPart>;
  onSelectPart?: (partId: string) => void;
  litLine?: string | null;
  colors?: LayoutDoc['colors'];
  onSetLineColor?: (lineKey: string, color: string | undefined) => void;
  onSetPrinted?: (partId: string, count: number) => void;
  onBumpPrinted?: (partId: string, delta: number, max: number) => void;
  emptyText: string;
}

function BomSection(
  { title, lines, index, onSelectPart, litLine, colors, onSetLineColor, onSetPrinted,
    onBumpPrinted, emptyText }: SectionProps,
): JSX.Element {
  const left = lines.reduce((sum, line) => sum + finite(line.toPrint), 0);
  const total = lines.reduce((sum, line) => sum + finite(line.quantity), 0);
  return (
    <section className="bom-section">
      <h3 className="bom-section__title">
        {title}
        <span className="bom-section__count tabular-nums">
          {lines.length === 0 || left === total
            ? formatCount(lines.length)
            : `${formatCount(left)} left`}
        </span>
      </h3>

      {lines.length === 0 ? (
        <p className="bom-section__empty">{emptyText}</p>
      ) : (
        <table className="bom-table">
          <colgroup>
            <col className="bom-table__col--qty" />
            <col />
            <col className="bom-table__col--printed" />
            <col className="bom-table__col--filament" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="bom-table__num" title="How many are still to print">
                To print
              </th>
              <th scope="col">Part</th>
              <th scope="col" className="bom-table__num">
                Printed
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
              const done = line.toPrint <= 0 && line.quantity > 0;
              const lit = litLine === line.partId;
              return (
                <tr
                  key={line.partId}
                  className={done ? 'bom-line bom-line--done' : 'bom-line'}
                  // Which line the wall is lit for. An attribute rather than a
                  // class so the row keeps its two existing states without a
                  // third combination to spell out.
                  data-lit={lit ? 'true' : undefined}
                  aria-current={lit ? 'true' : undefined}
                >
                  {/* What is LEFT, because that is the number you act on. The
                      quantity stays underneath it whenever the two differ, so
                      the list never looks like it shrank the job. */}
                  <td className="bom-table__num bom-line__qty">
                    {formatCount(line.toPrint)}
                    {line.printed > 0 ? (
                      <span className="bom-line__sub tabular-nums">
                        of {formatCount(line.quantity)}
                      </span>
                    ) : null}
                  </td>
                  <td className="bom-line__part">
                    <span className="bom-line__heading">
                      {/* Before the name, so the colours line up down the list
                          and read as a key to what is on the wall. */}
                      {onSetLineColor === undefined ? null : (
                        <ColorSwatch
                          className="bom-line__swatch"
                          label={`Colour for ${label}`}
                          value={colors?.lines?.[line.partId]}
                          fallback={line.type === 'panel' ? colors?.panels : colors?.parts}
                          onChange={(c) => onSetLineColor(line.partId, c)}
                          onClear={() => onSetLineColor(line.partId, undefined)}
                        />
                      )}
                      {onSelectPart === undefined ? (
                        <span className="bom-line__name">{label}</span>
                      ) : (
                        <button
                          type="button"
                          className="bom-line__name bom-line__name--button"
                          onClick={() => onSelectPart(line.partId)}
                          title={lit ? `Stop highlighting ${label}` : `Highlight ${label} on the wall`}
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
                      {/* Why the quantity is not higher: the wall fastener's own
                          sockets ARE inserts, so the parts hung on them do not
                          each need another one printed. */}
                      {line.providedBySockets > 0 ? (
                        <span
                          className="bom-line__flag"
                          title="Sockets in the wall fasteners already do this job, so these are not printed"
                        >
                          {line.providedBySockets} already in the wall
                        </span>
                      ) : null}
                      {done ? <span className="bom-line__flag bom-line__flag--done">printed</span> : null}
                    </span>
                  </td>
                  <td className="bom-table__num bom-line__printed">
                    {onSetPrinted === undefined ? (
                      formatCount(line.printed)
                    ) : (
                      <PrintedControl
                        line={line}
                        onSetPrinted={onSetPrinted}
                        onBumpPrinted={onBumpPrinted}
                      />
                    )}
                  </td>
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
  const {
    bom, catalog, doc, onExport, onSelectPart, litLine, onSetLineColor, onClearColors,
    onDismissIssue, onSetPrinted, onBumpPrinted, onResetPrinted, onResetFixings, extras,
  } = props;

  /**
   * How many wall fixings a person overruled. Off the DOCUMENT rather than off
   * the plan, because that is what "Reset fixings" undoes: a removal for a cell
   * the planner no longer proposes is still an edit this button would clear.
   */
  const edited =
    (doc.fixingEdits?.removed?.length ?? 0) + (doc.fixingEdits?.added?.length ?? 0);

  /** The colours this build actually uses — through the one function that knows
   *  which of the four levels answers for each thing on the wall. */
  const palette = useMemo(
    () => colorsInUse(doc, [...(bom.printed ?? []), ...(bom.fasteners ?? [])]),
    [doc, bom.printed, bom.fasteners],
  );

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
          {/*
            * The wall's own figures, and NOT the layout's name: the title bar
            * carries that name three inches away, in a bigger type, and a panel
            * heading that repeats it verbatim reads as a rendering fault. The
            * figures stay because they are the thing this list is counting, and
            * because the title bar drops them on a narrow window.
            */}
          <p className="bom-panel__wall tabular-nums">
            {formatCount(doc.wall?.widthMm)} × {formatCount(doc.wall?.heightMm)} mm ·{' '}
            {formatCount(doc.panels?.length)} panels · {formatCount(doc.items?.length)} placed
          </p>
        </div>

        {/*
          * A utility strip, not four decisions.
          *
          * These were four full-height bordered buttons with a filled blue one
          * at the front, which is the visual weight of a primary action — and
          * exporting is never why anyone opened this panel. They are one
          * segmented control now: the same four formats, one row, and Print
          * keeps an icon because it is the one that goes on the workshop wall.
          */}
        <div className="bom-panel__exports" role="group" aria-label="Export the parts list">
          {EXPORTS.map((entry) => (
            <button
              key={entry.format}
              type="button"
              className="button button--ghost button--sm bom-export"
              title={entry.hint}
              onClick={() => onExport(entry.format)}
            >
              {entry.format === 'print' ? <Icon name="printer" /> : null}
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
              bins into its cells. Everything you place is counted here — and as each batch comes
              off the printer you tick it off, so the list always says what is left to print.
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
              litLine={litLine}
              colors={doc.colors}
              onSetLineColor={onSetLineColor}
              onSetPrinted={onSetPrinted}
              onBumpPrinted={onBumpPrinted}
              emptyText="No panels or accessories placed yet."
            />
            <BomSection
              title="Inserts & fasteners"
              lines={fasteners}
              index={index}
              onSelectPart={onSelectPart}
              litLine={litLine}
              colors={doc.colors}
              onSetLineColor={onSetLineColor}
              onSetPrinted={onSetPrinted}
              onBumpPrinted={onBumpPrinted}
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
                  ? `, of which ${formatCount(bom.fixings.junctions)} ${
                      bom.fixings.junctions === 1 ? 'is a four-cell insert' : 'are four-cell inserts'
                    } bridging where panels meet`
                  : ''}
                .
                {/* Said out loud, because a spacing figure stops being the whole
                    truth the moment somebody moves one: the count above is the
                    plan AS EDITED, and this is how you get the planner's own
                    back. */}
                {edited > 0 ? (
                  <>
                    {' '}
                    <span className="bom-panel__edited">
                      {formatCount(edited)} moved or removed by hand
                    </span>
                    {onResetFixings === undefined ? null : (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="bom-totals__reset"
                          onClick={onResetFixings}
                          title="Put every wall fixing back where the planner had it"
                        >
                          Reset fixings
                        </button>
                      </>
                    )}
                  </>
                ) : null}
              </p>
            )}
          </>
        )}
        {extras}
      </div>

      <footer className="bom-totals" aria-label="Totals">
        <dl className="bom-totals__list">
          {/* The lead number is what is LEFT, because that is what the panel is
              asked while a wall is being built. The whole job is beside it. */}
          <div className="bom-totals__item bom-totals__item--lead">
            <dt className="bom-totals__label">Still to print</dt>
            <dd className="bom-totals__value bom-totals__value--lead tabular-nums">
              {formatCount(totals?.toPrint)}
              <span className="bom-totals__sub tabular-nums">
                of {formatCount(totals?.parts)}
              </span>
            </dd>
          </div>
          <div className="bom-totals__item">
            <dt className="bom-totals__label">Printed</dt>
            <dd className="bom-totals__value tabular-nums">
              {formatCount(totals?.printed)}
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
        {/* What to load in the printer. Only the colours something on this wall
            actually falls back to — a default nobody uses is not a spool you
            have to buy, and listing it would say otherwise. */}
        {palette.length > 0 && (
          <p className="bom-totals__palette">
            <span className="bom-totals__palette-label">
              {palette.length === 1 ? '1 colour' : `${formatCount(palette.length)} colours`}
            </span>
            {palette.map((colour) => (
              <span
                key={colour}
                className="bom-totals__chip"
                style={{ backgroundColor: colour }}
                title={colour}
              >
                <span className="visually-hidden">{colour}</span>
              </span>
            ))}
            {onClearColors !== undefined && (
              <button
                type="button"
                className="bom-totals__reset"
                onClick={onClearColors}
                title="Put every colour back to the way the wall is drawn by default"
              >
                Clear colours
              </button>
            )}
          </p>
        )}

        <div className="bom-totals__foot">
          <p className="bom-totals__note" title={catalog.slicerProfile}>
            Filament is a slicer estimate · {catalog.slicerProfile}
          </p>
          {/* Only once there is progress to lose — an empty list has nothing to
              reset, and the button would just be one more thing to read. */}
          {onResetPrinted !== undefined && finite(totals?.printed) > 0 ? (
            <button
              type="button"
              className="bom-totals__reset"
              onClick={onResetPrinted}
              title="Set every printed count back to none — building this wall again from scratch"
            >
              Reset printed
            </button>
          ) : null}
        </div>
      </footer>
    </aside>
  );
}
