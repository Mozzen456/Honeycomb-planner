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
  heldFragments,
  plateGeometryKey,
  type BorderSpec,
  type FrameSide,
} from './honeycomb';
import { hexKey, hexToMm, keyToHex, panelCells, placedPanelCells } from './hex';
import { cellRemainderBox, obstacleRegions, obstructedCells } from './obstacles';
import { bedFor, MARGIN_X, MARGIN_Y, PITCH } from './constants';
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
function assemblyIndex(panels: readonly PlacedPanel[], frame?: WallFrame): AssemblyIndex {
  /*
   * Memoised on the panels and frame by identity. Every per-plate question —
   * its border spec, its edge letters, its geometry key — asks for the whole
   * assembly, so unmemoised a 53-plate wall indexed the whole wall 53 times per
   * question: a quarter of a second, on every edit that re-cut a plate.
   */
  const hit = indexCache.get(panels);
  if (hit && hit.frame === frame) return hit.index;
  const index = buildAssemblyIndex(panels, frame);
  indexCache.set(panels, { frame, index });
  return index;
}

interface AssemblyIndex {
  occupied: ReadonlySet<string>;
  ownerOf: ReadonlyMap<string, string>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

const indexCache = new WeakMap<
  readonly PlacedPanel[],
  { frame: WallFrame | undefined; index: AssemblyIndex }
>();

function buildAssemblyIndex(panels: readonly PlacedPanel[], frame?: WallFrame): AssemblyIndex {
  const occupied = new Set<string>();
  const ownerOf = new Map<string, string>();
  /*
   * The ring the EDGE cuts is OCCUPIED, even though it is not in
   * `placedPanelCells` (D87).
   *
   * `omit` is how those cells leave the planner, and `occupied` answers a
   * different question: is this position PRINTED. A border piece is raised only
   * where a position is empty, so with the ring reading as empty the whole
   * perimeter looked like a hole and every plate filled it back in with solid
   * hexagons — sitting exactly where the cut cells' missing halves are, which is
   * a honeycomb half filled in all the way round. Reported as "a small defect at
   * the corners", where two runs of them meet and it is most obvious.
   *
   * A zone's cells are NOT added: a zone is a genuine hole in the wall, the
   * thing the `holes` switch exists for.
   */
  const edge = borderCutCells(panels, frame);
  for (const p of panels) {
    for (const c of panelCells(p.origin, p.columns, p.rows)) {
      const k = hexKey(c);
      if (!edge.has(k)) continue;
      occupied.add(k);
      ownerOf.set(k, p.id);
    }
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
  index: AssemblyIndex,
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
  const index = assemblyIndex(panels, frame);
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
  // The plate's own lines, straight from the blocks — never through
  // `assemblyIndex`, which now asks THIS function which positions are occupied.
  const bounds = cellCentreBounds(assemblyBlockCells(panels));
  const eps = 1e-6;
  for (const p of panels) {
    // The whole block, not `placedPanelCells`. `cutAroundObstacles` rebuilds
    // `omit` from the block every time, so an answer read off the surviving
    // cells is empty on the second call and the ring comes back.
    for (const c of panelCells(p.origin, p.columns, p.rows)) {
      const m = hexToMm(c);
      if (
        (frame.left && m.x <= bounds.minX + eps) ||
        (frame.right && m.x >= bounds.maxX - eps) ||
        (frame.bottom && m.y <= bounds.minY + eps) ||
        (frame.top && m.y >= bounds.maxY - eps)
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
  const index = assemblyIndex(panels, frame);
  // Grown by the clearance, so the border keeps off exactly what the CELLS keep
  // off. Two rules for one zone would put the rail inside the gap the cells
  // were cut to leave.
  // Through `obstacleRects`, so a zone made of several rectangles is clipped
  // against exactly the rectangles the cells were cut against. An L clipped
  // against its bounding box would wall off the inside of the L, which is
  // honeycomb the user kept.
  // ...and a drawn outline as its convex pieces, edges and all, so the plate is
  // cut along the line that was drawn rather than stepped round it (D109).
  const keepClear = (obstacles ?? []).flatMap(obstacleRegions);
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
  /** The plates a zone set aside (`LayoutDoc.covered`), for their stranded edge. */
  covered?: readonly PlacedPanel[],
  /** The printer bed, which a plate taking a stranded cell must still fit (D110). */
  bed?: PlateBed,
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
  const base = baseModelSpec(panel, panels, frame, obstacles, covered, bed);
  /*
   * ...less the fragments another plate holds, plus the ones it holds of its
   * neighbours' (D111). A cut cell that comes out loose in its own plate but
   * flush against another plate's whole cell is printed BY that plate, where it
   * is joined on.
   */
  const moved = heldTransfers(panels, frame, obstacles, covered, bed).get(panel.id);
  if (moved === undefined) return { cells, clipped: base.clipped, border: base.border };
  return {
    cells,
    clipped: [...base.clipped.filter((c) => !moved.give.has(hexKey(c))), ...moved.take],
    border: base.border,
  };
}

/** `panelModelSpec` before any fragment changes hands. */
function baseModelSpec(
  panel: PlacedPanel,
  panels: readonly PlacedPanel[],
  frame: WallFrame | undefined,
  obstacles: readonly Obstacle[] | undefined,
  covered: readonly PlacedPanel[] | undefined,
  bed: PlateBed | undefined,
): { cells: Hex[]; clipped: Hex[]; border: BorderSpec | undefined } {
  const cells = placedPanelCells(panel);
  const kept = new Set(cells.map(hexKey));
  const clipped = panelCells(panel.origin, panel.columns, panel.rows)
    .filter((c) => !kept.has(hexKey(c)));
  // ...and the stranded edge of any plate the zone set aside next to it (D110).
  if (frameIsOn(frame)) clipped.push(...(adoptedCells(panels, covered, obstacles, bed).get(panel.id) ?? []));
  return {
    cells,
    clipped,
    border: borderSpecFor(panels, frame, panel, obstacles),
  };
}

/**
 * Which cut cells change plates, and between which (D111).
 *
 * A cut can leave a fragment that is joined to nothing in its own plate yet
 * lies flush along a whole cell of the next: the top row of a plate a zone has
 * eaten from below, or the arm of a cell at a concave corner. Printed where it
 * was planned it is a separate fleck in that plate's file — loose in the wall,
 * held by nothing. The generator names them (`heldFragments`); here each is
 * handed to the plate that prints the cell it is flush against, if that plate
 * still fits the bed with it (the same check as D110), and otherwise left
 * where it was.
 *
 * Memoised like everything else here: one pass over the plates a zone or the
 * edge actually cuts, per change of the wall.
 */
function heldTransfers(
  panels: readonly PlacedPanel[],
  frame: WallFrame | undefined,
  obstacles: readonly Obstacle[] | undefined,
  covered: readonly PlacedPanel[] | undefined,
  bed: PlateBed | undefined,
): ReadonlyMap<string, { give: Set<string>; take: Hex[] }> {
  const out = new Map<string, { give: Set<string>; take: Hex[] }>();
  if (!frameIsOn(frame) || !obstacles || obstacles.length === 0 || !bed) return out;
  const hit = transferCache.get(panels);
  if (hit && hit.frame === frame && hit.obstacles === obstacles && hit.covered === covered &&
      hit.bedW === bed.width && hit.bedD === bed.depth) return hit.moves;

  const blockOwner = new Map<string, string>();
  for (const p of panels) {
    for (const c of panelCells(p.origin, p.columns, p.rows)) blockOwner.set(hexKey(c), p.id);
  }
  const fit = footprints(panels, covered, obstacles, bed);
  const entry = (id: string) => {
    let e = out.get(id);
    if (!e) { e = { give: new Set(), take: [] }; out.set(id, e); }
    return e;
  };
  for (const p of panels) {
    /*
     * Only a plate a ZONE cuts can leave a held fragment — the edge cuts a
     * straight run and leaves its half cells joined along it — so the plates
     * round the rim, which all have cut cells once a border is on, are not
     * generated here for nothing.
     */
    const block = panelCells(p.origin, p.columns, p.rows);
    if (obstructedCells(obstacles, block).size === 0 &&
        !(adoptedCells(panels, covered, obstacles, bed).get(p.id)?.length)) continue;
    const spec = baseModelSpec(p, panels, frame, obstacles, covered, bed);
    if (spec.clipped.length === 0 || spec.cells.length === 0) continue;
    let fragments;
    try {
      fragments = heldFragments(spec);
    } catch {
      continue;
    }
    for (const f of fragments) {
      const holder = blockOwner.get(f.holder);
      if (holder === undefined || holder === p.id) continue;
      const hexes = f.cells.map(keyToHex);
      if (!fit.takeAll(holder, hexes)) continue;
      for (const k of f.cells) entry(p.id).give.add(k);
      entry(holder).take.push(...hexes);
    }
  }
  transferCache.set(panels, {
    frame, obstacles, covered, bedW: bed.width, bedD: bed.depth, moves: out,
  });
  return out;
}

const transferCache = new WeakMap<
  readonly PlacedPanel[],
  {
    frame: WallFrame | undefined;
    obstacles: readonly Obstacle[] | undefined;
    covered: readonly PlacedPanel[] | undefined;
    bedW: number;
    bedD: number;
    moves: ReadonlyMap<string, { give: Set<string>; take: Hex[] }>;
  }
>();

/** The same thing, straight from a document. */
export function panelModelSpecFor(panel: PlacedPanel, doc: LayoutDoc) {
  return panelModelSpec(panel, doc.panels, doc.frame, doc.obstacles, doc.covered, bedOfDoc(doc));
}

/** Only the size of a bed matters here. */
export interface PlateBed {
  width: number;
  depth: number;
}

/** The document's printer bed, or undefined for one this build does not know. */
export function bedOfDoc(doc: Pick<LayoutDoc, 'bedId' | 'customBed'>): PlateBed | undefined {
  return bedFor(doc.bedId, doc.customBed);
}

/**
 * The cut cells a SET-ASIDE plate leaves stranded, each handed to the standing
 * plate it touches most (D110).
 *
 * A plate whose every cell a zone touches is set aside whole (D108) — nothing
 * of it can take a part. But "touches" is not "covers": along a sloping zone a
 * plate's bottom row can sit mostly below the line, and setting the plate aside
 * took that strip with it. Measured on a 2400 × 1200 wall under a roof sloping
 * 450 mm: the cut edge, which should run straight along the line, fell short of
 * it by up to 14.6 mm wherever such a plate sat — a notch one cell deep.
 *
 * Every cell of such a plate that a zone cuts, and that no standing plate
 * holds, goes to the standing plate whose block holds the most of its six
 * neighbours (ties to the smallest neighbouring cell, as with the edge, D60).
 * It joins that plate's `clipped` list, so the generator cuts it exactly as it
 * cuts that plate's own: whatever is outside the zone is printed, and a cell
 * with nothing worth printing is dropped there, by the one rule that decides it.
 * A cell touching no standing plate stays stranded — printed on its own it
 * would be a loose shard.
 *
 * Planner-side nothing changes: the cell is in no plate's `cells`, so nothing
 * mounts in it, counts it or fixes into it, which is the D56 split again.
 */
export function adoptedCells(
  panels: readonly PlacedPanel[],
  covered: readonly PlacedPanel[] | undefined,
  obstacles: readonly Obstacle[] | undefined,
  /**
   * The bed every plate has to fit. A plate takes a stranded cell only if its
   * block grown by that cell still fits it, either way round; otherwise the next
   * neighbour is asked, and failing that the cell stays stranded — a notch in
   * the cut is a blemish, a plate that does not fit the printer is not a part.
   * Unknown, nothing is adopted: there is nothing to check a plate against.
   */
  bed: PlateBed | undefined,
): ReadonlyMap<string, Hex[]> {
  const none = new Map<string, Hex[]>();
  if (!covered || covered.length === 0 || !obstacles || obstacles.length === 0 || !bed) return none;
  const hit = adoptCache.get(panels);
  if (hit && hit.covered === covered && hit.obstacles === obstacles &&
      hit.bedW === bed.width && hit.bedD === bed.depth) return hit.adopted;

  const fit = footprints(panels, undefined, obstacles, bed);
  const blockOwner = new Map<string, string>();
  for (const p of panels) {
    for (const c of panelCells(p.origin, p.columns, p.rows)) blockOwner.set(hexKey(c), p.id);
  }
  const adopted = new Map<string, Hex[]>();
  const seen = new Set<string>();
  for (const plate of covered) {
    const block = panelCells(plate.origin, plate.columns, plate.rows);
    const cut = obstructedCells(obstacles, block);
    for (const c of block) {
      const k = hexKey(c);
      if (!cut.has(k) || blockOwner.has(k) || seen.has(k)) continue;
      seen.add(k);
      const votes = new Map<string, { n: number; best: string }>();
      for (const d of RING) {
        const nk = hexKey({ q: c.q + d.q, r: c.r + d.r });
        const owner = blockOwner.get(nk);
        if (owner === undefined) continue;
        const v = votes.get(owner);
        if (v === undefined) votes.set(owner, { n: 1, best: nk });
        else {
          v.n++;
          if (nk < v.best) v.best = nk;
        }
      }
      // Most neighbours first, the smallest neighbouring cell breaking a tie;
      // the first that can take it without outgrowing the bed does.
      const ranked = [...votes.entries()].sort(([, a], [, b]) =>
        b.n - a.n || (a.best < b.best ? -1 : a.best > b.best ? 1 : 0));
      const winner = ranked.map(([owner]) => owner).find((owner) => fit.takeAll(owner, [c]));
      if (winner === undefined) continue;
      const list = adopted.get(winner);
      if (list) list.push(c);
      else adopted.set(winner, [c]);
    }
  }
  adoptCache.set(panels, { covered, obstacles, bedW: bed.width, bedD: bed.depth, adopted });
  return adopted;
}

/**
 * Every plate's printed footprint, and whether it can take more cut cells and
 * still fit the bed, either way round.
 *
 * A block's own hexagons to begin with — exactly `plateFootprintMm` — then,
 * for each extra cell, what of it lies outside the zones (`cellRemainderBox`),
 * not the whole hexagon: charging the hexagon refused nearly every cell a
 * shipped plate near its bed was offered, for a sliver a few millimetres deep.
 * With `covered`, the cells those plates' neighbours adopted are counted in
 * first. A border only ever cuts inside this.
 */
function footprints(
  panels: readonly PlacedPanel[],
  covered: readonly PlacedPanel[] | undefined,
  obstacles: readonly Obstacle[] | undefined,
  bed: PlateBed,
) {
  const extent = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();
  for (const p of panels) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of panelCells(p.origin, p.columns, p.rows)) {
      const m = hexToMm(c);
      minX = Math.min(minX, m.x - MARGIN_X); maxX = Math.max(maxX, m.x + MARGIN_X);
      minY = Math.min(minY, m.y - MARGIN_Y); maxY = Math.max(maxY, m.y + MARGIN_Y);
    }
    extent.set(p.id, { minX, maxX, minY, maxY });
  }
  const EPS = 1e-6;
  const fits = (w: number, h: number) =>
    (w <= bed.width + EPS && h <= bed.depth + EPS) || (w <= bed.depth + EPS && h <= bed.width + EPS);
  const grow = (owner: string, cells: readonly Hex[], commit: boolean): boolean => {
    const e = extent.get(owner);
    if (e === undefined) return false;
    let g = { ...e };
    for (const c of cells) {
      const r = cellRemainderBox(c, obstacles);
      if (r === null) continue; // nothing of it prints
      g = {
        minX: Math.min(g.minX, r.minX), maxX: Math.max(g.maxX, r.maxX),
        minY: Math.min(g.minY, r.minY), maxY: Math.max(g.maxY, r.maxY),
      };
    }
    const w0 = e.maxX - e.minX, h0 = e.maxY - e.minY;
    const w1 = g.maxX - g.minX, h1 = g.maxY - g.minY;
    // No growth at all is always fine, even for a plate already too big.
    if (!(w1 <= w0 + EPS && h1 <= h0 + EPS) && !fits(w1, h1)) return false;
    if (commit) extent.set(owner, g);
    return true;
  };
  if (covered && covered.length > 0 && obstacles && obstacles.length > 0) {
    for (const [owner, cells] of adoptedCells(panels, covered, obstacles, bed)) grow(owner, cells, true);
  }
  return {
    /** Add `cells` to `owner` if it still fits; say whether it did. */
    takeAll: (owner: string, cells: readonly Hex[]): boolean => grow(owner, cells, true),
  };
}

const adoptCache = new WeakMap<
  readonly PlacedPanel[],
  {
    covered: readonly PlacedPanel[];
    obstacles: readonly Obstacle[];
    bedW: number;
    bedD: number;
    adopted: ReadonlyMap<string, Hex[]>;
  }
>();

/**
 * Which plates are the SAME plate, by what the generator would build (D107).
 *
 * Every place that counts, draws or downloads "n of these" has to agree on what
 * "these" are, and the only honest answer is the geometry. Part, block, `omit`
 * and the edge letters are not enough once a border is on: the zone cuts a
 * plate where its edge happens to land INSIDE the plate, and the plate under a
 * zone's corner carries a sliver up the zone's side that its neighbours along
 * the same edge do not. Same omitted cells, same letters, different plate.
 *
 * With no border the plate is its cells and nothing else — the eaten cells are
 * dropped whole and there is no edge to cut — so the relative cell set IS the
 * key and nothing is generated to find it. With one, `plateGeometryKey` asks the
 * generator. Memoised on the panels, frame and zones by identity: the document
 * is immutable, so an edit that does not touch them reuses the answer.
 */
export function panelGeometryKeys(
  panels: readonly PlacedPanel[],
  frame: WallFrame | undefined,
  obstacles: readonly Obstacle[] | undefined,
  /**
   * Required, even when undefined: a plate's geometry includes the stranded
   * cells it adopts from these (D110), and a key computed without them says two
   * plates are the same when one of them is not.
   */
  covered: readonly PlacedPanel[] | undefined,
  /** Required for the same reason: it decides which stranded cells a plate takes. */
  bed: PlateBed | undefined,
): ReadonlyMap<string, string> {
  const hit = geometryKeyCache.get(panels);
  if (hit && hit.frame === frame && hit.obstacles === obstacles && hit.covered === covered &&
      hit.bedW === bed?.width && hit.bedD === bed?.depth) {
    return hit.keys;
  }
  const keys = new Map<string, string>();
  for (const p of panels) {
    const spec = panelModelSpec(p, panels, frame, obstacles, covered, bed);
    if (spec.border === undefined) {
      const rel = spec.cells
        .map((c) => hexKey({ q: c.q - p.origin.q, r: c.r - p.origin.r }))
        .sort()
        .join(' ');
      keys.set(p.id, `cells:${rel}`);
      continue;
    }
    if (isPlainPlate(spec)) {
      const rel = spec.cells
        .map((c) => hexKey({ q: c.q - p.origin.q, r: c.r - p.origin.r }))
        .sort()
        .join(' ');
      keys.set(p.id, `plain:${rel}`);
      continue;
    }
    try {
      keys.set(p.id, spec.cells.length === 0 ? 'empty' : plateGeometryKey(spec, hexToMm(p.origin)));
    } catch {
      // The generator refused it; it is drawn from the fallback and is its own
      // plate rather than a member of somebody else's group.
      keys.set(p.id, `refused:${p.id}`);
    }
  }
  geometryKeyCache.set(panels, { frame, obstacles, covered, bedW: bed?.width, bedD: bed?.depth, keys });
  return keys;
}

/**
 * A plate nothing reaches: no cut cell, no zone and no line of the wall's edge
 * within a cell of it, and no empty position beside it for the border to grow
 * into. The generator can only build such a plate from its cells, so its cells
 * ARE its key and nothing need be generated to find it.
 *
 * Most of a big wall is plates like this, and generating each one to hash it
 * was most of the cost of a zone drag frame: 0.5 s of keys on a 4 × 2.4 m wall.
 * Conservative on every count — a plate it wrongly calls plain could only ever
 * be one that is cut, and every condition below is one the cut needs — and a
 * plate it wrongly calls NOT plain merely gets the generator's key, which is
 * correct anyway.
 */
function isPlainPlate(spec: { cells: Hex[]; clipped: Hex[]; border: BorderSpec | undefined }): boolean {
  const border = spec.border;
  if (border === undefined || spec.clipped.length > 0 || spec.cells.length === 0) return false;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of spec.cells) {
    const m = hexToMm(c);
    minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x);
    minY = Math.min(minY, m.y); maxY = Math.max(maxY, m.y);
  }
  // The edge cuts outlines a cell's half-width from its line and bores a rail
  // further; a full pitch clear of every line is clear of both.
  const b = border.bounds;
  const clear = PITCH + Math.max(0, border.thicknessMm);
  const sides = border.sides;
  if ((sides.left && minX - b.minX < clear) || (sides.right && b.maxX - maxX < clear) ||
      (sides.bottom && minY - b.minY < clear) || (sides.top && b.maxY - maxY < clear)) return false;
  // A zone within two cells could cut it, or hold a fragment against it.
  const reach = 2 * PITCH;
  for (const z of border.keepClear ?? []) {
    if (!(maxX + reach <= z.minX || minX - reach >= z.maxX ||
          maxY + reach <= z.minY || minY - reach >= z.maxY)) return false;
  }
  // An empty position beside it is a hole the border would grow a piece into.
  for (const c of spec.cells) {
    for (const d of RING) {
      if (!border.occupied.has(hexKey({ q: c.q + d.q, r: c.r + d.r }))) return false;
    }
  }
  return true;
}

const geometryKeyCache = new WeakMap<
  readonly PlacedPanel[],
  {
    frame: WallFrame | undefined;
    obstacles: readonly Obstacle[] | undefined;
    covered: readonly PlacedPanel[] | undefined;
    bedW: number | undefined;
    bedD: number | undefined;
    keys: ReadonlyMap<string, string>;
  }
>();

/** `panelGeometryKeys` straight from a document. */
export function panelGeometryKeysFor(doc: LayoutDoc): ReadonlyMap<string, string> {
  return panelGeometryKeys(doc.panels, doc.frame, doc.obstacles, doc.covered, bedOfDoc(doc));
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
