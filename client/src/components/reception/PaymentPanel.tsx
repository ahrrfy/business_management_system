import { useEffect, useState } from "react";
import {
  ArrowLeftRight,
  Banknote,
  BookmarkCheck,
  Check,
  ChevronDown,
  CreditCard,
  Landmark,
  Percent,
  Printer,
  ShieldCheck,
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
  /** ٢٣/٨ (بلاغ المالك «الكاشير لا يفهم لماذا الزرّ معطَّل»): نصٌّ مُحسَبٌ من الأب يشرح السبب
   *  الفعليّ حين `deferredAvailable=false` — رسالة «اربط عميلاً» كانت مضلِّلة حين يكون العميل
   *  مربوطاً لكن حدّ ائتمانه صفر، أو السلّة مسوّدة، أو تخصيصاً فقط. `null` يعني «الزرّ مفعَّل». */
  deferredDisabledReason: string | null;
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
  onSubmit: (opts: { quickFullPay: boolean; isReservation?: boolean }) => void;
}

const POS_METHODS: Array<{ v: PayMethod; label: string }> = [
  { v: "CASH", label: "نقدي" },
  { v: "CARD", label: "بطاقة" },
];

export function PaymentPanel({
  payInput, setPayInput,
  deferred, setDeferred,
  deferredAvailable, deferredCustomerName, deferredDisabledReason,
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
          <span className="inline-flex items-baseline gap-1.5 rounded-md bg-[var(--sem-pos-bg)] px-2 py-0.5">
            <span className="text-xs font-bold text-[var(--sem-pos)]">الفكّة:</span>
            <span className="text-lg font-black tabular-nums text-[var(--sem-pos)]" dir="ltr">{fmt(change)}</span>
          </span>
        )}
        {isOwing && (
          <span className="inline-flex items-baseline gap-1.5 rounded-md bg-[var(--sem-warn-bg)] px-2 py-0.5">
            <span className="text-xs font-bold text-[var(--sem-warn)]">متبقّي:</span>
            <span className="text-lg font-black tabular-nums text-[var(--sem-warn)]" dir="ltr">{fmt(remaining)}</span>
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
      {/* صفّ الإجراءات: مبلغ مدفوع + رقائق سريعة | طريقة الدفع | عربون/كوبون | زرّا الإتمام */}
      <div className="flex flex-wrap items-center justify-between gap-3 pe-28">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border bg-card p-1">
            <span className="px-2 text-xs font-bold text-muted-foreground">المدفوع:</span>
            <input
              type="text"
              inputMode="decimal"
              value={displayPay}
              onChange={(e) => {
                const val = e.target.value;
                setDisplayPay(val);
                try {
                  const norm = normalizeNumberInput(val).normalized;
                  setPayInput(norm);
                } catch {
                  setPayInput(val);
                }
              }}
              className="h-8 w-24 rounded bg-transparent px-2 text-sm font-black tabular-nums outline-none focus:bg-accent/50"
              dir="ltr"
              placeholder="0"
            />
            <button
              type="button"
              onClick={payAll}
              className="rounded bg-muted px-2 py-1 text-xs font-bold text-muted-foreground hover:bg-primary/20 hover:text-primary"
            >
              = الكل
            </button>
          </div>

          <div className="flex rounded-lg border bg-card p-0.5">
            {POS_METHODS.map((p) => (
              <button
                key={p.v}
                type="button"
                disabled={!isPosPaymentMethodEnabled(p.v)}
                onClick={() => setMethod(p.v)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-bold transition-colors",
                  method === p.v ? "bg-primary text-primary-foreground shadow-xs" : "text-muted-foreground hover:bg-muted",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          {method !== "CASH" && (
            <div
              className={cn(
                "flex items-center rounded-lg border bg-card p-1 shadow-xs transition-colors",
                needPaymentRef && !paymentReference.trim()
                  ? "border-[var(--sem-warn)] ring-1 ring-[var(--sem-warn)]/30"
                  : "border-primary/40",
              )}
            >
              <CreditCard aria-hidden className="size-4 text-primary ms-1" />
              <span className="px-1.5 text-xs font-bold text-muted-foreground whitespace-nowrap">
                {method === "CARD" ? "رقم العملية:" : "رقم المرجع:"}
              </span>
              <input
                type="text"
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
                placeholder={
                  method === "CARD"
                    ? "رقم إيصال الـ POS"
                    : method === "WALLET"
                      ? "رقم عملية المحفظة"
                      : "رقم العملية"
                }
                className="h-8 w-36 rounded bg-transparent px-2 text-xs font-bold outline-none focus:bg-accent/50 text-foreground placeholder:text-muted-foreground/60"
                dir="ltr"
                autoFocus
              />
              {paymentReference && (
                <button
                  type="button"
                  onClick={() => setPaymentReference("")}
                  className="p-1 text-muted-foreground hover:text-foreground"
                  title="مسح"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              )}
            </div>
          )}

          {deferredAvailable && (
            <button
              type="button"
              onClick={() => setDeferred(!deferred)}
              className={cn("rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors", deferred ? "border-[var(--sem-warn)] bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]" : "text-muted-foreground hover:bg-muted")}
            >
              آجل (ذمّة)
            </button>
          )}

          {hasCustom && (
            <span className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-bold",
              paid > 0
                ? "border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
                : "border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
            )}>
              <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0" />
              <span>
                {paid > 0
                  ? (paid >= expectedNow
                      ? "دفع كامل للطلب وإرسال للتنفيذ"
                      : `عربون مقبوض: ${fmt(paid)} د.ع · متبقٍّ للتسليم: ${fmt(remaining)} د.ع`)
                  : "حجز مؤقت للتنفيذ · الدفع عند الاستلام"}
              </span>
            </span>
          )}
        </div>

        <div className="ms-auto flex items-center gap-2">
          {hasCustom ? (
            <>
              {paid > 0 ? (
                <>
                  <button
                    type="button"
                    disabled={cartEmpty || submitting || !hasShift}
                    onClick={() => onSubmit({ quickFullPay: false, isReservation: true })}
                    title="حفظ بدون دفعة وتأجيل كامل المبلغ للدفع عند الاستلام"
                    className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg border-2 border-primary/80 bg-primary/5 px-3 text-xs font-black text-primary shadow-xs transition-colors hover:bg-primary/15 disabled:bg-muted disabled:text-muted-foreground disabled:border-transparent disabled:shadow-none"
                  >
                    <BookmarkCheck aria-hidden className="size-4" />
                    <span>حجز مؤقت (بلا دفعة)</span>
                  </button>
                  {paid < expectedNow && (
                    <button
                      type="button"
                      disabled={cartEmpty || submitting || !hasShift}
                      onClick={() => onSubmit({ quickFullPay: true })}
                      title="تحصيل الإجمالي كاملاً وطباعة"
                      className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--sem-warn)] px-3 text-xs font-black text-background shadow-md transition-colors hover:bg-[var(--sem-warn)]/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
                    >
                      <Zap aria-hidden className="size-4" />
                      <span>تحصيل الإجمالي وطباعة</span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={cartEmpty || submitting || !hasShift}
                    onClick={() => onSubmit({ quickFullPay: false })}
                    title={paid >= expectedNow ? "قبض المبلغ كاملاً وإرسال للتنفيذ" : "قبض الدفعة/العربون وإرسال للتنفيذ"}
                    className="inline-flex h-11 min-w-44 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-black text-primary-foreground shadow-md transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
                  >
                    {submitting ? (
                      "جارٍ الإرسال…"
                    ) : (
                      <>
                        <Check aria-hidden className="size-4" />
                        <span>{paid >= expectedNow ? "قبض المبلغ كاملاً وإرسال للتنفيذ" : "قبض الدفعة وإرسال للتنفيذ"}</span>
                      </>
                    )}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={cartEmpty || submitting || !hasShift}
                    onClick={() => onSubmit({ quickFullPay: true })}
                    title="تحصيل الإجمالي كاملاً وطباعة (F4)"
                    className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--sem-warn)] px-4 text-sm font-black text-background shadow-md transition-colors hover:bg-[var(--sem-warn)]/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
                  >
                    <Zap aria-hidden className="size-4" />
                    <span>تحصيل الإجمالي وطباعة</span>
                  </button>
                  <button
                    type="button"
                    disabled={cartEmpty || submitting || !hasShift}
                    onClick={() => onSubmit({ quickFullPay: false, isReservation: true })}
                    title="حفظ وحجز الطلب للتنفيذ والدفع عند الاستلام"
                    className="inline-flex h-11 min-w-48 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-black text-primary-foreground shadow-md transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
                  >
                    {submitting ? (
                      "جارٍ الإرسال…"
                    ) : (
                      <>
                        <BookmarkCheck aria-hidden className="size-4" />
                        <span>حجز مؤقت وإرسال للتنفيذ</span>
                      </>
                    )}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={cartEmpty || submitting || !hasShift}
                onClick={() => onSubmit({ quickFullPay: false, isReservation: true })}
                title="حفظ وحجز الفاتورة لتكون جاهزة في شاشة التسليم المباشر أو الإسناد للتوصيل"
                className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg border-2 border-primary/80 bg-primary/5 px-4 text-sm font-black text-primary shadow-xs transition-colors hover:bg-primary/15 disabled:bg-muted disabled:text-muted-foreground disabled:border-transparent disabled:shadow-none"
              >
                <BookmarkCheck aria-hidden className="size-4" />
                <span>حفظ وحجز الفاتورة</span>
              </button>
              {!deferred && (
                <button
                  type="button"
                  disabled={cartEmpty || submitting || !hasShift}
                  onClick={() => onSubmit({ quickFullPay: true })}
                  title="تحصيل المطلوب الآن وطباعة (F4)"
                  className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--sem-warn)] px-4 text-sm font-black text-background shadow-md transition-colors hover:bg-[var(--sem-warn)]/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
                >
                  <Zap aria-hidden className="size-4" />
                  <span>تحصيل المطلوب وطباعة</span>
                </button>
              )}
              <button
                type="button"
                disabled={cartEmpty || submitting || !hasShift || (deferred && !deferredAvailable)}
                onClick={() => onSubmit({ quickFullPay: !deferred && paid <= 0 })}
                title="إتمام البيع المباشر"
                className="inline-flex h-11 min-w-44 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-black text-primary-foreground shadow-md transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
              >
                {submitting ? (
                  "جارٍ الإرسال…"
                ) : (
                  <>
                    <Check aria-hidden className="size-4" />
                    <span>إتمام البيع المباشر</span>
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
