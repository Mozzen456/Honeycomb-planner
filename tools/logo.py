#!/usr/bin/env python3
"""
Build the app's two logo assets from the master artwork.

    python tools/logo.py                      # rebuild from Honecomblogo.png
    python tools/logo.py path/to/master.png   # ...from somewhere else

Writes `src/ui/assets/honeycomb-logo.png` (light theme) and
`honeycomb-logo-dark.png` (dark theme). Both are cropped to the artwork's own
content and downscaled; `App.css` picks between them with the same
`prefers-color-scheme` + `[data-theme]` pair every themed token uses.

WHY THIS EXISTS
---------------
The supplied logo letters its name in dark grey. That is correct on a white
page and invisible on this app's dark theme, whose title bar is #14181B — so
the dark variant is DERIVED here rather than drawn, and it is derived rather
than hand-edited so that replacing the master is one command instead of a
manual re-edit somebody will forget.

**If the master changes, run this.** The two files in `src/ui/assets/` are build
output that happens to be committed; nothing else regenerates them.

THE TWO TRANSFORMS
------------------
*Crop* to the alpha bounding box. The master carries a transparent border (31 x
64 px on the original), and a logo sized by its box rather than by its content
spends a chunk of every pixel it is given on nothing.

*Recolour, neutrals only.* `v -> max(v, 255 - v)` lifts a dark grey into the
light half of the ramp and leaves anything already light exactly where it is.
That matters in three places at once: the wordmark becomes legible on a
near-black bar, the pale honeycomb inside the two O's stays pale, and PLANNER
stays a step quieter than HONEYCOMB. A plain inversion (`255 - v`) would have
turned that pale texture black and flipped the light/dark relationship between
the two words.

The gold is the brand and never moves. Pixels are blended toward "leave alone"
by SATURATION rather than switched by a threshold, so the anti-aliased fringe
between a gold hexagon and a grey letter has no hard edge in it.

NO DEPENDENCIES
---------------
Pure standard library — `zlib` and `struct` — because this repo's Python side
already asks for trimesh/scipy/shapely and a logo should not widen that. It
handles exactly what the master is: 8-bit RGBA, non-interlaced. Anything else is
refused rather than guessed at.
"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "Honecomblogo.png"
OUT_DIR = ROOT / "src" / "ui" / "assets"

# ~3.5x the 293 px the logo draws at in the title bar, so it stays crisp on a 3x
# screen without carrying the master's 2400 px into the bundle.
OUT_WIDTH = 1024

# Below SAT_LOW a pixel is treated as neutral and recoloured; above SAT_HIGH it
# is left exactly as drawn. Gold measures ~0.74, grey measures 0.
SAT_LOW, SAT_HIGH = 0.12, 0.32

# Alpha at or below this counts as "not part of the artwork" when cropping.
CROP_ALPHA = 8


# ---------------------------------------------------------------------------
# PNG
# ---------------------------------------------------------------------------

def read_rgba(path: Path) -> tuple[int, int, bytearray]:
    """Decode an 8-bit RGBA non-interlaced PNG into a flat buffer."""
    raw = path.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path}: not a PNG")

    idat = bytearray()
    width = height = 0
    i = 8
    while i < len(raw):
        length = struct.unpack(">I", raw[i:i + 4])[0]
        kind = raw[i + 4:i + 8]
        if kind == b"IHDR":
            width, height, depth, colour, _, _, interlace = struct.unpack(
                ">IIBBBBB", raw[i + 8:i + 8 + 13]
            )
            if (depth, colour, interlace) != (8, 6, 0):
                raise SystemExit(
                    f"{path}: need 8-bit RGBA non-interlaced, got depth={depth} "
                    f"colour-type={colour} interlace={interlace}"
                )
        elif kind == b"IDAT":
            idat += raw[i + 8:i + 8 + length]
        i += 12 + length

    data = zlib.decompress(bytes(idat))
    bpp, stride = 4, width * 4
    out = bytearray(width * height * 4)
    prev = bytearray(stride)
    pos = 0

    for y in range(height):
        filt = data[pos]
        pos += 1
        line = bytearray(data[pos:pos + stride])
        pos += stride
        if filt == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 255
        elif filt == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif filt == 3:
            for x in range(stride):
                left = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((left + prev[x]) >> 1)) & 255
        elif filt == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                c = prev[x - bpp] if x >= bpp else 0
                b = prev[x]
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pred) & 255
        elif filt != 0:
            raise SystemExit(f"{path}: unknown scanline filter {filt}")
        out[y * stride:(y + 1) * stride] = line
        prev = line

    return width, height, out


def write_rgba(path: Path, width: int, height: int, buf: bytearray) -> int:
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # filter: None. The artwork is flat colour; zlib copes.
        rows += buf[y * width * 4:(y + 1) * width * 4]

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    return len(png)


# ---------------------------------------------------------------------------
# Transforms
# ---------------------------------------------------------------------------

def content_box(width: int, height: int, buf: bytearray) -> tuple[int, int, int, int]:
    """The artwork's alpha bounding box, as (x0, y0, w, h)."""
    stride = width * 4
    x0, y0, x1, y1 = width, height, -1, -1
    for y in range(height):
        row = y * stride
        for x in range(width):
            if buf[row + x * 4 + 3] > CROP_ALPHA:
                x0 = min(x0, x)
                x1 = max(x1, x)
                y0 = min(y0, y)
                y1 = max(y1, y)
    if x1 < 0:
        raise SystemExit("the master is fully transparent")
    return x0, y0, x1 - x0 + 1, y1 - y0 + 1


