# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser planner for a Honeycomb Storage Wall (HSW): lay accessories out on a hex grid, get back an
exact list of what to print. The geometry is **measured from the STL files in `./models/`**, not
copied from any published description. `HSW-SPEC.md` records every number with its provenance,
`DECISIONS.md` records why each call was made, `PARKED.md` records what is still open.

## Commands

```bash
npm run dev          # Vite dev server
npm test             # vitest run — 515 tests
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + vite build (also copies models/ into dist/)

npx vitest run tests/hex.test.ts                    # one file
npx vitest run tests/store.test.ts -t "six times"   # one test by name
npx vitest                                          # watch
```

Python side (measurement + catalogue). Needs `trimesh scipy shapely rtree numpy`, and PrusaSlicer
for print estimates:

```bash
python tools/scan.py             # measure new/changed STLs, append to the catalogue
python tools/scan.py --rescan    # re-measure everything from a cold cache
python tools/scan.py --no-slice  # skip slicing (fast; estimates come out zeroed)
python tools/scan.py --verify    # rebuild and diff against the committed catalogue
python tools/report.py           # human-readable catalogue summary
```

`scan.py` shells out to PrusaSlicer. If it fails to start under the tool sandbox, run that command
with the sandbox disabled — the failure looks like a crash, not a permission error.

## The traps

These have each cost real debugging time. Read before touching geometry.

**`ROW_STEP` is `20.438`, not `23.6·√3/2` (= 20.43820).** The designer typed a rounded constant.
The difference is 0.0002 mm per row and 0.0034 mm across an 18-column panel — which is exactly the
error that stops panels lining up. Never "simplify" `src/core/constants.ts` into closed forms. A
consequence: hexagons do not tile *exactly*, so two cells compute a shared corner 0.0003 mm apart —
any code matching vertices by coordinate must snap first.

**`panelCells` staggers by `-ceil(r/2)`, not `-floor(r/2)`.** Both keep the block rectangular; they
pick opposite chiralities, and six of the seven shipped panels are chiral. `tests/panel-parity.test.ts`
checks the generated cell map against the footprints measured from the meshes — it is the guard, and
it also pins the one panel (`mk3s`) that must be hung 180° round.

**`allowRotation` must stay `false`.** 90° is not a symmetry of a hex lattice. With it on, a
3000 × 2000 wall produced 17,294 mm² of real panel-on-panel overlap. It is also unnecessary: the
scanner already canonicalises each STL's drawn orientation.

**Two frames, and confusing them is the classic bug.** `panel.columns`/`rows` are the wall-lattice
footprint and are the only thing deciding placement. `widthMm`/`heightMm` are the printed *bed*
footprint, used solely for printer fit.

**A fixing belongs to the part it passes through, and nothing else may claim it.** This
double-count class has appeared twice — once as 350 inserts asking for 700 wall screws, once as one
M3 hole buying two M3 bolts. The regression test in `tests/critic-bom.test.ts` §0 is now general
(any part vs anything it requires, any thread size); keep it that way rather than adding another
guard for one string.

**Wall fixings belong to the ASSEMBLY, not to a panel.** `tools/scan.py` writes
`requires: insert-countersunk × (4 + cells/50)` onto every panel part; multiplying that by the
number of plates gave 370 wall screws on a 2400 × 1200 wall — one every 88 mm. `src/core/fixings.ts`
plans them across the whole sheet at a spacing instead (~74, 26/m²), and `bom.ts` supersedes the
per-panel requirement for panels placed *as panels*. A panel part dropped as a loose item keeps its
own requirement, or its fixings would vanish.

**A fastener count must never come from the cell bound.** That bound is the bounding-box estimate
PARKED P1 says is not a measurement, and laundering it into a shopping list made a 7-cell shelf
with two pegs order seven inserts. `detect.mountPoints()` counts the mounting bosses on the wall
face and refuses to answer when the count is not stable across depth; the corrections live in
`src/catalog/overrides.json`, which both the scanner and the app now apply.

