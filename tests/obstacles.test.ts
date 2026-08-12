/**
 * Planning round a light switch.
 *
 * The wall cannot be cut with a knife: a panel that has to go round a switch is
 * a different plate, generated from the customiser rather than printed from a
 * stock STL. These check the whole chain — obstacle in millimetres, cells cut,
 * panels marked, parts list telling the truth about what to print.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { computeBom } from '../src/core/bom';
import { isCustomPanel, toCustomiserPanel } from '../src/core/customiser';
import { hexKey, hexToMm, placedPanelCells } from '../src/core/hex';
import { cellClashes, makeObstacle, obstructedCells, OBSTACLE_PRESETS } from '../src/core/obstacles';
import { cutAroundObstacles, emptyDoc, Store } from '../src/core/store';
import type { Catalog, Obstacle, PlacedPanel } from '../src/core/types';

const catalog = catalogJson as unknown as Catalog;
const SWITCH = OBSTACLE_PRESETS[0]!;

const panel = (over: Partial<PlacedPanel> = {}): PlacedPanel => ({
  id: 'p1',
  partId: 'wall-honeycomb-part',
  origin: { q: 0, r: 0 },
  columns: 7,
  rows: 8,
  ...over,
});

describe('cellClashes', () => {
  it('takes the whole hexagon, not just its centre', () => {
    // A switch plate covering the edge of a cell still stops an insert going in,
    // so the cell's real 23.6 x 27.25 envelope is what is tested.
    const cell = { q: 2, r: 2 };
    const p = hexToMm(cell);
    const justClipping: Obstacle = {
      id: 'o', label: 'switch',
      xMm: p.x + 11, yMm: p.y - 5, widthMm: 20, heightMm: 20, clearanceMm: 0,
    };
    expect(cellClashes(cell, justClipping)).toBe(true);

    const wellClear: Obstacle = { ...justClipping, xMm: p.x + 40 };
    expect(cellClashes(cell, wellClear)).toBe(false);
  });

  it('honours the clearance', () => {
    const cell = { q: 0, r: 0 };
    const p = hexToMm(cell);
    const near: Obstacle = {
      id: 'o', label: 'switch',
      xMm: p.x + 20, yMm: p.y, widthMm: 10, heightMm: 10, clearanceMm: 0,
    };
    expect(cellClashes(cell, near)).toBe(false);
    expect(cellClashes(cell, { ...near, clearanceMm: 10 })).toBe(true);
  });
});

describe('cutAroundObstacles', () => {
  it('cuts a switch out of the panel it lands on', () => {
    const p = panel();
    const centre = hexToMm({ q: 3, r: 4 });
    const obstacle = makeObstacle('o1', SWITCH, centre.x - SWITCH.widthMm / 2, centre.y - SWITCH.heightMm / 2);

    const cut = cutAroundObstacles([p], [obstacle]);
    expect(cut).toHaveLength(1);
    expect(isCustomPanel(cut[0]!)).toBe(true);
    // An 86 mm plate plus clearance covers several 23.6 mm cells.
    expect(cut[0]!.omit!.length).toBeGreaterThanOrEqual(4);

    // ...and the cut cells really are the obstructed ones, no more.
    const block = placedPanelCells(p);
    const blocked = obstructedCells([obstacle], block);
    expect(cut[0]!.omit!.map(hexKey).sort()).toEqual([...blocked].sort());
    // The remaining cells are exactly the block minus the cut.
    expect(placedPanelCells(cut[0]!)).toHaveLength(block.length - blocked.size);
  });

  it('leaves a panel the obstacle misses completely alone', () => {
    const far = makeObstacle('o1', SWITCH, 5000, 5000);
    const cut = cutAroundObstacles([panel()], [far]);
    expect(cut[0]!.omit).toBeUndefined();
    expect(isCustomPanel(cut[0]!)).toBe(false);
  });

  it('drops a panel the obstacle swallows whole', () => {
    // A pipe running the height of a small panel leaves no plate to print.
    const huge: Obstacle = {
      id: 'o', label: 'chimney breast',
      xMm: -500, yMm: -500, widthMm: 2000, heightMm: 2000, clearanceMm: 0,
    };
    expect(cutAroundObstacles([panel()], [huge])).toEqual([]);
  });

  it('recomputes rather than accumulates, so moving a switch back restores the cells', () => {
    const centre = hexToMm({ q: 3, r: 4 });
    const here = makeObstacle('o1', SWITCH, centre.x, centre.y);
    const moved = { ...here, xMm: here.xMm + 400 };

    const once = cutAroundObstacles([panel()], [here]);
    const thenMoved = cutAroundObstacles(once, [moved]);
    const backAgain = cutAroundObstacles(thenMoved, [here]);

    // An accumulating cut would leave the wall pockmarked by every position the
    // obstacle had ever been in.
    expect(backAgain[0]!.omit!.map(hexKey).sort()).toEqual(once[0]!.omit!.map(hexKey).sort());
  });
});

describe('the store keeps the wall in step with the obstacles', () => {
  it('re-cuts the panels when an obstacle is added, without re-solving', () => {
    const store = new Store(emptyDoc(), catalog);
    store.setPanels([panel()]);
    expect(isCustomPanel(store.getState().doc.panels[0]!)).toBe(false);

    const centre = hexToMm({ q: 3, r: 4 });
    store.setObstacles([makeObstacle('o1', SWITCH, centre.x, centre.y)]);
    expect(isCustomPanel(store.getState().doc.panels[0]!)).toBe(true);

    // ...and removing it puts the wall back exactly as it was.
    store.setObstacles([]);
    expect(isCustomPanel(store.getState().doc.panels[0]!)).toBe(false);
  });

  it('cuts panels laid out after the obstacle too', () => {
    const store = new Store(emptyDoc(), catalog);
    const centre = hexToMm({ q: 3, r: 4 });
    store.setObstacles([makeObstacle('o1', SWITCH, centre.x, centre.y)]);
    store.setPanels([panel()]);
    expect(isCustomPanel(store.getState().doc.panels[0]!)).toBe(true);
  });
});

describe('the parts list tells the truth about a cut wall', () => {
  it('does not count a cut panel as a stock plate', () => {
    const centre = hexToMm({ q: 3, r: 4 });
    const cut = cutAroundObstacles(
      [panel({ id: 'a' }), panel({ id: 'b', origin: { q: 20, r: 0 } })],
      [makeObstacle('o1', SWITCH, centre.x, centre.y)],
    );
    const doc = { ...emptyDoc(), panels: cut };
    const bom = computeBom(doc, catalog);

    // One plate is still stock; the other is not, and printing two of the stock
    // file would leave you with a panel that does not fit round the switch.
    const stock = bom.printed.find((l) => l.partId === 'wall-honeycomb-part');
    expect(stock?.quantity).toBe(1);

    const custom = bom.printed.filter((l) => l.partId.startsWith('custom/'));
    expect(custom).toHaveLength(1);
    expect(custom[0]!.quantity).toBe(1);
    expect(custom[0]!.estimated).toBe(true);
    // Less plate to print than the stock one it came from.
    expect(custom[0]!.grams).toBeLessThan(stock!.grams);
  });

  it('gives every cut panel customiser parameters that describe it', () => {
    const centre = hexToMm({ q: 3, r: 4 });
    const cut = cutAroundObstacles([panel()], [makeObstacle('o1', SWITCH, centre.x, centre.y)]);
    const params = toCustomiserPanel(cut[0]!);
    expect(params).not.toBeNull();
    expect(params!.cellCount).toBe(placedPanelCells(cut[0]!).length);
    // Fewer cells than the stock block it came from.
    expect(params!.cellCount).toBeLessThan(placedPanelCells(panel()).length);
    // The cut is expressed as SOME combination of shorter columns, offsets and
    // gaps — which of the three depends on where the switch lands, and all
    // three are legal. What matters is that the parameters reproduce the shape
    // exactly, and tests/customiser.test.ts proves that by round-trip.
    const described = params!.columnHeights.reduce((n, h, i) => {
      const skipped = (params!.gaps[i] ?? '').split(',').filter((x) => x.length > 0).length;
      return n + h - skipped;
    }, 0);
    expect(described).toBe(params!.cellCount);
  });
});
