import { L12_FEATURES, SCHOOL_LEVELS, SCHOOL_STATUSES, vocabKey, type L12Feature } from '@altis/shared';
import type { AccredProfile, EvidenceListResponse, EvidenceView, PeriodView } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type JSX } from 'react';
import { EvidenceUpload } from '@/components/accreditation/evidence-upload';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge, CheckField, ProblemAlert } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { useT, type TKey } from '@/i18n';
import { api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { useApiQuery } from '@/lib/me';
import { accreditationKeys, keyText, periodPath, retry, useRefreshPeriods } from '../data';
import {
  FormSection,
  PeriodFormFooter,
  SelectField,
  TextField,
  textOrNull,
  usePeriodSave,
  wholeOrNull,
  type PeriodPatch,
  type PeriodSaving,
} from '../period-form';
import { ReadOnlyNote, TabState, type TabContext } from '../tab-state';

/**
 * Profil (spec §6 "Akreditasi", §10.6): the period's name and the institution's profile the documents print: the NPP,
 * the school's status, founding year and decree, the school and its level, the heads of school and library, the
 * address and contacts, the previous accreditation, the name on the certificate, the profile video, the features of a
 * library website outside ALTIS, and the four profile photos.
 *
 * Only the changed fields are sent; a changed part of an address, a founding decree or a previous accreditation sends
 * that part whole (the server replaces it whole). The photos are evidence files of the period (indicator `SCH-PROFIL`):
 * a photo is uploaded as evidence and then named in the profile. A frozen period is read only.
 */
export function ProfileTab(props: { periodId: string }): JSX.Element {
  return <TabState periodId={props.periodId}>{(ctx) => <ProfilePanel ctx={ctx} />}</TabState>;
}

/** The form starts over for another period; the save's outcome is kept above it. */
function ProfilePanel({ ctx }: { ctx: TabContext }) {
  const saving = usePeriodSave(ctx.period);
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <ProfileForm key={ctx.period.id} ctx={ctx} saving={saving} />
      <ProfilePhotos ctx={ctx} />
    </div>
  );
}

// ---- the fields ------------------------------------------------------------------------------------------------------

/** How a text field of the profile is entered: its label, its width, or a number range, a day, or an input kind. */
interface TextSpec {
  label: TKey;
  max?: number;
  number?: readonly [number, number];
  date?: true;
  type?: 'tel' | 'url' | 'email';
}

/** The profile's text fields, by their path in the profile (a part's fields as `part.field`). */
const TEXTS = {
  npp: { label: 'accreditation.workspace.profile.npp', max: 32 },
  foundedYear: { label: 'accreditation.workspace.profile.founded_year', number: [1800, 2100] },
  'foundingDecree.number': { label: 'accreditation.workspace.profile.decree_number', max: 64 },
  'foundingDecree.date': { label: 'accreditation.workspace.profile.decree_date', date: true },
  'foundingDecree.issuer': { label: 'accreditation.workspace.profile.decree_issuer', max: 191 },
  schoolName: { label: 'accreditation.workspace.profile.school_name', max: 191 },
  schoolHead: { label: 'accreditation.workspace.profile.school_head', max: 191 },
  libraryHead: { label: 'accreditation.workspace.profile.library_head', max: 191 },
  libraryHeadId: { label: 'accreditation.workspace.profile.library_head_id', max: 32 },
  'address.street': { label: 'accreditation.workspace.profile.street', max: 191 },
  'address.village': { label: 'accreditation.workspace.profile.village', max: 191 },
  'address.district': { label: 'accreditation.workspace.profile.district', max: 191 },
  'address.regency': { label: 'accreditation.workspace.profile.regency', max: 191 },
  'address.province': { label: 'accreditation.workspace.profile.province', max: 64 },
  'address.postalCode': { label: 'accreditation.workspace.profile.postal_code', max: 10 },
  phone: { label: 'accreditation.workspace.profile.phone', max: 32, type: 'tel' },
  website: { label: 'accreditation.workspace.profile.website', max: 191, type: 'url' },
  email: { label: 'accreditation.workspace.profile.email', max: 191, type: 'email' },
  'previousAccreditation.year': { label: 'accreditation.workspace.profile.previous_year', number: [1900, 2100] },
  'previousAccreditation.certificateNo': { label: 'accreditation.workspace.profile.previous_certificate', max: 64 },
  certificateName: { label: 'accreditation.workspace.profile.certificate_name', max: 191 },
  profileVideoUrl: { label: 'accreditation.workspace.profile.video', max: 500, type: 'url' },
} as const satisfies Readonly<Record<string, TextSpec>>;

