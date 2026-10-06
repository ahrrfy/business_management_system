/**
 * Empirical Challenger Suite: Cross-Module Cancellation Interlock (R3), Error Contracts & Boundary States
 *
 * Scenarios Tested:
 * 1. Cancellation interlock after full return (R3)
 * 2. Cancellation interlock on SUPERSEDED invoice (R3)
 * 3. Cancellation interlock on CANCELLED invoice (R3)
 * 4. Cancellation after partial return remains valid & refunds/restocks ONLY the remainder (R3 Boundary)
 * 5. Zero-dollar promotional invoice remains cancellable as intended (Boundary State)
 * 6. Error format contracts: strict BAD_REQUEST with appErrorMessage structure (no raw DB leaks)
 */

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { TRPCError } from "@trpc/server";
import type { TrpcContext } from "../../context";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { returnRouter } from "../returnRouter";
import { createSale } from "../../services/saleService";
import { cancelSale } from "../../services/sale/cancel";
import { isDeadInvoice } from "@shared/predicates/isDeadInvoice";

const TABLES = [
  "idempotencyKeys",
  "financialPeriods",
  "deliveryOutbox",
  "deliveryEvents",
  "deliveryRemittanceLines",
  "deliveryLedgerEntries",
  "deliveryConsignments",
  "deliveryRemittances",
  "deliveryParties",
  "onlineOrderItems",
  "onlineOrders",
  "installmentLines",
  "installmentPlans",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItemBundleComponents",
  "invoiceItemServiceMaterials",
  "invoiceItems",
  "invoices",
  "productionRecipeLines",
  "productionRecipes",
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
  const testDbUrl =
    process.env.DATABASE_URL ||
    process.env.TEST_DATABASE_URL ||
    "mysql://root:testpw@127.0.0.1:3310/erp_prevent_duplicate_invoice_returns_test";
  const conn = await mysql.createConnection(testDbUrl);
  try {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES) {
      try {
        await conn.query(`DELETE FROM \`${t}\``);
      } catch {
        // ignore missing tables
      }
    }
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    await conn.end();
  }
}

