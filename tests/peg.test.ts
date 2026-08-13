/**
 * The peg detector, against the one thing independently measured.
 *
 * `detect.ts` cannot say which face of an insert-fed part goes against the wall
 * — it has no wall interface on any axis, so `insertFed` falls back to "most
 * material under the surface", which for a shelf picks the tray. DECISIONS D31
 * settled the shelves' real answer from the meshes by hand: the tray floor is
 * perpendicular to Z and **the hexagonal peg runs along Y**. That is the fact
 * this module has to reproduce without being told.
 *
 * The assertions are deliberately about the AXIS and the confidence, because
 * those are what the detector claims. It reports no width — see the note in
 * `peg.ts` for why a width would be a confident wrong number here.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { detectPeg } from '../src/core/peg';
import type { Catalog } from '../src/core/types';
import { loadModel } from './stl.test';

const catalog = catalogJson as unknown as Catalog;
const meshOf = (id: string) => {
  const part = catalog.parts.find((p) => p.id === id);
  if (!part) throw new Error(`no such part: ${id}`);
  return loadModel(part.file);
};

describe('detectPeg', () => {
  /**
   * The headline. All four shelves and both `hook-to-empty` variants mount on a
   * peg along Y, measured by hand in D31 — and `detect.ts` says Z for every one
   * of them. Reproducing D31 from geometry alone is the whole point.
   */
  it('finds the Y peg on the parts D31 measured by hand', () => {
    for (const id of ['shelf-1', 'shelf-2', 'shelf-3', 'shelf-4',
      'hook-to-empty', 'hook-to-empty-long']) {
      const peg = detectPeg(meshOf(id));
      expect(peg, id).not.toBeNull();
      expect(peg!.axis, `${id} peg axis`).toBe('y');
    }
  }, 120000);

  it('is confident about them, not merely right', () => {
    for (const id of ['shelf-1', 'shelf-4', 'hook-to-empty']) {
      expect(detectPeg(meshOf(id))!.confidence, id).toBeGreaterThan(0.9);
    }
  }, 120000);

  /**
   * A panel's cells ARE hexagonal prisms along Z, so the detector should say so.
   * Not a useful mounting answer for a panel — it is the plate, it does not
   * mount on a peg — but it is a check that the thing finds the obvious case.
   */
  it('finds the Z prisms of a panel', () => {
    const peg = detectPeg(meshOf('wall-honeycomb-part'));
    expect(peg).not.toBeNull();
    expect(peg!.axis).toBe('z');
    expect(peg!.confidence).toBeGreaterThan(0.9);
  }, 120000);

  it('answers for every shipped part, with a confidence to judge it by', () => {
    const weak: string[] = [];
    for (const part of catalog.parts) {
      const peg = detectPeg(loadModel(part.file));
      expect(peg, part.id).not.toBeNull();
      expect(peg!.confidence).toBeGreaterThan(0);
      expect(peg!.confidence).toBeLessThanOrEqual(1);
      if (peg!.confidence < 0.8) weak.push(`${part.id} ${peg!.confidence.toFixed(2)}`);
    }
    // Pinned so a change in the model set, or in the scoring, is visible rather
    // than silent. These are the ones a person should look at first.
    expect(weak.sort()).toEqual([
      'hook-12mm-for-m3 0.62',
      'hook-25mm-for-m3 0.62',
    ]);
  }, 300000);
});