type TextName = keyof typeof TEXTS;

/** The profile's choice fields. */
type ChoiceName = 'status' | 'schoolLevel' | 'previousAccreditation.grade';

/** The parts the server replaces whole. */
type Part = 'foundingDecree' | 'address' | 'previousAccreditation';

interface Values {
  name: string;
  texts: Record<TextName, string>;
  choices: Record<ChoiceName, string>;
  features: readonly L12Feature[];
}

/** The value at `path` (`part.field`) of `profile`, as stored. */
function storedAt(profile: AccredProfile, path: string): unknown {
  const [head, tail] = path.split('.') as [string, string | undefined];
  const value = (profile as Record<string, unknown>)[head];
  if (tail === undefined) return value;
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[tail] : undefined;
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function valuesOf(p: PeriodView): Values {
  const texts = {} as Record<TextName, string>;
  for (const name of Object.keys(TEXTS) as TextName[]) texts[name] = asText(storedAt(p.profile, name));
  return {
    name: p.name,
    texts,
    choices: {
      status: asText(p.profile.status),
      schoolLevel: asText(p.profile.schoolLevel),
      'previousAccreditation.grade': asText(p.profile.previousAccreditation?.grade),
    },
    features: p.profile.externalWebsiteFeatures ?? [],
  };
}

/** The input of field `name` as the API takes it; `invalid` for a number out of range. */
function parsed(name: TextName, text: string): string | number | null | 'invalid' {
  const spec: TextSpec = TEXTS[name];
  if (spec.number !== undefined) return wholeOrNull(text, spec.number[0], spec.number[1]);
  return textOrNull(text);
}

const normalized = (v: unknown): unknown => (v === undefined ? null : v);

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/**
 * What `values` would send for `period`: the fields refused before anything is sent, and the patch of the fields that
 * differ from the stored ones (empty: nothing to save).
 */
function profilePatch(values: Values, period: PeriodView): { found: Record<string, string>; patch: PeriodPatch } {
  const found: Record<string, string> = {};
  const next: Record<string, unknown> = {};
  for (const name of Object.keys(TEXTS) as TextName[]) {
    const v = parsed(name, values.texts[name]);
    if (v === 'invalid') found[name] = 'form.error.invalid';
    else next[name] = v;
  }
  for (const [name, v] of Object.entries(values.choices)) next[name] = v === '' ? null : v;
  const name = values.name.trim();
  if (name === '') found['name'] = 'form.error.required';

  const profile: Record<string, unknown> = {};
  const changedParts = new Set<Part>();
  for (const [path, v] of Object.entries(next)) {
    if (normalized(storedAt(period.profile, path)) === v) continue;
    const [head, tail] = path.split('.') as [string, string | undefined];
    if (tail === undefined) profile[head] = v;
    else changedParts.add(head as Part);
  }
  // A part is replaced whole: send every one of its fields.
  for (const part of changedParts) {
    const whole: Record<string, unknown> = {};
    for (const [path, v] of Object.entries(next)) if (path.startsWith(`${part}.`)) whole[path.slice(part.length + 1)] = v;
    profile[part] = whole;
  }
  if (!sameSet(values.features, period.profile.externalWebsiteFeatures ?? [])) {
    profile['externalWebsiteFeatures'] = L12_FEATURES.filter((f) => values.features.includes(f));
  }
  const patch: PeriodPatch = {};
  if (name !== '' && name !== period.name) patch.name = name;
  if (Object.keys(profile).length > 0) patch.profile = profile as AccredProfile;
  return { found, patch };
}

/** `values` over the period read again: what was typed stays, every field left as it was takes its value in `after`. */
function rebased(values: Values, before: Values, after: Values): Values {
  const texts = { ...values.texts };
  for (const name of Object.keys(TEXTS) as TextName[]) if (values.texts[name] === before.texts[name]) texts[name] = after.texts[name];
  const choices = { ...values.choices };
  for (const name of Object.keys(choices) as ChoiceName[]) if (values.choices[name] === before.choices[name]) choices[name] = after.choices[name];
  return {
    name: values.name === before.name ? after.name : values.name,
    texts,
    choices,
    features: sameSet(values.features, before.features) ? after.features : values.features,
  };
}

function ProfileForm({ ctx, saving }: { ctx: TabContext; saving: PeriodSaving }) {
  const t = useT();
  const period = ctx.period;
  const [values, setValues] = useState<Values>(() => valuesOf(period));
  // The period the values were taken from. Read again with a new version (a photo named below, another librarian's
  // save, this form's own save), it never resets what was typed: those fields stay, the others show what is stored
  // now, and the next save names the new version.
  const [loaded, setLoaded] = useState(period);
  if (loaded.version !== period.version) {
    setLoaded(period);
    setValues((v) => rebased(v, valuesOf(loaded), valuesOf(period)));
  }
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const { save, busy, problem, outcome, serverErrors } = saving;
  const off = !ctx.canEdit || busy;
  const errorOf = (name: string): string | undefined => errors[name] ?? serverErrors[name];
  const pending = profilePatch(values, period);
  useDirtyGuard(ctx.canEdit && (Object.keys(pending.found).length > 0 || Object.keys(pending.patch).length > 0));

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!ctx.canEdit) return;
    const { found, patch } = profilePatch(values, period);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    void save(patch, (path) => {
      if (path === 'name') return 'name';
      const field = path.startsWith('profile.') ? path.slice('profile.'.length) : null;
      if (field === null) return null;
      if (field in values.texts || field in values.choices) return field;
      return field === 'externalWebsiteFeatures' ? field : null;
    });
  };

  const text = (name: TextName) => {
    const spec: TextSpec = TEXTS[name];
    return (
      <TextField
        key={name}
        label={t(spec.label)}
        type={spec.number !== undefined ? 'number' : spec.date === true ? 'date' : (spec.type ?? 'text')}
        value={values.texts[name]}
        error={errorOf(name)}
        disabled={off}
        maxLength={spec.max}
        onChange={(v) => setValues((s) => ({ ...s, texts: { ...s.texts, [name]: v } }))}
      />
    );
  };

  const choice = (name: ChoiceName, label: TKey, options: readonly (readonly [string, string])[]) => (
    <SelectField
      key={name}
      label={t(label)}
      value={values.choices[name]}
      error={errorOf(name)}
      disabled={off}
      options={[['', t('accreditation.workspace.profile.none')], ...options]}
      onChange={(v) => setValues((s) => ({ ...s, choices: { ...s.choices, [name]: v } }))}
    />
  );

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-6">
      <ReadOnlyNote ctx={ctx} />
      <FormSection title={t('accreditation.workspace.profile.section.period')}>
        <TextField
          label={t('accreditation.workspace.profile.name')}
          value={values.name}
          error={errorOf('name')}
          disabled={off}
          maxLength={191}
          onChange={(v) => setValues((s) => ({ ...s, name: v }))}
        />
      </FormSection>
      <FormSection title={t('accreditation.workspace.profile.section.identity')}>
        {text('npp')}
        {choice(
          'status',
          'accreditation.workspace.profile.status',
          SCHOOL_STATUSES.map((s) => [s, t(vocabKey('school_status', s))] as const),
        )}
        {text('schoolName')}
        {choice(
          'schoolLevel',
          'accreditation.workspace.profile.school_level',
          SCHOOL_LEVELS.map((l) => [l, t(vocabKey('school_level', l))] as const),
        )}
        {text('foundedYear')}
        {text('schoolHead')}
        {text('libraryHead')}
        {text('libraryHeadId')}
      </FormSection>
      <FormSection title={t('accreditation.workspace.profile.section.decree')}>
        {text('foundingDecree.number')}
        {text('foundingDecree.date')}
        {text('foundingDecree.issuer')}
      </FormSection>
      <FormSection title={t('accreditation.workspace.profile.section.address')}>
        {text('address.street')}
        {text('address.village')}
        {text('address.district')}
        {text('address.regency')}
        {text('address.province')}
        {text('address.postalCode')}
        {text('phone')}
        {text('email')}
        {text('website')}
      </FormSection>
      <FormSection title={t('accreditation.workspace.profile.section.accreditation')}>
        {choice('previousAccreditation.grade', 'accreditation.workspace.profile.previous_grade', [
          ['A', 'A'],
          ['B', 'B'],
          ['C', 'C'],
        ])}
        {text('previousAccreditation.year')}
        {text('previousAccreditation.certificateNo')}
        {text('certificateName')}
        {text('profileVideoUrl')}
      </FormSection>
      <FormSection title={t('accreditation.workspace.profile.section.website')} hint={t('accreditation.workspace.profile.features_hint')}>
        <div role="group" aria-label={t('accreditation.workspace.profile.features')} className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
          {L12_FEATURES.map((feature) => (
            <CheckField
              key={feature}
              label={keyText(t, `accred.element.${feature}`)}
              checked={values.features.includes(feature)}
              disabled={off}
              onChange={(e) =>
                setValues((s) => ({ ...s, features: e.target.checked ? [...s.features, feature] : s.features.filter((f) => f !== feature) }))
              }
            />
          ))}
        </div>
      </FormSection>
      <PeriodFormFooter canEdit={ctx.canEdit} busy={busy} problem={problem} outcome={outcome} />
    </form>
  );
}

