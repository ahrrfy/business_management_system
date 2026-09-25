/**
 * BulkPicker — overlay dialog that lists products (server-side via tRPC),
 * allowing multi-select with bulk add to the cart.
 * Ported from `_design-bundle/project/invoice-bulk-picker.jsx#BulkProductPicker`,
 * grouping by category is replaced with a simple flat list (no category endpoint yet).
 */
import { useEffect, useMemo, useState } from "react";
import { Check, Package, Search } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { cn } from "@/lib/utils";
import { fmtNum } from "./totals";
import { estimatedPurchaseUnitPrice } from "./purchasePrice";
import type { Currency, InvoiceLine, InvoiceType, PriceSource, PriceTier } from "./types";

export interface BulkPickerProps {
  open: boolean;
  onClose: () => void;
  onAddItems: (lines: InvoiceLine[]) => void;
  invoiceType: InvoiceType;
  branchId: number;
  tier: PriceTier;
  customerId?: number | null;
  /**
   * Codex #980 (٤/٩/٢٦): عملةُ أمر الشراء وسعرُ تثبيته لتقدير سعر وحدة الصفّ بالدولار
   * (الفرع الدولاريّ يقسم على `agreedRate`). تُمرَّر من `PurchaseNew`/`PurchaseEdit`.
   */
  purchaseCurrency?: Currency;
  purchaseAgreedRate?: string;
}

