/**
 * Every opening stays a full rail away from every blocked zone (D114).
 *
 * The frame round an aperture is the plate between the zone and the nearest
 * bore, and with a border on it is meant to be the border's thickness all the
 * way round. Only cells the zone OVERLAPS used to be cut back to it, so a cell
 * stopping just short of the zone kept its whole bore. A zone edge snapped to
 * the lattice lands exactly on the flats of every other column, whose mouths
 * sit 0.8 mm inside them — so on a rectangle drawn in the app the top and bottom
 * walls measured 0.80 mm a third of the way along and 3.60 everywhere else:
 * reported, with a screenshot, as a frame that "is not consistent".
 *
 * Stated as the property rather than as a thickness on one wall: no point of
 * any bore, at any level, of any plate lies closer to a zone than the rail. It
 * is checked on the rings the generator triangulates, and the mesh is checked
 * closed, because a bore cut is a change to the solid.
 */

import { describe, expect, it } from 'vitest';

import { MARGIN_Y, ROW_STEP } from '../src/core/constants';
import { buildHoneycombMesh, meshIsClosed, plateRings } from '../src/core/honeycomb';
import { zoneFromOutline } from '../src/core/measure';
import { obstacleRects } from '../src/core/obstacles';
import { panelModelSpecFor } from '../src/core/panelModel';
import { emptyDoc, Store } from '../src/core/store';
import { solveTiling, type PanelSize } from '../src/core/tiling';
import type { Catalog, LayoutDoc, Obstacle, PlacedPanel, WallFrame } from '../src/core/types';
import type { Pt } from '../src/core/zonePolygon';

import catalogJson from '../src/catalog/catalog.json';

const catalog = catalogJson as unknown as Catalog;
const RAIL = 3.6;
const FRAME: WallFrame = {
  left: true, right: true, bottom: true, top: true, holes: true, thicknessMm: RAIL,
};

const sizes: PanelSize[] = catalog.parts
  .filter((p) => p.type === 'panel' && p.panel)
  .map((p) => ({
    partId: p.id, columns: p.panel!.columns, rows: p.panel!.rows,
    widthMm: p.panel!.widthMm, heightMm: p.panel!.heightMm,
  }));

function wallWith(bedId: string, zones: Obstacle[], frame: WallFrame | null = FRAME): LayoutDoc {
  const wall = { widthMm: 2400, heightMm: 1200 };
  const panels = solveTiling({ wall, bedId, available: sizes })
    .panels.map((p, i): PlacedPanel => ({ ...p, id: `p${i}` }));
  const store = new Store({ ...emptyDoc(), wall, bedId, panels }, catalog);
  if (frame) store.setFrame(frame);
  store.setObstacles(zones);
  return store.getState().doc;
}

const rect = (xMm: number, yMm: number, widthMm: number, heightMm: number): Obstacle => ({
  id: 'z', label: 'Zone', xMm, yMm, widthMm, heightMm, clearanceMm: 0,
});

/** Distance from a point to a convex polygon it lies outside of (0 if inside). */
function distanceTo(poly: readonly Pt[], p: Pt): number {
  let inside = true;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const ex = b.x - a.x, ey = b.y - a.y;
    // Counter-clockwise polygons have the inside on the left.
    if (ex * (p.y - a.y) - ey * (p.x - a.x) < 0) inside = false;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / (ex * ex + ey * ey)));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * ex), p.y - (a.y + t * ey)));
  }
  return inside ? 0 : best;
}

const ccw = (poly: Pt[]): Pt[] => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a < 0 ? [...poly].reverse() : poly;
};

/** The zone as convex polygons: its rectangles, or its drawn outline's pieces. */
function zonePolys(o: Obstacle): Pt[][] {
  if (o.outline) return [ccw(o.outline.map((p) => ({ x: p.xMm, y: p.yMm })))];
  return obstacleRects(o).map(({ minX, minY, maxX, maxY }) => [
    { x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY },
  ]);
}

/** The nearest any bore point of any plate comes to the zone, and whether every plate closed. */
function nearestBore(doc: LayoutDoc, polys: Pt[][], convexOnly: boolean) {
  let nearest = Infinity;
  let open = 0;
  for (const panel of doc.panels) {
    const spec = { ...panelModelSpecFor(panel, doc), originAtZero: false };
    const { innerRings } = plateRings(spec);
    for (const rings of innerRings.values()) {
      for (const ring of rings) {
        for (const p of ring) {
          for (const poly of polys) nearest = Math.min(nearest, distanceTo(poly, p));
        }
      }
    }
    if (meshIsClosed(buildHoneycombMesh(spec)).unmatchedEdges !== 0) open++;
  }
  void convexOnly;
  return { nearest, open };
}

describe('the frame round a blocked zone is the rail all the way round', () => {
  // The rectangle the report was drawn with: edges on cell centres and flats,
  // which is where the plan's snapping puts them.
  const snapped = rect(749.3934664, 200.6, 919.7099999999999, 743.4);
  const cases: [string, string, Obstacle][] = [
    ['snapped rectangle, MK3S', 'mk3s', snapped],
    ['snapped rectangle, 256 bed', 'bed256', snapped],
    // Edges a hair either side of a flat, and between: every phase a top or
    // bottom edge can land on relative to a column's cells.
    ...[0, 0.3, 0.8, 1.7, 2.9, 3.5, 5.0, 9.0].map((d): [string, string, Obstacle] => [
      `rectangle with its bottom ${d} mm above a flat`, 'bed256',
      rect(600 + d * 3, 4 * 2 * MARGIN_Y + MARGIN_Y + d, 500 + d, 300 + 2 * d),
    ]),
    ['rectangle off-lattice in x', 'bed256', rect(700 + ROW_STEP / 3, 333.3, 410.7, 260.2)],
  ];

  for (const [name, bed, zone] of cases) {
    it(`${name}: no bore comes within the rail, and every plate is closed`, () => {
      const doc = wallWith(bed, [zone]);
      const { nearest, open } = nearestBore(doc, zonePolys(zone), true);
      expect(nearest).toBeGreaterThanOrEqual(RAIL - 1e-6);
      expect(open).toBe(0);
    });
  }

  it('holds for a drawn outline with slanted edges', () => {
    const made = zoneFromOutline(
      [{ x: 500, y: 300 }, { x: 1300, y: 300 }, { x: 900, y: 800 }], 'z', 'Roof', 0,
    );
    if ('problem' in made) throw new Error(made.problem);
    const doc = wallWith('bed256', [made.zone]);
    const { nearest, open } = nearestBore(doc, zonePolys(made.zone), true);
    expect(nearest).toBeGreaterThanOrEqual(RAIL - 1e-6);
    expect(open).toBe(0);
  });

  it('leaves the honeycomb alone with the border off', () => {
    // No border, no rail: the cells are cut at the zone and that is all.
    const doc = wallWith('bed256', [snapped], null);
    const { nearest } = nearestBore(doc, zonePolys(snapped), true);
    expect(nearest).toBeLessThan(RAIL);
  });
});
