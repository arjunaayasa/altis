import { SRU_INDEXES, type DuplicateHint, type IsbnLookupResponse, type SruIndex, type SruSearchResponse } from '@altis/shared/api/catalog/copy';
import type { RecordDraft } from '@altis/shared/api/catalog/record-data';
import type { CatalogConfigView } from '@altis/shared/api/settings';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Badge, CheckField, Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { InlinePanel } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type TKey, type Translate } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery } from '@/lib/me';
import { useScannerInput } from '@/lib/scanner';

/**
 * Copy cataloguing in the record editor (Phase 2 spec §6.2, §6.3, §13; plan Tasks 4 and 32, M13): "Salin dari SRU" and
 * the ISBN lookup. Both hand the chosen draft to the editor, which fills its form from it and saves with `source` set.
 * Nothing is stored here: the routes answer drafts, and the record exists only once the editor saves it.
 *
 * - `SruCopyDialog`: the server (the enabled ones of `GET catalog/config`), the index (ISBN, title, author, any) and the
 *   term → `GET catalog/sru/search` (one page of 20, with "Halaman sebelumnya/berikutnya"). Opened with `initialIsbn`, it
 *   searches that ISBN at once. While it is open a scanner burst that looks like an ISBN searches it (the editor pauses
 *   its own scanner meanwhile).
 * - `IsbnLookupButton`: "Cari ISBN" → `GET catalog/lookup/isbn/:isbn`. A record of the catalogue already holding the
 *   ISBN goes to `onExisting` (the editor shows "Sudah ada di katalog" with a link and "Tambah eksemplar"); otherwise
 *   the candidates of the enabled sources open in an inline panel under the button, with the sources that did not
 *   answer.
 * - Each candidate shows its title, main author, publisher, year and ISBNs, and its duplicate hint (the stored record
 *   it most likely duplicates, with its score; the record opens in a new tab, so the form is kept). "Pilih" →
 *   `onPick({draft, source})`; with "Tambah eksemplar sekarang" ticked, `onPick({draft, source, addItemNow: true})`
 *   (M13: the editor opens the saved record's items tab).
 * - The answers come from other servers: every value is rendered as text, never as markup or a link (only the duplicate
 *   hint, an id of our own, becomes a link).
 * - Both open as inline panels in the page (Esc or "Tutup" closes them), above the editor's form, never inside it; the
 *   search form also stops its submit event from bubbling up the React tree.
 * - The searches are not retried by the client (each one is outbound work for the server, and the ISBN lookup counts
 *   on a per-user limit of 30 a minute); a 429 shows its wait.
 */

/** A candidate the librarian picked: the draft, its source (`sru:<serverId>` or `isbn:arsya`), and "add an item now". */
export interface CopyPick {
  draft: RecordDraft;
  source: string;
  /** "Tambah eksemplar sekarang" was ticked (M13): the editor opens the items tab after the save. */
  addItemNow?: boolean;
}

export interface SruCopyDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Searched at once when the dialog opens (from the editor's ISBN field). */
  initialIsbn?: string;
  onPick(c: CopyPick): void;
}

export interface IsbnLookupButtonProps {
  isbn: string;
  onPick(c: CopyPick): void;
  /** The ISBN is already in the catalog: the editor links to that record ("Tambah eksemplar"). */
  onExisting(recordId: string): void;
}

/** The records of one SRU page (`maximumRecords`, §6.2). */
const SRU_PAGE = 20;

/** The longest search term (`SruSearchQuery.q`). */
const TERM_MAX = 200;

/**
 * A scan that may be an ISBN (or the EAN-13 printed with it): digits, then digits, `X`, hyphens or spaces, 10 to 17
 * characters in all (the editor's own rule).
 */
const ISBN_SCAN = /^\d[\dXx -]{9,16}$/;

/** The catalogue settings the dialogs need (the editor reads the same query). */
function useCatalogConfig() {
  return useApiQuery<CatalogConfigView>({ queryKey: ['catalog', 'config'], path: 'catalog/config', staleTime: 60_000 });
}

