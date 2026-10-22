/**
 * عناصر عرض مشتركة لوحدة الأصول: أيقونة الفئة (lucide)، شارة الحالة، بطاقة مؤشّر، وتنسيق المبالغ.
 */
import { type ReactNode } from "react";
import { Banknote, Building2, Car, Fingerprint, Landmark, Laptop, Monitor, type LucideIcon, Package, Printer, Sofa } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { assetStatusLabel } from "@shared/assets";
import { fmtInt } from "@/lib/money";

export const ASSET_CATEGORY_ICON: Record<string, LucideIcon> = {
  computers: Laptop,
  display: Monitor,
  furniture: Sofa,
  vehicles: Car,
  printing: Printer,
  devices: Fingerprint,
  land: Landmark,
  buildings: Building2,
};

export function categoryIcon(category: string): LucideIcon {
  return ASSET_CATEGORY_ICON[category] ?? Package;
}

export function CategoryIcon({ category, className }: { category: string; className?: string }) {
  const Icon = categoryIcon(category);
  return <Icon className={cn("size-4 text-muted-foreground", className)} aria-hidden="true" />;
}

const STATUS_CLS: Record<string, string> = {
  active: "badge-status-active",
  maintenance: "badge-status-pending",
  retired: "bg-muted text-muted-foreground",
  disposed: "badge-stock-out",
};

export function AssetStatusBadge({ status }: { status: string }) {
  return (
    <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap", STATUS_CLS[status] ?? "bg-muted text-muted-foreground")}>
      {assetStatusLabel(status)}
    </span>
  );
}

/** بطاقة مؤشّر هادئة: أيقونة + عنوان فوق رقم بارز (الرقم هو البطل). */
export function StatCard({ label, value, icon: Icon, sub, tone }: { label: string; value: ReactNode; icon?: LucideIcon; sub?: ReactNode; tone?: "default" | "negative" | "positive" }) {
  const valueCls = tone === "negative" ? "text-money-negative" : tone === "positive" ? "text-money-positive" : "";
  return (
    <Card className="py-1.5 gap-0.5">
      <CardContent className="px-2.5 py-0">
        <div className="flex items-center gap-1.5 text-muted-foreground text-2xs font-semibold">
          {Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
          <span className="truncate">{label}</span>
        </div>
        <div className={cn("text-base font-extrabold tabular-nums leading-tight", valueCls)}>{value}</div>
        {sub && <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** مبلغ بالدينار العراقي للعرض (بلا كسور + فاصل آلاف). */
export const iqd = (v: string | number | null | undefined) => fmtInt(v);
export { Banknote };
