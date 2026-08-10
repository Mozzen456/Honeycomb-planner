"""Pass 4: panel outlines, their relationship to the lattice, and how they tile.

The question that decides whether the planner is worth anything: if I butt two
panels together, does the hex lattice continue across the seam, and at what
offset? Answered by expressing each panel's outline in lattice coordinates.
"""
import json

import numpy as np

from hexlib import ROOT, fit_lattice, load, ring_to_hexagon, section_polygons, z_levels

PANELS = [
    "models/wall-honeycomb-part.stl",
    "models/wall-honeycomb-106x89-fixed.stl",
    "models/wall-honeycomb-224x190size(mk3s).stl",
    "models/wall-honeycomb-293x271-(big-printer).stl",
    "models/wall-honeycomb-bambu-211x248-fixed.stl",
    "models/wall-honeycomb-k1-211x201.stl",
    "models/375x389-fixed.stl",
]

PITCH = 23.6  # measured, exact to 1.8e-4 mm across every panel


def canonical_axes(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Reduce any fitted basis to the two canonical 60-degree-apart steps."""
    cands = [a, b, a + b, a - b, -a + b]
    cands = [v for v in cands if abs(np.linalg.norm(v) - PITCH) < 0.01]
    # pick the one closest to +X, then the one ~60 deg from it
    cands = sorted(cands + [-v for v in cands], key=lambda v: -v[0])
    u = cands[0]
    for v in cands:
        ang = np.degrees(np.arccos(np.clip(np.dot(u, v) / PITCH ** 2, -1, 1)))
        if 55 < ang < 65 and v[1] > 0:
            return u, v
    return a, b


def analyse(path: str) -> dict:
    mesh = load(path)
    lo, hi = mesh.bounds
    levels = [z for z, _ in z_levels(mesh)]
    # Section inside the throat band (2nd band) -- the narrowest, cleanest profile.
    z = (levels[1] + levels[2]) / 2
    polys = section_polygons(mesh, z)
    outer = max(polys, key=lambda p: p.area)

    hexes, odd = [], []
    for r in outer.interiors:
        h = ring_to_hexagon(np.asarray(r.coords))
        (hexes if h is not None else odd).append(h if h is not None else np.asarray(r.coords))

    centres = np.array([h.centre for h in hexes])
    lat = fit_lattice(centres)
    u, v = canonical_axes(lat.a, lat.b)

    # Integer lattice indices of every cell, relative to the lowest-left cell.
    M = np.c_[u, v]
    idx = np.rint(np.linalg.solve(M, (centres - lat.origin).T).T).astype(int)
    idx -= idx.min(axis=0)

    ext = np.asarray(outer.exterior.coords)[:-1]
    ext_local = ext - lo[:2]

    # Where does the boundary sit relative to the cell centres, in mm?
    cmin, cmax = centres.min(axis=0) - lo[:2], centres.max(axis=0) - lo[:2]
    size = (hi - lo)[:2]
    margins = {
        "left": round(float(cmin[0]), 4),
        "right": round(float(size[0] - cmax[0]), 4),
        "bottom": round(float(cmin[1]), 4),
        "top": round(float(size[1] - cmax[1]), 4),
    }

    # Tiling test: is the panel footprint an integer number of lattice steps in
    # each direction? Report the size in units of the two canonical axes.
    orient = "pointy-top" if abs(u[1]) < 1e-3 and abs(u[0] - PITCH) < 1e-3 else "flat-top"
    row_step = abs(v[1])
    col_step = abs(u[0]) if orient == "pointy-top" else abs(u[0])

    out = {
        "file": path,
        "size_mm": [round(float(s), 4) for s in size],
        "depth_mm": round(float((hi - lo)[2]), 4),
        "cells": len(centres),
        "non_hex_interiors": len(odd),
        "orientation": orient,
        "axis_u": [round(float(x), 5) for x in u],
        "axis_v": [round(float(x), 5) for x in v],
        "lattice_residual_max_mm": round(lat.residual_max, 7),
        "index_span": [int(idx[:, 0].max()) + 1, int(idx[:, 1].max()) + 1],
        "margins_mm": margins,
        "exterior_vertices": len(ext),
        "exterior_is_rectangle": bool(len(_rect_test(ext)) == 4),
        "size_in_pitches": [round(float(size[0] / PITCH), 5),
                            round(float(size[1] / PITCH), 5)],
        "size_over_row_step": round(float(size[1] / row_step), 5),
        "size_over_col_step": round(float(size[0] / col_step), 5),
        "cell_index_pairs": sorted({(int(a), int(b)) for a, b in idx}),
    }

    print(f"\n=== {path}")
    print(f"  {size[0]:.3f} x {size[1]:.3f} x {(hi-lo)[2]:.2f} mm | {len(centres)} cells "
          f"| {orient} | {len(odd)} non-hex holes")
    print(f"  u={np.round(u,4)}  v={np.round(v,4)}  resid {lat.residual_max:.1e}")
    print(f"  exterior has {len(ext)} vertices; rectangle={out['exterior_is_rectangle']}")
    print(f"  margins (centre -> edge): {margins}")
    print(f"  size / pitch = {out['size_in_pitches']}")
    if odd:
        _report_odd(odd)
    return out


def _rect_test(ext: np.ndarray) -> np.ndarray:
    """Corners that are not 180-degree colinear; 4 => plain rectangle."""
    keep = []
    n = len(ext)
    for i in range(n):
        a, b, c = ext[i - 1], ext[i], ext[(i + 1) % n]
        cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        if abs(cr) > 1e-4:
            keep.append(b)
    return np.asarray(keep)


def _report_odd(odd: list) -> None:
    from hexlib import fit_circle
    print(f"  non-hexagonal interiors:")
    shapes = {}
    for ring in odd:
        pts = ring[:-1] if np.allclose(ring[0], ring[-1]) else ring
        bb = tuple(np.round(pts.max(0) - pts.min(0), 3))
        shapes.setdefault((len(pts), bb), []).append(pts)
    for (n, bb), group in sorted(shapes.items()):
        f = fit_circle(group[0])
        tag = (f"circle dia {2*f.radius:.3f} (resid {f.residual_max:.4f})"
               if f.residual_max < 0.05 else "non-circular")
        print(f"    x{len(group):3d}  {n:3d} pts  bbox {bb}  {tag}")


def main() -> None:
    rows = [analyse(p) for p in PANELS]
    dest = ROOT / "build" / "tiling.json"
    dest.write_text(json.dumps(rows, indent=1), encoding="utf-8")

    print("\n\n=== tiling summary ===")
    print(f"{'panel':46} {'w x h mm':>20} {'cells':>6} {'w/pitch':>9} {'h/pitch':>9}  orient")
    for r in rows:
        print(f"{r['file'].split('/')[-1]:46} {r['size_mm'][0]:9.3f} x{r['size_mm'][1]:8.3f} "
              f"{r['cells']:6d} {r['size_in_pitches'][0]:9.4f} {r['size_in_pitches'][1]:9.4f}  "
              f"{r['orientation']}")
    print(f"\n-> {dest}")


if __name__ == "__main__":
    main()
