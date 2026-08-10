# Design tokens

`src/ui/tokens.css` is the only file in this app allowed to contain a colour
literal. `src/ui/base.css` resets bare HTML elements using nothing but those
tokens. Everything else — components, the canvas renderer, print styles —
consumes the tokens and defines no values of its own.

Import once, at the app entry point:

```ts
import './ui/base.css';   // pulls in tokens.css itself
```

---

## The one rule

**If you are about to type `#`, `rgb(`, `hsl(`, a px value, or a duration into a
component, stop.** Either a token already covers it, or the token layer is
missing something and this file is where that gets fixed. A one-off value is a
theme bug that will not show up until someone switches to dark.

Two corollaries:

- **Consume semantic tokens, never primitives.** `--neutral-500` has a value but
  no meaning. `--border-default` has a meaning, and that meaning survives a
  theme change. A component that references `--neutral-*`, `--blue-*`,
  `--red-*`, `--amber-*`, `--green-*` or `--ink-*` is broken in dark mode by
  construction — those names are theme-agnostic and do not move.
- **Do not redefine a token to mean something else locally.** Scoping a token to
  a subtree (`.panel { --surface-1: var(--surface-2) }`) is legitimate for
  nesting elevation. Redefining what it *is* is not.

---

## Token groups

### Colour — surfaces

| Token | Role |
|---|---|
| `--surface-0` | App shell, gutters, the ground the canvas sits on |
| `--surface-1` | Chrome panels: top bar, left catalogue, right parts list |
| `--surface-2` | Raised within a panel: list rows, inputs, wells |
| `--surface-3` | Detached: popovers, menus, dialogs |

Four elevation levels, lowest to highest. In light, higher is lighter; in dark,
higher is lighter too — the ramp is shared but each theme picks its own rungs.
**Express elevation with surface colour first.** A shadow is only for something
that genuinely floats (menu, dialog, drag preview). Cards get a border, not a
shadow.

### Colour — text

| Token | Role | Floor |
|---|---|---|
| `--text-primary` | Body, values, anything you must read | 4.5:1 |
| `--text-secondary` | Supporting text, column headers, inactive tabs | 4.5:1 |
| `--text-tertiary` | Metadata, hints, units | 4.5:1 |
| `--text-disabled` | Unavailable controls **only** | 3:1 |
| `--accent-on` | Text/icons sitting on an accent fill | 4.5:1 |

`--text-tertiary` still clears 4.5:1 on every surface — "quiet" is not an excuse
for illegible. `--text-disabled` is the only text token below 4.5:1, is exempt
from WCAG 1.4.3 because it marks an inactive control, and still clears 3:1.
Never use it for text that is merely low-priority; that is `--text-tertiary`.

### Colour — borders

| Token | Role |
|---|---|
| `--border-subtle` | Decorative hairlines *inside* a surface: row rules, card edges |
| `--border-default` | The boundary of an interactive control. Measured ≥ 3:1 on every surface, both themes |
| `--border-strong` | Emphasis: dividers between major regions, hovered control edges |

`--border-subtle` is deliberately below 3:1. **It must never be the only thing
telling the user that a control exists** — if a border is the sole boundary of
an input, button or drop target, it is `--border-default` or stronger.

### Colour — accent

`--accent`, `--accent-hover`, `--accent-active`, `--accent-on`, `--accent-bg`
(low-alpha), `--accent-border`, plus `--accent-rgb` for custom alphas.

One accent, one hue: **azure**. It means exactly four things — selection, the
active/current item, focus, and the primary action in a group. Nothing is accent
coloured because it would look nice. If more than roughly 2% of the pixels on
screen are accent, something has gone wrong.

For a custom alpha, compose from the channel token rather than inventing a
colour: `rgb(var(--accent-rgb) / 0.3)`.

### Colour — status

`--danger-fg` / `--danger-bg` / `--danger-border`, and the same triple for
`--warning-*` and `--success-*`, plus `--danger-rgb` etc.

