import { vocabKey } from '@altis/shared';
import type { IndicatorEvidenceView, IndicatorResultView } from '@altis/shared/api/accreditation';
import type { JSX } from 'react';
import { EvidenceUpload } from '@/components/accreditation/evidence-upload';
import { Badge } from '@/components/form-field';
import { useT, type TKey, type Translate } from '@/i18n';
import { keyText } from '@/screens/accreditation/data';

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
            {item.kind === 'screenshot' && item.screen !== null && (
              <p className="text-muted-foreground">{t('accreditation.workspace.evidence.screen', { screen: screenName(t, item.screen) })}</p>
            )}
            {state !== undefined && state.files.length > 0 && (
              <ul className="grid gap-0.5">
                {state.files.map((file) => (
                  <li key={file.id}>
                    <a href={`/files/${encodeURIComponent(file.id)}`} className="text-primary underline-offset-4 hover:underline">
                      {file.name}
                    </a>
                    {file.caption !== '' && <span className="text-muted-foreground"> · {file.caption}</span>}
                  </li>
                ))}
              </ul>
            )}
            {canUpload && item.kind !== 'generated' && (
              <div>
                <EvidenceUpload
                  periodId={periodId}
                  indicatorCode={indicatorCode}
                  evidenceCode={item.code}
                  label={t('accreditation.workspace.evidence.upload')}
                  onDone={onUploaded}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
