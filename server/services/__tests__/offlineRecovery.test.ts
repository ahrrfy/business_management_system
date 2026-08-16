import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

/**
 * المسار و-٤ من ورقة الإصلاحات (١٦/٨): «بيعٌ أوفلاينيّ محتجَز خارج الدفتر».
 *
 * الزبون دفع نقداً والبضاعة خرجت من الرفّ، ثم وصل البيع بعد إغلاق الوردية فرفضه الخادم
 * ولم يكتب شيئاً — والعنصر بقي في طابور الجهاز وحده. مسحُ بيانات المتصفّح = ضياع الإيراد
 * والمخزون والنقد نهائياً، بلا أن يعلم أحد.
 *
 * الثابت المطلوب: **الرفض يُوثَّق خادمياً لحظته**، ويبقى للمدير مسارُ ترحيلٍ مُدقَّق.
 */

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function makeCtx(user: any) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}

const CASHIER = 41;
const MANAGER = 42;

async function user(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}

function saleInput(over: Record<string, unknown> = {}) {
  return {
    branchId: 1,
    lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "1000" }],
    payment: { amount: "1000", method: "CASH" as const },
    clientRequestId: "offline-recovery-1",
    capturedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    offlineReceiptNumber: "OFF-1-dev1-1",
    deviceId: "dev1",
    shiftId: 1,
    ...over,
  };
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "offlineRecoveryItems", "auditLogs", "accountingEntries", "receipts", "invoiceItems",
    "invoices", "inventoryMovements", "branchStock", "productUnits", "productVariants",
    "products", "shifts", "users", "branches",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values({ id: 1, name: "Main", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: CASHIER, openId: "or-cashier", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: MANAGER, openId: "or-manager", name: "مدير", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "قلم", categoryId: null });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN", costPrice: "500" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 50 });
  // وردية **مغلقة**: هي بالضبط الحالة التي كانت تبتلع البيع.
  await d.insert(s.shifts).values({
    id: 1, branchId: 1, userId: CASHIER, openingBalance: "0",
    status: "CLOSED", closedAt: new Date(),
  });
});

describe("المسار و-٤ — استرداد البيع الأوفلاينيّ المحتجَز", () => {
  it("الرفض لوردية مغلقة يُوثَّق خادمياً بدل أن يضيع على الجهاز", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(cashier.offline.replaySale(saleInput())).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    // الثابت: لا فاتورة (الإقفال حدٌّ محاسبيّ) — **لكن** العنصر محفوظٌ خادمياً.
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    const parked = await db().select().from(s.offlineRecoveryItems);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      offlineReceiptNumber: "OFF-1-dev1-1",
      recoveryStatus: "PENDING",
      branchId: 1,
    });
  });

  it("إعادة محاولة الجهاز لا تُضاعف العنصر", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    for (let i = 0; i < 3; i++) {
      await expect(cashier.offline.replaySale(saleInput())).rejects.toBeTruthy();
    }
    expect(await db().select().from(s.offlineRecoveryItems)).toHaveLength(1);
  });

  it("المدير يرى الطابور ويُرحّل العنصر إلى وردية مفتوحة فيدخل الدفتر", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(cashier.offline.replaySale(saleInput())).rejects.toBeTruthy();

    await db().insert(s.shifts).values({
      id: 2, branchId: 1, userId: MANAGER, openingBalance: "0", status: "OPEN", shiftType: "RETAIL",
    });

    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));
    const queue = await manager.offline.recoveryQueue();
    expect(queue).toHaveLength(1);

    const posted = await manager.offline.postRecoveryItem({ id: queue[0].id, targetShiftId: 2 });
    expect(posted.invoiceId).toBeGreaterThan(0);

    const invoices = await db().select().from(s.invoices);
    expect(invoices).toHaveLength(1);
    // الرقم الأوفلاينيّ المطبوع للزبون يبقى مربوطاً بالفاتورة (رابط الاحتجاز بالدفتر).
    expect(invoices[0].offlineReceiptNumber).toBe("OFF-1-dev1-1");

    const row = (await db().select().from(s.offlineRecoveryItems))[0];
    expect(row.recoveryStatus).toBe("POSTED");
    expect(Number(row.invoiceId)).toBe(Number(invoices[0].id));
  });

  it("الفاتورة تُنسَب للكاشير الملتقِط لا للمدير المُراجِع (وعاء العمولة)", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(cashier.offline.replaySale(saleInput())).rejects.toBeTruthy();
    await db().insert(s.shifts).values({
      id: 2, branchId: 1, userId: MANAGER, openingBalance: "0", status: "OPEN", shiftType: "RETAIL",
    });
    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));
    const queue = await manager.offline.recoveryQueue();
    const posted = await manager.offline.postRecoveryItem({ id: queue[0].id, targetShiftId: 2 });

    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, posted.invoiceId)))[0];
    // محرّك العمولات ينسب بـcreatedBy ⇒ لولا الإعادة لتحوّلت عمولة الكاشير إلى المدير.
    expect(Number(inv.createdBy)).toBe(CASHIER);
    expect(inv.salespersonNameSnapshot).toBe("كاشير");
  });

  it("لا يُرحَّل بيع التجزئة إلى وردية استقبال/طباعة", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(cashier.offline.replaySale(saleInput())).rejects.toBeTruthy();
    await db().insert(s.shifts).values({
      id: 3, branchId: 1, userId: MANAGER, openingBalance: "0", status: "OPEN", shiftType: "RECEPTION",
    });
    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));
    const queue = await manager.offline.recoveryQueue();
    await expect(
      manager.offline.postRecoveryItem({ id: queue[0].id, targetShiftId: 3 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // ويبقى العنصر معلّقاً للمحاولة الصحيحة — لا يُستهلك بالرفض.
    expect((await manager.offline.recoveryQueue())).toHaveLength(1);
  });

  it("الكاشير لا يُرحّل ولا يرى الطابور", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(cashier.offline.recoveryQueue()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("الترحيل مرّةً واحدة — إعادة الترحيل لا تُنشئ فاتورة ثانية", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(cashier.offline.replaySale(saleInput())).rejects.toBeTruthy();
    await db().insert(s.shifts).values({
      id: 2, branchId: 1, userId: MANAGER, openingBalance: "0", status: "OPEN", shiftType: "RETAIL",
    });
    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));
    const queue = await manager.offline.recoveryQueue();
    await manager.offline.postRecoveryItem({ id: queue[0].id, targetShiftId: 2 });
    await expect(
      manager.offline.postRecoveryItem({ id: queue[0].id, targetShiftId: 2 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(s.invoices)).toHaveLength(1);
  });

  it("الإهمال يتطلّب سبباً ويُكتب في التدقيق", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(cashier.offline.replaySale(saleInput())).rejects.toBeTruthy();
    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));
    const queue = await manager.offline.recoveryQueue();

    await manager.offline.discardRecoveryItem({ id: queue[0].id, reason: "إيصال تجريبيّ من جهاز الفحص" });
    const row = (await db().select().from(s.offlineRecoveryItems))[0];
    expect(row.recoveryStatus).toBe("DISCARDED");

    const logs = await db().select().from(s.auditLogs);
    expect(logs.some((l) => l.action === "offline.recovery.discard")).toBe(true);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
  });
});
