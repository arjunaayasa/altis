import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setInstallCsrf } from '@/install/api';
import { INSTALL_MESSAGES, type InstallKey } from '@/install/i18n';
import { Wizard } from '@/install/wizard';
import { ORIGIN, PROBE_CONTENT, PROBE_ID, checks, fakeInstall, healthyProbes, json, preflight, problem, type FakeInstall } from './fake-install';

// The wizard's steps (Task 30; spec §9.5): resume at the step of installState, the checks with the browser probes and
// the blocking exposure verdict, the database and `POST config`, the migrations one call at a time with a progress bar,
// the super admin straight to the scheduler (the community edition has no licence step), the scheduler (both lines
// with copy buttons; `finish` refused with CRON_NOT_DETECTED shows the guidance), and the i18n parity of
// src/install/i18n.ts.

const ID = INSTALL_MESSAGES.id;
const fetchMock = vi.fn<typeof fetch>();
let server: FakeInstall;

beforeEach(() => {
  setInstallCsrf(null);
  vi.stubGlobal('fetch', fetchMock);
  server = fakeInstall(fetchMock, { ...healthyProbes(), 'GET checks': () => json(checks()) });
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const heading = (key: InstallKey) => screen.findByRole('heading', { name: ID[key] });
/** The texts a control names in `aria-describedby`, in its order (what a screen reader reads after the label). */
const described = (el: HTMLElement): string[] =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? `#${id} missing`);
const button = (key: InstallKey) => screen.getByRole('button', { name: ID[key] }) as HTMLButtonElement;

describe('resume', () => {
  it.each([
    ['migrate', 'migrate.title'],
    ['profile', 'profile.title'],
    ['admin', 'admin.title'],
    ['cron', 'cron.title'],
  ] as const)('checks.installState %s → the %s step', async (installState, title) => {
    server.on('GET checks', () => json(checks({ installState })));
    server.on('GET progress', () => json({ installState, migrations: { applied: 1, total: 3 } }));
    server.on('POST migrate', () => json({ done: false, applied: null, remaining: 2 }));
    server.on('POST cron/test', () => json({ required: true, detected: false, mode: null, at: null, cronLine: 'c', curlLine: 'u' }));
    render(<Wizard />);
    expect(await heading(title)).toBeTruthy();
  });

  it('the step list has seven steps, 0 claim to 6 done, and no licence step', async () => {
    server.on('GET checks', () => json(checks({ installState: 'admin' })));
    render(<Wizard />);
    await heading('admin.title');
    const steps = within(screen.getByRole('navigation', { name: ID['app.steps_label'] })).getAllByRole('listitem');
    expect(steps.map((li) => li.textContent)).toEqual(
      (['step.claim', 'step.checks', 'step.database', 'step.profile', 'step.admin', 'step.cron', 'step.done'] as const).map((key, i) => `${i}. ${ID[key]}`),
    );
    expect(steps.find((li) => li.getAttribute('aria-current') === 'step')?.textContent).toBe(`4. ${ID['step.admin']}`);
    expect(screen.getByText(ID['app.step_of'].replace('{n}', '5').replace('{total}', '7'))).toBeTruthy();
    expect(Object.keys(ID).filter((key) => key.startsWith('license.') || key === 'step.license')).toEqual([]);
  });

  it('checks.installState profile → the profile step is shown, and no probe runs', async () => {
    server.on('GET checks', () => json(checks({ installState: 'profile' })));
    render(<Wizard />);
    expect(await heading('profile.title')).toBeTruthy();
    expect(server.callsTo('GET probe/poll')).toHaveLength(0);
  });
});

describe('checks', () => {
  it('a candidate that serves the probe file → POST exposure sent, the blocking message shown, no way forward', async () => {
    server.on(`GET ${ORIGIN}/tmp/${PROBE_ID}`, () => new Response(PROBE_CONTENT, { status: 200 }));
    render(<Wizard />);
    expect(await heading('checks.title')).toBeTruthy();
    expect(await screen.findByText(ID['checks.exposure.exposed'])).toBeTruthy();
    expect(server.callsTo('POST exposure')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: ID['app.next'] })).toBeNull();
    // Only the checks can be run again (after the folders were moved).
    expect(button('checks.rerun')).toBeTruthy();
  });

  it('a failed mandatory check blocks with its fix hint; warnings do not', async () => {
    server.on('GET checks', () =>
      json(checks({ preflight: preflight({ node: { ok: false, level: 'error', detail: 'Node 20.11.0' }, ram: { ok: false, level: 'warn', detail: '256 MiB' } }) })),
    );
    render(<Wizard />);
    expect(await screen.findByText(ID['checks.fix.node'])).toBeTruthy();
    expect(screen.getByText(ID['checks.fix.ram'])).toBeTruthy();
    expect(await screen.findByText(ID['checks.exposure.ok'])).toBeTruthy();
    expect(screen.getByText(ID['checks.blocked_preflight'])).toBeTruthy();
    expect(button('app.next').disabled).toBe(true);
  });

  it('the aaPanel Default project warning and the detected runtime are shown', async () => {
    server.on('GET checks', () => json(checks({ runtime: 'standalone', panelWarning: 'aapanel_default' })));
    render(<Wizard />);
    expect(await screen.findByText(ID['checks.aapanel_default'])).toBeTruthy();
    expect(screen.getByText(ID['checks.runtime'].replace('{runtime}', ID['runtime.standalone']))).toBeTruthy();
  });

  it('the base URL is location.origin; a path is refused', async () => {
    render(<Wizard />);
    const input = (await screen.findByLabelText(ID['checks.base_url.label'])) as HTMLInputElement;
    expect(input.value).toBe(ORIGIN);
    expect(described(input)).toEqual([ID['checks.base_url.hint']]);
    fireEvent.change(input, { target: { value: `${ORIGIN}/perpus` } });
    expect(await screen.findByText(ID['checks.base_url.path'])).toBeTruthy();
    // The control says why it is invalid, and the reason is announced when it appears.
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(described(input)).toEqual([ID['checks.base_url.path'], ID['checks.base_url.hint']]);
    expect(screen.getByText(ID['checks.base_url.path']).getAttribute('role')).toBe('alert');
  });

  it('a clean host: the hops suggestion with its IP is confirmed, then database → Uji koneksi → POST config carries the proof', async () => {
    server.on('POST db/test', () =>
      json({ ok: true, flavor: 'mariadb', version: '10.6.18', problems: [], poolSize: 2, empty: true, resumable: false }),
    );
    server.on('POST config', () => json({ installState: 'migrate' }));
    server.on('GET progress', () => json({ installState: 'migrate', migrations: { applied: 0, total: 3 } }));
    server.on('POST migrate', () => json({ done: false, applied: null, remaining: 3 }));
    render(<Wizard />);

    const suggestion = ID['checks.network.suggestion'].replace('{hops}', '1').replace('{ip}', '198.51.100.7');
    expect(await screen.findByText(suggestion)).toBeTruthy();
    expect(await screen.findByText(ID['checks.exposure.ok'])).toBeTruthy();
    expect(button('app.next').disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(ID['checks.network.confirm']));
    await waitFor(() => expect(button('app.next').disabled).toBe(false));
    fireEvent.click(button('app.next'));

    expect(await heading('db.title')).toBeTruthy();
    // Passenger runs several processes: no SQLite.
    const dialect = screen.getByLabelText(ID['db.dialect']) as HTMLSelectElement;
    expect([...dialect.options].map((o) => o.value)).toEqual(['mysql', 'mariadb', 'postgres']);
    fireEvent.change(dialect, { target: { value: 'mariadb' } });
    fireEvent.change(screen.getByLabelText(ID['db.database']), { target: { value: 'altis' } });
    fireEvent.change(screen.getByLabelText(ID['db.user']), { target: { value: 'altis_user' } });
    fireEvent.change(screen.getByLabelText(ID['db.password']), { target: { value: 'rahasia-db' } });
    expect(button('db.save').disabled).toBe(true);
    fireEvent.click(button('db.test'));
    expect(await screen.findByText(ID['db.result.empty'])).toBeTruthy();
    expect(screen.getByText(ID['db.result.ok'].replace('{flavor}', 'MariaDB').replace('{version}', '10.6.18'))).toBeTruthy();
    const db = { dialect: 'mariadb', host: 'localhost', port: 3306, database: 'altis', user: 'altis_user', password: 'rahasia-db' };
    expect(server.callsTo('POST db/test')[0]!.body).toEqual({ db });

    fireEvent.click(button('db.save'));
    expect(await heading('migrate.title')).toBeTruthy();
    const body = server.callsTo('POST config')[0]!.body as {
      baseUrl: string;
      db: unknown;
      trustProxy: { hops: number };
      probe: { nonce: string; hmac: string; results: Record<string, unknown> };
    };
    expect(body).toMatchObject({ baseUrl: ORIGIN, db, trustProxy: { hops: 1 } });
    expect(body.probe.hmac).toBe(`hmac-of-${body.probe.nonce}`);
    expect(Object.keys(body.probe.results).sort()).toEqual(['chunkBytes', 'methods', 'polling', 'sse', 'xff']);
    expect(body.probe.results).toMatchObject({ polling: true, methods: { put: true, patch: true, delete: true }, chunkBytes: 5 * 1024 * 1024 });
    expect(server.callsTo('POST config')[0]!.headers.get('X-CSRF-Token')).toBe('csrf-w');
  });

  it('no hops value gives an IP (ipAtSuggested empty): the page says so and the chosen hops can still be confirmed', async () => {
    server.on('GET probe/poll', () => json({ now: 1, ip: null, ipTrust: 'collapsed', xff: [], peerPrivate: false, suggestedHops: 0, ipAtSuggested: '' }));
    render(<Wizard />);
    expect(await screen.findByText(ID['checks.network.suggestion_no_ip'].replace('{hops}', '0'))).toBeTruthy();
    expect(screen.getByText(ID['checks.network.ip_unknown'])).toBeTruthy();
    expect(await screen.findByText(ID['checks.exposure.ok'])).toBeTruthy();
    const confirm = screen.getByLabelText(ID['checks.network.confirm_hops']) as HTMLInputElement;
    expect(confirm.disabled).toBe(false);
    expect(button('app.next').disabled).toBe(true);
    fireEvent.click(confirm);
    await waitFor(() => expect(button('app.next').disabled).toBe(false));
  });

  it('the spoofable warning follows the hops being chosen, not what the server derived with its own default', async () => {
    // The server's pre-install hops took the forged entry, but the suggested hops (1) do not.
    server.on('GET probe/poll', (call) => {
      const forged = call.headers.get('X-Forwarded-For');
      const xff = forged === null ? ['198.51.100.7'] : [forged, '198.51.100.7'];
      return json({ now: 1, ip: forged ?? '198.51.100.7', ipTrust: 'ok', xff, peerPrivate: true, suggestedHops: xff.length, ipAtSuggested: xff[0] });
    });
    render(<Wizard />);
    const hops = (await screen.findByLabelText(ID['checks.network.hops'])) as HTMLInputElement;
    expect(hops.value).toBe('1');
    expect(screen.queryByText(ID['checks.network.spoofable'])).toBeNull();
    // Two hops would take the forged entry as the client IP.
    fireEvent.change(hops, { target: { value: '2' } });
    expect(await screen.findByText(ID['checks.network.spoofable'])).toBeTruthy();
    fireEvent.change(hops, { target: { value: '1' } });
    await waitFor(() => expect(screen.queryByText(ID['checks.network.spoofable'])).toBeNull());
  });

  it('hops the page flags as spoofable cannot be confirmed: the box is disabled with the warning as its reason, Next stays off', async () => {
    server.on('GET probe/poll', (call) => {
      const forged = call.headers.get('X-Forwarded-For');
      const xff = forged === null ? ['198.51.100.7'] : [forged, '198.51.100.7'];
      return json({ now: 1, ip: xff.at(-1), ipTrust: 'ok', xff, peerPrivate: true, suggestedHops: xff.length, ipAtSuggested: xff.at(-1) });
    });
    render(<Wizard />);
    const hops = (await screen.findByLabelText(ID['checks.network.hops'])) as HTMLInputElement;
    expect(await screen.findByText(ID['checks.exposure.ok'])).toBeTruthy();
    const confirm = screen.getByRole('checkbox') as HTMLInputElement;
    // The clean chain's length plus one: the forged entry would be the client IP.
    fireEvent.change(hops, { target: { value: '2' } });
    const warning = await screen.findByText(ID['checks.network.spoofable']);
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute('aria-describedby')?.split(' ')).toContain(warning.id);
    fireEvent.click(confirm);
    expect(confirm.checked).toBe(false);
    expect(button('app.next').disabled).toBe(true);
    // The suggested hops again: confirmable.
    fireEvent.change(hops, { target: { value: '1' } });
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(button('app.next').disabled).toBe(false));
  });
});

