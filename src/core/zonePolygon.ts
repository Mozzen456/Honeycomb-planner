/**
 * A blocked zone drawn as a POLYGON — the slope of a roof, a stair stringer, a
 * boxed-in pipe at an angle (D109).
 *
 * Everything here is pure plane geometry in wall millimetres. The generator
 * cuts with HALF-PLANES and has no polygon boolean by design, so a polygon is
 * handed over the only way it can use one: as CONVEX pieces, each a short list
 * of straight edges. A rectangle is the special case with four axis-aligned
 * edges, and it is fed through the same door (`obstacles.obstacleRegions`), so
 * every test the rectangle has ever passed is also a test of this path.
 *
 * Four jobs, all on a list of points:
 *
 *   - `normaliseOutline` — counter-clockwise, no repeats, no collinear runs;
 *   - `outlineProblem`   — the reason a drawn outline cannot be a zone, if any;
 *   - `convexParts`      — the outline as convex pieces (ear clipping, then
 *                          Hertel–Mehlhorn to merge triangles back together);
 *   - `growConvex`       — one piece pushed out by the clearance.
 *
 * Plus `simplifyStroke`, which turns a freehand pointer trail into a handful of
 * corners.
 */

export interface Pt {
  x: number;
  y: number;
}

/**
 * One straight edge of a convex piece: the piece is `nx·x + ny·y <= d`.
 *
 * `(nx, ny)` is the OUTWARD unit normal, so `d` is a signed distance in
 * millimetres and every tolerance applied to it is a real length — the same
 * contract every half-plane in `honeycomb.ts` keeps.
 *
 * `internal` marks an edge that is not the zone's own boundary but a diagonal
 * the decomposition introduced between two pieces. Cutting a cell on one is
 * never wrong — the other piece cuts it again from its side — but it throws
 * away plate the zone never asked for, so the cutter prefers a real edge.
 */
export interface ZoneEdge {
  nx: number;
  ny: number;
  d: number;
  internal?: boolean;
}

/** Fewest points a zone can be drawn with. */
export const MIN_OUTLINE_POINTS = 3;
/**
 * Most corners an outline may keep.
 *
 * Bounded because a share link is user input: every corner becomes edges the
 * cutter tests against every cell near the zone, and a pasted outline of ten
 * thousand points would make every edit re-cut the wall at a crawl. A roof, a
 * stair and a chimney breast all fit in a dozen.
 */
export const MAX_OUTLINE_POINTS = 64;
/** Smallest area worth calling a zone, mm². Below it a drawn shape is a slip. */
export const MIN_OUTLINE_AREA_MM2 = 100;

const EPS = 1e-9;

/** Twice the signed area: positive when the points run counter-clockwise. */
export function signedArea2(pts: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a;
}

const cross = (o: Pt, a: Pt, b: Pt): number =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/**
 * The outline in canonical form: counter-clockwise, no point repeated, no
 * point lying on the straight line between its neighbours.
 *
 * Collinear points matter beyond tidiness: a convex piece with a 180° corner
 * has two edges on one line, and the cutter would test both.
 */
export function normaliseOutline(points: readonly Pt[]): Pt[] {
  const same = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y) <= 1e-6;
  const pts: Pt[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (pts.length > 0 && same(pts[pts.length - 1]!, p)) continue;
    pts.push({ x: p.x, y: p.y });
  }
  // ...including the closing point a stroke often ends on.
  while (pts.length > 1 && same(pts[0]!, pts[pts.length - 1]!)) pts.pop();
  // Collinear runs, repeated until none are left.
  for (let changed = true; changed && pts.length > 3;) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[(i + pts.length - 1) % pts.length]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % pts.length]!;
      const len = Math.hypot(c.x - a.x, c.y - a.y);
      if (len < 1e-9 || Math.abs(cross(a, b, c)) / len < 1e-6) {
        pts.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  if (signedArea2(pts) < 0) pts.reverse();
  return pts;
}

/** Do segments `ab` and `cd` cross or touch, other than at a shared end? */
function segmentsMeet(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
      ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) return true;
  const on = (p: Pt, q: Pt, r: Pt, side: number) =>
    Math.abs(side) <= EPS &&
    Math.min(p.x, q.x) - EPS <= r.x && r.x <= Math.max(p.x, q.x) + EPS &&
    Math.min(p.y, q.y) - EPS <= r.y && r.y <= Math.max(p.y, q.y) + EPS;
  return on(c, d, a, d1) || on(c, d, b, d2) || on(a, b, c, d3) || on(a, b, d, d4);
}

/**
 * Why this outline cannot be a zone, in words — or null when it can.
 *
 * Refused rather than repaired. A stroke that crosses itself has no inside a
 * person could point at, and guessing one would cut honeycomb they did not
 * mean to lose; saying so lets them draw it again.
 */
