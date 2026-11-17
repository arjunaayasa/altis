import type { PeriodSummaryView } from '@altis/shared/api/accreditation';
import { useId, type JSX } from 'react';
import { Field, SELECT_CLASS } from '@/components/form-field';
import { useT } from '@/i18n';
import { useFormats } from '@/screens/accreditation/data';

/**
 * The period picker of the workspace: every live period, newest first, by its name and span, a frozen one marked so.
 * Choosing one calls `onChange` with its id.
 */
export function PeriodPicker({
  periods,
  value,
  onChange,
}: {
  periods: readonly PeriodSummaryView[];
  value: string;
  onChange(id: string): void;
}): JSX.Element {
  const t = useT();
  const f = useFormats();
  const id = useId();
  return (
    <Field id={id} label={t('accreditation.picker.label')} className="max-w-md">
      <select id={id} className={SELECT_CLASS} value={value} onChange={(e) => onChange(e.target.value)}>
        {periods.map((p) => {
          const label = t('accreditation.picker.option', { name: p.name, from: f.day(p.startsOn), to: f.day(p.endsOn) });
          return (
            <option key={p.id} value={p.id}>
              {p.status === 'frozen' ? `${label} · ${t('accreditation.picker.frozen')}` : label}
            </option>
          );
        })}
      </select>
    </Field>
  );
}