/**
 * The name of a candidate's source: the SRU server's name, the ISBN service (`isbn:arsya`, a source value kept for
 * the records and answers that carry it; the community edition has no such service), or the id as it is.
 */
function sourceLabel(t: Translate, source: string, config: CatalogConfigView | undefined): string {
  if (source === 'isbn:arsya') return t('catalog.sru.source.arsya');
  if (source.startsWith('sru:')) {
    const id = source.slice('sru:'.length);
    return config?.sruServers.find((s) => s.id === id)?.name ?? id;
  }
  return source;
}

/** The text of an error code a source failed with (`error.<CODE>`), or the generic one for a code without a text. */
function codeText(t: Translate, code: string): string {
  const key = `error.${code}` as TKey;
  const text = t(key);
  return text === key ? t('error.INTERNAL') : text;
}

/** `{draft, source}`, with `addItemNow: true` when the box is ticked. */
function pickOf(draft: RecordDraft, source: string, addItemNow: boolean): CopyPick {
  return addItemNow ? { draft, source, addItemNow: true } : { draft, source };
}

/** "Tambah eksemplar sekarang": one box for every "Pilih" of the list below it. */
function AddItemNowBox({ checked, onChange }: { checked: boolean; onChange(checked: boolean): void }) {
  const t = useT();
  return <CheckField label={t('catalog.sru.add_item_now')} hint={t('catalog.sru.add_item_now_hint')} checked={checked} onChange={(e) => onChange(e.target.checked)} />;
}

interface Candidate {
  key: string;
  draft: RecordDraft;
  duplicate: DuplicateHint | null;
  /** Shown under the record (the ISBN lookup merges several sources); null when the list has one source. */
  sourceName: string | null;
  onPick(): void;
}

