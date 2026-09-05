// معالجة موحّدة لعرض «سيُسجَّل سالباً» في مراجعة الجرد (StocktakeReview.tsx) — استُخرجت من
// الشاشة نفسها كي لا تكبر صفحةٌ فوق العتبة أكثر (check:page-size). المصدر الوحيد لثلاثة
// عروض: خلية المعدود المصحَّح، شارة الحالة الفردية، وتحذير حوار التأكيد.
import { AlertTriangle } from "lucide-react";
import { fmtInt } from "@/lib/money";

const nf = (n: number | null | undefined) => fmtInt(n ?? 0);
const signed = (n: number) =>
  (n > 0 ? "+" : n < 0 ? "−" : "") + fmtInt(Math.abs(n));

export interface NegativeSettlementRow {
  adjustedCount: number | null;
  diff: number | null;
  decision?: { action: "ADJUST" | "KEEP" } | null;
  withinThreshold: boolean;
}

/** هل سيكتب الاعتماد رصيداً سالباً فعلياً لهذا الصنف؟ يطابق تحديد action في finalize.ts
 * تماماً (KEEP لا يستدعي setStock أبداً) — لا نحذّر من صفٍّ لن يُسوّى فعلياً لمجرّد سالبية
 * adjustedCount (مراجعة عدائية: صنفٌ اختير له KEEP صراحةً يبقى برصيده الدفتري الحالي، وقد
 * يكون موجباً، فيُخالف التحذير الحقيقة). */
export function willRowSettleNegative(
  r: NegativeSettlementRow,
  effectiveDirectUnderThreshold: boolean,
): boolean {
  if (r.adjustedCount == null || r.adjustedCount >= 0) return false;
  if (r.diff === 0) return false;
  const action =
    r.decision?.action ??
    (r.withinThreshold && effectiveDirectUnderThreshold ? "ADJUST" : undefined);
  return action === "ADJUST";
}

/** خلية «المعدود المصحَّح» — تُلوَّن وتُعلَّم حين سيُسجَّل الصنف سالباً عند الاعتماد. */
export function CorrectedCountCell({
  adjustedCount,
  netAfter,
  rawCount,
  autoAdjust,
  willSettleNegative,
}: {
  adjustedCount: number | null;
  netAfter: number;
  rawCount: number | null;
  autoAdjust: boolean;
  willSettleNegative: boolean;
}) {
  return (
    <td
      className={`p-2.5 text-center font-mono font-bold tabular-nums ${willSettleNegative ? "text-[var(--sem-neg)]" : ""}`}
      dir="ltr"
    >
      {adjustedCount == null ? (
        "—"
      ) : (
        <span
          title={
            willSettleNegative
              ? `بيعٌ استمرّ بعد العدّ وتجاوزه — العدّ الخام ${nf(rawCount)} ${signed(netAfter)} حركات لاحقة. يُثبَّت برصيده السالب الحقيقي عند الاعتماد ويظهر في تقرير السوالب.`
              : netAfter !== 0 && autoAdjust && rawCount != null
                ? `العدّ الخام ${nf(rawCount)} ${signed(netAfter)} حركات لاحقة`
                : ""
          }
        >
          {nf(adjustedCount)}
          {willSettleNegative ? (
            <AlertTriangle
              aria-hidden
              className="ms-0.5 inline size-3 text-[var(--sem-neg)]"
            />
          ) : (
            netAfter !== 0 &&
            autoAdjust && (
              <span className="text-[10px] text-[var(--sem-info)]">*</span>
            )
          )}
        </span>
      )}
    </td>
  );
}

/** شارة الحالة لصفٍّ سيُسجَّل سالباً — إضافةٌ على شارة الحالة الرئيسية (مطابقة `tone="rose"`
 * في Pill المحلّي بالشاشة، بلا استيرادٍ عكسيّ منها). */
export function NegativeSettlementPill() {
  return (
    <span
      title="بيعٌ استمرّ بعد العدّ وتجاوزه — سيُثبَّت الرصيد سالباً حقيقياً عند الاعتماد بدل حجب الجلسة، ويظهر في تقرير السوالب للمتابعة."
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold bg-money-negative/10 text-money-negative border-money-negative/40"
    >
      <AlertTriangle aria-hidden className="size-3" /> سيُسجَّل سالباً
    </span>
  );
}

/** تحذير حوار التأكيد: N صنف سيُثبَّت برصيدٍ سالب حقيقي عند الاعتماد. */
export function NegativeSettlementBanner({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p className="flex items-start gap-1.5 rounded-md bg-money-negative/10 px-3 py-2 text-xs text-money-negative">
      <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {nf(count)} صنف سيُثبَّت برصيدٍ سالب حقيقي — بيعٌ استمرّ بعد العدّ
        وتجاوزه. لن يُحجَب الاعتماد بسببها؛ ستظهر في تقرير السوالب (المخزون ←
        تقرير السوالب) للمتابعة.
      </span>
    </p>
  );
}
