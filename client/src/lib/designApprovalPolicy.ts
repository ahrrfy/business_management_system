/**
 * **سياسةُ اعتماد التصميم في الواجهة — مرآةُ الخادم، مصدرٌ واحد.**
 *
 * كانت `designApprovalSelfReviewBlocked` تعيش داخل صفحة `TaskDetail.tsx`، فلمّا صار القرارُ
 * متاحاً من بطاقة أمر الشغل أيضاً (١/٩/٢٦) كان البديل أن تُستورَد **صفحةٌ** من **مكوّن** —
 * أو أن يُعاد كتابةُ الشرط، وهو أوّلُ الانجراف. فنُقلت إلى هنا و`TaskDetail` يُعيد تصديرها.
 *
 * الإنفاذُ خادميٌّ دائماً (`assertReviewerAuthority` + مجموعةُ `forbiddenActors` في
 * `decideWorkOrderDesignApproval`)؛ هذه الدوالُّ تمنع **زرّاً يَعِد بما سيرفضه الخادم**.
 */
import { moduleAccessAllowed, type PermissionMap } from "@shared/permissions";

/**
 * فصلُ الواجبات: طالبُ الاعتماد ومنشئُ النسخة والفنّيُّ المسنَد ومكلَّفُ المهمّة — لا يراجع
 * أحدُهم عملَه. مرآةُ `forbiddenActors` في الخدمة حرفياً.
 */
export function designApprovalSelfReviewBlocked(
  currentUserId: number | undefined,
  participants: Array<number | string | null | undefined>,
): boolean {
  if (currentUserId == null) return false;
  return participants.some(
    (participant) => participant != null && Number(participant) === currentUserId,
  );
}

/** مرآةُ `assertReviewerAuthority`: مديرُ الوحدة أو منحٌ صريح بـ`workorders: FULL`. */
export function canDecideDesignApproval(
  role: string | null | undefined,
  override: unknown,
): boolean {
  return (
    !!role &&
    moduleAccessAllowed(
      role,
      (override ?? null) as PermissionMap | null,
      "workorders",
      "FULL",
      ["manager"],
    )
  );
}
