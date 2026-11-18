import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The two HTML shells of the admin build. index.html links the site icon the server answers at /site-icon/<size>.png
// (the library's own, or the built-in one), also as the Apple touch icon. install.html is shown before the system is
// installed, when the server answers nothing but the wizard: it names an empty `data:` icon (the CSP's `img-src`
// allows `data:`), so the browser asks for no `/favicon.ico`, which ALTIS does not serve.

const ROOT = path.resolve(import.meta.dirname, '..');

function head(file: string): string {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
}

describe('admin HTML shells', () => {
  it('index.html links the site icon in 32 and 192 px and the 180 px touch icon, all served by this origin', () => {
    const links = [...head('index.html').matchAll(/<link\b[^>]*>/g)].map((m) => m[0]);
    expect(links).toEqual([
      '<link rel="icon" type="image/png" sizes="32x32" href="/site-icon/32.png" />',
      '<link rel="icon" type="image/png" sizes="192x192" href="/site-icon/192.png" />',
      '<link rel="apple-touch-icon" href="/site-icon/180.png" />',
    ]);
  });

  it('install.html has an empty data: icon in <head>', () => {
    expect(head('install.html')).toContain('<link rel="icon" href="data:," />');
  });
});
