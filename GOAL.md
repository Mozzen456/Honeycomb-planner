# GOAL

Make the border round a **blocked zone** look like `inner box.jpeg` — the printed plate with a light
switch through it. The aperture there is a straight rectangle closed by a THIN, EVEN wall, with the
honeycomb running right up to it and the edge cells CUT flush. Custom-shaped zones and square ones
must both come out that way, judged by looking at the running app.

## Done when

- [x] A zone can be a custom shape (union of rectangles): stored, round-tripped, and a plain zone
      still serialises with no `shape` key — proof: `npx vitest run tests/zone-shape.test.ts`
- [x] The honeycomb is cut to the SHAPE through the one `obstructedCells` path; the hollow of an L
      is left as wall — proof: same file
- [x] No border material lands inside any zone, square or custom, measured as AREA on a 0.5 mm grid
      — proof: `npx vitest run tests/zone-shape.test.ts tests/honeycomb-frame.test.ts -t "inside"`
- [x] A bordered plate cut round a custom zone is a closed mesh —
      proof: `npx vitest run tests/zone-shape.test.ts tests/honeycomb-frame.test.ts -t "closed"`
- [x] **Edge cells are CUT flush at the aperture** rather than removed whole, so the wall is thin
      and the open cells reach it — proof: `npx vitest run tests/zone-aperture.test.ts` (the plate is
      lighter than the paved one, open cells come closer to every side than removal allowed, no
      material inside the zone, mesh closed), plus the 3D view beside `inner box.jpeg`
- [x] `npm test` (955), `npm run typecheck`, `npm run build` all clean

## Constraints

- **No polygon boolean.** A border is half-planes and a convex polygon clipped by one stays convex
  (D59). A zone is a union of rectangles for that reason (D80).
- **One cutter.** `obstacleRects` is the single reader of `shape`.
- **The reference OBJECT wins.** `inner box.jpeg` is a printed plate; where it disagrees with our
  reasoning, it is right — the same rule that made `borders.webp` overturn `Cadcode.rtf` (D59).
- A clipped cell must keep the loft's vertex correspondence across all four bore bands, or the mesh
  is not watertight. Refuse rather than guess if the clip topology changes between bands.
- An absent key must round-trip to an absent key.

## Worklist

- [x] Custom shapes end to end, and the border clipped to the zone.
- [x] **Looked at it in 3D at high zoom, as asked.** Confirmed: our aperture edge is straight, but
      behind it sits a solid apron up to a WHOLE CELL deep, with the hexagon outlines showing
      through as filled bumps. The open cells start well back from the switch. In the photograph the
      open cells come right up to the wall and the wall is thin and even. That is the whole
      difference and it is not a tuning problem.
- [x] **DONE — partial cells at the aperture.** The plan, in the order it has to be done:
      1. `panelModelSpec` hands the generator the FULL block (including the cells the zone clashes
         with) plus `keepClear`, and keeps telling the PLANNER those cells are gone. This is D56's
         planner-versus-printer split, which already exists for exactly this kind of divergence —
         a half cell must never be mountable, but it should still print.
      2. In `buildHoneycombMesh`, clip a cell's outer ring AND all four bore rings by the same
         zone half-planes. Same planes on every level is what keeps the shared edge between two
         clipped neighbours cancelling, so the plate stays watertight.
      3. The inner skin currently matches ring j to ring j+1 BY INDEX, which breaks the moment a
         clip gives two levels different vertex counts. Replace it with the bearing merge
         `addAnnulus` already uses — it handles unequal counts and both rings stay convex.
      4. A cell whose clipped bore no longer contains its own centre becomes SOLID (no bore); one
         whose outer ring clips to nothing is dropped. Both keep the merge's precondition true.
      5. At a zone CORNER a cell is hexagon-minus-quadrant, which is an L. A cell cannot be split
         the way a border piece can, because its bore would split too — so it takes both planes and
         keeps the corner quadrant. Four slightly smaller cells at the aperture corners.
- [x] Re-measured and re-looked: both a square zone and an L on one wall come out with the
      honeycomb cut flush to a straight aperture, no apron.

## Progress log

- 2026-08-13 — GOAL.md created from checked state. Verified in this turn: `npm test` 519 passed,
  `npm run typecheck` clean, catalogue carries exactly 27 `needsReview` of 51 parts.
  `scan.py --verify` now runnable via scratchpad venv: geometry byte-identical across all 51 parts,
  differing only in this machine's PrusaSlicer profile hash and ≤0.02 min on four slice times.
  `src/catalog/catalog.json` itself is untouched in git. No code or catalogue changes yet.
