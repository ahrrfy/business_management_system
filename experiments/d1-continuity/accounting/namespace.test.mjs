import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  namespaceSql,
  namespaceBinding,
  namespaceEnvironment,
  namespaceObjects,
  JOURNAL_GUARDS,
} from "./namespace.ts";
import { sqlStatements } from "../cash/sql-statements.mjs";
test("fixed namespace lexes object identifiers and preserves business text, aliases and comments", () => {
  for (const [input, expected] of [
    ["SELECT * FROM invoices", "SELECT * FROM q1gl_invoices"],
    [
      "SELECT 'FROM', 'UPDATE', ';', 'PRAGMA' FROM invoices",
      "SELECT 'FROM', 'UPDATE', ';', 'PRAGMA' FROM q1gl_invoices",
    ],
    [
      'SELECT "invoices"."id" FROM "invoices"',
      'SELECT "q1gl_invoices"."id" FROM "q1gl_invoices"',
    ],
    [
      "SELECT * FROM `invoices` JOIN [invoiceItems] i ON i.invoiceId=`invoices`.id",
      "SELECT * FROM `q1gl_invoices` JOIN [q1gl_invoiceItems] i ON i.invoiceId=`q1gl_invoices`.id",
    ],
    [
      "SELECT 'invoices', 'cashJournalHead_guard', 'it''s invoices' AS invoices FROM invoices /* FROM hidden */ -- invoices\n",
      "SELECT 'invoices', 'cashJournalHead_guard', 'it''s invoices' AS invoices FROM q1gl_invoices /* FROM hidden */ -- invoices\n",
    ],
    [
      "WITH chosen AS (SELECT * FROM invoices) SELECT * FROM chosen",
      "WITH chosen AS (SELECT * FROM q1gl_invoices) SELECT * FROM chosen",
    ],
    [
      "SELECT seq FROM sqlite_sequence WHERE name='invoices'",
      "SELECT seq FROM sqlite_sequence WHERE name='q1gl_invoices'",
    ],
    [
      "SELECT json_group_object(name,seq) FROM sqlite_sequence WHERE name IN('invoices')",
      "SELECT json_group_object(substr(name,6),seq) FROM sqlite_sequence WHERE name IN('q1gl_invoices')",
    ],
  ])
    assert.equal(namespaceSql(input), expected);
  const metadata =
    "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN(" +
    JOURNAL_GUARDS.map((n) => "'" + n + "'").join(",") +
    ")";
  const mapped = namespaceSql(metadata);
  for (const name of JOURNAL_GUARDS)
    assert.ok(mapped.includes("'q1gl_" + name + "'"));
});
test("malformed, unknown, broadened metadata and unsupported DDL fail before native prepare", () => {
  let queries = 0;
  const db = namespaceBinding({
    prepare() {
      queries++;
      throw Error("NATIVE_PREPARE_REACHED");
    },
  });
  for (const sql of [
    "SELECT * FROM invoices WHERE note='unterminated",
    'SELECT * FROM "invoices',
    "SELECT * FROM [invoices",
    "SELECT * FROM `invoices",
    "SELECT * FROM invoices /* open",
    "SELECT * FROM invoices /* nested /* */",
    "SELECT * FROM invoices */",
    "SELECT * FROM unknown",
    "SELECT * FROM legacyOnly WHERE EXISTS (WITH legacyOnly AS (SELECT 1) SELECT 1)",
    "WITH legacyOnly AS (SELECT 1) DELETE FROM legacyOnly",
    "WITH legacyOnly AS (SELECT 1) UPDATE legacyOnly SET id=1",
    "WITH main AS (SELECT 1) SELECT * FROM main.invoices",
    "WITH main AS (SELECT 1) SELECT * FROM main.legacyOnly",
    'WITH "main" AS (SELECT 1) SELECT * FROM "main"."invoices"',
    "WITH [main] AS (SELECT 1) SELECT * FROM [main].[legacyOnly]",
    "SELECT * FROM (unknown)",
    "SELECT * FROM (invoices)",
    "SELECT * FROM json_each",
    "SELECT * FROM invoices INDEXED BY unknown",
    "SELECT * FROM q1gl_invoices",
    "SELECT * FROM invoices, unknown",
    "SELECT * FROM",
    "SELECT * FROM (invoices",
    "SELECT 1);",
    "CREATE TABLE unknown(id INTEGER)",
    "CREATE INDEX invoices ON invoices(id)",
    "CREATE TRIGGER invoices BEFORE INSERT ON invoices BEGIN SELECT 1; END",
    "CREATE TRIGGER cashJournalHead_no_delete BEFORE DELETE ON cashJournalHead BEGIN SELECT 1; END; SELECT 2",
    "CREATE TRIGGER cashJournalHead_no_delete BEFORE DELETE ON cashJournalHead BEGIN SELECT 1; END;;",
    "CREATE TRIGGER cashJournalHead_no_delete; SELECT 1 BEGIN SELECT 1; END",
    "CREATE VIEW invoices AS SELECT 1",
    "DROP TABLE invoices",
    "ALTER TABLE invoices ADD x",
    "PRAGMA table_info(invoices)",
    "SELECT * FROM sqlite_master",
    "SELECT name FROM sqlite_master WHERE type='table' AND name='invoices'",
    "SELECT * FROM sqlite_sequence WHERE name=?",
    "SELECT * FROM sqlite_sequence WHERE name='unknown'",
    "SELECT * FROM sqlite_sequence WHERE name='invoices' OR 1=1",
    "SELECT * FROM invoices; SELECT * FROM customers",
  ])
    assert.throws(() => db.prepare(sql), /NAMESPACE_SQL_REJECTED/, sql);
  assert.equal(queries, 0);
});
test("wrapper preserves native statement values, atomic batch identity, sessions, bookmarks and metadata", async () => {
  const calls = [],
    result = { success: true, meta: { changes: 2, rows_read: 3 } },
    row = { note: "invoices" };
  const raw = {
      prepare(sql) {
        calls.push(["prepare", sql]);
        return {
          bind(...args) {
            calls.push(["bind", args]);
            return this;
          },
          first(...args) {
            calls.push(["first", args]);
            return row;
          },
          all() {
            return result;
          },
          run() {
            return result;
          },
          raw() {
            return result;
          },
        };
      },
      batch(items) {
        calls.push(["batch", items]);
        return [result, result];
      },
      withSession(mode) {
        calls.push(["session", mode]);
        return session;
      },
    },
    session = {
      ...raw,
      getBookmark() {
        return "native-bookmark";
      },
    };
  const db = namespaceBinding(raw);
  assert.equal(namespaceBinding(db), db);
  const env = namespaceEnvironment({ DB: db, RECOVERY_LOG: db, other: "kept" });
  assert.equal(env.DB, db);
  assert.equal(env.RECOVERY_LOG, db);
  const values = ["invoices", JSON.stringify({ table: "cashCommands" }), 3];
  const a = db.prepare("INSERT INTO invoices(id) VALUES(?)").bind(...values),
    b = db.prepare("SELECT * FROM invoices");
  assert.equal(await a.run(), result);
  assert.equal(await b.first("note"), row);
  assert.deepEqual(await db.batch([a, b]), [result, result]);
  assert.deepEqual(calls.find((x) => x[0] === "bind")[1], values);
  assert.equal(calls.filter((x) => x[0] === "batch").length, 1);
  assert.equal(calls.find((x) => x[0] === "batch")[1].length, 2);
  assert.equal(
    db.withSession("first-primary").getBookmark(),
    "native-bookmark",
  );
  assert.equal(
    db.withSession("native-bookmark").getBookmark(),
    "native-bookmark",
  );
  assert.throws(() => db.batch([{}]), /NAMESPACE_SQL_REJECTED/);
  assert.throws(
    () => b.bind(...Array(101).fill("invoices")),
    /NAMESPACE_SQL_REJECTED/,
  );
  assert.throws(
    () =>
      db.batch([namespaceBinding(session).prepare("SELECT * FROM invoices")]),
    /NAMESPACE_SQL_REJECTED/,
  );
});
test("every exact current schema/index/journal definition is covered by reviewed mapping", async () => {
  const journal = await readFile(
    new URL("../cash/journal-schema.sql", import.meta.url),
    "utf8",
  );
  for (const match of journal.matchAll(/CREATE (?:TABLE|TRIGGER) (\w+)/g))
    assert.ok(namespaceObjects.includes(match[1]), match[1]);
  for (const sql of sqlStatements(journal))
    assert.doesNotThrow(() => namespaceSql(sql));
});
