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
import { BEDS, bedFor, CUSTOM_BED_ID, MAX_BED_MM, MIN_BED_MM } from '../core/constants';
import { computeBom, panelsForLine } from '../core/bom';
import { normaliseColor } from '../core/colors';
import { toCsv, toMarkdownChecklist, toPrintableHtml, downloadName } from '../core/exporters';
import { buildHoneycombMesh, toBinaryStl } from '../core/honeycomb';
import { proposePart, type ImportedPart, type ImportProposal } from '../core/importPart';
import { isModelFile, MODEL_ACCEPT } from '../core/modelFile';
import { applyOverrides, mountingOf, type MountingOverride } from '../core/overrides';
import { panelModelFileName, panelModelSpecFor } from '../core/panelModel';
import { decodeShareUrl, encodeShareUrl, deserialize, serialize } from '../core/persist';
import { resolveProjectParts, shoppableParts } from '../core/projectParts';
import {
  emptyDoc, MAX_WALL_MM, MIN_WALL_MM, Store, type EditorState, type DropResult,
} from '../core/store';
import { generatedPlateSizes, solveTiling, type PanelSize } from '../core/tiling';
import type { Catalog, Hex, InsertRequirement, PlacedPanel, Rotation } from '../core/types';
import {
  deleteModelBytes, loadUserParts, mergeCatalog, pruneWallPhotos, putModelBytes, saveUserParts,
  sweepOrphans, WALL_PHOTOS_KEPT,
} from '../core/userCatalog';
import { BomPanel } from './BomPanel';
import { ColorSwatch } from './ColorSwatch';
import { CatalogPanel } from './CatalogPanel';
import { ObstaclePanel } from './ObstaclePanel';
import { WallPhotoPanel } from './WallPhotoPanel';
import { ImportDialog } from './ImportDialog';
import { PartLibrary } from './PartLibrary';
import { forgetPhotoUrl, removePhoto, savePhoto } from './partPhotos';
import {
  clearMounting, loadUserOverrides, mergeOverrideFiles, setFootprint, setMounting,
  setRequires, toOverrideFile, toSetupFile,
  type UserOverrides,
} from '../core/userOverrides';
import { AlignPanel } from './AlignPanel';
import { PartInspector } from './PartInspector';
import { forgetPartMesh } from './meshLibrary';
import { forgetThumbnail } from './partThumbnails';
import { Icon } from './Icon';
import { ToolMenu } from './ToolMenu';
import { NumberField } from './NumberField';
import { WallCanvas, ghostCells, type DragPayload } from './WallCanvas';
import { WallView3D } from './WallView3D';
import './App.css';

/**
 * The generated catalogue with the human corrections in `overrides.json`
 * applied. The scanner applies the same file, so a rescan and the app agree.
 */
const shippedCatalog = catalogJson as unknown as Catalog;

type Theme = 'system' | 'light' | 'dark';

/** Where the chosen theme is remembered. Its own key, like every other store. */
const THEME_KEY = 'hsw.theme.v1';

/**
 * The theme this browser was left on, or `system` if it has never been said.
 *
 * Read defensively and through a try: a stored value is user input by the time
 * it comes back, and Safari throws on `localStorage` outright in private mode
 * rather than returning null. A theme is not worth failing to start over.
 */
function storedTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === 'light' || raw === 'dark' ? raw : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Which theme is actually on screen, given the browser's own preference.
 *
 * `system` is not a third look, it is "ask the OS" — so the button has to
 * resolve it before it can offer the opposite. Without `matchMedia` (jsdom, an
 * old engine) light is the safe assumption: it is what the stylesheet's bare
 * `:root` defines, so the answer matches what is painted.
 */
function effectiveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}


