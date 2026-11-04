import fs from 'node:fs';
import path from 'node:path';
import { isDirectory, isInside, realpathNearest } from './pathutil.js';

// The document-root guard (spec P16). The classic shared-hosting mistake is to unpack the app, or to let
// DATA_DIR land, inside a directory the web server serves: anybody could then download config.json (database
// password, secrets) and the backups. The check is static and has no way to be skipped; the wizard's HTTP
// probe (spec §9.5) is a second line of defence for layouts that this check cannot see.

export interface DocrootCheckOptions {
  dataDir: string;
  /** The folder that holds `app.js`. */
  appRoot: string;
  /** The user's home directory. An empty or blank value disables the rules that are relative to it. */
  home: string;
  /**
   * Prepended to `/var/www` and `/www` (also to the `root` paths found in the aaPanel configuration), so that
   * tests can fake those directories.
   *
   * @internal Tests only. Never wire it from the environment or from a configuration file: whoever controls
   * it controls what counts as a document root.
   */
  rootPrefix?: string;
}

export type DocrootCheck =
  | { ok: true }
  | {
      ok: false;
      /** `DOCROOT`: DATA_DIR or the app lies in a detected document root. `DATA_IN_APPROOT`: DATA_DIR lies in the app folder. */
      reason: 'DATA_IN_APPROOT' | 'DOCROOT';
      /** The real path of the document root that matched (or of the app folder for `DATA_IN_APPROOT`). */
      matched: string;
    };

/** cPanel names the document root of an addon or subdomain after the domain. */
const DOMAIN_LIKE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
/** A domain-named folder in $HOME that holds one of these is a document root. */
const DOCROOT_MARKERS = ['.htaccess', 'index.php', 'index.html', 'cgi-bin'];
/** XAMPP and Apache setups call the document root `htdocs`; Plesk calls it `httpdocs`. */
const DOCROOT_SEGMENTS = new Set(['htdocs', 'httpdocs']);

/** aaPanel keeps the nginx site configurations here. */
const VHOST_DIR = ['www', 'server', 'panel', 'vhost', 'nginx'];
/** `root <path>;` in an nginx configuration, with the path bare or quoted. Comments are removed beforehand. */
const ROOT_DIRECTIVE = /(?:^|[\s;{}])root[ \t]+("[^"\n]*"|'[^'\n]*'|[^\s;"'{}]+)[ \t]*;/g;

/** `/<parts>` under the (test-only) prefix; always absolute, also when the prefix is empty. */
function underPrefix(prefix: string, ...parts: string[]): string {
  return path.join(prefix, path.sep, ...parts);
}

/** aaPanel keeps the sites below this folder; a vhost `root` counts only when it lies below it (ruling R9). */
const WWWROOT = '/www/wwwroot/';

/**
 * The `root` paths of one nginx configuration that lie strictly below `/www/wwwroot/`, normalised. Variables,
 * relative values and anything that, once normalised, is not below that folder (`/www/wwwroot/../altis/x`) are
 * skipped. The filter is lexical, before any symbolic link is followed: a site that is a link elsewhere still
 * contributes its real target afterwards.
 */
function rootDirectives(conf: string): string[] {
  const roots: string[] = [];
  for (const match of conf.replace(/#[^\n]*/g, '').matchAll(ROOT_DIRECTIVE)) {
    const raw = match[1] ?? '';
    const value = raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
    if (!value.startsWith('/') || value.includes('$')) continue;
    const normalised = path.posix.normalize(value);
    if (normalised.startsWith(WWWROOT) && normalised.length > WWWROOT.length) roots.push(normalised);
  }
  return roots;
}

/** The names in `dir`, or none when it cannot be read. */
function names(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** The document roots that aaPanel's own configuration lists below `/www/wwwroot`; none when it cannot be read. */
function vhostRoots(prefix: string): string[] {
  const dir = underPrefix(prefix, ...VHOST_DIR);
  const roots: string[] = [];
  for (const name of names(dir)) {
    if (!name.endsWith('.conf')) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const value of rootDirectives(text)) roots.push(realpathNearest(underPrefix(prefix, value)));
  }
  return roots;
}

/**
 * aaPanel's `/www/wwwroot` and every site below it (the folder itself blocks every `/www/wwwroot/<site>`,
 * listed in a configuration or not); each child is also resolved on its own, so that a site that is a
 * symbolic link elsewhere blocks its real target; then the `root`s that the nginx configuration lists below it.
 */
function wwwrootRoots(prefix: string): string[] {
  const base = underPrefix(prefix, 'www', 'wwwroot');
  const roots = [realpathNearest(base)];
  for (const name of names(base)) {
    const site = path.join(base, name);
    if (isDirectory(site)) roots.push(realpathNearest(site));
  }
  roots.push(...vhostRoots(prefix));
  return roots;
}

/**
 * The real paths of the domain-named folders directly in `$HOME` that hold a document-root marker (cPanel
 * addon and subdomain roots). A folder that is a symbolic link contributes its target.
 */
function homeDomainRoots(home: string): string[] {
  const roots: string[] = [];
  for (const name of names(home)) {
    if (!DOMAIN_LIKE.test(name)) continue;
    const dir = path.join(home, name);
    if (DOCROOT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)))) roots.push(realpathNearest(dir));
  }
  return roots;
}