export function outlineProblem(points: readonly Pt[]): string | null {
  const pts = normaliseOutline(points);
  if (pts.length < MIN_OUTLINE_POINTS) return 'A shape needs at least three corners.';
  if (pts.length > MAX_OUTLINE_POINTS) {
    return `A shape can have at most ${MAX_OUTLINE_POINTS} corners — draw it with fewer.`;
  }
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      // Neighbouring edges share a corner by construction.
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsMeet(a, b, pts[j]!, pts[(j + 1) % n]!)) {
        return 'That shape crosses itself — draw it without the line crossing over.';
      }
    }
  }
  // After the crossing test: a bow tie's two halves cancel to no area at all,
  // and "too small" would be the wrong thing to tell someone about it.
  if (Math.abs(signedArea2(pts)) / 2 < MIN_OUTLINE_AREA_MM2) {
    return 'That shape is too small to block anything.';
  }
  return null;
}

/** Is `p` strictly inside triangle `abc` (counter-clockwise)? */
function inTriangle(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  return cross(a, b, p) > EPS && cross(b, c, p) > EPS && cross(c, a, p) > EPS;
}

/**
 * Ear clipping: a simple counter-clockwise polygon as triangles, by index.
 *
 * O(n³) in the worst case, which at `MAX_OUTLINE_POINTS` is nothing.
 */
function triangulate(pts: readonly Pt[]): [number, number, number][] {
  const idx = pts.map((_, i) => i);
  const out: [number, number, number][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10_000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k + idx.length - 1) % idx.length]!;
      const ib = idx[k]!;
      const ic = idx[(k + 1) % idx.length]!;
      const a = pts[ia]!, b = pts[ib]!, c = pts[ic]!;
      if (cross(a, b, c) <= EPS) continue; // reflex or flat: not an ear
      let blocked = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTriangle(pts[j]!, a, b, c)) { blocked = true; break; }
      }
      if (blocked) continue;
      out.push([ia, ib, ic]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate input; take what we have
  }
  if (idx.length === 3) out.push([idx[0]!, idx[1]!, idx[2]!]);
  return out;
}

/** Is the polygon (by index, counter-clockwise) convex? */
function isConvex(pts: readonly Pt[], poly: readonly number[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = pts[poly[(i + poly.length - 1) % poly.length]!]!;
    const b = pts[poly[i]!]!;
    const c = pts[poly[(i + 1) % poly.length]!]!;
    if (cross(a, b, c) < -EPS) return false;
  }
  return true;
}

/**
 * The outline as CONVEX pieces, each a counter-clockwise list of points, plus
 * which of each piece's edges are diagonals rather than the outline's own.
 *
 * Triangles first, then Hertel–Mehlhorn: drop every diagonal whose removal
 * leaves both its ends convex. That gives at most four times the optimal number
 * of pieces and, for the shapes this is for — a convex roof slope, an L, a
 * staircase — usually exactly the optimum: one piece for anything convex.
 */
export function convexParts(points: readonly Pt[]): { points: Pt[]; internal: boolean[] }[] {
  const pts = normaliseOutline(points);
  if (pts.length < 3) return [];
  let polys: number[][] = triangulate(pts).map((t) => [...t]);
  const n = pts.length;
  const isOutlineEdge = (a: number, b: number) => (a + 1) % n === b;

  for (let merged = true; merged;) {
    merged = false;
    outer:
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        const A = polys[i]!, B = polys[j]!;
        // A shared diagonal appears as a->b in one and b->a in the other.
        for (let ka = 0; ka < A.length; ka++) {
          const a0 = A[ka]!, a1 = A[(ka + 1) % A.length]!;
          if (isOutlineEdge(a0, a1)) continue;
          const kb = B.findIndex((v, k) => v === a1 && B[(k + 1) % B.length] === a0);
          if (kb < 0) continue;
          // Splice B into A across the shared edge.
          const joined: number[] = [];
          for (let k = 0; k < A.length; k++) {
            joined.push(A[(ka + 1 + k) % A.length]!);
            if (k === A.length - 1) break;
          }
          // `joined` runs a1 ... a0 round A; continue round B from a0 to a1.
          for (let k = 2; k < B.length; k++) joined.push(B[(kb + k) % B.length]!);
          if (!isConvex(pts, joined)) continue;
          polys[i] = joined;
          polys.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  return polys.map((poly) => ({
    points: poly.map((k) => ({ ...pts[k]! })),
    internal: poly.map((k, i) => !isOutlineEdge(k, poly[(i + 1) % poly.length]!)),
  }));
}

/** The edges of a counter-clockwise convex polygon, outward unit normals. */
export function edgesOf(points: readonly Pt[], internal?: readonly boolean[]): ZoneEdge[] {
  const out: ZoneEdge[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    // Counter-clockwise, so the outward normal is the edge turned clockwise.
    const nx = (b.y - a.y) / len;
    const ny = -(b.x - a.x) / len;
    out.push({ nx, ny, d: nx * a.x + ny * a.y, ...(internal?.[i] ? { internal: true } : {}) });
  }
  return out;
}

/**
 * A convex piece pushed out by `c` millimetres: every edge moved out by `c`,
 * plus a BEVEL wherever a corner is sharp.
 *
 * Moving the edges alone is a mitre, and a mitre at a sharp corner runs a long
 * way: 5 mm of clearance on a 20° tip reaches 29 mm past it. The clearance
 * means "keep this far off", so the tip is capped by a line across it at that
 * distance — a half-plane like any other, so the piece stays convex and the
 * cutter needs nothing new. Square and obtuse corners get no bevel, which is
 * what keeps a rectangle grown by its clearance the rectangle it always was.
 */
export function growConvex(edges: readonly ZoneEdge[], points: readonly Pt[], c: number): ZoneEdge[] {
  if (!(c > 0)) return edges.map((e) => ({ ...e }));
  const out = edges.map((e) => ({ ...e, d: e.d + c }));
  for (let i = 0; i < points.length; i++) {
    const prev = edges[(i + edges.length - 1) % edges.length]!;
    const next = edges[i]!;
    // Interior angle below 90° when the two outward normals point more than
    // 90° apart.
    const dot = prev.nx * next.nx + prev.ny * next.ny;
    if (dot >= 0) continue;
    let bx = prev.nx + next.nx;
    let by = prev.ny + next.ny;
    const len = Math.hypot(bx, by);
    if (len < 1e-9) continue;
    bx /= len;
    by /= len;
    const v = points[i]!;
    out.push({ nx: bx, ny: by, d: bx * v.x + by * v.y + c });
  }
  return out;
}

/** The corners of the convex region `n·p <= d` for every edge, within a box. */
export function regionPoints(edges: readonly ZoneEdge[], box: {
  minX: number; minY: number; maxX: number; maxY: number;
}): Pt[] {
  let poly: Pt[] = [
    { x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY },
  ];
  for (const e of edges) {
    const next: Pt[] = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i]!;
      const prev = poly[(i + poly.length - 1) % poly.length]!;
      const dc = e.nx * cur.x + e.ny * cur.y - e.d;
      const dp = e.nx * prev.x + e.ny * prev.y - e.d;
      if ((dc <= 0) !== (dp <= 0)) {
        const t = dp / (dp - dc);
        next.push({ x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) });
      }
      if (dc <= 0) next.push(cur);
    }
    poly = next;
    if (poly.length === 0) break;
  }
  return poly;
}

