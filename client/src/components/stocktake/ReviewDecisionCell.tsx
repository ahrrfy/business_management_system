import { Button } from "@/components/ui/button";
import { RefreshCw, Scale, Check } from "lucide-react";

import { Pill } from "./ReviewDisplay";
import type { ReviewRow, ReviewRowActions, Reason } from "./ReviewRowTypes";
import { AppSelect } from "@/components/ui/AppSelect";
import { REASONS } from "./ReviewRowTypes";
export function ReviewDecisionCell({
  r,
  actions,
  reason,
}: {
  r: ReviewRow;
  actions: ReviewRowActions;
  reason: Reason;
}) {
  const {
    s,
    isOperational,
    canOperation,
    selectedForApproval,
    toggleApprovalSelection,
    setReopenFor,
    setReopenReason,
    setConflictFor,
    decide,
    onDecide,
    openRecount,
    onReasonChange,
  } = actions;
  const conflictOpen = r.conflict != null && r.conflict.resolvedPick == null;
  const uncounted = r.rawCount == null;
  const recPending = r.recount?.status === "PENDING";
  return (
    <>
      {" "}
      {/* القرار */}
      <td className="p-2.5 text-center">
        {conflictOpen ? (
          <Button
            size="sm"
            variant="outline"
            className="text-[var(--sem-neg)]"
            disabled={
              !canOperation("stocktakes.resolveConflict") ||
              !isOperational ||
              !!r.reviewApproved
            }
            onClick={() => setConflictFor(r.variantId)}
          >
            <Scale aria-hidden className="size-4" /> الفصل في التعارض
          </Button>
        ) : uncounted || recPending ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : r.diff === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-col items-center gap-1">
            {r.decision ? (
              <>
                <Pill
                  tone={r.decision.action === "ADJUST" ? "emerald" : "muted"}
                >
                  {r.decision.action === "ADJUST"
                    ? "تسوية بالمعدود"
                    : "إبقاء الدفتري"}
                </Pill>
                <p className="text-[10px] text-muted-foreground">
                  {r.decision.autoApplied || !r.decision.decidedByName
                    ? "تلقائي (ضمن الحدّ)"
                    : `بقرار ${r.decision.decidedByName}`}
                </p>
                {isOperational && !r.reviewApproved && (
                  <div className="flex flex-wrap justify-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      disabled={
                        !canOperation("stocktakes.decide") || decide.isPending
                      }
                      title="تبديل القرار"
                      onClick={() =>
                        onDecide(
                          r,
                          r.decision!.action === "ADJUST" ? "KEEP" : "ADJUST",
                        )
                      }
                    >
                      {r.decision.action === "ADJUST"
                        ? "حوّل لإبقاء"
                        : "حوّل لتسوية"}
                    </Button>
                    {/* حوكمة م٥: صفٌّ فوق الحدّ لم يُعَد عدّه بعدُ يبقى حاجزاً حتى لو
                                      اتُّخذ قراره ⇒ نُبقي زرّ إعادة العدّ ظاهراً كي لا تُقفَل الجلسة
                                      (Codex P1: كان الزرّ يختفي على الصفّ المقرَّر فيتعذّر رفع الحاجز). */}
                    {s.requireRecountOverThreshold &&
                      r.overThreshold &&
                      r.kindUsed !== "RECOUNT" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px] text-violet-700"
                          title="طلب إعادة عدّ (سبب إلزامي) — إلزاميّ فوق الحدّ"
                          onClick={() => openRecount(r)}
                          disabled={!canOperation("stocktakes.requestRecount")}
                        >
                          <RefreshCw aria-hidden className="size-3" /> إعادة عدّ
                        </Button>
                      )}
                  </div>
                )}
              </>
            ) : !r.overThreshold && s.directUnderThreshold ? (
              <>
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--sem-pos)]">
                  تسوية تلقائية <Check aria-hidden className="size-3" />
                </span>
                {isOperational && !r.reviewApproved && (
                  <div className="flex flex-wrap justify-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      disabled={
                        !canOperation("stocktakes.decide") || decide.isPending
                      }
                      title="تجاهل العدّ وإبقاء الرصيد الدفتري"
                      onClick={() => onDecide(r, "KEEP")}
                    >
                      إبقاء بدلاً
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px] text-violet-700"
                      title="طلب إعادة عدّ (سبب إلزامي)"
                      onClick={() => openRecount(r)}
                      disabled={!canOperation("stocktakes.requestRecount")}
                    >
                      <RefreshCw aria-hidden className="size-3" /> إعادة عدّ
                    </Button>
                  </div>
                )}
              </>
            ) : isOperational && !r.reviewApproved ? (
              <div className="flex flex-wrap justify-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !canOperation("stocktakes.decide") || decide.isPending
                  }
                  title="اعتماد الكمية المعدودة وتسوية الفرق"
                  onClick={() => onDecide(r, "ADJUST")}
                >
                  تسوية
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={
                    !canOperation("stocktakes.decide") || decide.isPending
                  }
                  title="تجاهل العدّ وإبقاء الرصيد الدفتري"
                  onClick={() => onDecide(r, "KEEP")}
                >
                  إبقاء
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-violet-700"
                  title="طلب إعادة عدّ (سبب إلزامي)"
                  onClick={() => openRecount(r)}
                  disabled={!canOperation("stocktakes.requestRecount")}
                >
                  <RefreshCw aria-hidden className="size-4" /> إعادة عدّ
                </Button>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
            {/* سبب الفرق — يغذي تقرير الانكماش والقيد المحاسبي */}
            <AppSelect
              value={reason}
              disabled={
                !canOperation("stocktakes.decide") ||
                !isOperational ||
                !!r.reviewApproved ||
                decide.isPending
              }
              onValueChange={(v) => onReasonChange(r, v as Reason)}
              title="سبب الفرق — يُسجَّل في تقرير الانكماش"
              aria-label="سبب الفرق"
              className={`mt-1 h-7 w-full max-w-[150px] px-1.5 text-[11px] ${
                reason !== "UNSPECIFIED"
                  ? "border-input text-foreground"
                  : "border-[var(--sem-warn)]/50 text-[var(--sem-warn)]"
              }`}
            >
              {REASONS.map((x) => (
                <option key={x.v} value={x.v}>
                  {x.v === "UNSPECIFIED" ? "السبب؟" : x.label}
                </option>
              ))}
            </AppSelect>
          </div>
        )}
      </td>
    </>
  );
}
