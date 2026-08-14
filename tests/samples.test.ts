/**
 * Not a test so much as a generator: writes a realistic set of exports to
 * build/ so the print page and CSV can be eyeballed as artefacts rather than
 * as assertions. Run with:  npx vitest run tools/make_samples.test.ts
 */
import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { toCsv, toMarkdownChecklist, toPrintableHtml } from '../src/core/exporters';
import { Store, emptyDoc, __resetIds } from '../src/core/store';
import { solveTiling, type PanelSize } from '../src/core/tiling';
import type { Catalog } from '../src/core/types';

const catalog = catalogJson as unknown as Catalog;

describe('sample exports', () => {
  it('writes a garage-wall parts list to build/', async () => {
    __resetIds();
    const available: PanelSize[] = catalog.parts
      .filter((p) => p.type === 'panel' && p.panel)
      .map((p) => ({
        partId: p.id,
        columns: p.panel!.columns,
        rows: p.panel!.rows,
        widthMm: p.panel!.widthMm,
        heightMm: p.panel!.heightMm,
      }));
    const wall = { widthMm: 2400, heightMm: 1200 };
    const res = solveTiling({ wall, bedId: 'bed256', available });

    const store = new Store(
      {
        ...emptyDoc(),
        name: 'Garage wall',
        wall,
        bedId: 'bed256',
        panels: res.panels.map((p, i) => ({
          id: `p${i}`,
          partId: p.partId,
          origin: p.origin,
          columns: p.columns,
          rows: p.rows,
        })),
      },
      catalog,
    );

    const accessories = catalog.parts.filter(
      (p) => p.type === 'accessory' || p.type === 'insert',
    );
    let placed = 0;
    for (let r = 1; r < 40 && placed < 30; r += 3) {
      for (let q = 1; q < 80 && placed < 30; q += 6) {
        const part = accessories[placed % accessories.length]!;
        if (store.addItem(part.id, { q, r }).ok) placed++;
      }
    }
    expect(placed).toBe(30);

    const bom = store.bom();
    const doc = store.getState().doc;

    // `node:fs` is imported dynamically because @types/node is not a dependency
    // of this project — the app itself never touches the filesystem, and adding
    // node typings just to satisfy one generator would put Node globals in
    // scope for every browser module in the repo.
    const fs = (await import('node:fs')) as typeof import('fs');
    fs.mkdirSync('build', { recursive: true });
    fs.writeFileSync('build/sample-parts-list.html', toPrintableHtml(bom, doc), 'utf-8');
    fs.writeFileSync('build/sample-parts-list.csv', toCsv(bom), 'utf-8');
    fs.writeFileSync('build/sample-parts-list.md', toMarkdownChecklist(bom, doc), 'utf-8');

    // eslint-disable-next-line no-console
    console.log(
      `panels=${doc.panels.length} items=${doc.items.length} ` +
        `lines=${bom.printed.length}+${bom.fasteners.length} ` +
        `shopping=${bom.shopping.length} totals=${bom.totals.parts} parts, ` +
        `${bom.totals.grams} g`,
    );
    expect(bom.issues.filter((i) => i.level === 'error')).toEqual([]);
  });
});
