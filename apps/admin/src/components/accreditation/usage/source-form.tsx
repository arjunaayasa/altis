import { SlimsDbConfigBody, type SlimsUsageTestResponse } from '@altis/shared/api/accreditation';
import { PlugIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { CheckField, Field, Notice } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type TKey } from '@/i18n';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useBytes } from '@/screens/backups/upload';
import { checkDb, type DbDraft, type DbErrors } from '@/screens/catalog/migration/source-step';

/**
 * Step 1 of "Impor dari SLiMS" (spec §11.2): where the usage figures are read from. Its own form, not the catalogue
 * migration's source step: that one tests through the migration route (under the migration permission) and uploads into
 * the migration's upload context, while this import has its own route and context. Only the migration's pure database
 * check (`checkDb`) and its draft shape are shared.
 *
 * - **A SLiMS database:** host, port, user, password, database and TLS, checked before anything is sent (the shared
 *   check, then the widths of the usage import's own body). "Uji koneksi" asks `POST
 *   accreditation/slims-usage/test-connection` `{db}` (re-authenticated: the reauth dialog opens when the server asks),
 *   which always answers 200: the usage tables with their rows, the member types with a guessed group, and the first and
 *   last month of usage; or `ok: false` with its code and reason. A change to any field drops the old answer.
 * - **A SQL dump** (`.sql`, `.sql.gz`): chosen here, uploaded in the context `accreditation.slims_dump` when the import
 *   starts.
 *
 * The database password lives in this page's memory only until the import starts.
 */

export interface UsageSourceDraft {
  kind: 'db' | 'dump' | null;
  db: DbDraft;
  dump: File | null;
}

export const EMPTY_USAGE_SOURCE: UsageSourceDraft = {
  kind: null,
  db: { host: '', port: '3306', user: '', password: '', database: '', tls: false },
  dump: null,
};

export type UsageTestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'done'; answer: SlimsUsageTestResponse }
  | { kind: 'error'; error: unknown };

/** The errors shown after "Lanjut". */
export interface UsageSourceErrors {
  kind?: TKey;
  dump?: TKey;
  test?: TKey;
  db?: DbErrors;
}

/**
 * The database of `db` as the usage import's body carries it, or the message key of each field that is not right: the
 * migration's own check first, then the narrower widths of the usage import (host ≤ 191, user ≤ 64).
 */
export function checkUsageDb(db: DbDraft): { config: SlimsDbConfigBody; errors?: undefined } | { config?: undefined; errors: DbErrors } {
  const checked = checkDb(db);
  if (checked.errors !== undefined) return { errors: checked.errors };
  const { host, port, user, password, database, tls } = checked.source;
  const parsed = SlimsDbConfigBody.safeParse({ host, port, user, password, database, tls });
  if (parsed.success) return { config: parsed.data };
  const errors: DbErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === 'host' || field === 'port' || field === 'user' || field === 'password' || field === 'database') {
      errors[field] ??= issue.code === 'too_big' ? 'form.error.too_big' : 'form.error.invalid_format';
    }
  }
  return { errors };
}

/** The errors of a source before "Lanjut" (none: it is complete; a database must have passed the connection test). */
export function checkUsageSource(s: UsageSourceDraft, test: UsageTestState): UsageSourceErrors {
  if (s.kind === null) return { kind: 'accreditation.usage.source.kind_required' };
  if (s.kind === 'dump') return s.dump === null ? { dump: 'accreditation.usage.source.dump_required' } : {};
  const db = checkUsageDb(s.db);
  if (db.errors !== undefined) return { db: db.errors };
  return test.kind === 'done' && test.answer.ok ? {} : { test: 'accreditation.usage.test.required' };
}

export const hasUsageSourceErrors = (e: UsageSourceErrors): boolean =>
  e.kind !== undefined || e.dump !== undefined || e.test !== undefined || (e.db !== undefined && Object.keys(e.db).length > 0);

