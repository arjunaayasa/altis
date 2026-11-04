import type { ItemDetail } from '@altis/shared/api/catalog/items';
import type { LabelBody } from '@altis/shared/api/catalog/labels';
import type { CatalogConfigView } from '@altis/shared/api/settings';
import { useQueryClient } from '@tanstack/react-query';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { DownloadIcon, ExternalLinkIcon, FileTextIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { PRINT_QUEUE_MAX, usePrintQueue, type QueueEntry } from '@/components/catalog/print-queue';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { Badge, Field, Notice, NoticeAlert, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type TKey } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api, csrfToken, setCsrfToken } from '@/lib/api';
import { buildSync } from '@/lib/build-sync';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { useScannerInput } from '@/lib/scanner';

/**
 * Cetak Label (Phase 2 spec §7, §13; plan Task 30): the print queue (components/catalog/print-queue.tsx) and the
 * label PDF of `POST catalog/labels` (Task 36). Every part needs `catalog.records.read`, the route's permission.
 *
 * - **Queue:** the entries the lists added (items, or records standing for all their items), each with "Keluarkan",
 *   and "Kosongkan antrean" after a confirmation.
 * - **Add by barcode:** a scanner burst anywhere on the page (lib/scanner.ts) or a typed barcode →
 *   `GET catalog/items/by-barcode?barcode=` (M2) → the item joins the queue. An archived item is refused here, since
 *   the label route would skip it.
 * - **PDF:** one kind at a time (`LabelBody` takes `itemIds` or `recordIds`, never both): the profile (from
 *   `GET catalog/config`), the start position (1-1000; past one sheet it wraps to the same slot of a fresh sheet,
 *   Task 7) and the copies (1-5), checked here first. The answer is the PDF itself, offered as "Buka PDF" (a new tab)
 *   and "Unduh PDF" from an object URL (revoked when the next one is made, and when the screen goes); the entries that
 *   gave no label (`X-Altis-Label-Skipped`) are told. The printed entries stay queued until "Keluarkan yang sudah
 *   dicetak" takes them out. A 422 `CATALOG_LABEL_LIMIT` (more than 1 000 labels, records counted with their items)
 *   is explained; a profile that is gone (`profileId not_found`) is said at its field.
 */

const features = tableFeatures({});
const column = createColumnHelper<typeof features, QueueEntry>();

const LABELS_PATH = 'catalog/labels';
/** The longest barcode the lookup takes (`ItemByBarcodeQuery`). */
const BARCODE_MAX = 200;
/** A queue entry's label for an item: its barcode and its record's title. */
const itemLabel = (item: Pick<ItemDetail, 'barcode' | 'record'>): string => `${item.barcode} — ${item.record.title}`;

/** The PDF of a label request, and how many of the requested ids gave no label. */
interface LabelPdf {
  blob: Blob;
  skipped: number;
}

/**
 * `POST catalog/labels` with the page's CSRF token, answered with the bytes as they are. Like every answer lib/api.ts
 * reads, this one feeds `X-Altis-Build` to the build check and hands on a CSRF token the server rotated.
 */
