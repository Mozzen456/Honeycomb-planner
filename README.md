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

Then: set your wall size, pick your printer, hit **Solve panels**, press **Browse parts…** to pick
what you want on the wall, and drag it on from the rail.

```bash
npm test          # 1078 tests over the pure engines
npm run typecheck
npm run build
```

Needs Node 18 or newer. `node_modules` is not committed — install it fresh rather than copying it
between machines, or the CLI shims will not be executable.

## Shopping for parts

The catalogue is a shop, and the rail on the left is what you took from it. **Browse parts…** opens
the library: every part as a card with a picture, its type, how many cells it takes, and what it
costs to print, with shelves for accessories, inserts, fasteners, panels and your own uploads.
**Add to project** puts a part in the rail, ready to drag onto the wall.

The parts you chose are saved with the layout, so they travel down a share link — and anything you
place on the wall counts as chosen whether you added it first or not.

## Add your own models

**Drop an STL or a 3MF anywhere on the window** — or use **Upload a model** in the library. The
file is measured in the browser and you get a review dialog showing what was found: bounding box,
volume, how far it stands off the wall, its cell footprint, and a print estimate.

Set the type, draw the footprint by clicking cells, choose the insert it bolts to, and **add a photo
of the printed part** — the library shows that instead of the render, because a photo tells you what
the thing is and a render only tells you the shape.

A 3MF is read with its **units and placement applied**: a model drawn in inches is converted to
millimetres and says so, and the transforms that place its objects are honoured, so the part arrives
the size and the way round it was exported. If the file holds several placed objects — a whole build
plate rather than one model — they are merged into a single part and you are told, so you can go back
and export just the one you meant.

Then you **line it up**: the same alignment tool the shipped parts get, showing your model against a
patch of real wall. Pick the face that mounts, nudge and turn it until it sits right, and it joins
your library. That step is not optional — the detector cannot work out which face mounts for about
half of these models, and a part added without an answer sits wrong on the wall. From then on it
behaves like any other part: placeable, counted in the parts list, present in every export.

Two things about an imported part are marked wherever they appear, including on the printed sheet:

- a footprint the geometry could only **bound** rather than measure (that is the `est.` badge —
  see "Known limits" below), and
- a print estimate that is **modelled rather than sliced**, since a browser has no slicer. Reckon
  on ±30% for HSW-like parts and ±50% for anything very unlike them; it is fitted against 73 real
  PrusaSlicer results and its measured error per family is in `HSW-SPEC.md` §7. If you need a real
  number, slice the file.

Imports live in your browser (localStorage for the details, IndexedDB for the mesh and the photo),
so they survive a reload and never touch the generated catalogue. Photos are scaled down to 640 px
before they are stored, because that storage is shared with the meshes the 3D view needs. Delete an
upload with the × on its library card; the × on a rail tile only takes the part out of this project.

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
| `src/core/bom.ts` | parts-list aggregation, printed counts, validation | `tests/bom.test.ts` |
| `src/core/store.ts` | commands, placement rules, undo/redo | `tests/store.test.ts` |
| `src/core/persist.ts` | save/load/share, hostile-input tolerant | `tests/persist.test.ts` |
| `src/core/exporters.ts` | CSV, markdown, print page | `tests/exporters.test.ts` |
| `src/core/stl.ts` | STL reading, mesh measurement, print estimate | `tests/stl.test.ts` |
| `src/core/threemf.ts` | 3MF reading — units, transforms, winding | `tests/threemf.test.ts` |
| `src/core/detect.ts` | footprint detection in the browser | `tests/detect.test.ts` |
| `src/core/importPart.ts` | an STL or 3MF becomes a catalogue part | `tests/import.test.ts` |
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

## A photograph of your wall

A switch is not "about 1200 up" — it is where it is, and the way you find out is to stand in front
of the wall with a camera. So you can lay a photograph under the plan and drag the blocked zones
onto the things they represent.

Press `P` for the **Photo** tool and add a picture. Then **Set scale**, and drag between two points
whose real distance apart you know — the ends of a tape laid against the wall, the width of a door
frame — and type that distance. The photo scales about the *first* point you clicked, so a corner
you can name stays exactly where you put it. Until you do this the photo is only *fitted* to the
wall, which is a guess, and the panel says so.

It shows in both views, at an opacity you set, either **behind** the honeycomb — where the room
shows through the open cells, which is what you want while placing zones — or **in front** of it,
for checking a finished plan against the wall it was drawn from.

