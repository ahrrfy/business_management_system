// رأس إجماليّات لوحة الدفع (خصم رأس الفاتورة + التقريب النقديّ + الصافي).
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import { X, Percent } from "lucide-react";
import { type FluidFn, fmt, type PosColors as C } from "./posShared";

export interface PaymentTotalsProps {
  C: C;
  ultra: boolean;
  fluid: FluidFn;
  total: number;
  subtotal: number;
  invoiceDiscountAmount: number;
  invoiceDiscountPct: string;
  setInvoiceDiscountPct: (value: string) => void;
  invoiceDiscountAllowed: boolean;
  effectiveHeaderCapPct: number;
  cashRoundingDelta: number;
}

/** رأس الإجماليّات: المجموع قبل الخصم · خصم رأس الفاتورة (٠–١٥٪) · التقريب النقديّ · الصافي. */
export function PaymentTotals({ C, ultra, fluid, total, subtotal, invoiceDiscountAmount, invoiceDiscountPct, setInvoiceDiscountPct, invoiceDiscountAllowed, effectiveHeaderCapPct, cashRoundingDelta }: PaymentTotalsProps) {
  return (
    <div style={{ padding: ultra ? "4px 13px" : "8px 13px", background: C.muted, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
      {/* المجموع قبل الخصم — يُعرض فقط عند تطبيق خصم رأس فاتورة، ليتحقّق الكاشير من الفرق أمام العميل. */}
      {invoiceDiscountAmount > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
          <span style={{ fontSize: 11.5, color: C.mutedFg, fontWeight: 600 }}>المجموع قبل الخصم</span>
          <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
            <span style={{ fontSize: 13.5, fontWeight: 700, direction: "ltr", color: C.mutedFg, textDecoration: "line-through" }}>{fmt(subtotal)}</span>
            <span style={{ fontSize: 11, color: C.mutedFg }}>د.ع</span>
          </div>
        </div>
      )}
      {/* خصم على الفاتورة (٢٢/٨) — سلطة الكاشير مقصورة على ١٥٪ (قرار المالك)؛ فوقه بوّابة مدير خادمياً.
          صار (٢٣/٨) بارزاً بصرياً: بلاغُ المالك «الخصم غير ظاهر» — الحقلُ كان ١١٫٥px بعرضٍ ٤٢px
          يبتلعه رأس الإجمالي. أعِيدَ تصميمُه بأيقونةٍ ولوحةٍ صريحة و`title` تصف السقف، فيراه
          الكاشير عند كلّ حساب. سقفٌ فعّال ديناميّ يقصّ الانحرافَ المسبق (عرض/خصم يدويّ). */}
      <div
        role="group"
        aria-label="خصم على الفاتورة"
        title={invoiceDiscountAllowed
          ? `اكتب نسبة الخصم (0 إلى ${Number.isInteger(effectiveHeaderCapPct) ? effectiveHeaderCapPct : effectiveHeaderCapPct.toFixed(2).replace(/\.?0+$/, "")}٪) — فوق السقف يلزم اعتماد مدير`
          : "خصم رأس الفاتورة غير متاح لسلّة الكروت الرقمية"}
        style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: 4, gap: 8,
          padding: "6px 10px",
          borderRadius: 8,
          border: `${invoiceDiscountAmount > 0 ? 2 : 1.5}px ${invoiceDiscountAmount > 0 ? "solid" : "dashed"} ${invoiceDiscountAmount > 0 ? C.amber : C.border}`,
          background: invoiceDiscountAmount > 0 ? C.amberSoft : C.card,
          transition: "border-color .12s, background .12s",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, color: invoiceDiscountAmount > 0 ? C.amber : C.fg, fontWeight: 800, flexShrink: 0 }}>
          <Percent aria-hidden size={14} strokeWidth={2.5} />
          خصم على الفاتورة
          {invoiceDiscountAllowed ? (
            /* bidi: "0–15٪" بلا اتجاهٍ صريح يُعاد ترتيبه بصرياً "15-0٪" داخل الكاشير RTL — نفس
               عطب دلاء الأعمار المُصلَح في ReportShell (٣/٩)؛ السطر المجاور "قبل الخصم" يضبط
               direction:"ltr" بالفعل، وهذا كان الوحيد الناقص. */
            <span style={{ color: C.mutedFg, fontWeight: 600, fontSize: 11, direction: "ltr" }}>
              (0–{Number.isInteger(effectiveHeaderCapPct) ? effectiveHeaderCapPct : effectiveHeaderCapPct.toFixed(2).replace(/\.?0+$/, "")}٪)
            </span>
          ) : (
            <span style={{ color: C.mutedFg, fontWeight: 500, fontSize: 11 }}>(غير متاحٍ للكروت)</span>
          )}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {invoiceDiscountAmount > 0 && (
            <>
              <span style={{ fontSize: 12.5, color: C.amber, fontWeight: 900, direction: "ltr" }}>
                −{fmt(invoiceDiscountAmount)}
              </span>
              <button
                type="button"
                onClick={() => setInvoiceDiscountPct("")}
                aria-label="إزالة خصم الفاتورة"
                title="إزالة الخصم"
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, border: "none", background: "transparent", color: C.amber, cursor: "pointer", padding: 0, borderRadius: 4 }}
              >
                <X aria-hidden size={14} strokeWidth={2.5} />
              </button>
            </>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 2, border: `2px solid ${invoiceDiscountAmount > 0 ? C.amber : C.primary}`, borderRadius: 8, background: C.card, height: 32, padding: "0 6px", boxShadow: invoiceDiscountAmount > 0 ? `0 0 0 3px color-mix(in oklch, ${C.amber} 35%, transparent)` : "none" }}>
            <input
              type="text"
              inputMode="decimal"
              value={invoiceDiscountPct}
              onChange={(e) => {
                // القبول الصارم: لا نمسح المحارف الممنوعة بصمت. `-` أو أيّ رمزٍ غير مسموح يُرَدّ
                // إلى القيمة السابقة (لا تحويل صامت لسالبٍ إلى موجب). الفاصلةُ العربية/الأوروبية `،/,`
                // تُطبَّع إلى نقطةٍ (نفس معنى الفاصل العشريّ)، ولا نقطتان.
                // ٢٣/٨ — Codex P1: نمنع `.` منفرداً كي لا يمرّ لـD() فيرمي.
                const src = e.target.value;
                if (src === "") { setInvoiceDiscountPct(""); return; }
                const norm = src.replace(/[،,]/g, ".");
                if (!/^\d+\.?\d*$|^\d*\.\d+$/.test(norm)) return;
                const n = Number(norm);
                if (!Number.isFinite(n) || n < 0) return;
                if (n > effectiveHeaderCapPct) {
                  const capStr = Number.isInteger(effectiveHeaderCapPct)
                    ? String(effectiveHeaderCapPct)
                    : effectiveHeaderCapPct.toFixed(2).replace(/\.?0+$/, "");
                  setInvoiceDiscountPct(capStr);
                  return;
                }
                setInvoiceDiscountPct(norm);
              }}
              onBlur={(e) => {
                // تنظيف على الترك: قصّ الأصفار الرائدة وتوحيد التمثيل.
                const raw = e.target.value.trim();
                if (raw === "" || raw === "0" || raw === "0.") { setInvoiceDiscountPct(""); return; }
                const n = Number(raw);
                if (!Number.isFinite(n) || n <= 0) { setInvoiceDiscountPct(""); return; }
              }}
              placeholder="0"
              aria-label="نسبة خصم الفاتورة"
              disabled={!invoiceDiscountAllowed}
              style={{
                width: 52, height: 28, border: "none", outline: "none",
                background: "transparent", color: C.fg,
                fontSize: 15, fontWeight: 900, textAlign: "center",
                direction: "ltr", fontFamily: "inherit",
              }}
            />
            <span style={{ fontSize: 13.5, color: invoiceDiscountAmount > 0 ? C.amber : C.mutedFg, fontWeight: 800 }}>%</span>
          </div>
        </div>
      </div>
      {/* تقريبٌ نقديٌّ IQD — يظهر حين يجعل الصافيَ غير مضاعفٍ لـ٢٥٠ (النقد الكامل فقط، سياسة المالك).
          الإفصاحُ يجعل حسابَ الشاشة يطابق ما يُطبع على الإيصال (subtotal − discount ± rounding = total). */}
      {cashRoundingDelta !== 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
          <span style={{ fontSize: 11.5, color: C.mutedFg, fontWeight: 600 }}>تقريب نقديّ IQD</span>
          <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
            <span style={{ fontSize: 13.5, fontWeight: 700, direction: "ltr", color: C.mutedFg }}>
              {cashRoundingDelta > 0 ? "+" : ""}{fmt(cashRoundingDelta)}
            </span>
            <span style={{ fontSize: 11, color: C.mutedFg }}>د.ع</span>
          </div>
        </div>
      )}
      {/* الصافي — الرقم الكبير هو ما يقبضه الكاشير فعلياً من الزبون (بعد التقريب النقديّ). */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12.5, color: C.mutedFg, fontWeight: 600 }}>
          {invoiceDiscountAmount > 0 || cashRoundingDelta !== 0 ? "الصافي المستحقّ" : "إجمالي الفاتورة"}
        </span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <span style={{ fontSize: fluid(24, 3.6, 32), fontWeight: 900, direction: "ltr", letterSpacing: "-1px", color: C.fg }}>{fmt(total)}</span>
          <span style={{ fontSize: 12.5, color: C.mutedFg }}>د.ع</span>
        </div>
      </div>
    </div>
  );
}
