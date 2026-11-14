import { canTransition } from '@altis/shared';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { ItemDetail, ItemView } from '@altis/shared/api/catalog/items';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm, type Path } from 'react-hook-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge, Notice, NoticeAlert, RefetchProblem } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { holdsAt } from '@/lib/access';
import { ApiError, api, type FieldError } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { ItemStatusBadge } from '@/screens/circulation/common';
import { ItemHistory } from './history';
import {
  ItemFields,
  checkPatch,
  customCodeAt,
  fieldErrorsOf,
  formValuesOf,
  invalidateAfterItemWrite,
  itemErrorKey,
  itemKey,
  patchOf,
  useBranchLocations,
  useCatalogConfig,
  useCollectionTypes,
  useItemCustomFields,
  useInactiveBranches,
  useSuppliers,
  withPatch,
  withoutCustomError,
  type ItemFormChoices,
  type ItemFormValues,
} from './item-form';
import { isUlid } from './search';

/**
 * Eksemplar, one item (Phase 2 spec §13, §2.5, §3.4; plan Task 25), `/admin/catalog/items/$itemId`:
 *
 * - `GET catalog/items/:id`: the item and its history (newest first). The header names the barcode, the record (a link
 *   to its editor), the branch, the status and whether the item may be loaned (§2.5).
 * - The form ({@link ItemFields}): the status select offers the current status and `ITEM_TRANSITIONS[current]` only;
 *   the price is a decimal string; without a location the suggested shelf of the view is offered (never saved by
 *   itself). "Simpan" sends `PATCH branches/:branchId/items/:id` with the version the form started from and only what
 *   changed, checked first with the shared `ItemPatchBody`; the answer is `{id, version}` (S15), so the item is read
 *   again and the form follows it. Field errors land on their fields (`catalog.items.error.*` for the items API's own
 *   codes; `custom.<code>` on its custom field); a stale version (CONFLICT_STALE) offers "Muat ulang". The live item
 *   custom fields are part of the form (item-form.tsx).
 * - "Siangi" (archive: `withdrawn` + `archived_at`) asks first, then sends `DELETE …` with `{version}`. An archived
 *   item comes back only through `withdrawn → processing`.
 * - Without `catalog.items.manage` at the item's branch (`holdsAt`), or with the branch marked inactive (L13,
 *   `isWritableBranch`), the page is read-only and says why: the server would refuse.
 */

function BackLink() {
  const t = useT();
  return (
    <Link to="/admin/catalog/items" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeftIcon className="size-4" aria-hidden="true" />
      {t('catalog.items.back')}
    </Link>
  );
}

const enc = encodeURIComponent;

