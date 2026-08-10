/**
 * App shell: wiring only.
 *
 * All the real work lives in pure modules (hex, tiling, bom, persist,
 * exporters) and in the Store. This file's job is to connect a pointer to a
 * command and a document to a panel — if logic starts accumulating here, it
 * belongs somewhere testable instead.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import catalogJson from '../catalog/catalog.json';
import { BEDS } from '../core/constants';
import { toCsv, toMarkdownChecklist, toPrintableHtml, downloadName } from '../core/exporters';
import { decodeShareUrl, encodeShareUrl, deserialize, serialize } from '../core/persist';
import { emptyDoc, Store, type EditorState, type DropResult } from '../core/store';
import { solveTiling, type PanelSize } from '../core/tiling';
import type { Catalog, Hex, Rotation } from '../core/types';
import { BomPanel } from './BomPanel';
import { CatalogPanel } from './CatalogPanel';
import { WallCanvas, ghostCells, type DragPayload } from './WallCanvas';
import { WallView3D } from './WallView3D';
import './App.css';

const catalog = catalogJson as unknown as Catalog;

type Theme = 'system' | 'light' | 'dark';

export function App() {
  const storeRef = useRef<Store | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new Store(loadInitialDoc(), catalog);
  }
  const store = storeRef.current;

  const [state, setState] = useState<EditorState>(() => store.getState());
  const [drag, setDrag] = useState<DragPayload | null>(null);
  const [dropCheck, setDropCheck] = useState<DropResult>({ ok: true });
  const [toast, setToast] = useState<{ text: string; kind: 'error' | 'warn' | 'ok' } | null>(null);
  const [filter, setFilter] = useState('');
  const [theme, setTheme] = useState<Theme>('system');
  /**
   * 3D is the default view. The wall is a physical object you hang things ON,
   * and a plan view hides the question that actually matters at the wall: how
   * far does this stick out, and does it foul its neighbour. The 2D plan stays
   * available because it is faster to aim precisely in.
   */
  const [view, setView] = useState<'3d' | '2d'>('3d');

  useEffect(() => store.subscribe(setState), [store]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  const say = useCallback((text: string, kind: 'error' | 'warn' | 'ok' = 'ok') => {
    setToast({ text, kind });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const bom = useMemo(
    () => store.bom(),
    // Recomputed whenever the document identity changes — the doc is immutable,
    // so identity is a sound dependency.
    [store, state.doc],
  );

  // --- drag lifecycle -----------------------------------------------------

  /**
   * The live drag, written synchronously so the very next pointer event can see
   * it. `drag` state drives rendering; this ref drives hit handling. Without it
   * the first move after grabbing is lost to the render round-trip — and a fast
   * enough gesture loses its drop entirely.
   */
  const dragRef = useRef<DragPayload | null>(null);

  const startDrag = useCallback((payload: DragPayload) => {
    dragRef.current = payload;
    setDrag(payload);
    setDropCheck({ ok: true });
  }, []);

  const beginPartDrag = useCallback(
    (partId: string) => startDrag({ partId, rotation: 0, grabOffset: { q: 0, r: 0 } }),
    [startDrag],
  );

  const beginItemDrag = useCallback(
    (itemIds: string[], grabOffset: Hex) => startDrag({ itemIds, rotation: 0, grabOffset }),
    [startDrag],
  );

  const onDragMove = useCallback(
    (cell: Hex) => {
      const d = dragRef.current;
      if (!d) return;
      const cells = ghostCells(d, cell, catalog, store.getState().doc);
      setDropCheck(store.checkPlacement(cells, new Set(d.itemIds ?? [])));
    },
    [store],
  );

  const onDrop = useCallback(
    (cell: Hex) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      const anchor = { q: cell.q - d.grabOffset.q, r: cell.r - d.grabOffset.r };
      let result: DropResult;
      if (d.partId !== undefined) {
        result = store.addItem(d.partId, anchor, d.rotation);
      } else {
        const ids = d.itemIds ?? [];
        // Read through the store, not a render-time snapshot: this runs from a
        // window listener that may outlive the render it was created in.
        const lead = store.getState().doc.items.find((i) => i.id === ids[0]);
        const delta = lead
          ? { q: anchor.q - lead.at.q, r: anchor.r - lead.at.r }
          : { q: 0, r: 0 };
        result = delta.q === 0 && delta.r === 0 ? { ok: true } : store.moveItems(ids, delta);
      }
      setDrag(null);
      if (!result.ok) {
        say(result.reason ?? 'That does not fit there', 'error');
        setDropCheck(result);
      } else {
        setDropCheck({ ok: true });
        if (result.warnings && result.warnings.length > 0) say(result.warnings[0]!, 'warn');
      }
    },
    [store, say],
  );

  const cancelDrag = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
    setDropCheck({ ok: true });
  }, []);

  // --- keyboard -----------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      const sel = state.selection;

      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); return; }
      if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault(); store.redo(); return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault(); store.select(state.doc.items.map((i) => i.id)); return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const r = store.duplicateItems(sel, { q: 1, r: 1 });
        if (!r.ok) say(r.reason ?? 'No room to duplicate', 'error');
        return;
      }
      if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        if (e.shiftKey) store.ungroupItems(sel); else store.groupItems(sel);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (sel.length) { e.preventDefault(); store.deleteItems(sel); }
        return;
      }
      if (e.key === 'Escape') { cancelDrag(); store.select([]); return; }
      if (e.key.toLowerCase() === 'r' && sel.length) {
        e.preventDefault();
        const r = store.rotateItems(sel, e.shiftKey ? -1 : 1);
        if (!r.ok) say(r.reason ?? 'No room to rotate', 'error');
        return;
      }
      const arrows: Record<string, Hex> = {
        ArrowLeft: { q: -1, r: 0 }, ArrowRight: { q: 1, r: 0 },
        ArrowUp: { q: 0, r: -1 }, ArrowDown: { q: 0, r: 1 },
      };
      const d = arrows[e.key];
      if (d && sel.length) {
        e.preventDefault();
        const r = store.moveItems(sel, d);
        if (!r.ok) say(r.reason ?? 'Blocked', 'error');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, state.selection, state.doc.items, say, cancelDrag]);

  // --- commands -----------------------------------------------------------

  const autoTile = useCallback(() => {
    const available: PanelSize[] = catalog.parts
      .filter((p) => p.type === 'panel' && p.panel)
      .map((p) => ({
        partId: p.id,
        columns: p.panel!.columns,
        rows: p.panel!.rows,
        widthMm: p.panel!.widthMm,
        heightMm: p.panel!.heightMm,
      }));
    const res = solveTiling({
      wall: state.doc.wall,
      bedId: state.doc.bedId,
      available,
      // MUST stay false. "Rotation" here swaps columns with rows, and 90° is
      // not a symmetry of a hex lattice — spinning a panel's measured cell
      // centres by 90° puts them 15.14 mm off the wall grid. With it enabled a
      // 3000 x 2000 wall produced 17,294 mm² of real panel-on-panel overlap:
      // panels that physically cannot be built.
      //
      // It is also unnecessary. `panel.columns/rows` are already expressed in
      // the wall frame by the scanner, which canonicalises each STL's drawn
      // orientation; `widthMm/heightMm` stay in the bed frame for printer fit.
      // Rotating again applied that conversion twice.
      allowRotation: false,
    });
    if (res.panels.length === 0) {
      say(res.warnings[0] ?? 'No panel fits that wall and printer', 'error');
      return;
    }
    store.setPanels(
      res.panels.map((p, i) => ({
        id: `p${i}`,
        partId: p.partId,
        origin: p.origin,
        columns: p.columns,
        rows: p.rows,
      })),
    );
    say(
      `${res.panels.length} panels · ${res.cellCount} cells · ${(res.coverage * 100).toFixed(1)}% covered`,
      'ok',
    );
  }, [state.doc.wall, state.doc.bedId, store, say]);

  const onExport = useCallback(
    (format: 'csv' | 'markdown' | 'print' | 'json') => {
      try {
        if (format === 'print') {
          const html = toPrintableHtml(bom, state.doc);
          const w = window.open('', '_blank');
          if (!w) { say('Popup blocked — allow popups to print', 'warn'); return; }
          w.document.write(html);
          w.document.close();
          return;
        }
        const map = {
          csv: { text: toCsv(bom), ext: 'csv', mime: 'text/csv' },
          markdown: { text: toMarkdownChecklist(bom, state.doc), ext: 'md', mime: 'text/markdown' },
          json: { text: serialize(state.doc), ext: 'json', mime: 'application/json' },
        } as const;
        const { text, ext, mime } = map[format];
        download(downloadName(state.doc, ext), text, mime);
        say(`Exported ${ext.toUpperCase()}`, 'ok');
      } catch (err) {
        say(`Export failed: ${(err as Error).message}`, 'error');
      }
    },
    [bom, state.doc, say],
  );

  const share = useCallback(() => {
    try {
      const url = encodeShareUrl(state.doc, window.location.href.split('#')[0] ?? '');
      window.history.replaceState(null, '', url);
      void navigator.clipboard?.writeText(url);
      say('Share link copied to clipboard', 'ok');
    } catch {
      say('Could not build a share link', 'error');
    }
  }, [state.doc, say]);

  const importJson = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = deserialize(String(reader.result ?? ''));
        if (!res.doc) {
          say(`Could not read that file: ${res.errors[0] ?? 'unrecognised format'}`, 'error');
          return;
        }
        store.replaceDoc(res.doc, 'Import layout');
        say(
          res.errors.length
            ? `Loaded with ${res.errors.length} problem(s) — ${res.errors[0]}`
            : 'Layout loaded',
          res.errors.length ? 'warn' : 'ok',
        );
      };
      reader.onerror = () => say('Could not read that file', 'error');
      reader.readAsText(file);
    },
    [store, say],
  );

  // --- render -------------------------------------------------------------

  const selectedPartIds = useMemo(() => {
    const ids = new Set<string>();
    for (const it of state.doc.items) if (state.selection.includes(it.id)) ids.add(it.partId);
    return ids;
  }, [state.doc.items, state.selection]);

  return (
    <div className="app">
      <header className="app__bar">
        <div className="app__brand">
          <span className="app__mark" aria-hidden="true" />
          <input
            className="app__name"
            value={state.doc.name}
            onChange={(e) => store.setName(e.target.value)}
            aria-label="Layout name"
          />
        </div>

        <div className="app__wall-controls">
          <label>
            Wall
            <input
              type="number"
              value={state.doc.wall.widthMm}
              min={50}
              step={10}
              onChange={(e) => store.setWall(Number(e.target.value), state.doc.wall.heightMm)}
              aria-label="Wall width in millimetres"
            />
          </label>
          <span aria-hidden="true">×</span>
          <label>
            <span className="visually-hidden">Height</span>
            <input
              type="number"
              value={state.doc.wall.heightMm}
              min={50}
              step={10}
              onChange={(e) => store.setWall(state.doc.wall.widthMm, Number(e.target.value))}
              aria-label="Wall height in millimetres"
            />
          </label>
          <span className="app__unit">mm</span>

          <label>
            Printer
            <select
              value={state.doc.bedId}
              onChange={(e) => store.setBed(e.target.value)}
              aria-label="Printer bed"
            >
              {BEDS.map((b) => (
                <option key={b.id} value={b.id}>{b.label}</option>
              ))}
            </select>
          </label>

          <button type="button" className="app__primary" onClick={autoTile}>
            Solve panels
          </button>

          <div className="app__viewtoggle" role="group" aria-label="View">
            <button
              type="button"
              aria-pressed={view === '3d'}
              onClick={() => setView('3d')}
            >
              3D
            </button>
            <button
              type="button"
              aria-pressed={view === '2d'}
              onClick={() => setView('2d')}
            >
              Plan
            </button>
          </div>
        </div>

        <div className="app__actions">
          <button type="button" onClick={() => store.undo()} disabled={!state.canUndo} title="Undo (Ctrl+Z)">Undo</button>
          <button type="button" onClick={() => store.redo()} disabled={!state.canRedo} title="Redo (Ctrl+Shift+Z)">Redo</button>
          <button type="button" onClick={share}>Share</button>
          <label className="app__import">
            Import
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importJson(f);
                e.target.value = '';
              }}
            />
          </label>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as Theme)}
            aria-label="Colour theme"
          >
            <option value="system">Auto</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </header>

      <div className="app__body">
        <aside className="app__rail">
          <CatalogPanel
            catalog={catalog}
            filter={filter}
            onFilterChange={setFilter}
            selectedPartId={[...selectedPartIds][0]}
            onDragStart={(partId) => beginPartDrag(partId)}
          />
        </aside>

        <main className="app__stage">
          {view === '3d' ? (
            <WallView3D
              doc={state.doc}
              catalog={catalog}
              selection={state.selection}
              drag={drag}
              dragRef={dragRef}
              placementValid={dropCheck.ok}
              onDragMove={onDragMove}
              onDrop={onDrop}
              onDragCancel={cancelDrag}
              onStartItemDrag={beginItemDrag}
              onSelect={(ids, additive) => {
                const expanded = store.expandSelection(ids);
                store.select(additive ? [...state.selection, ...expanded] : expanded);
              }}
            />
          ) : (
            <WallCanvas
              doc={state.doc}
              catalog={catalog}
              selection={state.selection}
              drag={drag}
              dragRef={dragRef}
              invalidCells={dropCheck.ok ? undefined : dropCheck.blockedCells}
              placementValid={dropCheck.ok}
              onDragMove={onDragMove}
              onDrop={onDrop}
              onDragCancel={cancelDrag}
              onStartItemDrag={beginItemDrag}
              onSelect={(ids, additive) => {
                const expanded = store.expandSelection(ids);
                store.select(additive ? [...state.selection, ...expanded] : expanded);
              }}
            />
          )}
          {toast && (
            <div className={`app__toast app__toast--${toast.kind}`} role="status">
              {toast.text}
            </div>
          )}
          {/* Each view owns its own corner text. A shell-level hint here sat on
              top of the canvas's scale readout, both 11px mono, both anchored
              bottom-left. */}
        </main>

        <aside className="app__bom">
          <BomPanel
            bom={bom}
            catalog={catalog}
            doc={state.doc}
            onExport={onExport}
            onSelectPart={(partId) =>
              store.select(state.doc.items.filter((i) => i.partId === partId).map((i) => i.id))
            }
          />
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function loadInitialDoc() {
  if (typeof window !== 'undefined' && window.location.hash.length > 1) {
    const res = decodeShareUrl(window.location.href);
    if (res.doc) return res.doc;
  }
  return emptyDoc();
}

function download(name: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type { Rotation };
