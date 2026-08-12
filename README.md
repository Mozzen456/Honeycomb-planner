# Honeycomb Planner

Lay out a Honeycomb Storage Wall on a real hex grid, and get back an exact list of everything
you have to print.

The grid is not decorative. Every position in the document is an axial hex coordinate derived
from the actual meshes in `./models/` — 23.600 mm cell pitch, 20.438 mm row step, measured to
within 1.8 × 10⁻⁴ mm across all seven panels. See **[HSW-SPEC.md](HSW-SPEC.md)** for how, and
**[DECISIONS.md](DECISIONS.md)** for why each call was made.

---

## Run it

```bash
npm install
npm run dev
```

Then: set your wall size, pick your printer, hit **Solve panels**, and drag accessories on.

```bash
npm test          # 515 tests over the pure engines
npm run typecheck
npm run build
```

Needs Node 18 or newer. `node_modules` is not committed — install it fresh rather than copying it
between machines, or the CLI shims will not be executable.

## Add your own models

**Drop an STL anywhere on the window** — or use **Import**. The file is measured in the browser and
you get a review dialog showing what was found: bounding box, volume, how far it stands off the
wall, its cell footprint, and a print estimate. Set the type, draw the footprint by clicking cells,
choose the insert it bolts to, and it joins the catalogue under **Imported**. It then behaves like
any other part — placeable, counted in the parts list, present in every export.

Two things about an imported part are marked wherever they appear, including on the printed sheet:

- a footprint the geometry could only **bound** rather than measure (that is the `est.` badge —
  see "Known limits" below), and
- a print estimate that is **modelled rather than sliced**, since a browser has no slicer. Reckon
  on ±30% for HSW-like parts and ±50% for anything very unlike them; it is fitted against 73 real
  PrusaSlicer results and its measured error per family is in `HSW-SPEC.md` §7. If you need a real
  number, slice the file.

Imports live in your browser (localStorage plus IndexedDB for the mesh), so they survive a reload
and never touch the generated catalogue. Remove one with the × on its tile.

For a permanent, sliced, reproducible entry, put the file in `./models/` and run the scanner
instead.

## Rebuild the catalogue

The catalogue is **generated, never hand-written**. Drop more STLs into `./models/` and:

```bash
python tools/scan.py            # measure new/changed files, append
python tools/scan.py --rescan   # re-measure everything from scratch
python tools/scan.py --verify   # rebuild and diff against the committed catalogue
python tools/report.py          # human-readable summary
python tools/calibrate_estimator.py   # re-fit the in-browser print estimator
```

Requires `trimesh`, `scipy`, `shapely`, `rtree`, `numpy`, and PrusaSlicer for print estimates
(it finds `prusa-slicer-console.exe` automatically; without it, estimates are marked stale
rather than guessed).

Anything the scanner cannot confidently classify lands in **[UNKNOWN.md](UNKNOWN.md)** with its
evidence. Correct it in `src/catalog/overrides.json`, keyed by part id — the scanner reads that
file and never writes it, so your correction survives every future rescan.

---

## How it is put together

Everything load-bearing is a pure function over an immutable document, tested without a browser.
The UI is a thin shell on top.

| Module | Does | Tests |
|---|---|---|
| `src/core/constants.ts` | the measured geometry, and nothing else | — |
| `src/core/hex.ts` | axial hex math, rotation, occupancy | `tests/hex.test.ts` |
| `src/core/tiling.ts` | panel tiling solver, seam detection | `tests/tiling.test.ts` |
| `src/core/bom.ts` | parts-list aggregation and validation | `tests/bom.test.ts` |
| `src/core/store.ts` | commands, placement rules, undo/redo | `tests/store.test.ts` |
| `src/core/persist.ts` | save/load/share, hostile-input tolerant | `tests/persist.test.ts` |
| `src/core/exporters.ts` | CSV, markdown, print page | `tests/exporters.test.ts` |
| `src/core/stl.ts` | STL reading, mesh measurement, print estimate | `tests/stl.test.ts` |
| `src/core/detect.ts` | footprint detection in the browser | `tests/detect.test.ts` |
| `src/core/importPart.ts` | an STL becomes a catalogue part | `tests/import.test.ts` |
| `src/core/userCatalog.ts` | imported parts, stored and merged | `tests/import.test.ts` |
| `src/ui/tokens.css` | the design token layer — nothing else defines a colour | see `TOKENS.md` |

