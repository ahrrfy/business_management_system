// نافذة إغلاق الوردية (عدّ النقد · المطابقة · Z-report).
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import { fmtDate } from "@/lib/date";
import { notify } from "@/lib/notify";
import { D, formatIqd } from "@/lib/money";
import { releaseReservedPrintWindow, reservePrintWindow } from "@/lib/printing/brand";
import { printShiftClose } from "@/lib/printing/print";
import { readShiftOutboxSummary, subscribeOutbox } from "@/lib/offline/outbox";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { Check, AlertTriangle } from "lucide-react";
import { paymentMethodLabel, paymentMethodClass } from "@/lib/paymentMethod";
import { POS_STATION_LABEL, type PosStation } from "@shared/permissions";
import { MoneyInput } from "@/components/form/MoneyInput";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  SHIFT_VARIANCE_CODES,
  SHIFT_VARIANCE_LABELS,
  type ShiftVarianceCode,
} from "@shared/shiftCashGovernance";
import { type ShiftData, fmt, type PosColors as C } from "./posShared";
import { useModalFocus } from "./useModalFocus";
import { ShiftCashReconciliationMini } from "./ShiftCashReconciliationMini";
import { CardBrandLogos } from "@/components/ui/CardBrandLogos";

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
  // الوردية موسومةً «مُزامنة لاحقاً» في التقرير). محصور بوردية الكاشير الحالية كي لا تحجبها مبيعات محطة أخرى.
  const [outboxQueued, setOutboxQueued] = useState({ count: 0, total: 0 });
  useEffect(() => {
    let alive = true;
    const load = () => {
      void readShiftOutboxSummary(shift?.id).then((s) => {
        if (alive) setOutboxQueued({ count: s.queued, total: s.queuedTotal });
      });
    };
    load();
    const off = subscribeOutbox(load);
    return () => { alive = false; off(); };
  }, [shift?.id]);
  const closeBlocked = outboxQueued.count > 0;

  const reportQ = trpc.shifts.report.useQuery(
    { shiftId: shift!.id },
    { enabled: !!shift }
  );
  const report = reportQ.data;

  const closeShift = trpc.shifts.close.useMutation({
    onSuccess: async (r) => {
      const rep = report;
      const deptLabel = shift?.shiftType && shift.shiftType in POS_STATION_LABEL
        ? POS_STATION_LABEL[shift.shiftType as PosStation]
        : undefined;
      void printShiftClose({
        shiftId:        r.shiftId,
        openedAt:       shift?.openedAt ?? null,
        closedAt:       new Date(),
        cashierName:    me?.name ?? "كاشير",
        branchName:     (branches ?? []).find((b) => Number(b.id) === branchId)?.name ?? `فرع #${branchId}`,
        departmentName: deptLabel,
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
      }).catch(() => {}).finally(() => releaseReservedPrintWindow());
      if (r.treasuryReturn) {
        notify.ok(
          `أُغلقت الوردية ورُحّل ${formatIqd(r.countedCash)} إلى الخزينة تلقائياً`,
          `سند الترحيل ${r.treasuryReturn.handoverNumber}`,
        );
      }
      await utils.shifts.current.invalidate();
      onClosed();
    },
    onError: (e) => { releaseReservedPrintWindow(); notify.errBig(e); },
  });

  const [varianceReasonCode, setVarianceReasonCode] = useState<ShiftVarianceCode | "">("");
  const [varianceReason, setVarianceReason] = useState("");
  const [managerApprovedByUserId, setManagerApprovedByUserId] = useState<number | "">("");

  useEffect(() => {
    setVarianceReasonCode("");
    setVarianceReason("");
    setManagerApprovedByUserId("");
  }, [shift?.id]);

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

  const approversQ = trpc.shifts.eligibleVarianceApprovers.useQuery(undefined, {
    enabled: hasVariance && !isElevatedRole,
  });

  const canCloseWithVariance = isElevatedRole
    ? !!(varianceReasonCode && varianceReason.trim())
    : !!(varianceReasonCode && varianceReason.trim() && managerApprovedByUserId);

  const closeDisabled = !counted || closeShift.isPending || closeBlocked || (hasVariance && !canCloseWithVariance);
  const closeLabel = closeShift.isPending
    ? ACTION_LABELS.closing
    : closeBlocked
      ? "أكمل المزامنة أولاً"
      : hasVariance
        ? canCloseWithVariance
          ? isElevatedRole
            ? "إغلاق معتمد وطباعة Z"
            : "إغلاق باعتماد المدير وطباعة Z"
          : isElevatedRole
            ? "حدد سبب الفرق وبيانه"
            : "يتطلب اعتماد المدير وبيان السبب"
        : "إغلاق وطباعة Z";
  // متغيّرات عددية للعرض ولتفادي تغييرات JSX الأكبر
  const openingBal  = openingD.toNumber();
  const diff        = diffD?.toNumber() ?? null;

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgb(0 0 0/.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif" }}>
      <div onClick={(e) => e.stopPropagation()} ref={modalRef} role="dialog" aria-modal="true" aria-label="إغلاق الوردية"
        style={{ background: C.card, borderRadius: 18, padding: "24px 26px", width: "min(490px, 96vw)", boxShadow: "0 24px 64px rgb(0 0 0/.32)", animation: "popIn .2s ease", maxHeight: "90vh", overflowY: "auto" }}>

        <div style={{ fontWeight: 900, fontSize: 19, marginBottom: 4, color: C.fg }}>إغلاق الوردية #{shift?.id}</div>
        <div style={{ fontSize: 12.5, color: C.mutedFg, marginBottom: 14 }}>
          {fmtDate(new Date())}
        </div>

        {reportQ.isLoading ? (
          <div style={{ padding: "24px 0", textAlign: "center", color: C.mutedFg }}>جارٍ تحميل التقرير…</div>
        ) : (
          <>
            {/* ملخص الفواتير للمعلومة فقط */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, padding: "8px 12px", background: "color-mix(in oklch, var(--muted) 35%, transparent)", borderRadius: 10, marginBottom: 6 }}>
              <span style={{ color: C.mutedFg }}>ملخص فواتير البيع</span>
              <span style={{ fontWeight: 700, color: C.fg }}>
                {report?.invoiceCount ?? 0} فاتورة · {fmt(Number(report?.salesTotal ?? 0))} د.ع
              </span>
            </div>

            {outboxQueued.count > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, padding: "7px 10px", background: C.amberSoft, borderRadius: 8, marginBottom: 8, color: C.fg }}>
                <span>مبيعات غير مُزامنة (نقدها بالدرج)</span>
                <span style={{ fontWeight: 700 }}>{outboxQueued.count} فاتورة · {fmt(outboxQueued.total)} د.ع</span>
              </div>
            )}

            {/* تفصيل وبيان نقد الوردية ومصادر النقد المتوقع */}
            <ShiftCashReconciliationMini
              cashReconciliation={report?.cashReconciliation}
              invoiceCount={report?.invoiceCount ?? 0}
              salesTotal={report?.salesTotal ?? "0"}
              openingBalance={openingBal}
              expectedCash={expectedD?.toNumber() ?? 0}
              showExpected={showExpected}
            />

            {/* Payment breakdown — طرق الدفع غير النقدية لتوضيح أنها لا تدخل نقد الدرج */}
            {(report?.payments ?? []).filter((p) => Number(p.total) > 0 && p.method !== "CASH").length > 0 && (
              <div style={{ margin: "10px 0 4px", fontSize: 12, color: C.mutedFg, fontWeight: 700 }}>طرق دفع غير نقدية بالوردية:</div>
            )}
            {(report?.payments ?? []).filter((p) => Number(p.total) > 0 && p.method !== "CASH").map((p) => (
              <div key={`${p.method}-${p.direction}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, padding: "5px 0", borderBottom: `1px dashed ${C.border}` }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${paymentMethodClass(p.method)}`}>
                    {p.method === "CARD" && <CardBrandLogos size="xs" />}
                    <span>{paymentMethodLabel(p.method)}</span>
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
              <div style={{ marginTop: 14, padding: 12, border: `1.5px solid ${C.amber}`, borderRadius: 9, background: C.amberSoft }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: C.fg, marginBottom: 6 }}>
                  يوجد فرق نقدي ({diffD != null && diffD.gt(0) ? "زيادة" : "عجز"} بقيمة {diffD != null ? fmt(diffD.abs().toNumber()) : 0} د.ع)
                </div>
                <div style={{ fontSize: 12, color: C.mutedFg, marginBottom: 10 }}>
                  {isElevatedRole
                    ? "بصفتك مديراً/مسؤولاً، يرجى تحديد سبب الفرق وكتابة التبرير لاعتماده وإغلاق الوردية وتصفير الدرج."
                    : "إغلاق الوردية مع وجود فرق نقدي يتطلب توثيق سبب الفرق وبيانه وموافقة مدير الفرع."}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {!isElevatedRole && (
                    <div>
                      <label style={{ display: "block", fontSize: 12, fontWeight: 700, marginBottom: 4, color: C.fg }}>
                        المدير المعتمد للفرق:
                      </label>
                      <select
                        value={managerApprovedByUserId}
                        onChange={(e) => setManagerApprovedByUserId(e.target.value ? Number(e.target.value) : "")}
                        style={{ width: "100%", height: 36, borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, color: C.fg, padding: "0 8px", fontSize: 12.5 }}
                      >
                        <option value="">-- اختر مديراً للاعتماد --</option>
                        {(approversQ.data ?? []).map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} ({m.role === "admin" ? "إدارة عامة" : "مدير فرع"})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <label style={{ display: "block", fontSize: 12, fontWeight: 700, marginBottom: 4, color: C.fg }}>
                      سبب الفرق:
                    </label>
                    <select
                      value={varianceReasonCode}
                      onChange={(e) => setVarianceReasonCode(e.target.value as ShiftVarianceCode)}
                      style={{ width: "100%", height: 36, borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, color: C.fg, padding: "0 8px", fontSize: 12.5 }}
                    >
                      <option value="">-- اختر سبب الفرق --</option>
                      {SHIFT_VARIANCE_CODES.map((code) => (
                        <option key={code} value={code}>
                          {SHIFT_VARIANCE_LABELS[code]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: 12, fontWeight: 700, marginBottom: 4, color: C.fg }}>
                      بيان وتبرير الفرق:
                    </label>
                    <input
                      type="text"
                      value={varianceReason}
                      onChange={(e) => setVarianceReason(e.target.value)}
                      placeholder="اكتب توضيحاً تفصيلياً لسبب الفرق..."
                      style={{ width: "100%", height: 36, borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, color: C.fg, padding: "0 8px", fontSize: 12.5 }}
                    />
                  </div>
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
                onClick={() => {
                  if (!shift) return;
                  reservePrintWindow();
                  closeShift.mutate({
                    shiftId: shift.id,
                    countedCash: counted,
                    varianceReasonCode: hasVariance && varianceReasonCode ? (varianceReasonCode as ShiftVarianceCode) : undefined,
                    varianceReason: hasVariance && varianceReason.trim() ? varianceReason.trim() : undefined,
                    managerApprovedByUserId: hasVariance && !isElevatedRole && managerApprovedByUserId ? Number(managerApprovedByUserId) : undefined,
                  });
                }}
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
