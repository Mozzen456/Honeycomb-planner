"""Dry-run the footprint detector over every model and print what it decides."""
from footprint import detect
from hexlib import MODELS, ROOT, load


def main() -> None:
    print(f"{'file':46} {'bbox mm':>21} {'tier':11} {'or':6} {'ax':3} {'conf':>5} {'n':>4}  cells")
    flagged = []
    for path in sorted(MODELS.rglob("*.stl")):
        try:
            mesh = load(path)
            fp = detect(mesh)
        except Exception as exc:
            print(f"{path.name[:46]:46} ERROR {exc!r}")
            continue
        lo, hi = mesh.bounds
        s = hi - lo
        cells = ",".join(f"({q},{r})" for q, r in fp.cells[:6])
        if len(fp.cells) > 6:
            cells += f" +{len(fp.cells)-6}"
        mark = " !" if fp.needs_review else "  "
        print(f"{path.name[:46]:46} {s[0]:6.1f}x{s[1]:6.1f}x{s[2]:5.1f} {fp.tier:11} "
              f"{fp.drawn_orientation:6} {fp.mating_axis:3} {fp.confidence:5.2f} "
              f"{len(fp.cells):4d}{mark}{cells}")
        if fp.needs_review:
            flagged.append((path.name, fp))

    print(f"\n{len(flagged)} part(s) flagged for review:")
    for name, fp in flagged:
        print(f"  {name}")
        for n in fp.notes:
            print(f"      {n}")


if __name__ == "__main__":
    main()
