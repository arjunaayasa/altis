import { createHash, createHmac } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError, newId } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeBase64Url } from '@altis/crypto';
import { INSTALL_CODE_TTL_MS, ensureInstallCode, formatInstallCode } from '../src/install/code.js';
import {
  CLAIM_ATTEMPTS,
  CLAIM_KEYS_MAX,
  CLAIM_WINDOW_MS,
  INSTALL_SESSION_IDLE_MS,
  STATE_FILE_MAX_BYTES,
  claimInstall,
  installCsrfToken,
  probeHmac,
  readInstallSession,
  updateInstallWizard,
} from '../src/install/session.js';

// The claim (spec §7.7, §9.5 step 0; plan Task 10): the install code is exchanged for a claim token (the
// `altis_install` cookie); attempts are counted first in DATA_DIR/tmp/install-claims.json, 5 per 15 min per IP; the
// claim lives in DATA_DIR/tmp/install-session.json (2 h idle), and a valid code entered again moves it.

const NOW = 1_767_225_600_000;
const ORIGIN = 'https://perpus.example.sch.id';
const IP = '203.0.113.7';

let root: string;
let dataDir: string;
let code: string;

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-install-session-')));
  dataDir = path.join(root, 'altis-data');
  await fsp.mkdir(dataDir);
  code = (await ensureInstallCode(dataDir, { now: NOW, env: {} })).code;
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

async function failure(fn: () => Promise<unknown>): Promise<{ code: string; meta?: Record<string, unknown> }> {
  try {
    await fn();
  } catch (error) {
    if (isDomainError(error)) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

const claim = (over: Partial<Parameters<typeof claimInstall>[1]> = {}) =>
  claimInstall(dataDir, { code: formatInstallCode(code), ip: IP, origin: ORIGIN, now: NOW, env: {}, ...over });

async function sessionFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(path.join(dataDir, 'tmp', 'install-session.json'), 'utf8')) as Record<string, unknown>;
}

