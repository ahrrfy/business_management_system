import { useState } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { D, round2, formatIqd } from "@/lib/money";

export type ShiftKind = "RETAIL" | "RECEPTION";

export interface OpeningContinuity {
  loading: boolean;
  expected: string | null; // متبقّي الوردية السابقة (2dp) أو null (أوّل وردية)
  hasExpected: boolean;
  diff: string | null; // موقَّع: المُدخَل − المتوقَّع (2dp)
  hasDiscrepancy: boolean;
  reason: string;
  setReason: (v: string) => void;
  reasonRequired: boolean;
  blocked: boolean; // سبب مطلوب وفارغ ⇒ يُعطَّل زرّ الفتح
  reasonPayload: string | undefined; // يُمرَّر لـopen.mutate عند الاختلاف فقط
}

// استخراج رقمٍ آمن من مدخل المستخدم (قد يحوي حروفاً/فراغات أثناء الكتابة) بلا رمي Decimal.
function safeNum(s: string): string {
  const m = String(s).match(/^\s*(\d+(?:\.\d+)?)/);
  return m ? m[1] : "0";
}

/**
 * ①ج منطق «استمرارية نقد الورديات» المشترك لشاشات فتح الوردية (POS/PrintPOS/Reception):
 * يَجلب الرصيد الافتتاحيّ المتوقَّع (متبقّي آخر وردية مغلقة لنفس الفرع/النوع)، يقارنه بالمُدخَل،
 * ويُدير حقل السبب (إلزاميّ عند الاختلاف). للعرض/الحجب فقط؛ الفرض النهائيّ خادميّ (openShift).
 */
export function useOpeningContinuity(opts: {
  branchId: number | null | undefined;
  shiftType: ShiftKind;
  opening: string;
  enabled?: boolean;
}): OpeningContinuity {
  const enabled = (opts.enabled ?? true) && opts.branchId != null && opts.branchId > 0;
  const q = trpc.shifts.expectedOpening.useQuery(
    { branchId: Number(opts.branchId), shiftType: opts.shiftType },
    { enabled, refetchOnWindowFocus: false },
  );
  const [reason, setReason] = useState("");

  const expected = q.data?.expected ?? null;
  const hasExpected = expected != null;
  const diffD = hasExpected ? round2(D(safeNum(opts.opening)).minus(D(expected))) : null;
  const hasDiscrepancy = diffD != null && diffD.abs().gte(D("0.01"));
  const reasonRequired = hasDiscrepancy;
  const blocked = reasonRequired && reason.trim().length === 0;

  return {
    loading: enabled && q.isLoading,
    expected,
    hasExpected,
    diff: diffD ? diffD.toFixed(2) : null,
    hasDiscrepancy,
    reason,
    setReason,
    reasonRequired,
    blocked,
    reasonPayload: hasDiscrepancy ? reason.trim() || undefined : undefined,
  };
}

/* ── عرض إنلاين (POS/PrintPOS) بلوحة ألوان C ─────────────────────────────── */
type Palette = Record<string, string | undefined>;

