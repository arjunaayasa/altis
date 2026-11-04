import type { ConfigBody, DbConfigBody, DbTestResponse, InstallStateResponse } from '@altis/shared/api/install';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { installApi } from '../api';
import { useInstallT, type InstallKey } from '../i18n';
import { CONTROL_CLASS, Field, ProblemAlert, StepHeading } from '../ui';
import type { Connection } from './checks';

// Step 2, the database (spec §9.5 step 2): the dialects this runtime may use (SQLite only where one process owns the
// file, P20: not on Passenger or LiteSpeed), "Uji koneksi" (`POST db/test`: version, engine, empty or this install's
// own, the pool size, P17), then `POST config` with what the checks step decided (base URL, hops, the probe proof and
// results). The server writes config.json and begins the `install-migrate` op; the migration step follows.

type Dialect = DbConfigBody['dialect'];

const DEFAULT_PORT: Readonly<Record<Exclude<Dialect, 'sqlite'>, number>> = { mysql: 3306, mariadb: 3306, postgres: 5432 };

/** The product names `POST db/test` reports a server as (not translated). */
const FLAVOR_NAMES: Readonly<Record<string, string>> = { mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite' };

/** Whether this runtime may use SQLite (@altis/platform sqliteAllowed: one process owns the file). */
export function sqliteAllowedOn(runtime: string): boolean {
  return runtime !== 'passenger' && runtime !== 'litespeed';
}

interface DbForm {
  dialect: Dialect;
  host: string;
  /** '' = the dialect's default port. */
  port: string;
  database: string;
  user: string;
  password: string;
}

/** The `db` of the form as `POST db/test` and `POST config` take it (empty optional fields left out). */
export function dbBody(form: DbForm): DbConfigBody {
  if (form.dialect === 'sqlite') return { dialect: 'sqlite' };
  const port = /^\d{1,5}$/.test(form.port.trim()) ? Number(form.port.trim()) : DEFAULT_PORT[form.dialect];
  const body: DbConfigBody = { dialect: form.dialect, host: form.host.trim() === '' ? 'localhost' : form.host.trim(), port };
  if (form.database.trim() !== '') body.database = form.database.trim();
  if (form.user !== '') body.user = form.user;
  if (form.password !== '') body.password = form.password;
  return body;
}

export function DatabaseStep({
  runtime,
  connection,
  onConfigured,
  recover,
}: {
  runtime: string;
  connection: Connection;
  onConfigured(): void;
  recover(error: unknown): Promise<boolean>;
}) {
  const t = useInstallT();
  const dialects: Dialect[] = ['mysql', 'mariadb', 'postgres', ...(sqliteAllowedOn(runtime) ? (['sqlite'] as const) : [])];
  const [form, setForm] = useState<DbForm>({ dialect: 'mysql', host: 'localhost', port: '', database: '', user: '', password: '' });
  const [tested, setTested] = useState<{ body: string; result: DbTestResponse } | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [error, setError] = useState<unknown>(null);

  const body = dbBody(form);
  const current = tested !== null && tested.body === JSON.stringify(body) ? tested.result : null;
  const usable = current !== null && current.ok && (current.empty || current.resumable);
  const set = (patch: Partial<DbForm>): void => setForm((f) => ({ ...f, ...patch }));

  const test = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    setBusy('test');
    setError(null);
    try {
      const result = await installApi<DbTestResponse>('POST', 'db/test', { db: body });
      setTested({ body: JSON.stringify(body), result });
    } catch (failure) {
      setTested(null);
      if (!(await recover(failure))) setError(failure);
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    if (!usable) return;
    setBusy('save');
    setError(null);
    const config: ConfigBody = { baseUrl: connection.baseUrl, db: body, trustProxy: { hops: connection.hops }, probe: connection.probe };
    try {
      await installApi<InstallStateResponse>('POST', 'config', config);
      onConfigured();
    } catch (failure) {
      if (!(await recover(failure))) setError(failure);
      setBusy(null);
    }
  };

  const sqlite = form.dialect === 'sqlite';
  const port = sqlite ? '' : String(DEFAULT_PORT[form.dialect as Exclude<Dialect, 'sqlite'>]);

  return (
    <div className="space-y-6">
      <StepHeading title={t('db.title')} intro={t('db.intro')} />
      <form className="grid gap-4" onSubmit={(e) => void test(e)} noValidate>
        <Field id="install-db-dialect" label={t('db.dialect')} hint={sqliteAllowedOn(runtime) ? t('db.sqlite_note') : t('db.sqlite_unavailable')}>
          <select
            id="install-db-dialect"
            className={`${CONTROL_CLASS} h-9`}
            value={form.dialect}
            onChange={(e) => set({ dialect: e.target.value as Dialect, port: '' })}
            aria-describedby="install-db-dialect-hint"
          >
            {dialects.map((d) => (
              <option key={d} value={d}>
                {t(`db.dialect.${d}` as InstallKey)}
              </option>
            ))}
          </select>
        </Field>
        {sqlite ? null : (
          <>
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <Field id="install-db-host" label={t('db.host')}>
                <Input id="install-db-host" value={form.host} onChange={(e) => set({ host: e.target.value })} autoComplete="off" spellCheck={false} />
              </Field>
              <Field id="install-db-port" label={t('db.port')}>
                <Input id="install-db-port" inputMode="numeric" value={form.port} placeholder={port} onChange={(e) => set({ port: e.target.value })} autoComplete="off" />
              </Field>
            </div>
            <Field id="install-db-name" label={t('db.database')}>
              <Input id="install-db-name" value={form.database} onChange={(e) => set({ database: e.target.value })} autoComplete="off" spellCheck={false} />
            </Field>
            <Field id="install-db-user" label={t('db.user')}>
              <Input id="install-db-user" value={form.user} onChange={(e) => set({ user: e.target.value })} autoComplete="off" spellCheck={false} />
            </Field>
            <Field id="install-db-password" label={t('db.password')}>
              <Input id="install-db-password" type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
            </Field>
          </>
        )}
        <div>
          <Button type="submit" variant="outline" disabled={busy !== null}>
            {busy === 'test' ? t('db.testing') : t('db.test')}
          </Button>
        </div>
      </form>

      {current === null ? (
        tested === null ? null : (
          <p className="text-sm text-muted-foreground">{t('db.retest')}</p>
        )
      ) : (
        <div className="space-y-1 text-sm" aria-live="polite">
          <p>{t('db.result.ok', { flavor: FLAVOR_NAMES[current.flavor] ?? current.flavor, version: current.version })}</p>
          <p>{t('db.result.pool', { n: current.poolSize })}</p>
          {current.problems.map((p) => (
            <p key={p} className="text-destructive">
              {p === 'VERSION_TOO_OLD' || p === 'ENGINE_NOT_INNODB' || p === 'NO_FULLTEXT' ? t(`db.problem.${p}`) : p}
            </p>
          ))}
          {current.empty ? <p>{t('db.result.empty')}</p> : current.resumable ? <p>{t('db.result.resumable')}</p> : <p className="text-destructive">{t('db.result.not_empty')}</p>}
        </div>
      )}

      {error === null ? null : <ProblemAlert error={error} />}

      <div className="border-t pt-4">
        <Button type="button" disabled={!usable || busy !== null} onClick={() => void save()}>
          {busy === 'save' ? t('db.saving') : t('db.save')}
        </Button>
      </div>
    </div>
  );
}