async function seed() {
  const d = db();
  // 1) Branches
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);

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
      name: "مدير الفرع الأول",
      role: "manager",
      branchId: 1,
      loginMethod: "local",
      isOwner: false,
    },
    {
      id: 4,
      openId: "test-manager-b2",
      name: "مدير الفرع الثاني",
      role: "manager",
      branchId: 2,
      loginMethod: "local",
      isOwner: false,
    },
  ]);

  // 3) Products & Variants
  // Product 1: Regular Book (5.00 IQD, Cost 2.00)
  await d.insert(s.products).values({ id: 1, name: "دفتر مذكرات" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NOTEBOOK-1", costPrice: "2.00" });
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "5.00" }]);
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });

  // Product 2: Regular Pen (2.00 IQD, Cost 1.00)
  await d.insert(s.products).values({ id: 2, name: "قلم حبر" });
  await d.insert(s.productVariants).values({ id: 2, productId: 2, sku: "PEN-2", costPrice: "1.00" });
  await d.insert(s.productUnits).values([
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([{ productUnitId: 2, priceTier: "RETAIL", price: "2.00" }]);
  await d.insert(s.branchStock).values({ variantId: 2, branchId: 1, quantity: 100 });

  // Product 3: Zero-Dollar Promotional Item (0.00 IQD, Cost 0.00)
  await d.insert(s.products).values({ id: 3, name: "هدية ترويجية مجانية" });
  await d.insert(s.productVariants).values({ id: 3, productId: 3, sku: "PROMO-0", costPrice: "0.00" });
  await d.insert(s.productUnits).values([
    { id: 3, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([{ productUnitId: 3, priceTier: "RETAIL", price: "0.00" }]);
  await d.insert(s.branchStock).values({ variantId: 3, branchId: 1, quantity: 50 });

  // 4) Customers
  await d.insert(s.customers).values([
    { id: 1, name: "عميل تجاري مسجل", currentBalance: "0.00" },
    { id: 2, name: "عميل نقدي مسجل", currentBalance: "0.00" },
  ]);
}

const cashierActor = { userId: 2, branchId: 1, role: "cashier" as const };
const managerActor = { userId: 3, branchId: 1, role: "manager" as const };
const managerOtherBranch = { userId: 4, branchId: 2, role: "manager" as const };
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

describe.sequential("Adversarial Empirical Challenge: Cross-Module Cancellation Interlock (R3) & Error Contracts", () => {
  // ═════════════════════════════════════════════════════════════════════════════
  // Challenge 1: Cancellation Interlock After Full Return (R3)
  // ═════════════════════════════════════════════════════════════════════════════
  it("CHALLENGE-1: محاولة إلغاء فاتورة بعد إرجاعها بالكامل ترفض قطعياً برمز BAD_REQUEST وعقد appErrorMessage", async () => {
    const shiftId = await openShift();
    // 1) بيع قطعتين بسعر 5.00 د.ع (إجمالي 10.00 د.ع)
    const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 2, unitPrice: "5.00" }]);

    // 2) تنفيذ إرجاع كامل للفاتورة (قطعتين بقيمة 10.00 د.ع)
    const caller = returnRouter.createCaller(cashierContext());
    await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      disposition: "RESTOCK",
      items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 2, unitPrice: "5.00" }],
      settlement: { method: "CASH", totalAmount: "10.00", shiftId },
      clientRequestId: "req-challenger-c1-full",
    });

    // التحقق من أن حالة الفاتورة تحولت إلى RETURNED
    const invAfterReturn = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId))
    )[0];
    expect(invAfterReturn.status).toBe("RETURNED");
    expect(invAfterReturn.returnedTotal).toBe("10.00");

    // 3) محاولة إلغاء الفاتورة بعد إرجاعها بالكامل
    let caughtError: any = null;
    try {
      await cancelSale(
        {
          invoiceId: sale.invoiceId,
          refundPaymentMethod: "CARD",
          reference: "REF-CARD-CHALLENGE-1",
          reason: "محاولة إلغاء بعد إرجاع كامل",
        },
        managerActor,
      );
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(TRPCError);
    expect(caughtError.code).toBe("BAD_REQUEST");
    // التحقق من بنية appErrorMessage (تحتوي على فاصل الشرطة والنقطة ومخرج عملي)
    expect(caughtError.message).toContain(" — ");
    expect(caughtError.message).toMatch(/مُرتجَعة بالكامل/);
    expect(caughtError.message).not.toMatch(/ER_|errno|sqlState|SELECT|INSERT|UPDATE/i);

    // التأكد من أن حالة الفاتورة لم تتبدل إلى CANCELLED
    const invFinal = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId))
    )[0];
    expect(invFinal.status).toBe("RETURNED");

    // التأكد من عدم تكرار إعادة المخزون (100 - 2 + 2 = 100)
    const [stockRow] = await db()
      .select()
      .from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
    expect(Number(stockRow.quantity)).toBe(100);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Challenge 2: Cancellation Interlock on SUPERSEDED Invoice (R3)
  // ═════════════════════════════════════════════════════════════════════════════
  it("CHALLENGE-2: محاولة إلغاء فاتورة مستبدلة بتصحيح (SUPERSEDED) ترفض قطعياً برمز BAD_REQUEST وعقد appErrorMessage", async () => {
    // 1) إنشاء فاتورة بيع عادية عبر خدمة البيع
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
      },
      adminActor,
    );

    // 2) تحديث حالة الفاتورة إلى SUPERSEDED لمحاكاة الاستبدال
    await db()
      .update(s.invoices)
      .set({ status: "SUPERSEDED" })
      .where(eq(s.invoices.id, sale.invoiceId));

    const supersededInv = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId))
    )[0];
    expect(supersededInv.status).toBe("SUPERSEDED");

    // 3) محاولة إلغاء الفاتورة الأصلية المستبدلة
    let caughtError: any = null;
    try {
      await cancelSale(
        {
          invoiceId: sale.invoiceId,
          refundPaymentMethod: "CASH",
          reason: "محاولة إلغاء فاتورة مستبدلة",
        },
        adminActor,
      );
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(TRPCError);
    expect(caughtError.code).toBe("BAD_REQUEST");
    expect(caughtError.message).toContain(" — ");
    expect(caughtError.message).toMatch(/مستبدلة بفاتورة مصححة|لا يجوز إلغاؤها/);
    expect(caughtError.message).not.toMatch(/ER_|errno|sqlState/i);

    // التأكد من بقاء الحالة SUPERSEDED
    const invCheck = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId))
    )[0];
    expect(invCheck.status).toBe("SUPERSEDED");
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Challenge 3: Cancellation Interlock on Already CANCELLED Invoice (R3)
  // ═════════════════════════════════════════════════════════════════════════════
  it("CHALLENGE-3: محاولة إلغاء فاتورة ملغاة مسبقاً (CANCELLED) ترفض قطعياً برمز BAD_REQUEST وعقد appErrorMessage", async () => {
    // 1) إنشاء فاتورة بيع
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
      },
      adminActor,
    );

    // 2) إلغاء الفاتورة بنجاح في المرة الأولى
    const firstCancel = await cancelSale(
      {
        invoiceId: sale.invoiceId,
        refundPaymentMethod: "CASH",
        reason: "إلغاء أولي صحيح",
      },
      adminActor,
    );
    expect(firstCancel.invoiceId).toBe(sale.invoiceId);

    const cancelledInv = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId))
    )[0];
    expect(cancelledInv.status).toBe("CANCELLED");

    // 3) محاولة إلغاء الفاتورة مرة ثانية بدون idempotency key
    let caughtError: any = null;
    try {
      await cancelSale(
        {
          invoiceId: sale.invoiceId,
          refundPaymentMethod: "CASH",
          reason: "إلغاء مكرر خاطئ",
        },
        adminActor,
      );
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(TRPCError);
    expect(caughtError.code).toBe("BAD_REQUEST");
    expect(caughtError.message).toContain(" — ");
    expect(caughtError.message).toMatch(/ملغاة مسبقاً/);
    expect(caughtError.message).not.toMatch(/ER_|errno|sqlState/i);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Challenge 4: Partial Return Cancellation Boundary (R3 Boundary)
  // ═════════════════════════════════════════════════════════════════════════════
  it("CHALLENGE-4: الفاتورة المرتجعة جزئياً تبقى قابلة للإلغاء وتعيد المتبقي المالي والمخزني فقط بلا مضاعفة", async () => {
    const shiftId = await openShift();
    // الرصيد الأولي للصنف 1 = 100
    // 1) بيع قطعتين بقيمة 10.00 د.ع (المخزون ينخفض إلى 98)
    const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 2, unitPrice: "5.00" }]);

    let [stockRow] = await db()
      .select()
      .from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
    expect(Number(stockRow.quantity)).toBe(98);

    // 2) إرجاع جزئي لقطعة واحدة بقيمة 5.00 د.ع (المخزون يرتفع إلى 99)
    const caller = returnRouter.createCaller(cashierContext());
    await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      disposition: "RESTOCK",
      items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
      settlement: { method: "CASH", totalAmount: "5.00", shiftId },
      clientRequestId: "req-challenger-c4-partial",
    });

    [stockRow] = await db()
      .select()
      .from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
    expect(Number(stockRow.quantity)).toBe(99);

    const invPartial = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId))
    )[0];
    expect(invPartial.returnedTotal).toBe("5.00");
    expect(invPartial.total).toBe("10.00");
    expect(isDeadInvoice(invPartial)).toBe(false);

    // 3) إلغاء الفاتورة: يجب أن ينجح ويعيد فقط القطعة الـ 1 المتبقية و 5.00 د.ع فقط
    const cancelRes = await cancelSale(
      {
        invoiceId: sale.invoiceId,
        refundPaymentMethod: "CARD",
        reference: "REF-CARD-C4",
        reason: "إلغاء ما تبقى من الفاتورة المرتجعة جزئياً",
      },
      managerActor,
    );

    // ═══ نتيجة التحقق بعد المعالجة (Post-Fix Verification) ═══
    // بعد تمرير invoiceId في مسار سلة المرتجعات executeSalesReturnCart،
    // يتم قيد إيصال الصرف (OUT) مربوطاً بالفاتورة، فتقوم دالة invoicePaidPool بحسم المبالغ المستردة سابقاً.
    // يسترد العميل فقط المبلغ المتبقي (5.00 د.ع) بدلاً من 10.00 د.ع كاملة (منع الازدواج المالي).
    expect(cancelRes.refundAmount).toBe("5.00");

    // المخزون يعود إلى 100 بالضبط (وليس 101 — منع تكرار إعادة المخزون المسترجع مسبقاً)
    [stockRow] = await db()
      .select()
      .from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
    expect(Number(stockRow.quantity)).toBe(100);

    // حالة الفاتورة تحولت إلى CANCELLED ورصيد returnedTotal أصبح 10.00 مساوياً للإجمالي
    const invFinal = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId))
    )[0];
    expect(invFinal.status).toBe("CANCELLED");
    expect(invFinal.returnedTotal).toBe("10.00");

    // 4) أي محاولة تالية لإرجاع أو إلغاء ترفض برمز BAD_REQUEST
    await expect(
      caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        disposition: "RESTOCK",
        items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
        settlement: { method: "CASH", totalAmount: "5.00", shiftId },
      }),
    ).rejects.toThrow();

    await expect(
      cancelSale(
        {
          invoiceId: sale.invoiceId,
          refundPaymentMethod: "CASH",
        },
        managerActor,
      ),
    ).rejects.toThrow();
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Challenge 5: Zero-Dollar Promotional Invoice Cancellability (Boundary State)
  // ═════════════════════════════════════════════════════════════════════════════
  it("CHALLENGE-5: الفاتورة الصفرية الترويجية قابلة للإلغاء وتعيد المخزون الترويجي وتتحول إلى CANCELLED بنجاح", async () => {
    // الرصيد الأولي للصنف الترويجي 3 = 50
    // 1) بيع قطعتين بسعر 0.00 د.ع (إجمالي 0.00 د.ع)
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "POS",
        priceOverrideApproved: true,
        lines: [{ variantId: 3, productUnitId: 3, quantity: "2" }],
        payment: { amount: "0.00", method: "CASH" },
      },
      adminActor,
    );

    // المخزون ينخفض من 50 إلى 48
    let [promoStock] = await db()
      .select()
      .from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, 3), eq(s.branchStock.branchId, 1)));
    expect(Number(promoStock.quantity)).toBe(48);

    const promoInv = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId))
    )[0];
    expect(parseFloat(promoInv.total)).toBe(0);
    expect(isDeadInvoice(promoInv)).toBe(false);

    // 2) إلغاء الفاتورة الصفرية: يجب أن يمر بنجاح دون أي خطأ رياضي أو قفل
    const cancelRes = await cancelSale(
      {
        invoiceId: sale.invoiceId,
        refundPaymentMethod: "CASH",
        reason: "إلغاء فاتورة ترويجية مجانية",
      },
      adminActor,
    );

    expect(cancelRes.invoiceId).toBe(sale.invoiceId);
    expect(cancelRes.refundAmount).toBe("0.00");

    // المخزون الترويجي يعود إلى 50 بالكامل
    [promoStock] = await db()
      .select()
      .from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, 3), eq(s.branchStock.branchId, 1)));
    expect(Number(promoStock.quantity)).toBe(50);

    // الفاتورة أصبحت CANCELLED
    const promoInvAfter = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId))
    )[0];
    expect(promoInvAfter.status).toBe("CANCELLED");

    // محاولة إلغائها مرة ثانية ترفض «ملغاة مسبقاً»
    await expect(
      cancelSale(
        {
          invoiceId: sale.invoiceId,
          refundPaymentMethod: "CASH",
        },
        adminActor,
      ),
    ).rejects.toThrow(/ملغاة مسبقاً/);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Challenge 6: Negative Error Contracts & Database Leak Resistance
  // ═════════════════════════════════════════════════════════════════════════════
  describe.sequential("CHALLENGE-6: Negative Error Contracts & DB Leak Resistance", () => {
    it("6.1: رفض محاولة تنفيذ مرتجع على فاتورة CANCELLED مع التزام هيكل appErrorMessage", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 1, unitPrice: "5.00" }]);
      await cancelSale(
        { invoiceId: sale.invoiceId, refundPaymentMethod: "CARD", reference: "REF-6-1" },
        managerActor,
      );

      const caller = returnRouter.createCaller(cashierContext());
      let caughtError: any = null;
      try {
        await caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          disposition: "RESTOCK",
          items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
          settlement: { method: "CASH", totalAmount: "5.00", shiftId },
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(TRPCError);
      expect(caughtError.code).toBe("BAD_REQUEST");
      expect(caughtError.message).toContain(" — ");
      expect(caughtError.message).toMatch(/ملغاة/);
      expect(caughtError.message).not.toMatch(/ER_|errno|sqlState/i);
    });

    it("6.2: رفض محاولة تنفيذ مرتجع على فاتورة SUPERSEDED مع التزام هيكل appErrorMessage", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 1, unitPrice: "5.00" }]);
      await db()
        .update(s.invoices)
        .set({ status: "SUPERSEDED" })
        .where(eq(s.invoices.id, sale.invoiceId));

      const caller = returnRouter.createCaller(cashierContext());
      let caughtError: any = null;
      try {
        await caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          disposition: "RESTOCK",
          items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
          settlement: { method: "CASH", totalAmount: "5.00", shiftId },
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(TRPCError);
      expect(caughtError.code).toBe("BAD_REQUEST");
      expect(caughtError.message).toContain(" — ");
      expect(caughtError.message).toMatch(/SUPERSEDED|مستبدلة/);
      expect(caughtError.message).not.toMatch(/ER_|errno|sqlState/i);
    });

    it("6.3: رفض محاولة تنفيذ مرتجع بمبلغ أكبر من المتبقي برمز BAD_REQUEST وعقد appErrorMessage", async () => {
      const shiftId = await openShift();
      const sale = await sellCashItems(shiftId, 1, [{ variantId: 1, qty: 1, unitPrice: "5.00" }]);

      const caller = returnRouter.createCaller(cashierContext());
      let caughtError: any = null;
      try {
        await caller.executeSalesReturnCart({
          invoiceNumber: sale.invoiceNumber,
          disposition: "RESTOCK",
          items: [{ variantId: 1, productName: "دفتر مذكرات", quantity: 1, unitPrice: "5.00" }],
          settlement: { method: "CASH", totalAmount: "15.00", shiftId }, // 15.00 > 5.00
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(TRPCError);
      expect(caughtError.code).toBe("BAD_REQUEST");
      expect(caughtError.message).toContain(" — ");
      expect(caughtError.message).toMatch(/يتجاوز القيمة المتبقية للفاتورة/);
      expect(caughtError.message).not.toMatch(/ER_|errno|sqlState/i);
    });

    it("6.4: رفض إلغاء فاتورة تابعة لفرع آخر من قبل مدير فرع غير مصرح (FORBIDDEN مع appErrorMessage)", async () => {
      const sale = await createSale(
        {
          branchId: 1,
          customerId: 1,
          sourceType: "ORDER",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        },
        adminActor,
      );

      let caughtError: any = null;
      try {
        await cancelSale(
          {
            invoiceId: sale.invoiceId,
            refundPaymentMethod: "CASH",
          },
          managerOtherBranch, // فرع 2 وليس فرع 1
        );
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(TRPCError);
      expect(caughtError.code).toBe("FORBIDDEN");
      expect(caughtError.message).toContain(" — ");
      expect(caughtError.message).toMatch(/لا تخصّ فرعك/);
      expect(caughtError.message).not.toMatch(/ER_|errno|sqlState/i);
    });

    it("6.5: رفض إلغاء فاتورة غير موجودة (NOT_FOUND مع appErrorMessage)", async () => {
      let caughtError: any = null;
      try {
        await cancelSale(
          {
            invoiceId: 999999, // غير موجودة
            refundPaymentMethod: "CASH",
          },
          adminActor,
        );
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(TRPCError);
      expect(caughtError.code).toBe("NOT_FOUND");
      expect(caughtError.message).toContain(" — ");
      expect(caughtError.message).toMatch(/غير موجودة/);
      expect(caughtError.message).not.toMatch(/ER_|errno|sqlState/i);
    });
  });
});
