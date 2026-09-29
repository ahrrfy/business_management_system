import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { approveVoucher, createVoucher } from "../voucherService";
import { money } from "../money";

const cashier = { userId: 10, branchId: 1, role: "cashier" as const };
const owner = { userId: 2, branchId: 1, role: "manager" as const, isOwner: true };

const TABLES = [
  "auditLogs",
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "branches",
  "users",
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

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 10, openId: "cashier-10", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1, isOwner: false, isActive: true },
    { id: 2, openId: "owner-2", name: "المالك المعتمد", role: "manager", loginMethod: "local", branchId: 1, isOwner: true, isActive: true },
  ]);
  await d.insert(s.products).values({ id: 1, name: "بضاعة" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "SKU-1", costPrice: "5000.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "20000.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 50 });
  await d.insert(s.shifts).values({ id: 1, userId: 10, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "1:1", openingBalance: "0" });
  await d.insert(s.customers).values({ id: 1, name: "عميل معتمد", currentBalance: "0", creditLimit: "9999999.00" });
  await d.insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "5000000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "TREASURY-SEED-FUND",
    createdBy: 2,
  });
}

describe("EDGE-FIN-01: فك التعليق الدائم عند اعتماد سند مرتبط بفاتورة مسددة مسبقاً", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("يعتمد السند بمرونة ويفك ربط الفاتورة ويقيد المبلغ على رصيد العميل إذا سُددت الفاتورة مسبقاً", async () => {
    // 1. إنشاء فاتورة آجلة بـ 20,000
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        priceTier: "RETAIL",
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      owner,
    );

    // 2. إنشاء سند قبض معلق بـ 20,000 مرتبط بالفاتورة بحالة (PENDING_APPROVAL)
    const [inserted] = await db().insert(s.receipts).values({
      voucherNumber: "RV-1-20260929-00001",
      branchId: 1,
      direction: "IN",
      amount: "20000.00",
      paymentMethod: "CASH",
      partyType: "CUSTOMER",
      partyId: 1,
      description: "دفعة معلقة تحت التدقيق",
      invoiceId: sale.invoiceId,
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      createdBy: 10,
      voucherDate: "2026-09-29",
    });
    const receiptId = inserted.insertId;

    // 3. أثناء انتظار الاعتماد، قام الكاشير بتسديد الفاتورة بالكامل في نقطة البيع
    await db()
      .update(s.invoices)
      .set({ paidAmount: "20000.00", status: "PAID" })
      .where(eq(s.invoices.id, sale.invoiceId));

    // 4. المدير يعتمد السند المعلق الآن
    // قبل الإصلاح: كان يرمي TRPCError(BAD_REQUEST) ويتعلق السند للأبد!
    // بعد الإصلاح: يكتمل الاعتماد بفك ربط الفاتورة وتوجيه المال لرصيد العميل
    const approvedRes = await approveVoucher(receiptId, owner);
    expect(approvedRes.approvalStatus).toBe("APPROVED");

    // 5. التحقق من سلامة البيانات:
    // أ. السند فُك ربطه بالفاتورة لمنع التحصيل أو العكس المزدوج
    const [receipt] = await db().select().from(s.receipts).where(eq(s.receipts.id, receiptId));
    expect(receipt.invoiceId).toBeNull();
    expect(receipt.internalNote).toContain("مسددة مسبقاً بالكامل");

    // ب. الفاتورة لم تتجاوز سقفها (paidAmount لا يزال 20,000)
    const [inv] = await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId));
    expect(money(inv.paidAmount).toFixed(2)).toBe("20000.00");
    expect(inv.status).toBe("PAID");

    // ج. سجل التدقيق وثق فك الربط
    const auditEntries = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "voucher.unlink_invoice_on_approval"));
    expect(auditEntries.length).toBeGreaterThan(0);
  });

  it("يعتمد السند بمرونة ويفك ربط الفاتورة إذا أُلغيت الفاتورة (مستند ميت) أثناء التعليق", async () => {
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        priceTier: "RETAIL",
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      owner,
    );

    const [inserted] = await db().insert(s.receipts).values({
      voucherNumber: "RV-1-20260929-00002",
      branchId: 1,
      direction: "IN",
      amount: "20000.00",
      paymentMethod: "CASH",
      partyType: "CUSTOMER",
      partyId: 1,
      description: "دفعة",
      invoiceId: sale.invoiceId,
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      createdBy: 10,
      voucherDate: "2026-09-29",
    });
    const receiptId = inserted.insertId;

    // إلغاء الفاتورة أثناء تعليق السند
    await db().update(s.invoices).set({ status: "CANCELLED" }).where(eq(s.invoices.id, sale.invoiceId));

    // اعتماد السند ينجح بلا استثناء
    const approvedRes = await approveVoucher(receiptId, owner);
    expect(approvedRes.approvalStatus).toBe("APPROVED");

    const [receipt] = await db().select().from(s.receipts).where(eq(s.receipts.id, receiptId));
    expect(receipt.invoiceId).toBeNull();
    expect(receipt.internalNote).toContain("ملغاة أو مرتجعة أو مستبدلة");

    // الفاتورة تبقى ملغاة ولم تُبعث كفاتورة مدفوعة
    const [inv] = await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId));
    expect(inv.status).toBe("CANCELLED");
  });
});
