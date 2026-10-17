import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { money as labMoney, total as labTotal } from "./commands.mjs";
import { createLab } from "./run.mjs";
import {
  connectReference,
  loadProductionMoney,
  repoRoot,
} from "./mysql-reference.mjs";

let production, lab, connection, server;
const evidence = {
  kind: "isolated-local-money-reference",
  cases: [],
  limits: [],
};
const rounded = (value) => String(labMoney(value));

before(async () => {
  production = await loadProductionMoney();
  lab = await createLab();
  ({ connection, server } = await connectReference());
  evidence.mysql = { version: server.version, port: server.port };
  evidence.productionSourceSha256 = {};
  for (const file of [
    "server/services/money.ts",
    "server/services/billing.ts",
  ]) {
    evidence.productionSourceSha256[file] = createHash("sha256")
      .update(await readFile(resolve(repoRoot, file)))
      .digest("hex");
  }
  await connection.query(
    "CREATE TABLE IF NOT EXISTS lab_money_reference (id INT PRIMARY KEY, amount DECIMAL(20,2) NOT NULL) ENGINE=InnoDB",
  );
  await lab.db
    .prepare(
      "CREATE TABLE IF NOT EXISTS lab_money_reference (id INTEGER PRIMARY KEY, amount TEXT NOT NULL CHECK(typeof(amount)='text'))",
    )
    .run();
});

after(async () => {
  if (connection) await connection.end();
  if (lab) await lab.close();
  await mkdir(new URL("./results/", import.meta.url), { recursive: true });
  evidence.completedAt = new Date().toISOString();
  evidence.runtime = process.version;
  await writeFile(
    new URL("./results/reference-evidence.json", import.meta.url),
    JSON.stringify(evidence, null, 2),
  );
});

test("HALF_UP, signed effects, USD cents and full DECIMAL(20,2) boundaries match actual repository money", () => {
  const fixtures = [
    "0",
    "0.1",
    "0.2",
    "0.005",
    "1.005",
    "-1.005",
    "1.004999",
    "-0.005",
    "19.995",
    "999999999999999999.99",
    "-999999999999999999.99",
    "90071992547409.93",
    "92233720368547758.08",
  ];
  for (let i = 0; i < 250; i++)
    fixtures.push(`${i * 7919}.${String((i * 37) % 10000).padStart(4, "0")}`);
  for (const value of fixtures)
    assert.equal(rounded(value), production.toDbMoney(value), value);
  evidence.cases.push({
    name: "actual-money-boundaries",
    vectors: fixtures.length,
    passed: true,
  });
});

test("invoice totals use the existing line rounding, discounts, tax and COD delivery fee contract", () => {
  const cases = [
    {
      lines: [
        { quantity: 3, unitPrice: "0.335" },
        { quantity: 2, unitPrice: "1.005" },
      ],
      discount: "0.005",
      tax: "0",
      fee: "0",
    },
    {
      lines: [{ quantity: 7, unitPrice: "1250.25" }],
      discount: "250.50",
      tax: "0",
      fee: "5000",
    },
    {
      lines: [{ quantity: 2, unitPrice: "9.99" }],
      discount: "0.005",
      tax: "7.5",
      fee: "3.005",
    },
    {
      lines: [{ quantity: 1, unitPrice: "999999999999999999.99" }],
      discount: "0.01",
      tax: "0",
      fee: "0.01",
    },
    {
      lines: [{ quantity: 2, unitPrice: "1" }],
      discount: "9999",
      tax: "0",
      fee: "0",
    },
  ];
  for (const c of cases) {
    const lineTotals = c.lines.map(
      (line) =>
        production.computeLineTotal({
          quantity: production.money(line.quantity),
          unitPrice: production.money(line.unitPrice),
        }).total,
    );
    const expected = production.computeInvoiceTotals({
      lineTotals,
      invoiceDiscount: c.discount,
      taxRatePercent: c.tax,
      deliveryFee: c.fee,
    });
    assert.equal(
      labTotal(c.lines, c.discount, c.tax, c.fee),
      expected.total,
      JSON.stringify(c),
    );
  }
  evidence.cases.push({
    name: "actual-billing-invoice-contract",
    vectors: cases.length,
    passed: true,
  });
});

