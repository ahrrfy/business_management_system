import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cancelOutboundGift } from "../gifts/outbound";
import { approveVoucher, rejectVoucher } from "../voucherService";
import { cancelVoucher, createVoucher } from "../voucherService";

/**
 * المسار و (١٧/٨) — **دورات حياة ناقصة**: لكل حالةٍ معلّقة مخرجٌ واحدٌ على الأقل، ولا انتقال
 * مستحيل يُقبَل.
 *  - و-١ هدية صادرة `PENDING_APPROVAL` كان مخرجها الوحيد الاعتماد ⇒ إنفاقٌ قسريّ أو طابورٌ أبديّ.
 *  - و-٣ سندٌ أُلغي (`REVERSED`) وهو معلَّق كان يقبل «رفضاً» لاحقاً ⇒ حالة مستحيلة + حدث
 *    `PAYMENT_REJECTED` على طلبٍ منتهٍ. (`approveVoucher` كان يحرس `REVERSED`؛ الرفض لا.)
 */

function db() {
  const v = getDb();
  if (!v) throw new Error("DATABASE_URL not set for tests");
  return v;
}

const admin = { userId: 1, branchId: 1, role: "admin" as const };
const manager = { userId: 2, branchId: 1, role: "manager" as const };

const TABLES = [
  "giftVoucherLines", "giftVouchers", "accountingEntries", "receipts", "idempotencyKeys",
  "branchStock", "productUnits", "productVariants", "products", "categories",
  "suppliers", "users", "branches",
];

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "u1", name: "مدير", role: "admin", loginMethod: "local", branchId: 1, isOwner: false },
    { id: 2, openId: "u2", name: "مالك٢", role: "manager", loginMethod: "local", branchId: 1, isOwner: true },
    { id: 3, openId: "u3", name: "موظّف", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.suppliers).values({ id: 1, name: "مورّد" });
  await d.insert(s.categories).values({ id: 1, name: "قرطاسية" });
  await d.insert(s.products).values({ id: 1, name: "قلم", categoryId: 1 });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "500.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
});

describe("و-١ — مخرج طلب الهدية المعلَّق", () => {
  async function pendingGift() {
    const d = db();
    const [head] = await d.insert(s.giftVouchers).values({
      giftNumber: "GO-1", direction: "OUT", branchId: 1, status: "PENDING_APPROVAL",
      totalCost: "5000.00", createdBy: 3, sellable: true,
    });
    const giftId = Number((head as unknown as { insertId: number }).insertId);
    await d.insert(s.giftVoucherLines).values({
      giftVoucherId: giftId, variantId: 1, productUnitId: 1, quantity: "10",
      baseQuantity: 10, unitCostSnapshot: "500.00", lineCost: "5000.00",
    });
    return giftId;
  }

  it("الإلغاء يُنهي الطلب بصفر أثرٍ على المخزون والدفتر", async () => {
    const giftId = await pendingGift();
    const res = await cancelOutboundGift(giftId, admin, "طلب خاطئ");
    expect(res.status).toBe("CANCELLED");

    const [gift] = await db().select().from(s.giftVouchers).where(eq(s.giftVouchers.id, giftId));
    expect(gift.status).toBe("CANCELLED");
    // لا حركة مخزون ولا قيد: أثر الهدية لا يُطبَّق إلّا عند الاعتماد.
    const [stock] = await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1));
    expect(Number(stock.quantity)).toBe(100);
    const entries = await db().select({ id: s.accountingEntries.id }).from(s.accountingEntries);
    expect(entries).toHaveLength(0);
  });

  it("لا يُلغى إلّا المعلَّق (المُنجَز يُعالَج بعكسٍ محاسبيّ)", async () => {
    const giftId = await pendingGift();
    await db().update(s.giftVouchers).set({ status: "DELIVERED" }).where(eq(s.giftVouchers.id, giftId));
    await expect(cancelOutboundGift(giftId, admin)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("و-٣ — لا رفضَ لسندٍ ملغى", () => {
  it("سندٌ معلَّق أُلغي ⇒ الرفض يُرفض (والاعتماد كان محروساً أصلاً)", async () => {
    const created = await createVoucher(
      {
        voucherType: "PAYMENT", branchId: 1, amount: "5000000.00", paymentMethod: "CASH",
        partyType: "SUPPLIER", partyId: 1, description: "سند فوق العتبة",
        clientRequestId: "wf3-1",
      } as never,
      manager,
    );
    const [row] = await db().select().from(s.receipts).where(eq(s.receipts.id, created.receiptId));
    // الشريحة تفترض سنداً معلَّقاً؛ لو لم يتجاوز العتبة فلا موضوع للاختبار.
    expect(row.approvalStatus).toBe("PENDING_APPROVAL");

    await cancelVoucher(created.receiptId, admin);
    const [afterCancel] = await db().select().from(s.receipts).where(eq(s.receipts.id, created.receiptId));
    expect(afterCancel.status).toBe("REVERSED");

    await expect(rejectVoucher(created.receiptId, admin, "سبب")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(approveVoucher(created.receiptId, admin)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
