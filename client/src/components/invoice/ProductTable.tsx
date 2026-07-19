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
import { Package, ShoppingCart, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { calcLineTotal, calcMargin, fmtNum } from "./totals";
import { ProductSearchBar } from "./ProductSearchBar";
import type { InvoiceAction, InvoiceLine, InvoiceType, PriceTier } from "./types";

export interface ProductTableProps {
  items: InvoiceLine[];
  dispatch: Dispatch<InvoiceAction>;
  branchId: number;
  tier: PriceTier;
  invoiceType: InvoiceType;
  /** false = hide cost & margin columns (cashier role). */
  showCost: boolean;
  /**
   * حصص الضريبة الموزَّعة لكل سطر (عرض فقط). مصفوفة نصوص decimal 2dp بطول `items` بالضبط
   * (يحسبها الأب عبر `allocateLineTax(items.map(i => ({total: calcLineTotal(i)})), totals.totalTax,
   * totals.afterDiscount)` ⇒ مجموع الحصص = totals.totalTax بلا انجراف). عمود «حصة الضريبة»
   * يظهر فقط حين taxShares مصفوفة بنفس طول items وفيها قيمة موجبة على الأقلّ. أُهمِل ⇒ لا عمود.
   */
  taxShares?: string[] | null;
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
}: {
  value: string | number;
  onChange: (v: string) => void;
  width?: string;
  max?: number;
  suffix?: string;
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
  taxShares,
  onOpenBulkPicker,
  onNotify,
}: ProductTableProps) {
  const isPurchase = invoiceType === "PURCHASE" || invoiceType === "PURCHASE_RETURN";
  // مرتجع البيع: السعر والخصم يُعرَضان للقراءة فقط — الخادم يتجاهل تسعير المحرّر ويحسب الاسترداد
  // تناسبياً من إجماليّات بنود الفاتورة المصدر المخزَّنة، فتحريرهما وهمٌ يضلّل الموظّف.
  const readOnlyPricing = invoiceType === "SALE_RETURN";
  const showCostCol = showCost && !isPurchase;
  // عمود «حصة الضريبة» يظهر فقط حين يمرِّر الأبُ حصصاً بطول items وفيها قيمة موجبة واحدة على
  // الأقلّ (لا نُظهر عموداً كامل الأصفار حين تكون الضريبة غير مفعَّلة أو صفريّة).
  const showTaxCol =
    Array.isArray(taxShares) &&
    taxShares.length === items.length &&
    taxShares.some((s) => Number(s) > 0);
  // عدد الأعمدة لصفّ «السلة فارغة»: ١٠ ثابتة + (تكلفة+هامش) + (حصة ضريبة).
  const colCount = 10 + (showCostCol ? 2 : 0) + (showTaxCol ? 1 : 0);

  const totalQty = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);

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
    const convFactor = Number(it.conversionFactor) || 1;
    const availBase = Number(it.stockBase) || 0;
    const reqBase = demandByVariant.get(it.variantId) ?? (Number(it.qty) || 0) * convFactor;
    const isOut = availBase <= 0;
    const isShort = !isOut && reqBase > availBase;
    const availInUnit = Math.floor(availBase / convFactor);
    return { isOut, isShort, availInUnit };
  };

  const th = "sticky top-0 z-[2] whitespace-nowrap border-b-2 bg-muted px-2 py-2.5 text-center text-xs font-bold text-muted-foreground";
  const td = "px-2 py-2.5 text-center text-sm align-middle";

  return (
    <section className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden rounded-xl border bg-card">
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

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={cn(th, "w-9")}>#</th>
              <th className={cn(th, "w-24")}>الباركود</th>
              <th className={cn(th, "min-w-[180px] text-right")}>المنتج</th>
              <th className={cn(th, "w-16")}>الوحدة</th>
              <th className={cn(th, "w-16")}>المخزون</th>
              {showCostCol && <th className={cn(th, "w-20")}>التكلفة</th>}
              <th className={cn(th, "w-24")}>{isPurchase ? "سعر الشراء" : "السعر"}</th>
              <th className={cn(th, "w-32")}>الكمية</th>
              <th className={cn(th, "w-20")}>خصم %</th>
              {showTaxCol && <th className={cn(th, "w-24")}>حصة الضريبة</th>}
              {showCostCol && <th className={cn(th, "w-16")}>هامش%</th>}
              <th className={cn(th, "w-28")}>الإجمالي</th>
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
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-bold text-foreground">{item.name}</span>
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
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{item.sku}</div>
                  </td>
                  <td className={cn(td, "text-xs text-muted-foreground")}>{item.unit}</td>
                  <td className={td}>
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
                  </td>
                  {showCostCol && (
                    <td className={cn(td, "text-xs text-muted-foreground")} dir="ltr">
                      {fmtNum(item.costBase)}
                    </td>
                  )}
                  <td className={td}>
                    {readOnlyPricing ? (
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
                      />
                    )}
                  </td>
                  <td className={td}>
                    <QuantityControl
                      value={item.qty}
                      onChange={(v) => dispatch({ type: "UPDATE_ITEM", idx, field: "qty", value: v })}
                    />
                  </td>
                  <td className={td}>
                    {readOnlyPricing ? (
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
                    {fmtNum(Math.round(Number(lineTotal)))}
                  </td>
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
