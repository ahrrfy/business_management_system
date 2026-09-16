import { useEffect, useRef } from "react";
import { Pencil, Receipt as ReceiptIcon, X } from "lucide-react";
import { isCustomPriceSku, serviceIcon } from "@/lib/printServices";
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
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 10px", height: 36, background: C.muted, borderBottom: `1px solid ${C.border}`, flexShrink: 0, gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ fontWeight: 800, fontSize: 13, color: C.fg, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <ReceiptIcon aria-hidden size={15} /> الفاتورة
          </span>
          {cart.length > 0 && <span style={{ background: C.primary, color: C.primaryFg, borderRadius: 10, padding: "1px 7px", fontSize: 11, fontWeight: 700 }}>{cart.length} · {items}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {cart.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              style={{
                height: 24,
                minHeight: 0,
                padding: "0 8px",
                background: "none",
                border: `1px solid ${C.border}`,
                borderRadius: 5,
                cursor: "pointer",
                fontSize: 11,
                color: C.danger,
                fontFamily: "inherit",
                fontWeight: 700,
                transition: "all 0.15s ease",
              }}
            >
              تفريغ
            </button>
          )}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: cart.length ? 6 : 0 }}>
        {cart.length === 0 ? (
          <div style={{ padding: "40px 0", textAlign: "center", color: C.mutedFg }}>
            <div style={{ marginBottom: 8, display: "flex", justifyContent: "center", opacity: 0.55 }}><ReceiptIcon aria-hidden size={36} strokeWidth={1.5} /></div>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>الفاتورة فارغة</div>
            <div style={{ fontSize: 11.5, marginTop: 5, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4, flexWrap: "wrap" }}>
              اضغط <kbd style={{ background: C.muted, borderRadius: 4, padding: "1px 5px", fontFamily: "monospace", fontSize: 10, fontWeight: 700, color: C.fg }}>F2</kbd> للبحث السريع، أو اختر خدمة من الشبكة
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {cart.map((c) => {
              const sel = selUid === c.uid;
              const editing = editPriceUid === c.uid;
              return (
                <div key={c.uid} ref={sel ? selectedRowRef : undefined} onClick={() => setSelUid(c.uid)}
                  style={{ borderRadius: 8, border: `1.5px solid ${sel ? C.primary : C.border}`, background: sel ? C.primarySoft : C.card, padding: "6px 9px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 800, color: C.fg, lineHeight: 1.25, display: "flex", alignItems: "center", gap: 5, minWidth: 0, overflow: "hidden" }}>
                      {(() => { const SIcon = serviceIcon(c.svc.sku); return <SIcon aria-hidden size={14} style={{ flexShrink: 0, color: C.primary }} />; })()}
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.svc.productName}</span>
                      <span style={{ fontSize: 11, color: C.mutedFg, fontWeight: 500, flexShrink: 0 }}>/ {c.svc.unitName}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                      <span style={{ direction: "ltr", fontWeight: 900, fontSize: 14, color: C.fg }}>
                        {fmt(c.price * c.qty)} <span style={{ fontSize: 10, fontWeight: 500, color: C.mutedFg }}>د.ع</span>
                      </span>
                      <button onClick={(e) => { e.stopPropagation(); removeRow(c.uid); }} aria-label="حذف السطر" style={{ width: 24, height: 24, minHeight: 0, flexShrink: 0, background: "none", border: `1px solid ${C.border}`, borderRadius: 5, cursor: "pointer", color: C.mutedFg, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><X aria-hidden size={13} /></button>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                    <div onClick={(e) => { e.stopPropagation(); setSelUid(c.uid); setEditPriceUid(c.uid); }} style={{ minWidth: 70 }}>
                      {editing ? (
                        <input autoFocus dir="ltr" inputMode="numeric" defaultValue={c.price}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setPrice(c.uid, Math.max(0, parseInt(e.target.value.replace(/[^0-9]/g, ""), 10) || 0))}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setEditPriceUid(null); }}
                          onBlur={() => setEditPriceUid(null)}
                          style={{ width: 72, height: 26, textAlign: "center", border: `1.5px solid ${C.primary}`, borderRadius: 6, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 12.5, fontWeight: 800, outline: "none", direction: "ltr" }} />
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 3.5, direction: "ltr", color: isCustomPriceSku(c.svc.sku) ? C.amber : C.mutedFg, fontWeight: isCustomPriceSku(c.svc.sku) ? 800 : 600, fontSize: 11.5, padding: "2px 6px", borderRadius: 5, border: `1px dashed ${isCustomPriceSku(c.svc.sku) ? C.amber : C.border}` }}>
                          {fmt(c.price)}<Pencil aria-hidden size={9} style={{ opacity: 0.7 }} />
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      <button onClick={(e) => { e.stopPropagation(); changeQty(c.uid, c.qty - 1); }} style={{ width: 28, height: 26, minHeight: 0, border: `1px solid ${C.border}`, borderRadius: 5, background: C.card, cursor: "pointer", fontSize: 16, fontWeight: 700, color: C.fg, display: "flex", alignItems: "center", justifyContent: "center", touchAction: "manipulation" }}>−</button>
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
                        style={{ width: 44, height: 26, textAlign: "center", fontWeight: 800, fontSize: 13.5, direction: "ltr", color: C.fg, background: C.card, border: `1px solid ${C.border}`, borderRadius: 5, outline: "none", fontFamily: "inherit" }}
                      />
                      <button onClick={(e) => { e.stopPropagation(); changeQty(c.uid, c.qty + 1); }} style={{ width: 28, height: 26, minHeight: 0, border: `1px solid ${C.border}`, borderRadius: 5, background: C.card, cursor: "pointer", fontSize: 16, fontWeight: 700, color: C.fg, display: "flex", alignItems: "center", justifyContent: "center", touchAction: "manipulation" }}>+</button>
                    </div>
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
