// نافذة إغلاق الوردية (عدّ النقد · المطابقة · Z-report).
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import { fmtDate } from "@/lib/date";
import { notify } from "@/lib/notify";
import { D, formatIqd } from "@/lib/money";
import { printShiftClose } from "@/lib/printing/print";
import { readOutboxSummary, subscribeOutbox } from "@/lib/offline/outbox";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { Check, AlertTriangle } from "lucide-react";
import { paymentMethodLabel, paymentMethodClass } from "@/lib/paymentMethod";
import { MoneyInput } from "@/components/form/MoneyInput";
import { ACTION_LABELS } from "@shared/actionLabels";
import { type ShiftData, fmt, type PosColors as C } from "./posShared";
import { useModalFocus } from "./useModalFocus";

export interface ShiftCloseDialogProps {
  C: C;
  shift: ShiftData;
  branchId: number;
  onClose: () => void;
  onClosed: () => void;
  me: RouterOutputs["auth"]["me"] | undefined;
  branches: RouterOutputs["branches"]["list"] | undefined;
}

export function ShiftCloseDialog({ C, shift, branchId, onClose, onClosed, me, branches }: ShiftCloseDialogProps) {
  const modalRef = useModalFocus<HTMLDivElement>();
  const [counted, setCounted] = useState("");
  const [countEntered, setCountEntered] = useState(false);
  const utils = trpc.useUtils();

  // ش٤ أوفلاين — حارس الطابور: إغلاق الوردية وثمة مبيعات غير مُزامنة يترك نقداً في الدرج بلا
  // فواتير في Z ⇒ محجوب افتراضياً؛ المدير/الأدمن يتجاوز بإقرار صريح (تُرحَّل لاحقاً وتدخل
  // الوردية موسومةً «مُزامنة لاحقاً» في التقرير).
  const [outboxQueued, setOutboxQueued] = useState({ count: 0, total: 0 });
  useEffect(() => {
    let alive = true;
    const load = () => {
      void readOutboxSummary().then((s) => {
        if (alive) setOutboxQueued({ count: s.queued, total: s.queuedTotal });
      });
    };
    load();
    const off = subscribeOutbox(load);
    return () => { alive = false; off(); };
  }, []);
  const closeBlocked = outboxQueued.count > 0;

  const reportQ = trpc.shifts.report.useQuery(
    { shiftId: shift!.id },
    { enabled: !!shift }
  );
  const report = reportQ.data;

  const closeShift = trpc.shifts.close.useMutation({
    onSuccess: async (r) => {
      const rep = report;
      void printShiftClose({
        shiftId:        r.shiftId,
        openedAt:       shift?.openedAt ?? null,
        closedAt:       new Date(),
        cashierName:    me?.name ?? "كاشير",
        branchName:     (branches ?? []).find((b) => Number(b.id) === branchId)?.name ?? `فرع #${branchId}`,
        openingBalance: r.openingBalance,
        invoiceCount:   rep?.invoiceCount ?? 0,
        salesTotal:     rep?.salesTotal ?? "0",
        payments:       (rep?.payments ?? []).map((p) => ({
          method:    p.method,
          direction: p.direction as "IN" | "OUT",
          count:     Number(p.count),
          total:     p.total,
        })),
        expectedCash: r.expectedCash,
        countedCash:  r.countedCash,
        variance:     r.variance,
        treasuryReturn: r.treasuryReturn
          ? {
              amount: r.countedCash,
              referenceNumber: r.treasuryReturn.handoverNumber,
            }
          : null,
      });
      if (r.treasuryReturn) {
        notify.ok(
          `أُغلقت الوردية ورُحّل ${formatIqd(r.countedCash)} إلى الخزينة تلقائياً`,
          `سند الترحيل ${r.treasuryReturn.handoverNumber}`,
        );
      }
      await utils.shifts.current.invalidate();
      onClosed();
    },
    onError: (e) => notify.errBig(e),
  });

  // النقد المتوقع يأتي من نفس مصدر حقيقة closeShift على الخادم (DRAWER حصراً).
  const openingD    = D(shift?.openingBalance ?? 0);
  // ش٤: النقد غير المُزامَن موجود فيزيائياً بالدرج ⇒ يدخل المتوقع المعروض للعدّ (الخادم عند
  // الإغلاق يحسب المُزامَن فقط، والفرق يُفسَّر لاحقاً بقسم «مُزامنة لاحقاً» في التقرير).
  const expectedD   = report != null ? D(report.expectedCash).plus(D(outboxQueued.total)) : null;
  const countedD    = counted ? D(counted) : null;
  // فقدان التركيز من حقل المعدود يُثبّت انتهاء الإدخال ويكشف المطابقة تلقائياً بلا زر إضافي.
  const isElevatedRole = me?.role === "admin" || me?.role === "manager";
  const showExpected = isElevatedRole || countEntered;
  const diffD       = showExpected && expectedD != null && countedD != null ? countedD.minus(expectedD) : null;
  const hasVariance = diffD != null && diffD.abs().gt("0.005");
  const closeDisabled = !counted || closeShift.isPending || closeBlocked || hasVariance;
  const closeLabel = closeShift.isPending
    ? ACTION_LABELS.closing
    : closeBlocked
      ? "أكمل المزامنة أولاً"
      : hasVariance
        ? "الإغلاق مرفوض لوجود فرق"
        : "إغلاق وطباعة Z";
  // متغيّرات عددية للعرض ولتفادي تغييرات JSX الأكبر
  const openingBal  = openingD.toNumber();
  const diff        = diffD?.toNumber() ?? null;

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgb(0 0 0/.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif" }}>
      <div onClick={(e) => e.stopPropagation()} ref={modalRef} role="dialog" aria-modal="true" aria-label="إغلاق الوردية"
        style={{ background: C.card, borderRadius: 18, padding: "26px 30px", width: 440, boxShadow: "0 24px 64px rgb(0 0 0/.32)", animation: "popIn .2s ease", maxHeight: "90vh", overflowY: "auto" }}>

        <div style={{ fontWeight: 900, fontSize: 19, marginBottom: 4, color: C.fg }}>إغلاق الوردية #{shift?.id}</div>
        <div style={{ fontSize: 12.5, color: C.mutedFg, marginBottom: 18 }}>
          {fmtDate(new Date())}
        </div>

        {reportQ.isLoading ? (
          <div style={{ padding: "24px 0", textAlign: "center", color: C.mutedFg }}>جارٍ تحميل التقرير…</div>
        ) : (
          <>
            {([
              ["عدد الفواتير",     `${report?.invoiceCount ?? 0} فاتورة`],
              ["إجمالي المبيعات",  `${fmt(Number(report?.salesTotal ?? 0))} د.ع`],
              ["الرصيد الافتتاحي", `${fmt(openingBal)} د.ع`],
              ...(outboxQueued.count > 0
                ? [["مبيعات غير مُزامنة (نقدها بالدرج)", `${outboxQueued.count} فاتورة · ${fmt(outboxQueued.total)} د.ع`] as [string, string]]
                : []),
              ...(report != null && showExpected
                ? [["النقد المتوقع بالصندوق", `${fmt(expectedD?.toNumber() ?? 0)} د.ع`] as [string, string]]
                : []),
            ] as [string, string][]).map(([l, v]) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
                <span style={{ color: C.mutedFg }}>{l}</span>
                <span style={{ fontWeight: 700, color: C.fg }}>{v}</span>
              </div>
            ))}

            {/* Payment breakdown — كل طريقة بلقب عربيّ + شارة ملوّنة، ليَفهَم الكاشير أنّ مبيعات
                البطاقة/التحويل/المحفظة لا تدخل نقد الدرج المتوقّع (الخادم يحسبه CASH+DRAWER فقط).
                هذا يزيل حَيرة «لماذا الفرق؟» — الفرق ليس عجزاً، البطاقة لا تُقاس بعدّ النقد. */}
            {(report?.payments ?? []).filter((p) => Number(p.total) > 0).length > 0 && (
              <div style={{ margin: "10px 0 4px", fontSize: 12, color: C.mutedFg, fontWeight: 700 }}>تفصيل طرق الدفع:</div>
            )}
            {(report?.payments ?? []).filter((p) => Number(p.total) > 0).map((p) => (
              <div key={`${p.method}-${p.direction}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, padding: "5px 0", borderBottom: `1px dashed ${C.border}` }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${paymentMethodClass(p.method)}`}>
                    {paymentMethodLabel(p.method)}
                  </span>
                  <span style={{ color: C.mutedFg }}>{p.direction === "IN" ? "وارد" : "صادر"} ({p.count})</span>
                </span>
                <span style={{ fontWeight: 700, color: p.direction === "OUT" ? C.danger : C.fg, direction: "ltr" }}>{fmt(Number(p.total))} د.ع</span>
              </div>
            ))}
            {/* تلميح تعليميّ للكاشير: يظهر فقط عند وجود مبيعات غير نقدية — يزيل حَيرة «العجز الوهميّ». */}
            {(report?.payments ?? []).some((p) => p.direction === "IN" && p.method !== "CASH" && Number(p.total) > 0) && (
              <div style={{ marginTop: 8, padding: "8px 10px", background: "color-mix(in oklch, var(--sem-info) 8%, transparent)", border: "1px solid color-mix(in oklch, var(--sem-info) 25%, transparent)", borderRadius: 7, fontSize: 11.5, color: C.mutedFg, lineHeight: 1.55 }}>
                <strong style={{ color: C.fg }}>ملاحظة:</strong> مبيعات البطاقة/التحويل/المحفظة لا تدخل عدّ نقد الدرج. عدّ النقد الفعليّ فقط — النظام يعلم بها ولن يُظهر عجزاً بسببها.
              </div>
            )}

            <div
              style={{ marginTop: 16 }}
              onBlur={() => setCountEntered(counted.trim() !== "")}
            >
              <label htmlFor="pos-counted-cash" style={{ display: "block", marginBottom: 6, fontSize: 13, fontWeight: 800, color: C.fg }}>
                النقد المعدود (د.ع)
              </label>
              <MoneyInput
                id="pos-counted-cash"
                value={counted}
                onChange={(value) => {
                  setCounted(value);
                  setCountEntered(false);
                }}
                placeholder="0"
                ariaLabel="النقد المعدود عند إغلاق الوردية"
                className="h-12 text-center text-lg font-extrabold"
              />
              {!showExpected && (
                <div style={{ marginTop: 6, fontSize: 12, color: C.mutedFg }}>
                  أدخل ما عددته فعلياً في الصندوق لتظهر نتيجة المطابقة.
                </div>
              )}
              {diff !== null && (
                <div style={{ marginTop: 7, fontSize: 14, fontWeight: 700, color: diff >= 0 ? C.success : C.danger, display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                  <span>الفرق: {diff >= 0 ? "+" : ""}{fmt(diff)} د.ع</span>
                  {diff === 0 && <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><Check aria-hidden size={14} strokeWidth={3} /> مطابق تماماً</span>}
                  {diff > 0  && <span>(زيادة)</span>}
                  {diff < 0  && <span>(عجز)</span>}
                </div>
              )}
            </div>

            {hasVariance && (
              <div style={{ marginTop: 14, padding: 12, border: `1.5px solid ${C.danger}`, borderRadius: 9, background: C.dangerSoft }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: C.danger }}>
                  لا يمكن إغلاق الوردية: النقد المعدود لا يساوي الرصيد الافتتاحي مضافاً إليه صافي المبيعات النقدية المسجّلة.
                </div>
                <div style={{ marginTop: 6, fontSize: 12.5, color: C.mutedFg }}>
                  أعد العد، ثم راجع الفواتير والمرتجعات والمزامنة. إذا بقي الفرق فاستدعِ المدير لتصحيح العملية من وحدتها المختصة؛ لا يمكن اعتماد مال بلا مصدر من شاشة الإغلاق.
                </div>
              </div>
            )}

            {/* ش٤ أوفلاين: لا مصدر مالي قبل ترحيل الفاتورة، لذلك لا يوجد تجاوز للإغلاق. */}
            {outboxQueued.count > 0 && (
              <div style={{ marginTop: 14, padding: "10px 12px", background: C.amberSoft, border: `1.5px solid ${C.amber}`, borderRadius: 9, fontSize: 12.5, color: C.fg }}>
                <div style={{ fontWeight: 800, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <AlertTriangle aria-hidden size={15} /> توجد {outboxQueued.count} فاتورة غير مُزامنة ({fmt(outboxQueued.total)} د.ع)
                </div>
                <div style={{ marginTop: 4, color: C.mutedFg }}>
                  أكمل المزامنة قبل الإغلاق (شارة المزامنة أسفل الشاشة) — نقدها في الدرج ولن تظهر في Z قبل الترحيل.
                </div>
                <div style={{ marginTop: 6, fontWeight: 700 }}>
                  لا يمكن الإغلاق قبل مزامنة الفواتير، حتى بصلاحية المدير.
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button onClick={onClose}
                style={{ flex: 1, height: 46, background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, color: C.fg }}>
                إلغاء
              </button>
              <button
                disabled={closeDisabled}
                onClick={() => shift && closeShift.mutate({
                  shiftId: shift.id,
                  countedCash: counted,
                })}
                style={{ flex: 1, height: 46, background: closeDisabled ? C.muted : C.danger, color: closeDisabled ? C.mutedFg : "#fff", border: "none", borderRadius: 9, cursor: closeDisabled ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700 }}>
                {closeLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
