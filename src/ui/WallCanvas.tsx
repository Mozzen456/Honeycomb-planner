/**
 * The wall: canvas rendering, hit testing, and direct manipulation.
 *
 * Canvas rather than SVG because a 2400 x 1200 wall is ~5,900 cells; as DOM
 * that is 5,900 nodes re-laid-out on every drag frame. Here the whole wall is
 * one draw call and hit testing is arithmetic (mmToHex) rather than a DOM query.
 *
 * Colours come from the token layer via getComputedStyle, so the canvas follows
 * the theme instead of hardcoding a second palette that drifts from the CSS one.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { MARGIN_X, MARGIN_Y, PITCH, ROW_STEP } from '../core/constants';
import {
  edgeCorners,
  hexCorners,
  hexKey,
  hexToMm,
  keyToHex,
  mmToHex,
  panelCells,
  placedPanelCells,
  type Point,
} from '../core/hex';
import { itemCells } from '../core/bom';
import {
  formatMm,
  handlePoint,
  measure,
  resizeZone,
  SNAP_RADIUS_MM,
  snapPoint,
  zoneFromDrag,
  zoneHit,
  zoneParts,
  moveZone,
  withZonePart,
  MIN_ZONE_MM,
  ZONE_HANDLES,
  type Snap,
} from '../core/measure';
import { assemblyBlockCells, borderSpecFor, frameIsOn, NO_WALL_FRAME } from '../core/panelModel';
import {
  borderPolygons, DEFAULT_BORDER_MM, MAX_BORDER_MM, MIN_BORDER_MM, plateEdgeShapes,
} from '../core/honeycomb';
import { MAX_WALL_MM } from '../core/store';
import { NumberField } from './NumberField';
import { obstacleRects } from '../core/obstacles';
import { partCells } from '../core/store';
import type {
  Catalog, Hex, LayoutDoc, Obstacle, PlacedItem, Rotation, WallFrame,
} from '../core/types';
import './WallCanvas.css';

/**
 * What the pointer does on the plan.
 *
 * Modal rather than modifier-based because two of the three are DRAGS on empty
 * wall, and a marquee, a measurement and a new zone cannot all be "drag on empty
 * wall at once". The mode is shown, and Escape always returns to Select.
 */
export type PlanTool = 'select' | 'measure' | 'zone';

export interface DragPayload {
  /** Dragging a new part from the catalogue. */
  partId?: string;
  /** Dragging existing items already on the wall. */
  itemIds?: string[];
  rotation: Rotation;
  /** Cursor offset within the footprint, so the part does not jump on grab. */
  grabOffset: Hex;
}

export interface WallCanvasProps {
  doc: LayoutDoc;
  catalog: Catalog;
  selection: readonly string[];
  drag: DragPayload | null;
  /**
   * The same drag, written synchronously when the gesture starts.
   *
   * `drag` arrives via state, so it is only visible after a render. A pointer
   * can move (and release) before that render lands — every synthetic drag
   * does, and a fast human flick does too — and the first move would be
   * dropped, or the whole gesture lost. The ref lets the window handlers see
   * the drag on the very next event.
   */
  dragRef: { current: DragPayload | null };
  /** Cells that failed the last placement check, highlighted in red. */
  invalidCells?: readonly Hex[];
  onDragMove: (cell: Hex) => void;
  onDrop: (cell: Hex) => void;
  onDragCancel: () => void;
  onSelect: (ids: string[], additive: boolean) => void;
  onStartItemDrag: (itemIds: string[], grabOffset: Hex) => void;
  placementValid: boolean;
  /**
   * Blocked zones after an edit — drawn, moved, resized or deleted.
   *
   * The whole list, not a patch, because that is what `store.setObstacles`
   * takes: it re-cuts every panel from scratch each time, so moving a switch
   * back where it was restores the cells it took.
   */
  onObstaclesChange: (obstacles: Obstacle[]) => void;
  /** Put an edge round the wall, or take it off. Undefined means none. */
  onFrameChange: (frame: WallFrame | undefined) => void;
}

