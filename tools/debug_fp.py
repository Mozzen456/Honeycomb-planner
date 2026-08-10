"""Trace the wall-clip detector on one part."""
import sys

from shapely.geometry import Polygon as SPoly
from shapely.ops import unary_union

from footprint import (ENV_FLATS, _bands, _cells_in_silhouette, _filled, _hex_pts,
                       envelope_block)
from hexlib import load, section_polygons

path = sys.argv[1]
mesh = load(path)
lo, hi = mesh.bounds
sx, sy = float(hi[0] - lo[0]), float(hi[1] - lo[1])
print(f"{path}\n  bbox {sx:.4f} x {sy:.4f} x {float(hi[2]-lo[2]):.4f}")
print(f"  envelope_block -> {envelope_block(sx, sy)}")

gate = envelope_block(sx, sy)
drawn = gate[0] if gate else "flat"

for thick, z in _bands(mesh)[:14]:
    polys = section_polygons(mesh, z)
    if not polys:
        print(f"  z={z:7.3f} (t={thick:.3f}): no section")
        continue
    sil = _filled(polys)
    pts = _cells_in_silhouette(sil, drawn)
    if pts:
        union = unary_union([SPoly(_hex_pts(cx, cy, ENV_FLATS, drawn)) for cx, cy in pts])
        ch = sil.intersection(union).area / union.area
    else:
        ch = 0.0
    print(f"  z={z:7.3f} (t={thick:.3f}) area={sil.area:9.2f} bounds="
          f"{tuple(round(v,2) for v in sil.bounds)}  cells={len(pts)} fill={ch*100:5.1f}%")
    if thick > 1.0:
        from footprint import _basis, _cells_from_anchor
        _e1, _e2, ex, ey = _basis(drawn)
        minx, miny, maxx, maxy = sil.bounds
        for label, (x0, y0) in {
            "BL": (minx + ex / 2, miny + ey / 2),
            "TL": (minx + ex / 2, maxy - ey / 2),
            "BR": (maxx - ex / 2, miny + ey / 2),
            "TR": (maxx - ex / 2, maxy - ey / 2),
        }.items():
            got = _cells_from_anchor(sil, drawn, x0, y0)
            print(f"      anchor {label} ({x0:7.2f},{y0:7.2f}) -> {len(got)} cells "
                  f"{[(round(a,1), round(b,1)) for a, b in got]}")
