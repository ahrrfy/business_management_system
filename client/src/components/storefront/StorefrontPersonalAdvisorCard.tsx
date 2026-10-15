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
      className={`rounded-2xl border border-emerald-200/80 bg-emerald-50/60 p-3 sm:p-3.5 transition dark:border-emerald-800/40 dark:bg-emerald-950/20 ${className}`}
      aria-label="بطاقة المستشار الشخصي"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-xs dark:bg-emerald-500">
            <UserCheck aria-hidden className="size-5" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h5 className="text-xs font-black text-slate-800 dark:text-slate-100">
                مستشارك المباشر للطلب والشركات
              </h5>
              <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.2 text-[9px] font-bold text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300">
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
          className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-600 bg-white px-3 py-1.5 text-[11px] font-black text-emerald-700 shadow-xs transition hover:bg-emerald-600 hover:text-white active:scale-95 dark:border-emerald-500 dark:bg-slate-900 dark:text-emerald-400 dark:hover:bg-emerald-600 dark:hover:text-white"
        >
          <MessageCircle aria-hidden className="size-3.5" />
          <span className="hidden sm:inline">استشارة فورية</span>
          <span className="sm:hidden">واتساب</span>
        </button>
      </div>
    </div>
  );
}
