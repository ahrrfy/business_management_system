import { type RouterOutputs } from "@/lib/trpc";
import { Briefcase, MessageCircle, Package } from "lucide-react";
import { Link } from "wouter";
import { useOptionalStorefrontConsent } from "./ConsentChoice";
import { STORE_NAME, STORE_TAGLINE } from "./storefrontCatalogModel";

interface Props {
  openTrack: (orderNumber?: string) => void;
  settings: RouterOutputs["storefront"]["settings"] | undefined;
}

export function StorefrontFooter({ openTrack, settings }: Props) {
  const consent = useOptionalStorefrontConsent();

  return (
    <footer className="mt-12 border-t border-slate-900/[0.08] bg-white pb-24 dark:border-slate-800 dark:bg-slate-900">
      <div className="mx-auto max-w-[1500px] px-4 py-8 lg:px-8">
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <p className="store-display-title text-base font-bold text-slate-900 dark:text-white">
              {STORE_NAME} — متجر مكتبة العربية الرسمي
            </p>
            <p className="mt-1 text-xs font-medium text-slate-500 dark:text-slate-400">
              {STORE_TAGLINE}
            </p>
          </div>

          <nav
            className="flex flex-wrap items-center gap-2"
            aria-label="خدمات المتجر والدعم"
          >
            <button
              type="button"
              onClick={() => openTrack()}
              className="flex touch-manipulation items-center gap-1.5 rounded-full border border-slate-200 bg-[#f8f8fa] px-3.5 py-2 text-xs font-semibold text-slate-700 transition-[transform,border-color,background-color] duration-150 ease-out hover:border-slate-300 hover:bg-white active:scale-[0.97] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <Package aria-hidden className="size-3.5" />
              تتبّع طلبي
            </button>
            <Link
              href="/apply"
              className="flex touch-manipulation items-center gap-1.5 rounded-full border border-slate-200 bg-[#f8f8fa] px-3.5 py-2 text-xs font-semibold text-slate-700 transition-[transform,border-color,background-color] duration-150 ease-out hover:border-slate-300 hover:bg-white active:scale-[0.97] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <Briefcase aria-hidden className="size-3.5" />
              الوظائف
            </Link>
            {settings?.whatsappNumber && (
              <a
                href={`https://wa.me/${settings.whatsappNumber.replace(/[^\d]/g, "")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex touch-manipulation items-center gap-1.5 rounded-full border border-slate-200 bg-[#f8f8fa] px-3.5 py-2 text-xs font-semibold text-slate-700 transition-[transform,border-color,background-color] duration-150 ease-out hover:border-slate-300 hover:bg-white active:scale-[0.97] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                <MessageCircle aria-hidden className="size-3.5" />
                تواصل معنا
              </a>
            )}
          </nav>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-900/[0.06] pt-5 text-[11px] font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <Link href="/legal/privacy" className="hover:text-slate-900 dark:hover:text-white">
              سياسة الخصوصية
            </Link>
            <Link href="/legal/terms" className="hover:text-slate-900 dark:hover:text-white">
              الشروط والأحكام
            </Link>
            <Link href="/legal/returns" className="hover:text-slate-900 dark:hover:text-white">
              الاسترجاع والاستبدال
            </Link>
            {consent && (
              <button
                type="button"
                onClick={consent.openPreferences}
                className="hover:text-slate-900 dark:hover:text-white"
              >
                تفضيلات الخصوصية
              </button>
            )}
          </div>
          <span>شركة الرؤية العربية للتجارة العامة — العراق</span>
        </div>
      </div>
    </footer>
  );
}
