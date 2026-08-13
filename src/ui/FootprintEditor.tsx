/**
 * A patch of wall you click cells on.
 *
 * The question it answers is the one geometry cannot: how much wall does this
 * part take? For 27 of the 51 shipped parts the catalogue's answer is the
 * bounding box laid over the lattice — a bound, not a measurement (PARKED P1) —
 * and which cells an installer actually uses is a choice. This is where a person
 * makes it, for an imported part in `ImportDialog` and for any part at all in
 * `PartInspector`.
 *
 * ---------------------------------------------------------------------------
 * It draws from `hexToMm` and `hexCorners`, and that is not a detail
 * ---------------------------------------------------------------------------
 *
 * It used to carry its own copy of the embedding — `x = PITCH·(q + r/2)`,
 * `y = ROW_STEP·r`, hexagons drawn with a vertex at the top. That is the
 * POINTY-top frame the app was drawn in before D35, transposed from the wall's
 * own `x = ROW_STEP·q, y = PITCH·(r + q/2)`. A transpose is a reflection: a
 * symmetric footprint looked identical, and an L-shaped one came out MIRRORED
 * from the shape that landed on the wall.
 *
 * That is the fourth copy of the hex embedding this repo has had to hunt down
 * (CLAUDE.md keeps the list). It now calls the same two functions the wall does,
 * so an editor that disagrees with the wall is no longer possible.
 *
 * The only frame change left is SVG's: its y axis points down and the wall's
 * points up, so y is negated once, here, on the way out of `hexToMm`.
 */

import { hexCorners, hexKey, hexToMm } from '../core/hex';
import { CELL, INSERT, PITCH } from '../core/constants';
import type { Hex } from '../core/types';
import './FootprintEditor.css';

export interface FootprintEditorProps {
  cells: readonly Hex[];
  onToggle: (cell: Hex) => void;
  /** Extra rings of empty cells around the selection, to grow into. */
  reach?: number;
  /** Marks the cells as carrying an insert — the thing the part hangs on. */
  showInserts?: boolean;
  /**
   * Cells of the part that something can be installed INTO — drawn open,
   * because that is what they are: a hole in the part rather than material.
   */
  sockets?: readonly Hex[];
  label?: string;
}

export function FootprintEditor(props: FootprintEditorProps): JSX.Element {
  const { cells, onToggle, reach: extra = 2, showInserts = false, sockets = [] } = props;
  const chosen = new Set(cells.map(hexKey));
  const open = new Set(sockets.map(hexKey));

  // Always show a ring or two beyond whatever is selected, so there is
  // somewhere to grow into.
  const reach = cells.reduce(
    (max, c) => Math.max(max, Math.abs(c.q), Math.abs(c.r), Math.abs(c.q + c.r)),
    1,
  ) + extra;

  const grid: Hex[] = [];
  for (let r = -reach; r <= reach; r++) {
    for (let q = -reach; q <= reach; q++) {
      if (Math.abs(q + r) > reach) continue;
      grid.push({ q, r });
    }
  }

  // SVG's y runs down the screen; the wall's runs up it. One negation, here.
  const pts = grid.map((c) => {
    const m = hexToMm(c);
    return { cell: c, x: m.x, y: -m.y };
  });
  const minX = Math.min(...pts.map((p) => p.x)) - PITCH;
  const maxX = Math.max(...pts.map((p) => p.x)) + PITCH;
  const minY = Math.min(...pts.map((p) => p.y)) - PITCH;
  const maxY = Math.max(...pts.map((p) => p.y)) + PITCH;

  /** The cell's real outline, at its real place, with a hairline of gap. */
  const cellPath = (cell: Hex, acrossFlats: number): string =>
    hexCorners(cell, acrossFlats)
      .map((p) => `${p.x.toFixed(2)},${(-p.y).toFixed(2)}`)
      .join(' ');

  return (
    <svg
      className="footprint"
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      role="group"
      aria-label={props.label ?? 'Footprint editor'}
    >
      {pts.map(({ cell }) => {
        const key = hexKey(cell);
        const on = chosen.has(key);
        const origin = cell.q === 0 && cell.r === 0;
        return (
          <polygon
            key={key}
            points={cellPath(cell, CELL.mouthAcrossFlats)}
            className={`footprint__cell${on ? ' footprint__cell--on' : ''}${
              on && open.has(key) ? ' footprint__cell--socket' : ''
            }${origin ? ' footprint__cell--anchor' : ''}`}
            onClick={() => onToggle(cell)}
            role="checkbox"
            aria-checked={on}
            aria-label={`cell ${cell.q}, ${cell.r}`}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onToggle(cell);
              }
            }}
          />
        );
      })}
      {/*
        The insert that fastens the part, drawn as the thing you would actually
        see: its 22.5 mm flange, OVERLAPPING the 22.0 mm mouth it cannot fit
        into. That overlap is the physical fact — the flange is wider than the
        hole, so it seats proud — and it is measured, not a drawing convention.
      */}
      {showInserts && pts.filter(({ cell }) => chosen.has(hexKey(cell))).map(({ cell }) => (
        <polygon
          key={`insert-${hexKey(cell)}`}
          className="footprint__insert"
          points={cellPath(cell, INSERT.flangeAcrossFlats)}
          pointerEvents="none"
        />
      ))}
    </svg>
  );
}
