"""Fit the in-browser print estimator against real slices, and prove it generalises.

`src/core/stl.ts` has to guess print time and filament for a part nobody has
sliced, because there is no slicer in a browser. This script is where its
constants come from, and where the honesty of its stated error is established.

The lesson that shaped it, kept here because it is easy to repeat: the first
version was fitted on the 51 shipped HSW parts alone. Every one of them is
thin-walled -- a hook, a clip, a perforated plate -- so the fit had no example
of an infill-dominated solid to learn from, and the model quietly learned the
family instead of the physics. It scored 15% RMS on its own fit set and was
54-59% WRONG on a solid cube, a sphere and a flat plate. Fitting and testing on
one family proves only that you memorised that family.

So this script slices two things:

  1. the 51 shipped parts, which are what users mostly import; and
  2. ~22 generated shapes that span what the shipped set does not -- solid
     blocks, thin shells, flat plates, tall posts, cylinders and tubes.

It fits on the union and reports the error on each family separately, plus on
any held-out shapes you add. Output goes to tests/fixtures/estimator-calibration.json,
which `tests/stl.test.ts` then checks against WITHOUT needing a slicer.

    python tools/calibrate_estimator.py            # fit and report
    python tools/calibrate_estimator.py --write    # ... and rewrite the fixture

Needs PrusaSlicer (see tools/slicer.py for where it looks). Deliberately has no
numpy/trimesh dependency, so it runs anywhere the slicer does.
"""
from __future__ import annotations

import json
import math
import pathlib
import struct
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import slicer  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "estimator-calibration.json"

# Must match src/core/stl.ts. The fit solves for these; they are written back by
# hand, because a generated constants file would be a second source of truth.
LAYER_H = 0.2
DENSITY = 1.24

# ---------------------------------------------------------------------------
# STL reading and measurement -- the same arithmetic as src/core/stl.ts
# ---------------------------------------------------------------------------


def read_stl(path: pathlib.Path) -> list:
    data = path.read_bytes()
    if len(data) >= 84:
        count = struct.unpack_from("<I", data, 80)[0]
        if 84 + count * 50 == len(data) and count:
            return [
                struct.unpack_from("<12fH", data, 84 + i * 50)[3:12]
                for i in range(count)
            ]
    import re

    nums = [float(x) for x in re.findall(r"vertex\s+(\S+)\s+(\S+)\s+(\S+)", data.decode("utf8", "replace")) for x in x]
    return [tuple(nums[i : i + 9]) for i in range(0, len(nums), 9)]


def measure(path: pathlib.Path) -> tuple[float, float, float]:
    """volume, surface area, height -- exactly what the browser measures."""
    volume = area = 0.0
    zmin, zmax = 1e30, -1e30
    for t in read_stl(path):
        a, b, c = t[0:3], t[3:6], t[6:9]
        volume += (
            a[0] * (b[1] * c[2] - b[2] * c[1])
            - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0])
        ) / 6.0
        u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
        n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        area += 0.5 * math.sqrt(sum(x * x for x in n))
        for p in (a, b, c):
            zmin = min(zmin, p[2])
            zmax = max(zmax, p[2])
    return abs(volume), area, zmax - zmin


# ---------------------------------------------------------------------------
# The calibration shapes
# ---------------------------------------------------------------------------


def _write_stl(path: pathlib.Path, tris) -> None:
    with open(path, "wb") as f:
        f.write(b"\0" * 80)
        f.write(struct.pack("<I", len(tris)))
        for a, b, c in tris:
            u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
            v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
            n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
            length = math.sqrt(sum(x * x for x in n)) or 1.0
            f.write(struct.pack("<3f", *[x / length for x in n]))
            for p in (a, b, c):
                f.write(struct.pack("<3f", *p))
            f.write(struct.pack("<H", 0))


def _box(x0, y0, z0, x1, y1, z1, flip=False):
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
         (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    quads = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    out = []
    for a, b, c, d in quads:
        out += ([(v[a], v[c], v[b]), (v[a], v[d], v[c])] if flip
                else [(v[a], v[b], v[c]), (v[a], v[c], v[d])])
    return out


def _cyl(r, h, n=40, flip=False):
    out = []
    for j in range(n):
        a0, a1 = 2 * math.pi * j / n, 2 * math.pi * (j + 1) / n
        p0 = (r * math.cos(a0), r * math.sin(a0))
        p1 = (r * math.cos(a1), r * math.sin(a1))
        tris = [
            ((p0[0], p0[1], 0), (p1[0], p1[1], 0), (p1[0], p1[1], h)),
            ((p0[0], p0[1], 0), (p1[0], p1[1], h), (p0[0], p0[1], h)),
            ((0, 0, 0), (p1[0], p1[1], 0), (p0[0], p0[1], 0)),
            ((0, 0, h), (p0[0], p0[1], h), (p1[0], p1[1], h)),
        ]
        out += [tuple(reversed(t)) for t in tris] if flip else tris
    return out


def _sphere(r, n=24):
    def P(i, j):
        return (r * math.sin(math.pi * i / n) * math.cos(2 * math.pi * j / n),
                r * math.sin(math.pi * i / n) * math.sin(2 * math.pi * j / n),
                r + r * math.cos(math.pi * i / n))
    out = []
    for i in range(n):
        for j in range(n):
            a, b, c, d = P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)
            out += [(a, b, c), (a, c, d)]
    return out


