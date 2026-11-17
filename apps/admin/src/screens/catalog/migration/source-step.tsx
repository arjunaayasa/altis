import { SlimsDbSource, type SlimsTestResponse } from '@altis/shared/api/catalog/migration';
import { useId, useRef, useState, type ReactNode } from 'react';
import { CheckField, Field, Notice } from '@/components/form-field';
import { TABLE } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type TKey } from '@/i18n';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { cn } from '@/lib/utils';
import { useBytes } from '@/screens/backups/upload';

/**
 * Step 1 of the Migrasi SLiMS wizard (Phase 2 spec §11.1, §13; plan Task 30): where SLiMS is read from.
 *
 * - **A SLiMS database** (MySQL/MariaDB, `SELECT` only): host, port, user, password, database and TLS, checked with the
 *   shared `SlimsDbSource` before anything is sent. "Uji koneksi" asks `POST catalog/migrations/slims/test-connection`
 *   (re-authenticated: the reauth dialog opens when the server asks), which always answers 200 (P2-17): the version
 *   the tables look like, the tables the migration reads with their rows (-1: the source does not know), the core
 *   tables that are missing; or `ok: false` with the code and its reason. A change to any field drops the old answer.
 * - **A SQL dump** (`.sql`, `.sql.gz`): chosen here, uploaded (`slims.dump`) when the dry run starts.
 * - **The files archive** (`slims.files`, optional): the zip of `repository/` and `images/`, uploaded with the dump.
 *   Only the dry run takes it: the real run adopts the dry run's archive (S3), so it is chosen here or never.
 *
 * The database password lives in this page's memory only until the dry run starts (index.tsx empties it then).
 */

export interface DbDraft {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  tls: boolean;
}

export interface SourceDraft {
  kind: 'db' | 'dump' | null;
  db: DbDraft;
  dump: File | null;
  files: File | null;
}

export const EMPTY_SOURCE: SourceDraft = {
  kind: null,
  db: { host: '', port: '3306', user: '', password: '', database: '', tls: false },
  dump: null,
  files: null,
};

/** The message key of each database field that is not right. */
export type DbErrors = Partial<Record<keyof DbDraft, TKey>>;

/** The source errors shown after "Lanjut". */
export interface SourceErrors {
  kind?: TKey;
  dump?: TKey;
  db?: DbErrors;
}

const DB_FIELDS: readonly (keyof DbDraft)[] = ['host', 'port', 'user', 'password', 'database'];

/**
 * The database source of `db`, checked by the shared schema (the host trimmed, the port 1-65535, a user without spaces,
 * a MySQL database name), or the message key of each field that is not right. The password may be empty (a user
 * without one, as a fresh XAMPP's `root`), never longer than 200 characters, and is never trimmed.
 */
export function checkDb(db: DbDraft): { source: SlimsDbSource; errors?: undefined } | { source?: undefined; errors: DbErrors } {
  const port = /^\d{1,5}$/.test(db.port.trim()) ? Number(db.port.trim()) : Number.NaN;
  const parsed = SlimsDbSource.safeParse({
    kind: 'db',
    host: db.host,
    port,
    user: db.user,
    password: db.password,
    database: db.database,
    tls: db.tls,
  });
  if (parsed.success) return { source: parsed.data };
  const errors: DbErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field !== 'string' || !(DB_FIELDS as readonly string[]).includes(field)) continue;
    const name = field as keyof DbDraft;
    if (errors[name] !== undefined) continue;
    const raw = name === 'port' ? db.port : String(db[name]);
    errors[name] = raw.trim() === '' && name !== 'password' ? 'form.error.required' : issue.code === 'too_big' ? 'form.error.too_big' : 'form.error.invalid_format';
  }
  return { errors };
}

/** The errors of a source before "Lanjut" (none: it is complete). */
export function checkSource(s: SourceDraft): SourceErrors {
  if (s.kind === null) return { kind: 'catalog.migration.source.kind_required' };
  if (s.kind === 'dump') return s.dump === null ? { dump: 'catalog.migration.dump.required' } : {};
  const db = checkDb(s.db);
  return db.errors === undefined ? {} : { db: db.errors };
}

export const hasSourceErrors = (e: SourceErrors): boolean => e.kind !== undefined || e.dump !== undefined || (e.db !== undefined && Object.keys(e.db).length > 0);

/** A file input that keeps its choice in the wizard's state (a file input cannot be given a value back). */
function FileField({
  label,
  hint,
  accept,
  file,
  error,
  onPick,
}: {
  label: string;
  hint?: string;
  accept: string;
  file: File | null;
  error?: TKey | undefined;
  onPick(file: File | null): void;
}) {
  const t = useT();
  const bytes = useBytes();
  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })} error={error}>
      {(c) => (
        <div className="grid gap-1">
          <Input {...c} type="file" accept={accept} onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
          {file !== null && <p className="text-xs text-muted-foreground">{t('catalog.migration.file.chosen', { name: file.name, size: bytes(file.size) })}</p>}
        </div>
      )}
    </Field>
  );
}

type TestState = { kind: 'idle' } | { kind: 'testing' } | { kind: 'done'; answer: SlimsTestResponse } | { kind: 'error'; error: unknown };

