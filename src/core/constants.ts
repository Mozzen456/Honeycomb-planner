/**
 * HSW geometry constants — measured from the meshes in ./models/, not assumed.
 *
 * Provenance for every number here is HSW-SPEC.md, and the measurement code that
 * produced them is tools/*.py. Do not "tidy" these into closed forms: see D4 in
 * DECISIONS.md for why ROW_STEP is 20.438 and not 23.6·√3/2 = 20.43820.
 *
 * Canonical wall frame is POINTY-TOP: hexagons have a corner pointing +Y, flats
 * left and right, and neighbouring cells in a row are PITCH apart along X.
 */

/**
 * Centre-to-centre distance between cells sharing a column — VERTICALLY adjacent
 * on a flat-top wall. Exact.
 *
 * Named for the frame it was measured in, where it was the horizontal pitch. The
 * wall is drawn flat-top now (DECISIONS D31/D35), so it runs down a column; the
 * number is a property of the lattice and does not change with the frame.
 */
export const PITCH = 23.6;

/**
 * Centre-to-centre distance between adjacent COLUMNS. A typed constant in the
 * source CAD, NOT PITCH·√3/2 (= 20.43820). The 0.0002 mm difference accumulates
 * to 0.0034 mm across an 18-column panel, which is exactly the drift that stops
 * panels lining up.
 */
export const ROW_STEP = 20.438;

/** Vertical offset of each column relative to its neighbour. Exactly PITCH/2. */
export const STAGGER = 11.8;

/** Panel thickness. Identical across all seven shipped panels. */
export const PANEL_DEPTH = 8.0;

/**
 * Distance from an edge cell's centre to the panel boundary.
 *
 * Which axis carries which number is a property of the FRAME, and the frame
 * turned (D35). On a flat-top wall the left and right boundaries sit at a
 * hexagon corner (PITCH/√3) and the top and bottom at a flat (PITCH/2) — the
 * opposite way round from the pointy-top frame these were first measured in.
 * The two values themselves are unchanged and still verified against exact
 * boundary vertices; only their axes swapped.
 */
export const MARGIN_X = 13.6254664;
export const MARGIN_Y = 11.8;

/**
 * The two hexagon profiles that matter, as across-flats widths in mm.
 * The bore is stepped: a wide mouth, a chamfer, then the narrow throat that
 * actually retains an insert.
 */
export const CELL = {
  /** Full cell — the visible opening, 2.0 mm deep. */
  mouthAcrossFlats: 22.0,
  mouthAcrossCorners: 25.40341,
  mouthDepth: 2.0,
  /** Insert profile — the 4.6 mm throat almost everything clips into. */
  throatAcrossFlats: 20.0,
  throatAcrossCorners: 23.09401,
  throatDepth: 4.6,
  /** 48° lead-in between throat and mouth. */
  chamferDepth: 0.9,
  /** 0.5 mm entry flare on the far face, opening to 20.8. */
  entryFlareDepth: 0.5,
  entryFlareAcrossFlats: 20.8,
} as const;

/** Minimum material between adjacent cells, at the throat and at the mouth. */
export const WALL_AT_THROAT = PITCH - CELL.throatAcrossFlats; // 3.6
export const WALL_AT_MOUTH = PITCH - CELL.mouthAcrossFlats; // 1.6

/** The standard insert envelope: 22.5 mm flange, 19.7 mm body, 10 mm tall. */
export const INSERT = {
  flangeAcrossFlats: 22.5,
  flangeAcrossCorners: 25.9808,
  flangeThickness: 2.5,
  bodyAcrossFlats: 19.7,
  barbAcrossFlats: 20.735,
  height: 10.0,
} as const;

/**
 * Diagonal neighbour distance. Slightly under PITCH because ROW_STEP is rounded.
 * Present so tests can assert it rather than rediscover it as a "bug".
 */
export const DIAGONAL_NEIGHBOUR = Math.sqrt(STAGGER ** 2 + ROW_STEP ** 2); // 23.59983

/** Printer beds the planner can tile for. Usable area, mm. */
export interface Bed {
  id: string;
  label: string;
  width: number;
  depth: number;
}

export const BEDS: Bed[] = [
  { id: 'mini', label: 'Prusa Mini', width: 180, depth: 180 },
  { id: 'bed220', label: '220 × 220 (Ender 3 / K1)', width: 220, depth: 220 },
  { id: 'bed235', label: '235 × 235 (Ender 3 V2)', width: 235, depth: 235 },
  { id: 'mk3s', label: 'Prusa MK3S/MK4 (250 × 210)', width: 250, depth: 210 },
  { id: 'bed256', label: '256 × 256 (Bambu X1/P1)', width: 256, depth: 256 },
  { id: 'bed300', label: '300 × 300', width: 300, depth: 300 },
  { id: 'bed350', label: '350 × 350 (Bambu X1E / large)', width: 350, depth: 350 },
  { id: 'bed400', label: '400 × 400', width: 400, depth: 400 },
];
