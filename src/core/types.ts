/**
 * The document model. This file is the contract every other module builds against.
 *
 * Two rules that the whole app depends on:
 *   1. Position is ALWAYS axial hex coordinates. Pixels exist only inside the
 *      renderer and the pointer handlers, and never enter the document.
 *   2. The document is immutable. Every mutation returns a new document, which
 *      is what makes undo/redo a list rather than a reconstruction problem.
 */

/**
 * Axial hex coordinate, pointy-top. `q` runs along a row, `r` down the rows.
 * World position: x = PITCH·(q + r/2), y = ROW_STEP·r.
 */
export interface Hex {
  q: number;
  r: number;
}

/** Rotation in 60° steps, 0–5. Hexagons have six-fold symmetry; nothing else is legal. */
export type Rotation = 0 | 1 | 2 | 3 | 4 | 5;

// ---------------------------------------------------------------------------
// Catalogue — produced by tools/scan.py, consumed read-only by the app.
// ---------------------------------------------------------------------------

export type PartType = 'panel' | 'insert' | 'fastener' | 'accessory' | 'unknown';

/** How confident the scanner is about a classification, and why. */
export interface Provenance {
  /** 'geometry' | 'filename' | 'both' | 'conflict' */
  basis: 'geometry' | 'filename' | 'both' | 'conflict';
  confidence: number;
  notes: string[];
}

export interface PrintEstimate {
  minutes: number;
  grams: number;
  metres: number;
  /** Slicer profile id these numbers came from. Never mix profiles silently. */
  profile: string;
  supports: boolean;
  /** 'sliced' from a real headless slice; 'volume' from mesh volume × density. */
  source: 'sliced' | 'volume';
}

export interface InsertRequirement {
  /** Catalogue id of the required insert/fastener part. */
  partId: string;
  count: number;
}

export interface CatalogPart {
  id: string;
  name: string;
  /** Path relative to repo root, e.g. "models/shelves/shelf-1.stl". */
  file: string;
  type: PartType;
  /** Folder the STL came from — the author's own grouping. */
  group: string;

  /**
   * Cells this part occupies, as offsets from its anchor. Always includes {q:0,r:0}.
   * A part that clips to a single cell is [{q:0,r:0}].
   */
  footprint: Hex[];
  /** Which cell of the footprint sits under the cursor while dragging. */
  anchor: Hex;
  /** Orientation the STL is drawn in; 'flat' files need a 90° spin to fit the wall. */
  drawnOrientation: 'pointy' | 'flat' | 'n/a';

  bboxMm: [number, number, number];
  volumeMm3: number;

  /** Printed hardware this part needs in order to mount. */
  requires: InsertRequirement[];
  /** Bought hardware — screws, plugs. Free text keys, aggregated by the BOM. */
  hardware: { item: string; count: number }[];

  print: PrintEstimate;

  /** Panels only. */
  panel?: {
    columns: number;
    rows: number;
    widthMm: number;
    heightMm: number;
    /** Bed ids this fits on, given it may need a 90° rotation to suit the wall. */
    fitsBeds: string[];
  };

  provenance: Provenance;
  /** Content hash of the STL — lets the scanner detect a changed file. */
  sha256: string;
}

export interface Catalog {
  /** Bumped when the schema changes, so an old catalogue is rejected loudly. */
  schemaVersion: number;
  generatedAt: string;
  slicerProfile: string;
  parts: CatalogPart[];
  /** Parts the scanner could not confidently classify. Never invented. */
  unresolved: { file: string; reason: string; bboxMm: number[] }[];
}

// ---------------------------------------------------------------------------
// Layout document
// ---------------------------------------------------------------------------

export interface PlacedPanel {
  id: string;
  /** Catalogue part id of the panel. */
  partId: string;
  /** Lattice position of the panel's lowest-left cell. */
  origin: Hex;
  columns: number;
  rows: number;
  /**
   * Cells cut OUT of the block, in absolute lattice coordinates.
   *
   * A stock panel has none. A panel with `omit` is a CUSTOM panel: the same
   * block with holes left out so it can go round a light switch, a socket or a
   * pipe. It is not one of the seven shipped STLs any more, so it has to be
   * generated — `src/core/customiser.ts` turns it into parameters for the
   * OpenSCAD honeycomb customiser, which works on this exact lattice.
   */
  omit?: Hex[];
}

/**
 * Something on the wall the honeycomb has to avoid.
 *
 * Rectangular in wall millimetres because that is how you measure one with a
 * tape: a light switch is 86 × 86, a double socket 146 × 86. The planner turns
 * that into cells and cuts them out of whichever panels they land in.
 */
