import { SERVICE_CODES, vocabKey, type ServiceCode } from '@altis/shared';
import type { PeriodView } from '@altis/shared/api/accreditation';
import { useState, type FormEvent, type JSX } from 'react';
import { CheckField } from '@/components/form-field';
import { useT, type TKey } from '@/i18n';
import { useDirtyGuard } from '@/lib/dirty-forms';
import {
  FormSection,
  PeriodFormFooter,
  StaleNote,
  TextField,
  numberText,
  textOrNull,
  usePeriodSave,
  usePeriodValues,
  wholeOrNull,
  type PeriodFormModel,
  type PeriodPatch,
  type PeriodSaving,
} from '../period-form';
import { ReadOnlyNote, TabState, type TabContext } from '../tab-state';

/**
 * Populasi & Sarana (spec §6 "Akreditasi", §10.5, §10.6): the school population of the period from Dapodik/EMIS
 * (students, teachers, education staff, classes; or the population a non-school library serves), the teachers who use
 * the library, the statement that every member of the school is registered as a library member (only then may member
 * counts stand in for the population, and every sheet that uses them prints it), the facilities (computers for users
 * and staff, the library's ICT devices, barcode scanners, floor area, bandwidth, weekly service hours), the services,
 * and the address of a library website outside ALTIS. Only the fields changed are sent; a frozen period is read only.
 */
export function PopulationTab(props: { periodId: string }): JSX.Element {
  return <TabState periodId={props.periodId}>{(ctx) => <PopulationPanel ctx={ctx} />}</TabState>;
}

/** The form starts over for another period; the save's outcome is kept above it. */
function PopulationPanel({ ctx }: { ctx: TabContext }) {
  const saving = usePeriodSave();
  return <PopulationForm key={ctx.period.id} ctx={ctx} saving={saving} />;
}

/** The whole-number fields of the tab, with their labels, hints and upper bounds. */
const NUMBERS = [
  { name: 'students', label: 'accreditation.workspace.population.students', max: 2_147_483_647 },
  { name: 'teachers', label: 'accreditation.workspace.population.teachers', max: 2_147_483_647 },
  { name: 'eduStaff', label: 'accreditation.workspace.population.edu_staff', max: 2_147_483_647 },
  { name: 'classes', label: 'accreditation.workspace.population.classes', max: 2_147_483_647 },
  { name: 'populationServed', label: 'accreditation.workspace.population.population_served', max: 2_147_483_647 },
  { name: 'teachersUsing', label: 'accreditation.workspace.population.teachers_using', max: 2_147_483_647 },
  { name: 'userPcs', label: 'accreditation.workspace.population.user_pcs', max: 32_767 },
  { name: 'staffPcs', label: 'accreditation.workspace.population.staff_pcs', max: 32_767 },
  { name: 'ictDevices', label: 'accreditation.workspace.population.ict_devices', max: 32_767, hint: 'accreditation.workspace.population.ict_devices_hint' },
  { name: 'scanners', label: 'accreditation.workspace.population.scanners', max: 32_767 },
  { name: 'floorM2', label: 'accreditation.workspace.population.floor_m2', max: 2_147_483_647 },
  { name: 'bandwidthMbps', label: 'accreditation.workspace.population.bandwidth', max: 2_147_483_647 },
  { name: 'hoursPerWeek', label: 'accreditation.workspace.population.hours', max: 168 },
] as const satisfies readonly { name: keyof PeriodView; label: TKey; max: number; hint?: TKey }[];

type NumberName = (typeof NUMBERS)[number]['name'];

const POPULATION: readonly NumberName[] = ['students', 'teachers', 'eduStaff', 'classes', 'populationServed', 'teachersUsing'];
const FACILITIES: readonly NumberName[] = ['userPcs', 'staffPcs', 'ictDevices', 'scanners', 'floorM2', 'bandwidthMbps', 'hoursPerWeek'];

interface Values {
  numbers: Record<NumberName, string>;
  allRegisteredConfirmed: boolean;
  services: readonly ServiceCode[];
  externalWebsiteUrl: string;
}