def build_shapes(into: pathlib.Path) -> list[tuple[str, str]]:
    """The spanning set. Family names end up in the fixture and in the report."""
    made: list[tuple[str, str]] = []

    def add(name, tris, family):
        _write_stl(into / f"{name}.stl", tris)
        made.append((name, family))

    # Infill-dominated: the regime the HSW set has none of.
    for s in (12, 18, 25, 35, 45):
        add(f"solid-cube-{s}", _box(0, 0, 0, s, s, s), "calibration")
    # Shell-dominated, a range of wall thicknesses.
    for s, w in ((25, 1.0), (30, 1.6), (40, 2.4), (50, 3.2)):
        add(f"shell-{s}-w{w}", _box(0, 0, 0, s, s, s) + _box(w, w, w, s - w, s - w, s - w, flip=True), "calibration")
    # Flat plates: long fast lines, few layers.
    for w, d, h in ((40, 40, 3), (80, 60, 2), (120, 80, 4), (60, 60, 8)):
        add(f"plate-{w}x{d}x{h}", _box(0, 0, 0, w, d, h), "calibration")
    # Tall and thin: dominated by the per-layer cost.
    for w, h in ((6, 60), (10, 100), (4, 40), (16, 140)):
        add(f"post-{w}x{h}", _box(0, 0, 0, w, w, h), "calibration")
    # Curved.
    for r, h in ((10, 20), (20, 15), (8, 60)):
        add(f"cyl-r{r}h{h}", _cyl(r, h), "calibration")
    for r, h, w in ((15, 25, 2.0), (25, 20, 3.0)):
        add(f"tube-r{r}h{h}w{w}", _cyl(r, h) + _cyl(r - w, h, flip=True), "calibration")

    # Held out from the fit on purpose, so the reported error is not the fit's
    # own opinion of itself.
    add("hollow-box-30", _box(0, 0, 0, 30, 30, 30) + _box(1.2, 1.2, 1.2, 28.8, 28.8, 28.8, flip=True), "held-out")
    add("rod-4x4x120", _box(0, 0, 0, 4, 4, 120), "held-out")
    add("sphere-r15", _sphere(15), "held-out")
    add("thin-plate-2x60x80", _box(0, 0, 0, 60, 2, 80), "held-out")
    return made


# ---------------------------------------------------------------------------
# Fitting
# ---------------------------------------------------------------------------


def _solve(cols: list[list[float]], y: list[float]) -> list[float]:
    """Ordinary least squares by Gauss-Jordan on the normal equations."""
    n = len(cols)
    aug = [
        [sum(cols[i][k] * cols[j][k] for k in range(len(y))) for j in range(n)]
        + [sum(cols[i][k] * y[k] for k in range(len(y)))]
        for i in range(n)
    ]
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(aug[r][i]))
        aug[i], aug[p] = aug[p], aug[i]
        for r in range(n):
            if r == i:
                continue
            f = aug[r][i] / aug[i][i]
            for c in range(i, n + 1):
                aug[r][c] -= f * aug[i][c]
    return [aug[i][n] / aug[i][i] for i in range(n)]


def split(volume: float, area: float, shell_t: float, infill_f: float) -> tuple[float, float]:
    shell = min(area * shell_t, volume * 0.95)
    return shell, max(0.0, volume - shell) * infill_f


def _stats(errs: list[float]) -> str:
    rms = math.sqrt(sum(e * e for e in errs) / len(errs))
    return f"rms {rms * 100:5.1f}%  worst {max(abs(e) for e in errs) * 100:5.1f}%"


