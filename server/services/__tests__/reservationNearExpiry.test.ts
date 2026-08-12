import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createProduct } from "../catalogService";
import {
  createReservation,
  extendReservation,
  notifyNearExpiryReservations,
} from "../reservations";
import { withTx } from "../tx";
import { flowNotify, type FlowNotifyInput } from "../whatsapp/flowNotify";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1, role: "admin" as const };
const TABLES = [
  "reservationEvents", "reservationLines", "reservationStock", "reservations",
  "waHubSettings",
  "branchStock", "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "productImages", "products",
  "customers", "categories", "users", "branches",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

let variantId: number;
let unitId: number;

async function makeReservation(
  phoneSuffix: string,
  channel: "PHONE" | "WALK_IN" | "WHATSAPP" | "STORE",
  expiresAt: Date,
  contactName: string | null = null,
) {
  const result = await createReservation({
    branchId: 1,
    contactName,
    contactPhone: `+96477000000${phoneSuffix}`,
    channel,
    lines: [{ variantId, productUnitId: unitId, quantity: 2 }],
  }, actor);
  await db().update(s.reservations).set({ expiresAt }).where(eq(s.reservations.id, result.reservationId));
  return result;
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "near_expiry_test", name: "admin", role: "admin", loginMethod: "local" });
  await createProduct({
    name: "منتج تنبيه",
    variants: [{
      sku: "RSV-NEAR",
      costPrice: "1000",
      openingStock: 100,
      units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "1500" }] }],
    }],
  }, actor);
  const variant = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, "RSV-NEAR")))[0];
  variantId = Number(variant.id);
  unitId = Number((await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, variantId)))[0].id);
  await db().insert(s.waHubSettings).values({ id: 1, flowReservationNearExpiry: true });
});

