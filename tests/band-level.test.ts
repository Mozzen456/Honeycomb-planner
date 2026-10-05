/**
 * Every band of plates ends at the wall's top, never above it (D124).
 *
 * Bands are filled one at a time, tallest plates first, so how high a band gets
 * depends on the heights its width comes in. On a 300 mm bed with the shipped
 * plates the 14-wide bands stack 44 rows and the 4-wide band at the right-hand
 * edge stacked 48 — a column standing 94 mm proud of the wall, and with the
 * border on, every other band's top row paved solid because the assembly's top
 * line came from that one column. Reported with a screenshot.
 *
 * A band LOWER than the rest is a different thing and is allowed: it is a band
 * whose width cannot reach the height, and pulling the whole wall down to it
 * cascades (an 18-wide band cannot make 45 rows from 16s, so it would fall to
 * 32). Only a band taller than the height most of the wall's width reaches is
 * wrong, and that is what is asserted.
 */

import { describe, expect, it } from 'vitest';

import { BEDS } from '../src/core/constants';
import { cellsBoundsMm, panelCells } from '../src/core/hex';
import { panelFrameSides } from '../src/core/panelModel';
import { emptyDoc, Store } from '../src/core/store';
import { generatedPlateSizes, solveTiling, type PanelSize } from '../src/core/tiling';
import type { Catalog, PlacedPanel, WallFrame } from '../src/core/types';

import catalogJson from '../src/catalog/catalog.json';

const catalog = catalogJson as unknown as Catalog;
const shipped: PanelSize[] = catalog.parts
  .filter((p) => p.type === 'panel' && p.panel)
  .map((p) => ({
    partId: p.id, columns: p.panel!.columns, rows: p.panel!.rows,
    widthMm: p.panel!.widthMm, heightMm: p.panel!.heightMm,
  }));

const solve = (bedId: string, fit: boolean, widthMm: number, heightMm: number) =>
  solveTiling({
    wall: { widthMm, heightMm },
    bedId,
    available: fit ? generatedPlateSizes(bedId) : shipped,
    allowRotation: false,
  }).panels;

/** Each band's top, with the number of columns it spans. */
function bandTops(panels: ReturnType<typeof solve>) {
  const bands = new Map<number, typeof panels>();
  for (const p of panels) bands.set(p.origin.q, [...(bands.get(p.origin.q) ?? []), p]);
  return [...bands.values()].map((ps) => ({
    columns: ps[0]!.columns,
    top: cellsBoundsMm(ps.flatMap((p) => panelCells(p.origin, p.columns, p.rows))).maxY,
  }));
}

/** The top that most of the wall's width reaches — the lower one on a tie. */
function wallTop(tops: ReturnType<typeof bandTops>): number {
  const width = new Map<number, number>();
  for (const t of tops) {
    const k = Math.round(t.top * 1000) / 1000;
    width.set(k, (width.get(k) ?? 0) + t.columns);
  }
  const most = Math.max(...width.values());
  return Math.min(...[...width].filter(([, w]) => w === most).map(([k]) => k));
}

describe('a solved wall has one top', () => {
  it('on the reported wall: 2400 x 1200 on a 300 bed, shipped plates', () => {
    const tops = bandTops(solve('bed300', false, 2400, 1200));
    const distinct = new Set(tops.map((t) => t.top.toFixed(3)));
    expect([...distinct]).toHaveLength(1);
  });

  const walls: [number, number][] = [
    [400, 400], [1000, 1000], [1234, 567], [2400, 1200], [800, 2600], [3000, 2000],
  ];
  for (const bed of BEDS) {
    for (const fit of [false, true]) {
      it(`no band stands above the wall: ${bed.id}, ${fit ? 'fit to printer' : 'shipped plates'}`, () => {
        for (const [w, h] of walls) {
          const tops = bandTops(solve(bed.id, fit, w, h));
          if (tops.length === 0) continue;
          const top = wallTop(tops);
          const proud = tops.filter((t) => t.top > top + 1e-6);
          expect({ wall: `${w}x${h}`, proud }).toEqual({ wall: `${w}x${h}`, proud: [] });
        }
      });
    }
  }
});

describe('a plate on the edge of a bordered wall says so', () => {
  it('names the side its cut column is on, not only the corners', () => {
    // The walk that names a plate's sides looks for EMPTY positions past it,
    // and the cut ring counts as occupied — so a plate in the outermost column
    // found none, and the parts list called it "generated" with no reason.
    const frame: WallFrame = {
      left: true, right: true, top: true, bottom: true, holes: false, thicknessMm: 3.6,
    };
    const panels = solve('bed300', false, 2400, 1200)
      .map((p, i): PlacedPanel => ({ id: `p${i}`, ...p }));
    const store = new Store({ ...emptyDoc(), wall: { widthMm: 2400, heightMm: 1200 }, bedId: 'bed300' }, catalog);
    store.setFrame(frame);
    store.setPanels(panels);
    const doc = store.getState().doc;
    const leftmost = Math.min(...doc.panels.map((p) => p.origin.q));
    const rightmost = Math.max(...doc.panels.map((p) => p.origin.q + p.columns - 1));
    for (const p of doc.panels) {
      const s = panelFrameSides(p, doc.panels, doc.frame);
      if (p.origin.q === leftmost) expect({ id: p.id, left: s.left }).toEqual({ id: p.id, left: true });
      if (p.origin.q + p.columns - 1 === rightmost) {
        expect({ id: p.id, right: s.right }).toEqual({ id: p.id, right: true });
      }
    }
  });
});
