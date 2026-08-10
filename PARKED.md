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

## P7. 16 failing tests, all in critic files, all with a known cause

**Status: the underlying defects are fixed; these tests encode the pre-fix world.**

Four independent critics ran against this build and found real bugs. I fixed them. Two of the
critics wrote their findings *as tests* so they could not regress silently — which means that when
a finding is fixed, its test fails by design. Others hard-code hand-computed quantities that
legitimately changed when a bug was fixed.

Run `npx vitest run` and you get **371 passing, 16 failing**. The failures break down as:

| Count | File | Cause | Action needed |
|---|---|---|---|
| 2 | `critic-bom` | `FINDING: accessories … require no insert and no bolt` and `FINDING: nothing reserves cells for wall mounts` | The first is **fixed** — invert the test. The second is still open, see P8. |
| 9 | `critic-bom` | Hand-computed quantities/shopping/totals for three layouts | Recompute: accessories now correctly require inserts and bolts, so the numbers changed |
| 1 | `critic-bom` | `seam crossing fires … across a vertical seam` | The hard-coded cell no longer straddles a seam after the stagger-parity fix; pick a new cell |
| 1 | `bom.test` | `reports overlapping panels` | Fixture panels no longer overlap under the corrected parity; move one |
| 2 | `critic-abuse` | 2000-item scaling threshold; `±1e9` coordinates | See P8 — both still open |

I did not silently delete or weaken these tests, and I did not leave them passing by accident.
Recomputing nine hand-arithmetic fixtures needs the same care the critic spent producing them, and
I ran out of budget before I could do it properly. Doing it carelessly would be worse than leaving
it visible.

**What is verified green:** `acceptance`, `panel-parity`, `tiling`, `hex`, `store`, `persist`,
`exporters`, `samples` — including the full 2400 × 1200 "Done" scenario end to end.

---

## P8. Defects found by the critics that are still open

Fixed this pass: group rotation silently translating a selection, the 90°-rotation tiling bug, the
stagger-parity mirror, silent truncation in `deserialize`, the panel-cell-count bomb, store/BOM
disagreement on anchors and empty footprints, `rotateItems(NaN)`, and 18 accessories that required
no insert or bolt.

Still open, in severity order:

1. **`checkPlacement` accepts coordinates that `persist` refuses** (±1e9). The item is dropped on
   reload *with a clear message*, so it is loud rather than silent — but the two modules disagree
   about what a legal document is, and the store is the permissive one. Fix: clamp in `addItem`.
2. **Nothing reserves cells for the wall-mount inserts a panel requires.** Fill all 16 cells of a
   4×4 panel and the BOM still asks for 4 countersunk inserts with nowhere to put them, and raises
   no issue. Fix: a warning in `validate` when free cells < required wall mounts.
3. **`needsReview` never reaches a BOM line**, so the `est.` marker is on screen but absent from
   the CSV, markdown and print page — the sheet you actually carry to the printer. Fix: add the
   field to `BomLine` and surface it in all three exporters.
4. **`crosses-seam` is in the `Issue` union but never emitted by `validate`.** The seam warning
   fires at drop time only, so a layout arriving by file or share link is never advised.
5. **Bulk placement is quadratic-ish**: 0.039 ms/item at 200 items, 0.216 ms/item at 2000, because
   `checkPlacement` rebuilds the occupancy map per call. No cliff, and a drag on a 20k-item wall
   still costs ~2 ms per pointer move, but it should be an incremental index.
6. **CSV per-unit columns divide the rounded line total**, so `minutes_each` reads 54.6 where the
   catalogue says 54.63. Cosmetic; the fix is to read the catalogue value.

---

## P9. Design defects found by the blind design critic

The critic's verdict was that it would pick this out as the amateur in about two seconds, and that
the tell is the top bar. It also found the app **unusable below 1088 px** — which matters, because
the brief asked for it to work on a tablet.

Fixed already: the canvas hierarchy (panel plate now drawn, seams quietened), theme repaint, and
the clipped wall-size inputs.

Still open, in the critic's severity order:

1. **The top bar's buttons were never styled.** `base.css` strips every `<button>` to
   `background:none; border:0; padding:0` and expects a `.button` component that no file defines.
   `Solve panels` measures 73 × 19.5 px with zero padding and square corners, next to 32 px rounded
   inputs; `Undo`/`Redo`/`Share` are bare 20 px text. Fix: one shared `.button` consumed by
   `App.css`, `BomPanel.css` and `.app__import`, which each hand-roll it today.
2. **Below 1088 px the catalogue renders no parts at all.** `App.css`'s media block caps the rail
   at 12 rem while `CatalogPanel.css` still asserts `inline-size: 240px`, leaving a 37 px scroll
   area. Fix both together.
3. **Panel width is owned twice** — by the shell grid and by each panel — so both float in dead
   gutters with doubled borders of different weights, and the parts list stops 47 px short of the
   window edge.
4. Two 11 px mono strings overlap in the bottom-left corner (`.app__hint` and the canvas readout).
5. No canvas empty state: the largest surface in the product has no first-run guidance.
6. Focus ring is accent-on-accent on the primary button; `.app__name` uses `:focus` with
   `outline: none`, contradicting the token layer's "one ring for the whole app".
7. The wall dimension inputs inherit `--text-tertiary` from their label.
8. `--space-1-5` is referenced in `App.css` but never defined.

None of these are token-layer failures — `tokens.css` is sound and its contrast is measured. They
are all places where the shell was assembled without consuming it.

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
