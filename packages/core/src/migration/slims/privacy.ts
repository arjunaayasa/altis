import { registerMemberErasureStep } from '../../members/ext/hooks.js';
import { memberSubjectKeyIn } from './stages/people-kit.js';

// What anonymising a member removes of the SLiMS migration: the source rows kept whole in `migration_archive` that are
// about that member (a comment, a hold or a fine that did not become an ALTIS row), found by their subject key, a keyed
// hash of the member's id, without reading their JSON. Registered when the module loads (the SLiMS migration's barrel
// imports it). The member's legacy map rows are removed by the anonymisation itself.

registerMemberErasureStep({
  name: 'slims-migration-archive',
  async run(tx, memberId) {
    await tx.trx.deleteFrom('migration_archive').where('subject_key', '=', await memberSubjectKeyIn(tx.trx, memberId)).execute();
  },
});
