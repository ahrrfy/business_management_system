import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

/**
 * تحويلات المخزون بخطوتين (١٤/٧/٢٠٢٦) — ثوابت النظام:
 *  I1: الإرسال يخصم المصدر فوراً؛ «بالطريق» لا يظهر في رصيد أي فرع.
 *  I2: الاستلام الجزئي يضيف المستلَم فقط؛ العجز موثَّق على السطر وملاحظته إلزامية.
 *  I3: مجموع مخزون النظام بعد استلام بعجز = الأصل − العجز (خسارة نقل حقيقية).
 *  I4: الإلغاء يعيد الكمية كاملة للمصدر ويغلق السند.
 *  I5: عزل الفرع — الاستلام حصريّ للوجهة والإلغاء حصريّ للمصدر (غير المرفوعين).
 *  I6: لا استلام/إلغاء مزدوج (سند مقفل يرفض)، والاستلام idempotent بالمفتاح.
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
    { id: 3, name: "ثالث", code: "third", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "المدير", email: "admin@t.test", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_wh1", name: "مخزن ف١", email: "wh1@t.test", role: "warehouse", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_wh2", name: "مخزن ف٢", email: "wh2@t.test", role: "warehouse", loginMethod: "local", branchId: 2 },
    { id: 4, openId: "local_wh3", name: "مخزن ف٣", email: "wh3@t.test", role: "warehouse", loginMethod: "local", branchId: 3 },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "ورق A4" }, { id: 2, name: "قلم" }]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PAP-1", costPrice: "5.00" },
    { id: 2, productId: 2, sku: "PEN-1", costPrice: "1.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 20 },
    { variantId: 2, branchId: 1, quantity: 10 },
  ]);
}
function makeCtx(user: any) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}
async function userById(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}
async function stockOf(variantId: number, branchId: number): Promise<number> {
  const r = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId))).limit(1))[0];
  return r ? Number(r.quantity) : 0;
}
async function systemStock(variantId: number): Promise<number> {
  const rows = await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, variantId));
  return rows.reduce((a, r) => a + Number(r.quantity), 0);
}
/** ينشئ سنداً قياسياً (٨ ورق + ٤ قلم) من ف١ إلى ف٢ بواسطة الأدمن ويعيد السند بأسطره. */
async function createStd() {
  const admin = appRouter.createCaller(makeCtx(await userById(1)));
  const r = await admin.inventory.transferBatch({
    fromBranchId: 1, toBranchId: 2, reason: "STOCKOUT",
    items: [{ variantId: 1, baseQuantity: 8 }, { variantId: 2, baseQuantity: 4 }],
  });
  const doc = await admin.inventory.transferGet({ id: r.transferId });
  return { r, doc, admin };
}

beforeEach(async () => { await reset(); await seed(); });

describe("I1: الإرسال ⇒ بالطريق (لا يظهر في رصيد أي فرع)", () => {
  it("يخصم المصدر فوراً ولا يضيف للوجهة، والسند IN_TRANSIT بمجاميع صحيحة", async () => {
    const { doc } = await createStd();
    expect(doc.status).toBe("IN_TRANSIT");
    expect(Number(doc.totalSentBase)).toBe(12);
    expect(doc.totalReceivedBase).toBeNull();
    expect(doc.lines).toHaveLength(2);
    expect(await stockOf(1, 1)).toBe(12);
    expect(await stockOf(1, 2)).toBe(0);
    // مجموع النظام نقص بقدر ما بالطريق — البضاعة غير قابلة للبيع في أي فرع أثناء النقل.
    expect(await systemStock(1)).toBe(12);
  });

  it("شارة الوارد بالطريق تُحصي لوجهة الفرع فقط", async () => {
    await createStd();
    const wh2 = appRouter.createCaller(makeCtx(await userById(3)));
    const wh1 = appRouter.createCaller(makeCtx(await userById(2)));
    expect(await wh2.inventory.transfersPendingIncoming()).toBe(1);
    expect(await wh1.inventory.transfersPendingIncoming()).toBe(0);
  });
});

