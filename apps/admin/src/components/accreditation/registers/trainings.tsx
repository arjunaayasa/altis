import { TrainingBody, TrainingPatchBody, type StaffView, type TrainingView } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { useQueryClient } from '@tanstack/react-query';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useId, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { Field, Notice, ProblemAlert, RootError } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { changedFields, isStale, useCount } from '@/screens/catalog/masters/master-table';
import {
  FileLink,
  KEEP_FILE,
  RegisterFileField,
  intOrText,
  registerKey,
  requiredDate,
  textOrNull,
  useDateText,
  useRegisterSave,
  type FileChoice,
} from './register-table';

/**
 * The trainings of one staff member (continuing professional development), inside that person's panel: a table, an
 * inline form to add or edit one (`POST accreditation/staff/:id/trainings`, `PATCH accreditation/trainings/:id`) with
 * its certificate, and archive after a confirmation (`DELETE accreditation/trainings/:id`). The trainings come
 * embedded in the staff list, so every write reads that list again.
 */

interface TrainingValues {
  title: string;
  organizer: string;
  heldOn: string;
  hours: string;
}

const EMPTY: TrainingValues = { title: '', organizer: '', heldOn: '', hours: '' };

const valuesOf = (row: TrainingView): TrainingValues => ({
  title: row.title,
  organizer: row.organizer ?? '',
  heldOn: row.heldOn,
  hours: row.hours === null ? '' : String(row.hours),
});

const trainingBody = (v: TrainingValues) => ({
  title: v.title.trim(),
  organizer: textOrNull(v.organizer),
  heldOn: requiredDate(v.heldOn),
  hours: intOrText(v.hours),
});

/** The inline form of one training (null: a new one). */
function TrainingForm({
  staff,
  training,
  onSaved,
  onCancel,
}: {
  staff: StaffView;
  training: TrainingView | null;
  onSaved(title: string): Promise<void>;
  onCancel(): void;
}) {
  const t = useT();
  const base = training === null ? EMPTY : valuesOf(training);
  const form = useForm<TrainingValues>({ defaultValues: base });
  const [certificate, setCertificate] = useState<FileChoice>(KEEP_FILE);
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty || certificate.kind !== 'keep');
  const { submit, problem, fileError } = useRegisterSave({
    form,
    row: training,
    create: { path: `accreditation/staff/${encodeURIComponent(staff.id)}/trainings`, schema: TrainingBody },
    update: { path: (id) => `accreditation/trainings/${encodeURIComponent(id)}`, schema: TrainingPatchBody },
    body: (v) => (training === null ? trainingBody(v) : changedFields(trainingBody(v), trainingBody(base))),
    file: { key: 'certificateUploadId', choice: certificate },
    invalidate: registerKey('staff'),
    onSaved: () => onSaved(form.getValues('title').trim()),
    onUnchanged: onCancel,
  });
  return (
    <form
      noValidate
      aria-label={t(training === null ? 'accreditation.registers.trainings.add' : 'accreditation.registers.trainings.edit')}
      className="grid gap-4 rounded-lg border bg-layer p-4"
      onSubmit={(e) => void submit(e)}>
      <ProblemAlert error={problem} />
      <RootError message={errors.root?.['server']?.message} />
      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
        <Field label={t('accreditation.registers.trainings.field.title')} error={errors.title} className="sm:col-span-2">
          {(c) => <Input {...c} autoComplete="off" maxLength={191} {...form.register('title')} />}
        </Field>
        <Field label={t('accreditation.registers.trainings.field.organizer')} error={errors.organizer} className="sm:col-span-2">
          {(c) => <Input {...c} autoComplete="off" maxLength={191} {...form.register('organizer')} />}
        </Field>
        <Field label={t('accreditation.registers.trainings.field.held_on')} error={errors.heldOn}>
          {(c) => <Input {...c} type="date" {...form.register('heldOn')} />}
        </Field>
        <Field label={t('accreditation.registers.trainings.field.hours')} error={errors.hours}>
          {(c) => <Input {...c} type="number" inputMode="numeric" min={0} max={32767} step={1} {...form.register('hours')} />}
        </Field>
      </div>
      <RegisterFileField
        label={t('accreditation.registers.trainings.field.certificate')}
        current={training?.certificateFileId == null ? null : { id: training.certificateFileId, name: training.certificateFileName }}
        choice={certificate}
        onChoice={setCertificate}
        error={fileError}
        disabled={false}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? t('form.saving') : t('accreditation.registers.trainings.save')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          {t('form.cancel')}
        </Button>
      </div>
    </form>
  );
}

