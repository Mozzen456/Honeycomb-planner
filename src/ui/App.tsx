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
import overridesJson from '../catalog/overrides.json';
import { BEDS } from '../core/constants';
import { computeBom } from '../core/bom';
import { toCsv, toMarkdownChecklist, toPrintableHtml, downloadName } from '../core/exporters';
import { proposePart, type ImportedPart, type ImportProposal } from '../core/importPart';
import { applyOverrides, mountingOf, type MountingOverride } from '../core/overrides';
import { decodeShareUrl, encodeShareUrl, deserialize, serialize } from '../core/persist';
import { emptyDoc, Store, type EditorState, type DropResult } from '../core/store';
import { solveTiling, type PanelSize } from '../core/tiling';
import type { Catalog, Hex, InsertRequirement, Rotation } from '../core/types';
import {
  deleteModelBytes, loadUserParts, mergeCatalog, putModelBytes, saveUserParts,
} from '../core/userCatalog';
import { BomPanel } from './BomPanel';
import { CatalogPanel } from './CatalogPanel';
import { ObstaclePanel } from './ObstaclePanel';
import { ImportDialog } from './ImportDialog';
import {
  clearMounting, loadUserOverrides, mergeOverrideFiles, setFootprint, setMounting,
  setRequires, toOverrideFile, toSetupFile,
  type UserOverrides,
} from '../core/userOverrides';
import { AlignPanel } from './AlignPanel';
import { PartInspector } from './PartInspector';
import { forgetPartMesh } from './meshLibrary';
import { forgetThumbnail } from './partThumbnails';
import { WallCanvas, ghostCells, type DragPayload } from './WallCanvas';
import { WallView3D } from './WallView3D';
import './App.css';

/**
 * The generated catalogue with the human corrections in `overrides.json`
 * applied. The scanner applies the same file, so a rescan and the app agree.
 */
const shippedCatalog = catalogJson as unknown as Catalog;

type Theme = 'system' | 'light' | 'dark';

