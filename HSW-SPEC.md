# HSW-SPEC — Honeycomb Storage Wall geometry, measured

Every number in this document was measured from the meshes in `./models/`. Nothing was taken
from a Printables description, a forum post, or memory. Where a widely-repeated community figure
disagrees with the files, the files win and the disagreement is recorded (§9).

Reproduce everything here with:

```
python tools/inventory.py        # raw bbox / volume / format for all 51 STLs
python tools/analyze_panel.py    # hexagon recovery + whole-panel lattice fit
python tools/profile_depth.py    # resolves the stepped bore, band by band
python tools/fit_constants.py    # least-squares fit of the lattice constants
python tools/outline_shape.py    # exact panel boundary vertices
python tools/survey_holes.py     # circle fits + the units proof
python tools/scan.py             # builds src/catalog/catalog.json
```

---

## 1. Units

**Millimetres.** Proven, not assumed — see DECISIONS.md D1.

| File named | Measured bore (circle fit) | Standard metric clearance | Match |
|---|---|---|---|
| `insert-with-M3` | **3.19 mm** (resid 0.0026) | M3 → 3.2 | ✓ |
| `insert M4` | **4.19 mm** (resid 0.0027) | M4 → 4.2 | ✓ |
| `insert M5` | **5.09 mm** (resid 0.0026) | M5 → 5.1 | ✓ |

Each bore also carries a 0.3 mm-deep entry chamfer that widens it by exactly 0.3 mm
(3.49 / 4.49 / 5.39). At any other scale these numbers are nonsense: ×25.4 would put a 106 mm
hole in a 46 mm part.

Independent confirmation: PrusaSlicer's own `--info` reports `volume = 1872.097168` for
`insert-empty.stl`; trimesh reports 1872.097. Two independent readers, same number.

---

## 2. The lattice

Fitted across **all seven panels simultaneously** — 56 to 288 cells each, one least-squares
lattice per panel over every recovered hexagon centre.

| Quantity | Value | How |
|---|---|---|
| **Cell pitch** (row-adjacent centres) | **23.600 mm** exactly | lattice fit, residual ≤ 1.8 × 10⁻⁴ mm |
| **Row step** (row-to-row) | **20.438 mm** exactly | least squares over 7 panels, δ = −3 × 10⁻⁷ |
| **Stagger** (row offset) | **11.800 mm** = pitch / 2 | exact boundary vertices |
| Diagonal neighbour distance | 23.59983 mm | √(11.8² + 20.438²) |
| Panel depth | **8.000 mm** | identical on all 7 panels |

> **The row step is 20.438, not 23.6·√3/2 = 20.43820.** The designer typed a rounded constant.
> The 0.0002 mm difference is invisible on one cell and 0.0034 mm across an 18-column panel —
> which is exactly the error that stops panels lining up. The app hard-codes 20.438 and never
> computes it from √3. See DECISIONS.md D4.

Because the row step is rounded while the hexagons themselves are regular, the lattice is
very slightly non-equilateral: horizontal neighbours sit 23.60000 mm apart, diagonal neighbours
23.59983 mm. Measured |b| across all panels was 23.59983–23.59984. This is a real property of
the standard, not measurement noise.

### Axial coordinates

The app's canonical frame is **pointy-top** — a corner points +Y, flats face left and right.

```
x = PITCH · (q + r/2)      = 23.600·q + 11.800·r
y = ROW_STEP · r           = 20.438·r
```

---

## 3. The two hexagon geometries

The bore through a panel is **stepped**, not straight. Resolved by probing five heights inside
each band and reading the slope, so a prism is distinguishable from a taper (a single probe per
band cannot tell them apart — both return one number).

From the printed-bottom face (z = 0) of `wall-honeycomb-part.stl`:

| Band | Depth | Across flats | Across corners | Kind |
|---|---|---|---|---|
| 0.0 → 0.5 | 0.5 mm | 20.8 → 20.0 | 24.02 → 23.09 | taper, 38.7° per side (entry flare) |
| 0.5 → 5.1 | **4.6 mm** | **20.000** | **23.09401** | **PRISM — the insert profile** |
| 5.1 → 6.0 | 0.9 mm | 20.0 → 22.0 | 23.09 → 25.40 | taper, 48.0° per side (lead-in) |
| 6.0 → 8.0 | **2.0 mm** | **22.000** | **25.40341** | **PRISM — the full cell** |

