import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  openShift,
  closeShift,
  getShiftReport,
  computeExpectedCash,
  shiftIdForCashTx,
} from "../shiftService";
import { createSale } from "../saleService";
import { processPayment } from "../sale/payment";
import { createVoucher, approveVoucher } from "../voucherService";
import { createExpense } from "../expenseService";
import { createCashDrop } from "../cashDropService";
import { money, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";

function db() {
  const conn = getDb();
  if (!conn) throw new Error("DATABASE_URL not set for tests");
  return conn;
}

const CASHIER_1: Actor & { role: string } = { userId: 10, branchId: 1, role: "cashier" };
const CASHIER_2: Actor & { role: string } = { userId: 11, branchId: 1, role: "cashier" };
const MANAGER_1: Actor & { role: string } = { userId: 20, branchId: 1, role: "manager" };
const ADMIN_1: Actor & { role: string } = { userId: 1, branchId: 1, role: "admin" };
const MANAGER_BRANCH_2: Actor & { role: string } = { userId: 21, branchId: 2, role: "manager" };

let requestSeq = 0;
function nextRequestId(prefix = "e2e-cash"): string {
  requestSeq += 1;
  return `${prefix}-${Date.now()}-${requestSeq}`;
}

async function seedBase() {
  const d = db();

  // 1. Branches
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);

  // 2. Users
  await d.insert(s.users).values([
    { id: 1, openId: "admin-user", name: "مدير النظام", role: "admin", loginMethod: "local", branchId: 1, isOwner: false },
    { id: 20, openId: "manager-user", name: "مدير الفرع", role: "manager", loginMethod: "local", branchId: 1, isOwner: true },
    { id: 10, openId: "cashier-1", name: "كاشير رئيسي", role: "cashier", loginMethod: "local", branchId: 1, isOwner: false },
    { id: 11, openId: "cashier-2", name: "كاشير ثان", role: "cashier", loginMethod: "local", branchId: 1, isOwner: false },
    { id: 21, openId: "manager-branch-2", name: "مدير الفرع الثاني", role: "manager", loginMethod: "local", branchId: 2, isOwner: false },
  ]);

  // 3. Voucher Categories
  await d.insert(s.voucherCategories).values([
    { id: 10, name: "مصروفات عامة", direction: "OUT", postingRole: "OPERATING_EXPENSE" },
    { id: 11, name: "إيرادات عامة", direction: "IN", postingRole: "OTHER_REVENUE" },
    { id: 12, name: "إيجار ومرافق", direction: "OUT", postingRole: "RENT" },
  ]);

  // 4. Customers
  await d.insert(s.customers).values([
    { id: 1, name: "عميل نقدي مباشر", defaultPriceTier: "RETAIL", currentBalance: "0.00" },
    { id: 2, name: "شركة الأفق للتجارة", defaultPriceTier: "RETAIL", currentBalance: "150000.00" },
  ]);

  // 5. Suppliers
  await d.insert(s.suppliers).values([
    { id: 1, name: "شركة النور للقرطاسية", currentBalance: "50000.00" },
  ]);

  // 6. Products, Variants, Units, Prices, Stock
  await d.insert(s.products).values([
    { id: 1, name: "دفتر تجارب مدرسي" },
    { id: 2, name: "قلم جاف فاخر" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "NB-EXP-01", costPrice: "3000.00" },
    { id: 2, productId: 2, sku: "PEN-EXP-01", costPrice: "500.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "5000.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "1000.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 500 },
    { variantId: 2, branchId: 1, quantity: 500 },
    { variantId: 1, branchId: 2, quantity: 200 },
  ]);

  // 7. Seed Initial Treasury Cash Float (enables opening shifts with positive float)
  await d.insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "10000000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "INITIAL-TREASURY-E2E-FLOAT",
    createdBy: 1,
  });
}

beforeEach(async () => {
  await seedBase();
});

