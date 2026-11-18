import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import type { Download, Locator, Page } from '@playwright/test';
import type { EvidenceListResponse } from '@altis/shared/api/accreditation';
import { SLIMS_FIXTURE_SEED, slimsFixtureBytes } from '../../../packages/core/test/support/slims-fixture/index.js';
import type { CspRecorder } from '../lib/csp.js';
import { T, expect, passReauth, signIn, test } from '../fixtures.js';
import { openNavPage } from '../lib/nav.js';

// The accreditation workspace of a school library, end to end, as its librarian prepares a period, in a real browser
// with the CSP guard of fixtures.ts on every page (the spec fails on any CSP violation):
//
//   the library type set to "Perpustakaan sekolah" in Pengaturan; a new period of the senior-high instrument over the
//   last school year that has ended; its population and facilities; one activity, one staff member, one budget year
//   and one document in the registers; one evidence file uploaded on an indicator; the usage statistics imported from
//   the synthetic SLiMS dump (its usage rows dated over the three school years up to the period's end) through the
//   import wizard; "Hitung ulang"; the period frozen; then, on Cetak, the simulation, the evidence file (PDF) and the
//   per-component ZIP made and downloaded, each file read (a PDF, a ZIP of the component ZIPs).
//
// The fixture super admin holds every permission; the documents that hold personal data ask for the password, which
// the spec confirms in the dialog whenever it comes. The screens' words come from the admin catalogues (lib/text.ts).

const ULID_IN_PATH = /\/admin\/accreditation\/([0-9A-HJKMNP-TV-Z]{26})(?:\?|$)/;

/** The jobs of the install (the import, the evaluation, the documents) may take this long. */
const JOB_TIMEOUT_MS = 5 * 60_000;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Runs `fn` as a reported step and requires that it caused no CSP problem (the fixture checks the test again). */
async function clean(csp: CspRecorder, name: string, fn: () => Promise<void>): Promise<void> {
  await test.step(name, async () => {
    const mark = csp.mark();
    await fn();
    expect(csp.problems(mark), `CSP problems during "${name}"`).toEqual([]);
  });
}

/** The year the last school year that has ended began (July to June). */
function lastSchoolYearStart(now: Date = new Date()): number {
  const year = now.getFullYear();
  return now.getMonth() + 1 >= 7 ? year - 1 : year - 2;
}

