/**
 * لوحة وضع «توصيل» داخل سلّة الكاشير (م١ PR-B): العميل بالهاتف (يسار) + حقول التوصيل (يمين) في نفس
 * الشاشة فوق جدول السلّة — بيعٌ لعميلٍ جديد عبر واتساب مع توصيل بلا مغادرة الكاشير.
 */
import { DeliveryCustomerSection, type DeliveryCustomerIdentity } from "./DeliveryCustomerSection";
import { DeliveryModeFields } from "./DeliveryModeFields";
import type { DeliveryDraft } from "./deliveryMode";
import type { PosColors as C } from "./posShared";

export interface CartDeliveryPanelProps {
  C: C;
  /** مفتاح التبويب — يعيد تركيب قسم العميل لكلّ تبويب (حالة بحثٍ مستقلّة). */
  tabId: number;
  draft: DeliveryDraft;
  onChange: (next: DeliveryDraft) => void;
  onIdentityChange: (identity: DeliveryCustomerIdentity) => void;
  customerBalance: string | null;
  suggestedPartyId?: number | null;
  disabledReason: string | null;
}

export function CartDeliveryPanel({ C, tabId, draft, onChange, onIdentityChange, customerBalance, suggestedPartyId = null, disabledReason }: CartDeliveryPanelProps) {
  return (
    <div
      data-testid="pos-delivery-mode"
      style={{ flexShrink: 0, maxHeight: "52%", overflowY: "auto", padding: 8, background: C.muted, borderBottom: `1px solid ${C.border}` }}
    >
      <div className="grid gap-2 lg:grid-cols-[minmax(250px,1fr)_minmax(320px,1.25fr)]" dir="rtl">
        <div className="space-y-2">
          <DeliveryCustomerSection
            key={tabId}
            initialPhone={draft.customerPhone}
            balance={customerBalance}
            onIdentityChange={onIdentityChange}
          />
        </div>
        <DeliveryModeFields draft={draft} onChange={onChange} suggestedPartyId={suggestedPartyId} disabledReason={disabledReason} />
      </div>
    </div>
  );
}
