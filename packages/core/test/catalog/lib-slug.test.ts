import { describe, expect, it } from 'vitest';
import { recordSlug, recordUrlPath } from '../../src/catalog/lib/index.js';

// Spec §9.1: the record URL is /katalog/<id>/<slug>; the slug is ASCII, lower case, with hyphens, <= 80 characters.

describe('recordSlug', () => {
  it('makes an ASCII, lower-case, hyphenated slug', () => {
    expect(recordSlug('Laskar Pelangi')).toBe('laskar-pelangi');
    expect(recordSlug('Café: une histoire!')).toBe('cafe-une-histoire');
    expect(recordSlug("  Tafsir Al-Qur'an — Jilid 1  ")).toBe('tafsir-al-quran-jilid-1');
    expect(recordSlug('Straße & Øresund')).toBe('strasse-oresund');
  });

  it("falls back to 'judul' when nothing ASCII is left", () => {
    expect(recordSlug('')).toBe('judul');
    expect(recordSlug('!!!')).toBe('judul');
    expect(recordSlug('كتاب التوحيد')).toBe('judul');
  });

  it('keeps at most 80 characters and never ends with a hyphen', () => {
    const slug = recordSlug(`${'abcd '.repeat(40)}`);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(recordSlug('x'.repeat(200))).toBe('x'.repeat(80));
  });
});

describe('recordUrlPath', () => {
  it('is /katalog/<id>/<slug>', () => {
    expect(recordUrlPath('01JBX5V8Q3R7T9W2Y4Z6A8C0E2', 'Laskar Pelangi')).toBe('/katalog/01JBX5V8Q3R7T9W2Y4Z6A8C0E2/laskar-pelangi');
    expect(recordUrlPath('01JBX5V8Q3R7T9W2Y4Z6A8C0E2', '')).toBe('/katalog/01JBX5V8Q3R7T9W2Y4Z6A8C0E2/judul');
  });
});
