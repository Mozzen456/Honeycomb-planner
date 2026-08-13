/**
 * A plate's MESH must match its own CELL BLOCK.
 *
 * The 3D view draws each panel from its STL and positions it by lining the
 * mesh's centre up with the centre of the cells it covers. That only works if
 * the mesh is the same size and the same way round as the block — and for three
 * of the seven shipped panels it was not.
 *
 * `wall-honeycomb-part`, `mk3s` and `bambu-211x248` are drawn POINTY-top, and
 * `toAxial` spins a pointy-drawn part's CELLS onto the flat-top lattice while
 * `meshLibrary.orient` deliberately refuses to spin the mesh. That refusal is
 * right for an accessory — a part is drawn in the orientation it is used, and
 * spinning an SD-card holder points its slots sideways — but a plate has no
 * meaningful up, and leaving it unspun left the mesh 90° from its block:
 * 177 × 170.32 drawn where 170.32 × 177 was needed.
 *
 * It hid on a wall built from ONE pointy panel, because every plate was wrong
 * the same way and the boundaries fell inside a continuous honeycomb. It only
 * showed when a bed mixes a pointy plate with a flat one — the 256 bed picks
 * mk3s and 106x89 together — which is why "Bambu looks wrong, Prusa looks fine".
 *
 * This compares the two directly, in millimetres, for every shipped panel. No
 * renderer and no browser: `bboxMm` is the measured file and the block comes
 * from the lattice.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { MARGIN_X, PITCH, ROW_STEP } from '../src/core/constants';
import type { Catalog } from '../src/core/types';

const catalog = catalogJson as unknown as Catalog;
const panels = catalog.parts.filter((p) => p.type === 'panel' && p.panel);

/** The block's extent in wall millimetres, from HSW-SPEC §4. */
function blockMm(columns: number, rows: number): { w: number; h: number } {
  return {
    w: (columns - 1) * ROW_STEP + 2 * MARGIN_X,
    h: PITCH * (rows + 0.5),
  };
}

describe('every plate mesh matches its cell block', () => {
  it('has seven panels to check', () => {
    expect(panels.length).toBe(7);
  });

  for (const part of panels) {
    it(`${part.id} — ${part.drawnOrientation}-drawn`, () => {
      const block = blockMm(part.panel!.columns, part.panel!.rows);
      const [bx, by] = part.bboxMm;

      /*
       * A pointy-drawn plate's FILE is the block transposed — that is what
       * "drawn pointy on a flat-top wall" means — and the view spins it by 90°
       * to compensate. So the file is checked against the block it will become,
       * which is the transpose for a pointy plate and the block itself for a
       * flat one. Asserting the file matched the block directly would demand
       * the STLs be redrawn.
       */
      const spun = part.drawnOrientation === 'pointy';
      const wantW = spun ? block.h : block.w;
      const wantH = spun ? block.w : block.h;

      expect(bx!, `${part.id} width`).toBeCloseTo(wantW, 1);
      expect(by!, `${part.id} height`).toBeCloseTo(wantH, 1);
    });
  }

  /**
   * The property that actually broke: after the view's spin, EVERY plate ends up
   * the same way round as its block. Stated separately from the per-panel checks
   * because this is the invariant the renderer relies on, and a future panel
   * drawn some third way must fail here rather than pass quietly.
   */
  it('after the view spins the pointy ones, all seven agree with their block', () => {
    const wrong: string[] = [];
    for (const part of panels) {
      const block = blockMm(part.panel!.columns, part.panel!.rows);
      const spun = part.drawnOrientation === 'pointy';
      // What the mesh measures once the view has turned it.
      const w = spun ? part.bboxMm[1]! : part.bboxMm[0]!;
      const h = spun ? part.bboxMm[0]! : part.bboxMm[1]!;
      if (Math.abs(w - block.w) > 0.1 || Math.abs(h - block.h) > 0.1) {
        wrong.push(`${part.id}: ${w.toFixed(2)}x${h.toFixed(2)} vs block ${block.w.toFixed(2)}x${block.h.toFixed(2)}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
