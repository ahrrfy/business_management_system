import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createExpense } from "../expenseService";
import { computeExpectedCash } from "../shiftService";
import { approveVoucher, cancelVoucher, createVoucher } from "../voucherService";
import {
  assertCashOutAvailable,
  computeTreasuryCashBalance,
  lockCashSourceForUpdate,
} from "../cash/cashAvailability";
import { getCashFlowSeries, getDashboard, getPaymentMethodBreakdown, getRecentMovements } from "../treasuryService";
import { getCashOrphansReport, getTreasurySummary } from "../reportsTreasuryService";
import { getCashFlow, getFinancialPosition } from "../reportsFinancialService";
import { sendTransfer } from "../cashTransferService";
import { toDateStr } from "../money";
import { withTx } from "../tx";

const admin = { userId: 1, branchId: 1, role: "admin" as const };
const manager = { userId: 2, branchId: 1, role: "manager" as const };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

async function reset() {
  const database = db();
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "idempotencyKeys",
    "cashTransfers",
    "accountingEntries",
    "expenses",
    "receipts",
    "shifts",
    "suppliers",
    "branches",
    "users",
  ]) {
    await database.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  // Production migrations seed this singleton. Restore it after another DB
  // suite truncates monthCloseSequence so branch-concurrency starts with the
  // same shared-gate invariant as a real installation.
  await db()
    .insert(s.monthCloseSequence)
    .values({ id: 1, status: "NEEDS_BOOTSTRAP", version: 0 })
    .onDuplicateKeyUpdate({ set: { id: 1 } });
  await db().insert(s.branches).values({
    id: 1,
    name: "MAIN",
    code: "MAIN",
    type: "MAIN",
  });
  await db().insert(s.users).values([
    {
      id: 1,
      openId: "cash-core-admin",
      name: "admin",
      role: "admin",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
    {
      id: 2,
      openId: "cash-core-manager",
      name: "manager",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
  ]);
  await db().insert(s.suppliers).values({
    id: 1,
    name: "مورد",
    currentBalance: "3000000.00",
  });
}

async function fundTreasury(amount: string, branchId = 1) {
  await db().insert(s.receipts).values({
    branchId,
    cashBucket: "TREASURY",
    direction: "IN",
    amount,
    paymentMethod: "CASH",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: `TEST-TREASURY-${branchId}-${amount}`,
    createdBy: 1,
  });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});
describe("cash-nonnegative-core — قفل المصدر والتراجع", () => {
  it("DRAWER: صرفان متزامنان لا يستهلكان الرصيد نفسه", async () => {
    await db().insert(s.shifts).values({
      id: 1,
      branchId: 1,
      userId: 2,
      openingBalance: "100.00",
      status: "OPEN",
      openGuard: "2:1:RETAIL",
    });

    const results = await Promise.allSettled([
      createExpense(
        {
          branchId: 1,
          category: "SUPPLIES",
          amount: "80.00",
          paymentMethod: "CASH",
          description: "الصرف المتزامن الأول",
          clientRequestId: "drawer-race-1",
        },
        manager,
      ),
      createExpense(
        {
          branchId: 1,
          category: "SUPPLIES",
          amount: "80.00",
          paymentMethod: "CASH",
          description: "الصرف المتزامن الثاني",
          clientRequestId: "drawer-race-2",
        },
        manager,
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const outs = await db()
      .select()
      .from(s.receipts)
      .where(
        and(
          eq(s.receipts.direction, "OUT"),
          eq(s.receipts.cashBucket, "DRAWER"),
        ),
      );
    expect(outs).toHaveLength(1);
    expect(await db().select().from(s.expenses)).toHaveLength(1);
    await db().transaction(async (tx) => {
      expect((await computeExpectedCash(tx, 1, "100.00")).toFixed(2)).toBe(
        "20.00",
      );
    });
  });

  it("TREASURY: صرفان متزامنان يتسلسلان على قفل الفرع ولا يصنعان سالباً", async () => {
    await fundTreasury("100.00");
    const first = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "80.00", paymentMethod: "CASH",
      partyType: "SUPPLIER", partyId: 1, description: "الصرف المتزامن الأول",
      clientRequestId: "treasury-race-1",
    }, manager);
    const second = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "80.00", paymentMethod: "CASH",
      partyType: "SUPPLIER", partyId: 1, description: "الصرف المتزامن الثاني",
      clientRequestId: "treasury-race-2",
    }, manager);
    const results = await Promise.allSettled([
      approveVoucher(first.receiptId, admin),
      approveVoucher(second.receiptId, admin),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const treasury = await db()
      .select({
        balance: sql<string>`COALESCE(SUM(CASE WHEN ${s.receipts.direction} = 'IN' THEN ${s.receipts.amount} ELSE -${s.receipts.amount} END), 0)`,
      })
      .from(s.receipts)
      .where(
        and(
          eq(s.receipts.cashBucket, "TREASURY"),
          eq(s.receipts.paymentMethod, "CASH"),
        ),
      );
    expect(treasury[0]?.balance).toBe("20.00");
    expect(
      await db()
        .select()
        .from(s.receipts)
        .where(
          and(
            eq(s.receipts.direction, "OUT"),
            eq(s.receipts.cashBucket, "TREASURY"),
          ),
        ),
    ).toHaveLength(1);
  });

  it("المرشح CASH حاكم: إدخال CARD ملوث بدلو DRAWER لا يمول صرفاً نقدياً", async () => {
    await db().insert(s.shifts).values({
      id: 1,
      branchId: 1,
      userId: 2,
      openingBalance: "0.00",
      status: "OPEN",
      openGuard: "2:1:RETAIL",
    });
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId: 1,
      cashBucket: "DRAWER",
      direction: "IN",
      amount: "1000.00",
      paymentMethod: "CARD",
      status: "COMPLETED",
      createdBy: 2,
    });

    await expect(
      createExpense(
        {
          branchId: 1,
          category: "SUPPLIES",
          amount: "1.00",
          paymentMethod: "CASH",
          description: "لا تمويل من البطاقة",
        },
        manager,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.expenses)).toHaveLength(0);
  });

  it("approvalStatus حاكم: المعلّق/المرفوض/المعكوس غير المعتمد لا يمول، والمعكوس المعتمد حدث مادي", async () => {
    await db().insert(s.receipts).values([
      {
        branchId: 1, cashBucket: "TREASURY", direction: "IN", amount: "1000.00",
        paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "PENDING_APPROVAL", createdBy: 1,
      },
      {
        branchId: 1, cashBucket: "TREASURY", direction: "IN", amount: "1000.00",
        paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "REJECTED", createdBy: 1,
      },
      {
        branchId: 1, cashBucket: "TREASURY", direction: "IN", amount: "1000.00",
        paymentMethod: "CASH", status: "REVERSED", approvalStatus: "PENDING_APPROVAL", createdBy: 1,
      },
    ]);
    await db().transaction(async (tx) => {
      expect((await computeTreasuryCashBalance(tx, 1)).toFixed(2)).toBe("0.00");
    });

    const pending = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "1.00", paymentMethod: "CASH",
      partyType: "SUPPLIER", partyId: 1, description: "لا تمويل من استلام معلّق",
      clientRequestId: "pending-in-does-not-fund",
    }, manager);
    await expect(approveVoucher(pending.receiptId, admin)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const [stored] = await db().select().from(s.receipts).where(eq(s.receipts.id, pending.receiptId));
    expect(stored.approvalStatus).toBe("PENDING_APPROVAL");

    await db().insert(s.receipts).values({
      branchId: 1, cashBucket: "TREASURY", direction: "IN", amount: "1.00",
      paymentMethod: "CASH", status: "REVERSED", approvalStatus: "APPROVED", createdBy: 1,
    });
    await approveVoucher(pending.receiptId, admin);
    await db().transaction(async (tx) => {
      expect((await computeTreasuryCashBalance(tx, 1)).toFixed(2)).toBe("0.00");
    });
  });
});

