import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../../../drizzle/migrations/0181_store_fulfillment_branch.sql", import.meta.url),
);

describe("0181 storefront fulfillment migration contract", () => {
  it("is fail-closed and never equates finding a branch with opening the store", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toMatch(/INSERT INTO `storeSettings`[\s\S]*SELECT 1, 0, @store_branch_id/);
    expect(sql).toMatch(/UPDATE `storeSettings`[\s\S]*`isOpen` = 0,[\s\S]*`fulfillmentBranchId` = COALESCE/);
    expect(sql).not.toMatch(/`isOpen` = IF\(/);
    expect(sql).not.toMatch(/SELECT 1, IF\(@store_branch_id IS NULL, 0, 1\)/);
    expect(sql).not.toMatch(/`isOpen`\s*=\s*1/);
  });
});
