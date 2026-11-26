import React from "react";
import { Banknote, Phone, Truck } from "lucide-react";
import { fmtInt } from "@/lib/money";

interface StoreTrustAndHelpProps {
  whatsappNumber?: string | null;
  freeShippingThreshold: number;
  freeShippingThresholdBaghdad?: number | string | null;
  freeShippingThresholdGovernorates?: number | string | null;
}

export function StoreTrustAndHelp({
  freeShippingThreshold,
  freeShippingThresholdBaghdad,
  freeShippingThresholdGovernorates,
}: StoreTrustAndHelpProps) {
  const baghdadThr = Number(freeShippingThresholdBaghdad ?? freeShippingThreshold ?? 0);
  const govThr = Number(freeShippingThresholdGovernorates ?? 0);

  const shippingLabel =
    baghdadThr > 0 && govThr > 0 && baghdadThr !== govThr
      ? `توصيل مجاني لبغداد من ${fmtInt(baghdadThr)} د.ع وللمحافظات من ${fmtInt(govThr)} د.ع`
      : freeShippingThreshold > 0
        ? `توصيل مجاني للطلبات من ${fmtInt(freeShippingThreshold)} د.ع`
        : "توصيل سريع لكافة المحافظات";

  return (
    <section
      aria-label="مزايا الطلب من المتجر"
      className="mt-4 rounded-2xl border border-slate-900/[0.06] bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
        <span className="inline-flex items-center gap-1.5">
          <Truck aria-hidden className="size-3.5 text-[var(--store-brand)]" />
          <span>{shippingLabel}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Banknote aria-hidden className="size-3.5 text-[var(--store-brand)]" />
          <span>الدفع نقدا عند الاستلام</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Phone aria-hidden className="size-3.5 text-[var(--store-brand)]" />
          <span>تأكيد الطلب قبل الإرسال</span>
        </span>
      </div>
    </section>
  );
}
