/**
 * BulkPicker — overlay dialog that lists products (server-side via tRPC),
 * allowing multi-select with bulk add to the cart.
 * Ported from `_design-bundle/project/invoice-bulk-picker.jsx#BulkProductPicker`,
 * grouping by category is replaced with a simple flat list (no category endpoint yet).
 */
import { useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { fmtNum } from "./totals";
import type { InvoiceLine, InvoiceType, PriceTier } from "./types";

export interface BulkPickerProps {
  open: boolean;
  onClose: () => void;
  onAddItems: (lines: InvoiceLine[]) => void;
  invoiceType: InvoiceType;
  branchId: number;
  tier: PriceTier;
}

export function BulkPicker({ open, onClose, onAddItems, invoiceType, branchId, tier }: BulkPickerProps) {
  const isPurchase = invoiceType === "PURCHASE" || invoiceType === "PURCHASE_RETURN";
  const [searchQ, setSearchQ] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // الشمولية: لا سقف ثابت. نبدأ بصفحة ونزيد الحدّ كلّما مرّر المستخدم للأسفل (تحميل كسول
  // غير محدود) فتظهر كل المطابقات بالتمرير بدل قصّها عند رقم. PAGE حجم الدفعة.
  const PAGE = 300;
  const [limit, setLimit] = useState(PAGE);

  const posQ = trpc.catalog.posList.useQuery(
    { branchId, tier, query: searchQ.trim(), limit },
    { enabled: open && !isPurchase, placeholderData: keepPreviousData }
  );
  const purQ = trpc.catalog.forPurchase.useQuery(
    { branchId, query: searchQ.trim(), limit },
    { enabled: open && isPurchase, placeholderData: keepPreviousData }
  );

  type Row = {
    productUnitId: number;
    productId: number;
    variantId: number;
    name: string;
    sku: string;
    barcode: string | null;
    unitName: string;
    conversionFactor: string;
    stockBase: number;
    price: string;
    costBase: string;
  };

  const rows: Row[] = useMemo(() => {
    if (isPurchase) {
      return (purQ.data ?? []).map((r) => ({
        productUnitId: r.productUnitId,
        productId: r.productId,
        variantId: r.variantId,
        name: r.productName + (r.variantName ? ` — ${r.variantName}` : ""),
        sku: r.sku,
        barcode: null,
        unitName: r.unitName,
        conversionFactor: r.conversionFactor,
        stockBase: r.stockBase ?? 0,
        price: r.costPriceBase,
        costBase: r.costPriceBase,
      }));
    }
    return (posQ.data ?? []).map((r) => ({
      productUnitId: r.productUnitId,
      productId: r.productId,
      variantId: r.variantId,
      name: r.productName + (r.variantName ? ` — ${r.variantName}` : ""),
      sku: r.sku,
      barcode: r.barcode ?? null,
      unitName: r.unitName,
      conversionFactor: r.conversionFactor,
      stockBase: r.stockBase ?? 0,
      price: r.price ?? "0",
      costBase: "0",
    }));
  }, [isPurchase, posQ.data, purQ.data]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(rows.map((r) => r.productUnitId)));
  const clearAll = () => setSelected(new Set());

  const handleConfirm = () => {
    const lines: InvoiceLine[] = rows
      .filter((r) => selected.has(r.productUnitId))
      .map((r) => ({
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
      }));
    onAddItems(lines);
    setSelected(new Set());
    setSearchQ("");
    setLimit(PAGE);
    onClose();
  };

  // التحميل الأوّليّ فقط (isLoading = لا بيانات بعد) يُظهر شاشة «جارٍ التحميل»؛ أمّا جلب
  // الدفعات الإضافية (isFetching مع إبقاء البيانات السابقة) فيُظهر مؤشّراً سفلياً ولا يُخفي القائمة.
  const fetching = (isPurchase ? purQ.isFetching : posQ.isFetching) && open;
  const initialLoading = (isPurchase ? purQ.isLoading : posQ.isLoading) && open;
  // بلغنا الحدّ الحاليّ ⇒ قد توجد نتائج أكثر تُحمَّل بمزيد من التمرير.
  const maybeMore = rows.length >= limit;
  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    if (fetching || !maybeMore) return;
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) setLimit((l) => l + PAGE);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setSelected(new Set());
          setSearchQ("");
          setLimit(PAGE);
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b p-5">
          <DialogTitle className="flex items-center gap-2 text-lg font-extrabold">📦 إضافة متعددة</DialogTitle>
          <DialogDescription className="text-xs">
            اختر منتجات لإضافتها دفعة واحدة (الكمية تبدأ بـ 1 لكل صنف)
          </DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2 border-b px-5 py-2.5">
          <div className="relative flex-1">
            <span aria-hidden className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">🔍</span>
            <Input
              value={searchQ}
              onChange={(e) => { setSearchQ(e.target.value); setLimit(PAGE); }}
              placeholder="فلتر بالاسم أو SKU..."
              className="h-9 pe-9"
            />
          </div>
          <Button type="button" size="sm" variant="outline" onClick={selectAll}>
            تحديد الكل
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={clearAll}>
            إلغاء التحديد
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2" onScroll={handleScroll}>
          {initialLoading && <div className="px-3 py-6 text-center text-sm text-muted-foreground">جارٍ التحميل…</div>}
          {!initialLoading && rows.length === 0 && (
            <div className="px-3 py-10 text-center text-muted-foreground">
              <div className="mb-2 text-3xl">🔍</div>
              <div className="text-sm">لا نتائج</div>
            </div>
          )}
          {!initialLoading &&
            rows.map((p) => {
              const isSelected = selected.has(p.productUnitId);
              return (
                <div
                  key={p.productUnitId}
                  onClick={() => toggle(p.productUnitId)}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-lg border-b px-3 py-2 transition",
                    isSelected ? "bg-primary/10" : "hover:bg-muted/60"
                  )}
                >
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggle(p.productUnitId)}
                    aria-label={`اختيار ${p.name}`}
                    className="shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{p.name}</div>
                    <div className="mt-0.5 flex gap-2 text-[11px] text-muted-foreground">
                      <span>{p.sku}</span>
                      <span>•</span>
                      <span>{p.unitName}</span>
                      <span>•</span>
                      <span className={p.stockBase < 5 ? "text-rose-600" : ""}>مخزون: {fmtNum(p.stockBase)}</span>
                    </div>
                  </div>
                  <div className="shrink-0 text-left">
                    <div dir="ltr" className="text-sm font-extrabold text-primary">
                      {fmtNum(p.price)}
                    </div>
                    <div className="text-center text-[10px] text-muted-foreground">د.ع</div>
                  </div>
                </div>
              );
            })}
          {!initialLoading && rows.length > 0 && (
            <div className="px-3 py-3 text-center text-xs text-muted-foreground">
              {maybeMore
                ? fetching
                  ? "جارٍ تحميل المزيد…"
                  : "مرّر لأسفل لتحميل المزيد…"
                : `كل النتائج محمّلة — ${fmtNum(rows.length)} صنف`}
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between border-t bg-muted px-5 py-3">
          <div className="text-sm font-bold">
            تم تحديد <span className="text-base font-extrabold text-primary">{selected.size}</span> صنف
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              إلغاء
            </Button>
            <Button type="button" disabled={selected.size === 0} onClick={handleConfirm}>
              ✓ إضافة {selected.size > 0 ? `(${selected.size})` : ""} للسلة
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
