import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The two HTML shells of the admin build (index.html, install.html): each names an empty `data:` icon (the CSP's
// `img-src` allows `data:`), so the browser asks for no `/favicon.ico`, which ALTIS does not serve; without it every
// first page load logged a 404 in the console.

const ROOT = path.resolve(import.meta.dirname, '..');

describe('admin HTML shells', () => {
  it.each(['index.html', 'install.html'])('%s has an empty data: icon in <head>', (file) => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    expect(head).toContain('<link rel="icon" href="data:," />');
  });
});
