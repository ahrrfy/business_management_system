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
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Gift, Package, ShoppingCart, X } from "lucide-react";
import { priceDecimalsFor } from "@shared/moneyPrecision";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { calcLineTotal, calcMargin, calcUnitCost, fmtNum } from "./totals";
import { ProductSearchBar } from "./ProductSearchBar";
import { getLineStockState } from "./stockAvailability";
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

/**
 * خليّة رقميّة داخل جدول الفاتورة (سعر البند/نسبة الخصم) — **تفويضٌ كامل لـ`MoneyInput`**.
 *
 * **الجذر (بلاغ المالك ١٧/٨/٢٦: «السعر لا يمكن أن يكون 1,450.99»):** كانت هذه الخليّة تُحلّل
 * المدخل بـ`Number(v)` مباشرةً وتُسقط أيّ ضغطةٍ تُنتج `NaN` **بلا أيّ إشعار**. فالفاصلة الألفية
 * («1,450.99» — وهي الشكل الذي تعرضه بقيّة حقول النظام)، والأرقام الهندية («١٤٥٠٫٩٩»)، ورمز
 * العملة الملتصق، واللصق من Excel: كلّها تُبتلَع صامتةً فيبدو الحقل «مرفوضاً/متجمّداً». وكانت
 * تقبل منازل عشرية بلا سقف ثمّ تُقصّ صامتاً عند الحفظ ⇒ المعروض ≠ المحفوظ.
 *
 * `MoneyInput` يحلّ الثلاثة معاً بمنطقٍ واحدٍ مُختبَر: تطبيعُ اللصق عبر `toNormalizedNumber`،
 * وفواصلُ آلافٍ حيّة في العرض بينما القيمة الخام (بلا فواصل) هي ما يُرسَل، وسقفُ منازلٍ صريح.
 */
