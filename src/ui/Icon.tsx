/**
 * The icon set.
 *
 * One file, one grid, one stroke weight. Before this the product had exactly two
 * glyphs — a sun and a moon typed as text — and every other control was a word
 * in a bordered box, which is why a toolbar of eight actions read as a debug
 * panel rather than as an application.
 *
 * The rules, so a ninth icon cannot arrive drawn differently:
 *
 *   - 24 × 24 viewBox, drawn on a 2px grid, rendered at 16px (--icon-size-sm)
 *     or 20px (--icon-size-md). Never a raw pixel size at the call site.
 *   - STROKE, never fill. `base.css` sets `svg { fill: currentColor }` for the
 *     app's other inline SVG, so every icon here sets `fill="none"` on the root
 *     and inherits `stroke="currentColor"` — colour is the parent's job, which
 *     is what lets one icon sit in a ghost button, a primary button and a
 *     danger row without three variants of it.
 *   - 1.75 stroke, round caps and joins. Hairline at 1 disappears against
 *     --surface-1 in the light theme; 2 is heavy beside 13px text.
 *   - `aria-hidden`. An icon never carries the name of its control: the button
 *     around it has the label, and an icon that also announces itself makes
 *     every icon button say everything twice.
 *
 * Geometry that means something in this product is drawn from the product: the
 * view switch's `plan` mark is a real hexagon and `wall` is three of them in the
 * lattice's own stagger, so the two views are told apart by their subject rather
 * than by a generic cube-and-grid pair.
 */

import type { SVGProps } from 'react';

/** Every icon this app has. Adding one here is the only way to add one. */
export type IconName =
  | 'undo'
  | 'redo'
  | 'share'
  | 'import'
  | 'download'
  | 'more'
  | 'sun'
  | 'moon'
  | 'wall'
  | 'plan'
  | 'solve'
  | 'printer'
  | 'ruler'
  | 'search'
  | 'close'
  | 'plus'
  | 'minus'
  | 'target'
  | 'trash'
  | 'check'
  | 'alert'
  | 'info'
  | 'photo'
  | 'zone'
  | 'palette'
  | 'chevronDown'
  | 'chevronRight'
  | 'sparkle'
  | 'coffee'
  | 'layers';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  name: IconName;
  /** 'sm' = 16px (default, beside 13px text), 'md' = 20px (empty states). */
  size?: 'sm' | 'md';
}

/**
 * Path data only — the wrapper below supplies the frame, so no path here may
 * set its own stroke, size or colour.
 */
