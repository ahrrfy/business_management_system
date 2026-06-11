/**
 * ProductSearchBar — type-ahead product search + barcode resolver.
 *
 * - Live search via `trpc.catalog.posList` (for sale-side) or `catalog.forPurchase` (for purchase-side).
 * - Keyboard: ↑/↓ to navigate, Enter to add, Escape to close. Exact barcode match on Enter.
 * - When a scanner pastes a full barcode followed by Enter, we resolve via `catalog.byBarcode`
 *   (sale-side only). On purchase side, we fall back to substring match.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fmtNum } from "./totals";
import type { InvoiceLine, InvoiceType, PriceTier } from "./types";

export interface ProductSearchBarProps {
  invoiceType: InvoiceType;
  branchId: number;
  tier: PriceTier;
  onAddProduct: (line: InvoiceLine) => void;
  /** Optional callback for "not found" / errors. */
  onNotify?: (msg: string, kind: "error" | "info") => void;
}

interface NormalizedRow {
  productId: number;
  variantId: number;
  productUnitId: number;
  name: string;
  sku: string;
  barcode: string | null;
  unitName: string;
  conversionFactor: string;
  stockBase: number;
  /** Sale price (sale side) OR cost (purchase side) — already in the unit, decimal string. */
  price: string;
  /** Cost in base unit (purchase side carries this; sale side gets it null when hidden). */
  costBase: string;
  category?: string | null;
}

function stockBadgeColor(stock: number): string {
  if (stock < 5) return "text-rose-600";
  if (stock < 15) return "text-amber-600";
  return "text-muted-foreground";
}

