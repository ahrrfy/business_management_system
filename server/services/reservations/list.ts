// قراءة قائمة الحجوزات (بعزل الفرع). التفاصيل (get) واستعلام التوفّر المستقل (availability) يُعادان
// مع مستهلكهما الواجهيّ في شريحة تالية (شاشة تفاصيل الحجز + شاشة «هل متوفر؟») — DoD: لا خلفية بلا واجهة.
import { and, desc, eq, like, or } from "drizzle-orm";
import { reservations } from "../../../drizzle/schema";
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
