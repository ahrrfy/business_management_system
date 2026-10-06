/**
 * اختبارات E2E الشاملة لحارس منع تكرار إرجاع الفواتير وبنودها والترابط الذري بين الإلغاء والإرجاع (F1 - F10 عبر Tiers 1-4).
 *
 * الفئات والمستويات المغطاة:
 * - Tier 1: Feature Coverage (F1 to F10 Happy Path & Primary Invariants)
 *   * F1: حارس تكرار المرتجع (Backend Idempotency Replay)
 *   * F2: توليد واستيعاب معرّف الطلب (clientRequestId)
 *   * F3: كشف الفواتير الميتة وسقف الاسترداد الصفري (isDeadInvoice & Block Predicate)
 *   * F4: كبح وتطويق الكميات لمنع تجاوز المتبقي (Quantity Clamping & Over-Return Prevention)
 *   * F5: صون مسار المرتجع العابر دون فاتورة (Walk-in Return Preservation)
 *   * F6: الترابط الذري المانع لإلغاء فاتورة مرتجعة كلياً (Atomic Cancellation Interlock)
 *   * F7: حارس أهلية الإلغاء في الواجهة (isCancellable Contract)
 *   * F8: فحص سجل وتفاصيل المرتجع المسبق (Enriched Return History Backend)
 *   * F9: وسم الفاتورة المسترجعة وانعكاس حالتها (Return Disclosure & Status Transition)
 *   * F10: توحيد رسائل الخطأ وفق عقد appErrorMessage (what, why, doThis)
 *
 * - Tier 2: Boundary & Corner Cases
 *   * مبالغ صفرية، تجاوز سقف الفاتورة، تجاوز المدفوع الفعلي، تجاوز كميات البنود، أصناف أجنبية، وحالات الفاتورة الميتة (RETURNED, CANCELLED, SUPERSEDED).
 *
 * - Tier 3: Cross-Feature Combinations & State Transitions
 *   * إرجاع ثم إلغاء (حظر قطعي)، إلغاء ثم إرجاع (حظر قطعي)، تجزئة المرتجع المتتالية، تزامن المرتجع العابر.
 *
 * - Tier 4: Real-World Retail Workflows
 *   * دورة الكاشير الكاملة عبر الورديات: بيع نقدي -> إرجاع جزئي أول -> إرجاع متمم -> حظر أي محاولة لاحقة للإرجاع أو الإلغاء.
 */

import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import type { TrpcContext } from "../../context";
import * as s from "../../../drizzle/schema";
import { getDb, closeDb } from "../../db";
import { returnRouter } from "../returnRouter";
import { createSale } from "../../services/saleService";
import { cancelSale } from "../../services/sale/cancel";
import { isDeadInvoice } from "@shared/predicates/isDeadInvoice";
import { DEAD_INVOICE_STATUSES, isDeadInvoiceStatus } from "@shared/invoiceStatus";

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItemBundleComponents",
  "invoiceItems",
  "invoices",
  "branchStock",
  "bundleComponents",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "suppliers",
  "branches",
  "roles",
  "users",
  "salesControlRequests",
  "returnRequests",
  "auditLogs",
  "monthCloseSequence",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  const conn = await mysql.createConnection(
    process.env.DATABASE_URL || "mysql://root:testpw@127.0.0.1:3310/erp_prevent_duplicate_invoice_returns_test"
  );
  try {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of TABLES) {
      if (table === "accountingEntries") {
        await conn.query(`TRUNCATE TABLE \`${table}\``);
      } else {
        await conn.query(`DELETE FROM \`${table}\``);
      }
    }
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    await conn.end();
  }
}

