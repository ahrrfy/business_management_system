import { and, eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import * as s from "../../../drizzle/schema";
import mysql from "mysql2/promise";
import { closeDb, getDb } from "../../db";
import {
  openShift,
  closeShift,
  shiftIdForCashTx,
} from "../shiftService";
import { createSale } from "../saleService";
import { processPayment } from "../sale/payment";
import { createVoucher } from "../voucherService";
import { returnSaleDirect } from "../returnService";
import {
  recordDeliveryRemittanceInTx,
  lockDeliveryRemittanceCashSourceInTx,
} from "../delivery/remittance";
import { withTx, type Actor } from "../tx";

import { truncateTables } from "./__testUtils__";

function db() {
  const conn = getDb();
  if (!conn) throw new Error("DATABASE_URL not set for tests");
  return conn;
}

const TABLES_TO_RESET = [
  "accountingEntries",
  "receipts",
  "deliveryRemittances",
  "deliveryParties",
  "invoiceItems",
  "invoices",
  "voucherCategories",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "customers",
  "shifts",
  "users",
  "branches",
  "idempotencyKeys",
];

// 5 Roles to test (with valid DB roles)
const ROLES: Array<{ role: string; dbRole: "admin" | "manager" | "accountant" | "cashier" | "print_operator"; userId: number; name: string }> = [
  { role: "admin", dbRole: "admin", userId: 1, name: "مسؤول نظام (أدمن)" },
  { role: "manager", dbRole: "manager", userId: 20, name: "مدير فرع" },
  { role: "accountant", dbRole: "accountant", userId: 30, name: "محاسب مالي" },
  { role: "cashier", dbRole: "cashier", userId: 10, name: "كاشير نقطة بيع" },
  { role: "reception", dbRole: "print_operator", userId: 40, name: "موظف استقبال" },
];

let reqSeq = 0;
function nextReq(prefix = "adv-cash"): string {
  reqSeq += 1;
  return `${prefix}-${Date.now()}-${reqSeq}`;
}

async function seedTestEnvironment() {
  const d = db();

  // Branches
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);

  // Users for all 5 roles + another user for hijacking tests
  await d.insert(s.users).values([
    { id: 1, openId: "admin-adv", name: "مدير النظام", role: "admin", loginMethod: "local", branchId: 1, isOwner: false },
    { id: 20, openId: "manager-adv", name: "مدير الفرع", role: "manager", loginMethod: "local", branchId: 1, isOwner: false },
    { id: 30, openId: "accountant-adv", name: "محاسب", role: "accountant", loginMethod: "local", branchId: 1, isOwner: false },
    { id: 10, openId: "cashier-adv", name: "كاشير 1", role: "cashier", loginMethod: "local", branchId: 1, isOwner: false },
    { id: 40, openId: "reception-adv", name: "استقبال", role: "print_operator", loginMethod: "local", branchId: 1, isOwner: false },
    { id: 99, openId: "cashier-victim", name: "كاشير آخر ضحية", role: "cashier", loginMethod: "local", branchId: 1, isOwner: false },
  ]);

  // Voucher categories
  await d.insert(s.voucherCategories).values([
    { id: 10, name: "مصروفات عامة", direction: "OUT", postingRole: "OPERATING_EXPENSE" },
    { id: 11, name: "إيرادات عامة", direction: "IN", postingRole: "OTHER_REVENUE" },
  ]);

  // Customer
  await d.insert(s.customers).values([
    { id: 1, name: "عميل نقدي مباشر", defaultPriceTier: "RETAIL", currentBalance: "0.00" },
    { id: 2, name: "عميل آجل", defaultPriceTier: "RETAIL", currentBalance: "100000.00" },
  ]);

  // Product, variant, unit, price, stock
  await d.insert(s.products).values([{ id: 1, name: "دفتر اختبارات" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "TEST-ITEM-01", costPrice: "2000.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "5000.00" }]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 1, branchId: 2, quantity: 100 },
  ]);

  // Initial treasury cash float for branch 1
  await d.insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "10000000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "INIT-TREASURY-CASH",
    createdBy: 1,
  });

  // Create an unpaid invoice for payment & return tests
  // We insert a credit sale invoice directly into invoices + invoiceItems
  await d.insert(s.invoices).values({
    id: 100,
    invoiceNumber: "INV-TEST-100",
    branchId: 1,
    customerId: 2,
    sourceType: "POS",
    total: "5000.00",
    subtotal: "5000.00",
    paidAmount: "0.00",
    status: "CONFIRMED",
    paymentMode: "CREDIT",
    createdBy: 1,
  });
  await d.insert(s.invoiceItems).values({
    id: 100,
    invoiceId: 100,
    variantId: 1,
    productUnitId: 1,
    quantity: "1",
    baseQuantity: 1,
    unitPrice: "5000.00",
    subtotal: "5000.00",
    total: "5000.00",
  });

  // Create a PAID invoice for return tests
  await d.insert(s.invoices).values({
    id: 200,
    invoiceNumber: "INV-PAID-200",
    branchId: 1,
    customerId: 1,
    sourceType: "POS",
    total: "5000.00",
    subtotal: "5000.00",
    paidAmount: "5000.00",
    status: "PAID",
    paymentMode: "PREPAID",
    paymentMethod: "CASH",
    createdBy: 1,
  });
  await d.insert(s.invoiceItems).values({
    id: 200,
    invoiceId: 200,
    variantId: 1,
    productUnitId: 1,
    quantity: "1",
    baseQuantity: 1,
    unitPrice: "5000.00",
    subtotal: "5000.00",
    total: "5000.00",
  });
  // Receipt for the paid invoice
  await d.insert(s.receipts).values({
    id: 200,
    invoiceId: 200,
    branchId: 1,
    direction: "IN",
    amount: "5000.00",
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    createdBy: 1,
  });
}

