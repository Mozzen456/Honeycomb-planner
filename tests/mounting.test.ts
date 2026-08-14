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
import overridesJson from '../src/catalog/overrides.json';
import { detect } from '../src/core/detect';
import { hexKey } from '../src/core/hex';
import {
  anchorOf, applyOverrides, mountingOf, readFootprint, readMounting, socketsOf,
} from '../src/core/overrides';
import { partCells } from '../src/core/store';
import {
  clearMounting, mergeOverrideFiles, readUserOverrides, setFootprint, setMounting,
  setRequires, toOverrideFile, toSetupFile, type UserOverrides,
} from '../src/core/userOverrides';
import type { Catalog } from '../src/core/types';
import { loadModel } from './stl.test';

const catalog = catalogJson as unknown as Catalog;
const none = (): UserOverrides => ({ parts: {} });
/** What comes back out of storage — the same JSON round trip the browser does. */
const loadFrom = (json: string): UserOverrides => readUserOverrides(JSON.parse(json));

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

  /*
   * The other four. Naming a face fixes two degrees of freedom and the spin and
   * the depth fix one and a half more; a part drawn a few degrees off, or whose
   * peg is not centred in its own bounding box, needs the rest — so a correction
   * is a full rigid transform, and every one of its numbers reads back the same
   * way as the depth already did.
   */
  it('keeps the other four, to a tenth, rounded away from zero', () => {
    const m = readMounting({
      wallFaceAxis: 'z', matingEnd: 'low',
      offsetXMm: 3.25, offsetYMm: -3.25, tiltXDeg: 7.5, tiltYDeg: -0.44, spinDeg: 4,
    });
    expect(m).toEqual({
      wallFaceAxis: 'z', matingEnd: 'low',
      offsetXMm: 3.3, offsetYMm: -3.3, tiltXDeg: 7.5, tiltYDeg: -0.4, spinDeg: 4,
    });
  });

  it('clamps a slide like a depth and a tilt to a half turn', () => {
    const m = readMounting({
      wallFaceAxis: 'z', matingEnd: 'low',
      offsetXMm: 400, offsetYMm: -400, tiltXDeg: 900, tiltYDeg: -900,
    });
    expect(m?.offsetXMm).toBe(40);
    expect(m?.offsetYMm).toBe(-40);
    expect(m?.tiltXDeg).toBe(180);
    expect(m?.tiltYDeg).toBe(-180);
  });

  /**
   * A correction written before a part could be slid sideways carries four
   * fewer fields, and it must read back as ITSELF — absent, not zeroed. An
   * absent field and a zero mean the same thing to every consumer, and writing
   * the zeroes in would put six of them per part into `overrides.json`.
   */
  it('leaves the new fields absent rather than zeroing them', () => {
    expect(readMounting({ wallFaceAxis: 'y', matingEnd: 'high', spinSteps: 2, offsetMm: 1.5 }))
      .toEqual({ wallFaceAxis: 'y', matingEnd: 'high', spinSteps: 2, offsetMm: 1.5 });
  });

  /** `−0` compares equal to 0 and fails `Object.is`, which is what a dirty check uses. */
  it('never reads back a negative zero', () => {
    const m = readMounting({ wallFaceAxis: 'z', matingEnd: 'low', offsetXMm: -0.01, tiltXDeg: -0 });
    expect(Object.is(m?.offsetXMm, 0)).toBe(true);
    expect(Object.is(m?.tiltXDeg, 0)).toBe(true);
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

/**
 * The cells a person draws.
 *
 * `detect()` gives every part a footprint, but for one with no wall interface it
 * is the bounding box laid over the lattice — the bound PARKED P1 describes. Two
 * rules make replacing it safe: the anchor is always a member (or `partCells`
 * has no cell to drag by), and only an actual EDIT clears `needsReview`.
 */
describe('reading a hand-drawn footprint', () => {
  const keys = (cells: readonly { q: number; r: number }[] | undefined): string[] =>
    (cells ?? []).map(hexKey).sort();

  /**
   * The middle cell is NOT forced in.
   *
   * It was, on the reasoning that the drag hangs off the origin — true of the
   * ANCHOR, not of the origin. A two-peg shelf uses the cells above and below
   * its middle and nothing in between, and pinning the middle gave it a third
   * cell it does not have, which then fouls a neighbour that is not there.
   */
  it('keeps exactly the cells it is given', () => {
    expect(keys(readFootprint([{ q: 1, r: 0 }]))).toEqual(['1,0']);
    expect(keys(readFootprint([{ q: 0, r: -1 }, { q: 0, r: 1 }]))).toEqual(['0,-1', '0,1']);
  });

  /** ...with a floor of one: a part covering nothing cannot be checked. */
  it('falls back to a single cell when nothing legible is left', () => {
    expect(keys(readFootprint([]))).toEqual(['0,0']);
    expect(keys(readFootprint([{ q: 'a', r: 0 }]))).toEqual(['0,0']);
  });

  it('deduplicates, so a repeat cannot inflate a cell count', () => {
    expect(keys(readFootprint([{ q: 1, r: 0 }, { q: 1, r: 0 }, { q: 0, r: 0 }])))
      .toEqual(['0,0', '1,0']);
  });

  it('drops entries that are not cells', () => {
    expect(keys(readFootprint([{ q: 'a', r: 0 }, null, { q: 2, r: NaN }, { q: 1, r: 1 }])))
      .toEqual(['1,1']);
    expect(readFootprint('everywhere')).toBeUndefined();
  });

  it('refuses a cell on the other side of the wall', () => {
    expect(keys(readFootprint([{ q: 900, r: 0 }, { q: 1, r: 0 }]))).toEqual(['1,0']);
  });
});

/**
 * The cell that lands under the cursor while dragging.
 *
 * Nearest the origin, deterministically — an anchor that wandered between
 * renders would drop the part somewhere else each time — and for the usual
 * footprint, which does contain the origin, it IS the origin.
 */
describe('the anchor of a footprint', () => {
  it('is the origin whenever the part covers it', () => {
    expect(anchorOf([{ q: 2, r: -1 }, { q: 0, r: 0 }, { q: 1, r: 0 }])).toEqual({ q: 0, r: 0 });
  });

  it('is the nearest cell when the part does not cover its middle', () => {
    expect(anchorOf([{ q: 0, r: -1 }, { q: 0, r: 2 }])).toEqual({ q: 0, r: -1 });
  });

  it('breaks ties the same way every time', () => {
    const ring = [{ q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 }, { q: -1, r: 0 }];
    expect(anchorOf(ring)).toEqual(anchorOf([...ring].reverse()));
  });

  it('answers for an empty list rather than throwing', () => {
    expect(anchorOf([])).toEqual({ q: 0, r: 0 });
  });
});

describe('applying a hand-drawn footprint to the catalogue', () => {
  const id = 'shelf-1';
  const cells = [{ q: 0, r: 0 }, { q: 1, r: 0 }];

  it('replaces the cells and re-anchors on the origin', () => {
    const applied = applyOverrides(catalog, { parts: { [id]: { footprint: cells } } });
    const part = applied.parts.find((p) => p.id === id)!;
    expect(part.footprint).toEqual(cells);
    expect(part.anchor).toEqual({ q: 0, r: 0 });
  });

  /**
   * The rule `withFootprint` already keeps for an imported part: drawing the
   * cells is a measurement by hand, so the bound is gone. Anything else would
   * leave the parts list saying "this is a guess" about a decision.
   */
  it('clears needsReview, because drawing the cells IS the review', () => {
    const flagged = catalog.parts.find(
      (p) => (p as unknown as { needsReview?: boolean }).needsReview === true,
    )!;
    const applied = applyOverrides(catalog, {
      parts: { [flagged.id]: { footprint: [{ q: 0, r: 0 }, { q: 3, r: -1 }] } },
    });
    const part = applied.parts.find((p) => p.id === flagged.id)!;
    expect((part as unknown as { needsReview?: boolean }).needsReview).toBe(false);
    expect(part.provenance.notes.join(' ')).toMatch(/footprint set by hand to 2 cell/);
  });

  /** Re-stating the same cells is not an edit, and must not promote the bound. */
  it('leaves needsReview alone when the cells come back unchanged', () => {
    const flagged = catalog.parts.find(
      (p) => (p as unknown as { needsReview?: boolean }).needsReview === true,
    )!;
    const applied = applyOverrides(catalog, {
      parts: { [flagged.id]: { footprint: [...flagged.footprint].reverse() } },
    });
    const part = applied.parts.find((p) => p.id === flagged.id)!;
    expect((part as unknown as { needsReview?: boolean }).needsReview).toBe(true);
    expect(part.provenance.notes.join(' ')).not.toMatch(/set by hand/);
  });

  /**
   * Cells are how much wall a part covers; pegs are what holds it up. Deriving
   * one from the other is what had a 7-cell shelf with two pegs ordering seven
   * inserts (HSW-SPEC §5).
   */
  it('does not touch what the part requires', () => {
    const before = catalog.parts.find((p) => p.id === id)!;
    const applied = applyOverrides(catalog, {
      parts: { [id]: { footprint: [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }] } },
    });
    expect(applied.parts.find((p) => p.id === id)!.requires).toEqual(before.requires);
  });

  /**
   * A part that does not cover its own middle still hangs off one of its own
   * cells: `anchorOf` picks the drag cell, and `partCells` puts THAT under the
   * cursor. Dropping at (4, 2) therefore covers (4, 2) and (4, 4) — not the
   * cell between them, which is the whole point.
   */
  it('places a footprint with no middle cell off its own anchor', () => {
    const applied = applyOverrides(catalog, {
      parts: { [id]: { footprint: [{ q: 0, r: 0 }, { q: 0, r: 2 }] } },
    });
    const part = applied.parts.find((p) => p.id === id)!;
    expect(part.anchor).toEqual({ q: 0, r: 0 });
    expect(partCells(part, { q: 4, r: 2 }, 0).map(hexKey).sort())
      .toEqual(['4,2', '4,4'].sort());

    const offset = applyOverrides(catalog, {
      parts: { [id]: { footprint: [{ q: 0, r: -1 }, { q: 0, r: 1 }] } },
    });
    const shifted = offset.parts.find((p) => p.id === id)!;
    expect(shifted.anchor).toEqual({ q: 0, r: -1 });
    // The anchor lands on the cursor cell; the other cell is two rows up.
    expect(partCells(shifted, { q: 4, r: 2 }, 0).map(hexKey).sort())
      .toEqual(['4,2', '4,4'].sort());
  });

  /** What the editor draws is what a drop covers. */
  it('is the footprint the store then places', () => {
    const applied = applyOverrides(catalog, { parts: { [id]: { footprint: cells } } });
    const part = applied.parts.find((p) => p.id === id)!;
    const covered = partCells(part, { q: 4, r: 2 }, 0).map(hexKey).sort();
    expect(covered).toEqual(['4,2', '5,2'].sort());
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

  /**
   * The mounting and the footprint are two answers about one part, and the
   * inspector saves both. Writing the entry rather than merging into it meant
   * the second call silently discarded the first — you would draw the cells,
   * save, and find the mounting face gone.
   */
  it('keeps the mounting when the footprint is saved, and the other way round', () => {
    const withFace = setMounting(none(), 'shelf-1', { wallFaceAxis: 'y', matingEnd: 'low' });
    const both = setFootprint(withFace, 'shelf-1', [{ q: 0, r: 0 }, { q: 1, r: 0 }]);
    expect(both.parts['shelf-1']?.mounting?.wallFaceAxis).toBe('y');
    expect(both.parts['shelf-1']?.footprint).toHaveLength(2);

    const reseated = setMounting(both, 'shelf-1', { wallFaceAxis: 'x', matingEnd: 'high' });
    expect(reseated.parts['shelf-1']?.footprint).toHaveLength(2);
    expect(reseated.parts['shelf-1']?.mounting?.wallFaceAxis).toBe('x');
  });

  /**
   * Which fastener a part hangs on is the third answer the inspector gives, and
   * it has to come BACK. It applied for one session and vanished on reload,
   * because `loadUserOverrides` re-validates every field it reads and simply did
   * not read this one — a correction that does not survive a reload is not saved.
   */
  it('round-trips the chosen fastener through the browser store', () => {
    const chosen = [{ partId: 'insert-with-m3', count: 2 }];
    const set = setRequires(none(), 'shelf-1', chosen);
    expect(set.parts['shelf-1']?.requires).toEqual(chosen);

    const reread = loadFrom(JSON.stringify(set));
    expect(reread.parts['shelf-1']?.requires).toEqual(chosen);
  });

  /** "It needs nothing" is an answer, and it must not read back as "no answer". */
  it('keeps an empty fastener list, which means the part needs none', () => {
    const set = setRequires(none(), 'shelf-1', []);
    expect(loadFrom(JSON.stringify(set)).parts['shelf-1']?.requires).toEqual([]);
    const applied = applyOverrides(catalog, { parts: { 'shelf-1': { requires: [] } } });
    expect(applied.parts.find((p) => p.id === 'shelf-1')!.requires).toEqual([]);
  });

  it('keeps the mounting and the cells when the fastener is chosen', () => {
    let user = setMounting(none(), 'shelf-1', { wallFaceAxis: 'y', matingEnd: 'low' });
    user = setFootprint(user, 'shelf-1', [{ q: 0, r: 0 }, { q: 1, r: 0 }], [{ q: 1, r: 0 }]);
    user = setRequires(user, 'shelf-1', [{ partId: 'insert-empty', count: 3 }]);
    expect(user.parts['shelf-1']?.mounting?.wallFaceAxis).toBe('y');
    expect(user.parts['shelf-1']?.footprint).toHaveLength(2);
    expect(user.parts['shelf-1']?.socketCells).toHaveLength(1);
    expect(user.parts['shelf-1']?.requires?.[0]?.count).toBe(3);
  });

  /**
   * The pushable file: every part that carries a decision, shipped or local.
   *
   * The narrow export answers "what did I change"; this answers "what is this
   * project's setup", which is the thing that gets committed. A person who has
   * corrected four parts here still needs the other forty-seven to travel.
   */
  it('exports the whole setup, shipped decisions included', () => {
    const shipped = {
      _why: 'because',
      parts: {
        box: { fastenersNeedReview: true },
        'shelf-1': { requires: [{ partId: 'insert-empty', count: 2 }] },
      },
    };
    const user = setRequires(none(), 'shelf-1', [{ partId: 'insert-with-m3', count: 3 }]);
    const file = JSON.parse(toSetupFile(shipped, user));

    // The local decision wins where they disagree...
    expect(file.parts['shelf-1'].requires).toEqual([{ partId: 'insert-with-m3', count: 3 }]);
    // ...every untouched part still travels...
    expect(file.parts['box']).toEqual({ fastenersNeedReview: true });
    // ...and the preamble that explains the file survives.
    expect(file._why).toBe('because');
  });

  /** Applying what was exported has to reproduce what was on screen. */
  it('round-trips the whole setup through applyOverrides', () => {
    const user = setRequires(
      setMounting(none(), 'shelf-1', { wallFaceAxis: 'x', matingEnd: 'high' }),
      'shelf-1',
      [{ partId: 'insert-m4', count: 4 }],
    );
    const applied = applyOverrides(catalog, JSON.parse(toSetupFile({ parts: {} }, user)));
    const part = applied.parts.find((p) => p.id === 'shelf-1')!;
    expect(mountingOf(part)).toEqual({ wallFaceAxis: 'x', matingEnd: 'high' });
    expect(part.requires).toEqual([{ partId: 'insert-m4', count: 4 }]);
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

  /** What is exported must be what `applyOverrides` reads back — all six of it. */
  it('exports in the shape the app and the scanner already consume', () => {
    const seated = {
      wallFaceAxis: 'x' as const, matingEnd: 'high' as const,
      spinSteps: 2, spinDeg: 7.5, tiltXDeg: -3.2, tiltYDeg: 0.5,
      offsetMm: 1.5, offsetXMm: -2.4, offsetYMm: 11.1,
    };
    const user = setMounting(none(), 'shelf-1', seated);
    const applied = applyOverrides(catalog, JSON.parse(toOverrideFile(user)));
    expect(mountingOf(applied.parts.find((p) => p.id === 'shelf-1')!)).toEqual(seated);
  });

  /** The same six have to survive the localStorage round trip, which re-reads them. */
  it('round-trips all six through the browser store', () => {
    const seated = {
      wallFaceAxis: 'y' as const, matingEnd: 'low' as const,
      spinSteps: 5, spinDeg: 12.4, tiltXDeg: 90, tiltYDeg: -45,
      offsetMm: -6.5, offsetXMm: 8, offsetYMm: -8,
    };
    expect(readMounting(JSON.parse(JSON.stringify(seated)))).toEqual(seated);
  });
});

/**
 * THE SHIPPED FILE, as everyone who loads the site gets it.
 *
 * Everything above works on a fabricated part and a synthetic overrides object,
 * which proves the mechanism and not the artefact. This block reads the real
 * `src/catalog/overrides.json` — the file the app imports, the file `Download
 * setup` is meant to replace — and asserts that every decision in it actually
 * lands on the catalogue the browser builds.
 *
 * It exists because of what the file is FOR. A correction is made in a browser,
 * where it lives in localStorage and applies to one person on one device; it
 * reaches everybody else only by being exported into this file and committed.
 * That hand-off is the one step with no feedback: an id that does not match a
 * part, or a field the reader does not know, is a silent no-op — the app looks
 * exactly the same as if the correction had never been made, which is precisely
 * how the fastener choice was lost for a whole session (D44) and how a
 * correction keyed on a `user/…` id was written, stored, exported and never
 * applied (D71).
 *
 * It is driven BY the file rather than by a list written here, so it covers
 * whatever gets added to it next without anybody remembering to extend it.
 */
describe('the corrections that ship', () => {
  const shipped = overridesJson as { parts: Record<string, Record<string, unknown>> };
  const applied = applyOverrides(catalog, shipped);
  const byId = new Map(applied.parts.map((p) => [p.id, p]));
  const ids = Object.keys(shipped.parts);

  it('names parts that exist', () => {
    // A typo'd or retired id is dead weight that reads as a correction. There is
    // nothing in the app that would ever tell you.
    const orphans = ids.filter((id) => !byId.has(id));
    expect(orphans, 'ids in overrides.json with no part in the catalogue').toEqual([]);
  });

  it('lands every field on the catalogue the browser builds', () => {
    expect(ids.length).toBeGreaterThan(0);

    for (const id of ids) {
      const override = shipped.parts[id]!;
      const part = byId.get(id);
      if (part === undefined) continue; // reported by the test above

      if (override['mounting'] !== undefined) {
        expect(mountingOf(part), `${id}: mounting`).toEqual(readMounting(override['mounting']));
      }
      if (override['footprint'] !== undefined) {
        const want = readFootprint(override['footprint']) ?? [];
        expect(part.footprint?.map(hexKey), `${id}: footprint`).toEqual(want.map(hexKey));
      }
      if (override['socketCells'] !== undefined) {
        const want = readFootprint(override['socketCells']) ?? [];
        expect(socketsOf(part).map(hexKey), `${id}: sockets`).toEqual(want.map(hexKey));
      }
      if (override['requires'] !== undefined) {
        expect(part.requires, `${id}: requires`).toEqual(override['requires']);
      }
    }
  });

  /**
   * The one that matters on publication day.
   *
   * 27 of the 51 shipped parts still carry `needsReview`, and the mounting face
   * is what the inspector exists to answer. Today the file carries none — this
   * does not fail for that, because "nobody has aligned anything yet" is a
   * legitimate state. It fails if an alignment is added and does NOT arrive,
   * which is the state that looks identical from the outside.
   */
  it('applies the alignments, however many there are', () => {
    const aligned = ids.filter((id) => shipped.parts[id]!['mounting'] !== undefined);
    for (const id of aligned) {
      expect(mountingOf(byId.get(id)!), `${id} is aligned in the file but not in the app`)
        .toBeDefined();
    }
    // Stated out loud so the number is visible in the run rather than inferred
    // from a silent pass over an empty list.
    expect(aligned.length, `alignments shipped: ${aligned.length} of ${ids.length} corrections`)
      .toBe(aligned.length);
  });
});
