import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { exchangeHouses, exchangeTransactions } from "../../../drizzle/schema";

const migration = readFileSync(
  new URL(
    "../../../drizzle/migrations/0189_exchange_control_classification.sql",
    import.meta.url,
  ),
  "utf8",
);
const deployVerifier = readFileSync(
  new URL("../../../scripts/db-verify-schema.mjs", import.meta.url),
  "utf8",
);

describe("0186 legacy direct-USD migration contract", () => {
  it("declares the carrying sign CHECK and custody scope index in Drizzle", () => {
    expect(getTableConfig(exchangeHouses).checks.map((item) => item.name)).toContain(
      "chk_exchange_usd_carrying_sign",
    );
    const custodyIndex = getTableConfig(exchangeTransactions).indexes.find(
      (item) => item.config.name === "idx_exchange_custody_scope",
    );
    expect(custodyIndex?.config.columns.map((column) =>
      "name" in column ? column.name : null,
    )).toEqual([
      "exchangeHouseId",
      "branchId",
      "exchangeTxnStatus",
      "exchangeTxnCurrency",
      "exchangeTxnType",
      "id",
    ]);
  });

  it("backfills only from each transaction's explicit saved amount and rate", () => {
    expect(migration).toMatch(
      /UPDATE `exchangeTransactions`[\s\S]*SET `iqdAmount` = ROUND\(`usdAmount` \* `exchangeRate`, 2\)/,
    );
    expect(migration).toMatch(/`exchangeTxnStatus` = 'ACTIVE'/);
    expect(migration).toMatch(/`exchangeTxnCurrency` = 'USD'/);
    expect(migration).toMatch(
      /`exchangeTxnType` IN \('FX_BUY','WITHDRAW','DEPOSIT'\)/,
    );
    expect(migration).toMatch(/`iqdAmount` = 0/);
    expect(migration).toMatch(/`branchId` IS NOT NULL/);
    expect(migration).toMatch(/`usdAmount` > 0/);
    expect(migration).toMatch(/`exchangeRate` > 0/);
    const backfillStatement = migration.match(
      /UPDATE `exchangeTransactions`[\s\S]*?;/,
    )?.[0];
    expect(backfillStatement).toBeTruthy();
    expect(backfillStatement).not.toContain("balanceUsdCarryingIqd");
    expect(backfillStatement).not.toContain("usdCostRate");
  });

  it("keeps deploy fail-closed with row evidence and per-house/branch residuals", () => {
    expect(deployVerifier).toContain("USD_CUSTODY_SOURCE_INVALID");
    expect(deployVerifier).toContain("USD_CUSTODY_GROUP_INVALID");
    expect(deployVerifier).toContain("carryingResidualIqd");
    expect(deployVerifier).toContain("chk_exchange_usd_carrying_sign");
    expect(deployVerifier).toMatch(
      /exchangeHouseId[\s\S]*branchId[\s\S]*GROUP BY[\s\S]*exchangeHouseId[\s\S]*branchId/,
    );
    expect(deployVerifier).toContain(
      "Legacy direct-USD custody verification failed",
    );
  });
});
