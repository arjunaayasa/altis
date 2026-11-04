import { SruTestBody, type SruTestResponse } from '@altis/shared/api/catalog/copy';
import { SRU_VERSIONS, SruServerList, type CatalogSettings } from '@altis/shared/api/settings';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useFieldArray, useWatch, type UseFormReturn } from 'react-hook-form';
import { CheckField, Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { api } from '@/lib/api';
import { isMessageKey, problemText } from '@/lib/form-errors';
import { ListError } from './barcode-patterns';
import { errorAt, freeCode, listMax, ownError, type CatalogFormValues, type ServerValues } from './form';

/**
 * The SRU server editor of Pengaturan › Katalog (Phase 2 spec §6.2, §12.6; plan Task 28): each server's code, name,
 * base URL, version, record schema and its four CQL indexes, whether it is enabled, and "Uji", which sends the URL and
 * version as typed (saved or not) to `POST catalog/sru/test`. That route always answers 200 `{ok, code?, message?,
 * version?}` (decision P2-17), so a failure shows the server's own message (text, never markup); a problem (a URL the
 * guard refuses, the per-user rate limit) shows its own message. At most 10 servers (the shared schema's limit); a
 * saved server's code is read-only, since records name their source `sru:<code>`.
 */

/** The most SRU servers the settings hold. */
export const SERVERS_MAX = listMax(SruServerList);

const INDEX_NAMES = ['isbn', 'title', 'author', 'any'] as const;

/** A new server: disabled, no URL yet, the default CQL indexes (§6.2). */
function newServer(id: string): ServerValues {
  return {
    id,
    name: '',
    url: '',
    version: '1.2',
    recordSchema: 'marcxml',
    indexes: { isbn: 'bath.isbn', title: 'dc.title', author: 'dc.creator', any: 'cql.serverChoice' },
    enabled: false,
    locked: false,
  };
}

/** What the last test said, for the URL and version it tested: shown only while the row still holds those. */
type TestOutcome = { kind: 'success' | 'error'; text: string; url: string; version: string } | null;

function ServerFieldset({
  form,
  index,
  readOnly,
  onRemove,
}: {
  form: UseFormReturn<CatalogFormValues, unknown, CatalogSettings>;
  index: number;
  readOnly: boolean;
  onRemove(): void;
}) {
  const t = useT();
  const { register, control, getValues } = form;
  const errors = form.formState.errors;
  const server = useWatch({ control, name: `sru.servers.${index}` });
  const s = `sru.servers.${index}` as const;
  const typed = server?.name.trim() ?? '';
  const name = typed === '' ? t('catalog.settings.sru.new') : typed;
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome>(null);
  const textError = (path: string) => ownError(errorAt(errors, path));

  const shown = outcome !== null && outcome.url === server?.url && outcome.version === server.version ? outcome : null;

  const test = async (): Promise<void> => {
    setOutcome(null);
    const tested = { url: getValues(`${s}.url`), version: getValues(`${s}.version`) };
    const say = (kind: 'success' | 'error', text: string): void => setOutcome({ kind, text, ...tested });
    const body = SruTestBody.safeParse(tested);
    if (!body.success) {
      say('error', t('catalog.settings.sru.test_url_first'));
      return;
    }
    setTesting(true);
    try {
      const answer = await api<SruTestResponse>('POST', 'catalog/sru/test', body.data);
      if (answer.ok) {
        const version = answer.version;
        say('success', version === undefined || version === '' ? t('catalog.settings.sru.test_ok_plain') : t('catalog.settings.sru.test_ok', { version }));
      } else {
        const code = answer.code === undefined ? undefined : `error.${answer.code}`;
        const message =
          answer.message !== undefined && answer.message.trim() !== ''
            ? answer.message
            : code !== undefined && isMessageKey(code)
              ? t(code as TKey)
              : t('error.INTERNAL');
        say('error', t('catalog.settings.sru.test_failed', { message }));
      }
    } catch (e) {
      say('error', problemText(t, e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <fieldset className="grid min-w-0 gap-4 rounded-md border p-4">
      <legend className="px-1 text-sm font-semibold">{name}</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('catalog.settings.sru.id')} hint={server?.locked ? t('catalog.settings.code_locked') : undefined} error={textError(`${s}.id`)}>
          {(c) => (
            <Input {...c} className="font-mono" maxLength={32} autoComplete="off" spellCheck={false} readOnly={server?.locked === true} {...register(`${s}.id`)} disabled={readOnly} />
          )}
        </Field>
        <Field label={t('catalog.settings.sru.name')} error={textError(`${s}.name`)}>
          {(c) => <Input {...c} maxLength={64} {...register(`${s}.name`)} disabled={readOnly} />}
        </Field>
        <Field label={t('catalog.settings.sru.url')} hint={t('catalog.settings.sru.url_hint')} error={textError(`${s}.url`)} className="sm:col-span-2">
          {(c) => (
            <Input {...c} type="url" inputMode="url" maxLength={500} autoComplete="off" spellCheck={false} className="font-mono" {...register(`${s}.url`)} disabled={readOnly} />
          )}
        </Field>
        <Field label={t('catalog.settings.sru.version')} error={textError(`${s}.version`)}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} {...register(`${s}.version`)} disabled={readOnly}>
              {SRU_VERSIONS.map((version) => (
                <option key={version} value={version}>
                  {`SRU ${version}`}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('catalog.settings.sru.record_schema')} error={textError(`${s}.recordSchema`)}>
          {(c) => <Input {...c} className="font-mono" maxLength={64} autoComplete="off" spellCheck={false} {...register(`${s}.recordSchema`)} disabled={readOnly} />}
        </Field>
        {INDEX_NAMES.map((index_) => (
          <Field key={index_} label={t(`catalog.settings.sru.index.${index_}`)} error={textError(`${s}.indexes.${index_}`)}>
            {(c) => (
              <Input {...c} className="font-mono" maxLength={64} autoComplete="off" spellCheck={false} {...register(`${s}.indexes.${index_}`)} disabled={readOnly} />
            )}
          </Field>
        ))}
        <CheckField className="sm:col-span-2" label={t('catalog.settings.sru.enabled')} {...register(`${s}.enabled`)} disabled={readOnly} />
      </div>
      {!readOnly && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={t('catalog.settings.sru.test_label', { name })}
              disabled={testing}
              onClick={() => void test()}
            >
              {t(testing ? 'catalog.settings.sru.testing' : 'catalog.settings.sru.test')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onRemove}>
              <Trash2Icon aria-hidden="true" />
              {t('catalog.settings.sru.remove', { name })}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('catalog.settings.sru.test_hint')}</p>
          {shown !== null && <Notice kind={shown.kind}>{shown.text}</Notice>}
        </div>
      )}
    </fieldset>
  );
}

export function SruServersEditor({ form, readOnly }: { form: UseFormReturn<CatalogFormValues, unknown, CatalogSettings>; readOnly: boolean }) {
  const t = useT();
  const array = useFieldArray({ control: form.control, name: 'sru.servers' });
  const [limited, setLimited] = useState(false);

  const add = (): void => {
    if (array.fields.length >= SERVERS_MAX) {
      setLimited(true);
      return;
    }
    setLimited(false);
    const taken = form.getValues('sru.servers').map((s) => s.id);
    array.append(newServer(freeCode('server', array.fields.length + 1, taken)));
  };

  return (
    <div className="grid gap-4">
      {array.fields.map((field, i) => (
        <ServerFieldset
          key={field.id}
          form={form}
          index={i}
          readOnly={readOnly}
          onRemove={() => {
            setLimited(false);
            array.remove(i);
          }}
        />
      ))}
      {!readOnly && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={add}>
            <PlusIcon aria-hidden="true" />
            {t('catalog.settings.sru.add')}
          </Button>
        </div>
      )}
      <ListError
        limited={limited}
        error={errorAt(form.formState.errors, 'sru.servers')}
        tooMany="catalog.settings.sru.too_many"
        max={SERVERS_MAX}
      />
    </div>
  );
}
