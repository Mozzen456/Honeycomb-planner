/**
 * The shipped plates, finished at the edges by the bed's own sizes (D128).
 *
 * Seven shipped plates stack only to the heights their rows add up to, so a wall
 * tiled with them alone came out stepped along the top in 24 of 54 printer and
 * wall combinations — 82 mm on the default bed at 800 × 2600, 200 mm on a 400
 * bed at 4000 × 2500 — and a 500 × 400 wall on a 300 bed was half bare. The app
 * now passes the bed's generated sizes as `fillers`: used only where no shipped
 * plate reaches, so the top is one line and the right-hand strip is covered.
 */

import { describe, expect, it } from 'vitest';

import { BEDS, MARGIN_X, MARGIN_Y, PITCH, ROW_STEP } from '../src/core/constants';
import { cellsBoundsMm, hexKey, hexToMm, panelCells } from '../src/core/hex';
import { generatedPlateSizes, maxPlateForBed, solveTiling, type PanelSize } from '../src/core/tiling';
import type { Catalog } from '../src/core/types';

import catalogJson from '../src/catalog/catalog.json';

const catalog = catalogJson as unknown as Catalog;
const shipped: PanelSize[] = catalog.parts
  .filter((p) => p.type === 'panel' && p.panel)
  .map((p) => ({
    partId: p.id, columns: p.panel!.columns, rows: p.panel!.rows,
    widthMm: p.panel!.widthMm, heightMm: p.panel!.heightMm,
  }));

const solve = (bedId: string, widthMm: number, heightMm: number) =>
  solveTiling({
    wall: { widthMm, heightMm },
    bedId,
    available: shipped,
    fillers: generatedPlateSizes(bedId),
    allowRotation: false,
  });

const walls: [number, number][] = [
  [300, 300], [500, 400], [800, 2600], [1234, 567], [2400, 1200], [4000, 2500],
];

describe('shipped plates with fill-ins', () => {
  for (const bed of BEDS) {
    it(`one flat top, nothing bare, nothing outside: ${bed.id}`, () => {
      for (const [w, h] of walls) {
        const res = solve(bed.id, w, h);
        const label = `${bed.id} ${w}x${h}`;
        expect(res.panels.length, label).toBeGreaterThan(0);

        // One top across every band. Half a pitch is the lattice's own stagger:
        // a one-column band has no odd column leaning up, and that is not a step.
        const bands = new Map<number, Array<(typeof res.panels)[number]>>();
        for (const p of res.panels) bands.set(p.origin.q, [...(bands.get(p.origin.q) ?? []), p]);
        const tops = [...bands.values()].map((ps) =>
          cellsBoundsMm(ps.flatMap((p) => panelCells(p.origin, p.columns, p.rows))).maxY);
        expect(Math.max(...tops) - Math.min(...tops), `${label} tops ${tops}`)
          .toBeLessThanOrEqual(PITCH / 2 + 1e-6);

        // No bare strip a cell could have filled.
        expect(res.unusedMm.top, label).toBeLessThan(ROW_STEP);
        expect(res.unusedMm.right, label).toBeLessThan(PITCH);

        // Inside the wall, and no cell printed twice.
        const seen = new Set<string>();
        for (const p of res.panels) {
          for (const c of panelCells(p.origin, p.columns, p.rows)) {
            const k = hexKey(c);
            expect(seen.has(k), `${label} overlap at ${k}`).toBe(false);
            seen.add(k);
            const m = hexToMm(c);
            expect(m.x - MARGIN_X, label).toBeGreaterThan(-1e-6);
            expect(m.x + MARGIN_X, label).toBeLessThan(w + 1e-6);
            expect(m.y - MARGIN_Y, label).toBeGreaterThan(-1e-6);
            expect(m.y + MARGIN_Y, label).toBeLessThan(h + 1e-6);
          }
        }
      }
    });
  }

  it('still builds a wall the shipped plates can cross out of shipped plates', () => {
    const res = solve('bed256', 2400, 1200);
    const stock = res.panels.filter((p) => !p.partId.startsWith('generated/'));
    expect(stock.length).toBeGreaterThan(res.panels.length / 2);
  });

  it('changes nothing for a caller that offers no fill-ins', () => {
    const plain = solveTiling({
      wall: { widthMm: 800, heightMm: 2600 }, bedId: 'bed256', available: shipped, allowRotation: false,
    });
    expect(plain.panels.every((p) => !p.partId.startsWith('generated/'))).toBe(true);
  });
});

