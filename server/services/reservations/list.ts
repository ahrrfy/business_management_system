// قراءات الحجوزات: القائمة (بعزل فرع)، التفاصيل، واستعلام التوفّر (ATP) عبر الفروع.
import { and, desc, eq, like, or } from "drizzle-orm";
import { branchStock, reservationLines, reservations, reservationStock } from "../../../drizzle/schema";
import { requireDb } from "../tx";
import type { ReservationStatus } from "./helpers";

export interface ListScope {
  scopedBranchId: number | null;
}
export interface ListFilter {
  status?: ReservationStatus;
  branchId?: number;
  q?: string;
  limit?: number;
}

export async function listReservations(scope: ListScope, filter: ListFilter = {}) {
  const db = requireDb();
  const conds = [];
  // عزل الفرع: غير المرتفع (scopedBranchId مضبوط) يرى فرعه فقط؛ المرتفع يفلتر بـ filter.branchId اختيارياً.
  const branch = scope.scopedBranchId ?? filter.branchId;
  if (branch != null) conds.push(eq(reservations.branchId, branch));
  if (filter.status) conds.push(eq(reservations.status, filter.status));
  if (filter.q) {
    const q = `%${filter.q}%`;
    conds.push(or(like(reservations.reservationNumber, q), like(reservations.contactPhone, q), like(reservations.contactName, q)));
  }
  return db
    .select()
    .from(reservations)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(reservations.id))
    .limit(Math.min(filter.limit ?? 100, 200));
}

export async function getReservation(id: number, scope: ListScope) {
  const db = requireDb();
  const rows = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
  const res = rows[0];
  if (!res) return null;
  if (scope.scopedBranchId != null && Number(res.branchId) !== scope.scopedBranchId) return null; // عزل الفرع
  const lines = await db.select().from(reservationLines).where(eq(reservationLines.reservationId, id));
  return { ...res, lines };
}

/** استعلام التوفّر (ATP) لصنف عبر الفروع (أو فرع محدّد) — للشاشة «هل متوفر؟». */
export async function getAvailabilityByVariant(variantId: number, branchId?: number) {
  const db = requireDb();
  const stockConds = [eq(branchStock.variantId, variantId)];
  if (branchId != null) stockConds.push(eq(branchStock.branchId, branchId));
  const stock = await db
    .select({ branchId: branchStock.branchId, onHand: branchStock.quantity })
    .from(branchStock)
    .where(and(...stockConds));
  const resConds = [eq(reservationStock.variantId, variantId)];
  if (branchId != null) resConds.push(eq(reservationStock.branchId, branchId));
  const reserved = await db
    .select({ branchId: reservationStock.branchId, reserved: reservationStock.reservedBase })
    .from(reservationStock)
    .where(and(...resConds));
  const resMap = new Map(reserved.map((r) => [Number(r.branchId), r.reserved]));
  return stock.map((s) => {
    const r = resMap.get(Number(s.branchId)) ?? 0;
    return { branchId: Number(s.branchId), onHand: s.onHand, reserved: r, available: s.onHand - r };
  });
}
