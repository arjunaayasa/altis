import { resolveLocale } from '@altis/shared';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../../http/request-id.js';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';
import { opacText } from './messages.js';
import { oaiErrorDocument } from './oai/protocol.js';
import { oaiTokenKeys } from './oai/token.js';
import { handleOai, type OaiResult } from './oai/verbs.js';
import { textResponse } from './respond.js';

// The OPAC routes of OAI-PMH 2.0 (Phase 2 Task 35; spec §10, D2-24, D2-34):
//
//   GET  /oai   oai.get    the arguments in the query string
//   POST /oai   oai.post   the arguments in an application/x-www-form-urlencoded body
//
// Both are public, `session: 'none'` (no cookie is read), mode read (an edition never locks data, §1.3),
// `maintenance: allow`, `idempotency: none`, `audit: null`, rate-limited per IP in the bucket `oai` (60/min). The POST
// is the route contract's cookieless read (Task 2, isCookielessRead): it declares `mode: 'read'` explicitly and no
// body schema, so step 8 (CSRF/Origin) is skipped for it, and it is `tx: 'self'` (it writes nothing; the rate limiter
// counts in its own transaction). It reads its form itself: at most OAI_FORM_MAX_BYTES of UTF-8, else badArgument.
//
// OAI-PMH answers only while `opac.oai.enabled` is on and `opac.oai.adminEmail` is filled in (§10); otherwise 503 with
// a short text (Diagnostik and the dashboard's `oai_misconfigured` say why). Every answer is `text/xml` (OAI-PMH 2.0
// §3.1.2.1), protocol errors included (status 200), never cached. Every URL comes from config.baseUrl.

/** The largest POST body read (the arguments of one request fit in a few hundred bytes). */
export const OAI_FORM_MAX_BYTES = 16 * 1024;

const NO_STORE = 'no-store';

/** The declaration fields both routes share. */
const OAI = { public: true, session: 'none', maintenance: 'allow', idempotency: 'none', audit: null } as const;

/** Each argument with every value given, in order (URLSearchParams decoding: `+` is a space, `%XX` a byte). */
function argumentsOf(search: URLSearchParams): Record<string, string[]> {
  const out = Object.create(null) as Record<string, string[]>;
  for (const [name, value] of search) (out[name] ??= []).push(value);
  return out;
}

/** True for `application/x-www-form-urlencoded`, with no parameter but a utf-8 `charset`. */
function isFormContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const [type = '', ...parameters] = header.split(';');
  if (type.trim().toLowerCase() !== 'application/x-www-form-urlencoded') return false;
  return parameters.every((p) => {
    const eq = p.indexOf('=');
    if (eq < 0) return false;
    const name = p.slice(0, eq).trim().toLowerCase();
    const value = p.slice(eq + 1).trim().replace(/^"|"$/g, '').toLowerCase();
    return name === 'charset' && (value === 'utf-8' || value === 'utf8');
  });
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The arguments of a POST: its `application/x-www-form-urlencoded` body of at most {@link OAI_FORM_MAX_BYTES} bytes of
 * UTF-8, read here with a count (a declared Content-Length over the limit is refused unread; a body without one is
 * read only up to the limit, then cancelled). Null for any other body.
 */
async function formArguments(c: Context<AppEnv>): Promise<Record<string, string[]> | null> {
  if (!isFormContentType(c.req.header('content-type'))) return null;
  const declared = c.req.header('content-length');
  if (declared !== undefined && (!/^\d{1,12}$/.test(declared.trim()) || Number(declared) > OAI_FORM_MAX_BYTES)) return null;
  const stream = c.req.raw.body;
  const chunks: Uint8Array[] = [];
  if (stream !== null) {
    const reader = stream.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > OAI_FORM_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  let text: string;
  try {
    text = utf8.decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
  return argumentsOf(new URLSearchParams(text));
}

/** The settings OAI-PMH answers with (§10, §12.6); `null` while it is off or has no admin e-mail. */
async function oaiSettings(rc: RouteContext): Promise<{ adminEmail: string; libraryName: string; orgCode: string | null } | null> {
  const get = <T>(key: Parameters<typeof rc.services.settings.get>[1]) => rc.services.settings.get<T>(rc.db.db, key);
  const enabled = await get<boolean>('opac.oai.enabled');
  const adminEmail = (await get<string | null>('opac.oai.adminEmail')) ?? '';
  if (enabled !== true || adminEmail.trim() === '') return null;
  return {
    adminEmail: adminEmail.trim(),
    libraryName: (await get<string | null>('library.name')) ?? '',
    orgCode: await get<string | null>('catalog.marcOrgCode'),
  };
}

function xml(c: Context<AppEnv>, result: OaiResult): Response {
  return c.body(result.xml, result.status as ContentfulStatusCode, { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': NO_STORE });
}

/**
 * The answer to an OAI-PMH request whose arguments `read` gives (null: a body that cannot be read → badArgument), or
 * the 503 text while OAI-PMH is off (in the language of `?lang=`, Indonesian by default).
 */
async function answer(rc: RouteContext, read: () => Promise<Record<string, string[]> | null>): Promise<Response> {
  const settings = await oaiSettings(rc);
  if (settings === null) {
    return textResponse(rc.c, 503, opacText(resolveLocale(rc.c.req.query('lang')), 'oai.unavailable'), NO_STORE);
  }
  const baseUrl = rc.config.baseUrl;
  const params = await read();
  if (params === null) return xml(rc.c, { status: 200, xml: oaiErrorDocument({ now: rc.now, baseUrl, request: null }, 'badArgument') });
  return xml(
    rc.c,
    await handleOai(params, {
      db: rc.db.db,
      baseUrl,
      libraryName: settings.libraryName,
      adminEmail: settings.adminEmail,
      orgCode: settings.orgCode,
      now: rc.now,
      keys: oaiTokenKeys(rc.config.keyring),
    }),
  );
}

const oaiGet = route({
  ...OAI,
  id: 'oai.get',
  method: 'GET',
  path: '/oai',
  ipLimits: ['oai'],
  handler: async (rc) => answer(rc, async () => argumentsOf(new URL(rc.c.req.url).searchParams)),
});

const oaiPost = route({
  ...OAI,
  id: 'oai.post',
  method: 'POST',
  path: '/oai',
  ipLimits: ['oai'],
  mode: 'read',
  tx: 'self',
  handler: async (rc) => answer(rc, () => formArguments(rc.c)),
});

/** OAI-PMH's two routes (GET and POST /oai). */
export const OAI_ROUTES: RouteDecl[] = [oaiGet, oaiPost];
