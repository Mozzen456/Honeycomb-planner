/*
 * Which plate owns a cell, for the hover highlight.
 *
 * The 3D view answers "what am I pointing at" by finding the panel whose cells
 * contain the hovered one. That was `placedPanelCells`, and on a BORDERED wall
 * the outermost ring is printed but leaves through `omit` exactly as a switch's
 * cells do (D87) — so the whole rim belonged to no panel, and pointing at the
 * edge of the wall lit nothing at all. The edge is the part of a wall you are
 * most likely to point at.
 *
 * The rule is stated here rather than in the renderer because a renderer cannot
 * be tested without a browser, and this is the whole of the decision.
 */
import { describe, expect, it } from 'vitest';

import { hexKey, panelCells, placedPanelCells } from '../src/core/hex';
import { borderCutCells } from '../src/core/panelModel';
import { cutAroundObstacles } from '../src/core/store';
import type { Hex, PlacedPanel, WallFrame } from '../src/core/types';

const FRAME: WallFrame = {
  left: true, right: true, bottom: true, top: true, holes: true, thicknessMm: 3.6,
};

/** The rule the view uses: surviving cells, plus the ring a border cut. */
function ownerOf(
  cell: Hex, panels: readonly PlacedPanel[], borderCut: ReadonlySet<string>,
): PlacedPanel | undefined {
  const onBorder = borderCut.has(hexKey(cell));
  return panels.find((p) =>
    placedPanelCells(p).some((c) => c.q === cell.q && c.r === cell.r)
    || (onBorder && panelCells(p.origin, p.columns, p.rows)
      .some((c) => c.q === cell.q && c.r === cell.r)));
}

function wall(frame: WallFrame | undefined) {
  const raw: PlacedPanel[] = [
    { id: 'a', partId: 'x', origin: { q: 0, r: 0 }, columns: 6, rows: 5 },
    { id: 'b', partId: 'x', origin: { q: 6, r: -3 }, columns: 6, rows: 5 },
  ];
  const panels = cutAroundObstacles(raw, [], frame);
  return { panels, borderCut: borderCutCells(panels, frame) };
}

describe('which plate the hover highlight lights', () => {
  it('has a border ring that no panel claims through its surviving cells', () => {
    // Pins the shape of the bug: this is why the rim lit nothing.
    const { panels, borderCut } = wall(FRAME);
    expect(borderCut.size).toBeGreaterThan(0);
    const survivors = new Set(panels.flatMap((p) => placedPanelCells(p).map(hexKey)));
    for (const key of borderCut) expect(survivors.has(key)).toBe(false);
  });

  it('gives every cut ring cell back to exactly one plate', () => {
    const { panels, borderCut } = wall(FRAME);
    for (const key of borderCut) {
      const [q, r] = key.split(',').map(Number);
      const cell = { q: q!, r: r! };
      const owners = panels.filter((p) =>
        panelCells(p.origin, p.columns, p.rows)
          .some((c) => c.q === cell.q && c.r === cell.r));
      // A position between two blocks would be ambiguous; the rim is not.
      expect(owners.length).toBe(1);
      expect(ownerOf(cell, panels, borderCut)?.id).toBe(owners[0]!.id);
    }
  });

  it('still claims every ordinary cell, bordered or not', () => {
    for (const frame of [FRAME, undefined]) {
      const { panels, borderCut } = wall(frame);
      for (const p of panels) {
        for (const c of placedPanelCells(p)) {
          expect(ownerOf(c, panels, borderCut)?.id).toBe(p.id);
        }
      }
    }
  });

  it('claims nothing off the wall', () => {
    const { panels, borderCut } = wall(FRAME);
    expect(ownerOf({ q: 40, r: 40 }, panels, borderCut)).toBeUndefined();
  });
});
