// The catalog's `authorities` barrel (Phase 2 Task 13): names (agents), subjects with their reciprocal thesaurus,
// publishers, merge and orphans. Only the names of the task's interface (M14; packages/core/test/barrels.test.ts): the
// usage counts, the row lock and the text helpers stay internal.
export { createAgent, getAgent, listAgents, updateAgent } from './agents.js';
export type { AuthorityCreateResult, AuthorityUpdateResult } from './agents.js';
export { createSubject, listSubjects, updateSubject } from './subjects.js';
export { getSubject, setSubjectRelations } from './thesaurus.js';
export { createPublisher, getPublisher, listPublishers, updatePublisher } from './publishers.js';
export { archiveAuthority } from './archive.js';
export { mergeAuthority } from './merge.js';
export { archiveOrphans, listOrphans } from './orphans.js';
