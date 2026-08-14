/**
 * The generator against the plates it claims to reproduce.
 *
 * `src/core/honeycomb.ts` builds a honeycomb plate from `constants.ts` alone —
 * it never reads a mesh. The seven shipped panels were measured off their real
 * STLs by `tools/scan.py`, so generating each one and comparing volume and
 * bounding box is a check of the model against reality, not against itself.
 *
 * That is the whole reason the generator can be trusted with a plate nobody has
 * ever printed: it gets the ones that HAVE been printed right, to five figures.
 *
 * The other two cases here are properties no comparison can give:
 *   - the surface is closed and consistently wound, which is what makes it
 *     printable rather than a bag of triangles a slicer has to guess at;
 *   - it survives the trip through a binary STL and back.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { CELL, INSERT, PANEL_DEPTH, PITCH, ROW_STEP } from '../src/core/constants';
import { hexKey, panelCells } from '../src/core/hex';
import {
  BORE_PROFILE,
  buildHoneycombMesh,
  meshBoundsMm,
  meshIsClosed,
  meshVolumeMm3,
  toBinaryStl,
} from '../src/core/honeycomb';
import { measureMesh, parseStl } from '../src/core/stl';
import type { Catalog } from '../src/core/types';

const catalog = catalogJson as unknown as Catalog;
const panels = catalog.parts.filter((p) => p.type === 'panel' && p.panel);

describe('the bore profile', () => {
  it('is exactly a plate deep, band by band', () => {
    const last = BORE_PROFILE[BORE_PROFILE.length - 1]!;
    expect(last.zMm).toBeCloseTo(PANEL_DEPTH, 9);
    // Ascending, and never wider than the cell pitch.
    for (let i = 1; i < BORE_PROFILE.length; i++) {
      expect(BORE_PROFILE[i]!.zMm).toBeGreaterThan(BORE_PROFILE[i - 1]!.zMm);
    }
    for (const level of BORE_PROFILE) expect(level.acrossFlatsMm).toBeLessThan(PITCH);
  });

  it('puts the 22 mm mouth against the WALL and the 20.8 flare on the room side', () => {
    expect(BORE_PROFILE[0]!.acrossFlatsMm).toBeCloseTo(22.0, 9);
    expect(BORE_PROFILE[BORE_PROFILE.length - 1]!.acrossFlatsMm).toBeCloseTo(20.8, 9);
  });

  it('gives a real insert’s barbs room to spring out where they actually sit', () => {
    /*
     * Which way round a plate goes is decided by the INSERT, not by the plate,
     * and this measures it on the shipped insert rather than restating a number.
     *
     * An insert enters from the room, its flange stops on the face, and its
     * snap barbs — wider than the 20.0 throat — have to reach a part of the bore
     * that is wider still, or they stay compressed and the insert falls out.
     * Measured on `insert-empty.stl`: the barbs are 5.7 to 6.1 mm past the
     * seating face. From the ROOM side that is where the 48° lead-in opens into
     * the 22.0 mouth, so the mouth is the WALL side. Turn the plate over and the
     * same barbs sit inside the 20.0 throat, which is the state this asserts
     * against — it fails on the profile the app shipped before D97.
     */
    const insert = catalog.parts.find((x) => x.id === 'insert-empty')!;
    const bytes = readFileSync(insert.file);
    const mesh = parseStl(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    const p = mesh.positions;
    // The insert's own axis is the short one (10 mm against 22.5 / 25.98).
    const ext = [0, 1, 2].map((a) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = a; i < p.length; i += 3) { lo = Math.min(lo, p[i]!); hi = Math.max(hi, p[i]!); }
      return { a, lo, hi, span: hi - lo };
    }).sort((x, y) => x.span - y.span);
    const axis = ext[0]!;
    const [o1, o2] = [ext[1]!.a, ext[2]!.a];

    /** Across FLATS at height h above the flange face: the narrower bbox side. */
    const widthAt = (h: number): number => {
      const z = axis.lo + h;
      let lo1 = Infinity, hi1 = -Infinity, lo2 = Infinity, hi2 = -Infinity;
      for (let i = 0; i < p.length; i += 3) {
        if (Math.abs(p[i + axis.a]! - z) > 0.15) continue;
        lo1 = Math.min(lo1, p[i + o1]!); hi1 = Math.max(hi1, p[i + o1]!);
        lo2 = Math.min(lo2, p[i + o2]!); hi2 = Math.max(hi2, p[i + o2]!);
      }
      return Math.min(hi1 - lo1, hi2 - lo2);
    };
    // Flange end first: it is the widest.
    const flangeAtLow = widthAt(1) > widthAt(axis.span - 1);
    const fromFlange = (h: number): number => widthAt(flangeAtLow ? h : axis.span - h);

    // Everything past the flange that is wider than the throat is a barb.
    const barbDepths: number[] = [];
    for (let h = INSERT.flangeThickness + 0.5; h < axis.span; h += 0.1) {
      if (fromFlange(h) > CELL.throatAcrossFlats + 0.05) {
        barbDepths.push(h - INSERT.flangeThickness); // depth into the plate
      }
    }
    expect(barbDepths.length, 'found no barbs on insert-empty').toBeGreaterThan(0);

    /** The plate's bore at `d` mm in from the ROOM face. */
    const boreAt = (d: number): number => {
      const z = PANEL_DEPTH - d;
      for (let i = 1; i < BORE_PROFILE.length; i++) {
        const a = BORE_PROFILE[i - 1]!, b = BORE_PROFILE[i]!;
        if (z >= a.zMm && z <= b.zMm) {
          const t = b.zMm === a.zMm ? 0 : (z - a.zMm) / (b.zMm - a.zMm);
          return a.acrossFlatsMm + t * (b.acrossFlatsMm - a.acrossFlatsMm);
        }
      }
      return NaN;
    };

    const deepest = Math.max(...barbDepths);
    expect(deepest, 'the barbs must stay inside an 8 mm plate').toBeLessThan(PANEL_DEPTH);
    // At its widest the barb must have somewhere to go.
    const widest = Math.max(...barbDepths.map(boreAt));
    expect(widest).toBeGreaterThan(INSERT.barbAcrossFlats);
  });
});

