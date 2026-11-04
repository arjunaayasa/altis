import type { SessionItem } from '@altis/shared/api/auth';
import { useQueryClient } from '@tanstack/react-query';
import { MonitorSmartphoneIcon } from 'lucide-react';
import { useState } from 'react';
import { NoticeAlert, ProblemAlert } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { useLocale, useT, type Translate } from '@/i18n';
import { api } from '@/lib/api';
import { useApiQuery } from '@/lib/me';
import { ProfilePage, ProfileSection } from './profile';

/**
 * "Sesi aktif", `/admin/profile/sessions` (spec §7.1 "Pencabutan", §13.5; Task 28): the user's live sign-ins
 * (`GET auth/sessions`), this one marked, each other one with "Akhiri" (`DELETE auth/sessions/:id`, which ends it with
 * its remember-me token, B9). The device is a rough reading of the browser's user agent, enough to recognise it.
 */

const SESSIONS_KEY = ['auth', 'sessions'] as const;

/** "Chrome di Windows" from a user agent; null when neither the browser nor the system is recognised. */
function deviceOf(userAgent: string): { browser: string | null; os: string | null } {
  const browser = /Edg(?:e|A|iOS)?\//.test(userAgent)
    ? 'Edge'
    : /OPR\/|Opera/.test(userAgent)
      ? 'Opera'
      : /SamsungBrowser\//.test(userAgent)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS\//.test(userAgent)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(userAgent)
            ? 'Chrome'
            : /Safari\//.test(userAgent)
              ? 'Safari'
              : null;
  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /iPhone|iPad|iPod/.test(userAgent)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(userAgent)
          ? 'macOS'
          : /CrOS/.test(userAgent)
            ? 'ChromeOS'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : null;
  return { browser, os };
}

function describeDevice(t: Translate, userAgent: string | null): string {
  const { browser, os } = deviceOf(userAgent ?? '');
  if (browser === null && os === null) return t('profile.sessions.unknown_device');
  return t('profile.sessions.device', {
    browser: browser ?? t('profile.sessions.some_browser'),
    os: os ?? t('profile.sessions.some_os'),
  });
}

const BADGE = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium';

/** `/admin/profile/sessions`. */
export function SessionsScreen() {
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const sessions = useApiQuery<SessionItem[]>({ queryKey: [...SESSIONS_KEY], path: 'auth/sessions' });
  const [busy, setBusy] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const time = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { dateStyle: 'medium', timeStyle: 'short' });

  const list = [...(sessions.data ?? [])].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt);
  const others = list.filter((s) => !s.current);

  /** Ends the sessions `ids`, one after the other, then reads the list again. */
  const revoke = async (ids: string[], key: string): Promise<void> => {
    setBusy(key);
    setProblem(null);
    setEnded(false);
    try {
      for (const id of ids) await api('DELETE', `auth/sessions/${id}`);
      setEnded(true);
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(null);
      await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    }
  };

  return (
    <ProfilePage>
      <ProfileSection title={t('profile.sessions.title')} description={t('profile.sessions.description')}>
        {sessions.isPending && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )}
        <ProblemAlert error={sessions.error ?? problem} />
        {ended && <NoticeAlert tone="success">{t('profile.sessions.revoked')}</NoticeAlert>}
        {list.length > 0 && (
          <ul aria-label={t('profile.sessions.list')} className="divide-y">
            {list.map((s) => {
              const device = describeDevice(t, s.userAgent);
              return (
                <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 items-start gap-3">
                    <MonitorSmartphoneIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                    <div className="grid min-w-0 gap-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{device}</span>
                        {s.current && <span className={`${BADGE} border-primary/30 bg-primary/10 text-primary`}>{t('profile.sessions.current')}</span>}
                        {s.remembered && <span className={`${BADGE} text-muted-foreground`}>{t('profile.sessions.remembered')}</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('profile.sessions.last_seen', { time: time.format(s.lastSeenAt) })} ·{' '}
                        {t('profile.sessions.signed_in', { time: time.format(s.createdAt) })}
                      </p>
                      {s.ip !== null && <p className="text-xs text-muted-foreground">{t('profile.sessions.ip', { ip: s.ip })}</p>}
                    </div>
                  </div>
                  {!s.current && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t('profile.sessions.revoke_label', { device })}
                      disabled={busy !== null}
                      onClick={() => void revoke([s.id], s.id)}
                    >
                      {t('profile.sessions.revoke')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {others.length > 1 && (
          <div>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void revoke(others.map((s) => s.id), 'others')}>
              {t('profile.sessions.revoke_others')}
            </Button>
          </div>
        )}
      </ProfileSection>
    </ProfilePage>
  );
}
