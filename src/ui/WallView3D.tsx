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

import { itemCells } from '../core/bom';
import { fixingsFor, JUNCTION_FIXING_ID } from '../core/fixings';
import { CELL, PANEL_DEPTH, PITCH } from '../core/constants';
import {
  cellsBoundsMm, hexKey, hexToMm, mmToHex, panelCells, placedPanelCells, placeFootprint,
} from '../core/hex';
import type { Catalog, CatalogPart, Hex, LayoutDoc, Rotation } from '../core/types';
import { loadPartMesh, type PartMesh } from './meshLibrary';
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

  const back = make(CELL.throatAcrossFlats, PANEL_DEPTH - CELL.mouthDepth);
  const front = make(CELL.mouthAcrossFlats, CELL.mouthDepth);
  front.translate(0, 0, PANEL_DEPTH - CELL.mouthDepth);
  return { back, front };
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
  const pressRef = useRef<{ x: number; y: number; cell: Hex; itemId?: string; moved: boolean } | null>(null);
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

  // --- scene setup --------------------------------------------------------

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
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
    scene.add(panelGroup, itemGroup, ghostGroup, hoverGroup, obstacleGroup, fixingGroup);

    stateRef.current = {
      renderer, scene, camera,
      raycaster: new THREE.Raycaster(),
      // Picking happens on the panel's FRONT face, which is where the user is
      // pointing — not on z = 0, which would put the cursor behind the plate.
      plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -PANEL_DEPTH),
      panelGroup, itemGroup, ghostGroup, hoverGroup, obstacleGroup, fixingGroup, frame: 0,
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
    s.scene.background = theme.bg;

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
      { partId: string; columns: number; rows: number; omit: Hex[]; origins: Hex[] }
    >();
    for (const p of doc.panels) {
      const cut = (p.omit ?? [])
        .map((c) => hexKey({ q: c.q - p.origin.q, r: c.r - p.origin.r }))
        .sort()
        .join(' ');
      // Keyed on the PART as well as the shape: two panel types can share a
      // cell block and still be different plates, and each has its own mesh.
      const k = `${p.partId}|${p.columns}x${p.rows}|${cut}`;
      const e = bySize.get(k) ?? {
        partId: p.partId,
        columns: p.columns,
        rows: p.rows,
        omit: (p.omit ?? []).map((c) => ({ q: c.q - p.origin.q, r: c.r - p.origin.r })),
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

    for (const { partId, columns, rows, omit, origins } of bySize.values()) {
      /*
       * The real plate, when there is one AND this is a stock plate.
       *
       * `omit` is the gate, and it is not an optimisation: a panel with cells
       * left out is a CUSTOM panel generated from the OpenSCAD customiser, not
       * the shipped STL any more (see `src/core/customiser.ts`). Drawing the
       * stock mesh for it would show a plate with no hole where the light
       * switch goes, which is precisely the thing the customiser exists to cut.
       */
      const real = omit.length === 0 ? panelMeshes.get(partId) : undefined;

      if (real) {
        // The mesh is centred on its own bounding box; the cell block is not
        // centred on the ORIGIN cell. Line the two up by their centres, which
        // works because a plate's margins are equal on opposite sides, so its
        // cells really are centred within it (HSW-SPEC §4).
        const block = cellsBoundsMm(panelCells({ q: 0, r: 0 }, columns, rows));
        const cx = (block.minX + block.maxX) / 2;
        const cy = (block.minY + block.maxY) / 2;
        const mesh = new THREE.InstancedMesh(real.geometry, faceMat, origins.length);
        const m4 = new THREE.Matrix4();
        origins.forEach((o, i) => {
          const p = hexToMm(o);
          m4.makeTranslation(p.x + cx, p.y + cy, 0);
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

      const { back, front } = buildPanelGeometry(columns, rows, omit);
      for (const [geo, mat] of [[back, bodyMat], [front, faceMat]] as const) {
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
  }, [doc.panels, panelMeshes, ready, readTheme, themeTick]);

  // --- build the placed items --------------------------------------------

  /**
   * Bumped when a part's real mesh finishes loading, to rebuild the item group.
   *
   * Loading is asynchronous and per part id, so the wall draws immediately with
   * boxes and each box is replaced by the real shape as its STL arrives. A part
   * that never arrives keeps its box, which is why the box code below stays.
   */
  const [meshTick, setMeshTick] = useState(0);
  const meshes = useRef(new Map<string, PartMesh | null>());

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
      const colour = sel.has(it.id) ? theme.selected : theme.item;
      const mat = new THREE.MeshLambertMaterial({ color: colour });

      // The body: the part's own mesh where we have it, otherwise a box at its
      // measured size, standing proud of the face.
      let cx = 0;
      let cy = 0;
      for (const c of cells) {
        const p = hexToMm(c);
        cx += p.x;
        cy += p.y;
      }
      cx /= cells.length;
      cy /= cells.length;

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
      body.position.set(cx, cy, loaded ? PANEL_DEPTH : PANEL_DEPTH + depth / 2);
      const fitting = part.type === 'insert' || part.type === 'fastener';
      // No seat correction: a mesh from a file is drawn flat-top and the wall
      // is now flat-top too, so it lands in its hole unturned (D35).
      void fitting;
      body.rotation.z = (Math.PI / 3) * it.rotation;
      body.userData['itemId'] = it.id;
      body.userData['ownGeometry'] = loaded === null || loaded === undefined;
      s.itemGroup.add(body);

      // A thin collar in each occupied cell, so a multi-cell part still shows
      // WHICH cells it uses — the body alone would hide that.
      for (const c of cells) {
        const p = hexToMm(c);
        const collar = new THREE.Mesh(
          cellPrism((CELL.mouthAcrossFlats * 0.96) / Math.sqrt(3), CELL.mouthDepth * 1.2),
          mat,
        );
        collar.position.set(p.x, p.y, PANEL_DEPTH - CELL.mouthDepth * 0.4);
        collar.userData['itemId'] = it.id;
        s.itemGroup.add(collar);
      }
    }
  }, [doc.items, selection, catalog, partOf, ready, readTheme, themeTick, meshTick]);

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

    const occupied = new Set<string>();
    for (const it of doc.items) for (const c of itemCells(it, catalog)) occupied.add(hexKey(c));
    const plan = fixingsFor(doc, undefined, occupied);

    // Lighter than the plate, not darker. These are structure rather than the
    // things you came to hang up, so they must not compete with a placed
    // accessory — but drawn 50% toward black they vanished into a dark theme's
    // plate entirely, which defeats the point of drawing them at all. Lifting
    // them off the plate reads as a part seated in the hole.
    const mat = new THREE.MeshLambertMaterial({
      color: theme.panel.clone().lerp(new THREE.Color(0xffffff), 0.35),
    });
    for (const cell of plan.cells) {
      const p = hexToMm(cell);
      const mesh = fixingMesh
        ? new THREE.Mesh(fixingMesh.geometry, mat)
        : new THREE.Mesh(cellPrism(CELL.mouthAcrossFlats / Math.sqrt(3), PANEL_DEPTH), mat);
      // Seated in the cell: the insert drops in from behind and its flange sits
      // proud of the front face, which is what the photographs show.
      mesh.position.set(p.x, p.y, fixingMesh ? PANEL_DEPTH - fixingMesh.depthMm : PANEL_DEPTH / 2);
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
        ? new THREE.Mesh(junctionMesh.geometry, mat)
        : new THREE.Mesh(cellPrism((CELL.mouthAcrossFlats * 1.6) / Math.sqrt(3), PANEL_DEPTH), mat);
      mesh.rotation.z = (Math.PI / 3) * junction.rotation;
      mesh.position.set(
        cx, cy,
        junctionMesh ? PANEL_DEPTH - junctionMesh.depthMm : PANEL_DEPTH / 2,
      );
      mesh.userData['ownGeometry'] = junctionMesh === null;
      s.fixingGroup.add(mesh);
    }
  }, [doc, catalog, ready, readTheme, themeTick, fixingMesh, junctionMesh]);

  // --- obstacles ----------------------------------------------------------

  /**
   * Switches and sockets, drawn as what they are: a plate standing off the
   * wall where the honeycomb cannot go. Shown in the danger colour because the
   * one thing you need to see is whether a part is about to sit on top of one.
   */
  useEffect(() => {
    const s = stateRef.current;
    if (!s || !ready) return;
    const theme = readTheme();
    for (const child of [...s.obstacleGroup.children]) {
      s.obstacleGroup.remove(child);
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material)?.dispose?.();
    }
    for (const o of doc.obstacles ?? []) {
      const mat = new THREE.MeshLambertMaterial({
        color: theme.bad, transparent: true, opacity: 0.75,
      });
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(Math.max(1, o.widthMm), Math.max(1, o.heightMm), 10),
        mat,
      );
      box.position.set(o.xMm + o.widthMm / 2, o.yMm + o.heightMm / 2, PANEL_DEPTH / 2 + 5);
      s.obstacleGroup.add(box);
    }
  }, [doc.obstacles, ready, readTheme, themeTick]);

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
  useEffect(() => {
    const s = stateRef.current;
    if (!s || !ready) return;
    for (const child of [...s.hoverGroup.children]) {
      s.hoverGroup.remove(child);
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material)?.dispose?.();
    }
    if (!hover || drag) return;
    // Only over the wall itself — lighting a cell in empty space would invite a
    // drop that `checkPlacement` then refuses.
    const panel = doc.panels.find((p) =>
      placedPanelCells(p).some((c) => c.q === hover.q && c.r === hover.r));
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

    // ...and the individual cell, brighter, on top of it. Both together answer
    // the two questions at once: which plate, and which hole in it.
    const p = hexToMm(hover);
    const cell = new THREE.Mesh(cellPrism(PITCH / Math.sqrt(3), 0.6), light(0.5));
    // Just proud of the plate's front face, so it reads as the cell lighting up
    // rather than as an object standing on the wall.
    cell.position.set(p.x, p.y, PANEL_DEPTH + 0.6);
    s.hoverGroup.add(cell);
  }, [hover, drag, doc.panels, ready, readTheme, themeTick]);

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
      pressRef.current = { x: e.clientX, y: e.clientY, cell, itemId: hitId, moved: false };
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

      const press = pressRef.current;
      if (!press || press.itemId === undefined) {
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
      if (dragRef.current) {
        const cell = cellAt(e.clientX, e.clientY);
        setHover(null);
        if (cell) onDrop(cell); else onDragCancel();
        pressRef.current = null;
        return;
      }
      const press = pressRef.current;
      if (press) {
        onSelect(press.itemId === undefined ? [] : [press.itemId],
          e.metaKey || e.ctrlKey);
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
  }, [ready, cellAt, itemIndex, doc.items, selection, dragRef,
      onDragMove, onDrop, onDragCancel, onSelect, onStartItemDrag]);

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
      <div className="wall3d__hint">
        drag to place · right-drag orbit · shift-drag pan · wheel zoom · R rotate · Ctrl+D duplicate
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
    return placeFootprint(part.footprint, anchor, drag.rotation);
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
    out.push(...placeFootprint(part.footprint,
      { q: m.at.q + delta.q, r: m.at.r + delta.r }, m.rotation));
  }
  return out;
}
