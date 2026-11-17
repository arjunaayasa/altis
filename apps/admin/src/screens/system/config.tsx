import {
  EmailTestBody,
  MAX_ALLOWED_ORIGINS,
  SMTP_SECURITY,
  SmtpPatchBody,
  SystemConfigPatchBody,
  type CronTokenRotateResponse,
  type EmailTestResponse,
  type EnvLockedField,
  type SystemConfigPutResponse,
  type SystemConfigView,
} from '@altis/shared/api/system-config';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CheckField, Field, NoticeAlert, ProblemAlert, RefetchProblem, RootError, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { Callout, ErrorState, FormBar, LoadingState, PageHead, StatusText, Tag } from '@/components/layout';
import { OneTimeSecretDialog } from '@/components/one-time-secret-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, applyServerErrors, hasFieldErrors, problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { holdMe } from '@/lib/sign-in';
import { SettingsSection, wholeNumberIn } from '@/screens/settings/library';

/**
 * Konfigurasi Sistem (spec §13.3, §7.6, P13, P15; decisions D17, D27, D42; super admin only: `system.config.manage`).
 *
 * - One form for config.json's `baseUrl`, `trustProxy.hops` and `allowedOrigins` and the SMTP transport, saved with
 *   `PUT system/config` (reauth). It sends only what differs from the configuration in use, and never a field an
 *   environment variable locks: such a field is disabled and names its variable (the server would refuse the PUT with
 *   CONFIG_LOCKED_BY_ENV even for the same value). The answer is the configuration now in use.
 * - The SMTP password is write-only (§7.6): the screen shows only whether one is saved, the input starts empty, and an
 *   empty input sends no `password` key, which keeps the saved one. Changing host, port or username without a new
 *   password clears it on the server, which the form says before saving; "Hapus" sends `null`.
 * - The server refuses a change that would lock the admin out at the address they use (422 INVALID_BASE_URL with the
 *   reason `origin_mismatch`, Review Focus 5): its explanation (the problem's `detail`) is shown. An accepted change of
 *   the baseUrl's scheme answers `signInAgain`: the sign-in cookies changed names (P13), so this session is gone; the
 *   screen then only says so, with a link to the sign-in page at the new address, and the cached `auth/me` is held so
 *   the shell stays up.
 * - "Kirim e-mail uji" (`POST system/config/email-test`, reauth) uses the saved settings, so it waits while the form
 *   has unsaved changes. "Ganti token cron" (`POST system/cron-token/rotate`, reauth) asks first and shows the new
 *   token once, in a dialog only its button closes and whose value is forgotten when it closes.
 */

const SYSTEM_KEY = ['system', 'config'] as const;

const SMTP_SHAPE = SmtpPatchBody.shape;
const HOPS = SystemConfigPatchBody.shape.trustProxy.unwrap().shape.hops;
const PORT = SMTP_SHAPE.port.unwrap();
const ORIGIN = SystemConfigPatchBody.shape.allowedOrigins.unwrap().element;
const URL_MAX = SystemConfigPatchBody.shape.baseUrl.unwrap().maxLength ?? 2048;
const HOST_MAX = SMTP_SHAPE.host.unwrap().unwrap().maxLength ?? 191;
const USERNAME_MAX = SMTP_SHAPE.username.unwrap().unwrap().maxLength ?? 191;
const PASSWORD_MAX = SMTP_SHAPE.password.unwrap().unwrap().maxLength ?? 512;
const FROM_MAX = SMTP_SHAPE.from.unwrap().unwrap().maxLength ?? 191;

/** The reasons of SMTP_FAILED (the SMTP stage that failed), each with its own message. */
const SMTP_REASONS = ['connect', 'tls', 'auth', 'send'] as const;

/** The non-empty, trimmed lines of a text. */
const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** `''` (left empty: none), or a text `schema` accepts; the field's error is the check that failed. */
function emptyOr(schema: z.ZodType) {
  return z
    .string()
    .trim()
    .check((ctx) => {
      if (ctx.value === '') return;
      const issue = schema.safeParse(ctx.value).error?.issues[0];
      if (issue === undefined) return;
      if (issue.code === 'too_big') ctx.issues.push({ code: 'too_big', origin: 'string', maximum: issue.maximum, inclusive: true, input: ctx.value });
      else ctx.issues.push({ code: 'invalid_format', format: 'text', input: ctx.value });
    });
}

