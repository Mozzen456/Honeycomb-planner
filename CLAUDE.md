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
npm test             # vitest run — 394 tests
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + vite build

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

**Overlap is allowed.** The wall exists to mount things *on*, so accessories may share cells freely
and silently — no warning, no issue. The only impossibility is two parts that plug *into* a cell
(`type` `insert` or `fastener`) sharing one. See `isExclusive` in `src/core/store.ts`.

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
