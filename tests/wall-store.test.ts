/**
 * The shelf of saved walls, and the working copy behind it.
 *
 * Two stores answering two different fears, and the tests are about the seams
 * between them:
 *
 *   - a wall put on the shelf twice is one wall, not two;
 *   - a shelf that has been hand-edited, truncated by a browser out of room, or
 *     written by an older build must lose the bad row and NOT the good ones;
 *   - a full shelf refuses rather than evicting, because a store that quietly
 *     drops your oldest wall to make room for your newest is worse than one that
 *     says no;
 *   - and a saved wall's photograph must be protected from the cache bound that
 *     `pruneWallPhotos` applies, which is the thing D88 could not do until a
 *     list of documents existed.
 */

import { describe, expect, it } from 'vitest';

import { serialize, deserialize } from '../src/core/persist';
import { emptyDoc } from '../src/core/store';
import {
  MAX_SAVED_WALLS, protectedPhotoIds, putWall, readWalls, removeWall, sortWalls, wallSummary,
  type SavedWall,
} from '../src/core/wallStore';
import type { LayoutDoc } from '../src/core/types';

const wall = (over: Partial<LayoutDoc> = {}): LayoutDoc => ({ ...emptyDoc(), ...over });

const entry = (over: Partial<SavedWall> = {}): SavedWall => ({
  id: 'w1', name: 'Garage', savedAt: 1000,
  widthMm: 2400, heightMm: 1200, plates: 6, items: 2,
  text: '{}', ...over,
});

describe('the summary a shelf row is listed from', () => {
  it('takes the figures off the document', () => {
    const doc = wall({
      id: 'abc', name: 'Workshop',
      wall: { widthMm: 1800, heightMm: 900 },
      panels: [{}, {}] as LayoutDoc['panels'],
      items: [{}] as LayoutDoc['items'],
    });
    expect(wallSummary(doc)).toEqual({
      id: 'abc', name: 'Workshop', widthMm: 1800, heightMm: 900, plates: 2, items: 1,
    });
  });

  /** An untitled wall still has to be findable on a shelf of them. */
  it('names a blank one rather than listing an empty row', () => {
    expect(wallSummary(wall({ name: '   ' })).name).toBe('Untitled wall');
    expect(wallSummary(wall({ name: '  Shed  ' })).name).toBe('Shed');
  });

  /** Carried so the photo bound can be told what is still spoken for. */
  it('records the photograph the wall needs kept', () => {
    const doc = wall({ photo: { id: 'wallphoto42' } as LayoutDoc['photo'] });
    expect(wallSummary(doc).photoId).toBe('wallphoto42');
    expect(wallSummary(wall()).photoId).toBeUndefined();
  });
});

describe('putting a wall on the shelf', () => {
  it('replaces the same wall rather than duplicating it', () => {
    const doc = wall({ id: 'w1', name: 'Garage' });
    const first = putWall([], doc, 'one', 1000).walls;
    const again = putWall(first, { ...doc, name: 'Garage v2' }, 'two', 2000).walls;
    expect(again).toHaveLength(1);
    expect(again[0]!.name).toBe('Garage v2');
    expect(again[0]!.text).toBe('two');
  });

  /** Two walls a person happened to name alike are still two walls. */
  it('keeps two different walls that share a name', () => {
    const a = putWall([], wall({ id: 'a', name: 'Wall' }), 'a', 1).walls;
    const b = putWall(a, wall({ id: 'b', name: 'Wall' }), 'b', 2).walls;
    expect(b.map((w) => w.id).sort()).toEqual(['a', 'b']);
  });

  it('lists the newest first', () => {
    let list = putWall([], wall({ id: 'a', name: 'A' }), 'a', 1000).walls;
    list = putWall(list, wall({ id: 'b', name: 'B' }), 'b', 3000).walls;
    list = putWall(list, wall({ id: 'c', name: 'C' }), 'c', 2000).walls;
    expect(list.map((w) => w.id)).toEqual(['b', 'c', 'a']);
  });

  /**
   * REFUSES, never evicts.
   *
   * The one behaviour a shelf must not have is losing something you put on it to
   * make room for something else — the entire point of it is that things stay
   * where they were put. The refusal is a sentence, because it is shown.
   */
  it('refuses past the bound instead of dropping the oldest', () => {
    let list: SavedWall[] = [];
    for (let i = 0; i < MAX_SAVED_WALLS; i++) {
      list = putWall(list, wall({ id: `w${i}`, name: `W${i}` }), 'x', i).walls;
    }
    expect(list).toHaveLength(MAX_SAVED_WALLS);

    const res = putWall(list, wall({ id: 'one-too-many' }), 'x', 9999);
    expect(res.refused).toMatch(/Delete one/);
    expect(res.walls).toHaveLength(MAX_SAVED_WALLS);
    expect(res.walls.some((w) => w.id === 'one-too-many')).toBe(false);
    // ...and the oldest is still there, which is the half that matters.
    expect(res.walls.some((w) => w.id === 'w0')).toBe(true);
  });

  /** A full shelf still takes an UPDATE to a wall already on it. */
  it('still saves over a wall that is already on a full shelf', () => {
    let list: SavedWall[] = [];
    for (let i = 0; i < MAX_SAVED_WALLS; i++) {
      list = putWall(list, wall({ id: `w${i}`, name: `W${i}` }), 'old', i).walls;
    }
    const res = putWall(list, wall({ id: 'w3', name: 'W3' }), 'new', 5000);
    expect(res.refused).toBeUndefined();
    expect(res.walls.find((w) => w.id === 'w3')!.text).toBe('new');
    expect(res.walls).toHaveLength(MAX_SAVED_WALLS);
  });
});

