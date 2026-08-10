/**
 * persist.ts is the module that stands between the user and losing their work,
 * so it is tested the way an attacker would use it: every malformed input gets
 * its own assertion proving (a) nothing throws and (b) the failure is explained
 * in words a human can act on.
 */

import { describe, expect, it } from 'vitest';

import {
  CURRENT_SCHEMA,
  decodeShareUrl,
  deserialize,
  encodeShareUrl,
  migrate,
  serialize,
} from '../src/core/persist';
import type { LayoutDoc, Rotation } from '../src/core/types';

const BASE = 'https://hexwall.example/planner';

function makeDoc(overrides: Partial<LayoutDoc> = {}): LayoutDoc {
  return {
    schemaVersion: CURRENT_SCHEMA,
    id: 'doc-1',
    name: 'Garage wall',
    wall: { widthMm: 2400, heightMm: 1200 },
    bedId: 'bed256',
    panels: [{ id: 'p1', partId: 'panel-7x8', origin: { q: 0, r: 0 }, columns: 7, rows: 8 }],
    items: [
      { id: 'i1', partId: 'hook-25', at: { q: 2, r: 3 }, rotation: 1 },
      { id: 'i2', partId: 'bin-small', at: { q: -4, r: 0 }, rotation: 0, groupId: 'g1' },
    ],
    groups: [{ id: 'g1', label: 'Screwdrivers' }],
    ...overrides,
  };
}

function bigDoc(itemCount: number): LayoutDoc {
  const items = Array.from({ length: itemCount }, (_, i) => ({
    id: `item-${i}`,
    partId: i % 3 === 0 ? 'hook-25mm' : i % 3 === 1 ? 'bin-small-v2' : 'shelf-narrow',
    at: { q: (i % 17) - 8, r: Math.floor(i / 17) },
    rotation: (i % 6) as Rotation,
    ...(i % 5 === 0 ? { groupId: 'g1' } : {}),
  }));
  return makeDoc({ items, name: 'Two hundred things' });
}

/** Every hostile input must satisfy this: no throw, no doc-shaped lie, real words. */
function expectRejected(text: string, label: string): string[] {
  let result: ReturnType<typeof deserialize> | undefined;
  expect(() => {
    result = deserialize(text);
  }, `${label} must not throw`).not.toThrow();
  expect(result, label).toBeDefined();
  expect(result!.doc, `${label} must not produce a document`).toBeNull();
  expect(result!.errors.length, `${label} must explain itself`).toBeGreaterThan(0);
  for (const e of result!.errors) {
    expect(typeof e).toBe('string');
    expect(e.length).toBeGreaterThan(0);
  }
  return result!.errors;
}

// ---------------------------------------------------------------------------

