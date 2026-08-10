# Honeycomb Planner

Lay out a Honeycomb Storage Wall on a real hex grid, and get back an exact list of everything
you have to print.

The grid is not decorative. Every position in the document is an axial hex coordinate derived
from the actual meshes in `./models/` — 23.600 mm cell pitch, 20.438 mm row step, measured to
within 1.8 × 10⁻⁴ mm across all seven panels. See **[HSW-SPEC.md](HSW-SPEC.md)** for how, and
**[DECISIONS.md](DECISIONS.md)** for why each call was made.

---

## Run it

```bash
npm install
npm run dev
```

Then: set your wall size, pick your printer, hit **Solve panels**, and drag accessories on.

```bash
npm test          # 180+ unit tests over the pure engines
npm run typecheck
npm run build
```

## Rebuild the catalogue

The catalogue is **generated, never hand-written**. Drop more STLs into `./models/` and:

```bash
python tools/scan.py            # measure new/changed files, append
python tools/scan.py --rescan   # re-measure everything from scratch
python tools/scan.py --verify   # rebuild and diff against the committed catalogue
python tools/report.py          # human-readable summary
```

Requires `trimesh`, `scipy`, `shapely`, `rtree`, `numpy`, and PrusaSlicer for print estimates
(it finds `prusa-slicer-console.exe` automatically; without it, estimates are marked stale
rather than guessed).

Anything the scanner cannot confidently classify lands in **[UNKNOWN.md](UNKNOWN.md)** with its
evidence. Correct it in `src/catalog/overrides.json`, keyed by part id — the scanner reads that
file and never writes it, so your correction survives every future rescan.

---

## How it is put together

Everything load-bearing is a pure function over an immutable document, tested without a browser.
The UI is a thin shell on top.

| Module | Does | Tests |
|---|---|---|
| `src/core/constants.ts` | the measured geometry, and nothing else | — |
| `src/core/hex.ts` | axial hex math, rotation, occupancy | `tests/hex.test.ts` |
| `src/core/tiling.ts` | panel tiling solver, seam detection | `tests/tiling.test.ts` |
| `src/core/bom.ts` | parts-list aggregation and validation | `tests/bom.test.ts` |
| `src/core/store.ts` | commands, placement rules, undo/redo | `tests/store.test.ts` |
| `src/core/persist.ts` | save/load/share, hostile-input tolerant | `tests/persist.test.ts` |
| `src/core/exporters.ts` | CSV, markdown, print page | `tests/exporters.test.ts` |
| `src/ui/tokens.css` | the design token layer — nothing else defines a colour | see `TOKENS.md` |

Two rules the whole thing depends on:

1. **Position is always a hex coordinate.** Pixels exist only inside the renderer and the
   pointer handlers, and never enter the document.
2. **The document is immutable.** Every command returns a new one, which is what makes undo a
   list of snapshots rather than a reconstruction problem.

---

## What the app enforces

- **Overlap is refused at drop time, with a visible reason** — never silently allowed and
  discovered after printing.
- **Off-panel is refused**, and distinguished from overlap ("hangs off the panel edge — 2 cells
  unsupported" is a different problem from "overlaps USB-holder").
- **Seam crossing is flagged, not blocked.** An accessory spanning two panels is the classic HSW
  mistake, but sometimes it is fine — so you get told, and you decide.
- **Groups move and rotate as one rigid body.** If any member cannot land, none of them move.

## Keyboard

| | |
|---|---|
| `R` / `Shift+R` | rotate selection 60° |
| `Ctrl+D` | duplicate |
| `Ctrl+G` / `Ctrl+Shift+G` | group / ungroup |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `Ctrl+A` | select all |
| arrows | nudge one cell |
| `Delete` | remove |
| `Alt`+drag, middle-drag | pan |
| wheel / pinch | zoom |

---

## Known limits

- **29 of 51 parts are second-tier** — they bolt or plug into an *insert* rather than clipping to
  the wall. Geometry can measure how wide such a part is but cannot know which cells its
  installer will use, so their footprints are bounding-box estimates, flagged in the UI and in
  `UNKNOWN.md`. Correct them via `overrides.json`.
- **`375x389-fixed.stl` needs a 400 × 400 bed.** It fits none of the common printers.
- Print estimates are for one specific recorded profile (`PLA-0.20mm-15pct-2perim-0.4nozzle`).
  They are real slices, not volume guesses, but they are not *your* profile.