/** The form of `item` (keyed by its id): it follows the server's newer versions while nothing is being typed. */
function ItemEditForm({
  item,
  canManage,
  choices,
  reload,
}: {
  item: ItemView;
  canManage: boolean;
  choices: ItemFormChoices;
  /** Reads the item again and answers it (undefined when the read failed). */
  reload(): Promise<ItemView | undefined>;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  /** The item the form started from: its version goes with the patch, its values are what "changed" compares to. */
  const [base, setBase] = useState<ItemView>(item);
  /** The last read of the server the form took over (a newer read replaces the form's values; this one did already). */
  const adopted = useRef<ItemView>(item);
  const form = useForm<ItemFormValues>({ defaultValues: formValuesOf(item) });
  const { isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const [outcome, setOutcome] = useState<'saved' | 'no_changes' | 'archived' | null>(null);
  const [problem, setProblem] = useState<{ text: string; stale: boolean } | null>(null);
  const [archiving, setArchiving] = useState(false);
  /** The message key of each custom field the server refused (a code may hold a `.`: no form path). */
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});

  /** The form shows `fresh` (nothing unsaved) and patches from it. */
  const resetTo = useCallback(
    (fresh: ItemView): void => {
      adopted.current = fresh;
      form.reset(formValuesOf(fresh));
      setBase(fresh);
    },
    [form],
  );

  // A new read of the server (after a save, an archive, or another user's change) replaces the form's values, unless
  // something is being typed (then the save meets CONFLICT_STALE and "Muat ulang" decides) or the read is older than
  // what the form holds (a read sent before this form's own save).
  useEffect(() => {
    if (item === adopted.current || item.version < base.version || form.formState.isDirty) return;
    resetTo(item);
  }, [item, base.version, form, resetTo]);

  /** Puts field errors on their fields; false when one names no field of the form (the caller shows the problem). */
  const placeErrors = (errors: readonly FieldError[]): boolean => {
    const fields = Object.keys(form.getValues()).filter((f) => f !== 'custom');
    const custom: Record<string, string> = {};
    let focused = false;
    let all = true;
    for (const { path, code } of errors) {
      const customCode = customCodeAt(path, choices.customFields);
      if (customCode !== null) {
        if (!Object.prototype.hasOwnProperty.call(custom, customCode)) custom[customCode] = itemErrorKey(path, code);
        continue;
      }
      if (!fields.includes(path)) {
        all = false;
        continue;
      }
      form.setError(path as Path<ItemFormValues>, { type: code, message: itemErrorKey(path, code) }, { shouldFocus: !focused });
      focused = true;
    }
    setCustomErrors(custom);
    return all;
  };

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    setOutcome(null);
    setCustomErrors({});
    const body = patchOf(values, base, choices.customFields);
    if (Object.keys(body).length === 1) {
      setOutcome('no_changes');
      return;
    }
    const checked = checkPatch(body);
    if (!checked.ok) {
      placeErrors(checked.errors);
      return;
    }
    try {
      const saved = await api<StoreResponse>('PATCH', `branches/${enc(base.branch.id)}/items/${enc(base.id)}`, checked.body);
      // Saved: even if the read below fails, the next save starts from these values and this version.
      setBase(withPatch(base, checked.body, saved.version));
      form.reset(values);
      setOutcome('saved');
      await invalidateAfterItemWrite(queryClient);
    } catch (e) {
      const errors = fieldErrorsOf(e);
      if (errors.length > 0 && placeErrors(errors)) return;
      setProblem({ text: problemText(t, e), stale: e instanceof ApiError && e.code === 'CONFLICT_STALE' });
    }
  });

  const reloadForm = async (): Promise<void> => {
    const fresh = await reload();
    if (fresh === undefined) return;
    resetTo(fresh);
    setProblem(null);
  };

  const canArchive = canManage && !base.archived && canTransition(base.status, 'withdrawn');

  return (
    <>
      {outcome === 'saved' && <Notice kind="success">{t('catalog.items.saved')}</Notice>}
      {outcome === 'archived' && <Notice kind="success">{t('catalog.items.archive_done')}</Notice>}
      {outcome === 'no_changes' && <NoticeAlert>{t('catalog.items.no_changes')}</NoticeAlert>}
      {problem !== null && (
        <Notice
          kind="error"
          action={
            problem.stale ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void reloadForm()}>
                {t('catalog.items.reload')}
              </Button>
            ) : undefined
          }
        >
          {problem.text}
        </Notice>
      )}
      <form noValidate onSubmit={(e) => void submit(e)}>
        <fieldset disabled={!canManage} className="flex min-w-0 flex-col gap-6 rounded-lg border bg-card p-4">
          <ItemFields
            form={form}
            base={base}
            choices={choices}
            suggestion={base.locationId === null ? item.suggestedLocation : null}
            customErrors={customErrors}
            onCustomChange={(code) => setCustomErrors((old) => withoutCustomError(old, code))}
          />
          {canManage && (
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={isSubmitting}>
                {t(isSubmitting ? 'form.saving' : 'form.save')}
              </Button>
              {canArchive && (
                <Button type="button" variant="outline" onClick={() => setArchiving(true)}>
                  {t('catalog.items.archive')}
                </Button>
              )}
            </div>
          )}
        </fieldset>
      </form>
      <ConfirmDialog
        open={archiving}
        title={t('catalog.items.archive_title')}
        description={t('catalog.items.archive_body', { barcode: base.barcode })}
        confirmLabel={t('catalog.items.archive')}
        destructive
        onConfirm={async () => {
          setOutcome(null);
          setProblem(null);
          const archived = await api<StoreResponse>('DELETE', `branches/${enc(base.branch.id)}/items/${enc(base.id)}`, { version: base.version });
          // Withdrawn and archived (§2.5): the form follows at once (what was typed is dropped, the item it was typed
          // for is gone from use), then the item is read again.
          resetTo({ ...base, status: 'withdrawn', archived: true, loanable: false, selfService: false, version: archived.version });
          setOutcome('archived');
          await invalidateAfterItemWrite(queryClient);
        }}
        onClose={() => setArchiving(false)}
      />
    </>
  );
}

