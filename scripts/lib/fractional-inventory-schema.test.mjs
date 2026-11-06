import test from "node:test";
import assert from "node:assert/strict";
import { assertMaterialCostSnapshotColumn, classifyFractionalSchema, fractionalColumnsFromSql, assertForwardSchemaRecovery } from "./fractional-inventory-schema.mjs";

const sql = "ALTER TABLE `branchStock` MODIFY COLUMN `quantity` DECIMAL(15,4) NOT NULL;\nALTER TABLE `inventoryMovements` MODIFY COLUMN `signedDelta` DECIMAL(15,4) NULL;";
const columns = fractionalColumnsFromSql(sql);
const rows = (type = "int") => columns.map(({ table, column }) => ({ tableName: table, columnName: column, dataType: type, precision: type === "decimal" ? 15 : 10, scale: type === "decimal" ? 4 : 0 }));

test("schema verification requires the nullable historical monetary snapshot", () => {
  const valid = { dataType: "decimal", precision: 15, scale: 2, isNullable: "YES" };
  assert.doesNotThrow(() => assertMaterialCostSnapshotColumn(valid));
  for (const invalid of [undefined, { ...valid, dataType: "int" }, { ...valid, scale: 4 }, { ...valid, precision: 14 }, { ...valid, isNullable: "NO" }]) assert.throws(() => assertMaterialCostSnapshotColumn(invalid), /SNAPSHOT_SCHEMA_DRIFT/);
});
test("schema metadata distinguishes legacy, partial and completed decimal cutover without coercion", () => {
  assert.equal(classifyFractionalSchema(columns, rows()).pending, true);
  assert.equal(classifyFractionalSchema(columns, [rows()[0], rows("decimal")[1]]).pending, true);
  assert.equal(classifyFractionalSchema(columns, rows("decimal")).pending, false);
  assert.throws(() => classifyFractionalSchema(columns, rows().slice(1)), /SCHEMA_DRIFT/);
  assert.throws(() => classifyFractionalSchema(columns, rows("float")), /SCHEMA_DRIFT/);
});
test("forward recovery requires a durable cutover marker and the exact database identity", () => {
  const journal = { id: "old-activation", phase: "FATAL", database: "erp", serverUuid: "one", schemaTransition: { id: "fractional-material-quantities-v1", rollbackPolicy: "FORWARD_ONLY", started: true } };
  assert.equal(assertForwardSchemaRecovery(journal, { database: "erp", serverUuid: "one" }), journal);
  for (const invalid of [{ ...journal, phase: "RELEASED" }, { ...journal, schemaTransition: undefined }, { ...journal, schemaTransition: { ...journal.schemaTransition, started: false } }]) assert.throws(() => assertForwardSchemaRecovery(invalid, { database: "erp", serverUuid: "one" }), /FORWARD_RECOVERY/);
  assert.throws(() => assertForwardSchemaRecovery(journal, { database: "other", serverUuid: "one" }), /TARGET/);
  assert.throws(() => assertForwardSchemaRecovery(journal, { database: "erp", serverUuid: "two" }), /TARGET/);
});