/**
 * The document roots that are places (real paths): `$HOME/public_html`, the real path of `$HOME/www`, the
 * domain-named folders in `$HOME`, `/var/www`, and aaPanel's `/www/wwwroot` sites. The segment `www` on its
 * own is not a document root: `/www/altis/<name>/app` is the supported aaPanel layout.
 */
function docroots(home: string, prefix: string): string[] {
  const roots: string[] = [];
  if (home.trim() !== '') {
    roots.push(realpathNearest(path.join(home, 'public_html')));
    if (isDirectory(path.join(home, 'www'))) roots.push(realpathNearest(path.join(home, 'www')));
    roots.push(...homeDomainRoots(home));
  }
  roots.push(realpathNearest(underPrefix(prefix, 'var', 'www')));
  roots.push(...wwwrootRoots(prefix));
  return roots;
}

/** The path up to the first segment named `htdocs` or `httpdocs` (any letter case), or null. */
function namedDocroot(p: string): string | null {
  const { root } = path.parse(p);
  const parts = p.slice(root.length).split(path.sep);
  for (let i = 0; i < parts.length; i += 1) {
    if (DOCROOT_SEGMENTS.has((parts[i] as string).toLowerCase())) return path.join(root, ...parts.slice(0, i + 1));
  }
  return null;
}

/**
 * Checks that neither DATA_DIR nor the app folder lies in a document root, and that DATA_DIR is not inside
 * the app folder. There is no way to override a failure.
 *
 * Paths are compared as real paths (`fs.realpathSync.native`, which also settles letter case on macOS and
 * Windows), so a symbolic link cannot hide a document root: with `~/www -> ~/public_html`, `~/www/x` is
 * blocked. For a path that does not exist yet, the real path of its nearest existing ancestor is joined with
 * the rest. The document roots are:
 *
 * - `$HOME/public_html`, and the real path of `$HOME/www`;
 * - a folder directly in `$HOME` that is named like a domain (cPanel addon and subdomain roots) and holds
 *   `.htaccess`, `index.php`, `index.html` or `cgi-bin`; a folder that is a link counts by its target;
 * - `/var/www/**`;
 * - any path with a segment `htdocs` or `httpdocs`, checked on the real and on the written path;
 * - aaPanel: every `/www/wwwroot/<site>` (a site that is a link counts by its target), plus the `root` that
 *   `/www/server/panel/vhost/nginx/*.conf` lists when it lies below `/www/wwwroot/`. A listed root anywhere
 *   else, such as `/www/altis/<name>/app`, which aaPanel may write for a Node project, is not a document root.
 *
 * When both problems apply, `DOCROOT` is reported first. This inspects the file system but changes nothing.
 */
export function checkDocroot(o: DocrootCheckOptions): DocrootCheck {
  const roots = docroots(o.home, o.rootPrefix ?? '');

  const subjects = [o.dataDir, o.appRoot].map((written) => ({ written: path.resolve(written), real: realpathNearest(written) }));
  for (const { written, real } of subjects) {
    // Several can apply (a listed site inside /www/wwwroot): report the most specific.
    const containing = roots.filter((root) => isInside(real, root));
    const rootMatch = containing.reduce<string | null>((best, root) => (best === null || root.length > best.length ? root : best), null);
    const matched = rootMatch ?? namedDocroot(real) ?? namedDocroot(written);
    if (matched !== null) return { ok: false, reason: 'DOCROOT', matched };
  }

  const [data, app] = subjects as [(typeof subjects)[number], (typeof subjects)[number]];
  if (isInside(data.real, app.real)) return { ok: false, reason: 'DATA_IN_APPROOT', matched: app.real };
  return { ok: true };
}
