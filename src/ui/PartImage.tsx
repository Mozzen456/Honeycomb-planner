/**
 * The picture of a part, wherever one is shown.
 *
 * There are two sources and a strict order between them:
 *
 *   1. the PHOTOGRAPH the user attached, if there is one — what the printed
 *      thing actually looks like;
 *   2. otherwise the rendered mesh from `partThumbnails`, which is what the
 *      file contains.
 *
 * One component rather than one per surface. The rail and the library both want
 * this and they want it identically; two copies would drift the moment one of
 * them learnt about photos and the other did not — which is the shape of D50,
 * D52 and D66, each of which was a second reader of the same fact quietly
 * disagreeing with the first.
 *
 * Lazy, because the library shows fifty-one cards and each render is a WebGL
 * draw and an STL parse. The observer starts a screenful early, so the picture
 * is usually there before the card is scrolled to. A part with neither photo nor
 * render keeps its empty frame: `models/` may be absent entirely (the app builds
 * with `base: './'` and can be opened from a file:// URL) and a planner that
 * cannot fetch a model still plans.
 */

import { useEffect, useRef, useState } from 'react';

import type { CatalogPart } from '../core/types';
import { photoUrlFor } from './partPhotos';
import { thumbnailFor } from './partThumbnails';

export interface PartImageProps {
  part: CatalogPart;
  className?: string;
  /**
   * Skip the photo lookup for parts already known not to have one.
   *
   * The library reads every photo key once (`listPhotoIds`) and passes the
   * answer down, which turns fifty-one IndexedDB transactions into one. Left
   * undefined, each image asks for itself — correct, just chattier.
   */
  hasPhoto?: boolean;
}

export function PartImage({ part, className, hasPhoto }: PartImageProps): JSX.Element {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (typeof IntersectionObserver !== 'function') { setNear(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true);
        io.disconnect();
      }
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let live = true;
    const photo = hasPhoto === false ? Promise.resolve(null) : photoUrlFor(part.id);
    void photo
      .then((found) => found ?? thumbnailFor(part))
      .then((u) => { if (live) setUrl(u); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [near, part, hasPhoto]);

  return (
    <span className={className} ref={ref} aria-hidden="true">
      {url === null ? null : <img src={url} alt="" draggable={false} loading="lazy" />}
    </span>
  );
}