function InlineNumberInput({
  value,
  onChange,
  width = "w-20",
  max,
  suffix,
  decimals = 2,
  ariaLabel,
}: {
  value: string | number;
  onChange: (v: string) => void;
  width?: string;
  /** سقفٌ أعلى للقيمة (نسبة الخصم = ١٠٠). يُقصّ التجاوز فقط — لا يمسّ القيم الوسيطة أثناء الكتابة. */
  max?: number;
  suffix?: string;
  /** أقصى منازل عشرية — يُشتقّ من عملة المستند عبر `priceDecimalsFor` لحقول السعر. */
  decimals?: number;
  ariaLabel?: string;
}) {
  return (
    <div className="flex items-center justify-center gap-1">
      <MoneyInput
        value={String(value ?? "")}
        decimals={decimals}
        ariaLabel={ariaLabel}
        onChange={(raw) => {
          if (max == null || raw === "" || raw === ".") return onChange(raw);
          // القصّ عند التجاوز فقط: تمريرُ `String(Number(raw))` دائماً كان يمسح النقطة أثناء
          // كتابة كسر («12.» ⇒ «12») فيتعذّر إدخال خصمٍ كسريّ.
          const n = Number(raw);
          onChange(Number.isFinite(n) && n > max ? String(max) : raw);
        }}
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
  const branchesQ = trpc.branches.list.useQuery();
  const branchLabel = (id: number) => branchesQ.data?.find((b) => Number(b.id) === id)?.name ?? `فرع #${id}`;
  const isPurchase = invoiceType === "PURCHASE" || invoiceType === "PURCHASE_RETURN";
  // مرتجع البيع: السعر والخصم يُعرَضان للقراءة فقط — الخادم يتجاهل تسعير المحرّر ويحسب الاسترداد
  // تناسبياً من إجماليّات بنود الفاتورة المصدر المخزَّنة، فتحريرهما وهمٌ يضلّل الموظّف.
  const readOnlyPricing = invoiceType === "SALE_RETURN" || invoiceType === "PURCHASE_RETURN";
  const sourceLocked = invoiceType === "PURCHASE_RETURN";
  const showCostCol = showCost && !isPurchase;
  // خصم البند مخفيّ في الشراء: خدمة الشراء (`createPurchaseOrder`) تتجاهله تماماً (التكلفة = سعر
  // الوحدة كاملاً) ⇒ إظهاره يوهم بأثرٍ لا يقع ويجعل الإجمالي المعروض ≠ المحفوظ. البيع يُبقيه.
  const showDiscountCol = !isPurchase;
  const showIqdEquivalent = isPurchase && purchaseCurrency === "USD" && Number(purchaseRate) > 0;
  // دقّة سعر البند = دقّة **عملة المستند** (`shared/moneyPrecision`): الدينار منزلتان والدولار
  // أربع (سعر الوحدة الدولاريّ يُشتقّ بالقسمة: 41.48 ÷ 12 = 3.4566). الحقل يُطبّق السقف أثناء
  // الكتابة ⇒ المعروض = المُرسَل = المخزَّن، فلا حاجة لقصٍّ صامتٍ عند مغادرة الحقل (كان يُحوّل
  // 3.4566 إلى 3.46 بلا إشعار). البيع/عرض السعر بالدينار دائماً.
  const linePriceDecimals = priceDecimalsFor(isPurchase ? purchaseCurrency : "IQD");
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
    const convFactor = Number(it.conversionFactor) || 1;
    const reqBase = demandByVariant.get(it.variantId) ?? (Number(it.qty) || 0) * convFactor;
    const state = getLineStockState(it, reqBase);
    return isPurchase ? { ...state, isOut: false, isShort: false } : state;
  };

  const th = "sticky top-0 z-[2] whitespace-nowrap border-b-2 bg-muted px-2 py-2 text-center text-xs font-bold text-muted-foreground";
  const td = "px-2 py-1.5 text-center text-sm align-middle";

  // ٢٣/٨ — تمريرٌ تلقائيّ لآخر منتجٍ مُضاف (بلاغ المالك على شاشات الكاشيرات — طُبِّق على فاتورة
  // البيع المتقدّمة والشراء وعرض السعر ومرتجع الشراء: كلّها تستهلك ProductTable). لا مفهومَ
  // «مختار» هنا (كلّ سطرٍ قابلٌ للتحرير المباشر) ⇒ نحرّك آخر صفٍّ في مجال الرؤية عند فعل الإضافة.
  //
  // ٢٣/٨ (Codex P2): الاعتماد على `items.length` كان يشغّل التمرير عند تحميل مستندٍ قائم
  // (PurchaseEdit / تصحيح فاتورة يرسلان REPLACE_STATE بأسطرٍ كثيرة) فيقفز الجدولُ للأسفل
  // ويُخفي الأوائل. الحلّ: عدّاد `addTick` داخليّ يزيد **فقط** عند ADD_ITEM من ProductSearchBar
  // الداخليّ (بحثٌ فعليٌّ من الكاشير). REPLACE_STATE والحذف وتعديل الكمّية لا يحرّكونه.
  // BulkPicker يظلّ خارج التمرير التلقائي (يقفلها الكاشير بيديه ويرى النتيجة فوراً).
  const lastRowRef = useRef<HTMLTableRowElement | null>(null);
  const [addTick, setAddTick] = useState(0);
  useEffect(() => {
    if (addTick === 0) return;
    const raf = requestAnimationFrame(() => {
      lastRowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
  }, [addTick]);

  return (
    <section className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden rounded-xl border bg-card print:overflow-visible">
      {!sourceLocked && (
        <div className="shrink-0 border-b px-3.5 py-3">
          <ProductSearchBar
            invoiceType={invoiceType}
            branchId={branchId}
            tier={tier}
            onAddProduct={(line) => { dispatch({ type: "ADD_ITEM", item: line }); setAddTick((t) => t + 1); }}
            onNotify={onNotify}
          />
        </div>
      )}

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
          {!sourceLocked && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
              onClick={onOpenBulkPicker}
            >
              <Package aria-hidden className="size-4" /> إضافة متعددة
            </Button>
          )}
          {items.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 border-[var(--sem-neg)]/40 text-[var(--sem-neg)] hover:bg-[var(--sem-neg-bg)]"
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
              <th className={cn(th, "w-20")}>{isPurchase ? "المخزون" : "المتاح للبيع"}</th>
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
                  {/* ٢٣/٨ (بلاغ فحص UX): كان النصّ عاماً يكرّر شريط البحث فوقه. صار دعوةَ فعلٍ محدَّدةً
                      بأيقونتَي لوحة المفاتيح والحزمة كي يعرف الموظّف طريقين واضحَين. */}
                  <div className="mx-auto mt-2 flex max-w-md items-center justify-center gap-3 text-xs">
                    <span className="inline-flex items-center gap-1">
                      اضغط <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-bold">F2</kbd> للبحث السريع
                    </span>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="inline-flex items-center gap-1">
                      أو <span className="font-bold text-primary">إضافة متعدّدة</span> لاختيار مجموعة
                    </span>
                  </div>
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
                  ref={idx === items.length - 1 ? lastRowRef : undefined}
                  className={cn(
                    "border-b transition hover:bg-muted/50",
                    stock.isKnown && stock.isOut && "border-s-[3px] border-s-destructive bg-destructive/5",
                    stock.isKnown && !stock.isOut && stock.isShort && "border-s-[3px] border-s-[var(--sem-warn)] bg-[var(--sem-warn-bg)]",
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
                      {!isPurchase && !stock.isKnown && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] font-extrabold text-muted-foreground">
                          جارٍ التحقق من الرصيد
                        </span>
                      )}
                      {!isPurchase && stock.isService && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] font-extrabold text-muted-foreground">
                          خدمة — بلا رصيد مخزني
                        </span>
                      )}
                      {/* «يُباع بالطلب» (0318): نُصرّح بأن الرصيد الصفريّ/السالب مقصود ومسموح،
                          كي لا يقرأه المستعمل عطباً ويمتنع عن حفظ فاتورةٍ ستنجح. */}
                      {!isPurchase && stock.allowBackorder && stock.availableBase <= 0 && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-[var(--sem-warn)] px-2 py-0.5 text-[10px] font-extrabold text-background">
                          يُباع بالطلب — يُورَّد لاحقاً
                        </span>
                      )}
                      {!isPurchase && stock.isKnown && stock.isOut && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-destructive px-2 py-0.5 text-[10px] font-extrabold text-destructive-foreground">
                          لا يوجد متاح للبيع
                        </span>
                      )}
                      {!isPurchase && stock.isKnown && !stock.isOut && stock.isShort && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-[var(--sem-warn)] px-2 py-0.5 text-[10px] font-extrabold text-background">
                          {stock.availableInUnit === 0 ? "لا يكفي لوحدة" : `المتاح ${stock.availableInUnit} فقط`}
                        </span>
                      )}
                      {!isPurchase && stock.overbookedBase > 0 && (
                        <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                          زيادة حجز {fmtNum(stock.overbookedBase)} وحدة أساس
                        </span>
                      )}
                    </div>
                    {!isPurchase && stock.isKnown && !stock.isService && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                        <span>{branchLabel(item.stockBranchId ?? branchId)}</span>
                        <span>فعلي {fmtNum(stock.onHandBase)}</span>
                        <span className={stock.reservedBase > 0 ? "font-bold text-[var(--sem-warn)]" : ""}>
                          محجوز {fmtNum(stock.reservedBase)}
                        </span>
                        <span className="font-bold">متاح للبيع {fmtNum(stock.availableBase)}</span>
                      </div>
                    )}
                    {allocations.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {allocations.map((allocation) => (
                          <span
                            key={allocation.reservationId}
                            className="rounded border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--sem-warn)]"
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
                          <div className="flex items-center gap-1 font-semibold text-[var(--sem-warn)]">
                            <AlertTriangle aria-hidden className="size-3 shrink-0" />
                            الأرخص سابقاً: {purchaseInsight.lowestPurchase.supplierName} بـ <span dir="ltr">{fmtNum(purchaseInsight.lowestPurchase.price)}</span> د.ع
                            <span>(فرق {fmtNum(enteredPriceIqd! - lowestPriceIqd!)} د.ع)</span>
                          </div>
                        )}
                        {isBelowHistoricalLow && (
                          <div className="font-semibold text-[var(--sem-pos)]">
                            سعر ممتاز: أقل من أدنى شراء سابق بـ <span dir="ltr">{fmtNum(lowestPriceIqd! - enteredPriceIqd!)}</span> د.ع
                          </div>
                        )}
                        {!isAboveHistoricalLow && supplierLastPriceIqd != null && enteredPriceIqd != null && enteredPriceIqd > supplierLastPriceIqd && (
                          <div className="font-semibold text-[var(--sem-warn)]">
                            أعلى من آخر سعر لهذا المورد بـ <span dir="ltr">{fmtNum(enteredPriceIqd - supplierLastPriceIqd)}</span> د.ع
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className={cn(td, "text-xs text-muted-foreground")}>{item.unit}</td>
                  <td className={td}>
                    {item.isService ? (
                      <span className="rounded bg-[var(--sem-pos-bg)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--sem-pos)]">خدمة</span>
                    ) : (
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-xs font-extrabold tabular-nums",
                          stock.isKnown && stock.isOut ? "bg-destructive text-destructive-foreground"
                            : stock.isShort ? "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
                            : "text-muted-foreground",
                        )}
                        dir="ltr"
                      >
                        {isPurchase
                          ? fmtNum(item.stockBase)
                          : stock.isKnown
                            ? fmtNum(stock.availableInUnit)
                            : "…"}
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
                        decimals={linePriceDecimals}
                        ariaLabel={`سعر ${item.name}`}
                        onChange={(v) => {
                          if (isPurchase) {
                            dispatch({ type: "UPDATE_ITEM", idx, field: "costBase", value: v });
                            dispatch({ type: "UPDATE_ITEM", idx, field: "price", value: v });
                          } else {
                            dispatch({ type: "UPDATE_ITEM", idx, field: "price", value: v });
                          }
                        }}
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
                          ariaLabel={`خصم ${item.name} بالنسبة المئوية`}
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
                        marginNum > 20 ? "text-[var(--sem-pos)]" : marginNum > 0 ? "text-[var(--sem-warn)]" : "text-[var(--sem-neg)]"
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
                      className="h-8 w-8 border-[var(--sem-neg)]/40 text-[var(--sem-neg)] hover:bg-[var(--sem-neg-bg)]"
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