describe('claimInstall', () => {
  it('exchanges the code (as typed, any case and grouping) for a claim token; writes install-session.json (mode 600)', async () => {
    const result = await claim({ code: formatInstallCode(code).toLowerCase().replaceAll('-', ' ') });
    expect(result.claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.installState).toBeNull();
    const file = await sessionFile();
    expect(file).toEqual({
      claimHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      origin: ORIGIN,
      probeSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      csrfSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      createdAt: NOW,
      lastSeenAt: NOW,
      // 1c Task 27: the wizard's state, empty for a new install.
      wizard: { probeId: null, exposure: { exposed: false, okAt: null }, probeResults: null },
    });
    expect(JSON.stringify(file)).not.toContain(result.claimToken);
    if (process.platform !== 'win32') {
      expect((await fsp.stat(path.join(dataDir, 'tmp', 'install-session.json'))).mode & 0o777).toBe(0o600);
    }

    const session = await readInstallSession(dataDir, result.claimToken, NOW);
    expect(session).not.toBeNull();
    expect(result.csrfToken).toBe(installCsrfToken(session!));
    // csrf = HMAC(csrfSecret, 'csrf:install:' + claimHash); probe = HMAC(probeSecret, 'probe:' + nonce).
    const hmac = (key: string, msg: string) => encodeBase64Url(createHmac('sha256', key).update(msg).digest());
    expect(result.csrfToken).toBe(hmac(String(file['csrfSecret']), `csrf:install:${String(file['claimHash'])}`));
    expect(probeHmac(session!, 'n0nce')).toBe(hmac(String(file['probeSecret']), 'probe:n0nce'));
  });

  it('answers the installState of an unfinished config.json', async () => {
    await fsp.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ version: 1, installState: 'profile' }));
    expect((await claim()).installState).toBe('profile');
  });

  it('five wrong codes from one IP are 403 each; the sixth attempt, even with the right code, is 429 with retryAfterS', async () => {
    expect(CLAIM_ATTEMPTS).toBe(5);
    for (let i = 0; i < CLAIM_ATTEMPTS; i += 1) {
      expect((await failure(() => claim({ code: 'ABCDE-FGHJK-MNPQR-STVWX-YZ0123', now: NOW + i * 1000 }))).code).toBe('INSTALL_CODE_INVALID');
    }
    const refused = await failure(() => claim({ now: NOW + 10_000 }));
    expect(refused.code).toBe('AUTH_TOO_MANY_ATTEMPTS');
    // The oldest attempt leaves the 15-minute window 15 min after it was made.
    expect(refused.meta).toEqual({ retryAfterS: Math.ceil((CLAIM_WINDOW_MS - 10_000) / 1000) });
    // Another IP has its own count; the first one may try again once the window has passed.
    expect((await claim({ ip: '198.51.100.9', now: NOW + 10_000 })).claimToken).toBeTruthy();
    expect((await claim({ now: NOW + CLAIM_WINDOW_MS + 1 })).claimToken).toBeTruthy();
  });

  it('counts unknown peers (no IP) in one bucket of their own', async () => {
    for (let i = 0; i < CLAIM_ATTEMPTS; i += 1) {
      expect((await failure(() => claim({ ip: null, code: 'x' }))).code).toBe('INSTALL_CODE_INVALID');
    }
    expect((await failure(() => claim({ ip: null }))).code).toBe('AUTH_TOO_MANY_ATTEMPTS');
    expect((await claim()).claimToken).toBeTruthy();
  });

  it('a flood of IPs never makes install-claims.json too large to read back: every count holds', async () => {
    // A file just under the read limit (1 MiB), as many distinct IPs with 5 attempts each would leave it.
    const readLimit = 1024 * 1024;
    const t = NOW - 60_000;
    const entry = (i: number) => `"${createHash('sha256').update(`flood-${i}`).digest('hex')}":[${t},${t},${t},${t},${t}]`;
    const count = Math.floor((readLimit - 14) / (entry(0).length + 1));
    const flood = `{"attempts":{${Array.from({ length: count }, (_, i) => entry(i)).join(',')}}}`;
    expect(flood.length).toBeLessThanOrEqual(readLimit);
    expect(flood.length).toBeGreaterThan(readLimit - entry(0).length);
    await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', 'install-claims.json'), flood);

    // Two more IPs use up their attempts: the counts written must still be read, so the sixth attempt is refused.
    for (const ip of [IP, '198.51.100.23']) {
      for (let i = 0; i < CLAIM_ATTEMPTS; i += 1) {
        expect((await failure(() => claim({ ip, code: 'ABCDE-FGHJK-MNPQR-STVWX-YZ0123' }))).code).toBe('INSTALL_CODE_INVALID');
      }
    }
    expect((await failure(() => claim())).code).toBe('AUTH_TOO_MANY_ATTEMPTS');
    expect((await failure(() => claim({ ip: '198.51.100.23' }))).code).toBe('AUTH_TOO_MANY_ATTEMPTS');
    const written = await fsp.readFile(path.join(dataDir, 'tmp', 'install-claims.json'), 'utf8');
    expect(written.length).toBeLessThanOrEqual(readLimit);
    expect(Object.keys((JSON.parse(written) as { attempts: object }).attempts).length).toBeLessThanOrEqual(CLAIM_KEYS_MAX);
  });

  it('the most IPs the claims file keeps fit its read limit, even with the longest times', () => {
    expect(STATE_FILE_MAX_BYTES).toBe(1024 * 1024);
    const longest = `"${'f'.repeat(64)}":[${Array.from({ length: CLAIM_ATTEMPTS }, () => Number.MAX_SAFE_INTEGER).join(',')}]`;
    expect('{"attempts":{}}'.length + CLAIM_KEYS_MAX * (longest.length + 1)).toBeLessThan(STATE_FILE_MAX_BYTES);
  });

  it('a claim without Origin is 403 ORIGIN_DENIED', async () => {
    expect((await failure(() => claim({ origin: null }))).code).toBe('ORIGIN_DENIED');
  });

  it('one message for every bad code: wrong, malformed, overlong, expired, or no code file', async () => {
    for (const given of ['ABCDE-FGHJK-MNPQR-STVWX-YZ0123', 'nope', 'X'.repeat(64)]) {
      expect((await failure(() => claim({ code: given, ip: given }))).code, given).toBe('INSTALL_CODE_INVALID');
    }
    expect((await failure(() => claim({ now: NOW + INSTALL_CODE_TTL_MS + 1 }))).code).toBe('INSTALL_CODE_INVALID');
    await fsp.rm(path.join(dataDir, 'install-code.txt'));
    expect((await failure(() => claim({ ip: '192.0.2.1' }))).code).toBe('INSTALL_CODE_INVALID');
  });

  it('ALTIS_INSTALL_CODE is the code to enter when set', async () => {
    const env = { ALTIS_INSTALL_CODE: 'ABCDE-FGHJK-MNPQR-STVWX-YZ0123' };
    expect((await failure(() => claim({ env }))).code).toBe('INSTALL_CODE_INVALID');
    expect((await claim({ env, code: 'abcdefghjkmnpqrstvwxyz0123' })).claimToken).toBeTruthy();
  });

  it('a second successful claim moves the claim: the first token is no longer read', async () => {
    const first = await claim();
    const second = await claim({ now: NOW + 5000, origin: 'http://192.168.1.10:3000' });
    expect(await readInstallSession(dataDir, first.claimToken, NOW + 6000)).toBeNull();
    expect(await readInstallSession(dataDir, second.claimToken, NOW + 6000)).toMatchObject({ origin: 'http://192.168.1.10:3000' });
    expect(second.csrfToken).not.toBe(first.csrfToken);
  });
});

