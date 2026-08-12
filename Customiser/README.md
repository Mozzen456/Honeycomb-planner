# Honeycomb customiser

The parametric OpenSCAD generator for honeycomb panels, as supplied. It is what
makes a panel the shipped STLs cannot: one with cells left out, so the wall can
go round a light switch, a socket or a pipe.

| file | what it is |
|---|---|
| `honeycomb-customiser.scad` | the source, as plain text — open this in OpenSCAD |
| `Uten navn.rtf` | the original upload, kept verbatim |

The `.scad` is extracted from the `.rtf` and is byte-identical in content;
OpenSCAD cannot open an RTF, and a plain-text copy is also the only one git can
diff.

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
