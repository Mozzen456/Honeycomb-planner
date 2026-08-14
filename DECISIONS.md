# DECISIONS

Every question I would have asked, answered here with the reasoning. Newest section last.

---

## D1. Units are millimetres — proven, not assumed

STL carries no units, so I proved it rather than assuming.

Files whose names contain `M3`, `M4`, `M5` contain circular bores of **3.19 / 4.19 / 5.09 mm**
(least-squares circle fits, max residual < 0.006 mm). Those are exactly the standard metric
*clearance* sizes: nominal + 0.2 mm. Each also carries a 0.3 mm-deep entry chamfer widening the
bore by exactly 0.3 mm (3.49 / 4.49 / 5.39).

A part named "M4" with a 4.19 mm hole is millimetres. At 25.4× it would be a 106 mm hole in a
46 mm part, which is impossible. Confirmed independently: panel depth is exactly 8.00, and the
smallest panel is 88.6 × 106.2 — a plausible printed plate in mm, absurd in inches or metres.

**Decision:** all geometry is millimetres, no scale factor applied anywhere.

---

## D2. Curved features are fitted, never read off vertices

Screw holes in these meshes are 50–146-sided polygons. The distance between two opposite facet
vertices understates the true diameter by up to 2%, which is the difference between an M3
clearance hole and an M3 tapping hole.

**Decision:** every diameter in the spec and catalogue comes from a Kasa least-squares circle fit,
and I record three numbers: the fit diameter (the CAD nominal), the *inscribed* diameter (what a
bolt actually passes through), and the max residual. Flat features — hexagon corners, panel edges,
z-steps — are taken straight from triangle corners and are exact.

---

## D3. Cell pitch comes from a whole-panel lattice fit, not one hexagon × N

Measuring one hexagon and multiplying accumulates error. Instead every hexagonal hole in a panel
is recovered from a cross-section, and one lattice `centre_i = origin + q_i·a + r_i·b` is fitted to
all of them simultaneously by least squares over integer indices.

Result across all seven panels (56 to 288 cells each): **max residual 1.8 × 10⁻⁴ mm**, which is
float32 storage noise. The lattice is exact.

---

## D4. The row step is 20.438, *not* 23.6·√3/2

This one matters and it is the trap the brief warned about.

Assuming a mathematically regular lattice gives row step = 23.6·√3/2 = **20.43820**. Fitting the
constant from the panel outlines instead gives **20.438000** (least-squares over 7 panels, delta
−3 × 10⁻⁷). The designer typed a 5-decimal rounding.

The difference is 0.0002 mm per row — invisible on one cell, but the 18-column panel is 17 steps
wide, so assuming √3/2 makes it 0.0034 mm too big, and a wall of several panels drifts further.
The consequence of getting this wrong is exactly "panels that do not line up".

Because the row step is rounded but the hexagons themselves are regular, the lattice is very
slightly non-equilateral: horizontal neighbours are 23.60000 mm apart, diagonal neighbours
√(11.8² + 20.438²) = **23.59983 mm**. The measured |b| was 23.59983–23.59984. Confirms it.

**Decision:** the app uses P = 23.6 and ROW = 20.438 as exact constants. It never computes
ROW from √3.

---

## D5. Shipped panels use measured sizes; only hypothetical panels use the formula

The closed-form panel size (see HSW-SPEC §4) reproduces every shipped panel to within
2.1 × 10⁻⁴ mm, but not to float32-exact, because the outline margin (P/√3 = 13.6254664) and the
typed row step are not perfectly consistent with each other in the source CAD.

0.0002 mm is 0.2 µm: ~6× finer than a printer can position and ~250× finer than first-layer squish.
It cannot cause a fit problem. But there is no reason to carry avoidable error.

**Decision:** for the seven panels that exist in `./models/`, the app uses the **measured bounding
box** verbatim. The formula is used only to describe panel sizes that are not in the folder. This
makes drift structurally impossible for anything the user will actually print.

---

## D6. Panel outlines are interlocking, not rectangular

Every panel's exterior is a 116–268 vertex zig-zag, not a rectangle: it is the boundary of the
*union of hexagonal unit cells*. Bottom-edge vertices land on exact multiples of 23.6; left-edge
flats are 13.6255 mm long and repeat every 40.876 mm (= 2 × 20.438).

This means panels do not butt like tiles — they **mesh**. The consequence for the planner is that a
panel's position is constrained to lattice positions, and the seam between two panels is a zig-zag
line through the grid rather than a straight cut. Seam-crossing detection has to be done in cell
space, not by comparing pixel rectangles.

---

## D7. Assembly direction of the insert — stated with its evidence

The panel bore, from the printed-bottom face: 0.5 mm lead-in flaring to 20.8 → **20.0 mm throat for
4.6 mm** → 48° chamfer → **22.0 mm mouth for 2.0 mm**.

The standard insert is 10 mm tall: 22.5 mm hexagonal flange 2.5 mm thick, then a 19.7 mm body, then
snap barbs bulging to **20.735 mm** at 5.7–6.1 mm below the flange, then a lead-in taper to the tip.

Those barbs are wider than the 20.0 throat and land exactly where the bore opens out to 21.3–22.0.
That is a snap fit, and it only works one way round: **the insert enters from the throat side, and
its flange bears on that face.** Pushed in from the mouth side the barbs would still be inside the
throat at full depth and could never release.

The flange (22.5 across flats) is larger than the 22.0 mouth, so it always sits proud of the face
rather than recessing — consistent with the flange being the visible, room-side feature.

**Decision:** the planner treats one panel face as the mounting face and the other as the accessory
face, and reports insert counts per cell. It does **not** assert which physical side faces the room,
because that is an assembly instruction, not a geometric constraint, and nothing in the BOM depends
on it. See UNKNOWN.md for the residual uncertainty.

---

## D8. Community sanity-check numbers: two agree, two do not

Used as a check, never as a source. Where they disagree, the files win.

| Community figure | Measured | Verdict |
|---|---|---|
| 20 mm hexagons | 20.000 mm across flats at the throat | **agrees exactly** |
| base panel ~170 × 177 mm | `wall-honeycomb-part.stl` = 177.000 × 170.317 | **agrees exactly** |
| that panel has 28 cells | **56 cells** (7 columns × 8 rows), counted from 56 recovered hexagons and confirmed by C×R | **disagrees — files win** |
| ~42.58 mm across a two-hexagon span | two-cell spans measured are 46.418 mm (diagonal) and 46.100 mm (axial); no feature in any file measures 42.58 | **disagrees — files win** |

On the 28 vs 56: I recovered 56 hexagonal interiors from the cross-section, and independently
7 × 8 = 56 from the size formula. Both agree. 28 is exactly half of 56, so the community figure is
plausibly a count of cells per *face* or a typo for a half panel, but I am not going to guess —
recorded and moved on.

On 42.58: nothing measures it. 2 × 20.438 = 40.876 and 20.438 + 22.0 = 42.438 are the nearest
things in the geometry, neither convincing. Recorded in UNKNOWN.md.

---

## D9. Tech stack

Vite + React + TypeScript, Canvas 2D for the wall, Vitest for tests, zero runtime dependencies
beyond React.

- **Canvas over SVG:** a 2400 × 1200 wall is ~5,900 cells. As SVG that is 5,900 DOM nodes fighting
  the compositor on every drag frame. Canvas redraws it in one pass and makes hit-testing an
  arithmetic problem rather than a DOM query.
- **No UI framework / component library:** the brief asks explicitly for no stock-template look. A
  component library is a stock-template look with extra steps.
- **No state library:** undo/redo wants an explicit command log over an immutable document. That is
  ~80 lines written directly and is clearer than bending a store to it.

---

## D10. Print estimates come from a real slicer

No slicer was on PATH, but **Bambu Studio is installed** and ships a CLI. PrusaSlicer and
OrcaSlicer were absent.

**Decision:** print time and filament mass are produced by slicing each STL headless with Bambu
Studio's CLI at a recorded profile (0.20 mm layer, 15% grid infill, 2 walls, PLA at 1.24 g/cm³).
The exact profile is stamped into `catalog.json` so the numbers are reproducible and so a future
re-slice at a different profile is visibly a different profile rather than silently inconsistent.

Where the slicer fails on a mesh, the entry is marked `estimate: "volume"` and falls back to
mesh volume × density × a fitted solidity factor — never silently mixed with sliced numbers.

