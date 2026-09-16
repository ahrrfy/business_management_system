import React, { useEffect, useState } from "react";
import { Pencil, Undo2, Banknote, CreditCard, RefreshCw, AlertTriangle, Zap, Clock, Check } from "lucide-react";
import { normalizeNumberInput } from "@shared/numberNormalize";
import { POS_EXTERNAL_PAYMENT_PROOF_HINT } from "@shared/posPaymentPolicy";
import { ACTION_LABELS } from "@shared/actionLabels";
import { roundCashIQD } from "@/lib/money";
import { CopyButton } from "@/components/CopyButton";
import { PaymentReferenceField } from "@/components/pos/PaymentReferenceField";
import { PrintCartList, type PrintCartLine as CartLine } from "@/components/printPos/PrintCartList";
import { PrintChannelCustomerBar, type OrderChannel } from "./PrintChannelCustomerBar";

export type PaymentMethod = "CASH" | "CARD" | "TRANSFER";

export type EditingInvoiceInfo = {
  id: number;
  invoiceNumber: string;
  preCollected: string;
  originalTotal: string;
};

export interface CheckoutProps {
  C: any;
  cart: CartLine[];
  total: number;
  selUid: number | null;
  setSelUid: (id: number | null) => void;
  changeQty: (uid: number, q: number) => void;
  removeRow: (uid: number) => void;
  onClear: () => void;
  setPrice: (uid: number, p: number) => void;
  editPriceUid: number | null;
  setEditPriceUid: (id: number | null) => void;
  customerId: number | null;
  setCustomerId: (id: number | null) => void;
  contactName: string;
  setContactName: (name: string) => void;
  contactPhone: string;
  setContactPhone: (phone: string) => void;
  channel: OrderChannel;
  setChannel: (c: OrderChannel) => void;
  editingInvoice: EditingInvoiceInfo | null;
  onCancelEdit: () => void;
  heldCount: number;
  onOpenHeldDrawer: () => void;
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
  numPress: (k: string) => void;
  onPay: () => void;
  onQuickPay: () => void;
  onReserve: () => void;
  isPending: boolean;
  addTick: number;
}

const METHOD_LABEL: Record<PaymentMethod, string> = { CASH: "نقدي", CARD: "بطاقة", TRANSFER: "تحويل" };
const fmt = (n: number) => Number(n || 0).toLocaleString("en-US");
const riqd = (n: number) => roundCashIQD(n).toNumber();
const fluid = (min: number, ratio: number, max: number) => `clamp(${min}px, ${ratio}vh, ${max}px)`;

