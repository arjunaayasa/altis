/**
 * `feed sign` and `freshness sign`: the signed static update feed (spec §9.6; decision D1d-3; preflight 1D-11).
 *
 * `<feedBase>/<channel>/feed.json` is the canonical JSON (RFC 8785) of the feed payload `{v: 1, channel, releases,
 * keyset}`, `feed.sig` its `altis-feed/1` envelope by a `release` key (re-signed at every release, on the signing
 * machine), and `freshness.json` a `{raw, env}` document `altis-timestamp/1` `{feedSha256, seq, issuedAt, expiresAt}`
 * by a `timestamp` key (renewed by the freshness automation, at most 14 days ahead). The client (Task 20,
 * `verifyFeed`) requires both, and refuses a lower `seq` than the highest it has seen.
 *
 * `issuedAt` is signed time: installations trust it to judge their own clock (D1d-7, spec §10.4), so a freshness
 * document dated ahead of the real time would mislead them. `freshness sign` therefore always signs with this host's
 * clock (which must run NTP); `--issued-at` exists for tests and is refused for any key that is not `dev-`
 * (ISSUED_AT_DEV_ONLY), and an issuedAt more than 5 min ahead of the clock is refused (ISSUED_AT_AHEAD).
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import { canonicalize, parseStrictJson, signDetached, type KeysetDoc } from '@altis/crypto';
import { FEED_TYP, FRESHNESS_MAX_MS, FRESHNESS_TYP, parseFeedPayload, type FeedPayload, type FreshnessPayload } from '@altis/crypto/feed';
import {
  CliError,
  DEV_KID_PREFIX,
  UsageError,
  hasExactKeys,
  isRecord,
  isoDateTime,
  json,
  messageOf,
  parseOptions,
  readKeysetFile,
  readStrictJson,
  refuseOutputOverInput,
  wholeNumber,
  writeTextAtomic,
  type CliIo,
} from './common.js';
import { openKeyFor } from './key-file.js';

export const FEED_FILE = 'feed.json';
export const FEED_SIG_FILE = 'feed.sig';

/** `freshness sign --expires-in-days`: 1 to 14 (§9.6 "expiresAt ≤ 14 hari"). */
export const FRESHNESS_MIN_DAYS = 1;
export const FRESHNESS_MAX_DAYS = FRESHNESS_MAX_MS / 86_400_000;

/** How far ahead of this host's clock an `issuedAt` may be (preflight 1D-11). */
export const ISSUED_AT_MAX_AHEAD_MS = 5 * 60_000;

const DAY_MS = 86_400_000;

/** The feed source file: exactly these fields; the keyset documents come from --keyset. */
const SOURCE_FIELDS = ['channel', 'releases', 'v'];

/** The fields of a feed entry (FeedEntry, §9.6), sorted. */
const ENTRY_FIELDS = [
  'bootProtocol',
  'channel',
  'minCodeVersionAfter',
  'minDb',
  'minNode',
  'minUpgradeFrom',
  'notesUrl',
  'releasedAt',
  'sha256',
  'size',
  'url',
  'version',
];

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// The keyset file (readKeysetFile, common.ts): the feed carries every document, so an entry of another shape is refused
// rather than signed into it.

/**
 * The feed payload of a source `{v: 1, channel, releases}` and the keyset documents. Every entry is checked with the
 * client's own parser and must hold exactly the fields of §9.6 (a field this tool does not know would be signed but
 * dropped by every client); versions are unique and every entry is of the feed's channel.
 */
function feedPayloadOf(source: unknown, keyset: KeysetDoc[], file: string): FeedPayload {
  if (!isRecord(source) || !hasExactKeys(source, SOURCE_FIELDS)) {
    throw new CliError(`FEED_FORMAT:source (${file} must be exactly {v: 1, channel, releases}; the keyset documents come from --keyset)`);
  }
  let payload: FeedPayload;
  try {
    payload = parseFeedPayload({ ...source, keyset });
  } catch (err) {
    throw new CliError(`${messageOf(err)} (${file})`);
  }
  (source['releases'] as unknown[]).forEach((entry, index) => {
    const unknown = Object.keys(entry as Record<string, unknown>).filter((key) => ENTRY_FIELDS.indexOf(key) === -1);
    if (unknown.length > 0) {
      throw new CliError(`FEED_FORMAT:releases.${index} (${file}: ${unknown.join(', ')} is not a feed entry field of this release; clients would ignore it)`);
    }
  });
  const versions = new Set<string>();
  payload.releases.forEach((entry, index) => {
    if (entry.channel !== payload.channel) {
      throw new CliError(`FEED_CHANNEL:releases.${index} (${file}: ${entry.version} is a ${entry.channel} release, the feed is ${payload.channel})`);
    }
    if (versions.has(entry.version)) throw new CliError(`FEED_DUPLICATE_VERSION:${entry.version} (${file}: one entry per version)`);
    versions.add(entry.version);
  });
  return payload;
}

/**
 * `feed sign --in <feed-src.json> --keyset <keyset.json> --key <release key> --out-dir <dir>`: writes `<dir>/feed.json`
 * (the canonical payload, `keyset` = every document of --keyset) and `<dir>/feed.sig`.
 */