async function seed() {
  const d = db();
  // 1) Branch
  await d.insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });

  // 2) Users
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "test-admin",
      name: "مدير النظام",
      role: "admin",
      branchId: 1,
      loginMethod: "local",
      isOwner: true,
    },
    {
      id: 2,
      openId: "test-cashier",
      name: "كاشير المرتجعات",
      role: "cashier",
      branchId: 1,
      loginMethod: "local",
      isOwner: false,
    },
    {
      id: 3,
      openId: "test-manager",
      name: "مدير الفرع",
      role: "manager",
      branchId: 1,
      loginMethod: "local",
      isOwner: false,
    },
  ]);

  // 3) Products, Variants, Units, Prices, Stock
  // Product 1: Notebook
  await d.insert(s.products).values({ id: 1, name: "دفتر مذكرات" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NOTEBOOK-1", costPrice: "2.00" });
  await d.insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "5.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });

  // Product 2: Pen
  await d.insert(s.products).values({ id: 2, name: "قلم حبر" });
  await d.insert(s.productVariants).values({ id: 2, productId: 2, sku: "PEN-2", costPrice: "1.00" });
  await d.insert(s.productUnits).values({
    id: 2,
    variantId: 2,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await d.insert(s.productPrices).values({ productUnitId: 2, priceTier: "RETAIL", price: "2.00" });
  await d.insert(s.branchStock).values({ variantId: 2, branchId: 1, quantity: 100 });

  // Product 3: Foreign product (not sold on test invoice)
  await d.insert(s.products).values({ id: 3, name: "منتج أجنبي" });
  await d.insert(s.productVariants).values({ id: 3, productId: 3, sku: "FOREIGN-3", costPrice: "1.00" });
  await d.insert(s.productUnits).values({
    id: 3,
    variantId: 3,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await d.insert(s.productPrices).values({ productUnitId: 3, priceTier: "RETAIL", price: "3.00" });
  await d.insert(s.branchStock).values({ variantId: 3, branchId: 1, quantity: 50 });

  // 4) Customers
  await d.insert(s.customers).values([
    { id: 1, name: "عميل تجاري مسجل", currentBalance: "0.00" },
    { id: 2, name: "عميل نقدي مسجل", currentBalance: "0.00" },
  ]);
}

const cashierActor = { userId: 2, branchId: 1, role: "cashier" as const };
const managerActor = { userId: 3, branchId: 1, role: "manager" as const };
const adminActor = { userId: 1, branchId: 1, role: "admin" as const, isOwner: true };

function cashierContext(): TrpcContext {
  return {
    req: { headers: {} } as TrpcContext["req"],
    res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
    user: {
      id: 2,
      role: "cashier",
      branchId: 1,
      name: "كاشير المرتجعات",
      email: "cashier@test.local",
      isActive: true,
      isOwner: false,
    } as TrpcContext["user"],
  };
}

async function openShift(): Promise<number> {
  const r = await db().insert(s.shifts).values({
    branchId: 1,
    userId: 2,
    openingBalance: "1000.00",
    status: "OPEN",
    shiftType: "RETAIL",
    openGuard: "1:2:RETAIL",
  });
  return Number((r as unknown as { insertId?: number }[])[0]?.insertId ?? 1);
}

/** إنشاء عملية بيع نقدية سريعة بمجموع القطع والأسعار المحددة لتمويل الدرج وتوليد الفاتورة */
async function sellCashItems(
  shiftId: number,
  customerId: number,
  items: Array<{ variantId: number; productUnitId?: number; qty: number; unitPrice: string }>,
) {
  const totalAmount = items
    .reduce((sum, item) => sum + item.qty * parseFloat(item.unitPrice), 0)
    .toFixed(2);

  const sale = await createSale(
    {
      branchId: 1,
      shiftId,
      customerId,
      sourceType: "POS",
      lines: items.map((i) => ({
        variantId: i.variantId,
        productUnitId: i.productUnitId ?? i.variantId,
        quantity: String(i.qty),
      })),
      payment: { amount: totalAmount, method: "CASH" },
    },
    cashierActor,
  );
  return sale;
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe.sequential("E2E Test Suite: Prevent Duplicate Invoice Returns & Cross-Module Interlock (Tiers 1-4)", () => {
  // ═════════════════════════════════════════════════════════════════════════════
  // Tier 1: Feature Coverage (F1 to F10)
  // ═════════════════════════════════════════════════════════════════════════════
  describe.sequential("Tier 1: Feature Coverage (F1 - F10 Happy Path & Primary Invariants)", () => {
    it("⭐ T1-F1: Backend Idempotency — التنفيذ الأول يسجل المرتجع وتكرار نفس clientRequestId لا يكرر حركات الصرف المالي", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 3, unitPrice: "5.00" }]);
      const caller = returnRouter.createCaller(cashierContext());
      const clientRequestId = "req-idem-t1-f1";

      const returnPayload = {
        invoiceNumber: sale.invoiceNumber,
        customer: { customerId: 1, name: "عميل تجاري مسجل" },
        disposition: "RESTOCK" as const,
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
        settlement: { method: "CASH" as const, totalAmount: "5.00", shiftId },
        clientRequestId,
      };

      const firstRes = await caller.executeSalesReturnCart(returnPayload);
      expect(firstRes.returnNumber).toMatch(/^SR-/);

      const receiptsBefore = await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.direction, "OUT"));
      expect(receiptsBefore).toHaveLength(1);

      // إعادة تنفيذ نفس الطلب بنفس المعرف clientRequestId
      let secondRes: any = null;
      let dupRejected = false;
      try {
        secondRes = await caller.executeSalesReturnCart(returnPayload);
      } catch {
        dupRejected = true;
      }

      const receiptsAfter = await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.direction, "OUT"));

      // التحقق الصارم: يجب ألا يتكرر إيصال الصرف النقدي في الدرج مطلقاً
      expect(receiptsAfter).toHaveLength(1);
      if (!dupRejected && secondRes) {
        expect(secondRes.returnNumber).toBe(firstRes.returnNumber);
      }
    });

    it("⭐ T1-F2: Client Request ID — توليد واستيعاب معرّفات الطلب المتمايزة ينفذ عمليات متتابعة بنجاح", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 3, unitPrice: "5.00" }]);
      const caller = returnRouter.createCaller(cashierContext());

      // تنفيذ أول بمعرف req-t1-f2-a
      const resA = await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "5.00", shiftId },
        clientRequestId: "req-t1-f2-a",
      });
      expect(resA.returnNumber).toMatch(/^SR-/);

      // تنفيذ ثانٍ مستقل بمعرف متمايز req-t1-f2-b
      const resB = await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "5.00", shiftId },
        clientRequestId: "req-t1-f2-b",
      });
      expect(resB.returnNumber).toMatch(/^SR-/);
      expect(resA.returnNumber).not.toBe(resB.returnNumber);
    });

    it("⭐ T1-F3: Red Alert / Return Block Predicate — كشف الفواتير الميتة وحساب سقف الاسترداد المتبقي بدقة", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 1, unitPrice: "5.00" }]);
      const caller = returnRouter.createCaller(cashierContext());

      // 1) قبل الإرجاع: الفاتورة حية ولها سقف استرداد
      const initialInspection = await caller.inspectInvoiceForReturn({
        invoiceNumber: sale.invoiceNumber,
      });
      expect(initialInspection).not.toBeNull();
      expect(initialInspection?.isDead).toBe(false);
      expect(Number(initialInspection?.maxRefundable)).toBe(5);

      // 2) إرجاع الفاتورة بالكامل
      await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "5.00", shiftId },
        clientRequestId: "req-t1-f3-full",
      });

      // 3) بعد الإرجاع الكامل: الفاتورة تصبح ميتة RETURNED ومتبقيها صفر
      const afterInspection = await caller.inspectInvoiceForReturn({
        invoiceNumber: sale.invoiceNumber,
      });
      expect(afterInspection).not.toBeNull();
      expect(afterInspection?.status).toBe("RETURNED");
      expect(afterInspection?.isDead).toBe(true);
      expect(Number(afterInspection?.maxRefundable)).toBe(0);
      expect(Number(afterInspection?.remainingInvoiceTotal)).toBe(0);
    });

    it("⭐ T1-F4: Action Disablement & Qty Clamping — استرجاع جزئي يحدّث متبقي البنود ويمنع تجاوز الكمية", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 3, unitPrice: "5.00" }]);
      const caller = returnRouter.createCaller(cashierContext());

      // استرجاع قطعة واحدة من أصل 3
      await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "5.00", shiftId },
        clientRequestId: "req-t1-f4-part",
      });

      const inspected = await caller.inspectInvoiceForReturn({
        invoiceNumber: sale.invoiceNumber,
      });
      expect(inspected?.items[0]?.remainingQuantity).toBe(2);
      expect(inspected?.items[0]?.returnedBaseQuantity).toBe(1);
    });

    it("⭐ T1-F5: Walk-in Return Preservation — صون مسار المرتجع العابر دون رقم فاتورة بنجاح ودون أي عائق", async () => {
      const shiftId = await openShift();
      // تمويل الدرج أولاً ببيع نقدي بقيمة 20.00 د.ع
      await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 4, unitPrice: "5.00" }]);

      const caller = returnRouter.createCaller(cashierContext());

      // تنفيذ مرتجع نقدي لزبون عابر دون تمرير رقم فاتورة
      const res = await caller.executeSalesReturnCart({
        invoiceNumber: undefined,
        customer: { name: "زبون عابر متجر" },
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 2, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "10.00", shiftId },
        clientRequestId: "req-t1-f5-walkin",
      });

      expect(res.returnNumber).toMatch(/^SR-/);
      expect(res.originalInvoiceNumber).toBeUndefined();

      // التحقق من إنشاء إيصال صرف نقدي وتحديث رصيد المخزون
      const outReceipts = await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.direction, "OUT"));
      expect(outReceipts).toHaveLength(1);
      expect(outReceipts[0]?.amount).toBe("10.00");
    });

    it("⭐ T1-F6: Atomic Cancellation Interlock — الفاتورة المسترجعة كلياً يُمنع إلغاؤها قطيعاً", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 2, unitPrice: "5.00" }]);
      const caller = returnRouter.createCaller(cashierContext());

      // إرجاع الفاتورة كاملة (10.00 د.ع)
      await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 2, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "10.00", shiftId },
        clientRequestId: "req-t1-f6-full",
      });

      // محاولة إلغاء الفاتورة بعد إرجاعها بالكامل -> يجب أن تُرفض برمز BAD_REQUEST
      await expect(
        cancelSale(
          {
            invoiceId: sale.invoiceId,
            refundPaymentMethod: "CARD",
            reference: "REF-CARD-TEST",
            reason: "محاولة إلغاء بعد الإرجاع الكامل",
          },
          managerActor,
        ),
      ).rejects.toThrow(/مُرتجَعة|RETURNED|لا يمكن إلغاء/);
    });

    it("⭐ T1-F7: Cancellation UI Guard Invariant — التأكد من صحة مسند isDeadInvoiceStatus للفئات الحاكمة", () => {
      expect(isDeadInvoiceStatus("RETURNED")).toBe(true);
      expect(isDeadInvoiceStatus("CANCELLED")).toBe(true);
      expect(isDeadInvoiceStatus("SUPERSEDED")).toBe(true);
      expect(isDeadInvoiceStatus("PAID")).toBe(false);
      expect(isDeadInvoiceStatus("PENDING")).toBe(false);
      expect(isDeadInvoiceStatus("CONFIRMED")).toBe(false);

      expect(isDeadInvoice("RETURNED")).toBe(true);
      expect(isDeadInvoice("CANCELLED")).toBe(true);
      expect(isDeadInvoice({ status: "RETURNED" })).toBe(true);
      expect(isDeadInvoice({ status: "PAID" })).toBe(false);
    });

    it("⭐ T1-F8: Enriched Return Inspection Backend — فحص الفاتورة يعيد تفاصيل البنود والكميات والأسعار وسقف المرتجع بدقة", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [
        { variantId: 1, qty: 2, unitPrice: "5.00" },
        { variantId: 2, qty: 4, unitPrice: "2.00" },
      ]);
      const caller = returnRouter.createCaller(cashierContext());

      const inspected = await caller.inspectInvoiceForReturn({
        invoiceNumber: sale.invoiceNumber,
      });

      expect(inspected).not.toBeNull();
      expect(inspected?.invoiceNumber).toBe(sale.invoiceNumber);
      expect(inspected?.items).toHaveLength(2);
      expect(Number(inspected?.total)).toBe(18); // (2*5) + (4*2) = 10 + 8 = 18
      expect(Number(inspected?.maxRefundable)).toBe(18);
    });

    it("⭐ T1-F9: Return Disclosure & Status Transition — تحول حالة الفاتورة المسترجعة بالكامل إلى RETURNED وتصفير مدفوعها", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 2, unitPrice: "5.00" }]);
      const caller = returnRouter.createCaller(cashierContext());

      await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 2, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "10.00", shiftId },
        clientRequestId: "req-t1-f9-full",
      });

      const [invRow] = await db()
        .select()
        .from(s.invoices)
        .where(eq(s.invoices.id, sale.invoiceId));

      expect(invRow?.status).toBe("RETURNED");
      expect(Number(invRow?.returnedTotal)).toBe(10);
      expect(Number(invRow?.paidAmount)).toBe(0);
    });

    it("⭐ T1-F10: Error Message Standardization — رسائل الخطأ تتبع عقد appErrorMessage وتحتوي الإجراء المقترح doThis", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 2, unitPrice: "5.00" }]);
      const caller = returnRouter.createCaller(cashierContext());

      // محاولة استرجاع كمية ومبلغ يتجاوزان الفاتورة
      try {
        await caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          disposition: "RESTOCK",
          items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 5, unitPrice: "5.00" }],
          settlement: { method: "CASH", totalAmount: "25.00", shiftId },
          clientRequestId: "req-t1-f10-err",
        });
        expect.unreachable("كان يجب أن تفشل المعاملة بسبب تجاوز المتبقي");
      } catch (e: any) {
        // التحقق من بنية appErrorMessage: ماذا حدث — لماذا. ماذا تفعل
        expect(e.message).toContain(" — ");
        expect(e.message).toMatch(/(عدّل مبالغ وأصناف السلة|قلل الكمية|المتبقي)/);
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Tier 2: Boundary & Corner Cases
  // ═════════════════════════════════════════════════════════════════════════════
  describe.sequential("Tier 2: Boundary & Corner Cases", () => {
    it("T2-1: رفض مبلغ المرتجع الصفري (totalAmount <= 0) برمز BAD_REQUEST", async () => {
      const shiftId = await openShift();
      const caller = returnRouter.createCaller(cashierContext());

      await expect(
        caller.executeSalesReturnCart({
          disposition: "RESTOCK",
          items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "0.00" }],
          settlement: { method: "CASH", totalAmount: "0.00", shiftId },
        }),
      ).rejects.toThrow(/مبلغ المرتجع غير صالح|أكبر من صفر/);
    });

    it("T2-2: رفض استرداد مبلغ يتجاوز القيمة المتبقية للفاتورة", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 2, unitPrice: "5.00" }]); // total = 10.00
      const caller = returnRouter.createCaller(cashierContext());

      await expect(
        caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          disposition: "RESTOCK",
          items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "15.00" }],
          settlement: { method: "CASH", totalAmount: "15.00", shiftId },
        }),
      ).rejects.toThrow(/مبلغ المرتجع يتجاوز القيمة المتبقية للفاتورة/);
    });

    it("T2-3: رفض استرداد نقد يفوق المدفوع الفعلي على الفاتورة", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 2, unitPrice: "5.00" }]);
      // تعديل المدفوع الفعلي إلى 4.00 فقط في القاعدة
      await db()
        .update(s.invoices)
        .set({ paidAmount: "4.00" })
        .where(eq(s.invoices.id, sale.invoiceId));

      const caller = returnRouter.createCaller(cashierContext());

      await expect(
        caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          disposition: "RESTOCK",
          items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
          settlement: { method: "CASH", totalAmount: "5.00", shiftId },
        }),
      ).rejects.toThrow(/مبلغ الاسترداد يتجاوز المدفوع الفعلي للفاتورة/);
    });

    it("T2-4: رفض استرجاع كمية تتجاوز الكمية الأساسية المباعة للبند", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 2, unitPrice: "5.00" }]);
      const caller = returnRouter.createCaller(cashierContext());

      await expect(
        caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          disposition: "RESTOCK",
          items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 3, unitPrice: "5.00" }],
          settlement: { method: "CASH", totalAmount: "10.00", shiftId },
        }),
      ).rejects.toThrow(/تتجاوز المتبقي في الفاتورة/);
    });

    it("T2-5: رفض استرجاع صنف أجنبي غير مدرج ضمن بنود الفاتورة المرجعية", async () => {
      const shiftId = await openShift();
      // تم بيع الصنف 1 فقط
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 2, unitPrice: "5.00" }]);
      const caller = returnRouter.createCaller(cashierContext());

      // محاولة إرجاع الصنف 3 (غير موجود في الفاتورة)
      await expect(
        caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          disposition: "RESTOCK",
          items: [{ variantId: 3, productName: "منتج أجنبي", quantity: 1, unitPrice: "3.00" }],
          settlement: { method: "CASH", totalAmount: "3.00", shiftId },
        }),
      ).rejects.toThrow(/غير مدرج ضمن بنود الفاتورة المرجعية/);
    });

    it("T2-6: رفض تنفيذ مرتجع على فاتورة بحالة RETURNED", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 2, unitPrice: "5.00" }]);
      // ضبط الحالة إلى RETURNED مباشرة
      await db()
        .update(s.invoices)
        .set({ status: "RETURNED", returnedTotal: "10.00" })
        .where(eq(s.invoices.id, sale.invoiceId));

      const caller = returnRouter.createCaller(cashierContext());

      await expect(
        caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          disposition: "RESTOCK",
          items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
          settlement: { method: "CASH", totalAmount: "5.00", shiftId },
        }),
      ).rejects.toThrow(/فاتورة ملغاة أو مستبدلة أو مرجعة بالكامل مسبقاً|RETURNED/);
    });

    it("T2-7: رفض تنفيذ مرتجع على فاتورة بحالة CANCELLED", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 2, unitPrice: "5.00" }]);
      await db()
        .update(s.invoices)
        .set({ status: "CANCELLED" })
        .where(eq(s.invoices.id, sale.invoiceId));

      const caller = returnRouter.createCaller(cashierContext());

      await expect(
        caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          disposition: "RESTOCK",
          items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
          settlement: { method: "CASH", totalAmount: "5.00", shiftId },
        }),
      ).rejects.toThrow(/فاتورة ملغاة أو مستبدلة أو مرجعة بالكامل مسبقاً|CANCELLED/);
    });

    it("T2-8: رفض تنفيذ مرتجع على فاتورة بحالة SUPERSEDED", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 2, unitPrice: "5.00" }]);
      await db()
        .update(s.invoices)
        .set({ status: "SUPERSEDED" })
        .where(eq(s.invoices.id, sale.invoiceId));

      const caller = returnRouter.createCaller(cashierContext());

      await expect(
        caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          disposition: "RESTOCK",
          items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
          settlement: { method: "CASH", totalAmount: "5.00", shiftId },
        }),
      ).rejects.toThrow(/فاتورة ملغاة أو مستبدلة أو مرجعة بالكامل مسبقاً|SUPERSEDED/);
    });

    it("T2-9: الحد الدقيق: استرجاع كامل الكمية المتبقية يحول الحالة إلى RETURNED تماماً", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 4, unitPrice: "5.00" }]); // 20.00
      const caller = returnRouter.createCaller(cashierContext());

      // استرجاع كافة القطع الأربعة دفعة واحدة
      await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 4, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "20.00", shiftId },
      });

      const [updated] = await db()
        .select()
        .from(s.invoices)
        .where(eq(s.invoices.id, sale.invoiceId));

      expect(updated?.status).toBe("RETURNED");
      expect(Number(updated?.returnedTotal)).toBe(20);
      expect(Number(updated?.paidAmount)).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Tier 3: Cross-Feature Combinations & State Transitions
  // ═════════════════════════════════════════════════════════════════════════════
  describe.sequential("Tier 3: Cross-Feature Combinations & State Transitions", () => {
    it("T3-1: تعارض الإرجاع مع الإلغاء: الفاتورة المسترجعة كلياً تمنع الإلغاء اللاحق رفضاً قاطعاً", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 2, unitPrice: "5.00" }]);
      const caller = returnRouter.createCaller(cashierContext());

      // 1) إرجاع الفاتورة بالكامل
      await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 2, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "10.00", shiftId },
      });

      // 2) محاولة إلغاء الفاتورة من شاشة الإلغاء
      await expect(
        cancelSale(
          {
            invoiceId: sale.invoiceId,
            refundPaymentMethod: "CARD",
            reference: "REF-TEST-T3-1",
            reason: "إلغاء بعد إرجاع كامل",
          },
          managerActor,
        ),
      ).rejects.toThrow();
    });

    it("T3-2: تعارض الإلغاء مع الإرجاع: الفاتورة الملغاة تمنع أي محاولة إرجاع لاحقة رفضاً قاطعاً", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 2, unitPrice: "5.00" }]);

      // 1) إلغاء الفاتورة أولاً (عبر بطاقة لمنع الاعتماد على سيولة الخزينة)
      await cancelSale(
        {
          invoiceId: sale.invoiceId,
          refundPaymentMethod: "CARD",
          reference: "REF-TEST-T3-2",
          reason: "إلغاء بيع خاطئ",
        },
        managerActor,
      );

      // 2) محاولة إرجاع الفاتورة الملغاة
      const caller = returnRouter.createCaller(cashierContext());
      await expect(
        caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          disposition: "RESTOCK",
          items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
          settlement: { method: "CASH", totalAmount: "5.00", shiftId },
        }),
      ).rejects.toThrow(/ملغاة/);
    });

    it("T3-3: تجزئة المرتجع المتتالية (Step-Down Returns) حتى اكتمال الإرجاع وتجميد الفاتورة", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 4, unitPrice: "5.00" }]); // 4 قطع = 20.00
      const caller = returnRouter.createCaller(cashierContext());

      // خطوة 1: استرجاع قطعة واحدة (المتبقي 3)
      await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "5.00", shiftId },
        clientRequestId: "req-step-1",
      });
      let inspect = await caller.inspectInvoiceForReturn({ invoiceNumber: sale.invoiceNumber });
      expect(inspect?.items[0]?.remainingQuantity).toBe(3);
      expect(Number(inspect?.maxRefundable)).toBe(15);
      expect(inspect?.isDead).toBe(false);

      // خطوة 2: استرجاع قطعتين (المتبقي 1)
      await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 2, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "10.00", shiftId },
        clientRequestId: "req-step-2",
      });
      inspect = await caller.inspectInvoiceForReturn({ invoiceNumber: sale.invoiceNumber });
      expect(inspect?.items[0]?.remainingQuantity).toBe(1);
      expect(Number(inspect?.maxRefundable)).toBe(5);
      expect(inspect?.isDead).toBe(false);

      // خطوة 3: استرجاع القطعة الأخيرة المتبقية (المتبقي 0 وتتحول الحالة إلى RETURNED)
      await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "5.00", shiftId },
        clientRequestId: "req-step-3",
      });
      inspect = await caller.inspectInvoiceForReturn({ invoiceNumber: sale.invoiceNumber });
      expect(inspect?.items[0]?.remainingQuantity).toBe(0);
      expect(Number(inspect?.maxRefundable)).toBe(0);
      expect(inspect?.status).toBe("RETURNED");
      expect(inspect?.isDead).toBe(true);

      // خطوة 4: أي محاولة لاحقة تُرفض فوراً
      await expect(
        caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          disposition: "RESTOCK",
          items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
          settlement: { method: "CASH", totalAmount: "5.00", shiftId },
          clientRequestId: "req-step-4",
        }),
      ).rejects.toThrow(/RETURNED|ملغاة أو مستبدلة أو مرجعة بالكامل مسبقاً/);
    });

    it("T3-4: استقلالية المرتجع العابر عند تجميد أو قفل مرتجعات الفواتير", async () => {
      const shiftId = await openShift();
      // تمويل الدرج أولاً بمبيعات كافية (4 قطع = 20.00 د.ع)
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 4, unitPrice: "5.00" }]);
      const caller = returnRouter.createCaller(cashierContext());

      // إرجاع الفاتورة بالكامل وقفلها (صرف 20.00 د.ع، ثم مبيعات أخرى لتمويل المرتجع العابر)
      await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 4, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "20.00", shiftId },
      });

      // بيع جديد يمول الدرج بـ 15.00 د.ع
      await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 3, unitPrice: "5.00" }]);

      // التحقق من أن المرتجع العابر لا يتأثر إطلاقاً ويعمل بسلاسة
      const walkinRes = await caller.executeSalesReturnCart({
        invoiceNumber: undefined,
        customer: { name: "زبون عابر مستقل" },
        disposition: "RESTOCK",
        items: [{ variantId: 2, productName: "قلم حبر", quantity: 3, unitPrice: "2.00" }],
        settlement: { method: "CASH", totalAmount: "6.00", shiftId },
      });

      expect(walkinRes.returnNumber).toMatch(/^SR-/);
      expect(Number(walkinRes.totalAmount)).toBe(6);
    });

    it("T3-5: حارس تكرار البند المقسم داخل السلة نفسها (Line Splitting Invariant)", async () => {
      const shiftId = await openShift();
      // تم بيع قطعتين فقط من الصنف 1
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 2, unitPrice: "5.00" }]);
      const caller = returnRouter.createCaller(cashierContext());

      // محاولة التحايل بتقسيم الصنف إلى سطرين (2 قطعة + 1 قطعة = 3 قطع > 2)
      await expect(
        caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          disposition: "RESTOCK",
          items: [
            { variantId: 1, productName: "دفتر مذكرات", quantity: 2, unitPrice: "5.00" },
            { variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" },
          ],
          settlement: { method: "CASH", totalAmount: "15.00", shiftId },
        }),
      ).rejects.toThrow();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Tier 4: Real-World Retail Workflows
  // ═════════════════════════════════════════════════════════════════════════════
  describe.sequential("Tier 4: Real-World Retail Workflows", () => {
    it("T4-1: دورة الكاشير الواقعية: بيع نقدي -> إرجاع جزئي صباحي -> إرجاع متمم مسائي -> قفل الفاتورة وحظر الإلغاء", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 5, unitPrice: "5.00" }]); // 25.00 د.ع
      const caller = returnRouter.createCaller(cashierContext());

      // 1) إرجاع جزئي صباحي لقطعتين
      const ret1 = await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        customer: { customerId: 1, name: "عميل تجاري مسجل" },
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 2, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "10.00", shiftId },
        reason: "إرجاع صباحي جزئي",
        clientRequestId: "req-rw-morning",
      });
      expect(ret1.returnNumber).toMatch(/^SR-/);

      // 2) إرجاع متمم مسائي للقطع الثلاث المتبقية
      const ret2 = await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        customer: { customerId: 1, name: "عميل تجاري مسجل" },
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 3, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "15.00", shiftId },
        reason: "إرجاع مسائي متمم",
        clientRequestId: "req-rw-evening",
      });
      expect(ret2.returnNumber).toMatch(/^SR-/);

      // 3) التحقق من أن الفاتورة أصبحت مقفلة بالكامل
      const [finalInv] = await db()
        .select()
        .from(s.invoices)
        .where(eq(s.invoices.id, sale.invoiceId));
      expect(finalInv?.status).toBe("RETURNED");
      expect(Number(finalInv?.returnedTotal)).toBe(25);
      expect(Number(finalInv?.paidAmount)).toBe(0);

      // 4) محاولة إرجاع إضافي ترفض
      await expect(
        caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          disposition: "RESTOCK",
          items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
          settlement: { method: "CASH", totalAmount: "5.00", shiftId },
          clientRequestId: "req-rw-extra",
        }),
      ).rejects.toThrow();

      // 5) محاولة إلغاء الفاتورة ترفض
      await expect(
        cancelSale(
          {
            invoiceId: sale.invoiceId,
            refundPaymentMethod: "CARD",
            reference: "REF-TEST-T4-1",
            reason: "إلغاء فاتورة متممة الإرجاع",
          },
          managerActor,
        ),
      ).rejects.toThrow();
    });

    it("T4-2: إرجاع متعدد الأصناف في الفاتورة: إرجاع أحد الأصناف مع بقاء الآخر قابلاً للإرجاع", async () => {
      const shiftId = await openShift();
      // بيع صنفين: دفترين وقلمين
      const sale = await sellCashItems(shiftId, 1, [
        { variantId: 1, qty: 2, unitPrice: "5.00" }, // 10.00
        { variantId: 2, qty: 2, unitPrice: "2.00" }, // 4.00
      ]);
      const caller = returnRouter.createCaller(cashierContext());

      // إرجاع الدفاتر فقط (قطعتين من الصنف 1)
      await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 2, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "10.00", shiftId },
        clientRequestId: "req-rw-item1",
      });

      const inspect = await caller.inspectInvoiceForReturn({
        invoiceNumber: sale.invoiceNumber,
      });

      // الصنف 1 استنفد بالكامل (متبقي 0)
      const item1 = inspect?.items.find((i) => i.variantId === 1);
      expect(item1?.remainingQuantity).toBe(0);

      // الصنف 2 ما زال متاحاً للإرجاع (متبقي 2)
      const item2 = inspect?.items.find((i) => i.variantId === 2);
      expect(item2?.remainingQuantity).toBe(2);
      expect(Number(inspect?.maxRefundable)).toBe(4);
      expect(inspect?.isDead).toBe(false);

      // إرجاع الأقلام لاحقاً
      await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "RESTOCK",
        items: [{ variantId: 2, productName: "قلم حبر", quantity: 2, unitPrice: "2.00" }],
        settlement: { method: "CASH", totalAmount: "4.00", shiftId },
        clientRequestId: "req-rw-item2",
      });

      const finalInspect = await caller.inspectInvoiceForReturn({
        invoiceNumber: sale.invoiceNumber,
      });
      expect(finalInspect?.status).toBe("RETURNED");
      expect(Number(finalInspect?.maxRefundable)).toBe(0);
      expect(finalInspect?.isDead).toBe(true);
    });

    it("T4-3: إرجاع صنف تالف بتصنيف DAMAGED — تسجيل الخسارة دون إعادة الصنف لمخزون الرف الصالح للبيع", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 1, unitPrice: "5.00" }]);
      const caller = returnRouter.createCaller(cashierContext());

      const [stockBefore] = await db()
        .select()
        .from(s.branchStock)
        .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
      const qtyBefore = stockBefore?.quantity ?? 0;

      // إرجاع الصنف بتصنيف DAMAGED
      const res = await caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "DAMAGED",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "5.00", shiftId },
        reason: "تالف وغير صالح للبيع",
        clientRequestId: "req-rw-damaged",
      });

      expect(res.returnNumber).toMatch(/^SR-/);
      expect(res.disposition).toBe("DAMAGED");

      const [stockAfter] = await db()
        .select()
        .from(s.branchStock)
        .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));

      // الصنف التالف لا يعود إلى المخزون الجاهز للبيع (RESTOCK)
      expect(stockAfter?.quantity).toBe(qtyBefore);

      // الفاتورة استرجعت قيمتها
      const inspect = await caller.inspectInvoiceForReturn({
        invoiceNumber: sale.invoiceNumber,
      });
      expect(inspect?.status).toBe("RETURNED");
      expect(Number(inspect?.maxRefundable)).toBe(0);
    });
  });
});