The alignment is part of the layout: it undoes, it saves, and it travels down a share link. The
image itself cannot — it lives in this browser. Open the layout somewhere else and it knows exactly
where the photograph goes and asks you for the picture by name; attach it again and the scale you
measured is kept.

## Tick off what you have printed

A wall is not printed in one go, so the parts list keeps count. Each line has a **printed** stepper —
`−`, a number you can type, `+`, and **all** for a whole batch — and the number on the left is what is
**still to print**. The footer leads with the same figure for the whole wall: *still to print, 130 of
142*. **Reset printed** starts the count again.

The counts are saved with the layout and travel down a share link, and every export carries them: the
CSV gains `printed` and `to_print`, the markdown checklist counts down and ticks its own boxes, and
the printable sheet puts what is left in the quantity column with the finished lines already ticked.

There is deliberately **no print time**. The estimate belongs to whichever machine and profile the
catalogue was sliced with, so it is wrong for anyone else's printer, and "19 h 15 min" for a garage
wall is not a number you can act on. Filament is still there — it is what you buy — as a figure for
the whole job.

## Colour it in

Two swatches at the top set the defaults — one colour for the panels, one for everything that clips
into them — and the wall repaints in both views. From there:

- **a whole line**: the swatch beside any parts-list line colours everything it counts, so the k1
  plates can be blue while the rest stay white;
- **one particular thing**: select parts on the wall and the top bar grows a **Selected** swatch that
  paints just those.

Clicking a swatch opens a small picker — twelve filament colours, your own through **Custom…**, or a
hex you type — and **nothing changes until you press OK**; Cancel and Escape throw the choice away.
The Parts colour covers everything that clips into the wall, including the inserts and wall fixings
the planner puts in itself, and anything you drop in afterwards arrives in it. Each swatch shows the colour that thing will actually be — its own, or the one it inherits —
so the parts list doubles as a key to the wall. The × beside a swatch gives it back to the default, and the
footer lists the colours the build actually uses (a default nothing falls back to is not a spool you
have to buy). The colours are saved with the layout, travel down a share link, and appear on every
export, so the sheet at the printer says which filament to load.

## Find a part on the wall

Click any line in the parts list and the wall lights up what it is talking about: a panel line lights
those plates — in 3D and in the plan — and an accessory line selects its placements. Click the same
line again, or press Escape, to turn it off.

A plate cut round a light switch or carrying a border is counted on its own line, so it lights up
from that line and not from the shipped one. What lights up is exactly what the line counts.

## Move the wall fixings

The planner works out where the wall fixings go — spread across the whole assembly at a spacing,
with a four-cell insert wherever three or four plates meet — and in 3D you can argue with it. Click
one to pick it, drag it to another cell, or press Delete to take it out; `Ctrl+Z` undoes any of it.
A junction fastener can be removed but not moved, because its job is to straddle the corner where
the plates meet.

Your changes ride on the layout, so they survive a re-solve, a save and a share link, and the parts
list says how many you overruled with a **Reset fixings** button beside it. Take the last fixing off
a plate and the list warns you that nothing is holding it.

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

On the plan, the tools are modal — most of them are drags on empty wall, and a marquee, a
measurement, a new zone and a photograph being slid about cannot all be that at once. `Esc` always
returns to Select.

| | |
|---|---|
| `V` | select — move parts, and zones by their handles |
| `M` | measure between two points, snapping (`Shift` turns snapping off) |
| `B` | drag a blocked zone (`Shift` adds a rectangle to the selected one, making an L) |
| `P` | the wall photograph — drag it, set its scale, `Delete` takes it off |
| `E` | border on or off, all four sides |

---

## Known limits

- **27 of 51 parts are second-tier** — they bolt or plug into an *insert* rather than clipping to
  the wall. Geometry can measure how wide such a part is but cannot know which cells its
  installer will use, so their footprints are bounding-box estimates, flagged in the UI and in
  `UNKNOWN.md`. Correct them via `overrides.json`, or draw the real footprint in the import dialog.
- **The layout is comfortable from about 1000 px up.** Below that the top bar takes a second line
  and the catalogue becomes a strip above the wall; on a phone it is legible but cramped, which is
  a fair description of planning a garage wall on a phone.
- **`375x389-fixed.stl` needs a 400 × 400 bed.** It fits none of the common printers.
- Print estimates are for one specific recorded profile (`PLA-0.20mm-15pct-2perim-0.4nozzle`).
  They are real slices, not volume guesses, but they are not *your* profile.
