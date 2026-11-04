import type { AgentView, OrphansResponse, PublisherView, SubjectView } from '@altis/shared/api/catalog/authorities';
import type { Paged } from '@altis/shared/api/catalog/common';

// Fixtures of the Otoritas screen tests (Phase 2 Task 26): authority views as `GET catalog/{agents|subjects|publishers}`
// answers them (Task 13), and a page of a keyset list.

export const AGENT_PRAM_ID = '01JZ00000000000000000000A1';
export const AGENT_PRAM2_ID = '01JZ00000000000000000000A2';
export const AGENT_BALAI_ID = '01JZ00000000000000000000A3';
export const SUBJECT_SEJARAH_INDONESIA_ID = '01JZ00000000000000000000S1';
export const SUBJECT_SEJARAH_ID = '01JZ00000000000000000000S2';
export const SUBJECT_ARKEOLOGI_ID = '01JZ00000000000000000000S3';
export const PUBLISHER_GRAMEDIA_ID = '01JZ00000000000000000000P1';

const CREATED = 1_760_000_000_000;

export function agent(o: Partial<AgentView> & Pick<AgentView, 'id' | 'name'>): AgentView {
  return {
    type: 'person',
    dates: null,
    authoritySource: null,
    authorityRef: null,
    note: null,
    usage: 0,
    mergedInto: null,
    archived: false,
    version: 1,
    createdAt: CREATED,
    updatedAt: null,
    ...o,
  };
}

export function subject(o: Partial<SubjectView> & Pick<SubjectView, 'id' | 'term'>): SubjectView {
  return {
    type: 'topic',
    classification: null,
    scopeNote: null,
    authoritySource: null,
    relations: [],
    cycles: [],
    usage: 0,
    mergedInto: null,
    archived: false,
    version: 1,
    createdAt: CREATED,
    updatedAt: null,
    ...o,
  };
}

export function publisher(o: Partial<PublisherView> & Pick<PublisherView, 'id' | 'name'>): PublisherView {
  return { place: null, usage: 0, mergedInto: null, archived: false, version: 1, createdAt: CREATED, updatedAt: null, ...o };
}

export const AGENT_PRAM = agent({ id: AGENT_PRAM_ID, name: 'Toer, Pramoedya Ananta', dates: '1925-2006', usage: 3, version: 3 });
export const AGENT_PRAM2 = agent({ id: AGENT_PRAM2_ID, name: 'Toer, Pramoedya A.', usage: 1, version: 2 });
export const AGENT_BALAI = agent({ id: AGENT_BALAI_ID, name: 'Balai Pustaka', type: 'organization', usage: 7 });

export const SUBJECT_SEJARAH_INDONESIA = subject({
  id: SUBJECT_SEJARAH_INDONESIA_ID,
  term: 'Sejarah Indonesia',
  usage: 4,
  version: 5,
  relations: [{ rel: 'rt', subjectId: SUBJECT_ARKEOLOGI_ID, term: 'Arkeologi', type: 'topic' }],
});
export const SUBJECT_SEJARAH = subject({ id: SUBJECT_SEJARAH_ID, term: 'Sejarah', usage: 12 });
export const SUBJECT_ARKEOLOGI = subject({ id: SUBJECT_ARKEOLOGI_ID, term: 'Arkeologi', usage: 2 });

export const PUBLISHER_GRAMEDIA = publisher({ id: PUBLISHER_GRAMEDIA_ID, name: 'Gramedia Pustaka Utama', place: 'Jakarta', usage: 40, version: 4 });

/** One page of a keyset list. */
export function paged<T>(items: T[], nextCursor: string | null = null): Paged<T> {
  return { items, nextCursor };
}

/** `n` orphan agents with ids `01JZORPHAN…<n>` (zero-padded), labels `Yatim <n>`. */
export function orphanAgents(from: number, count: number): OrphansResponse['items'] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(from + i).padStart(4, '0');
    return { id: `01JZ0RPHAN00000000000${n}X`.slice(0, 26), label: `Yatim ${from + i}`, type: 'person' as const };
  });
}

/** The first wait of a test: it covers the lazy screen's first import, slow on a busy machine (as pages.test.tsx). */
export const FIRST = { timeout: 10_000 };
