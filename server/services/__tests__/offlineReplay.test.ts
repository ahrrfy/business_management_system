/**
 * اختبارات إعادة تشغيل البيع الأوفلايني (الشريحة ٣ من خطة الأوفلاين) — offline.replaySale:
 *  1) الترحيل السعيد: فاتورة INV رسمية موسومة originatedOffline + الرقم المؤقّت + capturedAt،
 *     قيد SALE واحد، خصم مخزون، حالة PAID.
 *  2) idempotency: إرسال مزدوج بنفس clientRequestId ⇒ فاتورة واحدة وخصم مخزون واحد.
 *  3) تجاوز المخزون: البيع يُسجَّل والرصيد يهبط سالباً (قرار مالك: سالب موسوم لا رفض).
 *  4) نافذة الالتقاط: مستقبلي/أقدم من ٧٢ ساعة ⇒ PRECONDITION_FAILED (يُعلَّق لدى العميل).
 *  5) نقدي فقط + تحت التكلفة FORBIDDEN + وردية مغلقة BAD_REQUEST.
 *  6) عزل الفرع في الراوتر: كاشير فرع ٢ يُجبَر على فرعه مهما مرّر.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { replayOfflineSale, type ReplayOfflineSaleInput } from "../offline/replaySale";

const TABLES = [
  "idempotencyKeys",
  "auditLogs",
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
    { id: 2, openId: "local_cashier1", name: "كاشير ف١", email: "c1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_cashier2", name: "كاشير ف٢", email: "c2@t.test", role: "cashier", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "قلم جاف أزرق" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "PEN-1", costPrice: "100.00" }]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "100000017" },
  ]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "250.00" }]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 10 },
    { variantId: 1, branchId: 2, quantity: 10 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "زبون نقدي", defaultPriceTier: "RETAIL", currentBalance: "0" }]);
  // ورديتان مفتوحتان: كاشير ف١ (id=1) وكاشير ف٢ (id=2).
  await d.insert(s.shifts).values([
    { id: 1, userId: 2, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "2:1", openingBalance: "0" },
    { id: 2, userId: 3, branchId: 2, status: "OPEN", openedAt: new Date(), openGuard: "3:2", openingBalance: "0" },
  ]);
}

function makeCtx(user: unknown) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as never;
}
async function userById(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}

const cashier1 = { userId: 2, branchId: 1, role: "cashier" } as const;

/** التقاط قبل ساعة — داخل النافذة دائماً. */
const capturedAgoIso = (ms = 60 * 60 * 1000) => new Date(Date.now() - ms).toISOString();

function baseInput(overrides?: Partial<ReplayOfflineSaleInput>): ReplayOfflineSaleInput {
  return {
    branchId: 1,
    shiftId: 1,
    priceTier: "RETAIL",
    lines: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPriceOverride: "250.00" }],
    payment: { amount: "500.00", method: "CASH" },
    clientRequestId: "offline-11111111-aaaa",
    capturedAt: capturedAgoIso(),
    offlineReceiptNumber: "OFF-1-ab12-5",
    deviceId: "ab12",
    ...overrides,
  };
}

beforeEach(async () => { await reset(); await seed(); });

