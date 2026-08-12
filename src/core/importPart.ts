/**
 * Turn a dropped STL into a catalogue part.
 *
 * This is the assembly step: `stl.ts` reads and measures the mesh, `detect.ts`
 * works out its cells, and this file writes the `CatalogPart` the rest of the
 * app already knows how to place, cost and print. The classification and
 * requirement rules are deliberately the same ones `tools/scan.py` applies, so
 * an imported insert behaves exactly like a scanned one in the BOM.
 *
 * Two things are different from a scanned part and both are visible rather than
 * hidden:
 *
 *   - the print estimate is modelled, not sliced, so it carries
 *     `print.source: 'volume'` and every surface that shows it says "est.";
 *   - anything geometry cannot answer is proposed, not asserted. The import
 *     dialog is where a human confirms the type, draws the real footprint and
 *     names the insert it bolts to — which is PARKED.md P1's "define footprint"
 *     mode, finally built.
 */

import { detect, type Detection } from './detect';
import { PITCH, ROW_STEP } from './constants';
import { estimatePrint, measureMesh, parseStl, type MeshMeasure } from './stl';
import type { Catalog, CatalogPart, Hex, PartType } from './types';

/** Panels get four wall mounts, plus one more per 50 cells (tools/scan.py). */
const WALL_MOUNTS_MIN = 4;
const CELLS_PER_EXTRA_MOUNT = 50;

/** Marks a part as user-imported wherever a `CatalogPart` travels. */
export const IMPORT_PREFIX = 'user/';

export interface ImportedPart extends CatalogPart {
  needsReview: boolean;
  projectionMm: number;
  /** Everything the detector saw, kept so the dialog can explain itself. */
  measurement: {
    tier: Detection['tier'];
    method: string;
    confidence: number;
    matingAxis: string;
    wallFaceAxis: string;
    triangles: number;
    areaMm2: number;
    overhangAreaMm2: number;
    overhangFraction: number;
    bores: Detection['bores'];
    /** Set on every part this module makes. Never true for a scanned part. */
    imported: true;
    importedAt: string;
  };
}

export interface ImportProposal {
  part: ImportedPart;
  detection: Detection;
  measure: MeshMeasure;
  /** Things the user should look at before accepting. Never fatal. */
  warnings: string[];
}

// ---------------------------------------------------------------------------

/** Cell set as a stable string, for comparing two footprints. */
const normalise = (cells: readonly Hex[]): string =>
  cells.map((c) => `${c.q},${c.r}`).sort().join(' ');

