/**
 * تلميحات الأسعار تحت اسم الصنف في جدول الفاتورة (عرضٌ فقط، بلا حالة ولا شبكة).
 *
 *  • `PurchaseInsightHints`: «آخر شراء/أرخص سابقاً/…» — **منقولةٌ كما هي** من `ProductTable`
 *    (كان ≈٣٠ سطراً مضمَّنةً في جدولٍ تجاوز سقف المكوّن) دون تغيير سلوك.
 *  • `SaleLastPriceHints`: آخر سعر بيعٍ لهذا العميل + مقارنته بالسعر المُدخَل (`@shared/priceAlerts`)
 *    وزرّ «استخدم» لاسترجاعه. إرشاديّ فقط — لا يمنع الحفظ.
 *
 * أيقونات `lucide-react` (لا إيموجي)، وألوان توكنز `--sem-*` (حارس `check:colors`)، وأرقام بـ`fmtNum`.
 */
import React from "react";
import { AlertTriangle, Check, FileText, Info, TrendingUp } from "lucide-react";
import { daysSince, evaluateSalePriceAlerts, pickReferenceSale, type PriceAlert, type SaleLineInsight } from "@shared/priceAlerts";
import { cn } from "@/lib/utils";
import { D } from "@/lib/money";
import { fmtNum } from "./totals";
import type { PurchasePriceInsight } from "./ProductTable";

/** «اليوم/أمس/قبل N يوم» بالعربيّة الصحيحة للعدد (٢ يومين، ٣-١٠ أيام، ١١+ يوماً). */
export function ageLabel(days: number | null): string {
  if (days == null) return "";
  if (days === 0) return "اليوم";
  if (days === 1) return "أمس";
  if (days === 2) return "قبل يومين";
  if (days <= 10) return `قبل ${days} أيام`;
  return `قبل ${days} يوماً`;
}

export function PurchaseInsightHints({
  insight,
  enteredPriceIqd,
}: {
  insight: PurchasePriceInsight;
  /** السعر المُدخَل مُحوَّلاً إلى الدينار (يحسبه الجدول بعملة الأمر وسعر التثبيت)؛ null = غير مقروء. */
  enteredPriceIqd: number | null;
}) {
  const lowestPriceIqd = Number(insight.lowestPurchase.price);
  const supplierLastPriceIqd = insight.selectedSupplierLastPurchase
    ? Number(insight.selectedSupplierLastPurchase.price)
    : null;
  const isAboveHistoricalLow = enteredPriceIqd != null && enteredPriceIqd > lowestPriceIqd;
  const isBelowHistoricalLow = enteredPriceIqd != null && enteredPriceIqd > 0 && enteredPriceIqd < lowestPriceIqd;
  return (
    <div className="mt-1 space-y-0.5 text-[10px] leading-4" dir="rtl">
      <div className="text-muted-foreground">
        آخر شراء: <span dir="ltr" className="font-bold tabular-nums">{fmtNum(insight.lastPurchase.price)}</span> د.ع
        <span> من {insight.lastPurchase.supplierName}</span>
      </div>
      {insight.selectedSupplierLastPurchase && (
        <div className="text-muted-foreground">
          آخر سعر من المورد الحالي: <span dir="ltr" className="font-bold tabular-nums">{fmtNum(insight.selectedSupplierLastPurchase.price)}</span> د.ع
        </div>
      )}
      {isAboveHistoricalLow && (
        <div className="flex items-center gap-1 font-semibold text-[var(--sem-warn)]">
          <AlertTriangle aria-hidden className="size-3 shrink-0" />
          الأرخص سابقاً: {insight.lowestPurchase.supplierName} بـ <span dir="ltr">{fmtNum(insight.lowestPurchase.price)}</span> د.ع
          <span>(فرق {fmtNum(enteredPriceIqd! - lowestPriceIqd)} د.ع)</span>
        </div>
      )}
      {isBelowHistoricalLow && (
        <div className="font-semibold text-[var(--sem-pos)]">
          سعر ممتاز: أقل من أدنى شراء سابق بـ <span dir="ltr">{fmtNum(lowestPriceIqd - enteredPriceIqd!)}</span> د.ع
        </div>
      )}
      {!isAboveHistoricalLow && supplierLastPriceIqd != null && enteredPriceIqd != null && enteredPriceIqd > supplierLastPriceIqd && (
        <div className="font-semibold text-[var(--sem-warn)]">
          أعلى من آخر سعر لهذا المورد بـ <span dir="ltr">{fmtNum(enteredPriceIqd - supplierLastPriceIqd)}</span> د.ع
        </div>
      )}
    </div>
  );
}

const SEVERITY_CLASS: Record<PriceAlert["severity"], string> = {
  good: "text-[var(--sem-pos)]",
  info: "text-muted-foreground",
  warn: "text-[var(--sem-warn)]",
  danger: "text-[var(--sem-neg)]",
};

function alertText(alert: PriceAlert): string {
  const pct = (alert.deltaPercent ?? "0").replace("-", "");
  switch (alert.code) {
    case "FIRST_TIME":
      // «ظاهر لك» لا «لم يحدث»: المحصور بفرعٍ/موظّفٍ يرى ضمن نطاقه فقط، فالغياب ليس دليلَ أول بيع مطلقاً.
      return "لا بيع سابق ظاهر لك لهذا الصنف مع هذا العميل";
    case "SAME_AS_LAST":
      return "نفس آخر سعر بيع";
    case "BELOW_LAST_SALE":
      return `أقل من آخر سعر بيع بـ ${pct}%`;
    case "ABOVE_LAST_SALE":
      return `أعلى من آخر سعر بيع بـ ${pct}%`;
  }
}

