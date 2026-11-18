import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LICENSE_ALLOWANCES,
  LICENSE_ALLOWLIST,
  checkLicenses,
  checkNativeInputs,
  checkNoLeaks,
  checkRuntimeImports,
  licenseAllowed,
  packagesOfInputs,
  scanRuntimeImports,
  type BundledPackage,
} from '../src/checks.js';

// The release guards (Task 17 rulings): licence allowlist over the packages in the bundles (esbuild metafile inputs),
// no native module, a self-contained bundle (node built-ins only at run time), no test hook or dev key in production.

let root: string;

beforeAll(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-checks-')));
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

/** Writes `<root>/<dir>/package.json` (and an index.js) and returns the index.js path relative to root. */
async function fakePackage(dir: string, manifest: Record<string, unknown>): Promise<string> {
  await fsp.mkdir(path.join(root, dir), { recursive: true });
  await fsp.writeFile(path.join(root, dir, 'package.json'), JSON.stringify(manifest));
  await fsp.writeFile(path.join(root, dir, 'index.js'), 'module.exports = 1;\n');
  return `${dir}/index.js`;
}

const pkg = (name: string, license: string | undefined): BundledPackage => ({ name, version: '1.0.0', license, dir: `/x/${name}` });

describe('licenseAllowed (SPDX expressions)', () => {
  it('the allowlist is exactly the ruling', () => {
    expect([...LICENSE_ALLOWLIST].sort()).toEqual(
      ['0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BlueOak-1.0.0', 'CC0-1.0', 'ISC', 'MIT', 'MIT-0', 'Unlicense'].sort(),
    );
  });

  it.each([
    ['MIT', true],
    ['MIT-0', true], // nodemailer (decision D17): MIT without the notice condition
    ['MIT-0 OR GPL-3.0', true],
    ['MIT-1', false],
    ['ISC', true],
    ['Apache-2.0', true],
    ['(MIT)', true],
    ['MIT OR GPL-3.0', true],
    ['GPL-3.0 OR MIT', true],
    ['(MIT OR Apache-2.0) AND BSD-3-Clause', true],
    ['MIT AND ISC', true],
    ['MIT AND GPL-3.0', false],
    ['(MIT OR GPL-2.0) AND LGPL-3.0', false],
    ['GPL-3.0', false],
    ['GPL-3.0-or-later', false],
    ['AGPL-3.0-only', false],
    ['LGPL-2.1', false],
    ['SSPL-1.0', false],
    ['Apache-2.0 WITH LLVM-exception', false],
    ['SEE LICENSE IN LICENSE.md', false],
    ['UNLICENSED', false],
    ['mit', false],
    ['MIT OR', false],
    ['(MIT', false],
    ['', false],
  ])('%s → %s', (expression, allowed) => {
    expect(licenseAllowed(expression)).toBe(allowed);
  });

  it('a missing licence is not allowed', () => {
    expect(licenseAllowed(undefined)).toBe(false);
  });
});

describe('packagesOfInputs', () => {
  it('maps bundle inputs to the package that holds them (pnpm layout, scoped names), skipping our own sources', async () => {
    const a = await fakePackage('node_modules/.pnpm/left@1.2.3/node_modules/left', { name: 'left', version: '1.2.3', license: 'MIT' });
    const b = await fakePackage('node_modules/.pnpm/@sc+right@2.0.0/node_modules/@sc/right', {
      name: '@sc/right',
      version: '2.0.0',
      license: 'ISC',
    });
    await fsp.mkdir(path.join(root, 'node_modules/.pnpm/left@1.2.3/node_modules/left/lib'), { recursive: true });
    const inputs = [a, b, 'node_modules/.pnpm/left@1.2.3/node_modules/left/lib/x.js', 'packages/crypto/src/jcs.ts', '<define:__TRUSTED_KEYS__>'];
    const packages = await packagesOfInputs(inputs, root);
    expect(packages.map((p) => [p.name, p.version, p.license])).toEqual([
      ['@sc/right', '2.0.0', 'ISC'],
      ['left', '1.2.3', 'MIT'],
    ]);
    expect(packages[1]!.dir).toBe(path.join(root, 'node_modules/.pnpm/left@1.2.3/node_modules/left'));
  });

  it('reads the old `licenses: [{type}]` form as an OR of its entries', async () => {
    const input = await fakePackage('node_modules/old', { name: 'old', version: '0.1.0', licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] });
    const [old] = await packagesOfInputs([input], root);
    expect(old!.license).toBe('MIT OR Apache-2.0');
  });
});

