import { t, type Locale } from '@altis/shared';

// The mails ALTIS sends (decision D17: plain text only). The text of each comes from the shared catalogs
// (`mail.<kind>.subject` / `.body` in packages/shared/src/i18n) unless the library wrote its own (`email.template.*`
// settings), and `{name}` placeholders are filled from `vars`.

// ---- Komunitas (member area): `member_password_reset` ----
export type MailKind = 'password_reset' | 'email_test' | 'member_password_reset';

/** A library's own wording of a mail; null, undefined or blank means the catalog text. */
export interface MailOverride {
  subject?: string | null;
  body?: string | null;
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Every character that ends a line in a mail header: CR, LF, NEL, LS and PS. Built from escapes so the file holds none of them. */
const LINE_BREAKS = new RegExp('[\\r\\n\\u0085\\u2028\\u2029]+', 'g');

/** One line: each run of line breaks becomes a single space, the ends are trimmed. */
export const oneLine = (text: string): string => text.replace(LINE_BREAKS, ' ').trim();

/**
 * `template` with each `{name}` replaced by `vars[name]`, in one pass: a value that looks like a placeholder is not
 * expanded again, and the value is taken literally (no `$&`-style patterns). A placeholder without a value is left as
 * written, as the catalog's `t` does.
 */
function fill(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (whole: string, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole));
}

const filled = (text: string | null | undefined): string | null => (text === null || text === undefined || text.trim() === '' ? null : text);

/**
 * The mail of `kind` in `locale`: a one-line subject and a plain-text body.
 *
 * - `override` (the library's own subject and body, `email.template.*`) replaces the catalog text of the part it
 *   holds; a null, missing or blank part keeps the catalog text.
 * - Values are stripped of CR and LF before they go into the subject, so a library name can never add a header
 *   (`Perpus\r\nBcc: x`); the subject is flattened to one line as a whole, an override's own line breaks included. The body
 *   takes the values as given.
 * - Placeholders are `{name}`, `{username}`, `{library}`, `{link}`, `{minutes}` (password_reset) and `{library}`
 *   (email_test); one that `vars` does not hold stays as written.
 */
export function renderMail(
  kind: MailKind,
  locale: Locale,
  vars: Readonly<Record<string, string>>,
  override: MailOverride = {},
): { subject: string; text: string } {
  const subjectTemplate = filled(override.subject) ?? t(locale, `mail.${kind}.subject`);
  const bodyTemplate = filled(override.body) ?? t(locale, `mail.${kind}.body`);
  const singleLine = Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, oneLine(value)]));
  return { subject: oneLine(fill(subjectTemplate, singleLine)), text: fill(bodyTemplate, vars) };
}
