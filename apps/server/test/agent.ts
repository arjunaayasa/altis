import type { Hono } from 'hono';
import type { AppEnv } from '../src/app.js';

// A test client over Hono's app.request(): no socket, but the request carries a peer address the way
// @hono/node-server hands it over (`c.env.incoming.socket.remoteAddress`), and a cookie jar keeps what the app sets.

export interface AgentReply {
  status: number;
  /** The body parsed as JSON, or undefined when it is not JSON (or empty). */
  json: unknown;
  text: string;
  headers: Headers;
}

export interface AgentOptions {
  /** The peer address (`c.env.incoming.socket.remoteAddress`); default `203.0.113.10`. */
  peer?: string;
  /** Headers sent with every request (a call's own headers win). */
  headers?: Record<string, string>;
}

type Send = (path: string, body?: unknown, headers?: Record<string, string>) => Promise<AgentReply>;

export interface Agent {
  get: Send;
  post: Send;
  put: Send;
  patch: Send;
  delete: Send;
  /** The cookies the jar holds, by name. */
  readonly cookies: Map<string, string>;
  /** Puts a cookie into the jar as if the app had set it. */
  setCookie(name: string, value: string): void;
}

/** Updates `jar` from the Set-Cookie headers of `res`: `Max-Age=0` (or a past `Expires`) removes the cookie. */
function store(jar: Map<string, string>, res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    const [pair = '', ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const gone = attrs.some((a) => {
      const [k = '', v = ''] = a.split('=');
      const key = k.trim().toLowerCase();
      if (key === 'max-age') return Number(v.trim()) <= 0;
      if (key === 'expires') return Date.parse(v.trim()) <= Date.now();
      return false;
    });
    if (gone) jar.delete(name);
    else jar.set(name, value);
  }
}

/**
 * A cookie-jar client over `app.request(path, init, {incoming: {socket: {remoteAddress: peer}}})`.
 *
 * `body`: undefined sends none; a string is sent as it is (content type `application/json` unless the headers name
 * another); anything else is sent as its JSON text.
 */
export function createAgent(app: Hono<AppEnv>, o: AgentOptions = {}): Agent {
  const jar = new Map<string, string>();
  const peer = o.peer ?? '203.0.113.10';

  const send =
    (method: string): Send =>
    async (path, body, headers = {}) => {
      const h = new Headers(o.headers);
      if (body !== undefined) h.set('content-type', 'application/json');
      for (const [k, v] of Object.entries(headers)) h.set(k, v);
      if (jar.size > 0 && !h.has('cookie')) {
        h.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      }
      const init: RequestInit = { method, headers: h };
      if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
      const res = await app.request(path, init, { incoming: { socket: { remoteAddress: peer } } });
      store(jar, res);
      const text = await res.text();
      let json: unknown;
      try {
        json = text === '' ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, json, text, headers: res.headers };
    };

  return {
    get: send('GET'),
    post: send('POST'),
    put: send('PUT'),
    patch: send('PATCH'),
    delete: send('DELETE'),
    cookies: jar,
    setCookie: (name, value) => {
      jar.set(name, value);
    },
  };
}
