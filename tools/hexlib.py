"""Shared mesh-measurement primitives.

Everything here reads triangle corners. Flat features (hexagon vertices, panel
edges) come out exact; anything curved is faceted, so circles get *fitted* and
the residual is reported rather than swallowed.
"""
from __future__ import annotations

import math
import pathlib
from dataclasses import dataclass, field

import numpy as np
import trimesh

ROOT = pathlib.Path(__file__).resolve().parent.parent
MODELS = ROOT / "models"

# Vertices that land within this of each other are the same feature. STL stores
# float32, so ~1e-4 mm of quantisation noise is expected and harmless.
EPS = 1e-3


def load(path: str | pathlib.Path) -> trimesh.Trimesh:
    p = pathlib.Path(path)
    if not p.is_absolute():
        p = ROOT / p
    mesh = trimesh.load_mesh(p, process=False)
    if isinstance(mesh, trimesh.Scene):
        mesh = mesh.dump(concatenate=True)
    return mesh


def z_levels(mesh: trimesh.Trimesh, tol: float = EPS) -> list[tuple[float, int]]:
    """Distinct z planes present in the vertex cloud, with populations.

    A step in this histogram is a real ledge in the part -- this is how the
    stepped hexagon hole (full cell in front, insert shelf behind) shows up.
    """
    z = np.sort(mesh.vertices[:, 2])
    out: list[tuple[float, int]] = []
    start = 0
    for i in range(1, len(z) + 1):
        if i == len(z) or z[i] - z[start] > tol:
            out.append((float(np.mean(z[start:i])), i - start))
            start = i
    return out


def section_polygons(mesh: trimesh.Trimesh, z: float):
    """Cross-section at height z -> list of shapely polygons (with interiors)."""
    sec = mesh.section(plane_origin=[0, 0, z], plane_normal=[0, 0, 1])
    if sec is None:
        return []
    planar, _ = sec.to_planar(
        to_2D=np.eye(4), check=False
    )
    return list(planar.polygons_full)


@dataclass
class Hexagon:
    """A hexagonal ring recovered from a cross-section."""

    centre: np.ndarray
    corners: np.ndarray  # (6,2) ordered
    across_corners: float
    across_flats: float
    side: float
    rotation_deg: float  # angle of the first corner, normalised into [0, 60)
    regularity: float  # max deviation of corner radii from the mean, mm

    def as_dict(self) -> dict:
        return {
            "centre": [round(float(v), 4) for v in self.centre],
            "across_corners": round(self.across_corners, 4),
            "across_flats": round(self.across_flats, 4),
            "side": round(self.side, 4),
            "rotation_deg": round(self.rotation_deg, 4),
            "regularity_mm": round(self.regularity, 6),
        }


def ring_to_hexagon(coords: np.ndarray) -> Hexagon | None:
    """Interpret a closed ring as a regular hexagon, or return None.

    Collinear points are dropped first: a section can split an edge without
    changing the shape, so a 'hexagon' may arrive with 7-12 vertices.
    """
    pts = np.asarray(coords, dtype=float)[:, :2]
    if len(pts) > 1 and np.allclose(pts[0], pts[-1], atol=EPS):
        pts = pts[:-1]
    pts = _drop_collinear(pts)
    if len(pts) != 6:
        return None

    centre = pts.mean(axis=0)
    rel = pts - centre
    radii = np.linalg.norm(rel, axis=1)
    regularity = float(radii.max() - radii.min())
    R = float(radii.mean())

    # A six-sided polygon is not a hexagon. Without this gate an L-shaped hook
    # profile that happens to have six corners reads as a cell-sized hexagon and
    # invents a mating feature that is not there.
    if R < 1e-6 or regularity > max(0.02 * R, 0.01):
        return None

    angles = np.degrees(np.arctan2(rel[:, 1], rel[:, 0]))
    rot = float(np.min(np.mod(angles, 60.0)))

    # Edge lengths give the side directly; across-flats from the apothem so we
    # never assume regularity we have not measured.
    edges = np.linalg.norm(np.roll(pts, -1, axis=0) - pts, axis=1)
    side = float(edges.mean())
    apothems = []
    for i in range(6):
        a, b = pts[i], pts[(i + 1) % 6]
        d = b - a
        n = np.array([-d[1], d[0]]) / np.linalg.norm(d)
        apothems.append(abs(float(np.dot(centre - a, n))))
    across_flats = 2.0 * float(np.mean(apothems))

    # Second gate: a regular hexagon has across_corners / across_flats = 2/sqrt(3).
    if abs((2.0 * R) / across_flats - 2 / math.sqrt(3)) > 0.01:
        return None
    # Third gate: equal sides.
    if edges.max() - edges.min() > max(0.02 * side, 0.01):
        return None

    return Hexagon(centre, pts, 2.0 * R, across_flats, side, rot, regularity)


def _drop_collinear(pts: np.ndarray, tol: float = 1e-4) -> np.ndarray:
    keep = []
    n = len(pts)
    for i in range(n):
        a, b, c = pts[i - 1], pts[i], pts[(i + 1) % n]
        cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        if abs(cross) > tol:
            keep.append(b)
    return np.asarray(keep)