/** A one-page PDF (the evidence file a librarian scans). */
function onePagePdf(): Buffer {
  const stream = 'BT /F1 18 Tf 30 100 Td (Bukti uji akreditasi) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Clicks `trigger` and answers the password dialog when it comes before the download; the download. */
async function downloadConfirmed(page: Page, trigger: Locator, password: string): Promise<Buffer> {
  const download = page.waitForEvent('download', { timeout: JOB_TIMEOUT_MS });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: T('reauth.title') });
  const first = await Promise.race([
    download.then(() => 'download' as const),
    dialog.waitFor({ state: 'visible', timeout: 30_000 }).then(
      () => 'dialog' as const,
      () => 'none' as const,
    ),
  ]);
  if (first === 'dialog') {
    await dialog.getByLabel(T('reauth.password'), { exact: true }).fill(password);
    await dialog.getByRole('button', { name: T('reauth.submit'), exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  const done: Download = await download;
  return fsp.readFile(await done.path());
}

/** The names of the entries of a ZIP, read from its central directory (the end record, then each file header). */
function zipNames(zip: Buffer): string[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('no end of central directory record');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`central directory entry ${i} is malformed`);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    names.push(zip.subarray(at + 46, at + 46 + nameLength).toString('utf8'));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

test('Akreditasi: a school period prepared, computed, frozen, and its simulation, evidence file and per-component ZIP downloaded', async ({
  page,
  csp,
  admin,
  staff,
}) => {
  test.setTimeout(20 * 60_000);
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const startYear = lastSchoolYearStart();
  const startsOn = `${startYear}-07-01`;
  const endsOn = `${startYear + 1}-06-30`;
  const periodName = `Tahun pelajaran ${startYear}/${startYear + 1} (uji ${tag})`;
  const status = page.getByRole('region', { name: T('accreditation.status.title') });
  const tab = (key: Parameters<typeof T>[0]) => page.getByRole('tablist', { name: T('accreditation.tabs') }).getByRole('tab', { name: T(key), exact: true });
  let periodId = '';

  await clean(csp, 'sign in', async () => {
    await signIn(page, admin);
  });

  await clean(csp, 'Pengaturan: the library is a school library', async () => {
    await page.goto('/admin/settings');
    await page.getByLabel(T('settings.library.type'), { exact: true }).selectOption('sekolah');
    await page.getByRole('button', { name: T('form.save'), exact: true }).click();
    await expect(page.getByText(T('form.saved'), { exact: true }).or(page.getByText(T('settings.unchanged'), { exact: true }))).toBeVisible();
  });

  await clean(csp, 'Akreditasi: a new period of the senior-high instrument', async () => {
    await openNavPage(page, '/admin/accreditation');
    await expect(page).toHaveURL(/\/admin\/accreditation$/);
    await expect(page.getByRole('heading', { level: 1, name: T('accreditation.title'), exact: true })).toBeVisible();
    await page.getByRole('link', { name: T('accreditation.new_period'), exact: true }).first().click();
    await expect(page).toHaveURL(/\/admin\/accreditation\/new$/);
    await expect(page.getByRole('heading', { level: 1, name: T('accreditation.new.title'), exact: true })).toBeVisible();
    await page.getByLabel(T('accreditation.new.name'), { exact: true }).fill(periodName);
    await page.getByLabel(T('accreditation.new.instrument'), { exact: true }).selectOption('sch-sma-2025');
    await page.getByLabel(T('accreditation.new.kind'), { exact: true }).selectOption('school_year');
    await page.getByLabel(T('accreditation.new.start_year_school'), { exact: true }).fill(String(startYear));
    await page.getByLabel(T('accreditation.new.school_level'), { exact: true }).selectOption('sma_smk_ma');
    await page.getByRole('button', { name: T('accreditation.new.submit'), exact: true }).click();
    await expect(page).toHaveURL(ULID_IN_PATH);
    periodId = ULID_IN_PATH.exec(page.url())![1]!;
    await expect(page.getByRole('heading', { level: 2, name: periodName, exact: true })).toBeVisible();
    await expect(status.getByText(T('accreditation.status.never'), { exact: true })).toBeVisible();
  });

  await clean(csp, 'Populasi & Sarana: the school\'s population and facilities saved', async () => {
    await tab('accreditation.tab.populasi').click();
    await expect(page).toHaveURL(/[?&]tab=populasi(&|$)/);
    const numbers: [Parameters<typeof T>[0], string][] = [
      ['accreditation.workspace.population.students', '108'],
      ['accreditation.workspace.population.teachers', '10'],
      ['accreditation.workspace.population.edu_staff', '5'],
      ['accreditation.workspace.population.classes', '3'],
      ['accreditation.workspace.population.user_pcs', '4'],
      ['accreditation.workspace.population.scanners', '2'],
      ['accreditation.workspace.population.hours', '35'],
    ];
    for (const [label, value] of numbers) await page.getByLabel(T(label), { exact: true }).fill(value);
    await page.getByRole('checkbox', { name: T('vocab.service_code.reading_room'), exact: true }).check();
    await page.getByRole('checkbox', { name: T('vocab.service_code.circulation'), exact: true }).check();
    await page.getByRole('button', { name: T('form.save'), exact: true }).click();
    await expect(page.getByText(T('form.saved'), { exact: true })).toBeVisible();
    await expect(page.getByLabel(T('accreditation.workspace.population.students'), { exact: true })).toHaveValue('108');
  });

  await clean(csp, 'Register: one activity, one staff member, one budget year and one document', async () => {
    await tab('accreditation.tab.register').click();
    await expect(page).toHaveURL(/[?&]tab=register(&|$)/);
    const registers = page.getByRole('tablist', { name: T('accreditation.registers.tabs_label') });
    // A register's form opens in a panel above its table, named "Tambah …" and, once the row is stored, "Ubah …".
    const kinds = ['activities', 'staff', 'budgets', 'documents'] as const;
    const titles = kinds.flatMap((kind) => [T(`accreditation.registers.${kind}.add`), T(`accreditation.registers.${kind}.edit`)]);
    const panel = page.getByRole('region', { name: new RegExp(`^(${titles.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`) });

    /**
     * Saves the open panel's form; the panel then says the row `name` was stored, and is closed; the register lists a
     * row showing `rowText`.
     */
    const saveAndClose = async (name: string, rowText: string = name): Promise<void> => {
      await panel.getByRole('button', { name: T('form.save'), exact: true }).click();
      await expect(panel.getByText(T('accreditation.registers.done.created', { name }), { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: T('form.cancel'), exact: true }).first().click();
      await expect(panel).toBeHidden();
      await expect(page.getByRole('row').filter({ hasText: rowText }).first()).toBeVisible();
    };

    const activity = `Bimbingan membaca kelas X (uji ${tag})`;
    await registers.getByRole('tab', { name: T('accreditation.registers.tab.activities'), exact: true }).click();
    await page.getByRole('button', { name: T('accreditation.registers.activities.add'), exact: true }).click();
    await expect(panel.getByRole('heading', { name: T('accreditation.registers.activities.add'), exact: true })).toBeVisible();
    await panel.getByLabel(T('accreditation.registers.activities.field.kind'), { exact: true }).selectOption('reading_guidance');
    await panel.getByLabel(T('accreditation.registers.field.title'), { exact: true }).fill(activity);
    await panel.getByLabel(T('accreditation.registers.activities.field.held_on'), { exact: true }).fill(`${startYear}-09-15`);
    await panel.getByLabel(T('accreditation.registers.activities.field.participants'), { exact: true }).fill('30');
    await saveAndClose(activity);

    const person = `Pustakawan Uji ${tag}`;
    await registers.getByRole('tab', { name: T('accreditation.registers.tab.staff'), exact: true }).click();
    await page.getByRole('button', { name: T('accreditation.registers.staff.add'), exact: true }).click();
    await expect(panel.getByRole('heading', { name: T('accreditation.registers.staff.add'), exact: true })).toBeVisible();
    await panel.getByLabel(T('accreditation.registers.staff.field.name'), { exact: true }).fill(person);
    await panel.getByLabel(T('accreditation.registers.staff.field.role'), { exact: true }).selectOption('head');
    await panel.getByLabel(T('accreditation.registers.staff.field.education_level'), { exact: true }).selectOption('s1');
    await panel.getByLabel(T('accreditation.registers.staff.field.starts_on'), { exact: true }).fill(`${startYear - 3}-07-01`);
    await panel.getByRole('checkbox', { name: T('accreditation.registers.staff.field.library_training'), exact: true }).check();
    await saveAndClose(person);

    const budgetYear = startYear + 1;
    await registers.getByRole('tab', { name: T('accreditation.registers.tab.budgets'), exact: true }).click();
    await page.getByRole('button', { name: T('accreditation.registers.budgets.add'), exact: true }).click();
    await expect(panel.getByRole('heading', { name: T('accreditation.registers.budgets.add'), exact: true })).toBeVisible();
    await panel.getByLabel(T('accreditation.registers.budgets.field.year'), { exact: true }).fill(String(budgetYear));
    await panel.getByLabel(T('accreditation.registers.budgets.field.library'), { exact: true }).fill('6.500.000');
    await panel.getByLabel(T('accreditation.registers.budgets.field.parent_nonpersonnel'), { exact: true }).fill('100.000.000');
    await saveAndClose(T('accreditation.registers.budgets.name', { year: budgetYear }), String(budgetYear));

    const document = `Kebijakan pengembangan koleksi (uji ${tag})`;
    await registers.getByRole('tab', { name: T('accreditation.registers.tab.documents'), exact: true }).click();
    await page.getByRole('button', { name: T('accreditation.registers.documents.add'), exact: true }).click();
    await expect(panel.getByRole('heading', { name: T('accreditation.registers.documents.add'), exact: true })).toBeVisible();
    await panel.getByLabel(T('accreditation.registers.documents.field.kind'), { exact: true }).selectOption('collection_policy');
    await panel.getByLabel(T('accreditation.registers.field.title'), { exact: true }).fill(document);
    await panel.getByLabel(T('accreditation.registers.documents.field.issued_on'), { exact: true }).fill(`${startYear}-07-10`);
    for (const code of ['a1', 'a2', 'a3']) {
      await panel.getByRole('checkbox', { name: T(`accred.aspect.collection_policy.${code}` as Parameters<typeof T>[0]), exact: true }).check();
    }
    await saveAndClose(document);
  });

  await clean(csp, 'Indikator: one evidence file uploaded on an indicator', async () => {
    await tab('accreditation.tab.indikator').click();
    await expect(page).toHaveURL(/[?&]tab=indikator(&|$)/);
    const upload = T('accreditation.workspace.evidence.upload');
    const card = page.locator('section[data-indicator]').filter({ has: page.getByRole('button', { name: upload, exact: true }) }).first();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: upload, exact: true }).first().click();
    const panel = page.getByRole('form', { name: upload });
    await expect(panel).toBeVisible();
    await panel.getByLabel(T('accreditation.registers.upload.file'), { exact: true }).setInputFiles({ name: `bukti-${tag}.pdf`, mimeType: 'application/pdf', buffer: onePagePdf() });
    await panel.getByLabel(T('accreditation.registers.upload.caption'), { exact: true }).fill(`Bukti uji ${tag}`);
    const submit = panel.getByRole('button', { name: T('accreditation.registers.upload.submit'), exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(panel).toBeHidden({ timeout: 60_000 });
    const listed = await staff.call<EvidenceListResponse>('GET', `accreditation/evidence?periodId=${encodeURIComponent(periodId)}`);
    expect(listed.evidence.filter((e) => e.caption === `Bukti uji ${tag}` && e.mime === 'application/pdf')).toHaveLength(1);
  });

  await clean(csp, 'Penggunaan Bulanan: the SLiMS fixture dump imported through the wizard', async () => {
    const { dump } = slimsFixtureBytes(SLIMS_FIXTURE_SEED, {
      usage: { fromMonth: `${startYear - 2}-07`, months: 36, period: { startsOn, endsOn } },
    });
    await tab('accreditation.tab.penggunaan').click();
    await expect(page).toHaveURL(/[?&]tab=penggunaan(&|$)/);
    await page.getByRole('button', { name: T('accreditation.usage.import_open'), exact: true }).click();
    await expect(page.getByRole('heading', { name: T('accreditation.usage.wizard.title'), exact: true })).toBeVisible();
    await page.getByLabel(T('accreditation.usage.source.kind_dump'), { exact: true }).check();
    await page.getByLabel(T('catalog.migration.dump.file'), { exact: true }).setInputFiles({ name: 'slims-dump.sql', mimeType: 'application/sql', buffer: dump });
    await page.getByRole('button', { name: T('accreditation.usage.next'), exact: true }).click();
    await expect(page.getByRole('heading', { name: T('accreditation.usage.options.title'), exact: true })).toBeVisible();
    await page.getByRole('button', { name: T('accreditation.usage.start'), exact: true }).click();
    const succeeded = page.getByText(T('accreditation.usage.summary.succeeded'), { exact: true });
    await passReauth(page, admin.password, { next: page.getByRole('heading', { name: T('accreditation.usage.progress.title'), exact: true }).or(succeeded) });
    await expect(succeeded).toBeVisible({ timeout: JOB_TIMEOUT_MS });
    await expect(page.getByText(new RegExp(`^${escapeRe(T('accreditation.usage.summary.months', { first: '', last: '' }).split(':')[0]!)}`)).first()).toBeVisible();
    await page.getByRole('button', { name: T('accreditation.usage.summary.done'), exact: true }).click();
    await expect(page.getByRole('heading', { name: T('accreditation.usage.wizard.title'), exact: true })).toBeHidden();
  });

  await clean(csp, '"Hitung ulang": the results computed', async () => {
    await status.getByRole('button', { name: T('accreditation.status.recompute'), exact: true }).click();
    const computed = new RegExp(`^${escapeRe(T('accreditation.status.computed', { time: '' }).trim())}`);
    await expect(status.getByText(computed)).toBeVisible({ timeout: JOB_TIMEOUT_MS });
    await expect(status.getByRole('button', { name: T('accreditation.status.recompute'), exact: true })).toBeEnabled();
    await expect(status.getByText(T('accreditation.status.stale'), { exact: true })).toHaveCount(0);
  });

  await clean(csp, 'Riwayat: the period frozen with its snapshot', async () => {
    await tab('accreditation.tab.riwayat').click();
    await expect(page).toHaveURL(/[?&]tab=riwayat(&|$)/);
    const freeze = page.getByRole('region', { name: T('accreditation.workspace.history.freeze.title'), exact: true });
    await freeze.getByLabel(T('accreditation.workspace.history.freeze.note'), { exact: true }).fill(`Snapshot uji ${tag}`);
    await freeze.getByRole('button', { name: T('accreditation.workspace.history.freeze.submit'), exact: true }).click();
    // Frozen: the panel turns into the unfreeze panel, and the snapshot is listed.
    await expect(page.getByRole('region', { name: T('accreditation.workspace.history.unfreeze.title'), exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(T('vocab.period_status.frozen'), { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: `Snapshot uji ${tag}` })).toHaveCount(1);
  });

  await clean(csp, 'Cetak: the simulation, the evidence file and the per-component ZIP made and downloaded', async () => {
    await tab('accreditation.tab.cetak').click();
    await expect(page).toHaveURL(/[?&]tab=cetak(&|$)/);
    const runs = page.locator('li[data-run-id]');

    /** Starts a document with `button`, waits for its run to succeed, downloads its file. */
    const make = async (button: string, runTitle: string): Promise<Buffer> => {
      const card = runs.filter({ hasText: runTitle }).first();
      await page.getByRole('button', { name: button, exact: true }).click();
      await passReauth(page, admin.password, { next: card });
      // The download appears once the run has succeeded.
      const label = T('accreditation.print.runs.download_label', { title: runTitle, date: '' }).replace(/,\s*$/, '');
      const download = card.getByRole('button', { name: new RegExp(`^${escapeRe(label)}`) });
      await expect(download).toBeVisible({ timeout: JOB_TIMEOUT_MS });
      await expect(card.getByText(T('vocab.report_run_status.succeeded'), { exact: true }).first()).toBeVisible();
      return downloadConfirmed(page, download, admin.password);
    };

    const pdf = T('vocab.report_format.pdf');
    const simulation = await make(T('accreditation.print.simulation.make'), `${T('report.accreditation.self_assessment.title')} · ${pdf}`);
    expect(simulation.subarray(0, 5).toString('latin1'), 'the simulation is a PDF').toBe('%PDF-');

    const dossier = await make(T('accreditation.print.dossier.pdf'), `${T('report.accreditation.dossier.title')} · ${pdf}`);
    expect(dossier.subarray(0, 5).toString('latin1'), 'the evidence file is a PDF').toBe('%PDF-');

    const zip = await make(T('accreditation.print.dossier.zip_components'), `${T('report.accreditation.dossier.title')} · ${T('accreditation.print.dossier.zip_components')}`);
    expect(zip.readUInt32LE(0), 'the per-component evidence is a ZIP').toBe(0x04034b50);
    expect(zipNames(zip).sort()).toEqual(['F-penyelenggaraan.zip', 'G-pengelolaan.zip', 'K-koleksi.zip', 'L-pelayanan.zip', 'SP-sarana.zip', 'T-tenaga.zip', 'profil.zip']);
  });
});