const features = tableFeatures({});
const column = createColumnHelper<typeof features, TrainingView>();

/** The trainings of `staff` (in its panel): the table, the inline form, the archive confirmation. */
export function TrainingsPanel({ staff, canManage }: { staff: StaffView; canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const date = useDateText();
  const count = useCount();
  const headingId = useId();
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [archiving, setArchiving] = useState<TrainingView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: registerKey('staff') });

  const archive = async (training: TrainingView): Promise<void> => {
    setNotice(null);
    try {
      await api<StoreResponse>('DELETE', `accreditation/trainings/${encodeURIComponent(training.id)}`);
    } catch (e) {
      if (isStale(e)) await refresh();
      throw e;
    }
    if (editing?.id === training.id) setEditing(null);
    setNotice(t('accreditation.registers.trainings.done.archived', { name: training.title }));
    await refresh();
  };

  const columns = useMemo(() => {
    const base = [
      column.display({
        id: 'title',
        header: t('accreditation.registers.trainings.col.title'),
        cell: (info) => (
          <span className="grid">
            <span className="font-semibold">{info.row.original.title}</span>
            {info.row.original.organizer !== null && <span className="text-muted-foreground">{info.row.original.organizer}</span>}
          </span>
        ),
      }),
      column.display({ id: 'heldOn', header: t('accreditation.registers.trainings.col.held_on'), cell: (info) => <span className="whitespace-nowrap">{date(info.row.original.heldOn)}</span> }),
      column.display({
        id: 'hours',
        header: t('accreditation.registers.trainings.col.hours'),
        cell: (info) => <span className="tabular-nums">{info.row.original.hours === null ? '—' : count(info.row.original.hours)}</span>,
      }),
      column.display({
        id: 'certificate',
        header: t('accreditation.registers.trainings.col.certificate'),
        cell: (info) => <FileLink id={info.row.original.certificateFileId} name={info.row.original.certificateFileName} />,
      }),
    ];
    if (!canManage) return column.columns(base);
    return column.columns([
      ...base,
      column.display({
        id: 'actions',
        header: t('accreditation.registers.col.actions'),
        cell: (info) => (
          <span className="flex flex-wrap gap-1 whitespace-nowrap">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t('accreditation.registers.trainings.action.edit_named', { name: info.row.original.title })}
              onClick={() => {
                setNotice(null);
                setEditing({ id: info.row.original.id });
              }}>
              {t('accreditation.registers.action.edit')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t('accreditation.registers.trainings.action.archive_named', { name: info.row.original.title })}
              onClick={() => setArchiving(info.row.original)}>
              {t('accreditation.registers.action.archive')}
            </Button>
          </span>
        ),
      }),
    ]);
  }, [t, date, count, canManage]);

  const table = useTable({ features, columns, data: staff.trainings, getRowId: (row) => row.id });
  const training = editing === null || editing.id === null ? null : (staff.trainings.find((r) => r.id === editing.id) ?? null);

  return (
    <section aria-labelledby={headingId} className="grid gap-3 border-t pt-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1">
          <h3 id={headingId} className="text-base font-bold">
            {t('accreditation.registers.trainings.title')}
          </h3>
          <p className="text-sm text-muted-foreground">{t('accreditation.registers.trainings.intro', { name: staff.name })}</p>
        </div>
        {canManage && editing === null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setNotice(null);
              setEditing({ id: null });
            }}>
            {t('accreditation.registers.trainings.add')}
          </Button>
        )}
      </div>
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      <DataTable table={table} caption={t('accreditation.registers.trainings.caption', { name: staff.name })} empty={t('accreditation.registers.trainings.empty')} />
      {canManage && editing !== null && (editing.id === null || training !== null) && (
        <TrainingForm
          key={editing.id ?? 'new'}
          staff={staff}
          training={training}
          onCancel={() => setEditing(null)}
          onSaved={async (title) => {
            await refresh();
            setEditing(null);
            setNotice(t('accreditation.registers.trainings.done.saved', { name: title }));
          }}
        />
      )}
      {archiving !== null && (
        <ConfirmDialog
          open
          destructive
          title={t('accreditation.registers.trainings.confirm.title', { name: archiving.title })}
          description={t('accreditation.registers.trainings.confirm.body')}
          confirmLabel={t('accreditation.registers.action.archive')}
          onConfirm={() => archive(archiving)}
          onClose={() => setArchiving(null)}
        />
      )}
    </section>
  );
}
