import { LOCALES, type Locale } from '@altis/shared';
import type { CirculationSettingsBody, CirculationSettingsView, EmailSettings, EmailSettingsBody, EmailTemplate } from '@altis/shared/api/settings';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { SideSection } from '@/components/layout';
import { Field, TEXTAREA_CLASS } from '@/components/form-field';
import { Input } from '@/components/ui/input';
import { translate, useT, type TKey } from '@/i18n';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { SettingsFooter, saveSettings, type SaveOutcome } from './library';

/**
 * The member notices' settings, two more forms:
 *
 * - Pengaturan › Sirkulasi (`circulation`): how many days before the due date a loan is reminded (0: never), every how
 *   many days an overdue loan is reminded again and at most how many times (0: never), and the hold-ready mail;
 * - the library's own subject and body of each member notice per language (`email`; empty: the built-in text, shown
 *   faintly in the field), on the Pengingat E-mail screen.
 *
 * Each sends only what changed (library.tsx's frame).
 */

type NumberKey = 'dueSoonDays' | 'overdueEveryDays' | 'overdueMax';

const RANGES: Record<NumberKey, [number, number]> = { dueSoonDays: [0, 14], overdueEveryDays: [1, 60], overdueMax: [0, 10] };

export function NoticesSettingsForm({ initial, canManage }: { initial: CirculationSettingsView; canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [view, setView] = useState(initial.notices);
  const [values, setValues] = useState<Record<NumberKey, string>>(() => ({
    dueSoonDays: String(initial.notices.dueSoonDays),
    overdueEveryDays: String(initial.notices.overdueEveryDays),
    overdueMax: String(initial.notices.overdueMax),
  }));
  const [holdReady, setHoldReady] = useState(initial.notices.holdReady);
  const [errors, setErrors] = useState<Partial<Record<NumberKey, TKey>>>({});
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dirty = holdReady !== view.holdReady || (Object.keys(RANGES) as NumberKey[]).some((k) => values[k] !== String(view[k]));
  useDirtyGuard(dirty);

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setErrors({});
    setProblem(null);
    setOutcome(null);
    const next: Partial<Record<NumberKey, TKey>> = {};
    const parsed: Partial<Record<NumberKey, number>> = {};
    for (const key of Object.keys(RANGES) as NumberKey[]) {
      const text = values[key].trim();
      const n = /^\d{1,3}$/.test(text) ? Number(text) : null;
      const [min, max] = RANGES[key];
      if (n === null || n < min || n > max) next[key] = 'form.number_range';
      else parsed[key] = n;
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    const notices: NonNullable<CirculationSettingsBody['notices']> = {};
    for (const key of Object.keys(RANGES) as NumberKey[]) if (parsed[key] !== view[key]) notices[key] = parsed[key]!;
    if (holdReady !== view.holdReady) notices.holdReady = holdReady;
    if (Object.keys(notices).length === 0) {
      setOutcome('unchanged');
      return;
    }
    setBusy(true);
    try {
      const saved = await saveSettings(queryClient, 'circulation', { notices } satisfies CirculationSettingsBody);
      const v = saved.view.notices;
      setView(v);
      setValues({ dueSoonDays: String(v.dueSoonDays), overdueEveryDays: String(v.overdueEveryDays), overdueMax: String(v.overdueMax) });
      setHoldReady(v.holdReady);
      setOutcome('saved');
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  };

  const number = (key: NumberKey, label: TKey, hint: TKey) => (
    <Field label={t(label)} hint={t(hint)} error={errors[key]}>
      {(c) => <Input {...c} inputMode="numeric" value={values[key]} onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} />}
    </Field>
  );

  return (
    <SideSection title={t('notices.settings.title')} intro={t('notices.settings.intro')}>
      <form noValidate className="grid gap-4 sm:grid-cols-3" onSubmit={(e) => void submit(e)}>
        <fieldset disabled={!canManage} className="contents">
          {number('dueSoonDays', 'notices.settings.due_soon_days', 'notices.settings.due_soon_hint')}
          {number('overdueEveryDays', 'notices.settings.overdue_every', 'notices.settings.overdue_every_hint')}
          {number('overdueMax', 'notices.settings.overdue_max', 'notices.settings.overdue_max_hint')}
          <label className="flex items-center gap-2 text-sm sm:col-span-3">
            <input type="checkbox" className="size-4 accent-primary" checked={holdReady} onChange={(e) => setHoldReady(e.target.checked)} />
            {t('notices.settings.hold_ready')}
          </label>
        </fieldset>
        <div className="grid gap-4 sm:col-span-3">
          <SettingsFooter canManage={canManage} busy={busy} outcome={outcome} problem={problem} rootError={undefined} />
        </div>
      </form>
    </SideSection>
  );
}

// ---- the templates ---------------------------------------------------------------------------------------------------

type TemplateName = 'circulationDueSoon' | 'circulationOverdue' | 'circulationHoldReady';

const TEMPLATES: readonly { name: TemplateName; kind: 'circulation_due_soon' | 'circulation_overdue' | 'circulation_hold_ready'; label: TKey }[] = [
  { name: 'circulationDueSoon', kind: 'circulation_due_soon', label: 'vocab.notice_kind.due_soon' },
  { name: 'circulationOverdue', kind: 'circulation_overdue', label: 'vocab.notice_kind.overdue' },
  { name: 'circulationHoldReady', kind: 'circulation_hold_ready', label: 'vocab.notice_kind.hold_ready' },
];

/** The placeholders the notice mails fill. */
const NOTICE_PLACEHOLDERS = '{name}, {memberNo}, {library}, {link}, {loans}, {count}, {due}, {balance}, {title}, {branch}, {pickupUntil}';

type Texts = Record<TemplateName, Record<Locale, { subject: string; body: string }>>;

const textOf = (tpl: EmailTemplate): { subject: string; body: string } => ({ subject: tpl.subject ?? '', body: tpl.body ?? '' });

function textsOf(view: EmailSettings): Texts {
  const out = {} as Texts;
  for (const { name } of TEMPLATES) out[name] = { id: textOf(view.templates[name].id), en: textOf(view.templates[name].en) };
  return out;
}

const blankToNull = (s: string): string | null => (s.trim() === '' ? null : s);

export function NoticeTemplatesForm({ initial, canManage }: { initial: EmailSettings; canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [view, setView] = useState(initial);
  const [texts, setTexts] = useState<Texts>(() => textsOf(initial));
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useDirtyGuard(JSON.stringify(texts) !== JSON.stringify(textsOf(view)));

  const set = (name: TemplateName, locale: Locale, part: 'subject' | 'body', value: string): void =>
    setTexts((x) => ({ ...x, [name]: { ...x[name], [locale]: { ...x[name][locale], [part]: value } } }));

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setProblem(null);
    setOutcome(null);
    const templates: NonNullable<EmailSettingsBody['templates']> = {};
    for (const { name } of TEMPLATES) {
      const pair: Partial<Record<Locale, { subject?: string | null; body?: string | null }>> = {};
      for (const locale of LOCALES) {
        const stored = view.templates[name][locale];
        const typed = texts[name][locale];
        const part: { subject?: string | null; body?: string | null } = {};
        if (blankToNull(typed.subject) !== stored.subject) part.subject = blankToNull(typed.subject);
        if (blankToNull(typed.body) !== stored.body) part.body = blankToNull(typed.body);
        if (Object.keys(part).length > 0) pair[locale] = part;
      }
      if (Object.keys(pair).length > 0) templates[name] = pair;
    }
    if (Object.keys(templates).length === 0) {
      setOutcome('unchanged');
      return;
    }
    setBusy(true);
    try {
      const saved = await saveSettings(queryClient, 'email', { templates } satisfies EmailSettingsBody);
      setView(saved.view);
      setTexts(textsOf(saved.view));
      setOutcome('saved');
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SideSection title={t('notices.templates.title')} intro={t('notices.templates.intro', { placeholders: NOTICE_PLACEHOLDERS })}>
      <form noValidate className="grid gap-6" onSubmit={(e) => void submit(e)}>
        <fieldset disabled={!canManage} className="contents">
          {TEMPLATES.map(({ name, kind, label }) => (
            <fieldset key={name} className="grid gap-4 border-t pt-4 first-of-type:border-t-0 first-of-type:pt-0">
              <legend className="text-sm font-semibold">{t(label)}</legend>
              {LOCALES.map((locale) => (
                <div key={locale} className="grid gap-3">
                  <Field label={t('settings.email.subject', { language: t(`palette.language.${locale}`) })}>
                    {(c) => (
                      <Input
                        {...c}
                        autoComplete="off"
                        maxLength={200}
                        placeholder={translate(locale, `mail.${kind}.subject`)}
                        value={texts[name][locale].subject}
                        onChange={(e) => set(name, locale, 'subject', e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label={t('settings.email.body', { language: t(`palette.language.${locale}`) })}>
                    {(c) => (
                      <textarea
                        {...c}
                        rows={8}
                        className={TEXTAREA_CLASS}
                        maxLength={4000}
                        placeholder={translate(locale, `mail.${kind}.body`)}
                        value={texts[name][locale].body}
                        onChange={(e) => set(name, locale, 'body', e.target.value)}
                      />
                    )}
                  </Field>
                </div>
              ))}
            </fieldset>
          ))}
        </fieldset>
        <SettingsFooter canManage={canManage} busy={busy} outcome={outcome} problem={problem} rootError={undefined} />
      </form>
    </SideSection>
  );
}
