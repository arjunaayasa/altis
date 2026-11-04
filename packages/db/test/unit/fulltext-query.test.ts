import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
  type DialectAdapter,
  type Expression,
  type QueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { fullTextFamily, PG_SEARCH_VECTOR_SQL } from '../../src/fulltext.js';
import { fullTextExcluded, fullTextRanked, fullTextWhere, type FtExpr } from '../../src/fulltext-query.js';

// The query side of the registered full-text helpers (Phase 2 spec §4.3, Task 15), compiled for each family without a
// server: SQLite runs them for real in packages/core/test/db/search-*.test.ts; the InnoDB and PostgreSQL strings are
// pinned here, and Task 39 runs them on MariaDB and PostgreSQL (§4.3: result sets compared across dialects).

function compilerFor(adapter: DialectAdapter, compiler: () => QueryCompiler, introspector: (db: Kysely<unknown>) => unknown) {
  return new Kysely<unknown>({
    dialect: {
      createAdapter: () => adapter,
      createDriver: () => new DummyDriver(),
      createIntrospector: introspector as never,
      createQueryCompiler: compiler,
    },
  });
}

const pg = compilerFor(new PostgresAdapter(), () => new PostgresQueryCompiler(), (db) => new PostgresIntrospector(db));
const mysql = compilerFor(new MysqlAdapter(), () => new MysqlQueryCompiler(), (db) => new MysqlIntrospector(db));
const sqlite = compilerFor(new SqliteAdapter(), () => new SqliteQueryCompiler(), (db) => new SqliteIntrospector(db));

const compiled = (db: Kysely<unknown>, e: Expression<unknown>) => {
  const c = sql`${e}`.compile(db);
  return { sql: c.sql, parameters: c.parameters };
};

/** `laskar (pelangi OR edensor) "sang pemimpi" pengarang:hirata* ` as the search builds it. */
const EXPR: FtExpr = {
  kind: 'and',
  items: [
    { kind: 'term', token: 'laskar' },
    { kind: 'or', items: [{ kind: 'term', token: 'pelangi' }, { kind: 'term', token: 'edensor' }] },
    { kind: 'phrase', tokens: ['sang', 'pemimpi'] },
    { kind: 'term', token: 'hirata', prefix: true, field: 't_agents' },
  ],
};

const VECTOR = PG_SEARCH_VECTOR_SQL.compile(pg).sql;

describe('fullTextWhere', () => {
  it('SQLite: the FTS5 rowids of one MATCH, a field as a column filter', () => {
    expect(fullTextFamily(sqlite)).toBe('fts5');
    expect(compiled(sqlite, fullTextWhere('fts5', 'all', EXPR))).toEqual({
      sql: '"search_doc"."doc_no" IN (SELECT rowid FROM "search_fts" WHERE "search_fts" MATCH ?)',
      parameters: ['("laskar" AND ("pelangi" OR "edensor") AND "sang pemimpi" AND {t_agents} : "hirata" *)'],
    });
    expect(compiled(sqlite, fullTextWhere('fts5', 't_title', { kind: 'term', token: 'laskar' })).parameters).toEqual(['{t_title} : "laskar"']);
  });

  it('PostgreSQL: the index expression @@ to_tsquery(simple), a field as its weight label', () => {
    expect(compiled(pg, fullTextWhere('pg', 'all', EXPR))).toEqual({
      sql: `${VECTOR} @@ to_tsquery('simple', $1)`,
      // Task 39: a phrase of the whole document stays inside one column (the vector runs on from one into the next).
      parameters: [
        "('laskar' & ('pelangi' | 'edensor') & (('sang':A <-> 'pemimpi':A) | ('sang':B <-> 'pemimpi':B) | ('sang':C <-> 'pemimpi':C) | ('sang':D <-> 'pemimpi':D)) & 'hirata':*B)",
      ],
    });
    expect(compiled(pg, fullTextWhere('pg', 't_title', { kind: 'phrase', tokens: ['laskar', 'pelangi'] })).parameters).toEqual([
      "('laskar':A <-> 'pelangi':A)",
    ]);
    expect(compiled(pg, fullTextWhere('pg', 't_subjects', { kind: 'term', token: 'novel' })).parameters).toEqual(["'novel':C"]);
  });

  it('InnoDB: one boolean-mode MATCH per field over exactly the columns of its FULLTEXT index', () => {
    expect(compiled(mysql, fullTextWhere('innodb', 'all', EXPR))).toEqual({
      sql:
        '(MATCH (`search_doc`.`t_title`, `search_doc`.`t_agents`, `search_doc`.`t_subjects`, `search_doc`.`t_rest`) AGAINST (? IN BOOLEAN MODE)' +
        ' AND MATCH (`search_doc`.`t_agents`) AGAINST (? IN BOOLEAN MODE))',
      parameters: ['+laskar +(pelangi edensor) +"sang pemimpi"', '+hirata*'],
    });
    expect(compiled(mysql, fullTextWhere('innodb', 't_title', { kind: 'term', token: 'laskar' }))).toEqual({
      sql: 'MATCH (`search_doc`.`t_title`) AGAINST (? IN BOOLEAN MODE)',
      parameters: ['+laskar'],
    });
    // An OR across two fields is two MATCHes ORed in SQL.
    const across: FtExpr = { kind: 'or', items: [{ kind: 'term', token: 'laskar', field: 't_title' }, { kind: 'term', token: 'hirata', field: 't_agents' }] };
    expect(compiled(mysql, fullTextWhere('innodb', 'all', across))).toEqual({
      sql: '(MATCH (`search_doc`.`t_title`) AGAINST (? IN BOOLEAN MODE) OR MATCH (`search_doc`.`t_agents`) AGAINST (? IN BOOLEAN MODE))',
      parameters: ['+laskar', '+hirata'],
    });
  });

  it('refuses a token that is not 1-84 letters or digits, an empty phrase or group, an unknown field', () => {
    for (const bad of [
      { kind: 'term', token: 'a"b' },
      { kind: 'term', token: '' },
      { kind: 'term', token: 'x'.repeat(85) },
      { kind: 'term', token: 'a b' },
      { kind: 'phrase', tokens: [] },
      { kind: 'and', items: [] },
      { kind: 'term', token: 'ok', field: 't_rest' },
      { kind: 'not', item: { kind: 'term', token: 'ok' } },
    ]) {
      expect(() => fullTextWhere('fts5', 'all', bad as FtExpr), JSON.stringify(bad)).toThrow(TypeError);
    }
  });
});

