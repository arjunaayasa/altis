import { describe, expect, it } from 'vitest';
import { DUMP_LITERAL_MAX, DumpParseError, createSqlDumpParser, type DumpEvent } from '../../src/migration/slims/source/sql-dump.js';

// The streaming mysqldump/phpMyAdmin reader (spec §11.1, S9). Its input is the dump's bytes one character per byte
// (a Latin-1 decoding), so a chunk may end anywhere, even inside a UTF-8 sequence.

/** `text` (written as JavaScript text) as the parser reads a dump: its UTF-8 bytes, one character each. */
const bytes = (text: string): string => Buffer.from(text, 'utf8').toString('latin1');

/** Every event of `dump`, pushed in pieces of `size` characters (whole when omitted). */
function parse(dump: string, size?: number, o?: Parameters<typeof createSqlDumpParser>[0]): unknown[] {
  const parser = createSqlDumpParser(o);
  const out: unknown[] = [];
  const step = size ?? Math.max(1, dump.length);
  for (let i = 0; i < dump.length; i += step) out.push(...parser.push(dump.slice(i, i + step)));
  out.push(...parser.end());
  return out;
}

function failure(fn: () => unknown): DumpParseError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DumpParseError) return error;
    throw error;
  }
  throw new Error('no DumpParseError');
}

const CREATE_BIBLIO = [
  'CREATE TABLE `biblio` (',
  '  `biblio_id` int(11) NOT NULL AUTO_INCREMENT,',
  "  `title` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'judul; (utama)',",
  '  `notes` text,',
  '  PRIMARY KEY (`biblio_id`),',
  '  KEY `title_idx` (`title`(100)),',
  '  FULLTEXT KEY `notes_ft` (`notes`)',
  ') ENGINE=MyISAM DEFAULT CHARSET=utf8mb4;',
].join('\n');

