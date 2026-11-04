import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { withTx } from '@altis/db';
import { appPath, dataPath, readAppFile, readBytes, realPathOf, removeFile, writeBytesAtomic, type AppFileName } from '@altis/platform';
import { isUlid, newId } from '@altis/shared';
import { EXPOSURE_READ_MAX_BYTES } from '@altis/shared/api/install';
import { z } from 'zod';
import type { JobContext, JobHandler, JobOutcome } from '../jobs/types.js';
import { notify } from '../notifications/service.js';
import { scheduleWindowSchema } from '../scheduler/registry.js';
import { writeSettings } from '../settings/service.js';

// The daily exposure check (spec §11 "uji paparan DATA_DIR harian (banner merah bila gagal)"; decision C21; preflight
// S26, B5). A web server whose document root holds DATA_DIR or the app folder serves config.json, backups and the
// database to anyone. The job proves it the way an attacker would: it fetches files it knows the bytes of through the
// installation's own base URL.
//
// - The files: a probe file it writes itself (`DATA_DIR/tmp/<ulid>`, 32 random bytes as hex, world-readable so that a
//   web server running as another user could serve it), `app.js` and `altis-data-dir.txt` of the app folder (when
//   present).
// - The candidates (C21): every path suffix of each file's real path, from the file up to `$HOME` (exclusive), or up
//   to the file system root, at most 8 levels: `/home/u/altis-data/tmp/x` with home `/home/u` gives `/x`, `/tmp/x`
//   and `/altis-data/tmp/x`. Each is fetched as `baseUrl + suffix` over node:http(s) (P18): 5 s, at most 64 KiB read,
//   no redirect followed.
// - A 200 whose body is the file's bytes (its first 64 KiB for a larger file such as app.js: the read stops there)
//   means exposure: `system.exposure = {at, ok: false, url}` and one `exposure_failed` notification to the holders of
//   `system.diagnostics.read` (the dashboard's red alert reads the setting). The job stops at the first such URL.
// - Sliced (S26, P9): candidates are fetched one after another while the slice's budget allows one more fetch (5 s);
//   the rest go into `continueWith` (the probe id and the next index), so whichever process claims the job next goes
//   on with the same probe file. A slice whose budget is below one fetch (piggyback's 2 s) still fetches one
//   candidate, its timeout cut to the budget left (at least {@link EXPOSURE_MIN_FETCH_MS}), so every slice advances and
//   a host whose only runner is piggyback ends the job too. After the last candidate: `{at, ok: true, url: null}`.
//   The probe file is removed when the job ends.

