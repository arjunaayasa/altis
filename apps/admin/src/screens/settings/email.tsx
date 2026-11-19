import { LOCALES, type Locale } from '@altis/shared';
import { EmailSettingsBody, type EmailSettings, type EmailTemplate } from '@altis/shared/api/settings';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field, TEXTAREA_CLASS } from '@/components/form-field';
import { SETTING_BLOCK } from '@/components/layout';
import { Input } from '@/components/ui/input';
import { translate, useT, type AdminKey } from '@/i18n';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, applyServerErrors, hasFieldErrors } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { SettingsFooter, SettingsLoader, SettingsPage, SettingsSection, blankToNull, saveSettings, type SaveOutcome } from './library';

/**
 * Pengaturan → E-mail (spec §13.3 "nama pengirim + templat e-mail"; `PUT settings/email`): the sender's display name
 * and the password-reset mail in each language. A blank field is sent as null and goes back to its default (the
 * library's name, the catalog text shown faintly in the field). The SMTP transport itself is part of the system
 * configuration (system/config.tsx).
 */

/** The longest texts the server keeps (the settings registry's limits, through the shared body schema). */
const TEMPLATE_SHAPE = EmailSettingsBody.shape.templates.unwrap().shape.passwordReset.unwrap().shape.id.unwrap().shape;
const SENDER_MAX = EmailSettingsBody.shape.senderName.unwrap().unwrap().maxLength ?? 100;
const SUBJECT_MAX = TEMPLATE_SHAPE.subject.unwrap().unwrap().maxLength ?? 200;
const BODY_MAX = TEMPLATE_SHAPE.body.unwrap().unwrap().maxLength ?? 4000;

/** The placeholders `renderMail` fills in a password-reset mail (packages/core/src/mail/templates.ts). */
const RESET_PLACEHOLDERS = '{name}, {username}, {library}, {link}, {minutes}';

/**
 * A reset mail without `{link}` would reach the user without the link to set a new password: a body that is not
 * blank (blank goes back to the default text) must contain it. The server refuses it the same way (422
 * VALIDATION_FAILED, code `missing_link`, at the body's path), which lands on the same field.
 */
const LINK_PLACEHOLDER = '{link}';

const TemplateForm = z.strictObject({
  subject: z.string().max(SUBJECT_MAX),
  body: z
    .string()
    .max(BODY_MAX)
    .refine((body) => body.trim() === '' || body.includes(LINK_PLACEHOLDER), { error: 'form.error.missing_link' satisfies AdminKey }),
});

const EmailForm = z.strictObject({
  senderName: z.string().max(SENDER_MAX),
  templates: z.strictObject({ passwordReset: z.strictObject({ id: TemplateForm, en: TemplateForm }) }),
});

type EmailValues = z.infer<typeof EmailForm>;

const templateValues = (t: EmailTemplate): { subject: string; body: string } => ({ subject: t.subject ?? '', body: t.body ?? '' });

function emailValues(view: EmailSettings): EmailValues {
  const reset = view.templates.passwordReset;
  return { senderName: view.senderName ?? '', templates: { passwordReset: { id: templateValues(reset.id), en: templateValues(reset.en) } } };
}

/** The PUT body: only what differs from `view`, at its path. */
function emailBody(values: EmailValues, view: EmailSettings): EmailSettingsBody {
  const body: EmailSettingsBody = {};
  const senderName = blankToNull(values.senderName);
  if (senderName !== view.senderName) body.senderName = senderName;
  const passwordReset: Partial<Record<Locale, { subject?: string | null; body?: string | null }>> = {};
  for (const locale of LOCALES) {
    const typed = values.templates.passwordReset[locale];
    const stored = view.templates.passwordReset[locale];
    const part: { subject?: string | null; body?: string | null } = {};
    const subject = blankToNull(typed.subject);
    if (subject !== stored.subject) part.subject = subject;
    const text = blankToNull(typed.body);
    if (text !== stored.body) part.body = text;
    if (Object.keys(part).length > 0) passwordReset[locale] = part;
  }
  if (Object.keys(passwordReset).length > 0) body.templates = { passwordReset };
  return body;
}

function EmailSettingsForm({ initial, canManage }: { initial: EmailSettings; canManage: boolean }) {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const [view, setView] = useState(initial);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm<EmailValues>({ resolver: zodResolver(EmailForm, FORM_PARSE), defaultValues: emailValues(initial) });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const readOnly = !canManage;
  const discard = (): void => {
    form.reset();
    setOutcome(null);
    setProblem(null);
  };

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    setOutcome(null);
    const body = emailBody(values, view);
    if (Object.keys(body).length === 0) {
      form.reset(emailValues(view));
      setOutcome('unchanged');
      return;
    }
    try {
      const saved = await saveSettings(queryClient, 'email', body);
      setView(saved.view);
      form.reset(emailValues(saved.view));
      setOutcome('saved');
    } catch (e) {
      if (hasFieldErrors(e)) applyServerErrors(form, e);
      else setProblem(e);
    }
  });

  const language = (locale: Locale): string => t(`palette.language.${locale}`);
  const resetErrors = errors.templates?.passwordReset;
  return (
    <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)} onChange={() => setOutcome(null)}>
      <SettingsSection title={t('settings.tab.email')} intro={t('settings.email.description')}>
        <Field label={t('settings.email.sender_name')} hint={t('settings.email.sender_name_hint')} error={errors.senderName}>
          {(c) => (
            <Input
              {...c}
              autoComplete="off"
              maxLength={SENDER_MAX}
              placeholder={me?.library.name}
              {...form.register('senderName')}
              disabled={readOnly}
            />
          )}
        </Field>
      </SettingsSection>
      <SettingsSection title={t('settings.email.reset_title')} intro={t('settings.email.reset_description')}>
        <p className={cn(SETTING_BLOCK, 'text-meta text-muted-foreground')}>{t('settings.email.placeholders', { placeholders: RESET_PLACEHOLDERS })}</p>
        {LOCALES.map((locale) => (
          <fieldset key={locale} className="contents">
            <legend className="sr-only">{language(locale)}</legend>
            <Field label={t('settings.email.subject', { language: language(locale) })} error={resetErrors?.[locale]?.subject}>
              {(c) => (
                <Input
                  {...c}
                  autoComplete="off"
                  maxLength={SUBJECT_MAX}
                  placeholder={translate(locale, 'mail.password_reset.subject')}
                  {...form.register(`templates.passwordReset.${locale}.subject`)}
                  disabled={readOnly}
                />
              )}
            </Field>
            <Field wide label={t('settings.email.body', { language: language(locale) })} error={resetErrors?.[locale]?.body}>
              {(c) => (
                <textarea
                  {...c}
                  rows={8}
                  className={TEXTAREA_CLASS}
                  maxLength={BODY_MAX}
                  placeholder={translate(locale, 'mail.password_reset.body')}
                  {...form.register(`templates.passwordReset.${locale}.body`)}
                  disabled={readOnly}
                />
              )}
            </Field>
          </fieldset>
        ))}
      </SettingsSection>
      <SettingsFooter canManage={canManage} busy={isSubmitting} dirty={isDirty} onDiscard={discard} outcome={outcome} problem={problem} rootError={errors.root?.['server']?.message} />
    </form>
  );
}

/** `/admin/settings/email`. */
export function EmailSettingsScreen() {
  return (
    <SettingsPage>
      <SettingsLoader group="email">{(view, canManage) => <EmailSettingsForm initial={view} canManage={canManage} />}</SettingsLoader>
    </SettingsPage>
  );
}
