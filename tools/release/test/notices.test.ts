import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BundledPackage } from '../src/checks.js';
import { COMPOSED_LICENSES, VENDORED_NOTICES, collectNotices } from '../src/notices.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

// THIRD_PARTY_NOTICES.txt (spec §4.3): the licence texts of every bundled package, from its LICENSE*/NOTICE* files;
// a package without any licence text fails the build.

let root: string;

beforeAll(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-notices-')));
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

async function packageDir(name: string, files: Record<string, string>): Promise<BundledPackage> {
  const dir = path.join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) await fsp.writeFile(path.join(dir, file), text);
  return { name, version: '1.0.0', license: 'MIT', dir };
}

describe('collectNotices', () => {
  it('reproduces LICENSE* and NOTICE* files of each package, sorted by name, with CRLF made LF', async () => {
    const zeta = await packageDir('zeta', { 'LICENSE.md': 'Zeta licence\r\nline 2\r\n', NOTICE: 'Zeta notice\n', 'README.md': '# zeta\n' });
    const alpha = await packageDir('alpha', { license: 'Alpha licence text\n', 'index.js': '' });
    const notices = await collectNotices([zeta, alpha], { version: '1.2.3' });
    expect(notices.packages.map((p) => [p.name, p.files])).toEqual([
      ['alpha', ['license']],
      ['zeta', ['LICENSE.md', 'NOTICE']],
    ]);
    expect(notices.text).toContain('ALTIS 1.2.3');
    expect(notices.text.indexOf('Alpha licence text')).toBeGreaterThan(-1);
    expect(notices.text.indexOf('Alpha licence text')).toBeLessThan(notices.text.indexOf('Zeta licence'));
    expect(notices.text).toContain('Zeta licence\nline 2\n');
    expect(notices.text).toContain('Zeta notice');
    expect(notices.text).not.toContain('\r');
    expect(notices.text).not.toContain('# zeta');
  });

  it('falls back to the licence section of README.md', async () => {
    const readme = await packageDir('readme-only', {
      'README.md': '# readme-only\n\nUsage.\n\n## License\n\nThe MIT License (MIT)\n\nCopyright (c) 2014 Someone\n\n## Other\n\nnot this\n',
    });
    const notices = await collectNotices([readme], { version: '1.0.0' });
    expect(notices.packages[0]!.files).toEqual(['README.md']);
    expect(notices.text).toContain('Copyright (c) 2014 Someone');
    expect(notices.text).not.toContain('not this');
    expect(notices.text).not.toContain('Usage.');
  });

  it('accepts a pg-types-like README licence section (the MIT text in full) and a short one that carries a copyright line', async () => {
    const full = await packageDir('pg-types-like', {
      'README.md': [
        '# pg-types-like',
        '',
        '## license',
        '',
        'The MIT License (MIT)',
        '',
        'Copyright (c) 2014 Brian M. Carlson',
        '',
        'Permission is hereby granted, free of charge, to any person obtaining a copy',
        'of this software and associated documentation files (the "Software"), to deal',
        'in the Software without restriction, including without limitation the rights',
        '',
      ].join('\n'),
    });
    const short = await packageDir('copyright-line', { 'README.md': '# copyright-line\n\n## License\n\nCopyright (c) 2013-2016 Hannes Hörl\n' });
    const notices = await collectNotices([full, short], { version: '1.0.0' });
    expect(notices.packages.map((p) => [p.name, p.files])).toEqual([
      ['copyright-line', ['README.md']],
      ['pg-types-like', ['README.md']],
    ]);
    expect(notices.text).toContain('Permission is hereby granted');
    expect(notices.text).toContain('Copyright (c) 2013-2016 Hannes Hörl');
  });

  it('accepts a long README licence section even without the usual words (200 characters or more)', async () => {
    const body = 'This software is distributed under the terms of the Example Public Licence, version 2. '.repeat(3);
    expect(body.length).toBeGreaterThanOrEqual(200);
    const long = await packageDir('long-section', { 'README.md': `# long-section\n\n## Licence\n\n${body}\n` });
    const notices = await collectNotices([long], { version: '1.0.0' });
    expect(notices.packages[0]!.files).toEqual(['README.md']);
  });

  it('fails LICENSE_TEXT_MISSING:<pkg> for a README licence section that is only a name ("MIT"): no copyright or permission notice (MIT notice condition)', async () => {
    for (const [name, section] of [
      ['bare-mit', 'MIT'],
      ['mit-link', 'MIT © [Someone](https://example.com)'],
      ['see-file', 'Released under the MIT licence; see the LICENSE file in the repository.'],
    ] as const) {
      const pkg = await packageDir(name, { 'README.md': `# ${name}\n\nUsage.\n\n## License\n\n${section}\n` });
      expect(section.length).toBeLessThan(200);
      await expect(collectNotices([pkg], { version: '1.0.0' }), name).rejects.toThrow(new RegExp(`^LICENSE_TEXT_MISSING:${name}\\b`));
    }
  });

  it('a README fallback does not hide a real LICENSE file, and a bare README section does not replace one', async () => {
    const both = await packageDir('file-and-readme', { LICENSE: 'Real licence text\n', 'README.md': '# x\n\n## License\n\nMIT\n' });
    const notices = await collectNotices([both], { version: '1.0.0' });
    expect(notices.packages[0]!.files).toEqual(['LICENSE']);
    expect(notices.text).toContain('Real licence text');
  });

  it('fails LICENSE_TEXT_MISSING:<pkg> for a package without any licence text', async () => {
    const bare = await packageDir('bare', { 'README.md': '# bare\n\nNo licence here.\n', 'index.js': '' });
    await expect(collectNotices([bare], { version: '1.0.0' })).rejects.toThrow(/^LICENSE_TEXT_MISSING:bare\b/);
  });

  it('a package that ships no licence text at all gets its reviewed composed text, for its exact name, version and licence only', async () => {
    const thin = await packageDir('no-licence-file', { 'README.md': '# no-licence-file\n\n## License\n\nMIT\n' });
    await fsp.mkdir(path.join(root, 'composed'), { recursive: true });
    await fsp.writeFile(path.join(root, 'composed', 'no-licence-file.txt'), 'Composed MIT text\r\nCopyright (c) Someone\n');
    const composed = [{ name: 'no-licence-file', version: '1.0.0', license: 'MIT', file: 'composed/no-licence-file.txt' }];
    const notices = await collectNotices([thin], { version: '1.0.0', vendored: [], composed, root });
    expect(notices.packages).toEqual([{ name: 'no-licence-file', version: '1.0.0', license: 'MIT', files: ['composed/no-licence-file.txt'] }]);
    expect(notices.text).toContain('Composed MIT text\nCopyright (c) Someone');
    expect(notices.text).toContain('Sumber / Source: composed/no-licence-file.txt (tidak ada berkas lisensi di paket / the package ships no licence file)');

    // Another version, or another declared licence, is not what was reviewed.
    await expect(collectNotices([{ ...thin, version: '1.0.1' }], { version: '1.0.0', vendored: [], composed, root })).rejects.toThrow(
      /^LICENSE_TEXT_MISSING:no-licence-file\b/,
    );
    await expect(collectNotices([{ ...thin, license: 'ISC' }], { version: '1.0.0', vendored: [], composed, root })).rejects.toThrow(
      /^LICENSE_TEXT_MISSING:no-licence-file\b/,
    );
    // A real licence file always wins over a composed text.
    const shipped = await packageDir('ships-its-own', { LICENSE: 'Own licence\n' });
    const own = await collectNotices([shipped], { version: '1.0.0', vendored: [], composed: [{ ...composed[0]!, name: 'ships-its-own' }], root });
    expect(own.packages[0]!.files).toEqual(['LICENSE']);
  });

  it('COMPOSED_LICENSES: react-remove-scroll-bar 2.3.8 (Radix dialogs) ships no licence file; its text is the standard MIT text with its author', async () => {
    expect(COMPOSED_LICENSES.map((c) => [c.name, c.version, c.license])).toEqual([
      ['react-remove-scroll-bar', '2.3.8', 'MIT'],
      ['qrcode-generator', '2.0.4', 'MIT'],
    ]);
    const text = await fsp.readFile(path.join(REPO_ROOT, COMPOSED_LICENSES[0]!.file), 'utf8');
    const mit = (await fsp.readFile(path.join(REPO_ROOT, 'apps', 'admin', 'node_modules', 'react', 'LICENSE'), 'utf8')).replace(/\r\n?/g, '\n');
    expect(text).toContain('Copyright (c) Anton Korzunov');
    expect(text).toContain(mit.slice(mit.indexOf('Permission is hereby granted')).trim());
  });

  it('COMPOSED_LICENSES: qrcode-generator 2.0.4 (the 2FA QR code) ships no licence file; its text is the standard MIT text with the copyright of its source header', async () => {
    const entry = COMPOSED_LICENSES.find((c) => c.name === 'qrcode-generator');
    const text = await fsp.readFile(path.join(REPO_ROOT, entry!.file), 'utf8');
    const mit = (await fsp.readFile(path.join(REPO_ROOT, 'apps', 'admin', 'node_modules', 'react', 'LICENSE'), 'utf8')).replace(/\r\n?/g, '\n');
    const source = await fsp.readFile(path.join(REPO_ROOT, 'apps', 'admin', 'node_modules', 'qrcode-generator', 'dist', 'qrcode.mjs'), 'utf8');
    expect(source).toContain('Copyright (c) 2009 Kazuhiko Arase');
    expect(source).toContain('Licensed under the MIT license');
    expect(text).toContain('Copyright (c) 2009 Kazuhiko Arase');
    expect(text).toContain(mit.slice(mit.indexOf('Permission is hereby granted')).trim());
  });

  it('appends the vendored notices: SecLists (the common-password list of @altis/core) with its MIT text', async () => {
    expect(VENDORED_NOTICES.map((v) => v.file)).toContain('packages/core/data/LICENSE-SecLists.txt');
    const license = await fsp.readFile(path.join(REPO_ROOT, 'packages', 'core', 'data', 'LICENSE-SecLists.txt'), 'utf8');
    expect(license).toMatch(/MIT/);
    const notices = await collectNotices([await packageDir('vendor-host', { LICENSE: 'Host licence\n' })], { version: '1.0.0' });
    expect(notices.text).toContain('SecLists');
    expect(notices.text).toContain(license.replace(/\r\n?/g, '\n').trim());
    expect(notices.text).toContain('Permission is hereby granted');
    // After the bundled packages, and listed in the header.
    expect(notices.text.indexOf('Host licence')).toBeLessThan(notices.text.indexOf(license.trim().split('\n')[0]!));
    const header = notices.text.slice(0, notices.text.indexOf('='.repeat(80)));
    expect(header).toContain('SecLists');
  });

  it('appends the shadcn/ui notice (the admin UI primitives are adapted from it, S27): the MIT text, Copyright (c) 2023 shadcn', async () => {
    const shadcn = VENDORED_NOTICES.find((v) => v.name.startsWith('shadcn/ui'));
    expect(shadcn).toEqual({
      name: 'shadcn/ui components (apps/admin/src/components/ui)',
      source: 'https://github.com/shadcn-ui/ui',
      license: 'MIT',
      file: 'apps/admin/src/components/ui/LICENSE-shadcn-ui.txt',
    });
    const license = (await fsp.readFile(path.join(REPO_ROOT, shadcn!.file), 'utf8')).replace(/\r\n?/g, '\n');
    const mit = (await fsp.readFile(path.join(REPO_ROOT, 'apps', 'admin', 'node_modules', 'react', 'LICENSE'), 'utf8')).replace(/\r\n?/g, '\n');
    expect(license.split('\n').slice(0, 3)).toEqual(['MIT License', '', 'Copyright (c) 2023 shadcn']);
    expect(license).toContain(mit.slice(mit.indexOf('Permission is hereby granted')).trim());
    const notices = await collectNotices([await packageDir('vendor-host-2', { LICENSE: 'Host licence\n' })], { version: '1.0.0' });
    expect(notices.text).toContain(`shadcn/ui components (apps/admin/src/components/ui)\nLisensi / License: MIT\nSumber / Source: https://github.com/shadcn-ui/ui (${shadcn!.file})`);
    expect(notices.text).toContain(license.trim());
    const header = notices.text.slice(0, notices.text.indexOf('='.repeat(80)));
    expect(header).toContain('  shadcn/ui components (apps/admin/src/components/ui) (MIT)');
  });

  it('fails LICENSE_TEXT_MISSING:<name> for a vendored notice whose licence file is missing or empty', async () => {
    const vendored = [{ name: 'gone', source: 'https://example.invalid/gone', license: 'MIT', file: 'nope/LICENSE.txt' }];
    await expect(collectNotices([], { version: '1.0.0', vendored, root })).rejects.toThrow(/^LICENSE_TEXT_MISSING:gone\b/);
    await fsp.mkdir(path.join(root, 'empty'), { recursive: true });
    await fsp.writeFile(path.join(root, 'empty', 'LICENSE.txt'), '  \n');
    const empty = [{ ...vendored[0]!, name: 'empty', file: 'empty/LICENSE.txt' }];
    await expect(collectNotices([], { version: '1.0.0', vendored: empty, root })).rejects.toThrow(/^LICENSE_TEXT_MISSING:empty\b/);
  });

  it('is deterministic', async () => {
    const one = await packageDir('one', { LICENSE: 'One\n' });
    const two = await packageDir('two', { LICENSE: 'Two\n' });
    const a = await collectNotices([one, two], { version: '1.0.0' });
    const b = await collectNotices([two, one], { version: '1.0.0' });
    expect(a.text).toBe(b.text);
  });
});
