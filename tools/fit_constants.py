"""Solve for the panel constants from all seven panels at once.

Assuming ROW = P*sqrt(3)/2 leaves a residual that grows with column count --
a sure sign the designer typed a rounded constant. Rather than guess which
rounding, fit ROW and MARGIN by least squares over every panel and report the
residual, then compare against the candidate closed forms.
"""
import math

import numpy as np

from hexlib import load

P = 23.6

PANELS = [
    ("wall-honeycomb-part.stl",                  "pointy",  7,  8),
    ("wall-honeycomb-106x89-fixed.stl",          "flat",    4,  4),
    ("wall-honeycomb-224x190size(mk3s).stl",     "pointy",  9,  9),
    ("wall-honeycomb-293x271-(big-printer).stl", "flat",   14, 11),
    ("wall-honeycomb-bambu-211x248-fixed.stl",   "pointy", 10, 10),
    ("wall-honeycomb-k1-211x201.stl",            "flat",   10,  8),
    ("375x389-fixed.stl",                        "flat",   18, 16),
]


def main() -> None:
    # Exact bbox extents straight from the float32 vertex data.
    obs = []
    for name, orient, cols, rows in PANELS:
        m = load(f"models/{name}")
        lo, hi = m.bounds
        w, h = float(hi[0] - lo[0]), float(hi[1] - lo[1])
        # n = number of ROW-steps along the "row axis" dimension
        n = (rows - 1) if orient == "pointy" else (cols - 1)
        dim = h if orient == "pointy" else w
        obs.append((name, orient, cols, rows, w, h, n, dim))

    # dim = n*ROW + 2*MARGIN  ->  linear in (ROW, MARGIN)
    A = np.array([[o[6], 2.0] for o in obs])
    y = np.array([o[7] for o in obs])
    (row_step, margin), *_ = np.linalg.lstsq(A, y, rcond=None)
    resid = A @ np.array([row_step, margin]) - y

    print("Least-squares fit over all 7 panels (row-axis dimension):")
    print(f"  ROW step  = {row_step:.9f} mm")
    print(f"  MARGIN    = {margin:.9f} mm   (2*MARGIN = {2*margin:.9f})")
    print(f"  residuals = {np.round(resid, 7)}  max |r| = {np.abs(resid).max():.2e} mm\n")

    print("Candidate closed forms for ROW step:")
    for label, val in [
        ("P*sqrt(3)/2      ", P * math.sqrt(3) / 2),
        ("20.438 (typed)   ", 20.438),
        ("20.4382 (typed)  ", 20.4382),
    ]:
        print(f"  {label} = {val:.9f}   delta = {val - row_step:+.2e}")

    print("\nCandidate closed forms for MARGIN:")
    for label, val in [
        ("P/sqrt(3)        ", P / math.sqrt(3)),
        ("13.6255 (typed)  ", 13.6255),
        ("2*ROW/3          ", 2 * row_step / 3),
    ]:
        print(f"  {label} = {val:.9f}   delta = {val - margin:+.2e}")

    # Now lock ROW=20.438, MARGIN=P/sqrt(3) and re-check every panel exactly.
    print("\n\nExact reproduction with ROW = 20.438, MARGIN = 23.6/sqrt(3):")
    ROW, MRG = 20.438, P / math.sqrt(3)
    print(f"{'panel':44} {'cols x rows':>11} {'dW mm':>11} {'dH mm':>11}  ok")
    worst = 0.0
    for name, orient, cols, rows, w, h, _, _ in obs:
        if orient == "pointy":
            pw, ph = P * (cols + 0.5), (rows - 1) * ROW + 2 * MRG
        else:
            pw, ph = (cols - 1) * ROW + 2 * MRG, P * (rows + 0.5)
        dw, dh = pw - w, ph - h
        worst = max(worst, abs(dw), abs(dh))
        ok = abs(dw) < 1e-4 and abs(dh) < 1e-4
        print(f"{name:44} {cols:4d} x {rows:<4d} {dw:+11.7f} {dh:+11.7f}  {'OK' if ok else 'FAIL'}")
    print(f"\nworst deviation {worst:.2e} mm "
          f"(float32 quantum at 375 mm is {np.spacing(np.float32(375.0)):.1e} mm)")


if __name__ == "__main__":
    main()
