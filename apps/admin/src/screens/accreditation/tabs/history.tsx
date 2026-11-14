import type { FreezeBody, SnapshotListResponse } from '@altis/shared/api/accreditation';
import { useState, type JSX } from 'react';
import { Disclaimer } from '@/components/accreditation/disclaimer';
import { Field, NoticeAlert, ProblemAlert } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api, reauth } from '@/lib/api';
import { periodPath, useFormats, useRefreshPeriods, useSnapshots } from '../data';
import { TabState, type TabContext } from '../tab-state';

/**
 * Riwayat (spec §6 "Akreditasi", §10.10): freezing the period and its snapshots.
 *
 * - "Bekukan" (with an optional note) stores a snapshot of the current results and locks the period's answers,
 *   profile, population, facilities and monthly usage; the registers stay editable. The server refuses while the
 *   results are older than the period's last change ("Hitung ulang dulu").
 * - "Cairkan" opens a frozen period again; it asks for the password first (the API client's dialog). Its snapshots
 *   stay.
 * - The snapshots, newest first: when, the estimate they froze (a range, the single estimate with its predicate, or a
 *   practice figure when the prerequisites were not met), the prerequisites, the note, and the frozen evidence file
 *   when one was kept (downloaded after the password, since it names the staff).
 *
 * Freezing and opening again need `accreditation.workspace.manage`.
 */
export function HistoryTab(props: { periodId: string }): JSX.Element {
  return <TabState periodId={props.periodId}>{(ctx) => <History ctx={ctx} />}</TabState>;
}

function History({ ctx }: { ctx: TabContext }) {
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      {ctx.period.status === 'open' ? <FreezePanel ctx={ctx} /> : <UnfreezePanel ctx={ctx} />}
      <Snapshots periodId={ctx.period.id} />
    </div>
  );
}

function FreezePanel({ ctx }: { ctx: TabContext }) {
  const t = useT();
  const refresh = useRefreshPeriods();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  const freeze = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    setDone(false);
    try {
      const text = note.trim();
      const body: FreezeBody = text === '' ? {} : { note: text };
      await api('POST', periodPath(ctx.period.id, '/freeze'), body);
      setDone(true);
      setNote('');
      await refresh();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={t('accreditation.workspace.history.freeze.title')} className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground">
      <h3 className="text-base font-semibold">{t('accreditation.workspace.history.freeze.title')}</h3>
      <p className="text-sm text-muted-foreground">{t('accreditation.workspace.history.freeze.text')}</p>
      {ctx.canManage ? (
        <>
          <Field label={t('accreditation.workspace.history.freeze.note')}>
            {(control) => <Input {...control} value={note} maxLength={191} disabled={busy} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <div>
            <Button type="button" disabled={busy} onClick={() => void freeze()}>
              {t(busy ? 'accreditation.workspace.history.freeze.busy' : 'accreditation.workspace.history.freeze.submit')}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm">{t('accreditation.workspace.history.read_only')}</p>
      )}
      <ProblemAlert error={problem} />
      {done && <NoticeAlert tone="success">{t('accreditation.workspace.history.freeze.done')}</NoticeAlert>}
    </section>
  );
}

function UnfreezePanel({ ctx }: { ctx: TabContext }) {
  const t = useT();
  const f = useFormats();
  const refresh = useRefreshPeriods();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  const unfreeze = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await api('POST', periodPath(ctx.period.id, '/unfreeze'), {});
      await refresh();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={t('accreditation.workspace.history.unfreeze.title')} className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground">
      <h3 className="text-base font-semibold">{t('accreditation.workspace.history.unfreeze.title')}</h3>
      {ctx.period.frozenAt !== null && <p className="text-sm">{t('accreditation.workspace.history.frozen', { time: f.dateTime(ctx.period.frozenAt) })}</p>}
      <p className="text-sm text-muted-foreground">{t('accreditation.workspace.history.unfreeze.text')}</p>
      {ctx.canManage ? (
        <div>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void unfreeze()}>
            {t(busy ? 'accreditation.workspace.history.unfreeze.busy' : 'accreditation.workspace.history.unfreeze.submit')}
          </Button>
        </div>
      ) : (
        <p className="text-sm">{t('accreditation.workspace.history.read_only')}</p>
      )}
      <ProblemAlert error={problem} />
    </section>
  );
}

type SnapshotRow = SnapshotListResponse['snapshots'][number];

/** Downloads a snapshot's frozen evidence file after the password (the file names the staff). */
async function downloadDossier(snapshotId: string): Promise<void> {
  try {
    await reauth.request();
  } catch {
    return;
  }
  const a = document.createElement('a');
  a.href = `/api/v1/accreditation/snapshots/${encodeURIComponent(snapshotId)}/dossier`;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

function Snapshots({ periodId }: { periodId: string }) {
  const t = useT();
  const f = useFormats();
  const snapshots = useSnapshots(periodId);
  const list = snapshots.data?.snapshots;

  const estimate = (s: SnapshotRow): string => {
    if (s.na === null) return t('accreditation.workspace.history.range', { low: f.decimal(s.naLow), high: f.decimal(s.naHigh) });
    if (!s.prerequisitesMet) return `${f.decimal(s.na)} · ${t('accred.na.exercise')}`;
    if (s.grade === null) return f.decimal(s.na);
    return `${f.decimal(s.na)} · ${t('accreditation.workspace.score.grade', { grade: s.grade, label: t(`accred.predicate.${s.grade}`) })}`;
  };

  return (
    <section aria-label={t('accreditation.workspace.history.snapshots.title')} className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">{t('accreditation.workspace.history.snapshots.title')}</h3>
      {list === undefined ? (
        snapshots.isError ? (
          <ProblemAlert error={snapshots.error} />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('accreditation.workspace.history.snapshots.empty')}</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('accreditation.workspace.history.column.created')}</th>
                  <th className="px-3 py-2 font-medium">{t('accreditation.workspace.history.column.score')}</th>
                  <th className="px-3 py-2 font-medium">{t('accreditation.workspace.history.column.prerequisites')}</th>
                  <th className="px-3 py-2 font-medium">{t('accreditation.workspace.history.column.note')}</th>
                  <th className="px-3 py-2 font-medium">{t('accreditation.workspace.history.column.dossier')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id} className="border-t align-top">
                    <td className="px-3 py-2 whitespace-nowrap">{f.dateTime(s.createdAt)}</td>
                    <td className="px-3 py-2 tabular-nums">{estimate(s)}</td>
                    <td className="px-3 py-2">{t(s.prerequisitesMet ? 'accreditation.workspace.prereq.pass' : 'accreditation.workspace.prereq.fail')}</td>
                    <td className="px-3 py-2">{s.note ?? ''}</td>
                    <td className="px-3 py-2">
                      {s.dossierFileId === null ? (
                        <span className="text-muted-foreground">{t('accreditation.workspace.history.dossier.none')}</span>
                      ) : (
                        <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => void downloadDossier(s.id)}>
                          {t('accreditation.workspace.history.dossier.download')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Disclaimer />
        </>
      )}
    </section>
  );
}
