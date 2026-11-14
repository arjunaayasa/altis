import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { MemberView } from '@altis/shared/api/members';
import { useState, type FormEvent } from 'react';
import { Field, ProblemAlert } from '@/components/form-field';
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
 */
export function MemberPasswordDialog({ member, open, onClose, onDone }: { member: MemberView; open: boolean; onClose(): void; onDone(text: string): void }) {
  const t = useT();
  const focus = useReturnFocus();
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

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      {open && (
        <DialogContent closeLabel={t('form.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('members.password.title')}</DialogTitle>
            <DialogDescription>{t('members.password.intro')}</DialogDescription>
          </DialogHeader>
          <form noValidate className="grid gap-4" onSubmit={submit}>
            <Field label={t('members.password.field')} hint={t('members.password.hint')} error={error ?? undefined}>
              {(c) => <Input {...c} type="password" autoComplete="new-password" maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-primary" checked={mustReset} onChange={(e) => setMustReset(e.target.checked)} />
              {t('members.password.must_reset')}
            </label>
            <ProblemAlert error={problem} />
            <DialogFooter className="flex-wrap">
              <Button type="button" variant="outline" disabled={busy} onClick={() => void send({ password: null, mustReset: false })}>
                {t('members.password.clear')}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={close}>
                {t('form.cancel')}
              </Button>
              <Button type="submit" disabled={busy}>
                {t(busy ? 'form.saving' : 'members.password.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
