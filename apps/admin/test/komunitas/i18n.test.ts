import { describe, expect, it } from 'vitest';
import { ADMIN_MESSAGES } from '@/i18n';
import { KOMUNITAS_AREAS_EN, KOMUNITAS_AREAS_ID, KOMUNITAS_EN, KOMUNITAS_ID } from '@/i18n/komunitas';

// The admin copy of reports and accreditation: one file per area, each owned by the task that builds its screens,
// joined in i18n/komunitas/index.ts and spread into ADMIN_ID/ADMIN_EN. Every area is held to the shared rules: the same
// keys and {placeholders} in `id` and `en`, no empty text, no English left in `id`, and keys under the area's prefix
// (`reports.` or `accreditation.`, never a shared family such as `report.` or `accred.`), so two areas never write
// the same key.

const placeholders = (text: string): string[] => [...new Set([...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!))].sort();

/** The prefixes an area's keys may take. */
const PREFIXES: Readonly<Record<keyof typeof KOMUNITAS_AREAS_ID, readonly string[]>> = {
  reports: ['reports.'],
  accreditation: ['accreditation.'],
  workspace: ['accreditation.workspace.'],
  registers: ['accreditation.registers.'],
  usage: ['accreditation.usage.', 'accreditation.snp.'],
  print: ['accreditation.print.'],
  settings: ['accreditation.settings.'],
  members: ['members.'],
  circulation: ['circulation.'],
  holds: ['holds.', 'nav.circulation.hold_shelf', 'jobs.type.circulation.holds', 'jobs.schedule.circulation.holds', 'jobs.message.circulation.holds.'],
  circCore: ['circulation.', 'members.clearance.'],
  membersTools: ['members.tools.', 'visits.'],
  // ---- Komunitas (member area) ----
  'member-area': ['members.types.field.', 'members.types.opac.', 'members.password.', 'catalog.attachments.', 'auditlog.actor.member', 'jobs.type.mail.member_password_reset'],
  placeholder: ['komunitas.placeholder.'],
};

describe('the reports and accreditation admin copy', () => {
  const areas = Object.keys(KOMUNITAS_AREAS_ID) as (keyof typeof KOMUNITAS_AREAS_ID)[];

  it('is one file per area, in a fixed order, plus the placeholder texts', () => {
    expect(areas).toEqual(['reports', 'accreditation', 'workspace', 'registers', 'usage', 'print', 'settings', 'members', 'circulation', 'holds', 'circCore', 'membersTools', 'member-area', 'placeholder']);
    expect(Object.keys(KOMUNITAS_AREAS_EN)).toEqual(areas);
  });

  it.each(areas)('%s: id and en have the same keys, each with the area prefix', (area) => {
    const id = Object.keys(KOMUNITAS_AREAS_ID[area]).sort();
    expect(Object.keys(KOMUNITAS_AREAS_EN[area]).sort()).toEqual(id);
    for (const key of id) expect(PREFIXES[area].some((prefix) => key.startsWith(prefix)), key).toBe(true);
  });

  it.each(areas)('%s: no empty text, the same placeholders, and no English left in id', (area) => {
    const en = KOMUNITAS_AREAS_EN[area];
    for (const [key, text] of Object.entries(KOMUNITAS_AREAS_ID[area] as Readonly<Record<string, string>>)) {
      for (const value of [text, en[key]!]) expect(value.trim(), key).not.toBe('');
      expect(placeholders(en[key]!), key).toEqual(placeholders(text));
      expect(en[key], `${key}: the id text is the en one`).not.toBe(text);
    }
  });

  it('no key is in two areas, and the joined copy holds every area key; ADMIN_MESSAGES spreads it as it is', () => {
    const all = areas.flatMap((area) => Object.keys(KOMUNITAS_AREAS_ID[area]));
    expect(all.length).toBe(new Set(all).size);
    expect(Object.keys(KOMUNITAS_ID).sort()).toEqual([...all].sort());
    expect(Object.keys(KOMUNITAS_EN).sort()).toEqual([...all].sort());
    for (const [key, text] of Object.entries(KOMUNITAS_ID)) {
      expect((ADMIN_MESSAGES.id as Readonly<Record<string, string>>)[key], key).toBe(text);
      expect((ADMIN_MESSAGES.en as Readonly<Record<string, string>>)[key], key).toBe((KOMUNITAS_EN as Readonly<Record<string, string>>)[key]);
    }
  });

  it('the navigation and the settings tab have their labels', () => {
    expect(ADMIN_MESSAGES.id['nav.group.reports']).toBe('Laporan');
    expect(ADMIN_MESSAGES.id['nav.reports.reports']).toBe('Laporan');
    expect(ADMIN_MESSAGES.id['nav.reports.accreditation']).toBe('Akreditasi');
    expect(ADMIN_MESSAGES.id['settings.tab.accreditation']).toBe('Akreditasi');
    for (const key of ['nav.group.reports', 'nav.reports.reports', 'nav.reports.accreditation', 'settings.tab.accreditation'] as const) {
      expect(ADMIN_MESSAGES.en[key], key).toBeTruthy();
      expect(ADMIN_MESSAGES.en[key], key).not.toBe(ADMIN_MESSAGES.id[key]);
    }
  });
});
