import { EDUCATION_LEVELS, EMPLOYMENTS, STAFF_ROLES, vocabKey, type EducationLevel, type Employment, type StaffRole } from '@altis/shared';
import { StaffBody, StaffPatchBody, type StaffView } from '@altis/shared/api/accreditation';
import { useForm } from 'react-hook-form';
import { CheckField, Field, ProblemAlert, RootError } from '@/components/form-field';
import { Tag } from '@/components/layout';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { changedFields } from '@/screens/catalog/masters/master-table';
import {
  FormButtons,
  RegisterSection,
  VocabSelect,
  choiceOrAbsent,
  choiceOrNull,
  dateOrNull,
  registerKey,
  requiredDate,
  textOrNull,
  useDateText,
  useRegisterSave,
  useSpanText,
  type RegisterColumn,
  type RegisterFormProps,
} from './register-table';
import { TrainingsPanel } from './trainings';

/**
 * The staff register (`accreditation/staff`): the people who run the library, with their role, whether they are a
 * functional librarian (whatever their role), their employment, education, training and certificates, the number of
 * their appointment decree and when they served. A person's trainings (continuing professional development) are kept
 * inline, in that person's panel (trainings.tsx); the list shows them under each person.
 */

interface StaffValues {
  name: string;
  position: string;
  role: StaffRole | '';
  isLibrarian: boolean;
  employment: Employment | '';
  educationLevel: EducationLevel | '';
  educationLibrary: boolean;
  libraryTraining: boolean;
  competencyCert: boolean;
  associationMember: boolean;
  appointmentRef: string;
  startsOn: string;
  endsOn: string;
}

const EMPTY: StaffValues = {
  name: '',
  position: '',
  role: '',
  isLibrarian: false,
  employment: '',
  educationLevel: '',
  educationLibrary: false,
  libraryTraining: false,
  competencyCert: false,
  associationMember: false,
  appointmentRef: '',
  startsOn: '',
  endsOn: '',
};

const valuesOf = (row: StaffView): StaffValues => ({
  name: row.name,
  position: row.position ?? '',
  role: row.role,
  isLibrarian: row.isLibrarian,
  employment: row.employment ?? '',
  educationLevel: row.educationLevel ?? '',
  educationLibrary: row.educationLibrary,
  libraryTraining: row.libraryTraining,
  competencyCert: row.competencyCert,
  associationMember: row.associationMember,
  appointmentRef: row.appointmentRef ?? '',
  startsOn: row.startsOn ?? '',
  endsOn: row.endsOn ?? '',
});

const staffBody = (v: StaffValues) => ({
  name: v.name.trim(),
  position: textOrNull(v.position),
  role: choiceOrAbsent(v.role),
  isLibrarian: v.isLibrarian,
  employment: choiceOrNull(v.employment),
  educationLevel: choiceOrNull(v.educationLevel),
  educationLibrary: v.educationLibrary,
  libraryTraining: v.libraryTraining,
  competencyCert: v.competencyCert,
  associationMember: v.associationMember,
  appointmentRef: textOrNull(v.appointmentRef),
  startsOn: requiredDate(v.startsOn),
  endsOn: dateOrNull(v.endsOn),
});

