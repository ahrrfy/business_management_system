import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { getDashboard } from "../treasury/dashboard";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function makeCtx(user: any) {
  return {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    user,
  } as any;
}

const RECIPIENT = 21;
const INTRUDER = 22;
const CASHIER = 23;

async function user(id: number) {
  return (
    await db().select().from(s.users).where(eq(s.users.id, id)).limit(1)
  )[0];
}

async function pendingContract(
  referenceNumber = "CD-1-20260725-0001",
  sourceShiftId: number | null = null,
  stageSource: "NEW" | "LEGACY" | false = "NEW",
) {
  if (referenceNumber.startsWith("CD-") && stageSource) {
    const sourceResult = await db().insert(s.receipts).values({
      branchId: 1,
      shiftId: sourceShiftId,
      direction: "OUT",
      amount: "75000",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      referenceNumber,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      partyType: "OTHER",
      createdBy: CASHIER,
    });
    const sourceReceiptId = Number(
      (sourceResult as any)[0]?.insertId ?? (sourceResult as any).insertId,
    );
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType:
          stageSource === "LEGACY" ? "CASH_HANDOVER" : "CASH_TRANSFER_OUT",
        branchId: 1,
        receiptId: sourceReceiptId,
        amount: "75000",
        entryDate: sql`CURDATE()` as unknown as string,
        dedupeKey: `TEST:CASH_DROP:${referenceNumber}`,
      });
  }
  const result = await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "75000",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    referenceNumber,
    status: "PENDING",
    approvalStatus: "APPROVED",
    partyType: "OTHER",
    description: "cash custody pending recipient acceptance",
    createdBy: RECIPIENT,
  });
  return Number((result as any)[0]?.insertId ?? (result as any).insertId);
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "auditLogs",
    "accountingEntries",
    "receipts",
    "shifts",
    "users",
    "branches",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values({
    id: 1,
    name: "Main",
    code: "MAIN",
    type: "MAIN",
  });
  await d.insert(s.users).values([
    {
      id: RECIPIENT,
      openId: "accept-recipient",
      name: "Recipient manager",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: INTRUDER,
      openId: "accept-intruder",
      name: "Other manager",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: CASHIER,
      openId: "accept-cashier",
      name: "Cashier source",
      role: "cashier",
      loginMethod: "local",
      branchId: 1,
    },
  ]);
});

