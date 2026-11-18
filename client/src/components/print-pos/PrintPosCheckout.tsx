import React from "react";
import { Pencil, Percent, Undo2, X } from "lucide-react";
import { D, round2 } from "@/lib/money";
import { CASHIER_INVOICE_DISCOUNT_MAX_PCT, computeInvoiceDiscount } from "@/components/pos/posShared";
import { PrintCartList, type PrintCartLine as CartLine } from "@/components/printPos/PrintCartList";

export function computePrintPosTotals(
  cart: CartLine[],
  editingInvoice: EditingInvoiceInfo | null,
  invoiceDiscountType?: "percent" | "amount",
  invoiceDiscountValue?: string,
) {
  const rawTotal = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const calc = computeInvoiceDiscount({
    subtotalD: D(rawTotal),
    effectiveHeaderCapPctD: D(CASHIER_INVOICE_DISCOUNT_MAX_PCT),
    invoiceDiscountAllowed: rawTotal > 0 && !editingInvoice,
    type: invoiceDiscountType ?? "percent",
    value: invoiceDiscountValue ?? "",
  });
  return {
    rawTotal,
    invoiceDiscountAmountD: calc.discountAmountD,
    invoiceDiscountAmount: calc.discountAmountD.toNumber(),
    total: round2(D(rawTotal).minus(calc.discountAmountD)).toNumber(),
  };
}

export type PaymentMethod = "CASH" | "CARD" | "TRANSFER" | "WALLET";

export type EditingInvoiceInfo = {
  id: number;
  invoiceNumber: string;
  preCollected: string;
  originalTotal: string;
};

export interface CheckoutProps {
  extraChargesSlot?: React.ReactNode;
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
  editingInvoice: EditingInvoiceInfo | null;
  onCancelEdit: () => void;
  addTick: number;
  subtotal?: number;
  invoiceDiscountType?: "percent" | "amount";
  invoiceDiscountValue?: string;
  invoiceDiscountAmount?: number;
  invoiceDiscountMaxPct?: number;
  onInvoiceDiscountChange?: (type: "percent" | "amount", value: string) => void;
}

const fmt = (n: number) => Number(n || 0).toLocaleString("en-US");

export function CheckoutColumn(props: CheckoutProps) {
  return (
    <div style={{ width: 440, flexShrink: 0, display: "flex", flexDirection: "column", gap: 6, minHeight: 0, height: "100%" }}>
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
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Pencil size={15} />
            <span>
              وضع تعديل طلب محجوز #{props.editingInvoice.invoiceNumber}
              {Number(props.editingInvoice.preCollected) > 0 && (
                <span style={{ marginInlineStart: 4, fontWeight: 700, color: props.C.fg }}>
                  (عربون محوّل: {fmt(Number(props.editingInvoice.preCollected))}{" "} د.ع)
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
      <PrintCartList
        C={props.C}
        cart={props.cart}
        selUid={props.selUid}
        setSelUid={props.setSelUid}
        changeQty={props.changeQty}
        removeRow={props.removeRow}
        onClear={props.onClear}
        setPrice={props.setPrice}
        editPriceUid={props.editPriceUid}
        setEditPriceUid={props.setEditPriceUid}
        customerId={props.customerId}
        setCustomerId={props.setCustomerId}
        addTick={props.addTick}
      />
      {props.onInvoiceDiscountChange && !props.editingInvoice && (props.subtotal ?? 0) > 0 && (() => {
        const mode = props.invoiceDiscountType ?? "percent";
        const val = props.invoiceDiscountValue ?? "";
        const discAmt = props.invoiceDiscountAmount ?? 0;
        const maxPct = props.invoiceDiscountMaxPct ?? 15;
        return (
          <div
            role="group"
            aria-label="خصم على الفاتورة"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "6px 10px",
              borderRadius: 10,
              border: `1.5px ${discAmt > 0 ? "solid" : "dashed"} ${discAmt > 0 ? props.C.amber : props.C.border}`,
              background: discAmt > 0 ? "var(--sem-warn-bg)" : props.C.card,
              flexShrink: 0,
            }}
          >
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Percent aria-hidden size={13} />
              <span style={{ fontSize: 12, fontWeight: 800 }}>خصم فاتورة</span>
              <input
                type="text"
                inputMode="decimal"
                dir="ltr"
                value={val}
                placeholder="0"
                aria-label={mode === "percent" ? "نسبة خصم الفاتورة" : "مبلغ خصم الفاتورة"}
                onChange={(e) => {
                  const norm = e.target.value.replace(/[،,]/g, ".");
                  if (norm === "") {
                    props.onInvoiceDiscountChange!(mode, "");
                    return;
                  }
                  if (!/^\d+\.?\d*$|^\d*\.\d+$/.test(norm)) return;
                  props.onInvoiceDiscountChange!(mode, norm);
                }}
                style={{
                  width: mode === "percent" ? 44 : 74,
                  textAlign: "center",
                  fontSize: 13,
                  fontWeight: 900,
                  background: "transparent",
                  border: `1px solid ${props.C.border}`,
                  borderRadius: 6,
                  padding: "2px 4px",
                  outline: "none",
                }}
              />
              <div
                role="group"
                aria-label="نوع خصم الفاتورة"
                style={{ display: "inline-flex", border: `1px solid ${props.C.border}`, borderRadius: 6, overflow: "hidden" }}
              >
                <button
                  type="button"
                  aria-pressed={mode === "percent"}
                  onClick={() => {
                    if (mode === "percent") return;
                    const nextPct = (props.subtotal ?? 0) > 0 && discAmt > 0
                      ? Math.min(maxPct, (discAmt / (props.subtotal ?? 1)) * 100).toFixed(2).replace(/\.?0+$/, "")
                      : "";
                    props.onInvoiceDiscountChange!("percent", nextPct);
                  }}
                  style={{
                    padding: "2px 7px",
                    fontSize: 11,
                    fontWeight: 800,
                    border: "none",
                    cursor: "pointer",
                    background: mode === "percent" ? props.C.primary : "transparent",
                    color: mode === "percent" ? props.C.primaryFg : props.C.mutedFg,
                  }}
                >
                  %
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "amount"}
                  onClick={() => {
                    if (mode === "amount") return;
                    props.onInvoiceDiscountChange!("amount", discAmt > 0 ? String(discAmt) : "");
                  }}
                  style={{
                    padding: "2px 7px",
                    fontSize: 11,
                    fontWeight: 800,
                    border: "none",
                    cursor: "pointer",
                    background: mode === "amount" ? props.C.primary : "transparent",
                    color: mode === "amount" ? props.C.primaryFg : props.C.mutedFg,
                  }}
                >
                  د.ع
                </button>
              </div>
            </div>
            {discAmt > 0 && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span dir="ltr" style={{ fontSize: 12, fontWeight: 900, color: props.C.amber }}>
                  −{fmt(discAmt)} د.ع
                </span>
                <button
                  type="button"
                  aria-label="إزالة خصم الفاتورة"
                  onClick={() => props.onInvoiceDiscountChange!(mode, "")}
                  style={{ background: "none", border: "none", cursor: "pointer", color: props.C.mutedFg, display: "inline-flex" }}
                >
                  <X aria-hidden size={13} />
                </button>
              </div>
            )}
          </div>
        );
      })()}
      {props.extraChargesSlot}
    </div>
  );
}
