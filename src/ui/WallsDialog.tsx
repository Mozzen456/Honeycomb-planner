/**
 * The shelf of saved walls: save this one, start a blank one, open or delete an
 * old one.
 *
 * Pure presentation over a list it is handed. It reads no storage and parses no
 * document — `wallStore.ts` owns both — so the whole dialog is a function of its
 * props and every gesture leaves through a callback.
 *
 * Two things here are not cosmetic:
 *
 *   - DELETE ASKS, and it asks in place rather than through `confirm()`. A
 *     saved wall is the only thing in this app that a click can destroy for
 *     good: everything else is undoable, and the shelf is deliberately not, or
 *     an undo stack would have to own storage. The confirm is inline because a
 *     native dialog over a modal is a second modal, and on a short window the
 *     browser puts it somewhere the page cannot control.
 *   - THE OPEN WALL IS MARKED. Without it, "Open" on the wall you are already
 *     in looks like it did nothing, and "Save" looks like it made a duplicate —
 *     the shelf is keyed on the document id, so saving twice replaces.
 */

import { useEffect, useRef, useState } from 'react';

import { Icon } from './Icon';
import type { SavedWall } from '../core/wallStore';

import './WallsDialog.css';

export interface WallsDialogProps {
  walls: readonly SavedWall[];
  /** The document on screen, so its row can say so. */
  currentId: string;
  /** Whether the wall on screen is worth offering to save. */
  currentName: string;
  onSave: () => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

/** Absolute, never "3 days ago": a relative date is a puzzle when it matters. */
function when(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function WallsDialog(props: WallsDialogProps): JSX.Element {
  const { walls, currentId, currentName, onSave, onNew, onOpen, onDelete, onClose } = props;
  const [confirming, setConfirming] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /* Escape closes — the dialog's own, before the plan's tools see it. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (confirming !== null) { setConfirming(null); return; }
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, confirming]);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  const saved = walls.some((w) => w.id === currentId);

  return (
    <div
      className="modal-scrim"
      role="presentation"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="walls"
        role="dialog"
        aria-modal="true"
        aria-labelledby="walls-title"
        ref={panelRef}
      >
        <header className="walls__head">
          <div>
            <h2 className="walls__title" id="walls-title">Your walls</h2>
            <p className="walls__note">
              Kept in this browser on this device. Nothing is uploaded — use
              {' '}<strong>Share</strong> or <strong>Export&nbsp;JSON</strong> to move a wall
              somewhere else.
            </p>
          </div>
          <button
            type="button"
            className="iconbutton"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="walls__actions">
          <button type="button" className="button button--primary" onClick={onSave}>
            <Icon name="check" />
            {saved ? 'Save changes' : 'Save this wall'}
          </button>
          <button type="button" className="button" onClick={onNew}>
            <Icon name="plus" />
            New wall
          </button>
          <span className="walls__current" title={currentName}>
            {saved ? 'Saving replaces' : 'Saving adds'} “{currentName}”
          </span>
        </div>

        {walls.length === 0 ? (
          <div className="walls__empty">
            <span className="walls__emptyicon" aria-hidden="true">
              <Icon name="layers" size="md" />
            </span>
            <p className="walls__emptytitle">No saved walls yet</p>
            <p className="walls__emptybody">
              Save the wall you are working on and it will be here next time. The one on screen
              already survives a refresh on its own — this is for keeping several.
            </p>
          </div>
        ) : (
          <ul className="walls__list" role="list">
            {walls.map((w) => {
              const open = w.id === currentId;
              return (
                <li className="walls__row" key={w.id} data-open={open ? 'true' : undefined}>
                  <div className="walls__body">
                    <p className="walls__name">
                      {w.name}
                      {open && <span className="walls__badge">on screen</span>}
                    </p>
                    <p className="walls__meta tabular-nums">
                      {w.widthMm} × {w.heightMm} mm
                      <span aria-hidden="true"> · </span>
                      {w.plates} {w.plates === 1 ? 'plate' : 'plates'}
                      <span aria-hidden="true"> · </span>
                      {w.items} placed
                      {w.photoId !== undefined && (
                        <span className="walls__photo" title="Has a wall photograph">
                          <Icon name="photo" />
                        </span>
                      )}
                    </p>
                    <p className="walls__when tabular-nums">{when(w.savedAt)}</p>
                  </div>

                  {confirming === w.id ? (
                    <div className="walls__confirm">
                      <span className="walls__confirmtext">Delete for good?</span>
                      <button
                        type="button"
                        className="button button--sm"
                        onClick={() => setConfirming(null)}
                      >
                        Keep
                      </button>
                      <button
                        type="button"
                        className="button button--sm button--danger"
                        onClick={() => { setConfirming(null); onDelete(w.id); }}
                      >
                        Delete
                      </button>
                    </div>
                  ) : (
                    <div className="walls__rowactions">
                      <button
                        type="button"
                        className="button button--sm"
                        onClick={() => onOpen(w.id)}
                        disabled={open}
                        title={open ? 'This is the wall on screen' : `Open ${w.name}`}
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        className="iconbutton walls__delete"
                        aria-label={`Delete ${w.name}`}
                        title="Delete this wall"
                        onClick={() => setConfirming(w.id)}
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <footer className="walls__foot">
          <p className="walls__hint">
            Opening a wall replaces the one on screen — <strong>Undo</strong> brings it back.
          </p>
          <button type="button" className="button" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  );
}
