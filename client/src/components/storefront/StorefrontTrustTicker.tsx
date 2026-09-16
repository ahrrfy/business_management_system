import React from "react";
import { Banknote, Truck, ShieldCheck, MessageCircle } from "lucide-react";

interface StorefrontTrustTickerProps {
  className?: string;
  onOpenWhatsApp?: () => void;
}

export function StorefrontTrustTicker({
  className = "",
  onOpenWhatsApp,
}: StorefrontTrustTickerProps) {
  const trustItems = [
    {
      icon: <Banknote aria-hidden className="size-5 text-emerald-600 dark:text-emerald-400" />,
      title: "دفع عند الاستلام",
      desc: "افحص طلبك وادفع بعد الاستلام",
      badge: "أمان تام",
    },
    {
      icon: <Truck aria-hidden className="size-5 text-blue-600 dark:text-blue-400" />,
      title: "توصيل سريع",
      desc: "تغطية شاملة لكل محافظات العراق",
      badge: "شحن سريع",
    },
    {
      icon: <ShieldCheck aria-hidden className="size-5 text-indigo-600 dark:text-indigo-400" />,
      title: "ضمان الاستبدال",
      desc: "استبدال فوري ومرن خلال 48 ساعة",
      badge: "أصلي 100%",
    },
    {
      icon: <MessageCircle aria-hidden className="size-5 text-orange-600 dark:text-orange-400" />,
      title: "خدمة زبائن مميزة",
      desc: "استفسارات وطلبات خاصة عبر واتساب",
      badge: "دعم مباشر",
      action: onOpenWhatsApp,
    },
  ];

  return (
    <section
      aria-label="مزايا المتجر والضمانات"
      className={`grid grid-cols-2 gap-3 sm:grid-cols-4 ${className}`}
    >
      {trustItems.map((item) => {
        const CardElement = item.action ? "button" : "div";
        return (
          <CardElement
            key={item.title}
            onClick={item.action}
            type={item.action ? "button" : undefined}
            className={`group relative flex flex-col items-start justify-between rounded-2xl border border-slate-100 bg-white/90 p-4 text-right shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-indigo-100 hover:shadow-md dark:border-slate-800 dark:bg-slate-900/90 ${
              item.action ? "cursor-pointer" : ""
            }`}
          >
            <div className="flex w-full items-center justify-between">
              <div className="flex size-10 items-center justify-center rounded-xl bg-slate-50 transition-colors duration-300 group-hover:bg-indigo-50 dark:bg-slate-800 dark:group-hover:bg-indigo-950">
                {item.icon}
              </div>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-black text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {item.badge}
              </span>
            </div>

            <div className="mt-3">
              <span className="block text-xs font-black text-slate-800 dark:text-slate-100">
                {item.title}
              </span>
              <span className="mt-0.5 block text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                {item.desc}
              </span>
            </div>
          </CardElement>
        );
      })}
    </section>
  );
}