/** The header, the form and the history of one item. */
function ItemPage({ item, reload }: { item: ItemDetail; reload(): Promise<ItemView | undefined> }) {
  const t = useT();
  const me = useMe();
  const outside = useInactiveBranches().has(item.branch.id);
  const canManage = holdsAt(me, 'catalog.items.manage', item.branch.id) && !outside;
  const config = useCatalogConfig();
  const types = useCollectionTypes();
  const suppliers = useSuppliers();
  const locations = useBranchLocations(item.branch.id);
  const custom = useItemCustomFields();
  const choices: ItemFormChoices = {
    collectionTypes: types.data?.items ?? [],
    suppliers: suppliers.data?.items ?? [],
    locations: locations.data?.items ?? [],
    currency: config.data?.currency ?? 'IDR',
    customFields: custom.defs,
  };
  // The selects need their options before the form is made (a select keeps the first option otherwise); the custom
  // fields are shown once read (none when they cannot be: the stored values are then kept as they are).
  const ready = types.data !== undefined && suppliers.data !== undefined && locations.data !== undefined && custom.settled;
  const firstProblem = [types, suppliers, locations].find((q) => q.data === undefined && q.isError);

  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="font-mono text-2xl font-semibold break-all">{item.barcode}</h1>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-1">
            <dt className="text-muted-foreground">{t('catalog.items.record')}:</dt>
            <dd>
              <Link to={`/admin/catalog/records/${enc(item.record.id)}`} className="font-medium text-primary underline-offset-4 hover:underline">
                {item.record.title}
              </Link>
            </dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">{t('catalog.items.branch')}:</dt>
            <dd>{t('catalog.items.branch_option', { code: item.branch.code, name: item.branch.name })}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <ItemStatusBadge status={item.status} circulation={item.circulation} />
          {item.circulation.state === null && (
            <Badge tone={item.loanable ? 'info' : 'warning'}>{t(item.loanable ? 'catalog.items.loanable' : 'catalog.items.not_loanable')}</Badge>
          )}
          {item.selfService && <Badge>{t('catalog.items.self_service')}</Badge>}
          {item.archived && <Badge tone="danger">{t('catalog.items.archived')}</Badge>}
        </div>
      </header>
      {item.archived && <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm">{t('catalog.items.archived_notice')}</p>}
      {!canManage && <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm">{t(outside ? 'catalog.items.outside_limit' : 'catalog.items.read_only')}</p>}
      {ready ? (
        <ItemEditForm key={item.id} item={item} canManage={canManage} choices={choices} reload={reload} />
      ) : firstProblem !== undefined ? (
        <Notice kind="error">{problemText(t, firstProblem.error)}</Notice>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {t('shell.loading')}
        </p>
      )}
      {/* After the locations: a move names them (archived ones included); if they cannot be read, the history is still
          shown, a move then naming an unknown location. */}
      {(locations.data !== undefined || locations.isError) && <ItemHistory events={item.history} locations={locations.data?.items ?? []} />}
    </>
  );
}

export function ItemEditScreen() {
  const t = useT();
  const { itemId = '' } = useParams({ strict: false }) as { itemId?: string };
  const valid = isUlid(itemId);
  const item = useApiQuery<ItemDetail>({ queryKey: itemKey(itemId), path: `catalog/items/${enc(itemId)}`, enabled: valid });

  const reload = async (): Promise<ItemView | undefined> => (await item.refetch()).data;

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <BackLink />
      {/* The data wins over an error: a failed background refetch keeps the form and what was typed. */}
      {!valid ? (
        <Notice kind="error">{t('error.NOT_FOUND')}</Notice>
      ) : item.data === undefined ? (
        item.isError ? (
          <Notice kind="error">{problemText(t, item.error)}</Notice>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )
      ) : (
        <>
          <RefetchProblem query={item} />
          <ItemPage item={item.data} reload={reload} />
        </>
      )}
    </div>
  );
}
