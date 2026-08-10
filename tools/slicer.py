"""Headless slicing for real print estimates.

Estimates come from an actual slice, not from volume x density. A volume guess
cannot know about perimeters, infill percentage, top/bottom solid layers or
travel moves, and it is wrong by 30-60% on thin-walled parts like these hooks --
which is the difference between one spool and two.

The profile is written to disk and hashed into the catalogue so the numbers are
reproducible and so re-slicing at a different profile is visibly a different
profile rather than silently inconsistent.
"""
from __future__ import annotations

import hashlib
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent

CANDIDATES = [
    r"C:\Program Files\Prusa3D\PrusaSlicer\prusa-slicer-console.exe",
    r"C:\Users\Morten\Documents\PrusaSlicer-2.9.3\prusa-slicer-console.exe",
    "prusa-slicer-console.exe",
    "prusa-slicer",
]

# The recorded profile. Values chosen to be an unremarkable, widely reproducible
# PLA setup rather than anything clever -- the point is that it is stated.
PROFILE = {
    "layer_height": "0.2",
    "first_layer_height": "0.2",
    "perimeters": "2",
    "top_solid_layers": "4",
    "bottom_solid_layers": "3",
    "fill_density": "15%",
    "fill_pattern": "grid",
    "nozzle_diameter": "0.4",
    "filament_diameter": "1.75",
    "filament_density": "1.24",
    "filament_cost": "20",
    "temperature": "215",
    "first_layer_temperature": "215",
    "bed_temperature": "60",
    "first_layer_bed_temperature": "60",
    "support_material": "0",
    "brim_width": "0",
    "skirts": "0",
    # An oversized estimation bed on purpose. Bed size does not affect time or
    # filament -- it only decides whether the slicer refuses the job at all. A
    # 250x210 bed made the three largest panels fail with "outside the print
    # volume" and silently lose their estimates. Whether a part fits the USER's
    # printer is a separate question, answered per part by `panel.fitsBeds`.
    "bed_shape": "0x0,400x0,400x400,0x400",
    "max_print_height": "400",
    "printer_technology": "FFF",
    "gcode_flavor": "marlin2",
    "perimeter_speed": "45",
    "infill_speed": "80",
    "travel_speed": "180",
}

PROFILE_ID = "PLA-0.20mm-15pct-2perim-0.4nozzle/PrusaSlicer"


def find_slicer() -> str | None:
    for c in CANDIDATES:
        if pathlib.Path(c).exists():
            return c
        w = shutil.which(c)
        if w:
            return w
    return None


def build_profile(dest: pathlib.Path, slicer: str) -> pathlib.Path:
    """Start from the slicer's own defaults, then override the recorded keys.

    Hand-writing a whole .ini invites a missing key that silently changes a
    default; starting from --save guarantees every other setting is the
    slicer's documented default for this exact build.
    """
    base = dest.parent / "default-profile.ini"
    if not base.exists():
        subprocess.run([slicer, "--save", str(base)], check=True,
                       capture_output=True, timeout=120)
    lines = base.read_text(encoding="utf-8", errors="replace").splitlines()
    seen = set()
    out = []
    for line in lines:
        m = re.match(r"^\s*([A-Za-z0-9_]+)\s*=", line)
        if m and m.group(1) in PROFILE:
            key = m.group(1)
            out.append(f"{key} = {PROFILE[key]}")
            seen.add(key)
        else:
            out.append(line)
    for k, v in PROFILE.items():
        if k not in seen:
            out.append(f"{k} = {v}")
    dest.write_text("\n".join(out) + "\n", encoding="utf-8")
    return dest


def profile_hash(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


_TIME = re.compile(r";\s*estimated printing time \(normal mode\)\s*=\s*(.+)")
_GRAMS = re.compile(r";\s*(?:total )?filament used \[g\]\s*=\s*([\d.]+)")
_MM = re.compile(r";\s*filament used \[mm\]\s*=\s*([\d.]+)")


def _parse_duration(text: str) -> float:
    """'1h 2m 3s' / '2d 1h' -> minutes."""
    total = 0.0
    for value, unit in re.findall(r"(\d+(?:\.\d+)?)\s*([dhms])", text):
        total += float(value) * {"d": 1440, "h": 60, "m": 1, "s": 1 / 60}[unit]
    return total


def slice_one(stl: pathlib.Path, slicer: str, profile: pathlib.Path,
              timeout: int = 600) -> dict | None:
    """Slice one STL; return minutes / grams / metres, or None if it failed."""
    with tempfile.TemporaryDirectory() as td:
        gcode = pathlib.Path(td) / "out.gcode"
        cmd = [slicer, "--export-gcode", "--load", str(profile),
               "--output", str(gcode), str(stl)]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=timeout,
                                  text=True, errors="replace")
        except subprocess.TimeoutExpired:
            return {"error": f"slicer timed out after {timeout}s"}
        if not gcode.exists():
            tail = (proc.stderr or proc.stdout or "").strip().splitlines()
            return {"error": (tail[-1] if tail else f"exit {proc.returncode}")}

        text = gcode.read_text(encoding="utf-8", errors="replace")
        # Search the whole file, not the tail: PrusaSlicer appends its entire
        # config as comments after the summary, and that dump is far larger than
        # any sane tail window.
        t = _TIME.search(text)
        g = _GRAMS.search(text)
        mm = _MM.search(text)
        if not (t and g and mm):
            return {"error": "slicer produced gcode without a summary block"}
        return {
            "minutes": round(_parse_duration(t.group(1)), 2),
            "grams": round(float(g.group(1)), 3),
            "metres": round(float(mm.group(1)) / 1000.0, 4),
            "raw_time": t.group(1).strip(),
        }


if __name__ == "__main__":
    import sys

    s = find_slicer()
    print(f"slicer: {s}")
    if not s:
        raise SystemExit("no slicer found")
    prof = build_profile(ROOT / "build" / "hsw-profile.ini", s)
    print(f"profile: {prof} ({profile_hash(prof)})")
    for arg in sys.argv[1:]:
        print(f"  {arg} -> {slice_one(pathlib.Path(arg), s, prof)}")
