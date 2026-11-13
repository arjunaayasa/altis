import { isPersonalColumn } from '@altis/db';
import type { ReportColumn, ReportDefinition } from './types.js';

// Which reports hold personal data (spec §3.7, §12): a table report whose columns, for any value of the parameters
// that shape them, include a column sourced from a registered personal column must be declared `personal` (its export
// then needs a fresh re-authentication and is audited). The registry test holds every definition to that rule.

/** The columns `def` answers for `params` (a document has none). */
export function columnsOf(def: ReportDefinition, params: Record<string, unknown> = {}): readonly ReportColumn[] {
  if (def.kind !== 'table') return [];
  return typeof def.columns === 'function' ? def.columns(params) : def.columns;
}

/**
 * The parameter values that can shape `def`'s columns: none at all, then each option of each `status` parameter (in
 * a list for a `multiple` one), a year for a `year`, `true` for a `bool`, the least value for an `int`.
 */
export function columnShapes(def: ReportDefinition): Record<string, unknown>[] {
  const shapes: Record<string, unknown>[] = [{}];
  for (const p of def.params) {
    if (p.kind === 'status') for (const option of p.options ?? []) shapes.push({ [p.name]: p.multiple === true ? [option] : option });
    else if (p.kind === 'year') shapes.push({ [p.name]: p.min ?? 2000 });
    else if (p.kind === 'bool') shapes.push({ [p.name]: true });
    else if (p.kind === 'int') shapes.push({ [p.name]: p.min ?? 0 });
  }
  return shapes;
}

/** True when a column of `def`, for any of its {@link columnShapes}, comes from a registered personal column. */
export function showsPersonalColumn(def: ReportDefinition): boolean {
  return columnShapes(def).some((params) =>
    columnsOf(def, params).some((c) => c.source !== undefined && isPersonalColumn(c.source.table, c.source.column)),
  );
}
