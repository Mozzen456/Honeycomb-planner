# GOAL

Do a full rundown of the project and check every alignment, then actually plan a complete wall in
the app end to end. If the result looks like the reference photographs and everything lines up —
cells, parts, inserts, panel seams — it is done. If it does not, keep going until it does. The
decisive test is the picture, not the test suite: the suite already passes while the app draws the
wall 90° from the designer's own drawings.

## Done when

- [ ] The app draws the wall **flat-top**, matching every reference photograph — proof:
      `src/core/hex.ts` `hexCorners` starts at `60·i` (not `60·i − 90`), and
      `wall-honeycomb-part` measures **170.32 wide × 177 tall** (today: 177 × 170.3171, i.e. 90° out)
- [ ] `FITTING_SEAT_RADIANS` no longer exists — it was only ever compensation for the wrong frame
      (D31/D33) — proof: `grep -c FITTING_SEAT_RADIANS src/ui/WallView3D.tsx` returns 0 (today: 5)
- [ ] A full wall is planned in the running app — panels solved, accessories placed, inserts and
      junctions drawn — and a screenshot shows cells, parts and seams all on the same lattice —
      proof: screenshot in this session + `npx vitest run tests/acceptance.test.ts`
- [ ] Every part's orientation agrees across catalogue, both detectors, and the drawings — proof:
      `npx vitest run tests/detect.test.ts tests/panel-parity.test.ts tests/mounting.test.ts
      tests/fitting-seat.test.ts tests/customiser.test.ts`
- [ ] The rundown is written: what each module does, what is measured vs assumed, what remains open
      — proof: `HSW-SPEC.md` §11 exists and every open item in it appears in `PARKED.md`
- [ ] `npm test`, `npm run typecheck`, `npm run build` all clean, and `scan.py --verify` shows
      **zero geometry differences** (the slicer-hash lines are environmental — see Environment)

## Constraints

- The STLs in `./models/` are the authority on every measured number. A source settles a *choice*,
  never a measurement.
- Never hand-edit `src/catalog/catalog.json`. Corrections go in `src/catalog/overrides.json`.
- `ROW_STEP` stays `20.438`; `allowRotation` stays `false`. The stagger stays chiral — it flips
  meaning under the frame turn, so `panel-parity.test.ts` is the guard, not a formality.
- Never clear `needsReview` on a bounding-box bound. Picking a mounting face (D34) does not promote
  a bound to a measurement.
- A fixing belongs to one part. A part and the thing it requires must never both claim it.
- A failing `critic-*` test may pin a defect on purpose. Check the underlying bug first.
- Turning the frame is a rotation, never a reflection — a mirrored plate is invisible until printed.
  Both bases must have determinant `+PITCH·ROW_STEP`.

## Environment (checked 2026-08-13)

- `npm` needs `. ~/.nvm/nvm.sh` first — Node v24.19.0 installed but not on the default PATH.
- System `python3` has no trimesh. Use the venv at `<scratchpad>/hswvenv/bin/python`.
  PrusaSlicer 2.9.6 present.
- **`--verify` cannot be byte-identical on this machine and that is environmental.** All differing
  lines are the PrusaSlicer profile hash plus four `minutes` values differing by ≤0.02. Zero
  geometry differences. "Geometry clean" is the passing bar.
- The browser pane cannot drive drag-and-drop (synthetic pointer events fail `setPointerCapture`).
  Drive the app with dispatched `KeyboardEvent`s and the catalogue tile's Enter-to-place (D32).
- Do not commit `build/` — its diffs are pre-existing CRLF and prior local runs.

## Worklist

- [ ] **P9a — turn the lattice. This is the whole objective; everything else is downstream.**
      **THE TRANSFORM IS NOW PINNED BY DATA — do not re-derive it, and do not "simplify" it.**

          relabel:   (q, r)  ->  (-r, q + r)
          embedding: x = ROW_STEP * q,  y = PITCH * (r + q/2)
          panelCells: build along q, stagger -floor(q/2)   [was -ceil(r/2)]
          margins:   MARGIN_X <-> MARGIN_Y  (11.8 is the half-flat, 13.6254664 the half-corner)
          corners:   hexCorners starts at 60*i, not 60*i - 90
          FITTING_SEAT_RADIANS deletes itself

      How it was pinned, so nobody has to guess again:
      - `(q,r) -> (r,q)`, the obvious swap, is a **MIRROR** (det −1, verified numerically). It is
        the invisible-until-printed error. Both `(r,−q−r)` and `(−r,q+r)` are true rotations.
      - Both rotations give the designer's `170.32 wide × 177 tall` for `wall-honeycomb-part`
        (app today: 177 × 170.32), so the bounding box CANNOT choose between them — they differ
        by 180°.
      - Panel parity chooses: generating the block in the new frame and comparing against the
        relabelled stored footprints, **`(−r,q+r)` + `floor` matches all 7 panels**;
        `(r,−q−r)` + `floor` matches 6 and fails on exactly `mk3s` — the panel CLAUDE.md flags as
        needing a 180°. The canary worked.
- [ ] **Re-express every stored `footprint` in `catalog.json` by the pinned relabel** — all 51
      parts. This is a lossless data migration, NOT a rescan: it needs no PrusaSlicer, so the
      committed `print`/estimate blocks and their provenance survive untouched and this machine's
      slicer hash is never baked in. `tools/footprint.py` and `src/core/detect.ts` must emit the new
      labels too (CLAUDE.md: two detectors, they must agree).
- [ ] **Plan a full wall in the app and photograph it.** The acceptance test proves the numbers;
      only the screenshot proves the picture. Compare against the PDF drawings and
      `Customiser/network_wall` photograph.
- [ ] P1a — footprints for the 27 `needsReview` parts. The PDF sourced their fasteners but says
      nothing about which cells an installer uses. The D34 inspector now gives a human route for the
      mounting face; the cells still need a source. Groups: shelves (4), hooks (8), boxes/holders
      (8), covers (3), wrench holders (2), misc (2).
- [ ] Write the rundown into `HSW-SPEC.md` §11 — measured vs assumed, module by module.
- [ ] Not actionable, record only: P2 (375×389 fits no listed bed — a measurement), P4 (one slicer
      profile), P6 (untested surfaces), P9 residuals (imported print estimate ±30 %, phone layout).

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
