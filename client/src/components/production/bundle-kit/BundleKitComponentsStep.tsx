import * as React from "react";
import { AlertTriangle, Copy, Layers, Plus, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { digitsArabicToLatin } from "@shared/numberNormalize";
import type { ComponentRequirementDto } from "@shared/bundleProductionTypes";

export interface BundleKitComponentBatch {
  variantId: number;
  recipeId: number | null;
  batchQty: number;
  scrapQty: number;
  laborPerUnit: string;
  selected: boolean;
}

interface BundleKitComponentsStepProps {
  components: ComponentRequirementDto[];
  batches: BundleKitComponentBatch[];
  onBatchChange: (variantId: number, update: Partial<BundleKitComponentBatch>) => void;
  onToggleAll: (selected: boolean) => void;
  onResetToSuggested?: () => void;
  onAddRecipe?: (component: ComponentRequirementDto) => void;
}

export function BundleKitComponentsStep({
  components,
  batches,
  onBatchChange,
  onToggleAll,
  onResetToSuggested,
  onAddRecipe,
}: BundleKitComponentsStepProps) {
  const batchMap = new Map<number, BundleKitComponentBatch>(
    batches.map((b) => [b.variantId, b]),
  );

  const manufacturedCount = components.filter((c) => c.isManufactured).length;
  const commercialShortages = components.filter(
    (c) => !c.isManufactured && c.shortageQty > 0,
  );

  const allManufacturedSelected =
    manufacturedCount > 0 &&
    components
      .filter((c) => c.isManufactured)
      .every((c) => batchMap.get(c.variantId)?.selected);

  return (
    <div className="space-y-4" dir="rtl">
      {/* تنبيه السلع التجارية الناقصة */}
      {commercialShortages.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]">
          <AlertTriangle aria-hidden="true" className="size-5 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold">تنبيه: سلع تجارية غير مصنعة بحاجة لتوريد</p>
            <p className="text-xs text-muted-foreground">
              البكج يحتوي على مكونات مشتراة جاهزة بدون وصفة تصنيع تعاني من نقص في رصيد الفرع:{" "}
              {commercialShortages.map((s) => `${s.productName} (عجز: ${s.shortageQty})`).join("، ")}.
              يمكنك إنتاج المكونات المصنعة الآن، وسيتطلب اكتمال بيع وتجهيز البكج إصدار أمر شراء لتلك السلع.
            </p>
          </div>
        </div>
      )}

      {/* شريط الإحصائيات السريعة والتحكم الجماعي */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3 text-xs">
        <div className="flex items-center gap-4">
          <span className="text-muted-foreground">
            إجمالي المكونات: <strong className="text-foreground">{components.length}</strong>
          </span>
          <span className="text-muted-foreground">
            المكونات المصنعة:{" "}
            <strong className="text-[var(--sem-pos)]">{manufacturedCount}</strong>
          </span>
          <span className="text-muted-foreground">
            السلع التجارية:{" "}
            <strong className="text-foreground">{components.length - manufacturedCount}</strong>
          </span>
        </div>

        {manufacturedCount > 0 && (
          <div className="flex items-center gap-3">
            {onResetToSuggested && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onResetToSuggested}
                className="h-7 text-xs px-2.5 gap-1.5 text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="size-3" aria-hidden="true" />
                استعادة المقترحات
              </Button>
            )}
            <div className="flex items-center gap-2">
              <Checkbox
                id="toggle-all-mfg"
                aria-label="تحديد كافة المكونات المصنعة"
                checked={allManufacturedSelected}
                onCheckedChange={(checked) => onToggleAll(Boolean(checked))}
              />
              <label
                htmlFor="toggle-all-mfg"
                className="cursor-pointer font-medium select-none"
              >
                تحديد كافة المكونات المصنعة
              </label>
            </div>
          </div>
        )}
      </div>

      {/* جدول المكونات */}
      <div className="overflow-x-auto rounded-lg border border-border bg-card/40">
        <table className="w-full text-xs text-start min-w-[980px] border-collapse">
          <thead className="bg-muted/70 text-muted-foreground">
            <tr>
              <th scope="col" className="p-2.5 text-center w-12 whitespace-nowrap select-none">تضمين</th>
              <th scope="col" className="p-2.5 text-start font-medium min-w-[240px] whitespace-nowrap select-none">المكون والنوع</th>
              <th scope="col" className="p-2.5 text-center font-medium min-w-[75px] whitespace-nowrap select-none">لكل طقم</th>
              <th scope="col" className="p-2.5 text-center font-medium min-w-[85px] whitespace-nowrap select-none">المطلوب كلياً</th>
              <th scope="col" className="p-2.5 text-center font-medium min-w-[85px] whitespace-nowrap select-none">المتاح بالفرع</th>
              <th scope="col" className="p-2.5 text-center font-medium min-w-[85px] whitespace-nowrap select-none">العجز الصافي</th>
              <th scope="col" className="p-2.5 text-center font-medium min-w-[100px] whitespace-nowrap select-none">مضاعف الدفعة</th>
              <th scope="col" className="p-2.5 text-center font-medium min-w-[110px] w-28 whitespace-nowrap select-none">كمية الإنتاج</th>
              <th scope="col" className="p-2.5 text-center font-medium min-w-[85px] w-20 whitespace-nowrap select-none">تالف متوقع</th>
              <th scope="col" className="p-2.5 text-center font-medium min-w-[105px] w-24 whitespace-nowrap select-none">أجور عمالة</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {components.map((c) => {
              const batch = batchMap.get(c.variantId);
              const isSelected = batch?.selected ?? false;

              return (
                <tr
                  key={c.variantId}
                  className={`transition-colors ${
                    !c.isManufactured
                      ? "bg-muted/15"
                      : isSelected
                        ? "bg-primary/5"
                        : "hover:bg-muted/30"
                  }`}
                >
                  <td className="p-2 text-center whitespace-nowrap">
                    {c.isManufactured ? (
                      <Checkbox
                        checked={isSelected}
                        aria-label={`تضمين ${c.productName} في أمر تصنيع البكج`}
                        onCheckedChange={(checked) => {
                          const isNowSelected = Boolean(checked);
                          const currentBatch = batchMap.get(c.variantId);
                          const currentQty = currentBatch?.batchQty ?? 0;
                          const fallbackQty =
                            c.suggestedBatchQty > 0
                              ? c.suggestedBatchQty
                              : c.totalRequiredQty > 0
                                ? c.totalRequiredQty
                                : (c.requiredBatchMultiple || 1);
                          onBatchChange(c.variantId, {
                            selected: isNowSelected,
                            batchQty: isNowSelected && currentQty <= 0 ? fallbackQty : currentQty,
                          });
                        }}
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>

                  <td className="p-2.5">
                    <div className="font-semibold text-foreground leading-snug">{c.productName}</div>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      <span className="font-mono text-[11px] text-muted-foreground" dir="ltr">
                        {c.sku}
                      </span>
                      {c.isManufactured ? (
                        <Badge
                          variant="secondary"
                          className="text-[10px] py-0 px-1.5 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-none whitespace-nowrap shrink-0"
                        >
                          <Layers aria-hidden="true" className="size-3 me-1" />
                          {c.recipeName ?? "مصنّع"}
                        </Badge>
                      ) : (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Badge
                            variant="outline"
                            className="text-[10px] py-0 px-1.5 text-muted-foreground whitespace-nowrap shrink-0"
                          >
                            سلعة تجارية
                          </Badge>
                          {onAddRecipe && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => onAddRecipe(c)}
                              className="h-5 text-[10px] px-2 py-0 border-dashed border-primary/50 text-primary hover:bg-primary/10 hover:border-primary gap-1 font-medium whitespace-nowrap shrink-0"
                              title="إضافة أو نسخ وصفة إنتاج لتحويل هذا الصنف إلى مكوّن مصنّع"
                              aria-label={`تحويل ${c.productName} لمصنّع أو نسخ وصفة`}
                            >
                              <Copy aria-hidden="true" className="size-2.5" />
                              <span>تحويل لمصنّع / نسخ وصفة</span>
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </td>

                  <td className="p-2.5 text-center font-mono font-medium whitespace-nowrap" dir="ltr">
                    {c.componentBaseQuantity}
                  </td>

                  <td className="p-2.5 text-center font-mono font-medium whitespace-nowrap" dir="ltr">
                    {c.totalRequiredQty}
                  </td>

                  <td className="p-2.5 text-center font-mono whitespace-nowrap" dir="ltr">
                    <span
                      className={
                        c.onHandStock >= c.totalRequiredQty
                          ? "text-[var(--sem-pos)] font-semibold"
                          : "text-muted-foreground"
                      }
                    >
                      {c.onHandStock}
                    </span>
                  </td>

                  <td className="p-2.5 text-center font-mono whitespace-nowrap" dir="ltr">
                    {c.shortageQty > 0 ? (
                      <span className="text-[var(--sem-neg)] font-bold">
                        {c.shortageQty}
                      </span>
                    ) : (
                      <span className="text-[var(--sem-pos)]">0</span>
                    )}
                  </td>

                  <td className="p-2.5 text-center whitespace-nowrap">
                    {c.isManufactured ? (
                      <div className="space-y-0.5">
                        <span className="font-mono text-xs" dir="ltr">
                          {c.requiredBatchMultiple > 1
                            ? `مضاعف ${c.requiredBatchMultiple}`
                            : "1 (حر)"}
                        </span>
                        {c.surplusBufferQty > 0 && (
                          <div className="text-[10px] text-[var(--sem-info)] font-mono" dir="ltr">
                            فائض جبر: +{c.surplusBufferQty}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>

                  <td className="p-2 text-center whitespace-nowrap">
                    {c.isManufactured ? (
                      <div className="space-y-0.5">
                        <Input
                          type="number"
                          min="1"
                          dir="ltr"
                          lang="en-US"
                          step={c.requiredBatchMultiple || 1}
                          disabled={!isSelected}
                          aria-label={`كمية إنتاج ${c.productName}`}
                          className="h-8 text-center text-xs font-mono font-bold w-20 mx-auto"
                          value={batch ? (batch.batchQty === 0 ? "" : batch.batchQty) : c.suggestedBatchQty}
                          onChange={(e) => {
                            const raw = e.target.value;
                            if (raw === "") {
                              onBatchChange(c.variantId, { batchQty: 0 });
                              return;
                            }
                            const val = parseInt(digitsArabicToLatin(raw), 10);
                            onBatchChange(c.variantId, {
                              batchQty: Number.isFinite(val) ? Math.max(0, val) : 0,
                            });
                          }}
                        />
                        {c.requiredBatchMultiple > 1 && isSelected && (batch?.batchQty ?? 0) > 0 && (batch?.batchQty ?? 0) % c.requiredBatchMultiple !== 0 && (
                          <div className="text-[10px] text-[var(--sem-warn)] whitespace-nowrap">
                            مضاعف {c.requiredBatchMultiple}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-1">
                        <span className="text-muted-foreground text-xs whitespace-nowrap">شراء خارجي</span>
                        {onAddRecipe && (
                          <button
                            type="button"
                            onClick={() => onAddRecipe(c)}
                            className="text-[10px] text-primary hover:underline font-medium flex items-center gap-0.5 cursor-pointer whitespace-nowrap shrink-0"
                            title="إضافة وصفة وتصنيع الصنف"
                            aria-label={`إضافة وصفة وتصنيع ${c.productName}`}
                          >
                            <Plus aria-hidden="true" className="size-2.5" />
                            <span>+ إضافة وصفة</span>
                          </button>
                        )}
                      </div>
                    )}
                  </td>

                  <td className="p-2 text-center whitespace-nowrap">
                    {c.isManufactured ? (
                      <Input
                        type="number"
                        min="0"
                        dir="ltr"
                        lang="en-US"
                        disabled={!isSelected}
                        aria-label={`تالف متوقع لـ ${c.productName}`}
                        className="h-8 text-center text-xs font-mono w-16 mx-auto"
                        value={batch?.scrapQty ?? 0}
                        onChange={(e) => {
                          const val = parseInt(digitsArabicToLatin(e.target.value), 10);
                          onBatchChange(c.variantId, {
                            scrapQty: Number.isFinite(val) && val >= 0 ? val : 0,
                          });
                        }}
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>

                  <td className="p-2 text-center whitespace-nowrap">
                    {c.isManufactured ? (
                      <Input
                        type="text"
                        inputMode="decimal"
                        dir="ltr"
                        lang="en-US"
                        disabled={!isSelected}
                        aria-label={`أجور عمالة لـ ${c.productName}`}
                        className="h-8 text-center text-xs font-mono w-20 mx-auto"
                        value={batch?.laborPerUnit ?? c.laborPerUnit}
                        onChange={(e) => {
                          const val = digitsArabicToLatin(e.target.value).replace(/[^0-9.]/g, "");
                          onBatchChange(c.variantId, {
                            laborPerUnit: val,
                          });
                        }}
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
