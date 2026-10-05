/**
 * A plate a zone covers completely comes back when the zone stops covering it
 * (D117).
 *
 * `cutAroundObstacles` has always recomputed `omit` from scratch so that moving
 * a switch back restores the cells it took. A plate whose EVERY cell was taken
 * was dropped from the document instead, which is that same accumulation one
 * level up: nothing remembered it, so moving or shrinking the zone afterwards
 * left a plate-sized hole until the wall was solved again. A zone is dragged
 * with a commit per frame, so simply dragging a big one across the wall ate
 * every plate it passed over.
 */
import { describe, expect, it } from 'vitest';

import { moveZone } from '../src/core/measure';
import { deserialize, serialize } from '../src/core/persist';
import { emptyDoc, Store } from '../src/core/store';
import { solveTiling, type PanelSize } from '../src/core/tiling';
import type { Catalog, Obstacle, WallFrame } from '../src/core/types';

import catalogJson from '../src/catalog/catalog.json';

const catalog = catalogJson as unknown as Catalog;

const sizes: PanelSize[] = catalog.parts
  .filter((p) => p.type === 'panel' && p.panel)
  .map((p) => ({
    partId: p.id,
    columns: p.panel!.columns,
    rows: p.panel!.rows,
    widthMm: p.panel!.widthMm,
    heightMm: p.panel!.heightMm,
  }));

const WALL = { widthMm: 1600, heightMm: 900 };
const solved = () => solveTiling({ wall: WALL, bedId: 'bed256', available: sizes })
  .panels.map((p, i) => ({ ...p, id: `p${i}` }));

const FRAME: WallFrame = {
  left: true, right: true, bottom: true, top: true, holes: true, thicknessMm: 3.6,
};

/** A zone big enough to swallow at least one whole plate. */
const BIG: Obstacle = {
  id: 'z', label: 'Doorway', xMm: 300, yMm: 150, widthMm: 700, heightMm: 600, clearanceMm: 5,
};

const ids = (store: Store) => store.getState().doc.panels.map((p) => p.id).sort();

describe('a plate a zone swallows is set aside, not forgotten', () => {
  for (const frame of [undefined, FRAME]) {
    const label = frame ? 'with a border' : 'without a border';

    it(`a zone moved off a plate it covered gives the plate back — ${label}`, () => {
      const store = new Store({ ...emptyDoc(), wall: WALL, panels: solved() }, catalog);
      if (frame) store.setFrame(frame);
      const before = ids(store);
      const omitsBefore = JSON.stringify(store.getState().doc.panels);

      store.setObstacles([BIG]);
      const swallowed = before.filter((id) => !ids(store).includes(id));
      // The fixture has to be able to fail: the zone must really eat a plate.
      expect(swallowed.length).toBeGreaterThan(0);
      expect(store.getState().doc.covered?.map((p) => p.id).sort()).toEqual(swallowed);

      store.setObstacles([]);
      expect(ids(store)).toEqual(before);
      expect(store.getState().doc.covered).toBeUndefined();
      // Exactly the wall it was, cuts included — not merely the same ids.
      const sorted = (s: string) => JSON.stringify(
        (JSON.parse(s) as { id: string }[]).sort((a, b) => (a.id < b.id ? -1 : 1)));
      expect(sorted(JSON.stringify(store.getState().doc.panels))).toEqual(sorted(omitsBefore));
    });

    it(`dragging a zone across the wall leaves no hole behind it — ${label}`, () => {
      const store = new Store({ ...emptyDoc(), wall: WALL, panels: solved() }, catalog);
      if (frame) store.setFrame(frame);
      store.setObstacles([{ ...BIG, xMm: 20 }]);
      const start = store.getState().doc.obstacles![0]!;
      // One commit per frame, the way the plan's zone drag does it.
      for (let dx = 0; dx <= 600; dx += 25) store.setObstacles([moveZone(start, dx, 0)]);
      const afterDrag = ids(store);
      // And back to where it started: the wall must be the wall it was there.
      store.setObstacles([start]);
      const atStart = ids(store);
      store.setObstacles([]);
      expect(ids(store)).toEqual(solved().map((p) => p.id).sort());
      expect(afterDrag.length).toBeGreaterThan(0);
      expect(atStart.length).toBeGreaterThan(0);
    });
  }

  it('survives a save and a reload, and a layout without any keeps no key', () => {
    const store = new Store({ ...emptyDoc(), wall: WALL, panels: solved() }, catalog);
    expect(serialize(store.getState().doc)).not.toContain('"covered"');
    store.setObstacles([BIG]);
    const doc = store.getState().doc;
    const back = deserialize(serialize(doc));
    expect(back.errors).toEqual([]);
    expect(back.doc!.covered).toEqual(doc.covered);
    const again = new Store(back.doc!, catalog);
    again.setObstacles([]);
    expect(ids(again)).toEqual(solved().map((p) => p.id).sort());
  });

  it('a new solve forgets what the old layout set aside', () => {
    const store = new Store({ ...emptyDoc(), wall: WALL, panels: solved() }, catalog);
    store.setObstacles([BIG]);
    expect(store.getState().doc.covered?.length).toBeGreaterThan(0);
    store.setObstacles([]);
    store.setPanels(solved().slice(0, 3));
    store.setObstacles([BIG]);
    store.setObstacles([]);
    expect(ids(store)).toEqual(['p0', 'p1', 'p2']);
  });
});
