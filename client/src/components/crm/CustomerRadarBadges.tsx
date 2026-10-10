/**
 * رادار الكاشير والعملاء — شارات فورية مميزة (Customer Radar Badges)
 * يُظهر الشارات التشغيلية للزبائن في الكاشير والاستقبال وملف الزبون 360°.
 *
 * صفر إيموجي — يعتمد أيقونات lucide-react حصراً (حارس check:emoji).
 */

import {
  Crown,
  AlertTriangle,
  AlertCircle,
  History,
  Star,
  Award,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";

export interface CustomerRadarBadgesProps {
  customerId?: number | null;
  badges?: {
    isVip?: boolean;
    frequentCustomer?: boolean;
    isNearCreditLimit?: boolean;
    isOverCreditLimit?: boolean;
    hasOpenComplaint?: boolean;
    hasPreviousComplaint?: boolean;
    eligibleForGoogleReview?: boolean;
  } | null;
  className?: string;
  size?: "sm" | "default";
  onClick?: () => void;
}

export function CustomerRadarBadges({
  customerId,
  badges: badgesProp,
  className = "flex flex-wrap items-center gap-1.5",
  size = "default",
  onClick,
}: CustomerRadarBadgesProps) {
  const dossierQuery = trpc.customers.dossier360.useQuery(
    { customerId: customerId! },
    {
      enabled: !badgesProp && customerId != null && customerId > 0,
      staleTime: 60_000,
    },
  );

  const badges = badgesProp ?? dossierQuery.data?.metrics?.badges;
  if (!badges) return null;

  const iconSize = size === "sm" ? "size-3" : "size-3.5";
  const badgeCls =
    size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-0.5 text-xs";
  const interactiveCls = onClick
    ? "cursor-pointer hover:opacity-85 transition-opacity"
    : "";

  return (
    <div
      className={`${className} ${interactiveCls}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === "Enter" && onClick() : undefined}
    >
      {badges.isVip && (
        <Badge
          variant="secondary"
          className={`${badgeCls} bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-600/40 font-semibold gap-1 inline-flex items-center`}
        >
          <Crown
            aria-hidden
            className={`${iconSize} text-amber-600 dark:text-amber-400 shrink-0`}
          />
          <span>زبون VIP مميز</span>
        </Badge>
      )}

      {badges.isOverCreditLimit && (
        <Badge
          variant="destructive"
          className={`${badgeCls} gap-1 inline-flex items-center font-medium`}
        >
          <AlertTriangle aria-hidden className={`${iconSize} shrink-0`} />
          <span>تجاوز سقف الدين</span>
        </Badge>
      )}

      {!badges.isOverCreditLimit && badges.isNearCreditLimit && (
        <Badge
          variant="secondary"
          className={`${badgeCls} bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-300 dark:border-orange-600/40 gap-1 inline-flex items-center`}
        >
          <AlertCircle aria-hidden className={`${iconSize} shrink-0`} />
          <span>قارب سقف الائتمان</span>
        </Badge>
      )}

      {badges.hasOpenComplaint && (
        <Badge
          variant="destructive"
          className={`${badgeCls} bg-rose-600 text-white gap-1 inline-flex items-center font-medium animate-pulse`}
        >
          <AlertCircle aria-hidden className={`${iconSize} shrink-0`} />
          <span>شكوى جودة مفتوحة</span>
        </Badge>
      )}

      {!badges.hasOpenComplaint && badges.hasPreviousComplaint && (
        <Badge
          variant="outline"
          className={`${badgeCls} text-muted-foreground border-amber-400/50 bg-amber-50/40 dark:bg-amber-950/20 gap-1 inline-flex items-center`}
        >
          <History
            aria-hidden
            className={`${iconSize} text-amber-600 shrink-0`}
          />
          <span>عتب سابق مسجل</span>
        </Badge>
      )}

      {badges.eligibleForGoogleReview && (
        <Badge
          variant="secondary"
          className={`${badgeCls} bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-600/40 gap-1 inline-flex items-center`}
        >
          <Star
            aria-hidden
            className={`${iconSize} text-emerald-600 fill-emerald-500 shrink-0`}
          />
          <span>مرشح لتقييم خرائط Google</span>
        </Badge>
      )}

      {!badges.isVip && badges.frequentCustomer && (
        <Badge
          variant="outline"
          className={`${badgeCls} text-blue-700 dark:text-blue-400 border-blue-300 dark:border-blue-600/40 bg-blue-50/30 gap-1 inline-flex items-center`}
        >
          <Award aria-hidden className={`${iconSize} text-blue-600 shrink-0`} />
          <span>زبون متكرر</span>
        </Badge>
      )}
    </div>
  );
}
