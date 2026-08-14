/**
 * The printing cart: how many of each line are printed, and how many are left.
 *
 * Three owners have to agree about one number, which is the whole risk here:
 * the document stores it, `bom.ts` caps it against what the layout now needs,
 * and the store edits it. The tests below are written against the behaviour a
 * person sees — print four, the line says four fewer — rather than against any
 * one of those three, so a change that moves the rule between them still passes
 * and a change that breaks it cannot.
 *
 * Each one was checked by breaking the code deliberately and watching it go red
 * (the cap, the delete-on-zero, the absent-key round trip). See the note in
 * CLAUDE.md about tests that cannot fail.
 */

import { describe, expect, it } from 'vitest';

import { computeBom } from '../src/core/bom';
import { decodeShareUrl, deserialize, encodeShareUrl, serialize } from '../src/core/persist';
import { Store, emptyDoc } from '../src/core/store';
import type {
  Catalog,
  CatalogPart,
  LayoutDoc,
  PlacedItem,
  PrintEstimate,
  Rotation,
} from '../src/core/types';

// ---------------------------------------------------------------------------
// Fixtures — small enough to check the arithmetic by hand
// ---------------------------------------------------------------------------

function makeEstimate(over: Partial<PrintEstimate> = {}): PrintEstimate {
  return {
    minutes: 10,
    grams: 5,
    metres: 1.5,
    profile: 'test-0.20mm-pla',
    supports: false,
    source: 'sliced',
    ...over,
  };
}

function makePart(id: string, over: Partial<CatalogPart> = {}): CatalogPart {
  return {
    id,
    name: `Part ${id}`,
    file: `models/${id}.stl`,
    type: 'accessory',
    group: 'test',
    footprint: [{ q: 0, r: 0 }],
    anchor: { q: 0, r: 0 },
    drawnOrientation: 'pointy',
    bboxMm: [23.6, 23.6, 8],
    volumeMm3: 1000,
    requires: [],
    hardware: [],
    print: makeEstimate(),
    provenance: { basis: 'geometry', confidence: 1, notes: [] },
    sha256: `sha-${id}`,
    ...over,
  };
}

const HOOK = makePart('hook');
const CLIP = makePart('clip', { type: 'insert' });

const CATALOG: Catalog = {
  schemaVersion: 1,
  generatedAt: '2024-01-01T00:00:00.000Z',
  slicerProfile: 'test-0.20mm-pla',
  parts: [HOOK, CLIP],
  unresolved: [],
};

const item = (id: string, partId: string, q: number, rotation: Rotation = 0): PlacedItem => ({
  id,
  partId,
  at: { q, r: 0 },
  rotation,
});

function docWith(count: number, printed?: Record<string, number>): LayoutDoc {
  const items = Array.from({ length: count }, (_, i) => item(`i${i}`, 'hook', i));
  return { ...emptyDoc(), items, ...(printed ? { printed } : {}) };
}

const hookLine = (doc: LayoutDoc) =>
  computeBom(doc, CATALOG).printed.find((l) => l.partId === 'hook')!;

// ---------------------------------------------------------------------------
// The line: printed, and what is left
// ---------------------------------------------------------------------------

describe('a line counts down as it is printed', () => {
  it('starts with everything to print and nothing printed', () => {
    const line = hookLine(docWith(6));
    expect(line.quantity).toBe(6);
    expect(line.printed).toBe(0);
    expect(line.toPrint).toBe(6);
  });

  it('says how many more to print once some are done', () => {
    const line = hookLine(docWith(6, { hook: 4 }));
    expect(line.printed).toBe(4);
    expect(line.toPrint).toBe(2);
  });

  it('reaches zero to print when the count meets the quantity', () => {
    expect(hookLine(docWith(6, { hook: 6 })).toPrint).toBe(0);
  });

  /**
   * The cap. A layout that shrinks under a count already taken must not report
   * "8 of 3 printed" or a negative number of parts still to go, and — the half
   * that is easy to lose — the DOCUMENT must keep the 8, so that putting the
   * parts back gives the progress back rather than starting the build again.
   */
  it('caps a stale count at what the layout now needs, without forgetting it', () => {
    const stale = docWith(3, { hook: 8 });
    const line = hookLine(stale);
    expect(line.printed).toBe(3);
    expect(line.toPrint).toBe(0);
    expect(stale.printed!['hook']).toBe(8);

    // Put the parts back: the count that was kept is the count that applies.
    const restored = docWith(10, { hook: 8 });
    expect(hookLine(restored).printed).toBe(8);
    expect(hookLine(restored).toPrint).toBe(2);
  });

  it('refuses to read rubbish as progress', () => {
    for (const bad of [-4, Number.NaN, Number.POSITIVE_INFINITY, 2.7]) {
      const line = hookLine(docWith(6, { hook: bad as number }));
      expect(Number.isInteger(line.printed), String(bad)).toBe(true);
      expect(line.printed, String(bad)).toBeGreaterThanOrEqual(0);
      expect(line.printed + line.toPrint, String(bad)).toBe(6);
    }
    // 2.7 of a thing has not been printed; two have.
    expect(hookLine(docWith(6, { hook: 2.7 })).printed).toBe(2);
  });

  it('counts a required insert like anything else — it is printed too', () => {
    const shelf = makePart('shelf', { requires: [{ partId: 'clip', count: 2 }] });
    const catalog: Catalog = { ...CATALOG, parts: [shelf, CLIP] };
    const doc: LayoutDoc = {
      ...emptyDoc(),
      items: [item('a', 'shelf', 0), item('b', 'shelf', 1)],
      printed: { clip: 3 },
    };
    const clip = computeBom(doc, catalog).fasteners.find((l) => l.partId === 'clip')!;
    expect(clip.quantity).toBe(4);
    expect(clip.printed).toBe(3);
    expect(clip.toPrint).toBe(1);
  });
});

