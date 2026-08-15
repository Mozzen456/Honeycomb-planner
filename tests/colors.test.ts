/**
 * What colour a thing on the wall is printed in.
 *
 * The whole feature is one question asked in four places — the plan, the 3D
 * view, the parts list and the exports — so the risk is not that a colour is
 * wrong, it is that two of those four answer differently. Everything here holds
 * `colors.ts` to the ORDER it promises, and the last block holds the parts list
 * to the same answer the views get.
 *
 * A colour is also the only user-supplied STRING this app paints with. It ends
 * up in a canvas `fillStyle` and a `THREE.Color`, both of which take arbitrary
 * text and do something unhelpful with what they cannot parse, so the reader
 * refuses anything that is not a hex colour — from a file, from a link, from a
 * command.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import overridesJson from '../src/catalog/overrides.json';
import { computeBom, panelLineKeys } from '../src/core/bom';
import {
  colorOfItem, colorOfLine, colorOfPanel, colorsInUse, hasColors, normaliseColor, readColors,
} from '../src/core/colors';
import { applyOverrides } from '../src/core/overrides';
import { deserialize, serialize } from '../src/core/persist';
import { Store, emptyDoc } from '../src/core/store';
import { shouldCommit, swatchColor } from '../src/ui/ColorSwatch';
import { solveTiling, type PanelSize } from '../src/core/tiling';
import type { Catalog, LayoutDoc, PlacedItem, WallColors } from '../src/core/types';

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

const item = (id: string, partId: string, q = 0): PlacedItem => ({
  id, partId, at: { q, r: 0 }, rotation: 0,
});

// ---------------------------------------------------------------------------

describe('normaliseColor', () => {
  it('takes a hex colour, in either length, in either case', () => {
    expect(normaliseColor('#ff8800')).toBe('#ff8800');
    expect(normaliseColor('#FF8800')).toBe('#ff8800');
    // Expanded, so everything downstream can assume one shape.
    expect(normaliseColor('#f80')).toBe('#ff8800');
    expect(normaliseColor('  #f80  ')).toBe('#ff8800');
  });

  it('refuses anything a canvas would accept and a person did not mean', () => {
    for (const bad of [
      'red', 'rgb(1,2,3)', 'transparent', '#12345', '#gggggg', 'ff8800',
      'url(evil)', '', '  ', null, undefined, 42, {}, ['#fff'],
    ]) {
      expect(normaliseColor(bad as unknown), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('the four levels, most specific first', () => {
  const colors: WallColors = {
    panels: '#ffffff',
    parts: '#111111',
    lines: { 'hook-to-empty': '#00aa00', 'wall-honeycomb-part': '#0000ff' },
    items: { i1: '#ff0000' },
  };

  it('gives an item its own colour before its line, and its line before the default', () => {
    expect(colorOfItem(colors, item('i1', 'hook-to-empty'))).toBe('#ff0000');
    expect(colorOfItem(colors, item('i2', 'hook-to-empty'))).toBe('#00aa00');
    expect(colorOfItem(colors, item('i3', 'shelf-1'))).toBe('#111111');
    expect(colorOfItem({}, item('i3', 'shelf-1'))).toBeUndefined();
  });

  it('gives a plate its line before the panel default', () => {
    expect(colorOfPanel(colors, 'wall-honeycomb-part')).toBe('#0000ff');
    expect(colorOfPanel(colors, 'wall-honeycomb-k1-211x201')).toBe('#ffffff');
    // A generated plate is keyed by its own line, not by the shipped part.
    expect(colorOfPanel({ lines: { 'custom/3x3||': '#abcdef' } }, 'custom/3x3||')).toBe('#abcdef');
    expect(colorOfPanel({}, 'anything')).toBeUndefined();
  });

  it('shows a line its own colour, or the default its KIND would fall back to', () => {
    expect(colorOfLine(colors, 'hook-to-empty', false)).toBe('#00aa00');
    expect(colorOfLine(colors, 'shelf-1', false)).toBe('#111111');   // parts default
    expect(colorOfLine(colors, 'wall-honeycomb-k1-211x201', true)).toBe('#ffffff'); // panels
    expect(colorOfLine({}, 'shelf-1', false)).toBeUndefined();
  });

  it('treats "no colour" as an answer, never as black', () => {
    // The absence of a decision. Nothing may fill it in — a swatch showing
    // #000000 says "your plates are black", which is a claim nobody made.
    expect(colorOfItem(undefined, item('i1', 'x'))).toBeUndefined();
    expect(colorOfPanel(undefined, 'x')).toBeUndefined();
    expect(hasColors(undefined)).toBe(false);
    expect(hasColors({})).toBe(false);
    expect(hasColors({ lines: {} })).toBe(false);
    expect(hasColors({ panels: '#fff' })).toBe(true);
  });
});

describe('readColors', () => {
  it('keeps what is a colour and drops what is not, key by key', () => {
    const read = readColors({
      panels: '#FFF',
      parts: 'chartreuse' as string,
      lines: { good: '#123456', bad: 'javascript:x' as string, '': '#fff' },
      items: { i1: '#abc' },
    });
    expect(read).toEqual({
      panels: '#ffffff',
      lines: { good: '#123456' },
      items: { i1: '#aabbcc' },
    });
    // Not `{parts: undefined}` — an absent key has to stay absent.
    expect('parts' in read).toBe(false);
  });

  it('survives rubbish in the shape of an object', () => {
    expect(readColors(undefined)).toEqual({});
    expect(readColors({ lines: 'nope' as unknown as Record<string, string> })).toEqual({});
  });
});

describe('the swatch itself', () => {
  it('shows what is being picked, then what it is, then what it inherits', () => {
    expect(swatchColor('#111111', '#222222', '#333333')).toBe('#111111');
    expect(swatchColor(null, '#222222', '#333333')).toBe('#222222');
    expect(swatchColor(null, undefined, '#333333')).toBe('#333333');
  });

  it('shows NOTHING when nothing has been chosen anywhere', () => {
    // The rule a tidy-up would break: a swatch of black is a decision nobody
    // made, and somebody would buy a spool for it.
    expect(swatchColor(null, undefined, undefined)).toBeUndefined();
  });

  /**
   * The commit rule. Two things it stops: an undo step for a picker dismissed
   * on the colour it opened on, and — worse — an INHERITED swatch freezing its
   * inherited colour into an override that then stops following the default.
   */
  it('commits only a real change', () => {
    expect(shouldCommit('#ff0000', '#00ff00')).toBe(true);
    expect(shouldCommit('#ff0000', undefined)).toBe(true);
    expect(shouldCommit('#ff0000', '#ff0000')).toBe(false);
    expect(shouldCommit('', '#ff0000')).toBe(false);
  });
});

