/**
 * Plates stacked for one print job.
 *
 * The trick is a single layer of air between the copies: they bridge rather
 * than fuse, and come apart in the hand. So the two things worth pinning are
 * the GAP — measured between one plate's top and the next one's bottom, on the
 * mesh, not on the arithmetic that placed it — and that every copy is still the
 * plate, unmoved in x and y and unchanged in shape.
 */

import { describe, expect, it } from 'vitest';

import { panelCells } from '../src/core/hex';
import {
  buildHoneycombMesh,
  MAX_STACK,
  meshBoundsMm,
  meshIsClosed,
  STACK_GAP_MM,
  stackHeightMm,
  stackMesh,
  toBinaryStl,
  type SolidMesh,
} from '../src/core/honeycomb';
import { PANEL_DEPTH } from '../src/core/constants';
import { measureMesh, parseStl } from '../src/core/stl';
import { countWhileTyping } from '../src/ui/StackMenu';

const plate = (columns = 4, rows = 3): SolidMesh =>
  buildHoneycombMesh({ cells: panelCells({ q: 0, r: 0 }, columns, rows) });

/**
 * Where a vertical ray at (x, y) finds MATERIAL, as sorted spans.
 *
 * On the mesh, because that is the only thing a printer reads. Vertex z-levels
 * cannot answer this: a plate's own profile has a 4.6 mm step in it, so any rule
 * that splits the level set on a jump either splits one plate into five or
 * misses a 0.2 mm gap entirely.
 */
function solidSpans(mesh: SolidMesh, x: number, y: number): { lo: number; hi: number }[] {
  const zs: number[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    const o = t * 9;
    const ax = mesh.positions[o]!;
    const ay = mesh.positions[o + 1]!;
    const bx = mesh.positions[o + 3]!;
    const by = mesh.positions[o + 4]!;
    const cx = mesh.positions[o + 6]!;
    const cy = mesh.positions[o + 7]!;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue; // a side wall: the ray only grazes it
    const w0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area;
    const w1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area;
    const w2 = 1 - w0 - w1;
    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
    zs.push(w0 * mesh.positions[o + 2]! + w1 * mesh.positions[o + 5]! + w2 * mesh.positions[o + 8]!);
  }
  zs.sort((a, b) => a - b);
  const spans: { lo: number; hi: number }[] = [];
  for (let i = 0; i + 1 < zs.length; i += 2) spans.push({ lo: zs[i]!, hi: zs[i + 1]! });
  return spans;
}

/** A point where the plate is solid from its bottom face to its top one. */
function throughPoint(mesh: SolidMesh): { x: number; y: number } {
  const b = meshBoundsMm(mesh);
  // Irrational-ish steps, so no sample lands on a cell centre, a flat or a
  // corner — the degeneracies the lattice traps warn about.
  for (let i = 1; i < 400; i++) {
    const x = b.min[0] + (b.size[0] * ((i * 0.6180339887) % 1));
    const y = b.min[1] + (b.size[1] * ((i * 0.4142135624) % 1));
    const spans = solidSpans(mesh, x, y);
    if (spans.length === 1 && spans[0]!.hi - spans[0]!.lo > PANEL_DEPTH - 1e-9) return { x, y };
  }
  throw new Error('no through-thickness point found');
}