/** One fetch's limit (spec: 5 s), and the least budget a slice must have left to start a second one. */
export const EXPOSURE_FETCH_TIMEOUT_MS = 5000;
/** The shortest timeout of a slice's one fetch when its budget is below {@link EXPOSURE_FETCH_TIMEOUT_MS}. */
export const EXPOSURE_MIN_FETCH_MS = 500;
/** What a short slice keeps back from its budget for the rest of its work (the heartbeat, the checkpoint). */
const SLICE_MARGIN_MS = 250;
/** At most this much of a response is read (64 KiB, the wizard's browser test reads as much). */
export const EXPOSURE_MAX_BYTES = EXPOSURE_READ_MAX_BYTES;
/** Suffixes per file at most (decision C21: "at most 8 levels"). */
export const EXPOSURE_MAX_LEVELS = 8;
/** `system.exposure.url` holds at most this many characters. */
const URL_SETTING_MAX = 191;
/** app.js is read up to this size for its prefix (a release's bootloader is far smaller). */
const APP_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** Where the notification leads (the admin's Diagnostik screen, Task 32). */
const DIAGNOSTICS_PAGE = '/admin/diagnostics';

export type ExposureKind = 'probe' | 'app' | 'pointer';

/** One URL path to fetch below the base URL, and the file it would serve. */
export interface ExposureCandidate {
  kind: ExposureKind;
  /** `/seg/…/file`, each segment percent-encoded. */
  path: string;
}

/** What a fetch saw: the status (0 when no answer came: error, timeout, bad URL) and up to 64 KiB of a 200's body. */
export interface ExposureResponse {
  status: number;
  body: Buffer;
}

/** How the job fetches a URL within `o.timeoutMs` (tests inject their own). Never rejects. */
export type ExposureFetch = (url: string, o: { timeoutMs: number }) => Promise<ExposureResponse>;

const SEPARATORS = /[\\/]+/;
const DRIVE = /^[A-Za-z]:/;

/**
 * The URL path suffixes of `file` (see the top of this file): from the file's own name upwards, stopping below `home`
 * when `file` lies inside it, else at the root (a Windows drive is never a segment), and after
 * {@link EXPOSURE_MAX_LEVELS}. Both `/` and `\` separate; a path with a drive letter compares case-insensitively.
 */
export function pathSuffixes(file: string, home: string): string[] {
  const windows = DRIVE.test(file);
  const parts = file.split(SEPARATORS).filter((s) => s !== '');
  const homeParts = home.split(SEPARATORS).filter((s) => s !== '');
  const same = (a: string, b: string): boolean => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  let start = windows ? 1 : 0;
  if (homeParts.length > 0 && homeParts.length < parts.length && homeParts.every((seg, i) => same(seg, parts[i]!))) {
    start = homeParts.length;
  }
  const levels = Math.min(parts.length - start, EXPOSURE_MAX_LEVELS);
  const out: string[] = [];
  for (let k = 1; k <= levels; k += 1) out.push(`/${parts.slice(parts.length - k).map(encodeURIComponent).join('/')}`);
  return out;
}

/**
 * The candidates of the probe file `<dataDir>/tmp/<probeId>`, of `<appRoot>/app.js` and of
 * `<appRoot>/altis-data-dir.txt`, in that order (decision C21). The folders are taken as given: pass real paths (the
 * job resolves each file's real path itself).
 */
export function exposureCandidates(o: { dataDir: string; appRoot: string; home: string; probeId: string }): ExposureCandidate[] {
  const files: [ExposureKind, string][] = [
    ['probe', `${o.dataDir}/tmp/${o.probeId}`],
    ['app', `${o.appRoot}/app.js`],
    ['pointer', `${o.appRoot}/altis-data-dir.txt`],
  ];
  return files.flatMap(([kind, file]) => pathSuffixes(file, o.home).map((path) => ({ kind, path })));
}

/**
 * GET `url` over node:http or node:https (P18): no redirect followed, at most `maxBytes` of a 200's body read (the
 * connection is closed then), the whole exchange bounded by `timeoutMs`. Never rejects: no answer (an error, the
 * timeout, a URL that is not http(s)) is status 0.
 */
export function fetchBounded(url: string, o: { timeoutMs?: number; maxBytes?: number } = {}): Promise<ExposureResponse> {
  const timeoutMs = o.timeoutMs ?? EXPOSURE_FETCH_TIMEOUT_MS;
  const maxBytes = o.maxBytes ?? EXPOSURE_MAX_BYTES;
  const none: ExposureResponse = { status: 0, body: Buffer.alloc(0) };
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve(none);
  }
  const transport = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
  if (transport === null) return Promise.resolve(none);
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    let req: http.ClientRequest | undefined;
    const finish = (r: ExposureResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req?.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish(none), timeoutMs);
    try {
      req = transport.request(
        target,
        { method: 'GET', agent: false, headers: { 'User-Agent': 'ALTIS exposure check', Accept: '*/*' } },
        (res) => {
          res.on('error', () => finish(none));
          const status = res.statusCode ?? 0;
          if (status !== 200) {
            res.resume();
            finish({ status, body: Buffer.alloc(0) });
            return;
          }
          res.on('data', (chunk: Buffer) => {
            const take = chunk.subarray(0, maxBytes - size);
            chunks.push(take);
            size += take.length;
            if (size >= maxBytes) finish({ status, body: Buffer.concat(chunks) });
          });
          res.on('end', () => finish({ status, body: Buffer.concat(chunks) }));
        },
      );
    } catch {
      finish(none);
      return;
    }
    req.on('error', () => finish(none));
    req.end();
  });
}

/** The job's payload: the scheduler's window, then the checkpoint (the probe file's id, the next candidate). */
export const exposurePayload = scheduleWindowSchema.extend({
  probeId: z.string().refine(isUlid).optional(),
  next: z.int().min(0).max(1000).optional(),
});

export type ExposurePayload = z.infer<typeof exposurePayload>;

export interface ExposureJobDeps {
  dataDir: string;
  appRoot: string;
  /** The folder the suffixes stop below (default the process's home, '' when unknown: up to the root). */
  home?: string;
  /** config.json's baseUrl; null without a config (the job then records nothing). */
  baseUrl(): string | null;
  /** Default {@link fetchBounded}. */
  fetch?: ExposureFetch;
}

