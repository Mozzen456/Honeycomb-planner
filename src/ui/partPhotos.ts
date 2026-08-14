/**
 * A photograph of the printed part, for the library.
 *
 * A rendered thumbnail says what the mesh is; a photograph says what the thing
 * IS — printed in orange PETG, holding four screwdrivers, on somebody's wall.
 * That is the difference between a file listing and a shop, and it is the whole
 * reason for this module.
 *
 * Three jobs, in the order they happen:
 *
 *   1. **Check the file.** Rejected here, with a sentence, rather than stored
 *      and found to be unreadable later.
 *   2. **Downscale it.** A phone photograph is 4 MB and 4000 px wide; the
 *      biggest thing that ever draws it is a 320 px library card. Twenty parts
 *      at full size is 80 MB of a shared browser quota that also holds the STL
 *      bytes the 3D view needs — so a photo that is not shrunk costs the wall
 *      its meshes. Re-encoded as WebP where the browser will, JPEG otherwise.
 *   3. **Hand it out as a URL** the same way `partThumbnails` hands out its
 *      renders, cached per part id, so a card that re-renders does not re-read
 *      IndexedDB and does not leak an object URL per render.
 *
 * The sizing rule is a pure function and is tested as one. Everything else here
 * needs a canvas, and a canvas is what a test cannot have.
 */

import { deletePhoto, getPhoto, listPhotoIds, putPhoto } from '../core/userCatalog';

/** Longest edge we keep. Twice the biggest card, so it stays sharp on a 2× screen. */
export const PHOTO_MAX_PX = 640;

/** Refused above this, before anything is decoded. A 25 MB "photo" is not one. */
export const PHOTO_MAX_BYTES = 25 * 1024 * 1024;

const RE_ENCODE_QUALITY = 0.82;

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/**
 * Fit `width × height` inside a `max`-pixel square, keeping the aspect ratio.
 *
 * Never enlarges: a 200 px photo of a small hook stays 200 px rather than being
 * blown up into a blurry 640, which costs bytes to look worse. Rounds to whole
 * pixels and never returns zero — a 1000 × 3 panorama must still have a height
 * a canvas will accept.
 */
export function fitWithin(
  width: number,
  height: number,
  max: number = PHOTO_MAX_PX,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Why this file cannot be a photo, or null if it can.
 *
 * A sentence rather than a boolean, because "that did not work" is the message
 * this app is trying not to give: the two real failures are picking the STL
 * again by mistake and picking a RAW file the browser cannot decode, and both
 * deserve to be named.
 */
export function photoRefusal(file: { name: string; type: string; size: number }): string | null {
  if (file.size > PHOTO_MAX_BYTES) {
    return `${file.name} is ${(file.size / (1024 * 1024)).toFixed(0)} MB — pick an image under ${PHOTO_MAX_BYTES / (1024 * 1024)} MB.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.type.startsWith('image/')) return null;
  if (/\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(file.name)) return null;
  return `${file.name} is not an image the browser can show — JPEG, PNG or WebP.`;
}

// ---------------------------------------------------------------------------
// Preparing
// ---------------------------------------------------------------------------

/** The first of these the browser will actually encode to. */
function encodeType(): string {
  if (typeof document === 'undefined') return 'image/jpeg';
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  return probe.toDataURL('image/webp').startsWith('data:image/webp')
    ? 'image/webp'
    : 'image/jpeg';
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('the browser could not decode that image'));
    };
    img.src = url;
  });
}

/**
 * Decode, downscale and re-encode. Rejects only if the image cannot be read.
 *
 * A photo already smaller than the ceiling is still re-encoded, on purpose: a
 * 300 px PNG screenshot is often larger than the 640 px WebP of the same thing,
 * and this way exactly one format reaches storage.
 */
export async function preparePhoto(file: Blob): Promise<Blob> {
  const img = await loadImage(file);
  const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight);
  if (width === 0) throw new Error('that image has no size');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('this browser would not give us a canvas');
  ctx.drawImage(img, 0, 0, width, height);

  const type = encodeType();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, RE_ENCODE_QUALITY),
  );
  // `toBlob` is allowed to hand back null, and a browser that does has still
  // given us the pixels — the original is worse than the resize but better
  // than losing the picture.
  return blob ?? file;
}

// ---------------------------------------------------------------------------
// Storage and display
// ---------------------------------------------------------------------------

/**
 * Object URLs, one per part, made once.
 *
 * Not revoked on unmount: the URL belongs to the part, not to the card showing
 * it, and the library mounts and unmounts a card every time the filter changes.
 * Revoking on unmount would blank the image of a part the user scrolled past
 * and scrolled back to. `forgetPhoto` revokes, and that is the only place.
 */
const urls = new Map<string, Promise<string | null>>();

/** A displayable URL for the part's photo, or null if it has none. */
export function photoUrlFor(partId: string): Promise<string | null> {
  const hit = urls.get(partId);
  if (hit !== undefined) return hit;
  const pending = getPhoto(partId)
    .then((blob) => (blob === null ? null : URL.createObjectURL(blob)))
    .catch(() => null);
  urls.set(partId, pending);
  return pending;
}

/** Store a prepared photo and make it the one `photoUrlFor` hands out. */
export async function savePhoto(partId: string, image: Blob): Promise<boolean> {
  const stored = await putPhoto(partId, image);
  forgetPhotoUrl(partId);
  return stored;
}

/** Drop the part's photo entirely — used when the part itself is removed. */
export async function removePhoto(partId: string): Promise<void> {
  forgetPhotoUrl(partId);
  await deletePhoto(partId);
}

/** Release the cached URL without touching what is stored. */
export function forgetPhotoUrl(partId: string): void {
  const pending = urls.get(partId);
  urls.delete(partId);
  void pending?.then((url) => {
    if (url !== null) URL.revokeObjectURL(url);
  });
}

export { listPhotoIds };