interface View {
  /** Millimetres per CSS pixel. */
  scale: number;
  /** Wall-mm coordinate at the canvas origin. */
  originX: number;
  originY: number;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 6;

export function WallCanvas(props: WallCanvasProps) {
  const {
    doc,
    catalog,
    selection,
    drag,
    dragRef,
    invalidCells,
    onDragMove,
    onDrop,
    onDragCancel,
    onSelect,
    onStartItemDrag,
    placementValid,
    onObstaclesChange,
    onFrameChange,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ scale: 0.35, originX: -40, originY: -40 });
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hover, setHover] = useState<Hex | null>(null);

  // --- plan tools ---------------------------------------------------------
  const [tool, setTool] = useState<PlanTool>('select');
  /** The finished tape, kept on screen so the number can be READ and copied. */
  const [tape, setTape] = useState<{ from: Snap; to: Snap } | null>(null);
  /**
   * A tape or a zone being dragged out right now.
   *
   * Mirrored into a REF and written synchronously, for exactly the reason the
   * part drag is (see `dragRef`): state is only visible after a render, and
   * pointerdown → pointermove → pointerup can all land before that render
   * commits. Read from state, the release saw `sketch === null` and threw the
   * gesture away — every quick flick measured nothing at all, and so did every
   * synthetic drag.
   */
  const [sketch, setSketchState] = useState<{ from: Snap; to: Snap } | null>(null);
  const sketchRef = useRef<{ from: Snap; to: Snap } | null>(null);
  const setSketch = useCallback((next: { from: Snap; to: Snap } | null) => {
    sketchRef.current = next;
    setSketchState(next);
  }, []);
  const [zoneSel, setZoneSel] = useState<string | null>(null);
  /** Where the pointer is, snapped — the crosshair and the readout. */
  const [cursor, setCursor] = useState<Snap | null>(null);
  /**
   * A live zone move or resize.
   *
   * In a ref, for the same reason the part drag is: the gesture has to be
   * visible to the very next pointer event, and state is only visible after a
   * render. `origin` is the zone as it was when the grab started, so a drag is
   * always computed from the original rather than accumulated frame by frame —
   * accumulating drifts, and a resize that drifts changes size when you pause.
   */
  const zoneDragRef = useRef<
    { id: string; origin: Obstacle; grab: Point; handle: { hx: number; hy: number } | null } | null
  >(null);
  /**
   * Bumped whenever the theme changes, purely to force a repaint.
   *
   * The canvas reads its colours from the token layer via getComputedStyle, but
   * a theme switch changes no React state, so nothing in the draw effect's
   * dependencies moves and the canvas keeps painting the old palette — dark
   * chrome around a stubbornly light wall. Watching both the explicit
   * `data-theme` attribute and the OS preference covers the toggle and the case
   * where the system flips while the app is open.
   */
  const [themeTick, setThemeTick] = useState(0);
  const [marquee, setMarquee] = useState<{ a: Point; b: Point } | null>(null);
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const pressRef = useRef<{ x: number; y: number; cell: Hex; itemId?: string } | null>(null);

  /**
   * Cached static layer: the panel grid and the seams.
   *
   * These change only when the panels or the view change, but they are by far
   * the most expensive thing on screen — a garage wall is ~5,800 hexagons, i.e.
   * ~35,000 path segments. Rebuilding that on every pointer move during a drag
   * backed the event queue up until the tab stopped responding. Now it is drawn
   * once into an offscreen canvas and blitted, so a drag frame costs one
   * drawImage plus the handful of items actually moving.
   */
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const staticKeyRef = useRef<string>('');

  // --- geometry helpers ---------------------------------------------------

  /**
   * Wall millimetres to canvas pixels — and Y IS FLIPPED, on purpose.
   *
   * Screen y grows downward and wall y grows UP: the wall's origin is its
   * bottom-left corner, which is what a tape measure reads against and what the
   * 3D view uses. Mapping them straight through drew the plan upside down
   * against the same document the 3D view drew the right way up, so the top of
   * the wall in one was the bottom of it in the other (D70).
   *
   * `originY` is therefore the wall-mm y at the BOTTOM of the canvas.
   */
  const toScreen = useCallback(
    (p: Point): Point => ({
      x: (p.x - view.originX) / view.scale,
      y: size.h - (p.y - view.originY) / view.scale,
    }),
    [view, size.h],
  );

  const toWall = useCallback(
    (x: number, y: number): Point => ({
      x: x * view.scale + view.originX,
      y: (size.h - y) * view.scale + view.originY,
    }),
    [view, size.h],
  );

  /**
   * Index of every panel cell, for tinting and for off-panel detection.
   *
   * `placedPanelCells`, NOT `panelCells` on the raw block: a cell cut out for an
   * obstacle or a frame is not on the plate and must not be drawn. This read the
   * full block, so a blocked zone changed the parts list and the 3D view and
   * left the plan showing an unbroken honeycomb straight through the light
   * switch — the one place the cut most needs to be visible, since drawing the
   * zone is what you came to the plan to do.
   */
  const panelIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of doc.panels) {
      for (const c of placedPanelCells(p)) m.set(hexKey(c), p.id);
    }
    return m;
  }, [doc.panels]);

  /** Cell -> item id, so a click can find what it hit in O(1). */
  const itemIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of doc.items) {
      for (const c of itemCells(it, catalog)) m.set(hexKey(c), it.id);
    }
    return m;
  }, [doc.items, catalog]);

  /**
   * Seam edges, computed once per panel change rather than once per frame.
   *
   * Recomputing this inside the draw loop meant rebuilding a Set per panel and
   * walking 60 panels × ~100 cells × 6 directions on every pointer move. That
   * is ~36,000 iterations per frame before a single pixel is drawn, and it
   * locked the tab solid during a drag.
   */
  const seamEdges = useMemo(() => {
    if (doc.panels.length < 2) return [] as Array<{ cell: Hex; dir: number }>;
    const out: Array<{ cell: Hex; dir: number }> = [];
    for (const p of doc.panels) {
      // The cells the plate really has, so the hole left by a zone reads as an
      // outside edge rather than growing a seam round itself.
      const cells = placedPanelCells(p);
      const own = new Set(cells.map(hexKey));
      for (const c of cells) {
        for (let i = 0; i < 6; i++) {
          const d = HEX_DIRS[i]!;
          const nk = hexKey({ q: c.q + d.q, r: c.r + d.r });
          if (own.has(nk)) continue;          // same panel: not a seam
          if (!panelIndex.has(nk)) continue;  // outside edge: not a seam either
          out.push({ cell: c, dir: i });
        }
      }
    }
    return out;
  }, [doc.panels, panelIndex]);

  const partOf = useCallback(
    (partId: string) => catalog.parts.find((p) => p.id === partId),
    [catalog],
  );

  /** Cells that really exist, for snapping. Rebuilt only when the panels do. */
  const snapCells = useMemo(() => {
    const out: Hex[] = [];
    for (const key of panelIndex.keys()) {
      const comma = key.indexOf(',');
      out.push({ q: Number(key.slice(0, comma)), r: Number(key.slice(comma + 1)) });
    }
    return out;
  }, [panelIndex]);

  /**
   * Where the plate's edge really is, as shapes to draw.
   *
   * Both halves of it, from the generator's own rules so the plan cannot show an
   * edge the plate will not have:
   *
   *  - `edges` — the outermost cells, CUT on the plate's own lines (D86). They
   *    live in `omit` because nothing mounts in half a cell, so the plan draws
   *    none of them and would show a plate a whole ring smaller than the file.
   *    Fed the whole BLOCK for that reason, not the surviving cells.
   *  - `border` — the pieces raised round a HOLE the plate goes round that no
   *    zone owns: a step, or a gap where no plate reaches. All that is left of
   *    the phantom walk now that the outside is cut rather than grown.
   *
   * A seam between two plates has neither, because the position is taken.
   */
  const plateEdge = useMemo(() => {
    const spec = borderSpecFor(doc.panels, doc.frame, undefined, doc.obstacles);
    if (!spec) return { edges: [], border: [] };
    return {
      edges: plateEdgeShapes(assemblyBlockCells(doc.panels), spec),
      border: borderPolygons([...spec.occupied].map(keyToHex), spec),
    };
  }, [doc.panels, doc.frame, doc.obstacles]);

  /**
   * A pointer position as a snapped wall point.
   *
   * The radius is scaled by the view so it is a constant number of PIXELS on
   * screen: 8 mm is a comfortable grab at 100 % and invisible at 10 %, where a
   * whole wall is 200 px wide and nothing would ever catch.
   */
  const snapAt = useCallback(
    (p: Point, free: boolean): Snap =>
      snapPoint(p, {
        cells: snapCells,
        obstacles: doc.obstacles,
        wall: doc.wall,
        radiusMm: SNAP_RADIUS_MM * Math.max(1, view.scale * 2),
        enabled: !free,
      }),
    [snapCells, doc.obstacles, doc.wall, view.scale],
  );

  // --- sizing -------------------------------------------------------------

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(1, Math.floor(r.width)), h: Math.max(1, Math.floor(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  /** Fit the wall in view. Called on mount and by the Fit button. */
  const fit = useCallback(() => {
    const pad = 40;
    const sx = doc.wall.widthMm / Math.max(1, size.w - pad * 2);
    const sy = doc.wall.heightMm / Math.max(1, size.h - pad * 2);
    const scale = clamp(Math.max(sx, sy), MIN_SCALE, MAX_SCALE);
    setView({
      scale,
      originX: doc.wall.widthMm / 2 - (size.w / 2) * scale,
      originY: doc.wall.heightMm / 2 - (size.h / 2) * scale,
    });
  }, [doc.wall.widthMm, doc.wall.heightMm, size.w, size.h]);

  useEffect(() => {
    fit();
    // Only on wall size / viewport change, not on every doc edit.
  }, [fit]);

  // --- drawing ------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const bw = Math.floor(size.w * dpr);
    const bh = Math.floor(size.h * dpr);
    // Assigning canvas.width reallocates and clears the backing store. Doing it
    // unconditionally costs a full buffer allocation on every animation frame.
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      canvas.style.width = `${size.w}px`;
      canvas.style.height = `${size.h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const css = getComputedStyle(canvas);
    const tok = (name: string, fallback: string) =>
      css.getPropertyValue(name).trim() || fallback;

    const C = {
      wall: tok('--canvas-wall', '#101418'),
      grid: tok('--canvas-grid', '#7C838A'),
      cell: tok('--canvas-cell', '#1a2026'),
      cellHover: tok('--canvas-cell-hover', '#243039'),
      panel: tok('--canvas-panel-tint', '#18202a'),
      seam: tok('--canvas-seam', '#c05a2a'),
      item: tok('--accent-bg', '#1d3a52'),
      itemEdge: tok('--accent', '#57AEE8'),
      selection: tok('--canvas-selection', '#57AEE8'),
      ghostOk: tok('--canvas-ghost-valid', '#5FC98A'),
      ghostOkFill: tok('--canvas-ghost-valid-fill', '#5FC98A'),
      ghostBad: tok('--canvas-ghost-invalid', '#F0867B'),
      ghostBadFill: tok('--canvas-ghost-invalid-fill', '#F0867B'),
      text: tok('--canvas-label', '#aab3bb'),
      textDim: tok('--canvas-label-muted', '#7C838A'),
      zone: tok('--canvas-zone', '#B26B00'),
      zoneFill: tok('--canvas-zone-fill', 'rgba(178,107,0,0.2)'),
      zoneClearance: tok('--canvas-zone-clearance', 'rgba(178,107,0,0.45)'),
      measure: tok('--canvas-measure', '#e8edf2'),
      measureHalo: tok('--canvas-measure-halo', '#101418'),
      frame: tok('--canvas-frame', '#c05a2a'),
    };

    ctx.clearRect(0, 0, size.w, size.h);
    ctx.fillStyle = C.wall;
    ctx.fillRect(0, 0, size.w, size.h);

    // Wall outline in millimetres.
    const tl = toScreen({ x: 0, y: 0 });
    const br = toScreen({ x: doc.wall.widthMm, y: doc.wall.heightMm });
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.setLineDash([]);


    const cellPx = PITCH / view.scale;
    const drawGrid = cellPx > 6;

    // Precompute the corner offsets once. cos/sin per corner per cell was
    // 6 trig pairs × thousands of cells × every frame.
    const R0 = PITCH / Math.sqrt(3) / view.scale;
    const unit: Point[] = [];
    // FLAT-TOP, matching `hexCorners` in hex.ts and `corner` in WallView3D —
    // the plan view and the 3D view draw the same wall and must agree. The
    // `− 90` that used to be here went with the frame (D35).
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i);
      unit.push({ x: Math.cos(a), y: Math.sin(a) });
    }

    /** Add one hexagon to `path` — no state changes, no draw call. */
    const addHex = (path: Path2D, c: Hex, inset: number) => {
      const centre = toScreen(hexToMm(c));
      const R = R0 - inset / view.scale;
      for (let i = 0; i < 6; i++) {
        const u = unit[i]!;
        const x = centre.x + R * u.x;
        const y = centre.y + R * u.y;
        if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
      }
      path.closePath();
    };

    const hexPath = (c: Hex, inset: number) => {
      const p = new Path2D();
      addHex(p, c, inset);
      return p;
    };

    // 1 + 2. The static layer: panel cells and seams. Rebuilt only when the
    //        view, the panels or the theme change; otherwise blitted.
    const staticKey = [
      size.w, size.h, dpr,
      view.scale.toFixed(6), view.originX.toFixed(3), view.originY.toFixed(3),
      panelIndex.size, seamEdges.length, doc.panels.length,
      doc.wall.widthMm, doc.wall.heightMm, C.cell, C.grid, C.seam, C.panel,
    ].join('|');

    if (staticKeyRef.current !== staticKey || !staticRef.current) {
      let layer = staticRef.current;
      if (!layer) {
        layer = document.createElement('canvas');
        staticRef.current = layer;
      }
      layer.width = canvas.width;
      layer.height = canvas.height;
      const lc = layer.getContext('2d');
      if (lc) {
        lc.setTransform(dpr, 0, 0, dpr, 0, 0);
        lc.clearRect(0, 0, size.w, size.h);

        if (drawGrid) {
          // Only enumerate cells when the static layer is actually being
          // rebuilt — this walk is the expensive part.
          const visible = visibleCells(toWall, size, doc, panelIndex);

          // Two layers, so depth reads inward: the wall is the void, the panel
          // plate is material, the cell is the hole through it. Drawing cells
          // straight onto the wall colour skipped the plate entirely and left
          // the honeycomb looking like a flat wireframe with nothing behind it.
          const plate = new Path2D();
          const field = new Path2D();
          let count = 0;
          for (const c of visible) {
            if (panelIndex.size > 0 && !panelIndex.has(hexKey(c))) continue;
            addHex(plate, c, 0);      // full cell footprint: the plate
            addHex(field, c, 1.6);    // inset: the opening
            count++;
          }
          if (count > 0) {
            lc.fillStyle = C.panel;
            lc.fill(plate);
            lc.fillStyle = C.cell;
            lc.fill(field);
            lc.strokeStyle = C.grid;
            lc.lineWidth = Math.max(0.5, Math.min(1.25, cellPx / 30));
            lc.globalAlpha = 0.3;
            lc.stroke(field);
            lc.globalAlpha = 1;
          }
        } else if (panelIndex.size > 0) {
          // Too zoomed out for individual cells: fill panel areas as blocks.
          lc.fillStyle = C.panel;
          for (const p of doc.panels) {
            const b = cellsBounds(panelCells(p.origin, p.columns, p.rows));
            const a = toScreen({ x: b.minX, y: b.minY });
            const d = toScreen({ x: b.maxX, y: b.maxY });
            lc.fillRect(a.x, a.y, d.x - a.x, d.y - a.y);
          }
        }

        // Panel seams — the classic HSW mistake is spanning one unknowingly.
        if (seamEdges.length > 0 && drawGrid) {
          const seams = new Path2D();
          for (const { cell, dir } of seamEdges) {
            // Corners taken in WALL space from `hexCorners` and then mapped,
            // rather than rebuilt from angles in screen space. Screen space is
            // y-flipped, so an angle written there runs the other way round the
            // hexagon and every seam lands on the wrong edge — the same
            // off-by-one `edgeCorners` exists to stop, arriving by a different
            // route (D70).
            const corners = hexCorners(cell);
            const [c1, c2] = edgeCorners(dir);
            const a = toScreen(corners[c1]!);
            const b = toScreen(corners[c2]!);
            seams.moveTo(a.x, a.y);
            seams.lineTo(b.x, b.y);
          }
          // Deliberately quiet. A seam is reference information, not the
          // subject: at full weight it was the boldest thing on the wall,
          // heavier than the parts the user actually placed, which inverts the
          // hierarchy. It only has to be findable, not loud.
          lc.strokeStyle = C.seam;
          lc.lineWidth = Math.max(0.75, Math.min(1.4, cellPx / 26));
          lc.globalAlpha = 0.5;
          lc.stroke(seams);
          lc.globalAlpha = 1;
        }
      }
      staticKeyRef.current = staticKey;
    }

    if (staticRef.current) {
      ctx.drawImage(staticRef.current, 0, 0, size.w, size.h);
    }

    // Hover highlight sits on the dynamic layer: it changes every frame.
    //
    // Drawn at inset 0 — the WHOLE cell, out to its corners. It used to inset by
    // 0.8 px, which left a hairline of unlit grid around the hexagon and made the
    // highlight read as a slightly smaller shape floating inside the cell rather
    // than as the cell itself lighting up. The point of the highlight is to say
    // "this is the hexagon you are pointing at, and this is how big it is".
    if (drawGrid && hover && (panelIndex.size === 0 || panelIndex.has(hexKey(hover)))) {
      ctx.fillStyle = C.cellHover;
      ctx.fill(hexPath(hover, 0));
    }

    // 3. Placed items.
    const selected = new Set(selection);
    const dragging = new Set(drag?.itemIds ?? []);
    for (const it of doc.items) {
      const part = partOf(it.partId);
      if (!part) continue;
      const cells = itemCells(it, catalog);
      const isSel = selected.has(it.id);
      ctx.globalAlpha = dragging.has(it.id) ? 0.25 : 1;
      const body = new Path2D();
      for (const c of cells) addHex(body, c, 1.6);
      ctx.fillStyle = C.item;
      ctx.fill(body);
      ctx.strokeStyle = isSel ? C.selection : C.itemEdge;
      ctx.lineWidth = isSel ? Math.max(2, cellPx / 12) : Math.max(1, cellPx / 22);
      ctx.stroke(outlineRegion(cells, toScreen, view.scale));
      ctx.globalAlpha = 1;

      if (cellPx > 34) {
        const b = cellsBounds(cells);
        const mid = toScreen({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
        ctx.fillStyle = C.text;
        ctx.font = `${Math.min(13, Math.max(9, cellPx / 4))}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(shortLabel(part.name), mid.x, mid.y);
      }
    }

    // 4. Ghost preview under the cursor.
    if (drag && hover) {
      const cells = ghostCells(drag, hover, catalog, doc);
      const ghost = new Path2D();
      for (const c of cells) addHex(ghost, c, 1.6);
      ctx.fillStyle = placementValid ? C.ghostOkFill : C.ghostBadFill;
      ctx.fill(ghost);
      ctx.strokeStyle = placementValid ? C.ghostOk : C.ghostBad;
      ctx.lineWidth = Math.max(1.5, cellPx / 14);
      ctx.stroke(outlineRegion(cells, toScreen, view.scale));
    }

    // 5. Cells that blocked the last attempt.
    if (invalidCells && invalidCells.length > 0) {
      const bad = new Path2D();
      for (const c of invalidCells) addHex(bad, c, 1.2);
      ctx.strokeStyle = C.ghostBad;
      ctx.lineWidth = Math.max(1.5, cellPx / 12);
      ctx.stroke(bad);
    }

    // 5b. Blocked zones, and the frame.
    //
    // Drawn AFTER the honeycomb rather than under it: the cells inside a zone
    // have been cut out, so the zone shows through the gap it made, and seeing
    // the two together is the whole point — a zone whose rectangle does not
    // line up with the missing hexagons is a zone in the wrong place.
    drawZones(ctx, doc, toScreen, C, zoneSel, tool);
    drawBorder(ctx, plateEdge, toScreen, C);

    // 6. Marquee.
    if (marquee) {
      const a = toScreen(marquee.a);
      const b = toScreen(marquee.b);
      ctx.fillStyle = C.selection;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = C.selection;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }

    // 6b. The zone being dragged out, before it exists as a document object.
    if (tool === 'zone' && sketch) {
      const a = toScreen(sketch.from);
      const b = toScreen(sketch.to);
      ctx.fillStyle = C.zoneFill;
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.strokeStyle = C.zone;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.setLineDash([]);
      label(
        ctx, C,
        `${formatMm(Math.abs(sketch.to.x - sketch.from.x), 0)} × ` +
          `${formatMm(Math.abs(sketch.to.y - sketch.from.y), 0)} mm`,
        (a.x + b.x) / 2, Math.min(a.y, b.y) - 10,
      );
    }

    // 6c. The tape: the one being dragged, or the last one taken.
    const shown = tool === 'measure' ? (sketch ?? tape) : tape;
    if (shown) drawTape(ctx, shown, toScreen, C, size);

    // 6d. The snap crosshair, so you can see WHAT it caught before committing.
    if (cursor && cursor.kind !== 'free' && (tool === 'measure' || tool === 'zone')) {
      const p = toScreen(cursor);
      ctx.strokeStyle = C.measure;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(p.x - 7, p.y);
      ctx.lineTo(p.x + 7, p.y);
      ctx.moveTo(p.x, p.y - 7);
      ctx.lineTo(p.x, p.y + 7);
      ctx.stroke();
      if (!sketch) label(ctx, C, cursor.label, p.x, p.y - 14);
    }

    // 7. Scale readout.
    ctx.fillStyle = C.textDim;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const zones = (doc.obstacles ?? []).length;
    ctx.fillText(
      `${doc.wall.widthMm} × ${doc.wall.heightMm} mm · ${panelIndex.size} cells` +
        `${zones > 0 ? ` · ${zones} blocked` : ''} · ${(100 / view.scale).toFixed(0)}%`,
      12,
      size.h - 10,
    );
  }, [
    doc, catalog, selection, drag, hover, marquee, invalidCells, placementValid,
    size, view, toScreen, toWall, panelIndex, partOf, seamEdges, themeTick,
    tool, tape, sketch, zoneSel, cursor, plateEdge,
  ]);

  // --- interaction --------------------------------------------------------

  const cellAt = useCallback(
    (ev: { clientX: number; clientY: number }): Hex => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const x = ev.clientX - (rect?.left ?? 0);
      const y = ev.clientY - (rect?.top ?? 0);
      return mmToHex(toWall(x, y));
    },
    [toWall],
  );

  /**
   * Pointer tracking for a live drag, on WINDOW and attached ONCE.
   *
   * Two things force this shape:
   *
   *  - A drag from the catalogue rail begins on an element outside this canvas,
   *    which may also hold pointer capture, so the canvas's own handlers never
   *    see the move that brings the part over the wall.
   *  - Attaching the listeners from an effect keyed on the `drag` STATE loses
   *    the start of the gesture: the pointer can move and release before that
   *    render commits. So the listeners live for the lifetime of the component
   *    and read the live drag from a ref that is written synchronously.
   *
   * The handler closure is kept fresh in a ref rather than by re-subscribing,
   * so re-attaching can never race with an in-flight gesture.
   */
  const liveRef = useRef({ toWall, onDragMove, onDrop, onDragCancel });
  liveRef.current = { toWall, onDragMove, onDrop, onDragCancel };

  useEffect(() => {
    const rectOf = () => canvasRef.current?.getBoundingClientRect();
    const inside = (e: PointerEvent, r: DOMRect) =>
      e.clientX >= r.left && e.clientX <= r.right &&
      e.clientY >= r.top && e.clientY <= r.bottom;

    const move = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const rect = rectOf();
      if (!rect) return;
      if (!inside(e, rect)) { setHover(null); return; }
      const cell = mmToHex(liveRef.current.toWall(e.clientX - rect.left, e.clientY - rect.top));
      setHover(cell);
      liveRef.current.onDragMove(cell);
    };

    const up = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const rect = rectOf();
      setHover(null);
      // Released off the wall: cancel rather than dropping at the last cell the
      // cursor happened to cross. Dropping somewhere the user is not pointing
      // is worse than not dropping at all.
      if (!rect || !inside(e, rect)) { liveRef.current.onDragCancel(); return; }
      liveRef.current.onDrop(
        mmToHex(liveRef.current.toWall(e.clientX - rect.left, e.clientY - rect.top)),
      );
    };

    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current) {
        liveRef.current.onDragCancel();
        setHover(null);
      }
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', key);
    };
  }, [dragRef]);

  /** Pointer position in wall millimetres. */
  const wallAt = useCallback(
    (ev: { clientX: number; clientY: number }): Point => {
      const rect = canvasRef.current?.getBoundingClientRect();
      return toWall(ev.clientX - (rect?.left ?? 0), ev.clientY - (rect?.top ?? 0));
    },
    [toWall],
  );

  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    // Capture is an optimisation — it keeps the gesture alive past the canvas
    // edge — and it is allowed to fail: the browser rejects it for a pointer
    // that is no longer active, and it throws rather than returning false.
    // Unguarded, that exception aborts the rest of this handler, so the press
    // that failed to capture also fails to select, measure or start a zone.
    try {
      (ev.target as Element).setPointerCapture?.(ev.pointerId);
    } catch {
      /* the gesture still works, it just stops at the canvas edge */
    }
    const cell = cellAt(ev);

    // Middle button or space-drag pans.
    if (ev.button === 1 || ev.altKey) {
      panRef.current = { x: ev.clientX, y: ev.clientY, ox: view.originX, oy: view.originY };
      return;
    }
    if (ev.button !== 0) return;

    const at = wallAt(ev);
    const snapped = snapAt(at, ev.shiftKey);

    // Measure: every press starts a fresh tape. The previous one stays on
    // screen until then, because a measurement you cannot read twice is not
    // much use — you take it, then go and look at the thing you measured.
    if (tool === 'measure') {
      setTape(null);
      setSketch({ from: snapped, to: snapped });
      return;
    }

    if (tool === 'zone') {
      setSketch({ from: snapped, to: snapped });
      return;
    }

    // Select: a zone comes first, but only where it can be grabbed — its own
    // rectangle or a handle. Nothing can be placed inside a zone (its cells are
    // cut), so this can never steal a click meant for a part.
    const zones = doc.obstacles ?? [];
    const grabbed = grabZone(zones, at, zoneSel, view.scale);
    if (grabbed) {
      setZoneSel(grabbed.id);
      zoneDragRef.current = {
        id: grabbed.id,
        origin: grabbed.zone,
        grab: at,
        handle: grabbed.handle,
      };
      onSelect([], false);
      return;
    }
    if (zoneSel !== null) setZoneSel(null);

    const hitId = itemIndex.get(hexKey(cell));
    pressRef.current = { x: ev.clientX, y: ev.clientY, cell, itemId: hitId };
    if (hitId === undefined) {
      const rect = canvasRef.current?.getBoundingClientRect();
      const p = toWall(ev.clientX - (rect?.left ?? 0), ev.clientY - (rect?.top ?? 0));
      setMarquee({ a: p, b: p });
    }
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (panRef.current) {
      const d = panRef.current;
      setView((v) => ({
        ...v,
        originX: d.ox - (ev.clientX - d.x) * v.scale,
        // `+`, not `−`: wall y runs up the screen now, so dragging the pointer
        // down has to raise the wall-mm value at the bottom edge.
        originY: d.oy + (ev.clientY - d.y) * v.scale,
      }));
      return;
    }

    // While a drag is live the window listener owns pointer tracking, so the
    // canvas must not also report the move or every frame is handled twice.
    if (drag) return;

    const at = wallAt(ev);

    // A zone being moved or resized. Always recomputed from the ORIGINAL zone
    // and the total delta, never from the last frame — accumulating drifts, and
    // a rectangle that drifts changes size whenever the pointer pauses.
    const zd = zoneDragRef.current;
    if (zd) {
      const zones = doc.obstacles ?? [];
      const next = zd.handle
        ? resizeZone(zd.origin, zd.handle.hx, zd.handle.hy, snapAt(at, ev.shiftKey))
        // Through `moveZone`: a zone with a shape has to move its rectangles
        // with its box, or it blocks somewhere it is not drawn.
        : moveZone(zd.origin, at.x - zd.grab.x, at.y - zd.grab.y);
      onObstaclesChange(zones.map((o) => (o.id === zd.id ? next : o)));
      return;
    }

    if (tool === 'measure' || tool === 'zone') {
      const snapped = snapAt(at, ev.shiftKey);
      setCursor(snapped);
      const live = sketchRef.current;
      if (live) setSketch({ ...live, to: snapped });
      return;
    }

    const cell = cellAt(ev);
    setHover(cell);

    const press = pressRef.current;
    if (!press) return;
    const moved = Math.hypot(ev.clientX - press.x, ev.clientY - press.y);

    if (marquee) {
      const rect = canvasRef.current?.getBoundingClientRect();
      const p = toWall(ev.clientX - (rect?.left ?? 0), ev.clientY - (rect?.top ?? 0));
      setMarquee((m) => (m ? { ...m, b: p } : m));
      return;
    }

    // Threshold before a click becomes a drag, so a sloppy click does not move
    // a part by one cell without the user meaning it.
    if (press.itemId !== undefined && moved > 4) {
      const ids = selection.includes(press.itemId) ? [...selection] : [press.itemId];
      const anchorItem = doc.items.find((i) => i.id === press.itemId);
      const grabOffset = anchorItem
        ? { q: press.cell.q - anchorItem.at.q, r: press.cell.r - anchorItem.at.r }
        : { q: 0, r: 0 };
      pressRef.current = null;
      onStartItemDrag(ids, grabOffset);
    }
  };

  const onPointerUp = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (panRef.current) {
      panRef.current = null;
      return;
    }

    if (zoneDragRef.current) {
      zoneDragRef.current = null;
      return;
    }

    // `sketchRef`, never the state: see the note where it is declared. The
    // release can arrive before the render that would make `sketch` visible.
    const live = sketchRef.current;

    if (tool === 'measure') {
      // Keep it, however short. A zero-length tape is a legitimate thing to
      // leave on screen — it marks a point, and the next press replaces it.
      if (live) setTape(live);
      setSketch(null);
      return;
    }

    if (tool === 'zone') {
      if (live) {
        const zone = zoneFromDrag(
          live.from, live.to,
          `zone${Date.now().toString(36)}`,
          'Blocked zone',
          // No clearance by default: the user drew the rectangle they meant.
          // A preset obstacle carries one because 86 mm is the FACEPLATE and
          // the bevel round it is extra; a hand-drawn zone already includes it.
          0,
        );
        /*
         * Shift ADDS this rectangle to the selected zone instead of making a
         * new one, which is how a zone becomes an L or a T.
         *
         * A modifier rather than a third tool: it is the same gesture on the
         * same tool, and the thing it needs to say is "this one goes with that
         * one". A separate mode would have to be entered, and the zone it adds
         * to chosen, before the drag even starts.
         */
        const addTo = ev.shiftKey
          ? (doc.obstacles ?? []).find((o) => o.id === zoneSel)
          : undefined;
        if (zone && addTo) {
          const grown = withZonePart(addTo, {
            xMm: zone.xMm, yMm: zone.yMm, widthMm: zone.widthMm, heightMm: zone.heightMm,
          });
          onObstaclesChange((doc.obstacles ?? []).map((o) => (o.id === grown.id ? grown : o)));
          setTool('select');
          setSketch(null);
          return;
        }
        if (zone) {
          onObstaclesChange([...(doc.obstacles ?? []), zone]);
          setZoneSel(zone.id);
          // Straight back to Select, so the zone you just drew can be nudged
          // without hunting for the tool switch — and so a stray click on the
          // wall does not become a second zone.
          setTool('select');
        }
      }
      setSketch(null);
      return;
    }

    if (drag) {
      // Handled by the window-level listener; just clear local press state.
      pressRef.current = null;
      setMarquee(null);
      return;
    }
    if (marquee) {
      const hits = itemsInRect(doc, catalog, marquee.a, marquee.b);
      onSelect(hits, ev.shiftKey || ev.metaKey || ev.ctrlKey);
      setMarquee(null);
      pressRef.current = null;
      return;
    }
    const press = pressRef.current;
    if (press) {
      const id = press.itemId;
      onSelect(id === undefined ? [] : [id], ev.shiftKey || ev.metaKey || ev.ctrlKey);
    }
    pressRef.current = null;
  };

  const onPointerLeave = () => {
    // Do NOT cancel a live drag here: a catalogue drag legitimately starts
    // outside the canvas, and wandering past the edge mid-drag is normal.
    if (drag) return;
    setHover(null);
    setCursor(null);
    panRef.current = null;
  };

  /**
   * Tool keys, and what Escape and Delete mean while a zone is selected.
   *
   * Deliberately NOT folded into the shell's key handler: it already declines
   * to act on Delete when nothing is selected, which is exactly the case where
   * a zone is, and Escape there clears the item selection without knowing a
   * tool exists. Two handlers, each minding its own selection.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'Escape') {
        setTool('select');
        setSketch(null);
        setTape(null);
        setZoneSel(null);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && zoneSel !== null) {
        e.preventDefault();
        onObstaclesChange((doc.obstacles ?? []).filter((o) => o.id !== zoneSel));
        setZoneSel(null);
        return;
      }
      if (e.key.toLowerCase() === 'e') {
        e.preventDefault();
        const current = doc.frame;
        onFrameChange(
          frameIsOn(current)
            ? undefined
            : {
                ...NO_WALL_FRAME,
                left: true, right: true, bottom: true, top: true, holes: true,
                thicknessMm: current?.thicknessMm ?? DEFAULT_BORDER_MM,
              },
        );
        return;
      }
      const keys: Record<string, PlanTool> = { v: 'select', m: 'measure', b: 'zone' };
      const next = keys[e.key.toLowerCase()];
      if (next) {
        setTool(next);
        setSketch(null);
        if (next !== 'select') setZoneSel(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoneSel, doc.obstacles, doc.frame, onObstaclesChange, onFrameChange]);

  const onWheel = (ev: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const cx = ev.clientX - (rect?.left ?? 0);
    const cy = ev.clientY - (rect?.top ?? 0);
    setView((v) => {
      // Trackpad pinch arrives as ctrl+wheel; plain wheel scrolls the view.
      if (!ev.ctrlKey && !ev.metaKey && Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
        return { ...v, originX: v.originX + ev.deltaX * v.scale };
      }
      const before = {
        x: cx * v.scale + v.originX,
        y: (size.h - cy) * v.scale + v.originY,
      };
      const factor = Math.exp(ev.deltaY * 0.0015);
      const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      return {
        scale,
        originX: before.x - cx * scale,
        originY: before.y - (size.h - cy) * scale,
      };
    });
  };

  /** The tape being dragged out, or the last one taken. */
  const readout = useMemo(() => {
    const shown = tool === 'measure' ? (sketch ?? tape) : tape;
    return shown ? measure(shown.from, shown.to) : null;
  }, [tool, sketch, tape]);

  const borderOn = frameIsOn(doc.frame);

  const TOOLS: { id: PlanTool; label: string; key: string; hint: string }[] = [
    { id: 'select', label: 'Select', key: 'V', hint: 'Move parts and zones' },
    { id: 'measure', label: 'Measure', key: 'M', hint: 'Drag between two points — hold Shift to ignore snapping' },
    { id: 'zone', label: 'Blocked zone', key: 'B', hint: 'Drag a rectangle the honeycomb must keep out of' },
  ];

  return (
    <div className="wall-canvas" ref={wrapRef} data-tool={tool}>
      <div className="wall-canvas__toolbar" role="group" aria-label="Plan tool">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tool === t.id}
            title={`${t.hint} (${t.key})`}
            onClick={() => {
              setTool(t.id);
              setSketch(null);
              if (t.id !== 'select') setZoneSel(null);
            }}
          >
            {t.label}
            <kbd>{t.key}</kbd>
          </button>
        ))}
        {/*
          The border, where you are looking at the wall.
          It lives in the parts-list rail too, with the per-side checkboxes —
          this is the switch you reach for while planning, and the thickness
          beside it because "how thick" is the question you ask straight after
          "on or off".
        */}
        <button
          type="button"
          className="wall-canvas__border"
          aria-pressed={borderOn}
          title="A straight, closed edge round the outside of the honeycomb (E)"
          onClick={() => {
            const current = doc.frame;
            if (frameIsOn(current)) {
              onFrameChange(undefined);
              return;
            }
            onFrameChange({
              ...NO_WALL_FRAME,
              left: true, right: true, bottom: true, top: true, holes: true,
              thicknessMm: current?.thicknessMm ?? DEFAULT_BORDER_MM,
            });
          }}
        >
          Border
          <kbd>E</kbd>
        </button>
        {borderOn && doc.frame && (
          <label className="wall-canvas__thickness">
            <NumberField
              value={doc.frame.thicknessMm}
              min={MIN_BORDER_MM}
              max={MAX_BORDER_MM}
              step={0.2}
              decimals={1}
              onCommit={(v) => onFrameChange({ ...doc.frame!, thicknessMm: v })}
              aria-label="Border thickness in millimetres"
            />
            <span>mm</span>
          </label>
        )}

        {readout && (
          <>
            {/*
              The measurement in the DOM as well as on the canvas.
              A number painted into a canvas cannot be read by a screen reader,
              cannot be selected, and cannot be copied into the note you are
              writing about your wall — and this is the one number in the app a
              person actually wants to write down. `aria-live` so it is announced
              as the tape is dragged out.
            */}
            <output className="wall-canvas__readout tabular-nums" aria-live="polite">
              <strong>{formatMm(readout.distanceMm)}</strong> mm
              <span>
                {formatMm(Math.abs(readout.dxMm))} × {formatMm(Math.abs(readout.dyMm))}
              </span>
            </output>
            <button
              type="button"
              className="wall-canvas__clear"
              title="Clear the measurement (Esc)"
              onClick={() => { setTape(null); setSketch(null); }}
            >
              Clear
            </button>
          </>
        )}
      </div>
      {/*
        One tag per blocked zone, as real HTML over the canvas.

        Painted text can be read and nothing else. A switch plate is 146 × 86 and
        that is a number you TYPE — dragging a rectangle until it looks about
        right is how you end up cutting one hexagon too few. The tag is also the
        only way the zones reach a screen reader, and the only way their sizes
        can be copied out.

        Anchored to the zone's top-left corner rather than its middle, so the
        body of the zone stays free to grab and drag.
      */}
      <div className="wall-canvas__zonetags" aria-label="Blocked zones">
        {(doc.obstacles ?? []).map((o) => {
          const a = toScreen({ x: o.xMm, y: o.yMm });
          const b = toScreen({ x: o.xMm + o.widthMm, y: o.yMm + o.heightMm });
          const left = Math.min(a.x, b.x);
          const top = Math.min(a.y, b.y);
          const wide = Math.abs(b.x - a.x);
          const tall = Math.abs(b.y - a.y);
          // Too small on screen to hold a tag: it would cover the zone it
          // describes and land on top of its neighbours.
          if (wide < 46 || tall < 22) return null;
          return (
            <ZoneTag
              key={o.id}
              zone={o}
              left={left}
              top={top}
              selected={o.id === zoneSel}
              onSelect={() => setZoneSel(o.id)}
              onChange={(next) =>
                onObstaclesChange((doc.obstacles ?? []).map((z) => (z.id === o.id ? next : z)))}
            />
          );
        })}
      </div>

      <canvas
        ref={canvasRef}
        className="wall-canvas__surface"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerLeave}
        onPointerLeave={onPointerLeave}
        onWheel={onWheel}
        role="application"
        aria-label="Wall layout"
      />
      <div className="wall-canvas__tools">
        <button type="button" onClick={fit} title="Fit wall to view">Fit</button>
        <button
          type="button"
          onClick={() => setView((v) => ({ ...v, scale: clamp(v.scale / 1.3, MIN_SCALE, MAX_SCALE) }))}
          title="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => setView((v) => ({ ...v, scale: clamp(v.scale * 1.3, MIN_SCALE, MAX_SCALE) }))}
          title="Zoom out"
        >
          −
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function shortLabel(name: string): string {
  return name.length > 16 ? `${name.slice(0, 15)}…` : name;
}

