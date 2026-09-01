/**
 * Blocked zones, the frame, and the plates they force you to generate.
 *
 * A stock panel is a rectangle of cells and one of seven shipped STLs. Put a
 * light switch in the middle of a wall — or a frame down its edge — and the
 * panels around it are none of those: they are the same block cut about, and
 * they have to be MADE. This panel is where you say what the wall has to go
 * round, and where you get the plate itself.
 *
 * "Download STL" is the point of the whole thing. Copying parameters into
 * somebody else's customiser was the old answer and it is still offered, because
 * a person who wants to tweak the shape should be able to — but the normal path
 * is now: draw the zone, press the button, print the plate.
 *
 * Pure presentation, like BomPanel: it renders what it is given and hands every
 * change back through a callback. The one exception is measuring the generated
 * plates for the bed-fit check, which is a pure function of the panels and is
 * memoised on them.
 */

import { useMemo, useState } from 'react';

import { customLineKey } from '../core/bom';
import { bedFor } from '../core/constants';
import {
  customPanelGroups, toCustomiserScad,
} from '../core/customiser';
import { toCustomiserCells } from '../core/customiser';
import {
  buildHoneycombMesh, MAX_BORDER_MM, MIN_BORDER_MM, meshBoundsMm, meshVolumeMm3,
} from '../core/honeycomb';
import { MIN_ZONE_MM } from '../core/measure';
import { OBSTACLE_PRESETS } from '../core/obstacles';
import { MAX_WALL_MM } from '../core/store';
import {
  frameIsOn, NO_WALL_FRAME, panelFrameKey, panelFrameSides, panelModelSpec,
} from '../core/panelModel';
import type { LayoutDoc, Obstacle, PlacedPanel, WallFrame } from '../core/types';
import { NumberField } from './NumberField';
import { StackMenu } from './StackMenu';

import './ObstaclePanel.css';

export interface ObstaclePanelProps {
  doc: LayoutDoc;
  onChange: (obstacles: Obstacle[]) => void;
  onFrameChange: (frame: WallFrame | undefined) => void;
  onCopy: (text: string, what: string) => void;
  /** Hand a generated plate to the browser as a file. */
  /** `copies` stacked into one file — see `StackMenu`. One is a plain plate. */
  onDownload: (panel: PlacedPanel, label: string, copies: number) => void;
  /**
   * The parts-list line the wall is lit for, so the row that means shows it.
   *
   * A LINE and not a list of panel ids, for the reason `panelsForLine` exists:
   * the plates a line means are derived from the wall as it is now.
   */
  litLine?: string | null;
  /** Light this plate's copies while the pointer is over its row; null on leave. */
  onHoverLine?: (lineKey: string | null) => void;
  /**
   * Keep them lit after the pointer has gone. `toggle` is the row's own click —
   * press it again and the highlight goes out; a download just pins it, because
   * turning the wall's answer off is not what asking for the file meant.
   */
  onLightLine?: (lineKey: string, toggle: boolean) => void;
}

const FRAME_SIDE_LABELS: { key: keyof WallFrame; label: string }[] = [
  { key: 'top', label: 'Top' },
  { key: 'bottom', label: 'Bottom' },
  { key: 'left', label: 'Left' },
  { key: 'right', label: 'Right' },
];