export function ProductSearchBar({ invoiceType, branchId, tier, onAddProduct, onNotify }: ProductSearchBarProps) {
  const isPurchase = invoiceType === "PURCHASE" || invoiceType === "PURCHASE_RETURN";

  const [query, setQuery] = useState("");
  const [showDrop, setShowDrop] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // بحث ذكي: تأجيل ١٨٠ms (طلب واحد بعد استقرار الكتابة لا مع كل حرف) + إبقاء النتائج
  // السابقة أثناء الجلب (لا وميض) + التفعيل من حرفين. التطبيع العربي والترتيب على الخادم.
  const debounced = useDebouncedValue(query, 180);
  const term = debounced.trim();
  const canSearch = term.length >= 2;
  // Sale-side query
  const posQ = trpc.catalog.posList.useQuery(
    { branchId, tier, query: term, limit: 50 },
    { enabled: !isPurchase && canSearch, placeholderData: keepPreviousData, staleTime: 15_000 }
  );
  // Purchase-side query
  const purQ = trpc.catalog.forPurchase.useQuery(
    { branchId, query: term, limit: 50 },
    { enabled: isPurchase && canSearch, placeholderData: keepPreviousData, staleTime: 15_000 }
  );
  /** النتائج مطابقة للنص الحالي (لا تأجيل ولا جلب معلّق وطوله صالح) ⇒ Enter يضيف بأمان */
  const settled =
    term === query.trim() && query.trim().length >= 2 && !(isPurchase ? purQ.isFetching : posQ.isFetching);

  const utils = trpc.useUtils();

  // ما يُعرض/يُبحر فيه: عند النزول تحت حرفين تُخفى النتائج القديمة العالقة (keepPreviousData)
  // كي لا تُعرض مضلِّلةً ولا يضيفها Enter/الأسهم خطأً.
  const results: NormalizedRow[] = useMemo(() => {
    if (query.trim().length < 2) return [];
    if (isPurchase) {
      return (purQ.data ?? []).map((r) => ({
        productId: r.productId,
        variantId: r.variantId,
        productUnitId: r.productUnitId,
        name: r.productName + (r.variantName ? ` — ${r.variantName}` : ""),
        sku: r.sku,
        barcode: null,
        unitName: r.unitName,
        conversionFactor: r.conversionFactor,
        stockBase: r.stockBase ?? 0,
        price: r.costPriceBase, // purchase price defaults to last cost (base)
        costBase: r.costPriceBase,
      }));
    }
    return (posQ.data ?? []).map((r) => ({
      productId: r.productId,
      variantId: r.variantId,
      productUnitId: r.productUnitId,
      name: r.productName + (r.variantName ? ` — ${r.variantName}` : ""),
      sku: r.sku,
      barcode: r.barcode ?? null,
      unitName: r.unitName,
      conversionFactor: r.conversionFactor,
      stockBase: r.stockBase ?? 0,
      price: r.price ?? "0",
      costBase: "0", // cashier should not see cost; pages may pass showCost=false in the table
    }));
  }, [isPurchase, posQ.data, purQ.data, query]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setShowDrop(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  useEffect(() => {
    // تظهر القائمة دائماً مع نصّ بحث (نتائج أو حالة واضحة: قصير/جارٍ/لا نتائج) — لا صمت
    setShowDrop(query.trim().length > 0);
    setSelectedIdx(-1);
  }, [results, query]);

  const addRow = (r: NormalizedRow) => {
    const line: InvoiceLine = {
      productId: r.productId,
      variantId: r.variantId,
      productUnitId: r.productUnitId,
      name: r.name,
      sku: r.sku,
      barcode: r.barcode,
      unit: r.unitName,
      qty: 1,
      conversionFactor: r.conversionFactor,
      stockBase: r.stockBase,
      price: r.price || "0",
      costBase: r.costBase || "0",
      discount: "0",
      discountType: "percent",
      tax: "0",
      note: "",
    };
    onAddProduct(line);
    setQuery("");
    setShowDrop(false);
    inputRef.current?.focus();
  };

  const handleKey = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedIdx >= 0 && results[selectedIdx]) {
        addRow(results[selectedIdx]);
        return;
      }
      // أثناء التأجيل/الجلب النتائج قد تعود لاستعلام أقدم ⇒ لا نضيف خطأً (انتظر ~٢٠٠ms واضغط من جديد)
      if (settled && results.length >= 1) {
        addRow(results[0]);
        return;
      }
      // Try exact barcode resolution (sale side only — has byBarcode endpoint).
      // فقط لما يشبه باركوداً (أرقام/لاتيني متصل ≥4) — نصّ بحث عربي عادي لا يُرمى عليه
      // «باركود غير معروف»؛ رسالة «لا نتائج» تظهر في القائمة نفسها.
      const code = query.trim();
      const looksLikeBarcode = /^[0-9A-Za-z_-]{4,}$/.test(code);
      if (code && !isPurchase && looksLikeBarcode) {
        try {
          const row = await utils.catalog.byBarcode.fetch({ barcode: code, branchId, tier });
          if (row) {
            addRow({
              productId: row.productId,
              variantId: row.variantId,
              productUnitId: row.productUnitId,
              name: row.productName + (row.variantName ? ` — ${row.variantName}` : ""),
              sku: row.sku,
              barcode: row.barcode ?? null,
              unitName: row.unitName,
              conversionFactor: row.conversionFactor,
              stockBase: row.stockBase ?? 0,
              price: row.price ?? "0",
              costBase: "0",
            });
            return;
          }
          onNotify?.(`الباركود غير معروف: ${code}`, "error");
        } catch {
          onNotify?.("تعذّر الاتصال بالخادم", "error");
        }
      }
    } else if (e.key === "Escape") {
      setShowDrop(false);
      setQuery("");
    }
  };

  const loading = (isPurchase ? purQ.isFetching : posQ.isFetching) && query.trim().length > 0;

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <span aria-hidden className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-base text-muted-foreground">
            🔍
          </span>
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            onFocus={() => {
              if (results.length > 0) setShowDrop(true);
            }}
            placeholder="ابحث بالاسم أو SKU أو امسح الباركود..."
            className="h-11 pe-10 ps-4 text-sm"
            aria-label="بحث المنتجات"
          />
          {query && (
            <button
              type="button"
              aria-label="مسح"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="absolute start-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-sm text-muted-foreground hover:bg-muted"
            >
              ✕
            </button>
          )}
        </div>
        <div className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg border bg-muted px-3 text-xs font-semibold text-muted-foreground">
          <span className="text-base">📷</span> باركود
        </div>
        <div className="shrink-0 rounded-md bg-muted px-2 py-1 text-[11px] font-semibold text-muted-foreground">F2 للبحث</div>
      </div>

      {showDrop && (
        <div className="absolute inset-x-0 top-[calc(100%+4px)] z-40 overflow-hidden rounded-xl border bg-card shadow-xl">
          {query.trim().length < 2 && (
            <div className="px-4 py-3 text-center text-xs text-muted-foreground">اكتب حرفين فأكثر للبحث…</div>
          )}
          {query.trim().length >= 2 && results.length === 0 && (
            <div className="px-4 py-3 text-center text-xs text-muted-foreground">
              {loading ? "جارٍ البحث…" : <>لا نتائج لـ «{query.trim()}» — جرّب كلمة أقصر أو امسح الباركود</>}
            </div>
          )}
          {/* النتائج السابقة تبقى ظاهرة أثناء الجلب (باهتة قليلاً) — لا وميض اختفاء */}
          <div className={cn("max-h-80 overflow-auto", loading && "opacity-60")}>
          {results.map((p, i) => (
              <div
                key={p.productUnitId}
                onClick={() => addRow(p)}
                className={cn(
                  "grid cursor-pointer grid-cols-[1fr_auto] gap-3 border-b px-4 py-2.5 last:border-b-0 transition",
                  i === selectedIdx ? "bg-primary/10" : "hover:bg-muted"
                )}
              >
                <div>
                  <div className="text-sm font-bold text-foreground">{p.name}</div>
                  <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                    <span>{p.sku}</span>
                    <span>•</span>
                    <span>{p.unitName}</span>
                    <span>•</span>
                    <span className={stockBadgeColor(p.stockBase)}>مخزون: {fmtNum(p.stockBase)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end justify-center">
                  <div dir="ltr" className="text-base font-extrabold text-primary">
                    {fmtNum(p.price)}
                  </div>
                  <div className="text-[10px] text-muted-foreground">د.ع / {p.unitName}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
