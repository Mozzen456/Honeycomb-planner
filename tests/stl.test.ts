/**
 * The browser-side reader, checked against the Python/trimesh side.
 *
 * The whole point of `src/core/stl.ts` is that an imported part is measured the
 * same way a scanned one was. That claim is only worth anything if it is tested
 * against the real thing, so these run over all 51 shipped models and compare
 * with the numbers `tools/scan.py` recorded in the catalogue.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { estimatePrint, measureMesh, parseStl, StlParseError } from '../src/core/stl';
import type { Catalog } from '../src/core/types';

const catalog = catalogJson as unknown as Catalog;
const root = resolve(__dirname, '..');

export function loadModel(file: string) {
  const buf = readFileSync(resolve(root, file));
  return parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

describe('parseStl', () => {
  it('reads every shipped model', () => {
    for (const part of catalog.parts) {
      const mesh = loadModel(part.file);
      expect(mesh.triangleCount, part.id).toBeGreaterThan(0);
      expect(mesh.positions.length, part.id).toBe(mesh.triangleCount * 9);
    }
  });

  it('reads a binary STL whose header starts with the word "solid"', () => {
    // The classic reader bug: sniffing the format on the leading token rather
    // than the length. Several shipped files begin "solid" and are binary.
    const header = new Uint8Array(84);
    new TextEncoder().encodeInto('solid exported-by-something', header.subarray(0, 80));
    const body = new Uint8Array(50);
    const buffer = new Uint8Array(84 + 50);
    buffer.set(header);
    buffer.set(body, 84);
    new DataView(buffer.buffer).setUint32(80, 1, true);
    // One triangle, corners at (0,0,0) (1,0,0) (0,1,0).
    const dv = new DataView(buffer.buffer);
    dv.setFloat32(84 + 12 + 12, 1, true); // b.x
    dv.setFloat32(84 + 12 + 28, 1, true); // c.y

    const mesh = parseStl(buffer.buffer);
    expect(mesh.format).toBe('binary');
    expect(mesh.triangleCount).toBe(1);
  });

  it('reads ASCII', () => {
    const text = `solid t
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 10 0 0
  vertex 0 10 0
 endloop
endfacet
endsolid t`;
    const bytes = new TextEncoder().encode(text);
    const mesh = parseStl(bytes.buffer as ArrayBuffer);
    expect(mesh.format).toBe('ascii');
    expect(mesh.triangleCount).toBe(1);
    expect(measureMesh(mesh).areaMm2).toBeCloseTo(50, 6);
  });

  it('refuses a file that is not an STL, with a reason', () => {
    const junk = new TextEncoder().encode('this is a text file, not a model at all');
    expect(() => parseStl(junk.buffer as ArrayBuffer)).toThrow(StlParseError);
  });

  it('refuses a truncated ASCII STL rather than reading a partial triangle', () => {
    const text = 'solid t\nfacet normal 0 0 1\n outer loop\n  vertex 0 0 0\n  vertex 1 0 0\n';
    const bytes = new TextEncoder().encode(text);
    expect(() => parseStl(bytes.buffer as ArrayBuffer)).toThrow(/whole number of triangles/);
  });
});

describe('measureMesh', () => {
  it('agrees with trimesh on volume for all 51 models', () => {
    for (const part of catalog.parts) {
      const m = measureMesh(loadModel(part.file));
      // The catalogue rounds to 1e-3 mm³; anything above 1e-5 relative would be
      // a real disagreement in the tetrahedron sum, not rounding.
      expect(Math.abs(m.volumeMm3 - part.volumeMm3) / part.volumeMm3, part.id).toBeLessThan(1e-5);
    }
  });

  it('agrees with trimesh on the bounding box for all 51 models', () => {
    for (const part of catalog.parts) {
      const m = measureMesh(loadModel(part.file));
      for (let i = 0; i < 3; i++) {
        expect(m.bboxMm[i]!, `${part.id} axis ${i}`).toBeCloseTo(part.bboxMm[i]!, 3);
      }
    }
  });

  it('reproduces the recorded supports verdict on all 51 models', () => {
    for (const part of catalog.parts) {
      const m = measureMesh(loadModel(part.file));
      expect(m.supports, part.id).toBe(part.print.supports);
    }
  });
});

describe('estimatePrint', () => {
  /**
   * The estimator exists because a browser cannot slice. It is only honest if
   * its error is known, so the error is asserted rather than described: these
   * bounds are what it actually achieves against real PrusaSlicer results, and
   * a change that loosens them has to say so here.
   */
  it('lands within 25% of a real slice on every shipped part', () => {
    const errors: number[] = [];
    for (const part of catalog.parts) {
      const m = measureMesh(loadModel(part.file));
      const est = estimatePrint({
        volumeMm3: m.volumeMm3,
        areaMm2: m.areaMm2,
        heightMm: m.bboxMm[2]!,
        supports: m.supports,
      });
      const err = Math.abs(est.grams - part.print.grams) / part.print.grams;
      errors.push(err);
      expect(err, `${part.id} grams`).toBeLessThan(0.25);
    }
    const rms = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length);
    expect(rms).toBeLessThan(0.1);
  });

  it('stays within 50% on print time, and says the numbers are estimates', () => {
    for (const part of catalog.parts) {
      const m = measureMesh(loadModel(part.file));
      const est = estimatePrint({
        volumeMm3: m.volumeMm3,
        areaMm2: m.areaMm2,
        heightMm: m.bboxMm[2]!,
        supports: m.supports,
      });
      expect(est.source).toBe('volume');
      const err = Math.abs(est.minutes - part.print.minutes) / part.print.minutes;
      expect(err, `${part.id} minutes`).toBeLessThan(0.5);
    }
  });

  /**
   * The test that matters most, and the one that did not exist at first.
   *
   * Every shipped part is thin-walled — hooks, clips, perforated plates — so an
   * estimator fitted and tested on them alone can score well by memorising that
   * family. The first version did exactly that: on a solid cube, a sphere and a
   * flat plate it predicted print time 54-59% too slow, and nothing in the
   * suite noticed, because nothing in the suite was shaped like that.
   *
   * The fixture holds 27 shapes that span the regime the HSW set does not —
   * infill-dominated solids, flat plates, tall posts, tubes, 0.6 to 91 cm3 —
   * each with its real PrusaSlicer result under the profile in HSW-SPEC.md 7.
   * No slicer is needed to run this; the numbers are recorded.
   */
  it('generalises to geometry unlike the HSW parts', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(__dirname, 'fixtures/estimator-calibration.json'), 'utf8'),
    ) as { shapes: { name: string; volumeMm3: number; areaMm2: number; heightMm: number; grams: number; minutes: number }[] };

    expect(fixture.shapes.length).toBeGreaterThanOrEqual(25);

    const mass: number[] = [];
    const time: number[] = [];
    for (const shape of fixture.shapes) {
      const est = estimatePrint({
        volumeMm3: shape.volumeMm3,
        areaMm2: shape.areaMm2,
        heightMm: shape.heightMm,
        supports: false,
      });
      const gErr = Math.abs(est.grams - shape.grams) / shape.grams;
      const mErr = Math.abs(est.minutes - shape.minutes) / shape.minutes;
      mass.push(gErr);
      time.push(mErr);
      // Per-shape ceilings. Generous, because this is an estimate on geometry
      // the model was never going to nail — but far tighter than the 60% the
      // first version reached, and tight enough that a regression shows up.
      expect(gErr, `${shape.name} grams`).toBeLessThan(0.45);
      expect(mErr, `${shape.name} minutes`).toBeLessThan(0.55);
    }
    const rms = (xs: number[]) => Math.sqrt(xs.reduce((s, e) => s + e * e, 0) / xs.length);
    expect(rms(mass)).toBeLessThan(0.18);
    expect(rms(time)).toBeLessThan(0.25);
  });

  it('charges infill less per mm3 than shell, because it prints faster', () => {
    // The distinction the first version lacked. A solid block and a thin shell
    // of the same filament volume are not the same print: perimeters run at
    // 45 mm/s and infill at 80. Collapsing the two is what made a solid cube
    // come out an hour slow.
    const solid = estimatePrint({ volumeMm3: 20000, areaMm2: 5400, heightMm: 27, supports: false });
    const thin = estimatePrint({ volumeMm3: 5000, areaMm2: 6000, heightMm: 27, supports: false });
    const perGramSolid = solid.minutes / solid.grams;
    const perGramThin = thin.minutes / thin.grams;
    expect(perGramSolid).toBeLessThan(perGramThin);
  });

  it('never returns a negative or non-finite quantity', () => {
    const est = estimatePrint({ volumeMm3: 0, areaMm2: 0, heightMm: 0, supports: false });
    for (const v of [est.minutes, est.grams, est.metres]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
