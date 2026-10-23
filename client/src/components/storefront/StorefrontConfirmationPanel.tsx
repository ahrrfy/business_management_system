import { money } from "@/components/storefront/storefrontCartMath";
import { type Panel } from "@/components/storefront/storefrontCatalogModel";
import { StorefrontPanelShell } from "@/components/storefront/StorefrontPanelShell";
import { Check, Package } from "lucide-react";
import React from "react";
import { formatStorefrontReservationDeadline } from "./storefrontCatalogModel";
export interface StorefrontConfirmationPanelProps {
  setPanel: React.Dispatch<React.SetStateAction<Panel>>;
  confirmation: {
    orderNumber: string;
    total: string;
    reservationExpiresAt: Date | string;
  };
  setConfirmation: React.Dispatch<
    React.SetStateAction<{
      orderNumber: string;
      total: string;
      reservationExpiresAt: Date | string;
    } | null>
  >;
  openTrack: (orderNumber?: string) => void;
}
export function StorefrontConfirmationPanel({
  setPanel,
  confirmation,
  setConfirmation,
  openTrack,
}: StorefrontConfirmationPanelProps) {
  return (
    <StorefrontPanelShell
      title="تمّ استلام طلبك"
      onClose={() => setPanel(null)}
    >
      <div className="flex flex-col items-center py-6 text-center">
        <div className="flex size-20 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
          <Check aria-hidden className="size-10" />
        </div>
        <h3 className="mt-4 text-lg font-extrabold text-slate-900 dark:text-white">
          شكراً لك — تمّ استلام طلبك
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          سنتواصل معك لتأكيد التوصيل.
        </p>
        <p className="mt-3 rounded-xl bg-[var(--sem-warn)]/5 px-3 py-2 text-xs font-bold text-[var(--sem-warn)] ring-1 ring-[var(--sem-warn)]/40">
          الكمية محجوزة حتى{" "}
          {formatStorefrontReservationDeadline(
            confirmation.reservationExpiresAt,
          )}
          ؛ بعد ذلك يلزم إعادة الطلب حسب التوفر.
        </p>
        <div className="mt-5 w-full rounded-xl bg-white p-4 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">رقم الطلب</span>
            <span className="font-extrabold tracking-wider text-slate-900 dark:text-white">
              {confirmation.orderNumber}
            </span>
          </div>
          <div className="mt-2 flex justify-between text-sm">
            <span className="text-slate-500">الإجمالي (يُدفع للمندوب)</span>
            <span className="font-extrabold tabular-nums text-emerald-600 dark:text-emerald-400">
              {money(confirmation.total)} د.ع
            </span>
          </div>
        </div>
        <button
          onClick={() => {
            setPanel(null);
            setConfirmation(null);
          }}
          className="mt-6 w-full rounded-xl bg-emerald-700 py-4 text-sm font-extrabold text-white transition motion-safe:active:scale-[0.98] hover:bg-emerald-800"
        >
          متابعة التسوّق
        </button>
        <button
          onClick={() => openTrack(confirmation.orderNumber)}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl bg-white py-3.5 text-sm font-extrabold text-emerald-700 ring-1 ring-emerald-200 transition hover:bg-emerald-50 dark:bg-slate-900 dark:text-emerald-400 dark:ring-slate-700"
        >
          <Package aria-hidden className="size-4" /> تتبّع هذا الطلب
        </button>
      </div>
    </StorefrontPanelShell>
  );
}
