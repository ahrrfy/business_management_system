/**
 * تقريرُ الاعتماد الذاتي — الطرفُ الخادميّ لشاشة «الاعتماد الذاتي» (ownerProcedure حصراً،
 * لا مدير فرع ولا محاسب: هذا تقريرُ رقابةٍ على المُلّاك أنفسهم). راجع
 * `server/services/audit/selfApprovalReport.ts` للاستعلامات، ولماذا معيارُ الصفّ تساوي
 * المُنشئ والمُقرِّر لا `isOwner` الحاليّ.
 */
import { z } from "zod";
import { ownerProcedure, router } from "../trpc";
import { listSelfApprovalRecords } from "../services/audit/selfApprovalReport";

/** YYYY-MM-DD — نصّ صريح لا Date (يُمرَّر كما هو لمقارنات SQL بنمط DATE()). */
const ymdStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "صيغة التاريخ YYYY-MM-DD");

export const selfApprovalAuditRouter = router({
  list: ownerProcedure
    .input(z.object({ from: ymdStr.optional(), to: ymdStr.optional() }).optional())
    .query(async ({ input }) => {
      return listSelfApprovalRecords({ from: input?.from, to: input?.to });
    }),
});
