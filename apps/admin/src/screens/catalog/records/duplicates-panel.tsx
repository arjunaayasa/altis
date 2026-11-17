import { DuplicateCheckBody, type DuplicateCheckResponse } from '@altis/shared/api/catalog/records';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useWatch, type Control } from 'react-hook-form';
import { Badge } from '@/components/form-field';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { useDebounced } from './agent-picker';
import type { RecordFormValues } from './draft-to-form';

/**
 * The live duplicate check of the record editor (Phase 2 spec §3.3: "saat mengetik di editor (berjeda 500 ms)"; plan
 * Task 24): `POST catalog/records/duplicates` (a read, `mode: read`) with what the form holds so far: the title (the
 * check waits for one), the subtitle, the year, the identifiers given, the main agent's name, the publisher's name,
 * and on an existing record its own id (`excludeId`). It runs 500 ms after the last change, and the last answer stays
 * up while the next one loads.
 *
 * The server answers at most 5 candidates at or above `catalog.dedupe.threshold`, each with its score (0-100) and why
 * (§3.3). Each opens in a new tab, so what is being typed here stays.
 */

/** The wait after the last change (§3.3). */
const DEBOUNCE_MS = 500;

/**
 * The check's body for `v` (as JSON, a stable query key), or null when the form holds no usable title. A part that is
 * out of bounds while being typed (a half-written identifier, a 300-character name) is left out of the check rather
 * than stopping it.
 */
export function checkBody(
  v: Pick<RecordFormValues, 'title' | 'subtitle' | 'publicationYear' | 'identifiers' | 'agents' | 'publisher'>,
  excludeId: string | null,
): string | null {
  const body: Record<string, unknown> = { title: v.title.trim() };
  if (v.subtitle.trim() !== '') body['subtitle'] = v.subtitle.trim();
  if (/^\d{4}$/.test(v.publicationYear.trim())) body['year'] = v.publicationYear.trim();
  const identifiers = v.identifiers
    .filter((i) => i.value.trim() !== '')
    .map((i) => (i.qualifier.trim() === '' ? { type: i.type, value: i.value.trim() } : { type: i.type, value: i.value.trim(), qualifier: i.qualifier.trim() }));
  if (identifiers.length > 0) body['identifiers'] = identifiers;
  const main = v.agents.find((a) => a.isMain)?.ref.name.trim();
  if (main !== undefined && main !== '') body['mainAgentName'] = main;
  const publisher = v.publisher?.name.trim();
  if (publisher !== undefined && publisher !== '') body['publisherName'] = publisher;
  if (excludeId !== null) body['excludeId'] = excludeId;
  let parsed = DuplicateCheckBody.safeParse(body);
  if (!parsed.success) {
    // Drop each optional part the contract refuses, then check once more; a refused title stops the check.
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      if (key === '' || key === 'title') return null;
      delete body[key];
    }
    parsed = DuplicateCheckBody.safeParse(body);
  }
  return parsed.success ? JSON.stringify(parsed.data) : null;
}

export function DuplicatesPanel({ control, excludeId }: { control: Control<RecordFormValues>; excludeId: string | null }) {
  const t = useT();
  const me = useMe();
  const headingId = useId();
  const [title, subtitle, publicationYear, identifiers, agents, publisher] = useWatch({
    control,
    name: ['title', 'subtitle', 'publicationYear', 'identifiers', 'agents', 'publisher'],
  });
  const body = checkBody({ title, subtitle, publicationYear, identifiers, agents, publisher }, excludeId);
  const settled = useDebounced(body, DEBOUNCE_MS);
  const check = useQuery({
    queryKey: ['catalog', 'records', 'duplicates', settled],
    queryFn: ({ signal }) => api<DuplicateCheckResponse>('POST', 'catalog/records/duplicates', JSON.parse(settled as string) as unknown, { signal }),
    enabled: me !== undefined && settled !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });
  const candidates = check.data?.candidates ?? [];

  return (
    <section aria-labelledby={headingId} className="grid content-start gap-3 p-4">
      <div className="grid gap-1">
        <h2 id={headingId} className="text-base font-bold">
          {t('catalog.records.dup.title')}
        </h2>
        <p className="text-meta text-muted-foreground">{t('catalog.records.dup.hint')}</p>
      </div>
      {body === null ? (
        <p className="text-sm text-muted-foreground">{t('catalog.records.dup.wait')}</p>
      ) : check.isError && check.data === undefined ? (
        <p role="alert" className="text-sm font-semibold text-bad">
          {t('catalog.records.dup.failed')} {problemText(t, check.error)}
        </p>
      ) : check.data === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('catalog.records.dup.checking')}
        </p>
      ) : candidates.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('catalog.records.dup.none')}
        </p>
      ) : (
        <ul className="grid gap-2" aria-busy={check.isFetching || undefined}>
          {candidates.map((c) => (
            <li key={c.recordId} className="grid gap-1 rounded-md border bg-background px-3 py-2.5 text-sm">
              <a
                href={`/admin/catalog/records/${encodeURIComponent(c.recordId)}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('catalog.records.dup.open', { title: c.title })}
                className="font-semibold text-accent-text underline-offset-4 hover:underline"
              >
                {c.title}
              </a>
              <span className="flex flex-wrap items-center gap-1">
                {c.year !== null && <span className="text-muted-foreground">{c.year}</span>}
                <Badge tone={c.score >= 100 ? 'danger' : 'warning'}>{t('catalog.records.dup.score', { score: c.score })}</Badge>
                {c.reasons.map((r) => (
                  <Badge key={r}>{t(`catalog.records.dup.reason.${r}`)}</Badge>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
