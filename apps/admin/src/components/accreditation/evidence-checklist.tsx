import { vocabKey } from '@altis/shared';
import { MINUTES_EVIDENCE_CODE, type EvidenceListResponse, type IndicatorEvidenceView, type IndicatorResultView } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type JSX } from 'react';
import { EvidenceMinutes } from '@/components/accreditation/evidence-minutes';
import { EvidenceUpload } from '@/components/accreditation/evidence-upload';
import { accredKeys, accredPaths } from '@/components/accreditation/usage/queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { useT, type TKey, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { useApiQuery, useMe } from '@/lib/me';
import { accreditationKeys, keyText } from '@/screens/accreditation/data';

/** The ALTIS screens a screenshot item names, by the key the instrument gives them. */
const SCREENS: Readonly<Record<string, TKey>> = {
  'catalog/records': 'accreditation.workspace.screen.records',
  members: 'accreditation.workspace.screen.members',
  'circulation/desk': 'accreditation.workspace.screen.circulation_desk',
  'opac:/cari': 'accreditation.workspace.screen.opac_search',
  'opac:/': 'accreditation.workspace.screen.opac_home',
};

/** The name of the ALTIS screen a screenshot shows (the key itself for a screen this build does not name). */
export function screenName(t: Translate, screen: string): string {
  const key = SCREENS[screen];
  return key === undefined ? screen : t(key);
}

/**
 * The evidence checklist of one indicator: each item with its kind, whether it is there ("ada") or not yet
 * ("belum"), the ALTIS report that makes a generated item, the ALTIS screen to capture for a screenshot, the files
 * linked to it, and, for an item filled by uploading, the upload (`canUpload`: a manager on an open period). Whether an
 * item is there comes from the period's results (`status`); before the first evaluation it is not shown.
 *
 * A signed document ALTIS drafts (the annual library report behind the routine-reports item) names that report, with a
 * link to make it for the period's span when the user may read the statistics reports.
 *
 * An item that takes the minutes of a stocktake session also links the minutes a finished session stored, without a
 * download and an upload (evidence-minutes.tsx).
 *
 * The same manager removes a file after a confirmation (`DELETE accreditation/evidence/:id`): a wrong upload must not
 * stay in the evidence file and its ZIPs, nor keep the item "ada". The results name a file only; its evidence row comes
 * from the period's evidence list, read once for every checklist of the page.
 */
export function EvidenceChecklist({
  periodId,
  indicatorCode,
  items,
  status,
  canUpload,
  onUploaded,
}: {
  periodId: string;
  indicatorCode: string;
  items: readonly IndicatorEvidenceView[];
  status: IndicatorResultView['evidence'] | undefined;
  canUpload: boolean;
  onUploaded(): void;
}): JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const readsReports = holds(useMe(), 'reports.statistics.read');
  const evidence = useApiQuery<EvidenceListResponse>({ queryKey: accredKeys.evidence(periodId), path: accredPaths.evidence(periodId), enabled: canUpload });
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  // One file can be linked to several items (a session's minutes under two indicators): the row of this item's link.
  const evidenceOf = (fileId: string, itemCode: string): string | undefined =>
    evidence.data?.evidence.find((e) => e.fileId === fileId && e.indicatorCode === indicatorCode && e.evidenceCode === itemCode)?.id;

  const remove = async (id: string): Promise<void> => {
    await api<StoreResponse>('DELETE', `accreditation/evidence/${encodeURIComponent(id)}`);
    // The results, the period (its last change), the evidence lists and the component sizes all moved.
    await queryClient.invalidateQueries({ queryKey: accreditationKeys.all() });
  };

  if (items.length === 0) return <p className="text-sm text-muted-foreground">{t('accreditation.workspace.evidence.empty')}</p>;
  return (
    <ul aria-label={t('accreditation.workspace.evidence.title')} className="grid gap-2">
      {items.map((item) => {
        const state = status?.find((s) => s.code === item.code);
        return (
          <li key={item.code} className="grid gap-1 rounded-md border px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{keyText(t, item.labelKey)}</span>
              {item.primary && <Badge tone="info">{t('accreditation.workspace.evidence.primary')}</Badge>}
              <Badge>{t(vocabKey('evidence_kind', item.kind))}</Badge>
              {state !== undefined && (
                <Badge tone={state.present ? 'info' : 'warning'}>
                  {t(state.present ? 'accreditation.workspace.evidence.present' : 'accreditation.workspace.evidence.absent')}
                </Badge>
              )}
            </div>
            {item.kind === 'generated' && item.reportId !== null && (
              <p className="text-muted-foreground">{t('accreditation.workspace.evidence.generated', { report: keyText(t, `report.${item.reportId}.title`) })}</p>
            )}
            {/* ---- Komunitas K5 (reports): a signed document ALTIS drafts ---- */}
            {item.kind !== 'generated' && item.reportId !== null && (
              <p className="text-muted-foreground">
                {t('accreditation.workspace.evidence.draft', { report: keyText(t, `report.${item.reportId}.title`) })}
                {readsReports && (
                  <>
                    {' '}
                    <Link
                      to={`/admin/reports/${encodeURIComponent(item.reportId)}`}
                      search={{ periodId }}
                      className="text-primary underline-offset-4 hover:underline">
                      {t('accreditation.workspace.evidence.draft_open')}
                    </Link>
                  </>
                )}
              </p>
            )}
            {item.kind === 'screenshot' && item.screen !== null && (
              <p className="text-muted-foreground">{t('accreditation.workspace.evidence.screen', { screen: screenName(t, item.screen) })}</p>
            )}
            {state !== undefined && state.files.length > 0 && (
              <ul className="grid gap-1">
                {state.files.map((file) => {
                  const id = canUpload ? evidenceOf(file.id, item.code) : undefined;
                  return (
                    <li key={file.id} className="flex flex-wrap items-center gap-2">
                      <span>
                        <a href={`/files/${encodeURIComponent(file.id)}`} className="text-primary underline-offset-4 hover:underline">
                          {file.name}
                        </a>
                        {file.caption !== '' && <span className="text-muted-foreground"> · {file.caption}</span>}
                      </span>
                      {id !== undefined && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={t('accreditation.workspace.evidence.remove_named', { name: file.name })}
                          onClick={() => setRemoving({ id, name: file.name })}>
                          {t('accreditation.workspace.evidence.remove')}
                        </Button>
                      )}
                      {removing !== null && removing.id === id && (
                        <ConfirmDialog
                          open
                          destructive
                          title={t('accreditation.workspace.evidence.confirm.title', { name: removing.name })}
                          description={t('accreditation.workspace.evidence.confirm.body')}
                          confirmLabel={t('accreditation.workspace.evidence.remove')}
                          onConfirm={() => remove(removing.id)}
                          onClose={() => setRemoving(null)}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {canUpload && item.kind !== 'generated' && (
              <div className="flex flex-wrap gap-2">
                <EvidenceUpload
                  periodId={periodId}
                  indicatorCode={indicatorCode}
                  evidenceCode={item.code}
                  label={t('accreditation.workspace.evidence.upload')}
                  onDone={onUploaded}
                />
                {/* ---- the stocktake minutes as evidence: the stored minutes of a finished session ---- */}
                {item.code === MINUTES_EVIDENCE_CODE && <EvidenceMinutes periodId={periodId} indicatorCode={indicatorCode} onDone={onUploaded} />}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
