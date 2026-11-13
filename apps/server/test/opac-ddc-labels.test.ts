import { LOCALES, MESSAGES } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { SHELL_MESSAGES } from '../src/opac/catalog/messages/shell.js';

// The names of the ten DDC main classes live twice: in the OPAC's own copy (`shell.home.class.<d>`, its class browser)
// and in the shared vocabulary of the reports (`vocab.ddc_main.<d>00`). The OPAC keeps its keys; this keeps the two
// copies word for word the same in both languages, so a report and the catalogue never name a class differently.

describe('the DDC main class names of the reports and of the OPAC', () => {
  it.each(LOCALES)('are the same in %s for the classes 0 to 9', (locale) => {
    const shared = MESSAGES[locale] as Readonly<Record<string, string>>;
    const opac = SHELL_MESSAGES[locale] as Readonly<Record<string, string>>;
    for (let d = 0; d <= 9; d += 1) {
      expect(opac[`shell.home.class.${d}`], `${locale}:${d}`).toBeTruthy();
      expect(shared[`vocab.ddc_main.${d}00`], `${locale}:${d}`).toBe(opac[`shell.home.class.${d}`]);
    }
  });
});
