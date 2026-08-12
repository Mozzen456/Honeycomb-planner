/**
 * How many fixings each part actually takes.
 *
 * The worst defect the parts list had: ten shipped accessories ordered NO
 * fastener at all — including both 200 mm wrench racks — and the shelves
 * ordered one insert per cell of their bounding-box BOUND, so a 7-cell shelf
 * with two pegs asked for seven inserts. `detect.mountPoints` counts the
 * mounting bosses on the wall face instead, and refuses to answer when the
 * count is not stable across depth.
 *
 * The corrections it produced live in `src/catalog/overrides.json`, because
 * `catalog.json` is generated and hand-editing it is the one thing CLAUDE.md
 * forbids.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import overridesJson from '../src/catalog/overrides.json';
import { detect, mountPoints } from '../src/core/detect';
import { applyOverrides, fastenersNeedReview } from '../src/core/overrides';
import type { Catalog } from '../src/core/types';
import { loadModel } from './stl.test';

const catalog = catalogJson as unknown as Catalog;
const corrected = applyOverrides(catalog, overridesJson);
const part = (id: string) => corrected.parts.find((p) => p.id === id)!;
const orders = (id: string) => part(id).requires.reduce((n, r) => n + r.count, 0);

describe('mountPoints', () => {
  /**
   * The shelves are the clearest case in the model set: a flat tray with pegs
   * at each end, and every boss measures ~15.6 mm across corners — the 13.4 mm
   * insert socket (15.47 across corners), confirmed independently by a third
   * party quoting "15.47 by 13.4". Four parts, one shape, one answer.
   */
  it.each([
    ['shelf-1', 2],
    ['shelf-2', 2],
    ['shelf-3', 2],
    ['shelf-4', 3],
  ])('measures %s at %i mounting points', (id, expected) => {
    const mesh = loadModel(part(id).file);
    const mp = mountPoints(mesh, detect(mesh));
    expect(mp.confident).toBe(true);
    expect(mp.count).toBe(expected);
    for (const span of mp.spansMm) expect(span).toBeGreaterThan(13);
    for (const span of mp.spansMm) expect(span).toBeLessThan(19);
  }, 120000);

  it('says so rather than guessing when the bosses cannot be counted', () => {
    // A wrench rack's bosses merge with its bar at every depth the raster can
    // separate, so there is no stable count. That is reported as unknown, not
    // rounded to something plausible.
    const mesh = loadModel(part('wranch-hoks-1').file);
    expect(mountPoints(mesh, detect(mesh)).confident).toBe(false);
  }, 120000);

  it('needs no insert for a part that clips straight into the wall', () => {
    const mesh = loadModel(part('20-micro-sd-card-holder').file);
    const mp = mountPoints(mesh, detect(mesh));
    expect(mp.confident).toBe(true);
    expect(mp.notes.join(' ')).toMatch(/no separate insert/);
    expect(orders('20-micro-sd-card-holder')).toBe(0);
  }, 120000);
});

describe('the corrections reach the catalogue', () => {
  it('orders the measured number of inserts, not one per bounding-box cell', () => {
    for (const [id, expected] of [['shelf-1', 2], ['shelf-2', 2], ['shelf-3', 2], ['shelf-4', 3]] as const) {
      expect(orders(id), id).toBe(expected);
      // ...and the uncorrected catalogue really did order one per cell, so this
      // test fails loudly if the override file is ever dropped.
      const raw = catalog.parts.find((p) => p.id === id)!;
      expect(raw.requires.reduce((n, r) => n + r.count, 0)).toBe(raw.footprint.length);
    }
  });

  /**
   * The rule, from the system itself: a second-tier part mounts through a
   * hexagonal peg that slides into an INSERT, which clips into a wall cell
   * (HSW-SPEC §5). There is no such thing as one that fastens with nothing.
   *
   * Ten shipped accessories used to order zero — including two 200 mm wrench
   * racks. A count of zero there was never a measurement, it was a missing one.
   */
  it('never lets an insert-fed accessory be fastened by nothing', () => {
    const unfastened: string[] = [];
    for (const p of corrected.parts) {
      if (p.type !== 'accessory') continue;
      const measurement = (p as unknown as { measurement?: { tier?: string } }).measurement;
      if (measurement?.tier === 'wall-clip') continue; // carries its own interface
      const fixings = p.requires.reduce((n, r) => n + r.count, 0);
      const boughtBolts = p.hardware.reduce((n, h) => n + (/bolt|screw/i.test(h.item) ? h.count : 0), 0);
      if (fixings + boughtBolts === 0) unfastened.push(p.id);
    }
    expect(unfastened).toEqual([]);
  });

  it('flags the floored ones rather than passing a guess off as a count', () => {
    // Four parts get a floor of one because their pegs could not be counted.
    // Every one of them must say so, or the floor becomes indistinguishable
    // from a measurement.
    const table = (overridesJson as { parts: Record<string, { _note?: string; fastenersNeedReview?: boolean }> }).parts;
    const floored = Object.entries(table).filter(([, v]) => /Floored at one/.test(v._note ?? ''));
    expect(floored.length).toBeGreaterThan(0);
    for (const [id, entry] of floored) {
      expect(entry.fastenersNeedReview, id).toBe(true);
      expect(fastenersNeedReview(corrected.parts.find((p) => p.id === id)), id).toBe(true);
    }
  });

  it('never silently drops a correction that changes a count', () => {
    const table = (overridesJson as { parts: Record<string, { requires?: unknown[] }> }).parts;
    for (const [id, entry] of Object.entries(table)) {
      if (!Array.isArray(entry.requires)) continue;
      const want = (entry.requires as { count: number }[]).reduce((n, r) => n + r.count, 0);
      expect(orders(id), id).toBe(want);
    }
  });
});
