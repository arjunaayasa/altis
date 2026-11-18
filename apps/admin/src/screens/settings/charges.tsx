import type { CirculationSettingsBody, CirculationSettingsView } from '@altis/shared/api/settings';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { CheckField, Field, SELECT_CLASS } from '@/components/form-field';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { SettingsFooter, SettingsSection, saveSettings, type SaveOutcome } from './library';

/**
 * Two more forms of Pengaturan › Sirkulasi, both in the group `circulation`:
 *
 * - fines, blocks and receipts: whether the library's closed days count as days late, the optional blocks (an unpaid
 *   balance above an amount blocks loans and renewals; an overdue loan blocks loans), the receipt roll's width and its
 *   closing line in each language;
 * - holds: on or off, on the OPAC or not, only when no copy is on the shelf, and the days a copy waits on the hold shelf.
 *
 * Each sends only what changed (library.tsx's frame).
 */

/** Minor units as a decimal for the form (`150000` → `1500`). */
function decimalOf(minor: number | null): string {
  if (minor === null) return '';
  const whole = Math.trunc(minor / 100);
  const cents = minor % 100;
  return cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, '0')}`;
}

/** A typed decimal as minor units (`5.000` and `5000` alike), or null when it is not one. */
function minorOf(text: string): number | null {
  const s = text.trim().replace(/\s/g, '');
  const plain = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(',', '.');
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(plain);
  return m === null ? null : Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export function FinesSettingsForm({ initial, canManage }: { initial: CirculationSettingsView; canManage: boolean }) {
  const t = useT();
  const ids = useId();
  const queryClient = useQueryClient();
  const [view, setView] = useState(initial);
  const [skip, setSkip] = useState(initial.fines.skipClosedDays);
  const [limit, setLimit] = useState(decimalOf(initial.block.unpaidOverMinor));
  const [overdue, setOverdue] = useState(initial.block.overdue);
  const [paper, setPaper] = useState<58 | 80>(initial.receipt.paperMm);
  const [footerId, setFooterId] = useState(initial.receipt.footer.id ?? '');
  const [footerEn, setFooterEn] = useState(initial.receipt.footer.en ?? '');
  const [limitError, setLimitError] = useState<TKey | undefined>(undefined);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dirty =
    skip !== view.fines.skipClosedDays ||
    limit !== decimalOf(view.block.unpaidOverMinor) ||
    overdue !== view.block.overdue ||
    paper !== view.receipt.paperMm ||
    footerId !== (view.receipt.footer.id ?? '') ||
    footerEn !== (view.receipt.footer.en ?? '');
  useDirtyGuard(dirty);

  const reset = (v: CirculationSettingsView): void => {
    setView(v);
    setSkip(v.fines.skipClosedDays);
    setLimit(decimalOf(v.block.unpaidOverMinor));
    setOverdue(v.block.overdue);
    setPaper(v.receipt.paperMm);
    setFooterId(v.receipt.footer.id ?? '');
    setFooterEn(v.receipt.footer.en ?? '');
  };

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setLimitError(undefined);
    setProblem(null);
    setOutcome(null);
    const minor = limit.trim() === '' ? null : minorOf(limit);
    if (limit.trim() !== '' && minor === null) {
      setLimitError('charges.error.amount');
      return;
    }
    const body: CirculationSettingsBody = {};
    if (skip !== view.fines.skipClosedDays) body.fines = { skipClosedDays: skip };
    const block: NonNullable<CirculationSettingsBody['block']> = {};
    if (minor !== view.block.unpaidOverMinor) block.unpaidOverMinor = minor;
    if (overdue !== view.block.overdue) block.overdue = overdue;
    if (Object.keys(block).length > 0) body.block = block;
    const receipt: NonNullable<CirculationSettingsBody['receipt']> = {};
    if (paper !== view.receipt.paperMm) receipt.paperMm = paper;
    const footer: { id?: string | null; en?: string | null } = {};
    if (footerId !== (view.receipt.footer.id ?? '')) footer.id = footerId.trim() === '' ? null : footerId.trim();
    if (footerEn !== (view.receipt.footer.en ?? '')) footer.en = footerEn.trim() === '' ? null : footerEn.trim();
    if (Object.keys(footer).length > 0) receipt.footer = footer;
    if (Object.keys(receipt).length > 0) body.receipt = receipt;
    if (Object.keys(body).length === 0) {
      setOutcome('unchanged');
      return;
    }
    setBusy(true);
    try {
      const saved = await saveSettings(queryClient, 'circulation', body);
      reset(saved.view);
      setOutcome('saved');
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={t('charges.settings.title')} intro={t('charges.settings.intro')}>
      <form noValidate className="grid" onSubmit={(e) => void submit(e)}>
        <fieldset disabled={!canManage} className="contents">
          <CheckField label={t('charges.settings.skip_closed')} checked={skip} onChange={(e) => setSkip(e.target.checked)} />
          <Field label={t('charges.settings.block_unpaid')} hint={t('charges.settings.block_unpaid_hint')} error={limitError}>
            {(c) => <Input {...c} inputMode="decimal" autoComplete="off" value={limit} onChange={(e) => setLimit(e.target.value)} />}
          </Field>
          <CheckField label={t('charges.settings.block_overdue')} checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />
          <Field id={`${ids}-paper`} label={t('charges.settings.paper')}>
            <select id={`${ids}-paper`} className={SELECT_CLASS} value={String(paper)} onChange={(e) => setPaper(e.target.value === '58' ? 58 : 80)}>
              <option value="58">{t('charges.settings.paper_58')}</option>
              <option value="80">{t('charges.settings.paper_80')}</option>
            </select>
          </Field>
          <Field label={t('charges.settings.footer_id')}>{(c) => <Input {...c} maxLength={300} value={footerId} onChange={(e) => setFooterId(e.target.value)} />}</Field>
          <Field label={t('charges.settings.footer_en')}>{(c) => <Input {...c} maxLength={300} value={footerEn} onChange={(e) => setFooterEn(e.target.value)} />}</Field>
        </fieldset>
        <SettingsFooter
          canManage={canManage}
          busy={busy}
          dirty={dirty}
          onDiscard={() => {
            setSkip(view.fines.skipClosedDays);
            setLimit(decimalOf(view.block.unpaidOverMinor));
            setOverdue(view.block.overdue);
            setPaper(view.receipt.paperMm);
            setFooterId(view.receipt.footer.id ?? '');
            setFooterEn(view.receipt.footer.en ?? '');
            setLimitError(undefined);
            setOutcome(null);
            setProblem(null);
          }}
          outcome={outcome}
          problem={problem}
          rootError={undefined}
        />
      </form>
    </SettingsSection>
  );
}

export function HoldsSettingsForm({ initial, canManage }: { initial: CirculationSettingsView; canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [view, setView] = useState(initial);
  const [holds, setHolds] = useState(initial.holds);
  const [days, setDays] = useState(String(initial.holds.pickupDays));
  const [daysError, setDaysError] = useState<TKey | undefined>(undefined);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify({ ...holds, pickupDays: days }) !== JSON.stringify({ ...view.holds, pickupDays: String(view.holds.pickupDays) });
  useDirtyGuard(dirty);
  const flag = (key: 'enabled' | 'opac' | 'onlyWhenNoneAvailable', label: TKey) => (
    <CheckField label={t(label)} checked={holds[key]} onChange={(e) => setHolds((h) => ({ ...h, [key]: e.target.checked }))} />
  );

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setDaysError(undefined);
    setProblem(null);
    setOutcome(null);
    const n = /^\d{1,2}$/.test(days.trim()) ? Number(days.trim()) : null;
    if (n === null || n < 1 || n > 30) {
      setDaysError('form.number_range');
      return;
    }
    const changed: NonNullable<CirculationSettingsBody['holds']> = {};
    if (holds.enabled !== view.holds.enabled) changed.enabled = holds.enabled;
    if (holds.opac !== view.holds.opac) changed.opac = holds.opac;
    if (holds.onlyWhenNoneAvailable !== view.holds.onlyWhenNoneAvailable) changed.onlyWhenNoneAvailable = holds.onlyWhenNoneAvailable;
    if (n !== view.holds.pickupDays) changed.pickupDays = n;
    if (Object.keys(changed).length === 0) {
      setOutcome('unchanged');
      return;
    }
    setBusy(true);
    try {
      const saved = await saveSettings(queryClient, 'circulation', { holds: changed } satisfies CirculationSettingsBody);
      setView(saved.view);
      setHolds(saved.view.holds);
      setDays(String(saved.view.holds.pickupDays));
      setOutcome('saved');
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={t('charges.settings.holds_title')} intro={t('charges.settings.holds_intro')}>
      <form noValidate className="grid" onSubmit={(e) => void submit(e)}>
        <fieldset disabled={!canManage} className="contents">
          {flag('enabled', 'charges.settings.holds_enabled')}
          {flag('opac', 'charges.settings.holds_opac')}
          {flag('onlyWhenNoneAvailable', 'charges.settings.holds_only_none')}
          <Field label={t('charges.settings.holds_pickup_days')} error={daysError}>
            {(c) => <Input {...c} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />}
          </Field>
        </fieldset>
        <SettingsFooter
          canManage={canManage}
          busy={busy}
          dirty={dirty}
          onDiscard={() => {
            setHolds(view.holds);
            setDays(String(view.holds.pickupDays));
            setDaysError(undefined);
            setOutcome(null);
            setProblem(null);
          }}
          outcome={outcome}
          problem={problem}
          rootError={undefined}
        />
      </form>
    </SettingsSection>
  );
}
