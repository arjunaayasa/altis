import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BROWSER_CHANNELS, E2E_HOST_SUFFIX, browserUse, hostResolverArg, withHostResolver } from '../lib/browser.js';

const EXE = path.resolve('/opt/browsers/chrome-headless-shell');
const exists = (file: string): boolean => file === EXE;

describe('browserUse (which Chromium the E2E suite drives)', () => {
  it("uses Playwright's own Chromium when neither variable is set (CI installs it with `playwright install`)", () => {
    expect(browserUse({}, exists)).toEqual({});
    expect(browserUse({ ALTIS_E2E_EXECUTABLE: '  ', ALTIS_E2E_CHANNEL: '' }, exists)).toEqual({});
  });

  it('launches a local executable named by ALTIS_E2E_EXECUTABLE', () => {
    expect(browserUse({ ALTIS_E2E_EXECUTABLE: EXE }, exists)).toEqual({ launchOptions: { executablePath: EXE } });
  });

  it('refuses an executable path that is relative or names no file', () => {
    expect(() => browserUse({ ALTIS_E2E_EXECUTABLE: 'chrome' }, exists)).toThrow(/ALTIS_E2E_EXECUTABLE.*absolute/);
    expect(() => browserUse({ ALTIS_E2E_EXECUTABLE: path.resolve('/nowhere/chrome') }, exists)).toThrow(/ALTIS_E2E_EXECUTABLE.*no such file/);
  });

  it('takes a Chromium channel by ALTIS_E2E_CHANNEL (an installed Chrome or Edge)', () => {
    expect(browserUse({ ALTIS_E2E_CHANNEL: 'msedge' }, exists)).toEqual({ channel: 'msedge' });
    expect(BROWSER_CHANNELS).toContain('chrome');
  });

  it('refuses an unknown channel, and both variables at once', () => {
    expect(() => browserUse({ ALTIS_E2E_CHANNEL: 'firefox' }, exists)).toThrow(/ALTIS_E2E_CHANNEL.*one of/);
    expect(() => browserUse({ ALTIS_E2E_CHANNEL: 'chrome', ALTIS_E2E_EXECUTABLE: EXE }, exists)).toThrow(/not both/);
  });
});

describe('withHostResolver (1d Task 35: an app with a DNS name as its baseUrl)', () => {
  it('maps every name under altis-e2e.test to 127.0.0.1, beside the browser picked', () => {
    expect(E2E_HOST_SUFFIX).toBe('altis-e2e.test');
    expect(hostResolverArg()).toBe('--host-resolver-rules=MAP *.altis-e2e.test 127.0.0.1');
    expect(withHostResolver({})).toEqual({ launchOptions: { args: [hostResolverArg()] } });
    expect(withHostResolver({ launchOptions: { executablePath: EXE } })).toEqual({ launchOptions: { executablePath: EXE, args: [hostResolverArg()] } });
    expect(withHostResolver({ channel: 'chrome' })).toEqual({ channel: 'chrome', launchOptions: { args: [hostResolverArg()] } });
  });
});