describe('stacking plates for one print', () => {
  it('leaves exactly one layer of air between every pair', () => {
    const one = plate();
    const { x, y } = throughPoint(one);
    for (const copies of [2, 3, 7]) {
      const spans = solidSpans(stackMesh(one, copies), x, y);
      expect(spans).toHaveLength(copies);
      for (let i = 1; i < spans.length; i++) {
        // Measured between the top of one copy and the bottom of the next —
        // which is what a printer sees, and is not the same statement as "each
        // copy was translated by step".
        expect(spans[i]!.lo - spans[i - 1]!.hi).toBeCloseTo(STACK_GAP_MM, 9);
      }
    }
  });

  it('keeps every copy the same plate, only lifted', () => {
    const one = plate();
    const many = stackMesh(one, 4);
    const b1 = meshBoundsMm(one);
    const b4 = meshBoundsMm(many);
    // Same footprint: a stack grows upward and nowhere else.
    expect(b4.min[0]).toBeCloseTo(b1.min[0], 9);
    expect(b4.max[0]).toBeCloseTo(b1.max[0], 9);
    expect(b4.min[1]).toBeCloseTo(b1.min[1], 9);
    expect(b4.max[1]).toBeCloseTo(b1.max[1], 9);
    expect(b4.min[2]).toBeCloseTo(b1.min[2], 9);

    // ...and each copy is the original mesh, vertex for vertex, lifted.
    const per = one.positions.length;
    const step = b1.size[2] + STACK_GAP_MM;
    for (let c = 0; c < 4; c++) {
      for (let i = 0; i < per; i += 3) {
        expect(many.positions[c * per + i]).toBe(one.positions[i]);
        expect(many.positions[c * per + i + 1]).toBe(one.positions[i + 1]);
        expect(many.positions[c * per + i + 2]).toBeCloseTo(one.positions[i + 2]! + c * step, 9);
      }
    }
  });

  it('says how tall the stack will be, and is right', () => {
    const one = plate();
    for (const copies of [1, 2, 5]) {
      const wanted = stackHeightMm(meshBoundsMm(one).size[2], copies);
      expect(meshBoundsMm(stackMesh(one, copies)).size[2]).toBeCloseTo(wanted, 9);
      // A plate is PANEL_DEPTH tall, so the sum is checkable by hand.
      expect(wanted).toBeCloseTo(PANEL_DEPTH * copies + STACK_GAP_MM * (copies - 1), 9);
    }
  });

  it('stays closed and printable, and every copy is separate', () => {
    const many = stackMesh(plate(), 5);
    expect(meshIsClosed(many)).toEqual({ closed: true, unmatchedEdges: 0, degenerate: 0 });
    // Five shells, on purpose: a stack is meant to come apart.
    expect(many.triangleCount).toBe(plate().triangleCount * 5);
    const read = parseStl(toBinaryStl(many, 'stack'));
    expect(read.triangleCount).toBe(many.triangleCount);
    expect(measureMesh(read).volumeMm3 / 5).toBeCloseTo(
      measureMesh(parseStl(toBinaryStl(plate()))).volumeMm3,
      1,
    );
  });

  it('takes nonsense without producing nonsense', () => {
    const one = plate();
    expect(stackMesh(one, 1)).toBe(one); // the same object, not a copy of it
    expect(stackMesh(one, 0).triangleCount).toBe(one.triangleCount);
    expect(stackMesh(one, -3).triangleCount).toBe(one.triangleCount);
    expect(stackMesh(one, 2.7).triangleCount).toBe(one.triangleCount * 2);
    expect(stackMesh(one, 1e6).triangleCount).toBe(one.triangleCount * MAX_STACK);
  });
});

describe('the count the popover asks for', () => {
  it('leaves a half-typed field alone', () => {
    // Mid-edit is not a number, and must not become one: `Number('')` is 0,
    // which would clamp to 1 and repaint the field before the second digit
    // lands. The same rule `NumberField` exists for.
    expect(countWhileTyping('')).toBeUndefined();
    expect(countWhileTyping('   ')).toBeUndefined();
    expect(countWhileTyping('abc')).toBeUndefined();
  });

  it('takes a count and holds it to the bounds', () => {
    expect(countWhileTyping('3')).toBe(3);
    expect(countWhileTyping('0')).toBe(1);
    expect(countWhileTyping('-4')).toBe(1);
    expect(countWhileTyping('2.9')).toBe(2);
    expect(countWhileTyping('999')).toBe(MAX_STACK);
  });
});
