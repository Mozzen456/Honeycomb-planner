"""Verify the closed-form panel size formula against every measured panel.

If W and H can be predicted from (columns, rows) alone to within float32 noise,
the planner can generate panel sizes instead of hardcoding a lookup table.
"""
import json
import math

from hexlib import ROOT

P = 23.6                    # cell pitch, measured
ROW = P * math.sqrt(3) / 2  # 20.438011...
MARGIN_ROW = P / math.sqrt(3)  # 13.625527...

MEASURED = [
    # file, orientation, W, H, cells
    ("wall-honeycomb-part.stl",              "pointy", 177.000, 170.3171,  56),
    ("wall-honeycomb-106x89-fixed.stl",      "flat",    88.5651, 106.200,  16),
    ("wall-honeycomb-224x190size(mk3s).stl", "pointy", 224.200, 190.7549,  81),
    ("wall-honeycomb-293x271-(big-printer).stl", "flat", 292.9451, 271.400, 154),
    ("wall-honeycomb-bambu-211x248-fixed.stl", "pointy", 247.800, 211.1931, 100),
    ("wall-honeycomb-k1-211x201.stl",        "flat",   211.1931, 200.600,  80),
    ("375x389-fixed.stl",                    "flat",   374.6971, 389.400, 288),
]


def size_pointy(cols: int, rows: int) -> tuple[float, float]:
    """Columns run along X at full pitch; rows stagger by half a pitch in X."""
    return P * (cols + 0.5), (rows - 1) * ROW + 2 * MARGIN_ROW


def size_flat(cols: int, rows: int) -> tuple[float, float]:
    """Transpose of pointy-top: columns along X at ROW spacing."""
    return (cols - 1) * ROW + 2 * MARGIN_ROW, P * (rows + 0.5)


def solve(orient: str, w: float, h: float) -> tuple[int, int]:
    if orient == "pointy":
        cols = round(w / P - 0.5)
        rows = round((h - 2 * MARGIN_ROW) / ROW) + 1
    else:
        cols = round((w - 2 * MARGIN_ROW) / ROW) + 1
        rows = round(h / P - 0.5)
    return cols, rows


def main() -> None:
    print(f"pitch          P    = {P}")
    print(f"row step   P*v3/2   = {ROW:.6f}")
    print(f"row margin  P/v3    = {MARGIN_ROW:.6f}")
    print(f"col margin  P/2     = {P/2:.6f}\n")

    print(f"{'panel':44} {'orient':7} {'cols x rows':>12} {'cells':>6} "
          f"{'dW mm':>10} {'dH mm':>10}  ok")
    rows_out, all_ok = [], True
    for name, orient, w, h, cells in MEASURED:
        c, r = solve(orient, w, h)
        pw, ph = (size_pointy if orient == "pointy" else size_flat)(c, r)
        dw, dh = pw - w, ph - h
        ok = abs(dw) < 5e-4 and abs(dh) < 5e-4 and c * r == cells
        all_ok &= ok
        print(f"{name:44} {orient:7} {c:5d} x {r:<4d} {c*r:6d} "
              f"{dw:+10.5f} {dh:+10.5f}  {'OK' if ok else 'MISMATCH'}")
        rows_out.append({"file": f"models/{name}", "orientation": orient,
                         "columns": c, "rows": r, "cells": c * r,
                         "width_mm": round(pw, 4), "height_mm": round(ph, 4),
                         "measured_cells": cells})

    print(f"\n{'ALL PANELS REPRODUCED BY FORMULA' if all_ok else 'FORMULA FAILS'}")
    (ROOT / "build" / "panel_sizes.json").write_text(
        json.dumps(rows_out, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