/** One candidate: what identifies the record, its duplicate hint, and "Pilih". */
function CandidateCard({ c }: { c: Candidate }) {
  const t = useT();
  const { draft, duplicate } = c;
  const title = draft.subtitle === undefined ? draft.title : `${draft.title} : ${draft.subtitle}`;
  const author = (draft.agents.find((a) => a.isMain) ?? draft.agents[0])?.name;
  const publisher = draft.publisher === null ? undefined : [draft.publisher.place, draft.publisher.name].filter((x) => x !== undefined && x !== '').join(' : ');
  const facts = [author, draft.edition, publisher, draft.publicationYear].filter((x): x is string => x !== undefined && x !== '');
  const isbns = draft.identifiers.filter((i) => i.type === 'isbn').map((i) => i.value);
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-md border bg-background px-3 py-2.5 text-sm">
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="font-semibold break-words">{title}</p>
        {facts.length > 0 && <p className="break-words text-muted-foreground">{facts.join(' · ')}</p>}
        {isbns.length > 0 && <p className="text-xs break-all text-muted-foreground">{t('catalog.sru.isbns', { list: isbns.join(', ') })}</p>}
        {c.sourceName !== null && <p className="text-xs text-muted-foreground">{t('catalog.sru.from_source', { source: c.sourceName })}</p>}
        {duplicate !== null && (
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={duplicate.score >= 100 ? 'danger' : 'warning'}>{t('catalog.sru.duplicate', { score: duplicate.score })}</Badge>
            <a
              href={`/admin/catalog/records/${encodeURIComponent(duplicate.recordId)}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('catalog.sru.duplicate_open_label', { title: draft.title })}
              className="text-xs font-semibold text-accent-text underline-offset-4 hover:underline"
            >
              {t('catalog.sru.duplicate_open')}
            </a>
          </p>
        )}
      </div>
      <Button type="button" size="sm" aria-label={t('catalog.sru.pick_label', { title: draft.title })} onClick={c.onPick}>
        {t('catalog.sru.pick')}
      </Button>
    </li>
  );
}

function CandidateList({ items, label }: { items: readonly Candidate[]; label: string }) {
  return (
    <ul aria-label={label} className="grid gap-2">
      {items.map((c) => (
        <CandidateCard key={c.key} c={c} />
      ))}
    </ul>
  );
}

// ---- "Salin dari SRU" ------------------------------------------------------------------------------------------------

interface SearchParams {
  server: string;
  index: SruIndex;
  q: string;
  start: number;
}

type SearchState =
  | { kind: 'idle' }
  | { kind: 'busy'; params: SearchParams }
  | { kind: 'done'; params: SearchParams; page: SruSearchResponse }
  | { kind: 'error'; params: SearchParams; error: unknown };

/** The VALIDATION_FAILED paths of a failed search the panel shows on their own. */
function fieldOf(e: unknown): 'server' | 'q' | null {
  if (!(e instanceof ApiError) || e.code !== 'VALIDATION_FAILED') return null;
  const paths = (e.errors ?? []).map((f) => f.path);
  if (paths.includes('server')) return 'server';
  if (paths.includes('q')) return 'q';
  return null;
}

/**
 * The text of a failed search: a server that refused it (a diagnostic, CATALOG_SRU_INVALID with the server's own
 * message as its detail, spec §6.2) says so with that message; anything else is the problem's text.
 */
function searchProblemText(t: Translate, e: unknown): string {
  if (e instanceof ApiError && e.code === 'CATALOG_SRU_INVALID' && e.detail !== undefined && e.detail !== '') return t('catalog.sru.refused', { message: e.detail });
  return problemText(t, e);
}

/** The search form and its results (mounted while the dialog is open, so each opening starts afresh). */
function SruSearchPanel({ initialIsbn, onPick }: { initialIsbn: string; onPick(c: CopyPick): void }) {
  const t = useT();
  const ids = useId();
  const config = useCatalogConfig();
  const servers = config.data?.sruServers.filter((s) => s.enabled) ?? [];
  const [serverChoice, setServerChoice] = useState('');
  const server = servers.some((s) => s.id === serverChoice) ? serverChoice : (servers[0]?.id ?? '');
  const [index, setIndex] = useState<SruIndex>(initialIsbn === '' ? 'title' : 'isbn');
  const [term, setTerm] = useState(initialIsbn);
  const [termError, setTermError] = useState(false);
  const [addItemNow, setAddItemNow] = useState(false);
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' });
  /** The number of the latest search: an older one's answer is dropped. */
  const latest = useRef(0);
  const autoSearched = useRef(false);

  const run = async (params: SearchParams): Promise<void> => {
    const mine = ++latest.current;
    setSearch({ kind: 'busy', params });
    const query = new URLSearchParams({ server: params.server, index: params.index, q: params.q, start: String(params.start) });
    try {
      const page = await api<SruSearchResponse>('GET', `catalog/sru/search?${query.toString()}`);
      if (latest.current === mine) setSearch({ kind: 'done', params, page });
    } catch (error) {
      if (latest.current === mine) setSearch({ kind: 'error', params, error });
    }
  };

  // Opened from the editor's ISBN field: that ISBN is searched at once, on the first enabled server.
  useEffect(() => {
    if (autoSearched.current || initialIsbn === '' || server === '') return;
    autoSearched.current = true;
    void run({ server, index: 'isbn', q: initialIsbn, start: 1 });
  });

  // A scan while the dialog is open searches the ISBN it read.
  useScannerInput({
    minLength: 10,
    onScan: (raw) => {
      const code = raw.trim();
      if (!ISBN_SCAN.test(code) || server === '') return;
      setIndex('isbn');
      setTerm(code);
      setTermError(false);
      void run({ server, index: 'isbn', q: code, start: 1 });
    },
  });

  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    // The dialog sits in a portal, but React events still bubble to the editor's form around it.
    e.stopPropagation();
    const q = term.trim();
    if (q === '') {
      setTermError(true);
      return;
    }
    setTermError(false);
    void run({ server, index, q, start: 1 });
  };

  if (config.data === undefined) {
    if (config.isError) return <Notice kind="error">{problemText(t, config.error)}</Notice>;
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('catalog.sru.loading')}
      </p>
    );
  }
  if (servers.length === 0) return <Notice kind="error">{t('catalog.sru.no_servers')}</Notice>;

  const busy = search.kind === 'busy';
  const failedField = search.kind === 'error' ? fieldOf(search.error) : null;
  const pageOf = (start: number): void => {
    if (search.kind === 'done') void run({ ...search.params, start });
  };

  let results: ReactNode = null;
  if (search.kind === 'error' && failedField === null) {
    results = <Notice kind="error">{searchProblemText(t, search.error)}</Notice>;
  } else if (search.kind === 'error' && failedField === 'server') {
    results = <Notice kind="error">{t('catalog.sru.server_unavailable')}</Notice>;
  } else if (search.kind === 'done') {
    const { page, params } = search;
    const to = Math.min(page.total, page.start + SRU_PAGE - 1);
    const expected = Math.max(0, to - page.start + 1);
    results =
      page.records.length === 0 && expected === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('catalog.sru.empty')}
        </p>
      ) : (
        <section aria-labelledby={`${ids}-results`} className="grid gap-3">
          <h3 id={`${ids}-results`} className="text-base font-semibold">
            {t('catalog.sru.results')}
          </h3>
          <p role="status" className="text-sm text-muted-foreground">
            {t('catalog.sru.total', { total: page.total, from: page.start, to })}
          </p>
          {page.records.length < expected && <p className="text-sm text-muted-foreground">{t('catalog.sru.unreadable')}</p>}
          {page.records.length > 0 && (
            <>
              <AddItemNowBox checked={addItemNow} onChange={setAddItemNow} />
              <CandidateList
                label={t('catalog.sru.results')}
                items={page.records.map((r, i) => ({
                  key: `${page.start}-${i}`,
                  draft: r.draft,
                  duplicate: r.duplicate,
                  sourceName: null,
                  onPick: () => onPick(pickOf(r.draft, `sru:${params.server}`, addItemNow)),
                }))}
              />
            </>
          )}
          {(page.start > 1 || to < page.total) && (
            <nav aria-label={t('catalog.sru.paging')} className="flex flex-wrap justify-between gap-2">
              <Button type="button" variant="outline" size="sm" disabled={page.start <= 1} onClick={() => pageOf(Math.max(1, page.start - SRU_PAGE))}>
                {t('catalog.sru.prev')}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={to >= page.total} onClick={() => pageOf(page.start + SRU_PAGE)}>
                {t('catalog.sru.next')}
              </Button>
            </nav>
          )}
        </section>
      );
  }

  return (
    <div className="grid gap-4">
      <form noValidate aria-label={t('catalog.sru.form')} className="grid gap-3 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end" onSubmit={submit}>
        <Field label={t('catalog.sru.server')}>
          {(control) => (
            <select {...control} className={SELECT_CLASS} value={server} onChange={(e) => setServerChoice(e.target.value)}>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('catalog.sru.index')}>
          {(control) => (
            <select {...control} className={SELECT_CLASS} value={index} onChange={(e) => setIndex(e.target.value as SruIndex)}>
              {SRU_INDEXES.map((i) => (
                <option key={i} value={i}>
                  {t(`catalog.sru.index.${i}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('catalog.sru.term')} error={termError || failedField === 'q' ? 'catalog.sru.term_required' : undefined}>
          {(control) => <Input {...control} type="search" value={term} maxLength={TERM_MAX} autoComplete="off" onChange={(e) => setTerm(e.target.value)} />}
        </Field>
        <Button type="submit" variant="outline" className="bg-background" disabled={busy}>
          {t(busy ? 'catalog.sru.searching' : 'catalog.sru.search')}
        </Button>
      </form>
      <div aria-live="polite" aria-busy={busy || undefined} className="grid gap-3">
        {busy && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('catalog.sru.searching')}
          </p>
        )}
        {results}
      </div>
    </div>
  );
}

