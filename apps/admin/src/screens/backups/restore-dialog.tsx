import type { BackupItem, BackupRestoreResponse, RestoreBody } from '@altis/shared/api/backups';
import { useId, useState, type FormEvent } from 'react';
import { useDateTime } from '@/components/data-table';
import { CheckField, Field } from '@/components/form-field';
import { useReturnFocus } from '@/components/return-focus';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { ApiError, OPS_PAGE_PATH, api } from '@/lib/api';
import { fieldErrorKey, problemText } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { page } from '@/lib/page';

/**
 * "Pulihkan" of Cadangan (spec §9.10, §7.3 "konfirmasi tegas"; route `backups.restore`; preflight S6; 1c Task 32): the
 * dialog that begins the `restore` op of a backup made by this server (`ok`) or of an uploaded archive (`uploaded`).
 *
 * - **What it replaces:** every piece of data here, from a backup of the date it names (its version, schema and source
 *   database are listed). There is no choice of a target schema in 1c (S6): every restore ends at this release's.
 * - **Tanpa berkas:** `withoutFiles` restores the database only; every uploaded file then ends `missing`.
 * - **Frasa sandi:** an uploaded archive may be encrypted, and only the server can tell: its passphrase field is
 *   offered (left out of the request when empty); 422 BACKUP_PASSPHRASE_REQUIRED or BACKUP_PASSPHRASE_INVALID lands on
 *   that field.
 * - **Eksternal:** an uploaded archive, or a backup whose manifest does not carry this installation's HMAC
 *   (`sameInstall: false`), replaces this data only after the admin typed this library's name (`me.library.name`;
 *   compared as the server does, after NFKC and trimming): "Pulihkan" stays disabled until it matches, and the typed
 *   text goes as `confirmLibraryName`. A server that still answers 409 BACKUP_CONFIRM_REQUIRED shows the field.
 * - The request is re-authenticated (the reauth dialog opens on top when the server asks, lib/api.ts). 202 `{opId}`
 *   comes with the `altis_ops` cookie; the page then loads the operations page `/admin/_update` (a server page, never
 *   routed; Task 19), which follows the op to its end.
 */

/** The database names of the dialects (product names, not translated). */
export const DIALECT_NAMES: Readonly<Record<BackupItem['dialect'], string>> = Object.freeze({
  sqlite: 'SQLite',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgres: 'PostgreSQL',
});

/** How the server compares a typed library name: NFKC, then trimmed. */
const comparable = (name: string): string => name.normalize('NFKC').trim();

/** The dialog for `backup` (kept by the list between openings); its content starts afresh at every opening. */
export function RestoreDialog({ backup, open, onClose }: { backup: BackupItem | null; open: boolean; onClose(): void }) {
  const t = useT();
  const focus = useReturnFocus();
  return (
    <Dialog open={open && backup !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent closeLabel={t('backups.prepare.close')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
        {backup !== null && <RestoreForm backup={backup} />}
      </DialogContent>
    </Dialog>
  );
}

function Fact({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

function RestoreForm({ backup }: { backup: BackupItem }) {
  const t = useT();
  const me = useMe();
  const dateTime = useDateTime();
  const ids = { passphrase: useId(), name: useId(), error: useId(), facts: useId() };
  const libraryName = me?.library.name ?? '';
  const archive = backup.status === 'uploaded';
  const [askName, setAskName] = useState(backup.external || !backup.sameInstall);
  const [askPassphrase, setAskPassphrase] = useState(archive);
  const [passphrase, setPassphrase] = useState('');
  const [passphraseError, setPassphraseError] = useState<TKey | undefined>(undefined);
  const [typedName, setTypedName] = useState('');
  const [withoutFiles, setWithoutFiles] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);

  const nameMatches = comparable(typedName) !== '' && comparable(typedName) === comparable(libraryName);
  const ready = !busy && !started && (!askName || nameMatches);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!ready) return;
    setError(null);
    setPassphraseError(undefined);
    setBusy(true);
    try {
      const body: RestoreBody = { withoutFiles };
      if (askPassphrase && passphrase !== '') body.passphrase = passphrase;
      if (askName) body.confirmLibraryName = typedName;
      await api<BackupRestoreResponse>('POST', `backups/${encodeURIComponent(backup.id)}/restore`, body);
      setStarted(true);
      page.assign(OPS_PAGE_PATH);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'BACKUP_PASSPHRASE_REQUIRED' || e.code === 'BACKUP_PASSPHRASE_INVALID')) {
        setAskPassphrase(true);
        setPassphraseError(`error.${e.code}`);
      } else if (e instanceof ApiError && e.code === 'VALIDATION_FAILED' && e.errors?.some((f) => f.path === 'passphrase')) {
        setPassphraseError(fieldErrorKey(e.errors.find((f) => f.path === 'passphrase')!.code));
      } else {
        if (e instanceof ApiError && e.code === 'BACKUP_CONFIRM_REQUIRED') setAskName(true);
        setError(problemText(t, e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)} aria-describedby={error === null ? undefined : ids.error}>
      <DialogHeader>
        <DialogTitle>{t('backups.restore.title')}</DialogTitle>
        <DialogDescription>{t('backups.restore.description', { time: dateTime(backup.createdAt) })}</DialogDescription>
      </DialogHeader>
      <section aria-labelledby={ids.facts} className="rounded-md border p-3 text-sm">
        <h3 id={ids.facts} className="sr-only">
          {t('backups.restore.facts')}
        </h3>
        <dl className="grid gap-1">
          <Fact label={t('backups.col.kind')}>{t(`backups.kind.${backup.kind}`)}</Fact>
          <Fact label={t('backups.restore.version')}>{backup.appVersion}</Fact>
          <Fact label={t('backups.restore.schema')}>{backup.schemaVersion}</Fact>
          <Fact label={t('backups.restore.dialect')}>{DIALECT_NAMES[backup.dialect] ?? backup.dialect}</Fact>
        </dl>
      </section>
      {askPassphrase && (
        <Field id={ids.passphrase} label={t('backups.restore.passphrase')} hint={t('backups.restore.passphrase_hint')} error={passphraseError}>
          {(c) => (
            <Input
              {...c}
              type="password"
              autoComplete="off"
              maxLength={512}
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                setPassphraseError(undefined);
              }}
            />
          )}
        </Field>
      )}
      <CheckField
        label={t('backups.restore.without_files')}
        hint={t('backups.restore.without_files_hint')}
        checked={withoutFiles}
        onChange={(e) => setWithoutFiles(e.target.checked)}
      />
      {askName && (
        <>
          <Alert variant="destructive">
            <AlertDescription>{t('backups.restore.external')}</AlertDescription>
          </Alert>
          <Field id={ids.name} label={t('backups.restore.confirm_name', { name: libraryName })} hint={t('backups.restore.confirm_name_hint')}>
            {(c) => (
              <Input {...c} autoComplete="off" spellCheck={false} maxLength={191} value={typedName} onChange={(e) => setTypedName(e.target.value)} />
            )}
          </Field>
        </>
      )}
      {error !== null && (
        <p id={ids.error} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {started && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('backups.restore.starting')}
        </p>
      )}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={busy || started}>
            {t('backups.restore.cancel')}
          </Button>
        </DialogClose>
        <Button type="submit" variant="destructive" disabled={!ready}>
          {t('backups.restore.submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}
