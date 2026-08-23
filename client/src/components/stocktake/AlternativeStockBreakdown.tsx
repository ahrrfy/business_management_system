// توزيع مخزون البدائل — مكوّنٌ مشترك: بطاقةُ منتجٍ تعرض الإجماليّ (مجموع الترميزات) وحصّة كل ترميز.
// يستهلكه تقرير Stocktakes.tsx وحوار Products.tsx (نفس العرض في المكانين).
import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fmtInt } from "@/lib/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown, Boxes } from "lucide-react";

type ProductBreakdown = RouterOutputs["stocktakes"]["alternativeStockBreakdown"][number];

/** اسمُ العرض للترميز: الأصل ⇐ «الأصل»، والبديل ⇐ اسم ماركته (أو الـSKU إن غاب). */
function variantLabel(v: ProductBreakdown["variants"][number]): string {
  if (v.variantKind === "ALTERNATIVE") return v.variantName?.trim() || v.sku;
  return v.variantName?.trim() || "الأصل";
}

/** بطاقة منتجٍ واحد: الإجماليّ + جدول حصص الترميزات (كمية + شريط نسبة + ٪). */
export function AlternativeStockCard({ product }: { product: ProductBreakdown }) {
  const baseUnit = product.variants.find((v) => v.baseUnit)?.baseUnit ?? "وحدة";
  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b p-3">
        <p className="min-w-0 truncate text-sm font-bold">{product.productName}</p>
        <p className="shrink-0 text-sm">
          <span className="text-muted-foreground">الإجماليّ: </span>
          <span className="font-bold tabular-nums" dir="ltr">
            {fmtInt(product.totalBase)}
          </span>{" "}
          <span className="text-xs text-muted-foreground">{baseUnit}</span>
        </p>
      </div>
      <div className="divide-y">
        {product.variants.map((v) => (
          <div key={v.variantId} className="flex items-center gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold">{variantLabel(v)}</span>
                {v.variantKind === "ALTERNATIVE" && (
                  <span className="shrink-0 rounded-md bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 dark:bg-slate-600 dark:text-slate-100">
                    بديل
                  </span>
                )}
              </div>
              <p className="font-mono text-[11px] text-muted-foreground" dir="ltr">
                {v.sku}
              </p>
            </div>
            <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary/70"
                style={{ width: `${Math.max(0, Math.min(100, v.sharePct))}%` }}
              />
            </div>
            <div className="w-24 shrink-0 text-start">
              <span className="text-sm font-bold tabular-nums" dir="ltr">
                {fmtInt(v.quantityBase)}
              </span>
              <span className="ms-1 text-xs text-muted-foreground tabular-nums">
                ({v.sharePct.toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 1 })}٪)
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────── تقرير شامل: كل المنتجات ذات البدائل (مدير) ─────────── */

export function AlternativeStockReportPanel() {
  const [open, setOpen] = useState(false);
  const q = trpc.stocktakes.alternativeStockBreakdown.useQuery(undefined, { enabled: open });
  const products = q.data ?? [];
  return (
    <Card>
      <CardHeader className="cursor-pointer p-4" onClick={() => setOpen((v) => !v)}>
        <CardTitle className="flex items-center justify-between text-base">
          <span className="inline-flex items-center gap-2">
            <Boxes aria-hidden className="size-4" /> توزيع مخزون البدائل
            {open && products.length > 0 && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                {products.length} منتجاً
              </span>
            )}
          </span>
          <ChevronDown
            aria-hidden
            className={`size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3 p-4 pt-0">
          <p className="text-xs text-muted-foreground">
            لكلّ منتجٍ له بدائل: الإجماليّ = مجموع مخزون كل ترميزاته (الأصل + البدائل)، وحصّة كلٍّ منها.
            المخزون بوحدة الأساس عبر كل الفروع (أو فرعك إن كنت مقيَّداً به).
          </p>
          {q.isLoading && (
            <p className="py-4 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>
          )}
          {!q.isLoading && products.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              لا منتجات لها بدائل بعد — افصل بديلاً أولاً ليظهر توزيع مخزونه.
            </p>
          )}
          {products.map((p) => (
            <AlternativeStockCard key={p.productId} product={p} />
          ))}
        </CardContent>
      )}
    </Card>
  );
}
