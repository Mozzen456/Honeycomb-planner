/**
 * The wall photograph: the calibration, and the plumbing that keeps it.
 *
 * The subject of every test here is one number — millimetres per image pixel —
 * and the two things that number has to be true about:
 *
 *   1. **After scaling, the two points the user clicked really are the distance
 *      apart they said.** Stated on the IMAGE rather than on the wall, because
 *      that is what makes it a scale rather than an arithmetic identity: the
 *      pixels under the two clicks are found before the calibration and looked
 *      up again afterwards. An assertion phrased on the wall points alone would
 *      be `|b − a| = realMm` by construction and would pass with the factor
 *      inverted.
 *   2. **The first point does not move.** The whole usability of the gesture:
 *      you click a corner you can name, and it stays under the cursor while the
 *      picture grows around it. Again asserted in image pixels — the pixel under
 *      `a` before must be the pixel under `a` after.
 *
 * Both were checked by breaking the code deliberately: anchoring on the photo's
 * centre fails (2), and inverting `realMm / measured` fails (1).
 */

import { describe, expect, it } from 'vitest';

import type { Point } from '../src/core/hex';
import { deserialize, serialize } from '../src/core/persist';
import { emptyDoc, Store } from '../src/core/store';
import { staleWallPhotoIds } from '../src/core/userCatalog';
import catalogJson from '../src/catalog/catalog.json';
import type { Catalog, LayoutDoc, WallPhoto } from '../src/core/types';
import {
  calibratePhoto, clampMmPerPixel, DEFAULT_PHOTO_OPACITY, MAX_PHOTO_SPAN_MM, MIN_PHOTO_SPAN_MM,
  movePhoto, newWallPhoto, photoCentreMm, photoHit, photoRectMm,
} from '../src/core/wallPhoto';

const catalog = catalogJson as unknown as Catalog;
const WALL = { widthMm: 2400, heightMm: 1200 };

/** Which image pixel is under this point on the wall. The inverse of the draw. */
function pixelUnder(photo: WallPhoto, p: Point): Point {
  return {
    x: (p.x - photo.xMm) / photo.mmPerPixel,
    // Image pixels run DOWN from the top-left; the wall runs up. The flip is
    // not what is under test, but getting it wrong here would make the anchor
    // assertion pass for the wrong reason.
    y: (photo.yMm + photo.pixelHeight * photo.mmPerPixel - p.y) / photo.mmPerPixel,
  };
}

/** Where on the wall a given image pixel has landed. */
function wallUnder(photo: WallPhoto, px: Point): Point {
  return {
    x: photo.xMm + px.x * photo.mmPerPixel,
    y: photo.yMm + photo.pixelHeight * photo.mmPerPixel - px.y * photo.mmPerPixel,
  };
}

describe('newWallPhoto', () => {
  it('fits the whole picture on the wall and centres it', () => {
    const photo = newWallPhoto('p1', 'wall.jpg', 2048, 1536, WALL);
    const r = photoRectMm(photo);
    expect(r.widthMm).toBeLessThanOrEqual(WALL.widthMm + 1e-9);
    expect(r.heightMm).toBeLessThanOrEqual(WALL.heightMm + 1e-9);
    // Contained, not cropped: one dimension touches the wall exactly.
    expect(Math.min(WALL.widthMm - r.widthMm, WALL.heightMm - r.heightMm)).toBeCloseTo(0, 6);
    expect(photoCentreMm(photo).x).toBeCloseTo(WALL.widthMm / 2, 6);
    expect(photoCentreMm(photo).y).toBeCloseTo(WALL.heightMm / 2, 6);
  });

  it('is NOT calibrated, because fitting it is a placement and not a measurement', () => {
    expect(newWallPhoto('p1', 'wall.jpg', 2048, 1536, WALL).calibrated).toBe(false);
  });

  it('starts behind the honeycomb, visible, at the default opacity', () => {
    const photo = newWallPhoto('p1', 'wall.jpg', 1000, 800, WALL);
    expect(photo.depth).toBe('behind');
    expect(photo.visible).toBe(true);
    expect(photo.opacity).toBe(DEFAULT_PHOTO_OPACITY);
  });
});

describe('photoRectMm / photoHit / movePhoto', () => {
  const photo: WallPhoto = {
    ...newWallPhoto('p1', 'w.jpg', 1000, 500, WALL),
    mmPerPixel: 2, xMm: 100, yMm: 200,
  };

  it('is pixels × scale, from the lower-left corner', () => {
    expect(photoRectMm(photo)).toEqual({
      xMm: 100, yMm: 200, widthMm: 2000, heightMm: 1000,
    });
  });

  it('is hit inside its rectangle and not outside it', () => {
    expect(photoHit(photo, { x: 500, y: 500 })).toBe(true);
    expect(photoHit(photo, { x: 100, y: 200 })).toBe(true);   // exactly the corner
    expect(photoHit(photo, { x: 99.9, y: 500 })).toBe(false);
    expect(photoHit(photo, { x: 500, y: 1200.1 })).toBe(false);
  });

  it('moves without changing size', () => {
    const moved = movePhoto(photo, -40, 15);
    expect(moved.xMm).toBe(60);
    expect(moved.yMm).toBe(215);
    expect(photoRectMm(moved).widthMm).toBe(photoRectMm(photo).widthMm);
  });
});

