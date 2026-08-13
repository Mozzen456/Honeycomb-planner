/**
 * The GHOST must land where the part lands.
 *
 * While a part is being dragged the views draw the cells it would occupy — the
 * green honeycomb. That is a third answer to a question `store.partCells` and
 * `bom.itemCells` already have to agree on exactly, and it was drifting: both
 * ghosts called `placeFootprint` on the RAW footprint while `partCells`
 * subtracts the part's ANCHOR first. The two differ by exactly that anchor, so
 * the green cells sat a cell or two from where the part actually dropped.
 *
 * It hid because every anchor in the shipped catalogue is the origin, where the
 * subtraction is a no-op. It appeared the moment a hand-drawn footprint left the
 * middle cell out (D46) and `anchorOf` moved the anchor to a real cell.
 *
 * This holds the three definitions to each other, for a footprint that does and
 * one that does not contain its own origin.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { hexKey } from '../src/core/hex';
import { applyOverrides } from '../src/core/overrides';
import { partCells } from '../src/core/store';
import type { Catalog, Hex, LayoutDoc } from '../src/core/types';
import { ghostCells } from '../src/ui/WallCanvas';
import { ghost3DCells } from '../src/ui/WallView3D';

const base = catalogJson as unknown as Catalog;
const PART = 'shelf-1';
const emptyDocument = { items: [], panels: [] } as unknown as LayoutDoc;

const keys = (cells: readonly Hex[]): string[] => cells.map(hexKey).sort();

/** The same drop, told three ways. */
function agree(catalog: Catalog, hover: Hex, grabOffset: Hex = { q: 0, r: 0 }): void {
  const part = catalog.parts.find((p) => p.id === PART)!;
  const anchor = { q: hover.q - grabOffset.q, r: hover.r - grabOffset.r };
  const landing = keys(partCells(part, anchor, 0));

  expect(keys(ghostCells({ partId: PART, rotation: 0, grabOffset }, hover, catalog, emptyDocument)))
    .toEqual(landing);
  expect(keys(ghost3DCells({ partId: PART, rotation: 0, grabOffset }, hover, catalog, emptyDocument)))
    .toEqual(landing);
}

describe('the drag ghost', () => {
  it('matches the landing cells for an ordinary footprint', () => {
    agree(base, { q: 4, r: 2 });
    agree(base, { q: -3, r: 7 }, { q: 1, r: 0 });
  });

  /**
   * The case that broke it: a two-peg part that uses the cells above and below
   * its middle and nothing in between, so `anchorOf` puts the anchor on (0,-1)
   * rather than the origin.
   */
  it('matches for a footprint that does not contain its own middle', () => {
    const drawn = applyOverrides(base, {
      parts: { [PART]: { footprint: [{ q: 0, r: -1 }, { q: 0, r: 1 }] } },
    });
    const part = drawn.parts.find((p) => p.id === PART)!;
    expect(part.anchor).toEqual({ q: 0, r: -1 });
    agree(drawn, { q: 4, r: 2 });
    agree(drawn, { q: 0, r: 0 }, { q: 0, r: 1 });
  });

  /** ...and for one whose anchor is somewhere else entirely. */
  it('matches for an off-centre anchor', () => {
    const drawn = applyOverrides(base, {
      parts: { [PART]: { footprint: [{ q: 2, r: 0 }, { q: 3, r: 0 }, { q: 2, r: 1 }] } },
    });
    expect(drawn.parts.find((p) => p.id === PART)!.anchor).toEqual({ q: 2, r: 0 });
    agree(drawn, { q: 5, r: 5 });
  });

  /** Rotation is about the anchor in all three, or a turned part jumps. */
  it('agrees under rotation', () => {
    const drawn = applyOverrides(base, {
      parts: { [PART]: { footprint: [{ q: 0, r: -1 }, { q: 0, r: 1 }] } },
    });
    const part = drawn.parts.find((p) => p.id === PART)!;
    for (let rotation = 0; rotation < 6; rotation++) {
      const drag = { partId: PART, rotation: rotation as 0, grabOffset: { q: 0, r: 0 } };
      const landing = keys(partCells(part, { q: 3, r: 3 }, rotation as 0));
      expect(keys(ghostCells(drag, { q: 3, r: 3 }, drawn, emptyDocument)), `rot ${rotation}`)
        .toEqual(landing);
      expect(keys(ghost3DCells(drag, { q: 3, r: 3 }, drawn, emptyDocument)), `rot ${rotation}`)
        .toEqual(landing);
    }
  });
});
