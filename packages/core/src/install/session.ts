import { dataPath, readBytes, readJsonWithBak, withFileLock, writeBytesAtomic, type DataPath, type Env, type HeldFileLock } from '@altis/platform';
import { DomainError, isDomainError, isUlid } from '@altis/shared';
import { ProbeResultBody } from '@altis/shared/api/diagnostics';
import { hmacB64u, randomToken, safeEqual, sha256hex } from '../crypto/tokens.js';
import { currentInstallCode, ensureInstallTmp, installLockPath, normalizeInstallCode } from './code.js';

// The install claim (spec §7.7, §9.5 step 0; decision C19). Before the install there is no database, so the claim's
// state lives in DATA_DIR files, guarded by DATA_DIR/tmp/install-session.lock (P6: every process sees the same):
//
// - tmp/install-claims.json: the attempts of the last 15 minutes per `sha256hex(ip ?? 'none')` (5 at most), for the
//   5 000 IPs seen last (so the file always reads back). Every attempt is counted first, before its Origin and its
//   code are looked at; a refused one (429) is not counted.
// - tmp/install-session.json `{claimHash, origin, probeSecret, csrfSecret, createdAt, lastSeenAt}` (mode 600): the one
//   current claim. Its token is only in the browser's `altis_install` cookie; the file keeps its SHA-256. A valid code
//   entered again replaces the file, which moves the claim ("memindahkan klaim"): the earlier token stops working.
// - The session expires after 2 h without a request; reading it refreshes `lastSeenAt` at most once a minute, under
//   the lock and only while the file still holds the same claim (a refresh never brings back a claim that moved).
// - The CSRF token of the wizard is `hmacB64u(csrfSecret, 'csrf:install:' + claimHash)`; the base URL probe answers
//   `hmacB64u(probeSecret, 'probe:' + nonce)`, the same from every process (§9.5 step 1).
// - 1c Task 27: the session also keeps the wizard's own state ({@link InstallWizardState}), so that whichever process
//   answers the next step sees it: the exposure probe file's id, the exposure verdict (an exposed installation blocks
//   `config`, §9.5 "Bila ada yang terambil → blokir"), and the browser test's results, which stay here until the seeds
//   write them to `system.probe`. A claim that moves keeps the probe file and the results (facts about this
//   installation) but not the exposure verdict: the new holder runs the exposure test again.

/** A claim is dropped after this long without a request (spec §7.7: "kedaluwarsa setelah 2 jam idle"). */
export const INSTALL_SESSION_IDLE_MS = 7_200_000;
/** At most this many claim attempts per IP in {@link CLAIM_WINDOW_MS} (spec §7.7). */
export const CLAIM_ATTEMPTS = 5;
/** The window of {@link CLAIM_ATTEMPTS}: 15 minutes. */
export const CLAIM_WINDOW_MS = 900_000;

/** `lastSeenAt` is written again at most this often. */
const TOUCH_INTERVAL_MS = 60_000;
/**
 * The claim file keeps at most this many IPs (the ones seen last); an IP beyond it simply starts over. Sized so that
 * the file, full, still reads back under {@link STATE_FILE_MAX_BYTES}: an IP takes at most 154 bytes (its 64-hex key
 * and 5 times of up to 16 digits), so 5 000 take about 770 KB. A file over the limit would read as unusable and reset
 * every count, the flooder's included.
 */
export const CLAIM_KEYS_MAX = 5_000;
/** The install state files (install-claims.json, install-session.json) are read up to this size; larger is unusable. */
export const STATE_FILE_MAX_BYTES = 1024 * 1024;
/** A claim token: randomToken(32). */
const CLAIM_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** What the wizard keeps between its steps (1c Task 27), in the install session. */
export interface InstallWizardState {
  /** The exposure probe file `DATA_DIR/tmp/<probeId>` (a ULID), once `GET checks` made one. */
  probeId: string | null;
  /** The last exposure test: `exposed` blocks `config`; `okAt` is when a test found nothing (null: none did). */
  exposure: { exposed: boolean; okAt: number | null };
  /** The browser test's results sent with `config`, until the seeds after the migrations write them. */
  probeResults: ProbeResultBody | null;
}

