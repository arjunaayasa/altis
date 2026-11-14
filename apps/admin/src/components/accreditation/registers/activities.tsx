import { ACTIVITY_KINDS, vocabKey, type ActivityKind } from '@altis/shared';
import { ActivityBody, ActivityPatchBody, type ActivityView } from '@altis/shared/api/accreditation';
import { useForm } from 'react-hook-form';
import { Badge, CheckField, Field, ProblemAlert, RootError, TEXTAREA_CLASS } from '@/components/form-field';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { changedFields, useCount } from '@/screens/catalog/masters/master-table';
import {
  FormButtons,
  RegisterSection,
  VocabSelect,
  choiceOrAbsent,
  dateOrNull,
  intOrText,
  longOrNull,
  registerKey,
  requiredDate,
  textOrNull,
  useRegisterSave,
  useSpanText,
  type RegisterColumn,
  type RegisterFormProps,
} from './register-table';

/**
 * The activities register (`accreditation/activities`): what the library did, when, with how many participants and
 * which partner, and two flags that let one activity count for more indicators: it used the library's facilities (a
 * lesson held in the library), and a speaker or literacy activist came from outside. Photos and attendance lists are
 * the row's attachments.
 */

interface ActivityValues {
  kind: ActivityKind | '';
  title: string;
  heldOn: string;
  endedOn: string;
  participants: string;
  partner: string;
  usesLibraryFacility: boolean;
  externalSpeaker: boolean;
  description: string;
}

const EMPTY: ActivityValues = {
  kind: '',
  title: '',
  heldOn: '',
  endedOn: '',
  participants: '',
  partner: '',
  usesLibraryFacility: false,
  externalSpeaker: false,
  description: '',
};

const valuesOf = (row: ActivityView): ActivityValues => ({
  kind: row.kind,
  title: row.title,
  heldOn: row.heldOn,
  endedOn: row.endedOn ?? '',
  participants: row.participants === null ? '' : String(row.participants),
  partner: row.partner ?? '',
  usesLibraryFacility: row.usesLibraryFacility,
  externalSpeaker: row.externalSpeaker,
  description: row.description ?? '',
});

const activityBody = (v: ActivityValues) => ({
  kind: choiceOrAbsent(v.kind),
  title: v.title.trim(),
  heldOn: requiredDate(v.heldOn),
  endedOn: dateOrNull(v.endedOn),
  participants: intOrText(v.participants),
  partner: textOrNull(v.partner),
  usesLibraryFacility: v.usesLibraryFacility,
  externalSpeaker: v.externalSpeaker,
  description: longOrNull(v.description),
});

function ActivityForm({ row, canManage, onSaved, onCancel }: RegisterFormProps<ActivityView>) {
  const t = useT();
  const base = row === null ? EMPTY : valuesOf(row);
  const form = useForm<ActivityValues>({ defaultValues: base });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const { submit, problem } = useRegisterSave({
    form,
    row,
    create: { path: 'accreditation/activities', schema: ActivityBody },
    update: { path: (id) => `accreditation/activities/${encodeURIComponent(id)}`, schema: ActivityPatchBody },
    body: (v) => (row === null ? activityBody(v) : changedFields(activityBody(v), activityBody(base))),
    invalidate: registerKey('activities'),
    onSaved,
    onUnchanged: onCancel,
  });
  const disabled = !canManage;
  return (
    <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)}>
      <ProblemAlert error={problem} />
      <RootError message={errors.root?.['server']?.message} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('accreditation.registers.activities.field.kind')} error={errors.kind}>
          {(c) => (
            <VocabSelect
              {...c}
              values={ACTIVITY_KINDS}
              label={(k) => t(vocabKey('activity_kind', k))}
              empty={t('accreditation.registers.choose')}
              disabled={disabled}
              {...form.register('kind')}
            />
          )}
        </Field>
        <Field label={t('accreditation.registers.activities.field.participants')} error={errors.participants}>
          {(c) => <Input {...c} type="number" inputMode="numeric" min={0} step={1} disabled={disabled} {...form.register('participants')} />}
        </Field>
        <Field label={t('accreditation.registers.field.title')} error={errors.title} className="sm:col-span-2">
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('title')} />}
        </Field>
        <Field label={t('accreditation.registers.activities.field.held_on')} error={errors.heldOn}>
          {(c) => <Input {...c} type="date" disabled={disabled} {...form.register('heldOn')} />}
        </Field>
        <Field
          label={t('accreditation.registers.activities.field.ended_on')}
          hint={t('accreditation.registers.activities.field.ended_on_hint')}
          error={errors.endedOn}>
          {(c) => <Input {...c} type="date" disabled={disabled} {...form.register('endedOn')} />}
        </Field>
        <Field label={t('accreditation.registers.activities.field.partner')} error={errors.partner} className="sm:col-span-2">
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('partner')} />}
        </Field>
      </div>
      <div className="grid gap-3">
        <CheckField
          label={t('accreditation.registers.activities.field.uses_library_facility')}
          hint={t('accreditation.registers.activities.field.uses_library_facility_hint')}
          disabled={disabled}
          {...form.register('usesLibraryFacility')}
        />
        <CheckField
          label={t('accreditation.registers.activities.field.external_speaker')}
          hint={t('accreditation.registers.activities.field.external_speaker_hint')}
          disabled={disabled}
          {...form.register('externalSpeaker')}
        />
      </div>
      <Field label={t('accreditation.registers.activities.field.description')} error={errors.description}>
        {(c) => <textarea {...c} className={TEXTAREA_CLASS} disabled={disabled} {...form.register('description')} />}
      </Field>
      <FormButtons canManage={canManage} busy={isSubmitting} onCancel={onCancel} />
    </form>
  );
}

/** The activities register: newest first, with its flags. */
export function ActivitiesRegister() {
  const t = useT();
  const count = useCount();
  const span = useSpanText();
  const columns: RegisterColumn<ActivityView>[] = [
    { id: 'date', header: t('accreditation.registers.activities.col.date'), cell: (r) => <span className="whitespace-nowrap">{span(r.heldOn, r.endedOn)}</span> },
    { id: 'kind', header: t('accreditation.registers.activities.col.kind'), cell: (r) => t(vocabKey('activity_kind', r.kind)) },
    {
      id: 'title',
      header: t('accreditation.registers.activities.col.title'),
      cell: (r) => (
        <span className="grid">
          <span className="font-medium">{r.title}</span>
          {r.partner !== null && <span className="text-muted-foreground">{r.partner}</span>}
        </span>
      ),
    },
    {
      id: 'participants',
      header: t('accreditation.registers.activities.col.participants'),
      cell: (r) => <span className="tabular-nums">{r.participants === null ? '—' : count(r.participants)}</span>,
    },
    {
      id: 'flags',
      header: t('accreditation.registers.activities.col.flags'),
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.usesLibraryFacility && <Badge tone="info">{t('accreditation.registers.activities.badge.facility')}</Badge>}
          {r.externalSpeaker && <Badge tone="info">{t('accreditation.registers.activities.badge.speaker')}</Badge>}
        </span>
      ),
    },
  ];
  return <RegisterSection kind="activities" entity="library_activities" columns={columns} nameOf={(r) => r.title} form={ActivityForm} />;
}