/** A file whose bytes a candidate must return: its kind, its real path and the SHA-256 of its first 64 KiB. */
interface Target {
  kind: ExposureKind;
  realPath: string;
  length: number;
  sha256: string;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function targetOf(kind: ExposureKind, realPath: string | null, bytes: Buffer | null): Target | null {
  if (realPath === null || bytes === null || bytes.length === 0) return null;
  const prefix = bytes.subarray(0, EXPOSURE_MAX_BYTES);
  return { kind, realPath, length: prefix.length, sha256: sha256(prefix) };
}

function homeDir(): string {
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

/** The probe file of `probeId`, written with new random content when it is not there (a first slice, or it vanished). */
async function ensureProbe(dataDir: string, probeId: string): Promise<Buffer> {
  const file = dataPath(dataDir, 'tmp', probeId);
  const existing = await readBytes(file, 1024);
  if (existing !== null && existing.length > 0) return existing;
  const content = Buffer.from(randomBytes(32).toString('hex'), 'utf8');
  await writeBytesAtomic(file, content, 0o644);
  return content;
}

/** The app folder's file `name` when it exists. */
async function appTarget(kind: ExposureKind, appRoot: string, name: AppFileName): Promise<Target | null> {
  const p = appPath(appRoot, name);
  try {
    return targetOf(kind, await realPathOf(p), await readAppFile(p, APP_FILE_MAX_BYTES));
  } catch {
    return null; // unreadable, a folder, too large: nothing a web server would serve as this file either
  }
}

/** A URL short enough for `system.exposure.url`. */
function storedUrl(url: string): string {
  return url.length <= URL_SETTING_MAX ? url : `${url.slice(0, URL_SETTING_MAX - 1)}…`;
}

/** The candidates of this slice, in a fixed order (the checkpoint's `next` indexes it). */
async function candidatesOf(deps: ExposureJobDeps, probeId: string, home: string): Promise<{ target: Target; path: string }[]> {
  const probeBytes = await ensureProbe(deps.dataDir, probeId);
  const probe = targetOf('probe', await realPathOf(dataPath(deps.dataDir, 'tmp', probeId)), probeBytes);
  const targets = [probe, await appTarget('app', deps.appRoot, 'app.js'), await appTarget('pointer', deps.appRoot, 'altis-data-dir.txt')];
  const realHome = home === '' ? '' : ((await realPathOf(home).catch(() => null)) ?? home);
  return targets.flatMap((t) => (t === null ? [] : pathSuffixes(t.realPath, realHome).map((path) => ({ target: t, path }))));
}

async function conclude(ctx: JobContext, deps: ExposureJobDeps, probeId: string, url: string | null): Promise<JobOutcome<ExposurePayload>> {
  const now = ctx.now();
  const stored = url === null ? null : storedUrl(url);
  await withTx(ctx.handle, async (trx) => {
    await writeSettings(trx, { 'system.exposure': { at: now, ok: url === null, url: stored } }, { keyring: [], now, actorId: null });
    if (stored !== null) {
      await notify(
        trx,
        {
          audience: { permission: 'system.diagnostics.read' },
          type: 'exposure.failed',
          titleKey: 'notification.exposure_failed.title',
          params: { url: stored },
          link: DIAGNOSTICS_PAGE,
        },
        now,
      );
    }
  });
  await removeFile(dataPath(deps.dataDir, 'tmp', probeId));
  if (stored !== null) ctx.log.error('diagnostics: DATA_DIR or the app folder is served by the web server', { url: stored });
  return { done: true };
}

/** The daily job `diagnostics.exposure` (schedule `diagnostics.exposure`; see the top of this file). */
export function exposureJob(deps: ExposureJobDeps): JobHandler<ExposurePayload> {
  const fetch: ExposureFetch = deps.fetch ?? ((url, o) => fetchBounded(url, o));
  return {
    type: 'diagnostics.exposure',
    permission: 'system.diagnostics.manage',
    retryable: 'api',
    payload: exposurePayload,
    async run(ctx, p) {
      const base = deps.baseUrl();
      if (base === null || base === '') {
        ctx.log.info('diagnostics: no baseUrl, the exposure check is skipped');
        return { done: true };
      }
      const root = base.replace(/\/+$/, '');
      const probeId = p.probeId ?? newId();
      const candidates = await candidatesOf(deps, probeId, deps.home ?? homeDir());
      let next = p.next ?? 0;
      const first = next;
      while (next < candidates.length) {
        const left = ctx.budgetLeftMs();
        // A full fetch while the budget allows one; else only the slice's first, cut to what is left (see the top).
        if (left < EXPOSURE_FETCH_TIMEOUT_MS && next > first) break;
        const timeoutMs = left >= EXPOSURE_FETCH_TIMEOUT_MS ? EXPOSURE_FETCH_TIMEOUT_MS : Math.max(EXPOSURE_MIN_FETCH_MS, left - SLICE_MARGIN_MS);
        const { target, path } = candidates[next]!;
        const url = `${root}${path}`;
        const res = await fetch(url, { timeoutMs });
        next += 1;
        if (res.status === 200 && res.body.length === target.length && sha256(res.body) === target.sha256) {
          return conclude(ctx, deps, probeId, url);
        }
        await ctx.heartbeat({ progress: Math.floor((100 * next) / candidates.length) });
      }
      if (next < candidates.length) {
        return {
          continueWith: { windowStart: p.windowStart, windowEnd: p.windowEnd, probeId, next },
          progress: Math.floor((100 * next) / candidates.length),
        };
      }
      return conclude(ctx, deps, probeId, null);
    },
  };
}
