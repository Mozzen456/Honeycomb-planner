/**
 * Turning a BOM into something the user can actually take to a printer.
 *
 * Three formats, three audiences:
 *   - CSV for a spreadsheet (RFC 4180, so a part called `Hook, 25mm "long"`
 *     survives Excel, Numbers and every parser in between).
 *   - Markdown for a checklist you tick off over several printing sessions.
 *   - HTML for the sheet you print and tape to the printer — black on white,
 *     legible over pretty.
 *
 * All four functions are pure string builders. `toPrintableHtml` deliberately
 * touches no DOM API: it returns markup, and the caller decides whether that
 * becomes a Blob, a new window or a file.
 *
 * Convention, set by `bom.ts` and followed here: `BomLine.grams` and `.metres`
 * are the **line totals** — the catalogue's per-part estimate already multiplied
 * by `quantity`. The per-unit columns in the CSV come from the line's own
 * per-unit fields, never from dividing a rounded total back out.
 *
 * Every sheet carries what is STILL TO PRINT as well as the quantity, because a
 * build happens over weeks: the copy taped to the printer is worth nothing if it
 * cannot tell you what today's job is.
 */

import { bedFor } from './constants';
import type { Bom, BomLine, LayoutDoc } from './types';

/**
 * The printer, as a person can check it against their own.
 *
 * The id alone was fine while every bed was a preset; a custom one prints as
 * "custom", which tells a reader nothing about the plates in front of them.
 * `bedFor` gives the size back with it.
 */
const bedName = (doc: Partial<LayoutDoc>): string =>
  bedFor(doc.bedId ?? '', doc.customBed)?.label ?? doc.bedId ?? '';

// ---------------------------------------------------------------------------
// Number and text formatting
// ---------------------------------------------------------------------------

