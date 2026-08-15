// نواة المحجوز المجمّع (reservationStock) — نمط applyMovement مع branchStock.
// حجز ناعم (soft/ATP): لا يمسّ branchStock إطلاقاً. المتاح الحاكم يجمع الحجز الرسمي
// وتخصيص الطلبات الإلكترونية النشطة من primitive الكتالوج نفسها، فلا ينشأ ATP ثانٍ متناقض.
import { and, eq, sql } from "drizzle-orm";
import { reservationStock } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { loadVariantAvailability } from "../catalog/variantAvailability";

export interface Availability {
  onHand: number; // الرصيد الفعليّ بوحدة الأساس
  reserved: number; // الحجز الرسمي + تخصيص طلبات المتجر النشطة بوحدة الأساس
  available: number; // ATP تنفيذيّ = max(0, onHand − reserved)؛ لا تعرض أي شاشة كمية سالبة قابلة للبيع
  rawAvailableBase: number; // فرق تشخيصي موقّع للتدقيق فقط
  shortfallBase: number; // مقدار العجز التشخيصي = max(0, reserved − onHand)
}

/** يضمن وجود صفّ reservationStock للـ(صنف×فرع) قبل القفل — FOR UPDATE لا يقفل صفّاً غير موجود. */
async function ensureReservedRow(tx: Tx, variantId: number, branchId: number): Promise<void> {
  await tx
    .insert(reservationStock)
    .values({ variantId, branchId, reservedBase: 0 })
    .onDuplicateKeyUpdate({ set: { variantId: sql`${reservationStock.variantId}` } });
}

/**
 * يقرأ المتاح (ATP) لصنف×فرع من المصدر الحاكم نفسه المستعمل في POS والمتجر.
 * مع lock=true يقفل variant/stock/allocations بالترتيب الموحد؛ لذلك يرى الحجز الثاني
 * الحجز الرسمي والطلب الإلكتروني اللذين التزما قبله، ولا يتجاوز تخصيصهما بصمت.
 */
export async function readAvailability(
  tx: Tx,
  variantId: number,
  branchId: number,
  opts: { lock?: boolean } = {},
): Promise<Availability> {
  const state = (await loadVariantAvailability(tx, branchId, [variantId], {
    lock: opts.lock === true,
  })).get(variantId);
  const onHand = state?.onHandBase ?? 0;
  const reserved = state?.reservedBase ?? 0;
  const rawAvailableBase = onHand - reserved;
  return {
    onHand,
    reserved,
    available: Math.max(0, rawAvailableBase),
    rawAvailableBase,
    shortfallBase: Math.max(0, -rawAvailableBase),
  };
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
