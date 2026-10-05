/**
 * A zone must not leave a plate as a sliver (D130).
 *
 * Reported with a screenshot: "Custom plate H — 2 cells, 87 × 44 mm", and asked
 * for directly: "combine them (if they fit the printer) or make 2 smaller ones
 * so that one does not get that small". The re-cut joins a plate left with
 * fewer than `MIN_PLATE_CELLS` to its neighbour in the same column of plates
 * when the joined plate still fits the bed, and otherwise moves the boundary
 * between them. Swept over random zones, because which plate a zone leaves
 * small depends on exactly where its edge lands.
 */
import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { bedFor } from '../src/core/constants';
import { hexKey, hexToMm, panelCells, placedPanelCells } from '../src/core/hex';
import { cellRemainderBox } from '../src/core/obstacles';
import { deserialize, serialize } from '../src/core/persist';
import { emptyDoc, MIN_PLATE_CELLS, recutPanels, Store } from '../src/core/store';
import { generatedPlateSizes, solveTiling } from '../src/core/tiling';
import { MARGIN_X, MARGIN_Y } from '../src/core/constants';
import type { Catalog, LayoutDoc, Obstacle, PlacedPanel } from '../src/core/types';

const catalog = catalogJson as unknown as Catalog;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function solved(bedId: string, w: number, h: number, framed: boolean): Store {
  const s = new Store({ ...emptyDoc(), wall: { widthMm: w, heightMm: h }, bedId }, catalog);
  if (framed) s.setFrame({ left: true, right: true, top: true, bottom: true, holes: true, thicknessMm: 3.6 });
  const res = solveTiling({
    wall: { widthMm: w, heightMm: h }, bedId, available: generatedPlateSizes(bedId, framed ? 3.6 : 0),
    allowRotation: false,
  });
  s.setPanels(res.panels.map((p, i): PlacedPanel => ({ id: `p${i}`, ...p })));
  return s;
}

const live = (p: PlacedPanel) => placedPanelCells(p).length;

function connected(p: PlacedPanel): boolean {
  const cells = placedPanelCells(p);
  const left = new Set(cells.map(hexKey));
  const queue = cells.slice(0, 1);
  if (queue[0]) left.delete(hexKey(queue[0]));
  while (queue.length > 0) {
    const c = queue.pop()!;
    for (const [dq, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]]) {
      const n = { q: c.q + dq!, r: c.r + dr! };
      if (left.delete(hexKey(n))) queue.push(n);
    }
  }
  return left.size === 0;
}
const slivers = (doc: LayoutDoc) => doc.panels.filter((p) => live(p) > 0 && live(p) < MIN_PLATE_CELLS);

/** The printed extent, as the re-cut measures it: what survives the zones. */
function fitsBed(p: PlacedPanel, doc: LayoutDoc): boolean {
  const bed = bedFor(doc.bedId, doc.customBed)!;
  const cut = new Set((p.omit ?? []).map(hexKey));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of panelCells(p.origin, p.columns, p.rows)) {
    const m = hexToMm(c);
    const box = cut.has(hexKey(c)) ? cellRemainderBox(c, doc.obstacles)
      : { minX: m.x - MARGIN_X, maxX: m.x + MARGIN_X, minY: m.y - MARGIN_Y, maxY: m.y + MARGIN_Y };
    if (!box) continue;
    minX = Math.min(minX, box.minX); maxX = Math.max(maxX, box.maxX);
    minY = Math.min(minY, box.minY); maxY = Math.max(maxY, box.maxY);
  }
  if (!Number.isFinite(minX)) return true;
  const w = maxX - minX, h = maxY - minY, e = 1e-6;
  return (w <= bed.width + e && h <= bed.depth + e) || (w <= bed.depth + e && h <= bed.width + e);
}

