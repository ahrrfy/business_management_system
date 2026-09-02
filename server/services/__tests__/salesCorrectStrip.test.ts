/**
 * تجريد `sales.correct` الصادق (١٩/٨) — «شاشة التصحيح بدائية ولا تعمل» (بلاغ المالك).
 *
 * الإجراء **رأسٌ فقط**: ملاحظاتٌ وتاريخُ استحقاق. وكان يوهم بغير ذلك: يقفل كلّ إيصالات
 * الفاتورة بـ`FOR UPDATE` ويكتب `paymentMethod`/`receipts` في **طرفَي** سجلّ التدقيق
 * متطابقَين، والشاشةُ ترسم لهما «طريقة الدفع: كذا ← كذا» لا يظهر أبداً.
 *
 * المحروس هنا: (١) الحمولة مجرّدةٌ فعلاً، (٢) المال لم يُمَسّ، (٣) القفل زال فلا يُعطَّل
 * قبضٌ متزامن أثناء تعديل مديرٍ لملاحظة.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
  "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users", "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}
const getInsertId = (res: any): number => Number(res?.[0]?.insertId ?? res?.insertId);
let shiftId = 0;

function adminCtx(): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: 1, role: "admin", branchId: 1, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  };
}
const caller = () => appRouter.createCaller(adminCtx());

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "0.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
  await d.insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
  const sr = await d.insert(s.shifts).values({
    userId: 1, branchId: 1, status: "OPEN", openedAt: new Date(),
    openGuard: "1:1", openingBalance: "0",
  });
  shiftId = getInsertId(sr);
});

/** فاتورةٌ مقبوضةٌ نقداً — كي يوجد إيصالٌ فعليّ يمكن أن يُمَسّ لو أخطأ المسار. */
async function paidInvoice() {
  const r = await createSale(
    {
      branchId: 1, customerId: 1, sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }],
      payment: { amount: "30.00", method: "CASH" },
      shiftId,
    } as never,
    { userId: 1, branchId: 1 },
  );
  return Number((r as { invoiceId: number }).invoiceId);
}

describe("تجريد sales.correct", () => {
  it("⭐ حمولة التدقيق مجرّدة: ملاحظات فقط — لا استحقاق ولا طريقة دفع ولا إيصالات", async () => {
    const invoiceId = await paidInvoice();
    await caller().sales.correct({ invoiceId, notes: "ملاحظة جديدة", reason: "طلب العميل" });

    const log = (await db().select().from(s.auditLogs)
      .where(eq(s.auditLogs.action, "sale.invoiceCorrect")))[0];
    expect(log).toBeTruthy();
    const oldV = log.oldValue as Record<string, unknown>;
    const newV = (log.newValue as { fields: Record<string, unknown> }).fields;
    expect(Object.keys(oldV).sort()).toEqual(["notes"]);
    expect(Object.keys(newV).sort()).toEqual(["notes"]);
    expect(newV.notes).toBe("ملاحظة جديدة");
  });

  it("⭐ صفر أثرٍ ماليّ: الإيصال وطريقة الدفع والقيود كما هي بالحرف", async () => {
    const invoiceId = await paidInvoice();
    const before = {
      receipts: await db().select().from(s.receipts),
      entries: await db().select().from(s.accountingEntries),
      invoice: (await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)))[0],
    };

    await caller().sales.correct({ invoiceId, notes: "تعديل", reason: "سببٌ كافٍ" });

    const after = {
      receipts: await db().select().from(s.receipts),
      entries: await db().select().from(s.accountingEntries),
      invoice: (await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)))[0],
    };
    expect(after.receipts).toEqual(before.receipts);
    expect(after.entries).toEqual(before.entries);
    expect(after.invoice.paymentMethod).toBe(before.invoice.paymentMethod);
    expect(after.invoice.paidAmount).toBe(before.invoice.paidAmount);
    expect(after.invoice.total).toBe(before.invoice.total);
    // ما تغيّر: الملاحظة وحدها.
    expect(after.invoice.notes).toBe("تعديل");
  });

  it("يرفض بلا تغيّرٍ فعليّ، ويرفض المستند الميت", async () => {
    const invoiceId = await paidInvoice();
    await expect(caller().sales.correct({ invoiceId, reason: "بلا تغيير" }))
      .rejects.toThrowError(/لم تتغير/);
    await db().update(s.invoices).set({ status: "CANCELLED" }).where(eq(s.invoices.id, invoiceId));
    await expect(caller().sales.correct({ invoiceId, notes: "x", reason: "محاولة" }))
      .rejects.toThrowError(/ملغاة|مرتجعة|مستبدَلة/);
  });
});
