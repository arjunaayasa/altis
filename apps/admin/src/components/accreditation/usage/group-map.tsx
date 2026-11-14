import { ACCRED_GROUPS, type AccredGroup } from '@altis/shared';
import type { UsageGroupsPutBody, UsageGroupsView } from '@altis/shared/api/accreditation';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Notice, RefetchProblem, SELECT_CLASS } from '@/components/form-field';
import { useT, type Translate } from '@/i18n';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery } from '@/lib/me';
import { useRetryKey } from '@/screens/catalog/exchange/summary-view';
import { accredKeys, accredPaths } from './queries';

/**
 * The member-type mapping (spec §10.7, §11.1 `memberTypeGroups`/`unknownMemberGroup`): the accreditation group each
 * SLiMS member type counts in, and the group of the members SLiMS no longer has ("anggota terhapus",
 * `member_unknown`). A change is saved at once (`PUT accreditation/usage-groups`, one row) and the usage table reads it
 * whenever it is read, so no new import is needed. The mapping belongs to the whole installation, so a frozen period
 * does not stop it. While the mapping has no row for the deleted members it shows the group the setting gives them.
 */

const UNKNOWN = 'member_unknown';
const TYPE_PREFIX = 'slims_type:';

type Row = UsageGroupsView['groups'][number];

/** The label of a mapping row: the SLiMS type's name (or its id), or the deleted members. */
export function groupRowLabel(t: Translate, row: Pick<Row, 'groupKey' | 'label'>): string {
  if (row.groupKey === UNKNOWN) return t('accreditation.usage.groups.unknown');
  if (row.label !== null && row.label.trim() !== '') return row.label;
  const id = row.groupKey.startsWith(TYPE_PREFIX) ? row.groupKey.slice(TYPE_PREFIX.length) : row.groupKey;
  return t('accreditation.usage.groups.type_id', { id });
}

/** A select of the accreditation groups, with "Tidak dihitung" for null. */
export function AccredGroupSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: AccredGroup | null;
  disabled: boolean;
  onChange(group: AccredGroup | null): void;
}) {
  const t = useT();
  return (
    <select
      aria-label={label}
      className={SELECT_CLASS}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? null : (e.target.value as AccredGroup))}
    >
      <option value="">{t('accreditation.usage.groups.none')}</option>
      {ACCRED_GROUPS.map((g) => (
        <option key={g} value={g}>
          {t(`vocab.accred_group.${g}`)}
        </option>
      ))}
    </select>
  );
}

export interface GroupMapProps {
  /** The user may manage accreditation. */
  editable: boolean;
  /** The group of the deleted members while the mapping has no row for them (`accreditation.unknownMemberGroup.default`). */
  unknownDefault: AccredGroup | null;
  /** The period whose usage table and results a change makes stale. */
  periodId: string;
  /** The heading and its introduction (the mapping's own by default). */
  title?: string;
  intro?: string;
}

type Outcome = { kind: 'saved'; label: string } | { kind: 'error'; error: unknown } | null;

export function GroupMap({ editable, unknownDefault, periodId, title, intro }: GroupMapProps) {
  const t = useT();
  const titleId = useId();
  const queryClient = useQueryClient();
  const retryKey = useRetryKey('accreditation-usage-groups');
  const query = useApiQuery<UsageGroupsView>({ queryKey: accredKeys.usageGroups(), path: accredPaths.usageGroups() });
  /** The group chosen for a row until the mapping is read again. */
  const [chosen, setChosen] = useState<Readonly<Record<string, AccredGroup | null>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const rows: Row[] = [...(query.data?.groups ?? [])];
  if (query.data !== undefined && !rows.some((r) => r.groupKey === UNKNOWN)) {
    rows.push({ groupKey: UNKNOWN, label: null, accredGroup: unknownDefault, updatedAt: 0 });
  }
  const types = rows.filter((r) => r.groupKey !== UNKNOWN);

  const change = async (row: Row, accredGroup: AccredGroup | null): Promise<void> => {
    const label = groupRowLabel(t, row);
    const before = Object.prototype.hasOwnProperty.call(chosen, row.groupKey) ? chosen[row.groupKey]! : row.accredGroup;
    setChosen((current) => ({ ...current, [row.groupKey]: accredGroup }));
    setBusy(row.groupKey);
    setOutcome(null);
    const body: UsageGroupsPutBody = { groups: [{ groupKey: row.groupKey, accredGroup }] };
    try {
      await api('PUT', accredPaths.usageGroups(), body, { idempotencyKey: retryKey.key(body) });
      retryKey.clear();
      setOutcome({ kind: 'saved', label });
      void queryClient.invalidateQueries({ queryKey: accredKeys.usageGroups() });
      void queryClient.invalidateQueries({ queryKey: accredKeys.usage(periodId) });
      void queryClient.invalidateQueries({ queryKey: accredKeys.results(periodId) });
    } catch (e) {
      setChosen((current) => ({ ...current, [row.groupKey]: before }));
      setOutcome({ kind: 'error', error: e });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby={titleId} className="grid gap-3">
      <div className="grid gap-1">
        <h3 id={titleId} className="text-base font-semibold">
          {title ?? t('accreditation.usage.groups.title')}
        </h3>
        <p className="text-sm text-muted-foreground">{intro ?? t('accreditation.usage.groups.intro')}</p>
      </div>
      <RefetchProblem query={query} />
      {query.data === undefined ? (
        query.isError ? (
          <Notice kind="error">{problemText(t, query.error)}</Notice>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )
      ) : (
        <>
          {types.length === 0 && <p className="text-sm text-muted-foreground">{t('accreditation.usage.groups.empty')}</p>}
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                    {t('accreditation.usage.groups.col_type')}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                    {t('accreditation.usage.groups.col_group')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const label = groupRowLabel(t, row);
                  const value = Object.prototype.hasOwnProperty.call(chosen, row.groupKey) ? chosen[row.groupKey]! : row.accredGroup;
                  return (
                    <tr key={row.groupKey} data-group-key={row.groupKey} className="border-t">
                      <th scope="row" className="px-3 py-2 text-left align-top font-normal">
                        <span className="grid gap-0.5">
                          <span>{label}</span>
                          {row.groupKey === UNKNOWN && <span className="text-xs text-muted-foreground">{t('accreditation.usage.groups.unknown_hint')}</span>}
                        </span>
                      </th>
                      <td className="px-3 py-2 align-top">
                        <div className="max-w-xs">
                          <AccredGroupSelect
                            label={t('accreditation.usage.groups.select', { type: label })}
                            value={value}
                            disabled={!editable || busy !== null}
                            onChange={(g) => void change(row, g)}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {outcome?.kind === 'saved' && <Notice kind="success">{t('accreditation.usage.groups.saved', { type: outcome.label })}</Notice>}
          {outcome?.kind === 'error' && <Notice kind="error">{problemText(t, outcome.error)}</Notice>}
        </>
      )}
    </section>
  );
}
