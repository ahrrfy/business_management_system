/**
 * فروعُ مصدرٍ **خدمتُه تقصر غيرَ الأدمن على فرعه** — دالّةٌ نقيّة (بلا قاعدة) تُختبَر بلا قاعدة.
 *
 * `assertBranchScope` في `cashVarianceService` ترفض لغير `admin` أيَّ فرعٍ غيرَ فرعه، فالأدمن على
 * «كلّ الفروع» يُعدِّد فروعَ النطاق كلَّها (كما تفعل مصادر المشتريات) وغيرُه فرعَه المُسنَد وحده.
 * كان المصدر يستبدل `actor.branchId` حين يكون النطاق «كلّ الفروع» فتختفي قضايا الفروع الأخرى
 * من صندوق الأدمن (Codex على #1004).
 */
export function serviceBranchScopedIds(
  actor: { role: string; branchId: number | null },
  scopeBranchIds: number[] | null,
  allBranchIds: number[],
): number[] {
  if (actor.role === "admin") return scopeBranchIds ?? allBranchIds;
  if (actor.branchId == null) return [];
  return scopeBranchIds ? scopeBranchIds.filter((b) => b === actor.branchId) : [actor.branchId];
}