describe('generated plates against the measured shipped ones', () => {
  it('has all seven panels to compare against', () => {
    expect(panels.length).toBe(7);
  });

  for (const part of panels) {
    const p = part.panel!;

    it(`${part.id} — volume within 0.05 % of the measured mesh`, () => {
      const cells = panelCells({ q: 0, r: 0 }, p.columns, p.rows);
      expect(cells.length).toBe(p.columns * p.rows);
      const mesh = buildHoneycombMesh({ cells });
      const volume = meshVolumeMm3(mesh);
      const error = Math.abs(volume - part.volumeMm3) / part.volumeMm3;
      expect(error).toBeLessThan(0.0005);
    });

    it(`${part.id} — bounding box within 0.01 mm of the measured mesh`, () => {
      const cells = panelCells({ q: 0, r: 0 }, p.columns, p.rows);
      const size = meshBoundsMm(buildHoneycombMesh({ cells })).size;
      // The catalogue's `bboxMm` is in the FILE's frame, and four of the seven
      // are drawn 90° from the wall's. Comparing the sorted extents sidesteps
      // that without weakening the check: three numbers still have to match.
      const mine = [...size].sort((a, b) => a - b);
      const theirs = [...part.bboxMm].sort((a, b) => a - b);
      for (let i = 0; i < 3; i++) expect(mine[i]!).toBeCloseTo(theirs[i]!, 2);
    });
  }

  it('is exactly a plate thick, and the wall block wide and tall', () => {
    // The two numbers on the designer's own drawing for `wall-honeycomb-part`
    // (HSW-SPEC §2): 8 columns by 7 rows is 170.32 wide and 177 tall.
    const cells = panelCells({ q: 0, r: 0 }, 8, 7);
    const size = meshBoundsMm(buildHoneycombMesh({ cells })).size;
    expect(size[0]).toBeCloseTo(7 * ROW_STEP + 2 * (PITCH / Math.sqrt(3)), 3);
    expect(size[1]).toBeCloseTo(7 * PITCH + PITCH / 2, 3);
    expect(size[2]).toBeCloseTo(PANEL_DEPTH, 9);
  });
});

