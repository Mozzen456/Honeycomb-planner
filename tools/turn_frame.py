#!/usr/bin/env python3
"""
One-shot migration: re-express every stored footprint in the flat-top frame.

The wall was drawn pointy-top, 90 degrees from the designer's own drawings
(DECISIONS D31/D35). Turning it means every cell label in the generated
catalogue has to move with it.

This is a RELABEL, not a rescan. It touches no mesh and runs no slicer, so the
committed `print` estimates and their provenance survive byte-for-byte, and this
machine's PrusaSlicer profile hash is never baked into the catalogue. That is
the whole reason it exists as a migration rather than `scan.py --rescan`.

    (q, r)  ->  (-r, q + r)

That map is pinned by experiment, not chosen -- see GOAL.md. The obvious
`(q, r) -> (r, q)` swap is a MIRROR (determinant -1) and would flip every chiral
panel invisibly until printed. Of the two true rotations, this is the one that
reproduces all seven measured panel footprints; the other fails on `mk3s`.

Idempotent it is NOT -- running it twice turns the catalogue 180 degrees. It
writes a marker into the catalogue's `frame` field and refuses to run again.
"""

from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CATALOG = ROOT / "src" / "catalog" / "catalog.json"
FRAME = "flat-top-v1"


def turn(cell: dict) -> dict:
    """The pinned rotation. A cell's own keys are preserved; only q and r move."""
    q, r = cell["q"], cell["r"]
    out = dict(cell)
    out["q"], out["r"] = -r, q + r
    return out


def main() -> int:
    with open(CATALOG, encoding="utf-8", newline="") as fh:
        raw = fh.read()
    doc = json.loads(raw)

    if doc.get("frame") == FRAME:
        print(f"already {FRAME}; refusing to turn it again", file=sys.stderr)
        return 1

    turned = 0
    for part in doc["parts"]:
        if isinstance(part.get("footprint"), list):
            part["footprint"] = [turn(c) for c in part["footprint"]]
            turned += 1
        if isinstance(part.get("anchor"), dict):
            part["anchor"] = turn(part["anchor"])
        # A panel's block is quoted as columns x rows in the frame it was
        # measured in. The turn exchanges the two axes, so the counts swap with
        # them -- 8 columns of 7 becomes 7 columns of 8.
        panel = part.get("panel")
        if isinstance(panel, dict) and "columns" in panel and "rows" in panel:
            panel["columns"], panel["rows"] = panel["rows"], panel["columns"]
        # widthMm/heightMm are the printed BED footprint, not the wall footprint
        # (CLAUDE.md: two frames, and confusing them is the classic bug). The bed
        # does not turn when the wall does, so they are deliberately untouched.

    doc["frame"] = FRAME

    # `json.dumps` with the scanner's own settings, so the diff shows only what
    # actually changed rather than the whole file's formatting.
    #
    # And written back with the line ending the file already had. This repo came
    # off Windows and the committed catalogue is CRLF; writing LF rewrites all
    # 7315 lines and buries 1902 real coordinate changes in a 14631-line diff
    # that nobody can review.
    text = json.dumps(doc, indent=1, sort_keys=True) + "\n"
    if raw.count("\r\n") > raw.count("\n") / 2:
        text = text.replace("\n", "\r\n")
    with open(CATALOG, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    print(f"turned {turned} footprints into the {FRAME} frame")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