describe('createSqlDumpParser', () => {
  it('reads CREATE TABLE and INSERT with quotes, doubled quotes, NULL and a value holding `),(` and `;`', () => {
    const dump = `${CREATE_BIBLIO}\nINSERT INTO \`biblio\` VALUES (1,'it\\'s','a''b'),(2,'x),(y;z',NULL);\n`;
    expect(parse(dump)).toEqual([
      { type: 'create', table: 'biblio', columns: ['biblio_id', 'title', 'notes'], primaryKey: ['biblio_id'] },
      {
        type: 'insert',
        table: 'biblio',
        columns: null,
        rows: [
          { biblio_id: 1, title: "it's", notes: "a'b" },
          { biblio_id: 2, title: 'x),(y;z', notes: null },
        ],
      },
    ]);
  });

  it('reads every MySQL escape', () => {
    const dump = "INSERT INTO t (a) VALUES ('\\0|\\'|\\\"|\\b|\\n|\\r|\\t|\\Z|\\\\|\\%|\\_|\\q');";
    const [event] = parse(dump) as [{ rows: { a: string }[] }];
    const c = String.fromCharCode;
    expect(event.rows[0]!.a).toBe(['\0', "'", '"', c(8), '\n', '\r', '\t', c(0x1a), '\\', '\\%', '\\_', 'q'].join('|'));
  });

  it('reads hex literals, character set introducers and bit literals', () => {
    const dump = "INSERT INTO t (a,b,c,d,e,f,g) VALUES (0x4142,X'4142',_binary 'x',_binary 0x00ff,_utf8mb4'ok',b'101',0x);";
    expect(parse(dump)).toEqual([
      {
        type: 'insert',
        table: 't',
        columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        rows: [
          {
            a: Uint8Array.from([0x41, 0x42]),
            b: Uint8Array.from([0x41, 0x42]),
            c: Uint8Array.from([0x78]),
            d: Uint8Array.from([0x00, 0xff]),
            e: 'ok',
            f: 5,
            g: new Uint8Array(0),
          },
        ],
      },
    ]);
  });

  it('decodes UTF-8 text and keeps bytes that are not UTF-8 as bytes', () => {
    const dump = bytes("INSERT INTO t VALUES ('Café 中文');") + "INSERT INTO t VALUES ('Caf\xe9');";
    const events = parse(dump, undefined, { columns: new Map([['t', ['a']]]) }) as { rows: { a: unknown }[] }[];
    expect(events[0]!.rows[0]!.a).toBe('Café 中文');
    expect(events[1]!.rows[0]!.a).toEqual(Uint8Array.from([0x43, 0x61, 0x66, 0xe9]));
  });

  it('reads numbers: safe integers as numbers, everything else as its text', () => {
    const dump = 'INSERT INTO t (a,b,c,d,e,f,g) VALUES (42,-7,3.50,1e3,9007199254740993,+5,-1.5e-3);';
    const [event] = parse(dump) as [{ rows: unknown[] }];
    expect(event.rows[0]).toEqual({ a: 42, b: -7, c: '3.50', d: '1e3', e: '9007199254740993', f: 5, g: '-1.5e-3' });
  });

  it('reads the variants of INSERT, qualified names and column lists', () => {
    const dump = [
      'INSERT IGNORE INTO `db`.`t` (`a`, `b`) VALUES (1,2);',
      'REPLACE LOW_PRIORITY INTO t2 VALUES (3);',
      'insert into `t3` (`a`) value (4), (5);',
      'INSERT INTO `t4` PARTITION (p0) (`a`) VALUES (6);',
    ].join('\n');
    expect(parse(dump)).toEqual([
      { type: 'insert', table: 't', columns: ['a', 'b'], rows: [{ a: 1, b: 2 }] },
      { type: 'insert', table: 't2', columns: null, rows: [{ '1': 3 }] },
      { type: 'insert', table: 't3', columns: ['a'], rows: [{ a: 4 }, { a: 5 }] },
      { type: 'insert', table: 't4', columns: ['a'], rows: [{ a: 6 }] },
    ]);
  });

  it('skips comments of every kind, including a multi-line one between statements and conditional ones', () => {
    const dump = [
      '-- MySQL dump 10.13',
      '--',
      '# a hash comment',
      '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;',
      '/* a multi-line comment',
      "   with ; and ' and ` and INSERT INTO x VALUES (1);",
      '*/',
      "INSERT /* inline */ INTO t (a) VALUES ('x') -- trailing",
      ';',
      '/*!40000 ALTER TABLE `t` ENABLE KEYS */;',
    ].join('\n');
    expect(parse(dump)).toEqual([{ type: 'insert', table: 't', columns: ['a'], rows: [{ a: 'x' }] }]);
  });

  it('ignores every other statement', () => {
    const dump = [
      "SET @x = 'a;b';",
      'LOCK TABLES `t` WRITE;',
      'DROP TABLE IF EXISTS `t`;',
      'CREATE VIEW v AS SELECT 1;',
      'CREATE DATABASE x;',
      'INSERT INTO t (a) SELECT a FROM u;',
      'INSERT INTO t SET a = 1;',
      'UNLOCK TABLES;',
      ';;',
      '/*!50001 CREATE TABLE `v` (`a` int) */;',
    ].join('\n');
    expect(parse(dump)).toEqual([]);
  });

  it('skips a DELIMITER block, whatever its body holds', () => {
    const dump = [
      'DELIMITER ;;',
      'CREATE PROCEDURE p() BEGIN UPDATE a SET b = 1; INSERT INTO log VALUES (1); END ;;',
      'DELIMITER ;',
      'INSERT INTO t (a) VALUES (2);',
    ].join('\n');
    expect(parse(dump)).toEqual([{ type: 'insert', table: 't', columns: ['a'], rows: [{ a: 2 }] }]);
  });

  it('reads primary keys declared inline, by constraint, composite or added by ALTER TABLE (phpMyAdmin)', () => {
    const dump = [
      'CREATE TABLE a (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, `key` varchar(3));',
      'CREATE TABLE IF NOT EXISTS `b` (`x` int, `y` varchar(10), CONSTRAINT `pk` PRIMARY KEY USING BTREE (`x`, `y`(5) DESC));',
      'CREATE TABLE `c` (`z` int);',
      'ALTER TABLE `c` ADD PRIMARY KEY (`z`), ADD KEY `k` (`z`);',
      'CREATE TABLE d LIKE c;',
    ].join('\n');
    expect(parse(dump)).toEqual([
      { type: 'create', table: 'a', columns: ['id', 'key'], primaryKey: ['id'] },
      { type: 'create', table: 'b', columns: ['x', 'y'], primaryKey: ['x', 'y'] },
      { type: 'create', table: 'c', columns: ['z'], primaryKey: [] },
      { type: 'primaryKey', table: 'c', primaryKey: ['z'] },
    ]);
  });

  it('gives the same events whatever the chunk boundaries', () => {
    const dump = bytes(
      [
        CREATE_BIBLIO,
        "INSERT INTO `biblio` VALUES (1,'it\\'s ''q'' Café','x'),(2,'a\\\\','-- not a comment'),(-3,'/* no */',NULL);",
        '-- c\n# d\n/* e */',
        "INSERT INTO `t` (`a`) VALUES (0x41),(_binary 'y'),(1.5e-3),(b'11'),(X'4243');",
        'DELIMITER ;;\nCREATE TRIGGER x BEGIN SET a = 1; END ;;\nDELIMITER ;',
      ].join('\n'),
    );
    const whole = parse(dump);
    for (const size of [1, 2, 3, 7, 13, 4096]) expect(parse(dump, size)).toEqual(whole);
  });

  it('emits the rows of a long INSERT in batches of 500, whatever the chunking', () => {
    const tuples = Array.from({ length: 1200 }, (_, i) => `(${i},'r${i}')`).join(',');
    const dump = `INSERT INTO t (a,b) VALUES ${tuples};`;
    for (const size of [undefined, 97]) {
      const events = parse(dump, size) as { rows: unknown[] }[];
      expect(events.map((e) => e.rows.length)).toEqual([500, 500, 200]);
      expect(events[2]!.rows[199]).toEqual({ a: 1199, b: 'r1199' });
    }
  });

  it('keys the rows by the CREATE TABLE columns, the seeded columns, or by position', () => {
    expect(parse('CREATE TABLE t (a int, b int); INSERT INTO t VALUES (1,2);')[1]).toMatchObject({ rows: [{ a: 1, b: 2 }] });
    expect(parse('INSERT INTO t VALUES (1,2);', undefined, { columns: new Map([['t', ['a', 'b']]]) })).toEqual([
      { type: 'insert', table: 't', columns: null, rows: [{ a: 1, b: 2 }] },
    ]);
    expect(parse('INSERT INTO u VALUES (1,2);')).toEqual([{ type: 'insert', table: 'u', columns: null, rows: [{ '1': 1, '2': 2 }] }]);
  });

  it('keeps a column named __proto__ as a plain key', () => {
    const [event] = parse('INSERT INTO t (`__proto__`, a) VALUES (1, 2);') as [{ rows: Record<string, unknown>[] }];
    expect(Object.keys(event.rows[0]!)).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(event.rows[0])).toBe(Object.prototype);
  });

  it('marks the end of every statement with the offset after it, when asked', () => {
    const dump = "SET a=1;\nINSERT INTO t (a) VALUES ('x;');\n-- end\n";
    const events = parse(dump, 3, { marks: true });
    expect(events).toEqual([
      { type: 'end', offset: 8 },
      { type: 'insert', table: 't', columns: ['a'], rows: [{ a: 'x;' }] },
      { type: 'end', offset: 41 },
    ]);
    expect(dump.slice(0, 41).endsWith(';')).toBe(true);
  });

  it('reads a last INSERT without its semicolon', () => {
    expect(parse('INSERT INTO t (a) VALUES (1)')).toEqual([{ type: 'insert', table: 't', columns: ['a'], rows: [{ a: 1 }] }]);
  });

  it('refuses a dump cut inside a value, a malformed value and a row of the wrong width', () => {
    const cut = failure(() => parse("INSERT INTO `biblio` (a) VALUES ('abc"));
    expect([cut.code, cut.table]).toEqual(['truncated', 'biblio']);
    expect(failure(() => parse('INSERT INTO t (a) VALUES (1),')).code).toBe('truncated');
    expect(failure(() => parse('/* never closed')).code).toBe('truncated');
    const bad = failure(() => parse('INSERT INTO t (a) VALUES (foo);'));
    expect([bad.code, bad.table]).toEqual(['syntax', 't']);
    expect(failure(() => parse('INSERT INTO t (a) VALUES 1;')).code).toBe('syntax');
    const width = failure(() => parse('CREATE TABLE t (a int); INSERT INTO t VALUES (1,2);'));
    expect([width.code, width.table]).toEqual(['column_count', 't']);
  });

  it('refuses text that is not one byte per character', () => {
    expect(() => createSqlDumpParser().push('INSERT 中')).toThrow(TypeError);
  });
});

