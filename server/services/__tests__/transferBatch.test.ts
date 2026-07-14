import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

/**
 * اختبارات سند التحويل متعدد الأسطر (inventory.transferBatch):
 *  - ينقل عدّة أصناف بين فرعين ذرّياً (كل الأسطر أو لا شيء).
 *  - فشل أي سطر (نقص مخزون) يُرجِع كل السند (لا تحويل جزئي).
 *  - عزل الفرع: warehouse لا يحوّل من فرع ليس فرعه.
 *  - يرفض الصنف المكرّر ونفس الفرع مصدراً ووجهة.
 */
const TABLES = ["auditLogs", "idempotencyKeys", "stockTransferLines", "stockTransfers", "inventoryMovements", "branchStock", "productVariants", "products", "users", "branches"];

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
    { id: 1, openId: "local_admin", name: "المدير", email: "admin@t.test", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_wh2", name: "مخزن ف٢", email: "wh2@t.test", role: "warehouse", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "ورق A4" }, { id: 2, name: "قلم" }]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PAP-1", costPrice: "5.00" },
    { id: 2, productId: 2, sku: "PEN-1", costPrice: "1.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 20 },
    { variantId: 2, branchId: 1, quantity: 10 },
    { variantId: 1, branchId: 2, quantity: 5 },
  ]);
}
function makeCtx(user: any) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}
async function stockOf(variantId: number, branchId: number): Promise<number> {
  const r = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId))).limit(1))[0];
  return r ? Number(r.quantity) : 0;
}
async function admin() { return (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0]; }
async function wh2() { return (await db().select().from(s.users).where(eq(s.users.id, 3)).limit(1))[0]; }

beforeEach(async () => { await reset(); await seed(); });

describe("inventory.transferBatch", () => {
  it("خطوتان: الإنشاء يخصم المصدر ويضع السند «بالطريق»، والاستلام المطابق يضيف للوجهة", async () => {
    const caller = appRouter.createCaller(makeCtx(await admin()));
    const r = await caller.inventory.transferBatch({
      fromBranchId: 1, toBranchId: 2, reason: "REBALANCE",
      items: [{ variantId: 1, baseQuantity: 8 }, { variantId: 2, baseQuantity: 4 }],
    });
    expect(r.lines).toBe(2);
    expect(r.transferNumber).toMatch(/^TRF-/);
    // بعد الإرسال: المصدر مخصوم والوجهة لم تتغيّر (البضاعة بالطريق — لا تُباع مرّتين).
    expect(await stockOf(1, 1)).toBe(12); // 20-8
    expect(await stockOf(1, 2)).toBe(5);  // لم تصل بعد
    expect(await stockOf(2, 1)).toBe(6);  // 10-4
    expect(await stockOf(2, 2)).toBe(0);

    // الاستلام المطابق في الفرع الوجهة (warehouse ف٢) يضيف الكميات كاملة ويقفل السند.
    const receiver = appRouter.createCaller(makeCtx(await wh2()));
    const doc = await receiver.inventory.transferGet({ id: r.transferId });
    expect(doc.status).toBe("IN_TRANSIT");
    await receiver.inventory.transferReceive({
      transferId: r.transferId,
      lines: doc.lines.map((l: any) => ({ lineId: Number(l.id), quantityReceived: l.quantitySent })),
    });
    expect(await stockOf(1, 2)).toBe(13); // 5+8
    expect(await stockOf(2, 2)).toBe(4);  // 0+4
    const after = await receiver.inventory.transferGet({ id: r.transferId });
    expect(after.status).toBe("RECEIVED");
    expect(Number(after.totalReceivedBase)).toBe(12);
  });

  it("ذرّية: فشل سطر (نقص مخزون) يُرجِع كل السند", async () => {
    const caller = appRouter.createCaller(makeCtx(await admin()));
    await expect(caller.inventory.transferBatch({
      fromBranchId: 1, toBranchId: 2,
      items: [{ variantId: 1, baseQuantity: 5 }, { variantId: 2, baseQuantity: 999 }], // السطر الثاني يتجاوز المتاح
    })).rejects.toThrow();
    // لا تحويل جزئي: الصنف الأول لم يُخصم.
    expect(await stockOf(1, 1)).toBe(20);
    expect(await stockOf(1, 2)).toBe(5);
    expect(await stockOf(2, 1)).toBe(10);
  });

  it("عزل الفرع: warehouse لا يحوّل من فرع ليس فرعه", async () => {
    const caller = appRouter.createCaller(makeCtx(await wh2())); // فرعه 2، يحاول المصدر 1
    await expect(caller.inventory.transferBatch({
      fromBranchId: 1, toBranchId: 2, items: [{ variantId: 1, baseQuantity: 1 }],
    })).rejects.toThrow(/فرعك|FORBIDDEN/);
  });

  it("يرفض الصنف المكرّر في السند", async () => {
    const caller = appRouter.createCaller(makeCtx(await admin()));
    await expect(caller.inventory.transferBatch({
      fromBranchId: 1, toBranchId: 2,
      items: [{ variantId: 1, baseQuantity: 1 }, { variantId: 1, baseQuantity: 2 }],
    })).rejects.toThrow(/مكرّر/);
  });

  it("يرفض نفس الفرع مصدراً ووجهة", async () => {
    const caller = appRouter.createCaller(makeCtx(await admin()));
    await expect(caller.inventory.transferBatch({
      fromBranchId: 1, toBranchId: 1, items: [{ variantId: 1, baseQuantity: 1 }],
    })).rejects.toThrow(/نفس الفرع/);
  });
});