export async function feedSignCommand(args: string[], io: CliIo): Promise<void> {
  const o = parseOptions(args, { required: ['in', 'keyset', 'key', 'out-dir'] });
  const outDir = o.values['out-dir'] as string;
  if (outDir === '') throw new UsageError('--out-dir must not be empty');
  // Neither output may replace an input, the release key above all (1d review L01).
  const inputs = [
    ['--key', o.values['key']],
    ['--in', o.values['in']],
    ['--keyset', o.values['keyset']],
  ] as const;
  for (const name of [FEED_FILE, FEED_SIG_FILE]) await refuseOutputOverInput(nodePath.join(nodePath.resolve(outDir), name), inputs, '--out-dir');
  const key = await openKeyFor(o.values['key'] as string, FEED_TYP);
  const keyset = await readKeysetFile(o.values['keyset'] as string);
  const payload = feedPayloadOf(await readStrictJson(o.values['in'] as string, 'feed source'), keyset, o.values['in'] as string);

  const signer = await key.unlock();
  const text = canonicalize(payload);
  const env = signDetached(payload, { typ: FEED_TYP, kid: signer.kid, privateKey: signer.privateKey });
  const dir = nodePath.resolve(outDir);
  await fsp.mkdir(dir, { recursive: true });
  const feedFile = nodePath.join(dir, FEED_FILE);
  const sigFile = nodePath.join(dir, FEED_SIG_FILE);
  await writeTextAtomic(feedFile, text);
  await writeTextAtomic(sigFile, json(env));
  io.out(
    `signed the ${payload.channel} feed (${payload.releases.length} release(s), ${keyset.length} keyset document(s)) as ${signer.kid}: wrote ${feedFile} and ${sigFile}`,
  );
  io.out(`feed.json SHA-256 ${sha256Hex(Buffer.from(text, 'utf8'))}`);
}

/**
 * `freshness sign --feed <feed.json> --seq <n> --expires-in-days <d> --key <timestamp key> --out <freshness.json>
 * [--issued-at <ISO>]`: writes `{raw, env}`, the altis-timestamp/1 document over the SHA-256 of feed.json's bytes.
 */
export async function freshnessSignCommand(args: string[], io: CliIo): Promise<void> {
  const o = parseOptions(args, { required: ['feed', 'seq', 'expires-in-days', 'key', 'out'], optional: ['issued-at'] });
  const seq = wholeNumber(o.values['seq'] as string, '--seq');
  const days = wholeNumber(o.values['expires-in-days'] as string, '--expires-in-days');
  if (days < FRESHNESS_MIN_DAYS || days > FRESHNESS_MAX_DAYS) {
    throw new UsageError(`--expires-in-days must be ${FRESHNESS_MIN_DAYS} to ${FRESHNESS_MAX_DAYS} (spec §9.6: expiresAt is at most 14 days after issuedAt)`);
  }
  const issuedAtText = o.values['issued-at'];
  const given = issuedAtText === undefined ? undefined : isoDateTime(issuedAtText, '--issued-at');
  const out = o.values['out'] as string;
  if (out === '') throw new UsageError('--out must not be empty');
  // The timestamp key lives on the automation host: a mistyped --out must never replace it (1d review L01).
  await refuseOutputOverInput(out, [
    ['--key', o.values['key']],
    ['--feed', o.values['feed']],
  ]);

  const key = await openKeyFor(o.values['key'] as string, FRESHNESS_TYP);
  if (given !== undefined && !key.kid.startsWith(DEV_KID_PREFIX)) {
    throw new UsageError(
      `ISSUED_AT_DEV_ONLY (--issued-at is for dev- keys in tests; ${key.kid} signs with this host's clock, which installations take as signed time)`,
    );
  }
  const now = Date.now();
  const issuedAt = given ?? now;
  if (issuedAt > now + ISSUED_AT_MAX_AHEAD_MS) {
    throw new UsageError(
      `ISSUED_AT_AHEAD (issuedAt ${new Date(issuedAt).toISOString()} is more than 5 min ahead of this host's clock ` +
        `${new Date(now).toISOString()}: installations would take it as signed time and could be pushed toward CLOCK_ROLLBACK)`,
    );
  }

  const feedFile = o.values['feed'] as string;
  let feedBytes: Buffer;
  try {
    feedBytes = await fsp.readFile(feedFile);
  } catch (err) {
    throw new CliError(`cannot read the feed ${feedFile}: ${messageOf(err)}`);
  }
  try {
    parseFeedPayload(parseStrictJson(feedBytes.toString('utf8')));
  } catch (err) {
    const message = messageOf(err);
    throw new CliError(`${message.startsWith('FEED_FORMAT') ? message : `FEED_FORMAT:json (${message})`} (${feedFile} is not a feed.json)`);
  }

  const payload: FreshnessPayload = { feedSha256: sha256Hex(feedBytes), seq, issuedAt, expiresAt: issuedAt + days * DAY_MS };
  const signer = await key.unlock();
  const env = signDetached(payload, { typ: FRESHNESS_TYP, kid: signer.kid, privateKey: signer.privateKey });
  const target = nodePath.resolve(out);
  await fsp.mkdir(nodePath.dirname(target), { recursive: true });
  await writeTextAtomic(target, json({ raw: canonicalize(payload), env }));
  io.out(
    `signed freshness seq ${seq} for ${feedFile} as ${signer.kid}: issued ${new Date(issuedAt).toISOString()}, ` +
      `expires ${new Date(payload.expiresAt).toISOString()}; wrote ${target}`,
  );
}
