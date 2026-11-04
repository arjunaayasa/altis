import { defineOpacMessages } from './define.js';

// The OPAC copy of OAI-PMH (Phase 2 Task 35; spec §10). Keys start with `oai.`; the same keys and {placeholders} in
// both languages, no English left in `id` (test/opac-messages.test.ts). The protocol's own answers (its error texts)
// are English and live in oai/protocol.ts: a harvester reads them, and `lang` is no OAI-PMH argument. This file holds
// the one text a person may read: the plain-text 503 while OAI-PMH is off or has no admin e-mail.

export const OAI_MESSAGES = defineOpacMessages(
  {
    'oai.unavailable':
      'Layanan OAI-PMH perpustakaan ini belum aktif. Pengelola perlu mengaktifkannya dan mengisi e-mail admin OAI di Pengaturan › OPAC.',
  },
  {
    'oai.unavailable':
      "This library's OAI-PMH service is not enabled. An administrator needs to turn it on and fill in the OAI admin e-mail under Settings › OPAC.",
  },
);
