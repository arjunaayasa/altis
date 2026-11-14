import { LOCALES } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { OPAC_MESSAGE_AREAS, defineOpacMessages, opacText, type OpacKey } from '../src/opac/catalog/messages.js';

// The OPAC's own copy (Phase 2 Task 3, decision P2-04): one file per area under src/opac/catalog/messages/ (shell,
// pages, search, detail, oai), each owned by its task and written with defineOpacMessages(id, en), whose types make the
// two languages have the same keys. This aggregator test holds every area file to the shared i18n rules: the same keys
// and {placeholders} in `id` and `en`, no empty text, no English left in `id`, and keys that carry their area's prefix
// (the areas are merged into one table, so a key in two areas would silently lose one text).

const placeholders = (text: string): string[] => [...new Set([...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!))].sort();

/** Keys whose two texts may be the same (a proper name, a format, a number): none so far. */
const SAME_IN_BOTH: readonly string[] = [];

describe('the OPAC message areas', () => {
  const areas = Object.entries(OPAC_MESSAGE_AREAS);

  it('are the five areas, in a fixed order', () => {
    expect(areas.map(([name]) => name)).toEqual(['shell', 'pages', 'search', 'detail', 'oai', 'visits']);
  });

  it.each(areas)('%s: id and en have the same keys, each with the area prefix', (name, messages) => {
    const id = Object.keys(messages.id).sort();
    expect(Object.keys(messages.en).sort()).toEqual(id);
    for (const key of id) expect(key.startsWith(`${name}.`), key).toBe(true);
  });

  it.each(areas)('%s: no empty text, the same placeholders, and no English left in id', (_name, messages) => {
    for (const [key, text] of Object.entries(messages.id)) {
      const en = (messages.en as Record<string, string>)[key]!;
      for (const value of [text, en]) expect(value.trim(), key).not.toBe('');
      expect(placeholders(en), key).toEqual(placeholders(text));
      if (!SAME_IN_BOTH.includes(key)) expect(en, `${key}: the id text is the en one`).not.toBe(text);
    }
  });

  it.each(areas)('%s: frozen', (_name, messages) => {
    expect(Object.isFrozen(messages)).toBe(true);
    for (const locale of LOCALES) expect(Object.isFrozen(messages[locale])).toBe(true);
  });

  it('no key is in two areas', () => {
    const all = areas.flatMap(([, m]) => Object.keys(m.id));
    expect(all.length).toBe(new Set(all).size);
  });

  it('Task 3 itself writes the status pages of opacStatusResponse (S17) in the shell area', () => {
    for (const status of [410, 429, 503]) {
      for (const part of ['title', 'body']) expect(Object.keys(OPAC_MESSAGE_AREAS.shell.id)).toContain(`shell.status.${status}.${part}`);
    }
  });
});

describe('opacText', () => {
  it('answers the text of the locale', () => {
    const key: OpacKey = 'shell.status.429.title';
    expect(opacText('id', key)).toBe(OPAC_MESSAGE_AREAS.shell.id[key]);
    expect(opacText('en', key)).toBe(OPAC_MESSAGE_AREAS.shell.en[key]);
    expect(opacText('en', key)).not.toBe(opacText('id', key));
  });

  it('answers every key of every area in both languages', () => {
    for (const [, messages] of Object.entries(OPAC_MESSAGE_AREAS)) {
      for (const key of Object.keys(messages.id) as OpacKey[]) {
        for (const locale of LOCALES) expect(opacText(locale, key)).toBe((messages[locale] as Record<string, string>)[key]);
      }
    }
  });

  it('defineOpacMessages freezes both languages', () => {
    const m = defineOpacMessages({ 'x.a': 'satu' }, { 'x.a': 'one' });
    expect(Object.isFrozen(m) && Object.isFrozen(m.id) && Object.isFrozen(m.en)).toBe(true);
    expect(m).toEqual({ id: { 'x.a': 'satu' }, en: { 'x.a': 'one' } });
  });
});
