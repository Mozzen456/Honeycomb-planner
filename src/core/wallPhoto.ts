/**
 * A photograph of the real wall, and the arithmetic that puts it in its place.
 *
 * The job is one number: **how many wall millimetres is one image pixel worth.**
 * Everything else — where the photo sits, how big it draws, how a zone lines up
 * against a light switch in it — falls out of that number and the corner it is
 * measured from. So the number is not guessed from EXIF, or from the wall size,
 * or from anything the camera claims: it comes from two points the user clicks
 * on the photo and one distance they measured with a tape.
 *
 * Pure millimetres, like `measure.ts`. The canvas supplies the two points, the
 * panel supplies the distance, and every decision about what they mean is made
 * here so it can be tested without a browser or a decoded image.
 *
 * The image bytes are somebody else's problem — `src/ui/wallPhotoImage.ts` —
 * and deliberately so: this module never needs the pixels to answer anything.
 */

import type { Point } from './hex';
import type { WallPhoto, WallSpec } from './types';

/**
 * A photo you cannot see through is not an overlay, it is a wall covering.
 *
 * The floor is not zero for the same reason a hidden layer has its own switch:
 * an invisible photo that still claims to be shown is indistinguishable from a
 * broken one, and the person who dragged the slider to the end will report it
 * as such. `visible` is how you turn it off.
 */
export const MIN_PHOTO_OPACITY = 0.05;
export const MAX_PHOTO_OPACITY = 1;

/** Half strength: the honeycomb and the room both readable at once. */
export const DEFAULT_PHOTO_OPACITY = 0.5;

/**
 * How big the photo is allowed to end up, measured across its longest edge.
 *
 * The ceiling is the same 100 m envelope `persist.readCoordMm` allows for any
 * wall measurement, so a calibration cannot produce a document the loader would
 * then reject. The floor stops a mistyped distance — 12 where 1200 was meant —
 * collapsing the photo to a speck that cannot be found again, let alone grabbed
 * and re-scaled.
 */
export const MIN_PHOTO_SPAN_MM = 10;
export const MAX_PHOTO_SPAN_MM = 100_000;

/** Longest edge kept when the image is stored. Detail enough to click a switch. */
export const WALL_PHOTO_MAX_PX = 2048;

// ---------------------------------------------------------------------------
// Where it sits
// ---------------------------------------------------------------------------

