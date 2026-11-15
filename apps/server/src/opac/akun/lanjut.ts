import type { RouteDecl } from '../../http/route.js';

// Where the sign-in page goes back to (`lanjut`): only a path of this site that one of the OPAC's own GET routes
// serves, checked against the route table (never by a text prefix), with its query kept; anything else (another site,
// `//host`, `/\host`, a path no OPAC page answers, the sign-in page itself) is null and the member lands on `/akun`.

/** The longest `lanjut` taken, in characters. */
const LANJUT_MAX = 1000;
const ORIGIN = 'https://lanjut.invalid';
/** A path that starts with one slash and is not followed by another slash or a backslash. */
const LOCAL = /^\/(?![/\\])/;
/** Text a link never carries: control characters, a backslash, white space. */
const UNSAFE = /[\p{Cc}\\\s]/u;

/** The pages a member never goes back to after signing in. */
const NEVER = new Set(['/akun/masuk', '/akun/lupa-sandi', '/akun/atur-sandi/:token', '/akun/keluar', '/akun/foto', '/assets/:file']);

/** The matcher of a Hono path (`/katalog/:id/:slug`): each parameter one non-empty segment. */
function matcher(path: string): RegExp {
  const parts = path.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return new RegExp(`^${parts.join('/')}$`);
}

const cache = new WeakMap<readonly RouteDecl[], RegExp[]>();

function matchers(routes: readonly RouteDecl[]): RegExp[] {
  let list = cache.get(routes);
  if (list === undefined) {
    // The OPAC's own pages: public GET routes that read no staff session, outside the API, the wizard and `/_health`.
    list = routes
      .filter((r) => r.method === 'GET' && r.public === true && r.session === 'none' && r.install === undefined)
      .filter((r) => !r.path.startsWith('/api/') && !r.path.startsWith('/_') && !NEVER.has(r.path))
      .map((r) => matcher(r.path));
    cache.set(routes, list);
  }
  return list;
}

/** `value` as a local path and query an OPAC GET route of `routes` serves, or null (see the top of this file). */
export function safeLanjut(value: unknown, routes: readonly RouteDecl[]): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > LANJUT_MAX) return null;
  if (!LOCAL.test(value) || UNSAFE.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN || url.hash !== '') return null;
  const path = url.pathname;
  if (!LOCAL.test(path) || !matchers(routes).some((m) => m.test(path))) return null;
  return `${path}${url.search}`;
}