describe('calibratePhoto', () => {
  const base = newWallPhoto('p1', 'wall.jpg', 2000, 1500, WALL);

  it('makes the two clicked points exactly the stated distance apart', () => {
    // Two points on the photo, wherever the fitted scale happens to put them.
    const a: Point = { x: 400, y: 300 };
    const b: Point = { x: 1600, y: 900 };
    const pxA = pixelUnder(base, a);
    const pxB = pixelUnder(base, b);

    const { photo, refusal } = calibratePhoto(base, a, b, 850);
    expect(refusal).toBeNull();
    expect(photo).not.toBeNull();

    // The SAME two features of the picture, looked up again after the scaling.
    const nowA = wallUnder(photo!, pxA);
    const nowB = wallUnder(photo!, pxB);
    expect(Math.hypot(nowB.x - nowA.x, nowB.y - nowA.y)).toBeCloseTo(850, 6);
  });

  it('leaves the first point exactly where it was', () => {
    const a: Point = { x: 400, y: 300 };
    const b: Point = { x: 1600, y: 900 };
    const pxA = pixelUnder(base, a);

    const { photo } = calibratePhoto(base, a, b, 850);
    const nowA = wallUnder(photo!, pxA);
    expect(nowA.x).toBeCloseTo(a.x, 6);
    expect(nowA.y).toBeCloseTo(a.y, 6);
  });

  it('shrinks when the real distance is smaller and grows when it is larger', () => {
    const a: Point = { x: 400, y: 300 };
    const b: Point = { x: 1400, y: 300 };  // 1000 mm apart as currently drawn
    const smaller = calibratePhoto(base, a, b, 500).photo!;
    const larger = calibratePhoto(base, a, b, 2000).photo!;
    expect(smaller.mmPerPixel).toBeCloseTo(base.mmPerPixel / 2, 9);
    expect(larger.mmPerPixel).toBeCloseTo(base.mmPerPixel * 2, 9);
  });

  it('marks the photo as calibrated', () => {
    expect(base.calibrated).toBe(false);
    expect(calibratePhoto(base, { x: 0, y: 0 }, { x: 100, y: 0 }, 90).photo!.calibrated).toBe(true);
  });

  it('refuses a zero-length drag, in a sentence', () => {
    const { photo, refusal } = calibratePhoto(base, { x: 500, y: 500 }, { x: 500, y: 500 }, 100);
    expect(photo).toBeNull();
    expect(refusal).toMatch(/same place/i);
  });

  it('refuses a distance that is not one', () => {
    for (const bad of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { photo, refusal } = calibratePhoto(base, { x: 0, y: 0 }, { x: 100, y: 0 }, bad);
      expect(photo).toBeNull();
      expect(refusal).toMatch(/real distance/i);
    }
  });

  it('refuses rather than silently clamping a wildly wrong distance', () => {
    // 1 mm between two points a metre apart on screen: the picture would end up
    // kilometres across. Clamping would leave the anchor somewhere else and the
    // scale a lie, so it is refused and said.
    const { photo, refusal } = calibratePhoto(base, { x: 400, y: 300 }, { x: 1400, y: 300 }, 1e6);
    expect(photo).toBeNull();
    expect(refusal).toMatch(/across/i);
  });
});

describe('clampMmPerPixel', () => {
  it('keeps the longest edge inside the envelope', () => {
    expect(clampMmPerPixel(1e9, 2000, 1000) * 2000).toBeCloseTo(MAX_PHOTO_SPAN_MM, 6);
    expect(clampMmPerPixel(1e-9, 2000, 1000) * 2000).toBeCloseTo(MIN_PHOTO_SPAN_MM, 6);
  });

  it('passes a sane scale through untouched', () => {
    expect(clampMmPerPixel(1.2, 2000, 1000)).toBe(1.2);
  });

  it('never returns a scale that is not a positive number', () => {
    for (const bad of [0, -1, Number.NaN]) {
      expect(clampMmPerPixel(bad, 2000, 1000)).toBeGreaterThan(0);
    }
  });
});

/**
 * Removing a photo must NOT drop its bytes, because removing is undoable.
 *
 * So the store is bounded as a CACHE instead, and the two properties that make
 * that safe are the subject here: the newest survive, and anything the caller
 * protects survives whatever its age.
 */
