import {
  ArrowLeftRight,
  Banknote,
  Check,
  ChevronDown,
  CreditCard,
  Printer,
  Smartphone,
  Ticket,
  Truck,
  Wallet,
  Zap,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { PAY_METHOD_LABEL, QUICK_AMTS, type PayMethod } from "./cartMath";

/**
 * لوحة الدفع لشاشة الاستقبال — **شريطٌ أفقيٌّ ثابتٌ أسفل الصفحة** (إعادة بناء ٧/٨، طلب مالك
 * صريح: الحاسبة الرقمية الكاملة والعمود الجانبي الضيق كانا يزدحمان ويبتلعان مساحة السلة، وكل
 * تكبير/تصغير في المتصفّح كان يهدّد ظهور زرَّي الدفع). البديل: صفّان أفقيّان يملآن عرض الصفحة
 * كاملاً (`flex-shrink-0` أسفل عمودٍ `flex-col` — يُدفَع تلقائياً خارج مسار التمرير، فلا حاجة
 * لسُلَّم احتواءٍ ديناميكي أو ResizeObserver: البار لا يُقصّ أبداً لأن منطقة السلة فوقه هي التي
 * تتقلّص/تُمرَّر عند ضيق الارتفاع، لا هو). لوحة الأرقام الكاملة (٠-٩) حُذفت — `payInput` حقلٌ
 * نصّي حقيقي يقبل الكتابة المباشرة من لوحة المفاتيح، ورقائق المبالغ السريعة + «= الكل» تكفي
 * غالبية العمل اليدوي. كل الحالة المالية تصل عبر props (بصفر تغيير في العقد أو منطق الحفظ).
 */
export interface PaymentPanelProps {
  payInput: string; setPayInput: (v: string) => void;
  method: PayMethod; setMethod: (m: PayMethod) => void;
  paymentReference: string; setPaymentReference: (v: string) => void;
  needPaymentRef: boolean;
  grandTotal: number; expectedNow: number; cashRoundingDelta: number;
  sumDirect: number; sumCustom: number; heldDelivery: number; cashDueNow: number;
  /** ٨/٨ — شفافية أجرة التوصيل: تُعرض دائماً مهما كان القابض (كانت تختفي لـCOURIER/SHOP).
   *  COURIER = المندوب يقبضها من الزبون (خارج فاتورة المكتبة، لكن الزبون يدفعها) ⇒ نُظهر
   *  «إجمالي ما يدفعه الزبون». SHOP = على المكتبة. COUNTER يُعرض عبر heldDelivery أعلاه. */
  orderDelivery: { fee: number; feeCollection: "COURIER" | "COUNTER" | "SHOP"; partyName: string } | null;
  /** ش٤ — عربونٌ مقبوضٌ سلفاً على الطلب المحفوظ النشط: يُعرض ويُخصَم من «المتوقّع الآن». */
  heldDeposit: number;
  paid: number;
  change: number; remaining: number; isChange: boolean; isOwing: boolean;
  hasCustom: boolean;
  depositMenuOpen: boolean; setDepositMenuOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  /** خيارات «عربون» المنسدلة محسوبة في الصفحة (label + المبلغ المعروض + onPick). */
  depositOptions: Array<{ label: string; amountLabel: string; onPick: () => void }>;
  payAll: () => void; setQuickAmt: (v: number) => void;
  couponCode: string | null; couponLabel: string | null;
  couponInput: string; setCouponInput: (v: string) => void;
  couponOpen: boolean; setCouponOpen: (v: boolean) => void;
  applyCoupon: () => void; clearCoupon: () => void; couponPending: boolean;
  submitting: boolean; cartEmpty: boolean; hasShift: boolean;
  onSubmit: (opts: { quickFullPay: boolean }) => void;
}

export function PaymentPanel({
  payInput, setPayInput,
  method, setMethod,
  paymentReference, setPaymentReference,
  needPaymentRef,
  grandTotal, expectedNow, cashRoundingDelta,
  sumDirect, sumCustom, heldDelivery, cashDueNow, orderDelivery, heldDeposit,
  paid, change, remaining, isChange, isOwing,
  hasCustom,
  depositMenuOpen, setDepositMenuOpen,
  depositOptions,
  payAll, setQuickAmt,
  couponCode, couponLabel,
  couponInput, setCouponInput,
  couponOpen, setCouponOpen,
  applyCoupon, clearCoupon, couponPending,
  submitting, cartEmpty, hasShift,
  onSubmit,
}: PaymentPanelProps) {
  return (
    <div
      tabIndex={-1}
      className="flex flex-shrink-0 flex-col gap-1.5 border-t-2 bg-card px-4 py-2 outline-none focus:ring-2 focus:ring-primary/30"
    >
      {/* صفّ المعلومات: تنبيهات (تقريب/عربون سابق/أمانة توصيل) + الإجمالي + الفكّة أو المتبقّي. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {cashRoundingDelta !== 0 && (
          <span className="text-[11px] font-semibold text-muted-foreground">
            قُرّب نقدياً لفئة ٢٥٠ ({cashRoundingDelta > 0 ? "+" : "−"}{fmt(Math.abs(cashRoundingDelta))} على {fmt(grandTotal)})
          </span>
        )}
        {heldDeposit > 0 && (
          <span className="inline-flex items-center gap-1 rounded-md border border-[var(--sem-info)]/40 bg-[var(--sem-info-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--sem-info)]">
            <Banknote aria-hidden className="size-3" /> عربون مقبوض سلفاً (يُخصَم): <span dir="ltr">−{fmt(heldDeposit)}</span>
          </span>
        )}
        {heldDelivery > 0 && (
          <span className="inline-flex items-center gap-1 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--sem-warn)]">
            <Truck aria-hidden className="size-3" /> أجرة توصيل أمانةً: <span dir="ltr">{fmt(heldDelivery)}</span> — المُستلَم نقداً الآن: <span dir="ltr">{fmt(cashDueNow)}</span>
          </span>
        )}
        {/* ٨/٨ — شفافية أجرة التوصيل غير المقبوضة في الكاونتر (COURIER/SHOP): كانت تختفي كلياً
            فيتساءل الزبون والموظّف. COURIER: الأجرة خارج فاتورة المكتبة لكن الزبون يدفعها للمندوب
            ⇒ نُظهر «إجمالي ما يدفعه الزبون». SHOP: على المكتبة (لا يدفعها الزبون). */}
        {orderDelivery && orderDelivery.feeCollection !== "COUNTER" && orderDelivery.fee > 0 && (
          orderDelivery.feeCollection === "COURIER" ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--sem-warn)]">
              <Truck aria-hidden className="size-3" /> توصيل ({orderDelivery.partyName}): المندوب يقبض <span dir="ltr">{fmt(orderDelivery.fee)}</span> من الزبون — إجمالي ما يدفعه الزبون <span dir="ltr">{fmt(expectedNow + orderDelivery.fee)}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md border border-muted-foreground/30 bg-muted/40 px-2 py-0.5 text-[11px] font-bold text-muted-foreground">
              <Truck aria-hidden className="size-3" /> توصيل ({orderDelivery.partyName}): <span dir="ltr">{fmt(orderDelivery.fee)}</span> على المكتبة (لا يدفعها الزبون)
            </span>
          )
        )}
        {couponCode && (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-money-positive/40 bg-money-positive/10 px-2 py-0.5 text-[11px] font-bold text-money-positive">
            <Ticket aria-hidden className="size-3" /> {couponLabel ?? couponCode}
            <button type="button" onClick={clearCoupon} className="font-semibold underline">إزالة</button>
          </span>
        )}

        <div className="ms-auto flex items-baseline gap-1.5">
          <span className="text-xs font-semibold text-muted-foreground">إجمالي الفاتورة</span>
          <span className="text-2xl font-black leading-none tabular-nums tracking-tight" dir="ltr">{fmt(expectedNow)}</span>
          <span className="text-xs text-muted-foreground">د.ع</span>
        </div>

        {isChange && paid > 0 && (
          <span className="inline-flex items-baseline gap-1.5 rounded-md bg-emerald-500/10 px-2 py-0.5">
            <span className="text-xs font-bold text-emerald-700">الفكّة:</span>
            <span className="text-lg font-black tabular-nums text-emerald-700" dir="ltr">{fmt(change)}</span>
          </span>
        )}
        {isOwing && (
          <span className="inline-flex items-baseline gap-1.5 rounded-md bg-amber-500/10 px-2 py-0.5">
            <span className="text-xs font-bold text-amber-700">متبقّي:</span>
            <span className="text-lg font-black tabular-nums text-amber-700" dir="ltr">{fmt(remaining)}</span>
          </span>
        )}
        <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-extrabold", method === "CASH" ? "text-muted-foreground" : "border-[var(--sem-info)]/50 bg-[var(--sem-info-bg)] text-[var(--sem-info)]")}>
          {PAY_METHOD_LABEL[method]}
        </span>
      </div>

      {/* صفّ الإجراءات: مبلغ مدفوع + رقائق سريعة | طريقة الدفع | عربون/كوبون | زرّا الإتمام.
          pe-28 يحجز حافّة الشريط اليسرى فارغةً — شارة مزامنة الأوفلاين (fixed bottom-3 left-3
          مشتركة بكل شاشات الكاشير) تطفو فوق تلك الزاوية بالضبط في أي شاشةٍ بشريطٍ سفليّ حافّة-لحافّة. */}
      <div className="flex flex-wrap items-center gap-2 pe-28">
        {/* المبلغ المدفوع — حقلٌ نصّي حقيقي (لوحة المفاتيح تكتب مباشرة، بلا حاسبة إضافية). */}
        <div className="flex h-10 items-center gap-2 rounded-lg border-[1.5px] bg-muted/40 px-3 focus-within:border-primary">
          <span className="shrink-0 text-xs text-muted-foreground">المدفوع</span>
          <input
            value={payInput}
            onChange={(e) => {
              const v = e.target.value.replace(/[^\d.]/g, "");
              if ((v.match(/\./g) ?? []).length <= 1) setPayInput(v);
            }}
            inputMode="decimal"
            dir="ltr"
            placeholder="0"
            aria-label="المبلغ المدفوع"
            className={cn(
              "w-28 min-w-0 bg-transparent text-end text-lg font-black tabular-nums outline-none",
              isOwing && "text-amber-600",
              isChange && "text-emerald-600",
            )}
          />
        </div>
        {QUICK_AMTS.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setQuickAmt(v)}
            className="h-10 rounded-lg border-[1.5px] bg-card px-2.5 text-xs font-bold tabular-nums hover:bg-muted"
            dir="ltr"
          >
            {v.toLocaleString("en-US")}
          </button>
        ))}
        <button
          type="button"
          onClick={payAll}
          className="h-10 rounded-lg border-[1.5px] border-primary bg-card px-3 text-xs font-extrabold text-primary hover:bg-primary/10"
        >
          = الكل
        </button>

        <div className="mx-1 h-8 w-px shrink-0 bg-border" aria-hidden />

        {/* طريقة الدفع — أزرار أيقونة مدمجة أفقياً بدل شبكة قائمة. */}
        <div className="flex items-center gap-1">
          {(
            [
              { v: "CASH", label: "نقدي", Icon: Banknote },
              { v: "CARD", label: "بطاقة", Icon: CreditCard },
              { v: "TRANSFER", label: "تحويل", Icon: ArrowLeftRight },
              { v: "WALLET", label: "محفظة", Icon: Wallet },
              { v: "TELECOM", label: "رصيد زين", Icon: Smartphone },
            ] as const
          ).map((p) => (
            <button
              key={p.v}
              onClick={() => setMethod(p.v)}
              title={p.label}
              aria-pressed={method === p.v}
              className={cn(
                "inline-flex h-10 items-center gap-1.5 rounded-lg border-2 px-2.5 text-xs font-extrabold transition-colors",
                method === p.v
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card hover:bg-muted",
              )}
            >
              <p.Icon aria-hidden className="size-4" />
              <span className="hidden lg:inline">{p.label}</span>
            </button>
          ))}
        </div>
        {needPaymentRef && (
          <Input
            value={paymentReference}
            onChange={(e) => setPaymentReference(e.target.value)}
            placeholder={
              method === "CARD" ? "رقم عملية البطاقة"
              : method === "WALLET" ? "رقم عملية المحفظة"
              : method === "TELECOM" ? "أرقام كارت شحن زين"
              : "رقم التحويل"
            }
            className="h-10 w-40 text-xs"
            dir="ltr"
          />
        )}

        <div className="mx-1 h-8 w-px shrink-0 bg-border" aria-hidden />

        {/* عربون — منسدلٌ يفتح للأعلى (البار في أسفل الصفحة). */}
        <div className="relative">
          <button
            onClick={() => setDepositMenuOpen((v) => !v)}
            disabled={cartEmpty}
            title={cartEmpty ? "أضف ما يريده الزبون أولاً" : "عربون: قبضٌ فوريّ بسند، أو تعبئة سريعة من المخصّص"}
            className={cn(
              "inline-flex h-10 items-center gap-1 rounded-lg border-[1.5px] px-3 text-xs font-extrabold",
              !cartEmpty ? "bg-card hover:bg-muted" : "cursor-not-allowed bg-muted/40 text-muted-foreground/50",
            )}
          >
            عربون <ChevronDown aria-hidden className="size-3" />
          </button>
          {depositMenuOpen && !cartEmpty && (
            <div className="absolute bottom-[calc(100%+4px)] end-0 z-30 w-48 rounded-lg border bg-card p-1.5 shadow-2xl" dir="rtl">
              {hasCustom && <div className="px-1 pb-1 text-[10px] text-muted-foreground">الجاهز كاملاً + نسبة من المخصّص:</div>}
              {depositOptions.map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={opt.onPick}
                  className="block w-full rounded-md px-2 py-1.5 text-start text-xs font-bold hover:bg-muted"
                >
                  {opt.label}
                  <span className="ms-1 text-[10px] font-semibold text-muted-foreground tabular-nums" dir="ltr">
                    = {opt.amountLabel}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* كوبون — مطويٌّ خلف زرٍّ (نادر الاستعمال)؛ إن كان مُطبَّقاً فرقاقته تظهر بصفّ المعلومات أعلاه. */}
        {!couponCode && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setCouponOpen(!couponOpen)}
              className="inline-flex h-10 items-center gap-1 rounded-lg border-[1.5px] bg-card px-3 text-xs font-bold text-muted-foreground hover:bg-muted"
            >
              <Ticket aria-hidden className="size-3.5" /> كوبون
            </button>
            {couponOpen && (
              <div className="absolute bottom-[calc(100%+4px)] end-0 z-30 w-56 rounded-lg border bg-card p-2 shadow-2xl" dir="rtl">
                <div className="flex gap-1.5">
                  <Input
                    value={couponInput}
                    onChange={(e) => setCouponInput(e.target.value)}
                    placeholder="رمز الكوبون"
                    className="h-9 flex-1 text-xs"
                    dir="ltr"
                    autoFocus
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyCoupon(); } }}
                  />
                  <button
                    type="button"
                    disabled={!couponInput.trim() || couponPending}
                    onClick={applyCoupon}
                    className="h-9 shrink-0 rounded-md border-[1.5px] border-primary px-3 text-xs font-bold text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:border-border disabled:text-muted-foreground"
                  >
                    {couponPending ? "…" : "تطبيق"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* زرّا الإتمام — يتّجهان لأقصى الشريط، جنباً إلى جنب، ثابتان دائماً (البار لا يُقصّ). */}
        <div className="ms-auto flex items-center gap-2">
          <span className="hidden text-[10px] text-muted-foreground lg:inline">F4 دفع · F2 بحث</span>
          <button
            type="button"
            disabled={cartEmpty || submitting || !hasShift}
            onClick={() => onSubmit({ quickFullPay: true })}
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-4 text-sm font-black text-white shadow-md transition-colors hover:bg-amber-600 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
          >
            <Zap aria-hidden className="size-4" /> تحصيل المطلوب الآن وطباعة
          </button>
          <button
            type="button"
            disabled={cartEmpty || submitting || !hasShift}
            onClick={() => onSubmit({ quickFullPay: false })}
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-black text-primary-foreground shadow-md transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
          >
            {submitting ? (
              "جارٍ الإرسال…"
            ) : sumCustom > 0 && sumDirect > 0 ? (
              <><Printer aria-hidden className="size-4" /> تثبيت البيع وإرسال الطباعة</>
            ) : sumCustom > 0 ? (
              <><Printer aria-hidden className="size-4" /> إرسال للمطبعة</>
            ) : (
              <><Check aria-hidden className="size-4" /> إتمام الطلب وطباعة</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