async function postLabels(body: LabelBody, signal?: AbortSignal): Promise<Response> {
  const token = csrfToken();
  const res = await fetch(`/api/v1/${LABELS_PATH}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/pdf, application/problem+json',
      'Content-Type': 'application/json',
      ...(token === null ? {} : { 'X-CSRF-Token': token }),
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  const build = res.headers.get('X-Altis-Build');
  if (build !== null) buildSync.observe(build);
  const rotated = res.headers.get('X-CSRF-Token');
  if (rotated !== null && rotated !== '') setCsrfToken(rotated);
  return res;
}

const isPdf = (res: Response): boolean => res.ok && /^application\/pdf\b/i.test(res.headers.get('Content-Type') ?? '');

async function pdfOf(res: Response): Promise<LabelPdf> {
  const skipped = Number(res.headers.get('X-Altis-Label-Skipped') ?? '0');
  return { blob: await res.blob(), skipped: Number.isSafeInteger(skipped) && skipped > 0 ? skipped : 0 };
}

/**
 * The label PDF of `body`. The answer is binary, so it is read here rather than through the JSON client; a refusal
 * (any answer that is not a PDF) is sent once more through lib/api.ts, which handles it as it handles every other
 * request (a fresh CSRF token, the sign-in page, maintenance, a 429's wait) and throws its ApiError. The route only
 * reads, so asking twice costs nothing but time. When that second request passed (a token was refreshed meanwhile),
 * the PDF is asked for once more.
 */
export async function requestLabelPdf(body: LabelBody, signal?: AbortSignal): Promise<LabelPdf> {
  const first = await postLabels(body, signal);
  if (isPdf(first)) return pdfOf(first);
  await api<unknown>('POST', LABELS_PATH, body, signal === undefined ? {} : { signal });
  const again = await postLabels(body, signal);
  if (isPdf(again)) return pdfOf(again);
  throw new ApiError(again.status, 'INTERNAL', { problemJson: false });
}

/** A whole number from `text` within `min`-`max`, or null. */
function wholeIn(text: string, min: number, max: number): number | null {
  if (!/^\d{1,4}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= min && n <= max ? n : null;
}

// ---- adding by barcode ---------------------------------------------------------------------------------------------

type ScanOutcome =
  | { kind: 'searching'; barcode: string }
  | { kind: 'queued'; added: boolean; label: string; dropped: number }
  | { kind: 'not_found' | 'invalid' | 'archived'; barcode: string }
  | { kind: 'error'; error: unknown };

function ScanPanel({ add }: { add(e: QueueEntry[]): { added: number; dropped: number } }) {
  const t = useT();
  const number = new Intl.NumberFormat(useLocale() === 'en' ? 'en' : 'id');
  const titleId = useId();
  const [barcode, setBarcode] = useState('');
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  /** The lookup in flight: a newer scan supersedes it. */
  const current = useRef(0);

  const lookUp = async (raw: string): Promise<void> => {
    const code = raw.trim();
    if (code === '') return;
    const n = ++current.current;
    if (code.length > BARCODE_MAX) {
      setOutcome({ kind: 'invalid', barcode: code.slice(0, 40) });
      return;
    }
    setOutcome({ kind: 'searching', barcode: code });
    try {
      const item = await api<ItemDetail>('GET', `catalog/items/by-barcode?barcode=${encodeURIComponent(code)}`);
      if (n !== current.current) return;
      if (item.archived) {
        setOutcome({ kind: 'archived', barcode: item.barcode });
        return;
      }
      const label = itemLabel(item);
      const result = add([{ kind: 'item', id: item.id, label }]);
      setOutcome({ kind: 'queued', added: result.added > 0, label, dropped: result.dropped });
      setBarcode('');
    } catch (e) {
      if (n !== current.current) return;
      if (e instanceof ApiError && e.code === 'NOT_FOUND') setOutcome({ kind: 'not_found', barcode: code });
      else if (e instanceof ApiError && e.code === 'VALIDATION_FAILED') setOutcome({ kind: 'invalid', barcode: code });
      else setOutcome({ kind: 'error', error: e });
    }
  };

  useScannerInput({ onScan: (code) => void lookUp(code), minLength: 3 });

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void lookUp(barcode);
  };

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <h2 id={titleId} className="text-base font-semibold">
        {t('catalog.labels.scan.title')}
      </h2>
      <form noValidate onSubmit={submit} className="max-w-xl">
        <Field label={t('catalog.labels.scan.barcode')} hint={t('catalog.labels.scan.hint')}>
          {(c) => (
            <div className="flex gap-2">
              <Input {...c} value={barcode} maxLength={BARCODE_MAX} autoComplete="off" spellCheck={false} onChange={(e) => setBarcode(e.target.value)} />
              <Button type="submit" variant="outline">
                <PlusIcon aria-hidden="true" />
                {t('catalog.labels.scan.submit')}
              </Button>
            </div>
          )}
        </Field>
      </form>
      {outcome !== null &&
        (outcome.kind === 'searching' ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('catalog.labels.scan.searching', { barcode: outcome.barcode })}
          </p>
        ) : outcome.kind === 'queued' ? (
          <Notice kind="success">
            {t(outcome.added ? 'catalog.labels.scan.added' : 'catalog.labels.scan.already', { label: outcome.label })}
            {outcome.dropped > 0 && <> {t('catalog.labels.queue.dropped', { count: number.format(outcome.dropped) })}</>}
          </Notice>
        ) : outcome.kind === 'error' ? (
          <Notice kind="error">{problemText(t, outcome.error)}</Notice>
        ) : (
          <Notice kind="error">{t(`catalog.labels.scan.${outcome.kind}`, { barcode: outcome.barcode })}</Notice>
        ))}
    </section>
  );
}

// ---- the queue -----------------------------------------------------------------------------------------------------

function QueuePanel({ entries, remove, clear }: { entries: QueueEntry[]; remove(ids: string[]): void; clear(): void }) {
  const t = useT();
  const number = new Intl.NumberFormat(useLocale() === 'en' ? 'en' : 'id');
  const titleId = useId();
  const [clearing, setClearing] = useState(false);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('kind', {
          header: () => t('catalog.labels.queue.col.kind'),
          cell: (c) => <Badge tone={c.getValue() === 'record' ? 'info' : 'neutral'}>{t(`catalog.labels.queue.kind.${c.getValue()}`)}</Badge>,
        }),
        column.accessor('label', { header: () => t('catalog.labels.queue.col.label'), cell: (c) => <span className="break-words">{c.getValue()}</span> }),
        column.display({
          id: 'actions',
          header: () => t('catalog.labels.queue.col.actions'),
          cell: (c) => (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={t('catalog.labels.queue.remove_label', { label: c.row.original.label })}
              onClick={() => remove([c.row.original.id])}
            >
              {t('catalog.labels.queue.remove')}
            </Button>
          ),
        }),
      ]),
    [t, remove],
  );
  const table = useTable({ features, columns, data: entries, getRowId: (e) => `${e.kind}:${e.id}` });

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="text-base font-semibold">
            {t('catalog.labels.queue.title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('catalog.labels.queue.count', { count: number.format(entries.length), max: number.format(PRINT_QUEUE_MAX) })}
          </p>
        </div>
        {entries.length > 0 && (
          <Button type="button" variant="outline" size="sm" onClick={() => setClearing(true)}>
            <Trash2Icon aria-hidden="true" />
            {t('catalog.labels.queue.clear')}
          </Button>
        )}
      </div>
      <DataTable table={table} caption={t('catalog.labels.queue.title')} empty={t('catalog.labels.queue.empty')} />
      <ConfirmDialog
        open={clearing}
        destructive
        title={t('catalog.labels.queue.clear_title')}
        description={t('catalog.labels.queue.clear_body', { count: number.format(entries.length) })}
        confirmLabel={t('catalog.labels.queue.clear_confirm')}
        onConfirm={() => {
          clear();
          return Promise.resolve();
        }}
        onClose={() => setClearing(false)}
      />
    </section>
  );
}

// ---- the PDF -------------------------------------------------------------------------------------------------------

/** A PDF made: its object URL, what it was made of, and how many of those gave no label. */
interface Made {
  url: string;
  ids: string[];
  skipped: number;
  removed: boolean;
}

interface PrintErrors {
  profileId?: TKey;
  start?: TKey;
  copies?: TKey;
}

function PrintPanel({ entries, remove }: { entries: QueueEntry[]; remove(ids: string[]): void }) {
  const t = useT();
  const number = new Intl.NumberFormat(useLocale() === 'en' ? 'en' : 'id');
  const titleId = useId();
  const sourceName = useId();
  const queryClient = useQueryClient();
  const config = useApiQuery<CatalogConfigView>({ queryKey: ['catalog', 'config'], path: 'catalog/config', staleTime: 60_000 });
  const profiles = config.data?.labelProfiles ?? [];

  const items = entries.filter((e) => e.kind === 'item');
  const records = entries.filter((e) => e.kind === 'record');
  const [chosenKind, setChosenKind] = useState<QueueEntry['kind']>('item');
  const kind: QueueEntry['kind'] = chosenKind === 'item' ? (items.length > 0 ? 'item' : 'record') : records.length > 0 ? 'record' : 'item';
  const chosen = kind === 'item' ? items : records;

  const [picked, setPicked] = useState('');
  const profileId = profiles.some((p) => p.id === picked) ? picked : (profiles[0]?.id ?? '');
  const [start, setStart] = useState('1');
  const [copies, setCopies] = useState('1');
  const [errors, setErrors] = useState<PrintErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [made, setMade] = useState<Made | null>(null);

  // The object URL of the PDF shown lives until the next one is shown, or until the screen goes.
  const shownUrl = useRef<string | null>(null);
  const show = (next: Made | null): void => {
    if (shownUrl.current !== null && shownUrl.current !== next?.url) URL.revokeObjectURL(shownUrl.current);
    shownUrl.current = next?.url ?? null;
    setMade(next);
  };
  useEffect(
    () => () => {
      if (shownUrl.current !== null) URL.revokeObjectURL(shownUrl.current);
      shownUrl.current = null;
    },
    [],
  );

  const run = useRef<AbortController | null>(null);
  useEffect(() => () => run.current?.abort(), []);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const startPosition = wholeIn(start, 1, 1000);
    const copyCount = wholeIn(copies, 1, 5);
    const next: PrintErrors = {};
    if (startPosition === null) next.start = 'catalog.labels.print.start_range';
    if (copyCount === null) next.copies = 'catalog.labels.print.copies_range';
    setErrors(next);
    setFailure(null);
    if (startPosition === null || copyCount === null || profileId === '' || chosen.length === 0) return;
    const ids = chosen.map((e) => e.id);
    const body: LabelBody =
      kind === 'item'
        ? { profileId, itemIds: ids, startPosition, copies: copyCount }
        : { profileId, recordIds: ids, startPosition, copies: copyCount };
    const controller = new AbortController();
    run.current = controller;
    setBusy(true);
    try {
      const pdf = await requestLabelPdf(body, controller.signal);
      show({ url: URL.createObjectURL(pdf.blob), ids, skipped: pdf.skipped, removed: false });
    } catch (e) {
      if (controller.signal.aborted) return;
      show(null);
      if (e instanceof ApiError && e.code === 'VALIDATION_FAILED' && (e.errors ?? []).some((x) => x.path === 'profileId')) {
        setErrors({ profileId: 'catalog.labels.print.profile_gone' });
        void queryClient.invalidateQueries({ queryKey: ['catalog', 'config'] });
      } else {
        setFailure(e);
      }
    } finally {
      if (run.current === controller) run.current = null;
      setBusy(false);
    }
  };

  if (config.data === undefined) {
    return config.isError ? (
      <ProblemAlert error={config.error} />
    ) : (
      <p role="status" className="text-sm text-muted-foreground">
        {t('catalog.labels.loading')}
      </p>
    );
  }

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <h2 id={titleId} className="text-base font-semibold">
        {t('catalog.labels.print.title')}
      </h2>
      {profiles.length === 0 ? (
        <NoticeAlert>{t('catalog.labels.print.no_profiles')}</NoticeAlert>
      ) : (
        <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          {items.length > 0 && records.length > 0 && (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">{t('catalog.labels.print.source')}</legend>
              {(['item', 'record'] as const).map((k) => {
                const id = `${sourceName}-${k}`;
                return (
                  <div key={k} className="flex items-center gap-2">
                    <input
                      id={id}
                      type="radio"
                      name={sourceName}
                      value={k}
                      checked={kind === k}
                      onChange={() => setChosenKind(k)}
                      className="size-4 accent-primary"
                    />
                    <label htmlFor={id} className="text-sm">
                      {k === 'item'
                        ? t('catalog.labels.print.source_items', { count: number.format(items.length) })
                        : t('catalog.labels.print.source_records', { count: number.format(records.length) })}
                    </label>
                  </div>
                );
              })}
              <p className="text-xs text-muted-foreground">{t('catalog.labels.print.source_hint')}</p>
            </fieldset>
          )}
          <div className="grid gap-4 md:grid-cols-3">
            <Field label={t('catalog.labels.print.profile')} hint={t('catalog.labels.print.profile_hint')} error={errors.profileId}>
              {(c) => (
                <select
                  {...c}
                  className={SELECT_CLASS}
                  value={profileId}
                  onChange={(e) => {
                    setPicked(e.target.value);
                    setErrors((old) => ({ ...old, profileId: undefined }));
                  }}
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {`${p.name} (${t(`catalog.labels.kind.${p.kind}`)})`}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('catalog.labels.print.start')} hint={t('catalog.labels.print.start_hint')} error={errors.start}>
              {(c) => <Input {...c} type="number" inputMode="numeric" min={1} max={1000} step={1} value={start} onChange={(e) => setStart(e.target.value)} />}
            </Field>
            <Field label={t('catalog.labels.print.copies')} hint={t('catalog.labels.print.copies_hint')} error={errors.copies}>
              {(c) => <Input {...c} type="number" inputMode="numeric" min={1} max={5} step={1} value={copies} onChange={(e) => setCopies(e.target.value)} />}
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy || chosen.length === 0}>
              <FileTextIcon aria-hidden="true" />
              {busy ? t('catalog.labels.print.working') : t('catalog.labels.print.submit')}
            </Button>
            {chosen.length === 0 && <span className="text-sm text-muted-foreground">{t('catalog.labels.print.empty')}</span>}
          </div>
        </form>
      )}
      {failure !== null && (
        <Notice kind="error">
          {failure instanceof ApiError && failure.code === 'CATALOG_LABEL_LIMIT' ? t('catalog.labels.print.limit') : problemText(t, failure)}
        </Notice>
      )}
      {made !== null && (
        <div className="flex flex-col gap-2">
          <Notice kind="success">{t('catalog.labels.print.ready')}</Notice>
          {made.skipped > 0 && (
            <NoticeAlert>
              {made.skipped >= made.ids.length
                ? t('catalog.labels.print.none')
                : t('catalog.labels.print.skipped', { count: number.format(made.skipped) })}
            </NoticeAlert>
          )}
          <div className="flex flex-wrap gap-2">
            <a href={made.url} target="_blank" rel="noopener noreferrer" className={buttonVariants()}>
              <ExternalLinkIcon aria-hidden="true" />
              {t('catalog.labels.print.open')}
            </a>
            <a href={made.url} download="label.pdf" className={buttonVariants({ variant: 'outline' })}>
              <DownloadIcon aria-hidden="true" />
              {t('catalog.labels.print.download')}
            </a>
            {!made.removed && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  remove(made.ids);
                  setMade({ ...made, removed: true });
                }}
              >
                {t('catalog.labels.print.remove_printed')}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export function LabelsScreen() {
  const t = useT();
  const me = useMe();
  const queue = usePrintQueue();
  const allowed = holds(me, 'catalog.records.read');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('nav.catalog.labels')}</h1>
        <p className="text-sm text-muted-foreground">{t('catalog.labels.description')}</p>
      </div>
      {/* Every route of the screen needs the permission: say so before anything is asked. */}
      {!allowed ? (
        <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />
      ) : (
        <>
          <ScanPanel add={queue.add} />
          <QueuePanel entries={queue.entries} remove={queue.remove} clear={queue.clear} />
          <PrintPanel entries={queue.entries} remove={queue.remove} />
        </>
      )}
    </div>
  );
}