describe('the store', () => {
  const store = (doc: LayoutDoc): Store => new Store(doc, catalog);
  const withItem = (): LayoutDoc => ({ ...solvedDoc(), items: [item('i1', 'hook-to-empty')] });

  it('sets and clears a default, and undoes', () => {
    const s = store(solvedDoc());
    s.setDefaultColor('panels', '#ff8800');
    expect(s.getState().doc.colors).toEqual({ panels: '#ff8800' });
    s.setDefaultColor('panels', undefined);
    // Cleared back to ABSENT, not to a colour that looks like the default.
    expect(s.getState().doc.colors).toBeUndefined();
    s.undo();
    expect(s.getState().doc.colors).toEqual({ panels: '#ff8800' });
  });

  it('paints a line and a placed item', () => {
    const s = store(withItem());
    s.setLineColor('hook-to-empty', '#00ff00');
    s.setItemColor(['i1'], '#0000ff');
    expect(s.getState().doc.colors).toEqual({
      lines: { 'hook-to-empty': '#00ff00' },
      items: { i1: '#0000ff' },
    });
    // The item wins, which is the point of having both.
    expect(colorOfItem(s.getState().doc.colors, item('i1', 'hook-to-empty'))).toBe('#0000ff');
  });

  it('paints a whole selection in ONE undo step', () => {
    const doc: LayoutDoc = {
      ...solvedDoc(),
      items: [item('i1', 'hook-to-empty', 0), item('i2', 'hook-to-empty', 2)],
    };
    const s = store(doc);
    s.setItemColor(['i1', 'i2'], '#123456');
    expect(Object.keys(s.getState().doc.colors?.items ?? {})).toEqual(['i1', 'i2']);
    s.undo();
    expect(s.getState().doc.colors).toBeUndefined();
  });

  it('refuses a colour that is not one, and stores nothing', () => {
    const s = store(withItem());
    s.setDefaultColor('parts', 'red');
    s.setLineColor('hook-to-empty', 'rgb(1,2,3)');
    s.setItemColor(['i1'], 'no');
    expect(s.getState().doc.colors).toBeUndefined();
    expect(s.getState().canUndo).toBe(false);
  });

  it('ignores an item it does not have, so a deletion cannot leave a colour behind', () => {
    const s = store(withItem());
    s.setItemColor(['ghost'], '#ff0000');
    expect(s.getState().doc.colors).toBeUndefined();
  });

  it('costs no undo step when nothing changes', () => {
    const s = store(withItem());
    s.setLineColor('hook-to-empty', '#00ff00');
    const after = s.getState();
    s.setLineColor('hook-to-empty', '#00FF00');   // same colour, said differently
    expect(s.getState().doc).toBe(after.doc);
  });

  it('clears everything in one step', () => {
    const s = store(withItem());
    s.setDefaultColor('panels', '#ffffff');
    s.setItemColor(['i1'], '#ff0000');
    s.clearColors();
    expect(s.getState().doc.colors).toBeUndefined();
    s.undo();
    expect(s.getState().doc.colors?.items).toEqual({ i1: '#ff0000' });
  });

  it('never mutates the document it was given', () => {
    const doc = withItem();
    const s = store(doc);
    s.setItemColor(['i1'], '#ff0000');
    expect(doc.colors).toBeUndefined();
  });
});

