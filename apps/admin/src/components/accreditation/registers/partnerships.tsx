import { PARTNERSHIP_KINDS, vocabKey, type PartnershipKind } from '@altis/shared';
import { PartnershipBody, PartnershipPatchBody, type PartnershipView } from '@altis/shared/api/accreditation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Field, ProblemAlert, RootError, TEXTAREA_CLASS } from '@/components/form-field';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { changedFields } from '@/screens/catalog/masters/master-table';
import {
  FileLink,
  FormButtons,
  KEEP_FILE,
  RegisterFileField,
  RegisterSection,
  VocabSelect,
  choiceOrAbsent,
  dateOrNull,
  longOrNull,
  registerKey,
  requiredDate,
  useRegisterSave,
  useSpanText,
  type FileChoice,
  type RegisterColumn,
  type RegisterFormProps,
} from './register-table';

/**
 * The partnerships register (`accreditation/partnerships`): the library's memoranda and agreements with other
 * institutions, when they hold, what they cover, and the signed document, which the row holds itself
 * (`documentUploadId`, uploaded when the form is saved).
 */

interface PartnershipValues {
  partner: string;
  kind: PartnershipKind | '';
  startsOn: string;
  endsOn: string;
  scope: string;
}

const EMPTY: PartnershipValues = { partner: '', kind: '', startsOn: '', endsOn: '', scope: '' };

const valuesOf = (row: PartnershipView): PartnershipValues => ({
  partner: row.partner,
  kind: row.kind,
  startsOn: row.startsOn,
  endsOn: row.endsOn ?? '',
  scope: row.scope ?? '',
});

const partnershipBody = (v: PartnershipValues) => ({
  partner: v.partner.trim(),
  kind: choiceOrAbsent(v.kind),
  startsOn: requiredDate(v.startsOn),
  endsOn: dateOrNull(v.endsOn),
  scope: longOrNull(v.scope),
});

function PartnershipForm({ row, canManage, onSaved, onCancel }: RegisterFormProps<PartnershipView>) {
  const t = useT();
  const base = row === null ? EMPTY : valuesOf(row);
  const form = useForm<PartnershipValues>({ defaultValues: base });
  const [agreement, setAgreement] = useState<FileChoice>(KEEP_FILE);
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty || agreement.kind !== 'keep');
  const { submit, problem, fileError } = useRegisterSave({
    form,
    row,
    create: { path: 'accreditation/partnerships', schema: PartnershipBody },
    update: { path: (id) => `accreditation/partnerships/${encodeURIComponent(id)}`, schema: PartnershipPatchBody },
    body: (v) => (row === null ? partnershipBody(v) : changedFields(partnershipBody(v), partnershipBody(base))),
    file: { key: 'documentUploadId', choice: agreement },
    invalidate: registerKey('partnerships'),
    onSaved,
    onUnchanged: onCancel,
  });
  const disabled = !canManage;
  return (
    <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)}>
      <ProblemAlert error={problem} />
      <RootError message={errors.root?.['server']?.message} />
      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
        <Field label={t('accreditation.registers.partnerships.field.partner')} error={errors.partner}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('partner')} />}
        </Field>
        <Field label={t('accreditation.registers.partnerships.field.kind')} error={errors.kind}>
          {(c) => (
            <VocabSelect
              {...c}
              values={PARTNERSHIP_KINDS}
              label={(v) => t(vocabKey('partnership_kind', v))}
              empty={t('accreditation.registers.choose')}
              disabled={disabled}
              {...form.register('kind')}
            />
          )}
        </Field>
        <Field label={t('accreditation.registers.partnerships.field.starts_on')} error={errors.startsOn}>
          {(c) => <Input {...c} type="date" disabled={disabled} {...form.register('startsOn')} />}
        </Field>
        <Field
          label={t('accreditation.registers.partnerships.field.ends_on')}
          hint={t('accreditation.registers.partnerships.field.ends_on_hint')}
          error={errors.endsOn}>
          {(c) => <Input {...c} type="date" disabled={disabled} {...form.register('endsOn')} />}
        </Field>
      </div>
      <Field label={t('accreditation.registers.partnerships.field.scope')} error={errors.scope}>
        {(c) => <textarea {...c} className={TEXTAREA_CLASS} disabled={disabled} {...form.register('scope')} />}
      </Field>
      <RegisterFileField
        label={t('accreditation.registers.partnerships.field.document')}
        current={row?.documentFileId == null ? null : { id: row.documentFileId, name: row.documentFileName }}
        choice={agreement}
        onChoice={setAgreement}
        error={fileError}
        disabled={disabled}
      />
      <FormButtons canManage={canManage} busy={isSubmitting} onCancel={onCancel} />
    </form>
  );
}

/** The partnerships register: newest first, with the agreement file. */
export function PartnershipsRegister() {
  const t = useT();
  const span = useSpanText();
  const columns: RegisterColumn<PartnershipView>[] = [
    {
      id: 'partner',
      header: t('accreditation.registers.partnerships.col.partner'),
      cell: (r) => (
        <span className="grid">
          <span className="font-semibold">{r.partner}</span>
          {r.scope !== null && <span className="line-clamp-2 text-muted-foreground">{r.scope}</span>}
        </span>
      ),
    },
    { id: 'kind', header: t('accreditation.registers.partnerships.col.kind'), cell: (r) => t(vocabKey('partnership_kind', r.kind)) },
    { id: 'valid', header: t('accreditation.registers.partnerships.col.valid'), cell: (r) => <span className="whitespace-nowrap">{span(r.startsOn, r.endsOn, true)}</span> },
    { id: 'document', header: t('accreditation.registers.partnerships.col.document'), cell: (r) => <FileLink id={r.documentFileId} name={r.documentFileName} /> },
  ];
  return <RegisterSection kind="partnerships" entity="library_partnerships" columns={columns} nameOf={(r) => r.partner} form={PartnershipForm} />;
}