export function ghostCells(
  drag: DragPayload,
  hover: Hex,
  catalog: Catalog,
  doc: LayoutDoc,
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
  if (members.length === 0) return [];
  const lead = members[0];
  if (!lead) return [];
  const delta = { q: anchor.q - lead.at.q, r: anchor.r - lead.at.r };
  const out: Hex[] = [];
  for (const m of members) {
    const part = catalog.parts.find((p) => p.id === m.partId);
    if (!part) continue;
    out.push(
      ...partCells(part, { q: m.at.q + delta.q, r: m.at.r + delta.r }, m.rotation),
    );
  }
  return out;
}

function cellsBounds(cells: readonly Hex[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of cells) {
    const p = hexToMm(c);
    minX = Math.min(minX, p.x - MARGIN_X);
    maxX = Math.max(maxX, p.x + MARGIN_X);
    minY = Math.min(minY, p.y - MARGIN_Y);
    maxY = Math.max(maxY, p.y + MARGIN_Y);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/**
 * Cells worth drawing this frame.
 *
 * Enumerating the lattice across the viewport is unbounded — zoom out far
 * enough and the row × column product runs into the millions before anything
 * gets culled, and the frame is gone. So when panels exist we iterate the
 * panels' own cells (a number the document actually contains) and cull those to
 * the viewport. With no panels there is nothing to draw but the wall rectangle,
 * which bounds the enumeration by the wall size instead.
 */
/**
 * Exported for `tests/visible-cells.test.ts`. It is pure — a mapper, a size and
 * a document — and it carried a stale copy of the inverse embedding through a
 * frame turn, so it is worth holding to its contract from outside.
 */
export function visibleCells(
  toWall: (x: number, y: number) => Point,
  size: { w: number; h: number },
  doc: LayoutDoc,
  panelIndex: ReadonlyMap<string, string>,
): Hex[] {
  // Both canvas corners, then min/max — NOT "top-left is the minimum". Wall y
  // runs up the screen, so `toWall(0, 0)` is the canvas's top edge and therefore
  // the LARGEST y (D70). Taking it as the minimum culled the whole wall.
  const a = toWall(0, 0);
  const b = toWall(size.w, size.h);
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const pad = PITCH;
  const inView = (c: Hex) => {
    const p = hexToMm(c);
    return p.x >= minX - pad && p.x <= maxX + pad && p.y >= minY - pad && p.y <= maxY + pad;
  };

  const out: Hex[] = [];
  if (panelIndex.size > 0) {
    for (const key of panelIndex.keys()) {
      const comma = key.indexOf(',');
      const c = { q: Number(key.slice(0, comma)), r: Number(key.slice(comma + 1)) };
      if (inView(c)) out.push(c);
    }
    return out;
  }

  // r must be solved per COLUMN, because y = PITCH·(r + q/2): the r that reaches
  // a given y slides by half a step every column. Clamping r to a fixed floor
  // shears the field into a parallelogram — the right-hand columns lose their
  // top cells.
  //
  // Transposed with the frame (D35). It read the other way round — r from
  // y/ROW_STEP and q per row — which is the pointy-top inverse and survived the
  // turn because this path only runs on an EMPTY wall, before any panel is
  // solved. With panels the range comes from `panelIndex` above, so the stale
  // arithmetic never showed once anything was on screen.
  const qMin = Math.max(0, Math.floor(Math.max(minX, 0) / ROW_STEP) - 1);
  const qMax = Math.min(
    Math.ceil(doc.wall.widthMm / ROW_STEP),
    Math.ceil(maxX / ROW_STEP) + 1,
  );
  for (let q = qMin; q <= qMax; q++) {
    const yLo = Math.max(minY, 0);
    const yHi = Math.min(maxY, doc.wall.heightMm);
    const rMin = Math.floor(yLo / PITCH - q / 2) - 1;
    const rMax = Math.ceil(yHi / PITCH - q / 2) + 1;
    for (let r = rMin; r <= rMax; r++) {
      if (out.length > 40000) return out; // last-resort guard
      out.push({ q, r });
    }
  }
  return out;
}

/** The six neighbour directions, shared by the renderer and the seam index. */
const HEX_DIRS: readonly Hex[] = [
  { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 },
  { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 },
];

/**
 * Outline of a multi-cell region: only the edges with no neighbour inside it.
 *
 * Returns a Path2D rather than stroking, so the caller makes exactly one draw
 * call however many cells the part covers.
 */
function outlineRegion(
  cells: readonly Hex[],
  toScreen: (p: Point) => Point,
  scale: number,
): Path2D {
  const set = new Set(cells.map(hexKey));
  // The inset is in screen pixels, so it converts to an across-flats in wall mm.
  const acrossFlats = PITCH - 2 * 1.6 * scale;
  const path = new Path2D();
  for (const c of cells) {
    // Corners in WALL space, then mapped. Rebuilt from angles in screen space
    // they would run the other way round the hexagon, because screen y is
    // flipped — every outline one edge out, which is exactly the defect
    // `edgeCorners` was introduced for (D70).
    const corners = hexCorners(c, acrossFlats);
    for (let i = 0; i < 6; i++) {
      const d = HEX_DIRS[i]!;
      if (set.has(hexKey({ q: c.q + d.q, r: c.r + d.r }))) continue;
      const [c1, c2] = edgeCorners(i);
      const a = toScreen(corners[c1]!);
      const b = toScreen(corners[c2]!);
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
    }
  }
  return path;
}

/**
 * A blocked zone's name and size, as controls rather than paint.
 *
 * Click either to edit it. The size is two fields and an unambiguous `×`, not
 * one "146 x 86" string to parse: a measurement someone types under pressure
 * should not be able to fail on a separator.
 */
function ZoneTag(props: {
  zone: Obstacle;
  left: number;
  top: number;
  selected: boolean;
  onSelect: () => void;
  onChange: (next: Obstacle) => void;
}) {
  const { zone, left, top, selected, onSelect, onChange } = props;
  const [editing, setEditing] = useState<'name' | 'size' | null>(null);
  /**
   * The name being typed, held back like the numbers are.
   *
   * Committed per keystroke it goes through `setObstacles`, which re-cuts every
   * plate on the wall — for a rename, which cannot change a single cell.
   */
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  const commitName = (): void => {
    if (nameDraft !== null && nameDraft !== zone.label) onChange({ ...zone, label: nameDraft });
    setNameDraft(null);
    setEditing(null);
  };

  return (
    <div
      className="zone-tag"
      data-selected={selected || undefined}
      style={{ left: `${left}px`, top: `${top}px` }}
      onPointerDown={(e) => {
        // The tag is a control, not part of the wall: keep the press away from
        // the canvas underneath, which would start a marquee or a new zone.
        e.stopPropagation();
        onSelect();
      }}
    >
      {editing === 'name' ? (
        <input
          className="zone-tag__name zone-tag__input"
          autoFocus
          value={nameDraft ?? zone.label}
          aria-label="Zone name"
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') { setNameDraft(null); setEditing(null); }
          }}
        />
      ) : (
        <button
          type="button"
          className="zone-tag__name"
          title="Rename this zone"
          onClick={() => setEditing('name')}
        >
          {zone.label}
        </button>
      )}

      {editing === 'size' ? (
        <span className="zone-tag__size tabular-nums">
          {/*
            `confirm`, not live. Typing `220` over `146` would otherwise re-cut
            every plate on the wall at `2`, at `22` and at `220`, and leave three
            undo steps for one measurement. Enter or OK applies it; Escape drops
            it; leaving the field applies it too, because a typed measurement
            silently thrown away is worse than one applied a moment early.
          */}
          <NumberField
            className="zone-tag__input"
            value={zone.widthMm}
            min={MIN_ZONE_MM}
            max={MAX_WALL_MM}
            step={1}
            commitOn="confirm"
            onCommit={(v) => onChange({ ...zone, widthMm: v })}
            aria-label={`${zone.label} width in millimetres`}
          />
          <span aria-hidden="true">×</span>
          <NumberField
            className="zone-tag__input"
            value={zone.heightMm}
            min={MIN_ZONE_MM}
            max={MAX_WALL_MM}
            step={1}
            commitOn="confirm"
            onCommit={(v) => onChange({ ...zone, heightMm: v })}
            aria-label={`${zone.label} height in millimetres`}
          />
          <button
            type="button"
            className="zone-tag__ok"
            onClick={() => setEditing(null)}
            aria-label="Apply this size"
          >
            OK
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="zone-tag__size tabular-nums"
          title="Type the exact size of the thing the honeycomb has to miss"
          onClick={() => setEditing('size')}
        >
          {formatMm(zone.widthMm, 0)} × {formatMm(zone.heightMm, 0)} mm
        </button>
      )}
    </div>
  );
}

