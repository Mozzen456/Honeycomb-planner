/**
 * From a planned panel to a printable plate.
 *
 * `honeycomb.ts` is pure geometry — cells in, triangles out — and knows nothing
 * about documents. This is the bridge: it decides which cells a given plate on a
 * given wall really has, and what border it carries, so that the wall view, the
 * parts list, the STL download and the customiser export all ask the same
 * question and get the same answer.
 *
 * **The border belongs to the ASSEMBLY, not to a plate.** A plate hands the
 * generator every cell in the wall, not just its own, and the generator only
 * raises an edge where a lattice position is EMPTY. So a seam between two plates
 * never grows a border — the position is taken by the plate next door — and the
 * two still interlock exactly as they always did. Only the outside of the whole
 * wall, and the holes cut in it, get an edge.
 *
 * That one rule replaces what used to be four global cut lines, and it is why
 * nothing else here has to know about steps, L-shapes or blocked zones: they are
 * all just places where the next position is empty.
 */

import {
  cellCentreBounds,
  DEFAULT_BORDER_MM,
  hasFrame,
  NO_FRAME,
  type BorderSpec,
  type FrameSide,
} from './honeycomb';
import { hexKey, hexToMm, panelCells, placedPanelCells } from './hex';
import { obstacleRects } from './obstacles';
import type { Hex, LayoutDoc, Obstacle, PlacedPanel, WallFrame } from './types';

export const NO_WALL_FRAME: WallFrame = {
  left: false, right: false, bottom: false, top: false,
  holes: false, thicknessMm: DEFAULT_BORDER_MM,
};

export const frameIsOn = (f: WallFrame | undefined): boolean =>
  f !== undefined && (f.left || f.right || f.bottom || f.top || f.holes);

/**
 * Every cell of every panel, as keys.
 *
 * The cells the plates REALLY have — `placedPanelCells`, so a blocked zone's
 * hole counts as empty and grows an edge, which is exactly what you want round a
 * light switch.
 */
export function assemblyOccupancy(panels: readonly PlacedPanel[]): Set<string> {
  const out = new Set<string>();
  for (const p of panels) for (const c of placedPanelCells(p)) out.add(hexKey(c));
  return out;
}

