import { ERROR_CODES } from '@altis/shared';
import type { OpStatusView } from '@altis/shared/api/ops';
import {
  UPDATE_CHANNELS,
  type ChannelBody,
  type ChannelResponse,
  type UpdateApplyBody,
  type UpdateChannel,
  type UpdateCheckResponse,
  type UpdateOpResponse,
  type UpdatesView,
} from '@altis/shared/api/updates';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useDateTime } from '@/components/data-table';
import { Field, Notice, ProblemAlert, RefetchProblem, SELECT_CLASS } from '@/components/form-field';
import { Callout, ErrorState, LoadingState, PageHead } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useT, type AdminKey, type TKey, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, OPS_PAGE_PATH, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { page } from '@/lib/page';
import { invalidateRealtimeKeys, useRealtime } from '@/lib/realtime';
import { SettingsSection } from '@/screens/settings/library';
import { UPDATES_HISTORY_KEY, UpdateHistory } from './history';
import { PackageUploadPanel, PrecheckList, RefusalAlert, failureText, useReleaseDay } from './upload';

/**
 * Pembaruan (spec §13.3 "Versi, cek, catatan perubahan, Perbarui, `/admin/_update`, riwayat, kembali ke versi
 * sebelumnya, unggah paket, kanal"; §9.6-9.8; routes `updates.*` of Task 28; 1d Task 30), `/admin/updates` for a
 * holder of `system.update.read`:
 *
 * - **Notices**: a running update or rollback op (its state and progress, with the operations page `/admin/_update`
 *   for a holder of `system.update.run`, whom alone the page opens for: 1d review L13), one that needs attention or
 *   ended badly within the hour; a newer bundled release whose prechecks failed (§9.8 row
 *   2); the version a manual rollback pinned (§9.7).
 * - **Versi terpasang**: the running release and app.js (`current`), and the channel (`stable`/`beta`): a select for a
 *   holder of `system.update.run` (`PUT updates/channel`), the channel's name for anyone else.
 * - **Rilis terbaru**: the last update check (when, or why it failed) and "Periksa pembaruan" (`POST updates/check`, at
 *   most once a minute: a 429 says how long to wait); without a feed URL (`onlineCheck: false`) a line saying online
 *   checks are not set up, and no button (updates come by upload); the release it found with its release notes (an
 *   http(s) link only) and its prechecks (upload.tsx PrecheckList); **Perbarui ke <v>** for a holder of
 *   `system.update.run` while one-click updates are offered: enabled only when every precheck passed and no update or
 *   rollback op runs; the click sends `POST updates/apply {version}` (the server asks for the password first,
 *   AUTH_REAUTH_REQUIRED, and the API client opens the reauth dialog, §9.6 step 3), then loads the operations page,
 *   which follows and drives the op with the `altis_ops` cookie the answer set. In image mode (`oneClick: false`) there
 *   is no Perbarui; wherever `dockerPull` is set (image mode or the Docker runtime) the
 *   `docker compose pull && docker compose up -d` line shows.
 * - **Unggah paket pembaruan** (upload.tsx), for a holder of `system.update.run` while one-click updates are offered.
 * - **Kembali ke versi sebelumnya** (§9.7), for a holder of `system.update.run`: disabled with the explanation of
 *   `rollback.reason` when it cannot run (`no_previous`, `incompatible`, `missing`, `pending`, `image`); otherwise a
 *   confirmation, then `POST updates/rollback` (reauth), then the operations page.
 * - **Riwayat** (history.tsx).
 *
 * The screen reads `GET updates` again on every `system.update` hint (`update.checked` when a check ends, `op.progress`
 * of an update or rollback op), and the history on every hint that is not progress. The menus only hide: the server
 * refuses whatever they hide.
 */

/** The React Query key of `GET updates`. */
export const UPDATES_KEY = ['updates'] as const;

/** What a Docker installation runs on the server to update (§9.8). */
export const DOCKER_PULL = 'docker compose pull && docker compose up -d';

