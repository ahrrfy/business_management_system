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

function acceptInput(receiptId: number, clientRequestId: string) {
  return {
    receiptId,
    countedCash: "75000.00",
    countedBreakdown: { "25000": 1, "50000": 1 },
    clientRequestId,
  };
}

async function user(id: number) {
  return (
    await db().select().from(s.users).where(eq(s.users.id, id)).limit(1)
  )[0];
}

async function pendingContract(
  referenceNumber = "CD-1-20260725-0001",
  sourceShiftId: number | null = null,
  stageSource: "NEW" | "LEGACY" | false = "NEW",
  recipientId: number = RECIPIENT,
) {
  if ((referenceNumber.startsWith("CD-") || referenceNumber.startsWith("CH-")) && stageSource) {
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
    createdBy: recipientId,
  });
  return Number((result as any)[0]?.insertId ?? (result as any).insertId);
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "auditLogs",
    "accountingEntries",
    "cashCustodyCounts",
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
      intruder.treasury.acceptHandoverReceipt(acceptInput(receiptId, "intruder")),
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
      source: "CASH_DROP",
    });
    expect(queue[0]).not.toHaveProperty("amount");

    const accepted = await recipient.treasury.acceptHandoverReceipt(
      acceptInput(receiptId, "accept-1"),
    );
    expect(accepted.idempotent).toBe(false);

    const acceptanceEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.receiptId, receiptId));
    expect(acceptanceEntries).toHaveLength(1);
    expect(acceptanceEntries[0]).toMatchObject({
      entryType: "CASH_TRANSFER_IN",
      amount: "75000.00",
      dedupeKey: `CASH_CUSTODY_ACCEPT:${receiptId}`,
    });

    const after = await getDashboard(
      { branchId: 1 },
      { scopedBranchId: null, role: "admin", userId: RECIPIENT },
    );
    expect(
      after.treasuryBalances.find((row) => row.branchId === 1)?.balance,
    ).toBe("75000.00");
    expect(await recipient.treasury.pendingHandoverReceipts()).toEqual([]);

    const replay = await recipient.treasury.acceptHandoverReceipt(
      acceptInput(receiptId, "accept-1"),
    );
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
      recipient.treasury.acceptHandoverReceipt(acceptInput(receiptId, "orphan")),
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
      recipient.treasury.acceptHandoverReceipt(acceptInput(receiptId, "legacy")),
    ).resolves.toMatchObject({ idempotent: false, receiptId });

    expect(
      await db()
        .select({ id: s.accountingEntries.id })
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.receiptId, receiptId)),
    ).toHaveLength(0);
  });

  it("saves a blind-count variance and keeps the full custody amount out of treasury", async () => {
    const receiptId = await pendingContract("CH-1-20260725-VARIANCE");
    const recipient = appRouter.createCaller(makeCtx(await user(RECIPIENT)));

    const result = await recipient.treasury.acceptHandoverReceipt({
      receiptId,
      countedCash: "50000.00",
      countedBreakdown: { "50000": 1 },
      clientRequestId: "variance-1",
    });
    expect(result).toMatchObject({
      accepted: false,
      countStatus: "VARIANCE_OPEN",
      variance: "-25000.00",
    });
    const receipt = (await db().select().from(s.receipts).where(eq(s.receipts.id, receiptId)))[0];
    expect(receipt.status).toBe("PENDING");
    const counts = await db().select().from(s.cashCustodyCounts);
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({ countedAmount: "50000.00", variance: "-25000.00", status: "VARIANCE_OPEN" });
    const dashboard = await getDashboard(
      { branchId: 1 },
      { scopedBranchId: null, role: "admin", userId: RECIPIENT },
    );
    expect(dashboard.treasuryBalances.find((row) => row.branchId === 1)?.balance).toBe("0.00");

    await expect(
      recipient.treasury.acceptHandoverReceipt({
        receiptId,
        countedCash: "75000.00",
        countedBreakdown: { "50000": 1, "25000": 1 },
        clientRequestId: "variance-recipient-retry",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await expect(
      recipient.treasury.reassignHandoverReceipt({ receiptId, toUserId: INTRUDER }),
    ).resolves.toMatchObject({ receiptId, assignedToId: INTRUDER });
    const independentRecipient = appRouter.createCaller(makeCtx(await user(INTRUDER)));
    await expect(
      independentRecipient.treasury.acceptHandoverReceipt({
        receiptId,
        countedCash: "75000.00",
        countedBreakdown: { "50000": 1, "25000": 1 },
        clientRequestId: "variance-independent-recount",
      }),
    ).resolves.toMatchObject({ accepted: true, countStatus: "MATCHED" });

    const finalReceipt = (await db().select().from(s.receipts).where(eq(s.receipts.id, receiptId)))[0];
    expect(finalReceipt).toMatchObject({ status: "COMPLETED", approvedBy: INTRUDER });
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
      recipient.treasury.acceptHandoverReceipt(acceptInput(receiptId, "handover")),
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
    ).toHaveLength(1);
  });

  it("rejects the courier who dropped the cash from accepting their own custody", async () => {
    // المستلِم = المُسلِّم نفسه (CASHIER)، عبر إدخالٍ مباشر يتجاوز حارس الإنشاء
    // (createCashDrop) عمداً — القبول يجب أن يرفضه بمعزل عن ذلك الحارس الأعلى.
    const receiptId = await pendingContract(
      "CD-1-20260725-SELFCOURIER",
      null,
      "NEW",
      CASHIER,
    );
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));

    await expect(
      cashier.treasury.acceptHandoverReceipt(acceptInput(receiptId, "self-courier")),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "لا يجوز لمُسلِّم النقد قبول عهدته",
    });

    const row = (
      await db().select().from(s.receipts).where(eq(s.receipts.id, receiptId))
    )[0];
    expect(row.status).toBe("PENDING");
  });

  it("rejects the shift owner from accepting cash dropped out of their own drawer", async () => {
    const shiftResult = await db().insert(s.shifts).values({
      branchId: 1,
      userId: RECIPIENT,
      openingBalance: "0",
      openGuard: "recipient-shift-owner:1:RETAIL",
    });
    const shiftId = Number(
      (shiftResult as any)[0]?.insertId ?? (shiftResult as any).insertId,
    );
    const receiptId = await pendingContract("CD-1-20260725-SELFSHIFT", shiftId);
    const recipient = appRouter.createCaller(makeCtx(await user(RECIPIENT)));

    await expect(
      recipient.treasury.acceptHandoverReceipt(acceptInput(receiptId, "self-shift-owner")),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "لا يجوز لمالك الوردية قبول النقد الخارج من درجها",
    });

    const row = (
      await db().select().from(s.receipts).where(eq(s.receipts.id, receiptId))
    )[0];
    expect(row.status).toBe("PENDING");
  });
});