describe('the surface', () => {
  it('is closed and consistently wound for a whole plate', () => {
    const mesh = buildHoneycombMesh({ cells: panelCells({ q: 0, r: 0 }, 5, 4) });
    const check = meshIsClosed(mesh);
    expect(check.degenerate).toBe(0);
    expect(check.unmatchedEdges).toBe(0);
    expect(check.closed).toBe(true);
  });

  it('is closed for a single cell', () => {
    const mesh = buildHoneycombMesh({ cells: [{ q: 0, r: 0 }] });
    expect(meshIsClosed(mesh).closed).toBe(true);
  });

  it('is closed for a plate with cells cut out of the middle', () => {
    // The shape a light switch leaves behind: this is the case the whole
    // feature exists for, and the one no shipped STL covers.
    const block = panelCells({ q: 0, r: 0 }, 6, 6);
    const hole = new Set([hexKey({ q: 2, r: 2 }), hexKey({ q: 3, r: 1 }), hexKey({ q: 3, r: 2 })]);
    const cells = block.filter((c) => !hole.has(hexKey(c)));
    const mesh = buildHoneycombMesh({ cells });
    expect(meshIsClosed(mesh).closed).toBe(true);
    // And the material really is missing: three cells' worth less than the block.
    const full = meshVolumeMm3(buildHoneycombMesh({ cells: block }));
    const cut = meshVolumeMm3(mesh);
    expect(full - cut).toBeGreaterThan(0);
    expect((full - cut) / full).toBeCloseTo(3 / 36, 2);
  });

  it('faces outward — the volume comes out positive', () => {
    // A mesh wound the other way measures the same size and a NEGATIVE volume,
    // and prints as the space around the plate rather than the plate.
    expect(meshVolumeMm3(buildHoneycombMesh({ cells: panelCells({ q: 0, r: 0 }, 3, 3) })))
      .toBeGreaterThan(0);
  });

  it('shares one corner between the three cells that meet there', () => {
    // ROW_STEP is the typed 20.438, so three cells disagree about their common
    // corner by ~0.0003 mm (D4). Un-snapped, this plate has cracks along every
    // internal edge and `meshIsClosed` fails — that is what this pins.
    const mesh = buildHoneycombMesh({ cells: panelCells({ q: 0, r: 0 }, 4, 4) });
    const seen = new Set<string>();
    for (let i = 0; i < mesh.positions.length; i += 3) {
      seen.add(`${mesh.positions[i]},${mesh.positions[i + 1]},${mesh.positions[i + 2]}`);
    }
    // 16 cells: were corners not shared, the outer ring alone would contribute
    // 16 × 6 × 2 = 192 distinct positions. Sharing brings it well under that.
    const outerAtBottom = [...seen].filter((k) => k.endsWith(',0')).length;
    expect(outerAtBottom).toBeLessThan(192);
  });
});

describe('the STL it writes', () => {
  it('round-trips through parseStl with the same volume and box', () => {
    const cells = panelCells({ q: 0, r: 0 }, 4, 4);
    const mesh = buildHoneycombMesh({ cells });
    const stl = toBinaryStl(mesh, 'test plate');

    const back = parseStl(stl);
    expect(back.format).toBe('binary');
    expect(back.triangleCount).toBe(mesh.triangleCount);

    const measured = measureMesh(back);
    // float32 in the file, so this is a precision check, not an equality one.
    expect(measured.volumeMm3).toBeCloseTo(meshVolumeMm3(mesh), 1);
    const size = meshBoundsMm(mesh).size;
    for (let i = 0; i < 3; i++) expect(measured.bboxMm[i]!).toBeCloseTo(size[i]!, 3);
  });

  it('is exactly 84 + 50 bytes a triangle', () => {
    const mesh = buildHoneycombMesh({ cells: [{ q: 0, r: 0 }] });
    expect(toBinaryStl(mesh).byteLength).toBe(84 + mesh.triangleCount * 50);
  });

  it('starts the plate at the origin, ready for a bed', () => {
    const cells = panelCells({ q: 3, r: -2 }, 3, 3);
    const b = meshBoundsMm(buildHoneycombMesh({ cells }));
    expect(b.min[0]).toBeCloseTo(0, 9);
    expect(b.min[1]).toBeCloseTo(0, 9);
    expect(b.min[2]).toBeCloseTo(0, 9);
  });
});
