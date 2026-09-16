import React from "react";
import { Banknote, Truck, Phone, MessageCircle } from "lucide-react";
import { fmtInt } from "@/lib/money";

interface StoreTrustAndHelpProps {
  whatsappNumber?: string | null;
  freeShippingThreshold: number;
}

export function StoreTrustAndHelp({
  whatsappNumber,
  freeShippingThreshold,
}: StoreTrustAndHelpProps) {
  const whatsappHref = whatsappNumber ? `https://wa.me/${whatsappNumber.replace(/[^\d]/g, "")}` : null;

  return (
    <section aria-labelledby="store-help-title" className="mt-8 rounded-2xl border border-indigo-100 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-black text-blue-700 dark:text-blue-400">تسوّق بثقة ووضوح</p>
          <h2 id="store-help-title" className="mt-0.5 text-base font-black text-slate-900 dark:text-white">معلومات تساعدك قبل الطلب</h2>
        </div>
        {whatsappHref && (
          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2 text-xs font-black text-white shadow-sm transition hover:from-emerald-700 hover:to-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2"
          >
            <MessageCircle aria-hidden className="size-4" /> اسألنا مباشرة عبر واتساب
          </a>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-4 transition-all hover:bg-white hover:shadow-xs dark:border-slate-800 dark:bg-slate-800/50">
          <p className="flex items-center gap-2 text-xs font-black text-blue-800 dark:text-blue-300">
            <Banknote aria-hidden className="size-4 text-blue-600 dark:text-blue-400" /> الدفع عند الاستلام
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            لا تدفع مقدماً؛ تدفع نقداً لمندوب التوصيل بعد استلام طلبك ومطابقته وفحصه بالكامل.
          </p>
        </div>

        <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-4 transition-all hover:bg-white hover:shadow-xs dark:border-slate-800 dark:bg-slate-800/50">
          <p className="flex items-center gap-2 text-xs font-black text-emerald-800 dark:text-emerald-300">
            <Truck aria-hidden className="size-4 text-emerald-600 dark:text-emerald-400" /> أجور التوصيل واضحة
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            {freeShippingThreshold > 0
              ? `يصبح التوصيل مجانياً تلقائياً عندما تبلغ قيمة المنتجات ${fmtInt(freeShippingThreshold)} د.ع، ويظهر لك مقدار المتبقي في السلة.`
              : "تُحسب أجرة التوصيل حسب محافظتك قبل تأكيد الطلب وتظهر بشفافية في ملخص السلة."}
          </p>
        </div>

        <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-4 transition-all hover:bg-white hover:shadow-xs dark:border-slate-800 dark:bg-slate-800/50">
          <p className="flex items-center gap-2 text-xs font-black text-orange-800 dark:text-orange-300">
            <Phone aria-hidden className="size-4 text-orange-600 dark:text-orange-400" /> تأكيد بالاتصال
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            يتواصل معك فريقنا هاتفياً قبل إرسال الشحنة للتحقق من العنوان والموعد وتفاصيل الطلب.
          </p>
        </div>
      </div>
    </section>
  );
}