/** The reasons of `rollback.reason` (core's RollbackUnavailableReason, plus `image`), each with its explanation. */
const ROLLBACK_REASONS: Readonly<Record<string, AdminKey>> = Object.freeze({
  no_previous: 'updates.rollback.reason.no_previous',
  incompatible: 'updates.rollback.reason.incompatible',
  missing: 'updates.rollback.reason.missing',
  pending: 'updates.rollback.reason.pending',
  image: 'updates.rollback.reason.image',
});

const CHANNEL_LABEL: Readonly<Record<UpdateChannel, AdminKey>> = Object.freeze({
  stable: 'updates.channel.stable',
  beta: 'updates.channel.beta',
});

const own = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);

/** The message of a registered error code, else the generic server error (a code this build does not know). */
function errorText(t: Translate, code: string): string {
  return own(ERROR_CODES, code) ? t(`error.${code}` as TKey) : t('error.INTERNAL');
}

/** An http(s) URL as given, else null: a release-notes link never runs script (a signed feed names it, all the same). */
function webUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** An update or rollback op that has not ended: nothing else can be installed or rolled back now. */
const isLive = (op: OpStatusView | null): boolean => op !== null && !op.terminal;

/** The kind and state of `op` in words (the shared `ops.kind.*`, `ops.state.*`). */
function opWords(t: Translate, op: OpStatusView): { kind: string; state: string } {
  return { kind: t(`ops.kind.${op.kind ?? 'update'}`), state: t(`ops.state.${op.state}` as TKey) };
}

/** "Buka halaman operasi": the server's page, loaded as a page (never through the router). */
function OpsPageLink() {
  const t = useT();
  return (
    <Button asChild variant="outline" size="sm" className="w-fit bg-background">
      <a href={OPS_PAGE_PATH}>{t('updates.op.open')}</a>
    </Button>
  );
}

/**
 * Where an op that has not ended is followed: the operations page for a viewer holding the permission of its kind
 * (`canFollow`: system.update.run for an update or a rollback, OP_KIND_PERMISSION), else who can follow it (1d review
 * L13, ruling R1c-9: the page would refuse anyone else with 403 AUTHZ_DENIED).
 */
function OpsPageWay({ canFollow }: { canFollow: boolean }) {
  const t = useT();
  return canFollow ? <OpsPageLink /> : <p>{t('updates.op.page_run_only')}</p>;
}

/** The update or rollback op of the view, unless it ended well. */
function OpNotice({ op, canFollow }: { op: OpStatusView | null; canFollow: boolean }) {
  const t = useT();
  if (op === null || (op.terminal && op.state === 'done')) return null;
  const words = opWords(t, op);
  if (!op.terminal && !op.needsAttention) {
    return (
      <Callout role="status" title={t('updates.op.running', { kind: words.kind, state: words.state, progress: Math.round(op.progress) })}>
        <OpsPageWay canFollow={canFollow} />
      </Callout>
    );
  }
  return (
    <Callout tone="warn" title={op.needsAttention ? t('updates.op.attention', { kind: words.kind }) : t('updates.op.ended', { kind: words.kind, state: words.state })}>
      {op.error === null && !op.needsAttention ? undefined : (
        <>
          {op.error !== null && <p>{errorText(t, op.error.code)}</p>}
          {op.needsAttention && <OpsPageWay canFollow={canFollow} />}
        </>
      )}
    </Callout>
  );
}

