/**
 * A colour you can pick, confirm, clear, and see at a glance.
 *
 * One component for all three places colours are chosen — the two defaults in
 * the top bar, the swatch on a parts-list line, and the one that paints the
 * selection — because they are the same control answering the same question,
 * and two copies would drift the moment one learnt something the other did not.
 * That is the shape of D50, D52 and D66.
 *
 * **Nothing reaches the wall until OK.** This started as a bare
 * `<input type="color">`, which was wrong twice over. React's `onChange` on one
 * is the native `input` event, so the wall repainted continuously while a colour
 * was being chosen and every shade passed through went on the undo stack; and
 * moving the commit to the native `change` event fixed that while leaving a
 * control with **no OK button in it** — on macOS the system Colours panel has
 * none, so there was no moment a person could point at and say "now". A popover
 * with Cancel and OK is that moment. The native picker is still in there, behind
 * "Custom…", for a colour the presets do not have.
 *
 * **An unset colour is not a colour.** A native picker cannot be empty: it shows
 * `#000000` when handed nothing, which reads as "your plates are black" rather
 * than "you have not chosen". So an unset swatch hatches, and `undefined`
 * survives all the way through `swatchColor`.
 *
 * The popover is PORTALLED to the body: the parts list scrolls and clips
 * (`contain: layout paint` on `.bom-panel__scroll`), so a popover rendered in
 * the row would be cut off at the panel's edge — which is exactly where the
 * swatches are.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { normaliseColor } from '../core/colors';

import './ColorSwatch.css';

/**
 * What the well shows: what is being picked, else what this thing IS, else what
 * it inherits — and `undefined` when none of those exist, which the CSS draws as
 * a hatch.
 *
 * Pure and exported so the rule can be held to a contract without a DOM, the
 * way `NumberField`'s `valueWhileTyping` is. The rule it protects is the one
 * that is easy to break by "tidying": `undefined` must never become a colour,
 * because a swatch of black says a decision was made that was not.
 */
export function swatchColor(
  draft: string | null,
  value: string | undefined,
  fallback: string | undefined,
): string | undefined {
  return draft ?? value ?? fallback;
}

/**
 * Does this pick reach the document?
 *
 * Only on a real change. A picker closed on the colour it opened on has decided
 * nothing, and committing anyway would spend an undo step on it — and, on an
 * INHERITED swatch, would freeze the inherited colour into an override that then
 * stops following the default it came from.
 */
export function shouldCommit(picked: string, value: string | undefined): boolean {
  return picked.length > 0 && picked !== value;
}

/**
 * Filament colours, for the quick row.
 *
 * DATA, not design tokens: `tokens.css` owns the colours the app draws ITSELF
 * in, and these are the spools a person is likely to own. Chosen to be
 * distinguishable from each other on a small swatch and against both themes'
 * walls, which is why there is one grey and not three.
 */
const PRESETS: readonly { hex: string; name: string }[] = [
  { hex: '#f2f2ef', name: 'White' },
  { hex: '#9aa0a6', name: 'Grey' },
  { hex: '#1a1a1a', name: 'Black' },
  { hex: '#c62828', name: 'Red' },
  { hex: '#ef6c00', name: 'Orange' },
  { hex: '#f9c000', name: 'Yellow' },
  { hex: '#2e7d32', name: 'Green' },
  { hex: '#1565c0', name: 'Blue' },
  { hex: '#6a1b9a', name: 'Purple' },
  { hex: '#c2185b', name: 'Pink' },
  { hex: '#795548', name: 'Brown' },
  { hex: '#00897b', name: 'Teal' },
];

export interface ColorSwatchProps {
  /** The chosen colour, or undefined for "as the theme draws it". */
  value: string | undefined;
  /**
   * What the swatch shows when nothing is chosen — the colour this thing would
   * fall back to. The picker opens on it, so the first nudge is from what is on
   * screen rather than from black.
   */
  fallback?: string;
  onChange: (color: string) => void;
  /** Absent means the colour cannot be cleared (nothing to fall back to). */
  onClear?: () => void;
  label: string;
  className?: string;
  disabled?: boolean;
}

