# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser planner for a Honeycomb Storage Wall (HSW): lay accessories out on a hex grid, get back an
exact list of what to print. The geometry is **measured from the STL files in `./models/`**, not
copied from any published description. `HSW-SPEC.md` records every number with its provenance,
`DECISIONS.md` records why each call was made, `PARKED.md` records what is still open, and
`UNKNOWN.md` lists what the scanner would not guess at.

`GOAL.md` holds an objective and its done-when checklist — **check whether it is still the live one
before working to it.** Every box in it is currently ticked, and by work that is now many decisions
old (the blocked-zone aperture, D80–D87, against a head that has since passed D100), so
it is a record of finished work rather than a brief; the newest decisions in `DECISIONS.md` are the
better guide to where the work actually got to.

## Commands

```bash
npm run dev          # Vite dev server
npm test             # vitest run — 51 files, 1157 tests
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

python tools/logo.py                         # rebuild both logo artworks from the master
```

`logo.py` needs no third-party package at all — `zlib` and `struct` — so it runs anywhere. Run it
whenever `Honecomblogo.png` changes; the two files in `src/ui/assets/` are build output that happens
to be committed (D102).

`calibrate_estimator.py` needs PrusaSlicer but **not** trimesh, so it runs where `scan.py` cannot.
Same for `tools/slicer.py`, which knows the macOS bundle path as well as the Windows one.

If `npm` is missing, Node is not installed: `. ~/.nvm/nvm.sh && nvm install --lts`. A `node_modules`
copied from another platform will fail with "Permission denied" on the CLI shims rather than
anything informative — delete it and reinstall.

`scan.py` shells out to PrusaSlicer. If it fails to start under the tool sandbox, run that command
with the sandbox disabled — the failure looks like a crash, not a permission error.

## The traps

These have each cost real debugging time. Read before touching geometry.

### The lattice

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

**The wall is FLAT-TOP, and that is settled (D31/D35).** It used to be drawn pointy-top, 90° from
the designer's own dimensioned drawings — `wall-honeycomb-part` measured 177 × 170.32 where the
drawing says 170.32 × 177. `FITTING_SEAT_RADIANS` is gone with it: a mesh loaded from a FILE is
drawn flat-top and now seats in its hole unturned.

The correction did not vanish, it INVERTED, and this is the live trap. Geometry the VIEW builds for
itself — the collar, the placeholder prisms, the drag ghost — needs the half-face turn that real
meshes no longer do, because `CylinderGeometry(…, 6).rotateX(90°)` lands its corners on a
POINTY-top cell. That lives in one helper, `cellPrism` in `WallView3D.tsx`; do not inline a bare
`CylinderGeometry` for anything that has to sit in a cell. `tests/fitting-seat.test.ts` pins it.

**An edge runs between corners `dir` and `dir + 1`. Call `edgeCorners`.** Got wrong three times now:
`unionOutline` in the 3D view (pass 7), and in `WallCanvas` both the placed-part outlines and the
panel seams, which drew `dir − 1` to `dir` — one edge round the hexagon, through a 704-test suite,
because it is entirely plausible on screen (D57). The test asserts nothing by hand: the edge's
midpoint must sit exactly halfway between the two cell centres.

**The lattice is ANCHORED into the wall, in X only** (D63). The wall's origin is its corner; the
lattice's is a cell centre. `LATTICE_ANCHOR` is the vector between them and lives in exactly one
place — `hexToMm` adds it, `mmToHex` removes it. Without it the honeycomb hung `MARGIN_X` off the
left of every wall, because `tiling.ts` had always counted columns from `ROW_STEP·q + MARGIN_X`.
X only: in Y the solver already lands the outline on zero by choosing a band's start row (the
stagger puts centres on every half pitch, and `MARGIN_Y` IS half a pitch), so anchoring Y as well
pushes the top row 8.6 mm off the wall.

**The plan canvas is Y-UP; canvas pixels are not** (D70). `toScreen` flips y and `originY` is the
wall-mm y at the BOTTOM of the canvas, so the plan and the 3D view agree about which way up the wall
is. Consequences that bit: pan and wheel-zoom invert on y, and **anything describing the lattice must
compute in WALL space and map through `toScreen`** — angles written in screen space run the other way
round the hexagon and put every seam and outline one edge out. `visibleCells` must take BOTH canvas
corners and sort them; `toWall(0, 0)` is the largest y, not the smallest.

**A part is placed at the BOX CENTRE of its cells — `cellsCentreMm`, never the mean** (D73). The
mesh is centred by `orient` on its own wall-plane BOUNDING box, so the point in lattice space it
corresponds to is the middle of the cells' bounding box. A mean is dragged toward whichever side has
more cells: on the L-shaped `insert-hollow-tre` the two differ by **3.406 mm**, so the part was drawn
a seventh of a cell off its own holes — in the wall view, in the fastener under it, in the hover
outline and in the alignment dialog, four independent copies of the same wrong choice. Only one
shipped footprint is asymmetric enough to show it, which is why it survived. `tests/part-centring.test.ts`
states the geometry rather than the call: every wall-clip part's placed mesh must leave the same gap
on opposite edges.

**Never re-derive the embedding. Call `hexToMm` / `mmToHex`.** This is the single most expensive
mistake in the repo's history. Three separate copies of the inverse survived the frame turn because
none of them named the function they duplicated: `cellAt` in `WallView3D` (every 3D hit test, drop
included, landed several cells from the pointer), `visibleCells` in `WallCanvas` (an eighth of an
empty wall had no grid drawn), and a private `hexRound3`. All three passed a 557-test suite. A
FOURTH turned up later in the footprint editor — `x = PITCH·(q + r/2)`, the *transpose* of
`hexToMm`, so the cells you drew came out mirrored from the cells that landed (D42). After any
change to the frame, grep for `/ ROW_STEP` and `/ PITCH` outside `hex.ts` and read every hit.

**`hexToMm` is a POSITION, not a displacement — never add two of them** (D76). It is
`M·cell + LATTICE_ANCHOR`, so a sum carries the anchor twice and lands `MARGIN_X` (13.6255 mm, two
thirds of a column) out. A DIFFERENCE of two is anchor-free and always safe. Both places that
re-centre a bounding-box-centred stock plate got this wrong — `WallView3D`'s instancing and
`PartInspector`'s wall patch — so every stock plate in 3D sat 13.6 mm right of its own cells. It hid
because they ALL sat there: the honeycomb stayed continuous and only a placed part, a fixing or a
socket ring revealed it by appearing to sit between holes. A stock plate is now placed at
`cellsCentreMm(panelCells(origin, …))` — the block's centre at its real origin, one anchored
quantity used once — and `tests/plate-alignment.test.ts` puts every cell of all seven plates on the
lattice from five origins.

**A band must START on an EVEN column, or the wall is two honeycombs** (D96). `panelCells` staggers
by −floor(dq/2), so a band beginning at absolute column q0 puts the lowest cell of column q at
`y/PITCH = k + frac((q − q0)/2)` — and that fraction is `frac(q/2)` for even q0 and its OPPOSITE for
odd. An odd-origin band therefore carries the other phase of the same lattice, and `k` is a whole row
where the error is half of one, so the silhouette steps a full PITCH at that seam, top AND bottom,
for the height of the wall. It reads as "the hexagons go one over for a few, then one under for a
few" — the "few" is one band. `BandPlan.keepsPhase` ranks above cells covered in `isBetterBand`;
it costs one column of plate width on a bed whose widest plate is odd (11 → 10 on an MK3S) and is a
PREFERENCE, so a plate set with only odd widths still tiles.

**Two more ways an edge goes ragged, both fixed with it and both about the OTHER end of a band.**
`bandBump` used to ask for `bandColumns >= 2`, reasoning about the odd columns that lean UP — so a
ONE-column band, which has no odd column, kept its cells centred on y = 0 with half of each below the
wall. The bump belongs to the LOWEST cell, which is in the first column of every band whatever its
width. And `generatedPlateSizes` used to keep only its 120 largest, which is the wrong axis to
economise on: a band's WIDTH is chosen once, but its heights must STACK to the top exactly, so
dropping the short plates left a band 165 mm low. Offer the whole grid — it is 19 × 16 at the very
biggest.

**A fudge factor in an assertion is a defect report.** `tiling.test.ts` added `MARGIN_X` to the
bounds before checking panels were inside the wall, under a comment stating the anchor as if it
existed. The test agreed with the intent while the app did something else, for as long as both were
wrong together. Read `+ MARGIN` in a test as "two modules disagree here".

### The generator and the border

**A panel with `omit` is a CUSTOM panel and is not the stock STL any more.** It is generated —
`src/core/honeycomb.ts` makes the plate itself, and `src/core/customiser.ts` still emits parameters
for anyone who wants to tweak it by hand — so it must never be counted as a copy of the shipped file:
you would print 50 plates and find four of them do not fit round the light switch. Every derivation
of a panel's cells must go through `placedPanelCells`, never `panelCells` on the raw
origin/columns/rows. `WallCanvas.panelIndex` got this wrong and drew an unbroken honeycomb straight
through the light switch while the parts list and the 3D view both showed it cut (D57).

**The generated plate is measured against the seven that were printed.** `honeycomb.ts` builds from
`constants.ts` alone and reproduces every shipped plate to 0.0025 % of volume and 0.0004 mm of
bounding box (`tests/honeycomb-model.test.ts`). That comparison is what lets it be trusted with a
plate nobody has printed. Where `Customiser/Cadcode.rtf` disagrees with a measurement the measurement
wins — its entry chamfer is 0.18 mm where the plates measure a 20.8 flare over 0.5 mm (D54).

**The 22.0 MOUTH goes against the wall; z = 0 of the generated plate is the wall face** (D97). The
bore runs mouth (2.0) → 48° lead-in (0.9) → throat (4.6) → 20.8 flare (0.5) out to the room. It was
built the other way up, so the app drew every plate turned over — reported as "the tapered part
should be towards the wall". The INSERT decides it, not the plate: `insert-empty`'s barbs peak at
20.735 across flats and sit 5.7–6.1 mm past the seating face, which is where the bore opens to
21.3–22.0 if it entered from the FLARE side, and inside the 20.0 throat if it entered from the mouth
(HSW-SPEC §5). `honeycomb-model.test.ts` measures that on the real insert rather than restating it.