describe("I2+I3: الاستلام الجزئي والعجز الموثَّق", () => {
  it("استلام 6 من 8 بملاحظة ⇒ الوجهة +6، العجز 2 على السطر، ومجموع النظام نقص به", async () => {
    const { r, doc } = await createStd();
    const wh2 = appRouter.createCaller(makeCtx(await userById(3)));
    const l1 = doc.lines.find((l: any) => Number(l.variantId) === 1)!;
    const l2 = doc.lines.find((l: any) => Number(l.variantId) === 2)!;
    const res = await wh2.inventory.transferReceive({
      transferId: r.transferId,
      lines: [
        { lineId: Number(l1.id), quantityReceived: 6, note: "كرتونان تالفان أثناء النقل" },
        { lineId: Number(l2.id), quantityReceived: 4 },
      ],
    });
    expect(res.discrepancyUnits).toBe(2);
    expect(await stockOf(1, 2)).toBe(6);
    expect(await stockOf(2, 2)).toBe(4);
    // I3: النظام كله فقد 2 من الورق فعلاً (12 بالمصدر + 6 بالوجهة = 18 من أصل 20).
    expect(await systemStock(1)).toBe(18);
    const after = await wh2.inventory.transferGet({ id: r.transferId });
    expect(after.status).toBe("RECEIVED");
    expect(Number(after.totalReceivedBase)).toBe(10);
    const afterL1 = after.lines.find((l: any) => Number(l.variantId) === 1)!;
    expect(Number(afterL1.quantityReceived)).toBe(6);
    expect(afterL1.note).toContain("تالف");
  });

  it("سطر بفارق بلا ملاحظة ⇒ رفض، ولا كتابة جزئية", async () => {
    const { r, doc } = await createStd();
    const wh2 = appRouter.createCaller(makeCtx(await userById(3)));
    await expect(
      wh2.inventory.transferReceive({
        transferId: r.transferId,
        lines: doc.lines.map((l: any, i: number) => ({ lineId: Number(l.id), quantityReceived: i === 0 ? 1 : Number(l.quantitySent) })),
      })
    ).rejects.toThrow(/ملاحظة/);
    expect(await stockOf(1, 2)).toBe(0);
    expect((await db().select().from(s.stockTransfers))[0].status).toBe("IN_TRANSIT");
  });

  it("يرفض استلاماً فوق المرسَل أو بأسطر ناقصة", async () => {
    const { r, doc } = await createStd();
    const wh2 = appRouter.createCaller(makeCtx(await userById(3)));
    const l1 = doc.lines[0];
    await expect(
      wh2.inventory.transferReceive({
        transferId: r.transferId,
        lines: [{ lineId: Number(l1.id), quantityReceived: Number(l1.quantitySent) + 1 }],
      })
    ).rejects.toThrow();
    await expect(
      wh2.inventory.transferReceive({
        transferId: r.transferId,
        lines: [{ lineId: Number(l1.id), quantityReceived: Number(l1.quantitySent) }],
      })
    ).rejects.toThrow(/كل أسطر/);
  });
});

describe("I4: الإلغاء يعيد الكمية للمصدر", () => {
  it("إلغاء سند بالطريق يعيد الرصيد كاملاً ويغلقه CANCELLED", async () => {
    const { r, admin } = await createStd();
    expect(await stockOf(1, 1)).toBe(12);
    await admin.inventory.transferCancel({ transferId: r.transferId });
    expect(await stockOf(1, 1)).toBe(20);
    expect(await stockOf(2, 1)).toBe(10);
    expect(await stockOf(1, 2)).toBe(0);
    const doc = (await db().select().from(s.stockTransfers))[0];
    expect(doc.status).toBe("CANCELLED");
  });

  it("سند ملغى يرفض الاستلام، وسند مستلَم يرفض الإلغاء", async () => {
    const { r, doc, admin } = await createStd();
    const wh2 = appRouter.createCaller(makeCtx(await userById(3)));
    await admin.inventory.transferCancel({ transferId: r.transferId });
    await expect(
      wh2.inventory.transferReceive({
        transferId: r.transferId,
        lines: doc.lines.map((l: any) => ({ lineId: Number(l.id), quantityReceived: Number(l.quantitySent) })),
      })
    ).rejects.toThrow(/لا تقبل الاستلام|ليس بالطريق/);

    const second = await createStd();
    await wh2.inventory.transferReceive({
      transferId: second.r.transferId,
      lines: second.doc.lines.map((l: any) => ({ lineId: Number(l.id), quantityReceived: Number(l.quantitySent) })),
    });
    await expect(admin.inventory.transferCancel({ transferId: second.r.transferId })).rejects.toThrow(/بالطريق/);
  });
});

