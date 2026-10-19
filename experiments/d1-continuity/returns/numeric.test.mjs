import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { build } from "esbuild";
import initSqlJs from "../cash/node_modules/sql.js/dist/sql-wasm.js";
await mkdir(new URL("./build/", import.meta.url), { recursive: true });
await build({
  stdin: {
    contents:
      "export{exactReturnQuery}from'./numeric';export{returnQueries}from'./queries-extra'",
    resolveDir: new URL("./", import.meta.url).pathname.replace(
      /^\/([A-Za-z]:)/,
      "$1",
    ),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: new URL(
    "./build/numeric-tests.mjs",
    import.meta.url,
  ).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  logLevel: "silent",
});
const { exactReturnQuery, returnQueries } =
    await import("./build/numeric-tests.mjs"),
  SQL = await initSqlJs();
const load = returnQueries.find(
    (s) => s.startsWith("SELECT a.id,") && !s.includes(" HAVING "),
  ),
  outstanding = returnQueries.find(
    (s) => s.startsWith("SELECT a.id,") && s.includes(" HAVING "),
  ),
  balance = returnQueries.find((s) => s.startsWith("SELECT a.effectKind, SUM"));
function database() {
  const d = new SQL.Database();
  d.run(
    "CREATE TABLE documentEffects(id INTEGER PRIMARY KEY,documentType TEXT,documentId INTEGER,effectKind TEXT,phase TEXT,scope TEXT,signedAmount TEXT,signedQuantity INTEGER,reversalOfEffectId INTEGER,payloadJson TEXT)",
  );
  return d;
}
const add = (
  d,
  id,
  amount,
  quantity,
  phase = "APPLY",
  parent = null,
  scope = "invoice-sale",
) =>
  d.run("INSERT INTO documentEffects VALUES(?,?,?,?,?,?,?,?,?,?)", [
    id,
    "INVOICE",
    1,
    "INVENTORY",
    phase,
    scope,
    amount,
    quantity,
    parent,
    null,
  ]);
test("Decimal preserves cents, 0.0001 residue and multiple children across scopes", () => {
  const d = database();
  try {
    add(d, 1, "0.3000", 3);
    add(d, 2, "-0.1000", -1, "REVERSE", 1);
    add(d, 3, "-0.2000", -2, "REVERSE", 1, "other-child-scope");
    const row = exactReturnQuery(
      d,
      load,
      ["INVOICE", 1, "invoice-sale"],
      "execute",
    ).rows[0][0];
    assert.equal(row.reversedAmount, "-0.3000");
    assert.equal(row.reversedQuantity, -3);
    assert.equal(
      exactReturnQuery(
        d,
        outstanding,
        ["INVOICE", 1, "invoice-sale"],
        "execute",
      ).rows[0].length,
      0,
    );
    add(d, 4, "0.0001", 0, "REVERSE", 1);
    assert.equal(
      exactReturnQuery(
        d,
        outstanding,
        ["INVOICE", 1, "invoice-sale"],
        "execute",
      ).rows[0].length,
      1,
    );
  } finally {
    d.close();
  }
});
test("balance assertion detects quantity-only or money-only residue without scope leakage", () => {
  const d = database();
  try {
    add(d, 1, "0.3000", 1);
    add(d, 2, "-0.3000", 0, "REVERSE", 1);
    add(d, 3, "9.0000", 0, "APPLY", null, "different");
    let rows = exactReturnQuery(
      d,
      balance,
      ["INVOICE", 1, "INVENTORY", "invoice-sale"],
      "execute",
    ).rows[0];
    assert.equal(rows[0].sumAmount, "0.0000");
    assert.equal(rows[0].sumQuantity, 1);
    add(d, 4, "0.0000", -1, "REVERSE", 1);
    assert.deepEqual(
      exactReturnQuery(
        d,
        balance,
        ["INVOICE", 1, "INVENTORY", "invoice-sale"],
        "execute",
      ).rows,
      [[]],
    );
    add(d, 5, "0.0001", 0, "REVERSE", 1);
    rows = exactReturnQuery(
      d,
      balance,
      ["INVOICE", 1, "INVENTORY", "invoice-sale"],
      "execute",
    ).rows[0];
    assert.equal(rows[0].sumAmount, "0.0001");
  } finally {
    d.close();
  }
});
test("ledger sums and paid-amount subtraction use stored Decimal text", () => {
  const d = database();
  try {
    d.run(
      "CREATE TABLE accountingEntries(invoiceId INTEGER,entryType TEXT,revenue TEXT,taxAmount TEXT,amount TEXT);INSERT INTO accountingEntries VALUES(1,'RETURN','-0.10','0.00','-0.10'),(1,'RETURN','-0.20','0.00','-0.20')",
    );
    const query = returnQueries.find(
      (s) =>
        s.startsWith("select COALESCE(SUM(`revenue`)") &&
        s.includes("SUM(`amount`)"),
    );
    assert.deepEqual(exactReturnQuery(d, query, [1, "RETURN"], "all").rows, [
      ["-0.30", "0.00", "-0.30"],
    ]);
    d.run(
      "CREATE TABLE invoices(id INTEGER PRIMARY KEY,paidAmount TEXT);INSERT INTO invoices VALUES(1,'0.30')",
    );
    const update = returnQueries.find((s) =>
      s.includes("GREATEST(`invoices`.`paidAmount`"),
    );
    exactReturnQuery(d, update, ["0.10", 1], "execute");
    assert.equal(
      d.exec("SELECT paidAmount FROM invoices")[0].values[0][0],
      "0.20",
    );
    exactReturnQuery(d, update, ["0.30", 1], "execute");
    assert.equal(
      d.exec("SELECT paidAmount FROM invoices")[0].values[0][0],
      "0.00",
    );
    assert.equal(
      exactReturnQuery(
        d,
        "SELECT SUM(arbitrary) FROM arbitrary",
        [],
        "execute",
      ),
      undefined,
    );
  } finally {
    d.close();
  }
});
