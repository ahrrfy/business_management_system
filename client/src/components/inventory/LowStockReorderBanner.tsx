import { Button } from "@/components/ui/button";
import { AlertTriangle, ClipboardList, ShoppingCart } from "lucide-react";
import { useLocation } from "wouter";

interface LowStockReorderBannerProps {
  lowCount: number;
  outOfStockCount: number;
  lowVariantIds: number[];
  canManagePurchases: boolean;
}

export function LowStockReorderBanner({
  lowCount,
  outOfStockCount,
  lowVariantIds,
  canManagePurchases,
}: LowStockReorderBannerProps) {
  const [, navigate] = useLocation();

  if (lowCount === 0 && outOfStockCount === 0) return null;

  const totalProblematic = lowCount + outOfStockCount;

  const handleCreateReorder = (unassigned: boolean) => {
    if (lowVariantIds.length === 0) return;
    const modeParam = unassigned ? "&mode=unassigned_sourcing" : "";
    try {
      const key = `po_reorder_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      sessionStorage.setItem(key, JSON.stringify(lowVariantIds));
      navigate(`/purchases/new?prefillKey=${encodeURIComponent(key)}&autoReason=low_stock${modeParam}`);
    } catch {
      // fallback
      navigate(`/purchases/new?items=${lowVariantIds.slice(0, 50).join(",")}${modeParam}`);
    }
  };

  return (
    <div className="rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/20 p-3.5 flex flex-wrap items-center justify-between gap-3 text-sm animate-in fade-in">
      <div className="flex items-center gap-2.5">
        <div className="rounded-full bg-[var(--sem-warn)]/10 p-2 text-[var(--sem-warn)]">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div>
          <p className="font-semibold text-foreground">
            تنبيه نواقص المخزون: يوجد {totalProblematic} صنف يحتاج لإعادة طلب وتأمين
          </p>
          <p className="text-xs text-muted-foreground">
            {outOfStockCount > 0 ? `${outOfStockCount} نفد رصيدها تماماً · ` : ""}
            {lowCount > 0 ? `${lowCount} صنف تحت حد الأمان الأدنى · ` : ""}
            نظام التوريد المرن للسوق العراقي (بحث وتفاوض بدون مورد أو شراء مباشر)
          </p>
        </div>
      </div>

      {canManagePurchases && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="gap-1.5 font-medium bg-[var(--sem-warn)] hover:bg-[var(--sem-warn)]/90 text-background"
            onClick={() => handleCreateReorder(true)}
          >
            <ClipboardList className="h-4 w-4" />
            طلب تأمين النواقص (إسناد للمدير للتفاوض في السوق) ({totalProblematic})
          </Button>

          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 font-medium border-[var(--sem-warn)]/50 hover:bg-[var(--sem-warn-bg)]/50"
            onClick={() => handleCreateReorder(false)}
          >
            <ShoppingCart className="h-4 w-4" />
            أمر شراء مباشر (مورد محدد)
          </Button>
        </div>
      )}
    </div>
  );
}