describe('the totals answer "how many more"', () => {
  it('splits the parts into printed and still to print', () => {
    const totals = computeBom(docWith(6, { hook: 4 }), CATALOG).totals;
    expect(totals.parts).toBe(6);
    expect(totals.printed).toBe(4);
    expect(totals.toPrint).toBe(2);
  });

  it('always adds back up to the number of parts, stale counts included', () => {
    for (const counts of [undefined, { hook: 1 }, { hook: 5 }, { hook: 99 }]) {
      const totals = computeBom(docWith(5, counts), CATALOG).totals;
      expect(totals.printed + totals.toPrint, JSON.stringify(counts)).toBe(totals.parts);
    }
  });

  it('leaves the filament figures alone — they are the whole job', () => {
    const all = computeBom(docWith(4), CATALOG).totals;
    const half = computeBom(docWith(4, { hook: 2 }), CATALOG).totals;
    expect(half.grams).toBe(all.grams);
    expect(half.metres).toBe(all.metres);
  });
});

// ---------------------------------------------------------------------------
// The store: editing the count
// ---------------------------------------------------------------------------

describe('setPrinted', () => {
  const store = (doc: LayoutDoc): Store => new Store(doc, CATALOG);

  it('records a count and undoes it', () => {
    const s = store(docWith(6));
    s.setPrinted('hook', 4);
    expect(s.getState().doc.printed).toEqual({ hook: 4 });
    s.undo();
    expect(s.getState().doc.printed).toBeUndefined();
    s.redo();
    expect(s.getState().doc.printed).toEqual({ hook: 4 });
  });

  it('deletes the key at zero, and the whole field with the last key', () => {
    const s = store(docWith(6));
    s.setPrinted('hook', 4);
    s.setPrinted('clip', 1);
    s.setPrinted('hook', 0);
    expect(s.getState().doc.printed).toEqual({ clip: 1 });
    s.setPrinted('clip', 0);
    // Not `{}` — an absent key has to round-trip to an absent key.
    expect(s.getState().doc.printed).toBeUndefined();
  });

  it('is absolute, not a delta: two calls with the same number land once', () => {
    const s = store(docWith(6));
    s.setPrinted('hook', 3);
    const after = s.getState();
    s.setPrinted('hook', 3);
    // Same value, so no commit at all — a repeat click costs no undo step.
    expect(s.getState().doc).toBe(after.doc);
    expect(s.getState().doc.printed).toEqual({ hook: 3 });
  });

  /**
   * The stepper, and the bug it exists for.
   *
   * Found by driving the running app: `+ + +` on a 12-plate line recorded ONE.
   * A button in a rendered list knows the count as of its last render, so three
   * clicks arriving before a repaint each compute `0 + 1`. The store holds the
   * count, so the store does the arithmetic — the same rule as D58.
   *
   * The loop below is that failure exactly: `printed` is read ONCE, the way a
   * rendered closure holds it, and then three steps are taken from it.
   */
  it('steps from the stored count, so a burst of clicks all count', () => {
    const s = store(docWith(12));
    const stale = s.getState().doc.printed?.['hook'] ?? 0;
    for (let i = 0; i < 3; i++) s.bumpPrinted('hook', 1, 12);
    expect(stale).toBe(0); // what the buttons in that render were holding
    expect(s.getState().doc.printed).toEqual({ hook: 3 });
  });

  it('will not step below none or above the line', () => {
    const s = store(docWith(4, { hook: 1 }));
    s.bumpPrinted('hook', -1, 4);
    s.bumpPrinted('hook', -1, 4);
    expect(s.getState().doc.printed).toBeUndefined();
    for (let i = 0; i < 9; i++) s.bumpPrinted('hook', 1, 4);
    expect(s.getState().doc.printed).toEqual({ hook: 4 });
  });

  it('stores whole, non-negative counts whatever it is handed', () => {
    const s = store(docWith(6));
    s.setPrinted('hook', -3);
    expect(s.getState().doc.printed).toBeUndefined();
    s.setPrinted('hook', 2.9);
    expect(s.getState().doc.printed).toEqual({ hook: 2 });
    s.setPrinted('hook', Number.NaN);
    expect(s.getState().doc.printed).toBeUndefined();
  });

  it('never mutates the document it was given', () => {
    const doc = docWith(6, { hook: 2 });
    const s = store(doc);
    s.setPrinted('hook', 5);
    expect(doc.printed).toEqual({ hook: 2 });
  });

  it('clears every count in one step, and that step undoes', () => {
    const s = store(docWith(6, { hook: 4, clip: 2 }));
    s.clearPrinted();
    expect(s.getState().doc.printed).toBeUndefined();
    s.undo();
    expect(s.getState().doc.printed).toEqual({ hook: 4, clip: 2 });
  });

  it('clearing nothing is not an undo step', () => {
    const s = store(docWith(6));
    const before = s.getState();
    s.clearPrinted();
    expect(s.getState().canUndo).toBe(before.canUndo);
  });
});

