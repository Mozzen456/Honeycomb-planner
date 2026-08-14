/**
 * How far an insert goes INTO the wall, and how far it stands OUT of it —
 * measured on the insert's own mesh rather than assumed.
 *
 * HSW is two-level (HSW-SPEC §5): the insert clips into a cell and the
 * accessory pegs into the insert. Which means an insert is the only part in the
 * catalogue that does NOT sit on the wall face: its body goes through the mouth
 * and into the throat, and its flange — 22.5 mm across flats, wider than the
 * 22.0 mm mouth it cannot enter — rests on the front face. Everything else in
 * the app seats a part with its mating face at the wall (`meshLibrary.orient`),
 * and for an insert that is 10 mm out in the room rather than 7.5 mm inside the
 * wall.
 *
 * The split is measurable, and this measures it: the flange is exactly the
 * material that cannot pass through a cell mouth. Scan for the first plane
 * where the part gets wider than the widest thing that fits in a hole, and that
 * plane is the wall's front face.
 *
 * Why measure it rather than write 2.5:
 *
 *   - the alignment tool draws the insert so a person can seat a part ON it,
 *     and a drawn stand-in is exactly what that dialog exists to replace;
 *   - `seat: 'insert'` stands a part off by `INSERT.flangeThickness`, and this
 *     is what holds that constant to the models (`tests/insert-seat.test.ts`);
 *   - the wall view drew every fixing at `PANEL_DEPTH − depthMm`, which buries
 *     the flange in the plate and pushes 2 mm of body out the back.
 *
 * It refuses rather than guesses. A part whose widest material is not a slab at
 * the outer end is not seating like an insert — and a made-up number here is a
 * part drawn floating off the wall with nothing saying so.
 */

import { INSERT } from './constants';

export interface InsertSeat {
  /**
   * How deep the body reaches into the wall, measured from the underside of the
   * flange, mm. The insert is drawn at `PANEL_DEPTH − bodyMm`.
   */
  bodyMm: number;
  /**
   * How far the flange stands proud of the wall's front face, mm — the datum a
   * part with `seat: 'insert'` rests on.
   */
  proudMm: number;
}

/**
 * Half the step between the widest thing that enters a cell and the flange that
 * cannot, along the same (across-corners) direction.
 *
 * The barb is the fattest part of the body — 20.735 mm across flats, the snap
 * ridge that retains the insert in the throat — so anything wider than it is
 * material that stayed outside. Derived from the two measured widths rather
 * than typed, so it follows if either is re-measured: the classifier sits
 * halfway between them, ~0.5 mm either way.
 */
const HALF_STEP = (INSERT.flangeAcrossCorners - INSERT.barbAcrossFlats * (2 / Math.sqrt(3))) / 4;

/**
 * The seat of an insert, from its ORIENTED positions.
 *
 * "Oriented" means what `meshLibrary.orient` produces: wall coordinates, +Z out
 * of the wall, the mating face at z = 0, centred on its own wall-plane bounding
 * box. The flange is expected at the FAR end of z — which is what turning a
 * part over to face the wall does to an insert drawn flange-first — and a part
 * whose widest material is anywhere else gets `null`.
 *
 * @param positions triples of x, y, z, as a geometry's position attribute.
 */
export function measureInsertSeat(positions: ArrayLike<number>): InsertSeat | null {
  if (positions.length < 9) return null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const depth = maxZ - minZ;
  if (!(depth > 0)) return null;

  /*
   * The widest material in the part IS the flange: the body has to fit through
   * a 22.0 mm mouth and the flange is 22.5 mm across. So the classifier is a
   * band inside the part's own outline — no lattice, no cell centres, and in
   * particular no assumption about WHICH cells the insert covers, which for a
   * chiral multi-cell insert is the one thing the oriented mesh and the
   * footprint disagree about (D49, PARKED P10).
   */
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const reachX = (maxX - minX) / 2 - HALF_STEP;
  const reachY = (maxY - minY) / 2 - HALF_STEP;
  if (reachX <= 0 || reachY <= 0) return null;

  let flangeStart = Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = Math.abs(positions[i]! - cx);
    const y = Math.abs(positions[i + 1]! - cy);
    if (x < reachX && y < reachY) continue;
    const z = positions[i + 2]!;
    if (z < flangeStart) flangeStart = z;
  }
  if (!Number.isFinite(flangeStart)) return null;

  const bodyMm = flangeStart - minZ;
  const proudMm = maxZ - flangeStart;

  /*
   * Believable? A flange is a thin collar at the outer end of a plug that is
   * several times longer than it is. Anything else — a part that is widest at
   * the wall, or one with no step at all — is not an insert seating in a cell,
   * and this says so instead of returning a number that would draw it floating.
   */
  if (proudMm < 0.5 || proudMm > 6) return null;
  if (bodyMm < 2 || bodyMm <= proudMm) return null;

  return { bodyMm, proudMm };
}
