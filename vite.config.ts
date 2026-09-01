// defineConfig comes from vitest/config, not vite: the `test` key below is a
// vitest type augmentation and vite's own defineConfig rejects it.
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Ship `models/` with the build.
 *
 * The 3D view draws each placed part from its real mesh, and the parts list
 * links every line to its STL. In dev those come straight off the project root,
 * which Vite serves; a build has to carry them. They are not in `public/`
 * because the scanner, the catalogue and the docs all name them as `models/…`
 * relative to the repo root, and a second copy on disk is a second thing to
 * keep in step.
 *
 * 5.5 MB for all 51, fetched one part at a time and only when one is actually
 * placed.
 */
function copyModels(): Plugin {
  return {
    name: 'hsw-copy-models',
    apply: 'build',
    closeBundle() {
      const from = resolve(__dirname, 'models');
      if (!existsSync(from)) {
        this.warn('models/ not found — the built app will fall back to drawing boxes');
        return;
      }
      cpSync(from, resolve(__dirname, 'dist/models'), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), copyModels()],
  base: './',
  server: {
    /*
     * The port comes from the ENVIRONMENT when a launcher assigns one, and is
     * 5173 otherwise.
     *
     * Vite does not read `PORT` itself — it has its own default and steps
     * forward to the next free port when that is taken — so a launcher that
     * hands a port over and then watches it (an agent harness, a container,
     * a dev container's forwarded port) waits on a server that started
     * somewhere else. One line here is the whole fix, and a bare `npm run dev`
     * is unaffected.
     */
    port: Number(process.env.PORT) || 5173,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
