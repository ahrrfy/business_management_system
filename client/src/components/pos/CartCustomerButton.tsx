// زرّ العميل ومنتقيه في رأس سلّة الكاشير.
// استُخرج مكوّنياً كي ينزل تحت خطّ أساس `check:page-size` ومقياس الاحتكاك D4.

import { CustomerSelectionDialog } from "./CustomerSelectionDialog";
import type { RouterOutputs } from "@/lib/trpc";
import { User, ChevronDown, Truck, Phone } from "lucide-react";
import { priceTierLabel } from "@/lib/labels";
import { type Tier, type PosColors as C } from "./posShared";

export interface CartCustomerButtonProps {
  C: C;
  customerId: number | null;
  selectedCustomer:
    | RouterOutputs["customers"]["list"][number]
    | NonNullable<RouterOutputs["customers"]["get"]>
    | null;
  tierOverride: Tier | null;
  effectiveTier: Tier;
  setTierOvr: (v: Tier | null) => void;
  setCustId: (id: number | null) => void;
  showCustPicker: boolean;
  setShowCustPicker: (v: boolean) => void;
  /** م١ PR-B — وضع «توصيل» للتبويب: يستبدل منتقي العميل بشارة «عميل بالهاتف» ويُظهر مفتاح التبديل. */
  delivery: boolean;
  onToggleDelivery: () => void;
  /** سبب تعطيل تفعيل الوضع (الأوفلاين) — يُعطّل المفتاح ويشرح في title. */
  deliveryDisabledReason: string | null;
}

/** زرّ العميل في رأس السلّة + نافذة اختيار وتخصيص العميل المنبثقة. */
export function CartCustomerButton({
  C,
  customerId,
  selectedCustomer,
  tierOverride,
  effectiveTier,
  setTierOvr,
  setCustId,
  showCustPicker,
  setShowCustPicker,
  delivery,
  onToggleDelivery,
  deliveryDisabledReason,
}: CartCustomerButtonProps) {
  const toggleDisabled = !delivery && !!deliveryDisabledReason;
  const isCashOnly =
    selectedCustomer != null &&
    selectedCustomer.creditLimit != null &&
    Number(selectedCustomer.creditLimit) === 0;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {/* م١ PR-B: مفتاح وضع «توصيل» — لكلّ تبويبٍ حالته. معطَّلٌ دون اتصال (لا إسناد بلا حرّاس الخادم الحيّة). */}
      <button
        type="button"
        onClick={onToggleDelivery}
        disabled={toggleDisabled}
        aria-pressed={delivery}
        title={
          toggleDisabled
            ? deliveryDisabledReason ?? undefined
            : delivery
            ? "إلغاء وضع التوصيل — يعود البيع عادياً"
            : "بيعٌ بتوصيل: عميلٌ بالهاتف + طردٌ يُسند مع الفاتورة ويُحصَّل عند التسليم"
        }
        style={{
          height: 34,
          padding: "0 11px",
          background: delivery ? C.primary : C.card,
          border: `1.5px solid ${delivery ? C.primary : C.border}`,
          borderRadius: 8,
          cursor: toggleDisabled ? "not-allowed" : "pointer",
          fontFamily: "inherit",
          fontSize: 12.5,
          fontWeight: 700,
          color: delivery ? C.primaryFg : toggleDisabled ? C.mutedFg : C.fg,
          display: "flex",
          alignItems: "center",
          gap: 5,
          whiteSpace: "nowrap",
          opacity: toggleDisabled ? 0.6 : 1,
        }}
      >
        <Truck size={14} aria-hidden /> توصيل
      </button>

      {delivery ? (
        <span
          style={{
            height: 34,
            padding: "0 11px",
            background: C.primarySoft,
            border: `1.5px solid ${C.primary}`,
            borderRadius: 8,
            fontSize: 12.5,
            fontWeight: 700,
            color: C.primary,
            display: "flex",
            alignItems: "center",
            gap: 5,
            whiteSpace: "nowrap",
          }}
        >
          <Phone size={14} aria-hidden />{" "}
          {selectedCustomer ? selectedCustomer.name : "عميلٌ بالهاتف — أدخل رقمه أدناه"}
          {selectedCustomer && (
            <span style={{ fontSize: 11, opacity: 0.8 }}>
              ({priceTierLabel(effectiveTier)})
            </span>
          )}
        </span>
      ) : (
        <div>
          <button
            type="button"
            onClick={() => setShowCustPicker(true)}
            style={{
              height: 34,
              padding: "0 11px",
              background: customerId ? C.primarySoft : C.card,
              border: `1.5px solid ${customerId ? C.primary : C.border}`,
              borderRadius: 8,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12.5,
              fontWeight: 700,
              color: customerId ? C.primary : C.mutedFg,
              display: "flex",
              alignItems: "center",
              gap: 5,
              whiteSpace: "nowrap",
            }}
          >
            <User size={14} aria-hidden />
            <span>{selectedCustomer ? selectedCustomer.name : "عميل نقدي"}</span>
            {selectedCustomer && (
              <span style={{ fontSize: 11, opacity: 0.8 }}>
                ({priceTierLabel(effectiveTier)})
              </span>
            )}
            {selectedCustomer && (
              <span
                style={{
                  fontSize: 10,
                  padding: "1px 5px",
                  borderRadius: 4,
                  fontWeight: 800,
                  background: isCashOnly ? "rgba(239, 68, 68, 0.15)" : "rgba(16, 185, 129, 0.15)",
                  color: isCashOnly ? "#ef4444" : "#10b981",
                }}
              >
                {isCashOnly ? "نقدي فقط" : "آجل"}
              </span>
            )}
            <ChevronDown aria-hidden size={14} />
          </button>

          <CustomerSelectionDialog
            open={showCustPicker}
            onOpenChange={setShowCustPicker}
            C={C}
            customerId={customerId}
            selectedCustomer={selectedCustomer}
            effectiveTier={effectiveTier}
            tierOverride={tierOverride}
            onSelectCustomer={setCustId}
            onSelectTier={setTierOvr}
          />
        </div>
      )}
    </div>
  );
}
