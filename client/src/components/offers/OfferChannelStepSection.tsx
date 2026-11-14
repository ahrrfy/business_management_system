/**
 * client/src/components/offers/OfferChannelStepSection.tsx
 *
 * Comprehensive, unmistakable Channel, Branch & Delivery Perks selector for Step 4:
 * - Visual 3-card channel selector (ALL / POS_ONLY / STORE_ONLY)
 * - Live 6-surface ERP coverage matrix showing exact screens & apps where the offer applies
 * - Branch scope selector (all branches vs specific branch, RBAC-aware)
 * - Optional shipping/delivery perk (free shipping or fixed delivery discount)
 */

import React from "react";
import {
  Building2,
  CheckCircle2,
  Globe,
  Layers,
  MonitorSmartphone,
  Store,
  Truck,
  XCircle,
} from "lucide-react";
import { Field } from "@/components/product/variantBits";
import { AppSelect } from "@/components/ui/AppSelect";
import type { PromoChannel } from "./offersTypes";

export type ShippingPerkMode = "NONE" | "FREE";

export interface OfferChannelStepSectionProps {
  channel: PromoChannel;
  onChannelChange: (next: PromoChannel) => void;
  branchId: string;
  onBranchIdChange: (next: string) => void;
  branches: ReadonlyArray<{ id: number; name: string; code?: string | null }>;
  isAdmin: boolean;
  userBranchId?: number | null;
  shippingPerkMode: ShippingPerkMode;
  onShippingPerkModeChange: (next: ShippingPerkMode) => void;
  hasFreeShippingRule?: boolean;
}

const CHANNEL_CARDS: ReadonlyArray<{
  value: "ALL" | "POS_ONLY" | "STORE_ONLY";
  title: string;
  subtitle: string;
  badgeText: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    value: "ALL",
    title: "كل القنوات (المحل + الأونلاين)",
    subtitle:
      "يشتغل العرض بكاشير المحل والأوفلاين والاستقبال والفواتير، ويظهر بنفس الوقت بموقع وتطبيق المتجر الإلكتروني.",
    badgeText: "شامل للمحل والأونلاين",
    Icon: Layers,
  },
  {
    value: "POS_ONLY",
    title: "مبيعات المحل والفروع فقط",
    subtitle:
      "يشتغل داخل المحل فقط (الكاشير، الأوفلاين، الاستقبال، الفواتير، وقارئ الأسعار) ولا يظهر بالمتجر الإلكتروني.",
    badgeText: "داخل المحل فقط",
    Icon: Store,
  },
  {
    value: "STORE_ONLY",
    title: "المتجر الإلكتروني وتطبيق الموبايل فقط",
    subtitle:
      "عرض خاص لطلبات الأونلاين عبر موقع المتجر وتطبيق الموبايل (Android / iOS) بدون تطبيقه بكاشير المحل.",
    badgeText: "أونلاين فقط",
    Icon: Globe,
  },
];

const ERP_SURFACES: ReadonlyArray<{
  key: string;
  title: string;
  activeWhen: (ch: "ALL" | "POS_ONLY" | "STORE_ONLY") => boolean;
}> = [
  {
    key: "pos",
    title: "نقطة البيع (الكاشير POS)",
    activeWhen: (ch) => ch === "ALL" || ch === "POS_ONLY",
  },
  {
    key: "offline",
    title: "البيع دون اتصال (أوفلاين الطوارئ)",
    activeWhen: (ch) => ch === "ALL" || ch === "POS_ONLY",
  },
  {
    key: "reception_invoice",
    title: "شاشة الاستقبال والفاتورة المتقدمة",
    activeWhen: (ch) => ch === "ALL" || ch === "POS_ONLY",
  },
  {
    key: "kiosk_labels",
    title: "قارئ الأسعار وملصقات الرفوف والباركود",
    activeWhen: (ch) => ch === "ALL" || ch === "POS_ONLY",
  },
  {
    key: "web_store",
    title: "موقع المتجر الإلكتروني (الويب)",
    activeWhen: (ch) => ch === "ALL" || ch === "STORE_ONLY",
  },
  {
    key: "mobile_app",
    title: "تطبيق المتجر للهاتف (Android / iOS)",
    activeWhen: (ch) => ch === "ALL" || ch === "STORE_ONLY",
  },
];

