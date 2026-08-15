#!/usr/bin/env python3
"""Build the social preview card — `public/social-card.png`, 1200 x 630.

WHY THIS EXISTS
---------------
A link to the planner posted anywhere — a forum, a Printables comment, a chat —
is rendered by the other end as a card, and with no `og:image` that card is a
grey box with a domain in it. The app is a picture of a wall; the preview should
be too.

WHAT IT DRAWS
-------------
The real lattice, from `src/core/constants.ts` and nothing else: flat-top cells
on a 23.600 mm pitch with a 20.438 mm row step and 20.0 mm across the flats.
Drawing an approximate honeycomb here would be the one picture of the product
that disagrees with the product — the same failure `panel-mesh.test.ts` and
`honeycomb-model.test.ts` exist to catch further in.

Over it, the DARK-theme wordmark from `src/ui/assets/`, because the card's
background is the dark theme's own shell colour. That artwork is itself build
output (D102) — run `tools/logo.py` first if the master has changed.

NO DEPENDENCIES
---------------
`zlib` and `struct`, via `logo.py`'s codec, for the reason stated there: the
Python side already asks for trimesh/scipy/shapely and a picture should not
widen that.

ANTI-ALIASING
-------------
Each hexagon is filled from its SIGNED DISTANCE rather than supersampled. A
regular flat-top hexagon's edge normals are 90 degrees apart in threes, so the
distance is `max(|y|, |x·cos30 + y·sin30|, |x·cos30 - y·sin30|) - F/2` and one
pass gives a clean edge. Supersampling 1200x630 by 2x in pure Python costs 3M
point tests for a worse result.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from logo import read_rgba, write_rgba  # noqa: E402  (path set above)

ROOT = Path(__file__).resolve().parent.parent
WORDMARK = ROOT / "src" / "ui" / "assets" / "honeycomb-logo-dark.png"
OUT = ROOT / "public" / "social-card.png"

# The size every consumer of og:image assumes. Facebook, Slack, Discord,
# Mastodon and X all crop to about 1.91:1; 1200x630 is that ratio exactly, so
# nothing is cut off.
W, H = 1200, 630

# The lattice, from src/core/constants.ts. Not re-derived: ROW_STEP is the
# designer's typed 20.438, NOT 23.6·√3/2, and the difference is the whole
# subject of D4.
PITCH = 23.6
ROW_STEP = 20.438
ACROSS_FLATS = 20.0

# One cell drawn this many pixels across the flats. Big enough that the card
# reads as a wall rather than as a texture at the size a chat client shows it.
CELL_PX = 46.0
MM_TO_PX = CELL_PX / ACROSS_FLATS

# Dark theme, from src/ui/tokens.css: the shell's ground, the plate over it, and
# the opening through the plate. Ordered wall < plate < cell exactly as D101
# requires of the canvas trio — depth has to read inward.
WALL = (0x0D, 0x10, 0x13)
PLATE = (0x22, 0x2A, 0x30)
CELL = (0x15, 0x1A, 0x1E)

# The gold from the wordmark, for the accent row. Sampled from the master rather
# than typed: it is somebody else's brand colour and this file is not tokens.css.
GOLD = (0xE8, 0xA7, 0x2B)

COS30 = math.cos(math.radians(30.0))
SIN30 = 0.5


def hex_coverage(dx: float, dy: float, half_flats: float) -> float:
    """How much of a pixel at (dx, dy) from a cell's centre is inside it.

    The three normals of a flat-top hexagon, then a one-pixel linear ramp across
    the boundary. Returns 0.0 outside, 1.0 inside, a fraction on the edge.
    """
    d = max(
        abs(dy),
        abs(dx * COS30 + dy * SIN30),
        abs(dx * COS30 - dy * SIN30),
    ) - half_flats
    return min(1.0, max(0.0, 0.5 - d))


def blend(buf: bytearray, x: int, y: int, rgb: tuple[int, int, int], a: float) -> None:
    if a <= 0.0:
        return
    o = (y * W + x) * 4
    for c in range(3):
        buf[o + c] = round(buf[o + c] * (1.0 - a) + rgb[c] * a)


def main() -> None:
    if not WORDMARK.exists():
        raise SystemExit(f"{WORDMARK} is missing — run `python tools/logo.py` first")

    # Opaque throughout: a social card is composited onto whatever background
    # the client uses, and transparency there means a wordmark on white.
    buf = bytearray(W * H * 4)
    for i in range(W * H):
        o = i * 4
        buf[o], buf[o + 1], buf[o + 2], buf[o + 3] = *WALL, 255

    # --- the plate -----------------------------------------------------------
    #
    # A band across the lower two thirds, so the wordmark sits on quiet ground
    # and the wall reads as something the eye travels down to.
    plate_top = int(H * 0.34)
    for y in range(plate_top, H):
        row = y * W
        for x in range(W):
            o = (row + x) * 4
            buf[o], buf[o + 1], buf[o + 2] = PLATE

    # A single hairline where the plate begins — the edge of a real plate is a
    # cut on its outermost cell centres (D87), and this is that line.
    for x in range(W):
        blend(buf, x, plate_top, (0x33, 0x3D, 0x45), 1.0)

    # --- the cells -----------------------------------------------------------
    #
    # Enough columns and rows to overrun the frame on every side: the honeycomb
    # is continuous and a card showing its last column would look like a plate
    # floating in space.
    half = ACROSS_FLATS / 2.0 * MM_TO_PX
    step_x = ROW_STEP * MM_TO_PX
    step_y = PITCH * MM_TO_PX
    reach = int(half) + 2

    cols = int(W / step_x) + 3
    origin_y = plate_top + step_y * 0.75

    def top_r(q: int) -> int:
        """The r of the highest cell drawn in column q.

        The window slides by -q/2 as columns advance, so an anchor stated as a
        bare r lands on a different height in every column — and off the card
        entirely within a dozen of them.
        """
        return math.floor((plate_top - half - origin_y) / step_y - q / 2.0)

    # Real footprints off the catalogue's own shapes: a single peg, a two-cell
    # hook, an L, and a four-cell block. The offsets are AXIAL, which is already
    # the wall's own frame — hexToMm applies the stagger when it places them, and
    # correcting for it here as well would shear every cluster.
    placed: set[tuple[int, int]] = set()
    # `ax` must stay inside the drawn columns (0 .. W/ROW_STEP_px) and `depth`
    # plus the shape's own reach inside the drawn rows, or a cluster is silently
    # cropped to nothing — which is how the first four of these vanished.
    for ax, depth, shape in (
        (1, 5, ((0, 0), (0, 1))),
        (5, 2, ((0, 0),)),
        (8, 6, ((0, 0), (1, 0), (1, 1))),
        (13, 3, ((0, 0), (0, 1), (1, 0), (1, 1))),
        (17, 7, ((0, 0), (1, 0))),
        (21, 4, ((0, 0), (0, 1))),
        (24, 1, ((0, 0),)),
    ):
        # The anchor's r is resolved ONCE, from the anchor column. Resolving it
        # per cell would re-seat every column of the cluster on its own sliding
        # window, which shears the shape by a row depending on parity — the
        # footprint has to be a rigid AXIAL shape and let the stagger place it.
        base_r = top_r(ax) + depth
        for dq, dr in shape:
            placed.add((ax + dq, base_r + dr))

    for q in range(-1, cols):
        cx = q * step_x

        # The r range has to FOLLOW the stagger, not be a fixed count. Centres
        # sit at y = origin + PITCH·(r + q/2), so the window of r that covers
        # the card slides by -q/2 as the columns advance; a constant range
        # instead walks the lattice off the bottom and fills a triangle.
        r_lo = math.floor((plate_top - half - origin_y) / step_y - q / 2.0)
        r_hi = math.ceil((H + half - origin_y) / step_y - q / 2.0)

        for r in range(r_lo, r_hi + 1):
            # The stagger, as hexToMm has it: y = PITCH·(r + q/2).
            cy = origin_y + step_y * (r + q / 2.0)
            if cy + half < plate_top - 1 or cy - half > H:
                continue

            # The accent: a few cells carrying something, the way a planned
            # wall looks. Contiguous FOOTPRINTS rather than a scatter or a row —
            # a row of lit cells reads as a painted band (D68) and a scatter
            # denies that the thing is a lattice, whereas a two-cell hook and an
            # L-shaped insert are what is actually on a wall.
            lit = (q, r) in placed
            ink = GOLD if lit else CELL

            for py in range(int(cy) - reach, int(cy) + reach + 1):
                if py < plate_top or py >= H:
                    continue
                for px in range(int(cx) - reach, int(cx) + reach + 1):
                    if px < 0 or px >= W:
                        continue
                    a = hex_coverage(px + 0.5 - cx, py + 0.5 - cy, half)
                    if lit:
                        a *= 0.30  # a tint through the opening, not a plug
                    blend(buf, px, py, ink, a)

    # --- the wordmark --------------------------------------------------------
    lw, lh, logo = read_rgba(WORDMARK)

    # 46% of the card's width. Wide enough to be the subject, short of the
    # crop most clients apply to the edges.
    target_w = int(W * 0.46)
    scale = target_w / lw
    target_h = max(1, round(lh * scale))
    ox = (W - target_w) // 2
    oy = int(H * 0.17) - target_h // 2

    for y in range(target_h):
        sy = min(lh - 1, int(y / scale))
        for x in range(target_w):
            sx = min(lw - 1, int(x / scale))
            s = (sy * lw + sx) * 4
            a = logo[s + 3] / 255.0
            if a <= 0.0:
                continue
            dx, dy = ox + x, oy + y
            if 0 <= dx < W and 0 <= dy < H:
                blend(buf, dx, dy, (logo[s], logo[s + 1], logo[s + 2]), a)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    size = write_rgba(OUT, W, H, buf)
    print(f"{OUT.relative_to(ROOT)}  {W}x{H}  {size // 1024} kB")


if __name__ == "__main__":
    main()