**Correction:** PrusaSlicer *was* installed, at `C:\Program Files\Prusa3D\PrusaSlicer\`. My first
probe missed it because it checked `PATH` and scanned for directories matching `slic|orca|bambu`,
and "Prusa3D" matches none of those. All 51 parts are sliced with **PrusaSlicer 2.9.6**, which is
what the brief asked for. Bambu Studio was not used.

The estimation bed is deliberately 400 × 400. Bed size does not affect time or filament — it only
decides whether the slicer refuses the job — and a 250 × 210 bed made the three largest panels
fail with "all objects are outside the print volume" and silently lose their estimates. Whether a
part fits the *user's* printer is a separate question, answered per part by `panel.fitsBeds`.

---

## D11. The screw belongs to the insert, not to the panel

Found by looking at the running app: 350 countersunk inserts, **700 wall screws**.

Panels carried `requires: [insert-countersunk × n]` *and* `hardware: [wall screw × n, wall plug ×
n]`, while the insert itself also carried its own screw and plug. The BOM expands hardware through
`requires`, so every fixing was counted twice.

**Decision:** the fixing belongs to the part it passes through. A panel requires inserts; the
insert requires a screw and a plug. The panel lists no fixings of its own — *unless* no countersunk
insert exists in the catalogue, in which case the panel carries them, because otherwise they would
go unlisted entirely. Guarding against the undercount matters as much as fixing the overcount.

---

## D12. Bolt sizes come from the narrowest section of each bore

Every countersunk wall fastener was claiming an M5 bolt it does not take.

A countersink is a cone, so it presents a different diameter in every slice, and its mid-cone
sections land squarely inside the M4 and M5 tolerance windows. A second bug rode along: rounding
each bore's fitted centre to 0.1 mm to group them split one cone across a boundary into two holes,
so a one-cell wall insert asked for two wall screws.

**Decision:** bores are clustered by centre *distance* (not by rounding), and each hole is sized by
its **narrowest** section — the shank hole, the only diameter a screw actually has to pass. A hole
whose diameter varies by more than 0.5 mm is reported as a countersink rather than as a bolt hole.
`insert-countersunk-with-m3x3` now reports 3 × M3, which independently matches the `m3x3` in its
filename.

---

## D13. Pointer Events only — the native HTML5 drag is actively suppressed

The catalogue tiles were both `draggable` (HTML5) and wired to `pointerdown`. On a mouse the
browser promoted the gesture to a native drag part-way through the move, which swallows every
subsequent `pointermove`/`pointerup`. The drop never arrived and the page sat in a modal drag loop
that was indistinguishable from a hang.

**Decision:** the gesture is Pointer Events only — they already cover mouse, pen and touch — and
`dragstart` is cancelled so the native drag can never begin.

## D14. The live drag is held in a ref, not in state

`drag` state is only visible after a render, and a pointer can move *and release* before that
render commits. The first move after grabbing was being dropped, and a fast enough gesture lost its
drop entirely.

**Decision:** the drag is written synchronously to a ref that the window handlers read; the state
copy exists only to drive rendering. The window listeners are attached once for the component's
lifetime and read the latest callbacks from a ref, so re-subscribing can never race an in-flight
gesture.

---

## D15. Canvas: a cached static layer, and one draw call per style

A garage wall is ~5,800 cells. The first renderer filled and stroked each hexagon individually and
rebuilt the seam set inside the draw loop — roughly 36,000 iterations and 12,000 draw calls per
frame, on every pointer move.

**Decision:** seams are indexed once per panel change; the panel grid and seams are rendered into
an offscreen canvas keyed on (size, view, panels, theme colours) and blitted; everything else is
batched into one `Path2D` per style. `canvas.width` is only reassigned when it actually changes,
since assigning it reallocates the backing store. Measured: **40 complete drag gestures in 9 ms**.

**A correction worth recording:** I first diagnosed a "freeze" during drags and attributed it to
this cost. It was not. The stalls were Chrome throttling `setTimeout` to ~1 s in a backgrounded
tab, which was inflating my *measurement harness*, not the app. The optimisation is still right —
the per-frame cost was real — but the freeze I was chasing was an artefact of how I was measuring.
Recorded because the wrong diagnosis was convincing for a while.

## D16. The canvas must be told when the theme changes

Switching to dark left dark chrome around a stubbornly light wall. The canvas reads its colours
from the token layer via `getComputedStyle`, but a theme switch changes no React state, so nothing
in the draw effect's dependencies moved.

**Decision:** the canvas watches `data-theme` with a `MutationObserver` and the OS preference with
`matchMedia`, and bumps a counter to force a repaint. This also covers the system flipping theme
while the app is open.

## D18. Overlap is allowed — I had the model of the system wrong

The first build refused any two items that shared a cell, and called it the
whole value of the app. That was wrong, and it was wrong about the physical
system rather than about the code.

HSW is a wall you mount things **on**. An accessory bolts to an insert and
stands proud of the panel; two accessories sharing a cell in plan view are at
different depths and do not fight. Refusing that placement blocks the normal
way the system is used.

**Decision:** exclusivity applies only to parts that go *into* a hole — those
whose catalogue `type` is `insert` or `fastener`. Two of those in one cell is
still a hard refusal ("one insert per hole"), because there is one hole.
Everything else may overlap freely.

And it does so **silently**. My first pass warned on every overlap; with 26
parts placed the parts list filled with advisories for a layout that was
completely fine, which is how a warning system trains people to ignore it. The
BOM likewise only reports the insert-in-insert case, at `error`; ordinary
overlap produces no issue at all.

---

## D21. "Why is it so thick" — three separate causes, none of them the panel

Worth writing down because my first two guesses were both wrong, and the real
answer was only findable by measuring.

**1. The plate was built as N independent hexagonal rings.** One `ExtrudeGeometry`
per cell, each an outer 23.6 hexagon with a 22.0 hole. Adjacent rings share
their outer edge exactly — which means every cell boundary carried *two
coincident 8 mm-tall side walls*, inside solid material, that have no business
existing. Rendered at an angle those read as thick dark borders and the plate
looked like a tray of hexagonal cups. That is what "thick" was.

Now it is one shape per panel: the union outline, with one hole per cell. The
only vertical faces left are the panel silhouette and the bores.

**Tracing that outline had two bugs of its own**, both found by checking the
polygon's area against `cells × cellArea` rather than by looking at it:

- Boundary edges were stored in a map keyed by start vertex, one entry each. On
  a castellated edge two boundary edges can leave the *same* vertex, so one was
  overwritten — 58 edges chained into 41 points and an outline 7 % short. Fixed
  by keeping a list per vertex and, where there is a choice, taking the tightest
  clockwise turn from the reversed incoming direction, which is the rule that
  keeps the interior on the left.
- Adjacent cells do not compute a shared corner to the same float. ROW_STEP is
  the typed 20.438, not the 20.43829 that makes hexagons tile exactly (D4), so
  the two copies land 0.0003 mm apart and could straddle a rounding boundary.
  Vertices are now snapped to a 0.25 mm grid before matching — real corners are
  at least 6.8 mm apart, so nothing legitimate can collide.

**2. Parts were extruded by `max(bbox)`,** which is the wrong axis for nearly
everything in this set. A 10 mm insert stood 26 mm off the wall; `wranch-hoks`
would have been drawn as a **200 mm column** instead of the 13.29 mm bar it is.
The scanner now measures `projectionMm` from the part's mating axis where one
was detected (17 of 44 parts), and otherwise from the face with the most
material against the wall. Recorded with its basis, so a guess is visible as a
guess.

**3. The rib and the shoulder were the same tone.** Face-on, a real panel shows
a 1.6 mm rib and then, 2 mm back, a 1 mm shoulder each side down to the 20.0
throat. Both read as "wall" unless the recessed one is visibly recessed, so the
plate looked like a 3.6 mm wall — twice what it looks like in the hand. The
front face is now lit brightly against a darker body, which is what the real
part does. The geometry did not change; only whether the eye can tell the two
apart.

The bore is now modelled properly as well: a 6 mm body at the 20 mm throat and a
2 mm front face at the 22 mm mouth, which is the measured stepped profile from
HSW-SPEC §3 rather than a straight hole.

---

## D20. The same double-count bug, twice — so the guard is now general

D11 fixed a wall-screw double count: a panel and the insert it required both contributed the
fixing, so 350 inserts asked for 700 screws. I added a regression test — and scoped it to the wall
screw.

The moment three-axis bore detection gave eight accessories their missing requirements, the *same
class* walked straight back in one level down: `screw-holder` and the `insert-with-m3` it requires
both emitted the identical shopping line `"M3 bolt, 10-16 mm"`. **One M3 hole, two M3 bolts.** Six
parts were affected. The specific guard did not see it because it was watching one string.

**Decision:** an accessory that successfully requires an insert lists no fixing of its own — the
insert already carries the one that passes through the joint. If that insert is absent from the
catalogue the accessory keeps the bolt, so the fix cannot turn an overcount into an undercount.

And the regression test is now **general**: no part may claim a fixing that anything it requires
also claims, for any thread size, anywhere in the catalogue. A guard written against one instance
of a class only catches that instance; this one catches the class.

Cost of the change: the catalogue records thread and length but not head style, so the countersunk
hooks no longer say "countersunk screw" — they inherit the insert's generic bolt line. Inventing a
second line item to express head shape would have doubled the count again, which is the exact
mistake being fixed. Noted in HSW-SPEC rather than papered over.

---

## D19. Three dimensions, because depth is the question the plan cannot answer

A flat plan tells you which cells are used. Standing at the wall, the question
is *how far does this stick out, and does it foul its neighbour* — which a plan
cannot show, and which matters more now that parts are allowed to overlap.

**Decision:** the 3D view is the default; the 2D plan stays one click away
because it is faster to aim precisely in. Both drive the same document — hex
coordinates in, the same `store` commands out — so neither can drift from the
other.

Implementation notes worth keeping:

- **One extruded geometry per distinct panel size, drawn as an `InstancedMesh`.**
  The plate is built as one `ExtrudeGeometry` over per-cell hexagonal rings, so
  a 64-panel garage wall is two draw calls rather than 5,800 meshes. The plate's
  zig-zag boundary comes out correct for free, because the outer hexagons *are*
  the lattice's unit cells and neighbours share edges exactly.
- **Parts are drawn at their measured depth** from `bboxMm`, one block per
  occupied cell rather than one box over the bounding area — so a multi-cell
  part stays honest about which cells it actually uses.
- **Colours are read from the token layer**, not hardcoded, so the 3D view
  follows the theme. That needed a fix: the tokens resolve to
  `rgb(15  97 147)` — doubled whitespace, from `rgb(var(--accent-rgb))` over a
  space-separated triple — which three.js's colour parser rejects *silently*,
  leaving every material white. Every accent part came out the same grey as the
  plate. The string is now normalised through a canvas 2D context first, which
  makes it immune to whatever colour syntax the tokens use next.
- **Lighting is deliberately mid-range.** Too bright and a Lambert surface
  washes to white so the parts stop reading against the plate; too dim and the
  dark theme's plate — only two ramp steps above the void — vanishes entirely.
- The 3D scene needs the same `MutationObserver` on `data-theme` that D16 added
  to the 2D canvas, for the same reason.

---

## D17. Visual hierarchy on the wall

Two things read wrong once there was something to look at:

- **The panel plate was never drawn.** Cells were painted straight onto the wall colour, so panels
  read as a flat wireframe with nothing behind them. Now the full-size hexagon footprint is filled
  with the panel tint and the inset opening on top, so depth reads inward: wall (void) → plate →
  cell.
- **The seams were the loudest thing on the wall** — heavier than the parts the user had placed,
  which inverts the hierarchy. A seam is reference information; it has to be findable, not loud.
  Weight and alpha both reduced.

---

## D22. Importing an STL in the browser — a second measurer, held to the first

The brief asks for new models to be usable without a round trip through Python. That means a
second implementation of the thing this project is most careful about, which is a real risk: two
measurers that disagree turn one catalogue into two.

So it is written as a port with a test that pins it. `tools/footprint.py` reaches its answer with
trimesh cross-sections and shapely booleans; `src/core/detect.ts` reaches it with a raster,
because a browser has neither library. Every question the Python detector asks a polygon — is
this cell filled, is that hole hexagonal, how much of the probe is covered — is a question about
*area*, and a raster answers area without a boolean-geometry library.

**`tests/detect.test.ts` runs the browser detector over all 51 shipped models and requires it to
reproduce the scanner's footprint cell for cell.** It does: 51/51, including the six chiral panels
where a mirrored answer would be silently wrong, and the 4-cell diamond inserts whose filenames do
not describe their shape. Tier and `needsReview` match too.

Two details carried over deliberately:

- **The bounding-box gate is the sharp test**, not area overlap. A plain rectangle is ~70%
  coverable by hexagons, so area scoring calls a storage box a 3-cell wall part; the gate rejects
  it because the box does not decompose onto the lattice.
- **The axis permutations are cyclic.** A cyclic permutation is a rotation; an acyclic one is a
  reflection, which would mirror the footprint — the same class of error as the stagger parity in
  D4's neighbourhood.

---

## D23. An imported part's print estimate is modelled, and says so

There is no slicer in a browser. The honest options were to leave the numbers blank or to model
them and mark them, and blank numbers make a parts list useless for the thing it is for — deciding
whether you can print this tonight.

Volume × density is not good enough: these parts are mostly perimeter, and that model is wrong by
up to **109%** on this very model set. So the estimate is shell-plus-infill.

**The first version of this was fitted on the 51 shipped parts alone, and that was a mistake** —
see D28, which is the correction. It now fits 73 slices spanning solids as well as shells, and
charges shell and infill different rates because perimeters print at 45 mm/s and infill at 80.

| | HSW parts | held out of the fit |
|---|---|---|
| grams | RMS **7.0%**, worst 20.6% | RMS 11.3%, worst 19.2% |
| minutes | RMS **13.2%**, worst 30.9% | RMS 26.3%, worst 46.9% |

Those bounds are asserted in `tests/stl.test.ts` rather than described, so loosening them has to
be a deliberate act. Every part built this way carries `print.source: 'volume'`, and the catalogue
tile, the parts list, the CSV, the Markdown checklist and the printable sheet all mark it.

---

## D24. The import dialog is where a measurement problem becomes an authoring one

PARKED P1 said it: geometry can measure how wide a shelf is, but it cannot say which cells its
installer will put its inserts in, because **that is a choice, not a feature**. 29 of 51 shipped
parts are in that position.

The dialog is the answer P1 proposed, built: it shows every measured number, says plainly which
of them are bounds, and gives the two controls that geometry cannot supply — draw the footprint,
and name the insert it bolts to.

One rule keeps it honest: **accepting the proposed footprint is not the same as confirming it.**
Only an actual edit clears `needsReview`. Pressing Add on a bounded part leaves it flagged, so a
bound is never silently promoted to a measurement by a click.

---

## D25. Imported parts live beside the generated catalogue, never inside it

`src/catalog/catalog.json` is generated and read-only — hand-editing it is the one thing CLAUDE.md
says never to do, because the next `--rescan` would erase the edit.

So imported parts are a separate list that is merged at read time, and their ids carry a `user/`
prefix, which makes a collision with a generated part structurally impossible rather than a case
to resolve. Metadata goes in localStorage (small, synchronous, wanted before first render); the
STL bytes go in IndexedDB (megabytes). Losing the bytes costs the 3D mesh and nothing else, so a
browser that refuses IndexedDB still gets a working part.

The merge is memoised on identity, because `bom.ts` caches its part index in a `WeakMap` keyed on
the `Catalog` object. A fresh merge per render would rebuild that index per render.

---

## D26. The 3D view draws the real mesh, not a box the size of the box

Every accessory used to be an extruded bounding box. That answers "does it fit", which is what the
plan view is for, and not the question the 3D view exists to answer: what will this look like on
my wall, and does this hook foul the one beside it. A 20-slot SD-card holder and a coat hook were
the same grey cuboid.

Each placed part is now drawn from its own STL — lazily, cached per part id, one fetch per
distinct part, with the box kept as the placeholder until it arrives and as the permanent fallback
when it cannot be fetched.

Orientation is not guesswork: the detector already knows which axis faces the wall, which end of
that axis it is, and whether the part is drawn flat-top and so must be spun 90° to sit on a
pointy-top wall. `meshLibrary.ts` re-runs `detect()` rather than inventing a second orientation
rule — one rule, one place, and the mesh cannot end up disagreeing with the footprint.

Turning a part over is a 180° rotation about an in-plane axis, **not** a negation of the wall
normal on its own. Negating one axis is a reflection, and a mirrored hook is a left-hand hook on a
right-hand wall: wrong in a way that looks fine.

---

## D27. Two interaction defects that only a real browser shows

Both were invisible to the test suite and obvious within a minute of using the app.

**The 3D toolbar was dead to a mouse.** `Fit` and `Front` sit inside the canvas host so they can
float over the wall, so their `pointerdown` bubbles to the host's handler, which called
`setPointerCapture`. Capture redirects every later pointer event to the host, and the button never
received its click — while working perfectly when called from code, which is why nothing caught
it. The handler now ignores events originating inside `.wall3d__tools`.

**The whole app scrolled its own chrome away.** The shell is `100dvh` with `overflow: hidden`, yet
`documentElement.scrollHeight` measured 3326 against a 900px window: the catalogue's tall tile list
propagated its overflow past its own `overflow-y: auto` and into the viewport's scrolling area.
Clicking or tabbing to a tile scrolled the page and took the top bar off screen, with no scrollbar
to bring it back. `contain: layout paint` on the two scrolling panels fixes it — `layout paint`
rather than `strict`, because `strict` implies `size` and would make the grid track report zero
height.


---

## D28. The estimator had memorised the model set, and only a slicer could show it

PrusaSlicer became available on the machine after the import feature was built, which made two
checks possible that had not been.

**First: the committed catalogue reproduces.** All 51 parts re-sliced from scratch against the
committed profile hash on macOS — filament mass identical on every one, print time within 0.05 %,
length within 0.11 %. The catalogue was generated on Windows, so that is a cross-platform
reproduction, and the mass column does not move at all. HSW-SPEC §7 now records it.

**Second, and the reason this decision exists: the in-browser estimator was overfitted, and its
own test suite could not see it.** D23 reported RMS 15 % on print time and it was true — against
the 51 shipped parts, every one of which is a hook, a clip or a perforated plate. Sliced against
geometry that is not in that family:

| shape | real | estimated |
|---|---|---|
| solid cube, 25 mm | 30.2 min | 47.8 min (**+58 %**) |
| sphere, r15 | 27.4 min | 42.2 min (**+54 %**) |
| flat plate, 60 × 2 × 80 | 55.4 min | 88.3 min (**+59 %**) |

The cause is straightforward once seen: the model charged one blended rate per mm³ of filament,
and every part it learned from was almost pure perimeter. It had no example of infill to learn
that infill prints nearly twice as fast. Someone importing a chunky bin would have been told an
hour of print time that did not exist.

Fixing it meant fixing the *fit set*, not the formula: 22 generated shapes spanning solid blocks,
thin shells, flat plates, tall posts, cylinders and tubes, plus four shapes held out entirely.
Refitting on the union improved every family at once — HSW time RMS 15 % → **13.2 %**, worst
42 % → **31 %**, and held-out worst 59.5 % → **46.9 %**.

Two things did *not* work and are recorded so they are not retried blindly:

- fitting the shell/infill split on the 51 HSW parts alone made it **worse** (RMS 15.0 % → 17.9 %),
  because with no infill in the data the second coefficient has nothing to identify it;
- adding a fourth term for average cross-section perimeter — an attempt to distinguish long fast
  lines from small fiddly ones — did not help either family. The remaining error on a flat plate
  (+47 %) is real and unexplained by anything cheap to compute from a mesh.

The lasting change is not the constants, it is `tests/fixtures/estimator-calibration.json`: 27
shapes with their real slicer results, checked by `tests/stl.test.ts` **without needing a slicer**.
Fitting and testing on one family proves only that you memorised that family, and now the suite
cannot make that mistake quietly again. `tools/calibrate_estimator.py` regenerates the whole thing.


---

## D29. Wall fixings belong to the wall; insert counts belong to the peg

Two fastener defects, opposite in sign, both from the same habit: deriving a count from something
that was never a count.

**Wall fixings were per panel.** `requires: insert-countersunk × (4 + cells/50)` on every panel
part, multiplied by the number of plates, is 370 wall screws on a 2400 × 1200 wall — **one every
88 mm**. The panels interlock along a zig-zag edge and multi-cell inserts bridge the seams (§4), so
a tiled wall behaves as one sheet and takes fixings at a spacing. `src/core/fixings.ts` plans them
across the assembly: a grid at ~220 mm, plus a floor of one per panel, routed around cells that
accessories have taken. That gives 74 on the same wall — 26/m², against the 20/m² of the one real
HSW design I could find, and the two rules (grid, one-per-panel) land within two of each other,
which is the reason to believe either.

**Insert counts came from the cell bound.** Where the scanner found no bolt bore it fell back to
`insert-empty × cells` — `cells` being the bounding-box bound PARKED P1 explicitly calls not a
measurement — or emitted nothing at all. So a 7-cell shelf with two pegs ordered seven inserts, and
ten accessories, including two 200 mm wrench racks, ordered none.

The fix is to measure the thing that decides the count. A second-tier part mounts through hexagonal
pegs (§5); `detect.mountPoints()` counts them as separate lumps of material on the wall face, at
lattice spacings, stable across several depths, scanning in from **both** ends because the mating
end of a tier-3 part is a guess by construction. Every shelf boss measures 15.6 mm across corners —
the 13.4 mm socket — which is the cross-check that the thing being counted is the right thing.

Three rules came out of it, and they are the durable part:

1. **A fastener count never comes from the cell bound.** It is measured, or it is unknown.
2. **Unknown is a valid answer and must be visible** — `fastenersNeedReview` reaches the parts list,
   the CSV, the checklist and the printed sheet.
3. **But unknown is not zero.** A second-tier part hangs on the wall through an insert, so the floor
   is one. Under-ordering stops a build; over-ordering costs a 2 g print.

Corrections go in `src/catalog/overrides.json`, which is the documented channel — and which the app
now reads as well as the scanner, so a correction no longer needs Python and a slicer to take
effect.

---

## D30. Obstacles make a panel that is not a panel any more

A light switch cannot be worked around by moving parts; the plate itself has to change. So an
obstacle is a rectangle in wall millimetres, `obstructedCells` turns it into cells, and every panel
it lands in gets an `omit` list.

The moment a panel has `omit` it is **no longer the shipped STL**, and the parts list has to say so
or you print fifty copies of a file and find four of them do not fit. Custom panels are counted
separately, with a print estimate scaled by the fraction of cells that survive and marked estimated
like every other modelled figure.

They are generated by the OpenSCAD customiser in `Customiser/`, which — checked, not assumed — is on
this lattice: 23.6 pitch, 20.4382 column step, 13.625466 hexagon side, 8 deep. The one difference is
that it computes the column step in closed form where the shipped panels use the typed 20.438: D4's
0.0002 mm, 0.0024 mm across a 13-column panel. Noted, not adopted.

The conversion is the dangerous part. The customiser is flat-top and the wall is pointy-top, so it
is a 90° turn plus a stagger parity, and a parity error produces a **mirror image** that is invisible
until the plate is printed and the holes are on the wrong side of the switch. `tests/customiser.test.ts`
therefore asserts nothing by hand: it converts a panel to parameters, expands them back with the
customiser's own loop, and requires the identical cell set — every block shape, both parities, seven
lattice positions. The first derivation failed it, which is the whole reason it is written that way.

`omit` also forces one discipline on the rest of the app: **every derivation of a panel's cells goes
through `placedPanelCells`**, never `panelCells` on the raw origin/columns/rows. The two modules
most likely to forget are the ones deciding where fixings go and whether an accessory is off-panel,
and both would fail silently.

---

## D31. The wall hangs flat-top — measured, and the app still draws it pointy-top

**The question.** PARKED P9 left this open: the app draws the wall pointy-top, every photograph of
a mounted part looks flat-top, and 30° is not a multiple of 60°, so no rotation of a part
reconciles them. `FITTING_SEAT_RADIANS` in `WallView3D.tsx` turns fittings by 30° to hide it.

**The evidence, three independent lines, all agreeing.** Recorded with provenance in HSW-SPEC §10.

1. **The designer's own dimensioned drawings** (in `152592-honeycomb-storage-wall-*.pdf`, the
   Printables listing for RostaP's model 152592, read 2026-08-13). Both the base-panel drawing and
   the insert-family drawing present the lattice flat-top: the panel is `170.32` across by `177`
   down — the 20.438 step horizontal, the 23.6 pitch vertical — and the insert's `25.98` across
   corners is horizontal while its `22.5` across flats is vertical.
2. **The meshes, which are the authority.** A shelf's tray floor is horizontal in use, so a shelf
   fixes "up" without appeal to any photograph. On all four shelves the tray floor is perpendicular
   to Z, the hexagonal peg runs along Y into the wall, and the peg's six side normals fall at 0°,
   ±60°, ±120°, 180° from +Z — a face normal pointing straight up, which is a flat edge on top.
   `hook-to-empty`, `hook-to-empty-long` and `box-without-screw` share that frame.
3. **The photographs** already noted in P9 — mounted parts read flat-top.

**Decision: the wall hangs flat-top, and this is recorded as a fact about the product.** It costs
nothing in the BOM: the lattice, adjacency, footprints and tiling are identical under a 90° turn of
the viewing frame, so no number in HSW-SPEC changes and no test moves.

**What is deliberately NOT done here.** The app's renderers are left pointy-top for now, and
`FITTING_SEAT_RADIANS` stays. Turning the frame is a real change — `hexToMm`, `panelCells`, the
tiler, `panel-parity.test.ts`, the customiser round-trip and both renderers — and the parity test
exists precisely because a stagger error there is a mirrored plate that is invisible until it is
printed. That is worth doing deliberately, not as a side effect of settling the evidence. It is
carried in PARKED P9 as the one remaining action, now with the answer attached rather than the
question.

**What changes immediately:** nothing in code. The 30° seat is no longer an unexplained fudge —
it is a known 90° frame difference, documented, with the measurement that proves the direction.

---

## D32 — Enter on a catalogue tile places the part; it does not start a drag

**Found by testing the keyboard path, which had no test and did not work.**

The tile's tooltip said "drag onto the wall, or press Enter". Enter synthesised a real `pointerdown`
on the tile — tidy, because the parent then received a fully-formed event it could measure instead
of a keyboard event wearing a pointer event's type. But a drag ends on `pointerup` over the wall,
there is no Enter-to-drop, and the arrow keys move the *selection*, not a pending drag. So Enter
started a gesture a keyboard could never finish: a ghost that only Escape could clear.

**Decision: `onActivate` is a separate prop from `onDragStart`, and it places the part outright.**
Blurring the two is what caused this — "start a drag" and "place a part" are different intentions,
and one event type cannot carry both.

The part lands on the first cell it actually fits, scanned in reading order, and arrives *selected*,
which hands the rest to keys that already exist: arrows move it, `R` rotates, Delete removes. That
is a shorter road than a parallel keyboard-drag cursor, and it adds no new vocabulary.

The search is `Store.firstFittingCell`, in core rather than in the shell, so it is tested without a
browser and reuses `addItem`'s own gate — `partCells` + `exclusiveCellsOf` + `checkPlacement`. The
keyboard and the pointer therefore cannot come to different views about which cells are legal. It is
reading order and not nearest-to-centre because it has to be deterministic: the same part on the same
wall must always land in the same place, or undo/redo stops being a round trip.

## D33 — The seat correction belongs to meshes that came out of a file, and to nothing else

**Found while auditing part orientation against the drawings.**

`FITTING_SEAT_RADIANS` (30°) compensates the orientation an STL was *drawn* in. `Insert-countersunk`'s
flange vertices sit at 0°/60°/…/300° in the file — flat-top, as its `drawnOrientation` says — while a
pointy-top cell's corners are at 30°/90°/…, so the real mesh needs exactly that 30° and gets it.

Geometry the view builds for itself does not. `CylinderGeometry(…, 6).rotateX(90°)` already puts its
vertices at 30°/90°/…/330° — precisely the cell's corners. Two of the four places that draw a fitting
turned that placeholder by another 30° anyway, laying it *across* the cell walls: the exact failure
the constant exists to prevent. The placed-item path had always guarded it with `loaded &&`; the wall
fixing and junction paths had not, and the collar needed no guard because it was never given one.

**Decision: the seat is applied only when the real mesh is present** — `fixingMesh ? … : 0`.

Pinned in `tests/fitting-seat.test.ts` as arithmetic, not as a screenshot. A hexagon looks like a
hexagon at any angle; this is only wrong *relative to the cell under it*, which is why it survived
in plain sight and why the eye is the wrong instrument for it.

---

## D34 — The mounting face is a question a person can answer, in the 3D inspector

**Asked for directly: "look at a part in 3D, click what face is the mounting face, and save it."**

The detector picks a part's wall face from whichever candidate scores best, and for 27 of the 51
shipped parts it declines to pick at all (`drawnOrientation: "n/a"`, PARKED P1). Until now there was
no way to answer it except by editing a file by hand and re-running a Python scanner.

**Decision: the correction goes through `overrides.json` — the channel that already exists** — and
carries three things: `wallFaceAxis`, `matingEnd`, and `spinSteps`.

The third one is why this is not only a detector fix. Picking a face fixes two degrees of freedom;
the turn *about* that face is the third, and it is the open pointy-top/flat-top frame question
(D31). `spinSteps` is in 30° units and not 60° on purpose: a hexagon repeats every 60°, so 60° steps
could never express the half-face offset between the app's wall and the frame the photographs show.
Per-part, it is how a part is made to look right before that question is settled globally; when it
IS settled, these become redundant rather than wrong.

**The face is fed to `detect()` as a CONSTRAINT, not stapled onto its result.** The footprint, the
projection and the tier all follow from which face is against the wall, so forcing the face and
re-deriving is what keeps "where it sits" agreeing with "which way it faces". Stapling would leave a
part whose cells were measured off one face and whose mesh hangs off another — the exact split that
unifying the footprint and the mesh was meant to prevent.

**The model is shown in the STL's own frame, not oriented.** The question is which axis of the FILE
faces the wall, so the click has to land on an axis of the file; raycasting an already-turned mesh
would mean inverting the permutation and the flip to get back, which is a second transform to keep
true against the first.

**Drag orbits, click picks, told apart by distance.** Not a nicety: the camera only ever shows three
of the six faces, and without orbit the back, the underside and one side cannot be chosen at all —
which is precisely where a mounting plug tends to be.

**Saved locally AND exportable.** A browser cannot write into the repository, so a correction would
otherwise either apply and never persist, or persist and never apply. It goes to localStorage so it
takes effect on the next render, and `Overrides (n)` downloads it in `overrides.json`'s own shape so
it can be committed — at which point `tools/scan.py` honours it too and a rescan agrees. Merged per
part rather than per file, so a local mounting decision does not discard the shipped fastener count
for the same part: different facts, different people, different days.

**What this does NOT do: it does not clear `needsReview`.** Knowing which face mounts removes the
detector's main ambiguity, but for a tier-3 part the CELLS are still the bounding-box bound PARKED P1
says is not a measurement. Promoting a bound to a measurement by clicking is the dishonesty that
`withFootprint` already refuses to commit, and this refuses it too.

**It found its own first case immediately.** `shelf-1` is detected as mounting on `Bottom (−Z)` —
`insertFed` choosing the face with the most material under the surface, which for a shelf is the
tray. The pegs are on another face entirely. The dialog shows the detector's answer next to the
picked one for exactly this reason: so you can see what you are overruling.

---

## D36 — Hovering lights the whole cell, in both views; and `cellAt` stops re-deriving `mmToHex`

**Asked for: "honeycomb should be highlighted the full size of it when I hold the mouse over."**

Two things were wrong, and the second was much worse than the first.

**The 2D plan drew the highlight inset by 0.8 px.** A hairline of unlit grid stayed around the
hexagon, so it read as a slightly smaller shape floating inside the cell rather than as the cell
itself lighting up. Now drawn at inset 0 — out to the corners, the size `hexCorners` gives.

**The 3D view had no hover highlight at all.** It tracked `hover` only while something was being
dragged, so the wall said nothing about which cell the pointer was over until you were already
carrying a part. It now lights the cell at `PITCH` across flats — the whole hexagon, not the 22 mm
mouth. The mouth is the hole; the cell is the hexagon of wall it sits in, and that is what "which
cell am I pointing at" means. Suppressed while dragging, because the ghost answers the same
question more precisely.

Drawn in the **accent**, additively. `--canvas-cell-hover` is a dark slate, which highlights on the
2D canvas because it is lighter than the wall behind it — and in 3D the cell sits on a pale grey
plate, where the same colour darkens instead. Additive blending brightens whatever is underneath,
on a plate or over a gap, in either theme.

**The real find: `cellAt` carried its own copy of the inverse embedding**, still in the pointy-top
form — `r = y/20.438; q = x/PITCH − r/2` — with a private `hexRound3` beside it whose comment
claimed "shared semantics with hex.ts so both views agree". The frame turn (D35) missed it because
nothing in the file names `mmToHex`. **Every hit test in the 3D view was landing several cells from
the pointer, and that includes the DROP.** Placing a part in 3D put it in the wrong hole.

**Decision: `cellAt` calls `mmToHex`, and `hexRound3` is deleted.** Delegating rather than
re-deriving is the actual fix. A rule with two implementations has two chances to be wrong and one
place you will look — and this copy survived precisely by not mentioning the function it duplicated.

Found by pointing at the wall and noticing the wrong hexagon lit. No test covers it: the suite
never asks where a screen coordinate lands, and 557 of them passed throughout.

---

## D37 — The wall is drawn from the real panel STLs, and hovering lights the whole plate

**Asked for: "the honeycomb should be a model of the ACTUAL honeycomb, so when I hover it I hover
the whole part."**

Two things, and the second is the one that was actually missing.

**Panels are now drawn from their own STL**, the way accessories already were. They used to be
generated — an extruded union outline with a hole per cell, built from the measured lattice. That
is exact as far as it goes, and it is a *model* of the plate rather than the plate: it cannot show
the entry flare, the lead-in chamfer, or anything the designer put there that the four numbers in
`constants.ts` do not capture.

Still instanced per panel type, so a 64-panel wall is one draw call per type, and loading stays
lazy and cached per part id. The generated geometry remains the **fallback** — a planner that
cannot fetch a model still plans.

**A panel with `omit` keeps the generated geometry, and that is not an optimisation.** A cut panel
is a CUSTOM panel from the OpenSCAD customiser, not the shipped STL any more. Drawing the stock
mesh for one would show a plate with no hole where the light switch goes — exactly the thing the
customiser exists to cut.

**Alignment is centre-to-centre, and the assumption behind it was measured rather than asserted.**
The mesh arrives centred on its own bounding box; the cell block is not centred on the *origin*
cell. Lining the two up by their centres is only correct if a plate's cells really are centred
within it, which the margin formula implies (HSW-SPEC §4) — and the meshes agree to **0.00002 mm**
across the panels checked. So the alignment is exact, not lucky.

**Hovering now lights the whole plate**, faintly, with the hovered cell brighter on top of it.
Drawn from the panel's own `unionOutline`, so it follows the castellated zig-zag edge exactly
rather than approximating it with a rectangle. A wall is not a continuous honeycomb — it is a set
of printed plates, and which one you are pointing at is a real question: it is the thing you print,
hang and count. The seams are zig-zags through the grid and are genuinely hard to read face-on.

Both together answer the two questions at once: which plate, and which hole in it.

---

## D38 — The mounting-face inspector actually re-orients the part now

**Reported as a new request — "let me click the surface that should face the honeycomb so parts
get rotated correctly" — which is what D34 already built.** It was asked for again because it did
not appear to work, and it genuinely did not.

**`WallView3D` kept a second mesh cache.** `meshLibrary` caches oriented geometry per part id and
`forgetPartMesh` clears it, which `saveMounting` calls. But the view holds its own
`meshes` ref in front of that, and nothing was clearing it. So picking a face updated the
catalogue, dropped the library's copy, rebuilt the item group — and then drew from the view's own
stale entry. The part never turned. Saving worked, persistence worked, the export worked; the one
visible consequence did not, which is the only part a person can see.

Cleared on `catalog` identity, because that is exactly what changes when a correction is saved.
Broad on purpose: `loadPartMesh` still returns its cached promise for every part whose geometry did
not change, so the cost of being broad is a microtask.

**The control was also undiscoverable.** The ⌖ button on a catalogue tile sat at `opacity: 0` until
the tile was hovered, copying the remove control beside it. That is right for remove — destructive,
and its absence is safe — and wrong here: setting a mounting face is something you go LOOKING for,
and a control that only exists on hover is one you must already know about. Now visible at rest.

**Verified by the picture, not by the store.** Placed an SD-card holder, changed its mounting face
from `Left (−X)` to `Front (−Y)`, saved, and compared screenshots: the wide comb becomes a compact
end-on block. Checking `localStorage` would have passed before the fix as well.

---

## D39 — The catalogue shows a rendered preview of each part

**Asked for: "a small 3D preview or a photo of the part in the list."**

A name and a cell count do not tell you what a part IS. `hook-to-empty` and `hook-side` are two
hooks; `insert-hollow-tre` and `insert-hollow-for` differ only in cell count; and many of the 51
names describe the part's FIXING rather than its shape. Picking the right one meant dragging it onto
the wall to look at it.

**Rendered, not photographed.** There are no photographs of most of these parts, and a render is
generated from the same STL the planner already trusts — so it cannot drift from what will be
printed, and an imported part gets a preview for free.

**One offscreen renderer, not one canvas per tile.** A browser allows on the order of sixteen live
WebGL contexts and the catalogue has fifty-one tiles; a canvas each would have the oldest contexts
killed and those tiles go blank. Instead each part is drawn into a single shared renderer in turn
and read out as a PNG data URL, which is an ordinary `<img>` from then on.

**Lazy, via `IntersectionObserver` with a screenful of margin.** Fifty-one previews means fifty-one
STL fetches and parses, and the rail shows about six at a time.

**The bounding BOX is fitted, not the bounding sphere.** The obvious sphere fit wasted most of the
frame on this part set: a panel is a wide flat plate, its sphere radius is half its *diagonal*, and
framing that left the plate an unreadable smudge in a 48 px tile. Projecting the box corners onto
the camera's own axes and fitting the widest is exact for any proportion — a plate fills the frame
and a hook still fits. The tile is 64 px, which is where the shapes became legible.

**Both caches are dropped together.** The preview draws the ORIENTED mesh, so picking a new mounting
face (D34) invalidates it exactly as it invalidates the geometry — and removing an imported part
clears both, since an imported id can be reused by a later import and would otherwise show the old
part's shape under the new one's name.

---

## D40 — "Align parts": measure the peg, compare it with the catalogue, decide in one screen

**Asked for: "a new tool to align all these parts so they fit like they should — really important if
people are going to use this."** They are right that it is. 27 of 51 parts have no measured mounting
face, the inspector (D34) fixes one at a time, and at one dialog per part nobody finishes.

Two pieces.

**`src/core/peg.ts` — measure the peg.** `detect.ts` cannot answer for these parts: they have no
wall interface on any axis, so `insertFed` falls back to "the face with the most material just under
the surface", which for a shelf is the underside of the tray. But the part mates through a
*hexagonal prism*, and a hexagonal prism has a signature nothing else in these models has — every
side face parallel to the axis, their normals on six directions 60° apart. One pass over the
triangles; no raster, no shapely, so it runs in the browser.

Held to the one independently measured fact available: D31 established BY HAND that all four shelves
and both `hook-to-empty` variants mount along **Y**, where `detect.ts` says Z for every one of them.
`detectPeg` reproduces that from geometry alone at confidence > 0.9, and `tests/peg.test.ts` pins it.

**`AlignPanel` — a contact sheet, not a wizard.** Every part on one screen, the catalogue's axis
beside the peg's face, the ones that DISAGREE sorted to the top and least-confident first. Most rows
need no attention; the few that do are visible without a click. One button accepts every confident
disagreement at once, and the threshold is stated on screen rather than hidden.

**What it deliberately does not claim.** No width is reported (see `peg.ts` — averaging plane
offsets across a part with 56 identical holes is meaningless, and it produced −0.96 mm before it was
removed). No footprint is proposed: which cells an installer uses is PARKED P1 and stands. And the
Catalogue column shows the **axis only**, because `catalog.json` records `wallFaceAxis` and no mating
end — naming a face there would put an end on screen that nothing measured.

Accepting writes the same `MountingOverride` the inspector writes, so it reaches `overrides.json`
and exports identically. Not a second channel.

---

## D41 — Six degrees of freedom in the inspector, and one transform behind them

**Asked for directly: "in the alignment tool I need all degrees of freedom to move this part into
the exact position, so I need 6 degrees of freedom."**

D34 gave the correction three and a half: the mounting face (two), a spin in 30° steps about the
wall normal, and a depth along it. That is enough to say *this face, that way up*, and not enough to
SEAT a part — a model drawn a couple of degrees off square, or whose mating peg is not centred in
its own bounding box, cannot be put where it goes by naming a face and a depth. There was no way at
all to slide a part sideways.

**Decision: `MountingOverride` carries a full rigid transform** — `offsetXMm`, `offsetYMm`,
`offsetMm` and `spinSteps` + `spinDeg`, `tiltXDeg`, `tiltYDeg` — in WALL coordinates: +X across the
wall, +Y up it, +Z out of it. The two old fields keep their names and their meaning, so a
correction written before this reads back as exactly itself, and an absent field means zero.

**The spin stays in 30° steps with a trim on top, rather than becoming one free angle.** 30° is a
turn the lattice itself has (D31/D34); the ↺/↻ buttons are how a hexagon is lined up, and counting
thirty presses of a 1° control is not. The dialog shows the two as ONE angle in degrees and splits
it on the way in — nobody thinks in "four steps and seven degrees".

**One transform, in `src/ui/mountingTransform.ts`, and both consumers call it.** `meshLibrary` bakes
it into the geometry the wall draws; `PartInspector` conjugates the same matrix into the file's own
frame to preview it. Two copies of "rotate, rotate, translate" is precisely the failure this repo
has paid for three times over — the hex inverse survived in three places because none of them named
the function they duplicated — and here the symptom would be a part lined up in the dialog and
somewhere else on the wall. The order is fixed and documented: spin about the normal, tilt about X,
tilt about Y, then translate. Rotation first because "turn it, then put it where I want it" is the
order a person can predict; the other way round every slide is re-aimed by whatever spin is set.

**The pivot is the mating FACE, not the middle of the part.** On the wall `orient` puts the mating
face at z = 0, so a tilt hinges on the wall surface. The inspector's mesh is centred on its own
bounding box, so the preview needs the pivot moved there explicitly — otherwise the same six numbers
would hinge about the part's middle and swing it off the plate. `halfAlongNormal` is the argument
that carries it, and `tests/mounting-transform.test.ts` pins the hinge.

**The wall plate is now FLUSH against the chosen face.** It stood off by half the part's LARGEST
dimension plus 4%, which for anything that is not a cube left the part floating: zero depth looked
wrong, and every reading of the depth was against a gap nobody chose. Zero now looks like what zero
means.

**Every number is typeable.** Buttons are for nudging while you watch, and nudging is hopeless for
"3.2 mm out and 7° round", which is what matching a part to a measurement or a photograph asks for.
The field holds its own text while focused — a controlled numeric input without that cannot be typed
into, because clearing it to type `-3` parses to nothing and writes the old value back under the
cursor.

**Keyboard: the two pairs that existed still do what they did.** Bare arrows spin and set depth,
`shift` slides, `alt` tilts. The common adjustments should not move because four more became
possible.

**What this does NOT touch: the detection.** The cells a part covers, its projection and its tier
still come from `detect()` under the chosen face. A seating correction says where the mesh sits; a
tier-3 part's footprint is still the bound PARKED P1 describes, and nudging a part 12 mm sideways
does not promote it.

---

## D42 — The inspector says how much wall a part takes, and what it rests on

**Asked for directly: "in the alignment tool I want to select the amount of space on the wall — I
click the number of frames it should take — and I should be able to mount these on top of the
inserts, since they are what's fastening it."**

Two questions, and geometry can answer neither.

**How much wall.** `detect()` gives every part a footprint, but for the 27 with no wall interface it
is the bounding box laid over the lattice: a BOUND, not a measurement (PARKED P1). Which cells an
installer actually uses is a choice — a shelf whose box spans seven cells is held by two pegs. The
import dialog has had a cell editor since it shipped, for parts being added; parts already in the
catalogue had no way to answer at all.

**Decision: `PartOverride.footprint` — the same override file, the same merge, the same export.**
It replaces the detected cells outright, re-anchors on the origin, and everything downstream follows
because everything downstream reads `part.footprint`: `store.partCells` for what a drop covers,
`bom.itemCells` for what the parts list reconciles, the ghost for what the drag shows.

**Drawing the cells CLEARS `needsReview`; re-stating them does not.** That is the line
`withFootprint` already draws for an imported part, and the reason is the same: the flag means
"these cells are a bounding box", and an actual edit replaces the bound with a decision. Clicking a
cell and clicking it back is not a decision, and promoting a bound by round-tripping the editor is
exactly the dishonesty P1 exists to prevent.

**It does NOT change what the part requires.** Cells are how much wall a part covers; pegs are what
holds it up, counted by `detect.mountPoints()` from the wall face (HSW-SPEC §5). Deriving one from
the other is what had a 7-cell shelf with two pegs ordering seven inserts, twice. The dialog now
states the two side by side — "4 cells" and "the parts list orders 2 × insert-empty, counted from
its own pegs rather than from these cells" — so nobody has to infer that they are different facts.

**What it rests on.** HSW is two-level: the insert clips into the cell, the accessory pegs into the
insert. The insert's 22.5 mm flange cannot enter the 22.0 mm mouth, so it seats proud, and a
fastened part rests on the FLANGE — `INSERT.flangeThickness`, 2.5 mm, measured. `orient` puts every
mating face at z = 0, which is where a part sits only if nothing is fastening it.

**Decision: `MountingOverride.seat: 'wall' | 'insert'`, a datum rather than a number.** Typing 2.5
into the depth would work today and say nothing: a reader six months later sees a nudge, not a
reason, and it does not follow the flange if the flange is ever re-measured. `seatOffsetMm` reads
the constant, `mountingTransform.depthMm` adds it under the person's own trim, and both the preview
and the wall get it from that one function (D41).

Default `wall`, not `insert`. It is the physically right answer for most accessories, and making it
the default would silently move every part in every saved layout 2.5 mm out.

**The inserts are drawn.** A toggle that only changes arithmetic is a toggle nobody trusts, so the
patch grows a flange in each claimed cell and the part visibly rests on them.

**The plate is now the part's OWN cells plus a ring.** It was a fixed centre-and-six, which is
right for a one-cell hook and wrong for a four-cell shelf — the part spilled off the plate and the
one question the plate exists to answer, does this cover the cells it claims, could not be asked.

**And the fourth copy of the hex embedding turned up.** `FootprintEditor` carried
`x = PITCH·(q + r/2), y = ROW_STEP·r` — the pointy-top frame from before D35, which is the TRANSPOSE
of `hexToMm`. A transpose is a reflection: symmetric footprints looked identical and an L-shaped one
came out mirrored from the shape that landed. It now calls `hexToMm` and `hexCorners`, like
everything else. Extracted to `src/ui/FootprintEditor.tsx` so the import dialog and the inspector
cannot drift apart, which is also how the bug survived — it was one component nobody compared with
the wall.

---

## D43 — A cell of a part can be a socket: something else installs into it

**Asked for directly: "on the thing that mounts to 4 panels and the wall, 3 of those are for
mounting as well, so I want to be able to install things into those."**

The thing is `insert-for-countersunk-hole-3` (and its sibling `insert-countersunk-with-m3x3`): a
four-cell diamond that bridges a junction where four plates meet and takes one wall screw
(HSW-SPEC §4, `fixings.ts`). The planner treated all four of its cells as filled, so dropping
anything that plugs into a cell was refused — "one insert per hole". That rule is right for a plain
insert and wrong for a part that IS the hole.

**Which three, measured rather than assumed.** Rastering the mating face and matching each enclosed
hole's centroid to a cell of the footprint gives, for both parts, the same answer: cells (0,0),
(1,0) and (2,-1) carry a mounting hole and (1,-1) carries the 3.2 mm wall-screw bore. On
`insert-for-countersunk-hole-3` the three are 13.2 mm across flats and 15.2 across corners — the
standard 13.4 mm insert socket a peg plugs into; on `insert-countersunk-with-m3x3` they are 3.0 mm
M3 bores. The whole hollow family came out of the same pass: `insert-hollow-dual`, `-tre` and `-for`
are sockets in every cell. All five are in `overrides.json` with the measurement in the note.

**Decision: `PartOverride.socketCells`, applied per cell, and a placement rule that reads it.** A
cell offered as a socket accepts ONE thing installed into it; the next is refused, as is anything at
all in the screw cell. Marked in the inspector by cycling a cell — empty → covered → a socket — and
drawn open there and gold in the 3D patch, because a socket is a hole in the part rather than
material.

**What it did NOT change: the parts list.** A socket says something CAN go there, not that anything
is ordered. Cells are how much wall a part covers, pegs are what holds a part up, and deriving a
fastener count from cells is the seven-inserts-for-two-pegs bug this repo has already paid for
twice. An insert installed in a socket is counted because it was placed, not because the socket
exists.

**It found a real bug on the way.** The occupancy index kept ONE item id per cell, last writer
winning — so an accessory hung over an insert HID it, and the cell then accepted a second insert as
if it were bare wall. The one-insert-per-hole rule had a hole in it, and only for the case a person
would actually hit: hang a hook, then fit an insert. There is now a second index of what is IN each
hole, which is what the rule was always describing.

**And the validator had to learn the same rule, immediately.** Within a minute of the store allowing
the install, the app accepted the drop and the parts list turned red: "only one part can occupy a
cell". Same class of split as `partCells` vs `itemCells`, and the same fix — `itemSocketCells` in
`bom.ts`, written as the same three steps as `itemCells`, consulted by both.

---

## D44 — The plate is perforated, the camera is in the room, and the fastener is a picture

**Reported: "still not working on those fasteners, they disappear. Also with those fasteners in
that alignment tool I want to select which one to use with the part, so have a photo of the
selection."**

**They disappeared because a cell was drawn as MATERIAL.** The inspector's wall patch was a slab
with an opaque hexagonal prism plugged into every cell. That is invisible behind an accessory, which
stands proud of the wall, and fatal for anything that goes INTO the cells:
`insert-for-countersunk-hole-3` sat exactly inside four solid prisms and could not be seen at all.
A cell is a hole. The plate is now one extruded outline with a hole per cell — the same thing
`buildPanelGeometry` does for the wall itself, for the same reason — and a claimed cell is marked
by a RING round the hole rather than a plug in it.

**Second cause, same symptom: the camera was inside the wall.** The view opened on a fixed front
angle and the face buttons looked straight AT the mounting face. That was survivable while the plate
stood half a part's width away; with the plate flush against the mating face (D41) it means looking
at the back of the wall with the part behind it. The dialog now opens — and every face button now
looks — from the ROOM side, which is the end the mating face is not on.

**Third: the patch was drawn at lattice coordinates while the mesh was centred.** Cell (0,0) is not
the middle of a four-cell diamond, so the part was drawn 20 mm from its own holes. The patch is now
centred on the block, which is what `meshLibrary.orient` does to the mesh.

**Choosing the fastener: tiles with rendered pictures, not a list of ids.** `insert-hollow-tre` and
`insert-hollow-for` differ by three letters and by one cell; `insert-with-m3` and `insert-m4` differ
by a bore nobody can see in a name. The thumbnails are the same renders the catalogue tiles use,
cached per part id, so this costs nothing new. The chosen fastener and a count go into
`PartOverride.requires`, which `applyOverrides` already applied and the BOM already consumed — the
gap was only that no one could say it without editing JSON.

**The count is the number of PEGS, not of cells**, and the panel says so where it is entered. That
is the rule the catalogue keeps getting wrong on its own (a 7-cell shelf with two pegs ordering
seven inserts), and the place to state it is next to the number.

**And `loadUserOverrides` had to learn to read it back.** It re-validates every field on the way in,
which is right — a stored document is user input by the time it returns — but a field nobody reads
is a correction that applies for one session and vanishes on reload. The validation is now the
exported, browser-free `readUserOverrides`, tested field by field, precisely so the next field
somebody adds is not silently dropped.

**Pushing the setup, not just the diff.** Asked for straight after: "I want to save it locally yes,
but I want to be able to push the setup for all of the parts." Local storage was never the
sticking point — the export was, because `toOverrideFile` emits only what THIS browser changed
(D34, so the diff stays readable). That is the right file for a small pull request and the wrong one
for "here is how every part is set up". `toSetupFile` merges the shipped decisions with the local
ones, sorts by id, carries the file's own preamble through, and is what the top bar's **Setup (n)**
now downloads: drop it over `src/catalog/overrides.json`, commit, and both the app and
`tools/scan.py` read it. **Mine (n)** still gives the narrow diff, and only appears when there is
one.

---

## D45 — The tool's honeycomb IS the wall's honeycomb, and up the wall is up

**Reported: "the size of the honeycomb in the tool is not the same size as the real honeycomb, so
please fix that, and make the up orientation be up."**

**The cell was drawn as one straight 22 mm bore.** A real wall cell is stepped: a 22.0 mm mouth
2.0 mm deep, then the 20.0 mm throat that actually retains an insert (HSW-SPEC §3, `CELL`). The
inspector's plate went straight through at the mouth, so every hole in the tool read wider — and
shallower — than the same hole on the wall, which is exactly the comparison a person is making when
they hold the dialog up against their own honeycomb. It is now the two layers `buildPanelGeometry`
already builds for the wall, from the same constants, with the mouth on the side the part is on.
Same numbers, same profile, one honeycomb.

The cell marker went with it: a ring 1.0 mm proud each side ate most of the 1.6 mm web, which made
the webs look fatter than they are. 0.6 mm now, so the web is drawn at its real width.

**Up the wall is up on screen.** The part is modelled in the FILE's frame on purpose (D34) — the
question is which axis of the STL faces the wall, so a click has to land on an axis of the STL. But
nobody hangs a shelf in the file's frame. While "up the wall" was whichever way the modeller drew,
the one judgement the dialog exists for — will this hang right — could not be made by looking, only
by reading a green arrow.

**Decision: turn the STAGE, not the part.** `fileToScene` maps the file's axes into a scene where
the wall's across is +X, its up is +Z (which is also the orbit's pole, so dragging behaves) and its
outward normal is −Y, toward the default camera. The geometry inside keeps its file coordinates, so
`face.normal` still names a file axis and the raycast is untouched. Determinant +1 on all six faces,
held by test — a mirrored stage would be a left-hand hook drawn on a right-hand wall.

That collapsed the per-face camera rules: with the stage turned, every mounting face points the
same way, so the view is simply "from the room, three-quarter". Dead-on was rejected for the reason
it always was — along the normal a part is just its own silhouette.

---

## D46 — The honeycomb in the inspector is a real panel out of `models/`

**Reported: "when I select shelf 2 in the alignment tool it does not align with 2 honeycombs, so I
think the size of the honeycomb in the alignment tool is wrong. Can you just use an original STL for
the honeycomb model in there."**

The size was not wrong — D45 had already put the wall's own stepped profile in, and the lattice came
from `hexToMm` throughout. But that is an argument, and the person holding a printed panel against
the screen should not have to take an argument on trust. **The wall in the dialog is now the
smallest shipped panel that covers the patch, loaded through `loadPartMesh`** — the same loader,
cache and 90° pointy-plate spin the wall view uses. There is nothing left to disbelieve: it is the
file they are going to print.

Its lattice is aligned to the dialog's by putting the panel's most central cell exactly where the
part's own cell (0, 0) goes. Both sides are `hexToMm`, so every other cell follows for free, and
`tests/panel-mesh.test.ts` already holds each plate's mesh to its block — the property the alignment
rests on. The drawn plate stays as the fallback, because the app is built to run from a `file://`
URL with no `models/` beside it.

