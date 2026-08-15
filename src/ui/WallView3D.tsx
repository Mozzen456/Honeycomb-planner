/**
 * The wall in three dimensions.
 *
 * The honeycomb is a physical thing you hang objects ON, so a flat plan hides
 * the one question that actually matters when you are standing in front of it:
 * how far does this stick out, and does it foul the thing next to it. The 3D
 * view answers that directly — panels are 8 mm plates with real hexagonal
 * holes, and every accessory is drawn at its measured depth, standing proud of
 * the wall.
 *
 * The document is untouched by any of this. Position is still axial hex
 * coordinates; millimetres appear here, and pixels never do.
 *
 * Performance shape: one extruded geometry per DISTINCT panel size, drawn as an
 * InstancedMesh, so a 60-panel garage wall is two draw calls rather than 5,800.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import { fasteningPlanFor, fixingPlanFor, itemCells, panelLineKeys } from '../core/bom';
import { colorOfItem, colorOfLine, colorOfPanel } from '../core/colors';
import { JUNCTION_FIXING_ID } from '../core/fixings';
import { CELL, PANEL_DEPTH, PITCH } from '../core/constants';
import {
  cellsCentreMm, hexKey, hexToMm, mmToHex, panelCells, placedPanelCells,
} from '../core/hex';
import { buildHoneycombMesh } from '../core/honeycomb';
import {
  borderCutCells,
  isGeneratedSize, panelFrameKey, panelIsBordered, panelModelSpecFor,
} from '../core/panelModel';
import { partCells } from '../core/store';
import { photoCentreMm, photoRectMm, photoRotation } from '../core/wallPhoto';
import type {
  Catalog, CatalogPart, Hex, LayoutDoc, PlacedPanel, Rotation,
} from '../core/types';
import { loadPartMesh, solidToGeometry, type PartMesh } from './meshLibrary';
import { peekWallPhotoImage, wallPhotoImage } from './wallPhotoImage';
import './WallView3D.css';

export interface Drag3D {
  partId?: string;
  itemIds?: string[];
  rotation: Rotation;
  grabOffset: Hex;
}

export interface WallView3DProps {
  doc: LayoutDoc;
  catalog: Catalog;
  selection: readonly string[];
  drag: Drag3D | null;
  dragRef: { current: Drag3D | null };
  placementValid: boolean;
  onDragMove: (cell: Hex) => void;
  onDrop: (cell: Hex) => void;
  onDragCancel: () => void;
  onSelect: (ids: string[], additive: boolean) => void;
  onStartItemDrag: (itemIds: string[], grabOffset: Hex) => void;
  /**
   * The wall fixing the user has picked — a single fixing's cell, or a junction
   * fastener's ANCHOR. Held by the shell rather than in the store's selection,
   * because a fixing is not an item: every consumer of `selection` looks its ids
   * up in `doc.items`, and a cell key in that list would be a stranger to all of
   * them. Null when nothing is picked.
   */
  pickedFixing?: Hex | null;
  /** Picked, or unpicked with null. Clicking bare wall clears it. */
  onPickFixing?: (at: Hex | null) => void;
  /** Dragged from one cell to another. The store refuses what cannot land. */
  onMoveFixing?: (from: Hex, to: Hex) => void;
  /**
   * Panel ids to light up — the plates a parts-list line is talking about.
   *
   * Ids and not a partId, because which plates a line means is a rule with one
   * owner (`bom.panelsForLine`): a cut or bordered plate has left the stock line
   * for a generated one, and a view deciding for itself would light a plate the
   * line does not count.
   */
  litPanelIds?: ReadonlySet<string>;
}

/** The six neighbour directions, in the same order as the corner indices below. */
const DIRS: readonly Hex[] = [
  { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 },
  { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 },
];

/**
 * A six-sided prism aligned to a WALL CELL, standing along +Z.
 *
 * This replaces `FITTING_SEAT_RADIANS`, which is gone. That constant existed
 * because the parts are drawn flat-top while the wall was drawn pointy-top, so
 * every fitting needed 30° to seat in its hole — and its own comment said the
 * real fix was the frame. The frame is turned (D35), so the correction for a
 * real mesh is now zero and it has simply been deleted.
 *
 * What remains is the opposite problem, and it is why this helper exists rather
 * than nothing at all. `CylinderGeometry(…, 6)` puts its first vertex on an axis,
 * which after `rotateX(90°)` lands the corners at 30°/90°/…/330° — that matched
 * a pointy-top cell exactly, and it is 30° out from a flat-top one. So geometry
 * the VIEW builds now needs the half-face turn that meshes from FILES no longer
 * do. Building it in here, once, keeps that fact in one place instead of three
 * `rotation.z` terms that have to be remembered separately.
 *
 * `hexCorners` in hex.ts is the authority on where a cell's corners are; this
 * matches it at 0°/60°/…/300°, and tests/fitting-seat.test.ts pins the two
 * together.
 */
function cellPrism(radius: number, depth: number): THREE.CylinderGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, depth, 6);
  g.rotateX(Math.PI / 2);
  g.rotateZ(Math.PI / 6);
  return g;
}

/**
 * How far out of the wall a part's mesh sits — the ONE reading of it.
 *
 * Everything mounts ON the wall face, where `meshLibrary.orient` leaves its
 * mating face. A fitting is the exception: it mounts IN the wall, body through
 * the 22.0 mm mouth into the throat, and only its flange stays on this side
 * (HSW-SPEC §5). `measureInsertSeat` finds that split on the mesh itself, so
 * this drops the part by the length of the body and leaves the flange proud —
 * which is what a photograph of an installed insert shows, and what the
 * alignment tool draws a part up against.
 *
 * The fixings were at `PANEL_DEPTH − depthMm`: the whole 10 mm inside an 8 mm
 * plate, so the flange was buried 2.5 mm in the honeycomb and 2 mm of body came
 * out of the back. That is the fallback now, for a fitting whose mesh will not
 * read as one — wrong by a flange, and still nearer than standing it in the
 * room.
 */
function seatedZ(mesh: PartMesh, fitting: boolean): number {
  if (mesh.seat !== null) return PANEL_DEPTH - mesh.seat.bodyMm;
  return fitting ? PANEL_DEPTH - mesh.depthMm : PANEL_DEPTH;
}

/**
 * Corner k of a FLAT-TOP cell, in wall millimetres.
 *
 * Must stay identical to `hexCorners` in hex.ts — this builds the plate's
 * outline and that draws the plan view, so a disagreement is a panel whose 3D
 * silhouette does not match its own 2D drawing. The `− 90` that used to be here
 * went with the frame (D35).
 */
function corner(centre: { x: number; y: number }, k: number, acrossFlats: number) {
  const R = acrossFlats / Math.sqrt(3);
  const a = (Math.PI / 180) * (60 * (((k % 6) + 6) % 6));
  return new THREE.Vector2(centre.x + R * Math.cos(a), centre.y + R * Math.sin(a));
}

/**
 * A RING round a cell's mouth — which cell, without plugging it.
 *
 * This was a solid hexagonal prism sitting in the mouth, and a cell is a HOLE:
 * anything that goes into it disappeared behind the marker meant to point at it.
 * Now that a fitting is seated in the wall rather than standing out in the room
 * (D53) that is most of what you came to look at — the socket in the top of an
 * insert, the bore a bolt goes through, the daylight through a hollow one.
 *
 * `PartInspector` learnt the same thing as D44 and its cells have been rings
 * ever since. This is the wall's copy of that lesson: 0.6 mm each side of the
 * 1.6 mm web, so the marker sits ON the rim without swallowing it.
 */
function cellRing(centre: { x: number; y: number }, depth: number): THREE.ExtrudeGeometry {
  const outer: THREE.Vector2[] = [];
  const inner: THREE.Vector2[] = [];
  for (let k = 0; k < 6; k++) {
    outer.push(corner(centre, k, CELL.mouthAcrossFlats + 1.2));
    // Reversed, so it reads as a hole against the counter-clockwise outline.
    inner.push(corner(centre, 5 - k, CELL.mouthAcrossFlats));
  }
  const shape = new THREE.Shape(outer);
  shape.holes.push(new THREE.Path(inner));
  const g = new THREE.ExtrudeGeometry([shape], {
    depth, bevelEnabled: false, curveSegments: 1,
  });
  g.computeVertexNormals();
  return g;
}

/**
 * The outline of a set of cells: the boundary of their union.
 *
 * An edge is on the boundary exactly when the neighbour across it is not in the
 * set. Walking each cell's own boundary counter-clockwise makes the shared
 * edges cancel, so chaining what is left yields the panel's real zig-zag
 * silhouette — no rectangle approximation, and no seam down the middle.
 */
