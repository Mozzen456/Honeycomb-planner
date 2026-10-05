/**
 * How many fixings hold the wall up, and which cells they go in.
 *
 * This used to be a property of a PANEL: `tools/scan.py` wrote
 * `requires: insert-countersunk × (4 + cells/50)` onto every panel part, and
 * the BOM multiplied that by the number of panels placed. On a 2400 × 1200 wall
 * tiled into 64 plates that came to **370 wall screws — one every 88 mm**.
 * Nobody drills that.
 *
 * It is a property of the ASSEMBLY, not of one plate. The panels interlock
 * along a zig-zag edge and multi-cell inserts bridge the seams (HSW-SPEC §4),
 * so a tiled wall behaves as one sheet: fixings are spread across it at a
 * spacing chosen for the substrate, not counted per plate.
 *
 * Two rules, and the count is the union of both:
 *
 *  1. **A grid at `spacingMm`**, snapped to real cells. This is what carries
 *     the load and what the spacing figure means.
 *  2. **At least one fixing in every panel.** A plate with no fixing of its own
 *     hangs entirely on its neighbours' interlock; fine in the middle of a
 *     sheet, not fine at an edge, and not worth the failure mode.
 *
 * Sanity check on the default: 220 mm over a 2400 × 1200 wall gives ~66
 * fixings, and "one per panel" over the same wall gives 64. Two independent
 * rules landing in the same place is the reason to believe either. The only
 * outside figure I could find for a real HSW build — a 900 × 600 design
 * specifying 7 insert-countersunk plus 4 hexagon-countersunk-and-hole — works
 * out at 20 per m²; this lands at 23.
 *
 * It is still a stated engineering rule and not a measurement. Argue with it
 * here, in one place, rather than in a scanner that bakes it into 51 files.
 *
 * SEAMS. Where panels meet, the fixing that goes in is not a single-cell one.
 * HSW-SPEC §4: the panels carry no screw holes of their own, and "a 2-, 3- or
 * 4-cell insert dropped into cells that straddle the join is what actually
 * holds two panels together". So a junction where three or four plates meet
 * gets `insert-for-countersunk-hole-3` — a four-cell diamond taking one wall
 * screw — which fixes all of them to the wall with one fixing and stops them
 * parting company with each other. Those are planned first; the spacing grid
 * then fills in what is left.
 */

import { PITCH, ROW_STEP } from './constants';
import { hexDistance, hexKey, hexToMm, placeFootprint, placedPanelCells } from './hex';
import type { FixingEdits, Hex, LayoutDoc, PlacedPanel, Rotation } from './types';

/**
 * Which of a part's OWN cells carry the fastener it hangs on.
 *
 * Not "all of them". A seven-cell shelf hanging on two pegs takes two inserts,
 * and drawing one per cell is the seven-inserts-for-two-pegs error made into a
 * picture — it contradicts the count on the part and the line on the list.
 *
 * Nearest the anchor first, ties broken on q then r, and a multi-cell fastener
 * claims every cell it covers so the next one does not land on top of it.
 * Deterministic, because this decides where an insert is DRAWN in two different
 * views: the alignment tool, where a person seats their part against it, and the
 * wall. Two readings of it would put the insert in one cell in the dialog and
 * another on the wall, which is the class of bug that keeps costing this repo
 * days (D53).
 *
 * @param cells   the cells the part covers, in whatever frame the caller uses
 * @param anchor  the cell the part hangs off — `item.at` on the wall
 * @param spread  the fastener's own footprint, as offsets from its anchor
 * @param count   how many of it the part takes
 * @param taken   cells that already have one (a socket in the wall supplies it)
 */