function valuesOf(p: PeriodView): Values {
  const numbers = {} as Record<NumberName, string>;
  for (const { name } of NUMBERS) numbers[name] = numberText(p[name]);
  return { numbers, allRegisteredConfirmed: p.allRegisteredConfirmed, services: p.services ?? [], externalWebsiteUrl: p.externalWebsiteUrl ?? '' };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/**
 * What `values` would send for `period`: the fields refused before anything is sent, and the patch of the fields that
 * differ from the stored ones (empty: nothing to save).
 */
function populationPatch(values: Values, period: PeriodView): { found: Record<string, string>; patch: PeriodPatch } {
  const found: Record<string, string> = {};
  const patch: Record<string, unknown> = {};
  for (const { name, max } of NUMBERS) {
    const n = wholeOrNull(values.numbers[name], 0, max);
    if (n === 'invalid') found[name] = 'form.error.invalid';
    else if (n !== period[name]) patch[name] = n;
  }
  if (values.allRegisteredConfirmed !== period.allRegisteredConfirmed) patch['allRegisteredConfirmed'] = values.allRegisteredConfirmed;
  if (!sameSet(values.services, period.services ?? [])) patch['services'] = SERVICE_CODES.filter((c) => values.services.includes(c));
  const url = textOrNull(values.externalWebsiteUrl);
  if (url !== period.externalWebsiteUrl) patch['externalWebsiteUrl'] = url;
  return { found, patch: patch as PeriodPatch };
}

/** `values` over a newer period made on this page: what was typed stays, every other field takes its value in `after`. */
function rebased(values: Values, before: Values, after: Values): Values {
  const numbers = { ...values.numbers };
  for (const { name } of NUMBERS) if (values.numbers[name] === before.numbers[name]) numbers[name] = after.numbers[name];
  return {
    numbers,
    allRegisteredConfirmed: values.allRegisteredConfirmed === before.allRegisteredConfirmed ? after.allRegisteredConfirmed : values.allRegisteredConfirmed,
    services: sameSet(values.services, before.services) ? after.services : values.services,
    externalWebsiteUrl: values.externalWebsiteUrl === before.externalWebsiteUrl ? after.externalWebsiteUrl : values.externalWebsiteUrl,
  };
}

const POPULATION_MODEL: PeriodFormModel<Values> = { valuesOf, pending: populationPatch, rebased };

function PopulationForm({ ctx, saving }: { ctx: TabContext; saving: PeriodSaving }) {
  const t = useT();
  // The values and the period they were read from (period-form.tsx): a save names that period's version, so a change
  // made elsewhere meanwhile is refused as stale instead of being overwritten.
  const form = usePeriodValues(ctx.period, saving, POPULATION_MODEL);
  const { values, setValues } = form;
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const { save, busy, problem, outcome, serverErrors } = saving;
  const off = !ctx.canEdit || busy;
  const errorOf = (name: string): string | undefined => errors[name] ?? serverErrors[name];
  useDirtyGuard(ctx.canEdit && form.dirty);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!ctx.canEdit) return;
    const sent = form.base;
    const { found, patch } = populationPatch(values, sent);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const toField = (path: string): string | null => (path in values.numbers || path === 'externalWebsiteUrl' || path === 'services' ? path : null);
    void save(sent, patch, toField, (version) => form.stored(sent, patch, version));
  };

  const number = (name: NumberName) => {
    const field = NUMBERS.find((n) => n.name === name)!;
    return (
      <TextField
        key={name}
        type="number"
        label={t(field.label)}
        hint={'hint' in field ? t(field.hint) : undefined}
        value={values.numbers[name]}
        error={errorOf(name)}
        disabled={off}
        onChange={(v) => setValues((s) => ({ ...s, numbers: { ...s.numbers, [name]: v } }))}
      />
    );
  };

  return (
    <form noValidate onSubmit={submit} className="grid max-w-5xl">
      <ReadOnlyNote ctx={ctx} />
      <StaleNote values={form} />
      <FormSection title={t('accreditation.workspace.population.section.population')} hint={t('accreditation.workspace.population.section.population_hint')}>
        {POPULATION.map(number)}
        <CheckField
          className="sm:col-span-full"
          label={t('accreditation.workspace.population.all_registered')}
          hint={t('accreditation.workspace.population.all_registered_hint')}
          checked={values.allRegisteredConfirmed}
          disabled={off}
          onChange={(e) => setValues((s) => ({ ...s, allRegisteredConfirmed: e.target.checked }))}
        />
      </FormSection>
      <FormSection title={t('accreditation.workspace.population.section.facilities')}>{FACILITIES.map(number)}</FormSection>
      <FormSection title={t('accreditation.workspace.population.section.services')}>
        <div role="group" aria-label={t('accreditation.workspace.population.services')} className="grid gap-2 sm:col-span-full sm:grid-cols-2">
          {SERVICE_CODES.map((code) => (
            <CheckField
              key={code}
              label={t(vocabKey('service_code', code))}
              checked={values.services.includes(code)}
              disabled={off}
              onChange={(e) =>
                setValues((s) => ({ ...s, services: e.target.checked ? [...s.services, code] : s.services.filter((c) => c !== code) }))
              }
            />
          ))}
        </div>
        {errorOf('services') !== undefined && <p className="text-meta font-semibold text-bad sm:col-span-full">{t(errorOf('services') as TKey)}</p>}
        <TextField
          type="url"
          label={t('accreditation.workspace.population.external_url')}
          hint={t('accreditation.workspace.population.external_url_hint')}
          value={values.externalWebsiteUrl}
          error={errorOf('externalWebsiteUrl')}
          disabled={off}
          maxLength={191}
          onChange={(v) => setValues((s) => ({ ...s, externalWebsiteUrl: v }))}
        />
      </FormSection>
      <PeriodFormFooter canEdit={ctx.canEdit} busy={busy} problem={problem} outcome={outcome} />
    </form>
  );
}
