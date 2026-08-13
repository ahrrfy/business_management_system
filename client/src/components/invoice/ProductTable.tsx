/**
 * ProductTable — the invoice cart with inline editing.
 * Ported from `_design-bundle/project/invoice-table.jsx#ProductTable`.
 *
 * `showCost` is controlled by RBAC at the page level (cashier → false; manager → true).
 *
 * الضريبة على مستوى الفاتورة لا السطر (§١٤): لا يُحرَّر معدّل الضريبة لكل بند. إن مرَّرَ الأب
 * `taxShares` (مصفوفة نصوص decimal بطول items وناتجة من `allocateLineTax`)، ظهر عمود عرض
 * فقط باسم «حصة الضريبة» بجانب «الإجمالي»؛ خلاف ذلك يُخفى العمود تماماً.
 */
import type { Dispatch } from "react";
import { AlertTriangle, Gift, Package, ShoppingCart, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { D, round2 } from "@/lib/money";
import { calcLineTotal, calcMargin, calcUnitCost, fmtNum } from "./totals";
import { ProductSearchBar } from "./ProductSearchBar";
import type { Currency, InvoiceAction, InvoiceLine, InvoiceType, PriceTier } from "./types";

export interface PurchasePriceInsight {
  lastPurchase: { price: string; supplierId: number; supplierName: string; purchaseOrderId: number; orderDate: Date | string };
  lowestPurchase: { price: string; supplierId: number; supplierName: string; purchaseOrderId: number; orderDate: Date | string };
  selectedSupplierLastPurchase?: { price: string; supplierId: number; supplierName: string; purchaseOrderId: number; orderDate: Date | string };
}

export interface ProductTableProps {
  items: InvoiceLine[];
  dispatch: Dispatch<InvoiceAction>;
  branchId: number;
  tier: PriceTier;
  invoiceType: InvoiceType;
  /** false = hide cost & margin columns (cashier role). */
  showCost: boolean;
  purchaseCurrency?: Currency;
  purchaseRate?: string;
  purchasePriceInsights?: Record<string, PurchasePriceInsight>;
  /**
   * حصص الضريبة الموزَّعة لكل سطر (عرض فقط). مصفوفة نصوص decimal 2dp بطول `items` بالضبط
   * (يحسبها الأب عبر `allocateLineTax(items.map(i => ({total: calcLineTotal(i)})), totals.totalTax,
   * totals.afterDiscount)` ⇒ مجموع الحصص = totals.totalTax بلا انجراف). عمود «حصة الضريبة»
   * يظهر فقط حين taxShares مصفوفة بنفس طول items وفيها قيمة موجبة على الأقلّ. أُهمِل ⇒ لا عمود.
   */
  taxShares?: string[] | null;
  /**
   * هدايا الفاتورة (0149): إظهار عمود «هدية» بمفتاحٍ لكلّ سطر (فاتورة البيع فقط — الخادم لا يقبل
   * `isGift` إلّا في `sales.create`). الافتراضي false فلا تتأثّر شاشات الشراء/عرض السعر/المرتجع.
   */
  allowGiftLines?: boolean;
  onOpenBulkPicker: () => void;
  /** Toast hook. */
  onNotify?: (msg: string, kind: "error" | "info") => void;
}

function InlineNumberInput({
  value,
  onChange,
  width = "w-20",
  max,
  suffix,
  onBlur,
}: {
  value: string | number;
  onChange: (v: string) => void;
  width?: string;
  max?: number;
  suffix?: string;
  /** يُستدعى عند مغادرة الحقل — لتطبيع القيمة (مثل قصّ سعر الدولار إلى منزلتين/سنتين). */
  onBlur?: () => void;
}) {
  return (
    <div className="flex items-center justify-center gap-1">
      <Input
        dir="ltr"
        value={String(value ?? "")}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "" || v === "-" || v === ".") {
            onChange(v);
            return;
          }
          const n = Number(v);
          if (Number.isFinite(n)) {
            if (max != null) onChange(String(Math.min(max, Math.max(0, n))));
            else onChange(v);
          }
        }}
        onBlur={onBlur}
        className={cn("h-8 text-center text-sm font-bold", width)}
      />
      {suffix && <span className="text-[11px] text-muted-foreground">{suffix}</span>}
    </div>
  );
}

function QuantityControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8 text-base"
        onClick={() => onChange(Math.max(1, value - 1))}
        aria-label="إنقاص"
      >
        −
      </Button>
      <Input
        dir="ltr"
        value={String(value)}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!Number.isNaN(n) && n >= 1) onChange(n);
        }}
        className="h-8 w-12 text-center text-sm font-extrabold"
        aria-label="الكمية"
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8 text-base"
        onClick={() => onChange(value + 1)}
        aria-label="زيادة"
      >
        +
      </Button>
    </div>
  );
}

export function ProductTable({
  items,
  dispatch,
  branchId,
  tier,
  invoiceType,
  showCost,
  purchaseCurrency = "IQD",
  purchaseRate = "",
  purchasePriceInsights,
  taxShares,
  allowGiftLines = false,
  onOpenBulkPicker,
  onNotify,
}: ProductTableProps) {
  const isPurchase = invoiceType === "PURCHASE" || invoiceType === "PURCHASE_RETURN";
  // مرتجع البيع: السعر والخصم يُعرَضان للقراءة فقط — الخادم يتجاهل تسعير المحرّر ويحسب الاسترداد
  // تناسبياً من إجماليّات بنود الفاتورة المصدر المخزَّنة، فتحريرهما وهمٌ يضلّل الموظّف.
  const readOnlyPricing = invoiceType === "SALE_RETURN";
  const showCostCol = showCost && !isPurchase;
  // خصم البند مخفيّ في الشراء: خدمة الشراء (`createPurchaseOrder`) تتجاهله تماماً (التكلفة = سعر
  // الوحدة كاملاً) ⇒ إظهاره يوهم بأثرٍ لا يقع ويجعل الإجمالي المعروض ≠ المحفوظ. البيع يُبقيه.
  const showDiscountCol = !isPurchase;
  const showIqdEquivalent = isPurchase && purchaseCurrency === "USD" && Number(purchaseRate) > 0;
  // سعر الشراء بالدولار = سنتات (منزلتان). نطبّعه عند مغادرة الحقل كي يطابق ما يُرسَل للخادم
  // (`nonNegMoneyString` يقصّه لمنزلتين) فيصير المعروض = المخزَّن (لا فرق تقريبٍ صامت).
  const normalizeUsdPurchasePrice = isPurchase && purchaseCurrency === "USD";
  // عمود «حصة الضريبة» يظهر فقط حين يمرِّر الأبُ حصصاً بطول items وفيها قيمة موجبة واحدة على
  // الأقلّ (لا نُظهر عموداً كامل الأصفار حين تكون الضريبة غير مفعَّلة أو صفريّة).
  const showTaxCol =
    Array.isArray(taxShares) &&
    taxShares.length === items.length &&
    taxShares.some((s) => Number(s) > 0);
  // عدد الأعمدة لصفّ «السلة فارغة»: ٩ ثابتة + (خصم) + (تكلفة+هامش) + (حصة ضريبة) + (معادل د.ع) + (هدية).
  const colCount =
    9 + (showDiscountCol ? 1 : 0) + (showCostCol ? 2 : 0) + (showTaxCol ? 1 : 0) + (showIqdEquivalent ? 1 : 0) + (allowGiftLines ? 1 : 0);

  const totalQty = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
  const reservationVariantIds = isPurchase
    ? []
    : Array.from(new Set(items.filter((item) => !item.isService).map((item) => item.variantId)));
  const allocationsQ = trpc.reservations.activeAllocations.useQuery(
    { branchId, variantIds: reservationVariantIds },
    { enabled: reservationVariantIds.length > 0, staleTime: 15_000 },
  );
  const allocationsByVariant = new Map<number, NonNullable<typeof allocationsQ.data>>();
  for (const allocation of allocationsQ.data ?? []) {
    const list = allocationsByVariant.get(allocation.variantId) ?? [];
    list.push(allocation);
    allocationsByVariant.set(allocation.variantId, list);
  }

  const priceAsIqd = (price: string) => {
    const numeric = Number(price);
    if (!Number.isFinite(numeric)) return null;
    if (purchaseCurrency !== "USD") return numeric;
    const rate = Number(purchaseRate);
    return Number.isFinite(rate) && rate > 0 ? numeric * rate : null;
  };

  // حالة المخزون لكل صنف (مَشابهة POS/Reception). الـPurchase لا تَنطبق عليه دلالياً.
  // الطلب الكلّي لكل variant عبر كل وحداته في السلّة (رصيد الفرع مُشترك بين القطعة/الدرزن/الكرتون).
  const demandByVariant = new Map<number, number>();
  if (!isPurchase) {
    for (const it of items) {
      const f = Number(it.conversionFactor) || 1;
      demandByVariant.set(it.variantId, (demandByVariant.get(it.variantId) ?? 0) + (Number(it.qty) || 0) * f);
    }
  }
  const stockState = (it: InvoiceLine) => {
    if (isPurchase) return { isOut: false, isShort: false, availInUnit: Number.POSITIVE_INFINITY };
    // خدمة (١٢/٨/٢٦): بلا مخزون ذاتيّ — createSale يخصم موادها من الوصفة، فلا تحذير للخدمة.
    if (it.isService) return { isOut: false, isShort: false, availInUnit: Number.POSITIVE_INFINITY };
    const convFactor = Number(it.conversionFactor) || 1;
    const availBase = Number(it.availableBase ?? it.stockBase) || 0;
    const reqBase = demandByVariant.get(it.variantId) ?? (Number(it.qty) || 0) * convFactor;
    const isOut = availBase <= 0;
    const isShort = !isOut && reqBase > availBase;
    const availInUnit = Math.floor(availBase / convFactor);
    return { isOut, isShort, availInUnit };
  };

  const th = "sticky top-0 z-[2] whitespace-nowrap border-b-2 bg-muted px-2 py-2 text-center text-xs font-bold text-muted-foreground";
  const td = "px-2 py-1.5 text-center text-sm align-middle";

  return (
    <section className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden rounded-xl border bg-card print:overflow-visible">
      <div className="shrink-0 border-b px-3.5 py-3">
        <ProductSearchBar
          invoiceType={invoiceType}
          branchId={branchId}
          tier={tier}
          onAddProduct={(line) => dispatch({ type: "ADD_ITEM", item: line })}
          onNotify={onNotify}
        />
      </div>

      <div className="flex shrink-0 items-center justify-between border-b bg-muted px-3.5 py-1.5">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-sm font-extrabold">
            <ShoppingCart aria-hidden className="size-4" /> سلة المنتجات
          </span>
          {items.length > 0 && (
            <span className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-bold text-primary-foreground">
              {items.length} منتج · {totalQty} قطعة
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
            onClick={onOpenBulkPicker}
          >
            <Package aria-hidden className="size-4" /> إضافة متعددة
          </Button>
          {items.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 border-rose-400/40 text-rose-600 hover:bg-rose-50"
              onClick={() => dispatch({ type: "CLEAR_ITEMS" })}
            >
              تفريغ الكل
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto print:overflow-visible">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={cn(th, "w-9")}>#</th>
              <th className={cn(th, "w-24")}>الباركود</th>
              <th className={cn(th, "min-w-[180px] text-right")}>المنتج</th>
              <th className={cn(th, "w-16")}>الوحدة</th>
              <th className={cn(th, "w-16")}>المخزون</th>
              {showCostCol && <th className={cn(th, "w-20")}>التكلفة</th>}
              <th className={cn(th, "w-24")}>{isPurchase ? `سعر الشراء ${purchaseCurrency === "USD" ? "$" : "د.ع"}` : "السعر"}</th>
              <th className={cn(th, "w-32")}>الكمية</th>
              {showDiscountCol && <th className={cn(th, "w-20")}>خصم %</th>}
              {allowGiftLines && <th className={cn(th, "w-14")}>هدية</th>}
              {showTaxCol && <th className={cn(th, "w-24")}>حصة الضريبة</th>}
              {showCostCol && <th className={cn(th, "w-16")}>هامش%</th>}
              <th className={cn(th, "w-28")}>الإجمالي</th>
              {showIqdEquivalent && <th className={cn(th, "w-28")}>المعادل د.ع</th>}
              <th className={cn(th, "w-10")} aria-label="حذف" />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={colCount} className="py-12 text-center text-muted-foreground">
                  <div className="opacity-50 flex justify-center"><Package aria-hidden size={40} /></div>
                  <div className="mt-2 text-sm font-semibold">لا توجد منتجات في السلة</div>
                  <div className="mx-auto mt-1 max-w-xs text-xs">ابحث بالاسم أو رمز SKU أو امسح الباركود لإضافة منتجات</div>
                </td>
              </tr>
            )}
            {items.map((item, idx) => {
              const lineTotal = calcLineTotal(item);
              const margin = calcMargin(item);
              const marginNum = Number(margin);
              const stock = stockState(item);
              const allocations = allocationsByVariant.get(item.variantId) ?? [];
              const purchaseInsight = isPurchase
                ? purchasePriceInsights?.[`${item.variantId}:${item.productUnitId}`]
                : undefined;
              const enteredPriceIqd = priceAsIqd(item.costBase || item.price);
              const lowestPriceIqd = purchaseInsight ? Number(purchaseInsight.lowestPurchase.price) : null;
              const supplierLastPriceIqd = purchaseInsight?.selectedSupplierLastPurchase
                ? Number(purchaseInsight.selectedSupplierLastPurchase.price)
                : null;
              const isAboveHistoricalLow = enteredPriceIqd != null && lowestPriceIqd != null && enteredPriceIqd > lowestPriceIqd;
              const isBelowHistoricalLow = enteredPriceIqd != null && lowestPriceIqd != null && enteredPriceIqd > 0 && enteredPriceIqd < lowestPriceIqd;
              return (
                <tr
                  key={`${item.productUnitId}-${idx}`}
                  className={cn(
                    "border-b transition hover:bg-muted/50",
                    stock.isOut && "border-s-[3px] border-s-destructive bg-destructive/5",
                    !stock.isOut && stock.isShort && "border-s-[3px] border-s-amber-500 bg-amber-50",
                  )}
                >
                  <td className={cn(td, "font-semibold text-muted-foreground")}>{idx + 1}</td>
                  <td className={cn(td, "font-mono text-[11px] text-muted-foreground")} dir="ltr">
                    {item.barcode?.slice(-6) ?? "—"}
                  </td>
                  <td className={cn(td, "text-right")}>
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      <span className="text-sm font-bold leading-tight text-foreground">{item.name}</span>
                      {item.sku && (
                        <span className="font-mono text-[10px] text-muted-foreground" dir="ltr">{item.sku}</span>
                      )}
                      {stock.isOut && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-destructive px-2 py-0.5 text-[10px] font-extrabold text-destructive-foreground">
                          نافذ — لا مخزون
                        </span>
                      )}
                      {!stock.isOut && stock.isShort && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2 py-0.5 text-[10px] font-extrabold text-amber-50">
                          {stock.availInUnit === 0 ? "لا يكفي لوحدة" : `المتاح ${stock.availInUnit} فقط`}
                        </span>
                      )}
                    </div>
                    {!isPurchase && !item.isService && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                        <span>فعلي {fmtNum(item.stockBase)}</span>
                        <span className={Number(item.reservedBase ?? 0) > 0 ? "font-bold text-amber-700 dark:text-amber-400" : ""}>
                          محجوز {fmtNum(item.reservedBase ?? 0)}
                        </span>
                        <span className="font-bold">متاح {fmtNum(item.availableBase ?? item.stockBase)}</span>
                      </div>
                    )}
                    {allocations.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {allocations.map((allocation) => (
                          <span
                            key={allocation.reservationId}
                            className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                          >
                            حجز باسم {allocation.customerName} · {fmtNum(allocation.remainingBase)} وحدة أساس
                          </span>
                        ))}
                      </div>
                    )}
                    {purchaseInsight && (
                      <div className="mt-1 space-y-0.5 text-[10px] leading-4" dir="rtl">
                        <div className="text-muted-foreground">
                          آخر شراء: <span dir="ltr" className="font-bold tabular-nums">{fmtNum(purchaseInsight.lastPurchase.price)}</span> د.ع
                          <span> من {purchaseInsight.lastPurchase.supplierName}</span>
                        </div>
                        {purchaseInsight.selectedSupplierLastPurchase && (
                          <div className="text-muted-foreground">
                            آخر سعر من المورد الحالي: <span dir="ltr" className="font-bold tabular-nums">{fmtNum(purchaseInsight.selectedSupplierLastPurchase.price)}</span> د.ع
                          </div>
                        )}
                        {isAboveHistoricalLow && (
                          <div className="flex items-center gap-1 font-semibold text-amber-700 dark:text-amber-400">
                            <AlertTriangle aria-hidden className="size-3 shrink-0" />
                            الأرخص سابقاً: {purchaseInsight.lowestPurchase.supplierName} بـ <span dir="ltr">{fmtNum(purchaseInsight.lowestPurchase.price)}</span> د.ع
                            <span>(فرق {fmtNum(enteredPriceIqd! - lowestPriceIqd!)} د.ع)</span>
                          </div>
                        )}
                        {isBelowHistoricalLow && (
                          <div className="font-semibold text-emerald-700 dark:text-emerald-400">
                            سعر ممتاز: أقل من أدنى شراء سابق بـ <span dir="ltr">{fmtNum(lowestPriceIqd! - enteredPriceIqd!)}</span> د.ع
                          </div>
                        )}
                        {!isAboveHistoricalLow && supplierLastPriceIqd != null && enteredPriceIqd != null && enteredPriceIqd > supplierLastPriceIqd && (
                          <div className="font-semibold text-amber-700 dark:text-amber-400">
                            أعلى من آخر سعر لهذا المورد بـ <span dir="ltr">{fmtNum(enteredPriceIqd - supplierLastPriceIqd)}</span> د.ع
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className={cn(td, "text-xs text-muted-foreground")}>{item.unit}</td>
                  <td className={td}>
                    {item.isService ? (
                      <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">خدمة</span>
                    ) : (
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-xs font-extrabold tabular-nums",
                          stock.isOut ? "bg-destructive text-destructive-foreground"
                            : stock.isShort ? "bg-amber-100 text-amber-700"
                            : "text-muted-foreground",
                        )}
                        dir="ltr"
                      >
                        {isPurchase ? fmtNum(item.stockBase) : stock.availInUnit}
                      </span>
                    )}
                  </td>
                  {showCostCol && (
                    <td className={cn(td, "text-xs text-muted-foreground")} dir="ltr">
                      {fmtNum(calcUnitCost(item))}
                    </td>
                  )}
                  <td className={td}>
                    {item.isGift ? (
                      // السطر المُهدى: لا حقلَ سعرٍ أصلاً (الخادم يُصفّره) — نُظهر الحالة لا مُدخَلاً
                      // يوهم بإمكان التسعير. السعر المخزَّن في الحالة يبقى كما هو ليعود عند إلغاء الإهداء.
                      <span className="badge-status-active inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-extrabold">
                        <Gift aria-hidden className="size-3" /> مجاناً
                      </span>
                    ) : readOnlyPricing ? (
                      <span dir="ltr" className="text-sm font-bold tabular-nums">{fmtNum(item.price)}</span>
                    ) : (
                      <InlineNumberInput
                        value={isPurchase ? item.costBase || item.price : item.price}
                        width="w-20"
                        onChange={(v) => {
                          if (isPurchase) {
                            dispatch({ type: "UPDATE_ITEM", idx, field: "costBase", value: v });
                            dispatch({ type: "UPDATE_ITEM", idx, field: "price", value: v });
                          } else {
                            dispatch({ type: "UPDATE_ITEM", idx, field: "price", value: v });
                          }
                        }}
                        onBlur={
                          normalizeUsdPurchasePrice
                            ? () => {
                                // سعر الدولار = سنتات: نقصّه لمنزلتين عند المغادرة فيطابق ما يُرسَل ويُخزَّن
                                // (لا يبقى 4.1666 يُعرَض بينما يُحفظ 4.17). القيم الوسيطة («.») ⇒ تجاهُل آمن.
                                const raw = item.costBase || item.price || "0";
                                let rounded: string;
                                try {
                                  rounded = round2(D(raw)).toFixed(2);
                                } catch {
                                  return;
                                }
                                if (rounded === raw) return;
                                dispatch({ type: "UPDATE_ITEM", idx, field: "costBase", value: rounded });
                                dispatch({ type: "UPDATE_ITEM", idx, field: "price", value: rounded });
                              }
                            : undefined
                        }
                      />
                    )}
                  </td>
                  <td className={td}>
                    <QuantityControl
                      value={item.qty}
                      onChange={(v) => dispatch({ type: "UPDATE_ITEM", idx, field: "qty", value: v })}
                    />
                  </td>
                  {showDiscountCol && (
                    <td className={td}>
                      {item.isGift ? (
                        // خصمٌ على مجّانٍ لا معنى له — نُعطّل الحقل بدل تركه يوهم بأثرٍ لا يقع.
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : readOnlyPricing ? (
                        <span className="text-xs text-muted-foreground tabular-nums">{fmtNum(item.discount)}%</span>
                      ) : (
                        <InlineNumberInput
                          value={item.discount}
                          width="w-14"
                          max={100}
                          suffix="%"
                          onChange={(v) => dispatch({ type: "UPDATE_ITEM", idx, field: "discount", value: v })}
                        />
                      )}
                    </td>
                  )}
                  {allowGiftLines && (
                    <td className={td}>
                      <Button
                        type="button"
                        variant={item.isGift ? "default" : "outline"}
                        size="icon"
                        aria-pressed={item.isGift === true}
                        aria-label={item.isGift ? `إلغاء إهداء ${item.name}` : `إهداء ${item.name} مجاناً`}
                        title={item.isGift ? "إلغاء الإهداء (يعود السعر)" : "اجعل هذا الصنف هديةً مجانية"}
                        className="h-8 w-8"
                        onClick={() =>
                          dispatch({ type: "UPDATE_ITEM", idx, field: "isGift", value: !item.isGift })
                        }
                      >
                        <Gift aria-hidden className="size-4" />
                      </Button>
                    </td>
                  )}
                  {showTaxCol && (
                    <td className={cn(td, "text-xs font-semibold text-muted-foreground")} dir="ltr">
                      {fmtNum(taxShares![idx])}
                    </td>
                  )}
                  {showCostCol && (
                    <td
                      className={cn(
                        td,
                        "text-xs font-bold",
                        marginNum > 20 ? "text-emerald-600" : marginNum > 0 ? "text-amber-600" : "text-rose-600"
                      )}
                    >
                      {margin}%
                    </td>
                  )}
                  <td className={cn(td, "text-base font-extrabold")} dir="ltr">
                    {fmtNum(lineTotal)} {isPurchase && purchaseCurrency === "USD" ? "$" : ""}
                  </td>
                  {showIqdEquivalent && (
                    <td className={cn(td, "text-sm font-bold")} dir="ltr">
                      {fmtNum(Number(lineTotal) * Number(purchaseRate))}
                    </td>
                  )}
                  <td className={td}>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 border-rose-300/40 text-rose-600 hover:bg-rose-50"
                      onClick={() => dispatch({ type: "REMOVE_ITEM", idx })}
                      aria-label="حذف"
                    >
                      <X aria-hidden className="size-4" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