// ---------------------------------------------------------------------------
// Persistence: the progress travels with the layout
// ---------------------------------------------------------------------------

describe('printed counts round-trip', () => {
  const reload = (doc: LayoutDoc): LayoutDoc => {
    const result = deserialize(serialize(doc));
    expect(result.doc, result.errors.join('\n')).not.toBeNull();
    return result.doc!;
  };

  it('survives save and load', () => {
    expect(reload(docWith(6, { hook: 4 })).printed).toEqual({ hook: 4 });
  });

  it('is byte-identical on a second save, whatever order the counts were typed', () => {
    const a: LayoutDoc = { ...docWith(6), printed: { zebra: 1, alpha: 2 } };
    const b: LayoutDoc = { ...docWith(6), printed: { alpha: 2, zebra: 1 } };
    expect(serialize(a)).toBe(serialize(b));
    expect(serialize(reload(a))).toBe(serialize(a));
  });

  it('a layout with no progress serialises exactly as it always did', () => {
    const plain = docWith(6);
    expect(serialize(plain)).not.toContain('printed');
    expect(reload(plain).printed).toBeUndefined();
  });

  it('drops a zero rather than storing it, so a save matches its own reload', () => {
    const doc: LayoutDoc = { ...docWith(6), printed: { hook: 0 } };
    expect(serialize(doc)).not.toContain('"printed"');
    expect(reload(doc).printed).toBeUndefined();
  });

  it('reads a hostile file without believing it', () => {
    const cases: [unknown, unknown][] = [
      ['not an object', undefined],
      [{ hook: 'four' }, undefined],
      [{ hook: -2 }, undefined],
      [{ hook: 1e12 }, { hook: 100_000 }],
      [{ hook: 3.9 }, { hook: 3 }],
    ];
    for (const [stored, expected] of cases) {
      const text = JSON.stringify({ ...docWith(6), printed: stored });
      const result = deserialize(text);
      expect(result.doc, JSON.stringify(stored)).not.toBeNull();
      expect(result.doc!.printed, JSON.stringify(stored)).toEqual(expected);
    }
  });

  it('travels down a share link, like every other edit on the document', () => {
    const url = encodeShareUrl(docWith(6, { hook: 4 }), 'https://example.test/planner');
    const shared = decodeShareUrl(url);
    expect(shared.doc, shared.errors.join('\n')).not.toBeNull();
    expect(shared.doc!.printed).toEqual({ hook: 4 });
  });

  it('a count for a part the layout no longer has is kept, not swept', () => {
    // The layout may get it back; the parts list simply never asks about it.
    const doc: LayoutDoc = { ...docWith(2), printed: { hook: 1, 'long-gone': 5 } };
    expect(reload(doc).printed).toEqual({ hook: 1, 'long-gone': 5 });
    expect(computeBom(doc, CATALOG).printed.some((l) => l.partId === 'long-gone')).toBe(false);
  });
});
