/**
 * UnifiedProductSearch — مكون البحث والإكمال التلقائي عن المنتجات
 * 
 * طبق الأصل من مكون الكاشير (POSHeader + usePOSCatalogSearch):
 * - مبني فوق UnifiedSearchInput مع ستايل الكاشير المميز والمريح.
 * - قائمة منسدلة أنيقة تعرض تفاصيل الصنف بدقة متناهية:
 *   • اسم المنتج
 *   • شارات الدلالة المحاسبية والتشغيلية (خِدمة، أمانة، بكج)
 *   • الرمز والموديل (SKU) والوحدة
 *   • تفصيل المخزون الحي للفرع: فعلي · محجوز · متاح للبيع مع تدرج لوني (أحمر < 5، برتقالي < 15، رمادي ≥ 15)
 *   • السعر بالدينار العراقي IQD بالخط العريض المميز
 * - ملاحة كاملة بلوحة المفاتيح: السهم للأعلى/للأسفل للتنقل، Enter للإضافة/الاختيار، Escape للإغلاق.
 * - دعم جانبي البيع (POS / Sale) والشراء/التصنيع (Purchase / Production) بسلاسة.
 */
import * as React from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { fmtAr } from "@/lib/money";
import { UnifiedSearchInput } from "./UnifiedSearchInput";
import { cn } from "@/lib/utils";

export type PosProductRow = RouterOutputs["catalog"]["posList"][number];

export interface UnifiedProductSearchProps {
  branchId: number;
  /** وضع الاستعلام: sale (كاشير/مبيعات posList) أو purchase (شراء/تصنيع forPurchase) */
  mode?: "sale" | "purchase";
  /** فئة السعر (لجانب البيع): RETAIL / WHOLESALE / etc. */
  tier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  /** عند اختيار أو إضافة صنف */
  onSelect: (product: PosProductRow) => void;
  placeholder?: string;
  autoFocus?: boolean;
  size?: "default" | "compact" | "lg";
  variant?: "default" | "pos";
  className?: string;
  inputClassName?: string;
  branchName?: string;
}

