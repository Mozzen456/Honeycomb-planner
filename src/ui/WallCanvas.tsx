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
  hexKey,
  hexToMm,
  mmToHex,
  panelCells,
  placeFootprint,
  type Point,
} from '../core/hex';
import { itemCells } from '../core/bom';
import type { Catalog, Hex, LayoutDoc, PlacedItem, Rotation } from '../core/types';
import './WallCanvas.css';

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
  } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ scale: 0.35, originX: -40, originY: -40 });
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hover, setHover] = useState<Hex | null>(null);
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

  const toScreen = useCallback(
    (p: Point): Point => ({
      x: (p.x - view.originX) / view.scale,
      y: (p.y - view.originY) / view.scale,
    }),
    [view],
  );

  const toWall = useCallback(
    (x: number, y: number): Point => ({
      x: x * view.scale + view.originX,
      y: y * view.scale + view.originY,
    }),
    [view],
  );

  /** Index of every panel cell, for tinting and for off-panel detection. */
  const panelIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of doc.panels) {
      for (const c of panelCells(p.origin, p.columns, p.rows)) {
        m.set(hexKey(c), p.id);
      }
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
      const cells = panelCells(p.origin, p.columns, p.rows);
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
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 90);
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
            const centre = toScreen(hexToMm(cell));
            // Edge `dir` lies between corners dir and dir+1 of a pointy-top hex.
            const a1 = (Math.PI / 180) * (60 * dir - 60);
            const a2 = (Math.PI / 180) * (60 * dir);
            seams.moveTo(centre.x + R0 * Math.cos(a1), centre.y + R0 * Math.sin(a1));
            seams.lineTo(centre.x + R0 * Math.cos(a2), centre.y + R0 * Math.sin(a2));
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
    if (drawGrid && hover && (panelIndex.size === 0 || panelIndex.has(hexKey(hover)))) {
      ctx.fillStyle = C.cellHover;
      ctx.fill(hexPath(hover, 0.8));
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

    // 7. Scale readout.
    ctx.fillStyle = C.textDim;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(
      `${doc.wall.widthMm} × ${doc.wall.heightMm} mm · ${panelIndex.size} cells · ${(100 / view.scale).toFixed(0)}%`,
      12,
      size.h - 10,
    );
  }, [
    doc, catalog, selection, drag, hover, marquee, invalidCells, placementValid,
    size, view, toScreen, toWall, panelIndex, partOf, seamEdges, themeTick,
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

  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    const cell = cellAt(ev);

    // Middle button or space-drag pans.
    if (ev.button === 1 || ev.altKey) {
      panRef.current = { x: ev.clientX, y: ev.clientY, ox: view.originX, oy: view.originY };
      return;
    }
    if (ev.button !== 0) return;

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
        originY: d.oy - (ev.clientY - d.y) * v.scale,
      }));
      return;
    }

    // While a drag is live the window listener owns pointer tracking, so the
    // canvas must not also report the move or every frame is handled twice.
    if (drag) return;

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
    panRef.current = null;
  };

  const onWheel = (ev: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const cx = ev.clientX - (rect?.left ?? 0);
    const cy = ev.clientY - (rect?.top ?? 0);
    setView((v) => {
      // Trackpad pinch arrives as ctrl+wheel; plain wheel scrolls the view.
      if (!ev.ctrlKey && !ev.metaKey && Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
        return { ...v, originX: v.originX + ev.deltaX * v.scale };
      }
      const before = { x: cx * v.scale + v.originX, y: cy * v.scale + v.originY };
      const factor = Math.exp(ev.deltaY * 0.0015);
      const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      return { scale, originX: before.x - cx * scale, originY: before.y - cy * scale };
    });
  };

  return (
    <div className="wall-canvas" ref={wrapRef}>
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
    return placeFootprint(part.footprint, anchor, drag.rotation);
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
      ...placeFootprint(part.footprint, { q: m.at.q + delta.q, r: m.at.r + delta.r }, m.rotation),
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
function visibleCells(
  toWall: (x: number, y: number) => Point,
  size: { w: number; h: number },
  doc: LayoutDoc,
  panelIndex: ReadonlyMap<string, string>,
): Hex[] {
  const tl = toWall(0, 0);
  const br = toWall(size.w, size.h);
  const pad = PITCH;
  const inView = (c: Hex) => {
    const p = hexToMm(c);
    return p.x >= tl.x - pad && p.x <= br.x + pad && p.y >= tl.y - pad && p.y <= br.y + pad;
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

  // q must be solved per row, because x = PITCH·(q + r/2): the q that reaches a
  // given x slides by half a step every row. Clamping q to a fixed floor shears
  // the field into a parallelogram — the lower rows lose their left-hand cells.
  const rMin = Math.max(0, Math.floor(Math.max(tl.y, 0) / ROW_STEP) - 1);
  const rMax = Math.min(
    Math.ceil(doc.wall.heightMm / ROW_STEP),
    Math.ceil(br.y / ROW_STEP) + 1,
  );
  for (let r = rMin; r <= rMax; r++) {
    const xLo = Math.max(tl.x, 0);
    const xHi = Math.min(br.x, doc.wall.widthMm);
    const qMin = Math.floor(xLo / PITCH - r / 2) - 1;
    const qMax = Math.ceil(xHi / PITCH - r / 2) + 1;
    for (let q = qMin; q <= qMax; q++) {
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
  const R = (PITCH / Math.sqrt(3) - 1.6) / scale;
  const path = new Path2D();
  for (const c of cells) {
    const centre = toScreen(hexToMm(c));
    for (let i = 0; i < 6; i++) {
      const d = HEX_DIRS[i]!;
      if (set.has(hexKey({ q: c.q + d.q, r: c.r + d.r }))) continue;
      const a1 = (Math.PI / 180) * (60 * i - 60);
      const a2 = (Math.PI / 180) * (60 * i);
      path.moveTo(centre.x + R * Math.cos(a1), centre.y + R * Math.sin(a1));
      path.lineTo(centre.x + R * Math.cos(a2), centre.y + R * Math.sin(a2));
    }
  }
  return path;
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
