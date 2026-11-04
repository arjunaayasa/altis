// A source of the ISBN lookup (Phase 2 spec §6.3, §6.4; plan Task 32): something that, given an ISBN-13, answers the
// drafts of the records it holds for it. The community edition has one adapter, an SRU server (sru-source.ts,
// `sru:<serverId>`); the record source value `isbn:arsya` stays accepted for data compatibility. lookupIsbn
// (lookup.ts) asks the sources in parallel within its time budget and merges what they answer.

import type { RecordDraft } from '@altis/shared/api/catalog/record-data';

/**
 * One source of the ISBN lookup. `id` is the value a save puts in `RecordCreateBody.source` (`sru:<serverId>`; the
 * reserved `isbn:arsya` is never a source here). `lookup` answers the drafts it holds for `isbn13` (13 digits), never
 * stored; it must stop when `signal` aborts (the lookup's per-source and overall budgets) and reject with a DomainError
 * (`CATALOG_OUTBOUND_BLOCKED`, `CATALOG_OUTBOUND_FAILED`, `CATALOG_SRU_INVALID`) when it cannot answer.
 */
export interface IsbnSource {
  id: string;
  lookup(isbn13: string, signal: AbortSignal): Promise<RecordDraft[]>;
}

/** What maps a MARC leader's type (06) and level (07) to a material type code (null: the default type). */
export type MarcMaterialTypeFn = (leader06: string, leader07: string) => string | null;