@dataclass
class CircleFit:
    centre: np.ndarray
    radius: float
    residual_max: float
    residual_rms: float
    n_points: int
    inscribed_radius: float  # what a facetted polygon actually clears

    def as_dict(self) -> dict:
        return {
            "centre": [round(float(v), 4) for v in self.centre],
            "fit_radius": round(self.radius, 4),
            "fit_diameter": round(2 * self.radius, 4),
            "inscribed_diameter": round(2 * self.inscribed_radius, 4),
            "residual_max_mm": round(self.residual_max, 5),
            "residual_rms_mm": round(self.residual_rms, 5),
            "n_points": self.n_points,
        }


def fit_circle(pts: np.ndarray) -> CircleFit:
    """Algebraic (Kasa) circle fit + residuals.

    A screw hole in an STL is a 16-to-64-gon. The circumscribed fit radius is
    what the CAD nominal was; the inscribed radius is what a bolt actually
    passes through. Both are reported because they differ by up to 2% and that
    is the difference between an M3 clearance hole and an M3 tap.
    """
    p = np.asarray(pts, dtype=float)[:, :2]
    A = np.c_[2 * p[:, 0], 2 * p[:, 1], np.ones(len(p))]
    b = (p ** 2).sum(axis=1)
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    cx, cy = sol[0], sol[1]
    r = math.sqrt(max(sol[2] + cx * cx + cy * cy, 0.0))
    centre = np.array([cx, cy])
    d = np.linalg.norm(p - centre, axis=1)
    resid = d - r
    # Inscribed radius: shortest distance from centre to any chord.
    ins = r
    for i in range(len(p)):
        a, c = p[i], p[(i + 1) % len(p)]
        seg = c - a
        L = np.linalg.norm(seg)
        if L < 1e-9:
            continue
        n = np.array([-seg[1], seg[0]]) / L
        ins = min(ins, abs(float(np.dot(centre - a, n))))
    return CircleFit(
        centre,
        r,
        float(np.abs(resid).max()),
        float(np.sqrt((resid ** 2).mean())),
        len(p),
        float(ins),
    )


@dataclass
class Lattice:
    """A 2D lattice fitted to a whole field of hexagon centres."""

    origin: np.ndarray
    a: np.ndarray  # basis vector 1 (per +q step)
    b: np.ndarray  # basis vector 2 (per +r step)
    indices: np.ndarray  # (n,2) integer (q, r) per input centre
    residual_max: float
    residual_rms: float
    n: int
    extra: dict = field(default_factory=dict)


def fit_lattice(centres: np.ndarray) -> Lattice | None:
    """Fit centre_i ~= origin + q_i*a + r_i*b over ALL centres at once.

    This is the whole point of measuring a full panel rather than one hexagon:
    a per-cell measurement times 28 accumulates error, a global least-squares
    fit averages it away and tells you the residual so you know whether the
    lattice is actually regular.
    """
    pts = np.asarray(centres, dtype=float)[:, :2]
    if len(pts) < 3:
        return None
    seed = pts[np.lexsort((pts[:, 0], pts[:, 1]))][0]
    rel = pts - seed

    # Candidate basis vectors: every nearest-neighbour-length step, folded into
    # the upper half plane so v and -v do not both appear.
    d = np.linalg.norm(pts[:, None, :] - pts[None, :, :], axis=-1)
    np.fill_diagonal(d, np.inf)
    nn = float(d.min())
    steps = []
    for i, j in zip(*np.where(d <= nn * 1.05)):
        v = pts[j] - pts[i]
        if v[1] < -1e-6 or (abs(v[1]) <= 1e-6 and v[0] < 0):
            continue
        steps.append(v)
    if not steps:
        return None
    steps = np.unique(np.round(np.asarray(steps), 3), axis=0)

    # Pick the pair spanning the largest area -- the least degenerate basis.
    a = b = None
    best_area = 0.0
    for i in range(len(steps)):
        for j in range(i + 1, len(steps)):
            area = abs(steps[i, 0] * steps[j, 1] - steps[i, 1] * steps[j, 0])
            if area > best_area:
                best_area, a, b = area, steps[i], steps[j]
    if a is None or best_area < 1e-3 * nn * nn:
        return None

    idx = None
    for _ in range(8):
        M = np.c_[a, b]
        if abs(np.linalg.det(M)) < 1e-9:
            return None
        idx = np.rint(np.linalg.solve(M, rel.T).T)
        # Re-solve for origin + basis given integer indices (linear LSQ).
        A = np.c_[np.ones(len(pts)), idx]
        if np.linalg.matrix_rank(A) < 3:
            return None
        sol, *_ = np.linalg.lstsq(A, pts, rcond=None)
        origin, a, b = sol[0], sol[1], sol[2]
        rel = pts - origin

    pred = origin + idx @ np.vstack([a, b])
    err = np.linalg.norm(pts - pred, axis=1)
    return Lattice(
        origin,
        a,
        b,
        idx.astype(int),
        float(err.max()),
        float(np.sqrt((err ** 2).mean())),
        len(pts),
    )