describe('migrate', () => {
  it('POST migrate is called until done: true and the bar reaches 100 %', async () => {
    server.on('GET checks', () => json(checks({ installState: 'migrate' })));
    server.on('GET progress', () => json({ installState: 'migrate', migrations: { applied: 0, total: 3 } }));
    const answers = [
      { done: false, applied: '0001_init', remaining: 2 },
      { done: false, applied: '0002_access', remaining: 1 },
      { done: true, applied: '0003_ops', remaining: 0 },
    ];
    server.on('POST migrate', () => json(answers.shift()));
    render(<Wizard />);
    expect(await heading('migrate.title')).toBeTruthy();
    expect(await screen.findByText(ID['migrate.done'])).toBeTruthy();
    expect(server.callsTo('POST migrate')).toHaveLength(3);
    const bar = screen.getByRole('progressbar') as HTMLProgressElement;
    expect(bar.value).toBe(100);
    fireEvent.click(button('app.next'));
    expect(await heading('profile.title')).toBeTruthy();
  });

  it('a failed migration stops with its error and can be tried again', async () => {
    server.on('GET checks', () => json(checks({ installState: 'migrate' })));
    server.on('GET progress', () => json({ installState: 'migrate', migrations: { applied: 0, total: 2 } }));
    server.on('POST migrate', () => problem(503, 'DB_UNAVAILABLE'));
    render(<Wizard />);
    expect(await screen.findByText(ID['migrate.failed'])).toBeTruthy();
    server.on('POST migrate', () => json({ done: true, applied: '0002', remaining: 0 }));
    fireEvent.click(button('app.retry'));
    expect(await screen.findByText(ID['migrate.done'])).toBeTruthy();
  });
});

