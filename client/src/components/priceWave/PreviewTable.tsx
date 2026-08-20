// جدول معاينة موجة التسعير — «هل هذا ما تريد فعلاً؟».
//
// ثلاثة أشياء تميّزه عمّا كان:
//   ١) **الاستثناء السطريّ**: الموجة لم تعد «كل شيء أو لا شيء». الاستثناء يُرسَل مُعرِّفاتٍ فقط
//      (وحدة × فئة سعر) لا أسعاراً ⇒ الخادم يبقى هو من يحسب (ثابت W1).
//   ٢) **الصفوف الساقطة تُعرَض بأسبابها**: كان `SET_MARGIN` يتخطّى الأصناف بلا تكلفة (وكل بكج،
//      لأنّ عموده صفرٌ بحكم التصميم) **بصمت** — فيظنّ المدير أنّ عشرين بكجاً سُعِّرت وهي لم تُمَسّ.
//   ٣) **الهامش قبل/بعد** بتكلفة الوحدة الصحيحة (الأساس × معامل التحويل، والبكج من وصفته)،
//      فلا هامش ١٠٠٪ كاذب ولا حارس «تحت التكلفة» أعمى عن الدرزن والكرتون.
import { AlertTriangle, Package, Coins } from "lucide-react";
import {
  PRICE_WAVE_SKIP_LABELS,
  type PriceWaveSkipReason,
} from "@shared/priceWaveRule";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { priceTierLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";

export interface PreviewRow {
  productUnitId: number;
  productId: number;
  productName: string;
  sku: string;
  unitName: string;
  conversionFactor: string;
  priceTier: string;
  oldPrice: string;
  newPrice: string;
  unitCost: string | null;
  oldMarginPct: number | null;
  newMarginPct: number | null;
  belowCost: boolean;
  rounded: boolean;
  clampedMin: boolean;
  isBundle: boolean;
}

export interface SkippedRow {
  productUnitId: number;
  productName: string;
  sku: string;
  unitName: string;
  priceTier: string;
  oldPrice: string;
  reason: PriceWaveSkipReason;
}

const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
function money(v: string | number | null): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? nf.format(n) : "—";
}
function pct(v: number | null): string {
  return v == null ? "—" : `${v}%`;
}

export function rowKey(r: {
  productUnitId: number;
  priceTier: string;
}): string {
  return `${r.productUnitId}:${r.priceTier}`;
}

const th = "px-3 py-2 text-right font-medium whitespace-nowrap";
const td = "px-3 py-2 align-middle";

export function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "neg" | "warn" | "pos";
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2",
        tone === "neg" && "border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)]",
        tone === "warn" &&
          "border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)]",
        tone === "pos" && "border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)]",
      )}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums" dir="ltr">
        {value}
      </div>
    </div>
  );
}