// ---- the photos ------------------------------------------------------------------------------------------------------

/** The indicator code the profile's evidence files (its photos) are linked to. */
const PROFILE_CODE = 'SCH-PROFIL';

/** The four photo slots, the evidence item each is uploaded as, and their labels. */
const PHOTOS = [
  { slot: 'front', code: 'photo_front', label: 'accreditation.workspace.profile.photo.front' },
  { slot: 'collection', code: 'photo_collection', label: 'accreditation.workspace.profile.photo.collection' },
  { slot: 'staff', code: 'photo_staff', label: 'accreditation.workspace.profile.photo.staff' },
  { slot: 'readingRoom', code: 'photo_reading_room', label: 'accreditation.workspace.profile.photo.reading_room' },
] as const satisfies readonly { slot: keyof NonNullable<AccredProfile['photos']>; code: string; label: TKey }[];

type Slot = (typeof PHOTOS)[number]['slot'];

/**
 * The four profile photos: each slot says whether it holds a photo (with its file), and a manager of an open period
 * uploads one (an image, stored as a JPEG evidence file of the period under `SCH-PROFIL`) or takes it out of the
 * profile. After an upload the newest evidence file of that slot is named in the profile.
 *
 * Every evidence file of the profile goes into the evidence ZIP, named in a slot or not. So each one can be deleted with
 * its file after a confirmation (`DELETE accreditation/evidence/:id`; the server empties a slot that named it), and a
 * slot also lists its files the profile no longer names (a replaced photo, one taken out), each with that delete.
 */
