/**
 * The frame as a DOCUMENT feature: cutting, saving, and who owns which cells.
 *
 * `honeycomb-frame.test.ts` checks the geometry. This checks the plumbing, and
 * the one rule that ties the two together and is easy to get backwards:
 *
 *   **The planner and the printer see a framed edge differently, on purpose.**
 *   To the planner those cells are gone — they are half hexagons and nothing
 *   mounts in one — so they live in `omit` and every existing rule (placement,
 *   the parts list, the fixing plan) drops them without being taught that frames
 *   exist. To the printer they are still material. `panelModelSpec` is the one
 *   place that puts them back, and if it ever stops, the plate is generated with
 *   a column of holes where its frame should be.
 */

import { describe, expect, it } from 'vitest';

import { MARGIN_X, MARGIN_Y } from '../src/core/constants';
import { panelCells } from '../src/core/hex';

import {
  buildHoneycombMesh, cellCentreBounds, DEFAULT_BORDER_MM, meshBoundsMm, meshIsClosed,
  meshVolumeMm3,
} from '../src/core/honeycomb';
import {
  frameIsOn, isGeneratedPanel, panelFrameKey, panelFrameSides, panelIsBordered, panelModelSpec,
  panelModelSpecFor,
} from '../src/core/panelModel';
import { deserialize, serialize } from '../src/core/persist';
import { cutAroundObstacles, emptyDoc, Store } from '../src/core/store';
import catalogJson from '../src/catalog/catalog.json';
import type { Catalog, LayoutDoc, PlacedPanel, WallFrame } from '../src/core/types';

const catalog = catalogJson as unknown as Catalog;

const ALL: WallFrame = {
  left: true, right: true, bottom: true, top: true, holes: true, thicknessMm: 3.6,
};
const LEFT: WallFrame = { ...ALL, right: false, bottom: false, top: false, holes: false };

const panel = (over: Partial<PlacedPanel> = {}): PlacedPanel => ({
  id: 'p1', partId: 'wall-honeycomb-part', origin: { q: 0, r: 0 }, columns: 4, rows: 4, ...over,
});

const docWith = (panels: PlacedPanel[], frame?: WallFrame): LayoutDoc => ({
  ...emptyDoc(), panels, ...(frame ? { frame } : {}),
});

describe('what a border does to the cells', () => {
  it('takes the outer ring, and nothing behind it', () => {
    /*
     * D59's headline claim, REVERSED by D86, which is why it is worth stating
     * as the reversal. The border used to add material outside the honeycomb
     * and cost no cells; the plate's edge is a straight cut through the
     * outermost cells now — what the printed reference shows at its aperture,
     * applied to the outside — so that one ring goes.
     *
     * The half cells still PRINT: they are the rim. They just stop being
     * somewhere to mount anything, which is the split this module owns (D56).
     */
    const cut = cutAroundObstacles([panel()], [], LEFT);
    expect(cut.length).toBe(1);
    expect(cut[0]!.omit).toHaveLength(4);        // the left column, and only it
    const spec = panelModelSpec(cut[0]!, [cut[0]!], LEFT);
    expect(spec.cells.length).toBe(12);          // what the planner sees...
    expect(spec.clipped.length).toBe(4);         // ...and what the plate prints
    expect(spec.border).toBeDefined();
  });

  it('takes none of them with no border switched on', () => {
    const cut = cutAroundObstacles([panel()], [], undefined);
    expect(cut[0]!.omit).toBeUndefined();
    expect(panelModelSpec(cut[0]!, [cut[0]!], undefined).cells.length).toBe(16);
  });

  it('leaves a plate alone when nothing is switched on', () => {
    expect(frameIsOn(undefined)).toBe(false);
    expect(frameIsOn({ ...ALL, left: false, right: false, bottom: false, top: false, holes: false }))
      .toBe(false);
    expect(panelModelSpec(panel(), [panel()], undefined).border).toBeUndefined();
  });

  it('still cuts round an obstacle, which is a different thing entirely', () => {
    const obstacle = {
      id: 'o', label: 'Switch', xMm: 20, yMm: 20, widthMm: 30, heightMm: 30, clearanceMm: 0,
    };
    const cut = cutAroundObstacles([panel()], [obstacle]);
    expect(cut.length).toBe(1);
    expect((cut[0]!.omit ?? []).length).toBeGreaterThan(0);
    // ...and the cells it took are gone from what the generator is handed,
    // unlike a border's, which are never taken in the first place.
    expect(panelModelSpec(cut[0]!, cut, ALL).cells.length).toBeLessThan(16);
  });
});