export function PreviewTable({
  rows,
  excluded,
  onToggle,
  onSetMany,
}: {
  rows: PreviewRow[];
  excluded: Set<string>;
  onToggle: (key: string) => void;
  onSetMany: (keys: string[], on: boolean) => void;
}) {
  const allKeys = rows.map(rowKey);
  const allExcluded =
    allKeys.length > 0 && allKeys.every((k) => excluded.has(k));

  return (
    <div className="overflow-x-auto rounded-md border max-h-[28rem] overflow-y-auto">
      <table className="w-full min-w-[62rem] text-sm">
        <thead className="sticky top-0 z-[2] bg-muted/95 text-xs text-muted-foreground backdrop-blur">
          <tr>
            <th className={cn(th, "w-10")}>
              <input
                type="checkbox"
                aria-label={allExcluded ? "أعِد كل الصفوف" : "استثنِ كل الصفوف"}
                checked={allExcluded}
                onChange={(e) => onSetMany(allKeys, e.target.checked)}
                title="استثناء الكل / إعادة الكل"
              />
            </th>
            <th className={th}>المنتج</th>
            <th className={th}>SKU</th>
            <th className={th}>الوحدة</th>
            <th className={th}>فئة السعر</th>
            <th className={th}>تكلفة الوحدة</th>
            <th className={th}>السعر الحالي</th>
            <th className={th}>السعر الجديد</th>
            <th className={th}>الفرق</th>
            <th className={th}>الهامش قبل ← بعد</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const key = rowKey(r);
            const isOut = excluded.has(key);
            const diff = Number(r.newPrice) - Number(r.oldPrice);
            return (
              <tr
                key={key}
                className={cn(
                  "border-t",
                  r.belowCost && !isOut && "bg-[var(--sem-neg-bg)]",
                  isOut && "opacity-45",
                )}
              >
                <td className={td}>
                  <input
                    type="checkbox"
                    checked={isOut}
                    onChange={() => onToggle(key)}
                    aria-label={
                      isOut
                        ? `أعِد ${r.productName}`
                        : `استثنِ ${r.productName}`
                    }
                    title={
                      isOut
                        ? "معاد — سيتغيّر سعره"
                        : "استثنِ هذا الصفّ من الموجة"
                    }
                  />
                </td>
                <td className={td}>
                  <span className={cn(isOut && "line-through")}>
                    {r.productName}
                  </span>
                  {r.isBundle && (
                    <Badge variant="outline" className="mr-1 text-[10px]">
                      <Package aria-hidden className="size-3" />
                      بكج
                    </Badge>
                  )}
                  {r.belowCost && (
                    <Badge variant="destructive" className="mr-1 text-[10px]">
                      تحت التكلفة
                    </Badge>
                  )}
                </td>
                <td className={cn(td, "text-xs text-muted-foreground")}>
                  {r.sku}
                </td>
                <td className={td}>
                  {r.unitName}
                  {Number(r.conversionFactor) > 1 && (
                    <span
                      className="mr-1 text-xs text-muted-foreground"
                      dir="ltr"
                    >
                      ×{nf.format(Number(r.conversionFactor))}
                    </span>
                  )}
                </td>
                <td className={td}>{priceTierLabel(r.priceTier)}</td>
                <td
                  className={cn(td, "tabular-nums text-muted-foreground")}
                  dir="ltr"
                >
                  {money(r.unitCost)}
                </td>
                <td className={cn(td, "tabular-nums")} dir="ltr">
                  {money(r.oldPrice)}
                </td>
                <td className={cn(td, "font-semibold tabular-nums")} dir="ltr">
                  {money(r.newPrice)}
                  {r.rounded && (
                    <Coins
                      aria-hidden
                      className="mr-1 inline size-3 text-muted-foreground"
                    />
                  )}
                </td>
                <td
                  className={cn(
                    td,
                    "tabular-nums",
                    diff >= 0
                      ? "text-[var(--sem-pos)]"
                      : "text-[var(--sem-neg)]",
                  )}
                  dir="ltr"
                >
                  {diff >= 0 ? "+" : ""}
                  {money(diff)}
                </td>
                <td className={cn(td, "tabular-nums text-xs")} dir="ltr">
                  {pct(r.oldMarginPct)} <span aria-hidden>←</span>{" "}
                  <b>{pct(r.newMarginPct)}</b>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * الصفوف الساقطة — بديل التخطّي الصامت. تُعرَض مطويّةً كي لا تزاحم الجدول الأساسيّ،
 * لكنّ عدّها ظاهرٌ دائماً في العنوان: «سقطت ٢٠ ولن تتغيّر» أوضح ألف مرّة من اختفائها.
 */
export function SkippedPanel({
  skipped,
  open,
  onToggle,
}: {
  skipped: SkippedRow[];
  open: boolean;
  onToggle: () => void;
}) {
  if (!skipped.length) return null;
  const byReason = new Map<PriceWaveSkipReason, number>();
  for (const s of skipped)
    byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);

  return (
    <div className="rounded-md border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <AlertTriangle
            aria-hidden
            className="size-4 shrink-0 text-[var(--sem-warn)]"
          />
          <span>
            <b>{skipped.length}</b> صفّاً لن يتغيّر —{" "}
            {Array.from(byReason.entries())
              .map(([reason, n]) => `${n} ${PRICE_WAVE_SKIP_LABELS[reason]}`)
              .join(" · ")}
          </span>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onToggle}>
          {open ? "إخفاء التفاصيل" : "عرض التفاصيل"}
        </Button>
      </div>
      {open && (
        <div className="mt-3 max-h-56 overflow-auto rounded-md border bg-background">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="sticky top-0 bg-muted/95 text-xs text-muted-foreground backdrop-blur">
              <tr>
                <th className={th}>المنتج</th>
                <th className={th}>الوحدة</th>
                <th className={th}>فئة السعر</th>
                <th className={th}>السعر الحالي</th>
                <th className={th}>السبب</th>
              </tr>
            </thead>
            <tbody>
              {skipped.map((s) => (
                <tr
                  key={`${s.productUnitId}:${s.priceTier}`}
                  className="border-t"
                >
                  <td className={td}>{s.productName}</td>
                  <td className={td}>{s.unitName}</td>
                  <td className={td}>{priceTierLabel(s.priceTier)}</td>
                  <td className={cn(td, "tabular-nums")} dir="ltr">
                    {money(s.oldPrice)}
                  </td>
                  <td className={cn(td, "text-xs text-muted-foreground")}>
                    {PRICE_WAVE_SKIP_LABELS[s.reason]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