beforeEach(async () => {
  await truncateTables(TABLES_TO_RESET);
  await seedTestEnvironment();
});

describe("Adversarial Cash Shift Enforcement (R2: Strict No-Shift Cash Prohibition - Fail-Closed)", () => {
  // =========================================================================
  // SECTION 1: ALL 5 ROLES ATTEMPTING CASH TRANSACTIONS WITH NO SHIFT OPEN
  // =========================================================================
  describe("1. All 5 Roles: Absolute Prohibition when user has NO open shift in branch", () => {
    for (const user of ROLES) {
      const actor: Actor & { role: string } = { userId: user.userId, branchId: 1, role: user.role };

      it(`1.1 [${user.role}] Cash Sale without open shift MUST throw PRECONDITION_FAILED and write 0 rows`, async () => {
        const rcBefore = (await db().select().from(s.receipts)).length;
        const entBefore = (await db().select().from(s.accountingEntries)).length;

        let err: unknown = null;
        try {
          await createSale(
            {
              branchId: 1,
              customerId: 1,
              sourceType: "POS",
              lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
              payment: { method: "CASH", amount: "5000.00" },
              clientRequestId: nextReq(`sale-${user.role}`),
            },
            actor,
          );
        } catch (e) {
          err = e;
        }

        expect(err).toBeInstanceOf(TRPCError);
        expect((err as TRPCError).code).toBe("PRECONDITION_FAILED");

        // Fail-Closed verification: 0 rows added
        const rcAfter = (await db().select().from(s.receipts)).length;
        const entAfter = (await db().select().from(s.accountingEntries)).length;
        expect(rcAfter).toBe(rcBefore);
        expect(entAfter).toBe(entBefore);
      });

      it(`1.2 [${user.role}] Cash Invoice Payment without open shift MUST throw PRECONDITION_FAILED and write 0 rows`, async () => {
        const rcBefore = (await db().select().from(s.receipts)).length;
        const entBefore = (await db().select().from(s.accountingEntries)).length;

        let err: unknown = null;
        try {
          await processPayment(
            {
              invoiceId: 100,
              amount: "5000.00",
              method: "CASH",
              clientRequestId: nextReq(`pay-${user.role}`),
            },
            actor,
          );
        } catch (e) {
          err = e;
        }

        expect(err).toBeInstanceOf(TRPCError);
        expect((err as TRPCError).code).toBe("PRECONDITION_FAILED");

        const rcAfter = (await db().select().from(s.receipts)).length;
        const entAfter = (await db().select().from(s.accountingEntries)).length;
        expect(rcAfter).toBe(rcBefore);
        expect(entAfter).toBe(entBefore);
      });

      if (user.role === "admin" || user.role === "manager") {
        it(`1.3 [${user.role}] Cash Voucher RECEIPT without open shift routes to TREASURY (administrative authority)`, async () => {
          const vRes = await createVoucher(
            {
              voucherType: "RECEIPT",
              branchId: 1,
              amount: "25000.00",
              paymentMethod: "CASH",
              partyType: "CUSTOMER",
              partyId: 1,
              description: `سند قبض تجريبي - ${user.role}`,
              clientRequestId: nextReq(`v-rcpt-${user.role}`),
            },
            actor,
          );
          expect(vRes.approvalStatus).toBe("APPROVED");
          const [rc] = await db().select().from(s.receipts).where(eq(s.receipts.id, vRes.receiptId));
          expect(rc.shiftId).toBeNull();
          expect(rc.cashBucket).toBe("TREASURY");
        });
      } else {
        it(`1.3 [${user.role}] Cash Voucher RECEIPT without open shift MUST throw PRECONDITION_FAILED and write 0 rows`, async () => {
          const rcBefore = (await db().select().from(s.receipts)).length;
          const entBefore = (await db().select().from(s.accountingEntries)).length;

          let err: unknown = null;
          try {
            await createVoucher(
              {
                voucherType: "RECEIPT",
                branchId: 1,
                amount: "25000.00",
                paymentMethod: "CASH",
                partyType: "CUSTOMER",
                partyId: 1,
                description: `سند قبض تجريبي - ${user.role}`,
                clientRequestId: nextReq(`v-rcpt-${user.role}`),
              },
              actor,
            );
          } catch (e) {
            err = e;
          }

          expect(err).toBeInstanceOf(TRPCError);
          expect((err as TRPCError).code).toBe("PRECONDITION_FAILED");

          const rcAfter = (await db().select().from(s.receipts)).length;
          const entAfter = (await db().select().from(s.accountingEntries)).length;
          expect(rcAfter).toBe(rcBefore);
          expect(entAfter).toBe(entBefore);
        });
      }

      it(`1.4 [${user.role}] Cash Voucher PAYMENT without open shift is queued PENDING_APPROVAL with shiftId=null (no cash disbursed)`, async () => {
        const vRes = await createVoucher(
          {
            voucherType: "PAYMENT",
            branchId: 1,
            amount: "15000.00",
            paymentMethod: "CASH",
            partyType: "OTHER",
            voucherCategoryId: 10,
            counterpartyName: "مصروف تجريبي",
            description: `سند صرف تجريبي - ${user.role}`,
            clientRequestId: nextReq(`v-pay-${user.role}`),
          },
          actor,
        );

        expect(vRes.approvalStatus).toBe("PENDING_APPROVAL");
        const [rc] = await db().select().from(s.receipts).where(eq(s.receipts.id, vRes.receiptId));
        expect(rc.shiftId).toBeNull();
        expect(rc.cashBucket).toBeNull();
      });

      if (user.role === "admin" || user.role === "manager") {
        it(`1.5 [${user.role}] Cash Return when branch has 0 open shifts routes refund to TREASURY`, async () => {
          const retRes = await returnSaleDirect(
            {
              invoiceId: 200,
              lines: [{ invoiceItemId: 200, baseQuantity: 1 }],
              refund: { amount: "5000.00", method: "CASH" },
              operatorReason: "إرجاع تجريبي لاختبار مسار الخزينة للإداري",
              clientRequestId: nextReq(`ret-zero-${user.role}`),
            },
            actor,
          );
          expect(retRes.fullyReturned).toBe(true);
        });
      } else {
        it(`1.5 [${user.role}] Cash Return when branch has 0 open shifts MUST throw PRECONDITION_FAILED or FORBIDDEN and write 0 rows`, async () => {
          const rcBefore = (await db().select().from(s.receipts)).length;
          const entBefore = (await db().select().from(s.accountingEntries)).length;

          let err: unknown = null;
          try {
            await returnSaleDirect(
              {
                invoiceId: 200,
                lines: [{ invoiceItemId: 200, baseQuantity: 1 }],
                refund: { amount: "5000.00", method: "CASH" },
                operatorReason: "إرجاع تجريبي لاختبار حظر النقد بلا وردية",
                clientRequestId: nextReq(`ret-zero-${user.role}`),
              },
              actor,
            );
          } catch (e) {
            err = e;
          }

          expect(err).toBeInstanceOf(TRPCError);
          expect(["PRECONDITION_FAILED", "FORBIDDEN"]).toContain((err as TRPCError).code);

          const rcAfter = (await db().select().from(s.receipts)).length;
          const entAfter = (await db().select().from(s.accountingEntries)).length;
          expect(rcAfter).toBe(rcBefore);
          expect(entAfter).toBe(entBefore);
        });
      }

      if (user.role === "admin" || user.role === "manager") {
        it(`1.6 [${user.role}] Cash Remittance cash source lock without open shift locks to TREASURY`, async () => {
          const lockRes = await withTx(async (tx) => {
            return lockDeliveryRemittanceCashSourceInTx(
              tx,
              {
                partyId: 1,
                branchId: 1,
                collectedTotal: "10000.00",
                feesTotal: "0.00",
                lines: [],
                clientRequestId: nextReq(`remit-${user.role}`),
              },
              actor,
            );
          });
          expect(lockRes.shiftId).toBeNull();
          expect(lockRes.cashBucket).toBe("TREASURY");
        });
      } else {
        it(`1.6 [${user.role}] Cash Remittance cash source lock without open shift MUST throw PRECONDITION_FAILED`, async () => {
          let err: unknown = null;
          try {
            await withTx(async (tx) => {
              return lockDeliveryRemittanceCashSourceInTx(
                tx,
                {
                  partyId: 1,
                  branchId: 1,
                  collectedTotal: "10000.00",
                  feesTotal: "0.00",
                  lines: [],
                  clientRequestId: nextReq(`remit-${user.role}`),
                },
                actor,
              );
            });
          } catch (e) {
            err = e;
          }

          expect(err).toBeInstanceOf(TRPCError);
          expect((err as TRPCError).code).toBe("PRECONDITION_FAILED");
        });
      }
    }
  });

  // =========================================================================
  // SECTION 2: ADVERSARIAL ATTACKS & BYPASS ATTEMPTS BY ADMIN & MANAGER
  // =========================================================================
  describe("2. Adversarial Attacks & Bypass Scenarios by Admin / Manager", () => {
    it("2.1 Zombie Shift Attack: Admin attempts cash sale with a CLOSED shift ID", async () => {
      // Create a closed shift belonging to Admin
      await db().insert(s.shifts).values({
        id: 777,
        userId: 1,
        branchId: 1,
        status: "CLOSED",
        openedAt: new Date(Date.now() - 3600000),
        closedAt: new Date(),
        shiftType: "RETAIL",
        openingBalance: "10000.00",
      });

      const actor: Actor & { role: string } = { userId: 1, branchId: 1, role: "admin" };

      await expect(
        createSale(
          {
            branchId: 1,
            customerId: 1,
            sourceType: "POS",
            shiftId: 777,
            lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
            payment: { method: "CASH", amount: "5000.00" },
            clientRequestId: nextReq("admin-zombie"),
          },
          actor,
        ),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    });

    it("2.2 Shift Impersonation / Hijack Attack: Admin attempts cash sale using another cashier's open shift", async () => {
      // Victim cashier has an open shift
      await db().insert(s.shifts).values({
        id: 888,
        userId: 99, // cashier-victim
        branchId: 1,
        status: "OPEN",
        openedAt: new Date(),
        shiftType: "RETAIL",
        openingBalance: "10000.00",
      });

      const adminActor: Actor & { role: string } = { userId: 1, branchId: 1, role: "admin" };

      await expect(
        createSale(
          {
            branchId: 1,
            customerId: 1,
            sourceType: "POS",
            shiftId: 888,
            lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
            payment: { method: "CASH", amount: "5000.00" },
            clientRequestId: nextReq("admin-hijack"),
          },
          adminActor,
        ),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("2.3 Shift Impersonation Attack: Manager attempts invoice payment using another cashier's open shift", async () => {
      await db().insert(s.shifts).values({
        id: 889,
        userId: 99,
        branchId: 1,
        status: "OPEN",
        openedAt: new Date(),
        shiftType: "RETAIL",
        openingBalance: "10000.00",
      });

      const managerActor: Actor & { role: string } = { userId: 20, branchId: 1, role: "manager" };

      await expect(
        processPayment(
          {
            invoiceId: 100,
            amount: "5000.00",
            method: "CASH",
            shiftId: 889,
            clientRequestId: nextReq("manager-hijack-pay"),
          },
          managerActor,
        ),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("2.4 Cross-Branch Shift Smuggling: Admin has an open shift in Branch 2, attempts cash sale in Branch 1", async () => {
      // Admin has open shift in branch 2
      await db().insert(s.shifts).values({
        id: 992,
        userId: 1,
        branchId: 2,
        status: "OPEN",
        openedAt: new Date(),
        shiftType: "RETAIL",
        openingBalance: "10000.00",
      });

      const adminActor: Actor & { role: string } = { userId: 1, branchId: 1, role: "admin" };

      // Case A: Admin attempts sale in branch 1 without passing shiftId
      await expect(
        createSale(
          {
            branchId: 1,
            customerId: 1,
            sourceType: "POS",
            lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
            payment: { method: "CASH", amount: "5000.00" },
            clientRequestId: nextReq("admin-cross-null"),
          },
          adminActor,
        ),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });

      // Case B: Admin attempts sale in branch 1 by explicitly passing the branch 2 shiftId
      await expect(
        createSale(
          {
            branchId: 1,
            customerId: 1,
            sourceType: "POS",
            shiftId: 992,
            lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
            payment: { method: "CASH", amount: "5000.00" },
            clientRequestId: nextReq("admin-cross-explicit"),
          },
          adminActor,
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("2.5 Cross-Branch Voucher Smuggling: Admin has open shift in Branch 2, attempts cash voucher in Branch 1", async () => {
      await db().insert(s.shifts).values({
        id: 993,
        userId: 1,
        branchId: 2,
        status: "OPEN",
        openedAt: new Date(),
        shiftType: "RETAIL",
        openingBalance: "10000.00",
      });

      const adminActor: Actor & { role: string } = { userId: 1, branchId: 1, role: "admin" };

      const vRes = await createVoucher(
        {
          voucherType: "RECEIPT",
          branchId: 1,
          amount: "10000.00",
          paymentMethod: "CASH",
          partyType: "CUSTOMER",
          partyId: 1,
          description: "سند عبر الفروع",
          clientRequestId: nextReq("admin-cross-voucher"),
        },
        adminActor,
      );

      expect(vRes.approvalStatus).toBe("APPROVED");
      const [rc] = await db().select().from(s.receipts).where(eq(s.receipts.id, vRes.receiptId));
      expect(rc.shiftId).toBeNull();
      expect(rc.cashBucket).toBe("TREASURY");
    });

    it("2.6 Forensic Test: Admin cannot execute cash return when another cashier has an open shift in branch (throws FORBIDDEN)", async () => {
      // Cashier 99 has an open shift in branch 1
      await db().insert(s.shifts).values({
        id: 555,
        userId: 99,
        branchId: 1,
        status: "OPEN",
        openedAt: new Date(),
        shiftType: "RETAIL",
        openingBalance: "10000.00",
      });

      const adminActor: Actor & { role: string } = { userId: 1, branchId: 1, role: "admin" };

      // Admin has NO open shift in branch 1.
      // Admin attempts cash refund when Cashier 99 has an open shift -> MUST throw FORBIDDEN.
      let err: unknown = null;
      try {
        await returnSaleDirect(
          {
            invoiceId: 200,
            lines: [{ invoiceItemId: 200, baseQuantity: 1 }],
            refund: { amount: "5000.00", method: "CASH" },
            operatorReason: "إرجاع تجريبي رقابي لدرج كاشير آخر",
            clientRequestId: nextReq("admin-return-cashier-shift"),
          },
          adminActor,
        );
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("FORBIDDEN");

      // Verify DB state: zero cash OUT receipts written against Cashier 99's shift
      const outReceipts = await db()
        .select()
        .from(s.receipts)
        .where(and(eq(s.receipts.invoiceId, 200), eq(s.receipts.direction, "OUT")));
      expect(outReceipts).toHaveLength(0);

      // Verify that even if Admin explicitly specifies Cashier 99's shiftId, it still throws FORBIDDEN
      let explicitErr: unknown = null;
      try {
        await returnSaleDirect(
          {
            invoiceId: 200,
            lines: [{ invoiceItemId: 200, baseQuantity: 1 }],
            refund: { amount: "5000.00", method: "CASH", shiftId: 555 },
            operatorReason: "إرجاع تجريبي بتحديد درج كاشير آخر صراحة",
            clientRequestId: nextReq("admin-return-cashier-shift-explicit"),
          },
          adminActor,
        );
      } catch (e) {
        explicitErr = e;
      }
      expect(explicitErr).toBeInstanceOf(TRPCError);
      expect((explicitErr as TRPCError).code).toBe("FORBIDDEN");
    });

    it("2.7 Forensic Test: Admin cannot execute cash remittance by specifying another cashier's targetShiftId (throws FORBIDDEN)", async () => {
      // Cashier 99 has an open shift in branch 1
      await db().insert(s.shifts).values({
        id: 556,
        userId: 99,
        branchId: 1,
        status: "OPEN",
        openedAt: new Date(),
        shiftType: "RECEPTION",
        openingBalance: "10000.00",
      });

      await db().insert(s.deliveryParties).values({
        id: 2,
        name: "شركة التوصيل 2",
        phone: "07700000002",
        partyType: "COMPANY",
        branchId: 1,
      });

      const adminActor: Actor & { role: string } = { userId: 1, branchId: 1, role: "admin" };

      // Admin has NO open shift.
      // Admin passes targetShiftId: 556 (Cashier 99's shift) -> MUST throw FORBIDDEN.
      let err: unknown = null;
      try {
        await withTx(async (tx) => {
          return lockDeliveryRemittanceCashSourceInTx(
            tx,
            {
              partyId: 2,
              branchId: 1,
              collectedTotal: "15000.00",
              feesTotal: "3000.00",
              lines: [],
              targetShiftId: 556, // Cashier 99's shift
              clientRequestId: nextReq("admin-remit-target-shift"),
            },
            adminActor,
          );
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("FORBIDDEN");
    });
  });
});
