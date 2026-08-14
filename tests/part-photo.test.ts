/**
 * The two rules of attaching a photo to a part that do not need a browser.
 *
 * Everything else in `partPhotos.ts` is canvas work, which a node test cannot
 * do. These two are the ones that decide whether the feature is usable:
 *
 *   - **the sizing.** A phone photograph is 4 MB and 4000 px wide, and the
 *     browser's storage quota is shared with the STL bytes the 3D view needs.
 *     Twenty un-shrunk photos is eighty megabytes, and what breaks is not the
 *     picture — it is the wall's meshes, somewhere else entirely.
 *   - **the refusal.** The two real mistakes are picking the STL again and
 *     picking a RAW file the browser cannot decode. Both must be named while
 *     the person is still at the file picker.
 */

import { describe, expect, it } from 'vitest';

import { fitWithin, photoRefusal, PHOTO_MAX_BYTES, PHOTO_MAX_PX } from '../src/ui/partPhotos';

describe('fitting a photo inside the ceiling', () => {
  it('shrinks the long edge to the limit and keeps the ratio', () => {
    const { width, height } = fitWithin(4000, 3000);
    expect(width).toBe(PHOTO_MAX_PX);
    // 3000/4000 of 640 = 480, and the ratio is what a squashed photo loses.
    expect(height).toBe(Math.round((PHOTO_MAX_PX * 3000) / 4000));
    expect(width / height).toBeCloseTo(4000 / 3000, 6);
  });

  it('works the same on a portrait photo — the LONG edge is the one bounded', () => {
    const { width, height } = fitWithin(3000, 4000);
    expect(height).toBe(PHOTO_MAX_PX);
    expect(width).toBeLessThan(PHOTO_MAX_PX);
  });

  it('never enlarges: a small photo is left alone', () => {
    // Blowing a 200 px thumbnail up to 640 costs bytes to look worse.
    expect(fitWithin(200, 150)).toEqual({ width: 200, height: 150 });
  });

  it('never returns a zero edge, however extreme the ratio', () => {
    // A 1000 x 3 panorama scales its height to 1.9 px. Rounded down that is a
    // canvas of height 0, which throws rather than drawing anything.
    const { width, height } = fitWithin(1000, 3);
    expect(width).toBe(PHOTO_MAX_PX);
    expect(height).toBeGreaterThanOrEqual(1);
  });

  it('answers zero for a size that is not one, rather than NaN', () => {
    expect(fitWithin(0, 100)).toEqual({ width: 0, height: 0 });
    expect(fitWithin(Number.NaN, 100)).toEqual({ width: 0, height: 0 });
    expect(fitWithin(-10, -10)).toEqual({ width: 0, height: 0 });
  });
});

describe('which files may be a photo', () => {
  const file = (name: string, type: string, size = 1024) => ({ name, type, size });

  it('accepts the ordinary image types', () => {
    expect(photoRefusal(file('hook.jpg', 'image/jpeg'))).toBeNull();
    expect(photoRefusal(file('hook.png', 'image/png'))).toBeNull();
    expect(photoRefusal(file('hook.webp', 'image/webp'))).toBeNull();
  });

  it('accepts an image whose type the OS did not fill in, by extension', () => {
    expect(photoRefusal(file('hook.JPEG', ''))).toBeNull();
  });

  it('refuses the STL, by name, because that is the mistake people make', () => {
    const refusal = photoRefusal(file('hook.stl', 'model/stl'));
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('hook.stl');
  });

  it('refuses a file too big to be worth decoding, and says how big it is', () => {
    const refusal = photoRefusal(file('huge.jpg', 'image/jpeg', PHOTO_MAX_BYTES + 1));
    expect(refusal).toMatch(/MB/);
  });

  it('refuses an empty file', () => {
    expect(photoRefusal(file('nothing.jpg', 'image/jpeg', 0))).toMatch(/empty/);
  });
});
