/**
 * ProductTable — the invoice cart with inline editing.
 * Ported from `_design-bundle/project/invoice-table.jsx#ProductTable`.
 *
 * `showCost` is controlled by RBAC at the page level (cashier → false; manager → true).
 */
import type { Dispatch } from "react";
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
  /** false = hide the per-line tax column (e.g. SALE in a 0%-VAT market where the backend
   *  stores no per-line tax). Default true to preserve existing screens. */
  showTax?: boolean;
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
  showTax = true,
  onOpenBulkPicker,
  onNotify,
}: ProductTableProps) {
  const isPurchase = invoiceType === "PURCHASE" || invoiceType === "PURCHASE_RETURN";
  const showCostCol = showCost && !isPurchase;
  const showTaxCol = showTax;
  // عدد الأعمدة لصفّ «السلة فارغة»: ١٠ ثابتة + (تكلفة+هامش) + (ضريبة).
  const colCount = 10 + (showCostCol ? 2 : 0) + (showTaxCol ? 1 : 0);

  const totalQty = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);

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
          <span className="text-sm font-extrabold">🛒 سلة المنتجات</span>
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
            📦 إضافة متعددة
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
              {showTaxCol && <th className={cn(th, "w-16")}>ضريبة %</th>}
              {showCostCol && <th className={cn(th, "w-16")}>هامش%</th>}
              <th className={cn(th, "w-28")}>الإجمالي</th>
              <th className={cn(th, "w-10")} aria-label="حذف" />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={colCount} className="py-12 text-center text-muted-foreground">
                  <div className="text-4xl opacity-50">📦</div>
                  <div className="mt-2 text-sm font-semibold">لا توجد منتجات في السلة</div>
                  <div className="mx-auto mt-1 max-w-xs text-xs">ابحث بالاسم أو رمز SKU أو امسح الباركود لإضافة منتجات</div>
                </td>
              </tr>
            )}
            {items.map((item, idx) => {
              const lineTotal = calcLineTotal(item);
              const margin = calcMargin(item);
              const lowStock = item.stockBase < 5;
              const marginNum = Number(margin);
              return (
                <tr key={`${item.productUnitId}-${idx}`} className="border-b transition hover:bg-muted/50">
                  <td className={cn(td, "font-semibold text-muted-foreground")}>{idx + 1}</td>
                  <td className={cn(td, "font-mono text-[11px] text-muted-foreground")} dir="ltr">
                    {item.barcode?.slice(-6) ?? "—"}
                  </td>
                  <td className={cn(td, "text-right")}>
                    <div className="text-sm font-bold text-foreground">{item.name}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{item.sku}</div>
                  </td>
                  <td className={cn(td, "text-xs text-muted-foreground")}>{item.unit}</td>
                  <td className={td}>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-xs font-bold",
                        lowStock ? "bg-rose-100 text-rose-700" : "text-muted-foreground"
                      )}
                    >
                      {fmtNum(item.stockBase)}
                    </span>
                  </td>
                  {showCostCol && (
                    <td className={cn(td, "text-xs text-muted-foreground")} dir="ltr">
                      {fmtNum(item.costBase)}
                    </td>
                  )}
                  <td className={td}>
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
                  </td>
                  <td className={td}>
                    <QuantityControl
                      value={item.qty}
                      onChange={(v) => dispatch({ type: "UPDATE_ITEM", idx, field: "qty", value: v })}
                    />
                  </td>
                  <td className={td}>
                    <InlineNumberInput
                      value={item.discount}
                      width="w-14"
                      max={100}
                      suffix="%"
                      onChange={(v) => dispatch({ type: "UPDATE_ITEM", idx, field: "discount", value: v })}
                    />
                  </td>
                  {showTaxCol && (
                    <td className={td}>
                      <InlineNumberInput
                        value={item.tax}
                        width="w-12"
                        max={100}
                        suffix="%"
                        onChange={(v) => dispatch({ type: "UPDATE_ITEM", idx, field: "tax", value: v })}
                      />
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
                      ✕
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
