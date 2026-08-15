import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { truncateTables } from "./__testUtils__";
import { createProduct } from "../catalogService";
import { withTx } from "../tx";
import {
  cancelReservation, convertReservationToSale, createReservation, expireDueReservations,
  extendReservation, readAvailability, releaseReservation,
} from "../reservations";

/**
 * الحجوزات — R-م٣: اختبارات الثوابت الحرجة (§٨ من docs/gifts-reservations-design-2026-07-27.md).
 * حجز ناعم (ATP): لا يمسّ branchStock؛ reservationStock.reservedBase = Σ(المحجوز النشط)؛
 * الإلغاء/الانتهاء يحرّران مرّة واحدة؛ overbook مسموح (ناعم) مع وسم؛ التحويل لوحدة الأساس.
 */

const actor = { userId: 1, branchId: 1, role: "admin" as const };

const TABLES = [
  "onlineOrderItems", "onlineOrders",
  "reservationEvents", "reservationLines", "reservationStock", "reservations",
  "accountingEntries", "receipts", "invoiceItems", "invoices", "idempotencyKeys", "inventoryMovements", "shifts", "openingModeSettings",
  "branchStock", "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "productImages", "products",
  "auditLogs", "customers", "categories", "users", "branches",
];

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set for tests"); return d; }

async function seedBase() {
  await db().insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" },
    { id: 2, openId: "other_cashier", name: "cashier 2", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
}

/** منتج بسيط بوحدة أساس (+درزن اختياري factor 12) ومخزون افتتاحي في الفرع ١. */
async function mkProduct(sku: string, opening: number, withDozen = false) {
  const units: Array<{ unitName: string; conversionFactor: string; isBaseUnit: boolean; prices: Array<{ priceTier: "RETAIL"; price: string }> }> = [
    { unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "1500" }] },
  ];
  if (withDozen) units.push({ unitName: "درزن", conversionFactor: "12", isBaseUnit: false, prices: [{ priceTier: "RETAIL", price: "16000" }] });
  await createProduct({ name: `منتج ${sku}`, variants: [{ sku, costPrice: "1000", openingStock: opening, units }] }, actor);
  const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, sku)))[0];
  const allUnits = await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(v.id)));
  const base = allUnits.find((u) => u.isBaseUnit)!;
  const dozen = allUnits.find((u) => !u.isBaseUnit);
  return { variantId: Number(v.id), baseUnitId: Number(base.id), dozenUnitId: dozen ? Number(dozen.id) : null };
}

/** عميل بلا حدّ ائتمان (creditLimit=null) — يسمح بالتحويل الآجل بلا نقد/وردية. */
async function mkCustomer(name: string) {
  await db().insert(s.customers).values({ name, creditLimit: null });
  const c = (await db().select().from(s.customers).where(eq(s.customers.name, name)))[0];
  return Number(c.id);
}

async function onHand(variantId: number, branchId = 1) {
  const r = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId))))[0];
  return r?.quantity ?? 0;
}
async function reserved(variantId: number, branchId = 1) {
  const r = (await db().select().from(s.reservationStock).where(and(eq(s.reservationStock.variantId, variantId), eq(s.reservationStock.branchId, branchId))))[0];
  return r?.reservedBase ?? 0;
}
const atp = (variantId: number, branchId = 1) => withTx((tx) => readAvailability(tx, variantId, branchId));
function makeCtx(user: unknown) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