- 2026-08-13 — Pass 1, "mine the local PDF". The repo-root PDF is RostaP's Printables listing
  (model 152592) and carries four dimensioned CAD drawings. Closed P3 (both halves: 56 cells from
  the designer's own panel drawing; two-hexagon span dimensioned 40.88, so 42.58 is folklore) and
  P5 (install diagram: the 3.6 mm rim faces the room). Settled the frame question — **flat-top** —
  from the shelves' own meshes: tray floor ⊥ Z, peg along Y, peg normals at 0/±60/±120/180° from
  +Z. Sourced the fastener half of P1; footprints untouched, `needsReview` unchanged. HSW-SPEC §10
  + §10.1, DECISIONS D31. `npm test` 519 passed, `tsc` clean, catalogue not touched so no rescan.
  Commit 897d717. **Stopping: the remaining P9 action is a decision for the user.**
- 2026-08-13 — Pass 2, "turn the lattice". User chose to turn it properly. Specified the whole
  change and verified the new basis is a rotation, not a reflection (both determinants
  `+PITCH·ROW_STEP`). Confirmed the app draws every panel 90° from the designer's own dimensions:
  `wall-honeycomb-part` is 177.00 × 170.32 in the app, 170.32 × 177 on the drawing. **Stopped
  before touching geometry**: the turn forces every stored `footprint` in `catalog.json` to be
  re-expressed, which regenerates the catalogue and collides with the "`--verify` byte-identical"
  criterion — and `--verify` cannot be byte-identical here regardless, because of the local
  PrusaSlicer hash. No code changed; `npm test` 519 and `tsc` still green. Awaiting the user's call
  on how to handle the catalogue.
- 2026-08-13 — Pass 3, testing the app itself. Orientation audit: measured every STL's hexagonal
  interface independently and compared with the catalogue — **24 of 24 agree** on parts the scanner
  stands behind; the other 27 carry `drawnOrientation: "n/a"` and are exactly the `needsReview` set.
  Panels split 4 flat / 3 pointy as drawn, recorded correctly. Best frame evidence yet: the designer
  dimensions the four-cell insert 40.88 × 23.6, the app's `insert-for-countersunk-hole-3` spans
  23.60 × 40.88 — same numbers, transposed. Fixed two real defects found by driving the app:
  Enter-on-tile started a drag no keyboard could finish (D32), and the seat correction was applied
  to view-built placeholder geometry that was already aligned, laying it across the cell walls
  (D33). Added the mounting-face inspector (D34) so a person can pick which face mounts, saved
  through `overrides.json` and exportable. Commits b5a14f6, 2ad72b1, c586f2e. `npm test` 556 passed.
- 2026-08-13 — Goal re-set to "full rundown, check alignments, plan a real wall, match the photos".
  Verified in this turn before writing: `npm test` 556 passed (19 files), `npm run typecheck` clean,
  27 of 51 `needsReview`, `FITTING_SEAT_RADIANS` still present (5 uses), `hexCorners` still
  `60·i − 90`, and `wall-honeycomb-part` still measures 177 × 170.3171 against the designer's
  170.32 × 177. **The app is still 90° from its own source, so the objective is not met and the
  lattice turn is now the top of the worklist.** No code changed this turn.
- 2026-08-13 — Pass 4, "go": pinned the lattice turn by experiment before touching code. Verified
  numerically that the obvious `(q,r)->(r,q)` swap is a MIRROR (det −1) — the invisible-until-printed
  error — and that `(r,−q−r)` and `(−r,q+r)` are both true rotations, each reproducing the
  designer's `170.32 × 177` exactly, so the bounding box cannot choose between them. Panel parity
  chose: **`(−r, q+r)` with a `floor` stagger matches all 7 panels**, while `(r,−q−r)` matches 6 and
  fails on exactly `mk3s`, the panel CLAUDE.md flags as needing a 180°. Transform recorded in the
  worklist above. No code changed yet; `npm test` 556 and `tsc` still green.
- 2026-08-13 — Pass 5, the turn itself. Core geometry is turned and the catalogue is migrated;
  **the tree is deliberately RED at 509/556 and this is a mid-migration checkpoint, not a finished
  state.** `tools/turn_frame.py` relabels all 51 footprints by the pinned `(q,r)->(-r,q+r)` with no
  mesh and no slicer, so every committed `print` estimate survives byte-for-byte and this machine's
  PrusaSlicer hash is never baked in; the diff is only q/r, columns/rows and a `frame` marker.
  Caught that the committed `catalog.json` is CRLF — writing LF rewrote all 7315 lines and buried
  the 1902 real changes, so the migration now preserves the file's own endings.
  **`panel-parity.test.ts` is green and stronger than before: all seven panels match as drawn, where
  `mk3s` previously needed a 180°.** That panel was never an oddity in the plate — it was the
  pointy-top stagger parity disagreeing with how the panel is drawn, and the turn removed the cause.
  `tiling.ts` transposed to vertical bands, 28/29. The one failure is NOT the transposition: with
  both variants offered the band chooser takes a 10-column band (480 cells) over an 8-column one
  (400), though 8-column bands tile the height exactly and would cover 5600 cells against 5280. That
  is a pre-existing greedy limitation in `isBetterBand`, unmasked by the turn rather than caused by
  it, and `allowRotation` is `false` in the app regardless. Recorded, not tuned away.
- 2026-08-13 — Pass 6, "keep on fixing". 509 -> 541 of 557. Every load-bearing geometry guard is
  green: panel-parity 10/10, detect 27/27 (both detectors agreeing on all 51 models), customiser
  round-trip 10/10, fitting-seat 4/4, hex 82/82. `tsc` and `npm run build` clean.
  **Three of the six Done-when criteria are now met and were checked this turn**: `hexCorners`
  starts at `60·i`; `wall-honeycomb-part` measures 170.32 wide × 177 tall, the designer's own
  dimensions, where it used to come out transposed; `FITTING_SEAT_RADIANS` is gone from the code
  (the one remaining mention is the comment explaining why it went).
  `FITTING_SEAT_RADIANS` did not simply vanish — the correction INVERTED. A mesh from a file now
  seats unturned, while geometry the view builds (the collar, the two placeholder prisms) needs the
  30° that real meshes no longer do, because `CylinderGeometry(…,6).rotateX(90°)` lands on a
  pointy-top cell. That now lives in one helper, `cellPrism`, instead of three separate
  `rotation.z` terms — which is how it shipped wrong in two of four places before.
  Two findings worth keeping. The tiler's behaviour TRANSPOSED exactly: the old 2400×1200 result
  (64 panels, 5784 cells, 96.87%) is now what 1200×2400 gives, and 2400×1200 gives 67 panels at
  91.64%. That is honest — the app used to measure the plate at 177 × 170.32, which flattered a wide
  wall. And `mk3s` no longer needs its 180°: it never was an oddity in the plate, it was the
  pointy-top stagger parity disagreeing with how the panel is drawn.
- 2026-08-13 — Pass 7, "keep going". **557/557, and all six Done-when criteria met and checked
  this turn.** The wall draws flat-top; `wall-honeycomb-part` measures 170.32 × 177, its own
  drawing's dimensions; `FITTING_SEAT_RADIANS` is gone; a 400 × 400 wall was solved in the running
  app with an SD-card holder and a shelf placed on it and photographed; `tsc` and `build` clean.
  Two bugs the tests could not have caught, both found by looking at the app. The plate came back
  as a scatter of open wedges: `unionOutline` took edge k as running corner k+1 -> k+2, which is
  forced by the corner angles and becomes k -> k+1 once the corners move to 0/60/...  And the
  Python detector disagreed with the catalogue on 17 parts — not a code fault but a missing
  `networkx` in the venv, which made `section_polygons` throw so every tier-2 part silently fell
  back to a tier-3 bound. `scan.py --verify` had never shown it because it reads its sha256 cache.
  With networkx installed, `footprint.py` agrees on 51 of 51, so both detectors agree with the
  catalogue and with each other. HSW-SPEC §2 and §4 rewritten to the flat-top frame (they still
  described the old one and contradicted §10), and §11 added as the rundown.
- 2026-08-13 — Pass 8, hover highlight. The ask was "highlight the honeycomb at its full size on
  hover"; delivering it turned up two more stale copies of the embedding, both of the same class as
  D35 and both invisible to the 564-test suite.
  **`cellAt` in WallView3D re-derived `mmToHex` inline**, still pointy-top, with a private
  `hexRound3` beside it whose comment claimed "shared semantics with hex.ts". Every hit test in the
  3D view landed several cells from the pointer — **including the drop**, so placing a part in 3D
  put it in the wrong hole. Now calls `mmToHex`; `hexRound3` deleted.
  **`visibleCells` in WallCanvas re-derived it too**, so on an EMPTY wall about an eighth of the
  width had no grid drawn at the right-hand edge. It survived because the moment a panel exists the
  range comes from `panelIndex` instead. Now transposed, exported, and pinned by
  `tests/visible-cells.test.ts` — which was checked against the old code first and fails it with
  3366 missing cells on a 2400 × 1200 wall.
  Also: the drag ghost built a raw prism and sat 30° off a flat-top cell (same class as D33), and
  `fixings.ts` hard-coded `23.6 * 20.438` instead of the constants. Both fixed.
  Suite 564/564. **The lesson is now three-for-three: every defect since the turn was found by
  looking at the running app, none by the suite.** A duplicated geometry rule is the recurring
  cause, and grepping for `/ ROW_STEP` and `/ PITCH` outside `hex.ts` is how the last two were
  found — worth doing again after any frame change.
- 2026-08-13 — Goal re-set to the Parametric Model Maker. Baseline checked in this turn before
  writing: `npm test` **704 passed (27 files)**, working tree already carries the STL-import / 3D
  mesh branch. Read `Customiser/Cadcode.rtf`: it is the supplied customiser **plus borders** —
  `Top/Bottom/Left/Right_Border` and `Double_Outer_Wall_Thickness` — so it is the frame reference,
  and its `wall()` profile gives the whole bore in closed form. Cross-checked that profile against
  HSW-SPEC §3: the two agree on 22.0/2.0, the 48° lead-in over 0.9, and 20.0/4.6 — and **disagree on
  the entry flare**, customiser `ft = 0.18` against a measured 20.8 over 0.5 mm. Measurement wins.
  Modelled the plate by hand from the measured profile: 902.68 mm³ of material per cell, so
  `wall-honeycomb-part` (56 cells) = **50550.0 mm³ against a measured 50551.0**, `375x389-fixed`
  (288 cells) = 259971.8 against 259974.6. The generator's geometry is therefore pinned before a
  line of it is written. No code changed this turn.
- 2026-08-13 — The Parametric Model Maker, built and checked in the running app. **782/782, typecheck
  and build clean**; every Done-when proof re-run this turn.
  **`src/core/honeycomb.ts` generates the plate itself** — cells (and an optional frame) to watertight
  triangles to a binary STL, with no polygon boolean anywhere, because a border is two half-planes and
  a convex polygon clipped by one stays convex. It is built from `constants.ts` alone and reproduces
  all seven shipped plates to **0.0025 % of volume and 0.0004 mm of bounding box** — that comparison
  is the whole reason a plate nobody has printed can be trusted. The residual 0.0004 is the SNAPPING:
  `ROW_STEP` being the typed 20.438 (D4) means three cells disagree about their shared corner by
  0.0003 mm, so `cornerPositions` resolves each corner to one canonical point keyed on the triple of
  cells that meet there. Unsnapped it is a mesh of 0.0003 mm cracks that a slicer refuses or
  "repairs". Verified in the browser on a real download: 7,076 triangles, **0 unmatched directed
  edges after the float32 round trip**, 8.000 mm thick, sitting on the origin.
  **The frame is Cadcode's, including its asymmetry** (D55): a border CUTS the outermost cells along
  their own centre line and walls them off, so it eats them — a left border takes the whole first
  column, a top border only the un-staggered half of the top row, because the staggered half already
  sits flush with the line. Measured against the MOUTH, the widest band. Doubling grows top/bottom
  outward and left/right inward, which looks like a leftover in the reference and is reproduced
  rather than tidied, so these plates interchange with everyone else's.
  **A framed cell is gone to the planner and present to the printer** (D56), and `panelModelSpec` is
  the only place that reconciles them — so placement, the parts list and the fixing plan all picked
  frames up untaught. `panelFrameKey` had to join every grouping key (`customPanelGroups`,
  `computeBom`, the 3D instancing) because the same cut with the border on opposite edges is a MIRROR
  IMAGE; grouped, you print one twice and the other never.
  **Three bugs found by looking at the app, none by the suite** — four for four since the turn.
  `WallCanvas.panelIndex` built its cell map from `panelCells` on the raw block, so a blocked zone
  changed the parts list and the 3D view and left the PLAN drawing an unbroken honeycomb straight
  through the switch. The measure/zone gesture was held in state, so the release arrived before the
  render and every quick flick measured nothing — a ref, exactly as the part drag already was (D58).
  And 3D drew a framed edge as a column of missing hexagons; it now draws cut plates from the
  generator, so what you see is what you download.
  **Two more, found while deriving the frame**: `WallCanvas` drew every placed-part outline and every
  panel seam from corners `dir − 1` to `dir` — one edge round the hexagon, the same off-by-one already
  fixed once in `WallView3D` (pass 7), invisible to 704 tests. Now `edgeCorners` in `hex.ts`, tested
  against where the neighbour actually is (D57). And the customiser's own entry chamfer disagrees with
  the shipped plates — 0.18 against a measured 20.8 flare over 0.5 mm — so the generator takes the
  measurement (D54).
  Verified in the browser end to end: a 1000 × 800 wall framed on three sides gives five custom plates
  named by the edge each meets and leaves the five interior plates STOCK; a double socket cuts a sixth;
  a tape between two wall corners reads exactly **1 500 mm, 1 200 × 900**.
- 2026-08-14 — Borders, custom thickness, and plates sized to the printer. **797/797, typecheck and
  build clean.**
  **The border was rebuilt from the user's own photograph and it INVERTED the design.** D55 built it
  from `Cadcode.rtf`, which CUTS the outermost cells along their centre line. `Customiser/borders.webp`
  — a printed plate — does the opposite: under magnification every cell is a whole open hexagon, the
  walls between cells run out past the honeycomb to a straight line, and the notches behind that line
  are filled solid. Nothing is cut. That is a column of mounting points per plate, so the cut was
  replaced wholesale (D59) and the whole cells-consumed apparatus went with it: `frameCutCells` gone,
  `store.setFrame` no longer re-cuts, `panelModelSpec` no longer restores. **Reading a reference
  IMPLEMENTATION where a reference OBJECT existed cost a day** — the same rule as `models/` outranking
  any published description, applied one level up.
  Built from one ring of empty positions drawn solid and clipped to a line `thicknessMm` out. Each
  phantom derives its own line from its own neighbours, so a straight run comes out flush and an
  L-shape follows its steps with no run-finding anywhere. Thickness is now a millimetre field bounded
  by `MAX_BORDER_MM`.
  **"Outer perimeter only, not the middle ones" falls out for free**: an edge is raised only where a
  position is EMPTY across the assembly, and a seam position is taken by the plate next door.
  **Two defects found by looking at the app, neither by the suite.** Bordered plates came back 20 mm
  wider than their own cells — one lattice step — because a position at the corner where two plates
  butt was claimed by BOTH; printed, they would overlap by a whole cell and the wall would not
  assemble (D60). And every plate on a bordered wall was listed as generated, including the ones in
  the middle, because `panelFrameKey` appended the thickness unconditionally so it was never empty.
  **Plates now follow the printer** (D61). `plateFootprintMm` reproduces all seven shipped plates from
  their cell counts alone, and `maxPlateForBed(180 × 180)` returns exactly 8 × 7 — which IS
  `wall-honeycomb-part`, so the formula is the designer's. On a 1400 × 1000 wall the Prusa Mini plans
  54 plates of 56 cells and a 400 mm printer 12 plates of 304, at the same 96.1 % coverage. Off by
  default and not stored on the document: it changes what the next solve produces, and a saved layout
  already records what it produced.
  Verified in the browser: a 420 × 360 wall, bordered all round at 3.6 mm, comes back as four plates
  that download **watertight, 8.000 mm thick, at the origin, and inside the 256 bed** — 214.79 × 145.20,
  × 133.40, × 227.80 and × 239.60 mm.
- 2026-08-14 — "the honeycomb is not in the wall edge its shifted". It was: **13.6255 mm — exactly
  `MARGIN_X` — off the left of every wall**, since the frame turn. `tiling.ts` had always counted
  columns from `ROW_STEP·q + MARGIN_X`, an outline-anchored lattice; `hexToMm` put cell (0,0)'s
  CENTRE at the origin. `LATTICE_ANCHOR` names the vector and applies it once (D63).
  **X only.** In Y the solver already lands the outline on zero by choosing a band's start row, so
  anchoring Y too pushed the top row **8.6 mm off** a 1200 × 900 wall — found by re-measuring after
  the change, not by reasoning before it.
  **`tiling.test.ts` had the bug written into it**: it added `MARGIN_X`/`MARGIN_Y` to the bounds
  before checking panels were inside the wall, under a comment stating the anchor as though it
  existed. The test agreed with the INTENT while the app did the other thing. A fudge factor in an
  assertion is worth reading as a defect report.
  Now checked with nothing added, across five wall sizes and both plate sources: left gap 0.00 on
  every one, nothing off any edge. 816/816, typecheck and build clean.
  Also this pass: `NumberField` (D62) — the measurement fields could not be cleared, because
  `Number('')` is 0 and the document clamped it up before the second digit landed.
- 2026-08-14 — Border switch and zone measurements moved onto the plan (D64). **Border** (`E`) in the
  plan toolbar with its thickness beside it, and a blocked zone's name and size are now HTML controls
  over the canvas rather than painted text — click either and type. Verified in the browser: a double
  socket retyped from 146 × 86 to 220 × 120, the honeycomb re-cut round it, and the border drawn on
  the wall's perimeter and round the zone. 816/816, typecheck and build clean.
- 2026-08-14 — "the border follows the honeycomb, i want it flat". The GEOMETRY was already flat —
  the mesh reaches exactly `maxY + MARGIN_Y + thickness` along its whole top and the STL downloads
  that way. The PLAN was drawing the honeycomb's zig-zag: one line per exposed cell edge. Two
  readings of "where is the border" (D65). The plan now FILLS `borderPolygons`, which comes out of
  the generator's own walk, so there is one answer.
  Corners needed a second ring of pieces — the position squaring an outside corner touches no real
  cell — worth 33 mm² a plate; ownership had to reach a step further with it.
  **The test that was missing, and its shape:** a zig-zag border and a flat one have the SAME
  bounding box, so every bounds assertion passed. What separates them is that a zig-zag loses
  material along every edge — shortfall grows with the perimeter — while a flat one loses only four
  corner chamfers, so the shortfall is CONSTANT. A 3 × 3 and an 8 × 7 must now come out equal.
  819/819, typecheck and build clean.
- 2026-08-14 — "the frames are not flat on the top, just jagged; sides look nice". The GEOMETRY was
  flat all along — measured, the top silhouette of a bordered plate is one straight line at
  `maxY + MARGIN_Y + t` at every x. **The 3D wall was drawing the shipped STL** (D66):
  `WallView3D` short-circuits to the cached stock mesh when a plate has no cut-outs and a catalogue
  id, and a bordered plate has both. Plan showed a border, parts list said "edged top + left", wall
  showed neither. It read as a TOP problem because a flat-top lattice zig-zags 6.8 mm on the sides
  and 11.8 along the top — same defect, twice as visible.
  Three things stop a plate being stock — cut, generated size, EDGE — and every gate has to ask all
  three. `panelIsBordered` names the third so nothing re-derives it.
  **No test could have caught it**: every border test was on the geometry, and the geometry was
  right. A renderer chose not to use it — same shape as D50 and D52. Found by looking at the app,
  four for four since the frame turn. 821/821, typecheck and build clean.
- 2026-08-14 — A blocked zone's size now waits for Enter or OK (D67). It committed per keystroke, so
  typing `220` over `146` re-cut every plate on the wall at `2`, `22` and `220` — three re-plans and
  three undo steps for one measurement, with the wall thrashing while you typed it. `NumberField`
  gained `commitOn: 'type' | 'confirm'` rather than a second component: same parsing, clamping and
  blur path, one fewer call. The zone's NAME waits too — a rename cannot change a cell but goes
  through `setObstacles` all the same. Which schedule a field gets follows from what its commit
  COSTS, so the wall size stays live. Verified in the browser: field reads 220 while the document
  still reads 146, and only Enter or OK applies it. 824/824, typecheck and build clean.
- 2026-08-14 — "the border is jagged towards the middle, make it flat on both sides". The geometry
  had no such edge; the PLAN painted one. `drawBorder` filled the border in its own tone, so the band
  read as a separate object — and a separate object has two edges, so the eye followed its inner
  boundary, which is the honeycomb's outline stepping half a pitch between staggered columns. Filled
  in the PLATE's colour it draws what the photograph shows: flat outer rim, honeycomb stopping short
  of it, nothing in between (D68).
  Recorded because it is not a defect: a left/right edge scallops 6.8 mm while a top/bottom edge
  steps 11.8, because the wall is flat-top and adjacent columns stagger half a pitch. The reference
  plate is photographed with its rows along the bordered edge, so its edges are the 6.8 kind.
  **Three reports in a row on this border, all the same shape**: the geometry right, a renderer
  drawing something else (D65, D66, D68). When the plan, the parts list and 3D disagree, suspect the
  drawing before the model. 824/824, typecheck and build clean.
- 2026-08-14 — "the border is jagged towards the middle". Measured rather than argued: the OUTER edge
  was already dead flat (pixel probe, spread 0 across the width); the INNER edge varied 17 px, because
  filling to the straight line makes the band `t` thick above one column and `t + PITCH/2` above the
  next — the flat-top stagger. The photograph does not show it because that plate is shot with its
  ROWS along the bordered edge, the direction that does not stagger; our sides are that direction,
  which is why they were fine.
  Three shapes were possible and the cost differed, so it was **asked, not assumed**: cut the
  protruding half-row (loses half the top and bottom rows), thicken the border (hides it), or leave
  the pockets open. User chose open pockets — top and bottom are now clipped inside as well, so the
  rail is one thickness and every cell stays mountable, at the cost of a rail attached at every other
  column. Left and right stay filled: their notch is a hexagon's own 6.8 mm scallop, not a missing
  cell (D69). Verified: top edge spread 0 px, rail 3 px thick where a pocket sits behind it.
  825/825, typecheck and build clean.
- 2026-08-14 — Three reports. **(1) The plan was upside down against the 3D view** (D70): `toScreen`
  mapped wall y straight to canvas y, which grows downward, so a socket 60 mm off the floor drew at
  the TOP of the plan and the bottom in 3D. Flipped, and a y-flip is not one line — pan and
  wheel-zoom invert, `visibleCells` must sort both canvas corners (`toWall(0,0)` is the LARGEST y,
  and taking it as the minimum culled the whole wall), and seams and part outlines had to stop
  rebuilding corners from angles in SCREEN space, which run the other way round a flipped hexagon.
  They now take `hexCorners` in wall space and map — the right structure anyway.
  **(2) The border is one thickness on all four sides now**, not just top and bottom.
  **(3) "Fit to printer, top not levelled" — could not reproduce.** Measured the rendered plan: the
  plate's top edge is a single y across the whole width (the 1 px sliver above it is the dashed wall
  outline), and the cell tops are a regular 11.8 mm stagger with generated sizes exactly as with
  shipped ones. Worth re-checking now the view is the right way up — the complaint was made while
  the plan was mirrored, so "the top" was the wall's bottom. 829/829, typecheck and build clean.
