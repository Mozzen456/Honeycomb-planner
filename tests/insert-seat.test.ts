/**
 * An insert goes INTO the wall, and how far is measured, not assumed.
 *
 * Everything else in the app seats a part with its mating face on the wall
 * (`meshLibrary.orient`). An insert is the exception: its body passes through
 * the 22.0 mm mouth into the throat, and its 22.5 mm flange — which cannot
 * follow it — rests on the front face. Drawn by the old convention, an insert
 * stood its whole 10 mm out in the room; positioned at `PANEL_DEPTH − depthMm`,
 * as the wall fixings were, its flange was buried in the plate and 2 mm of body
 * came out of the back.
 *
 * These run `measureInsertSeat` over every shipped insert, through the same
 * `orient` the wall draws with, and hold two things:
 *
 *   1. every one of them reads as an insert at all — a refusal here means the
 *      alignment tool falls back to drawing a stand-in flange, which is the
 *      thing it exists to stop doing;
 *   2. the flange stands `INSERT.flangeThickness` proud. That constant is the
 *      datum `seat: 'insert'` moves a part by (HSW-SPEC §5), and until now
 *      nothing checked it against the models it claims to describe. If someone
 *      re-measures the flange, this is what says whether the family agrees.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { INSERT, PANEL_DEPTH } from '../src/core/constants';
import { detect } from '../src/core/detect';
import { measureInsertSeat } from '../src/core/insertSeat';
import { orient } from '../src/ui/meshLibrary';
import type { Catalog, CatalogPart } from '../src/core/types';
import { loadModel } from './stl.test';

const catalog = catalogJson as unknown as Catalog;
const inserts = catalog.parts.filter((p) => p.type === 'insert' || p.type === 'fastener');

/** The oriented geometry the wall would draw for this part. */
function orientedPositions(part: CatalogPart): Float32Array {
  const mesh = loadModel(part.file);
  return orient(mesh, detect(mesh)).getAttribute('position').array as Float32Array;
}

/** Its extent along the wall normal — everything the seat has to account for. */
function depthOf(positions: Float32Array): number {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 2; i < positions.length; i += 3) {
    if (positions[i]! < min) min = positions[i]!;
    if (positions[i]! > max) max = positions[i]!;
  }
  return max - min;
}

describe('measureInsertSeat — over the shipped insert family', () => {
  it('has the whole family to check', () => {
    expect(inserts.length).toBe(15);
  });

  for (const part of inserts) {
    it(`${part.id} seats with its flange proud`, () => {
      const positions = orientedPositions(part);
      const seat = measureInsertSeat(positions);
      expect(seat, 'reads as an insert').not.toBeNull();
      // Measured, and it agrees with the constant to within a printer's
      // tolerance. Not asserted as exactly equal: the flange's outer rim is
      // chamfered on some of these, and the number that matters is where the
      // UNDERSIDE lands.
      expect(seat!.proudMm).toBeCloseTo(INSERT.flangeThickness, 1);
      // The body is what enters the wall, and it has to fit: 8 mm of plate,
      // through a 2.0 mouth and a 4.6 throat with a 0.9 lead-in.
      expect(seat!.bodyMm).toBeGreaterThan(4);
      expect(seat!.bodyMm).toBeLessThanOrEqual(PANEL_DEPTH);
      // Body plus flange is the whole part: nothing is unaccounted for.
      expect(seat!.bodyMm + seat!.proudMm).toBeCloseTo(depthOf(positions), 2);
    }, 30000);
  }
});

describe('measureInsertSeat — refusing', () => {
  it('says nothing about a part that does not seat like an insert', () => {
    // A box has no flange and no plug; a number here would draw it sunk into
    // the wall with nothing to say why.
    const box = catalog.parts.find((p) => p.id === 'box');
    expect(box, 'a box to test with').toBeDefined();
    expect(measureInsertSeat(orientedPositions(box!))).toBeNull();
  }, 30000);

  it('refuses an empty or degenerate mesh rather than dividing by nothing', () => {
    expect(measureInsertSeat(new Float32Array([]))).toBeNull();
    expect(measureInsertSeat(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))).toBeNull();
  });
});
