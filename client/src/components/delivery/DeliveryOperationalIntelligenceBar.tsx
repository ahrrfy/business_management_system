/**
 * DeliveryOperationalIntelligenceBar - شريط المؤشرات التشغيلية والذكاء الوظيفي للتوصيل
 * يعرض ملخصاً حياً للمناديب النشطين، الطرود بالشارع، إجمالي مبالغ COD، وتنبيهات السقف النقدي
 */
import React from "react";
import { AlertTriangle, Package, ShieldCheck, Truck, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fmt } from "@/lib/money";
import type { DeliveryPartySummary } from "./DeliveryPartyExposureBadge";

interface Props {
  parties: DeliveryPartySummary[];
  className?: string;
}

export function DeliveryOperationalIntelligenceBar({ parties, className = "" }: Props) {
  const activePartiesCount = parties.length;
  const individualCount = parties.filter((p) => p.partyType === "INDIVIDUAL").length;
  const companyCount = parties.filter((p) => p.partyType === "COMPANY").length;

  let totalOpenParcels = 0;
  let totalInTransitCod = 0;
  let overLimitCount = 0;
  let nearLimitCount = 0;

  for (const p of parties) {
    const open = p.openConsignments ?? 0;
    const amount = Number(p.parcelsInTransitAmount ?? "0");
    totalOpenParcels += open;
    totalInTransitCod += amount;

    if (p.floatLimit) {
      const limit = Number(p.floatLimit);
      if (limit > 0) {
        if (amount > limit) {
          overLimitCount++;
        } else if (amount >= limit * 0.8) {
          nearLimitCount++;
        }
      }
    }
  }

  return (
    <div
      className={`rounded-2xl border bg-card p-3 shadow-xs transition-all ${className}`}
      dir="rtl"
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:gap-3 text-xs">
        {/* النشاط الميداني */}
        <div className="flex items-center gap-2.5 rounded-xl border bg-muted/20 p-2.5">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <Truck aria-hidden className="size-4 shrink-0" />
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground font-medium">المناديب النشطون</p>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-base font-extrabold font-mono text-foreground">
                {activePartiesCount}
              </span>
              <span className="text-[10px] text-muted-foreground">
                ({individualCount} داخلي · {companyCount} شركة)
              </span>
            </div>
          </div>
        </div>

        {/* الطرود في الشارع */}
        <div className="flex items-center gap-2.5 rounded-xl border bg-muted/20 p-2.5">
          <div className="rounded-lg bg-blue-500/10 p-2 text-blue-600">
            <Package aria-hidden className="size-4 shrink-0" />
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground font-medium">طرود قيد التوصيل</p>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-base font-extrabold font-mono text-foreground">
                {totalOpenParcels}
              </span>
              <span className="text-[10px] text-muted-foreground">طرد مفتوح</span>
            </div>
          </div>
        </div>

        {/* إجمالي مبالغ COD */}
        <div className="flex items-center gap-2.5 rounded-xl border bg-muted/20 p-2.5">
          <div className="rounded-lg bg-[var(--sem-pos-bg)]/40 p-2 text-[var(--sem-pos)]">
            <Wallet aria-hidden className="size-4 shrink-0" />
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground font-medium">مبالغ بعهدة المناديب (COD)</p>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-base font-extrabold font-mono text-foreground">
                {fmt(totalInTransitCod)}
              </span>
              <span className="text-[10px] text-muted-foreground">د.ع</span>
            </div>
          </div>
        </div>

        {/* حالة السلامة وسقف العهدة */}
        <div className="flex items-center gap-2.5 rounded-xl border bg-muted/20 p-2.5">
          <div
            className={`rounded-lg p-2 ${
              overLimitCount > 0
                ? "bg-destructive/10 text-destructive"
                : nearLimitCount > 0
                ? "bg-[var(--sem-warn-bg)]/40 text-[var(--sem-warn)]"
                : "bg-emerald-500/10 text-emerald-600"
            }`}
          >
            {overLimitCount > 0 || nearLimitCount > 0 ? (
              <AlertTriangle aria-hidden className="size-4 shrink-0" />
            ) : (
              <ShieldCheck aria-hidden className="size-4 shrink-0" />
            )}
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground font-medium">سقوف العهدة والائتمان</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              {overLimitCount > 0 ? (
                <Badge variant="destructive" className="h-5 px-1.5 text-[10px] font-bold">
                  {overLimitCount} تجاوز السقف
                </Badge>
              ) : nearLimitCount > 0 ? (
                <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-bold border-[var(--sem-warn)] text-[var(--sem-warn)]">
                  {nearLimitCount} قرب السقف
                </Badge>
              ) : (
                <span className="text-xs font-bold text-emerald-600">جميع المناديب ضمن السقف</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
