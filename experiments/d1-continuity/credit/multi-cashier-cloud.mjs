import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { creditCloudContext, verifyCreditResources } from "./cloud-run.mjs";
import { creditRoot } from "./build.mjs";
import { cashCloudClient } from "../cash/cloud-client.mjs";
import { readPagedSnapshot, canonical } from "../cash/paged-client.mjs";
assert.equal(process.argv[2], "--confirm-isolated-credit-lab");
const c = await creditCloudContext();
await verifyCreditResources(c);
const dir = path.join(creditRoot, "results/subsecond-20261018");
await mkdir(dir, { recursive: true });
const sql = await readFile(
  path.join(creditRoot, "build/cloud/multi-cashier.sql"),
  "utf8",
);
assert.ok(!/\b(?:DROP|DELETE|ALTER|TRUNCATE)\b/i.test(sql));
assert.ok(!/UPDATE\s+(?!`?(?:users|shifts)`?\s)/i.test(sql));
const query = async (role, command) =>
  c.invoke(
    [
      "d1",
      "execute",
      c.runtime.databases[role].databaseId,
      "--remote",
      "--command",
      command,
      "--json",
    ],
    true,
    true,
  );
const expectedUsers = [11, 12, 13, 14].map((id) => ({
  id,
  openId: "credit-lab-" + id,
  name: "Synthetic Credit Cashier " + id,
  role: "cashier",
  branchId: 1,
  loginMethod: "local",
}));
const expectedShifts = [11, 12, 13, 14].map((id) => ({
  id,
  userId: id,
  branchId: 1,
  shiftStatus: "OPEN",
  shiftType: "RETAIL",
  openingBalance: "0.00",
  openGuard: "1:" + id + ":RETAIL",
}));
async function verifyRows(role, complete = false) {
  const r = await query(
    role,
    "SELECT role FROM cashSandboxIdentity WHERE id='actual-credit-20261018';SELECT id,openId,name,role,branchId,loginMethod FROM users WHERE id BETWEEN11 AND14 ORDER BY id;SELECT id,userId,branchId,shiftStatus,shiftType,openingBalance,openGuard FROM shifts WHERE id BETWEEN11 AND14 ORDER BY id;"
      .replaceAll("BETWEEN11", "BETWEEN 11")
      .replaceAll("AND14", "AND 14"),
  );
  assert.equal(r[0].results[0]?.role, role);
  for (const [rows, expected] of [
    [r[1].results, expectedUsers],
    [r[2].results, expectedShifts],
  ]) {
    if (complete) assert.equal(rows.length, 4);
    for (const row of rows)
      assert.deepEqual(
        row,
        expected.find((e) => e.id === row.id),
      );
  }
  return r;
}
for (const role of ["primary", "restore"])
  await verifyRows(role, !!c.runtime.multiCashierFixtureAt);
if (c.runtime.multiCashierFixtureAt) {
  console.log("Existing matching four-cashier baseline retained");
  process.exit(0);
}
let requests = 0;
const call = cashCloudClient(c, () => requests++),
  beforeRows = {};
const beforeFile = path.join(dir, "fixture-before.json");
let before;
try {
  before = JSON.parse(await readFile(beforeFile, "utf8"));
  Object.assign(beforeRows, before.rows);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  const snapshot = await readPagedSnapshot(call, c.source, {
    onRow: (t, r) => (beforeRows[t] ??= []).push(r),
  });
  assert.deepEqual(await readPagedSnapshot(call, c.restore), snapshot);
  before = { snapshot, rows: beforeRows };
  await writeFile(beforeFile, JSON.stringify(before, null, 2), { flag: "wx" });
}
for (const role of ["primary", "restore"]) {
  const rows = await verifyRows(role);
  if (rows[1].results.length === 4 && rows[2].results.length === 4) continue;
  // Existing rows were checked above. Idempotent additive INSERTs allow a
  // known partial import to resume without replacing financial data.
  const additive = sql.replace(
    /(INSERT INTO [^;]+);/g,
    "$1 ON CONFLICT(id) DO NOTHING;",
  );
  const file = path.join(c.cwd, "credit-multi-cashier-" + role + ".sql");
  await writeFile(file, additive);
  await c.invoke(
    [
      "d1",
      "execute",
      c.runtime.databases[role].databaseId,
      "--remote",
      "--file",
      file,
      "--yes",
      "--json",
    ],
    true,
  );
  await verifyRows(role, true);
}
const afterRows = {};
const after = await readPagedSnapshot(call, c.source, {
  onRow: (t, r) => (afterRows[t] ??= []).push(r),
});
assert.equal(after.epoch, before.snapshot.epoch);
for (const table of Object.keys(before.snapshot.counts)) {
  const rows = afterRows[table] ?? [],
    old = beforeRows[table] ?? [];
  assert.equal(
    canonical(
      ["users", "shifts"].includes(table)
        ? rows.filter((r) => r.id < 11 || r.id > 14)
        : rows,
    ),
    canonical(old),
    table + " prior data changed",
  );
}
assert.deepEqual(await readPagedSnapshot(call, c.restore), after);
await writeFile(path.join(dir, "multi-cashier-baseline.sql"), sql, {
  flag: "wx",
});
await writeFile(
  path.join(dir, "fixture-extension.json"),
  JSON.stringify(
    {
      passed: true,
      before: before.snapshot,
      after,
      sourceAndRestoreMatch: true,
      previousRowsUnchanged: true,
      usersAdded: 4,
      shiftsAdded: 4,
      stockOrMoneyAdjusted: false,
      sqlSha256: createHash("sha256").update(sql).digest("hex"),
      requests,
    },
    null,
    2,
  ),
);
c.runtime.multiCashierFixtureAt = new Date().toISOString();
await c.save();
console.log(
  JSON.stringify({
    passed: true,
    epoch: after.epoch,
    rows: after.totalRows,
    usersAdded: 4,
    shiftsAdded: 4,
    stockOrMoneyAdjusted: false,
  }),
);