export function App() {
  /**
   * The catalogue is the generated one plus whatever the user imported.
   * `mergeCatalog` memoises on identity because `bom.ts` caches its part index
   * in a WeakMap keyed on the Catalog object — a fresh merge per render would
   * rebuild that index per render.
   */
  const initialParts = useRef(loadUserParts());
  const [userParts, setUserParts] = useState<ImportedPart[]>(() => initialParts.current.parts);
  /**
   * Corrections made in this browser, layered over the ones that ship. Both are
   * applied through the same `applyOverrides`, so a correction behaves
   * identically whether it has been committed to `overrides.json` yet or not.
   */
  const [userOverrides, setUserOverrides] = useState<UserOverrides>(() => loadUserOverrides());
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [aligning, setAligning] = useState(false);
  /** The library — the shop you pick parts out of before planning (D71). */
  const [browsing, setBrowsing] = useState(false);
  /**
   * An import that has been described and is waiting to be lined up.
   *
   * Alignment is the second half of an import, not an afterthought: a part
   * whose mounting face nobody chose sits wrong on the wall, and this is the
   * one moment somebody is certainly looking at it. The part is NOT in the
   * catalogue yet — its bytes are in IndexedDB (the inspector needs them to
   * draw the mesh) and nothing else has happened, so cancelling here leaves
   * only those bytes to sweep up.
   */
  const [pendingImport, setPendingImport] = useState<
    { part: ImportedPart; photo: Blob | null } | null
  >(null);

  /**
   * Corrections are applied AFTER the merge, not before.
   *
   * They used to be applied to the shipped catalogue and the imports bolted on
   * afterwards, which meant an override keyed on a `user/…` id was written,
   * exported and never applied — the part you had just lined up went on the
   * wall the way the detector guessed. Same class as D50: two owners of one
   * fact, and the one that reached the screen was the stale one. Now every part
   * goes through the same pipe, and the import flow can rely on it (D71).
   */
  const overrideFile = useMemo(
    () => mergeOverrideFiles(overridesJson, userOverrides),
    [userOverrides],
  );
  /** How many parts the pushable setup covers — shipped decisions and local ones. */
  const setupParts = useMemo(
    () => Object.keys(overrideFile.parts ?? {}).length,
    [overrideFile],
  );
  const catalog = useMemo(
    () => applyOverrides(mergeCatalog(shippedCatalog, userParts), overrideFile),
    [userParts, overrideFile],
  );

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
  /**
   * The wall fixing the user has picked, if any — a cell for a single fixing, a
   * junction's anchor for the four-cell one.
   *
   * Shell state and not the store's selection, because a fixing is not an item:
   * `selection` holds ids that every other consumer looks up in `doc.items`, and
   * a cell key in that list would be a stranger to all of them. It does not need
   * to travel with undo either — what a removal has to give back is the fixing,
   * not the fact that it was highlighted.
   */
  const [pickedFixing, setPickedFixing] = useState<Hex | null>(null);
  /**
   * The parts-list line whose plates are lit on the wall, by its partId.
   *
   * The LINE is stored, not the panel ids: the wall changes under it — solve
   * again, cut a plate round a switch — and a stored list of ids would light
   * plates that no longer answer to that line. Deriving on each render keeps the
   * highlight true to what the line means now, and clicking the same line again
   * turns it off.
   */
  const [litLine, setLitLine] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  /**
   * 3D is the default view. The wall is a physical object you hang things ON,
   * and a plan view hides the question that actually matters at the wall: how
   * far does this stick out, and does it foul its neighbour. The 2D plan stays
   * available because it is faster to aim precisely in.
   */
  const [view, setView] = useState<'3d' | '2d'>('3d');
  /**
   * Size plates to the chosen printer, instead of using the seven shipped ones.
   *
   * Not on the document: it changes what the NEXT solve produces, and a saved
   * layout already records what it produced. Storing it would let a reload
   * silently re-plan someone's wall.
   */
  const [sizeToPrinter, setSizeToPrinter] = useState(false);

  useEffect(() => store.subscribe(setState), [store]);

  /**
   * Sweep up after imports that were abandoned by closing the tab.
   *
   * The bytes go into IndexedDB before the alignment step so the inspector can
   * draw the real mesh, and `cancelImport` clears them on Cancel — but a closed
   * tab cannot run a handler, so a few megabytes are stranded, in the same
   * quota the 3D view's meshes come out of. Once, at startup, when no import
   * can be in flight; running it mid-session would race a pending part, whose
   * bytes are down and whose catalogue entry deliberately does not exist yet.
   *
   * Deliberately silent unless it finds something: "cleaned up 0 files" is not
   * news, and a message about storage nobody asked about is alarming.
   *
   * **Skipped entirely unless the part list was READ successfully.** "No
   * imports" and "could not look" are the same empty array, and acting on the
   * second one would delete every model and photo a person had uploaded
   * because Safari refused localStorage once. A destructive sweep needs to know
   * what is alive, not merely fail to see it.
   */
  const swept = useRef(false);
  useEffect(() => {
    if (swept.current) return;
    swept.current = true;
    if (!initialParts.current.readable) return;
    void sweepOrphans(catalog.parts).then((n) => {
      if (n > 0) say(`Cleared ${n} leftover file${n === 1 ? '' : 's'} from an abandoned import`, 'ok');
    });
    /*
     * And bound the wall photographs, which are NOT swept the same way.
     *
     * A part's photo is orphaned the moment no part claims it, and the
     * catalogue is the complete list of parts. There is no such list of
     * documents: a layout naming a photo id may be a file on disk or a link
     * nobody has opened yet. Nor can removing or replacing a photo drop its
     * bytes, because both are undoable and undo has to give the picture back.
     *
     * So this is a cache bound, not a collector: the newest few survive and the
     * open document's own photo is protected whatever its age. Startup only,
     * where no attach can be in flight — and silent, because a number of
     * photographs nobody asked about is alarming rather than useful.
     */
    void pruneWallPhotos(WALL_PHOTOS_KEPT, [store.getState().doc.photo?.id ?? '']);
    // Startup only. `catalog` is complete on the first render — imported parts
    // load synchronously from localStorage — so there is nothing to wait for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    // Remembered, or the button is a toggle that forgets between visits — and
    // both views repaint from the token layer on this attribute, so the choice
    // has to survive the reload that a shared link or a reopened file causes.
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // A browser refusing storage is not a reason to refuse the theme.
    }
  }, [theme]);

  /**
   * Which plates the lit line means, through `bom.panelsForLine` — the one
   * owner of that rule, so a click can never light a plate the line does not
   * count (a cut or bordered plate has left the stock line for a generated one).
   */
  const litPanelIds = useMemo(() => {
    if (litLine === null) return undefined;
    const ids = panelsForLine(state.doc, litLine);
    return ids.length > 0 ? new Set(ids) : undefined;
  }, [state.doc, litLine]);

  /**
   * The colour the wall would draw something in if nobody had chosen one.
   *
   * Read from the token layer at call time rather than kept in state: it changes
   * with the theme, and a swatch showing last theme's grey is a swatch that
   * opens the picker on the wrong colour. Cheap — it runs when a swatch renders,
   * not per frame.
   */
  const themeColor = (token: string, fallback: string): string => {
    if (typeof window === 'undefined') return fallback;
    const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    if (raw.length === 0) return fallback;
    /*
     * Through a canvas, because a TOKEN IS NOT A HEX COLOUR. `--accent` computes
     * to `rgb(87 174 232)` — the token layer builds it from an `--accent-rgb`
     * triple so one channel set can serve solid and translucent uses — and a
     * `<input type="color">` handed that shows BLACK, silently. The 2D context
     * normalises any CSS colour to `#rrggbb`, which is the one shape the picker
     * and `normaliseColor` both accept.
     */
    const probe = document.createElement('canvas').getContext('2d');
    if (!probe) return normaliseColor(raw) ?? fallback;
    probe.fillStyle = '#000000';
    probe.fillStyle = raw;
    const normalised = typeof probe.fillStyle === 'string' ? probe.fillStyle : '';
    return normaliseColor(normalised) ?? normaliseColor(raw) ?? fallback;
  };

  /**
   * The colour of the selection — but only when they agree.
   *
   * Three parts painted three colours have no one colour, and showing the first
   * one would offer to be cleared as if it were all of them. Undefined then, so
   * the swatch reads as "not one colour" and picking one paints them all.
   */
  const selectionColor = useMemo(() => {
    const colors = state.doc.colors?.items ?? {};
    const chosen = state.selection.map((id) => colors[id]);
    const first = chosen[0];
    return chosen.length > 0 && chosen.every((c) => c === first) ? first : undefined;
  }, [state.selection, state.doc.colors]);

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
        if (sel.length) { e.preventDefault(); store.deleteItems(sel); return; }
        /*
         * A picked wall fixing, and ONLY when nothing else is selected. Three
         * handlers now want this key — items here, the photograph in the plan
         * canvas, and this — and they are told apart by a condition rather than
         * by which listener runs first, exactly as D88 sets out.
         */
        if (pickedFixing) {
          e.preventDefault();
          const r = store.removeFixing(pickedFixing);
          if (r.ok) { setPickedFixing(null); say('Wall fixing removed — Ctrl+Z puts it back', 'ok'); }
          else say(r.reason ?? 'Could not remove that fixing', 'error');
        }
        return;
      }
      if (e.key === 'Escape') {
        cancelDrag(); store.select([]); setPickedFixing(null); setLitLine(null); return;
      }
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
  }, [store, state.selection, state.doc.items, say, cancelDrag, pickedFixing]);

  // --- commands -----------------------------------------------------------

  const autoTile = useCallback(() => {
    const shipped: PanelSize[] = catalog.parts
      .filter((p) => p.type === 'panel' && p.panel)
      .map((p) => ({
        partId: p.id,
        columns: p.panel!.columns,
        rows: p.panel!.rows,
        widthMm: p.panel!.widthMm,
        heightMm: p.panel!.heightMm,
      }));
    /*
     * Plates sized to the printer, or the seven that ship.
     *
     * Off by default, and that is deliberate: the shipped files are known-good
     * and someone who has already printed a stack of them should not have their
     * wall re-planned around plates nobody has tested. Switched on, the biggest
     * plate the chosen bed can hold is used instead — a 350 mm printer gets
     * 16 × 14, a Prusa Mini gets 8 × 7 — so choosing a bigger printer really
     * does give bigger parts and fewer seams.
     *
     * The border is included in the fit, because a bordered plate is wider than
     * its cells by the thickness on each side and would otherwise be planned to
     * exactly the bed and then not fit it.
     */
    const border = state.doc.frame
      ? Math.max(0, state.doc.frame.thicknessMm)
      : 0;
    const available: PanelSize[] = sizeToPrinter
      ? generatedPlateSizes(state.doc.bedId, border, state.doc.customBed)
      : shipped;
    const res = solveTiling({
      wall: state.doc.wall,
      bedId: state.doc.bedId,
      ...(state.doc.customBed ? { customBed: state.doc.customBed } : {}),
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
  }, [catalog, state.doc.wall, state.doc.bedId, state.doc.customBed, state.doc.frame,
      sizeToPrinter, store, say]);

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

  // --- model import (STL and 3MF) -------------------------------------------

  /**
   * Measure a dropped model and open the review dialog.
   *
   * Measuring is a few hundred milliseconds on the largest shipped panel, which
   * is long enough to look like nothing happened — hence the busy state. It runs
   * on the main thread deliberately: a worker would have to ship the catalogue
   * across for the classification step, and this is fast enough that the
   * complexity buys nothing.
   *
   * `await` rather than a plain call, because a 3MF is a ZIP and inflating it
   * goes through `DecompressionStream`. The `finally` is what keeps the busy
   * state honest across that — a rejected promise must clear it too, or a bad
   * file leaves "Measuring…" on screen for ever.
   */
  const importModel = useCallback(
    (file: File) => {
      setBusy(`Measuring ${file.name}…`);
      const reader = new FileReader();
      reader.onload = () => {
        const buffer = reader.result as ArrayBuffer;
        void proposePart(file.name, buffer, store.catalog)
          .then(async (proposal) => {
            modelBytes.current.set(proposal.part.id, buffer);
            /*
             * The bytes go to IndexedDB now, before the FIRST step opens.
             *
             * They used to be written between step 1 and step 2, when the
             * alignment stage needed the mesh. Step 1 needs it too now: with no
             * photograph chosen, the photo slot shows the part rendered from its
             * own model, and `meshLibrary` reads an imported part's bytes from
             * exactly here. Nothing else about the part is written, so
             * `cancelImport` still has one thing to undo — and it already swept
             * these at either step.
             */
            const stored = await putModelBytes(proposal.part.id, buffer);
            if (!stored) {
              say('This browser would not store the model, so the 3D views will draw a box', 'warn');
            }
            setImporting(proposal);
          })
          .catch((err: unknown) => {
            say(`Could not read ${file.name}: ${(err as Error).message}`, 'error');
          })
          .finally(() => setBusy(null));
      };
      reader.onerror = () => {
        setBusy(null);
        say(`Could not read ${file.name}`, 'error');
      };
      reader.readAsArrayBuffer(file);
    },
    [store, say],
  );

  /**
   * Bytes of the file being reviewed, held until the part is actually added.
   *
   * The ORIGINAL bytes, in whatever format they arrived: a 3MF is stored as a
   * 3MF and read back as one by `meshLibrary`. Converting on the way in would
   * mean the file in storage is not the file the person chose.
   */
  const modelBytes = useRef(new Map<string, ArrayBuffer>());

  /**
   * Step 1 finished: hand the described part to the alignment step.
   *
   * The bytes go into IndexedDB HERE rather than at the end, because the
   * inspector draws the part from its own model and `meshLibrary` fetches an
   * imported part's bytes from exactly that store. Nothing else is written —
   * the part is not in `userParts`, not in the catalogue and not in the
   * project — so `cancelImport` has one thing to undo.
   */
  const beginAlignImport = useCallback((part: ImportedPart, photo: Blob | null) => {
    // The bytes are already in IndexedDB — `importModel` put them there so the
    // first step could render the part. Nothing left to do but change step.
    setImporting(null);
    setPendingImport({ part, photo });
  }, []);

  /** Abandon an import at either step. Nothing survives it but a log line. */
  const cancelImport = useCallback((partId: string) => {
    modelBytes.current.delete(partId);
    void deleteModelBytes(partId);
    forgetPartMesh(partId);
    forgetThumbnail(partId);
    setPendingImport(null);
    setImporting(null);
  }, []);

  /**
   * Step 2 finished: the part joins the library, with its alignment and photo,
   * and goes straight into the project.
   *
   * Straight into the project because it was just uploaded for this wall —
   * making someone find their own upload in the library to add it is the one
   * step in the shopping metaphor that would only ever be friction.
   *
   * The alignment is written as an OVERRIDE, the same record the inspector
   * writes for a shipped part, rather than baked into the stored part: one
   * mechanism, one export, and `Setup (n)` carries an imported part's mounting
   * to the repo exactly like everything else.
   */
  const finishImport = useCallback(
    (
      part: ImportedPart,
      photo: Blob | null,
      mounting: MountingOverride,
      footprint: readonly Hex[],
      sockets: readonly Hex[],
      requires: readonly InsertRequirement[],
    ) => {
      setUserParts((prev) => {
        const next = [...prev.filter((p) => p.id !== part.id), part];
        const problem = saveUserParts(next);
        if (problem !== null) say(problem, 'warn');
        return next;
      });
      setUserOverrides((prev) => {
        const withFace = setMounting(prev, part.id, mounting, 'lined up when it was uploaded');
        const withCells = setFootprint(
          withFace, part.id, footprint, sockets, 'lined up when it was uploaded',
        );
        return setRequires(withCells, part.id, requires);
      });
      if (photo !== null) {
        void savePhoto(part.id, photo).then((stored) => {
          if (!stored) say('Added, but this browser would not store the photo', 'warn');
        });
      }
      modelBytes.current.delete(part.id);
      // Both caches are keyed on part id and an id can be reused by a later
      // import, so neither may carry a previous model's shape into this one.
      forgetPartMesh(part.id);
      forgetThumbnail(part.id);
      store.addToProject([part.id]);
      setPendingImport(null);
      say(`${part.name} is in your library and in this project — drag it onto the wall`, 'ok');
    },
    [store, say],
  );

  /** Delete an upload from the library for good — model, photo and all. */
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
      void removePhoto(partId);
      // Every cache is keyed on part id, and an imported id can be reused by a
      // later import of a different model. Leaving any behind would show the
      // removed part's picture under the new one's name.
      forgetPartMesh(partId);
      forgetThumbnail(partId);
      forgetPhotoUrl(partId);
      // It cannot stay in the project when it no longer exists.
      store.removeFromProject(partId);
      say('Deleted from your library', 'ok');
    },
    [store, say],
  );

  // --- the project's parts --------------------------------------------------

  const addToProject = useCallback(
    (partId: string) => {
      store.addToProject([partId]);
      const part = catalog.parts.find((p) => p.id === partId);
      say(`${part?.name ?? partId} added — it is in the rail, ready to drag on`, 'ok');
    },
    [store, catalog, say],
  );

  const removeFromProject = useCallback(
    (partId: string) => {
      const result = store.removeFromProject(partId);
      if (!result.ok) say(result.reason ?? 'That part is in use', 'error');
    },
    [store, say],
  );

  /** One entry point for both kinds of file, so a drop never has to be aimed. */
  const importFile = useCallback(
    (file: File) => {
      if (isModelFile(file.name)) importModel(file);
      else if (/\.json$/i.test(file.name)) importJson(file);
      else say(`${file.name} is not a model (.stl or .3mf) or a saved layout`, 'error');
    },
    [importModel, importJson, say],
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

  /**
   * Generate a plate and hand it to the browser as an STL.
   *
   * Built here rather than in the panel that shows the button, for the same
   * reason the exports are: a component that renders a list should not also own
   * a Blob and an object URL. `panelModelSpecFor` is the single place that knows
   * which cells a plate really has — the planner's view of a framed edge and the
   * printer's are deliberately different (D56).
   */
  const downloadPlate = useCallback(
    (panel: PlacedPanel, label: string) => {
      try {
        const spec = panelModelSpecFor(panel, state.doc);
        const mesh = buildHoneycombMesh({
          cells: spec.cells, clipped: spec.clipped, border: spec.border,
        });
        const stl = toBinaryStl(mesh, `${state.doc.name} — ${label}`);
        const name = panelModelFileName(`${state.doc.name} ${label}`, spec.cells.length);
        const url = URL.createObjectURL(new Blob([stl], { type: 'model/stl' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        say(`${name} — ${mesh.triangleCount.toLocaleString()} triangles`, 'ok');
      } catch (e) {
        say(e instanceof Error ? e.message : 'That plate could not be generated', 'error');
      }
    },
    [state.doc, say],
  );

  // --- render -------------------------------------------------------------

  const selectedPartIds = useMemo(() => {
    const ids = new Set<string>();
    for (const it of state.doc.items) if (state.selection.includes(it.id)) ids.add(it.partId);
    return ids;
  }, [state.doc.items, state.selection]);

  /**
   * What the rail shows: the parts shopped for this wall, resolved once.
   *
   * One resolver for the rail and the library, so they cannot come to different
   * views about what the project contains — the recurring failure in this
   * codebase is two readers of one fact (D50, D52, D57, D66).
   */
  const project = useMemo(
    () => resolveProjectParts(state.doc, catalog),
    [state.doc, catalog],
  );

  /**
   * The printer this document means, resolved once.
   *
   * `bedFor` is the only thing that turns a bed id plus a typed size into a bed,
   * so the fields below show what the SOLVER will use — clamped, not what was
   * typed — and a custom bed cannot be honoured by one reader and ignored by the
   * next.
   */
  const bed = useMemo(
    () => bedFor(state.doc.bedId, state.doc.customBed),
    [state.doc.bedId, state.doc.customBed],
  );

  /**
   * How many parts "Browse parts" actually offers.
   *
   * `catalog.parts.length` counted the seven wall plates, which are not on sale
   * — the app generates every plate it draws (D97) — so the button promised
   * seven parts the library will not show.
   */
  const shoppable = useMemo(() => shoppableParts(catalog), [catalog]);

  return (
    <div className="app">
      {/*
        * Two tiers, because the bar was carrying two different kinds of thing at
        * one weight: what this DOCUMENT is and what you can do to the app (the
        * title bar), against the parameters that decide what the next solve
        * produces (the toolbar). Twenty controls in one undifferentiated row is
        * the single loudest "unfinished" tell the product had.
        */}
      <header className="app__header">
        <div className="app__titlebar">
          <div className="app__brand">
            <span className="app__mark" aria-hidden="true" />
            <div className="app__identity">
              <input
                className="app__name"
                value={state.doc.name}
                onChange={(e) => store.setName(e.target.value)}
                aria-label="Layout name"
              />
              {/* What the title is actually describing. It reads off the
                  document, so it is never a caption for a wall that has since
                  been re-solved. */}
              <p className="app__docmeta tabular-nums">
                {state.doc.wall.widthMm} × {state.doc.wall.heightMm} mm
                <span className="app__docmeta-sep" aria-hidden="true">·</span>
                {state.doc.panels.length} {state.doc.panels.length === 1 ? 'plate' : 'plates'}
                <span className="app__docmeta-sep" aria-hidden="true">·</span>
                {state.doc.items.length} placed
              </p>
            </div>
          </div>

          {/*
            * The logo, in the gap between what you are working on and what you
            * can do to it.
            *
            * A background-image on a labelled box rather than an `<img>`,
            * because there are TWO artworks — the lettering in the supplied file
            * is dark grey and disappears on the dark theme's near-black bar — and
            * CSS is the only thing that can choose between them through the same
            * `prefers-color-scheme` + `[data-theme]` pair the token layer already
            * uses. Two `<img>` tags with one hidden would fetch both.
            *
            * Deliberately NOT a link: the document lives in memory, an unsaved
            * layout is one click from gone, and it would be navigating to the
            * page you are already on.
            */}
          <div
            className="app__logo"
            role="img"
            aria-label="honeycombplanner.com"
            title="honeycombplanner.com"
          />

          <div className="app__titleactions">
            <div className="app__actiongroup" role="group" aria-label="History">
              <button
                type="button"
                className="iconbutton"
                onClick={() => store.undo()}
                disabled={!state.canUndo}
                aria-label="Undo"
                title="Undo (Ctrl+Z)"
              >
                <Icon name="undo" />
              </button>
              <button
                type="button"
                className="iconbutton"
                onClick={() => store.redo()}
                disabled={!state.canRedo}
                aria-label="Redo"
                title="Redo (Ctrl+Shift+Z)"
              >
                <Icon name="redo" />
              </button>
            </div>

            <span className="app__actiondivider" aria-hidden="true" />

            {/* File in, link out — the two things a person does with a whole
                layout, so they keep their words. Everything else up here is an
                icon. */}
            <label className="button button--subtle app__import" title="Add a model (.stl or .3mf), or open a saved layout">
              <Icon name="import" />
              Import
              <input
                type="file"
                accept={`${MODEL_ACCEPT},application/json,.json`}
                multiple
                onChange={(e) => {
                  for (const f of e.target.files ?? []) importFile(f);
                  e.target.value = '';
                }}
              />
            </label>
            <button type="button" className="button button--subtle" onClick={share}>
              <Icon name="share" />
              Share
            </button>

            {/*
              * Buy Me a Coffee, in the service's own yellow so it is recognised
              * as the thing it is rather than read as another app control.
              *
              * `target="_blank"` is not a preference here, it is the same rule
              * the logo follows: the document lives in memory and an unsaved
              * layout is one click from gone, so nothing in this bar may
              * navigate the tab away. `rel="noopener noreferrer"` because the
              * destination is somebody else's page.
              */}
            <a
              className="app__coffee"
              href="https://buymeacoffee.com/mort1hag"
              target="_blank"
              rel="noopener noreferrer"
              title="Support the planner — opens buymeacoffee.com in a new tab"
            >
              <Icon name="coffee" />
              <span className="app__coffee__label">Buy me a coffee</span>
            </a>

            {/*
              * The catalogue-maintenance channel, folded into one control.
              *
              * Align, Setup and Mine are the developer front doors described
              * under "Correcting a part's mounting" — a person planning a wall
              * never opens them — and in the flat bar they took a third of it at
              * the same weight as Undo. Nothing is lost: each is one click away
              * and still carries its own count.
              */}
            <ToolMenu
              label="Catalogue setup"
              heading="Catalogue setup"
              items={[
                {
                  id: 'align',
                  label: 'Align every part…',
                  icon: 'target',
                  hint: "Compare every part's mounting face against the peg measured from its own model",
                  onSelect: () => setAligning(true),
                },
                {
                  id: 'setup',
                  label: 'Download setup',
                  detail: String(setupParts),
                  icon: 'download',
                  hint: 'Download the setup for every part — mounting, cells, sockets and fasteners — to replace src/catalog/overrides.json and commit',
                  onSelect: downloadSetup,
                },
                ...(Object.keys(userOverrides.parts).length > 0
                  ? [{
                    id: 'mine',
                    label: 'Download my changes',
                    detail: String(Object.keys(userOverrides.parts).length),
                    icon: 'download' as const,
                    hint: 'Download only what was corrected in this browser, as a small diff',
                    onSelect: downloadOverrides,
                  }]
                  : []),
              ]}
            />

            <span className="app__actiondivider" aria-hidden="true" />

            {/*
              * Last in the bar, so it sits in the top-right corner where a theme
              * switch is looked for. A BUTTON and not the three-way select it
              * replaces: "auto" is a state you leave rather than one you pick, so
              * the control offers the one thing you actually want — the other
              * theme — and resolving `system` first is what lets it say which.
              */}
            <button
              type="button"
              className="iconbutton"
              onClick={() => setTheme(effectiveTheme(theme) === 'dark' ? 'light' : 'dark')}
              title={
                effectiveTheme(theme) === 'dark'
                  ? 'Switch to the light theme'
                  : 'Switch to the dark theme'
              }
              aria-label={
                effectiveTheme(theme) === 'dark'
                  ? 'Switch to the light theme'
                  : 'Switch to the dark theme'
              }
            >
              <Icon name={effectiveTheme(theme) === 'dark' ? 'sun' : 'moon'} />
            </button>
          </div>
        </div>

        <div className="app__toolbar">
          {/*
            * Three clusters, each in its own well: the WALL, the PRINTER, and
            * the action that turns the two into plates. Grouping is the whole
            * point — the bar's controls are not a list, they are three questions
            * with an answer button, and drawn as a flat row of equals they read
            * as neither.
            */}
          <div className="toolbar__group">
            <Icon name="ruler" className="toolbar__groupicon" />
            <label className="toolbar__field">
              <span className="toolbar__label">Wall</span>
              <NumberField
                value={state.doc.wall.widthMm}
                min={MIN_WALL_MM}
                max={MAX_WALL_MM}
                step={10}
                onCommit={(v) => store.setWall(v, state.doc.wall.heightMm)}
                aria-label="Wall width in millimetres"
              />
            </label>
            <span className="toolbar__times" aria-hidden="true">×</span>
            <label className="toolbar__field">
              <span className="visually-hidden">Height</span>
              <NumberField
                value={state.doc.wall.heightMm}
                min={MIN_WALL_MM}
                max={MAX_WALL_MM}
                step={10}
                onCommit={(v) => store.setWall(state.doc.wall.widthMm, v)}
                aria-label="Wall height in millimetres"
              />
            </label>
            <span className="app__unit">mm</span>
          </div>

          <div className="toolbar__group">
            <Icon name="printer" className="toolbar__groupicon" />
            <label className="toolbar__field">
              <span className="toolbar__label">Printer</span>
              <select
                value={state.doc.bedId}
                onChange={(e) => {
                  store.setBed(e.target.value);
                  // Typing a bed size is only ever a request to GENERATE plates
                  // for it — with "Fit to printer" off the size would just filter
                  // the seven shipped plates, and the solve would look as if the
                  // number had been ignored. Visible and reversible: the checkbox
                  // next to it ticks.
                  if (e.target.value === CUSTOM_BED_ID) setSizeToPrinter(true);
                }}
                aria-label="Printer bed"
              >
                {BEDS.map((b) => (
                  <option key={b.id} value={b.id}>{b.label}</option>
                ))}
                <option value={CUSTOM_BED_ID}>Custom…</option>
              </select>
            </label>

            {/*
              * The build plate, when it is not one of the presets.
              *
              * `commitOn: 'confirm'`, like a blocked zone's size and unlike the
              * wall's: there is no live preview to watch — the bed decides what
              * the NEXT solve generates — so committing per keystroke would put
              * three sizes nobody chose into the undo stack on the way to 300.
              */}
            {state.doc.bedId === CUSTOM_BED_ID && bed !== undefined && (
              <>
                <label className="toolbar__field">
                  <span className="visually-hidden">Build plate width</span>
                  <NumberField
                    value={bed.width}
                    min={MIN_BED_MM}
                    max={MAX_BED_MM}
                    step={10}
                    commitOn="confirm"
                    onCommit={(v) => store.setCustomBed(v, bed.depth)}
                    aria-label="Build plate width in millimetres"
                  />
                </label>
                <span className="toolbar__times" aria-hidden="true">×</span>
                <label className="toolbar__field">
                  <span className="visually-hidden">Build plate depth</span>
                  <NumberField
                    value={bed.depth}
                    min={MIN_BED_MM}
                    max={MAX_BED_MM}
                    step={10}
                    commitOn="confirm"
                    onCommit={(v) => store.setCustomBed(bed.width, v)}
                    aria-label="Build plate depth in millimetres"
                  />
                </label>
                <span className="app__unit">mm</span>
              </>
            )}

            <label className="app__fitprinter" title="Generate plates as large as this printer can hold, instead of using the seven shipped ones">
              <input
                type="checkbox"
                checked={sizeToPrinter}
                onChange={(e) => setSizeToPrinter(e.target.checked)}
              />
              Fit to printer
            </label>
          </div>

          <button type="button" className="button button--primary app__primary" onClick={autoTile}>
            <Icon name="solve" />
            Solve panels
          </button>

          {/*
            * The view switch, immediately after the action that fills the wall
            * and BEFORE the spacer.
            *
            * It used to sit in the far corner of the bar, behind the colours,
            * as two 12px words — and the Plan is not a minor mode. It is where
            * you measure, block out a light switch, set the border and line the
            * wall up against a photograph, none of which exist in 3D. Half of
            * the product was one grey word in the corner. So: bigger, labelled,
            * in the reading path, and the inactive half is drawn at SECONDARY
            * rather than tertiary — see the note in App.css, a tab in the
            * metadata colour reads as one you are not allowed to press.
            */}
          <div className="app__viewswitch" role="group" aria-label="View">
            <span className="app__viewswitch__label" aria-hidden="true">View</span>
            <div className="app__viewtoggle">
              <button
                type="button"
                aria-pressed={view === '3d'}
                onClick={() => setView('3d')}
                title="See the wall as it will be built"
              >
                <Icon name="wall" size="md" />
                3D
              </button>
              <button
                type="button"
                aria-pressed={view === '2d'}
                onClick={() => setView('2d')}
                title="Measure, block out zones, set the border and line up a photograph of your wall"
              >
                <Icon name="plan" size="md" />
                Plan
              </button>
            </div>
          </div>

          {/* Everything after this is pushed to the far end: what the wall LOOKS
              like. A colour is a property of the wall, like its size and its
              printer, not an action you take. */}
          <span className="toolbar__spacer" />

          {/*
            * The two defaults, and — only while something is selected — the one
            * that paints it.
            */}
          <div className="app__colors toolbar__group" role="group" aria-label="Colours">
            <Icon name="palette" className="toolbar__groupicon" />
            <ColorSwatch
              label="Colour for the panels"
              value={state.doc.colors?.panels}
              fallback={themeColor('--canvas-panel-tint', '#c8ced6')}
              onChange={(c) => store.setDefaultColor('panels', c, 'Colour the panels')}
              onClear={() => store.setDefaultColor('panels', undefined, 'Clear the panel colour')}
            />
            <span className="app__colors__label">Panels</span>
            <ColorSwatch
              label="Colour for the accessories and fasteners"
              value={state.doc.colors?.parts}
              fallback={themeColor('--accent', '#3d7ea6')}
              onChange={(c) => store.setDefaultColor('parts', c, 'Colour the parts')}
              onClear={() => store.setDefaultColor('parts', undefined, 'Clear the part colour')}
            />
            <span className="app__colors__label">Parts</span>
            {/* Only with a selection. A swatch that silently paints nothing is
                worse than no swatch: you pick a colour, the wall does not
                change, and the control has told you nothing about why. */}
            {state.selection.length > 0 && (
              <>
                <ColorSwatch
                  label={`Colour the ${state.selection.length} selected`}
                  value={selectionColor}
                  fallback={themeColor('--accent', '#3d7ea6')}
                  onChange={(c) => store.setItemColor(state.selection, c, 'Colour selected parts')}
                  onClear={() =>
                    store.setItemColor(state.selection, undefined, 'Clear the colour')}
                />
                <span className="app__colors__label">
                  Selected ({state.selection.length})
                </span>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="app__body">
        <aside className="app__rail">
          <CatalogPanel
            parts={project.parts}
            missing={project.missing}
            catalogSize={shoppable.length}
            onBrowse={() => setBrowsing(true)}
            filter={filter}
            onFilterChange={setFilter}
            selectedPartId={[...selectedPartIds][0]}
            onDragStart={(partId) => beginPartDrag(partId)}
            onActivate={placePartFromKeyboard}
            onRemovePart={removeFromProject}
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
              litPanelIds={litPanelIds}
              pickedFixing={pickedFixing}
              onPickFixing={setPickedFixing}
              onMoveFixing={(from, to) => {
                const r = store.moveFixing(from, to);
                if (r.ok) setPickedFixing(to);
                else say(r.reason ?? 'That fixing cannot go there', 'error');
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
              litPanelIds={litPanelIds}
              placementValid={dropCheck.ok}
              onDragMove={onDragMove}
              onDrop={onDrop}
              onDragCancel={cancelDrag}
              onStartItemDrag={beginItemDrag}
              onObstaclesChange={(obstacles) => store.setObstacles(obstacles)}
              onFrameChange={(frame) => store.setFrame(frame)}
              onPhotoChange={(photo) => store.setPhoto(photo)}
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
              <p className="app__empty-title">
                <Icon name="sparkle" size="md" />
                Start with the wall
              </p>
              <ol className="app__empty-steps">
                <li>Set the size of your wall and pick your printer, above.</li>
                <li>
                  Press <strong>Solve panels</strong> and the planner works out which panels
                  to print and how they tile.
                </li>
                <li>
                  Press <strong>Browse parts</strong> on the left, add the hooks, shelves and
                  bins you want, then drag them from the rail onto the cells.
                </li>
              </ol>
              <p className="app__empty-note">
                Got your own model? Drop an STL or 3MF anywhere on this window. You give it a photo,
                line it up against the wall, and it joins your library.
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
            onSelectPart={(partId) => {
              // Both halves of "show me this line": the placed ITEMS get
              // selected, and the PLATES light up. A line is one or the other in
              // practice — a panel line has no items, an accessory line has no
              // plates — so this is one gesture with one meaning rather than two
              // behaviours to remember. Clicking the same line again turns it
              // off, which is the only way back for a panel line: a plate is not
              // selectable, so Escape-the-selection does not cover it.
              store.select(state.doc.items.filter((i) => i.partId === partId).map((i) => i.id));
              setLitLine((current) => (current === partId ? null : partId));
              setPickedFixing(null);
            }}
            litLine={litLine}
            onSetLineColor={(lineKey, color) => store.setLineColor(lineKey, color)}
            onClearColors={() => store.clearColors()}
            onSetPrinted={(partId, count) => store.setPrinted(partId, count)}
            onBumpPrinted={(partId, delta, max) => store.bumpPrinted(partId, delta, max)}
            onResetPrinted={() => store.clearPrinted()}
            onResetFixings={() => { store.resetFixings(); setPickedFixing(null); }}
            extras={
              <>
                {/* Above the zones, because it is what you line them up
                    against — and the order the job actually happens in. */}
                <WallPhotoPanel
                  doc={state.doc}
                  onChange={(photo) => store.setPhoto(photo)}
                  onProblem={(message) => say(message, 'error')}
                />
                <ObstaclePanel
                  doc={state.doc}
                  onChange={(obstacles) => store.setObstacles(obstacles)}
                  onFrameChange={(frame) => store.setFrame(frame)}
                  onDownload={downloadPlate}
                  onCopy={(text, what) => {
                    void navigator.clipboard?.writeText(text);
                    say(`${what} settings copied — paste them into the customiser`, 'ok');
                  }}
                />
              </>
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

      {browsing && (
        <PartLibrary
          catalog={catalog}
          doc={state.doc}
          onAdd={addToProject}
          onRemove={removeFromProject}
          onInspect={(partId) => { setBrowsing(false); setInspecting(partId); }}
          onDelete={removeImportedPart}
          onUpload={(files) => { for (const f of files) importFile(f); }}
          onClose={() => setBrowsing(false)}
        />
      )}

      {importing !== null && (
        <ImportDialog
          proposal={importing}
          catalog={catalog}
          onCancel={() => cancelImport(importing.part.id)}
          onConfirm={beginAlignImport}
        />
      )}

      {/*
        The second half of an import: the same alignment tool a shipped part
        gets, on a part that is not in the catalogue yet.

        It is handed a catalogue with the pending part merged in — the inspector
        looks its subject up there, and `meshLibrary` reads an imported part's
        bytes from IndexedDB, which is why they were written before this opened.
      */}
      {pendingImport !== null && (
        <PartInspector
          key={pendingImport.part.id}
          part={pendingImport.part}
          catalog={mergeCatalog(catalog, [pendingImport.part])}
          intent="import"
          onSave={(m, footprint, sockets, requires) =>
            finishImport(pendingImport.part, pendingImport.photo, m, footprint, sockets, requires)}
          onClear={() => cancelImport(pendingImport.part.id)}
          onClose={() => cancelImport(pendingImport.part.id)}
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
