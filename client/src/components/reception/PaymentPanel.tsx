import { useEffect, useState } from "react";
import {
  ArrowLeftRight,
  Banknote,
  Check,
  ChevronDown,
  CreditCard,
  Landmark,
  Percent,
  Printer,
  Smartphone,
  Ticket,
  Truck,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage } from "@shared/posPaymentPolicy";
import { INBOUND_TELECOM_DISABLED_MESSAGE } from "@shared/inboundPaymentPolicy";
import { normalizeNumberInput } from "@shared/numberNormalize";
import { PAY_METHOD_LABEL, type PayMethod } from "./cartMath";

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
  deferred: boolean; setDeferred: (value: boolean) => void;
  deferredAvailable: boolean; deferredCustomerName: string | null;
  method: PayMethod; setMethod: (m: PayMethod) => void;
  paymentReference: string; setPaymentReference: (v: string) => void;
  needPaymentRef: boolean;
  grandTotal: number; expectedNow: number; cashRoundingDelta: number;
  sumDirect: number; sumCustom: number; heldDelivery: number; cashDueNow: number;
  /** ٢٣/٨ — خصمُ رأس الفاتورة على البيع المباشر (سلطة الكاشير ٠–١٥٪): نسبةٌ يُدخلها الكاشير،
   *  والمبلغ يُحسَب على البيع الخالص وحده (لا يمسّ printSale ولا workOrders). فوق السقف يلزم
   *  اعتمادُ مدير خادميّ (invoiceDiscountExceedsThreshold على الإجماليّ). سلسلةٌ فارغة = لا خصم. */
  invoiceDiscountPct: string;
  setInvoiceDiscountPct: (v: string) => void;
  invoiceDiscountAmount: number;
  /** false = لا سلطة على الرأس (سلّةٌ بلا بيعٍ مباشرٍ، مثلاً طباعة/تخصيص فقط). يُعطَّل الحقلُ بصرياً. */
  invoiceDiscountAllowed: boolean;
  invoiceDiscountMaxPct: number;
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
  payAll: () => void;
  couponCode: string | null; couponLabel: string | null;
  couponInput: string; setCouponInput: (v: string) => void;
  couponOpen: boolean; setCouponOpen: (v: boolean) => void;
  applyCoupon: () => void; clearCoupon: () => void; couponPending: boolean;
  submitting: boolean; cartEmpty: boolean; hasShift: boolean;
  onSubmit: (opts: { quickFullPay: boolean }) => void;
}