describe("cash-nonnegative-core — ترتيب الأقفال وعزل الفروع", () => {
  it("source→document يمنع deadlock بين عكس قبض وصرف مباشر متزامن", async () => {
    const original = await createVoucher({
      voucherType: "RECEIPT", branchId: 1, amount: "100.00", paymentMethod: "CASH",
      partyType: "SUPPLIER", partyId: 1, description: "قبض لاختبار ترتيب الأقفال",
      clientRequestId: "lock-order-original",
    }, admin);

    let sourceLocked!: () => void;
    let releaseSource!: () => void;
    const sourceIsLocked = new Promise<void>((resolve) => { sourceLocked = resolve; });
    const mayContinue = new Promise<void>((resolve) => { releaseSource = resolve; });
    const directOut = withTx(async (tx) => {
      await lockCashSourceForUpdate(tx, { branchId: 1, cashBucket: "TREASURY" });
      sourceLocked();
      await mayContinue;
      await assertCashOutAvailable(tx, {
        branchId: 1, cashBucket: "TREASURY", amount: "100.00", operation: "صرف اختبار ترتيب الأقفال",
      });
      await tx.insert(s.receipts).values({
        branchId: 1, cashBucket: "TREASURY", direction: "OUT", amount: "100.00",
        paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "APPROVED",
        referenceNumber: "LOCK-ORDER-DIRECT-OUT", createdBy: 1,
      });
    });
    await sourceIsLocked;
    const cancellation = cancelVoucher(original.receiptId, admin);
    await new Promise((resolve) => setTimeout(resolve, 75));
    releaseSource();

    const [spent, cancelled] = await Promise.allSettled([directOut, cancellation]);
    expect(spent.status).toBe("fulfilled");
    expect(cancelled.status).toBe("fulfilled");
    if (cancelled.status === "fulfilled") {
      expect(cancelled.value).toMatchObject({ status: "PENDING_APPROVAL" });
      await expect(approveVoucher(Number(cancelled.value.approvalReceiptId), manager))
        .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    }
    await db().transaction(async (tx) => {
      expect((await computeTreasuryCashBalance(tx, 1)).toFixed(2)).toBe("0.00");
    });
  });

  it("إلغاء سند صرف نقدي يقفل الخزينة قبل الإيصال ولا يتعاكس مع OUT متزامن", async () => {
    await fundTreasury("200.00");
    const pending = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "100.00", paymentMethod: "CASH",
      partyType: "SUPPLIER", partyId: 1, description: "صرف لاختبار إلغاء OUT المتزامن",
      clientRequestId: "cancel-out-lock-order",
    }, manager);
    await approveVoucher(pending.receiptId, admin);

    let sourceLocked!: () => void;
    let releaseSource!: () => void;
    const sourceIsLocked = new Promise<void>((resolve) => { sourceLocked = resolve; });
    const mayContinue = new Promise<void>((resolve) => { releaseSource = resolve; });
    const directOut = withTx(async (tx) => {
      await lockCashSourceForUpdate(tx, { branchId: 1, cashBucket: "TREASURY" });
      sourceLocked();
      await mayContinue;
      await assertCashOutAvailable(tx, {
        branchId: 1, cashBucket: "TREASURY", amount: "100.00",
        operation: "صرف موازٍ لإلغاء سند الصرف",
      });
      await tx.insert(s.receipts).values({
        branchId: 1, cashBucket: "TREASURY", direction: "OUT", amount: "100.00",
        paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "APPROVED",
        referenceNumber: "LOCK-ORDER-CANCEL-OUT", createdBy: 1,
      });
    });
    await sourceIsLocked;
    const cancellation = cancelVoucher(pending.receiptId, admin);
    await new Promise((resolve) => setTimeout(resolve, 75));
    releaseSource();

    const results = await Promise.allSettled([directOut, cancellation]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(results[1]).toMatchObject({
      status: "fulfilled",
      value: { status: "PENDING_APPROVAL" },
    });
    for (const result of results) {
      if (result.status === "rejected") {
        expect(String(result.reason?.message ?? "")).not.toMatch(/DEADLOCK|Deadlock|ER_LOCK_DEADLOCK/);
      }
    }
    await db().transaction(async (tx) => {
      expect((await computeTreasuryCashBalance(tx, 1)).toFixed(2)).toBe("0.00");
    });
  });

  it("قفل وحساب الخزينة انتقائيان بالفرع: صرفان متزامنان في فرعين لا يتداخلان", async () => {
    await db().insert(s.branches).values({ id: 2, name: "SECOND", code: "SECOND", type: "SALES" });
    await fundTreasury("100.00", 1);
    await fundTreasury("100.00", 2);

    let readyCount = 0;
    let releaseBoth!: () => void;
    const bothLocked = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const spend = (branchId: number) => withTx(async (tx) => {
      await lockCashSourceForUpdate(tx, { branchId, cashBucket: "TREASURY" });
      readyCount += 1;
      if (readyCount === 2) releaseBoth();
      await bothLocked;
      await assertCashOutAvailable(tx, {
        branchId, cashBucket: "TREASURY", amount: "100.00", operation: `صرف فرع ${branchId}`,
      });
      await tx.insert(s.receipts).values({
        branchId, cashBucket: "TREASURY", direction: "OUT", amount: "100.00",
        paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "APPROVED",
        referenceNumber: `MULTI-BRANCH-OUT-${branchId}`, createdBy: 1,
      });
    });

    await Promise.all([spend(1), spend(2)]);
    await db().transaction(async (tx) => {
      expect((await computeTreasuryCashBalance(tx, 1)).toFixed(2)).toBe("0.00");
      expect((await computeTreasuryCashBalance(tx, 2)).toFixed(2)).toBe("0.00");
    });
  });

  it("تحويلان متعاكسان بين فرعين يقفلان الحسابين بترتيب واحد بلا deadlock", async () => {
    await db().insert(s.branches).values({ id: 2, name: "SECOND", code: "SECOND", type: "SALES" });
    await fundTreasury("100.00", 1);
    await fundTreasury("100.00", 2);

    const results = await Promise.allSettled([
      sendTransfer({
        fromBranchId: 1, toBranchId: 2, amount: "25.00",
        clientRequestId: "opposite-transfer-1-to-2",
      }, admin),
      sendTransfer({
        fromBranchId: 2, toBranchId: 1, amount: "25.00",
        clientRequestId: "opposite-transfer-2-to-1",
      }, admin),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(String(result.reason?.message ?? "")).not.toMatch(/DEADLOCK|Deadlock|ER_LOCK_DEADLOCK/);
      }
    }
    expect(await db().select().from(s.cashTransfers)).toHaveLength(2);
    await db().transaction(async (tx) => {
      expect((await computeTreasuryCashBalance(tx, 1)).toFixed(2)).toBe("75.00");
      expect((await computeTreasuryCashBalance(tx, 2)).toFixed(2)).toBe("75.00");
    });
  });
});

