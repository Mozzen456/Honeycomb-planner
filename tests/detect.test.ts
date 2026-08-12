/**
 * The browser detector, checked cell-for-cell against the Python one.
 *
 * `tools/footprint.py` reaches its answer with trimesh cross-sections and
 * shapely booleans; `src/core/detect.ts` reaches it with a raster, because a
 * browser has neither library. This file is the guarantee that the two agree —
 * on all 51 shipped models, including the six chiral panels where a mirrored
 * answer would be silently wrong, and the 4-cell diamond inserts whose filenames
 * do not describe their shape.
 *
 * If this drifts, an imported part stops meaning the same thing as a scanned
 * one, and the catalogue quietly becomes two catalogues.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { detect, envelopeBlock, toAxial, ENV_CORNERS, ENV_FLATS } from '../src/core/detect';
import { PITCH, ROW_STEP } from '../src/core/constants';
import type { Catalog, Hex } from '../src/core/types';
import { loadModel } from './stl.test';

const catalog = catalogJson as unknown as Catalog;
const key = (cells: readonly Hex[]) =>
  cells.map((c) => `${c.q},${c.r}`).sort().join(' ');

describe('detect — against the shipped catalogue', () => {
  it('reproduces the measured footprint of all 51 parts, cell for cell', () => {
    const wrong: string[] = [];
    for (const part of catalog.parts) {
      const d = detect(loadModel(part.file));
      if (key(d.cells) !== key(part.footprint)) {
        wrong.push(`${part.id}: want [${key(part.footprint)}] got [${key(d.cells)}]`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120000);

  it('puts every part in the tier the scanner put it in', () => {
    const wrong: string[] = [];
    for (const part of catalog.parts) {
      const d = detect(loadModel(part.file));
      const want = (part as unknown as { measurement: { tier: string } }).measurement.tier;
      if (d.tier !== want) wrong.push(`${part.id}: want ${want} got ${d.tier}`);
    }
    expect(wrong).toEqual([]);
  }, 120000);

  it('recovers columns × rows for every shipped panel', () => {
    for (const part of catalog.parts) {
      if (part.type !== 'panel' || !part.panel) continue;
      const d = detect(loadModel(part.file));
      expect(d.panel, part.id).toBeDefined();
      expect(d.panel!.columns, `${part.id} columns`).toBe(part.panel.columns);
      expect(d.panel!.rows, `${part.id} rows`).toBe(part.panel.rows);
    }
  }, 120000);

  it('flags exactly the parts the scanner flagged for review', () => {
    for (const part of catalog.parts) {
      const d = detect(loadModel(part.file));
      const flagged = (part as unknown as { needsReview?: boolean }).needsReview === true;
      expect(d.needsReview, part.id).toBe(flagged);
    }
  }, 120000);

  /**
   * The two tiers whose confidence differs by design: a wall-clipping part is
   * measured, an insert-fed one is bounded. A detector that reported the same
   * confidence for both would be lying about the second.
   */
  it('never claims high confidence for an insert-fed part', () => {
    for (const part of catalog.parts) {
      const d = detect(loadModel(part.file));
      if (d.tier === 'insert-fed') {
        expect(d.confidence, part.id).toBeLessThan(0.5);
        expect(d.needsReview, part.id).toBe(true);
      }
    }
  }, 120000);
});

describe('envelopeBlock — the wall-interface gate', () => {
  it('accepts one cell drawn either way', () => {
    expect(envelopeBlock(ENV_CORNERS, ENV_FLATS)).toEqual({ drawn: 'flat', a: 0, b: 0 });
    expect(envelopeBlock(ENV_FLATS, ENV_CORNERS)).toEqual({ drawn: 'pointy', a: 0, b: 0 });
  });

  it('accepts a two-cell block, counting the half-pitch stagger', () => {
    expect(envelopeBlock(ENV_CORNERS + ROW_STEP, ENV_FLATS + PITCH / 2)).toEqual({
      drawn: 'flat', a: 1, b: 1,
    });
  });

  it('rejects a plain rectangle that a hexagon grid would happily cover', () => {
    // The failure mode this gate exists for: ~70% of a rectangle is coverable
    // by hexagons, so area scoring calls a storage box a 3-cell wall part.
    expect(envelopeBlock(46.2, 55.0)).toBeNull();
    expect(envelopeBlock(100, 60)).toBeNull();
  });

  it('rejects anything smaller than a single cell', () => {
    expect(envelopeBlock(20, 20)).toBeNull();
  });

  /** The tolerance is 0.03 of a lattice STEP, not 0.03 mm — 0.6 mm along the
   *  row axis. Real parts land inside 0.03 mm of exact; a shelf misses by
   *  millimetres, so the window has room to spare either way. */
  it('tolerates a fraction of a lattice step and no more', () => {
    expect(envelopeBlock(ENV_CORNERS + 0.2, ENV_FLATS)).not.toBeNull();
    expect(envelopeBlock(ENV_CORNERS + 0.8, ENV_FLATS)).toBeNull();
  });
});

describe('toAxial', () => {
  it('maps a pointy-drawn row onto consecutive q', () => {
    const cells = toAxial([{ u: 0, v: 0 }, { u: PITCH, v: 0 }, { u: 2 * PITCH, v: 0 }], 'pointy');
    expect(cells).toEqual([{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }]);
  });

  it('spins a flat-drawn part 90° so it sits on a pointy-top wall', () => {
    // Drawn flat, the lattice step along +v is one row; on the wall that has to
    // become a step along the pointy-top row axis, or the part lands rotated.
    const cells = toAxial([{ u: 0, v: 0 }, { u: 0, v: PITCH }], 'flat');
    expect(cells).toEqual([{ q: 0, r: 0 }, { q: 1, r: 0 }]);
  });

  it('refuses points that are not on one lattice, rather than rounding them on', () => {
    expect(toAxial([{ u: 0, v: 0 }, { u: PITCH * 0.6, v: 0 }], 'pointy')).toBeNull();
  });

  it('is empty-safe', () => {
    expect(toAxial([], 'pointy')).toBeNull();
  });
});
