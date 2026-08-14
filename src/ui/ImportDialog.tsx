/**
 * The first step of a model import: what this part is.
 *
 * Measuring a mesh is the easy half. The half geometry cannot do is say which
 * cells an insert-fed part will be screwed into — that is the installer's
 * choice, not a feature of the file (PARKED.md P1). So this dialog shows every
 * number that was measured, says plainly which of them are bounds rather than
 * measurements, and gives the controls that turn the unanswerable questions
 * into clicks: name the insert it bolts to, and add a photograph of the printed
 * thing.
 *
 * WHICH CELLS the part takes is asked on the NEXT step and not here. It used to
 * be asked on both, with two footprint editors a click apart — and the one on
 * this page is the worse place to answer it, because there is nothing to answer
 * it against. On the alignment step the same editor sits beside the part shown
 * against a real patch of wall, which is the only view in which "does it cover
 * that cell" is a question a person can actually see.
 *
 * It does not finish the import. Pressing Next hands the part to the alignment
 * step, and only that step adds it (D71) — a model whose mounting face nobody
 * chose is a part that will sit wrong on the wall, and the moment it is being
 * added is the one moment the person is certainly looking at it.
 *
 * Nothing is written until the alignment step is saved. Cancel at either step
 * leaves the catalogue exactly as it was.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { BEDS } from '../core/constants';
import { bedsThatFit, withFootprint, type ImportedPart, type ImportProposal } from '../core/importPart';
import type { Catalog, PartType } from '../core/types';
import { PartImage } from './PartImage';
import { photoRefusal, PHOTO_MAX_PX, preparePhoto } from './partPhotos';
import './ImportDialog.css';

export interface ImportDialogProps {
  proposal: ImportProposal;
  catalog: Catalog;
  onCancel: () => void;
  /** The part as described, plus its downscaled photo if one was chosen. */
  onConfirm: (part: ImportedPart, photo: Blob | null) => void;
}

const TYPES: { value: PartType; label: string; note: string }[] = [
  { value: 'panel', label: 'Panel', note: 'the wall itself — can be laid out by Solve panels' },
  { value: 'insert', label: 'Insert', note: 'clips into a cell; one per hole' },
  { value: 'fastener', label: 'Fastener', note: 'clips into a cell and takes a wall screw' },
  { value: 'accessory', label: 'Accessory', note: 'mounts on the wall; may overlap others' },
];

const fmt = (v: number, dp = 1): string => v.toFixed(dp);

export function ImportDialog({ proposal, catalog, onCancel, onConfirm }: ImportDialogProps) {
  const [name, setName] = useState(proposal.part.name);
  const [type, setType] = useState<PartType>(proposal.part.type);
  const [requiresId, setRequiresId] = useState<string>(
    proposal.part.requires[0]?.partId ?? '',
  );
  /**
   * The photo, already downscaled, plus a URL to show it with.
   *
   * Prepared on PICK rather than on confirm, so what the preview shows is the
   * exact blob that gets stored — and so a file the browser cannot decode says
   * so while the person is still holding the file picker, not two steps later.
   */
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // The preview URL belongs to this dialog and dies with it. (A photo that is
  // kept gets a fresh URL from `photoUrlFor`, which owns the long-lived ones.)
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url); }, [photo]);

  const choosePhoto = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    const refusal = photoRefusal(file);
    if (refusal !== null) {
      setPhotoError(refusal);
      return;
    }
    try {
      const blob = await preparePhoto(file);
      setPhoto((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { blob, url: URL.createObjectURL(blob) };
      });
      setPhotoError(null);
    } catch (err) {
      setPhotoError(`Could not read ${file.name}: ${(err as Error).message}`);
    }
  };

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

  const confirm = (): void => {
    /*
     * The cells are passed through UNCHANGED — they are chosen on the next
     * step, against the wall, where you can see them.
     *
     * `withFootprint` is still the right call rather than a plain spread: the
     * TYPE can change here, and the wall-mount count and the panel block are
     * derived from it. Re-stating the same cells deliberately does NOT clear
     * `needsReview`, which is the honesty rule this whole flow rests on — only
     * an actual edit turns a bound into a decision.
     */
    let part = withFootprint({ ...proposal.part, type }, proposal.part.footprint, catalog);
    part = { ...part, name: name.trim().length > 0 ? name.trim() : part.id };
    if (requiresId.length > 0) {
      part = {
        ...part,
        requires: [{ partId: requiresId, count: Math.max(1, proposal.part.footprint.length) }],
      };
    } else if (type === 'accessory' && measured.tier !== 'wall-clip') {
      part = { ...part, requires: [] };
    }
    if (part.panel) {
      part = {
        ...part,
        panel: { ...part.panel, fitsBeds: bedsThatFit(part.panel.widthMm, part.panel.heightMm, BEDS) },
      };
    }
    onConfirm(part, photo?.blob ?? null);
  };

  const canBeLaidOut = type === 'panel' && proposal.part.panel !== undefined;

  return (
    <div className="modal-scrim import-scrim" role="presentation" onPointerDown={onCancel}>
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
          <p className="import__step">Step 1 of 2 · What this part is</p>
          <h2 className="import__title" id="import-title">Add {proposal.part.file}</h2>
          <p className="import__sub">
            {measured.tier === 'panel'
              ? 'Measured as a panel.'
              : measured.tier === 'wall-clip'
                ? 'Measured as a wall part — its footprint comes from the mesh.'
                : 'No wall interface found — the footprint below is a bound, not a measurement.'}
            {' '}Next you line it up against the wall; it joins your library after that.
          </p>
        </header>

        <div className="import__body">
          <section className="import__form">
            <label className="import__field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            {/*
              A photograph of the printed part.
              Optional, and above the numbers on purpose: it is the field that
              makes the library browsable, and the one a person will skip if it
              is buried under a bounding box and a triangle count.
            */}
            <div className="import__photo">
              <span className="import__photolabel">Photo</span>
              <div className="import__photorow">
                {/*
                  With no photograph, the slot shows the part RENDERED from its
                  own model — the same picture the library falls back to. An
                  empty grey box asked "is a photo required?"; the render answers
                  it by showing what you get if you skip this.
                */}
                {photo === null ? (
                  <PartImage
                    part={proposal.part}
                    className="import__photoframe import__photoframe--render"
                    hasPhoto={false}
                  />
                ) : (
                  <span className="import__photoframe">
                    <img src={photo.url} alt={`Photograph of ${name}`} />
                  </span>
                )}
                <div className="import__photoactions">
                  <label className="button import__photopick">
                    {photo === null ? 'Choose a photo…' : 'Replace…'}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        void choosePhoto(e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {photo !== null && (
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        URL.revokeObjectURL(photo.url);
                        setPhoto(null);
                      }}
                    >
                      Remove
                    </button>
                  )}
                  <p className="import__hint">
                    Optional. Without one you get the render on the left, which tells you
                    the shape; a photograph tells you the part — printed, in colour, holding
                    something. Scaled down to {PHOTO_MAX_PX} px before it is stored.
                  </p>
                </div>
              </div>
              {photoError !== null && <p className="import__photoerror">{photoError}</p>}
            </div>

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
                <dt>Filament (est.)</dt>
                <dd>
                  {fmt(proposal.part.print.grams)} g
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

        </div>

        <footer className="import__foot">
          <button type="button" className="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="button button--primary" onClick={confirm}>
            Next: line it up →
          </button>
        </footer>
      </div>
    </div>
  );
}
