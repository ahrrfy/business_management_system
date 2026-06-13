import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useMemo, useState } from "react";

export type PurchaseRow = RouterOutputs["catalog"]["forPurchase"][number];

/**
 * بيكر بحث منتجات مشترك (يستعمل catalog.forPurchase ⇒ يحمل **التكلفة** والمخزون والوحدات).
 * عند الاختيار يعيد المتغيّر المُختار + كل وحداته (لاختيار وحدة السطر لاحقاً). manager-gated خادمياً.
 */
export function ProductSearchPicker({
  branchId,
  label,
  placeholder,
  onPick,
}: {
  branchId: number;
  label?: string;
  placeholder?: string;
  onPick: (variant: PurchaseRow, units: PurchaseRow[]) => void;
}) {
  const [q, setQ] = useState("");
  const res = trpc.catalog.forPurchase.useQuery(
    { branchId, query: q, limit: 16 },
    { enabled: q.trim().length > 0 }
  );

  // صفّ واحد لكل متغيّر (نُفضّل وحدة الأساس للعرض).
  const variants = useMemo(() => {
    const byVariant = new Map<number, PurchaseRow>();
    for (const r of res.data ?? []) {
      const cur = byVariant.get(r.variantId);
      if (!cur || (r.isBaseUnit && !cur.isBaseUnit)) byVariant.set(r.variantId, r);
    }
    return Array.from(byVariant.values());
  }, [res.data]);

  function unitsFor(variantId: number): PurchaseRow[] {
    const all = (res.data ?? []).filter((r) => r.variantId === variantId);
    return all.length ? all : [];
  }

  return (
    <div className="space-y-1">
      {label && <Label>{label}</Label>}
      <div className="relative">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder ?? "ابحث بالاسم/SKU/الباركود…"} />
        {q.trim() && (variants.length > 0 || res.isFetching) && (
          <div className="absolute z-20 mt-1 w-full bg-popover border rounded-md shadow max-h-60 overflow-auto">
            {res.isFetching && <div className="p-2 text-xs text-muted-foreground text-center">جارٍ البحث…</div>}
            {variants.map((v) => {
              const detail = [v.variantName, v.color, v.size].filter(Boolean).join(" / ");
              return (
                <button
                  key={v.variantId}
                  type="button"
                  className="block w-full text-right px-3 py-2 text-sm hover:bg-accent"
                  onClick={() => {
                    onPick(v, unitsFor(v.variantId));
                    setQ("");
                  }}
                >
                  <div className="font-medium">{detail ? `${v.productName} — ${detail}` : v.productName}</div>
                  <div className="text-xs text-muted-foreground font-mono flex justify-between" dir="ltr">
                    <span>{v.sku}</span>
                    <span>متاح {Number(v.stockBase).toLocaleString("en-US")}</span>
                  </div>
                </button>
              );
            })}
            {!res.isFetching && variants.length === 0 && (
              <div className="p-2 text-xs text-muted-foreground text-center">لا نتائج.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
