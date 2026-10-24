import { SplitTenderButton } from "@/components/payments/SplitTenderButton";

import { CreditCard, ShieldCheck, X } from "lucide-react";

import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { isPosPaymentMethodEnabled } from "@shared/posPaymentPolicy";

import { normalizeNumberInput } from "@shared/numberNormalize";

import { CardBrandLogos } from "@/components/ui/CardBrandLogos";
import type { PaymentPanelProps } from "./PaymentPanel";
import { INBOUND_ENABLED_PAYMENT_METHODS } from "@shared/inboundPaymentPolicy";
import { paymentMethodCompact } from "@shared/terms";
const POS_METHODS = INBOUND_ENABLED_PAYMENT_METHODS.filter(v => v === "CASH" || v === "CARD").map((v) => ({
  v,
  label: paymentMethodCompact(v),
}));
export function ReceptionTenderControls(
  props: PaymentPanelProps & {
    displayPay: string;
    setDisplayPay: (value: string) => void;
  },
) {
  const {
    splitTender,
    splitDisabledReason,
    setPayInput,
    deferred,
    setDeferred,
    deferredAvailable,
    method,
    setMethod,
    paymentReference,
    setPaymentReference,
    needPaymentRef,
    expectedNow,
    heldDelivery,
    paid,
    remaining,
    hasCustom,
    payAll,
    submitting,
    cartEmpty,
    hasShift,
    displayPay,
    setDisplayPay,
  } = props;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {splitTender && (
        <SplitTenderButton
          draft={splitTender}
          due={String(expectedNow)}
          disabled={
            submitting ||
            cartEmpty ||
            !hasShift ||
            (!splitTender.active && !!splitDisabledReason)
          }
          reason={splitDisabledReason}
        />
      )}
      <div className="flex items-center rounded-lg border bg-card p-1">
        <span className="px-2 text-xs font-bold text-muted-foreground">
          المدفوع:
        </span>
        <input
          type="text"
          inputMode="decimal"
          value={displayPay}
          readOnly={splitTender?.active === true}
          onChange={(e) => {
            const val = e.target.value;
            setDisplayPay(val);
            try {
              const norm = normalizeNumberInput(val).normalized;
              setPayInput(norm);
            } catch {
              setPayInput(val);
            }
          }}
          className="h-8 w-24 rounded bg-transparent px-2 text-sm font-black tabular-nums outline-none focus:bg-accent/50"
          dir="ltr"
          placeholder="0"
        />
        <button
          type="button"
          onClick={payAll}
          disabled={splitTender?.active === true}
          className="rounded bg-muted px-2 py-1 text-xs font-bold text-muted-foreground hover:bg-primary/20 hover:text-primary"
        >
          = الكل
        </button>
      </div>

      {(!splitTender?.active || heldDelivery > 0) && (
        <div className="flex items-center rounded-lg border bg-card p-0.5">
          {splitTender?.active && (
            <span className="px-2 text-xs">قبض أجرة التوصيل:</span>
          )}
          {POS_METHODS.map((p) => (
            <button
              key={p.v}
              type="button"
              disabled={!isPosPaymentMethodEnabled(p.v)}
              onClick={() => setMethod(p.v)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-bold transition-colors",
                method === p.v
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {p.v === "CARD" && <CardBrandLogos size="xs" />}
              <span>{p.label}</span>
            </button>
          ))}
        </div>
      )}

      {method !== "CASH" && (!splitTender?.active || heldDelivery > 0) && (
        <div
          className={cn(
            "flex items-center rounded-lg border bg-card p-1 shadow-xs transition-colors",
            needPaymentRef && !paymentReference.trim()
              ? "border-[var(--sem-warn)] ring-1 ring-[var(--sem-warn)]/30"
              : "border-primary/40",
          )}
        >
          {method === "CARD" ? (
            <CardBrandLogos size="xs" className="ms-1" />
          ) : (
            <CreditCard aria-hidden className="size-4 text-primary ms-1" />
          )}
          <span className="px-1.5 text-xs font-bold text-muted-foreground whitespace-nowrap">
            {method === "CARD" ? "رقم العملية:" : "رقم المرجع:"}
          </span>
          <input
            type="text"
            value={paymentReference}
            onChange={(e) => setPaymentReference(e.target.value)}
            placeholder={
              method === "CARD"
                ? "رقم إيصال الـ POS"
                : method === "WALLET"
                  ? "رقم عملية المحفظة"
                  : "رقم العملية"
            }
            className="h-8 w-36 rounded bg-transparent px-2 text-xs font-bold outline-none focus:bg-accent/50 text-foreground placeholder:text-muted-foreground/60"
            dir="ltr"
            autoFocus
          />
          {paymentReference && (
            <button
              type="button"
              onClick={() => setPaymentReference("")}
              className="p-1 text-muted-foreground hover:text-foreground"
              title="مسح"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          )}
        </div>
      )}

      {deferredAvailable && (
        <button
          type="button"
          onClick={() => setDeferred(!deferred)}
          className={cn(
            "rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors",
            deferred
              ? "border-[var(--sem-warn)] bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
              : "text-muted-foreground hover:bg-muted",
          )}
        >
          آجل (ذمّة)
        </button>
      )}

      {hasCustom && !splitTender?.active && (
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-bold",
            paid > 0
              ? "border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
              : "border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
          )}
        >
          <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0" />
          <span>
            {paid > 0
              ? paid >= expectedNow
                ? "دفع كامل للطلب وإرسال للتنفيذ"
                : `عربون مقبوض: ${fmt(paid)} د.ع · متبقٍّ للتسليم: ${fmt(remaining)} د.ع`
              : "الدفع عند الاستلام · لم يُقبض شيء"}
          </span>
        </span>
      )}
    </div>
  );
}
