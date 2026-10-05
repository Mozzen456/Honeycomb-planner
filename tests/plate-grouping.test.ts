/**
 * Plates counted as "n of the same" really are the same plate (D107).
 *
 * The parts list, the STL download and the 3D view all group plates, and all of
 * them used to group by a description of what a plate was MADE from: part,
 * block, which cells are omitted, which sides carry an edge. With a border on
 * that is not enough. A zone's edge lands wherever it was drawn, so the plate
 * under the zone's CORNER keeps a sliver up the zone's side that its neighbours
 * along the same edge do not — same omitted cells, same edge letters, different
 * plate. The 3D view built one plate per group and stamped it on all of them,
 * which drew that sliver standing up out of the aperture's edge once per plate
 * ("these bugs in the 3D model"), and the parts list downloaded one file for a
 * line whose plates needed two.
 *
 * Measured on the MESH, never on the key: two plates on one line must build
 * the same solid, and the keys must tell apart every pair that does not.
 */
import { describe, expect, it } from 'vitest';

import { panelLineKeys } from '../src/core/bom';
import { hexToMm } from '../src/core/hex';
import { buildHoneycombMesh, meshVolumeMm3 } from '../src/core/honeycomb';
import { panelGeometryKeysFor, panelModelSpecFor } from '../src/core/panelModel';
import { emptyDoc, Store } from '../src/core/store';
import { solveTiling, type PanelSize } from '../src/core/tiling';
import type { Catalog, LayoutDoc, Obstacle, PlacedPanel, WallFrame } from '../src/core/types';

import catalogJson from '../src/catalog/catalog.json';

const catalog = catalogJson as unknown as Catalog;

const FRAME: WallFrame = {
  left: true, right: true, bottom: true, top: true, holes: true, thicknessMm: 3.6,
};

const sizes: PanelSize[] = catalog.parts
  .filter((p) => p.type === 'panel' && p.panel)
  .map((p) => ({
    partId: p.id,
    columns: p.panel!.columns,
    rows: p.panel!.rows,
    widthMm: p.panel!.widthMm,
    heightMm: p.panel!.heightMm,
  }));

const WALL = { widthMm: 2400, heightMm: 1200 };
const SOLVED: PlacedPanel[] = solveTiling({ wall: WALL, bedId: 'bed256', available: sizes })
  .panels.map((p, i) => ({ ...p, id: `p${i}` }));

function wallWith(zone: Omit<Obstacle, 'id' | 'label' | 'clearanceMm'>, frame?: WallFrame): LayoutDoc {
  const store = new Store({ ...emptyDoc(), wall: WALL, bedId: 'bed256', panels: SOLVED }, catalog);
  if (frame) store.setFrame(frame);
  store.setObstacles([{ id: 'z', label: 'Window', clearanceMm: 5, ...zone }]);
  return store.getState().doc;
}

/** The solid a plate builds, moved to its own origin. */
function solid(panel: PlacedPanel, doc: LayoutDoc): string {
  const mesh = buildHoneycombMesh({ ...panelModelSpecFor(panel, doc), originAtZero: false });
  const o = hexToMm(panel.origin);
  const r = (v: number) => {
    const n = Math.round(v * 100);
    return n === 0 ? '0' : String(n);
  };
  const verts = new Set<string>();
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    verts.add(`${r(p[i]! - o.x)},${r(p[i + 1]! - o.y)},${r(p[i + 2]!)}`);
  }
  return `${meshVolumeMm3(mesh).toFixed(1)}|${[...verts].sort().join(' ')}`;
}

/*
 * Zones whose corners land inside plates that share every input with their
 * neighbours — found by sweeping zones over a freshly solved wall and keeping
 * the ones the old grouping got wrong. The first is the report: wide, over the
 * middle of the wall, its corner plate keeping a column up the zone's side
 * while the plates along its bottom edge do not, so the old 3D view drew that
 * column as a spike on every plate in the row.
 */
const ZONES = [
  { xMm: 843, yMm: 656, widthMm: 906, heightMm: 379 },
  { xMm: 225, yMm: 440, widthMm: 930, heightMm: 406 },
  { xMm: 512, yMm: 621, widthMm: 494, heightMm: 215 },
  { xMm: 1394, yMm: 493, widthMm: 779, heightMm: 451 },
];

describe('one parts-list line is one plate', () => {
  for (const zone of ZONES) {
    for (const frame of [FRAME, undefined]) {
      it(`every plate on a line builds the same solid — zone at ${zone.xMm},${zone.yMm}, ${frame ? 'bordered' : 'no border'}`, () => {
        const doc = wallWith(zone, frame);
        const byLine = new Map<string, PlacedPanel[]>();
        for (const [id, line] of panelLineKeys(doc)) {
          const list = byLine.get(line) ?? [];
          list.push(doc.panels.find((p) => p.id === id)!);
          byLine.set(line, list);
        }
        const wrong: string[] = [];
        for (const [line, plates] of byLine) {
          if (plates.length < 2) continue;
          const first = solid(plates[0]!, doc);
          for (const p of plates.slice(1)) {
            if (solid(p, doc) !== first) wrong.push(`${line}: ${plates[0]!.id} vs ${p.id}`);
          }
        }
        expect(wrong).toEqual([]);
      });
    }
  }

  it('the geometry key tells apart exactly the plates that differ', () => {
    const doc = wallWith(ZONES[0]!, FRAME);
    const keys = panelGeometryKeysFor(doc);
    const solids = new Map(doc.panels.map((p) => [p.id, solid(p, doc)]));
    let pairs = 0;
    for (let i = 0; i < doc.panels.length; i++) {
      for (let j = i + 1; j < doc.panels.length; j++) {
        const a = doc.panels[i]!, b = doc.panels[j]!;
        if (a.partId !== b.partId) continue;
        pairs++;
        expect(keys.get(a.id) === keys.get(b.id), `${a.id} / ${b.id}`)
          .toBe(solids.get(a.id) === solids.get(b.id));
      }
    }
    expect(pairs).toBeGreaterThan(100);
  });

  it('a zone moved without changing which cells it omits re-keys the plates it cut', () => {
    // The 3D hover cache is never cleared, so a key that did not move with the
    // zone kept lighting the plate as it was before the drag.
    const a = wallWith(ZONES[0]!, FRAME);
    const b = wallWith({ ...ZONES[0]!, yMm: ZONES[0]!.yMm + 2 }, FRAME);
    const ka = panelGeometryKeysFor(a);
    const kb = panelGeometryKeysFor(b);
    const moved = a.panels.filter((p) => {
      const q = b.panels.find((x) => x.id === p.id);
      return q && JSON.stringify(q.omit ?? []) === JSON.stringify(p.omit ?? [])
        && (p.omit?.length ?? 0) > 0 && ka.get(p.id) !== kb.get(p.id);
    });
    expect(moved.length).toBeGreaterThan(0);
  });
});
