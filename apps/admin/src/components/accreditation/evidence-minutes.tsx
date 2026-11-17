import type { EvidenceMinutesListResponse } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type JSX } from 'react';
import { Field, SELECT_CLASS } from '@/components/form-field';
import { InlinePanel } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';

/**
 * The minutes of a stocktake session as evidence: on an indicator item that takes them, a button that opens a dialog
 * listing the finished sessions whose minutes ALTIS stored (of the branches whose stocktake the user may read), and links
 * the chosen one with `POST accreditation/evidence/stocktake-minutes`. Nothing is downloaded or uploaded: the evidence
 * names the stored file. Only a holder of `accreditation.workspace.manage` sees it.
 */

const CAPTION_MAX = 191;
const MINUTES_PATH = 'accreditation/evidence/stocktake-minutes';

export function EvidenceMinutes({ periodId, indicatorCode, onDone }: { periodId: string; indicatorCode: string; onDone(): void }): JSX.Element {
  const t = useT();
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!holds(me, 'accreditation.workspace.manage')) return <></>;
  return (
    <>
      <Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={() => (busy ? undefined : setOpen((o) => !o))}>
        {t('accreditation.workspace.evidence.minutes.open')}
      </Button>
      {open && (
        <MinutesForm
          periodId={periodId}
          indicatorCode={indicatorCode}
          busy={busy}
          onBusy={setBusy}
          onCancel={() => setOpen(false)}
          onStored={() => {
            setOpen(false);
            onDone();
          }}
        />
      )}
    </>
  );
}

function MinutesForm(props: { periodId: string; indicatorCode: string; busy: boolean; onBusy(busy: boolean): void; onCancel(): void; onStored(): void }) {
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const errorId = useId();
  const sessions = useApiQuery<EvidenceMinutesListResponse>({ queryKey: ['accreditation', 'evidence', 'stocktake-minutes'], path: MINUTES_PATH });
  const [chosen, setChosen] = useState('');
  const [caption, setCaption] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = sessions.data?.items ?? [];
  const date = (ms: number): string => new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { dateStyle: 'medium' }).format(ms);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving) return;
    if (chosen === '') {
      setError(t('accreditation.workspace.evidence.minutes.required'));
      return;
    }
    setError(null);
    setSaving(true);
    props.onBusy(true);
    try {
      const body: Record<string, unknown> = { stocktakeId: chosen, periodId: props.periodId, indicatorCode: props.indicatorCode };
      if (caption.trim() !== '') body['caption'] = caption.trim();
      await api<StoreResponse>('POST', MINUTES_PATH, body);
      setSaving(false);
      props.onBusy(false);
      await queryClient.invalidateQueries({ queryKey: ['accreditation'] });
      props.onStored();
    } catch (err) {
      setSaving(false);
      props.onBusy(false);
      const duplicate = err instanceof ApiError && err.errors?.some((f) => f.code === 'duplicate') === true;
      setError(duplicate ? t('accreditation.workspace.evidence.minutes.duplicate') : problemText(t, err));
    }
  };

  return (
    <InlinePanel
      title={t('accreditation.workspace.evidence.minutes.title')}
      onSubmit={(e) => void submit(e)}
      {...(props.busy ? {} : { onCancel: props.onCancel })}
      className="w-full max-w-xl basis-full">
      <p className="text-sm text-muted-foreground">{t('accreditation.workspace.evidence.minutes.hint')}</p>
        {sessions.isSuccess && items.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('accreditation.workspace.evidence.minutes.none')}
          </p>
        ) : (
          <Field label={t('accreditation.workspace.evidence.minutes.session')}>
            {(c) => (
              <select
                {...c}
                className={SELECT_CLASS}
                value={chosen}
                disabled={saving || !sessions.isSuccess}
                aria-invalid={error !== null && chosen === '' ? true : undefined}
                aria-describedby={error !== null ? errorId : undefined}
                onChange={(e) => {
                  setChosen(e.target.value);
                  setError(null);
                }}>
                <option value="">{sessions.isSuccess ? t('accreditation.workspace.evidence.minutes.choose') : t('accreditation.workspace.evidence.minutes.loading')}</option>
                {items.map((s) => (
                  <option key={s.stocktakeId} value={s.stocktakeId}>
                    {t('accreditation.workspace.evidence.minutes.option', { name: s.name, branch: s.branch.name, date: date(s.finishedAt) })}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label={t('accreditation.registers.upload.caption')} hint={t('accreditation.workspace.evidence.minutes.caption_hint')}>
          {(c) => <Input {...c} autoComplete="off" maxLength={CAPTION_MAX} disabled={saving} value={caption} onChange={(e) => setCaption(e.target.value)} />}
        </Field>
        {sessions.isError && (
          <p role="alert" className="text-meta font-semibold text-bad">
            {problemText(t, sessions.error)}
          </p>
        )}
        {error !== null && (
          <p id={errorId} role="alert" className="text-meta font-semibold text-bad">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={saving || items.length === 0}>
            {t('accreditation.workspace.evidence.minutes.submit')}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={props.onCancel}>
            {t('form.cancel')}
          </Button>
        </div>
    </InlinePanel>
  );
}
