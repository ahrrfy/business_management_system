// رأس إجماليّات لوحة الدفع (خصم رأس الفاتورة + التقريب النقديّ + الصافي).
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import { X, Percent, Tag } from "lucide-react";
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
  invoiceDiscountType?: "percent" | "amount";
  invoiceDiscountValue?: string;
  onInvoiceDiscountChange?: (value: string, type: "percent" | "amount") => void;
  maxDiscountAmount?: number;
}

/** رأس الإجماليّات: المجموع قبل الخصم · خصم رأس الفاتورة (نسبة/مبلغ) · التقريب النقديّ · الصافي. */
export function PaymentTotals({
  C, ultra, fluid, total, subtotal, invoiceDiscountAmount, invoiceDiscountPct, setInvoiceDiscountPct,
  invoiceDiscountAllowed, effectiveHeaderCapPct, cashRoundingDelta,
  invoiceDiscountType = "percent", invoiceDiscountValue, onInvoiceDiscountChange, maxDiscountAmount = 0,
}: PaymentTotalsProps) {
  const currentType = invoiceDiscountType;
  const currentValue = invoiceDiscountValue ?? invoiceDiscountPct;
  const nextType = currentType === "percent" ? "amount" : "percent";

  const handleToggleType = () => {
    if (!onInvoiceDiscountChange) return;
    if (!currentValue || currentValue.trim() === "" || Number(currentValue) === 0) {
      onInvoiceDiscountChange("", nextType);
      return;
    }
    if (nextType === "amount") {
      const amt = Math.round(invoiceDiscountAmount);
      onInvoiceDiscountChange(amt > 0 ? String(amt) : "", "amount");
    } else {
      if (subtotal > 0 && invoiceDiscountAmount > 0) {
        const pct = Math.min(effectiveHeaderCapPct, (invoiceDiscountAmount / subtotal) * 100);
        const pctStr = Number.isInteger(pct) ? String(pct) : pct.toFixed(2).replace(/\.?0+$/, "");
        onInvoiceDiscountChange(pctStr, "percent");
      } else {
        onInvoiceDiscountChange("", "percent");
      }
    }
  };

  const handleValueChange = (src: string) => {
    if (src === "") {
      if (onInvoiceDiscountChange) onInvoiceDiscountChange("", currentType);
      else setInvoiceDiscountPct("");
      return;
    }
    const norm = src.replace(/[،,]/g, ".");
    if (!/^\d+\.?\d*$|^\d*\.\d+$/.test(norm)) return;
    const n = Number(norm);
    if (!Number.isFinite(n) || n < 0) return;

    if (currentType === "percent") {
      if (n > effectiveHeaderCapPct) {
        const capStr = Number.isInteger(effectiveHeaderCapPct)
          ? String(effectiveHeaderCapPct)
          : effectiveHeaderCapPct.toFixed(2).replace(/\.?0+$/, "");
        if (onInvoiceDiscountChange) onInvoiceDiscountChange(capStr, "percent");
        else setInvoiceDiscountPct(capStr);
        return;
      }
      if (onInvoiceDiscountChange) onInvoiceDiscountChange(norm, "percent");
      else setInvoiceDiscountPct(norm);
    } else {
      const maxAmt = maxDiscountAmount > 0 ? maxDiscountAmount : Math.floor(subtotal * (effectiveHeaderCapPct / 100));
      if (n > maxAmt && maxAmt > 0) {
        if (onInvoiceDiscountChange) onInvoiceDiscountChange(String(Math.floor(maxAmt)), "amount");
        return;
      }
      if (onInvoiceDiscountChange) onInvoiceDiscountChange(norm, "amount");
    }
  };

  const handleClear = () => {
    if (onInvoiceDiscountChange) onInvoiceDiscountChange("", currentType);
    else setInvoiceDiscountPct("");
  };

  return (
    <div style={{ padding: ultra ? "3px 10px" : "5px 10px", background: C.muted, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
      {/* المجموع قبل الخصم */}
      {invoiceDiscountAmount > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
          <span style={{ fontSize: 11, color: C.mutedFg, fontWeight: 600 }}>المجموع قبل الخصم</span>
          <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 700, direction: "ltr", color: C.mutedFg, textDecoration: "line-through" }}>{fmt(subtotal)}</span>
            <span style={{ fontSize: 10.5, color: C.mutedFg }}>د.ع</span>
          </div>
        </div>
      )}
      {/* خصم على الفاتورة */}
      <div
        role="group"
        aria-label="خصم على الفاتورة"
        title={invoiceDiscountAllowed
          ? (currentType === "percent"
              ? `اكتب نسبة الخصم (0 إلى ${Number.isInteger(effectiveHeaderCapPct) ? effectiveHeaderCapPct : effectiveHeaderCapPct.toFixed(2).replace(/\.?0+$/, "")}٪)`
              : `اكتب مبلغ الخصم بالدينار (أقصى: ${fmt(maxDiscountAmount)} د.ع)`)
          : "خصم رأس الفاتورة غير متاح لسلّة الكروت الرقمية"}
        style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: 3, gap: 6,
          padding: "3px 8px",
          borderRadius: 7,
          border: `${invoiceDiscountAmount > 0 ? 2 : 1.5}px ${invoiceDiscountAmount > 0 ? "solid" : "dashed"} ${invoiceDiscountAmount > 0 ? C.amber : C.border}`,
          background: invoiceDiscountAmount > 0 ? C.amberSoft : C.card,
          transition: "border-color .12s, background .12s",
        }}
      >
        {/* التسمية وسقف الخصم */}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0, flexShrink: 1 }}>
          <Tag aria-hidden size={13} strokeWidth={2.5} style={{ color: invoiceDiscountAmount > 0 ? C.amber : C.fg, flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, color: invoiceDiscountAmount > 0 ? C.amber : C.fg, fontWeight: 800, whiteSpace: "nowrap" }}>
            خصم الفاتورة
          </span>
          {invoiceDiscountAllowed ? (
            <span style={{ color: C.mutedFg, fontWeight: 600, fontSize: 10.5, direction: "ltr", whiteSpace: "nowrap" }}>
              {currentType === "percent"
                ? `(0–${Number.isInteger(effectiveHeaderCapPct) ? effectiveHeaderCapPct : effectiveHeaderCapPct.toFixed(1)}٪)`
                : `(أقصى: ${fmt(maxDiscountAmount > 0 ? maxDiscountAmount : Math.floor(subtotal * (effectiveHeaderCapPct / 100)))})`}
            </span>
          ) : (
            <span style={{ color: C.mutedFg, fontWeight: 500, fontSize: 11, whiteSpace: "nowrap" }}>(غير متاحٍ للكروت)</span>
          )}
        </div>

        {/* المبلغ المخصوم + زر المسح + صندوق الإدخال مع زر التبديل */}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          {invoiceDiscountAmount > 0 && (
            <>
              <span style={{ fontSize: 11, color: C.amber, fontWeight: 900, direction: "ltr", whiteSpace: "nowrap" }}>
                {currentType === "amount"
                  ? (subtotal > 0 ? `(${((invoiceDiscountAmount / subtotal) * 100).toFixed(0)}%)` : "")
                  : `−${fmt(invoiceDiscountAmount)} د.ع`}
              </span>
              <button
                type="button"
                onClick={handleClear}
                aria-label="إزالة خصم الفاتورة"
                title="إزالة الخصم"
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, border: "none", background: "transparent", color: C.amber, cursor: "pointer", padding: 0, borderRadius: 3 }}
              >
                <X aria-hidden size={13} strokeWidth={2.5} />
              </button>
            </>
          )}
          {/* صندوق الإدخال مدمج مع زر التبديل باتجاه LTR ثابت */}
          <div style={{
            display: "inline-flex",
            alignItems: "center",
            direction: "ltr",
            border: `1.5px solid ${invoiceDiscountAmount > 0 ? C.amber : C.primary}`,
            borderRadius: 6,
            background: C.card,
            height: 28,
            padding: "0 2px",
            boxShadow: invoiceDiscountAmount > 0 ? `0 0 0 2px color-mix(in oklch, ${C.amber} 30%, transparent)` : "none",
          }}>
            <input
              type="text"
              inputMode="decimal"
              value={currentValue}
              onChange={(e) => handleValueChange(e.target.value)}
              onBlur={(e) => {
                const raw = e.target.value.trim();
                if (raw === "" || raw === "0" || raw === "0.") { handleClear(); return; }
                const n = Number(raw);
                if (!Number.isFinite(n) || n <= 0) { handleClear(); return; }
              }}
              placeholder="0"
              aria-label={currentType === "percent" ? "نسبة خصم الفاتورة" : "مبلغ خصم الفاتورة بالدينار"}
              disabled={!invoiceDiscountAllowed}
              style={{
                width: currentType === "percent" ? 38 : 52,
                height: 24,
                border: "none",
                outline: "none",
                background: "transparent",
                color: C.fg,
                fontSize: 13,
                fontWeight: 900,
                textAlign: "center",
                direction: "ltr",
                fontFamily: "inherit",
              }}
            />
            <button
              type="button"
              onClick={handleToggleType}
              disabled={!invoiceDiscountAllowed}
              title={currentType === "percent" ? "الخصم كنسبة مئوية — اضغط للتحويل إلى مبلغ ثابت بالدينار" : "الخصم كمبلغ ثابت — اضغط للتحويل إلى نسبة مئوية"}
              aria-label={currentType === "percent" ? "تحويل الخصم إلى مبلغ ثابت بالدينار" : "تحويل الخصم إلى نسبة مئوية"}
              style={{
                height: 22,
                padding: "0 5px",
                borderRadius: 4,
                border: `1px solid ${C.border}`,
                background: currentType === "amount" ? C.amberSoft : C.muted,
                color: currentType === "amount" ? C.amber : C.primary,
                fontFamily: "inherit",
                fontSize: 10.5,
                fontWeight: 900,
                cursor: invoiceDiscountAllowed ? "pointer" : "not-allowed",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                userSelect: "none",
              }}
            >
              {currentType === "percent" ? "%" : "د.ع"}
            </button>
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
