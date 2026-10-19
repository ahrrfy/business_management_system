import { idempotencyHash } from "../../../server/services/idempotency";
import { quote } from "./schema";
import { assertCashReadBoundary } from "./cash-state";
export function canonicalCashJson(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalCashJson).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalCashJson(value[key]))
      .join(",") +
    "}"
  );
}
export function cashCommandFromRow(row: any) {
  return row
    ? {
        requestId: row.requestId,
        requestHash: row.requestHash,
        result: JSON.parse(row.resultJson),
        request: JSON.parse(row.requestJson),
        plan: JSON.parse(row.planJson),
        planHash: row.planHash,
      }
    : null;
}
export async function readCashCommand(binding: any, requestId: string) {
  return cashCommandFromRow(
    await binding
      .prepare("SELECT * FROM cashCommands WHERE requestId=?")
      .bind(requestId)
      .first(),
  );
}
// Native-only candidate: combine adjacent inserts of the SAME table/columns.
// Each group stays within D1's100 bound parameters; update preimages remain exact.
export function planChangeGroups(
  changes: any[],
  groupInserts = false,
): any[][] {
  const groups: any[][] = [];
  for (const change of changes) {
    const previous = groups.at(-1);
    if (
      groupInserts &&
      !change.before &&
      previous &&
      !previous[0].before &&
      previous[0].table === change.table &&
      JSON.stringify(Object.keys(previous[0].after)) ===
        JSON.stringify(Object.keys(change.after)) &&
      (previous.length + 1) * Object.keys(change.after).length <= 100
    )
      previous.push(change);
    else groups.push([change]);
  }
  return groups;
}
export function planMutationStatements(changes: any[], groupInserts = false) {
  return planChangeGroups(changes, groupInserts).reduce(
    (n, g) => n + (g[0].before ? 2 : 1),
    0,
  );
}
export async function applyPlan(
  binding: any,
  plan: any,
  config: {
    tables: Array<{
      name: string;
      primary: string[];
      columns: Array<{ name: string }>;
    }>;
    mutableTables: Set<string>;
    schemaVersion: string;
    maxChanges?: number;
    groupInserts?: boolean;
  },
  options: {
    fault?: boolean;
    knownAbsent?: boolean;
    historicalRestore?: boolean;
  } = {},
) {
  if (
    plan.version !== 1 ||
    plan.schemaVersion !== config.schemaVersion ||
    !Number.isSafeInteger(plan.expectedEpoch) ||
    plan.requestId !== plan.request?.input?.clientRequestId ||
    plan.requestHash !== idempotencyHash(plan.request) ||
    !Array.isArray(plan.changes) ||
    plan.changes.length > (config.maxChanges ?? 30)
  )
    throw Error("INVALID_PLAN_VERSION");
  // The original epoch CAS and unique command key still arbitrate a race after
  // the caller's authoritative preflight. Restore/default callers re-read.
  const existing = options.knownAbsent
    ? null
    : await readCashCommand(binding, plan.requestId);
  if (existing) {
    if (existing.requestHash !== plan.requestHash)
      throw Error("REQUEST_CONFLICT");
    return { ...existing.result, idempotentReplay: true };
  }
  if (plan.readBoundary && !options.historicalRestore)
    assertCashReadBoundary(plan.readBoundary);
  const statements = [
    binding
      .prepare("UPDATE cashEpoch SET epoch=epoch+1 WHERE id=1 AND epoch=?")
      .bind(plan.expectedEpoch),
    binding.prepare("INSERT INTO cashAssert(ok) VALUES(changes())"),
  ];
  for (const group of planChangeGroups(plan.changes, config.groupInserts)) {
    const change = group[0];
    const table = config.tables.find((t) => t.name === change.table);
    if (!table || !config.mutableTables.has(change.table))
      throw Error("INVALID_PLAN_TABLE");
    const keys = table.primary;
    const row = change.after;
    const names = Object.keys(row);
    if (
      names.length !== table.columns.length ||
      group.some(
        (c) =>
          Object.keys(c.after).length !== table.columns.length ||
          Object.keys(c.after).some(
            (k) => !table.columns.some((col) => col.name === k),
          ) ||
          keys.some((k) => c.after[k] !== c.key[k]),
      )
    )
      throw Error("INVALID_PLAN_COLUMN");
    if (change.before) {
      const columns = Object.keys(change.before);
      if (
        columns.length !== table.columns.length ||
        columns.some((k) => !table.columns.some((c) => c.name === k)) ||
        keys.some((k) => change.before[k] !== change.key[k])
      )
        throw Error("INVALID_PLAN_PREIMAGE");
      statements.push(
        binding
          .prepare(
            "INSERT INTO cashAssert(ok) SELECT CASE WHEN EXISTS(SELECT 1 FROM " +
              quote(table.name) +
              " WHERE " +
              columns.map((k) => quote(k) + " IS ?").join(" AND ") +
              ") THEN 1 ELSE 0 END",
          )
          .bind(...columns.map((k) => change.before[k])),
      );
      statements.push(
        binding
          .prepare(
            "UPDATE " +
              quote(table.name) +
              " SET " +
              names.map((k) => quote(k) + "=?").join(",") +
              " WHERE " +
              keys.map((k) => quote(k) + "=?").join(" AND "),
          )
          .bind(...names.map((k) => row[k]), ...keys.map((k) => change.key[k])),
      );
    } else
      statements.push(
        binding
          .prepare(
            "INSERT INTO " +
              quote(table.name) +
              " (" +
              names.map(quote).join(",") +
              ") VALUES " +
              group
                .map(() => "(" + names.map(() => "?").join(",") + ")")
                .join(","),
          )
          .bind(...group.flatMap((c) => names.map((k) => c.after[k]))),
      );
  }
  const planJson = canonicalCashJson(plan),
    planHash = idempotencyHash(plan);
  statements.push(
    binding
      .prepare("INSERT INTO cashCommands VALUES(?,?,?,?,?,?)")
      .bind(
        plan.requestId,
        plan.requestHash,
        canonicalCashJson(plan.request),
        canonicalCashJson(plan.result),
        planJson,
        planHash,
      ),
    binding
      .prepare("INSERT INTO cashOutbox VALUES(?,?,?,?)")
      .bind(plan.outbox.eventId, plan.requestId, planJson, planHash),
  );
  statements.push(binding.prepare("DELETE FROM cashAssert"));
  if (options.fault)
    statements.push(binding.prepare("INSERT INTO cashAssert(ok) VALUES(0)"));
  await binding.batch(statements);
  return plan.result;
}
