import { AlertTriangle, Banknote, CreditCard, Plus, Send, Split, Trash2, Wallet, X } from "lucide-react";
import { CardBrandLogos } from "@/components/ui/CardBrandLogos";
import { D, round2 } from "@/lib/money";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PaymentReferenceField } from "./PaymentReferenceField";
import { isSplitLegExternalConfirmed, parsePosLegAmountD } from "./posTotals";
import {
  type PaymentMethod,
  type PosPaymentLegDraft,
  type PosColors as C,
  fmt,
} from "./posShared";

export { isSplitLegExternalConfirmed };

export interface SplitPaymentSectionProps {
  C: C;
  total: number;
  cartLen: number;
  paymentLegs: PosPaymentLegDraft[];
  onEnableSplit: () => void;
  onDisableSplit: () => void;
  onAddLeg: () => void;
  onUpdateLeg: (
    legId: string,
    patch: Partial<Pick<PosPaymentLegDraft, "method" | "amount" | "paymentRef">>,
  ) => void;
  onRemoveLeg: (legId: string) => void;
  onConfirmLegExternalPayment: (legId: string) => void;
  confirmingLegId: string | null;
  splitNonCashOverpay?: boolean;
  deliveryFeeHeld?: number;
}

export function SplitPaymentSection({
  C,
  total,
  cartLen,
  paymentLegs,
  onEnableSplit,
  onDisableSplit,
  onAddLeg,
  onUpdateLeg,
  onRemoveLeg,
  onConfirmLegExternalPayment,
  confirmingLegId,
  splitNonCashOverpay = false,
  deliveryFeeHeld = 0,
}: SplitPaymentSectionProps) {
  if (paymentLegs.length === 0) {
    return (
      <div style={{ padding: "2px 11px 2px", flexShrink: 0, display: "flex" }}>
        <button
          type="button"
          disabled={cartLen === 0 || total <= 0}
          onClick={onEnableSplit}
          data-testid="pos-enable-split-payment"
          style={{
            width: "100%",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 5,
            height: 28,
            padding: "0 9px",
            borderRadius: 7,
            border: `1.5px dashed ${C.primary}`,
            background: C.primarySoft,
            color: C.primary,
            fontFamily: "inherit",
            fontSize: 12,
            fontWeight: 800,
            cursor: cartLen === 0 || total <= 0 ? "not-allowed" : "pointer",
            opacity: cartLen === 0 || total <= 0 ? 0.5 : 1,
          }}
        >
          <Split aria-hidden size={13} />
          تقسيم الدفع (نقدي + بطاقة…)
        </button>
      </div>
    );
  }

  const totalD = D(total);
  const sumD = paymentLegs.reduce(
    (acc, l) => acc.plus(parsePosLegAmountD(l.amount)),
    D(0),
  );

  const fillRemainingForLeg = (legId: string) => {
    const othersD = paymentLegs
      .filter((l) => l.id !== legId)
      .reduce((acc, l) => acc.plus(parsePosLegAmountD(l.amount)), D(0));
    const remD = totalD.minus(othersD);
    if (remD.gt(0)) {
      onUpdateLeg(legId, { amount: String(remD.toNumber()) });
    }
  };

  const legMethodBtnStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    minWidth: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    height: 28,
    fontSize: 11.5,
    fontWeight: 800,
    border: `1.5px solid ${active ? C.primary : C.border}`,
    borderRadius: 6,
    cursor: "pointer",
    fontFamily: "inherit",
    background: active ? C.primary : C.card,
    color: active ? C.primaryFg : C.fg,
  });

  const methods: { code: PaymentMethod; label: string; Icon: typeof Banknote }[] = [
    { code: "CASH", label: "نقدي", Icon: Banknote },
    { code: "CARD", label: "بطاقة", Icon: CreditCard },
    { code: "TRANSFER", label: "تحويل", Icon: Send },
    { code: "WALLET", label: "محفظة", Icon: Wallet },
  ];

  return (
    <div
      data-testid="pos-split-payment-panel"
      style={{
        padding: "4px 11px",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 800, color: C.primary }}>
          <Split aria-hidden size={14} />
          الدفع المقسّم ({paymentLegs.length})
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {paymentLegs.length < 4 && (
            <button
              type="button"
              onClick={onAddLeg}
              data-testid="pos-split-add-leg"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                height: 25,
                padding: "0 8px",
                borderRadius: 6,
                border: `1px solid ${C.primary}`,
                background: C.card,
                color: C.primary,
                fontFamily: "inherit",
                fontSize: 11,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              <Plus aria-hidden size={12} />
              دفعة أخرى
            </button>
          )}
          <button
            type="button"
            onClick={onDisableSplit}
            data-testid="pos-disable-split-payment"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              height: 25,
              padding: "0 8px",
              borderRadius: 6,
              border: `1px solid ${C.border}`,
              background: C.muted,
              color: C.mutedFg,
              fontFamily: "inherit",
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            <X aria-hidden size={12} />
            إلغاء التقسيم
          </button>
        </div>
      </div>

      {paymentLegs.map((leg, idx) => {
        const confirmed = isSplitLegExternalConfirmed(leg, D(idx === 0 ? deliveryFeeHeld : 0));
        const confirming = confirmingLegId === leg.id;
        return (
          <div
            key={leg.id}
            data-testid={`pos-split-leg-${idx}`}
            style={{
              border: `1.5px solid ${C.border}`,
              borderRadius: 8,
              padding: "6px 8px",
              background: C.muted,
              display: "flex",
              flexDirection: "column",
              gap: 5,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: C.mutedFg, minWidth: 44 }}>
                دفعة {idx + 1}
              </span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 3, flex: 1 }}>
                {methods.map(({ code, label, Icon }) => (
                  <button
                    key={code}
                    type="button"
                    style={legMethodBtnStyle(leg.method === code)}
                    onClick={() => onUpdateLeg(leg.id, { method: code })}
                  >
                    {code === "CARD" ? <CardBrandLogos size="xs" pill={leg.method === "CARD"} className="min-w-0 shrink px-0.5 py-0" imgClassName="h-2.5 w-auto max-w-[26px]" /> : <Icon aria-hidden size={13} />}
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              {paymentLegs.length > 2 && (
                <button
                  type="button"
                  onClick={() => onRemoveLeg(leg.id)}
                  aria-label={`حذف الدفعة ${idx + 1}`}
                  style={{
                    height: 28,
                    width: 28,
                    borderRadius: 6,
                    border: `1px solid ${C.danger}`,
                    background: C.dangerSoft,
                    color: C.danger,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  <Trash2 aria-hidden size={13} />
                </button>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ fontSize: 11, color: C.mutedFg, fontWeight: 700, minWidth: 44 }}>
                المبلغ
              </span>
              <MoneyInput
                value={leg.amount}
                onChange={(raw) => onUpdateLeg(leg.id, { amount: raw })}
                placeholder="0"
                ariaLabel={`مبلغ الدفعة ${idx + 1}`}
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 30,
                  border: `1.5px solid ${C.border}`,
                  borderRadius: 6,
                  background: C.card,
                  color: C.fg,
                  padding: "0 8px",
                  fontFamily: "inherit",
                  fontSize: 14,
                  fontWeight: 900,
                  direction: "ltr",
                  textAlign: "left",
                  outline: "none",
                }}
              />
              <button
                type="button"
                onClick={() => fillRemainingForLeg(leg.id)}
                title="تعبئة المبلغ المتبقي من إجمالي الفاتورة"
                style={{
                  height: 30,
                  padding: "0 8px",
                  borderRadius: 6,
                  border: `1px solid ${C.primary}`,
                  background: C.card,
                  color: C.primary,
                  fontFamily: "inherit",
                  fontSize: 11,
                  fontWeight: 800,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                = المتبقي
              </button>
            </div>

            {leg.method !== "CASH" && (
              <PaymentReferenceField
                value={leg.paymentRef}
                onChange={(v) => onUpdateLeg(leg.id, { paymentRef: v })}
                method={leg.method}
                confirmed={confirmed}
                confirming={confirming}
                onConfirm={() => onConfirmLegExternalPayment(leg.id)}
                inputId={`pos-split-ref-${leg.id}`}
                colors={{
                  border: C.border,
                  muted: C.card,
                  mutedFg: C.mutedFg,
                  fg: C.fg,
                  amber: C.amber,
                  success: C.success,
                }}
                style={{ marginTop: 2 }}
              />
            )}
          </div>
        );
      })}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "3px 6px",
          borderRadius: 6,
          background: C.card,
          border: `1px solid ${C.border}`,
          fontSize: 11.5,
          fontWeight: 800,
        }}
      >
        <span style={{ color: C.mutedFg }}>مجموع الدفعات المقسّمة</span>
        <span style={{ color: sumD.gte(totalD) ? C.success : C.amber, direction: "ltr" }}>
          {fmt(sumD.toNumber())} / {fmt(total)} د.ع
        </span>
      </div>

      {splitNonCashOverpay && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "4px 8px",
            borderRadius: 6,
            background: C.dangerSoft,
            color: C.danger,
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          <AlertTriangle aria-hidden size={13} style={{ flexShrink: 0 }} />
          <span>مجموع الدفعات غير النقدية يتجاوز إجمالي الفاتورة — الفكّة مسموحة على الشق النقدي فقط.</span>
        </div>
      )}
    </div>
  );
}