/** A newer bundled release whose prechecks failed (§9.8 row 2), and the version a manual rollback pinned (§9.7). */
function ReleaseNotices({ view }: { view: UpdatesView }) {
  const t = useT();
  return (
    <>
      {view.bundledBlocked !== null && (
        <Callout tone="warn" title={t('updates.bundled_blocked', { version: view.bundledBlocked.version })}>
          <ul className="list-disc pl-5">
            {view.bundledBlocked.failures.map((failure) => (
              <li key={failure}>{failureText(t, failure)}</li>
            ))}
          </ul>
        </Callout>
      )}
      {view.pinned !== null && (
        <Callout role="status" title={t('updates.pinned', { version: view.pinned })} />
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[12rem_1fr] sm:gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

/** The channel select of a holder of `system.update.run`: `PUT updates/channel`, then the view read again. */
function ChannelForm({ channel, onChanged }: { channel: UpdateChannel; onChanged(): void }) {
  const t = useT();
  const [chosen, setChosen] = useState<UpdateChannel>(channel);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => setChosen(channel), [channel]);

  const save = async (): Promise<void> => {
    if (busy || chosen === channel) return;
    setBusy(true);
    setOutcome(null);
    try {
      const body: ChannelBody = { channel: chosen };
      const saved = await api<ChannelResponse>('PUT', 'updates/channel', body);
      setOutcome({ kind: 'success', text: t('updates.channel.done', { channel: t(CHANNEL_LABEL[saved.channel]) }) });
      onChanged();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'MAINTENANCE')) setOutcome({ kind: 'error', text: problemText(t, e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('updates.channel')} hint={t('updates.channel.hint')} className="max-w-md min-w-48 flex-1">
          {(c) => (
            <select {...c} className={SELECT_CLASS} value={chosen} disabled={busy} onChange={(e) => setChosen(e.target.value as UpdateChannel)}>
              {UPDATE_CHANNELS.map((value) => (
                <option key={value} value={value}>
                  {t(CHANNEL_LABEL[value])}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <div>
        <Button type="button" variant="outline" disabled={busy || chosen === channel} onClick={() => void save()}>
          {t('updates.channel.save')}
        </Button>
      </div>
      {outcome !== null && <Notice kind={outcome.kind}>{outcome.text}</Notice>}
    </div>
  );
}

/** "Versi terpasang": the running release, app.js, and the channel. */
function CurrentSection({ view, canRun, onChanged }: { view: UpdatesView; canRun: boolean; onChanged(): void }) {
  const t = useT();
  return (
    <SettingsSection title={t('updates.current.title')}>
      <dl className="flex flex-col gap-3">
        <Row label={t('updates.current.version')}>
          <span translate="no" className="font-mono">
            {view.current.version}
          </span>
        </Row>
        <Row label={t('updates.current.app_js')}>
          {view.current.appJs === null ? (
            t('updates.current.unknown')
          ) : (
            <span translate="no" className="font-mono">
              {view.current.appJs}
            </span>
          )}
        </Row>
        {!canRun && <Row label={t('updates.channel')}>{t(CHANNEL_LABEL[view.channel])}</Row>}
      </dl>
      {canRun && <ChannelForm channel={view.channel} onChanged={onChanged} />}
    </SettingsSection>
  );
}

/** The `docker compose pull && docker compose up -d` path (§9.8): the only one in image mode, else another one. */
function DockerPull({ only }: { only: boolean }) {
  const t = useT();
  return (
    <div className="grid gap-2 text-sm">
      <p>{t(only ? 'updates.docker.image' : 'updates.docker.also')}</p>
      <pre className="overflow-x-auto rounded-md border bg-layer px-3 py-2 text-xs">
        <code translate="no">{DOCKER_PULL}</code>
      </pre>
    </div>
  );
}

/** When the last check ran and how it went, that one is under way, or that no online check is set up. */
function CheckStatus({ view, checking }: { view: UpdatesView; checking: boolean }) {
  const t = useT();
  const dateTime = useDateTime();
  const { check } = view;
  let text: string;
  if (!view.onlineCheck) text = t('updates.check.offline');
  else if (checking) text = t('updates.check.running');
  else if (check === null) text = t('updates.check.never');
  else if (!check.ok) text = t('updates.check.failed', { time: dateTime(check.at), reason: errorText(t, check.error ?? 'INTERNAL') });
  else text = t('updates.check.last', { time: dateTime(check.at) });
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {text}
    </p>
  );
}

/**
 * "Rilis terbaru": the check, the release it found with its notes and prechecks, Perbarui, the Docker path.
 * `onRead` reads the view again.
 */
function ReleaseSection({ view, canRun, onRead }: { view: UpdatesView; canRun: boolean; onRead(): void }) {
  const t = useT();
  const day = useReleaseDay();
  const precheckId = useId();
  const hintId = useId();
  /** The `check.at` the view showed when "Periksa pembaruan" was clicked: the check is under way until it moves. */
  const [checkingFrom, setCheckingFrom] = useState<{ at: number | null } | null>(null);
  const [checkProblem, setCheckProblem] = useState<unknown>(null);
  const [checkBusy, setCheckBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyProblem, setApplyProblem] = useState<unknown>(null);

  const at = view.check?.at ?? null;
  useEffect(() => {
    if (checkingFrom !== null && checkingFrom.at !== at) setCheckingFrom(null);
  }, [checkingFrom, at]);

  const check = async (): Promise<void> => {
    if (checkBusy) return;
    setCheckBusy(true);
    setCheckProblem(null);
    try {
      await api<UpdateCheckResponse>('POST', 'updates/check');
      setCheckingFrom({ at });
      // Where no worker runs, the request itself ran the check: its result is there to read already. Elsewhere the
      // `update.checked` hint brings it.
      onRead();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'MAINTENANCE')) setCheckProblem(e);
    } finally {
      setCheckBusy(false);
    }
  };

  const { available, precheck } = view;

  const apply = async (): Promise<void> => {
    if (applying || available === null) return;
    setApplying(true);
    setApplyProblem(null);
    try {
      const body: UpdateApplyBody = { version: available.version };
      await api<UpdateOpResponse>('POST', 'updates/apply', body);
      // The operations page follows (and, where no worker runs, drives) the op: the page goes there and stays busy.
      page.assign(OPS_PAGE_PATH);
      return;
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'MAINTENANCE')) setApplyProblem(e);
      // The prechecks, the edition's entitlement or the op may have changed since the view was read.
      onRead();
    }
    setApplying(false);
  };

  const notes = available === null ? null : webUrl(available.notesUrl);
  const offerApply = canRun && view.oneClick && available !== null;
  const applyEnabled = precheck !== null && precheck.ok && !isLive(view.op) && !applying;

  return (
    <SettingsSection title={t('updates.check.title')}>
      <div className="flex flex-col gap-2">
        <CheckStatus view={view} checking={checkingFrom !== null} />
        {view.onlineCheck && (
          <div>
            <Button type="button" variant="outline" disabled={checkBusy} onClick={() => void check()}>
              {t('updates.check.action')}
            </Button>
          </div>
        )}
        {checkProblem !== null && <ProblemAlert error={checkProblem} />}
      </div>

      {available === null ? (
        view.onlineCheck && view.check?.ok === true && <p className="text-sm">{t('updates.check.latest')}</p>
      ) : (
        <div className="grid gap-3 rounded-lg border p-4">
          <div className="grid gap-1">
            <p className="text-sm font-bold">{t('updates.available', { version: available.version, date: day(available.releasedAt) })}</p>
            {notes !== null && (
              <a href={notes} target="_blank" rel="noopener noreferrer" className="w-fit text-sm font-semibold text-accent-text underline underline-offset-4">
                {t('updates.available.notes', { version: available.version })}
              </a>
            )}
          </div>
          {precheck !== null && <PrecheckList id={precheckId} report={precheck} latest={available.steppingStone ? available.latest : null} />}
          {offerApply && (
            <div className="flex flex-col gap-2">
              <div>
                <Button
                  type="button"
                  disabled={!applyEnabled}
                  aria-describedby={precheck === null ? hintId : `${precheckId} ${hintId}`}
                  onClick={() => void apply()}
                >
                  {t('updates.apply', { version: available.version })}
                </Button>
              </div>
              <p id={hintId} className="text-xs text-muted-foreground">
                {t('updates.apply.hint')}
              </p>
              {applyProblem !== null && <RefusalAlert error={applyProblem} />}
            </div>
          )}
        </div>
      )}

      {view.dockerPull && <DockerPull only={!view.oneClick} />}
    </SettingsSection>
  );
}

/** "Kembali ke versi sebelumnya" (§9.7), for a holder of `system.update.run`. */
function RollbackSection({ view, onRead }: { view: UpdatesView; onRead(): void }) {
  const t = useT();
  const reasonId = useId();
  const [confirming, setConfirming] = useState(false);
  const { rollback } = view;
  const target = rollback.target;
  const reason = !rollback.available && rollback.reason !== null && own(ROLLBACK_REASONS, rollback.reason) ? ROLLBACK_REASONS[rollback.reason]! : null;
  const enabled = rollback.available && target !== null && !isLive(view.op);

  const run = async (): Promise<void> => {
    try {
      await api<UpdateOpResponse>('POST', 'updates/rollback');
    } catch (e) {
      // ROLLBACK_UNAVAILABLE and the like: the dialog says so, and the section shows why from the view read again.
      onRead();
      throw e;
    }
    page.assign(OPS_PAGE_PATH);
  };

  return (
    <SettingsSection title={t('updates.rollback.title')}>
      {target !== null && rollback.reason !== 'image' && <p className="text-sm">{t('updates.rollback.body', { version: target })}</p>}
      {reason !== null && (
        <p id={reasonId} className="text-sm text-muted-foreground">
          {t(reason)}
        </p>
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={!enabled}
          aria-describedby={reason === null ? undefined : reasonId}
          onClick={() => setConfirming(true)}
        >
          {t('updates.rollback.action')}
        </Button>
      </div>
      {target !== null && (
        <ConfirmDialog
          open={confirming}
          title={t('updates.rollback.confirm_title', { version: target })}
          description={t('updates.rollback.confirm_body', { version: target, current: view.current.version })}
          confirmLabel={t('updates.rollback.confirm', { version: target })}
          onConfirm={run}
          onClose={() => setConfirming(false)}
        />
      )}
    </SettingsSection>
  );
}

/** `/admin/updates`. */
export function UpdatesScreen() {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const canRead = holds(me, 'system.update.read');
  const canRun = holds(me, 'system.update.run');
  const updates = useApiQuery<UpdatesView>({ queryKey: [...UPDATES_KEY], path: 'updates', enabled: canRead });

  // The hints of `system.update` (the shell reads the channel already for a holder of `system.update.read`; a channel
  // the caller may not read would refuse the whole poll, §10.7). Read in the background (an event is no sign of the
  // user), only marked stale while the tab is hidden.
  useRealtime(canRead ? ['system.update'] : [], (e) => {
    const keys = e.type.endsWith('.progress') ? [UPDATES_KEY] : [UPDATES_KEY, UPDATES_HISTORY_KEY];
    invalidateRealtimeKeys(queryClient, keys, document.visibilityState === 'hidden');
  });

  const read = (): void => {
    void queryClient.invalidateQueries({ queryKey: UPDATES_KEY });
  };

  let content: ReactNode;
  if (!canRead) {
    // The server would refuse (and record the refusal): say so without asking.
    content = <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />;
  } else if (updates.data !== undefined) {
    const view = updates.data;
    content = (
      <>
        <RefetchProblem query={updates} />
        <OpNotice op={view.op} canFollow={canRun} />
        <ReleaseNotices view={view} />
        <CurrentSection view={view} canRun={canRun} onChanged={read} />
        <ReleaseSection view={view} canRun={canRun} onRead={read} />
        {canRun && view.oneClick && <PackageUploadPanel blocked={isLive(view.op)} />}
        {canRun && <RollbackSection view={view} onRead={read} />}
        <UpdateHistory />
      </>
    );
  } else if (updates.isError) {
    content = <ErrorState error={updates.error} onRetry={() => void updates.refetch()} retrying={updates.isFetching} />;
  } else {
    content = <LoadingState />;
  }

  return (
    <div className="grid max-w-5xl gap-6">
      <PageHead title={t('nav.updates')} intro={t('updates.description')} />
      {content}
    </div>
  );
}
