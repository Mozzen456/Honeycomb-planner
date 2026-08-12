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

**RESOLVED for imported parts, and half-resolved for shipped ones.** The "define footprint" mode
described here now exists: drop an STL on the window and the import dialog shows every measured
number, says which are bounds, and lets you click the cells the part really occupies. Accepting the
proposal does *not* clear the flag — only an actual edit does, so a bound is never promoted to a
measurement by a click (DECISIONS D24).

What it does not yet do is write a correction for one of the 29 **shipped** parts back to
`src/catalog/overrides.json`, because a browser cannot write into the repo. Correcting one of those
still means editing `overrides.json` by hand — or importing the same STL and drawing its footprint,
which gives you a usable part immediately but a modelled print estimate rather than the sliced one.

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

## P7. RESOLVED — the suite is green

**394 tests pass, `tsc --noEmit` is clean.** This section previously recorded 16 failures left
behind after a round of critic fixes. They have all been reconciled: expectations that encoded
deliberately-changed behaviour were recomputed by hand from the current catalogue, findings that
were fixed were inverted into regression tests, and findings that are still open are pinned to the
current behaviour with a message telling a future fixer to invert them.

One genuine defect surfaced during that reconciliation and is now **fixed** — see D20: an accessory
and the insert it required *both* claimed the same bolt, so one M3 hole bought two M3 bolts. That
is D11's double-count class reappearing in a new place, which is why the guard against it is now
general rather than specific to the wall screw.

<details><summary>What the failures were (kept for the record)</summary>

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

</details>

---

## P8. RESOLVED — the critics' open defects are closed

All six are fixed, and each pinned test has been inverted into a regression test rather than
deleted. `npm test` is **467 passing** (was 394).

| # | Was | Now |
|---|---|---|
| 1 | `checkPlacement` accepted coordinates `persist` refuses (±1e9) | `addItem`, `moveItems` and `duplicateItems` clamp against `MAX_CELL_COORD`, the same 1e7 limit `persist.readCoord` uses. One constant, two modules. |
| 2 | Nothing reserved cells for a panel's wall mounts | `validate` emits `no-room-for-mounts` when a panel's free cells are fewer than the fixings it orders. The count is read from the panel's own `requires[]`, so the warning and the order cannot drift apart. |
| 3 | `needsReview` never reached a BOM line | `BomLine` carries `needsReview` and `estimated`; the CSV has two new columns, the checklist and the printable sheet spell them out in words. |
| 4 | `crosses-seam` was in the `Issue` union but never emitted | `validate` calls the tiler's own `crossesSeam`, so a layout that arrives by file or share link is advised exactly as a drop is. |
| 5 | Bulk placement was quadratic-ish | The occupancy map is cached on the immutable items array and *extended* across an append instead of rebuilt. Measured: 0.129 ms/item at 2000 items → **0.004 ms/item**, and flat against 200. |
| 6 | CSV per-unit columns divided the rounded line total | `BomLine` carries the catalogue's per-unit figures; the exporter reads them. 54.63 stays 54.63. |

---

## P9. Design defects found by the blind design critic

The critic's verdict was that it would pick this out as the amateur in about two seconds, and that
the tell is the top bar. It also found the app **unusable below 1088 px** — which matters, because
the brief asked for it to work on a tablet.

**Fixed since:**

1. **The top bar's buttons.** `base.css` strips every `<button>` and expects a `.button` component
   that no file defined, so `Solve panels` was a 73 × 19.5 px unpadded block beside 32 px rounded
   inputs. That component now exists in `App.css` and the bar consumes it. *(This was the critic's
   "two seconds to spot it" tell.)*
2. **The catalogue rendering no parts below 1088 px.** The shell capped the rail height but never
   told the panel inside to fill it, so its scroll area collapsed to 37 px. The narrow layout now
   sizes the panel to the rail and lays tiles out as horizontally-scrolling columns; a second
   breakpoint at 46 rem stacks the parts list under the wall. **Caveat: the rules are verified
   present and well-formed, but the display here would not resize below 3440 px, so the narrow
   layout has not been seen rendered.**
3. **Panel width owned twice.** The grid now uses the same `--panel-width-*` tokens the panels do,
   and the shell slots no longer draw their own borders. Measured after: rail and panel are both
   240 px, where they were 272 and 240 with two parallel rules between them.
4. The colliding corner text — the shell-level hint is gone; each view owns its own.
5. Focus ring and `.app__name:focus` → `:focus-visible` with the standard ring; the primary button
   offsets its ring outward so it is not accent-on-accent.