/**
 * What the pointer grabbed on a zone: a resize handle, the body, or nothing.
 *
 * Handles are tested first and only on the SELECTED zone, because they stick
 * out past the rectangle — an unselected zone's handles are not drawn, and
 * grabbing something invisible is worse than missing it. The tolerance is in
 * pixels converted to millimetres, so the target stays the same size on screen
 * however far you are zoomed out.
 */
function grabZone(
  zones: readonly Obstacle[],
  at: Point,
  selectedId: string | null,
  scale: number,
): { id: string; zone: Obstacle; handle: { hx: number; hy: number } | null } | null {
  const tolMm = (HANDLE_PX / 2 + 3) * scale;
  const selected = zones.find((o) => o.id === selectedId);
  if (selected) {
    for (const { hx, hy } of ZONE_HANDLES) {
      const p = handlePoint(selected, hx, hy);
      if (Math.abs(p.x - at.x) <= tolMm && Math.abs(p.y - at.y) <= tolMm) {
        return { id: selected.id, zone: selected, handle: { hx, hy } };
      }
    }
  }
  // Last drawn is on top, so search backwards.
  for (let i = zones.length - 1; i >= 0; i--) {
    const o = zones[i]!;
    if (zoneHit(o, at)) return { id: o.id, zone: o, handle: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plan-tool drawing. Pure: context, data, a mapper and the palette — no state.
// ---------------------------------------------------------------------------

interface Palette {
  zone: string;
  zoneFill: string;
  zoneClearance: string;
  measure: string;
  measureHalo: string;
  text: string;
  frame: string;
  /** The plate. The border is drawn in it, because the border IS the plate. */
  panel: string;
  grid: string;
}

/**
 * Text with a halo, so a number stays readable wherever it lands.
 *
 * A measurement crosses bare wall, plate and open cell in one run, and any
 * single colour is unreadable against one of the three. Stroking the background
 * colour behind the glyphs is what a CAD drawing does and costs one extra pass.
 */
function label(
  ctx: CanvasRenderingContext2D,
  C: Palette,
  text: string,
  x: number,
  y: number,
  /**
   * Canvas size, to keep the label on it.
   *
   * A tape between two wall corners puts its rise label past the right-hand
   * edge, where it lands under the parts list and is simply gone. Nudging it
   * back in beats dropping it: an approximate position for a number you can
   * read is worth more than an exact one you cannot.
   */
  bounds?: { w: number; h: number },
): void {
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (bounds) {
    const half = ctx.measureText(text).width / 2 + 6;
    x = Math.min(Math.max(x, half), bounds.w - half);
    y = Math.min(Math.max(y, 12), bounds.h - 12);
  }
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = C.measureHalo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = C.measure;
  ctx.fillText(text, x, y);
}

/** The handle squares of the selected zone, in screen pixels. */
const HANDLE_PX = 7;

function drawZones(
  ctx: CanvasRenderingContext2D,
  doc: LayoutDoc,
  toScreen: (p: Point) => Point,
  C: Palette,
  selectedId: string | null,
  tool: PlanTool,
): void {
  for (const o of doc.obstacles ?? []) {
    const selected = o.id === selectedId;
    /*
     * Every rectangle of the shape, not the bounding box.
     *
     * An L drawn as its box would show the hollow as blocked when it is not —
     * the honeycomb is still there and still takes parts. `zoneParts` and
     * `obstacleRects` are the two readings of one list (drawn, and grown by the
     * clearance); nothing here re-derives either.
     */
    const parts = zoneParts(o);
    const boxOf = (r: { xMm: number; yMm: number; widthMm: number; heightMm: number }) => {
      const a = toScreen({ x: r.xMm, y: r.yMm });
      const b = toScreen({ x: r.xMm + r.widthMm, y: r.yMm + r.heightMm });
      return {
        x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y),
      };
    };

    // The clearance ring first, so the solid rectangles sit on top of it.
    if (o.clearanceMm > 0) {
      ctx.strokeStyle = C.zoneClearance;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (const g of obstacleRects(o)) {
        const ga = toScreen({ x: g.minX, y: g.minY });
        const gb = toScreen({ x: g.maxX, y: g.maxY });
        ctx.strokeRect(
          Math.min(ga.x, gb.x), Math.min(ga.y, gb.y),
          Math.abs(gb.x - ga.x), Math.abs(gb.y - ga.y),
        );
      }
      ctx.setLineDash([]);
    }

    ctx.fillStyle = C.zoneFill;
    for (const r of parts) { const q = boxOf(r); ctx.fillRect(q.x, q.y, q.w, q.h); }
    ctx.strokeStyle = C.zone;
    ctx.lineWidth = selected ? 2.5 : 1.5;
    for (const r of parts) { const q = boxOf(r); ctx.strokeRect(q.x, q.y, q.w, q.h); }

    // The label and the size are NOT painted here. They are real HTML controls
    // over the canvas, because a measurement you can only look at is half a
    // feature — you need to be able to type the switch plate's actual 146 × 86
    // rather than nudge a rectangle until it looks about right.

    // Handles only on the selected zone, and only when they can be used: eight
    // squares on every zone would bury the honeycomb the plan exists to show.
    if (selected && tool !== 'measure') {
      ctx.fillStyle = C.zone;
      ctx.strokeStyle = C.measureHalo;
      ctx.lineWidth = 1;
      for (const { hx, hy } of ZONE_HANDLES) {
        const p = toScreen(handlePoint(o, hx, hy));
        ctx.fillRect(p.x - HANDLE_PX / 2, p.y - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
        ctx.strokeRect(p.x - HANDLE_PX / 2, p.y - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
      }
    }
  }
}

/**
 * The border, drawn as the SAME PLATE it is part of.
 *
 * Filled in the plate's own colour, not a colour of its own, and that is the
 * whole point. A border is not a thing stuck to the honeycomb — it is more of
 * the same 8 mm plate, and the plate is one piece of plastic.
 *
 * Drawn in its own tone it read as a separate band, and the band's INNER
 * boundary — the honeycomb's zig-zag, stepping half a pitch between staggered
 * columns — looked like a jagged edge on the border. There is no such edge. The
 * only boundary a printed plate has there is where the holes begin, which is
 * exactly what the reference photograph shows and what this now draws (D68).
 *
 * The shapes come from `borderPolygons`, which is the generator's own walk, so
 * there is exactly one answer to "where is the edge".
 */
function drawBorder(
  ctx: CanvasRenderingContext2D,
  shapes: {
    edges: readonly { outline: readonly Point[]; bore: readonly Point[] }[];
    border: readonly (readonly Point[])[];
  },
  toScreen: (p: Point) => Point,
  C: Palette,
): void {
  if (shapes.edges.length === 0 && shapes.border.length === 0) return;
  const path = new Path2D();
  const add = (poly: readonly Point[]): void => {
    for (let i = 0; i < poly.length; i++) {
      const q = toScreen(poly[i]!);
      if (i === 0) path.moveTo(q.x, q.y);
      else path.lineTo(q.x, q.y);
    }
    path.closePath();
  };
  for (const poly of shapes.border) add(poly);
  // The cut cells: their outline, then what is left of their mouth punched out
  // of it. Even-odd rather than a second fill, so a half hexagon reads as the
  // open hole it is rather than as solid plate with a lid.
  for (const e of shapes.edges) {
    add(e.outline);
    if (e.bore.length >= 3) add(e.bore);
  }
  ctx.fillStyle = C.panel;
  ctx.fill(path, 'evenodd');
  // A hairline on the outside only, so the plate's edge stays findable against
  // the wall behind it at low zoom. The stroke follows the same shapes, so it
  // cannot describe a different edge from the fill.
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 0.75;
  ctx.globalAlpha = 0.35;
  ctx.stroke(path);
  ctx.globalAlpha = 1;
}

/** A tape measure: the run, its two ticks, and the numbers. */
function drawTape(
  ctx: CanvasRenderingContext2D,
  tape: { from: Snap; to: Snap },
  toScreen: (p: Point) => Point,
  C: Palette,
  bounds: { w: number; h: number },
): void {
  const a = toScreen(tape.from);
  const b = toScreen(tape.to);
  const m = measure(tape.from, tape.to);

  // The right-angled legs first, dashed and quiet: they answer "how far across
  // and how far up", which is what you actually mark on a wall with a pencil.
  ctx.strokeStyle = C.measure;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  ctx.lineWidth = 1.75;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();

  // End ticks perpendicular to the run, so a zero-length tape is still visible.
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = (-(b.y - a.y) / len) * 6;
  const ny = ((b.x - a.x) / len) * 6;
  ctx.beginPath();
  ctx.moveTo(a.x - nx, a.y - ny);
  ctx.lineTo(a.x + nx, a.y + ny);
  ctx.moveTo(b.x - nx, b.y - ny);
  ctx.lineTo(b.x + nx, b.y + ny);
  ctx.stroke();

  label(ctx, C, `${formatMm(m.distanceMm)} mm`, (a.x + b.x) / 2, (a.y + b.y) / 2 - 12, bounds);
  if (Math.abs(m.dxMm) > 0.5 && Math.abs(m.dyMm) > 0.5) {
    label(ctx, C, formatMm(Math.abs(m.dxMm)), (a.x + b.x) / 2, a.y + (a.y < b.y ? -12 : 12), bounds);
    // Beside the vertical leg, on the side the diagonal is NOT — otherwise the
    // rise sits on top of the run.
    label(ctx, C, formatMm(Math.abs(m.dyMm)), b.x + (b.x >= a.x ? 26 : -26), (a.y + b.y) / 2, bounds);
  }
}

function itemsInRect(doc: LayoutDoc, catalog: Catalog, a: Point, b: Point): string[] {
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  const hits: string[] = [];
  for (const it of doc.items) {
    const cells = itemCells(it, catalog);
    if (cells.length === 0) continue;
    const hit = cells.some((c) => {
      const p = hexToMm(c);
      return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
    });
    if (hit) hits.push(it.id);
  }
  return hits;
}

export type { PlacedItem };
