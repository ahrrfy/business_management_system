import { money } from "@/components/storefront/storefrontCartMath";
import { type Panel } from "@/components/storefront/storefrontCatalogModel";
import { StorefrontPanelShell } from "@/components/storefront/StorefrontPanelShell";
import { formatQuantity } from "@/lib/money";
import { type RouterOutputs } from "@/lib/trpc";
import {
  orderStatusChipClass,
  orderStatusLabelForCustomer,
} from "@shared/onlineOrderStatus";
import { Loader2 } from "lucide-react";
import React from "react";
export interface StorefrontLabelPanelProps {
  setPanel: React.Dispatch<React.SetStateAction<Panel>>;
  labelLoading: boolean;
  labelData: RouterOutputs["storefront"]["labelSummary"] | undefined;
}
export function StorefrontLabelPanel({
  setPanel,
  labelLoading,
  labelData,
}: StorefrontLabelPanelProps) {
  return (
    <StorefrontPanelShell
      title="معلومات طلب الشحن"
      onClose={() => setPanel(null)}
    >
      {labelLoading ? (
        <div className="flex justify-center py-12 text-[var(--sem-info)]">
          <Loader2 aria-hidden className="size-7 animate-spin" />
        </div>
      ) : labelData ? (
        <div className="space-y-3 text-sm">
          <div className="rounded-xl bg-white p-4 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
            <div className="flex items-center justify-between">
              <span className="font-extrabold" dir="ltr">
                {labelData.orderNumber}
              </span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${orderStatusChipClass(labelData.status)}`}
              >
                {orderStatusLabelForCustomer(labelData.status)}
              </span>
            </div>
            <p className="mt-3 text-base font-extrabold text-slate-900 dark:text-white">
              {labelData.customerName ?? "العميل"}
            </p>
            {labelData.customerPhone && (
              <p
                dir="ltr"
                className="mt-1 font-extrabold text-[var(--sem-info)]"
              >
                {labelData.customerPhone}
              </p>
            )}
            <p className="mt-2 leading-relaxed text-slate-600 dark:text-slate-300">
              {labelData.addressText ?? labelData.governorate ?? "—"}
            </p>
          </div>
          <div className="rounded-xl bg-white p-4 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
            <p className="mb-2 text-xs font-extrabold text-slate-500">
              منتجات الطلب
            </p>
            <div className="space-y-2">
              {labelData.items.map((it, index) => (
                <div
                  key={index}
                  className="flex justify-between gap-3 border-b border-slate-100 pb-2 last:border-0 last:pb-0 dark:border-slate-800"
                >
                  <span>
                    {it.productName}
                    {it.unitName ? ` — ${it.unitName}` : ""}
                  </span>
                  <b className="shrink-0 tabular-nums">
                    ×{formatQuantity(it.quantity)}
                  </b>
                </div>
              ))}
            </div>
            <div className="mt-3 flex justify-between border-t border-slate-200 pt-3 text-base font-extrabold dark:border-slate-700">
              <span>المبلغ عند الاستلام</span>
              <span dir="ltr" className="text-money-positive">
                {money(labelData.total)} د.ع
              </span>
            </div>
          </div>
        </div>
      ) : (
        <p className="py-10 text-center text-sm font-bold text-destructive">
          تعذر فتح معلومات هذا الملصق.
        </p>
      )}
    </StorefrontPanelShell>
  );
}
