/**
 * A printer that is not on the list.
 *
 * The bed used to be an id and nothing else, so every reader could look it up
 * in `BEDS` for itself. A typed size breaks that: `bedId` alone no longer says
 * how big the plate is, and a reader that keeps doing its own lookup silently
 * falls back to "unknown printer" — which in the solver's case means a wall with
 * no panels on it and a warning nobody asked for.
 *
 * So `bedFor` is the one resolver, and what is tested here is that everything
 * which needs a bed goes through it: the solver, the generated plate sizes, the
 * store's commands, and the file the layout is saved as. The last one matters
 * most — a bed is a property of the wall that was PLANNED, so a layout whose
 * plates were cut for a 380 mm printer has to come back saying so.
 */

import { describe, expect, it } from 'vitest';

import {
  BEDS, bedFor, clampBedMm, CUSTOM_BED_ID, MARGIN_X, MAX_BED_MM, MIN_BED_MM, PITCH,
} from '../src/core/constants';
import { computeBom } from '../src/core/bom';
import { deserialize, serialize } from '../src/core/persist';
import { emptyDoc, Store } from '../src/core/store';
import {
  generatedPlateSizes, maxPlateForBed, plateFootprintMm, solveTiling,
} from '../src/core/tiling';
import type { Catalog } from '../src/core/types';
import catalogJson from '../src/catalog/catalog.json';

const catalog = catalogJson as unknown as Catalog;
const custom = (widthMm: number, depthMm: number) => ({ widthMm, depthMm });

describe('resolving which bed a document means', () => {
  it('gives back the preset for a preset id', () => {
    for (const b of BEDS) expect(bedFor(b.id)).toEqual(b);
  });

  it('builds a bed from the typed size, and says the size in its label', () => {
    // "Custom" on its own in an export header or a warning is not something
    // anyone can check against the printer in front of them.
    const bed = bedFor(CUSTOM_BED_ID, custom(380, 360))!;
    expect(bed.width).toBe(380);
    expect(bed.depth).toBe(360);
    expect(bed.label).toContain('380');
    expect(bed.label).toContain('360');
  });

  it('refuses an id it does not know, and a custom bed with no size', () => {
    // Undefined is what makes `solveTiling` say so rather than guess a printer.
    expect(bedFor('no-such-printer')).toBeUndefined();
    expect(bedFor(CUSTOM_BED_ID)).toBeUndefined();
  });

  it('brings a typed size into range rather than believing it', () => {
    expect(clampBedMm(1e9)).toBe(MAX_BED_MM);
    expect(clampBedMm(-5)).toBe(MIN_BED_MM);
    expect(clampBedMm(Number.NaN)).toBe(MIN_BED_MM);
    expect(bedFor(CUSTOM_BED_ID, custom(1e9, 1e9))!.width).toBe(MAX_BED_MM);
  });

  it('makes at least one whole plate at the smallest bed it allows', () => {
    // The floor is a real floor: below one cell there is nothing to generate and
    // the solver would come back with a warning and a bare wall.
    const bed = bedFor(CUSTOM_BED_ID, custom(MIN_BED_MM, MIN_BED_MM))!;
    const max = maxPlateForBed(bed);
    expect(max.columns).toBeGreaterThanOrEqual(1);
    expect(max.rows).toBeGreaterThanOrEqual(1);
    expect(generatedPlateSizes(CUSTOM_BED_ID, 0, custom(MIN_BED_MM, MIN_BED_MM)).length)
      .toBeGreaterThan(0);
  });
});

