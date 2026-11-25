import React from "react";
import { UserCheck, MessageCircle, ShieldCheck } from "lucide-react";
import { openWhatsApp } from "@/lib/whatsapp";

interface StorefrontPersonalAdvisorCardProps {
  productTitle?: string;
  whatsappNumber?: string | null;
  className?: string;
}

export function StorefrontPersonalAdvisorCard({
  productTitle,
  whatsappNumber,
  className = "",
}: StorefrontPersonalAdvisorCardProps) {
  if (!whatsappNumber) return null;

  const inquiryMessage = productTitle
    ? `مرحباً، أود استشارة حول منتج «${productTitle}» وتفاصيل المواصفات والكميات للطلب.`
    : "مرحباً، أود استشارة بخصوص طلبات الشركات وتفاصيل التجهيز من الرؤية العربية.";

  return (
    <div
      className={`rounded-2xl border border-slate-200/90 bg-[#f5f5f7] p-3 sm:p-3.5 transition dark:border-slate-800 dark:bg-slate-900/70 ${className}`}
      aria-label="بطاقة المستشار الشخصي"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-xl bg-[#1d1d1f] text-white shadow-xs dark:bg-white dark:text-[#1d1d1f]">
            <UserCheck aria-hidden className="size-5" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h5 className="text-xs font-black text-[#1d1d1f] dark:text-slate-100">
                مستشارك المباشر للطلب والشركات
              </h5>
              <span className="inline-flex items-center gap-0.5 rounded-full bg-white px-2 py-0.5 text-[9px] font-bold text-[var(--store-brand)] ring-1 ring-slate-200/80 dark:bg-slate-800 dark:text-blue-300 dark:ring-slate-700">
                <ShieldCheck aria-hidden className="size-2.5" />
                <span>معتمد</span>
              </span>
            </div>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">
              جاهزون لمساعدتك في المواصفات، عينات الطباعة، وأسعار الجملة
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => openWhatsApp(whatsappNumber, inquiryMessage)}
          className="inline-flex items-center gap-1.5 rounded-full bg-[#1d1d1f] px-3.5 py-1.5 text-[11px] font-bold text-white shadow-xs transition hover:bg-slate-800 active:scale-95 dark:bg-white dark:text-[#1d1d1f]"
        >
          <MessageCircle aria-hidden className="size-3.5 text-emerald-400 dark:text-emerald-600" />
          <span className="hidden sm:inline">استشارة فورية</span>
          <span className="sm:hidden">واتساب</span>
        </button>
      </div>
    </div>
  );
}