Both prism bands measured with standard deviation **0.00000 mm across all 56 cells**, and max
irregularity ≤ 1.1 × 10⁻⁵ mm. These are exact.

**The two that matter:**

- **Full cell — 22.000 mm across flats.** The visible mouth, 2 mm deep.
- **Insert profile — 20.000 mm across flats.** The 4.6 mm throat almost everything clips into.
  This is the "20 mm hexagon" the community quotes, and it is exactly right.

### Wall thickness

| Between cells at | Thickness |
|---|---|
| the throat (20.0 bore) | **3.600 mm** = 23.6 − 20.0 |
| the mouth (22.0 bore) | **1.600 mm** = 23.6 − 22.0 |

---

## 4. Panels

### Outline

A panel's exterior is **not a rectangle**. It is the boundary of the union of hexagonal unit
cells — a zig-zag of 116 to 268 vertices that **interlocks** with its neighbours.

Verified against exact boundary vertices on `wall-honeycomb-part.stl`:

- bottom-edge vertices at **exact multiples of 23.6** (23.6, 47.2, 70.8, … 165.2);
- left-edge flats **13.6255 mm long** (= the hexagon side), repeating every **40.876 mm** = 2 × 20.438;
- the left edge alternates between x = 0 and x = 11.8 — a castellated edge, 12 vertices at one
  and 13 at the other.

Consequence for the planner: seams are zig-zag lines through the grid, so seam-crossing has to
be computed **in cell space**, never by comparing pixel rectangles.

### Margins (edge cell centre → panel boundary)

| Axis | Margin | Closed form |
|---|---|---|
| flats axis | **11.80000 mm** | pitch / 2 |
| rows axis | **13.62547 mm** | pitch / √3 |

### Size formula

```
pointy-drawn:  W = PITCH·(columns + 0.5)          H = (rows − 1)·20.438 + 27.25093
flat-drawn:    W = (columns − 1)·20.438 + 27.25093  H = PITCH·(rows + 0.5)
```

Reproduces every shipped panel to within **2.1 × 10⁻⁴ mm** (0.2 µm). The app nonetheless uses
the *measured* bbox for the seven shipped panels, so drift is structurally impossible for
anything the user will actually print — see DECISIONS.md D5.

### The seven panels

Wall columns × rows are in the **wall frame** (canonical pointy-top). Width × height are the
**bed footprint as drawn**. Four panels are drawn flat-top and must be spun 90° to sit on a
pointy-top wall, which is why their two frames are transposed.

| File | Drawn | Wall cols × rows | Cells | Bed W × H mm | Print¹ | Fits |
|---|---|---|---|---|---|---|
| `wall-honeycomb-106x89-fixed` | flat | 4 × 4 | 16 | 88.57 × 106.20 | 1 h 33 m, 14.6 g | everything from Prusa Mini up |
| `wall-honeycomb-part` | pointy | 7 × 8 | **56** | 177.00 × 170.32 | 5 h 15 m, 49.1 g | Prusa Mini (180×180) |
| `wall-honeycomb-k1-211x201` | flat | 8 × 10 | 80 | 211.19 × 200.60 | 7 h 24 m, 69.6 g | 220×220 and up |
| `wall-honeycomb-224x190size(mk3s)` | pointy | 9 × 9 | 81 | 224.20 × 190.75 | 7 h 31 m, 70.6 g | 235×235, MK3S and up |
| `wall-honeycomb-bambu-211x248-fixed` | pointy | 10 × 10 | 100 | 247.80 × 211.19 | 9 h 15 m, 86.7 g | 256×256 and up |
| `wall-honeycomb-293x271-(big-printer)` | flat | 11 × 14 | 154 | 292.95 × 271.40 | 14 h 08 m, 132.4 g | 300×300 and up |
| `375x389-fixed` | flat | 16 × 18 | 288 | 374.70 × 389.40 | 26 h 10 m, 245.0 g | **400×400 only** |

¹ PrusaSlicer 2.9.6, profile `PLA-0.20mm-15pct-2perim-0.4nozzle` — see §7.

Cell counts were recovered twice and agree: once by counting hexagonal holes in the
cross-section, once from columns × rows via the size formula.

**Note on `375x389-fixed`:** at 374.70 × 389.40 it fits none of the beds in the brief's list
(Prusa Mini, 220, 235, 256, 350). It needs a 400 × 400 machine. Flagged rather than fudged.

### How panels join

