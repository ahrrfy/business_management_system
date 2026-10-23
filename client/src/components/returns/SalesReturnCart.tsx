import { Minus, Plus, ShoppingCart, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MoneyInput } from "@/components/form/MoneyInput";
import { fmt, formatQuantity, moneyInput } from "@/lib/money";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { ProductSearchBar } from "@/components/invoice/ProductSearchBar";
import type { SalesReturnPortalModel } from "./useSalesReturnPortal";

type Props = Pick<
  SalesReturnPortalModel,
  | "activeBranchId"
  | "lastAddedId"
  | "salesCart"
  | "setSalesCart"
  | "salesTotal"
  | "salesTotalPieces"
  | "handleAddProductFromSearch"
>;
export function SalesReturnCart({
  activeBranchId,
  lastAddedId,
  salesCart,
  setSalesCart,
  salesTotal,
  salesTotalPieces,
  handleAddProductFromSearch,
}: Props) {
  return (
    <Card className="shadow-xs">
      <CardHeader className="p-3 pb-2 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <ShoppingCart className="size-4 text-primary" aria-hidden />
            <span>سلة الأصناف المرتجعة ({salesCart.length})</span>
            {salesTotalPieces > 0 && (
              <Badge
                variant="secondary"
                className="text-[11px] font-normal px-2 py-0"
              >
                إجمالي القطع: {salesTotalPieces}
              </Badge>
            )}
          </CardTitle>
          {salesCart.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSalesCart([])}
              className="h-7 text-xs text-muted-foreground hover:text-destructive px-2"
            >
              <Trash2 className="size-3 ml-1" />
              تفريغ السلة
            </Button>
          )}
        </div>

        {/* المكون الموحد للبحث عن المنتجات وإضافتها للسلة كما في الكاشير */}
        <ProductSearchBar
          invoiceType="SALE_RETURN"
          branchId={activeBranchId}
          tier="RETAIL"
          onAddProduct={handleAddProductFromSearch}
          onNotify={(msg, kind) =>
            kind === "error" ? notify.err(msg) : notify.info(msg)
          }
          placeholder="ابحث بالاسم أو SKU أو امسح الباركود لإضافته للسلة مباشرة... (F2)"
          compact={true}
          autoFocus={true}
        />
      </CardHeader>

      <CardContent className="p-3 pt-0">
        {salesCart.length === 0 ? (
          <div className="py-10 border-2 border-dashed rounded-xl text-center flex flex-col items-center justify-center gap-2 text-muted-foreground bg-muted/10">
            <ShoppingCart className="size-9 text-muted-foreground/40" />
            <p className="font-semibold text-sm">سلة المرتجعات فارغة</p>
            <p className="text-xs max-w-sm">
              استخدم حقل البحث الموحد أعلاه للبحث اليدوي بالاسم أو مسح الباركود
              مباشرة لإدراج الأصناف في السلة
            </p>
          </div>
        ) : (
          <div className="border rounded-xl overflow-hidden shadow-2xs">
            <div className="max-h-[460px] overflow-y-auto overflow-x-auto">
              <table className="w-full text-xs text-right">
                <thead className="sticky top-0 bg-muted/95 backdrop-blur z-10 text-muted-foreground font-semibold border-b shadow-2xs">
                  <tr>
                    <th className="p-2.5">الصنف</th>
                    <th className="p-2.5 text-center w-36">الكمية</th>
                    <th className="p-2.5 w-36">سعر الإرجاع (د.ع)</th>
                    <th className="p-2.5 w-28 text-left">الإجمالي</th>
                    <th className="p-2.5 w-12 text-center">حذف</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {salesCart.map((item, idx) => {
                    const subtotal =
                      item.quantity * moneyInput(item.unitPrice).toNumber();
                    const isRecentlyAdded = item.id === lastAddedId;
                    return (
                      <tr
                        key={item.id}
                        className={cn(
                          "transition-colors duration-700",
                          isRecentlyAdded
                            ? "bg-emerald-500/20 dark:bg-emerald-500/25 font-medium"
                            : "hover:bg-muted/20",
                        )}
                      >
                        <td className="p-2.5">
                          <div className="font-bold text-foreground flex items-center gap-1.5 flex-wrap">
                            <span>{item.productName}</span>
                            {item.isBundle && (
                              <Badge
                                variant="secondary"
                                className="text-[9px] px-1 py-0 bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300 border-blue-300"
                              >
                                بكج
                              </Badge>
                            )}
                            {item.unit &&
                              item.conversionFactor &&
                              item.conversionFactor > 1 && (
                                <span className="text-[10px] font-normal px-1.5 py-0.5 rounded bg-muted text-muted-foreground border">
                                  {item.unit} ({item.conversionFactor} قطعة)
                                </span>
                              )}
                          </div>
                          <div className="flex items-center gap-2 flex-wrap mt-0.5">
                            {item.barcode && (
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {item.barcode}
                              </span>
                            )}
                            {item.maxAllowedQuantity != null && (
                              <span className="text-[10px] text-muted-foreground font-mono">
                                (المتبقي بالفاتورة:{" "}
                                {formatQuantity(item.maxAllowedQuantity)})
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="p-2.5">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setSalesCart((prev) =>
                                  prev.map((it, i) =>
                                    i === idx
                                      ? {
                                          ...it,
                                          quantity: Math.max(
                                            1,
                                            it.quantity - 1,
                                          ),
                                        }
                                      : it,
                                  ),
                                );
                              }}
                              className="size-7 rounded border flex items-center justify-center hover:bg-muted text-muted-foreground"
                            >
                              <Minus className="size-3" />
                            </button>
                            <Input
                              type="number"
                              min={1}
                              max={item.maxAllowedQuantity}
                              value={item.quantity}
                              onChange={(e) => {
                                let q = Math.max(
                                  1,
                                  parseInt(e.target.value, 10) || 1,
                                );
                                if (
                                  item.maxAllowedQuantity != null &&
                                  q > item.maxAllowedQuantity
                                ) {
                                  q = item.maxAllowedQuantity;
                                  notify.warn(
                                    `الحد الأقصى المتاح للإرجاع من الفاتورة هو ${formatQuantity(item.maxAllowedQuantity)})`,
                                  );
                                }
                                setSalesCart((prev) =>
                                  prev.map((it, i) =>
                                    i === idx ? { ...it, quantity: q } : it,
                                  ),
                                );
                              }}
                              className="h-7 w-14 text-center text-xs font-bold p-0"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                if (
                                  item.maxAllowedQuantity != null &&
                                  item.quantity >= item.maxAllowedQuantity
                                ) {
                                  notify.warn(
                                    `لا يمكن تجاوز الكمية المتبقية في الفاتورة (${formatQuantity(item.maxAllowedQuantity)})`,
                                  );
                                  return;
                                }
                                setSalesCart((prev) =>
                                  prev.map((it, i) =>
                                    i === idx
                                      ? { ...it, quantity: it.quantity + 1 }
                                      : it,
                                  ),
                                );
                              }}
                              disabled={
                                item.maxAllowedQuantity != null &&
                                item.quantity >= item.maxAllowedQuantity
                              }
                              className="size-7 rounded border flex items-center justify-center hover:bg-muted text-muted-foreground disabled:opacity-40"
                            >
                              <Plus className="size-3" />
                            </button>
                          </div>
                        </td>
                        <td className="p-2.5">
                          <MoneyInput
                            value={item.unitPrice}
                            onChange={(p) => {
                              if (
                                item.originalUnitPrice &&
                                Number(p) > Number(item.originalUnitPrice)
                              ) {
                                notify.warn(
                                  `لا يمكن رفع سعر الإرجاع عن سعر البيع في الفاتورة (${fmt(item.originalUnitPrice)} د.ع)`,
                                );
                                p = item.originalUnitPrice;
                              }
                              setSalesCart((prev) =>
                                prev.map((it, i) =>
                                  i === idx ? { ...it, unitPrice: p } : it,
                                ),
                              );
                            }}
                            className="h-7 text-xs font-mono"
                            ariaLabel="سعر الوحدة"
                          />
                          {item.originalUnitPrice && (
                            <div className="text-[9px] text-muted-foreground font-mono mt-0.5">
                              سعر الفاتورة: {fmt(item.originalUnitPrice)}
                            </div>
                          )}
                        </td>
                        <td className="p-2.5 text-left font-mono font-bold">
                          {fmt(String(subtotal))}
                        </td>
                        <td className="p-2.5 text-center">
                          <button
                            type="button"
                            onClick={() => {
                              setSalesCart((prev) =>
                                prev.filter((_, i) => i !== idx),
                              );
                            }}
                            className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="p-2.5 bg-muted/30 border-t flex items-center justify-between text-xs">
              <button
                type="button"
                onClick={() => setSalesCart([])}
                className="text-muted-foreground hover:text-destructive text-[11px]"
              >
                تفريغ السلة
              </button>
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground">
                  القطع:{" "}
                  <strong className="text-foreground">
                    {salesTotalPieces}
                  </strong>
                </span>
                <span>
                  المجموع:{" "}
                  <strong className="text-emerald-700 dark:text-emerald-400 font-mono font-bold text-sm">
                    {fmt(String(salesTotal))} د.ع
                  </strong>
                </span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