export interface PhotoRect {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

/** The rectangle the photo covers, in the same frame an `Obstacle` is drawn in. */
export function photoRectMm(photo: WallPhoto): PhotoRect {
  return {
    xMm: photo.xMm,
    yMm: photo.yMm,
    widthMm: photo.pixelWidth * photo.mmPerPixel,
    heightMm: photo.pixelHeight * photo.mmPerPixel,
  };
}

/**
 * Its middle — what the 3D view needs, since a plane is placed by its centre,
 * and the point everything about the rotation turns around.
 *
 * Unaffected by the rotation, which is the reason the centre is the pivot: a
 * turned photo is still centred where it was, so nothing that positions the
 * picture has to know the angle.
 */
export function photoCentreMm(photo: WallPhoto): Point {
  const r = photoRectMm(photo);
  return { x: r.xMm + r.widthMm / 2, y: r.yMm + r.heightMm / 2 };
}

// ---------------------------------------------------------------------------
// Which way up
// ---------------------------------------------------------------------------

/** Rotation is stored to a tenth of a degree — finer than anyone can aim. */
const ROTATION_STEP = 10;

/**
 * The turn, normalised to (−180, 180].
 *
 * Wrapped rather than clamped: 190° and −170° are the same picture, and a
 * control that stops dead at 180 makes turning the last few degrees the long way
 * round. Wrapping also keeps the stored number small however many times someone
 * holds the arrow key down.
 */
export function clampPhotoRotation(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const rounded = Math.round(deg * ROTATION_STEP) / ROTATION_STEP;
  const wrapped = ((rounded % 360) + 360) % 360;      // [0, 360)
  const signed = wrapped > 180 ? wrapped - 360 : wrapped;
  // `-0` is a real value that compares equal to 0 and fails `Object.is`, which
  // is what a dirty check uses. Same rule as `readMounting`'s six numbers.
  return Object.is(signed, -0) ? 0 : signed;
}

/** The effective angle. Absent means square. */
export function photoRotation(photo: WallPhoto): number {
  return clampPhotoRotation(photo.rotationDeg ?? 0);
}

/**
 * Turn the photo to an absolute angle, about its own centre.
 *
 * Zero is stored as ABSENT, not as `0`. A layout nobody has turned must
 * serialise exactly as it always did — the same rule the colours, the printed
 * counts and the frame all follow — or every previously saved wall gains a field
 * on its next save and every share link gets longer for nothing.
 */
export function rotatePhoto(photo: WallPhoto, deg: number): WallPhoto {
  const rotationDeg = clampPhotoRotation(deg);
  const { rotationDeg: _old, ...rest } = photo;
  return rotationDeg === 0 ? rest : { ...rest, rotationDeg };
}

/**
 * The four corners as DRAWN, in wall millimetres, anticlockwise from the
 * bottom-left of the photo's own frame.
 *
 * The one place the rotation is turned into geometry. Both views and the hit
 * test go through it, so a picture cannot be drawn at an angle the pointer does
 * not agree with — which is the whole class of bug this app keeps finding when
 * two readers derive the same thing separately.
 */
export function photoCorners(photo: WallPhoto): [Point, Point, Point, Point] {
  const r = photoRectMm(photo);
  const c = photoCentreMm(photo);
  const t = (photoRotation(photo) * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const at = (dx: number, dy: number): Point => ({
    x: c.x + dx * cos - dy * sin,
    y: c.y + dx * sin + dy * cos,
  });
  const hw = r.widthMm / 2;
  const hh = r.heightMm / 2;
  return [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)];
}

/**
 * Is this point on the photo? Used to decide whether a drag grabs it.
 *
 * The point is turned back into the photo's own frame and tested against the
 * plain rectangle, rather than the rectangle being turned into a polygon and
 * tested against. Same answer, and it stays a rectangle test — a point-in-quad
 * test is where an off-by-one in corner order hides.
 */
export function photoHit(photo: WallPhoto, p: Point): boolean {
  const r = photoRectMm(photo);
  const c = photoCentreMm(photo);
  const t = (-photoRotation(photo) * Math.PI) / 180;
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const x = c.x + dx * Math.cos(t) - dy * Math.sin(t);
  const y = c.y + dx * Math.sin(t) + dy * Math.cos(t);
  return x >= r.xMm && x <= r.xMm + r.widthMm &&
         y >= r.yMm && y <= r.yMm + r.heightMm;
}

/**
 * Keep the scale inside the envelope above, whatever it was asked for.
 *
 * Clamped on the LONGEST edge rather than on the scale itself, because the
 * limits are about the size of the thing on the wall and a scale means nothing
 * without the pixel count beside it.
 */
export function clampMmPerPixel(
  mmPerPixel: number,
  pixelWidth: number,
  pixelHeight: number,
): number {
  const longest = Math.max(1, pixelWidth, pixelHeight);
  if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0) return MIN_PHOTO_SPAN_MM / longest;
  return Math.min(
    MAX_PHOTO_SPAN_MM / longest,
    Math.max(MIN_PHOTO_SPAN_MM / longest, mmPerPixel),
  );
}

export function clampPhotoOpacity(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_PHOTO_OPACITY;
  return Math.min(MAX_PHOTO_OPACITY, Math.max(MIN_PHOTO_OPACITY, v));
}

/**
 * A new photo, fitted across the wall and centred on it.
 *
 * Fitted rather than left at some arbitrary scale so that the very first frame
 * shows the picture roughly where the wall is: a photo that lands 40 m off the
 * plan is one the user has to find before they can calibrate it, and finding it
 * means knowing the scale, which is the thing they have not set yet.
 *
 * `calibrated` is false, and stays false until a distance is actually measured.
 * The fit is a placement, not a measurement, and the panel says so.
 */