/** The answer of "Uji koneksi". */
function TestAnswer({ answer }: { answer: SlimsUsageTestResponse }) {
  const t = useT();
  const number = new Intl.NumberFormat(useLocale() === 'en' ? 'en-GB' : 'id-ID');
  const tablesId = useId();
  if (!answer.ok) {
    return (
      <Notice kind="error">
        {t('accreditation.usage.test.failed', { code: answer.code })}
        {answer.reason !== null && <> {t('catalog.migration.db.reason', { reason: answer.reason })}</>}
      </Notice>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Notice kind="success">{t('accreditation.usage.test.ok')}</Notice>
      <p className="text-sm">
        {answer.months === null
          ? t('accreditation.usage.test.no_months')
          : t('accreditation.usage.test.months', { first: answer.months.first, last: answer.months.last })}
      </p>
      {answer.tables.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table aria-labelledby={tablesId} className="w-full text-sm">
            <caption id={tablesId} className="px-3 py-2 text-left font-medium">
              {t('accreditation.usage.test.tables')}
            </caption>
            <thead className="bg-muted/50 text-left">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                  {t('catalog.migration.db.col_table')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">
                  {t('catalog.migration.db.col_rows')}
                </th>
              </tr>
            </thead>
            <tbody>
              {answer.tables.map((x) => (
                <tr key={x.name} className="border-t">
                  <th scope="row" className="px-3 py-1 text-left font-mono text-xs font-normal">
                    {x.name}
                  </th>
                  <td className="px-3 py-1 text-right tabular-nums">{x.rows === null || x.rows < 0 ? t('catalog.migration.db.rows_unknown') : number.format(x.rows)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The database fields and "Uji koneksi". */
function DbFields({
  db,
  errors,
  test,
  onChange,
  onTest,
}: {
  db: DbDraft;
  errors: DbErrors;
  test: UsageTestState;
  onChange(db: DbDraft): void;
  onTest(state: UsageTestState): void;
}) {
  const t = useT();
  const [shown, setShown] = useState<DbErrors>({});
  /** The test in flight: a change to a field, or a newer test, makes its answer stale. */
  const current = useRef(0);
  const all = { ...errors, ...shown };

  const set = (patch: Partial<DbDraft>): void => {
    current.current += 1;
    onTest({ kind: 'idle' });
    setShown({});
    onChange({ ...db, ...patch });
  };

  const runTest = async (): Promise<void> => {
    const checked = checkUsageDb(db);
    if (checked.errors !== undefined) {
      setShown(checked.errors);
      return;
    }
    const n = ++current.current;
    onTest({ kind: 'testing' });
    try {
      const answer = await api<SlimsUsageTestResponse>('POST', 'accreditation/slims-usage/test-connection', { db: checked.config });
      if (n === current.current) onTest({ kind: 'done', answer });
    } catch (e) {
      if (n === current.current) onTest({ kind: 'error', error: e });
    }
  };

  const text = (field: keyof DbDraft, label: TKey, o: { type?: string; autoComplete?: string; maxLength?: number; hint?: TKey } = {}) => (
    <Field label={t(label)} error={all[field]} {...(o.hint === undefined ? {} : { hint: t(o.hint) })}>
      {(c) => (
        <Input
          {...c}
          type={o.type ?? 'text'}
          value={String(db[field])}
          autoComplete={o.autoComplete ?? 'off'}
          spellCheck={false}
          {...(o.maxLength === undefined ? {} : { maxLength: o.maxLength })}
          onChange={(e) => set({ [field]: e.target.value })}
        />
      )}
    </Field>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-[1fr_8rem]">
        {text('host', 'catalog.migration.db.host', { maxLength: 191 })}
        {text('port', 'catalog.migration.db.port', { maxLength: 5 })}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {text('user', 'catalog.migration.db.user', { maxLength: 64 })}
        {text('password', 'catalog.migration.db.password', {
          type: 'password',
          autoComplete: 'new-password',
          maxLength: 200,
          hint: 'accreditation.usage.source.password_hint',
        })}
      </div>
      <div className="grid gap-4 md:grid-cols-2">{text('database', 'catalog.migration.db.database', { maxLength: 64 })}</div>
      <CheckField label={t('catalog.migration.db.tls')} checked={db.tls} onChange={(e) => set({ tls: e.target.checked })} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={test.kind === 'testing'} onClick={() => void runTest()}>
          <PlugIcon aria-hidden="true" />
          {t('catalog.migration.db.test')}
        </Button>
        {test.kind === 'testing' && (
          <span role="status" className="text-sm text-muted-foreground">
            {t('catalog.migration.db.testing')}
          </span>
        )}
      </div>
      {test.kind === 'done' && <TestAnswer answer={test.answer} />}
      {test.kind === 'error' && <Notice kind="error">{problemText(t, test.error)}</Notice>}
    </div>
  );
}

/** The source step: the kind of source, then the database fields (with the connection test) or the dump file. */
export function SourceForm({
  value,
  errors,
  test,
  onChange,
  onTest,
}: {
  value: UsageSourceDraft;
  errors: UsageSourceErrors;
  test: UsageTestState;
  onChange(next: UsageSourceDraft): void;
  onTest(state: UsageTestState): void;
}) {
  const t = useT();
  const bytes = useBytes();
  const kindName = useId();
  const kindError = errors.kind === undefined ? undefined : `${kindName}-error`;

  const choice = (kind: 'db' | 'dump', label: TKey, hint: TKey) => {
    const id = `${kindName}-${kind}`;
    return (
      <div className="grid gap-1">
        <div className="flex items-start gap-2">
          <input
            id={id}
            type="radio"
            name={kindName}
            value={kind}
            checked={value.kind === kind}
            aria-describedby={kindError}
            onChange={() => onChange({ ...value, kind })}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          <label htmlFor={id} className="text-sm leading-snug">
            {t(label)}
          </label>
        </div>
        <p className="pl-6 text-xs text-muted-foreground">{t(hint)}</p>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">{t('accreditation.usage.source.kind')}</legend>
        {choice('db', 'accreditation.usage.source.kind_db', 'accreditation.usage.source.kind_db_hint')}
        {choice('dump', 'accreditation.usage.source.kind_dump', 'accreditation.usage.source.kind_dump_hint')}
        {errors.kind !== undefined && (
          <p id={kindError} className="text-sm text-destructive">
            {t(errors.kind)}
          </p>
        )}
      </fieldset>
      {value.kind === 'db' && (
        <>
          <DbFields db={value.db} errors={errors.db ?? {}} test={test} onChange={(db) => onChange({ ...value, db })} onTest={onTest} />
          {errors.test !== undefined && <p className="text-sm text-destructive">{t(errors.test)}</p>}
        </>
      )}
      {value.kind === 'dump' && (
        <Field label={t('catalog.migration.dump.file')} error={errors.dump}>
          {(c) => (
            <div className="grid gap-1">
              <Input {...c} type="file" accept=".sql,.gz,application/sql,application/gzip" onChange={(e) => onChange({ ...value, dump: e.target.files?.[0] ?? null })} />
              {value.dump !== null && (
                <p className="text-xs text-muted-foreground">{t('catalog.migration.file.chosen', { name: value.dump.name, size: bytes(value.dump.size) })}</p>
              )}
            </div>
          )}
        </Field>
      )}
    </div>
  );
}
