import { MESSAGES, t, type ErrorCode, type Locale, type MessageKey } from '@altis/shared';
import { opCliLines, type OpView } from '@altis/shared/api/ops';
import { PRECHECK_FAILURE_VIEWS, type UpdateStatusView } from '@altis/shared/api/updates';
import { raw } from 'hono/html';
import type { PropsWithChildren } from 'hono/jsx';
import type { HtmlEscapedString } from 'hono/utils/html';
import { NO_ICON, toDocument } from '../opac/layout.js';
import { UPDATE_PAGE_SCRIPT } from './update-script.js';

// The operations page `/admin/_update` (spec §9.4, §7.4; plan Task 19): a self-contained server page (hono/jsx) that
// follows the current exclusive op and, in `external` mode, drives it. It loads nothing: its style and script are
// inline under the response's CSP nonce, so it also works while a restore has closed every other route (the SPA and
// its assets included). Its texts are messages (`ops.*`) or values JSX escapes; what the script needs comes as two
// JSON blocks (`#i18n`: the `ops.kind.*`, `ops.state.*`, `ops.page.*` texts of the page's language and the `error.*`
// texts of {@link UPDATE_PAGE_ERROR_CODES}; `#state`: the op, the CSRF tokens, whether a session holds the page and
// whether its user has 2FA). The server renders the op as it is now, the script (ops/update-script.ts) keeps it current.
//
// Cancel and takeover (ruling R1c-9): a page a full session holds offers both as buttons, and re-authenticates on the
// page itself (the `#reauth` form: the password, plus the authenticator code with 2FA, posted to `auth/reauth` with the
// session's CSRF token) before repeating the action; the admin itself may be closed meanwhile. A page held by the
// op's cookie alone offers a sign-in link that comes back here instead (outside a restore: sign-in is closed during
// one, so only a session that was already open can cancel or take over a restore).
//
// Also the 401 page `/admin/_update` answers while nobody can sign in (a restore, `ops_wait`, an update moving the
// schema in `updating`) to a browser with neither the op's cookie nor a session (api/ops.ts updatePageRefusal):
// bilingual, since nothing tells the language of a stranger.
//
// 1d Task 29 (spec §9.6, §9.7, §9.8; preflight 1D-27): for an update op, the label `ops.page.db_restore_needed` while
// its prechecks found the running release below the target's `minCodeVersionAfter` (`OpView.update.dbRestoreNeeded`),
// the `ops.page.schema_hold` instruction naming the backup for a failed schemaHold update (`UPDATE_SCHEMA_HOLD_FAILED`),
// and the CLI lines of a failed revert (`release:rollback` among them, opCliLines). While no op runs, a newer bundled
// release whose prechecks failed (`bundledBlocked`, as `GET updates/status` answers it), each failure named by
// `update.precheck.<failure>`. `#state` also says whether the script may follow `system.update` over SSE (`sse`).

/** The path of the page (route `ops.update_page`, mounted before admin.index's `/admin/*`, M3). */
export const OPS_PAGE_PATH = '/admin/_update';

/**
 * The sign-in that comes back to the page (a page without a session, and the 302 of api/ops.ts updatePageRefusal): the
 * SPA loads the page again once signed in (its `/admin/_update` route). Open during a normal maintenance (R1c-9).
 */
export const OPS_SIGN_IN_HREF = `/admin/login?next=${OPS_PAGE_PATH}`;

/**
 * The error codes whose `error.<CODE>` texts the page carries: what its own requests (cancel, takeover, auth/reauth)
 * may be refused with, the session having ended meanwhile included (`OPS_AUTH_REQUIRED`, and `AUTH_REAUTH_REQUIRED`
 * on a page without the reauth form). Any other code shows as itself after "Kesalahan".
 */
export const UPDATE_PAGE_ERROR_CODES: readonly ErrorCode[] = Object.freeze([
  'AUTH_REQUIRED',
  'AUTH_REAUTH_REQUIRED',
  'OPS_AUTH_REQUIRED',
  'AUTH_MFA_INVALID',
  'AUTH_TOO_MANY_ATTEMPTS',
  'AUTH_BUSY',
  'AUTHZ_DENIED',
  'CSRF_INVALID',
  'VALIDATION_FAILED',
  'OPS_NONE',
  'OPS_POINT_OF_NO_RETURN',
]);

/** The download of the op's report (route `ops.report`). */
const REPORT_HREF = '/api/v1/ops/report';