describe("cash-nonnegative-core — اعتماد السند", () => {
  it("اعتماد المالك لا يقفل users حصرياً مقابل OUT يكتب createdBy للمالك", async () => {
    await fundTreasury("200.00");
    const pending = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "100.00", paymentMethod: "CASH",
      partyType: "SUPPLIER", partyId: 1, description: "اعتماد مقابل FK المستخدم",
      clientRequestId: "approval-user-share-lock-order",
    }, manager);

    let sourceLocked!: () => void;
    const sourceIsLocked = new Promise<void>((resolve) => { sourceLocked = resolve; });
    const directOut = withTx(async (tx) => {
      await lockCashSourceForUpdate(tx, { branchId: 1, cashBucket: "TREASURY" });
      sourceLocked();
      // يتيح للاعتماد بلوغ قفل المصدر. بالترتيب القديم كان يملك users/X هنا،
      // ثم يتعطل INSERT أدناه على FK/S بينما الاعتماد ينتظر branch/X.
      await new Promise((resolve) => setTimeout(resolve, 75));
      await assertCashOutAvailable(tx, {
        branchId: 1, cashBucket: "TREASURY", amount: "50.00",
        operation: "صرف متزامن ينسبه إلى المالك",
      });
      await tx.insert(s.receipts).values({
        branchId: 1, cashBucket: "TREASURY", direction: "OUT", amount: "50.00",
        paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "APPROVED",
        referenceNumber: "APPROVAL-USER-FK-OUT", createdBy: admin.userId,
      });
    });
    await sourceIsLocked;
    const approval = approveVoucher(pending.receiptId, admin);
    const results = await Promise.allSettled([directOut, approval]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(String(result.reason?.message ?? "")).not.toMatch(/DEADLOCK|Deadlock|ER_LOCK_DEADLOCK/);
      }
    }
    await db().transaction(async (tx) => {
      expect((await computeTreasuryCashBalance(tx, 1)).toFixed(2)).toBe("50.00");
    });
  });

  it("سباق اعتمادين يرحّل سند الصرف مرة واحدة فقط", async () => {
    await fundTreasury("2000000.00");
    const pending = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "2000000.00",
        paymentMethod: "CASH",
        partyType: "SUPPLIER",
        partyId: 1,
        description: "دفعة متزامنة",
        clientRequestId: "voucher-approval-race",
      },
      manager,
    );
    expect(pending.approvalStatus).toBe("PENDING_APPROVAL");

    const results = await Promise.allSettled([
      approveVoucher(pending.receiptId, admin),
      approveVoucher(pending.receiptId, admin),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(0);
    const approvals = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    expect(approvals.filter((result) => result.replayed)).toHaveLength(1);
    expect(approvals.filter((result) => !result.replayed)).toHaveLength(1);

    const receipt = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, pending.receiptId))
    )[0];
    expect(receipt.approvalStatus).toBe("APPROVED");
    expect(receipt.cashBucket).toBe("TREASURY");
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.entryType, "PAYMENT_OUT")),
    ).toHaveLength(1);
    const supplier = (
      await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1))
    )[0];
    expect(supplier.currentBalance).toBe("1000000.00");
  });
});

