"""General depth profiler: exterior silhouette AND interior holes, band by band.

Works for solid parts (inserts, hooks) as well as perforated panels.
"""
import sys

import numpy as np

from hexlib import fit_circle, load, ring_to_hexagon, section_polygons, z_levels

PROBES = 3


def ring_kind(coords: np.ndarray) -> str:
    h = ring_to_hexagon(coords)
    if h is not None:
        return (f"HEX flats={h.across_flats:.4f} corners={h.across_corners:.4f} "
                f"rot={h.rotation_deg:.2f} c=({h.centre[0]:.3f},{h.centre[1]:.3f})")
    pts = coords[:-1] if np.allclose(coords[0], coords[-1]) else coords
    f = fit_circle(pts)
    if f.residual_max < 0.05 and len(pts) >= 8:
        return (f"CIRCLE dia_fit={2*f.radius:.4f} dia_ins={2*f.inscribed_radius:.4f} "
                f"resid={f.residual_max:.4f} n={len(pts)} "
                f"c=({f.centre[0]:.3f},{f.centre[1]:.3f})")
    return f"POLY n={len(pts)} bbox={np.round(pts.max(0)-pts.min(0), 3)}"


def main() -> None:
    target = sys.argv[1]
    mesh = load(target)
    lo, hi = mesh.bounds
    levels = [z for z, _ in z_levels(mesh)]
    print(f"{target}\n  bbox {np.round(hi - lo, 4)}  z {lo[2]:.3f}..{hi[2]:.3f}")
    print(f"  z levels ({len(levels)}): {[round(z,4) for z in levels]}\n")

    for k in range(len(levels) - 1):
        z0, z1 = levels[k], levels[k + 1]
        print(f"  === band {z0:.4f} .. {z1:.4f}   ({z1-z0:.4f} mm)")
        for t in np.linspace(0.2, 0.8, PROBES):
            z = z0 + (z1 - z0) * t
            polys = section_polygons(mesh, z)
            if not polys:
                print(f"    z={z:8.4f}  (empty)")
                continue
            areas = sorted((p.area for p in polys), reverse=True)
            print(f"    z={z:8.4f}  {len(polys)} solid region(s), area {sum(areas):.3f} mm2")
            for p in sorted(polys, key=lambda q: -q.area)[:3]:
                ext = np.asarray(p.exterior.coords)
                print(f"        outer: {ring_kind(ext)}")
                for r in list(p.interiors)[:6]:
                    print(f"         hole: {ring_kind(np.asarray(r.coords))}")
                if len(p.interiors) > 6:
                    print(f"         ... +{len(p.interiors)-6} more holes")
            break  # one probe per band is enough once we know bands are prisms
        # second probe to confirm the band really is a prism
        za = z0 + (z1 - z0) * 0.25
        zb = z0 + (z1 - z0) * 0.75
        pa, pb = section_polygons(mesh, za), section_polygons(mesh, zb)
        if pa and pb:
            aa, ab = sum(p.area for p in pa), sum(p.area for p in pb)
            tag = "prism" if abs(aa - ab) < 1e-4 else f"TAPERED (area {aa:.3f} -> {ab:.3f})"
            print(f"        [{tag}]")


if __name__ == "__main__":
    sys.exit(main())
