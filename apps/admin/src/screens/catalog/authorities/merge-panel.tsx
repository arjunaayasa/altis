import type { AgentView, AuthorityKind, MergeIntoBody } from '@altis/shared/api/catalog/authorities';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { ChevronsUpDownIcon } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { Field } from '@/components/form-field';
import { Callout, InlinePanel } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { cn } from '@/lib/utils';
import { authorityLabel, authorityName, authorityPath, typeLabel, useAuthorityCandidates, type AuthorityView } from './common';

/**
 * "Gabungkan ke otoritas lain…" of an authority's page (Phase 2 Task 26; spec §3.5 "Gabung", §13;
 * `POST catalog/{agents|subjects|publishers}/:id/merge`). Two steps in one panel, opened in the page under the button:
 *
 * 1. **The target.** A search among the live authorities of the same kind (an agent's among the agents of its own type,
 *    since agents of different types cannot merge); the authority itself is never offered. "Lanjut" needs a choice.
 * 2. **The confirmation.** Which authority goes into which, what moves, and that the merge cannot be undone. Only
 *    "Gabungkan" posts `{intoId, version}` (the version is the source's: the page's own writes chain through
 *    `version()`). A refusal (CATALOG_MERGE_INVALID: the target was archived or merged meanwhile; CONFLICT_STALE) stays in
 *    the panel with its reason; "Kembali" goes back to the choice.
 *
 * The answer is `{id, version}` only (S15): `onMerged` hands it to the page, which reads the source again (now merged,
 * read-only, with a link to its target). Every step starts afresh when the panel opens again. Esc closes the open search
 * list first, then the panel (not while the merge is being sent).
 */

export interface MergePanelProps {
  kind: AuthorityKind;
  /** The authority merged away. */
  source: AuthorityView;
  /** Batal or Esc. */
  onClose(): void;
  /** The source's version to send: past the page's own writes. */
  version(): number;
  /** The merge went through: the version sent, the server's answer, and the target. */
  onMerged(sent: number, saved: StoreResponse, target: AuthorityView): void;
}

export function MergePanel({ kind, source, onClose, version, onMerged }: MergePanelProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const name = authorityName(source);
  return (
    <InlinePanel title={t('catalog.authorities.merge.title', { name })} onCancel={() => (busy ? undefined : onClose())} className="max-w-3xl">
      <p className="text-sm text-muted-foreground">{t('catalog.authorities.merge.description', { name })}</p>
      <MergeSteps kind={kind} source={source} version={version} onMerged={onMerged} onBusy={setBusy} onCancel={onClose} />
    </InlinePanel>
  );
}

/** One authority on offer. */
interface Option {
  value: string;
  label: string;
}

/**
 * The target field: a button (`role="combobox"`) showing the choice, which opens the search list below it (cmdk:
 * arrows, Enter, Escape). Searching is the server's (`onSearchChange`), so cmdk does not filter.
 */
function TargetPicker({
  id,
  options,
  value,
  onValueChange,
  search,
  onSearchChange,
  loading,
  emptyText,
}: {
  id: string;
  options: readonly Option[];
  value: string | null;
  onValueChange(value: string): void;
  search: string;
  onSearchChange(search: string): void;
  loading: boolean;
  emptyText: string;
}) {
  const t = useT();
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };
  const chosen = value === null ? undefined : options.find((o) => o.value === value);
  return (
    <div className="flex flex-col gap-2">
      <Button
        ref={trigger}
        type="button"
        id={id}
        variant="outline"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        className="w-full justify-between bg-background font-normal"
        onClick={() => setOpen(!open)}>
        <span className={cn('truncate', chosen === undefined && 'text-muted-foreground')}>{chosen?.label ?? t('catalog.authorities.merge.target_placeholder')}</span>
        <ChevronsUpDownIcon className="opacity-50" aria-hidden="true" />
      </Button>
      {open && (
        <Command
          shouldFilter={false}
          label={t('catalog.authorities.merge.search_label')}
          className="border bg-background"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            // The list closes first: the panel's own Esc must not see this one.
            e.preventDefault();
            e.stopPropagation();
            close();
          }}>
          <CommandInput autoFocus placeholder={t('catalog.authorities.merge.search_placeholder')} value={search} onValueChange={onSearchChange} />
          <CommandList id={listId} className="max-h-60">
            {loading ? (
              <p role="status" className="py-6 text-center text-sm text-muted-foreground">
                {t('catalog.authorities.pick.searching')}
              </p>
            ) : options.length === 0 ? (
              <p className="py-6 text-center text-sm">{emptyText}</p>
            ) : (
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem
                    key={o.value}
                    value={o.value}
                    onSelect={() => {
                      onValueChange(o.value);
                      close();
                    }}>
                    <span className={cn('truncate', o.value === value && 'font-semibold')}>{o.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      )}
    </div>
  );
}