describe("replayOfflineSale — الترحيل السعيد والوسم", () => {
  it("يُصدر فاتورة رسمية INV موسومة originatedOffline بالرقم المؤقّت وcapturedAt وPAID", async () => {
    const res = await replayOfflineSale(baseInput(), cashier1);
    expect(res.invoiceNumber.startsWith("INV-1-")).toBe(true);
    expect(res.status).toBe("PAID");
    expect(res.idempotentReplay).toBeUndefined();

    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, res.invoiceId)))[0];
    expect(!!inv.originatedOffline).toBe(true);
    expect(inv.offlineReceiptNumber).toBe("OFF-1-ab12-5");
    expect(inv.capturedAt).not.toBeNull();
    expect(inv.sourceId).toBe("offline-11111111-aaaa");
    expect(inv.sourceType).toBe("POS");

    // قيد SALE واحد بحارس dedupeKey البنيوي + خصم المخزون.
    const entries = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `SALE:${res.invoiceId}`));
    expect(entries).toHaveLength(1);
    const stock = (await db().select().from(s.branchStock)
      .where(eq(s.branchStock.variantId, 1)))[0];
    void stock; // الفرعان — نفحص فرع ١ أدناه بدقة
    const stock1 = (await db().select().from(s.branchStock))
      .find((r) => Number(r.branchId) === 1)!;
    expect(Number(stock1.quantity)).toBe(8);
  });

  it("idempotency: إرسال مزدوج بنفس المفتاح ⇒ فاتورة واحدة وخصم مخزون واحد", async () => {
    const input = baseInput();
    const r1 = await replayOfflineSale(input, cashier1);
    const r2 = await replayOfflineSale(input, cashier1);
    expect(r2.idempotentReplay).toBe(true);
    expect(r2.invoiceId).toBe(r1.invoiceId);
    const count = await db().select({ c: sql<number>`count(*)` }).from(s.invoices);
    expect(Number(count[0].c)).toBe(1);
    const stock1 = (await db().select().from(s.branchStock))
      .find((r) => Number(r.branchId) === 1)!;
    expect(Number(stock1.quantity)).toBe(8); // خُصم مرة واحدة فقط
  });

  it("تجاوز المخزون: بيع ١٥ من رصيد ١٠ يُسجَّل والرصيد يهبط إلى -٥ (سالب موسوم، لا رفض)", async () => {
    const res = await replayOfflineSale(
      baseInput({
        lines: [{ variantId: 1, productUnitId: 1, quantity: "15", unitPriceOverride: "250.00" }],
        payment: { amount: "3750.00", method: "CASH" },
        clientRequestId: "offline-oversell-1",
        offlineReceiptNumber: "OFF-1-ab12-6",
      }),
      cashier1,
    );
    expect(res.status).toBe("PAID");
    const stock1 = (await db().select().from(s.branchStock))
      .find((r) => Number(r.branchId) === 1)!;
    expect(Number(stock1.quantity)).toBe(-5);
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, res.invoiceId)))[0];
    expect(!!inv.originatedOffline).toBe(true); // الوسم = مدخل تقرير المراجعة
  });
});

describe("replayOfflineSale — نافذة الالتقاط والحرّاس", () => {
  it("capturedAt أقدم من ٧٢ ساعة ⇒ PRECONDITION_FAILED (يُعلَّق للمراجعة)", async () => {
    await expect(
      replayOfflineSale(baseInput({ capturedAt: capturedAgoIso(73 * 60 * 60 * 1000) }), cashier1),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("capturedAt مستقبلي بأكثر من سماحية ٥ دقائق ⇒ PRECONDITION_FAILED", async () => {
    await expect(
      replayOfflineSale(baseInput({ capturedAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }), cashier1),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("انحراف ساعة بسيط (مستقبلي بدقيقتين) ضمن السماحية ⇒ يُقبل", async () => {
    const res = await replayOfflineSale(
      baseInput({ capturedAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(), clientRequestId: "offline-skew-1", offlineReceiptNumber: "OFF-1-ab12-7" }),
      cashier1,
    );
    expect(res.status).toBe("PAID");
  });

  it("طريقة دفع غير نقدية ⇒ BAD_REQUEST (الأوفلاين نقدي فقط)", async () => {
    await expect(
      replayOfflineSale(
        baseInput({ payment: { amount: "500.00", method: "CARD" as never } }),
        cashier1,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("سعر ملتقَط تحت التكلفة بلا سلطة ⇒ FORBIDDEN (يُعلَّق لمراجعة المدير)", async () => {
    await expect(
      replayOfflineSale(
        baseInput({
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "50.00" }],
          payment: { amount: "50.00", method: "CASH" },
          clientRequestId: "offline-belowcost-1",
        }),
        cashier1,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("وردية مغلقة ⇒ BAD_REQUEST (ش٤ ستضيف مسار المزامنة المتأخرة الموسوم)", async () => {
    await db().update(s.shifts).set({ status: "CLOSED", openGuard: null }).where(eq(s.shifts.id, 1));
    await expect(replayOfflineSale(baseInput(), cashier1)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("offline.replaySale (راوتر) — عزل الفرع", () => {
  it("كاشير فرع ٢ يمرّر branchId=1 ⇒ يُجبَر على فرعه ٢ (لا IDOR)", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(3)));
    const res = await caller.offline.replaySale({
      branchId: 1, // ادّعاء فرع آخر
      shiftId: 2, // وردية كاشير ف٢ نفسه
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "250.00" }],
      payment: { amount: "250.00", method: "CASH" },
      clientRequestId: "offline-idor-1",
      capturedAt: capturedAgoIso(),
      offlineReceiptNumber: "OFF-2-cd34-1",
    });
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, res.invoiceId)))[0];
    expect(Number(inv.branchId)).toBe(2); // فرعه الفعلي لا المُدّعى
    // المخزون خُصم من فرعه هو.
    const stock2 = (await db().select().from(s.branchStock)).find((r) => Number(r.branchId) === 2)!;
    expect(Number(stock2.quantity)).toBe(9);
  });
});