/** The wizard state of a new install session. */
export const EMPTY_WIZARD_STATE: InstallWizardState = Object.freeze({
  probeId: null,
  exposure: Object.freeze({ exposed: false, okAt: null }),
  probeResults: null,
}) as InstallWizardState;

/** The current claim, as tmp/install-session.json holds it. */
export interface InstallSession {
  /** `sha256hex(claimToken)`. */
  claimHash: string;
  /** The `Origin` of the claim request: every later non-GET wizard request must come from it. */
  origin: string;
  /** The key of the base URL probe's HMAC ({@link probeHmac}). */
  probeSecret: string;
  /** The key of the wizard's CSRF token ({@link installCsrfToken}). */
  csrfSecret: string;
  createdAt: number;
  lastSeenAt: number;
  /** 1c Task 27: the wizard's state ({@link EMPTY_WIZARD_STATE} in a session written before it). */
  wizard: InstallWizardState;
}

export interface ClaimResult {
  /** For the `altis_install` cookie only; never stored. */
  claimToken: string;
  /** The `X-CSRF-Token` of the wizard's non-GET requests. */
  csrfToken: string;
  /** config.json's `installState` when an unfinished install exists (the wizard resumes there), else null. */
  installState: string | null;
}

const sessionPath = (dataDir: string): DataPath => dataPath(dataDir, 'tmp', 'install-session.json');
const claimsPath = (dataDir: string): DataPath => dataPath(dataDir, 'tmp', 'install-claims.json');

/** The CSRF token of the wizard's non-GET requests for the claim `s`. */
export function installCsrfToken(s: InstallSession): string {
  return hmacB64u(s.csrfSecret, `csrf:install:${s.claimHash}`);
}