**The plate is built in WALL coordinates now.** `wallBasis` as the group's rotation makes +X across,
+Y up and +Z out of the wall, which deleted a per-axis sign that every position in that effect had
to carry by hand.

**What shelf-2 was actually showing.** Its catalogue footprint is five cells in a COLUMN — the
bounding-box bound (PARKED P1) — while the part is 97 mm wide and 51 deep, and the detector puts its
mounting face on the tray underside rather than on the pegs (D40's first case, still open). So it
was drawn lying flat across five cells it does not use. Nothing about the honeycomb: the tool was
faithfully drawing a wrong catalogue entry. Front (−Y) plus a 90° spin lands it flat on the wall,
and the cell editor is where the two real cells get recorded — which is exactly the workflow D42/D43
added, now against a wall nobody can argue with.

**And the dialog is keyed on the part.** Every control seeds from the part it opened on, so a part
swapped under an open dialog would have inherited the previous one's alignment and offered to save
it. `key={part.id}` makes the swap a remount. No path in the app does that today; the trap is that
the next one would have.

**The middle cell is not compulsory.** Reported straight after: "where you select where the
fasteners should be I'm not able to select nothing, which I should, and I want to not have to have
the middle one." The editor pinned cell (0, 0) — one click cycled it covered → socket → covered and
never to empty — on the reasoning that `partCells` puts the anchor under the cursor and a footprint
with nothing at the origin has no cell to drag by. True of the ANCHOR, and the anchor does not have
to be the origin. A two-peg shelf hangs on the cells above and below its middle and uses nothing in
between; pinning the middle gave it a third cell it does not have, which then reports overlaps
against a neighbour that is not really there.

So `anchorOf` picks the drag cell from whatever cells the part has — nearest the origin, ties broken
deterministically, which for any footprint containing the origin IS the origin — and
`applyOverrides`, `withFootprint` and the editor all use it instead of assuming. Any cell can now go
back to empty; the last one cannot, because a part covering nothing cannot be checked against
anything. The editor outlines whichever cell is currently the anchor rather than always the middle.

Four tests written the day before pinned the old rule and now assert the new one — the case
`tests/critic-*.test.ts` warns about, checked rather than "corrected": the behaviour changed on
purpose.

---

## D47 — A socket in the wall IS an insert, so the parts list stops ordering another

**Asked for: "the wall fastener combined is 1 screw hole and 3 empty inserts, so when I align a part
with an empty insert and put it on one of the spots that's open on the wall mount, I want it to
remove the one attached to the model and use the existing one."**

D43 made those three cells installable. What it deliberately did not do was change the count, on the
grounds that knowing WHICH peg lands in which socket is an inference from cells — the mistake that
had a 7-cell shelf ordering seven inserts. That objection is answered now: the cell editor (D42)
records the cells a part actually mounts through, so "a cell of this part is a socket of that one"
is a fact about two placements rather than a guess about a bounding box.

**Decision: a socket may declare which insert it STANDS IN FOR (`socketProvides`), and a part hung
on one has that insert deducted from what the list orders.** Measured and shipped: the junction
fastener's three sockets are the same 13.2 mm socket `insert-empty` provides;
`insert-countersunk-with-m3x3`'s three cells are M3 bores, which is what `insert-with-m3` provides —
and its own hardware already orders those three bolts and nuts, so nothing is lost by not printing
another insert.

**Stated, never inferred.** A part with `socketCells` and no `socketProvides` offers somewhere to
install something and orders nothing away. Two sockets being the same size is not proof they do the
same job, and this is a shopping list.

**One socket, one claim.** Sockets are allocated in document order and each is consumed once, so two
accessories over the same hole cannot both save an insert, and a part can never claim its own.
Sockets come from placed items AND from the junction fixings the plan puts in at the seams — those
are in the wall whether or not anybody dropped them by hand.

**The line says why it is not higher.** `BomLine.providedBySockets` reads "1 already in the wall" on
screen, a note in the markdown checklist and a column in the CSV. A quantity that silently drops is
indistinguishable from a bug at the printer.

Checked in the app, not only in tests: with a junction fastener placed, dropping
`countersunk-to-holee` on one of its sockets leaves no `insert-empty` line at all; dragging the same
part one cell off the socket brings it straight back.

---

## D48 — Hanging a part on a wall fastener's open hole must not delete the fastener

**Reported: "if you move something like the hook to empty onto one of the wall fastener's empty
holes, the wall mount just disappears. I want to use those holes, but only for parts that use an
empty insert of any kind to mount."**

`planFixings` refuses any cell an accessory covers, and it checks that over all FOUR cells of a
junction placement — so one hook on one of the three open sockets dropped the whole placement. The
fixing vanished from the plan, from the parts list and from the 3D view, which is the opposite of
what putting a part there means: the socket is what the part is pegged INTO.

**Decision: two readings of "occupied", not one.** Anything on a cell still keeps the spacing grid
out of it — a single-cell countersunk fixing has no socket to peg into and a screwdriver has to
reach its head. But a part that mounts through a plain socket, sitting on a JUNCTION's socket cell,
blocks nothing. `SharedCells` carries those cells plus the junction's socket offsets, and the
junction pass allows a shared cell only where that candidate placement actually has a socket. The
fourth cell — the wall screw — still blocks, whatever is on it, because a screwdriver has to get
there.

**"An empty insert of any kind" is derived, not a list of ids.** `isEmptyInsert` is an insert or
fastener that asks for NO hardware: no bolt, no wall screw, so all it offers is the socket. That is
`insert-empty` and the whole hollow family, and it excludes every M3/M4/M5 and every countersunk
insert. A part "uses" one when its `requires` names one.

**One helper, both consumers.** `fixingPlanFor(doc, catalog)` builds both sets and is what `bom.ts`
and `WallView3D` now call. Two readings of which cells are free would have put a fixing in the
picture that is not on the list, or the reverse — the same split `partCells`/`itemCells` and
`store`/`validate` have each been through.

**A broken fixture, found while testing this.** `planFixings` groups cells BY PANEL ID; a test that
built panels straight from `solveTiling` without assigning ids had every panel reading as the same
plate, so no junction was ever found and the test would have passed against a planner that did
nothing. The app assigns `p${i}`; the fixture does now too.

---

## D49 — The socket cells were measured in the wrong frame, and it inverted them

**Reported: "it sort of works — it only works over the countersunk hole, which is the only one it
should NOT work on."**

Exactly right, and the cause is one frame. D47's socket cells were measured by rastering the RAW
STL and matching each hole's centroid to a cell. But `meshLibrary.orient` turns a part over when its
mating end is `high` — `v = -v` — while `detect.toAxial` does not turn the footprint with it. This
part mates on `high`. So the measurement was of the file, and the app draws the mirror of it: the
middle two cells swap, and the app ended up calling the wall-screw bore a socket and the socket a
screw hole. The outer two cells are on the mirror axis and were right either way, which is why it
"sort of" worked.

**Re-measured in the frame the wall draws in** — the mesh oriented through the mating flip,
positioned at the mean of its cells, each hole's centroid through `mmToHex`:

| cell | what is there |
|---|---|
| (1,0) | the 3.2 mm countersunk wall-screw bore |
| (0,0), (1,-1), (2,-1) | 13.2 mm hexagonal sockets |

Same three cells on `insert-countersunk-with-m3x3`. Confirmed by eye as well as by arithmetic: in
the inspector the round cone is the top-middle cell and carries no socket ring, while the other
three do.

**The general rule this leaves behind: anything that says WHERE ON A PART a feature is must be
measured on the ORIENTED mesh, never on the file.** The mirror is real for every `high`-mating part
and it is invisible on a symmetric footprint. `insert-hollow-for` shows the same mismatch between
its mesh and its own recorded cells; that one is a catalogue-wide question and is PARKED (P10) with
the measurement rather than patched here.

---

## D50 — The parts list is computed from the document and the catalogue, not through the store

**Reported: "when I place something I have used the tool on, the amount of fasteners does not
update — and when it is placed on top of these fasteners you of course don't need a fastener for
that part."**

**The stale list was an ordering hazard, not a missing dependency.** `App` computed the BOM with
`store.bom()`, memoised on the document. The store's catalogue is set in an EFFECT — `store.setCatalog`
runs after the render — so on the render where a correction has just rebuilt the catalogue,
`store.bom()` still reads the old one, and by the next render the memo has nothing new to react to.
Adding `catalog` to the dependencies does not fix it: the memo then recomputes on exactly the render
where the store is still behind. You could set a part to insert-M5, place it, and be told to print
insert-empty.

**The BOM is a pure function of two immutable inputs, so it is now computed from them:**
`computeBom(state.doc, catalog)`. No ordering to get right, and it is what `bom.ts` was written to
be. `store.bom()` stays for callers that own both — the tests, and anything outside React.

**And an empty insert of ANY kind now answers a part that wants an empty insert.** The substitution
matched on part id, which was right while the only such part was `insert-empty` and wrong the moment
the inspector let a person choose `insert-hollow-dual` instead: the same hexagonal socket, a
different id, and the saving silently disappeared. `isEmptyInsert` on both sides decides it. Bolted
inserts stay exclusive — an M3 bore answers only a part that wants an M3 insert, because a plain
socket has no thread.

---

## D51 — The drag ghost is `partCells`, like everything else that answers "which cells"

**Reported: "when I move the part around, the green honeycomb does not line up with where the part
lands."**

Both ghosts — `ghostCells` in the plan view and `ghost3DCells` in the wall view — called
`placeFootprint` on the RAW footprint. `store.partCells` subtracts the part's ANCHOR first. The two
differ by exactly that anchor, so the green cells sat a cell or two from where the part actually
dropped: with a two-cell footprint anchored at (0,-1), the ghost drew 4,1 and 4,3 while the part
landed on 4,2 and 4,4.

It hid because every anchor in the shipped catalogue is the origin, where the subtraction is a
no-op. It appeared the moment a hand-drawn footprint left the middle cell out (D46) and `anchorOf`
moved the anchor onto a real cell.

**Both now call `partCells`.** That is the third copy of "which cells does this part cover" this
repo has had to collapse — `partCells` and `itemCells` were unified for the same reason, and
`ghost3DCells` carries a comment about exactly this hazard directly above the line that had it.

`tests/ghost.test.ts` holds all three to each other for an ordinary footprint, one with no middle
cell, one anchored well off the origin, and through all six rotations — because rotation is about
the anchor too, so a turned part would jump as well as sit wrong.

---

## D52 — One body in the inspector's scene, and one place that removes it

**Reported: "under Space on the wall, if I click The wall face then Its inserts, the model
duplicates."**

The model-load effect added the part's mesh to the stage and overwrote `s.part` — and never took the
previous mesh away. Any re-run of that effect (its dependencies are the part and its saved mounting,
both of which are new objects whenever the catalogue is rebuilt) left the old mesh standing in the
scene. Every other effect drives `s.part` alone, so the abandoned copy sits still while the real one
moves: a part that duplicates itself and then leaves a ghost behind.

**Removed and disposed in the effect's cleanup**, which React runs before a re-run as well as on
unmount, plus a defensive drop at the point of adding — the invariant is one body, and it should be
readable where it could break, not only where it is tidied. The geometry built here is this dialog's
own; `meshLibrary`'s is the wall's too and is never disposed from here.

**Two things next to it were wrong for the same reason.** The plate effect removed the previous plate
itself and had no cleanup, so a closed dialog left its buffers behind; it now adds in the effect and
removes in the cleanup, one place each. And it bailed out while no body was loaded — right, because
it needs the body's half-extent for the stand-off — but nothing brought it back afterwards except
the first `status` change, so a RE-loaded part kept a plate sized for the previous one. `bodyTick`
is the signal now.

**What I could not do: reproduce the exact click sequence.** Four seat toggles, before and after a
saved correction, with the part moved 10 mm out to expose any ghost — one body every time, both
before and after the fix. The defect above is the only mechanism in the file that can leave a second
copy in the scene, and it is closed; if it turns up again it will be from a path I have not found,
and the thing to look at first is what changed `part` or `current` identity while the dialog stayed
open.

---

## D53 — An insert seats IN the wall, and its own mesh says how far

**Reported: "in the alignment tool I want you to use the actual model of the insert so that I can
line up properly, and catch the position from the alignment tool so that it all gets seated
correctly."**

The alignment tool drew the insert as a gold disc — `INSERT.flangeAcrossFlats` across,
`INSERT.flangeThickness` thick, one in every cell the part covered. That is a drawing of a flange
and nothing else: no body, no bolt head, and above all **no socket**, which is the one feature a
person is lining their part up against. It is the same objection that turned the dialog's honeycomb
into a real panel STL (D45) — what you are matching your part to should be the object you are going
to print.

**So the insert is now its own STL**, through the same `loadPartMesh` the wall draws with, sharing
its cache and carrying any correction saved for the insert itself.

**Which meant answering where an insert actually sits, and that is not where anything else sits.**
`meshLibrary.orient` leaves every part with its mating face at z = 0 — on the wall face. An insert
is the exception in the whole catalogue: its body goes through the 22.0 mm mouth into the throat and
only its flange stays on this side (HSW-SPEC §5). Drawn by the general rule it stands its entire
10 mm out in the room.

`src/core/insertSeat.ts` measures the split instead of assuming it: the flange is exactly the
material that cannot pass through a mouth, so the lowest plane at which the part gets wider than the
widest thing that fits IS the wall's front face. Every one of the fifteen shipped fittings measures
**7.5 mm of body and a 2.5 mm flange** — which is `INSERT.flangeThickness` to the tenth, so the datum
`seat: 'insert'` has moved parts by since it was introduced is now held to the models it claims to
describe (`tests/insert-seat.test.ts`). It **refuses** rather than guesses: a mesh whose widest
material is not a thin collar at the outer end returns null, and the caller falls back — to the drawn
flange in the dialog, and to the old convention on the wall.

**The classifier deliberately uses no cell centres.** The obvious test — "further from any cell
centre than a mouth's circumradius" — is more principled and does not work here, because for a
`high`-mating part the oriented mesh is mirrored relative to its own footprint (PARKED P10). On the
chiral two-cell fittings (`double-m4`, `insert-hollow-dual`, `insert-hollow-for`,
`insert-with-m3-dual`) that reads the plugs as being outside their own holes and calls the entire
10 mm a flange. A band inside the part's own outline needs no lattice at all and is immune to it.

**The same measurement fixed the wall, which is the "seated correctly" half of the request.** Wall
fixings and junction fixings were drawn at `PANEL_DEPTH − depthMm`: all 10 mm of a fitting inside an
8 mm plate, so the flange was buried 2.5 mm in the honeycomb and 2 mm of body came out of the back.
A placed insert item was at `PANEL_DEPTH` — the whole thing standing in the room. All four now go
through one helper, `seatedZ` in `WallView3D`, so the wall cannot seat an insert one way as a fixing
and another as an item, and the dialog and the wall show the same object in the same place.

**The inserts are drawn `fastenerCount` times, not once per cell** — in the 3D stage and in the 2D
footprint editor, which took a `showInserts` flag and marked every covered cell. A seven-cell shelf
hanging on two pegs showed seven inserts: the seven-inserts-for-two-pegs error (CLAUDE.md) drawn as
a picture, contradicting the number typed directly below it. They go in the cells nearest the anchor,
deterministically, and a multi-cell fastener claims every cell it covers so the next one does not
land on top of it.

**What is NOT claimed: which cells the pegs are really in.** Nothing in the geometry says that, and
the tool does not pretend otherwise — the count is a person's answer and the placement follows it in
a stated order. And the seat datum stays `INSERT.flangeThickness` rather than becoming per-part: it
is what `seatOffsetMm` moves a part by, in a core function with no mesh to hand. An insert whose own
flange disagrees with it by more than 0.1 mm — which no shipped one does, but an imported one may —
is called out in the dialog with the number to type into the depth, rather than being absorbed.

**And the dialog has to seat a fitting too — reported within the hour.** "The whole wall is
misaligned, so when I line something up in the tool it does not line up in the large preview." The
wall had learnt where an insert goes and the alignment tool had not: it draws every part with its
mating face on the plate, which is right for an accessory and 7.5 mm wrong for the part that mounts
INSIDE the cell. Lining an insert up against the tool's wall therefore put it somewhere else in the
big view — the single failure this file exists to prevent, reintroduced by teaching one side of it
a new fact.

The inspected part is now dropped by the same `seat.bodyMm`, as a translation along the wall normal
on top of `mountingMatrixInFileFrame` — NOT folded into `mountingMatrix`, because it is not a
correction: nobody chose it, and it must never appear in the six numbers that get saved. It is
measured under the LIVE face rather than read off `loadPartMesh`, whose geometry carries the SAVED
mounting: picking a different face changes which end goes into the wall, and the preview has to
follow the click rather than the file.

What was checked while looking for it, since "the whole wall" could have meant the honeycomb itself:
every shipped panel's holes were rastered out of the geometry the wall actually draws — `orient`
plus the pointy plate's 90° — and compared with `hexToMm` under the wall's own placement rule. The
worst residual over all seven, 288-cell plate included, is 0.25 mm at a 0.5 mm raster, i.e. nothing.
The plates and the lattice agree; it was the fittings that had moved.

**Then the cell markers had to stop being plugs.** "When I place a part its middle gets filled out,
so I cannot see through the open parts." Each occupied cell carried a solid hexagonal prism in its
mouth — a marker for WHICH cells a multi-cell part uses, which is a real question the body alone
cannot answer. It sat at z 6.0–8.4, which is inside the socket of an insert now seated at 0.5–10.5:
the marker was drawn through the middle of the very hole it was pointing at.

`PartInspector` already knew this — D44 turned its cells into rings for exactly this reason, "a cell
drawn as a solid prism hides anything that goes into it". The wall's markers are now the same ring,
0.6 mm each side of the 1.6 mm web, so they sit ON the rim and leave the hole open. Seating the
fittings is what exposed it: while an insert stood 10 mm out in the room, the plug behind it was
hidden by the part itself.

**And then the wall had to DRAW them.** "When I use the tool to align an object with an insert, the
insert is not rendered in the 3D view of the main page." The wall drew the fixings that hold the
PLATES up — the spacing grid and the junctions at the seams — and nothing that holds the things ON
them. So the alignment tool showed a hook pegged into an insert and the big view showed the same
hook floating over an empty hole: the two disagreed about the very object the tool exists to line
up against.

`bom.fasteningPlanFor` resolves every placed item's `requires` into cells on the wall, and it is one
plan with two consumers by construction: `computeBom` reads its `supplied` cells to know what NOT to
order, `WallView3D` reads its `cells` to know what to draw. An insert in the picture is an insert on
the list, and the reverse — which is the rule D48 had to establish for the wall fixings after
planning them twice gave 128 holes in a wall needing 80. The socket allocation moved into it
unchanged, so the deduction that was already right stayed right.

Which cells carry them is `fixings.fastenerCells`, and `PartInspector` now calls it instead of its
own copy: the count the person typed, never one per cell, nearest the anchor, with a multi-cell
fastener claiming what it covers. Two copies of that rule would put the insert in one cell in the
dialog and another on the wall — the same failure as the seat, one step further out.

`tests/fastening-plan.test.ts` pins both halves: the count rule with its cases, and a part hung on a
junction's open socket coming back `supplied` with nothing drawn while a second one on bare wall
buys its own — checked against the BOM line, which reports 1 printed and 1 provided.

---

## D54 — The generator is built from the measurements; the customiser settles only choices

`Customiser/Cadcode.rtf` — the supplied OpenSCAD customiser plus borders — expresses the whole bore
in closed form, as one extruded polygon per wall:

    polygon([[0,0], [0,8], [0.8,8], [0.8,6], [1.8,5.1], [1.8,0.5], [1.62,0]])

That is a complete, unambiguous specification of the plate, and it would have been much quicker to
transcribe than to derive. It is also wrong in one place.

Read as thickness against height, it says: 1.8 mm of wall from z 0.5 to 5.1, tapering to 0.8 mm
between 5.1 and 6.0, then 0.8 mm to the top, with a 0.18 mm chamfer over the bottom 0.5 mm. Against
HSW-SPEC §3 — measured off `wall-honeycomb-part.stl`, standard deviation **0.00000 mm** across all
56 cells — the two agree exactly on the 22.0 mouth over 2.0 mm, on the 48° lead-in over 0.9 mm, and
on the 20.0 throat over 4.6 mm. They disagree on the entry flare: the customiser chamfers to 20.36,
the shipped plates measure **20.8 across flats over 0.5 mm**.

The measurement wins, per the standing rule that a source settles a *choice* and never a
measurement. `BORE_PROFILE` in `src/core/honeycomb.ts` is therefore assembled from `constants.ts`
and nothing else, and the four band depths sum to exactly `PANEL_DEPTH` — 0.5 + 4.6 + 0.9 + 2.0 = 8.0
— which `assertProfile` refuses to let drift.

What the customiser IS the authority on is everything a measurement cannot reach, because no shipped
plate has one: where a border cuts, how thick it is, and how it behaves when doubled.

**How we know the generator is right.** It reproduces all seven shipped plates from the constants
alone — volume within **0.0025 %** and bounding box within **0.0004 mm** of the figures `tools/scan.py`
measured off the real files, on every one. `tests/honeycomb-model.test.ts` is that comparison, and it
is the reason a plate nobody has ever printed can be trusted: the ones that HAVE been printed come
out right to five figures. The residual 0.0004 mm is the snapping below, not error.

**Watertightness is not optional and not automatic.** `ROW_STEP` is the designer's typed 20.438, not
23.6·√3/2 (D4), so unit hexagons do **not** tile exactly: the three cells meeting at a corner compute
it about 0.0003 mm apart. Emitted as computed, that is a mesh full of 0.0003 mm cracks — not a solid,
and a slicer will either refuse it or "repair" it into something else. `cornerPositions` resolves
every shared corner to ONE canonical point, keyed on the unordered triple of cells that meet there,
so adjacent cells emit bit-identical vertices and the internal edges cancel exactly. `meshIsClosed`
checks the stronger property — every directed edge has exactly one opposite — which also catches
inconsistent winding, and it compares vertices EXACTLY on purpose: a tolerance there would hide the
snapping failing.

---

## D55 — A border cuts through the cell centre, and Cadcode's asymmetry is kept

> **SUPERSEDED BY D59.** This described the customiser's CUT. The user's own printed
> reference plate does the opposite — it adds material and keeps every cell — so the cut
> was replaced wholesale. Kept because the reasoning about which cells a cut eats is still
> the reason the additive form was worth the rewrite.

A framed edge is not "the honeycomb, plus a rim". Following the customiser, it is a CUT: the
outermost cells are sliced along their own centre line and closed with a wall of the same thickness
and taper as every other wall. Two consequences fall out of that and both matter to the planner.

**It eats cells.** Half a hexagon holds nothing, so those cells must leave the mountable set or the
app offers a socket that will not exist. Which cells is not uniform and cannot be guessed: a left
border eats the whole first column, while a top border eats only the un-staggered half of the top
row — the staggered half sits a full `PITCH/2` lower, so the line runs along its flat and leaves its
bore untouched. `frameConsumedCells` decides it by one rule, measured against the widest band of the
bore: a cell is eaten when its MOUTH crosses the line.

**The wall's inner face lands exactly where a full cell's bore already is.** So a single-thickness
border adds no material at all to the cells it only grazes; only doubling does. If that comes out
wrong the plate still looks right on screen and the frame is 1.8 mm thinner than asked for.

Cadcode is asymmetric about doubling: the top and bottom borders shift the plate's edge OUTWARD by
`WALL_THICKNESS` (its `shift`) so the wall's inner face stays put, while the left and right borders
keep a fixed edge and grow inward. That looks like a leftover — the top/bottom shift carries a
comment describing it as a fix — and it is reproduced rather than tidied, because the point of
matching the reference is that these plates interchange with everyone else's. Recorded here so the
next person does not "correct" it. `tests/honeycomb-frame.test.ts` pins both halves.

---

## D56 — The planner and the printer see a framed cell differently, on purpose

A cell a border has halved is in two states at once: gone, as far as anything that mounts on the
wall is concerned, and still there as far as the printer is concerned. Both are true and the app
needs both.

The cheap resolution — a third cell state, checked everywhere — would mean teaching placement, the
parts list, the fixing plan and both renderers about frames. Instead the frame's cells join the
obstacle's cells in `omit`, which every one of those rules already handles, and exactly one function
puts them back: `panelModelSpec` in `src/core/panelModel.ts`, which is what the generator, the STL
download, the 3D view and the customiser export all go through. Nothing else may reconstruct a
plate's cells. If that function ever stops restoring them, the plate generates with a column of holes
where its frame should be — you would print it and find it had no frame on it — so
`tests/frame-document.test.ts` states it as a measurement: the restored plate has strictly more
material than the un-restored one.

Two more things follow from the frame being a property of the ASSEMBLY rather than of a plate.
`frameLinesFor` takes the line from every panel's cells at once, because four plates along one edge
must be cut on ONE line or the edge comes out stepped. And `panelFrameKey` joins the grouping key
everywhere identical plates are counted — `customPanelGroups`, `computeBom` and the 3D view's
instancing — because two plates with the same relative cut and the border on opposite edges are
MIRROR IMAGES, and grouping them prints one twice and the other never.

---

## D57 — An edge runs between corners `dir` and `dir + 1`, and that is now a function

Deriving the frame needed the answer to "which two corners bound the edge a cell shares with
neighbour `dir`", and checking it turned up the same off-by-one twice more in `WallCanvas`: the
outline of every placed part, and every panel seam, were drawn from corners `dir − 1` to `dir` — one
edge round the hexagon. It is the identical mistake already fixed once in `WallView3D`'s
`unionOutline` (pass 7), and it survived a 704-test suite because it is entirely plausible on screen:
a seam still ran between two plates, an outline still surrounded a part, just along the wrong side of
each cell.

It is now `edgeCorners` in `hex.ts`, with the rest of the lattice semantics, and the test asserts
nothing by hand: the midpoint of the edge must sit exactly halfway between the two cell centres. That
cannot be satisfied by an off-by-one and it needs no written-down expectation.

`WallCanvas`'s `panelIndex` had a related fault, and it is the one that mattered most here: it built
the cell map from `panelCells` on the raw block instead of `placedPanelCells`, so a cut cell was
still drawn. A blocked zone changed the parts list and the 3D view and left the plan showing an
unbroken honeycomb straight through the light switch — the one place the cut most needs to be
visible, since drawing the zone is what you came to the plan to do.

---

## D58 — The plan is where you measure and where you draw what the wall must avoid

A wall is planned against a room and a room is measured with a tape. The app could state the wall's
own size and nothing else: there was no way to ask how far it was between any two things on it, and
an obstacle could only be typed in as four numbers in a side panel — where it was then invisible,
because neither view drew obstacles at all.

Three modal tools now, not modifiers: two of the three are DRAGS on empty wall, and a marquee, a
measurement and a new zone cannot all be "drag on empty wall" at once. Escape always returns to
Select, and drawing a zone returns to Select by itself so the zone can be nudged without hunting for
the tool switch.

Snapping is shared between measuring and drawing, which is the point: a zone drawn by eye lands a
fraction of a cell out, and a fraction of a cell is the difference between cutting one hexagon and
cutting two. `snapPoint` ranks a POINT above a LINE before it considers distance — ranking by
distance alone makes a wall corner unreachable, since standing 3 mm right and 4 mm up from it the
bottom edge is 4 mm away and the corner 5, so the edge takes every pointer and you can never measure
from the corner of your own wall.

The measurement is in the DOM as well as on the canvas. A number painted into a canvas cannot be read
by a screen reader, cannot be selected and cannot be copied into the note you are writing about your
wall — and this is the one number in the app a person actually wants to write down.

**The live gesture is a REF**, written synchronously, exactly as the part drag already was. Held in
state, the release arrived before the render that would make it visible and the whole gesture was
thrown away: every quick flick measured nothing. That is the third time this shape has cost something
in this file, so it is worth stating plainly — anything a pointer builds up between `down` and `up`
belongs in a ref, and the state copy exists only to draw.

---

## D59 — The border ADDS material; it does not cut cells

D55 built the border from `Cadcode.rtf`, which slices the outermost cells along their centre
line and walls off the halves. Then the user supplied a photograph of a printed plate
(`Customiser/borders.webp`) and it is not that at all.

Under magnification the reference is unambiguous: every cell is a whole, open hexagon; the
walls BETWEEN cells run out past the honeycomb to a straight line; and the triangular notches
between the zig-zag outline and that line are filled solid. Nothing is cut. The plate is the
honeycomb plus material on the outside.

The difference is not cosmetic — it is a column of mounting points. A cut border eats the whole
first column of a plate and half the top row; the additive one costs nothing. Given the choice
between matching a reference implementation and matching a reference OBJECT, the object wins,
for the same reason the STLs in `models/` outrank any published description.

**How it is built.** One extra ring: every empty lattice position touching the plate, drawn
SOLID (no bore), clipped to a straight line `thicknessMm` beyond the outermost extent of the
real cells around it. Each phantom works its own line out from its own neighbours, so a straight
run comes out flush without anyone having to find the run first, and a step in an L-shaped plate
follows the step. Local rule, global result — and phantoms are ordinary pieces to the mesh
builder, tiling with their neighbours and sharing their snapped corners, so watertightness comes
free.

**Thickness is now a number, not a switch.** Cadcode offered single or double because a cut can
only be one cell wall or two. An additive edge can be any width, so it is a millimetre field,
bounded by `MAX_BORDER_MM` — one ring of positions can only reach so far, and past that the edge
would come back short without saying so.

**`Top_Border` still travels to the customiser; the thickness does not.** "This edge is closed"
survives the translation between a cut and an addition. The millimetres do not mean the same
thing in both, and emitting a number that means something else is worse than emitting nothing.

---

## D60 — Exactly one plate prints each piece of edge

A position on the outside of the wall can touch two plates at once — the corner where they butt.
Both would grow it, and printed, the two plates overlap by a whole cell and the wall does not go
together. Found by looking at the app: bordered plates came back 20 mm wider than their own
cells, which is one lattice step, which is one phantom claimed twice.

Ownership goes to whichever plate holds the MOST of the position's neighbours — the plate it is
actually attached to. Given to the other one it becomes a tab hanging off a corner: fragile, and
a plate wider than its own block for no reason a reader could see. Ties break on the canonically
smallest neighbouring CELL, a property of the lattice rather than of the panel list, so both
plates reach the same answer without either knowing about the other.

The same walk answers both questions — which edge to build, and which sides to label the plate
with — because they must agree. Labelled from "sides it is near" instead of "sides it owns", a
plate reads "edged bottom" in the parts list while its neighbour prints that bottom edge.

A plate can still legitimately carry a strip reaching one lattice step past its own cells: the
wall's edge is continuous and the plates share it out, so the split lands somewhere. That is
budgeted in `generatedPlateSizes` rather than discovered at the printer — without the allowance
a bordered wall plans plates to exactly the bed and then several of them do not fit.

---

## D61 — Plates are sized to the printer, not taken from the shipped seven

The seven shipped plates were drawn for particular beds, and the largest that fits a 350 mm
printer is a 10 × 10. That printer can hold 16 × 14. Tiling a wall out of shipped files on a big
printer therefore prints two and a half times as many plates, with two and a half times as many
seams, for no reason except that nobody published the bigger file. Now the app can make it.

`plateFootprintMm` is the arithmetic, and it is checked against the shipped plates rather than
against itself — it reproduces all seven from their cell counts alone. The strongest evidence it
is the designer's own formula is that `maxPlateForBed` on the smallest listed bed (180 × 180)
returns exactly 8 × 7, which is `wall-honeycomb-part`.

**Off by default**, and that is deliberate: someone who has already printed a stack of shipped
plates should not have their wall re-planned around plates nobody has tested. It is also NOT
stored on the document — it changes what the next solve produces, and a saved layout already
records what it produced, so storing it would let a reload silently re-plan someone's wall.

A generated plate carries a `generated/` id, which no catalogue entry will ever match. Three
consequences, each of which was a real defect first: `validate` must not report it missing,
`isCustomPanel` must count it as custom so it reaches the download list, and the BOM must cost it
against the biggest shipped plate PER CELL — left to fall through, a wall of generated plates
reported zero print time and zero filament, which looks like an answer rather than like a gap.

---

## D62 — A measurement field holds text, not a number

Reported plainly: "on the measurements i cannot erase the text to 0 making it really hard to type
1000mm".

The cause is the obvious controlled number input:

    <input type="number" value={mm} onChange={e => setMm(Number(e.target.value))} />

`Number('')` is `0`. The zero goes into the document, the document clamps it up to its minimum, and
the field repaints as `50` before the second digit arrives — so typing "1000" over "2400" produces
"501000", or nothing, depending on where the caret ends up. The value is never wrong for long enough
to see; the field simply refuses to be emptied, and there is nothing on screen to explain why.

`NumberField` separates the two things that were conflated. The TEXT being edited is local state and
shows exactly what was typed, including empty. The NUMBER is committed separately, and only when the
text parses AND is in range — so the half-typed "1" on the way to "1000" never resizes the wall to
its minimum. Blur resolves whatever is left: an in-range number commits, out-of-range clamps (by
then it is a request, not a typo), and anything unparseable reverts to what the document holds.

Two things worth keeping:

**The rules are pure functions.** `valueWhileTyping`, `valueOnBlur` and `formatValue` are the whole
feature and are tested without a DOM or a test renderer, which is the same shape as everything else
load-bearing here. The component is the shell.

**The range has one owner.** `MIN_WALL_MM` and `MAX_WALL_MM` are exported from `store.ts` beside the
`clampDim` that enforces them, because the field needs the same range to decide what to commit. Two
copies and the field would refuse a size the document would have accepted, with nothing to say so.

`PartInspector` had already solved this for its six seating numbers and nobody noticed it was a
general problem. It is the third time in this codebase that a rule existed correctly in one place
and wrongly in another; the fix is the same as it always is — extract it, name it, test it.

---

## D63 — The lattice is anchored into the wall, in X only

Reported as "in the plan section the honeycomb is not in the wall edge its shifted", and it was:
the honeycomb hung **13.6255 mm — exactly `MARGIN_X` — off the left-hand edge of every wall**, with
the slack turning up as an over-large gap on the right.

The wall's origin is its bottom-left CORNER, which is what a tape measure reads against. The
lattice's origin is a cell CENTRE. Those are not the same point and nothing said so. `tiling.ts` had
assumed the offset all along — `maxColumnIndex` counts columns from `ROW_STEP·q + MARGIN_X`, and
`maxRowsInBand` from `PITCH·shift + MARGIN_Y` — while `hexToMm` put cell (0, 0) at (0, 0). The solver
and the embedding disagreed by exactly one vector, and had done since the frame turn.

`LATTICE_ANCHOR` in `constants.ts` names it, `hexToMm` adds it and `mmToHex` takes it away. One
place: a translation changes no relative geometry, so rotations, footprints, parity, seams, the
detector and the generator are all untouched — `toAxial` works on differences and never sees it.

**X only, and the asymmetry is the whole subtlety.** In Y the solver can already land the outline on
zero by choosing which row a band starts at: centres sit at `PITCH·(r + q/2)`, the stagger makes
that any multiple of `PITCH/2`, and `MARGIN_Y` IS `PITCH/2`, so `r + q/2 = 0.5` hits it exactly. In X
there is no such freedom — `ROW_STEP·q = MARGIN_X` has no integer solution — so the offset can only
come from the anchor. Anchoring Y as well pushes every band half a pitch up and the top row off the
wall: measured at **8.6 mm over** on a 1200 × 900 wall with plates sized to a 256 bed, caught by
re-measuring rather than by reasoning.

**The test had the bug written into it.** `tiling.test.ts` asserted "keeps every panel inside the
wall rectangle" by adding `MARGIN_X` and `MARGIN_Y` to the bounds before comparing, under a comment
saying "the lattice is anchored so the bottom-left panel's outline starts at (0, 0)" — stating the
intent and then compensating for the code not implementing it. A fudge factor in an assertion is
worth reading as a defect report: it is usually the place where two modules already disagree and
somebody made the test agree with both. The fudge is gone, and `plate-size.test.ts` now checks the
solved honeycomb against the wall on five wall sizes and both plate sources with nothing added.

---

## D64 — The border switch and the zone's measurements belong on the plan

Two controls moved to where the work happens.

**Border, in the plan toolbar.** It had only been in the parts-list rail, which is where you go to
read what to print — not where you are when you decide the wall wants a finished edge. The toolbar
button switches all four sides on at once with the thickness beside it, because "how thick" is the
question asked immediately after "on or off"; the per-side checkboxes stay in the rail for the wall
that runs into a ceiling on one side. `E` toggles it, next to `V`/`M`/`B`.

**A blocked zone's name and size are controls, not paint.** They were drawn into the canvas, which
means they can be looked at and nothing else. A switch plate is 146 × 86 — a number you have written
on the back of your hand and want to type, not a rectangle to drag until it looks about right, and
dragging is how you end up cutting one hexagon too few. Clicking either opens it for editing.

Three details worth keeping:

- The size is **two fields and a separate `×`**, not one "146 x 86" string to parse. A measurement
  typed under pressure should not be able to fail on a separator.
- The tag layer is `pointer-events: none` and each tag takes it back for itself, so the wall
  underneath still drags and marquees normally.
- The tag is anchored to the zone's **corner**, not its middle, because the middle is where you grab
  to move the zone. A tag over it would make a zone you can rename but not move.

It also makes the zones reachable at all without a pointer: painted text has no place in the
accessibility tree, so until now a blocked zone was invisible to a screen reader and its size could
not be copied out.

---

## D65 — The plan draws the border the generator makes, not the honeycomb's outline

Reported as "it now has a border, BUT it follows the honeycomb, i want it to be flat like in the
picture, just straight lines on the border".

The GEOMETRY was already flat — measured: a bordered 5 × 4 plate's mesh reaches exactly
`maxY + MARGIN_Y + thickness` along its whole top, and the STL downloads with that edge. The PLAN
was drawing something else. `borderEdgeSegments` emitted one line per exposed cell edge, which is
the honeycomb's zig-zag, so the picture promised a scalloped edge while the file delivered a
straight one. Two readings of "where is the border", which is the failure this codebase keeps
having.

There is now one reading. `borderPolygons` comes out of `borderPieces` — the same walk the mesh is
built from — and the plan FILLS those shapes rather than tracing an outline of its own. The border
is material, so it is drawn as material.

**The corners needed a second ring.** Where two straight runs meet, the position that squares the
corner off touches no real cell at all: it sits diagonally past the corner one, so the first ring of
phantoms never reaches it. The expansion now repeats until nothing new survives the clip planes.

**The test that would have caught it, and the shape of it.** A border that follows the zig-zag and
one that is flat have the SAME bounding box, so every bounds assertion passed. What separates them
is where the lost area goes: a zig-zag border loses material along every edge, so the shortfall
against a true rectangle grows with the perimeter; a flat one loses only the four corner chamfers,
so the shortfall is a CONSTANT. `honeycomb-frame.test.ts` now measures the cross-section of a 3 × 3
and an 8 × 7 and requires the two shortfalls to be equal. That is a property no amount of
bounding-box checking expresses.

The corners are left very slightly chamfered — about 25 mm² each, a 7 mm nick — because a hexagon
does not tile a square corner exactly. Recorded rather than chased: it is under 2 % of the plate, it
is where a sharp corner would chip anyway, and closing it completely would mean a real polygon union
for a result nobody can see.

---

## D66 — Three things stop a plate being the shipped file, and all three are gates

Reported as "the frames are not flat on the top, just jagged; sides look nice". The geometry was
flat — measured, the top silhouette of a bordered plate is a single straight line at
`maxY + MARGIN_Y + thickness` at every x across it. The 3D wall was drawing the SHIPPED STL.

`WallView3D` short-circuits to the cached mesh when a plate is the stock plate:

    const real = omit.length === 0 && !isGeneratedSize(partId) ? panelMeshes.get(partId) : undefined;

A bordered plate has no cut-outs and a catalogue id, so it passed both tests and the stock file was
drawn — no border, the honeycomb's raw zig-zag on every edge. The plan showed a border, the parts
list said "edged top + left", and the wall showed neither. It only looked like a TOP problem because
the sides of a flat-top lattice zig-zag by 6.8 mm and the top by 11.8: the same defect, twice as
visible along the top.

Three things stop a plate being the shipped file — cells cut out of it, a size the app chose, and an
EDGE — and every gate has to check all three. The first two were already there; the third was added
when the border was, and this one gate was missed.

The lesson is not "check three things". It is that a plate's identity had grown a third reason and
the reasons live in three different modules — `omit` on the panel, the id prefix in `panelModel`,
and the frame on the document. `panelIsBordered` now names the third so a gate can ask rather than
re-derive, and `tests/frame-document.test.ts` states the whole rule: a plate with no cut and a
catalogue id can still not be stock.

**Why no test caught it.** Every check of the border was on the GEOMETRY, and the geometry was right
throughout. The defect was a renderer choosing not to use it. That is the same shape as D50 (the
parts list computed through the store) and D52 (the abandoned mesh in the inspector): the data was
correct and something drew something else. Those are found by looking at the running app, which is
how this one was found too — four for four since the frame turn.

---

## D67 — A measurement whose commit is expensive waits for Enter or OK

Reported as "when i want to change the size of the blocked box i need an OK button or for me to hit
the enter button before the blocked zone size is updated".

`NumberField` commits every in-range keystroke (D62), which is right for the wall size: seeing the
wall resize as you type is the point. It is wrong for a blocked zone. Typing `220` over `146` commits
at `2`, at `22` and at `220`, and each commit runs `setObstacles` — which re-cuts every plate on the
wall, re-derives the parts list, and leaves an undo step. Three re-cuts and three undo steps for one
measurement, and the wall visibly thrashing while you type it.

So the field gained a mode rather than a new component: `commitOn: 'type' | 'confirm'`. Nothing about
the parsing, clamping or formatting changes — `confirm` simply does not call `valueWhileTyping`, and
the existing blur path resolves it. One rule, two schedules.

**Which schedule a field gets follows from what its commit COSTS**, not from what it looks like. The
wall size stays live because the commit is a resize and the feedback is the feature. The zone's size
waits because the commit re-plans the wall. The zone's NAME waits too, for the same reason and no
other — a rename cannot change a single cell, but it goes through `setObstacles` all the same.

**Blur still commits.** Escape drops the edit and OK applies it, but wandering off with a number
typed applies it as well: a measurement silently thrown away is worse than one applied a moment
early, and there is nothing on screen that would explain the loss.

---

## D68 — The border is drawn in the plate's colour, because it IS the plate

Reported as "the border is jagged towards the middle, make it flat on both sides just like the
photo". The geometry had no such edge. The PLAN had painted one.

`drawBorder` filled the border shapes in their own tone, distinct from the plate. That made the band
read as a separate object, and a separate object has two edges — so the eye followed its INNER
boundary, which is the honeycomb's outline stepping half a pitch between staggered columns. It looked
like a jagged edge on the border. There is no edge there at all: a bordered plate is one piece of
8 mm plastic, and the only boundary it has near its rim is where the holes begin.

Filled in the plate's own colour it draws what the reference photograph shows: a flat outer rim, the
honeycomb stopping short of it, and nothing in between to see. A hairline follows the same shapes so
the plate's outer edge stays findable against the wall behind it at low zoom — the same shapes, so
the stroke cannot describe a different edge from the fill.

**Why the top looked worse than the sides, which is worth recording because it is not a defect.**
The wall is flat-top (D31/D35). Along a LEFT or RIGHT edge every cell in a column sits at the same
x, so the outline scallops by `MARGIN_X − PITCH/(2√3)` = 6.8 mm and repeats. Along a TOP or BOTTOM
edge, adjacent columns are staggered half a pitch, so it steps 11.8 mm. Same construction, nearly
twice the amplitude, which is why "sides look nice" and the top did not.

The reference plate is photographed with its rows running along the bordered edge, so its bordered
edges are the 6.8 mm kind. That is an orientation of the photograph, not a difference in the plate:
the wall's flat-top frame is settled against the designer's own dimensioned drawings and is not a
free choice.

Three reports in a row about this border have all been the same shape — the geometry was right and a
renderer drew something else (D65, D66, this). Worth the pattern being written down: when the plan,
the parts list and the 3D view disagree, suspect the drawing before the model.

---

## D69 — The border is a rail of one thickness, and the staggered pockets stay open

Reported three times, and the last time precisely: "the border is jagged towards the middle, make it
flat on both sides just like the photo".

Measured on the render: the border's OUTER edge was already dead flat — a pixel probe found a single
value across the whole width, spread zero. The INNER edge varied by 17 px. Filling everything between
the honeycomb and the straight outer line makes the band `t` thick above one column and `t + PITCH/2`
above the next, because the wall is flat-top and adjacent columns stagger half a pitch along a TOP or
BOTTOM edge. Flat outside, stepped inside — which is what it looked like, and what it was.

**Why the reference photograph does not show this.** That plate is photographed with its ROWS running
along the bordered edge, which is the direction that does not stagger. Our left and right edges are
that direction, which is exactly why they were reported as fine while the top was not. The wall's
flat-top frame is settled against the designer's own dimensioned drawings (D31/D35) and is not a free
choice, so the stagger cannot be rotated away.

That left three shapes, and the user chose. Cutting the protruding half-row flush would give a
perfect rail at the cost of half the cells in the top and bottom rows. Making the border thicker
would hide the step without removing it. **Leaving the pockets open** keeps every cell mountable, and
that is the choice: the top and bottom borders are clipped on the inside as well, so the band is one
thickness, and the half-cell pockets between the rail and the lower columns are simply not filled.

The cost is real and is the reason this was asked rather than assumed: the rail is attached at every
other column rather than continuously, so that edge is easier to snap than a filled one would be.

**Left and right are deliberately NOT clipped.** The notch there is not a missing cell — it is the
6.8 mm scallop between a hexagon's own corner and its flats, inside a single cell's reach. Clipping
it would leave slivers, and filling it is what makes those edges read as a clean rail already.
`tests/honeycomb-frame.test.ts` states all three: every top piece is at most `t` deep, a top rail
adds about `width × t` of material and not that plus a half cell per column, and a side piece is
legitimately deeper than `t`.

---

## D70 — The plan is Y-UP, like the wall and like the 3D view

Reported as "the 2D planner window is not oriented the same way as the 3D". It was not: `toScreen`
mapped wall y straight to canvas y, and canvas y grows DOWNWARD. So the plan drew the same document
upside down against the view sitting next to it — a socket 60 mm off the floor appeared at the top of
the plan and at the bottom in 3D.

The wall's origin is its bottom-left corner, which is what a tape measure reads against, what
`LATTICE_ANCHOR` anchors to (D63) and what `WallView3D` already used. `toScreen` now flips y and
`originY` is the wall-mm y at the BOTTOM of the canvas.

**A y-flip is not a one-line change, because a flipped frame negates every angle written in it.**
Three things had to move with it:

- **Pan and wheel-zoom** invert on y — dragging the pointer down now raises the wall-mm value at the
  bottom edge.
- **Seams and part outlines** were rebuilt from angles in SCREEN space (`cos 60k`, `sin 60k`). Under
  a flip those run the other way round the hexagon, putting every edge one round out — the exact
  defect `edgeCorners` was introduced for (D57), arriving by a different route. Both now take their
  corners from `hexCorners` in WALL space and map them through `toScreen`, which is the right
  structure regardless: the lattice is described once, in the frame it is defined in.
- **`visibleCells`** took `toWall(0, 0)` as the minimum corner. With y up that is the canvas's TOP
  edge and therefore the largest y, so the cull rejected the entire wall. It now takes both corners
  and sorts them.

`addHex` needed nothing: a flat-top hexagon is symmetric about its horizontal axis, so the corner set
is unchanged by the flip.

The mapper is now pinned by `tests/visible-cells.test.ts` — higher wall points sit higher on screen,
the wall origin is bottom-left, and the round trip is exact so a drop lands where it was aimed.

---

## D71 — Parts are shopped for: a library to browse, a rail that holds this project

The rail was the whole catalogue — 51 shipped parts plus every import — and a wall uses about six of
them. Two different jobs were sharing one surface: *browsing*, which wants pictures and room, and
*building*, which wants the short list you are actually working from. The rail could answer neither.
"What am I printing?" was answered by reading the parts list, and "which of these is the hook I
want?" was answered by dragging one onto the wall to look at it.

So they are two places now, and a part moves between them:

- **`PartLibrary`** is the shop. Every part as a card with a picture at a size you can see, plus
  type, cell count, print time and filament; shelves (everything / in this project / my uploads /
  by type), a search box and a sort. One button per card puts the part in the project.
- **`CatalogPanel`** is the rail, and now holds only what was chosen. Which means it answers the
  question it never could: this is what the wall is built from.

**The list is on the DOCUMENT** (`LayoutDoc.library`), not in local UI state. Which parts a wall is
built from is a decision about that wall — it belongs in the file, it travels down a share link, and
it is undoable like every other edit. `projectParts.ts` is the only module that reads the field.

**A PLACED part is in the project whether the list names it or not.** `projectPartIds` unions the two
and everything else goes through it. Without that rule, every layout saved before this existed — and
every share link, and every undo past the point a part was added — opens with a wall covered in hooks
and an empty rail, and the only way back is to find the part in the library again. Placing a part
also adds it to the list, because dropping something straight onto the wall is a way of shopping for
it and the two paths must not disagree.

**An id the catalogue cannot resolve is kept and reported, never dropped.** Load a friend's layout and
it names uploads you have never seen. Dropping those ids would rewrite the document on the way
through; the rail says how many instead. Panels are the one exclusion from the rail: the tiler
chooses those from the wall size and the printer, so "Solve panels" must not silently fill the basket
with seven plates nobody picked.

### Uploading: a photo, and alignment is not optional

**A part may carry a photograph, and the library shows it instead of the render.** A render says what
the mesh is; a photo says what the thing is — printed, in orange PETG, holding four screwdrivers.
Twenty-seven of the 51 shipped parts are named for their fixing rather than their shape, and a shop
whose evidence is a filename is a directory listing. Photos are keyed on part id in their own
IndexedDB store and by nothing else, so a shipped part can have one too and absence is the answer to
"is there a photo" — no flag anybody has to keep true. Downscaled to 640 px and re-encoded before
storing: a phone photo is 4 MB, the quota is shared with the STL bytes the 3D view needs, and what
breaks when it fills is the wall's meshes, somewhere else entirely. Measured on a real import:
3.17 MB PNG in, 6 KB WebP out.

**An import is two steps and the second one cannot be skipped.** Step 1 describes the part (name,
type, fastener, footprint, photo); step 2 is the alignment tool, and the part joins the library only
when that is saved. The detector declines to guess a mounting face for 27 of 51 shipped parts
(PARKED P1) and it can be wrong as well as absent — a part whose face nobody chose sits wrong on the
wall, and the moment it is being added is the one moment somebody is certainly looking at it.
`PartInspector` gained one prop, `intent`, which changes only the labels and lifts the `dirty` guard
on Save: there is nothing to be dirty against on a part that does not exist yet, and the detector's
own answer is a legitimate choice.

The bytes go into IndexedDB *before* step 2 opens, because `meshLibrary` reads an imported part's
mesh from exactly there and the inspector draws the real model. That makes those bytes the only thing
an abandoned import leaves behind, and `cancelImport` sweeps them at either step.

**The alignment is written as an OVERRIDE**, the same record a shipped part's correction gets — one
mechanism, one export, and `Setup (n)` carries an imported part's mounting to the repo like anything
else.

### The bug this uncovered: overrides were applied before the merge

`applyOverrides(shippedCatalog, …)` ran first and the imports were bolted on afterwards, so an
override keyed on a `user/…` id was written, stored, exported — and never applied. You could line an
imported part up, watch the dialog save it, and find it on the wall the way the detector guessed.
Every part now goes through one pipe: `applyOverrides(mergeCatalog(shipped, mine), overrides)`.

Same shape as D50, D52 and D66: two owners of one fact, and the one that reached the screen was the
stale one. It had no symptom until the import flow started depending on it.

### The bug found by looking at the app, and the two more that came out of it

The library opened onto a dimmed page with nothing on it. The dialog was there, 1554 px below the
fold: the scrim's implicit grid track sized to the MAX-CONTENT height of 51 cards — 3971 px in a
1000 px viewport — because the dialog's own `block-size: min(56rem, 100%)` is a percentage against a
track whose size depends on its content, which is cyclic, so the percentage was dropped and the
oversized row was then centred faithfully. A definite track breaks the cycle:
`grid-template-rows: minmax(0, 1fr)`.

**The first write-up of this said the other modals "get away with it because their content is
shorter". That was wrong, and checking it is what found the rest.** Measured at a 480 px viewport:

- **`ImportDialog` was broken and live.** Its footer sat at y=775 in a 480 px window — `Cancel` and
  `Next: line it up` both 295 px below the fold, on a `position: fixed` scrim that does not scroll.
  On a short window an import could be neither completed nor cancelled, in the code path this very
  decision had just made mandatory.
- **`AlignPanel` had already hit it and never diagnosed it.** Its CSS carried a comment saying the
  grid version laid the panel out "BELOW its own fixed parent — a 768 px box reporting `top: 1236`
  inside a container spanning 0–900", called it "a grid sizing interaction not worth unpicking", and
  worked around it with flex. Same mechanism, found blind, papered over.
- `PartInspector` survives it, because a bare `max-block-size: 100%` resolves where the
  `min(46rem, 100%)` next door does not. Surviving by accident is not a property worth keeping.

Three copies of one rule, two of them broken, one of them saved by luck — the repo's signature
failure, in CSS this time. So the rule now exists once, as `.modal-scrim` in `base.css`, and each
backdrop wears the class. A fourth modal cannot get this wrong without deliberately opting out.

### The sweep, and the guard the sweep needed

Writing the bytes to IndexedDB before the alignment step is what lets the inspector draw the real
mesh, and it makes those bytes the only residue of an abandoned import. `cancelImport` clears them on
Cancel — but a closed tab runs no handler, so `sweepOrphans` deletes stored models and photos that no
part claims, once, at startup. Measured on a real browser: it collected two stranded models from
earlier sessions and left the live part's model and photo untouched.

**A sweep is destructive, so it needed a guard that the rest of the module does not.** `loadUserParts`
returned `{parts: [], dropped: []}` both when there were no imports and when localStorage refused to
open — Safari in private mode throws on access. Handing that empty list to the sweep would report
that every model and photo in IndexedDB belongs to nothing, and delete a person's entire upload
history because the metadata hiccuped once. `LoadResult.readable` now separates "nothing stored" from
"could not look", and the sweep runs only on the first. A corrupt or non-list store counts as
unreadable for the same reason; a single junk ENTRY does not, because there the list was read and
that row's bytes really are orphaned.

It also sweeps against the WHOLE catalogue rather than the imports alone. Photos are keyed on part id
and nothing else *precisely* so a shipped part can have one — sweeping against imports would have
deleted it. `orphanedIds` is pure and states all of this in `tests/import.test.ts`.

---

## D72 — 3MF is read as a first-class upload, with no new dependency

"I should also be able to upload .3mf files." The ask is one line; the format is not, and three of
its differences from STL are ways to be wrong that look right.

**No dependency.** `DecompressionStream('deflate-raw')` is a platform API in both browsers and Node,
which is exactly the two places this has to work — the app, and a `vitest` run with
`environment: 'node'`. So `src/core/zip.ts` is a hundred lines of header parsing and nothing else.
The alternatives were worse: three ships `fflate` at `three/examples/jsm/libs/…`, a transitive path
npm may hoist differently and three may move between versions; and three's own `3MFLoader` needs
`DOMParser`, which Node does not have, so it could not live in a module the tests can reach. The
model XML is read with a tag scanner for the same reason, and its limits are stated where it is
defined rather than discovered later.

**Units are the 25.4× mistake.** An STL carries no unit and this app assumes millimetres throughout.
A 3MF DECLARES one, and it is allowed to be `inch`. Read at face value, an inch file gives a part
25.4 times too big — it would not fit the wall, and no number on screen would say why. Every
coordinate is scaled exactly once, on the way in, so that by the time a mesh is a `MeshData` the
question is settled; and a unit the spec does not define is REFUSED rather than assumed to be
millimetres, because assuming is how the failure gets to the printer.

**Transforms are the orientation mistake.** An STL's coordinates are final. A 3MF's are per-object,
placed by `<build><item transform>` and possibly nested through `<components>`. Ignoring them moves
a part and, worse, turns it — and orientation is the one thing this app cannot recover from, because
`detect()` reads the mounting face off whatever geometry it is handed. Composition is child-then-
parent, which is what nesting actually means, and there is a test that distinguishes the two orders.

**Mirroring is the one that looks fine.** A transform with a negative determinant flips handedness,
and a mirrored accessory is a left-hand hook on a right-hand wall — the same class of error the
cyclic axis permutation in `meshLibrary.orient` exists to prevent. Triangles under such a transform
have their winding put back.

The test for that had to be rewritten before it meant anything. The obvious assertion — that
`measureMesh` still reports 1000 mm³ — passes whether the winding is flipped or not, because
`stl.ts` takes the ABSOLUTE value of the volume; and the bounding box cannot help either, since
mirroring a symmetric cube does not move it. The test now computes a signed volume itself, and was
checked by disabling the flip and watching it go red. A test that cannot fail is worse than no test,
because it reads like coverage.

**A 3MF may hold a whole build PLATE**, and there is no way to tell that from a single object
assembled out of components. Merging is right for the second and wrong for the first, so the items
are merged and the fact is SAID: the count comes back from the reader and the import dialog warns.
The person who exported the file knows instantly which they meant; the file does not.

**The bytes stay in the format they arrived in.** An imported 3MF is stored as a 3MF and read back
through the same dispatcher, keyed on `part.file`. Converting to STL on the way in would mean the
bytes in storage are not the file the person chose.

### The seam this moved

`proposePart` is now asynchronous, because a ZIP cannot be inflated synchronously in a browser. The
asynchrony stops at the file boundary: `proposeFromMesh` is the synchronous core, and the
classification, requirement and estimate rules — most of `tests/import.test.ts` — are still a pure
function of a mesh. `parseModelFile` sniffs the leading `PK\x03\x04` before trusting the extension,
because a 3MF renamed `.stl` is common and no STL can begin that way.

`tools/scan.py` and `models/` remain STL-only. 3MF is an upload format here, not a catalogue format.

### Verified, and one bug from doing so

A real shipped model was converted to an indexed 3MF, declared in INCHES, deflated, and dropped into
the running app: it came back 27.554 × 27.792 × 13.589 mm and 2.559 cm³ — the catalogue's own
measurements for that STL, to three decimals — was lined up, added, placed on the wall, and drew its
thumbnail from the stored 3MF bytes through `meshLibrary`.

The bug that run found was in the message, not the geometry: the unit warning said **"Drawn in
inchs"**, because it pluralised by appending an s. English plurals are irregular and the spec's unit
names are American, so there is a name table now, and it says millimetres like the rest of the app.

---

## D73 — A part is placed at the BOX CENTRE of its cells, not their mean

Reported as "the space on the wall alignment does not match the 3D viewer". It did not, and the
alignment dialog was innocent: it was faithfully copying the wall, and the wall had the same error.
The two agreed with each other and both disagreed with the geometry, which is why nothing looked
wrong until somebody opened an asymmetric part.

`meshLibrary.orient` centres a part's geometry on its own wall-plane BOUNDING BOX. Four separate
places then positioned that mesh at the MEAN of the cells it covers — the placed item in
`WallView3D`, the fastener drawn under it, the hover outline, and the inspector's wall patch. A mean
is pulled toward wherever there are more cells; a box centre depends only on the extremes. They are
the same point for a symmetric footprint and different for anything else.

On `insert-hollow-tre` — cells (0, 0), (0, 1), (1, 0), an L — the gap is **3.406 mm**, so the part
was drawn a seventh of a cell off the holes it plugs into, everywhere it was drawn. Only one shipped
footprint is asymmetric enough to show it, which is exactly why it survived: every other part in the
catalogue passes either convention.

`cellsCentreMm` in `hex.ts` is now the single answer, beside `cellsBoundsMm`. The panel path already
did the right thing by hand — `(block.minX + block.maxX) / 2` — and now goes through the same
function rather than being a fifth copy that happens to agree.

**The test states the geometry, not the call.** "Does this module call the right helper" is a test of
the code as written; what was wrong here was a fact about millimetres. So
`tests/part-centring.test.ts` takes every WALL-CLIP part — the ones whose silhouette really is their
cells — orients its mesh, places it the way a view places it, and requires the gap at each edge to
mirror the gap opposite. Measured across all 17 the gap is 0.63 mm in x and 0.55 mm in y, identical
for every part, which is the plate margin. Insert-fed parts are excluded and the reason is stated:
their footprint is a bound rather than a measurement (PARKED P1) and their geometry legitimately
overhangs it — `shelf-4`'s tray reaches 80 mm past the cells it hangs on.

The file also pins the defect itself: under the old mean-based centring `insert-hollow-tre`'s two
gaps sum to −6.81 mm instead of zero. Without that case the suite would be green in a world where
the bug was never fixed.

## D74 — The cells are chosen on the alignment step, and only there

The import asked "which cells does this part take" twice: once in `ImportDialog` with a footprint
editor, and again one click later in `PartInspector` with the same editor. The first is the worse
place to ask, because there is nothing to answer it against — a hex grid on its own. On the
alignment step the identical editor sits beside the part shown against a real patch of wall, which
is the only view in which "does it cover that cell" is a question a person can see the answer to.

So step 1 is what the part IS — name, type, fastener, photograph — and step 2 is where it GOES. The
dialog lost a column with the editor and is now a single one.

`withFootprint` is still called on confirm, with the cells unchanged: the TYPE can change on step 1,
and the wall-mount count and the panel block are derived from it. Re-stating the same cells
deliberately does not clear `needsReview` — only an actual edit turns a bound into a decision, and
that rule is what keeps the flag honest.

## D75 — No photograph means the render, shown rather than described

The photo slot was an empty grey box with an icon in it, which asks "is this required?". It now
shows the part rendered from its own model — the same picture the library falls back to — so the
answer to skipping it is visible in advance rather than discovered in the gallery afterwards.

That needed the model's bytes in IndexedDB one step earlier than before: `meshLibrary` reads an
imported part's mesh from there, and the render is `thumbnailFor` through the ordinary path rather
than a second renderer. Nothing else about the part is written at that point, so `cancelImport` still
has exactly one thing to undo, and `sweepOrphans` still catches a tab closed mid-import.

---

## D76 — `LATTICE_ANCHOR` was counted twice when re-centring a plate mesh

Reported with a screenshot of the alignment stage: the gold socket rings straddled the honeycomb's
walls instead of sitting in its holes. Measured, the offset was **13.6254664 mm — exactly
`LATTICE_ANCHOR.x`**, which is `MARGIN_X`, two thirds of a column. This is D63's class again: the
anchor applied where a DISPLACEMENT was wanted.

`hexToMm(c)` is `M·c + LATTICE_ANCHOR`. Adding two of its results — or adding one to a quantity that
already carries the anchor — counts the anchor twice. Both places that re-centre a
bounding-box-centred plate mesh did precisely that:

- `WallView3D` translated the stock instance by `hexToMm(origin) + cellsCentreMm(blockAt00)`, and
  both terms carry the anchor;
- `PartInspector` positioned its wall patch by `-mid - (hexToMm(anchor) - blockCentre)`, in which
  `mid` and `blockCentre` cancel their anchors against each other and the bare `hexToMm(anchor)`
  leaves one behind.

**Why it survived: every plate is wrong by the same amount.** The honeycomb stays perfectly
continuous, so nothing about the wall looks off. Only something drawn at the TRUE lattice position
reveals it — a placed part, a fixing, a socket ring — by appearing to sit between holes rather than
in them. The reporter saw it in the alignment dialog because that view puts a part and a plate side
by side at high zoom, which is the one place the two frames are visible at once.

The generated and drawn plate paths were never affected. They build geometry in lattice coordinates
and translate by `hexToMm(origin)` alone: one anchored quantity, used once. Only the stock-STL path
needs re-centring, because `orient` has already moved the mesh to its own bounding-box centre.

The fix removes the arithmetic rather than correcting it. A stock plate is now placed at
`cellsCentreMm(panelCells(origin, columns, rows))` — the centre of the block at its REAL origin,
which is one anchored quantity used as one absolute position and cannot double-count anything. The
inspector's patch is placed relative to `at({q: 0, r: 0})`, the same helper every cell in that group
is drawn with, so the plate and the cells are anchored by the same call.

**The assumption underneath is measured, not asserted.** Placing a plate by its centre only works if
its material is symmetric about its cell block. It is: the oriented mesh comes out 170.317 × 177.000
against a block of exactly 170.317 × 177.000, and `tests/plate-alignment.test.ts` checks that for all
seven shipped plates rather than trusting HSW-SPEC §4.

**The test states geometry and was checked against the old code.** For every shipped plate, from five
different origins, every one of its cells must land on `hexToMm` of the wall cell it represents, to
1e-9. Reverting the placement rule fails 8 cases; the fix passes all of them. It also carries the
general rule as a case of its own — a difference of two `hexToMm` results is anchor-free, a sum
carries two anchors — because that is the mistake worth recognising next time rather than this one
instance of it.

---

## D77 — The border round a blocked zone is clipped to the ZONE, not to the honeycomb

Reported as "the blocked zone with border gets really bugged and does not get a clean border like
the outer edge". Two faults, one on top of the other.

**`outwardOf` asks which side of the ASSEMBLY a piece is beyond, and a hole is beyond none of them.**
So a hole's pieces were given no inner clip at all — the rule that makes the outer band a rail of one
thickness (D69) never fired — and each was emitted as a whole solid hexagon. The rim of an aperture
was a ring of lumps.

Clipping them against the cells they lean on fixes the straight runs and not the corners: a piece
with real cells on both sides of its own centre has no side to face, so no plane fires and the
hexagon survives whole. Measured on the reported case — an 86 × 86 switch on a 500 × 400 wall — that
still left **369 mm² of plate inside the switch's own rectangle**. Not a complaint about a ragged
edge: it is plastic where the switch goes, and the plate would not sit flat on the wall.

**The deeper fault is that a hole had no straight line to clip to.** The outer edge has one — the
assembly's own bounds — and that is exactly why four plates down one side come out flush. A hole had
only the honeycomb's stepped rim, because a cell is cut the moment it CLASHES with a zone, so the
aperture is always bigger than the zone and lands on no line at all.

So the generator is now told the line. `BorderSpec.keepClear` carries the blocked-zone rectangles,
each already grown by its clearance so the border keeps off exactly what the cells keep off, and a
hole piece is pushed to the side of the rectangle its own centre is already outside. Measured after:
**0 mm² inside the switch.**

**The corner is deliberately under-filled.** "Hexagon minus rectangle" is an L, an L is not convex,
and this generator has no polygon boolean anywhere by design (D59) — a border is half-planes and a
convex polygon clipped by one stays convex. A piece at a corner therefore takes both planes and keeps
only their intersection, giving up the two arms. Material missing from a corner costs nothing;
material left in the aperture costs the print.

**And the rail does not stretch.** It is `t` thick measured from the honeycomb, so where the cut left
the cells further than `t` from the zone the aperture stays wider there — straight where the rail
reaches, stepped where it does not. Wider is the safe direction and the test says so rather than
pretending otherwise.

The test that matters is an AREA, not a distance. The first version measured how near a border vertex
came to an edge of the zone and reported 19.79 mm, which sounded alarming and meant almost nothing —
a legitimate 3.6 mm rail lying along the boundary scores that too. Sampling the border polygons on a
0.5 mm grid and asking how many square millimetres fall inside the rectangle is the question actually
being asked, and it is paired with a case proving the same hole is NOT clear when the generator is
told only about cells, so the check cannot pass by drawing nothing.

## D78 — A blocked zone is not drawn in 3D

It was a red slab the size of the zone, standing 5 mm off the wall, on the argument that you need to
see whether a part is about to sit on one. It was the biggest object on the wall and it was opaque,
so it hid the very thing it pointed at: the cut plates, the edge raised round them, and any part near
the zone. The one view where you can check that a border came out clean round a socket was the view
that covered it up — which is how D77 stayed unexamined.

It also says nothing the wall does not. The honeycomb is CUT there: the hole IS the zone, at its own
size, and nothing can be dropped in it because there are no cells. A marker that duplicates an
absence is noise laid over the answer. The plan view still draws zones with their names and sizes,
which is where they are positioned in the first place.

---

## D79 — A zone-facing border piece is filled SOLID to the zone, not railed to the honeycomb

D77 stopped the border printing into a blocked zone and it still looked wrong, which is the report
that followed: "still not a good looking border".

Reproduced before touching anything — the aperture's edge was a **staircase**. A rail is `t` thick
measured from the honeycomb, and a cell is cut the moment it CLASHES with a zone, so the aperture is
bigger than the zone by up to a whole cell. Where the cut happened to fall close the rail reached
the zone's line and the edge was straight; everywhere else it stopped at the honeycomb's own
hexagonal steps. Straight in places, scalloped in between, which is worse than uniformly scalloped
because it reads as damage.

So a piece that meets a zone is not railed at all. It is drawn SOLID and clipped only to stay out of
the zone. The material between the last cell and the switch is plate, which is what it is on a plate
you would cut by hand, and the aperture is then the zone rectangle exactly: one straight line per
side, all the way round. It costs no cell — the pieces are empty POSITIONS, so a rim cell's own
mouth is untouched and still mountable.

The outer edge keeps its `t` rail (D69), and so does a hole belonging to no zone — a step, or the gap
where a plate does not reach. Those have no straight line to fill out to and inventing one would be
guessing.

**The corner is an L, and an L is not convex.** Taking both of the zone's half-planes at once keeps
only their intersection and leaves a notch at each corner of the aperture. Instead the hexagon is
split along the zone's own vertical edge into two convex pieces that meet on a line and do not
overlap: everything left of it is outside the zone whatever its height, and everything right of it
needs only the horizontal plane. No polygon boolean, and the two halves share a face exactly the way
two neighbouring border pieces already do.

## D80 — A blocked zone is a UNION OF RECTANGLES, not a polygon

Asked for custom-shaped zones. The representation is a list of rectangles, and that is a geometry
decision rather than a UI one.

The border generator clips convex pieces with half-planes and has no polygon boolean anywhere by
deliberate design (D59). A rectangle hands it four half-planes directly. An arbitrary polygon would
have to be decomposed before it could be clipped against at all, and a CONCAVE one — which is the
whole point of a custom shape — cannot be clipped against in one piece. A union of rectangles keeps
every clip convex, covers the shapes people actually have (an L round a consumer unit, a T for a
pipe with a spur), and leaves every zone drawn before it valid and unchanged.

**One reader.** `obstacleRects` is the only thing that looks at `shape`, and `cellClashes`, the
border's `keepClear` and the plan's drawing all go through it. Two readers is how the cells get cut
to one shape and the border clipped to another.

**The bounding box is kept and is NOT what gets blocked.** `xMm/yMm/widthMm/heightMm` stay as the
shape's extent, because the tag on the plan reads them and the resize handles grab them. Blocking by
them would eat the hollow of an L — which is honeycomb the user deliberately kept, and which
`zoneHit` also has to fall through so a click there reaches the wall.

Consequences that had to be handled rather than discovered: a shaped zone is MOVED through
`moveZone`, which shifts the parts with the box — writing x/y alone would leave a zone blocking
where it is not drawn. A part that fails to parse is dropped rather than taking the zone with it,
the same salvage rule the rest of `persist.ts` follows. And `shape` is omitted from the JSON when
absent, so every layout saved before this round-trips to the bytes it always had.

**Shift-drag with the Blocked-zone tool adds a rectangle to the selected zone**, rather than a third
tool. It is the same gesture on the same tool and the only thing it needs to say is "this one goes
with that one"; a separate mode would have to be entered, and its target chosen, before the drag
started.

**Not done:** a shaped zone cannot be resized by its handles, only moved, renamed and added to.
Resizing a bounding box has no single meaning for an L — the arms could scale, or the box could
stretch and the arms stay — and guessing would be worse than the handles doing nothing.

---

## D81 — Cells a zone eats are PRINTED, cut; the planner still treats them as gone

`inner box.jpeg` — a printed plate with a light switch through it — settles what the inside edge of a
blocked zone should look like: a straight aperture closed by a thin, even wall, with the open cells
running right up to it. The cut goes THROUGH the cells, leaving partial hexagons.

We removed any cell a zone touched and filled the gap with border. That gave a straight aperture with
an apron behind it up to a WHOLE CELL deep, hexagons paved over and showing through as bumps. The
band swung from nearly nothing to ~23 mm depending on where the lattice fell against the switch.
Straight, and nothing like the plate.

**The two views of the plate diverge here, and that is the point.** `panelModelSpec` now returns the
eaten cells separately as `clipped`, and it is the one place allowed to know this (D56). The PLANNER
goes on treating them as gone — a cell a switch passes through is not somewhere to mount anything, so
it must not be counted, offered or fixed into, and `cells` is untouched so the parts list, the file
name and the fixing plan all see what they saw before. The PLATE gets them, cut off flush.

**Every ring of a clipped cell is cut by the same half-planes** — the outline and all four bore
levels. That is what keeps the mesh watertight: two neighbouring cells that both meet the zone are
truncated identically along their shared edge, so the edge still cancels and no wall is drawn inside
the solid. Verified on a real case: 30 clipped cells, 5 714 triangles, 0 unmatched edges.

**The inner skin needed a new merge.** It paired bore ring j with ring j+1 by INDEX, which is exact
while every level is the same hexagon at a different size. A clip breaks that — one level can lose a
corner the next keeps — so the strip folded through itself. `addSkirt` merges by bearing instead, the
same argument `addAnnulus` already makes for a flat cap, stood on its side. A bore cut past its own
cell centre would break that argument's precondition, so those cells print SOLID.

**A corner cell keeps its arm, as a solid offcut.** At a zone's corner, hexagon-minus-quadrant is an
L. Taking both planes keeps only their intersection and bites a notch out of every corner of the
aperture — which was the last thing visibly wrong with it. A border piece is split along the zone's
edge into two convex halves (D79), but a CELL cannot be split that way: its bore would split with it,
and two half-bores meeting on that line would grow a membrane across the hole. So the cell keeps the
whole side facing the zone's edge — outside the zone at any height — and the arm beyond it is filled
by a SECOND, SOLID piece at the same position, under its own key. Solid costs nothing: the offcut is
a sliver in one cell's outer margin, where a hole would do nothing anyway. The two pieces share their
straight edge and cancel there, the way two neighbouring cells already do.

### Three faults this uncovered, none of them in the new code

- **The reach test used the wrong radius.** Deciding whether a border piece meets a zone used the
  MOUTH's corner radius (12.7 mm) where a piece is the whole cell (13.6 mm). Pieces overlapping a
  zone by up to 0.9 mm were skipped, leaving a rail lying in the aperture.
- **An OUTER piece never checked `keepClear` at all.** A zone can overrun the plate's edge — a switch
  near the top of the wall — and the rail along that edge ran straight through it. Outer pieces now
  take the zone planes on top of their rail clip, and one whose centre is INSIDE a zone is dropped
  outright: there is no side of the zone to push it to, so it is in the aperture.
- **With the frame off there are no zones to clip against**, so a clipped cell would be drawn whole
  and fill the aperture solid. No zones now means the eaten cells are not drawn at all, which is
  exactly what a plate without a frame has always been.

Each was found by measuring the mesh rather than reading it — counting vertices that fall inside the
zone rectangle, and isolating the source by rebuilding the plate with the cells, the border and the
clipped cells switched off in turn.

---

## D82 — The aperture wall is a rail of `t`, the same as the outer edge

Reported as "the border thickness should be the same as the outer edge and should have no jagged
edges". Both came from the same thing.

Cells were cut flush at the zone (D81) and the band between was filled solid. That made the wall
whatever happened to be left of each cell: thick where the cut fell in the web between two bores,
paper-thin where it grazed one, and RAGGED where it clipped a bore open onto the aperture — a hole
half-cut is a scallop, not a wall. The outer edge meanwhile is a rail of exactly `thicknessMm`, so
the two did not match either.

Cells are now cut back to the zone **grown by `t`**, and the band between the zone and that line is
filled. The wall is then bounded by two straight, parallel lines a fixed `t` apart: the same rail the
outside of the plate gets, with nothing left to be jagged. Where the cells end is exactly where the
rail begins, so the two meet on one line and the join is internal.

The rail's inner line is the zone, which is what keeps the aperture the size that was blocked out.
Its outer line is `zone + t`, which is where the cells stop. Both are properties of the zone
rectangle rather than of the lattice, which is why the result no longer depends on where the cut
happens to fall against a bore.

`tests/zone-aperture.test.ts` states it as containment: every border piece belonging to an aperture
lies inside the band, so nothing reaches into the zone and nothing extends past `t`. The older test
that compared the plate's mass against a "paved" version was DELETED rather than adjusted — the
comparison had stopped meaning anything, because the border is now bounded to the band in both
arms of it, so neither one paves. A test whose baseline has quietly become the same as its subject
is worse than no test.

---

## D83 — The cut cell prints the aperture wall; the border keeps off

D82 said the wall round a blocked zone is a rail of `t`, the same as the outer edge, and split the
job in two: the cells the zone ate were cut back to `zone + t`, and the border filled the band
between the zone and that line. The cutting happened. The filling never did.

A border piece only ever grows on a lattice position the plate has left EMPTY — that one rule is
what stops a border appearing on a seam — and every position round an aperture is a position the
plate prints as a CUT CELL. So the pieces that were supposed to fill the band were dropped as
overlaps by the very guard that keeps a partial cell and a phantom from being printed twice, and the
band was planned by one half of the design and printed by neither.

The result, measured on an 86 × 120 switch, was the opposite of what D82 claimed:

| | intended | actual |
|---|---|---|
| aperture, each side | the zone | `zone + t`, and up to 10.0 mm out where a cell was dropped whole |
| wall thickness | `t` (3.60) | 0.00 to 26 mm |

The 0.00 is a bore left open onto the aperture — a cell sliced through its own hole — which is
exactly the ragged edge D82 was written to remove. It was invisible to the tests because they asked
about *border polygons*, and there were none: `expect(round.length).toBeGreaterThan(0)` passed on
pieces belonging to the plate's outside that happened to fall in the band.

So the wall is now the cut cell's own material, and the cut takes TWO lines instead of one:

- the **outline** is cut at the zone rectangle, so the aperture is that rectangle exactly — one
  straight line per side, wherever the lattice happens to fall against it;
- the **bores** are cut at the zone grown by `t`, so between the aperture and the nearest opening
  there is `t` of solid plate.

One piece of geometry owns that edge and nothing has to meet anything. It also settles the case the
two-owner design could not: across a seam the plate that would grow the border piece and the plate
that prints the cell are not even the same plate, so the band would have been printed twice. The
border's zone-filling branch is deleted; a hole belonging to no zone — a step, a gap where a plate
does not reach — keeps its reach rail, and an OUTER rail still clips against a zone that overruns
the plate's edge.

Two smaller things fell out of it.

A cell whose CENTRE lands inside the zone used to be dropped whole, and what it took with it was the
sliver of itself lying outside the zone — which is wall. That is where the 6.2 mm and 10.0 mm bites
came from. It now keeps that sliver, on the nearest side: a hexagon 27 mm across cannot poke out of
opposite sides of a switch, and the side it pokes out of most is the side the wall is on. Its bore
line falls beyond its own centre, so the piece prints solid, which is right — it is all wall.

And the watertightness argument changed shape without weakening. It used to be "every ring of a
clipped cell is cut by the same half-planes"; it is now "the outline cut is a function of the ZONE
alone", which is the part that was ever load-bearing — two neighbours truncate identically along the
edge they share, so it still cancels. Bores are private to a cell and may differ freely.

`tests/zone-aperture.test.ts` no longer asks about polygons. It slices the finished mesh at the
plate's own face and runs scanlines across it, which is the only way to state "the wall is 3.6 mm"
as a number: where the plate stops on each side of the aperture, how thick it is there, and — the
request as it was actually made — that the same measurement taken on the OUTSIDE of the plate gives
the same answer. Both halves were checked by breaking them deliberately and watching the tests go
red.

---

## D84 — The border is part of the plate, not lying next to it

Reported as "two loose 3.6 mm squares at the corners". Pulling on it found three defects stacked on
one another, all of the same shape: geometry that TOUCHES but does not JOIN. Every one of them left
the mesh watertight — a closed mesh can be several closed shells — so the whole suite stayed green
while a bordered plate came off the printer in pieces.

**The corners.** A lattice position outside the plate on TWO sides is a corner, and it was given both
rails and handed their intersection: a `t × t` square at the very corner, touching neither run. Both
rails' own material at that corner — the last `MARGIN_Y` of the side band, the first `MARGIN_X` of
the top one — belonged to that same position and went with it. Two of the four corners came off (the
stagger is chiral; at the other two the corner falls on a position that is outward on one side only).
A corner now takes NEITHER rail. It is solid out to both its lines, which is what a plate's corner is.

**The sides.** Railing the left and right to a uniform width was a mistake, and the reasoning behind
it was sound about the wrong thing. It made the band the same width the whole way round; what it did
not ask is what the honeycomb offers there to hold on to. A column of flat-top cells reaches its
straight outer line at ONE POINT per cell — the hexagon's corner — and along no edge at all, so a
uniform strip beside it is a comb hanging off a chain of points. Measured: the left and right strips
were separate solids from the honeycomb on every plate that had them.

A side is filled to its line again, as the reference plate in `Customiser/borders.webp` is and as D68
described before D69 was extended: the band beyond the envelope is still exactly `t`, and the 6.8 mm
scallop between two cells' corners is solid rather than open. The visible width therefore varies on
the left and right and not on the top and bottom, and that is not a defect that can be designed away
— **a straight outer edge, whole cells and a constant visible width are three things a hexagon
lattice will give you two of.** The border's *specification* is unchanged and is honoured everywhere:
`t` past the honeycomb, on all four sides and round every aperture.

**The floating point, which was the real one.** A rail's line is `cellCentre ± MARGIN`, recomputed;
the corners it is meant to land on come out of `cornerPositions`, which averages three cells to snap
them. The two agree to about 3e-15 mm and the sign of the disagreement is decided by rounding. Tested
exactly, one end of a shared edge then reads as outside its own rail line and the other as inside,
and Sutherland–Hodgman interpolates the cut between distances of ±1.8e-15 — which lands it at
`t = 0.5`, the MIDDLE of the edge. The piece comes out with a spurious vertex halfway along a face it
shares with a cell; that face never cancels against the cell's; a wall is drawn between two solids
that are touching. On plates that rounded the wrong way the entire top or bottom rail printed as a
loose strip the width of the plate, and nothing said so.

`clipConvex` now counts a point ON a plane as inside, to within `SAME`, and `cutEdge` snaps a cut
that lands within `SAME` of an endpoint onto that endpoint. Both planes here are axis-aligned with
unit normals, so the tolerance is a real distance in millimetres. It is the same rule
`cornerPositions` exists for, one level up: anything matching vertices by coordinate on this lattice
has to snap first.

**What the tests were missing.** `meshIsClosed` was doing its job and answering a different question.
`tests/honeycomb-frame.test.ts` now asserts the top face is ONE connected component, joined by shared
EDGES and never by shared vertices — the distinction is the whole finding, since a by-vertex test
calls a point-contact comb attached. Swept over sizes, because every failure was parity-dependent and
a single size passes by luck: five side combinations × seven block shapes, all one solid.

Left unfixed and worth knowing: where the stagger puts a half-cell pocket at a corner, the side band
stops one pitch short of the outer line rather than turning it square. That is the open pocket of D69
seen end-on, it costs about 3.6 × 15.4 mm at one corner, and it neither detaches anything nor reaches
past any line. The test states the bound it actually holds to — the band runs the full height of every
cell in the outer column — rather than a rounder claim that is false.

---

## D85 — A band ends where the PLATE does, not where its own neighbours do

Reported as "the outer edge is jagged". It was, on two sides: measured on a bordered plate, the
silhouette stepped in by up to **30.8 mm** on the left and right, at two of the four corners. The top
and bottom were straight to the bit. Which two corners depended on the block, because the stagger is
chiral, so a single plate size could look fine.

The reach is the rule that makes this border work: a phantom takes its lines from the cells it leans
on, which is what sets the band's thickness to `t` and what makes an L-shaped plate step in exactly
where its cells step in. Local rule, global result. It is the right rule ACROSS a band and the wrong
one ALONG it, and the flat-top lattice guarantees a wrong end: the outermost COLUMN sits half a pitch
short of its neighbour, so the side band stopped `t` past the last cell of its own column while the
plate — whose bounds are set by the taller neighbouring column, and whose top rail spans the full
width — carried on above it. The silhouette fell back to whatever hexagon was next, and near the top
of a cell that is its 6.8 mm corner-to-flat, hence 30.8 rather than 11.8.

So a band that runs in Y now takes its Y limits from the plate's own straight lines, and one that
runs in X takes its X limits from them; each still takes the ACROSS direction from its reach, so the
thickness rule and the L-shape rule are untouched. Only where that side is switched on — with no top
edge there is no top line to run to.

It cannot run away, and that is worth stating because a ceiling that big looks like one that could.
A piece is bounded by its own hexagon, which reaches half a cell past its centre, and the ring walk
never puts a centre more than one step from a real cell. The lines are a ceiling, not a licence to
grow: the growth guard is unchanged, so no new positions are created, and the inside of an L stays
empty.

`tests/honeycomb-frame.test.ts` measures the silhouette off the finished mesh — sliced at the plate's
own face and scanned, so a step of any depth anywhere along a side comes out as a number — over six
block sizes, and requires zero drift on every edged side. Reverted, it reports 30.7 mm.

---

## D86 — A cut bore is still a hole

Reported as "make the outside of the inner border hollow and not fill in the honeycombs". Round a
blocked zone the plate came out with a ring of PAVED hexagons behind the aperture wall, where the
printed reference (`inner box.jpeg`) has open ones running right up to it.

It was D81's own guard. Having gone to the trouble of printing the eaten cells cut rather than
dropping them — precisely to remove an apron — it then printed any cell SOLID as soon as the cut
passed that cell's centre, on the reasoning that the inner-skin merge "needs both rings to wrap that
point". Every cell whose centre falls inside a zone's rail is such a cell, so the apron came back one
ring thinner and nobody noticed, because the tests asked about the WALL and the wall was correct.

The reasoning was about the wrong point. `addSkirt` and `addAnnulus` both merge their two rings by
bearing around the INNER RING's own centroid, not the cell's centre — and a convex sliver always
contains its own centroid, while the levels are all cut by the same planes so the smaller ring stays
inside the larger. Nothing ever needed the cell centre. The guard is gone; a ring with fewer than
three points is still solid, because there the cut really did take all of it.

`tests/zone-aperture.test.ts` states it as a fraction: most of the way along each side of the
aperture the plate must stop within a rail and a cell wall. Paved, it collapses — with the guard put
back the right-hand side measures ZERO scanlines that thin, against 0.4 required.

---

## D87 — The plate's edge is a CUT on the cell centres, not a band added past them

**Superseded:** D59's "the border ADDS material and costs NO cells", and with it the whole phantom
apparatus — D69's top/bottom rail, D84's filled sides and cornerless corner, D85's band ends. The
CLOSED section below is the report this answers.

Four passes tried to make a straight edge out of material added beyond the honeycomb, and each one
produced a different wrong shape: a comb on the sides, a scallop on the top, loose blocks at two
corners, a notch at the other two, a ballooned corner. Every one of them was a different guess at the
same missing material, and the reason there was a guess to make is in the lattice rather than in any
of the rules:

**The honeycomb's own silhouette reaches the outermost cell CENTRES everywhere along a side, and no
further.** Two cells in a column meet at a flat that is `MARGIN_X − PITCH/2` = 6.81 mm short of their
corners; adjacent columns stagger half a pitch, so along a top edge one column reaches `maxY + 11.8`
and the next only `maxY`. Past the line `bounds` there is no continuous material to clip — so
everything out there had to be invented, and no local rule can invent it consistently at a corner.

On the line there is nothing to invent. The plate is now cut exactly the way an aperture is (D83),
with the zone's complement replaced by the plate's own rectangle:

- the cells' OUTLINES are clipped at `bounds` — the plate's edge;
- EVERY bore is clipped `t` inside that, so between the edge and the nearest opening there is `t` of
  plate.

Measured on the mesh, the plate's box then equals the cell-centre rectangle to 1e-9 on all four
sides at every thickness from 0.4 to 6.8 mm, and the rim is exactly `t` at its thinnest on every
side. The corner is square because two clips are two half-planes and their intersection is a corner;
there is no third rule.

**What it cost, and why the number 26.7 is the whole argument.** The old edge was a ring of solid
hexagons clipped to a straight line, so between two cells of the outermost column — where their flats
meet and there is no hole — the plate ran **26.7 mm** deep before the first opening, against a
`MARGIN_X + t` of 17.2. That is a whole extra cell of plastic, and it is what "the border looks
chunky" meant every time. The cut costs the outer RING instead: those cells come out as open half
hexagons, nothing mounts in one, and they leave the planner through `omit` exactly as a switch's
cells do (D56). `borders.webp` refused that trade; `inner box.jpeg` makes it at its aperture, and the
outside of a plate is the same edge.

**The measurement that was missing, which is the CLOSED report's own conclusion.** There was no test
of the band's WIDTH anywhere — every border test measured the bounding BOX, which cannot tell a `t`
rim from a `t` rim with a cell of solid behind it. `tests/plate-edge.test.ts` slices the plate and
runs scanlines: never deeper than `MARGIN + t`, never thinner than `t`, and exactly `t` at its
thinnest. It reads 26.7 on the old geometry and 9.5 on this one.

**Two things about the scanline, both of which cost a wrong answer first.** The lines are ANCHORED ON
CELL CENTRES and swept across one cell's span, because a line landing on a hexagon's flat or through
a corner vertex registers no crossing there — `(a − at)(b − at) < 0` is false when an endpoint is on
the line — so two runs merge and the band reads as most of the plate. Stepped blind from the bounding
box that happens somewhere on every plate: it reported 274 mm on a 12 × 11. And the CORNER cells are
left out, because a scanline there crosses the perpendicular band and measures both at once.

**Three faults fell out of the change, none of them in the new geometry.**

*The first line was wrong.* Cutting outlines at `bounds + t` and bores at `bounds` also gives a `t`
rim and reads correctly on a straight run, and it is what the patch this started from did. It leaves
the top scalloped `t` deep between columns and steps the side in **12.1 mm** at every corner, where
that side's own column has no cell high enough to reach the line. Same shape as every earlier
failure: a line the honeycomb does not reach.

*The ring left the planner and never arrived at the printer.* `omit` is how a cut cell leaves the
planner and `panelModelSpec` hands the omitted cells to the generator as `clipped` — which the
generator only ever cut against a ZONE. With a border and no zones there was nothing to clip them
against and they were dropped: every plate came out one whole ring short on each bordered side, still
watertight, still passing every geometry case in the suite, because each of those builds a spec by
hand and none goes through the store. A cut cell is now cut by everything that cuts it, so the two
routes into `clipped` compose instead of one cancelling the other.

*And the edge walked inward.* `assemblyIndex` took its BOUNDS from the cells that survive `omit`, so
switching a border on cut the ring, the bounds followed the ring inward, and the next edit cut a ring
that had already gone. Bounds now come from the whole BLOCK while `occupied` still comes from what
survives it: they answer different questions — "how far does the plate reach" against "is this
position filled" — and an omitted cell still PRINTS.

**The plan had to be taught, because the edge is no longer something the border walk can describe.**
`borderPolygons` returns nothing for the outside now, so the plan drew a wall a ring smaller than the
file. `plateEdgeShapes` gives it the cut cells and what is left of their mouths, off the same
`plateEdgePlanes` the mesh is built from — one rule, because the plan showing an edge the plate does
not have is this repo's most repeated bug (D65, D66, D68).

**And two pieces of prose became false.** The Frame panel still said "It costs you no cells", and the
parts list said "cut round an obstacle" for every bordered plate, because that reason fired on `omit`
being non-empty and the edge now fills it. The two reasons share one field and are told apart by
asking which cells the edge took.

---

## CLOSED by D87 — the corner of the band balloons, and none of the three rules tried is right

Visible on any bordered plate: along its runs the band is `t`, and at each corner it swells into a
lump about a cell across, with the neighbouring cells cut into wedges around it.

A corner position is outward on two sides at once, and three rules have been tried for it:

1. **Both rails, intersected** — keeps only the `t × t` square where they cross, touching neither
   run. Two of the four corners printed as loose blocks (D84).
2. **Neither rail** — fixed that, and is what ships. The piece keeps its whole hexagon, so the
   top/bottom rail swells from `t` to a half cell at its ends. This is the balloon.
3. **The union, as an L** split along the side band's own line, each arm at its own width. Correct
   in width, and it DETACHES on small plates: a 2 × 2 comes out as three solids.

What the measurements do and do not cover is the lesson here. `has a STRAIGHT outline` and `is ONE
solid` both pass on rule 2 — a ballooned corner is straight-edged and connected — so the suite was
green while the plate was visibly wrong. **There is no test of the band's WIDTH near a corner**, and
that is the missing guard: measure the band along all four sides INCLUDING the last cell at each end,
and require `t` throughout. Write that first; it fails on rule 2 and on rule 1, and it is what will
tell rule 3's successor from another near miss.

The left and right bands being filled (D84) makes the corner worse than it reads on paper, because
the two bands meeting there are different widths to begin with.
