/**
 * A number input you can actually type into.
 *
 * The obvious controlled number input is unusable for a measurement, and the
 * reason is worth stating because it is easy to write again:
 *
 *     <input type="number" value={mm} onChange={e => setMm(Number(e.target.value))} />
 *
 * Clear it to type a new value and `Number('')` is `0`. The `0` goes into the
 * document, the document clamps it to whatever the minimum is, and the field
 * repaints as `50` before the second digit lands. Typing "1000" over "2400" then
 * produces "501000", or nothing, depending on where the caret ends up. The value
 * is never wrong for long enough to notice — the field just refuses to be
 * emptied.
 *
 * So the text being edited is LOCAL, and the number is committed separately:
 *
 *   - while typing, the field shows exactly what was typed, including empty;
 *   - a value is committed only when it parses AND is in range, so the half-typed
 *     "1" on the way to "1000" never resizes the wall to its minimum;
 *   - on blur the draft is dropped, so the field goes back to showing the real
 *     value — clamped, formatted, and agreeing with the document again;
 *   - Enter commits and Escape abandons, because a field you can type into is a
 *     field someone will expect those from.
 *
 * `PartInspector` had already worked this out for its six seating numbers; this
 * is that, extracted, so the wall size and the zone sizes get it too rather than
 * a third copy appearing later.
 */

import { useRef, useState } from 'react';

export interface NumberFieldProps {
  value: number;
  /** Called with a parsed, in-range number. Never called with NaN. */
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Decimal places to show when the field is not being edited. */
  decimals?: number;
  /**
   * When the number reaches the document.
   *
   * `type` (default) commits every in-range keystroke, which is what you want
   * for a value with a live preview — the wall size, where seeing it resize as
   * you type is the point.
   *
   * `confirm` holds it until Enter, OK, or leaving the field. For a value whose
   * commit is EXPENSIVE or destructive: typing `220` into a blocked zone's width
   * otherwise re-cuts every plate on the wall three times over, at `2`, `22` and
   * `220`, and leaves three undo steps behind.
   */
  commitOn?: 'type' | 'confirm';
  className?: string;
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * What to commit for the text currently in the field, or null for "nothing yet".
 *
 * Pure, and separate from the component, because this is the whole feature: the
 * rule about when a half-typed number counts. `null` while the text is empty or
 * out of range is what lets "1" on the way to "1000" pass without resizing the
 * wall to its minimum first.
 */
export function valueWhileTyping(text: string, min: number, max: number): number | null {
  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < min || parsed > max) return null;
  return parsed;
}

/**
 * What to commit when the field is left, or null to keep what the document has.
 *
 * Out of range CLAMPS here rather than being refused: by the time someone has
 * tabbed away, "10" in a field with a floor of 50 is a request for the smallest
 * legal wall, not a typo to discard. Unparseable text is discarded, because
 * there is no number in it to honour.
 */
export function valueOnBlur(
  text: string,
  current: number,
  min: number,
  max: number,
): number | null {
  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed)) return null;
  const fixed = clamp(parsed, min, max);
  return fixed === current ? null : fixed;
}

/** How a committed value is shown when nobody is typing into it. */
export function formatValue(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '';
  return decimals > 0
    ? value.toFixed(decimals).replace(/\.?0+$/, '')
    : String(Math.round(value));
}

export function NumberField(props: NumberFieldProps) {
  const {
    value, onCommit, min = -Infinity, max = Infinity, step, decimals = 0,
    commitOn = 'type', className, disabled, title,
  } = props;

  /**
   * What the user has typed. `null` means "show the real value".
   *
   * While it is non-null the draft owns the display, so a value arriving from
   * outside — undo, a preset, the other half of a width × height pair — does not
   * yank the caret out of a half-typed number. Blur hands the display back.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const committed = useRef(value);
  committed.current = value;

  return (
    <input
      type="number"
      className={className}
      disabled={disabled}
      title={title}
      aria-label={props['aria-label']}
      inputMode="decimal"
      step={step}
      min={Number.isFinite(min) ? min : undefined}
      max={Number.isFinite(max) ? max : undefined}
      value={draft ?? formatValue(value, decimals)}
      onChange={(e) => {
        setDraft(e.target.value);
        if (commitOn === 'confirm') return;
        const next = valueWhileTyping(e.target.value, min, max);
        if (next !== null) onCommit(next);
      }}
      onBlur={(e) => {
        const next = valueOnBlur(e.target.value, committed.current, min, max);
        if (next !== null) onCommit(next);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
          return;
        }
        if (e.key === 'Escape') {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