const PATHS: Record<IconName, JSX.Element> = {
  undo: (
    <>
      <path d="M4 8h10a5 5 0 0 1 0 10H9" />
      <path d="M8 4 4 8l4 4" />
    </>
  ),
  redo: (
    <>
      <path d="M20 8H10a5 5 0 0 0 0 10h5" />
      <path d="m16 4 4 4-4 4" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4" />
    </>
  ),
  import: (
    <>
      <path d="M12 15V3" />
      <path d="m8 7 4-4 4 4" />
      <path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m8 11 4 4 4-4" />
      <path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
  /* The wall: THREE cells in the lattice's own stagger — flat-top, the next
     column dropped half a pitch, which is what makes it this product's wall
     rather than a generic grid. Three and not five: at 16px five hexagons of
     this weight merge into a blob, which on screen read as an asterisk. */
  wall: (
    <>
      <path d="M12 8.1 9.8 12H5.3L3 8.1 5.3 4.2h4.5Z" />
      <path d="M12 15.9 9.8 19.8H5.3L3 15.9 5.3 12h4.5Z" />
      <path d="M18.8 12l-2.3 3.9H12L9.8 12 12 8.1h4.5Z" />
    </>
  ),
  /* The plan: one cell inside the wall's extent. A rectangle round a hexagon is
     the plan view's whole job — how far the wall goes, and the lattice in it. */
  plan: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M17 12l-2.5 4.3h-5L7 12l2.5-4.3h5Z" />
    </>
  ),
  solve: (
    <>
      <path d="M12 3.2 18 6.6v6.8L12 16.8 6 13.4V6.6Z" />
      <path d="M6 6.6l6 3.4 6-3.4M12 10v6.8" />
      <path d="M4 19.5h16" />
    </>
  ),
  printer: (
    <>
      <path d="M7 9V4h10v5" />
      <path d="M5 9h14a2 2 0 0 1 2 2v5h-4" />
      <path d="M7 16H3v-5a2 2 0 0 1 2-2" />
      <rect x="7" y="14" width="10" height="6" rx="1" />
    </>
  ),
  ruler: (
    <>
      <rect x="2.5" y="8.5" width="19" height="7" rx="1.5" />
      <path d="M7 8.5v3m3.3-3v4.5m3.4-4.5v3m3.3-3v4.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  target: (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 2v3m0 14v3M2 12h3m14 0h3" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V4.5h6V7" />
      <path d="M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  alert: (
    <>
      <path d="M12 3.5 22 20H2Z" />
      <path d="M12 10v4.5" />
      <circle cx="12" cy="17.4" r="0.9" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.8" r="0.9" />
    </>
  ),
  photo: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" />
    </>
  ),
  zone: (
    <>
      <path d="M3 6.5V5a2 2 0 0 1 2-2h1.5M17.5 3H19a2 2 0 0 1 2 2v1.5M21 17.5V19a2 2 0 0 1-2 2h-1.5M6.5 21H5a2 2 0 0 1-2-2v-1.5" />
      <path d="M10 3h4M3 10v4M21 10v4M10 21h4" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3a9 9 0 0 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.1 0-1 .8-1.7 1.8-1.7H16a5 5 0 0 0 5-5c0-4-4-7.3-9-7.3Z" />
      <circle cx="8" cy="11" r="1.1" />
      <circle cx="12" cy="8" r="1.1" />
      <circle cx="16" cy="11" r="1.1" />
    </>
  ),
  chevronDown: <path d="m6 9.5 6 6 6-6" />,
  chevronRight: <path d="m9.5 6 6 6-6 6" />,
  sparkle: (
    <>
      <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9Z" />
      <path d="M18.5 16.5 19.2 19l2.3.8-2.3.7-.7 2.5-.7-2.5-2.3-.7 2.3-.8Z" />
    </>
  ),
  /* The support link. Drawn on this grid like everything else rather than
     pasted in from Buy Me a Coffee's own artwork: their mark is a raster asset
     on a fixed yellow, and it cannot inherit `currentColor`, sit on the 24-grid
     or take the same 1.75 stroke as its neighbours. The BUTTON carries their
     brand — their yellow, their wording — which is what makes it recognisable;
     the glyph only has to be a cup. */
  coffee: (
    <>
      <path d="M4 8.5h13v5.4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Z" />
      <path d="M17 10.2h1.4a2.6 2.6 0 0 1 0 5.2H17" />
      <path d="M7.8 2.4v2.6M12.2 2.4v2.6" />
      <path d="M3.5 21.6h14" />
    </>
  ),
  /* Saved walls: several of the same thing, stacked. Not a folder — nothing here
     is a file system, and a folder promises somewhere to put things. */
  layers: (
    <>
      <path d="m12 3 9 4.6-9 4.6-9-4.6Z" />
      <path d="m3.6 12.3 8.4 4.3 8.4-4.3" />
      <path d="m3.6 16.8 8.4 4.3 8.4-4.3" />
    </>
  ),
};

/**
 * Draw one icon.
 *
 * `focusable="false"` matters on more than IE: a nested SVG can take a tab stop
 * in some engines, and every icon here lives inside a control that already has
 * one — the button would then need two presses to leave.
 */
export function Icon({ name, size = 'sm', className, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className === undefined ? `icon icon--${size}` : `icon icon--${size} ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
