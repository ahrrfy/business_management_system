import { AlertCircle, AlertTriangle, Gauge, TrendingUp } from "lucide-react";
import { formatIqd } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { RecipeController } from "./useProductRecipe";
import type { RecipeCosts } from "./useRecipeCosts";
type Props = Pick<
  RecipeController,
  | "can"
  | "currentBranchId"
  | "setPriceTierMode"
  | "activeLinesForCheck"
  | "stockCheckQ"
  | "stockData"
> &
  Pick<RecipeCosts, "calculatedCosts" | "profitability">;
export function RecipeSummary({
  can,
  currentBranchId,
  setPriceTierMode,
  activeLinesForCheck,
  stockCheckQ,
  stockData,
  calculatedCosts,
  profitability,
}: Props) {
  return (
    <>
      {/* بطاقات الإحصاء والتكلفة المحسوبة وهامش الربحية والطاقة الإنتاجية */}
      <div className="grid grid-cols-1 min-[420px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-2.5">
        <div className="p-3 rounded-lg border bg-card text-card-foreground">
          <span className="text-[11px] text-muted-foreground block font-medium">
            تكلفة المواد الخام
          </span>
          <span
            className="text-sm sm:text-base font-bold text-foreground mt-0.5 block"
            dir="ltr"
          >
            {formatIqd(calculatedCosts.materialsTotal.toString())}
          </span>
          <span className="text-[10px] text-muted-foreground">
            لكل وحدة ناتج أساسية
          </span>
        </div>

        <div className="p-3 rounded-lg border bg-card text-card-foreground">
          <span className="text-[11px] text-muted-foreground block font-medium">
            أجور العمالة المباشرة
          </span>
          <span
            className="text-sm sm:text-base font-bold text-foreground mt-0.5 block"
            dir="ltr"
          >
            {formatIqd(calculatedCosts.labor.toString())}
          </span>
          <span className="text-[10px] text-muted-foreground">
            لكل وحدة ناتج
          </span>
        </div>

        <div className="p-3 rounded-lg border bg-card text-card-foreground">
          <span className="text-[11px] text-muted-foreground block font-medium">
            نسبة الهدر المعياري
          </span>
          <span
            className="text-sm sm:text-base font-bold text-foreground mt-0.5 block"
            dir="ltr"
          >
            {calculatedCosts.wastePct.mul(100).toFixed(1)}%
          </span>
          <span className="text-[10px] text-muted-foreground">
            تُمتص في كلفة الوحدة
          </span>
        </div>

        <div className="p-3 rounded-lg border bg-primary/5 border-primary/20 text-primary">
          <span className="text-[11px] text-primary/80 block font-medium">
            كلفة الوحدة المعيارية
          </span>
          <span
            className="text-sm sm:text-base font-bold text-primary mt-0.5 block"
            dir="ltr"
          >
            {formatIqd(calculatedCosts.totalUnitCost.toString())}
          </span>
          <span className="text-[10px] text-primary/70">
            المواد + العمالة + الهدر
          </span>
        </div>

        {/* بطاقة الطاقة الإنتاجية الفورية */}
        <div
          className={cn(
            "p-3 rounded-lg border",
            stockCheckQ.isError
              ? "bg-amber-50/60 border-amber-500/30 text-amber-950 dark:bg-amber-950/20 dark:text-amber-300"
              : !stockCheckQ.isError && stockData && stockData.maxCapacity > 0
                ? "bg-emerald-50/60 border-emerald-500/30 text-emerald-950 dark:bg-emerald-950/20 dark:text-emerald-300"
                : "bg-muted/30 border-border text-foreground",
          )}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground block font-medium">
              الطاقة الإنتاجية الفورية
            </span>
            <Gauge className="size-3.5 text-muted-foreground" />
          </div>
          <span
            className="text-sm sm:text-base font-bold mt-0.5 block"
            dir="ltr"
          >
            {activeLinesForCheck.length === 0
              ? "لا توجد مواد"
              : stockCheckQ.isError
                ? "تعذر الفحص"
                : !can("production.recipes.checkStockAvailability")
                  ? "غير مفوض"
                  : stockData
                    ? `${stockData.maxCapacity} وحدة`
                    : currentBranchId
                      ? "جارٍ الفحص..."
                      : "حدد الفرع"}
          </span>
          <span className="text-[10px] text-muted-foreground block truncate">
            {activeLinesForCheck.length === 0 ? (
              "أضف مواداً أولية للوصفة"
            ) : stockCheckQ.isError ? (
              <button
                type="button"
                onClick={() => void stockCheckQ.refetch()}
                className="text-amber-700 dark:text-amber-400 font-medium underline cursor-pointer"
              >
                فشل فحص الرصيد — انقر للإعادة
              </button>
            ) : !can("production.recipes.checkStockAvailability") ? (
              "غير مفوض لفحص أرصدة المواد"
            ) : !stockData ? (
              currentBranchId ? (
                "فحص أرصدة المستودع..."
              ) : (
                "اختر فرعاً لمعاينة الرصيد"
              )
            ) : stockData.limitingComponent ? (
              `العائق: ${stockData.limitingComponent}`
            ) : stockData.maxCapacity > 0 ? (
              "المواد متوفرة بالكامل"
            ) : (
              "لا يوجد رصيد كافٍ"
            )}
          </span>
        </div>

        {/* بطاقة هامش الربحية المتوقع */}
        <div
          className={cn(
            "p-3 rounded-lg border",
            profitability
              ? profitability.isLoss
                ? "bg-destructive/10 border-destructive/30 text-destructive"
                : profitability.isLowMargin
                  ? "bg-amber-50/60 border-amber-500/30 text-amber-900 dark:bg-amber-950/20 dark:text-amber-300"
                  : "bg-emerald-50/60 border-emerald-500/30 text-emerald-950 dark:bg-emerald-950/20 dark:text-emerald-300"
              : "bg-muted/30 border-border text-foreground",
          )}
        >
          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
              <span className="text-[11px] text-muted-foreground block font-medium truncate">
                هامش الربح{" "}
                {profitability?.priceTier === "WHOLESALE" ? "(جملة)" : "(مفرق)"}
              </span>
              {profitability?.hasBothTiers && (
                <button
                  type="button"
                  onClick={() =>
                    setPriceTierMode((prev) =>
                      prev === "RETAIL" ? "WHOLESALE" : "RETAIL",
                    )
                  }
                  className="text-[9px] px-1 py-0.5 rounded border border-primary/30 text-primary hover:bg-primary/10 transition-colors"
                  title="التبديل بين سعر المفرق وسعر الجملة"
                >
                  {profitability.priceTier === "RETAIL" ? "جملة" : "مفرق"}
                </button>
              )}
            </div>
            <TrendingUp className="size-3.5 text-muted-foreground shrink-0" />
          </div>
          <span
            className="text-sm sm:text-base font-bold mt-0.5 block"
            dir="ltr"
          >
            {profitability
              ? `${profitability.grossMarginPct.toFixed(1)}%`
              : "غير محدد"}
          </span>
          <span
            className="text-[10px] text-muted-foreground block truncate"
            dir="ltr"
          >
            {profitability
              ? `الربح: ${formatIqd(profitability.grossProfit.toString())}`
              : "لم يُسجل سعر بيع"}
          </span>
        </div>
      </div>

      {/* تنبيهات الذكاء التشغيلي والربحية */}
      {profitability?.isLoss && (
        <div className="p-3 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2.5 text-xs">
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <span className="font-bold block">
              تحذير تشغيلي: التكلفة المعيارية أعلى من سعر البيع!
            </span>
            <p className="leading-relaxed">
              تكلفة إنتاج الوحدة (
              {formatIqd(calculatedCosts.totalUnitCost.toString())}) تتجاوز سعر
              البيع المعياري ({formatIqd(profitability.sellingPrice.toString())}
              ) بعجز قدره{" "}
              {formatIqd(profitability.grossProfit.abs().toString())} للوحدة (
              {profitability.grossMarginPct.toFixed(1)}%). يُرجى مراجعة نسب
              الهدر وكميات المواد أو تعديل سعر البيع لتفادي الخسائر التشغيلية.
            </p>
          </div>
        </div>
      )}

      {profitability?.isLowMargin && !profitability?.isLoss && (
        <div className="p-3 rounded-lg border border-amber-500/40 bg-amber-50/70 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300 flex items-start gap-2.5 text-xs">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <span className="font-bold block">تنبيه: هامش ربح منخفض</span>
            <p className="leading-relaxed">
              هامش الربح الإجمالي المتوقع (
              {profitability.grossMarginPct.toFixed(1)}%) أقل من الحد الموصى به
              (15%). يُنصح بفحص أسعار شراء المواد الخام وأجور العمالة لتحسين
              الربحية.
            </p>
          </div>
        </div>
      )}

      {!stockCheckQ.isError &&
        stockData &&
        stockData.maxCapacity === 0 &&
        activeLinesForCheck.length > 0 && (
          <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-50/50 text-amber-800 dark:bg-amber-950/20 dark:text-amber-300 flex items-start gap-2.5 text-xs">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <span className="font-bold block">
                تنبيه مخزني: نقص في المواد الأولية في الفرع الحالي
              </span>
              <p className="leading-relaxed">
                رصيد بعض المواد الخام صفر في مخزون الفرع الحالي
                {stockData.limitingComponent
                  ? ` (${stockData.limitingComponent})`
                  : ""}
                ، ولن يكون بالإمكان بدء أوامر الإنتاج الفوري حتى تأمين النواقص.
              </p>
            </div>
          </div>
        )}
    </>
  );
}
