// زرّ العميل ومنتقيه في رأس سلّة الكاشير.
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import CustomerPicker from "@/components/CustomerPicker";
import { AppSelect } from "@/components/ui/AppSelect";
import type { RouterOutputs } from "@/lib/trpc";
import { User, X, ChevronDown } from "lucide-react";
import { priceTierLabel } from "@/lib/labels";
import { type Tier, type PosColors as C } from "./posShared";

export interface CartCustomerButtonProps {
  C: C;
  customerId: number | null;
  selectedCustomer:
    | RouterOutputs["customers"]["list"][number]
    | NonNullable<RouterOutputs["customers"]["get"]>
    | null;
  tierOverride: Tier | null; effectiveTier: Tier;
  setTierOvr: (v: Tier | null) => void;
  setCustId: (id: number | null) => void;
  showCustPicker: boolean; setShowCustPicker: (v: boolean) => void;
}

/** زرّ العميل في رأس السلّة + منتقي العميل/فئة السعر المنبثق. */
export function CartCustomerButton({ C, customerId, selectedCustomer, tierOverride, effectiveTier, setTierOvr, setCustId, showCustPicker, setShowCustPicker }: CartCustomerButtonProps) {
  return (
  <div style={{ position: "relative" }}>
    <button
      onClick={() => setShowCustPicker(!showCustPicker)}
      style={{ height: 34, padding: "0 11px", background: customerId ? C.primarySoft : C.card, border: `1.5px solid ${customerId ? C.primary : C.border}`, borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, color: customerId ? C.primary : C.mutedFg, display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
      <User size={14} aria-hidden /> {selectedCustomer ? selectedCustomer.name : "عميل نقدي"}
      {selectedCustomer && (
        <span style={{ fontSize: 11, opacity: 0.8 }}>({priceTierLabel(effectiveTier)})</span>
      )}
      <ChevronDown aria-hidden size={14} />
    </button>

    {showCustPicker && (
      <div onClick={(e) => e.stopPropagation()}
        // الفتح لليمين (داخل اللوحة الواسعة) لا لليسار: الزر في الجزء الأيسر من شريط
        // السلّة، وleft:0 يمنع تجاوز الحافّة وقصّ المحتوى بـoverflow:hidden للّوحة.
        // maxHeight + تمرير يصون الارتفاع إن فُتح نموذج إضافة عميل (لا اقتطاع عمودي).
        style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, width: 340, maxHeight: "calc(100vh - 140px)", overflowY: "auto", background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 12px 40px rgb(0 0 0/.2)", zIndex: 50, padding: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: C.fg }}>اختر عميلاً</div>
        <CustomerPicker
          customerId={customerId}
          onCustomerChange={(id) => { setCustId(id); setShowCustPicker(false); }}
          balance={selectedCustomer?.currentBalance ?? null}
        />
        {selectedCustomer != null && selectedCustomer.creditLimit != null
          && Number(selectedCustomer.creditLimit) === 0 && (
          <div style={{ marginTop: 8, fontSize: 11, fontWeight: 700, color: C.mutedFg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 6px" }}>
            نقديٌّ فقط — لا يقبل الآجل (حدّ ائتمانه صفر)
          </div>
        )}
        <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ fontSize: 12, color: C.mutedFg }}>فئة السعر:</label>
            <AppSelect value={effectiveTier} onValueChange={(value) => setTierOvr(value as Tier)}
              style={{ height: 30, border: `1px solid ${C.border}`, borderRadius: 6, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 12, padding: "0 6px", outline: "none" }}>
              <option value="RETAIL">مفرد</option>
              <option value="WHOLESALE">جملة</option>
              <option value="GOVERNMENT">حكومي</option>
            </AppSelect>
            {tierOverride && (
              <button onClick={() => setTierOvr(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: C.mutedFg }}>↩</button>
            )}
          </div>
          {customerId && (
            <button onClick={() => { setCustId(null); setShowCustPicker(false); }}
              style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12, color: C.danger, fontFamily: "inherit" }}>
              إلغاء العميل
            </button>
          )}
        </div>
        <button onClick={() => setShowCustPicker(false)}
          aria-label="إغلاق منتقي العميل"
          style={{ position: "absolute", top: 8, left: 10, background: "none", border: "none", cursor: "pointer", color: C.mutedFg, display: "inline-flex" }}><X aria-hidden size={16} /></button>
      </div>
    )}
  </div>
  );
}
