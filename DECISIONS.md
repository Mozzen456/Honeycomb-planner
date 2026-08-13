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
