import { THESAURUS_RECIPROCAL, type ThesaurusRel } from '@altis/shared';

// The thesaurus of SLiMS (Phase 2 spec §11.4; plan Task 37): `mst_voc_ctrl.rt_id` (and the codes `mst_relation_term`
// lists) as the relations of `subject_relations`: U/UF/BT/NT/RT/SA → use/uf/bt/nt/rt/sa. Any other code (a library may
// add its own) becomes `rt`, the loosest relation, and is reported (`valid: false`). Each relation is written with its
// reciprocal (§3.5: use↔uf, bt↔nt, rt↔rt, sa↔sa), as the subjects service does.

const RELS: Readonly<Record<string, ThesaurusRel>> = Object.freeze({ U: 'use', UF: 'uf', BT: 'bt', NT: 'nt', RT: 'rt', SA: 'sa' });

/** The relation of a SLiMS relation code (trimmed, any case); another code → `rt`, not valid. */
export function thesaurusRelOf(code: string | null): { rel: ThesaurusRel; valid: boolean } {
  const c = (code ?? '').trim().toUpperCase();
  return Object.hasOwn(RELS, c) ? { rel: RELS[c]!, valid: true } : { rel: 'rt', valid: false };
}

/** The relation written back for `rel` (§3.5). */
export function reciprocalRel(rel: ThesaurusRel): ThesaurusRel {
  return THESAURUS_RECIPROCAL[rel];
}
