import { DOCUMENT_ASPECTS, DOCUMENT_KINDS, vocabKey, type DocumentKind } from '@altis/shared';
import { DocumentBody, DocumentPatchBody, type DocumentView } from '@altis/shared/api/accreditation';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { CheckField, Field, ProblemAlert, RootError } from '@/components/form-field';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
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
  registerKey,
  textOrNull,
  useDateText,
  useRegisterSave,
  type FileChoice,
  type RegisterColumn,
  type RegisterFormProps,
} from './register-table';

/**
 * The documents register (`accreditation/documents`): rules, procedures, policies, decrees, work programmes and
 * reports, with their number, date, issuer, validity and file (`fileUploadId`, uploaded when the form is saved). A kind
 * with aspects (the collection development policy, the library's work programme, the head's performance report) shows
 * one checkbox per aspect of `DOCUMENT_ASPECTS[kind]`; the codes are sent in that order, and a kind change drops the
 * aspects the new kind does not have. Every other kind has none and sends an empty list.
 */

interface DocumentValues {
  kind: DocumentKind | '';
  title: string;
  reference: string;
  issuedOn: string;
  issuedBy: string;
  aspectCodes: string[];
  validUntil: string;
}

const EMPTY: DocumentValues = { kind: '', title: '', reference: '', issuedOn: '', issuedBy: '', aspectCodes: [], validUntil: '' };

const valuesOf = (row: DocumentView): DocumentValues => ({
  kind: row.kind,
  title: row.title,
  reference: row.reference ?? '',
  issuedOn: row.issuedOn ?? '',
  issuedBy: row.issuedBy ?? '',
  aspectCodes: [...row.aspectCodes],
  validUntil: row.validUntil ?? '',
});

/** The aspects of `kind` (none for no kind). */
const aspectsOf = (kind: DocumentKind | ''): readonly string[] => (kind === '' ? [] : DOCUMENT_ASPECTS[kind]);

const documentBody = (v: DocumentValues) => ({
  kind: choiceOrAbsent(v.kind),
  title: v.title.trim(),
  reference: textOrNull(v.reference),
  issuedOn: dateOrNull(v.issuedOn),
  issuedBy: textOrNull(v.issuedBy),
  aspectCodes: aspectsOf(v.kind).filter((code) => v.aspectCodes.includes(code)),
  validUntil: dateOrNull(v.validUntil),
});

/** The label of aspect `code` of `kind`. */
const aspectKey = (kind: DocumentKind, code: string): TKey => `accred.aspect.${kind}.${code}` as TKey;