function unionOutline(cells: readonly Hex[]): THREE.Vector2[] {
  const inSet = new Set(cells.map(hexKey));

  /**
   * Vertices are snapped to a 0.25 mm grid before being matched.
   *
   * Two things force this. Real distinct corners are at least 6.8 mm apart, so
   * nothing legitimate can collide. But adjacent cells do NOT compute a shared
   * corner to the same float: ROW_STEP is the typed 20.438 rather than the
   * 20.43829 that makes hexagons tile exactly (D4), so the two copies sit
   * 0.0003 mm apart. Matching on rounded coordinates let that straddle a
   * rounding boundary, the chain broke, and the outline came back open — 58
   * boundary edges chaining into 41 points and a plate 7% short of its area.
   */
  const SNAP = 0.25;
  const key = (v: THREE.Vector2) => `${Math.round(v.x / SNAP)},${Math.round(v.y / SNAP)}`;

  const outgoing = new Map<string, Array<{ a: THREE.Vector2; b: THREE.Vector2 }>>();
  let edgeCount = 0;
  for (const c of cells) {
    const centre = hexToMm(c);
    for (let k = 0; k < 6; k++) {
      const d = DIRS[k]!;
      if (inSet.has(hexKey({ q: c.q + d.q, r: c.r + d.r }))) continue;
      // Direction k's edge runs from corner k to corner k+1, counter-clockwise.
      //
      // It was k+1 to k+2 in the pointy-top frame, and the shift is forced by
      // the corner angles, not a preference. DIRS point along the EDGE NORMALS,
      // which sit at 30°/90°/…/330° here; a cell's corners are at 0°/60°/…/300°
      // (`corner`, matching `hexCorners`). Edge k therefore lies between the
      // corners 30° either side of its normal — 60k and 60k+60, i.e. indices k
      // and k+1. Under the old `60k − 90` corners those same two worked out as
      // k+1 and k+2.
      //
      // Get this wrong and the boundary walk chains edges that do not touch:
      // the outline comes back as a scatter of open wedges instead of a plate.
      const a = corner(centre, k, PITCH);
      const b = corner(centre, k + 1, PITCH);
      const ka = key(a);
      const list = outgoing.get(ka);
      if (list) list.push({ a, b });
      else outgoing.set(ka, [{ a, b }]);
      edgeCount++;
    }
  }
  if (edgeCount === 0) return [];

  // Start at the lowest, then leftmost vertex — guaranteed to be on the outer
  // boundary rather than inside a notch.
  let startKey = '';
  let startPt: THREE.Vector2 | null = null;
  for (const [k, list] of outgoing) {
    const p = list[0]!.a;
    if (!startPt || p.y < startPt.y - 1e-9 || (Math.abs(p.y - startPt.y) < 1e-9 && p.x < startPt.x)) {
      startPt = p;
      startKey = k;
    }
  }
  if (!startPt) return [];

  const loop: THREE.Vector2[] = [startPt];
  const used = new Set<{ a: THREE.Vector2; b: THREE.Vector2 }>();
  let cur = startKey;
  let din: { x: number; y: number } | null = null;

  for (let guard = 0; guard < edgeCount + 2; guard++) {
    const cands = (outgoing.get(cur) ?? []).filter((e) => !used.has(e));
    if (cands.length === 0) break;
    let pick = cands[0]!;
    if (cands.length > 1 && din) {
      // A castellated edge can have two boundary edges leaving one vertex.
      // Taking the tightest clockwise turn from the reversed incoming direction
      // keeps the interior on the left, which is what traces the OUTER loop.
      const back = Math.atan2(-din.y, -din.x);
      let best = Infinity;
      for (const e of cands) {
        const ang = Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x);
        let t = back - ang;
        while (t <= 1e-9) t += 2 * Math.PI;
        while (t > 2 * Math.PI) t -= 2 * Math.PI;
        if (t < best) {
          best = t;
          pick = e;
        }
      }
    }
    used.add(pick);
    din = { x: pick.b.x - pick.a.x, y: pick.b.y - pick.a.y };
    loop.push(pick.b);
    cur = key(pick.b);
    if (cur === startKey) break;
  }
  return loop;
}

/**
 * One panel as TWO extruded solids: the 6 mm body bored to the 20 mm throat,
 * and a 2 mm front face bored to the 22 mm mouth.
 *
 * The previous version built one extrusion PER CELL — an independent hexagonal
 * ring each. Adjacent rings share their outer edge, so every cell boundary
 * carried two coincident 8 mm-tall side walls that are inside solid material
 * and should not exist. Rendered at an angle those walls read as thick dark
 * borders, and the plate looked like a tray of hexagonal cups rather than a
 * perforated sheet. That is the "why is it so thick".
 *
 * Now it is one shape: the union outline, with one hole per cell. The only
 * vertical faces left are the panel silhouette and the bores, so the web reads
 * as the 1.6 mm rib it actually is (23.6 pitch − 22.0 mouth), and the step down
 * to the 20 mm throat is visible inside each hole.
 */
function buildPanelGeometry(
  columns: number,
  rows: number,
  omit: readonly Hex[] = [],
): { back: THREE.BufferGeometry; front: THREE.BufferGeometry } {
  const cells = placedPanelCells({ origin: { q: 0, r: 0 }, columns, rows, omit });
  // The silhouette follows whatever cells remain, so a switch cut out of an
  // EDGE shows up in the outline for free. A cut in the MIDDLE cannot: the
  // outline walk returns the outer loop only, so those cells are added below as
  // full-cell voids instead. Without that they were drawn as solid plate —
  // exactly the material you had to remove.
  const outline = unionOutline(cells);
  const cut = omit.map((c) => ({ q: c.q, r: c.r }));

  const make = (holeAcrossFlats: number, depth: number) => {
    const shape = new THREE.Shape(outline);
    for (const c of cells) {
      const centre = hexToMm(c);
      const pts: THREE.Vector2[] = [];
      // Clockwise, so it reads as a hole against the counter-clockwise outline.
      for (let k = 5; k >= 0; k--) pts.push(corner(centre, k, holeAcrossFlats));
      shape.holes.push(new THREE.Path(pts));
    }
    for (const c of cut) {
      const centre = hexToMm(c);
      const pts: THREE.Vector2[] = [];
      for (let k = 5; k >= 0; k--) pts.push(corner(centre, k, PITCH));
      shape.holes.push(new THREE.Path(pts));
    }
    const g = new THREE.ExtrudeGeometry([shape], {
      depth,
      bevelEnabled: false,
      curveSegments: 1,
    });
    g.computeVertexNormals();
    return g;
  };

  // The 22.0 mouth is the WALL side (z 0…2) and the 20.0 throat is what the room
  // sees — see BORE_PROFILE, and the insert barbs that prove it. `front` is the
  // layer you look at, so it keeps the face tone; it is now the throat.
  const back = make(CELL.mouthAcrossFlats, CELL.mouthDepth);
  const front = make(CELL.throatAcrossFlats, PANEL_DEPTH - CELL.mouthDepth);
  front.translate(0, 0, CELL.mouthDepth);
  return { back, front };
}

/**
 * A generated plate as three.js geometry, in the plate's own frame.
 *
 * Built in ABSOLUTE wall millimetres — the frame lines are absolute, so it has
 * to be — and then shifted back by the panel's origin, because the caller
 * instances it and translates each copy by `hexToMm(origin)`. Every member of an
 * instancing group is a translation of this one; the group key includes the
 * frame, which is what makes that true.
 *
 * Returns null rather than throwing when the generator refuses a shape, so one
 * awkward plate cannot take the whole wall down with it.
 */
function generatedPanelGeometry(
  panel: PlacedPanel,
  doc: LayoutDoc,
): THREE.BufferGeometry | null {
  try {
    const spec = panelModelSpecFor(panel, doc);
    if (spec.cells.length === 0) return null;
    const mesh = buildHoneycombMesh({ ...spec, originAtZero: false });
    const o = hexToMm(panel.origin);
    return solidToGeometry(mesh, -o.x, -o.y);
  } catch {
    return null;
  }
}

/**
 * The plate a hover highlight is drawn from, cached by SHAPE.
 *
 * Keyed exactly as the instancing groups are — part, block, cut and frame —
 * because that key already means "these plates are the same plate", which is
 * what makes one geometry serve all of them. Never disposed and never large: a
 * wall has a handful of distinct plates, and a changed plate takes a new key.
 *
 * Separate from the panel effect's own geometries on purpose. Those are disposed
 * on every rebuild, and a highlight holding one would be drawing from freed
 * buffers the moment the wall was re-solved.
 */
const hoverPlates = new Map<string, THREE.BufferGeometry | null>();

function plateShapeKey(p: PlacedPanel, doc: LayoutDoc): string {
  const cut = (p.omit ?? [])
    .map((c) => hexKey({ q: c.q - p.origin.q, r: c.r - p.origin.r }))
    .sort()
    .join(' ');
  return `${p.partId}|${p.columns}x${p.rows}|${cut}|${panelFrameKey(p, doc.panels, doc.frame)}`;
}

function hoverPlateGeometry(p: PlacedPanel, doc: LayoutDoc): THREE.BufferGeometry | null {
  const key = plateShapeKey(p, doc);
  const had = hoverPlates.get(key);
  if (had !== undefined) return had;
  const geo = generatedPanelGeometry(p, doc);
  hoverPlates.set(key, geo);
  return geo;
}

/**
 * How far a part stands off the wall, and how big it is in the wall plane.
 *
 * Both come from `projectionMm`, measured by the scanner from the part's mating
 * axis (or, where there is none, from the face with the most material against
 * the wall). The obvious shortcut — the largest bounding-box dimension — is
 * wrong for nearly every part here: it stood a 10 mm insert 26 mm off the wall,
 * and would have drawn the 200 mm wrench rack as a 200 mm column instead of the
 * 13 mm bar it is.
 */
function partBox(part: CatalogPart): { depth: number; w: number; h: number } {
  const bbox = part.bboxMm ?? [20, 20, 10];
  const proj = (part as unknown as { projectionMm?: number }).projectionMm;
  const depth = Number.isFinite(proj) && (proj as number) > 0
    ? (proj as number)
    : Math.min(...bbox);

  // The two dimensions that are not the projection are the wall-plane size.
  const rest = [...bbox];
  const i = rest.findIndex((v) => Math.abs(v - depth) < 1e-6);
  if (i >= 0) rest.splice(i, 1);
  const [w, h] = [rest[0] ?? 20, rest[1] ?? 20];
  return { depth: Math.max(2, depth), w: Math.max(4, w), h: Math.max(4, h) };
}