export function OpeningContinuityInline({ C, oc }: { C: Palette; oc: OpeningContinuity }) {
  if (oc.loading) {
    return (
      <div style={{ fontSize: 12, color: C.mutedFg, marginBottom: 14 }}>
        جارٍ التحقّق من متبقّي الوردية السابقة…
      </div>
    );
  }
  if (!oc.hasExpected) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.mutedFg, marginBottom: 14 }}>
        <Info aria-hidden style={{ width: 14, height: 14, flexShrink: 0 }} />
        <span>أوّل وردية لهذا الدرج — لا رصيد سابق للمطابقة.</span>
      </div>
    );
  }
  const ok = !oc.hasDiscrepancy;
  const accent = ok ? (C.success ?? "#16a34a") : (C.amber ?? "#d97706");
  return (
    <div
      style={{
        marginBottom: 14,
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid ${ok ? C.border : accent}`,
        background: ok ? C.muted : (C.amberSoft ?? "rgba(217,119,6,.10)"),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12.5 }}>
        <span style={{ color: C.mutedFg }}>المتوقَّع (متبقّي الوردية السابقة)</span>
        <span style={{ fontWeight: 800, color: C.fg }}>{formatIqd(oc.expected)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 12.5, fontWeight: 800, color: accent }}>
        {ok ? <CheckCircle2 aria-hidden style={{ width: 15, height: 15 }} /> : <AlertTriangle aria-hidden style={{ width: 15, height: 15 }} />}
        <span>{ok ? "مطابق للمتوقَّع" : `فرقٌ عن المتوقَّع: ${formatIqd(oc.diff)}`}</span>
      </div>
      {oc.reasonRequired && (
        <div style={{ marginTop: 10 }}>
          <label style={{ fontSize: 12.5, fontWeight: 700, display: "block", marginBottom: 5, color: C.fg }}>
            سبب اختلاف الرصيد الافتتاحيّ <span style={{ color: C.danger }}>*</span>
          </label>
          <textarea
            value={oc.reason}
            onChange={(e) => oc.setReason(e.target.value.slice(0, 500))}
            rows={2}
            placeholder="مثال: إيداع فكّة من الخزينة / سحب مبلغ لإيداعه…"
            style={{
              width: "100%",
              border: `1.5px solid ${oc.blocked ? (C.danger ?? "#dc2626") : C.border}`,
              borderRadius: 9,
              background: C.card,
              color: C.fg,
              fontFamily: "inherit",
              fontSize: 13,
              padding: "8px 10px",
              outline: "none",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          {oc.blocked && (
            <div style={{ fontSize: 11.5, color: C.danger, marginTop: 4 }}>
              السبب مطلوب للمتابعة (أو صحّح الرصيد الافتتاحيّ ليطابق المتوقَّع).
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── عرض shadcn (Reception) ───────────────────────────────────────────────── */
export function OpeningContinuityCard({ oc }: { oc: OpeningContinuity }) {
  if (oc.loading) {
    return <p className="mb-3 text-xs text-muted-foreground">جارٍ التحقّق من متبقّي الوردية السابقة…</p>;
  }
  if (!oc.hasExpected) {
    return (
      <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Info aria-hidden className="size-3.5 shrink-0" />
        أوّل وردية لهذا الدرج — لا رصيد سابق للمطابقة.
      </p>
    );
  }
  const ok = !oc.hasDiscrepancy;
  return (
    <div className={`mb-3 rounded-lg border p-3 ${ok ? "bg-muted/50" : "border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-950/30"}`}>
      <div className="flex items-center justify-between gap-2 text-[13px]">
        <span className="text-muted-foreground">المتوقَّع (متبقّي الوردية السابقة)</span>
        <span className="font-extrabold tabular-nums">{formatIqd(oc.expected)}</span>
      </div>
      <div className={`mt-1.5 flex items-center gap-1.5 text-[13px] font-extrabold ${ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}>
        {ok ? <CheckCircle2 aria-hidden className="size-4" /> : <AlertTriangle aria-hidden className="size-4" />}
        <span>{ok ? "مطابق للمتوقَّع" : `فرقٌ عن المتوقَّع: ${formatIqd(oc.diff)}`}</span>
      </div>
      {oc.reasonRequired && (
        <div className="mt-2.5">
          <label className="mb-1 block text-[13px] font-bold">
            سبب اختلاف الرصيد الافتتاحيّ <span className="text-destructive">*</span>
          </label>
          <textarea
            value={oc.reason}
            onChange={(e) => oc.setReason(e.target.value.slice(0, 500))}
            rows={2}
            placeholder="مثال: إيداع فكّة من الخزينة / سحب مبلغ لإيداعه…"
            className={`w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${oc.blocked ? "border-destructive" : "border-input"}`}
          />
          {oc.blocked && (
            <p className="mt-1 text-xs text-destructive">
              السبب مطلوب للمتابعة (أو صحّح الرصيد الافتتاحيّ ليطابق المتوقَّع).
            </p>
          )}
        </div>
      )}
    </div>
  );
}
