// أدوات مشتركة للحجوزات — الترقيم (نمط nextTaskNumber) + قفل التحميل + عزل الفرع + الثوابت.
import { TRPCError } from "@trpc/server";
import { desc, eq, like } from "drizzle-orm";
import { reservations } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { toDateStr } from "../money";
import type { Actor } from "../tx";

/** مدة الحجز الافتراضية (قرار المالك ٢٧/٧: ٢٤ ساعة، تمديد حتى ٧٢ بموافقة مدير). */
export const DEFAULT_RESERVATION_HOURS = 24;
export const MAX_EXTEND_HOURS = 72;

/** الحالات النشطة التي تحجز مخزوناً فعلياً (تُحتسب في reservationStock). */
export const CLOSEABLE_STATUSES = ["ACTIVE", "PARTIALLY_FULFILLED"] as const;
export type ReservationStatus =
  | "ACTIVE" | "PARTIALLY_FULFILLED" | "FULFILLED" | "EXPIRED" | "CANCELLED" | "RELEASED";

/** رقم حجز تسلسليّ لكل (فرع×يوم): RES-{branchId}-{YYYYMMDD}-{5} — قفل FOR UPDATE يمنع التصادم. */
export async function nextReservationNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `RES-${branchId}-${ymd}-`;
  const rows = await tx
    .select({ n: reservations.reservationNumber })
    .from(reservations)
    .where(like(reservations.reservationNumber, `${prefix}%`))
    .orderBy(desc(reservations.id))
    .for("update")
    .limit(1);
  const last = rows[0]?.n;
  const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(seq).padStart(5, "0");
}

/** يحمّل الحجز تحت قفل الصفّ (تسلسل الانتقالات المتزامنة على نفس الحجز). */
export async function loadReservation(tx: Tx, id: number) {
  const rows = await tx.select().from(reservations).where(eq(reservations.id, id)).for("update").limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "الحجز غير موجود" });
  return rows[0];
}

/** عزل الفرع (نمط tasks/workOrders): غير المرتفع لا يمسّ حجز فرع آخر. */
export function assertReservationBranch(res: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin" || actor.role === "manager";
  if (elevated) return;
  if (Number(res.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الحجز لا يخصّ فرعك" });
  }
}