export function BulkPicker({ open, onClose, onAddItems, invoiceType, branchId, tier, customerId, purchaseCurrency = "IQD", purchaseAgreedRate = "" }: BulkPickerProps) {
  const isPurchase = invoiceType === "PURCHASE" || invoiceType === "PURCHASE_RETURN";
  const branchesQ = trpc.branches.list.useQuery();
  const branchLabel = (id: number) => branchesQ.data?.find((b) => Number(b.id) === id)?.name ?? `فرع #${id}`;
  // فاتورة بيع متقدّمة (١٢/٨/٢٦): كل خدمات الطباعة تُعرض هنا بلا شرط showInReception (المتقدّمة قد
  // تجمع سلعاً وخدماتٍ). createSale يخصم مواد الخدمة ويحتسب COGS ذرّياً.
  const isAdvancedSale = invoiceType === "SALE";
  const [searchQ, setSearchQ] = useState("");
  // حفظ الأصناف المحددة في Map للحفاظ التام والدقيق على تسلسل الاختيار (Insertion Order)
  // وصون الأصناف المختارة عبر عمليات البحث والفلترة المختلفة.
  const [selectedMap, setSelectedMap] = useState<Map<number, Row>>(new Map());
  // الشمولية: لا سقف ثابت. نبدأ بصفحة ونزيد الحدّ كلّما مرّر المستخدم للأسفل (تحميل كسول
  // غير محدود) فتظهر كل المطابقات بالتمرير بدل قصّها عند رقم. PAGE حجم الدفعة.
  const PAGE = 300;
  const [limit, setLimit] = useState(PAGE);

  const posQ = trpc.catalog.posList.useQuery(
    { branchId, tier, query: searchQ.trim(), limit, includeAllServices: isAdvancedSale, customerId },
    { enabled: open && !isPurchase }
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
    stockBranchId: number;
    reservedBase: number;
    availableBase: number;
    isService: boolean;
    isBundle: boolean;
    /** «يُباع بالطلب» (0318): يقبله الخادم قبل التوريد ⇒ لا يُوسَم نافداً. */
    allowBackorder: boolean;
    price: string;
    priceSource?: PriceSource;
    costBase: string;
  };

  const rows: Row[] = useMemo(() => {
    if (isPurchase) {
      return (purQ.data ?? []).map((r) => ({
        productUnitId: r.productUnitId, productId: r.productId, variantId: r.variantId,
        name: r.productName + (r.variantName ? ` — ${r.variantName}` : ""),
        sku: r.sku, barcode: null, unitName: r.unitName, conversionFactor: r.conversionFactor,
        stockBase: r.stockBase ?? 0, stockBranchId: branchId, reservedBase: 0, availableBase: r.stockBase ?? 0,
        isService: false, isBundle: false, allowBackorder: false,
        price: estimatedPurchaseUnitPrice(r.costPriceBase, r.conversionFactor, isPurchase ? purchaseCurrency : "IQD", isPurchase ? purchaseAgreedRate : null),
        costBase: r.costPriceBase,
      }));
    }
    return (posQ.data ?? []).map((r) => ({
      productUnitId: r.productUnitId, productId: r.productId, variantId: r.variantId,
      name: r.productName + (r.variantName ? ` — ${r.variantName}` : ""),
      sku: r.sku, barcode: r.barcode ?? null,
      unitName: r.isBundle === true && Number(r.conversionFactor) === 1 ? "بكج" : r.unitName,
      conversionFactor: r.conversionFactor, stockBase: r.stockBase ?? 0, stockBranchId: r.branchId,
      reservedBase: r.reservedBase ?? 0, availableBase: r.availableBase ?? (r.stockBase ?? 0),
      isService: r.isService || r.isPrintService, isBundle: r.isBundle === true,
      allowBackorder: r.allowBackorder === true, price: r.price ?? "0",
      priceSource: r.isContractPrice ? "CONTRACT" : "TIER", costBase: r.costPriceBase ?? "0",
    }));
  }, [isPurchase, posQ.data, purQ.data, purchaseCurrency, purchaseAgreedRate]);

  // تحديث بيانات الأصناف المحددة من أحدث نتائج rows مع الحفاظ الصارم على ترتيب الإدخال
  useEffect(() => {
    setSelectedMap((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map<number, Row>();
      prev.forEach((oldRow, id) => {
        const freshRow = rows.find((r) => r.productUnitId === id);
        if (freshRow && freshRow !== oldRow) {
          next.set(id, freshRow);
          changed = true;
        } else {
          next.set(id, oldRow);
        }
      });
      return changed ? next : prev;
    });
  }, [rows]);

  const salePricingPending = open && !isPurchase && posQ.isFetching;
  useEffect(() => {
    // اختيارٌ من سياق عميل/فئة سابق لا يجوز أن يبقى قابلاً للتأكيد بعد التبديل.
    setSelectedMap(new Map());
  }, [branchId, tier, customerId, invoiceType]);

  const toggle = (row: Row) => {
    if (salePricingPending) return;
    setSelectedMap((prev) => {
      const next = new Map(prev);
      if (next.has(row.productUnitId)) next.delete(row.productUnitId);
      else next.set(row.productUnitId, row);
      return next;
    });
  };

  const selectAll = () => {
    if (salePricingPending) return;
    setSelectedMap((prev) => {
      const next = new Map(prev);
      for (const r of rows) {
        if (!next.has(r.productUnitId)) next.set(r.productUnitId, r);
      }
      return next;
    });
  };
  const clearAll = () => setSelectedMap(new Map());

  // خريطة سريعة O(1) لرقم تسلسل التحديد لكل صنف لعرضه في شارة مرئية واضحة للمستخدم
  const selectedOrderMap = useMemo(() => {
    const map = new Map<number, number>();
    let order = 1;
    selectedMap.forEach((_, id) => {
      map.set(id, order++);
    });
    return map;
  }, [selectedMap]);

  const handleConfirm = () => {
    if (salePricingPending) return;
    // إضافة الأصناف بالتسلسل الزمني الدقيق الذي اختاره المستخدم (Array.from(selectedMap.values()))
    const lines: InvoiceLine[] = Array.from(selectedMap.values()).map((r) => ({
      productId: r.productId, variantId: r.variantId, productUnitId: r.productUnitId,
      name: r.name, sku: r.sku, barcode: r.barcode, unit: r.unitName, qty: 1,
      conversionFactor: r.conversionFactor, stockBase: r.stockBase, stockBranchId: r.stockBranchId,
      reservedBase: r.reservedBase, availableBase: r.availableBase, isService: r.isService,
      isBundle: r.isBundle, allowBackorder: r.allowBackorder, price: r.price || "0",
      referencePrice: r.price || "0", priceSource: r.priceSource, costBase: r.costBase || "0",
      discount: "0", discountType: "percent", note: "",
    }));
    onAddItems(lines);
    setSelectedMap(new Map());
    setSearchQ("");
    setLimit(PAGE);
    onClose();
  };

  // التحميل الأوّليّ يُظهر شاشة «جارٍ التحميل». أثناء أي جلب تسعير بيع يبقى التأكيد معطّلاً
  // حتى لا تُثبَّت نتيجة من سياق سابق؛ جانب الشراء وحده يُبقي البيانات السابقة.
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
          setSelectedMap(new Map());
          setSearchQ("");
          setLimit(PAGE);
          onClose();
        }
      }}
    >
      <DialogContent className="flex max-h-[85vh] sm:max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b p-5">
          <DialogTitle className="flex items-center gap-2 text-lg font-extrabold">
            <Package aria-hidden className="size-5" /> إضافة متعددة
          </DialogTitle>
          <DialogDescription className="text-xs">
            اختر منتجات لإضافتها دفعة واحدة (الكمية تبدأ بـ 1 لكل منتج)
          </DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2 border-b px-5 py-2.5">
          <UnifiedSearchInput
            value={searchQ}
            onChange={(val) => {
              setSearchQ(val);
              setLimit(PAGE);
            }}
            placeholder="فلتر بالاسم أو SKU أو امسح الباركود..."
            className="flex-1"
            size="default"
            debounceMs={200}
            barcode={true}
          />
          <Button type="button" size="sm" variant="outline" disabled={salePricingPending} onClick={selectAll}>
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
              <div className="mb-2 flex justify-center"><Search aria-hidden size={32} /></div>
              <div className="text-sm">لا نتائج</div>
            </div>
          )}
          {!initialLoading &&
            rows.map((p) => {
              const isSelected = selectedMap.has(p.productUnitId);
              const orderNum = selectedOrderMap.get(p.productUnitId);
              return (
                <div
                  key={p.productUnitId}
                  onClick={() => toggle(p)}
                  aria-disabled={salePricingPending}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-lg border-b px-3 py-2 transition",
                    salePricingPending && "cursor-not-allowed opacity-60",
                    isSelected ? "bg-primary/10 border-primary/20" : "hover:bg-muted/60"
                  )}
                >
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Checkbox
                      checked={isSelected}
                      disabled={salePricingPending}
                      onCheckedChange={() => toggle(p)}
                      // العلّة (١٤/٧): الصفّ كلّه onClick=toggle والمربّع onCheckedChange=toggle ⇒ النقر
                      // على المربّع نفسه كان يبدّل مرّتين (يبطل نفسه) فلا يُحدَّد شيء. نوقف الانتشار
                      // ⇒ نقرة المربّع = تبديل واحد، ونقرة بقية الصفّ تبقى تعمل، والمسافة/التبويب أيضاً.
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`اختيار ${p.name}`}
                      className="shrink-0"
                    />
                    {isSelected && orderNum !== undefined && (
                      <span
                        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-black text-primary-foreground shadow-xs animate-in zoom-in-50 duration-150"
                        title={`ترتيب الإضافة: #${orderNum}`}
                        aria-label={`ترتيب الاختيار ${orderNum}`}
                      >
                        {orderNum}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">
                      {p.name}
                      {p.isService && (
                        <span className="me-2 rounded-full bg-[var(--sem-pos-bg)] px-2 py-0.5 text-[10px] font-bold text-[var(--sem-pos)]">خدمة</span>
                      )}
                      {p.isBundle && (
                        <span className="me-2 rounded-full bg-[var(--sem-info-bg)] px-2 py-0.5 text-[10px] font-bold text-[var(--sem-info)]">بكج</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex gap-2 text-[11px] text-muted-foreground">
                      <span>{p.sku}</span>
                      <span>•</span>
                      <span>{p.unitName}</span>
                      <span>•</span>
                      <span>الفرع: {branchLabel(p.stockBranchId)}</span>
                      <span>•</span>
                      {p.isService ? (
                        <span>بلا مخزون ذاتيّ (تُخصَم موادها)</span>
                      ) : p.isBundle ? (
                        <span>المتاح كبكج كامل: {fmtNum(p.availableBase)}</span>
                      ) : (
                        <>
                          <span>فعلي: {fmtNum(p.stockBase)}</span>
                          {p.reservedBase > 0 && <span className="text-[var(--sem-warn)]">محجوز: {fmtNum(p.reservedBase)}</span>}
                          <span className={p.availableBase < 5 ? "text-[var(--sem-neg)]" : ""}>متاح للبيع: {fmtNum(p.availableBase)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-left">
                    <div dir="ltr" className="text-sm font-extrabold text-primary">
                      {fmtNum(p.price)}
                    </div>
                    <div className="text-center text-[10px] text-muted-foreground">
                      د.ع
                      {/* PUR-UNIT-01: تقديرٌ من آخر تكلفةٍ × معامل الوحدة — قابل للتعديل قبل الإرسال. */}
                      {isPurchase && (
                        <span className="ms-1 rounded bg-muted px-1 py-0.5 text-[9px] font-bold text-muted-foreground">
                          تقديريّ
                        </span>
                      )}
                    </div>
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
                : `كل النتائج محمّلة — ${fmtNum(rows.length)} منتج`}
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between border-t bg-muted px-5 py-3">
          <div className="flex flex-col text-sm">
            <div className="font-bold">
              تم تحديد <span className="text-base font-extrabold text-primary">{selectedMap.size}</span> منتج
            </div>
            {selectedMap.size > 1 && (
              <span className="text-[11px] text-muted-foreground">
                ستُضاف إلى الجدول بتسلسل التحديد ({selectedMap.size} أصناف)
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              إلغاء
            </Button>
            <Button type="button" disabled={selectedMap.size === 0 || salePricingPending} onClick={handleConfirm}>
              <Check aria-hidden className="size-4" /> إضافة {selectedMap.size > 0 ? `(${selectedMap.size})` : ""} للسلة
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