describe('serialize', () => {
  it('produces pretty, parseable JSON', () => {
    const text = serialize(makeDoc());
    expect(text).toContain('\n  "id": "doc-1"');
    expect(text.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('is stable regardless of the order the object was built in', () => {
    const a = makeDoc();
    // Same data, keys inserted in a different order.
    const b: LayoutDoc = {
      groups: a.groups,
      items: a.items,
      panels: a.panels,
      bedId: a.bedId,
      wall: a.wall,
      name: a.name,
      id: a.id,
      schemaVersion: a.schemaVersion,
    };
    expect(serialize(b)).toBe(serialize(a));
  });

  it('omits optional fields that were never set', () => {
    const doc = makeDoc({ items: [{ id: 'i1', partId: 'p', at: { q: 0, r: 0 }, rotation: 0 }] });
    expect(serialize(doc)).not.toContain('groupId');
  });
});

describe('round trip', () => {
  it('deserialize(serialize(d)).doc deep-equals d', () => {
    const doc = makeDoc();
    const result = deserialize(serialize(doc));
    expect(result.errors).toEqual([]);
    expect(result.doc).toEqual(doc);
  });

  it('survives a 200-item layout unchanged', () => {
    const doc = bigDoc(200);
    const result = deserialize(serialize(doc));
    expect(result.errors).toEqual([]);
    expect(result.doc).toEqual(doc);
  });

  it('keeps awkward text intact: quotes, newlines, emoji, RTL', () => {
    const doc = makeDoc({ name: 'He said "hi"\nline two — 🐝 مرحبا' });
    expect(deserialize(serialize(doc)).doc).toEqual(doc);
  });

  it('keeps an empty layout empty rather than inventing content', () => {
    const doc = makeDoc({ panels: [], items: [], groups: [] });
    const result = deserialize(serialize(doc));
    expect(result.errors).toEqual([]);
    expect(result.doc).toEqual(doc);
  });
});

// ---------------------------------------------------------------------------
// The hostile pass. One assertion per named input.
// ---------------------------------------------------------------------------

describe('deserialize never throws', () => {
  it('on an empty string', () => {
    const errors = expectRejected('', 'empty string');
    expect(errors[0]).toMatch(/empty/i);
  });

  it('on whitespace only', () => {
    expectRejected('   \n\t  ', 'whitespace only');
  });

  it('on "null"', () => {
    const errors = expectRejected('null', '"null"');
    expect(errors.join(' ')).toMatch(/null/i);
  });

  it('on "{" — an unclosed object', () => {
    const errors = expectRejected('{', 'unclosed object');
    expect(errors.join(' ')).toMatch(/not valid JSON/i);
  });

  it('on truncated JSON that starts out looking like a document', () => {
    const text = serialize(makeDoc());
    expectRejected(text.slice(0, Math.floor(text.length / 2)), 'truncated document');
  });

  it('on a top-level array', () => {
    const errors = expectRejected('[1, 2, 3]', 'array');
    expect(errors.join(' ')).toMatch(/list of 3/);
  });

  it('on an empty array', () => {
    expectRejected('[]', 'empty array');
  });

  it('on a bare number', () => {
    const errors = expectRejected('42', 'number');
    expect(errors.join(' ')).toMatch(/42/);
  });

  it('on a bare string', () => {
    expectRejected('"just some text"', 'string');
  });

  it('on a bare boolean', () => {
    expectRejected('true', 'boolean');
  });

  it('on deeply nested junk', () => {
    const deep = '['.repeat(20000) + ']'.repeat(20000);
    expectRejected(deep, 'deeply nested arrays');
  });

  it('on a deeply nested object that parses successfully', () => {
    let nested = '{"x":1}';
    for (let i = 0; i < 500; i++) nested = `{"x":${nested}}`;
    const text = `{"schemaVersion":1,"id":"a","name":"n","wall":{"widthMm":1,"heightMm":1},"bedId":"b","panels":[],"items":[],"groups":[],"junk":${nested}}`;
    let result: ReturnType<typeof deserialize> | undefined;
    expect(() => {
      result = deserialize(text);
    }).not.toThrow();
    // The junk is not part of the schema, so it is simply not carried over.
    expect(result!.doc).not.toBeNull();
    expect(result!.doc).not.toHaveProperty('junk');
  });

  it('on a 50 MB string', () => {
    const huge = 'a'.repeat(50 * 1024 * 1024);
    const errors = expectRejected(huge, '50 MB string');
    expect(errors.join(' ')).toMatch(/MB/);
  });

  it('on JSON that is valid but is not a document at all', () => {
    let result: ReturnType<typeof deserialize> | undefined;
    expect(() => {
      result = deserialize('{"hello":"world"}');
    }).not.toThrow();
    // Salvage: an object is at least document-shaped, so defaults are applied
    // and every substitution is reported rather than performed silently.
    expect(result!.doc).not.toBeNull();
    expect(result!.doc!.items).toEqual([]);
    expect(result!.errors.length).toBeGreaterThan(0);
  });
});

describe('deserialize salvages what it can', () => {
  it('keeps the layout when items is "banana"', () => {
    const doc = makeDoc();
    const raw = JSON.parse(serialize(doc)) as Record<string, unknown>;
    raw['items'] = 'banana';
    const result = deserialize(JSON.stringify(raw));
    expect(result.doc).not.toBeNull();
    expect(result.doc!.items).toEqual([]);
    expect(result.doc!.panels).toHaveLength(1); // the rest of the wall survived
    expect(result.doc!.name).toBe('Garage wall');
    expect(result.errors.join(' ')).toMatch(/items should be a list/);
  });

  it('drops only the item that is missing `at`, and says which one', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'd',
      name: 'n',
      wall: { widthMm: 100, heightMm: 100 },
      bedId: 'mini',
      panels: [],
      items: [
        { id: 'ok-1', partId: 'hook', at: { q: 0, r: 0 }, rotation: 0 },
        { id: 'bad', partId: 'hook', rotation: 0 },
        { id: 'ok-2', partId: 'hook', at: { q: 1, r: 1 }, rotation: 2 },
      ],
      groups: [],
    });
    const result = deserialize(text);
    expect(result.doc!.items.map((i) => i.id)).toEqual(['ok-1', 'ok-2']);
    expect(result.errors.join('\n')).toMatch(/items\[1\]/);
  });

  it('drops non-integer hex coordinates by index', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: 'd',
      name: 'n',
      wall: { widthMm: 100, heightMm: 100 },
      bedId: 'mini',
      panels: [],
      items: [{ id: 'a', partId: 'p', at: { q: 1.5, r: 0 }, rotation: 0 }],
      groups: [],
    });
    const result = deserialize(text);
    expect(result.doc!.items).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/items\[0\]\.at\.q is 1\.5/);
  });

  it('drops Infinity coordinates (1e999 parses as Infinity)', () => {
    const text =
      '{"schemaVersion":1,"id":"d","name":"n","wall":{"widthMm":100,"heightMm":100},' +
      '"bedId":"mini","panels":[],"items":[{"id":"a","partId":"p","at":{"q":1e999,"r":0},"rotation":0}],"groups":[]}';
    const result = deserialize(text);
    expect(result.doc!.items).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/Infinity/);
  });

  it('drops NaN coordinates handed straight to migrate', () => {
    const result = migrate({
      schemaVersion: 1,
      id: 'd',
      name: 'n',
      wall: { widthMm: 100, heightMm: 100 },
      bedId: 'mini',
      panels: [],
      items: [
        { id: 'a', partId: 'p', at: { q: NaN, r: 0 }, rotation: 0 },
        { id: 'b', partId: 'p', at: { q: 0, r: 0 }, rotation: 0 },
      ],
      groups: [],
    });
    expect(result.doc!.items.map((i) => i.id)).toEqual(['b']);
    expect(result.errors.join('\n')).toMatch(/NaN/);
  });

  it('drops coordinates that are strings, null, or objects', () => {
    for (const bad of ['3', null, {}, [], true]) {
      const result = migrate({
        schemaVersion: 1,
        id: 'd',
        name: 'n',
        wall: { widthMm: 1, heightMm: 1 },
        bedId: 'mini',
        panels: [],
        items: [{ id: 'a', partId: 'p', at: { q: bad, r: 0 }, rotation: 0 }],
        groups: [],
      });
      expect(result.doc!.items, `q = ${JSON.stringify(bad)}`).toEqual([]);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('keeps items whose entries are null by dropping just those entries', () => {
    const result = migrate({
      schemaVersion: 1,
      id: 'd',
      name: 'n',
      wall: { widthMm: 1, heightMm: 1 },
      bedId: 'mini',
      panels: [],
      items: [null, { id: 'a', partId: 'p', at: { q: 0, r: 0 }, rotation: 0 }, 7, 'x'],
      groups: [],
    });
    expect(result.doc!.items.map((i) => i.id)).toEqual(['a']);
    expect(result.errors.filter((e) => e.startsWith('items['))).toHaveLength(3);
  });

  it('wraps an out-of-range rotation instead of losing the part', () => {
    const result = migrate({
      schemaVersion: 1,
      id: 'd',
      name: 'n',
      wall: { widthMm: 1, heightMm: 1 },
      bedId: 'mini',
      panels: [],
      items: [{ id: 'a', partId: 'p', at: { q: 0, r: 0 }, rotation: 7 }],
      groups: [],
    });
    expect(result.doc!.items[0]!.rotation).toBe(1);
    expect(result.errors.join(' ')).toMatch(/rotation/);
  });

  it('replaces a garbage rotation with 0 and keeps the part', () => {
    const result = migrate({
      schemaVersion: 1,
      id: 'd',
      name: 'n',
      wall: { widthMm: 1, heightMm: 1 },
      bedId: 'mini',
      panels: [],
      items: [{ id: 'a', partId: 'p', at: { q: 0, r: 0 }, rotation: 'sideways' }],
      groups: [],
    });
    expect(result.doc!.items[0]!.rotation).toBe(0);
  });

  it('substitutes defaults for a missing wall and says so', () => {
    const result = migrate({ schemaVersion: 1, id: 'd', name: 'n', bedId: 'mini' });
    expect(result.doc!.wall.widthMm).toBeGreaterThan(0);
    expect(result.doc!.wall.heightMm).toBeGreaterThan(0);
    expect(result.errors.join(' ')).toMatch(/wall/);
  });

  it('renames duplicate ids rather than merging two different parts', () => {
    const result = migrate({
      schemaVersion: 1,
      id: 'd',
      name: 'n',
      wall: { widthMm: 1, heightMm: 1 },
      bedId: 'mini',
      panels: [],
      items: [
        { id: 'same', partId: 'p', at: { q: 0, r: 0 }, rotation: 0 },
        { id: 'same', partId: 'p', at: { q: 1, r: 0 }, rotation: 0 },
      ],
      groups: [],
    });
    const ids = result.doc!.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
    expect(result.errors.join(' ')).toMatch(/used twice/);
  });

  it('drops a panel with impossible dimensions but keeps the rest', () => {
    const result = migrate({
      schemaVersion: 1,
      id: 'd',
      name: 'n',
      wall: { widthMm: 1, heightMm: 1 },
      bedId: 'mini',
      panels: [
        { id: 'p1', partId: 'panel', origin: { q: 0, r: 0 }, columns: 0, rows: 8 },
        { id: 'p2', partId: 'panel', origin: { q: 0, r: 0 }, columns: 7, rows: 8 },
      ],
      items: [],
      groups: [],
    });
    expect(result.doc!.panels.map((p) => p.id)).toEqual(['p2']);
    expect(result.errors.join('\n')).toMatch(/panels\[0\]/);
  });
});

describe('prototype pollution', () => {
  it('strips __proto__ from the top level without polluting Object.prototype', () => {
    const text =
      '{"schemaVersion":1,"id":"d","name":"n","wall":{"widthMm":1,"heightMm":1},"bedId":"mini",' +
      '"panels":[],"items":[],"groups":[],"__proto__":{"polluted":"yes"}}';
    const result = deserialize(text);
    expect(result.doc).not.toBeNull();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.getPrototypeOf(result.doc)).toBe(Object.prototype);
  });

  it('strips __proto__ nested inside an item', () => {
    const text =
      '{"schemaVersion":1,"id":"d","name":"n","wall":{"widthMm":1,"heightMm":1},"bedId":"mini",' +
      '"panels":[],"items":[{"id":"a","partId":"p","at":{"q":0,"r":0},"rotation":0,' +
      '"__proto__":{"nestedPollution":"yes"}}],"groups":[]}';
    const result = deserialize(text);
    expect(result.doc!.items).toHaveLength(1);
    expect(({} as Record<string, unknown>)['nestedPollution']).toBeUndefined();
    expect(Object.getPrototypeOf(result.doc!.items[0]!)).toBe(Object.prototype);
  });

  it('strips constructor and prototype keys', () => {
    const text =
      '{"schemaVersion":1,"id":"d","name":"n","wall":{"widthMm":1,"heightMm":1},"bedId":"mini",' +
      '"panels":[],"items":[],"groups":[],"constructor":{"prototype":{"owned":"yes"}},' +
      '"prototype":{"owned":"yes"}}';
    const result = deserialize(text);
    expect(result.doc).not.toBeNull();
    expect(({} as Record<string, unknown>)['owned']).toBeUndefined();
    expect(Object.keys(result.doc!)).not.toContain('constructor');
    expect(Object.keys(result.doc!)).not.toContain('prototype');
  });

  it('survives __proto__ handed to migrate as a live object', () => {
    const evil = JSON.parse('{"__proto__":{"live":"yes"},"items":[]}') as Record<string, unknown>;
    const result = migrate(evil);
    expect(({} as Record<string, unknown>)['live']).toBeUndefined();
    expect(result.doc).not.toBeNull();
  });
});

