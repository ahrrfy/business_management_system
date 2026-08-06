import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Banknote,
  Check,
  ChevronDown,
  CreditCard,
  Printer,
  ShoppingCart,
  Smartphone,
  Ticket,
  Truck,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { PAY_METHOD_LABEL, QUICK_AMTS, type PayMethod } from "./cartMath";

/**
 * لوحة الدفع لشاشة الاستقبال — نُقلت حرفياً من Reception.tsx (تفكيك §١٣ ش١) بصفر تغيير سلوكي.
 * كل الحالة المالية ملك الصفحة وتصل عبر props؛ سلّم الاحتواء (القياس بالـResizeObserver ودرجات
 * الكثافة) داخليّ هنا لأنه عرضٌ محض لا يقرأه غير اللوحة.
 */
export interface PaymentPanelProps {
  onFocusStep: () => void;                    // onFocusCapture
  payInput: string; setPayInput: (v: string) => void;
  method: PayMethod; setMethod: (m: PayMethod) => void;
  paymentReference: string; setPaymentReference: (v: string) => void;
  needPaymentRef: boolean;
  grandTotal: number; expectedNow: number; cashRoundingDelta: number;
  sumDirect: number; sumCustom: number; heldDelivery: number; cashDueNow: number;
  /** ش٤ — عربونٌ مقبوضٌ سلفاً على الطلب المحفوظ النشط: يُعرض ويُخصَم من «المتوقّع الآن». */
  heldDeposit: number;
  paid: number;
  change: number; remaining: number; isChange: boolean; isOwing: boolean;
  hasCustom: boolean;
  depositMenuOpen: boolean; setDepositMenuOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  /** خيارات «عربون» المنسدلة محسوبة في الصفحة (label + المبلغ المعروض + onPick). */
  depositOptions: Array<{ label: string; amountLabel: string; onPick: () => void }>;
  numPress: (k: string) => void; payAll: () => void; setQuickAmt: (v: number) => void;
  couponCode: string | null; couponLabel: string | null;
  couponInput: string; setCouponInput: (v: string) => void;
  couponOpen: boolean; setCouponOpen: (v: boolean) => void;
  applyCoupon: () => void; clearCoupon: () => void; couponPending: boolean;
  submitting: boolean; cartEmpty: boolean; hasShift: boolean;
  onSubmit: (opts: { quickFullPay: boolean }) => void;
}

