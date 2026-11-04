import type { Permission } from '@altis/shared';
import type { PermissionItem } from '@altis/shared/api/roles';
import { CheckIcon, MinusIcon } from 'lucide-react';
import { CheckField } from '@/components/form-field';
import { useT, type TKey } from '@/i18n';
import { grantable } from '@/lib/access';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';

/**
 * The permissions of a role, grouped by module (spec §13.3 "pemilih izin per modul"), in the order of the catalog
 * (`GET permissions`), each labelled with its `perm.<key>` text and each group with `perm.module.<module>`.
 *
 * - Editable: a checkbox per permission. One the signed-in user cannot grant is disabled with the reason as its hint:
 *   not held (rule 1), or only a super admin grants it (rule 5). The server enforces both anyway. `onChange`
 *   receives the selection in catalog order.
 * - `readOnly` (a system role, or a role the user may not edit): a list that marks each permission granted or not,
 *   in words for screen readers (disabled checkboxes would all look alike).
 */
export function PermissionPicker({
  catalog,
  value,
  onChange,
  readOnly = false,
}: {
  catalog: readonly PermissionItem[];
  value: readonly Permission[];
  onChange?(next: Permission[]): void;
  readOnly?: boolean;
}) {
  const t = useT();
  const me = useMe();
  const selected = new Set<Permission>(value);

  const groups = new Map<string, PermissionItem[]>();
  for (const item of catalog) {
    const list = groups.get(item.module) ?? [];
    list.push(item);
    groups.set(item.module, list);
  }

  const toggle = (key: Permission, on: boolean): void => {
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    onChange?.(catalog.map((item) => item.key).filter((k) => next.has(k)));
  };

  return (
    <div className="grid gap-4">
      {[...groups].map(([module, items]) => (
        <fieldset key={module} className="rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">{t(`perm.module.${module}` as TKey)}</legend>
          {readOnly ? (
            <ul className="grid gap-x-6 gap-y-2 pt-1 text-sm sm:grid-cols-2">
              {items.map((item) => {
                const granted = selected.has(item.key);
                return (
                  <li key={item.key} className={cn('flex items-start gap-2', !granted && 'text-muted-foreground')}>
                    {granted ? (
                      <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                    ) : (
                      <MinusIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    )}
                    <span>
                      {t(`perm.${item.key}`)}
                      <span className="sr-only"> {t(granted ? 'roles.perm_granted' : 'roles.perm_not_granted')}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="grid gap-x-6 gap-y-3 pt-1 sm:grid-cols-2">
              {items.map((item) => {
                const verdict = grantable(me, item.key);
                const hint =
                  verdict === 'not_held' ? t('roles.perm_not_held') : verdict === 'super_admin_only' ? t('roles.perm_super_admin_only') : undefined;
                return (
                  <CheckField
                    key={item.key}
                    label={t(`perm.${item.key}`)}
                    {...(hint === undefined ? {} : { hint })}
                    checked={selected.has(item.key)}
                    disabled={verdict !== 'ok'}
                    onChange={(e) => toggle(item.key, e.target.checked)}
                  />
                );
              })}
            </div>
          )}
        </fieldset>
      ))}
    </div>
  );
}