function DocumentForm({ row, canManage, onSaved, onCancel }: RegisterFormProps<DocumentView>) {
  const t = useT();
  const hintId = useId();
  const base = row === null ? EMPTY : valuesOf(row);
  const form = useForm<DocumentValues>({ defaultValues: base });
  const [file, setFile] = useState<FileChoice>(KEEP_FILE);
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty || file.kind !== 'keep');
  const { submit, problem, fileError } = useRegisterSave({
    form,
    row,
    create: { path: 'accreditation/documents', schema: DocumentBody },
    update: { path: (id) => `accreditation/documents/${encodeURIComponent(id)}`, schema: DocumentPatchBody },
    body: (v) => (row === null ? documentBody(v) : changedFields(documentBody(v), documentBody(base))),
    file: { key: 'fileUploadId', choice: file },
    invalidate: registerKey('documents'),
    onSaved,
    onUnchanged: onCancel,
  });
  const disabled = !canManage;
  const kind = form.watch('kind');
  const chosen = form.watch('aspectCodes');
  const aspects = aspectsOf(kind);
  const toggle = (code: string, on: boolean): void => {
    const next = on ? [...chosen.filter((c) => c !== code), code] : chosen.filter((c) => c !== code);
    form.setValue('aspectCodes', next, { shouldDirty: true });
  };
  return (
    <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)}>
      <ProblemAlert error={problem} />
      <RootError message={errors.root?.['server']?.message} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('accreditation.registers.documents.field.kind')} error={errors.kind}>
          {(c) => (
            <VocabSelect
              {...c}
              values={DOCUMENT_KINDS}
              label={(v) => t(vocabKey('document_kind', v))}
              empty={t('accreditation.registers.choose')}
              disabled={disabled}
              {...form.register('kind')}
            />
          )}
        </Field>
        <Field label={t('accreditation.registers.documents.field.reference')} error={errors.reference}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('reference')} />}
        </Field>
        <Field label={t('accreditation.registers.field.title')} error={errors.title} className="sm:col-span-2">
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('title')} />}
        </Field>
        <Field label={t('accreditation.registers.documents.field.issued_on')} error={errors.issuedOn}>
          {(c) => <Input {...c} type="date" disabled={disabled} {...form.register('issuedOn')} />}
        </Field>
        <Field label={t('accreditation.registers.documents.field.issued_by')} error={errors.issuedBy}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('issuedBy')} />}
        </Field>
        <Field label={t('accreditation.registers.documents.field.valid_until')} error={errors.validUntil}>
          {(c) => <Input {...c} type="date" disabled={disabled} {...form.register('validUntil')} />}
        </Field>
      </div>
      {kind !== '' && aspects.length > 0 && (
        <fieldset className="grid gap-2 rounded-md border p-3" aria-describedby={hintId}>
          <legend className="px-1 text-sm font-medium">{t('accreditation.registers.documents.field.aspects')}</legend>
          <p id={hintId} className="text-xs text-muted-foreground">
            {t('accreditation.registers.documents.field.aspects_hint')}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {aspects.map((code) => (
              <CheckField
                key={`${kind}.${code}`}
                label={t(aspectKey(kind, code))}
                checked={chosen.includes(code)}
                disabled={disabled}
                onChange={(e) => toggle(code, e.target.checked)}
              />
            ))}
          </div>
        </fieldset>
      )}
      <RegisterFileField
        label={t('accreditation.registers.documents.field.file')}
        current={row?.fileId == null ? null : { id: row.fileId, name: row.fileName }}
        choice={file}
        onChoice={setFile}
        error={fileError}
        disabled={disabled}
      />
      <FormButtons canManage={canManage} busy={isSubmitting} onCancel={onCancel} />
    </form>
  );
}

/** The documents register: by kind, then newest first, with the share of aspects covered. */
export function DocumentsRegister() {
  const t = useT();
  const date = useDateText();
  const columns: RegisterColumn<DocumentView>[] = [
    { id: 'kind', header: t('accreditation.registers.documents.col.kind'), cell: (r) => t(vocabKey('document_kind', r.kind)) },
    {
      id: 'title',
      header: t('accreditation.registers.documents.col.title'),
      cell: (r) => (
        <span className="grid">
          <span className="font-medium">{r.title}</span>
          {r.reference !== null && <span className="text-muted-foreground">{r.reference}</span>}
        </span>
      ),
    },
    { id: 'issuedOn', header: t('accreditation.registers.documents.col.issued_on'), cell: (r) => <span className="whitespace-nowrap">{date(r.issuedOn)}</span> },
    {
      id: 'aspects',
      header: t('accreditation.registers.documents.col.aspects'),
      cell: (r) => {
        const total = DOCUMENT_ASPECTS[r.kind].length;
        return total === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="whitespace-nowrap">{t('accreditation.registers.documents.aspects_count', { count: r.aspectCodes.length, total })}</span>
        );
      },
    },
    { id: 'file', header: t('accreditation.registers.documents.col.file'), cell: (r) => <FileLink id={r.fileId} name={r.fileName} /> },
  ];
  return <RegisterSection kind="documents" entity="library_documents" columns={columns} nameOf={(r) => r.title} form={DocumentForm} />;
}