export function fastenerCells(
  cells: readonly Hex[],
  anchor: Hex,
  spread: readonly Hex[],
  count: number,
  taken: ReadonlySet<string> = new Set(),
): Hex[] {
  if (count <= 0 || cells.length === 0) return [];
  const shape = spread.length > 0 ? spread : [{ q: 0, r: 0 }];
  const ordered = [...cells].sort((a, b) => (
    hexDistance(a, anchor) - hexDistance(b, anchor) || a.q - b.q || a.r - b.r
  ));
  const claimed = new Set<string>(taken);
  const out: Hex[] = [];
  for (const c of ordered) {
    if (out.length >= count) break;
    if (claimed.has(hexKey(c))) continue;
    out.push(c);
    for (const s of shape) claimed.add(hexKey({ q: c.q + s.q, r: c.r + s.r }));
  }
  return out;
}

/**
 * Default centre-to-centre spacing for wall fixings, mm.
 *
 * 220 mm sits just inside the common 400 mm timber stud spacing at every other
 * stud, and is a normal fixing pitch for a sheet material into plasterboard
 * anchors. Heavier loads or a soft substrate want it tighter.
 */
export const DEFAULT_FIXING_SPACING_MM = 220;

/** Below this the count explodes; above it the sheet is not really held. */
export const MIN_FIXING_SPACING_MM = 100;
export const MAX_FIXING_SPACING_MM = 600;

export function clampSpacing(mm: number | undefined): number {
  if (typeof mm !== 'number' || !Number.isFinite(mm)) return DEFAULT_FIXING_SPACING_MM;
  return Math.min(MAX_FIXING_SPACING_MM, Math.max(MIN_FIXING_SPACING_MM, Math.round(mm)));
}

/**
 * The four-cell countersunk insert that bridges a junction.
 *
 * Footprint copied from the catalogue's MEASURED entry rather than derived —
 * `tests/fixings.test.ts` asserts the two still agree, so a rescan that changed
 * the part cannot leave this silently wrong.
 */
export const JUNCTION_FIXING_ID = 'insert-for-countersunk-hole-3';
export const JUNCTION_FOOTPRINT: readonly Hex[] = [
  { q: 0, r: 0 }, { q: 1, r: -1 }, { q: 1, r: 0 }, { q: 2, r: -1 },
];

/**
 * The two-cell countersunk fixing, used round the OUTSIDE of the wall (D125).
 *
 * The four-cell one needs a diamond of whole cells; along the wall's outer
 * rows, where the border has cut the last ring to half cells, it often cannot
 * have one, and a two-cell part still spreads the load over two hexagons where
 * a single-cell fixing takes it on one. Footprint copied from the measured
 * catalogue entry and held to it by `tests/fixings.test.ts`, like the junction's.
 */
export const EDGE_FIXING_ID = 'hexagon-countersung-and-hole';
export const EDGE_FOOTPRINT: readonly Hex[] = [{ q: 0, r: 0 }, { q: 0, r: 1 }];

/** The footprint of a multi-cell wall fixing, by part id; undefined for any other part. */
export function multiFootprint(partId: string): readonly Hex[] | undefined {
  if (partId === JUNCTION_FIXING_ID) return JUNCTION_FOOTPRINT;
  if (partId === EDGE_FIXING_ID) return EDGE_FOOTPRINT;
  return undefined;
}

/**
 * A multi-cell wall fixing: the four-cell insert, or the two-cell one round
 * the edge. Called a junction because the four-cell part was first used only
 * where three or four plates meet; since D125 it is used wherever it fits.
 */
export interface JunctionFixing {
  /** Which fixing this is — `JUNCTION_FIXING_ID` or `EDGE_FIXING_ID`. */
  partId: string;
  cells: Hex[];
  /** The panels it ties together — one, where it sits inside a plate. */
  panelIds: string[];
  /**
   * Where and how it sits, so the 3D view can draw the real part rather than a
   * token. Without these the renderer would have to re-derive the rotation from
   * the cell set, which is the sort of second derivation that drifts.
   */
  anchor: Hex;
  rotation: Rotation;
}

