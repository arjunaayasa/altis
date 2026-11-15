import { ACCRED_GROUPS, type AccredGroup } from '@altis/shared';
import {
  CIRCULATION_MODES,
  FINE_MODES,
  MEMBERS_MODES,
  type MigrationDryList,
  type MigrationMatchRow,
  type MigrationMemberType,
  type SlimsCutoverView,
  type SlimsPeopleOptions,
} from '@altis/shared/api/catalog/migration';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CheckCircle2Icon, CircleIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Badge, CheckField, Field, Notice, NoticeAlert, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type TKey } from '@/i18n';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery } from '@/lib/me';
import { useMemberTypes, useTypeName } from '@/screens/circulation/common';

/**
 * The members, visits and circulation of Migrasi SLiMS (the migration's member, staff, visit and circulation stages):
 *
 * - {@link PeopleFields}: the options of a run: how a re-run treats the members it mapped before ("Tambah anggota baru
 *   saja" or "Selaraskan anggota dengan SLiMS", which keeps the fields edited in ALTIS), how circulation comes over
 *   ("Tambah" or "Ganti", the move on the last day), fines in whole rupiah or minor units, visits before a date (or
 *   "otomatis": before the first visit ALTIS recorded itself), the gender, the staff accounts, the SLiMS type limit as
 *   the type's total limit, the default member type, and, once a dry run listed the SLiMS member types, the
 *   accreditation group of each (guessed from its name, editable).
 * - {@link MatchesReport}: "Cocokkan dengan SLiMS", each number of the source against ALTIS after a real run.
 * - {@link CutoverChecklist}: what holds "Mulai melayani" back, and the button itself.
 */

/** The people options as the wizard edits them (every field set). */
export interface PeopleDraft {
  membersMode: (typeof MEMBERS_MODES)[number];
  circulationMode: (typeof CIRCULATION_MODES)[number];
  fineMode: (typeof FINE_MODES)[number];
  /** `auto` or a date `YYYY-MM-DD`. */
  visitsBefore: string;
  migrateGender: boolean;
  staffUsers: boolean;
  typeLimitAsTotal: boolean;
  defaultMemberTypeId: string;
  memberTypeGroups: Record<string, AccredGroup>;
}

export const EMPTY_PEOPLE: PeopleDraft = {
  membersMode: 'append',
  circulationMode: 'append',
  fineMode: 'major',
  visitsBefore: 'auto',
  migrateGender: false,
  staffUsers: true,
  typeLimitAsTotal: false,
  defaultMemberTypeId: '',
  memberTypeGroups: {},
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The draft from a run's stored options (a dry run's, for its real run). */
export function peopleDraftOf(p: SlimsPeopleOptions | undefined): PeopleDraft {
  return {
    membersMode: p?.membersMode ?? 'append',
    circulationMode: p?.circulationMode ?? 'append',
    fineMode: p?.fineMode ?? 'major',
    visitsBefore: p?.visitsBefore ?? 'auto',
    migrateGender: p?.migrateGender ?? false,
    staffUsers: p?.staffUsers ?? true,
    typeLimitAsTotal: p?.typeLimitAsTotal ?? false,
    defaultMemberTypeId: p?.defaultMemberTypeId ?? '',
    memberTypeGroups: { ...(p?.memberTypeGroups ?? {}) },
  };
}

/** The `people` of a start body: the fields that differ from their defaults (none: no `people` at all). */
export function peopleBody(d: PeopleDraft): { people: SlimsPeopleOptions } | Record<string, never> {
  const p: SlimsPeopleOptions = {};
  if (d.membersMode !== 'append') p.membersMode = d.membersMode;
  if (d.circulationMode !== 'append') p.circulationMode = d.circulationMode;
  if (d.fineMode !== 'major') p.fineMode = d.fineMode;
  if (d.visitsBefore !== 'auto' && DATE.test(d.visitsBefore)) p.visitsBefore = d.visitsBefore;
  if (d.migrateGender) p.migrateGender = true;
  if (!d.staffUsers) p.staffUsers = false;
  if (d.typeLimitAsTotal) p.typeLimitAsTotal = true;
  if (d.defaultMemberTypeId !== '') p.defaultMemberTypeId = d.defaultMemberTypeId;
  if (Object.keys(d.memberTypeGroups).length > 0) p.memberTypeGroups = d.memberTypeGroups;
  return Object.keys(p).length === 0 ? {} : { people: p };
}

