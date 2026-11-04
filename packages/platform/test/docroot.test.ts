import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDocroot } from '../src/docroot.js';

// Every path lives under a temporary directory: `home` is injected and `rootPrefix` stands in for the real
// `/var/www` and `/www`, so nothing here touches the machine's own directories.

let root: string; // realpath of the temp directory (macOS temp dirs sit behind a symlink)
let home: string;
let rootPrefix: string;

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-docroot-')));
  home = path.join(root, 'home', 'u');
  rootPrefix = path.join(root, 'fake-root');
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(rootPrefix, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const mkdir = (...parts: string[]): Promise<string | undefined> => fsp.mkdir(path.join(...parts), { recursive: true });
const check = (dataDir: string, appRoot: string, extra: { home?: string } = {}) =>
  checkDocroot({ dataDir, appRoot, home: extra.home ?? home, rootPrefix });

async function writeVhost(name: string, content: string): Promise<void> {
  const dir = path.join(rootPrefix, 'www', 'server', 'panel', 'vhost', 'nginx');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, name), content);
}

/**
 * A site under /www/wwwroot whose `public` folder is a symlink to `<rootPrefix>/srv/<name>`. The blanket
 * /www/wwwroot rule cannot see that target, so only a configuration that lists the root reveals it.
 * Returns the target.
 */
async function linkedSite(name: string): Promise<string> {
  const target = path.join(rootPrefix, 'srv', name);
  await mkdir(target);
  await mkdir(rootPrefix, 'www', 'wwwroot', name);
  await fsp.symlink(target, path.join(rootPrefix, 'www', 'wwwroot', name, 'public'));
  return target;
}