describe('generating plates for a typed bed', () => {
  it('offers plates that fit it, and none that do not', () => {
    for (const [w, d] of [[180, 180], [250, 210], [380, 380], [MAX_BED_MM, MAX_BED_MM]]) {
      const sizes = generatedPlateSizes(CUSTOM_BED_ID, 0, custom(w!, d!));
      expect(sizes.length, `${w}×${d}`).toBeGreaterThan(0);
      for (const s of sizes) {
        expect(s.widthMm, `${w}×${d} ${s.partId}`).toBeLessThanOrEqual(w! + 1e-9);
        expect(s.heightMm, `${w}×${d} ${s.partId}`).toBeLessThanOrEqual(d! + 1e-9);
      }
    }
  });

  it('matches the preset exactly when the typed size is the preset’s', () => {
    // The custom path is not a second implementation — it is the same arithmetic
    // reading its numbers from the document instead of from the list.
    for (const b of BEDS) {
      const preset = generatedPlateSizes(b.id);
      const typed = generatedPlateSizes(CUSTOM_BED_ID, 0, custom(b.width, b.depth));
      expect(typed.map((s) => `${s.columns}x${s.rows}`), b.id)
        .toEqual(preset.map((s) => `${s.columns}x${s.rows}`));
    }
  });

  it('gets bigger plates from a bigger typed bed', () => {
    const biggest = (w: number, d: number) => {
      const s = generatedPlateSizes(CUSTOM_BED_ID, 0, custom(w, d))[0]!;
      return s.columns * s.rows;
    };
    expect(biggest(400, 400)).toBeGreaterThan(biggest(300, 300));
    expect(biggest(300, 300)).toBeGreaterThan(biggest(200, 200));
  });

  it('leaves room for a border, like the presets do', () => {
    const t = 4;
    for (const s of generatedPlateSizes(CUSTOM_BED_ID, t, custom(300, 300))) {
      expect(s.widthMm).toBeLessThanOrEqual(300 + 1e-9);
      expect(s.heightMm).toBeLessThanOrEqual(300 + 1e-9);
    }
  });
});

describe('solving a wall for a typed bed', () => {
  const solve = (w: number, d: number) => solveTiling({
    wall: { widthMm: 1800, heightMm: 1000 },
    bedId: CUSTOM_BED_ID,
    customBed: custom(w, d),
    available: generatedPlateSizes(CUSTOM_BED_ID, 0, custom(w, d)),
    allowRotation: false,
  });

  it('covers the wall with plates that fit the printer', () => {
    const res = solve(380, 380);
    expect(res.panels.length).toBeGreaterThan(0);
    expect(res.coverage).toBeGreaterThan(0.9);
    const bed = bedFor(CUSTOM_BED_ID, custom(380, 380))!;
    for (const p of res.panels) {
      const size = plateFootprintMm(p.columns, p.rows);
      expect(size.widthMm).toBeLessThanOrEqual(bed.width + 1e-9);
      expect(size.heightMm).toBeLessThanOrEqual(bed.depth + 1e-9);
    }
  });

  it('says so instead of guessing a printer when the size is missing', () => {
    const res = solveTiling({
      wall: { widthMm: 1800, heightMm: 1000 },
      bedId: CUSTOM_BED_ID,
      available: generatedPlateSizes('bed256'),
      allowRotation: false,
    });
    expect(res.panels).toEqual([]);
    expect(res.warnings.join(' ')).toContain(CUSTOM_BED_ID);
  });

  it('keeps the honeycomb on one lattice, as every other bed must', () => {
    // The band-phase rule (D96) is not a property of the preset list.
    const res = solve(330, 290);
    const low = new Map<number, number>();
    for (const p of res.panels) {
      for (let dq = 0; dq < p.columns; dq++) {
        const q = p.origin.q + dq;
        const r = p.origin.r - Math.floor(dq / 2);
        const y = PITCH * (r + q / 2);
        low.set(q, Math.min(low.get(q) ?? Infinity, y));
      }
    }
    const ys = [...low.values()];
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(PITCH / 2 + 1e-9);
  });
});

