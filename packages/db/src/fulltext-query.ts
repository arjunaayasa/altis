import { sql, type Expression, type Kysely, type RawBuilder, type SqlBool, type Transaction } from 'kysely';
import { PG_SEARCH_VECTOR_SQL, type FullTextFamily } from './fulltext.js';

// The query side of the registered full-text helpers (Phase 2 spec §4.3; plan Task 15): the only place where per-dialect
// full-text SQL is written for `search_doc` (its index: migration 0024, fulltext.ts). Core builds a dialect-neutral
// expression (FtExpr) out of the tokens of its tokenizer, and these helpers turn it into SQL for the family of the
// connection:
//
// - InnoDB (MySQL/MariaDB): `MATCH (<columns>) AGAINST (<boolean query> IN BOOLEAN MODE)` over the FULLTEXT index of
//   exactly those columns (`ix_search_doc_ft_all`, `_title`, `_agents`, `_subjects`). The relevance is
//   `3 × title + 2 × agents + 1.5 × subjects + all`, each a MATCH of the query's tokens (no operators).
// - PostgreSQL: `PG_SEARCH_VECTOR_SQL @@ to_tsquery('simple', …)`, the expression of the GIN index repeated through
//   its builder, a field as its weight label (`token:A` the title, `B` agents, `C` subjects); relevance `ts_rank_cd`.
//   A phrase of the whole document is ORed over the four weights, so that it stays inside one column as on the other
//   families (the vector's positions run on from one column into the next).
// - SQLite: the FTS5 table `search_fts` (`MATCH`, a field as a column filter `{t_title} : …`); relevance
//   `bm25(search_fts, 10, 5, 3, 1)`, negated so that higher is better on every family. FTS5 computes bm25 only in the
//   MATCH query itself, so the relevance comes as a derived table to join (fullTextRanked): a correlated bm25 per row
//   took 51 s for 50 000 hits where the join takes 34 ms.
//
// Every token must be letters and digits only (`[\p{L}\p{N}]`, 1–84 characters, the tokenizer's output): no token can
// then carry syntax into a MATCH string or a tsquery, which are bound as parameters anyway. A phrase holds its tokens
// in order; a prefix term matches the tokens it begins.
//
// The SQLite external-content table is not maintained by triggers: the index writer removes a document's FTS5 row
// with the `'delete'` command and the values it was indexed with, inserts the new row, and empties it with
// `'delete-all'` (fullTextDeleteRows, fullTextInsertRows, fullTextClear: no-ops on the other families, whose indexes
// follow the table).

/** The columns a term may be restricted to; `all` is the whole document. */
export type FullTextField = 'all' | 't_title' | 't_agents' | 't_subjects';

/** A full-text expression: terms and phrases (each with its field, else the call's), combined with AND and OR. */
export type FtExpr =
  | { kind: 'term'; token: string; prefix?: boolean; field?: FullTextField }
  | { kind: 'phrase'; tokens: readonly string[]; field?: FullTextField }
  | { kind: 'and'; items: readonly FtExpr[] }
  | { kind: 'or'; items: readonly FtExpr[] };

