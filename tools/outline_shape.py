"""Read the panel boundary vertices directly instead of inferring the margin.

The outline is a zig-zag, so 'margin' is not one number: there is a near margin
(at a flat) and a far margin (at a corner). Report both, relative to cell
centres, and show the repeating boundary motif.
"""
import sys
from collections import Counter

import numpy as np

from hexlib import fit_lattice, load, ring_to_hexagon, section_polygons, z_levels

TARGET = sys.argv[1] if len(sys.argv) > 1 else "models/wall-honeycomb-part.stl"


def main() -> None:
    mesh = load(TARGET)
    levels = [z for z, _ in z_levels(mesh)]
    z = (levels[1] + levels[2]) / 2
    outer = max(section_polygons(mesh, z), key=lambda p: p.area)

    hexes = [h for h in (ring_to_hexagon(np.asarray(r.coords))
                         for r in outer.interiors) if h is not None]
    centres = np.array([h.centre for h in hexes])
    lat = fit_lattice(centres)

    ext = np.asarray(outer.exterior.coords)[:-1]
    lo = ext.min(axis=0)
    print(f"{TARGET}")
    print(f"  {len(ext)} boundary vertices, {len(centres)} cells")
    print(f"  bbox {np.round(ext.max(0)-lo, 5)}")

    # Distinct x and y values on the boundary, as offsets from the bbox corner.
    for axis, label in ((0, "x"), (1, "y")):
        vals = np.round(ext[:, axis] - lo[axis], 4)
        uniq = sorted(Counter(vals).items())
        print(f"\n  distinct {label} on boundary ({len(uniq)} values):")
        for v, n in uniq[:6]:
            print(f"    {v:10.4f}  x{n}")
        if len(uniq) > 12:
            print(f"    ... {len(uniq)-12} more ...")
        for v, n in uniq[-6:]:
            print(f"    {v:10.4f}  x{n}")

    # Nearest boundary vertex to the extreme cell centres, per axis.
    print("\n  extreme cell centres vs boundary extremes:")
    cl = centres - lo
    e = ext - lo
    span = ext.max(0) - lo
    print(f"    cell x range  {cl[:,0].min():9.4f} .. {cl[:,0].max():9.4f}"
          f"   (edges 0 .. {span[0]:.4f})")
    print(f"    cell y range  {cl[:,1].min():9.4f} .. {cl[:,1].max():9.4f}"
          f"   (edges 0 .. {span[1]:.4f})")
    print(f"    left margin  {cl[:,0].min():.5f}   right margin {span[0]-cl[:,0].max():.5f}")
    print(f"    bottom margin{cl[:,1].min():9.5f}   top margin   {span[1]-cl[:,1].max():.5f}")

    # The boundary motif: vertices sorted along the left edge.
    print("\n  left-edge boundary vertices (x < 2 mm), sorted by y:")
    left = e[e[:, 0] < 2.0]
    for p in left[np.argsort(left[:, 1])][:10]:
        print(f"    ({p[0]:9.4f}, {p[1]:9.4f})")

    print("\n  bottom-edge boundary vertices (y < 2 mm), sorted by x:")
    bot = e[e[:, 1] < 2.0]
    for p in bot[np.argsort(bot[:, 0])][:10]:
        print(f"    ({p[0]:9.4f}, {p[1]:9.4f})")

    # Distance from each boundary vertex to the nearest cell centre: the set of
    # distinct values IS the boundary motif.
    d = np.linalg.norm(e[:, None, :] - cl[None, :, :], axis=-1).min(axis=1)
    print("\n  distinct distances boundary-vertex -> nearest cell centre:")
    for v, n in sorted(Counter(np.round(d, 4)).items()):
        print(f"    {v:9.4f}  x{n}")


if __name__ == "__main__":
    main()
