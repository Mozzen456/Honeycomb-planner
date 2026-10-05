/**
 * What colour a thing on the wall is printed in.
 *
 * A build is not one spool. The plates go on in white, the hooks in black, and
 * the three bins by the door in orange because that is what was left — so the
 * document carries four levels of answer and this module is the only place that
 * knows which one wins:
 *
 *   1. THIS placed item (`colors.items[itemId]`)
 *   2. everything on its parts-list line (`colors.lines[partId]`)
 *   3. the default for its kind — `colors.panels` for plates, `colors.parts`
 *      for everything that clips into them
 *   4. nothing, meaning "as the theme draws it"
 *
 * Both views ask through here rather than reading the fields, for the reason
 * D50, D52 and D66 each record separately: a second reader of one fact drifts
 * from the first, and here it would drift into the plan and the 3D view printing
 * the same wall in two different colours.
 *
 * `undefined` is a real answer at every level and is NOT a hole to fill with a
 * literal. The theme owns the untouched colours (`tokens.css`), and only the
 * caller knows which of its own tones applies — the plate tint, the item fill,
 * the selection colour it uses instead while something is selected.
 */

import type { BomLine, LayoutDoc, PlacedItem, WallColors } from './types';

/** Only `#rgb` and `#rrggbb` — see the note on `WallColors`. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * A colour, or nothing at all.
 *
 * Every colour entering the document goes through here — from the picker, from
 * a file, from a share link — because the value ends up in a canvas
 * `fillStyle` and in a `THREE.Color`, both of which take arbitrary strings and
 * do something unhelpful with the ones they cannot parse. `#abc` is expanded so
 * that everything downstream can assume one shape, and the case is normalised so
 * that `#FFF` and `#ffffff` are the same colour to a `===`.
 */
export function normaliseColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!HEX.test(text)) return undefined;
  const hex = text.slice(1).toLowerCase();
  return hex.length === 3
    ? `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    : `#${hex}`;
}

/** The colours of a document, with anything unreadable dropped. */
export function readColors(colors: WallColors | undefined): WallColors {
  if (!colors) return {};
  const out: WallColors = {};
  const panels = normaliseColor(colors.panels);
  const parts = normaliseColor(colors.parts);
  if (panels) out.panels = panels;
  if (parts) out.parts = parts;
  for (const field of ['lines', 'items'] as const) {
    const source = colors[field];
    if (!source || typeof source !== 'object') continue;
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
      const colour = normaliseColor(value);
      if (key.length > 0 && colour) kept[key] = colour;
    }
    if (Object.keys(kept).length > 0) out[field] = kept;
  }
  return out;
}

/** Has anything been coloured at all? */
export function hasColors(colors: WallColors | undefined): boolean {
  if (!colors) return false;
  return (
    colors.panels !== undefined ||
    colors.parts !== undefined ||
    Object.keys(colors.lines ?? {}).length > 0 ||
    Object.keys(colors.items ?? {}).length > 0
  );
}

/**
 * What a wall is printed in when nobody has said (D127): black plates, and
 * orange for everything that goes on them — accessories, inserts and the wall
 * fixings alike. Asked for directly, and the commonest two-colour build of
 * this wall. A choice on the document, at any level, still wins; these are
 * only the last level, where "as the theme draws it" used to be.
 *
 * Not pure #000: a plate drawn in true black loses its cell walls to the
 * shading, and in the dark theme sits on a near-black background.
 */
export const DEFAULT_PANEL_COLOR = '#262626';
export const DEFAULT_PART_COLOR = '#f07f1a';

/**
 * A chosen colour as it should be DRAWN on a given background: itself, unless
 * the background is dark and the colour darker still, when it is carried toward
 * white until it stands off by a fixed step. The default plate is near-black,
 * and drawn literally on the dark theme the honeycomb disappears into the
 * canvas. Only the drawing moves; the document, the parts list and the exports
 * keep the colour that was chosen. `#rgb`, `#rrggbb` and `rgb()` are read;
 * anything else is returned untouched.
 */
export function standOffColor(colour: string, background: string): string {
  const c = parseRgb(colour);
  const bg = parseRgb(background);
  if (!c || !bg) return colour;
  const lum = (v: number[]) => (0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!) / 255;
  if (lum(bg) > 0.5) return colour;
  const need = lum(bg) + 0.3;
  if (lum(c) >= need) return colour;
  let out = c;
  for (let i = 0; i < 40 && lum(out) < need; i++) out = out.map((v) => v + (255 - v) * 0.05);
  return '#' + out.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

function parseRgb(css: string): number[] | undefined {
  const s = css.trim();
  const hex = normaliseColor(s);
  if (hex) return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/**
 * The colour of one placed item: itself, then its line, then the default for
 * everything that clips into the wall.
 */
export function colorOfItem(
  colors: WallColors | undefined,
  item: Pick<PlacedItem, 'id' | 'partId'>,
): string | undefined {
  return colors?.items?.[item.id] ?? colors?.lines?.[item.partId] ?? colors?.parts ?? DEFAULT_PART_COLOR;
}

/**
 * The colour of one plate, by the LINE it is counted on.
 *
 * The line key, not the part id: a plate cut round a switch or carrying an edge
 * is counted as a generated plate (D56, D66, D92), and colouring it from the
 * shipped part's line would paint plates that are not the same object. The
 * caller gets the key from `bom.panelLineKeys`, which is the one place that
 * split is decided.
 */
export function colorOfPanel(
  colors: WallColors | undefined,
  lineKey: string | undefined,
): string | undefined {
  return (lineKey !== undefined ? colors?.lines?.[lineKey] : undefined) ?? colors?.panels ?? DEFAULT_PANEL_COLOR;
}

/**
 * What the swatch on a parts-list line should show: the line's own colour, or
 * the default its kind would fall back to, or nothing.
 */
export function colorOfLine(
  colors: WallColors | undefined,
  lineKey: string,
  isPanel: boolean,
): string | undefined {
  return colors?.lines?.[lineKey]
    ?? (isPanel ? colors?.panels ?? DEFAULT_PANEL_COLOR : colors?.parts ?? DEFAULT_PART_COLOR);
}

/**
 * The colours a build needs — what to tell the printer, and what a person counts
 * spools against.
 *
 * Off the PARTS LIST, because that is exactly the set of things that get
 * printed: every plate line, every accessory, and every insert — including the
 * ones the app puts in itself, the wall fixings, which is where this started.
 * Walking the document instead missed them, because a planned fixing is not a
 * placed item, and the row of chips then disagreed with the wall it sat under.
 *
 * Item overrides are added on top: one bin painted differently is a colour in
 * this build that no LINE mentions.
 *
 * Only what is actually used. A default nothing falls back to is not a spool you
 * have to buy, and neither is a line colour for a part that is not on this wall
 * — both are decisions with nothing on the other end of them. `undefined` — "as
 * the theme draws it" — is deliberately not in here either; it is the absence of
 * a decision, not a colour.
 */
export function colorsInUse(
  doc: LayoutDoc | undefined,
  lines: readonly Pick<BomLine, 'color'>[],
): string[] {
  const seen = new Set<string>();
  for (const line of lines) if (line.color) seen.add(line.color);

  const items = doc?.colors?.items;
  if (items) {
    for (const item of doc?.items ?? []) {
      const own = items[item.id];
      if (own) seen.add(own);
    }
  }
  return [...seen].sort();
}
