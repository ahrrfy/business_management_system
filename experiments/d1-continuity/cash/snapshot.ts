/// <reference path="./snapshot-sqljs.d.ts" />
import initSqlJs from "./node_modules/sql.js/dist/sql-wasm.js";
import wasm from "./sql-wasm.wasm";
import { drizzle } from "drizzle-orm/mysql-proxy";
import Decimal from "decimal.js";
import { tables, quote } from "./schema";
import { allowedQueries } from "./schema-queries";
let engine: Promise<any> | undefined;
// Lab resource evidence counts actual SQLite allocations and explicit closes.
const resources = { allocated: 0, closed: 0 };
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
export async function snapshotDatabase(binding: any) {
  const session = binding.withSession
    ? binding.withSession("first-primary")
    : binding;
  const object = (names: string[]) =>
    "json_object(" +
    names.flatMap((n) => ["'" + n + "'", quote(n)]).join(",") +
    ")";
  const pieces = tables.map((t) => {
    let obj = object(t.columns.slice(0, 15).map((c) => c.name));
    for (let i = 15; i < t.columns.length; i += 15)
      obj =
        "json_set(" +
        obj +
        "," +
        t.columns
          .slice(i, i + 15)
          .flatMap((c) => ["'$.'||'" + c.name + "'", quote(c.name)])
          .join(",") +
        ")";
    return (
      "(SELECT json_group_array(json(rowJson)) FROM (SELECT " +
      obj +
      " AS rowJson FROM " +
      quote(t.name) +
      " ORDER BY " +
      t.primary.map(quote).join(",") +
      ")) AS " +
      quote(t.name)
    );
  });
  const snapshot = await session
    .prepare("SELECT epoch," + pieces.join(",") + " FROM cashEpoch WHERE id=1")
    .first();
  const expectedEpoch = snapshot.epoch;
  if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0)
    throw Error("INVALID_EPOCH");
  const SQL = await sqlEngine();
  const local = new SQL.Database();
  resources.allocated++;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    local.close();
    resources.closed++;
  };
  try {
    local.run(tables.map((t) => t.ddl).join("\n"));
    // Hydration is private and discarded on failure. One local transaction
    // and one prepared INSERT per table avoid reparsing every historical row.
    local.run("BEGIN");
    const before: Record<string, any[]> = {};
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      const rows = JSON.parse(snapshot[t.name]);
      if (rows.length > 1000) throw Error("SNAPSHOT_LAB_LIMIT");
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
      if (/\b(?:SUM|AVG|CAST|ROUND)\s*\(/i.test(sql))
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
            while (stmt.step())
              rows.push(method === "all" ? stmt.get() : stmt.getAsObject());
            return { rows: method === "all" ? rows : [rows] };
          } finally {
            stmt.free();
          }
        }
        local.run(sql, params);
        const affectedRows = local.getRowsModified();
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