There are **no screw holes anywhere in any panel** — confirmed: zero non-hexagonal interiors in
every panel cross-section at the throat band. Panels join in two ways only:

1. **The interlocking zig-zag edge** carries the alignment.
2. **Multi-cell inserts bridge the seam.** A 2-, 3- or 4-cell insert dropped into cells that
   straddle the join is what actually holds two panels together. The catalogue's multi-cell
   inserts (§5) are the joiners.

### How panels mount to the wall

Also through the cells: a **countersunk insert** drops into a cell and takes a wall screw
through its 3.5 mm bore. Measured countersink profile on `Insert-countersunk.stl`: a 3.50 mm
shank hole opening through a cone to 6.89 mm and then a 10.0 mm bore — an **~88° included
angle**, i.e. a standard 90° countersink.

The app's rule: **4 wall mounts per panel, plus one more per 50 cells.** Four is the minimum
that stops a panel rotating; more stops a large panel bowing. This is an engineering rule, not
a measurement — argue with it in `tools/scan.py`.

---

## 5. The insert family

The standard insert envelope is **25.9808 × 22.5 × 10.0 mm** — a regular hexagon 22.5 mm across
flats, 10 mm tall.

Depth profile of `insert-empty.stl`:

| Band | Feature | Across flats |
|---|---|---|
| 0.0 → 0.3 | flange chamfer | 21.9 → 22.5 |
| 0.3 → 2.5 | **flange** | **22.500** |
| 2.5 → 6.5 | **body** | **19.7** |
| 6.5 → 9.6 | **snap barbs** | peak **20.735** at z ≈ 8.2–8.6 |
| 9.6 → 10.0 | tip taper | 19.48 |

**Why it works:** the 19.7 body slides through the 20.0 throat with 0.3 mm clearance; the
20.735 barbs are wider than the throat and spring out exactly where the bore opens to 21.3–22.0.
That is a snap fit, and only in one direction. The 22.5 flange is wider than the 22.0 mouth, so
it always seats proud of the face. Full reasoning and the residual uncertainty: DECISIONS.md D7.

Adjacent inserts do not collide: flanges are 22.5 across flats at 23.6 pitch, leaving a 1.1 mm gap.

### The family, as measured

| Part | Cells | Footprint shape | Takes |
|---|---|---|---|
| `insert-empty` | 1 | single | — (plain clip, 13.4 mm socket) |
| `insert-with-m3` | 1 | single | 1 × M3 |
| `insert-m4` | 1 | single | 1 × M4 |
| `insert-m5` | 1 | single | 1 × M5 |
| `insert-with-m3-dual` | 2 | diagonal pair | 2 × M3 |
| `double-m4` | 2 | diagonal pair | 2 × M4 |
| `double-m5` | 2 | diagonal pair | 2 × M5 |
| `insert-hollow-dual` | 2 | diagonal pair | — |
| `insert-hollow-tre` | 3 | triangle | — |
| `insert-hollow-for` | 4 | rhombus | — |
| `insert-countersunk` | 1 | single | 1 × wall screw |
| `hexagon-countersung-and-hole` | 2 | axial pair | 1 × wall screw |
| `insert-countersung-m3` | 2 | axial pair | 1 × M3 + 1 × wall screw |
| `insert-countersunk-with-m3x3` | 4 | diamond | **3 × M3** + 1 × wall screw |
| `insert-for-countersunk-hole-3` | 4 | diamond | 1 × wall screw |

The 3 × M3 on `insert-countersunk-with-m3x3` was measured from three distinct 3.19 mm bores —
and independently matches the `m3x3` in its filename. Geometry and name agree.

### Bolt sizes are measured, not read off filenames

A countersink is a cone, so it shows a different diameter in every slice — and its mid-cone
sections land inside the M4 and M5 tolerance windows. Bores are therefore grouped by centre and
sized by their **narrowest** section (the shank hole, the only diameter a screw must pass). Two
bugs this caught, both of which had silently produced a wrong shopping list:

- every countersunk wall fastener was claiming an M5 bolt it does not take;
- one 1-cell wall insert was asking for two wall screws, because rounding its cone's fitted
  centre to 0.1 mm split one hole across a boundary into two.

### The second tier

HSW here is **two-level**, which is not obvious from the outside and matters for the parts list:

1. **Inserts clip into wall cells** (20.0 throat / 22.0 mouth).
2. **Accessories attach to inserts** — either bolted (M3/M4/M5) or plugged into the insert's own
   hexagonal socket (13.4 mm on the standard insert, 18.5 / 16.5 mm on the hollow family, which
   is what `countersunk-to-holee` and `cover-contersunk` fit).

