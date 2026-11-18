import type { PrivacySettingsView, VisitsSettingsView } from '@altis/shared/api/settings';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { CheckField, Field, Notice, ProblemAlert, TEXTAREA_CLASS } from '@/components/form-field';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { SettingsFooter, SettingsLoader, SettingsPage, SettingsSection, saveSettings } from './library';

/**
 * Pengaturan → Kunjungan (`PUT settings/visits`): the repeat window, whether the desk and the OPAC sign-in count as
 * visits, and the guestbook station's options. Pengaturan → Privasi (`PUT settings/privacy`, which asks for the
 * password first): how many years history keeps the link to a person.
 */

function VisitsForm({ view, canManage }: { view: VisitsSettingsView; canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [dedupe, setDedupe] = useState(String(view.dedupeMinutes));
  const [fromDesk, setFromDesk] = useState(view.fromDesk);
  const [fromOnline, setFromOnline] = useState(view.fromOnline);
  const [askPurpose, setAskPurpose] = useState(view.askPurpose);
  const [showPhoto, setShowPhoto] = useState(view.station.showPhoto);
  const [welcomeId, setWelcomeId] = useState(view.station.welcome.id ?? '');
  const [welcomeEn, setWelcomeEn] = useState(view.station.welcome.en ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const dirty =
    dedupe !== String(view.dedupeMinutes) ||
    fromDesk !== view.fromDesk ||
    fromOnline !== view.fromOnline ||
    askPurpose !== view.askPurpose ||
    showPhoto !== view.station.showPhoto ||
    welcomeId !== (view.station.welcome.id ?? '') ||
    welcomeEn !== (view.station.welcome.en ?? '');
  useDirtyGuard(dirty);
  const discard = (): void => {
    setDedupe(String(view.dedupeMinutes));
    setFromDesk(view.fromDesk);
    setFromOnline(view.fromOnline);
    setAskPurpose(view.askPurpose);
    setShowPhoto(view.station.showPhoto);
    setWelcomeId(view.station.welcome.id ?? '');
    setWelcomeEn(view.station.welcome.en ?? '');
    setInvalid(false);
    setProblem(null);
    setSaved(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setProblem(null);
    setSaved(false);
    const minutes = Number(dedupe.trim());
    if (!/^\d{1,3}$/.test(dedupe.trim()) || minutes > 720) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setBusy(true);
    try {
      await saveSettings(queryClient, 'visits', {
        dedupeMinutes: minutes,
        fromDesk,
        fromOnline,
        askPurpose,
        station: { showPhoto, welcome: { id: welcomeId.trim() === '' ? null : welcomeId, en: welcomeEn.trim() === '' ? null : welcomeEn } },
      });
      setSaved(true);
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="grid gap-4">
      <SettingsSection title={t('visits.settings.title')}>
        <Field label={t('visits.settings.dedupe')} hint={t('visits.settings.dedupe_hint')} error={invalid ? 'visits.settings.invalid' : undefined}>
          {(c) => <Input {...c} inputMode="numeric" disabled={!canManage} value={dedupe} onChange={(e) => setDedupe(e.target.value)} />}
        </Field>
        <CheckField label={t('visits.settings.from_desk')} disabled={!canManage} checked={fromDesk} onChange={(e) => setFromDesk(e.target.checked)} />
        <CheckField label={t('visits.settings.from_online')} disabled={!canManage} checked={fromOnline} onChange={(e) => setFromOnline(e.target.checked)} />
        <CheckField label={t('visits.settings.ask_purpose')} disabled={!canManage} checked={askPurpose} onChange={(e) => setAskPurpose(e.target.checked)} />
        <CheckField label={t('visits.settings.show_photo')} disabled={!canManage} checked={showPhoto} onChange={(e) => setShowPhoto(e.target.checked)} />
        <Field wide label={t('visits.settings.welcome_id')}>
          {(c) => <textarea {...c} className={TEXTAREA_CLASS} maxLength={300} disabled={!canManage} value={welcomeId} onChange={(e) => setWelcomeId(e.target.value)} />}
        </Field>
        <Field wide label={t('visits.settings.welcome_en')}>
          {(c) => <textarea {...c} className={TEXTAREA_CLASS} maxLength={300} disabled={!canManage} value={welcomeEn} onChange={(e) => setWelcomeEn(e.target.value)} />}
        </Field>
      </SettingsSection>
      <ProblemAlert error={problem} />
      {saved && <Notice kind="success">{t('visits.settings.saved')}</Notice>}
      <SettingsFooter canManage={canManage} busy={busy} dirty={dirty} onDiscard={discard} outcome={null} problem={null} rootError={undefined} />
    </form>
  );
}

/** A number of years 1-20, blank as null; undefined when it is neither. */
function yearsOf(text: string): number | null | undefined {
  const s = text.trim();
  if (s === '') return null;
  if (!/^\d{1,2}$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= 20 ? n : undefined;
}

function PrivacyForm({ view, canManage }: { view: PrivacySettingsView; canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const text = (n: number | null): string => (n === null ? '' : String(n));
  const [loans, setLoans] = useState(text(view.loans.anonymizeAfterYears));
  const [visits, setVisits] = useState(text(view.visits.anonymizeAfterYears));
  const [members, setMembers] = useState(text(view.members.anonymizeArchivedAfterYears));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [invalid, setInvalid] = useState<string[]>([]);
  const dirty = loans !== text(view.loans.anonymizeAfterYears) || visits !== text(view.visits.anonymizeAfterYears) || members !== text(view.members.anonymizeArchivedAfterYears);
  useDirtyGuard(dirty);
  const discard = (): void => {
    setLoans(text(view.loans.anonymizeAfterYears));
    setVisits(text(view.visits.anonymizeAfterYears));
    setMembers(text(view.members.anonymizeArchivedAfterYears));
    setInvalid([]);
    setProblem(null);
    setSaved(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setProblem(null);
    setSaved(false);
    const values = { loans: yearsOf(loans), visits: yearsOf(visits), members: yearsOf(members) };
    const bad = Object.entries(values)
      .filter(([, v]) => v === undefined)
      .map(([k]) => k);
    setInvalid(bad);
    if (bad.length > 0) return;
    setBusy(true);
    try {
      await saveSettings(queryClient, 'privacy', {
        loans: { anonymizeAfterYears: values.loans },
        visits: { anonymizeAfterYears: values.visits },
        members: { anonymizeArchivedAfterYears: values.members },
      });
      setSaved(true);
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  const field = (key: 'loans' | 'visits' | 'members', label: string, value: string, set: (v: string) => void) => (
    <Field label={label} hint={t('visits.settings.years_hint')} error={invalid.includes(key) ? 'visits.settings.invalid' : undefined}>
      {(c) => <Input {...c} inputMode="numeric" disabled={!canManage} value={value} onChange={(e) => set(e.target.value)} />}
    </Field>
  );

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="grid gap-4">
      <SettingsSection title={t('visits.settings.privacy_title')} intro={t('visits.settings.privacy_intro')}>
        {field('loans', t('visits.settings.loans_years'), loans, setLoans)}
        {field('visits', t('visits.settings.visits_years'), visits, setVisits)}
        {field('members', t('visits.settings.members_years'), members, setMembers)}
      </SettingsSection>
      <ProblemAlert error={problem} />
      {saved && <Notice kind="success">{t('visits.settings.saved')}</Notice>}
      <SettingsFooter canManage={canManage} busy={busy} dirty={dirty} onDiscard={discard} outcome={null} problem={null} rootError={undefined} />
    </form>
  );
}

export function VisitsSettingsScreen() {
  return (
    <SettingsPage>
      <SettingsLoader group="visits">{(view, canManage) => <VisitsForm view={view} canManage={canManage} />}</SettingsLoader>
    </SettingsPage>
  );
}

export function PrivacySettingsScreen() {
  return (
    <SettingsPage>
      <SettingsLoader group="privacy">{(view, canManage) => <PrivacyForm view={view} canManage={canManage} />}</SettingsLoader>
    </SettingsPage>
  );
}
