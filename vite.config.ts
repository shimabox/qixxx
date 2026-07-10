import { defineConfig, type Plugin } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));

// Cloudflare Pages needs the redirect rule file at the *build output root*
// (docs/plan-cloudflare-x-share.md Phase 3: `/` -> `/qixxx/`, since
// wrangler.toml's `pages_build_output_dir = "dist"` is one level above this
// config's `build.outDir` of `dist/qixxx`). Vite's own `public/` dir copies
// into `build.outDir` — one level too deep here — so a plain `public/_redirects`
// wouldn't land in the right place. A `writeBundle`-hook plugin (rather than
// a `cp` step appended to package.json's `build` script) keeps this
// cross-platform (no shell-specific `cp`/`copy` command) and colocated with
// the one setting (`outDir`) it depends on, instead of syncing the same path
// in two separate places.
function cloudflareRedirectsPlugin(): Plugin {
  return {
    name: 'cloudflare-redirects',
    apply: 'build',
    writeBundle() {
      const outputRoot = resolve(rootDir, 'dist');
      mkdirSync(outputRoot, { recursive: true });
      writeFileSync(resolve(outputRoot, '_redirects'), '/ /qixxx/ 302\n');
    },
  };
}

export default defineConfig({
  base: '/qixxx/',
  build: {
    // Cloudflare Pages serves the app from `/qixxx/` (docs/plan-cloudflare-x-share.md
    // Phase 3) by having the *project* serve from the domain root while the
    // build output itself lives one level down; `pages_build_output_dir`
    // (wrangler.toml) stays "dist" so `_redirects` (written by the plugin
    // above) and the Pages Functions in `functions/` sit alongside it.
    outDir: 'dist/qixxx',
  },
  plugins: [cloudflareRedirectsPlugin()],
  server: {
    port: 5173,
  },
});
