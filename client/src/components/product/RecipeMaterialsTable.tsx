import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatIqd, moneyInput, round2 } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { RecipeController } from "./useProductRecipe";
type Props = Pick<
  RecipeController,
  | "can"
  | "currentRecipe"
  | "isEditing"
  | "formLines"
  | "stockData"
  | "stockCheckQ"
  | "handleRemoveLine"
  | "handleLineQtyChange"
>;
export function RecipeMaterialsTable({
  can,
  currentRecipe,
  isEditing,
  formLines,
  stockData,
  stockCheckQ,
  handleRemoveLine,
  handleLineQtyChange,
}: Props) {
  return (
    <>
      {/* جدول مكونات الوصفة */}
      <div className="rounded-lg border overflow-hidden max-h-[520px] overflow-y-auto">
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-start border-collapse">
            <thead className="bg-muted/40 text-muted-foreground border-b text-[11px]">
              <tr>
                <th className="py-2 px-3 text-start font-medium">#</th>
                <th className="py-2 px-3 text-start font-medium">
                  المادة الخام / المكوّن
                </th>
                <th className="py-2 px-3 text-start font-medium">
                  الرمز (SKU)
                </th>
                <th className="py-2 px-3 text-start font-medium">الوحدة</th>
                <th className="py-2 px-3 text-center font-medium">
                  الكمية المطلوبة
                </th>
                <th className="py-2 px-3 text-center font-medium">
                  المتوفر في الفرع
                </th>
                <th className="py-2 px-3 text-end font-medium">
                  تكلفة الوحدة (د.ع)
                </th>
                <th className="py-2 px-3 text-end font-medium">
                  إجمالي البند (د.ع)
                </th>
                {isEditing && (
                  <th className="py-2 px-3 text-center font-medium w-16">
                    إجراء
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {(isEditing ? formLines : currentRecipe?.lines || []).length ===
              0 ? (
                <tr>
                  <td
                    colSpan={isEditing ? 9 : 8}
                    className="py-6 text-center text-muted-foreground text-xs"
                  >
                    لا توجد مواد مضافة في هذه الوصفة حتى الآن
                  </td>
                </tr>
              ) : (
                (isEditing ? formLines : currentRecipe?.lines || []).map(
                  (line, idx) => {
                    const lineQty = moneyInput(line.qtyPerOutputBase);
                    const lineCost = round2(
                      lineQty.mul(moneyInput(line.inputCostPrice)),
                    );
                    const compStock = stockData?.components.find(
                      (c) => c.variantId === line.inputVariantId,
                    );

                    return (
                      <tr
                        key={`${line.inputVariantId}-${idx}`}
                        className="hover:bg-muted/20"
                      >
                        <td className="py-2.5 px-3 text-muted-foreground text-[11px]">
                          {idx + 1}
                        </td>
                        <td className="py-2.5 px-3 font-medium text-foreground">
                          {line.inputProductName ||
                            `مادة خام (#${line.inputVariantId})`}
                          {line.notes && (
                            <span className="block text-[10px] text-muted-foreground mt-0.5">
                              {line.notes}
                            </span>
                          )}
                        </td>
                        <td
                          className="py-2.5 px-3 text-muted-foreground font-mono"
                          dir="ltr"
                        >
                          {line.inputSku || "-"}
                        </td>
                        <td className="py-2.5 px-3 text-muted-foreground">
                          {"unitName" in line && line.unitName
                            ? line.unitName
                            : ("units" in line &&
                                line.units?.find((u) => u.isBaseUnit)
                                  ?.unitName) ||
                              "وحدة"}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          {isEditing ? (
                            <Input
                              type="number"
                              step="0.0001"
                              min="0.0001"
                              value={line.qtyPerOutputBase}
                              onChange={(e) =>
                                handleLineQtyChange(idx, e.target.value)
                              }
                              className="h-7 w-24 mx-auto text-center text-xs font-mono"
                              dir="ltr"
                            />
                          ) : (
                            <span className="font-bold font-mono" dir="ltr">
                              {line.qtyPerOutputBase}
                            </span>
                          )}
                        </td>
                        {/* عمود المتوفر في الفرع */}
                        <td className="py-2.5 px-3 text-center">
                          {compStock ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px] font-mono",
                                compStock.available > 0
                                  ? compStock.isLimiting
                                    ? "border-amber-500/40 text-amber-700 bg-amber-50/80"
                                    : "border-emerald-500/40 text-emerald-700 bg-emerald-50/80"
                                  : "border-destructive/40 text-destructive bg-destructive/10",
                              )}
                            >
                              {compStock.available > 0
                                ? `متوفر: ${compStock.available}`
                                : "غير متوفر"}
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-[10px] font-mono text-muted-foreground border-border bg-muted/40"
                            >
                              {!can("production.recipes.checkStockAvailability")
                                ? "غير مفوض"
                                : stockCheckQ.isError
                                  ? "تعذر الفحص"
                                  : stockCheckQ.isFetching
                                    ? "جارٍ الفحص"
                                    : !stockData
                                      ? "حدد الفرع"
                                      : "غير مسجل"}
                            </Badge>
                          )}
                        </td>
                        <td
                          className="py-2.5 px-3 text-end font-mono text-muted-foreground"
                          dir="ltr"
                        >
                          {formatIqd(line.inputCostPrice)}
                        </td>
                        <td
                          className="py-2.5 px-3 text-end font-bold font-mono text-foreground"
                          dir="ltr"
                        >
                          {formatIqd(lineCost.toString())}
                        </td>
                        {isEditing && (
                          <td className="py-2.5 px-3 text-center">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRemoveLine(idx)}
                              className="size-7 p-0 text-destructive hover:bg-destructive/10"
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </td>
                        )}
                      </tr>
                    );
                  },
                )
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