describe('profile and admin', () => {
  it('profile → POST profile → the admin step, which offers 2FA after the first sign-in', async () => {
    server.on('GET checks', () => json(checks({ installState: 'profile' })));
    server.on('POST profile', () => json({ installState: 'admin' }));
    render(<Wizard />);
    await heading('profile.title');
    fireEvent.change(screen.getByLabelText(ID['profile.name']), { target: { value: 'Perpustakaan Arsya' } });
    fireEvent.change(screen.getByLabelText(ID['profile.timezone']), { target: { value: 'Asia/Makassar' } });
    fireEvent.click(button('profile.save'));
    expect(await heading('admin.title')).toBeTruthy();
    expect(server.callsTo('POST profile')[0]!.body).toEqual({
      library: { name: 'Perpustakaan Arsya', timezone: 'Asia/Makassar', locale: 'id' },
      branch: {},
    });
    expect(screen.getByText(ID['admin.two_factor_note'])).toBeTruthy();
    expect(screen.getByText(ID['admin.password_hint'])).toBeTruthy();
  });

  it('admin: the passwords must match; a common password is refused with the policy reason', async () => {
    server.on('GET checks', () => json(checks({ installState: 'admin' })));
    server.on('POST admin', () => problem(422, 'PASSWORD_TOO_WEAK', { reason: 'common' }));
    render(<Wizard />);
    await heading('admin.title');
    fireEvent.change(screen.getByLabelText(ID['admin.username']), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText(ID['admin.name']), { target: { value: 'Ani' } });
    fireEvent.change(screen.getByLabelText(ID['admin.password']), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText(ID['admin.password_confirm']), { target: { value: 'password124' } });
    fireEvent.click(button('admin.save'));
    expect(await screen.findByText(ID['admin.password_mismatch'])).toBeTruthy();
    expect(described(screen.getByLabelText(ID['admin.password_confirm']))).toEqual([ID['admin.password_mismatch']]);
    expect(server.callsTo('POST admin')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(ID['admin.password_confirm']), { target: { value: 'password123' } });
    fireEvent.click(button('admin.save'));
    expect(await screen.findByText(ID['admin.password.common'])).toBeTruthy();
    expect(server.callsTo('POST admin')[0]!.body).toEqual({ username: 'admin', name: 'Ani', password: 'password123' });
  });
});

