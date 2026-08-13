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

    # One part where the fresh detection in the new frame does NOT agree with a
    # blind rotation of its old footprint. `src/core/detect.ts` is the authority
    # -- catalog.json is generated from it -- so its answer is carried here
    # explicitly rather than silently left wrong.
    #
    # 50 of the 51 parts agree with the rotation exactly, which is the evidence
    # that the rotation itself is right. This one is a 3-cell triangle, and a
    # triangle has no 180-degree symmetry, so the two candidate placements are
    # genuinely different cell sets rather than the same set relabelled. Verified
    # by running detect() over all 51 models and diffing: exactly one changed.
    DETECTOR_WINS = {
        "insert-hollow-tre": [{"q": 0, "r": 0}, {"q": 0, "r": 1}, {"q": 1, "r": 0}],
    }

    turned = 0
    for part in doc["parts"]:
        if isinstance(part.get("footprint"), list) and part["footprint"]:
            cells = [turn(c) for c in part["footprint"]]
            # Re-normalised COLUMN-major, the (q, r)-least cell to the origin.
            #
            # Not optional. The rotation fixes (0, 0), but the OLD footprints were
            # normalised row-major -- the (r, q)-least cell at the origin -- and a
            # rotation does not preserve which cell that is. `toAxial` in
            # detect.ts normalises with this same rule, and tests/detect.test.ts
            # compares the two EXACTLY, not up to a translation. Skip this and the
            # detector and the catalogue disagree by a shift on most parts.
            cells.sort(key=lambda c: (c["q"], c["r"]))
            base = cells[0]
            bq, br = base["q"], base["r"]
            for c in cells:
                c["q"] -= bq
                c["r"] -= br
            override = DETECTOR_WINS.get(part.get("id"))
            part["footprint"] = override if override is not None else cells
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