**...so EVERY plate in 3D comes from the generator, stock ones included.** A printed plate cannot
just be turned over in the picture: the flip mirrors its cell block, and 48 of the 56 cell centres of
`wall-honeycomb-part` then land in solid material. The generator builds the plate from the cells it
is given, so it cannot disagree with them; the shipped mesh survives only as the fallback for a shape
the generator refuses, and `PartInspector`'s wall patch takes the same route (`plateGeometry` in
`meshLibrary.ts`). Anything measuring the plate at a height must know that the mouth band is now
z 0.0–2.0 — `plate-edge.test.ts` sliced at 7 and silently moved into the throat.

**A generated mesh must SNAP its shared corners or it is not watertight.** `ROW_STEP` is the typed
20.438 (D4), so the three cells meeting at a corner compute it ~0.0003 mm apart — a mesh full of
0.0003 mm cracks, which a slicer refuses or silently "repairs". `cornerPositions` keys each corner on
the unordered triple of cells that meet there so every cell emits bit-identical vertices.
`meshIsClosed` compares vertices EXACTLY, on purpose: a tolerance would hide the snapping failing.

**...and a CLIP PLANE landing on one of those corners has to snap too** (D84). A rail's line is
`cellCentre ± MARGIN`, recomputed, and it misses the snapped corner by ~3e-15 mm in a direction
rounding decides. Tested exactly, one end of a shared edge reads as outside and the other as inside,
and Sutherland–Hodgman interpolates between distances of ±1.8e-15 — putting the cut at `t = 0.5`, the
MIDDLE of the edge. The piece then carries a spurious vertex halfway along a face it shares with a
cell, that face never cancels, and a wall is drawn between two solids that are touching. So
`clipConvex` counts ON the plane as inside to within `SAME`, and `cutEdge` snaps a cut within `SAME`
of an endpoint onto it. Every plane here is axis-aligned with a unit normal, so that tolerance is a
real distance in millimetres.

**The plate's edge is a CUT on the outermost cell CENTRES; it does NOT add material past them**
(D87, superseding D59, D69, D84 and D85 — read those for the shape of the mistake, not for the rule).
The outlines are clipped at `bounds` and every BORE `t` inside that, so the plate ends on its own
cell-centre rectangle with a `t` rim closing the half cells. Exactly the aperture rule (D83) with the
zone's complement replaced by the plate's rectangle, which is what `inner box.jpeg` shows.

**The line has to be `bounds`, and this is the trap.** `bounds ± t` also gives a `t` rim and looks
right along a straight run, and it is wrong: **the honeycomb's silhouette reaches `bounds` everywhere
along a side and no further.** Two cells in a column meet at a flat 6.81 mm short of their corners,
and adjacent columns stagger half a pitch, so past that line there is no continuous material to clip.
Measured at `bounds + t`: the top comes out scalloped `t` deep between columns and the side steps in
**12.1 mm** at every corner. Four earlier passes each invented that missing material a different way
(rail, fill, corner piece, band ends) and each printed as a different wrong shape.

**It costs the outer RING, and that is the trade `borders.webp` refused.** Those cells are open half
hexagons and nothing mounts in one, so they leave the planner through `omit` exactly as a switch's
cells do (D56) — `borderCutCells` names them, `cutAroundObstacles` applies them, and switching the
border off gives them back. The old edge instead ran **26.7 mm** of solid plate between two cells of
the outermost column, against a `MARGIN_X + t` of 17.2: a whole extra cell of plastic, which is what
"the border looks chunky" meant every time.

**`omit` is not one thing, and both readers must ask which.** A cell can be there because a zone ate
it or because the edge halved it, and a cell at the wall's rim can be BOTH. `panelModelSpec` hands
them all over as `clipped` and the generator cuts each by everything that cuts it — the zones it
meets AND the plate's lines — because taking only one is a defect either way round: only the zone's
and the plate runs past its own edge, only the edge's and there is plate inside the switch. With
NEITHER a clipped cell is dropped, which is what stops a frame-less plate filling its own aperture.
The parts list asks the same question to avoid saying "cut round an obstacle" about every bordered
plate.

**`assemblyIndex` takes BOUNDS from the whole block and `occupied` from what survives `omit`.** They
answer different questions — "how far does the plate reach" against "is this position filled" — and
conflating them is a runaway: the edge cuts the ring, bounds follow the ring inward, and the next
edit cuts a ring that has already gone. Measured, one whole lattice step short per edit.

**Measure the RIM with scanlines on the mesh, never with the bounding box.** A box cannot tell a `t`
rim from a `t` rim with a cell of solid behind it, which is why every border test passed through four
wrong shapes. `tests/plate-edge.test.ts` slices the plate and scans: never deeper than `MARGIN + t`,
never thinner than `t`, exactly `t` at its thinnest, and the box equal to the cell-centre rectangle
to 1e-9. Anchor the scanlines ON CELL CENTRES and sweep one cell's span — a line landing on a flat or
through a corner vertex registers no crossing, two runs merge, and the band reads as most of the
plate (274 mm on a 12 × 11 when stepped blind from the bounding box). Leave the CORNER cells out: a
scanline there crosses the perpendicular band and measures both at once.

**A border piece is now only for a HOLE the plate goes round that no zone owns** — a step, or a gap
where no plate reaches. `borderPieces` drops every outward position, because the outside is cut and a
piece beyond the plate would stand outside its own edge.

**`assemblyIndex.occupied` means PRINTED, not mountable — the cut ring is IN it.** A border piece is
raised where a position is EMPTY, and the ring leaves `placedPanelCells` through `omit`, so read off
that the whole rim looks like a hole and every plate fills it back in with solid hexagons landing on
the cut cells' missing halves: 30 spurious pieces on a four-plate wall, reported as "half of the
honeycomb is filled at the corners", which is where two runs of it meet. A ZONE's cells stay out of
`occupied` — a zone is a genuine hole, which is what `holes` is for.

**Point-in-section on this lattice needs a GENERIC ray, tested per plate.** Two ways it lies. An
axis-aligned scanline through a vertex registers a crossing twice or not at all — one plate gave 17
crossings, an odd count, and open cells read as solid — so cast at a slant with a half-open interval
along the segment. And even-odd parity holds only within ONE solid: plates INTERLOCK, so pooling
their sections makes a ray cross a shared stretch twice at one x and the parity never flips. Test
each plate's section separately and OR the answers.

**`meshIsClosed` does not mean one solid, and for a long time it was not.** A closed mesh can be
several closed shells; every detachment above kept it at zero unmatched edges. `honeycomb-frame.test.ts`
asserts ONE connected component of the top face, joined by shared EDGES and never by shared vertices —
a by-vertex test calls a point-contact comb attached — swept over block sizes, because every one of
these failures was parity-dependent and a single size passes by luck.

**The edge is drawn in the PLATE's colour, because it is the plate** (D68). Given a tone of its own
it reads as a separate band, and a separate band has an inner edge — which is the honeycomb's
outline, and looks jagged. There is no such edge: a bordered plate is one piece of plastic whose only
boundary near the rim is where the holes begin, which since D87 is literally true — the rim is the
outermost cells' own material.

**The plan DRAWS the edge from the generator's own rules — `plateEdgeShapes` and `borderPolygons`**
(D65, D87). It once traced one line per exposed cell edge — the honeycomb's zig-zag — so the picture
showed a scalloped edge while the downloaded plate had a straight one. Since the edge became a cut
there is nothing for the border walk to describe on the outside, and `borderPolygons` alone drew a
wall a RING smaller than the file: the cut cells are in `omit`, so the plan never sees them among the
cells it draws. `plateEdgeShapes` returns them and what is left of their mouths, off the same
`plateEdgePlanes` the mesh is built from. Feed it the whole BLOCK (`assemblyBlockCells`), not the
surviving cells.

**A blocked zone is a UNION OF RECTANGLES** (`Obstacle.shape`, D80), and the reason is convexity:
the border clips convex pieces with half-planes and there is no polygon boolean here by design. A
rectangle gives four half-planes; a concave polygon cannot be clipped against in one piece.
`obstacleRects` is the ONLY reader of `shape` — `cellClashes`, the border's `keepClear` and the
plan's drawing all go through it. The bounding box is kept for the tag and the handles and is NOT
what gets blocked: blocking by it would eat the hollow of an L. Move one with `moveZone`, or the
parts stay behind while the box moves.

**The aperture wall is the CUT CELL's, and it takes two cut lines** (D83, superseding D82). The
outline is cut at the zone rectangle — so the aperture is that rectangle exactly — and the four bore
levels `t` further out, so between the aperture and the nearest opening there is `t` of plate: the
same rail the outside gets. One cut line for both is wrong in either position: at `zone` the bore
opens onto the aperture (measured 0.00 mm of wall), at `zone + t` the aperture is oversize and the
wall is whatever survived of each hexagon.

**The border does NOT print the edge of an aperture — do not give it back that job.** It looks like
the natural owner and it cannot be: a border piece only grows where the plate has left a position
EMPTY, and every position round an aperture is a cell the plate prints CUT, so the pieces are dropped
by the guard against printing a position twice. That is exactly what D82 did — cells cut back to
leave room for a rail that was then never drawn — and the tests missed it because they asked about
border polygons, of which there were none. Across a seam it is worse than useless: the plate growing
the piece and the plate printing the cell are different plates. A hole belonging to no zone (a step,
a gap) keeps its reach rail; an outer rail still clips against a zone that overruns the plate's edge.