export function App() {
  /**
   * The catalogue is the generated one plus whatever the user imported.
   * `mergeCatalog` memoises on identity because `bom.ts` caches its part index
   * in a WeakMap keyed on the Catalog object — a fresh merge per render would
   * rebuild that index per render.
   */
  const [userParts, setUserParts] = useState<ImportedPart[]>(() => loadUserParts().parts);
  /**
   * Corrections made in this browser, layered over the ones that ship. Both are
   * applied through the same `applyOverrides`, so a correction behaves
   * identically whether it has been committed to `overrides.json` yet or not.
   */
  const [userOverrides, setUserOverrides] = useState<UserOverrides>(() => loadUserOverrides());
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [aligning, setAligning] = useState(false);

  const baseCatalog = useMemo(
    () => applyOverrides(shippedCatalog, mergeOverrideFiles(overridesJson, userOverrides)),
    [userOverrides],
  );
  /** How many parts the pushable setup covers — shipped decisions and local ones. */
  const setupParts = useMemo(
    () => Object.keys(mergeOverrideFiles(overridesJson, userOverrides).parts ?? {}).length,
    [userOverrides],
  );
  const catalog = useMemo(() => mergeCatalog(baseCatalog, userParts), [baseCatalog, userParts]);

  const storeRef = useRef<Store | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new Store(loadInitialDoc(), catalog);
  }
  const store = storeRef.current;
  useEffect(() => store.setCatalog(catalog), [store, catalog]);

  const [state, setState] = useState<EditorState>(() => store.getState());
  const [importing, setImporting] = useState<ImportProposal | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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

  /*
   * The parts list is a pure function of the document and the catalogue, so it
   * is computed from those two directly rather than through the store.
   *
   * Going through `store.bom()` looked equivalent and was not. The store's
   * catalogue is set in an EFFECT (`store.setCatalog`), which runs after the
   * render — so on the render where a correction has just changed the
   * catalogue, `store.bom()` still reads the old one, and by the next render
   * the memo has nothing new to react to. The list kept showing the old
   * fastener until an unrelated edit moved an item: you would set a part to
   * insert-M5, place it, and be told to print insert-empty.
   *
   * `computeBom` is pure and memoised on both immutable inputs, which is what
   * `bom.ts` was written to be. No ordering to get right.
   */
  const bom = useMemo(() => computeBom(state.doc, catalog), [state.doc, catalog]);

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

  /**
   * Enter on a catalogue tile, which places the part rather than starting a drag
   * no keyboard can finish (see `activateFromKeyboard`).
   *
   * The search for a cell is `Store.firstFittingCell`, so it is tested without a
   * browser and shares `addItem`'s gate. The part arrives SELECTED, which hands
   * the rest of the job to keys that already exist: arrows move it, R rotates,
   * Delete removes it.
   */
  const placePartFromKeyboard = useCallback(
    (partId: string) => {
      const doc = store.getState().doc;
      if (doc.panels.length === 0) {
        say('Solve the panels first — there is no wall to place it on', 'error');
        return;
      }
      const at = store.firstFittingCell(partId);
      if (at === null) {
        say('No room on the wall for that part', 'error');
        return;
      }
      const result = store.addItem(partId, at, 0);
      if (!result.ok) {
        say(result.reason ?? 'That does not fit there', 'error');
        return;
      }
      const placed = store.getState().doc.items.at(-1);
      if (placed) store.select([placed.id]);
      say('Placed — arrow keys move it, R rotates, Delete removes it', 'ok');
    },
    [store, say],
  );


  // --- mounting corrections -------------------------------------------------

  /**
   * A hand-picked mounting face. Saved locally so it applies at once and
   * survives a reload, and exportable into `src/catalog/overrides.json` so the
   * scanner honours it too — a browser cannot write into the repo.
   *
   * `forgetPartMesh` is the load-bearing half: the oriented geometry is cached
   * per part id, so without dropping it the correction would change the
   * catalogue and leave the old mesh on the wall.
   */
  const applyMounting = useCallback(
    (partId: string, mounting: MountingOverride, why: string) => {
      setUserOverrides((prev) => setMounting(prev, partId, mounting, why));
      forgetPartMesh(partId);
      forgetThumbnail(partId);
    },
    [],
  );

  /**
   * Both answers the inspector gives, saved together.
   *
   * The mounting says which way round the part goes and where it sits; the
   * footprint says how much wall it takes. They are separate facts about the
   * same part, written into the same entry — which is why `setMounting` and
   * `setFootprint` merge rather than replace, or saving one would drop the
   * other.
   */
  const saveMounting = useCallback(
    (
      partId: string,
      mounting: MountingOverride,
      footprint: readonly Hex[],
      sockets: readonly Hex[],
      requires: readonly InsertRequirement[],
    ) => {
      setUserOverrides((prev) => {
        const withFace = setMounting(prev, partId, mounting, 'mounting picked by hand');
        const withCells = setFootprint(
          withFace, partId, footprint, sockets, 'mounting picked by hand',
        );
        return setRequires(withCells, partId, requires);
      });
      forgetPartMesh(partId);
      // The catalogue preview draws the ORIENTED mesh, so it is now stale too.
      forgetThumbnail(partId);
      setInspecting(null);
      say('Mounting saved — Download overrides to keep it in the repo', 'ok');
    },
    [say],
  );

  const dropMounting = useCallback(
    (partId: string) => {
      setUserOverrides((prev) => clearMounting(prev, partId));
      forgetPartMesh(partId);
      forgetThumbnail(partId);
      setInspecting(null);
      say('Correction cleared — back to the detector\u2019s own answer', 'ok');
    },
    [say],
  );

  /**
   * The whole setup, for pushing: every part that carries a correction, shipped
   * or made here, in the file's own shape. This is what goes over
   * `src/catalog/overrides.json` and gets committed — the app and `tools/scan.py`
   * both read that file, so a pushed setup reaches everyone and every rescan.
   */
  const downloadSetup = useCallback(() => {
    download('overrides.json', toSetupFile(overridesJson, userOverrides), 'application/json');
    say('Setup downloaded — replace src/catalog/overrides.json with it and commit', 'ok');
  }, [userOverrides, say]);

  /** ...and just what was decided in this browser, when a small diff is wanted. */
  const downloadOverrides = useCallback(() => {
    const text = toOverrideFile(userOverrides);
    if (Object.keys(JSON.parse(text).parts ?? {}).length === 0) {
      say('No corrections made in this browser yet', 'warn');
      return;
    }
    download('overrides.mine.json', text, 'application/json');
  }, [userOverrides, say]);

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

  // --- STL import ---------------------------------------------------------

  /**
   * Measure a dropped model and open the review dialog.
   *
   * Measuring is a few hundred milliseconds on the largest shipped panel, which
   * is long enough to look like nothing happened — hence the busy state. It runs
   * on the main thread deliberately: a worker would have to ship the catalogue
   * across for the classification step, and this is fast enough that the
   * complexity buys nothing.
   */
  const importStl = useCallback(
    (file: File) => {
      setBusy(`Measuring ${file.name}…`);
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const buffer = reader.result as ArrayBuffer;
          const proposal = proposePart(file.name, buffer, store.catalog);
          stlBytes.current.set(proposal.part.id, buffer);
          setImporting(proposal);
        } catch (err) {
          say(`Could not read ${file.name}: ${(err as Error).message}`, 'error');
        } finally {
          setBusy(null);
        }
      };
      reader.onerror = () => {
        setBusy(null);
        say(`Could not read ${file.name}`, 'error');
      };
      reader.readAsArrayBuffer(file);
    },
    [store, say],
  );

  /** Bytes of the file being reviewed, held until the part is actually added. */
  const stlBytes = useRef(new Map<string, ArrayBuffer>());

  const addImportedPart = useCallback(
    (part: ImportedPart) => {
      setUserParts((prev) => {
        const next = [...prev.filter((p) => p.id !== part.id), part];
        const problem = saveUserParts(next);
        if (problem !== null) say(problem, 'warn');
        return next;
      });
      const bytes = stlBytes.current.get(part.id);
      if (bytes) {
        // The mesh is what the 3D view draws. Losing it costs the mesh and
        // nothing else, so a browser that refuses IndexedDB still gets a part.
        void putModelBytes(part.id, bytes).then((stored) => {
          if (!stored) say('Added, but this browser would not store the model for the 3D view', 'warn');
        });
        stlBytes.current.delete(part.id);
      }
      setImporting(null);
      say(`Added ${part.name} — it is in the catalogue under Imported`, 'ok');
    },
    [say],
  );

  const removeImportedPart = useCallback(
    (partId: string) => {
      const placed = store.getState().doc.items.filter((i) => i.partId === partId).length;
      if (placed > 0) {
        say(`${placed} placement${placed === 1 ? ' uses' : 's use'} that part — delete those first`, 'error');
        return;
      }
      setUserParts((prev) => {
        const next = prev.filter((p) => p.id !== partId);
        const problem = saveUserParts(next);
        if (problem !== null) say(problem, 'warn');
        return next;
      });
      void deleteModelBytes(partId);
      // Both caches are keyed on part id, and an imported id can be reused by a
      // later import of a different model. Leaving either behind would show the
      // removed part's shape under the new one's name.
      forgetPartMesh(partId);
      forgetThumbnail(partId);
      say('Removed from the catalogue', 'ok');
    },
    [store, say],
  );

  /** One entry point for both kinds of file, so a drop never has to be aimed. */
  const importFile = useCallback(
    (file: File) => {
      if (/\.stl$/i.test(file.name)) importStl(file);
      else if (/\.json$/i.test(file.name)) importJson(file);
      else say(`${file.name} is neither an STL model nor a saved layout`, 'error');
    },
    [importStl, importJson, say],
  );

  // Drop anywhere on the window. The wall itself is a drag target for placing
  // parts, so a file dropped on it must not be mistaken for a placement — the
  // check is on `dataTransfer.files`, which a part drag never carries.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };
    const drop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();
      for (const file of files) importFile(file);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [importFile]);

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
          <button
            type="button"
            onClick={() => setAligning(true)}
            title="Compare every part's mounting face against the peg measured from its own model"
          >
            Align
          </button>
          {/* Only once there is something to export. A browser cannot write into
              the repo, so this is how a hand-picked mounting face reaches
              `src/catalog/overrides.json` and, through it, the scanner. */}
          <button
            type="button"
            onClick={downloadSetup}
            title="Download the setup for every part — mounting, cells, sockets and fasteners — to replace src/catalog/overrides.json and commit"
          >
            Setup ({setupParts})
          </button>
          {Object.keys(userOverrides.parts).length > 0 && (
            <button
              type="button"
              onClick={downloadOverrides}
              title="Download only what was corrected in this browser, as a small diff"
            >
              Mine ({Object.keys(userOverrides.parts).length})
            </button>
          )}
          <label className="app__import" title="Add an STL model, or open a saved layout">
            Import
            <input
              type="file"
              accept=".stl,model/stl,application/json,.json"
              multiple
              onChange={(e) => {
                for (const f of e.target.files ?? []) importFile(f);
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
            onActivate={placePartFromKeyboard}
            onRemovePart={removeImportedPart}
            onInspect={setInspecting}
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
          {/*
            First-run guidance on the largest surface in the product, which
            otherwise opened as an empty black rectangle with a line of
            keyboard hints in the corner. It goes when the wall does, and it
            never eats a pointer event: the stage underneath is a drop target,
            and a panel dropped where this text sits must still land.
          */}
          {state.doc.panels.length === 0 && state.doc.items.length === 0 && (
            <div className="app__empty" aria-hidden="true">
              <p className="app__empty-title">Start with the wall</p>
              <ol className="app__empty-steps">
                <li>Set the size of your wall and pick your printer, above.</li>
                <li>
                  Press <strong>Solve panels</strong> and the planner works out which panels
                  to print and how they tile.
                </li>
                <li>Drag hooks, shelves and bins from the catalogue onto the cells.</li>
              </ol>
              <p className="app__empty-note">
                Got your own model? Drop an STL anywhere on this window and it is measured,
                classified and added to the catalogue.
              </p>
            </div>
          )}

          {busy !== null && (
            <div className="app__toast app__toast--ok" role="status">{busy}</div>
          )}
          {toast && busy === null && (
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
            extras={
              <ObstaclePanel
                doc={state.doc}
                onChange={(obstacles) => store.setObstacles(obstacles)}
                onCopy={(text, what) => {
                  void navigator.clipboard?.writeText(text);
                  say(`${what} settings copied — paste them into the customiser`, 'ok');
                }}
              />
            }
          />
        </aside>
      </div>

      {aligning && (
        <AlignPanel
          catalog={catalog}
          onApply={(partId, mounting) =>
            applyMounting(partId, mounting, 'mounting face taken from the measured peg')}
          onInspect={(partId) => { setAligning(false); setInspecting(partId); }}
          onClose={() => setAligning(false)}
        />
      )}

      {inspecting !== null && (() => {
        const part = catalog.parts.find((p) => p.id === inspecting);
        if (!part) return null;
        return (
          <PartInspector
            /*
             * Keyed on the part, so switching parts REMOUNTS the dialog.
             * Every control in it seeds its state from the part it opened on —
             * the face, the cells, the sockets, the six seating numbers — and
             * React keeps state across a prop change, so without this a second
             * part would inherit the first one's alignment and quietly offer to
             * save it.
             */
            key={part.id}
            part={part}
            catalog={catalog}
            current={mountingOf(part)}
            onSave={(m, footprint, sockets, requires) =>
              saveMounting(part.id, m, footprint, sockets, requires)}
            onClear={() => dropMounting(part.id)}
            onClose={() => setInspecting(null)}
          />
        );
      })()}

      {importing !== null && (
        <ImportDialog
          proposal={importing}
          catalog={catalog}
          onCancel={() => {
            stlBytes.current.delete(importing.part.id);
            setImporting(null);
          }}
          onConfirm={addImportedPart}
        />
      )}
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
