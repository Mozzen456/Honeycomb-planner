/**
 * Align every part at once.
 *
 * ---------------------------------------------------------------------------
 * The problem this is for
 * ---------------------------------------------------------------------------
 *
 * 27 of the 51 shipped parts have no measured mounting face. The inspector
 * (D34) lets a person set one by hand, and at one dialog per part that is an
 * afternoon's work that nobody will finish — and worse, it gives no way to tell
 * WHICH parts are wrong without opening all of them.
 *
 * So this is a contact sheet rather than a wizard. Every part on one screen,
 * with the catalogue's answer next to the peg's answer, and the ones that
 * DISAGREE sorted to the top. Most rows need no attention; the few that do are
 * the point, and they are visible without a single click.
 *
 * ---------------------------------------------------------------------------
 * Two answers, and why comparing them is the useful thing
 * ---------------------------------------------------------------------------
 *
 * `catalog.measurement.wallFaceAxis` is what `detect.ts` concluded. For a part
 * with no wall interface that is `insertFed`'s "face with the most material
 * just under the surface", which for a shelf is the underside of the tray.
 *
 * `detectPeg` measures the hexagonal prism the part actually mates through
 * (`src/core/peg.ts`). Where the two agree, there is nothing to decide. Where
 * they disagree, the peg is usually right — it is a measurement of the mating
 * feature rather than a guess about bulk — but "usually" is why this asks
 * rather than applying it.
 *
 * Accepting writes the same `MountingOverride` the inspector writes, so it
 * lands in `overrides.json` and exports the same way. Nothing here is a second
 * channel.
 */

import { useEffect, useMemo, useState } from 'react';

import { detectPeg, type PegDetection } from '../core/peg';
import { mountingOf, type MountingOverride } from '../core/overrides';
import type { Catalog, CatalogPart } from '../core/types';
import { loadRawMesh } from './meshLibrary';
import { thumbnailFor } from './partThumbnails';
import './AlignPanel.css';

export interface AlignPanelProps {
  catalog: Catalog;
  onApply: (partId: string, mounting: MountingOverride) => void;
  onInspect: (partId: string) => void;
  onClose: () => void;
}

type Axis = 'x' | 'y' | 'z';

const FACE: Record<string, string> = {
  'x:low': 'Left', 'x:high': 'Right',
  'y:low': 'Front', 'y:high': 'Back',
  'z:low': 'Bottom', 'z:high': 'Top',
};

const label = (axis?: string, end?: string): string =>
  axis && end ? (FACE[`${axis}:${end}`] ?? `${axis}${end}`) : axis ? `${axis}?` : '—';

/** What the catalogue's own detector concluded, if it concluded anything. */
function detectedAxis(part: CatalogPart): string | undefined {
  const m = (part as unknown as Record<string, unknown>)['measurement'];
  if (typeof m !== 'object' || m === null) return undefined;
  const a = (m as Record<string, unknown>)['wallFaceAxis'];
  return a === 'x' || a === 'y' || a === 'z' ? a : undefined;
}

interface Row {
  part: CatalogPart;
  detected?: string;
  peg?: PegDetection;
  saved?: MountingOverride;
  thumb?: string | null;
}

