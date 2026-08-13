/**
 * The hand-picked mounting face.
 *
 * 27 of the 51 shipped parts carry `drawnOrientation: "n/a"` because the
 * detector declines to guess which face goes against the wall (PARKED P1). This
 * is the channel for answering that by hand, and the property that matters is
 * that the answer is a CONSTRAINT on the detection rather than a value stapled
 * onto its result — otherwise a part's cells get measured off one face while its
 * mesh is hung off another, which is the exact class of bug the footprint and
 * mesh were unified to prevent.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { detect } from '../src/core/detect';
import { applyOverrides, mountingOf, readMounting } from '../src/core/overrides';
import {
  clearMounting, mergeOverrideFiles, setMounting, toOverrideFile, type UserOverrides,
} from '../src/core/userOverrides';
import type { Catalog } from '../src/core/types';
import { loadModel } from './stl.test';

const catalog = catalogJson as unknown as Catalog;
const none = (): UserOverrides => ({ parts: {} });

describe('reading a mounting correction', () => {
  it('accepts a complete one', () => {
    expect(readMounting({ wallFaceAxis: 'x', matingEnd: 'high' }))
      .toEqual({ wallFaceAxis: 'x', matingEnd: 'high' });
  });

  it('normalises the spin, so 13 steps and 1 step mean the same thing', () => {
    expect(readMounting({ wallFaceAxis: 'z', matingEnd: 'low', spinSteps: 13 })?.spinSteps).toBe(1);
    expect(readMounting({ wallFaceAxis: 'z', matingEnd: 'low', spinSteps: -1 })?.spinSteps).toBe(11);
  });

  /**
   * Depth is the fourth degree of freedom and the only one that is not an
   * orientation: `orient` seats every part with its mating face at z = 0, which
   * is wrong whenever the detector settled for the flattest surface rather than
   * the real one, and the part then floats off the wall or sinks into it.
   */
  it('keeps a depth offset, to a tenth of a millimetre', () => {
    expect(readMounting({ wallFaceAxis: 'z', matingEnd: 'low', offsetMm: 2.5 })?.offsetMm).toBe(2.5);
    expect(readMounting({ wallFaceAxis: 'z', matingEnd: 'low', offsetMm: -3.25 })?.offsetMm)
      .toBe(-3.3);
  });

  /**
   * Clamped rather than accepted. Past 40 mm it is not a seating correction, it
   * is a part in the wrong place, and taking 400 silently would hide that.
   */
  it('clamps an absurd depth instead of accepting it', () => {
    expect(readMounting({ wallFaceAxis: 'z', matingEnd: 'low', offsetMm: 400 })?.offsetMm).toBe(40);
    expect(readMounting({ wallFaceAxis: 'z', matingEnd: 'low', offsetMm: -400 })?.offsetMm)
      .toBe(-40);
  });

  it('leaves depth unset when it is not a number', () => {
    expect(readMounting({ wallFaceAxis: 'z', matingEnd: 'low', offsetMm: 'deep' })?.offsetMm)
      .toBeUndefined();
    expect(readMounting({ wallFaceAxis: 'z', matingEnd: 'low', offsetMm: NaN })?.offsetMm)
      .toBeUndefined();
  });

  /** Half-applying one would orient a part off a face nobody chose. */
  it('discards a half-written one rather than guessing the rest', () => {
    expect(readMounting({ wallFaceAxis: 'x' })).toBeUndefined();
    expect(readMounting({ matingEnd: 'low' })).toBeUndefined();
    expect(readMounting({ wallFaceAxis: 'w', matingEnd: 'low' })).toBeUndefined();
    expect(readMounting(null)).toBeUndefined();
  });
});

