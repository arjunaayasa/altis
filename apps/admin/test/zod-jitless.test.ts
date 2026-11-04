import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

// Spec §7.4 (CSP without 'unsafe-eval'), exit check A11: Zod compiles object parsers with `new Function` unless it is
// jitless, and the probe it runs first (a `new Function` inside a try/catch) is still reported by the browser as a
// `script-src` violation. The SPA switches Zod to jitless in a boot module of its own, imported by main.tsx before
// anything else: an ES module's body runs after every module it imports, so a call in main.tsx's body would come after
// any schema a statically imported module builds.

const MAIN = path.resolve(import.meta.dirname, '..', 'src', 'main.tsx');

/** The specifier of every import declaration of `source`, in order. */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/^import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((match) => match[1]!);
}

describe('zod-jitless', () => {
  it('importing the boot module makes Zod jitless', async () => {
    await import('@/lib/zod-jitless');
    expect(z.config().jitless).toBe(true);
  });

  it('is the first import of main.tsx', async () => {
    const specifiers = importSpecifiers(await fsp.readFile(MAIN, 'utf8'));
    expect(specifiers.length).toBeGreaterThan(1);
    expect(specifiers[0]).toBe('@/lib/zod-jitless');
  });
});