export interface FixingPlan {
  /** Cells that should carry a countersunk insert and a wall screw. */
  cells: Hex[];
  /** Which panel each fixing belongs to, in the same order. */
  panelIds: string[];
  spacingMm: number;
  /** Fixings per square metre of panelled wall — the number to sanity-check. */
  perSquareMetre: number;
  /** Panels the plan could not fit a single fixing into, because accessories
   *  have taken every cell. These plates have nothing holding them up. */
  starvedPanelIds: string[];
  /** Multi-panel junctions, each bridged by a four-cell countersunk insert. */
  junctions: JunctionFixing[];
  /**
   * Cells in `cells` that a PERSON put there, keyed. The plan is otherwise
   * indistinguishable once it is built, and the views want to say which ones
   * were chosen by hand — and the store wants to know that taking one out means
   * forgetting an addition rather than recording a removal.
   */
  manual: ReadonlySet<string>;
  /**
   * How many of the planner's own choices were taken out by hand. Zero means
   * this plan is exactly what the planner would produce on its own.
   */
  removedCount: number;
  /**
   * Panels left with no fixing at all BECAUSE one was removed by hand — as
   * against `starvedPanelIds`, where the planner could not find a free cell in
   * the first place. Two different problems, said differently: one is "clear
   * some cells", the other is "you took the only one out".
   */
  unfixedPanelIds: string[];
}

/**
 * Where the wall fixings go.
 *
 * Deterministic: the same document always produces the same cells, so the
 * parts list does not shuffle between renders and a saved layout can be built
 * from the printed sheet months later.
 */
/**
 * Cells a JUNCTION may take even though something is on them.
 *
 * A part that mounts through a plain socket is not blocking the hole, it is
 * USING it — the junction fastener's three open cells are exactly the sockets it
 * pegs into. Without this, hanging a hook on one of those cells deleted the
 * whole fixing: `avoid` is checked over all four of its cells, so one occupied
 * cell dropped the placement, and the wall mount vanished from the plan and from
 * the picture (D48).
 *
 * The grid pass still avoids them. A single-cell countersunk fixing has no
 * socket to peg into and a screwdriver has to reach its head, so a part over one
 * really is in the way.
 */
export interface SharedCells {
  /** Cells occupied by parts that mount through an empty insert. */
  cells: ReadonlySet<string>;
  /**
   * Which cells of the junction fastener are its sockets, as offsets from its
   * anchor. Passed in rather than restated here: it is measured, and it lives
   * in `overrides.json` with the measurement that produced it.
   */
  junctionSockets: readonly Hex[];
}