`-fg` is legible both on a bare surface and on its own `-bg`; both are measured.
Status colour is never the sole carrier of meaning — pair it with the wording
from `Issue['code']` in `src/core/types.ts` (`overlap`, `crosses-seam`, …).
Warning is amber rather than orange so it cannot be mistaken for the accent.

### Colour — canvas

| Token | Role |
|---|---|
| `--canvas-wall` | Wall area with no panel on it |
| `--canvas-panel-tint` | The printed plate material between cells |
| `--canvas-cell` | A hexagonal cell interior |
| `--canvas-cell-hover` | Cell under the pointer (opaque, pre-composited) |
| `--canvas-grid` | Lattice lines |
| `--canvas-seam` | Boundary between two panels — heavier than grid, because crossing it is an error (DECISIONS D6) |
| `--canvas-selection` / `--canvas-selection-fill` | Selected item outline and fill |
| `--canvas-ghost-valid` / `-valid-fill` | Drag preview in a legal position |
| `--canvas-ghost-invalid` / `-invalid-fill` | Drag preview in an illegal position |
| `--canvas-label` / `--canvas-label-muted` | Text drawn into the canvas |

Depth reads *inward*: wall (darkest, the void) < panel tint < cell (the open
hexagon). That is the reverse of chrome elevation on purpose — the canvas is a
hole in the app, not a card on top of it.

`--canvas-grid` is intentionally the same value in both themes: that rung of the
neutral ramp clears 3:1 against the canvas colours of light *and* dark.

The grid carries real information (it is the lattice you place parts on), so it
is held to 3:1 like any other meaningful graphic. **When 5,900 cells makes that
too dense, reduce the line width or stop drawing the grid below a zoom
threshold — never fade its colour.** Fading is how a contrast floor gets lost.

### Type

- **Stacks:** `--font-sans` (system UI stack), `--font-mono` (system mono).
  No webfonts ship with this app: no flash, no network dependency.
- **Scale:** `--font-size-2xs` (11px) → `--font-size-3xl` (32px), eight steps,
  in `rem` so browser font scaling still works. `--font-size-body` aliases the
  13px base. 13px because this is a dense tool with a 2400 mm wall to fit on a
  laptop, not a reading surface.
- **Line heights:** `--line-height-none | tight | snug | normal | relaxed`.
  Controls use `none`, list rows and table cells use `snug`, prose uses `normal`.
- **Weights:** `--font-weight-regular | medium | semibold | bold`. Reach for
  `medium` before `bold`; at 13px, bold is shouting.
- **Tracking:** `--letter-spacing-tight` (≥ 24px only), `normal`, `wide` (11px
  text, which needs air), `caps` (uppercase micro labels).

**Tabular numerals.** Anything a user compares down a column — quantities,
millimetres, grams, minutes — must use them, or the parts list jitters as
numbers change.

```css
.cell { font-variant-numeric: var(--font-numeric-tabular); }
```

`base.css` already applies this to `table`, `code`/`kbd`/`samp`/`pre`,
`input[type=number]` and `output`. For anything else, use the token above or the
`.tabular-nums` utility class. `--font-numeric-proportional` exists to opt back
out inside prose.

### Space

`--space-0`, `--space-0-5` (2px), `--space-1` … `--space-8` — a 4px base:
4, 8, 12, 16, 24, 32, 48, 64. **No off-scale values anywhere.** `--space-0-5` is
for optical nudges and hairline gaps only, not as a general half-step.

Rules of thumb: `--space-3` inside a control, `--space-4` between controls,
`--space-5` between groups.

### Shape

`--radius-none | sm (2px) | md (4px) | lg (6px) | pill`, and
`--border-width-hair` (1px) / `--border-width-thick` (2px).

Small radii only, in px so a corner does not grow when the user increases their
font size. Inputs, buttons and chips are `sm`; cards, popovers and dialogs are
`md`; `pill` is for count badges and nothing else. Not everything is rounded —
panel edges and table rules are square.

