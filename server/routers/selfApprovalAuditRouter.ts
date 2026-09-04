/**
 * تقريرُ الاعتماد الذاتي — الطرفُ الخادميّ لشاشة «الاعتماد الذاتي» (ownerProcedure حصراً،
 * لا مدير فرع ولا محاسب: هذا تقريرُ رقابةٍ على المُلّاك أنفسهم). راجع
 * `server/services/audit/selfApprovalReport.ts` للاستعلامات، ولماذا معيارُ الصفّ تساوي
 * المُنشئ والمُقرِّر لا `isOwner` الحاليّ.
 */
import { ownerProcedure, router } from "../trpc";
import { listSelfApprovalRecords } from "../services/audit/selfApprovalReport";

export const selfApprovalAuditRouter = router({
  list: ownerProcedure.query(async () => {
    return listSelfApprovalRecords();
  }),
});