function Radios<V extends string>({ legend, values, value, label, onChange, children }: { legend: string; values: readonly V[]; value: V; label(v: V): string; onChange(v: V): void; children?: ReactNode }) {
  const name = useId();
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {values.map((v) => (
        <div key={v} className="flex items-center gap-2">
          <input id={`${name}-${v}`} type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} className="size-4 accent-primary" />
          <label htmlFor={`${name}-${v}`} className="text-sm">
            {label(v)}
          </label>
        </div>
      ))}
      {children}
    </fieldset>
  );
}

/** The options of the member, visit and circulation stages (see the top of this file). */
export function PeopleFields({ value, onChange, memberTypes }: { value: PeopleDraft; onChange(next: PeopleDraft): void; memberTypes?: readonly MigrationMemberType[] }) {
  const t = useT();
  const types = useMemberTypes();
  const typeName = useTypeName();
  const set = <K extends keyof PeopleDraft>(k: K, v: PeopleDraft[K]): void => onChange({ ...value, [k]: v });
  const auto = value.visitsBefore === 'auto';
  return (
    <div className="flex flex-col gap-4 border-t pt-4">
      <h3 className="text-sm font-semibold">{t('catalog.migration.people.title')}</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <Radios
          legend={t('catalog.migration.people.members_mode')}
          values={MEMBERS_MODES}
          value={value.membersMode}
          label={(v) => t(`catalog.migration.people.members_mode.${v}`)}
          onChange={(v) => set('membersMode', v)}
        >
          <p className="text-xs text-muted-foreground">{t(`catalog.migration.people.members_mode.${value.membersMode}_hint`)}</p>
        </Radios>
        <Radios
          legend={t('catalog.migration.people.circulation_mode')}
          values={CIRCULATION_MODES}
          value={value.circulationMode}
          label={(v) => t(`catalog.migration.people.circulation_mode.${v}`)}
          onChange={(v) => set('circulationMode', v)}
        >
          <p className="text-xs text-muted-foreground">{t(`catalog.migration.people.circulation_mode.${value.circulationMode}_hint`)}</p>
        </Radios>
        <Field label={t('catalog.migration.people.fine_mode')}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} value={value.fineMode} onChange={(e) => set('fineMode', e.target.value as PeopleDraft['fineMode'])}>
              {FINE_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`catalog.migration.people.fine_mode.${m}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('catalog.migration.people.default_type')} hint={t('catalog.migration.people.default_type_hint')}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} value={value.defaultMemberTypeId} onChange={(e) => set('defaultMemberTypeId', e.target.value)}>
              <option value="">{t('catalog.migration.people.default_type_none')}</option>
              {(types.data?.items ?? []).map((type) => (
                <option key={type.id} value={type.id}>
                  {`${typeName(type)} (${type.code})`}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="grid gap-2">
          <CheckField label={t('catalog.migration.people.visits_auto')} hint={t('catalog.migration.people.visits_auto_hint')} checked={auto} onChange={(e) => set('visitsBefore', e.target.checked ? 'auto' : '')} />
          {!auto && (
            <Field label={t('catalog.migration.people.visits_before')} error={DATE.test(value.visitsBefore) ? undefined : 'catalog.migration.people.visits_before_required'}>
              {(c) => <Input {...c} type="date" value={value.visitsBefore} onChange={(e) => set('visitsBefore', e.target.value)} />}
            </Field>
          )}
        </div>
        <div className="grid gap-2">
          <CheckField label={t('catalog.migration.people.staff_users')} hint={t('catalog.migration.people.staff_users_hint')} checked={value.staffUsers} onChange={(e) => set('staffUsers', e.target.checked)} />
          <CheckField label={t('catalog.migration.people.migrate_gender')} hint={t('catalog.migration.people.migrate_gender_hint')} checked={value.migrateGender} onChange={(e) => set('migrateGender', e.target.checked)} />
          <CheckField label={t('catalog.migration.people.type_limit')} hint={t('catalog.migration.people.type_limit_hint')} checked={value.typeLimitAsTotal} onChange={(e) => set('typeLimitAsTotal', e.target.checked)} />
        </div>
      </div>
      {memberTypes !== undefined && memberTypes.length > 0 && (
        <div className="grid gap-2">
          <h4 className="text-sm font-medium">{t('catalog.migration.people.groups')}</h4>
          <p className="text-xs text-muted-foreground">{t('catalog.migration.people.groups_hint')}</p>
          <table className="text-sm">
            <tbody>
              {memberTypes.map((type) => (
                <tr key={type.id} className="border-t">
                  <td className="py-1 pr-3">{`${type.name} (${type.id})`}</td>
                  <td className="py-1 pr-3 text-right text-muted-foreground tabular-nums">{t('catalog.migration.people.members_count', { count: String(type.members) })}</td>
                  <td className="py-1">
                    <select
                      aria-label={t('catalog.migration.people.group_of', { name: type.name })}
                      className={SELECT_CLASS}
                      value={value.memberTypeGroups[type.id] ?? type.group}
                      onChange={(e) => set('memberTypeGroups', { ...value.memberTypeGroups, [type.id]: e.target.value as AccredGroup })}
                    >
                      {ACCRED_GROUPS.map((g) => (
                        <option key={g} value={g}>
                          {t(`vocab.accred_group.${g}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** "Cocokkan dengan SLiMS": each number of the source against ALTIS (a real run's summary). */
export function MatchesReport({ matches, collisions }: { matches: readonly MigrationMatchRow[] | undefined; collisions: number | undefined }) {
  const t = useT();
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale === 'en' ? 'en' : 'id');
  const n = (v: number): string => number.format(v);
  const titleId = useId();
  return (
    <>
      {collisions !== undefined && collisions > 0 && <Notice kind="error">{t('catalog.migration.people.collisions', { count: n(collisions) })}</Notice>}
      {matches !== undefined && (
        <section aria-labelledby={titleId} className="flex flex-col gap-2">
          <h3 id={titleId} className="text-sm font-semibold">
            {t('catalog.migration.people.matches')}
          </h3>
          <p className="text-xs text-muted-foreground">{t('catalog.migration.people.matches_hint')}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">{t('catalog.migration.people.col_number')}</th>
                  <th className="py-1 pr-3 text-right font-medium">SLiMS</th>
                  <th className="py-1 pr-3 text-right font-medium">ALTIS</th>
                  <th className="py-1 pr-3 text-right font-medium">{t('catalog.migration.people.col_explained')}</th>
                  <th className="py-1 font-medium">{t('catalog.migration.people.col_status')}</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m) => (
                  <tr key={`${m.key}:${m.scope}`} className="border-t" data-match={m.ok ? 'ok' : 'diff'}>
                    <td className="py-1 pr-3">
                      {t(`migration.match.${m.key}`)}
                      {m.scope !== '' && <span className="text-muted-foreground">{` · ${m.scope}`}</span>}
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums">{n(m.source)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{n(m.altis)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{n(m.explained)}</td>
                    <td className="py-1">{m.ok ? <Badge tone="info">{t('catalog.migration.people.match_ok')}</Badge> : <Badge tone="danger">{t('catalog.migration.people.match_diff')}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

/** The lists a dry run gives to check before the real run: each with its count and a few samples (a dry run's summary). */
export function DryListsReport({ lists }: { lists: readonly MigrationDryList[] | undefined }) {
  const t = useT();
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale === 'en' ? 'en' : 'id');
  const titleId = useId();
  if (lists === undefined || lists.length === 0) return null;
  const missing = lists.find((x) => x.key === 'open_loan_item_missing');
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3 id={titleId} className="text-sm font-semibold">
        {t('catalog.migration.people.dry_lists')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('catalog.migration.people.dry_lists_hint')}</p>
      {missing !== undefined && missing.count > 0 && <Notice kind="error">{t('catalog.migration.people.item_missing_hint')}</Notice>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3 font-medium">{t('catalog.migration.people.col_list')}</th>
              <th className="py-1 pr-3 text-right font-medium">{t('catalog.migration.people.col_count')}</th>
              <th className="py-1 font-medium">{t('catalog.migration.people.col_samples')}</th>
            </tr>
          </thead>
          <tbody>
            {lists.map((x) => (
              <tr key={x.key} className="border-t align-top" data-dry-list={x.key}>
                <td className="py-1 pr-3">{t(`migration.dry.${x.key}`)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{number.format(x.count)}</td>
                <td className="py-1 font-mono text-xs break-words">{x.samples.length === 0 ? '—' : x.samples.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const CUTOVER_KEY = ['catalog', 'migrations', 'slims', 'cutover'] as const;

function Item({ done, required, children }: { done: boolean; required: boolean; children: ReactNode }) {
  const t = useT();
  return (
    <li className="flex items-start gap-2" data-done={done ? 'yes' : 'no'}>
      {done ? <CheckCircle2Icon aria-hidden="true" className="mt-0.5 size-4 text-primary" /> : <CircleIcon aria-hidden="true" className="mt-0.5 size-4 text-muted-foreground" />}
      <span className="text-sm">
        {children}
        {!required && <span className="text-muted-foreground">{` (${t('catalog.migration.people.optional')})`}</span>}
      </span>
    </li>
  );
}

/** The cut-over checklist and "Mulai melayani" (see the top of this file). */
export function CutoverChecklist() {
  const t = useT();
  const titleId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const view = useApiQuery<SlimsCutoverView>({ queryKey: CUTOVER_KEY, path: 'catalog/migrations/slims/cutover' });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const v = view.data;
  if (view.isError) return <ProblemAlert error={view.error} />;
  if (v === undefined || v.runId === null) return null;

  const step = async (s: 'reprint_opened' | 'serve'): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const next = await api<SlimsCutoverView>('POST', 'catalog/migrations/slims/cutover/steps', { step: s });
      queryClient.setQueryData(CUTOVER_KEY, next);
      if (s === 'reprint_opened') void navigate({ to: '/admin/reports/$reportId', params: { reportId: 'members.reprint_list' } });
    } catch (e) {
      setFailure(problemText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const items: { done: boolean; required: boolean; text: TKey; extra?: ReactNode }[] = [
    { done: v.deskStaff >= 1, required: true, text: 'catalog.migration.people.check_staff' },
    { done: v.roomsWithStation >= v.rooms, required: true, text: 'catalog.migration.people.check_stations' },
    {
      done: v.reprintOpenedAt !== null,
      required: true,
      text: 'catalog.migration.people.check_reprint',
      extra: (
        <Button type="button" variant="link" size="sm" className="h-auto px-1" disabled={busy} onClick={() => void step('reprint_opened')}>
          {t('catalog.migration.people.open_reprint')}
        </Button>
      ),
    },
    { done: v.reconciled, required: true, text: 'catalog.migration.people.check_reconciled' },
    { done: false, required: false, text: 'catalog.migration.people.check_override' },
  ];

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <h2 id={titleId} className="text-base font-semibold">
        {t('catalog.migration.people.cutover_title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('catalog.migration.people.cutover_hint')}</p>
      {!v.stocktakeAvailable && <NoticeAlert>{t('catalog.migration.people.stocktake_warning')}</NoticeAlert>}
      {v.circulationLive && <NoticeAlert>{t('catalog.migration.people.circulation_live')}</NoticeAlert>}
      <ul className="flex flex-col gap-2">
        {items.map((i) => (
          <Item key={i.text} done={i.done} required={i.required}>
            {t(i.text, { rooms: String(v.rooms), withStation: String(v.roomsWithStation), staff: String(v.deskStaff) })}
            {i.extra}
          </Item>
        ))}
      </ul>
      {failure !== null && <Notice kind="error">{failure}</Notice>}
      {v.servingSince !== null ? (
        <NoticeAlert tone="success">{t('catalog.migration.people.serving', { since: new Date(v.servingSince).toLocaleDateString() })}</NoticeAlert>
      ) : (
        <div>
          <Button type="button" disabled={!v.ready || busy} onClick={() => void step('serve')}>
            {t('catalog.migration.people.serve')}
          </Button>
          {!v.ready && <p className="mt-1 text-xs text-muted-foreground">{t('catalog.migration.people.serve_held')}</p>}
        </div>
      )}
    </section>
  );
}
