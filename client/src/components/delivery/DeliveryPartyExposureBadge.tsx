/**
 * DeliveryPartyExposureBadge - شارة الذكاء التشغيلي لعُهدة المندوب والتحذير من سقف الائتمان
 */
import React from "react";
import { AlertTriangle, ShieldAlert, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fmt } from "@/lib/money";
import type { RouterOutputs } from "@/lib/trpc";

export type DeliveryPartySummary = RouterOutputs["delivery"]["listParties"][number];

export interface PartyObligationSummaryLike {
  currentBalance?: string | number | null;
  cashInHandStored?: string | number | null;
  shortfallOwedAmount?: string | number | null;
  parcelsInTransitAmount?: string | number | null;
  deliveredUncollectedAmount?: string | number | null;
  codDueTotal?: string | number | null;
  feeDueTotal?: string | number | null;
}

export function computePartySummaryExposure(party: DeliveryPartySummary): {
  inTransitAmount: number;
  cashInHandAmount: number;
  deliveredUncollectedAmount: number;
  totalExposureAmount: number;
} {
  const inTransitAmount = Number(party.parcelsInTransitAmount ?? "0");
  const cashInHandAmount =
    Number(party.cashInHandStored ?? "0") +
    Number(party.shortfallOwedAmount ?? "0");
  const deliveredUncollectedAmount = Number(
    party.deliveredUncollectedAmount ?? "0",
  );
  const totalExposureAmount =
    inTransitAmount + cashInHandAmount + deliveredUncollectedAmount;
  return {
    inTransitAmount,
    cashInHandAmount,
    deliveredUncollectedAmount,
    totalExposureAmount,
  };
}

export function formatPartyObligationOptionLabel(
  name: string,
  roleTag: string | null,
  obligation?: PartyObligationSummaryLike | null,
): string {
  const baseName = roleTag ? `${name} (${roleTag})` : name;
  if (!obligation) return baseName;
  const physicalCash = Number(
    obligation.cashInHandStored ?? obligation.currentBalance ?? 0,
  );
  const shortfall = Number(obligation.shortfallOwedAmount ?? 0);
  const cashInHand = physicalCash + shortfall;
  const hasExplicitTransit =
    obligation.parcelsInTransitAmount !== undefined ||
    obligation.deliveredUncollectedAmount !== undefined;
  const explicitTransit =
    Number(obligation.parcelsInTransitAmount ?? 0) +
    Number(obligation.deliveredUncollectedAmount ?? 0);
  const codTotal = Number(obligation.codDueTotal ?? 0);
  const inTransit = hasExplicitTransit
    ? explicitTransit
    : Math.max(0, codTotal - cashInHand);
  const totalCod = codTotal > 0 ? codTotal : cashInHand + inTransit;
  const feeDue = Number(obligation.feeDueTotal ?? 0);
  const cashLabel =
    shortfall > 0
      ? `نقد بيده: ${fmt(physicalCash)} · عجز: ${fmt(shortfall)}`
      : `نقد بيده: ${fmt(physicalCash)}`;

  if (cashInHand > 0 && inTransit > 0) {
    return `${baseName} — ${cashLabel} · بالطريق: ${fmt(inTransit)} د.ع (إجمالي ${fmt(totalCod)})`;
  }
  if (cashInHand <= 0 && inTransit > 0) {
    return `${baseName} — طرود بالطريق: ${fmt(inTransit)} د.ع (نقد بيده: 0)`;
  }
  if (cashInHand > 0) {
    return `${baseName} — ${cashLabel} د.ع`;
  }
  if (feeDue > 0) {
    return `${baseName} — أجور له: ${fmt(feeDue)} د.ع`;
  }
  return baseName;
}

interface Props {
  party: DeliveryPartySummary | null | undefined;
  compact?: boolean;
}

export function DeliveryPartyExposureBadge({ party, compact = false }: Props) {
  if (!party) return null;

  const openCount = party.openConsignments ?? 0;
  const {
    inTransitAmount,
    cashInHandAmount,
    deliveredUncollectedAmount,
    totalExposureAmount,
  } = computePartySummaryExposure(party);
  const streetAmount = inTransitAmount + deliveredUncollectedAmount;
  const floatLimit = party.floatLimit ? Number(party.floatLimit) : null;
  const isOverLimit =
    floatLimit !== null && floatLimit > 0 && totalExposureAmount > floatLimit;
  const isNearLimit =
    floatLimit !== null &&
    floatLimit > 0 &&
    !isOverLimit &&
    totalExposureAmount >= floatLimit * 0.8;

  if (compact) {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">العهدة المفتوحة:</span>
        <span className="font-bold text-foreground font-mono">{openCount} طرد</span>
        <span className="text-muted-foreground">·</span>
        <span className="font-bold text-foreground font-mono">{fmt(totalExposureAmount)} د.ع</span>
        {cashInHandAmount > 0 && streetAmount > 0 && (
          <span className="text-[10px] text-muted-foreground font-mono">
            (بيده {fmt(cashInHandAmount)} · بالطريق {fmt(streetAmount)})
          </span>
        )}
        {isOverLimit && (
          <Badge variant="destructive" className="h-5 px-1.5 text-[10px] gap-1 font-bold animate-pulse">
            <ShieldAlert aria-hidden className="size-3 shrink-0" />
            تجاوز السقف
          </Badge>
        )}
        {isNearLimit && (
          <Badge variant="outline" className="h-5 px-1.5 text-[10px] gap-1 font-bold border-[var(--sem-warn)] text-[var(--sem-warn)]">
            <AlertTriangle aria-hidden className="size-3 shrink-0" />
            قريب من السقف
          </Badge>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-background/80 p-2.5 text-xs space-y-1.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 font-bold text-foreground">
          <Truck aria-hidden className="size-3.5 text-primary shrink-0" />
          <span>مؤشر عهدة المندوب الميدانية:</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-muted-foreground font-medium">الطرود المفتوحة:</span>
          <span className="font-mono font-bold">{openCount} طرد</span>
          <span className="text-muted-foreground font-medium">· إجمالي COD المفتوح:</span>
          <span className="font-mono font-bold">{fmt(totalExposureAmount)} د.ع</span>
          {cashInHandAmount > 0 && (
            <span className="text-[11px] text-muted-foreground font-mono">
              (نقد بيده: {fmt(cashInHandAmount)} · بالطريق: {fmt(streetAmount)})
            </span>
          )}
        </div>
      </div>

      {isOverLimit && (
        <div className="flex items-center gap-1.5 text-[11px] font-bold text-destructive rounded-lg bg-destructive/10 px-2 py-1">
          <ShieldAlert aria-hidden className="size-3.5 shrink-0" />
          <span>
            تنبيه تجاوز السقف: إجمالي العهدة المفتوحة تجاوزت سقف المندوب المحدد ({fmt(floatLimit)} د.ع).
          </span>
        </div>
      )}

      {isNearLimit && (
        <div className="flex items-center gap-1.5 text-[11px] font-bold text-[var(--sem-warn)] rounded-lg bg-[var(--sem-warn-bg)]/30 px-2 py-1">
          <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
          <span>
            تنبيه: اقتراب من سقف العهدة المحدد ({fmt(floatLimit)} د.ع).
          </span>
        </div>
      )}
    </div>
  );
}
