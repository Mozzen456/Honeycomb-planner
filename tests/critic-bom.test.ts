/**
 * EXPLORATION SCRATCH — will be replaced by the real critic test.
 */
import { describe, expect, it } from 'vitest';
import catalogJson from '../src/catalog/catalog.json';
import { solveTiling, type PanelSize } from '../src/core/tiling';
import type { Catalog } from '../src/core/types';

const catalog = catalogJson as unknown as Catalog;

describe('explore', () => {
  it('tiles 2400x1200 on bed256', () => {
    const available: PanelSize[] = catalog.parts
      .filter((p) => p.type === 'panel' && p.panel)
      .map((p) => ({
        partId: p.id,
        columns: p.panel!.columns,
        rows: p.panel!.rows,
        widthMm: p.panel!.widthMm,
        heightMm: p.panel!.heightMm,
      }));
    const res = solveTiling({
      wall: { widthMm: 2400, heightMm: 1200 },
      bedId: 'bed256',
      available,
      allowRotation: true,
    });
    const counts = new Map<string, number>();
    for (const p of res.panels) counts.set(p.partId, (counts.get(p.partId) ?? 0) + 1);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      panels: res.panels.length,
      cellCount: res.cellCount,
      counts: [...counts],
      warnings: res.warnings,
      seams: res.seams.length,
      unused: res.unusedMm,
      first: res.panels.slice(0, 12),
    }, null, 1));
    expect(res.panels.length).toBeGreaterThan(0);
  });
});
