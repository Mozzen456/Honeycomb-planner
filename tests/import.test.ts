/**
 * Importing a model file, end to end over the pure modules.
 *
 * The promise the import feature makes is that a part you add behaves exactly
 * like a part the scanner measured — same footprint rules, same requirement
 * rules, same BOM. So these tests import real models from `./models/` and check
 * the result against the catalogue entry the Python scanner produced for the
 * same file, then run the whole thing through the BOM and the exporters.
 */

import { describe, expect, it } from 'vitest';

import catalogJson from '../src/catalog/catalog.json';
import { computeBom } from '../src/core/bom';
import { BEDS } from '../src/core/constants';
import { toCsv, toMarkdownChecklist } from '../src/core/exporters';
import {
  bedsThatFit, proposeFromMesh, proposePart, slugify, typeFromName, withFootprint,
} from '../src/core/importPart';
import { parseStl } from '../src/core/stl';
import { emptyDoc } from '../src/core/store';
import {
  isImported, isUsablePart, mergeCatalog, orphanedIds, parseUserParts,
} from '../src/core/userCatalog';
import type { Catalog, Hex } from '../src/core/types';
import { loadModel } from './stl.test';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const catalog = catalogJson as unknown as Catalog;

function bytesOf(file: string): ArrayBuffer {
  const buf = readFileSync(resolve(__dirname, '..', file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

const part = (id: string) => catalog.parts.find((p) => p.id === id)!;

describe('proposePart', () => {
  it('measures a wall-clipping accessory the way the scanner did', () => {
    const original = part('20-micro-sd-card-holder');
    const { part: made, detection } = proposeFromMesh(
      '20-micro-sd-card-holder.stl', parseStl(bytesOf(original.file)), catalog,
    );

    expect(made.id).toBe('user/20-micro-sd-card-holder');
    expect(made.type).toBe(original.type);
    expect(made.footprint).toEqual(original.footprint);
    expect(detection.tier).toBe('wall-clip');
    expect(made.needsReview).toBe(false);
    expect(made.bboxMm[0]).toBeCloseTo(original.bboxMm[0]!, 3);
    expect(made.volumeMm3 / original.volumeMm3).toBeCloseTo(1, 4);
    // A wall clip carries its own interface, so it needs no insert.
    expect(made.requires).toEqual([]);
  });

  it('flags an insert-fed part instead of asserting its cells', () => {
    const { part: made, warnings } = proposeFromMesh('shelf-2.stl', parseStl(bytesOf(part('shelf-2').file)), catalog);
    expect(made.needsReview).toBe(true);
    expect(warnings.join(' ')).toMatch(/bound from the bounding box/i);
    expect(made.provenance.notes.join(' ')).toMatch(/FLAGGED/);
  });

  it('recovers a panel, its block and the beds it fits', () => {
    const original = part('wall-honeycomb-part');
    const { part: made } = proposeFromMesh(
      'wall-honeycomb-part.stl', parseStl(bytesOf(original.file)), catalog,
    );
    expect(made.type).toBe('panel');
    expect(made.panel?.columns).toBe(original.panel!.columns);
    expect(made.panel?.rows).toBe(original.panel!.rows);
    // A panel pulls in the countersunk inserts that hold it up, and NOT their
    // screws — those belong to the insert (the D11 double-count rule).
    expect(made.requires).toEqual([{ partId: 'insert-countersunk', count: 5 }]);
    expect(made.hardware).toEqual([]);
  });

  it('never claims a slicer profile it did not use', () => {
    const { part: made } = proposeFromMesh('shelf-1.stl', parseStl(bytesOf(part('shelf-1').file)), catalog);
    expect(made.print.source).toBe('volume');
    expect(made.print.profile).toBe('estimated/in-browser');
    expect(made.print.grams).toBeGreaterThan(0);
  });

  it('gives a colliding name a distinct id rather than overwriting', () => {
    const file = part('shelf-1').file;
    const first = proposeFromMesh('shelf-1.stl', parseStl(bytesOf(file)), catalog).part;
    const wider = mergeCatalog(catalog, [first]);
    const second = proposeFromMesh('shelf-1.stl', parseStl(bytesOf(file)), wider).part;
    expect(second.id).not.toBe(first.id);
    expect(second.id).toBe('user/shelf-1-2');
  });

  it('refuses bytes that are not a model, with a reason', async () => {
    const junk = new TextEncoder().encode('not an stl at all, just some text');
    await expect(proposePart('notes.txt', junk.buffer as ArrayBuffer, catalog)).rejects.toThrow();
  });

  /**
   * `proposePart` is the asynchronous front door — it reads the file, whatever
   * format it is, and hands the mesh to `proposeFromMesh`. Every other case in
   * this file goes through the synchronous core, so this is the one that proves
   * the two halves still meet.
   */
  it('reads an STL through the async front door and agrees with the sync core', async () => {
    const file = part('20-micro-sd-card-holder').file;
    const viaFile = await proposePart('20-micro-sd-card-holder.stl', bytesOf(file), catalog);
    const viaMesh = proposeFromMesh('20-micro-sd-card-holder.stl', parseStl(bytesOf(file)), catalog);
    expect(viaFile.part.footprint).toEqual(viaMesh.part.footprint);
    expect(viaFile.part.type).toBe(viaMesh.part.type);
    expect(viaFile.warnings).toEqual(viaMesh.warnings);
  });
});

describe('typeFromName and slugify', () => {
  it('reads the type the scanner would read from a name', () => {
    expect(typeFromName('wall-honeycomb-211x248.stl')).toBe('panel');
    expect(typeFromName('375x389-fixed.stl')).toBe('panel');
    expect(typeFromName('Insert-countersunk.stl')).toBe('fastener');
    expect(typeFromName('insert-m4.stl')).toBe('insert');
    expect(typeFromName('hook-side.stl')).toBe('accessory');
    expect(typeFromName('thing.stl')).toBe('unknown');
  });

  it('makes a safe id out of any file name', () => {
    expect(slugify('Wall Honeycomb (BIG).stl')).toBe('wall-honeycomb-big');
    expect(slugify('----.stl')).toBe('part');
    expect(slugify('ünïcödé.stl')).toBe('n-c-d');
  });
});

describe('withFootprint — the human correction', () => {
  const proposal = () => proposeFromMesh('shelf-2.stl', parseStl(bytesOf(part('shelf-2').file)), catalog).part;

  it('keeps the flag when the proposed footprint is merely accepted', () => {
    // Pressing Add without touching anything must not promote a bound to a
    // measurement — that is the whole honesty rule in PARKED.md P1.
    const kept = withFootprint(proposal(), proposal().footprint, catalog);
    expect(kept.needsReview).toBe(true);
  });

  it('clears the flag when the cells are actually drawn', () => {
    const cells: Hex[] = [{ q: 0, r: 0 }, { q: 1, r: 0 }];
    const edited = withFootprint(proposal(), cells, catalog);
    expect(edited.needsReview).toBe(false);
    expect(edited.footprint).toEqual(cells);
    expect(edited.provenance.notes.join(' ')).toMatch(/set by hand to 2 cell/);
  });

  it('never leaves a part with an empty footprint', () => {
    expect(withFootprint(proposal(), [], catalog).footprint).toEqual([{ q: 0, r: 0 }]);
  });

  it('recomputes a panel block and its printed size from the drawn cells', () => {
    const panel = proposeFromMesh(
      'wall-honeycomb-part.stl', parseStl(bytesOf(part('wall-honeycomb-part').file)), catalog,
    ).part;
    const cells: Hex[] = [
      { q: 0, r: 0 }, { q: 1, r: 0 },
      { q: 0, r: 1 }, { q: 1, r: 1 },
    ];
    const edited = withFootprint(panel, cells, catalog);
    expect(edited.panel).toEqual(
      expect.objectContaining({ columns: 2, rows: 2 }),
    );
    expect(edited.panel!.widthMm).toBeCloseTo(59, 0);
  });
});

describe('bedsThatFit', () => {
  it('lets a plate be turned on the bed', () => {
    // 240 x 200 does not fit a 210-deep MK3S as drawn, but does turned 90°.
    expect(bedsThatFit(240, 200, BEDS)).toContain('mk3s');
  });

  it('excludes a plate that fits nothing smaller', () => {
    expect(bedsThatFit(374.7, 389.4, BEDS)).toEqual(['bed400']);
  });
});

describe('the imported part inside the rest of the app', () => {
  const imported = () =>
    withFootprint(
      proposeFromMesh('my-hook.stl', parseStl(bytesOf(part('hook-to-empty').file)), catalog).part,
      [{ q: 0, r: 0 }],
      catalog,
    );

  it('merges without colliding, and is recognisable as imported', () => {
    const made = imported();
    const wider = mergeCatalog(catalog, [made]);
    expect(wider.parts).toHaveLength(catalog.parts.length + 1);
    expect(isImported(wider.parts.find((p) => p.id === made.id))).toBe(true);
    expect(isImported(part('shelf-1'))).toBe(false);
  });

  it('memoises the merge, so the BOM index is not rebuilt per render', () => {
    const parts = [imported()];
    expect(mergeCatalog(catalog, parts)).toBe(mergeCatalog(catalog, parts));
    expect(mergeCatalog(catalog, [])).toBe(catalog);
  });

  it('reaches the BOM, the CSV and the checklist marked as an estimate', () => {
    const made = imported();
    const wider = mergeCatalog(catalog, [made]);
    const doc = {
      ...emptyDoc(),
      items: [{ id: 'i1', partId: made.id, at: { q: 0, r: 0 }, rotation: 0 as const }],
    };
    const bom = computeBom(doc, wider);
    const line = bom.printed.find((l) => l.partId === made.id)!;

    expect(line.quantity).toBe(1);
    expect(line.estimated).toBe(true);
    expect(line.grams).toBeGreaterThan(0);

    const csv = toCsv(bom);
    expect(csv).toContain(made.id);
    // The per-unit column is the catalogue value, not the rounded total.
    expect(csv).toContain('print_estimated');
    expect(toMarkdownChecklist(bom, doc)).toMatch(/filament estimated/);
  });

  it('pulls in the insert it bolts to, exactly once per cell', () => {
    const made = imported();
    const wider = mergeCatalog(catalog, [made]);
    const doc = {
      ...emptyDoc(),
      items: [{ id: 'i1', partId: made.id, at: { q: 0, r: 0 }, rotation: 0 as const }],
    };
    const bom = computeBom(doc, wider);
    const required = made.requires[0];
    expect(required).toBeDefined();
    const fastener = bom.fasteners.find((l) => l.partId === required!.partId)!;
    expect(fastener.quantity).toBe(required!.count);

    // ...and does not ALSO buy that insert's bolt itself. One fixing passes
    // through one hole — the double-count class from D11/D20.
    const bolts = bom.shopping.filter((s) => /bolt/i.test(s.item));
    for (const bolt of bolts) {
      expect(bolt.count).toBeLessThanOrEqual(required!.count);
    }
  });
});

describe('userCatalog storage', () => {
  it('reads back what it wrote', () => {
    const made = proposeFromMesh('shelf-1.stl', parseStl(bytesOf(part('shelf-1').file)), catalog).part;
    const { parts, dropped } = parseUserParts(JSON.stringify([made]));
    expect(dropped).toEqual([]);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.id).toBe(made.id);
  });

  it('drops a corrupt entry and says which, rather than failing to load', () => {
    const made = proposeFromMesh('shelf-1.stl', parseStl(bytesOf(part('shelf-1').file)), catalog).part;
    const stored = JSON.stringify([made, { id: 'broken' }, { footprint: [] }]);
    const { parts, dropped } = parseUserParts(stored);
    expect(parts).toHaveLength(1);
    expect(dropped).toEqual(['broken', 'an unnamed entry']);
  });

  it('drops a duplicate id rather than letting two parts share one', () => {
    const made = proposeFromMesh('shelf-1.stl', parseStl(bytesOf(part('shelf-1').file)), catalog).part;
    const { parts, dropped } = parseUserParts(JSON.stringify([made, made]));
    expect(parts).toHaveLength(1);
    expect(dropped[0]).toContain('duplicate id');
  });

  it('survives junk in localStorage', () => {
    expect(parseUserParts(null)).toEqual({ parts: [], dropped: [], readable: true });
    expect(parseUserParts('')).toEqual({ parts: [], dropped: [], readable: true });
    expect(parseUserParts('{oh no').dropped[0]).toMatch(/not valid JSON/);
    expect(parseUserParts('{"parts":[]}').dropped[0]).toMatch(/not a list/);
  });

  /**
   * `readable` is the guard on the only DESTRUCTIVE thing in this module.
   *
   * "No imports yet" and "the store would not open" are both an empty list, and
   * `sweepOrphans` deletes every stored model and photo that no part claims. If
   * an unreadable store reported an empty list as fact, a browser that refused
   * localStorage once would cost somebody every model they had uploaded.
   */
  it('says whether the store was actually READ, not just whether it was empty', () => {
    expect(parseUserParts(null).readable).toBe(true);      // nothing stored — a real answer
    expect(parseUserParts('[]').readable).toBe(true);       // stored nothing — also a real answer
    expect(parseUserParts('{oh no').readable).toBe(false);  // cannot tell what is alive
    expect(parseUserParts('{"parts":[]}').readable).toBe(false);
  });

  it('a junk ENTRY still leaves the list readable — that row really is an orphan', () => {
    const made = proposeFromMesh('shelf-1.stl', parseStl(bytesOf(part('shelf-1').file)), catalog).part;
    const res = parseUserParts(JSON.stringify([made, { id: 'broken' }]));
    expect(res.readable).toBe(true);
    expect(res.dropped).toEqual(['broken']);
  });

  describe('orphanedIds — what an abandoned import leaves behind', () => {
    it('names stored ids that belong to no part', () => {
      expect(orphanedIds(['user/a', 'user/b', 'user/c'], [{ id: 'user/b' }]))
        .toEqual(['user/a', 'user/c']);
    });

    it('is one-directional: a part with no stored bytes is NOT rubbish', () => {
      // The model may simply have failed to store on a browser that refuses
      // IndexedDB. The part still plans, costs and exports.
      expect(orphanedIds([], [{ id: 'user/a' }])).toEqual([]);
    });

    it('keeps a SHIPPED part’s id, because a photo may be keyed on one', () => {
      // Photos are keyed on part id and nothing else, precisely so a shipped
      // part can have one. Sweeping against the imports alone would eat it.
      expect(orphanedIds(['hook-side'], [{ id: 'hook-side' }])).toEqual([]);
      expect(orphanedIds(['hook-side'], [{ id: 'user/mine' }])).toEqual(['hook-side']);
    });
  });

  it('rejects a part with no usable footprint or type', () => {
    expect(isUsablePart({ id: 'x', name: 'x', footprint: [{ q: 0 }], bboxMm: [1, 2, 3], print: {}, type: 'accessory' })).toBe(false);
    expect(isUsablePart({ id: 'x', name: 'x', footprint: [], bboxMm: [1, 2, 3], print: {}, type: 'nonsense' })).toBe(false);
    expect(isUsablePart(null)).toBe(false);
  });
});

describe('the models the app ships still parse', () => {
  it('every catalogue file is readable and non-empty', () => {
    for (const p of catalog.parts) {
      expect(loadModel(p.file).triangleCount, p.id).toBeGreaterThan(0);
    }
  });
});
