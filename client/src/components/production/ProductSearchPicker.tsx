import { Label } from "@/components/ui/label";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useMemo, useState, useRef, useEffect } from "react";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { cn } from "@/lib/utils";

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
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

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

  // إغلاق القائمة عند النقر خارج المكون
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectVariant = (v: PurchaseRow) => {
    onPick(v, unitsFor(v.variantId));
    setQ("");
    setIsOpen(false);
    setSelectedIndex(-1);
  };

  // التنقل بلوحة المفاتيح
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || variants.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < variants.length - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : variants.length - 1));
    } else if (e.key === "Enter") {
      if (selectedIndex >= 0 && selectedIndex < variants.length) {
        e.preventDefault();
        selectVariant(variants[selectedIndex]);
      }
    } else if (e.key === "Escape") {
      setIsOpen(false);
    }
  };

  return (
    <div className="space-y-1" ref={containerRef} onKeyDown={handleKeyDown}>
      {label && <Label>{label}</Label>}
      <div className="relative">
        <UnifiedSearchInput
          value={q}
          onChange={(newVal) => {
            setQ(newVal);
            setIsOpen(Boolean(newVal.trim()));
            setSelectedIndex(-1);
          }}
          placeholder={placeholder ?? "ابحث بالاسم/SKU/الباركود…"}
          debounceMs={180}
          barcode={true}
          onSubmit={() => {
            if (variants.length > 0) {
              const target = selectedIndex >= 0 ? variants[selectedIndex] : variants[0];
              selectVariant(target);
            }
          }}
        />
        {isOpen && q.trim() && (variants.length > 0 || res.isFetching) && (
          <div className="absolute z-30 mt-1.5 w-full bg-popover/95 backdrop-blur-sm border rounded-xl shadow-xl max-h-72 overflow-auto divide-y divide-border/40">
            {res.isFetching && (
              <div className="p-3 text-xs text-muted-foreground text-center animate-pulse">
                جارٍ البحث في الأصناف والمخزون…
              </div>
            )}
            {variants.map((v, idx) => {
              const detail = [v.variantName, v.color, v.size].filter(Boolean).join(" / ");
              const isSelected = idx === selectedIndex;
              const stockNum = Number(v.stockBase);
              return (
                <button
                  key={v.variantId}
                  type="button"
                  className={cn(
                    "block w-full text-right px-3.5 py-2.5 text-sm transition-colors cursor-pointer",
                    isSelected ? "bg-primary/10 text-primary font-medium" : "hover:bg-accent/60"
                  )}
                  onClick={() => selectVariant(v)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">
                      {detail ? `${v.productName} — ${detail}` : v.productName}
                    </span>
                    <span
                      className={cn(
                        "text-xs px-2 py-0.5 rounded-full font-bold",
                        stockNum <= 0
                          ? "bg-destructive/10 text-destructive"
                          : stockNum < 5
                          ? "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
                          : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                      )}
                    >
                      {stockNum <= 0 ? "نفد المخزون" : `متاح ${stockNum.toLocaleString("en-US")} ${v.unitName || "وحدة"}`}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground font-mono flex items-center justify-between mt-1" dir="ltr">
                    <span className="bg-muted px-1.5 py-0.5 rounded text-[11px]">{v.sku}</span>
                    {v.costPriceBase && (
                      <span className="text-[11px] font-sans font-semibold text-foreground/80">
                        تكلفة: {Number(v.costPriceBase).toLocaleString("en-US")} د.ع
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
            {!res.isFetching && variants.length === 0 && (
              <div className="p-3 text-xs text-muted-foreground text-center">
                لا توجد منتجات مطابقة لـ «{q.trim()}»
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