describe("الحجوزات R-م٣ — الثوابت الحرجة", () => {
  it("ATP: الحجز يخصم المتاح ولا يمسّ المخزون الفعلي (branchStock ثابت)", async () => {
    const { variantId, baseUnitId } = await mkProduct("RSV-A", 10);
    expect(await onHand(variantId)).toBe(10);

    const res = await createReservation(
      { branchId: 1, contactPhone: "07700000001", lines: [{ variantId, productUnitId: baseUnitId, quantity: 3 }] },
      actor,
    );
    expect(res.reservationNumber).toMatch(/^RES-1-/);
    expect(res.overbookedVariantIds).toHaveLength(0);
    // المخزون الفعليّ لم يتغيّر؛ المحجوز = 3؛ المتاح = 7.
    expect(await onHand(variantId)).toBe(10);
    expect(await reserved(variantId)).toBe(3);
    const a = await atp(variantId);
    expect(a).toMatchObject({ onHand: 10, reserved: 3, available: 7 });
  });

  it("activeAllocations يعرض اسم صاحب الحجز والكمية المتبقية ويعزل فرع الكاشير", async () => {
    const { variantId, baseUnitId } = await mkProduct("RSV-VISIBLE", 10);
    const first = await createReservation(
      {
        branchId: 1,
        contactName: "سارة",
        contactPhone: "07700000011",
        lines: [{ variantId, productUnitId: baseUnitId, quantity: 4 }],
      },
      actor,
    );
    await db()
      .update(s.reservationLines)
      .set({ fulfilledBase: 1 })
      .where(eq(s.reservationLines.reservationId, first.reservationId));
    await createReservation(
      {
        branchId: 2,
        contactName: "باسل",
        contactPhone: "07700000012",
        lines: [{ variantId, productUnitId: baseUnitId, quantity: 2 }],
      },
      actor,
    );

    const cashier = (await db().select().from(s.users).where(eq(s.users.id, 2)).limit(1))[0];
    const rows = await appRouter.createCaller(makeCtx(cashier)).reservations.activeAllocations({ variantIds: [variantId] });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reservationId: first.reservationId,
      variantId,
      customerName: "سارة",
      remainingBase: 3,
    });
  });

  it("reservationStock المجمّع = Σ(المحجوز النشط) عبر عدّة حجوزات", async () => {
    const { variantId, baseUnitId } = await mkProduct("RSV-B", 20);
    await createReservation({ branchId: 1, contactPhone: "07700000002", lines: [{ variantId, productUnitId: baseUnitId, quantity: 3 }] }, actor);
    await createReservation({ branchId: 1, contactPhone: "07700000003", lines: [{ variantId, productUnitId: baseUnitId, quantity: 2 }] }, actor);
    expect(await reserved(variantId)).toBe(5);
    expect((await atp(variantId)).available).toBe(15);
  });

  it("الإنفاذ الناعم: يُسمح بالحجز فوق المتاح مع وسم overbooked (لا رمي)", async () => {
    const { variantId, baseUnitId } = await mkProduct("RSV-C", 5);
    const res = await createReservation({ branchId: 1, contactPhone: "07700000004", lines: [{ variantId, productUnitId: baseUnitId, quantity: 8 }] }, actor);
    expect(res.overbookedVariantIds).toContain(variantId);
    expect(await reserved(variantId)).toBe(8);
    expect(await atp(variantId)).toMatchObject({
      available: 0,
      rawAvailableBase: -3,
      shortfallBase: 3,
    });
  });

  it("ATP الحجز يحتسب تخصيص الطلب الإلكتروني النشط ولا يبيع المتاح نفسه مرتين", async () => {
    const { variantId, baseUnitId } = await mkProduct("RSV-ONLINE-ATP", 10);
    await db().insert(s.customers).values({ id: 91, name: "زبون متجر محجوز له" });
    await db().insert(s.onlineOrders).values({
      id: 91,
      orderNumber: "ORD-RSV-ATP",
      customerId: 91,
      branchId: 1,
      subtotal: "12000.00",
      total: "12000.00",
      status: "CONFIRMED",
    });
    await db().insert(s.onlineOrderItems).values({
      onlineOrderId: 91,
      variantId,
      productUnitId: baseUnitId,
      quantity: "8.000",
      baseQuantity: 8,
      unitPrice: "1500.00",
      total: "12000.00",
    });

    expect(await atp(variantId)).toMatchObject({ onHand: 10, reserved: 8, available: 2 });
    const res = await createReservation({
      branchId: 1,
      contactPhone: "07700000040",
      lines: [{ variantId, productUnitId: baseUnitId, quantity: 5 }],
    }, actor);

    expect(res.overbookedVariantIds).toContain(variantId);
    expect(await reserved(variantId)).toBe(5); // reservationStock يبقى الحجز الرسمي القابل للتحرير فقط
    expect(await atp(variantId)).toMatchObject({
      onHand: 10,
      reserved: 13,
      available: 0,
      rawAvailableBase: -3,
      shortfallBase: 3,
    });
  });

  it("الإلغاء يحرّر المحجوز بالكامل مرّة واحدة (idempotent على الحالة النهائية)", async () => {
    const { variantId, baseUnitId } = await mkProduct("RSV-D", 10);
    const res = await createReservation({ branchId: 1, contactPhone: "07700000005", lines: [{ variantId, productUnitId: baseUnitId, quantity: 4 }] }, actor);
    expect(await reserved(variantId)).toBe(4);

    await cancelReservation(res.reservationId, "طلب العميل", actor);
    expect(await reserved(variantId)).toBe(0);
    expect((await atp(variantId)).available).toBe(10);

    // إعادة الإلغاء على حجز ملغى مرفوضة (FSM) ⇒ لا تحرير مزدوج.
    await expect(cancelReservation(res.reservationId, null, actor)).rejects.toThrow();
    expect(await reserved(variantId)).toBe(0);
  });

  it("التحويل لوحدة الأساس: حجز «درزن» يخصم ١٢ قطعة من المتاح", async () => {
    const { variantId, dozenUnitId } = await mkProduct("RSV-E", 30, true);
    expect(dozenUnitId).not.toBeNull();
    await createReservation({ branchId: 1, contactPhone: "07700000006", lines: [{ variantId, productUnitId: dozenUnitId!, quantity: 1 }] }, actor);
    expect(await reserved(variantId)).toBe(12); // ١ درزن = ١٢ قطعة أساس
    expect((await atp(variantId)).available).toBe(18);
  });

  it("التحرير المديريّ والانتهاء التلقائيّ يحرّران المحجوز", async () => {
    const { variantId, baseUnitId } = await mkProduct("RSV-F", 10);
    const rel = await createReservation({ branchId: 1, contactPhone: "07700000007", lines: [{ variantId, productUnitId: baseUnitId, quantity: 2 }] }, actor);
    await releaseReservation(rel.reservationId, "نفاد مخزنيّ", actor);
    expect(await reserved(variantId)).toBe(0);

    // انتهاء تلقائيّ: حجز بمدّة ساعة ثم تسريع الانتهاء يدوياً عبر تعديل expiresAt للماضي.
    const exp = await createReservation({ branchId: 1, contactPhone: "07700000008", lines: [{ variantId, productUnitId: baseUnitId, quantity: 3 }] }, actor);
    expect(await reserved(variantId)).toBe(3);
    await db().update(s.reservations).set({ expiresAt: new Date(Date.now() - 3_600_000) }).where(eq(s.reservations.id, exp.reservationId));
    const sweep = await expireDueReservations();
    expect(sweep.expired).toBeGreaterThanOrEqual(1);
    expect(await reserved(variantId)).toBe(0);
    const row = (await db().select().from(s.reservations).where(eq(s.reservations.id, exp.reservationId)))[0];
    expect(row.status).toBe("EXPIRED");
  });

  it("التمديد يرفض المدّة خارج [١،٧٢] ويقبل الصالحة", async () => {
    const { variantId, baseUnitId } = await mkProduct("RSV-G", 10);
    const r = await createReservation({ branchId: 1, contactPhone: "07700000009", lines: [{ variantId, productUnitId: baseUnitId, quantity: 1 }] }, actor);
    await expect(extendReservation(r.reservationId, 100, actor)).rejects.toThrow();
    const ext = await extendReservation(r.reservationId, 48, actor);
    expect(new Date(ext.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("التحويل لبيع (آجل بعميل): يخصم المخزون الفعليّ، يحرّر المحجوز، يربط الفاتورة، والمتاح يبقى متسقاً", async () => {
    const cid = await mkCustomer("زبون الحجز");
    const { variantId, baseUnitId } = await mkProduct("RSV-H", 10);
    const r = await createReservation(
      { branchId: 1, customerId: cid, contactPhone: "07700000010", lines: [{ variantId, productUnitId: baseUnitId, quantity: 4 }] },
      actor,
    );
    expect(await reserved(variantId)).toBe(4);
    expect((await atp(variantId)).available).toBe(6); // 10 − 4

    const conv = await convertReservationToSale({ reservationId: r.reservationId, payment: null }, actor);
    expect(conv.invoiceId).toBeGreaterThan(0);
    // البيع خصم branchStock بالمباع (10→6)؛ التحرير خصم reservedBase بالمنفَّذ (4→0) ⇒ المتاح يبقى 6.
    expect(await onHand(variantId)).toBe(6);
    expect(await reserved(variantId)).toBe(0);
    expect((await atp(variantId)).available).toBe(6);
    const row = (await db().select().from(s.reservations).where(eq(s.reservations.id, r.reservationId)))[0];
    expect(row.status).toBe("FULFILLED");
    expect(Number(row.fulfilledInvoiceId)).toBe(conv.invoiceId);
  });

  it("التحويل idempotent: إعادة تحويل حجز منفَّذ مرفوضة (لا خصم مخزون مزدوج)", async () => {
    const cid = await mkCustomer("زبون ٢");
    const { variantId, baseUnitId } = await mkProduct("RSV-I", 10);
    const r = await createReservation(
      { branchId: 1, customerId: cid, contactPhone: "07700000011", lines: [{ variantId, productUnitId: baseUnitId, quantity: 3 }] },
      actor,
    );
    await convertReservationToSale({ reservationId: r.reservationId, payment: null }, actor);
    await expect(convertReservationToSale({ reservationId: r.reservationId, payment: null }, actor)).rejects.toThrow();
    expect(await onHand(variantId)).toBe(7); // خُصم مرّة واحدة (10−3)
  });

  it("أولوية صاحب الحجز: انخفاض ATP بسبب حجز لاحق لا يمنع التحويل ما دام الفعلي يغطيه", async () => {
    const cid = await mkCustomer("صاحب الحجز الأول");
    const { variantId, baseUnitId } = await mkProduct("RSV-PRIORITY", 10);
    const first = await createReservation(
      { branchId: 1, customerId: cid, contactPhone: "07700000013", lines: [{ variantId, productUnitId: baseUnitId, quantity: 4 }] },
      actor,
    );
    await createReservation(
      { branchId: 1, contactPhone: "07700000014", lines: [{ variantId, productUnitId: baseUnitId, quantity: 5 }] },
      actor,
    );
    expect((await atp(variantId)).available).toBe(1);

    const conv = await convertReservationToSale({ reservationId: first.reservationId, payment: null }, actor);
    expect(conv.invoiceId).toBeGreaterThan(0);
    expect(await onHand(variantId)).toBe(6);
    expect(await reserved(variantId)).toBe(5);
    expect((await atp(variantId)).available).toBe(1);
  });

  it("FIFO يمنع الحجز الأحدث من سرقة الأقدم ويعلن عجزه بعد تنفيذ الأقدم", async () => {
    const firstCustomerId = await mkCustomer("صاحب الحجز الأقدم FIFO");
    const secondCustomerId = await mkCustomer("صاحب الحجز الأحدث FIFO");
    const { variantId, baseUnitId } = await mkProduct("RSV-FIFO", 5);
    const first = await createReservation({
      branchId: 1,
      customerId: firstCustomerId,
      contactPhone: "07700000051",
      lines: [{ variantId, productUnitId: baseUnitId, quantity: 4 }],
    }, actor);
    const second = await createReservation({
      branchId: 1,
      customerId: secondCustomerId,
      contactPhone: "07700000052",
      lines: [{ variantId, productUnitId: baseUnitId, quantity: 4 }],
    }, actor);

    await expect(convertReservationToSale({ reservationId: second.reservationId, payment: null }, actor))
      .rejects.toThrow(/مخصّص|الحجوزات|المتاح/);
    expect(await onHand(variantId)).toBe(5);
    expect(await reserved(variantId)).toBe(8);
    expect((await db().select().from(s.reservations).where(eq(s.reservations.id, second.reservationId)))[0]?.status)
      .toBe("ACTIVE");

    const converted = await convertReservationToSale({ reservationId: first.reservationId, payment: null }, actor);
    expect(converted.invoiceId).toBeGreaterThan(0);
    expect(await onHand(variantId)).toBe(1);
    expect(await reserved(variantId)).toBe(4);
    expect((await db().select().from(s.reservations).where(eq(s.reservations.id, first.reservationId)))[0]?.status)
      .toBe("FULFILLED");
    expect((await db().select().from(s.reservations).where(eq(s.reservations.id, second.reservationId)))[0]?.status)
      .toBe("ACTIVE");
    expect(await atp(variantId)).toMatchObject({
      available: 0,
      rawAvailableBase: -3,
      shortfallBase: 3,
    });
  });

  it("تحويل الحجز لا يعفي تخصيص طلب إلكتروني نشط لطرف آخر", async () => {
    const reservationCustomerId = await mkCustomer("صاحب الحجز الرسمي");
    const onlineCustomerId = await mkCustomer("صاحب طلب المتجر");
    const { variantId, baseUnitId } = await mkProduct("RSV-CONVERT-ONLINE", 10);
    await db().insert(s.onlineOrders).values({
      id: 92,
      orderNumber: "ORD-RSV-CONVERT",
      customerId: onlineCustomerId,
      branchId: 1,
      subtotal: "12000.00",
      total: "12000.00",
      status: "CONFIRMED",
    });
    await db().insert(s.onlineOrderItems).values({
      onlineOrderId: 92,
      variantId,
      productUnitId: baseUnitId,
      quantity: "8.000",
      baseQuantity: 8,
      unitPrice: "1500.00",
      total: "12000.00",
    });
    const reservation = await createReservation({
      branchId: 1,
      customerId: reservationCustomerId,
      contactPhone: "07700000041",
      lines: [{ variantId, productUnitId: baseUnitId, quantity: 3 }],
    }, actor);

    await expect(convertReservationToSale({ reservationId: reservation.reservationId, payment: null }, actor))
      .rejects.toThrow(/طلبات المتجر|مخصّص/);
    expect(await onHand(variantId)).toBe(10);
    expect(await reserved(variantId)).toBe(3);
    expect(await atp(variantId)).toMatchObject({
      available: 0,
      rawAvailableBase: -1,
      shortfallBase: 1,
    });
  });

  it("التحويل يرفض المخزون الناقص ذرّياً حتى عند تفعيل سماح السالب في وضع الافتتاح", async () => {
    const cid = await mkCustomer("حجز لا يرث سماح الافتتاح");
    const { variantId, baseUnitId } = await mkProduct("RSV-STRICT-STOCK", 6);
    const r = await createReservation(
      { branchId: 1, customerId: cid, contactPhone: "07700000017", lines: [{ variantId, productUnitId: baseUnitId, quantity: 2 }] },
      actor,
    );
    await db().update(s.branchStock)
      .set({ quantity: 1, openedAt: null })
      .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, 1)));
    await db().insert(s.openingModeSettings).values({
      id: 1,
      enabled: true,
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      maxNegativeQtyPerLine: 10,
      updatedBy: actor.userId,
    });

    await expect(convertReservationToSale({ reservationId: r.reservationId, payment: null }, actor))
      .rejects.toThrow(/المخزون غير كافٍ/);
    expect(await onHand(variantId)).toBe(1);
    expect(await reserved(variantId)).toBe(2);
    const invoices = await db().select({ id: s.invoices.id }).from(s.invoices)
      .where(eq(s.invoices.sourceId, `RES-${r.reservationId}`));
    expect(invoices).toHaveLength(0);
  });

  it("انقضاء الحجز قبل التأكيد يرفض ذرّياً بلا فاتورة أو خصم مخزون", async () => {
    const cid = await mkCustomer("حجز منقضٍ داخل الحوار");
    const { variantId, baseUnitId } = await mkProduct("RSV-EXPIRED-DIALOG", 6);
    const r = await createReservation(
      { branchId: 1, customerId: cid, contactPhone: "07700000015", lines: [{ variantId, productUnitId: baseUnitId, quantity: 2 }] },
      actor,
    );
    await db().update(s.reservations)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(s.reservations.id, r.reservationId));

    await expect(convertReservationToSale({ reservationId: r.reservationId, payment: null }, actor))
      .rejects.toThrow(/انتهت مدّة الحجز/);
    expect(await onHand(variantId)).toBe(6);
    expect(await reserved(variantId)).toBe(2);
    const invoices = await db().select({ id: s.invoices.id }).from(s.invoices)
      .where(eq(s.invoices.sourceId, `RES-${r.reservationId}`));
    expect(invoices).toHaveLength(0);
  });

  it("يثبّت وردية القابض الحالية على الفاتورة والإيصال ويعيدها في نتيجة التحويل", async () => {
    await db().insert(s.shifts).values([
      { branchId: 1, userId: 2, openingBalance: "0", shiftType: "RETAIL", openGuard: "2:1:RETAIL" },
      { branchId: 1, userId: 1, openingBalance: "0", shiftType: "RETAIL", openGuard: "1:1:RETAIL" },
      { branchId: 1, userId: 1, openingBalance: "0", shiftType: "RECEPTION", openGuard: "1:1:RECEPTION" },
    ]);
    const otherShift = (await db().select().from(s.shifts).where(eq(s.shifts.userId, 2)))[0];
    const ownReceptionShift = (await db().select().from(s.shifts).where(and(
      eq(s.shifts.userId, actor.userId),
      eq(s.shifts.shiftType, "RECEPTION"),
    )))[0];
    const { variantId, baseUnitId } = await mkProduct("RSV-SHIFT", 3);
    const r = await createReservation(
      { branchId: 1, contactPhone: "07700000016", lines: [{ variantId, productUnitId: baseUnitId, quantity: 1 }] },
      actor,
    );

    await expect(convertReservationToSale({
      reservationId: r.reservationId,
      shiftId: null,
      payment: { amount: "1500", method: "CASH" },
    }, actor)).rejects.toThrow(/افتح وردية/);
    await expect(convertReservationToSale({
      reservationId: r.reservationId,
      shiftId: Number(otherShift.id),
      payment: { amount: "1500", method: "CASH" },
    }, actor)).rejects.toThrow(/وردية مساحة العمل/);
    expect(await onHand(variantId)).toBe(3);
    expect(await reserved(variantId)).toBe(1);

    const conv = await convertReservationToSale({
      reservationId: r.reservationId,
      shiftId: Number(ownReceptionShift.id),
      payment: { amount: "1500", method: "CASH" },
    }, actor);
    const invoice = (await db().select().from(s.invoices).where(eq(s.invoices.id, conv.invoiceId)))[0];
    const receipt = (await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, conv.invoiceId)))[0];
    expect(conv.shiftId).toBe(Number(ownReceptionShift.id));
    expect(invoice.shiftId).toBe(Number(ownReceptionShift.id));
    expect(receipt.shiftId).toBe(Number(ownReceptionShift.id));
    expect(receipt.paymentMethod).toBe("CASH");
    expect(receipt.cashBucket).toBe("DRAWER");
  });

  it("تحويل الحجز ببطاقة/تحويل يرفض المرجع الفارغ ويسجّل المرجع الصحيح خارج عدّ النقدية", async () => {
    const { variantId, baseUnitId } = await mkProduct("RSV-PAY-REF", 5);
    const r = await createReservation(
      { branchId: 1, contactPhone: "07700000012", lines: [{ variantId, productUnitId: baseUnitId, quantity: 1 }] },
      actor,
    );

    await expect(convertReservationToSale({
      reservationId: r.reservationId,
      payment: { amount: "1500", method: "CARD" },
    }, actor)).rejects.toThrow(/مرجع/);
    expect(await onHand(variantId)).toBe(5);
    expect(await reserved(variantId)).toBe(1);

    const conv = await convertReservationToSale({
      reservationId: r.reservationId,
      payment: { amount: "1500", method: "TRANSFER", reference: "TRX-RES-1001" },
    }, actor);
    expect(conv.status).toBe("PAID");
    const receipt = (await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, conv.invoiceId)))[0];
    expect(receipt.paymentMethod).toBe("TRANSFER");
    expect(receipt.referenceNumber).toBe("TRX-RES-1001");
    expect(receipt.shiftId).toBeNull();
  });
});
