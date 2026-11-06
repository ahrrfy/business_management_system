import fs from "node:fs";
import path from "node:path";

export const FRACTIONAL_SCHEMA_TRANSITION = "fractional-material-quantities-v1";
export const FRACTIONAL_MIGRATION = "0427_fractional_recipe_inventory.sql";

export function assertMaterialCostSnapshotColumn(row) {
  if (!row || row.dataType !== "decimal" || Number(row.precision) !== 15 || Number(row.scale) !== 2 || row.isNullable !== "YES") throw new Error("FRACTIONAL_MATERIAL_COST_SNAPSHOT_SCHEMA_DRIFT");
}

export function fractionalColumnsFromSql(sql) {
  const columns = [...sql.matchAll(/ALTER TABLE `([A-Za-z0-9_]+)` MODIFY COLUMN `([A-Za-z0-9_]+)` DECIMAL\(15,4\)/g)]
    .map((match) => ({ table: match[1], column: match[2] }));
  if (!columns.length || new Set(columns.map(({ table, column }) => `${table}.${column}`)).size !== columns.length) throw new Error("FRACTIONAL_SCHEMA_MANIFEST_INVALID");
  return columns;
}

export function classifyFractionalSchema(columns, rows) {
  const actual = new Map(rows.map((row) => [`${row.tableName}.${row.columnName}`, row]));
  let pending = false;
  for (const { table, column } of columns) {
    const row = actual.get(`${table}.${column}`);
    if (!row || !["int", "decimal"].includes(row.dataType) || (row.dataType === "decimal" && (Number(row.precision) !== 15 || Number(row.scale) !== 4))) throw new Error(`FRACTIONAL_SCHEMA_DRIFT:${table}.${column}`);
    if (row.dataType === "int") pending = true;
  }
  return { pending, columns };
}

export async function readFractionalInventorySchema(connection, projectRoot, database) {
  const columns = fractionalColumnsFromSql(fs.readFileSync(path.join(projectRoot, "drizzle/migrations", FRACTIONAL_MIGRATION), "utf8"));
  const predicate = columns.map(() => "(TABLE_NAME=? AND COLUMN_NAME=?)").join(" OR ");
  const [rows] = await connection.query(`SELECT TABLE_NAME AS tableName,COLUMN_NAME AS columnName,DATA_TYPE AS dataType,NUMERIC_PRECISION AS \`precision\`,NUMERIC_SCALE AS scale FROM information_schema.columns WHERE TABLE_SCHEMA=? AND (${predicate})`, [database, ...columns.flatMap(({ table, column }) => [table, column])]);
  return classifyFractionalSchema(columns, rows);
}

export function assertForwardSchemaRecovery(journal, identity) {
  if (!journal || ["RELEASED", "ROLLED_BACK"].includes(journal.phase) || journal.schemaTransition?.id !== FRACTIONAL_SCHEMA_TRANSITION || journal.schemaTransition.rollbackPolicy !== "FORWARD_ONLY" || journal.schemaTransition.started !== true) throw new Error("FRACTIONAL_FORWARD_RECOVERY_NOT_AUTHORIZED");
  if (identity && (journal.database !== identity.database || journal.serverUuid !== identity.serverUuid)) throw new Error("FRACTIONAL_FORWARD_RECOVERY_TARGET_MISMATCH");
  return journal;
}
