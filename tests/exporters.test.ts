/**
 * Exporters are judged by what happens on the far side: a CSV is only correct
 * if a parser gets the original strings back, so this file carries its own
 * RFC 4180 parser rather than asserting on quoting by eye.
 */

import { describe, expect, it } from 'vitest';

import { downloadName, toCsv, toMarkdownChecklist, toPrintableHtml } from '../src/core/exporters';
import type { Bom, BomLine, LayoutDoc } from '../src/core/types';

// ---------------------------------------------------------------------------
// A minimal RFC 4180 parser, written here so the CSV is checked by a reader
// that knows nothing about how it was written.
// ---------------------------------------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  let started = false;

  const endField = (): void => {
    row.push(field);
    field = '';
    started = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && !started) {
      quoted = true;
      started = true;
      i++;
      continue;
    }
    if (c === ',') {
      endField();
      i++;
      continue;
    }
    if (c === '\r' && text[i + 1] === '\n') {
      endRow();
      i += 2;
      continue;
    }
    if (c === '\n' || c === '\r') {
      endRow();
      i++;
      continue;
    }
    field += c;
    started = true;
    i++;
  }
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

/**
 * One field of a parsed row, BY COLUMN NAME.
 *
 * These assertions used to index by position — `row[11]` for grams each — so
 * adding a column to the sheet moved every expectation in the file silently:
 * the test still passed on the columns it had not reached and compared the
 * wrong two afterwards. The header row is the contract, so read through it.
 */
