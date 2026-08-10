"""Pass 2: derive the HSW grid from the panel meshes themselves.

For each panel: find the z-steps, section at each distinct level, recover every
hexagonal hole, then fit ONE lattice to all of them at once.
"""
import json
import sys

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


def analyse(path: str) -> dict:
    mesh = load(path)
    lo, hi = mesh.bounds
    levels = z_levels(mesh)
    print(f"\n=== {path}")
    print(f"    bbox {np.round(hi - lo, 4)}  z from {lo[2]:.4f} to {hi[2]:.4f}")
    print(f"    z levels: " + ", ".join(f"{z:.4f}({n})" for z, n in levels))

    result: dict = {"file": path, "size_mm": [round(float(v), 4) for v in (hi - lo)],
                    "z_levels": [[round(z, 4), n] for z, n in levels], "sections": {}}

    # Section midway between consecutive z-levels: that is where the profile is
    # unambiguous (exactly on a level you catch coincident geometry).
    zs = [z for z, _ in levels]
    probes = [(zs[i] + zs[i + 1]) / 2 for i in range(len(zs) - 1)]

    for z in probes:
        polys = section_polygons(mesh, z)
        if not polys:
            continue
        outer = max(polys, key=lambda p: p.area)
        hexes = []
        other = 0
        for ring in outer.interiors:
            h = ring_to_hexagon(np.asarray(ring.coords))
            if h is None:
                other += 1
            else:
                hexes.append(h)
        if not hexes:
            print(f"    z={z:7.4f}: {len(outer.interiors)} holes, none hexagonal")
            continue

        af = np.array([h.across_flats for h in hexes])
        ac = np.array([h.across_corners for h in hexes])
        rot = np.array([h.rotation_deg for h in hexes])
        reg = max(h.regularity for h in hexes)
        centres = np.array([h.centre for h in hexes])
        lat = fit_lattice(centres) if len(centres) >= 3 else None

        print(
            f"    z={z:7.4f}: {len(hexes):3d} hex (+{other} other)  "
            f"flats {af.mean():.4f}±{af.std():.5f}  corners {ac.mean():.4f}±{ac.std():.5f}  "
            f"rot {rot.mean():.3f}°  reg<={reg:.2e}"
        )
        if lat is not None:
            print(
                f"              lattice a={np.round(lat.a, 5)} |a|={np.linalg.norm(lat.a):.5f}  "
                f"b={np.round(lat.b, 5)} |b|={np.linalg.norm(lat.b):.5f}  "
                f"resid max {lat.residual_max:.2e} rms {lat.residual_rms:.2e}"
            )
        result["sections"][f"{z:.4f}"] = {
            "n_hex": len(hexes),
            "n_nonhex": other,
            "across_flats_mean": round(float(af.mean()), 5),
            "across_flats_std": round(float(af.std()), 6),
            "across_corners_mean": round(float(ac.mean()), 5),
            "across_corners_std": round(float(ac.std()), 6),
            "rotation_deg": round(float(rot.mean()), 4),
            "max_irregularity_mm": round(float(reg), 7),
            "outline_area_mm2": round(float(outer.area), 3),
            "lattice": None if lat is None else {
                "a": [round(float(v), 6) for v in lat.a],
                "b": [round(float(v), 6) for v in lat.b],
                "a_len": round(float(np.linalg.norm(lat.a)), 6),
                "b_len": round(float(np.linalg.norm(lat.b)), 6),
                "origin": [round(float(v), 5) for v in lat.origin],
                "residual_max_mm": round(lat.residual_max, 8),
                "residual_rms_mm": round(lat.residual_rms, 8),
                "index_min": [int(v) for v in lat.indices.min(axis=0)],
                "index_max": [int(v) for v in lat.indices.max(axis=0)],
                "cells": len(centres),
            },
            "centres": [[round(float(c[0]), 4), round(float(c[1]), 4)] for c in centres],
            "outline": [[round(float(x), 4), round(float(y), 4)]
                        for x, y in outer.exterior.coords],
        }
    return result


def main() -> None:
    out = [analyse(p) for p in PANELS]
    dest = ROOT / "build" / "panels.json"
    dest.parent.mkdir(exist_ok=True)
    dest.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"\n-> {dest}")


if __name__ == "__main__":
    sys.exit(main())
