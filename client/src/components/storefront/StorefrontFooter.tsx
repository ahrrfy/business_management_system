import { type RouterOutputs } from "@/lib/trpc";
import { Briefcase, MessageCircle, Package } from "lucide-react";
import { Link } from "wouter";
import { STORE_NAME, STORE_TAGLINE } from "./storefrontCatalogModel";
interface Props {
  openTrack: (orderNumber?: string) => void;
  settings: RouterOutputs["storefront"]["settings"] | undefined;
}
export function StorefrontFooter({ openTrack, settings }: Props) {
  return (
    <footer className="mt-10 border-t border-emerald-100 bg-white/70 pb-24 dark:border-slate-800 dark:bg-slate-900/60">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6">
        <div className="min-w-0">
          <p className="text-sm font-extrabold text-slate-700 dark:text-slate-200">
            {STORE_NAME}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
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
            className="flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-600 ring-1 ring-slate-200 transition hover:text-emerald-700 hover:ring-emerald-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700"
          >
            <Package aria-hidden className="size-3.5" />
            تتبّع طلبي
          </button>
          <Link
            href="/apply"
            className="flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-600 ring-1 ring-slate-200 transition hover:text-emerald-700 hover:ring-emerald-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700"
          >
            <Briefcase aria-hidden className="size-3.5" />
            الوظائف — انضمّ إلى فريقنا
          </Link>
          {settings?.whatsappNumber && (
            <a
              href={`https://wa.me/${settings.whatsappNumber.replace(/[^\d]/g, "")}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-600 ring-1 ring-slate-200 transition hover:text-emerald-700 hover:ring-emerald-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700"
            >
              <MessageCircle aria-hidden className="size-3.5" />
              تواصل معنا
            </a>
          )}
        </nav>
      </div>
    </footer>
  );
}