def main() -> int:
    found = slicer.find_slicer()
    if not found:
        print("no PrusaSlicer found -- see CANDIDATES in tools/slicer.py")
        return 1
    print(f"slicer:  {found}")
    profile = ROOT / "build" / "hsw-profile.ini"
    if not profile.exists():
        profile = slicer.build_profile(profile, found)
    print(f"profile: {profile.name} ({slicer.profile_hash(profile)})")

    rows: list[dict] = []

    catalog = json.loads((ROOT / "src" / "catalog" / "catalog.json").read_text())
    for part in catalog["parts"]:
        volume, area, height = measure(ROOT / part["file"])
        rows.append({"name": part["id"], "family": "hsw", "volumeMm3": round(volume, 3),
                     "areaMm2": round(area, 3), "heightMm": round(height, 3),
                     "grams": part["print"]["grams"], "minutes": part["print"]["minutes"],
                     "metres": part["print"]["metres"]})

    with tempfile.TemporaryDirectory() as td:
        folder = pathlib.Path(td)
        for name, family in build_shapes(folder):
            stl = folder / f"{name}.stl"
            result = slicer.slice_one(stl, found, profile, timeout=900)
            if not result or "error" in result:
                print(f"  ! {name}: {result}")
                continue
            volume, area, height = measure(stl)
            rows.append({"name": name, "family": family, "volumeMm3": round(volume, 3),
                         "areaMm2": round(area, 3), "heightMm": round(height, 3),
                         "grams": result["grams"], "minutes": result["minutes"],
                         "metres": result["metres"]})
            print(f"  sliced {name}: {result['minutes']:.1f} min, {result['grams']:.2f} g", flush=True)

    fit = [r for r in rows if r["family"] in ("hsw", "calibration")]
    held = [r for r in rows if r["family"] == "held-out"]

    best = None
    for ti in range(50, 140, 2):
        for fi in range(8, 50):
            shell_t, infill_f = ti / 100, fi / 100
            errs = []
            for r in fit:
                s, i = split(r["volumeMm3"], r["areaMm2"], shell_t, infill_f)
                errs.append(((s + i) / 1000 * DENSITY - r["grams"]) / r["grams"])
            rms = math.sqrt(sum(e * e for e in errs) / len(errs))
            if best is None or rms < best[0]:
                best = (rms, shell_t, infill_f)
    _, SHELL_T, INFILL_F = best

    def feats(rs):
        out = []
        for r in rs:
            s, i = split(r["volumeMm3"], r["areaMm2"], SHELL_T, INFILL_F)
            out.append((s, i, max(1.0, r["heightMm"] / LAYER_H)))
        return out

    F = feats(fit)
    coef = _solve([[f[0] for f in F], [f[1] for f in F], [f[2] for f in F]],
                  [r["minutes"] for r in fit])

    print("\n--- constants for src/core/stl.ts ESTIMATOR ---")
    print(f"  shellThicknessMm:     {SHELL_T}")
    print(f"  infillFraction:       {INFILL_F}")
    print(f"  minutesPerShellMm3:   {coef[0]:.5f}")
    print(f"  minutesPerInfillMm3:  {coef[1]:.5f}")
    print(f"  minutesPerLayer:      {coef[2]:.5f}")

    print("\n--- error, per family ---")
    for label, rs in (("fit", fit), ("  hsw", [r for r in fit if r["family"] == "hsw"]),
                      ("  calibration", [r for r in fit if r["family"] == "calibration"]),
                      ("HELD-OUT", held)):
        if not rs:
            continue
        G = feats(rs)
        mass = [((G[k][0] + G[k][1]) / 1000 * DENSITY - rs[k]["grams"]) / rs[k]["grams"] for k in range(len(rs))]
        time = [(sum(coef[j] * G[k][j] for j in range(3)) - rs[k]["minutes"]) / rs[k]["minutes"] for k in range(len(rs))]
        print(f"  {label:<12} n={len(rs):<3} mass {_stats(mass)}   time {_stats(time)}")

    if "--write" in sys.argv:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        shapes = [r for r in rows if r["family"] != "hsw"]
        FIXTURE.write_text(json.dumps({
            "_": "Real PrusaSlicer results for geometry that is NOT part of the HSW model set.",
            "_why": ("The estimator is fitted against printed parts. Fitting and testing on the same "
                     "family proves only that it memorised that family -- and it had: on a solid cube "
                     "and a flat plate the first version was 54-59% slow. These shapes span the regime "
                     "the HSW parts do not, so the estimator can be held to a stated error on geometry "
                     "a user might actually import."),
            "_profile": f"{slicer.PROFILE_ID}@{slicer.profile_hash(profile)} (HSW-SPEC.md 7)",
            "_regenerate": "python tools/calibrate_estimator.py --write",
            "shapes": shapes,
        }, indent=1) + "\n")
        print(f"\nwrote {len(shapes)} shapes to {FIXTURE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
