/**
 * The project's parts list — the basket you shop into (D71).
 *
 * The rail no longer shows the whole catalogue; it shows what this wall is
 * built from. That makes the list a piece of the DOCUMENT, and a document field
 * has three ways to go wrong, all of them tested here:
 *
 *   - it can disagree with the wall. A part placed on the wall but missing from
 *     the list would leave the rail empty next to a wall covered in hooks —
 *     which is what every layout saved before this feature looks like.
 *   - it can fail to round-trip. A field that serialises and does not come back
 *     is a setting that applies for one session and vanishes on reload, which
 *     is exactly how the chosen fastener was lost (D44).
 *   - it can be rewritten on the way through. A shared layout naming somebody
 *     else's upload must come back naming it still.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { deserialize, serialize } from '../src/core/persist';
import {
  inProject, MAX_PROJECT_PARTS, projectPartIds, resolveProjectParts, withPartAdded,
  withPartRemoved, withPartsAdded,
} from '../src/core/projectParts';
import { Store, emptyDoc, __resetIds } from '../src/core/store';
import type { Catalog, CatalogPart, Hex, LayoutDoc } from '../src/core/types';

function part(id: string, extra: Partial<CatalogPart> = {}): CatalogPart {
  return {
    id,
    name: id,
    file: `models/${id}.stl`,
    type: 'accessory',
    group: '',
    footprint: [{ q: 0, r: 0 }] as Hex[],
    anchor: { q: 0, r: 0 },
    drawnOrientation: 'flat',
    bboxMm: [10, 10, 10],
    volumeMm3: 100,
    requires: [],
    hardware: [],
    print: { minutes: 10, grams: 1, metres: 0.3, profile: 'test', supports: false, source: 'sliced' },
    provenance: { basis: 'geometry', confidence: 1, notes: [] },
    sha256: 'x',
    ...extra,
  };
}

const catalog: Catalog = {
  schemaVersion: 1,
  generatedAt: '',
  slicerProfile: 'test',
  parts: [
    part('hook'),
    part('shelf'),
    part('bin'),
    part('plate', { type: 'panel', panel: { columns: 8, rows: 7, widthMm: 170, heightMm: 177, fitsBeds: [] } }),
  ],
  unresolved: [],
};

const doc = (over: Partial<LayoutDoc> = {}): LayoutDoc => ({ ...emptyDoc(), ...over });

beforeEach(__resetIds);

// ---------------------------------------------------------------------------

describe('what is in the project', () => {
  it('is empty on a new document, and the key is absent rather than empty', () => {
    const d = emptyDoc();
    expect(d.library).toBeUndefined();
    expect(projectPartIds(d)).toEqual([]);
  });

  it('keeps the order parts were added in', () => {
    const d = withPartsAdded(emptyDoc(), ['shelf', 'hook', 'bin']);
    expect(d.library).toEqual(['shelf', 'hook', 'bin']);
  });

  it('adding the same part twice changes nothing, and returns the SAME document', () => {
    const once = withPartAdded(emptyDoc(), 'hook');
    const twice = withPartAdded(once, 'hook');
    // Identity, not equality: the caller skips its undo step on this, so a fresh
    // object that happens to be equal would still cost a history entry.
    expect(twice).toBe(once);
  });

  it('counts a PLACED part as in the project even when the list does not name it', () => {
    // This is every layout saved before the list existed. Without this the rail
    // opens empty next to a wall covered in parts.
    const d = doc({ items: [{ id: 'i1', partId: 'hook', at: { q: 0, r: 0 }, rotation: 0 }] });
    expect(d.library).toBeUndefined();
    expect(inProject(d, 'hook')).toBe(true);
    expect(projectPartIds(d)).toEqual(['hook']);
  });

  it('does not list a placed part twice when it is also chosen', () => {
    const d = withPartAdded(
      doc({ items: [{ id: 'i1', partId: 'hook', at: { q: 0, r: 0 }, rotation: 0 }] }),
      'hook',
    );
    expect(projectPartIds(d)).toEqual(['hook']);
  });

  it('removing the last part takes the key away again', () => {
    const added = withPartAdded(emptyDoc(), 'hook');
    const removed = withPartRemoved(added, 'hook');
    expect(removed.library).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(removed, 'library')).toBe(false);
  });

  it('refuses to grow past its ceiling', () => {
    let d = emptyDoc();
    for (let i = 0; i < MAX_PROJECT_PARTS + 10; i++) d = withPartAdded(d, `p${i}`);
    expect(d.library).toHaveLength(MAX_PROJECT_PARTS);
  });
});

describe('resolving the project against a catalogue', () => {
  it('returns the real parts, in list order', () => {
    const d = withPartsAdded(emptyDoc(), ['bin', 'hook']);
    const { parts, missing } = resolveProjectParts(d, catalog);
    expect(parts.map((p) => p.id)).toEqual(['bin', 'hook']);
    expect(missing).toEqual([]);
  });

  it('leaves PANELS out of the rail — the tiler chooses those, not the shopper', () => {
    const d = withPartsAdded(emptyDoc(), ['plate', 'hook']);
    expect(resolveProjectParts(d, catalog).parts.map((p) => p.id)).toEqual(['hook']);
  });

  it('reports an id the catalogue does not have instead of dropping it', () => {
    // A shared layout naming somebody else's upload. Silently coming up short
    // is indistinguishable from a bug.
    const d = withPartsAdded(emptyDoc(), ['hook', 'user/somebody-elses-thing']);
    const { parts, missing } = resolveProjectParts(d, catalog);
    expect(parts.map((p) => p.id)).toEqual(['hook']);
    expect(missing).toEqual(['user/somebody-elses-thing']);
  });
});

// ---------------------------------------------------------------------------

describe('the store commands', () => {
  const store = (): Store => new Store(emptyDoc(), catalog);

  it('placing a part puts it in the project', () => {
    const s = store();
    s.setPanels([{ id: 'p0', partId: 'plate', origin: { q: 0, r: 0 }, columns: 8, rows: 7 }]);
    const at = s.firstFittingCell('hook');
    expect(at).not.toBeNull();
    expect(s.addItem('hook', at!).ok).toBe(true);
    expect(s.getState().doc.library).toEqual(['hook']);
  });

  it('adding is one undo step, and undo takes the part back out', () => {
    const s = store();
    s.addToProject(['hook', 'shelf']);
    expect(s.getState().doc.library).toEqual(['hook', 'shelf']);
    s.undo();
    expect(s.getState().doc.library).toBeUndefined();
  });

  it('adding a part that is already there costs no undo step', () => {
    const s = store();
    s.addToProject(['hook']);
    s.addToProject(['hook']);
    s.undo();
    expect(s.getState().doc.library).toBeUndefined();
  });

  it('refuses to remove a part the wall is using, and says how many', () => {
    const s = store();
    s.setPanels([{ id: 'p0', partId: 'plate', origin: { q: 0, r: 0 }, columns: 8, rows: 7 }]);
    s.addItem('hook', s.firstFittingCell('hook')!);
    const result = s.removeFromProject('hook');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/1 placement/);
    // ...and it really is still there, rather than the message being cosmetic.
    expect(s.getState().doc.library).toEqual(['hook']);
  });

  it('removes a part nothing is using', () => {
    const s = store();
    s.addToProject(['hook', 'shelf']);
    expect(s.removeFromProject('hook').ok).toBe(true);
    expect(s.getState().doc.library).toEqual(['shelf']);
  });
});

// ---------------------------------------------------------------------------

describe('the list survives a save and a load', () => {
  it('round-trips exactly', () => {
    const before = withPartsAdded(emptyDoc(), ['shelf', 'hook', 'user/my-thing']);
    const after = deserialize(serialize(before)).doc;
    expect(after?.library).toEqual(['shelf', 'hook', 'user/my-thing']);
  });

  it('a document with no list round-trips to the same bytes it always had', () => {
    // The absent-key rule. A layout saved before the library existed must not
    // start differing from its own reload.
    const plain = emptyDoc();
    const text = serialize(plain);
    expect(text).not.toContain('library');
    expect(deserialize(text).doc?.library).toBeUndefined();
  });

  it('adding a part and taking it away again leaves the file unchanged', () => {
    const plain = emptyDoc();
    const there = withPartAdded(plain, 'hook');
    const back = withPartRemoved(there, 'hook');
    expect(serialize(back)).toBe(serialize(plain));
  });

  it('drops junk entries with an explanation rather than throwing', () => {
    const res = deserialize(JSON.stringify({
      ...emptyDoc(),
      library: ['hook', 42, '', 'hook', { q: 1 }, 'shelf'],
    }));
    expect(res.doc?.library).toEqual(['hook', 'shelf']);
    expect(res.errors.join(' ')).toMatch(/listed twice/);
  });

  it('caps a hostile list', () => {
    const huge = Array.from({ length: MAX_PROJECT_PARTS + 500 }, (_, i) => `p${i}`);
    const res = deserialize(JSON.stringify({ ...emptyDoc(), library: huge }));
    expect(res.doc?.library).toHaveLength(MAX_PROJECT_PARTS);
    expect(res.errors.join(' ')).toMatch(/more than/);
  });

  it('a library that is not a list does not take the layout down with it', () => {
    const res = deserialize(JSON.stringify({ ...emptyDoc(), library: 'hook' }));
    expect(res.doc).not.toBeNull();
    expect(res.doc?.library).toBeUndefined();
  });
});
