import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { todayUtcDate } from "../businessDay";
import {
  lockMaterializedCashReceiptSourceForWrite,
} from "../cash/cashAvailability";
import { withTx } from "../tx";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

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

const RECEIPT_INSERT_INVENTORY: Readonly<Record<string, number>> = {
  "assets/dispose.ts": 1,
  "cashDropService.ts": 2,
  "cashHandoverService.ts": 2,
  "cashTransferService.ts": 3,
  "cashVarianceService.ts": 1,
  "delivery/fees.ts": 2,
  "delivery/remittance.ts": 2,
  "delivery/returns.ts": 2,
  "delivery/settle.ts": 2,
  "digitalCards/reversalService.ts": 1,
  "digitalCards/walletOpsService.ts": 2,
  "exchange/reverse.ts": 1,
  "exchange/settleSupplier.ts": 1,
  "exchange/withdraw.ts": 1,
  "expenseService.ts": 2,
  "installment/bounce.ts": 1,
  "legacyNegativeShiftService.ts": 2,
  "payroll/advanceRepayment.ts": 1,
  "payroll/remittance.ts": 2,
  "payroll/settlement.ts": 2,
  "printSaleService.ts": 1,
  "purchase/purchaseCharges.ts": 2,
  "purchase/returnGovernance.ts": 2,
  "purchase/supplierPayments.ts": 2,
  "purchaseReturnsService.ts": 1,
  "reception/deposits.ts": 3,
  "receptionCheckoutService.ts": 1,
  "returnService.ts": 1,
  // م٢ ق٧: ردُّ إلغاء البيع/المرتجع الكامل وردُّ عكس تسليم أمر الشغل يكتبهما منفّذا محرّك العكس —
  // `sale/cancel.ts` و`workOrder/reverseDelivery.ts` لم يعودا يكتبان إيصالاً (يقفلان المصدر وحسب).
  "reversal/executors/invoiceRefund.ts": 1,
  "reversal/executors/workOrderDelivery.ts": 1,
  "sale/correct.ts": 1,
  "sale/create.ts": 1,
  "sale/payment.ts": 1,
  "shiftFundingService.ts": 2,
  "shiftService.ts": 1,
  "terminationSettlementService.ts": 1,
  "treasuryFundingService.ts": 1,
  "voucher/create.ts": 1,
  "workOrder/cancel.ts": 3,
  "workOrder/create.ts": 2,
  "workOrder/deliver.ts": 1,
  "workOrder/deliveryFeeRefund.ts": 1,
};

const NON_PHYSICAL_ONLY_WRITERS = new Set([
  "exchange/settleSupplier.ts", // EXCHANGE + cashBucket=null
  "installment/bounce.ts", // bounced CHECK compensation, never CASH
]);

