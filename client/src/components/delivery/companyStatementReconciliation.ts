/**
 * مطابقةُ كشف شركة التوصيل — المنطق النقيّ (برنامج v2 م١ PR-C، ٥/٩/٢٦).
 *
 * إيقاعُ الشركة: الكشفُ الورقيّ يصل بأسطره، والموظّف يحدّد في «تسوية المناديب» ما ورد فيه وبأيّ مبلغ.
 * هذه الدالّة تقارن **ما حُدِّد** بـ**ما يعرفه النظام** عن طرود الجهة القابلة للتسوية فتُصدر ثلاث فئات:
 *   · مطابق  — سطرٌ في الكشف بمبلغٍ = متبقّي الطرد عندنا (ويشمل إثباتَ تسليمٍ بلا نقد لطردٍ بلا متبقٍّ).
 *   · مختلف  — سطرٌ في الكشف بمبلغٍ ≠ المتبقّي: أقلّ (فرقٌ يبقى على الزبون) أو أكثر (يرفضه الخادم).
 *   · مفقود  — طردٌ يعرفه النظام ولم يرد في الكشف — يبقى مفتوحاً خارج هذا التوريد ويستحقّ سؤال الشركة.
 * لا حكمَ ماليّاً هنا: الخادم وحده يُثبت ويُورّد؛ هذه مرآةٌ تُظهر الفرق قبل التأكيد بدل اكتشافه بعده.
 */
export interface StatementReconcileLine {
  consignmentId: number;
  consignmentNumber: string;
  /** متبقّي الطرد الحيّ عندنا (نصّ مالٍ). */
  remaining: string;
  /** هل حدّده الموظّف سطراً من الكشف؟ */
  selected: boolean;
  /** المبلغ المُدخَل من الكشف (نصّ مالٍ؛ "0" = إثبات تسليمٍ بلا نقد). */
  collected: string;
}

export type StatementLineVerdict = "MATCHED" | "MISMATCH" | "MISSING";

export interface StatementReconciledLine {
  consignmentId: number;
  consignmentNumber: string;
  verdict: StatementLineVerdict;
  remaining: string;
  collected: string;
  /** المُدخَل − المتبقّي (منزلتان)؛ "0.00" للمطابق والمفقود. */
  diff: string;
}

export interface StatementReconciliation {
  matched: number;
  mismatch: number;
  missing: number;
  lines: StatementReconciledLine[];
}

const toNum = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const money2 = (n: number): string => n.toFixed(2);

export function reconcileCompanyStatement(lines: StatementReconcileLine[]): StatementReconciliation {
  const out: StatementReconciledLine[] = [];
  let matched = 0, mismatch = 0, missing = 0;
  for (const l of lines) {
    const remaining = toNum(l.remaining);
    if (!l.selected) {
      missing++;
      out.push({ consignmentId: l.consignmentId, consignmentNumber: l.consignmentNumber, verdict: "MISSING", remaining: money2(remaining), collected: "0.00", diff: "0.00" });
      continue;
    }
    const collected = toNum(l.collected);
    const diff = collected - remaining;
    if (Math.abs(diff) < 0.005) {
      matched++;
      out.push({ consignmentId: l.consignmentId, consignmentNumber: l.consignmentNumber, verdict: "MATCHED", remaining: money2(remaining), collected: money2(collected), diff: "0.00" });
    } else {
      mismatch++;
      out.push({ consignmentId: l.consignmentId, consignmentNumber: l.consignmentNumber, verdict: "MISMATCH", remaining: money2(remaining), collected: money2(collected), diff: money2(diff) });
    }
  }
  return { matched, mismatch, missing, lines: out };
}

export const STATEMENT_VERDICT_LABEL_AR: Readonly<Record<StatementLineVerdict, string>> = Object.freeze({
  MATCHED: "مطابق",
  MISMATCH: "مختلف",
  MISSING: "مفقود",
});

export const STATEMENT_VERDICT_HINT_AR: Readonly<Record<StatementLineVerdict, string>> = Object.freeze({
  MATCHED: "ورد في الكشف بمبلغٍ يساوي متبقّي الطرد عندنا",
  MISMATCH: "ورد في الكشف بمبلغٍ يخالف المتبقّي — الأقلّ يبقى ذمّةً على الزبون، والأكثر يرفضه الخادم",
  MISSING: "طردٌ نعرفه ولم يرد في الكشف — يبقى مفتوحاً خارج هذا التوريد؛ اسأل الشركة عنه",
});

/** أرقام الطرود لفئةٍ ما — للعرض المختصر (أوّل `limit` ثمّ «+n»). */
export function verdictNumbers(rec: StatementReconciliation, verdict: StatementLineVerdict, limit = 5): { shown: string[]; more: number } {
  const all = rec.lines.filter((l) => l.verdict === verdict).map((l) => l.consignmentNumber);
  return { shown: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}
