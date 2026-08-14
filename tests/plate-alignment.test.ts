/**
 * A stock plate's holes must land on the lattice its cells are drawn on.
 *
 * Reported with a screenshot of the alignment dialog: the gold socket rings
 * straddled the plate's walls instead of sitting in its holes. Measured, the
 * offset was **13.6254664 mm — exactly `LATTICE_ANCHOR.x`** — so this is D63's
 * class again, the anchor applied where a DISPLACEMENT was wanted.
 *
 * `hexToMm` is `M·cell + LATTICE_ANCHOR`. Adding two of its results, or adding
 * one to something that already carries the anchor, counts the anchor twice.
 * Both places that re-centre a bounding-box-centred plate mesh did exactly
 * that:
 *
 *   - `WallView3D` translated the stock instance by
 *     `hexToMm(origin) + cellsCentreMm(blockAt00)`;
 *   - `PartInspector` positioned its wall patch by
 *     `-mid - (hexToMm(anchor) - blockCentre)`.
 *
 * It hid for the same reason in both: **every plate is wrong by the same
 * amount**, so the honeycomb stays continuous and looks right. Only something
 * drawn at the TRUE lattice position — a placed part, a socket ring — reveals
 * it, by appearing to sit between holes. The generated and drawn plate paths
 * were never affected, because they build geometry in lattice coordinates and
 * translate by `hexToMm(origin)` alone, which is one anchored quantity used
 * once.
 *
 * The check below is the geometric fact, not the call: a plate placed by the
 * rule must put each of its own cells on the wall cell it represents, to the
 * micron.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import catalogJson from '../src/catalog/catalog.json';
import { LATTICE_ANCHOR } from '../src/core/constants';
import { detect } from '../src/core/detect';
import { cellsBoundsMm, cellsCentreMm, hexToMm, panelCells } from '../src/core/hex';
import { parseStl } from '../src/core/stl';
import { orient } from '../src/ui/meshLibrary';
import type { Catalog, Hex } from '../src/core/types';

const catalog = catalogJson as unknown as Catalog;
const panels = catalog.parts.filter((p) => p.type === 'panel' && p.panel);

/**
 * Where a bounding-box-centred plate mesh must be translated to.
 *
 * The centre of the block AT ITS REAL ORIGIN — one anchored quantity used once
 * as one absolute position, which is what makes double-counting impossible.
 */
const placeAt = (origin: Hex, columns: number, rows: number) =>
  cellsCentreMm(panelCells(origin, columns, rows));

describe('the plate mesh really is centred on its own cells', () => {
  /**
   * The assumption the placement rests on, measured rather than trusted: a
   * plate's margins are equal on opposite sides, so the material's bounding box
   * and the cell block's are the same box. If a plate were ever drawn
   * off-centre in its own file this would catch it, and the rule above would
   * need a per-part correction instead.
   */
  for (const part of panels) {
    it(`${part.id} — material bbox matches its cell block`, () => {
      const buf = readFileSync(resolve(__dirname, '..', part.file));
      const mesh = parseStl(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      );
      const detection = detect(mesh);
      const geometry = orient(mesh, detection);
      // The 90° spin a pointy-drawn plate needs to match its own block, which
      // `loadPartMesh` applies for panels and `orient` deliberately does not.
      if (detection.drawnOrientation === 'pointy') geometry.rotateZ(Math.PI / 2);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;

      const block = cellsBoundsMm(panelCells({ q: 0, r: 0 }, part.panel!.columns, part.panel!.rows));
      expect(box.max.x - box.min.x).toBeCloseTo(block.maxX - block.minX, 3);
      expect(box.max.y - box.min.y).toBeCloseTo(block.maxY - block.minY, 3);
    });
  }
});

describe('a placed stock plate puts its cells on the wall lattice', () => {
  const ORIGINS: Hex[] = [
    { q: 0, r: 0 },
    { q: 1, r: 0 },
    { q: 0, r: 1 },
    { q: 8, r: -3 },
    { q: -5, r: 7 },
  ];

  for (const part of panels) {
    const { columns, rows } = part.panel!;
    it(`${part.id} — every cell, from every origin`, () => {
      // The plate's own cells, and where the mesh holds each of them relative
      // to its centre. `orient` leaves that centre at the mesh origin.
      const own = panelCells({ q: 0, r: 0 }, columns, rows);
      const centre = cellsCentreMm(own);
      const local = own.map((c) => {
        const p = hexToMm(c);
        return { x: p.x - centre.x, y: p.y - centre.y };
      });

      for (const origin of ORIGINS) {
        const at = placeAt(origin, columns, rows);
        const wall = panelCells(origin, columns, rows);
        for (let i = 0; i < wall.length; i++) {
          const want = hexToMm(wall[i]!);
          expect(at.x + local[i]!.x).toBeCloseTo(want.x, 9);
          expect(at.y + local[i]!.y).toBeCloseTo(want.y, 9);
        }
      }
    });
  }

  /**
   * The defect, pinned. Without this the file passes in a world where nothing
   * was ever fixed, because a uniformly shifted honeycomb is self-consistent.
   */
  it('the old rule was out by exactly LATTICE_ANCHOR', () => {
    const { columns, rows } = panels[0]!.panel!;
    const origin: Hex = { q: 0, r: 0 };
    const centre = cellsCentreMm(panelCells({ q: 0, r: 0 }, columns, rows));
    const wasAt = {
      x: hexToMm(origin).x + centre.x,
      y: hexToMm(origin).y + centre.y,
    };
    const shouldBe = placeAt(origin, columns, rows);
    expect(wasAt.x - shouldBe.x).toBeCloseTo(LATTICE_ANCHOR.x, 9);
    expect(wasAt.y - shouldBe.y).toBeCloseTo(LATTICE_ANCHOR.y, 9);
    // 13.6 mm is two thirds of a column, which is why it looked like the rings
    // were sitting on the walls rather than slightly off centre.
    expect(LATTICE_ANCHOR.x).toBeGreaterThan(13);
  });

  /**
   * ...and the guard that generalises it: adding two `hexToMm` results is
   * always wrong, because the anchor comes along twice. A DIFFERENCE of two is
   * always safe. Stated here so the next person reaching for one has the rule.
   */
  it('a difference of two hexToMm results carries no anchor; a sum carries two', () => {
    const a: Hex = { q: 2, r: -1 };
    const b: Hex = { q: 5, r: 3 };
    const shifted: Hex = { q: a.q + b.q, r: a.r + b.r };

    // SAFE: the anchors cancel, leaving the pure lattice displacement — which
    // is `hexToMm` of the difference with the anchor taken back off.
    const delta: Hex = { q: b.q - a.q, r: b.r - a.r };
    expect(hexToMm(b).x - hexToMm(a).x).toBeCloseTo(hexToMm(delta).x - LATTICE_ANCHOR.x, 9);
    expect(hexToMm(b).y - hexToMm(a).y).toBeCloseTo(hexToMm(delta).y - LATTICE_ANCHOR.y, 9);

    // WRONG, and by exactly one anchor: adding two positions where a position
    // plus a displacement was meant. This is the arithmetic both plate sites
    // were doing, and 13.6255 mm is what it cost.
    const sum = { x: hexToMm(a).x + hexToMm(b).x, y: hexToMm(a).y + hexToMm(b).y };
    expect(sum.x - hexToMm(shifted).x).toBeCloseTo(LATTICE_ANCHOR.x, 9);
    expect(sum.y - hexToMm(shifted).y).toBeCloseTo(LATTICE_ANCHOR.y, 9);
  });
});
