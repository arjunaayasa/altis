import {
  CLEARANCE_PROFILE_PAPERS,
  type CirculationSettingsBody,
  type CirculationSettingsView,
  type ClearanceProfile,
  type MembersSettingsBody,
  type MembersSettingsView,
} from '@altis/shared/api/settings';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Field, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { ApiError } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { SettingsFooter, SettingsLoader, SettingsPage, SettingsSection, saveSettings, type SaveOutcome } from './library';

/**
 * Pengaturan › Sirkulasi (`/admin/settings/circulation`): two groups on one page.
 *
 * - `circulation` (`PUT settings/circulation`): how many minutes after a loan the desk may still void it (Ctrl+Z), and
 *   how a lost item is charged (the item's price when it has one; a processing fee, in minor units of the library's
 *   currency, typed here as a decimal).
 * - `members`, its clearance letters (`PUT settings/members`): the number prefix (`BP/2026/0001`) and the letter
 *   profile: paper, place, who signs (title, name, staff number) and the statement (empty: the built-in sentence).
 *
 * Each form sends only what changed and reads its group again after saving (library.tsx's frame).
 */

/** Minor units as a decimal for the form (`150000` → `1500`, `150050` → `1500.5`). */
function decimalOf(minor: number): string {
  const whole = Math.trunc(minor / 100);
  const cents = minor % 100;
  return cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, '0').replace(/0$/, '')}`;
}

/** A typed decimal as minor units, or null when it is not one. */
function minorOf(text: string): number | null {
  const m = /^(\d{1,13})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  return m === null ? null : Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

function CirculationForm({ initial, canManage }: { initial: CirculationSettingsView; canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [view, setView] = useState(initial);
  const [minutes, setMinutes] = useState(String(initial.loanVoidMinutes));
  const [useItemPrice, setUseItemPrice] = useState(initial.lost.useItemPrice);
  const [fee, setFee] = useState(decimalOf(initial.lost.processingFeeMinor));
  const [errors, setErrors] = useState<{ minutes?: TKey; fee?: TKey }>({});
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dirty = minutes !== String(view.loanVoidMinutes) || useItemPrice !== view.lost.useItemPrice || fee !== decimalOf(view.lost.processingFeeMinor);
  useDirtyGuard(dirty);

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setErrors({});
    setProblem(null);
    setOutcome(null);
    const m = /^\d{1,2}$/.test(minutes.trim()) ? Number(minutes.trim()) : null;
    const f = minorOf(fee === '' ? '0' : fee);
    const next: { minutes?: TKey; fee?: TKey } = {};
    if (m === null || m > 60) next.minutes = 'form.number_range';
    if (f === null) next.fee = 'circulation.settings.error.amount';
    if (next.minutes !== undefined || next.fee !== undefined) {
      setErrors(next);
      return;
    }
    const body: CirculationSettingsBody = {};
    if (m !== view.loanVoidMinutes) body.loanVoidMinutes = m!;
    const lost: NonNullable<CirculationSettingsBody['lost']> = {};
    if (useItemPrice !== view.lost.useItemPrice) lost.useItemPrice = useItemPrice;
    if (f !== view.lost.processingFeeMinor) lost.processingFeeMinor = f!;
    if (Object.keys(lost).length > 0) body.lost = lost;
    if (Object.keys(body).length === 0) {
      setOutcome('unchanged');
      return;
    }
    setBusy(true);
    try {
      const saved = await saveSettings(queryClient, 'circulation', body);
      setView(saved.view);
      setMinutes(String(saved.view.loanVoidMinutes));
      setUseItemPrice(saved.view.lost.useItemPrice);
      setFee(decimalOf(saved.view.lost.processingFeeMinor));
      setOutcome('saved');
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={t('circulation.settings.desk_title')} description={t('circulation.settings.desk_intro')}>
      <form noValidate className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => void submit(e)}>
        <Field label={t('circulation.settings.void_minutes')} hint={t('circulation.settings.void_minutes_hint')} error={errors.minutes}>
          {(c) => <Input {...c} inputMode="numeric" value={minutes} disabled={!canManage} onChange={(e) => setMinutes(e.target.value)} />}
        </Field>
        <Field label={t('circulation.settings.processing_fee')} hint={t('circulation.settings.processing_fee_hint')} error={errors.fee}>
          {(c) => <Input {...c} inputMode="decimal" value={fee} disabled={!canManage} onChange={(e) => setFee(e.target.value)} />}
        </Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" className="size-4 accent-primary" checked={useItemPrice} disabled={!canManage} onChange={(e) => setUseItemPrice(e.target.checked)} />
          {t('circulation.settings.use_item_price')}
        </label>
        <div className="grid gap-4 sm:col-span-2">
          <SettingsFooter canManage={canManage} busy={busy} outcome={outcome} problem={problem} rootError={undefined} />
        </div>
      </form>
    </SettingsSection>
  );
}

function ClearanceForm({ initial, canManage }: { initial: MembersSettingsView; canManage: boolean }) {
  const t = useT();
  const ids = useId();
  const queryClient = useQueryClient();
  const [view, setView] = useState(initial);
  const [prefix, setPrefix] = useState(initial.clearance.prefix);
  const [profile, setProfile] = useState<ClearanceProfile>(initial.clearance.profile);
  const [prefixError, setPrefixError] = useState<TKey | undefined>(undefined);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dirty = prefix !== view.clearance.prefix || JSON.stringify(profile) !== JSON.stringify(view.clearance.profile);
  useDirtyGuard(dirty);
  const set = (key: keyof ClearanceProfile) => (e: { target: { value: string } }) => setProfile((p) => ({ ...p, [key]: e.target.value }));

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setPrefixError(undefined);
    setProblem(null);
    setOutcome(null);
    if (!/^[\x21-\x2E\x30-\x7E]{1,16}$/.test(prefix.trim())) {
      setPrefixError('circulation.settings.error.prefix');
      return;
    }
    const clearance: NonNullable<MembersSettingsBody['clearance']> = {};
    if (prefix.trim() !== view.clearance.prefix) clearance.prefix = prefix.trim();
    if (JSON.stringify(profile) !== JSON.stringify(view.clearance.profile)) clearance.profile = profile;
    if (Object.keys(clearance).length === 0) {
      setOutcome('unchanged');
      return;
    }
    setBusy(true);
    try {
      const saved = await saveSettings(queryClient, 'members', { clearance } satisfies MembersSettingsBody);
      setView(saved.view);
      setPrefix(saved.view.clearance.prefix);
      setProfile(saved.view.clearance.profile);
      setOutcome('saved');
    } catch (error) {
      if (error instanceof ApiError && error.errors?.some((f) => f.path.startsWith('clearance.prefix'))) setPrefixError('circulation.settings.error.prefix');
      else setProblem(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={t('circulation.settings.clearance_title')} description={t('circulation.settings.clearance_intro')}>
      <form noValidate className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => void submit(e)}>
        <fieldset disabled={!canManage} className="contents">
          <Field label={t('circulation.settings.prefix')} hint={t('circulation.settings.prefix_hint')} error={prefixError}>
            {(c) => <Input {...c} maxLength={16} autoComplete="off" value={prefix} onChange={(e) => setPrefix(e.target.value)} />}
          </Field>
          <Field id={`${ids}-paper`} label={t('circulation.settings.paper')}>
            <select id={`${ids}-paper`} className={SELECT_CLASS} value={profile.paper} onChange={set('paper')}>
              {CLEARANCE_PROFILE_PAPERS.map((p) => (
                <option key={p} value={p}>
                  {t(`members.clearance.paper_${p}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('circulation.settings.city')}>{(c) => <Input {...c} maxLength={60} value={profile.city} onChange={set('city')} />}</Field>
          <Field label={t('circulation.settings.signer_title')}>{(c) => <Input {...c} maxLength={60} value={profile.signerTitle} onChange={set('signerTitle')} />}</Field>
          <Field label={t('circulation.settings.signer_name')}>{(c) => <Input {...c} maxLength={80} value={profile.signerName} onChange={set('signerName')} />}</Field>
          <Field label={t('circulation.settings.signer_id')} hint={t('circulation.settings.signer_id_hint')}>
            {(c) => <Input {...c} maxLength={60} value={profile.signerId} onChange={set('signerId')} />}
          </Field>
          <Field id={`${ids}-body`} label={t('circulation.settings.body_text')} hint={t('circulation.settings.body_text_hint')} className="sm:col-span-2">
            <textarea id={`${ids}-body`} className={TEXTAREA_CLASS} rows={3} maxLength={1000} value={profile.bodyText} onChange={set('bodyText')} />
          </Field>
        </fieldset>
        <div className="grid gap-4 sm:col-span-2">
          <SettingsFooter canManage={canManage} busy={busy} outcome={outcome} problem={problem} rootError={undefined} />
        </div>
      </form>
    </SettingsSection>
  );
}

export function CirculationSettingsScreen() {
  return (
    <SettingsPage>
      <SettingsLoader group="circulation">{(view, canManage) => <CirculationForm initial={view} canManage={canManage} />}</SettingsLoader>
      <SettingsLoader group="members">{(view, canManage) => <ClearanceForm initial={view} canManage={canManage} />}</SettingsLoader>
    </SettingsPage>
  );
}