const SystemForm = z.strictObject({
  baseUrl: z.string().trim().min(1).max(URL_MAX),
  trustProxy: z.strictObject({ hops: wholeNumberIn(HOPS) }),
  allowedOrigins: z.string().check((ctx) => {
    const list = lines(ctx.value);
    if (list.length > MAX_ALLOWED_ORIGINS || list.some((origin) => !ORIGIN.safeParse(origin).success)) {
      ctx.issues.push({ code: 'too_big', origin: 'array', maximum: MAX_ALLOWED_ORIGINS, inclusive: true, input: ctx.value });
    }
  }),
  smtp: z.strictObject({
    host: emptyOr(SMTP_SHAPE.host.unwrap().unwrap()),
    port: wholeNumberIn(PORT),
    security: z.enum(SMTP_SECURITY),
    username: z.string().max(USERNAME_MAX),
    // Never trimmed; empty keeps the saved password.
    password: z.string().max(PASSWORD_MAX),
    from: emptyOr(SMTP_SHAPE.from.unwrap().unwrap()),
  }),
  clearPassword: z.boolean(),
});

type SystemInput = z.input<typeof SystemForm>;
type SystemOutput = z.output<typeof SystemForm>;

function systemValues(view: SystemConfigView): SystemInput {
  return {
    baseUrl: view.baseUrl,
    trustProxy: { hops: view.trustProxy.hops },
    allowedOrigins: view.allowedOrigins.join('\n'),
    smtp: {
      host: view.smtp.host ?? '',
      port: view.smtp.port,
      security: view.smtp.security,
      username: view.smtp.username ?? '',
      password: '',
      from: view.smtp.from ?? '',
    },
    clearPassword: false,
  };
}

const orNull = (text: string): string | null => (text.trim() === '' ? null : text);

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The PUT body: what differs from `view`, never a locked field, and the password only when one was typed (or cleared). */
function systemBody(values: SystemOutput, view: SystemConfigView): SystemConfigPatchBody {
  const body: SystemConfigPatchBody = {};
  if (view.locked.baseUrl === undefined && values.baseUrl !== view.baseUrl) body.baseUrl = values.baseUrl;
  if (view.locked['trustProxy.hops'] === undefined && values.trustProxy.hops !== view.trustProxy.hops) {
    body.trustProxy = { hops: values.trustProxy.hops };
  }
  const origins = lines(values.allowedOrigins);
  if (!sameList(origins, view.allowedOrigins)) body.allowedOrigins = origins;
  const smtp: SmtpPatchBody = {};
  const typed = values.smtp;
  const host = orNull(typed.host);
  if (host !== view.smtp.host) smtp.host = host;
  if (typed.port !== view.smtp.port) smtp.port = typed.port;
  if (typed.security !== view.smtp.security) smtp.security = typed.security;
  const username = orNull(typed.username);
  if (username !== view.smtp.username) smtp.username = username;
  if (typed.password !== '') smtp.password = typed.password;
  else if (values.clearPassword && view.smtp.password.isSet) smtp.password = null;
  const from = orNull(typed.from);
  if (from !== view.smtp.from) smtp.from = from;
  if (Object.keys(smtp).length > 0) body.smtp = smtp;
  return body;
}

/** A failed save, test mail or rotation: the localized message, the SMTP stage that failed, and the server's explanation. */
function ConfigProblem({ error }: { error: unknown }) {
  const t = useT();
  if (error === null || error === undefined) return null;
  const e = error instanceof ApiError ? error : null;
  const text = e?.code === 'INVALID_BASE_URL' && e.reason === 'origin_mismatch' ? t('system.origin_mismatch') : problemText(t, error);
  const stage = e?.code === 'SMTP_FAILED' ? SMTP_REASONS.find((reason) => reason === e.reason) : undefined;
  // A VALIDATION_FAILED is shown at its fields; any other problem explains itself in `detail` (written to be shown),
  // unless the failed SMTP stage has a message of its own, which already says the same in the user's language.
  const detail = e !== null && e.code !== 'VALIDATION_FAILED' && stage === undefined ? e.detail : undefined;
  return (
    <Callout role="alert" tone="bad" title={text}>
      {stage === undefined && detail === undefined ? undefined : (
        <>
          {stage !== undefined && <p>{t(`system.smtp.reason.${stage}`)}</p>}
          {detail !== undefined && <p className="text-xs break-words">{detail}</p>}
        </>
      )}
    </Callout>
  );
}