describe("Cash Governance E2E Test Suite", () => {
  // =========================================================================
  // TIER 1: FEATURE COVERAGE (>=5 test cases per core cash feature)
  // =========================================================================

  describe("Tier 1: Feature Coverage — Core Cash Rails", () => {
    // -----------------------------------------------------------------------
    // Core Feature 1: POS Cash Sale (5 test cases)
    // -----------------------------------------------------------------------
    describe("1.1 POS Cash Sale", () => {
      it("TC-POS-01: Single POS retail cash sale books to DRAWER with active shift ID", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "50000.00", shiftType: "RETAIL" }, CASHIER_1);

        const sale = await createSale(
          {
            branchId: 1,
            customerId: 1,
            sourceType: "POS",
            shiftId: shift.shiftId,
            lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], // 1 * 5000 = 5000
            payment: { method: "CASH", amount: "5000.00" },
            clientRequestId: nextRequestId("pos-sale"),
          },
          CASHIER_1,
        );

        expect(sale.invoiceId).toBeDefined();

        const receiptRows = await db()
          .select()
          .from(s.receipts)
          .where(eq(s.receipts.invoiceId, sale.invoiceId));

        expect(receiptRows.length).toBe(1);
        const r = receiptRows[0];
        expect(r.cashBucket).toBe("DRAWER");
        expect(r.paymentMethod).toBe("CASH");
        expect(r.direction).toBe("IN");
        expect(Number(r.shiftId)).toBe(shift.shiftId);
        expect(r.status).toBe("COMPLETED");
        expect(r.approvalStatus).toBe("APPROVED");
        expect(money(r.amount).toFixed(2)).toBe("5000.00");
      });

      it("TC-POS-02: POS cash sale increments expected cash exactly by sale amount", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "50000.00", shiftType: "RETAIL" }, CASHIER_1);

        const expectedBefore = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "50000.00"));
        expect(expectedBefore.toFixed(2)).toBe("50000.00");

        await createSale(
          {
            branchId: 1,
            customerId: 1,
            sourceType: "POS",
            shiftId: shift.shiftId,
            lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }], // 3 * 5000 = 15000
            payment: { method: "CASH", amount: "15000.00" },
            clientRequestId: nextRequestId("pos-sale"),
          },
          CASHIER_1,
        );

        const expectedAfter = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "50000.00"));
        expect(expectedAfter.toFixed(2)).toBe("65000.00");
      });

      it("TC-POS-03: Multi-product POS cash sale calculates exact multi-line total without rounding error", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "10000.00", shiftType: "RETAIL" }, CASHIER_1);

        // 2 notebooks (2 * 5000 = 10,000) + 4 pens (4 * 1000 = 4,000) = 14,000
        await createSale(
          {
            branchId: 1,
            customerId: 1,
            sourceType: "POS",
            shiftId: shift.shiftId,
            lines: [
              { variantId: 1, productUnitId: 1, quantity: "2" },
              { variantId: 2, productUnitId: 2, quantity: "4" },
            ],
            payment: { method: "CASH", amount: "14000.00" },
            clientRequestId: nextRequestId("pos-multiline"),
          },
          CASHIER_1,
        );

        const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "10000.00"));
        expect(expected.toFixed(2)).toBe("24000.00");
      });

      it("TC-POS-04: POS cash sale with registered customer preserves drawer attribution", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "20000.00", shiftType: "RETAIL" }, CASHIER_1);

        const sale = await createSale(
          {
            branchId: 1,
            customerId: 2, // "شركة الأفق"
            sourceType: "POS",
            shiftId: shift.shiftId,
            lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], // 10,000
            payment: { method: "CASH", amount: "10000.00" },
            clientRequestId: nextRequestId("pos-registered-cust"),
          },
          CASHIER_1,
        );

        const r = (await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, sale.invoiceId)))[0];
        expect(r.cashBucket).toBe("DRAWER");
        expect(Number(r.shiftId)).toBe(shift.shiftId);

        // Balance of customer shouldn't increase for immediate cash settlement
        const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 2)))[0];
        expect(money(cust.currentBalance).toFixed(2)).toBe("150000.00");
      });

      it("TC-POS-05: Sequential POS cash sales accumulate monotonically in drawer balance", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "0.00", shiftType: "RETAIL" }, CASHIER_1);

        for (let i = 1; i <= 3; i++) {
          await createSale(
            {
              branchId: 1,
              customerId: 1,
              sourceType: "POS",
              shiftId: shift.shiftId,
              lines: [{ variantId: 2, productUnitId: 2, quantity: "2" }], // 2 * 1000 = 2000
              payment: { method: "CASH", amount: "2000.00" },
              clientRequestId: nextRequestId(`pos-seq-${i}`),
            },
            CASHIER_1,
          );
        }

        const finalExpected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "0.00"));
        expect(finalExpected.toFixed(2)).toBe("6000.00");
      });
    });

    // -----------------------------------------------------------------------
    // Core Feature 2: Cash Voucher IN (5 test cases)
    // -----------------------------------------------------------------------
    describe("1.2 Cash Voucher IN", () => {
      it("TC-VIN-01: Cash voucher IN for CUSTOMER debt collection binds to DRAWER and updates balance", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "50000.00", shiftType: "RETAIL" }, CASHIER_1);

        const v = await createVoucher(
          {
            voucherType: "RECEIPT",
            branchId: 1,
            amount: "40000.00",
            paymentMethod: "CASH",
            partyType: "CUSTOMER",
            partyId: 2,
            description: "تسديد دفعة نقدية من حساب شركة الأفق",
            clientRequestId: nextRequestId("vin-cust"),
          },
          CASHIER_1,
        );

        expect(v.receiptId).toBeDefined();
        const r = (await db().select().from(s.receipts).where(eq(s.receipts.id, v.receiptId)))[0];
        expect(r.cashBucket).toBe("DRAWER");
        expect(r.direction).toBe("IN");
        expect(Number(r.shiftId)).toBe(shift.shiftId);

        // Customer balance should be reduced from 150,000 to 110,000
        const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 2)))[0];
        expect(money(cust.currentBalance).toFixed(2)).toBe("110000.00");

        // Drawer cash should reflect +40,000 (total = 90,000)
        const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "50000.00"));
        expect(expected.toFixed(2)).toBe("90000.00");
      });

      it("TC-VIN-02: Cash voucher IN for OTHER party records counterpartyName and category", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "10000.00", shiftType: "RETAIL" }, CASHIER_1);

        const v = await createVoucher(
          {
            voucherType: "RECEIPT",
            branchId: 1,
            amount: "25000.00",
            paymentMethod: "CASH",
            partyType: "OTHER",
            partyId: null,
            counterpartyName: "وزارة التربية - أجور تصديق",
            voucherCategoryId: 11,
            description: "إيرادات تصديق وثائق",
            clientRequestId: nextRequestId("vin-other"),
          },
          CASHIER_1,
        );

        const r = (await db().select().from(s.receipts).where(eq(s.receipts.id, v.receiptId)))[0];
        expect(r.cashBucket).toBe("DRAWER");
        expect(r.counterpartyName).toBe("وزارة التربية - أجور تصديق");
        expect(Number(r.voucherCategoryId)).toBe(11);
        expect(Number(r.shiftId)).toBe(shift.shiftId);
      });

      it("TC-VIN-03: Cash voucher IN from SUPPLIER rebate increases drawer cash", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "20000.00", shiftType: "RETAIL" }, CASHIER_1);

        const v = await createVoucher(
          {
            voucherType: "RECEIPT",
            branchId: 1,
            amount: "15000.00",
            paymentMethod: "CASH",
            partyType: "SUPPLIER",
            partyId: 1,
            description: "خصم تشجيعي نقدي من المورد",
            clientRequestId: nextRequestId("vin-supp"),
          },
          CASHIER_1,
        );

        expect(v.receiptId).toBeDefined();
        const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "20000.00"));
        expect(expected.toFixed(2)).toBe("35000.00");
      });

      it("TC-VIN-04: Cash voucher IN under threshold is auto-approved and immediately impacts drawer", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "0.00", shiftType: "RETAIL" }, CASHIER_1);

        const v = await createVoucher(
          {
            voucherType: "RECEIPT",
            branchId: 1,
            amount: "10000.00",
            paymentMethod: "CASH",
            partyType: "CUSTOMER",
            partyId: 2,
            description: "قبض فوري تحت عتبة الموافقة",
            clientRequestId: nextRequestId("vin-auto-appr"),
          },
          CASHIER_1,
        );

        expect(v.approvalStatus).toBe("APPROVED");
        const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "0.00"));
        expect(expected.toFixed(2)).toBe("10000.00");
      });

      it("TC-VIN-05: Multiple voucher IN collections in same shift accumulate correctly in drawer", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "10000.00", shiftType: "RETAIL" }, CASHIER_1);

        await createVoucher(
          {
            voucherType: "RECEIPT",
            branchId: 1,
            amount: "5000.00",
            paymentMethod: "CASH",
            partyType: "CUSTOMER",
            partyId: 2,
            description: "قبض 1",
            clientRequestId: nextRequestId("vin-seq-1"),
          },
          CASHIER_1,
        );

        await createVoucher(
          {
            voucherType: "RECEIPT",
            branchId: 1,
            amount: "15000.00",
            paymentMethod: "CASH",
            partyType: "CUSTOMER",
            partyId: 2,
            description: "قبض 2",
            clientRequestId: nextRequestId("vin-seq-2"),
          },
          CASHIER_1,
        );

        const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "10000.00"));
        expect(expected.toFixed(2)).toBe("30000.00");
      });
    });

    // -----------------------------------------------------------------------
    // Core Feature 3: Cash Voucher OUT (5 test cases)
    // -----------------------------------------------------------------------
    describe("1.3 Cash Voucher OUT", () => {
      it("TC-VOUT-01: Approved cash voucher OUT decrements drawer expected cash", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "80000.00", shiftType: "RETAIL" }, CASHIER_1);

        // Create voucher OUT as cashier (pending approval)
        const v = await createVoucher(
          {
            voucherType: "PAYMENT",
            branchId: 1,
            amount: "25000.00",
            paymentMethod: "CASH",
            partyType: "SUPPLIER",
            partyId: 1,
            description: "دفعة نقدية لحساب المورد",
            clientRequestId: nextRequestId("vout-supp"),
          },
          CASHIER_1,
        );

        // Approve voucher via Manager with DRAWER funding source
        await approveVoucher(
          v.receiptId,
          MANAGER_1,
          {
            notes: "موافقة المدير على الصرف من الدرج",
            cashSource: { mode: "DRAWER", shiftId: shift.shiftId },
          },
        );

        const r = (await db().select().from(s.receipts).where(eq(s.receipts.id, v.receiptId)))[0];
        expect(r.direction).toBe("OUT");
        expect(r.cashBucket).toBe("DRAWER");
        expect(Number(r.shiftId)).toBe(shift.shiftId);

        // Drawer cash: 80,000 - 25,000 = 55,000
        const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "80000.00"));
        expect(expected.toFixed(2)).toBe("55000.00");
      });

      it("TC-VOUT-02: Cash voucher OUT updates supplier liability when approved", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "50000.00", shiftType: "RETAIL" }, CASHIER_1);

        const v = await createVoucher(
          {
            voucherType: "PAYMENT",
            branchId: 1,
            amount: "20000.00",
            paymentMethod: "CASH",
            partyType: "SUPPLIER",
            partyId: 1,
            description: "تسديد جزء من حساب المورد",
            clientRequestId: nextRequestId("vout-supp-bal"),
          },
          CASHIER_1,
        );

        await approveVoucher(
          v.receiptId,
          MANAGER_1,
          {
            notes: "معتمد من الدرج",
            cashSource: { mode: "DRAWER", shiftId: shift.shiftId },
          },
        );

        const supp = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
        // Supplier balance: 50,000 - 20,000 = 30,000
        expect(money(supp.currentBalance).toFixed(2)).toBe("30000.00");
      });

      it("TC-VOUT-03: Cash voucher OUT fails when drawer funds are insufficient", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "10000.00", shiftType: "RETAIL" }, CASHIER_1);

        const v = await createVoucher(
          {
            voucherType: "PAYMENT",
            branchId: 1,
            amount: "50000.00", // exceeds 10,000 in drawer
            paymentMethod: "CASH",
            partyType: "SUPPLIER",
            partyId: 1,
            description: "صرف يتجاوز رصيد الدرج",
            clientRequestId: nextRequestId("vout-insufficient"),
          },
          CASHIER_1,
        );

        await expect(
          approveVoucher(
            v.receiptId,
            MANAGER_1,
            {
              notes: "اعتماد غير ممكن لنقص النقد",
              cashSource: { mode: "DRAWER", shiftId: shift.shiftId },
            },
          ),
        ).rejects.toThrow();
      });

      it("TC-VOUT-04: Cash voucher OUT for OTHER party retains category and drawer attribution", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "40000.00", shiftType: "RETAIL" }, CASHIER_1);

        const v = await createVoucher(
          {
            voucherType: "PAYMENT",
            branchId: 1,
            amount: "15000.00",
            paymentMethod: "CASH",
            partyType: "OTHER",
            partyId: null,
            counterpartyName: "شركة الصيانة الدورية",
            voucherCategoryId: 10,
            description: "صيانة طابعة الإيصالات",
            clientRequestId: nextRequestId("vout-other-cat"),
          },
          CASHIER_1,
        );

        await approveVoucher(
          v.receiptId,
          MANAGER_1,
          {
            notes: "معتمد",
            cashSource: { mode: "DRAWER", shiftId: shift.shiftId },
          },
        );

        const r = (await db().select().from(s.receipts).where(eq(s.receipts.id, v.receiptId)))[0];
        expect(r.cashBucket).toBe("DRAWER");
        expect(r.counterpartyName).toBe("شركة الصيانة الدورية");
        expect(Number(r.voucherCategoryId)).toBe(10);
      });

      it("TC-VOUT-05: Cash voucher OUT with custom reference number is preserved on receipt", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "30000.00", shiftType: "RETAIL" }, CASHIER_1);

        const v = await createVoucher(
          {
            voucherType: "PAYMENT",
            branchId: 1,
            amount: "5000.00",
            paymentMethod: "CASH",
            partyType: "SUPPLIER",
            partyId: 1,
            referenceNumber: "INV-REF-9921",
            description: "دفعة مع رقم فاتورة مرجعية",
            clientRequestId: nextRequestId("vout-ref"),
          },
          CASHIER_1,
        );

        await approveVoucher(
          v.receiptId,
          MANAGER_1,
          {
            notes: "معتمد",
            cashSource: { mode: "DRAWER", shiftId: shift.shiftId },
          },
        );

        const r = (await db().select().from(s.receipts).where(eq(s.receipts.id, v.receiptId)))[0];
        expect(r.referenceNumber).toBe("INV-REF-9921");
      });
    });

    // -----------------------------------------------------------------------
    // Core Feature 4: Invoice Cash Collection (5 test cases)
    // -----------------------------------------------------------------------
    describe("1.4 Invoice Cash Collection", () => {
      it("TC-COL-01: Full cash collection on credit invoice marks invoice PAID and binds to DRAWER", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "20000.00", shiftType: "RETAIL" }, CASHIER_1);

        // Create credit order
        const order = await createSale(
          {
            branchId: 1,
            customerId: 2,
            sourceType: "ORDER",
            lines: [{ variantId: 1, productUnitId: 1, quantity: "6" }], // 6 * 5000 = 30,000
            clientRequestId: nextRequestId("credit-inv-full"),
          },
          ADMIN_1,
        );

        const paymentRes = await processPayment(
          {
            invoiceId: order.invoiceId,
            amount: "30000.00",
            method: "CASH",
            shiftId: shift.shiftId,
            clientRequestId: nextRequestId("pay-full"),
          },
          CASHIER_1,
        );

        expect(paymentRes.status).toBe("PAID");
        expect(paymentRes.paidAmount).toBe("30000.00");

        const r = (await db().select().from(s.receipts).where(eq(s.receipts.id, paymentRes.receiptId)))[0];
        expect(r.cashBucket).toBe("DRAWER");
        expect(r.paymentMethod).toBe("CASH");
        expect(Number(r.shiftId)).toBe(shift.shiftId);

        const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "20000.00"));
        expect(expected.toFixed(2)).toBe("50000.00");
      });

      it("TC-COL-02: Partial cash collection updates invoice to PARTIALLY_PAID and increments drawer", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "15000.00", shiftType: "RETAIL" }, CASHIER_1);

        const order = await createSale(
          {
            branchId: 1,
            customerId: 2,
            sourceType: "ORDER",
            lines: [{ variantId: 1, productUnitId: 1, quantity: "10" }], // 50,000
            clientRequestId: nextRequestId("credit-inv-partial"),
          },
          ADMIN_1,
        );

        const paymentRes = await processPayment(
          {
            invoiceId: order.invoiceId,
            amount: "20000.00",
            method: "CASH",
            shiftId: shift.shiftId,
            clientRequestId: nextRequestId("pay-partial"),
          },
          CASHIER_1,
        );

        expect(paymentRes.status).toBe("PARTIALLY_PAID");
        expect(paymentRes.paidAmount).toBe("20000.00");

        const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "15000.00"));
        expect(expected.toFixed(2)).toBe("35000.00");
      });

      it("TC-COL-03: Remainder payment on partially paid invoice completes settlement", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "0.00", shiftType: "RETAIL" }, CASHIER_1);

        const order = await createSale(
          {
            branchId: 1,
            customerId: 2,
            sourceType: "ORDER",
            lines: [{ variantId: 1, productUnitId: 1, quantity: "4" }], // 20,000
            clientRequestId: nextRequestId("credit-inv-rem"),
          },
          ADMIN_1,
        );

        // First installment: 10,000
        await processPayment(
          {
            invoiceId: order.invoiceId,
            amount: "10000.00",
            method: "CASH",
            shiftId: shift.shiftId,
            clientRequestId: nextRequestId("pay-part-1"),
          },
          CASHIER_1,
        );

        // Second installment: 10,000
        const finalPay = await processPayment(
          {
            invoiceId: order.invoiceId,
            amount: "10000.00",
            method: "CASH",
            shiftId: shift.shiftId,
            clientRequestId: nextRequestId("pay-part-2"),
          },
          CASHIER_1,
        );

        expect(finalPay.status).toBe("PAID");
        expect(finalPay.paidAmount).toBe("20000.00");

        const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "0.00"));
        expect(expected.toFixed(2)).toBe("20000.00");
      });

      it("TC-COL-04: Collections across multiple different invoices accumulate in cashier drawer", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "50000.00", shiftType: "RETAIL" }, CASHIER_1);

        const inv1 = await createSale(
          {
            branchId: 1,
            customerId: 1,
            sourceType: "ORDER",
            lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], // 10,000
            clientRequestId: nextRequestId("inv-multi-1"),
          },
          ADMIN_1,
        );

        const inv2 = await createSale(
          {
            branchId: 1,
            customerId: 2,
            sourceType: "ORDER",
            lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }], // 15,000
            clientRequestId: nextRequestId("inv-multi-2"),
          },
          ADMIN_1,
        );

        await processPayment(
          { invoiceId: inv1.invoiceId, amount: "10000.00", method: "CASH", shiftId: shift.shiftId, clientRequestId: nextRequestId("pay-inv1") },
          CASHIER_1,
        );

        await processPayment(
          { invoiceId: inv2.invoiceId, amount: "15000.00", method: "CASH", shiftId: shift.shiftId, clientRequestId: nextRequestId("pay-inv2") },
          CASHIER_1,
        );

        const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "50000.00"));
        expect(expected.toFixed(2)).toBe("75000.00");
      });

      it("TC-COL-05: Idempotent payment submission prevents duplicate cash drawer receipt", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "10000.00", shiftType: "RETAIL" }, CASHIER_1);

        const order = await createSale(
          {
            branchId: 1,
            customerId: 1,
            sourceType: "ORDER",
            lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], // 5000
            clientRequestId: nextRequestId("inv-idemp"),
          },
          ADMIN_1,
        );

        const reqId = nextRequestId("same-req-token");
        const pay1 = await processPayment(
          { invoiceId: order.invoiceId, amount: "5000.00", method: "CASH", shiftId: shift.shiftId, clientRequestId: reqId },
          CASHIER_1,
        );

        const pay2 = await processPayment(
          { invoiceId: order.invoiceId, amount: "5000.00", method: "CASH", shiftId: shift.shiftId, clientRequestId: reqId },
          CASHIER_1,
        );

        expect(pay2.idempotentReplay).toBe(true);

        const receiptsCount = await db()
          .select({ count: sql`count(*)` })
          .from(s.receipts)
          .where(eq(s.receipts.invoiceId, order.invoiceId));
        expect(Number(receiptsCount[0].count)).toBe(1);

        const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "10000.00"));
        expect(expected.toFixed(2)).toBe("15000.00");
      });
    });

    // -----------------------------------------------------------------------
    // Core Feature 5: Cash Expense (5 test cases)
    // -----------------------------------------------------------------------
    describe("1.5 Cash Expense", () => {
      it("TC-EXP-01: Direct petty cash expense from drawer binds to active shift and DRAWER bucket", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "50000.00", shiftType: "RETAIL" }, CASHIER_1);

        const exp = await createExpense(
          {
            branchId: 1,
            category: "SUPPLIES",
            amount: "7000.00",
            paymentMethod: "CASH",
            shiftId: shift.shiftId,
            description: "شراء مستلزمات نظافة للمتجر",
            clientRequestId: nextRequestId("exp-drawer"),
          },
          CASHIER_1,
        );

        expect(exp.receiptId).toBeDefined();
        const r = (await db().select().from(s.receipts).where(eq(s.receipts.id, exp.receiptId!)))[0];
        expect(r.cashBucket).toBe("DRAWER");
        expect(r.direction).toBe("OUT");
        expect(Number(r.shiftId)).toBe(shift.shiftId);

        const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "50000.00"));
        expect(expected.toFixed(2)).toBe("43000.00");
      });

      it("TC-EXP-02: Cash expense decrements drawer expected cash exactly by expense amount", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "30000.00", shiftType: "RETAIL" }, CASHIER_1);

        await createExpense(
          {
            branchId: 1,
            category: "MAINTENANCE",
            amount: "12500.00",
            paymentMethod: "CASH",
            shiftId: shift.shiftId,
            description: "صيانة إنارة الفرع",
            clientRequestId: nextRequestId("exp-maint"),
          },
          CASHIER_1,
        );

        const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "30000.00"));
        expect(expected.toFixed(2)).toBe("17500.00");
      });

      it("TC-EXP-03: Cash expense rejects when requested amount exceeds available drawer balance", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "5000.00", shiftType: "RETAIL" }, CASHIER_1);

        await expect(
          createExpense(
            {
              branchId: 1,
              category: "SUPPLIES",
              amount: "20000.00", // exceeds 5,000 in drawer
              paymentMethod: "CASH",
              shiftId: shift.shiftId,
              description: "مصروف يتجاوز رصيد الدرج",
              clientRequestId: nextRequestId("exp-insufficient"),
            },
            CASHIER_1,
          ),
        ).rejects.toThrow();
      });

      it("TC-EXP-04: Cash expense with payee and notes records complete audit attribution", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "25000.00", shiftType: "RETAIL" }, CASHIER_1);

        const exp = await createExpense(
          {
            branchId: 1,
            category: "SUPPLIES",
            amount: "4500.00",
            paymentMethod: "CASH",
            shiftId: shift.shiftId,
            payee: "أبو أحمد للقرطاسية الخارجية",
            description: "شراء ورق طباعة عاجل",
            clientRequestId: nextRequestId("exp-payee"),
          },
          CASHIER_1,
        );

        const expRow = (await db().select().from(s.expenses).where(eq(s.expenses.id, exp.expenseId)))[0];
        expect(expRow.payee).toBe("أبو أحمد للقرطاسية الخارجية");
        expect(expRow.description).toBe("شراء ورق طباعة عاجل");
      });

      it("TC-EXP-05: Sequential cash expenses accumulate and decrement drawer expected cash", async () => {
        const shift = await openShift({ branchId: 1, openingBalance: "50000.00", shiftType: "RETAIL" }, CASHIER_1);

        await createExpense(
          {
            branchId: 1,
            category: "SUPPLIES",
            amount: "6000.00",
            paymentMethod: "CASH",
            shiftId: shift.shiftId,
            clientRequestId: nextRequestId("exp-seq-1"),
          },
          CASHIER_1,
        );

        await createExpense(
          {
            branchId: 1,
            category: "SUPPLIES",
            amount: "8000.00",
            paymentMethod: "CASH",
            shiftId: shift.shiftId,
            clientRequestId: nextRequestId("exp-seq-2"),
          },
          CASHIER_1,
        );

        const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "50000.00"));
        expect(expected.toFixed(2)).toBe("36000.00");
      });
    });
  });

  // =========================================================================
  // TIER 2: BOUNDARY & CORNER CASES (>=5 test cases)
  // =========================================================================

  describe("Tier 2: Boundary & Corner Cases — Fail-Closed Enforcement", () => {
    it("TC-BOUND-01: Cashier with NO open shift is rejected fail-closed for POS cash sale", async () => {
      // Cashier 1 has no open shift
      await expect(
        createSale(
          {
            branchId: 1,
            customerId: 1,
            sourceType: "POS",
            lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
            payment: { method: "CASH", amount: "5000.00" },
            clientRequestId: nextRequestId("no-shift-pos"),
          },
          CASHIER_1,
        ),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    });

    it("TC-BOUND-02: Cashier with NO open shift is rejected fail-closed for cash invoice payment", async () => {
      const order = await createSale(
        {
          branchId: 1,
          customerId: 1,
          sourceType: "ORDER",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
          clientRequestId: nextRequestId("no-shift-inv"),
        },
        ADMIN_1,
      );

      await expect(
        processPayment(
          {
            invoiceId: order.invoiceId,
            amount: "5000.00",
            method: "CASH",
            clientRequestId: nextRequestId("no-shift-pay"),
          },
          CASHIER_1,
        ),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    });

    it("TC-BOUND-03: Cashier with NO open shift is rejected fail-closed for petty cash expense", async () => {
      await expect(
        createExpense(
          {
            branchId: 1,
            category: "SUPPLIES",
            amount: "5000.00",
            paymentMethod: "CASH",
            description: "صرف بلا وردية",
            clientRequestId: nextRequestId("no-shift-exp"),
          },
          CASHIER_1,
        ),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    });

    it("TC-BOUND-04: Anti-hijacking: Cashier 2 cannot book cash sale against Cashier 1 shift", async () => {
      const shift1 = await openShift({ branchId: 1, openingBalance: "20000.00", shiftType: "RETAIL" }, CASHIER_1);

      await expect(
        createSale(
          {
            branchId: 1,
            customerId: 1,
            sourceType: "POS",
            shiftId: shift1.shiftId, // Belongs to Cashier 1!
            lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
            payment: { method: "CASH", amount: "5000.00" },
            clientRequestId: nextRequestId("hijack-sale"),
          },
          CASHIER_2, // Attempted by Cashier 2!
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("TC-BOUND-05: Cross-branch rejection: Shift belonging to Branch 2 cannot be used in Branch 1", async () => {
      // Open shift in Branch 2 for Manager of Branch 2
      const shiftB2 = await openShift({ branchId: 2, openingBalance: "0.00", shiftType: "RETAIL" }, MANAGER_BRANCH_2);

      await expect(
        createSale(
          {
            branchId: 1, // Branch 1
            customerId: 1,
            sourceType: "POS",
            shiftId: shiftB2.shiftId, // Shift from Branch 2!
            lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
            payment: { method: "CASH", amount: "5000.00" },
            clientRequestId: nextRequestId("cross-branch-sale"),
          },
          CASHIER_1,
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("TC-BOUND-06: Non-positive amount rejection: Cash payment with 0.00 or negative amount fails", async () => {
      const shift = await openShift({ branchId: 1, openingBalance: "10000.00", shiftType: "RETAIL" }, CASHIER_1);

      const order = await createSale(
        {
          branchId: 1,
          customerId: 1,
          sourceType: "ORDER",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
          clientRequestId: nextRequestId("zero-amt-inv"),
        },
        ADMIN_1,
      );

      await expect(
        processPayment(
          {
            invoiceId: order.invoiceId,
            amount: "0.00",
            method: "CASH",
            shiftId: shift.shiftId,
            clientRequestId: nextRequestId("zero-amt-pay"),
          },
          CASHIER_1,
        ),
      ).rejects.toThrow();

      await expect(
        processPayment(
          {
            invoiceId: order.invoiceId,
            amount: "-500.00",
            method: "CASH",
            shiftId: shift.shiftId,
            clientRequestId: nextRequestId("neg-amt-pay"),
          },
          CASHIER_1,
        ),
      ).rejects.toThrow();
    });

    it("TC-BOUND-07: Zero-balance opening float shift lifecycle operates correctly without null arithmetic errors", async () => {
      const shift = await openShift({ branchId: 1, openingBalance: "0.00", shiftType: "RETAIL" }, CASHIER_1);

      await createSale(
        {
          branchId: 1,
          customerId: 1,
          sourceType: "POS",
          shiftId: shift.shiftId,
          lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], // 10,000
          payment: { method: "CASH", amount: "10000.00" },
          clientRequestId: nextRequestId("zero-float-sale"),
        },
        CASHIER_1,
      );

      const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "0.00"));
      expect(expected.toFixed(2)).toBe("10000.00");

      const closeRes = await closeShift(
        {
          shiftId: shift.shiftId,
          countedCash: "10000.00",
          enforceCashGovernance: true,
        },
        CASHIER_1,
      );

      expect(closeRes.reconciliationStatus).toBe("MATCHED");
      expect(money(closeRes.variance).isZero()).toBe(true);
    });
  });

  // =========================================================================
  // TIER 3: CROSS-FEATURE COMBINATIONS
  // =========================================================================

  describe("Tier 3: Cross-Feature Combinations — Multi-Rail Workflows", () => {
    it("TC-COMB-01: Maker-Checker approval preserves drawer shift binding and updates expected cash upon approval", async () => {
      const shift = await openShift({ branchId: 1, openingBalance: "100000.00", shiftType: "RETAIL" }, CASHIER_1);

      // 1. Cashier creates payment voucher OUT requiring approval
      const v = await createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "40000.00",
          paymentMethod: "CASH",
          partyType: "SUPPLIER",
          partyId: 1,
          description: "دفعة معلقة تتطلب موافقة المدير",
          clientRequestId: nextRequestId("maker-checker-vout"),
        },
        CASHIER_1,
      );

      expect(v.approvalStatus).toBe("PENDING_APPROVAL");

      // 2. Before approval: expected cash must NOT decrement
      const expectedBefore = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "100000.00"));
      expect(expectedBefore.toFixed(2)).toBe("100000.00");

      // 3. Manager approves voucher with DRAWER funding source
      const appRes = await approveVoucher(
        v.receiptId,
        MANAGER_1,
        {
          notes: "اعتماد المدير من درج الكاشير",
          cashSource: { mode: "DRAWER", shiftId: shift.shiftId },
        },
      );

      expect(appRes.approvalStatus).toBe("APPROVED");

      // 4. After approval: receipt preserves DRAWER and shiftId, expected cash decrements
      const r = (await db().select().from(s.receipts).where(eq(s.receipts.id, v.receiptId)))[0];
      expect(r.cashBucket).toBe("DRAWER");
      expect(Number(r.shiftId)).toBe(shift.shiftId);

      const expectedAfter = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "100000.00"));
      expect(expectedAfter.toFixed(2)).toBe("60000.00");
    });

    it("TC-COMB-02: Mid-shift Cash Drop decrements expected cash and reconciles cleanly at shift close", async () => {
      const shift = await openShift({ branchId: 1, openingBalance: "50000.00", shiftType: "RETAIL" }, CASHIER_1);

      // POS sales = 30 * 5,000 = 150,000 IQD. (Total in drawer = 200,000)
      await createSale(
        {
          branchId: 1,
          customerId: 1,
          sourceType: "POS",
          shiftId: shift.shiftId,
          lines: [{ variantId: 1, productUnitId: 1, quantity: "30" }],
          payment: { method: "CASH", amount: "150000.00" },
          clientRequestId: nextRequestId("pos-bulk-sale"),
        },
        CASHIER_1,
      );

      const expectedBeforeDrop = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "50000.00"));
      expect(expectedBeforeDrop.toFixed(2)).toBe("200000.00");

      // Mid-shift Cash Drop (safe skimming): 120,000 IQD to treasury
      const dropRes = await createCashDrop(
        {
          shiftId: shift.shiftId,
          amount: "120000.00",
          dropTo: MANAGER_1.userId,
          clientRequestId: nextRequestId("mid-shift-drop"),
        },
        CASHIER_1,
      );

      expect(dropRes.dropNumber).toBeDefined();
      expect(money(dropRes.drawerAfter).toFixed(2)).toBe("80000.00");

      // Expected cash must now be 80,000 IQD
      const expectedAfterDrop = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "50000.00"));
      expect(expectedAfterDrop.toFixed(2)).toBe("80000.00");

      // Cashier counts 80,000 IQD exactly at shift closing -> zero variance!
      const closeRes = await closeShift(
        {
          shiftId: shift.shiftId,
          countedCash: "80000.00",
          enforceCashGovernance: true,
        },
        CASHIER_1,
      );

      expect(closeRes.reconciliationStatus).toBe("MATCHED");
      expect(money(closeRes.variance).toFixed(2)).toBe("0.00");
    });

    it("TC-COMB-03: Composite multi-rail shift (Sales + Invoices + Vouchers + Expense + Drop) matches ledger exactly", async () => {
      // Opening: 50,000
      const shift = await openShift({ branchId: 1, openingBalance: "50000.00", shiftType: "RETAIL" }, CASHIER_1);

      // 1. POS Cash Sale: +25,000 (5 items * 5,000)
      await createSale(
        {
          branchId: 1,
          customerId: 1,
          sourceType: "POS",
          shiftId: shift.shiftId,
          lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
          payment: { method: "CASH", amount: "25000.00" },
          clientRequestId: nextRequestId("comp-pos"),
        },
        CASHIER_1,
      );

      // 2. Invoice Cash Collection: +30,000
      const creditOrder = await createSale(
        {
          branchId: 1,
          customerId: 2,
          sourceType: "ORDER",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "6" }], // 30,000
          clientRequestId: nextRequestId("comp-order"),
        },
        ADMIN_1,
      );
      await processPayment(
        {
          invoiceId: creditOrder.invoiceId,
          amount: "30000.00",
          method: "CASH",
          shiftId: shift.shiftId,
          clientRequestId: nextRequestId("comp-pay"),
        },
        CASHIER_1,
      );

      // 3. Cash Voucher IN: +15,000
      await createVoucher(
        {
          voucherType: "RECEIPT",
          branchId: 1,
          amount: "15000.00",
          paymentMethod: "CASH",
          partyType: "OTHER",
          counterpartyName: "إيراد استشارات",
          voucherCategoryId: 11,
          description: "إيراد نقدي",
          clientRequestId: nextRequestId("comp-vin"),
        },
        CASHIER_1,
      );

      // 4. Petty Cash Expense: -10,000
      await createExpense(
        {
          branchId: 1,
          category: "SUPPLIES",
          amount: "10000.00",
          paymentMethod: "CASH",
          shiftId: shift.shiftId,
          description: "مصروف ضيافة وتنظيف",
          clientRequestId: nextRequestId("comp-exp"),
        },
        CASHIER_1,
      );

      // 5. Cash Drop: -40,000
      await createCashDrop(
        {
          shiftId: shift.shiftId,
          amount: "40000.00",
          dropTo: MANAGER_1.userId,
          clientRequestId: nextRequestId("comp-drop"),
        },
        CASHIER_1,
      );

      // Math: 50,000 (opening) + 25,000 (sale) + 30,000 (inv) + 15,000 (vin) - 10,000 (exp) - 40,000 (drop) = 70,000
      const finalExpected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "50000.00"));
      expect(finalExpected.toFixed(2)).toBe("70000.00");

      // Verify closeShift matches 70,000 with 0.00 variance
      const closeRes = await closeShift(
        {
          shiftId: shift.shiftId,
          countedCash: "70000.00",
          enforceCashGovernance: true,
        },
        CASHIER_1,
      );

      expect(closeRes.reconciliationStatus).toBe("MATCHED");
      expect(money(closeRes.variance).isZero()).toBe(true);
    });
  });

  // =========================================================================
  // TIER 4: REAL-WORLD SCENARIOS
  // =========================================================================

  describe("Tier 4: Real-World Scenarios — Full Day Lifecycle & Provenance", () => {
    it("TC-SCEN-01: Full store day cashier shift lifecycle from opening float to zero-variance close and float return", async () => {
      // 1. Morning Shift Opening: 50,000 IQD opening float from treasury
      const shift = await openShift({ branchId: 1, openingBalance: "50000.00", shiftType: "RETAIL" }, CASHIER_1);

      // Verify shift status is OPEN
      const shiftRow = (await db().select().from(s.shifts).where(eq(s.shifts.id, shift.shiftId)))[0];
      expect(shiftRow.status).toBe("OPEN");
      expect(money(shiftRow.openingBalance).toFixed(2)).toBe("50000.00");

      // 2. Morning peak retail sales:
      // Customer A buys 2 notebooks: 10,000
      await createSale(
        {
          branchId: 1,
          customerId: 1,
          sourceType: "POS",
          shiftId: shift.shiftId,
          lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
          payment: { method: "CASH", amount: "10000.00" },
          clientRequestId: nextRequestId("day-sale-1"),
        },
        CASHIER_1,
      );

      // Customer B buys 10 pens: 10,000
      await createSale(
        {
          branchId: 1,
          customerId: 1,
          sourceType: "POS",
          shiftId: shift.shiftId,
          lines: [{ variantId: 2, productUnitId: 2, quantity: "10" }],
          payment: { method: "CASH", amount: "10000.00" },
          clientRequestId: nextRequestId("day-sale-2"),
        },
        CASHIER_1,
      );

      // 3. Customer debt collection via Voucher IN: 20,000
      await createVoucher(
        {
          voucherType: "RECEIPT",
          branchId: 1,
          amount: "20000.00",
          paymentMethod: "CASH",
          partyType: "CUSTOMER",
          partyId: 2,
          description: "تسديد دفعة حساب نقدية",
          clientRequestId: nextRequestId("day-vin"),
        },
        CASHIER_1,
      );

      // 4. Afternoon emergency maintenance expense: 8,000
      await createExpense(
        {
          branchId: 1,
          category: "MAINTENANCE",
          amount: "8000.00",
          paymentMethod: "CASH",
          shiftId: shift.shiftId,
          description: "إصلاح عطل كهربائي عاجل",
          clientRequestId: nextRequestId("day-exp"),
        },
        CASHIER_1,
      );

      // 5. Afternoon cash drop to safe: 40,000
      await createCashDrop(
        {
          shiftId: shift.shiftId,
          amount: "40000.00",
          dropTo: MANAGER_1.userId,
          clientRequestId: nextRequestId("day-drop"),
        },
        CASHIER_1,
      );

      // 6. End of day expected cash calculation:
      // 50,000 (open) + 10,000 (sale1) + 10,000 (sale2) + 20,000 (vin) - 8,000 (exp) - 40,000 (drop) = 42,000
      const expected = await withTx((tx) => computeExpectedCash(tx, shift.shiftId, "50000.00"));
      expect(expected.toFixed(2)).toBe("42000.00");

      // 7. Cashier counts physical cash: exactly 42,000 IQD
      const closeRes = await closeShift(
        {
          shiftId: shift.shiftId,
          countedCash: "42000.00",
          enforceCashGovernance: true,
        },
        CASHIER_1,
      );

      expect(closeRes.reconciliationStatus).toBe("MATCHED");
      expect(money(closeRes.variance).toFixed(2)).toBe("0.00");

      // Verify shift row updated to CLOSED
      const closedRow = (await db().select().from(s.shifts).where(eq(s.shifts.id, shift.shiftId)))[0];
      expect(closedRow.status).toBe("CLOSED");
      expect(money(closedRow.expectedCash ?? "0").toFixed(2)).toBe("42000.00");
      expect(money(closedRow.countedCash ?? "0").toFixed(2)).toBe("42000.00");
      expect(money(closedRow.variance ?? "0").toFixed(2)).toBe("0.00");

      // 8. Verify automated imprest return to treasury (CH-...)
      expect(closeRes.treasuryReturn).toBeDefined();
    });

    it("TC-SCEN-02: Z-Report provenance audit verifies complete transaction reconciliation without phantom variance", async () => {
      const shift = await openShift({ branchId: 1, openingBalance: "30000.00", shiftType: "RETAIL" }, CASHIER_1);

      // 1. POS Cash Sale: 15,000
      await createSale(
        {
          branchId: 1,
          customerId: 1,
          sourceType: "POS",
          shiftId: shift.shiftId,
          lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }],
          payment: { method: "CASH", amount: "15000.00" },
          clientRequestId: nextRequestId("z-sale"),
        },
        CASHIER_1,
      );

      // 2. Voucher IN: 10,000
      await createVoucher(
        {
          voucherType: "RECEIPT",
          branchId: 1,
          amount: "10000.00",
          paymentMethod: "CASH",
          partyType: "OTHER",
          counterpartyName: "مواطن - خدمات طباعة",
          voucherCategoryId: 11,
          description: "طباعة مستندات",
          clientRequestId: nextRequestId("z-vin"),
        },
        CASHIER_1,
      );

      // 3. Cash Expense: 5,000
      await createExpense(
        {
          branchId: 1,
          category: "SUPPLIES",
          amount: "5000.00",
          paymentMethod: "CASH",
          shiftId: shift.shiftId,
          description: "مشتريات ضيافة",
          clientRequestId: nextRequestId("z-exp"),
        },
        CASHIER_1,
      );

      // Close shift: 30,000 + 15,000 + 10,000 - 5,000 = 50,000
      await closeShift(
        {
          shiftId: shift.shiftId,
          countedCash: "50000.00",
          enforceCashGovernance: true,
        },
        CASHIER_1,
      );

      // 4. Retrieve Z-Report
      const report = await getShiftReport(shift.shiftId);
      expect(report).not.toBeNull();
      expect(report!.shift).toBeDefined();

      // Check reconciliation breakdown in report
      expect(money(report!.shift.openingBalance).toFixed(2)).toBe("30000.00");
      expect(money(report!.shift.expectedCash ?? "0").toFixed(2)).toBe("50000.00");
      expect(money(report!.shift.countedCash ?? "0").toFixed(2)).toBe("50000.00");
      expect(money(report!.shift.variance ?? "0").toFixed(2)).toBe("0.00");

      // Verify itemized receipts in Z-Report breakdown
      expect(report!.cashReconciliation.breakdown.opening.length).toBe(1);
      expect(report!.cashReconciliation.breakdown.cashSales.length).toBe(1);
      expect(report!.cashReconciliation.breakdown.otherCashIn.length).toBe(1);
      expect(report!.cashReconciliation.breakdown.expenses.length).toBe(1);

      // Verify formula reconciliation matches exactly
      expect(money(report!.cashReconciliation.cashSales).toFixed(2)).toBe("15000.00");
      expect(money(report!.cashReconciliation.otherCashIn).toFixed(2)).toBe("10000.00");
      expect(money(report!.cashReconciliation.expenses).toFixed(2)).toBe("5000.00");
      expect(money(report!.cashReconciliation.expectedCash).toFixed(2)).toBe("50000.00");
    });
  });
});