function field(rows: string[][], row: string[], column: string): string | undefined {
  const at = (rows[0] ?? []).indexOf(column);
  if (at < 0) throw new Error(`no such CSV column: ${column}`);
  return row[at];
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * `bom.ts` writes line *totals* into grams/metres, so the fixture does too:
 * 4 hooks at 4.25 g / 1.4 m each. Nothing printed yet unless a case says so.
 */
function line(over: Partial<BomLine> = {}): BomLine {
  const base: BomLine = {
    partId: 'hook-25',
    name: 'Hook 25 mm',
    file: 'models/accessories/hook-25.stl',
    type: 'accessory',
    quantity: 4,
    printed: 0,
    toPrint: 4,
    grams: 17,
    metres: 5.6,
    // Per-unit figures come from the catalogue, not from total / quantity:
    // 4 hooks at 4.25 g / 1.4 m each.
    gramsEach: 4.25,
    metresEach: 1.4,
    supports: false,
    needsReview: false,
    estimated: false,
    fastenersUnknown: false,
    providedBySockets: 0,
  };
  const merged = { ...base, ...over };
  // `toPrint` follows the quantity and the printed count the way `bom.ts` makes
  // it, unless the case states one — otherwise every fixture that overrides the
  // quantity would silently describe an impossible line.
  return over.toPrint === undefined
    ? { ...merged, toPrint: Math.max(0, merged.quantity - merged.printed) }
    : merged;
}

const NASTY_NAME = 'Hook, 25mm "long"';

function makeBom(over: Partial<Bom> = {}): Bom {
  return {
    printed: [
      line({ partId: 'panel-7x8', name: 'Panel 7 × 8', type: 'panel', quantity: 2, grams: 210, metres: 70, file: 'models/panels/panel-7x8.stl' }),
      line(),
      line({ partId: 'bin-s', name: NASTY_NAME, quantity: 4, file: 'models/bins/bin, small.stl' }),
    ],
    fasteners: [
      line({ partId: 'insert-std', name: 'Standard insert', type: 'insert', quantity: 24, grams: 1.2, metres: 0.4, file: 'models/hardware/insert.stl' }),
    ],
    shopping: [
      { item: 'M4 × 30 screw', count: 12 },
      { item: 'Wall plug, 8 mm "brown"', count: 12 },
    ],
    fixings: { count: 0, junctions: 0, spacingMm: 220, perSquareMetre: 0, starvedPanelIds: [] },
    totals: { parts: 33, printed: 0, toPrint: 33, grams: 470.5, metres: 158.4, distinctParts: 4 },
    issues: [],
    ...over,
  };
}

function makeDoc(over: Partial<LayoutDoc> = {}): LayoutDoc {
  return {
    schemaVersion: 1,
    id: 'doc-1',
    name: 'Garage wall',
    wall: { widthMm: 2400, heightMm: 1200 },
    bedId: 'bed256',
    panels: [{ id: 'p1', partId: 'panel-7x8', origin: { q: 0, r: 0 }, columns: 7, rows: 8 }],
    items: [{ id: 'i1', partId: 'hook-25', at: { q: 1, r: 1 }, rotation: 0 }],
    groups: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

describe('toCsv', () => {
  it('starts with a header row naming every column', () => {
    const rows = parseCsv(toCsv(makeBom()));
    expect(rows[0]).toEqual([
      'section',
      'quantity',
      // How far through the build you are, so the spreadsheet answers the same
      // question the panel does: what is still to print.
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
      // Why a fastener line is not higher: the wall's own sockets do that job.
      'already_in_the_wall',
      // What to load in the printer, when somebody has said.
      'color',
      'grams_each',
      'metres_each',
      'grams_total',
      'metres_total',
    ]);
  });

  it('uses CRLF line endings, as RFC 4180 requires', () => {
    const csv = toCsv(makeBom());
    expect(csv).toContain('\r\n');
    expect(csv.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('gives every row the same number of fields as the header', () => {
    const rows = parseCsv(toCsv(makeBom()));
    const width = rows[0]!.length;
    for (const row of rows) expect(row).toHaveLength(width);
  });

  it('round-trips a part named `Hook, 25mm "long"` through a CSV parser', () => {
    const rows = parseCsv(toCsv(makeBom()));
    const names = rows.map((r) => field(rows, r, 'part'));
    expect(names).toContain(NASTY_NAME);
  });

  it('doubles internal quotes rather than escaping them with a backslash', () => {
    const csv = toCsv(makeBom());
    expect(csv).toContain('"Hook, 25mm ""long"""');
    expect(csv).not.toContain('\\"');
  });

  it('round-trips a name containing a newline', () => {
    const weird = 'Two\nlines';
    const rows = parseCsv(toCsv(makeBom({ printed: [line({ name: weird })], fasteners: [], shopping: [] })));
    expect(field(rows, rows[1]!, 'part')).toBe(weird);
  });

  it('round-trips a name that is only a comma, and a name that is only a quote', () => {
    for (const name of [',', '"', '""', 'a,b,c', '"quoted"', ',,,\r\n,,,']) {
      const rows = parseCsv(toCsv(makeBom({ printed: [line({ name })], fasteners: [], shopping: [] })));
      expect(field(rows, rows[1]!, 'part'), JSON.stringify(name)).toBe(name);
    }
  });

  it('leaves ordinary fields unquoted', () => {
    const csv = toCsv(makeBom({ printed: [line({ name: 'Plain' })], fasteners: [], shopping: [] }));
    expect(csv.split('\r\n')[1]).toContain(',Plain,');
  });

  it('carries per-unit and total figures, and they are consistent', () => {
    const rows = parseCsv(toCsv(makeBom({ printed: [line()], fasteners: [], shopping: [] })));
    const row = rows[1]!;
    const get = (name: string): string | undefined => field(rows, row, name);
    expect(get('quantity')).toBe('4');
    expect(get('grams_each')).toBe('4.25'); // from the catalogue
    expect(get('grams_total')).toBe('17');
    expect(get('metres_each')).toBe('1.4');
    expect(get('metres_total')).toBe('5.6');
  });

  it('carries the colour a line is to be printed in, and leaves it empty otherwise', () => {
    const painted = parseCsv(
      toCsv(makeBom({ printed: [line({ color: '#ff8800' })], fasteners: [], shopping: [] })),
    );
    expect(field(painted, painted[1]!, 'color')).toBe('#ff8800');

    const plain = parseCsv(toCsv(makeBom({ printed: [line()], fasteners: [], shopping: [] })));
    // Not "#000000", and not "none": no colour chosen is the absence of a
    // decision, and a spreadsheet column that invents one would be a lie.
    expect(field(plain, plain[1]!, 'color')).toBe('');
  });

  it('carries the printed count and what is left of the line', () => {
    const rows = parseCsv(
      toCsv(makeBom({ printed: [line({ printed: 3 })], fasteners: [], shopping: [] })),
    );
    expect(field(rows, rows[1]!, 'quantity')).toBe('4');
    expect(field(rows, rows[1]!, 'printed')).toBe('3');
    expect(field(rows, rows[1]!, 'to_print')).toBe('1');
  });

  /**
   * The per-unit columns read the catalogue value rather than dividing the line
   * total, which is why a zero quantity is no longer a division at all. It used
   * to be `total / quantity` — and dividing an already-rounded total printed
   * 54.6 where the catalogue said 54.63 (PARKED P8 item 6).
   */
  it('reports the catalogue per-unit figure even when the quantity is zero', () => {
    const rows = parseCsv(
      toCsv(makeBom({ printed: [line({ quantity: 0 })], fasteners: [], shopping: [] })),
    );
    expect(field(rows, rows[1]!, 'grams_each')).toBe('4.25');
    expect(field(rows, rows[1]!, 'metres_each')).toBe('1.4');
  });

  it('marks a bounded footprint and a modelled print estimate', () => {
    // The two "this is a model, not a measurement" flags have to reach the
    // sheet that is actually carried to the printer, not just the screen.
    const rows = parseCsv(
      toCsv(makeBom({
        printed: [line({ needsReview: true, estimated: true })],
        fasteners: [],
        shopping: [],
      })),
    );
    expect(field(rows, rows[1]!, 'footprint_estimated')).toBe('yes');
    expect(field(rows, rows[1]!, 'print_estimated')).toBe('yes');
  });

  it('records the part id, type, file and support flag', () => {
    const rows = parseCsv(toCsv(makeBom({ printed: [line({ supports: true })], fasteners: [], shopping: [] })));
    const row = rows[1]!;
    expect(row[0]).toBe('printed');
    expect(field(rows, row, 'part_id')).toBe('hook-25');
    expect(field(rows, row, 'type')).toBe('accessory');
    expect(field(rows, row, 'file')).toBe('models/accessories/hook-25.stl');
    expect(field(rows, row, 'supports')).toBe('yes');
  });

  it('separates fasteners and bought hardware into their own sections', () => {
    const rows = parseCsv(toCsv(makeBom()));
    const sections = rows.slice(1).map((r) => r[0]);
    expect(sections).toContain('printed');
    expect(sections).toContain('fastener');
    expect(sections).toContain('shopping');
    const shopping = rows.find(
      (r) => r[0] === 'shopping' && field(rows, r, 'part') === 'Wall plug, 8 mm "brown"',
    );
    expect(shopping).toBeDefined();
    expect(shopping![1]).toBe('12');
    // Bought, not printed: the progress columns are blank rather than zeroed.
    expect(field(rows, shopping!, 'printed')).toBe('');
    expect(field(rows, shopping!, 'to_print')).toBe('');
  });

  it('survives an empty BOM', () => {
    const csv = toCsv({
      printed: [],
      fasteners: [],
      shopping: [],
      fixings: { count: 0, junctions: 0, spacingMm: 220, perSquareMetre: 0, starvedPanelIds: [] },
    totals: { parts: 0, printed: 0, toPrint: 0, grams: 0, metres: 0, distinctParts: 0 },
      issues: [],
    });
    expect(parseCsv(csv)).toHaveLength(1); // header only
  });
});

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

describe('toMarkdownChecklist', () => {
  const md = (): string => toMarkdownChecklist(makeBom(), makeDoc());

  it('leads with the layout name and the totals', () => {
    const text = md();
    const head = text.slice(0, text.indexOf('## '));
    expect(head).toContain('# Garage wall');
    expect(head).toContain('| Still to print |');
    expect(head).toContain('| 33 |'); // nothing printed yet, so all 33 are left
    expect(head).toContain('470.5 g');
  });

  it('has all four sections in build order', () => {
    const text = md();
    const order = ['## Panels', '## Accessories', '## Inserts & fasteners', '## Shopping list'];
    let cursor = -1;
    for (const heading of order) {
      const at = text.indexOf(heading);
      expect(at, heading).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('writes tickable checkboxes, one per line', () => {
    const text = md();
    const ticks = text.split('\n').filter((l) => l.startsWith('- [ ] '));
    // 1 panel + 2 accessories + 1 fastener + 2 shopping items
    expect(ticks).toHaveLength(6);
  });

  it('puts panels in the panel section and everything else out of it', () => {
    const text = md();
    const panels = text.slice(text.indexOf('## Panels'), text.indexOf('## Accessories'));
    expect(panels).toContain('Panel 7 × 8');
    expect(panels).not.toContain('Hook 25 mm');
  });

  it('shows what is left to print and the total filament per line', () => {
    const text = md();
    expect(text).toContain('- [ ] **4 ×** Hook 25 mm — 17 g');
  });

  it('counts down as a line is printed, and ticks its box when it is done', () => {
    const partly = toMarkdownChecklist(
      makeBom({ printed: [line({ printed: 3 })], fasteners: [], shopping: [] }),
      makeDoc(),
    );
    expect(partly).toContain('- [ ] **1 of 4 ×** Hook 25 mm — 3 of 4 printed, 17 g');

    const done = toMarkdownChecklist(
      makeBom({ printed: [line({ printed: 4 })], fasteners: [], shopping: [] }),
      makeDoc(),
    );
    expect(done).toContain('- [x] **0 of 4 ×** Hook 25 mm — all printed, 17 g');
  });

  it('says so explicitly when a section is empty', () => {
    const text = toMarkdownChecklist(
      { ...makeBom(), shopping: [] },
      makeDoc(),
    );
    const shopping = text.slice(text.indexOf('## Shopping list'));
    expect(shopping).toContain('_Nothing in this section._');
  });

  it('escapes pipes in table cells so the table cannot be broken', () => {
    const text = toMarkdownChecklist(
      makeBom({
        issues: [
          {
            level: 'error',
            code: 'overlap',
            message: 'Item A | overlaps | item B',
            itemIds: ['i1', 'i2'],
          },
        ],
      }),
      makeDoc(),
    );
    const row = text.split('\n').find((l) => l.includes('overlaps'))!;
    expect(row).toContain('Item A \\| overlaps \\| item B');
    // Exactly two structural pipes plus the escaped ones — the row still has
    // the two cells it is supposed to have.
    const structural = row.replace(/\\\|/g, '').split('|').length - 1;
    expect(structural).toBe(3);
  });

  it('escapes pipes in a part name too', () => {
    const text = toMarkdownChecklist(
      makeBom({ printed: [line({ name: 'Hook | wide' })], fasteners: [], shopping: [] }),
      makeDoc(),
    );
    expect(text).toContain('Hook \\| wide');
  });

  it('does not let a newline inside a name break the table', () => {
    const text = toMarkdownChecklist(makeBom(), makeDoc({ name: 'Line one\nLine two' }));
    expect(text.split('\n')[0]).toBe('# Line one Line two — build checklist');
  });

  it('handles an empty BOM without producing nonsense', () => {
    const text = toMarkdownChecklist(
      {
        printed: [],
        fasteners: [],
        shopping: [],
        fixings: { count: 0, junctions: 0, spacingMm: 220, perSquareMetre: 0, starvedPanelIds: [] },
    totals: { parts: 0, printed: 0, toPrint: 0, grams: 0, metres: 0, distinctParts: 0 },
        issues: [],
      },
      makeDoc({ name: '' }),
    );
    expect(text).toContain('# Untitled layout');
    expect(text).toContain('| Still to print | 0 |');
    expect(text.split('_Nothing in this section._')).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Printable HTML
// ---------------------------------------------------------------------------

describe('toPrintableHtml', () => {
  const html = (): string => toPrintableHtml(makeBom(), makeDoc());

  it('is a complete document', () => {
    const text = html();
    expect(text.startsWith('<!doctype html>')).toBe(true);
    expect(text).toContain('<meta charset="utf-8">');
    expect(text).toContain('<title>Garage wall — print list</title>');
    expect(text.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('is self-contained: no external request of any kind', () => {
    const text = html();
    expect(text).not.toMatch(/<link\b/i);
    expect(text).not.toMatch(/<script\b/i);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/\bsrc=/i);
    expect(text).not.toMatch(/@import/i);
    expect(text).not.toMatch(/url\(/i);
  });

  it('carries its CSS inline', () => {
    expect(html()).toContain('<style>');
  });

  it('has print rules that keep rows whole and print black on white', () => {
    const text = html();
    expect(text).toContain('@media print');
    expect(text).toContain('@page');
    expect(text).toContain('page-break-inside: avoid');
    expect(text).toContain('break-inside: avoid');
    expect(text).toContain('display: table-header-group');
    expect(text).toContain('background: #fff');
    expect(text).toContain('color: #000');
  });

  it('uses tabular numerals so columns line up', () => {
    expect(html()).toContain('font-variant-numeric: tabular-nums');
  });

  it('lists every section, with totals', () => {
    const text = html();
    expect(text).toContain('>Panels<');
    expect(text).toContain('>Accessories<');
    expect(text).toContain('>Inserts &amp; fasteners<');
    expect(text).toContain('>Shopping list<');
    expect(text).toContain('<dt>To print</dt><dd>33</dd>');
  });

  it('shows per-line totals, not per-unit figures', () => {
    const text = toPrintableHtml(
      makeBom({ printed: [line()], fasteners: [], shopping: [] }),
      makeDoc(),
    );
    expect(text).toContain('17 g'); // the line total, not 4.25 per unit
  });

  it('prints what is LEFT in the quantity column, with the box already ticked when done', () => {
    const partly = toPrintableHtml(
      makeBom({ printed: [line({ printed: 3 })], fasteners: [], shopping: [] }),
      makeDoc(),
    );
    expect(partly).toContain('<td class="qty">1</td>');
    expect(partly).toContain('3 of 4');
    // The stylesheet names the class too, so look for the CELL, not the word.
    expect(partly).not.toContain('<td class="tick tick--done">');

    const done = toPrintableHtml(
      makeBom({ printed: [line({ printed: 4 })], fasteners: [], shopping: [] }),
      makeDoc(),
    );
    expect(done).toContain('<td class="qty">0</td>');
    expect(done).toContain('<td class="tick tick--done">');
  });

  it('escapes user text — a part name cannot inject markup', () => {
    const text = toPrintableHtml(
      makeBom({ printed: [line({ name: '<script>alert(1)</script>', file: 'a&b<c>.stl' })], fasteners: [], shopping: [] }),
      makeDoc({ name: '"><img onerror=x>' }),
    );
    expect(text).not.toContain('<script>alert(1)</script>');
    expect(text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(text).toContain('a&amp;b&lt;c&gt;.stl');
    expect(text).not.toContain('<img onerror');
  });

  it('calls out layout problems at the top of the page', () => {
    const text = toPrintableHtml(
      makeBom({
        issues: [
          { level: 'error', code: 'overlap', message: 'Two parts share a cell', itemIds: ['a', 'b'] },
        ],
      }),
      makeDoc(),
    );
    expect(text).toContain('Two parts share a cell');
    expect(text.indexOf('Two parts share a cell')).toBeLessThan(text.indexOf('>Panels<'));
  });

  it('touches no DOM API', () => {
    const text = html();
    expect(text.length).toBeGreaterThan(0);
    expect(typeof globalThis.document).toBe('undefined');
  });

  it('handles an empty BOM', () => {
    const text = toPrintableHtml(
      {
        printed: [],
        fasteners: [],
        shopping: [],
        fixings: { count: 0, junctions: 0, spacingMm: 220, perSquareMetre: 0, starvedPanelIds: [] },
    totals: { parts: 0, printed: 0, toPrint: 0, grams: 0, metres: 0, distinctParts: 0 },
        issues: [],
      },
      makeDoc(),
    );
    expect(text).toContain('Nothing in this section.');
    expect(text).toContain('Nothing to buy.');
  });
});

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

describe('downloadName', () => {
  const name = (n: string, ext = 'csv'): string => downloadName(makeDoc({ name: n }), ext);

  it('keeps an ordinary name', () => {
    expect(name('Garage wall')).toBe('Garage wall.csv');
  });

  it('strips every character Windows refuses', () => {
    const out = name('a/b\\c:d*e?f"g<h>i|j');
    expect(out).toBe('a b c d e f g h i j.csv');
    for (const ch of '/\\:*?"<>|') expect(out).not.toContain(ch);
  });

  it('strips control characters', () => {
    expect(name('tab\there\u0000null')).toBe('tab here null.csv');
  });

  it('collapses runs of whitespace', () => {
    expect(name('  a     b  \n  c  ')).toBe('a b c.csv');
  });

  it('never returns an empty name', () => {
    expect(name('')).toBe('layout.csv');
    expect(name('   ')).toBe('layout.csv');
    expect(name('///')).toBe('layout.csv');
    expect(name('...')).toBe('layout.csv');
    expect(downloadName({ ...makeDoc(), name: undefined as unknown as string }, 'csv')).toBe('layout.csv');
  });

  it('caps the length', () => {
    const out = name('x'.repeat(500));
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('.csv')).toBe(true);
  });

  it('does not leave a leading dot or a trailing dot or space', () => {
    expect(name('.hidden')).toBe('hidden.csv');
    expect(name('trailing.')).toBe('trailing.csv');
    expect(name('trailing ')).toBe('trailing.csv');
  });

  it('sidesteps reserved device names', () => {
    expect(name('CON')).toBe('CON-layout.csv');
    expect(name('nul')).toBe('nul-layout.csv');
    expect(name('com1')).toBe('com1-layout.csv');
  });

  it('normalises the extension', () => {
    expect(name('Wall', '.md')).toBe('Wall.md');
    expect(name('Wall', 'HTML')).toBe('Wall.html');
    expect(name('Wall', '')).toBe('Wall');
    expect(name('Wall', '../evil')).toBe('Wall.evil');
  });

  it('keeps non-ASCII names, which are legal everywhere that matters', () => {
    expect(name('Værksted væg 🐝')).toBe('Værksted væg 🐝.csv');
  });
});
