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

/**
 * Let the built app open straight from disk.
 *
 * Vite emits `<script type="module" crossorigin>` and a `crossorigin`
 * stylesheet. A page opened as `file://` has the origin `null`, and a browser
 * refuses both under CORS — so an unzipped download double-clicked showed an
 * empty page in the browser's own background, which is BLACK in dark mode,
 * with the reason only in the console. A classic script has no such rule. The
 * bundle is one chunk built as an IIFE (below), so nothing in it needs module
 * semantics; `defer` keeps the module tag's timing, so `#root` exists when it
 * runs. Served over http nothing changes.
 *
 * What a `file://` page still cannot do is `fetch` — the placed parts' meshes
 * fall back to their measured boxes there (`meshLibrary`). Everything else,
 * plates included, is generated in the page.
 */
function classicScripts(): Plugin {
  return {
    name: 'hsw-classic-scripts',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html
          .replace(/<script type="module" crossorigin src=/g, '<script defer src=')
          .replace(/<link rel="stylesheet" crossorigin href=/g, '<link rel="stylesheet" href='),
    },
  };
}

export default defineConfig({
  plugins: [react(), copyModels(), classicScripts()],
  base: './',
  build: {
    // One chunk, no module syntax: see `classicScripts`. There is no dynamic
    // import in the app, so `inlineDynamicImports` changes nothing but stops a
    // future one from silently splitting a bundle an IIFE cannot load.
    modulePreload: false,
    rollupOptions: {
      output: { format: 'iife', inlineDynamicImports: true },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
