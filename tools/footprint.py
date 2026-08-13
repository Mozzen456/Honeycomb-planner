"""Work out which lattice cells a part occupies, from its geometry.

Three tiers, because this model family has three genuinely different kinds of part
and pretending otherwise invents data:

  1. PANEL      -- many hexagonal bores on a 23.6 mm lattice. Cells come from a
                   least-squares lattice fit over every bore centre.
  2. WALL-CLIP  -- carries the HSW wall interface (22.5 mm flange / 19.7 mm body).
                   Cells come from testing lattice points against the FILLED
                   silhouette of the mating band. Filled matters: a cell centre
                   usually sits inside a bore, so an unfilled test rejects it.
  3. INSERT-FED -- no wall interface at all. These bolt or plug into an insert
                   (M3/M4/M5, or the 13.4 / 18.5 mm hexagonal socket inside the
                   insert family). Their cell span is bounded from the bounding
                   box and FLAGGED for review rather than asserted.

Parts are drawn lying on whichever face suited the print bed, so all three axes
are tried as the candidate wall normal.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import trimesh
from shapely.geometry import Polygon as ShapelyPolygon
from shapely.ops import unary_union

from hexlib import fit_lattice, ring_to_hexagon, section_polygons, z_levels

PITCH = 23.6
ROW = 20.438

# Across-flats widths that mean "this mates with the wall".
WALL_INTERFACE = (22.5, 22.02, 20.735, 20.0, 19.7, 22.0)
# Widths that mean "this mates with an insert, not the wall" (second tier).
INSERT_SOCKET = (18.5, 16.5, 13.4, 11.4, 5.8)
TOL = 0.45

ENV_CORNERS = 25.9808   # one cell's flange envelope, across corners
ENV_FLATS = 22.5        # ... and across flats


@dataclass
class Footprint:
    cells: list[tuple[int, int]]
    drawn_orientation: str      # 'pointy' | 'flat' | 'n/a'
    mating_axis: str
    tier: str                   # 'panel' | 'wall-clip' | 'insert-fed' | 'unknown'
    method: str
    confidence: float
    needs_review: bool = False
    notes: list[str] = field(default_factory=list)
    interface_widths: list[float] = field(default_factory=list)
    socket_widths: list[float] = field(default_factory=list)


def _near(w: float, table) -> bool:
    return any(abs(w - t) <= TOL for t in table)


def _oriented(mesh: trimesh.Trimesh, axis: int) -> trimesh.Trimesh:
    if axis == 2:
        return mesh
    m = mesh.copy()
    if axis == 0:
        m.apply_transform(trimesh.transformations.rotation_matrix(-math.pi / 2, [0, 1, 0]))
    else:
        m.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [1, 0, 0]))
    return m


def _bands(mesh: trimesh.Trimesh, min_thick: float = 0.05) -> list[tuple[float, float]]:
    levels = [z for z, _ in z_levels(mesh)]
    out = []
    for i in range(len(levels) - 1):
        t = levels[i + 1] - levels[i]
        if t > min_thick:
            out.append((t, (levels[i] + levels[i + 1]) / 2))
    out.sort(reverse=True)
    return out


def _hexes_at(polys) -> list:
    found = []
    for poly in polys:
        for ring in [poly.exterior, *poly.interiors]:
            h = ring_to_hexagon(np.asarray(ring.coords))
            if h is not None:
                found.append(h)
    return found


def _filled(polys):
    """Union of the polygons with their holes filled — the true silhouette."""
    return unary_union([ShapelyPolygon(p.exterior) for p in polys])


def _orientation(rots) -> str | None:
    near0 = sum(1 for r in rots if min(r % 60, 60 - (r % 60)) < 4)
    near30 = sum(1 for r in rots if abs((r % 60) - 30) < 4)
    if near0 > near30:
        return "flat"
    if near30 > near0:
        return "pointy"
    return None


def _basis(drawn: str):
    """Lattice basis and single-cell envelope for the drawn orientation.

    Using two basis vectors rather than a row/column loop removes the stagger
    parity ambiguity entirely — every integer combination is a real cell.
    """
    if drawn == "flat":
        return (ROW, PITCH / 2), (0.0, PITCH), ENV_CORNERS, ENV_FLATS
    return (PITCH, 0.0), (PITCH / 2, ROW), ENV_FLATS, ENV_CORNERS


def _cells_from_anchor(sil, drawn: str, x0: float, y0: float):
    e1, e2, _ex, _ey = _basis(drawn)
    minx, miny, maxx, maxy = sil.bounds
    span = max(maxx - minx, maxy - miny)
    n = int(span / min(PITCH, ROW)) + 3

    out = []
    for i in range(-n, n + 1):
        for j in range(-n, n + 1):
            cx = x0 + i * e1[0] + j * e2[0]
            cy = y0 + i * e1[1] + j * e2[1]
            if not (minx - 0.5 <= cx <= maxx + 0.5 and miny - 0.5 <= cy <= maxy + 0.5):
                continue
            # Require most of the cell to be covered, so a cell merely clipped by
            # a connecting web does not count as occupied.
            probe = ShapelyPolygon(_hex_pts(cx, cy, ENV_FLATS * 0.62, drawn))
            if sil.intersection(probe).area >= 0.80 * probe.area:
                out.append((cx, cy))
    return out


PHASE_STEPS = 10


def _cells_in_silhouette(sil, drawn: str) -> list[tuple[float, float]]:
    """Lattice cells covered by the silhouette, with the phase SOLVED for.

    Every shortcut for guessing the phase turned out to be wrong on real parts:

      - "the lowest-left cell touches both bbox edges" fails whenever the part
        staggers downward to the right;
      - "inset the bbox corner by half the flange envelope" fails on any band
        that is not the flange, because the body hexagon is 19.7 mm across, not
        22.5 — and the body band is exactly the one where merged flanges
        separate into countable cells.

    Both failures look identical from the outside: every probe lands on a cell
    wall and the part reports zero cells rather than an error. So rather than
    guess, sweep the phase across one fundamental domain and keep the phase that
    explains the silhouette best. It costs ~100 polygon tests per band and it
    removes a whole family of silent wrong answers.
    """
    e1, e2, _ex, _ey = _basis(drawn)
    best: list[tuple[float, float]] = []
    best_key = (-1, -1.0)

    minx, miny, maxx, maxy = sil.bounds
    for ia in range(PHASE_STEPS):
        for ib in range(PHASE_STEPS):
            a, b = ia / PHASE_STEPS, ib / PHASE_STEPS
            x0 = minx + a * e1[0] + b * e2[0]
            y0 = miny + a * e1[1] + b * e2[1]
            pts = _cells_from_anchor(sil, drawn, x0, y0)
            if not pts:
                continue
            union = unary_union([ShapelyPolygon(_hex_pts(cx, cy, ENV_FLATS, drawn))
                                 for cx, cy in pts])
            fill = sil.intersection(union).area / max(union.area, 1e-9)
            key = (len(pts), round(fill, 3))
            if key > best_key:
                best_key, best = key, pts
    return best


def _hex_pts(cx: float, cy: float, across_flats: float, drawn: str):
    R = across_flats / math.sqrt(3)
    phase = 0.0 if drawn == "flat" else 30.0
    return [
        (cx + R * math.cos(math.radians(60 * k + phase)),
         cy + R * math.sin(math.radians(60 * k + phase)))
        for k in range(6)
    ]


def _to_axial(pts, drawn: str):
    if not pts:
        return None
    arr = np.asarray(pts, dtype=float)
    if drawn == "pointy":
        # A POINTY-drawn part must be spun 90 degrees to sit on a flat-top wall.
        # Physical requirement, not bookkeeping. It was the flat-drawn part that
        # needed spinning while the wall was pointy -- the rule did not change,
        # the wall did (DECISIONS D35).
        arr = np.c_[-arr[:, 1], arr[:, 0]]
    arr = arr - arr[0]
    # The inverse of hexToMm, flat-top: columns step ROW across, cells step PITCH
    # down a column, each column half a PITCH off its neighbour. Must stay
    # identical to `toAxial` in src/core/detect.ts -- tests/detect.test.ts holds
    # the two to the same answer on all 51 shipped models.
    q = arr[:, 0] / ROW
    r = arr[:, 1] / PITCH - q / 2
    ri, qi = np.rint(r), np.rint(q)
    if len(arr) > 1 and (np.abs(r - ri).max() > 0.2 or np.abs(q - qi).max() > 0.2):
        return None
    # Normalised COLUMN-major, the (q, r)-least cell to the origin.
    cells = sorted({(int(a), int(b)) for a, b in zip(qi, ri)}, key=lambda c: (c[0], c[1]))
    a0 = cells[0]
    return sorted(((a - a0[0], b - a0[1]) for a, b in cells), key=lambda c: (c[0], c[1]))


# ---------------------------------------------------------------------------

def _try_panel(mesh, axis_name) -> Footprint | None:
    """Many hexagonal bores on the lattice => a panel. Fit them all at once."""
    for _thick, z in _bands(mesh)[:8]:
        try:
            polys = section_polygons(mesh, z)
        except Exception:
            continue
        if not polys:
            continue
        outer = max(polys, key=lambda p: p.area)
        hexes = [h for h in (ring_to_hexagon(np.asarray(r.coords)) for r in outer.interiors)
                 if h is not None and _near(h.across_flats, WALL_INTERFACE)]
        if len(hexes) < 3:
            continue
        centres = np.array([h.centre for h in hexes])
        lat = fit_lattice(centres)
        if lat is None or lat.residual_max > 0.01:
            continue
        drawn = _orientation([h.rotation_deg for h in hexes])
        if drawn is None:
            continue
        cells = _to_axial([tuple(c) for c in centres], drawn)
        if cells is None or len(cells) != len(centres):
            continue
        return Footprint(
            cells, drawn, axis_name, "panel", "lattice-fit", 0.99,
            notes=[f"{len(centres)} hexagonal bores, lattice residual "
                   f"{lat.residual_max:.2e} mm at pitch {np.linalg.norm(lat.a):.5f}"],
            interface_widths=sorted({round(h.across_flats, 3) for h in hexes}),
        )
    return None


def envelope_block(sx: float, sy: float) -> tuple[str, int, int] | None:
    """Does this bounding box decompose onto the cell lattice exactly?

    This is the gate for "is this a wall-clipping part", and it is a far sharper
    test than any area comparison. A cell's flange envelope is 25.9808 across
    corners by 22.5 across flats, and every extra cell adds a whole lattice step
    along one axis and a HALF pitch along the other (the stagger). So a genuine
    multi-cell part has a bounding box of exactly

        flat-drawn:   25.9808 + a·20.438   by   22.5 + b·11.8
        pointy-drawn: 22.5    + a·11.8     by   25.9808 + b·20.438

    for non-negative integers a, b. Real parts hit this to within 0.03 mm; a
    storage box or a shelf misses it by millimetres. Area-overlap scoring cannot
    tell those apart, because a plain rectangle is ~70% coverable by hexagons.
    """
    for drawn, ex, ey, stepx, stepy in (
        ("flat", ENV_CORNERS, ENV_FLATS, ROW, PITCH / 2),
        ("pointy", ENV_FLATS, ENV_CORNERS, PITCH / 2, ROW),
    ):
        a, b = (sx - ex) / stepx, (sy - ey) / stepy
        if a < -0.03 or b < -0.03:
            continue
        ra, rb = round(a), round(b)
        if abs(a - ra) < 0.03 and abs(b - rb) < 0.03:
            return drawn, ra, rb
    return None


def _try_wall_clip(mesh, axis_name) -> Footprint | None:
    """Cells of a part whose bounding box decomposes onto the lattice.

    The bbox gate says the part IS a wall clip and fixes its orientation; the
    silhouette containment then says which cells inside that block are actually
    filled, which is what distinguishes an L-shaped 3-cell insert from the 2x2
    block that bounds it.
    """
    lo, hi = mesh.bounds
    gate = envelope_block(float(hi[0] - lo[0]), float(hi[1] - lo[1]))
    if gate is None:
        return None
    gate_drawn, ga, gb = gate

    best = None
    for _thick, z in _bands(mesh)[:14]:
        try:
            polys = section_polygons(mesh, z)
        except Exception:
            continue
        if not polys:
            continue
        sil = _filled(polys)
        if sil.is_empty or sil.area < 100:
            continue

        pts = _cells_in_silhouette(sil, gate_drawn)
        if not pts:
            continue
        union = unary_union([ShapelyPolygon(_hex_pts(cx, cy, ENV_FLATS, gate_drawn))
                             for cx, cy in pts])
        inter = sil.intersection(union).area
        covers_hex = inter / union.area   # the part actually fills those hexagons
        if covers_hex < 0.70:
            continue
        score = (len(pts), round(covers_hex, 3))
        if best is None or score > best[0]:
            best = (score, z, pts, covers_hex, _hexes_at(polys))
    if best is None:
        return None

    _score, z, pts, ch, hexes = best
    cells = _to_axial(pts, gate_drawn)
    if not cells:
        return None

    widths = sorted({round(h.across_flats, 3) for h in hexes
                     if _near(h.across_flats, WALL_INTERFACE)})
    conf = 0.97 if widths else 0.9
    notes = [f"bbox decomposes exactly onto the lattice "
             f"({gate_drawn}-drawn, {ga}+1 x {gb}+1 half-steps); "
             f"mating face on {axis_name} at z={z:.3f}; "
             f"{len(cells)} cell(s) filled, hexagons {ch*100:.1f}% solid"]
    if widths:
        notes.append(f"wall interface hexagons present at {widths} mm across flats")
    return Footprint(cells, gate_drawn, axis_name, "wall-clip", "bbox-gate+silhouette",
                     conf, notes=notes, interface_widths=widths)


def _sockets(mesh) -> list[float]:
    found = set()
    for axis in (2, 0, 1):
        m = _oriented(mesh, axis)
        for _t, z in _bands(m)[:12]:
            try:
                polys = section_polygons(m, z)
            except Exception:
                continue
            for h in _hexes_at(polys):
                if _near(h.across_flats, INSERT_SOCKET):
                    found.add(round(h.across_flats, 2))
    return sorted(found)


def _span_bound(size3) -> tuple[int, str, list[str]]:
    """Upper bound on how many cells a part could span, from its bbox.

    Deliberately a BOUND, not an answer: an insert-fed part gives no geometric
    clue which cells its mounting screws land in.
    """
    sx, sy, sz = sorted(size3, reverse=True)
    longest = sx
    n = max(1, int(math.ceil((longest - ENV_CORNERS) / ROW)) + 1) if longest > ENV_CORNERS else 1
    return n, "bbox-span", [
        f"no wall interface; longest bbox edge {longest:.2f} mm spans at most "
        f"{n} cell(s) at {ROW:.3f} mm per step"
    ]


def detect(mesh: trimesh.Trimesh) -> Footprint:
    size3 = tuple(float(v) for v in (mesh.bounds[1] - mesh.bounds[0]))

    for axis, name in ((2, "z"), (0, "x"), (1, "y")):
        m = _oriented(mesh, axis)
        fp = _try_panel(m, name)
        if fp is not None:
            return fp

    candidates = []
    for axis, name in ((2, "z"), (0, "x"), (1, "y")):
        m = _oriented(mesh, axis)
        fp = _try_wall_clip(m, name)
        if fp is not None:
            candidates.append(fp)
    if candidates:
        fp = max(candidates, key=lambda f: len(f.cells))
        fp.socket_widths = _sockets(mesh)
        if fp.socket_widths:
            fp.notes.append(f"also carries insert-side socket(s) at {fp.socket_widths} mm "
                            f"-- accessories plug into this part")
        return fp

    # Tier 3: mounts via an insert. Bound the span; do not invent the cells.
    sockets = _sockets(mesh)
    n, method, notes = _span_bound(size3)
    if sockets:
        notes.append(f"plugs into an insert socket at {sockets} mm across flats")
    else:
        notes.append("no hexagonal interface of any size found; likely screws to "
                     "an insert via an M3/M4/M5 hole")
    notes.append("FLAGGED: cell footprint is a bound from the bounding box, not a "
                 "measurement. Confirm before relying on it.")
    # Laid down a COLUMN, matching insertFed in src/core/detect.ts. The bound is
    # rotated with everything else by the frame turn (D35) rather than
    # special-cased, so tools/turn_frame.py could relabel all 51 parts with one
    # rule and no knowledge of tier.
    cells = [(0, i) for i in range(n)]
    return Footprint(cells, "n/a", "n/a", "insert-fed", method, 0.35,
                     needs_review=True, notes=notes, socket_widths=sockets)
