import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type UserConfig } from 'vite';

// The admin SPA build (spec §4.3, §4.8; Task 27). The release build (tools/release) runs `vite build` with
// ALTIS_BUILD=<version> and ALTIS_BUILD_PROFILE=<profile>, then copies dist/ to bundled-release/<v>/public/admin/:
//
// - base /admin/: the server serves index.html at /admin(/*) and the hashed files at /admin/assets/<name>, where a
//   name must match ADMIN_ASSET_NAME of @altis/platform (`[name]-[hash].[ext]`; the release build checks every one).
// - No source map ever ships (spec §4.3), and the bundle is minified: `permissionCatalog`'s test entry and the test
//   messages of @altis/shared are dead code in a production build only once the minifier folds `__BUILD_PROFILE__`
//   (the release's leak scan fails otherwise).
// - index.html carries `<meta name="csp-nonce" content="__CSP_NONCE__">`; the server puts the request's nonce there
//   and in its Content-Security-Policy (D31). Vite adds no inline script or style to it.
//   Its one inline script of its own, the colour theme applied before the first paint (src/lib/theme.ts), carries that
//   placeholder as its nonce.
// - A second entry, install.html (1c Task 30): the web install wizard (src/install/main.tsx), with the same placeholder,
//   which the server serves at /install (release kind `install-index`). Both pages load their hashed files from
//   /admin/assets, so the base stays /admin/ for both.
// - The `altis-inputs` plugin writes what the bundle is made of to .build/inputs.json (outside dist, never shipped):
//   the module ids of every chunk, plus the packages our stylesheets `@import` (`tailwindcss`, `tw-animate-css`), whose
//   rules Tailwind copies into the CSS output, and the packages a `url()` of our stylesheets points into (the font
//   package of src/fonts.css, whose files become assets). The release build maps them to packages for the licence check
//   and the notices.

const ADMIN_DIR = import.meta.dirname;
const SRC_DIR = path.join(ADMIN_DIR, 'src');
const REPO_ROOT = path.resolve(ADMIN_DIR, '..', '..');
const INPUTS_FILE = path.join(ADMIN_DIR, '.build', 'inputs.json');

const PROFILES = ['test', 'production'] as const;
type Profile = (typeof PROFILES)[number];

/** ALTIS_BUILD_PROFILE: `production` unless the release build says `test` (a build never keeps test bits by default). */
function buildProfile(value: string | undefined): Profile {
  if (value === undefined || value === '') return 'production';
  if ((PROFILES as readonly string[]).includes(value)) return value as Profile;
  throw new Error(`ALTIS_BUILD_PROFILE must be test or production, not ${JSON.stringify(value)}`);
}

/**
 * The package a virtual module of the bundler stands for: its code is copied into the bundle, so its licence counts
 * (`\0vite/preload-helper.js`, `\0rolldown/runtime.js`, ...). Returned as a file inside that package.
 */
function virtualModuleOwner(id: string): string | undefined {
  const require = createRequire(import.meta.url);
  const vite = path.dirname(require.resolve('vite/package.json'));
  if (id.startsWith('\0vite/')) return path.join(vite, 'package.json');
  if (id.startsWith('\0rolldown/') || id.startsWith('rolldown:')) {
    return createRequire(path.join(vite, 'package.json')).resolve('rolldown/package.json');
  }
  return undefined;
}

/** The package name of a bare specifier (`tailwindcss`, `@scope/name/sub` → `@scope/name`), or undefined. */
function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || /^[a-z]+:/i.test(specifier)) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** package.json of the package `name` as Node would find it from `file` (node_modules folders upwards), real path. */
function findPackage(name: string, file: string): string | undefined {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(manifest)) return fs.realpathSync(manifest);
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * The packages a stylesheet of ours takes something from by name: the ones it `@import`s, and the ones a `url()` of it
 * points into (a font file of a font package, which the build copies to the assets).
 */
function cssImports(file: string): string[] {
  const css = fs.readFileSync(file, 'utf8');
  const found: string[] = [];
  const specifiers = [
    ...[...css.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g)].map((match) => match[1]!),
    ...[...css.matchAll(/url\(\s*(?:'([^']+)'|"([^"]+)"|([^'")\s]+))\s*\)/g)].map((match) => (match[1] ?? match[2] ?? match[3])!),
  ];
  for (const specifier of specifiers) {
    const name = packageName(specifier);
    const manifest = name === undefined ? undefined : findPackage(name, file);
    if (manifest !== undefined) found.push(manifest);
  }
  return found;
}

/** POSIX path relative to the repository root (the form tools/release reads), without a query. */
function repoRelative(file: string): string {
  return path.relative(REPO_ROOT, file.replace(/[?#].*$/, '')).split(path.sep).join('/');
}

function altisInputs(): Plugin {
  return {
    name: 'altis-inputs',
    apply: 'build',
    generateBundle(_options, bundle) {
      const inputs = new Set<string>();
      const add = (id: string): void => {
        const owner = id.startsWith('\0') || id.startsWith('rolldown:') ? virtualModuleOwner(id) : id;
        if (owner !== undefined && path.isAbsolute(owner.replace(/[?#].*$/, ''))) inputs.add(repoRelative(owner));
      };
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') for (const id of Object.keys(output.modules)) add(id);
      }
      for (const id of this.getModuleIds()) {
        const file = id.replace(/[?#].*$/, '');
        if (file.endsWith('.css') && file.startsWith(SRC_DIR + path.sep)) cssImports(file).forEach(add);
      }
      fs.mkdirSync(path.dirname(INPUTS_FILE), { recursive: true });
      fs.writeFileSync(INPUTS_FILE, `${JSON.stringify([...inputs].sort(), null, 2)}\n`);
    },
  };
}

export default defineConfig((): UserConfig => {
  const profile = buildProfile(process.env['ALTIS_BUILD_PROFILE']);
  const build = process.env['ALTIS_BUILD'] || 'dev';
  return {
    base: '/admin/',
    root: ADMIN_DIR,
    publicDir: false,
    plugins: [react(), tailwindcss(), altisInputs()],
    resolve: { alias: { '@': SRC_DIR } },
    define: {
      __ALTIS_BUILD__: JSON.stringify(build),
      __BUILD_PROFILE__: JSON.stringify(profile),
    },
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      emptyOutDir: true,
      sourcemap: false,
      minify: true,
      cssMinify: true,
      // No inline asset: every file the page loads comes from /admin/assets (style-src/img-src 'self').
      assetsInlineLimit: 0,
      reportCompressedSize: false,
      rolldownOptions: {
        // Two pages (1c Task 30): the admin SPA and the install wizard, which the server serves at /install. They share
        // their common chunks (React, the UI primitives, the stylesheet) under /admin/assets.
        input: { index: path.join(ADMIN_DIR, 'index.html'), install: path.join(ADMIN_DIR, 'install.html') },
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]',
        },
      },
    },
  };
});
