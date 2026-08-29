import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronLeft, type LucideIcon } from "lucide-react";
import React from "react";

export interface MobileDataCardMeta {
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
}

export interface MobileDataCardAction {
  label: string;
  icon?: LucideIcon;
  onClick: (e: React.MouseEvent) => void;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
  disabled?: boolean;
}

export interface MobileDataCardProps {
  id?: string | number;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  badge?: {
    label: string;
    variant?: "default" | "secondary" | "destructive" | "outline" | "success" | "warning";
    className?: string;
  };
  amount?: {
    value: string | number;
    label?: string;
    currency?: string;
    positive?: boolean;
    negative?: boolean;
  };
  metadata?: MobileDataCardMeta[];
  primaryAction?: MobileDataCardAction;
  secondaryActions?: MobileDataCardAction[];
  onClick?: () => void;
  /** Accessible name for the card-wide action. Defaults to the text title when possible. */
  ariaLabel?: string;
  className?: string;
  children?: React.ReactNode;
}

export function MobileDataCard({
  title,
  subtitle,
  badge,
  amount,
  metadata = [],
  primaryAction,
  secondaryActions = [],
  onClick,
  ariaLabel,
  className,
  children,
}: MobileDataCardProps) {
  const cardActionLabel = ariaLabel ??
    (typeof title === "string" || typeof title === "number"
      ? `فتح تفاصيل ${title}`
      : "فتح التفاصيل");

  return (
    <Card
      onClick={onClick}
      className={cn(
        "relative p-3.5 bg-card border border-border/70 rounded-2xl shadow-xs transition-all active:scale-[0.99] touch-manipulation",
        onClick && "isolate cursor-pointer hover:border-primary/40 hover:shadow-sm",
        className
      )}
    >
      {onClick && (
        <button
          type="button"
          aria-label={cardActionLabel}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
          className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      )}

      {/* رأس الكرت: العنوان + الشارة + المبلغ */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-base text-foreground truncate leading-snug">{title}</span>
            {badge && (
              <Badge
                variant={badge.variant === "success" || badge.variant === "warning" ? "outline" : (badge.variant || "secondary")}
                className={cn(
                  "text-[11px] px-2 py-0.5 font-medium rounded-md",
                  badge.variant === "success" && "border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
                  badge.variant === "warning" && "border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
                  badge.className
                )}
              >
                {badge.label}
              </Badge>
            )}
          </div>
          {subtitle && (
            <div className="text-xs text-muted-foreground mt-0.5 truncate">{subtitle}</div>
          )}
        </div>

        {/* المبلغ المالي البارز */}
        {amount && (
          <div className="text-end shrink-0">
            {amount.label && (
              <div className="text-[10px] text-muted-foreground font-medium leading-none mb-1">
                {amount.label}
              </div>
            )}
            <div
              className={cn(
                "font-bold text-base tracking-tight leading-tight",
                amount.positive && "text-[var(--sem-pos)]",
                amount.negative && "text-destructive",
                !amount.positive && !amount.negative && "text-foreground"
              )}
            >
              {typeof amount.value === "number" ? amount.value.toLocaleString("en-US") : amount.value}
              <span className="text-[11px] font-normal text-muted-foreground ms-1">
                {amount.currency ?? "د.ع"}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* البيانات الوصفية (Metadata Grid) */}
      {metadata.length > 0 && (
        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 mt-3 pt-2.5 border-t border-border/50 text-xs">
          {metadata.map((meta, index) => {
            const Icon = meta.icon;
            return (
              <div key={index} className="flex items-center gap-1.5 min-w-0 text-muted-foreground">
                {Icon && <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden />}
                <span className="text-[11px] opacity-75 shrink-0">{meta.label}:</span>
                <span className="font-medium text-foreground truncate">{meta.value}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* محتوى إضافي مخصص */}
      {children && <div className="mt-2.5">{children}</div>}

      {/* شريط الإجراءات السريعة (Actions) */}
      {(primaryAction || secondaryActions.length > 0 || onClick) && (
        <div className="relative z-10 flex items-center justify-between gap-2 mt-3 pt-2 border-t border-border/40">
          <div className="flex items-center gap-1.5 flex-wrap">
            {secondaryActions.map((action, idx) => {
              const ActionIcon = action.icon;
              return (
                <Button
                  key={idx}
                  type="button"
                  variant={action.variant ?? "outline"}
                  size="sm"
                  disabled={action.disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    action.onClick(e);
                  }}
                  className="h-8 px-2.5 text-xs font-medium rounded-lg"
                >
                  {ActionIcon && <ActionIcon className="size-3.5 me-1" aria-hidden />}
                  {action.label}
                </Button>
              );
            })}
          </div>

          <div className="flex items-center gap-1 ms-auto">
            {primaryAction && (
              <Button
                type="button"
                variant={primaryAction.variant ?? "default"}
                size="sm"
                disabled={primaryAction.disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  primaryAction.onClick(e);
                }}
                className="h-8 px-3 text-xs font-medium rounded-lg"
              >
                {primaryAction.icon && <primaryAction.icon className="size-3.5 me-1" aria-hidden />}
                {primaryAction.label}
              </Button>
            )}
            {onClick && !primaryAction && (
              <div className="flex items-center text-xs text-primary font-medium" aria-hidden="true">
                <span>التفاصيل</span>
                <ChevronLeft className="size-4 ms-0.5" aria-hidden />
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
