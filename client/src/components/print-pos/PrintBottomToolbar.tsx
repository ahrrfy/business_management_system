import React, { useEffect, useState } from "react";
import {
  Banknote,
  CreditCard,
  RefreshCw,
  Clock,
  Zap,
  Check,
  Pencil,
} from "lucide-react";
import { normalizeNumberInput } from "@shared/numberNormalize";
import { ACTION_LABELS } from "@shared/actionLabels";
import { roundCashIQD } from "@/lib/money";
import { CopyButton } from "@/components/CopyButton";
import { PaymentReferenceField } from "@/components/pos/PaymentReferenceField";
import type { PrintCartLine as CartLine } from "@/components/printPos/PrintCartList";
import type { PaymentMethod, EditingInvoiceInfo } from "./PrintPosCheckout";

export interface PrintBottomToolbarProps {
  C: {
    card: string;
    border: string;
    primary: string;
    primaryFg: string;
    primarySoft: string;
    muted: string;
    mutedFg: string;
    fg: string;
    success: string;
    amber: string;
    danger: string;
  };
  cart: CartLine[];
  total: number;
  payInput: string;
  setPayInput: (u: string | ((s: string) => string)) => void;
  method: PaymentMethod;
  setMethod: (m: PaymentMethod) => void;
  paymentRef: string;
  setPaymentRef: (v: string) => void;
  externalPaymentConfirmed: boolean;
  externalFullPaymentConfirmed: boolean;
  externalPaymentPending: boolean;
  onConfirmExternalPayment: () => void;
  onPay: () => void;
  onQuickPay: () => void;
  onReserve: () => void;
  isPending: boolean;
  customerId: number | null;
  contactName: string;
  contactPhone: string;
  editingInvoice: EditingInvoiceInfo | null;
}

const METHOD_LABEL: Record<PaymentMethod, string> = { CASH: "نقدي", CARD: "بطاقة", TRANSFER: "تحويل" };
const fmt = (n: number) => Number(n || 0).toLocaleString("en-US");
const riqd = (n: number) => roundCashIQD(n).toNumber();

