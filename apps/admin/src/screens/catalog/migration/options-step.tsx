import type { BranchListResponse } from '@altis/shared/api/branches';
import { PRICE_MODES, sourceNameField, type PriceMode, type SlimsStartBody } from '@altis/shared/api/catalog/migration';
import { useEffect, useId, useMemo, type ReactNode } from 'react';
import { CheckField, Field, NoticeAlert, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { isWritableBranch } from '@/lib/branches';
import { useApiQuery } from '@/lib/me';
import { EMPTY_PEOPLE, PeopleFields, type PeopleDraft } from './people';

/**
 * Step 2 of the Migrasi SLiMS wizard (Phase 2 spec §11.2, §11.4, §13; plan Task 30; preflight S13): how the run writes.
 *
 * - **Cabang tujuan:** an active branch (`GET branches`), the default branch at first.
 * - **Harga eksemplar** (`priceMode`, §11.4): whole rupiah (×100 into minor units, the default), minor units
 *   already, or not migrated.
 * - **Nama sumber** (`sourceName`, S13): the source of every `migration_map` row the run writes. A re-run from the
 *   same SLiMS keeps it, so the rows mapped already are skipped; a second SLiMS needs another name.
 * - **Izinkan katalog tujuan yang tidak kosong** (`allowNonEmpty`, §11.2): a real run into a catalogue that holds
 *   records, only with the library's name typed out (compared as the server does: NFKC, then trimmed). The dry run
 *   ignores it, and the real run asks for it again (index.tsx).
 * - **Mode katalog** (`catalogMode`): "Tambah baris baru saja" (`append`, the default and the earlier behaviour: a
 *   re-run only adds new rows, as its sentence says) or "Selaraskan dengan SLiMS" (`sync`: the mapped records and
 *   copies no one edited in ALTIS are written again as SLiMS has them, those edited in ALTIS are skipped and reported),
 *   with the sentence of the mode chosen. The start sends `catalogMode` only for `sync`.
 * - **Lewati tahap katalog** (`skipCatalog`, {@link SkipCatalogField}) belongs to the real run under a dry run
 *   (index.tsx): it can be ticked only when that dry run was a sync that found no catalogue change.
 * - **Anggota, kunjungan, dan sirkulasi** (`people`, people.tsx): the member, visit and circulation options.
 */

/** How a run treats the catalogue rows it mapped before: `append` (new rows only) or `sync`. */
export type CatalogMode = NonNullable<SlimsStartBody['catalogMode']>;

export const CATALOG_MODES: readonly CatalogMode[] = ['append', 'sync'];

export interface OptionsDraft {
  /** '' until the branches are known (then the default branch). */
  branchId: string;
  priceMode: PriceMode;
  sourceName: string;
  allowNonEmpty: boolean;
  confirmLibraryName: string;
  // ---- Komunitas K1 (catalogue re-sync) ----
  catalogMode: CatalogMode;
  // ---- Komunitas (SLiMS members and circulation) ----
  people: PeopleDraft;
}

export const EMPTY_OPTIONS: OptionsDraft = {
  branchId: '',
  priceMode: 'major',
  sourceName: 'slims',
  allowNonEmpty: false,
  confirmLibraryName: '',
  catalogMode: 'append',
  people: EMPTY_PEOPLE,
};

export type OptionsErrors = Partial<Record<'branchId' | 'sourceName' | 'confirmLibraryName', TKey>>;

/** The branches query (shared with Cabang's list of active branches). */
export const ACTIVE_BRANCHES_KEY = ['branches', { includeArchived: false }] as const;

/** How the server compares a typed library name (migration guard.ts, as a restore does): NFKC, then trimmed. */
export const comparableName = (name: string): string => name.normalize('NFKC').trim();

/** The error of the library-name confirmation, if any. */
export function confirmError(allowNonEmpty: boolean, typed: string, libraryName: string): TKey | undefined {
  if (!allowNonEmpty) return undefined;
  if (comparableName(typed) === '') return 'catalog.migration.options.confirm_required';
  return comparableName(typed) === comparableName(libraryName) ? undefined : 'catalog.migration.options.confirm_mismatch';
}

/** The errors of the options before the dry run starts (none: they are complete). */
export function checkOptions(o: OptionsDraft, libraryName: string): OptionsErrors {
  const errors: OptionsErrors = {};
  if (o.branchId === '') errors.branchId = 'catalog.migration.options.branch_required';
  if (!sourceNameField.safeParse(o.sourceName).success) errors.sourceName = 'catalog.migration.options.source_name_invalid';
  const confirm = confirmError(o.allowNonEmpty, o.confirmLibraryName, libraryName);
  if (confirm !== undefined) errors.confirmLibraryName = confirm;
  return errors;
}

const PRICE_LABEL: Readonly<Record<PriceMode, TKey>> = {
  major: 'catalog.migration.options.price_major',
  minor: 'catalog.migration.options.price_minor',
  skip: 'catalog.migration.options.price_skip',
};

/** The label of a price mode. */
export const priceModeLabel = (mode: PriceMode): TKey => PRICE_LABEL[mode];

// ---- Komunitas K1 (catalogue re-sync) ----

/** What a run in `mode` does with the rows it mapped before. */
export function CatalogModeNote({ mode }: { mode: CatalogMode }) {
  const t = useT();
  return <NoticeAlert>{t(mode === 'sync' ? 'catalog.migration.options.sync_note' : 'catalog.migration.rerun_note')}</NoticeAlert>;
}

/** The label of a catalogue mode. */
export const catalogModeLabel = (mode: CatalogMode): TKey => (mode === 'sync' ? 'catalog.migration.options.catalog_mode.sync' : 'catalog.migration.options.catalog_mode.append');

/**
 * Whether the real run under a dry run may skip the catalogue stages: the dry run was a sync (that ran them, so it did
 * not skip them itself) whose summary counted no source record or copy new, changed or gone.
 */
export function canSkipCatalog(dryRun: { catalogMode?: CatalogMode; skipCatalog?: boolean }, catalogChanges: number | undefined): boolean {
  return dryRun.catalogMode === 'sync' && dryRun.skipCatalog !== true && catalogChanges === 0;
}

/** "Lewati tahap katalog": enabled only when `allowed` ({@link canSkipCatalog}), with the reason either way. */
export function SkipCatalogField({ allowed, checked, disabled, onChange }: { allowed: boolean; checked: boolean; disabled: boolean; onChange(next: boolean): void }) {
  const t = useT();
  return (
    <CheckField
      label={t('catalog.migration.options.skip_catalog')}
      hint={t(allowed ? 'catalog.migration.options.skip_catalog_ready' : 'catalog.migration.options.skip_catalog_hint')}
      checked={allowed && checked}
      disabled={!allowed || disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/** "Izinkan katalog tujuan yang tidak kosong" and, when ticked, the library's name typed out. */
export function NonEmptyConfirm({
  allowNonEmpty,
  typed,
  libraryName,
  error,
  onChange,
}: {
  allowNonEmpty: boolean;
  typed: string;
  libraryName: string;
  error: TKey | undefined;
  onChange(next: { allowNonEmpty: boolean; confirmLibraryName: string }): void;
}) {
  const t = useT();
  return (
    <div className="grid gap-3">
      <CheckField
        label={t('catalog.migration.options.allow_non_empty')}
        hint={t('catalog.migration.options.allow_non_empty_hint')}
        checked={allowNonEmpty}
        onChange={(e) => onChange({ allowNonEmpty: e.target.checked, confirmLibraryName: typed })}
      />
      {allowNonEmpty && (
        <Field label={t('catalog.migration.options.confirm_name', { name: libraryName })} error={error}>
          {(c) => (
            <Input
              {...c}
              value={typed}
              maxLength={191}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onChange({ allowNonEmpty, confirmLibraryName: e.target.value })}
            />
          )}
        </Field>
      )}
    </div>
  );
}

export function OptionsStep({
  value,
  errors,
  libraryName,
  onChange,
  children,
}: {
  value: OptionsDraft;
  errors: OptionsErrors;
  libraryName: string;
  onChange(next: OptionsDraft): void;
  /** The step's buttons and the progress of the start (index.tsx). */
  children: ReactNode;
}) {
  const t = useT();
  const titleId = useId();
  const priceName = useId();
  const modeName = useId();
  const branches = useApiQuery<BranchListResponse>({ queryKey: ACTIVE_BRANCHES_KEY, path: 'branches' });
  // The writable branches (live and active, L13): a migration writes the items of its target branch.
  const active = useMemo(() => branches.data?.items.filter(isWritableBranch) ?? [], [branches.data]);
  const fallback = active.find((b) => b.isDefault)?.id ?? active[0]?.id ?? '';

  // The default branch until the user picks one (and again when the chosen one is gone).
  useEffect(() => {
    if (branches.data === undefined) return;
    if (!active.some((b) => b.id === value.branchId) && fallback !== value.branchId) onChange({ ...value, branchId: fallback });
  }, [branches.data, active, fallback, value, onChange]);

  return (
    <section aria-labelledby={titleId} className="grid max-w-4xl gap-4">
      <h2 id={titleId} className="text-base font-bold">
        {t('catalog.migration.options.title')}
      </h2>
      {branches.isError && <ProblemAlert error={branches.error} />}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('catalog.migration.options.branch')} hint={t('catalog.migration.options.branch_hint')} error={errors.branchId}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} value={value.branchId} onChange={(e) => onChange({ ...value, branchId: e.target.value })}>
              {active.map((b) => (
                <option key={b.id} value={b.id}>
                  {`${b.name} (${b.code})`}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('catalog.migration.options.source_name')} hint={t('catalog.migration.options.source_name_hint')} error={errors.sourceName}>
          {(c) => (
            <Input
              {...c}
              value={value.sourceName}
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onChange({ ...value, sourceName: e.target.value })}
            />
          )}
        </Field>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-bold">{t('catalog.migration.options.price')}</legend>
        {PRICE_MODES.map((mode) => {
          const id = `${priceName}-${mode}`;
          return (
            <div key={mode} className="flex items-center gap-2">
              <input
                id={id}
                type="radio"
                name={priceName}
                value={mode}
                checked={value.priceMode === mode}
                onChange={() => onChange({ ...value, priceMode: mode })}
                className="size-4 accent-primary"
              />
              <label htmlFor={id} className="text-sm">
                {t(PRICE_LABEL[mode])}
              </label>
            </div>
          );
        })}
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-bold">{t('catalog.migration.options.catalog_mode')}</legend>
        {CATALOG_MODES.map((mode) => {
          const id = `${modeName}-${mode}`;
          return (
            <div key={mode} className="flex items-center gap-2">
              <input
                id={id}
                type="radio"
                name={modeName}
                value={mode}
                checked={value.catalogMode === mode}
                onChange={() => onChange({ ...value, catalogMode: mode })}
                className="size-4 accent-primary"
              />
              <label htmlFor={id} className="text-sm">
                {t(catalogModeLabel(mode))}
              </label>
            </div>
          );
        })}
        <CatalogModeNote mode={value.catalogMode} />
      </fieldset>
      <NonEmptyConfirm
        allowNonEmpty={value.allowNonEmpty}
        typed={value.confirmLibraryName}
        libraryName={libraryName}
        error={errors.confirmLibraryName}
        onChange={(next) => onChange({ ...value, ...next })}
      />
      <PeopleFields value={value.people} onChange={(people) => onChange({ ...value, people })} />
      {children}
    </section>
  );
}
