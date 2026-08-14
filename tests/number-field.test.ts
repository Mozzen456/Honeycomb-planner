/**
 * The rule that decides when a half-typed number counts.
 *
 * "I cannot clear the field to type 1000" is a bug a type check cannot see and a
 * screenshot cannot show, so it is pinned here. The failure: a controlled
 * `<input type="number">` whose handler does `Number(e.target.value)` turns an
 * empty field into `0`, the document clamps that up to its minimum, and the
 * field repaints before the second digit lands — so typing "1000" over "2400"
 * produces "501000", or nothing, depending on where the caret ended up.
 *
 * The component is a shell over these three functions, which is why they are
 * what the tests hold: no DOM, no test-renderer dependency, and the rule stated
 * where it can be read.
 */

import { describe, expect, it } from 'vitest';

import { formatValue, valueOnBlur, valueWhileTyping } from '../src/ui/NumberField';
import { MAX_WALL_MM, MIN_WALL_MM } from '../src/core/store';
import { MAX_BORDER_MM, MIN_BORDER_MM } from '../src/core/honeycomb';
import { MIN_ZONE_MM } from '../src/core/measure';

const wall = (text: string) => valueWhileTyping(text, MIN_WALL_MM, MAX_WALL_MM);

describe('while typing', () => {
  it('commits nothing for an empty field', () => {
    // The whole bug in one line: empty must mean "not yet", never zero.
    expect(wall('')).toBeNull();
  });

  it('commits nothing for a number still below the minimum', () => {
    // Typing 1 → 10 → 100 → 1000. The first two are on the way somewhere; a
    // wall does not become 50 mm wide twice en route.
    expect(wall('1')).toBeNull();
    expect(wall('10')).toBeNull();
    expect(wall('100')).toBe(100);
    expect(wall('1000')).toBe(1000);
  });

  it('commits nothing for anything that is not a number', () => {
    for (const junk of ['', '-', '.', '-.', 'abc', 'e5', '--5', ' ']) {
      expect(wall(junk), junk).toBeNull();
    }
  });

  it('never returns NaN or Infinity', () => {
    for (const text of ['', '-', 'abc', '1e999', 'Infinity', '-Infinity', '1e']) {
      const v = wall(text);
      expect(v === null || Number.isFinite(v), text).toBe(true);
    }
  });

  it('refuses a value past the ceiling rather than clamping mid-word', () => {
    expect(wall(String(MAX_WALL_MM))).toBe(MAX_WALL_MM);
    expect(wall(String(MAX_WALL_MM + 1))).toBeNull();
  });

  it('takes a partly-typed decimal without losing the point', () => {
    // "2." parses as 2 and must be treated on its merits, not discarded — the
    // field is still showing what was typed either way.
    expect(valueWhileTyping('2.', MIN_BORDER_MM, MAX_BORDER_MM)).toBe(2);
    expect(valueWhileTyping('2.4', MIN_BORDER_MM, MAX_BORDER_MM)).toBe(2.4);
    expect(valueWhileTyping('0.2', MIN_BORDER_MM, MAX_BORDER_MM)).toBeNull();
  });
});

describe('when the field is left', () => {
  it('keeps what the document has if the field was abandoned empty', () => {
    expect(valueOnBlur('', 2400, MIN_WALL_MM, MAX_WALL_MM)).toBeNull();
    expect(valueOnBlur('abc', 2400, MIN_WALL_MM, MAX_WALL_MM)).toBeNull();
  });

  it('clamps an out-of-range number rather than discarding it', () => {
    // By the time you have tabbed away, "10" is a request for the smallest legal
    // wall, not a typo — refusing it silently would leave the old value with no
    // hint that anything was ignored.
    expect(valueOnBlur('10', 2400, MIN_WALL_MM, MAX_WALL_MM)).toBe(MIN_WALL_MM);
    expect(valueOnBlur('999999', 2400, MIN_WALL_MM, MAX_WALL_MM)).toBe(MAX_WALL_MM);
  });

  it('says nothing when the value has not changed', () => {
    // So tabbing through a form is not an undo step per field.
    expect(valueOnBlur('2400', 2400, MIN_WALL_MM, MAX_WALL_MM)).toBeNull();
  });

  it('commits a good value', () => {
    expect(valueOnBlur('1000', 2400, MIN_WALL_MM, MAX_WALL_MM)).toBe(1000);
  });
});

describe('how a resting value reads', () => {
  it('shows a whole millimetre with no decimal point', () => {
    expect(formatValue(2400, 0)).toBe('2400');
    expect(formatValue(2400.4, 0)).toBe('2400');
  });

  it('shows a thickness to one place, without a trailing zero', () => {
    expect(formatValue(3.6, 1)).toBe('3.6');
    expect(formatValue(3, 1)).toBe('3');
  });

  it('shows nothing for a value that is not one', () => {
    expect(formatValue(Number.NaN, 0)).toBe('');
    expect(formatValue(Number.POSITIVE_INFINITY, 1)).toBe('');
  });
});

describe('the ranges it is given', () => {
  it('match the store\'s own clamp, so the field cannot refuse a legal wall', () => {
    // Two copies of this range and the field would reject a size the document
    // would have accepted, with nothing on screen to explain it.
    expect(MIN_WALL_MM).toBe(50);
    expect(MAX_WALL_MM).toBe(20000);
  });

  it('keeps the border thickness inside what one ring of cells can reach', () => {
    expect(MIN_BORDER_MM).toBeGreaterThan(0);
    expect(MIN_BORDER_MM).toBeLessThan(MAX_BORDER_MM);
  });
});

describe('holding a value back until it is confirmed', () => {
  /**
   * `commitOn: "confirm"` is the same two functions used differently — the
   * component simply does not call `valueWhileTyping` — so what is worth pinning
   * is that the two rules stay independent, and that blur still resolves.
   */
  it('still resolves on the way out, so a typed measurement is never lost', () => {
    // The one thing a deferred field must not do: swallow what was typed.
    expect(valueOnBlur('220', 146, MIN_WALL_MM, MAX_WALL_MM)).toBe(220);
  });

  it('still refuses junk on the way out', () => {
    expect(valueOnBlur('', 146, MIN_WALL_MM, MAX_WALL_MM)).toBeNull();
    expect(valueOnBlur('abc', 146, MIN_WALL_MM, MAX_WALL_MM)).toBeNull();
  });

  it('would have committed three times per measurement while typing', () => {
    // Why the mode exists, stated as the cost it avoids: typing "220" over
    // "146" commits at 2, 22 and 220, and each commit re-cuts every plate on
    // the wall and leaves an undo step.
    const commits = ['2', '22', '220']
      .map((t) => valueWhileTyping(t, MIN_ZONE_MM, MAX_WALL_MM))
      .filter((v) => v !== null);
    expect(commits).toEqual([22, 220]);
  });
});
