"""Pass 3: resolve the hexagon hole profile through the panel's depth.

A single probe per band cannot tell a prism from a chamfer -- both read one
number. So probe several heights inside each band and look at the slope. Zero
slope = straight wall; constant non-zero slope = a taper, and the angle tells
you whether it is a 45 deg chamfer or a lead-in.
"""
import sys

import numpy as np

from hexlib import fit_lattice, load, ring_to_hexagon, section_polygons, z_levels

TARGET = sys.argv[1] if len(sys.argv) > 1 else "models/wall-honeycomb-part.stl"
PROBES = 5


def main() -> None:
    mesh = load(TARGET)
    lo, hi = mesh.bounds
    levels = [z for z, _ in z_levels(mesh)]
    print(f"{TARGET}\n  bbox {np.round(hi - lo, 4)}  z levels {[round(z,4) for z in levels]}\n")

    print(f"  {'z':>8}  {'n':>4}  {'flats':>9}  {'corners':>9}  {'rot':>7}  slope d(flats)/dz")
    prev = None
    for k in range(len(levels) - 1):
        z0, z1 = levels[k], levels[k + 1]
        band = []
        for t in np.linspace(0.12, 0.88, PROBES):
            z = z0 + (z1 - z0) * t
            polys = section_polygons(mesh, z)
            if not polys:
                continue
            outer = max(polys, key=lambda p: p.area)
            hexes = [h for h in (ring_to_hexagon(np.asarray(r.coords))
                                 for r in outer.interiors) if h is not None]
            if not hexes:
                continue
            af = float(np.mean([h.across_flats for h in hexes]))
            ac = float(np.mean([h.across_corners for h in hexes]))
            rot = float(np.mean([h.rotation_deg for h in hexes]))
            band.append((z, af, ac, rot, len(hexes)))

        if not band:
            print(f"  band {z0:.3f}-{z1:.3f}: no hexagonal holes")
            continue
        zs = np.array([r[0] for r in band])
        afs = np.array([r[1] for r in band])
        slope = float(np.polyfit(zs, afs, 1)[0]) if len(band) > 1 else 0.0
        kind = "PRISM" if abs(slope) < 1e-6 else f"TAPER {np.degrees(np.arctan2(abs(slope)/2,1)):.2f}deg/side"
        print(f"  -- band z {z0:7.3f} .. {z1:7.3f}  ({z1-z0:.3f} mm)   {kind}")
        for z, af, ac, rot, n in band:
            print(f"  {z:8.4f}  {n:4d}  {af:9.5f}  {ac:9.5f}  {rot:7.3f}  {slope:+.6f}")
        prev = band

    # Non-hexagonal interiors: mounting / screw holes. Fit circles, report
    # residuals, and never quote a facet-vertex distance as a diameter.
    print("\n  non-hexagonal interiors (circle-fitted):")
    seen = {}
    for k in range(len(levels) - 1):
        z = (levels[k] + levels[k + 1]) / 2
        polys = section_polygons(mesh, z)
        if not polys:
            continue
        outer = max(polys, key=lambda p: p.area)
        rings = [np.asarray(r.coords) for r in outer.interiors]
        odd = [r for r in rings if ring_to_hexagon(r) is None]
        if not odd:
            continue
        from hexlib import fit_circle
        fits = [fit_circle(r[:-1]) for r in odd]
        ds = np.array([2 * f.radius for f in fits])
        print(f"    z={z:7.3f}: {len(odd):3d} holes, fit dia "
              f"{ds.min():.4f}..{ds.max():.4f}  "
              f"max resid {max(f.residual_max for f in fits):.5f} mm  "
              f"n_pts {sorted({f.n_points for f in fits})}")
        for f in fits[:4]:
            print(f"        centre {np.round(f.centre,3)}  dia_fit {2*f.radius:.4f}  "
                  f"dia_inscribed {2*f.inscribed_radius:.4f}  rms {f.residual_rms:.5f}")


if __name__ == "__main__":
    sys.exit(main())