describe('migrate', () => {
  it('rejects things that are not documents', () => {
    for (const bad of [null, undefined, 42, 'text', true, [1, 2], Symbol('x')]) {
      const result = migrate(bad as unknown);
      expect(result.doc, String(String(bad))).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('stamps the current schema version onto an older document', () => {
    const result = migrate({
      schemaVersion: 0,
      id: 'd',
      name: 'n',
      wall: { widthMm: 1, heightMm: 1 },
      bedId: 'mini',
      panels: [],
      items: [],
      groups: [],
    });
    expect(result.doc!.schemaVersion).toBe(CURRENT_SCHEMA);
    expect(result.errors.join(' ')).toMatch(/Upgraded/);
  });

  it('warns loudly about a document from a newer build but still reads it', () => {
    const result = migrate({
      schemaVersion: CURRENT_SCHEMA + 5,
      id: 'd',
      name: 'n',
      wall: { widthMm: 1, heightMm: 1 },
      bedId: 'mini',
      panels: [],
      items: [{ id: 'a', partId: 'p', at: { q: 0, r: 0 }, rotation: 0 }],
      groups: [],
    });
    expect(result.doc!.items).toHaveLength(1);
    expect(result.errors.join(' ')).toMatch(/newer version/i);
  });

  it('does not choke on a cyclic object', () => {
    const cyclic: Record<string, unknown> = {
      schemaVersion: 1,
      id: 'd',
      name: 'n',
      wall: { widthMm: 1, heightMm: 1 },
      bedId: 'mini',
      panels: [],
      items: [],
      groups: [],
    };
    cyclic['self'] = cyclic;
    let result: ReturnType<typeof migrate> | undefined;
    expect(() => {
      result = migrate(cyclic);
    }).not.toThrow();
    expect(result!.doc).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

describe('share links', () => {
  it('round-trips a document exactly', () => {
    const doc = makeDoc();
    const url = encodeShareUrl(doc, BASE);
    const result = decodeShareUrl(url);
    expect(result.errors).toEqual([]);
    expect(result.doc).toEqual(doc);
  });

  it('puts the payload in the hash so it never reaches a server', () => {
    const url = encodeShareUrl(makeDoc(), BASE);
    expect(url.startsWith(`${BASE}#d=`)).toBe(true);
    expect(url.indexOf('?')).toBe(-1);
  });

  it('uses only URL-safe characters', () => {
    const url = encodeShareUrl(makeDoc({ name: 'quotes " slash / plus + emoji 🐝' }), BASE);
    const payload = url.slice(url.indexOf('#d=') + 3);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeShareUrl(url).doc!.name).toBe('quotes " slash / plus + emoji 🐝');
  });

  it('replaces an existing hash rather than appending to it', () => {
    const url = encodeShareUrl(makeDoc(), `${BASE}#d=stale`);
    expect(url.split('#')).toHaveLength(2);
    expect(decodeShareUrl(url).doc).not.toBeNull();
  });

  it('reads a payload sitting alongside other hash parameters', () => {
    const doc = makeDoc();
    const url = encodeShareUrl(doc, BASE);
    const payload = url.slice(url.indexOf('#d=') + 3);
    expect(decodeShareUrl(`${BASE}#view=wall&d=${payload}`).doc).toEqual(doc);
  });

  it('round-trips a 200-item layout and stays a usable length', () => {
    const doc = bigDoc(200);
    const url = encodeShareUrl(doc, BASE);
    const result = decodeShareUrl(url);
    expect(result.errors).toEqual([]);
    expect(result.doc).toEqual(doc);
    // Reported in the module notes; the hard limits that matter in the wild are
    // ~2 000 chars for old IE and ~8 000 for most servers — but this never hits
    // a server, and Chrome/Firefox handle megabyte-scale hashes.
    console.log(
      `[share url] 200 items: json ${serialize(doc).length} chars -> url ${url.length} chars`,
    );
    expect(url.length).toBeLessThan(100_000);
  });

  it('compresses: the link is much shorter than the raw JSON', () => {
    const doc = bigDoc(200);
    expect(encodeShareUrl(doc, BASE).length).toBeLessThan(serialize(doc).length / 2);
  });

  it('does not throw on a url with no hash', () => {
    const result = decodeShareUrl(BASE);
    expect(result.doc).toBeNull();
    expect(result.errors[0]).toMatch(/no layout/i);
  });

  it('does not throw on an empty hash', () => {
    expect(decodeShareUrl(`${BASE}#`).doc).toBeNull();
    expect(decodeShareUrl(`${BASE}#d=`).doc).toBeNull();
  });

  it('does not throw on a hash that is not base64 at all', () => {
    for (const junk of ['#d=!!!!!', '#d=🐝🐝🐝', '#d=%%%%', '#d=a b c']) {
      let result: ReturnType<typeof decodeShareUrl> | undefined;
      expect(() => {
        result = decodeShareUrl(BASE + junk);
      }, junk).not.toThrow();
      expect(result!.doc, junk).toBeNull();
      expect(result!.errors.length, junk).toBeGreaterThan(0);
    }
  });

  it('does not throw on base64 of the wrong length', () => {
    expect(decodeShareUrl(`${BASE}#d=A`).doc).toBeNull();
    expect(decodeShareUrl(`${BASE}#d=AAAAA`).doc).toBeNull();
  });

  it('does not throw on a truncated payload', () => {
    const url = encodeShareUrl(bigDoc(60), BASE);
    for (const cut of [4, 40, 400, url.length - 6]) {
      const chopped = url.slice(0, url.length - cut);
      let result: ReturnType<typeof decodeShareUrl> | undefined;
      expect(() => {
        result = decodeShareUrl(chopped);
      }, `cut ${cut}`).not.toThrow();
      expect(result!.errors.length, `cut ${cut}`).toBeGreaterThan(0);
    }
  });

  it('does not throw on a payload with random bytes flipped', () => {
    const url = encodeShareUrl(bigDoc(40), BASE);
    const head = url.slice(0, url.indexOf('#d=') + 3);
    const payload = url.slice(url.indexOf('#d=') + 3);
    for (let i = 0; i < payload.length; i += 37) {
      const mangled = `${head}${payload.slice(0, i)}A${payload.slice(i + 1)}`;
      expect(() => decodeShareUrl(mangled), `flip at ${i}`).not.toThrow();
    }
  });

  it('rejects an unknown payload format without throwing', () => {
    // 0xFF scheme byte, base64url of [0xff, 0x00, 0x00]
    const result = decodeShareUrl(`${BASE}#d=_wAA`);
    expect(result.doc).toBeNull();
    expect(result.errors.join(' ')).toMatch(/format/i);
  });

  it('does not throw on non-string or absurd input', () => {
    expect(decodeShareUrl('').doc).toBeNull();
    expect(decodeShareUrl(undefined as unknown as string).doc).toBeNull();
    expect(decodeShareUrl(('#d=' + 'A'.repeat(1000)) as string).doc).toBeNull();
  });

  it('works with a relative base', () => {
    const doc = makeDoc();
    const url = encodeShareUrl(doc, '/planner/');
    expect(url.startsWith('/planner/#d=')).toBe(true);
    expect(decodeShareUrl(url).doc).toEqual(doc);
  });

  it('round-trips text that stresses UTF-8 encoding', () => {
    const doc = makeDoc({ name: '𝕳𝖊𝖝 — ölçü 中文 🐝🐝 \u0000 end' });
    expect(decodeShareUrl(encodeShareUrl(doc, BASE)).doc).toEqual(doc);
  });
});