### Elevation

`--shadow-none | sm | md | lg`, plus `--scrim` for modal backdrops.

Three quiet shadows. A shadow means "this genuinely floats above the page". It
never means "this is a card" and it is never stacked to manufacture depth. The
alphas are tokens (`--shadow-a1..a3`) because dark needs a far heavier shadow to
register at all — reusing the light alphas on dark produces nothing visible.

### Motion

`--duration-fast` (90ms, hover/focus), `--duration-base` (160ms, panel and menu),
`--duration-slow` (260ms, dialog), and `--ease-standard` (within the page),
`--ease-enter` (arriving, decelerating), `--ease-exit` (leaving, accelerating).

**Never transition a property the pointer is already driving.** Dragging a part
follows the finger with no easing; a transition there feels like lag.

`prefers-reduced-motion: reduce` collapses all three durations to 1ms and all
three curves to `linear` in `tokens.css`, so anything built from the tokens is
covered automatically. `base.css` adds a global override as a backstop.

### Size and layout

`--tap-target-min` (44px), `--control-height-sm | md | lg`, `--icon-size-sm | md`,
`--topbar-height`, `--panel-width-left | right | min`, `--statusbar-height`, and
the `--z-*` stacking scale (`canvas` → `tooltip`). Every z-index in the app comes
from that scale; no component invents one.

**Touch.** On a coarse pointer `base.css` grows buttons, selects, summaries and
inputs to `--tap-target-min`. On a mouse the dense heights stand — a trackpad
user is paying for that density. For a control that must stay visually small
(a 24px icon toggle, a checkbox), add `class="hit-area"`: a pseudo-element
expands the hit rectangle to 44 × 44 without changing layout.

---

## Theming mechanics

```
:root                                                  complete LIGHT palette
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { … }                OS dark, unless overridden
}
:root[data-theme="dark"] { … }                         explicit toggle wins
```

- The **complete** light palette is on bare `:root`. No colour has its only
  definition inside a media query or an attribute block.
- The two dark blocks have **identical bodies** and contain **no colour
  literals** — they only re-point semantic roles at different primitives. Edit
  one, edit the other.
- `:root[data-theme="light"]` needs no block: bare `:root` already is light, and
  the `:not([data-theme="light"])` guard stops the OS overriding an explicit
  choice in the other direction.
- Tokens that are deliberately theme-invariant (`--text-disabled`,
  `--border-default`, `--canvas-grid`) are defined once on `:root` and commented
  as such in both dark blocks, so their absence reads as intent rather than an
  omission.
- `color-scheme` is set alongside the palette, so native scrollbars, form
  controls and the canvas backdrop match the theme.

To toggle: set or remove `data-theme` on `<html>`.

```ts
document.documentElement.dataset.theme = 'dark';   // force dark
document.documentElement.dataset.theme = 'light';  // force light
delete document.documentElement.dataset.theme;     // follow the OS
```

**Dark is not inverted light.** Both themes share one neutral ramp but pick
different, independently measured rungs of it, and the accent flips from a deep
azure (dark ink on a light ground) to a light azure (light ink on a dark ground)
so it stays the most saturated thing on screen in both. Dark `--surface-0` is
not black: a true-black shell makes the canvas look like a hole and makes OLED
smearing visible while panning.

---

## Consuming tokens from the canvas

Canvas 2D cannot read CSS. Resolve the tokens once, cache them, and re-resolve
whenever the theme changes:

```ts
const read = () => {
  const s = getComputedStyle(document.documentElement);
  return {
    wall:  s.getPropertyValue('--canvas-wall').trim(),
    grid:  s.getPropertyValue('--canvas-grid').trim(),
    cell:  s.getPropertyValue('--canvas-cell').trim(),
    seam:  s.getPropertyValue('--canvas-seam').trim(),
    // …
  };
};
```

Three things to get right:

1. **Re-read on theme change.** Watch
   `matchMedia('(prefers-color-scheme: dark)')` *and* the `data-theme` attribute
   (`MutationObserver`), then redraw. A cached palette is the usual reason a
   canvas stays light after the user switches.
2. **Alpha tokens resolve to a CSS colour string**, e.g.
   `rgb(15 97 147 / 0.22)` — `ctx.fillStyle` and `ctx.strokeStyle` accept it
   directly. No parsing needed.
3. **Prefer the opaque tokens in the hot path.** `--canvas-cell-hover` is
   pre-composited (accent at 10% over the cell colour) so a hovered cell is one
   fill instead of two. If you change the accent or the cell colour, recompute
   `--blue-tint-light` / `--blue-tint-dark` in `tokens.css`.

---

## Accessibility — measured, not estimated

Targets: **4.5:1** for text (WCAG 2.1 AA, 1.4.3), **3:1** for UI component
boundaries and meaningful graphics (1.4.11). Ratios below are computed from the
sRGB relative-luminance formula, with alpha backgrounds composited over
`--surface-1` first.

"Worst surface" rows test each foreground against the lowest-contrast surface in
that theme — `--surface-0` in light (darkest ground for dark ink),
`--surface-3` in dark (lightest ground for light ink). If a foreground passes
there it passes everywhere.

`--text-disabled` is held to 3:1 rather than 4.5:1: WCAG 1.4.3 exempts inactive
controls. It is the only foreground below 4.5:1 anywhere in the system.
`--border-subtle` is not in the table because it is decorative by definition and
is never the sole boundary of a control; every border that *is* load-bearing is
`--border-default`, which is tested against every surface.

The last three rows in each block are non-normative separation checks (no WCAG
minimum applies to a fill-against-fill difference); they are listed so that the
canvas layering is a measured decision rather than a hope.

**98 pairs checked, 98 pass.**

