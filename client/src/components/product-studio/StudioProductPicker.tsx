import { CameraScanner } from "@/components/scan/CameraScanner";
import { BarcodeSearchCue, barcodeSearchInputClass } from "@/components/scan/BarcodeSearchCue";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { createLatestBarcodeResolutionGate } from "@/lib/productStudio/barcodeResolution";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Camera, Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

type StudioProduct = RouterOutputs["productStudio"]["products"]["rows"][number];

export function StudioProductPicker({
  canManage,
  value,
  onPick,
}: {
  canManage: boolean;
  value: number | null;
  onPick: (product: StudioProduct) => void;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [unknownBarcode, setUnknownBarcode] = useState("");
  const [isResolvingBarcode, setIsResolvingBarcode] = useState(false);
  const utils = trpc.useUtils();
  const barcodeResolutionGate = useRef(createLatestBarcodeResolutionGate());

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  const search = trpc.productStudio.products.useInfiniteQuery(
    { search: debouncedQuery, includeInactive },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const resolveBarcode = async (barcode: string) => {
    const token = barcodeResolutionGate.current.next();
    setIsResolvingBarcode(true);
    try {
      const match = await utils.productStudio.resolveBarcode.fetch({ barcode });
      if (!barcodeResolutionGate.current.isCurrent(token)) return;
      if (!match.isActive) {
        setUnknownBarcode("المنتج معطّل ولا يمكن إسناد مهمة له.");
        return;
      }
      onPick({ ...match, matchedBarcode: null });
      setQuery("");
      setOpen(false);
      setUnknownBarcode("");
    } catch {
      if (barcodeResolutionGate.current.isCurrent(token)) setUnknownBarcode("الباركود غير معروف. راجعه أو ابحث بالاسم.");
    } finally {
      if (barcodeResolutionGate.current.isCurrent(token)) setIsResolvingBarcode(false);
    }
  };
  const barcodeInput = useBarcodeInput((barcode) => {
    setQuery(barcode);
    setOpen(true);
    setUnknownBarcode("");
    void resolveBarcode(barcode);
  });

  // لا نعرض نتيجة مفتاح أقدم أثناء مهلة debounce؛ يمنع اختيار نتيجة لا تخص النص الحالي.
  const rows = useMemo(
    () => query.trim() === debouncedQuery ? (search.data?.pages ?? []).flatMap((page) => page.rows) : [],
    [debouncedQuery, query, search.data],
  );
  useEffect(() => setActiveIndex(0), [debouncedQuery, includeInactive]);

  const pick = (row: StudioProduct) => {
    if (!row.isActive) {
      setUnknownBarcode("المنتج معطّل ولا يمكن إسناد مهمة له.");
      return;
    }
    onPick(row);
    setQuery("");
    setOpen(false);
    setUnknownBarcode("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    barcodeInput.handleKeyDown(event, setQuery);
    if (event.defaultPrevented) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => Math.min(current + 1, Math.max(rows.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" && rows[activeIndex]) {
      event.preventDefault();
      pick(rows[activeIndex]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  const selected = rows.find((row) => row.productId === value);
  return (
    <div className="space-y-1.5">
      <div className="relative flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Input
            id="studio-product-search"
            value={query}
            onChange={(event) => {
              barcodeResolutionGate.current.next();
              setIsResolvingBarcode(false);
              setQuery(event.target.value);
              setOpen(true);
              setUnknownBarcode("");
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="اسم المنتج أو SKU أو الباركود"
            className={barcodeSearchInputClass}
            role="combobox"
            aria-expanded={open}
            aria-controls="studio-product-results"
            aria-activedescendant={rows[activeIndex] ? `studio-product-${rows[activeIndex].productId}` : undefined}
          />
          <BarcodeSearchCue />
        </div>
        <Button type="button" variant="outline" size="icon" onClick={() => setCameraOpen(true)} aria-label="مسح باركود بالكاميرا">
          <Camera className="size-4" />
        </Button>
      </div>
      {canManage && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={includeInactive} onCheckedChange={(checked) => setIncludeInactive(checked === true)} />
          إظهار المنتجات المعطّلة للمراجعة
        </label>
      )}
      {selected && !query && <p className="text-xs text-muted-foreground">المنتج المختار: {selected.productName}</p>}
      {unknownBarcode && <p className="text-xs text-destructive" role="status">{unknownBarcode}</p>}
      {open && (
        <div id="studio-product-results" className="max-h-64 overflow-auto rounded-md border bg-popover shadow-sm" role="listbox">
          {(search.isFetching || isResolvingBarcode) && rows.length === 0 ? (
            <div className="flex items-center justify-center gap-2 p-3 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" /> جارٍ البحث…</div>
          ) : rows.length === 0 ? (
            <div className="p-3 text-center text-xs text-muted-foreground">لا توجد منتجات مطابقة.</div>
          ) : (
            <>
              {rows.map((row, index) => (
                <button
                  id={`studio-product-${row.productId}`}
                  key={`${row.productId}-${row.variantId ?? "product"}-${row.unitId ?? "unit"}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  disabled={!row.isActive}
                  className={`block w-full border-b px-3 py-2 text-start text-sm last:border-b-0 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-55 ${index === activeIndex ? "bg-accent" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => pick(row)}
                >
                  <span className="font-medium">{row.productName}</span>
                  {(row.variantName || row.unitName) && <span className="text-muted-foreground"> — {[row.variantName, row.unitName].filter(Boolean).join(" / ")}</span>}
                  {!row.isActive && <span className="mr-2 text-xs text-destructive">معطّل</span>}
                </button>
              ))}
              {search.hasNextPage && (
                <div className="p-2">
                  <Button type="button" variant="outline" className="w-full" disabled={search.isFetchingNextPage} onClick={() => void search.fetchNextPage()}>
                    {search.isFetchingNextPage ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />} تحميل المزيد
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      <CameraScanner
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onDetect={(barcode) => {
          setCameraOpen(false);
          setQuery(barcode);
          setOpen(true);
          setUnknownBarcode("");
          void resolveBarcode(barcode);
        }}
      />
    </div>
  );
}
