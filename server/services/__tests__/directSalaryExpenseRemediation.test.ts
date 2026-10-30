import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { POSTING_POLICY_HASH } from "../accounting/postingEngine";
import {
  approveExpense,
  cancelExpense,
  createExpense,
  executeApprovedExpense,
} from "../expenseService";
import { money } from "../money";
import { truncateTables } from "./__testUtils__";

const creator = { userId: 1, branchId: 1, role: "cashier" as const };
const owner = { userId: 2, branchId: 1, role: "admin" as const, isOwner: true };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

beforeEach(async () => {
  await truncateTables([
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "doubleEntrySettings",
    "idempotencyKeys",
    "auditLogs",
    "expenses",
    "receipts",
    "shifts",
    "accounts",
    "expenseCategories",
    "branches",
    "users",
  ]);
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.expenseCategories).values({
    id: 1,
    name: "أجور العمال اليومية",
    bucket: "SALARY",
    isActive: true,
    isBucketDefault: true,
  });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "direct-wage-creator",
        name: "الموظف",
        role: "cashier",
        branchId: 1,
        isActive: true,
      },
      {
        id: 2,
        openId: "direct-wage-owner",
        name: "المالك",
        role: "admin",
        branchId: 1,
        isActive: true,
        isOwner: true,
      },
    ]);
  await db()
    .insert(s.accounts)
    .values([
      { code: "T-CASH", name: "الدرج", type: "ASSET", systemRole: "CASH" },
      {
        code: "T-TREASURY",
        name: "الخزينة",
        type: "ASSET",
        systemRole: "TREASURY_CASH",
      },
      { code: "T-BANK", name: "البنك", type: "ASSET", systemRole: "CARD_BANK" },
      {
        code: "T-WAGES",
        name: "الأجور",
        type: "EXPENSE",
        systemRole: "SALARIES",
      },
      {
        code: "T-ACCRUED",
        name: "رواتب مستحقة",
        type: "LIABILITY",
        systemRole: "ACCRUED_SALARY",
      },
    ]);
  await db().insert(s.shifts).values({
    id: 1,
    userId: creator.userId,
    branchId: 1,
    openingBalance: "1000000.00",
    status: "OPEN",
    shiftType: "RETAIL",
    openGuard: "1:1:RETAIL",
  });
  await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "1000000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "DIRECT-WAGE-TEST-FUND",
    createdBy: owner.userId,
  });
});

async function setMode(mode: "ACTIVE" | "SHADOW" | "OFF") {
  await db()
    .insert(s.doubleEntrySettings)
    .values({
      id: 1,
      mode,
      shadowCycleId: "direct-wage-cycle",
      shadowOpeningHash: "a".repeat(64),
      policyApprovalReference: "DIRECT-WAGE-TEST-POLICY",
      policyApprovalPolicyHash: POSTING_POLICY_HASH,
      policyApprovalCycleId: "direct-wage-cycle",
      policyApprovalOpeningHash: "a".repeat(64),
      policyAccountantName: "محاسب الاختبار",
      policyApprovedAt: new Date(),
      policyApprovedBy: owner.userId,
    });
}

async function journalLines(receiptId?: number) {
  const query = db()
    .select({
      role: s.journalLines.role,
      debit: s.journalLines.debit,
      credit: s.journalLines.credit,
      profile: s.journalEntries.postingProfile,
      status: s.journalEntries.status,
    })
    .from(s.journalLines)
    .innerJoin(
      s.journalEntries,
      eq(s.journalEntries.id, s.journalLines.journalId),
    )
    .innerJoin(
      s.accountingEntries,
      eq(s.accountingEntries.id, s.journalEntries.entryId),
    );
  return receiptId == null
    ? query
    : query.where(eq(s.accountingEntries.receiptId, receiptId));
}

