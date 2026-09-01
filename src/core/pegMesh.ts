/**
 * The hexagonal PEG, as geometry. Shared by everything that grows one.
 *
 * Not to be confused with `peg.ts`, which MEASURES the peg an uploaded part
 * already has in order to guess how it mounts. This one BUILDS the peg, from the
 * profile measured off the shipped shelves (`PEG` and `PEG_PROFILE` in
 * `constants.ts`, and D108).
 *
 * Two callers with two different needs, which is why the ring and the solid are
 * separate exports:
 *
 *   - `binModel.ts` grows a peg out of a back panel it is drawing anyway, so it
 *     emits the rings itself and lets the panel's own hole be the root;
 *   - `pegAdder.ts` bolts a peg onto somebody else's mesh, so it needs a CLOSED
 *     solid with a cap at each end, embedded far enough into the part that the
 *     two overlap rather than touch.
 *
 * Frame here is the wall's: +a across it, +u up it, +d OUT of it. A peg goes IN,
 * so it runs from `+seat` (inside the part) down to `−PEG.lengthMm`.
 */

import { PEG, PEG_PROFILE } from './constants';

export interface Corner {
  a: number;
  u: number;
}

/**
 * The peg hexagon's six corners at one point along its length, closed form.
 *
 * Corners at 0°, 60°, … so the hexagon is FLAT-TOP, matching both the wall's
 * cells and the socket in the top of an insert. A peg turned 30° would foul the
 * socket, which is the same class of error as D31/D35.
 *
 * `sidesMm` draws five faces in and `bottomMm` the sixth, because that is what
 * the shipped pegs measure (see `PEG_PROFILE`): the bottom flat is the face the
 * part is printed on and drafting it would lift it off the bed. With an apothem
 * of `A`, the two corners either side of that face come out at
 * `±(A − 2s + b)/√3`, which is where the asymmetry in this function comes from.
 *
 * Closed form and not a plane intersection, so that at `s = b = 0` the four
 * expressions collapse to bit-identical values — `binModel` cuts the holes in
 * its back panel from these very numbers, and `meshIsClosed` compares vertices
 * EXACTLY.
 */
export function pegRing(centre: Corner, sidesMm: number, bottomMm: number): Corner[] {
  const A = PEG.acrossFlats / 2;
  const flatHalf = (A - sidesMm) / Math.sqrt(3);
  const cornerHalf = 2 * flatHalf;
  const bottomHalf = (A - 2 * sidesMm + bottomMm) / Math.sqrt(3);
  const up = A - sidesMm;
  const down = A - bottomMm;
  return [
    { a: centre.a + cornerHalf, u: centre.u }, //   0°  right corner
    { a: centre.a + flatHalf, u: centre.u + up }, //  60°
    { a: centre.a - flatHalf, u: centre.u + up }, // 120°
    { a: centre.a - cornerHalf, u: centre.u }, // 180°  left corner
    { a: centre.a - bottomHalf, u: centre.u - down }, // 240°
    { a: centre.a + bottomHalf, u: centre.u - down }, // 300°
  ];
}

/**
 * How far a bolted-on peg is buried in the part it is bolted to.
 *
 * There is no polygon boolean in this codebase and there is not going to be
 * one, so a peg added to somebody else's mesh is a SECOND SOLID that overlaps
 * the first — which every slicer unions, and which is exactly what putting two
 * objects in a 3MF does. Overlap and not abut: two solids that merely touch
 * share a zero-thickness contact and a slicer is entitled to read that as two
 * parts resting against each other.
 *
 * Two millimetres, and it does two jobs. It is deep enough that the union is
 * unambiguous, and — because `pegAdder` will not offer a cell unless the part is
 * SOLID for the whole of it — it doubles as the minimum thickness a part has to
 * have where a peg goes. A peg welded to 0.4 mm of skin comes off with the first
 * load.
 *
 * Not more. Three was the first guess and it refuses a 2.2 mm plate, which is
 * most of what people upload; the load is carried by the bond over the peg's
 * whole 156 mm² root face and by the part's own thickness, not by how far the
 * peg is buried.
 */
export const PEG_SEAT_MM = 2;

/**
 * The peg's rings, root first: the buried end, the wall face, then the profile.
 *
 * The first two share a section — the peg is not drafted until 4 mm along — so
 * the band between them is a straight prism through the part's skin.
 */
export function pegRings(centre: Corner, seatMm: number): { d: number; corners: Corner[] }[] {
  return [
    { d: seatMm, corners: pegRing(centre, 0, 0) },
    ...PEG_PROFILE.map((level) => ({
      d: -level.alongMm,
      corners: pegRing(centre, level.sidesMm, level.bottomMm),
    })),
  ];
}

/** Positions and a triangle count, in whatever frame the caller is using. */
export interface PegSolid {
  positions: number[];
  triangleCount: number;
}

/**
 * One peg as a CLOSED solid, capped at both ends.
 *
 * Wound counter-clockwise seen from outside, like everything else this codebase
 * writes. `d` decreases along the peg — it is going INTO the wall — which is why
 * the side quads read root-then-tip and the tip's fan is reversed.
 *
 * Emitted as `[d, a, u]`, the file frame `binModel` documents: +x out of the
 * wall, +y across it, +z up it. The permutation `(a, u, d) -> (d, a, u)` is
 * CYCLIC and therefore a rotation; an acyclic one would mirror the peg.
 */
export function buildPegSolid(centre: Corner, seatMm = PEG_SEAT_MM): PegSolid {
  const rings = pegRings(centre, seatMm);
  const xs: number[] = [];
  let n = 0;
  const push = (c: Corner, d: number): void => {
    xs.push(d, c.a, c.u);
  };
  const tri = (a: Corner, ad: number, b: Corner, bd: number, c: Corner, cd: number): void => {
    push(a, ad);
    push(b, bd);
    push(c, cd);
    n++;
  };

  for (let i = 0; i + 1 < rings.length; i++) {
    const near = rings[i]!;
    const far = rings[i + 1]!;
    for (let k = 0; k < 6; k++) {
      const k1 = (k + 1) % 6;
      // Corners run anti-clockwise in (a, u) and d decreases along the peg, so
      // this order is the one whose normal points out of the prism.
      tri(near.corners[k]!, near.d, far.corners[k]!, far.d, far.corners[k1]!, far.d);
      tri(near.corners[k]!, near.d, far.corners[k1]!, far.d, near.corners[k1]!, near.d);
    }
  }

  // The buried end, facing back out of the part (+d).
  const root = rings[0]!;
  for (let k = 1; k + 1 < 6; k++) {
    tri(root.corners[0]!, root.d, root.corners[k]!, root.d, root.corners[k + 1]!, root.d);
  }
  // The tip, facing into the wall (−d) — so the fan is reversed.
  const tip = rings[rings.length - 1]!;
  for (let k = 1; k + 1 < 6; k++) {
    tri(tip.corners[0]!, tip.d, tip.corners[k + 1]!, tip.d, tip.corners[k]!, tip.d);
  }

  return { positions: xs, triangleCount: n };
}
