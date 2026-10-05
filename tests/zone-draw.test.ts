/**
 * A DRAWN zone makes good plates and a good border (D118, D123), on every shape
 * somebody is likely to draw.
 *
 * The rectangle has had a test per defect; the drawn outline has a few shapes.
 * This puts a set of free-drawn outlines — a roof slope, a slanted strip, a
 * five-sided shape, a concave shape, one running off the wall — through the
 * whole pipeline on several printers with the border on, and asks of every
 * plate what a person printing it would:
 *
 *   - it is one closed, printable mesh that fits the bed;
 *   - no plastic stands inside the zone;
 *   - no opening comes within the rail of the zone, so the wall round the
 *     aperture is never thinner than the border (D123);
 *   - and the wall is never much THICKER than the border for any length along
 *     the drawn edge either — a dropped quadrant leaves ~13 mm of solid for the
 *     width of a cell, which is the stepped aperture of D105, and the slanted
 *     cut is where a dropped piece would hide.
 */

import { describe, expect, it } from 'vitest';

import { bedFor } from '../src/core/constants';
import { buildHoneycombMesh, meshBoundsMm, meshIsClosed, plateRings } from '../src/core/honeycomb';
import { zoneFromOutline } from '../src/core/measure';
import { panelModelSpecFor } from '../src/core/panelModel';
import { emptyDoc, Store } from '../src/core/store';
import { generatedPlateSizes, solveTiling, type PanelSize } from '../src/core/tiling';
import { hexToMm, panelCells } from '../src/core/hex';
import type { Catalog, LayoutDoc, Obstacle, PlacedPanel, WallFrame } from '../src/core/types';
import { pointInOutline, type Pt } from '../src/core/zonePolygon';

import catalogJson from '../src/catalog/catalog.json';

const catalog = catalogJson as unknown as Catalog;
const RAIL = 3.6;
const FRAME: WallFrame = { left: true, right: true, top: true, bottom: true, holes: true, thicknessMm: RAIL };
const shipped: PanelSize[] = catalog.parts
  .filter((p) => p.type === 'panel' && p.panel)
  .map((p) => ({
    partId: p.id, columns: p.panel!.columns, rows: p.panel!.rows,
    widthMm: p.panel!.widthMm, heightMm: p.panel!.heightMm,
  }));

const W = 2400, H = 1200;
const SHAPES: Record<string, Pt[]> = {
  'roof slope': [{ x: 1300, y: H + 10 }, { x: W + 10, y: 520 }, { x: W + 10, y: H + 10 }],
  'slanted strip': [{ x: 300, y: 200 }, { x: 420, y: 200 }, { x: 980, y: 900 }, { x: 860, y: 900 }],
  'five sides': [{ x: 700, y: 300 }, { x: 1000, y: 260 }, { x: 1130, y: 520 }, { x: 900, y: 760 }, { x: 640, y: 600 }],
  'concave': [{ x: 1500, y: 200 }, { x: 1900, y: 200 }, { x: 1900, y: 700 }, { x: 1720, y: 700 }, { x: 1720, y: 380 }, { x: 1500, y: 380 }],
  'off the wall': [{ x: -40, y: 300 }, { x: 260, y: 360 }, { x: 180, y: 820 }, { x: -40, y: 760 }],
};

function wallWith(bedId: string, fit: boolean, outline: Pt[]): { doc: LayoutDoc; zone: Obstacle } {
  const made = zoneFromOutline(outline, 'z', 'Drawn', 0);
  if ('problem' in made) throw new Error(made.problem);
  const panels = solveTiling({
    wall: { widthMm: W, heightMm: H }, bedId,
    available: fit ? generatedPlateSizes(bedId, RAIL) : shipped, allowRotation: false,
  }).panels.map((p, i): PlacedPanel => ({ id: `p${i}`, ...p }));
  const s = new Store({ ...emptyDoc(), wall: { widthMm: W, heightMm: H }, bedId }, catalog);
  s.setFrame(FRAME);
  s.setPanels(panels);
  s.setObstacles([made.zone]);
  return { doc: s.getState().doc, zone: made.zone };
}

/** Distance from a point to a closed polygon's boundary. */
function toBoundary(poly: readonly Pt[], p: Pt): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const ex = b.x - a.x, ey = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / (ex * ex + ey * ey || 1)));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * ex), p.y - (a.y + t * ey)));
  }
  return best;
}

const CASES: [string, boolean][] = [['bed256', false], ['mk3s', true], ['bed300', false]];