29 of the 51 parts are second-tier. Geometry can measure how wide such a part is, but **cannot**
say which cells its installer will put its inserts in — that is a choice, not a feature. Those
parts carry a bounding-box footprint and are flagged in `UNKNOWN.md` rather than guessed at.

---

## 6. Catalogue

`src/catalog/catalog.json` — **generated, never hand-written**.

```
python tools/scan.py            # incremental: measures only new/changed files
python tools/scan.py --rescan   # re-measure everything
python tools/scan.py --verify   # rebuild and diff against the committed file
```

51 parts: 7 panels, 10 inserts, 5 fasteners, 29 accessories. All 51 carry sliced estimates.

- Measurements cache on the STL's **sha256 plus a measure-version**, so a change to the
  measurement logic invalidates stale results instead of silently keeping them.
- Slices cache on the **profile hash** too, so changing the profile cannot leave the catalogue
  quietly mixing two profiles under one name.
- `catalog.json` carries no wall-clock timestamp unless its content changed, which makes
  "re-run from scratch and diff" a byte-for-byte check. `--verify` currently reports
  **REPRODUCED EXACTLY**.
- Human corrections go in `src/catalog/overrides.json`, keyed by part id. The scanner reads it
  and never writes it, so a correction survives every future rescan.

---

## 7. Print estimates

Real headless slices, not volume guesses. A volume estimate knows nothing about perimeters,
infill, solid layers or travel, and is 30–60 % wrong on thin-walled parts like these hooks.

**PrusaSlicer 2.9.6**, profile id `PLA-0.20mm-15pct-2perim-0.4nozzle/PrusaSlicer`, hashed into
every catalogue entry:

| Setting | Value |
|---|---|
| layer height | 0.20 mm |
| perimeters | 2 |
| top / bottom solid | 4 / 3 |
| infill | 15 % grid |
| nozzle / filament | 0.4 mm / 1.75 mm |
| filament density | 1.24 g/cm³ (PLA) |
| supports | off |
| estimation bed | 400 × 400 (see below) |

The estimation bed is deliberately oversized. Bed size does not change time or filament — it
only decides whether the slicer refuses the job. A 250 × 210 bed made the three largest panels
fail with "outside the print volume" and silently lose their estimates. Whether a part fits the
**user's** printer is a separate question, answered per part by `panel.fitsBeds`.

**Supports** are a stated mesh heuristic, not a slicer verdict: facets whose normal lies within
45° of straight down, excluding the bed face; supports recommended if that area exceeds both
20 mm² and 2 % of total. The raw overhang area is recorded on every part so the call is auditable.

---

## 8. Complete inventory

Every one of the 51 STLs, with bounding box, type and cell footprint, is in
`src/catalog/catalog.json`. `build/inventory.json` holds the raw pass (format, triangle count,
volume, watertightness). All 51 are **binary** STL; the loader handles ASCII too.

Note: **no file in `./models/` is watertight** by trimesh's test. This is normal for exported
STLs of this vintage and does not affect any measurement used here — every number in this
document comes from cross-sections and vertex positions, neither of which requires a closed
manifold. PrusaSlicer independently reports `manifold = yes` for `insert-empty.stl`, so the
"not watertight" flag reflects duplicated vertices rather than actual holes.

---

## 9. Community figures — checked, not trusted

| Figure in circulation | Measured | Verdict |
|---|---|---|
| 20 mm hexagons | 20.000 mm across flats at the throat | **agrees exactly** |
| base panel ≈ 170 × 177 mm | `wall-honeycomb-part` = 177.000 × 170.317 | **agrees exactly** |
| …with 28 cells | **56 cells** (7 × 8) | **disagrees — files win** |
| ≈ 42.58 mm across a two-hexagon span | 46.418 mm (diagonal) / 46.100 mm (axial) | **disagrees — files win** |

On 28 vs 56: 56 hexagonal interiors were recovered from the cross-section, and 7 × 8 = 56 was
derived independently from the size formula. Both agree. 28 is exactly half, so the community
figure is plausibly a per-face count or a typo — but that is a guess, so it is recorded and left.

On 42.58: nothing in any file measures it. The nearest quantities in the geometry are
2 × 20.438 = 40.876 and 20.438 + 22.0 = 42.438, neither convincing. Recorded in `UNKNOWN.md`.
