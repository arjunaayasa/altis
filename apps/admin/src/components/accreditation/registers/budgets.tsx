import type { Locale } from '@altis/shared';
import { BudgetBody, BudgetPatchBody, type BudgetView } from '@altis/shared/api/accreditation';
import type { CatalogConfigView } from '@altis/shared/api/settings';
import { useForm } from 'react-hook-form';
import { Field, ProblemAlert, RootError, TEXTAREA_CLASS } from '@/components/form-field';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type TKey } from '@/i18n';
import { holds } from '@/lib/access';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { useApiQuery, useMe } from '@/lib/me';
import { changedFields, type FieldIssue } from '@/screens/catalog/masters/master-table';
import {
  FormButtons,
  RegisterSection,
  intOrText,
  longOrNull,
  registerKey,
  useRegisterList,
  useRegisterSave,
  type RegisterColumn,
  type RegisterFormProps,
} from './register-table';

/**
 * The budgets register (`accreditation/budgets`): one row per year (a second live row of the same year is refused with
 * `taken` on the year), the library's budget and the parent institution's (whole, and without staff costs,
 * maintenance and building upkeep: the base of the library's share), the collection and user-activity budgets.
 *
 * Money is typed in major units (`6.500.000`, `Rp 6.500.000`, `6,500,000.50`) and sent in minor units with its currency:
 * every currency has two minor digits here, as everywhere in ALTIS, so Rp 6.500.000 is 650 000 000.
 */

/** A typed amount: its minor units (null when blank), or not an amount. */
export type ParsedAmount = { ok: true; minor: number | null } | { ok: false };

/** A currency written before the amount: `Rp`, `Rp.`, a three-letter code, or a sign. */
const CURRENCY_PREFIX = /^(?:rp\.?|[a-z]{3}\b|[$€£¥])\s*/i;
/** The most integer digits of an amount (its minor units stay a safe integer). */
const INTEGER_DIGITS_MAX = 13;

/**
 * An amount in major units as minor units (two decimals). Grouping and decimal marks are read in either convention:
 * with both marks the last one is the decimal mark; a single mark followed by exactly three digits groups thousands
 * (`1.500` is 1 500), followed by one or two digits it is the decimal mark (`12,5` is 12.50); a mark used twice groups.
 * Groups after the first have exactly three digits. Spaces and a leading currency are ignored.
 */
export function parseMajorAmount(text: string): ParsedAmount {
  const s = text
    .trim()
    .replace(CURRENCY_PREFIX, '')
    .replace(/[\s\u00a0\u202f]/g, '');
  if (s === '') return { ok: true, minor: null };
  if (!/^\d[\d.,]*$/.test(s) || !/\d$/.test(s)) return { ok: false };
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decimal: '.' | ',' | null = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decimal = lastDot > lastComma ? '.' : ',';
  } else if (lastDot >= 0 || lastComma >= 0) {
    const mark = lastDot >= 0 ? '.' : ',';
    const uses = s.split(mark).length - 1;
    if (uses === 1 && s.length - s.lastIndexOf(mark) - 1 !== 3) decimal = mark;
  }
  let integer = s;
  let fraction = '';
  if (decimal !== null) {
    const at = s.lastIndexOf(decimal);
    integer = s.slice(0, at);
    fraction = s.slice(at + 1);
    if (fraction.length < 1 || fraction.length > 2 || integer.includes(decimal)) return { ok: false };
  }
  const group = decimal === '.' ? ',' : decimal === ',' ? '.' : integer.includes('.') ? '.' : integer.includes(',') ? ',' : null;
  if (group !== null && integer.includes(group)) {
    const parts = integer.split(group);
    if (!/^\d{1,3}$/.test(parts[0]!) || parts.slice(1).some((p) => !/^\d{3}$/.test(p))) return { ok: false };
    integer = parts.join('');
  }
  if (!/^\d+$/.test(integer)) return { ok: false };
  const digits = integer.replace(/^0+(?=\d)/, '');
  if (digits.length > INTEGER_DIGITS_MAX) return { ok: false };
  const minor = Number(digits) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? { ok: true, minor } : { ok: false };
}