**Cells a zone eats are PRINTED, cut — the planner still treats them as gone** (D81).
`panelModelSpec` returns them as `clipped`, separately from `cells`, and is the one place allowed to
know the plate and the plan differ (D56). Removing them whole left an apron up to a WHOLE CELL deep
round the aperture; the printed reference (`inner box.jpeg`) has open cells right up to a thin even
wall. **The OUTLINE cut is a function of the ZONE alone**, never of which cell is asking — that is
what keeps two clipped neighbours truncating identically so their shared edge still cancels and the
mesh stays watertight. Bores are private to a cell and may differ. The inner skin can no longer pair
rings by index (a clip changes the vertex count between levels): `addSkirt` merges by bearing. A bore
the cut leaves ANY of stays OPEN (D86). It used to print solid once the cut passed the cell's own
centre, which paved a ring of hexagons behind every aperture wall — D81's apron, put back by D81's
own guard. The merge never needed that point: `addSkirt` and `addAnnulus` both work by bearing around
the INNER RING's centroid, which a convex sliver always contains. A cell whose CENTRE falls inside the zone keeps its sliver
on the nearest side rather than being dropped — dropped, it took its own wall with it and bit up to
10 mm out of a "straight" aperture. At a zone CORNER a cell keeps the whole side facing the zone's
edge and its arm is filled by a second SOLID piece at the same position — a cell cannot be split like
a border piece (D79) without splitting its bore, and two half-bores would grow a membrane across the
hole; taking both planes instead notches every corner of the aperture. **No zones means the eaten
cells are not drawn at all** — otherwise a frame-less plate fills its own aperture.

**Which side a cell is cut on is where its MATERIAL is, never where its CENTRE is** (D105). A
hexagon is 27.25 mm across and a zone edge lands wherever it was drawn, so a centre falling a hair
inside an edge says nothing about whether the cell reaches past it. `clipPlanesFor` used to pick
`px`/`py` off the centre, so a cell whose centre sat **0.04 mm** inside a zone's x range while
outside it in y got no x plane at all — cut on y alone, and the 13.6 mm of plate it still had beyond
the zone's x edge was thrown away. A whole quadrant, so the aperture wall had a hexagonal hole in
it: measured 13.41, 13.45 and 13.38 mm on ONE side of each of three zones, and 0.00 on the other
nine, which is what "cut straight along this zone and stepped along that one" was. The tell is the
1/√3 slope on the gap's boundary — that is a hexagon's own edge, which is what a dropped cell leaves
and what a cut never does. The reach test agrees with the centre test wherever the centre test had
an opinion; the corner is where it had none.

**Two things it is NOT, both ruled out by measurement — do not re-spend the time.** `cellClashes`
tests a cell as its bounding BOX rather than its hexagon, which over-selects at the box's four empty
corners; it is real, it is not this, and it hands back zero cells on the reported wall. And the
minimum-thickness floor is not this either: zeroing it moves none of the numbers, because these
cells take the CORNER branch where the surviving arm is 13.66 mm.

**A plane that removes NOTHING means the ZONE removes nothing — skip it** (D106). A cell keeps
`ring ∩ (px ∪ py)`, so if either plane holds over the whole hexagon the union IS the hexagon and
there is nothing to cut. Put through the corner path regardless, one cell comes out as three pieces
whose union is the cell it started as, and those pieces then draw bore walls against each other
along both split lines. It is not a shortcut, it is the difference between one piece and three, and
D105 made it bite: asking about a cell's REACH gives a plane to every cell wholly past an edge,
including ones that need only the other.

**The inner skin must cancel a shared bore face, exactly as `boundaryEdges` does for the outer**
(D106). Emitted per piece it drew both sides of every split line — open bore either side, so a
surface with solid on NEITHER: a membrane of zero thickness, reported as a stripe "1 pixel wide",
which is the correct description of something with no width. Three traps in fixing it. Cancel
through `boundaryEdges`, never a set of opposites — a clipped bore can hold an edge AND its reverse
and cancel against itself, both sides drop the band, and the hole in the plate becomes a hole in the
MESH. `addSkirt` cannot be taught the test at all: it merges by BEARING, so where two levels differ
in vertex count the two pieces tessellate the shared stretch differently and dropping the same area
from each leaves a crack. So cancel ONLY where every piece holding the edge is index-matched; a
skirt piece keeps its wall, membrane and all. **A stripe is a blemish and an open plate is not
printable** — if a change here trades watertightness for appearance, it is the wrong change, and
`zone-sliver.test.ts` and `zone-aperture.test.ts` will say so.

**Measure a membrane as a run of ZERO length in a section.** Two crossings at one x is a surface
with no thickness, which no real plate can produce. Same slice the aperture is measured on, and it
responds: 476 before D105, 706 after, 402 with the no-op skip, 0 with the cancellation.

**Measure the apron as a run of CONSECUTIVE gapped scanlines, not as a maximum.** Even-odd counting
on this lattice is degenerate where a line meets a flat or a vertex, and one such line reported
10.52 mm on a side that re-measured at 0.00 the moment the phase or the slice height moved. A missing
quadrant is ~11 mm of aperture — thirty-odd consecutive lines — and does not care where the scanlines
fall. `tests/zone-apron.test.ts` therefore repeats the whole measurement at a second phase and
height, because a result that holds at one phase is a coincidence and during this fix one was.

**Measure this on the MESH, not on the polygons that were meant to produce it.** Slice the finished
plate at its own face and run scanlines across the section: where the plate stops each side of the
aperture, and how thick it is there. Every proxy — border polygons, cell centres, bounding boxes —
let the wall be 0.00 mm somewhere while the suite stayed green (`tests/zone-aperture.test.ts`).

**A border piece's reach is the CELL's corner radius (13.6), not the mouth's (12.7)**, and an OUTER
piece must check `keepClear` too — a zone can overrun the plate's edge, and a rail whose centre is
inside a zone is dropped outright.

**`BorderSpec.keepClear` is now only a KEEP-OFF, never a fill-to** (D77 and D79, both superseded by
D83). It carries the zone rectangles, grown by their clearance so the border keeps off exactly what
the cells keep off, and its whole remaining job is to stop an OUTER rail running through an aperture
where a zone overruns the plate's edge. Read the two dead decisions for the shape of the mistake
rather than for the rule: both are attempts to make the border produce an edge it structurally
cannot reach, and both were measured as "plate inside the switch" — 369 mm² in D77's case — which is
the right metric and was not the reason either of them failed. **Measure a hole's rim as an AREA
inside the rectangle, never as a distance to its edge**: a legitimate rail lying along the boundary
scores 19.79 mm on the distance metric and means nothing.

**A blocked zone is NOT drawn in 3D** (D78). It was a red slab standing off the wall, and being the
biggest opaque object there it hid what it pointed at — the cut plates and the edge round them. The
hole in the honeycomb is the zone, at its own size; the plan view draws the zones and their names.

**A border never appears on a seam.** It is raised only where a lattice position is EMPTY across the
whole ASSEMBLY, so the position between two plates is taken and they still interlock. That one rule
is why nothing has to know about steps, L-shapes or blocked zones — they are all just empty
positions.

**Exactly ONE plate prints each piece of edge** (D60). A position at the corner where two plates
butt touches both, and unowned it is grown by both — printed, they overlap by a whole cell and the
wall will not assemble. It goes to whichever plate holds the most of its neighbours, ties broken on
the smallest neighbouring cell. The SAME walk must answer "which sides does this plate print",
or it is labelled `edged bottom` while its neighbour prints that bottom.

**A plate can carry a strip one lattice step past its own cells**, because the wall's edge is
continuous and the split lands somewhere. `generatedPlateSizes` budgets for it; without that a
bordered wall plans plates to exactly the bed and then several do not fit.

**`panelFrameKey` must join the grouping key everywhere identical plates are counted** —
`customPanelGroups`, `computeBom`, the 3D instancing — because the same cells with the edge on
opposite sides is a MIRROR IMAGE, and grouping the two prints one twice and the other never. It
returns `''` for a plate with no edge; append anything unconditionally and every plate on a bordered
wall looks edged, including the ones in the middle.

**Three things stop a plate being the shipped file, and EVERY gate must check all three** (D66):
cells cut out (`omit`), a size the app chose (`isGeneratedSize`), and an EDGE (`panelIsBordered`).
`WallView3D`'s short-circuit to the cached stock mesh checked the first two, so every bordered plate
drew the plain shipped STL — the plan showed a border, the parts list said "edged top + left", and
the wall showed neither. The geometry was right the whole time; a renderer chose not to use it, which
is the same shape as D50 and D52 and is only ever found by looking at the running app.

**A `generated/` plate has no catalogue entry and never will** (D61). Three things must know:
`validate` must not report it missing, `isCustomPanel` must count it as custom so it reaches the
download list, and the BOM must cost it against the biggest shipped plate PER CELL — left to fall
through it reported zero filament, which looks like an answer rather than a gap.

### Fixings, sockets and the parts list

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

**A part pegged into a junction's socket does not block that junction** (D48). `planFixings` checks
`avoid` across all four cells, so one hook on one open socket used to delete the whole fixing — the
wall mount disappearing from the plan, the list and the picture. `SharedCells` lets the junction pass
accept a shared cell where that placement has a socket; the wall-screw cell still blocks, and the
spacing grid still avoids everything. Build both sets with `bom.fixingPlanFor` — `WallView3D` and
`bom.ts` must not have their own reading of which cells are free.

**The inserts under the ACCESSORIES come from `bom.fasteningPlanFor`, the same way** (D53). The wall
drew the fixings holding the plates up and nothing holding the things on them, so a part seated
against an insert in the alignment tool arrived with no insert under it. One plan, two consumers:
`computeBom` reads its `supplied` cells to know what not to order, the 3D view reads `cells` to know
what to draw. Which cells those are is `fixings.fastenerCells` — count, never one per cell, nearest
the anchor — and `PartInspector` calls the same function, or the tool and the wall pick different
cells again.

**The fixings are EDITABLE, and the edits are applied to the plan's OUTPUT** (D90).
`doc.fixingEdits` is two lists of cells — taken out, and put in — and `applyFixingEdits` runs after
`planFixings` has finished. Feeding them back into the planner instead is the trap: the grid notices
the hole a removal left and fills it from the next cell, so the fixing you deleted comes back 24 mm
away, which reads as a broken delete. A move is one of each, in one undo step. Putting one back where
the planner had it UNDOES the removal rather than recording an override at the same cell, and
removing one you added FORGETS the addition — without both, the document collects pairs that cancel
and never comes back to where it started. A junction can be removed but not moved: it exists to
straddle the corner where the plates meet, and anywhere else it is the wrong part. Removing the last
fixing on a plate warns as `panel-unfixed`, which is NOT `no-room-for-mounts` — that one says "clear
a cell", and here the cells are clear and the fixing is gone.