/** The page's own style: no font or image from anywhere, light and dark. */
const PAGE_CSS = [
  ':root{color-scheme:light dark;--bg:#f5f7fa;--fg:#1c2430;--muted:#566173;--card:#fff;--border:#d6dce5;',
  '--accent:#0f766e;--accent-fg:#fff;--danger:#b42318}',
  '@media (prefers-color-scheme:dark){:root{--bg:#0e131a;--fg:#e5e9ef;--muted:#9ba5b4;--card:#161d26;',
  '--border:#2b3542;--accent:#2dd4bf;--accent-fg:#052420;--danger:#f97066}}',
  '*{box-sizing:border-box}',
  'body{margin:0;min-height:100vh;padding:1.5rem 1rem;background:var(--bg);color:var(--fg);',
  'font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
  'main{max-width:40rem;margin:0 auto;background:var(--card);border:1px solid var(--border);border-radius:.75rem;',
  'padding:1.5rem}',
  'h1{font-size:1.375rem;line-height:1.3;margin:0 0 1rem}h2{font-size:1.125rem;line-height:1.3;margin:1.5rem 0 .5rem}',
  'dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:0 0 1rem}',
  'dt{color:var(--muted)}dd{margin:0;font-weight:600}',
  '.progress{display:flex;align-items:center;gap:.75rem}',
  'progress{flex:1;height:.75rem;accent-color:var(--accent)}',
  '.actions{display:flex;flex-wrap:wrap;gap:.5rem;margin:1.25rem 0 0}',
  '.button{font:inherit;display:inline-block;padding:.5rem 1rem;border-radius:.5rem;border:1px solid var(--border);',
  'background:var(--card);color:var(--fg);text-decoration:none;cursor:pointer}',
  '.button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
  '.button[disabled]{opacity:.6;cursor:default}',
  '.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}',
  '.danger,.error{color:var(--danger)}',
  '.muted{color:var(--muted);font-size:.875rem}',
  'pre{overflow-x:auto;background:var(--bg);border:1px solid var(--border);border-radius:.5rem;padding:.75rem;margin:.5rem 0 0}',
  'hr{border:0;border-top:1px solid var(--border);margin:1.5rem 0}',
  '.reauth{margin:1.25rem 0 0;padding:1rem;border:1px solid var(--border);border-radius:.5rem}.reauth h2{margin-top:0}',
  '.field{display:grid;gap:.25rem;margin:.75rem 0 0}label{font-weight:600}',
  'input{font:inherit;width:100%;max-width:20rem;padding:.5rem .75rem;border:1px solid var(--border);border-radius:.5rem;',
  'background:var(--bg);color:var(--fg)}input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}',
  '[hidden]{display:none!important}',
].join('');

/**
 * Text for an inline `<script>` or `<style>` element, as JSX must not escape it. Only the page's own constants and
 * {@link scriptJson} output come here, and none can close its element.
 *
 * @throws TypeError for a text holding `</script`, `</style` or `<!--`
 */
function inlineText(text: string): HtmlEscapedString {
  if (/<\/(?:script|style)|<!--/i.test(text)) throw new TypeError('update page: inline text must not close its element');
  return raw(text);
}

/** `value` as JSON for a `<script type="application/json">` block: `<`, `>`, `&` and the line separators escaped. */
function scriptJson(value: unknown): HtmlEscapedString {
  const json = JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return inlineText(json);
}

/**
 * The texts the page script reads: every `ops.kind.*`, `ops.state.*` and `ops.page.*` message of `locale`, the
 * `error.<CODE>` text of each of {@link UPDATE_PAGE_ERROR_CODES}, and (1d Task 29) `update.precheck.<failure>` of
 * every precheck failure.
 */
export function updatePageTexts(locale: Locale): Record<string, string> {
  const table = MESSAGES[locale];
  const texts: Record<string, string> = {};
  for (const key of Object.keys(table) as MessageKey[]) {
    if (/^ops\.(?:kind|state|page)\./.test(key)) texts[key] = table[key];
  }
  for (const code of UPDATE_PAGE_ERROR_CODES) texts[`error.${code}`] = t(locale, `error.${code}` as MessageKey);
  for (const failure of PRECHECK_FAILURE_VIEWS) texts[`update.precheck.${failure}`] = t(locale, `update.precheck.${failure}`);
  return texts;
}

/** Whether the page shows the CLI way out (`opCliLines`, shared with Diagnostik; final review OPS-ATTN-EXIT). */
export function showsCli(op: OpView | null): boolean {
  return opCliLines(op).length > 0;
}

/** 1d Task 29: the error of a failed schemaHold update (§9.8 row 3): the page names the backup to restore. */
const SCHEMA_HOLD_FAILED = 'UPDATE_SCHEMA_HOLD_FAILED';

/** 1d Task 29: the schemaHold instruction is shown: the op failed with UPDATE_SCHEMA_HOLD_FAILED and names its backup. */
function showsSchemaHold(op: OpView | null): op is OpView & { backupId: string } {
  return op !== null && op.error?.code === SCHEMA_HOLD_FAILED && op.backupId !== null;
}

