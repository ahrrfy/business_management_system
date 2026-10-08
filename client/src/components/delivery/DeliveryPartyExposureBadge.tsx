/**
 * DeliveryPartyExposureBadge - شارة الذكاء التشغيلي لعُهدة المندوب والتحذير من سقف الائتمان
 */
import React from "react";
import { AlertTriangle, ShieldAlert, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fmt } from "@/lib/money";
import type { RouterOutputs } from "@/lib/trpc";

export type DeliveryPartySummary = RouterOutputs["delivery"]["listParties"][number];

interface Props {
  party: DeliveryPartySummary | null | undefined;
  compact?: boolean;
}

export function DeliveryPartyExposureBadge({ party, compact = false }: Props) {
  if (!party) return null;

  const openCount = party.openConsignments ?? 0;
  const inTransitAmount = Number(party.parcelsInTransitAmount ?? "0");
  const floatLimit = party.floatLimit ? Number(party.floatLimit) : null;
  const isOverLimit = floatLimit !== null && floatLimit > 0 && inTransitAmount > floatLimit;
  const isNearLimit =
    floatLimit !== null && floatLimit > 0 && !isOverLimit && inTransitAmount >= floatLimit * 0.8;

  if (compact) {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">العهدة:</span>
        <span className="font-bold text-foreground font-mono">{openCount} طرد</span>
        <span className="text-muted-foreground">·</span>
        <span className="font-bold text-foreground font-mono">{fmt(inTransitAmount)} د.ع</span>
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
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground font-medium">الطرود المفتوحة:</span>
          <span className="font-mono font-bold">{openCount} طرد</span>
          <span className="text-muted-foreground font-medium">· المبالغ:</span>
          <span className="font-mono font-bold">{fmt(inTransitAmount)} د.ع</span>
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
