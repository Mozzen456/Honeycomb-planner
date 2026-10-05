/**
 * Which part each wall fixing is (D125).
 *
 * The four-cell countersunk insert wherever it fits, the two-cell one round the
 * outside of the wall, and the single-cell one only where neither fits. Asked
 * for by the person building the wall: the multi-cell parts spread the load over
 * more than one hexagon, and the four-cell one leaves three sockets to hang
 * things on.
 *
 * What must NOT change is how many fixings there are — the spacing decides
 * that, and it was tuned against real walls (~26 per m²). So the counts are
 * compared against the single-cell plan the planner used to make: same number
 * of fixings, different parts.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { fixingPlanFor } from '../src/core/bom';
import { EDGE_FIXING_ID, EDGE_FOOTPRINT, JUNCTION_FIXING_ID } from '../src/core/fixings';
import { cellsCentreMm, hexKey, hexToMm, placedPanelCells } from '../src/core/hex';
import { emptyDoc, Store } from '../src/core/store';
import { generatedPlateSizes, solveTiling, type PanelSize } from '../src/core/tiling';
import type { Catalog, LayoutDoc, PlacedPanel, WallFrame } from '../src/core/types';

const catalog = catalogJson as unknown as Catalog;
const sizes: PanelSize[] = catalog.parts
  .filter((p) => p.type === 'panel' && p.panel)
  .map((p) => ({
    partId: p.id, columns: p.panel!.columns, rows: p.panel!.rows,
    widthMm: p.panel!.widthMm, heightMm: p.panel!.heightMm,
  }));

function wall(widthMm: number, heightMm: number, bedId: string, frame?: WallFrame): LayoutDoc {
  const panels = solveTiling({ wall: { widthMm, heightMm }, bedId, available: sizes, allowRotation: false })
    .panels.map((p, i): PlacedPanel => ({ id: `p${i}`, ...p }));
  const s = new Store({ ...emptyDoc(), wall: { widthMm, heightMm }, bedId }, catalog);
  if (frame) s.setFrame(frame);
  s.setPanels(panels);
  return s.getState().doc;
}

const FRAME: WallFrame = { left: true, right: true, top: true, bottom: true, holes: true, thicknessMm: 3.6 };
const WALLS: [number, number, string, WallFrame | undefined][] = [
  [2400, 1200, 'bed256', undefined],
  [2400, 1200, 'bed300', FRAME],
  [1200, 2400, 'mk3s', FRAME],
  [600, 400, 'mk3s', undefined],
];

describe('the parts the planner fixes the wall with', () => {
  it('uses the measured two-cell footprint', () => {
    const part = catalog.parts.find((p) => p.id === EDGE_FIXING_ID)!;
    const norm = (cells: readonly { q: number; r: number }[]) => cells.map(hexKey).sort().join(' ');
    expect(norm(EDGE_FOOTPRINT)).toBe(norm(part.footprint));
    // One wall screw, like every other wall fixing — the shopping list relies on it.
    expect((part.hardware ?? []).filter((h) => /wall screw/i.test(h.item))).toHaveLength(1);
  });

  for (const [w, h, bed, frame] of WALLS) {
    it(`${w} x ${h} on ${bed}${frame ? ', bordered' : ''}: multi-cell where it fits, the edge part on the outside`, () => {
      const doc = wall(w, h, bed, frame);
      const plan = fixingPlanFor(doc, catalog);
      const kinds = new Set(plan.junctions.map((j) => j.partId));
      expect([...kinds].every((k) => k === JUNCTION_FIXING_ID || k === EDGE_FIXING_ID)).toBe(true);
      // Nothing on these empty walls blocks a multi-cell part, so none is single.
      expect(plan.cells).toEqual([]);
      expect(plan.junctions.some((j) => j.partId === EDGE_FIXING_ID)).toBe(true);

      // Every EDGE fixing is out at the rim: within a spacing's half of the
      // outermost mountable cells, never in the middle of the wall.
      const cells = doc.panels.flatMap((p) => placedPanelCells(p)).map(hexToMm);
      const minX = Math.min(...cells.map((c) => c.x)), maxX = Math.max(...cells.map((c) => c.x));
      const minY = Math.min(...cells.map((c) => c.y)), maxY = Math.max(...cells.map((c) => c.y));
      const reach = plan.spacingMm / 2;
      for (const j of plan.junctions.filter((x) => x.partId === EDGE_FIXING_ID)) {
        const near = j.cells.map(hexToMm).some((c) =>
          c.x - minX <= reach || maxX - c.x <= reach || c.y - minY <= reach || maxY - c.y <= reach);
        expect({ at: hexKey(j.anchor), near }).toEqual({ at: hexKey(j.anchor), near: true });
      }

      // Every plate is held, and no two fixings share a hole.
      const used = new Set<string>();
      for (const c of plan.junctions.flatMap((j) => j.cells)) {
        expect(used.has(hexKey(c))).toBe(false);
        used.add(hexKey(c));
      }
      const held = new Set(plan.junctions.flatMap((j) => j.panelIds));
      for (const p of doc.panels) expect(held.has(p.id)).toBe(true);
    });
  }

  it('keeps the number of fixings the spacing asks for', () => {
    // 2400 x 1200 on a 256 bed planned 75 fixings as 24 single + 51 four-cell
    // before D125, and the count is the spacing's business, not the parts'.
    // 72 since D129: three seam corners within half a spacing of another tie.
    const plan = fixingPlanFor(wall(2400, 1200, 'bed256'), catalog);
    expect(plan.cells.length + plan.junctions.length).toBe(72);
  });

  it('never crowds two fixings together (D129)', () => {
    // Plates of two heights side by side put a seam corner on each side every
    // ~110 mm, and each took a tie: pairs 47 mm apart down a whole seam, read
    // as "it looks really weird". Nothing closer than 40 % of the spacing.
    for (const bed of ['mini', 'mk3s', 'bed256', 'bed300', 'bed400']) {
      for (const [w, h] of [[2000, 2000], [2400, 1200], [1234, 2000]] as const) {
        const panels = solveTiling({
          wall: { widthMm: w, heightMm: h }, bedId: bed, available: sizes,
          fillers: generatedPlateSizes(bed), allowRotation: false,
        }).panels.map((p, i): PlacedPanel => ({ id: `p${i}`, ...p }));
        const doc: LayoutDoc = { ...emptyDoc(), wall: { widthMm: w, heightMm: h }, bedId: bed, panels };
        const plan = fixingPlanFor(doc, catalog);
        const pts = [...plan.cells.map(hexToMm), ...plan.junctions.map((j) => cellsCentreMm(j.cells))];
        let min = Infinity;
        for (let i = 0; i < pts.length; i++) {
          for (let k = i + 1; k < pts.length; k++) {
            min = Math.min(min, Math.hypot(pts[i]!.x - pts[k]!.x, pts[i]!.y - pts[k]!.y));
          }
        }
        expect(min, `${bed} ${w}x${h}`).toBeGreaterThanOrEqual(plan.spacingMm * 0.4);
        const held = new Set([...plan.panelIds, ...plan.junctions.flatMap((j) => j.panelIds)]);
        for (const p of panels) expect(held.has(p.id), `${bed} ${w}x${h} ${p.id}`).toBe(true);
      }
    }
  });
});