describe("تنبيه قرب انتهاء الحجز", () => {
  it("يربط المفتاح العام RESERVATION_NEAR_EXPIRY بمفتاح الإعداد المستقل", async () => {
    const result = await flowNotify({
      flowKey: "RESERVATION_NEAR_EXPIRY",
      branchId: 1,
      toPhoneE164: "+9647700000099",
      templateName: "reservation_near_expiry",
      bodyParams: ["RES-1", "عميل", "صنف", "15:00"],
      dedupeKey: "RESERVATION_NEAR_EXPIRY:TEST",
    });
    // لو لم يُربط المفتاح بالعمود الجديد لكانت النتيجة disabled؛ غياب التكامل هو البوابة التالية.
    expect(result).toEqual({ skipped: "no_integration" });
  });

  it("ينبّه ACTIVE داخل أربع ساعات لقناتي PHONE/WHATSAPP فقط بالقالب والحقول المطلوبة", async () => {
    const now = new Date("2026-08-12T10:00:00.000Z");
    const phone = await makeReservation("01", "PHONE", new Date("2026-08-12T12:00:00.000Z"), "سارة");
    const whatsapp = await makeReservation("02", "WHATSAPP", new Date("2026-08-12T13:00:00.000Z"));
    const store = await makeReservation("03", "STORE", new Date("2026-08-12T11:00:00.000Z"));
    const walkIn = await makeReservation("04", "WALK_IN", new Date("2026-08-12T11:00:00.000Z"));
    await makeReservation("05", "PHONE", new Date("2026-08-12T10:00:00.000Z"));
    await makeReservation("06", "PHONE", new Date("2026-08-12T14:00:00.000Z"));
    await db().update(s.reservations).set({ contactPhone: "07701234567" }).where(eq(s.reservations.id, phone.reservationId));

    const notify = vi.fn(async () => ({ queued: true, outboxId: 1, isNew: true } as const));
    const result = await notifyNearExpiryReservations({ now, notify });

    expect(result).toEqual({ eligible: 2, notified: 2, skipped: 0 });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0][0]).toMatchObject({
      flowKey: "RESERVATION_NEAR_EXPIRY",
      templateName: "reservation_near_expiry",
      toPhoneE164: "+9647701234567",
      dispatchMode: "DEFERRED",
      deliveryGuard: {
        type: "RESERVATION_NEAR_EXPIRY",
        reservationId: phone.reservationId,
        expiresAt: "2026-08-12T12:00:00.000Z",
      },
      bodyParams: [phone.reservationNumber, "سارة", "منتج تنبيه × 2 قطعة", "15:00"],
    });
    expect(notify.mock.calls[0][0].dedupeKey).toMatch(new RegExp(`^RESERVATION_NEAR_EXPIRY:${phone.reservationId}:`));
    expect(notify.mock.calls[1][0].bodyParams[0]).toBe(whatsapp.reservationNumber);

    const rows = await db().select().from(s.reservations);
    expect(rows.find((r) => Number(r.id) === phone.reservationId)?.nearExpiryNotifiedAt).not.toBeNull();
    expect(rows.find((r) => Number(r.id) === whatsapp.reservationId)?.nearExpiryNotifiedAt).not.toBeNull();
    expect(rows.find((r) => Number(r.id) === store.reservationId)?.nearExpiryNotifiedAt).toBeNull();
    expect(rows.find((r) => Number(r.id) === walkIn.reservationId)?.nearExpiryNotifiedAt).toBeNull();
  });

  it("لا يكرر الموعد نفسه، والتمديد يصفّر الأثر ويتيح تنبيهاً جديداً بمفتاح مختلف", async () => {
    const firstNow = new Date();
    const reservation = await makeReservation("07", "PHONE", new Date(firstNow.getTime() + 60 * 60 * 1000));
    const notify = vi.fn(async () => ({ queued: true, outboxId: 2, isNew: true } as const));

    await notifyNearExpiryReservations({ now: firstNow, notify });
    await notifyNearExpiryReservations({ now: firstNow, notify });
    expect(notify).toHaveBeenCalledTimes(1);

    await extendReservation(reservation.reservationId, 1, actor);
    const extended = (await db().select().from(s.reservations).where(eq(s.reservations.id, reservation.reservationId)))[0];
    expect(extended.nearExpiryNotifiedAt).toBeNull();
    await notifyNearExpiryReservations({ now: new Date(), notify });

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0].dedupeKey).not.toBe(notify.mock.calls[0][0].dedupeKey);
  });

  it("لا يضع أثر الإرسال عند تعطيل البوابة كي يعاود المحاولة لاحقاً", async () => {
    const now = new Date();
    const reservation = await makeReservation("08", "WHATSAPP", new Date(now.getTime() + 2 * 60 * 60 * 1000));
    const disabled = vi.fn(async () => ({ skipped: "disabled" } as const));

    expect(await notifyNearExpiryReservations({ now, notify: disabled })).toEqual({ eligible: 1, notified: 0, skipped: 1 });
    const afterSkip = (await db().select().from(s.reservations).where(eq(s.reservations.id, reservation.reservationId)))[0];
    expect(afterSkip.nearExpiryNotifiedAt).toBeNull();

    const enabled = vi.fn(async () => ({ queued: true, outboxId: 3, isNew: true } as const));
    expect(await notifyNearExpiryReservations({ now, notify: enabled })).toEqual({ eligible: 1, notified: 1, skipped: 0 });
  });

  it("يتخطى الهاتف غير الصالح بلا outbox وبلا أثر كي يمكن إصلاحه والمحاولة لاحقاً", async () => {
    const now = new Date();
    const reservation = await makeReservation("12", "PHONE", new Date(now.getTime() + 60 * 60 * 1000));
    await db().update(s.reservations).set({ contactPhone: "abc" }).where(eq(s.reservations.id, reservation.reservationId));
    const notify = vi.fn(async () => ({ queued: true, outboxId: 8, isNew: true } as const));

    expect(await notifyNearExpiryReservations({ now, notify })).toEqual({ eligible: 1, notified: 0, skipped: 1 });
    expect(notify).not.toHaveBeenCalled();
    const row = (await db().select().from(s.reservations).where(eq(s.reservations.id, reservation.reservationId)))[0];
    expect(row.nearExpiryNotifiedAt).toBeNull();
  });

  it("يخرج قبل مسح الدفعة عندما يكون المفتاح العام معطلاً", async () => {
    const now = new Date();
    await makeReservation("10", "PHONE", new Date(now.getTime() + 60 * 60 * 1000));
    await db().update(s.waHubSettings).set({ flowReservationNearExpiry: false }).where(eq(s.waHubSettings.id, 1));
    const notify = vi.fn(async () => ({ queued: true, outboxId: 5, isNew: true } as const));

    expect(await notifyNearExpiryReservations({ now, notify })).toEqual({ eligible: 0, notified: 0, skipped: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("يلغي الجدولة إن تغيّر الموعد بين الفحص الأول وفحص outbox الذرّي", async () => {
    const now = new Date();
    const reservation = await makeReservation("09", "PHONE", new Date(now.getTime() + 60 * 60 * 1000));
    const racingNotify = vi.fn(async (input: FlowNotifyInput) => {
      await db()
        .update(s.reservations)
        .set({ expiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000) })
        .where(eq(s.reservations.id, reservation.reservationId));
      const stillEligible = await withTx((tx) => input.finalEligibilityCheck!(tx));
      return stillEligible
        ? ({ queued: true, outboxId: 4, isNew: true } as const)
        : ({ skipped: "stale" } as const);
    });

    expect(await notifyNearExpiryReservations({ now, notify: racingNotify })).toEqual({ eligible: 1, notified: 0, skipped: 1 });
    const row = (await db().select().from(s.reservations).where(eq(s.reservations.id, reservation.reservationId)))[0];
    expect(row.nearExpiryNotifiedAt).toBeNull();
  });

  it("يعيد فحص الانتهاء بساعة قاعدة البيانات عند التشغيل الحقيقي لا بوقت بداية الدورة", async () => {
    const reservation = await makeReservation("11", "PHONE", new Date(Date.now() + 60 * 60 * 1000));
    const expiringNotify = vi.fn(async (input: FlowNotifyInput) => {
      await db()
        .update(s.reservations)
        .set({ expiresAt: new Date(Date.now() - 60 * 1000) })
        .where(eq(s.reservations.id, reservation.reservationId));
      const stillEligible = await withTx((tx) => input.finalEligibilityCheck!(tx));
      return stillEligible
        ? ({ queued: true, outboxId: 6, isNew: true } as const)
        : ({ skipped: "stale" } as const);
    });

    expect(await notifyNearExpiryReservations({ notify: expiringNotify })).toEqual({
      eligible: 1,
      notified: 0,
      skipped: 1,
    });
  });

  it("يستكمل ما بعد 200 حجز بصفحات keyset محدودة حتى عند تساوي وقت الانتهاء", async () => {
    const now = new Date("2026-08-12T10:00:00.000Z");
    const expiresAt = new Date("2026-08-12T12:00:00.000Z");
    const count = 205;
    await db().insert(s.reservations).values(Array.from({ length: count }, (_, index) => ({
      reservationNumber: `RSV-PAGE-${String(index).padStart(3, "0")}`,
      branchId: 1,
      contactPhone: "+9647700000099",
      channel: "PHONE" as const,
      status: "ACTIVE" as const,
      expiresAt,
      createdBy: 1,
    })));
    const reservationsForLines = await db()
      .select({ id: s.reservations.id })
      .from(s.reservations)
      .where(eq(s.reservations.expiresAt, expiresAt));
    await db().insert(s.reservationLines).values(reservationsForLines.map((row) => ({
      reservationId: Number(row.id),
      variantId,
      productUnitId: unitId,
      baseQuantity: 1,
    })));
    const notify = vi.fn(async () => ({ queued: true, outboxId: 7, isNew: true } as const));

    expect(await notifyNearExpiryReservations({ now, notify })).toEqual({
      eligible: count,
      notified: count,
      skipped: 0,
    });
    expect(notify).toHaveBeenCalledTimes(count);
  });
});