function AlertIcon({ alert }: { alert: PriceAlert }) {
  const cls = "size-3 shrink-0";
  if (alert.severity === "warn" || alert.severity === "danger") return <AlertTriangle aria-hidden className={cls} />;
  if (alert.code === "SAME_AS_LAST") return <Check aria-hidden className={cls} />;
  if (alert.code === "ABOVE_LAST_SALE") return <TrendingUp aria-hidden className={cls} />;
  return <Info aria-hidden className={cls} />;
}

export function SaleLastPriceHints({
  insight,
  enteredPrice,
  onUsePrice,
  now,
}: {
  /** رؤى هذا الصفّ؛ `undefined` = لم يصل الجواب بعدُ ⇒ لا نعرض شيئاً (لا ادّعاء بلا دليل). */
  insight: SaleLineInsight | undefined;
  enteredPrice: string;
  /** يملأ حقل السعر بسعر المرجع؛ غائب ⇒ لا زرّ (شاشةٌ للقراءة فقط). */
  onUsePrice?: (price: string) => void;
  /** للاختبار: ساعةٌ ثابتة. */
  now?: Date;
}) {
  if (!insight) return null;
  const alerts = evaluateSalePriceAlerts({ enteredPrice, lastSales: insight.lastSales });
  // المرجع من السجلّ مباشرةً لا من التنبيهات: السعر الفارغ/الصفر لا ينتج تنبيهاً، ويبقى «آخر بيع» وزرّ «استخدم» ظاهرَين.
  const reference = pickReferenceSale(insight.lastSales) ?? undefined;
  const hasDiscount = reference != null && Number(reference.discountPercent) > 0;
  let differs = reference != null;
  if (reference != null && enteredPrice.trim() !== "") {
    try {
      differs = !D(reference.price).eq(D(enteredPrice));
    } catch {
      differs = true;
    }
  }
  return (
    <div className="mt-1 space-y-0.5 text-[10px] leading-4" dir="rtl" aria-live="polite" data-testid="sale-last-price-hints">
      {reference && (
        <div className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
          <span>
            آخر بيع لهذا العميل: <span dir="ltr" className="font-bold tabular-nums">{fmtNum(reference.price)}</span> د.ع
          </span>
          <span>· {ageLabel(daysSince(reference.at, now))}</span>
          <span dir="ltr" className="font-mono">{reference.invoiceNumber}</span>
          {hasDiscount && <span>(بخصم <span dir="ltr">{fmtNum(reference.discountPercent)}</span>%)</span>}
          {onUsePrice && differs && (
            <button
              type="button"
              className="rounded border border-primary/40 bg-primary/10 px-1.5 text-[10px] font-bold text-primary hover:bg-primary/20"
              aria-label="استخدم آخر سعر بيع لهذا العميل"
              onClick={() => onUsePrice(reference.price)}
            >
              استخدم
            </button>
          )}
        </div>
      )}
      {alerts.map((alert) => (
        <div key={alert.code} className={cn("flex items-center gap-1 font-semibold", SEVERITY_CLASS[alert.severity])}>
          <AlertIcon alert={alert} />
          {alertText(alert)}
        </div>
      ))}
    </div>
  );
}

/**
 * تلميح السعر التعاقدي: الكتالوج يملأ السعر التعاقدي آلياً (`priceSource="CONTRACT"` و`referencePrice`)
 * لكن الجدول لم يُظهر ذلك — فيعدّله الموظف بلا أن يعلم أنه يخرج عن عقد العميل.
 * عرضٌ فقط من حالة السطر نفسها (السعر وصل أصلاً للكاشير مُحلَّلاً)، فلا استعلامَ جديد ولا تسريب.
 *  • السعر = التعاقدي ⇒ شارة «سعر تعاقدي».  • يختلف ⇒ تنبيه + زرّ «استعد» (إن لم تكن الشاشة للقراءة).
 */
export function ContractPriceHint({
  priceSource,
  referencePrice,
  enteredPrice,
  onRestore,
}: {
  priceSource: string | null | undefined;
  referencePrice: string | null | undefined;
  enteredPrice: string;
  onRestore?: (price: string) => void;
}) {
  if (priceSource !== "CONTRACT" || !referencePrice) return null;
  let differs: boolean;
  try {
    differs = !D(referencePrice).eq(D(enteredPrice));
  } catch {
    return null;
  }
  return (
    <div
      className={cn(
        "mt-1 flex flex-wrap items-center gap-x-1.5 text-[10px] font-semibold leading-4",
        differs ? "text-[var(--sem-warn)]" : "text-primary",
      )}
      dir="rtl"
      data-testid="contract-price-hint"
    >
      {differs ? <AlertTriangle aria-hidden className="size-3 shrink-0" /> : <FileText aria-hidden className="size-3 shrink-0" />}
      {differs ? (
        <span>
          يختلف عن السعر التعاقدي (<span dir="ltr" className="tabular-nums">{fmtNum(referencePrice)}</span> د.ع)
        </span>
      ) : (
        <span>سعر تعاقدي للعميل</span>
      )}
      {differs && onRestore && (
        <button
          type="button"
          className="rounded border border-primary/40 bg-primary/10 px-1.5 text-[10px] font-bold text-primary hover:bg-primary/20"
          aria-label="استعادة السعر التعاقدي"
          onClick={() => onRestore(referencePrice)}
        >
          استعد
        </button>
      )}
    </div>
  );
}
