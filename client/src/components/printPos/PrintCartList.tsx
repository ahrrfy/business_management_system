import { useEffect, useRef } from "react";
import { Pencil, Receipt as ReceiptIcon, User, X } from "lucide-react";
import { isCustomPriceSku, serviceIcon } from "@/lib/printServices";
import { PrintCustomerCombo } from "./PrintCustomerCombo";
import type { RouterOutputs } from "@/lib/trpc";

type Svc = RouterOutputs["printPos"]["services"][number];
export type PrintCartLine = { uid: number; svc: Svc; qty: number; price: number };

export interface PrintCartListProps {
  C: {
    card: string;
    border: string;
    primary: string;
    primaryFg: string;
    primarySoft: string;
    muted: string;
    mutedFg: string;
    fg: string;
    amber: string;
    danger: string;
  };
  cart: PrintCartLine[];
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
  addTick: number;
}

const fmt = (n: number) => Number(n || 0).toLocaleString("en-US");

export function PrintCartList({
  C,
  cart,
  selUid,
  setSelUid,
  changeQty,
  removeRow,
  onClear,
  setPrice,
  editPriceUid,
  setEditPriceUid,
  customerId,
  setCustomerId,
  addTick,
}: PrintCartListProps) {
  const items = cart.reduce((s, c) => s + c.qty, 0);
  const selectedRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (selUid == null) return;
    const raf = requestAnimationFrame(() => {
      selectedRowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
  }, [addTick, selUid]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 11px", height: 48, background: C.muted, borderBottom: `1px solid ${C.border}`, flexShrink: 0, gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 800, fontSize: 14.5, color: C.fg, display: "inline-flex", alignItems: "center", gap: 6 }}><ReceiptIcon aria-hidden size={17} /> الفاتورة</span>
          {cart.length > 0 && <span style={{ background: C.primary, color: C.primaryFg, borderRadius: 12, padding: "2px 9px", fontSize: 11.5, fontWeight: 700 }}>{cart.length} · {items}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: customerId != null ? C.primary : C.mutedFg }} aria-hidden><User size={14} /></span>
          <PrintCustomerCombo C={C} customerId={customerId} setCustomerId={setCustomerId} />
          {cart.length > 0 && <button onClick={onClear} style={{ height: 36, padding: "0 11px", background: "none", border: `1px solid ${C.border}`, borderRadius: 9, cursor: "pointer", fontSize: 12.5, color: C.danger, fontFamily: "inherit", fontWeight: 700 }}>تفريغ</button>}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: cart.length ? 9 : 0 }}>
        {cart.length === 0 ? (
          <div style={{ padding: "50px 0", textAlign: "center", color: C.mutedFg }}>
            <div style={{ marginBottom: 10, display: "flex", justifyContent: "center", opacity: 0.55 }}><ReceiptIcon aria-hidden size={40} strokeWidth={1.5} /></div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>الفاتورة فارغة</div>
            <div style={{ fontSize: 12, marginTop: 6, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4, flexWrap: "wrap" }}>
              اضغط <kbd style={{ background: C.muted, borderRadius: 4, padding: "1px 6px", fontFamily: "monospace", fontSize: 10.5, fontWeight: 700, color: C.fg }}>F2</kbd> للبحث السريع، أو اختر خدمة من الشبكة
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {cart.map((c) => {
              const sel = selUid === c.uid;
              const editing = editPriceUid === c.uid;
              return (
                <div key={c.uid} ref={sel ? selectedRowRef : undefined} onClick={() => setSelUid(c.uid)}
                  style={{ borderRadius: 11, border: `1.5px solid ${sel ? C.primary : C.border}`, background: sel ? C.primarySoft : C.card, padding: "9px 11px", cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                    <div style={{ fontSize: 19, fontWeight: 800, color: C.fg, lineHeight: 1.3, display: "flex", alignItems: "center", gap: 6 }}>
                      {(() => { const SIcon = serviceIcon(c.svc.sku); return <SIcon aria-hidden size={16} />; })()}
                      {c.svc.productName}
                      <span style={{ fontSize: 13, color: C.mutedFg, fontWeight: 500 }}>/ {c.svc.unitName}</span>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); removeRow(c.uid); }} aria-label="حذف السطر" style={{ width: 44, height: 44, flexShrink: 0, background: "none", border: `1px solid ${C.border}`, borderRadius: 8, cursor: "pointer", color: C.mutedFg, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><X aria-hidden size={18} /></button>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div onClick={(e) => { e.stopPropagation(); setSelUid(c.uid); setEditPriceUid(c.uid); }} style={{ minWidth: 78 }}>
                      {editing ? (
                        <input autoFocus dir="ltr" inputMode="numeric" defaultValue={c.price}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setPrice(c.uid, Math.max(0, parseInt(e.target.value.replace(/[^0-9]/g, ""), 10) || 0))}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setEditPriceUid(null); }}
                          onBlur={() => setEditPriceUid(null)}
                          style={{ width: 84, height: 36, textAlign: "center", border: `1.5px solid ${C.primary}`, borderRadius: 8, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 14, fontWeight: 800, outline: "none", direction: "ltr" }} />
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, direction: "ltr", color: isCustomPriceSku(c.svc.sku) ? C.amber : C.mutedFg, fontWeight: isCustomPriceSku(c.svc.sku) ? 800 : 600, fontSize: 13.5, padding: "5px 9px", borderRadius: 8, border: `1px dashed ${isCustomPriceSku(c.svc.sku) ? C.amber : C.border}` }}>
                          {fmt(c.price)}<Pencil aria-hidden size={10} style={{ opacity: 0.7 }} />
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button onClick={(e) => { e.stopPropagation(); changeQty(c.uid, c.qty - 1); }} style={{ width: 40, height: 40, border: `1.5px solid ${C.border}`, borderRadius: 10, background: C.card, cursor: "pointer", fontSize: 22, color: C.fg, display: "flex", alignItems: "center", justifyContent: "center", touchAction: "manipulation" }}>−</button>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={c.qty}
                        onClick={(e) => e.stopPropagation()}
                        onFocus={(e) => { e.stopPropagation(); e.currentTarget.select(); }}
                        onChange={(e) => {
                          e.stopPropagation();
                          const raw = e.target.value.replace(/[^\d]/g, "");
                          if (raw === "") return;
                          const n = parseInt(raw, 10);
                          if (!Number.isFinite(n) || n < 0) return;
                          changeQty(c.uid, n);
                        }}
                        onBlur={(e) => { if (e.currentTarget.value === "" || Number(e.currentTarget.value) < 1) changeQty(c.uid, 1); }}
                        aria-label="الكمية"
                        style={{ width: 56, height: 40, textAlign: "center", fontWeight: 900, fontSize: 18, direction: "ltr", color: C.fg, background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 10, outline: "none", fontFamily: "inherit" }}
                      />
                      <button onClick={(e) => { e.stopPropagation(); changeQty(c.uid, c.qty + 1); }} style={{ width: 40, height: 40, border: `1.5px solid ${C.border}`, borderRadius: 10, background: C.card, cursor: "pointer", fontSize: 22, color: C.fg, display: "flex", alignItems: "center", justifyContent: "center", touchAction: "manipulation" }}>+</button>
                    </div>
                    <span style={{ direction: "ltr", fontWeight: 900, fontSize: 16, color: C.fg, minWidth: 64, textAlign: "left" }}>{fmt(c.price * c.qty)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
