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
import { PANEL_DEPTH, PITCH } from '../core/constants';
import { hexKey, hexToMm, panelCells, placeFootprint } from '../core/hex';
import type { Catalog, CatalogPart, Hex, LayoutDoc, Rotation } from '../core/types';
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

/** Hexagon outline in the XY plane, given its across-flats width. */
function hexShape(acrossFlats: number): THREE.Shape {
  const R = acrossFlats / Math.sqrt(3);
  const s = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 90);
    const x = R * Math.cos(a);
    const y = R * Math.sin(a);
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}

/**
 * One panel as a single extruded solid: the plate, with a hexagonal hole
 * through every cell.
 *
 * Built by unioning per-cell outer hexagons and punching per-cell holes. The
 * outer hexagons of neighbouring cells share edges exactly (they are the
 * lattice's own unit cells), so the result reads as one continuous plate with
 * the correct zig-zag boundary rather than as a rectangle.
 */
function buildPanelGeometry(columns: number, rows: number): THREE.BufferGeometry {
  const cells = panelCells({ q: 0, r: 0 }, columns, rows);
  const shapes: THREE.Shape[] = [];
  for (const c of cells) {
    const p = hexToMm(c);
    const outer = hexShape(PITCH);
    outer.getPoints(); // force curve cache before translating points
    const moved = new THREE.Shape(
      outer.getPoints(6).map((v) => new THREE.Vector2(v.x + p.x, v.y + p.y)),
    );
    const holePts = hexShape(22.0)
      .getPoints(6)
      .map((v) => new THREE.Vector2(v.x + p.x, v.y + p.y));
    moved.holes.push(new THREE.Path(holePts));
    shapes.push(moved);
  }
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth: PANEL_DEPTH,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geo.computeVertexNormals();
  return geo;
}

/** Extent of a part along the wall normal, from its measured bounding box. */
function projection(part: CatalogPart): number {
  const [a, b, c] = part.bboxMm;
  // The mating face is the one that sits against the wall, so the part sticks
  // out by whichever dimension is NOT in the wall plane. For a wall-clip that
  // is the 10 mm insert height; for a hook it is the long axis.
  const dims = [a ?? 10, b ?? 10, c ?? 10].sort((x, y) => x - y);
  return Math.max(6, dims[2] ?? 10);
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
    frame: number;
  } | null>(null);

  const [ready, setReady] = useState(false);
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
    scene.add(panelGroup, itemGroup, ghostGroup);

    stateRef.current = {
      renderer, scene, camera,
      raycaster: new THREE.Raycaster(),
      // Picking happens on the panel's FRONT face, which is where the user is
      // pointing — not on z = 0, which would put the cursor behind the plate.
      plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -PANEL_DEPTH),
      panelGroup, itemGroup, ghostGroup, frame: 0,
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

    // One geometry per distinct size, instanced across every panel using it.
    const bySize = new Map<string, { columns: number; rows: number; origins: Hex[] }>();
    for (const p of doc.panels) {
      const k = `${p.columns}x${p.rows}`;
      const e = bySize.get(k) ?? { columns: p.columns, rows: p.rows, origins: [] };
      e.origins.push(p.origin);
      bySize.set(k, e);
    }

    const material = new THREE.MeshLambertMaterial({ color: theme.panel });
    for (const { columns, rows, origins } of bySize.values()) {
      const geo = buildPanelGeometry(columns, rows);
      const mesh = new THREE.InstancedMesh(geo, material, origins.length);
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
  }, [doc.panels, ready, readTheme, themeTick]);

  // --- build the placed items --------------------------------------------

  useEffect(() => {
    const s = stateRef.current;
    if (!s || !ready) return;
    const theme = readTheme();
    const sel = new Set(selection);

    for (const child of [...s.itemGroup.children]) {
      s.itemGroup.remove(child);
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material)?.dispose?.();
    }

    for (const it of doc.items) {
      const part = partOf(it.partId);
      if (!part) continue;
      const cells = itemCells(it, catalog);
      if (cells.length === 0) continue;
      const depth = projection(part);
      const colour = sel.has(it.id) ? theme.selected : theme.item;
      const mat = new THREE.MeshLambertMaterial({ color: colour });

      // One block per occupied cell, standing proud of the panel face. Drawing
      // per cell (rather than one box over the bounding area) keeps a
      // multi-cell part honest about which cells it actually uses.
      for (const c of cells) {
        const p = hexToMm(c);
        const geo = new THREE.CylinderGeometry(
          (PITCH * 0.92) / Math.sqrt(3), (PITCH * 0.92) / Math.sqrt(3), depth, 6,
        );
        geo.rotateX(Math.PI / 2);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(p.x, p.y, PANEL_DEPTH + depth / 2);
        mesh.userData['itemId'] = it.id;
        s.itemGroup.add(mesh);
      }
    }
  }, [doc.items, selection, catalog, partOf, ready, readTheme, themeTick]);

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
    const depth = part ? projection(part) : 20;
    const mat = new THREE.MeshLambertMaterial({
      color: placementValid ? theme.ok : theme.bad,
      transparent: true,
      opacity: 0.65,
    });
    for (const c of cells) {
      const p = hexToMm(c);
      const geo = new THREE.CylinderGeometry(
        (PITCH * 0.92) / Math.sqrt(3), (PITCH * 0.92) / Math.sqrt(3), depth, 6,
      );
      geo.rotateX(Math.PI / 2);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p.x, p.y, PANEL_DEPTH + depth / 2);
      s.ghostGroup.add(mesh);
    }
  }, [drag, hover, catalog, doc, placementValid, partOf, ready, readTheme, themeTick]);

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
    // World mm -> nearest cell. Same rounding as the 2D path, so a drop lands
    // in the same place whichever view you are using.
    const rr = hit.y / 20.438;
    const qq = hit.x / PITCH - rr / 2;
    return hexRound3(qq, rr);
  }, []);

  // --- pointer handling ---------------------------------------------------

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !ready) return;

    const down = (e: PointerEvent) => {
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
      if (!press || press.itemId === undefined) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= 5) return;
      const anchor = doc.items.find((i) => i.id === press.itemId);
      const grab = anchor
        ? { q: press.cell.q - anchor.at.q, r: press.cell.r - anchor.at.r }
        : { q: 0, r: 0 };
      const ids = selection.includes(press.itemId) ? [...selection] : [press.itemId];
      pressRef.current = null;
      onStartItemDrag(ids, grab);
    };

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
    host.addEventListener('wheel', wheel, { passive: false });
    host.addEventListener('contextmenu', ctx);
    return () => {
      host.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
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

/** Cube rounding, shared semantics with hex.ts so both views agree. */
function hexRound3(qf: number, rf: number): Hex {
  const xf = qf;
  const zf = rf;
  const yf = -qf - rf;
  let x = Math.round(xf);
  let y = Math.round(yf);
  let z = Math.round(zf);
  const dx = Math.abs(x - xf);
  const dy = Math.abs(y - yf);
  const dz = Math.abs(z - zf);
  if (dx > dy && dx > dz) x = -y - z;
  else if (dy > dz) y = -x - z;
  else z = -x - y;
  return { q: x === 0 ? 0 : x, r: z === 0 ? 0 : z };
}

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