/** Every cell of every panel's full block, before anything was cut out of it. */
export function assemblyBlockCells(panels: readonly PlacedPanel[]): Hex[] {
  const seen = new Set<string>();
  const out: Hex[] = [];
  for (const p of panels) {
    for (const c of panelCells(p.origin, p.columns, p.rows)) {
      const k = hexKey(c);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

/**
 * The assembly, indexed once: who is where, and where the outside is.
 *
 * Built by every border question, so it is built in one place.
 */
function assemblyIndex(panels: readonly PlacedPanel[]) {
  const occupied = new Set<string>();
  const ownerOf = new Map<string, string>();
  for (const p of panels) {
    for (const c of placedPanelCells(p)) {
      const k = hexKey(c);
      occupied.add(k);
      ownerOf.set(k, p.id);
    }
  }
  /*
   * The BOUNDS come from the whole BLOCK, `omit` and all, while `occupied` comes
   * from what survives it. The two answer different questions and conflating
   * them is a runaway.
   *
   * `occupied` is "is this position filled", which is what decides a seam and
   * where a hole's edge may grow — an omitted cell is empty for that purpose.
   * `bounds` is "how far does the plate REACH", and since D86 it is the line the
   * plate is cut ON. Taken from the surviving cells it moves inward the moment
   * anything is omitted: switching a border on cuts the outer ring, the bounds
   * follow that ring inward, and the next edit cuts a ring that has already
   * gone. Measured, the plate came back one whole lattice step short on every
   * bordered side, and would have lost another on every subsequent edit.
   *
   * A cell in `omit` still PRINTS — cut round a switch, or halved by the edge —
   * so the plate genuinely reaches that far. The planner-versus-printer split
   * (D56), landing inside one function.
   */
  return { occupied, ownerOf, bounds: cellCentreBounds(assemblyBlockCells(panels)) };
}

/**
 * Exactly one plate prints each piece of edge.
 *
 * A position on the outside can touch TWO plates at once — the corner where
 * they butt — and without an owner BOTH grow it. Printed, the two plates then
 * overlap by a whole cell and the wall will not go together.
 *
 * It goes to whichever plate holds the MOST of its neighbours, because that is
 * the plate it is actually attached to: given to the other one it becomes a tab
 * hanging off a corner, which is both fragile and a plate wider than its own
 * cells. Ties break on the canonically smallest neighbouring CELL — a property
 * of the lattice rather than of the panel list, so both plates reach the same
 * answer and neither has to know about the other.
 */
function ownerOfPosition(
  p: Hex,
  index: ReturnType<typeof assemblyIndex>,
): string | undefined {
  const votes = new Map<string, { n: number; best: string }>();
  const vote = (k: string): void => {
    const owner = index.ownerOf.get(k);
    if (owner === undefined) return;
    const seen = votes.get(owner);
    if (seen === undefined) votes.set(owner, { n: 1, best: k });
    else {
      seen.n++;
      if (k < seen.best) seen.best = k;
    }
  };

  for (const d of RING) {
    const k = hexKey({ q: p.q + d.q, r: p.r + d.r });
    if (index.occupied.has(k)) vote(k);
  }

  // A position that squares off an OUTSIDE CORNER touches no cell at all — it
  // sits diagonally past the corner one — so the vote has to reach one step
  // further or the corner belongs to nobody and never gets printed.
  if (votes.size === 0) {
    for (const d of RING) {
      const mid = { q: p.q + d.q, r: p.r + d.r };
      for (const dd of RING) {
        const k = hexKey({ q: mid.q + dd.q, r: mid.r + dd.r });
        if (index.occupied.has(k)) vote(k);
      }
    }
  }
  let winner: string | undefined;
  let winning: { n: number; best: string } | undefined;
  for (const [owner, v] of votes) {
    if (
      winning === undefined ||
      v.n > winning.n ||
      (v.n === winning.n && v.best < winning.best)
    ) {
      winner = owner;
      winning = v;
    }
  }
  return winner;
}

/** Which side of the assembly a position lies past, or none for a hole. */
function outwardSides(
  p: Hex,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
): FrameSide[] {
  const eps = 1e-6;
  const q = hexToMm(p);
  const out: FrameSide[] = [];
  if (q.x < bounds.minX - eps) out.push('left');
  if (q.x > bounds.maxX + eps) out.push('right');
  if (q.y < bounds.minY - eps) out.push('bottom');
  if (q.y > bounds.maxY + eps) out.push('top');
  return out;
}

/**
 * The edge THIS plate is responsible for.
 *
 * One walk, two answers: the geometry hands it to the generator, and the sides
 * label the plate and group it. Sharing the walk is what stops a plate being
 * labelled "edged bottom" while its neighbour prints that bottom edge.
 */
function ownedBorder(
  panel: PlacedPanel,
  panels: readonly PlacedPanel[],
  frame: WallFrame | undefined,
): { sides: FrameSide[]; holes: boolean } {
  if (!frameIsOn(frame) || frame === undefined) return { sides: [], holes: false };
  const index = assemblyIndex(panels);
  const sides = new Set<FrameSide>();
  let holes = false;
  const seen = new Set<string>();

  for (const c of placedPanelCells(panel)) {
    for (const d of RING) {
      const p = { q: c.q + d.q, r: c.r + d.r };
      const k = hexKey(p);
      if (index.occupied.has(k) || seen.has(k)) continue;
      seen.add(k);
      if (ownerOfPosition(p, index) !== panel.id) continue;
      const outward = outwardSides(p, index.bounds);
      if (outward.length === 0) {
        if (frame.holes) holes = true;
      } else if (outward.every((side) => frame[side])) {
        for (const side of outward) sides.add(side);
      }
    }
  }
  return { sides: [...sides], holes };
}

/**
 * The cells the plate's own EDGE cuts through (D86).
 *
 * The border is not added beyond the honeycomb any more — the honeycomb is cut
 * off flat and the cut cells are left open, which is what `inner box.jpeg`
 * shows. So the outermost column and row of the assembly come out as HALF
 * CELLS, and nothing mounts in a half cell.
 *
 * They go into `omit` for the same reason a switch's cells do: the planner has
 * to stop offering them while the plate goes on printing them, cut. That is the
 * planner-versus-printer split this module owns (D56), and it is why this is
 * here and not in the generator — the generator can cut a cell, but only the
 * document can stop the app hanging a shelf on it.
 *
 * A cell is cut when its own centre lies ON the assembly's outer line, which is
 * where the bores are cut. Nothing else comes close: the next column is
 * `ROW_STEP` away and the next row half a `PITCH`, both further out than a
 * mouth's own radius, so exactly one ring is affected however the block falls.
 */
export function borderCutCells(
  panels: readonly PlacedPanel[],
  frame: WallFrame | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!frameIsOn(frame) || frame === undefined) return out;
  const index = assemblyIndex(panels);
  const eps = 1e-6;
  for (const p of panels) {
    // The whole block, not `placedPanelCells`. `cutAroundObstacles` rebuilds
    // `omit` from the block every time, so an answer read off the surviving
    // cells is empty on the second call and the ring comes back.
    for (const c of panelCells(p.origin, p.columns, p.rows)) {
      const m = hexToMm(c);
      if (
        (frame.left && m.x <= index.bounds.minX + eps) ||
        (frame.right && m.x >= index.bounds.maxX - eps) ||
        (frame.bottom && m.y <= index.bounds.minY + eps) ||
        (frame.top && m.y >= index.bounds.maxY - eps)
      ) out.add(hexKey(c));
    }
  }
  return out;
}

/**
 * What border, if any, this wall's plates carry.
 *
 * Returns undefined when nothing is switched on, so the generator can skip the
 * whole phantom walk rather than build an empty one.
 */
export function borderSpecFor(
  panels: readonly PlacedPanel[],
  frame: WallFrame | undefined,
  /** The plate being generated. Omit to let one plate carry the whole edge. */
  owner?: PlacedPanel,
  /**
   * The blocked zones, so a border round one can be cut to the zone itself.
   *
   * Optional because the generator works from cells alone for everything else,
   * and a wall with no zones has nothing to pass. Absent, the edge round a hole
   * falls back to following the honeycomb's own steps — which is what it did
   * before, and what left plate inside the switch (D77).
   */
  obstacles?: readonly Obstacle[],
): BorderSpec | undefined {
  if (!frameIsOn(frame) || frame === undefined) return undefined;
  const index = assemblyIndex(panels);
  // Grown by the clearance, so the border keeps off exactly what the CELLS keep
  // off. Two rules for one zone would put the rail inside the gap the cells
  // were cut to leave.
  // Through `obstacleRects`, so a zone made of several rectangles is clipped
  // against exactly the rectangles the cells were cut against. An L clipped
  // against its bounding box would wall off the inside of the L, which is
  // honeycomb the user kept.
  const keepClear = (obstacles ?? []).flatMap(obstacleRects);
  return {
    thicknessMm: frame.thicknessMm > 0 ? frame.thicknessMm : DEFAULT_BORDER_MM,
    occupied: index.occupied,
    sides: { left: frame.left, right: frame.right, bottom: frame.bottom, top: frame.top },
    holes: frame.holes,
    bounds: index.bounds,
    ...(keepClear.length > 0 ? { keepClear } : {}),
    ...(owner ? { owns: (p: Hex) => ownerOfPosition(p, index) === owner.id } : {}),
  };
}

/**
 * What to hand the generator for one plate: its own cells, and the wall's border.
 *
 * A plate's cells are simply `placedPanelCells` — the border costs none of them,
 * which is the whole difference between this border and the customiser's cut.
 */
export function panelModelSpec(
  panel: PlacedPanel,
  panels: readonly PlacedPanel[],
  frame: WallFrame | undefined,
  obstacles?: readonly Obstacle[],
): { cells: Hex[]; clipped: Hex[]; border: BorderSpec | undefined } {
  const cells = placedPanelCells(panel);
  /*
   * The cells a zone ate are handed to the generator SEPARATELY, to be printed
   * cut rather than not printed at all.
   *
   * This is the planner-versus-printer split this module exists to own (D56),
   * and here it is load-bearing twice over. The planner must go on treating
   * these cells as gone — a cell a switch passes through is not somewhere you
   * can mount anything, so it must not be offered, counted or fixed into. The
   * PLATE should still have them, cut off flush at the aperture, because that
   * is what a plate cut for a switch looks like: open cells right up to a thin
   * even wall, not an apron of paved-over hexagons (D81).
   *
   * `cells` is unchanged, so everything that counts cells — the parts list, the
   * file name, the fixing plan — sees exactly what it saw before.
   */
  const kept = new Set(cells.map(hexKey));
  const clipped = panelCells(panel.origin, panel.columns, panel.rows)
    .filter((c) => !kept.has(hexKey(c)));
  return {
    cells,
    clipped,
    border: borderSpecFor(panels, frame, panel, obstacles),
  };
}

/** The same thing, straight from a document. */
export function panelModelSpecFor(panel: PlacedPanel, doc: LayoutDoc) {
  return panelModelSpec(panel, doc.panels, doc.frame, doc.obstacles);
}

/**
 * Which border sides this plate actually prints.
 *
 * Not "which sides it is near" — which sides it OWNS, through the same rule the
 * geometry uses. A plate in the middle of the wall owns none and prints as a
 * plain plate.
 */
export function panelFrameSides(
  panel: PlacedPanel,
  panels: readonly PlacedPanel[],
  frame: WallFrame | undefined,
): WallFrame {
  const thicknessMm = frame?.thicknessMm ?? DEFAULT_BORDER_MM;
  const owned = ownedBorder(panel, panels, frame);
  const has = new Set(owned.sides);
  return {
    left: has.has('left'),
    right: has.has('right'),
    bottom: has.has('bottom'),
    top: has.has('top'),
    holes: owned.holes,
    thicknessMm,
  };
}

const RING: readonly Hex[] = [
  { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 },
  { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 },
];

/** `panelFrameSides` as a short string, for grouping identical plates. */
export function panelFrameKey(
  panel: PlacedPanel,
  panels: readonly PlacedPanel[],
  frame: WallFrame | undefined,
): string {
  if (!frameIsOn(frame)) return '';
  const s = panelFrameSides(panel, panels, frame);
  const letters =
    `${s.left ? 'L' : ''}${s.right ? 'R' : ''}${s.bottom ? 'B' : ''}${s.top ? 'T' : ''}` +
    `${s.holes ? 'H' : ''}`;
  // Empty means "this plate carries no edge", which is what every caller tests
  // for. Appending the thickness unconditionally made every plate on a bordered
  // wall look edged, including the ones in the middle — they came out on the
  // generated list with no reason given.
  return letters === '' ? '' : `${letters}@${s.thicknessMm}`;
}

/** Does this plate carry an edge anywhere? Then it is not the stock STL. */
export function panelIsBordered(
  panel: PlacedPanel,
  panels: readonly PlacedPanel[],
  frame: WallFrame | undefined,
): boolean {
  return panelFrameKey(panel, panels, frame) !== '';
}

/**
 * Is this plate one of the shipped STLs, or does it have to be generated?
 *
 * Three ways to stop being stock: a hole cut in it, an edge on it, or a size no
 * shipped file comes in. Printing the stock file instead would put a hexagon
 * where the light switch is.
 */
export function isGeneratedPanel(panel: PlacedPanel): boolean {
  return (Array.isArray(panel.omit) && panel.omit.length > 0) || isGeneratedSize(panel.partId);
}

/** Ids of plates the app sizes itself, rather than taking from `models/`. */
export const GENERATED_PREFIX = 'generated/';

export const isGeneratedSize = (partId: string): boolean =>
  partId.startsWith(GENERATED_PREFIX);

/** A file name a person can match to the plate on their screen. */
export function panelModelFileName(label: string, cellCount: number): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug || 'honeycomb-plate'}-${cellCount}cell.stl`;
}

export { hasFrame, NO_FRAME };
