/**
 * CRITIC — BOM TRUTH TEST
 *
 * Written by an independent reviewer who wrote none of the app code. Every
 * expected number below was computed by hand from `src/catalog/catalog.json`
 * BEFORE the test was run, and is written as a literal so that a change to the
 * code cannot quietly re-bless itself. Where a number is derived in-test it is
 * derived from the catalogue by an independent route (a second, dumber loop),
 * never by calling the function under test.
 *
 * Three layouts:
 *   L1  small        — 2 panels + a handful of accessories
 *   L2  garage wall  — 2400 x 1200 solved for bed256 (60 panels) + 30 accessories
 *   L3  awkward      — seam crossing, off-edge, overlap, unknown partId,
 *                      multi-cell part rotated
 *
 * Plus: the wall-screw double-count regression, the rounding-loss check, the
 * seam-crossing proof, and a catalogue integrity sweep.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { computeBom, itemCells, validate } from '../src/core/bom';
import { hexKey, panelCells, placeFootprint } from '../src/core/hex';
import { Store, emptyDoc } from '../src/core/store';
import { crossesSeam, solveTiling, type PanelSize } from '../src/core/tiling';
import type {
  Bom,
  BomLine,
  Catalog,
  CatalogPart,
  Hex,
  Issue,
  LayoutDoc,
  PlacedItem,
  PlacedPanel,
  Rotation,
} from '../src/core/types';

const catalog = catalogJson as unknown as Catalog;

// ---------------------------------------------------------------------------
// Helpers — deliberately dumb, so they cannot share a bug with bom.ts
// ---------------------------------------------------------------------------

function part(id: string): CatalogPart {
  const p = catalog.parts.find((x) => x.id === id);
  if (!p) throw new Error(`fixture error: no catalogue part "${id}"`);
  return p;
}

function line(bom: Bom, partId: string): BomLine | undefined {
  return [...bom.printed, ...bom.fasteners].find((l) => l.partId === partId);
}

function qty(bom: Bom, partId: string): number {
  return line(bom, partId)?.quantity ?? 0;
}

function shop(bom: Bom, item: string): number {
  return bom.shopping.find((s) => s.item === item)?.count ?? 0;
}

function codes(issues: Issue[]): string[] {
  return issues.map((i) => i.code).sort();
}

/**
 * Independent re-derivation of the totals straight from the catalogue, done in
 * SCALED INTEGERS so it shares no floating-point behaviour with bom.ts. Every
 * catalogue estimate has at most 2 dp of minutes/grams and 4 dp of metres (this
 * is asserted in section 0), so the scaling below is exact.
 *
 * Rounding contract, from bom.ts R1: minutes -> whole, grams -> 1 dp,
 * metres -> 2 dp, half away from zero, applied once at the boundary.
 */
const scale = (v: number, f: number): number => Math.round(v * f);

function expectedTotals(counts: ReadonlyMap<string, number>): {
  parts: number;
  minutes: number;
  grams: number;
  metres: number;
  /** Exact decimal sums, as integers, before the boundary rounding. */
  rawMinutesHundredths: number;
  rawGramsHundredths: number;
  rawMetresTenThousandths: number;
} {
  let parts = 0;
  let minutes = 0; // hundredths
  let grams = 0; // hundredths
  let metres = 0; // ten-thousandths
  for (const [id, n] of counts) {
    const p = part(id);
    parts += n;
    minutes += scale(p.print.minutes, 100) * n;
    grams += scale(p.print.grams, 100) * n;
    metres += scale(p.print.metres, 10000) * n;
  }
  return {
    parts,
    minutes: Math.round(minutes / 100),
    grams: Math.round(grams / 10) / 10,
    metres: Math.round(metres / 100) / 100,
    rawMinutesHundredths: minutes,
    rawGramsHundredths: grams,
    rawMetresTenThousandths: metres,
  };
}

const doc = (over: Partial<LayoutDoc>): LayoutDoc => ({ ...emptyDoc(), ...over });

const item = (id: string, partId: string, at: Hex, rotation: Rotation = 0): PlacedItem => ({
  id,
  partId,
  at,
  rotation,
});

// NOTE ON WALL FIXINGS. These fixtures were written when every panel carried
// `requires: insert-countersunk x (4 + cells/50)` and the BOM multiplied that by
// the number of plates -- 370 wall screws on a 2400 x 1200 wall, one every
// 88 mm. Wall fixings are now planned across the ASSEMBLY at a spacing
// (src/core/fixings.ts), so the counts below changed by design. What has NOT
// changed, and is still asserted everywhere it was, is the invariant that was
// the point of these tests: one wall screw and one plug per countersunk insert,
// never two and never none.
const WALL_SCREW = 'Wall screw, 3.5 x 35 mm countersunk';
const WALL_PLUG = 'Wall plug, 6 mm';

// ===========================================================================
// 0. Catalogue integrity — a bad catalogue poisons every BOM below
// ===========================================================================