test("MySQL DECIMAL and D1 TEXT preserve large signed values and exact application aggregation", async () => {
  await connection.query("DELETE FROM lab_money_reference");
  await lab.db.prepare("DELETE FROM lab_money_reference").run();
  const values = [
    "999999999999999999.99",
    "-999999999999999999.98",
    "0.01",
    "90071992547409.93",
    "-90071992547409.92",
  ];
  for (const [id, amount] of values.entries()) {
    await connection.execute("INSERT INTO lab_money_reference VALUES (?,?)", [
      id,
      amount,
    ]);
    await lab.db
      .prepare("INSERT INTO lab_money_reference VALUES (?,?)")
      .bind(id, amount)
      .run();
  }
  const [mysqlRows] = await connection.query(
    "SELECT amount FROM lab_money_reference ORDER BY id",
  );
  const d1Rows = (
    await lab.db
      .prepare(
        "SELECT amount, typeof(amount) AS storageType FROM lab_money_reference ORDER BY id",
      )
      .all()
  ).results;
  assert.deepEqual(
    mysqlRows.map((row) => row.amount),
    values,
  );
  assert.deepEqual(
    d1Rows.map((row) => row.amount),
    values,
  );
  assert.ok(d1Rows.every((row) => row.storageType === "text"));
  const [[mysqlSum]] = await connection.query(
    "SELECT SUM(amount) AS total FROM lab_money_reference",
  );
  const exactD1 = production.toDbMoney(
    production.sumMoney(d1Rows.map((row) => row.amount)),
  );
  assert.equal(exactD1, "0.03");
  assert.equal(mysqlSum.total, exactD1);
  // A cancellation-heavy sum can happen to round correctly. A single maximum
  // DECIMAL(20,2) value is a deterministic counterexample to numeric aggregation.
  const unsafeD1 = await lab.db
    .prepare("SELECT SUM(amount) AS total FROM lab_money_reference WHERE id=0")
    .first();
  assert.notEqual(production.toDbMoney(String(unsafeD1.total)), values[0]);
  evidence.cases.push({
    name: "mysql-d1-roundtrip-and-sum",
    exact: exactD1,
    exactLargeValue: values[0],
    unsafeLargeSqlSum: String(unsafeD1.total),
    passed: true,
  });
  evidence.limits.push(
    "D1 monetary TEXT requires exact application/precomputed aggregation; SQL SUM(TEXT) is unsafe. This spike does not port existing SQL financial reports.",
  );
});

