/**
 * Moving and removing the wall fixings the planner puts in.
 *
 * The fixings stay DERIVED — `planFixings` still spreads them across the
 * assembly, which is the whole point of D48 — and a person's decisions are kept
 * as edits on the document that are applied to the plan's output. The properties
 * that matter, and the ones that are easy to get wrong:
 *
 *   1. a removal STAYS removed. The obvious mistake is to feed the edits back
 *      into the planner, which notices the gap and helpfully fills it from a
 *      cell away — the fixing you deleted, moved 24 mm;
 *   2. the parts list orders what the wall draws, edits included. One plan, two
 *      consumers (D48, D53);
 *   3. adding one where the planner had it UNDOES the removal rather than
 *      recording an override, and removing one you added forgets the addition.
 *      Otherwise the document accumulates pairs that cancel and never comes back
 *      to the state you started in;
 *   4. a move is ONE undo step, and a refused move leaves the fixing where it
 *      was rather than deleted.
 *
 * Written against a real catalogue and a real solved wall, because the plan's
 * own cells are what the edits refer to.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import overridesJson from '../src/catalog/overrides.json';
import { computeBom, fixingPlanFor } from '../src/core/bom';
import { hexKey, placedPanelCells, placeFootprint } from '../src/core/hex';
import { applyOverrides } from '../src/core/overrides';
import { deserialize, serialize } from '../src/core/persist';
import { Store, emptyDoc } from '../src/core/store';
import { solveTiling, type PanelSize } from '../src/core/tiling';
import type { Catalog, Hex, LayoutDoc, Rotation } from '../src/core/types';

const catalog = applyOverrides(catalogJson as unknown as Catalog, overridesJson);

const panelSizes = (): PanelSize[] =>
  catalog.parts
    .filter((p) => p.type === 'panel' && p.panel)
    .map((p) => ({
      partId: p.id,
      columns: p.panel!.columns,
      rows: p.panel!.rows,
      widthMm: p.panel!.widthMm,
      heightMm: p.panel!.heightMm,
    }));

/** A solved wall: several plates, so there are junctions as well as grid fixings. */
function solvedDoc(widthMm = 1200, heightMm = 900): LayoutDoc {
  const doc = { ...emptyDoc(), wall: { widthMm, heightMm } };
  const solved = solveTiling({ wall: doc.wall, bedId: doc.bedId, available: panelSizes() });
  return {
    ...doc,
    panels: solved.panels.map((p, i) => ({
      id: `p${i}`,
      partId: p.partId,
      origin: p.origin,
      columns: p.columns,
      rows: p.rows,
    })),
  };
}

const store = (doc: LayoutDoc): Store => new Store(doc, catalog);
const planOf = (doc: LayoutDoc) => fixingPlanFor(doc, catalog);
const keys = (cells: readonly Hex[]): string[] => cells.map(hexKey).sort();

/**
 * Every fixing in a plan, by the cell that NAMES it: a single fixing's own cell,
 * a multi-cell one's anchor. Since D125 the planner puts the two- and four-cell
 * parts wherever they fit, so most plans have no single fixings at all, and
 * these tests are about fixings, whichever part they are.
 */
const anchors = (plan: ReturnType<typeof planOf>): Hex[] =>
  [...plan.cells, ...plan.junctions.map((j) => j.anchor)];
const total = (plan: ReturnType<typeof planOf>): number => plan.cells.length + plan.junctions.length;
/** Fixings a person may MOVE: all but a four-cell insert tying 3+ plates at a corner. */
const movable = (plan: ReturnType<typeof planOf>): Hex[] => [
  ...plan.cells,
  ...plan.junctions.filter((j) => j.panelIds.length < 3).map((j) => j.anchor),
];