describe('fullTextExcluded', () => {
  it('doc_no NOT IN the matching documents, read from the index on every family', () => {
    const novel: FtExpr = { kind: 'term', token: 'novel' };
    expect(compiled(sqlite, fullTextExcluded('fts5', 'all', novel)).sql).toBe(
      '"search_doc"."doc_no" NOT IN (SELECT rowid FROM "search_fts" WHERE "search_fts" MATCH ?)',
    );
    expect(compiled(pg, fullTextExcluded('pg', 'all', novel)).sql).toBe(
      `"search_doc"."doc_no" NOT IN (SELECT "ftx"."doc_no" FROM "search_doc" AS "ftx" WHERE ${VECTOR} @@ to_tsquery('simple', $1))`,
    );
    expect(compiled(mysql, fullTextExcluded('innodb', 'all', novel)).sql).toBe(
      '`search_doc`.`doc_no` NOT IN (SELECT `ftx`.`doc_no` FROM `search_doc` AS `ftx` WHERE MATCH (`ftx`.`t_title`, `ftx`.`t_agents`, `ftx`.`t_subjects`, `ftx`.`t_rest`) AGAINST (? IN BOOLEAN MODE))',
    );
  });
});

describe('fullTextRanked', () => {
  const laskar: FtExpr = { kind: 'term', token: 'laskar' };

  it('SQLite: rowid and -bm25(search_fts, 10, 5, 3, 1) of the MATCH query itself', () => {
    expect(compiled(sqlite, fullTextRanked('fts5', 'all', laskar))).toEqual({
      sql: 'SELECT rowid AS "doc_no", -bm25("search_fts", 10, 5, 3, 1) AS "score" FROM "search_fts" WHERE "search_fts" MATCH ?',
      parameters: ['"laskar"'],
    });
  });

  it('PostgreSQL: ts_rank_cd over the index expression', () => {
    expect(compiled(pg, fullTextRanked('pg', 'all', laskar)).sql).toBe(
      `SELECT "ftr"."doc_no" AS "doc_no", ts_rank_cd(${VECTOR}, to_tsquery('simple', $1)) AS "score" FROM "search_doc" AS "ftr" WHERE ${VECTOR} @@ to_tsquery('simple', $2)`,
    );
  });

  it('InnoDB: 3 × title + 2 × agents + 1.5 × subjects + all, each a MATCH of the tokens without operators', () => {
    const c = compiled(mysql, fullTextRanked('innodb', 'all', EXPR));
    expect(c.sql).toBe(
      'SELECT `ftr`.`doc_no` AS `doc_no`, (3 * MATCH (`ftr`.`t_title`) AGAINST (? IN BOOLEAN MODE) + 2 * MATCH (`ftr`.`t_agents`) AGAINST (? IN BOOLEAN MODE)' +
        ' + 1.5 * MATCH (`ftr`.`t_subjects`) AGAINST (? IN BOOLEAN MODE) + MATCH (`ftr`.`t_title`, `ftr`.`t_agents`, `ftr`.`t_subjects`, `ftr`.`t_rest`) AGAINST (? IN BOOLEAN MODE)) AS `score`' +
        ' FROM `search_doc` AS `ftr` WHERE (MATCH (`ftr`.`t_title`, `ftr`.`t_agents`, `ftr`.`t_subjects`, `ftr`.`t_rest`) AGAINST (? IN BOOLEAN MODE) AND MATCH (`ftr`.`t_agents`) AGAINST (? IN BOOLEAN MODE))',
    );
    expect(c.parameters.slice(0, 4)).toEqual(Array(4).fill('laskar pelangi edensor "sang pemimpi" hirata*'));
  });
});