describe('reading a shelf back', () => {
  it('drops a malformed row and keeps the rest', () => {
    const read = readWalls([
      entry({ id: 'good', savedAt: 2 }),
      null,
      'nonsense',
      { id: 'no-text' },
      { text: 'no-id' },
      entry({ id: 'alsogood', savedAt: 1 }),
    ]);
    expect(read.map((w) => w.id)).toEqual(['good', 'alsogood']);
  });

  it('is empty for anything that is not a list', () => {
    for (const raw of [null, undefined, 42, 'x', {}]) expect(readWalls(raw)).toEqual([]);
  });

  it('fills in what an older build did not write', () => {
    const [w] = readWalls([{ id: 'w', text: '{}' }]);
    expect(w).toMatchObject({ name: 'Untitled wall', savedAt: 0, plates: 0, items: 0 });
  });

  /** A duplicate id would give two rows that Open and Delete cannot tell apart. */
  it('keeps only the first of a duplicated id', () => {
    const read = readWalls([entry({ id: 'w', text: 'first' }), entry({ id: 'w', text: 'second' })]);
    expect(read).toHaveLength(1);
    expect(read[0]!.text).toBe('first');
  });
});

describe('removing and ordering', () => {
  it('removes by id and leaves the others', () => {
    const list = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })];
    expect(removeWall(list, 'b').map((w) => w.id).sort()).toEqual(['a', 'c']);
  });

  it('removing something absent changes nothing', () => {
    const list = [entry({ id: 'a' })];
    expect(removeWall(list, 'nope')).toHaveLength(1);
  });

  /** Same timestamp must not mean a shelf that reshuffles between renders. */
  it('orders equal timestamps stably, by name then id', () => {
    const list = [
      entry({ id: 'z', name: 'B', savedAt: 5 }),
      entry({ id: 'a', name: 'A', savedAt: 5 }),
      entry({ id: 'b', name: 'A', savedAt: 5 }),
    ];
    expect(sortWalls(list).map((w) => w.id)).toEqual(['a', 'b', 'z']);
    expect(sortWalls(sortWalls(list)).map((w) => w.id)).toEqual(['a', 'b', 'z']);
  });
});

/**
 * The photographs the shelf still needs.
 *
 * `pruneWallPhotos` keeps the newest few and whatever it is told to protect.
 * Until there was a shelf, a saved layout's photo could not be spoken for at all
 * (D88); this is the answer, and getting it wrong means a wall comes back off
 * the shelf remembering exactly where its picture goes and unable to show it.
 */
describe('the photographs a saved wall keeps alive', () => {
  it('protects every saved wall and the open one', () => {
    const list = [
      entry({ id: 'a', photoId: 'p1' }),
      entry({ id: 'b' }),
      entry({ id: 'c', photoId: 'p2' }),
    ];
    expect(protectedPhotoIds(list, 'p3').sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('does not protect an empty id, which would keep nothing', () => {
    expect(protectedPhotoIds([entry({ photoId: '' })], '')).toEqual([]);
  });

  it('says each photo once, however many walls share it', () => {
    const list = [entry({ id: 'a', photoId: 'p' }), entry({ id: 'b', photoId: 'p' })];
    expect(protectedPhotoIds(list, 'p')).toEqual(['p']);
  });
});

/**
 * A wall on the shelf is the same text as a downloaded `.json`, so it migrates
 * through the same reader. If these ever diverge, a shelf written by one build
 * becomes unreadable by the next with nothing to say why.
 */
describe('the shelf stores the file format', () => {
  it('round-trips a document through save and open', () => {
    const doc = wall({ id: 'rt', name: 'Round trip', wall: { widthMm: 1500, heightMm: 800 } });
    const text = serialize(doc);
    const saved = putWall([], doc, text, 1234).walls[0]!;

    const back = deserialize(saved.text);
    expect(back.doc).toBeDefined();
    expect(back.doc!.id).toBe('rt');
    expect(back.doc!.name).toBe('Round trip');
    expect(back.doc!.wall).toEqual({ widthMm: 1500, heightMm: 800 });
  });

  /** The summary must describe the text beside it, not some other wall. */
  it('summarises the wall it stored', () => {
    const doc = wall({ id: 's', name: 'S', wall: { widthMm: 1000, heightMm: 500 } });
    const saved = putWall([], doc, serialize(doc), 1).walls[0]!;
    const back = deserialize(saved.text).doc!;
    expect([saved.widthMm, saved.heightMm]).toEqual([back.wall.widthMm, back.wall.heightMm]);
    expect(saved.plates).toBe(back.panels.length);
  });
});
