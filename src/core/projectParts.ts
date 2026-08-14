/**
 * The parts this project has been shopped for.
 *
 * The catalogue is a shop: 51 shipped models plus whatever the user imported,
 * and a wall uses six of them. The rail used to show all of it, which made
 * "which parts is this wall built from" a question you answered by scrolling.
 * So a layout now carries a LIST of the parts chosen for it, and the rail shows
 * that list; the library is where you go to add to it (D71).
 *
 * Three rules, and they are the whole module:
 *
 *   1. **A placed part is in the project, list or no list.** Otherwise a layout
 *      saved before this existed — or one whose list was edited by hand —
 *      opens with parts on the wall and an empty rail, and the only way to get
 *      the part back is to find it in the library again. `projectPartIds`
 *      therefore unions the stored list with what is actually placed, and
 *      nothing else in the app derives the rail's contents.
 *   2. **A part in the list need not exist.** Load a friend's layout and it
 *      names imports you have never seen. Those ids are KEPT — dropping them
 *      would quietly rewrite the document on the way through — and reported
 *      separately, so the rail can say so instead of silently coming up short.
 *   3. **Order is the order they were added**, so the rail does not reshuffle
 *      itself when a part is removed and re-added.
 */

import type { Catalog, CatalogPart, LayoutDoc } from './types';
import { isImported } from './userCatalog';

/**
 * Ceiling on the list. The whole shipped catalogue is 51 parts and the point of
 * the list is to be shorter than that, so this is a bound on hostile input
 * rather than a limit anyone will meet.
 */
export const MAX_PROJECT_PARTS = 500;

/**
 * Can this part be CHOSEN from the catalogue?
 *
 * Everything but a plate. The app sizes and generates every plate it draws
 * (D97), so the seven shipped panel entries are not things anyone picks: the
 * tiler decides which plates a wall needs from the wall size and the printer,
 * and what you print is the file the app writes, not the file in `models/`.
 * They stay IN the catalogue — the solver reads their sizes when "Fit to
 * printer" is off, the parts list costs a generated plate against the biggest
 * of them, and `PartInspector` sizes its wall patch from the smallest — so this
 * is the one place that says they are not on sale.
 *
 * The rail has always applied it (a plate is not something you drag off a
 * shelf); the library now applies the same rule rather than its own.
 *
 * **A plate you IMPORTED is still yours.** `typeFromName` calls anything named
 * `wall-honeycomb…` or `220x220…` a panel, and the import dialog tells you a
 * plate the tiler cannot lay out can still be placed by hand — so hiding it
 * would take somebody's own upload off the shelves, and "My uploads" in the
 * library is the only place it can be looked at or deleted. The rule is about
 * the SHIPPED plates the app now generates for itself, not about the type.
 */
export const isShoppable = (part: CatalogPart): boolean =>
  part.type !== 'panel' || isImported(part);

/** The catalogue as a SHOP: everything a person can actually choose. */
export const shoppableParts = (catalog: Catalog): CatalogPart[] =>
  (catalog.parts ?? []).filter(isShoppable);

/**
 * Every part id this project uses: the ones chosen, plus the ones placed.
 *
 * Placed-but-unlisted comes up in three ordinary ways — an old layout, a shared
 * link, an undo past the point the part was added — and in every one of them
 * the honest answer is that the wall uses the part.
 */
export function projectPartIds(doc: LayoutDoc): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of doc.library ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const item of doc.items) {
    if (seen.has(item.partId)) continue;
    seen.add(item.partId);
    out.push(item.partId);
  }
  return out;
}

/** Is this part in the project — either chosen or already on the wall? */
export function inProject(doc: LayoutDoc, partId: string): boolean {
  if ((doc.library ?? []).includes(partId)) return true;
  return doc.items.some((i) => i.partId === partId);
}

export interface ProjectParts {
  /** In list order, then placement order. Only parts the catalogue can resolve. */
  parts: CatalogPart[];
  /** Ids in the list that this catalogue has no part for. Never dropped silently. */
  missing: string[];
}

/**
 * The project's parts as real catalogue entries.
 *
 * Plates are excluded by `isShoppable`: the tiler chooses those from the wall
 * size and the printer, and a plate is not something you drag off a shelf.
 * Putting them in the rail would mean "Solve panels" silently filling the basket
 * with plates nobody picked.
 */
export function resolveProjectParts(doc: LayoutDoc, catalog: Catalog): ProjectParts {
  const index = new Map(catalog.parts.map((p) => [p.id, p]));
  const parts: CatalogPart[] = [];
  const missing: string[] = [];
  for (const id of projectPartIds(doc)) {
    const part = index.get(id);
    if (part === undefined) missing.push(id);
    else if (isShoppable(part)) parts.push(part);
  }
  return { parts, missing };
}

// ---------------------------------------------------------------------------
// Edits. Pure: each returns a new document, or the SAME one when nothing
// changed — which is what lets a caller skip an undo step it would regret.
// ---------------------------------------------------------------------------

/** Add a part to the project. Idempotent, and a no-op once the list is full. */
export function withPartAdded(doc: LayoutDoc, partId: string): LayoutDoc {
  if (partId.length === 0) return doc;
  const library = doc.library ?? [];
  if (library.includes(partId)) return doc;
  if (library.length >= MAX_PROJECT_PARTS) return doc;
  return { ...doc, library: [...library, partId] };
}

/** Several at once, so adding a whole group is one undo step. */
export function withPartsAdded(doc: LayoutDoc, partIds: readonly string[]): LayoutDoc {
  let next = doc;
  for (const id of partIds) next = withPartAdded(next, id);
  return next;
}

/**
 * Take a part back out.
 *
 * A part still on the wall cannot be removed — `projectPartIds` would put it
 * straight back, so the rail would ignore the click and look broken. The caller
 * checks and says why; this function just refuses to pretend.
 */
export function withPartRemoved(doc: LayoutDoc, partId: string): LayoutDoc {
  const library = doc.library ?? [];
  if (!library.includes(partId)) return doc;
  const next = library.filter((id) => id !== partId);
  if (next.length === 0) {
    // An absent key must round-trip to an absent key: a layout that never had a
    // list must not start differing from its own reload because someone added a
    // part and took it away again.
    const { library: _dropped, ...rest } = doc;
    return rest;
  }
  return { ...doc, library: next };
}

/** How many placements would be orphaned by removing this part. */
export const placementsOf = (doc: LayoutDoc, partId: string): number =>
  doc.items.filter((i) => i.partId === partId).length;
