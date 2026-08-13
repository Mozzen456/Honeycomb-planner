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
npm test             # vitest run — 593 tests
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

python tools/calibrate_estimator.py          # re-fit the in-browser print estimator
python tools/calibrate_estimator.py --write  # ...and rewrite tests/fixtures/
```

`calibrate_estimator.py` needs PrusaSlicer but **not** trimesh, so it runs where `scan.py` cannot.
Same for `tools/slicer.py`, which knows the macOS bundle path as well as the Windows one.

If `npm` is missing, Node is not installed: `. ~/.nvm/nvm.sh && nvm install --lts`. A `node_modules`
copied from another platform will fail with "Permission denied" on the CLI shims rather than
anything informative — delete it and reinstall.

`scan.py` shells out to PrusaSlicer. If it fails to start under the tool sandbox, run that command
with the sandbox disabled — the failure looks like a crash, not a permission error.

## The traps

These have each cost real debugging time. Read before touching geometry.

**`ROW_STEP` is `20.438`, not `23.6·√3/2` (= 20.43820).** The designer typed a rounded constant.
The difference is 0.0002 mm per row and 0.0034 mm across an 18-column panel — which is exactly the
error that stops panels lining up. Never "simplify" `src/core/constants.ts` into closed forms. A
consequence: hexagons do not tile *exactly*, so two cells compute a shared corner 0.0003 mm apart —
any code matching vertices by coordinate must snap first.

**`panelCells` staggers by `-floor(q/2)`, not `-ceil(q/2)`.** Both keep the block rectangular; they
pick opposite chiralities, and six of the seven shipped panels are chiral. `tests/panel-parity.test.ts`
checks the generated cell map against the footprints measured from the meshes — it is the guard.
The parity that keeps a block unmirrored depends on the FRAME: it was `-ceil(r/2)` while the wall
was pointy-top, and turning the wall flipped it (D35). It was not chosen — `floor` is the value
that reproduces all seven measured footprints and `ceil` reproduces none. Since the turn no panel
needs to be hung 180° round, `mk3s` included; that was the old frame's parity disagreeing with how
the panel is drawn, not a property of the plate.

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

**The wall is FLAT-TOP, and that is settled (D31/D35).** It used to be drawn pointy-top, 90° from
the designer's own dimensioned drawings — `wall-honeycomb-part` measured 177 × 170.32 where the
drawing says 170.32 × 177. `FITTING_SEAT_RADIANS` is gone with it: a mesh loaded from a FILE is
drawn flat-top and now seats in its hole unturned.

The correction did not vanish, it INVERTED, and this is the live trap. Geometry the VIEW builds for
itself — the collar, the placeholder prisms, the drag ghost — needs the half-face turn that real
meshes no longer do, because `CylinderGeometry(…, 6).rotateX(90°)` lands its corners on a
POINTY-top cell. That lives in one helper, `cellPrism` in `WallView3D.tsx`; do not inline a bare
`CylinderGeometry` for anything that has to sit in a cell. `tests/fitting-seat.test.ts` pins it.

**Never re-derive the embedding. Call `hexToMm` / `mmToHex`.** This is the single most expensive
mistake in the repo's history. Three separate copies of the inverse survived the frame turn because
none of them named the function they duplicated: `cellAt` in `WallView3D` (every 3D hit test, drop
included, landed several cells from the pointer), `visibleCells` in `WallCanvas` (an eighth of an
empty wall had no grid drawn), and a private `hexRound3`. All three passed a 557-test suite. A
FOURTH turned up later in the footprint editor — `x = PITCH·(q + r/2)`, the *transpose* of
`hexToMm`, so the cells you drew came out mirrored from the cells that landed (D42). After any
change to the frame, grep for `/ ROW_STEP` and `/ PITCH` outside `hex.ts` and read every hit.

**`meshLibrary` must NOT apply the 90° spin that `toAxial` applies.** `toAxial` spins a
POINTY-drawn part's CELLS so its footprint lands on the flat-top lattice; applying the same turn to
the MESH points an SD-card holder's slots sideways. A part is drawn in the orientation it is used.
(It was the FLAT-drawn part that needed spinning while the wall was pointy-top — the rule did not
change, the wall did.)

**Coverage cannot tell a flange from the end of a block** — a rectangle contains the hexagon
inscribed in it, so both score ~1.0. `detectWallClip` scores `coverage × hexagonality`, where
hexagonality measures the material *outside* the hexagon but inside its bounding box. Neither half
works alone: hexagonality by itself prefers whichever end is smaller and mounts an insert tip-first.
Getting this wrong mounted all 17 clip-in parts back-to-front.

**A junction fixing REPLACES nearby fixings; it does not add to them.** Planned independently, the
seam rule and the spacing grid gave 56 four-cell inserts on top of 74 single ones — 128 holes in a
wall needing about 80. Same class of error as the original 370.

**Overlap is allowed.** The wall exists to mount things *on*, so accessories may share cells freely
and silently — no warning, no issue. The only impossibility is two parts that plug *into* a cell
(`type` `insert` or `fastener`) sharing one. See `isExclusive` in `src/core/store.ts`.

**...except where a cell is a SOCKET, and that rule lives in two places that must agree** (D43).
`insert-for-countersunk-hole-3` spans four cells and three of them are open 13.2 mm sockets
(measured; the fourth takes the wall screw), so one thing may be installed into each — and the next
one is refused. `store.checkPlacement` and `bom.validate` both consult `itemSocketCells`; teaching
only the store made the app accept a drop that the parts list then called an error, within a minute.
Occupancy for this rule is a SEPARATE index of what is *in* each hole: the cell→item map keeps one
id per cell, so an accessory hung over an insert used to hide it and the cell took a second insert.

**There are now two footprint detectors and they must agree.** `tools/footprint.py` uses trimesh
and shapely; `src/core/detect.ts` uses a raster, because a browser has neither. `tests/detect.test.ts`
runs the TS one over all 51 shipped models and requires the same cells, tier and `needsReview` as
the committed catalogue. If you change either, that test is the contract — do not weaken it.
The axis permutations in `detect.ts` are **cyclic on purpose**: cyclic is a rotation, acyclic is a
reflection, and a mirrored footprint is silently wrong.

**Accepting a proposed footprint must not clear `needsReview`.** Only an actual edit does. A bound
promoted to a measurement by a click is the exact dishonesty PARKED P1 exists to prevent, and
`withFootprint` in `src/core/importPart.ts` is where that rule lives.

**A PANEL drawn pointy-top needs its mesh spun 90°; nothing else does.** `meshLibrary.orient`
refuses the drawn-orientation spin because a part is drawn in the orientation it is USED — spinning
an SD-card holder points its slots sideways. That argument rests on the part having a meaningful up,
and a plate has none: it must match its own CELL BLOCK, which `toAxial` derives by spinning a
pointy-drawn part's cells. Unspun, `wall-honeycomb-part` draws 177 × 170.32 where the block needs
170.32 × 177. It hides on a wall of ONE pointy panel — every plate wrong the same way reads as a
continuous honeycomb — and only shows when a bed mixes pointy with flat. `tests/panel-mesh.test.ts`
compares every plate's bbox with its block.

**`WallView3D` keeps a SECOND mesh cache in front of `meshLibrary`'s.** `forgetPartMesh` clears the
library's copy and nothing else; the view's `meshes` ref is dropped on `catalog` identity. Miss that
and a saved mounting correction updates the catalogue, drops the library entry, rebuilds the item
group — and redraws from the stale local copy, so the part never visibly turns.

**`THREE.Spherical` is Y-up. `PartInspector` is Z-up.** Reading a Z-up camera position into a Y-up
spherical and back turns a vertical drag into rotation about the wrong pole (it comes out sideways)
and the `phi` clamp blocks it. The inspector holds azimuth/elevation itself. `WallView3D` is Y-up
throughout and is fine — do not "unify" them without checking which frame each actually uses.

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
- **`src/core/hex.ts`** — axial hex math (flat-top), rotation, occupancy. Every other module
  depends on its exact semantics, and none of them may re-derive it.
- **`src/core/tiling.ts`** — panel solver and seam detection.
- **`src/core/bom.ts`** — parts-list aggregation and `validate()`.
- **`src/core/store.ts`** — commands, placement rules, undo/redo.
- **`src/core/persist.ts` / `exporters.ts`** — save/load/share, CSV/markdown/print.
- **`src/core/stl.ts`** — STL parsing, mesh measurement, the fitted print estimator.
- **`src/core/detect.ts`** — the browser's footprint detector (raster port of `footprint.py`).
- **`src/core/importPart.ts`** — an STL plus a file name becomes a `CatalogPart`.
- **`src/core/userCatalog.ts`** — imported parts: validation, storage, merge with the generated
  catalogue. Ids carry a `user/` prefix so a collision is impossible.
- **`src/core/peg.ts`** — measures the hexagonal PEG a part mates through, giving a mounting axis
  and end that `detect.ts` cannot: an insert-fed part has no wall interface, so `insertFed` guesses
  from bulk and picks a shelf's tray. Reports a confidence and NO width (see the note in the file).
- **`src/core/userOverrides.ts`** — corrections made in the browser, layered over `overrides.json`
  and exportable in its shape. A browser cannot write the repo file, so it does both.
- **`src/core/overrides.ts`** — human corrections to the generated catalogue, applied by the app
  as well as by the scanner.
- **`src/core/fixings.ts`** — where the wall fixings go, across the assembly.
- **`src/core/obstacles.ts`** — switches, sockets and pipes, as cells the wall must avoid.
- **`src/ui/meshLibrary.ts`** — loads a part's STL, orients it to the wall, caches per part id.
  Load-bearing logic despite living in `ui/`: it decides which face goes against the wall.
- **`src/core/customiser.ts`** — a cut panel as OpenSCAD customiser parameters. The customiser is on
  the same lattice (23.6 / 20.438 / 8) and is flat-top, which the wall now is too, so the conversion
  is a stagger parity and nothing else — the 90° turn it used to carry is gone (D35). Still pinned
  by round-trip in `tests/customiser.test.ts`, for the same reason `panel-parity.test.ts` exists:
  a parity error is a mirrored plate, invisible until it is printed.

### Correcting a part's mounting

`detect.ts` cannot say which face of an insert-fed part goes against the wall — 27 of 51 have no
wall interface at all — so there is a human channel, and it is one channel with two front doors:

- **`PartInspector`** (⌖ on any catalogue tile) — the part in 3D against a patch of wall. Pick a
  face by clicking it or by one of six buttons, then seat it: three slides and three turns, each
  typeable, each also on the arrows (bare = spin and depth, `shift` = slide, `alt` = tilt). Below
  that, the questions geometry cannot answer (D42/D43/D44): which CELLS the part takes and which of
  them are SOCKETS — one click cycles empty → covered → socket — whether it sits on the wall face or
  on the flanges of its inserts, and WHICH fastener holds it on, chosen from tiles with rendered
  pictures because the names do not distinguish them.

  **Its wall patch is a plate with HOLES, and the camera sits in the room.** A cell drawn as a solid
  prism hides anything that goes into it — every insert vanished (D44) — and with the plate flush
  against the mating face, looking AT that face means looking at the back of the wall.

  **Its cell is the wall's cell: a 22.0 mouth 2.0 deep over a 20.0 throat**, built as the same two
  layers `buildPanelGeometry` builds, from the same constants (D45). One straight bore at the mouth
  read wider than the real thing, and the tool disagreeing with the wall about the size of the
  honeycomb is the one comparison a person makes by eye.

  **The stage is turned so UP THE WALL IS UP** — `fileToScene` in `mountingTransform.ts`, tested to
  determinant +1 on all six faces. The part keeps its FILE coordinates inside that turn, which is
  what lets the raycast still name a file axis.
- **`AlignPanel`** ("Align" in the top bar) — every part at once, the catalogue's axis beside
  `detectPeg`'s, disagreements sorted to the top, one button to accept the confident ones.

Both write the same `MountingOverride` into `userOverrides`, which `applyOverrides` folds into the
catalogue. The face is fed to `detect()` as a **constraint**, never stapled onto its result, so the
footprint and projection are re-derived from it — otherwise a part's cells are measured off one face
and its mesh hung off another.

**Two exports, and they answer different questions** (D44). **Setup (n)** in the top bar is
`toSetupFile` — every part carrying a decision, shipped or local, in `overrides.json`'s own shape
with its preamble: that is the file you drop over `src/catalog/overrides.json` and push. **Mine (n)**
is `toOverrideFile` — only what this browser changed, for a readable diff. Neither is a substitute
for the other: a person who corrected four parts still needs the other forty-seven to travel.

**Every field of a stored correction must be read back explicitly.** `readUserOverrides` re-validates
what comes out of localStorage field by field — right, because a stored document is user input by
then — so a field nobody reads is a correction that applies for one session and disappears on
reload. That is exactly what happened to the chosen fastener (D44). It is exported and browser-free
so each field is tested.

**A hand-drawn footprint replaces the detected cells and clears `needsReview`; re-stating the same
cells does neither** (D42). It is the same line `withFootprint` draws for an imported part: the flag
means "this is a bounding box", and only an actual edit turns a bound into a decision. It never
touches `requires` — cells are how much wall a part covers, pegs are what holds it up, and deriving
one from the other is the seven-inserts-for-two-pegs bug.

**`seat: 'insert'` stands a part off by the insert's flange** (`INSERT.flangeThickness`, 2.5 mm) —
the datum a fastened part actually rests on, since the 22.5 mm flange cannot enter the 22.0 mm mouth.
Stored as a datum, not as 2.5 typed into the depth, so it stays true if the flange is re-measured
and reads as a reason rather than a nudge. Default `wall`: making `insert` the default would move
every part in every saved layout.

**The six seating numbers are ONE transform, and it lives in `src/ui/mountingTransform.ts`** (D41).
`wallFaceAxis`/`matingEnd` choose the face; `offsetXMm`/`offsetYMm`/`offsetMm` slide the part across
the wall, up it and out of it; `spinSteps` (30° lattice steps) + `spinDeg`, `tiltXDeg` and
`tiltYDeg` turn it. Order: spin, tilt X, tilt Y, translate — rotation first, pivoting on the MATING
FACE. `meshLibrary` bakes that matrix into the wall's geometry and `PartInspector` conjugates the
same matrix into the file's frame to preview it; do not reimplement it in either place, or a part
lines up in the dialog and sits somewhere else on the wall. None of the six touch the detection: a
seating correction says where the mesh sits, not which cells it covers.

Picking a face does NOT clear `needsReview`. Knowing the face removes the detector's main ambiguity;
a tier-3 part's CELLS are still the bound PARKED P1 describes.

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

`tests/customiser.test.ts` asserts nothing by hand: it converts a panel to parameters, expands them
back with the customiser's own loop, and demands the identical cell set. A parity error there is a
mirrored plate, invisible until it is printed.

`tests/fixtures/estimator-calibration.json` holds 27 non-HSW shapes with real slicer results, so the
print estimator can be held to a stated error **without** a slicer installed. It exists because the
estimator was once fitted and tested on the shipped parts alone — all thin-walled — and was 54–59%
wrong on a solid cube. Fitting and testing on one family proves only that you memorised it.

`tests/critic-*.test.ts` were written by adversarial reviewers with fresh context. Some deliberately
**pin current, wrong behaviour** for findings that are still open, with a comment saying to invert
the test when fixed. If one of those starts failing, check whether you fixed the underlying defect
before "correcting" the expectation.

`Customiser/` holds the OpenSCAD parametric generator that makes panels with cells left out (for a
light switch). Its README records the lattice check against `constants.ts`; the `.scad` is the
readable copy of the supplied `.rtf`.

## Importing other agent configs

An OpenAI Codex config and a Gemini CLI config were both found at user level. If you want their MCP
servers, slash commands, subagents, skills or instructions brought across, reply `/import` to scan
and list what is importable, then `/import --yes=<digest>` (the scan output names the digest) to
apply the user-level items. If `/import` is unavailable on this surface, run `claude import` from a
terminal instead.
