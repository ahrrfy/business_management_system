import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createExpense } from "../expenseService";
import { computeExpectedCash } from "../shiftService";
import { approveVoucher, createVoucher } from "../voucherService";

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
    },
    {
      id: 2,
      openId: "cash-core-manager",
      name: "manager",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
  ]);
  await db().insert(s.suppliers).values({
    id: 1,
    name: "مورد",
    currentBalance: "3000000.00",
  });
}

async function fundTreasury(amount: string) {
  await db().insert(s.receipts).values({
    branchId: 1,
    cashBucket: "TREASURY",
    direction: "IN",
    amount,
    paymentMethod: "CASH",
    status: "COMPLETED",
    referenceNumber: `TEST-TREASURY-${amount}`,
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
    const results = await Promise.allSettled([
      createExpense(
        {
          branchId: 1,
          category: "RENT",
          amount: "80.00",
          paymentMethod: "CASH",
          cashSource: "TREASURY",
          description: "الصرف المتزامن الأول",
          clientRequestId: "treasury-race-1",
        },
        admin,
      ),
      createExpense(
        {
          branchId: 1,
          category: "RENT",
          amount: "80.00",
          paymentMethod: "CASH",
          cashSource: "TREASURY",
          description: "الصرف المتزامن الثاني",
          clientRequestId: "treasury-race-2",
        },
        admin,
      ),
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

  it("إيصال TREASURY معلّق ليس نقداً متاحاً ولا يمول الصرف", async () => {
    await db().insert(s.receipts).values({
      branchId: 1,
      cashBucket: "TREASURY",
      direction: "IN",
      amount: "1000.00",
      paymentMethod: "CASH",
      status: "PENDING",
      createdBy: 1,
    });

    await expect(
      createExpense(
        {
          branchId: 1,
          category: "RENT",
          amount: "1.00",
          paymentMethod: "CASH",
          cashSource: "TREASURY",
          description: "لا تمويل من استلام معلّق",
        },
        admin,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.expenses)).toHaveLength(0);
  });
});

describe("cash-nonnegative-core — اعتماد السند", () => {
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
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

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
  it("المسارات السبعة في الشريحة تستدعي الحارس المركزي صراحةً", () => {
    const expectedCalls = new Map<string, number>([
      ["expenseService.ts", 1],
      ["purchase/receive.ts", 2],
      ["sale/cancel.ts", 1],
      ["shiftService.ts", 1],
      ["voucher/approval.ts", 1],
      ["voucher/cancel.ts", 1],
      ["voucher/create.ts", 1],
    ]);
    const root = path.resolve(process.cwd(), "server/services");
    for (const [relative, minimum] of expectedCalls) {
      const source = readFileSync(path.join(root, relative), "utf8");
      const calls = source.match(/await\s+assertCashOutAvailable\s*\(/g) ?? [];
      expect(calls.length, relative).toBeGreaterThanOrEqual(minimum);
    }
  });

  it("جرد ملفات إدراج receipts ذات OUT الحرفي fail-closed ولا يقبل باباً جديداً صامتاً", () => {
    const guardedHere = [
      "expenseService.ts",
      "purchase/receive.ts",
      "sale/cancel.ts",
      "shiftService.ts",
    ];
    // أبواب موجودة خارج ملكية هذه الشريحة. وجودها في allowlist لا يعلن حمايتها؛ بل يجبر أي إضافة
    // جديدة على تعديل هذا العقد وتصنيفها صراحةً في شريحة التكامل اللاحقة.
    const outsideSlice = [
      "assets/create.ts",
      "assets/lifecycle.ts",
      "assets/update.ts",
      "cashDropService.ts",
      "cashHandoverService.ts",
      "cashTransferService.ts",
      "delivery/fees.ts",
      "delivery/remittance.ts",
      "delivery/returns.ts",
      "digitalCards/reversalService.ts",
      "digitalCards/walletOpsService.ts",
      "exchange/deposit.ts",
      "exchange/settleSupplier.ts",
      "installment/bounce.ts",
      "payroll/lifecycle.ts",
      "promotionService.ts",
      "purchase/usdSettlement.ts",
      "reception/deposits.ts",
      "returnService.ts",
      "sale/correct.ts",
      "workOrder/cancel.ts",
      "workOrder/deliveryFeeRefund.ts",
    ];
    const expected = [...guardedHere, ...outsideSlice].sort();
    const root = path.resolve(process.cwd(), "server/services");
    const actual = serviceFiles(root)
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return (
          /\.insert\((?:\w+\.)?receipts\)/.test(source) &&
          /direction\s*:\s*["']OUT["']/.test(source)
        );
      })
      .map((file) => path.relative(root, file).replaceAll("\\", "/"))
      .sort();
    expect(actual).toEqual(expected);
  });

  it("جرد جميع كتّاب receipts يمنع إخفاء OUT باتجاه ديناميكي أو alias جديد", () => {
    const expected = [
      "assets/create.ts",
      "assets/dispose.ts",
      "assets/lifecycle.ts",
      "assets/update.ts",
      "cashDropService.ts",
      "cashHandoverService.ts",
      "cashTransferService.ts",
      "delivery/fees.ts",
      "delivery/remittance.ts",
      "delivery/returns.ts",
      "delivery/settle.ts",
      "digitalCards/reversalService.ts",
      "digitalCards/walletOpsService.ts",
      "exchange/deposit.ts",
      "exchange/reverse.ts",
      "exchange/settleSupplier.ts",
      "exchange/withdraw.ts",
      "expenseService.ts",
      "installment/bounce.ts",
      "payroll/lifecycle.ts",
      "printSaleService.ts",
      "promotionService.ts",
      "purchase/receive.ts",
      "purchase/usdSettlement.ts",
      "purchaseReturnsService.ts",
      "reception/deposits.ts",
      "receptionCheckoutService.ts",
      "returnService.ts",
      "sale/cancel.ts",
      "sale/correct.ts",
      "sale/create.ts",
      "sale/payment.ts",
      "shiftService.ts",
      "treasuryFundingService.ts",
      "voucher/cancel.ts",
      "voucher/create.ts",
      "workOrder/cancel.ts",
      "workOrder/create.ts",
      "workOrder/deliver.ts",
      "workOrder/deliveryFeeRefund.ts",
    ].sort();
    const root = path.resolve(process.cwd(), "server/services");
    const actual = serviceFiles(root)
      .filter((file) =>
        /\.insert\((?:\w+\.)?receipts\)/.test(readFileSync(file, "utf8")),
      )
      .map((file) => path.relative(root, file).replaceAll("\\", "/"))
      .sort();
    expect(actual).toEqual(expected);
  });
});
