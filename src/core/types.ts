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
 * What colour to print things in.
 *
 * Four levels, most specific first: one placed item, everything on a parts-list
 * line, then the two defaults — one for the plates, one for everything that
 * clips into them. `colorOfItem` and `colorOfPanel` are the only readers, so
 * the order lives in one place rather than in each view.
 *
 * These are the USER'S colours and are document data, not design tokens: the
 * rule that `tokens.css` owns every colour governs the app's own chrome, and a
 * filament choice is a fact about this build. Absent at every level means "as
 * the theme draws it", which is what an untouched layout has always looked like.
 *
 * Stored as `#rrggbb`, validated on the way in — a stored document is user input
 * by the time it comes back, and an arbitrary string here reaches a canvas
 * `fillStyle` and a `THREE.Color`.
 */
export interface WallColors {
  /** Every plate, unless a line says otherwise. */
  panels?: string;
  /** Every accessory, insert and fastener, unless a line or an item does. */
  parts?: string;
  /**
   * By parts-list LINE — a catalogue part id, or `custom/<shape>|<frame>` for a
   * generated plate. Keyed that way because the list is where you choose it, and
   * because a line is exactly the set of things that get printed together.
   */
  lines?: Record<string, string>;
  /** One placed item, by item id: this hook, not every hook. */
  items?: Record<string, string>;
}

/**
 * Where a person overruled the wall-fixing plan.
 *
 * `removed` names positions the planner chose and the user took out: a cell for
 * a single countersunk fixing, or a junction fastener's ANCHOR for the four-cell
 * one. `added` names cells the user put a fixing in. A move is a removal and an
 * addition, committed together.
 *
 * Removing something the plan no longer proposes is harmless and is KEPT: the
 * plan moves when the wall is re-solved, and a cell that comes back should come
 * back removed. The same reasoning as a printed count outliving its line.
 */