/** The answer of "Uji koneksi". */
function TestAnswer({ answer }: { answer: SlimsTestResponse }) {
  const t = useT();
  const number = new Intl.NumberFormat(useLocale() === 'en' ? 'en' : 'id');
  const tablesId = useId();
  const tables = answer.tables ?? [];
  let head: ReactNode;
  if (answer.ok) {
    head = (
      <Notice kind="success">
        {answer.version === '8' ? t('catalog.migration.db.ok_8') : t('catalog.migration.db.ok', { version: answer.version ?? '9' })}
      </Notice>
    );
  } else {
    head = (
      <Notice kind="error">
        {t(answer.code === 'MIGRATION_SOURCE_UNSUPPORTED' ? 'catalog.migration.db.unsupported' : 'catalog.migration.db.unreachable')}
        {answer.reason !== undefined && <> {t('catalog.migration.db.reason', { reason: answer.reason })}</>}
      </Notice>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {head}
      {tables.length > 0 && (
        <div className={TABLE.wrap}>
          <table aria-labelledby={tablesId} className={TABLE.table}>
            <caption id={tablesId} className="px-3 py-2 text-left text-sm font-bold">
              {t('catalog.migration.db.tables')}
            </caption>
            <thead>
              <tr>
                <th scope="col" className={TABLE.th}>
                  {t('catalog.migration.db.col_table')}
                </th>
                <th scope="col" className={cn(TABLE.th, 'text-right')}>
                  {t('catalog.migration.db.col_rows')}
                </th>
              </tr>
            </thead>
            <tbody>
              {tables.map((x) => (
                <tr key={x.name}>
                  <th scope="row" className={cn(TABLE.td, 'py-1.5 text-left font-normal')}>
                    {x.name}
                  </th>
                  <td className={cn(TABLE.td, 'py-1.5 text-right')}>{x.rows < 0 ? t('catalog.migration.db.rows_unknown') : number.format(x.rows)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(answer.missing?.length ?? 0) > 0 && (
        <p className="text-sm text-muted-foreground">{t('catalog.migration.db.missing', { tables: (answer.missing ?? []).join(', ') })}</p>
      )}
    </div>
  );
}

/** The database fields and "Uji koneksi". */
function DbFields({ db, errors, onChange }: { db: DbDraft; errors: DbErrors; onChange(db: DbDraft): void }) {
  const t = useT();
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [shown, setShown] = useState<DbErrors>({});
  /** The test in flight: a change to a field, or a newer test, makes its answer stale. */
  const current = useRef(0);
  const all = { ...errors, ...shown };

  const set = (patch: Partial<DbDraft>): void => {
    current.current += 1;
    setTest({ kind: 'idle' });
    setShown({});
    onChange({ ...db, ...patch });
  };

  const runTest = async (): Promise<void> => {
    const checked = checkDb(db);
    if (checked.errors !== undefined) {
      setShown(checked.errors);
      return;
    }
    const n = ++current.current;
    setTest({ kind: 'testing' });
    try {
      const answer = await api<SlimsTestResponse>('POST', 'catalog/migrations/slims/test-connection', { source: checked.source });
      if (n === current.current) setTest({ kind: 'done', answer });
    } catch (e) {
      if (n === current.current) setTest({ kind: 'error', error: e });
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
        {text('host', 'catalog.migration.db.host', { maxLength: 253 })}
        {text('port', 'catalog.migration.db.port', { maxLength: 5 })}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {text('user', 'catalog.migration.db.user', { maxLength: 80 })}
        {text('password', 'catalog.migration.db.password', { type: 'password', autoComplete: 'new-password', maxLength: 200, hint: 'catalog.migration.db.password_hint' })}
      </div>
      <div className="grid gap-4 md:grid-cols-2">{text('database', 'catalog.migration.db.database', { maxLength: 64 })}</div>
      <CheckField label={t('catalog.migration.db.tls')} checked={db.tls} onChange={(e) => set({ tls: e.target.checked })} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={test.kind === 'testing'} onClick={() => void runTest()}>
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

export function SourceStep({
  value,
  errors,
  onChange,
  onNext,
}: {
  value: SourceDraft;
  errors: SourceErrors;
  onChange(next: SourceDraft): void;
  onNext(): void;
}) {
  const t = useT();
  const titleId = useId();
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
    <section aria-labelledby={titleId} className="grid max-w-4xl gap-4">
      <h2 id={titleId} className="text-base font-bold">
        {t('catalog.migration.source.title')}
      </h2>
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-bold">{t('catalog.migration.source.kind')}</legend>
        {choice('db', 'catalog.migration.source.kind_db', 'catalog.migration.source.kind_db_hint')}
        {choice('dump', 'catalog.migration.source.kind_dump', 'catalog.migration.source.kind_dump_hint')}
        {errors.kind !== undefined && (
          <p id={kindError} className="text-meta font-semibold text-bad">
            {t(errors.kind)}
          </p>
        )}
      </fieldset>
      {value.kind === 'db' && <DbFields db={value.db} errors={errors.db ?? {}} onChange={(db) => onChange({ ...value, db })} />}
      {value.kind === 'dump' && (
        <FileField
          label={t('catalog.migration.dump.file')}
          accept=".sql,.gz,application/sql,application/gzip"
          file={value.dump}
          error={errors.dump}
          onPick={(dump) => onChange({ ...value, dump })}
        />
      )}
      {value.kind !== null && (
        <FileField
          label={t('catalog.migration.files.file')}
          hint={t('catalog.migration.files.hint')}
          accept=".zip,application/zip"
          file={value.files}
          onPick={(files) => onChange({ ...value, files })}
        />
      )}
      <div className="flex gap-2 border-t pt-4">
        <Button type="button" onClick={onNext}>
          {t('catalog.migration.next')}
        </Button>
      </div>
    </section>
  );
}
