/// <reference path="./snapshot-sqljs.d.ts" />
import initSqlJs from "./node_modules/sql.js/dist/sql-wasm.js";
import wasm from "./sql-wasm.wasm";
import { drizzle } from "drizzle-orm/mysql-proxy";
import Decimal from "decimal.js";
import { tables as defaultTables, quote } from "./schema";
import { allowedQueries as defaultAllowedQueries } from "./schema-queries";
import {
  cashProjectionSql,
  cashReadBoundary,
  assertCashReadBoundary,
} from "./cash-state";
let engine: Promise<any> | undefined;
// Lab resource evidence counts actual SQLite allocations and explicit closes.
const resources = { allocated: 0, closed: 0 };
const schemaTemplates = new WeakMap<
  object,
  { ddl: string; bytes: Uint8Array }
>();
// mysql2 decodes JSON columns before Drizzle sees them; the SQLite proxy must
// provide the same values rather than silently hiding structured settings.
type SnapshotOptions = {
  tables?: typeof defaultTables;
  allowedQueries?: Set<string>;
  projectionSql?: string;
  mode?: string;
  exactCustomerBalance?: boolean;
  rejectDeliveryHistory?: boolean;
  schemaTemplate?: boolean;
  preloaded?: {
    row: any;
    envelope: string;
    boundary: ReturnType<typeof cashReadBoundary>;
  };
};
export const snapshotResourceCounts = () => ({ ...resources });
function sqlEngine() {
  return (engine ??= initSqlJs({
    instantiateWasm(imports: any, success: any) {
      const instance = new WebAssembly.Instance(wasm, imports);
      success(instance, wasm);
      return instance.exports;
    },
  }));
}
// Compile immutable code at cashier connection time; no rows or balances are cached.
function emptySchemaTemplate(SQL: any, tables: typeof defaultTables) {
  const ddl = tables.map((t) => t.ddl).join("\n");
  const prior = schemaTemplates.get(tables);
  if (prior?.ddl === ddl) return prior.bytes;
  const template = new SQL.Database();
  resources.allocated++;
  try {
    template.run(ddl);
    const bytes = template.export();
    schemaTemplates.set(tables, { ddl, bytes });
    return bytes;
  } finally {
    template.close();
    resources.closed++;
  }
}
export async function warmSnapshotEngine(tables?: typeof defaultTables) {
  const SQL = await sqlEngine();
  if (tables) emptySchemaTemplate(SQL, tables);
}
export async function snapshotDatabase(
  binding: any,
  input: any,
  actor: any,
  options: SnapshotOptions = {},
) {
  const tables = options.tables ?? defaultTables,
    allowedQueries = options.allowedQueries ?? defaultAllowedQueries;
  const jsonColumns = new Set(
    tables.flatMap((t) =>
      t.columns.filter((c) => c.sqlType === "json").map((c) => c.name),
    ),
  );
  const session = binding.withSession
    ? binding.withSession("first-primary")
    : binding;
  const boundary = options.preloaded?.boundary ?? cashReadBoundary();
  const envelope = JSON.stringify({ input, actor, ...boundary });
  if (options.preloaded && options.preloaded.envelope !== envelope)
    throw Error("SNAPSHOT_ENVELOPE_MISMATCH");
  if (options.preloaded && !options.preloaded.row)
    throw Error("SNAPSHOT_ROW_MISSING");
  const snapshot =
    options.preloaded?.row ??
    (await session
      .prepare(options.projectionSql ?? cashProjectionSql)
      .bind(envelope)
      .first());
  assertCashReadBoundary(boundary);
  if (options.rejectDeliveryHistory) {
    const flags = JSON.parse(snapshot.scopeFlags);
    if (flags.deliveryHistory)
      throw Error("UNSUPPORTED_CUSTOMER_DELIVERY_HISTORY");
    if (flags.unsupportedCollection)
      throw Error("UNSUPPORTED_CREDIT_COLLECTION_INVOICE");
  }
  const expectedEpoch = snapshot.epoch;
  if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0)
    throw Error("INVALID_EPOCH");
  const SQL = await sqlEngine();
  // SQL.js may own/mutate its input buffer. Each invocation receives a COPY
  // of a schema-only database; the retained template never receives any rows.
  const local = options.schemaTemplate
    ? new SQL.Database(new Uint8Array(emptySchemaTemplate(SQL, tables)))
    : new SQL.Database();
  resources.allocated++;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    local.close();
    resources.closed++;
  };
  try {
    if (!options.schemaTemplate) local.run(tables.map((t) => t.ddl).join("\n"));
    // Hydration is private and discarded on failure. One local transaction
    // and one prepared INSERT per table avoid reparsing every historical row.
    local.run("BEGIN");
    const before: Record<string, any[]> = {};
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      const rows = JSON.parse(snapshot[t.name]);
      before[t.name] = rows;
      if (!rows.length) continue;
      const names = t.columns.map((column) => column.name);
      const statement = local.prepare(
        "INSERT INTO " +
          quote(t.name) +
          " (" +
          names.map(quote).join(",") +
          ") VALUES (" +
          names.map(() => "?").join(",") +
          ")",
      );
      try {
        for (const row of rows) {
          validateRow(t, row);
          statement.run(names.map((name) => row[name]));
        }
      } finally {
        statement.free();
      }
    }
    const sequences = JSON.parse(snapshot.sequences);
    for (const t of tables.filter((t) => t.columns.some((c) => c.auto))) {
      const seq = sequences[t.name] ?? 0;
      if (!Number.isSafeInteger(seq) || seq < 0)
        throw Error("INVALID_SEQUENCE:" + t.name);
      const localSeq =
        local.exec(
          "SELECT seq FROM sqlite_sequence WHERE name=" + "'" + t.name + "'",
        )[0]?.values[0]?.[0] ?? 0;
      if (seq < localSeq) throw Error("INVALID_SEQUENCE:" + t.name);
      local.run("UPDATE sqlite_sequence SET seq=? WHERE name=?", [seq, t.name]);
      if (!local.getRowsModified())
        local.run("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)", [
          t.name,
          seq,
        ]);
    }
    local.run("COMMIT");
    let lastInsertId = 0;
    const trace: any[] = [];
    const callback = async (
      original: string,
      params: any[],
      method: string,
    ) => {
      params = params.map((v) =>
        v instanceof Date ? v.toISOString().slice(0, 23).replace("T", " ") : v,
      );
      trace.push({ sql: original, params, method });
      const shape = original
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\(\?(, \?)+\)/g, "(?)");
      if (!allowedQueries.has(shape))
        throw Error("UNSUPPORTED_SQL_SHAPE: " + shape);
      let sql = original.trim();
      let changedCustomerId: number | null = null;
      if (
        options.exactCustomerBalance &&
        /^update `customers` set `currentBalance` = `customers`\.`currentBalance` \+ \?/i.test(
          sql,
        )
      ) {
        const row = local.exec(
          "SELECT currentBalance FROM customers WHERE id=" +
            Number(params.at(-1)),
        )[0]?.values[0];
        if (!row) throw Error("CUSTOMER_BALANCE_ROW_MISSING");
        const oldBalance = new Decimal(row[0] as string),
          newBalance = oldBalance.plus(new Decimal(params[0]));
        if (!oldBalance.eq(newBalance))
          changedCustomerId = Number(params.at(-1));
        params = [newBalance.toFixed(2), ...params.slice(1)];
        sql = sql.replace("`customers`.`currentBalance` + ?", "?");
      }
      if (/^SELECT LAST_INSERT_ID\(\) AS v$/i.test(sql))
        return { rows: [[{ v: lastInsertId }]] };
      if (
        /^INSERT INTO documentCounters \(counterKey, lastValue\)\s+VALUES \(\?, LAST_INSERT_ID\(\?\)\)\s+ON DUPLICATE KEY UPDATE lastValue = LAST_INSERT_ID\(lastValue \+ 1\)$/i.test(
          sql,
        )
      ) {
        local.run(
          "INSERT INTO documentCounters(counterKey,lastValue) VALUES(?,?) ON CONFLICT(counterKey) DO UPDATE SET lastValue=lastValue+1,updatedAt=CURRENT_TIMESTAMP",
          params,
        );
        const stmt = local.prepare(
          "SELECT lastValue FROM documentCounters WHERE counterKey=?",
        );
        stmt.bind([params[0]]);
        stmt.step();
        lastInsertId = stmt.get()[0];
        stmt.free();
        return { rows: [{ insertId: lastInsertId, affectedRows: 1 }] };
      }
      if (/;|\b(?:DELETE|DROP|ALTER|PRAGMA|ATTACH|REPLACE)\b/i.test(sql))
        throw Error("Unsupported SQL: " + sql);
      // These locks operate on one private state; D1 epoch CAS validates ALL of it.
      sql = sql.replace(/\s+for (?:update|share)(?=\s+limit|$)/gi, "");
      sql = sql
        .replace(/CURRENT_TIMESTAMP\(3\)/g, "CURRENT_TIMESTAMP")
        .replace(/NOW\(\)/gi, "CURRENT_TIMESTAMP")
        .replace(
          /DATE_ADD\((`onlineOrders`\.`orderDate`), INTERVAL 24 HOUR\)/g,
          "datetime($1, '+24 hours')",
        );
      if (/on duplicate key update/i.test(sql)) {
        if (
          !/^insert into `branchStock` /i.test(sql) ||
          !/on duplicate key update `variantId` = `branchStock`\.`variantId`$/i.test(
            sql,
          )
        )
          throw Error("Unsupported upsert: " + sql);
        sql = sql.replace(
          /on duplicate key update.*$/i,
          "ON CONFLICT(variantId,branchId) DO NOTHING",
        );
      }
      if (/^insert into /i.test(sql)) {
        const match = /^insert into (`\w+`) \(([^)]+)\) values /i.exec(sql);
        if (match) {
          const table = tables.find((t) => quote(t.name) === match[1]);
          if (!table) throw Error("Unsupported table");
          const names = match[2]
            .split(",")
            .map((s) => s.trim().replaceAll("`", ""));
          // DEFAULT appears interspersed with parameters. Rebuild values row by row.
          const start = match[0].length;
          const originalTail = original
            .trim()
            .slice(start)
            .replace(/ on duplicate key update.*$/i, "");
          const rewritten = originalTail.replace(
            /\(([^()]*)\)/g,
            (_all, body) =>
              "(" +
              body
                .split(",")
                .map((token: string, col: number) => {
                  const column = table.columns.find(
                    (c) => c.name === names[col],
                  );
                  if (token.trim().toLowerCase() === "default")
                    return column?.defaultSql ?? "NULL";
                  // Original MySQL DATE columns discard the time on assignment.
                  // Coerce only bound DATE values in the existing INSERT allowlist,
                  // before staging reads/afterimages; keep parameter positions intact.
                  if (column?.sqlType === "date" && token.trim() === "?")
                    return "date(?)";
                  return token;
                })
                .join(",") +
              ")",
          );
          const suffix = sql.includes("ON CONFLICT")
            ? " " + sql.slice(sql.indexOf("ON CONFLICT"))
            : "";
          sql = sql.slice(0, start) + rewritten + suffix;
        }
      }
      // SQL arithmetic is allowed only for integer stock and document sequences.
      const emptyDeliveryRead =
        options.rejectDeliveryHistory &&
        /^select /i.test(sql) &&
        /from `deliveryConsignments`/.test(sql) &&
        before.deliveryConsignments.length === 0 &&
        !/\b(?:SUM|AVG|ROUND)\s*\(/i.test(sql);
      if (/\b(?:SUM|AVG|CAST|ROUND)\s*\(/i.test(sql) && !emptyDeliveryRead)
        throw Error("Unsupported numeric SQL: " + sql);
      if (
        /^update /i.test(sql) &&
        /[+*/]/.test(sql) &&
        !/^update `branchStock` set `quantity` = `branchStock`\.`quantity` \+ \?/i.test(
          sql,
        )
      )
        throw Error("Unsupported arithmetic: " + sql);
      try {
        if (/^select/i.test(sql)) {
          const stmt = local.prepare(sql);
          try {
            stmt.bind(params);
            const rows = [];
            const names = stmt.getColumnNames();
            while (stmt.step()) {
              const values = stmt
                .get()
                .map((value: any, i: number) =>
                  jsonColumns.has(names[i]) && typeof value === "string"
                    ? JSON.parse(value)
                    : value,
                );
              rows.push(
                method === "all"
                  ? values
                  : Object.fromEntries(
                      names.map((name: string, i: number) => [name, values[i]]),
                    ),
              );
            }
            return { rows: method === "all" ? rows : [rows] };
          } finally {
            stmt.free();
          }
        }
        local.run(sql, params);
        const affectedRows = local.getRowsModified();
        if (changedCustomerId !== null && affectedRows)
          local.run(
            "UPDATE customers SET updatedAt=CURRENT_TIMESTAMP WHERE id=?",
            [changedCustomerId],
          );
        if (/^update `branchStock` /i.test(sql) && affectedRows)
          local.run(
            "UPDATE branchStock SET updatedAt=CURRENT_TIMESTAMP WHERE variantId=? AND branchId=?",
            params.slice(-2),
          );
        const insertId =
          local.exec("SELECT last_insert_rowid()")[0]?.values[0][0] ?? 0;
        return { rows: [{ insertId, affectedRows }] };
      } catch (e: any) {
        throw Error(
          e.message + " | SQL " + sql + " | params " + JSON.stringify(params),
        );
      }
    };
    const tx = drizzle(callback as any);
    function changes() {
      const result: any[] = [];
      for (const t of tables) {
        const raw = local.exec("SELECT * FROM " + quote(t.name))[0];
        const after = raw
          ? raw.values.map((vals: any[]) =>
              Object.fromEntries(
                raw.columns.map((c: string, i: number) => [c, vals[i]]),
              ),
            )
          : [];
        for (const row of after) {
          validateRow(t, row);
          for (const c of t.columns)
            if (c.decimal && row[c.name] != null)
              row[c.name] = new Decimal(row[c.name]).toFixed(c.decimal.scale);
        }
        const key = (r: any) => JSON.stringify(t.primary.map((k) => r[k]));
        const previous = new Map(before[t.name].map((r) => [key(r), r]));
        for (const row of after) {
          const prev = previous.get(key(row)) ?? null;
          if (JSON.stringify(prev) !== JSON.stringify(row))
            result.push({
              table: t.name,
              key: Object.fromEntries(t.primary.map((k) => [k, row[k]])),
              before: prev,
              after: row,
            });
          previous.delete(key(row));
        }
        if (previous.size) throw Error("Deletion unsupported");
      }
      return result;
    }
    return {
      tx,
      trace,
      expectedEpoch,
      before,
      boundary,
      metrics: {
        mode: options.mode ?? "CASH_SCOPED",
        rows: Object.fromEntries(
          tables.map((t) => [t.name, before[t.name].length]),
        ),
        totalRows: Object.values(before).reduce((n, r) => n + r.length, 0),
        bytes: new TextEncoder().encode(JSON.stringify(snapshot)).byteLength,
      },
      changes,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
function validateRow(t: any, row: any) {
  for (const c of t.columns) {
    const v = row[c.name];
    if (v == null) continue;
    if (c.decimal) {
      if (typeof v !== "string") throw Error("DECIMAL_TEXT_REQUIRED");
      const value = new Decimal(v);
      if (
        !value.isFinite() ||
        value.decimalPlaces() > c.decimal.scale ||
        value
          .abs()
          .gte(new Decimal(10).pow(c.decimal.precision - c.decimal.scale))
      )
        throw Error("DECIMAL_RANGE: " + t.name + "." + c.name);
    } else if (c.type === "INTEGER") {
      if (
        !Number.isSafeInteger(v) ||
        (/^int(?:\(|$)/.test(c.sqlType) && (v < -2147483648 || v > 2147483647))
      )
        throw Error("INTEGER_RANGE: " + t.name + "." + c.name);
    }
  }
}
