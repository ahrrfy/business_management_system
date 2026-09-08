import { AlertTriangle } from "lucide-react";
import { fmt, type PosColors as C } from "./posShared";

export interface CartPanelFooterProps {
  C: C;
  cartLength: number;
  itemCount: number;
  flaggedCount: number;
  anyOut: boolean;
  total: number;
}

export function CartPanelFooter({
  C,
  cartLength,
  itemCount,
  flaggedCount,
  anyOut,
  total,
}: CartPanelFooterProps) {
  if (cartLength === 0) return null;

  return (
    <div
      style={{
        borderTop: `2px solid ${C.border}`,
        padding: "9px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: C.muted,
        flexShrink: 0,
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span style={{ fontSize: 13, color: C.mutedFg, whiteSpace: "nowrap" }}>
          {cartLength} منتج · {itemCount} قطعة
        </span>
        {flaggedCount > 0 && (
          // شارة دائمة تلخّص أصناف نقص المخزون كي لا يختفي التحذير حين ينزلق سطره خارج الرؤية.
          <span
            style={{
              background: anyOut ? C.danger : C.amber,
              color: anyOut ? "#fff" : "#241900",
              borderRadius: 8,
              padding: "3px 10px",
              fontSize: 12,
              fontWeight: 800,
              whiteSpace: "nowrap",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <AlertTriangle aria-hidden size={13} /> {flaggedCount} منتج ناقص المخزون
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
        <span style={{ fontSize: 13.5, color: C.mutedFg }}>المجموع:</span>
        <span style={{ fontSize: 28, fontWeight: 900, direction: "ltr", color: C.fg }}>
          {fmt(total)}
        </span>
        <span style={{ fontSize: 13, color: C.mutedFg }}>د.ع</span>
      </div>
    </div>
  );
}