export function ColorSwatch(props: ColorSwatchProps): JSX.Element {
  const { value, fallback, onChange, onClear, label, className, disabled } = props;
  const id = useId();

  /**
   * The colour being considered, before OK.
   *
   * Null while the popover is shut, so a colour arriving from outside — undo, a
   * share link, the default changing under an inherited swatch — is what the
   * well shows. The same shape as `NumberField`'s draft, and for the same
   * reason: the control has to show what you are doing without the document
   * having to agree yet.
   */
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);

  const wellColor = swatchColor(draft, value, fallback);
  const shown = wellColor ?? '#888888';

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  const close = (): void => {
    setOpen(false);
    setDraft(null);
    setTyped(null);
    buttonRef.current?.focus();
  };

  const commit = (): void => {
    const picked = draft ?? '';
    if (shouldCommit(picked, value)) onChange(picked);
    close();
  };

  /**
   * Where the popover goes: under the swatch, flipped above when there is no
   * room below, and clamped so it cannot hang off either edge. Measured after
   * layout — a popover positioned from the click point instead would drift the
   * moment the row it belongs to scrolled.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = buttonRef.current?.getBoundingClientRect();
    const box = popoverRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const width = box?.width ?? 240;
    const height = box?.height ?? 220;
    const gap = 6;
    const below = anchor.bottom + gap;
    const top = below + height > window.innerHeight ? Math.max(gap, anchor.top - height - gap) : below;
    const left = Math.min(
      Math.max(gap, anchor.left),
      Math.max(gap, window.innerWidth - width - gap),
    );
    setAt({ top, left });
  }, [open]);

  /** Escape closes without committing; a click outside does the same. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const title = value !== undefined
    ? `${label} — ${value}`
    : wellColor !== undefined
      ? `${label} — ${wellColor}, from the default`
      : `${label} — not chosen`;

  return (
    <span className={className === undefined ? 'swatch' : `swatch ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        id={id}
        className="swatch__well"
        data-unset={wellColor === undefined ? 'true' : undefined}
        style={wellColor === undefined ? undefined : { backgroundColor: wellColor }}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={title}
        onClick={() => setOpen((was) => !was)}
      />

      {/* Only when there is something to clear. A disabled × on every swatch is
          three-quarters of a parts list full of dead controls. */}
      {onClear !== undefined && value !== undefined && !disabled ? (
        <button
          type="button"
          className="swatch__clear hit-area"
          onClick={onClear}
          title={`${label} — back to the default`}
          aria-label={`${label} — back to the default`}
        >
          ×
        </button>
      ) : null}

      {open && !disabled && createPortal(
        <div
          ref={popoverRef}
          className="swatch-pop"
          role="dialog"
          aria-label={label}
          style={at === null ? { visibility: 'hidden' } : { top: at.top, left: at.left }}
        >
          <p className="swatch-pop__title">{label}</p>

          <div className="swatch-pop__grid" role="group" aria-label="Filament colours">
            {PRESETS.map((preset) => (
              <button
                key={preset.hex}
                type="button"
                className="swatch-pop__preset"
                style={{ backgroundColor: preset.hex }}
                aria-label={preset.name}
                aria-pressed={(draft ?? value) === preset.hex}
                data-chosen={(draft ?? value) === preset.hex ? 'true' : undefined}
                title={`${preset.name} — ${preset.hex}`}
                onClick={() => { setDraft(preset.hex); setTyped(null); }}
              />
            ))}
          </div>

          <div className="swatch-pop__row">
            {/* The native picker, for a colour the presets do not have. It only
                ever moves the DRAFT — the OS panel has no OK of its own, which
                is the whole reason this popover exists. */}
            <label className="swatch-pop__custom">
              <input
                type="color"
                value={shown}
                onChange={(e) => { setDraft(e.target.value); setTyped(null); }}
              />
              Custom…
            </label>
            {/* Typed or pasted, because a filament's hex is usually written down
                somewhere. Committed only if it parses; the field keeps what was
                typed until then, exactly as `NumberField` does. */}
            <input
              className="swatch-pop__hex"
              type="text"
              spellCheck={false}
              value={typed ?? draft ?? value ?? ''}
              placeholder={fallback ?? '#rrggbb'}
              aria-label="Colour as hex"
              onChange={(e) => {
                setTyped(e.target.value);
                const parsed = normaliseColor(e.target.value);
                if (parsed !== undefined) setDraft(parsed);
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
            />
          </div>

          <div className="swatch-pop__actions">
            {onClear !== undefined && value !== undefined ? (
              <button
                type="button"
                className="button swatch-pop__default"
                onClick={() => { onClear(); close(); }}
              >
                Use default
              </button>
            ) : null}
            <button type="button" className="button" onClick={close}>Cancel</button>
            <button
              type="button"
              className="button button--primary"
              onClick={commit}
              disabled={draft === null}
            >
              OK
            </button>
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}
