import type { CatalogAgentType, CatalogSubjectType } from '../../../catalog/data/authorities.js';

// The types of SLiMS authorities (Phase 2 spec §11.4; plan Task 37): `mst_author.authority_type` `p`/`o`/`c` as the
// agent types person, organization and meeting, and `mst_topic.topic_type` `t`/`g`/`n`/`tm`/`gr`/`oc` as the six subject
// types. A code outside these (copy cataloguing leaves `o` and `c` in topics, an import may leave anything) is
// `valid: false`: the stage files it under the default type (person, topic) and reports it.

const AGENT_TYPES: Readonly<Record<string, CatalogAgentType>> = Object.freeze({ p: 'person', o: 'organization', c: 'meeting' });

const SUBJECT_TYPES: Readonly<Record<string, CatalogSubjectType>> = Object.freeze({
  t: 'topic',
  g: 'geographic',
  n: 'name',
  tm: 'temporal',
  gr: 'genre',
  oc: 'occupation',
});

/** The agent type of a SLiMS authority type code (trimmed, any case); an unknown or empty code → person, not valid. */
export function agentTypeOf(code: string | null): { type: CatalogAgentType; valid: boolean } {
  const c = (code ?? '').trim().toLowerCase();
  return Object.hasOwn(AGENT_TYPES, c) ? { type: AGENT_TYPES[c]!, valid: true } : { type: 'person', valid: false };
}

/** The subject type of a SLiMS topic type code (trimmed, any case); an unknown or empty code → topic, not valid. */
export function subjectTypeOf(code: string | null): { type: CatalogSubjectType; valid: boolean } {
  const c = (code ?? '').trim().toLowerCase();
  return Object.hasOwn(SUBJECT_TYPES, c) ? { type: SUBJECT_TYPES[c]!, valid: true } : { type: 'topic', valid: false };
}
