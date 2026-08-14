# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser planner for a Honeycomb Storage Wall (HSW): lay accessories out on a hex grid, get back an
exact list of what to print. The geometry is **measured from the STL files in `./models/`**, not
copied from any published description. `HSW-SPEC.md` records every number with its provenance,
`DECISIONS.md` records why each call was made, `PARKED.md` records what is still open, `UNKNOWN.md`
lists what the scanner would not guess at, and `GOAL.md` holds the current objective with its
done-when checklist — read that one first if you are picking the work up mid-flight.

## Commands

```bash
npm run dev          # Vite dev server
npm test             # vitest run — 40 files, 964 tests
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

**The border ADDS material and costs NO cells** (D59, superseding D55). The customiser cuts the
outermost cells in half; the user's printed reference plate (`Customiser/borders.webp`) does the
opposite — every hexagon stays whole and open, the walls between cells run out to a straight line,
and the notches behind it fill solid. Built from ONE ring of empty positions drawn solid and clipped
to that line, so a straight run comes out flush and an L-shape follows its steps without anyone
segmenting the outline. Thickness is a millimetre field bounded by `MAX_BORDER_MM` — one ring can
only reach so far, and past that the edge comes back short without saying so.

**The top and bottom border is a RAIL of one thickness; left and right are FILLED** (D69, D84). The
wall is flat-top, so along a top/bottom edge adjacent columns stagger half a pitch: filling to the
straight outer line makes the band `t` thick above one column and `t + 11.8` above the next. Those two
sides are therefore clipped on the inside as well, and the half-cell pockets are left OPEN — every
cell stays mountable, at the cost of a rail attached at every other column, which is fine because a
cell's top FLAT is 13.6 mm of shared edge.

**Do not "fix" the sides to match by railing them too — that has been tried and it prints as a
comb.** A column of flat-top cells reaches its straight outer line at ONE POINT per cell, the
hexagon's corner, and along no edge at all, so a uniform strip there hangs off the plate at a chain
of points; measured, the left and right rails were separate solids from the honeycomb on every plate
that had them. A straight outer edge, whole cells and a constant visible width are three things a
hexagon lattice will give you two of. The band past the envelope is `t` on all four sides and that IS
the specification; on the left and right the 6.8 mm scallop behind it is solid too.

**A band ends where the PLATE does, not where its own neighbours do** (D85). The reach is right
ACROSS a band — it sets the thickness and makes an L step in where its cells do — and wrong ALONG it,
because the outermost column sits half a pitch short of its neighbour: the side band stopped `t` past
its own column's last cell while the plate carried on above it, stepping the silhouette in by up to
**30.8 mm** at two corners (chirally, so one block size hides it). A band running in Y takes its Y
limits from the plate's lines and its X limits from its reach, and vice versa. It cannot run away —
a piece is bounded by its own hexagon and the growth guard is untouched, so no new positions appear
and the inside of an L stays empty.

**A CORNER position takes NEITHER rail** (D84). It is outward on two sides at once, and given both it
keeps only where they cross: a `t × t` square touching neither run, which is how two of the four
corners of every bordered plate came off as loose blocks. Given the top/bottom rail alone it loses the
side band's last 11.8 mm instead — a notch rather than a loose piece, which no connectivity test sees.
It is solid out to both its lines, because that is what a plate's corner is.

**`meshIsClosed` does not mean one solid, and for a long time it was not.** A closed mesh can be
several closed shells; every detachment above kept it at zero unmatched edges. `honeycomb-frame.test.ts`
asserts ONE connected component of the top face, joined by shared EDGES and never by shared vertices —
a by-vertex test calls a point-contact comb attached — swept over block sizes, because every one of
these failures was parity-dependent and a single size passes by luck.

**The border is drawn in the PLATE's colour, because it is the plate** (D68). Given a tone of its
own it reads as a separate band, and a separate band has an inner edge — which is the honeycomb's
outline, stepping half a pitch between staggered columns, and looks like a jagged border. There is no
edge there: a bordered plate is one piece of plastic whose only boundary near the rim is where the
holes begin. Related and NOT a defect: a left/right edge scallops 6.8 mm (every cell in a column
shares an x) while a top/bottom edge steps 11.8 mm (adjacent columns stagger half a pitch), so the
top always looks chunkier than the sides.

**The plan DRAWS the border from `borderPolygons`, the generator's own walk** (D65). It once traced
one line per exposed cell edge — the honeycomb's zig-zag — so the picture showed a scalloped edge
while the downloaded plate had a straight one. Both have the same bounding box, so no bounds
assertion could tell them apart; what separates them is that a zig-zag border's shortfall against a
true rectangle grows with the perimeter while a flat one's is a CONSTANT (the four corner chamfers).
That is what `honeycomb-frame.test.ts` measures.

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
cut past its own cell centre prints SOLID. A cell whose CENTRE falls inside the zone keeps its sliver
on the nearest side rather than being dropped — dropped, it took its own wall with it and bit up to
10 mm out of a "straight" aperture. At a zone CORNER a cell keeps the whole side facing the zone's
edge and its arm is filled by a second SOLID piece at the same position — a cell cannot be split like
a border piece (D79) without splitting its bore, and two half-bores would grow a membrane across the
hole; taking both planes instead notches every corner of the aperture. **No zones means the eaten
cells are not drawn at all** — otherwise a frame-less plate fills its own aperture.

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
through it reported zero print time and zero filament, which looks like an answer rather than a gap.

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
- **`src/core/constants.ts`** — the measured geometry, and `LATTICE_ANCHOR`. Nothing else defines it.
- **`src/core/hex.ts`** — axial hex math (flat-top), rotation, occupancy. Every other module
  depends on its exact semantics, and none of them may re-derive it.
- **`src/core/tiling.ts`** — panel solver and seam detection, plus the bed-driven plate sizes
  (`plateFootprintMm`, `maxPlateForBed`, `generatedPlateSizes`) behind "Fit to printer".
- **`src/core/bom.ts`** — parts-list aggregation and `validate()`.
- **`src/core/store.ts`** — commands, placement rules, undo/redo.
- **`src/core/persist.ts` / `exporters.ts`** — save/load/share, CSV/markdown/print.
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
- **`src/core/measure.ts`** — measuring on the plan, snapping, and blocked zones as rectangles you
  draw. Pure millimetres; the canvas supplies points and draws answers.
- **`src/core/projectParts.ts`** — which parts this wall is built from: the basket the library fills
  and the rail shows. The only reader of `doc.library`, and the one place that knows a PLACED part
  counts whether the list names it or not (D71).
- **`src/ui/meshLibrary.ts`** — loads a part's STL, orients it to the wall, caches per part id.
  Load-bearing logic despite living in `ui/`: it decides which face goes against the wall.
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

  **Its honeycomb is a real panel STL** — the smallest shipped panel that covers the patch, through
  the same `loadPartMesh` the wall uses, aligned by putting its most central cell where the part's
  cell (0, 0) goes (D46). Drawing the cell from constants was right and still not believable to
  someone holding a printed panel up to the screen. The drawn two-layer plate (22.0 mouth over a
  20.0 throat, D45) is the fallback for when `models/` cannot be fetched. Do NOT dispose that
  geometry on rebuild: it is `meshLibrary`'s, shared with the wall view.

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
shows every part as a card with a picture, shelves and a sort; `CatalogPanel` shows only the parts
put in the project. Two surfaces because browsing and building are different jobs.

**The project's parts are on the DOCUMENT** (`LayoutDoc.library`), so they travel down a share link
and undo like every other edit. `src/core/projectParts.ts` is the ONLY module that reads that field.

**A placed part is in the project whether the list names it or not.** `projectPartIds` unions the
list with `doc.items`, and everything goes through it. Skip that and every layout saved before the
field existed opens with a wall full of hooks and an empty rail. `addItem` also adds to the list —
dropping a part straight onto the wall is a way of shopping for it, and the two paths must agree.
**Panels are excluded from the rail**: the tiler picks those, so "Solve panels" must not fill the
basket with plates nobody chose. **An unresolvable id is kept and counted, never dropped** — a
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

Three modal tools in `WallCanvas`, switched by the toolbar or by `V` / `M` / `B`, with Escape always
returning to Select. Modal rather than modifier-based because two of the three are drags on empty
wall, and a marquee, a measurement and a new zone cannot all be that at once.

- **Measure** — drag between two points, with snapping (`shift` turns it off). The readout is drawn
  on the canvas AND rendered into the DOM, because a number painted into a canvas cannot be read by a
  screen reader, selected, or copied — and it is the one number a person wants to write down.
- **Blocked zone** — drag a rectangle the honeycomb must keep out of. It is an `Obstacle`; there is no
  second path, so `store.setObstacles` re-cuts the panels exactly as before. Drawing one returns to
  Select so it can be nudged straight away.
- **Select** — as before, plus moving and resizing zones by their handles. Zone hit-testing comes
  first and cannot steal a click from a part: a zone's cells are cut, so nothing can be placed there.

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

### Two views

`WallView3D.tsx` (default) and `WallCanvas.tsx` (2D plan) drive the same store, so they cannot
drift. A CUT plate is drawn in 3D from the **generator** — the same triangles the download writes —
rather than from the drawn approximation, which knows about cells and holes but not about a framed
edge and left a column of hexagons simply missing along every frame. What you see is what you print. Both read their colours from the token layer via `getComputedStyle` and both need a
`MutationObserver` on `data-theme` to repaint — a theme switch changes no React state.

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
