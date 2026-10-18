import * as source from "../../../drizzle/schema";
import { getTableConfig, MySqlDialect } from "drizzle-orm/mysql-core";
import { getTableName } from "drizzle-orm";
import Decimal from "decimal.js";
import { cashReadIndexes } from './cash-indexes';

// Finite experiment projection; every column/default and unique constraint comes
// from the original schema. This is deliberately not a full ERP schema migration.
export const tableNames = [
  "branches",
  "users",
  "customers",
  "monthCloseSequence",
  "shifts",
  "products",
  "productVariants",
  "productUnits",
  "productPrices",
  "branchStock",
  "invoices",
  "invoiceItems",
  "inventoryMovements",
  "receipts",
  "accountingEntries",
  "idempotencyKeys",
  "documentCounters",
  "financialPeriods",
  "doubleEntrySettings",
  "openingModeSettings",
  "reservationStock",
  "onlineOrders",
  "onlineOrderItems",
  "bundleComponents",
  "promotions",
  "promotionTargets",
  "couponPrograms",
  "invoiceAttributions",
  "cashDailyReconciliations",
  "couponRedemptions",
  "coupons",
  "deliveryConsignments",
];
const dialect = new MySqlDialect();
export const quote = (s: string) => "`" + s.replaceAll("`", "``") + "`";
const literal = (v: any): string =>
  v == null
    ? "NULL"
    : typeof v === "boolean"
      ? v
        ? "1"
        : "0"
      : typeof v === "number"
        ? String(v)
        : "'" + String(v).replaceAll("'", "''") + "'";
export const tables = tableNames.map((name) => {
  const config = getTableConfig((source as any)[name]);
  const columns = config.columns.map((c: any) => {
    const sqlType = c.getSQLType();
    const decimal = /^decimal\((\d+),(\d+)\)$/.exec(sqlType);
    let defaultSql: string | undefined;
    if (c.default !== undefined) {
      defaultSql =
        typeof c.default === "object"
          ? dialect.sqlToQuery(c.default).sql
          : literal(
              decimal ? new Decimal(c.default).toFixed(+decimal[2]) : c.default,
            );
      if (/^\(?now\(\)\)?$/i.test(defaultSql!))
        defaultSql = "CURRENT_TIMESTAMP";
    }
    if (name === "onlineOrders" && c.name === "reservationExpiresAt")
      defaultSql = undefined;
    if (
      c.generated &&
      !(name === "productUnits" && c.name === "barcodeNormalized")
    )
      throw Error("Unsupported generated column " + name + "." + c.name);
    return {
      name: c.name,
      sqlType,
      type:
        decimal || /char|text|enum|json|date|time/i.test(sqlType)
          ? "TEXT"
          : "INTEGER",
      primary: c.primary,
      auto: !!c.autoIncrement,
      notNull: c.notNull,
      defaultSql,
      onUpdateNow: !!c.hasOnUpdateNow,
      decimal: decimal ? { precision: +decimal[1], scale: +decimal[2] } : null,
      enumValues: c.enumValues ?? null,
    };
  });
  const unique = [
    ...config.uniqueConstraints.map((x: any) =>
      x.columns.map((c: any) => c.name),
    ),
    ...config.indexes
      .filter((x: any) => x.config.unique)
      .map((x: any) => x.config.columns.map((c: any) => c.name)),
    ...config.columns.filter((c: any) => c.isUnique).map((c: any) => [c.name]),
  ];
  const primary = columns.filter((c) => c.primary).map((c) => c.name);
  if (!primary.length)
    primary.push(
      ...config.primaryKeys.flatMap((x: any) =>
        x.columns.map((c: any) => c.name),
      ),
    );
  if (!primary.length) throw Error("Missing primary key " + name);
  const foreignKeys = config.foreignKeys.map((fk: any) => {
    const r = fk.reference();
    return {
      columns: r.columns.map((c: any) => c.name),
      foreignTable: getTableName(r.foreignTable),
      foreignColumns: r.foreignColumns.map((c: any) => c.name),
    };
  });
  const sourceChecks = config.checks.map((c: any) =>
    dialect.sqlToQuery(c.value).sql.replaceAll(quote(name) + ".", ""),
  );
  // This slice accepts simple period locks only; governed month closure is excluded.
  const checks =
    name === "financialPeriods"
      ? ["closeMonth IS NULL AND closeRevision IS NULL"]
      : sourceChecks;
  if (name === "productUnits")
    checks.push("barcode IS NULL AND barcodeNormalized IS NULL");
  const constraints = [
    ...unique.map((cols) => "UNIQUE (" + cols.map(quote).join(",") + ")"),
    ...checks.map((s) => "CHECK (" + s + ")"),
    ...foreignKeys.map((f) =>
      tableNames.includes(f.foreignTable) &&
      // Customer references admit read-only online holds. This cash slice still
      // forbids customer-account effects in its financial/coupon tables.
      (f.foreignTable !== 'customers' || ['onlineOrders','customers'].includes(name))
        ? "FOREIGN KEY (" +
          f.columns.map(quote).join(",") +
          ") REFERENCES " +
          quote(f.foreignTable) +
          " (" +
          f.foreignColumns.map(quote).join(",") +
          ") DEFERRABLE INITIALLY DEFERRED"
        : "CHECK (" +
          f.columns.map((c: string) => quote(c) + " IS NULL").join(" AND ") +
          ")",
    ),
  ];
  const ddl =
    "CREATE TABLE " +
    quote(name) +
    " (" +
    columns
      .map(
        (c) =>
          quote(c.name) +
          " " +
          c.type +
          (c.primary ? " PRIMARY KEY" + (c.auto ? " AUTOINCREMENT" : "") : "") +
          (c.notNull && !c.primary ? " NOT NULL" : "") +
          (c.defaultSql !== undefined ? " DEFAULT " + c.defaultSql : "") +
          (/^(?:var)?char\((\d+)\)/i.test(c.sqlType)
            ? " CHECK (length(" +
              quote(c.name) +
              ") <= " +
              /\((\d+)\)/.exec(c.sqlType)![1] +
              ")"
            : "") +
          (c.enumValues?.length
            ? " CHECK (" +
              quote(c.name) +
              " IN (" +
              c.enumValues.map(literal).join(",") +
              "))"
            : ""),
      )
      .concat(constraints)
      .join(",") +
    ");";
  return { name, columns, primary, foreignKeys, checks, sourceChecks, ddl };
});
export const initializationSql = [
  ...tables.map((t) => t.ddl),
  "CREATE TABLE cashEpoch (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL);",
  "INSERT INTO cashEpoch VALUES(1,0);",
  "CREATE TABLE cashAssert (ok INTEGER NOT NULL CHECK(ok=1));",
  "CREATE TABLE cashCommands (requestId TEXT PRIMARY KEY, requestHash TEXT NOT NULL, requestJson TEXT NOT NULL, resultJson TEXT NOT NULL, planJson TEXT NOT NULL, planHash TEXT NOT NULL);",
  "CREATE TABLE cashOutbox (eventId TEXT PRIMARY KEY, requestId TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, planHash TEXT NOT NULL);",
  ...cashReadIndexes,
].join("\n");
