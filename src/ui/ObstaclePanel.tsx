/**
 * Switches, sockets and pipes — and the custom panels they force.
 *
 * A stock panel is a rectangle of cells and one of seven shipped STLs. Put a
 * light switch in the middle of a wall and the panels around it are none of
 * those: they are the same block with cells missing, and they have to be
 * generated. This panel is where you say where the switch is, and where you get
 * the parameters for the OpenSCAD customiser that makes the plate.
 *
 * Pure presentation, like BomPanel: it renders what it is given and hands every
 * change back through a callback.
 */

import { useState } from 'react';

import {
  customPanelGroups, customPanelSizeMm, toCustomiserScad,
} from '../core/customiser';
import { OBSTACLE_PRESETS } from '../core/obstacles';
import type { LayoutDoc, Obstacle } from '../core/types';
import './ObstaclePanel.css';

export interface ObstaclePanelProps {
  doc: LayoutDoc;
  onChange: (obstacles: Obstacle[]) => void;
  onCopy: (text: string, what: string) => void;
}

const num = (v: number): string => String(Math.round(v));

export function ObstaclePanel({ doc, onChange, onCopy }: ObstaclePanelProps) {
  const [preset, setPreset] = useState(0);
  const obstacles = doc.obstacles ?? [];
  const groups = customPanelGroups(doc.panels);

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

  return (
    <section className="obstacles" aria-label="Obstacles and custom panels">
      <h3 className="obstacles__title">
        Obstacles
        <span className="obstacles__count tabular-nums">{obstacles.length}</span>
      </h3>

      <p className="obstacles__hint">
        Anything the honeycomb has to go round. The planner cuts those cells out of
        whichever panels they land in, and those panels then have to be generated
        rather than printed from a stock file.
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
                aria-label="Obstacle name"
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
                    <input
                      type="number"
                      value={num(o[key])}
                      step={key === 'clearanceMm' ? 1 : 10}
                      onChange={(e) => edit(o.id, { [key]: Number(e.target.value) })}
                      aria-label={`${o.label} ${label} in millimetres`}
                    />
                  </label>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {groups.length > 0 && (
        <>
          <h3 className="obstacles__title">
            Custom panels
            <span className="obstacles__count tabular-nums">{groups.length}</span>
          </h3>
          <p className="obstacles__hint">
            These are not stock plates. Paste each parameter block into the honeycomb
            customiser to generate the STL — it works on the same 23.6 mm lattice, so
            the plate drops straight into the wall.
          </p>
          <ul className="obstacles__list" role="list">
            {groups.map((group, i) => {
              const label = `Custom panel ${String.fromCharCode(65 + i)}`;
              if (group.params === null) {
                return (
                  <li className="custom-panel custom-panel--bad" key={group.key}>
                    <p className="custom-panel__name">{label} — ×{group.panels.length}</p>
                    <p className="custom-panel__meta">
                      This shape is outside what the customiser can express (it tops out
                      at 13 columns of 12). Split the wall differently, or move the
                      obstacle.
                    </p>
                  </li>
                );
              }
              const size = customPanelSizeMm(group.params);
              return (
                <li className="custom-panel" key={group.key}>
                  <p className="custom-panel__name">
                    {label}
                    <span className="custom-panel__qty tabular-nums">×{group.panels.length}</span>
                  </p>
                  <p className="custom-panel__meta tabular-nums">
                    {group.params.cellCount} cells · {group.params.columns} columns ·{' '}
                    {Math.round(size.widthMm)} × {Math.round(size.heightMm)} mm
                  </p>
                  <button
                    type="button"
                    className="button"
                    onClick={() => onCopy(toCustomiserScad(group.params!, label), label)}
                  >
                    Copy customiser settings
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
