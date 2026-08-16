import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  cancelTransfer,
  receiveTransfer,
  sendTransfer,
} from "../cashTransferService";
import { money, toDateStr } from "../money";
import { truncateTables } from "./__testUtils__";

const SENDER = { userId: 1, branchId: 1, role: "manager" as const };
const RECEIVER = { userId: 2, branchId: 2, role: "manager" as const };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function seedBase() {
  await truncateTables([
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "idempotencyKeys",
    "cashTransfers",
    "financialPeriods",
    "doubleEntrySettings",
    "receipts",
    "users",
    "branches",
  ]);
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "Sender", code: "MAIN", type: "MAIN" },
      { id: 2, name: "Receiver", code: "SALES", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "interbranch-sender",
        name: "Sender manager",
        role: "manager",
        branchId: 1,
      },
      {
        id: 2,
        openId: "interbranch-receiver",
        name: "Receiver manager",
        role: "manager",
        branchId: 2,
      },
    ]);
  await db().insert(s.doubleEntrySettings).values({
    id: 1,
    mode: "SHADOW",
    shadowCycleId: "interbranch-clearing-test",
  });
  await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "1000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "TEST-TREASURY-FUND",
    createdBy: 1,
  });
}

beforeEach(seedBase);

async function postedJournalLines() {
  return db()
    .select({
      entryId: s.journalEntries.entryId,
      branchId: s.journalEntries.branchId,
      postingProfile: s.journalEntries.postingProfile,
      role: s.journalLines.role,
      debit: s.journalLines.debit,
      credit: s.journalLines.credit,
    })
    .from(s.journalLines)
    .innerJoin(
      s.journalEntries,
      eq(s.journalEntries.id, s.journalLines.journalId),
    );
}

describe("cash transfer interbranch clearing", () => {
  it("posts branch-balanced send and atomic receipt legs with company clearing net zero", async () => {
    const sent = await sendTransfer(
      {
        fromBranchId: 1,
        toBranchId: 2,
        amount: "100.00",
        clientRequestId: "interbranch-send-1",
      },
      SENDER,
    );
    const received = await receiveTransfer(sent.transferId, RECEIVER);

    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.branchId, 1));
    const allEntries = await db().select().from(s.accountingEntries);
    expect(allEntries).toHaveLength(3);
    expect(allEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branchId: 1,
          receiptId: sent.sentReceiptId,
          dedupeKey: `CT_OUT:${sent.transferNumber}`,
          postingProfile: "CASH_TRANSFER_OUT_IN_TRANSIT",
        }),
        expect.objectContaining({
          branchId: 1,
          receiptId: sent.sentReceiptId,
          dedupeKey: `CT_CLEAR_OUT:${sent.transferNumber}`,
          postingProfile: "INTERBRANCH_CLEARING_OUT",
        }),
        expect.objectContaining({
          branchId: 2,
          receiptId: received.receivedReceiptId,
          dedupeKey: `CT_IN:${sent.transferNumber}`,
          postingProfile: "CASH_TRANSFER_IN_FROM_CLEARING",
        }),
      ]),
    );
    expect(entries).toHaveLength(2);

    const lines = await postedJournalLines();
    const net = (branchId: number, role: string) =>
      lines
        .filter((line) => line.branchId === branchId && line.role === role)
        .reduce(
          (sum, line) => sum.plus(line.debit).minus(line.credit),
          money(0),
        );
    expect(net(1, "TREASURY_CASH").toFixed(2)).toBe("-100.00");
    expect(net(1, "CASH_IN_TRANSIT").toFixed(2)).toBe("0.00");
    expect(net(1, "INTERBRANCH_CLEARING").toFixed(2)).toBe("100.00");
    expect(net(2, "TREASURY_CASH").toFixed(2)).toBe("100.00");
    expect(net(2, "INTERBRANCH_CLEARING").toFixed(2)).toBe("-100.00");
    const companyClearing = net(1, "INTERBRANCH_CLEARING").plus(
      net(2, "INTERBRANCH_CLEARING"),
    );
    expect(companyClearing.isZero()).toBe(true);

    for (const branchId of [1, 2]) {
      const totals = lines
        .filter((line) => line.branchId === branchId)
        .reduce(
          (sum, line) => ({
            debit: sum.debit.plus(line.debit),
            credit: sum.credit.plus(line.credit),
          }),
          { debit: money(0), credit: money(0) },
        );
      expect(totals.debit.eq(totals.credit)).toBe(true);
    }

    await expect(
      receiveTransfer(sent.transferId, RECEIVER),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db().select().from(s.accountingEntries)).toHaveLength(3);
  });

  it("cancels only in transit and restores sender treasury against CIT without clearing", async () => {
    const sent = await sendTransfer(
      {
        fromBranchId: 1,
        toBranchId: 2,
        amount: "75.00",
        clientRequestId: "interbranch-cancel-1",
      },
      SENDER,
    );
    await cancelTransfer(sent.transferId, "cancel test", SENDER);

    const lines = await postedJournalLines();
    const net = (role: string) =>
      lines
        .filter((line) => line.branchId === 1 && line.role === role)
        .reduce(
          (sum, line) => sum.plus(line.debit).minus(line.credit),
          money(0),
        );
    expect(net("TREASURY_CASH").isZero()).toBe(true);
    expect(net("CASH_IN_TRANSIT").isZero()).toBe(true);
    expect(lines.some((line) => line.role === "INTERBRANCH_CLEARING")).toBe(
      false,
    );
    expect((await db().select().from(s.cashTransfers))[0]).toMatchObject({
      status: "CANCELLED",
    });
    await expect(
      receiveTransfer(sent.transferId, RECEIVER),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rolls back the receipt, status and both legs if acceptance posting is blocked", async () => {
    const sent = await sendTransfer(
      {
        fromBranchId: 1,
        toBranchId: 2,
        amount: "50.00",
        clientRequestId: "interbranch-rollback-1",
      },
      SENDER,
    );
    await db().insert(s.financialPeriods).values({
      cutoffDate: toDateStr(),
      status: "LOCKED",
      lockedBy: 1,
    });

    await expect(
      receiveTransfer(sent.transferId, RECEIVER),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db().select().from(s.cashTransfers))[0]).toMatchObject({
      status: "IN_TRANSIT",
      receivedReceiptId: null,
      receivedBy: null,
      receivedAt: null,
    });
    expect(
      (await db().select().from(s.receipts)).filter(
        (receipt) => receipt.referenceNumber === sent.transferNumber,
      ),
    ).toHaveLength(1);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
  });
});