export function newWallPhoto(
  id: string,
  name: string,
  pixelWidth: number,
  pixelHeight: number,
  wall: WallSpec,
): WallPhoto {
  const w = Math.max(1, Math.round(pixelWidth));
  const h = Math.max(1, Math.round(pixelHeight));
  // Contain, not cover: the whole picture on the wall, so nothing the user may
  // want to calibrate against is off the plan to begin with.
  const mmPerPixel = clampMmPerPixel(
    Math.min(wall.widthMm / w, wall.heightMm / h),
    w, h,
  );
  return {
    id,
    name,
    pixelWidth: w,
    pixelHeight: h,
    mmPerPixel,
    calibrated: false,
    xMm: (wall.widthMm - w * mmPerPixel) / 2,
    yMm: (wall.heightMm - h * mmPerPixel) / 2,
    opacity: DEFAULT_PHOTO_OPACITY,
    depth: 'behind',
    visible: true,
  };
}

/** Slide the photo by a delta, in wall millimetres. */
export function movePhoto(photo: WallPhoto, dx: number, dy: number): WallPhoto {
  return { ...photo, xMm: photo.xMm + dx, yMm: photo.yMm + dy };
}

// ---------------------------------------------------------------------------
// Calibration — two points and a distance
// ---------------------------------------------------------------------------

export interface Calibration {
  photo: WallPhoto | null;
  /** Why it could not be done, as a sentence. Null when it was. */
  refusal: string | null;
}

/**
 * Scale the photo so that `a` and `b` are `realMm` apart.
 *
 * **Anchored on `a`, which is the whole usability of the gesture.** You click a
 * feature you can name — the corner of the switch plate, the edge of the door
 * frame — and then a second one, and the first stays exactly where you put it
 * while the picture grows or shrinks around it. Anchoring on the photo's centre
 * instead moves both of the points you just chose, so the thing you were
 * lining up walks off under the cursor and the next drag has to chase it.
 *
 * The two points are in WALL millimetres — the canvas has already mapped the
 * pointer through its own view — so this never has to know anything about
 * pixels on screen, zoom, or where the canvas is.
 *
 * Both failures are named rather than clamped away. A zero-length drag has no
 * scale to give, and a distance of zero or less is not a distance; silently
 * doing nothing in either case reads as the button being broken.
 */
export function calibratePhoto(
  photo: WallPhoto,
  a: Point,
  b: Point,
  realMm: number,
): Calibration {
  const measured = Math.hypot(b.x - a.x, b.y - a.y);
  if (!Number.isFinite(measured) || measured < 1e-6) {
    return {
      photo: null,
      refusal: 'Those two points are in the same place, so there is no length to scale against.',
    };
  }
  if (!Number.isFinite(realMm) || realMm <= 0) {
    return { photo: null, refusal: 'Give the real distance between the two points, in millimetres.' };
  }

  const wanted = realMm / measured;
  const mmPerPixel = clampMmPerPixel(photo.mmPerPixel * wanted, photo.pixelWidth, photo.pixelHeight);
  // The factor actually applied, which is the clamped one — using `wanted` here
  // would move the anchor whenever the clamp bit, and the anchor staying put is
  // the one thing this gesture promises.
  const factor = mmPerPixel / photo.mmPerPixel;
  if (Math.abs(factor - wanted) > 1e-9) {
    return {
      photo: null,
      refusal:
        `That would make the photo ${formatSpan(Math.max(photo.pixelWidth, photo.pixelHeight) * photo.mmPerPixel * wanted)}` +
        ' across. Check the distance and which two points you clicked.',
    };
  }

  return {
    photo: {
      ...photo,
      mmPerPixel,
      calibrated: true,
      // Scaled ABOUT `a`: every point moves away from it by the same factor,
      // so `a` itself does not move at all.
      xMm: a.x + (photo.xMm - a.x) * factor,
      yMm: a.y + (photo.yMm - a.y) * factor,
    },
    refusal: null,
  };
}

function formatSpan(mm: number): string {
  return mm >= 1000 ? `${(mm / 1000).toFixed(1)} m` : `${Math.round(mm)} mm`;
}
