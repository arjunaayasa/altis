import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPasswordHasher } from '../src/crypto/password.js';

// Writes test/fixtures/password-vectors.json: PHC strings made by this Node, which test/password.test.ts verifies on
// whatever Node runs the tests (spec §7.1: "hash dibuat di Node terbaru lalu diverifikasi di 22.16"; the PR job runs
// Node 22.16). Run it on the newest Node the product supports and commit the output:
//
//   pnpm --filter @altis/core gen:password-vectors
//
// Non-ASCII characters are written as \u escapes, so that no editor or tool can recompose the decomposed vector.

const OUTPUT = path.resolve(import.meta.dirname, '..', 'test', 'fixtures', 'password-vectors.json');

/** The passwords: ASCII; decomposed Unicode (macOS input) with a trailing space; full-width and astral characters. */
export const VECTOR_PASSWORDS = ['kuda-lumping-biru', 'Café-kopi-2026 ', 'Ｐerpustakaan \u{1F4DA} Nusantara'] as const;

/** JSON with every non-ASCII UTF-16 unit as a \u escape. */
function asciiJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2).replace(/[^\x20-\x7e\n]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

async function main(): Promise<void> {
  const hasher = createPasswordHasher();
  const vectors = [];
  for (const password of VECTOR_PASSWORDS) vectors.push({ password, phc: await hasher.hash(password) });
  fs.writeFileSync(OUTPUT, asciiJson(vectors));
  process.stdout.write(`${path.relative(process.cwd(), OUTPUT)}: ${vectors.length} vectors (Node ${process.versions.node})\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