test("MySQL and D1 reject FK, CHECK and duplicate non-null keys and both allow repeated NULL unique values", async () => {
  await connection.query(
    "CREATE TABLE IF NOT EXISTS lab_ref_parent (id INT PRIMARY KEY) ENGINE=InnoDB",
  );
  await connection.query(
    "CREATE TABLE IF NOT EXISTS lab_ref_child (id INT PRIMARY KEY, parentId INT NOT NULL, requestKey VARCHAR(100) UNIQUE, quantity INT NOT NULL CHECK(quantity >= 0), FOREIGN KEY(parentId) REFERENCES lab_ref_parent(id)) ENGINE=InnoDB",
  );
  await connection.query("DELETE FROM lab_ref_child");
  await connection.query("INSERT IGNORE INTO lab_ref_parent VALUES (1)");
  await lab.db
    .prepare(
      "CREATE TABLE IF NOT EXISTS lab_ref_parent (id INTEGER PRIMARY KEY)",
    )
    .run();
  await lab.db
    .prepare(
      "CREATE TABLE IF NOT EXISTS lab_ref_child (id INTEGER PRIMARY KEY, parentId INTEGER NOT NULL REFERENCES lab_ref_parent(id), requestKey TEXT UNIQUE, quantity INTEGER NOT NULL CHECK(quantity >= 0))",
    )
    .run();
  await lab.db.prepare("INSERT OR IGNORE INTO lab_ref_parent VALUES (1)").run();
  for (const [id, key] of [
    [1, null],
    [2, null],
    [3, "request-one"],
  ]) {
    await connection.execute("INSERT INTO lab_ref_child VALUES (?,1,?,1)", [
      id,
      key,
    ]);
    await lab.db
      .prepare("INSERT INTO lab_ref_child VALUES (?,1,?,1)")
      .bind(id, key)
      .run();
  }
  for (const [id, parentId, requestKey, quantity] of [
    [4, 1, "request-one", 1],
    [5, 9999, "orphan", 1],
    [6, 1, "negative", -1],
    [7, null, "missing-parent", 1],
  ]) {
    await assert.rejects(
      connection.execute("INSERT INTO lab_ref_child VALUES (?,?,?,?)", [
        id,
        parentId,
        requestKey,
        quantity,
      ]),
    );
    await assert.rejects(
      lab.db
        .prepare("INSERT INTO lab_ref_child VALUES (?,?,?,?)")
        .bind(id, parentId, requestKey, quantity)
        .run(),
    );
  }
  const [[mysqlCount]] = await connection.query(
    "SELECT COUNT(*) AS n FROM lab_ref_child",
  );
  const d1Count = await lab.db
    .prepare("SELECT COUNT(*) AS n FROM lab_ref_child")
    .first();
  assert.equal(mysqlCount.n, 3);
  assert.equal(d1Count.n, 3);
  evidence.cases.push({ name: "constraint-rejection-parity", passed: true });
});

test("actual MySQL test collation differs from SQLite BINARY and NOCASE: migration must resolve identifiers", async () => {
  const [[mysqlEquality]] = await connection.query(
    "SELECT _utf8mb4'Résumé' COLLATE utf8mb4_unicode_ci = _utf8mb4'resume' COLLATE utf8mb4_unicode_ci AS accentEqual, _utf8mb4'key ' COLLATE utf8mb4_unicode_ci = _utf8mb4'key' COLLATE utf8mb4_unicode_ci AS padEqual",
  );
  const d1Equality = await lab.db
    .prepare(
      "SELECT 'Résumé' = 'resume' COLLATE NOCASE AS accentEqual, 'key ' = 'key' AS padEqual",
    )
    .first();
  assert.equal(mysqlEquality.accentEqual, 1);
  assert.equal(mysqlEquality.padEqual, 1);
  assert.equal(d1Equality.accentEqual, 0);
  assert.equal(d1Equality.padEqual, 0);
  evidence.cases.push({
    name: "collation-difference-detected",
    mysql: mysqlEquality,
    d1: d1Equality,
    passed: true,
  });
  evidence.limits.push(
    "utf8mb4_unicode_ci accent/case/PAD semantics are not reproduced by SQLite NOCASE; identifier normalization and collision review remain a cutover blocker. Live production collation was not inspected.",
  );
});

test("MySQL baseline rolls back source and exact money effects on late constraint failure", async () => {
  await connection.query(
    "CREATE TABLE IF NOT EXISTS lab_ref_effects (id INT PRIMARY KEY, amount DECIMAL(20,2) NOT NULL CHECK(amount >= 0)) ENGINE=InnoDB",
  );
  await connection.query("DELETE FROM lab_ref_effects");
  await connection.beginTransaction();
  try {
    await connection.execute("INSERT INTO lab_ref_effects VALUES (?,?)", [
      1,
      "1234.56",
    ]);
    await assert.rejects(
      connection.execute("INSERT INTO lab_ref_effects VALUES (?,?)", [
        2,
        "-0.01",
      ]),
    );
  } finally {
    await connection.rollback();
  }
  const [[row]] = await connection.query(
    "SELECT COUNT(*) AS n FROM lab_ref_effects",
  );
  assert.equal(row.n, 0);
  evidence.cases.push({ name: "mysql-late-failure-baseline", passed: true });
});
