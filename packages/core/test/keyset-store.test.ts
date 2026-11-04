import { fork, type ChildProcess } from 'node:child_process';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  KEYSET_MAX_DOCS,
  KEYSET_MAX_DOC_BYTES,
  KEYSET_MAX_FILE_BYTES,
  collectInstalledKeysets,
  readKeysetFile,
  resolveKeysetSources,
  resolveTrustedKeys,
  signDetached,
  type KeysetDoc,
  type TrustedKey,
} from '@altis/crypto';
import type { CurrentState } from '@altis/platform';
import { isDomainError } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CoreLogger } from '../src/context.js';
import { appendKeysetDocs, persistKeysetDocs, releaseKeysetDocs } from '../src/updates/keyset-store.js';

// The keyset store (spec §8.3, rulings R65a and R65c; plan Task 10): DATA_DIR/releases/keyset.json, written under
// releases/keyset.lock, holds every root-signed keyset document the installation has seen (from the feed and from
// every release installed or adopted), so a revocation keeps applying after the release or feed that carried it is
// gone. Only documents that verify against the roots are appended; the file and its .bak are read together; the
// frozen limits (4096 documents, 64 KiB each, 8 MiB in all) are never passed.

const DEV_KEYS = path.resolve(import.meta.dirname, '..', '..', '..', 'tools', 'keys', 'dev');
const readDev = (name: string): unknown => JSON.parse(readFileSync(path.join(DEV_KEYS, name), 'utf8')) as unknown;