**A panel with `omit` is a CUSTOM panel and is not the stock STL any more.** It is generated from
the OpenSCAD customiser (`src/core/customiser.ts`), so it must never be counted as a copy of the
shipped file — you would print 50 plates and find four of them do not fit round the light switch.
Every derivation of a panel's cells must go through `placedPanelCells`, never `panelCells` on the
raw origin/columns/rows.

**Overlap is allowed.** The wall exists to mount things *on*, so accessories may share cells freely
and silently — no warning, no issue. The only impossibility is two parts that plug *into* a cell
(`type` `insert` or `fastener`) sharing one. See `isExclusive` in `src/core/store.ts`.

**There are now two footprint detectors and they must agree.** `tools/footprint.py` uses trimesh
and shapely; `src/core/detect.ts` uses a raster, because a browser has neither. `tests/detect.test.ts`
runs the TS one over all 51 shipped models and requires the same cells, tier and `needsReview` as
the committed catalogue. If you change either, that test is the contract — do not weaken it.
The axis permutations in `detect.ts` are **cyclic on purpose**: cyclic is a rotation, acyclic is a
reflection, and a mirrored footprint is silently wrong.

**Accepting a proposed footprint must not clear `needsReview`.** Only an actual edit does. A bound
promoted to a measurement by a click is the exact dishonesty PARKED P1 exists to prevent, and
`withFootprint` in `src/core/importPart.ts` is where that rule lives.

**A control inside the 3D canvas host needs `setPointerCapture` skipped.** The host captures the
pointer on `pointerdown`, which swallows the click of any button inside it. This made `Fit` and
`Front` dead to a mouse while working when called from code — see the guard in `WallView3D.tsx`.

**A scrolling panel inside the `100dvh` shell must `contain: layout paint`.** Without it the panel's
overflow propagates to the viewport, `documentElement.scrollHeight` grows past the window, and
focusing a catalogue tile scrolls the top bar off screen. `layout paint`, not `strict`: `strict`
implies `size` and collapses the grid track.

## Architecture

Everything load-bearing is a pure function over an immutable document, tested without a browser.
The UI is a thin shell.

- **`src/core/constants.ts`** — the measured geometry. Nothing else defines it.
- **`src/core/hex.ts`** — axial hex math (pointy-top), rotation, occupancy. Every other module
  depends on its exact semantics.
- **`src/core/tiling.ts`** — panel solver and seam detection.
- **`src/core/bom.ts`** — parts-list aggregation and `validate()`.
- **`src/core/store.ts`** — commands, placement rules, undo/redo.
- **`src/core/persist.ts` / `exporters.ts`** — save/load/share, CSV/markdown/print.
- **`src/core/stl.ts`** — STL parsing, mesh measurement, the fitted print estimator.
- **`src/core/detect.ts`** — the browser's footprint detector (raster port of `footprint.py`).
- **`src/core/importPart.ts`** — an STL plus a file name becomes a `CatalogPart`.
- **`src/core/userCatalog.ts`** — imported parts: validation, storage, merge with the generated
  catalogue. Ids carry a `user/` prefix so a collision is impossible.
- **`src/core/overrides.ts`** — human corrections to the generated catalogue, applied by the app
  as well as by the scanner.
- **`src/core/fixings.ts`** — where the wall fixings go, across the assembly.
- **`src/core/obstacles.ts`** — switches, sockets and pipes, as cells the wall must avoid.
- **`src/core/customiser.ts`** — a cut panel as OpenSCAD customiser parameters. The customiser is on
  the same lattice (23.6 / 20.438 / 8), flat-top where the wall is pointy-top, so the conversion is
  a 90° turn plus a stagger parity — pinned by round-trip in `tests/customiser.test.ts` for the same
  reason `panel-parity.test.ts` exists.

Two invariants the whole thing rests on:

1. **Position is always a `Hex`.** Millimetres appear in renderers and pointer handlers; pixels
   never enter the document.