/** Trim a float to `dp` decimals with no trailing zeros — 4.50 → "4.5". */
function num(value: number, dp = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  const fixed = value.toFixed(dp);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

const lines = (parts: string[]): string => parts.join('\n');

/** A whole count, never negative — quantities, printed, still to print. */
const whole = (value: number | undefined | null): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

// ---------------------------------------------------------------------------
// CSV — RFC 4180
// ---------------------------------------------------------------------------

const CSV_HEADER = [
  'section',
  'quantity',
  'printed',
  'to_print',
  'part_id',
  'part',
  'type',
  'file',
  'supports',
  'footprint_estimated',
  'print_estimated',
  'fastener_count_unknown',
  'already_in_the_wall',
  'color',
  'grams_each',
  'metres_each',
  'grams_total',
  'metres_total',
];

/**
 * Quote a field per RFC 4180 §2.6/2.7: fields containing a comma, a double
 * quote or a line break are wrapped in double quotes, and internal quotes are
 * doubled. Everything else is emitted bare.
 */
function csvField(value: string | number): string {
  const s = typeof value === 'number' ? num(value) : String(value ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const csvRow = (cells: (string | number)[]): string => cells.map(csvField).join(',');

/**
 * Per-unit figures come from the line's own catalogue values.
 *
 * They used to be computed as `total / quantity`, which divides a number that
 * has already been rounded: six parts at 4.63 g each total 27.8, and 27.8 / 6
 * printed as 4.6. The spreadsheet then disagreed with the catalogue in its last
 * digit for no reason a reader could see. `bom.ts` carries the unrounded
 * per-unit value through, and this reads it.
 */
function csvLineFor(section: string, line: BomLine): (string | number)[] {
  const q = Number.isFinite(line.quantity) ? line.quantity : 0;
  return [
    section,
    num(q, 0),
    num(whole(line.printed), 0),
    num(whole(line.toPrint), 0),
    line.partId ?? '',
    line.name ?? '',
    line.type ?? 'unknown',
    line.file ?? '',
    line.supports ? 'yes' : 'no',
    line.needsReview ? 'yes' : 'no',
    line.estimated ? 'yes' : 'no',
    line.fastenersUnknown ? 'yes' : 'no',
    num(line.providedBySockets ?? 0, 0),
    line.color ?? '',
    num(line.gramsEach ?? 0),
    num(line.metresEach ?? 0),
    num(line.grams),
    num(line.metres),
  ];
}

/**
 * The whole BOM as CSV, header row first, CRLF line endings as the RFC
 * specifies. Bought hardware is included with empty print figures rather than
 * omitted — a shopping list that lives in a different file gets forgotten.
 */
export function toCsv(bom: Bom): string {
  const rows: string[] = [csvRow(CSV_HEADER)];
  for (const line of bom.printed ?? []) rows.push(csvRow(csvLineFor('printed', line)));
  for (const line of bom.fasteners ?? []) rows.push(csvRow(csvLineFor('fastener', line)));
  for (const buy of bom.shopping ?? []) {
    // Bought, not printed: `printed` and `to_print` are left EMPTY rather than
    // zeroed. A zero would read as "none of these bought yet", which is a claim
    // this app has no way to make — nobody ticks a screw off in here.
    const row: (string | number)[] = new Array(CSV_HEADER.length).fill('');
    row[0] = 'shopping';
    row[1] = num(Number.isFinite(buy.count) ? buy.count : 0, 0);
    row[CSV_HEADER.indexOf('part')] = buy.item ?? '';
    row[CSV_HEADER.indexOf('type')] = 'bought';
    rows.push(csvRow(row));
  }
  return rows.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Markdown checklist
// ---------------------------------------------------------------------------

/**
 * Escape the characters that would break a Markdown *table cell*: a pipe ends
 * the cell, and a backslash before it would otherwise escape our escape.
 * Newlines collapse, because a table cell cannot contain one.
 */
function mdCell(value: string): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/** Outside tables only the pipe needs escaping in practice, plus line breaks. */
function mdText(value: string): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

function checklistLine(line: BomLine): string {
  const q = Number.isFinite(line.quantity) ? line.quantity : 0;
  const done = whole(line.printed);
  const left = whole(line.toPrint);
  const detail: string[] = [];
  // What is LEFT leads, and the box is ticked when there is nothing left — the
  // checklist is the same list as the panel's counts, in a file you can carry.
  if (done > 0) detail.push(left > 0 ? `${num(done, 0)} of ${num(q, 0)} printed` : 'all printed');
  // Which filament to load. Before the weight, because it is what you change on
  // the machine rather than something you read off it.
  if (line.color) detail.push(`in ${line.color}`);
  if (line.grams > 0) detail.push(`${num(line.grams, 1)} g`);
  if (line.supports) detail.push('needs supports');
  // The sheet you carry to the printer is the copy that gets used, so the two
  // "this is a model, not a measurement" markers travel with it. On screen they
  // are the `est.` badge; here they are words, because a badge does not print.
  if (line.needsReview) detail.push('footprint estimated');
  if (line.estimated) detail.push('filament estimated');
  // The one that stops a build: you get to the wall and find out the parts list
  // never knew how many inserts this thing takes.
  if (line.fastenersUnknown) detail.push('CHECK how many inserts this needs');
  // Not a warning: it is the reason the number is what it is, and the sheet is
  // the copy someone counts parts against at the printer.
  if (line.providedBySockets > 0) {
    detail.push(`${line.providedBySockets} more already in the wall fasteners`);
  }
  const tail = detail.length ? ` — ${detail.join(', ')}` : '';
  const file = line.file ? ` \`${mdText(line.file)}\`` : '';
  const box = left === 0 && q > 0 ? '- [x]' : '- [ ]';
  // The count is what is STILL TO PRINT, which is the number you act on. The
  // quantity is beside it whenever the two differ, so the sheet never looks like
  // it has quietly changed the size of the job.
  const count = left === q ? `${num(q, 0)} ×` : `${num(left, 0)} of ${num(q, 0)} ×`;
  return `${box} **${count}** ${mdText(line.name || line.partId)}${tail}${file}`;
}

function section(title: string, body: string[]): string[] {
  return ['', `## ${title}`, '', ...(body.length ? body : ['_Nothing in this section._'])];
}

/**
 * A checklist you can genuinely work from: totals at the top so you know what
 * you are committing to, then one tickable line per part, grouped the way the
 * build actually happens — panels first (nothing mounts without them), then the
 * accessories, then the small printed hardware, then the trip to the shop.
 */
export function toMarkdownChecklist(bom: Bom, doc: LayoutDoc): string {
  const printed = bom.printed ?? [];
  const panels = printed.filter((l) => l.type === 'panel');
  const accessories = printed.filter((l) => l.type !== 'panel');
  const fasteners = bom.fasteners ?? [];
  const shopping = bom.shopping ?? [];
  const totals = bom.totals;

  const out: string[] = [];
  out.push(`# ${mdText(doc.name || 'Untitled layout')} — build checklist`);
  out.push('');
  out.push(
    `Wall ${num(doc.wall?.widthMm ?? 0)} × ${num(doc.wall?.heightMm ?? 0)} mm · bed \`${mdText(bedName(doc))}\``,
  );
  out.push('');
  out.push('| Total | Value |');
  out.push('| --- | ---: |');
  out.push(`| Still to print | ${mdCell(num(totals?.toPrint ?? 0, 0))} |`);
  out.push(`| Already printed | ${mdCell(num(totals?.printed ?? 0, 0))} |`);
  out.push(`| Parts in all | ${mdCell(num(totals?.parts ?? 0, 0))} |`);
  out.push(`| Distinct parts | ${mdCell(num(totals?.distinctParts ?? 0, 0))} |`);
  out.push(`| Filament | ${mdCell(`${num(totals?.grams ?? 0, 1)} g`)} |`);
  out.push(`| Filament length | ${mdCell(`${num(totals?.metres ?? 0, 1)} m`)} |`);

  out.push(...section('Panels', panels.map(checklistLine)));
  out.push(...section('Accessories', accessories.map(checklistLine)));
  out.push(...section('Inserts & fasteners', fasteners.map(checklistLine)));
  out.push(
    ...section(
      'Shopping list',
      shopping.map((s) => `- [ ] **${num(Number.isFinite(s.count) ? s.count : 0, 0)} ×** ${mdText(s.item)}`),
    ),
  );

  const issues = bom.issues ?? [];
  if (issues.length > 0) {
    out.push('');
    out.push('## Problems to fix first');
    out.push('');
    out.push('| Level | Problem |');
    out.push('| --- | --- |');
    for (const issue of issues) {
      out.push(`| ${mdCell(issue.level)} | ${mdCell(issue.message)} |`);
    }
  }

  out.push('');
  return lines(out);
}

// ---------------------------------------------------------------------------
// Printable HTML
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlRows(rows: BomLine[]): string {
  if (rows.length === 0) {
    return '<tr class="empty"><td colspan="6">Nothing in this section.</td></tr>';
  }
  return rows
    .map((line) => {
      const q = Number.isFinite(line.quantity) ? line.quantity : 0;
      const done = whole(line.printed);
      const left = whole(line.toPrint);
      return lines([
        left === 0 && q > 0 ? '<tr class="done">' : '<tr>',
        // Pre-ticked when there is nothing left to print, so the sheet you take
        // to the printer starts where the app left off rather than at zero.
        left === 0 && q > 0 ? '  <td class="tick tick--done"></td>' : '  <td class="tick"></td>',
        `  <td class="qty">${escapeHtml(num(left, 0))}</td>`,
        `  <td class="name">${escapeHtml(line.name || line.partId)}` +
          (line.file ? `<span class="file">${escapeHtml(line.file)}</span>` : '') +
          (line.color ? `<span class="flag">${escapeHtml(line.color)}</span>` : '') +
          (line.supports ? '<span class="flag">supports</span>' : '') +
          (line.needsReview ? '<span class="flag">footprint est.</span>' : '') +
          (line.estimated ? '<span class="flag">filament est.</span>' : '') +
          (line.fastenersUnknown ? '<span class="flag">check fixings</span>' : '') +
          '</td>',
        `  <td class="n">${escapeHtml(done > 0 ? `${num(done, 0)} of ${num(q, 0)}` : num(q, 0))}</td>`,
        `  <td class="n">${escapeHtml(num(line.grams, 1))} g</td>`,
        `  <td class="n">${escapeHtml(num(line.metres, 1))} m</td>`,
        '</tr>',
      ]);
    })
    .join('\n');
}

function htmlSection(title: string, rows: BomLine[]): string {
  return lines([
    '<section>',
    `<h2>${escapeHtml(title)}</h2>`,
    '<table>',
    '<thead><tr><th class="tick"></th><th class="qty">To print</th><th>Part</th><th class="n">Printed</th><th class="n">Filament</th><th class="n">Length</th></tr></thead>',
    '<tbody>',
    htmlRows(rows),
    '</tbody>',
    '</table>',
    '</section>',
  ]);
}

/**
 * One self-contained page: inline CSS, no external request of any kind, so it
 * prints identically from a file:// URL on a machine with no network. Rows are
 * kept off page breaks, numbers are tabular so columns line up, and everything
 * is black on white because this is going through a laser printer.
 */
export function toPrintableHtml(bom: Bom, doc: LayoutDoc): string {
  const printed = bom.printed ?? [];
  const panels = printed.filter((l) => l.type === 'panel');
  const accessories = printed.filter((l) => l.type !== 'panel');
  const fasteners = bom.fasteners ?? [];
  const shopping = bom.shopping ?? [];
  const totals = bom.totals;
  const issues = bom.issues ?? [];
  const title = doc.name || 'Untitled layout';

  const css = `
:root { color-scheme: only light; }
* { box-sizing: border-box; }
html, body { background: #fff; color: #000; }
body {
  margin: 0; padding: 16mm 14mm;
  font: 11pt/1.45 "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
h1 { font-size: 18pt; margin: 0 0 2mm; letter-spacing: -0.01em; }
h2 { font-size: 12pt; margin: 0 0 2mm; text-transform: uppercase; letter-spacing: 0.08em; }
.meta { font-size: 9.5pt; margin: 0 0 6mm; }
.totals { display: flex; flex-wrap: wrap; gap: 0 10mm; border-top: 1.5pt solid #000;
          border-bottom: 1.5pt solid #000; padding: 3mm 0; margin: 0 0 8mm; }
.totals div { min-width: 26mm; }
.totals dt { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.08em; }
.totals dd { margin: 0; font-size: 13pt; font-weight: 700; }
section { margin: 0 0 8mm; break-inside: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 1.6mm 2mm; vertical-align: top;
         border-bottom: 0.5pt solid #999; }
thead th { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em;
           border-bottom: 1pt solid #000; }
tr { break-inside: avoid; page-break-inside: avoid; }
thead { display: table-header-group; }
td.tick, th.tick { width: 7mm; }
td.tick::before { content: ""; display: block; width: 4.5mm; height: 4.5mm;
                  border: 1pt solid #000; margin-top: 0.6mm; }
/* Already printed: the box arrives ticked, so the sheet starts where the app
   left off. Solid rather than a drawn tick — a laser printer at 8pt makes a
   glyph look like dirt, and a filled square cannot be misread. */
td.tick--done::before { background: #000; }
tr.done td.name, tr.done td.qty, tr.done td.n { color: #555; }
td.qty, th.qty { width: 12mm; font-weight: 700; }
td.n, th.n { text-align: right; width: 22mm; white-space: nowrap; }
td.name .file { display: block; font-size: 8pt; word-break: break-all; }
td.name .flag { display: inline-block; margin-top: 0.5mm; font-size: 8pt;
                border: 0.5pt solid #000; padding: 0 1mm; }
tr.empty td { font-style: italic; }
.issues { border: 1.5pt solid #000; padding: 3mm; margin: 0 0 8mm; }
.issues ul { margin: 1mm 0 0; padding-left: 5mm; }
.issues li { margin: 0.5mm 0; }
.foot { margin-top: 10mm; font-size: 8pt; border-top: 0.5pt solid #999; padding-top: 2mm; }
@page { margin: 12mm; }
@media print {
  body { padding: 0; font-size: 10pt; }
  h1 { font-size: 16pt; }
  section { break-inside: auto; }
  .issues, .totals { break-inside: avoid; }
  a[href]::after { content: ""; }
}
@media screen {
  body { max-width: 210mm; margin: 0 auto; }
}`.trim();

  const shoppingHtml =
    shopping.length === 0
      ? '<tr class="empty"><td colspan="3">Nothing to buy.</td></tr>'
      : shopping
          .map(
            (s) =>
              `<tr><td class="tick"></td><td class="qty">${escapeHtml(
                num(Number.isFinite(s.count) ? s.count : 0, 0),
              )}</td><td>${escapeHtml(s.item)}</td></tr>`,
          )
          .join('\n');

  const issuesHtml =
    issues.length === 0
      ? ''
      : lines([
          '<div class="issues">',
          `<h2>${escapeHtml(`${issues.length} problem${issues.length === 1 ? '' : 's'} in this layout`)}</h2>`,
          '<ul>',
          ...issues.map(
            (i) => `<li><strong>${escapeHtml(i.level)}:</strong> ${escapeHtml(i.message)}</li>`,
          ),
          '</ul>',
          '</div>',
        ]);

  return lines([
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} — print list</title>`,
    `<style>${css}</style>`,
    '</head>',
    '<body>',
    `<h1>${escapeHtml(title)}</h1>`,
    '<p class="meta">' +
      `Wall ${escapeHtml(num(doc.wall?.widthMm ?? 0))} &times; ${escapeHtml(num(doc.wall?.heightMm ?? 0))} mm` +
      ` &middot; bed ${escapeHtml(bedName(doc))}` +
      ` &middot; ${escapeHtml(num(doc.panels?.length ?? 0, 0))} panels` +
      ` &middot; ${escapeHtml(num(doc.items?.length ?? 0, 0))} placed parts</p>`,
    '<dl class="totals">',
    `<div><dt>To print</dt><dd>${escapeHtml(num(totals?.toPrint ?? 0, 0))}</dd></div>`,
    `<div><dt>Printed</dt><dd>${escapeHtml(num(totals?.printed ?? 0, 0))}</dd></div>`,
    `<div><dt>Parts</dt><dd>${escapeHtml(num(totals?.parts ?? 0, 0))}</dd></div>`,
    `<div><dt>Distinct</dt><dd>${escapeHtml(num(totals?.distinctParts ?? 0, 0))}</dd></div>`,
    `<div><dt>Filament</dt><dd>${escapeHtml(num(totals?.grams ?? 0, 1))} g</dd></div>`,
    `<div><dt>Length</dt><dd>${escapeHtml(num(totals?.metres ?? 0, 1))} m</dd></div>`,
    '</dl>',
    issuesHtml,
    htmlSection('Panels', panels),
    htmlSection('Accessories', accessories),
    htmlSection('Inserts & fasteners', fasteners),
    lines([
      '<section>',
      '<h2>Shopping list</h2>',
      '<table>',
      '<thead><tr><th class="tick"></th><th class="qty">Qty</th><th>Item</th></tr></thead>',
      '<tbody>',
      shoppingHtml,
      '</tbody>',
      '</table>',
      '</section>',
    ]),
    '<p class="foot">Honeycomb Planner print list. Quantities are what is still to print; filament figures are slicer estimates for the recorded profile.</p>',
    '</body>',
    '</html>',
    '',
  ]);
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

/** Windows refuses these as file names whatever the extension. */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

const MAX_STEM = 64;

/**
 * A file name that will survive Windows, macOS and Linux, derived from whatever
 * the user typed in the name box — including nothing at all.
 */
export function downloadName(doc: LayoutDoc, ext: string): string {
  const raw = typeof doc?.name === 'string' ? doc.name : '';

  let stem = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ') // control characters
    .replace(/[/\\:*?"<>|]/g, ' ') // characters no filesystem agrees on
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim()
    .replace(/^\.+/, '') // a leading dot hides the file on Unix
    .replace(/[. ]+$/, '') // Windows silently strips these — do it visibly
    .trim();

  if (stem.length > MAX_STEM) stem = stem.slice(0, MAX_STEM).replace(/[. ]+$/, '').trim();
  if (stem.length === 0) stem = 'layout';
  if (RESERVED.has(stem.toLowerCase())) stem = `${stem}-layout`;

  const suffix = String(ext ?? '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase()
    .slice(0, 12);

  return suffix.length === 0 ? stem : `${stem}.${suffix}`;
}