describe("I5: عزل الفرع", () => {
  it("warehouse من غير الفرع الوجهة لا يستلم، ومن غير المصدر لا يلغي", async () => {
    const { r, doc } = await createStd();
    const wh1 = appRouter.createCaller(makeCtx(await userById(2))); // فرع المصدر
    const wh3 = appRouter.createCaller(makeCtx(await userById(4))); // فرع ثالث
    const fullLines = doc.lines.map((l: any) => ({ lineId: Number(l.id), quantityReceived: Number(l.quantitySent) }));
    await expect(wh1.inventory.transferReceive({ transferId: r.transferId, lines: fullLines })).rejects.toThrow(/الوجهة/);
    await expect(wh3.inventory.transferReceive({ transferId: r.transferId, lines: fullLines })).rejects.toThrow(/الوجهة/);
    await expect(wh3.inventory.transferCancel({ transferId: r.transferId })).rejects.toThrow(/المرسل/);
    // ولا يرى سنداً لا يخصّ فرعه إطلاقاً.
    await expect(wh3.inventory.transferGet({ id: r.transferId })).rejects.toThrow(/فرعك/);
  });

  it("القائمة محصورة بفرع غير المرفوع (وارد/صادر)", async () => {
    await createStd();
    const wh3 = appRouter.createCaller(makeCtx(await userById(4)));
    const wh2 = appRouter.createCaller(makeCtx(await userById(3)));
    expect((await wh3.inventory.transfersList({})).rows).toHaveLength(0);
    const inbox = await wh2.inventory.transfersList({ dir: "in", status: "IN_TRANSIT" });
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0].toBranchName).toBe("المبيعات");
  });
});

describe("I6: لا ازدواج", () => {
  it("استلام ثانٍ لنفس السند يرفض (لا تضخيم رصيد الوجهة)", async () => {
    const { r, doc } = await createStd();
    const wh2 = appRouter.createCaller(makeCtx(await userById(3)));
    const fullLines = doc.lines.map((l: any) => ({ lineId: Number(l.id), quantityReceived: Number(l.quantitySent) }));
    await wh2.inventory.transferReceive({ transferId: r.transferId, lines: fullLines });
    await expect(wh2.inventory.transferReceive({ transferId: r.transferId, lines: fullLines })).rejects.toThrow(/لا تقبل الاستلام|ليس بالطريق/);
    expect(await stockOf(1, 2)).toBe(8);
  });

  it("استلام بنفس clientRequestId ⇒ replay صامت بلا حركات إضافية", async () => {
    const { r, doc } = await createStd();
    const wh2 = appRouter.createCaller(makeCtx(await userById(3)));
    const fullLines = doc.lines.map((l: any) => ({ lineId: Number(l.id), quantityReceived: Number(l.quantitySent) }));
    const a = await wh2.inventory.transferReceive({ transferId: r.transferId, lines: fullLines, clientRequestId: "rcv-1" });
    const b = await wh2.inventory.transferReceive({ transferId: r.transferId, lines: fullLines, clientRequestId: "rcv-1" });
    expect(a.idempotentReplay).toBe(false);
    expect(b.idempotentReplay).toBe(true);
    expect(await stockOf(1, 2)).toBe(8);
  });
});
