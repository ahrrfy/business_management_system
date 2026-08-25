/**
 * SupplierInvoiceMatch — لوحة **مطابقة أمر الشراء بفاتورة المورّد** (إنشاءً وتعديلاً).
 *
 * تُظهر قبل الحفظ: مجموع بنودنا · قيمة فاتورة المورّد · **الفرق بالرقم** · حكمٌ مشروح، وتُتيح
 * توزيع الفرق على أسعار البنود بنسبة القيمة **بعد أن يراه الموظّف ويؤكّده** — لا امتصاصَ خفيّ.
 * المنطق كلّه في `supplierInvoiceMatch.ts` (نقيٌّ ومُختبَر)؛ هذا الملف عرضٌ فقط.
 */
import { AlertTriangle, BadgePercent, CheckCircle2, FileCheck2, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/form/MoneyInput";
import { cn } from "@/lib/utils";
import { fmtAr } from "@/lib/money";
import type { PriceCurrency } from "@shared/moneyPrecision";
import { matchSupplierInvoice, type MatchResult } from "./supplierInvoiceMatching";

export interface SupplierInvoiceMatchProps {
  /** إجماليّ الأمر المشتقّ من البنود **بعملة الأمر** (نظير `calcTotals().grandTotal`). */
  derivedTotal: string;
  /** قيمة فاتورة المورّد كما أدخلها الموظّف (نصّ خام). */
  value: string;
  onChange: (raw: string) => void;
  currency: PriceCurrency;
  /** يوزّع الفرق على أسعار البنود. غيابه ⇒ لا يظهر الزرّ (لا سطور قابلة للتعديل). */
  onDistribute?: () => void;
  /**
   * يُسجّل الفرق **خصمَ فاتورةٍ** (0204) — المسار الطبيعيّ حين تكون ورقة المورّد أقلّ من بنودنا:
   * يبقى سعرُ المورّد الأصليّ في البنود ويُسجَّل الخصم بذاته، بدل إعادة تسعيرٍ تُخفي أنّه خصم.
   */
  onApplyAsDiscount?: () => void;
  /** يُعطَّل الزرّ حين لا توجد بنودٌ بقيمةٍ موجبة. */
  canDistribute?: boolean;
}

const TONE: Record<MatchResult["verdict"], string> = {
  UNSET: "border-dashed",
  INVALID: "border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)]/50",
  MATCH: "border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)]/50",
  OURS_HIGHER: "border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/50",
  OURS_LOWER: "border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/50",
};

export function SupplierInvoiceMatch({
  derivedTotal,
  value,
  onChange,
  currency,
  onDistribute,
  onApplyAsDiscount,
  canDistribute = true,
}: SupplierInvoiceMatchProps) {
  const result = matchSupplierInvoice(derivedTotal, value, currency);
  const curSym = currency === "USD" ? "$" : "د.ع";
  const mismatched = result.verdict === "OURS_HIGHER" || result.verdict === "OURS_LOWER";

  return (
    <section className={cn("overflow-hidden rounded-xl border bg-card", TONE[result.verdict])}>
      <header className="flex items-center gap-2 border-b bg-muted px-4 py-2.5">
        <FileCheck2 aria-hidden className="size-5" />
        <span className="text-sm font-extrabold">مطابقة فاتورة المورّد</span>
      </header>

      <div className="space-y-2 px-4 py-3">
        <label className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-muted-foreground">
            قيمة الفاتورة ({curSym})
          </span>
          <MoneyInput
            value={value}
            onChange={onChange}
            placeholder="اكتب الرقم من ورقة المورّد"
            ariaLabel="قيمة فاتورة المورّد"
            className="h-8 w-36 text-center text-sm font-bold"
          />
        </label>

        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">مجموع بنودنا</span>
          <span dir="ltr" className="font-bold tabular-nums">{fmtAr(result.derived)} {curSym}</span>
        </div>

        {result.verdict !== "UNSET" && result.verdict !== "INVALID" && (
          <div className="flex items-center justify-between border-t pt-2 text-sm">
            <span className="text-muted-foreground">الفرق</span>
            <span
              dir="ltr"
              className={cn(
                "font-extrabold tabular-nums",
                result.verdict === "MATCH" ? "text-[var(--sem-pos)]" : "text-[var(--sem-warn)]",
              )}
            >
              {fmtAr(result.difference)} {curSym}
            </span>
          </div>
        )}

        {result.message && (
          <p
            className={cn(
              "flex items-start gap-1.5 text-[11px] leading-relaxed",
              result.verdict === "MATCH" ? "font-bold text-[var(--sem-pos)]" : "text-[var(--sem-warn)]",
            )}
          >
            {result.verdict === "MATCH" ? (
              <CheckCircle2 aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            ) : (
              <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            )}
            <span>{result.message}</span>
          </p>
        )}

        {mismatched && (onDistribute || onApplyAsDiscount) && (
          <div className="space-y-1.5 border-t pt-2">
            {/* بنودنا أعلى ⇒ الفرق خصمٌ من المورّد في الأغلب: تسجيلُه خصماً يحفظ سعرَه الأصليّ
                في التاريخ ويُظهر الخصم بذاته، وهو أصدق من إعادة تسعيرٍ تُخفي سببه. */}
            {result.verdict === "OURS_HIGHER" && onApplyAsDiscount && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 w-full border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)]/60 text-[var(--sem-pos)] hover:bg-[var(--sem-pos-bg)]/80"
                onClick={onApplyAsDiscount}
                disabled={!canDistribute}
              >
                <BadgePercent aria-hidden className="size-4" /> سجّل الفرق خصمَ فاتورة
              </Button>
            )}
            {onDistribute && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-full border-primary/40 bg-primary/5 text-primary hover:bg-primary/10"
              onClick={onDistribute}
              disabled={!canDistribute}
            >
              <Scale aria-hidden className="size-4" /> وزّع الفرق على أسعار البنود
            </Button>
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              <strong>خصمُ فاتورة</strong> يُبقي سعر المورّد الأصليّ في البنود ويُسجّل الخصم بذاته
              (يُوزَّع بنسبة القيمة فيَنقص الذمّة والتكلفة) — وهو الأنسب للخصم التجاريّ.
              و<strong>توزيعُ الفرق</strong> يُعيد تسعير البنود نفسها، والأسعار الجديدة تظهر في
              الجدول قبل الحفظ. أمّا البند الناقص فأضِفه بنداً مستقلاً.
            </p>
          </div>
        )}

        {result.verdict === "UNSET" && (
          <p className="border-t pt-2 text-[11px] leading-relaxed text-muted-foreground">
            اكتب الرقم المدوَّن على فاتورة المورّد ليتحقّق النظام من مطابقته لمجموع البنود قبل
            الحفظ. الحقل اختياريّ، لكنّه يمنع حفظ أمرٍ يخالف مستنده.
          </p>
        )}
      </div>
    </section>
  );
}
