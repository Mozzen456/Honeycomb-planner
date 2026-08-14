/**
 * The overflow menu in the title bar.
 *
 * It exists to hold the three CATALOGUE-MAINTENANCE actions — Align, Setup (n),
 * Mine (n) — which are the app's developer channel (see "Correcting a part's
 * mounting" in CLAUDE.md) and were sitting in the top bar at exactly the same
 * visual weight as Undo and Share. Eight equal buttons in a row is not a
 * hierarchy, and the three that a person building a wall never touches were
 * taking a third of it.
 *
 * Nothing is REMOVED by this: every action is still one click from the bar, and
 * still carries its own count so "Setup (33)" is readable before the menu opens.
 *
 * Kept deliberately small — a menu is easy to get subtly wrong, so the three
 * behaviours that actually matter are the three that are implemented:
 *
 *   - Escape closes it AND returns focus to the trigger. Without the second half
 *     the keyboard is dumped at the top of the document.
 *   - A pointer down anywhere else closes it. `pointerdown` and not `click`:
 *     the wall is a drag surface, and a menu that survives until the mouse comes
 *     back up stays open across the whole of the first drag gesture under it.
 *   - Up/Down move between items, Home/End jump. A menu that can be opened from
 *     the keyboard and then not walked is worse than no menu.
 *
 * It is NOT portalled. `ColorSwatch`'s popover has to be, because the parts list
 * clips its overflow; the title bar does not clip, and this drops into the app's
 * own body area.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { Icon } from './Icon';
import type { IconName } from './Icon';

export interface ToolMenuItem {
  /** Stable key, and what the handler is keyed by. */
  id: string;
  label: string;
  /** Shown after the label, greyed: a count, a size, a state. */
  detail?: string;
  hint?: string;
  icon?: IconName;
  onSelect: () => void;
}

export interface ToolMenuProps {
  /** The trigger's accessible name — it has no visible text. */
  label: string;
  items: readonly ToolMenuItem[];
  /** Optional heading above the items, naming what they have in common. */
  heading?: string;
}

export function ToolMenu({ label, items, heading }: ToolMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  /* Close on an outside press or on Escape. Both listeners are only mounted
     while the menu is open, so a closed menu costs nothing. */
  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  /* Focus the first item on open, so the keyboard lands inside the thing it
     just asked for rather than behind it. */
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const walk = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const nodes = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (nodes.length === 0) return;
    const at = nodes.indexOf(document.activeElement as HTMLElement);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (at + step + nodes.length) % nodes.length;
      nodes[next]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      nodes[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      nodes[nodes.length - 1]?.focus();
    }
  };

  return (
    <div className="toolmenu" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="iconbutton"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="more" />
      </button>

      {open && (
        <div
          className="toolmenu__list"
          id={menuId}
          role="menu"
          aria-label={label}
          ref={listRef}
          onKeyDown={walk}
        >
          {heading !== undefined && <p className="toolmenu__heading">{heading}</p>}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="toolmenu__item"
              title={item.hint}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon !== undefined && <Icon name={item.icon} />}
              <span className="toolmenu__label">{item.label}</span>
              {item.detail !== undefined && (
                <span className="toolmenu__detail tabular-nums">{item.detail}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