**A junction fixing REPLACES nearby fixings; it does not add to them.** Planned independently, the
seam rule and the spacing grid gave 56 four-cell inserts on top of 74 single ones — 128 holes in a
wall needing about 80. Same class of error as the original 370.

**Overlap is allowed.** The wall exists to mount things *on*, so accessories may share cells freely
and silently — no warning, no issue. The only impossibility is two parts that plug *into* a cell
(`type` `insert` or `fastener`) sharing one. See `isExclusive` in `src/core/store.ts`.

**A socket may also SUPPLY the insert a part needs** (D47). Any EMPTY insert answers a part that
wants an empty insert — same socket, different id — while a bolted one answers only its own kind. `socketProvides` on the socket-offering
part names the insert its holes stand in for; `bom.ts` then deducts one from what a part hung on that
cell orders, allocating each socket once, in document order, and never to the part that offers it.
Absent `socketProvides` nothing is deducted — sameness of size is not sameness of job. The deduction
is visible on the line (`providedBySockets`), because a quantity that silently drops is
indistinguishable from a bug at the printer.

**...except where a cell is a SOCKET, and that rule lives in two places that must agree** (D43).
`insert-for-countersunk-hole-3` spans four cells and three of them are open 13.2 mm sockets
(measured; the fourth takes the wall screw), so one thing may be installed into each — and the next
one is refused. `store.checkPlacement` and `bom.validate` both consult `itemSocketCells`; teaching
only the store made the app accept a drop that the parts list then called an error, within a minute.
Occupancy for this rule is a SEPARATE index of what is *in* each hole: the cell→item map keeps one
id per cell, so an accessory hung over an insert used to hide it and the cell took a second insert.

**The parts list is `computeBom(doc, catalog)`, NOT `store.bom()`** (D50). The store's catalogue is
set in an effect, so during the render after a correction it is still the old one — a list computed
through the store shows the previous fastener until an unrelated edit moves an item. Any state that
belongs to two owners (a React memo and an object mutated in an effect) has this hazard; prefer the
pure function of the immutable inputs.

**The list reports what is LEFT to print, and there is no print time anywhere** (D89). `doc.printed`
is partId → how many have come off the printer, and every line carries `printed` and `toPrint`.
Minutes are gone from `BomLine`, the totals and every export — the catalogue still MEASURES them
(`catalog.json`, `stl.ts`), because that is provenance, and the estimate belongs to a machine and a
profile rather than to this wall. Filament stays, and stays as the whole job: you buy a spool once.

**The document remembers a bigger count than the layout needs; the LINE caps it.** `setPrinted`
stores what it is given so that deleting a shelf and putting it back does not forget the four you
printed, and `printedOf` in `bom.ts` clamps to `quantity` at the one place a line is built. Cap it
on the way in and the fact is gone; cap it in the panel and the exports disagree with the screen.

**A ± button must NOT compute `printed ± 1` from what it rendered** (D89, and D58 again). Three
clicks arriving before a repaint all read the same value, so `+ + +` on a 12-plate line recorded
ONE — measured in the running app. `store.bumpPrinted` reads the document and adds; `setPrinted` is
for the typed field and for `all` / `none`, where the number is what the user actually said.

**The stepper's parts are `flex: none` and the `all` toggle has a FIXED width.** In a 320 px panel
flex shrank the buttons to 15 px and the field below two digits, and the wider `none` label pushed
the whole control out of its column and over the part name. The column is sized to hold the total;
the per-line filament column gave up 16 px for it.

### Reading a model file

**Two formats, one `MeshData`, one dispatcher.** `parseModelFile` in `src/core/modelFile.ts` is the
only place that chooses between `parseStl` and `parse3mf`; everything downstream takes a mesh and
neither knows nor cares. It sniffs the BYTES (`PK\x03\x04`) before trusting the extension, because
a 3MF renamed `.stl` is common and no STL can begin that way.

**`proposePart` is async and `proposeFromMesh` is not.** A 3MF is a ZIP, and there is no synchronous
inflate in a browser — `DecompressionStream` is the reason `zip.ts` needs no dependency and the
reason the front door returns a promise. The asynchrony stops at the file boundary: the
classification, the requirements and the estimate are all still a pure function of a mesh, which is
what most of `tests/import.test.ts` exercises.

**A 3MF is stored as a 3MF.** `meshLibrary` reads an imported part's bytes back through the same
dispatcher, keyed on `part.file`. Converting to STL on the way in would mean the bytes in storage
are not the file the person chose.

**Three ways a 3MF is silently wrong, and all three are handled in `threemf.ts`:**

- **Units.** An STL has none and this app assumes millimetres; a 3MF DECLARES one and it may be
  inches. Read at face value that is a part 25.4× too big, with nothing on screen to say why. Every
  coordinate is scaled once, on the way through, and an unknown unit is REFUSED rather than assumed
  to be mm.
- **Transforms.** An STL's coordinates are final; a 3MF's are per-object, placed by
  `<build><item transform>` and possibly nested through `<components>`. Ignoring them moves the part
  and, worse, TURNS it — and orientation is the one thing the app cannot detect its way out of,
  because `detect()` reads the mounting face off the geometry it is handed.
- **Winding.** A transform with a negative determinant MIRRORS, and a mirrored accessory is a
  left-hand hook on a right-hand wall — the same class of error the cyclic axis permutation in
  `meshLibrary.orient` exists to prevent. Triangles under a mirroring transform have their winding
  put back. **Do not test this through `measureMesh`**: it takes the absolute value of the volume, so
  a mesh wound inside out measures exactly like a correct one. `tests/threemf.test.ts` computes a
  signed volume itself, and was checked by disabling the flip and watching it go red.

**A 3MF may hold a whole build PLATE.** Several `<build><item>`s are MERGED into one part, because
that is right for an object assembled from components and wrong for six unrelated models — and which
one it is cannot be told from the file. So it is merged and SAID: the item count comes back and the
import dialog warns, because a person who dropped a plate in needs to know before the printer does.

`tools/scan.py` and `models/` are still STL-only. 3MF is an upload format, not a catalogue format.

### Parts, meshes and detection

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

**An insert seats IN the wall, and nothing else does** (D53). Every other part is drawn with its
mating face on the wall face, which is where `meshLibrary.orient` leaves it. A fitting's body goes
through the mouth into the throat and only its flange stays on this side — 7.5 mm in, 2.5 mm proud,
measured on all fifteen shipped fittings. `measureInsertSeat` (`src/core/insertSeat.ts`) finds the
split and `PartMesh.seat` carries it; `seatedZ` in `WallView3D` is the ONLY place the wall reads it,
covering placed items, wall fixings, junction fixings and the hover outline. Never write
`PANEL_DEPTH - depthMm` for a fitting again: that is all 10 mm of it inside an 8 mm plate, flange
buried and body out the back. Its classifier uses the part's own outline and NO cell centres, on
purpose — a cell-centre test reads the chiral two-cell fittings inside out, because for a `high`
mating end the oriented mesh is mirrored against its own footprint (PARKED P10).

**...and `PartInspector` must drop a fitting by the SAME `bodyMm`.** The wall learnt where an insert
goes and the dialog did not, so an insert lined up in the tool sat 7.5 mm deeper on the wall — the
one failure that file exists to prevent, within an hour of the change. It is a translation along the
wall normal on top of `mountingMatrixInFileFrame`, NEVER folded into `mountingMatrix`: the seat is
not a correction and must not turn up in the six numbers that get saved. Measured under the LIVE
axis/end through `orient`, not read off `loadPartMesh` — that geometry carries the SAVED mounting,
and picking a face changes which end goes into the wall.

**Where a feature sits ON a part must be measured on the ORIENTED mesh, not on the file** (D49,
PARKED P10). `orient` turns a `high`-mating part over (`v = -v`) and `toAxial` does not turn the
footprint with it, so the mesh is mirrored relative to its own cells. A symmetric footprint hides it
completely — and measuring `insert-for-countersunk-hole-3` in the file's frame swapped its middle
two cells, so the app offered the countersunk bore as a socket and refused a real one.

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

### The photograph of the wall

**The scale is two clicks and a typed distance, anchored on the FIRST click** (D88). Not EXIF, not
the wall size — those are guesses dressed as measurements, and `calibrated` on the document exists
to keep a fitted photo from being presented as a measured one. Anchoring on the first point is what
lets you click a corner you can name and have it stay put while the picture grows round it; anchored
on the centre, both points you just chose move and the feature walks off under the cursor. Test that
in IMAGE PIXELS: `|b − a| = realMm` stated on the wall points is true by construction and passes
with the factor inverted. A calibration that would breach `MIN/MAX_PHOTO_SPAN_MM` is REFUSED with a
sentence, never clamped — clamping keeps the anchor and makes the scale a lie.

**A document's `id` is a real identity and `emptyDoc()` mints a fresh one** (D103). It was the
constant `'layout'` for as long as only one document existed at a time, which was invisible until
walls could be SAVED: the shelf is keyed on that id — saving the same wall twice must replace it
rather than grow a copy — so a constant meant saving the garage, pressing New wall, saving the
workshop, and losing the garage. Minted from time AND randomness, never a counter: a share link
carries a document into a browser whose shelf this one has never seen. Nothing may sort ids or read
meaning into them.

**A saved wall's photograph is protected from the cache bound** (D103). `pruneWallPhotos` keeps the
newest few plus whatever it is told; every wall on the shelf carries its `photoId` so it can be told.
Deleting a wall does NOT delete its picture — another wall may share it.

**The alignment is on the document; the pixels are in IndexedDB.** Same split as an imported part,
and it makes "this browser does not have the picture" a real state that has to be said out loud —
a share link carries the alignment and cannot carry a photograph. Re-attaching mints a NEW id even
though the alignment is kept: the id is the storage key and both views cache their decoded copy
against it, so re-storing under the same key leaves them drawing the old picture (D50/D52/D66 again).

