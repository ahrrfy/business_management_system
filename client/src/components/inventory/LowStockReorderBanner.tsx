import { Button } from "@/components/ui/button";
import { AlertTriangle, ShoppingCart } from "lucide-react";
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

  const handleCreateReorderPO = () => {
    if (lowVariantIds.length === 0) return;
    try {
      const key = `po_reorder_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      sessionStorage.setItem(key, JSON.stringify(lowVariantIds));
      navigate(`/purchases/new?prefillKey=${encodeURIComponent(key)}&autoReason=low_stock`);
    } catch {
      // fallback
      navigate(`/purchases/new?items=${lowVariantIds.slice(0, 50).join(",")}`);
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
            تنبيه نواقص المخزون: يوجد {totalProblematic} صنف يحتاج لإعادة طلب
          </p>
          <p className="text-xs text-muted-foreground">
            {outOfStockCount > 0 ? `${outOfStockCount} نفد رصيدها تماماً · ` : ""}
            {lowCount > 0 ? `${lowCount} صنف تحت حد الأمان الأدنى` : ""}
          </p>
        </div>
      </div>

      {canManagePurchases && (
        <Button
          size="sm"
          className="gap-1.5 font-medium bg-[var(--sem-warn)] hover:bg-[var(--sem-warn)]/90 text-background"
          onClick={handleCreateReorderPO}
        >
          <ShoppingCart className="h-4 w-4" />
          إنشاء أمر شراء بالنواقص فوراً ({totalProblematic})
        </Button>
      )}
    </div>
  );
}
