// تحويل الحجز إلى فاتورة بيع (R-م٤). عبر createSale (يخصم المخزون + COGS + الائتمان + التقريب) —
// نمط convertQuotation/dispatchOnlineOrder: القراءة خارج معاملة البيع (createSale يفتح معاملته).
// بعد الفاتورة: تحرير المحجوز المنفَّذ + ربط fulfilledInvoiceId + حدث FULFILL (معاملة منفصلة، idempotent).
// ATP يبقى متسقاً: البيع يخصم branchStock بالمباع، والتحرير يخصم reservedBase بالمنفَّذ ⇒ المتاح ثابت.
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { productUnits, reservationEvents, reservationLines, reservations } from "../../../drizzle/schema";
import { createSale } from "../sale/create";
import type { PaymentMethod } from "../sale/types";
import { getOpenShift } from "../shiftService";
import { requireDb, withTx, type Actor } from "../tx";
import { adjustReservedStock } from "./stock";

export interface ConvertReservationInput {
  reservationId: number;
  payment?: { amount: string; method: PaymentMethod } | null;
}
export interface ConvertReservationResult {
  reservationId: number;
  invoiceId: number;
  invoiceNumber: string;
  total: string;
  status: "PENDING" | "PARTIALLY_PAID" | "PAID";
  idempotentReplay?: boolean;
}

export async function convertReservationToSale(input: ConvertReservationInput, actor: Actor): Promise<ConvertReservationResult> {
  const db = requireDb();
  const res = (await db.select().from(reservations).where(eq(reservations.id, input.reservationId)).limit(1))[0];
  if (!res) throw new TRPCError({ code: "NOT_FOUND", message: "الحجز غير موجود" });
  const elevated = actor.role === "admin" || actor.role === "manager";
  if (!elevated && Number(res.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الحجز لا يخصّ فرعك" });
  }
  if (res.status !== "ACTIVE" && res.status !== "PARTIALLY_FULFILLED") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `لا يمكن تحويل حجز حالته ${res.status}` });
  }
  // فحص انتهاء كسول (مراجعة Codex P2): لا تحوّل حجزاً انقضت مدّته وإن لم يُعالجه الكنّاس بعد.
  if (new Date(res.expiresAt).getTime() <= Date.now()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "انتهت مدّة الحجز — لا يمكن تحويله" });
  }

  const lines = await db.select().from(reservationLines).where(eq(reservationLines.reservationId, input.reservationId));
  const remaining = lines.filter((l) => l.baseQuantity - l.fulfilledBase > 0);
  if (!remaining.length) throw new TRPCError({ code: "BAD_REQUEST", message: "لا كميات متبقّية للتحويل" });

  // الدفع النقديّ يتطلب وردية مفتوحة (نمط convertQuotation) — يُحلّ خارج معاملة البيع. يمكّن تحويل
  // حجز walk-in بلا عميل عبر تحصيل نقديّ كامل عند الحضور (مراجعة Codex P1).
  let shiftId: number | null = null;
  if (input.payment && input.payment.method === "CASH" && Number(input.payment.amount) > 0) {
    const sh = await getOpenShift(actor.userId, Number(res.branchId));
    if (!sh) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "افتح وردية أولاً لتحصيل دفعة نقدية عند التحويل" });
    shiftId = sh.id;
  }

  // البنود مخزّنة بوحدة الأساس ⇒ نبيع بوحدة الأساس (السعر يُحسَب حياً من productPrices — quotedUnitPrice عرضيّ).
  const saleLines: Array<{ variantId: number; productUnitId: number; baseQty: number; lineId: number; fromFulfilled: number; toFulfilled: number }> = [];
  for (const l of remaining) {
    const baseUnit = (await db
      .select({ id: productUnits.id })
      .from(productUnits)
      .where(and(eq(productUnits.variantId, Number(l.variantId)), eq(productUnits.isBaseUnit, true)))
      .limit(1))[0];
    if (!baseUnit) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `لا وحدة أساس للمتغيّر ${l.variantId}` });
    saleLines.push({
      variantId: Number(l.variantId),
      productUnitId: Number(baseUnit.id),
      baseQty: l.baseQuantity - l.fulfilledBase,
      lineId: Number(l.id),
      fromFulfilled: l.fulfilledBase,
      toFulfilled: l.baseQuantity,
    });
  }

  // createSale يفتح معاملته الخاصة (idempotent عبر sourceId=RES-<id>) — لا يُستدعى داخل withTx.
  const sale = await createSale(
    {
      branchId: Number(res.branchId),
      shiftId,
      customerId: res.customerId ? Number(res.customerId) : null,
      sourceType: "ORDER",
      clientRequestId: `RES-${res.id}`,
      lines: saleLines.map((sl) => ({ variantId: sl.variantId, productUnitId: sl.productUnitId, quantity: String(sl.baseQty) })),
      payment: input.payment ?? null,
      notes: `محوّل من الحجز ${res.reservationNumber}`,
      // مراجعة Codex P1: لا نمرّر priceOverrideApproved تلقائياً — البيع تحت التكلفة يبقى محكوماً بموافقة
      // مدير في createSale نفسه (الحجز لا يحمل موافقة مسبقة، فلا يفتح مساراً يتجاوز الحوكمة).
    },
    actor,
  );

  // ربط الفاتورة + تحرير المحجوز المنفَّذ + FULFILL (خارج معاملة البيع — نمط convertQuotation).
  await withTx(async (tx) => {
    // حارس تكرار (idempotent replay): إن رُبط الحجز مسبقاً لا نكرّر التحرير.
    const cur = (await tx
      .select({ status: reservations.status, inv: reservations.fulfilledInvoiceId })
      .from(reservations)
      .where(eq(reservations.id, input.reservationId))
      .for("update")
      .limit(1))[0];
    // حارس صارم (مراجعة Codex P1): لا نُثبّت FULFILLED إلا إن كان الحجز ما زال قابلاً للتحويل (لم يُلغَ/
    // يُحرَّر/ينتهِ متزامناً بعد قراءة الحالة). النافذة بين createSale وهذا القفل موسومة limitation R-م٤ب
    // (الحلّ الكامل: حالة claim انتقالية FULFILLING قبل createSale — يتطلب هجرة enum، شريحة تالية).
    if (!cur || (cur.status !== "ACTIVE" && cur.status !== "PARTIALLY_FULFILLED")) return;
    for (const sl of saleLines) {
      await tx.update(reservationLines).set({ fulfilledBase: sl.toFulfilled }).where(eq(reservationLines.id, sl.lineId));
      await adjustReservedStock(tx, sl.variantId, Number(res.branchId), -sl.baseQty);
    }
    await tx.update(reservations).set({ status: "FULFILLED", fulfilledInvoiceId: sale.invoiceId }).where(eq(reservations.id, input.reservationId));
    await tx.insert(reservationEvents).values({
      reservationId: input.reservationId,
      eventType: "FULFILL",
      fromStatus: res.status,
      toStatus: "FULFILLED",
      note: `فاتورة ${sale.invoiceNumber}`,
      userId: actor.userId,
    });
  });

  return {
    reservationId: input.reservationId,
    invoiceId: sale.invoiceId,
    invoiceNumber: sale.invoiceNumber,
    total: sale.total,
    status: sale.status,
    idempotentReplay: sale.idempotentReplay,
  };
}
