import { configMtimeMs, type Env } from '@altis/platform';
import { isDomainError } from '@altis/shared';
import { loadConfig, type Config } from '../config.js';
import type { LogFields, Logger } from '../logger.js';
import { loggableError } from '../safe-error.js';

// The config part of the fence of spec §9.3 (decision D34; the release-version and data-epoch parts come with 1c
// and 1d). Every process of an install (up to six Passenger workers) serves from its own copy of config.json, and a
// write by another process (`PUT system/config`, the CLI's `config:set`) must reach it without a restart: step 4 of
// the chain calls check() on every request, which looks at the file's mtime at most once per `intervalMs` (2 s) and
// loads the file again (loadConfig, environment overrides applied) when the mtime changed.
//
// - The mtime the current config came from is not known when the fence is created (the caller loaded `initial`
//   itself), so the first look loads the file once more.
// - A file that does not load (invalid, unreadable, gone) keeps the config in use and is tried again on the next look,
//   even with the same mtime (a coarse file system, a write read half-way); the failure is logged once per mtime, so
//   a broken file is reported once, not on every request.
// - `onChange(next, prev)` runs when the loaded config differs from the one in use (a touched but unchanged file
//   changes nothing). A failing onChange is logged; the new config stays current.
// - Concurrent checks share one look. The fence keeps no timer: an idle process looks at nothing.
// - reset(config): a writer in this process (PUT system/config, the cron-token rotation; D42) applied what it wrote
//   itself. That config becomes the one in use without an onChange; a look that began before the reset is discarded
//   (it may have read the file as it was before the write), and the next look loads the file again whatever its
//   mtime, so the written file brings no onChange and a later change by anyone still does.

export interface ConfigFence {
  /** The config in use: `initial` until a check loads a changed file. */
  current(): Config;
  /** Looks at config.json when `intervalMs` passed since the last look, and loads it when it changed. Never rejects. */
  check(): Promise<void>;
  /**
   * Makes `config` the one in use, without calling onChange: the config this process just wrote to config.json and
   * applied itself (environment overrides included). A look already running is discarded when it ends; the next look
   * loads the file again.
   */
  reset(config: Config): void;
}

export interface ConfigFenceOptions {
  dataDir: string;
  /** The environment whose overrides loadConfig applies (as at boot). */
  env: Env;
  /** The config the caller loaded and serves from. */
  initial: Config;
  /** The shortest time between two looks at the file (default 2000 ms). */
  intervalMs?: number;
  /** Epoch ms (default `Date.now`). */
  clock?: () => number;
  /** How the file's mtime is read (default `configMtimeMs`; tests spy on it). */
  mtime?: typeof configMtimeMs;
  /** Called with the new config and the one it replaces. */
  onChange(next: Config, prev: Config): void;
  log: Logger;
}

const DEFAULT_INTERVAL_MS = 2000;

/** What the log may say about an error: the code and detail of a DomainError (config errors name paths, never values). */
function errorFields(error: unknown): LogFields {
  if (isDomainError(error)) return { code: error.code, detail: error.detail };
  return { error: loggableError(error) };
}

/** Two configs are the same when their JSON texts are (both come out of the same schema, in the same key order). */
function sameConfig(a: Config, b: Config): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The config fence of one process (see the top of this file).
 *
 * @throws TypeError for an `intervalMs` that is not a finite number of at least 0
 */
export function createConfigFence(o: ConfigFenceOptions): ConfigFence {
  const intervalMs = o.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new TypeError('createConfigFence: intervalMs must be a finite number of at least 0');
  const clock = o.clock ?? (() => Date.now());
  const mtime = o.mtime ?? configMtimeMs;
  const { log } = o;

  let current = o.initial;
  let lastLookAt = clock();
  /** The mtime of the last load that worked; undefined until one did. */
  let loadedMtime: number | null | undefined;
  /** The mtime whose failed load was logged; undefined while none failed since the last load that worked. */
  let failedMtime: number | null | undefined;
  /** Whether the last look failed to stat (logged once until a stat works again). */
  let statFailing = false;
  let running: Promise<void> | undefined;
  /** Bumped by reset(): a look that began before it must not apply what it read. */
  let generation = 0;

  async function look(): Promise<void> {
    const began = generation;
    let m: number | null;
    try {
      m = await mtime(o.dataDir);
      statFailing = false;
    } catch (error) {
      if (!statFailing) log.error('config fence: config.json cannot be read; the config in use is kept', errorFields(error));
      statFailing = true;
      return;
    }
    if (began !== generation || m === loadedMtime) return;

    /** A load that failed: tried again on the next look, logged once per mtime. */
    const failed = (msg: string, fields: LogFields): void => {
      if (m === failedMtime) return;
      failedMtime = m;
      log.error(msg, fields);
    };
    let next: Config | null;
    try {
      next = await loadConfig(o.dataDir, o.env);
    } catch (error) {
      if (began === generation) failed('config fence: config.json does not load; the config in use is kept', errorFields(error));
      return;
    }
    if (began !== generation) return; // reset() meanwhile: what this look read may be older than the config in use
    if (next === null) {
      failed('config fence: config.json is gone; the config in use is kept', {});
      return;
    }
    loadedMtime = m;
    failedMtime = undefined;
    const prev = current;
    current = next;
    if (sameConfig(next, prev)) return;
    log.info('config fence: config.json changed, the new config is in use', {});
    try {
      o.onChange(next, prev);
    } catch (error) {
      log.error('config fence: applying the new config failed', { error: loggableError(error) });
    }
  }

  return {
    current: () => current,
    check(): Promise<void> {
      if (running !== undefined) return running;
      const now = clock();
      // A clock that went back counts as due, so that a wrong reading cannot stop the fence for good.
      if (now >= lastLookAt && now - lastLookAt < intervalMs) return Promise.resolve();
      lastLookAt = now;
      running = look()
        .catch((error: unknown) => {
          log.error('config fence: the check failed; the config in use is kept', { error: loggableError(error) });
        })
        .finally(() => {
          running = undefined;
        });
      return running;
    },
    reset(config: Config): void {
      generation += 1;
      current = config;
      // The next look loads the file whatever its mtime, and reports a failure to load it afresh.
      loadedMtime = undefined;
      failedMtime = undefined;
    },
  };
}
