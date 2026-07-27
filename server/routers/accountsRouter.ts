// شجرة الحسابات — راوتر قراءة (P0، الدفتر المزدوج). خلف بوّابة التقارير (بيانات مالية مرجعية،
// نفس خط §٦: manager/accountant/auditor + منح صريح). لا كتابة بعد — الجدول بياناتٌ تُبذَر بالهجرة.
import { chartOfAccounts, listAccounts } from "../services/accountsService";
import { reportViewerProcedure, router } from "../trpc";

export const accountsRouter = router({
  /** الشجرة مجموعةً حسب النوع (لعرض الواجهة). */
  tree: reportViewerProcedure.query(() => chartOfAccounts()),
  /** كل الحسابات مسطّحةً مرتّبة. */
  list: reportViewerProcedure.query(() => listAccounts()),
});