function devKey(kid: string): KeyObject {
  const file = readDev(`${kid}.key.json`) as { pkcs8: string };
  return createPrivateKey({ key: Buffer.from(file.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
}

/** tools/keys/dev/roots.json: dev-root-1, the trust anchor of test builds. */
const ROOTS = readDev('roots.json') as TrustedKey[];
/** tools/keys/dev/keyset.json's one document: dev-root-1 trusts dev-rel-1, dev-rel-2 and the other dev keys. */
const DEV_KEYSET = (readDev('keyset.json') as KeysetDoc[])[0]!;
const ROOT_KEY = devKey('dev-root-1');

function signed(payload: unknown, kid = 'dev-root-1', privateKey = ROOT_KEY): KeysetDoc {
  return { raw: JSON.stringify(payload), env: signDetached(payload, { typ: 'altis-keyset/1', kid, privateKey }) };
}

/** A dev-root-1 document revoking dev-rel-2 (Review Focus 3: a leaked release key). */
const REVOKE_REL_2 = signed({ seq: 2, keys: [], revokedKids: ['dev-rel-2'] });

/** `n` distinct dev-root-1 documents, each revoking a kid nobody uses. */
function many(n: number, from: number, pad = ''): KeysetDoc[] {
  return Array.from({ length: n }, (_, i) => signed({ seq: from + i, keys: [], revokedKids: [`unused-${from + i}${pad}`] }));
}

const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const NOW = 1_800_000_000_000;

let tmp: string;
let counter = 0;
let dataDir: string;
let store: string;

beforeAll(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-keyset-store-')));
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  dataDir = path.join(tmp, `data-${counter++}`);
  await fsp.mkdir(path.join(dataDir, 'releases'), { recursive: true });
  store = path.join(dataDir, 'releases', 'keyset.json');
});

const append = (docs: readonly KeysetDoc[], o: { refuseDevKids?: boolean; log?: CoreLogger } = {}) =>
  appendKeysetDocs({ dataDir, roots: ROOTS, docs, refuseDevKids: o.refuseDevKids ?? false, log: o.log ?? silent });

const readStore = async (): Promise<unknown> => JSON.parse(await fsp.readFile(store, 'utf8')) as unknown;
const exists = (file: string): Promise<boolean> => fsp.stat(file).then(
  () => true,
  () => false,
);
const PAST = new Date(NOW - 86_400_000);

async function writeJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}

describe('appendKeysetDocs', () => {
  it('an empty store takes a dev-root-1 document; the same document again changes nothing', async () => {
    expect(await append([DEV_KEYSET])).toEqual({ added: 1, present: 0, rejected: 0, refused: 0, full: false });
    expect(await readStore()).toEqual([{ raw: DEV_KEYSET.raw, env: DEV_KEYSET.env }]);
    expect(await readKeysetFile(store)).toEqual([DEV_KEYSET]);

    await fsp.utimes(store, PAST, PAST);
    const before = await fsp.readFile(store, 'utf8');
    expect(await append([DEV_KEYSET])).toEqual({ added: 0, present: 1, rejected: 0, refused: 0, full: false });
    expect((await fsp.stat(store)).mtimeMs).toBe(PAST.getTime());
    expect(await fsp.readFile(store, 'utf8')).toBe(before);
    expect(await exists(`${store}.bak`)).toBe(false);
  });

  it('a copy whose raw text gained a space in a value is rejected and never hides the original', async () => {
    const tampered: KeysetDoc = { raw: DEV_KEYSET.raw.replace('"dev-rel-1"', '"dev-rel-1 "'), env: DEV_KEYSET.env };
    expect(tampered.raw).not.toBe(DEV_KEYSET.raw);
    expect(await append([tampered])).toEqual({ added: 0, present: 0, rejected: 1, refused: 0, full: false });
    expect(await exists(store)).toBe(false); // nothing accepted: nothing written
    expect(await append([tampered, DEV_KEYSET])).toEqual({ added: 1, present: 0, rejected: 1, refused: 0, full: false });
    expect(await readStore()).toEqual([DEV_KEYSET]);
  });

  it('a copy that differs only in insignificant whitespace is already present (the signature covers the canonical form)', async () => {
    // A release key holder could otherwise fill the store with endless whitespace variants of one genuine document
    // and keep a later revocation out (R65c cap).
    await append([DEV_KEYSET]);
    const spaced: KeysetDoc = { raw: ` ${DEV_KEYSET.raw}\n`, env: DEV_KEYSET.env };
    expect(resolveTrustedKeys(ROOTS, [spaced]).rejected).toEqual([]);
    expect(await append([spaced])).toEqual({ added: 0, present: 1, rejected: 0, refused: 0, full: false });
    expect(await readStore()).toEqual([DEV_KEYSET]);
  });

  it('rejects a document signed by a release key, and under refuseDevKids one that trusts a dev- kid', async () => {
    const byRelease = signed({ seq: 3, keys: [], revokedKids: ['unused'] }, 'dev-rel-1', devKey('dev-rel-1'));
    expect(await append([byRelease])).toEqual({ added: 0, present: 0, rejected: 1, refused: 0, full: false });
    expect(await exists(store)).toBe(false);

    expect(await append([DEV_KEYSET], { refuseDevKids: true })).toEqual({ added: 0, present: 0, rejected: 1, refused: 0, full: false });
    expect(await exists(store)).toBe(false);
    // Revoking a dev kid stays allowed under refuseDevKids (ruling R65b).
    expect(await append([REVOKE_REL_2], { refuseDevKids: true })).toMatchObject({ added: 1, rejected: 0 });
    expect(await readStore()).toEqual([REVOKE_REL_2]);
  });

  it('logs each rejection with its index and reason, never the document', async () => {
    const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
    const log: CoreLogger = { info() {}, warn: (msg, fields) => warnings.push({ msg, fields }), error() {} };
    const byRelease = signed({ seq: 3, keys: [], revokedKids: ['unused'] }, 'dev-rel-1', devKey('dev-rel-1'));
    await append([DEV_KEYSET, byRelease], { log });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fields).toEqual({ index: 1, reason: 'SIG_INVALID:kid' });
    expect(JSON.stringify(warnings)).not.toContain(byRelease.env.sig);
  });

  it('4096 documents present plus one more: full, and the file is left exactly as it was', async () => {
    const present = many(KEYSET_MAX_DOCS, 1);
    await writeJson(store, present);
    await fsp.utimes(store, PAST, PAST);
    const before = await fsp.readFile(store, 'utf8');
    const extra = signed({ seq: 9000, keys: [], revokedKids: ['extra'] });

    expect(await append([extra])).toEqual({ added: 0, present: 0, rejected: 0, refused: 1, full: true });
    expect(await fsp.readFile(store, 'utf8')).toBe(before);
    expect((await fsp.stat(store)).mtimeMs).toBe(PAST.getTime());
    // A document already there is still found while the store is full.
    expect(await append([present[17]!, extra])).toEqual({ added: 0, present: 1, rejected: 0, refused: 1, full: true });
  }, 30_000);

  it('appends in input order and stops before the 4096th document is passed', async () => {
    await writeJson(store, many(KEYSET_MAX_DOCS - 1, 1));
    const [a, b, c] = many(3, 9000);
    expect(await append([a!, b!, c!])).toEqual({ added: 1, present: 0, rejected: 0, refused: 2, full: true });
    const docs = await readKeysetFile(store);
    expect(docs).toHaveLength(KEYSET_MAX_DOCS);
    expect(docs![KEYSET_MAX_DOCS - 1]).toEqual(a);
  }, 30_000);

  it('stops before the file passes 8 MiB, and the file stays readable', async () => {
    // Documents of about 60 KB each: about 139 fit in 8 MiB as the writer lays them out.
    const big = many(150, 1, 'x'.repeat(60_000));
    const r = await append(big);
    expect(r.full).toBe(true);
    expect(r.added).toBeGreaterThan(130);
    expect(r.added + r.refused).toBe(150);
    const size = (await fsp.stat(store)).size;
    expect(size).toBeLessThanOrEqual(KEYSET_MAX_FILE_BYTES);
    expect(size).toBeGreaterThan(KEYSET_MAX_FILE_BYTES - 70_000);
    expect(await readKeysetFile(store)).toEqual(big.slice(0, r.added));

    // Nothing more fits: the next call writes nothing.
    const mtime = (await fsp.stat(store)).mtimeMs;
    expect(await append(many(1, 500, 'x'.repeat(60_000)))).toMatchObject({ added: 0, refused: 1, full: true });
    expect((await fsp.stat(store)).mtimeMs).toBe(mtime);
  }, 30_000);

  it('a document over 64 KiB as stored JSON is never written (it would make the file unreadable)', async () => {
    // Quotes are escaped twice (once in raw, once in the file): raw stays under 64 KiB, the stored entry does not.
    const huge = signed({ seq: 5, keys: [], revokedKids: ['"'.repeat(20_000)] });
    expect(Buffer.byteLength(huge.raw)).toBeLessThan(KEYSET_MAX_DOC_BYTES);
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeGreaterThan(KEYSET_MAX_DOC_BYTES);
    expect(resolveTrustedKeys(ROOTS, [huge]).rejected).toEqual([]);
    expect(await append([huge, DEV_KEYSET])).toEqual({ added: 0, present: 0, rejected: 0, refused: 2, full: true });
    expect(await exists(store)).toBe(false);
  });

  it('reads the file and its .bak together: A and B, with C only in the .bak, plus D writes A, B, C and D', async () => {
    const [a, b, c, d] = many(4, 100);
    await writeJson(store, [a, b]);
    await writeJson(`${store}.bak`, [c]);
    expect(await append([d!])).toEqual({ added: 1, present: 0, rejected: 0, refused: 0, full: false });
    expect(await readStore()).toEqual([a, b, c, d]);
    expect(JSON.parse(await fsp.readFile(`${store}.bak`, 'utf8'))).toEqual([a, b]); // the previous main file
    // C counts as present from the .bak too.
    expect(await append([c!])).toMatchObject({ added: 0, present: 1 });
  });

  it('a torn main file next to a usable .bak: the .bak documents are kept', async () => {
    const [c, d] = many(2, 200);
    await writeJson(store, '[{"raw":');
    await writeJson(`${store}.bak`, [c]);
    expect(await append([d!])).toMatchObject({ added: 1 });
    expect(await readStore()).toEqual([c, d]);
  });

  it.each([
    ['both copies are corrupt', '{ torn', '[1'],
    ['the only copy is corrupt', '{ torn', null],
    ['the only copy is the .bak and it is corrupt', null, 'not json'],
  ])('%s: STATE_CORRUPT, and the files are left untouched', async (_name, main, bak) => {
    if (main !== null) await writeJson(store, main);
    if (bak !== null) await writeJson(`${store}.bak`, bak);
    const error = await append([DEV_KEYSET]).catch((e: unknown) => e);
    expect(isDomainError(error) && error.code === 'STATE_CORRUPT').toBe(true);
    expect(main === null ? await exists(store) : await fsp.readFile(store, 'utf8')).toBe(main === null ? false : main);
    expect(bak === null ? await exists(`${store}.bak`) : await fsp.readFile(`${store}.bak`, 'utf8')).toBe(bak === null ? false : bak);
    expect((await fsp.readdir(path.join(dataDir, 'releases'))).sort()).toEqual(
      [main === null ? null : 'keyset.json', bak === null ? null : 'keyset.json.bak'].filter((n) => n !== null),
    );
  });

  it('refuses invalid roots before any I/O (a programming error)', async () => {
    const notRoot = [{ kid: 'dev-rel-1', use: 'release', pub: ROOTS[0]!.pub }] as TrustedKey[];
    await expect(appendKeysetDocs({ dataDir, roots: notRoot, docs: [DEV_KEYSET], refuseDevKids: false, log: silent })).rejects.toThrow(TypeError);
    expect(await fsp.readdir(path.join(dataDir, 'releases'))).toEqual([]);
  });

  it('creates DATA_DIR/releases when it is missing', async () => {
    await fsp.rm(path.join(dataDir, 'releases'), { recursive: true });
    expect(await append([DEV_KEYSET])).toMatchObject({ added: 1 });
    expect(await readStore()).toEqual([DEV_KEYSET]);
  });

  it('two processes appending different documents at once: every document is kept', async () => {
    const fixture = path.join(import.meta.dirname, 'fixtures', 'keyset-store-child.mjs');
    const sets = [many(12, 1000), many(12, 2000)];
    const children: ChildProcess[] = [];
    try {
      const runs = sets.map((docs) => {
        const child = fork(fixture, [JSON.stringify({ dataDir, roots: ROOTS, docs })], {
          cwd: path.resolve(import.meta.dirname, '../../..'),
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        children.push(child);
        let report: unknown;
        const ready = new Promise<void>((resolve, reject) => {
          child.on('message', (message) => {
            if (message === 'ready') resolve();
            else report = message;
          });
          child.once('error', reject);
          child.once('exit', (code) => reject(new Error(`child exited with ${String(code)} before it was ready`)));
        });
        const closed = new Promise<{ exit: number | null; report: unknown }>((resolve) =>
          child.once('close', (exit) => resolve({ exit, report })),
        );
        return { child, ready, closed };
      });
      await Promise.all(runs.map((r) => r.ready));
      for (const r of runs) r.child.send('go');
      const done = await Promise.all(runs.map((r) => r.closed));
      expect(done.map((d) => d.exit)).toEqual([0, 0]);
      for (const d of done) expect(d.report).toEqual({ added: 12, present: 0, rejected: 0, full: false });
      const stored = (await readKeysetFile(store))!;
      expect(stored).toHaveLength(24);
      expect(new Set(stored.map((doc) => doc.raw))).toEqual(new Set([...sets[0]!, ...sets[1]!].map((doc) => doc.raw)));
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 60_000);
});

describe('releaseKeysetDocs', () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = path.join(tmp, `app-${counter++}`);
    await fsp.mkdir(appRoot, { recursive: true });
  });

  const state = (o: Partial<CurrentState>): CurrentState => ({
    schema: 1,
    active: { version: '0.1.0', source: 'bundled' },
    previous: null,
    pending: null,
    pendingSince: null,
    pinned: null,
    ...o,
  });

  it('returns the documents of every bundled release and of every release current.json names, not the store', async () => {
    const [x] = many(1, 300);
    await writeJson(path.join(appRoot, 'bundled-release', '0.1.0', 'keyset.json'), [DEV_KEYSET]);
    await writeJson(path.join(dataDir, 'releases', '0.2.0', 'keyset.json'), [DEV_KEYSET, REVOKE_REL_2]);
    await writeJson(path.join(dataDir, 'releases', '0.3.0', 'keyset.json'), [x]);
    await writeJson(store, many(1, 400)); // the store itself is not a release
    const docs = await releaseKeysetDocs({
      appRoot,
      dataDir,
      state: state({ active: { version: '0.2.0', source: 'data' }, previous: { version: '0.1.0', source: 'bundled' }, pending: { version: '0.3.0', source: 'data' }, pendingSince: NOW }),
    });
    expect(docs).toEqual([DEV_KEYSET, DEV_KEYSET, REVOKE_REL_2, x]);
  });

  it('logs and skips a release keyset.json that cannot be used', async () => {
    const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
    const log: CoreLogger = { info() {}, warn: (msg, fields) => warnings.push({ msg, fields }), error() {} };
    await writeJson(path.join(appRoot, 'bundled-release', '0.1.0', 'keyset.json'), [DEV_KEYSET]);
    await writeJson(path.join(dataDir, 'releases', '0.2.0', 'keyset.json'), '{ torn');
    const docs = await releaseKeysetDocs({ appRoot, dataDir, state: state({ previous: { version: '0.2.0', source: 'data' } }), log });
    expect(docs).toEqual([DEV_KEYSET]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fields).toMatchObject({ source: 'DATA_DIR/releases/0.2.0/keyset.json' });
  });

  it('no release folder at all: no documents', async () => {
    expect(await releaseKeysetDocs({ appRoot, dataDir, state: state({}) })).toEqual([]);
  });
});

describe('Review Focus 3: a revocation persisted in the store outlives the release that carried it', () => {
  it('dev-rel-2 stays revoked although the bundled keyset.json still trusts it and the revoking release is gone', async () => {
    const appRoot = path.join(tmp, `app-${counter++}`);
    await writeJson(path.join(appRoot, 'bundled-release', '0.1.0', 'keyset.json'), [DEV_KEYSET]);
    const revoking = path.join(dataDir, 'releases', '0.2.0');
    await writeJson(path.join(revoking, 'keyset.json'), [DEV_KEYSET, REVOKE_REL_2]);

    const kids = async (named: { name: string; dir: string }[]): Promise<string[]> => {
      const found = await collectInstalledKeysets({ appRoot, dataKeyset: store, releases: named });
      return resolveKeysetSources(ROOTS, found.sources).keys.map((k) => k.kid);
    };
    const bundled = { name: 'bundled-release/0.1.0/keyset.json', dir: path.join(appRoot, 'bundled-release', '0.1.0') };
    expect(await kids([bundled])).toContain('dev-rel-2'); // without the store, the bundled keyset still trusts it

    const docs = await releaseKeysetDocs({
      appRoot,
      dataDir,
      state: { schema: 1, active: { version: '0.2.0', source: 'data' }, previous: { version: '0.1.0', source: 'bundled' }, pending: null, pendingSince: null, pinned: null },
    });
    expect(await persistKeysetDocs({ dataDir, roots: ROOTS, docs, refuseDevKids: false, log: silent, now: NOW })).toEqual({
      added: 2,
      present: 1,
      rejected: 0,
      refused: 0,
      full: false,
    });
    expect(await kids([bundled, { name: 'DATA_DIR/releases/0.2.0/keyset.json', dir: revoking }])).not.toContain('dev-rel-2');

    // Retention removes the release that first carried the revocation (a rollback to the bundled 0.1.0).
    await fsp.rm(revoking, { recursive: true });
    const after = await kids([bundled]);
    expect(after).not.toContain('dev-rel-2');
    expect(after).toContain('dev-rel-1');

    // The next start persists the remaining releases' documents again: nothing changes.
    const again = await releaseKeysetDocs({
      appRoot,
      dataDir,
      state: { schema: 1, active: { version: '0.1.0', source: 'bundled' }, previous: null, pending: null, pendingSince: null, pinned: null },
    });
    expect(await appendKeysetDocs({ dataDir, roots: ROOTS, docs: again, refuseDevKids: false, log: silent })).toMatchObject({ added: 0, present: 1 });
    expect(await kids([bundled])).not.toContain('dev-rel-2');
  });
});