- 2026-08-14 — "make a system for uploading parts… printables style… you go shopping for parts to your
  wall". Built, and it turned the catalogue inside out. **860/860, typecheck and build clean.**
  **The rail was doing two jobs and could answer neither** (D71). It showed all 51 shipped parts plus
  every import, and a wall uses six; "which am I printing" was answered by reading the parts list, and
  "which of these is the hook I want" by dragging one onto the wall to look at it. Now `PartLibrary`
  is the shop — a card per part with a picture at a size you can see, shelves, search, sort, one
  button to add — and the rail holds only what was chosen, which is the question it could never
  answer before: what is this wall built from?
  **The list is on the DOCUMENT** (`LayoutDoc.library`), so it travels down a share link and undoes
  like any edit — verified by pressing Share and reloading from the hash. The rule that makes it safe
  is that a PLACED part counts whether the list names it or not: without it every layout saved before
  today opens with a wall full of hooks and an empty rail. An id the catalogue cannot resolve is kept
  and counted, never dropped — a dropped friend's-upload id would rewrite their document on the way
  through.
  **A part can carry a photograph, and it beats the render.** Keyed on part id and nothing else, in
  its own IndexedDB store, so absence IS the answer and no flag has to be kept true. Downscaled
  before storing, which is not a nicety: the quota is shared with the STL bytes the 3D view needs, so
  an unshrunk photo costs the wall its meshes somewhere else entirely. Measured on a real import —
  3.17 MB PNG in, **6 KB WebP at 640 × 427** out.
  **Uploading is two steps and the second cannot be skipped.** Describe it, then line it up; it joins
  the library only when the alignment is saved. The detector declines to guess a mounting face for 27
  of 51 parts, and the moment a part is being added is the one moment somebody is certainly looking
  at it. The bytes go to IndexedDB before step 2 so the inspector can draw the real mesh, which makes
  them the only thing an abandoned import leaves — checked at both steps, nothing left behind.
  **The bug underneath it: overrides were applied BEFORE the merge**, so a correction on a `user/…`
  id was written, stored, exported and never applied. You could line an imported part up, watch the
  dialog save it, and find it on the wall the way the detector guessed. Same shape as D50/D52/D66 —
  two owners of one fact — and it had no symptom until this flow depended on it. Verified after the
  fix: an uploaded hook reads "Mounting face Front (−Y), Detected Top (+Z)" across a reload.
  **And one found only by looking at the app, five for five since the frame turn.** The library
  opened onto a dimmed page with nothing on it. The dialog was there, 1554 px below the fold: the
  scrim's implicit grid track sized to the max-content height of 51 cards — 3971 px in a 1000 px
  viewport — because the dialog's `block-size: min(56rem, 100%)` is a percentage against a track
  sized by its own content. `grid-template-rows: minmax(0, 1fr)`. Every other modal uses the same
  pattern and gets away with it only because its content is shorter than the screen.
