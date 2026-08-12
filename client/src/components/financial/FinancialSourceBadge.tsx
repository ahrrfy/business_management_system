import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Banknote,
  Boxes,
  Building2,
  CircleHelp,
  CreditCard,
  Landmark,
  ReceiptText,
  WalletCards,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type FinancialSourceKind =
  | "DRAWER"
  | "TREASURY"
  | "CASH"
  | "BANK"
  | "CARD"
  | "CHECK"
  | "TRANSFER"
  | "WALLET"
  | "EXCHANGE"
  | "STOCK"
  | "OTHER";

export interface FinancialSourceBadgeProps extends Omit<
  ComponentProps<"span">,
  "children"
> {
  source?: FinancialSourceKind | string | null;
  paymentMethod?: string | null;
  cashBucket?: string | null;
  label?: ReactNode;
  showMethod?: boolean;
  showBucket?: boolean;
  fallback?: ReactNode;
  compact?: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  DRAWER: "درج كاشير",
  TREASURY: "خزينة إدارية",
  CASH: "نقدي",
  BANK: "حساب بنكي",
  CARD: "بطاقة",
  CHECK: "صك",
  TRANSFER: "تحويل",
  WALLET: "محفظة",
  EXCHANGE: "صيرفة",
  STOCK: "مخزون",
  OTHER: "مصدر آخر",
};

const SOURCE_ICON: Record<string, LucideIcon> = {
  DRAWER: Banknote,
  TREASURY: Building2,
  CASH: Banknote,
  BANK: Landmark,
  CARD: CreditCard,
  CHECK: ReceiptText,
  TRANSFER: Landmark,
  WALLET: WalletCards,
  EXCHANGE: Landmark,
  STOCK: Boxes,
  OTHER: CircleHelp,
};

function normalized(value?: string | null) {
  return value?.trim().toUpperCase() || "";
}

function sourceTone(source: string) {
  if (source === "DRAWER" || source === "CASH") return "success" as const;
  if (source === "TREASURY" || source === "EXCHANGE") return "warning" as const;
  if (["BANK", "CARD", "CHECK", "TRANSFER", "WALLET"].includes(source))
    return "info" as const;
  return "neutral" as const;
}

/** يعرض طريقة الدفع ومكان المال معاً، مثل «نقدي · درج كاشير». */
export function FinancialSourceBadge({
  source,
  paymentMethod,
  cashBucket,
  label,
  showMethod = true,
  showBucket = true,
  fallback = "مصدر غير محدد",
  compact = false,
  className,
  ...props
}: FinancialSourceBadgeProps) {
  const normalizedSource = normalized(source);
  const method = normalized(paymentMethod);
  const bucket = normalized(cashBucket);
  const semanticSource = bucket || normalizedSource || method || "OTHER";
  const Icon = SOURCE_ICON[semanticSource] ?? SOURCE_ICON[method] ?? CircleHelp;

  const parts: ReactNode[] = [];
  if (showMethod && method) parts.push(SOURCE_LABEL[method] ?? paymentMethod);
  if (showBucket && bucket && bucket !== method)
    parts.push(SOURCE_LABEL[bucket] ?? cashBucket);
  if (!parts.length && normalizedSource)
    parts.push(SOURCE_LABEL[normalizedSource] ?? source);

  const content =
    label ??
    (parts.length
      ? parts.map((part, index) => (
          <span key={index} className="contents">
            {index > 0 ? (
              <span aria-hidden className="opacity-50">
                ·
              </span>
            ) : null}
            <span>{part}</span>
          </span>
        ))
      : fallback);

  return (
    <Badge
      variant={sourceTone(semanticSource)}
      className={cn(compact ? "h-5 px-1.5 text-[10px]" : "min-h-6", className)}
      {...props}
    >
      <Icon aria-hidden className="shrink-0" />
      {content}
    </Badge>
  );
}