export function planFixings(
  panels: readonly PlacedPanel[],
  spacingMm: number = DEFAULT_FIXING_SPACING_MM,
  /** Cells already taken by accessories. A fixing routes around them rather
   *  than being ordered for a hole that is not free. */
  avoid: ReadonlySet<string> = new Set(),
  shared: SharedCells = { cells: new Set(), junctionSockets: [] },
  /**
   * What a person decided instead. Applied AFTER the plan, never fed back into
   * it: the grid must not notice a gap where a fixing was removed and helpfully
   * put one back a cell away, which is what re-planning around the edits would
   * do. See `applyFixingEdits`.
   */
  edits?: FixingEdits,
): FixingPlan {
  const spacing = clampSpacing(spacingMm);
  const chosen = new Map<string, string>(); // cell key -> panel id

  // Cells of each panel, and the whole assembly's extent in millimetres.
  const byPanel: { id: string; cells: Hex[] }[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const panel of panels) {
    const cells = placedPanelCells({
      origin: panel.origin ?? { q: 0, r: 0 },
      columns: Math.max(0, Math.floor(panel.columns)),
      rows: Math.max(0, Math.floor(panel.rows)),
      omit: panel.omit,
    });
    if (cells.length === 0) continue;
    byPanel.push({ id: panel.id, cells });
    for (const c of cells) {
      const p = hexToMm(c);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (byPanel.length === 0) {
    return {
      cells: [], panelIds: [], spacingMm: spacing, perSquareMetre: 0,
      starvedPanelIds: [], junctions: [],
      manual: new Set(), removedCount: 0, unfixedPanelIds: [],
    };
  }

  // 0. Junctions first. Where three or four plates meet, one four-cell insert
  //    ties them together AND to the wall — which a single-cell fixing in each
  //    plate does not do, however many of them there are. Planned before the
  //    grid so the grid fills in around them rather than competing.
  const owner = new Map<string, string>();
  for (const { id, cells } of byPanel) {
    for (const c of cells) owner.set(hexKey(c), id);
  }
  const junctions: JunctionFixing[] = [];
  const usedByJunction = new Set<string>();

  /*
   * FOUR plates first, then three.
   *
   * This used to take the first placement covering three or more and stop, which
   * meant it settled for a three-plate tie whenever one turned up first — even
   * with a four-plate placement a single cell away. At a corner where four
   * plates meet that is the wrong insert in the wrong hole: the fourth plate is
   * left held only by the grid, and the one joint that most needs tying is the
   * one that gets least.
   *
   * So it runs twice, taking every four-plate junction before considering any
   * three-plate one. Still greedy within a pass — an exact cover is a set-packing
   * problem and not worth it here — but greedy on the right thing.
   */
  /*
   * Only a cell within two steps of ANOTHER plate's cell can anchor a fixing
   * that spans three plates — the footprint reaches two cells from its anchor —
   * so the search starts from those and not from every cell on the wall. Same
   * anchors in the same order, so the same answer; most of a plate is interior.
   */
  // The same ownership keyed by NUMBER for the hot loops below: a string key
  // per lookup was most of this pass's time on a big wall.
  const num = (q: number, r: number): number => q * 20_000_003 + r;
  const ownerAt = new Map<number, string>();
  for (const { id, cells } of byPanel) for (const c of cells) ownerAt.set(num(c.q, c.r), id);
  const nearSeam = (id: string, c: Hex): boolean => {
    for (let dq = -2; dq <= 2; dq++) {
      for (let dr = Math.max(-2, -dq - 2); dr <= Math.min(2, -dq + 2); dr++) {
        const other = ownerAt.get(num(c.q + dq, c.r + dr));
        if (other !== undefined && other !== id) return true;
      }
    }
    return false;
  };
  const seamAnchors = byPanel.map(({ id, cells }) => cells.filter((c) => nearSeam(id, c)));

  /*
   * Every placement that spans three or more plates, worked out ONCE, in the
   * order the passes below visit them — anchor by anchor, turn by turn. The two
   * passes used to rebuild every placement each, and nearly all of them span
   * one or two plates and are no use to either.
   */
  interface Candidate { anchor: Hex; rot: Rotation; placed: Hex[]; keys: string[]; spans: number }
  const candidates: Candidate[][] = [];
  // The six turns of the footprint, rotated once — `placeFootprint` per
  // placement re-rotated the same four cells a hundred thousand times.
  const turned = [0, 1, 2, 3, 4, 5].map((rot) => placeFootprint(JUNCTION_FOOTPRINT, { q: 0, r: 0 }, rot as Rotation));
  for (const cells of seamAnchors) {
    for (const anchor of cells) {
      const mine: Candidate[] = [];
      for (let rot = 0; rot < 6; rot++) {
        const shape = turned[rot]!;
        const spans = new Set<string>();
        let onPlates = true;
        for (const c of shape) {
          const o = ownerAt.get(num(c.q + anchor.q, c.r + anchor.r));
          if (o === undefined) { onPlates = false; break; }
          spans.add(o);
        }
        if (!onPlates || spans.size < 3) continue;
        const placed = shape.map((c) => ({ q: c.q + anchor.q, r: c.r + anchor.r }));
        mine.push({ anchor, rot: rot as Rotation, placed, keys: placed.map(hexKey), spans: spans.size });
      }
      if (mine.length > 0) candidates.push(mine);
    }
  }

  for (const want of [4, 3]) {
    for (const mine of candidates) {
      for (const { anchor, rot, placed, keys, spans } of mine) {
        // Two plates is an ordinary seam, which the interlocking edge already
        // handles; this pass wants exactly `want`.
        if (spans !== want) continue;
        /*
         * Every cell must be on a panel, free, and not already spoken for —
         * where "free" means free of anything that is not plugged INTO this
         * fixing. A part mounting through a plain socket may sit on one of the
         * three socket cells; the fourth takes the wall screw, and a part over
         * THAT is in the way of a screwdriver whatever it mounts with.
         */
        if (keys.some((k) => usedByJunction.has(k))) continue;
        if (avoid.size > 0) {
          const socketKeys = new Set(
            placeFootprint(shared.junctionSockets, anchor, rot).map(hexKey),
          );
          const blocked = (k: string): boolean =>
            avoid.has(k) && !(shared.cells.has(k) && socketKeys.has(k));
          if (keys.some(blocked)) continue;
        }
        junctions.push({
          partId: JUNCTION_FIXING_ID,
          cells: placed,
          panelIds: [...new Set(keys.map((k) => owner.get(k)!))].sort(),
          anchor,
          rotation: rot,
        });
        for (const k of keys) {
          usedByJunction.add(k);
          chosen.set(k, owner.get(k)!);
        }
        break; // one per anchor per pass, as before
      }
    }
  }

  // Every cell, indexed by position, so a grid point can find the nearest one.
  const all: { cell: Hex; x: number; y: number; panelId: string }[] = [];
  for (const { id, cells } of byPanel) {
    for (const c of cells) {
      if (avoid.has(hexKey(c)) || usedByJunction.has(hexKey(c))) continue;
      const p = hexToMm(c);
      all.push({ cell: c, x: p.x, y: p.y, panelId: id });
    }
  }

  /*
   * The cells bucketed by position, so finding the ones near a grid point
   * looks at a few buckets instead of every cell on the wall. Without it the
   * plan is (grid points × cells): ~8 000 × 800 000 on a 20 m wall of small
   * plates, which is minutes, and the parts list replans on every edit.
   */
  const bucketMm = spacing / 2;
  const buckets = new Map<string, (typeof all)[number][]>();
  for (const a of all) {
    const k = `${Math.floor(a.x / bucketMm)},${Math.floor(a.y / bucketMm)}`;
    const list = buckets.get(k);
    if (list) list.push(a);
    else buckets.set(k, [a]);
  }
  const within = (gx: number, gy: number, radius: number): (typeof all)[number][] => {
    const out: (typeof all)[number][] = [];
    const span = Math.ceil(radius / bucketMm);
    const bx = Math.floor(gx / bucketMm), by = Math.floor(gy / bucketMm);
    for (let i = -span; i <= span; i++) {
      for (let j = -span; j <= span; j++) {
        const list = buckets.get(`${bx + i},${by + j}`);
        if (list) for (const a of list) out.push(a);
      }
    }
    return out;
  };

  /**
   * The placement of `footprint` nearest a grid point, on free cells.
   *
   * Every cell must be on a plate, free and not already spoken for — the same
   * rules as the seam pass, sockets included. Searched from the cells nearest
   * the point outwards, and scored by where the PART's middle lands, so the
   * fixing sits on the grid rather than merely touching it.
   */
  const placeNear = (
    footprint: readonly Hex[],
    sockets: readonly Hex[],
    partId: string,
    gx: number,
    gy: number,
  ): JunctionFixing | null => {
    const reach = (spacing * 0.5) ** 2;
    const near = within(gx, gy, spacing * 0.5)
      .map((a) => ({ a, d: (a.x - gx) ** 2 + (a.y - gy) ** 2 }))
      .filter(({ a, d }) => d <= reach && !chosen.has(hexKey(a.cell)))
      .sort((u, v) => u.d - v.d || u.a.cell.q - v.a.cell.q || u.a.cell.r - v.a.cell.r)
      .slice(0, 24);
    let best: JunctionFixing | null = null;
    let bestD = Infinity;
    for (const { a } of near) {
      for (let rot = 0; rot < 6; rot++) {
        const placed = placeFootprint(footprint, a.cell, rot as Rotation);
        const keys = placed.map(hexKey);
        const socketKeys = new Set(placeFootprint(sockets, a.cell, rot as Rotation).map(hexKey));
        const blocked = (k: string): boolean =>
          avoid.has(k) && !(shared.cells.has(k) && socketKeys.has(k));
        if (keys.some((k) => !owner.has(k) || blocked(k) || usedByJunction.has(k) || chosen.has(k))) {
          continue;
        }
        let cx = 0, cy = 0;
        for (const c of placed) {
          const p = hexToMm(c);
          cx += p.x;
          cy += p.y;
        }
        const d = (cx / placed.length - gx) ** 2 + (cy / placed.length - gy) ** 2;
        if (d < bestD - 1e-9) {
          bestD = d;
          best = {
            partId,
            cells: placed,
            panelIds: [...new Set(keys.map((k) => owner.get(k)!))].sort(),
            anchor: a.cell,
            rotation: rot as Rotation,
          };
        }
      }
    }
    return best;
  };

  // Only the SEAM junctions stand in for grid points. A fixing the grid itself
  // placed as a multi-cell part (D125) must not, or on a small wall the next
  // grid point is "covered" by its neighbour and the plate loses a fixing.
  const seamJunctions = junctions.slice();
  // ...bucketed like the cells below, for the same reason.
  const seamAt = new Map<string, { x: number; y: number }[]>();
  for (const j of seamJunctions) {
    for (const c of j.cells) {
      const p = hexToMm(c);
      const k = `${Math.floor(p.x / (spacing / 2))},${Math.floor(p.y / (spacing / 2))}`;
      const list = seamAt.get(k);
      if (list) list.push(p);
      else seamAt.set(k, [p]);
    }
  }

  // 1. The grid. Half a spacing in from each edge, so fixings sit inside the
  //    sheet rather than on its corners where the plate is weakest.
  const cols = Math.max(1, Math.round((maxX - minX) / spacing));
  const rows = Math.max(1, Math.round((maxY - minY) / spacing));
  for (let i = 0; i <= cols; i++) {
    for (let j = 0; j <= rows; j++) {
      const gx = minX + ((maxX - minX) * i) / cols;
      const gy = minY + ((maxY - minY) * j) / rows;
      // A junction already fixes the sheet here. It counts TOWARDS the spacing
      // rather than being extra: planning both independently put 56 junction
      // inserts on top of 74 single ones and asked for 128 holes in a wall that
      // needs about 70.
      let covered = false;
      const cover = spacing * 0.7;
      const span = Math.ceil(cover / bucketMm);
      const bx = Math.floor(gx / bucketMm), by = Math.floor(gy / bucketMm);
      for (let di = -span; di <= span && !covered; di++) {
        for (let dj = -span; dj <= span && !covered; dj++) {
          for (const p2 of seamAt.get(`${bx + di},${by + dj}`) ?? []) {
            if ((p2.x - gx) ** 2 + (p2.y - gy) ** 2 < cover ** 2) { covered = true; break; }
          }
        }
      }
      if (covered) continue;
      /*
       * A multi-cell fixing where one fits (D125): the four-cell insert inside
       * the wall, the two-cell one along its outside rows, where the four-cell
       * diamond so often has no room. Either holds the sheet over more than one
       * hexagon, and the four-cell one leaves three sockets to hang things on.
       * A single cell only where neither fits.
       */
      const onEdge = i === 0 || i === cols || j === 0 || j === rows;
      const multi = onEdge
        ? placeNear(EDGE_FOOTPRINT, [], EDGE_FIXING_ID, gx, gy)
        : placeNear(JUNCTION_FOOTPRINT, shared.junctionSockets, JUNCTION_FIXING_ID, gx, gy)
          ?? placeNear(EDGE_FOOTPRINT, [], EDGE_FIXING_ID, gx, gy);
      if (multi !== null) {
        junctions.push(multi);
        for (const c of multi.cells) {
          const k = hexKey(c);
          usedByJunction.add(k);
          chosen.set(k, owner.get(k)!);
        }
        continue;
      }
      let best: (typeof all)[number] | null = null;
      let bestD = Infinity;
      for (const candidate of within(gx, gy, spacing)) {
        if (chosen.has(hexKey(candidate.cell))) continue;
        const d = (candidate.x - gx) ** 2 + (candidate.y - gy) ** 2;
        if (d < bestD) {
          bestD = d;
          best = candidate;
        }
      }
      // Only if a cell is actually near the grid point: a grid point over a gap
      // in an L-shaped wall must not drag a fixing across the room to reach it.
      if (best !== null && bestD <= spacing * spacing) {
        chosen.set(hexKey(best.cell), best.panelId);
      }
    }
  }

  // 2. Every panel gets at least one, taken nearest its own centre. A panel
  //    held by a junction insert already has one.
  const covered = new Set(chosen.values());
  for (const j of junctions) for (const id of j.panelIds) covered.add(id);
  const starved: string[] = [];
  for (const { id, cells } of byPanel) {
    if (covered.has(id)) continue;
    let cx = 0;
    let cy = 0;
    for (const c of cells) {
      const p = hexToMm(c);
      cx += p.x;
      cy += p.y;
    }
    cx /= cells.length;
    cy /= cells.length;
    let best: Hex | null = null;
    let bestD = Infinity;
    for (const c of cells) {
      if (chosen.has(hexKey(c)) || avoid.has(hexKey(c)) || usedByJunction.has(hexKey(c))) continue;
      const p = hexToMm(c);
      const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    // Every cell taken by an accessory: this plate has nothing holding it up,
    // and that is worth saying rather than quietly ordering a fixing anyway.
    if (best === null) starved.push(id);
    else chosen.set(hexKey(best), id);
  }

  // Deterministic order: reading order down the wall. Junction cells are held
  // in `chosen` so nothing else claims them, but they are NOT single-cell
  // fixings and must not be ordered as such.
  const entries = [...chosen.entries()]
    .filter(([key]) => !usedByJunction.has(key))
    .map(([key, panelId]) => {
    const comma = key.indexOf(',');
      return { cell: { q: Number(key.slice(0, comma)), r: Number(key.slice(comma + 1)) }, panelId };
    });
  entries.sort((a, b) => a.cell.r - b.cell.r || a.cell.q - b.cell.q);

  const areaM2 = totalPanelAreaM2(byPanel.reduce((n, p) => n + p.cells.length, 0));
  const planned: FixingPlan = {
    cells: entries.map((e) => e.cell),
    panelIds: entries.map((e) => e.panelId),
    spacingMm: spacing,
    perSquareMetre: areaM2 > 0 ? (entries.length + junctions.length) / areaM2 : 0,
    starvedPanelIds: starved.sort(),
    junctions,
    manual: new Set(),
    removedCount: 0,
    unfixedPanelIds: [],
  };
  return applyFixingEdits(planned, edits, owner, areaM2);
}

/**
 * The plan as a person left it: their removals taken out, their own positions
 * put in.
 *
 * Separate from the planning above, and applied to its OUTPUT, because the two
 * answer different questions. The planner says where fixings belong on a sheet
 * of this shape; this says where somebody decided otherwise. Feeding the edits
 * back into the planner instead would let the grid notice the hole a removal
 * left and fill it from a cell away — the fixing you just deleted, moved 24 mm.
 *
 * A removal is matched by CELL for a single fixing and by ANCHOR for a junction:
 * the anchor is what the view has to name to point at one, and it is stable
 * across the rotation search. Nothing here re-plans, so the result stays a pure
 * function of (panels, spacing, avoid, edits).
 */
function applyFixingEdits(
  plan: FixingPlan,
  edits: FixingEdits | undefined,
  owner: ReadonlyMap<string, string>,
  areaM2: number,
): FixingPlan {
  const removed = new Set((edits?.removed ?? []).map(hexKey));
  const added = edits?.added ?? [];
  const placedByHand = edits?.placed ?? [];
  if (removed.size === 0 && added.length === 0 && placedByHand.length === 0) return plan;

  const cells: Hex[] = [];
  const panelIds: string[] = [];
  let removedCount = 0;
  for (const [i, cell] of plan.cells.entries()) {
    if (removed.has(hexKey(cell))) { removedCount += 1; continue; }
    cells.push(cell);
    panelIds.push(plan.panelIds[i] ?? '');
  }
  const junctions = plan.junctions.filter((j) => {
    const gone = removed.has(hexKey(j.anchor));
    if (gone) removedCount += 1;
    return !gone;
  });

  /*
   * A hand-placed fixing has to land on a plate and in a hole nothing else is
   * already fixed through. It does NOT have to avoid an accessory: overlap is
   * allowed everywhere else in this app (see `isExclusive` in store.ts), the
   * planner only keeps clear of accessories because it is guessing, and a person
   * pointing at a cell is not guessing. What it cannot share is a hole another
   * fixing is already in.
   */
  const taken = new Set(cells.map(hexKey));
  for (const j of junctions) for (const c of j.cells) taken.add(hexKey(c));
  const manual = new Set<string>();
  for (const cell of added) {
    const key = hexKey(cell);
    const panelId = owner.get(key);
    if (panelId === undefined || taken.has(key)) continue;
    taken.add(key);
    manual.add(key);
    cells.push({ q: cell.q, r: cell.r });
    panelIds.push(panelId);
  }

  // Multi-cell fixings a person moved (D125): the same part at the place they
  // dropped it, on the same rules — on a plate, and in no hole already fixed.
  for (const f of placedByHand) {
    const footprint = multiFootprint(f.partId);
    if (footprint === undefined) continue;
    const placed = placeFootprint(footprint, f.at, f.rotation);
    const keys = placed.map(hexKey);
    if (keys.some((k) => !owner.has(k) || taken.has(k))) continue;
    for (const k of keys) taken.add(k);
    manual.add(hexKey(f.at));
    junctions.push({
      partId: f.partId,
      cells: placed,
      panelIds: [...new Set(keys.map((k) => owner.get(k)!))].sort(),
      anchor: { q: f.at.q, r: f.at.r },
      rotation: f.rotation,
    });
  }

  // Reading order down the wall, exactly as the planner leaves it, so a
  // hand-placed fixing does not sit at the end of the parts list's own order.
  const order = cells
    .map((cell, i) => ({ cell, panelId: panelIds[i] ?? '' }))
    .sort((a, b) => a.cell.r - b.cell.r || a.cell.q - b.cell.q);

  // Plates left holding nothing. Only counted where the planner HAD given the
  // plate a fixing and a person took it away — a plate the planner could not fit
  // one into is already in `starvedPanelIds`, and saying both about the same
  // plate would put two warnings on the list for one problem.
  const held = new Set(order.map((e) => e.panelId));
  for (const j of junctions) for (const id of j.panelIds) held.add(id);
  const hadOne = new Set(plan.panelIds);
  for (const j of plan.junctions) for (const id of j.panelIds) hadOne.add(id);
  const unfixed = [...hadOne].filter((id) => id.length > 0 && !held.has(id)).sort();

  const total = order.length + junctions.length;
  return {
    cells: order.map((e) => e.cell),
    panelIds: order.map((e) => e.panelId),
    spacingMm: plan.spacingMm,
    perSquareMetre: areaM2 > 0 ? total / areaM2 : 0,
    starvedPanelIds: plan.starvedPanelIds,
    junctions,
    manual,
    removedCount,
    unfixedPanelIds: unfixed.filter((id) => !plan.starvedPanelIds.includes(id)),
  };
}

/**
 * Panelled area in m², from the cell count.
 *
 * One cell tiles PITCH × ROW_STEP of wall — the lattice's fundamental domain,
 * not the hexagon's own area, because the cells tessellate.
 */
export function totalPanelAreaM2(cellCount: number): number {
  return (cellCount * PITCH * ROW_STEP) / 1e6;
}

/** Convenience: the fixing plan for a whole document. */
export const fixingsFor = (
  doc: LayoutDoc,
  spacingMm?: number,
  avoid?: ReadonlySet<string>,
  shared?: SharedCells,
): FixingPlan =>
  planFixings(
    doc?.panels ?? [],
    spacingMm ?? DEFAULT_FIXING_SPACING_MM,
    avoid,
    shared,
    doc?.fixingEdits,
  );