describe('readInstallSession', () => {
  it('null for another token, a malformed one, or no session file', async () => {
    expect(await readInstallSession(dataDir, 'x'.repeat(43), NOW)).toBeNull();
    const { claimToken } = await claim();
    // Another last character (one of 16 possible ones: 'A' itself 1 time in 16).
    const other = `${claimToken.slice(0, 42)}${claimToken.endsWith('A') ? 'E' : 'A'}`;
    expect(await readInstallSession(dataDir, other, NOW)).toBeNull();
    expect(await readInstallSession(dataDir, '', NOW)).toBeNull();
    expect(await readInstallSession(dataDir, 'not a token', NOW)).toBeNull();
  });

  it('expires after 2 h idle; each read refreshes lastSeenAt at most once a minute', async () => {
    const { claimToken } = await claim();
    expect(await readInstallSession(dataDir, claimToken, NOW + 30_000)).toMatchObject({ lastSeenAt: NOW });
    expect((await sessionFile())['lastSeenAt']).toBe(NOW);
    expect(await readInstallSession(dataDir, claimToken, NOW + 60_000)).toMatchObject({ lastSeenAt: NOW + 60_000 });
    expect((await sessionFile())['lastSeenAt']).toBe(NOW + 60_000);

    const idleFrom = NOW + 60_000;
    expect(await readInstallSession(dataDir, claimToken, idleFrom + INSTALL_SESSION_IDLE_MS)).not.toBeNull();
    const fresh = await claim({ now: NOW + 100_000 });
    expect(await readInstallSession(dataDir, fresh.claimToken, NOW + 100_000 + INSTALL_SESSION_IDLE_MS + 1)).toBeNull();
  });

  it('idle 2 h + 1 ms: null', async () => {
    const { claimToken } = await claim();
    expect(await readInstallSession(dataDir, claimToken, NOW + INSTALL_SESSION_IDLE_MS + 1)).toBeNull();
  });
});

describe('the wizard state (1c Task 27)', () => {
  const RESULTS = {
    polling: true,
    sse: false,
    methods: { put: true, patch: false, delete: true },
    chunkBytes: 1_048_576,
    xff: { cleanXff: ['198.51.100.7'], forgedXff: ['203.0.113.77', '198.51.100.7'], forgedDerived: '198.51.100.7' },
  };

  it('updateInstallWizard changes the state of the current claim, kept by reads and their lastSeenAt refresh', async () => {
    const { claimToken } = await claim();
    const s = (await readInstallSession(dataDir, claimToken, NOW))!;
    const probeId = newId(NOW);
    const updated = await updateInstallWizard(dataDir, s.claimHash, NOW + 1000, (w) => ({ ...w, probeId, probeResults: RESULTS }));
    expect(updated?.wizard).toEqual({ probeId, exposure: { exposed: false, okAt: null }, probeResults: RESULTS });
    expect(updated?.lastSeenAt).toBe(NOW + 1000);
    // A read that refreshes lastSeenAt keeps the wizard state.
    expect((await readInstallSession(dataDir, claimToken, NOW + 120_000))?.wizard.probeResults).toEqual(RESULTS);
    expect((await sessionFile())['wizard']).toEqual({ probeId, exposure: { exposed: false, okAt: null }, probeResults: RESULTS });
  });

  it('updateInstallWizard writes nothing once the claim moved or went idle (null)', async () => {
    const first = await claim();
    const hash = (await readInstallSession(dataDir, first.claimToken, NOW))!.claimHash;
    expect(await updateInstallWizard(dataDir, hash, NOW + INSTALL_SESSION_IDLE_MS + 1, (w) => w)).toBeNull();
    await claim({ now: NOW + 1000 });
    expect(await updateInstallWizard(dataDir, hash, NOW + 2000, (w) => ({ ...w, exposure: { exposed: true, okAt: null } }))).toBeNull();
    expect((await sessionFile())['wizard']).toEqual({ probeId: null, exposure: { exposed: false, okAt: null }, probeResults: null });
  });

  it('a claim that moves keeps the probe file and the results, not the exposure verdict', async () => {
    const first = await claim();
    const hash = (await readInstallSession(dataDir, first.claimToken, NOW))!.claimHash;
    const probeId = newId(NOW);
    await updateInstallWizard(dataDir, hash, NOW, () => ({ probeId, exposure: { exposed: false, okAt: NOW }, probeResults: RESULTS }));
    const second = await claim({ now: NOW + 5000 });
    expect((await readInstallSession(dataDir, second.claimToken, NOW + 5000))?.wizard).toEqual({
      probeId,
      exposure: { exposed: false, okAt: null },
      probeResults: RESULTS,
    });
  });

  it('a malformed wizard state reads as empty, the claim itself stays valid', async () => {
    const { claimToken } = await claim();
    const file = await sessionFile();
    await fsp.writeFile(
      path.join(dataDir, 'tmp', 'install-session.json'),
      JSON.stringify({ ...file, wizard: { probeId: '../x', exposure: { exposed: 'yes', okAt: -1 }, probeResults: { polling: 1 } } }),
    );
    expect((await readInstallSession(dataDir, claimToken, NOW))?.wizard).toEqual({ probeId: null, exposure: { exposed: false, okAt: null }, probeResults: null });
  });
});
