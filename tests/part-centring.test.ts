/**
 * A part's mesh must land on the cells it claims.
 *
 * Reported as "the space on the wall does not match the 3D viewer": in the
 * alignment dialog the honeycomb outline sat beside the part rather than under
 * it. The dialog was not the culprit — it was faithfully copying the wall, and
 * the wall had the same error, so the two agreed with each other and both
 * disagreed with the geometry.
 *
 * `meshLibrary.orient` centres a part on its own wall-plane BOUNDING BOX. Four
 * separate places then positioned that mesh at the MEAN of the cells it covers:
 * the placed item in `WallView3D`, the fastener under it, the hover outline,
 * and the inspector's plate. Mean and box centre are the same point for a
 * symmetric footprint — which is most of the catalogue, which is why this
 * survived — and differ for anything else.
 *
 * That is the failure mode this repo keeps meeting: one rule, several copies,
 * and a test suite that never looks at the two together. So the check here is
 * not "does the code call the right function" but the geometric fact itself —
 * the oriented mesh, placed the way a view places it, must sit over its own
 * cells. It is run over every shipped part, so the next asymmetric footprint
 * added to the catalogue is covered without anyone remembering to.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import catalogJson from '../src/catalog/catalog.json';
import { detect } from '../src/core/detect';
import { cellsBoundsMm, cellsCentreMm, hexToMm } from '../src/core/hex';
import { parseStl } from '../src/core/stl';
import { orient } from '../src/ui/meshLibrary';
import type { Catalog, CatalogPart, Hex } from '../src/core/types';

const catalog = catalogJson as unknown as Catalog;

const meshOf = (part: CatalogPart) => {
  const buf = readFileSync(resolve(__dirname, '..', part.file));
  return parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
};

/** What the four views used to do. Kept so the difference can be stated. */
function meanCentre(cells: readonly Hex[]): { x: number; y: number } {
  const out = { x: 0, y: 0 };
  for (const c of cells) {
    const p = hexToMm(c);
    out.x += p.x / cells.length;
    out.y += p.y / cells.length;
  }
  return out;
}

describe('cellsCentreMm', () => {
  it('is the box centre, not the mean, and they differ on an L', () => {
    // `insert-hollow-tre`'s own footprint: two cells in one column, one in the
    // next. The mean is dragged toward the column with two cells in it.
    const L: Hex[] = [{ q: 0, r: 0 }, { q: 0, r: 1 }, { q: 1, r: 0 }];
    const box = cellsCentreMm(L);
    const mean = meanCentre(L);
    expect(box.x - mean.x).toBeCloseTo(3.406, 3);
    expect(box.y).toBeCloseTo(mean.y, 9);
  });

  it('agrees with the mean whenever the footprint is symmetric', () => {
    // Which is why the defect survived: most of the catalogue is symmetric.
    for (const cells of [
      [{ q: 0, r: 0 }],
      [{ q: 0, r: 0 }, { q: 1, r: 0 }],
      [{ q: 0, r: 0 }, { q: 0, r: 1 }, { q: 1, r: -1 }, { q: 1, r: 0 }],
    ] as Hex[][]) {
      const box = cellsCentreMm(cells);
      const mean = meanCentre(cells);
      expect(box.x).toBeCloseTo(mean.x, 9);
      expect(box.y).toBeCloseTo(mean.y, 9);
    }
  });

  it('is unmoved by adding a cell already inside the span', () => {
    // A box centre depends on the extremes alone. A mean does not, and that is
    // exactly the property that made it wrong here.
    const span: Hex[] = [{ q: 0, r: 0 }, { q: 2, r: 0 }];
    const filled: Hex[] = [...span, { q: 1, r: 0 }, { q: 1, r: 0 }];
    expect(cellsCentreMm(filled)).toEqual(cellsCentreMm(span));
  });

  it('answers the origin for no cells rather than NaN', () => {
    expect(cellsCentreMm([])).toEqual({ x: 0, y: 0 });
  });
});

/**
 * The geometric contract, measured on the shipped models.
 *
 * A WALL-CLIP part's silhouette IS its cells — it is a plug that goes into
 * them — so once a view has placed its mesh, the mesh's bounding box and the
 * cells' bounding box must be concentric. Measured across all 17 of them the
 * gap is 0.63 mm in x and 0.55 mm in y, the same on both edges and the same for
 * every part, which is the plate margin and not an alignment error.
 *
 * INSERT-FED parts are excluded, and that is not a dodge: their footprint is a
 * BOUND from the bounding box rather than a measurement (PARKED P1), and their
 * geometry legitimately overhangs it — `shelf-4`'s tray reaches 80 mm past the
 * cells it hangs on. There is no contract to state for them.
 */
function placedGaps(part: CatalogPart): { x: [number, number]; y: [number, number] } {
  const detection = detect(meshOf(part));
  const geometry = orient(meshOf(part), detection);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  // `orient` leaves the mesh centred on (0,0) in the wall plane; a view places
  // it at `cellsCentreMm`. This is where its edges then fall, against the cells'.
  const at = cellsCentreMm(part.footprint);
  const cells = cellsBoundsMm(part.footprint);
  return {
    x: [at.x + box.min.x - cells.minX, at.x + box.max.x - cells.maxX],
    y: [at.y + box.min.y - cells.minY, at.y + box.max.y - cells.maxY],
  };
}

describe('a wall-clip part sits centred in the cells it claims', () => {
  const clips = catalog.parts.filter(
    (p) => p.type !== 'panel' && p.footprint.length > 0 && detect(meshOf(p)).tier === 'wall-clip',
  );

  it('there are enough of them for this to mean something', () => {
    expect(clips.length).toBeGreaterThanOrEqual(17);
    // ...including the L-shaped one, which is the only shipped footprint where
    // the box centre and the mean disagree. Without it this file proves nothing.
    expect(clips.map((p) => p.id)).toContain('insert-hollow-tre');
  });

  for (const part of clips) {
    it(`${part.id} — equal gap on opposite edges`, () => {
      const { x, y } = placedGaps(part);
      // Centred means the two gaps are mirror images. A mis-centring keeps
      // their SUM (the mesh is no wider) and destroys their symmetry, which is
      // why this is asserted rather than the gap size alone.
      expect(x[0] + x[1]).toBeCloseTo(0, 6);
      expect(y[0] + y[1]).toBeCloseTo(0, 6);
      // ...and the part really does fill its cells, to within the plate margin.
      expect(Math.abs(x[0])).toBeLessThan(1);
      expect(Math.abs(y[0])).toBeLessThan(1);
    });
  }

  /**
   * The defect, stated. Without this the file is green in a world where the bug
   * was never fixed, because every symmetric part passes either way.
   */
  it('would have failed under the mean-based centring it replaced', () => {
    const part = catalog.parts.find((p) => p.id === 'insert-hollow-tre')!;
    const geometry = orient(meshOf(part), detect(meshOf(part)));
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const cells = cellsBoundsMm(part.footprint);
    const at = meanCentre(part.footprint); // what the four views used to do
    const lo = at.x + box.min.x - cells.minX;
    const hi = at.x + box.max.x - cells.maxX;
    // Off-centre by the full 3.406 mm, so the gaps no longer cancel.
    expect(lo + hi).toBeCloseTo(-6.81, 2);
    expect(Math.abs(lo)).toBeGreaterThan(1);
  });
});
