// defineConfig comes from vitest/config, not vite: the `test` key below is a
// vitest type augmentation and vite's own defineConfig rejects it.
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

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

/** Every file under `dir`, as paths relative to the repo root with `/`. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [relative(__dirname, path).split('\\').join('/')];
  });
}

/**
 * The single-file build: `npm run build:standalone` (D122).
 *
 * One HTML file holding the bundle, its pictures and every shipped mesh, so
 * it works double-clicked from anywhere — including straight out of a zip,
 * where a viewer extracts only the file that was opened and a page that
 * needs `assets/` beside it starts with nothing. The meshes go in gzipped,
 * as `window.__HSW_MODELS__`, which `meshLibrary` reads before it tries to
 * fetch. The script is moved to the end of `<body>`: inline, it runs as soon
 * as it is parsed, and in `<head>` there is no `#root` yet.
 */
function standalone(): Plugin {
  return {
    name: 'hsw-standalone',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler: (html, ctx) => {
        const bundle = ctx.bundle;
        if (!bundle) return html;
        let scripts = '';
        for (const [name, output] of Object.entries(bundle)) {
          if (output.type !== 'chunk') continue;
          const tag = new RegExp(`<script[^>]*src="\\./${name}"[^>]*></script>\\s*`);
          if (!tag.test(html)) continue;
          html = html.replace(tag, '');
          scripts += `<script>${output.code.replace(/<\/script/gi, '<\\/script')}</script>\n`;
          delete bundle[name];
        }
        const models: Record<string, string> = {};
        for (const file of filesUnder(resolve(__dirname, 'models'))) {
          if (!/\.stl$/i.test(file)) continue;
          models[file] = gzipSync(readFileSync(resolve(__dirname, file)), { level: 9 }).toString('base64');
        }
        const favicon = readFileSync(resolve(__dirname, 'public/favicon.svg')).toString('base64');
        return html
          .replace('href="./favicon.svg"', `href="data:image/svg+xml;base64,${favicon}"`)
          // A function, not a string: a replacement string reads `$&` and
          // `$'` in the minified bundle as patterns.
          .replace(
            '</body>',
            () => `<script>window.__HSW_MODELS__=${JSON.stringify(models)};</script>\n${scripts}</body>`,
          );
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    ...(mode === 'standalone' ? [classicScripts(), standalone()] : [copyModels(), classicScripts()]),
  ],
  base: './',
  // The single file carries nothing beside it: no public/ copy, every
  // picture inlined.
  publicDir: mode === 'standalone' ? false : 'public',
  build: {
    // One chunk, no module syntax: see `classicScripts`. There is no dynamic
    // import in the app, so `inlineDynamicImports` changes nothing but stops a
    // future one from silently splitting a bundle an IIFE cannot load.
    modulePreload: false,
    ...(mode === 'standalone' ? { outDir: 'dist-standalone', assetsInlineLimit: Number.MAX_SAFE_INTEGER } : {}),
    rollupOptions: {
      output: { format: 'iife', inlineDynamicImports: true },
    },
  },
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
}));