describe('forcing the wall face through detect', () => {
  const part = catalog.parts.find((p) => p.id === 'shelf-1')!;

  it('honours the axis it is given, over the one it would have picked', () => {
    const mesh = loadModel(part.file);
    const free = detect(mesh);
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(detect(mesh, { forceAxis: axis }).wallFaceAxis).toBe(axis);
    }
    // And the free run is still whatever it was — forcing is not sticky.
    expect(detect(mesh).wallFaceAxis).toBe(free.wallFaceAxis);
  });

  it('honours the mating end it is given', () => {
    const mesh = loadModel(part.file);
    expect(detect(mesh, { forceEnd: 'low' }).matingEnd).toBe('low');
    expect(detect(mesh, { forceEnd: 'high' }).matingEnd).toBe('high');
  });

  it('says in the notes that a person chose, not the detector', () => {
    const d = detect(loadModel(part.file), { forceAxis: 'y', forceEnd: 'high' });
    expect(d.notes.join(' ')).toMatch(/by hand/);
  });

  /**
   * The whole point of forcing the axis rather than overwriting the result: the
   * projection is measured along whichever face was chosen, so it has to move
   * when the face moves.
   */
  it('re-derives the projection from the forced face', () => {
    const mesh = loadModel(part.file);
    const depths = (['x', 'y', 'z'] as const).map((a) => detect(mesh, { forceAxis: a }).projectionMm);
    expect(new Set(depths).size).toBeGreaterThan(1);
  });
});

describe('applying a mounting correction to the catalogue', () => {
  it('lands on the part, where meshLibrary and the inspector both read it', () => {
    const file = { parts: { 'shelf-1': { mounting: { wallFaceAxis: 'x', matingEnd: 'high' } } } };
    const applied = applyOverrides(catalog, file);
    const part = applied.parts.find((p) => p.id === 'shelf-1')!;
    expect(mountingOf(part)).toEqual({ wallFaceAxis: 'x', matingEnd: 'high' });
  });

  it('leaves every other part alone', () => {
    const file = { parts: { 'shelf-1': { mounting: { wallFaceAxis: 'x', matingEnd: 'high' } } } };
    const applied = applyOverrides(catalog, file);
    const others = applied.parts.filter((p) => p.id !== 'shelf-1');
    expect(others.every((p) => mountingOf(p) === undefined)).toBe(true);
  });
});

describe('local corrections and the file they become', () => {
  it('round-trips a correction', () => {
    const set = setMounting(none(), 'shelf-1', { wallFaceAxis: 'y', matingEnd: 'low', spinSteps: 1 });
    expect(set.parts['shelf-1']?.mounting?.wallFaceAxis).toBe('y');
    expect(clearMounting(set, 'shelf-1').parts['shelf-1']).toBeUndefined();
  });

  /**
   * A local mounting decision and a shipped fastener count are different facts
   * about the same part, decided by different people. Merging per FILE would
   * throw one of them away.
   */
  it('merges per part, so a local mounting keeps the shipped fastener count', () => {
    const shipped = { parts: { 'shelf-1': { fastenersNeedReview: true, _note: 'counted by hand' } } };
    const user = setMounting(none(), 'shelf-1', { wallFaceAxis: 'y', matingEnd: 'low' });
    const merged = mergeOverrideFiles(shipped, user);
    expect(merged.parts?.['shelf-1']?.fastenersNeedReview).toBe(true);
    expect(merged.parts?.['shelf-1']?.mounting?.wallFaceAxis).toBe('y');
  });

  it('keeps shipped corrections for parts nobody touched locally', () => {
    const shipped = { parts: { box: { fastenersNeedReview: true } } };
    const merged = mergeOverrideFiles(shipped, setMounting(none(), 'shelf-1', {
      wallFaceAxis: 'y', matingEnd: 'low',
    }));
    expect(merged.parts?.['box']?.fastenersNeedReview).toBe(true);
  });

  it('exports only what was corrected here, so the diff stays readable', () => {
    const user = setMounting(none(), 'shelf-1', { wallFaceAxis: 'y', matingEnd: 'low' });
    const text = toOverrideFile(user);
    expect(JSON.parse(text)).toEqual({
      parts: { 'shelf-1': { mounting: { wallFaceAxis: 'y', matingEnd: 'low' } } },
    });
  });

  /** What is exported must be what `applyOverrides` reads back. */
  it('exports in the shape the app and the scanner already consume', () => {
    const user = setMounting(none(), 'shelf-1', {
      wallFaceAxis: 'x', matingEnd: 'high', spinSteps: 2, offsetMm: 1.5,
    });
    const applied = applyOverrides(catalog, JSON.parse(toOverrideFile(user)));
    expect(mountingOf(applied.parts.find((p) => p.id === 'shelf-1')!))
      .toEqual({ wallFaceAxis: 'x', matingEnd: 'high', spinSteps: 2, offsetMm: 1.5 });
  });
});