describe("A07 — direct wage expense uses the expense contract", () => {
  it.each([
    {
      rail: "drawer",
      paymentMethod: "CASH" as const,
      amount: "25000.00",
      asset: "CASH",
      bucket: "DRAWER",
    },
    {
      rail: "treasury",
      paymentMethod: "CASH" as const,
      amount: "600000.00",
      asset: "TREASURY_CASH",
      bucket: "TREASURY",
    },
    {
      rail: "transfer",
      paymentMethod: "TRANSFER" as const,
      amount: "25000.00",
      asset: "CARD_BANK",
      bucket: null,
    },
  ])(
    "ACTIVE posts and cancels $rail wages once without a payroll liability",
    async ({ rail, paymentMethod, amount, asset, bucket }) => {
      await setMode("ACTIVE");
      const input = {
        branchId: 1,
        category: "SALARY" as const,
        amount,
        paymentMethod,
        description: "أجرة عامل يومي",
        payee: "عامل يومي بلا دورة رواتب",
        referenceNumber: `DAILY-WAGE-${rail}`,
        clientRequestId: `direct-wage-${rail}`,
      };
      const created = await createExpense(input, creator);
      const expenseId = created.expenseId;
      const receiptId = Number(created.receiptId);
      if (rail !== "drawer") {
        const [pending] = await db()
          .select()
          .from(s.expenses)
          .where(eq(s.expenses.id, expenseId));
        expect(pending.status).toBe("PENDING_APPROVAL");
        expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
        await approveExpense(expenseId, owner);
        await executeApprovedExpense(
          expenseId,
          rail === "treasury" ? "TREASURY" : "NON_CASH",
          owner,
        );
        const replay = await executeApprovedExpense(
          expenseId,
          rail === "treasury" ? "TREASURY" : "NON_CASH",
          owner,
        );
        expect(replay.idempotent).toBe(true);
      }
      expect((await createExpense(input, creator)).expenseId).toBe(expenseId);
      const [expense] = await db()
        .select()
        .from(s.expenses)
        .where(eq(s.expenses.id, expenseId));
      const [receipt] = await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, receiptId));
      expect(expense).toMatchObject({
        category: "SALARY",
        source: "CASH",
        status: "ACTIVE",
        amount,
        paymentMethod,
        payee: input.payee,
        referenceNumber: input.referenceNumber,
        cashBucket: bucket,
      });
      expect(expense.expenseCategoryId).not.toBeNull();
      expect(receipt).toMatchObject({
        direction: "OUT",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        amount,
        paymentMethod,
        cashBucket: bucket,
        referenceNumber: input.referenceNumber,
      });
      expect(await db().select().from(s.expenses)).toHaveLength(1);
      expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
      expect(await journalLines(receiptId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "SALARIES",
            debit: amount,
            credit: "0.00",
            profile: "PAYMENT_OUT_EXPENSE",
            status: "POSTED",
          }),
          expect.objectContaining({
            role: asset,
            debit: "0.00",
            credit: amount,
            profile: "PAYMENT_OUT_EXPENSE",
            status: "POSTED",
          }),
        ]),
      );
      expect(await journalLines(receiptId)).toHaveLength(2);

      await cancelExpense(expenseId, owner);
      const [cancelled] = await db()
        .select()
        .from(s.expenses)
        .where(eq(s.expenses.id, expenseId));
      const [reversed] = await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, receiptId));
      const [compensation] = await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.referenceNumber, `CANCEL-EXP-${expenseId}`));
      expect(cancelled.status).toBe("CANCELLED");
      expect(reversed.status).toBe("REVERSED");
      expect(compensation).toMatchObject({
        direction: "IN",
        amount,
        paymentMethod,
        cashBucket: bucket,
        shiftId: expense.shiftId,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
      });
      expect(await journalLines(Number(compensation.id))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: asset,
            debit: amount,
            credit: "0.00",
            profile: "PAYMENT_IN_OTHER",
            status: "POSTED",
          }),
          expect.objectContaining({
            role: "SALARIES",
            debit: "0.00",
            credit: amount,
            profile: "PAYMENT_IN_OTHER",
            status: "POSTED",
          }),
        ]),
      );
      const lines = await journalLines();
      expect(lines).toHaveLength(4);
      expect(lines.some((line) => line.role === "ACCRUED_SALARY")).toBe(false);
      for (const role of [asset, "SALARIES"]) {
        expect(
          lines
            .filter((line) => line.role === role)
            .reduce(
              (sum, line) => sum.plus(line.debit).minus(line.credit),
              money(0),
            )
            .toFixed(2),
        ).toBe("0.00");
      }
      await expect(cancelExpense(expenseId, owner)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(await db().select().from(s.accountingEntries)).toHaveLength(2);
      expect(await db().select().from(s.receipts)).toHaveLength(3);
      expect(await db().select().from(s.journalEntries)).toHaveLength(2);
    },
  );

  it.each(["OFF", "SHADOW"] as const)(
    "keeps direct drawer wages compatible with %s",
    async (mode) => {
      await setMode(mode);
      const created = await createExpense(
        {
          branchId: 1,
          category: "SALARY",
          amount: "25000.00",
          paymentMethod: "CASH",
          description: "أجرة يومية",
        },
        creator,
      );
      await cancelExpense(created.expenseId, owner);
      expect(await db().select().from(s.accountingEntries)).toHaveLength(2);
      const journals = await db().select().from(s.journalEntries);
      expect(journals).toHaveLength(mode === "OFF" ? 0 : 2);
      expect(journals.every((journal) => journal.status === "POSTED")).toBe(
        true,
      );
      expect(
        (await journalLines()).some((line) => line.role === "ACCRUED_SALARY"),
      ).toBe(false);
    },
  );
});