- 2026-08-14 — "look into the bugs you found". Chased the residue of the shopping-library pass, and
  the loose ends were worth more than the bugs already fixed. **865/865, typecheck and build clean.**
  **The write-up was wrong and checking it is what found the real bug.** D71 had said the other modals
  "get away with" the implicit-grid-track fault "because their content is shorter than the viewport".
  Measured at a 480 px window instead of asserted: **`ImportDialog` was broken and live** — footer at
  y=775 in a 480 px viewport, so `Cancel` and `Next: line it up` were both below the fold on a scrim
  that does not scroll. On a short window an import could be neither finished nor cancelled, in the
  path this branch had just made mandatory.
  **And `AlignPanel` had hit the same thing months ago and papered over it**: its CSS carried a
  comment describing a 768 px panel at `top: 1236` inside a 0–900 container, calling it "not worth
  unpicking", and centring with flex instead. Three copies of one rule, two broken, one saved by
  luck — the repo's signature failure, in CSS. The rule now lives once, `.modal-scrim` in `base.css`,
  and all four backdrops wear it. Verified: all four dialogs sit at top 16, bottom 464 in a 480 px
  window.
  **`sweepOrphans` for what an abandoned import leaves.** Writing the STL bytes before the alignment
  step is what lets the inspector draw the real mesh, and it makes those bytes the residue of any
  import abandoned by closing the tab, in the same quota the 3D meshes come from. Runs once at
  startup; collected two stranded models from earlier sessions and left the live part's model and
  photo untouched.
  **The sweep needed a guard, and finding that was the point of the exercise.** `loadUserParts`
  returned the same empty list for "no imports" and "localStorage refused to open" — Safari private
  mode throws on access. Fed to a sweep, that empty list says every stored model belongs to nothing.
  A browser hiccup would have deleted a person's entire upload history. `LoadResult.readable` now
  separates the two and the sweep runs only on the first. It also sweeps against the whole catalogue,
  not the imports alone, because a photo is keyed on part id precisely so a shipped part can have one.
  **Two non-bugs, recorded so they are not chased again.** The "controlled input becoming
  uncontrolled" warning in `ObstaclePanel` does not reproduce — exercised every frame control on a
  clean load and it stayed silent; it was a stale HMR generation in the console buffer. And clicks
  not registering on library buttons was my own coordinate arithmetic against a downscaled
  screenshot, not the app: a real pointer click adds a part correctly.