**Removing or replacing a photo must NOT delete its bytes** (D88). Both are ordinary undoable edits,
and undo has to give the picture back — dropping the pixels leaves undo restoring a layout that
remembers exactly where a photograph goes and cannot show it, which is the one state the feature
works to avoid. Nor can the store be swept the way a part's photo is: there is no list of documents
the way there is a list of parts, so "no open document claims it" is not evidence that nothing does
— the layout holding an id may be a file on disk. `pruneWallPhotos` bounds it as a CACHE instead,
keeping the newest `WALL_PHOTOS_KEPT` and whatever the caller protects, at startup only. Ordered by
key, compared by LENGTH first: an id is `wallphoto` + base-36 milliseconds, so a plain string sort
inverts on the day that stamp gains a digit and prunes the newest photo instead of the oldest.

**In the plan, a cell BEHIND a photo has to be made a hole, and skipping its fill does not do it**
(D88). In 3D "behind" works for free, because a cell really is a hole. In the plan a cell is a filled
hexagon in an opaque colour, so the photo was drawn correctly and then painted over — "behind" came
out as "not shown at all". And the plate path already covers the whole hexagon out to its corners
with the opening painted ON TOP, so leaving the opening unpainted leaves plate there. The hole must
be taken OUT: plate and openings in one even-odd fill. `showThrough` joins the static layer's cache
key, or the layer keeps its opaque cells from before the photo arrived.

**The photo drag commits ONCE, on release** — a zone gets away with per-frame commits because it
moves centimetres; a photo is dragged the width of the wall and would fill `HISTORY_LIMIT` with one
gesture. Which means the live position is local, which means it must live in a REF: held in state it
is invisible to the release handler, and every quick flick moved nothing at all. That is D58 exactly,
made again directly beneath the comment warning about it, and found by driving the app.

**The photo can be TURNED, and the plan must never rotate its canvas to do it** (D104).
`rotationDeg` is counter-clockwise as the wall is seen, about the photo's own CENTRE, and
`photoCorners` is the ONE place it becomes geometry — both views and `photoHit` go through it, so the
picture and the pointer cannot disagree about where the photo is. The plan is y-up and its pixels are
not (D70), so turning the canvas by the angle needs a negation — which is the same hand-written sign
that put every seam and every outline one edge out. Do not write it. Map the four corners through
`toScreen` and build the matrix from two edges; there is then nothing to get backwards, and 3D needs
no correction at all because it is y-up in world space exactly as the wall is. `xMm`/`yMm` stay the
corner of the UNROTATED rectangle: that field and `mmPerPixel` describe the photo in its own frame.
Zero is stored as ABSENT, so a layout nobody has turned serialises exactly as it always did.

### UI, state and rendering

**`NumberField`'s schedule follows what its commit COSTS** (D67). `commitOn: 'type'` (default) is
for a value with a live preview — the wall size, where watching it resize IS the feature.
`commitOn: 'confirm'` is for one whose commit re-plans the wall: a blocked zone's size goes through
`setObstacles`, so typing `220` over `146` would re-cut every plate three times and leave three undo
steps. Same parsing, same clamping, same blur path; it just stops calling `valueWhileTyping`.

**A measurement field is `NumberField`, never a raw controlled `<input type="number">`.** The
obvious form — `value={mm} onChange={e => setMm(Number(e.target.value))}` — cannot be cleared:
`Number('')` is `0`, the document clamps it up to the minimum, and the field repaints before the
second digit lands, so typing `1000` over `2400` gives `501000`. The text being edited is LOCAL and
the number commits separately, only when it parses AND is in range — which is what lets the
half-typed `1` on the way to `1000` pass without resizing the wall. Its rules are pure functions
(`valueWhileTyping`, `valueOnBlur`, `formatValue`) so they can be held to a contract without a DOM.
The range must come from whoever owns the clamp — `MIN_WALL_MM`/`MAX_WALL_MM` live in `store.ts`
beside `clampDim` — or the field silently refuses a value the document would have taken.

**Anything a pointer builds up between `down` and `up` lives in a REF.** State is only visible after
a render and the release can arrive first. It cost the part drag once, and then the measure/zone
gesture — held in state, every quick flick measured nothing at all (D58). The state copy exists only
to draw.

**In `PartInspector`, one effect adds a thing to the scene and its own cleanup removes it** (D52).
The model effect used to add the part's mesh and overwrite `s.part` without removing the old one, so
a re-run left a second copy standing where the first was — and since every other effect drives
`s.part`, the abandoned one sat still while the real one moved. The plate has the same shape now:
added in the effect, removed in the cleanup. Anything that measures the body (the plate's stand-off,
the transform) must also depend on `bodyTick`, or a re-loaded part keeps the previous one's plate.

**`WallView3D` keeps a SECOND mesh cache in front of `meshLibrary`'s.** `forgetPartMesh` clears the
library's copy and nothing else; the view's `meshes` ref is dropped on `catalog` identity. Miss that
and a saved mounting correction updates the catalogue, drops the library entry, rebuilds the item
group — and redraws from the stale local copy, so the part never visibly turns.

**`THREE.Spherical` is Y-up. `PartInspector` is Z-up.** Reading a Z-up camera position into a Y-up
spherical and back turns a vertical drag into rotation about the wrong pole (it comes out sideways)
and the `phi` clamp blocks it. The inspector holds azimuth/elevation itself. `WallView3D` is Y-up
throughout and is fine — do not "unify" them without checking which frame each actually uses.

**A colour is resolved by `colors.ts` and by nothing else** (D93). Four levels, most specific
first: the placed item, its parts-list line, the default for its kind (`colors.panels` /
`colors.parts`), then nothing. Both views, the parts list and the exports all ask through
`colorOfItem` / `colorOfPanel` / `colorOfLine`, because the failure here is the plan and the 3D view
painting one wall two ways. A plate's colour is keyed by the LINE it is counted on
(`bom.panelLineKeys`), so a cut or bordered plate takes the colour of the generated plate it is.

**"No colour" is an answer and it is not black.** An absent key means "as the theme draws it": a
native colour input handed nothing shows `#000000`, which reads as a decision nobody made. An
untouched layout still serialises with no `colors` key at all, and a swatch hatches rather than
showing black.

**`normaliseColor` is the gate, and a TOKEN IS NOT A HEX COLOUR.** A colour ends up in a canvas
`fillStyle` and a `THREE.Color`, which accept anything and mis-handle what they cannot parse, so only
`#rgb`/`#rrggbb` gets in. And a swatch opening on the theme's own colour must convert it through a 2D
context first: `--accent` computes to `rgb(87 174 232)` — the token layer builds it from an
`--accent-rgb` triple — and a colour input handed that shows black, silently.

**The colour joins the 3D instancing key, like `lit`.** One `InstancedMesh` per group shares one
material. In the plan, cells are gathered into one path PER COLOUR, never one fill per plate.

**Which plates a parts-list line means is `bom.panelsForLine`, and nothing else may answer it**
(D92). Not "the panels with that partId": a cut, app-sized or bordered plate has left the stock line
for a generated `custom/…` one (D56, D66), so a view deciding for itself lights a plate the line does
not count. Both views take the same ids. In 3D, LIT joins the instancing key — one `InstancedMesh`
per shape shares one material, so two plates of a shape cannot be drawn in two tones from one batch.
A lit plate is the plate's tone carried TOWARD the selection colour, never replaced by it: replaced,
the honeycomb reads as a flat slab and you cannot see the cells, which is usually why you clicked.

**A prop the draw effect reads has to be in its dependency array.** `litPanelIds` reached
`WallCanvas` and was left out of the effect's deps, so clicking a line marked the row and repainted
nothing — which looks exactly like a highlight that does not work, and was only found by clicking it.
It then happened AGAIN with `doc.colors` and the 3D item effect (D94): the plates repainted and the
parts did not, reported as "the colour selector on the part is not working, but it is on the panels".
`WallView3D` has FIVE effects that draw, each with its own array; a new prop has to be added to every
one that reads it, and the symptom never looks like a dependency — it looks like half a feature.

**The colour swatch is a POPOVER with its own OK** (D95). The native `<input type="color">` has no
confirm button on macOS — the system Colours panel just closes — so there was no moment a person
could point at. Presets, the native picker behind "Custom…", a hex field, Cancel / OK; portalled to
the body because the parts list clips its overflow and that is where the swatches live.

**Wall fixings and accessory inserts take a colour too** (D95). They are printed parts with their own
parts-list lines, but they are NOT `doc.items` — they come from `fixingPlanFor` and
`fasteningPlanFor` — so `colorOfItem` cannot see them and they need `colorOfLine(colors, partId,
false)`. Miss that and they are the one thing on the wall ignoring the colour chosen for their kind.
`colorsInUse` reads the PARTS LIST for the same reason: walking the document cannot see a planned
fixing, so a wall coloured only through its fixings reported no colours at all.

**A colour commits on the picker's OK, never while it is being dragged** (D94). React's `onChange`
on `<input type="color">` is the native `input` event and fires continuously, so a live commit
repaints every plate on the wall per frame and fills the undo stack with shades nobody chose. The
native `change` event is the confirmation; `input` moves the swatch and stops there. Same rule as
`NumberField`'s `commitOn: 'confirm'`, and `shouldCommit` refuses a no-op pick — on an INHERITED
swatch that would freeze the default into an override that stops following it.

**The picked wall fixing is SHELL state, never `selection`** (D90). Every consumer of `selection`
looks its ids up in `doc.items`, so a cell key in that list is a stranger to all of them. It lives in
`App`, the 3D view takes it as a prop and draws it in the selection colour, and Delete is told apart
from the item handler and the photograph's by a CONDITION — items when something is selected, a
fixing when one is picked and nothing is — never by which `window` listener runs first (D88).

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

- **`src/core/types.ts`** — the document model, and the contract every other module builds
  against. Two rules the whole app rests on are stated there: position is ALWAYS a `Hex`, and the
  document is immutable (which is what makes undo a list of snapshots rather than a reconstruction
  problem, and lets `bom.ts` cache on object identity).