export function AlignPanel(props: AlignPanelProps): JSX.Element {
  const { catalog, onApply, onInspect, onClose } = props;
  const [pegs, setPegs] = useState<ReadonlyMap<string, PegDetection | null>>(new Map());
  const [thumbs, setThumbs] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [done, setDone] = useState(0);

  const parts = useMemo(
    () => catalog.parts.filter((p) => p.type !== 'panel'),
    [catalog],
  );

  /*
   * Measured one at a time, reporting progress as it goes.
   *
   * Fifty parts is fifty STL parses. Done in a `Promise.all` the tab locks up
   * for several seconds with nothing on screen; done in sequence with the count
   * rising, the rows fill in underneath and the work is visibly finite. The
   * meshes are cached, so opening this a second time is instant.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      const found = new Map<string, PegDetection | null>();
      for (const part of parts) {
        if (!live) return;
        const mesh = await loadRawMesh(part);
        found.set(part.id, mesh ? detectPeg(mesh) : null);
        if (!live) return;
        setPegs(new Map(found));
        setDone(found.size);
      }
    })();
    return () => { live = false; };
  }, [parts]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const got = new Map<string, string | null>();
      for (const part of parts) {
        if (!live) return;
        got.set(part.id, await thumbnailFor(part));
        if (!live) return;
        setThumbs(new Map(got));
      }
    })();
    return () => { live = false; };
  }, [parts]);

  const rows: Row[] = useMemo(() => {
    const out = parts.map((part) => ({
      part,
      detected: detectedAxis(part),
      peg: pegs.get(part.id) ?? undefined,
      saved: mountingOf(part),
      thumb: thumbs.get(part.id),
    }));
    // Disagreements first, least confident of those first: the top of the list
    // is always the thing most worth a person's attention.
    const rank = (r: Row): number => {
      if (r.saved) return 3;                                   // already decided
      if (!r.peg) return 2;                                    // nothing to offer
      if (r.detected && r.detected === r.peg.axis) return 1;    // they agree
      return 0;                                                 // they disagree
    };
    return out.sort((a, b) =>
      rank(a) - rank(b) || (a.peg?.confidence ?? 0) - (b.peg?.confidence ?? 0));
  }, [parts, pegs, thumbs]);

  const disputed = rows.filter(
    (r) => !r.saved && r.peg && r.detected && r.detected !== r.peg.axis,
  );
  const confident = disputed.filter((r) => (r.peg?.confidence ?? 0) >= 0.9);

  return (
    <div className="align__scrim" role="dialog" aria-modal="true" aria-label="Align parts">
      <div className="align">
        <header className="align__head">
          <div>
            <h2 className="align__title">Align parts</h2>
            <p className="align__sub">
              The catalogue&apos;s mounting face next to the one measured from the part&apos;s own
              peg. {disputed.length} disagree
              {done < parts.length ? ` · measuring ${done}/${parts.length}` : ''}
            </p>
          </div>
          <button type="button" className="align__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="align__bulk">
          <button
            type="button"
            className="app__primary"
            disabled={confident.length === 0}
            onClick={() => {
              for (const r of confident) {
                onApply(r.part.id, { wallFaceAxis: r.peg!.axis as Axis, matingEnd: r.peg!.end });
              }
            }}
          >
            Use the peg for all {confident.length} confident disagreements
          </button>
          <span className="align__note">
            Only where the peg scores 0.90 or better. Anything less is left for you to look at.
          </span>
        </div>

        <ul className="align__rows">
          {rows.map((r) => {
            const agrees = r.detected && r.peg && r.detected === r.peg.axis;
            const state = r.saved ? 'set' : !r.peg ? 'none' : agrees ? 'agree' : 'differ';
            return (
              <li key={r.part.id} className="align__row" data-state={state}>
                <span className="align__thumb">
                  {r.thumb ? <img src={r.thumb} alt="" draggable={false} /> : null}
                </span>
                <span className="align__name">{r.part.name || r.part.id}</span>
                <span className="align__cell">
                  {/* The AXIS only. `catalog.json` records `wallFaceAxis` and no
                      mating end, so naming a face here — "Bottom" rather than
                      "Z" — would put an end on screen that nothing measured. */}
                  <span className="align__key">Catalogue axis</span>
                  {r.detected ? r.detected.toUpperCase() : '—'}
                </span>
                <span className="align__cell">
                  {/* The peg gives both, so both are shown. */}
                  <span className="align__key">Peg face</span>
                  {r.peg ? `${r.peg.axis.toUpperCase()} · ${label(r.peg.axis, r.peg.end)}` : '—'}
                </span>
                <span className="align__cell align__conf tabular-nums">
                  <span className="align__key">Confidence</span>
                  {r.peg ? r.peg.confidence.toFixed(2) : '—'}
                </span>
                <span className="align__actions">
                  {r.saved ? (
                    <span className="align__set">set by hand</span>
                  ) : (
                    <button
                      type="button"
                      disabled={!r.peg}
                      onClick={() => onApply(r.part.id, {
                        wallFaceAxis: r.peg!.axis as Axis,
                        matingEnd: r.peg!.end,
                      })}
                    >
                      Use peg
                    </button>
                  )}
                  <button type="button" onClick={() => onInspect(r.part.id)}>Open…</button>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