- 2026-08-14 — ".3mf files too". Added as a first-class upload format. **893/893, typecheck and
  build clean.**
  **No new dependency.** `DecompressionStream('deflate-raw')` is a platform API in both browsers and
  Node — the two places this must work — so `src/core/zip.ts` is a hundred lines of header parsing
  and nothing else. Three's `3MFLoader` was not an option: it needs `DOMParser`, which Node lacks, so
  it could not live anywhere the tests can reach. The model XML is read with a tag scanner for the
  same reason, with its limits stated where it is defined.
  **Three ways a 3MF is silently wrong, all handled.** UNITS — a 3MF declares one and it may be
  inches, so read at face value a part is 25.4× too big with nothing on screen to say why; scaled
  once on the way in, and an unknown unit is refused rather than assumed to be mm. TRANSFORMS — an
  STL's coordinates are final, a 3MF's are placed by build items and nested components, and ignoring
  them TURNS the part, which is the one thing `detect()` cannot recover from. MIRRORING — a negative
  determinant flips handedness, and a mirrored accessory is a left-hand hook on a right-hand wall.
  **The mirroring test had to be rewritten before it meant anything.** The obvious assertion — that
  `measureMesh` still reports 1000 mm³ — passes whether the winding is flipped or not, because
  `stl.ts` takes the ABSOLUTE value; and the bounding box cannot tell either, since mirroring a
  symmetric cube does not move it. It now computes a signed volume itself, and was checked by
  disabling the flip and watching it go red. Same lesson as the `+ MARGIN` fudge: a test that cannot
  fail reads like coverage.
  **A 3MF may be a whole build PLATE** and nothing in the file distinguishes that from one object
  made of components. So the items are merged and the fact is SAID — the count comes back and the
  import dialog warns, because the person who exported it knows instantly which they meant.
  **The seam moved, deliberately.** `proposePart` is async now (no synchronous inflate in a browser),
  but the asynchrony stops at the file boundary: `proposeFromMesh` is the sync core and most of
  `import.test.ts` still exercises a pure function of a mesh. `parseModelFile` sniffs `PK\x03\x04`
  before trusting the extension, because a 3MF renamed `.stl` is common.
  **Verified in the browser, not just in node.** A real shipped model converted to an indexed 3MF,
  declared in INCHES and deflated, dropped into the running app: back as 27.554 × 32.792 × 13.589 mm
  and 2.559 cm³ — the catalogue's own figures for that STL to three decimals — lined up, added,
  placed, and drawing its library thumbnail from the stored 3MF bytes through `meshLibrary`.
  The one bug that run found was in the prose, not the geometry: the unit warning read **"Drawn in
  inchs"**. There is a name table now. `models/` and `scan.py` stay STL-only — 3MF is an upload
  format, not a catalogue format.
