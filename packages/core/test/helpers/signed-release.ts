import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { KEYSET_TYP, RELEASE_TYP, buildManifest, signDetached, type KeysetDoc, type ReleaseManifest, type TrustedKey } from '@altis/crypto';

// Signed release folders with the dev keys of tools/keys/dev (1d Task 27's tests): `bundled-release/<v>/` as app.js's
// zip carries it, or `DATA_DIR/releases/<v>/` as an install or an adoption leaves it.

const DEV_KEYS = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'tools', 'keys', 'dev');
const readDev = (name: string): unknown => JSON.parse(readFileSync(path.join(DEV_KEYS, name), 'utf8')) as unknown;

/** The dev root keys (what a test build embeds). */
export const DEV_ROOTS = readDev('roots.json') as TrustedKey[];
/** The dev keyset (dev-root-1 signs it; it adds dev-rel-1, dev-rel-2, dev-lic-1, ...). */
export const DEV_KEYSET = readDev('keyset.json') as KeysetDoc[];

/** A dev private key by kid. */
export function devKey(kid: string): KeyObject {
  const file = readDev(`${kid}.key.json`) as { pkcs8: string };
  return createPrivateKey({ key: Buffer.from(file.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
}

/** A keyset document signed by `dev-root-1` (seq 2 unless given): `revokedKids` revoked, no key added. */
export function rootDoc(o: { seq?: number; revokedKids?: string[] } = {}): KeysetDoc {
  const payload = { seq: o.seq ?? 2, keys: [], revokedKids: o.revokedKids ?? ['dev-rel-2'] };
  return { raw: JSON.stringify(payload), env: signDetached(payload, { typ: KEYSET_TYP, kid: 'dev-root-1', privateKey: devKey('dev-root-1') }) };
}

export interface SignedReleaseOptions {
  /** Fields of the manifest besides `version` and `files` (defaults: a 0009 schema, Node 22.16, every database). */
  meta?: Partial<Omit<ReleaseManifest, 'version' | 'files'>>;
  /** The release's keyset.json (default the dev keyset). */
  keyset?: KeysetDoc[];
  /** The kid that signs the manifest (default `dev-rel-1`). */
  signer?: string;
}

/**
 * Writes the release `version` into `dir` (created): server.mjs, public/admin/index.html, keyset.json, manifest.json,
 * manifest.sig and `.complete`. Returns its manifest.
 */
export async function writeSignedRelease(dir: string, version: string, o: SignedReleaseOptions = {}): Promise<ReleaseManifest> {
  await fsp.mkdir(path.join(dir, 'public', 'admin'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'server.mjs'), `export const bootProtocol = 1;\n// ${version}\n`);
  await fsp.writeFile(path.join(dir, 'public', 'admin', 'index.html'), `<!doctype html><title>ALTIS ${version}</title>\n`);
  await fsp.writeFile(path.join(dir, 'keyset.json'), `${JSON.stringify(o.keyset ?? DEV_KEYSET, null, 2)}\n`);
  const manifest = await buildManifest(dir, {
    version,
    buildId: `test-${version}`,
    bootProtocol: 1,
    releasedAt: '2026-10-27',
    schemaLatest: '0009',
    minCodeVersionAfter: '0.0.0',
    minUpgradeFrom: '0.0.0',
    minNode: '22.16.0',
    minDb: { mysql: '8.0.0', mariadb: '10.6.0', postgres: '15.0.0' },
    ...o.meta,
  });
  const signer = o.signer ?? 'dev-rel-1';
  await fsp.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fsp.writeFile(path.join(dir, 'manifest.sig'), JSON.stringify(signDetached(manifest, { typ: RELEASE_TYP, kid: signer, privateKey: devKey(signer) })));
  await fsp.writeFile(path.join(dir, '.complete'), '');
  return manifest;
}
