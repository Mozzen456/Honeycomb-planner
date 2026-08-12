/**
 * Custom panels round-trip through the OpenSCAD customiser's parameters.
 *
 * The risk here is the same one `panel-parity.test.ts` guards: the customiser is
 * flat-top and the wall is pointy-top, so the conversion is a 90° turn plus a
 * stagger parity. Get the parity wrong and the generated plate is a MIRROR of
 * the one you designed — which nothing catches until it is printed and the
 * holes are on the wrong side of the switch.
 *
 * So the mapping is not asserted against hand-written numbers. Every case is
 * checked by converting the panel to parameters, expanding those parameters
 * back into cells with the customiser's own arithmetic, and requiring the exact
 * same cell set the app started with.
 */

import { describe, expect, it } from 'vitest';

import { toCustomiserPanel, toCustomiserScad, customPanelGroups, type CustomiserPanel } from '../src/core/customiser';
import { hexKey, placedPanelCells } from '../src/core/hex';
import type { Hex, PlacedPanel } from '../src/core/types';

/**
 * Expand customiser parameters the way the .scad file does.
 *
 * Deliberately written from the customiser's own loop — column, row, the `lo`
 * stagger term and the gap skip — rather than by inverting our own conversion,
 * so a mistake in the conversion cannot cancel itself out here.
 */
function expand(p: CustomiserPanel): { col: number; row: number }[] {
  const out: { col: number; row: number }[] = [];
  for (let col = 0; col < p.columns; col++) {
    const height = p.columnHeights[col] ?? 0;
    const skip = new Set(
      (p.gaps[col] ?? '').split(',').filter((s) => s.length > 0).map((s) => Number(s)),
    );
    for (let r = 0; r < height; r++) {
      if (skip.has(r + 1)) continue;
      out.push({ col, row: r + (p.offsets[col] ?? 0) });
    }
  }
  return out;
}

/** The app cells those (col,row) pairs mean, given the parity. */
function toWallCells(
  pairs: { col: number; row: number }[], flip: boolean, colBase: number, rowBase: number,
): string[] {
  return pairs
    .map(({ col, row }) => {
      const r = col + colBase;
      const lo = (((r + (flip ? 1 : 0)) % 2) + 2) % 2;
      const q = row + rowBase - (r - lo) / 2;
      return hexKey({ q, r });
    })
    .sort();
}

function roundTrips(panel: PlacedPanel): void {
  const params = toCustomiserPanel(panel);
  expect(params, 'panel could not be expressed').not.toBeNull();
  const wanted = placedPanelCells(panel).map(hexKey).sort();
  const got = toWallCells(expand(params!), params!.flipStaggering, params!.colBase, params!.rowBase);
  expect(got).toEqual(wanted);
  expect(params!.cellCount).toBe(wanted.length);
}

const panel = (over: Partial<PlacedPanel> = {}): PlacedPanel => ({
  id: 'p1',
  partId: 'wall-honeycomb-part',
  origin: { q: 0, r: 0 },
  columns: 4,
  rows: 4,
  ...over,
});

describe('toCustomiserPanel', () => {
  it('round-trips a plain block', () => {
    roundTrips(panel());
  });

  it('round-trips blocks of every shape the tiler produces', () => {
    for (const columns of [1, 2, 3, 5, 7, 9]) {
      for (const rows of [1, 2, 3, 4, 8, 10]) {
        roundTrips(panel({ columns, rows }));
      }
    }
  });

  it('round-trips a block anywhere on the lattice, both parities', () => {
    // Origin parity is what decides `Flip_Staggering`; an odd row and an even
    // row must both come back exactly.
    for (const origin of [
      { q: 0, r: 0 }, { q: 1, r: 0 }, { q: 0, r: 1 }, { q: 3, r: 5 },
      { q: -4, r: 2 }, { q: -1, r: -3 }, { q: 7, r: -2 },
    ]) {
      roundTrips(panel({ origin, columns: 5, rows: 5 }));
    }
  });

  it('round-trips a panel with a hole cut in the middle for a switch', () => {
    const p = panel({ columns: 5, rows: 5, omit: [{ q: 1, r: 2 }, { q: 2, r: 2 }, { q: 1, r: 3 }] });
    roundTrips(p);
    const params = toCustomiserPanel(p)!;
    // The hole shows up as gaps, which is the customiser's own feature for it.
    expect(params.gaps.join('')).not.toBe('');
  });

  it('round-trips a hole cut out of a corner', () => {
    roundTrips(panel({ columns: 4, rows: 4, omit: [{ q: 0, r: 0 }] }));
    roundTrips(panel({ columns: 4, rows: 4, omit: [{ q: -2, r: 3 }] }));
  });

  it('refuses a panel bigger than the customiser can express', () => {
    expect(toCustomiserPanel(panel({ columns: 4, rows: 20 }))).toBeNull();
    expect(toCustomiserPanel(panel({ columns: 4, rows: 40 }))).toBeNull();
  });

  it('refuses an empty panel rather than emitting a blank plate', () => {
    expect(toCustomiserPanel(panel({ columns: 0, rows: 0 }))).toBeNull();
  });
});

describe('toCustomiserScad', () => {
  it('emits every parameter the customiser declares, so nothing keeps a stale value', () => {
    const params = toCustomiserPanel(panel({ columns: 3, rows: 3, omit: [{ q: 1, r: 1 }] }))!;
    const scad = toCustomiserScad(params, 'Panel A');
    expect(scad).toContain('Number_of_Columns = 3;');
    expect(scad).toContain('Flip_Staggering =');
    // All thirteen of each, including the ones past the panel's own width: a
    // customiser session that already had Column_7 = 5 must be overwritten.
    for (let i = 0; i < 13; i++) {
      expect(scad, `Column_${i}`).toContain(`Column_${i} = `);
      expect(scad, `Gap_Column_${i}`).toContain(`Gap_Column_${i} = "`);
      expect(scad, `Column_Offset_${i}`).toContain(`Column_Offset_${i} = `);
    }
  });
});

describe('customPanelGroups', () => {
  it('groups identical cut-outs and ignores stock panels', () => {
    const cut: Hex[] = [{ q: 1, r: 1 }];
    const groups = customPanelGroups([
      panel({ id: 'a', omit: cut }),
      panel({ id: 'b', origin: { q: 10, r: 0 }, omit: [{ q: 11, r: 1 }] }), // same shape, moved
      panel({ id: 'c' }), // stock: not a custom panel at all
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.panels.map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(groups[0]!.params).not.toBeNull();
  });

  it('keeps differently-cut panels apart', () => {
    const groups = customPanelGroups([
      panel({ id: 'a', omit: [{ q: 1, r: 1 }] }),
      panel({ id: 'b', omit: [{ q: 2, r: 2 }] }),
    ]);
    expect(groups).toHaveLength(2);
  });
});