- 2026-08-14 — Three reports off the back of the library work. **916/916, typecheck and build clean.**
  **(1) "the space on the wall alignment does not match the 3D viewer" — it did not, and the dialog
  was innocent.** `orient` centres a mesh on its wall-plane BOUNDING BOX; four separate places then
  placed that mesh at the MEAN of its cells — the wall's placed item, the fastener under it, the
  hover outline, and the inspector's patch. Mean and box centre coincide for a symmetric footprint
  and diverge otherwise: on the L-shaped `insert-hollow-tre` by **3.406 mm**, so the part was drawn a
  seventh of a cell off the holes it plugs into, everywhere. The dialog was faithfully copying the
  wall and the wall was wrong, so the two agreed with each other and both disagreed with the
  geometry. `cellsCentreMm` is the one answer now, and the panel path — which had it right by hand —
  goes through it too rather than being a fifth copy that happens to agree.
  **The test states the fact, not the call.** Every wall-clip part is oriented, placed the way a view
  places it, and required to leave the same gap on opposite edges: 0.63 mm in x and 0.55 mm in y
  across all 17, which is the plate margin. Insert-fed parts are excluded with the reason given —
  their footprint is a bound (PARKED P1) and `shelf-4`'s tray legitimately overhangs by 80 mm. The
  file also pins the defect: under the mean the two gaps sum to −6.81 mm instead of zero, so the
  suite could not be green in a world where this was never fixed.
  **(2) The cells are chosen on the alignment step now, and only there.** The import asked twice, a
  click apart, with the same editor — and step 1 is the worse place to ask, because a hex grid on its
  own has nothing to answer against. On step 2 it sits beside the part shown against real wall.
  **(3) No photograph shows the RENDER**, not a grey box with an icon. What you get by skipping it is
  now visible in advance instead of discovered in the gallery. Needed the model's bytes written one
  step earlier; `cancelImport` still has exactly one thing to undo.
