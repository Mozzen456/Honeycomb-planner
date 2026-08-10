"""Catalogue scanner.

    python tools/scan.py            # measure new/changed files, append, keep the rest
    python tools/scan.py --rescan   # ignore the cache and re-measure everything
    python tools/scan.py --no-slice # skip slicing (fast; marks estimates as stale)
    python tools/scan.py --verify   # re-derive and diff against the committed catalogue

Design rules, because this has to still work when more STLs are dropped in:

  * Nothing is hand-written. `src/catalog/catalog.json` is generated.
  * Anything the scanner cannot confidently classify goes to UNKNOWN.md with the
    evidence, and its catalogue entry is marked `needsReview`. It is never
    quietly invented.
  * Human corrections live in `src/catalog/overrides.json`, which the scanner
    reads and never writes. A correction therefore survives every future rescan.
  * The output contains no wall-clock timestamp unless the content changed, so
    "re-run from scratch and diff" is a byte-for-byte check.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import re
import sys
from datetime import datetime, timezone

import numpy as np

import footprint as fpmod
import slicer as slicemod
from hexlib import MODELS, ROOT, fit_circle, load, ring_to_hexagon, section_polygons, z_levels

SCHEMA_VERSION = 1
SCANNER_VERSION = "1.1.0"
# Bumped whenever the measurement code changes meaning. The cache keys on it, so
# a logic fix invalidates stale measurements instead of silently keeping them.
MEASURE_VERSION = 3
CATALOG = ROOT / "src" / "catalog" / "catalog.json"
OVERRIDES = ROOT / "src" / "catalog" / "overrides.json"
CACHE = ROOT / "build" / "measure-cache.json"
UNKNOWN_MD = ROOT / "UNKNOWN.md"

BEDS = [
    ("mini", 180, 180), ("bed220", 220, 220), ("bed235", 235, 235),
    ("mk3s", 250, 210), ("bed256", 256, 256), ("bed300", 300, 300),
    ("bed350", 350, 350), ("bed400", 400, 400),
]

# Wall mounting: how many countersunk wall inserts a panel needs. Four corners
# is the minimum that stops a panel rotating; large panels get more so the
# middle cannot bow off the wall. Stated as a rule so it can be argued with.
WALL_MOUNTS_MIN = 4
CELLS_PER_EXTRA_MOUNT = 50

SCREW_BORE_TOL = 0.25
BORE_FAMILIES = [("M3", 3.2), ("M4", 4.2), ("M5", 5.1)]


# ---------------------------------------------------------------------------
# Measurement
# ---------------------------------------------------------------------------

def sha256_of(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def overhang_report(mesh) -> dict:
    """Downward-facing area steeper than 45 deg, excluding the bed face.

    A stated heuristic, not a slicer verdict: a facet whose normal points down
    and lies within 45 deg of straight-down is unprintable without support. The
    raw area is recorded alongside the yes/no so the call can be audited.
    """
    normals = mesh.face_normals
    areas = mesh.area_faces
    zmin = float(mesh.bounds[0][2])
    centroids = mesh.triangles_center
    downward = normals[:, 2] < -math.cos(math.radians(45))
    off_bed = centroids[:, 2] > zmin + 0.25
    mask = downward & off_bed
    area = float(areas[mask].sum())
    total = float(areas.sum())
    return {
        "overhangAreaMm2": round(area, 2),
        "overhangFraction": round(area / total, 5) if total else 0.0,
        "supports": bool(area > 20.0 and area / max(total, 1e-9) > 0.02),
        "method": "facet normal within 45 deg of -Z, excluding the bed face; "
                  "supports if area > 20 mm2 and > 2% of total",
    }


def count_bores(mesh) -> dict[str, int]:
    """Distinct screw bores by metric family, from circle fits.

    Counting every circular cross-section independently is wrong: a countersink
    is a cone, so it presents a different diameter in every band, and its
    mid-cone sections land squarely in the M4 and M5 tolerance windows. That
    made every countersunk wall fastener claim an M5 bolt it does not take.

    So bores are grouped by CENTRE first, and each hole is sized by its narrowest
    section -- the shank hole, which is the only diameter a screw has to pass.
    A hole whose diameter varies is a countersink and is reported as such.
    """
    holes: dict[tuple, list[float]] = {}
    levels = [z for z, _ in z_levels(mesh)]
    for k in range(len(levels) - 1):
        z = (levels[k] + levels[k + 1]) / 2
        if levels[k + 1] - levels[k] < 0.05:
            continue
        try:
            polys = section_polygons(mesh, z)
        except Exception:
            continue
        for poly in polys:
            for ring in poly.interiors:
                pts = np.asarray(ring.coords)
                if len(pts) > 1 and np.allclose(pts[0], pts[-1]):
                    pts = pts[:-1]
                if len(pts) < 12 or ring_to_hexagon(np.asarray(ring.coords)) is not None:
                    continue
                f = fit_circle(pts)
                if f.residual_max > 0.02 * f.radius:
                    continue
                # Cluster by distance, not by rounding the centre: a cone's
                # fitted centre wobbles by a few microns between bands, and
                # rounding to 0.1 mm splits one countersink either side of a
                # boundary into two holes. That is how a one-cell wall insert
                # ended up asking for two wall screws.
                cx, cy = float(f.centre[0]), float(f.centre[1])
                for key in holes:
                    if math.hypot(cx - key[0], cy - key[1]) < 1.0:
                        holes[key].append(2 * f.radius)
                        break
                else:
                    holes[(cx, cy)] = [2 * f.radius]

    counts: dict[str, int] = {}
    for diameters in holes.values():
        shank = min(diameters)
        for tag, nominal in BORE_FAMILIES:
            if abs(shank - nominal) <= SCREW_BORE_TOL:
                counts[tag] = counts.get(tag, 0) + 1
                break
        else:
            if max(diameters) - shank > 0.5:
                counts["countersink"] = counts.get("countersink", 0) + 1
    return counts


def measure(path: pathlib.Path) -> dict:
    mesh = load(path)
    lo, hi = mesh.bounds
    fp = fpmod.detect(mesh)
    return {
        "bboxMm": [round(float(v), 4) for v in (hi - lo)],
        "volumeMm3": round(float(mesh.volume), 3),
        "triangles": int(len(mesh.faces)),
        "watertight": bool(mesh.is_watertight),
        "footprint": [{"q": q, "r": r} for q, r in fp.cells],
        "tier": fp.tier,
        "drawnOrientation": fp.drawn_orientation,
        "matingAxis": fp.mating_axis,
        "detectMethod": fp.method,
        "detectConfidence": round(fp.confidence, 3),
        "needsReview": fp.needs_review,
        "notes": fp.notes,
        "interfaceWidths": fp.interface_widths,
        "socketWidths": fp.socket_widths,
        "bores": count_bores(mesh),
        **overhang_report(mesh),
    }


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def classify(rel: str, group: str, m: dict) -> tuple[str, dict]:
    """Type from geometry and from filename/folder, with disagreements reported."""
    name = pathlib.Path(rel).stem.lower()
    g = group.lower()
    notes: list[str] = []

    if m["tier"] == "panel":
        geo = "panel"
    elif m["tier"] == "wall-clip":
        geo = "insert" if m["bboxMm"][2] <= 12.5 else "accessory"
    else:
        geo = "accessory"

    if "attaching honeycombs to the wall" in g:
        byname = "fastener"
    elif "fasteners and parts" in g:
        byname = "insert"
    elif "wall-honeycomb" in name or re.match(r"^\d+x\d+", name):
        byname = "panel"
    elif g in ("hooks and holders", "shelves", "other parts"):
        byname = "accessory"
    else:
        byname = "unknown"

    # A wall-mount fastener is geometrically an insert; that is agreement, not
    # conflict -- the folder is telling us its PURPOSE, which geometry cannot.
    reconciled = {("insert", "fastener"), ("fastener", "insert")}
    if geo == byname:
        basis, conf = "both", 0.95
        final = geo
    elif (geo, byname) in reconciled:
        basis, conf = "both", 0.9
        final = byname
        notes.append(f"geometry reads as '{geo}', folder says '{byname}'; "
                     f"both are consistent -- folder gives the purpose")
    elif byname == "unknown":
        basis, conf = "geometry", 0.7
        final = geo
        notes.append("filename gives no type; classified from geometry alone")
    else:
        basis, conf = "conflict", 0.45
        final = geo
        notes.append(f"CONFLICT: geometry says '{geo}', filename/folder says "
                     f"'{byname}'. Reporting the geometry result; neither is "
                     f"silently preferred -- see UNKNOWN.md")

    notes.extend(m["notes"])
    return final, {"basis": basis, "confidence": round(conf, 3), "notes": notes}


def requirements(rel: str, ptype: str, m: dict, ids: set[str]) -> tuple[list, list]:
    """Printed inserts this part needs, and bought hardware."""
    name = pathlib.Path(rel).stem.lower()
    requires: list[dict] = []
    hardware: list[dict] = []
    cells = max(1, len(m["footprint"]))
    bores = m.get("bores", {})

    if ptype == "panel":
        n = max(WALL_MOUNTS_MIN, WALL_MOUNTS_MIN + cells // CELLS_PER_EXTRA_MOUNT)
        if "insert-countersunk" in ids:
            requires.append({"partId": "insert-countersunk", "count": n})
            # No hardware here on purpose. The screw and plug belong to the
            # countersunk insert, and the BOM already expands hardware through
            # `requires`. Listing them on the panel as well doubled the shopping
            # list -- 350 inserts asked for 700 screws.
            return requires, hardware
        # No countersunk insert in the catalogue: the panel has to carry the
        # fixings itself or they would go unlisted entirely.
        hardware.append({"item": "Wall screw, 3.5 x 35 mm countersunk", "count": n})
        hardware.append({"item": "Wall plug, 6 mm", "count": n})
        return requires, hardware

    if ptype in ("insert", "fastener"):
        # These ARE the hardware; they only pull in the bolt that suits them.
        # The bolt family comes from the measured shank bore, not the filename:
        # the filename is a hint, the hole is the fact.
        for tag in ("M5", "M4", "M3"):
            if tag in bores:
                n = bores[tag]
                hardware.append({"item": f"{tag} bolt, 10-16 mm", "count": n})
                hardware.append({"item": f"{tag} nut", "count": n})
                break
        n_cs = bores.get("countersink", 0)
        if n_cs == 0 and ("countersunk" in name or "countersung" in name):
            n_cs = 1  # named as one but the cone was not resolved; trust the name
        if n_cs:
            hardware.append({"item": "Wall screw, 3.5 x 35 mm countersunk", "count": n_cs})
            hardware.append({"item": "Wall plug, 6 mm", "count": n_cs})
        return requires, hardware

    # Accessories. A wall-clip accessory needs nothing; an insert-fed one needs
    # an insert per mounting point, chosen by the bore it carries.
    if m["tier"] == "wall-clip":
        return requires, hardware

    for tag in ("M5", "M4", "M3"):
        if tag in bores:
            pid = {"M3": "insert-with-m3", "M4": "insert-m4", "M5": "insert-m5"}[tag]
            if pid in ids:
                requires.append({"partId": pid, "count": bores[tag]})
                hardware.append({"item": f"{tag} bolt, 10-16 mm", "count": bores[tag]})
            break
    else:
        if m.get("socketWidths"):
            if "insert-empty" in ids:
                requires.append({"partId": "insert-empty", "count": cells})
    return requires, hardware


def part_id(rel: str) -> str:
    stem = pathlib.Path(rel).stem
    s = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")
    return s


def panel_block(m: dict) -> dict:
    cells = [(c["q"], c["r"]) for c in m["footprint"]]
    rs = sorted({r for _q, r in cells})
    rows = len(rs)
    columns = max(sum(1 for _q, r in cells if r == rr) for rr in rs) if rs else 0
    w, h = m["bboxMm"][0], m["bboxMm"][1]
    fits = [bid for bid, bw, bd in BEDS
            if (min(w, h) <= min(bw, bd) + 1e-6 and max(w, h) <= max(bw, bd) + 1e-6)]
    return {"columns": columns, "rows": rows,
            "widthMm": round(w, 4), "heightMm": round(h, 4), "fitsBeds": fits}


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def load_json(path: pathlib.Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"  ! could not read {path.name}: {exc!r}; treating as empty")
        return default


def main() -> int:
    ap = argparse.ArgumentParser(description="Scan ./models and build the catalogue.")
    ap.add_argument("--rescan", action="store_true", help="ignore the measurement cache")
    ap.add_argument("--no-slice", action="store_true", help="skip slicing")
    ap.add_argument("--verify", action="store_true",
                    help="rebuild and diff against the committed catalogue")
    args = ap.parse_args()

    cache = {} if args.rescan else load_json(CACHE, {})
    overrides = load_json(OVERRIDES, {})
    files = sorted(MODELS.rglob("*.stl"), key=lambda p: str(p).lower())
    print(f"{len(files)} STL file(s) under models/")

    slicer_exe = None if args.no_slice else slicemod.find_slicer()
    profile = None
    profile_id = "not-sliced"
    if slicer_exe:
        profile = slicemod.build_profile(ROOT / "build" / "hsw-profile.ini", slicer_exe)
        profile_id = f"{slicemod.PROFILE_ID}@{slicemod.profile_hash(profile)}"
        print(f"slicer: {slicer_exe}\nprofile: {profile_id}")
    else:
        print("slicer: NONE -- print estimates will be marked stale")

    ids = {part_id(str(p.relative_to(ROOT))) for p in files}

    measured: dict[str, dict] = {}
    for i, path in enumerate(files, 1):
        rel = str(path.relative_to(ROOT)).replace("\\", "/")
        digest = sha256_of(path)
        entry = cache.get(rel)
        fresh = (entry is not None and entry.get("sha256") == digest
                 and entry.get("measureVersion") == MEASURE_VERSION)
        if fresh and "measure" in entry:
            m = entry["measure"]
        else:
            print(f"  [{i:>2}/{len(files)}] measuring {path.name}")
            try:
                m = measure(path)
            except Exception as exc:
                print(f"        ! measurement failed: {exc!r}")
                m = {"error": repr(exc), "bboxMm": [0, 0, 0], "volumeMm3": 0,
                     "footprint": [{"q": 0, "r": 0}], "tier": "unknown",
                     "drawnOrientation": "n/a", "matingAxis": "n/a",
                     "detectMethod": "failed", "detectConfidence": 0.0,
                     "needsReview": True, "notes": [f"measurement failed: {exc!r}"],
                     "interfaceWidths": [], "socketWidths": [], "bores": {},
                     "overhangAreaMm2": 0, "overhangFraction": 0, "supports": False,
                     "method": "n/a", "triangles": 0, "watertight": False}

        # Slices are cached against the profile as well as the mesh: changing
        # the profile must invalidate every estimate, or the catalogue ends up
        # quietly mixing two profiles under one profile id.
        sl = entry.get("slice") if fresh and entry.get("sliceProfile") == profile_id else None
        if slicer_exe and (sl is None or "error" in (sl or {})):
            print(f"  [{i:>2}/{len(files)}] slicing   {path.name}")
            sl = slicemod.slice_one(path, slicer_exe, profile)
        measured[rel] = {"sha256": digest, "measureVersion": MEASURE_VERSION,
                         "measure": m, "slice": sl, "sliceProfile": profile_id}

    CACHE.parent.mkdir(exist_ok=True)
    CACHE.write_text(json.dumps(measured, indent=1, sort_keys=True), encoding="utf-8")

    parts, unresolved = [], []
    for rel, rec in measured.items():
        m = rec["measure"]
        path = ROOT / rel
        group = str(path.parent.relative_to(MODELS)).replace("\\", "/")
        group = "" if group == "." else group
        pid = part_id(rel)
        ptype, prov = classify(rel, group, m)
        requires, hardware = requirements(rel, ptype, m, ids)

        sl = rec.get("slice") or {}
        if sl and "error" not in sl:
            est = {"minutes": sl["minutes"], "grams": sl["grams"],
                   "metres": sl["metres"], "profile": profile_id,
                   "supports": m["supports"], "source": "sliced"}
        else:
            # Never silently mix a guess with sliced numbers.
            est = {"minutes": 0, "grams": 0, "metres": 0,
                   "profile": profile_id, "supports": m["supports"],
                   "source": "volume"}
            prov["notes"].append(
                "print estimate unavailable" +
                (f": {sl['error']}" if sl.get("error") else " (slicing skipped)"))

        entry = {
            "id": pid,
            "name": pathlib.Path(rel).stem,
            "file": rel,
            "type": ptype,
            "group": group,
            "footprint": m["footprint"],
            "anchor": {"q": 0, "r": 0},
            "drawnOrientation": m["drawnOrientation"],
            "bboxMm": m["bboxMm"],
            "volumeMm3": m["volumeMm3"],
            "requires": requires,
            "hardware": hardware,
            "print": est,
            "provenance": prov,
            "sha256": rec["sha256"],
            "needsReview": bool(m["needsReview"] or prov["basis"] == "conflict"),
            "measurement": {
                "tier": m["tier"], "matingAxis": m["matingAxis"],
                "method": m["detectMethod"], "confidence": m["detectConfidence"],
                "interfaceWidths": m["interfaceWidths"],
                "socketWidths": m["socketWidths"], "bores": m["bores"],
                "overhangAreaMm2": m["overhangAreaMm2"],
                "overhangFraction": m["overhangFraction"],
                "watertight": m["watertight"], "triangles": m["triangles"],
            },
        }
        if ptype == "panel":
            entry["panel"] = panel_block(m)

        ov = overrides.get(pid)
        if isinstance(ov, dict):
            entry.update(ov)
            entry["provenance"]["notes"].append("manual override applied from overrides.json")
            entry["needsReview"] = bool(ov.get("needsReview", False))

        parts.append(entry)
        if entry["needsReview"]:
            unresolved.append({"file": rel, "id": pid,
                               "reason": "; ".join(prov["notes"][-3:]) or "low confidence",
                               "bboxMm": m["bboxMm"]})

    parts.sort(key=lambda p: (p["type"], p["id"]))
    catalog = {
        "schemaVersion": SCHEMA_VERSION,
        "scannerVersion": SCANNER_VERSION,
        "slicerProfile": profile_id,
        "generatedAt": None,           # filled below, only if content changed
        "parts": parts,
        "unresolved": sorted(unresolved, key=lambda u: u["file"]),
    }

    previous = load_json(CATALOG, None)
    body = json.dumps({k: v for k, v in catalog.items() if k != "generatedAt"},
                      indent=1, sort_keys=True)
    prev_body = (json.dumps({k: v for k, v in previous.items() if k != "generatedAt"},
                            indent=1, sort_keys=True) if isinstance(previous, dict) else None)
    if prev_body == body and isinstance(previous, dict):
        catalog["generatedAt"] = previous.get("generatedAt")
        changed = False
    else:
        catalog["generatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        changed = True

    if args.verify:
        same = prev_body == body
        print(f"\nVERIFY: catalogue {'REPRODUCED EXACTLY' if same else 'DIFFERS'}")
        if not same and prev_body is not None:
            a, b = prev_body.splitlines(), body.splitlines()
            shown = 0
            for i in range(max(len(a), len(b))):
                la = a[i] if i < len(a) else "<eof>"
                lb = b[i] if i < len(b) else "<eof>"
                if la != lb:
                    print(f"  line {i+1}:\n    committed: {la.strip()[:120]}\n"
                          f"    rebuilt  : {lb.strip()[:120]}")
                    shown += 1
                    if shown >= 10:
                        print("  ... (more differences)")
                        break
        return 0 if same else 1

    CATALOG.parent.mkdir(parents=True, exist_ok=True)
    CATALOG.write_text(json.dumps(catalog, indent=1, sort_keys=True) + "\n",
                       encoding="utf-8")
    write_unknown(unresolved, parts)

    by_type: dict[str, int] = {}
    for p in parts:
        by_type[p["type"]] = by_type.get(p["type"], 0) + 1
    sliced = sum(1 for p in parts if p["print"]["source"] == "sliced")
    print(f"\n{len(parts)} parts -> {CATALOG.relative_to(ROOT)} "
          f"({'updated' if changed else 'unchanged'})")
    print(f"  by type: {by_type}")
    print(f"  sliced estimates: {sliced}/{len(parts)}")
    print(f"  flagged for review: {len(unresolved)} -> UNKNOWN.md")
    return 0


def write_unknown(unresolved: list[dict], parts: list[dict]) -> None:
    by_id = {p["id"]: p for p in parts}
    lines = [
        "# UNKNOWN.md â€” parts the scanner would not guess at",
        "",
        "Generated by `python tools/scan.py`. Do not edit by hand: corrections go in",
        "`src/catalog/overrides.json`, keyed by part id, and survive every rescan.",
        "",
        "Everything here has a *usable* entry in the catalogue, but one the scanner",
        "does not stand behind. The app shows these with a 'needs review' marker so a",
        "wrong footprint cannot quietly become a wrong parts list.",
        "",
    ]
    if not unresolved:
        lines += ["## Nothing outstanding", "",
                  "Every part in `./models/` classified with confidence.", ""]
    else:
        lines += [f"## {len(unresolved)} part(s) need a human decision", ""]
        lines += ["| part | bbox mm | cells claimed | why |",
                  "|---|---|---|---|"]
        for u in unresolved:
            p = by_id.get(u["id"], {})
            bbox = " Ã— ".join(f"{v:g}" for v in u["bboxMm"])
            n = len(p.get("footprint", []))
            why = u["reason"].replace("|", "\\|")
            lines.append(f"| `{u['id']}` | {bbox} | {n} | {why} |")
        lines += ["", "### What to do about it", "",
                  "For each row, set the true footprint in `src/catalog/overrides.json`:",
                  "", "```json",
                  '{', '  "shelf-2": {',
                  '    "footprint": [{"q": 0, "r": 0}, {"q": 1, "r": 0}],',
                  '    "requires": [{"partId": "insert-with-m3", "count": 2}],',
                  '    "needsReview": false', '  }', '}', "```", ""]

    lines += [
        "## Why these could not be measured",
        "",
        "The parts above carry no HSW wall interface: no 22.5 mm flange and no 19.7 mm",
        "body hexagon on any of the three axes. They are the second tier of the system â€”",
        "they bolt or plug into an *insert*, and the insert clips to the wall. Geometry",
        "can say how wide such a part is; it cannot say which cells the installer will",
        "put its inserts in, because that is a choice, not a feature.",
        "",
        "So the footprint recorded for them is an upper bound from the bounding box",
        "(longest edge Ã· 20.438 mm row step), which is honest about being a bound.",
        "",
    ]
    UNKNOWN_MD.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())