export function WallView3D(props: WallView3DProps) {
  const {
    doc, catalog, selection, drag, dragRef, placementValid,
    onDragMove, onDrop, onDragCancel, onSelect, onStartItemDrag,
    pickedFixing = null, onPickFixing, onMoveFixing, litPanelIds,
  } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    raycaster: THREE.Raycaster;
    plane: THREE.Plane;
    panelGroup: THREE.Group;
    itemGroup: THREE.Group;
    ghostGroup: THREE.Group;
    hoverGroup: THREE.Group;
    obstacleGroup: THREE.Group;
    fixingGroup: THREE.Group;
    photoGroup: THREE.Group;
    frame: number;
  } | null>(null);

  const [ready, setReady] = useState(false);

  /**
   * The real STL for each panel type, by part id.
   *
   * A panel used to be drawn entirely from generated geometry — an extruded
   * union outline with a hole per cell, built from the measured lattice. That is
   * exact, but it is a MODEL of the plate rather than the plate: it cannot show
   * the entry flare, the lead-in chamfer, or anything the designer put there
   * that the four numbers in `constants.ts` do not capture.
   *
   * Loaded lazily and instanced per type, so a 64-panel wall is still one draw
   * call per panel type. The generated geometry stays as the fallback and is
   * still what a CUT panel uses — see the `omit` check where it is chosen.
   */
  const [panelMeshes, setPanelMeshes] = useState<ReadonlyMap<string, PartMesh>>(new Map());

  /**
   * Bumped on a theme change, purely to force the scene to be rebuilt.
   *
   * Materials and the scene background are baked from the token layer when the
   * meshes are built. A theme switch changes no React state, so without this
   * the chrome goes dark around a stubbornly light-grey wall.
   */
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    const bump = () => setThemeTick((n) => n + 1);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style'],
    });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', bump);
    return () => {
      mo.disconnect();
      mq.removeEventListener('change', bump);
    };
  }, []);
  // A gentle three-quarter view: enough perspective to read how far things
  // stand off the wall, not so much that you cannot aim at a cell. phi is the
  // polar angle, so ~1.45 rad is just above eye level with the wall.
  const orbitRef = useRef({ theta: -0.22, phi: 1.42, dist: 2200, tx: 0, ty: 0 });
  const pressRef = useRef<{
    x: number; y: number; cell: Hex; itemId?: string;
    /** The wall fixing under the press — its cell, or a junction's anchor. */
    fixing?: { at: Hex; junction: boolean };
    moved: boolean;
  } | null>(null);
  /**
   * A fixing being dragged, written synchronously on the first move past the
   * threshold. A REF and not state, for the reason D58 records twice over: the
   * release can arrive before React has rendered, and a `pointerup` reading a
   * state copy of this would find nothing and move nothing.
   */
  const fixingDragRef = useRef<{ from: Hex; junction: boolean } | null>(null);
  const panRef = useRef<{ x: number; y: number; mode: 'orbit' | 'pan' } | null>(null);

  const partOf = useCallback(
    (id: string) => catalog.parts.find((p) => p.id === id),
    [catalog],
  );

  /** Cell -> item id, for picking. */
  const itemIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of doc.items) for (const c of itemCells(it, catalog)) m.set(hexKey(c), it.id);
    return m;
  }, [doc.items, catalog]);

  /**
   * Panel id -> the parts-list line it is counted on, which is what a plate's
   * colour is keyed by. One walk of the assembly, through `bom.panelLineKeys` —
   * the one place the stock-versus-generated split is decided (D92).
   */
  const panelLines = useMemo(() => panelLineKeys(doc), [doc]);

  // --- scene setup --------------------------------------------------------

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    /*
     * `alpha: true`, and the scene keeps NO background of its own.
     *
     * The wall is the subject and it was standing on a flat rectangle of
     * `--canvas-wall` — the largest surface in the product, one value, edge to
     * edge, which is what made a lit 3D object look like a screenshot pasted
     * onto a swatch. The backdrop is now a CSS gradient on the host (see
     * `.wall3d` in WallView3D.css), so it is built from the same tokens, follows
     * the theme with no second definition, and costs the renderer nothing.
     */
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = false;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 10, 40000);

    // Kept deliberately restrained. At full brightness a Lambert surface washes
    // to white and the accent-coloured parts became indistinguishable from the
    // grey plate — the one distinction the view exists to make.
    // Balanced between two failure modes seen on real screens: too bright and a
    // Lambert surface washes to white, so the accent parts stop reading against
    // the plate; too dim and the dark theme's plate (only two ramp steps above
    // the void) disappears into the background entirely.
    scene.add(new THREE.AmbientLight(0xffffff, 0.62));
    const key = new THREE.DirectionalLight(0xffffff, 0.95);
    key.position.set(-0.35, 0.7, 1).multiplyScalar(1000);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(0.9, -0.3, 0.6).multiplyScalar(1000);
    scene.add(fill);

    const panelGroup = new THREE.Group();
    const itemGroup = new THREE.Group();
    const ghostGroup = new THREE.Group();
    const hoverGroup = new THREE.Group();
    const obstacleGroup = new THREE.Group();
    const fixingGroup = new THREE.Group();
    const photoGroup = new THREE.Group();
    scene.add(
      panelGroup, itemGroup, ghostGroup, hoverGroup, obstacleGroup, fixingGroup, photoGroup,
    );

    stateRef.current = {
      renderer, scene, camera,
      raycaster: new THREE.Raycaster(),
      // Picking happens on the panel's FRONT face, which is where the user is
      // pointing — not on z = 0, which would put the cursor behind the plate.
      plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -PANEL_DEPTH),
      panelGroup, itemGroup, ghostGroup, hoverGroup, obstacleGroup, fixingGroup, photoGroup,
      frame: 0,
    };
    setReady(true);

    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width));
      const h = Math.max(1, Math.floor(r.height));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(stateRef.current?.frame ?? 0);
      renderer.dispose();
      host.removeChild(renderer.domElement);
      stateRef.current = null;
    };
  }, []);

  /**
   * Read the theme's colours so the 3D view follows the token layer.
   *
   * The tokens are built as `rgb(var(--accent-rgb))` over a space-separated
   * triple, so `getComputedStyle` hands back `rgb(15  97 147)` — with doubled
   * whitespace, which three.js's colour parser rejects. It fails silently and
   * leaves the material white, which is how every accent-coloured part came out
   * the same grey as the plate. Letting the browser normalise the string first
   * makes this immune to whatever colour syntax the tokens use next.
   */
  const readTheme = useCallback(() => {
    const host = hostRef.current;
    const css = host ? getComputedStyle(host) : null;
    const probe = document.createElement('canvas').getContext('2d');

    const colour = (name: string, fallback: string): THREE.Color => {
      const raw = (css?.getPropertyValue(name) || '').trim();
      if (raw && probe) {
        probe.fillStyle = '#000000';
        probe.fillStyle = raw;
        const normalised = probe.fillStyle;
        if (typeof normalised === 'string' && normalised !== '#000000') {
          return new THREE.Color(normalised);
        }
      }
      return new THREE.Color(raw || fallback);
    };

    return {
      bg: colour('--canvas-wall', '#101418'),
      panel: colour('--canvas-panel-tint', '#c8ced6'),
      item: colour('--accent', '#3d7ea6'),
      selected: colour('--canvas-selection', '#57aee8'),
      ok: colour('--success-fg', '#5fc98a'),
      bad: colour('--danger-fg', '#f0867b'),
      // The ACCENT, not `--canvas-cell-hover`. That token is a dark slate, which
      // reads as a highlight on the 2D canvas because it is lighter than the
      // wall behind it — but in 3D the cell sits on a pale grey plate, where the
      // same colour darkens instead of lights. Drawn additively (below) so it
      // brightens whatever is under it, on a plate or over a gap, in either theme.
      hover: colour('--accent', '#57aee8'),
    };
  }, []);

  // --- world position of the wall centre, for framing ---------------------

  const wallCentre = useMemo(() => {
    if (doc.panels.length === 0) {
      return new THREE.Vector3(doc.wall.widthMm / 2, doc.wall.heightMm / 2, 0);
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of doc.panels) {
      for (const c of panelCells(p.origin, p.columns, p.rows)) {
        const m = hexToMm(c);
        minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x);
        minY = Math.min(minY, m.y); maxY = Math.max(maxY, m.y);
      }
    }
    return new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, 0);
  }, [doc.panels, doc.wall.widthMm, doc.wall.heightMm]);

  const fit = useCallback(() => {
    const span = Math.max(doc.wall.widthMm, doc.wall.heightMm * 1.6, 400);
    orbitRef.current = { theta: -0.22, phi: 1.42, dist: span * 1.05, tx: 0, ty: 0 };
  }, [doc.wall.widthMm, doc.wall.heightMm]);

  useEffect(() => { fit(); }, [fit]);

  // --- build the panels ---------------------------------------------------

  useEffect(() => {
    const s = stateRef.current;
    if (!s || !ready) return;
    const theme = readTheme();
    // No scene background: the host's gradient is the backdrop, and it shows
    // through because the renderer was made with `alpha: true`.
    s.scene.background = null;

    for (const child of [...s.panelGroup.children]) {
      s.panelGroup.remove(child);
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
    }

    // One geometry per distinct SHAPE, instanced across every panel using it.
    // A panel cut round a light switch is a different shape from the stock
    // block it came from, so the key has to include what it omits — keying on
    // columns × rows alone drew the cut panels solid.
    const bySize = new Map<
      string,
      {
        partId: string; columns: number; rows: number; omit: Hex[];
        sample: PlacedPanel; origins: Hex[]; lit: boolean; colour: string | undefined;
      }
    >();
    for (const p of doc.panels) {
      const cut = (p.omit ?? [])
        .map((c) => hexKey({ q: c.q - p.origin.q, r: c.r - p.origin.r }))
        .sort()
        .join(' ');
      // Keyed on the PART as well as the shape: two panel types can share a
      // cell block and still be different plates, and each has its own mesh.
      // And on the FRAME, because two plates with the same cut can still be
      // mirror images of each other when the border is on opposite edges.
      /*
        * LIT joins the key, and it has to.
        *
        * Every group becomes one `InstancedMesh` sharing a single material, so
        * two plates of the same shape cannot be drawn in two tones from one
        * batch. Keying on it splits them into two batches — normally one, since
        * nothing is lit — which is the only way "these three plates, not those
        * four" can be said in an instanced draw.
        */
      const lit = litPanelIds?.has(p.id) === true;
      // ...and so does the COLOUR, for exactly the same reason: one batch, one
      // material. Two plates of a shape printed in different filament are two
      // draws.
      const colour = colorOfPanel(doc.colors, panelLines.get(p.id));
      const k = `${p.partId}|${p.columns}x${p.rows}|${cut}|${panelFrameKey(p, doc.panels, doc.frame)}|${lit ? 'lit' : ''}|${colour ?? ''}`;
      const e = bySize.get(k) ?? {
        lit,
        colour,
        partId: p.partId,
        columns: p.columns,
        rows: p.rows,
        omit: (p.omit ?? []).map((c) => ({ q: c.q - p.origin.q, r: c.r - p.origin.r })),
        // One panel of the group, to generate the plate from. Every other member
        // is a translation of it — that is what the key guarantees.
        sample: p,
        origins: [],
      };
      e.origins.push(p.origin);
      bySize.set(k, e);
    }

    // Two tones, and the gap between them is doing real work.
    //
    // Face-on, a real panel shows a 1.6 mm rib (23.6 pitch − 22.0 mouth) and
    // then, 2 mm back, a 1 mm shoulder each side down to the 20.0 throat. Both
    // are "wall" to the eye unless the recessed one is visibly recessed — and
    // with them nearly the same tone the plate read as a 3.6 mm wall, i.e.
    // twice as thick as it looks in the hand. Lighting the front face brightly
    // and letting the shoulder sit back in shadow is what the real part does.
    const darker = theme.panel.clone().lerp(new THREE.Color(0x000000), 0.28);
    const bodyMat = new THREE.MeshLambertMaterial({ color: darker });
    const faceMat = new THREE.MeshLambertMaterial({
      color: theme.panel.clone().lerp(new THREE.Color(0xffffff), 0.18),
    });
    /*
     * A LIT plate: the plate's own tone carried most of the way to the selection
     * colour, not replaced by it. Replaced, a highlighted plate stops reading as
     * a plate at all — the honeycomb disappears into a flat blue slab and you
     * cannot see which cells it has, which is usually why you clicked. Two tones
     * again, so the front face and the recessed shoulder stay apart.
     */
    const litFace = new THREE.MeshLambertMaterial({
      color: theme.panel.clone().lerp(theme.selected, 0.62),
    });
    const litBody = new THREE.MeshLambertMaterial({
      color: theme.panel.clone().lerp(theme.selected, 0.62).lerp(new THREE.Color(0x000000), 0.28),
    });

    for (const { partId, columns, rows, omit, sample, origins, lit, colour } of bySize.values()) {
      /*
       * The user's colour wins over the theme's plate tone, and the LIT tint
       * wins over both — a highlight has to be visible whatever the plate is
       * printed in, or clicking a line in the parts list does nothing for the
       * one wall where you most need it. The two tones are kept: the front face
       * is the colour, the recessed shoulder the same colour in shadow, so a
       * coloured plate still reads as a plate rather than a flat card.
       */
      const own = colour === undefined ? undefined : new THREE.Color(colour);
      const face = lit
        ? litFace
        : own
          ? new THREE.MeshLambertMaterial({ color: own })
          : faceMat;
      const body = lit
        ? litBody
        : own
          ? new THREE.MeshLambertMaterial({
              color: own.clone().lerp(new THREE.Color(0x000000), 0.28),
            })
          : bodyMat;
      /*
       * EVERY plate is drawn from the generator, stock ones included.
       *
       * It used to be the shipped STL for a plate the app had not had to make,
       * on the grounds that the generated geometry "cannot show the entry flare,
       * the lead-in chamfer, or anything the designer put there". That was true
       * of the drawn approximation below; it has not been true since
       * `honeycomb.ts` learnt the whole measured bore, which it reproduces to
       * 0.0025 % of volume and 0.0004 mm of bounding box on all seven plates
       * (`tests/honeycomb-model.test.ts`).
       *
       * And it is now load-bearing rather than tidy. The 22.0 mouth goes against
       * the WALL (see BORE_PROFILE), so a stock plate has to be drawn turned
       * over from the way the app used to hang it — and a printed plate turned
       * over is a MIRRORED cell block: measured, 48 of the 56 cell centres of
       * `wall-honeycomb-part` land in solid material once it is flipped, because
       * `panelCells` staggers by −floor(dq/2) and the flip wants +. The
       * generator has no such problem: it BUILDS the plate from the cells it is
       * given, so it makes the plate this wall needs rather than a picture of a
       * plate hung the wrong way round. One source for every plate on the wall
       * is also what stops a cut plate and its stock neighbour disagreeing about
       * which way the bore runs.
       */
      const generated = generatedPanelGeometry(sample, doc);
      if (generated) {
        const mesh = new THREE.InstancedMesh(generated, face, origins.length);
        const m4 = new THREE.Matrix4();
        origins.forEach((o, i) => {
          const p = hexToMm(o);
          m4.makeTranslation(p.x, p.y, 0);
          mesh.setMatrixAt(i, m4);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.frustumCulled = false;
        s.panelGroup.add(mesh);
        continue;
      }

      /*
       * The shipped mesh, kept as the FALLBACK for a shape the generator
       * refuses — better a plate hung the wrong way round than a hole in the
       * wall with no explanation.
       *
       * Still gated on this really being the shipped plate, and all three gates
       * matter: cells cut out, a size the app chose, and an EDGE. Missing the
       * edge drew the stock STL for every bordered plate, so the plan showed a
       * border, the parts list said "edged top + left", and the wall in 3D had
       * neither (D66).
       */
      const stock =
        omit.length === 0 &&
        !isGeneratedSize(partId) &&
        !panelIsBordered(sample, doc.panels, doc.frame);
      const real = stock ? panelMeshes.get(partId) : undefined;

      if (real) {
        /*
         * The mesh is centred on its own bounding box, so it is placed at the
         * centre of the block it represents — measured at the block's REAL
         * origin, not at (0, 0) and then shifted.
         *
         * That distinction is the whole bug this replaced. It used to add
         * `hexToMm(origin)` to the centre of a block at (0, 0), and BOTH of
         * those carry `LATTICE_ANCHOR` — so the anchor was counted twice and
         * every stock plate sat exactly `MARGIN_X` (13.6255 mm) to the right of
         * its own cells. Invisible on the plates themselves, because they all
         * shifted together and the honeycomb stayed continuous; visible the
         * moment a PART was placed, because parts are drawn at the true lattice
         * position and so appeared to sit between holes. Same class as D63.
         *
         * A centre measured at the real origin cannot double-count anything:
         * it is one anchored quantity used as one absolute position. It works
         * because a plate's margins are equal on opposite sides, so its cells
         * really are centred within it — measured, not assumed: the mesh comes
         * out 170.317 × 177.000 against a block of exactly the same size
         * (HSW-SPEC §4, `tests/plate-alignment.test.ts`).
         */
        const mesh = new THREE.InstancedMesh(real.geometry, face, origins.length);
        const m4 = new THREE.Matrix4();
        origins.forEach((o, i) => {
          const c = cellsCentreMm(panelCells(o, columns, rows));
          m4.makeTranslation(c.x, c.y, 0);
          mesh.setMatrixAt(i, m4);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.frustumCulled = false;
        // Not ours to dispose on rebuild: the geometry is cached per part id by
        // meshLibrary and shared with every other placement of that panel.
        mesh.userData['ownGeometry'] = false;
        s.panelGroup.add(mesh);
        continue;
      }

      /*
       * Last resort: cells and holes, two tones, no bore.
       *
       * Reached only when the generator refused the shape AND there is no
       * shipped mesh to fall back on — a plate that would otherwise simply not
       * be on the wall, with nothing to say why.
       */
      const { back, front } = buildPanelGeometry(columns, rows, omit);
      for (const [geo, mat] of [[back, body], [front, face]] as const) {
        const mesh = new THREE.InstancedMesh(geo, mat, origins.length);
        const m4 = new THREE.Matrix4();
        origins.forEach((o, i) => {
          const p = hexToMm(o);
          m4.makeTranslation(p.x, p.y, 0);
          mesh.setMatrixAt(i, m4);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.frustumCulled = false;
        s.panelGroup.add(mesh);
      }
    }
  }, [doc.panels, doc.frame, doc.colors, panelLines, panelMeshes, ready, readTheme, themeTick,
      litPanelIds]);

  // --- build the placed items --------------------------------------------

  /**
   * The two plans this view draws, computed ONCE per document.
   *
   * `fixingPlanFor` runs the whole seam-and-spacing solver over the wall, and it
   * was being run again inside `fasteningPlanFor` and once more by the parts
   * list. Memoised here and handed down, so the fixings you see and the
   * fasteners you see come from the same pass — the reading of "which cells are
   * free" that D48 says must not exist twice.
   */
  const fixingPlan = useMemo(() => fixingPlanFor(doc, catalog), [doc, catalog]);
  const fastenings = useMemo(
    () => fasteningPlanFor(doc, catalog, fixingPlan),
    [doc, catalog, fixingPlan],
  );

  /**
   * Cell -> the wall fixing you would be pointing at.
   *
   * Every cell of a junction maps to that junction's ANCHOR, so clicking any of
   * its four hexagons picks the one fastener rather than nothing. Built from the
   * same plan the view draws, or the thing you can click and the thing you can
   * see would be different objects.
   */
  const fixingIndex = useMemo(() => {
    const m = new Map<string, { at: Hex; junction: boolean }>();
    for (const cell of fixingPlan.cells) m.set(hexKey(cell), { at: cell, junction: false });
    for (const j of fixingPlan.junctions) {
      for (const c of j.cells) m.set(hexKey(c), { at: j.anchor, junction: true });
    }
    return m;
  }, [fixingPlan]);

  /**
   * Bumped when a part's real mesh finishes loading, to rebuild the item group.
   *
   * Loading is asynchronous and per part id, so the wall draws immediately with
   * boxes and each box is replaced by the real shape as its STL arrives. A part
   * that never arrives keeps its box, which is why the box code below stays.
   */
  const [meshTick, setMeshTick] = useState(0);
  const meshes = useRef(new Map<string, PartMesh | null>());

  /**
   * Drop this view's own copy whenever the catalogue changes identity.
   *
   * `meshLibrary` caches oriented geometry per part id and `forgetPartMesh`
   * clears it — but THIS ref is a second cache in front of that one, and nothing
   * was clearing it. So picking a new mounting face (D34) updated the catalogue,
   * dropped the library's copy, and then the view redrew from its own stale
   * entry: the part never visibly turned, which made the whole inspector look
   * like it did nothing.
   *
   * Keyed on the catalogue rather than on a bespoke signal because that is
   * exactly what changes when a correction is saved — and it costs nothing to be
   * broad here, since `loadPartMesh` still returns its cached promise for every
   * part whose geometry did not actually change.
   */
  useEffect(() => {
    meshes.current.clear();
  }, [catalog]);

  useEffect(() => {
    const s = stateRef.current;
    if (!s || !ready) return;
    const theme = readTheme();
    const sel = new Set(selection);

    for (const child of [...s.itemGroup.children]) {
      s.itemGroup.remove(child);
      const m = child as THREE.Mesh;
      // Only the geometry this view built is disposed. A cached part mesh is
      // shared between every placement of that part and owned by meshLibrary —
      // disposing it here would blank every copy on the wall the moment one of
      // them was deleted.
      if (m.userData['ownGeometry'] === true) m.geometry?.dispose();
      (m.material as THREE.Material)?.dispose?.();
    }

    for (const it of doc.items) {
      const part = partOf(it.partId);
      if (!part) continue;
      const cells = itemCells(it, catalog);
      if (cells.length === 0) continue;
      const { depth, w, h } = partBox(part);
      /*
       * Selected beats coloured: while something is selected, the wall's job is
       * to say WHICH, and a part painted the same blue as the selection colour
       * would be indistinguishable from a selected one. The colour comes back
       * the moment the selection moves on.
       */
      const own = colorOfItem(doc.colors, it);
      const colour = sel.has(it.id)
        ? theme.selected
        : own !== undefined
          ? new THREE.Color(own)
          : theme.item;
      const mat = new THREE.MeshLambertMaterial({ color: colour });

      // The body: the part's own mesh where we have it, otherwise a box at its
      // measured size, standing proud of the face.
      //
      // Placed at the BOX CENTRE of its cells, which is where `orient` centres
      // the mesh. This used to take the MEAN, which is the same point only for a
      // symmetric footprint — an L-shaped part sat 3.4 mm off its own holes.
      const { x: cx, y: cy } = cellsCentreMm(cells);

      const loaded = meshes.current.get(it.partId);
      if (loaded === undefined) {
        // Not asked for yet. Ask once per part id; the box below stands in.
        meshes.current.set(it.partId, null);
        void loadPartMesh(part).then((m) => {
          meshes.current.set(it.partId, m);
          if (m !== null) setMeshTick((n) => n + 1);
        });
      }

      const body = loaded
        ? new THREE.Mesh(loaded.geometry, mat)
        : new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), mat);
      // A fitting goes INTO the cell; everything else stands on the face. No
      // seat ROTATION: a mesh from a file is drawn flat-top and the wall is now
      // flat-top too, so it lands in its hole unturned (D35).
      const fitting = part.type === 'insert' || part.type === 'fastener';
      body.position.set(cx, cy, loaded ? seatedZ(loaded, fitting) : PANEL_DEPTH + depth / 2);
      body.rotation.z = (Math.PI / 3) * it.rotation;
      body.userData['itemId'] = it.id;
      body.userData['ownGeometry'] = loaded === null || loaded === undefined;
      s.itemGroup.add(body);

      // A ring round each occupied cell, so a multi-cell part still shows WHICH
      // cells it uses — the body alone would hide that. A ring and not a plug:
      // the plug filled the hole, and a hole is the thing you look through.
      for (const c of cells) {
        const p = hexToMm(c);
        const collar = new THREE.Mesh(cellRing(p, 0.8), mat);
        collar.position.z = PANEL_DEPTH - 0.4;
        collar.userData['itemId'] = it.id;
        collar.userData['ownGeometry'] = true;
        s.itemGroup.add(collar);
      }
    }

    /*
     * THE INSERTS THE ACCESSORIES THEMSELVES HANG ON.
     *
     * The wall drew the fixings holding the PLATES up and nothing holding the
     * things ON them — so a part seated against an insert in the alignment tool
     * arrived here with no insert under it, and the two views disagreed about
     * the thing the tool exists to line up.
     *
     * Straight from `fasteningPlanFor`, which is also what `computeBom` counts:
     * one plan, so an insert in the picture is an insert on the list. Where the
     * wall already carries one — an accessory pegged into a junction fixing's
     * open socket (D47) — the plan reports it as supplied and nothing is drawn,
     * because the part that provides it is drawn already.
     *
     * In the fixing tone rather than the item's: these are wall hardware, and a
     * builder reading the picture should see the same family of parts in the
     * seams and under the hooks.
     */
    /*
      * ...and in the COLOUR chosen for that fastener, when one has been.
      *
      * These are printed parts with a line of their own in the list, so the
      * swatch on that line has to reach them — and so does the `Parts` default,
      * which is what "the fasteners that are already there" means: the inserts
      * the app puts in are as much a part of the build as the hooks. Per part
      * id, because a wall can carry several kinds at once.
      */
    const fittingTone = theme.panel.clone().lerp(new THREE.Color(0xffffff), 0.35);
    const fittingMats = new Map<string, THREE.MeshLambertMaterial>();
    const fittingMat = (partId: string): THREE.MeshLambertMaterial => {
      const held = fittingMats.get(partId);
      if (held) return held;
      const own = colorOfLine(doc.colors, partId, false);
      const made = new THREE.MeshLambertMaterial({
        color: own === undefined ? fittingTone : new THREE.Color(own),
      });
      fittingMats.set(partId, made);
      return made;
    };
    for (const f of fastenings) {
      const part = partOf(f.partId);
      if (!part || f.cells.length === 0) continue;
      const loaded = meshes.current.get(f.partId);
      if (loaded === undefined) {
        meshes.current.set(f.partId, null);
        void loadPartMesh(part).then((m) => {
          meshes.current.set(f.partId, m);
          if (m !== null) setMeshTick((n) => n + 1);
        });
      }
      for (const at of f.cells) {
        // Through `itemCells`, so one instance covers exactly the cells a placed
        // copy of that fastener would — anchor shift, rotation and all.
        const covered = itemCells(
          { id: `${f.itemId}/${f.partId}`, partId: f.partId, at, rotation: f.rotation },
          catalog,
        );
        if (covered.length === 0) continue;
        const { x: fx, y: fy } = cellsCentreMm(covered);
        const mesh = loaded
          ? new THREE.Mesh(loaded.geometry, fittingMat(f.partId))
          : new THREE.Mesh(cellPrism(CELL.mouthAcrossFlats / Math.sqrt(3), PANEL_DEPTH), fittingMat(f.partId));
        mesh.rotation.z = (Math.PI / 3) * f.rotation;
        mesh.position.set(fx, fy, loaded ? seatedZ(loaded, true) : PANEL_DEPTH / 2);
        // Selecting the part it holds, not itself: it is not a placed item.
        mesh.userData['itemId'] = f.itemId;
        mesh.userData['ownGeometry'] = !loaded;
        s.itemGroup.add(mesh);
      }
    }
    // `doc.colors` is READ above, so it belongs here. Left out, colouring a part
    // changed the document, the parts list and nothing on the wall — the plates
    // repainted (their effect lists it) and the parts did not, which is exactly
    // how it was reported: "the colour selector on the part is not working, but
    // it is on the panels".
  }, [doc.items, doc.colors, fastenings, selection, catalog, partOf, ready, readTheme, themeTick,
      meshTick]);

  // --- wall fixings -------------------------------------------------------

  /**
   * The countersunk inserts that hold the wall up, drawn where they go.
   *
   * They were ordered by the parts list and never shown, which made the one
   * question a builder has at this stage — "where do I drill?" — unanswerable
   * from the picture. They are real parts in real cells, so they are drawn from
   * the real mesh like everything else, with the measured box as the fallback.
   *
   * The plan avoids cells accessories occupy, so what is drawn here is exactly
   * what is ordered and exactly where it fits.
   */
  const [fixingMesh, setFixingMesh] = useState<PartMesh | null>(null);
  const [junctionMesh, setJunctionMesh] = useState<PartMesh | null>(null);
  const fixingPart = useMemo(
    () => catalog.parts.find((p) => p.type === 'fastener' || p.type === 'insert'
      ? (p.hardware ?? []).some((h) => /wall (screw|plug)/i.test(h.item))
        && (p.footprint ?? []).length <= 1
      : false),
    [catalog],
  );

  const junctionPart = useMemo(
    () => catalog.parts.find((p) => p.id === JUNCTION_FIXING_ID),
    [catalog],
  );

  useEffect(() => {
    if (!fixingPart) return;
    let live = true;
    void loadPartMesh(fixingPart).then((m) => {
      if (live && m !== null) setFixingMesh(m);
    });
    return () => { live = false; };
  }, [fixingPart]);

  // Every panel type actually on the wall. Only the ones in use, so a catalogue
  // of seven does not cost seven downloads to draw a wall built from one.
  const panelPartIds = useMemo(
    () => [...new Set(doc.panels.map((p) => p.partId))].sort().join('|'),
    [doc.panels],
  );

  useEffect(() => {
    if (panelPartIds.length === 0) return;
    let live = true;
    const ids = panelPartIds.split('|');
    void Promise.all(ids.map(async (id) => {
      const part = catalog.parts.find((x) => x.id === id);
      return part ? [id, await loadPartMesh(part)] as const : [id, null] as const;
    })).then((pairs) => {
      if (!live) return;
      const next = new Map<string, PartMesh>();
      for (const [id, m] of pairs) if (m !== null) next.set(id, m);
      if (next.size > 0) setPanelMeshes(next);
    });
    return () => { live = false; };
  }, [panelPartIds, catalog]);

  useEffect(() => {
    if (!junctionPart) return;
    let live = true;
    void loadPartMesh(junctionPart).then((m) => {
      if (live && m !== null) setJunctionMesh(m);
    });
    return () => { live = false; };
  }, [junctionPart]);

  useEffect(() => {
    const s = stateRef.current;
    if (!s || !ready) return;
    const theme = readTheme();
    for (const child of [...s.fixingGroup.children]) {
      s.fixingGroup.remove(child);
      const m = child as THREE.Mesh;
      if (m.userData['ownGeometry'] === true) m.geometry?.dispose();
      (m.material as THREE.Material)?.dispose?.();
    }
    if (doc.panels.length === 0) return;

    // The SAME reading of "occupied" the parts list uses: a part pegged into a
    // junction's own socket does not delete the junction (D48). Drawing this
    // from a second rule would put a fixing in the picture that is not on the
    // list, or the reverse.
    const plan = fixingPlan;

    // Lighter than the plate, not darker. These are structure rather than the
    // things you came to hang up, so they must not compete with a placed
    // accessory — but drawn 50% toward black they vanished into a dark theme's
    // plate entirely, which defeats the point of drawing them at all. Lifting
    // them off the plate reads as a part seated in the hole.
    /*
     * The colour these are printed in, when one has been chosen.
     *
     * A wall fixing is a printed part with its own line in the parts list — the
     * countersunk insert, and the four-cell one at the junctions — so both the
     * swatch on that line and the `Parts` default have to reach it. They are the
     * fasteners "already there": the app put them in rather than the user, and
     * that is no reason for them to be the one thing on the wall that ignores
     * the colour chosen for everything of their kind.
     */
    const tone = theme.panel.clone().lerp(new THREE.Color(0xffffff), 0.35);
    const toneFor = (partId: string | undefined): THREE.MeshLambertMaterial => {
      const own = partId === undefined ? undefined : colorOfLine(doc.colors, partId, false);
      return new THREE.MeshLambertMaterial({
        color: own === undefined ? tone : new THREE.Color(own),
      });
    };
    const mat = toneFor(fixingPart?.id);
    const junctionMat = toneFor(junctionPart?.id);
    /*
     * The one you have picked, in the selection colour — the same signal a
     * selected part gets, because it is the same question ("which of these am I
     * about to move or delete?"). A fixing being DRAGGED is drawn picked too:
     * the ghost is the hover highlight the wall already draws under the pointer.
     *
     * Picked beats coloured, for the same reason selected beats coloured on a
     * placed part: while you are holding one, the wall's job is to say which.
     */
    const pickedKey = pickedFixing ? hexKey(pickedFixing) : null;
    const picked = new THREE.MeshLambertMaterial({ color: theme.selected });
    const matFor = (at: Hex, base: THREE.MeshLambertMaterial): THREE.MeshLambertMaterial =>
      pickedKey !== null && hexKey(at) === pickedKey ? picked : base;

    for (const cell of plan.cells) {
      const p = hexToMm(cell);
      const mesh = fixingMesh
        ? new THREE.Mesh(fixingMesh.geometry, matFor(cell, mat))
        : new THREE.Mesh(
            cellPrism(CELL.mouthAcrossFlats / Math.sqrt(3), PANEL_DEPTH),
            matFor(cell, mat),
          );
      // Seated in the cell: the body drops into the hole and the flange sits
      // proud of the front face, which is what the photographs show — and, now
      // that the flange is measured rather than assumed away, what this draws.
      mesh.position.set(p.x, p.y, fixingMesh ? seatedZ(fixingMesh, true) : PANEL_DEPTH / 2);
      mesh.userData['ownGeometry'] = fixingMesh === null;
      s.fixingGroup.add(mesh);
    }

    /**
     * The junction inserts, drawn as the four-cell part they are.
     *
     * Every part in the build is modelled, fastenings included — a fixing you
     * cannot see is one you cannot check, and these are the ones holding the
     * panels to each other. Placed on the centroid of the cells they occupy,
     * which is the same convention a placed multi-cell item uses, and turned by
     * the rotation the planner chose so the diamond lies along the seam it is
     * bridging.
     */
    for (const junction of plan.junctions) {
      let cx = 0;
      let cy = 0;
      for (const c of junction.cells) {
        const p = hexToMm(c);
        cx += p.x;
        cy += p.y;
      }
      cx /= junction.cells.length;
      cy /= junction.cells.length;

      const mesh = junctionMesh
        ? new THREE.Mesh(junctionMesh.geometry, matFor(junction.anchor, junctionMat))
        : new THREE.Mesh(
            cellPrism((CELL.mouthAcrossFlats * 1.6) / Math.sqrt(3), PANEL_DEPTH),
            matFor(junction.anchor, junctionMat),
          );
      mesh.rotation.z = (Math.PI / 3) * junction.rotation;
      mesh.position.set(cx, cy, junctionMesh ? seatedZ(junctionMesh, true) : PANEL_DEPTH / 2);
      mesh.userData['ownGeometry'] = junctionMesh === null;
      s.fixingGroup.add(mesh);
    }
    // `doc` covers `doc.colors` here — this effect takes the whole document —
    // but the fixing PARTS do not, so they are listed: the tone is read off
    // their own parts-list lines.
  }, [doc, catalog, fixingPlan, ready, readTheme, themeTick, fixingMesh, junctionMesh,
      fixingPart, junctionPart, pickedFixing]);

  /*
   * --- obstacles: NOT drawn ------------------------------------------------
   *
   * A blocked zone used to be a red slab standing 5 mm off the wall, the size
   * of the zone, on the argument that you need to see whether a part is about
   * to sit on one. Two things were wrong with that.
   *
   * It is the biggest object on the wall and it is opaque, so it HID what it
   * was pointing at — the cut plates, the edge raised round them, and any part
   * near the zone. The one view where you can check that a border came out
   * clean round a socket was the one view that covered it up.
   *
   * And it says nothing the wall does not already say. The honeycomb is CUT
   * there: the hole is the zone, at exactly its size, and a part cannot be
   * dropped in it because there are no cells. A marker that duplicates an
   * absence is noise on top of the answer.
   *
   * The plan view still draws zones, with their names and sizes, which is where
   * you position them. `obstacleGroup` is kept in the scene so nothing else has
   * to change shape; it simply stays empty.
   */

  // --- the wall photograph -------------------------------------------------

  /**
   * The decoded picture, shared with the plan view through one cache.
   *
   * State rather than a ref because arriving is what has to rebuild the plane:
   * the image loads asynchronously and the effect below has already run once by
   * the time it does.
   */
  const [photoImg, setPhotoImg] = useState<HTMLImageElement | null>(() =>
    doc.photo ? peekWallPhotoImage(doc.photo.id) : null);
  const photoId = doc.photo?.id;

  useEffect(() => {
    if (photoId === undefined) { setPhotoImg(null); return; }
    let live = true;
    setPhotoImg(peekWallPhotoImage(photoId));
    void wallPhotoImage(photoId).then((img) => { if (live) setPhotoImg(img); });
    return () => { live = false; };
  }, [photoId]);

  /**
   * The GPU texture, kept across rebuilds and keyed on the photo it holds.
   *
   * A fresh `THREE.Texture` per rebuild would re-upload a 2048 px photograph to
   * the GPU every time anything about the photo changed — and the thing that
   * changes most is the opacity slider, which fires per frame while it is being
   * dragged. The plane, its geometry and its material are cheap and are rebuilt;
   * the texture is not, so it outlives them and is disposed only when the
   * picture itself goes.
   */
  const photoTexRef = useRef<{ id: string; tex: THREE.Texture } | null>(null);

  useEffect(() => {
    const s = stateRef.current;
    if (!s || !ready) return;
    for (const child of [...s.photoGroup.children]) {
      s.photoGroup.remove(child);
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material)?.dispose?.();
    }

    const photo = doc.photo;
    const held = photoTexRef.current;
    if (held && (!photo || held.id !== photo.id || photoImg === null)) {
      held.tex.dispose();
      photoTexRef.current = null;
    }
    if (!photo || !photo.visible || photoImg === null) return;

    let tex = photoTexRef.current?.tex;
    if (!tex) {
      tex = new THREE.Texture(photoImg);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      photoTexRef.current = { id: photo.id, tex };
    }

    const rect = photoRectMm(photo);
    const centre = photoCentreMm(photo);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(rect.widthMm, rect.heightMm),
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: photo.opacity,
        // Unlit and untone-mapped: a photograph already carries its own light,
        // and running it through the scene's key and fill would shade the room
        // by where the wall's lamps are, which is nonsense.
        toneMapped: false,
        // Visible from behind as well, so orbiting round the back of the wall
        // does not make the picture vanish.
        side: THREE.DoubleSide,
        // Never writes depth. It is a reference laid against the wall, not an
        // object in the room, and writing depth would let a photo standing in
        // front of the plate hide the parts mounted on it from their own
        // transparency sort.
        depthWrite: false,
      }),
    );
    /*
     * Behind the plate, or in front of it — geometrically, not by render order.
     *
     * The plate occupies z 0…PANEL_DEPTH, so 0.6 mm clear of either face puts
     * the photograph unambiguously on one side without z-fighting. Behind, it
     * shows through every open cell, which is the view you place a zone in;
     * in front it covers the honeycomb and the parts still stand through it,
     * because they really are in front of it.
     */
    mesh.position.set(centre.x, centre.y, photo.depth === 'behind' ? -0.6 : PANEL_DEPTH + 0.6);
    /*
     * The turn, about the wall normal.
     *
     * NOT negated, unlike the plan's (D70): this view is y-up in world space
     * exactly as the wall is, so a positive rotation about +z is already
     * counter-clockwise seen from the room — which is the sense the field is
     * stored in. The plan has to flip it because its pixels are y-down; here
     * there is nothing to undo.
     */
    mesh.rotation.z = (photoRotation(photo) * Math.PI) / 180;
    s.photoGroup.add(mesh);
  }, [doc.photo, photoImg, ready]);

  // --- ghost preview ------------------------------------------------------

  const [hover, setHover] = useState<Hex | null>(null);

  useEffect(() => {
    const s = stateRef.current;
    if (!s || !ready) return;
    const theme = readTheme();
    for (const child of [...s.ghostGroup.children]) {
      s.ghostGroup.remove(child);
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material)?.dispose?.();
    }
    if (!drag || !hover) return;

    const cells = ghost3DCells(drag, hover, catalog, doc);
    const part = drag.partId ? partOf(drag.partId) : undefined;
    const depth = part ? partBox(part).depth : 12;
    const mat = new THREE.MeshLambertMaterial({
      color: placementValid ? theme.ok : theme.bad,
      transparent: true,
      opacity: 0.6,
    });
    // The ghost shows CELLS, not the body: while aiming, which holes it lands
    // in is the question, and a solid body would hide the ones underneath it.
    for (const c of cells) {
      const p = hexToMm(c);
      // `cellPrism`, not a bare CylinderGeometry: the ghost has to seat in the
      // cell it is aiming at, and a raw prism lands 30° out on a flat-top wall.
      const geo = cellPrism((CELL.mouthAcrossFlats * 0.96) / Math.sqrt(3), depth);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p.x, p.y, PANEL_DEPTH + depth / 2);
      s.ghostGroup.add(mesh);
    }
  }, [drag, hover, catalog, doc, placementValid, partOf, ready, readTheme, themeTick]);

  /**
   * The cell under the pointer, lit at its FULL size.
   *
   * Drawn at `PITCH` across flats — the whole hexagon out to its corners, the
   * same size `hexCorners` gives the plan view — rather than at the 22 mm mouth.
   * The mouth is the hole; the cell is the hexagon of wall that hole sits in,
   * and that is what "which cell am I pointing at" means. A mouth-sized
   * highlight leaves the webbing between cells dark and reads as a smaller shape
   * floating inside the cell.
   *
   * Suppressed while dragging: the ghost already answers the same question, more
   * precisely, and two overlapping highlights on one cell just muddle it.
   */
  /**
   * The ring a border cuts, which is printed but is not in any panel's cells.
   * Memoised because a hover moves cell to cell and this walks every block.
   */
  const borderCut = useMemo(
    () => borderCutCells(doc.panels, doc.frame),
    [doc.panels, doc.frame],
  );

  useEffect(() => {
    const s = stateRef.current;
    if (!s || !ready) return;
    for (const child of [...s.hoverGroup.children]) {
      s.hoverGroup.remove(child);
      const m = child as THREE.Mesh | THREE.LineSegments;
      // The plate overlay, the cell prism and the part outline are built here
      // and are ours to dispose. The lit BODY is not: it borrows the part's own
      // geometry from meshLibrary's cache, which every placement of that part
      // shares, so disposing it would blank all of them. Flagged rather than
      // inferred — `EdgesGeometry` copies what it needs and this one does not.
      if (m.userData.borrowed !== true) m.geometry?.dispose();
      (m.material as THREE.Material)?.dispose?.();
    }
    if (!hover || drag) return;
    /*
     * Only over the wall itself — lighting a cell in empty space would invite a
     * drop that `checkPlacement` then refuses.
     *
     * ...but the outermost RING of a bordered plate is printed, and it leaves
     * `placedPanelCells` through `omit` exactly as a switch's cells do (D87). So
     * on a bordered wall the whole rim belonged to no panel: point at the edge
     * of the wall — the part of it you are most likely to point at — and nothing
     * lit up at all. The cut ring is asked for by name; a cell a ZONE ate is
     * still nobody's, which is right, because that one really is a hole.
     */
    const onBorder = borderCut.has(hexKey(hover));
    const panel = doc.panels.find((p) =>
      placedPanelCells(p).some((c) => c.q === hover.q && c.r === hover.r)
      || (onBorder && panelCells(p.origin, p.columns, p.rows)
        .some((c) => c.q === hover.q && c.r === hover.r)));
    if (!panel) return;

    const theme = readTheme();
    const light = (opacity: number) => new THREE.MeshBasicMaterial({
      color: theme.hover,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      // Never writes depth: the highlight is a light cast on the wall, not an
      // object, and writing depth would let it occlude a part standing in the
      // same cell.
      depthWrite: false,
    });

    /*
     * The whole PLATE, faintly.
     *
     * A wall is not a continuous honeycomb — it is a set of printed panels, and
     * which one you are pointing at is a real question: it is the thing you
     * print, hang, and count in the parts list. The seams between plates are
     * zig-zags through the grid and are genuinely hard to read face-on, so
     * without this you cannot tell where one plate ends and the next begins.
     *
     * Drawn from the panel's OWN outline — the same `unionOutline` that builds
     * the plate — so it follows the castellated edge exactly rather than
     * approximating it with a rectangle.
     */
    const plateGeo = hoverPlateGeometry(panel, doc);
    if (plateGeo) {
      const plate = new THREE.Mesh(plateGeo, light(0.16));
      // Borrowed from the shape cache, like the part body below.
      plate.userData.borrowed = true;
      const o = hexToMm(panel.origin);
      // A whisker proud of the real plate, or the two z-fight — the geometry is
      // the same triangles, drawn twice.
      plate.position.set(o.x, o.y, 0.15);
      s.hoverGroup.add(plate);
    } else {
      // The generator refused this shape, so fall back to the drawn outline. It
      // ends a ring short on a bordered plate, which is the whole reason the
      // real geometry is preferred — but a highlight that is slightly small
      // beats no highlight.
      const outline = unionOutline(placedPanelCells(panel));
      if (outline.length >= 3) {
        const shape = new THREE.Shape(outline);
        const plate = new THREE.Mesh(
          new THREE.ExtrudeGeometry([shape], { depth: 0.4, bevelEnabled: false }),
          light(0.16),
        );
        plate.position.set(0, 0, PANEL_DEPTH + 0.2);
        s.hoverGroup.add(plate);
      }
    }

    /*
     * A PLACED PART under the pointer is outlined whole.
     *
     * A part is the unit you print, order and move — a 4-cell junction insert is
     * one object, not four cells that happen to be adjacent — so pointing at any
     * of its cells has to pick up the whole of it. Lighting only the cell under
     * the pointer said nothing about where the part ends, which for a fastener
     * spanning a seam is the thing you actually want to see.
     *
     * Drawn as edges of the part's OWN geometry, positioned and turned exactly as
     * the body is, so the outline is the silhouette of the real mesh rather than
     * a box around it. `EdgesGeometry`'s threshold keeps it to the shape's
     * creases instead of every triangle.
     */
    const hitId = itemIndex.get(hexKey(hover));
    const item = hitId ? doc.items.find((i) => i.id === hitId) : undefined;
    const part = item ? partOf(item.partId) : undefined;

    if (item && part) {
      const cells = itemCells(item, catalog);
      // The same centring as the body above, through the same function: an
      // outline that is centred differently from the thing it outlines is worse
      // than no outline.
      const { x: cx, y: cy } = cellsCentreMm(cells);

      const loaded = meshes.current.get(item.partId);
      const { depth, w, h } = partBox(part);
      const geo = loaded
        ? loaded.geometry
        : new THREE.BoxGeometry(w, h, depth);
      const z = loaded
        ? seatedZ(loaded, part.type === 'insert' || part.type === 'fastener')
        : PANEL_DEPTH + depth / 2;
      const spin = (Math.PI / 3) * item.rotation;

      /*
       * The WHOLE part, lit — not just its creases.
       *
       * `EdgesGeometry` at a 25° threshold draws the shape's hard edges and
       * nothing else, which on a box reads as the whole object and on anything
       * organic reads as a few lines floating in space: a hook highlighted that
       * way showed a couple of strokes rather than a hook. What you want to see
       * when you point at a part is the part.
       *
       * So the body is drawn too, in the same additive accent the plate and the
       * cell use — a light cast on the thing, not a repaint of it, which is the
       * same rule that keeps a lit PLATE showing its own cells (D92). The edges
       * stay on top of it: additive light flattens the form, and the creases are
       * what put the shape back.
       *
       * `depthTest: false` on both, so a part behind the wall or behind another
       * part still shows whole. That is the point — a fastener spanning a seam
       * is exactly the case where you cannot otherwise tell where it ends.
       */
      const body = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: theme.hover,
        transparent: true,
        opacity: 0.28,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      }));
      // Borrowed from meshLibrary whenever the real mesh has loaded; the
      // placeholder box is ours. The cleanup above reads this.
      body.userData.borrowed = loaded !== undefined;
      body.position.set(cx, cy, z);
      body.rotation.z = spin;
      body.renderOrder = 998;
      s.hoverGroup.add(body);

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo, 25),
        new THREE.LineBasicMaterial({
          color: theme.hover,
          transparent: true,
          opacity: 0.95,
          depthTest: false,
        }),
      );
      // The same seating and spin the body got, from the same two values — an
      // outline that sits differently from the thing it outlines is worse than
      // no outline, and an insert sits 7.5 mm into the wall.
      edges.position.set(cx, cy, z);
      edges.rotation.z = spin;
      // Drawn last and over everything, so an outline round a part standing 40 mm
      // off the wall is not hidden by the part itself.
      edges.renderOrder = 999;
      s.hoverGroup.add(edges);
      // `geo` is NOT disposed here any more: the body above is still using it,
      // and the cleanup at the top of this effect owns it now.
      return;
    }

    // ...otherwise the individual cell, brighter, on top of the plate. The two
    // together answer the two questions at once: which plate, and which hole.
    const p = hexToMm(hover);
    const cell = new THREE.Mesh(cellPrism(PITCH / Math.sqrt(3), 0.6), light(0.5));
    // Just proud of the plate's front face, so it reads as the cell lighting up
    // rather than as an object standing on the wall.
    cell.position.set(p.x, p.y, PANEL_DEPTH + 0.6);
    s.hoverGroup.add(cell);
  // `doc.frame` and `doc.obstacles` are read through `hoverPlateGeometry`, and
  // half a feature is what leaving one out looks like (D92, D94).
  }, [hover, drag, doc, doc.panels, doc.frame, doc.obstacles, doc.items, borderCut,
      itemIndex, catalog, partOf, meshTick, ready, readTheme, themeTick]);

  // --- render loop --------------------------------------------------------

  useEffect(() => {
    if (!ready) return;
    const loop = () => {
      const s = stateRef.current;
      if (!s) return;
      const o = orbitRef.current;
      const target = new THREE.Vector3(
        wallCentre.x + o.tx, wallCentre.y + o.ty, 0,
      );
      s.camera.position.set(
        target.x + o.dist * Math.sin(o.phi) * Math.sin(o.theta),
        target.y + o.dist * Math.cos(o.phi),
        target.z + o.dist * Math.sin(o.phi) * Math.cos(o.theta),
      );
      s.camera.up.set(0, 1, 0);
      s.camera.lookAt(target);
      s.renderer.render(s.scene, s.camera);
      s.frame = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(stateRef.current?.frame ?? 0);
  }, [ready, wallCentre]);

  // --- picking ------------------------------------------------------------

  const cellAt = useCallback((clientX: number, clientY: number): Hex | null => {
    const s = stateRef.current;
    const host = hostRef.current;
    if (!s || !host) return null;
    const r = host.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    s.raycaster.setFromCamera(ndc, s.camera);
    const hit = new THREE.Vector3();
    if (!s.raycaster.ray.intersectPlane(s.plane, hit)) return null;
    // World mm -> nearest cell, through `mmToHex` itself.
    //
    // This used to inline its own copy of the inverse embedding —
    // `r = y/20.438; q = x/PITCH - r/2` — which was the pointy-top form and
    // silently outlived the frame turn (D35), so every hit in this view landed
    // on the wrong cell: the hover lit a hexagon a few cells up and to the left
    // of the pointer, and a DROP went there too.
    //
    // Delegating rather than re-deriving is the actual fix. A second copy of a
    // rule is a second thing to remember to turn, and this one was missed
    // precisely because it did not mention `mmToHex` anywhere.
    return mmToHex({ x: hit.x, y: hit.y });
  }, []);

  // --- pointer handling ---------------------------------------------------

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !ready) return;

    const down = (e: PointerEvent) => {
      // The toolbar lives inside the host so it can float over the wall, which
      // means its buttons' pointerdown bubbles to here. Capturing the pointer
      // then redirected every later pointer event to the host, and the button
      // never got its click: Fit and Front looked dead to a mouse while working
      // perfectly when called from code.
      if ((e.target as Element | null)?.closest?.('.wall3d__tools')) return;
      host.setPointerCapture?.(e.pointerId);
      if (e.button === 1 || e.altKey || e.shiftKey) {
        panRef.current = { x: e.clientX, y: e.clientY, mode: e.shiftKey ? 'pan' : 'orbit' };
        return;
      }
      if (e.button === 2) {
        panRef.current = { x: e.clientX, y: e.clientY, mode: 'orbit' };
        return;
      }
      if (e.button !== 0) return;
      const cell = cellAt(e.clientX, e.clientY);
      if (!cell) return;
      const hitId = itemIndex.get(hexKey(cell));
      // A part wins the cell: it is in front of the fixing and it is what the
      // pointer is over. The fixing under an accessory is reachable by moving
      // the accessory, which is the same rule the wall uses everywhere else.
      const fixing = hitId === undefined ? fixingIndex.get(hexKey(cell)) : undefined;
      pressRef.current = {
        x: e.clientX, y: e.clientY, cell, itemId: hitId, fixing, moved: false,
      };
    };

    const move = (e: PointerEvent) => {
      const pan = panRef.current;
      if (pan) {
        const dx = e.clientX - pan.x;
        const dy = e.clientY - pan.y;
        pan.x = e.clientX; pan.y = e.clientY;
        const o = orbitRef.current;
        if (pan.mode === 'orbit') {
          o.theta -= dx * 0.006;
          o.phi = Math.min(Math.PI - 0.15, Math.max(0.15, o.phi - dy * 0.006));
        } else {
          o.tx -= dx * o.dist * 0.0012;
          o.ty += dy * o.dist * 0.0012;
        }
        return;
      }

      if (dragRef.current) {
        const cell = cellAt(e.clientX, e.clientY);
        if (cell) { setHover(cell); onDragMove(cell); }
        return;
      }

      // A fixing already in hand: the hover highlight IS the ghost, so there is
      // nothing else to draw.
      if (fixingDragRef.current) {
        setHover(cellAt(e.clientX, e.clientY));
        return;
      }

      const press = pressRef.current;
      if (!press) {
        setHover(cellAt(e.clientX, e.clientY));
        return;
      }

      /*
       * Past the threshold on a fixing: pick it up. A JUNCTION is not picked up
       * — it is a four-cell insert whose whole job is to straddle the corner
       * where the plates meet, so it has nowhere else to be (HSW-SPEC §4). The
       * press stands, so releasing still selects it and Delete still removes it.
       */
      if (press.itemId === undefined && press.fixing && onMoveFixing) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= 5) return;
        if (press.fixing.junction) return;
        fixingDragRef.current = { from: press.fixing.at, junction: false };
        // The parent's `pickedFixing` is what DRAWS it as held — the ref is the
        // only copy the release handler can trust (D58).
        onPickFixing?.(press.fixing.at);
        setHover(cellAt(e.clientX, e.clientY));
        return;
      }

      if (press.itemId === undefined) {
        // Plain hover, nothing being dragged. The 3D view used to track `hover`
        // ONLY during a drag, so the wall gave no feedback about which cell the
        // pointer was over until you were already carrying something.
        setHover(cellAt(e.clientX, e.clientY));
        return;
      }
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= 5) return;
      const anchor = doc.items.find((i) => i.id === press.itemId);
      const grab = anchor
        ? { q: press.cell.q - anchor.at.q, r: press.cell.r - anchor.at.r }
        : { q: 0, r: 0 };
      const ids = selection.includes(press.itemId) ? [...selection] : [press.itemId];
      pressRef.current = null;
      onStartItemDrag(ids, grab);
    };

    const leave = () => setHover(null);

    const up = (e: PointerEvent) => {
      if (panRef.current) { panRef.current = null; return; }

      const moving = fixingDragRef.current;
      if (moving) {
        // Cleared FIRST, whatever happens next: a refused move must not leave
        // the view holding a fixing that is still on the wall.
        fixingDragRef.current = null;
        setHover(null);
        pressRef.current = null;
        const cell = cellAt(e.clientX, e.clientY);
        if (cell) onMoveFixing?.(moving.from, cell);
        return;
      }

      if (dragRef.current) {
        const cell = cellAt(e.clientX, e.clientY);
        setHover(null);
        if (cell) onDrop(cell); else onDragCancel();
        pressRef.current = null;
        return;
      }
      const press = pressRef.current;
      if (press) {
        if (press.itemId === undefined && press.fixing) {
          // Picking a fixing clears the item selection, and the other way round:
          // Delete has to mean one thing, and two live selections would make it
          // mean whichever the handler looked at first.
          onSelect([], false);
          onPickFixing?.(press.fixing.at);
        } else {
          onSelect(press.itemId === undefined ? [] : [press.itemId],
            e.metaKey || e.ctrlKey);
          onPickFixing?.(null);
        }
      }
      pressRef.current = null;
    };

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const o = orbitRef.current;
      o.dist = Math.min(30000, Math.max(120, o.dist * Math.exp(e.deltaY * 0.0012)));
    };

    const ctx = (e: Event) => e.preventDefault();

    host.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    // On the HOST, not the window: `pointermove` is bound to the window so a
    // drag survives leaving the canvas, but the highlight must not — a hexagon
    // left lit while the pointer is over the parts list is a lie about where
    // the pointer is.
    host.addEventListener('pointerleave', leave);
    host.addEventListener('wheel', wheel, { passive: false });
    host.addEventListener('contextmenu', ctx);
    return () => {
      host.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      host.removeEventListener('pointerleave', leave);
      host.removeEventListener('wheel', wheel);
      host.removeEventListener('contextmenu', ctx);
    };
  }, [ready, cellAt, itemIndex, fixingIndex, doc.items, selection, dragRef,
      onDragMove, onDrop, onDragCancel, onSelect, onStartItemDrag,
      onPickFixing, onMoveFixing]);

  return (
    <div className="wall3d" ref={hostRef}>
      <div className="wall3d__tools">
        <button type="button" onClick={fit} title="Frame the wall">Fit</button>
        <button
          type="button"
          onClick={() => { orbitRef.current.phi = 1.5708; orbitRef.current.theta = 0; }}
          title="Look straight on"
        >
          Front
        </button>
      </div>
      {/* The hint answers the question you have RIGHT NOW. Holding a fixing,
          that is what to do with it — including the one thing it refuses, which
          otherwise reads as a broken drag. */}
      <div className="wall3d__hint">
        {pickedFixing === null ? (
          'drag to place · right-drag orbit · shift-drag pan · wheel zoom · R rotate · Ctrl+D duplicate'
        ) : fixingIndex.get(hexKey(pickedFixing))?.junction ? (
          'wall fixing picked · Delete removes it · it bridges the plates, so it does not move'
        ) : (
          'wall fixing picked · drag to move it · Delete removes it · Escape lets go'
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/*
 * `hexRound3` lived here — a third copy of the cube rounding, its own comment
 * claiming "shared semantics with hex.ts so both views agree". It is gone, and
 * with it the inlined inverse embedding that used it. `cellAt` calls `mmToHex`.
 *
 * The copy is what caused the bug: the pointy-top inverse survived the frame
 * turn in this file because nothing in it named `mmToHex`, so every hit in the
 * 3D view landed several cells from the pointer. A rule with two
 * implementations has two chances to be wrong and one place you will look.
 */

export function ghost3DCells(
  drag: Drag3D, hover: Hex, catalog: Catalog, doc: LayoutDoc,
): Hex[] {
  const anchor = { q: hover.q - drag.grabOffset.q, r: hover.r - drag.grabOffset.r };
  if (drag.partId !== undefined) {
    const part = catalog.parts.find((p) => p.id === drag.partId);
    if (!part) return [];
    // `partCells`, not `placeFootprint` on the raw footprint: the two differ by
    // the part's ANCHOR, and the ghost that skipped it drew the landing zone a
    // cell or two from where the part actually lands. Invisible while every
    // shipped anchor was the origin, and immediate once a hand-drawn footprint
    // left the middle cell out (D46) and `anchorOf` moved the anchor.
    return partCells(part, anchor, drag.rotation);
  }
  const ids = new Set(drag.itemIds ?? []);
  const members = doc.items.filter((i) => ids.has(i.id));
  const lead = members[0];
  if (!lead) return [];
  const delta = { q: anchor.q - lead.at.q, r: anchor.r - lead.at.r };
  const out: Hex[] = [];
  for (const m of members) {
    const part = catalog.parts.find((p) => p.id === m.partId);
    if (!part) continue;
    out.push(...partCells(part, { q: m.at.q + delta.q, r: m.at.r + delta.r }, m.rotation));
  }
  return out;
}
