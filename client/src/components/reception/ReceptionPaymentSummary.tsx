import { Banknote, Percent, Ticket, Truck, X } from "lucide-react";

import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";

import { PAY_METHOD_LABEL } from "./cartMath";
import { CardBrandLogos } from "@/components/ui/CardBrandLogos";
import type { PaymentPanelProps } from "./PaymentPanel";
export function ReceptionPaymentSummary(
  props: PaymentPanelProps & {
    submitAllowed: boolean;
    noCollectionNow: boolean;
  },
) {
  const {
    deferred,
    method,
    grandTotal,
    expectedNow,
    cashRoundingDelta,
    heldDelivery,
    cashDueNow,
    invoiceDiscountPct,
    setInvoiceDiscountPct,
    invoiceDiscountAmount,
    invoiceDiscountAllowed,
    invoiceDiscountMaxPct,
    orderDelivery,
    heldDeposit,
    paid,
    change,
    remaining,
    isChange,
    isOwing,
    couponCode,
    couponLabel,
    couponInput,
    setCouponInput,
    applyCoupon,
    clearCoupon,
    couponPending,
    cartEmpty,
    noCollectionNow,
  } = props;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {cashRoundingDelta !== 0 && (
        <span className="text-[11px] font-semibold text-muted-foreground">
          قُرّب نقدياً لفئة ٢٥٠ ({cashRoundingDelta > 0 ? "+" : "−"}
          {fmt(Math.abs(cashRoundingDelta))} على {fmt(grandTotal)})
        </span>
      )}
      {heldDeposit > 0 && (
        <span className="inline-flex items-center gap-1 rounded-md border border-[var(--sem-info)]/40 bg-[var(--sem-info-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--sem-info)]">
          <Banknote aria-hidden className="size-3" /> عربون مقبوض سلفاً
          (يُخصَم): <span dir="ltr">−{fmt(heldDeposit)}</span>
        </span>
      )}
      {heldDelivery > 0 && (
        <span className="inline-flex items-center gap-1 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--sem-warn)]">
          <Truck aria-hidden className="size-3" /> أجرة توصيل أمانةً:{" "}
          <span dir="ltr">{fmt(heldDelivery)}</span> — المقبوض الآن:{" "}
          <span dir="ltr">{fmt(cashDueNow)}</span>
        </span>
      )}
      {/* ٨/٨ — شفافية أجرة التوصيل غير المقبوضة في الكاونتر (COURIER/SHOP): كانت تختفي كلياً
            فيتساءل الزبون والموظّف. COURIER: الأجرة خارج فاتورة المكتبة لكن الزبون يدفعها للمندوب
            ⇒ نُظهر «إجمالي ما يدفعه الزبون». SHOP: على المكتبة (لا يدفعها الزبون). */}
      {orderDelivery &&
        orderDelivery.feeCollection !== "COUNTER" &&
        orderDelivery.fee > 0 &&
        (orderDelivery.feeCollection === "COURIER" ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--sem-warn)]">
            <Truck aria-hidden className="size-3" /> توصيل (
            {orderDelivery.partyName}): المندوب يقبض{" "}
            <span dir="ltr">{fmt(orderDelivery.fee)}</span> من الزبون — إجمالي
            ما يدفعه الزبون{" "}
            <span dir="ltr">{fmt(expectedNow + orderDelivery.fee)}</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-md border border-muted-foreground/30 bg-muted/40 px-2 py-0.5 text-[11px] font-bold text-muted-foreground">
            <Truck aria-hidden className="size-3" /> توصيل (
            {orderDelivery.partyName}):{" "}
            <span dir="ltr">{fmt(orderDelivery.fee)}</span> على المكتبة (لا
            يدفعها الزبون)
          </span>
        ))}
      {couponCode ? (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-money-positive/40 bg-money-positive/10 px-2 py-0.5 text-[11px] font-bold text-money-positive">
          <Ticket aria-hidden className="size-3" /> {couponLabel ?? couponCode}
          <button
            type="button"
            onClick={clearCoupon}
            className="font-semibold underline text-destructive hover:text-destructive/80"
          >
            إزالة
          </button>
        </span>
      ) : (
        <div className="inline-flex items-center gap-1 rounded-md border border-dashed border-primary/40 bg-card px-2 py-0.5 text-foreground transition-colors hover:border-primary">
          <Ticket aria-hidden className="size-3 text-primary" />
          <input
            type="text"
            value={couponInput}
            onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyCoupon();
              }
            }}
            placeholder="كود الكوبون"
            className="w-20 bg-transparent text-xs font-bold uppercase outline-none placeholder:text-muted-foreground/60"
            dir="ltr"
            disabled={couponPending || cartEmpty}
          />
          <button
            type="button"
            disabled={couponPending || !couponInput.trim() || cartEmpty}
            onClick={applyCoupon}
            className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {couponPending ? "…" : "تطبيق"}
          </button>
        </div>
      )}

      {/* ٢٣/٨ — خصمُ رأس الفاتورة على البيع المباشر: بلاغ المالك «الخصم غير ظاهر». الحقلُ ظاهرٌ
            في صفّ المعلومات نفسه بلونٍ كهرمانيٍّ متيقّظ حين يكون له قيمة، وحدٍّ متقطّعٍ خفيف حين
            يكون فارغاً — إعلانٌ صريحٌ أنّه قابلٌ للتعبئة عند الحاجة. القبول: أرقامٌ ونقطةٌ عشريّة،
            مقصوصٌ لسلطة الكاشير (١٥٪ بقرار المالك) بلا رفضٍ صامت.
            invoiceDiscountAllowed=false ⇒ سلّةٌ بلا بيعٍ مباشر (طباعة/تخصيص فقط) فيُخفى الحقل. */}
      {invoiceDiscountAllowed && (
        <div
          role="group"
          aria-label="خصم على الفاتورة"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border-[1.5px] px-2 py-0.5 transition-colors",
            invoiceDiscountAmount > 0
              ? "border-[var(--sem-warn)] bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
              : "border-dashed border-primary/40 bg-card text-foreground",
          )}
          title={`خصمٌ على البيع المباشر (٠–${invoiceDiscountMaxPct}٪) — فوق السقف يلزم اعتماد مدير`}
        >
          <Percent aria-hidden className="size-3" strokeWidth={2.5} />
          <span className="text-[10px] font-bold">خصم فاتورة</span>
          <input
            type="text"
            inputMode="decimal"
            value={invoiceDiscountPct}
            onChange={(e) => {
              // ٢٣/٨ — Codex P1: `.` منفرداً (بلا أرقام) كان يُخزَّن ثم يمرَّر لـD("") فيرمي.
              // الحلّ: نطلب رقماً على الأقلّ في السلسلة قبل التخزين (فحصٌ إضافيّ فوق regex الصيغة).
              const src = e.target.value;
              if (src === "") {
                setInvoiceDiscountPct("");
                return;
              }
              const norm = src.replace(/[،,]/g, ".");
              if (!/^\d+\.?\d*$|^\d*\.\d+$/.test(norm)) return;
              const n = Number(norm);
              if (!Number.isFinite(n) || n < 0) return;
              if (n > invoiceDiscountMaxPct) {
                const capStr = Number.isInteger(invoiceDiscountMaxPct)
                  ? String(invoiceDiscountMaxPct)
                  : invoiceDiscountMaxPct.toFixed(2).replace(/\.?0+$/, "");
                setInvoiceDiscountPct(capStr);
                return;
              }
              setInvoiceDiscountPct(norm);
            }}
            onBlur={(e) => {
              const raw = e.target.value.trim();
              if (raw === "" || raw === "0" || raw === "0.") {
                setInvoiceDiscountPct("");
                return;
              }
              const n = Number(raw);
              if (!Number.isFinite(n) || n <= 0) {
                setInvoiceDiscountPct("");
                return;
              }
            }}
            placeholder="0"
            aria-label="نسبة خصم الفاتورة"
            dir="ltr"
            className="w-10 min-w-0 bg-transparent text-center text-sm font-black tabular-nums outline-none"
          />
          <span className="text-xs font-bold">%</span>
          {invoiceDiscountAmount > 0 && (
            <>
              <span className="text-xs font-black tabular-nums" dir="ltr">
                −{fmt(invoiceDiscountAmount)}
              </span>
              <button
                type="button"
                onClick={() => setInvoiceDiscountPct("")}
                aria-label="إزالة خصم الفاتورة"
                className="inline-flex size-4 items-center justify-center rounded hover:bg-[var(--sem-warn)]/20"
              >
                <X aria-hidden className="size-3" strokeWidth={2.5} />
              </button>
            </>
          )}
        </div>
      )}

      <div className="ms-auto flex items-baseline gap-1.5">
        <span className="text-xs font-semibold text-muted-foreground">
          {props.chargesOnly?"إجمالي الأجور":"إجمالي الفاتورة"}
        </span>
        <span
          className="text-2xl font-black leading-none tabular-nums tracking-tight"
          dir="ltr"
        >
          {fmt(expectedNow)}
        </span>
        <span className="text-xs text-muted-foreground">د.ع</span>
      </div>
      {/* ٨/٨ — «يدفع الزبون شاملاً التوصيل»: يجيب صراحةً «التوصيل غير محتسبٍ في الإجمالي».
            الأجرة تمريرٌ لا إيراد ⇒ لا تدخل «إجمالي الفاتورة» (الإيراد)، لكنها تظهر هنا في ما
            يدفعه الزبون فعلاً. SHOP (على المكتبة) لا يدفعه الزبون فيُستثنى. */}
      {orderDelivery &&
        orderDelivery.feeCollection !== "SHOP" &&
        orderDelivery.fee > 0 && (
          <div className="flex items-baseline gap-1.5 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2 py-0.5">
            <Truck
              aria-hidden
              className="size-3.5 self-center text-[var(--sem-warn)]"
            />
            <span className="text-[11px] font-bold text-[var(--sem-warn)]">
              يدفع الزبون شاملاً التوصيل
            </span>
            <span
              className="text-xl font-black leading-none tabular-nums text-[var(--sem-warn)]"
              dir="ltr"
            >
              {fmt(expectedNow + orderDelivery.fee)}
            </span>
            <span className="text-[11px] text-[var(--sem-warn)]">د.ع</span>
          </div>
        )}

      {isChange && paid > 0 && (
        <span className="inline-flex items-baseline gap-1.5 rounded-md bg-[var(--sem-pos-bg)] px-2 py-0.5">
          <span className="text-xs font-bold text-[var(--sem-pos)]">
            الفكّة:
          </span>
          <span
            className="text-lg font-black tabular-nums text-[var(--sem-pos)]"
            dir="ltr"
          >
            {fmt(change)}
          </span>
        </span>
      )}
      {isOwing && (
        <span className="inline-flex items-baseline gap-1.5 rounded-md bg-[var(--sem-warn-bg)] px-2 py-0.5">
          <span className="text-xs font-bold text-[var(--sem-warn)]">
            متبقّي:
          </span>
          <span
            className="text-lg font-black tabular-nums text-[var(--sem-warn)]"
            dir="ltr"
          >
            {fmt(remaining)}
          </span>
        </span>
      )}
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-extrabold",
          deferred || noCollectionNow
            ? "border-[var(--sem-warn)]/50 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
            : method === "CASH"
              ? "text-muted-foreground"
              : "border-[var(--sem-info)]/50 bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
        )}
      >
        {/* صدق طريقة الدفع (١٨/٨): بلا قبضٍ الآن لا تُسمّى طريقة — كانت تُعرض «نقدي» فتُقرأ
              العملية مدفوعةً وهي آجلة، وهو نفس الكذب الذي كان يُختَم على الفاتورة. */}
        {!deferred && !noCollectionNow && method === "CARD" && (
          <CardBrandLogos size="xs" />
        )}
        {deferred
          ? "بدون عربون"
          : noCollectionNow
            ? "بلا قبض الآن"
            : PAY_METHOD_LABEL[method]}
      </span>
    </div>
  );
}
