import { AlertTriangle } from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  STOCK_USAGE_LABELS,
  isMaterialEligibleStockUsage,
  isSellableStockUsage,
  type StockUsage,
} from "@shared/stockUsage";
import { useCatalogPeopleOperationAccess } from "@/lib/catalogPeopleOperationAccess";
import { trpc } from "@/lib/trpc";

export function ProductOpenCommitmentsNotice({
  productId,
  savedStockUsage,
  nextStockUsage,
}: {
  productId?: number;
  savedStockUsage?: StockUsage | null;
  nextStockUsage: StockUsage;
}) {
  const { can } = useCatalogPeopleOperationAccess();
  const effectiveSaved = savedStockUsage ?? "SALE_ONLY";
  const usageChanged =
    productId != null &&
    productId > 0 &&
    savedStockUsage !== undefined &&
    effectiveSaved !== nextStockUsage;

  const commitmentsQ = trpc.catalog.openCommitments.useQuery(
    { productId: productId ?? 0 },
    {
      enabled: Boolean(usageChanged && can("catalog.openCommitments")),
      staleTime: 15_000,
    },
  );

  if (!usageChanged) return null;
  if (commitmentsQ.isLoading) {
    return (
      <div className="mt-1.5 rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground">
        {ACTION_LABELS.verifying}
      </div>
    );
  }
  const summary = commitmentsQ.data;
  if (!summary || summary.total <= 0) return null;

  const nextSellable = isSellableStockUsage(nextStockUsage);
  const nextMaterial = isMaterialEligibleStockUsage(nextStockUsage);
  const affected = summary.categories.filter(
    (c) =>
      c.count > 0 &&
      ((!nextSellable && c.affectedWhenNotSellable) ||
        (!nextMaterial && c.affectedWhenNotMaterial)),
  );
  if (affected.length === 0) return null;

  return (
    <div
      role="status"
      data-testid="product-open-commitments-warning"
      className="mt-1.5 space-y-1 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2.5 py-2 text-xs text-[var(--sem-warn)]"
    >
      <div className="flex items-center gap-1.5 font-semibold">
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
        <span>
          تغيير الاستخدام إلى «{STOCK_USAGE_LABELS[nextStockUsage]}» يؤثّر في التزامات مفتوحة قائمة:
        </span>
      </div>
      <ul className="list-inside list-disc space-y-0.5 ps-1 text-foreground">
        {affected.map((item) => (
          <li key={item.key}>
            {item.label}:{" "}
            <span className="font-semibold tabular-nums">
              {item.count.toLocaleString("ar-IQ-u-nu-latn")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