describe('the store commands', () => {
  it('seeds the typed size from the printer that was chosen before', () => {
    // So the fields open on a real printer's numbers, and widening a bed by
    // 20 mm does not mean typing both numbers from scratch.
    const store = new Store({ ...emptyDoc(), bedId: 'mk3s' }, catalog);
    store.setBed(CUSTOM_BED_ID);
    expect(store.getState().doc.customBed).toEqual({ widthMm: 250, depthMm: 210 });
  });

  it('keeps a size that is already there', () => {
    const store = new Store(
      { ...emptyDoc(), bedId: 'mini', customBed: custom(333, 222) },
      catalog,
    );
    store.setBed(CUSTOM_BED_ID);
    expect(store.getState().doc.customBed).toEqual({ widthMm: 333, depthMm: 222 });
  });

  it('remembers the typed size while a preset is chosen', () => {
    // Flipping between "my printer" and "a Mini" is not destructive.
    const store = new Store(emptyDoc(), catalog);
    store.setCustomBed(333, 222);
    store.setBed('mini');
    expect(store.getState().doc.customBed).toEqual({ widthMm: 333, depthMm: 222 });
    store.setBed(CUSTOM_BED_ID);
    expect(bedFor(store.getState().doc.bedId, store.getState().doc.customBed)!.width).toBe(333);
  });

  it('clamps what it is given, and choosing a size chooses the printer', () => {
    const store = new Store(emptyDoc(), catalog);
    store.setCustomBed(1e9, -4);
    expect(store.getState().doc.bedId).toBe(CUSTOM_BED_ID);
    expect(store.getState().doc.customBed).toEqual({
      widthMm: MAX_BED_MM, depthMm: MIN_BED_MM,
    });
  });

  it('undoes as one step, back to the printer that was there', () => {
    const store = new Store(emptyDoc(), catalog);
    const before = store.getState().doc.bedId;
    store.setCustomBed(300, 300);
    store.undo();
    expect(store.getState().doc.bedId).toBe(before);
    expect(store.getState().doc.customBed).toBeUndefined();
  });
});

describe('the typed bed survives a save and a load', () => {
  it('comes back with the layout', () => {
    const doc = { ...emptyDoc(), bedId: CUSTOM_BED_ID, customBed: custom(345, 315) };
    const back = deserialize(serialize(doc));
    expect(back.doc!.bedId).toBe(CUSTOM_BED_ID);
    expect(back.doc!.customBed).toEqual({ widthMm: 345, depthMm: 315 });
    expect(back.errors).toEqual([]);
  });

  it('does not add the key to a layout that never had one', () => {
    // An absent key must round-trip to an absent key, or a preset layout starts
    // differing from its own reload.
    const text = serialize(emptyDoc());
    expect(text).not.toContain('customBed');
    expect(deserialize(text).doc!.customBed).toBeUndefined();
  });

  it('clamps a stored size rather than believing it, and says it did', () => {
    // A stored document is user input by the time it comes back. A bed of 1e9
    // would have the solver offering half a million plate sizes.
    const raw = JSON.parse(serialize({ ...emptyDoc(), bedId: CUSTOM_BED_ID, customBed: custom(300, 300) }));
    raw.customBed = { widthMm: 1e9, depthMm: 300 };
    const back = deserialize(JSON.stringify(raw));
    expect(back.doc!.customBed!.widthMm).toBe(MAX_BED_MM);
    expect(back.errors.join(' ')).toMatch(/customBed/);
  });

  it('falls back to a real printer when the size is missing entirely', () => {
    // `bedFor` would return undefined and the wall would come back with
    // "unknown bed" and no panels — a layout that cannot be solved and cannot
    // say why.
    const raw = JSON.parse(serialize(emptyDoc()));
    raw.bedId = CUSTOM_BED_ID;
    const back = deserialize(JSON.stringify(raw));
    expect(back.doc!.bedId).not.toBe(CUSTOM_BED_ID);
    expect(bedFor(back.doc!.bedId, back.doc!.customBed)).toBeDefined();
    expect(back.errors.join(' ')).toContain(CUSTOM_BED_ID);
  });

  it('ignores a size that is not a size', () => {
    const raw = JSON.parse(serialize(emptyDoc()));
    raw.customBed = 'big';
    const back = deserialize(JSON.stringify(raw));
    expect(back.doc!.customBed).toBeUndefined();
    expect(back.errors.join(' ')).toMatch(/customBed/);
  });
});