- **`src/core/constants.ts`** — the measured geometry, `LATTICE_ANCHOR`, and the printer beds:
  `BEDS`, and `bedFor`, which is the ONLY thing that turns a `bedId` plus a typed size into a bed
  (D99). Nothing else defines any of it.
- **`src/core/hex.ts`** — axial hex math (flat-top), rotation, occupancy. Every other module
  depends on its exact semantics, and none of them may re-derive it.
- **`src/core/tiling.ts`** — panel solver and seam detection, plus the bed-driven plate sizes
  (`plateFootprintMm`, `maxPlateForBed`, `generatedPlateSizes`) behind "Fit to printer".
- **`src/core/bom.ts`** — parts-list aggregation and `validate()`.
- **`src/core/store.ts`** — commands, placement rules, undo/redo.
- **`src/core/persist.ts` / `exporters.ts`** — save/load/share, CSV/markdown/print.
- **`src/core/wallStore.ts`** — the SESSION (the wall on screen, written back on every edit, so a
  refresh costs nothing) and the SHELF (the walls somebody deliberately named and kept). Two stores
  answering two different fears, and keeping them apart is what makes "New wall" safe — if the
  session were the save, starting a blank one would overwrite what you had. Both hold
  `serialize(doc)`, so a wall on the shelf, in a file and in a share link are one format with one
  migration path. Pure above the storage functions, and it takes its clock as an argument (D103).
  **`src/ui/WallsDialog.tsx`** is its one surface — Save / New / Open / Delete, reached from `Walls`
  in the title bar. Delete asks in place: a saved wall is the only thing in this app a click can
  destroy for good, because the shelf is deliberately outside the undo stack.
- **`src/core/stl.ts`** — STL parsing, mesh measurement, the fitted print estimator.
- **`src/core/threemf.ts`** — 3MF reading: units, transforms and winding, into the same
  `MeshData` an STL gives. **`src/core/zip.ts`** is the ZIP half, and **`src/core/modelFile.ts`**
  is the one place that decides which reader a file gets.
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
- **`src/core/insertSeat.ts`** — how far an insert goes into a cell and how far its flange stands
  proud, measured on the oriented mesh. The one part of the catalogue that does not seat on the wall
  face (D53).
- **`src/core/fixings.ts`** — where the wall fixings go, across the assembly; and `fastenerCells`,
  which of a part's own cells carry the insert it hangs on. Both the wall and the alignment tool
  place inserts through that one function.
- **`src/core/obstacles.ts`** — switches, sockets and pipes, as cells the wall must avoid.
- **`src/core/honeycomb.ts`** — the parametric model maker: cells (and an optional frame) become a
  printable, watertight plate, plus a binary STL writer. Built from the measured bore profile, and
  checked against all seven shipped plates. No polygon boolean anywhere — a border is two half-planes
  and a convex polygon clipped by one stays convex.
- **`src/core/panelModel.ts`** — the bridge from a planned panel to a printable one: which cells a
  plate really has, which frame lines apply, and which sides it meets. The single owner of the
  planner-versus-printer split (D56).
- **`src/core/colors.ts`** — what colour a thing is printed in: the four levels, the hex gate, and
  the palette a build actually uses. Pure, and the only place the order is decided (D93).
- **`src/core/measure.ts`** — measuring on the plan, snapping, and blocked zones as rectangles you
  draw. Pure millimetres; the canvas supplies points and draws answers.
- **`src/core/wallPhoto.ts`** — the photograph of the real wall: where it sits, how big it draws,
  and the two-point calibration that turns image pixels into millimetres. Pure, and it never needs
  the pixels to answer anything. **`src/ui/wallPhotoImage.ts`** is the other half — the bytes, and
  ONE decoded image per photo id shared by both views, because the plan redraws on every pointer
  move and a browser will not decode a 2048 px photograph per frame.
- **`src/core/projectParts.ts`** — which parts this wall is built from: the basket the library fills
  and the rail shows. The only reader of `doc.library`, the one place that knows a PLACED part counts
  whether the list names it or not (D71), and the home of `isShoppable` — the rule that a shipped
  plate is not something anyone picks (D98).
- **`src/ui/meshLibrary.ts`** — loads a part's STL, orients it to the wall, caches per part id;
  and `solidToGeometry` / `plateGeometry`, the bridge from the generator's `SolidMesh` to three.js
  that both views draw every plate through (D97). Load-bearing logic despite living in `ui/`: it
  decides which face goes against the wall.
- **`src/ui/partPhotos.ts`** — a photograph of the printed part: the sizing rule (pure, tested), the
  downscale, and the object-URL cache. Storage is `userCatalog.ts`'s `photos` store.
- **`src/ui/partThumbnails.ts`** — a rendered preview of a part, through ONE offscreen WebGL context
  for the whole catalogue. A canvas per tile is not an option: a browser allows about sixteen live
  contexts and there are 51+ tiles, so the oldest get killed and those tiles go blank. Renders are
  serialised through a promise chain and cached per part id.
- **`src/ui/PartImage.tsx`** — the picture of a part, wherever one is shown: the PHOTOGRAPH if there
  is one, the render otherwise. **One component, not one per surface** — the rail and the library
  both want it and want it identically, and two copies would drift the moment one learnt about
  photos and the other did not. That is the shape of D50, D52 and D66, each of which was a second
  reader of one fact quietly disagreeing with the first.
- **`src/ui/BomPanel.tsx`** — the parts list itself: sections, issues in plain language, the printed
  counts, the colour swatches, the totals. Pure presentation over a computed `Bom` — it derives no
  number of its own beyond formatting, and every action leaves through a callback. When something
  here looks wrong, the answer is almost always in `bom.ts`.
- **`src/ui/ObstaclePanel.tsx` / `src/ui/WallPhotoPanel.tsx`** — the two rails under the parts list,
  rendered through `BomPanel`'s `extras` slot: blocked zones with the custom plates they force, and
  the wall photograph's alignment. Being in `extras` is why the Photo TOOL exists in the plan
  toolbar as well (D88) — this panel is below a solved wall's entire parts list.
- **`src/ui/Icon.tsx`** — the icon set: one grid, one stroke weight, one rule about colour. The
  product had two glyphs before it, both typed as text, which is why a toolbar of eight actions read
  as a debug panel. Geometry that means something here is drawn from the product — the view switch's
  marks are a real flat-top hexagon and three of them in the lattice's own stagger.
- **`src/ui/ToolMenu.tsx`** — the `⋯` in the title bar, holding the catalogue-maintenance actions
  (Align, Setup, Mine). Closes on `pointerdown` and not on `click`, because the wall is a drag
  surface and a menu that waits for the button to come back up survives the whole of the first drag
  under it; Escape closes it AND returns focus to the trigger. Not portalled — the title bar does not
  clip its overflow the way the parts list does.
