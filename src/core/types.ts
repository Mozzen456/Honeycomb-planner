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

export interface LayoutDoc {
  schemaVersion: number;
  id: string;
  name: string;
  wall: WallSpec;
  bedId: string;
  panels: PlacedPanel[];
  items: PlacedItem[];
  groups: Group[];
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
    | 'panel-overlap';
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
  minutes: number;
  grams: number;
  metres: number;
  supports: boolean;
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
  issues: Issue[];
}
