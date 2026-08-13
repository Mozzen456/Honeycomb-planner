/**
 * The review step of an STL import.
 *
 * Measuring a mesh is the easy half. The half geometry cannot do is say which
 * cells an insert-fed part will be screwed into — that is the installer's
 * choice, not a feature of the file (PARKED.md P1). So this dialog shows every
 * number that was measured, says plainly which of them are bounds rather than
 * measurements, and gives the two controls that turn the unanswerable question
 * into a two-click one: draw the footprint, and name the insert it bolts to.
 *
 * Nothing is written until Add is pressed. Cancel leaves the catalogue exactly
 * as it was.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { BEDS } from '../core/constants';
import { hexKey } from '../core/hex';
import { bedsThatFit, withFootprint, type ImportedPart, type ImportProposal } from '../core/importPart';
import type { Catalog, Hex, PartType } from '../core/types';
import { FootprintEditor } from './FootprintEditor';
import './ImportDialog.css';

export interface ImportDialogProps {
  proposal: ImportProposal;
  catalog: Catalog;
  onCancel: () => void;
  onConfirm: (part: ImportedPart) => void;
}

const TYPES: { value: PartType; label: string; note: string }[] = [
  { value: 'panel', label: 'Panel', note: 'the wall itself — can be laid out by Solve panels' },
  { value: 'insert', label: 'Insert', note: 'clips into a cell; one per hole' },
  { value: 'fastener', label: 'Fastener', note: 'clips into a cell and takes a wall screw' },
  { value: 'accessory', label: 'Accessory', note: 'mounts on the wall; may overlap others' },
];

const fmt = (v: number, dp = 1): string => v.toFixed(dp);

function formatMinutes(total: number): string {
  const m = Math.round(total);
  return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h ${m % 60} m`;
}

export function ImportDialog({ proposal, catalog, onCancel, onConfirm }: ImportDialogProps) {
  const [name, setName] = useState(proposal.part.name);
  const [type, setType] = useState<PartType>(proposal.part.type);
  const [cells, setCells] = useState<Hex[]>(proposal.part.footprint);
  const [requiresId, setRequiresId] = useState<string>(
    proposal.part.requires[0]?.partId ?? '',
  );
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Focus moves into the dialog so a keyboard user is not left behind on the
  // page underneath, and Escape always gets out.
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const inserts = useMemo(
    () => catalog.parts.filter((p) => p.type === 'insert' || p.type === 'fastener'),
    [catalog],
  );

  const measured = proposal.detection;
  const measure = proposal.measure;
  const [w, h, d] = proposal.part.bboxMm;

  const toggle = (cell: Hex): void => {
    setCells((prev) => {
      const key = hexKey(cell);
      const without = prev.filter((c) => hexKey(c) !== key);
      // The anchor cell always belongs to the part: a footprint with nothing at
      // the origin has no cell under the cursor while dragging.
      if (without.length === prev.length) return [...prev, cell];
      if (without.length === 0) return prev;
      return without;
    });
  };

  const confirm = (): void => {
    let part = withFootprint({ ...proposal.part, type }, cells, catalog);
    part = { ...part, name: name.trim().length > 0 ? name.trim() : part.id };
    if (requiresId.length > 0) {
      part = { ...part, requires: [{ partId: requiresId, count: Math.max(1, cells.length) }] };
    } else if (type === 'accessory' && measured.tier !== 'wall-clip') {
      part = { ...part, requires: [] };
    }
    if (part.panel) {
      part = {
        ...part,
        panel: { ...part.panel, fitsBeds: bedsThatFit(part.panel.widthMm, part.panel.heightMm, BEDS) },
      };
    }
    onConfirm(part);
  };

  const canBeLaidOut = type === 'panel' && proposal.part.panel !== undefined;

  return (
    <div className="import-scrim" role="presentation" onPointerDown={onCancel}>
      <div
        className="import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        tabIndex={-1}
        ref={dialogRef}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="import__head">
          <h2 className="import__title" id="import-title">Add {proposal.part.file}</h2>
          <p className="import__sub">
            {measured.tier === 'panel'
              ? 'Measured as a panel.'
              : measured.tier === 'wall-clip'
                ? 'Measured as a wall part — its footprint comes from the mesh.'
                : 'No wall interface found — the footprint below is a bound, not a measurement.'}
          </p>
        </header>

        <div className="import__body">
          <section className="import__form">
            <label className="import__field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            <label className="import__field">
              <span>Type</span>
              <select value={type} onChange={(e) => setType(e.target.value as PartType)}>
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </label>
            <p className="import__hint">{TYPES.find((t) => t.value === type)?.note}</p>

            {type !== 'panel' && (
              <>
                <label className="import__field">
                  <span>Mounts with</span>
                  <select value={requiresId} onChange={(e) => setRequiresId(e.target.value)}>
                    <option value="">Nothing — it clips straight to the wall</option>
                    {inserts.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <p className="import__hint">
                  One per cell of the footprint. Whatever you choose is what the parts list
                  orders — and its bolts come with it, so nothing is counted twice.
                </p>
              </>
            )}

            <dl className="import__facts tabular-nums">
              <div><dt>Bounding box</dt><dd>{fmt(w)} × {fmt(h)} × {fmt(d)} mm</dd></div>
              <div><dt>Volume</dt><dd>{fmt(measure.volumeMm3 / 1000, 2)} cm³</dd></div>
              <div><dt>Triangles</dt><dd>{measure.triangles.toLocaleString()}</dd></div>
              <div><dt>Stands off</dt><dd>{fmt(proposal.part.projectionMm)} mm</dd></div>
              <div><dt>Method</dt><dd>{measured.method}</dd></div>
              <div>
                <dt>Print (est.)</dt>
                <dd>
                  {formatMinutes(proposal.part.print.minutes)} · {fmt(proposal.part.print.grams)} g
                  {proposal.part.print.supports ? ' · needs supports' : ''}
                </dd>
              </div>
              {canBeLaidOut && (
                <div>
                  <dt>Panel</dt>
                  <dd>
                    {proposal.part.panel!.columns} × {proposal.part.panel!.rows} cells ·{' '}
                    {fmt(proposal.part.panel!.widthMm)} × {fmt(proposal.part.panel!.heightMm)} mm
                  </dd>
                </div>
              )}
            </dl>

            {proposal.warnings.length > 0 && (
              <ul className="import__warnings">
                {proposal.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="import__footprint">
            <h3>Footprint</h3>
            <p className="import__hint">
              Click a cell to add or remove it. This is the shape the part occupies on the
              wall, and what the planner checks when you drop it.
            </p>
            <FootprintEditor cells={cells} onToggle={toggle} />
            <p className="import__count tabular-nums">
              {cells.length} cell{cells.length === 1 ? '' : 's'}
            </p>
          </section>
        </div>

        <footer className="import__foot">
          <button type="button" className="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="button button--primary" onClick={confirm}>
            Add to catalogue
          </button>
        </footer>
      </div>
    </div>
  );
}
