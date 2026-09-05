// شريط تبويبات البيع المتعدّدة (طلب ١، طلب ٢، …).
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import { X } from "lucide-react";
import { type POSTab, fmt, itemTotal, type PosColors as C } from "./posShared";

export interface TabBarProps {
  C: C; tabs: POSTab[]; activeId: number;
  onSwitch: (id: number) => void;
  onAdd: () => void;
  onClose: (id: number) => void;
}

export function TabBar({ C, tabs, activeId, onSwitch, onAdd, onClose }: TabBarProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", background: C.bg, borderBottom: `1px solid ${C.border}`, flexShrink: 0, overflowX: "auto" }}>
      {tabs.map((tab) => {
        const tabTotal = tab.cart.reduce((s, c) => s + itemTotal(c), 0);
        const items    = tab.cart.reduce((s, c) => s + c.qty, 0);
        const active   = tab.id === activeId;
        return (
          <div key={tab.id} onClick={() => onSwitch(tab.id)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 11px", borderRadius: 8, background: active ? C.primary : C.card, color: active ? C.primaryFg : C.fg, border: `${active ? "2px" : "1.5px"} solid ${active ? C.primary : C.border}`, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap", fontSize: 13, fontWeight: 700, transition: "all .12s" }}>
            <span>{tab.label}</span>
            {tabTotal > 0 && (
              <span style={{ fontSize: 12, fontWeight: 800, direction: "ltr", opacity: active ? 1 : 0.75 }}>
                {fmt(tabTotal)} د.ع
              </span>
            )}
            {items > 0 && (
              <span style={{ background: active ? "rgba(255,255,255,.25)" : C.muted, color: active ? "#fff" : C.mutedFg, borderRadius: 10, padding: "1px 6px", fontSize: 11, fontWeight: 700 }}>
                {items}
              </span>
            )}
            {tabs.length > 1 && (
              <button onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                aria-label="إغلاق التبويب"
                style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", color: active ? "rgba(255,255,255,.7)" : C.mutedFg, lineHeight: 1, display: "inline-flex" }}><X aria-hidden size={13} /></button>
            )}
          </div>
        );
      })}
      {tabs.length < 8 && (
        <button
          aria-label="طلب جديد"
          onClick={onAdd}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 44, height: 44, borderRadius: 8, background: C.card, border: `1.5px dashed ${C.border}`, cursor: "pointer", fontSize: 22, color: C.mutedFg, flexShrink: 0 }}
        >+</button>
      )}
    </div>
  );
}
