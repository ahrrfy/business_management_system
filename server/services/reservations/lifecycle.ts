// دورة حياة الحجز (FSM): الإلغاء/التحرير/التمديد/الانتهاء التلقائي. كل انتقال يحرّر المحجوز المتبقّي
// مرّة واحدة (idempotent) ويكتب حدثاً تسلسلياً. التحويل لبيع + العربون في R-م٤/م٥.
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { reservationEvents, reservationLines, reservations } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { withTx, type Actor } from "../tx";
import { assertReservationBranch, CLOSEABLE_STATUSES, loadReservation, MAX_EXTEND_HOURS } from "./helpers";
import { adjustReservedStock } from "./stock";

const CLOSEABLE: readonly string[] = CLOSEABLE_STATUSES;

/** يحرّر المحجوز المتبقّي (baseQuantity − fulfilledBase) لكل بنود الحجز — مجمَّعاً ومرتّباً تصاعدياً. */
async function releaseRemaining(tx: Tx, reservationId: number, branchId: number): Promise<void> {
  const lines = await tx
    .select({
      variantId: reservationLines.variantId,
      baseQuantity: reservationLines.baseQuantity,
      fulfilledBase: reservationLines.fulfilledBase,
    })
    .from(reservationLines)
    .where(eq(reservationLines.reservationId, reservationId));
  const byVariant = new Map<number, number>();
  for (const ln of lines) {
    const remaining = ln.baseQuantity - ln.fulfilledBase;
    if (remaining > 0) byVariant.set(Number(ln.variantId), (byVariant.get(Number(ln.variantId)) ?? 0) + remaining);
  }
  for (const variantId of Array.from(byVariant.keys()).sort((a, b) => a - b)) {
    await adjustReservedStock(tx, variantId, branchId, -byVariant.get(variantId)!);
  }
}

export async function cancelReservation(id: number, reason: string | null, actor: Actor): Promise<{ id: number; status: "CANCELLED" }> {
  return withTx(async (tx) => {
    const res = await loadReservation(tx, id);
    assertReservationBranch(res, actor);
    if (!CLOSEABLE.includes(res.status)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `لا يمكن إلغاء حجز حالته ${res.status}` });
    }
    await releaseRemaining(tx, id, Number(res.branchId));
    await tx.update(reservations).set({ status: "CANCELLED", cancelReason: reason ?? null }).where(eq(reservations.id, id));
    await tx.insert(reservationEvents).values({
      reservationId: id, eventType: "CANCEL", fromStatus: res.status, toStatus: "CANCELLED", note: reason ?? null, userId: actor.userId,
    });
    return { id, status: "CANCELLED" as const };
  });
}

/** تحرير مديريّ لظرف مخزنيّ (managerProcedure) — مميّز عن إلغاء العميل. */
export async function releaseReservation(id: number, reason: string | null, actor: Actor): Promise<{ id: number; status: "RELEASED" }> {
  return withTx(async (tx) => {
    const res = await loadReservation(tx, id);
    assertReservationBranch(res, actor);
    if (!CLOSEABLE.includes(res.status)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `لا يمكن تحرير حجز حالته ${res.status}` });
    }
    await releaseRemaining(tx, id, Number(res.branchId));
    await tx.update(reservations).set({ status: "RELEASED", releasedBy: actor.userId, cancelReason: reason ?? null }).where(eq(reservations.id, id));
    await tx.insert(reservationEvents).values({
      reservationId: id, eventType: "RELEASE", fromStatus: res.status, toStatus: "RELEASED", note: reason ?? null, userId: actor.userId,
    });
    return { id, status: "RELEASED" as const };
  });
}

export async function extendReservation(id: number, hours: number, actor: Actor): Promise<{ id: number; expiresAt: string }> {
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_EXTEND_HOURS) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `مدة التمديد بين ١ و${MAX_EXTEND_HOURS} ساعة` });
  }
  return withTx(async (tx) => {
    const res = await loadReservation(tx, id);
    assertReservationBranch(res, actor);
    if (!CLOSEABLE.includes(res.status)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `لا يمكن تمديد حجز حالته ${res.status}` });
    }
    // مراجعة Codex P2: مدّد من الأبعد (الانتهاء الحاليّ أو الآن) — لا تقصّر حجزاً مدّته المتبقّية أطول.
    const base = Math.max(Date.now(), new Date(res.expiresAt).getTime());
    const newExpiry = new Date(base + hours * 3_600_000);
    await tx
      .update(reservations)
      .set({ expiresAt: newExpiry, nearExpiryNotifiedAt: null })
      .where(eq(reservations.id, id));
    await tx.insert(reservationEvents).values({
      reservationId: id, eventType: "EXTEND", note: `تمديد ${hours} ساعة`, userId: actor.userId,
    });
    return { id, expiresAt: newExpiry.toISOString() };
  });
}

/**
 * كنّاس الانتهاء: يُنهي الحجوزات المنتهية (نشطة ∧ expiresAt < NOW) ويحرّر محجوزها.
 * يُستدعى من node-cron (بلا فلتر — دفعة عامّة) ومن get (بفلتر id — سطرٌ واحد فقط، لا خطر deadlock).
 * idempotent (يعالج المنتهية فقط).
 *
 * `opts.reservationId` (Codex P1 على PR #557): بدلاً من كنس ٥٠ صفّاً عشوائياً من فرعٍ آخر عند قراءة
 * حجزٍ بعينه، نمرّ بفلتر id فيُعالَج المطلوب حتماً — وحده. يمنع أيضاً الـdeadlock (Codex P2):
 * `createReservation` يقفل `reservationStock` قبل `reservations` (numbering)، بينما الكنّاس العام
 * يقفل `reservations` قبل `reservationStock` (release) — تعارضٌ محتمل تحت الحمل. كنسُ id واحدٍ
 * صفٍّ لن يتعارض إلا مع تعديلاتٍ على ذلك الصفّ بعينه، وذلك مقبول (retryOnDeadlock من الاستدعاء).
 */
export async function expireDueReservations(
  limitOrOpts: number | { limit?: number; reservationId?: number } = 200,
): Promise<{ expired: number }> {
  const opts = typeof limitOrOpts === "number" ? { limit: limitOrOpts } : limitOrOpts;
  const limit = opts.limit ?? 200;
  return withTx(async (tx) => {
    const conds = [
      inArray(reservations.status, ["ACTIVE", "PARTIALLY_FULFILLED"]),
      lt(reservations.expiresAt, sql`NOW()`),
    ];
    if (opts.reservationId != null) conds.push(eq(reservations.id, opts.reservationId));
    const due = await tx
      .select({ id: reservations.id, branchId: reservations.branchId, status: reservations.status })
      .from(reservations)
      .where(and(...conds))
      .for("update")
      .limit(limit);
    let expired = 0;
    for (const r of due) {
      await releaseRemaining(tx, Number(r.id), Number(r.branchId));
      await tx.update(reservations).set({ status: "EXPIRED" }).where(eq(reservations.id, Number(r.id)));
      await tx.insert(reservationEvents).values({
        reservationId: Number(r.id), eventType: "EXPIRE", fromStatus: r.status, toStatus: "EXPIRED", note: "انتهت المدة تلقائياً", userId: null,
      });
      expired++;
    }
    return { expired };
  });
}