describe("cash-nonnegative-core — دلالة REVERSED موحّدة", () => {
  it("إلغاء قبض TREASURY يصافر الحارس واللوحة والحركة والتقرير", async () => {
    const created = await createVoucher({
      voucherType: "RECEIPT", branchId: 1, amount: "100.00", paymentMethod: "CASH",
      partyType: "SUPPLIER", partyId: 1, description: "قبض سيُعكس",
      clientRequestId: "treasury-reversed-zero",
    }, admin);
    const cancellation = await cancelVoucher(created.receiptId, admin);
    await approveVoucher(Number(cancellation.approvalReceiptId), manager);

    await db().transaction(async (tx) => {
      expect((await computeTreasuryCashBalance(tx, 1)).toFixed(2)).toBe("0.00");
    });

    const scope = { scopedBranchId: 1, role: "admin", userId: 1 };
    const dashboard = await getDashboard({ branchId: 1 }, scope);
    expect(dashboard.treasuryBalances.find((row) => row.branchId === 1)?.balance).toBe("0.00");

    const flow = await getCashFlowSeries({ days: 1, branchId: 1 }, scope);
    expect(flow.at(-1)).toMatchObject({ inflow: "100.00", outflow: "100.00", net: "0.00" });
    const methods = await getPaymentMethodBreakdown({ period: "today", branchId: 1 }, scope);
    expect(methods.find((row) => row.key === "CASH")).toMatchObject({ inTotal: "100.00", outTotal: "100.00" });
    const movements = await getRecentMovements({ branchId: 1, limit: 10 }, scope);
    expect(movements.filter((row) => row.source === "RECEIPT")).toHaveLength(2);

    const orphans = await getCashOrphansReport({ branchId: 1, category: "TREASURY" });
    expect(orphans.netTreasury).toBe("0.00");
    const today = toDateStr();
    const summary = await getTreasurySummary({ branchId: 1, from: today, to: today });
    expect(summary.net).toBe("0.00");
    const financialFlow = await getCashFlow({ branchId: 1, from: today, to: today });
    expect(financialFlow).toMatchObject({ totalIn: "100.00", totalOut: "100.00", net: "0.00" });
  });

  it("العكس في يوم لاحق يحفظ تدفق يوم الأصل ويصافر الرصيد الحالي", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const yesterdayDay = yesterday.toISOString().slice(0, 10);
    const created = await createVoucher({
      voucherType: "RECEIPT", branchId: 1, amount: "100.00", paymentMethod: "CASH",
      partyType: "SUPPLIER", partyId: 1, description: "قبض أمس",
      clientRequestId: "treasury-period-reversal",
    }, admin);
    await db().update(s.receipts).set({ createdAt: yesterday, voucherDate: yesterdayDay }).where(eq(s.receipts.id, created.receiptId));
    await db().update(s.accountingEntries).set({ entryDate: yesterday }).where(eq(s.accountingEntries.receiptId, created.receiptId));
    const cancellation = await cancelVoucher(created.receiptId, admin);
    await approveVoucher(Number(cancellation.approvalReceiptId), manager);

    const flow = await getCashFlowSeries({ days: 2, branchId: 1 }, { scopedBranchId: 1, role: "admin", userId: 1 });
    expect(flow.find((row) => row.day === yesterdayDay)).toMatchObject({ inflow: "100.00", outflow: "0.00", net: "100.00" });
    expect(flow.at(-1)).toMatchObject({ inflow: "0.00", outflow: "100.00", net: "-100.00" });

    expect((await getFinancialPosition({ branchId: 1, asOf: yesterdayDay })).cash).toBe("100.00");
    expect((await getFinancialPosition({ branchId: 1 })).cash).toBe("0.00");
    const summary = await getTreasurySummary({ branchId: 1, from: yesterdayDay, to: toDateStr() });
    expect(summary.net).toBe("0.00");
    expect(await getCashFlow({ branchId: 1, from: yesterdayDay, to: yesterdayDay })).toMatchObject({
      totalIn: "100.00", totalOut: "0.00", net: "100.00",
    });
    expect(await getCashFlow({ branchId: 1, from: toDateStr(), to: toDateStr() })).toMatchObject({
      totalIn: "0.00", totalOut: "100.00", net: "-100.00",
    });
    expect(await getCashFlow({ branchId: 1, from: yesterdayDay, to: toDateStr() })).toMatchObject({
      totalIn: "100.00", totalOut: "100.00", net: "0.00",
    });
  });
});

function serviceFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...serviceFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(absolute);
  }
  return result;
}

describe("cash-nonnegative-core — عقد أبواب CASH OUT", () => {
  // استثناءات مغلقة ومفسّرة: هذه الملفات تكتب receipts لكن اتجاهاتها IN فقط؛ أي إضافة ملف
  // أو تحوّل أحدها إلى OUT يفشل الجرد حتى يُربط بالحارس/تصنيف غير نقدي صريح.
  const receiptInOnlyWriters = [
    "assets/dispose.ts", // متحصل بيع أصل
    "delivery/settle.ts", // قبض تسوية من المندوب
    "exchange/withdraw.ts", // نقد عائد من محفظة الصيرفة
    "printSaleService.ts", // قبض بيع
    "purchaseReturnsService.ts", // رد مورد داخل
    "receptionCheckoutService.ts", // قبض تسليم
    "sale/create.ts", // قبض بيع
    "sale/payment.ts", // دفعة عميل داخلة
    "treasuryFundingService.ts", // تمويل خزينة داخل
    "workOrder/create.ts", // قبض عربون
    "workOrder/deliver.ts", // قبض تسليم
  ].sort();
  // استثناء بنيوي ذاتي الإبطال: الكاتب القديم يحمل OUT خلف ثابت false. لا نعدّه باباً
  // مادياً، لكن العقد يفشل فور إزالة الثابت كي يُربط بالحارس قبل أن يصبح قابلاً للوصول.
  const unreachableOutWriters = ["delivery/remittance.ts"];

  it("كل كاتب receipts مصنّف fail-closed: OUT محروس أو IN-only مفسّر", () => {
    const root = path.resolve(process.cwd(), "server/services");
    const actual = serviceFiles(root)
      .filter((file) =>
        /\.insert\((?:\w+\.)?receipts\)/.test(readFileSync(file, "utf8")),
      )
      .map((file) => path.relative(root, file).replaceAll("\\", "/"))
      .sort();
    for (const relative of receiptInOnlyWriters) {
      expect(actual, `${relative} must remain an actual receipt writer`).toContain(relative);
      const source = readFileSync(path.join(root, relative), "utf8");
      expect(source, `${relative} is documented IN-only`).not.toMatch(/direction\s*:\s*["']OUT["']/);
    }
    for (const relative of unreachableOutWriters) {
      expect(actual, `${relative} must remain an actual receipt writer`).toContain(relative);
      const source = readFileSync(path.join(root, relative), "utf8");
      expect(source).toContain("const feeStillOwed = false");
      expect(source).toMatch(/if \(feesTotal\.gt\(0\)\)/);
    }

    // لا توجد allowlist لمسارات OUT: كل كاتب جديد خارج الاستثناءات المغلقة يُفحص تلقائياً
    // ويجب أن يستدعي الحارس/التصنيف المركزي داخل خدمته وإلا يفشل العقد.
    for (const relative of actual.filter((file) =>
      !receiptInOnlyWriters.includes(file) && !unreachableOutWriters.includes(file))) {
      const source = readFileSync(path.join(root, relative), "utf8");
      expect(
        /createSystemPaymentRequestTx\s*\(|assertApprovedTreasuryOutAvailable\s*\(|assertCashOutAvailable\s*\(|assertCashTransferAvailable\s*\(|assertNonPhysicalOutReceipt\s*\(/.test(source),
        `${relative} must guard/classify OUT in the same service`,
      ).toBe(true);
    }
  });

  it("منفذ اعتماد السند هو باب التنفيذ الوحيد ويستخدم الحارس المركزي", () => {
    const source = readFileSync(path.resolve(process.cwd(), "server/services/voucher/approval.ts"), "utf8");
    expect(source).toMatch(/await\s+authorizeExternalTreasuryDisbursement\s*\(/);
    expect(source).toMatch(/await\s+assertApprovedTreasuryOutAvailable\s*\(/);
    expect(source).toMatch(/cashBucket\s*=\s*"TREASURY"/);
    expect(source).toMatch(/shiftId\s*=\s*null/);
  });

  it("كل صرف TREASURY خارجي مباشر يثبت مالكاً مختلفاً أو يعلن استثناءً مغلقاً", () => {
    const root = path.resolve(process.cwd(), "server/services");
    const externalLifecycleFiles = [
      "assets/create.ts",
      "assets/lifecycle.ts",
      "purchase/receive.ts",
      "exchange/deposit.ts",
      "digitalCards/walletOpsService.ts",
      "voucher/approval.ts",
    ];
    for (const relative of externalLifecycleFiles) {
      const source = readFileSync(path.join(root, relative), "utf8");
      expect(
        /createSystemPaymentRequestTx\s*\(|authorizeExternalTreasuryDisbursement\s*\(/.test(source),
        `${relative} must defer external Treasury OUT or prove owner approval`,
      ).toBe(true);
    }

    const exceptionFiles = new Map([
      ["cashTransferService.ts", "CASH_TRANSFER_INTERNAL"],
      ["cashDropService.ts", "CASH_DROP_INTERNAL"],
      ["cashHandoverService.ts", "CASH_HANDOVER_INTERNAL"],
      ["shiftService.ts", "SHIFT_FLOAT_INTERNAL"],
      ["shiftFundingService.ts", "SHIFT_FLOAT_INTERNAL"],
      ["legacyNegativeShiftService.ts", "LEGACY_SHIFT_REMEDIATION_INTERNAL"],
      ["sale/cancel.ts", "SALE_CANCELLATION_COMPENSATION"],
      ["digitalCards/reversalService.ts", "DIGITAL_CARD_REVERSAL_COMPENSATION"],
      ["exchange/reverse.ts", "EXCHANGE_REVERSAL_COMPENSATION"],
    ]);
    for (const [relative, key] of exceptionFiles) {
      const source = readFileSync(path.join(root, relative), "utf8");
      expect(source).toContain(`assertTreasuryOutException("${key}")`);
    }
  });

  it("تصحيح البيع المدفوع مؤجل fail-closed ولا يترك باب CASH OUT خامداً", () => {
    const source = readFileSync(path.resolve(process.cwd(), "server/services/sale/correct.ts"), "utf8");
    expect(source).toContain("خرق ثابت التصحيح: نشأ فرق زائد رغم حظر نقل المقبوضات");
    expect(source).not.toMatch(/insert\(receipts\)/);
    expect(source).not.toContain("assertCashOutAvailable");
  });

  it("المسارات المركبة تقفل مصدر النقد قبل المستند والطرف", () => {
    const root = path.resolve(process.cwd(), "server/services");
    const ordered = [
      { file: "shiftService.ts", source: "await assertCashOutAvailable", target: "await tx.insert(shifts)" },
      { file: "purchase/receive.ts", source: "await lockCashSourceForUpdate", target: "await adjustSupplierBalance" },
      { file: "returnService.ts", source: "await lockCashSourceForUpdate", target: "await adjustSupplierBalance" },
      { file: "sale/cancel.ts", source: "await lockCashSourceForUpdate", target: "await adjustSupplierBalance" },
      { file: "exchange/withdraw.ts", source: "await lockCashSourceForUpdate", target: "await lockHouse" },
      { file: "delivery/remittance.ts", source: "await lockCashSourceForUpdate", target: "const party =" },
      { file: "delivery/fees.ts", source: "await lockCashSourceForUpdate", target: "const party =" },
      { file: "delivery/returns.ts", source: "await lockCashSourceForUpdate", target: "const party =" },
      { file: "returnService.ts", source: "await lockCashSourceForUpdate", target: "await tx.select({ id: deliveryParties.id })" },
      { file: "delivery/settle.ts", source: "await lockCashSourceForUpdate", target: "const party =" },
      { file: "purchaseReturnsService.ts", source: "await lockCashSourceForUpdate", target: ".from(purchaseOrders)" },
      { file: "exchange/settleSupplier.ts", source: "await lockBranchMonthCloseGate", target: "const supplier =" },
      { file: "exchange/reverse.ts", source: "await lockBranchMonthCloseGate", target: "const [supplier] =" },
    ];
    for (const item of ordered) {
      const source = readFileSync(path.join(root, item.file), "utf8");
      const sourceLock = source.indexOf(item.source);
      const downstreamLock = source.indexOf(item.target);
      expect(sourceLock, `${item.file}: source prelock is mandatory`).toBeGreaterThanOrEqual(0);
      expect(downstreamLock, `${item.file}: downstream party/document lock must remain present`).toBeGreaterThan(sourceLock);
    }
  });
});
