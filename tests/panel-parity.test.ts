/**
 * `panelCells()` must reproduce the cell map that was MEASURED from the meshes.
 *
 * The catalogue's panel footprints are recovered from the STL cross-sections —
 * every hexagon centre, fitted to the lattice — so they are ground truth. The
 * app separately *generates* a panel's cells from (origin, columns, rows), and
 * nothing was checking the two against each other.
 *
 * They disagreed. The generator staggered odd rows by `-floor(r/2)`, the meshes
 * by `-ceil(r/2)`: a half-pitch error on every odd row, which mirrors the panel
 * for six of the seven shipped sizes. Since a panel is not symmetric — one face
 * is the 20 mm insert throat, the other the 22 mm mouth — a mirrored cell map
 * puts every per-cell instruction on the wrong side.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { hexKey, panelCells } from '../src/core/hex';
import type { Catalog, Hex } from '../src/core/types';

const catalog = catalogJson as unknown as Catalog;
const panels = catalog.parts.filter((p) => p.type === 'panel' && p.panel);

/** Translate a cell set so its lowest (r, then q) cell sits at the origin. */
function normalise(cells: readonly Hex[]): string[] {
  const sorted = [...cells].sort((a, b) => (a.r !== b.r ? a.r - b.r : a.q - b.q));
  const first = sorted[0]!;
  return sorted.map((c) => hexKey({ q: c.q - first.q, r: c.r - first.r })).sort();
}

describe('panelCells reproduces the measured cell map', () => {
  it('has panels to check', () => {
    expect(panels.length).toBe(7);
  });

  for (const part of panels) {
    it(`${part.id} (${part.panel!.columns} x ${part.panel!.rows})`, () => {
      const generated = panelCells({ q: 0, r: 0 }, part.panel!.columns, part.panel!.rows);
      expect(generated).toHaveLength(part.footprint.length);

      // A panel is a physical plate: hanging it the other way up is free, and a
      // 180° turn is a symmetry of the hex lattice (three 60° steps). So the
      // generated map is correct if it matches the measured cells EITHER as
      // drawn OR flipped.
      //
      // Since the frame turned flat-top (D35), ALL SEVEN match as drawn. The
      // allowance is kept because it is a true statement about plates, and
      // because it is what would absorb a new panel drawn the other way up —
      // but nothing needs it today.
      const asDrawn = normalise(part.footprint);
      const flipped = normalise(part.footprint.map((c) => ({ q: -c.q, r: -c.r })));
      const got = normalise(generated);
      const matches = JSON.stringify(got) === JSON.stringify(asDrawn) ? 'as-drawn'
        : JSON.stringify(got) === JSON.stringify(flipped) ? 'flipped-180'
        : 'NEITHER';
      expect(matches, `${part.id} cell map does not match the mesh`).not.toBe('NEITHER');
    });
  }

  it('reports which panels must be hung 180° round', () => {
    const flippedOnes: string[] = [];
    for (const part of panels) {
      const got = normalise(panelCells({ q: 0, r: 0 }, part.panel!.columns, part.panel!.rows));
      if (JSON.stringify(got) !== JSON.stringify(normalise(part.footprint))) {
        flippedOnes.push(part.id);
      }
    }
    // Pinned so a change in the model set is visible rather than silent.
    //
    // EMPTY since the wall turned flat-top (D35), where it was
    // `['wall-honeycomb-224x190size-mk3s']`. That panel never was an oddity in
    // the plate — it was the pointy-top frame's stagger parity disagreeing with
    // the orientation the panel is drawn in, and mk3s was the one panel whose
    // dimensions made the disagreement visible. Turning the frame removed the
    // cause, so every shipped panel now hangs as drawn.
    //
    // This is the strongest form of the check, not a weakened one: the
    // generator reproduces all seven measured footprints exactly, with no
    // flip allowance spent. If a future change reintroduces a flip, this fires.
    expect(flippedOnes).toEqual([]);
  });

  /**
   * Grouped by COLUMN, because the wall is flat-top (D35): a column is the
   * vertical run and `panelCells` builds along q. The old frame grouped by `r`.
   * The property being checked is unchanged — the block is a full rectangle with
   * no ragged edge — only the axis it is read along.
   */
  it('every column has exactly `rows` cells and columns are contiguous', () => {
    for (const part of panels) {
      const cells = panelCells({ q: 3, r: -2 }, part.panel!.columns, part.panel!.rows);
      const byColumn = new Map<number, number[]>();
      for (const c of cells) {
        const column = byColumn.get(c.q) ?? [];
        column.push(c.r);
        byColumn.set(c.q, column);
      }
      expect(byColumn.size, part.id).toBe(part.panel!.columns);
      for (const [, rs] of byColumn) {
        rs.sort((a, b) => a - b);
        expect(rs).toHaveLength(part.panel!.rows);
        expect(rs[rs.length - 1]! - rs[0]!).toBe(part.panel!.rows - 1);
      }
    }
  });
});