- 2026-08-14 — "Error in allignment.png". The screenshot showed the gold socket rings straddling the
  honeycomb's walls, and it was a real one: **`LATTICE_ANCHOR` counted twice**. **932/932, typecheck
  and build clean.**
  Measured before touching anything: the offset is **13.6254664 mm — exactly `LATTICE_ANCHOR.x`**,
  two thirds of a column. `hexToMm` is `M·cell + LATTICE_ANCHOR`, so adding two of its results, or
  adding one to something that already carries the anchor, counts it twice. `WallView3D` translated
  each stock plate by `hexToMm(origin) + cellsCentreMm(blockAt00)`; `PartInspector` positioned its
  patch by `-mid - (hexToMm(anchor) - blockCentre)`, where mid and blockCentre cancel their anchors
  and the bare `hexToMm(anchor)` leaves one behind. D63's class exactly.
  **It survived because every plate is wrong by the same amount** — the honeycomb stays continuous
  and nothing about the wall looks off. Only something drawn at the true lattice position gives it
  away: a part, a fixing, a socket ring, sitting between holes. The alignment dialog is where a
  person first sees a part and a plate side by side at high zoom, which is why that is where it was
  reported. The generated and drawn plate paths were never affected — they translate by
  `hexToMm(origin)` alone, one anchored quantity used once.
  Fixed by removing the arithmetic rather than correcting it: a stock plate goes at
  `cellsCentreMm(panelCells(origin, columns, rows))`, the block's centre at its REAL origin, which
  cannot double-count. The assumption under that — a plate's material is symmetric about its cell
  block — is measured, not trusted: 170.317 × 177.000 mesh against a 170.317 × 177.000 block, checked
  for all seven plates.
  **The test states the geometry and was checked against the old code**: every cell of every shipped
  plate, from five origins, must land on `hexToMm` of the wall cell it represents to 1e-9. Reverting
  the rule fails 8 cases. It also carries the general lesson as its own case — a difference of two
  `hexToMm` results is safe, a sum is off by one anchor.
  Also this pass: the cells are chosen on the alignment step only, and an import with no photograph
  shows the rendered part instead of an empty box.
- 2026-08-14 — "the blocked zone with border gets really bugged... also makes a huge red square,
  please just remove that". Both done, and the border one was functional, not cosmetic.
  **938/938, typecheck and build clean.**
  **The red square is gone** (D78). It was a slab the size of the zone standing 5 mm off the wall in
  the danger colour — the biggest opaque object on the wall, hiding the cut plates and the edge round
  them. It also duplicated an absence: the honeycomb is CUT there, so the hole IS the zone. Removing
  it is what made the border examinable at all.
  **The border round a hole had two faults** (D77). `outwardOf` asks which side of the ASSEMBLY a
  piece lies beyond and a hole is beyond none, so hole pieces got no inner clip and came out as whole
  solid hexagons — the D69 rail rule never fired. Clipping against the cells a piece leans on fixed
  the straight runs and not the corners, where a piece has cells on both sides of its centre and no
  side to face. Measured, that still left **369 mm² of plate inside the switch's own rectangle**.
  **The real fault: a hole had no straight line to clip to.** The outer edge has the assembly bounds;
  a hole has only the honeycomb's stepped rim, because a cell is cut the moment it clashes, so the
  aperture is always bigger than the zone. `BorderSpec.keepClear` now carries the zone rectangles and
  a hole piece is pushed to the side of the rectangle it is already outside. **0 mm² inside the
  switch**, and the aperture comes out straight where the rail reaches it.
  Two limits stated rather than hidden: corners are under-filled, because hexagon-minus-rectangle is
  an L and there is no polygon boolean here by design (D59); and the rail is `t` and does not stretch,
  so where the cut left the cells further than `t` from the zone the aperture stays wider — the safe
  direction.
  **The first metric I used was worthless and I replaced it.** "How near does a border vertex come to
  the zone's edge" reported 19.79 mm and sounded alarming; a legitimate 3.6 mm rail lying on the
  boundary scores the same. The test now samples the border polygons on a 0.5 mm grid and measures
  AREA inside the rectangle, paired with a case proving the same hole is not clear when the generator
  is told only about cells — so it cannot pass by drawing nothing.
- 2026-08-14 — "still not a good looking border" + custom-shaped zones. **955/955, typecheck and
  build clean.** Goal re-set to this and every Done-when box ticked by running its check this turn.
  **Reproduced the judgement before changing anything** (D79): the aperture's edge was a STAIRCASE —
  straight where the `t` rail happened to reach the zone's line, stepped where it did not, because a
  cell is cut the moment it CLASHES so the aperture is bigger than the zone by up to a whole cell and
  a rail cannot span the gap. A zone-facing piece is now drawn SOLID and clipped only to stay out of
  the zone, so the aperture is the zone rectangle exactly. Costs no cell — the pieces are empty
  positions, so a rim cell's mouth is untouched. The outer edge and a zone-less hole keep the rail.
  At a corner the hexagon is SPLIT along the zone's vertical edge into two convex pieces that meet on
  a line, rather than intersected, which would leave a notch at every corner.
  **A zone is now a union of rectangles** (D80). A geometry decision, not a UI one: the border clips
  convex pieces with half-planes and there is no polygon boolean here by design (D59), so a rectangle
  gives four half-planes and a concave polygon gives nothing usable. `obstacleRects` is the single
  reader of `shape`; the cutter, the border and the plan all go through it. The bounding box stays
  for the tag and the handles and is explicitly NOT what blocks — blocking by it would eat the hollow
  of an L, which is wall the user kept, and `zoneHit` falls through there too. Shift-drag with the
  Blocked-zone tool adds a rectangle to the selected zone.
  **Verified in the app on one wall carrying both kinds**: the plan draws the L as an L with its
  hollow left as honeycomb beside a plain 86 × 86 switch; 3D shows a straight rail on every side of
  both apertures, including the L's inner corner. Six plates, all listed as "cut round an obstacle".
  **Not done and recorded**: a shaped zone cannot be resized by its handles, only moved, renamed and
  added to — resizing a bounding box has no single meaning for an L, and guessing beats nothing only
  if the guess is right.
- 2026-08-14 — "just fix it" — the aperture now matches `inner box.jpeg`. **963/963, typecheck and
  build clean.**
  Cells a zone eats are PRINTED, cut (D81). `panelModelSpec` hands them over as `clipped`, separately
  from `cells`, so the planner still treats them as gone — a cell a switch passes through must never
  be offered as somewhere to mount anything — while the plate gets them cut off flush. That is D56's
  planner-versus-printer split doing exactly the job it exists for.
  Every ring of a clipped cell, outline and all four bore levels, is cut by the SAME half-planes, so
  two clipped neighbours truncate identically along their shared edge and it still cancels: 30
  clipped cells, 5 714 triangles, **0 unmatched edges**. The inner skin could no longer pair rings by
  index once a clip changes the vertex count between levels — `addSkirt` merges by bearing instead,
  the same argument `addAnnulus` makes for a cap, stood on its side.
  **Three faults fell out of this, none in the new code**, all found by measuring the mesh rather
  than reading it — counting vertices inside the zone rectangle and isolating the source by
  rebuilding with cells, border and clipped cells switched off in turn. The border's reach test used
  the MOUTH's radius (12.7) where a piece is a whole CELL (13.6), so pieces overlapping by up to
  0.9 mm were skipped and left a rail in the aperture. An OUTER piece never consulted `keepClear` at
  all, so a zone overrunning the plate's edge had the rail run straight through it. And with the
  frame off there are no zones to clip against, which would have drawn the eaten cells whole and
  filled the aperture solid.
  Verified in the app on one wall carrying both kinds: a 180 × 180 L and an 86 × 120 switch, ten
  plates, both apertures straight-edged with the honeycomb cut flush right up to them and no apron.