describe("treasury handover receipt acceptance", () => {
  it("rejects anyone except the named recipient", async () => {
    const receiptId = await pendingContract();
    const intruder = appRouter.createCaller(makeCtx(await user(INTRUDER)));

    expect(await intruder.treasury.pendingHandoverReceipts()).toEqual([]);
    await expect(
      intruder.treasury.acceptHandoverReceipt({ receiptId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const row = (
      await db().select().from(s.receipts).where(eq(s.receipts.id, receiptId))
    )[0];
    expect(row.status).toBe("PENDING");
  });

  it("excludes pending cash, then recipient acceptance includes it exactly once and writes audit", async () => {
    const receiptId = await pendingContract();
    const recipient = appRouter.createCaller(makeCtx(await user(RECIPIENT)));

    const before = await getDashboard(
      { branchId: 1 },
      { scopedBranchId: null, role: "admin", userId: RECIPIENT },
    );
    expect(
      before.treasuryBalances.find((row) => row.branchId === 1)?.balance,
    ).toBe("0.00");

    const queue = await recipient.treasury.pendingHandoverReceipts();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: receiptId,
      referenceNumber: "CD-1-20260725-0001",
      amount: "75000.00",
      source: "CASH_DROP",
    });

    const accepted = await recipient.treasury.acceptHandoverReceipt({
      receiptId,
    });
    expect(accepted.idempotent).toBe(false);

    const acceptanceEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.receiptId, receiptId));
    expect(acceptanceEntries).toHaveLength(1);
    expect(acceptanceEntries[0]).toMatchObject({
      entryType: "CASH_TRANSFER_IN",
      amount: "75000.00",
      dedupeKey: `CASH_DROP_ACCEPT:${receiptId}`,
    });

    const after = await getDashboard(
      { branchId: 1 },
      { scopedBranchId: null, role: "admin", userId: RECIPIENT },
    );
    expect(
      after.treasuryBalances.find((row) => row.branchId === 1)?.balance,
    ).toBe("75000.00");
    expect(await recipient.treasury.pendingHandoverReceipts()).toEqual([]);

    const replay = await recipient.treasury.acceptHandoverReceipt({
      receiptId,
    });
    expect(replay.idempotent).toBe(true);
    expect(
      await db()
        .select({ id: s.accountingEntries.id })
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.receiptId, receiptId)),
    ).toHaveLength(1);

    const audits = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "treasury.handover.accept"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: RECIPIENT,
      branchId: 1,
      entityType: "receipt",
      entityId: String(receiptId),
    });
  });

  it("rejects an orphan cash-drop contract without materialising treasury cash", async () => {
    const receiptId = await pendingContract(
      "CD-1-20260725-ORPHAN",
      null,
      false,
    );
    const recipient = appRouter.createCaller(makeCtx(await user(RECIPIENT)));

    await expect(
      recipient.treasury.acceptHandoverReceipt({ receiptId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const row = (
      await db().select().from(s.receipts).where(eq(s.receipts.id, receiptId))
    )[0];
    expect(row.status).toBe("PENDING");
    expect(
      await db()
        .select({ id: s.accountingEntries.id })
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.receiptId, receiptId)),
    ).toHaveLength(0);
  });

  it("accepts a legacy already-recognised CD without posting treasury twice", async () => {
    const receiptId = await pendingContract(
      "CD-1-20260725-LEGACY",
      null,
      "LEGACY",
    );
    const recipient = appRouter.createCaller(makeCtx(await user(RECIPIENT)));

    await expect(
      recipient.treasury.acceptHandoverReceipt({ receiptId }),
    ).resolves.toMatchObject({ idempotent: false, receiptId });

    expect(
      await db()
        .select({ id: s.accountingEntries.id })
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.receiptId, receiptId)),
    ).toHaveLength(0);
  });

  it("shows the cashier and the source shift for a pending cash drop", async () => {
    const referenceNumber = "CD-1-20260725-0001";
    const shiftResult = await db().insert(s.shifts).values({
      branchId: 1,
      userId: CASHIER,
      openingBalance: "0",
      openGuard: "cashier-source:1:RETAIL",
    });
    const shiftId = Number(
      (shiftResult as any)[0]?.insertId ?? (shiftResult as any).insertId,
    );
    const receiptId = await pendingContract(referenceNumber, shiftId);

    const recipient = appRouter.createCaller(makeCtx(await user(RECIPIENT)));
    await expect(recipient.treasury.pendingHandoverReceipts()).resolves.toEqual(
      [
        expect.objectContaining({
          id: receiptId,
          sourceEmployeeName: "Cashier source",
          sourceShiftId: shiftId,
        }),
      ],
    );
  });

  it("accepts a close-shift handover contract through the same recipient workflow", async () => {
    const receiptId = await pendingContract("CH-1-20260725-0001");
    const recipient = appRouter.createCaller(makeCtx(await user(RECIPIENT)));

    const queue = await recipient.treasury.pendingHandoverReceipts();
    expect(queue[0]).toMatchObject({ id: receiptId, source: "CASH_HANDOVER" });

    await expect(
      recipient.treasury.acceptHandoverReceipt({ receiptId }),
    ).resolves.toMatchObject({ idempotent: false, receiptId });

    const row = (
      await db().select().from(s.receipts).where(eq(s.receipts.id, receiptId))
    )[0];
    expect(row).toMatchObject({
      status: "COMPLETED",
      approvedBy: RECIPIENT,
    });
    expect(row.approvedAt).toBeTruthy();
    expect(
      await db()
        .select({ id: s.accountingEntries.id })
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.receiptId, receiptId)),
    ).toHaveLength(0);
  });
});
