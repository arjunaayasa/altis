import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { MemberView } from '@altis/shared/api/members';
import { useState, type FormEvent, type ReactNode } from 'react';
import { CheckField, Field, ProblemAlert } from '@/components/form-field';
import { InlinePanel } from '@/components/layout';
import { useReturnFocus } from '@/components/return-focus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { passwordWeaknessKey } from '@/lib/form-errors';

/**
 * "Atur kata sandi OPAC…" (Komunitas, member area): staff set a member's password for the OPAC member account, or
 * remove it, optionally asking the member for a new one at the next sign-in (`PUT members/:id/password`, which asks for
 * the staff user's own password first: the API client opens the re-authentication dialog on 401 and sends again).
 * Every session of the member ends. The password is never shown again; a refusal of the policy says why.
 *
 * Two ways to show the same form: {@link MemberPasswordPanel}, a panel in the member page (the layout guide's way: no
 * dialog for a form), and {@link MemberPasswordDialog}, a dialog for a page that has no place for the panel yet.
 */

interface PasswordForm {
  password: string;
  setPassword(value: string): void;
  mustReset: boolean;
  setMustReset(value: boolean): void;
  error: TKey | null;
  problem: unknown;
  busy: boolean;
  submit(event: FormEvent<HTMLFormElement>): void;
  clear(): void;
  close(): void;
}

function usePasswordForm(member: MemberView, onClose: () => void, onDone: (text: string) => void): PasswordForm {
  const t = useT();
  const [password, setPassword] = useState('');
  const [mustReset, setMustReset] = useState(true);
  const [error, setError] = useState<TKey | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const close = (): void => {
    if (busy) return;
    setPassword('');
    setError(null);
    setProblem(null);
    onClose();
  };

  const send = async (body: { password: string | null; mustReset: boolean }): Promise<void> => {
    setError(null);
    setProblem(null);
    setBusy(true);
    try {
      await api<StoreResponse>('PUT', `members/${encodeURIComponent(member.id)}/password`, body);
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.code === 'PASSWORD_TOO_WEAK') setError(passwordWeaknessKey(e));
      else setProblem(e);
      return;
    }
    setBusy(false);
    setPassword('');
    onDone(t(body.password === null ? 'members.password.cleared' : 'members.password.saved'));
    onClose();
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (password === '') {
      setError('form.error.required');
      return;
    }
    void send({ password, mustReset });
  };

  return { password, setPassword, mustReset, setMustReset, error, problem, busy, submit, clear: () => void send({ password: null, mustReset: false }), close };
}

/** The new password, "ask for a new one at the next sign-in", and the refusal. */
function PasswordFields({ form }: { form: PasswordForm }): ReactNode {
  const t = useT();
  return (
    <>
      <Field label={t('members.password.field')} hint={t('members.password.hint')} error={form.error ?? undefined} className="max-w-md">
        {(c) => <Input {...c} type="password" autoComplete="new-password" maxLength={256} value={form.password} onChange={(e) => form.setPassword(e.target.value)} />}
      </Field>
      <CheckField label={t('members.password.must_reset')} checked={form.mustReset} onChange={(e) => form.setMustReset(e.target.checked)} />
      <ProblemAlert error={form.problem} />
    </>
  );
}

/** The password form as a panel in the member page, under the head whose menu opened it. */
export function MemberPasswordPanel({ member, onClose, onDone }: { member: MemberView; onClose(): void; onDone(text: string): void }) {
  const t = useT();
  const form = usePasswordForm(member, onClose, onDone);
  return (
    <InlinePanel title={t('members.password.title')} onSubmit={form.submit} onCancel={form.close}>
      <p className="-mt-1.5 max-w-[75ch] text-sm text-muted-foreground">{t('members.password.intro')}</p>
      <PasswordFields form={form} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={form.busy}>
          {t(form.busy ? 'form.saving' : 'members.password.save')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={form.busy} onClick={form.clear}>
          {t('members.password.clear')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={form.busy} onClick={form.close}>
          {t('form.cancel')}
        </Button>
      </div>
    </InlinePanel>
  );
}

/** The password form as a dialog (`open` shows it). */
export function MemberPasswordDialog({ member, open, onClose, onDone }: { member: MemberView; open: boolean; onClose(): void; onDone(text: string): void }) {
  const t = useT();
  const focus = useReturnFocus();
  const form = usePasswordForm(member, onClose, onDone);
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : form.close())}>
      {open && (
        <DialogContent closeLabel={t('form.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('members.password.title')}</DialogTitle>
            <DialogDescription>{t('members.password.intro')}</DialogDescription>
          </DialogHeader>
          <form noValidate className="grid gap-4" onSubmit={form.submit}>
            <PasswordFields form={form} />
            <DialogFooter className="flex-wrap">
              <Button type="button" variant="outline" disabled={form.busy} onClick={form.clear}>
                {t('members.password.clear')}
              </Button>
              <Button type="button" variant="outline" disabled={form.busy} onClick={form.close}>
                {t('form.cancel')}
              </Button>
              <Button type="submit" disabled={form.busy}>
                {t(form.busy ? 'form.saving' : 'members.password.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