describe('a zone leaves no sliver of a plate', () => {
  it('joins, or shares rows, across random zones — and gives the plates back', () => {
    const next = rng(7);
    let before = 0, after = 0;
    const hist = { before: [] as number[], after: [] as number[] };
    for (const [bedId, w, h, framed] of [
      ['bed256', 2000, 2000, true], ['mk3s', 2400, 1200, false], ['bed300', 1600, 1200, true],
      ['mini', 1200, 900, false], ['bed400', 2400, 2000, true],
    ] as const) {
      for (let n = 0; n < 16; n++) {
        const s = solved(bedId, w, h, framed);
        const original = s.getState().doc.panels;
        const zw = 60 + next() * 500, zh = 60 + next() * 500;
        const zone: Obstacle = {
          id: 'z', label: 'zone', xMm: next() * (w - zw), yMm: next() * (h - zh),
          widthMm: zw, heightMm: zh, clearanceMm: 0,
        };
        // The same cut with no bed: nothing joined, which is what it used to be.
        const bare = slivers({
          ...s.getState().doc,
          panels: recutPanels(original, undefined, [zone], s.getState().doc.frame).panels,
        });
        before += bare.length;
        for (const p of bare) hist.before.push(live(p));
        s.setObstacles([zone]);
        const doc = s.getState().doc;
        after += slivers(doc).length;
        for (const p of slivers(doc)) hist.after.push(live(p));
        for (const p of doc.panels) {
          expect(fitsBed(p, doc), `${bedId} ${p.id} fits`).toBe(true);
          if (p.joined) expect(connected(p), `${bedId} ${p.id} one piece`).toBe(true);
        }
        // No cell printed twice, and none lost: the union of the blocks is the solver's.
        const blocks = (ps: readonly PlacedPanel[]) =>
          ps.flatMap((p) => panelCells(p.origin, p.columns, p.rows).map(hexKey)).sort();
        const keys = blocks([...doc.panels, ...(doc.covered ?? [])]);
        expect(new Set(keys).size, `${bedId} overlap`).toBe(keys.length);
        expect(keys).toEqual(blocks(original));
        // Off the wall, and the solver's plates come back exactly.
        s.setObstacles([]);
        const back = s.getState().doc.panels;
        const sig = (ps: readonly PlacedPanel[]) =>
          ps.map((p) => `${p.id}:${p.partId}:${p.origin.q},${p.origin.r}:${p.columns}x${p.rows}`).sort();
        expect(sig(back)).toEqual(sig(original));
        expect(back.some((p) => p.joined)).toBe(false);
      }
    }
    // Measured 28 -> 14 when this was written, and every one under six cells
    // gone. What is left is a strip one cell wide beside a zone that takes the
    // rest of a column of plates — joining up or down outgrows the bed, and
    // across columns the blocks would not be rectangles on the lattice — or a
    // plate on a Prusa Mini, whose bed has no room to take more.
    expect(before).toBeGreaterThan(20);
    expect(after).toBeLessThanOrEqual(Math.floor(before / 2));
    expect(Math.min(...hist.after)).toBeGreaterThanOrEqual(6);
    expect(Math.min(...hist.before)).toBeLessThan(6);
  });

  it('keeps the originals through a save', () => {
    const s = solved('bed256', 2000, 2000, false);
    // A zone that eats all but the top row of the plate at the bottom-left.
    const p0 = s.getState().doc.panels.find((p) => p.origin.q === 0)!;
    const cells = panelCells(p0.origin, p0.columns, p0.rows).map(hexToMm);
    const top = Math.max(...cells.map((c) => c.y));
    s.setObstacles([{ id: 'z', label: 'z', xMm: 0, yMm: 0, widthMm: 400, heightMm: top - 20, clearanceMm: 0 }]);
    const doc = s.getState().doc;
    const joined = doc.panels.filter((p) => p.joined);
    expect(joined.length).toBeGreaterThan(0);
    const back = deserialize(serialize(doc)).doc!;
    expect(back.panels.filter((p) => p.joined)).toEqual(joined);
  });
});
