import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { effectiveDeliveryLedgerEntrySql } from "../delivery/legacyLedger";
import { getDeliveryFinancialSummary } from "../delivery/lifecycle";

const db = () => getDb()!;
const migration = readFileSync(
  "drizzle/migrations/extras/0178_delivery_phase2_state_and_ledgers.sql",
  "utf8",
);
const openingBlock = migration
  .slice(migration.indexOf("-- Run after all consignment snapshots."))
  .split("--> statement-breakpoint")[0];
const before = new Date("2026-08-01T10:00:00Z");
const after = new Date("2026-08-01T11:00:00Z");

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الأول", code: "MAIN", type: "MAIN" },
      { id: 2, name: "الثاني", code: "SECOND", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values({
      id: 1,
      openId: "opening-owner",
      role: "admin",
      isOwner: true,
      branchId: 1,
    });
  await db()
    .insert(s.deliveryParties)
    .values({
      id: 1,
      name: "جهة اختبار",
      partyType: "COMPANY",
      branchId: 1,
      currentBalance: "0",
    });
  await db()
    .insert(s.invoices)
    .values({
      id: 1,
      invoiceNumber: "OPENING-1",
      sourceType: "POS",
      sourceId: "opening-1",
      branchId: 1,
      subtotal: "100",
      total: "100",
      paidAmount: "0",
      status: "PENDING",
    });
  await db()
    .insert(s.deliveryConsignments)
    .values({
      id: 1,
      consignmentNumber: "OPENING-CN-1",
      branchId: 1,
      partyId: 1,
      invoiceId: 1,
      sourceId: 1,
      codAmount: "100",
      collectedAmount: "0",
      deliveryFee: "0",
      feeCollection: "COURIER",
      status: "DISPATCHED",
      parcelStatus: "OUT_FOR_DELIVERY",
      moneyStatus: "UNSETTLED",
    });
});

async function balance(amount: string) {
  await db()
    .update(s.deliveryParties)
    .set({ currentBalance: amount })
    .where(eq(s.deliveryParties.id, 1));
}
async function entry(
  key: string,
  type: typeof s.deliveryLedgerEntries.$inferInsert.entryType,
  amount: string,
  options: { opening?: boolean; branchId?: number | null; at?: Date } = {},
) {
  await db()
    .insert(s.deliveryLedgerEntries)
    .values({
      eventKey: key,
      partyId: 1,
      branchId: options.branchId === undefined ? 1 : options.branchId,
      consignmentId: options.opening ? null : 1,
      entryType: type,
      amount,
      createdAt: options.at ?? before,
      occurredAt: options.at ?? before,
    });
}
async function openings() {
  return db()
    .select()
    .from(s.deliveryLedgerEntries)
    .where(
      eq(s.deliveryLedgerEntries.eventKey, "BACKFILL:PARTY:1:CASH_CUSTODY"),
    );
}
async function bootstrap() {
  await db().execute(sql.raw(openingBlock));
}
async function cash() {
  const [row] = await db()
    .select({
      amount: sql<string>`COALESCE(SUM(CASE WHEN entryType IN ('COD_COLLECTED','SHORTFALL_ASSIGNED') THEN amount WHEN entryType IN ('COD_REMITTED','COD_RETURNED','COD_WRITTEN_OFF','SHORTFALL_SETTLED') THEN -amount ELSE 0 END),0)`,
    })
    .from(s.deliveryLedgerEntries)
    .where(effectiveDeliveryLedgerEntrySql());
  return Number(row.amount).toFixed(2);
}
async function exclude(
  amount = "100",
  reason:
    | "NATIVE_CUSTODY_OVERLAP"
    | "LEGACY_CUSTODY_REPRESENTED" = "NATIVE_CUSTODY_OVERLAP",
) {
  const [opening] = await openings();
  await db()
    .insert(s.deliveryOpeningExclusions)
    .values({
      ledgerEntryId: opening.id,
      partyId: 1,
      branchId: 1,
      openingAmount: amount,
      reason,
      evidenceHash: "a".repeat(64),
      evidence: { sourceLedgerIds: [1], reviewed: true },
      createdBy: 1,
    });
}