describe('staleWallPhotoIds', () => {
  // Ids are `wallphoto` + base-36 milliseconds, so they sort oldest-first.
  const ids = ['wallphoto1', 'wallphoto2', 'wallphoto3', 'wallphoto4', 'wallphoto5'];

  it('drops the oldest and keeps the newest', () => {
    expect(staleWallPhotoIds(ids, 2)).toEqual(['wallphoto1', 'wallphoto2', 'wallphoto3']);
  });

  it('drops nothing while the store is inside the bound', () => {
    expect(staleWallPhotoIds(ids, 5)).toEqual([]);
    expect(staleWallPhotoIds(ids, 99)).toEqual([]);
  });

  it('never drops a protected id, however old it is', () => {
    // The open document's own photograph, and the oldest thing in the store.
    expect(staleWallPhotoIds(ids, 2, ['wallphoto1'])).toEqual(['wallphoto2', 'wallphoto3']);
    expect(staleWallPhotoIds(ids, 0, ['wallphoto1'])).not.toContain('wallphoto1');
  });

  it('orders by age and not by string length, on the day the stamp grows a digit', () => {
    // 'wallphotozz' is older than 'wallphotoaaa': fewer digits is earlier in
    // base 36. Sorted as plain strings, 'wallphotoaaa' would come first and the
    // NEWER photo would be the one dropped.
    expect(staleWallPhotoIds(['wallphotoaaa', 'wallphotozz'], 1)).toEqual(['wallphotozz']);
  });
});

describe('the document', () => {
  const withPhoto = (): LayoutDoc => ({
    ...emptyDoc(),
    photo: {
      id: 'wallphoto1', name: 'garage.jpg',
      pixelWidth: 2048, pixelHeight: 1536,
      mmPerPixel: 1.1719, calibrated: true,
      xMm: 120.5, yMm: -40.2,
      opacity: 0.35, depth: 'front', visible: true,
    },
  });

  it('round-trips through save and load, scale included to full precision', () => {
    const back = deserialize(serialize(withPhoto()));
    expect(back.errors).toEqual([]);
    expect(back.doc?.photo).toEqual(withPhoto().photo);
  });

  it('leaves an absent photo absent — no key, not an undefined one', () => {
    const text = serialize(emptyDoc());
    expect(text).not.toContain('photo');
    const back = deserialize(text);
    expect(back.doc && 'photo' in back.doc).toBe(false);
  });

  it('drops a photo that is not one, and says so', () => {
    const back = deserialize(JSON.stringify({ ...emptyDoc(), photo: 'garage.jpg' }));
    expect(back.doc?.photo).toBeUndefined();
    expect(back.errors.join(' ')).toMatch(/photo/i);
  });

  it('drops a photo with no scale rather than inventing one', () => {
    const doc = withPhoto() as unknown as Record<string, unknown>;
    (doc['photo'] as Record<string, unknown>)['mmPerPixel'] = 'big';
    const back = deserialize(JSON.stringify(doc));
    expect(back.doc?.photo).toBeUndefined();
    expect(back.errors.join(' ')).toMatch(/mmPerPixel/);
  });

  it('reads every field back, so no setting lasts only one session', () => {
    // The failure this guards is D44's: a field written, stored, and never read.
    const back = deserialize(serialize(withPhoto())).doc?.photo;
    expect(back?.depth).toBe('front');
    expect(back?.calibrated).toBe(true);
    expect(back?.opacity).toBeCloseTo(0.35, 6);
    expect(back?.name).toBe('garage.jpg');
  });

  it('clamps a stored opacity and defaults a missing visibility to shown', () => {
    const doc = withPhoto() as unknown as Record<string, unknown>;
    const p = doc['photo'] as Record<string, unknown>;
    p['opacity'] = 12;
    delete p['visible'];
    const back = deserialize(JSON.stringify(doc)).doc?.photo;
    expect(back?.opacity).toBe(1);
    expect(back?.visible).toBe(true);
  });

  it('undoes as one edit, and removing it takes the key out', () => {
    const store = new Store(emptyDoc(), catalog);
    const photo = newWallPhoto('wallphoto1', 'garage.jpg', 2048, 1536, WALL);
    store.setPhoto(photo);
    expect(store.getState().doc.photo?.id).toBe('wallphoto1');

    store.setPhoto(undefined);
    expect('photo' in store.getState().doc).toBe(false);

    store.undo();
    expect(store.getState().doc.photo?.id).toBe('wallphoto1');
    store.undo();
    expect(store.getState().doc.photo).toBeUndefined();
  });

  it('does not cut a single cell — a photo is a reference, not an obstruction', () => {
    const store = new Store({ ...emptyDoc(), panels: [
      { id: 'p1', partId: 'wall-honeycomb-part', origin: { q: 0, r: 0 }, columns: 4, rows: 4 },
    ] }, catalog);
    const before = store.getState().doc.panels;
    store.setPhoto(newWallPhoto('wallphoto1', 'garage.jpg', 2048, 1536, WALL));
    expect(store.getState().doc.panels).toEqual(before);
  });
});