export function PrintBottomToolbar({
  C,
  cart,
  total,
  payInput,
  setPayInput,
  method,
  setMethod,
  paymentRef,
  setPaymentRef,
  externalPaymentConfirmed,
  externalFullPaymentConfirmed,
  externalPaymentPending,
  onConfirmExternalPayment,
  onPay,
  onQuickPay,
  onReserve,
  isPending,
  customerId,
  contactName,
  contactPhone,
  editingInvoice,
}: PrintBottomToolbarProps) {
  const [displayPay, setDisplayPay] = useState(payInput);

  useEffect(() => {
    try {
      const norm = normalizeNumberInput(displayPay).normalized;
      if (norm !== payInput) setDisplayPay(payInput);
    } catch {
      setDisplayPay(payInput);
    }
  }, [payInput]);

  const cartLen = cart.length;
  const paid = Number(payInput || 0);
  const cashTotal = method === "CASH" ? riqd(total) : total;
  const change = paid - cashTotal;
  const credit = cashTotal - paid;
  const isChange = paid > 0 && paid >= cashTotal;
  const isOwing = paid > 0 && paid < cashTotal;
  const hasZeroLine = cart.some((c) => c.price <= 0);

  const hasCustomerInfo =
    customerId != null || contactName.trim().length > 0 || contactPhone.trim().length > 0;
  const canReserve = cartLen > 0 && !hasZeroLine && hasCustomerInfo && !editingInvoice;
  const canPay =
    cartLen > 0 &&
    !hasZeroLine &&
    (editingInvoice != null ||
      ((payInput === "" || paid >= cashTotal) && (!isOwing || customerId != null) && externalPaymentConfirmed));
  const canQuickPay = cartLen > 0 && !hasZeroLine && !editingInvoice && externalFullPaymentConfirmed;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "6px 14px",
        minHeight: 56,
        flexShrink: 0,
        background: C.card,
        borderTop: `1.5px solid ${C.border}`,
        position: "relative",
        zIndex: 30,
        boxShadow: "0 -3px 12px rgba(0,0,0,0.06)",
        direction: "rtl",
        boxSizing: "border-box",
      }}
    >
      {/* ── اليمين: الإجمالي والمستلم والباقي ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {/* شارة الإجمالي */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "5px 13px",
            borderRadius: 8,
            background: C.primary,
            color: C.primaryFg,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, opacity: 0.9 }}>الإجمالي:</span>
          <span style={{ fontSize: 20, fontWeight: 900, direction: "ltr", letterSpacing: "-0.5px" }}>
            {fmt(total)}
          </span>
          <span style={{ fontSize: 11, opacity: 0.85 }}>د.ع</span>
        </div>

        {/* حقل المستلم وزر ملء الكل */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            background: C.muted,
            border: `1.5px solid ${C.border}`,
            borderRadius: 8,
            padding: "0 8px",
            height: 38,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 11.5, color: C.mutedFg, fontWeight: 700, whiteSpace: "nowrap" }}>
            {editingInvoice ? "دفعة إضافية:" : "المستلم:"}
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={displayPay}
            onChange={(e) => {
              const src = e.target.value;
              setDisplayPay(src);
              if (src === "") {
                setPayInput("");
                return;
              }
              if (!/^[\d.,،٫]*$/.test(src)) return;
              const result = normalizeNumberInput(src);
              if (result.ambiguous) return;
              const n = result.normalized;
              if (!n) return;
              if (!/^\d+\.?\d*$|^\d*\.\d+$/.test(n)) return;
              if (!Number.isFinite(Number(n))) return;
              setPayInput(n);
            }}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="0"
            aria-label="المبلغ المستلم"
            style={{
              width: 85,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 15,
              fontWeight: 900,
              direction: "ltr",
              textAlign: "center",
              fontFamily: "inherit",
              color: payInput ? (isOwing ? C.amber : C.primary) : C.fg,
            }}
          />
          <button
            type="button"
            onClick={() => setPayInput(String(cashTotal))}
            disabled={!cartLen}
            title="ملء المبلغ الإجمالي"
            style={{
              height: 24,
              minHeight: 0,
              padding: "0 7px",
              border: `1px solid ${C.primary}`,
              borderRadius: 5,
              background: C.primarySoft,
              color: C.primary,
              fontFamily: "inherit",
              fontSize: 11,
              fontWeight: 800,
              cursor: cartLen ? "pointer" : "not-allowed",
              opacity: cartLen ? 1 : 0.5,
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            = الكل
          </button>
        </div>

        {/* شارة الباقي للعميل */}
        {cartLen > 0 && !!payInput && isChange && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              background: "rgba(16, 185, 129, 0.12)",
              border: "1px solid var(--sem-pos, #10b981)",
              borderRadius: 7,
              padding: "2px 8px",
              height: 34,
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 11.5, color: "var(--sem-pos, #10b981)", fontWeight: 700 }}>
              الباقي:
            </span>
            <span style={{ fontSize: 14.5, fontWeight: 900, color: "var(--sem-pos, #10b981)", direction: "ltr" }}>
              {fmt(change)} د.ع
            </span>
            <CopyButton value={change} title="نسخ الباقي" successMessage="تم نسخ الباقي" />
          </div>
        )}

        {/* شارة المتبقي الآجل */}
        {cartLen > 0 && !!payInput && isOwing && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              background: "rgba(245, 158, 11, 0.12)",
              border: "1px solid var(--sem-warn, #f59e0b)",
              borderRadius: 7,
              padding: "2px 8px",
              height: 34,
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 11.5, color: "var(--sem-warn, #d97706)", fontWeight: 700 }}>
              المتبقي (آجل):
            </span>
            <span style={{ fontSize: 14.5, fontWeight: 900, color: "var(--sem-warn, #d97706)", direction: "ltr" }}>
              {fmt(credit)} د.ع
            </span>
            <CopyButton value={credit} title="نسخ المتبقي" successMessage="تم نسخ المتبقي" />
          </div>
        )}
      </div>

      {/* فاصل */}
      <div style={{ width: 1, height: 32, background: C.border, flexShrink: 0 }} />

      {/* ── الوسط: طرق التحصيل (نقدي / بطاقة / تحويل) ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: C.mutedFg }}>التحصيل:</span>
        <button
          type="button"
          onClick={() => setMethod("CASH")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            height: 36,
            minHeight: 0,
            padding: "0 12px",
            borderRadius: 7,
            border: `1.5px solid ${method === "CASH" ? C.primary : C.border}`,
            background: method === "CASH" ? C.primary : C.card,
            color: method === "CASH" ? C.primaryFg : C.fg,
            fontWeight: 800,
            fontSize: 12.5,
            cursor: "pointer",
            fontFamily: "inherit",
            transition: "all 0.15s ease",
          }}
        >
          <Banknote size={16} aria-hidden />
          <span>نقدي</span>
        </button>

        <button
          type="button"
          onClick={() => setMethod("CARD")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            height: 36,
            minHeight: 0,
            padding: "0 12px",
            borderRadius: 7,
            border: `1.5px solid ${method === "CARD" ? C.primary : C.border}`,
            background: method === "CARD" ? C.primary : C.card,
            color: method === "CARD" ? C.primaryFg : C.fg,
            fontWeight: 800,
            fontSize: 12.5,
            cursor: "pointer",
            fontFamily: "inherit",
            transition: "all 0.15s ease",
          }}
        >
          <CreditCard size={16} aria-hidden />
          <span>بطاقة</span>
        </button>

        <button
          type="button"
          onClick={() => setMethod("TRANSFER")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            height: 36,
            minHeight: 0,
            padding: "0 12px",
            borderRadius: 7,
            border: `1.5px solid ${method === "TRANSFER" ? C.primary : C.border}`,
            background: method === "TRANSFER" ? C.primary : C.card,
            color: method === "TRANSFER" ? C.primaryFg : C.fg,
            fontWeight: 800,
            fontSize: 12.5,
            cursor: "pointer",
            fontFamily: "inherit",
            transition: "all 0.15s ease",
          }}
        >
          <RefreshCw size={16} aria-hidden />
          <span>تحويل</span>
        </button>

        {method !== "CASH" && (
          <div style={{ flexShrink: 0, minWidth: 170 }}>
            <PaymentReferenceField
              value={paymentRef}
              onChange={setPaymentRef}
              method={method}
              confirmed={externalPaymentConfirmed}
              confirming={externalPaymentPending}
              onConfirm={onConfirmExternalPayment}
              inputId="print-pos-bottom-ref"
              colors={{
                border: C.border,
                muted: C.muted,
                mutedFg: C.mutedFg,
                fg: C.fg,
                amber: C.amber,
                success: C.success,
              }}
            />
          </div>
        )}
      </div>

      {/* تنبيه سعر يدوي إن وُجد */}
      {cartLen > 0 && hasZeroLine && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, color: C.amber, fontSize: 11, fontWeight: 700 }}>
          <Pencil size={11} aria-hidden />
          <span>أدخل سعراً للخدمات اليدوية</span>
        </div>
      )}

      {/* مساحة مرنة */}
      <div style={{ flex: 1, minWidth: 10 }} />

      {/* ── اليسار: أزرار الإجراءات (حجز الطلب / دفع سريع / إتمام الدفع) ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
        {!editingInvoice && (
          <>
            <button
              type="button"
              disabled={!canReserve || isPending}
              onClick={onReserve}
              title={
                isPending
                  ? ACTION_LABELS.saving
                  : !cartLen
                    ? "أضف خدمة أوّلاً"
                    : hasZeroLine
                      ? "أدخل سعراً للخدمات ذات السعر اليدوي"
                      : !hasCustomerInfo
                        ? "حجز الطلب يتطلب اسم أو هاتف الزبون أو اختيار عميل"
                        : "حجز الطلب كفاتورة معلقة بالتسليم مع حفظ العربون إن وجد"
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                height: 38,
                minHeight: 0,
                padding: "0 13px",
                borderRadius: 7,
                border: `1.5px solid ${canReserve ? "oklch(0.65 0.14 240)" : C.border}`,
                background: canReserve ? "oklch(0.55 0.16 240)" : C.muted,
                color: canReserve ? "#fff" : C.mutedFg,
                fontWeight: 800,
                fontSize: 12.5,
                cursor: canReserve ? "pointer" : "not-allowed",
                fontFamily: "inherit",
                whiteSpace: "nowrap",
                transition: "all 0.15s ease",
              }}
            >
              <Clock size={14} aria-hidden />
              <span>حجز الطلب</span>
            </button>

            <button
              type="button"
              disabled={!canQuickPay || isPending}
              onClick={onQuickPay}
              title={
                isPending
                  ? ACTION_LABELS.saving
                  : !cartLen
                    ? "أضف خدمة أوّلاً"
                    : hasZeroLine
                      ? "أدخل سعراً للخدمات ذات السعر اليدوي"
                      : !externalFullPaymentConfirmed
                        ? "أكمل مرجع الدفع الخارجي وتأكيده"
                        : `دفع سريع وطباعة — ${METHOD_LABEL[method]}`
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                height: 38,
                minHeight: 0,
                padding: "0 13px",
                borderRadius: 7,
                border: "none",
                background: canQuickPay
                  ? "linear-gradient(135deg, oklch(0.62 0.18 50), oklch(0.56 0.20 40))"
                  : C.muted,
                color: canQuickPay ? "#fff" : C.mutedFg,
                fontWeight: 800,
                fontSize: 12.5,
                cursor: canQuickPay ? "pointer" : "not-allowed",
                fontFamily: "inherit",
                whiteSpace: "nowrap",
                transition: "all 0.15s ease",
              }}
            >
              <Zap size={14} aria-hidden />
              <span>دفع سريع</span>
            </button>
          </>
        )}

        {/* زر إتمام الدفع الرئيسي */}
        <button
          type="button"
          disabled={!canPay || isPending}
          onClick={onPay}
          title={
            isPending
              ? ACTION_LABELS.saving
              : !cartLen
                ? "الفاتورة فارغة"
                : hasZeroLine
                  ? "أدخل سعراً للخدمات ذات السعر اليدوي"
                  : isOwing && customerId == null
                    ? "الآجل يحتاج عميلاً مسجلاً — أو اكمل المبلغ"
                    : !externalPaymentConfirmed && !editingInvoice
                      ? "أكمل مرجع الدفع الخارجي وتأكيده"
                      : editingInvoice
                        ? "اعتماد الفاتورة البديلة المعدلة وإغلاق السابقة"
                        : `إتمام الدفع — ${fmt(total)} د.ع`
          }
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: 40,
            minHeight: 0,
            padding: "0 18px",
            borderRadius: 8,
            border: "none",
            background: canPay && !isPending ? (editingInvoice ? "var(--sem-pos, #10b981)" : C.success) : C.muted,
            color: canPay && !isPending ? "#fff" : C.mutedFg,
            fontWeight: 900,
            fontSize: 13.5,
            cursor: canPay && !isPending ? "pointer" : "not-allowed",
            fontFamily: "inherit",
            boxShadow: canPay && !isPending ? "0 2px 8px rgba(16,185,129,0.25)" : "none",
            whiteSpace: "nowrap",
            transition: "all 0.15s ease",
          }}
        >
          {isPending ? (
            "جارٍ…"
          ) : editingInvoice ? (
            <>
              <Check size={16} strokeWidth={3} aria-hidden />
              <span>اعتماد التعديل</span>
            </>
          ) : isOwing && customerId != null ? (
            <>
              <Check size={16} strokeWidth={3} aria-hidden />
              <span>إتمام البيع (آجل)</span>
              <kbd
                style={{
                  background: "rgba(255,255,255,.24)",
                  color: "#fff",
                  borderRadius: 4,
                  padding: "1px 5px",
                  fontFamily: "monospace",
                  fontSize: 10,
                  fontWeight: 700,
                  marginInlineStart: 3,
                }}
              >
                F4
              </kbd>
            </>
          ) : (
            <>
              <Check size={16} strokeWidth={3} aria-hidden />
              <span>إتمام الدفع</span>
              <kbd
                style={{
                  background: "rgba(255,255,255,.24)",
                  color: "#fff",
                  borderRadius: 4,
                  padding: "1px 5px",
                  fontFamily: "monospace",
                  fontSize: 10,
                  fontWeight: 700,
                  marginInlineStart: 3,
                }}
              >
                F4
              </kbd>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