describe("opening custody imports", () => {
  it("does not create a late opening already represented by native custody", async () => {
    await balance("100");
    await entry("CN:1:COD_COLLECTED", "COD_COLLECTED", "100");
    await bootstrap();
    await bootstrap();
    expect(await openings()).toHaveLength(0);
    expect(await cash()).toBe("100.00");
  });

  it("imports only the legitimate unrepresented residual and stays idempotent", async () => {
    await balance("125");
    await entry("CN:1:COD_COLLECTED", "COD_COLLECTED", "100");
    await bootstrap();
    await bootstrap();
    expect((await openings()).map((x) => x.amount)).toEqual(["25.00"]);
    expect(await cash()).toBe("125.00");
  });

  it("preserves custody with no consignment evidence", async () => {
    await balance("25");
    await bootstrap();
    expect((await openings())[0].amount).toBe("25.00");
    expect(await cash()).toBe("25.00");
  });

  it("uses canonical snapshots instead of double-counting a native counterpart", async () => {
    await balance("125");
    await entry("CN:1:COD_COLLECTED", "COD_COLLECTED", "100");
    await entry("BACKFILL:CN:1:COD_COLLECTED", "COD_COLLECTED", "100", {
      at: after,
    });
    await bootstrap();
    expect((await openings())[0].amount).toBe("25.00");
    expect(await cash()).toBe("125.00");
  });

  it("finishes remittance snapshots before computing the residual", async () => {
    await balance("25");
    await db()
      .update(s.deliveryConsignments)
      .set({
        codAmount: "100",
        collectedAmount: "100",
        status: "DELIVERED",
        parcelStatus: "DELIVERED",
        moneyStatus: "SETTLED",
      });
    const connection = await mysql.createConnection({
      uri: process.env.TEST_DATABASE_URL!,
      multipleStatements: true,
    });
    try {
      for (const statement of migration
        .split("--> statement-breakpoint")
        .map((x) => x.trim())
        .filter(Boolean))
        await connection.query(statement);
    } finally {
      await connection.end();
    }
    expect((await openings())[0].amount).toBe("25.00");
    expect(await cash()).toBe("25.00");
  });

  it.each(["negative", "excess"])(
    "does not invent an opening for %s canonical custody",
    async (kind) => {
      await balance("25");
      await entry("CN:1:COD_COLLECTED", "COD_COLLECTED", "100");
      if (kind === "negative")
        await entry("CN:1:REMIT:test", "COD_REMITTED", "150");
      await bootstrap();
      expect(await openings()).toHaveLength(0);
      expect(
        (await db().select().from(s.deliveryParties))[0].currentBalance,
      ).toBe("25.00");
    },
  );

  it("aggregates branches once and keeps a shared residual unattributed", async () => {
    await db()
      .update(s.deliveryParties)
      .set({ branchId: null, currentBalance: "125" });
    await entry("CN:1:COD_COLLECTED", "COD_COLLECTED", "40");
    await entry("CN:1:COD_COLLECTED_SUPP:other", "COD_COLLECTED", "60", {
      branchId: 2,
    });
    await bootstrap();
    expect(await openings()).toMatchObject([
      { branchId: null, amount: "25.00" },
    ]);
    expect(await cash()).toBe("125.00");
  });
});

