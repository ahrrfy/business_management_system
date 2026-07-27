import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createProduct } from "../catalogService";
import { withTx } from "../tx";
import {
  cancelReservation, createReservation, expireDueReservations,
  extendReservation, readAvailability, releaseReservation,
} from "../reservations";

/**
 * الحجوزات — R-م٣: اختبارات الثوابت الحرجة (§٨ من docs/gifts-reservations-design-2026-07-27.md).
 * حجز ناعم (ATP): لا يمسّ branchStock؛ reservationStock.reservedBase = Σ(المحجوز النشط)؛
 * الإلغاء/الانتهاء يحرّران مرّة واحدة؛ overbook مسموح (ناعم) مع وسم؛ التحويل لوحدة الأساس.
 */

const actor = { userId: 1, branchId: 1, role: "admin" as const };

const TABLES = [
  "reservationEvents", "reservationLines", "reservationStock", "reservations",
  "accountingEntries", "receipts", "inventoryMovements",
  "branchStock", "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "productImages", "products",
  "auditLogs", "customers", "categories", "users", "branches",
];

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set for tests"); return d; }

async function seedBase() {
  await db().insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
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

async function onHand(variantId: number, branchId = 1) {
  const r = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId))))[0];
  return r?.quantity ?? 0;
}
async function reserved(variantId: number, branchId = 1) {
  const r = (await db().select().from(s.reservationStock).where(and(eq(s.reservationStock.variantId, variantId), eq(s.reservationStock.branchId, branchId))))[0];
  return r?.reservedBase ?? 0;
}
const atp = (variantId: number, branchId = 1) => withTx((tx) => readAvailability(tx, variantId, branchId));

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
    expect((await atp(variantId)).available).toBe(-3); // المتاح سالب موسوم
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
});