/** One rectangle of a zone, in wall millimetres. Lower-left corner and size. */
export interface ZoneRect {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

export interface Obstacle {
  id: string;
  label: string;
  /**
   * Lower-left corner and size, in the same wall millimetres as `WallSpec`.
   *
   * When `shape` is present these are its BOUNDING BOX and nothing more — the
   * tag on the plan reads them, and moving the zone moves them together with
   * the parts. The blocked area itself is always `obstacleRects`.
   */
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  /** Extra gap to leave all round — for a switch plate's bevel, or fingers. */
  clearanceMm: number;
  /**
   * A zone made of more than one rectangle — an L round a consumer unit, a run
   * of pipe with a spur off it.
   *
   * A UNION OF RECTANGLES rather than a polygon, and that is a geometry
   * decision, not a UI one: the border generator clips convex pieces with
   * half-planes and has no polygon boolean anywhere by design (D59). A
   * rectangle gives four half-planes directly; an arbitrary polygon would have
   * to be decomposed before it could be clipped against, and a concave one
   * cannot be clipped against at all in one piece.
   *
   * Absent means the zone is just the rectangle above, which is what every zone
   * drawn before this existed is — and what it must still serialise as.
   */
  shape?: ZoneRect[];
}

export interface PlacedItem {
  id: string;
  partId: string;
  /** Cell the anchor sits in. */
  at: Hex;
  rotation: Rotation;
  groupId?: string;
}

export interface Group {
  id: string;
  label?: string;
}

export interface WallSpec {
  widthMm: number;
  heightMm: number;
}

/**
 * A straight, closed edge round the honeycomb — the frame the community's builds
 * have, and something no shipped plate can give you.
 *
 * Per side, because a wall that runs into a ceiling wants an edge on three sides
 * and not the fourth. The edge is ADDITIVE — the walls between cells run out to
 * a straight line and the notches behind it fill solid — so it costs no cells
 * and every hexagon stays whole and mountable. It applies to the OUTSIDE of the
 * assembly only: a seam between two plates is not an outside, so plates still
 * interlock. Any panel carrying an edge is a CUSTOM panel and has to be
 * generated, never printed from a shipped STL.
 */
export interface WallFrame {
  left: boolean;
  right: boolean;
  bottom: boolean;
  top: boolean;
  /** An edge round the holes too — a blocked zone, or a step in the outline. */
  holes: boolean;
  /**
   * How far the edge reaches past the outermost cell, in millimetres.
   *
   * A free number rather than the customiser's single/double switch, because
   * this border is ADDITIVE — it adds material outside the honeycomb instead of
   * cutting cells in half — so any thickness is a legal plate and 3.6 is only
   * the default because it is what the reference photograph measures.
   */
  thicknessMm: number;
}

export interface LayoutDoc {
  schemaVersion: number;
  id: string;
  name: string;
  wall: WallSpec;
  bedId: string;
  panels: PlacedPanel[];
  items: PlacedItem[];
  groups: Group[];
  /** Switches, sockets and pipes the wall has to go round. */
  obstacles?: Obstacle[];
  /** Which outer edges carry a frame. Absent means none, which is the default. */
  frame?: WallFrame;
  /**
   * The parts shopped for this wall, in the order they were chosen — what the
   * rail shows. Absent means none have been chosen yet, which is not the same
   * as none being USED: a placed part counts whether it is listed or not. See
   * `projectParts.ts`, which is the only module that reads this field.
   */
  library?: string[];
}

// ---------------------------------------------------------------------------
// Derived results — pure functions produce these, nothing stores them.
// ---------------------------------------------------------------------------

export type IssueLevel = 'error' | 'warning';

export interface Issue {
  level: IssueLevel;
  code:
    | 'overlap'
    | 'off-panel'
    | 'crosses-seam'
    | 'no-panel'
    | 'unknown-part'
    | 'panel-overlap'
    /** Accessories have taken the cells the panel's own wall mounts need. */
    | 'no-room-for-mounts';
  message: string;
  itemIds: string[];
  cells?: Hex[];
}

export interface BomLine {
  partId: string;
  name: string;
  file: string;
  type: PartType;
  quantity: number;
  /** LINE TOTALS: the per-unit estimate already multiplied by `quantity`. */
  minutes: number;
  grams: number;
  metres: number;
  /**
   * Per-unit figures, straight from the catalogue.
   *
   * Present because an exporter that computes them as `total / quantity` is
   * dividing an already-rounded number: 54.63 minutes each × 6 rounds to 328,
   * and 328 / 6 prints as 54.6. The sheet you carry to the printer then
   * disagrees with the catalogue in its last digit for no reason a reader can
   * see.
   */
  minutesEach: number;
  gramsEach: number;
  metresEach: number;
  supports: boolean;
  /**
   * This part's cell footprint is a bound from its bounding box, not a measured
   * fit. Shown as "est." on screen, and now in every export as well — the
   * printed sheet is the copy that actually gets used.
   */
  needsReview: boolean;
  /** The print figures are modelled rather than sliced (an imported part). */
  estimated: boolean;
  /**
   * How many fixings this part takes could not be measured, so whatever is
   * ordered for it is a guess. Ten shipped accessories used to order NOTHING
   * and hang on the wall by magic; the ones that still cannot be counted say so
   * instead.
   */
  fastenersUnknown: boolean;
  /**
   * How many of this insert the WALL already provides, and so are not printed.
   *
   * The combined wall fastener is one screw hole and three open sockets, and a
   * socket is an insert: an accessory hung on one does not need another printed
   * for it. The quantity above is what to print; this is why it is not more.
   */
  providedBySockets: number;
}

export interface WallFixings {
  /** How many countersunk inserts + wall screws hold the whole assembly up. */
  count: number;
  /**
   * How many of those are four-cell inserts bridging a junction where three or
   * four plates meet. They hold the panels to each other as well as to the
   * wall, which is what the single-cell ones cannot do (HSW-SPEC §4).
   */
  junctions: number;
  spacingMm: number;
  perSquareMetre: number;
  /** Panels with no free cell left for a fixing. */
  starvedPanelIds: string[];
}

export interface Bom {
  printed: BomLine[];
  /** Inserts and fasteners, aggregated separately from the things they mount. */
  fasteners: BomLine[];
  /** Bought, not printed. */
  shopping: { item: string; count: number }[];
  totals: {
    parts: number;
    minutes: number;
    grams: number;
    metres: number;
    distinctParts: number;
  };
  /**
   * The wall fixings, as a whole-assembly figure rather than a per-panel one.
   * Present so the sheet can state the spacing it assumed — the number a
   * builder needs to sanity-check against their own wall.
   */
  fixings: WallFixings;
  issues: Issue[];
}