describe('the store', () => {
  it('re-cuts the panels, because switching an edge on changes which cells exist', () => {
    /*
     * The plumbing D86 needed and the reason it goes through the same call a
     * blocked zone does. An edge CUTS now, so the ring it halves has to leave
     * the planner the moment it is switched on — and come back the moment it is
     * switched off, or a plate keeps a hole in its parts list for a cell it no
     * longer has.
     */
    const store = new Store(docWith([panel()]), catalog);
    expect(store.getState().doc.panels[0]!.omit).toBeUndefined();
    store.setFrame(LEFT);
    expect(store.getState().doc.frame).toEqual(LEFT);
    expect(store.getState().doc.panels[0]!.omit).toHaveLength(4);
    store.setFrame(undefined);
    expect(store.getState().doc.frame).toBeUndefined();
    expect(store.getState().doc.panels[0]!.omit).toBeUndefined();
  });

  it('PRINTS the ring it took from the planner', () => {
    /*
     * The one that was missed, and the shape of it is worth keeping.
     *
     * `omit` is how a cut cell leaves the planner, and `panelModelSpec` hands
     * the omitted cells to the generator as `clipped` — which the generator only
     * ever cut against a ZONE. So with a border and no zones there was nothing
     * to clip them against and they were dropped: every plate came out with its
     * outermost ring simply MISSING, a whole cell short on each bordered side.
     * Still watertight, still passing every geometry case in the suite, because
     * every one of those builds a spec by hand and none of them goes through
     * the store.
     *
     * A cut cell is now cut by everything that cuts it — the zones it meets and
     * the plate's own lines — so the two routes into `clipped` compose instead
     * of one silently cancelling the other.
     */
    const store = new Store(docWith([panel({ columns: 5, rows: 5 })]), catalog);
    store.setFrame(ALL);
    const doc = store.getState().doc;
    const placed = doc.panels[0]!;
    const spec = panelModelSpecFor(placed, doc);
    expect(spec.clipped.length).toBeGreaterThan(0);

    const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
    expect(meshIsClosed(mesh).unmatchedEdges).toBe(0);
    // The plate reaches its own outermost cell centres on all four sides. Drop
    // the ring and it stops a whole lattice step short of every one of them.
    const b = cellCentreBounds(panelCells(placed.origin, placed.columns, placed.rows));
    const box = meshBoundsMm(mesh);
    expect(box.min[0]!).toBeCloseTo(b.minX, 9);
    expect(box.max[0]!).toBeCloseTo(b.maxX, 9);
    expect(box.min[1]!).toBeCloseTo(b.minY, 9);
    expect(box.max[1]!).toBeCloseTo(b.maxY, 9);
  });

  it('does not eat another ring every time anything else changes', () => {
    /*
     * The runaway underneath the same fault. `omit` is rebuilt from the whole
     * block on every edit and the ring is chosen against the assembly's bounds
     * — so bounds read off the cells that SURVIVE `omit` walk inward one lattice
     * step per edit. Three edits and a plate is three rings short, with nothing
     * on screen to say why.
     */
    const store = new Store(docWith([panel({ columns: 6, rows: 6 })]), catalog);
    store.setFrame(ALL);
    const ring = store.getState().doc.panels[0]!.omit!.length;
    expect(ring).toBeGreaterThan(0);
    store.setObstacles([]);
    store.setFrame(ALL);
    store.setObstacles([]);
    expect(store.getState().doc.panels[0]!.omit!.length).toBe(ring);
  });

  it('is undoable like every other command', () => {
    const store = new Store(docWith([panel()]), catalog);
    store.setFrame(ALL);
    expect(store.getState().canUndo).toBe(true);
    store.undo();
    expect(store.getState().doc.frame).toBeUndefined();
  });

  it('stores no frame at all when every side is off', () => {
    // Otherwise an untouched document stops equalling its own reload.
    const store = new Store(docWith([panel()]), catalog);
    store.setFrame({ ...ALL, left: false, right: false, bottom: false, top: false, holes: false });
    expect(store.getState().doc.frame).toBeUndefined();
  });
});

describe('saving', () => {
  it('round-trips a frame field for field, thickness included', () => {
    const doc = docWith([panel()], { ...ALL, thicknessMm: 2.4 });
    const back = deserialize(serialize(doc));
    expect(back.errors).toEqual([]);
    expect(back.doc?.frame).toEqual({ ...ALL, thicknessMm: 2.4 });
  });

  it('round-trips an unframed document to the same bytes it always had', () => {
    const doc = docWith([panel()]);
    const text = serialize(doc);
    expect(text).not.toContain('frame');
    expect(deserialize(text).doc?.frame).toBeUndefined();
  });

  it('drops a frame that is not one, and says so', () => {
    const broken = JSON.parse(serialize(docWith([panel()])));
    broken.frame = 'yes please';
    const back = deserialize(JSON.stringify(broken));
    expect(back.doc?.frame).toBeUndefined();
    expect(back.errors.join(' ')).toContain('frame');
  });

  it('treats a non-boolean side as off rather than as truthy', () => {
    const broken = JSON.parse(serialize(docWith([panel()])));
    broken.frame = {
      left: 1, right: true, bottom: null, top: false, holes: 'yes', thicknessMm: 'thick',
    };
    const back = deserialize(JSON.stringify(broken));
    expect(back.doc?.frame).toEqual({
      left: false, right: true, bottom: false, top: false, holes: false,
      thicknessMm: DEFAULT_BORDER_MM,
    });
    expect(back.errors.length).toBeGreaterThan(0);
  });
});

