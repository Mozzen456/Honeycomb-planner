/**
 * Which PLATES a parts-list line is talking about.
 *
 * Clicking a line lights those plates on the wall, and the only way that can go
 * wrong is by lighting a plate the line does not count. That is not a display
 * question: a plate cut round a switch, sized by the app, or carrying an edge
 * has LEFT the stock line and is reported on a generated one (D56, D66), so the
 * mapping has to follow the same rule `computeBom` uses to build the lines.
 *
 * `panelsForLine` is that rule, stated once. These tests hold it to the parts
 * list itself — for every line on a wall, the plates it names are as many as the
 * line's own quantity — rather than to a hand-written list of ids, so a change
 * to how lines are grouped cannot leave the two agreeing on paper and differing
 * on screen.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import overridesJson from '../src/catalog/overrides.json';
import { computeBom, panelsForLine } from '../src/core/bom';
import { applyOverrides } from '../src/core/overrides';
import { emptyDoc } from '../src/core/store';
import { cutAroundObstacles } from '../src/core/store';
import { solveTiling, type PanelSize } from '../src/core/tiling';
import type { Catalog, LayoutDoc, Obstacle } from '../src/core/types';

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

/** A light switch in the middle of the wall, which cuts whichever plates it hits. */
const SWITCH: Obstacle = {
  id: 'switch',
  label: 'Light switch',
  xMm: 560,
  yMm: 420,
  widthMm: 86,
  heightMm: 86,
  clearanceMm: 4,
};

describe('panelsForLine', () => {
  it('names every plate a stock line counts, and only those', () => {
    const doc = solvedDoc();
    const bom = computeBom(doc, catalog);
    const panelLines = bom.printed.filter((l) => l.type === 'panel');
    expect(panelLines.length).toBeGreaterThan(0);

    const seen = new Set<string>();
    for (const line of panelLines) {
      const ids = panelsForLine(doc, line.partId);
      // The list says "12 of these": twelve plates must light up.
      expect(ids, line.partId).toHaveLength(line.quantity);
      // No plate belongs to two lines, or clicking one line would light
      // another's plates as well.
      for (const id of ids) {
        expect(seen.has(id), `${id} claimed twice`).toBe(false);
        seen.add(id);
      }
    }
    // Between them, the lines account for the whole wall.
    expect(seen.size).toBe(doc.panels.length);
  });

  it('gives a CUT plate to its generated line, not to the stock one', () => {
    const plain = solvedDoc();
    const doc: LayoutDoc = {
      ...plain,
      obstacles: [SWITCH],
      panels: cutAroundObstacles(plain.panels, [SWITCH], undefined),
    };
    const cut = doc.panels.filter((p) => (p.omit?.length ?? 0) > 0);
    expect(cut.length, 'the switch cut no plates').toBeGreaterThan(0);

    const bom = computeBom(doc, catalog);
    const custom = bom.printed.filter((l) => l.partId.startsWith('custom/'));
    expect(custom.length).toBeGreaterThan(0);

    // Every cut plate is named by exactly one custom line...
    const byCustom = new Set(custom.flatMap((l) => panelsForLine(doc, l.partId)));
    for (const p of cut) expect(byCustom.has(p.id), `${p.id} is cut but unclaimed`).toBe(true);

    // ...and by NO stock line, which is the whole point: the shipped file has no
    // hole in it, and lighting it from the stock line would say it does.
    for (const line of bom.printed.filter((l) => !l.partId.startsWith('custom/'))) {
      const ids = new Set(panelsForLine(doc, line.partId));
      for (const p of cut) expect(ids.has(p.id), `${p.id} claimed by ${line.partId}`).toBe(false);
    }
  });

  it('keeps a bordered plate out of the stock line as well', () => {
    const plain = solvedDoc();
    const frame = { left: true, right: true, top: true, bottom: true, holes: false, thicknessMm: 4 };
    const doc: LayoutDoc = {
      ...plain,
      frame,
      panels: cutAroundObstacles(plain.panels, undefined, frame),
    };
    const bom = computeBom(doc, catalog);

    for (const line of bom.printed.filter((l) => !l.partId.startsWith('custom/'))) {
      const ids = panelsForLine(doc, line.partId);
      expect(ids, `${line.partId} still claims bordered plates`).toHaveLength(line.quantity);
    }
    // And every plate on this wall is accounted for by SOME line.
    const all = new Set(bom.printed.flatMap((l) => panelsForLine(doc, l.partId)));
    expect(all.size).toBe(doc.panels.length);
  });

  it('answers nothing for an accessory, an unknown id, or an empty wall', () => {
    const doc = solvedDoc();
    expect(panelsForLine(doc, 'hook-to-empty')).toEqual([]);
    expect(panelsForLine(doc, 'custom/not-a-real-group')).toEqual([]);
    expect(panelsForLine(doc, '')).toEqual([]);
    expect(panelsForLine(emptyDoc(), 'wall-honeycomb-part')).toEqual([]);
    expect(panelsForLine(undefined, 'wall-honeycomb-part')).toEqual([]);
  });

  it('is a pure read — it does not touch the document', () => {
    const doc = solvedDoc();
    const before = JSON.stringify(doc);
    panelsForLine(doc, doc.panels[0]!.partId);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