/** The base URL probe's answer for `nonce` (§9.5 step 1): the same in every process, keyed by the claim's secret. */
export function probeHmac(s: InstallSession, nonce: string): string {
  return hmacB64u(s.probeSecret, `probe:${nonce}`);
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A small JSON state file, or null when it is missing or unusable (not JSON, a folder, too large). */
async function readState(file: DataPath): Promise<unknown> {
  let bytes: Buffer | null;
  try {
    bytes = await readBytes(file, STATE_FILE_MAX_BYTES);
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') return null;
    throw error;
  }
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/** The wizard state as the session file holds it; what is missing or unusable reads as empty. */
function wizardOf(raw: unknown): InstallWizardState {
  if (typeof raw !== 'object' || raw === null) return EMPTY_WIZARD_STATE;
  const { probeId, exposure, probeResults } = raw as Record<string, unknown>;
  const e = typeof exposure === 'object' && exposure !== null ? (exposure as Record<string, unknown>) : {};
  const results = ProbeResultBody.safeParse(probeResults);
  return {
    probeId: typeof probeId === 'string' && isUlid(probeId) ? probeId : null,
    exposure: { exposed: e['exposed'] === true, okAt: isTime(e['okAt']) ? e['okAt'] : null },
    probeResults: results.success ? results.data : null,
  };
}

/** tmp/install-session.json, or null when there is none or it is unusable. */
async function readSessionFile(dataDir: string): Promise<InstallSession | null> {
  const raw = await readState(sessionPath(dataDir));
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const { claimHash, origin, probeSecret, csrfSecret, createdAt, lastSeenAt } = r;
  if (typeof claimHash !== 'string' || !SHA256_HEX.test(claimHash)) return null;
  if (typeof origin !== 'string' || origin === '' || origin.length > 2048) return null;
  if (typeof probeSecret !== 'string' || !SECRET.test(probeSecret)) return null;
  if (typeof csrfSecret !== 'string' || !SECRET.test(csrfSecret)) return null;
  if (!isTime(createdAt) || !isTime(lastSeenAt)) return null;
  return { claimHash, origin, probeSecret, csrfSecret, createdAt, lastSeenAt, wizard: wizardOf(r['wizard']) };
}

async function writeSessionFile(dataDir: string, s: InstallSession, lock: HeldFileLock): Promise<void> {
  lock.assertHeld();
  await writeBytesAtomic(sessionPath(dataDir), JSON.stringify(s), 0o600);
}

/** The attempts per IP hash still inside the window at `now` (a time from the future counts as now). */
function liveAttempts(raw: unknown, now: number): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const attempts = typeof raw === 'object' && raw !== null ? (raw as { attempts?: unknown }).attempts : undefined;
  if (typeof attempts !== 'object' || attempts === null) return out;
  for (const [key, list] of Object.entries(attempts)) {
    if (!SHA256_HEX.test(key) || !Array.isArray(list)) continue;
    const times = list
      .filter(isTime)
      .map((t) => Math.min(t, now))
      .filter((t) => now - t < CLAIM_WINDOW_MS)
      .sort((a, b) => a - b)
      .slice(-CLAIM_ATTEMPTS);
    if (times.length > 0) out.set(key, times);
  }
  return out;
}

/**
 * Counts one claim attempt of `ip` at `now` in tmp/install-claims.json (the caller holds the lock).
 *
 * @throws DomainError `AUTH_TOO_MANY_ATTEMPTS` (`meta.retryAfterS`: until the oldest counted attempt leaves the window)
 *   when the IP made {@link CLAIM_ATTEMPTS} attempts in the last 15 minutes; this attempt is then not counted
 */
async function countAttempt(dataDir: string, ip: string | null, now: number, lock: HeldFileLock): Promise<void> {
  const file = claimsPath(dataDir);
  const live = liveAttempts(await readState(file), now);
  const key = sha256hex(ip ?? 'none');
  const mine = live.get(key) ?? [];
  if (mine.length >= CLAIM_ATTEMPTS) {
    const retryAfterS = Math.max(1, Math.ceil((mine[0]! + CLAIM_WINDOW_MS - now) / 1000));
    throw new DomainError('AUTH_TOO_MANY_ATTEMPTS', { meta: { retryAfterS } });
  }
  live.delete(key);
  live.set(key, [...mine, now]); // last in insertion order: the most recently seen
  const kept = [...live].slice(-CLAIM_KEYS_MAX);
  lock.assertHeld();
  await writeBytesAtomic(file, JSON.stringify({ attempts: Object.fromEntries(kept) }), 0o600);
}

/** config.json's installState as written (no environment applied), or null without a usable config.json. */
async function configInstallState(dataDir: string): Promise<string | null> {
  try {
    const state = await readJsonWithBak(dataPath(dataDir, 'root', 'config.json'), (raw) => {
      const value = typeof raw === 'object' && raw !== null ? (raw as { installState?: unknown }).installState : undefined;
      return typeof value === 'string' ? value : null;
    });
    return state ?? null;
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') return null;
    throw error;
  }
}

/**
 * Exchanges the install code for a claim (spec §7.7), in this order:
 *
 * 1. the attempt is counted for `ip` (null: one shared bucket) → 429 `AUTH_TOO_MANY_ATTEMPTS` after 5 in 15 minutes;
 * 2. no `origin` → `ORIGIN_DENIED`;
 * 3. `code` (as typed: normalizeInstallCode) must be the current code (ALTIS_INSTALL_CODE, or install-code.txt while
 *    it is at most 24 h old) → otherwise 403 `INSTALL_CODE_INVALID`, one message for every cause;
 * 4. tmp/install-session.json is replaced by the new claim (any earlier claim stops working).
 *
 * @throws DomainError `AUTH_TOO_MANY_ATTEMPTS`, `ORIGIN_DENIED`, `INSTALL_CODE_INVALID`; `INVALID_CONFIG` for a
 *   malformed ALTIS_INSTALL_CODE; `STATE_CORRUPT` (`datadir_missing`, a lock timeout); `DISK_QUOTA`
 */
export async function claimInstall(
  dataDir: string,
  o: { code: string; ip: string | null; origin: string | null; now: number; env: Env },
): Promise<ClaimResult> {
  await ensureInstallTmp(dataDir);
  const session = await withFileLock(installLockPath(dataDir), async (lock) => {
    await countAttempt(dataDir, o.ip, o.now, lock);
    if (o.origin === null || o.origin === '') throw new DomainError('ORIGIN_DENIED');
    const expected = await currentInstallCode(dataDir, { now: o.now, env: o.env });
    const given = normalizeInstallCode(o.code);
    if (expected === null || given === null || !safeEqual(given, expected)) throw new DomainError('INSTALL_CODE_INVALID');

    const claimToken = randomToken(32);
    // 1c Task 27: a claim that moves keeps the probe file and the browser test's results (see the top of this file).
    const before = (await readSessionFile(dataDir))?.wizard ?? EMPTY_WIZARD_STATE;
    const s: InstallSession = {
      claimHash: sha256hex(claimToken),
      origin: o.origin,
      probeSecret: randomToken(32),
      csrfSecret: randomToken(32),
      createdAt: o.now,
      lastSeenAt: o.now,
      wizard: { probeId: before.probeId, exposure: { exposed: false, okAt: null }, probeResults: before.probeResults },
    };
    await writeSessionFile(dataDir, s, lock);
    return { s, claimToken };
  });
  return { claimToken: session.claimToken, csrfToken: installCsrfToken(session.s), installState: await configInstallState(dataDir) };
}

/**
 * The claim `claimToken` (the `altis_install` cookie) at `now`, or null: no session file, another claim (moved), a
 * malformed token, or idle for more than 2 h. Refreshes `lastSeenAt` when it is a minute old or more (see the top of
 * this file); a refresh that cannot take the lock at once is skipped (the next request tries again).
 *
 * @throws a file system error other than a missing or unusable file
 */
export async function readInstallSession(dataDir: string, claimToken: string, now: number): Promise<InstallSession | null> {
  if (typeof claimToken !== 'string' || !CLAIM_TOKEN.test(claimToken)) return null;
  const s = await readSessionFile(dataDir);
  const hash = sha256hex(claimToken);
  if (s === null || !safeEqual(hash, s.claimHash)) return null;
  if (now - s.lastSeenAt > INSTALL_SESSION_IDLE_MS) return null;
  if (now - s.lastSeenAt < TOUCH_INTERVAL_MS) return s;
  try {
    return await withFileLock(
      installLockPath(dataDir),
      async (lock) => {
        const again = await readSessionFile(dataDir);
        if (again === null || !safeEqual(hash, again.claimHash)) return null; // moved meanwhile
        if (now - again.lastSeenAt > INSTALL_SESSION_IDLE_MS) return null;
        if (now - again.lastSeenAt < TOUCH_INTERVAL_MS) return again;
        const touched = { ...again, lastSeenAt: now };
        await writeSessionFile(dataDir, touched, lock);
        return touched;
      },
      { waitMs: 2000 },
    );
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT' && error.meta?.['reason'] === 'lock_timeout') return s;
    throw error;
  }
}

/**
 * The session of the claim `claimHash` as tmp/install-session.json holds it now, or null when the claim moved or went
 * idle. A wizard step that decides on its wizard state under install-run.lock reads it again with this: the claim the
 * route chain checked was read before the step took the lock, and another step may have changed it meanwhile.
 *
 * @throws a file system error other than a missing or unusable file
 */
export async function currentInstallSession(dataDir: string, claimHash: string, now: number): Promise<InstallSession | null> {
  const s = await readSessionFile(dataDir);
  if (s === null || !safeEqual(s.claimHash, claimHash) || now - s.lastSeenAt > INSTALL_SESSION_IDLE_MS) return null;
  return s;
}

/**
 * Changes the wizard state of the claim `claimHash` (1c Task 27) under the lock: the file is read again, and nothing
 * is written when the claim moved meanwhile or went idle (null comes back; the caller answers INSTALL_CLAIM_REQUIRED).
 * `lastSeenAt` becomes `now`.
 *
 * @returns the session as written, or null
 * @throws a file system or lock error as it is
 */
export async function updateInstallWizard(
  dataDir: string,
  claimHash: string,
  now: number,
  mutate: (w: InstallWizardState) => InstallWizardState,
): Promise<InstallSession | null> {
  return withFileLock(installLockPath(dataDir), async (lock) => {
    const s = await readSessionFile(dataDir);
    if (s === null || !safeEqual(s.claimHash, claimHash) || now - s.lastSeenAt > INSTALL_SESSION_IDLE_MS) return null;
    const next: InstallSession = { ...s, lastSeenAt: Math.max(now, s.lastSeenAt), wizard: mutate(s.wizard) };
    await writeSessionFile(dataDir, next, lock);
    return next;
  });
}