const numberTag = (locale: Locale): string => (locale === 'en' ? 'en-GB' : 'id-ID');

/** Minor units as major units in the UI language, without decimals for a whole amount (`6.500.000`, `6.500.000,50`). */
export function formatMajorAmount(minor: number, locale: Locale): string {
  const whole = minor % 100 === 0;
  return new Intl.NumberFormat(numberTag(locale), { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(minor / 100);
}

/** Minor units with their currency in the UI language (`Rp 6.500.000`); a dash for none. */
export function formatMoney(minor: number | null, currency: string, locale: Locale): string {
  if (minor === null) return '—';
  const whole = minor % 100 === 0;
  try {
    return new Intl.NumberFormat(numberTag(locale), {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(minor / 100);
  } catch {
    return `${currency} ${formatMajorAmount(minor, locale)}`;
  }
}

/** The amounts of a budget, by their API names (the form fields carry the same names). */
const AMOUNTS = ['libraryMinor', 'parentMinor', 'parentNonpersonnelMinor', 'collectionMinor', 'communityMinor'] as const;

type AmountKey = (typeof AMOUNTS)[number];

type BudgetValues = { year: string; currency: string; note: string } & Record<AmountKey, string>;

/** The minor units of a typed amount that {@link parseMajorAmount} accepted (null when blank). */
const minorOf = (s: string): number | null => {
  const parsed = parseMajorAmount(s);
  return parsed.ok ? parsed.minor : null;
};

const budgetBody = (v: BudgetValues) => ({
  year: v.year.trim() === '' ? undefined : intOrText(v.year),
  libraryMinor: minorOf(v.libraryMinor) ?? undefined,
  parentMinor: minorOf(v.parentMinor),
  parentNonpersonnelMinor: minorOf(v.parentNonpersonnelMinor),
  collectionMinor: minorOf(v.collectionMinor),
  communityMinor: minorOf(v.communityMinor),
  currency: v.currency.trim().toUpperCase(),
  note: longOrNull(v.note),
});

/** The amounts that are not amounts, each on its field; the library's own budget is required. */
function amountIssues(v: BudgetValues): FieldIssue[] {
  const issues: FieldIssue[] = AMOUNTS.filter((key) => !parseMajorAmount(v[key]).ok).map((path) => ({
    path,
    code: 'invalid',
    message: 'accreditation.registers.budgets.amount_invalid',
  }));
  if (v.libraryMinor.trim() === '') issues.push({ path: 'libraryMinor', code: 'required', message: 'form.error.required' });
  return issues;
}

/** A year that already has a live budget. */
const yearTaken = (path: string, code: string): TKey | undefined => (path === 'year' && code === 'taken' ? 'accreditation.registers.budgets.year_taken' : undefined);

/** The labels and hints of the amount fields. */
const AMOUNT_FIELDS: readonly { key: AmountKey; label: TKey; hint?: TKey; wide?: boolean }[] = [
  { key: 'libraryMinor', label: 'accreditation.registers.budgets.field.library' },
  { key: 'collectionMinor', label: 'accreditation.registers.budgets.field.collection' },
  { key: 'parentMinor', label: 'accreditation.registers.budgets.field.parent', hint: 'accreditation.registers.budgets.field.parent_hint' },
  {
    key: 'parentNonpersonnelMinor',
    label: 'accreditation.registers.budgets.field.parent_nonpersonnel',
    hint: 'accreditation.registers.budgets.field.parent_nonpersonnel_hint',
  },
  { key: 'communityMinor', label: 'accreditation.registers.budgets.field.community' },
];

/** The currency a new budget starts with: the latest budget's, else the catalogue's, else IDR. */
function useDefaultCurrency(): string {
  const me = useMe();
  const list = useRegisterList<BudgetView>('budgets');
  const config = useApiQuery<CatalogConfigView>({
    queryKey: ['catalog', 'config'],
    path: 'catalog/config',
    staleTime: 60_000,
    enabled: holds(me, 'catalog.records.read'),
  });
  return list.data?.rows[0]?.currency ?? config.data?.currency ?? 'IDR';
}

function BudgetForm({ row, canManage, onSaved, onCancel }: RegisterFormProps<BudgetView>) {
  const t = useT();
  const locale = useLocale();
  const currency = useDefaultCurrency();
  const amount = (minor: number | null): string => (minor === null ? '' : formatMajorAmount(minor, locale));
  const base: BudgetValues =
    row === null
      ? { year: '', currency, note: '', libraryMinor: '', parentMinor: '', parentNonpersonnelMinor: '', collectionMinor: '', communityMinor: '' }
      : {
          year: String(row.year),
          currency: row.currency,
          note: row.note ?? '',
          libraryMinor: amount(row.libraryMinor),
          parentMinor: amount(row.parentMinor),
          parentNonpersonnelMinor: amount(row.parentNonpersonnelMinor),
          collectionMinor: amount(row.collectionMinor),
          communityMinor: amount(row.communityMinor),
        };
  const form = useForm<BudgetValues>({ defaultValues: base });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const { submit, problem } = useRegisterSave({
    form,
    row,
    create: { path: 'accreditation/budgets', schema: BudgetBody },
    update: { path: (id) => `accreditation/budgets/${encodeURIComponent(id)}`, schema: BudgetPatchBody },
    check: amountIssues,
    body: (v) => (row === null ? budgetBody(v) : changedFields(budgetBody(v), budgetBody(base))),
    message: yearTaken,
    invalidate: registerKey('budgets'),
    onSaved,
    onUnchanged: onCancel,
  });
  const disabled = !canManage;
  return (
    <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)}>
      <ProblemAlert error={problem} />
      <RootError message={errors.root?.['server']?.message} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('accreditation.registers.budgets.field.year')} error={errors.year}>
          {(c) => <Input {...c} type="number" inputMode="numeric" min={1900} max={2100} step={1} disabled={disabled} {...form.register('year')} />}
        </Field>
        <Field label={t('accreditation.registers.budgets.field.currency')} hint={t('accreditation.registers.budgets.field.currency_hint')} error={errors.currency}>
          {(c) => (
            <Input {...c} className="w-24 font-mono uppercase" maxLength={3} autoComplete="off" spellCheck={false} disabled={disabled} {...form.register('currency')} />
          )}
        </Field>
        {AMOUNT_FIELDS.map((f) => (
          <Field key={f.key} label={t(f.label)} hint={t(f.hint ?? 'accreditation.registers.budgets.amount_hint')} error={errors[f.key]}>
            {(c) => <Input {...c} inputMode="decimal" autoComplete="off" spellCheck={false} disabled={disabled} {...form.register(f.key)} />}
          </Field>
        ))}
      </div>
      <Field label={t('accreditation.registers.budgets.field.note')} error={errors.note}>
        {(c) => <textarea {...c} className={TEXTAREA_CLASS} disabled={disabled} {...form.register('note')} />}
      </Field>
      <FormButtons canManage={canManage} busy={isSubmitting} onCancel={onCancel} />
    </form>
  );
}

/** The budgets register: newest year first. */
export function BudgetsRegister() {
  const t = useT();
  const locale = useLocale();
  const money = (r: BudgetView, minor: number | null) => <span className="whitespace-nowrap tabular-nums">{formatMoney(minor, r.currency, locale)}</span>;
  const columns: RegisterColumn<BudgetView>[] = [
    { id: 'year', header: t('accreditation.registers.budgets.col.year'), cell: (r) => <span className="font-medium tabular-nums">{r.year}</span> },
    { id: 'library', header: t('accreditation.registers.budgets.col.library'), cell: (r) => money(r, r.libraryMinor) },
    { id: 'parent', header: t('accreditation.registers.budgets.col.parent'), cell: (r) => money(r, r.parentMinor) },
    { id: 'parentNonpersonnel', header: t('accreditation.registers.budgets.col.parent_nonpersonnel'), cell: (r) => money(r, r.parentNonpersonnelMinor) },
    { id: 'collection', header: t('accreditation.registers.budgets.col.collection'), cell: (r) => money(r, r.collectionMinor) },
  ];
  return (
    <RegisterSection
      kind="budgets"
      entity="library_budgets"
      columns={columns}
      nameOf={(r) => t('accreditation.registers.budgets.name', { year: r.year })}
      form={BudgetForm}
    />
  );
}