const CASH_WRITE_GUARD =
  /lockMaterializedCashReceiptSourceForWrite\s*\(|lockCashSourceForUpdate\s*\(|assertCashOutAvailable\s*\(|assertApprovedTreasuryOutAvailable\s*\(|assertCashTransferAvailable\s*\(|authorizeExternalTreasuryDisbursement\s*\(/;

describe("closed cash-day materialized write gate", () => {
  beforeEach(async () => {
    const database = db();
    await database.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    for (const table of [
      "cashDailyReconciliations",
      "receipts",
      "shifts",
      "users",
      "branches",
    ]) {
      await database.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
    }
    await database.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    await database
      .insert(s.monthCloseSequence)
      .values({ id: 1, status: "NEEDS_BOOTSTRAP", version: 0 })
      .onDuplicateKeyUpdate({ set: { id: 1 } });
    await database.insert(s.branches).values({ id: 1, name: "Main", code: "MAIN", type: "MAIN" });
    await database.insert(s.users).values({
      id: 91,
      openId: "closed-day-writer",
      name: "Closed day writer",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    });
    await database.insert(s.shifts).values({
      id: 991,
      branchId: 1,
      userId: 91,
      openingBalance: "0.00",
      status: "OPEN",
      shiftType: "RECEPTION",
      openGuard: "91:1:RECEPTION",
    });
    await database.insert(s.cashDailyReconciliations).values({
      branchId: 1,
      businessDate: todayUtcDate(),
      expectedTreasuryCash: "0.00",
      countedTreasuryCash: "0.00",
      variance: "0.00",
      status: "CLOSED",
      lastClientRequestId: "closed-day-count",
      closeClientRequestId: "closed-day-close",
      evidenceHash: "closed-day-evidence",
      countedByUserId: 91,
      closedByUserId: 91,
      closedAt: new Date(),
    });
  });

  it("rejects DRAWER/TREASURY materialization after CLOSED without blocking pending/non-cash", async () => {
    for (const source of [
      { cashBucket: "DRAWER" as const, shiftId: 991 },
      { cashBucket: "TREASURY" as const, shiftId: null },
    ]) {
      await expect(
        withTx((tx) =>
          lockMaterializedCashReceiptSourceForWrite(tx, {
            branchId: 1,
            ...source,
            paymentMethod: "CASH",
            status: "COMPLETED",
            approvalStatus: "APPROVED",
          }),
        ),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    }
    await expect(
      withTx(async (tx) => ({
        pending: await lockMaterializedCashReceiptSourceForWrite(tx, {
          branchId: 1,
          shiftId: null,
          cashBucket: "TREASURY",
          paymentMethod: "CASH",
          status: "PENDING",
          approvalStatus: "PENDING_APPROVAL",
        }),
        card: await lockMaterializedCashReceiptSourceForWrite(tx, {
          branchId: 1,
          shiftId: null,
          cashBucket: null,
          paymentMethod: "CARD",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
        }),
      })),
    ).resolves.toEqual({ pending: null, card: null });
  });
});

describe("closed cash-day writer inventory", () => {
  it("keeps every receipt INSERT inventoried and physically guarded or explicitly non-physical", () => {
    const root = path.resolve(process.cwd(), "server/services");
    const serverRoot = path.resolve(process.cwd(), "server");
    const actual = Object.fromEntries(
      serviceFiles(root)
        .map((file) => {
          const source = readFileSync(file, "utf8");
          const count = source.match(/(?:\.|\b)insert\(receipts\)/g)?.length ?? 0;
          return [path.relative(root, file).replaceAll("\\", "/"), count] as const;
        })
        .filter(([, count]) => count > 0)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    expect(actual).toEqual(RECEIPT_INSERT_INVENTORY);

    for (const relative of Object.keys(RECEIPT_INSERT_INVENTORY)) {
      const source = readFileSync(path.join(root, relative), "utf8");
      if (NON_PHYSICAL_ONLY_WRITERS.has(relative)) {
        expect(source, `${relative}: non-physical exemption must remain asserted`).toMatch(
          /assertNonPhysicalOutReceipt\s*\(/,
        );
      } else {
        expect(source, `${relative}: material CASH writer must acquire the central source/day gate`).toMatch(
          CASH_WRITE_GUARD,
        );
        expect(
          source,
          `${relative}: ordinary writers must never bypass CLOSED; only close/reopen orchestration may opt out`,
        ).not.toContain("allowClosedCashDay: true");
      }
    }

    const receiptWritesOutsideServices = serviceFiles(serverRoot)
      .filter((file) => !file.startsWith(`${root}${path.sep}`))
      .filter((file) => /(?:\.|\b)(?:insert|update)\(receipts\)/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(serverRoot, file).replaceAll("\\", "/"))
      .sort();
    expect(receiptWritesOutsideServices).toEqual(["routers/voucherRouter.ts"]);
    const voucherRouter = readFileSync(path.join(serverRoot, "routers/voucherRouter.ts"), "utf8");
    const routerReceiptMutations = [
      ...voucherRouter.matchAll(/update\(receipts\)\s*\.set\(\{([\s\S]*?)\}\)/g),
    ].map((match) => match[1]?.trim());
    expect(routerReceiptMutations).toEqual([
      "voucherCategoryId: input.toId",
      "voucherCategoryId: input.voucherCategoryId",
    ]);
  });

  it("keeps every PENDING→COMPLETED receipt transition classified", () => {
    const root = path.resolve(process.cwd(), "server/services");
    const transitions = serviceFiles(root)
      .map((file) => {
        const source = readFileSync(file, "utf8");
        return /update\(receipts\)[\s\S]{0,500}?status:\s*"COMPLETED"/.test(source)
          ? path.relative(root, file).replaceAll("\\", "/")
          : null;
      })
      .filter((file): file is string => file != null)
      .sort();
    expect(transitions).toEqual([
      "cashHandoverService.ts",
      "cashVarianceService.ts",
      "exchange/reverse.ts",
      "expenseService.ts",
      "shiftFundingService.ts",
      "treasury/pendingReceipts.ts",
      "voucher/approval.ts",
      "workOrder/cancel.ts",
    ]);
    for (const relative of transitions) {
      const source = readFileSync(path.join(root, relative), "utf8");
      if (relative === "workOrder/cancel.ts") {
        // هذا انتقال تنفيذ CARD/TRANSFER/WALLET فقط؛ CASH يُنفّذ فوراً عند إنشاء الرد.
        expect(source).toMatch(/refund\.paymentMethod === "CASH"/);
        continue;
      }
      expect(source, `${relative}: materialization transition must acquire the source/day gate`).toMatch(
        CASH_WRITE_GUARD,
      );
    }
  });

  it("keeps the central lock order source → day and requires the gate before receipt INSERTs", () => {
    const root = path.resolve(process.cwd(), "server/services");
    const source = readFileSync(
      path.resolve(process.cwd(), "server/services/cash/cashAvailability.ts"),
      "utf8",
    );
    const lockStart = source.indexOf("export async function lockCashSourceForUpdate");
    const drawerSource = source.indexOf(".from(shifts)", lockStart);
    const treasurySource = source.indexOf(".from(branches)", drawerSource);
    const drawerDay = source.indexOf("await assertCurrentCashDayWritable", drawerSource);
    const treasuryDay = source.indexOf("await assertCurrentCashDayWritable", treasurySource);
    expect(drawerSource).toBeGreaterThan(lockStart);
    expect(drawerDay).toBeGreaterThan(drawerSource);
    expect(treasurySource).toBeGreaterThan(drawerDay);
    expect(treasuryDay).toBeGreaterThan(treasurySource);

    const closedDayBypassOwners = serviceFiles(path.resolve(process.cwd(), "server"))
      .filter((file) => readFileSync(file, "utf8").includes("allowClosedCashDay"))
      .map((file) => path.relative(root, file).replaceAll("\\", "/"))
      .sort();
    expect(closedDayBypassOwners).toEqual([
      "cash/cashAvailability.ts",
      "cashDailyReconciliationService.ts",
    ]);
  });
});