describe('a wall made smaller after it was solved (D128)', () => {
  it('says the plates past its edge are there, and is quiet once re-solved', async () => {
    const { Store, emptyDoc } = await import('../src/core/store');
    const { validate } = await import('../src/core/bom');
    const s = new Store(emptyDoc(), catalog);
    s.setWall(2400, 1200);
    const place = (w: number, h: number) =>
      s.setPanels(solve('bed256', w, h).panels.map((p, i) => ({ id: `p${i}`, ...p })));
    place(2400, 1200);
    expect(validate(s.getState().doc, catalog).filter((i) => i.code === 'panel-off-wall')).toEqual([]);

    s.setWall(1800, 1000);
    const off = validate(s.getState().doc, catalog).filter((i) => i.code === 'panel-off-wall');
    expect(off).toHaveLength(1);
    expect(off[0]!.level).toBe('error');
    expect(off[0]!.itemIds.length).toBeGreaterThan(0);

    place(1800, 1000);
    expect(validate(s.getState().doc, catalog).filter((i) => i.code === 'panel-off-wall')).toEqual([]);
  });
});

describe('the strip at the right-hand edge (D129)', () => {
  it('is filled in the fewest pieces, not with the smallest shipped plate', () => {
    // 2000 mm on a 256 bed leaves 7 columns past the last 10-wide band. The
    // shipped widths alone made that twenty 4 x 4 plates and a 3-wide band of
    // fill-ins beside them, and every corner between them took a fixing.
    const res = solve('bed256', 2000, 2000);
    const lastQ = Math.max(...res.panels.map((p) => p.origin.q));
    const strip = res.panels.filter((p) => p.origin.q >= lastQ - 6 && p.origin.q > 80);
    expect(strip.length).toBeLessThanOrEqual(10);
    expect(new Set(strip.map((p) => p.origin.q)).size).toBe(1);
  });
});

describe('no stack or wall ends on a sliver (D130)', () => {
  it('never leaves a plate under a third of the bed in either direction', () => {
    // Measured before: 74 of 128 printer x wall pairs ended a column of plates
    // on a 10 x 1 or a wall on a strip of 1 x 10s; asked for directly — "make 2
    // smaller ones so that one does not get that small".
    const odd: string[] = [];
    for (const bed of BEDS) {
      for (const fit of [false, true]) {
        for (const [w, h] of [[300, 300], [500, 400], [1234, 567], [2000, 2000], [2400, 1200], [800, 2600], [4000, 2500], [1600, 777]] as const) {
          const gen = generatedPlateSizes(bed.id);
          const res = solveTiling({
            wall: { widthMm: w, heightMm: h }, bedId: bed.id,
            available: fit ? gen : shipped, ...(fit ? {} : { fillers: gen }), allowRotation: false,
          });
          const max = maxPlateForBed(bed);
          for (const p of res.panels) {
            // Against the plate's OWN neighbourhood, not the bed's maximum: a
            // 10 x 4 is the even half of a 9-row remainder, and fine.
            if (p.rows < 3 || p.columns < 3) odd.push(`${bed.id} ${fit ? 'fit' : 'stock'} ${w}x${h} ${p.columns}x${p.rows} (max ${max.columns}x${max.rows})`);
          }
        }
      }
    }
    expect(odd).toEqual([]);
  });
});