describe('createSqlDumpParser bounds (S9)', () => {
  const MIB = 1024 * 1024;

  it('refuses a string literal that passes 16 MiB without ending, naming its table, before the dump ends', () => {
    expect(DUMP_LITERAL_MAX).toBe(16 * MIB);
    const parser = createSqlDumpParser();
    parser.push("INSERT INTO `biblio` VALUES (1,'");
    const chunk = 'a'.repeat(MIB);
    let pushed = 0;
    const error = failure(() => {
      for (; pushed < 17; pushed += 1) parser.push(chunk);
    });
    expect([error.code, error.table]).toEqual(['literal_too_long', 'biblio']);
    expect(pushed).toBeLessThanOrEqual(16); // refused on the push that crossed 16 MiB, not at the end of 17 MiB
  });

  it('refuses a comment, a hex literal and a statement that pass 16 MiB', () => {
    const big = 'a'.repeat(DUMP_LITERAL_MAX + 1);
    expect(failure(() => createSqlDumpParser().push(`/* ${big}`))).toMatchObject({ code: 'literal_too_long', table: null });
    expect(failure(() => createSqlDumpParser().push(`-- ${big}`))).toMatchObject({ code: 'literal_too_long', table: null });
    expect(failure(() => createSqlDumpParser().push(`INSERT INTO h VALUES (0x${'4'.repeat(DUMP_LITERAL_MAX + 1)}`))).toMatchObject({
      code: 'literal_too_long',
      table: 'h',
    });
    expect(failure(() => createSqlDumpParser().push(`SET @a = 1 ${' '.repeat(DUMP_LITERAL_MAX)}+ 1`))).toMatchObject({
      code: 'literal_too_long',
      table: null,
    });
    // Pushed in pieces as splitDump does, each piece's rows dropped: a parser holds one batch, not the statement.
    const rows = createSqlDumpParser();
    const piece = '(1),'.repeat(MIB / 4);
    expect(
      failure(() => {
        rows.push('INSERT INTO r VALUES ');
        for (let i = 0; i < 17; i += 1) rows.push(piece);
      }),
    ).toMatchObject({ code: 'literal_too_long', table: 'r' });
  });
});

// Keep the event type in use (the union is part of the module's contract).
const sample: DumpEvent = { type: 'primaryKey', table: 't', primaryKey: [] };
void sample;