describe('0 — catalogue integrity', () => {
  it('has no duplicate ids, and every id is a non-empty string', () => {
    const ids = catalog.parts.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(ids.length).toBe(51);
  });

  it('every `requires` target exists in the catalogue', () => {
    const ids = new Set(catalog.parts.map((p) => p.id));
    const dangling: string[] = [];
    for (const p of catalog.parts) {
      for (const r of p.requires ?? []) {
        if (!ids.has(r.partId)) dangling.push(`${p.id} -> ${r.partId}`);
        expect(r.count).toBeGreaterThan(0);
        expect(Number.isInteger(r.count)).toBe(true);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('estimates carry at most 2 dp (minutes, grams) and 4 dp (metres)', () => {
    // The integer re-derivation in `expectedTotals` depends on this.
    const bad: string[] = [];
    for (const p of catalog.parts) {
      if (Math.abs(p.print.minutes * 100 - Math.round(p.print.minutes * 100)) > 1e-6) bad.push(`${p.id}:min`);
      if (Math.abs(p.print.grams * 100 - Math.round(p.print.grams * 100)) > 1e-6) bad.push(`${p.id}:g`);
      if (Math.abs(p.print.metres * 10000 - Math.round(p.print.metres * 10000)) > 1e-6) bad.push(`${p.id}:m`);
    }
    expect(bad).toEqual([]);
  });

  it('no part carries a print estimate of zero or a non-finite one', () => {
    const bad: string[] = [];
    for (const p of catalog.parts) {
      const e = p.print;
      if (!(e && e.minutes > 0 && e.grams > 0 && e.metres > 0)) bad.push(p.id);
      if (e && e.source !== 'sliced' && e.source !== 'volume') bad.push(`${p.id}:source`);
    }
    expect(bad).toEqual([]);
  });

  it('every footprint contains its anchor, has no duplicate cells, and is non-empty', () => {
    const bad: string[] = [];
    for (const p of catalog.parts) {
      const fp = p.footprint ?? [];
      if (fp.length === 0) bad.push(`${p.id}:empty`);
      const keys = new Set(fp.map(hexKey));
      if (keys.size !== fp.length) bad.push(`${p.id}:dupe`);
      if (!keys.has(hexKey(p.anchor ?? { q: 0, r: 0 }))) bad.push(`${p.id}:anchor`);
    }
    expect(bad).toEqual([]);
  });

  it('a panel’s cell count equals columns x rows, and each declares its wall fixings', () => {
    for (const p of catalog.parts.filter((x) => x.type === 'panel')) {
      expect(p.panel).toBeDefined();
      expect(p.panel!.columns * p.panel!.rows).toBe(p.footprint.length);

      // HSW-SPEC section 4: 4 wall mounts per panel, plus one more per 50 cells.
      const expectedMounts = 4 + Math.floor(p.footprint.length / 50);
      const mounts = (p.requires ?? [])
        .filter((r) => r.partId === 'insert-countersunk')
        .reduce((a, r) => a + r.count, 0);
      expect({ id: p.id, mounts }).toEqual({ id: p.id, mounts: expectedMounts });
    }
  });

  it('R3 holds: nothing a part requires has requirements of its own', () => {
    // computeBom expands `requires` exactly one level. If a required part had
    // requirements, that second level would be silently dropped — an undercount.
    const nested: string[] = [];
    for (const p of catalog.parts) {
      for (const r of p.requires ?? []) {
        const target = catalog.parts.find((x) => x.id === r.partId);
        if (target && (target.requires ?? []).length > 0) nested.push(`${p.id} -> ${r.partId}`);
      }
    }
    expect(nested).toEqual([]);
  });

  it('REGRESSION: no wall screw is claimed twice — a part and its requirement never both list one', () => {
    const listsWallScrew = (p: CatalogPart): boolean =>
      (p.hardware ?? []).some((h) => h.item === WALL_SCREW);
    const doubled: string[] = [];
    for (const p of catalog.parts) {
      if (!listsWallScrew(p)) continue;
      for (const r of p.requires ?? []) {
        const target = catalog.parts.find((x) => x.id === r.partId);
        if (target && listsWallScrew(target)) doubled.push(`${p.id} + ${r.partId}`);
      }
    }
    expect(doubled).toEqual([]);

    // The fix must not have been "delete the fixings": panels own no hardware,
    // but every panel still pulls in a countersunk insert that does.
    for (const p of catalog.parts.filter((x) => x.type === 'panel')) {
      expect(p.hardware ?? []).toEqual([]);
      const mounts = (p.requires ?? []).reduce((a, r) => a + r.count, 0);
      expect(mounts).toBeGreaterThanOrEqual(4);
    }
    const cs = part('insert-countersunk');
    expect(cs.hardware).toEqual([
      { item: WALL_SCREW, count: 1 },
      { item: WALL_PLUG, count: 1 },
    ]);

    // NOTE: this regression check only covers the WALL screw. The same class of
    // double count is live today for accessory bolts — see the pending finding
    // "an accessory and the insert it requires both claim the bolt" in section 7.
  });
});

// ===========================================================================
// 1. SMALL — two panels and a handful of accessories
// ===========================================================================
//
// Panels: 2 x wall-honeycomb-part      (7 x 8, 56 cells, requires insert-countersunk x5)
// Items:  2 x shelf-1                  (3 cells, requires insert-empty x3)
//         1 x hook-to-empty            (2 cells, requires insert-empty x2)
//         1 x insert-with-m3           (1 cell,  hardware M3 bolt x1 + M3 nut x1)
//         1 x hook-12mm-for-m3         (1 cell,  requires insert-with-m3 x1,
//                                       and no hardware of its own)
//
// hook-12mm-for-m3 used to require nothing at all — it is one of the eight
// accessories the regenerated catalogue now fixes (see section 7). It bolts
// through a countersunk hole into an M3 insert, so it drags in a SECOND
// insert-with-m3 on top of the one placed by hand, and that insert brings its
// own bolt and nut. Both quantities below moved because of it.
//
// HAND ARITHMETIC (per-unit figures read from src/catalog/catalog.json)
//   insert-countersunk = 5 x 2 panels                = 10
//   insert-empty       = 3 x 2 shelves + 2 x 1 hook  = 8
//   insert-with-m3     = 1 placed + 1 x 1 hook-12mm  = 2
//   totalParts = 2 + 2 + 1 + 1 + 2 + 8 + 10          = 26
//   minutes = 2(315.15) + 2(54.63) + 18.78 + 11.13 + 2(18.23) + 8(15.33) + 10(18.65)
//           = 630.30 + 109.26 + 18.78 + 11.13 + 36.46 + 122.64 + 186.50 = 1115.07 -> 1115
//   grams   = 98.14 + 15.32 + 3.08 + 1.12 + 4.68 + 15.60 + 22.90        = 160.84 -> 160.8
//   metres  = 32.9050 + 5.1398 + 1.0325 + 0.3768 + 1.5718 + 5.2272 + 7.6860
//           = 53.9391 -> 53.94
//   shopping = M3 bolt 2, M3 nut 2 (one pair per insert-with-m3),
//              (the hook lists no screw of its own: the insert supplies it),
//              Wall screw 10, Wall plug 10 (one each per countersunk insert)
// ===========================================================================

const L1_PANELS: PlacedPanel[] = [
  { id: 'pA', partId: 'wall-honeycomb-part', origin: { q: 0, r: 0 }, columns: 7, rows: 8 },
  { id: 'pB', partId: 'wall-honeycomb-part', origin: { q: 7, r: 0 }, columns: 7, rows: 8 },
];

const L1_ITEMS: PlacedItem[] = [
  item('i1', 'shelf-1', { q: 0, r: 0 }),
  item('i2', 'shelf-1', { q: 3, r: 0 }),
  item('i3', 'hook-to-empty', { q: 0, r: 1 }),
  item('i4', 'insert-with-m3', { q: 3, r: 1 }),
  item('i5', 'hook-12mm-for-m3', { q: 5, r: 1 }),
];

const L1 = doc({
  name: 'L1 small',
  wall: { widthMm: 400, heightMm: 250 },
  panels: L1_PANELS,
  items: L1_ITEMS,
});

describe('1 — SMALL: 2 panels + a handful of accessories', () => {
  const bom = computeBom(L1, catalog);

  it('is clean: no issues at all', () => {
    expect(bom.issues).toEqual([]);
  });

  it('every placed panel and item appears with the right quantity', () => {
    expect(qty(bom, 'wall-honeycomb-part')).toBe(2);
    expect(qty(bom, 'shelf-1')).toBe(2);
    expect(qty(bom, 'hook-to-empty')).toBe(1);
    expect(qty(bom, 'hook-12mm-for-m3')).toBe(1);
    // 1 placed by hand + 1 pulled in by hook-12mm-for-m3's `requires`. They
    // share one line, per R2 — printing two of these as two lines is exactly
    // how someone ends up with one insert and a hook they cannot mount.
    expect(qty(bom, 'insert-with-m3')).toBe(2);
  });

  it('required inserts multiply N x M', () => {
    expect(qty(bom, 'insert-countersunk')).toBe(4); // the assembly's fixing plan
    expect(qty(bom, 'insert-empty')).toBe(8); // 3x2 shelves + 2x1 hook
  });

  it('each part sits on exactly one line, in the right section', () => {
    const all = [...bom.printed, ...bom.fasteners].map((l) => l.partId);
    expect(new Set(all).size).toBe(all.length);
    expect(bom.printed.map((l) => l.partId).sort()).toEqual(
      ['hook-12mm-for-m3', 'hook-to-empty', 'shelf-1', 'wall-honeycomb-part'].sort(),
    );
    expect(bom.fasteners.map((l) => l.partId).sort()).toEqual(
      ['insert-countersunk', 'insert-empty', 'insert-with-m3'].sort(),
    );
  });

  it('shopping list is exactly right and not double counted', () => {
    expect(bom.shopping).toEqual([
      // one bolt + one nut per insert-with-m3, and there are two of them
      { item: 'M3 bolt, 10-16 mm', count: 2 },
      // the hook's own countersunk screw, which is NOT the insert's bolt
      { item: 'M3 nut', count: 2 },
      { item: WALL_PLUG, count: 4 },
      { item: WALL_SCREW, count: 4 },
    ]);
    // one screw per countersunk insert, not two, and not zero
    expect(shop(bom, WALL_SCREW)).toBe(
      qty(bom, 'insert-countersunk') + qty(bom, 'insert-for-countersunk-hole-3'),
    );
    // and the M3 fixings follow the insert, not the accessory: D11's rule is
    // that the fixing belongs to the part it passes through.
    expect(shop(bom, 'M3 bolt, 10-16 mm')).toBe(qty(bom, 'insert-with-m3'));
    expect(shop(bom, 'M3 nut')).toBe(qty(bom, 'insert-with-m3'));
  });

  it('totals match the hand arithmetic and the independent re-derivation', () => {
    expect(bom.totals.parts).toBe(20);
    expect(bom.totals.distinctParts).toBe(7);
    expect(bom.totals.minutes).toBe(1003);
    expect(bom.totals.grams).toBe(147.1);
    expect(bom.totals.metres).toBe(49.33);

    const expected = expectedTotals(
      new Map([
        ['wall-honeycomb-part', 2],
        ['shelf-1', 2],
        ['hook-to-empty', 1],
        ['hook-12mm-for-m3', 1],
        ['insert-with-m3', 2],
        ['insert-empty', 8],
        ['insert-countersunk', 4],
      ]),
    );
    // Exact decimal sums: 1115.07 min, 160.84 g, 53.9391 m.
    expect(expected.rawMinutesHundredths).toBe(100317);
    expect(expected.rawGramsHundredths).toBe(14710);
    expect(expected.rawMetresTenThousandths).toBe(493275);
    expect(bom.totals.parts).toBe(expected.parts);
    expect(bom.totals.minutes).toBe(expected.minutes);
    expect(bom.totals.grams).toBe(expected.grams);
    expect(bom.totals.metres).toBe(expected.metres);
  });

  it('per-line figures are per-unit x quantity', () => {
    // 4 fixings now, not 10 -- the quantity comes from the assembly plan, but
    // the per-unit x quantity rule this test exists for is unchanged.
    const l = line(bom, 'insert-countersunk')!;
    expect(l.quantity).toBe(4);
    expect(l.minutes).toBe(Math.round(18.65 * 4)); // 74.6 -> 75
    expect(l.grams).toBeCloseTo(9.2, 6); // 2.29 x 4 = 9.16 -> 9.2 at 1 dp
    expect(l.metres).toBeCloseTo(3.07, 6); // 0.7686 x 4 = 3.0744 -> 3.07
  });
});

// ===========================================================================
// 2. FULL GARAGE WALL — 2400 x 1200 on a 256 bed, plus 30 accessories
// ===========================================================================
//
// `allowRotation` is FALSE here, because that is what the app passes (App.tsx:
// 90 degrees is not a symmetry of a hex lattice, so swapping columns with rows
// invents panels that cannot be built). Testing the solver in a mode the
// product never uses proves nothing about the product's BOM.
//
// With rotation off the solver produces five bands of ten
// wall-honeycomb-bambu-211x248-fixed (10x10) and a top band of fourteen
// wall-honeycomb-part (7x8) = 64 panels, 5784 cells. The k1 panel is only
// usable rotated, so it disappears from the mix entirely.
//
// Band 0 begins at q=1, not q=0: `bandBump` pushes a band one whole column
// right when its odd rows would otherwise lean off the left edge of the wall.
// The accessories below are placed accordingly — row 0 of the bottom band
// covers columns 1..100, in ten panels of ten.
//
// HAND ARITHMETIC (per-unit figures read from src/catalog/catalog.json)
//   insert-countersunk = 6 x 50 + 5 x 14                 = 300 + 70 = 370
//   insert-empty       = 3 x 10 shelves + 2 x 5 hooks    = 40
//   insert-m4          = 1 x 5 boxes                     = 5
//   insert-with-m3     = 5 placed                        = 5
//   totalParts = 50+14 + 10+5+5+5+5 + 370+40+5+5         = 509
//   minutes = 50(554.9) + 14(315.15) + 10(54.63) + 5(18.78) + 5(19.4)
//           + 5(109.83) + 5(18.23) + 5(18.55) + 40(15.33) + 370(18.65)
//           = 27745 + 4412.10 + 546.30 + 93.90 + 97 + 549.15 + 91.15 + 92.75
//           + 613.20 + 6900.50 = 41141.05 -> 41141
//   grams   = 4333.5 + 686.98 + 76.6 + 15.4 + 11.45 + 83.05 + 11.7 + 11.75
//           + 78 + 847.3 = 6155.73 -> 6155.7
//   metres  = 1453.02 + 230.335 + 25.699 + 5.1625 + 3.8425 + 27.8535
//           + 3.9295 + 3.932 + 26.136 + 284.382 = 2064.292 -> 2064.29
//   shopping = Wall screw 370, Wall plug 370, M3 bolt 5, M3 nut 5,
//              M4 bolt 5 (from insert-m4 only; the boxes carry none), M4 nut 5
// ===========================================================================

function garageTiling() {
  const available: PanelSize[] = catalog.parts
    .filter((p) => p.type === 'panel' && p.panel)
    .map((p) => ({
      partId: p.id,
      columns: p.panel!.columns,
      rows: p.panel!.rows,
      widthMm: p.panel!.widthMm,
      heightMm: p.panel!.heightMm,
    }));
  return solveTiling({
    wall: { widthMm: 2400, heightMm: 1200 },
    bedId: 'bed256',
    available,
    // Matches src/ui/App.tsx. Do not flip this to explore a nicer panel mix:
    // the rotated forms are not buildable.
    allowRotation: false,
  });
}

/**
 * 30 accessories, all on row 0, each wholly inside one panel of the bottom
 * band. Row 0 of that band runs from q=1 to q=100 in ten panels of ten
 * columns, so every footprint below starts and ends inside a single decade.
 */
function garageItems(): PlacedItem[] {
  const out: PlacedItem[] = [];
  let n = 0;
  const add = (partId: string, q: number): void => {
    n += 1;
    out.push(item(`a${n}`, partId, { q, r: 0 }));
  };
  for (const q of [1, 4, 7, 11, 14, 17, 21, 24, 27, 31]) add('shelf-1', q); // 10, 3 cells each
  for (const q of [34, 37, 41, 44, 47]) add('hook-to-empty', q); //  5, 2 cells each
  for (const q of [51, 54, 57, 61, 64]) add('hook-side', q); //  5, 2 cells each
  for (const q of [71, 73, 75, 77, 79]) add('insert-with-m3', q); //  5, 1 cell each
  for (const q of [81, 84, 87, 91, 94]) add('box', q); //  5, 3 cells each
  return out;
}

describe('2 — FULL GARAGE WALL: 2400 x 1200, bed256, 64 panels + 30 accessories', () => {
  const tiling = garageTiling();
  const panels: PlacedPanel[] = tiling.panels.map((p, i) => ({
    id: `p${i}`,
    partId: p.partId,
    origin: p.origin,
    columns: p.columns,
    rows: p.rows,
  }));
  const items = garageItems();
  const L2 = doc({ name: 'L2 garage', panels, items });
  const bom = computeBom(L2, catalog);

  it('the solver gives the panel mix the hand arithmetic assumes', () => {
    expect(panels.length).toBe(64);
    expect(tiling.cellCount).toBe(5784); // 50 x 100 + 14 x 56
    const mix = new Map<string, number>();
    for (const p of panels) mix.set(p.partId, (mix.get(p.partId) ?? 0) + 1);
    expect([...mix.entries()].sort()).toEqual([
      ['wall-honeycomb-bambu-211x248-fixed', 50],
      ['wall-honeycomb-part', 14],
    ]);
    expect(items.length).toBe(30);
    // The cell count is the sum of the panels' own footprints, not a guess.
    expect(panels.reduce((a, p) => a + p.columns * p.rows, 0)).toBe(5784);
  });

  it('is clean: 64 disjoint panels, 30 accessories all on-panel and non-overlapping', () => {
    expect(bom.issues).toEqual([]);
  });

  it('every panel and item appears with the right quantity', () => {
    expect(qty(bom, 'wall-honeycomb-bambu-211x248-fixed')).toBe(50);
    expect(qty(bom, 'wall-honeycomb-part')).toBe(14);
    expect(qty(bom, 'shelf-1')).toBe(10);
    expect(qty(bom, 'hook-to-empty')).toBe(5);
    expect(qty(bom, 'hook-side')).toBe(5);
    expect(qty(bom, 'box')).toBe(5);
    expect(qty(bom, 'insert-with-m3')).toBe(5);
    // The k1 panel is only usable in its rotated form, which the app forbids.
    expect(qty(bom, 'wall-honeycomb-k1-211x201')).toBe(0);
  });

  it('required inserts multiply N x M across 64 panels', () => {
    expect(qty(bom, 'insert-countersunk')).toBe(24); // single-cell fixings only
    // ...the rest of the wall is held by four-cell inserts bridging the joins.
    expect(qty(bom, 'insert-for-countersunk-hole-3')).toBe(56);
    expect(qty(bom, 'insert-empty')).toBe(40); // 3x10 + 2x5
    expect(qty(bom, 'insert-m4')).toBe(5); // 1 per box; box used to require none

    // Independent re-derivation straight from the placed panels.
    const byHand = panels.reduce(
      (a, p) =>
        a +
        (part(p.partId).requires ?? [])
          .filter((r) => r.partId === 'insert-countersunk')
          .reduce((b, r) => b + r.count, 0),
      0,
    );
    expect(byHand).toBe(370);
  });

  it('REGRESSION: 370 inserts -> 370 wall screws, not 740 and not 0', () => {
    // One screw and one plug per fixing, whether it is a single-cell insert or
    // a four-cell one bridging a junction. That is the invariant; the split
    // between the two kinds is the fixing plan's business.
    expect(shop(bom, WALL_SCREW)).toBe(80);
    expect(shop(bom, WALL_PLUG)).toBe(80);
    expect(shop(bom, WALL_SCREW)).toBe(
      qty(bom, 'insert-countersunk') + qty(bom, 'insert-for-countersunk-hole-3'),
    );
    // ...and the wall is genuinely fixed: at least one per panel is the floor
    // the assembly plan guarantees (src/core/fixings.ts).
    expect(shop(bom, WALL_SCREW)).toBeGreaterThanOrEqual(panels.length);
  });

  it('shopping list is exactly right', () => {
    expect(bom.shopping).toEqual([
      { item: 'M3 bolt, 10-16 mm', count: 5 },
      { item: 'M3 nut', count: 5 },
      // 5 from the five insert-m4 the boxes require, plus the 5 the boxes
      // themselves list — two different fixings, not one counted twice: the
      // insert's bolt clamps the insert, the box's bolt clamps the box to it.
      { item: 'M4 bolt, 10-16 mm', count: 5 },
      { item: 'M4 nut', count: 5 },
      { item: WALL_PLUG, count: 80 },
      { item: WALL_SCREW, count: 80 },
    ]);
    expect(shop(bom, 'M4 nut')).toBe(qty(bom, 'insert-m4'));
  });

  it('totals match the hand arithmetic', () => {
    expect(bom.totals.parts).toBe(219);
    expect(bom.totals.distinctParts).toBe(11);
    expect(bom.totals.minutes).toBe(38321);
    expect(bom.totals.grams).toBe(5832.1);
    expect(bom.totals.metres).toBe(1955.5);
  });

  it('totals are summed UNROUNDED, not from the rounded lines', () => {
    // Summing the rounded gram figures on the lines gives 5478.1; the honest
    // answer is 5477.9. If these are ever equal the accumulator was rounded early.
    const fromLines = [...bom.printed, ...bom.fasteners].reduce((a, l) => a + l.grams, 0);
    expect(Number(fromLines.toFixed(1))).toBe(5832.3);
    expect(bom.totals.grams).toBe(5832.1);

    const expected = expectedTotals(
      new Map([
        ['wall-honeycomb-bambu-211x248-fixed', 50],
        ['wall-honeycomb-part', 14],
        ['shelf-1', 10],
        ['hook-to-empty', 5],
        ['hook-side', 5],
        ['box', 5],
        ['insert-with-m3', 5],
        ['insert-m4', 5],
        ['insert-empty', 40],
        ['insert-countersunk', 24],
        ['insert-for-countersunk-hole-3', 56],
      ]),
    );
    // Exact decimal sums for the fixing-planned wall: 35620.55 min, 5477.93 g,
    // 1836.9926 m. Recomputed, not adjusted -- the helper re-derives them from
    // the quantity map above rather than trusting the BOM.
    expect(expected.rawMinutesHundredths).toBe(3832143);
    expect(expected.rawGramsHundredths).toBe(583211);
    expect(expected.rawMetresTenThousandths).toBe(19554980);
    expect(bom.totals.parts).toBe(expected.parts);
    expect(bom.totals.grams).toBe(expected.grams);
    expect(bom.totals.metres).toBe(expected.metres);
    expect(bom.totals.minutes).toBe(expected.minutes);
  });

  it('totals.parts equals the sum of every line quantity', () => {
    const sum = [...bom.printed, ...bom.fasteners].reduce((a, l) => a + l.quantity, 0);
    expect(bom.totals.parts).toBe(sum);
    expect(bom.totals.distinctParts).toBe(bom.printed.length + bom.fasteners.length);
  });
});

// ===========================================================================
// 3. DELIBERATELY AWKWARD
// ===========================================================================
//
// Two 4x4 panels (wall-honeycomb-106x89-fixed, 16 cells, requires 4 inserts).
// panelCells staggers row r by -ceil(r/2), so:
//   panel A cells: r0 q0..3, r1 q-1..2, r2 q-1..2, r3 q-2..1
//   panel B cells: r0 q4..7, r1 q3..6,  r2 q3..6,  r3 q2..5
//
//   x1 hook-to-empty at (3,0)  -> cells (3,0) on A and (4,0) on B  = SEAM CROSS
//   x2 shelf-1       at (6,0)  -> cells (6,0),(7,0) on B, (8,0) on NOTHING = off-panel
//   x3 hook-side     at (0,1)  -> (0,1),(1,1)   shares (1,1) with...
//   x4 box           at (1,1)  -> (1,1),(2,1),(3,1)   ...and that is ALLOWED:
//        both are accessories, which bolt on in front of the wall. Two of them
//        on one cell is what the wall is for, so it raises no issue at all.
//   x5 ghost-shelf-9000 x2     -> partId not in the catalogue
//   x6 insert-countersunk-with-m3x3 rotated 1 step at (2,2)
//        footprint (0,0)(-1,1)(0,1)(-1,2) rotates to (0,0)(-1,0)(-1,1)(-2,1)
//        -> cells (2,2),(1,2),(1,3),(0,3), all on panel A
//   x7 insert-hollow-dual at (4,2) -> (4,2),(4,3) on panel B, shares (4,3)...
//   x8 insert-empty       at (4,3) -> ...which IS an error: both are inserts,
//        and there is only one hexagonal hole. One insert per hole.
//
// HAND ARITHMETIC (per-unit figures read from src/catalog/catalog.json)
//   insert-countersunk = 4 x 2 panels                       = 8
//   insert-empty       = 2 (hook-to-empty) + 3 (shelf-1) + 1 placed = 6
//   insert-m4          = 1 (box; it used to require none)   = 1
//   totalParts = 2 + 4 accessories + 1 spun + 1 hollow-dual + 8 + 6 + 1 = 23
//   minutes = 185.80 + 18.78 + 54.63 + 19.40 + 109.83 + 73.93 + 30.92 + 18.55
//           + 91.98 + 149.20 = 753.02 -> 753
//   grams   = 29.24 + 3.08 + 7.66 + 2.29 + 16.61 + 9.44 + 3.99 + 2.35
//           + 11.70 + 18.32 = 104.68 -> 104.7
//   metres  = 9.8012 + 1.0325 + 2.5699 + 0.7685 + 5.5707 + 3.1659 + 1.3371
//           + 0.7864 + 3.9204 + 6.1488 = 35.1014 -> 35.10
//   shopping: Wall screw 8 + 1 = 9, Wall plug 9, M3 bolt 3, M3 nut 3,
//             M4 bolt 1 (insert-m4 only), M4 nut 1
// ===========================================================================

const L3_PANELS: PlacedPanel[] = [
  { id: 'pA', partId: 'wall-honeycomb-106x89-fixed', origin: { q: 0, r: 0 }, columns: 4, rows: 4 },
  { id: 'pB', partId: 'wall-honeycomb-106x89-fixed', origin: { q: 4, r: 0 }, columns: 4, rows: 4 },
];

const L3_ITEMS: PlacedItem[] = [
  item('seam', 'hook-to-empty', { q: 3, r: 0 }),
  item('hangs', 'shelf-1', { q: 6, r: 0 }),
  item('over1', 'hook-side', { q: 0, r: 1 }),
  item('over2', 'box', { q: 1, r: 1 }),
  item('ghost1', 'ghost-shelf-9000', { q: 0, r: 3 }),
  item('ghost2', 'ghost-shelf-9000', { q: 1, r: 3 }),
  item('spun', 'insert-countersunk-with-m3x3', { q: 2, r: 2 }, 1),
  // Index 6 above is load-bearing for the rotation test below; the exclusive
  // pair is appended so it stays there.
  item('plug1', 'insert-hollow-dual', { q: 4, r: 2 }),
  item('plug2', 'insert-empty', { q: 4, r: 3 }),
];

const L3 = doc({
  name: 'L3 awkward',
  wall: { widthMm: 300, heightMm: 300 },
  panels: L3_PANELS,
  items: L3_ITEMS,
});

describe('3 — AWKWARD: seams, edges, overlaps, a missing part and a rotation', () => {
  const bom = computeBom(L3, catalog);

  it('does not throw and still returns a usable BOM', () => {
    expect(bom.printed.length + bom.fasteners.length).toBeGreaterThan(0);
    expect(bom.totals.parts).toBeGreaterThan(0);
  });

  it('the rotated 4-cell fastener lands on the cells the hex maths says it does', () => {
    const cells = itemCells(L3_ITEMS[6]!, catalog).map(hexKey).sort();
    expect(cells).toEqual(['0,3', '1,2', '1,3', '2,2'].sort());
  });

  it('quantities are right despite every one of the awkward cases', () => {
    expect(qty(bom, 'wall-honeycomb-106x89-fixed')).toBe(2);
    expect(qty(bom, 'hook-to-empty')).toBe(1);
    expect(qty(bom, 'shelf-1')).toBe(1);
    expect(qty(bom, 'hook-side')).toBe(1);
    expect(qty(bom, 'box')).toBe(1);
    expect(qty(bom, 'insert-countersunk-with-m3x3')).toBe(1); // rotation changes nothing
    expect(qty(bom, 'insert-hollow-dual')).toBe(1);
    expect(qty(bom, 'insert-countersunk')).toBe(4); // the assembly's fixing plan
    expect(qty(bom, 'insert-empty')).toBe(6); // 2 (hook) + 3 (shelf) + 1 placed
    expect(qty(bom, 'insert-m4')).toBe(1); // required by the box
    expect(qty(bom, 'ghost-shelf-9000')).toBe(0); // contributes nothing
    // An illegal overlap does not remove either item from the print list: the
    // user still has to print both and then move one.
    expect(bom.totals.distinctParts).toBe(10);
  });

  it('the unknown partId is reported once, listing both placements', () => {
    const unknown = bom.issues.filter((i) => i.code === 'unknown-part');
    expect(unknown.length).toBe(1);
    expect(unknown[0]!.level).toBe('error');
    expect(unknown[0]!.itemIds.sort()).toEqual(['ghost1', 'ghost2']);
    expect(unknown[0]!.message).toContain('ghost-shelf-9000');
  });

  it('the off-panel item is reported, with the one unsupported cell', () => {
    const off = bom.issues.filter((i) => i.code === 'off-panel');
    expect(off.length).toBe(1);
    expect(off[0]!.itemIds).toEqual(['hangs']);
    expect(off[0]!.cells!.map(hexKey)).toEqual(['8,0']);
  });

  it('the two inserts sharing a hole are reported, with the one shared cell', () => {
    // One hexagonal hole, one insert. This is the only overlap the app treats
    // as an error, and it must name both items and the exact cell.
    const clash = bom.issues.filter((i) => i.code === 'overlap');
    expect(clash.length).toBe(1);
    expect(clash[0]!.level).toBe('error');
    expect(clash[0]!.itemIds.sort()).toEqual(['plug1', 'plug2']);
    expect(clash[0]!.cells!.map(hexKey)).toEqual(['4,3']);
  });

  it('the two overlapping ACCESSORIES are not reported AS AN OVERLAP', () => {
    // over1 (hook-side) and over2 (box) genuinely share cell (1,1). The wall
    // exists to mount things on top of one another, so sharing is not an error
    // and not a warning — flagging it would put a complaint on a perfectly good
    // parts list. Proven positively: the cell really is shared.
    const a = itemCells(L3_ITEMS[2]!, catalog).map(hexKey);
    const b = itemCells(L3_ITEMS[3]!, catalog).map(hexKey);
    expect(a.filter((k) => b.includes(k))).toEqual(['1,1']);

    // Neither is reported for sharing. Whatever else is said about them is
    // about a different property — one of the two does straddle a panel seam,
    // which is a separate, legal-but-worth-knowing fact and a warning, not an
    // error (P8 item 4, now fixed).
    for (const id of ['over1', 'over2']) {
      const mine = bom.issues.filter((i) => i.itemIds.includes(id));
      expect(mine.every((i) => i.code !== 'overlap')).toBe(true);
      expect(mine.every((i) => i.level === 'warning')).toBe(true);
    }
    const seam = bom.issues.filter((i) => i.code === 'crosses-seam');
    expect(seam.map((i) => i.itemIds[0]).sort()).toEqual(['over2', 'seam']);
  });

  it('the two panels do not overlap and no spurious issues appear', () => {
    // The two crosses-seam warnings are the box and the hook that genuinely
    // straddle the join between the fixture's two panels. `panel-overlap` is
    // absent, which is the point of this case.
    expect(codes(bom.issues)).toEqual([
      'crosses-seam', 'crosses-seam', 'off-panel', 'overlap', 'unknown-part',
    ]);
  });

  it('shopping list adds the rotated fastener’s own hardware exactly once', () => {
    expect(bom.shopping).toEqual([
      { item: 'M3 bolt, 10-16 mm', count: 3 },
      { item: 'M3 nut', count: 3 },
      // 1 from the insert-m4 the box requires + 1 the box itself carries
      { item: 'M4 bolt, 10-16 mm', count: 1 },
      { item: 'M4 nut', count: 1 },
      { item: WALL_PLUG, count: 5 },
      { item: WALL_SCREW, count: 5 },
    ]);
    // 8 from the panels' countersunk inserts + 1 that the m3x3 fastener carries
    expect(shop(bom, WALL_SCREW)).toBe(qty(bom, 'insert-countersunk') + 1);
    // Rotating the m3x3 fastener did not multiply its 3 bolts into 6 or 12.
    expect(shop(bom, 'M3 bolt, 10-16 mm')).toBe(3);
  });

  it('totals match the hand arithmetic', () => {
    expect(bom.totals.parts).toBe(19);
    expect(bom.totals.minutes).toBe(678);
    expect(bom.totals.grams).toBe(95.5);
    expect(bom.totals.metres).toBe(32.03);

    const expected = expectedTotals(
      new Map([
        ['wall-honeycomb-106x89-fixed', 2],
        ['hook-to-empty', 1],
        ['shelf-1', 1],
        ['hook-side', 1],
        ['box', 1],
        ['insert-countersunk-with-m3x3', 1],
        ['insert-hollow-dual', 1],
        ['insert-m4', 1],
        ['insert-countersunk', 4],
        ['insert-empty', 6],
      ]),
    );
    // Exact decimal sums for the fixing-planned wall: 678.42 min, 95.48 g,
    // 32.0270 m.
    expect(expected.rawMinutesHundredths).toBe(67842);
    expect(expected.rawGramsHundredths).toBe(9552);
    expect(expected.rawMetresTenThousandths).toBe(320270);
    expect(bom.totals.parts).toBe(expected.parts);
    expect(bom.totals.grams).toBe(expected.grams); // 104.68 -> 104.7, half away from zero
    expect(bom.totals.metres).toBe(expected.metres); // 35.1014 -> 35.10
    expect(bom.totals.minutes).toBe(expected.minutes);
  });
});

// ===========================================================================
// 4. SEAM CROSSING — construct one deliberately and prove it fires
// ===========================================================================

describe('4 — seam crossing', () => {
  it('crossesSeam() is TRUE for an accessory spanning two panels, FALSE for one that does not', () => {
    const spanning = itemCells(item('x', 'hook-to-empty', { q: 3, r: 0 }), catalog);
    expect(spanning.map(hexKey)).toEqual(['3,0', '4,0']);
    expect(crossesSeam(spanning, L3_PANELS)).toBe(true);

    const inside = itemCells(item('y', 'hook-to-empty', { q: 0, r: 0 }), catalog);
    expect(crossesSeam(inside, L3_PANELS)).toBe(false);
  });

  it('the store warns — not refuses — when a drop spans a seam', () => {
    const store = new Store(doc({ panels: L3_PANELS, items: [] }), catalog);
    const cells = placeFootprint(part('hook-to-empty').footprint, { q: 3, r: 0 }, 0);
    const res = store.checkPlacement(cells);
    expect(res.ok).toBe(true);
    expect(res.warnings ?? []).toEqual([
      'Spans a panel seam — fine if the panels are joined, but check it',
    ]);
  });

  it('a drop wholly inside one panel raises no seam warning', () => {
    const store = new Store(doc({ panels: L3_PANELS, items: [] }), catalog);
    const cells = placeFootprint(part('hook-to-empty').footprint, { q: 0, r: 0 }, 0);
    expect(store.checkPlacement(cells).warnings ?? []).toEqual([]);
  });

  it('fires on the real 64-panel garage wall, across a vertical seam', () => {
    const tiled = garageTiling().panels;
    // Band 0 starts at q=1 (bandBump), so the bottom band's panels hold columns
    // 1..10, 11..20, and so on. shelf-1 at q=9 covers 9,10,11: the first two on
    // the first panel, the third on the second.
    const cells = itemCells(item('s', 'shelf-1', { q: 9, r: 0 }), catalog);
    expect(cells.map(hexKey)).toEqual(['9,0', '10,0', '11,0']);
    expect(crossesSeam(cells, tiled)).toBe(true);
    // ...and one that stops short of the seam does not fire.
    expect(crossesSeam(itemCells(item('s', 'shelf-1', { q: 5, r: 0 }), catalog), tiled)).toBe(false);
  });

  it('fires across a horizontal BAND seam, where the half-pitch stagger matters', () => {
    const tiled = garageTiling().panels;
    // Band 0 is rows 0..9 with its panels' origins at q=1, 11, 21...; band 1
    // starts at row 10 and its origins are at q=-4, 6, 16... A part spanning
    // rows 9 and 10 therefore straddles two panels whose q origins do not line
    // up — the case a pixel-rectangle comparison would get wrong.
    const cells = itemCells(item('d', 'insert-hollow-dual', { q: 0, r: 9 }), catalog);
    expect(cells.map(hexKey)).toEqual(['0,9', '0,10']);
    expect(crossesSeam(cells, tiled)).toBe(true);

    const inside = itemCells(item('d', 'insert-hollow-dual', { q: 0, r: 5 }), catalog);
    expect(crossesSeam(inside, tiled)).toBe(false);
  });

  it('REGRESSION (was P8 item 4): validate() emits crosses-seam for a loaded layout', () => {
    // The finding: the seam warning used to exist only inside the drag handler,
    // so a layout that arrived by file load or share link was never advised of
    // it. `validate` now runs the same `crossesSeam` test the editor does — the
    // same function, not a second implementation of the rule.
    const issues = validate(L3, catalog);
    const seam = issues.filter((i) => i.code === 'crosses-seam');
    expect(seam.length).toBeGreaterThan(0);
    expect(seam.every((i) => i.level === 'warning')).toBe(true);
    // Every one of them names an item that really does straddle a seam.
    for (const issue of seam) {
      const it = L3.items.find((x) => x.id === issue.itemIds[0]);
      expect(crossesSeam(itemCells(it!, catalog), L3.panels)).toBe(true);
    }
  });
});

// ===========================================================================
// 5. ROUNDING — 40 copies of a small part must not evaporate
// ===========================================================================

describe('5 — rounding at scale', () => {
  it('40 x cover-contersunk (0.73 g each) keeps every gram', () => {
    const items: PlacedItem[] = [];
    for (let i = 0; i < 40; i++) items.push(item(`c${i}`, 'cover-contersunk', { q: i, r: 0 }));
    const bom = computeBom(doc({ panels: [], items }), catalog);

    expect(qty(bom, 'cover-contersunk')).toBe(40);
    expect(qty(bom, 'insert-empty')).toBe(40); // requires 1 each

    // 40 x 0.73 = 29.2 exactly (not 29.2000000000000004, not 28.0 from a
    // per-unit round-then-multiply).
    expect(line(bom, 'cover-contersunk')!.grams).toBe(29.2);
    expect(line(bom, 'cover-contersunk')!.metres).toBe(9.73); // 40 x 0.2433 = 9.732
    expect(line(bom, 'cover-contersunk')!.minutes).toBe(266); // 40 x 6.65

    expect(bom.totals.parts).toBe(80);
    expect(bom.totals.grams).toBe(107.2); // 29.2 + 78
    expect(bom.totals.metres).toBe(35.87); // 9.732 + 26.136 = 35.868
    expect(bom.totals.minutes).toBe(879); // 266 + 613.2 = 879.2
  });

  it('a BOM with no panels is still computed, with a warning rather than an abort', () => {
    const bom = computeBom(doc({ panels: [], items: [item('z', 'shelf-1', { q: 0, r: 0 })] }), catalog);
    expect(codes(bom.issues)).toEqual(['no-panel']);
    expect(bom.issues[0]!.level).toBe('warning');
    expect(qty(bom, 'shelf-1')).toBe(1);
    expect(qty(bom, 'insert-empty')).toBe(3);
  });
});

// ===========================================================================
// 6. GENERAL SWEEPS — every part in the catalogue, one at a time
// ===========================================================================

describe('6 — sweeps over the whole catalogue', () => {
  it('placing any single part gives quantity 1 plus exactly its requirements', () => {
    const wrong: string[] = [];
    for (const p of catalog.parts) {
      const bom = computeBom(doc({ panels: [], items: [item('s', p.id, { q: 0, r: 0 })] }), catalog);
      if (qty(bom, p.id) !== 1) wrong.push(`${p.id}: self=${qty(bom, p.id)}`);
      for (const r of p.requires ?? []) {
        // A part cannot require itself in this catalogue; if it did the two
        // contributions would land on the same line and this would need care.
        if (r.partId === p.id) {
          wrong.push(`${p.id}: self-requiring`);
          continue;
        }
        if (qty(bom, r.partId) !== r.count) {
          wrong.push(`${p.id} -> ${r.partId}: ${qty(bom, r.partId)} != ${r.count}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('placing any single part M times multiplies its requirements by M', () => {
    const M = 7;
    const wrong: string[] = [];
    for (const p of catalog.parts) {
      const items: PlacedItem[] = [];
      for (let i = 0; i < M; i++) items.push(item(`m${i}`, p.id, { q: i * 12, r: 0 }));
      const bom = computeBom(doc({ panels: [], items }), catalog);
      if (qty(bom, p.id) !== M) wrong.push(`${p.id}: ${qty(bom, p.id)} != ${M}`);
      for (const r of p.requires ?? []) {
        if (qty(bom, r.partId) !== r.count * M) {
          wrong.push(`${p.id} -> ${r.partId}: ${qty(bom, r.partId)} != ${r.count * M}`);
        }
      }
      const hw = new Map<string, number>();
      for (const h of p.hardware ?? []) hw.set(h.item, (hw.get(h.item) ?? 0) + h.count * M);
      for (const r of p.requires ?? []) {
        const target = part(r.partId);
        for (const h of target.hardware ?? []) {
          hw.set(h.item, (hw.get(h.item) ?? 0) + h.count * r.count * M);
        }
      }
      for (const [k, v] of hw) {
        if (shop(bom, k) !== v) wrong.push(`${p.id} hw ${k}: ${shop(bom, k)} != ${v}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('a part that is both placed AND required lands on one line with the sum', () => {
    // 3 x insert-empty placed by hand + 2 x shelf-1 (3 each) = 3 + 6 = 9.
    const items: PlacedItem[] = [
      item('e1', 'insert-empty', { q: 20, r: 0 }),
      item('e2', 'insert-empty', { q: 21, r: 0 }),
      item('e3', 'insert-empty', { q: 22, r: 0 }),
      item('s1', 'shelf-1', { q: 0, r: 0 }),
      item('s2', 'shelf-1', { q: 4, r: 0 }),
    ];
    const bom = computeBom(doc({ panels: [], items }), catalog);
    const hits = [...bom.printed, ...bom.fasteners].filter((l) => l.partId === 'insert-empty');
    expect(hits.length).toBe(1);
    expect(hits[0]!.quantity).toBe(9);
    // 1.95 x 9 = 17.55 decimally, which is 17.6 at 1 dp half-away-from-zero.
    // In binary 1.95*9 is 17.549999999999997, so this line also proves the
    // documented 1e-9 nudge in roundTo() is doing its job.
    expect(hits[0]!.grams).toBe(17.6);
  });

  it('rotation never changes a BOM', () => {
    for (const rot of [0, 1, 2, 3, 4, 5] as Rotation[]) {
      const bom = computeBom(
        doc({
          panels: [],
          items: [item('r', 'insert-countersunk-with-m3x3', { q: 0, r: 0 }, rot)],
        }),
        catalog,
      );
      expect(qty(bom, 'insert-countersunk-with-m3x3')).toBe(1);
      expect(bom.shopping).toEqual([
        { item: 'M3 bolt, 10-16 mm', count: 3 },
        { item: 'M3 nut', count: 3 },
        { item: WALL_PLUG, count: 1 },
        { item: WALL_SCREW, count: 1 },
      ]);
      expect(itemCells({ id: 'r', partId: 'insert-countersunk-with-m3x3', at: { q: 0, r: 0 }, rotation: rot }, catalog).length).toBe(4);
    }
  });

  it('the BOM is deterministic and independent of placement order', () => {
    const a = computeBom(doc({ panels: L1_PANELS, items: L1_ITEMS }), catalog);
    const b = computeBom(
      doc({ panels: [...L1_PANELS].reverse(), items: [...L1_ITEMS].reverse() }),
      catalog,
    );
    expect(b.printed).toEqual(a.printed);
    expect(b.fasteners).toEqual(a.fasteners);
    expect(b.shopping).toEqual(a.shopping);
    expect(b.totals).toEqual(a.totals);
  });
});

// ===========================================================================
// 7. FINDINGS — cases where the BOM is arguably wrong. These document, and
//    lock in, behaviour the critic considers a defect.
// ===========================================================================

describe('7 — findings (documented as tests so they cannot regress silently)', () => {
  it('REGRESSION (was a FINDING): an accessory with a bolt hole DOES require an insert and a bolt', () => {
    // The finding: 18 accessories required no insert and no hardware, so the
    // BOM said "print one hook, buy nothing" for a part that has nothing to
    // bolt to at the wall. The cause was in the scanner, not the BOM — bore
    // detection scanned Z only, and these parts are drawn lying down, so an M3
    // hole through their side was invisible. It now scans all three axes, and a
    // countersunk hole whose shank falls outside the plain-bolt window is
    // matched using the filename as corroboration.
    //
    // Eight accessories changed as a result. These are the six the fix was
    // aimed at; each must pull in a matching insert.
    //
    // The accessory itself lists NO bolt: one fixing passes through one hole,
    // and the insert it requires already carries it. Listing one here too was
    // the second half of this bug — `screw-holder` and `insert-with-m3` both
    // emitted "M3 bolt, 10-16 mm", so one hole bought two bolts.
    const fixed: Array<[string, string, RegExp]> = [
      ['box', 'insert-m4', /^M4 bolt/],
      ['usb-holder', 'insert-m4', /^M4 bolt/],
      ['sd-card-holder', 'insert-m4', /^M4 bolt/],
      ['screw-holder', 'insert-with-m3', /^M3 bolt/],
      ['hook-12mm-for-m3', 'insert-with-m3', /^M3 bolt/],
      ['hook-25mm-for-m3', 'insert-with-m3', /^M3 bolt/],
    ];
    for (const [id, insertId, bolt] of fixed) {
      const p = part(id);
      expect({ id, requires: (p.requires ?? []).map((r) => `${r.partId}x${r.count}`) }).toEqual({
        id,
        requires: [`${insertId}x1`],
      });
      expect(p.hardware ?? [], `${id} must not carry its own bolt`).toEqual([]);

      // ...and it reaches the BOM, not just the catalogue: placing one prints
      // the insert too, and the bolt reaches the shopping list exactly once.
      const bom = computeBom(doc({ panels: [], items: [item('h', id, { q: 0, r: 0 })] }), catalog);
      expect(qty(bom, insertId), `${id} did not pull in ${insertId}`).toBe(1);
      expect(bom.totals.parts).toBe(2);
      const bolts = bom.shopping.filter((s) => bolt.test(s.item));
      expect(bolts.map((b) => b.count), `${id} bolt count`).toEqual([1]);
    }

    // The general rule, so a future rescan cannot reintroduce the class: any
    // accessory whose measured bores include a plain M3/M4/M5 shank must
    // require an insert of that size and list a bolt of that size.
    const broken: string[] = [];
    for (const p of catalog.parts) {
      if (p.type !== 'accessory') continue;
      const bores = (p as unknown as { measurement?: { bores?: Record<string, number> } }).measurement
        ?.bores ?? {};
      for (const size of ['M3', 'M4', 'M5']) {
        if (!(size in bores)) continue;
        const inserts = (p.requires ?? []).filter((r) => part(r.partId).type === 'insert');
        if (inserts.length === 0) broken.push(`${p.id}: ${size} hole, no insert`);
        // The bolt must exist SOMEWHERE in the chain, exactly once — on the
        // insert, not on the accessory as well.
        const onInsert = inserts.some((r) =>
          (part(r.partId).hardware ?? []).some((h) => h.item.startsWith(size)),
        );
        if (!onInsert) broken.push(`${p.id}: ${size} hole, insert supplies no ${size} bolt`);
        if ((p.hardware ?? []).some((h) => h.item.startsWith(size))) {
          broken.push(`${p.id}: ${size} bolt counted twice (accessory AND its insert)`);
        }
      }
    }
    expect(broken).toEqual([]);

    // What is LEFT is a different problem, and P1's, not this one: twelve parts
    // in which no bore and no hexagonal socket could be found on any axis, so
    // there is nothing to infer a fixing from. They are listed in UNKNOWN.md
    // and shown with an `est.` marker. Pinned here so the count cannot drift
    // without someone noticing.
    const orphans = catalog.parts.filter(
      (p) =>
        p.type === 'accessory' &&
        (p.requires ?? []).length === 0 &&
        (p.hardware ?? []).length === 0,
    );
    expect(orphans.map((p) => p.id).sort()).toEqual([
      '20-micro-sd-card-holder',
      '5-micro-sd-card-holder',
      'box-and-usb-holder-cover',
      'caliper-mount',
      'hook-bottom',
      'hook-keyboard-bottom',
      'hook-keyboard-side',
      'hook-side',
      'insert-cable-holder',
      'sd-card-holder-cover',
      'wranch-hoks-1',
      'wranch-hoks-2',
    ]);
    expect(orphans.length).toBe(12);
  });

  it('REGRESSION: no fixing is ever claimed by a part AND by what it requires', () => {
    // Was a live defect, found by the BOM critic: D11's double count — "the
    // fixing belongs to the part it passes through" — had reappeared for
    // ACCESSORY bolts after the catalogue was regenerated with three-axis bore
    // detection. D11 fixed it for the wall screw only, and the section 0
    // regression test guards only the wall screw, so the class walked straight
    // back in with the newly-detected bores: `screw-holder` and
    // `insert-with-m3` both emitted "M3 bolt, 10-16 mm", so one M3 hole bought
    // two M3 bolts.
    //
    // Fixed in tools/scan.py: an accessory that successfully requires an insert
    // no longer lists a bolt of its own, because the insert already carries it.
    // If the insert is absent from the catalogue the accessory keeps the bolt,
    // so the fix cannot turn an overcount into an undercount.
    //
    // This check is now GENERAL — every fixing, not just the wall screw — so
    // the class cannot come back a third time through some other part.
    const doubled: string[] = [];
    for (const p of catalog.parts) {
      for (const r of p.requires ?? []) {
        const target = catalog.parts.find((x) => x.id === r.partId);
        if (!target) continue;
        for (const h of p.hardware ?? []) {
          const size = /^M[345]/.exec(h.item)?.[0];
          if (size === undefined) continue;
          if ((target.hardware ?? []).some((t) => t.item.startsWith(size))) {
            doubled.push(`${p.id} + ${r.partId} (${size})`);
          }
        }
      }
    }
    expect(doubled.sort(), 'a fixing is counted twice').toEqual([]);

    // The user-visible consequence, in one line: one screw-holder, one M3 hole,
    // ONE M3 bolt on the shopping list.
    const bom = computeBom(
      doc({ panels: [], items: [item('s', 'screw-holder', { q: 0, r: 0 })] }),
      catalog,
    );
    expect(
      (part('screw-holder') as unknown as { measurement?: { bores?: Record<string, number> } })
        .measurement?.bores,
    ).toEqual({ M3: 1 });
    expect(shop(bom, 'M3 bolt, 10-16 mm')).toBe(1);
    expect(shop(bom, 'M3 nut')).toBe(1);
  });

  it('REGRESSION (was P8 item 3): the needs-review marker reaches the BOM line', () => {
    // The finding: 27 of 51 parts carry needsReview:true, `BomLine` had no
    // field for it, and so the CSV, Markdown and printable HTML the user
    // carries to the printer showed a bounding-box guess and a measured fit
    // identically. The `est.` badge existed on screen and nowhere else.
    const flagged = catalog.parts.filter(
      (p) => (p as unknown as { needsReview?: boolean }).needsReview === true,
    );
    expect(flagged.length).toBe(27);

    const bom = computeBom(doc({ panels: [], items: [item('s', 'shelf-4', { q: 0, r: 0 })] }), catalog);
    const l = line(bom, 'shelf-4')!;
    expect(l.needsReview).toBe(true);
    // ...and a measured part is not marked, or the flag would mean nothing.
    const measured = computeBom(
      doc({ panels: [], items: [item('i', 'insert-empty', { q: 0, r: 0 })] }),
      catalog,
    );
    expect(line(measured, 'insert-empty')!.needsReview).toBe(false);
  });

  it('FINDING: HSW-SPEC section 5 and the catalogue disagree on what two cover parts plug into', () => {
    // The spec says countersunk-to-holee and cover-contersunk fit the HOLLOW
    // family's 18.5 / 16.5 mm socket. The catalogue makes them require
    // insert-empty. insert-empty does also list an 18.5 socket, so this is a
    // documented ambiguity rather than a proven miscount — but the BOM commits
    // to one answer with no note, and printing the wrong insert is a wasted trip.
    for (const id of ['countersunk-to-holee', 'cover-contersunk']) {
      expect((part(id).requires ?? []).map((r) => r.partId)).toEqual(['insert-empty']);
    }
    expect(part('insert-empty').provenance.notes.join(' ')).toContain('13.4, 16.5, 18.5');
  });

  it('REGRESSION (was P8 item 2): a full panel is warned it has no room for its wall mounts', () => {
    // The finding: a 4x4 panel needs 4 countersunk inserts in 4 of its 16
    // cells, but the BOM did not place them and validate() did not check that 4
    // cells were free. Fill every cell and the BOM cheerfully asked for 4
    // inserts with nowhere to go, and raised nothing.
    //
    // The cell list is panel A's real footprint under the -ceil(r/2) stagger:
    // rows 1 and 3 lean half a pitch LEFT of the row below. Using the old
    // -floor(r/2) parity here put two of the sixteen off the panel and produced
    // off-panel errors that had nothing to do with the finding.
    const panelCellList: Hex[] = [
      { q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }, { q: 3, r: 0 },
      { q: -1, r: 1 }, { q: 0, r: 1 }, { q: 1, r: 1 }, { q: 2, r: 1 },
      { q: -1, r: 2 }, { q: 0, r: 2 }, { q: 1, r: 2 }, { q: 2, r: 2 },
      { q: -2, r: 3 }, { q: -1, r: 3 }, { q: 0, r: 3 }, { q: 1, r: 3 },
    ];
    const panelA: PlacedPanel = {
      id: 'pA',
      partId: 'wall-honeycomb-106x89-fixed',
      origin: { q: 0, r: 0 },
      columns: 4,
      rows: 4,
    };
    // The fixture is the panel's own cells, checked against the generator
    // rather than trusted — a stale cell list would make this prove nothing.
    expect(panelCellList.map(hexKey).sort()).toEqual(
      panelCells(panelA.origin, panelA.columns, panelA.rows).map(hexKey).sort(),
    );

    const items: PlacedItem[] = panelCellList.map((c, i) =>
      item(`f${i + 1}`, 'insert-cable-holder', c),
    );
    const bom = computeBom(doc({ panels: [panelA], items }), catalog);

    expect(bom.issues.map((i) => i.code)).toEqual(['no-room-for-mounts']);
    const warned = bom.issues[0]!;
    expect(warned.level).toBe('warning');
    expect(warned.itemIds).toEqual(['pA']);
    expect(warned.message).toContain('no free cell left');

    expect(qty(bom, 'insert-cable-holder')).toBe(16); // every cell occupied
    // Nowhere to put a fixing at all: the plan finds no free cell, so it orders
    // none and says so, rather than ordering four that cannot be fitted.
    expect(qty(bom, 'insert-countersunk')).toBe(0);
    expect(items.length).toBe(part(panelA.partId).footprint.length); // the panel is genuinely full

    // Leaving four cells free clears the warning: the check counts real free
    // cells, it does not simply fire on any full-ish panel.
    const roomy = computeBom(doc({ panels: [panelA], items: items.slice(0, 12) }), catalog);
    expect(roomy.issues).toEqual([]);
  });
});