/** The badge of a field an environment variable sets. */
function LockedBadge({ env }: { env: string }) {
  const t = useT();
  return (
    <Tag tone="warn">{t('system.locked', { env })}</Tag>
  );
}

/** The hint of a field: the locked notice when an environment variable sets it, else `hint`. */
function hintOf(t: Translate, locked: Partial<Record<EnvLockedField, string>>, field: EnvLockedField, hint: string): string {
  const env = locked[field];
  return env === undefined ? hint : t('system.locked_hint', { env });
}

function SystemConfigForm({ initial, onSignInAgain }: { initial: SystemConfigView; onSignInAgain(baseUrl: string): void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const passwordStatusId = useId();
  const [view, setView] = useState(initial);
  const [saved, setSaved] = useState<'saved' | 'unchanged' | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm<SystemInput, unknown, SystemOutput>({ resolver: zodResolver(SystemForm, FORM_PARSE), defaultValues: systemValues(initial) });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);

  /** `PUT system/config` with `body`; a refusal lands on the form (never thrown). */
  const save = async (body: SystemConfigPatchBody): Promise<void> => {
    try {
      const { signInAgain, ...next } = await api<SystemConfigPutResponse>('PUT', 'system/config', body);
      queryClient.setQueryData<SystemConfigView>(SYSTEM_KEY, next);
      setView(next);
      form.reset(systemValues(next));
      if (signInAgain) {
        // This session's cookies are no longer read (P13): keep the shell up while the screen says so.
        holdMe(queryClient);
        onSignInAgain(next.baseUrl);
        return;
      }
      setSaved('saved');
    } catch (e) {
      if (hasFieldErrors(e)) applyServerErrors(form, e);
      else setProblem(e);
    }
  };

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    setSaved(null);
    const body = systemBody(values, view);
    if (Object.keys(body).length === 0) {
      form.reset(systemValues(view));
      setSaved('unchanged');
      return;
    }
    await save(body);
  });

  const [host, port, username, password, clearPassword] = form.watch(['smtp.host', 'smtp.port', 'smtp.username', 'smtp.password', 'clearPassword']);
  const transportChanged =
    orNull(String(host ?? '').trim()) !== view.smtp.host ||
    Number(port) !== view.smtp.port ||
    orNull(String(username ?? '')) !== view.smtp.username;
  const passwordWillClear = view.smtp.password.isSet && password === '' && clearPassword !== true && transportChanged;
  const { locked } = view;

  return (
    <>
      <form noValidate className="flex flex-col gap-6" onSubmit={(e) => void submit(e)} onChange={() => setSaved(null)}>
        <SettingsSection title={t('system.site.title')}>
          <Field label={t('system.base_url')} hint={hintOf(t, locked, 'baseUrl', t('system.base_url_hint'))} error={errors.baseUrl}>
            {(c) => (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  {...c}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={URL_MAX}
                  className="min-w-0 flex-1"
                  {...form.register('baseUrl')}
                  disabled={locked.baseUrl !== undefined}
                />
                {locked.baseUrl !== undefined && <LockedBadge env={locked.baseUrl} />}
              </div>
            )}
          </Field>
          <Field
            label={t('system.hops')}
            hint={hintOf(t, locked, 'trustProxy.hops', t('system.hops_hint', { min: HOPS.minValue ?? 0, max: HOPS.maxValue ?? '' }))}
            error={errors.trustProxy?.hops}
          >
            {(c) => (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  {...c}
                  type="number"
                  inputMode="numeric"
                  min={HOPS.minValue ?? undefined}
                  max={HOPS.maxValue ?? undefined}
                  className="w-28"
                  {...form.register('trustProxy.hops', { valueAsNumber: true })}
                  disabled={locked['trustProxy.hops'] !== undefined}
                />
                {locked['trustProxy.hops'] !== undefined && <LockedBadge env={locked['trustProxy.hops']} />}
              </div>
            )}
          </Field>
          <Field label={t('system.origins')} hint={t('system.origins_hint', { max: MAX_ALLOWED_ORIGINS })} error={errors.allowedOrigins}>
            {(c) => (
              <textarea
                {...c}
                rows={3}
                spellCheck={false}
                placeholder="http://192.168.1.10:3000"
                className={TEXTAREA_CLASS}
                {...form.register('allowedOrigins')}
              />
            )}
          </Field>
        </SettingsSection>

        <SettingsSection title={t('system.smtp.title')} description={t('system.smtp.description')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('system.smtp.host')} error={errors.smtp?.host}>
              {(c) => <Input {...c} autoComplete="off" spellCheck={false} maxLength={HOST_MAX} {...form.register('smtp.host')} />}
            </Field>
            <Field label={t('system.smtp.port')} hint={t('system.smtp.port_hint', { min: PORT.minValue ?? 1, max: PORT.maxValue ?? '' })} error={errors.smtp?.port}>
              {(c) => (
                <Input
                  {...c}
                  type="number"
                  inputMode="numeric"
                  min={PORT.minValue ?? undefined}
                  max={PORT.maxValue ?? undefined}
                  {...form.register('smtp.port', { valueAsNumber: true })}
                />
              )}
            </Field>
            <Field label={t('system.smtp.security')} error={errors.smtp?.security}>
              {(c) => (
                <select {...c} className={SELECT_CLASS} {...form.register('smtp.security')}>
                  {SMTP_SECURITY.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`system.smtp.security.${mode}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('system.smtp.username')} error={errors.smtp?.username}>
              {(c) => <Input {...c} autoComplete="off" spellCheck={false} maxLength={USERNAME_MAX} {...form.register('smtp.username')} />}
            </Field>
            <Field label={t('system.smtp.password')} hint={t('system.smtp.password_hint')} error={errors.smtp?.password}>
              {(c) => (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    {...c}
                    aria-describedby={[passwordStatusId, c['aria-describedby']].filter(Boolean).join(' ')}
                    type="password"
                    autoComplete="new-password"
                    maxLength={PASSWORD_MAX}
                    className="min-w-0 flex-1"
                    {...form.register('smtp.password')}
                  />
                  <Tag id={passwordStatusId}>{t(view.smtp.password.isSet ? 'system.smtp.password_set' : 'system.smtp.password_unset')}</Tag>
                </div>
              )}
            </Field>
            <Field label={t('system.smtp.from')} hint={t('system.smtp.from_hint')} error={errors.smtp?.from}>
              {(c) => <Input {...c} type="email" autoComplete="off" spellCheck={false} maxLength={FROM_MAX} {...form.register('smtp.from')} />}
            </Field>
          </div>
          {view.smtp.password.isSet && (
            <CheckField label={t('system.smtp.password_clear')} disabled={password !== ''} {...form.register('clearPassword')} />
          )}
          {passwordWillClear && (
            <Callout role="status" tone="warn" title={t('system.smtp.password_will_clear')} />
          )}
        </SettingsSection>

        <RootError message={errors.root?.['server']?.message} />
        <ConfigProblem error={problem} />
        {saved === 'saved' && <NoticeAlert tone="success">{t('form.saved')}</NoticeAlert>}
        {saved === 'unchanged' && <NoticeAlert>{t('settings.unchanged')}</NoticeAlert>}
        <FormBar>
          <Button type="submit" disabled={isSubmitting}>
            {t(isSubmitting ? 'form.saving' : 'form.save')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('system.reauth_note')}</p>
          {isDirty && <StatusText tone="warn">{t('system.unsaved')}</StatusText>}
        </FormBar>
      </form>
      <EmailTest unsaved={isDirty} />
      <CronToken />
    </>
  );
}

/** "Kirim e-mail uji": one address; the saved SMTP settings send it. */
function EmailTest({ unsaved }: { unsaved: boolean }) {
  const t = useT();
  const me = useMe();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm<EmailTestBody>({
    resolver: zodResolver(EmailTestBody, FORM_PARSE),
    defaultValues: { to: me?.authenticated === true ? (me.user.email ?? '') : '' },
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    setSentTo(null);
    try {
      await api<EmailTestResponse>('POST', 'system/config/email-test', values);
      setSentTo(values.to);
    } catch (e) {
      if (hasFieldErrors(e)) applyServerErrors(form, e);
      else setProblem(e);
    }
  });

  return (
    <SettingsSection title={t('system.email_test.title')} description={t('system.email_test.description')}>
      <form noValidate className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('system.email_test.to')} error={errors.to} className="min-w-0 flex-1 basis-64">
            {(c) => <Input {...c} type="email" autoComplete="email" spellCheck={false} {...form.register('to')} />}
          </Field>
          <Button type="submit" variant="outline" disabled={isSubmitting || unsaved}>
            {t(isSubmitting ? 'form.working' : 'system.email_test.submit')}
          </Button>
        </div>
        {unsaved && <p className="text-xs text-muted-foreground">{t('system.email_test.save_first')}</p>}
        <ConfigProblem error={problem} />
        {sentTo !== null && <NoticeAlert tone="success">{t('system.email_test.sent', { to: sentTo })}</NoticeAlert>}
      </form>
    </SettingsSection>
  );
}

/**
 * "Ganti token cron": asks first, then shows the new token once (OneTimeSecretDialog). From the question on, the
 * page counts as a form being filled: the answer that carries the token may be the first to come from a newer
 * release, and reloading then would lose a token whose predecessor is already invalid.
 */
function CronToken() {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  // Answered while the confirmation is still open, shown once it has closed (one modal at a time; "Selesai" then
  // returns the focus to "Ganti token cron"). A ref, so that the closing confirmation still finds it.
  const answered = useRef<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  useDirtyGuard(confirming || revealing);

  const rotate = async (): Promise<void> => {
    const answer = await api<CronTokenRotateResponse>('POST', 'system/cron-token/rotate');
    answered.current = answer.cronToken;
    setRevealing(true);
  };

  const reveal = (): void => {
    if (answered.current !== null) setToken(answered.current);
    answered.current = null;
    setRevealing(false);
  };

  return (
    <SettingsSection title={t('system.cron.title')} description={t('system.cron.description')}>
      <div>
        <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
          {t('system.cron.rotate')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        destructive
        title={t('system.cron.confirm_title')}
        description={t('system.cron.confirm_body')}
        confirmLabel={t('system.cron.rotate')}
        onConfirm={rotate}
        onClose={() => setConfirming(false)}
        onClosed={reveal}
      />
      <OneTimeSecretDialog
        value={token}
        title={t('system.cron.new_title')}
        description={t('system.cron.new_body')}
        valueClassName="text-sm"
        onClose={() => setToken(null)}
      />
    </SettingsSection>
  );
}

/** After a change of the baseUrl's scheme: the only thing left to do is to sign in again at the new address. */
function SignInAgain({ baseUrl }: { baseUrl: string }) {
  const t = useT();
  const href = `${baseUrl}/admin/login`;
  return (
    <Callout title={t('system.sign_in_again.title')}>
      <p>{t('system.sign_in_again.body')}</p>
      <a href={href} className="mt-1 inline-block max-w-full font-semibold break-all text-accent-text underline underline-offset-4">
        {t('system.sign_in_again.link', { url: baseUrl })}
      </a>
    </Callout>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div className="grid max-w-5xl gap-6">
      <PageHead title={t('nav.system')} intro={t('system.description')} />
      {children}
    </div>
  );
}

/** `/admin/system`. */
export function SystemConfigScreen() {
  const me = useMe();
  const allowed = holds(me, 'system.config.manage');
  const [signInAgain, setSignInAgain] = useState<string | null>(null);
  // Not refetched on its own: after a scheme change this session is gone, and a read would only answer 401.
  const config = useApiQuery<SystemConfigView>({
    queryKey: [...SYSTEM_KEY],
    path: 'system/config',
    enabled: allowed && signInAgain === null,
    refetchOnWindowFocus: false,
  });

  let content: ReactNode;
  if (signInAgain !== null) {
    content = <SignInAgain baseUrl={signInAgain} />;
  } else if (!allowed) {
    // The server would refuse (and record the refusal): say so without asking.
    content = <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />;
  } else if (config.data !== undefined) {
    // The data wins over an error: a failed background refetch keeps the form and what was typed.
    content = (
      <>
        <RefetchProblem query={config} />
        <SystemConfigForm initial={config.data} onSignInAgain={setSignInAgain} />
      </>
    );
  } else if (config.isError) {
    content = <ErrorState error={config.error} onRetry={() => void config.refetch()} retrying={config.isFetching} />;
  } else {
    content = <LoadingState />;
  }
  return <Frame>{content}</Frame>;
}
