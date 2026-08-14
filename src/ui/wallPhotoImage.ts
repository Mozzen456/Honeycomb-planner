/**
 * The wall photograph's pixels: stored, decoded once, and handed to both views.
 *
 * `src/core/wallPhoto.ts` owns where the photo sits and how big it is and never
 * needs to see it. This is the other half — the bytes in IndexedDB, and one
 * decoded `HTMLImageElement` per photo id, shared by the 2D canvas (which draws
 * it directly) and the 3D view (which wraps it in a texture).
 *
 * ONE decode, for the reason `partThumbnails` keeps one WebGL context: the plan
 * redraws on every pointer move, and decoding a 2048 px photograph per frame is
 * not a thing a browser will do at any speed. So the cache hands out the same
 * element for the life of the page and the draw loop can read it synchronously.
 *
 * `peekWallPhotoImage` exists for exactly that: a canvas draw effect runs now
 * and cannot await. It returns what is already decoded, and the caller kicks off
 * `wallPhotoImage` to be told when there is something to draw.
 */

import { deleteWallPhoto, getWallPhoto, putWallPhoto } from '../core/userCatalog';
import { newWallPhoto, WALL_PHOTO_MAX_PX } from '../core/wallPhoto';
import type { WallPhoto, WallSpec } from '../core/types';
import { photoRefusal, prepareImage } from './partPhotos';

interface Entry {
  url: string;
  image: HTMLImageElement;
}

/** Decoded and ready, by photo id. Read synchronously by the renderers. */
const ready = new Map<string, Entry>();
/**
 * In flight or settled, by photo id.
 *
 * A miss resolving to null is CACHED too. Both views ask on every rebuild, and a
 * layout whose photo is not on this machine would otherwise re-open IndexedDB
 * once per render for an answer that cannot change.
 */
const pending = new Map<string, Promise<HTMLImageElement | null>>();

function decode(blob: Blob): Promise<Entry | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => resolve({ url, image });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

/**
 * The decoded photograph, or null if this browser does not have its bytes.
 *
 * Null is a real answer and not an error: a layout that arrived down a share
 * link carries the alignment and never the picture, and the panel says so and
 * offers to attach the file again under the same id.
 */
export function wallPhotoImage(id: string): Promise<HTMLImageElement | null> {
  const hit = pending.get(id);
  if (hit !== undefined) return hit;
  const promise = getWallPhoto(id)
    .then(async (blob) => {
      if (blob === null) return null;
      const entry = await decode(blob);
      if (entry === null) return null;
      ready.set(id, entry);
      return entry.image;
    })
    .catch(() => null);
  pending.set(id, promise);
  return promise;
}

/** What is decoded right now — for a draw that cannot wait. */
export function peekWallPhotoImage(id: string): HTMLImageElement | null {
  return ready.get(id)?.image ?? null;
}

/** Store the prepared image and make it the one the views draw. */
export async function saveWallPhotoImage(id: string, image: Blob): Promise<boolean> {
  forgetWallPhotoImage(id);
  return putWallPhoto(id, image);
}

/** Drop the photo entirely — the bytes as well as the decoded copy. */
export async function removeWallPhotoImage(id: string): Promise<void> {
  forgetWallPhotoImage(id);
  await deleteWallPhoto(id);
}

/**
 * Take a chosen file and make it the wall's photograph: check, downscale, store.
 *
 * ONE owner, because there are two front doors — the panel in the parts list and
 * the plan's own toolbar — and a second copy of this would drift the moment one
 * of them learnt something the other did not. That is the shape of D50, D52 and
 * D66, each of which was a second reader of one fact quietly disagreeing with
 * the first.
 *
 * `keep` carries an existing ALIGNMENT over to new pixels — "replace", and "the
 * bytes are not on this machine". Someone who has lined a photo up should not
 * have to do it again because they opened the layout on their laptop.
 *
 * The id is minted FRESH every time, even when the alignment is kept, and that
 * is not cosmetic: the id is the storage key, and both views cache their decoded
 * copy against it. Re-storing under the same key leaves them holding the old
 * picture with nothing in the document to say it changed.
 *
 * Never throws. A refusal is a sentence, because the two real failures — picking
 * the STL again by mistake, and a browser that will not store anything — both
 * deserve to be named rather than reported as "that did not work".
 */
export interface WallPhotoAttachment {
  photo: WallPhoto | null;
  refusal: string | null;
}

export async function attachWallPhoto(
  file: File,
  wall: WallSpec,
  keep: WallPhoto | null,
): Promise<WallPhotoAttachment> {
  const refusal = photoRefusal(file);
  if (refusal !== null) return { photo: null, refusal };
  try {
    // Bigger than a part's thumbnail, because this one is CLICKED ON: the scale
    // comes from pointing at two features in it, and a 640 px photo of a whole
    // wall puts the corner of a light switch inside a single pixel.
    const prepared = await prepareImage(file, WALL_PHOTO_MAX_PX);
    const id = `wallphoto${Date.now().toString(36)}`;
    const stored = await saveWallPhotoImage(id, prepared.blob);
    if (!stored) {
      return {
        photo: null,
        refusal:
          'This browser would not store the photo, so it would be gone on reload. ' +
          'Check that site data is allowed for this page.',
      };
    }
    // Warm the cache before the document points at the new id, so the first
    // frame after the commit already has something to draw.
    await wallPhotoImage(id);
    if (keep) {
      /*
       * The alignment survives; the SCALE is adjusted for the new pixel count.
       *
       * `mmPerPixel` is millimetres per pixel of the STORED image, so a
       * replacement that downscaled to a different width would otherwise draw
       * the photograph at a different size on the wall while still claiming the
       * same calibration.
       */
      // The OLD bytes stay. Replacing a photo is an ordinary undoable edit, and
      // undo has to give the previous picture back rather than a layout that
      // remembers where it went and cannot show it. `pruneWallPhotos` bounds the
      // store instead of each edit guessing when a claim is over.
      return {
        photo: {
          ...keep,
          id,
          name: file.name,
          pixelWidth: prepared.width,
          pixelHeight: prepared.height,
          mmPerPixel: keep.mmPerPixel * (keep.pixelWidth / Math.max(1, prepared.width)),
        },
        refusal: null,
      };
    }
    return {
      photo: newWallPhoto(id, file.name, prepared.width, prepared.height, wall),
      refusal: null,
    };
  } catch (e) {
    return {
      photo: null,
      refusal: `That image could not be read: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Release the decoded copy without touching what is stored. */
export function forgetWallPhotoImage(id: string): void {
  const entry = ready.get(id);
  if (entry) URL.revokeObjectURL(entry.url);
  ready.delete(id);
  pending.delete(id);
}
