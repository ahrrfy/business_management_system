import React from "react";
import { Banknote, Truck, Phone, MessageCircle } from "lucide-react";
import { fmtInt } from "@/lib/money";

interface StoreTrustAndHelpProps {
  whatsappNumber?: string | null;
  freeShippingThreshold: number;
  freeShippingThresholdBaghdad?: number | string | null;
  freeShippingThresholdGovernorates?: number | string | null;
}

export function StoreTrustAndHelp({
  whatsappNumber,
  freeShippingThreshold,
  freeShippingThresholdBaghdad,
  freeShippingThresholdGovernorates,
}: StoreTrustAndHelpProps) {
  const whatsappHref = whatsappNumber ? `https://wa.me/${whatsappNumber.replace(/[^\d]/g, "")}` : null;
  const baghdadThr = Number(freeShippingThresholdBaghdad ?? freeShippingThreshold ?? 0);
  const govThr = Number(freeShippingThresholdGovernorates ?? 0);

  return (
    <section aria-labelledby="store-help-title" className="mt-8 rounded-2xl border border-slate-900/[0.08] bg-white p-4 sm:p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold text-[var(--store-brand)]">تسوّق بثقة ووضوح</p>
          <h2 id="store-help-title" className="mt-0.5 text-base font-black text-[#1d1d1f] dark:text-white">معلومات تساعدك قبل الطلب</h2>
        </div>
        {whatsappHref && (
          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 w-full sm:w-auto justify-center items-center gap-2 rounded-full bg-[#1d1d1f] px-5 py-2.5 text-xs font-bold text-white shadow-xs transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--store-brand)] dark:bg-white dark:text-[#1d1d1f]"
          >
            <MessageCircle aria-hidden className="size-4 text-emerald-400 dark:text-emerald-600" /> اسألنا مباشرة عبر واتساب
          </a>
        )}
      </div>

      <div className="mt-4 grid gap-2.5 sm:gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200/80 bg-[#f5f5f7] p-3.5 sm:p-4 transition-colors hover:bg-white dark:border-slate-800 dark:bg-slate-800/50">
          <p className="flex items-center gap-2 text-xs font-black text-[#1d1d1f] dark:text-white">
            <Banknote aria-hidden className="size-4 text-[var(--store-brand)]" /> الدفع عند الاستلام
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            لا تدفع مقدماً؛ تدفع نقداً لمندوب التوصيل بعد استلام طلبك ومطابقته وفحصه بالكامل.
          </p>
        </div>

        <div className="rounded-xl border border-slate-200/80 bg-[#f5f5f7] p-3.5 sm:p-4 transition-colors hover:bg-white dark:border-slate-800 dark:bg-slate-800/50">
          <p className="flex items-center gap-2 text-xs font-black text-[#1d1d1f] dark:text-white">
            <Truck aria-hidden className="size-4 text-[var(--store-brand)]" /> أجور التوصيل واضحة
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            {baghdadThr > 0 && govThr > 0 && baghdadThr !== govThr
              ? `التوصيل مجاني تلقائياً لبغداد عند بلوغ ${fmtInt(baghdadThr)} د.ع وللمحافظات عند ${fmtInt(govThr)} د.ع، ويظهر المتبقي في السلة.`
              : freeShippingThreshold > 0
                ? `يصبح التوصيل مجانياً تلقائياً عندما تبلغ قيمة المنتجات ${fmtInt(freeShippingThreshold)} د.ع، ويظهر لك مقدار المتبقي في السلة.`
                : "تُحسب أجرة التوصيل حسب محافظتك قبل تأكيد الطلب وتظهر بشفافية في ملخص السلة."}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200/80 bg-[#f5f5f7] p-3.5 sm:p-4 transition-colors hover:bg-white dark:border-slate-800 dark:bg-slate-800/50">
          <p className="flex items-center gap-2 text-xs font-black text-[#1d1d1f] dark:text-white">
            <Phone aria-hidden className="size-4 text-[var(--store-brand)]" /> تأكيد بالاتصال
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            يتواصل معك فريقنا هاتفياً قبل إرسال الشحنة للتحقق من العنوان والموعد وتفاصيل الطلب.
          </p>
        </div>
      </div>
    </section>
  );
}