/** "Salin dari SRU": search an enabled SRU server and pick a record, in an inline panel while `open`. */
export function SruCopyDialog({ open, onOpenChange, initialIsbn, onPick }: SruCopyDialogProps): ReactNode {
  const t = useT();
  if (!open) return null;
  return (
    <InlinePanel title={t('catalog.sru.dialog.title')} onCancel={() => onOpenChange(false)}>
      <p className="max-w-[75ch] text-sm text-muted-foreground">{t('catalog.sru.dialog.description')}</p>
      <SruSearchPanel initialIsbn={initialIsbn?.trim() ?? ''} onPick={onPick} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" className="bg-background" onClick={() => onOpenChange(false)}>
          {t('catalog.sru.close')}
        </Button>
      </div>
    </InlinePanel>
  );
}

// ---- "Cari ISBN" -----------------------------------------------------------------------------------------------------

/** The candidates of an ISBN lookup and the sources that did not answer. */
function LookupResult({ result, onPick }: { result: IsbnLookupResponse; onPick(c: CopyPick): void }) {
  const t = useT();
  const config = useCatalogConfig();
  const [addItemNow, setAddItemNow] = useState(false);
  // The SRU servers are the only sources: `arsyaEnabled` is a reserved setting the community edition ignores.
  const anySource = config.data === undefined || config.data.sruServers.some((s) => s.enabled);
  return (
    <div className="grid gap-3">
      {result.candidates.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(result.errors.length === 0 && !anySource ? 'catalog.sru.lookup.no_sources' : 'catalog.sru.lookup.none')}
        </p>
      ) : (
        <>
          <AddItemNowBox checked={addItemNow} onChange={setAddItemNow} />
          <CandidateList
            label={t('catalog.sru.lookup.title', { isbn: result.isbn13 })}
            items={result.candidates.map((c, i) => ({
              key: `${c.source}-${i}`,
              draft: c.draft,
              duplicate: c.duplicate,
              sourceName: sourceLabel(t, c.source, config.data),
              onPick: () => onPick(pickOf(c.draft, c.source, addItemNow)),
            }))}
          />
        </>
      )}
      {result.errors.length > 0 && (
        <section className="grid gap-1 text-sm">
          <h3 className="font-medium">{t('catalog.sru.lookup.errors')}</h3>
          <ul className="list-disc pl-5 text-muted-foreground">
            {result.errors.map((e, i) => (
              <li key={`${e.source}-${i}`}>{t('catalog.sru.lookup.source_failed', { source: sourceLabel(t, e.source, config.data), reason: codeText(t, e.code) })}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** "Cari ISBN": look the ISBN up locally, then at the enabled sources (§6.3). */
export function IsbnLookupButton({ isbn, onPick, onExisting }: IsbnLookupButtonProps): ReactNode {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<IsbnLookupResponse | null>(null);
  const value = isbn.trim();

  const lookup = async (): Promise<void> => {
    if (value === '' || busy) return;
    setProblem(null);
    setBusy(true);
    try {
      const r = await api<IsbnLookupResponse>('GET', `catalog/lookup/isbn/${encodeURIComponent(value)}`);
      if (r.local !== null) onExisting(r.local.recordId);
      else setResult(r);
    } catch (e) {
      const invalid = e instanceof ApiError && e.code === 'VALIDATION_FAILED' && (e.errors ?? []).some((f) => f.path === 'isbn');
      setProblem(invalid ? t('catalog.sru.lookup.invalid') : problemText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" className="bg-background" disabled={value === '' || busy} onClick={() => void lookup()}>
        {t(busy ? 'catalog.sru.lookup.busy' : 'catalog.sru.lookup.button')}
      </Button>
      {problem !== null && (
        <p role="alert" className="w-full text-sm font-semibold text-bad">
          {problem}
        </p>
      )}
      {result !== null && (
        <InlinePanel className="w-full bg-background" title={t('catalog.sru.lookup.title', { isbn: result.isbn13 })} onCancel={() => setResult(null)}>
          <p className="max-w-[75ch] text-sm text-muted-foreground">{t('catalog.sru.lookup.description')}</p>
          <LookupResult
            result={result}
            onPick={(c) => {
              setResult(null);
              onPick(c);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setResult(null)}>
              {t('catalog.sru.close')}
            </Button>
          </div>
        </InlinePanel>
      )}
    </>
  );
}
