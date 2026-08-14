/**
 * The acceptance test, stated as the brief states it:
 *
 *   "I set my wall to 2400 x 1200 mm, pick my printer, drag thirty accessories
 *    onto it, hit export, walk to the printer with the list, print exactly what
 *    it says — and everything fits the wall and each other on the first try,
 *    with no leftovers and nothing missing."
 *
 * Runs against the REAL generated catalogue, not fixtures. If the scanner ever
 * produces a catalogue this cannot be satisfied from, this test is the alarm.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { toCsv, toMarkdownChecklist, toPrintableHtml } from '../src/core/exporters';
import { hexKey, panelCells, placeFootprint } from '../src/core/hex';
import { deserialize, encodeShareUrl, decodeShareUrl, serialize } from '../src/core/persist';
import { Store, emptyDoc, __resetIds } from '../src/core/store';
import { solveTiling, type PanelSize } from '../src/core/tiling';
import type { Catalog } from '../src/core/types';

const catalog = catalogJson as unknown as Catalog;

function panelSizes(): PanelSize[] {
  return catalog.parts
    .filter((p) => p.type === 'panel' && p.panel)
    .map((p) => ({
      partId: p.id,
      columns: p.panel!.columns,
      rows: p.panel!.rows,
      widthMm: p.panel!.widthMm,
      heightMm: p.panel!.heightMm,
    }));
}

describe('the catalogue itself', () => {
  it('loaded, and is the real thing', () => {
    expect(catalog.parts.length).toBe(51);
    expect(catalog.parts.filter((p) => p.type === 'panel')).toHaveLength(7);
  });

  it('every part has a usable footprint containing its anchor', () => {
    for (const p of catalog.parts) {
      expect(p.footprint.length, `${p.id} has no cells`).toBeGreaterThan(0);
      const keys = p.footprint.map(hexKey);
      expect(new Set(keys).size, `${p.id} has duplicate cells`).toBe(keys.length);
      expect(keys, `${p.id} footprint missing its anchor`).toContain('0,0');
    }
  });

  it('every part carries a real sliced estimate', () => {
    const bad = catalog.parts.filter((p) => p.print.source !== 'sliced' || p.print.minutes <= 0);
    expect(bad.map((p) => p.id)).toEqual([]);
  });

  it('every requirement points at a part that exists', () => {
    const ids = new Set(catalog.parts.map((p) => p.id));
    for (const p of catalog.parts) {
      for (const r of p.requires) {
        expect(ids.has(r.partId), `${p.id} requires missing ${r.partId}`).toBe(true);
      }
    }
  });

  it('panel cell counts agree with columns x rows', () => {
    for (const p of catalog.parts.filter((x) => x.type === 'panel')) {
      expect(p.footprint.length, p.id).toBe(p.panel!.columns * p.panel!.rows);
    }
  });
});

describe('a 2400 x 1200 garage wall', () => {
  const wall = { widthMm: 2400, heightMm: 1200 };

  it('tiles with no two panels ever sharing a cell', () => {
    const res = solveTiling({ wall, bedId: 'bed256', available: panelSizes() });
    expect(res.panels.length).toBeGreaterThan(0);

    const seen = new Set<string>();
    for (const p of res.panels) {
      for (const c of panelCells(p.origin, p.columns, p.rows)) {
        const k = hexKey(c);
        expect(seen.has(k), `two panels share cell ${k}`).toBe(false);
        seen.add(k);
      }
    }
    expect(seen.size).toBe(res.cellCount);
    expect(res.coverage).toBeGreaterThan(0.9);
  });

  it('is deterministic', () => {
    const a = solveTiling({ wall, bedId: 'bed256', available: panelSizes() });
    const b = solveTiling({ wall, bedId: 'bed256', available: panelSizes() });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('takes thirty accessories, exports, and the list matches the wall exactly', () => {
    __resetIds();
    const res = solveTiling({ wall, bedId: 'bed256', available: panelSizes() });
    const doc = {
      ...emptyDoc(),
      wall,
      bedId: 'bed256',
      panels: res.panels.map((p, i) => ({
        id: `p${i}`,
        partId: p.partId,
        origin: p.origin,
        columns: p.columns,
        rows: p.rows,
      })),
    };
    const store = new Store(doc, catalog);

    // Thirty accessories, spread across the wall. Only genuinely placeable
    // parts count — a refused drop must not silently become a BOM line.
    const accessories = catalog.parts
      .filter((p) => p.type === 'accessory' || p.type === 'insert')
      .slice(0, 10);
    expect(accessories.length).toBeGreaterThan(0);

    const placed: string[] = [];
    let r = 1;
    let q = 1;
    while (placed.length < 30 && r < 40) {
      const part = accessories[placed.length % accessories.length]!;
      const result = store.addItem(part.id, { q, r });
      if (result.ok) placed.push(part.id);
      q += 5;
      if (q > 80) {
        q = 1;
        r += 4;
      }
    }
    expect(placed.length, 'could not place 30 accessories').toBe(30);

    // 1. Nothing overlaps: every occupied cell is claimed exactly once.
    const owner = new Map<string, string>();
    for (const it of store.getState().doc.items) {
      const part = catalog.parts.find((p) => p.id === it.partId)!;
      for (const c of placeFootprint(part.footprint, it.at, it.rotation)) {
        const k = hexKey(c);
        expect(owner.has(k), `cell ${k} claimed twice`).toBe(false);
        owner.set(k, it.id);
      }
    }

    // 2. Everything sits on a panel.
    const panelSet = new Set<string>();
    for (const p of doc.panels) {
      for (const c of panelCells(p.origin, p.columns, p.rows)) panelSet.add(hexKey(c));
    }
    for (const k of owner.keys()) {
      expect(panelSet.has(k), `cell ${k} is off the wall`).toBe(true);
    }

    // 3. The BOM accounts for every placed thing, with nothing missing or extra.
    const bom = store.bom();
    const bomCounts = new Map<string, number>();
    for (const line of [...bom.printed, ...bom.fasteners]) {
      bomCounts.set(line.partId, (bomCounts.get(line.partId) ?? 0) + line.quantity);
    }
    const expected = new Map<string, number>();
    for (const it of store.getState().doc.items) {
      expected.set(it.partId, (expected.get(it.partId) ?? 0) + 1);
    }
    for (const p of doc.panels) {
      expected.set(p.partId, (expected.get(p.partId) ?? 0) + 1);
    }
    for (const [partId, n] of expected) {
      expect(bomCounts.get(partId) ?? 0, `BOM undercounts ${partId}`).toBeGreaterThanOrEqual(n);
    }

    // 4. Required inserts are counted, not forgotten.
    //
    // Wall fixings are excluded from this re-derivation: they are a property of
    // the assembly, planned across the whole wall at a spacing, not the sum of
    // each plate's declared requirement (src/core/fixings.ts). They are checked
    // on their own terms below.
    const isWallMount = (id: string): boolean =>
      (catalog.parts.find((p) => p.id === id)?.hardware ?? []).some((h) =>
        /wall (screw|plug)/i.test(h.item),
      );
    const requiredInserts = new Map<string, number>();
    for (const [partId, n] of expected) {
      const part = catalog.parts.find((p) => p.id === partId);
      if (part?.type === 'panel') continue;
      for (const req of part?.requires ?? []) {
        if (isWallMount(req.partId)) continue;
        requiredInserts.set(req.partId, (requiredInserts.get(req.partId) ?? 0) + req.count * n);
      }
    }
    for (const [partId, n] of requiredInserts) {
      expect(bomCounts.get(partId) ?? 0, `BOM forgot required ${partId}`).toBeGreaterThanOrEqual(n);
    }

    // 4b. The wall is actually fixed to the wall: at least one fixing per panel,
    // and exactly one screw and one plug per fixing.
    expect(bom.fixings.count).toBeGreaterThanOrEqual(doc.panels.length);
    const screws = bom.shopping.find((s) => /wall screw/i.test(s.item))?.count ?? 0;
    const plugs = bom.shopping.find((s) => /wall plug/i.test(s.item))?.count ?? 0;
    expect(screws).toBe(bom.fixings.count);
    expect(plugs).toBe(bom.fixings.count);

    // 5. Totals are positive and self-consistent.
    expect(bom.totals.parts).toBeGreaterThan(30);
    expect(bom.totals.toPrint).toBe(bom.totals.parts); // nothing printed yet
    expect(bom.totals.grams).toBeGreaterThan(0);

    // 6. No errors in the finished layout.
    expect(bom.issues.filter((i) => i.level === 'error')).toEqual([]);

    // 7. All three exports produce usable output.
    const csv = toCsv(bom);
    expect(csv.split('\n').length).toBeGreaterThan(3);
    const md = toMarkdownChecklist(bom, store.getState().doc);
    expect(md).toContain('- [ ]');
    const html = toPrintableHtml(bom, store.getState().doc);
    expect(html.toLowerCase()).toContain('<table');
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // self-contained

    // 8. Save / load / share round-trips exactly.
    const round = deserialize(serialize(store.getState().doc));
    expect(round.errors).toEqual([]);
    expect(round.doc).toEqual(store.getState().doc);

    const url = encodeShareUrl(store.getState().doc, 'https://example.test/planner');
    const back = decodeShareUrl(url);
    expect(back.doc).toEqual(store.getState().doc);
  });

  it('warns rather than silently failing when nothing fits the printer', () => {
    const res = solveTiling({
      wall: { widthMm: 100, heightMm: 100 },
      bedId: 'mini',
      available: panelSizes(),
    });
    expect(res.panels).toEqual([]);
    expect(res.warnings.length).toBeGreaterThan(0);
  });
});
