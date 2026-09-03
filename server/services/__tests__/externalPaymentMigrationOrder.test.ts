import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "drizzle/migrations/0307_external_payment_collection_channels.sql",
  "utf8",
);

describe("external payment collection migration", () => {
  it("creates the invoice FK support index before dropping uniqueness", () => {
    const addReplacementIndex = migration.indexOf(
      "ADD INDEX `idx_extpay_invoice` (`invoiceId`)",
    );
    const dropUniqueIndex = migration.indexOf("DROP INDEX `uq_extpay_invoice`");

    expect(addReplacementIndex).toBeGreaterThan(-1);
    expect(dropUniqueIndex).toBeGreaterThan(-1);
    expect(addReplacementIndex).toBeLessThan(dropUniqueIndex);
  });
});
