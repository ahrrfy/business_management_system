// sales.listSummary — مجاميع كل النتائج المطابقة للفلتر (W3):
//   ١) count/totalAmount/paidAmount = مجاميع Decimal للفواتير المنشأة (مقارنة نصّية بعد round2).
//   ٢) فلتر الحالة: المجاميع تطابق حرفياً صفوف list بنفس الفلتر (نفس buildSalesListConds).
//   ٣) returnedTotal يُخصم من «المتبقي»، والملغاة تساهم بصفر فيه (وتبقى ضمن totalAmount).
//   ٤) from/to نصف مفتوح [from, to+يوم) — فاتورة بتاريخ to تدخل، وبتاريخ to+1 لا.
// الاستعلام عبر appRouter.createCaller (نمط rbac.test.ts) لأن listSummary إجراء راوتر لا خدمة.
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import { getDb } from "../../db";
import { createSale, processPayment } from "../saleService";

Decimal.set({ rounding: Decimal.ROUND_HALF_UP });
const round2s = (v: Decimal.Value) => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

const actor = { userId: 1, branchId: 1 };

// سياق أدمن (branchScopedProcedure ⇒ scopedBranchId = null = كل الفروع) — نمط rbac.test.ts.
function adminCtx(): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: 1, role: "admin", branchId: 1, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  };
}
const caller = () => appRouter.createCaller(adminCtx());

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
  "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "0.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
  await d.insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
  // M5/M8: createSale CASH + processPayment CASH ⇒ يَلزم وردية مفتوحة.
  await d.insert(s.shifts).values({
    userId: 1, branchId: 1, status: "OPEN",
    openedAt: new Date(),
    openGuard: "1:1", openingBalance: "0",
  });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

/** بيع آجل (ORDER) بكمية قطع — القطعة 10.00. دفعة اختيارية تُسجَّل فوراً. */
async function sale(qtyPieces: string, pay?: string) {
  const r = await createSale(
    {
      branchId: 1,
      customerId: 1,
      sourceType: "ORDER",
      lines: [{ variantId: 1, productUnitId: 1, quantity: qtyPieces }],
      payment: pay ? { amount: pay, method: "CASH" } : undefined,
      // M8: createSale CASH يَستلزم shiftId صريحاً. الوردية مفتوحة في seedBase.
      shiftId: pay ? 1 : undefined,
    },
    actor,
  );
  return r;
}

/** ترجيع فاتورة إلى تاريخ معيّن (invoiceDate timestamp) — منتصف النهار محلياً لتفادي حواف المناطق الزمنية. */
async function backdateInvoice(invoiceId: number, ymd: string) {
  await db().update(s.invoices).set({ invoiceDate: new Date(`${ymd}T12:00:00`) }).where(eq(s.invoices.id, invoiceId));
}