2. **The document is immutable.** Every command returns a new one, which is what makes undo a list
   of snapshots (`Store.commit`) rather than a reconstruction problem. Selection travels *with* the
   snapshot, so undo restores it too.

`store.partCells()` and `bom.itemCells()` must agree exactly on which cells a placed part covers —
anchor handling and empty footprints included. When they disagreed, the editor accepted drops that
the BOM then reported as overlaps.

### Catalogue

Imported parts never go in `catalog.json`. They live in localStorage (metadata) and IndexedDB (the
STL bytes, for the 3D view) and are merged at read time by `mergeCatalog`, which memoises on
identity — `bom.ts` caches its part index in a `WeakMap` keyed on the `Catalog` object, so a fresh
merge per render would rebuild that index per render.

`src/catalog/catalog.json` is **generated — never hand-edit it.** Human corrections go in
`src/catalog/overrides.json`, keyed by part id; the scanner reads that file and never writes it, so
a correction survives every rescan. Parts the scanner will not guess at are marked `needsReview` and
listed in `UNKNOWN.md` (currently 27 of 51 — see PARKED.md P1 for why that is a property of the
model set, not a detector weakness).

The catalogue carries no wall-clock timestamp unless its content changed, which is what makes
`--verify` a byte-for-byte check.

`tools/scan.py` caches measurements on the STL's sha256 **plus `MEASURE_VERSION`**. Bump
`MEASURE_VERSION` whenever measurement logic changes meaning, or a rescan will silently reuse stale
results. Slices additionally cache on the profile hash.

### Two views

`WallView3D.tsx` (default) and `WallCanvas.tsx` (2D plan) drive the same store, so they cannot
drift. Both read their colours from the token layer via `getComputedStyle` and both need a
`MutationObserver` on `data-theme` to repaint — a theme switch changes no React state.

The live drag is held in a **ref**, written synchronously at gesture start, because `drag` state is
only visible after a render and a fast pointer can move and release before that lands. Catalogue
tiles are `draggable={false}` with `dragstart` cancelled: the gesture is Pointer Events only, and
letting the browser promote it to a native HTML5 drag swallows every subsequent pointer event.

In 3D, a panel is **one** extruded shape (union outline + one hole per cell), not one ring per cell.
Per-cell rings put two coincident 8 mm side walls inside solid material at every boundary, which is
what made the plate look thick. Part depth comes from the measured `projectionMm`, never from
`max(bbox)`.

Placed parts are drawn from their **real STL** (`src/ui/meshLibrary.ts`), loaded lazily and cached
per part id, with the measured box as placeholder and fallback. Orientation comes from re-running
`detect()` rather than from a second rule, so the mesh cannot disagree with the footprint. Only
geometry this view built is disposed on rebuild — a cached part mesh is shared by every placement
of that part, and disposing it would blank all of them.

### UI conventions

`src/ui/tokens.css` is the only place a colour, size, radius or duration is defined; `TOKENS.md`
documents the groups and carries the measured contrast table. Components consume tokens — no
literals. `base.css` strips `<button>` deliberately; the button component lives in `App.css`.

## Tests

`tests/acceptance.test.ts` is the product-level check: a 2400 × 1200 wall, solved, thirty
accessories placed, BOM reconciled against the placements, all three exports, and a save/load/share
round trip — run against the real generated catalogue.

`tests/critic-*.test.ts` were written by adversarial reviewers with fresh context. Some deliberately
**pin current, wrong behaviour** for findings that are still open, with a comment saying to invert
the test when fixed. If one of those starts failing, check whether you fixed the underlying defect
before "correcting" the expectation.

## Importing other agent configs

An OpenAI Codex config and a Gemini CLI config were both found at user level. If you want their MCP
servers, slash commands, subagents, skills or instructions brought across, reply `/import` to scan
and list what is importable, then `/import --yes=<digest>` (the scan output names the digest) to
apply the user-level items. If `/import` is unavailable on this surface, run `claude import` from a
terminal instead.
