/**
 * سياسة الرؤية قبل العد الأول لعهد النقد CD/CH.
 *
 * المستلم الصالح يجب أن يكون مديراً/إدارياً نشطاً من الفرع، ومختلفاً عن
 * مُسلِّم النقد ومالك الوردية. حالة النشاط يضمنها تسجيل الدخول وقائمة المستلمين؛
 * هنا نعيد فرض بقية العقد عند منافذ القراءة كي لا يعرف مستلم محتمل المبلغ قبل عدّه.
 */
export interface CashCustodyVisibilityActor {
  userId: number;
  role: string;
  branchId: number | null;
}

export interface CashCustodySourceIdentity {
  branchId: number | null;
  handedOverByUserId: number | null;
  shiftOwnerUserId: number | null;
}

export function isPotentialCashCustodyRecipient(
  actor: CashCustodyVisibilityActor | undefined,
  source: CashCustodySourceIdentity,
): boolean {
  if (!actor || (actor.role !== "admin" && actor.role !== "manager")) return false;
  if (actor.branchId == null || source.branchId == null || actor.branchId !== source.branchId) return false;
  if (source.handedOverByUserId != null && actor.userId === source.handedOverByUserId) return false;
  if (source.shiftOwnerUserId != null && actor.userId === source.shiftOwnerUserId) return false;
  return true;
}