/** Even–odd point in polygon. */
export function pointInOutline(points: readonly Pt[], p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!, b = points[j]!;
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * A freehand pointer trail reduced to the corners that matter
 * (Ramer–Douglas–Peucker, closed).
 *
 * A trail is hundreds of points a pixel apart, and every one of them would be a
 * corner the cutter has to test. `toleranceMm` is how far the simplified line
 * may stray from the hand-drawn one; the caller picks it from the zoom, so it
 * means a few pixels on screen whatever the scale.
 */
export function simplifyStroke(points: readonly Pt[], toleranceMm: number): Pt[] {
  if (points.length <= 3) return points.map((p) => ({ ...p }));
  const keep = rdpKeep(points, toleranceMm);
  // Closed: split at the point furthest from the start, then simplify both arcs.
  const s = points[0]!;
  let far = 1;
  for (let k = 1; k < points.length; k++) {
    if (Math.hypot(points[k]!.x - s.x, points[k]!.y - s.y) >
        Math.hypot(points[far]!.x - s.x, points[far]!.y - s.y)) far = k;
  }
  keep.mark(0, far);
  keep.mark(far, points.length - 1);
  // The trail's last point is usually back near its first.
  const out = points.filter((_, k) => keep.flags[k]).map((p) => ({ ...p }));
  if (out.length > 3) {
    const first = out[0]!, last = out[out.length - 1]!;
    if (Math.hypot(first.x - last.x, first.y - last.y) <= toleranceMm) out.pop();
  }
  return out;
}

/**
 * An OPEN trail reduced the same way — a stretch drawn freehand between
 * corners placed by clicking. Both ends are kept.
 */
export function simplifyPath(points: readonly Pt[], toleranceMm: number): Pt[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));
  const keep = rdpKeep(points, toleranceMm);
  keep.mark(0, points.length - 1);
  return points.filter((_, k) => keep.flags[k]).map((p) => ({ ...p }));
}

function rdpKeep(points: readonly Pt[], toleranceMm: number) {
  const flags = new Array<boolean>(points.length).fill(false);
  const rdp = (i: number, j: number): void => {
    const a = points[i]!, b = points[j]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const p = points[k]!;
      const dist = len < 1e-9
        ? Math.hypot(p.x - a.x, p.y - a.y)
        : Math.abs(cross(a, b, p)) / len;
      if (dist > worst) { worst = dist; at = k; }
    }
    if (worst > toleranceMm && at > 0) {
      flags[at] = true;
      rdp(i, at);
      rdp(at, j);
    }
  };
  return {
    flags,
    /** Keep both ends of `[i, j]` and whatever the line between them needs. */
    mark(i: number, j: number): void {
      flags[i] = true;
      flags[j] = true;
      rdp(i, j);
    },
  };
}