/** A stable, readable id from a file name. */
export function slugify(name: string): string {
  const stem = name.replace(/\.[^.]*$/, '');
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'part';
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const id = `${IMPORT_PREFIX}${base}`;
  if (!taken.has(id)) return id;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${id}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${id}-${taken.size}`;
}

/**
 * Type from the filename, as `tools/scan.py:classify` reads it.
 *
 * Only the evidence a browser actually has: there is no folder to read, so the
 * folder rules become filename rules and anything unrecognised says so instead
 * of guessing.
 */
export function typeFromName(name: string): PartType | 'unknown' {
  const stem = name.replace(/\.[^.]*$/, '').toLowerCase();
  if (/wall-?honeycomb/.test(stem) || /^\d+x\d+/.test(stem)) return 'panel';
  if (/countersunk|countersung|wall-?mount|wall-?screw/.test(stem)) return 'fastener';
  if (/^insert|-insert|insert-/.test(stem)) return 'insert';
  if (/hook|holder|shelf|shelve|rack|box|tray|bin|mount|cover/.test(stem)) return 'accessory';
  return 'unknown';
}

/** Reconcile what the geometry says with what the file is called. */
function classify(
  fileName: string,
  detection: Detection,
): { type: PartType; basis: 'geometry' | 'filename' | 'both' | 'conflict'; confidence: number; note?: string } {
  const geo = detection.geometryType;
  const named = typeFromName(fileName);

  if (named === 'unknown') {
    return {
      type: geo,
      basis: 'geometry',
      confidence: 0.7,
      note: 'the file name gives no type; classified from geometry alone',
    };
  }
  if (named === geo) return { type: geo, basis: 'both', confidence: 0.95 };

  // A wall-mount fastener IS geometrically an insert. The name is telling us
  // its purpose, which geometry cannot see — that is agreement, not conflict.
  const reconciled =
    (geo === 'insert' && named === 'fastener') || (geo === 'fastener' && named === 'insert');
  if (reconciled) {
    return {
      type: named,
      basis: 'both',
      confidence: 0.9,
      note: `geometry reads as "${geo}", the name says "${named}"; both are consistent — the name gives the purpose`,
    };
  }
  return {
    type: geo,
    basis: 'conflict',
    confidence: 0.45,
    note: `CONFLICT: geometry says "${geo}", the file name says "${named}". Showing the geometry result — neither is silently preferred.`,
  };
}

/**
 * Printed hardware this part needs, and bought hardware to go with it.
 *
 * The rule that has bitten this codebase twice: a fixing belongs to the part it
 * passes through, and nothing else may claim it. An accessory that requires an
 * insert does NOT also ask for that insert's bolt — the insert already does.
 */
function requirements(
  type: PartType,
  mounting: { cells: readonly Hex[]; tier: Detection['tier']; bores: Detection['bores'] },
  fileName: string,
  catalog: Catalog,
): { requires: CatalogPart['requires']; hardware: CatalogPart['hardware'] } {
  const ids = new Set(catalog.parts.map((p) => p.id));
  const requires: CatalogPart['requires'] = [];
  const hardware: CatalogPart['hardware'] = [];
  const cells = Math.max(1, mounting.cells.length);
  const stem = fileName.replace(/\.[^.]*$/, '').toLowerCase();

  if (type === 'panel') {
    const mounts = Math.max(
      WALL_MOUNTS_MIN,
      WALL_MOUNTS_MIN + Math.floor(cells / CELLS_PER_EXTRA_MOUNT),
    );
    if (ids.has('insert-countersunk')) {
      // No screws here on purpose: they belong to the countersunk insert, and
      // the BOM expands hardware through `requires`. Listing them twice is how
      // 350 inserts once asked for 700 wall screws.
      requires.push({ partId: 'insert-countersunk', count: mounts });
    } else {
      hardware.push({ item: 'Wall screw, 3.5 x 35 mm countersunk', count: mounts });
      hardware.push({ item: 'Wall plug, 6 mm', count: mounts });
    }
    return { requires, hardware };
  }

  if (type === 'insert' || type === 'fastener') {
    for (const tag of ['M5', 'M4', 'M3'] as const) {
      const n = mounting.bores[tag];
      if (n) {
        hardware.push({ item: `${tag} bolt, 10-16 mm`, count: n });
        hardware.push({ item: `${tag} nut`, count: n });
        break;
      }
    }
    if (/countersunk|countersung/.test(stem)) {
      hardware.push({ item: 'Wall screw, 3.5 x 35 mm countersunk', count: 1 });
      hardware.push({ item: 'Wall plug, 6 mm', count: 1 });
    }
    return { requires, hardware };
  }

  // A wall-clipping accessory carries its own interface and needs nothing.
  if (mounting.tier === 'wall-clip') return { requires, hardware };

  const insertFor: Record<'M3' | 'M4' | 'M5', string> = {
    M3: 'insert-with-m3',
    M4: 'insert-m4',
    M5: 'insert-m5',
  };
  for (const tag of ['M5', 'M4', 'M3'] as const) {
    const n = mounting.bores[tag];
    if (!n) continue;
    const pid = insertFor[tag];
    if (ids.has(pid)) requires.push({ partId: pid, count: n });
    else hardware.push({ item: `${tag} bolt, 10-16 mm`, count: n });
    return { requires, hardware };
  }

  // No bore resolved. The name is real evidence where geometry has none — a
  // blind counterbore is invisible in a projection — so it is used, and said.
  const named = (['m5', 'm4', 'm3'] as const).find((t) => stem.includes(t));
  if (named) {
    const tag = named.toUpperCase() as 'M3' | 'M4' | 'M5';
    const pid = insertFor[tag];
    if (ids.has(pid)) requires.push({ partId: pid, count: 1 });
    else hardware.push({ item: `${tag} bolt, 10-16 mm`, count: 1 });
  } else if (ids.has('insert-empty')) {
    requires.push({ partId: 'insert-empty', count: cells });
  }
  return { requires, hardware };
}

// ---------------------------------------------------------------------------

/**
 * Measure a dropped file and propose the part it describes.
 *
 * Throws only if the bytes are not an STL at all — everything else is reported
 * as a warning on a usable proposal, because a part the user can correct beats
 * a refusal they cannot.
 */
export function proposePart(
  fileName: string,
  buffer: ArrayBuffer,
  catalog: Catalog,
): ImportProposal {
  const mesh = parseStl(buffer);
  const measure = measureMesh(mesh);
  const detection = detect(mesh);
  const taken = new Set(catalog.parts.map((p) => p.id));
  const id = uniqueId(slugify(fileName), taken);

  const { type, basis, confidence, note } = classify(fileName, detection);
  const { requires, hardware } = requirements(type, detection, fileName, catalog);

  const print = estimatePrint({
    volumeMm3: measure.volumeMm3,
    areaMm2: measure.areaMm2,
    heightMm: measure.bboxMm[2],
    supports: measure.supports,
  });

  const warnings: string[] = [];
  if (detection.needsReview) {
    warnings.push(
      detection.tier === 'insert-fed'
        ? 'This part carries no wall interface, so its cells are a bound from the bounding box, not a measurement. Draw the real footprint below.'
        : 'The geometry did not resolve cleanly. Check the footprint below.',
    );
  }
  if (basis === 'conflict' && note) warnings.push(note);
  if (measure.volumeMm3 <= 0) warnings.push('The mesh encloses no volume — the print estimate will be wrong.');
  if (type === 'panel' && !detection.panel) {
    warnings.push(
      'The bores do not form a rectangular block, so this panel cannot be laid out by "Solve panels". You can still place it by hand.',
    );
  }

  const notes = [...detection.notes];
  if (note) notes.push(note);
  notes.push(
    `print estimate is modelled, not sliced (${print.grams.toFixed(1)} g, ` +
      `${Math.round(print.minutes)} min) — see the estimator note in src/core/stl.ts`,
  );

  const part: ImportedPart = {
    id,
    name: fileName.replace(/\.[^.]*$/, ''),
    file: fileName,
    type,
    group: 'Imported',
    footprint: detection.cells,
    anchor: detection.anchor,
    drawnOrientation: detection.drawnOrientation,
    bboxMm: measure.bboxMm,
    volumeMm3: measure.volumeMm3,
    requires,
    hardware,
    print: { ...print, profile: 'estimated/in-browser' },
    provenance: { basis, confidence, notes },
    sha256: '',
    needsReview: detection.needsReview,
    projectionMm: detection.projectionMm,
    measurement: {
      tier: detection.tier,
      method: detection.method,
      confidence: detection.confidence,
      matingAxis: detection.matingAxis,
      wallFaceAxis: detection.wallFaceAxis,
      triangles: measure.triangles,
      areaMm2: measure.areaMm2,
      overhangAreaMm2: measure.overhangAreaMm2,
      overhangFraction: measure.overhangFraction,
      bores: detection.bores,
      imported: true,
      importedAt: new Date().toISOString(),
    },
  };

  if (type === 'panel' && detection.panel) {
    part.panel = {
      columns: detection.panel.columns,
      rows: detection.panel.rows,
      widthMm: detection.panel.widthMm,
      heightMm: detection.panel.heightMm,
      fitsBeds: [],
    };
  }

  return { part, detection, measure, warnings };
}

/**
 * Which printer beds a panel fits on.
 *
 * Both orientations are tried because a plate can be turned on the bed; the
 * wall frame is unaffected, which is the whole reason `panel.columns/rows` and
 * `panel.widthMm/heightMm` are separate fields (see the note in CLAUDE.md).
 */
export function bedsThatFit(
  widthMm: number,
  heightMm: number,
  beds: readonly { id: string; width: number; depth: number }[],
): string[] {
  return beds
    .filter(
      (b) =>
        (widthMm <= b.width && heightMm <= b.depth) ||
        (heightMm <= b.width && widthMm <= b.depth),
    )
    .map((b) => b.id);
}

/**
 * Recompute the fields that depend on the footprint after a human edits it.
 *
 * The footprint is the one thing the dialog can change that everything else
 * hangs off — the wall-mount count, and whether the panel is still a block the
 * tiler can place — so it is recomputed here rather than left stale.
 */
export function withFootprint(
  part: ImportedPart,
  cells: readonly Hex[],
  catalog: Catalog,
): ImportedPart {
  const footprint = cells.length > 0 ? [...cells] : [{ q: 0, r: 0 }];

  // Accepting the proposed footprint is not the same as confirming it. Only an
  // actual edit clears the flag: otherwise pressing Add on a bounded part would
  // silently promote a bound to a measurement, which is the exact dishonesty
  // PARKED.md P1 exists to avoid.
  const edited =
    footprint.length !== part.footprint.length ||
    normalise(footprint) !== normalise(part.footprint);

  const next: ImportedPart = {
    ...part,
    footprint,
    anchor: { q: 0, r: 0 },
    needsReview: part.needsReview && !edited,
    provenance: {
      ...part.provenance,
      notes: edited
        ? [...part.provenance.notes, `footprint set by hand to ${footprint.length} cell(s)`]
        : part.provenance.notes,
    },
  };

  if (next.type === 'panel') {
    // A hand-drawn panel still has to be a rectangle for the tiler, and its bed
    // footprint has to follow the cells it now claims, or "Solve panels" would
    // place a plate that is not the size it prints.
    const rows = new Set(footprint.map((c) => c.r)).size;
    const columns = rows > 0 ? footprint.length / rows : 0;
    if (Number.isInteger(columns) && columns > 0) {
      next.panel = {
        columns,
        rows,
        widthMm: PITCH * (columns + 0.5),
        heightMm: (rows - 1) * ROW_STEP + 27.25093,
        fitsBeds: part.panel?.fitsBeds ?? [],
      };
    }
  }

  const { requires, hardware } = requirements(
    next.type,
    { cells: footprint, tier: part.measurement.tier, bores: part.measurement.bores },
    part.file,
    catalog,
  );
  next.requires = requires;
  next.hardware = hardware;
  return next;
}