/** 1d Task 29: a precheck failure's name (`update.precheck.<failure>`), or the word itself for one this release lacks. */
function failureText(locale: Locale, failure: string): string {
  const key = `update.precheck.${failure}`;
  return Object.hasOwn(MESSAGES[locale], key) ? t(locale, key as MessageKey) : failure;
}

/** The progress as a whole percentage, 0 to 100. */
function percentOf(op: OpView): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(op.progress) ? op.progress : 0)));
}

function Frame(props: PropsWithChildren<{ locale: Locale; nonce: string; title: string }>) {
  return (
    <html lang={props.locale}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="robots" content="noindex" />
        <title>{props.title}</title>
        <link rel="icon" href={NO_ICON} />
        <style nonce={props.nonce}>{inlineText(PAGE_CSS)}</style>
      </head>
      <body>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

export interface UpdatePageOptions {
  locale: Locale;
  /** The nonce of the response's Content-Security-Policy. */
  nonce: string;
  /** The current op, or null for none. */
  op: OpView | null;
  /** The page's `X-CSRF-Token` for `ops/drive|cancel`: the op's (`altis_ops`) or the session's; null without either. */
  csrfToken: string | null;
  /**
   * A full session holds the page (default false): cancel and takeover are buttons then, and a reauth they need is
   * asked on the page (R1c-9). Without one, cancel is a link to {@link OPS_SIGN_IN_HREF} (hidden during a restore).
   */
  session?: boolean;
  /** The session's CSRF token, for `auth/reauth` (null or absent without a session). */
  sessionCsrfToken?: string | null;
  /** The session's user has 2FA: the reauth form asks for the authenticator code too (default false). */
  totp?: boolean;
  /** 1d Task 29: the script may follow `system.update` over SSE (a session that reads it, SSE on); default false. */
  sse?: boolean;
  /** 1d Task 29: while no op runs, a newer bundled release whose prechecks failed (§9.8 row 2); default null. */
  bundledBlocked?: UpdateStatusView['bundledBlocked'];
}

/** The operations page (see the top of this file), as a whole document. */
export function renderUpdatePage(o: UpdatePageOptions): string {
  const { locale, nonce, op } = o;
  const session = o.session === true;
  const tr = (key: MessageKey): string => t(locale, key);
  const percent = op === null ? 0 : percentOf(op);
  const error = op?.error ? `${op.error.code}${op.error.detail === undefined ? '' : ` (${op.error.detail})`}` : '';
  const cancellable = op !== null && !op.terminal && !op.pointOfNoReturn;
  // A session takes the op over when the page does not hold its cookie (a restore past its PONR reads no session).
  const takeoverable = op !== null && !op.terminal && op.csrfToken === null && !(op.kind === 'restore' && op.pointOfNoReturn);
  const totp = session && o.totp === true;
  // 1d Task 29
  const dbRestore = op?.update?.dbRestoreNeeded === true;
  const schemaHold = showsSchemaHold(op) ? t(locale, 'ops.page.schema_hold', { backupId: op.backupId }) : '';
  const blocked = op === null || op.terminal ? (o.bundledBlocked ?? null) : null;
  return toDocument(
    <Frame locale={locale} nonce={nonce} title={`${tr('ops.page.title')} · ALTIS`}>
      <h1>{tr('ops.page.title')}</h1>
      <section id="op" aria-live="polite" hidden={op === null}>
        <dl>
          <dt>{tr('ops.page.kind')}</dt>
          <dd id="op-kind">{op?.kind ? t(locale, `ops.kind.${op.kind}`) : '-'}</dd>
          <dt>{tr('ops.page.state')}</dt>
          <dd id="op-state">{op === null ? '' : opStateText(locale, op.state)}</dd>
        </dl>
        <div class="progress">
          <progress id="op-progress" max="100" value={String(percent)} aria-label={tr('ops.page.progress')} />
          <span id="op-percent">{`${percent}%`}</span>
        </div>
        <p id="op-message" class="muted" hidden={!op?.message}>
          {op?.message ?? ''}
        </p>
        <p id="db-restore" class="muted" hidden={!dbRestore}>
          {tr('ops.page.db_restore_needed')}
        </p>
        <p id="op-error" class="error" role="alert" hidden={error === ''}>
          {`${tr('ops.page.error')}: `}
          <span id="op-error-text">{error}</span>
        </p>
        <p id="schema-hold" class="error" hidden={schemaHold === ''}>
          {schemaHold}
        </p>
      </section>
      <p id="op-none" hidden={op !== null}>
        {tr('ops.page.none')}
      </p>
      <section id="bundled" hidden={blocked === null}>
        <p id="bundled-text">{blocked === null ? '' : t(locale, 'ops.page.bundled_blocked', { version: blocked.version })}</p>
        <ul id="bundled-failures">
          {(blocked?.failures ?? []).map((failure) => (
            <li>{failureText(locale, failure)}</li>
          ))}
        </ul>
      </section>
      <p id="drive-hint" class="muted" hidden={!(op !== null && op.mode === 'external' && op.driveable)}>
        {tr('ops.page.drive_hint')}
      </p>
      <p id="done" role="status" hidden={op?.state !== 'done'}>
        {tr('ops.page.done')}
      </p>
      <p id="status" class="error" role="status" hidden></p>
      <div class="actions">
        <button type="button" id="resume" class="button primary" hidden={!(op !== null && op.needsAttention && op.startedAt !== null)}>
          {tr('ops.page.resume')}
        </button>
        {session ? (
          <button type="button" id="cancel" class="button danger" hidden={!cancellable}>
            {tr('ops.page.cancel')}
          </button>
        ) : (
          <a id="cancel" class="button" href={OPS_SIGN_IN_HREF} hidden={!(cancellable && op.kind !== 'restore')}>
            {tr('ops.page.sign_in')}
          </a>
        )}
        {session ? (
          <button type="button" id="takeover" class="button" hidden={!takeoverable}>
            {tr('ops.page.takeover')}
          </button>
        ) : null}
        <a id="report" class="button" href={REPORT_HREF} download hidden>
          {tr('ops.page.report')}
        </a>
        <a id="back" class="button" href="/admin" hidden={!(op === null || op.terminal)}>
          {tr('ops.page.back')}
        </a>
      </div>
      {session ? (
        <form id="reauth" class="reauth" hidden novalidate aria-labelledby="reauth-title">
          <h2 id="reauth-title">{tr('ops.page.reauth.title')}</h2>
          <p class="muted">{tr('ops.page.reauth.body')}</p>
          <div class="field">
            <label for="reauth-password">{tr('ops.page.reauth.password')}</label>
            <input id="reauth-password" name="password" type="password" autocomplete="current-password" aria-describedby="reauth-error" />
          </div>
          {totp ? (
            <div class="field" id="reauth-code-field">
              <label for="reauth-code">{tr('ops.page.reauth.code')}</label>
              <input
                id="reauth-code"
                name="code"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength={6}
                aria-describedby="reauth-error"
              />
            </div>
          ) : null}
          <p id="reauth-error" class="error" role="alert" hidden></p>
          <div class="actions">
            <button type="submit" id="reauth-submit" class="button primary">
              {tr('ops.page.reauth.submit')}
            </button>
            <button type="button" id="reauth-dismiss" class="button">
              {tr('ops.page.reauth.dismiss')}
            </button>
          </div>
        </form>
      ) : null}
      <section id="cli" hidden={!showsCli(op)}>
        <p>{tr('ops.page.cli_steps')}</p>
        <pre>
          <code id="cli-lines">{opCliLines(op).join('\n')}</code>
        </pre>
      </section>
      <noscript>
        <p class="error">{tr('ops.page.no_script')}</p>
      </noscript>
      <p class="muted">{tr('ops.page.cli_hint')}</p>
      <script type="application/json" id="i18n" nonce={nonce}>
        {scriptJson(updatePageTexts(locale))}
      </script>
      <script type="application/json" id="state" nonce={nonce}>
        {scriptJson({
          op,
          csrfToken: o.csrfToken,
          session,
          sessionCsrfToken: session ? (o.sessionCsrfToken ?? null) : null,
          totp,
          sse: session && o.sse === true,
          bundledBlocked: o.bundledBlocked ?? null,
        })}
      </script>
      <script nonce={nonce}>{inlineText(UPDATE_PAGE_SCRIPT)}</script>
    </Frame>,
  );
}

/** The label of `state` (`ops.state.<state>`), or the state itself for one this release does not name. */
function opStateText(locale: Locale, state: string): string {
  const key = `ops.state.${state}`;
  return Object.hasOwn(MESSAGES[locale], key) ? t(locale, key as MessageKey) : state;
}

/**
 * The 401 page of `/admin/_update` while nobody can sign in (a restore, a process waiting for an op, and 1d review C16
 * an update that moves the schema in phase `updating`) for a browser with neither the op's `altis_ops` cookie nor a
 * session that may still be read: the op can be followed only from the browser that started or took it over, and
 * from the server (its log, `ops:resume`). In Indonesian and English, one after the other.
 */
export function renderOpsBrowserOnly(o: { nonce: string }): string {
  const title = 'ops.page.browser_only.title' as const;
  const body = 'ops.page.browser_only.body' as const;
  return toDocument(
    <Frame locale="id" nonce={o.nonce} title={`${t('id', title)} · ALTIS`}>
      <section lang="id">
        <h1>{t('id', title)}</h1>
        <p>{t('id', body)}</p>
      </section>
      <hr />
      <section lang="en">
        <h2>{t('en', title)}</h2>
        <p>{t('en', body)}</p>
      </section>
    </Frame>,
  );
}
