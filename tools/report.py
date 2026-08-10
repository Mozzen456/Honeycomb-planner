"""Human-readable summary of the generated catalogue."""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
c = json.loads((ROOT / "src" / "catalog" / "catalog.json").read_text(encoding="utf-8"))

print(f"schema {c['schemaVersion']}  scanner {c['scannerVersion']}")
print(f"profile {c['slicerProfile']}\n")

print("PANELS")
print(f"  {'id':40} {'cols x rows':>12} {'cells':>6} {'w x h mm':>18} "
      f"{'time':>8} {'g':>7}  beds")
for p in [p for p in c["parts"] if p["type"] == "panel"]:
    b = p["panel"]
    print(f"  {p['id']:40} {b['columns']:5d} x {b['rows']:<4d} "
          f"{len(p['footprint']):6d} {b['widthMm']:8.2f} x{b['heightMm']:7.2f} "
          f"{p['print']['minutes']:7.0f}m {p['print']['grams']:7.1f}  "
          f"{','.join(b['fitsBeds']) or 'NONE'}")

for t in ("insert", "fastener"):
    print(f"\n{t.upper()}S")
    print(f"  {'id':40} {'cells':>6} {'drawn':>7} {'time':>8} {'g':>7}  hardware")
    for p in [p for p in c["parts"] if p["type"] == t]:
        hw = ", ".join(f"{h['count']}x {h['item']}" for h in p["hardware"])
        print(f"  {p['id']:40} {len(p['footprint']):6d} {p['drawnOrientation']:>7} "
              f"{p['print']['minutes']:7.1f}m {p['print']['grams']:7.1f}  {hw[:60]}")

print(f"\nACCESSORIES ({sum(1 for p in c['parts'] if p['type']=='accessory')})")
print(f"  {'id':40} {'cells':>6} {'tier':>11} {'time':>8} {'g':>7} {'sup':>4} rev")
for p in [p for p in c["parts"] if p["type"] == "accessory"]:
    print(f"  {p['id']:40} {len(p['footprint']):6d} "
          f"{p['measurement']['tier']:>11} {p['print']['minutes']:7.1f}m "
          f"{p['print']['grams']:7.1f} {'Y' if p['print']['supports'] else '-':>4} "
          f"{'REVIEW' if p['needsReview'] else ''}")

tot_m = sum(p["print"]["minutes"] for p in c["parts"])
tot_g = sum(p["print"]["grams"] for p in c["parts"])
print(f"\none of everything: {tot_m/60:.1f} h, {tot_g:.0f} g")
print(f"needsReview: {sum(1 for p in c['parts'] if p['needsReview'])}/{len(c['parts'])}")