- 2026-08-14 — "only the inside corners are wrong". They were, and it was the case flagged as a known
  limit rather than a bug: a cell diagonally outside a zone's CORNER wants hexagon-minus-quadrant,
  which is an L, and taking both planes keeps only their intersection — a notch bitten out of every
  corner of the aperture.
  A cell cannot be split the way a border piece is (D79), because its BORE would split with it and
  two half-bores meeting on that line would grow a membrane across the hole. So the cell now keeps
  the whole side facing the zone's edge — outside the zone at any height — and the arm beyond it is
  filled by a SECOND, SOLID piece at the same position under its own key. The offcut is a sliver in
  one cell's outer margin, where a hole would do nothing; the two pieces share their straight edge
  and cancel there like any two neighbours. **964/964, typecheck and build clean**, mesh still closed
  and still nothing inside the zone, corners square in the 3D view.
- 2026-08-14 — "border thickness should be the same as the outer edge, no jagged edges" (D82). Both
  were the same fault: cells cut flush AT the zone left the wall as whatever remained of each cell —
  thick in the web between two bores, thin where the line grazed one, and ragged where it clipped a
  bore open onto the aperture, which is a scallop rather than a wall. Cells are now cut back to the
  zone grown by `t` and the band between is filled, so the wall is bounded by two straight parallel
  lines a fixed `t` apart — the same rail the outside of the plate gets. Both lines come from the
  zone rectangle, so the result no longer depends on where the cut falls against a bore.
  The test states it as containment: every aperture border piece lies inside the band, so nothing
  reaches the zone and nothing passes `t`. The old mass comparison against a "paved" plate was
  deleted rather than retuned — the border is bounded to the band in both arms of it now, so neither
  paves and the baseline had quietly become the subject. **964/964, typecheck and build clean**,
  mesh closed, corners square, verified on a square zone and an L in the 3D view.
- 2026-08-14 — "why not just use the drawing of the blocked box as the model… and have the hexagon go
  up to the squares". That is exactly it, and applied to the OUTSIDE of the plate it is the whole
  fix (D87). **964/964, typecheck and build clean.**
  **The measurement first, because there had never been one.** Every border test measured the
  bounding BOX, which cannot tell a `t` rim from a `t` rim with a cell of solid behind it — so four
  passes of wrong shapes had all been green. Sliced the plate and ran scanlines across the section:
  the band between the plate's edge and the first opening measured **26.7 mm against a `MARGIN_X + t`
  of 17.2**, on every plate size. That is a whole extra cell of plastic and it is what "the border
  looks chunky" meant every time. `tests/plate-edge.test.ts` is that probe as an assertion; it was
  checked against the old geometry first and fails it at 26.7.
  Two things about the scanline, both of which cost a wrong answer first: anchor the lines ON CELL
  CENTRES (a line on a hexagon's flat or through a corner registers no crossing, two runs merge, and
  the band reads as most of the plate — 274 mm on a 12 × 11 when stepped blind from the bounding
  box), and leave the CORNER cells out, where a scanline crosses both bands at once.
  **The edge is a CUT now, on the outermost cell CENTRES**, with every bore clipped `t` inside it —
  the same two-line rule that walls a blocked zone (D83), which is what the user asked for. The whole
  phantom apparatus goes with it: no rail to attach, no scallop to fill, no corner class at all.
  **The line has to be `bounds` and not `bounds ± t`, and that was the last thing to learn.** Both
  give a `t` rim and both look right along a straight run. The honeycomb's silhouette only reaches
  `bounds`, so at `bounds + t` the top came out scalloped `t` deep between columns and the sides
  stepped in **12.1 mm at every corner**. On the line there is nothing left to invent: the plate's box
  is now the cell-centre rectangle to 1e-9 on all four sides at every thickness from 0.4 to 6.8 mm,
  and the rim is exactly `t` at its thinnest.
  It costs the outer RING — open half hexagons, nothing mounts in one — which is D59's trade taken
  the other way and is stated on the Frame panel rather than discovered at the printer.
  **Three faults fell out, none in the new geometry.** The ring left the planner through `omit` and
  never arrived at the printer: the generator only cut `clipped` cells against a ZONE, so with a
  border and no zones every plate came out a whole ring short — watertight, and green, because every
  geometry case builds its spec by hand and none goes through the store. The edge then WALKED inward,
  because `assemblyIndex` read its bounds off the cells that survive `omit`, so each edit cut a ring
  that had already gone. And the plan drew no edge at all, because `borderPolygons` has nothing to
  say about a cut — `plateEdgeShapes` gives it the cut cells off the same planes the mesh uses.
  Also: "cut round an obstacle" was being said about every bordered plate, since that reason fired on
  `omit` being non-empty.
  Verified in the running app on a 420 × 380 wall with a double socket through it: straight rim on
  all four sides, straight aperture, honeycomb cut flush to both, and the plan and the 3D view
  showing the same plate.
- 2026-08-14 — "just a small defect at the corners where half of the honeycomb is filled". It was the
  whole perimeter; the corners are where two runs of it meet. **966/966, typecheck and build clean.**
  A border piece is raised where a lattice position is EMPTY, and `occupied` was read off
  `placedPanelCells` — which no longer holds the ring, because the edge cuts it and it leaves through
  `omit`. So every plate looked at the wall's rim, saw a hole, and filled it back in with solid
  hexagons landing exactly on the cut cells' missing halves: **30 spurious pieces on a four-plate
  wall, eight on one plate.** `occupied` means PRINTED now, not mountable; a zone's cells stay out of
  it, because a zone is a genuine hole and that is what `holes` is for.
  **It took three goes to measure, and none of the three failures was in the geometry.** Pooling the
  four plates' sections is wrong because even-odd parity holds only within ONE solid and plates
  interlock — a ray crossing a shared stretch counts twice at one x and never flips. Slicing at the
  throat is wrong because the mouth's own 0.8 mm wall is solid there, so every probe near a rim is a
  false positive. And an axis-aligned ray is wrong because the probes are centroids of clipped bores,
  whose y lands on lattice values: one plate gave **17 crossings**, an odd count with three x values
  duplicated, and open cells read as solid. Generic direction, half-open interval, one plate at a
  time.
  The guard states both halves: a solid rectangular wall raises NO border pieces at all, and every
  cell the edge cuts still has a hole in it — checked on the meshes, because the piece that fills a
  cell in is raised by a different plate from the one printing the cell.

