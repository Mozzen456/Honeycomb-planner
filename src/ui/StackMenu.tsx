/**
 * Download a plate — one, or a stack of them printed in one go.
 *
 * A stack is several copies of the same plate sitting one above the next with a
 * single layer of air between them (`STACK_GAP_MM`). The printer bridges that
 * layer instead of fusing it, so the copies come apart in the hand, and a wall
 * that wants twelve identical plates becomes one print instead of twelve. The
 * OpenSCAD generator this app grew out of has the same parameter, with the same
 * 0.2 mm, which is where the number comes from.
 *
 * It is a POPOVER on the download button and not a field in the row, for the
 * reason the count is asked at all: how many will fit is a question about the
 * printer standing in the room, so the answer has to be next to the height the
 * choice produces. In the row it would be one more number in a list of numbers.
 *
 * Portalled to the body, exactly as `ColorSwatch` is and for exactly the same
 * reason: this rail is rendered inside the parts list, which scrolls and clips
 * its own overflow (`contain: layout paint`), so a popover rendered in the row
 * would be cut off at the panel's edge.
 *
 * The count is NOT document state. It says how to write one file; the wall does
 * not change, nothing is undoable, and a saved layout has no opinion about how
 * its plates were batched. Same argument as "Fit to printer".
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { PANEL_DEPTH } from '../core/constants';
import { clampStack, MAX_STACK, STACK_GAP_MM, stackHeightMm } from '../core/honeycomb';

import './StackMenu.css';

export interface StackMenuProps {
  /** The plate, as the row names it. */
  label: string;
  /** How many of this plate the wall needs — the natural batch. */
  needed: number;
  /** Asked for `copies` of it, as one file. */
  onDownload: (copies: number) => void;
  /** Lit on the wall when the popover opens, like every other action here. */
  onOpen?: () => void;
}

/**
 * What a typed count becomes on the way to the document — kept next to the
 * field's own rules so it can be checked without a DOM, exactly as
 * `NumberField.valueWhileTyping` is.
 *
 * An empty field is not zero: it is somebody mid-edit, and the draft holds the
 * text while the number stays where it was.
 */
export function countWhileTyping(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  if (!Number.isFinite(n)) return undefined;
  return clampStack(n);
}

export function StackMenu(props: StackMenuProps): JSX.Element {
  const { label, needed, onDownload, onOpen } = props;

  const [open, setOpen] = useState(false);
  /*
   * One, not `needed`. The popover states the height either way, so nobody is
   * surprised — but the button's own promise is "this plate", and pressing it
   * twice should not quietly produce a 98 mm tower. `All n` is one click away
   * for the person who wants the batch.
   */
  const [copies, setCopies] = useState(1);
  const [typed, setTyped] = useState<string | null>(null);

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  /*
   * `onOpen` lights the plate on the wall, which is a setState in `App` — so it
   * must not run inside `setOpen`'s updater, where React invokes it DURING this
   * component's render ("cannot update a component while rendering a different
   * one", and in a stricter mode a dropped update). It belongs in an effect,
   * fired when the popover has actually opened. Held in a ref so a new arrow
   * from the parent's next render cannot re-fire it.
   */
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const popRef = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  const close = (): void => {
    setOpen(false);
    setTyped(null);
    buttonRef.current?.focus();
  };

  const download = (n: number): void => {
    onDownload(clampStack(n));
    close();
  };

  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);

  /** Under the button, flipped above when there is no room, clamped to the window. */
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = buttonRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const box = popRef.current?.getBoundingClientRect();
    const width = box?.width ?? 240;
    const height = box?.height ?? 200;
    const gap = 6;
    const below = anchor.bottom + gap;
    const top =
      below + height > window.innerHeight ? Math.max(gap, anchor.top - height - gap) : below;
    const left = Math.min(
      Math.max(gap, anchor.left),
      Math.max(gap, window.innerWidth - width - gap),
    );
    setAt({ top, left });
  }, [open]);

  /** Escape and a click outside both close without downloading. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (popRef.current?.contains(target)) return;
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

  const height = stackHeightMm(PANEL_DEPTH, copies);
  const batch = Math.min(needed, MAX_STACK);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="button button--primary"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        Download STL
      </button>

      {open &&
        createPortal(
          <div
            ref={popRef}
            className="stack-pop"
            role="dialog"
            aria-label={`Download ${label}`}
            style={at === null ? { visibility: 'hidden' } : { top: at.top, left: at.left }}
          >
            <p className="stack-pop__title">Stack print</p>
            <p className="stack-pop__note">
              Copies printed one above the next, {STACK_GAP_MM} mm apart, in one file. They
              bridge that gap instead of fusing, so they come apart afterwards.
            </p>

            <div className="stack-pop__row">
              {/* Steppers read the COUNT through a functional updater, never the
                  value this render closed over: three clicks before a repaint
                  all see the same number otherwise, and record one (D89/D58). */}
              <button
                type="button"
                className="button button--ghost stack-pop__step"
                aria-label="One fewer"
                onClick={() => {
                  setTyped(null);
                  setCopies((n) => clampStack(n - 1));
                }}
                disabled={copies <= 1}
              >
                −
              </button>
              <input
                className="stack-pop__count tabular-nums"
                type="text"
                inputMode="numeric"
                aria-label="Plates in the stack"
                value={typed ?? String(copies)}
                onChange={(e) => {
                  setTyped(e.target.value);
                  const n = countWhileTyping(e.target.value);
                  if (n !== undefined) setCopies(n);
                }}
                onBlur={() => setTyped(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') download(copies);
                }}
              />
              <button
                type="button"
                className="button button--ghost stack-pop__step"
                aria-label="One more"
                onClick={() => {
                  setTyped(null);
                  setCopies((n) => clampStack(n + 1));
                }}
                disabled={copies >= MAX_STACK}
              >
                +
              </button>
              {/* The batch this wall actually wants — the reason anybody opened
                  this. Hidden when it is one, where it would say nothing; and
                  it says `Max` rather than `All` when the wall wants more than
                  a stack may hold, because a wall needing 36 and a button
                  reading `All 25` is the control lying about what it does. */}
              {batch > 1 && (
                <button
                  type="button"
                  className="button button--subtle stack-pop__all"
                  onClick={() => {
                    setTyped(null);
                    setCopies(batch);
                  }}
                  title={
                    needed > MAX_STACK
                      ? `As many as one stack holds — this wall needs ${needed}`
                      : `Every ${label} this wall needs`
                  }
                >
                  {needed > MAX_STACK ? `Max ${MAX_STACK}` : `All ${batch}`}
                </button>
              )}
            </div>

            {/*
              The height, because it is the only thing that decides whether the
              stack will print — and this app cannot decide it: a printer's build
              HEIGHT is not part of a bed, which is width and depth only. So it
              is stated and left to the person who owns the machine.
            */}
            <p className="stack-pop__meta tabular-nums">
              {copies === 1
                ? `One plate · ${PANEL_DEPTH} mm tall`
                : `${copies} plates · ${height.toFixed(1)} mm tall`}
            </p>

            <div className="stack-pop__actions">
              <button type="button" className="button" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => download(copies)}
              >
                Download
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