/** Fills the admin step's form with a valid account. */
function fillAdmin(): void {
  fireEvent.change(screen.getByLabelText(ID['admin.username']), { target: { value: 'admin' } });
  fireEvent.change(screen.getByLabelText(ID['admin.name']), { target: { value: 'Ani' } });
  fireEvent.change(screen.getByLabelText(ID['admin.password']), { target: { value: 'kata-sandi-kuat-1' } });
  fireEvent.change(screen.getByLabelText(ID['admin.password_confirm']), { target: { value: 'kata-sandi-kuat-1' } });
}

describe('admin to cron', () => {
  it('admin → POST admin answers installState cron → the scheduler step, with no licence step between', async () => {
    server.on('GET checks', () => json(checks({ installState: 'admin' })));
    server.on('POST admin', () => json({ installState: 'cron' }));
    server.on('POST cron/test', () => json({ required: true, detected: false, mode: null, at: null, cronLine: 'c', curlLine: 'u' }));
    render(<Wizard />);
    await heading('admin.title');
    fillAdmin();
    fireEvent.click(button('admin.save'));
    expect(await heading('cron.title')).toBeTruthy();
    expect(server.callsTo('POST admin')).toHaveLength(1);
    expect(server.callsTo('GET checks')).toHaveLength(1);
    expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('/license'))).toEqual([]);
  });

  it('cron: both lines with copy buttons; finish refused with CRON_NOT_DETECTED shows the scheduler guidance', async () => {
    const cronLine = '*/5 * * * * /home/u/nodevenv/altis/22/bin/node /home/u/altis/app/app.js jobs:run';
    const curlLine = 'curl -fsS -X POST -H "Authorization: Bearer tok" https://perpus.example/_cron';
    server.on('GET checks', () => json(checks({ installState: 'cron', runtime: 'passenger' })));
    server.on('POST cron/test', () => json({ required: true, detected: false, mode: null, at: null, cronLine, curlLine }));
    server.on('POST finish', () => problem(409, 'CRON_NOT_DETECTED'));
    render(<Wizard />);
    await heading('cron.title');
    expect(await screen.findByText(cronLine)).toBeTruthy();
    expect(screen.getByText(curlLine)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: ID['cron.copy'] })).toHaveLength(2);
    expect(screen.getByText(ID['cron.required'])).toBeTruthy();

    fireEvent.click(button('cron.finish'));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(ID['cron.not_detected_title'])).toBeTruthy();
    expect(within(alert).getByText(ID['cron.guidance.cpanel'])).toBeTruthy();
  });

  it('cron: Uji penjadwal shows a detected scheduler; finish → the done step links the sign-in page', async () => {
    let detected = false;
    server.on('GET checks', () => json(checks({ installState: 'cron', runtime: 'passenger' })));
    server.on('POST cron/test', () =>
      json({ required: true, detected, mode: detected ? 'cron_http' : null, at: detected ? Date.now() : null, cronLine: 'c', curlLine: 'u' }),
    );
    server.on('POST finish', () => json({ next: '/admin/login' }));
    render(<Wizard />);
    await screen.findByText(ID['cron.not_detected']);
    detected = true;
    fireEvent.click(button('cron.test'));
    await waitFor(() => expect(server.callsTo('POST cron/test')).toHaveLength(2));
    expect(await screen.findByText(new RegExp(ID['cron.detected.cron_http'].split('{time}')[0]!))).toBeTruthy();
    fireEvent.click(button('cron.finish'));
    expect(await heading('done.title')).toBeTruthy();
    expect(screen.getByRole('link', { name: ID['done.login'] }).getAttribute('href')).toBe('/admin/login');
  });

  it('a step answered 409 INSTALL_STEP_ORDER asks GET checks where the install stands and goes there', async () => {
    server.on('GET checks', () => json(checks({ installState: 'admin' })));
    server.on('POST admin', () => problem(409, 'INSTALL_STEP_ORDER'));
    server.on('POST cron/test', () => json({ required: false, detected: true, mode: 'worker', at: null, cronLine: 'c', curlLine: 'u' }));
    render(<Wizard />);
    await heading('admin.title');
    // Another tab finished this step meanwhile: the install stands at the scheduler now.
    server.on('GET checks', () => json(checks({ installState: 'cron' })));
    fillAdmin();
    fireEvent.click(button('admin.save'));
    expect(await heading('cron.title')).toBeTruthy();
    expect(server.callsTo('POST admin')).toHaveLength(1);
    expect(server.callsTo('GET checks')).toHaveLength(2);
  });
});

describe('i18n', () => {
  const placeholders = (text: string): string[] => [...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!).sort();

  it('src/install/i18n.ts: id and en have the same keys, none empty, with the same placeholders', () => {
    const id = Object.keys(INSTALL_MESSAGES.id).sort();
    expect(id.length).toBeGreaterThan(50);
    expect(Object.keys(INSTALL_MESSAGES.en).sort()).toEqual(id);
    for (const locale of ['id', 'en'] as const) {
      for (const [key, text] of Object.entries(INSTALL_MESSAGES[locale])) expect(text.trim(), `${locale} ${key}`).not.toBe('');
    }
    for (const key of id as InstallKey[]) expect(placeholders(INSTALL_MESSAGES.en[key]), key).toEqual(placeholders(INSTALL_MESSAGES.id[key]));
  });
});