export function CheckoutColumn(props: CheckoutProps) {
  return (
    <div style={{ width: 480, flexShrink: 0, display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
      <PrintChannelCustomerBar
        C={props.C}
        channel={props.channel}
        setChannel={props.setChannel}
        customerId={props.customerId}
        setCustomerId={props.setCustomerId}
        contactName={props.contactName}
        setContactName={props.setContactName}
        contactPhone={props.contactPhone}
        setContactPhone={props.setContactPhone}
        heldCount={props.heldCount}
        onOpenHeldDrawer={props.onOpenHeldDrawer}
      />
      {props.editingInvoice && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "8px 12px",
            background: "rgba(245, 158, 11, 0.12)",
            border: "1.5px solid var(--sem-warn, #f59e0b)",
            borderRadius: 10,
            fontSize: 12.5,
            fontWeight: 800,
            color: "var(--sem-warn, #d97706)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Pencil size={15} />
            <span>
              وضع تعديل طلب محجوز #{props.editingInvoice.invoiceNumber}
              {Number(props.editingInvoice.preCollected) > 0 && (
                <span style={{ marginInlineStart: 4, fontWeight: 700, color: props.C.fg }}>
                  (عربون محوّل: {fmt(Number(props.editingInvoice.preCollected))} د.ع)
                </span>
              )}
            </span>
          </div>
          <button
            type="button"
            onClick={props.onCancelEdit}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 8px",
              borderRadius: 6,
              border: "1px solid var(--sem-warn, #f59e0b)",
              background: props.C.card,
              color: props.C.fg,
              fontSize: 11,
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            <Undo2 size={12} />
            إلغاء التعديل
          </button>
        </div>
      )}
      <PrintCartList {...props} />
      <PaymentBlock {...props} />
    </div>
  );
}

export function PaymentBlock({
  C, total, payInput, setPayInput, method, setMethod, paymentRef, setPaymentRef,
  externalPaymentConfirmed, externalFullPaymentConfirmed, externalPaymentPending,
  onConfirmExternalPayment, onPay, onQuickPay, onReserve, cart, customerId,
  contactName, contactPhone, editingInvoice, isPending
}: CheckoutProps) {
  const [displayPay, setDisplayPay] = useState(payInput);
  useEffect(() => {
    try {
      const norm = normalizeNumberInput(displayPay).normalized;
      if (norm !== payInput) setDisplayPay(payInput);
    } catch { setDisplayPay(payInput); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payInput]);
  const cartLen = cart.length;
  const paid = Number(payInput || 0);
  const cashTotal = method === "CASH" ? riqd(total) : total;
  const change = paid - cashTotal;
  const credit = cashTotal - paid;
  const isChange = paid > 0 && paid >= cashTotal;
  const isOwing = paid > 0 && paid < cashTotal;
  const hasZeroLine = cart.some((c) => c.price <= 0);

  const hasCustomerInfo = customerId != null || contactName.trim().length > 0 || contactPhone.trim().length > 0;
  const canReserve = cartLen > 0 && !hasZeroLine && hasCustomerInfo && !editingInvoice;
  const canPay = cartLen > 0 && !hasZeroLine && (
    editingInvoice != null || (
      (payInput === "" || paid >= cashTotal) && (!isOwing || customerId != null) && externalPaymentConfirmed
    )
  );
  const canQuickPay = cartLen > 0 && !hasZeroLine && !editingInvoice && externalFullPaymentConfirmed;

  const Method = ({ m, Icon, label, disabled = false }: { m: PaymentMethod; Icon: React.ComponentType<{ "aria-hidden"?: boolean; size?: number }>; label: string; disabled?: boolean }) => (
    <button onClick={disabled ? undefined : () => setMethod(m)} disabled={disabled}
      aria-describedby={disabled ? "print-pos-external-payment-proof" : undefined}
      title={disabled ? POS_EXTERNAL_PAYMENT_PROOF_HINT : label}
      style={{ flex: 1, minHeight: fluid(44, 5.6, 50), display: "flex", alignItems: "center", justifyContent: "center", gap: 6, border: `2px solid ${method === m ? C.primary : C.border}`, borderRadius: 10, background: method === m ? C.primary : C.card, color: method === m ? C.primaryFg : C.fg, fontWeight: 800, fontSize: 13.5, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, fontFamily: "inherit", touchAction: "manipulation" }}>
      <Icon aria-hidden size={19} />{label}
    </button>
  );

  return (
    <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
      <div style={{ padding: "7px 16px", background: C.primary, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <span style={{ fontSize: 13.5, color: C.primaryFg, fontWeight: 700, opacity: 0.92 }}>الإجمالي</span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
          <span style={{ fontSize: fluid(20, 2.9, 27), fontWeight: 900, direction: "ltr", letterSpacing: "-1px", color: C.primaryFg }}>{fmt(total)}</span>
          <span style={{ fontSize: 12.5, color: C.primaryFg, opacity: 0.85 }}>د.ع</span>
        </div>
      </div>
      <div style={{ flexShrink: 0, padding: "8px 12px 0" }}>
        <div style={{ background: C.muted, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "5px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: fluid(38, 5, 46), marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: C.mutedFg, flexShrink: 0, fontWeight: 700 }}>
            {editingInvoice ? "دفعة إضافية (اختياري)" : "المبلغ المستلم"}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => setPayInput(String(cashTotal))}
              disabled={!cartLen}
              title="عبّئ المبلغ الإجماليّ"
              style={{ height: 30, padding: "0 10px", border: `1.5px solid ${C.primary}`, borderRadius: 8, background: C.primarySoft, color: C.primary, fontFamily: "inherit", fontSize: 12, fontWeight: 800, cursor: cartLen ? "pointer" : "not-allowed", opacity: cartLen ? 1 : 0.5, flexShrink: 0, touchAction: "manipulation" }}
            >
              = الكل
            </button>
            <input
              type="text"
              inputMode="decimal"
              value={displayPay}
              onChange={(e) => {
                const src = e.target.value;
                setDisplayPay(src);
                if (src === "") { setPayInput(""); return; }
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
              style={{ flex: 1, minWidth: 0, maxWidth: 200, border: "none", outline: "none", background: "transparent", fontSize: fluid(19, 2.6, 24), fontWeight: 900, direction: "ltr", textAlign: "left", fontFamily: "inherit", color: payInput ? (isOwing ? C.amber : C.primary) : C.fg }}
            />
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <Method m="CASH" Icon={Banknote} label="نقدي" />
          <Method m="CARD" Icon={CreditCard} label="بطاقة" />
          <Method m="TRANSFER" Icon={RefreshCw} label="تحويل" />
        </div>
        {method !== "CASH" && (
          <div id="print-pos-external-payment-proof" role="status" style={{ marginBottom: 6, display: "flex", alignItems: "flex-start", gap: 5, color: C.mutedFg, fontSize: 11.5, fontWeight: 700, lineHeight: 1.5 }}>
            <AlertTriangle aria-hidden size={14} style={{ marginTop: 1, flexShrink: 0 }} />
            <span>{POS_EXTERNAL_PAYMENT_PROOF_HINT}</span>
          </div>
        )}
        <PaymentReferenceField
          value={paymentRef}
          onChange={setPaymentRef}
          method={method}
          confirmed={externalPaymentConfirmed}
          confirming={externalPaymentPending}
          onConfirm={onConfirmExternalPayment}
          inputId="print-pos-payment-reference"
          colors={{ border: C.border, muted: C.muted, mutedFg: C.mutedFg, fg: C.fg, amber: C.amber, success: C.success }}
          style={{ marginBottom: 6 }}
        />
      </div>

      <div style={{ flexShrink: 0, padding: "6px 10px 9px", borderTop: `1px solid ${C.border}` }}>
        <div style={{ minHeight: 24, display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          {!cartLen && <span style={{ fontSize: 12.5, color: C.mutedFg }}>اختر خدمة للبدء</span>}
          {cartLen > 0 && hasZeroLine && <span style={{ fontSize: 12, color: C.amber, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}>أدخل سعراً للخدمات ذات السعر اليدوي (<Pencil aria-hidden size={11} />)</span>}
          {cartLen > 0 && !hasZeroLine && !payInput && !editingInvoice && <span style={{ fontSize: 12, color: C.mutedFg }}>{method === "CASH" && cashTotal !== total ? `نقداً يُقرَّب إلى ${fmt(cashTotal)} د.ع` : "أدخل المبلغ أو «إتمام» للدفع الكامل أو «حجز» للتعليق"}</span>}
          {cartLen > 0 && !!payInput && isChange && (<><span style={{ fontSize: 13, color: C.mutedFg, fontWeight: 600 }}>الباقي للعميل</span><span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ fontSize: 21, fontWeight: 900, color: C.success, direction: "ltr" }}>{fmt(change)} <span style={{ fontSize: 12, fontWeight: 500, color: C.mutedFg }}>د.ع</span></span><CopyButton value={change} title="نسخ الباقي" successMessage="تم نسخ الباقي" /></span></>)}
          {cartLen > 0 && !!payInput && isOwing && (<><span style={{ fontSize: 13, color: C.amber, fontWeight: 600 }}>المتبقي (آجل)</span><span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ fontSize: 21, fontWeight: 900, color: C.amber, direction: "ltr" }}>{fmt(credit)} <span style={{ fontSize: 12, fontWeight: 500 }}>د.ع</span></span><CopyButton value={credit} title="نسخ المتبقي" successMessage="تم نسخ المتبقي" /></span></>)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {!editingInvoice && (
            <div style={{ display: "flex", gap: 6 }}>
              <button disabled={!canQuickPay || isPending} onClick={onQuickPay}
                title={
                  isPending ? ACTION_LABELS.saving :
                  !cartLen ? "أضف خدمة أوّلاً" :
                  hasZeroLine ? "أدخل سعراً للخدمات ذات السعر اليدوي" :
                  !externalFullPaymentConfirmed ? "أكمل مرجع الدفع الخارجي وتأكيده" :
                  `دفع سريع وطباعة — ${METHOD_LABEL[method]}`
                }
                style={{ flex: 1, height: 38, background: canQuickPay && !isPending ? "linear-gradient(135deg, oklch(0.62 0.18 50), oklch(0.56 0.20 40))" : C.muted, color: canQuickPay && !isPending ? "#fff" : C.mutedFg, border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 12.5, fontWeight: 800, cursor: canQuickPay && !isPending ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, touchAction: "manipulation" }}>
                <Zap aria-hidden size={15} />دفع سريع
              </button>
              <button disabled={!canReserve || isPending} onClick={onReserve}
                title={
                  isPending ? ACTION_LABELS.saving :
                  !cartLen ? "أضف خدمة أوّلاً" :
                  hasZeroLine ? "أدخل سعراً للخدمات ذات السعر اليدوي" :
                  !hasCustomerInfo ? "حجز الطلب يتطلب اسم أو هاتف الزبون أو اختيار عميل" :
                  "حجز الطلب كفاتورة معلقة بالتسليم مع حفظ العربون إن وجد"
                }
                style={{ flex: 1, height: 38, background: canReserve && !isPending ? "linear-gradient(135deg, oklch(0.58 0.16 230), oklch(0.50 0.18 240))" : C.muted, color: canReserve && !isPending ? "#fff" : C.mutedFg, border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 12.5, fontWeight: 800, cursor: canReserve && !isPending ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, touchAction: "manipulation" }}>
                <Clock aria-hidden size={14} />حجز الطلب
              </button>
            </div>
          )}
          <button disabled={!canPay || isPending} onClick={onPay}
            title={
              isPending ? ACTION_LABELS.saving :
              !cartLen ? "أضف خدمة أوّلاً" :
              hasZeroLine ? "أدخل سعراً للخدمات ذات السعر اليدوي" :
              isOwing && customerId == null ? "الآجل يحتاج عميلاً مسجلاً — أو اكمل المبلغ" :
              !externalPaymentConfirmed && !editingInvoice ? "أكمل مرجع الدفع الخارجي وتأكيده" :
              editingInvoice ? "اعتماد الفاتورة البديلة المعدلة وإغلاق السابقة" :
              `إتمام الدفع — ${fmt(total)} د.ع`
            }
            style={{ width: "100%", height: 46, background: canPay && !isPending ? (editingInvoice ? "var(--sem-pos, #10b981)" : C.success) : C.muted, color: canPay && !isPending ? "#fff" : C.mutedFg, border: "none", borderRadius: 9, fontFamily: "inherit", fontSize: 15, fontWeight: 900, cursor: canPay && !isPending ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, touchAction: "manipulation" }}>
            {isPending
              ? "جارٍ…"
              : !cartLen
                ? "الفاتورة فارغة"
                : editingInvoice
                  ? <><Check aria-hidden size={18} strokeWidth={3} /> اعتماد التعديل البديل</>
                  : isOwing && customerId != null
                    ? <><Check aria-hidden size={18} strokeWidth={3} /> إتمام البيع (آجل) <kbd style={{ background: "rgba(255,255,255,.22)", color: "#fff", borderRadius: 4, padding: "1px 6px", fontFamily: "monospace", fontSize: 10, fontWeight: 700 }}>F4</kbd></>
                    : <><Check aria-hidden size={18} strokeWidth={3} /> إتمام الدفع <kbd style={{ background: "rgba(255,255,255,.22)", color: "#fff", borderRadius: 4, padding: "1px 6px", fontFamily: "monospace", fontSize: 10, fontWeight: 700 }}>F4</kbd></>}
          </button>
        </div>
        <div style={{ textAlign: "center", marginTop: 4, fontSize: 10, color: C.mutedFg, opacity: 0.85 }}>
          F4 للدفع · F2 للبحث · F12 للتفريغ · Esc للإغلاق
        </div>
      </div>
    </div>
  );
}
