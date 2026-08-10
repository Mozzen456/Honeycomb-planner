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
