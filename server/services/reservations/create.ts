// إنشاء الحجز — حجز ناعم تحت قفل ATP. الإنفاذ ناعم (قرار المالك): يُسمح بالحجز حتى فوق المتاح
// مع وسم الأصناف المتجاوِزة (overbookedVariantIds) — تحذير لا منع. الكميات تُحوَّل لوحدة الأساس خادمياً.
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { products, productVariants, reservationEvents, reservationLines, reservations } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { convertToBaseQuantity } from "../inventoryService";
import { withTx, type Actor } from "../tx";
import { DEFAULT_RESERVATION_HOURS, nextReservationNumber } from "./helpers";
import { adjustReservedStock, readAvailability } from "./stock";

export interface ReservationLineInput {
  variantId: number;
  productUnitId: number;
  quantity: number; // بالوحدة المختارة (قطعة/درزن/كرتون) — يُحوَّل لوحدة الأساس خادمياً
  quotedUnitPrice?: string | null;
}
export interface CreateReservationInput {
  branchId: number;
  customerId?: number | null;
  contactName?: string | null;
  contactPhone: string; // إلزاميّ (قرار المالك)
  channel?: "PHONE" | "WALK_IN" | "WHATSAPP" | "STORE";
  expiresInHours?: number | null; // افتراضي DEFAULT_RESERVATION_HOURS
  notes?: string | null;
  lines: ReservationLineInput[];
}
export interface CreateReservationResult {
  reservationId: number;
  reservationNumber: string;
  expiresAt: string;
  overbookedVariantIds: number[]; // أصناف حُجزت فوق المتاح (تحذير ناعم)
}

export async function createReservation(input: CreateReservationInput, actor: Actor): Promise<CreateReservationResult> {
  if (!input.contactPhone?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "هاتف العميل مطلوب للحجز" });
  if (!input.lines?.length) throw new TRPCError({ code: "BAD_REQUEST", message: "أضف صنفاً واحداً على الأقل للحجز" });
  for (const ln of input.lines) {
    if (!(ln.quantity > 0)) throw new TRPCError({ code: "BAD_REQUEST", message: "كمية الحجز يجب أن تكون موجبة" });
  }
  const hours = input.expiresInHours && input.expiresInHours > 0 ? input.expiresInHours : DEFAULT_RESERVATION_HOURS;

  return withTx(async (tx) => {
    // حوّل كل سطر لوحدة الأساس (baseQuantity صحيح؛ يرمي إن كان كسرياً) — منع «حجز درزن وبيع قطع».
    const converted: { variantId: number; productUnitId: number; baseQuantity: number; quotedUnitPrice?: string | null }[] = [];
    for (const ln of input.lines) {
      const conv = await convertToBaseQuantity(tx, ln.productUnitId, ln.quantity, ln.variantId);
      converted.push({ variantId: ln.variantId, productUnitId: ln.productUnitId, baseQuantity: conv.baseQuantity, quotedUnitPrice: ln.quotedUnitPrice });
    }

    // حارس (مراجعة Codex P1): لا يُحجز منتج مركّب (bundle) أو خدميّ — لا رصيد branchStock ذاتيّ له
    // (bundle مخزونه مشتقّ من مكوّناته؛ الحجز الناعم يعمل على reservationStock لكل variant مخزونيّ).
    const variantIds = Array.from(new Set(converted.map((c) => c.variantId)));
    const kinds = await tx
      .select({ variantId: productVariants.id, isBundle: products.isBundle, isService: products.isService })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(inArray(productVariants.id, variantIds));
    for (const k of kinds) {
      if (k.isBundle || k.isService) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يُحجز منتج مركّب (بكج) أو خدميّ — احجز أصنافاً مخزونية." });
      }
    }

    // دمج الكميات لكل صنف + ترتيب تصاعديّ للـvariantId (تفادي deadlock — نمط sale/create).
    const byVariant = new Map<number, number>();
    for (const ln of converted) byVariant.set(ln.variantId, (byVariant.get(ln.variantId) ?? 0) + ln.baseQuantity);
    const orderedVariants = Array.from(byVariant.keys()).sort((a, b) => a - b);

    const overbooked: number[] = [];
    // فحص ATP تحت قفل reservationStock (يتسلسل الحجوزات المتزامنة) — ناعم: نحجز حتى فوق المتاح مع وسم.
    for (const variantId of orderedVariants) {
      const need = byVariant.get(variantId)!;
      const { available } = await readAvailability(tx, variantId, input.branchId, { lock: true });
      if (need > available) overbooked.push(variantId);
      await adjustReservedStock(tx, variantId, input.branchId, need);
    }

    const reservationNumber = await nextReservationNumber(tx, input.branchId);
    const expiresAt = new Date(Date.now() + hours * 3_600_000);
    const insRes = await tx.insert(reservations).values({
      reservationNumber,
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      contactName: input.contactName ?? null,
      contactPhone: input.contactPhone.trim(),
      channel: input.channel ?? "PHONE",
      status: "ACTIVE",
      expiresAt,
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const reservationId = extractInsertId(insRes);

    for (const ln of converted) {
      await tx.insert(reservationLines).values({
        reservationId,
        variantId: ln.variantId,
        productUnitId: ln.productUnitId,
        baseQuantity: ln.baseQuantity,
        quotedUnitPrice: ln.quotedUnitPrice ?? null,
      });
    }
    await tx.insert(reservationEvents).values({
      reservationId,
      eventType: "CREATE",
      toStatus: "ACTIVE",
      note: overbooked.length ? `حجز فوق المتاح لأصناف: ${overbooked.join(", ")}` : null,
      userId: actor.userId,
    });

    return { reservationId, reservationNumber, expiresAt: expiresAt.toISOString(), overbookedVariantIds: overbooked };
  });
}