- **`src/ui/NumberField.tsx` / `src/ui/ColorSwatch.tsx`** — the two shared inputs, and they share a
  shape worth knowing before writing a third: the value being edited is LOCAL, the commit is
  separate and deliberate (`commitOn: 'confirm'`; the popover's OK), and the rules that decide when
  a draft becomes a value are exported as PURE functions so they can be held to a contract without a
  DOM (`valueWhileTyping`, `valueOnBlur`, `swatchColor`, `shouldCommit`). Both exist because the
  obvious controlled input is unusable for the job — one cannot be cleared while typing, the other
  repaints the whole wall per frame and fills the undo stack.
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

  **Its honeycomb is a real plate from the GENERATOR** — `plateGeometry(columns, rows)` in
  `meshLibrary`, at the size of the smallest shipped panel that covers the patch, aligned by putting
  its most central cell where the part's cell (0, 0) goes (D46). Drawing the cell from constants was
  right and still not believable to someone holding a printed panel up to the screen; the shipped
  STL was the answer until D97, and cannot be now — with the mouth against the wall a printed plate
  would have to be drawn turned over, and a turned-over plate is a MIRRORED cell block whose holes
  land between the cells this dialog draws its sockets on. The drawn two-layer plate (D45, mouth
  against the wall since D97) is the fallback for a patch no plate covers. Do NOT dispose that
  geometry on rebuild: it is `meshLibrary`'s, cached per size and shared with the wall view.

  **So is its insert** (D53). The chosen fastener's own STL, seated by `measureInsertSeat` — body in
  the hole, flange proud — because what a part is being lined up against is the SOCKET in the top of
  an insert, and a drawn flange has none. Same loader, same cache, same rule about disposal. It is
  drawn `fastenerCount` times in the cells nearest the anchor, NOT once per covered cell: one per
  cell is the seven-inserts-for-two-pegs error drawn as a picture, and it contradicts the count
  typed directly below it. `FootprintEditor` takes those same cells (`inserts`), not a flag.

  **The dialog is keyed on the part** (`key={part.id}` in `App.tsx`). Every control seeds its state
  from the part it opened on, and React keeps state across a prop change — so a part swapped under
  an open dialog would inherit the previous one's alignment and offer to save it.

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

**A footprint need not contain the origin, and `anchorOf` is why** (D46). The drag hangs off the
ANCHOR, not off cell (0, 0): a two-peg shelf uses the cells above and below its middle and nothing
in between. `applyOverrides`, `withFootprint` and the cell editor all take the anchor from the cells
that are actually there. The floor is one cell — a part covering nothing cannot be checked.

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
the BOM then reported as overlaps. **The drag ghosts are the same question and must call
`partCells`** (D51): both re-derived it with `placeFootprint` on the raw footprint, skipping the
anchor, so the green honeycomb sat a cell from where the part landed as soon as a footprint had a
non-origin anchor. `tests/ghost.test.ts` is the guard.

### Catalogue

Imported parts never go in `catalog.json`. They live in localStorage (metadata) and IndexedDB (the
STL bytes, for the 3D view) and are merged at read time by `mergeCatalog`, which memoises on
identity — `bom.ts` caches its part index in a `WeakMap` keyed on the `Catalog` object, so a fresh
merge per render would rebuild that index per render.

**Overrides are applied AFTER the merge, and the order is load-bearing** (D71). It used to be
`applyOverrides(shipped, …)` with the imports bolted on afterwards, so a correction keyed on a
`user/…` id was written, stored, exported — and never applied: you could line an imported part up,
watch the dialog save it, and find it on the wall the way the detector guessed. One pipe now,
`applyOverrides(mergeCatalog(shipped, mine), overrides)`. Same shape as D50, D52 and D66.

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

### Shopping for parts: the library, and what the rail holds

The catalogue is a SHOP and the rail is what came home from it (D71). `PartLibrary` (Browse parts…)
shows every part ON SALE as a card with a picture, shelves and a sort; `CatalogPanel` shows only the
parts put in the project. Two surfaces because browsing and building are different jobs.

**`isShoppable` is the only place that says a part is not on sale** (D98). Two rules live in it, and
the shelf, the search, the `Everything` count and the `Browse n parts` label all read
`shoppableParts(catalog)` — **42 of the 51** shipped, plus whatever was imported, and no Panels shelf.
The app sizes and generates every PLATE it draws (D97), so nobody picks one; and the two COVERS
(`box-and-usb-holder-cover`, `sd-card-holder-cover`) are lids for other accessories, which nothing
mounts on the wall. Excluded by id and never by a `-cover` suffix — `cover-contersunk` is a genuine
wall part a name rule would take with them. They stay IN the catalogue, because three things still read them: the solver
takes their sizes with "Fit to printer" off, `bom.ts` costs a generated plate against the biggest per
cell, and `PartInspector` sizes its wall patch from the smallest. A plate somebody IMPORTED is still
theirs and stays on the shelves — `typeFromName` calls anything named `wall-honeycomb…` a panel, and
hiding it would take an upload off the one surface that can delete it.

**The project's parts are on the DOCUMENT** (`LayoutDoc.library`), so they travel down a share link
and undo like every other edit. `src/core/projectParts.ts` is the ONLY module that reads that field.

**A placed part is in the project whether the list names it or not.** `projectPartIds` unions the
list with `doc.items`, and everything goes through it. Skip that and every layout saved before the
field existed opens with a wall full of hooks and an empty rail. `addItem` also adds to the list —
dropping a part straight onto the wall is a way of shopping for it, and the two paths must agree.
**Shipped panels are excluded from the rail** by that same `isShoppable`: the tiler picks those, so
"Solve panels" must not fill the basket with plates nobody chose. **An unresolvable id is kept and counted, never dropped** — a
friend's layout naming their uploads must come back naming them still.

**A photo is keyed on part id and on nothing else** — its own IndexedDB store, absence being the
answer to "has this one got a photo". No flag to keep true, and a shipped part can have one too.
Downscaled to 640 px WebP before storing (`src/ui/partPhotos.ts`): the quota is shared with the STL
bytes the 3D view needs, and what breaks when it fills is the wall's meshes, somewhere else entirely.

**An import is two steps and the second is mandatory.** Describe (`ImportDialog`), then line up
(`PartInspector` with `intent="import"`); the part joins the library only when the alignment is
saved. The detector declines to guess a mounting face for 27 of 51 parts, so a part added without
this step sits wrong on the wall. The STL bytes go into IndexedDB BEFORE step 2 opens, because
`meshLibrary` reads an imported part's mesh from exactly there — which makes those bytes the only
thing an abandoned import leaves behind, and `cancelImport` sweeps them at either step. The alignment
is stored as an ordinary `MountingOverride`, so `Setup (n)` carries it to the repo like any other.

**A closed tab cannot run `cancelImport`, so `sweepOrphans` runs once at startup** and deletes stored
models and photos that no part claims. Two rules keep it from being a data-loss bug of its own. It is
gated on `LoadResult.readable`, because "no imports" and "could not read the store" are the same
empty array and acting on the second would delete every upload a person had because Safari refused
localStorage once. And it sweeps against the WHOLE catalogue, not just the imports: a photo is keyed
on part id alone so that a shipped part can have one. Startup only — mid-session it would race a
pending import, whose bytes are down and whose entry deliberately does not exist yet.

**A `max-inline-size` narrower than a panel's widest row does not shrink it — the rows escape**
(D95). `inline-size: max-content` with a cap reads as "no wider than this" and means "and the
children keep their own width anyway": the colour popover's rows hung 69 px past its right edge, OK
outside the panel it belonged to. A cap has to be wide enough for the widest row — which is usually
the BUTTONS, not the content you designed around — with `min-inline-size: 0` on the rows so the cap
makes them wrap, and `flex-wrap` where the row is buttons. Check it by measuring every descendant's
rect against the container's in the running app; `scrollWidth > clientWidth` catches it too.

**Every modal backdrop is `.modal-scrim` in `base.css`, and that is the ONLY place its centring is
defined.** `place-items: center` alone leaves an implicit `auto` row; a dialog then asking for a
height as a percentage (`block-size: min(56rem, 100%)`) is asking against a track sized by its own
content, which is a cycle, so the percentage is dropped, the track takes the dialog's max-content
height and the dialog is faithfully centred somewhere off screen. `grid-template-rows: minmax(0, 1fr)`
breaks the cycle.

**This one mechanism has produced three separate bugs**, which is why the rule is shared and not
copied: `AlignPanel` laid a 768 px panel out at `top: 1236` inside a container spanning 0–900 and was
rescued by switching to flex with the cause never found; `PartLibrary` opened onto a dimmed page with
nothing on it, 1554 px below the fold; `ImportDialog` put `Cancel` and `Next` 295 px below a 480 px
viewport, so on a short window an import could be neither finished nor cancelled. Add a fourth modal
by putting `modal-scrim` on its backdrop — do not write the properties again.

### The plan section's tools

Four modal tools in `WallCanvas`, switched by the toolbar or by `V` / `M` / `B` / `P`, with Escape
always returning to Select. Modal rather than modifier-based because most of them are drags on empty
wall, and a marquee, a measurement, a new zone and a photograph being slid about cannot all be that
at once.

- **Measure** — drag between two points, with snapping (`shift` turns it off). The readout is drawn
  on the canvas AND rendered into the DOM, because a number painted into a canvas cannot be read by a
  screen reader, selected, or copied — and it is the one number a person wants to write down.
- **Blocked zone** — drag a rectangle the honeycomb must keep out of. It is an `Obstacle`; there is no
  second path, so `store.setObstacles` re-cuts the panels exactly as before. Drawing one returns to
  Select so it can be nudged straight away.
- **Select** — as before, plus moving and resizing zones by their handles. Zone hit-testing comes
  first and cannot steal a click from a part: a zone's cells are cut, so nothing can be placed there.
- **Photo** — bring a photograph in, slide it, and set its scale. Three steps for the scale and not
  two: **Set scale** arms the gesture, the drag leaves its two marks ON the picture where they can
  be checked against the thing that was measured, and the distance is typed afterwards with both
  marks still visible. Asking for the number first means holding it in your head while aiming, and a
  `prompt()` over the canvas hides the very points it is asking about. The calibration drag never
  snaps: the two points are features in the PHOTOGRAPH, and snapping would drag each click up to
  half a cell onto a lattice that knows nothing about where they are.

  **The tool is never disabled, because it is how you GET a photograph.** It was greyed out until
  one existed in the rail — which is below the whole parts list — so the one control naming the
  feature was dead, and the `title` explaining why never appeared: a browser fires no tooltip on a
  disabled button. Its strip carries the file picker when there is no photo, and the depth toggle
  and opacity slider when there is: those two are adjusted constantly while lining a zone up, and
  everything else about the photo is a once-per-session job that stays in the rail. `attachWallPhoto`
  in `src/ui/wallPhotoImage.ts` is the ONE owner of "a chosen file becomes the wall's photograph",
  because there are now two front doors onto it.

  **Backspace takes the photo off, and the scope is the TOOL plus an empty selection.** The shell
  owns that key too — it deletes the selected items — and both handlers are on `window`, where
  neither can rely on running first. So they are told apart by a condition rather than by order:
  the shell acts only when something is selected, this only when nothing is. Without the tool as
  scope as well, Backspace on the bare plan would delete a photograph somebody spent five minutes
  calibrating.

A **border** (`doc.frame`) is per-side plus "round the blocked zones", with a thickness in mm.
**Border** (`E`) in the plan toolbar switches all four sides on with the thickness beside it — the
switch you reach for while looking at the wall; the per-side checkboxes stay in the parts-list rail.
The plan draws it from the generator's own rule — an edge exists where the next position is empty —
so it cannot show an edge the plate will not have.

**A blocked zone's name and size are HTML controls over the canvas, not paint** (`ZoneTag`). Click
either and type: a switch plate is 146 × 86 and that is a number you enter, not a rectangle you nudge
until it looks about right. The size is two fields and a separate `×`, so a typed measurement cannot
fail on a separator. The tag layer is `pointer-events: none` with each tag taking it back, so the
wall underneath still drags, and the tag sits at the zone's CORNER so the middle stays grabbable.

**Fit to printer** (top bar, off by default) sizes plates to the chosen bed instead of using the
seven shipped ones: a Prusa Mini gets 8 × 7 plates, a 400 mm printer gets 19 × 16. Deliberately not
stored on the document — it changes what the NEXT solve produces, and a saved layout already records
what it produced.

**A printer that is not on the list is `bedId: 'custom'` plus `doc.customBed`, resolved by `bedFor`
and by nothing else** (D99). `bedId` alone stopped being enough to say how big the plate is, so any
reader still doing its own `BEDS.find` gets undefined and falls back to "unknown printer" — a wall
with no panels. The size is on the DOCUMENT because a saved layout's plates were cut to that bed;
it is clamped to `MIN_BED_MM`–`MAX_BED_MM` in the store AND again in `deserialize`, and the ceiling
is real: the plate grid grows with the bed's AREA, so 1000 × 1000 already offers 1968 sizes.

### Two views

`WallView3D.tsx` (default) and `WallCanvas.tsx` (2D plan) drive the same store, so they cannot
drift. EVERY plate is drawn in 3D from the **generator** — the same triangles the download writes —
rather than from the drawn approximation, which knows about cells and holes but not about a framed
edge, and rather than from the shipped STL, which since D97 would have to be hung turned over and
would then be a mirrored cell block. What you see is what you print. Both read their colours from the token layer via `getComputedStyle` and both need a
`MutationObserver` on `data-theme` to repaint — a theme switch changes no React state.

**They are not equivalent, and the asymmetry is worth knowing before you go looking.** The plan does
not draw the WALL FIXINGS at all — the countersunk inserts and the junction fasteners exist only in
3D — so everything about picking, moving and colouring one lives there (D90, D95). Anything the two
DO share must go through the same core function, which is what `panelsForLine`, `panelLineKeys` and
`colors.ts` are for. And `WallView3D` has five separate drawing effects, each with its own
dependency array: a new prop has to be added to every one that reads it, or half the wall silently
keeps painting the old picture (D92, D94).

The live drag is held in a **ref**, written synchronously at gesture start, because `drag` state is
only visible after a render and a fast pointer can move and release before that lands. Catalogue
tiles are `draggable={false}` with `dragstart` cancelled: the gesture is Pointer Events only, and
letting the browser promote it to a native HTML5 drag swallows every subsequent pointer event.

In 3D, a panel is **one** extruded shape (union outline + one hole per cell), not one ring per cell.
Per-cell rings put two coincident 8 mm side walls inside solid material at every boundary, which is
what made the plate look thick. Part depth comes from the measured `projectionMm`, never from
`max(bbox)`.

A placed part marks the cells it uses with a **ring, never a plug**. It was a solid prism in the
mouth, which fills the hole — and a cell is a hole, so the marker meant to point at a cell hid
whatever was in it: the socket of an insert, the bore for a bolt, the daylight through a hollow one.
That is D44's lesson, learnt again on the wall once fittings were seated in their cells rather than
standing out in the room (D53). Same for anything else this view draws over a cell.

Placed parts are drawn from their **real STL** (`src/ui/meshLibrary.ts`), loaded lazily and cached
per part id, with the measured box as placeholder and fallback. Orientation comes from re-running
`detect()` rather than from a second rule, so the mesh cannot disagree with the footprint. Only
geometry this view built is disposed on rebuild — a cached part mesh is shared by every placement
of that part, and disposing it would blank all of them.

### UI conventions

`src/ui/tokens.css` is the only place a colour, size, radius or duration is defined; `TOKENS.md`
documents the groups and carries the measured contrast table. Components consume tokens — no
literals. `base.css` strips `<button>` deliberately; the button component lives in `App.css`.

**The exception is a colour the USER chose** (D93): a filament colour is document data, like a wall
size, and arrives as an inline style. The rule above governs what the app draws ITSELF.

**The theme is one button in the top-right corner, and it is remembered** (D91). It resolves
`system` through `prefers-color-scheme` before offering the opposite, which is what lets it say
which theme it is switching to; the choice is stored in `localStorage` behind a `try`, because a
browser refusing storage is not a reason to refuse the theme. Both canvases repaint off the
`data-theme` attribute — see the `MutationObserver` note under "Two views".

**The shell's chrome is TWO tiers and they are split by what the controls do** (D100). The title bar
says what this DOCUMENT is — mark, layout name, the wall's own figures — with the app-level actions
at the far end; the toolbar carries the parameters the next solve READS. Nothing in the first tier
changes what gets printed and everything in the second does, which is the whole reason for the split:
as one row of twenty controls at one weight it was a list, and a list is what you read when you do
not know which thing matters. `--titlebar-height` and `--toolbar-height` are separate tokens because
they are not one thing that got taller.

**A toolbar control belongs to a GROUP, and a group is a well.** The bar asks three questions — how
big is the wall, what can you print, what colour — with one answer button between them.
`.toolbar__group` is that well, at `--surface-0`: the shell's ground, which is DARKER than the bar in
both themes, so one token reads as "set into the bar" either way round and there is no second
definition to keep in step. **The group shrinks and WRAPS; its children never shrink.** Flex's
default `min-width: auto` only protects a shrunk item as far as its own content box, so squeezed, the
printer well printed its select and both build-plate fields on top of each other — "Custom…380 340mm"
in one 90px run, which reads as a rendering fault rather than as a full bar. The plan view's tool
strip needs the same pair, for the same reason.

**Four button weights, and the point of `.button` is choosing between them** (D100). `--primary` for
the one action a region exists for, at most one per group; the bare class for a real bordered
secondary; `--subtle` (tinted, no border) for something always available that is not what you came
for; `--ghost` for toolbar and list-row actions. Two live consequences: the rail's `Browse parts…` is
NOT primary — a full-width filled blue bar there put a second primary on screen beside `Solve
panels`, and two primaries mean neither is — and the parts list's four exports are one ghost
segmented strip, because exporting is a utility and a filled `Print` at the front carried the weight
of the panel's main action.

**Every icon comes from `src/ui/Icon.tsx` and nowhere else.** 24 × 24 grid, 1.75 stroke, rendered at
`--icon-size-sm`/`md`, `aria-hidden` (the control around it has the label). Colour is always the
parent's job, which is what lets one glyph sit in a ghost button, a primary button and a danger row
without three variants of it.

**`fill: none` must be a RULE, not the `fill="none"` attribute.** `base.css` carries
`svg { fill: currentColor }` for the app's other inline SVG, and a presentation attribute loses to any
stylesheet declaration — so every stroked icon rendered as a solid blob. It looks like a badly drawn
icon rather than a specificity bug, which is why it is worth knowing before drawing the next one.

**A token fallback must never hold a literal.** `var(--radius-xs, 3px)` appeared in five rules across
two files; `--radius-xs` has never existed, so all five drew a 3px literal — the exact drift the token
layer exists to stop, and invisible, because the CSS reads as though it were tokenised. Grep for
`var(--[a-z-]*, ` before believing this file has no literals in it.

**The 3D view's background is CSS, not three.js** (D100). The renderer is built with `alpha: true`
and the scene sets no background, so `.wall3d`'s radial gradient IS the backdrop — `--canvas-wall` at
the edges lifted toward `--canvas-panel-tint` under the subject, which is the right relationship in
both themes and one definition instead of two. Setting `scene.background` again would paint over it.

**The canvas trio is ORDERED, and the order is a contract: wall < panel tint < cell** (D101). Depth
reads inward — the void, then the plate, then the opening through it. Dark had the cell and the plate
the wrong way round and 0.006 of luminance apart, so a solved wall drew in the plan as a faint smudge:
3,472 hexagons you could not see, on the view where you measure and block out a light switch. **Move
one of the three and you must re-measure the other two** — the numbers in TOKENS.md are the check, and
the row that matters is "cell vs wall (field separation)" (now 1.68:1 in dark, was 1.17:1). Moving the
cell also retired `--canvas-grid`'s theme-invariance: that token was shared only because one rung
cleared 3:1 against both themes' canvas colours, which it no longer does, so dark takes
`--neutral-450`. `--blue-tint-dark` is composited over the cell and has to be recomputed with it.

**The logo is TWO artworks, and `tools/logo.py` builds both** (D102). The supplied master letters its
name in dark grey, which is invisible on the dark theme's `#14181B` title bar — so
`src/ui/assets/honeycomb-logo.png` and `-dark.png` are a pair, chosen by `App.css` through the same
`prefers-color-scheme` + `[data-theme]` guard as any themed token, drawn as a `background-image` on a
`role="img"` box because only CSS can see the theme and two `<img>` tags would fetch both. The dark
variant is DERIVED, not drawn: `v -> max(v, 255 - v)` on the neutrals only, blended by saturation so
the gold is untouched and the anti-aliased fringe has no hard edge. **If the master changes, run
`python tools/logo.py`** — nothing else regenerates them, re-running reproduces the committed files
byte for byte, and the aspect ratio it prints has to match `--app-logo-ratio` in `App.css`.

**`--bmc-yellow` / `--bmc-ink` are somebody else's colours and have exactly one consumer** (D102).
The Buy Me a Coffee link is the only control in the app that does not follow the theme, because a
brand mark that changes colour with the page stops being recognisable. It does not take `.button`,
and nothing else may reference those two tokens. They still live in `tokens.css`, because that is the
only file allowed to contain a colour literal and an exception smuggled into a component is how a
palette starts to leak.

**The view switch is not a minor control** (D101). The Plan is where measuring, blocked zones, the
border and the wall photograph live, and none of them exist in 3D — so the switch sits beside `Solve
panels` at the tallest control height in the bar, and its INACTIVE half is `--text-secondary`, never
`--text-tertiary`: tertiary is the metadata colour, and a tab drawn in it reads as one you are not
allowed to press. It is raised rather than accent-filled, because `Solve panels` is accent-filled and
adjacent, and two filled controls side by side make neither of them primary.

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

**Check that a new test can FAIL before believing it.** Three in one session could not, each for a
different reason, and each read like coverage:

- asserting a mirrored mesh still measures 1000 mm³ — `measureMesh` takes the ABSOLUTE volume, so it
  passes whether the winding was flipped or not (the fix: compute a signed volume in the test);
- `expect(placed.x - cellCentre.x + meshCentre.x)` where `placed` and `cellCentre` were the same
  call — algebraically zero, so it only ever asserted `orient`'s own postcondition;
- comparing a plate's mass against a "paved" baseline after the border had been bounded in BOTH
  arms of the comparison, so neither one paved and the baseline had drifted into being the subject.

The cheap check is to break the code deliberately and watch the test go red — that is how the
winding flip, the plate placement and the hole rail were each confirmed. A fudge factor in an
assertion is the related smell, and is a defect report (see `tiling.test.ts` in the lattice traps).

`tests/critic-*.test.ts` were written by adversarial reviewers with fresh context. Some deliberately
**pin current, wrong behaviour** for findings that are still open, with a comment saying to invert
the test when fixed. If one of those starts failing, check whether you fixed the underlying defect
before "correcting" the expectation.

`Customiser/` holds the OpenSCAD parametric generator that makes panels with cells left out (for a
light switch). Its README records the lattice check against `constants.ts`; the `.scad` is the
readable copy of the supplied `.rtf`.
