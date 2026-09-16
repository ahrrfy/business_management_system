import React from "react";
import { Pencil, Undo2 } from "lucide-react";
import { PrintCartList, type PrintCartLine as CartLine } from "@/components/printPos/PrintCartList";

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
  editingInvoice: EditingInvoiceInfo | null;
  onCancelEdit: () => void;
  addTick: number;
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
    </div>
  );
}