6. The wall dimension inputs and printer select now take `--text-primary` instead of inheriting
   tertiary grey from their label.
7. `--space-1-5`, which was referenced but never defined.
8. Canvas hierarchy (the plate is now drawn, seams quietened), theme repaint, clipped wall inputs.

**Also fixed since, and the narrow layout has now been seen rendered:**

9. **The canvas empty state** exists: a three-step start card over the empty wall, which also says
   an STL can be dropped anywhere. It is `pointer-events: none`, because the stage under it is a
   drop target and a panel dropped on the words has to land.
10. **The containment bug was worse than a phantom gutter.** `documentElement.scrollHeight`
    measured 3326 against a 900px window, and clicking or tabbing to a catalogue tile scrolled the
    whole app so the top bar left the screen. `contain: layout paint` on both scrolling panels —
    not `strict`, which implies `size` and collapses the grid track.
11. `.bom-export` and `.app__import` now consume `.button`, which is the only definition of button
    chrome left in the app. The 12 px / 13 px disagreement is gone with them.
12. `.visually-hidden` is defined once, in `base.css`.
13. **The tablet layout was broken in a way the CSS review could not see.** Rendered at 1024 px,
    the top bar overflowed and pushed `Solve panels` and the 3D/Plan toggle off the end — the
    primary action in the product, invisible on the device the brief named. The bar now wraps.
    Also: two-line part names were cropped through the second line, and the keyboard hint ran
    underneath the Fit/Front buttons.

**Still open:**

- **The app draws the wall pointy-top; the photographs show it flat-top.** HSW-SPEC §2 makes
  pointy-top the canonical frame, and the panel size formula confirms the STLs are drawn that way.
  But every reference photograph of a *mounted* part — the SD-card holder in the designer's own
  gallery, the shelf seen from behind — shows a **flat-top** plug going into the wall, with the
  part's slots pointing straight up. Those two cannot both be right.

  It matters because a flat-top plug in a pointy-top cell is 30° out, and 30° is not a multiple of
  60°, so no legal rotation reconciles them: with the wall drawn pointy-top, an SD-card holder's
  slots can only ever point 30° off vertical. `src/ui/meshLibrary.ts` therefore draws the part the
  way it is used — slots up, plug in — and accepts that its hexagon reads 30° off the cell drawn
  under it. That is the visible symptom of this, not a bug in the transform.

  Resolving it properly means turning the app's whole lattice frame, which touches `hexToMm`,
  `panelCells`, the tiler, the parity test and both renderers. It should be measured first: photograph
  a hung panel square-on and see whether the cells have a vertex at the top or a flat edge.
- **The print estimate for imported parts is ±30 %, and ±50 % on unusual geometry.** It is a model,
  not a slice, and it is marked as one everywhere it appears. The residual is concentrated in one
  place: a large flat plate still comes out ~47 % slow, because nothing cheaply computable from a
  mesh distinguishes long fast extrusion lines from short fiddly ones. Two attempts at a feature
  that would are recorded in DECISIONS D28. Anyone wanting a real number should slice the file.
- **A phone is cramped.** At 375 px the wall gets about a third of the screen once the bar, the
  catalogue strip and the parts list have theirs. Nothing is broken or hidden, but planning a
  garage wall on a phone is not a thing this layout makes pleasant.

None of these were token-layer failures — `tokens.css` is sound and its contrast is measured. They
were all places where the shell had been assembled without consuming it.

---

## P6. What I did not test

Honest gaps, so nobody assumes coverage that is not there:

- **Real touch hardware.** Touch is handled through Pointer Events with `touch-action: none` on the
  canvas and coarse-pointer target sizes, and it is exercised with synthetic pointer events — but
  not on an actual tablet. Multi-touch pinch-zoom in particular is unverified.
- **Browsers other than Chrome.** Nothing used is Chrome-specific (Pointer Events, Path2D,
  `ResizeObserver`, `MutationObserver`, `TextEncoder`, IndexedDB, `contain`), but Firefox and
  Safari were not opened.
- **A slow or offline model fetch.** The 3D view falls back to the measured box when a model
  cannot be fetched, and that path is exercised by removing the file — but not against a slow
  connection, and there is no spinner on an individual part.
- **A huge imported STL.** Measurement runs on the main thread; the largest shipped model
  (19k triangles, 928 KB) takes about 20 ms to measure and 400 ms in the worst detector case. A
  million-triangle scan would block the tab for noticeably longer, and nothing yet moves that work
  to a worker.
- **Printing for real.** The print page is verified to be self-contained, to carry `@media print`
  rules and `break-inside` protection, and to be legible — but no paper came out of a printer.