describe("evidence-backed historical exclusions", () => {
  it("excludes only the reviewed opening in every canonical alias and summary", async () => {
    await balance("100");
    await entry("CN:1:COD_COLLECTED", "COD_COLLECTED", "100");
    await entry("BACKFILL:PARTY:1:CASH_CUSTODY", "COD_COLLECTED", "100", {
      opening: true,
      at: after,
    });
    expect(await cash()).toBe("200.00");
    const original = await db()
      .select()
      .from(s.deliveryLedgerEntries)
      .orderBy(s.deliveryLedgerEntries.id);
    await exclude();
    expect(await cash()).toBe("100.00");
    const [aliased] = await db().execute(
      sql`SELECT COALESCE(SUM(dle.amount),0) amount FROM deliveryLedgerEntries dle WHERE ${effectiveDeliveryLedgerEntrySql("dle")}`,
    );
    expect(Number((aliased as unknown as { amount: string }[])[0].amount)).toBe(
      100,
    );
    expect((await getDeliveryFinancialSummary(1)).cashInCustody).toBe("100.00");
    expect(
      await db()
        .select()
        .from(s.deliveryLedgerEntries)
        .orderBy(s.deliveryLedgerEntries.id),
    ).toEqual(original);
    expect(
      (await db().select().from(s.deliveryParties))[0].currentBalance,
    ).toBe("100.00");
  });

  it("keeps an unreviewed opening even when later native custody has the same amount", async () => {
    await entry("BACKFILL:PARTY:1:CASH_CUSTODY", "COD_COLLECTED", "100", {
      opening: true,
    });
    await entry("CN:1:COD_COLLECTED", "COD_COLLECTED", "100", { at: after });
    expect(await cash()).toBe("200.00");
  });

  it("closes an evidenced legacy carry without creating a second remittance", async () => {
    await entry("BACKFILL:PARTY:1:CASH_CUSTODY", "COD_COLLECTED", "100", {
      opening: true,
    });
    await entry("BACKFILL:CN:1:COD_COLLECTED", "COD_COLLECTED", "100", {
      at: after,
    });
    await entry("CN:1:REMIT:test", "COD_REMITTED", "100", { at: after });
    const count = (await db().select().from(s.deliveryLedgerEntries)).length;
    await exclude("100", "LEGACY_CUSTODY_REPRESENTED");
    expect(await cash()).toBe("0.00");
    expect(await db().select().from(s.deliveryLedgerEntries)).toHaveLength(
      count,
    );
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });

  it("rejects a mismatched opening amount and preserves the source", async () => {
    await entry("BACKFILL:PARTY:1:CASH_CUSTODY", "COD_COLLECTED", "100", {
      opening: true,
    });
    await expect(exclude("90")).rejects.toMatchObject({
      cause: {
        sqlState: "45000",
        sqlMessage: expect.stringContaining("matching original opening"),
      },
    });
    expect(await cash()).toBe("100.00");
  });

  it("makes exclusions immutable and keeps their key occupied on bootstrap replay", async () => {
    await entry("BACKFILL:PARTY:1:CASH_CUSTODY", "COD_COLLECTED", "100", {
      opening: true,
    });
    await exclude();
    await expect(
      db().update(s.deliveryOpeningExclusions).set({ openingAmount: "90" }),
    ).rejects.toMatchObject({
      cause: {
        sqlState: "45000",
        sqlMessage: expect.stringContaining("immutable"),
      },
    });
    await expect(
      db().delete(s.deliveryOpeningExclusions),
    ).rejects.toMatchObject({
      cause: {
        sqlState: "45000",
        sqlMessage: expect.stringContaining("immutable"),
      },
    });
    await balance("100");
    await bootstrap();
    expect(await openings()).toHaveLength(1);
    expect(await cash()).toBe("0.00");
  });

  it("rolls back an interrupted exclusion transaction", async () => {
    await entry("BACKFILL:PARTY:1:CASH_CUSTODY", "COD_COLLECTED", "100", {
      opening: true,
    });
    const [opening] = await openings();
    await expect(
      db().transaction(async (tx) => {
        await tx
          .insert(s.deliveryOpeningExclusions)
          .values({
            ledgerEntryId: opening.id,
            partyId: 1,
            branchId: 1,
            openingAmount: "100",
            reason: "NATIVE_CUSTODY_OVERLAP",
            evidenceHash: "a".repeat(64),
            evidence: { witness: 1 },
            createdBy: 1,
          });
        throw new Error("Injected failure");
      }),
    ).rejects.toThrow("Injected failure");
    expect(await db().select().from(s.deliveryOpeningExclusions)).toHaveLength(
      0,
    );
    expect(await cash()).toBe("100.00");
  });
});