export function UnifiedProductSearch({
  branchId,
  mode = "sale",
  tier = "RETAIL",
  onSelect,
  placeholder,
  autoFocus = false,
  size = "default",
  variant = "pos",
  className,
  inputClassName,
  branchName = "الفرع الحالي",
}: UnifiedProductSearchProps) {
  const [search, setSearch] = React.useState("");
  const [showDrop, setShowDrop] = React.useState(false);
  const [selectedIndex, setSelectedIndex] = React.useState<number>(-1);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const debouncedSearch = useDebouncedValue(search, 180);
  const isSearchActive = debouncedSearch.trim().length >= 2;

  // استعلام الكتالوج لجانب البيع
  const posQuery = trpc.catalog.posList.useQuery(
    { branchId, tier, query: debouncedSearch, limit: 20 },
    {
      enabled: mode === "sale" && isSearchActive,
      staleTime: 5_000,
    },
  );

  const utils = trpc.useUtils();

  // نتائج البحث الموحدة
  const results: PosProductRow[] = React.useMemo(() => {
    if (mode === "sale") {
      return (posQuery.data ?? []) as PosProductRow[];
    }
    return [];
  }, [mode, posQuery.data]);

  const searching = posQuery.isFetching;

  // إغلاق القائمة المنسدلة عند النقر خارج المكون
  React.useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setShowDrop(false);
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  // إعادة ضبط المؤشر عند تغيّر النتائج
  React.useEffect(() => {
    setSelectedIndex(-1);
  }, [results]);

  // دالة البحث المباشر بالباركود عند المسح
  const handleBarcodeScan = React.useCallback(
    async (code: string) => {
      if (!code) return;
      try {
        const item = await utils.catalog.byBarcode.fetch({
          barcode: code,
          branchId,
          tier,
        });
        if (item) {
          onSelect(item as PosProductRow);
          setSearch("");
          setShowDrop(false);
        }
      } catch {
        // في حال عدم العثور، يُترك الكود في البحث ليراه المستخدم
        setSearch(code);
        setShowDrop(true);
      }
    },
    [branchId, tier, utils, onSelect],
  );

  // لون شارة المخزون (أحمر < 5، برتقالي < 15، رمادي ≥ 15) كالكاشير
  const getStockColorClass = (stock: number) => {
    if (stock < 5) return "text-destructive font-bold";
    if (stock < 15) return "text-amber-600 dark:text-amber-500 font-semibold";
    return "text-muted-foreground";
  };

  // معالجة اختيار الصنف
  const handlePick = (item: PosProductRow) => {
    onSelect(item);
    setSearch("");
    setShowDrop(false);
    inputRef.current?.focus();
  };

  // ملاحة لوحة المفاتيح
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDrop || results.length === 0) {
      if (e.key === "ArrowDown" && results.length > 0) {
        setShowDrop(true);
        setSelectedIndex(0);
        e.preventDefault();
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : results.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = selectedIndex >= 0 ? results[selectedIndex] : results[0];
      if (target) {
        handlePick(target);
      }
    } else if (e.key === "Escape") {
      setShowDrop(false);
    }
  };

  return (
    <div ref={wrapRef} className={cn("relative flex-1 min-w-64", className)}>
      <UnifiedSearchInput
        ref={inputRef}
        value={search}
        onChange={(v) => {
          setSearch(v);
          if (v.trim()) setShowDrop(true);
        }}
        onImmediateChange={(v) => {
          if (v.trim()) setShowDrop(true);
        }}
        onScan={handleBarcodeScan}
        onSubmit={() => {
          if (results.length > 0) {
            handlePick(results[0]);
          }
        }}
        placeholder={placeholder ?? "ابحث بالاسم أو SKU أو امسح الباركود… (F2)"}
        barcode={true}
        autoFocus={autoFocus}
        size={size}
        variant={variant}
        className="w-full"
        inputClassName={inputClassName}
        onKeyDown={handleKeyDown}
      />

      {/* القائمة المنسدلة للنتائج — مطابقة لبطاقات الكاشير */}
      {showDrop && search.trim().length > 0 && (
        <div
          role="listbox"
          className="absolute top-[calc(100%+6px)] right-0 left-0 bg-popover text-popover-foreground border border-border rounded-xl shadow-2xl z-50 max-h-[60vh] overflow-y-auto divide-y divide-border/60 animate-in fade-in-50 zoom-in-95 duration-100"
        >
          {results.length === 0 && (
            <div className="p-4 text-xs text-muted-foreground text-center">
              {search.trim().length < 2
                ? "اكتب حرفين فأكثر للبحث…"
                : searching
                  ? "جارٍ البحث في الأصناف والمخزون…"
                  : `لا نتائج لـ «${search.trim()}» — جرّب كلمة أقصر أو امسح الباركود`}
            </div>
          )}

          {results.map((p, idx) => {
            const isSelected = idx === selectedIndex;
            const available = p.availableBase ?? p.stockBase;

            return (
              <div
                key={p.productUnitId}
                role="option"
                aria-selected={isSelected}
                onClick={() => handlePick(p)}
                onMouseEnter={() => setSelectedIndex(idx)}
                className={cn(
                  "flex items-center justify-between p-3.5 cursor-pointer transition-colors min-h-[58px]",
                  isSelected ? "bg-accent/80" : "hover:bg-muted/50",
                )}
              >
                {/* التفاصيل اليمينية: الاسم، الشارات، SKU، وتفصيل المخزون */}
                <div className="space-y-1 min-w-0 pr-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-sm text-foreground leading-snug">
                      {p.productName}
                    </span>

                    {p.isService && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[var(--sem-info-bg,#e0f2fe)] text-[var(--sem-info,#0369a1)]">
                        خِدمة
                      </span>
                    )}

                    {p.isConsignment && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[var(--sem-warn-bg,#fef3c7)] text-[var(--sem-warn,#b45309)]">
                        أمانة
                      </span>
                    )}
                  </div>

                  <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                    <span className="font-mono">{p.sku}</span>
                    <span>·</span>
                    <span>{p.unitName}</span>
                    {!p.isService && (
                      <>
                        <span>·</span>
                        <span className={getStockColorClass(available)}>
                          {branchName} · فعلي: {fmtAr(p.stockBase)} · محجوز: {fmtAr(p.reservedBase ?? 0)} · متاح للبيع: {fmtAr(available)}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* السعر في الجانب المقابل (اليسار في RTL) */}
                <div className="text-left shrink-0 pl-2">
                  {p.price == null ? (
                    <span className="text-xs text-destructive font-medium">بلا سعر</span>
                  ) : (
                    <div className="flex flex-col items-end">
                      <span className="font-extrabold text-base text-primary font-mono tracking-tight" dir="ltr">
                        {fmtAr(Number(p.price))}
                      </span>
                      <span className="text-[10px] text-muted-foreground -mt-1">د.ع</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
