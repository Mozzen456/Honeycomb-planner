# PARKED

Things I could not finish, or finished only partly, with what I tried. Nothing here is blocking
the app; everything here is a known, bounded limitation rather than a surprise waiting to happen.

---

## P1. 29 of 51 parts have a bounding-box footprint, not a measured one

**Status: not a bug, but not a measurement either. Documented, flagged in the UI, correctable.**

The HSW model set is two-tier, which is not obvious from the outside:

1. Inserts clip into wall cells (20.0 mm throat / 22.0 mm mouth).
2. Accessories attach to *inserts* — bolted (M3/M4/M5) or plugged into the insert's own hexagonal
   socket (13.4 mm standard, 18.5 / 16.5 mm on the hollow family).

Tier-1 parts are measured exactly: the detector gates on the bounding box decomposing onto the
lattice, then reads which cells are filled from the mating silhouette. All 7 panels and all 15
inserts/fasteners come out right, including a 4-cell diamond that its filename does not describe.

Tier-2 parts carry **no HSW wall interface on any axis** — no 22.5 mm flange, no 19.7 mm body. I
tried three approaches and all of them are fundamentally unable to answer the question:

- clustering concentric features → invents cells for a plate with three bores in one cell;
- silhouette-vs-hexagon area matching → a plain rectangle is ~70 % coverable by hexagons, so boxes
  and shelves false-positived as 3–4 cell wall parts;
- bounding-box decomposition → correctly *rejects* them, which is the honest answer.

The reason none of them work is not that the detector is weak. Geometry can say how wide a shelf
is; it cannot say which cells its installer will put its inserts in, because **that is a choice,
not a feature**. So those parts get an upper bound from the bounding box (longest edge ÷ 20.438 mm
row step), are marked `needsReview`, are listed in `UNKNOWN.md`, and are shown in the app with an
`est.` marker.

**What to do:** correct any of them in `src/catalog/overrides.json`, keyed by part id. The scanner
reads that file and never writes it, so a correction survives every rescan.

**What I would do with more time:** offer a "define footprint" mode in the app — drop the part, then
click the cells its inserts occupy, and write the result straight to `overrides.json`. That turns a
measurement problem into a two-click authoring problem, which is what it actually is.

---

## P2. `375x389-fixed.stl` fits none of the printers in the brief

Measured 374.70 × 389.40 mm. The brief listed Prusa Mini, 220 × 220, 235 × 235, 256 × 256 and
350 × 350; it fits none of them, and needs a 400 × 400 machine. The app therefore lists its
`fitsBeds` as `["bed400"]` only, and the tiler will not choose it for any smaller bed.

Not fixable from this end — it is what the file measures. Flagged rather than fudged.

---

## P3. The community "~42.58 mm across a two-hexagon span" is unreconciled

Nothing in any of the 51 files measures 42.58 mm. Measured two-cell spans are **46.418 mm**
(diagonal) and **46.100 mm** (axial). The nearest quantities in the geometry are 2 × 20.438 =
40.876 and 20.438 + 22.0 = 42.438, neither convincing.

I checked it against the pitch, the row step, both hexagon profiles, the flange envelope and the
panel margins. It corresponds to none of them. Recorded in `HSW-SPEC.md` §9 and left alone: the
files win, and inventing a derivation would be worse than admitting I do not have one.

Similarly unreconciled but less consequential: the community "28 cells" for the 170 × 177 panel,
where two independent methods both say **56**.

---

## P4. Print estimates are one profile, not your profile

All 51 parts are sliced with **PrusaSlicer 2.9.6** at `PLA-0.20mm-15pct-2perim-0.4nozzle`, and the
profile hash is stamped into every catalogue entry so the numbers are reproducible and a re-slice
at different settings is visibly a different profile.

They are real slices, not volume guesses. They are still not *your* settings. Re-slice with
`python tools/scan.py --rescan` after editing `PROFILE` in `tools/slicer.py`; the cache keys on the
profile hash, so changing it correctly invalidates every estimate instead of silently mixing two.

**Supports** are a stated mesh heuristic, not a slicer verdict (facets within 45° of straight down,
excluding the bed face; recommended above 20 mm² and 2 % of area). The raw overhang area is on
every part so the call can be audited. A second slice with supports enabled would give a truer
answer and would roughly double scan time; I judged the heuristic good enough to flag and not good
enough to quote a support-material mass, so it does not quote one.

---

## P5. Assembly direction is described with its evidence, not asserted

The geometry says unambiguously that the insert enters from the throat side and snaps into the
mouth: a 19.7 mm body through a 20.0 mm throat, barbs at 20.735 mm landing exactly where the bore
opens to 21.3–22.0 mm, and a 22.5 mm flange too wide to recess into the 22.0 mm mouth.

What geometry cannot tell me is which physical face the builder turns towards the room. Nothing in
the BOM depends on it, so the app does not claim it. Reasoning and evidence are in DECISIONS.md D7.

---

## P6. What I did not test

Honest gaps, so nobody assumes coverage that is not there:

- **Real touch hardware.** Touch is handled through Pointer Events with `touch-action: none` on the
  canvas and coarse-pointer target sizes, and it is exercised with synthetic pointer events — but
  not on an actual tablet. Multi-touch pinch-zoom in particular is unverified.
- **Browsers other than Chrome.** Nothing used is Chrome-specific (Pointer Events, Path2D,
  `ResizeObserver`, `MutationObserver`, `TextEncoder`), but Firefox and Safari were not opened.
- **Printing for real.** The print page is verified to be self-contained, to carry `@media print`
  rules and `break-inside` protection, and to be legible — but no paper came out of a printer.
