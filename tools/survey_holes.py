"""Survey every circular feature in the non-panel parts.

Two jobs:
  1. Scale proof. If the M3 parts really have ~3.2 mm holes and the M5 parts
     ~5.2 mm, the files are millimetres and nothing downstream is 25.4x off.
  2. The fastener spec: which insert takes which screw.

Every diameter here is a least-squares circle fit with its residual reported.
No diameter is ever read off a facet-vertex distance.
"""
import json
import pathlib
from collections import defaultdict

import numpy as np

from hexlib import MODELS, ROOT, fit_circle, load, ring_to_hexagon, section_polygons, z_levels

# Nominal metric clearance/tap sizes we expect to see, for labelling only --
# the measurement stands on its own, this just names it.
NOMINAL = {"M3": 3.0, "M4": 4.0, "M5": 5.0}


def circles_in(path: pathlib.Path) -> list[dict]:
    mesh = load(path)
    levels = [z for z, _ in z_levels(mesh)]
    found = []
    for k in range(len(levels) - 1):
        z = (levels[k] + levels[k + 1]) / 2
        try:
            polys = section_polygons(mesh, z)
        except Exception:
            continue
        for poly in polys:
            for ring in poly.interiors:
                pts = np.asarray(ring.coords)
                if len(pts) > 1 and np.allclose(pts[0], pts[-1]):
                    pts = pts[:-1]
                if ring_to_hexagon(np.asarray(ring.coords)) is not None:
                    continue  # hexagonal, not a screw hole
                if len(pts) < 12:
                    continue  # too coarse to call a circle
                f = fit_circle(pts)
                # A real cylinder: residual tiny relative to radius.
                if f.residual_max > 0.02 * f.radius or f.radius < 0.5:
                    continue
                found.append({
                    "z": round(z, 4),
                    "band": [round(levels[k], 4), round(levels[k + 1], 4)],
                    "dia_fit": round(2 * f.radius, 4),
                    "dia_inscribed": round(2 * f.inscribed_radius, 4),
                    "resid_max": round(f.residual_max, 6),
                    "resid_rms": round(f.residual_rms, 6),
                    "facets": f.n_points,
                    "centre": [round(float(v), 3) for v in f.centre],
                })
    return found


def cluster(found: list[dict]) -> list[dict]:
    """Collapse the same cylinder appearing in several z-bands."""
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for f in found:
        groups[(round(f["dia_fit"], 2), tuple(f["centre"]))].append(f)
    out = []
    for (dia, centre), items in sorted(groups.items()):
        zs = [i["z"] for i in items]
        out.append({
            "dia_fit": dia,
            "dia_inscribed": round(min(i["dia_inscribed"] for i in items), 4),
            "centre": list(centre),
            "z_from": round(min(i["band"][0] for i in items), 4),
            "z_to": round(max(i["band"][1] for i in items), 4),
            "resid_max": round(max(i["resid_max"] for i in items), 6),
            "facets": max(i["facets"] for i in items),
            "n_bands": len(items),
        })
    return out


def main() -> None:
    rows = []
    for path in sorted(MODELS.rglob("*.stl")):
        if "wall-honeycomb" in path.name or path.name in {"375x389-fixed.stl"}:
            continue
        try:
            circles = cluster(circles_in(path))
        except Exception as exc:  # noqa: BLE001
            print(f"{path.name}: ERROR {exc!r}")
            continue
        if not circles:
            continue
        rel = str(path.relative_to(ROOT)).replace("\\", "/")
        rows.append({"file": rel, "circles": circles})

    print(f"{'file':62} {'dia_fit':>8} {'inscr':>8} {'resid':>9} {'facets':>7} {'z span':>16}")
    for r in rows:
        for c in r["circles"]:
            print(f"{r['file'].split('/')[-1]:62} {c['dia_fit']:8.3f} "
                  f"{c['dia_inscribed']:8.3f} {c['resid_max']:9.5f} {c['facets']:7d} "
                  f"{c['z_from']:7.2f}..{c['z_to']:<7.2f}")

    # Scale proof: group every fitted diameter and see whether the population
    # clusters on metric screw sizes.
    all_d = sorted(c["dia_fit"] for r in rows for c in r["circles"])
    print(f"\n{len(all_d)} cylinders fitted, diameters {min(all_d):.3f}..{max(all_d):.3f} mm")
    print("\nSCALE PROOF -- named parts vs measured hole:")
    for tag, nom in NOMINAL.items():
        hits = [c["dia_fit"] for r in rows if tag.lower() in r["file"].lower()
                for c in r["circles"] if nom - 0.2 <= c["dia_fit"] <= nom + 1.5]
        if hits:
            print(f"  {tag} (nominal {nom} mm): files named {tag} contain holes "
                  f"{sorted(set(round(h,2) for h in hits))}")
            print(f"      -> ratio to nominal {np.mean(hits)/nom:.4f} "
                  f"(25.4 would mean inches)")

    (ROOT / "build" / "holes.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    print(f"\n-> build/holes.json")


if __name__ == "__main__":
    main()