describe('a drawn zone, through the whole pipeline', () => {
  for (const [name, outline] of Object.entries(SHAPES)) {
    for (const [bedId, fit] of CASES) {
      it(`${name} on ${bedId}${fit ? ' (fit to printer)' : ''}`, () => {
        const { doc, zone } = wallWith(bedId, fit, outline);
        const poly = zone.outline!.map((p) => ({ x: p.xMm, y: p.yMm }));
        const bed = bedFor(bedId)!;
        const bores: Pt[][] = [];
        for (const p of doc.panels) {
          const spec = { ...panelModelSpecFor(p, doc), originAtZero: false };
          const mesh = buildHoneycombMesh(spec);
          expect({ plate: p.id, open: meshIsClosed(mesh).unmatchedEdges }).toEqual({ plate: p.id, open: 0 });
          const [min, max] = [meshBoundsMm(mesh).min, meshBoundsMm(mesh).max];
          const dx = max[0] - min[0], dy = max[1] - min[1];
          const fits = (dx <= bed.width + 1e-6 && dy <= bed.depth + 1e-6) || (dy <= bed.width + 1e-6 && dx <= bed.depth + 1e-6);
          expect({ plate: p.id, fits }).toEqual({ plate: p.id, fits: true });
          // No plastic inside the drawn shape: triangle centroids, a hair in.
          const pos = mesh.positions;
          let inside = 0;
          for (let i = 0; i < pos.length; i += 9) {
            const c = { x: (pos[i]! + pos[i + 3]! + pos[i + 6]!) / 3, y: (pos[i + 1]! + pos[i + 4]! + pos[i + 7]!) / 3 };
            if (pointInOutline(poly, c) && toBoundary(poly, c) > 0.05) inside++;
          }
          expect({ plate: p.id, inside }).toEqual({ plate: p.id, inside: 0 });
          for (const rings of plateRings(spec).innerRings.values()) for (const r of rings) if (r.length) bores.push(r);
        }
        // The rail: no opening within the border's thickness of the zone.
        let nearest = Infinity;
        for (const r of bores) for (const v of r) if (!pointInOutline(poly, v)) nearest = Math.min(nearest, toBoundary(poly, v));
        // Within a tenth of a millimetre: a bore that would be shaved by less
        // than that is left alone (`RAIL_MIN_CUT`), because the cut would only
        // leave a sliver of a facet — a fraction of one extrusion width.
        expect(nearest).toBeGreaterThanOrEqual(RAIL - 0.1);

        // The wall along each drawn edge, sampled every 1 mm: how far from the
        // edge the nearest opening is. Solid much thicker than a rail plus the
        // web between two cells, for a cell's width or more, is plate the cut
        // threw away a piece of rather than cut.
        // Only where there IS honeycomb: a solve with stock plates can stop
        // short of the wall's edge, and an edge sampled out there measures
        // the distance to the last plate, not a wall.
        const centres = doc.panels.flatMap((p) => panelCells(p.origin, p.columns, p.rows)).map(hexToMm);
        const hx0 = Math.min(...centres.map((c) => c.x)) + 30, hx1 = Math.max(...centres.map((c) => c.x)) - 30;
        const hy0 = Math.min(...centres.map((c) => c.y)) + 30, hy1 = Math.max(...centres.map((c) => c.y)) - 30;
        const near = (pt: Pt): number => {
          let d = Infinity;
          for (const r of bores) {
            for (let i = 0; i < r.length; i++) {
              const a = r[i]!, b = r[(i + 1) % r.length]!;
              if (Math.abs(a.x - pt.x) > 40 || Math.abs(a.y - pt.y) > 40) continue;
              d = Math.min(d, toBoundary([a, b], pt));
            }
          }
          return d;
        };
        let longest = 0;
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          // Only the stretch of edge the honeycomb actually meets.
          let run = 0;
          for (let s = 6; s < len - 6; s += 1) {
            const pt = { x: a.x + ((b.x - a.x) * s) / len, y: a.y + ((b.y - a.y) * s) / len };
            if (pt.x < hx0 || pt.x > hx1 || pt.y < hy0 || pt.y > hy1) { run = 0; continue; }
            const d = near(pt);
            if (!Number.isFinite(d)) { run = 0; continue; }
            run = d > RAIL + 9 ? run + 1 : 0;
            longest = Math.max(longest, run);
          }
        }
        expect(longest).toBeLessThan(14);
      });
    }
  }
});
