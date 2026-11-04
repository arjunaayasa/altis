/**
 * The copy-cataloguing API vocabulary (Phase 2 spec §6.2-§6.4, §12.2; plan Tasks 28, 32): ISBN lookup and SRU search
 * (drafts, never stored), and the SRU server test of the settings screen. Outbound calls never run inside a
 * transaction; a blocked or failed one is `CATALOG_OUTBOUND_BLOCKED` / `CATALOG_OUTBOUND_FAILED`.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/catalog/copy`.
 */
import { z } from 'zod';
import type { ErrorCode } from '../../errors.js';
import { httpUrlField, settingIdField, shortText } from './common.js';
import type { RecordDraft } from './record-data.js';

/** A stored record that already holds the draft's ISBN, with its duplicate score (§3.3). */
export interface DuplicateHint {
  recordId: string;
  score: number;
}

/**
 * `GET catalog/lookup/isbn/:isbn` (§6.3): the record that already has this ISBN (`local`, and no source is asked), or
 * the candidates of every enabled source (≤ 10, deduplicated by ISBN), with each source's failure in `errors`.
 */
export interface IsbnLookupResponse {
  /** The ISBN normalised to 13 digits. */
  isbn13: string;
  local: { recordId: string; title: string } | null;
  /** `source` is `sru:<serverId>` or `isbn:arsya`, the value a save puts in `RecordCreateBody.source`. */
  candidates: { source: string; draft: RecordDraft; duplicate: DuplicateHint | null }[];
  errors: { source: string; code: string }[];
}

/** The SRU indexes the dialog offers; each server maps them to its own CQL index (`catalog.sru.servers`). */
export const SRU_INDEXES = Object.freeze(['isbn', 'title', 'author', 'any'] as const);

export type SruIndex = (typeof SRU_INDEXES)[number];

/** `GET catalog/sru/search?server=&index=&q=&start=`: one page of 20 records from an enabled server. */
export const SruSearchQuery = z.strictObject({
  server: settingIdField,
  index: z.enum(SRU_INDEXES),
  q: shortText(200).min(1),
  start: z.coerce.number().int().min(1).optional(),
});

export type SruSearchQuery = z.infer<typeof SruSearchQuery>;

/** One page of an SRU search; `start` is the position of the first record (1-based). */
export interface SruSearchResponse {
  total: number;
  start: number;
  records: { draft: RecordDraft; duplicate: DuplicateHint | null }[];
}

/** The SRU versions a server may speak. */
export const SRU_VERSIONS = Object.freeze(['1.1', '1.2', '2.0'] as const);

export type SruVersion = (typeof SRU_VERSIONS)[number];

/** `POST catalog/sru/test`: try an SRU base URL before saving it (`catalog.sru.servers` holds ≤ 500-character URLs). */
export const SruTestBody = z.strictObject({ url: httpUrlField(500), version: z.enum(SRU_VERSIONS) });

export type SruTestBody = z.infer<typeof SruTestBody>;

/**
 * The answer of the test, always 200 (decision P2-17): `ok`, or the error `code` with the server's own message cut to
 * 200 characters; `version` is the one the server reported.
 */
export interface SruTestResponse {
  ok: boolean;
  code?: ErrorCode;
  message?: string;
  version?: string;
}