describe('the plan a person has edited', () => {
  it('has fixings to edit in the first place', () => {
    const plan = planOf(solvedDoc());
    expect(total(plan)).toBeGreaterThan(0);
    expect(movable(plan).length).toBeGreaterThan(0);
    expect(plan.removedCount).toBe(0);
    expect(plan.manual.size).toBe(0);
  });

  it('drops a removed fixing, and does not quietly replace it', () => {
    const doc = solvedDoc();
    const before = planOf(doc);
    const victim = movable(before)[2]!;

    const after = planOf({ ...doc, fixingEdits: { removed: [victim] } });
    expect(keys(anchors(after))).not.toContain(hexKey(victim));
    expect(total(after)).toBe(total(before) - 1);
    expect(after.removedCount).toBe(1);
    // The rest are untouched — the planner has not re-run and shuffled them.
    expect(keys(anchors(after))).toEqual(
      keys(anchors(before)).filter((k) => k !== hexKey(victim)),
    );
  });

  it('drops a junction by its ANCHOR, all four cells with it', () => {
    const doc = solvedDoc(1600, 1200);
    const before = planOf(doc);
    expect(before.junctions.length).toBeGreaterThan(0);
    const junction = before.junctions[0]!;

    const after = planOf({ ...doc, fixingEdits: { removed: [junction.anchor] } });
    expect(after.junctions).toHaveLength(before.junctions.length - 1);
    expect(after.junctions.some((j) => hexKey(j.anchor) === hexKey(junction.anchor))).toBe(false);
  });

  it('adds one where a person put it, and marks it as theirs', () => {
    const doc = solvedDoc();
    const before = planOf(doc);
    const taken = new Set(keys(before.cells));
    for (const j of before.junctions) for (const c of j.cells) taken.add(hexKey(c));
    const free = doc.panels
      .flatMap((p) => Array.from({ length: p.columns * p.rows }, (_, i) => ({
        q: p.origin.q + (i % p.columns),
        r: p.origin.r + Math.floor(i / p.columns),
      })))
      .find((c) => !taken.has(hexKey(c)))!;

    const after = planOf({ ...doc, fixingEdits: { added: [free] } });
    expect(keys(after.cells)).toContain(hexKey(free));
    expect(after.manual.has(hexKey(free))).toBe(true);
    expect(after.cells).toHaveLength(before.cells.length + 1);
  });

  it('ignores an addition off the plates, and one on a cell already fixed', () => {
    const doc = solvedDoc();
    const before = planOf(doc);
    const offWall: Hex = { q: 9999, r: 9999 };
    const alreadyFixed = before.junctions[0]!.cells[1]!;

    const after = planOf({ ...doc, fixingEdits: { added: [offWall, alreadyFixed] } });
    expect(total(after)).toBe(total(before));
    expect(after.manual.size).toBe(0);
  });

  it('keeps the parts list and the wall counting the same fixings', () => {
    const doc = solvedDoc();
    const plain = computeBom(doc, catalog);
    const victim = anchors(planOf(doc))[1]!;
    const edited = computeBom({ ...doc, fixingEdits: { removed: [victim] } }, catalog);

    expect(edited.fixings.count).toBe(plain.fixings.count - 1);
    // And the plan the 3D view is handed says the same.
    expect(edited.fixings.count).toBe(
      planOf({ ...doc, fixingEdits: { removed: [victim] } }).cells.length
        + planOf({ ...doc, fixingEdits: { removed: [victim] } }).junctions.length,
    );
  });

  it('warns when a plate is left with nothing holding it', () => {
    const doc = solvedDoc();
    const plan = planOf(doc);

    // Strip the wall bare — every grid fixing and every junction — rather than
    // hunting for a plate that happens to carry exactly one. Which plate that is
    // is a property of the tiling; the rule under test is not.
    const removed = [...plan.cells, ...plan.junctions.map((j) => j.anchor)];
    const stripped = { ...doc, fixingEdits: { removed } };
    const bare = planOf(stripped);
    expect(bare.cells).toEqual([]);
    expect(bare.junctions).toEqual([]);
    // Every plate that was held by anything — a grid fixing OR a junction —
    // is now held by nothing, and says so.
    const wereHeld = new Set([
      ...plan.panelIds,
      ...plan.junctions.flatMap((j) => j.panelIds),
    ]);
    expect(bare.unfixedPanelIds.sort()).toEqual([...wereHeld].sort());

    const unfixed = computeBom(stripped, catalog).issues.filter((i) => i.code === 'panel-unfixed');
    expect(unfixed.length).toBeGreaterThan(0);
    expect(unfixed[0]!.level).toBe('warning');
    expect(unfixed[0]!.message).toContain('no wall fixing left');
  });

  it('says nothing about a plate that still has one', () => {
    const doc = solvedDoc();
    const plan = planOf(doc);
    // A plate carrying several: take one away and it is still held.
    const counts = new Map<string, number>();
    for (const id of plan.panelIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const j of plan.junctions) for (const id of j.panelIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    // A fixing held by ONE plate only, on a plate that has another.
    const lone = plan.junctions.find((j) => j.panelIds.length === 1 && counts.get(j.panelIds[0]!)! > 1);
    expect(lone, 'this wall gives every plate exactly one fixing').toBeDefined();
    const victim = lone!.anchor;

    const edited = { ...doc, fixingEdits: { removed: [victim] } };
    expect(planOf(edited).unfixedPanelIds).toEqual([]);
    expect(computeBom(edited, catalog).issues.some((i) => i.code === 'panel-unfixed')).toBe(false);
  });
});

describe('the store commands', () => {
  it('removes a fixing, and undo puts it back', () => {
    const s = store(solvedDoc());
    const victim = anchors(s.fixingPlan())[0]!;
    const before = total(s.fixingPlan());

    expect(s.removeFixing(victim).ok).toBe(true);
    expect(total(s.fixingPlan())).toBe(before - 1);
    s.undo();
    expect(total(s.fixingPlan())).toBe(before);
    expect(s.getState().doc.fixingEdits).toBeUndefined();
  });

  it('refuses to remove a fixing that is not there', () => {
    const s = store(solvedDoc());
    const r = s.removeFixing({ q: 9999, r: 9999 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no wall fixing/i);
    expect(s.getState().canUndo).toBe(false);
  });

  it('moves one in a single undo step', () => {
    const s = store(solvedDoc());
    const from = movable(s.fixingPlan())[0]!;
    const moving = s.fixingPlan().junctions.find((j) => hexKey(j.anchor) === hexKey(from))!;
    const to = roomFor(s, moving.cells.length);
    const before = total(s.fixingPlan());

    expect(s.moveFixing(from, to).ok).toBe(true);
    const after = s.fixingPlan();
    expect(total(after)).toBe(before);
    expect(keys(anchors(after))).toContain(hexKey(to));
    expect(keys(anchors(after))).not.toContain(hexKey(from));
    // The SAME part arrives — a two-cell fixing does not become a single one.
    const arrived = after.junctions.find((j) => hexKey(j.anchor) === hexKey(to))!;
    expect(arrived.partId).toBe(moving.partId);
    expect(after.manual.has(hexKey(to))).toBe(true);

    // ONE step, not two: a drag is one action.
    s.undo();
    expect(keys(anchors(s.fixingPlan()))).toContain(hexKey(from));
    expect(s.getState().doc.fixingEdits).toBeUndefined();
  });

  it('moves one it has already moved without leaving a trail behind', () => {
    const s = store(solvedDoc());
    const from = movable(s.fixingPlan())[0]!;
    const size = s.fixingPlan().junctions.find((j) => hexKey(j.anchor) === hexKey(from))!.cells.length;
    const to = roomFor(s, size);
    expect(s.moveFixing(from, to).ok).toBe(true);
    const again = roomFor(s, size);
    expect(s.moveFixing(to, again).ok).toBe(true);
    const edits = s.getState().doc.fixingEdits!;
    expect(edits.removed).toHaveLength(1);
    expect(edits.placed).toHaveLength(1);
    expect(hexKey(edits.placed![0]!.at)).toBe(hexKey(again));
  });

  it('leaves the fixing where it was when the destination refuses it', () => {
    const s = store(solvedDoc());
    const plan = s.fixingPlan();
    const from = movable(plan)[0]!;
    const onto = anchors(plan).find((a) => hexKey(a) !== hexKey(from))!; // already carries one

    const r = s.moveFixing(from, onto);
    expect(r.ok).toBe(false);
    expect(keys(anchors(s.fixingPlan()))).toContain(hexKey(from));
    // Nothing half-done, and no undo step for a move that did not happen.
    expect(s.getState().doc.fixingEdits).toBeUndefined();
    expect(s.getState().canUndo).toBe(false);
  });

  it('will not move a junction tying plates together at their corner, and says why', () => {
    const s = store(solvedDoc(1600, 1200));
    const junction = s.fixingPlan().junctions.find((j) => j.panelIds.length >= 3)!;
    const r = s.moveFixing(junction.anchor, freeCell(s));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/plates meet/i);
    // ...but it can be removed.
    expect(s.removeFixing(junction.anchor).ok).toBe(true);
  });

  it('refuses a cell off the plates, and one with a fixing already in it', () => {
    const s = store(solvedDoc());
    expect(s.addFixing({ q: 9999, r: 9999 }).ok).toBe(false);
    expect(s.addFixing(s.fixingPlan().junctions[0]!.cells[1]!).ok).toBe(false);
    expect(s.getState().doc.fixingEdits).toBeUndefined();
  });

  /**
   * The two cancelling cases. Both are about the document coming back to where
   * it started, so that "reset" is not the only way out of a pair of edits.
   */
  it('forgets an addition rather than recording a removal on top of it', () => {
    const s = store(solvedDoc());
    const cell = freeCell(s);
    s.addFixing(cell);
    expect(s.getState().doc.fixingEdits?.added).toHaveLength(1);
    s.removeFixing(cell);
    expect(s.getState().doc.fixingEdits).toBeUndefined();
  });

  it('undoes a removal rather than adding an override at the same cell', () => {
    const s = store(solvedDoc());
    const cell = anchors(s.fixingPlan())[0]!;
    s.removeFixing(cell);
    expect(s.getState().doc.fixingEdits?.removed).toHaveLength(1);
    s.addFixing(cell);
    expect(s.getState().doc.fixingEdits).toBeUndefined();
  });

  it('gives the whole plan back, in one undoable step', () => {
    const s = store(solvedDoc());
    s.removeFixing(anchors(s.fixingPlan())[0]!);
    s.removeFixing(anchors(s.fixingPlan())[0]!);
    const planned = total(new Store(solvedDoc(), catalog).fixingPlan());
    expect(total(s.fixingPlan())).toBe(planned - 2);

    s.resetFixings();
    expect(total(s.fixingPlan())).toBe(planned);
    s.undo();
    expect(total(s.fixingPlan())).toBe(planned - 2);
  });

  it('never mutates the document it was given', () => {
    const doc = solvedDoc();
    const s = store(doc);
    s.removeFixing(anchors(s.fixingPlan())[0]!);
    expect(doc.fixingEdits).toBeUndefined();
  });
});

describe('edits round-trip', () => {
  const reload = (doc: LayoutDoc): LayoutDoc => {
    const result = deserialize(serialize(doc));
    expect(result.doc, result.errors.join('\n')).not.toBeNull();
    return result.doc!;
  };

  it('survives save and load', () => {
    const doc: LayoutDoc = {
      ...solvedDoc(),
      fixingEdits: { removed: [{ q: 1, r: 2 }], added: [{ q: 3, r: 4 }] },
    };
    expect(reload(doc).fixingEdits).toEqual({
      removed: [{ q: 1, r: 2 }],
      added: [{ q: 3, r: 4 }],
    });
  });

  it('keeps a moved multi-cell fixing across save and load', () => {
    const doc: LayoutDoc = {
      ...solvedDoc(),
      fixingEdits: {
        removed: [{ q: 1, r: 2 }],
        placed: [{ partId: 'hexagon-countersung-and-hole', at: { q: 5, r: 3 }, rotation: 2 }],
      },
    };
    expect(reload(doc).fixingEdits).toEqual(doc.fixingEdits);
  });

  it('an untouched plan serialises exactly as it always did', () => {
    const plain = solvedDoc();
    expect(serialize(plain)).not.toContain('fixingEdits');
    expect(reload(plain).fixingEdits).toBeUndefined();
  });

  it('an empty edit list is not an edit', () => {
    const doc: LayoutDoc = { ...solvedDoc(), fixingEdits: { removed: [], added: [] } };
    expect(serialize(doc)).not.toContain('fixingEdits');
    expect(reload(doc).fixingEdits).toBeUndefined();
  });

  it('reads a hostile file without believing it', () => {
    const base = solvedDoc();
    const cases: [unknown, unknown][] = [
      ['not an object', undefined],
      [{ removed: 'nope' }, undefined],
      [{ removed: [{ q: 'a', r: 2 }] }, undefined],
      [{ removed: [{ q: 1, r: 2 }, { q: 1, r: 2 }] }, { removed: [{ q: 1, r: 2 }] }],
    ];
    for (const [stored, expected] of cases) {
      const result = deserialize(JSON.stringify({ ...base, fixingEdits: stored }));
      expect(result.doc, JSON.stringify(stored)).not.toBeNull();
      expect(result.doc!.fixingEdits, JSON.stringify(stored)).toEqual(expected);
    }
  });
});

/**
 * A cell from which a fixing of `size` cells fits in SOME turn, on free cells —
 * where a dragged multi-cell fixing can legally land.
 */
function roomFor(s: Store, size: number): Hex {
  const footprint = size === 4
    ? [{ q: 0, r: 0 }, { q: 1, r: -1 }, { q: 1, r: 0 }, { q: 2, r: -1 }]
    : [{ q: 0, r: 0 }, { q: 0, r: 1 }];
  const doc = s.getState().doc;
  const plan = s.fixingPlan();
  const taken = new Set(plan.cells.map(hexKey));
  for (const j of plan.junctions) for (const c of j.cells) taken.add(hexKey(c));
  const onPlate = new Set(doc.panels.flatMap((p) => placedPanelCells(p)).map(hexKey));
  for (const k of [...onPlate].sort()) {
    if (taken.has(k)) continue;
    const [q, r] = k.split(',').map(Number) as [number, number];
    for (let rot = 0; rot < 6; rot++) {
      const cells = placeFootprint(footprint, { q, r }, rot as Rotation).map(hexKey);
      if (cells.every((c) => onPlate.has(c) && !taken.has(c))) return { q, r };
    }
  }
  throw new Error('no room on this wall');
}

/** A cell on a plate with no fixing in it — somewhere a fixing can legally go. */
function freeCell(s: Store): Hex {
  const doc = s.getState().doc;
  const plan = s.fixingPlan();
  const taken = new Set(plan.cells.map(hexKey));
  for (const j of plan.junctions) for (const c of j.cells) taken.add(hexKey(c));
  for (const panel of doc.panels) {
    for (let i = 0; i < panel.columns * panel.rows; i++) {
      const cell = {
        q: panel.origin.q + (i % panel.columns) - Math.floor(Math.floor(i / panel.columns) / 2),
        r: panel.origin.r + Math.floor(i / panel.columns),
      };
      if (!taken.has(hexKey(cell))) {
        // Only if the wall really has that cell — the offset above is the
        // panel's own stagger, and a wall cut round a zone may not.
        const onWall = doc.panels.some((p) =>
          p.origin.q <= cell.q && p.origin.r <= cell.r
          && cell.r < p.origin.r + p.rows);
        if (onWall) return cell;
      }
    }
  }
  throw new Error('no free cell on this wall');
}
