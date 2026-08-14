# Honeycomb customiser

The parametric OpenSCAD generator for honeycomb panels, as supplied. It is what
makes a panel the shipped STLs cannot: one with cells left out, so the wall can
go round a light switch, a socket or a pipe — and, in the `Cadcode` version, one
with a straight framed edge.

**You no longer need OpenSCAD to get those plates.** `src/core/honeycomb.ts`
generates them in the browser: draw a blocked zone or switch a frame on in the
Plan section and press **Download STL**. This folder is the reference the
generator was checked against, and the route to take if you want to change a
shape by hand — every generated plate still offers **Copy settings**.

| file | what it is |
|---|---|
| `honeycomb-customiser.scad` | the source, as plain text — open this in OpenSCAD |
| `Cadcode.rtf` | the same customiser **plus borders**: `Top/Bottom/Left/Right_Border` and `Double_Outer_Wall_Thickness`. The reference for the frame. |
| `network_wall.jpg` | a built wall, for reference |
| `borders.webp` | **a printed plate with a border** — the reference the app's border is built from |

## Where it disagrees with the plates, the plates win

`Cadcode.rtf` gives the whole bore in closed form, as one extruded polygon per
wall:

```
polygon([[0,0], [0,8], [0.8,8], [0.8,6], [1.8,5.1], [1.8,0.5], [1.62,0]])
```

Read as thickness against height, that agrees with `HSW-SPEC.md` §3 — measured
off `wall-honeycomb-part.stl` with a standard deviation of 0.00000 mm across all
56 cells — on the 22.0 mouth over 2.0 mm, the 48° lead-in over 0.9 mm, and the
20.0 throat over 4.6 mm. It differs on the entry flare: the customiser chamfers
to 20.36, the shipped plates measure **20.8 across flats over 0.5 mm**. The app
takes the measurement (DECISIONS D54). What the customiser *is* the authority on
is the border, because no shipped plate has one.

The `.scad` is extracted from the original `.rtf` upload and is byte-identical in
content; OpenSCAD cannot open an RTF, and a plain-text copy is also the only one
git can diff. `Cadcode.rtf` is a later upload and is kept verbatim.

## It is on the same lattice as the measured spec

Checked, not assumed — from the constants in `get_constants()`
(`hole_width = 20`, `wall_thickness = 1.8`, `depth = 8`):

| quantity | customiser | `src/core/constants.ts` |
|---|---|---|
| cell pitch | `hole_width + 2·wall` = **23.600000** | `PITCH` 23.6 |
| column step | `1.5·hex_s` = **20.438200** | `ROW_STEP` 20.438 |
| hexagon side | `hex_h/√3` = **13.625466** | `MARGIN_Y` 13.6254664 |
| stagger | `hex_h/2` = **11.800000** | `STAGGER` 11.8 |
| plate depth | **8** | `PANEL_DEPTH` 8 |

The one difference is the column step: the customiser computes the closed form
20.4382 where the shipped panels use the typed 20.438. That is DECISIONS D4's
0.0002 mm — 0.0024 mm across a 13-column panel, far below print tolerance. The
app stays on the measured constant; the difference is noted rather than adopted.

**Orientation.** The customiser is flat-top: its *columns* step along 20.438 and
its cells step 23.6 within a column, with alternate columns dropped half a pitch.
On a pointy-top wall those are the wall's *rows*. `src/core/customiser.ts` does
that conversion, and `tests/customiser.test.ts` pins it by round-trip — get the
stagger parity wrong and the plate comes out a mirror image, which is invisible
until it is printed and the holes are on the wrong side of the switch.

## Using it from the planner

Add an obstacle in the planner's parts-list panel. Any panel it lands in is cut
around it, listed separately from the stock plates, and offers **Copy customiser
settings** — a block of `Number_of_Columns`, `Column_N`, `Gap_Column_N` and
`Column_Offset_N` to paste in here. All thirteen of each are emitted, including
the ones past the panel's own width, so a customiser session that already had
values set cannot leave a stale one behind.

## The border is the plate's, not the customiser's

`Cadcode.rtf` adds `Top/Bottom/Left/Right_Border`, and those CUT: the outermost cells are sliced
along their centre line and the halves walled off, which costs a whole column of mountable cells
per plate.

`borders.webp` is a printed plate, and it is not that. Every cell is a whole, open hexagon; the
walls BETWEEN cells run out past the honeycomb to a straight line; and the triangular notches
between the zig-zag outline and that line are filled in solid. It ADDS material and costs nothing.

The app builds the second one (DECISIONS D59) — a reference object outranks a reference
implementation, the same way the STLs in `models/` outrank any published description. The
`*_Border` flags are still emitted by **Copy settings** because "this edge is closed" survives the
translation; the thickness is not, because it does not mean the same thing in both.