export const PaymentPanel = forwardRef<HTMLDivElement, PaymentPanelProps>(function PaymentPanel(
  {
    onFocusStep,
    payInput, setPayInput,
    method, setMethod,
    paymentReference, setPaymentReference,
    needPaymentRef,
    grandTotal, expectedNow, cashRoundingDelta,
    sumDirect, sumCustom, heldDelivery, cashDueNow, heldDeposit,
    paid, change, remaining, isChange, isOwing,
    hasCustom,
    depositMenuOpen, setDepositMenuOpen,
    depositOptions,
    numPress, payAll, setQuickAmt,
    couponCode, couponLabel,
    couponInput, setCouponInput,
    couponOpen, setCouponOpen,
    applyCoupon, clearCoupon, couponPending,
    submitting, cartEmpty, hasShift,
    onSubmit,
  },
  ref,
) {
  // احتواء ديناميكي (إعادة بناء ٥/٨ — «منطقة الدفع فيها تمرير»): القياس بالنافذة كان خاطئاً
  // بنيوياً، لأن لوحة الدفع أقصر من النافذة بـ«شريط الأوضاع + ترويسة الاستقبال + الحشوة»
  // (~٢٤٠px، أكبر بكثير من فارق POS). فنافذةٌ «فسيحة» ٩٤٥px تُخفي أن اللوحة نفسها ٦٧٠px
  // ⇒ عجزٌ يُصرَف تمريراً دائماً. الآن تُقاس **اللوحة نفسها** بـResizeObserver، فالكثافة تتبع
  // المساحة الحقيقية. لا حلقة ارتجاج: ارتفاع اللوحة يفرضه الأب (صفّ flex بارتفاع ثابت)،
  // وكل ما تُبدّله الكثافة يقع **داخل** اللوحة فلا يُغيّر ارتفاعها.
  const paymentSectionRef = useRef<HTMLDivElement>(null);
  // الصفحة تحتاج الحاوية نفسها للتركيز (goToWorkflowStep) — نمرّر العنصر المرصود ذاته.
  useImperativeHandle(ref, () => paymentSectionRef.current as HTMLDivElement);
  const [payPanelH, setPayPanelH] = useState(0);
  useEffect(() => {
    const el = paymentSectionRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height;
      // عتبة ٤px تمنع إعادة رسمٍ لا داعي لها من كسور البكسل عند الزوم.
      setPayPanelH((prev) => (Math.abs(prev - h) < 4 ? prev : h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // ثلاث درجات احتواء: يُحذف الثانويّ أولاً ثم يُعاد التركيب — لا تصغيرَ للأساسيّ.
  // (0 = قبل أول قياس ⇒ نفترض الفسيح فلا يومض التركيب المضغوط عند الإقلاع.)
  const payDense = payPanelH > 0 && payPanelH < 700;
  const payUltra = payPanelH > 0 && payPanelH < 580;
  // شبكة أمانٍ أخيرة: تحت هذا الحدّ لا يبقى ثانويٌّ يُحذف، والحدود الدنيا الصلبة (مفاتيح ٤٠px
  // ×٤ صفوف + طرق الدفع ٤٤px + زرّا الفعل ٤٤/٤٨px) تطلب ~٥٠٠px. فلو مُنع التمرير هنا لَقُصّ
  // المحتوى **صامتاً** — وهو أسوأ من شريط تمرير. العتبة ٥٢٠ تترك هامشاً فوق الطلب الفعليّ
  // فلا تُفتَح إلا حين يستحيل الاحتواء حقّاً (خارج مدى التشغيل: أقصر لوحةٍ عمليّة ~٥٠٠px).
  const payOverflowGuard = payPanelH > 0 && payPanelH < 520;

  return (
    <div
      ref={paymentSectionRef}
      tabIndex={-1}
      onFocusCapture={onFocusStep}
      className="flex w-[408px] flex-shrink-0 flex-col overflow-hidden rounded-xl border bg-card outline-none focus:ring-2 focus:ring-primary/30 [container-type:size]"
    >
      {/* رأس الإجمالي + التقسيم الهجين — ثابتٌ دائماً، خارج منطقة التمرير. */}
      <div className={cn("flex-shrink-0 border-b bg-muted/40", payUltra ? "px-3 py-1.5" : "p-3")}>
        {!payDense && (
          <div className="mb-1.5 inline-flex items-center gap-1.5 text-xs font-extrabold">
            <span className="grid size-5 place-items-center rounded-full bg-primary text-[10px] text-primary-foreground">٥</span>
            المبلغ والدفع
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground">إجمالي الفاتورة</span>
          <div className="flex items-baseline gap-1">
            <span className="text-[clamp(22px,3.8cqh,30px)] font-black leading-tight tabular-nums tracking-tight" dir="ltr">{fmt(expectedNow)}</span>
            <span className="text-xs text-muted-foreground">د.ع</span>
          </div>
        </div>
        {/* ش٠ — شفافية التقريب النقدي: يظهر الفرق فقط حين يسري (فئة ٢٥٠ د.ع). */}
        {cashRoundingDelta !== 0 && (
          <div className="mt-0.5 text-end text-[10px] font-semibold text-muted-foreground" dir="rtl">
            قُرّب نقدياً لفئة ٢٥٠ ({cashRoundingDelta > 0 ? "+" : "−"}{fmt(Math.abs(cashRoundingDelta))} على {fmt(grandTotal)})
          </div>
        )}
        {/* أجرة التوصيل المقبوضة أمانةً: خارج الفاتورة، لكنها نقدٌ يُستلَم فعلاً الآن.
            عرضها منفصلةً يمنع الخلط الذي كان يجعل الموظّف يظنّها جزءاً من البيع. */}
        {/* ش٤ — عربون مقبوض سلفاً: الزبون دفعه فعلاً بإيصالٍ سابق ⇒ «المتوقّع الآن» أعلاه ناقصُه. */}
        {heldDeposit > 0 && (
          <div className="mt-1 flex items-center justify-between rounded-md border border-[var(--sem-info)]/40 bg-[var(--sem-info-bg)] px-2 py-1 text-[11px] font-bold text-[var(--sem-info)]">
            <span className="inline-flex items-center gap-1"><Banknote aria-hidden className="size-3" /> عربون مقبوض سلفاً (يُخصَم)</span>
            <span className="tabular-nums" dir="ltr">−{fmt(heldDeposit)}</span>
          </div>
        )}
        {heldDelivery > 0 && (
          <div className="mt-1 space-y-0.5 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2 py-1">
            <div className="flex items-center justify-between text-[11px] font-bold text-[var(--sem-warn)]">
              <span className="inline-flex items-center gap-1"><Truck aria-hidden className="size-3" /> أجرة توصيل أمانةً للمندوب</span>
              <span className="tabular-nums" dir="ltr">{fmt(heldDelivery)}</span>
            </div>
            <div className="flex items-center justify-between text-[11px] font-extrabold">
              <span>المُستلَم نقداً الآن</span>
              <span className="tabular-nums" dir="ltr">{fmt(cashDueNow)} د.ع</span>
            </div>
          </div>
        )}
        {/* بطاقتا التقسيم ثانويّتان (الرقمان يظهران في السلة نفسها) ⇒ تُحذفان في أضيق درجة. */}
        {!payUltra && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-2">
              <div className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700">
                <ShoppingCart aria-hidden className="size-3" /> منتجات جاهزة
              </div>
              <div className="mt-0.5 text-sm font-extrabold tabular-nums" dir="ltr">{fmt(sumDirect)}</div>
            </div>
            <div className="rounded-lg border border-violet-500/25 bg-violet-500/10 p-2">
              <div className="inline-flex items-center gap-1 text-[10px] font-bold text-violet-700">
                <Printer aria-hidden className="size-3" /> خدمات وطباعة
              </div>
              <div className="mt-0.5 text-sm font-extrabold tabular-nums" dir="ltr">{fmt(sumCustom)}</div>
            </div>
          </div>
        )}
      </div>

      {/* منطقة الإدخال — تتّسع بلا تمرير: الاحتواء المتكيّف أعلاه حذف الثانويّ بالفعل، ولوحة
          الأرقام تمتصّ الفائض بوحدات الحاوية. التمرير لا يُفتح إلا تحت ٤٥٢px (لا يُبلَغ عملياً). */}
      <div className={cn("flex min-h-0 flex-1 flex-col", payOverflowGuard ? "overflow-y-auto overscroll-contain" : "overflow-hidden")}>
      {/* م٤ — حقل المبلغ الحقيقيّ: `payInput` كان بلا أيّ مدخلٍ نصّيّ (F13) — حذفُ أوضاع
          اللوحة بلا هذا البديل كان يشلّ إدخال أيّ مبلغٍ جزئيّ/عربون. */}
      <div className={cn("flex-shrink-0 px-3", payUltra ? "pb-0.5 pt-1" : "pb-1 pt-2")}>
        <div className={cn(
          "flex items-center justify-between gap-2 rounded-lg border-[1.5px] bg-muted/40 px-3 focus-within:border-primary",
          payUltra ? "min-h-[36px] py-1" : "min-h-[44px] py-1.5",
        )}>
          <span className="shrink-0 text-xs text-muted-foreground">المبلغ المدفوع</span>
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
              "w-full min-w-0 bg-transparent text-end font-black tabular-nums outline-none",
              payUltra ? "text-xl" : "text-2xl",
              isOwing && "text-amber-600",
              isChange && "text-emerald-600",
            )}
          />
        </div>
      </div>

      {/* مبالغ سريعة — تُحذف عند ضيق الارتفاع (لوحة الأرقام تُغنِي عنها؛ حذف الثانويّ لا تصغير الأساسيّ). */}
      {!payDense && (
      <div className="flex flex-shrink-0 flex-wrap gap-1.5 px-3 py-1">
        {QUICK_AMTS.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setQuickAmt(v)}
            className="h-7 rounded-md border-[1.5px] bg-card px-2 text-[11px] font-bold tabular-nums hover:bg-muted"
            dir="ltr"
          >
            {v.toLocaleString("en-US")}
          </button>
        ))}
        <button
          type="button"
          onClick={payAll}
          className="h-7 rounded-md border-[1.5px] border-primary bg-card px-2 text-[11px] font-extrabold text-primary hover:bg-primary/10"
        >
          = الكل
        </button>
      </div>
      )}

      {/* لوحة الأرقام — تمتصّ الفائض: صفوفها `1fr` داخل كتلةٍ `flex-1` فتكبر بالمساحة المتاحة
          وتنكمش معها بلا قصٍّ ولا تمرير. الحدّ الأدنى 44px (هدف اللمس المعياريّ)، ولا ينزل إلى
          40px إلا في الدرجة الأضيق بعد حذف كل ثانويّ. */}
      {/* م٤ (§٨.٣): لوحة مبلغٍ خالصة — العمود المُحرَّر من أزرار الأوضاع صار: 000 (أعلى مفتاحٍ
          عائداً في سوق الدينار) و«= الكل» و«عربون» المنسدل (عند وجود تخصيص). */}
      <div className="min-h-0 flex-1 px-3 py-1">
        <div className={cn("grid h-full grid-cols-[auto_1fr_1fr_1fr] grid-rows-4 gap-1.5", payUltra ? "[--numh:40px]" : "[--numh:44px]")} dir="rtl">
          <button onClick={() => numPress("000")} className={cn(NUM_H, "min-w-[60px] rounded-lg border-[1.5px] bg-card text-sm font-extrabold tabular-nums hover:bg-muted")} dir="ltr">000</button>
          <NumKey k="3" onPress={numPress} />
          <NumKey k="2" onPress={numPress} />
          <NumKey k="1" onPress={numPress} />

          <button onClick={payAll} className={cn(NUM_H, "min-w-[60px] rounded-lg border-[1.5px] border-primary bg-card text-xs font-extrabold text-primary hover:bg-primary/10")}>= الكل</button>
          <NumKey k="6" onPress={numPress} />
          <NumKey k="5" onPress={numPress} />
          <NumKey k="4" onPress={numPress} />

          <div className="relative">
            {/* ش٤ (م٢): العربون على أيّ طلبٍ — مخصوصٍ وغير مخصوص — فالزرّ يُقفل بفراغ السلة فقط.
                خيارات التعبئة النسبية (٢٥٪/٥٠٪ من المخصّص) تظهر مع التخصيص وحده؛
                «قبض عربون الآن» و«سجلّ العرابين» يظهران دائماً (تحسبهما الصفحة). */}
            <button
              onClick={() => setDepositMenuOpen((v) => !v)}
              disabled={cartEmpty}
              title={cartEmpty ? "أضف ما يريده الزبون أولاً" : "عربون: قبضٌ فوريّ بسند، أو تعبئة سريعة من المخصّص"}
              className={cn(NUM_H, "w-full min-w-[60px] rounded-lg border-[1.5px] text-xs font-extrabold", !cartEmpty ? "bg-card hover:bg-muted" : "cursor-not-allowed bg-muted/40 text-muted-foreground/50")}
            >
              عربون <ChevronDown aria-hidden className="inline size-3" />
            </button>
            {depositMenuOpen && !cartEmpty && (
              <div className="absolute end-0 top-[calc(100%+4px)] z-30 w-44 rounded-lg border bg-card p-1.5 shadow-xl" dir="rtl">
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
          <NumKey k="9" onPress={numPress} />
          <NumKey k="8" onPress={numPress} />
          <NumKey k="7" onPress={numPress} />

          <button onClick={() => numPress("DEL")} className={cn(NUM_H, "grid place-items-center rounded-lg border-[1.5px] bg-red-50 text-red-700 hover:bg-red-100")} aria-label="حذف آخر رقم">
            <X aria-hidden className="size-4" />
          </button>
          <NumKey k="." onPress={numPress} />
          <NumKey k="0" onPress={numPress} />
          <button onClick={() => numPress("C")} className={cn(NUM_H, "rounded-lg border-[1.5px] bg-card text-xs font-extrabold text-muted-foreground hover:bg-muted")}>C</button>
        </div>
      </div>

      {/* طريقة الدفع — عند الضيق يُحذف العنوان وتُعاد الأيقونة والنصّ إلى صفٍّ واحد داخل
          الزرّ (تركيبٌ متكيّف) بدل تصغير الزرّ نفسه: يبقى ≥44px هدفَ لمسٍ سليماً.
          ش٥ (§٨.٣): خمس طرقٍ = grid صفّين ≤٣ (لا تصغير أزرارٍ تحت هدف اللمس)، والطريقة
          المختارة تُعرض **بالكلمات** في سطر «المتوقّع الآن» أسفل — اللون وحده لا يكفي. */}
      <div className={cn("flex-shrink-0 px-3", payUltra ? "py-0.5" : "py-1.5")}>
        {!payDense && <div className="mb-1 text-[11px] font-bold text-muted-foreground">طريقة الدفع</div>}
        <div className="grid grid-cols-3 gap-1.5">
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
              className={cn(
                "flex items-center justify-center rounded-lg border-2 text-xs font-extrabold transition-colors",
                payUltra
                  ? "min-h-[44px] flex-row gap-1 py-1"
                  : "min-h-[clamp(46px,6.6cqh,60px)] flex-col gap-0.5 py-2",
                method === p.v
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card hover:bg-muted",
              )}
            >
              <p.Icon aria-hidden className={payUltra ? "size-4" : "size-5"} />
              {p.label}
            </button>
          ))}
        </div>
        {needPaymentRef && (
          <Input
            value={paymentReference}
            onChange={(e) => setPaymentReference(e.target.value)}
            placeholder={
              method === "CARD" ? "أدخل رقم عملية البطاقة"
              : method === "WALLET" ? "أدخل رقم عملية المحفظة"
              : method === "TELECOM" ? "أدخل أرقام كارت شحن زين"
              : "أدخل رقم التحويل"
            }
            className="mt-2 h-9 text-xs"
            dir="ltr"
          />
        )}
      </div>

      {/* كوبون خصم — نادر الاستعمال ⇒ يُطوى خلف زرٍّ عند الضيق، ويبقى ظاهراً دائماً وهو
          مُطبَّق (لا يُخفى خصمٌ سارٍ) أو حين يطلبه الموظّف صراحةً. */}
      {payDense && !couponCode && !couponOpen ? (
        <div className="flex-shrink-0 px-3 py-1">
          <button
            type="button"
            onClick={() => setCouponOpen(true)}
            className="inline-flex h-8 items-center gap-1 rounded-md border-[1.5px] bg-card px-2 text-[11px] font-bold text-muted-foreground hover:bg-muted"
          >
            <Ticket aria-hidden className="size-3.5" /> كوبون خصم
          </button>
        </div>
      ) : (
      <div className="flex-shrink-0 px-3 py-1.5">
        <div className="mb-1 flex items-center gap-1 text-[11px] font-bold text-muted-foreground">
          <Ticket aria-hidden className="size-3.5" /> كوبون خصم
        </div>
        {couponCode ? (
          <div className="flex items-center justify-between rounded-md border border-money-positive/40 bg-money-positive/10 px-2 py-1.5 text-xs font-bold text-money-positive">
            <span>{couponLabel ?? couponCode}</span>
            <button type="button" onClick={clearCoupon} className="text-[11px] font-semibold underline">إزالة</button>
          </div>
        ) : (
          <div className="flex gap-1.5">
            <Input
              value={couponInput}
              onChange={(e) => setCouponInput(e.target.value)}
              placeholder="رمز الكوبون"
              className="h-8 flex-1 text-xs"
              dir="ltr"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyCoupon(); } }}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={!couponInput.trim() || couponPending}
              onClick={applyCoupon}
            >
              {couponPending ? "…" : "تطبيق"}
            </Button>
          </div>
        )}
      </div>
      )}

      {/* مؤشّر فكّة/متبقّي */}
      <div className="flex flex-shrink-0 items-center justify-between border-t px-3 py-1.5 text-xs">
        {isChange && paid > 0 && (
          <>
            <span className="font-semibold text-emerald-700">الفكّة:</span>
            <span className="text-xl font-black tabular-nums text-emerald-700" dir="ltr">
              {fmt(change)} <span className="text-[10px] font-medium">د.ع</span>
            </span>
          </>
        )}
        {isOwing && (
          <>
            <span className="font-semibold text-amber-700">متبقّي:</span>
            <span className="text-xl font-black tabular-nums text-amber-700" dir="ltr">
              {fmt(remaining)} <span className="text-[10px] font-medium">د.ع</span>
            </span>
          </>
        )}
        {!isChange && !isOwing && (
          <span className="text-muted-foreground">المتوقّع الآن: <span className="font-bold tabular-nums" dir="ltr">{fmt(expectedNow)} د.ع</span></span>
        )}
        {/* ش٥ (§٨.٣): الطريقة المختارة **بالكلمات** فوق زرّي الفعل — خطأ الاختيار على شاشةٍ
            مضغوطة يُنتج عجز درجٍ يمنع الإغلاق، واللون وحده لا يكفي. */}
        <span className={cn("ms-auto rounded-md border px-1.5 py-0.5 text-[10px] font-extrabold", method === "CASH" ? "text-muted-foreground" : "border-[var(--sem-info)]/50 bg-[var(--sem-info-bg)] text-[var(--sem-info)]")}>
          {PAY_METHOD_LABEL[method]}
        </span>
      </div>
      </div>{/* ← نهاية منطقة الإدخال */}

      {/* منطقة الفعل — لا تنكمش أبداً: زرّا الدفع يبقيان ظاهرَين وقابلَين للنقر
          مهما بلغ الزوم أو ضاق الارتفاع (هذا ما كان يختفي قبل الإصلاح). */}
      <div className={cn("flex-shrink-0 space-y-1.5 px-3", payUltra ? "pb-2 pt-0.5" : "pb-3 pt-1")}>
        <button
          type="button"
          disabled={cartEmpty || submitting || !hasShift}
          onClick={() => onSubmit({ quickFullPay: true })}
          className="inline-flex h-[clamp(44px,6cqh,52px)] w-full items-center justify-center gap-1.5 rounded-lg bg-amber-500 text-sm font-black text-white shadow-md transition-colors hover:bg-amber-600 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
        >
          <Zap aria-hidden className="size-4" /> تحصيل المطلوب الآن وطباعة
        </button>
        <button
          type="button"
          disabled={cartEmpty || submitting || !hasShift}
          onClick={() => onSubmit({ quickFullPay: false })}
          className="inline-flex h-[clamp(48px,6.5cqh,56px)] w-full items-center justify-center gap-1.5 rounded-lg bg-primary text-sm font-black text-primary-foreground shadow-md transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
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
        {!payDense && (
          <div className="text-center text-[10px] text-muted-foreground">F4 دفع · F2 بحث</div>
        )}
      </div>
    </div>
  );
});

/** ارتفاع مفتاح اللوحة: يملأ صفّ الشبكة (h-full) بحدٍّ أدنى هو هدف اللمس المعياريّ الممرَّر
 *  بالمتغيّر `--numh` من الحاوية (44px، و40px في الدرجة الأضيق) ⇒ يكبر بالمساحة ولا يُقصّ. */
const NUM_H = "h-full min-h-[var(--numh,44px)]";

function NumKey({ k, onPress }: { k: string; onPress: (k: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPress(k)}
      className={cn(NUM_H, "rounded-lg border-[1.5px] bg-muted/40 text-lg font-extrabold tabular-nums hover:bg-muted")}
      dir="ltr"
    >
      {k}
    </button>
  );
}
