import { useState } from "react";
import { Check } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { printDoc } from "@/lib/printing/print";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { formatIqd, D } from "@/lib/money";
import { notify } from "@/lib/notify";
import { MoneyInput } from "@/components/form/MoneyInput";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { ACTION_LABELS } from "@shared/actionLabels";

type ShiftData = RouterOutputs["shifts"]["current"];

export interface PrintShiftCloseDialogColors {
  card: string;
  border: string;
  muted: string;
  mutedFg: string;
  fg: string;
  success: string;
  danger: string;
}

export interface PrintShiftCloseDialogProps {
  C: PrintShiftCloseDialogColors;
  shift: NonNullable<ShiftData>;
  isElevatedRole: boolean;
  onClose: () => void;
  onClosed: () => void;
}

const SHOP = "الرؤية العربية";
const fmt = (n: number) => Number(n || 0).toLocaleString("en-US");

export function PrintShiftCloseDialog({
  C,
  shift,
  isElevatedRole,
  onClose,
  onClosed,
}: PrintShiftCloseDialogProps) {
  const [counted, setCounted] = useState("");
  const [countEntered, setCountEntered] = useState(false);
  const utils = trpc.useUtils();
  const reportQ = trpc.shifts.report.useQuery({ shiftId: shift.id });
  const report = reportQ.data;

  const closeShift = trpc.shifts.close.useMutation({
    onSuccess: async (r) => {
      const payRows: [string, string, string][] = (report?.payments ?? []).map((p) => [
        `${paymentMethodLabel(p.method)} ${p.direction === "IN" ? "وارد" : "صادر"}`,
        String(p.count),
        String(p.total),
      ]);
      await printDoc({
        kind: "zreport",
        title: SHOP,
        subtitle: "تقرير نهاية الوردية (Z) — قسم الطباعة",
        meta: [`وردية #${r.shiftId}`, fmtDateTime(new Date())],
        columns: ["الحركة", "عدد", "مبلغ"],
        rows: payRows.length ? payRows : [["لا حركات", "0", "0.00"]],
        totals: [
          { label: "عدد الفواتير", value: String(report?.invoiceCount ?? 0) },
          { label: "إجمالي المبيعات", value: String(report?.salesTotal ?? "0.00") },
          { label: "الرصيد الافتتاحي", value: r.openingBalance },
          { label: "النقد المتوقع", value: r.expectedCash },
          { label: "النقد المعدود", value: r.countedCash },
          { label: "الفرق", value: r.variance },
          ...(r.treasuryReturn ? [
            { label: "رُحّل إلى", value: "الخزينة" },
            { label: "رقم سند الترحيل", value: r.treasuryReturn.handoverNumber },
          ] : []),
        ],
        footer: r.treasuryReturn
          ? "تم ترحيل النقد إلى الخزينة تلقائياً"
          : "نهاية الوردية — شكراً",
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
    onError: (e) => notify.err(e),
  });

  const openingBal = D(shift.openingBalance ?? 0).toNumber();
  const expected = report != null ? D(report.expectedCash).toNumber() : null;
  const showExpected = isElevatedRole || countEntered;
  const diff = showExpected && expected != null && counted ? Number(counted) - expected : null;
  const hasVariance = diff != null && Math.abs(diff) >= 0.01;
  const closeDisabled = !counted || closeShift.isPending || hasVariance;
  const closeLabel = closeShift.isPending
    ? ACTION_LABELS.closing
    : hasVariance
      ? "الإغلاق مرفوض لوجود فرق"
      : "إغلاق وطباعة Z";

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgb(0 0 0/.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        direction: "rtl",
        fontFamily: "'Cairo', system-ui, sans-serif",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card,
          borderRadius: 18,
          padding: "24px 28px",
          width: 460,
          maxHeight: "92vh",
          overflowY: "auto",
          boxShadow: "0 24px 64px rgb(0 0 0/.32)",
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 19, marginBottom: 3, color: C.fg }}>إغلاق الوردية #{shift.id}</div>
        <div style={{ fontSize: 12.5, color: C.mutedFg, marginBottom: 16 }}>{fmtDate(new Date())}</div>
        {reportQ.isLoading ? (
          <div style={{ padding: "24px 0", textAlign: "center", color: C.mutedFg }}>جارٍ تحميل التقرير…</div>
        ) : (
          <>
            {([
              ["عدد الفواتير", `${report?.invoiceCount ?? 0} فاتورة`],
              ["إجمالي المبيعات", `${fmt(Number(report?.salesTotal ?? 0))} د.ع`],
              ["الرصيد الافتتاحي", `${fmt(openingBal)} د.ع`],
              ...(expected != null && showExpected ? [["النقد المتوقع بالصندوق", `${fmt(expected)} د.ع`] as [string, string]] : []),
            ] as [string, string][]).map(([l, v]) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
                <span style={{ color: C.mutedFg }}>{l}</span>
                <span style={{ fontWeight: 700, color: C.fg }}>{v}</span>
              </div>
            ))}
            {(report?.payments ?? []).filter((p) => Number(p.total) > 0).length > 0 && (
              <div style={{ margin: "10px 0 4px", fontSize: 12, color: C.mutedFg, fontWeight: 700 }}>تفصيل طرق الدفع:</div>
            )}
            {(report?.payments ?? []).filter((p) => Number(p.total) > 0).map((p) => (
              <div key={`${p.method}-${p.direction}`} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "4px 0", borderBottom: `1px dashed ${C.border}` }}>
                <span style={{ color: C.mutedFg }}>{paymentMethodLabel(p.method)} {p.direction === "IN" ? "وارد" : "صادر"} ({p.count})</span>
                <span style={{ fontWeight: 600, color: p.direction === "OUT" ? C.danger : C.fg }}>{fmt(Number(p.total))} د.ع</span>
              </div>
            ))}
            <div
              style={{ marginTop: 16 }}
              onBlur={() => setCountEntered(counted.trim() !== "")}
            >
              <label htmlFor="print-counted-cash" style={{ display: "block", marginBottom: 6, fontSize: 13, fontWeight: 800, color: C.fg }}>
                النقد المعدود (د.ع)
              </label>
              <MoneyInput
                id="print-counted-cash"
                value={counted}
                onChange={(value) => {
                  setCounted(value);
                  setCountEntered(false);
                }}
                placeholder="0"
                ariaLabel="النقد المعدود عند إغلاق وردية الطباعة"
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
                  {diff === 0 && <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><Check aria-hidden size={14} strokeWidth={3} /> مطابق</span>}
                  {diff > 0 && <span>(زيادة)</span>}
                  {diff < 0 && <span>(عجز)</span>}
                </div>
              )}
            </div>
            {hasVariance && (
              <div style={{ marginTop: 14, padding: 12, border: `1.5px solid ${C.danger}`, borderRadius: 9, background: C.muted }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: C.danger }}>
                  لا يمكن إغلاق الوردية: النقد المعدود لا يساوي الافتتاحي مضافاً إليه صافي المبيعات النقدية المسجّلة.
                </div>
                <div style={{ marginTop: 6, fontSize: 12.5, color: C.mutedFg }}>
                  أعد العد وراجع الفواتير والمرتجعات. لا يستطيع المدير اعتماد مال بلا مصدر من شاشة الإغلاق.
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button onClick={onClose} style={{ flex: 1, height: 46, background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, color: C.fg }}>إلغاء</button>
              <button
                disabled={closeDisabled}
                onClick={() => closeShift.mutate({
                  shiftId: shift.id,
                  countedCash: counted,
                })}
                style={{ flex: 1, height: 46, background: closeDisabled ? C.muted : C.danger, color: closeDisabled ? C.mutedFg : "#fff", border: "none", borderRadius: 9, cursor: closeDisabled ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700 }}
              >
                {closeLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