function ProfilePhotos({ ctx }: { ctx: TabContext }) {
  const t = useT();
  const queryClient = useQueryClient();
  const refresh = useRefreshPeriods();
  const period = ctx.period;
  const path = `accreditation/evidence?${new URLSearchParams({ periodId: period.id, indicatorCode: PROFILE_CODE }).toString()}`;
  const evidence = useApiQuery<EvidenceListResponse>({ queryKey: [...accreditationKeys.period(period.id), 'evidence', PROFILE_CODE], path, retry });
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<EvidenceView | null>(null);
  const photos = period.profile.photos ?? {};

  const remove = async (file: EvidenceView): Promise<void> => {
    await api<StoreResponse>('DELETE', `accreditation/evidence/${encodeURIComponent(file.id)}`);
    // The period (a slot emptied), its evidence lists, its results and the component sizes all moved.
    await queryClient.invalidateQueries({ queryKey: accreditationKeys.all() });
  };

  const deleteButton = (file: EvidenceView) =>
    ctx.canEdit && (
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={t('accreditation.workspace.profile.photo.delete_named', { name: file.fileName })}
        onClick={() => setRemoving(file)}>
        {t('accreditation.workspace.profile.photo.delete')}
      </Button>
    );

  const setSlot = async (slot: Slot, fileId: string | null): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const next = { front: photos.front ?? null, collection: photos.collection ?? null, staff: photos.staff ?? null, readingRoom: photos.readingRoom ?? null };
      next[slot] = fileId;
      await api('PATCH', periodPath(period.id), { version: period.version, profile: { photos: next } });
      await refresh();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  const uploaded = async (slot: Slot, code: string): Promise<void> => {
    const list = await evidence.refetch();
    const newest = (list.data?.evidence ?? []).filter((e) => e.evidenceCode === code).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (newest !== undefined && newest.fileId !== (photos[slot] ?? null)) await setSlot(slot, newest.fileId);
  };

  return (
    <section aria-label={t('accreditation.workspace.profile.section.photos')} className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground">
      <h3 className="text-base font-semibold">{t('accreditation.workspace.profile.section.photos')}</h3>
      <p className="text-sm text-muted-foreground">{t('accreditation.workspace.profile.photo_hint')}</p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {PHOTOS.map(({ slot, code, label }) => {
          const fileId = photos[slot] ?? null;
          const files = (evidence.data?.evidence ?? []).filter((e) => e.evidenceCode === code);
          const current = files.find((e) => e.fileId === fileId);
          const unused = files.filter((e) => e.fileId !== fileId);
          return (
            <li key={slot} className="grid gap-2 rounded-md border px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t(label)}</span>
                <Badge tone={fileId === null ? 'warning' : 'info'}>
                  {t(fileId === null ? 'accreditation.workspace.evidence.absent' : 'accreditation.workspace.evidence.present')}
                </Badge>
              </div>
              {fileId !== null && (
                <div className="flex flex-wrap items-center gap-2">
                  <a href={`/files/${encodeURIComponent(fileId)}`} className="text-primary underline-offset-4 hover:underline">
                    {current?.fileName ?? fileId}
                  </a>
                  {current !== undefined && deleteButton(current)}
                </div>
              )}
              {unused.length > 0 && (
                <ul className="grid gap-2">
                  {unused.map((file) => (
                    <li key={file.id} className="grid gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <a href={`/files/${encodeURIComponent(file.fileId)}`} className="text-primary underline-offset-4 hover:underline">
                          {file.fileName}
                        </a>
                        {deleteButton(file)}
                      </span>
                      <span className="text-xs text-muted-foreground">{t('accreditation.workspace.profile.photo.unused')}</span>
                    </li>
                  ))}
                </ul>
              )}
              {ctx.canEdit && (
                <div className="flex flex-wrap gap-2">
                  <EvidenceUpload
                    periodId={period.id}
                    indicatorCode={PROFILE_CODE}
                    evidenceCode={code}
                    imagesOnly
                    label={t('accreditation.workspace.profile.photo.upload')}
                    onDone={() => void uploaded(slot, code)}
                  />
                  {fileId !== null && (
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void setSlot(slot, null)}>
                      {t('accreditation.workspace.profile.photo.remove')}
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <ProblemAlert error={problem} />
      {removing !== null && (
        <ConfirmDialog
          open
          destructive
          title={t('accreditation.workspace.profile.photo.confirm.title', { name: removing.fileName })}
          description={t('accreditation.workspace.profile.photo.confirm.body')}
          confirmLabel={t('accreditation.workspace.profile.photo.delete')}
          onConfirm={() => remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}
