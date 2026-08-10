"""Pass 1: raw inventory of every STL in ./models/.

No interpretation, no classification. Just what the triangles say.
"""
import json
import pathlib
import sys

import numpy as np
import trimesh

ROOT = pathlib.Path(__file__).resolve().parent.parent
MODELS = ROOT / "models"


def stl_flavour(path: pathlib.Path) -> str:
    """Binary STL or ASCII STL? Header alone lies, so check the size math too."""
    with open(path, "rb") as fh:
        head = fh.read(84)
    if len(head) < 84:
        return "ascii?"
    n_tri = int.from_bytes(head[80:84], "little")
    expected = 84 + n_tri * 50
    if expected == path.stat().st_size:
        return "binary"
    return "ascii" if head[:5].lower() == b"solid" else "unknown"


def describe(path: pathlib.Path) -> dict:
    mesh = trimesh.load_mesh(path, process=False)
    if isinstance(mesh, trimesh.Scene):
        mesh = mesh.dump(concatenate=True)
    lo, hi = mesh.bounds
    size = hi - lo
    # Connected components tell us whether a file holds one part or several.
    try:
        n_bodies = len(mesh.split(only_watertight=False))
    except Exception:
        n_bodies = -1
    return {
        "file": str(path.relative_to(ROOT)).replace("\\", "/"),
        "name": path.stem,
        "group": str(path.parent.relative_to(MODELS)).replace("\\", "/"),
        "bytes": path.stat().st_size,
        "stl_format": stl_flavour(path),
        "triangles": int(len(mesh.faces)),
        "vertices_raw": int(len(mesh.vertices)),
        "bbox_min": [round(float(v), 4) for v in lo],
        "bbox_max": [round(float(v), 4) for v in hi],
        "size_mm": [round(float(v), 4) for v in size],
        "volume_mm3": round(float(mesh.volume), 3),
        "area_mm2": round(float(mesh.area), 3),
        "watertight": bool(mesh.is_watertight),
        "bodies": n_bodies,
    }


def main() -> None:
    rows = []
    for path in sorted(MODELS.rglob("*.stl")):
        try:
            rows.append(describe(path))
        except Exception as exc:  # noqa: BLE001 - want the file named, not a stack
            rows.append({"file": str(path.relative_to(ROOT)), "error": repr(exc)})
    out = ROOT / "build" / "inventory.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(rows, indent=1), encoding="utf-8")

    w = max(len(r["file"]) for r in rows)
    print(f"{'file'.ljust(w)}  {'fmt':7} {'tris':>7}  {'size (mm)':>26}  {'vol mm3':>10}  wt")
    for r in rows:
        if "error" in r:
            print(f"{r['file'].ljust(w)}  ERROR {r['error']}")
            continue
        s = "x".join(f"{v:7.2f}" for v in r["size_mm"])
        print(
            f"{r['file'].ljust(w)}  {r['stl_format']:7} {r['triangles']:7d}  {s}  "
            f"{r['volume_mm3']:10.1f}  {'Y' if r['watertight'] else 'n'}"
        )
    print(f"\n{len(rows)} files -> {out}")


if __name__ == "__main__":
    sys.exit(main())