export function PaymentPanel({
  payInput, setPayInput,
  deferred, setDeferred,
  deferredAvailable, deferredCustomerName,
  method, setMethod,
  paymentReference, setPaymentReference,
  needPaymentRef,
  grandTotal, expectedNow, cashRoundingDelta,
  invoiceDiscountPct, setInvoiceDiscountPct, invoiceDiscountAmount, invoiceDiscountAllowed, invoiceDiscountMaxPct,
  sumDirect, sumCustom, heldDelivery, cashDueNow, orderDelivery, heldDeposit,
  paid, change, remaining, isChange, isOwing,
  hasCustom,
  depositMenuOpen, setDepositMenuOpen,
  depositOptions,
  payAll,
  couponCode, couponLabel,
  couponInput, setCouponInput,
  couponOpen, setCouponOpen,
  applyCoupon, clearCoupon, couponPending,
  submitting, cartEmpty, hasShift,
  onSubmit,
}: PaymentPanelProps) {
  // ٢٣/٨ (Codex P1 v2): حقلُ المبلغ يفصل «العرض» عن «القيمة الملتزمة». هذا يحلّ ثلاث حالات:
  // (١) الكاشير يكتب `1,` كخطوةٍ في الطريق إلى `1,5` أو `1,234` — نُبقي الحرفَ ظاهراً في الحقل
  //     لكن لا نلتزم قيمةً غير قابلةٍ للحلّ.
  // (٢) الفاصلةُ العربية `،` تُعامَل بعقد `normalizeNumberInput` نفسه: `1،5` ⇒ `1.5` (عشريّ)،
  //     `1،234` ⇒ `1234` (ألوف). نمنعُ الانحدارَين السابقَين (تحطيم الآلاف ↔ خنق العشريّ).
  // (٣) الأزرارُ السريعة/`payAll` تكتب على `payInput` مباشرةً؛ نُزامن العرضَ إن اختلف تطبيعُه.
  const [displayPay, setDisplayPay] = useState(payInput);
  useEffect(() => {
    // نُزامن العرضَ من `payInput` إن تغيّرت الأخيرة من خارج الحقل (زرّ سريع، تفريغ سلّة…) —
    // ونحرص ألّا نطمس ما يكتبه الكاشير: التطبيعُ الحيّ لعرضه يطابق القيمة الملتزمة أصلاً.
    try {
      const norm = normalizeNumberInput(displayPay).normalized;
      if (norm !== payInput) setDisplayPay(payInput);
    } catch { setDisplayPay(payInput); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payInput]);
  // قد تكون الصفحة مفتوحة قبل النشر أو تحمل حالة قديمة؛ لا نترك طريقةً خارجية خفية.
  useEffect(() => {
    if (!isPosPaymentMethodEnabled(method)) {
      setMethod("CASH");
      setPaymentReference("");
    }
  }, [method, setMethod, setPaymentReference]);

  /**
   * صدق طريقة الدفع (١٨/٨) — «لا قبض الآن»: لا مبلغ مُدخَل (أو «بدون عربون» صراحةً). عندئذٍ
   * لا تُرسَل طريقةٌ للخادم فتُختَم الفاتورة `paymentMethod = NULL` = «آجل» بالاشتقاق، ولا
   * تُعرَض طريقةٌ في الواجهة كي لا تُقرأ العملية مدفوعةً وهي ليست كذلك (بلاغ المالك).
   */
  const noCollectionNow = !deferred && !(paid > 0);

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
                if (src === "") { setInvoiceDiscountPct(""); return; }
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
                if (raw === "" || raw === "0" || raw === "0.") { setInvoiceDiscountPct(""); return; }
                const n = Number(raw);
                if (!Number.isFinite(n) || n <= 0) { setInvoiceDiscountPct(""); return; }
              }}
              placeholder="0"
              aria-label="نسبة خصم الفاتورة"
              dir="ltr"
              className="w-10 min-w-0 bg-transparent text-center text-sm font-black tabular-nums outline-none"
            />
            <span className="text-xs font-bold">%</span>
            {invoiceDiscountAmount > 0 && (
              <>
                <span className="text-xs font-black tabular-nums" dir="ltr">−{fmt(invoiceDiscountAmount)}</span>
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
          <span className="text-xs font-semibold text-muted-foreground">إجمالي الفاتورة</span>
          <span className="text-2xl font-black leading-none tabular-nums tracking-tight" dir="ltr">{fmt(expectedNow)}</span>
          <span className="text-xs text-muted-foreground">د.ع</span>
        </div>
        {/* ٨/٨ — «يدفع الزبون شاملاً التوصيل»: يجيب صراحةً «التوصيل غير محتسبٍ في الإجمالي».
            الأجرة تمريرٌ لا إيراد ⇒ لا تدخل «إجمالي الفاتورة» (الإيراد)، لكنها تظهر هنا في ما
            يدفعه الزبون فعلاً. SHOP (على المكتبة) لا يدفعه الزبون فيُستثنى. */}
        {orderDelivery && orderDelivery.feeCollection !== "SHOP" && orderDelivery.fee > 0 && (
          <div className="flex items-baseline gap-1.5 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2 py-0.5">
            <Truck aria-hidden className="size-3.5 self-center text-[var(--sem-warn)]" />
            <span className="text-[11px] font-bold text-[var(--sem-warn)]">يدفع الزبون شاملاً التوصيل</span>
            <span className="text-xl font-black leading-none tabular-nums text-[var(--sem-warn)]" dir="ltr">{fmt(expectedNow + orderDelivery.fee)}</span>
            <span className="text-[11px] text-[var(--sem-warn)]">د.ع</span>
          </div>
        )}

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
        <span className={cn(
          "rounded-md border px-1.5 py-0.5 text-[10px] font-extrabold",
          deferred || noCollectionNow
            ? "border-[var(--sem-warn)]/50 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
            : method === "CASH" ? "text-muted-foreground" : "border-[var(--sem-info)]/50 bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
        )}>
          {/* صدق طريقة الدفع (١٨/٨): بلا قبضٍ الآن لا تُسمّى طريقة — كانت تُعرض «نقدي» فتُقرأ
              العملية مدفوعةً وهي آجلة، وهو نفس الكذب الذي كان يُختَم على الفاتورة. */}
          {deferred ? "بدون عربون" : noCollectionNow ? "بلا قبض الآن" : PAY_METHOD_LABEL[method]}
        </span>
      </div>

      {deferred && (
        <div className="grid grid-cols-[auto_auto_1fr] items-center gap-x-4 rounded-lg border border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] px-3 py-1.5 text-[var(--sem-warn)]">
          <div>
            <div className="text-[9px] font-bold opacity-80">المدفوع الآن</div>
            <div className="text-base font-black tabular-nums" dir="ltr">0 د.ع</div>
          </div>
          <div>
            <div className="text-[9px] font-bold opacity-80">المتبقّي ذمّة</div>
            <div className="text-base font-black tabular-nums" dir="ltr">{fmt(expectedNow)} د.ع</div>
          </div>
          <div className="text-end text-[11px] font-extrabold">
            سيُسجَّل المبلغ ديناً على {deferredCustomerName || "العميل المرتبط"} · بلا إيصال قبض أو حركة درج
          </div>
        </div>
      )}

      {/* صفّ الإجراءات: مبلغ مدفوع + رقائق سريعة | طريقة الدفع | عربون/كوبون | زرّا الإتمام.
          pe-28 يحجز حافّة الشريط اليسرى فارغةً — شارة مزامنة الأوفلاين (fixed bottom-3 left-3
          مشتركة بكل شاشات الكاشير) تطفو فوق تلك الزاوية بالضبط في أي شاشةٍ بشريطٍ سفليّ حافّة-لحافّة. */}
      <div className="flex flex-wrap items-center gap-2 pe-28">
        <div className="flex h-10 shrink-0 items-center rounded-lg border bg-muted/40 p-1" aria-label="طريقة التحصيل">
          <button
            type="button"
            aria-pressed={!deferred}
            onClick={() => setDeferred(false)}
            className={cn(
              "h-8 rounded-md px-3 text-xs font-black transition-colors",
              !deferred ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            دفع الآن
          </button>
          <button
            type="button"
            aria-pressed={deferred}
            disabled={!deferredAvailable}
            title={deferredAvailable ? "تسجيل كامل المبلغ ذمّة على العميل" : "اربط عميلاً بهاتف عراقي أولاً"}
            onClick={() => {
              setPayInput("");
              setDeferred(true);
            }}
            className={cn(
              "h-8 rounded-md px-3 text-xs font-black transition-colors",
              deferred
                ? "bg-primary text-primary-foreground shadow-sm"
                : deferredAvailable
                  ? "text-primary hover:bg-primary/10"
                  : "cursor-not-allowed text-muted-foreground/45",
            )}
          >
            بدون عربون
          </button>
        </div>

        {!deferred && <>
        {/* المبلغ المدفوع — حقلٌ نصّي حقيقي (لوحة المفاتيح تكتب مباشرة، بلا حاسبة إضافية).
            ٢٣/٨ — بلاغ Codex P1 v2: عقد التطبيع المشترك (`shared/numberNormalize`) هو المرجع
            الوحيد: `1,5` ⇒ `1.5` (عشريّ)، `1,234` ⇒ `1234` (ألوف)، `1،5` كذلك. الحقل يعرض
            ما يكتبه الكاشير حرفياً (`displayPay`) لكن لا يلتزم قيمةً إلا إن كانت غير ملتبسة.
            الحالات الوسطى (`1,`، `1.`، `.5`) تُعرض ولا تُلتزم كي لا تتحطّم `D()`. */}
        <div className="flex h-10 items-center gap-2 rounded-lg border-[1.5px] bg-muted/40 px-3 focus-within:border-primary">
          <span className="shrink-0 text-xs text-muted-foreground">المدفوع</span>
          <input
            value={displayPay}
            onChange={(e) => {
              const src = e.target.value;
              setDisplayPay(src);
              if (src === "") { setPayInput(""); return; }
              // حدُّ محارف: أرقام + فواصل شائعة فقط. غير ذلك يُترك دون التزام.
              if (!/^[\d.,،٫\-]*$/.test(src)) return;
              const result = normalizeNumberInput(src);
              if (result.ambiguous) return;
              const n = result.normalized;
              if (!n) return;
              if (!/^-?\d+\.?\d*$|^-?\d*\.\d+$/.test(n)) return;
              if (!Number.isFinite(Number(n))) return;
              setPayInput(n);
            }}
            onFocus={(e) => e.currentTarget.select()}
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
        <button
          type="button"
          onClick={payAll}
          className="h-10 rounded-lg border-[1.5px] border-primary bg-card px-3 text-xs font-extrabold text-primary hover:bg-primary/10"
        >
          = الكل
        </button>

        <div className="mx-1 h-8 w-px shrink-0 bg-border" aria-hidden />

        {/* طريقة الدفع — أزرار أيقونة مدمجة أفقياً بدل شبكة قائمة.
            صدق طريقة الدفع (١٨/٨): بلا مبلغٍ مقبوضٍ الآن لا معنى لاختيار طريقة — يحلّ محلّها
            إفصاحٌ صريح بنفس المساحة (بلا قفزة تخطيط) ولا تُرسَل طريقةٌ للخادم أصلاً. */}
        {noCollectionNow ? (
          <div
            className="inline-flex h-10 items-center gap-1.5 rounded-lg border-2 border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] px-3 text-[11px] font-extrabold text-[var(--sem-warn)]"
            role="status"
          >
            <Landmark aria-hidden className="size-4" />
            <span>آجل — لا قبض الآن · تظهر «غير مدفوعة»</span>
          </div>
        ) : (
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
              onClick={() => { if (isPosPaymentMethodEnabled(p.v)) setMethod(p.v); }}
              disabled={!isPosPaymentMethodEnabled(p.v)}
              aria-describedby={!isPosPaymentMethodEnabled(p.v) ? "reception-external-payment-disabled" : undefined}
              title={isPosPaymentMethodEnabled(p.v) ? p.label : posPaymentRejectionMessage(p.v)}
              aria-pressed={method === p.v}
              className={cn(
                "inline-flex h-10 items-center gap-1.5 rounded-lg border-2 px-2.5 text-xs font-extrabold transition-colors",
                method === p.v
                  ? "border-primary bg-primary text-primary-foreground"
                  : isPosPaymentMethodEnabled(p.v)
                    ? "bg-card hover:bg-muted"
                    : "cursor-not-allowed bg-muted/40 text-muted-foreground/45",
              )}
            >
              <p.Icon aria-hidden className="size-4" />
              <span className="hidden lg:inline">{p.label}</span>
            </button>
          ))}
        </div>
        )}
        {!noCollectionNow && (
          <span id="reception-external-payment-disabled" className="max-w-48 text-[9px] leading-tight text-muted-foreground">
            {INBOUND_TELECOM_DISABLED_MESSAGE}
          </span>
        )}
        {needPaymentRef && !noCollectionNow && (
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
        </>}

        {/* زرّا الإتمام — يتّجهان لأقصى الشريط، جنباً إلى جنب، ثابتان دائماً (البار لا يُقصّ). */}
        <div className="ms-auto flex items-center gap-2">
          {/* ٢٣/٨: تلميحٌ ظاهرٌ على كلّ الأحجام (كان مخفياً على &lt;lg — وهي شاشات الكاشير اللوحيّة).
              الاختصار سرٌّ قبيليٌّ لا معنى له إن لم يره الكاشير. */}
          <span className="text-[9px] text-muted-foreground sm:text-[10px]">F4 دفع · F2 بحث</span>
          {!deferred && (
            <button
              type="button"
              disabled={cartEmpty || submitting || !hasShift}
              onClick={() => onSubmit({ quickFullPay: true })}
              title={
                // ٢٣/٨ (بلاغ فحص UX): زرٌّ معطَّلٌ بلا شرحٍ يترك الكاشير محتاراً — `title` يعلن السبب.
                submitting ? "جارٍ الإرسال…" :
                cartEmpty ? "أضف منتجاً أوّلاً" :
                !hasShift ? "افتح وردية استقبال أوّلاً" :
                "تحصيل المطلوب الآن وطباعة (F4)"
              }
              className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-4 text-sm font-black text-white shadow-md transition-colors hover:bg-amber-600 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
            >
              <Zap aria-hidden className="size-4" /> تحصيل المطلوب الآن وطباعة
            </button>
          )}
          <button
            type="button"
            disabled={cartEmpty || submitting || !hasShift || (deferred && !deferredAvailable)}
            onClick={() => onSubmit({ quickFullPay: false })}
            title={
              submitting ? "جارٍ الإرسال…" :
              cartEmpty ? "أضف منتجاً أوّلاً" :
              !hasShift ? "افتح وردية استقبال أوّلاً" :
              (deferred && !deferredAvailable) ? "الآجل يحتاج عميلاً مرتبطاً بهاتفٍ عراقيّ" :
              deferred ? "إتمام بدون عربون (يُسجَّل ذمّةً على العميل)" :
              "إتمام الطلب وطباعة"
            }
            className="inline-flex h-11 min-w-48 items-center justify-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-black text-primary-foreground shadow-md transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
          >
            {submitting ? (
              "جارٍ الإرسال…"
            ) : deferred ? (
              <><Printer aria-hidden className="size-4" /> إتمام بدون عربون وطباعة</>
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
