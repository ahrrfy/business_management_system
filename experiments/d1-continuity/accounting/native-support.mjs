import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { nativeLab } from "./native.mjs";
export const oracle = JSON.parse(
  await readFile(
    new URL("./results/mysql-oracle.json", import.meta.url),
    "utf8",
  ),
);
export const clock = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d:\d\d(?:\.\d+)?Z?)?$/.test(v);
export const normalize = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?Z?$/.test(v)
    ? "<clock>"
    : Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v).map(([k, x]) => [k, normalize(x)]),
          )
        : v;
export const wire = (input) => {
  const { paymentMode, enforceBranchId, ...rest } = input;
  return {
    ...rest,
    branchId: 1,
    shiftId: input.shiftId ?? 1,
    ...(input.commandType === "SALE" && paymentMode === "PREPAID"
      ? { commandType: "CASH_SALE" }
      : {}),
  };
};
export async function setupLab(name = "accounting-matrix", options = {}) {
  const lab = await nativeLab({ name, ...options });
  const metadata = JSON.parse(
    await readFile(lab.buildDir + "/tables.json", "utf8"),
  );
  lab.tables = metadata;
  lab.seed = async (state, target = lab.db) => {
    const statements = [];
    for (const table of [
      "accounts",
      "statutoryAccountingProfiles",
      "statutoryAccounts",
      "statutoryAccountMappings",
      "doubleEntrySettings",
    ]) {
      const t = metadata.find((t) => t.name === table);
      statements.push(target.prepare("DELETE FROM `" + table + "`"));
      for (const row of state[table]) {
        const names = t.columns.map((c) => c.name);
        const values = t.columns.map((c) => {
          const v = row[c.name];
          return v && typeof v === "object"
            ? JSON.stringify(v)
            : clock(v) && c.sqlType !== "date"
              ? v.replace("T", " ").replace("Z", "")
              : v;
        });
        statements.push(
          target
            .prepare(
              "INSERT INTO `" +
                table +
                "`(" +
                names.map((n) => "`" + n + "`").join(",") +
                ") VALUES(" +
                names.map(() => "?").join(",") +
                ")",
            )
            .bind(...values),
        );
      }
    }
    await target.batch(statements);
    await target
      .prepare("UPDATE productPrices SET price='83.37' WHERE id=1")
      .run();
    await target
      .prepare("UPDATE productVariants SET costPrice='41.68' WHERE id=1")
      .run();
  };
  lab.graph = async () => {
    const graph = {};
    for (const name of Object.keys(oracle.scenarios[0].commands[0].before)) {
      if (name === "waOutbox") continue; // Not projected; external delivery is outside qualification.
      const t = metadata.find((t) => t.name === name);
      const rows = (await lab.db.prepare("SELECT * FROM `" + name + "`").all())
        .results;
      graph[name] = rows.map((r) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [
            k,
            t.columns.find((c) => c.name === k)?.sqlType === "json" &&
            typeof v === "string"
              ? JSON.parse(v)
              : v,
          ]),
        ),
      );
    }
    return graph;
  };
  return lab;
}
export function compareGraph(actual, expected, label, tables) {
  const { auditLogs, waOutbox, ...a } = actual,
    {
      auditLogs: originalDirectAudit,
      waOutbox: originalExternalOutbox,
      ...e
    } = expected;
  const ordered = (g) =>
    Object.fromEntries(
      Object.entries(g).map(([table, rows]) => [
        table,
        normalize(
          rows.map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                tables
                  .find((t) => t.name === table)
                  ?.columns.find((c) => c.name === key)?.sqlType === "date" &&
                typeof value === "string"
                  ? value.slice(0, 10)
                  : value,
              ]),
            ),
          ),
        ).sort((a, b) =>
          String(a.id ?? a.counterKey).localeCompare(
            String(b.id ?? b.counterKey),
          ),
        ),
      ]),
    );
  assert.deepEqual(ordered(a), ordered(e), label);
}
