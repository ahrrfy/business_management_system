// اعتماد تسويات المخزون المُعلَّقة (فصل مهام #٦، الشريحة ٢): طلبٌ معلَّق بلا تغيير مخزون ⇒ اعتماد
// مديرٍ آخر (SOD-04) يطبّق setStock + قيد ADJUST؛ الرفض بلا أثر؛ عزل الفرع.
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  requestStockAdjustment,
  approveStockAdjustment,
  rejectStockAdjustment,
  listStockAdjustmentRequests,
} from "../inventory/adjustmentApproval";

const WH1 = { userId: 2, branchId: 1, role: "warehouse" }; // المُنشئ (فرع ١)
const MGR1 = { userId: 4, branchId: 1, role: "manager" }; // مُعتمِد فرع ١
const MGR2 = { userId: 5, branchId: 2, role: "manager" }; // مدير فرع ٢ (لاختبار عزل الفرع)
const ADMIN = { userId: 1, branchId: 1, role: "admin" };

const TABLES = [
  "auditLogs",
  "accountingEntries",
  "stockAdjustmentRequests",
  "inventoryMovements",
  "branchStock",
  "productVariants",
  "products",
  "users",
  "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
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
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "u_admin", name: "المدير", role: "admin", branchId: 1 },
    { id: 2, openId: "u_wh1", name: "مخزن ف١", role: "warehouse", branchId: 1 },
    { id: 4, openId: "u_mgr1", name: "مدير ف١", role: "manager", branchId: 1 },
    { id: 5, openId: "u_mgr2", name: "مدير ف٢", role: "manager", branchId: 2 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "ورق A4" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PAPER-A4", variantName: "عادي", costPrice: "5.00" });
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 20 }]);
}
beforeEach(async () => {
  await reset();
  await seed();
});

async function stockOf(variantId: number, branchId: number) {
  const [r] = await db().select({ q: s.branchStock.quantity }).from(s.branchStock).where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId)));
  return Number(r?.q ?? 0);
}

describe("تسوية المخزون بفصل مهام (#٦ الشريحة ٢)", () => {
  it("الطلب يُنشئ صفّاً معلَّقاً بلا تغيير مخزون", async () => {
    const { requestId } = await requestStockAdjustment({ variantId: 1, branchId: 1, targetQuantity: 15, notes: "جرد" }, WH1);
    expect(await stockOf(1, 1)).toBe(20); // لا تغيير
    const [row] = await db().select().from(s.stockAdjustmentRequests).where(eq(s.stockAdjustmentRequests.id, requestId));
    expect(row.status).toBe("PENDING_APPROVAL");
    expect(row.targetQuantity).toBe(15);
    expect(Number(row.createdBy)).toBe(2);
    // لا قيد ADJUST بعد.
    const ents = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "ADJUST"));
    expect(ents.length).toBe(0);
  });

  it("اعتماد مديرٍ آخر (SOD) يطبّق المخزون + قيد ADJUST", async () => {
    const { requestId } = await requestStockAdjustment({ variantId: 1, branchId: 1, targetQuantity: 15 }, WH1);
    const res = await approveStockAdjustment(requestId, MGR1);
    expect(res.delta).toBe(-5);
    expect(await stockOf(1, 1)).toBe(15);
    const [row] = await db().select().from(s.stockAdjustmentRequests).where(eq(s.stockAdjustmentRequests.id, requestId));
    expect(row.status).toBe("APPROVED");
    expect(Number(row.approvedBy)).toBe(4);
    expect(Number(row.appliedMovementId)).toBe(res.movementId);
    const ents = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "ADJUST"));
    expect(ents.length).toBe(1);
    expect(String(ents[0].dedupeKey)).toBe(`INV_ADJUST:${res.movementId}`);
  });

  it("المُنشئ لا يعتمد طلبه بنفسه (SOD-04)", async () => {
    const { requestId } = await requestStockAdjustment({ variantId: 1, branchId: 1, targetQuantity: 15 }, WH1);
    await expect(approveStockAdjustment(requestId, WH1)).rejects.toThrow(/فصل المهام/);
    expect(await stockOf(1, 1)).toBe(20); // لا تغيير
  });

  it("مدير فرعٍ آخر لا يعتمد تسوية فرعٍ ليس فرعه (عزل الفرع)", async () => {
    const { requestId } = await requestStockAdjustment({ variantId: 1, branchId: 1, targetQuantity: 15 }, WH1);
    await expect(approveStockAdjustment(requestId, MGR2)).rejects.toThrow(/فرعٍ آخر/);
  });

  it("الرفض يُنهي الطلب بلا أثر مخزون", async () => {
    const { requestId } = await requestStockAdjustment({ variantId: 1, branchId: 1, targetQuantity: 15 }, WH1);
    await rejectStockAdjustment(requestId, MGR1, "خطأ في الإدخال");
    expect(await stockOf(1, 1)).toBe(20);
    const [row] = await db().select().from(s.stockAdjustmentRequests).where(eq(s.stockAdjustmentRequests.id, requestId));
    expect(row.status).toBe("REJECTED");
    expect(row.rejectionReason).toBe("خطأ في الإدخال");
  });

  it("لا يُعتمَد طلبٌ محسوم مسبقاً (لا ازدواج)", async () => {
    const { requestId } = await requestStockAdjustment({ variantId: 1, branchId: 1, targetQuantity: 15 }, WH1);
    await approveStockAdjustment(requestId, MGR1);
    await expect(approveStockAdjustment(requestId, MGR1)).rejects.toThrow(/انتظار الموافقة/);
  });

  it("admin يعتمد طلبه بنفسه (مُستثنى للتصحيح الإداري)", async () => {
    const { requestId } = await requestStockAdjustment({ variantId: 1, branchId: 1, targetQuantity: 25 }, ADMIN);
    const res = await approveStockAdjustment(requestId, ADMIN);
    expect(res.delta).toBe(5);
    expect(await stockOf(1, 1)).toBe(25);
  });

  it("القائمة تُظهر المعلَّق مع اسم الصنف والرصيد الحاليّ", async () => {
    await requestStockAdjustment({ variantId: 1, branchId: 1, targetQuantity: 15 }, WH1);
    const list = await listStockAdjustmentRequests({ branchId: 1, status: "PENDING_APPROVAL" });
    expect(list.length).toBe(1);
    expect(list[0].productName).toBe("ورق A4");
    expect(Number(list[0].currentQuantity)).toBe(20);
    expect(list[0].createdByName).toBe("مخزن ف١");
  });
});
