import { newId } from '@altis/shared';
import type { RecordCreateBody } from '@altis/shared/api/catalog/records';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import {
  archiveAuthority,
  archiveOrphans,
  createAgent,
  createPublisher,
  createSubject,
  getAgent,
  getSubject,
  listAgents,
  listOrphans,
  listSubjects,
  mergeAuthority,
  setSubjectRelations,
  updateAgent,
  updatePublisher,
  updateSubject,
} from '../../src/catalog/authorities/index.js';
import { createRecord } from '../../src/catalog/records/index.js';
import { NOW, failure, fieldErrors, openRecordsDb, type RecordsDb } from './catalog-records-support.js';

// Phase 2 Task 13: the authorities (spec §2.2, §3.5): names (agents), subjects with their reciprocal thesaurus,
// publishers, merge, orphans. On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`authorities [${engineLabel()}]`, () => {
  let db: RecordsDb;
  let buku: string;
  let serial = 0;

  /** A name of its own, so that the tests never share a key. */
  const unique = (base: string): string => `${base} ${(serial += 1)}`;

  const agent = async (name: string, type: 'person' | 'organization' | 'meeting' = 'person') =>
    (await db.run((tx) => createAgent(tx, { type, name }))).view;
  const subject = async (term: string, type: 'topic' | 'geographic' = 'topic') =>
    (await db.run((tx) => createSubject(tx, { type, term }))).view;
  const publisher = async (name: string) => (await db.run((tx) => createPublisher(tx, { name }))).view;
  const record = async (over: Partial<RecordCreateBody> = {}): Promise<string> =>
    (await db.run((tx) => createRecord(tx, { materialTypeId: buku, title: unique('Bumi Manusia'), ...over }))).id;
  const relationsOf = async (id: string) =>
    (await db.h.db.selectFrom('subject_relations').select(['related_id', 'rel']).where('subject_id', '=', id).orderBy('rel').orderBy('related_id').execute()).map(
      (r) => `${r.rel}:${r.related_id}`,
    );
  const row = (table: 'agents' | 'subjects' | 'publishers', id: string) =>
    db.h.db
      .selectFrom(table as 'agents')
      .select(['merged_into', 'archived_at', 'version'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const auditRows = (action: string) =>
    db.h.db.selectFrom('audit_log').select(['entity', 'entity_id', 'meta']).where('action', '=', action).orderBy('seq').execute();

  beforeAll(async () => {
    db = await openRecordsDb('authorities');
    buku = await db.materialTypeId('BUKU');
  });

  afterAll(async () => {
    await db?.close();
  });

  describe('agents, subjects, publishers: create, update, archive', () => {
    it('create → the view with usage 0 and version 0; the same (type, key) again → taken at name; another type is free', async () => {
      const name = unique('Toer, Pramoedya Ananta');
      const created = await db.run((tx) => createAgent(tx, { type: 'person', name: `  ${name} `, dates: '1925-2006' }));
      expect(created).toMatchObject({ revived: false, reindex: false });
      expect(created.view).toMatchObject({ type: 'person', name, dates: '1925-2006', usage: 0, mergedInto: null, archived: false, version: 0 });
      expect(await fieldErrors(db.run((tx) => createAgent(tx, { type: 'person', name: name.toUpperCase(), dates: '1925-2006' })))).toEqual([
        { path: 'name', code: 'taken' },
      ]);
      // Other dates or another type: another key.
      expect((await db.run((tx) => createAgent(tx, { type: 'person', name }))).view.dates).toBeNull();
      expect((await db.run((tx) => createAgent(tx, { type: 'organization', name, dates: '1925-2006' }))).view.type).toBe('organization');
      const audit = (await auditRows('catalog.authority.create')).filter((r) => r.entity_id === created.view.id);
      expect(audit.map((r) => ({ entity: r.entity, meta: JSON.parse(r.meta) }))).toEqual([
        { entity: 'agents', meta: { fields: ['type', 'name', 'dates'], revived: false } },
      ]);
    });

    it('create of an archived (unmerged) one brings it back (as resolve* does); of a merged one → taken', async () => {
      const name = unique('Balai Pustaka');
      const archived = await publisher(name);
      await db.run((tx) => archiveAuthority(tx, 'publishers', archived.id, 0));
      const again = await db.run((tx) => createPublisher(tx, { name: name.toLowerCase(), place: 'Jakarta' }));
      expect(again).toMatchObject({ revived: true, reindex: true });
      expect(again.view).toMatchObject({ id: archived.id, name: name.toLowerCase(), place: 'Jakarta', archived: false, version: 2 });

      const source = await agent(unique('Chairil Anwar'));
      const target = await agent(unique('Anwar, Chairil'));
      await db.run((tx) => mergeAuthority(tx, 'agents', source.id, target.id, 0));
      expect(await fieldErrors(db.run((tx) => createAgent(tx, { type: 'person', name: source.name })))).toEqual([{ path: 'name', code: 'taken' }]);
    });

    it('update: a rename → reindex true and a new key; a note only → reindex false; a stale version → CONFLICT_STALE; a taken key → taken', async () => {
      const a = await agent(unique('Hamka'));
      const renamed = await db.run((tx) => updateAgent(tx, a.id, { version: 0, name: `${a.name} (Haji)` }));
      expect(renamed).toMatchObject({ reindex: true, view: { name: `${a.name} (Haji)`, version: 1 } });
      const noted = await db.run((tx) => updateAgent(tx, a.id, { version: 1, note: 'Ulama dan sastrawan' }));
      expect(noted).toMatchObject({ reindex: false, view: { note: 'Ulama dan sastrawan', version: 2 } });
      const typed = await db.run((tx) => updateAgent(tx, a.id, { version: 2, type: 'organization' }));
      expect(typed.reindex).toBe(true);
      expect(await failure(db.run((tx) => updateAgent(tx, a.id, { version: 0, note: 'x' })))).toEqual({ code: 'CONFLICT_STALE' });
      const other = await agent(unique('Rendra'), 'organization');
      expect(await fieldErrors(db.run((tx) => updateAgent(tx, a.id, { version: 3, name: other.name })))).toEqual([{ path: 'name', code: 'taken' }]);

      const s = await subject(unique('Sastra Indonesia'));
      expect((await db.run((tx) => updateSubject(tx, s.id, { version: 0, scopeNote: 'Karya sastra' }))).reindex).toBe(false);
      expect((await db.run((tx) => updateSubject(tx, s.id, { version: 1, term: `${s.term} Modern` }))).reindex).toBe(true);
      const p = await publisher(unique('Gramedia'));
      // C08: the index holds the subject's classification (t_subjects) and the publisher's place (t_rest), so a change
      // of either re-indexes the linked records too.
      expect((await db.run((tx) => updateSubject(tx, s.id, { version: 2, classification: '899.221' }))).reindex).toBe(true);
      expect((await db.run((tx) => updatePublisher(tx, p.id, { version: 0, place: 'Jakarta' }))).reindex).toBe(true);
      expect((await db.run((tx) => updatePublisher(tx, p.id, { version: 1, name: `${p.name} Pustaka Utama` }))).reindex).toBe(true);
      expect(await failure(db.run((tx) => updateAgent(tx, newId(), { version: 0, note: 'x' })))).toEqual({ code: 'NOT_FOUND' });
    });

    it('archive: in use by a live record → 409 CATALOG_IN_USE with meta.count; unused → archived; again → answered as it is', async () => {
      const a = await agent(unique('Dini, Nh.'));
      await record({ agents: [{ ref: { id: a.id }, role: 'aut', isMain: true }] });
      await record({ agents: [{ ref: { id: a.id }, role: 'aut', isMain: true }, { ref: { id: a.id }, role: 'ill', isMain: false }] });
      expect((await getAgent(db.h.db, a.id)).usage).toBe(2);
      expect(await failure(db.run((tx) => archiveAuthority(tx, 'agents', a.id, 0)))).toEqual({ code: 'CATALOG_IN_USE', meta: { count: 2 } });

      const free = await subject(unique('Puisi'));
      expect(await db.run((tx) => archiveAuthority(tx, 'subjects', free.id, 0))).toEqual({ version: 1 });
      expect(await row('subjects', free.id)).toMatchObject({ archived_at: NOW, version: 1 });
      expect(await db.run((tx) => archiveAuthority(tx, 'subjects', free.id, 1))).toEqual({ version: 1 });
      const entries = (await auditRows('catalog.authority.archive')).filter((r) => r.entity_id === free.id).map((r) => JSON.parse(r.meta));
      expect(entries).toEqual([{}, { alreadyArchived: true }]);
    });

    it('lists: by key, live only unless includeArchived, `q` as a substring of the key, `type`, keyset cursor', async () => {
      const tag = `Lst${newId().slice(-6)}`;
      const names = ['Cc', 'Aa', 'Bb'].map((n) => `${tag} ${n}`);
      const views: { id: string }[] = [];
      for (const n of names) views.push(await agent(n));
      await agent(`${tag} Dd`, 'organization');
      await db.run((tx) => archiveAuthority(tx, 'agents', views[0]!.id, 0));

      const first = await listAgents(db.h.db, { q: tag.toLowerCase(), type: 'person', limit: 1 });
      expect(first.items.map((i) => i.name)).toEqual([`${tag} Aa`]);
      expect(first.nextCursor).not.toBeNull();
      const second = await listAgents(db.h.db, { q: tag, type: 'person', limit: 1, cursor: first.nextCursor! });
      expect(second.items.map((i) => i.name)).toEqual([`${tag} Bb`]);
      expect(second.nextCursor).toBeNull();
      const all = await listAgents(db.h.db, { q: tag, includeArchived: true, limit: 50 });
      expect(all.items.map((i) => i.name)).toEqual([`${tag} Aa`, `${tag} Bb`, `${tag} Cc`, `${tag} Dd`]);
      expect(all.items[2]).toMatchObject({ archived: true, usage: 0 });
      // A wildcard in `q` is literal.
      expect((await listAgents(db.h.db, { q: '%', limit: 50 })).items).toEqual([]);
      expect(await fieldErrors(listAgents(db.h.db, { type: 'topic', limit: 5 }))).toEqual([{ path: 'type', code: 'invalid_value' }]);
      expect(await fieldErrors(listAgents(db.h.db, { cursor: 'k.nope', limit: 5 }))).toEqual([{ path: 'cursor', code: 'invalid' }]);
    });
  });

  describe('thesaurus (§3.5): reciprocal relations in the same transaction', () => {
    it('setting bt A→B creates B nt A; removing it removes both', async () => {
      const a = await subject(unique('Kucing'));
      const b = await subject(unique('Hewan Peliharaan'));
      const view = await db.run((tx) => setSubjectRelations(tx, a.id, [{ rel: 'bt', subjectId: b.id }], 0));
      expect(view).toMatchObject({ id: a.id, version: 1, relations: [{ rel: 'bt', subjectId: b.id, term: b.term, type: 'topic' }], cycles: [] });
      expect(await relationsOf(a.id)).toEqual([`bt:${b.id}`]);
      expect(await relationsOf(b.id)).toEqual([`nt:${a.id}`]);
      // The other end changed too: its version moves on, so an editor holding the old one reloads.
      expect((await row('subjects', b.id)).version).toBe(1);
      expect((await getSubject(db.h.db, b.id)).relations).toEqual([{ rel: 'nt', subjectId: a.id, term: a.term, type: 'topic' }]);

      await db.run((tx) => setSubjectRelations(tx, a.id, [], 1));
      expect(await relationsOf(a.id)).toEqual([]);
      expect(await relationsOf(b.id)).toEqual([]);
      const entries = (await auditRows('catalog.authority.update')).filter((r) => r.entity_id === a.id).map((r) => JSON.parse(r.meta));
      expect(entries).toEqual([
        { fields: ['relations'], added: 1, removed: 0 },
        { fields: ['relations'], added: 0, removed: 1 },
      ]);
    });

    it('use A→B creates B uf A; rt is symmetric; sa too', async () => {
      const a = await subject(unique('Ilmu Hayat'));
      const b = await subject(unique('Biologi'));
      const c = await subject(unique('Zoologi'));
      await db.run((tx) =>
        setSubjectRelations(
          tx,
          a.id,
          [
            { rel: 'use', subjectId: b.id },
            { rel: 'rt', subjectId: c.id },
          ],
          0,
        ),
      );
      expect(await relationsOf(b.id)).toEqual([`uf:${a.id}`]);
      expect(await relationsOf(c.id)).toEqual([`rt:${a.id}`]);
      await db.run((tx) => setSubjectRelations(tx, c.id, [{ rel: 'rt', subjectId: a.id }, { rel: 'sa', subjectId: b.id }], 1));
      expect(await relationsOf(a.id)).toEqual([`rt:${c.id}`, `use:${b.id}`].sort());
      expect(await relationsOf(b.id)).toEqual([`sa:${c.id}`, `uf:${a.id}`].sort());
    });

    it('a relation to itself → self; an unknown subject → not_found; a stale version → CONFLICT_STALE; nothing written', async () => {
      const a = await subject(unique('Geologi'));
      const b = await subject(unique('Vulkanologi'));
      expect(
        await fieldErrors(
          db.run((tx) =>
            setSubjectRelations(
              tx,
              a.id,
              [
                { rel: 'nt', subjectId: b.id },
                { rel: 'rt', subjectId: a.id },
                { rel: 'sa', subjectId: newId() },
              ],
              0,
            ),
          ),
        ),
      ).toEqual([
        { path: 'relations.1.subjectId', code: 'self' },
        { path: 'relations.2.subjectId', code: 'not_found' },
      ]);
      expect(await relationsOf(b.id)).toEqual([]);
      expect(await failure(db.run((tx) => setSubjectRelations(tx, a.id, [], 5)))).toEqual({ code: 'CONFLICT_STALE' });
    });

    it('a BT cycle A→B→A is allowed and reported in cycles of both', async () => {
      const a = await subject(unique('Siklus A'));
      const b = await subject(unique('Siklus B'));
      await db.run((tx) => setSubjectRelations(tx, a.id, [{ rel: 'bt', subjectId: b.id }], 0));
      // B keeps its reciprocal `nt A` and adds `bt A`: A is now broader and narrower than B.
      const bView = await db.run((tx) =>
        setSubjectRelations(
          tx,
          b.id,
          [
            { rel: 'nt', subjectId: a.id },
            { rel: 'bt', subjectId: a.id },
          ],
          1,
        ),
      );
      expect(bView.cycles).toEqual([[b.id, a.id, b.id]]);
      expect((await getSubject(db.h.db, a.id)).cycles).toEqual([[a.id, b.id, a.id]]);
      const listed = await listSubjects(db.h.db, { q: 'Siklus', limit: 50 });
      expect(listed.items.find((s) => s.id === a.id)?.cycles).toEqual([[a.id, b.id, a.id]]);
    });

    it('a longer cycle X→Y→Z→X is reported with every subject along it', async () => {
      const [x, y, z] = [await subject(unique('Lingkar X')), await subject(unique('Lingkar Y')), await subject(unique('Lingkar Z'))];
      await db.run((tx) => setSubjectRelations(tx, x.id, [{ rel: 'bt', subjectId: y.id }], 0));
      await db.run((tx) => setSubjectRelations(tx, y.id, [{ rel: 'nt', subjectId: x.id }, { rel: 'bt', subjectId: z.id }], 1));
      const zView = await db.run((tx) => setSubjectRelations(tx, z.id, [{ rel: 'nt', subjectId: y.id }, { rel: 'bt', subjectId: x.id }], 1));
      expect(zView.cycles).toEqual([[z.id, x.id, y.id, z.id]]);
      expect((await getSubject(db.h.db, x.id)).cycles).toEqual([[x.id, y.id, z.id, x.id]]);
    });

    it('a new relation brings an archived subject back (as resolveSubjects does); one already stored leaves it archived', async () => {
      const a = await subject(unique('Teknik'));
      const kept = await subject(unique('Teknik Sipil'));
      const back = await subject(unique('Teknik Mesin'));
      await db.run((tx) => setSubjectRelations(tx, a.id, [{ rel: 'nt', subjectId: kept.id }], 0));
      // A subject that only stands in the thesaurus may be archived; its rows stay.
      await db.run((tx) => archiveAuthority(tx, 'subjects', kept.id, 1));
      await db.run((tx) => archiveAuthority(tx, 'subjects', back.id, 0));

      // The editor sends the stored list back with one relation more.
      const view = await db.run(
        (tx) =>
          setSubjectRelations(
            tx,
            a.id,
            [
              { rel: 'nt', subjectId: kept.id },
              { rel: 'rt', subjectId: back.id },
            ],
            1,
          ),
        NOW + 70,
      );
      expect(view.relations.map((r) => `${r.rel}:${r.subjectId}`)).toEqual([`nt:${kept.id}`, `rt:${back.id}`]);
      expect(await row('subjects', kept.id)).toMatchObject({ archived_at: NOW, version: 2 });
      expect(await row('subjects', back.id)).toMatchObject({ archived_at: null });
      expect(await relationsOf(kept.id)).toEqual([`bt:${a.id}`]);
      expect(await relationsOf(back.id)).toEqual([`rt:${a.id}`]);
    });

    it('a relation to a merged subject is stored against its target', async () => {
      const a = await subject(unique('Astronomi'));
      const old = await subject(unique('Ilmu Falak'));
      const target = await subject(unique('Ilmu Bintang'));
      await db.run((tx) => mergeAuthority(tx, 'subjects', old.id, target.id, 0));
      await db.run((tx) => setSubjectRelations(tx, a.id, [{ rel: 'rt', subjectId: old.id }], 0));
      expect(await relationsOf(a.id)).toEqual([`rt:${target.id}`]);
    });
  });

  describe('merge (§3.5)', () => {
    it('a record linked to both source and target with the same role → one link afterwards; the source is archived with merged_into', async () => {
      const source = await agent(unique('Pramoedya'));
      const target = await agent(unique('Toer, Pramoedya'));
      const both = await record({
        agents: [
          { ref: { id: source.id }, role: 'aut', isMain: true },
          { ref: { id: target.id }, role: 'aut', isMain: false },
          { ref: { id: source.id }, role: 'trl', isMain: false },
        ],
      });
      const only = await record({ agents: [{ ref: { id: source.id }, role: 'aut', isMain: true }] });

      expect(await db.run((tx) => mergeAuthority(tx, 'agents', source.id, target.id, 0), NOW + 50)).toEqual({ movedLinks: 2, version: 1 });

      const links = await db.h.db
        .selectFrom('record_agents')
        .select(['record_id', 'agent_id', 'role', 'is_main'])
        .where('record_id', 'in', [both, only])
        .orderBy('record_id')
        .orderBy('role')
        .execute();
      expect(links).toEqual(
        [
          { record_id: both, agent_id: target.id, role: 'aut', is_main: 1 },
          { record_id: both, agent_id: target.id, role: 'trl', is_main: 0 },
          { record_id: only, agent_id: target.id, role: 'aut', is_main: 1 },
        ].sort((x, y) => (x.record_id === y.record_id ? 0 : x.record_id < y.record_id ? -1 : 1)),
      );
      expect(await row('agents', source.id)).toEqual({ merged_into: target.id, archived_at: NOW + 50, version: 1 });
      expect(await row('agents', target.id)).toMatchObject({ merged_into: null, archived_at: null });
      expect((await getAgent(db.h.db, target.id)).usage).toBe(2);
      const entry = (await auditRows('catalog.authority.merge')).filter((r) => r.entity_id === source.id);
      expect(entry.map((r) => ({ entity: r.entity, meta: JSON.parse(r.meta) }))).toEqual([
        { entity: 'agents', meta: { intoId: target.id, movedLinks: 2, droppedLinks: 1, movedRelations: 0, repointed: 0 } },
      ]);
    });

    it('chain A→B then B→C → A.merged_into is C (one hop); merging C into A is refused', async () => {
      const [a, b, c] = [await agent(unique('Rantai A')), await agent(unique('Rantai B')), await agent(unique('Rantai C'))];
      await db.run((tx) => mergeAuthority(tx, 'agents', a.id, b.id, 0));
      await db.run((tx) => mergeAuthority(tx, 'agents', b.id, c.id, 0));
      expect((await row('agents', a.id)).merged_into).toBe(c.id);
      expect((await row('agents', b.id)).merged_into).toBe(c.id);
      expect(await failure(db.run((tx) => mergeAuthority(tx, 'agents', c.id, a.id, 0)))).toEqual({ code: 'CATALOG_MERGE_INVALID' });
      expect(await failure(db.run((tx) => mergeAuthority(tx, 'agents', a.id, c.id, 1)))).toEqual({ code: 'CATALOG_MERGE_INVALID' });
      expect(await failure(db.run((tx) => updateAgent(tx, a.id, { version: 1, note: 'x' })))).toEqual({ code: 'CATALOG_MERGE_INVALID' });
    });

    it('a person into an organization, the same id, an archived target → CATALOG_MERGE_INVALID; a stale version → CONFLICT_STALE', async () => {
      const person = await agent(unique('Soekarno'));
      const org = await agent(unique('Panitia Persiapan'), 'organization');
      expect(await failure(db.run((tx) => mergeAuthority(tx, 'agents', person.id, org.id, 0)))).toEqual({ code: 'CATALOG_MERGE_INVALID' });
      expect(await failure(db.run((tx) => mergeAuthority(tx, 'agents', person.id, person.id, 0)))).toEqual({ code: 'CATALOG_MERGE_INVALID' });
      const gone = await agent(unique('Arsip'));
      await db.run((tx) => archiveAuthority(tx, 'agents', gone.id, 0));
      expect(await failure(db.run((tx) => mergeAuthority(tx, 'agents', person.id, gone.id, 0)))).toEqual({ code: 'CATALOG_MERGE_INVALID' });
      const other = await agent(unique('Bung Karno'));
      expect(await failure(db.run((tx) => mergeAuthority(tx, 'agents', person.id, other.id, 7)))).toEqual({ code: 'CONFLICT_STALE' });
      expect(await failure(db.run((tx) => mergeAuthority(tx, 'agents', person.id, newId(), 0)))).toEqual({ code: 'NOT_FOUND' });
    });

    it('subjects: links and thesaurus relations (with their reciprocals) move to the target; one between the two is dropped', async () => {
      const source = await subject(unique('Sepak Bola'));
      const target = await subject(unique('Sepakbola'));
      const broader = await subject(unique('Olahraga'));
      const related = await subject(unique('Futsal'));
      await db.run((tx) =>
        setSubjectRelations(
          tx,
          source.id,
          [
            { rel: 'bt', subjectId: broader.id },
            { rel: 'rt', subjectId: related.id },
            { rel: 'rt', subjectId: target.id },
          ],
          0,
        ),
      );
      await db.run((tx) => setSubjectRelations(tx, target.id, [{ rel: 'rt', subjectId: source.id }, { rel: 'bt', subjectId: broader.id }], 1));
      const both = await record({ subjects: [{ ref: { id: source.id }, isPrimary: true }, { ref: { id: target.id }, isPrimary: false }] });
      await record({ subjects: [{ ref: { id: source.id }, isPrimary: true }] });

      const sourceVersion = Number((await row('subjects', source.id)).version);
      expect(await db.run((tx) => mergeAuthority(tx, 'subjects', source.id, target.id, sourceVersion))).toEqual({
        movedLinks: 1,
        version: sourceVersion + 1,
      });
      expect(await relationsOf(source.id)).toEqual([]);
      expect(await relationsOf(target.id)).toEqual([`bt:${broader.id}`, `rt:${related.id}`].sort());
      expect(await relationsOf(broader.id)).toEqual([`nt:${target.id}`]);
      expect(await relationsOf(related.id)).toEqual([`rt:${target.id}`]);
      expect(
        await db.h.db.selectFrom('record_subjects').select(['subject_id', 'is_primary']).where('record_id', '=', both).execute(),
      ).toEqual([{ subject_id: target.id, is_primary: 1 }]);
      expect((await getSubject(db.h.db, target.id)).usage).toBe(2);
    });

    it('publishers: the records move to the target', async () => {
      const source = await publisher(unique('Penerbit Lama'));
      const target = await publisher(unique('Penerbit Baru'));
      const r1 = await record({ publisher: { id: source.id } });
      expect(await db.run((tx) => mergeAuthority(tx, 'publishers', source.id, target.id, 0))).toEqual({ movedLinks: 1, version: 1 });
      expect((await db.h.db.selectFrom('records').select('publisher_id').where('id', '=', r1).executeTakeFirstOrThrow()).publisher_id).toBe(target.id);
    });
  });

  describe('orphans (§3.5)', () => {
    it('3 unlinked agents are listed; archiving 2 of them and 1 linked one → {archived: 2, skipped: 1}, one audit entry', async () => {
      const tag = `Ytm${newId().slice(-6)}`;
      const orphans = [await agent(`${tag} 1`), await agent(`${tag} 2`), await agent(`${tag} 3`)];
      const linked = await agent(`${tag} 4`);
      await record({ agents: [{ ref: { id: linked.id }, role: 'aut', isMain: true }] });

      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await listOrphans(db.h.db, 'agents', cursor, 200);
        ids.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(orphans.every((o) => ids.includes(o.id))).toBe(true);
      expect(ids).not.toContain(linked.id);
      const first = await listOrphans(db.h.db, 'agents', undefined, 200);
      expect(first.items.find((i) => i.id === orphans[0]!.id)).toEqual({ id: orphans[0]!.id, label: `${tag} 1`, type: 'person' });

      const before = (await auditRows('catalog.authority.archive')).length;
      expect(await db.run((tx) => archiveOrphans(tx, 'agents', [orphans[0]!.id, orphans[1]!.id, linked.id]))).toEqual({ archived: 2, skipped: 1 });
      const after = await auditRows('catalog.authority.archive');
      expect(after.length).toBe(before + 1);
      expect({ entity: after.at(-1)!.entity, entityId: after.at(-1)!.entity_id, meta: JSON.parse(after.at(-1)!.meta) }).toEqual({
        entity: 'agents',
        entityId: null,
        meta: { kind: 'agents', count: 2 },
      });
      expect((await row('agents', orphans[0]!.id)).archived_at).toBe(NOW);
      expect((await row('agents', linked.id)).archived_at).toBeNull();
      const left = await listOrphans(db.h.db, 'agents', undefined, 200);
      expect(left.items.map((i) => i.id)).toContain(orphans[2]!.id);
      expect(left.items.map((i) => i.id)).not.toContain(orphans[0]!.id);
    });

    it('a subject in the thesaurus is no orphan; a publisher of a record is none either', async () => {
      const a = await subject(unique('Entri Rujukan'));
      const b = await subject(unique('Istilah Pilihan'));
      await db.run((tx) => setSubjectRelations(tx, a.id, [{ rel: 'use', subjectId: b.id }], 0));
      const lone = await subject(unique('Subjek Yatim'));
      const subjects = (await listOrphans(db.h.db, 'subjects', undefined, 200)).items.map((i) => i.id);
      expect(subjects).toContain(lone.id);
      expect(subjects).not.toContain(a.id);
      expect(subjects).not.toContain(b.id);
      expect(await db.run((tx) => archiveOrphans(tx, 'subjects', [a.id, lone.id]))).toEqual({ archived: 1, skipped: 1 });

      const used = await publisher(unique('Pustaka Jaya'));
      await record({ publisher: { id: used.id } });
      expect((await listOrphans(db.h.db, 'publishers', undefined, 200)).items.map((i) => i.id)).not.toContain(used.id);
    });
  });
});