| Theme | Pair | Values | Ratio | Min | |
|---|---|---|---|---|---|
| light | text-primary on surface-0 | `#14181B` on `#E5E8EB` | **14.52:1** | 4.5:1 | pass |
| light | text-primary on surface-1 | `#14181B` on `#F0F2F4` | **15.91:1** | 4.5:1 | pass |
| light | text-primary on surface-2 | `#14181B` on `#F7F8F9` | **16.79:1** | 4.5:1 | pass |
| light | text-primary on surface-3 | `#14181B` on `#FFFFFF` | **17.85:1** | 4.5:1 | pass |
| light | text-secondary on surface-0 (worst surface) | `#4B535B` on `#E5E8EB` | **6.35:1** | 4.5:1 | pass |
| light | text-secondary on surface-1 | `#4B535B` on `#F0F2F4` | **6.96:1** | 4.5:1 | pass |
| light | text-tertiary on surface-0 (worst surface) | `#606870` on `#E5E8EB` | **4.60:1** | 4.5:1 | pass |
| light | text-tertiary on surface-1 | `#606870` on `#F0F2F4` | **5.04:1** | 4.5:1 | pass |
| light | text-disabled on surface-0 (worst surface) | `#7C838A` on `#E5E8EB` | **3.12:1** | 3:1 | pass |
| light | border-default on surface-0 (worst surface) | `#7C838A` on `#E5E8EB` | **3.12:1** | 3:1 | pass |
| light | border-default on surface-1 | `#7C838A` on `#F0F2F4` | **3.42:1** | 3:1 | pass |
| light | border-strong on surface-0 (worst surface) | `#545C64` on `#E5E8EB` | **5.52:1** | 3:1 | pass |
| light | accent on surface-0 (worst surface) | `#0F6193` on `#E5E8EB` | **5.42:1** | 4.5:1 | pass |
| light | accent on surface-1 | `#0F6193` on `#F0F2F4` | **5.94:1** | 4.5:1 | pass |
| light | accent-on on accent (filled control) | `#FFFFFF` on `#0F6193` | **6.66:1** | 4.5:1 | pass |
| light | accent-on on accent-hover | `#FFFFFF` on `#0B4E78` | **8.84:1** | 4.5:1 | pass |
| light | accent-on on accent-active | `#FFFFFF` on `#083C5D` | **11.57:1** | 4.5:1 | pass |
| light | accent focus ring on surface-1 (non-text) | `#0F6193` on `#F0F2F4` | **5.94:1** | 3:1 | pass |
| light | accent on accent-bg (composited) | `#0F6193` on `#DAE4EA` | **5.16:1** | 4.5:1 | pass |
| light | text-primary on accent-bg (selected row) | `#14181B` on `#DAE4EA` | **13.83:1** | 4.5:1 | pass |
| light | danger-fg on surface-0 (worst surface) | `#B0241C` on `#E5E8EB` | **5.48:1** | 4.5:1 | pass |
| light | danger-fg on surface-1 | `#B0241C` on `#F0F2F4` | **6.01:1** | 4.5:1 | pass |
| light | danger-fg on danger-bg (composited) | `#B0241C` on `#EADDDE` | **5.10:1** | 4.5:1 | pass |
| light | text-primary on danger-bg (composited) | `#14181B` on `#EADDDE` | **13.51:1** | 4.5:1 | pass |
| light | warning-fg on surface-0 (worst surface) | `#8A5200` on `#E5E8EB` | **5.19:1** | 4.5:1 | pass |
| light | warning-fg on surface-1 | `#8A5200` on `#F0F2F4` | **5.69:1** | 4.5:1 | pass |
| light | warning-fg on warning-bg (composited) | `#8A5200` on `#E6E2DC` | **4.95:1** | 4.5:1 | pass |
| light | text-primary on warning-bg (composited) | `#14181B` on `#E6E2DC` | **13.84:1** | 4.5:1 | pass |
| light | success-fg on surface-0 (worst surface) | `#136B3A` on `#E5E8EB` | **5.35:1** | 4.5:1 | pass |
| light | success-fg on surface-1 | `#136B3A` on `#F0F2F4` | **5.86:1** | 4.5:1 | pass |
| light | success-fg on success-bg (composited) | `#136B3A` on `#DAE5E1` | **5.10:1** | 4.5:1 | pass |
| light | text-primary on success-bg (composited) | `#14181B` on `#DAE5E1` | **13.84:1** | 4.5:1 | pass |
| light | canvas-grid on canvas-cell | `#6E767E` on `#F0F2F4` | **4.11:1** | 3:1 | pass |
| light | canvas-grid on canvas-cell-hover | `#6E767E` on `#DAE4EA` | **3.57:1** | 3:1 | pass |
| light | canvas-grid on canvas-wall | `#6E767E` on `#D5D9DE` | **3.25:1** | 3:1 | pass |
| light | canvas-grid on canvas-panel-tint | `#6E767E` on `#E5E8EB` | **3.75:1** | 3:1 | pass |
| light | canvas-seam on canvas-cell | `#3F4652` on `#F0F2F4` | **8.47:1** | 3:1 | pass |
| light | canvas-seam on canvas-panel-tint | `#3F4652` on `#E5E8EB` | **7.73:1** | 3:1 | pass |
| light | canvas-selection on canvas-cell | `#0F6193` on `#F0F2F4` | **5.94:1** | 3:1 | pass |
| light | canvas-selection on canvas-wall | `#0F6193` on `#D5D9DE` | **4.70:1** | 3:1 | pass |
| light | canvas-selection on canvas-panel-tint | `#0F6193` on `#E5E8EB` | **5.42:1** | 3:1 | pass |
| light | canvas-ghost-valid on canvas-cell | `#0F6193` on `#F0F2F4` | **5.94:1** | 3:1 | pass |
| light | canvas-ghost-invalid on canvas-cell | `#B0241C` on `#F0F2F4` | **6.01:1** | 3:1 | pass |
| light | canvas-ghost-invalid on canvas-panel-tint | `#B0241C` on `#E5E8EB` | **5.48:1** | 3:1 | pass |
| light | canvas-cell vs canvas-wall (field separation) | `#F0F2F4` on `#D5D9DE` | **1.26:1** | 1.15:1 | pass |
| light | canvas-cell-hover vs canvas-cell (state change) | `#DAE4EA` on `#F0F2F4` | **1.15:1** | 1.05:1 | pass |
| light | canvas-panel-tint vs canvas-wall | `#E5E8EB` on `#D5D9DE` | **1.15:1** | 1.08:1 | pass |
| light | text-primary on canvas-cell (in-canvas label) | `#14181B` on `#F0F2F4` | **15.91:1** | 4.5:1 | pass |
| light | text-primary on canvas-wall (in-canvas label) | `#14181B` on `#D5D9DE` | **12.59:1** | 4.5:1 | pass |
| dark | text-primary on surface-0 | `#E5E8EB` on `#0D1013` | **15.51:1** | 4.5:1 | pass |
| dark | text-primary on surface-1 | `#E5E8EB` on `#14181B` | **14.52:1** | 4.5:1 | pass |
| dark | text-primary on surface-2 | `#E5E8EB` on `#1A1F23` | **13.51:1** | 4.5:1 | pass |
| dark | text-primary on surface-3 | `#E5E8EB` on `#21272C` | **12.27:1** | 4.5:1 | pass |
| dark | text-secondary on surface-3 (worst surface) | `#9CA4AC` on `#21272C` | **5.98:1** | 4.5:1 | pass |
| dark | text-secondary on surface-1 | `#9CA4AC` on `#14181B` | **7.07:1** | 4.5:1 | pass |
| dark | text-tertiary on surface-3 (worst surface) | `#8B939B` on `#21272C` | **4.85:1** | 4.5:1 | pass |
| dark | text-tertiary on surface-1 | `#8B939B` on `#14181B` | **5.73:1** | 4.5:1 | pass |
| dark | text-disabled on surface-3 (worst surface) | `#7C838A` on `#21272C` | **3.93:1** | 3:1 | pass |
| dark | border-default on surface-3 (worst surface) | `#7C838A` on `#21272C` | **3.93:1** | 3:1 | pass |
| dark | border-default on surface-1 | `#7C838A` on `#14181B` | **4.65:1** | 3:1 | pass |
| dark | border-strong on surface-3 (worst surface) | `#9CA4AC` on `#21272C` | **5.98:1** | 3:1 | pass |
| dark | accent on surface-3 (worst surface) | `#57AEE8` on `#21272C` | **6.20:1** | 4.5:1 | pass |
| dark | accent on surface-1 | `#57AEE8` on `#14181B` | **7.33:1** | 4.5:1 | pass |
| dark | accent-on on accent (filled control) | `#07131C` on `#57AEE8` | **7.71:1** | 4.5:1 | pass |
| dark | accent-on on accent-hover | `#07131C` on `#7FC3F0` | **9.80:1** | 4.5:1 | pass |
| dark | accent-on on accent-active | `#07131C` on `#A6D6F6` | **12.13:1** | 4.5:1 | pass |
| dark | accent focus ring on surface-1 (non-text) | `#57AEE8` on `#14181B` | **7.33:1** | 3:1 | pass |
| dark | accent on accent-bg (composited) | `#57AEE8` on `#1F303C` | **5.58:1** | 4.5:1 | pass |
| dark | text-primary on accent-bg (selected row) | `#E5E8EB` on `#1F303C` | **11.04:1** | 4.5:1 | pass |
| dark | danger-fg on surface-3 (worst surface) | `#F0867B` on `#21272C` | **6.04:1** | 4.5:1 | pass |
| dark | danger-fg on surface-1 | `#F0867B` on `#14181B` | **7.14:1** | 4.5:1 | pass |
| dark | danger-fg on danger-bg (composited) | `#F0867B` on `#372A2A` | **5.50:1** | 4.5:1 | pass |
| dark | text-primary on danger-bg (composited) | `#E5E8EB` on `#372A2A` | **11.18:1** | 4.5:1 | pass |
| dark | warning-fg on surface-3 (worst surface) | `#DFA748` on `#21272C` | **7.01:1** | 4.5:1 | pass |
| dark | warning-fg on surface-1 | `#DFA748` on `#14181B` | **8.30:1** | 4.5:1 | pass |
| dark | warning-fg on warning-bg (composited) | `#DFA748` on `#342F22` | **6.19:1** | 4.5:1 | pass |
| dark | text-primary on warning-bg (composited) | `#E5E8EB` on `#342F22` | **10.84:1** | 4.5:1 | pass |
| dark | success-fg on surface-3 (worst surface) | `#5FC98A` on `#21272C` | **7.34:1** | 4.5:1 | pass |
| dark | success-fg on surface-1 | `#5FC98A` on `#14181B` | **8.68:1** | 4.5:1 | pass |
| dark | success-fg on success-bg (composited) | `#5FC98A` on `#20342D` | **6.42:1** | 4.5:1 | pass |
| dark | text-primary on success-bg (composited) | `#E5E8EB` on `#20342D` | **10.73:1** | 4.5:1 | pass |
| dark | canvas-grid on canvas-cell | `#6E767E` on `#1A1F23` | **3.60:1** | 3:1 | pass |
| dark | canvas-grid on canvas-cell-hover | `#6E767E` on `#202D37` | **3.05:1** | 3:1 | pass |
| dark | canvas-grid on canvas-wall | `#6E767E` on `#0B0E10` | **4.20:1** | 3:1 | pass |
| dark | canvas-grid on canvas-panel-tint | `#6E767E` on `#21272C` | **3.27:1** | 3:1 | pass |
| dark | canvas-seam on canvas-cell | `#9CA4AC` on `#1A1F23` | **6.58:1** | 3:1 | pass |
| dark | canvas-seam on canvas-panel-tint | `#9CA4AC` on `#21272C` | **5.98:1** | 3:1 | pass |
| dark | canvas-selection on canvas-cell | `#57AEE8` on `#1A1F23` | **6.82:1** | 3:1 | pass |
| dark | canvas-selection on canvas-wall | `#57AEE8` on `#0B0E10` | **7.95:1** | 3:1 | pass |
| dark | canvas-selection on canvas-panel-tint | `#57AEE8` on `#21272C` | **6.20:1** | 3:1 | pass |
| dark | canvas-ghost-valid on canvas-cell | `#57AEE8` on `#1A1F23` | **6.82:1** | 3:1 | pass |
| dark | canvas-ghost-invalid on canvas-cell | `#F0867B` on `#1A1F23` | **6.65:1** | 3:1 | pass |
| dark | canvas-ghost-invalid on canvas-panel-tint | `#F0867B` on `#21272C` | **6.04:1** | 3:1 | pass |
| dark | canvas-cell vs canvas-wall (field separation) | `#1A1F23` on `#0B0E10` | **1.17:1** | 1.15:1 | pass |
| dark | canvas-cell-hover vs canvas-cell (state change) | `#202D37` on `#1A1F23` | **1.18:1** | 1.05:1 | pass |
| dark | canvas-panel-tint vs canvas-wall | `#21272C` on `#0B0E10` | **1.28:1** | 1.08:1 | pass |
| dark | text-primary on canvas-cell (in-canvas label) | `#E5E8EB` on `#1A1F23` | **13.51:1** | 4.5:1 | pass |
| dark | text-primary on canvas-wall (in-canvas label) | `#E5E8EB` on `#0B0E10` | **15.74:1** | 4.5:1 | pass |

### If you add a colour

Add it to a primitive ramp in `tokens.css`, map a semantic token to it, then
measure the pair before shipping. The check is the sRGB relative-luminance
formula from WCAG 2.1 §1.4.3 with alpha composited over its real background —
if a pair misses, change the colour, not the target.