/** Whether the temp directory's file system treats `a` and `A` as one name (macOS and Windows default). */
function isCaseInsensitive(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'altis-case-'));
  try {
    fs.writeFileSync(path.join(dir, 'probe'), '');
    return fs.existsSync(path.join(dir, 'PROBE'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const CASE_INSENSITIVE = isCaseInsensitive();

describe('checkDocroot: blocked', () => {
  it('app inside $HOME/public_html', async () => {
    await mkdir(home, 'public_html', 'perpus');
    expect(check(path.join(home, 'altis-data'), path.join(home, 'public_html', 'perpus'))).toEqual({
      ok: false,
      reason: 'DOCROOT',
      matched: path.join(home, 'public_html'),
    });
  });

  it('DATA_DIR inside $HOME/public_html even when the app is outside', async () => {
    await mkdir(home, 'public_html');
    await mkdir(home, 'altis', 'app');
    expect(check(path.join(home, 'public_html', 'data'), path.join(home, 'altis', 'app'))).toEqual({
      ok: false,
      reason: 'DOCROOT',
      matched: path.join(home, 'public_html'),
    });
  });

  it('public_html itself', async () => {
    await mkdir(home, 'public_html');
    await mkdir(home, 'altis', 'app');
    expect(check(path.join(home, 'public_html'), path.join(home, 'altis', 'app'))).toMatchObject({ reason: 'DOCROOT' });
  });

  it('a path reached through a symlink: ~/www -> ~/public_html and DATA_DIR ~/www/x', async () => {
    await mkdir(home, 'public_html');
    await fsp.symlink(path.join(home, 'public_html'), path.join(home, 'www'));
    await mkdir(home, 'altis', 'app');
    expect(check(path.join(home, 'www', 'x'), path.join(home, 'altis', 'app'))).toEqual({
      ok: false,
      reason: 'DOCROOT',
      matched: path.join(home, 'public_html'),
    });
  });

  it('a real $HOME/www directory counts as a docroot too (the spec blocks the realpath of $HOME/www)', async () => {
    await mkdir(home, 'www', 'altis');
    await mkdir(home, 'altis', 'app');
    expect(check(path.join(home, 'www', 'altis'), path.join(home, 'altis', 'app'))).toEqual({
      ok: false,
      reason: 'DOCROOT',
      matched: path.join(home, 'www'),
    });
  });

  it('a symlinked DATA_DIR that points into public_html', async () => {
    await mkdir(home, 'public_html', 'hidden');
    await mkdir(home, 'altis', 'app');
    await fsp.symlink(path.join(home, 'public_html', 'hidden'), path.join(home, 'altis-data'));
    expect(check(path.join(home, 'altis-data'), path.join(home, 'altis', 'app'))).toMatchObject({
      reason: 'DOCROOT',
      matched: path.join(home, 'public_html'),
    });
  });

  it('a dangling symlink whose target (not created yet) lies in public_html', async () => {
    await mkdir(home, 'public_html');
    await mkdir(home, 'altis', 'app');
    await fsp.symlink(path.join(home, 'public_html', 'later', 'data'), path.join(home, 'altis-data'));
    expect(check(path.join(home, 'altis-data'), path.join(home, 'altis', 'app'))).toMatchObject({ reason: 'DOCROOT' });
  });

  it('a leaf that does not exist yet: the nearest existing ancestor decides', async () => {
    await mkdir(home, 'public_html', 'perpus');
    expect(check(path.join(home, 'altis-data'), path.join(home, 'public_html', 'perpus', 'new', 'app'))).toMatchObject({
      reason: 'DOCROOT',
      matched: path.join(home, 'public_html'),
    });
  });

  describe('cPanel addon/subdomain docroot ($HOME/<domain-name>)', () => {
    const domain = 'perpus.sekolah.sch.id';

    it.each([
      ['.htaccess', 'file'],
      ['index.php', 'file'],
      ['index.html', 'file'],
      ['cgi-bin', 'dir'],
    ] as const)('a domain-named directory holding %s', async (marker, kind) => {
      await mkdir(home, domain, 'app');
      if (kind === 'dir') await mkdir(home, domain, marker);
      else await fsp.writeFile(path.join(home, domain, marker), '');
      await mkdir(home, 'altis-data');
      expect(check(path.join(home, 'altis-data'), path.join(home, domain, 'app'))).toEqual({
        ok: false,
        reason: 'DOCROOT',
        matched: path.join(home, domain),
      });
    });

    it('also blocks a DATA_DIR placed there', async () => {
      await mkdir(home, domain, 'cgi-bin');
      await mkdir(home, 'altis', 'app');
      expect(check(path.join(home, domain, 'altis-data'), path.join(home, 'altis', 'app'))).toMatchObject({
        reason: 'DOCROOT',
        matched: path.join(home, domain),
      });
    });

    it('leaves a domain-named directory alone when it holds none of those markers', async () => {
      await mkdir(home, domain, 'app');
      await mkdir(home, domain, 'altis-data');
      expect(check(path.join(home, domain, 'altis-data'), path.join(home, domain, 'app'))).toEqual({ ok: true });
    });

    it('leaves a directory whose name is not domain-like alone, markers or not', async () => {
      await mkdir(home, 'altis', 'app');
      await fsp.writeFile(path.join(home, 'altis', 'index.html'), '');
      await mkdir(home, 'altis-data');
      expect(check(path.join(home, 'altis-data'), path.join(home, 'altis', 'app'))).toEqual({ ok: true });
    });
  });

  it('/var/www/** (under rootPrefix)', async () => {
    await mkdir(home, 'altis', 'app');
    const web = path.join(rootPrefix, 'var', 'www', 'html', 'altis');
    expect(check(web, path.join(home, 'altis', 'app'))).toEqual({
      ok: false,
      reason: 'DOCROOT',
      matched: path.join(rootPrefix, 'var', 'www'),
    });
    expect(check(path.join(home, 'altis-data'), web)).toMatchObject({ reason: 'DOCROOT' });
  });

  it.each(['htdocs', 'httpdocs', 'HTDOCS'])('any path with a segment named %s', async (name) => {
    await mkdir(home, 'altis', 'app');
    const dir = path.join(home, name, 'sub', 'data');
    expect(check(dir, path.join(home, 'altis', 'app'))).toEqual({
      ok: false,
      reason: 'DOCROOT',
      matched: path.join(home, name),
    });
    expect(check(path.join(home, 'altis-data'), path.join(home, name, 'app'))).toMatchObject({ reason: 'DOCROOT' });
  });

  it('a symlink named htdocs counts even when it points elsewhere', async () => {
    await mkdir(root, 'vol', 'web');
    await fsp.symlink(path.join(root, 'vol', 'web'), path.join(home, 'htdocs'));
    await mkdir(home, 'altis', 'app');
    expect(check(path.join(home, 'htdocs', 'data'), path.join(home, 'altis', 'app'))).toMatchObject({
      reason: 'DOCROOT',
      matched: path.join(home, 'htdocs'),
    });
  });

  it('/www/wwwroot/<site>/** when no vhost configuration is readable', async () => {
    await mkdir(home, 'altis', 'app');
    const app = path.join(rootPrefix, 'www', 'wwwroot', 'site', 'app');
    expect(check(path.join(home, 'altis-data'), app)).toEqual({
      ok: false,
      reason: 'DOCROOT',
      matched: path.join(rootPrefix, 'www', 'wwwroot'),
    });
  });

  it('DATA_DIR inside appRoot', async () => {
    await mkdir(home, 'altis', 'app');
    expect(check(path.join(home, 'altis', 'app', 'altis-data'), path.join(home, 'altis', 'app'))).toEqual({
      ok: false,
      reason: 'DATA_IN_APPROOT',
      matched: path.join(home, 'altis', 'app'),
    });
  });

  it('DATA_DIR equal to appRoot', async () => {
    await mkdir(home, 'altis', 'app');
    expect(check(path.join(home, 'altis', 'app'), path.join(home, 'altis', 'app'))).toMatchObject({
      reason: 'DATA_IN_APPROOT',
    });
  });

  it('DATA_DIR inside appRoot through a symlink', async () => {
    await mkdir(home, 'altis', 'app', 'real');
    await fsp.symlink(path.join(home, 'altis', 'app', 'real'), path.join(home, 'altis-data'));
    expect(check(path.join(home, 'altis-data'), path.join(home, 'altis', 'app'))).toMatchObject({
      reason: 'DATA_IN_APPROOT',
    });
  });

  it('reports DOCROOT before DATA_IN_APPROOT when both apply', async () => {
    await mkdir(home, 'public_html', 'app');
    expect(check(path.join(home, 'public_html', 'app', 'altis-data'), path.join(home, 'public_html', 'app'))).toMatchObject({
      reason: 'DOCROOT',
    });
  });
});

describe('checkDocroot: allowed', () => {
  it('DATA_DIR in a sibling whose name merely starts with the appRoot name is fine', async () => {
    await mkdir(home, 'altis', 'app');
    await mkdir(home, 'altis', 'app-data');
    expect(check(path.join(home, 'altis', 'app-data'), path.join(home, 'altis', 'app'))).toEqual({ ok: true });
  });

  it('~/altis/app with ~/altis-data/app, public_html present', async () => {
    await mkdir(home, 'public_html');
    await mkdir(home, 'altis', 'app');
    await mkdir(home, 'altis-data', 'app');
    expect(check(path.join(home, 'altis-data', 'app'), path.join(home, 'altis', 'app'))).toEqual({ ok: true });
  });

  it('neither path exists yet', () => {
    expect(check(path.join(home, 'altis-data', 'app'), path.join(home, 'altis', 'app'))).toEqual({ ok: true });
  });

  it('the supported aaPanel layout /www/altis/<name>/app + /www/altis/<name>/altis-data', async () => {
    const base = path.join(rootPrefix, 'www', 'altis', 'perpus');
    await mkdir(base, 'app');
    await mkdir(base, 'altis-data');
    expect(check(path.join(base, 'altis-data'), path.join(base, 'app'))).toEqual({ ok: true });
  });

  it('the aaPanel layout stays allowed when vhost configurations exist', async () => {
    await writeVhost('a.conf', 'server {\n  root /www/wwwroot/a;\n}\n');
    const base = path.join(rootPrefix, 'www', 'altis', 'perpus');
    expect(check(path.join(base, 'altis-data'), path.join(base, 'app'))).toEqual({ ok: true });
  });

  it('a symlinked DATA_DIR that points to another allowed volume', async () => {
    await mkdir(root, 'vol', 'altis-data');
    await mkdir(home, 'altis', 'app');
    await fsp.symlink(path.join(root, 'vol', 'altis-data'), path.join(home, 'altis-data'));
    expect(check(path.join(home, 'altis-data'), path.join(home, 'altis', 'app'))).toEqual({ ok: true });
  });

  it('an empty or blank home never means the working directory', () => {
    // The unguarded code would resolve `public_html` against the working directory and block this path.
    const underCwd = path.join(process.cwd(), 'public_html', 'x');
    const app = path.join(root, 'altis', 'app');
    expect(check(underCwd, app, { home: '' })).toEqual({ ok: true });
    expect(check(underCwd, app, { home: '   ' })).toEqual({ ok: true });
  });
});

describe('checkDocroot: aaPanel vhost configuration', () => {
  it('blocks every /www/wwwroot/<site>, listed in a configuration or not', async () => {
    await writeVhost('a.conf', 'server {\n  listen 80;\n  root /www/wwwroot/a;\n}\n');
    await mkdir(home, 'altis', 'app');
    const app = path.join(home, 'altis', 'app');

    // the listed site is reported by its own root, the most specific match
    expect(check(path.join(rootPrefix, 'www', 'wwwroot', 'a', 'x'), app)).toEqual({
      ok: false,
      reason: 'DOCROOT',
      matched: path.join(rootPrefix, 'www', 'wwwroot', 'a'),
    });
    // b is absent from every configuration and is still blocked
    expect(check(path.join(rootPrefix, 'www', 'wwwroot', 'b', 'x'), app)).toEqual({
      ok: false,
      reason: 'DOCROOT',
      matched: path.join(rootPrefix, 'www', 'wwwroot'),
    });
  });

  it('a symlinked /www/wwwroot/<site> contributes its real target, with no configuration at all', async () => {
    const target = path.join(rootPrefix, 'srv', 'linked');
    await mkdir(target);
    await mkdir(rootPrefix, 'www', 'wwwroot');
    await fsp.symlink(target, path.join(rootPrefix, 'www', 'wwwroot', 'linked'));
    await mkdir(home, 'altis', 'app');
    expect(check(path.join(target, 'altis-data'), path.join(home, 'altis', 'app'))).toEqual({
      ok: false,
      reason: 'DOCROOT',
      matched: target,
    });
    expect(check(path.join(home, 'altis-data'), path.join(target, 'app'))).toMatchObject({ reason: 'DOCROOT' });
  });

  it('a listed root under /www/wwwroot contributes its real target when it is a symlink elsewhere (R9)', async () => {
    const target = await linkedSite('shop');
    await writeVhost('shop.conf', 'server {\n  root /www/wwwroot/shop/public;\n}\n');
    await mkdir(home, 'altis', 'app');
    expect(check(path.join(target, 'altis-data'), path.join(home, 'altis', 'app'))).toEqual({
      ok: false,
      reason: 'DOCROOT',
      matched: target,
    });
    expect(check(path.join(home, 'altis-data'), path.join(target, 'app'))).toMatchObject({ reason: 'DOCROOT' });
  });

  it('without the listing, that same target is not a document root', async () => {
    const target = await linkedSite('shop');
    await mkdir(home, 'altis', 'app');
    expect(check(path.join(target, 'altis-data'), path.join(home, 'altis', 'app'))).toEqual({ ok: true });
  });

  it('a root outside /www/wwwroot is not a document root (R9): the Node project directory of the supported layout', async () => {
    await writeVhost(
      'perpus.conf',
      [
        'server {',
        '  root /www/altis/perpus/app;',
        '  location /static { root /www/altis/perpus/app/public; }',
        '  root /www/wwwroot/../altis/perpus/app;',
        '}',
        '',
      ].join('\n'),
    );
    const base = path.join(rootPrefix, 'www', 'altis', 'perpus');
    await mkdir(base, 'app', 'public');
    await mkdir(base, 'altis-data');
    expect(check(path.join(base, 'altis-data'), path.join(base, 'app'))).toEqual({ ok: true });
  });

  it('ignores a root outside /www/wwwroot wherever it is', async () => {
    await writeVhost('site.conf', 'server {\n  root /home/web/site;\n  root /srv/other;\n}\n');
    await mkdir(home, 'altis', 'app');
    const app = path.join(home, 'altis', 'app');
    expect(check(path.join(rootPrefix, 'home', 'web', 'site', 'altis-data'), app)).toEqual({ ok: true });
    expect(check(path.join(home, 'altis-data'), path.join(rootPrefix, 'srv', 'other', 'app'))).toEqual({ ok: true });
  });

  it('reads every *.conf, quoted values and a root inside a location block, and ignores other files', async () => {
    const quoted = await linkedSite('quoted');
    const single = await linkedSite('single');
    const bak = await linkedSite('bak');
    await writeVhost('one.conf', 'server { root "/www/wwwroot/quoted/public"; }\n');
    await writeVhost('two.conf', "server {\n  location / {\n    root '/www/wwwroot/single/public';\n  }\n}\n");
    await writeVhost('three.conf.bak', 'root /www/wwwroot/bak/public;\n');
    await mkdir(home, 'altis', 'app');
    const app = path.join(home, 'altis', 'app');
    expect(check(path.join(quoted, 'd'), app)).toMatchObject({ reason: 'DOCROOT' });
    expect(check(path.join(single, 'd'), app)).toMatchObject({ reason: 'DOCROOT' });
    expect(check(path.join(bak, 'd'), app)).toEqual({ ok: true });
  });

  it('ignores commented-out roots, variables, relative values, a bare / root and a root that climbs out of /www/wwwroot', async () => {
    const commented = await linkedSite('commented');
    const inline = await linkedSite('inline');
    const hidden = await linkedSite('hidden');
    const climbing = await linkedSite('climbing');
    await writeVhost(
      'x.conf',
      [
        '# root /www/wwwroot/commented/public;',
        'server {',
        '  root /www/wwwroot/inline/public; # root /www/wwwroot/hidden/public;',
        '  root $document_root;',
        '  root html;',
        '  root /;',
        '  root /www/wwwroot/climbing/../climbing/../../altis/x;',
        '}',
        '',
      ].join('\n'),
    );
    await mkdir(home, 'altis', 'app');
    const app = path.join(home, 'altis', 'app');
    expect(check(path.join(commented, 'd'), app)).toEqual({ ok: true });
    expect(check(path.join(hidden, 'd'), app)).toEqual({ ok: true });
    expect(check(path.join(climbing, 'd'), app)).toEqual({ ok: true });
    expect(check(path.join(inline, 'd'), app)).toMatchObject({ reason: 'DOCROOT' });
    expect(check(path.join(home, 'altis-data'), app)).toEqual({ ok: true }); // `root /;` did not block the world
  });

  it('an unreadable vhost directory falls back to the /www/wwwroot rule', async () => {
    // a file where the directory should be: readdir fails with ENOTDIR
    await mkdir(rootPrefix, 'www', 'server', 'panel', 'vhost');
    await fsp.writeFile(path.join(rootPrefix, 'www', 'server', 'panel', 'vhost', 'nginx'), 'x');
    await mkdir(home, 'altis', 'app');
    expect(check(path.join(rootPrefix, 'www', 'wwwroot', 'b', 'x'), path.join(home, 'altis', 'app'))).toMatchObject({
      reason: 'DOCROOT',
    });
  });
});

describe('checkDocroot: symlinked document roots', () => {
  it('~/example.com -> /data/sites/example.com blocks the real target', async () => {
    const target = path.join(root, 'data', 'sites', 'example.com');
    await mkdir(target);
    await fsp.writeFile(path.join(target, 'index.html'), '');
    await fsp.symlink(target, path.join(home, 'example.com'));
    await mkdir(home, 'altis', 'app');
    expect(check(path.join(target, 'altis-data'), path.join(home, 'altis', 'app'))).toEqual({
      ok: false,
      reason: 'DOCROOT',
      matched: target,
    });
    expect(check(path.join(home, 'altis-data'), path.join(target, 'app'))).toMatchObject({ reason: 'DOCROOT' });
    // and the path through the link, as before
    expect(check(path.join(home, 'example.com', 'altis-data'), path.join(home, 'altis', 'app'))).toMatchObject({
      reason: 'DOCROOT',
      matched: target,
    });
  });

  it('a symlinked domain-named folder without a marker is left alone', async () => {
    const target = path.join(root, 'data', 'sites', 'example.com');
    await mkdir(target, 'sub');
    await fsp.symlink(target, path.join(home, 'example.com'));
    await mkdir(home, 'altis', 'app');
    expect(check(path.join(target, 'altis-data'), path.join(home, 'altis', 'app'))).toEqual({ ok: true });
  });

  it('every domain-named folder is looked at, not only the one that holds the paths', async () => {
    const target = path.join(root, 'data', 'a.example.com');
    await mkdir(target, 'cgi-bin');
    await fsp.symlink(target, path.join(home, 'a.example.com'));
    await mkdir(home, 'b.example.com'); // a decoy without markers
    await mkdir(home, 'altis', 'app');
    expect(check(path.join(target, 'x'), path.join(home, 'altis', 'app'))).toMatchObject({ reason: 'DOCROOT' });
  });

  it.skipIf(!CASE_INSENSITIVE)('catches ~/PUBLIC_HTML/data on a case-insensitive file system', async () => {
    await mkdir(home, 'public_html');
    await mkdir(home, 'altis', 'app');
    expect(check(path.join(home, 'PUBLIC_HTML', 'data'), path.join(home, 'altis', 'app'))).toEqual({
      ok: false,
      reason: 'DOCROOT',
      matched: path.join(home, 'public_html'),
    });
    await mkdir(rootPrefix, 'var', 'www');
    expect(check(path.join(rootPrefix, 'VAR', 'WWW', 'x'), path.join(home, 'altis', 'app'))).toMatchObject({
      reason: 'DOCROOT',
    });
  });
});