/** The two steps; mounted only while the panel is open. */
function MergeSteps({
  kind,
  source,
  version,
  onMerged,
  onBusy,
  onCancel,
}: Pick<MergePanelProps, 'kind' | 'source' | 'version' | 'onMerged'> & { onBusy(busy: boolean): void; onCancel(): void }) {
  const t = useT();
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<AuthorityView | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** An agent merges only into an agent of its own type. */
  const type = kind === 'agents' ? (source as AgentView).type : undefined;
  const candidates = useAuthorityCandidates(kind, search, { ...(type === undefined ? {} : { type }), enabled: !confirming });

  /** The targets on offer: live, not the source; the one chosen stays listed so the field keeps showing it. */
  const offered = useMemo(() => {
    const live = candidates.items.filter((v) => v.id !== source.id && v.mergedInto === null && !v.archived);
    return target === null || live.some((v) => v.id === target.id) ? live : [target, ...live];
  }, [candidates.items, source.id, target]);
  const options: Option[] = useMemo(() => offered.map((v) => ({ value: v.id, label: authorityLabel(t, kind, v) })), [offered, t, kind]);

  const working = (on: boolean): void => {
    setBusy(on);
    onBusy(on);
  };

  const merge = async (): Promise<void> => {
    if (target === null) return;
    working(true);
    setError(null);
    const sent = version();
    try {
      const body: MergeIntoBody = { intoId: target.id, version: sent };
      const saved = await api<StoreResponse>('POST', `${authorityPath(kind, source.id)}/merge`, body);
      working(false);
      onMerged(sent, saved, target);
    } catch (e) {
      working(false);
      setError(problemText(t, e));
    }
  };

  if (confirming && target !== null) {
    return (
      <>
        <div className="grid max-w-[75ch] gap-2 text-sm">
          <p className="font-semibold">{t('catalog.authorities.merge.question', { source: authorityLabel(t, kind, source), target: authorityLabel(t, kind, target) })}</p>
          <p>{t(`catalog.authorities.merge.effect.${kind}`, { source: authorityName(source), target: authorityName(target) })}</p>
        </div>
        <Callout tone="warn" title={t('catalog.authorities.merge.irreversible')} />
        {error !== null && (
          <p role="alert" className="text-sm font-semibold text-bad">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void merge()}>
            {t(busy ? 'catalog.authorities.merge.merging' : 'catalog.authorities.merge.confirm')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError(null);
              setConfirming(false);
            }}>
            {t('catalog.authorities.merge.back')}
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      {type !== undefined && <p className="text-sm text-muted-foreground">{t('catalog.authorities.merge.same_type', { type: typeLabel(t, type) ?? type })}</p>}
      <Field label={t('catalog.authorities.merge.target')} className="max-w-xl">
        {(c) => (
          <TargetPicker
            id={c.id}
            options={options}
            value={target?.id ?? null}
            onValueChange={(id) => setTarget(offered.find((v) => v.id === id) ?? null)}
            search={search}
            onSearchChange={setSearch}
            loading={candidates.loading}
            emptyText={
              candidates.idle
                ? t('catalog.authorities.pick.hint')
                : candidates.error !== null
                  ? problemText(t, candidates.error)
                  : t('catalog.authorities.merge.search_empty')
            }
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={target === null} onClick={() => setConfirming(true)}>
          {t('catalog.authorities.merge.next')}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          {t('form.cancel')}
        </Button>
      </div>
    </>
  );
}