export function OfferChannelStepSection({
  channel,
  onChannelChange,
  branchId,
  onBranchIdChange,
  branches,
  isAdmin,
  userBranchId,
  shippingPerkMode,
  onShippingPerkModeChange,
  hasFreeShippingRule = false,
}: OfferChannelStepSectionProps) {
  const effectiveShippingMode: ShippingPerkMode = hasFreeShippingRule
    ? "FREE"
    : shippingPerkMode;
  const normalizedChannel: "ALL" | "POS_ONLY" | "STORE_ONLY" =
    channel === "POS_ONLY" || channel === "POS"
      ? "POS_ONLY"
      : channel === "STORE_ONLY" || channel === "STORE"
      ? "STORE_ONLY"
      : "ALL";

  const assignedBranchName =
    branches.find((b) => Number(b.id) === Number(userBranchId))?.name ??
    (userBranchId ? `فرع #${userBranchId}` : "فرعك المسند");

  return (
    <div className="rounded-lg border border-border bg-muted/15 p-3.5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MonitorSmartphone className="size-4 text-primary" />
          <span className="text-xs font-bold text-foreground">
            نطاق قنوات البيع والتواجد والفروع
          </span>
        </div>
      </div>

      {/* 3 Visual Channel Cards */}
      <div
        role="radiogroup"
        aria-label="بطاقات اختيار قناة العرض"
        className="grid grid-cols-1 sm:grid-cols-3 gap-2.5"
      >
        {CHANNEL_CARDS.map(({ value, title, subtitle, badgeText, Icon }) => {
          const selected = normalizedChannel === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChannelChange(value)}
              className={`flex flex-col justify-between gap-2 rounded-lg border p-3 text-right transition-colors cursor-pointer ${
                selected
                  ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                  : "border-border bg-card hover:bg-muted/40"
              }`}
            >
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-foreground">{title}</span>
                  <span
                    className={`flex size-7 shrink-0 items-center justify-center rounded-md ${
                      selected
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    <Icon className="size-3.5" />
                  </span>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">{subtitle}</p>
              </div>
              <span className="text-[10px] font-semibold text-[var(--sem-info)]">{badgeText}</span>
            </button>
          );
        })}
      </div>

      {/* Live 6-Surface Coverage Map */}
      <div className="rounded-md border border-border/80 bg-background p-2.5 space-y-2">
        <div className="text-[11px] font-semibold text-muted-foreground">
          أماكن عمل العرض تلقائياً حسب اختيارك:
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
          {ERP_SURFACES.map((surf) => {
            const active = surf.activeWhen(normalizedChannel);
            return (
              <div
                key={surf.key}
                className={`flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] ${
                  active
                    ? "border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] font-medium"
                    : "border-border bg-muted/30 text-muted-foreground line-through opacity-70"
                }`}
              >
                {active ? (
                  <CheckCircle2 className="size-3.5 shrink-0" />
                ) : (
                  <XCircle className="size-3.5 shrink-0" />
                )}
                <span>{surf.title}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Branch Scope + Delivery Perks */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-1">
        <Field
          label="الفرع المستهدف"
          hint={isAdmin ? "تخصيص العرض لفرع معين أو تفعيله بكل الفروع" : "مرتبط بفرعك الحالي"}
        >
          {isAdmin ? (
            <AppSelect
              value={branchId}
              onValueChange={onBranchIdChange}
              className="h-9 border-input px-3 py-1 text-sm"
            >
              <option value="">كل الفروع</option>
              {branches.map((b) => (
                <option key={b.id} value={String(b.id)}>
                  {b.name} {b.code ? `(${b.code})` : ""}
                </option>
              ))}
            </AppSelect>
          ) : (
            <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 text-xs font-medium text-foreground">
              <Building2 className="size-3.5 text-muted-foreground" />
              <span>{assignedBranchName}</span>
            </div>
          )}
        </Field>

        <Field
          label="ميزة التوصيل والشحن المصاحبة"
          hint={
            hasFreeShippingRule
              ? "مفعّل تلقائياً لأنك اخترت نوع «توصيل مجاني» ضمن العرض"
              : "لطلبات التوصيل والمتجر المشمولة بالعرض"
          }
        >
          <AppSelect
            value={effectiveShippingMode}
            onValueChange={(v) => onShippingPerkModeChange(v as ShippingPerkMode)}
            disabled={hasFreeShippingRule}
            className="h-9 border-input px-3 py-1 text-sm"
          >
            <option value="NONE">بدون خصم توصيل إضافي</option>
            <option value="FREE">توصيل مجاني على حساب المكتبة</option>
          </AppSelect>
        </Field>

        <div className="hidden lg:flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">
          <Truck className="size-4 shrink-0 text-primary/70" />
          <span>
            {effectiveShippingMode === "FREE"
              ? "تصير أجرة التوصيل مجاناً للزبون تلقائياً وتنطبع كميزة تسويقية بالفاتورة وملصق الطلب."
              : "تبقى أجرة التوصيل الاعتيادية كما هي."}
          </span>
        </div>
      </div>
    </div>
  );
}