export function ObstaclePanel({
  doc, onChange, onFrameChange, onCopy, onDownload,
  litLine = null, onHoverLine, onLightLine,
}: ObstaclePanelProps) {
  const [preset, setPreset] = useState(0);
  const obstacles = doc.obstacles ?? [];
  const frame = doc.frame ?? NO_WALL_FRAME;

  const groups = useMemo(
    () => customPanelGroups(doc.panels, (p) => panelFrameKey(p, doc.panels, doc.frame)),
    [doc.panels, doc.frame],
  );

  /**
   * The real size and weight of each generated plate.
   *
   * Measured off the mesh the download would produce, not estimated from the
   * cell block: a framed edge is half a cell narrower and that is exactly the
   * difference between fitting a 180 mm bed and not. Memoised on the panels, so
   * it is not rebuilt on every keystroke in a zone's X field.
   */
  const built = useMemo(
    () =>
      groups.map((g) => {
        const first = g.panels[0];
        if (!first) return null;
        try {
          const spec = panelModelSpec(first, doc.panels, doc.frame);
          const mesh = buildHoneycombMesh({ cells: spec.cells, border: spec.border });
          const size = meshBoundsMm(mesh).size;
          return {
            widthMm: size[0],
            heightMm: size[1],
            cm3: meshVolumeMm3(mesh) / 1000,
            cells: spec.cells.length,
            sides: panelFrameSides(first, doc.panels, doc.frame),
            error: null as string | null,
          };
        } catch (e) {
          return {
            widthMm: 0, heightMm: 0, cm3: 0, cells: 0, sides: NO_WALL_FRAME,
            error: e instanceof Error ? e.message : 'This shape could not be generated',
          };
        }
      }),
    [groups, doc.panels, doc.frame],
  );

  const bed = bedFor(doc.bedId, doc.customBed);

  const add = (): void => {
    const chosen = OBSTACLE_PRESETS[preset] ?? OBSTACLE_PRESETS[0]!;
    // Dropped in the middle of the wall, where it is visible and easy to drag
    // to the right place, rather than at the origin where it may be off screen.
    const next: Obstacle = {
      id: `obs${Date.now().toString(36)}`,
      label: chosen.label,
      xMm: Math.round(doc.wall.widthMm / 2 - chosen.widthMm / 2),
      yMm: Math.round(doc.wall.heightMm / 2 - chosen.heightMm / 2),
      widthMm: chosen.widthMm,
      heightMm: chosen.heightMm,
      clearanceMm: 5,
    };
    onChange([...obstacles, next]);
  };

  const edit = (id: string, patch: Partial<Obstacle>): void => {
    onChange(obstacles.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  };

  const setSide = (key: keyof WallFrame, on: boolean): void => {
    const next: WallFrame = { ...frame, [key]: on };
    onFrameChange(next.left || next.right || next.bottom || next.top ? next : undefined);
  };

  return (
    <section className="obstacles" aria-label="Blocked zones, frame and custom plates">
      <h3 className="obstacles__title">
        Blocked zones
        <span className="obstacles__count tabular-nums">{obstacles.length}</span>
      </h3>

      <p className="obstacles__hint">
        Anything the honeycomb has to keep out of — a switch, a socket, a pipe, or
        just a patch of wall you want left clear. Draw one straight onto the plan
        with the <strong>Blocked zone</strong> tool, or add a standard size here.
        The planner cuts those cells out of whichever plates they land in.
      </p>

      <div className="obstacles__add">
        <select
          value={preset}
          onChange={(e) => setPreset(Number(e.target.value))}
          aria-label="Kind of obstacle"
        >
          {OBSTACLE_PRESETS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label} · {p.widthMm} × {p.heightMm}
            </option>
          ))}
        </select>
        <button type="button" className="button" onClick={add}>Add</button>
      </div>

      {obstacles.length > 0 && (
        <ul className="obstacles__list" role="list">
          {obstacles.map((o) => (
            <li className="obstacle" key={o.id}>
              <input
                className="obstacle__label"
                value={o.label}
                onChange={(e) => edit(o.id, { label: e.target.value })}
                aria-label="Zone name"
              />
              <button
                type="button"
                className="obstacle__remove hit-area"
                aria-label={`Remove ${o.label}`}
                title="Remove"
                onClick={() => onChange(obstacles.filter((x) => x.id !== o.id))}
              >
                ×
              </button>
              <div className="obstacle__fields tabular-nums">
                {([
                  ['xMm', 'X'], ['yMm', 'Y'], ['widthMm', 'W'],
                  ['heightMm', 'H'], ['clearanceMm', 'Gap'],
                ] as const).map(([key, label]) => (
                  <label key={key}>
                    <span>{label}</span>
                    <NumberField
                      value={o[key]}
                      step={key === 'clearanceMm' ? 1 : 10}
                      // A zone may sit anywhere, including off the wall while
                      // you drag it back — only its SIZE has a floor, and that
                      // is the same one a drawn zone has.
                      min={key === 'widthMm' || key === 'heightMm' ? MIN_ZONE_MM : 0}
                      max={MAX_WALL_MM}
                      onCommit={(v) => edit(o.id, { [key]: v })}
                      aria-label={`${o.label} ${label} in millimetres`}
                    />
                  </label>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* --- Frame ---------------------------------------------------------- */}
      <h3 className="obstacles__title">
        Frame
        {frameIsOn(doc.frame) && (
          <span className="obstacles__count tabular-nums">
            {FRAME_SIDE_LABELS.filter((s) => frame[s.key]).length}
          </span>
        )}
      </h3>
      <p className="obstacles__hint">
        A straight, closed edge: the honeycomb is cut off flat on the outermost
        cells&rsquo; own centre line and the thickness below is the wall left
        closing them — the same even rim a plate gets round a light switch.{' '}
        <strong>It costs the outer ring:</strong> those cells come out as open
        half hexagons and nothing mounts in one, so they leave the parts list
        when you switch an edge on and come back when you switch it off. It goes
        on the outside of the wall only, never on a seam where two plates meet,
        so they still interlock. Any plate carrying an edge is generated here
        rather than printed from a stock file.
      </p>
      <div className="frame__sides" role="group" aria-label="Framed edges">
        {FRAME_SIDE_LABELS.map((s) => (
          <label key={s.key} className="frame__side">
            <input
              type="checkbox"
              checked={Boolean(frame[s.key])}
              onChange={(e) => setSide(s.key, e.target.checked)}
            />
            <span>{s.label}</span>
          </label>
        ))}
      </div>
      <label className="frame__double">
        <input
          type="checkbox"
          checked={frame.holes}
          onChange={(e) => setSide('holes', e.target.checked)}
        />
        <span>Round the blocked zones too</span>
      </label>
      <label className="frame__thickness">
        <span>Thickness</span>
        <NumberField
          className="tabular-nums"
          value={frame.thicknessMm}
          min={MIN_BORDER_MM}
          max={MAX_BORDER_MM}
          step={0.2}
          decimals={1}
          disabled={!frameIsOn(doc.frame)}
          onCommit={(v) => onFrameChange({ ...frame, thicknessMm: v })}
          aria-label="Border thickness in millimetres"
        />
        <span className="frame__unit">mm</span>
      </label>

      {/* --- Generated plates ----------------------------------------------- */}
      {groups.length > 0 && (
        <>
          <h3 className="obstacles__title">
            Plates to generate
            <span className="obstacles__count tabular-nums">{groups.length}</span>
          </h3>
          <p className="obstacles__hint">
            These are not stock plates — they are cut to your wall, and the app
            makes them itself. Download the STL and print it; the geometry comes
            from the same measurements as everything else, so it drops straight
            into the honeycomb.
          </p>
          <ul className="obstacles__list" role="list">
            {groups.map((group, i) => {
              const label = `Custom plate ${String.fromCharCode(65 + i)}`;
              const info = built[i];
              const first = group.panels[0];
              if (!first || !info) return null;
              const lineKey = customLineKey(group.key);
              const lit = litLine === lineKey;

              if (info.error) {
                // Lights on hover like any other row, and this is the row where
                // it matters most: the message says a shape cannot be made, and
                // the only useful next question is WHICH plate on the wall.
                return (
                  <li
                    className="custom-panel custom-panel--bad"
                    key={group.key}
                    data-lit={lit ? 'true' : undefined}
                    onPointerEnter={() => onHoverLine?.(lineKey)}
                    onPointerLeave={() => onHoverLine?.(null)}
                  >
                    <p className="custom-panel__name">{label} — ×{group.panels.length}</p>
                    <p className="custom-panel__meta">{info.error}</p>
                  </li>
                );
              }

              const fits =
                bed === undefined ||
                (Math.max(info.widthMm, info.heightMm) <= Math.max(bed.width, bed.depth) &&
                  Math.min(info.widthMm, info.heightMm) <= Math.min(bed.width, bed.depth));
              const borders = FRAME_SIDE_LABELS.filter((s) => info.sides[s.key]).map((s) => s.label);

              /*
               * The plate this row is about, named the way the parts list names
               * it (`bom.customLineKey`) so the wall lights the same copies
               * whichever surface you point at. Hovering the row lights them,
               * clicking the name keeps them lit, and downloading pins them —
               * the file you just asked for is the plate glowing on the wall.
               */
              return (
                <li
                  className="custom-panel"
                  key={group.key}
                  // An attribute rather than a class, exactly as a parts-list
                  // row does it: the row already has a `--bad` state and this is
                  // not a third combination of it.
                  data-lit={lit ? 'true' : undefined}
                  onPointerEnter={() => onHoverLine?.(lineKey)}
                  onPointerLeave={() => onHoverLine?.(null)}
                >
                  <p className="custom-panel__name">
                    {onLightLine === undefined ? (
                      label
                    ) : (
                      <button
                        type="button"
                        className="custom-panel__light"
                        onClick={() => onLightLine(lineKey, true)}
                        title={
                          lit
                            ? `Stop highlighting ${label}`
                            : `Highlight every ${label} on the wall`
                        }
                      >
                        {label}
                      </button>
                    )}
                    <span className="custom-panel__qty tabular-nums">×{group.panels.length}</span>
                  </p>
                  <p className="custom-panel__meta tabular-nums">
                    {info.cells} cells · {Math.round(info.widthMm)} × {Math.round(info.heightMm)} mm
                    {' · '}{info.cm3.toFixed(1)} cm³
                    {borders.length > 0 && ` · framed ${borders.join(' + ').toLowerCase()}`}
                  </p>
                  {!fits && bed && (
                    <p className="custom-panel__meta custom-panel__meta--warn">
                      Too big for the {bed.label} bed ({bed.width} × {bed.depth}).
                    </p>
                  )}
                  <div className="custom-panel__actions">
                    <StackMenu
                      label={label}
                      needed={group.panels.length}
                      // Pinned, never toggled, and pinned when the popover
                      // OPENS rather than when the file is written: you are
                      // about to be asked how many, and "how many of which
                      // one" is a question the wall answers. Hover has it lit
                      // already; this is what keeps it lit once the pointer
                      // leaves the row for the popover.
                      onOpen={() => onLightLine?.(lineKey, false)}
                      onDownload={(copies) => onDownload(first, label, copies)}
                    />
                    <button
                      type="button"
                      className="button"
                      title="Parameters for the OpenSCAD customiser, if you want to change the shape by hand"
                      onClick={() => {
                        onLightLine?.(lineKey, false);
                        const spec = panelModelSpec(first, doc.panels, doc.frame);
                        const params = toCustomiserCells(spec.cells) ?? group.params;
                        if (!params) {
                          onCopy('', label);
                          return;
                        }
                        onCopy(toCustomiserScad(params, label, info.sides), label);
                      }}
                    >
                      Copy settings
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