/** A document's indexed text, as `search_doc` holds it (the FTS5 row of `doc_no`). */
export interface FullTextRow {
  doc_no: number;
  t_title: string;
  t_agents: string;
  t_subjects: string;
  t_rest: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = Kysely<any> | Transaction<any>;

const TOKEN_RE = /^[\p{L}\p{N}]{1,84}$/u;
const FIELDS: readonly FullTextField[] = ['all', 't_title', 't_agents', 't_subjects'];
/** The MySQL/MariaDB FULLTEXT index of each field is over exactly these columns. */
const INNODB_COLUMNS: Readonly<Record<FullTextField, readonly string[]>> = {
  all: ['t_title', 't_agents', 't_subjects', 't_rest'],
  t_title: ['t_title'],
  t_agents: ['t_agents'],
  t_subjects: ['t_subjects'],
};
/** The PostgreSQL weight label of each field (PG_SEARCH_VECTOR_SQL: title A, agents B, subjects C, rest D). */
const PG_WEIGHT: Readonly<Record<FullTextField, string>> = { all: '', t_title: 'A', t_agents: 'B', t_subjects: 'C' };
/** The FTS5 table of migration 0024 (SEARCH_FULLTEXT.fts5.name). */
const FTS5_TABLE = 'search_fts';
/** Rows per FTS5 statement (5 parameters each). */
const FTS5_ROWS_PER_STATEMENT = 200;

/** The leaves of `expr`, each with its field resolved against `field`. */
type Leaf = Extract<FtExpr, { kind: 'term' | 'phrase' }> & { field: FullTextField };

/** `expr` checked and with every leaf's field resolved; TypeError for a malformed one (see the top of this file). */
function resolve(expr: FtExpr, field: FullTextField, depth = 0): FtExpr {
  if (depth > 16) throw new TypeError('full-text expression: nested more than 16 levels');
  if (typeof expr !== 'object' || expr === null) throw new TypeError('full-text expression: not an object');
  const f = 'field' in expr && expr.field !== undefined ? expr.field : field;
  if (!FIELDS.includes(f)) throw new TypeError(`full-text expression: unknown field ${JSON.stringify(f)}`);
  switch (expr.kind) {
    case 'term':
      if (typeof expr.token !== 'string' || !TOKEN_RE.test(expr.token)) throw new TypeError('full-text expression: a token must be 1-84 letters or digits');
      return { kind: 'term', token: expr.token, prefix: expr.prefix === true, field: f };
    case 'phrase':
      if (!Array.isArray(expr.tokens) || expr.tokens.length === 0) throw new TypeError('full-text expression: a phrase needs tokens');
      for (const t of expr.tokens) {
        if (typeof t !== 'string' || !TOKEN_RE.test(t)) throw new TypeError('full-text expression: a token must be 1-84 letters or digits');
      }
      return expr.tokens.length === 1 ? { kind: 'term', token: expr.tokens[0]!, prefix: false, field: f } : { kind: 'phrase', tokens: [...expr.tokens], field: f };
    case 'and':
    case 'or':
      if (!Array.isArray(expr.items) || expr.items.length === 0) throw new TypeError(`full-text expression: ${expr.kind} needs items`);
      if (expr.items.length === 1) return resolve(expr.items[0]!, field, depth + 1);
      return { kind: expr.kind, items: expr.items.map((i) => resolve(i, field, depth + 1)) };
    default:
      throw new TypeError('full-text expression: unknown kind');
  }
}

function leaves(expr: FtExpr): Leaf[] {
  return expr.kind === 'and' || expr.kind === 'or' ? expr.items.flatMap(leaves) : [expr as Leaf];
}

function fieldsOf(expr: FtExpr): Set<FullTextField> {
  return new Set(leaves(expr).map((l) => l.field));
}

// ---------------------------------------------------------------------------------------------------------------
// SQLite FTS5

/** The FTS5 query string of a resolved expression. */
function fts5Query(expr: FtExpr): string {
  switch (expr.kind) {
    case 'term': {
      const filter = expr.field === undefined || expr.field === 'all' ? '' : `{${expr.field}} : `;
      return `${filter}"${expr.token}"${expr.prefix === true ? ' *' : ''}`;
    }
    case 'phrase': {
      const filter = expr.field === undefined || expr.field === 'all' ? '' : `{${expr.field}} : `;
      return `${filter}"${expr.tokens.join(' ')}"`;
    }
    case 'and':
    case 'or':
      return `(${expr.items.map(fts5Query).join(expr.kind === 'and' ? ' AND ' : ' OR ')})`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// PostgreSQL

/** A lexeme of a tsquery: quoted, with its weight label and prefix mark. */
function pgLexeme(token: string, field: FullTextField, prefix: boolean): string {
  const label = `${prefix ? '*' : ''}${PG_WEIGHT[field]}`;
  return `'${token}'${label === '' ? '' : `:${label}`}`;
}

/** The phrase `tokens` inside the column of weight `label`: `('a':A <-> 'b':A)`. */
function pgPhrase(tokens: readonly string[], label: string): string {
  return `(${tokens.map((t) => `'${t}'${label === '' ? '' : `:${label}`}`).join(' <-> ')})`;
}

/** The weight labels of the four columns (PG_SEARCH_VECTOR_SQL). */
const PG_COLUMN_LABELS: readonly string[] = ['A', 'B', 'C', 'D'];

/** The `to_tsquery('simple', …)` text of a resolved expression. */
function pgQuery(expr: FtExpr): string {
  switch (expr.kind) {
    case 'term':
      return pgLexeme(expr.token, expr.field ?? 'all', expr.prefix === true);
    case 'phrase': {
      // Task 39: the weighted vector joins the columns' positions end to end, so a phrase of the whole document is the
      // phrase inside one of its columns (as FTS5 and InnoDB read it), never one running from a column into the next.
      const field = expr.field ?? 'all';
      if (field !== 'all') return pgPhrase(expr.tokens, PG_WEIGHT[field]);
      return `(${PG_COLUMN_LABELS.map((label) => pgPhrase(expr.tokens, label)).join(' | ')})`;
    }
    case 'and':
    case 'or':
      return `(${expr.items.map(pgQuery).join(expr.kind === 'and' ? ' & ' : ' | ')})`;
  }
}

function pgTsQuery(expr: FtExpr): RawBuilder<unknown> {
  return sql`to_tsquery('simple', ${pgQuery(expr)})`;
}

// ---------------------------------------------------------------------------------------------------------------
// InnoDB (MySQL/MariaDB)

/** A leaf of a boolean-mode query: a word, `word*`, or `"a phrase"`. */
function innodbLeaf(leaf: Leaf): string {
  return leaf.kind === 'term' ? `${leaf.token}${leaf.prefix === true ? '*' : ''}` : `"${leaf.tokens.join(' ')}"`;
}

/**
 * Whether one boolean-mode query can say `expr` (one field): a leaf, an OR of leaves, or an AND of leaves and ORs of
 * leaves. Deeper nesting is composed in SQL instead, since boolean mode gives an optional sub-group no clear meaning.
 */
function innodbSimple(expr: FtExpr): boolean {
  if (expr.kind === 'term' || expr.kind === 'phrase') return true;
  if (expr.kind === 'or') return expr.items.every((i) => i.kind === 'term' || i.kind === 'phrase');
  return expr.items.every((i) => i.kind === 'term' || i.kind === 'phrase' || (i.kind === 'or' && innodbSimple(i)));
}

/** The boolean-mode query of a simple expression (innodbSimple): `+a +(b c) +"d e"`, `a b`, `+a`. */
function innodbBoolean(expr: FtExpr): string {
  if (expr.kind === 'term' || expr.kind === 'phrase') return `+${innodbLeaf(expr as Leaf)}`;
  if (expr.kind === 'or') return expr.items.map((i) => innodbLeaf(i as Leaf)).join(' ');
  return expr.items
    .map((i) => (i.kind === 'or' ? `+(${i.items.map((l) => innodbLeaf(l as Leaf)).join(' ')})` : `+${innodbLeaf(i as Leaf)}`))
    .join(' ');
}

function innodbMatch(field: FullTextField, alias: string, query: string): RawBuilder<SqlBool> {
  const columns = sql.join(INNODB_COLUMNS[field].map((c) => sql.ref(`${alias}.${c}`)));
  return sql<SqlBool>`MATCH (${columns}) AGAINST (${query} IN BOOLEAN MODE)`;
}

/** The SQL predicate of a resolved expression over `alias`'s columns. */
function innodbPredicate(expr: FtExpr, alias: string): RawBuilder<SqlBool> {
  const fields = fieldsOf(expr);
  if (fields.size === 1 && innodbSimple(expr)) return innodbMatch([...fields][0]!, alias, innodbBoolean(expr));
  if (expr.kind === 'or') return sql<SqlBool>`(${sql.join(expr.items.map((i) => innodbPredicate(i, alias)), sql` OR `)})`;
  if (expr.kind === 'and') {
    // The items of one field that one boolean query can say go together into one MATCH; the others on their own.
    const groups = new Map<FullTextField, FtExpr[]>();
    const rest: FtExpr[] = [];
    for (const item of expr.items) {
      const f = fieldsOf(item);
      if (f.size === 1 && (item.kind !== 'and' && innodbSimple(item))) {
        const field = [...f][0]!;
        groups.set(field, [...(groups.get(field) ?? []), item]);
      } else rest.push(item);
    }
    const parts: RawBuilder<SqlBool>[] = [];
    for (const [field, items] of groups) {
      const one: FtExpr = items.length === 1 ? items[0]! : { kind: 'and', items };
      parts.push(innodbMatch(field, alias, innodbBoolean(one)));
    }
    for (const item of rest) parts.push(innodbPredicate(item, alias));
    return sql<SqlBool>`(${sql.join(parts, sql` AND `)})`;
  }
  // A leaf is always simple.
  return innodbMatch([...fields][0]!, alias, innodbBoolean(expr));
}

/** The relevance query of InnoDB: every leaf of the expression, without operators. */
function innodbScoreQuery(expr: FtExpr): string {
  return leaves(expr).map(innodbLeaf).join(' ');
}

// ---------------------------------------------------------------------------------------------------------------
// The helpers

/**
 * The documents of `search_doc` (the table of the query, not aliased) that match `expr`, as a predicate. Leaves
 * without a field of their own search `field`.
 *
 * @throws TypeError for a malformed expression (see the top of this file)
 */
export function fullTextWhere(family: FullTextFamily, field: FullTextField, expr: FtExpr): Expression<SqlBool> {
  const e = resolve(expr, field);
  if (family === 'fts5') return sql<SqlBool>`${sql.ref('search_doc.doc_no')} IN (SELECT rowid FROM ${sql.table(FTS5_TABLE)} WHERE ${sql.table(FTS5_TABLE)} MATCH ${fts5Query(e)})`;
  if (family === 'pg') return sql<SqlBool>`${PG_SEARCH_VECTOR_SQL} @@ ${pgTsQuery(e)}`;
  return innodbPredicate(e, 'search_doc');
}

/**
 * The documents of `search_doc` that do **not** match `expr` (an excluded clause, `-word`), as a predicate:
 * `doc_no NOT IN (<the matching documents>)`, which every family answers from its index (a negated MATCH would make
 * PostgreSQL compute the vector of every row).
 *
 * @throws TypeError for a malformed expression
 */
export function fullTextExcluded(family: FullTextFamily, field: FullTextField, expr: FtExpr): Expression<SqlBool> {
  const e = resolve(expr, field);
  const docNo = sql.ref('search_doc.doc_no');
  if (family === 'fts5') return sql<SqlBool>`${docNo} NOT IN (SELECT rowid FROM ${sql.table(FTS5_TABLE)} WHERE ${sql.table(FTS5_TABLE)} MATCH ${fts5Query(e)})`;
  if (family === 'pg') return sql<SqlBool>`${docNo} NOT IN (SELECT ${sql.ref('ftx.doc_no')} FROM ${sql.table('search_doc')} AS ${sql.id('ftx')} WHERE ${PG_SEARCH_VECTOR_SQL} @@ ${pgTsQuery(e)})`;
  return sql<SqlBool>`${docNo} NOT IN (SELECT ${sql.ref('ftx.doc_no')} FROM ${sql.table('search_doc')} AS ${sql.id('ftx')} WHERE ${innodbPredicate(e, 'ftx')})`;
}

/**
 * The documents that match `expr` with their relevance, as the body of a derived table with the columns `doc_no` and
 * `score` (higher is better; join it on `doc_no`): InnoDB `3 × title + 2 × agents + 1.5 × subjects + all`, PostgreSQL
 * `ts_rank_cd` over the weighted vector, SQLite `-bm25(search_fts, 10, 5, 3, 1)`. Leaves without a field search
 * `field`. Scores are comparable within one query only, and differ between families (§4.3: tests compare sets).
 *
 * @throws TypeError for a malformed expression
 */
export function fullTextRanked(family: FullTextFamily, field: FullTextField, expr: FtExpr): RawBuilder<{ doc_no: number; score: number }> {
  const e = resolve(expr, field);
  if (family === 'fts5') {
    return sql`SELECT rowid AS ${sql.id('doc_no')}, -bm25(${sql.table(FTS5_TABLE)}, 10, 5, 3, 1) AS ${sql.id('score')} FROM ${sql.table(FTS5_TABLE)} WHERE ${sql.table(FTS5_TABLE)} MATCH ${fts5Query(e)}`;
  }
  if (family === 'pg') {
    const q = pgTsQuery(e);
    return sql`SELECT ${sql.ref('ftr.doc_no')} AS ${sql.id('doc_no')}, ts_rank_cd(${PG_SEARCH_VECTOR_SQL}, ${q}) AS ${sql.id('score')} FROM ${sql.table('search_doc')} AS ${sql.id('ftr')} WHERE ${PG_SEARCH_VECTOR_SQL} @@ ${q}`;
  }
  const s = innodbScoreQuery(e);
  const score = sql`(3 * ${innodbMatch('t_title', 'ftr', s)} + 2 * ${innodbMatch('t_agents', 'ftr', s)} + 1.5 * ${innodbMatch('t_subjects', 'ftr', s)} + ${innodbMatch('all', 'ftr', s)})`;
  return sql`SELECT ${sql.ref('ftr.doc_no')} AS ${sql.id('doc_no')}, ${score} AS ${sql.id('score')} FROM ${sql.table('search_doc')} AS ${sql.id('ftr')} WHERE ${innodbPredicate(e, 'ftr')}`;
}

/**
 * Removes the full-text rows of `rows` (their values exactly as indexed: the `search_doc` rows about to be deleted or
 * rewritten), in the caller's transaction: on SQLite the FTS5 `'delete'` command per row; nothing elsewhere.
 */
export async function fullTextDeleteRows(trx: AnyDb, family: FullTextFamily, rows: readonly FullTextRow[]): Promise<void> {
  if (family !== 'fts5') return;
  for (let i = 0; i < rows.length; i += FTS5_ROWS_PER_STATEMENT) {
    const values = rows
      .slice(i, i + FTS5_ROWS_PER_STATEMENT)
      .map((r) => sql`('delete', ${r.doc_no}, ${r.t_title}, ${r.t_agents}, ${r.t_subjects}, ${r.t_rest})`);
    await sql`INSERT INTO ${sql.table(FTS5_TABLE)} (${sql.id(FTS5_TABLE)}, rowid, t_title, t_agents, t_subjects, t_rest) VALUES ${sql.join(values)}`.execute(trx);
  }
}

/** Adds the full-text rows of `rows` (`search_doc` rows just written), in the caller's transaction; SQLite only. */
export async function fullTextInsertRows(trx: AnyDb, family: FullTextFamily, rows: readonly FullTextRow[]): Promise<void> {
  if (family !== 'fts5') return;
  for (let i = 0; i < rows.length; i += FTS5_ROWS_PER_STATEMENT) {
    const values = rows
      .slice(i, i + FTS5_ROWS_PER_STATEMENT)
      .map((r) => sql`(${r.doc_no}, ${r.t_title}, ${r.t_agents}, ${r.t_subjects}, ${r.t_rest})`);
    await sql`INSERT INTO ${sql.table(FTS5_TABLE)} (rowid, t_title, t_agents, t_subjects, t_rest) VALUES ${sql.join(values)}`.execute(trx);
  }
}

/**
 * Empties the full-text index before `search_doc` is emptied (a full reindex, a restore's volatile tables): on SQLite
 * the FTS5 `'delete-all'` command (a plain DELETE of the content table would leave the index behind); nothing
 * elsewhere.
 */
export async function fullTextClear(trx: AnyDb, family: FullTextFamily): Promise<void> {
  if (family !== 'fts5') return;
  await sql`INSERT INTO ${sql.table(FTS5_TABLE)} (${sql.id(FTS5_TABLE)}) VALUES ('delete-all')`.execute(trx);
}