describe('checkLicenses', () => {
  it('passes allowed packages', () => {
    expect(() => checkLicenses([pkg('a', 'MIT'), pkg('b', 'BSD-2-Clause OR GPL-2.0')])).not.toThrow();
  });

  it('fails LICENSE_NOT_ALLOWED:<pkg> for GPL, a missing licence or an unknown one', () => {
    expect(() => checkLicenses([pkg('a', 'MIT'), pkg('evil-gpl', 'GPL-3.0')])).toThrow(/^LICENSE_NOT_ALLOWED:evil-gpl\b/);
    expect(() => checkLicenses([pkg('nolicense', undefined)])).toThrow(/^LICENSE_NOT_ALLOWED:nolicense\b/);
    expect(() => checkLicenses([pkg('odd', 'WTFPL')])).toThrow(/^LICENSE_NOT_ALLOWED:odd\b/);
  });

  it('LICENSE_ALLOWANCES: the UI typeface under the OFL, by exact name, version and licence; the OFL is not allowed otherwise', () => {
    expect(LICENSE_ALLOWANCES).toEqual([{ name: '@fontsource-variable/plus-jakarta-sans', version: '5.3.0', license: 'OFL-1.1' }]);
    expect(LICENSE_ALLOWLIST).not.toContain('OFL-1.1');
    expect(licenseAllowed('OFL-1.1')).toBe(false);
    const font: BundledPackage = { name: '@fontsource-variable/plus-jakarta-sans', version: '5.3.0', license: 'OFL-1.1', dir: '/x/font' };
    expect(() => checkLicenses([pkg('a', 'MIT'), font])).not.toThrow();
    // Another version, another package under the same licence, the same package under another licence: refused.
    expect(() => checkLicenses([{ ...font, version: '5.3.1' }])).toThrow(/^LICENSE_NOT_ALLOWED:@fontsource-variable\/plus-jakarta-sans \(5\.3\.1, "OFL-1\.1"\)/);
    expect(() => checkLicenses([{ ...font, name: '@fontsource-variable/inter' }])).toThrow(/^LICENSE_NOT_ALLOWED:@fontsource-variable\/inter\b/);
    expect(() => checkLicenses([{ ...font, license: 'GPL-3.0' }])).toThrow(/^LICENSE_NOT_ALLOWED:/);
    expect(() => checkLicenses([font], [])).toThrow(/^LICENSE_NOT_ALLOWED:/);
    // An allowance never hides another offender.
    expect(() => checkLicenses([font, pkg('evil-gpl', 'GPL-3.0')])).toThrow(/^LICENSE_NOT_ALLOWED:evil-gpl\b/);
  });

  it('names every offending package', () => {
    expect(() => checkLicenses([pkg('z-agpl', 'AGPL-3.0'), pkg('a-gpl', 'GPL-2.0')])).toThrow(/^LICENSE_NOT_ALLOWED:a-gpl\b.*z-agpl/);
  });
});

describe('checkNativeInputs', () => {
  it('fails NATIVE_MODULE:<path> for a .node file among the inputs', () => {
    expect(() => checkNativeInputs(['node_modules/x/index.js', 'packages/db/src/connect.ts'])).not.toThrow();
    expect(() => checkNativeInputs(['node_modules/x/index.js', 'node_modules/x/build/Release/x.node'])).toThrow(
      /^NATIVE_MODULE:node_modules\/x\/build\/Release\/x\.node$/,
    );
  });
});

