import fsp from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isDomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppState } from '../src/app.js';
import { createAppUpdateSource, createServices } from '../src/services.js';
import { recordingLogger, sampleConfig } from './support.js';

// 1d Task 20: services.updates.source as the server builds it (createAppUpdateSource): the feed base of feedBaseOf
// (ALTIS_UPDATE_FEED_URL first, none before a config is loaded), plain http to loopback only because this is a test
// build, and the embedded root keys, which a server.mjs not bundled by the release build does not have: such a server
// trusts no feed, and verification comes before anything the feed says is kept.

let dataDir: string;
const servers: http.Server[] = [];

beforeEach(async () => {
  dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-update-source-wiring-')));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  await fsp.rm(dataDir, { recursive: true, force: true });
});

async function failure(promise: Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (!isDomainError(error)) throw error;
    return { code: error.code, reason: error.meta?.['reason'] };
  }
  throw new Error('expected a DomainError, the call resolved');
}

/** A feed server on 127.0.0.1 answering the three files of a channel with well-formed but untrusted documents. */
async function feedServer(): Promise<{ base: string; paths: string[] }> {
  const paths: string[] = [];
  const env = { typ: 'altis-feed/1', kid: 'dev-rel-1', alg: 'Ed25519', sig: 'AAAA' };
  const files: Record<string, string> = {
    '/feed/stable/feed.json': JSON.stringify({ v: 1, channel: 'stable', releases: [], keyset: [] }),
    '/feed/stable/feed.sig': JSON.stringify(env),
    '/feed/stable/freshness.json': JSON.stringify({ raw: '{}', env: { ...env, typ: 'altis-timestamp/1', kid: 'dev-ts-1' } }),
  };
  const server = http.createServer((req, res) => {
    paths.push(req.url ?? '');
    const body = files[req.url ?? ''];
    if (body === undefined) res.writeHead(404).end();
    else res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed`, paths };
}

describe('services.updates.source (createAppUpdateSource)', () => {
  it('exists with a DATA_DIR, and is a TypeError without one', () => {
    const state: AppState = { phase: 'ready', config: sampleConfig() };
    const log = recordingLogger();
    expect(() => createServices(state, { state, version: '0.1.0', buildId: '0.1.0', log, env: {} }).updates).toThrow(TypeError);
    const services = createServices(state, { state, version: '0.1.0', buildId: '0.1.0', log, env: {}, dataDir });
    expect(typeof services.updates.source.fetchFeed).toBe('function');
    expect(typeof services.updates.source.download).toBe('function');
  });

  it('no config loaded, or none naming a feed → no_feed_url; plain http off loopback → insecure', async () => {
    const make = (state: AppState, env: Record<string, string>) =>
      createAppUpdateSource(state, { dataDir, env, clock: () => Date.now(), log: recordingLogger(), edition: () => undefined });
    expect(await failure(make({ phase: 'starting' }, {}).fetchFeed('stable'))).toEqual({ code: 'FEED_UNREACHABLE', reason: 'no_feed_url' });
    expect(await failure(make({ phase: 'ready', config: sampleConfig() }, {}).fetchFeed('stable'))).toEqual({
      code: 'FEED_UNREACHABLE',
      reason: 'no_feed_url',
    });
    const insecure = make({ phase: 'ready', config: sampleConfig() }, { ALTIS_UPDATE_FEED_URL: 'http://example.com/feed' });
    expect(await failure(insecure.fetchFeed('stable'))).toEqual({ code: 'FEED_UNREACHABLE', reason: 'insecure' });
    // feedConfigured (GET updates' onlineCheck, the dashboard's check): false exactly where no_feed_url is.
    expect(make({ phase: 'starting' }, {}).feedConfigured()).toBe(false);
    expect(make({ phase: 'ready', config: sampleConfig() }, {}).feedConfigured()).toBe(false);
    expect(insecure.feedConfigured()).toBe(true);
    expect(make({ phase: 'ready', config: { ...sampleConfig(), update: { feedUrl: 'https://feed.example/altis' } } }, {}).feedConfigured()).toBe(true);
  });

  it('ALTIS_UPDATE_FEED_URL is fetched (loopback http in a test build); without embedded roots nothing is trusted or kept', async () => {
    const feed = await feedServer();
    const observed: unknown[] = [];
    const source = createAppUpdateSource(
      { phase: 'ready', config: sampleConfig() },
      {
        dataDir,
        env: { ALTIS_UPDATE_FEED_URL: feed.base },
        clock: () => Date.now(),
        log: recordingLogger(),
        edition: () => ({ observeSignedTime: async (t: unknown) => void observed.push(t) }) as never,
      },
    );
    expect(await failure(source.fetchFeed('stable'))).toEqual({ code: 'FEED_INVALID', reason: 'signature' });
    expect(feed.paths.sort()).toEqual(['/feed/stable/feed.json', '/feed/stable/feed.sig', '/feed/stable/freshness.json']);
    expect(observed).toEqual([]);
    await expect(fsp.stat(path.join(dataDir, 'releases', 'feed-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(path.join(dataDir, 'releases', 'keyset.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