describe('the parts list says the same thing the wall does', () => {
  it('puts the resolved colour on every line, panels and parts alike', () => {
    const doc: LayoutDoc = {
      ...solvedDoc(),
      items: [item('i1', 'hook-to-empty')],
      colors: { panels: '#ffffff', parts: '#222222', lines: { 'hook-to-empty': '#00aa00' } },
    };
    const bom = computeBom(doc, catalog);
    const lines = panelLineKeys(doc);

    for (const line of bom.printed) {
      const expected = line.type === 'panel'
        ? colorOfPanel(doc.colors, line.partId)
        : colorOfLine(doc.colors, line.partId, false);
      expect(line.color, line.partId).toBe(expected);
    }
    // ...and a plate on the wall gets the same answer the list gives its line.
    for (const panel of doc.panels) {
      const lineKey = lines.get(panel.id)!;
      const onWall = colorOfPanel(doc.colors, lineKey);
      const onList = bom.printed.find((l) => l.partId === lineKey)?.color;
      expect(onWall, panel.id).toBe(onList);
    }
  });

  it('leaves the colour off a line nobody has coloured', () => {
    const bom = computeBom(solvedDoc(), catalog);
    for (const line of bom.printed) expect(line.color).toBeUndefined();
  });

  it('lists the colours a build actually USES, and no others', () => {
    const doc: LayoutDoc = {
      ...solvedDoc(),
      items: [item('i1', 'hook-to-empty')],
      // `#dddddd` is a line colour for a part that is not on this wall: a spool
      // nobody has to buy, and it must not appear.
      colors: {
        panels: '#ffffff',
        parts: '#222222',
        lines: { 'a-part-not-on-this-wall': '#dddddd' },
        items: { i1: '#ff0000' },
      },
    };
    const bom = computeBom(doc, catalog);
    const used = colorsInUse(doc, [...bom.printed, ...bom.fasteners]);

    expect(used).toContain('#ffffff');   // the plates
    expect(used).toContain('#ff0000');   // the one hook, painted itself
    /*
     * ...and the parts default, because the INSERTS fall back to it — the ones
     * the hook needs and the ones holding the plates up. Those are the
     * "fasteners already there": planned rather than placed, and printed all the
     * same. Reading the document instead of the parts list missed them.
     */
    expect(used).toContain('#222222');
    expect(bom.fasteners.every((l) => l.color === '#222222')).toBe(true);

    expect(used).not.toContain('#dddddd');
  });

  it('is empty for an uncoloured wall', () => {
    const doc = solvedDoc();
    const bom = computeBom(doc, catalog);
    expect(colorsInUse(doc, [...bom.printed, ...bom.fasteners])).toEqual([]);
  });
});

describe('colours round-trip', () => {
  const reload = (doc: LayoutDoc): LayoutDoc => {
    const result = deserialize(serialize(doc));
    expect(result.doc, result.errors.join('\n')).not.toBeNull();
    return result.doc!;
  };

  it('survives save and load', () => {
    const doc: LayoutDoc = {
      ...solvedDoc(),
      colors: { panels: '#ffffff', lines: { a: '#112233' }, items: { i1: '#445566' } },
    };
    expect(reload(doc).colors).toEqual(doc.colors);
  });

  /*
   * ONE base document, spread twice — the claim is about the order the swatches
   * were clicked and nothing else. Two separate `solvedDoc()` calls used to work
   * only because every document carried the same hard-coded id; they are unique
   * now that walls can be saved and the shelf is keyed on identity, and two
   * genuinely different documents are not the subject of this test.
   */
  it('is byte-identical however the swatches were clicked', () => {
    const base = solvedDoc();
    const a: LayoutDoc = { ...base, colors: { lines: { zebra: '#111111', alpha: '#222222' } } };
    const b: LayoutDoc = { ...base, colors: { lines: { alpha: '#222222', zebra: '#111111' } } };
    expect(serialize(a)).toBe(serialize(b));
  });

  it('an uncoloured layout serialises exactly as it always did', () => {
    const plain = solvedDoc();
    expect(serialize(plain)).not.toContain('colors');
    expect(reload(plain).colors).toBeUndefined();
  });

  it('drops a colour that is not one, rather than letting it reach a canvas', () => {
    const base = solvedDoc();
    const hostile = JSON.stringify({
      ...base,
      colors: {
        panels: 'javascript:alert(1)',
        parts: '#00ff00',
        lines: { good: '#123456', bad: 'url(http://evil)' },
        items: 'not an object',
      },
    });
    const result = deserialize(hostile);
    expect(result.doc).not.toBeNull();
    expect(result.doc!.colors).toEqual({ parts: '#00ff00', lines: { good: '#123456' } });
  });

  it('a document whose colours are ALL rubbish comes back with none', () => {
    const base = solvedDoc();
    const result = deserialize(JSON.stringify({ ...base, colors: { panels: 'red' } }));
    expect(result.doc!.colors).toBeUndefined();
  });
});
