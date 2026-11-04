import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setInstallCsrf } from '@/install/api';
import { INSTALL_MESSAGES } from '@/install/i18n';
import { Wizard } from '@/install/wizard';
import { checks, fakeInstall, healthyProbes, json, problem, type FakeInstall } from './fake-install';

// Step 0 of the wizard (Task 30; spec §7.7, §9.5 step 0): the page asks `GET checks`; without a claim the server
// answers 403 INSTALL_CLAIM_REQUIRED and the claim form shows, with how to open install-code.txt in the File
// Manager. The code is typed in any case, with spaces or dashes, shown grouped 5-5-5-5-6 and sent normalized.

const ID = INSTALL_MESSAGES.id;
const fetchMock = vi.fn<typeof fetch>();
let server: FakeInstall;

beforeEach(() => {
  setInstallCsrf(null);
  vi.stubGlobal('fetch', fetchMock);
  server = fakeInstall(fetchMock, { ...healthyProbes(), 'GET checks': () => problem(403, 'INSTALL_CLAIM_REQUIRED') });
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

async function claimForm(): Promise<HTMLInputElement> {
  render(<Wizard />);
  return (await screen.findByLabelText(ID['claim.code'])) as HTMLInputElement;
}

describe('claim', () => {
  it('explains where install-code.txt is, and opens on the claim step when there is no claim', async () => {
    await claimForm();
    expect(screen.getByRole('heading', { name: ID['claim.title'] })).toBeTruthy();
    expect(document.body.textContent).toContain('install-code.txt');
    expect(document.body.textContent).toContain(ID['claim.where.file_manager']);
  });

  it('the input `abcde fghjk mnpqr stvwx yz0123` is shown 5-5-5-5-6 and sent normalized', async () => {
    server.on('POST claim', () => problem(403, 'INSTALL_CODE_INVALID'));
    const input = await claimForm();
    fireEvent.change(input, { target: { value: 'abcde fghjk mnpqr stvwx yz0123' } });
    expect(input.value).toBe('ABCDE-FGHJK-MNPQR-STVWX-YZ0123');
    fireEvent.click(screen.getByRole('button', { name: ID['claim.submit'] }));
    await waitFor(() => expect(server.callsTo('POST claim')).toHaveLength(1));
    expect(server.callsTo('POST claim')[0]!.body).toEqual({ code: 'ABCDEFGHJKMNPQRSTVWXYZ0123' });
    expect(await screen.findByText(ID['claim.invalid'])).toBeTruthy();
  });

  it('Crockford look-alikes are read as the server reads them (I/L → 1, O → 0); a short code cannot be sent', async () => {
    const input = await claimForm();
    fireEvent.change(input, { target: { value: 'oiLab' } });
    expect(input.value).toBe('011AB');
    expect((screen.getByRole('button', { name: ID['claim.submit'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a 429 shows the retry time', async () => {
    server.on('POST claim', () => problem(429, 'AUTH_TOO_MANY_ATTEMPTS', { headers: { 'Retry-After': '600' } }));
    const input = await claimForm();
    fireEvent.change(input, { target: { value: 'ABCDEFGHJKMNPQRSTVWXYZ0123' } });
    fireEvent.click(screen.getByRole('button', { name: ID['claim.submit'] }));
    expect(await screen.findByText(ID['claim.too_many'].replace('{time}', ID['claim.minutes'].replace('{n}', '10')))).toBeTruthy();
  });

  it('success stores the CSRF token and loads checks: the wizard goes on with the token on every request', async () => {
    server.on('POST claim', () => json({ csrfToken: 'csrf-claim', installState: null }));
    const input = await claimForm();
    fireEvent.change(input, { target: { value: 'ABCDE-FGHJK-MNPQR-STVWX-YZ0123' } });
    server.on('GET checks', () => json(checks({ csrfToken: 'csrf-claim' })));
    fireEvent.click(screen.getByRole('button', { name: ID['claim.submit'] }));

    expect(await screen.findByRole('heading', { name: ID['checks.title'] })).toBeTruthy();
    const loads = server.callsTo('GET checks');
    expect(loads).toHaveLength(2);
    expect(loads[1]!.headers.get('X-CSRF-Token')).toBe('csrf-claim');
    // The probes the checks step starts are sent with it.
    await waitFor(() => expect(server.callsTo('PUT probe/methods')).toHaveLength(1));
    expect(server.callsTo('PUT probe/methods')[0]!.headers.get('X-CSRF-Token')).toBe('csrf-claim');
  });

  it('a claim the browser did not keep (a Secure cookie on an http: page) says so instead of starting over silently', async () => {
    server.on('POST claim', () => json({ csrfToken: 'csrf-claim', installState: null }));
    const input = await claimForm();
    fireEvent.change(input, { target: { value: 'ABCDEFGHJKMNPQRSTVWXYZ0123' } });
    fireEvent.click(screen.getByRole('button', { name: ID['claim.submit'] }));
    expect(await screen.findByText(ID['claim.cookie_lost'])).toBeTruthy();
    expect(server.callsTo('GET checks')).toHaveLength(2);
    expect((screen.getByRole('button', { name: ID['claim.submit'] }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('after a claim the wizard resumes at the step of installState', async () => {
    server.on('POST claim', () => json({ csrfToken: 'csrf-claim', installState: 'admin' }));
    const input = await claimForm();
    fireEvent.change(input, { target: { value: 'ABCDEFGHJKMNPQRSTVWXYZ0123' } });
    server.on('GET checks', () => json(checks({ installState: 'admin' })));
    fireEvent.click(screen.getByRole('button', { name: ID['claim.submit'] }));
    expect(await screen.findByRole('heading', { name: ID['admin.title'] })).toBeTruthy();
  });

  it('an installed ALTIS (404) says so and links the sign-in page', async () => {
    server.on('GET checks', () => problem(404, 'NOT_FOUND'));
    render(<Wizard />);
    expect(await screen.findByRole('heading', { name: ID['app.installed.title'] })).toBeTruthy();
    expect(screen.getByRole('link', { name: ID['app.go_login'] }).getAttribute('href')).toBe('/admin/login');
  });

  it('switches to English', async () => {
    await claimForm();
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(await screen.findByRole('heading', { name: INSTALL_MESSAGES.en['claim.title'] })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });
});