def resize(
    src: bytearray, stride: int, box: tuple[int, int, int, int], out_w: int
) -> tuple[int, bytearray]:
    """Box-filter downscale of `box` to `out_w`, in PREMULTIPLIED alpha.

    Premultiplying is not optional. Transparent pixels in the master carry RGB
    0, so averaging straight RGBA drags every edge toward black and draws a dark
    halo round each letter.
    """
    bx, by, bw, bh = box
    out_h = max(1, round(bh * out_w / bw))
    out = bytearray(out_w * out_h * 4)

    for oy in range(out_h):
        sy0 = by + oy * bh // out_h
        sy1 = max(sy0 + 1, by + (oy + 1) * bh // out_h)
        for ox in range(out_w):
            sx0 = bx + ox * bw // out_w
            sx1 = max(sx0 + 1, bx + (ox + 1) * bw // out_w)
            sr = sg = sb = sa = n = 0
            for sy in range(sy0, sy1):
                base = sy * stride
                for sx in range(sx0, sx1):
                    o = base + sx * 4
                    a = src[o + 3]
                    sr += src[o] * a
                    sg += src[o + 1] * a
                    sb += src[o + 2] * a
                    sa += a
                    n += 1
            o = (oy * out_w + ox) * 4
            if sa:
                out[o] = min(255, sr // sa)
                out[o + 1] = min(255, sg // sa)
                out[o + 2] = min(255, sb // sa)
            out[o + 3] = sa // n

    return out_h, out


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    if x <= edge0:
        return 0.0
    if x >= edge1:
        return 1.0
    t = (x - edge0) / (edge1 - edge0)
    return t * t * (3 - 2 * t)


def for_dark_theme(buf: bytearray) -> bytearray:
    """Lift the neutrals into the light half; leave the brand colour alone."""
    out = bytearray(buf)
    for o in range(0, len(out), 4):
        if out[o + 3] == 0:
            continue
        r, g, b = out[o], out[o + 1], out[o + 2]
        hi, lo = max(r, g, b), min(r, g, b)
        saturation = 0.0 if hi == 0 else (hi - lo) / hi
        keep = smoothstep(SAT_LOW, SAT_HIGH, saturation)  # 1 = brand colour
        if keep < 1.0:
            for k, v in enumerate((r, g, b)):
                out[o + k] = round(max(v, 255 - v) * (1 - keep) + v * keep)
    return out


# ---------------------------------------------------------------------------

def main() -> None:
    master = Path(sys.argv[1]) if len(sys.argv) > 1 else MASTER
    if not master.exists():
        raise SystemExit(f"{master}: not found")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    width, height, buf = read_rgba(master)
    box = content_box(width, height, buf)
    out_h, light = resize(buf, width * 4, box, OUT_WIDTH)
    dark = for_dark_theme(light)

    light_bytes = write_rgba(OUT_DIR / "honeycomb-logo.png", OUT_WIDTH, out_h, light)
    dark_bytes = write_rgba(OUT_DIR / "honeycomb-logo-dark.png", OUT_WIDTH, out_h, dark)

    print(f"master   {width} x {height}  ({master})")
    print(f"content  {box[2]} x {box[3]} at ({box[0]}, {box[1]})"
          f"  — trimmed {width - box[2]} x {height - box[3]}")
    print(f"written  {OUT_WIDTH} x {out_h}, ratio {OUT_WIDTH / out_h:.3f}:1")
    print(f"         honeycomb-logo.png       {light_bytes // 1024} kB")
    print(f"         honeycomb-logo-dark.png  {dark_bytes // 1024} kB")
    print()
    print("If the ratio changed, update --app-logo-ratio in src/ui/App.css.")


if __name__ == "__main__":
    main()