describe('checkRuntimeImports', () => {
  it('accepts node built-ins only', () => {
    expect(() => checkRuntimeImports(['fs', 'node:fs/promises', 'util/types', 'node:sqlite', 'node:module'])).not.toThrow();
  });

  it.each(['pg-native', 'cardinal', './chunk.mjs', '../x.js', '/abs/x.js', 'node:nope'])('fails BUNDLE_NOT_SELF_CONTAINED for %s', (spec) => {
    expect(() => checkRuntimeImports(['fs', spec])).toThrow(new RegExp(`^BUNDLE_NOT_SELF_CONTAINED:${spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  });
});

describe('scanRuntimeImports (acorn: what a bundle loads at run time)', () => {
  it('lists every import(), static import and require() specifier in source order, and the foreign one fails the existing check', () => {
    const code = "const a = import('x');\nconst b = require('x');\nconst c = require('node:fs');\n";
    const found = scanRuntimeImports(code);
    expect(found).toEqual(['x', 'x', 'node:fs']);
    expect(() => checkRuntimeImports(found)).toThrow(/^BUNDLE_NOT_SELF_CONTAINED:x\b/);
  });

  it('reads static imports and re-exports, in source order across kinds', () => {
    const code = [
      "import fs from 'node:fs';",
      "import { a } from './local.js';",
      "export * from 'pkg-all';",
      "export { b } from 'pkg-named';",
      "export const c = () => import('node:path');",
      '',
    ].join('\n');
    expect(scanRuntimeImports(code)).toEqual(['node:fs', './local.js', 'pkg-all', 'pkg-named', 'node:path']);
  });

  it('reads a CommonJS script (top-level return, hashbang) and a module alike', () => {
    expect(scanRuntimeImports("#!/usr/bin/env node\n'use strict';\nvar p = require('path');\nif (!p) return;\n")).toEqual(['path']);
    expect(scanRuntimeImports("import.meta.url; await import('node:os');")).toEqual(['node:os']);
  });

  it('follows esbuild\'s require shim, the variable whose initialiser throws "Dynamic require of"', () => {
    const shim =
      'var __require = (x => typeof require !== "undefined" ? require : x)(function (x) { throw Error(\'Dynamic require of "\' + x + \'" is not supported\'); });';
    expect(scanRuntimeImports(`${shim}\nvar n = __require("cardinal"); var o = __require('node:net');`)).toEqual(['cardinal', 'node:net']);
  });

  it('counts constant template literals, and ignores what is not a load of a constant specifier', () => {
    const code = [
      'import(`tpl`);',
      'require(`tpl2`);',
      'import(name);', // not a constant: nothing to name
      'require(dir + "/x");',
      "obj.require('not-a-load');", // a method called require is not the loader
      "const s = \"require('in-a-string')\"; // require('in-a-comment')",
      "require.resolve('resolved-not-loaded');",
      'require();',
    ].join('\n');
    expect(scanRuntimeImports(code)).toEqual(['tpl', 'tpl2']);
  });

  it('walks a deep expression (a minified bundle chains thousands of operands)', () => {
    const code = `var s = ${Array.from({ length: 3000 }, (_, i) => `"p${i}"`).join(' + ')}; require('deep');`;
    expect(scanRuntimeImports(code)).toEqual(['deep']);
  });

  it('throws on code that does not parse in either mode', () => {
    expect(() => scanRuntimeImports('var = ;')).toThrow(SyntaxError);
  });
});

describe('checkNoLeaks', () => {
  it('fails PRODUCTION_BUILD_LEAK:<file> when a text holds a needle', () => {
    const files = [
      { path: 'app.js', text: 'var a=1;' },
      { path: 'server.mjs', text: 'x="ALTIS_TEST_FAULT"' },
    ];
    expect(() => checkNoLeaks(files.slice(0, 1), ['ALTIS_TEST_', 'dev-rel-1'])).not.toThrow();
    expect(() => checkNoLeaks(files, ['ALTIS_TEST_', 'dev-rel-1'])).toThrow(/^PRODUCTION_BUILD_LEAK:server\.mjs\b.*ALTIS_TEST_/);
  });
});