function StaffForm({ row, canManage, onSaved, onCancel }: RegisterFormProps<StaffView>) {
  const t = useT();
  const base = row === null ? EMPTY : valuesOf(row);
  const form = useForm<StaffValues>({ defaultValues: base });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const { submit, problem } = useRegisterSave({
    form,
    row,
    create: { path: 'accreditation/staff', schema: StaffBody },
    update: { path: (id) => `accreditation/staff/${encodeURIComponent(id)}`, schema: StaffPatchBody },
    body: (v) => (row === null ? staffBody(v) : changedFields(staffBody(v), staffBody(base))),
    invalidate: registerKey('staff'),
    onSaved,
    onUnchanged: onCancel,
  });
  const disabled = !canManage;
  const unset = t('accreditation.registers.unset');
  return (
    <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)}>
      <ProblemAlert error={problem} />
      <RootError message={errors.root?.['server']?.message} />
      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
        <Field label={t('accreditation.registers.staff.field.name')} error={errors.name}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('name')} />}
        </Field>
        <Field label={t('accreditation.registers.staff.field.position')} error={errors.position}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('position')} />}
        </Field>
        <Field label={t('accreditation.registers.staff.field.role')} error={errors.role}>
          {(c) => (
            <VocabSelect
              {...c}
              values={STAFF_ROLES}
              label={(v) => t(vocabKey('staff_role', v))}
              empty={t('accreditation.registers.choose')}
              disabled={disabled}
              {...form.register('role')}
            />
          )}
        </Field>
        <Field label={t('accreditation.registers.staff.field.employment')} error={errors.employment}>
          {(c) => (
            <VocabSelect {...c} values={EMPLOYMENTS} label={(v) => t(vocabKey('employment', v))} empty={unset} disabled={disabled} {...form.register('employment')} />
          )}
        </Field>
        <Field label={t('accreditation.registers.staff.field.education_level')} error={errors.educationLevel}>
          {(c) => (
            <VocabSelect
              {...c}
              values={EDUCATION_LEVELS}
              label={(v) => t(vocabKey('education_level', v))}
              empty={unset}
              disabled={disabled}
              {...form.register('educationLevel')}
            />
          )}
        </Field>
        <Field label={t('accreditation.registers.staff.field.appointment_ref')} error={errors.appointmentRef}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('appointmentRef')} />}
        </Field>
        <Field label={t('accreditation.registers.staff.field.starts_on')} error={errors.startsOn}>
          {(c) => <Input {...c} type="date" disabled={disabled} {...form.register('startsOn')} />}
        </Field>
        <Field label={t('accreditation.registers.staff.field.ends_on')} hint={t('accreditation.registers.staff.field.ends_on_hint')} error={errors.endsOn}>
          {(c) => <Input {...c} type="date" disabled={disabled} {...form.register('endsOn')} />}
        </Field>
      </div>
      <div className="grid gap-3">
        <CheckField
          label={t('accreditation.registers.staff.field.is_librarian')}
          hint={t('accreditation.registers.staff.field.is_librarian_hint')}
          disabled={disabled}
          {...form.register('isLibrarian')}
        />
        <CheckField label={t('accreditation.registers.staff.field.education_library')} disabled={disabled} {...form.register('educationLibrary')} />
        <CheckField label={t('accreditation.registers.staff.field.library_training')} disabled={disabled} {...form.register('libraryTraining')} />
        <CheckField label={t('accreditation.registers.staff.field.competency_cert')} disabled={disabled} {...form.register('competencyCert')} />
        <CheckField label={t('accreditation.registers.staff.field.association_member')} disabled={disabled} {...form.register('associationMember')} />
      </div>
      <FormButtons canManage={canManage} busy={isSubmitting} onCancel={onCancel} />
    </form>
  );
}

/** The staff register: by role, then by name, with each person's trainings. */
export function StaffRegister() {
  const t = useT();
  const span = useSpanText();
  const date = useDateText();
  const columns: RegisterColumn<StaffView>[] = [
    {
      id: 'name',
      header: t('accreditation.registers.staff.col.name'),
      cell: (r) => (
        <span className="grid">
          <span className="font-semibold">{r.name}</span>
          {r.position !== null && <span className="text-muted-foreground">{r.position}</span>}
        </span>
      ),
    },
    {
      id: 'role',
      header: t('accreditation.registers.staff.col.role'),
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1">
          <span>{t(vocabKey('staff_role', r.role))}</span>
          {r.isLibrarian && <Tag>{t('accreditation.registers.staff.badge.librarian')}</Tag>}
        </span>
      ),
    },
    { id: 'serving', header: t('accreditation.registers.staff.col.serving'), cell: (r) => <span className="whitespace-nowrap">{span(r.startsOn, r.endsOn, true)}</span> },
    {
      id: 'trainings',
      header: t('accreditation.registers.staff.col.trainings'),
      cell: (r) =>
        r.trainings.length === 0 ? (
          <span className="text-muted-foreground">{t('accreditation.registers.staff.trainings_none')}</span>
        ) : (
          <ul className="grid gap-0.5">
            {r.trainings.map((training) => (
              <li key={training.id}>
                {training.title} <span className="text-muted-foreground">({date(training.heldOn)})</span>
              </li>
            ))}
          </ul>
        ),
    },
  ];
  return (
    <RegisterSection
      kind="staff"
      entity="library_staff"
      columns={columns}
      nameOf={(r) => r.name}
      form={StaffForm}
      extra={(row, canManage) => <TrainingsPanel staff={row} canManage={canManage} />}
    />
  );
}