describe('a wall planned on a typed bed', () => {
  it('plans, saves, loads and still fits the same printer', () => {
    // End to end, because the failure this feature invites is a size that is
    // honoured while you are looking at it and forgotten on reload.
    const bedMm = custom(365, 305);
    const store = new Store({ ...emptyDoc(), wall: { widthMm: 1500, heightMm: 900 } }, catalog);
    store.setCustomBed(bedMm.widthMm, bedMm.depthMm);
    const doc = store.getState().doc;
    const res = solveTiling({
      wall: doc.wall,
      bedId: doc.bedId,
      customBed: doc.customBed,
      available: generatedPlateSizes(doc.bedId, 0, doc.customBed),
      allowRotation: false,
    });
    expect(res.panels.length).toBeGreaterThan(0);

    const back = deserialize(serialize({ ...doc, panels: res.panels.map((p, i) => ({
      id: `p${i}`, partId: p.partId, origin: p.origin, columns: p.columns, rows: p.rows,
    })) }));
    const bed = bedFor(back.doc!.bedId, back.doc!.customBed)!;
    expect(bed.width).toBe(bedMm.widthMm);
    for (const p of back.doc!.panels) {
      const size = plateFootprintMm(p.columns, p.rows);
      expect(size.widthMm, `${p.columns}x${p.rows}`).toBeLessThanOrEqual(bed.width + 1e-9);
      expect(size.heightMm, `${p.columns}x${p.rows}`).toBeLessThanOrEqual(bed.depth + 1e-9);
    }
    // ...and the plates really are sized to THIS printer, not to a preset: the
    // widest one reaches within a column of the bed.
    const widest = Math.max(...back.doc!.panels.map((p) => plateFootprintMm(p.columns, p.rows).widthMm));
    expect(widest).toBeGreaterThan(bed.width - 2 * MARGIN_X - PITCH);
  });
});

describe('the parts list for a plate the customiser cannot express', () => {
  /**
   * A BOM fact, reproduced here because it takes a big bed to see it.
   *
   * `toCustomiserPanel` returns null above 13 × 12 — the customiser's own limit
   * — and a `generated/…` id has no catalogue entry by design (D61), so the
   * line's cell count had nothing left to fall back on and used 1. An 18 × 13
   * plate came out as "Custom panel A — 1 cells" and 5.1 g of filament, on a
   * parts list whose whole job is to say what to print. A 256 mm printer never
   * showed it because 12 × 10 is inside the customiser's range.
   */
  it('counts the plate’s real cells, and costs it as a real plate', () => {
    const store = new Store(
      { ...emptyDoc(), wall: { widthMm: 2400, heightMm: 1200 } },
      catalog,
    );
    store.setCustomBed(380, 340);
    const doc = store.getState().doc;
    const res = solveTiling({
      wall: doc.wall,
      bedId: doc.bedId,
      customBed: doc.customBed,
      available: generatedPlateSizes(doc.bedId, 0, doc.customBed),
      allowRotation: false,
    });
    const biggest = res.panels.reduce((a, b) => (a.columns * a.rows >= b.columns * b.rows ? a : b));
    expect(biggest.columns * biggest.rows).toBe(18 * 13); // past 13 × 12
    store.setPanels(res.panels.map((p, i) => ({
      id: `p${i}`, partId: p.partId, origin: p.origin, columns: p.columns, rows: p.rows,
    })));

    const bom = computeBom(store.getState().doc, catalog);
    const lines = bom.printed.filter((l) => l.type === 'panel');
    expect(lines.length).toBeGreaterThan(0);
    const line = lines.find((l) => l.name.includes(`${18 * 13} cells`));
    expect(line, lines.map((l) => l.name).join(' | ')).toBeDefined();
    // A 234-cell plate is most of a kilogram of filament, not five grams.
    expect(line!.grams / line!.quantity).toBeGreaterThan(100);
    for (const l of lines) expect(l.name, l.name).not.toMatch(/\b1 cells\b/);
  });
});