Two rules the whole thing depends on:

1. **Position is always a hex coordinate.** Pixels exist only inside the renderer and the
   pointer handlers, and never enter the document.
2. **The document is immutable.** Every command returns a new one, which is what makes undo a
   list of snapshots rather than a reconstruction problem.

---

## Two views of the same wall

**3D is the default.** The wall is a thing you mount objects *on*, so the question at the wall is
how far something stands out and whether it fouls its neighbour — which a plan cannot show. Panels
are drawn as real 8 mm plates with hexagonal holes, and **every placed part is drawn from its own
STL**, oriented the way it actually mounts. Models load lazily, one per distinct part; until one
arrives — or if it cannot be fetched at all — that part falls back to a box at its measured size.

**Plan** is one click away and is faster for aiming precisely. Both drive the same document, so
they cannot disagree.

Right-drag orbits, shift-drag pans, the wheel zooms.

## Planning round a light switch

Add an obstacle — switch, socket, thermostat, pipe — in the parts-list panel, and the planner cuts
those cells out of whichever panels they land in. Those panels are no longer stock plates, so they
are listed separately and each comes with a block of parameters for the OpenSCAD honeycomb
customiser in `Customiser/`, which generates the plate. It runs on the same 23.6 mm lattice, so what
it prints drops straight into the wall.

## What the app enforces

- **Things may overlap, freely and silently.** Accessories bolt onto an insert and stand proud of
  the panel — mounting things on top of each other is what the wall is *for*. Warning about it
  would cry wolf on every second drop.
- **One insert per hole.** The single genuine impossibility: two parts that plug *into* a cell
  cannot share it, and that is refused with a reason naming the occupant.
- **Wall fixings are planned across the wall, not per plate.** The panels interlock and multi-cell
  inserts bridge the seams, so the sheet takes fixings at a spacing (~220 mm) rather than four per
  plate. On a 2400 × 1200 wall that is 74 screws, not 370.
- **Off-panel is refused**, and distinguished from a clash ("hangs off the panel edge — 2 cells
  unsupported" is a different problem from a hole that is already filled).
- **Seam crossing is flagged, not blocked.** An accessory spanning two panels is the classic HSW
  mistake, but sometimes it is fine — so you get told, and you decide.
- **Groups move and rotate as one rigid body.** If any member cannot land, none of them move.

## Keyboard

| | |
|---|---|
| `R` / `Shift+R` | rotate selection 60° |
| `Ctrl+D` | duplicate |
| `Ctrl+G` / `Ctrl+Shift+G` | group / ungroup |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `Ctrl+A` | select all |
| arrows | nudge one cell |
| `Delete` | remove |
| `Alt`+drag, middle-drag | pan |
| wheel / pinch | zoom |

---

## Known limits

- **29 of 51 parts are second-tier** — they bolt or plug into an *insert* rather than clipping to
  the wall. Geometry can measure how wide such a part is but cannot know which cells its
  installer will use, so their footprints are bounding-box estimates, flagged in the UI and in
  `UNKNOWN.md`. Correct them via `overrides.json`, or draw the real footprint in the import dialog.
- **The layout is comfortable from about 1000 px up.** Below that the top bar takes a second line
  and the catalogue becomes a strip above the wall; on a phone it is legible but cramped, which is
  a fair description of planning a garage wall on a phone.
- **`375x389-fixed.stl` needs a 400 × 400 bed.** It fits none of the common printers.
- Print estimates are for one specific recorded profile (`PLA-0.20mm-15pct-2perim-0.4nozzle`).
  They are real slices, not volume guesses, but they are not *your* profile.