describe("sales.listSummary — مجاميع الفلترة", () => {
  it("٣ فواتير (PAID/PARTIALLY_PAID/PENDING) ⇒ count=3 والمجاميع تساوي جمع Decimal", async () => {
    await sale("3", "30.00"); // 30.00 مدفوعة كاملة ⇒ PAID
    await sale("5", "20.00"); // 50.00 مدفوع 20 ⇒ PARTIALLY_PAID
    await sale("2");          // 20.00 بلا دفعة ⇒ PENDING

    // الحقيقة من DB نفسها: جمع Decimal على invoices.
    const all = await db().select().from(s.invoices);
    expect(all).toHaveLength(3);
    const expTotal = all.reduce((a, r) => a.plus(r.total), new Decimal(0));
    const expPaid = all.reduce((a, r) => a.plus(r.paidAmount), new Decimal(0));

    const sum = await caller().sales.listSummary({});
    expect(sum.count).toBe(3);
    expect(round2s(sum.totalAmount)).toBe(round2s(expTotal));
    expect(round2s(sum.paidAmount)).toBe(round2s(expPaid));
    // لا مرتجعات ولا ملغاة ⇒ المتبقي = الإجمالي − المسدَّد.
    expect(round2s(sum.dueAmount)).toBe(round2s(expTotal.minus(expPaid)));
    // قيم رقمية محدّدة (قطعة 10.00): 100.00 / 50.00 / 50.00.
    expect(round2s(sum.totalAmount)).toBe("100.00");
    expect(round2s(sum.paidAmount)).toBe("50.00");
    expect(round2s(sum.dueAmount)).toBe("50.00");
  });

  it("فلتر الحالة PARTIALLY_PAID ⇒ المجاميع تطابق صفوف list بنفس الفلتر حرفياً", async () => {
    await sale("3", "30.00"); // PAID
    const b = await sale("5", "20.00"); // PARTIALLY_PAID
    await processPayment({ invoiceId: b.invoiceId, amount: "5.00", method: "CASH" }, actor); // تبقى PARTIALLY_PAID (25/50)
    await sale("7", "30.00"); // 70.00 مدفوع 30 ⇒ PARTIALLY_PAID
    await sale("2");          // PENDING

    const c = caller();
    const rows = await c.sales.list({ status: "PARTIALLY_PAID" });
    const sum = await c.sales.listSummary({ status: "PARTIALLY_PAID" });

    expect(rows.length).toBeGreaterThan(0);
    expect(sum.count).toBe(rows.length);
    const expTotal = rows.reduce((a, r) => a.plus(r.total), new Decimal(0));
    const expPaid = rows.reduce((a, r) => a.plus(r.paidAmount), new Decimal(0));
    expect(round2s(sum.totalAmount)).toBe(round2s(expTotal));
    expect(round2s(sum.paidAmount)).toBe(round2s(expPaid));
    // لا مرتجعات/ملغاة في هذا السيناريو ⇒ المتبقي = الإجمالي − المسدَّد لنفس الصفوف.
    expect(round2s(sum.dueAmount)).toBe(round2s(expTotal.minus(expPaid)));
  });

  it("returnedTotal يُخصم من المتبقي، والملغاة تساهم بصفر فيه وتبقى ضمن totalAmount", async () => {
    const d1 = await sale("4"); // 40.00 بلا دفعة
    const d2 = await sale("2"); // 20.00 بلا دفعة
    // مرتجع جزئي 10.00 على الأولى (returnedTotal يحدّثه returnService — نحدّثه مباشرة لعزل منطق المجاميع).
    await db().update(s.invoices).set({ returnedTotal: "10.00" }).where(eq(s.invoices.id, d1.invoiceId));
    // إلغاء الثانية بالكامل.
    await db().update(s.invoices).set({ status: "CANCELLED" }).where(eq(s.invoices.id, d2.invoiceId));

    const sum = await caller().sales.listSummary({});
    expect(sum.count).toBe(2);
    // totalAmount يجمع الكل (حتى الملغاة) — المتبقي وحده يستثنيها.
    expect(round2s(sum.totalAmount)).toBe("60.00");
    expect(round2s(sum.paidAmount)).toBe("0.00");
    // المتبقي = (40 − 0 − 10) للأولى + 0 للملغاة = 30.00.
    expect(round2s(sum.dueAmount)).toBe("30.00");
  });

  it("from/to نصف مفتوح [from, to+يوم): فاتورة بتاريخ to تدخل وبتاريخ to+1 لا — مطابق لـ list", async () => {
    const FROM = "2026-01-01";
    const TO = "2026-01-15";
    const a = await sale("1"); // 10.00 — داخل الفترة
    const b = await sale("2"); // 20.00 — يوم to نفسه (يدخل)
    const c0 = await sale("3"); // 30.00 — يوم to+1 (لا يدخل)
    await backdateInvoice(a.invoiceId, "2026-01-10");
    await backdateInvoice(b.invoiceId, TO);
    await backdateInvoice(c0.invoiceId, "2026-01-16");

    const c = caller();
    const rows = await c.sales.list({ from: FROM, to: TO });
    const sum = await c.sales.listSummary({ from: FROM, to: TO });

    expect(rows.map((r) => r.id).sort()).toEqual([a.invoiceId, b.invoiceId].sort());
    expect(sum.count).toBe(2);
    expect(round2s(sum.totalAmount)).toBe("30.00"); // 10 + 20، والثلاثون خارج الحدّ
    const expTotal = rows.reduce((x, r) => x.plus(r.total), new Decimal(0));
    expect(round2s(sum.totalAmount)).toBe(round2s(expTotal));
  });
});