describe('the plate it generates', () => {
  it('is closed, and has every one of its cells', () => {
    const p = panel();
    const spec = panelModelSpec(p, [p], ALL);
    const mesh = buildHoneycombMesh({ cells: spec.cells, border: spec.border });
    expect(spec.cells.length).toBe(16);
    expect(meshIsClosed(mesh).closed).toBe(true);
    expect(meshVolumeMm3(mesh)).toBeGreaterThan(0);
  });

  it('has more material with a border than without one', () => {
    const p = panel();
    const bare = buildHoneycombMesh({ cells: panelModelSpec(p, [p], undefined).cells });
    const spec = panelModelSpec(p, [p], ALL);
    const edged = buildHoneycombMesh({ cells: spec.cells, border: spec.border });
    expect(meshVolumeMm3(edged)).toBeGreaterThan(meshVolumeMm3(bare));
  });

  it('carries a thicker border when asked for one', () => {
    const p = panel();
    const thin = panelModelSpec(p, [p], { ...ALL, thicknessMm: 1 });
    const thick = panelModelSpec(p, [p], { ...ALL, thicknessMm: 5 });
    const a = meshVolumeMm3(buildHoneycombMesh({ cells: thin.cells, border: thin.border }));
    const b = meshVolumeMm3(buildHoneycombMesh({ cells: thick.cells, border: thick.border }));
    expect(b).toBeGreaterThan(a);
  });
});

describe('which sides a plate meets', () => {
  it('is only the lines its own cells sit on', () => {
    // Two plates side by side: the left one meets the left border, the right one
    // does not. Getting this wrong frames the middle of the wall.
    const left = panel({ id: 'a', origin: { q: 0, r: 0 } });
    const right = panel({ id: 'b', origin: { q: 4, r: -2 } });
    const panels = [left, right];
    expect(panelFrameSides(left, panels, LEFT).left).toBe(true);
    expect(panelFrameSides(right, panels, LEFT).left).toBe(false);
  });

  it('keys two mirror-image plates apart', () => {
    // The reason the key exists: same shape, opposite border, different plate.
    const a = panel({ id: 'a', origin: { q: 0, r: 0 } });
    const b = panel({ id: 'b', origin: { q: 4, r: -2 } });
    const panels = [a, b];
    const sides: WallFrame = { ...ALL, bottom: false, top: false, holes: false };
    expect(panelFrameKey(a, panels, sides)).not.toBe(panelFrameKey(b, panels, sides));
  });

  it('is empty when there is no frame, so nothing is split needlessly', () => {
    expect(panelFrameKey(panel(), [panel()], undefined)).toBe('');
  });
});

describe('a bordered plate is never the shipped file', () => {
  it('says so through `panelIsBordered`, which the 3D view has to ask', () => {
    // The gate that was missed. `WallView3D` short-circuits to the shipped mesh
    // when a plate has no cut-outs and a catalogue id — and a bordered plate has
    // both. So the plan drew a border, the parts list said "edged top + left",
    // and the wall in 3D was the plain stock plate (D66). Three things stop a
    // plate being stock and all three have to be checked.
    const p = panel();
    expect(isGeneratedPanel(p)).toBe(false);          // no cut, catalogue id...
    expect(panelIsBordered(p, [p], ALL)).toBe(true);  // ...but not stock either.
    expect(panelIsBordered(p, [p], undefined)).toBe(false);
  });

  it('is a SMALLER plate than the stock one, which is how you would notice', () => {
    /*
     * It used to be bigger: the border added `t` past the honeycomb on every
     * side. The edge is a cut now (D86), so a bordered plate ends on its
     * outermost cell CENTRES — it loses a margin each side and gains nothing,
     * whatever `t` is. Stated as the margin rather than as "smaller", because
     * "smaller" alone would also be true of a plate that had simply lost cells.
     *
     * To three decimals: a bare plate's outermost corners are SNAPPED, so its
     * box is 0.0003 mm inside the ideal (D4). The edged plate's is exact — its
     * edge is a clip plane, not a corner — and `plate-edge.test.ts` holds it to
     * 1e-9 there.
     */
    const p = panel();
    const bare = panelModelSpec(p, [p], undefined);
    const edged = panelModelSpec(p, [p], ALL);
    const a = meshBoundsMm(buildHoneycombMesh({ cells: bare.cells, border: bare.border }));
    const b = meshBoundsMm(buildHoneycombMesh({ cells: edged.cells, border: edged.border }));
    expect(b.size[0]!).toBeCloseTo(a.size[0]! - 2 * MARGIN_X, 3);
    expect(b.size[1]!).toBeCloseTo(a.size[1]! - 2 * MARGIN_Y, 3);
  });
});
