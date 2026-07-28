// نواة المحجوز المجمّع (reservationStock) — نمط applyMovement مع branchStock.
// حجز ناعم (soft/ATP): لا يمسّ branchStock إطلاقاً. المتاح (ATP) = رصيد فعليّ − محجوز نشط.
// التزامن: قفل صفّ reservationStock يتسلسل الحجوزات المتزامنة على نفس (صنف×فرع) ⇒ لا سباق «آخر قطعة».
import { and, eq, sql } from "drizzle-orm";
import { branchStock, reservationStock } from "../../../drizzle/schema";
import type { Tx } from "../../db";

export interface Availability {
  onHand: number; // الرصيد الفعليّ بوحدة الأساس
  reserved: number; // المحجوز النشط بوحدة الأساس
  available: number; // ATP = onHand − reserved (قد يكون سالباً إن حُجز فوق الرصيد — موسوم بالإنفاذ الناعم)
}

/** يضمن وجود صفّ reservationStock للـ(صنف×فرع) قبل القفل — FOR UPDATE لا يقفل صفّاً غير موجود. */
async function ensureReservedRow(tx: Tx, variantId: number, branchId: number): Promise<void> {
  await tx
    .insert(reservationStock)
    .values({ variantId, branchId, reservedBase: 0 })
    .onDuplicateKeyUpdate({ set: { variantId: sql`${reservationStock.variantId}` } });
}

/**
 * يقرأ المتاح (ATP) لصنف×فرع. مع lock=true يقفل صفّ reservationStock تحت نفس المعاملة
 * ⇒ حجزان متزامنان يتسلسلان (الثاني يقرأ محجوز الأوّل بعد commit).
 */
export async function readAvailability(
  tx: Tx,
  variantId: number,
  branchId: number,
  opts: { lock?: boolean } = {},
): Promise<Availability> {
  if (opts.lock) await ensureReservedRow(tx, variantId, branchId);
  const stockRows = await tx
    .select({ q: branchStock.quantity })
    .from(branchStock)
    .where(and(eq(branchStock.variantId, variantId), eq(branchStock.branchId, branchId)))
    .limit(1);
  const onHand = stockRows[0]?.q ?? 0;
  const resBase = tx
    .select({ r: reservationStock.reservedBase })
    .from(reservationStock)
    .where(and(eq(reservationStock.variantId, variantId), eq(reservationStock.branchId, branchId)))
    .limit(1);
  const resRows = await (opts.lock ? resBase.for("update") : resBase);
  const reserved = resRows[0]?.r ?? 0;
  return { onHand, reserved, available: onHand - reserved };
}

/**
 * يزيد/ينقص المحجوز المجمّع نسبياً (نمط applyMovement مع branchStock): +حجز / −تحرير.
 * GREATEST(0,…) حارس دفاعيّ يمنع نزول المحجوز تحت الصفر (تحرير مزدوج آمن — idempotent).
 */
export async function adjustReservedStock(
  tx: Tx,
  variantId: number,
  branchId: number,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  await ensureReservedRow(tx, variantId, branchId);
  await tx
    .update(reservationStock)
    .set({ reservedBase: sql`GREATEST(0, ${reservationStock.reservedBase} + ${delta})` })
    .where(and(eq(reservationStock.variantId, variantId), eq(reservationStock.branchId, branchId)));
}