export interface FixingEdits {
  removed?: Hex[];
  added?: Hex[];
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

/**
 * A photograph of the real wall, laid under (or over) the plan to line the
 * blocked zones up against what is actually there.
 *
 * A light switch is not at "about 1200 up" — it is where it is, and the way you
 * find out is to stand in front of the wall with a camera. So the picture is
 * brought in and SCALED against a length the user measured with a tape: two
 * points on the photo, one number, and every pixel is then worth a known number
 * of millimetres. From there a zone can be dragged onto the thing it is meant
 * to represent instead of onto a coordinate somebody wrote down.
 *
 * **The METADATA is on the document; the IMAGE is not.** Everything here is a
 * few dozen bytes and belongs with the layout — it undoes, it saves, it travels
 * down a share link. The pixels are megabytes and live in IndexedDB under `id`,
 * exactly as an imported part's STL does. A layout opened on another machine
 * therefore arrives with the alignment intact and no picture, which is a state
 * the app has to be able to say out loud rather than one it should pretend
 * cannot happen.
 */
export interface WallPhoto {
  /** Key for the stored image bytes, and nothing else. */
  id: string;
  /** The file it came from, so a missing image can be asked for by name. */
  name: string;
  /** Natural size of the STORED image, which is the downscaled one. */
  pixelWidth: number;
  pixelHeight: number;
  /**
   * Wall millimetres per image pixel — the whole point of the calibration.
   *
   * Set by fitting the photo across the wall to begin with, so it is visible
   * and draggable straight away, and replaced by a real measurement as soon as
   * two points and a distance are given.
   */
  mmPerPixel: number;
  /**
   * Has that measurement actually been taken?
   *
   * A fitted photo and a measured one are the same field with very different
   * standing, and presenting the first as the second is the same dishonesty
   * `needsReview` exists to prevent in the catalogue.
   */
  calibrated: boolean;
  /**
   * Lower-left corner of the UNROTATED rectangle, in wall millimetres — the same
   * frame an `Obstacle` uses.
   *
   * Unrotated on purpose: this and `mmPerPixel` describe the photo in its own
   * frame, and `rotationDeg` turns that frame about its centre. Storing a
   * rotated corner instead would make every read of this field ask "rotated by
   * what?", and the calibration — which scales about a point the user clicked —
   * would have to un-rotate before it could scale.
   */
  xMm: number;
  yMm: number;
  /**
   * Turn about the photo's own centre, in degrees, counter-clockwise as the wall
   * is seen from the room. Absent means square, which is what a photo dropped
   * straight off a phone claims to be and rarely is.
   *
   * About the CENTRE and not a corner: a photograph is straightened by eye
   * against features near the middle of it, and turning about a corner swings
   * the whole picture out from under the pointer.
   */
  rotationDeg?: number;
  /** 0–1. Drawn over the wall in both views at exactly this. */
  opacity: number;
  /**
   * In front of the honeycomb or behind it.
   *
   * Behind, the photo shows THROUGH the cells and the plate reads as a mask
   * over the room — which is what you want while placing zones. In front it
   * covers the plate, for checking a plan against the wall it was drawn from.
   */
  depth: 'front' | 'behind';
  /** Off without losing the alignment — the state you toggle constantly. */
  visible: boolean;
}

export interface LayoutDoc {
  schemaVersion: number;
  id: string;
  name: string;
  wall: WallSpec;
  bedId: string;
  /**
   * The build plate, when `bedId` is `custom`. Absent for a preset printer.
   *
   * On the document rather than beside "Fit to printer" in the shell, because it
   * is a property of the wall that was PLANNED: a saved layout's plates were cut
   * to this bed, so a reload that forgot it would show plates it could no longer
   * explain. Resolve it through `bedFor` and nowhere else.
   */
  customBed?: { widthMm: number; depthMm: number };
  panels: PlacedPanel[];
  items: PlacedItem[];
  groups: Group[];
  /** Switches, sockets and pipes the wall has to go round. */
  obstacles?: Obstacle[];
  /** A photograph of the real wall, scaled and positioned. Absent means none. */
  photo?: WallPhoto;
  /** Which outer edges carry a frame. Absent means none, which is the default. */
  frame?: WallFrame;
  /**
   * The parts shopped for this wall, in the order they were chosen — what the
   * rail shows. Absent means none have been chosen yet, which is not the same
   * as none being USED: a placed part counts whether it is listed or not. See
   * `projectParts.ts`, which is the only module that reads this field.
   */
  library?: string[];
  /**
   * Changes made BY HAND to the wall fixings the planner works out.
   *
   * The fixings stay derived — `planFixings` still spreads them across the
   * assembly at a spacing, which is the whole point of D48 — and this records
   * only where a person disagreed: positions taken out, and positions put in.
   * A fixing dragged from one cell to another is one of each.
   *
   * Kept as edits rather than as a materialised list because the plan has to
   * keep answering to the wall: resize it, cut it round a switch, re-solve it,
   * and the untouched fixings follow, while the three you moved stay moved.
   * Absent means the plan is exactly as planned.
   */
  fixingEdits?: FixingEdits;
  /**
   * What colour to print things in. Absent means every colour comes from the
   * theme, which is what a layout has always looked like. See `WallColors`.
   */
  colors?: WallColors;
  /**
   * How many of each parts-list line have come off the printer, keyed by
   * `BomLine.partId` — the build's progress, so the list can say what is LEFT.
   *
   * On the document rather than in the browser, for the same reason the wall
   * photo's alignment is: it belongs to this wall, it travels down a share link,
   * and it undoes. A count is kept even when it exceeds what the layout now
   * needs — delete a shelf and put it back and the four you printed are still
   * printed — so the ceiling is applied when the line is READ, never here.
   * Absent means nothing has been printed yet.
   */
  printed?: Record<string, number>;
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
    | 'no-room-for-mounts'
    /** Its fixing was removed by hand, so nothing holds this plate to the wall. */
    | 'panel-unfixed';
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
  /**
   * How many of this line are already printed, and how many are still to go.
   *
   * `printed` is `doc.printed[partId]` CAPPED at `quantity`, so a line never
   * reads "8 of 3 printed" after an edit shrank the wall; the document keeps the
   * larger number in case the parts come back. `toPrint` is what is left, and is
   * the number the whole feature exists to state.
   */
  printed: number;
  toPrint: number;
  /** LINE TOTALS: the per-unit estimate already multiplied by `quantity`. */
  grams: number;
  metres: number;
  /**
   * Per-unit figures, straight from the catalogue.
   *
   * Present because an exporter that computes them as `total / quantity` is
   * dividing an already-rounded number: 4.63 g each × 6 rounds to 27.8, and
   * 27.8 / 6 prints as 4.6. The sheet you carry to the printer then disagrees
   * with the catalogue in its last digit for no reason a reader can see.
   */
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
   * What to print it in, when somebody has said — `#rrggbb`, resolved through
   * the four levels in `colors.ts`. Absent means no colour was chosen, which is
   * not the same as "any colour": one is a decision, the other is its absence,
   * and the sheet says so.
   */
  color?: string;
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
    /**
     * The build's progress, summed over every printed line: how many of the
     * `parts` above are done, and how many are still to print. Both are capped
     * per line before they are added up, so `printed + toPrint === parts`.
     */
    printed: number;
    toPrint: number;
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
