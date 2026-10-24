import { ReceptionPaymentSummary } from "./ReceptionPaymentSummary";
import { ReceptionPaymentActions } from "./ReceptionPaymentActions";
import { ReceptionTenderControls } from "./ReceptionTenderControls";
import { SplitTenderButton } from "@/components/payments/SplitTenderButton";
import type { SplitTenderDraft } from "@/components/payments/useSplitTender";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  isPosPaymentMethodEnabled,
  posPaymentRejectionMessage,
} from "@shared/posPaymentPolicy";
import { INBOUND_TELECOM_DISABLED_MESSAGE } from "@shared/inboundPaymentPolicy";
import { normalizeNumberInput } from "@shared/numberNormalize";
import { PAY_METHOD_LABEL, type PayMethod } from "./cartMath";
import { CardBrandLogos } from "@/components/ui/CardBrandLogos";

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
  splitTender?: SplitTenderDraft;
  splitDisabledReason?: string | null;
  payInput: string;
  setPayInput: (v: string) => void;
  deferred: boolean;
  setDeferred: (value: boolean) => void;
  deferredAvailable: boolean;
  deferredCustomerName: string | null;
  /** ٢٣/٨ (بلاغ المالك «الكاشير لا يفهم لماذا الزرّ معطَّل»): نصٌّ مُحسَبٌ من الأب يشرح السبب
   *  الفعليّ حين `deferredAvailable=false` — رسالة «اربط عميلاً» كانت مضلِّلة حين يكون العميل
   *  مربوطاً لكن حدّ ائتمانه صفر، أو السلّة مسوّدة، أو تخصيصاً فقط. `null` يعني «الزرّ مفعَّل». */
  deferredDisabledReason: string | null;
  method: PayMethod;
  setMethod: (m: PayMethod) => void;
  paymentReference: string;
  setPaymentReference: (v: string) => void;
  needPaymentRef: boolean;
  grandTotal: number;
  expectedNow: number;
  cashRoundingDelta: number;
  sumDirect: number;
  sumCustom: number;
  heldDelivery: number;
  cashDueNow: number;
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
  orderDelivery: {
    fee: number;
    feeCollection: "COURIER" | "COUNTER" | "SHOP";
    partyName: string;
  } | null;
  /** ش٤ — عربونٌ مقبوضٌ سلفاً على الطلب المحفوظ النشط: يُعرض ويُخصَم من «المتوقّع الآن». */
  heldDeposit: number;
  paid: number;
  change: number;
  remaining: number;
  isChange: boolean;
  isOwing: boolean;
  hasCustom: boolean;
  depositMenuOpen: boolean;
  setDepositMenuOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  /** خيارات «عربون» المنسدلة محسوبة في الصفحة (label + المبلغ المعروض + onPick). */
  depositOptions: Array<{
    label: string;
    amountLabel: string;
    onPick: () => void;
  }>;
  payAll: () => void;
  couponCode: string | null;
  couponLabel: string | null;
  couponInput: string;
  setCouponInput: (v: string) => void;
  couponOpen: boolean;
  setCouponOpen: (v: boolean) => void;
  applyCoupon: () => void;
  clearCoupon: () => void;
  couponPending: boolean;
  submitting: boolean;
  cartEmpty: boolean;
  hasShift: boolean;
  submitAllowed?: boolean;
  onSubmit: (opts: { quickFullPay: boolean; isReservation?: boolean }) => void;
  deliveryFeePayment?: {
    capturedAmount: string;
    confirmed: boolean;
    pending: boolean;
    error: string | null;
    confirm: () => void;
  };
}

export function PaymentPanel(props: PaymentPanelProps) {
  const {
    payInput,
    setPayInput,
    deferred,
    setDeferred,
    deferredAvailable,
    deferredCustomerName,
    deferredDisabledReason,
    method,
    setMethod,
    paymentReference,
    setPaymentReference,
    needPaymentRef,
    grandTotal,
    expectedNow,
    cashRoundingDelta,
    invoiceDiscountPct,
    setInvoiceDiscountPct,
    invoiceDiscountAmount,
    invoiceDiscountAllowed,
    invoiceDiscountMaxPct,
    sumDirect,
    sumCustom,
    heldDelivery,
    cashDueNow,
    orderDelivery,
    heldDeposit,
    paid,
    change,
    remaining,
    isChange,
    isOwing,
    hasCustom,
    depositMenuOpen,
    setDepositMenuOpen,
    depositOptions,
    payAll,
    couponCode,
    couponLabel,
    couponInput,
    setCouponInput,
    couponOpen,
    setCouponOpen,
    applyCoupon,
    clearCoupon,
    couponPending,
    submitting,
    cartEmpty,
    hasShift,
    submitAllowed: suppliedSubmitAllowed = true,
    onSubmit,
    deliveryFeePayment,
    splitTender,
    splitDisabledReason,
  } = props;
  const submitAllowed =
    suppliedSubmitAllowed &&
    (deliveryFeePayment?.confirmed ?? true) &&
    (!splitTender?.active || splitTender.problem(String(expectedNow)) == null);
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
    } catch {
      setDisplayPay(payInput);
    }
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
      <ReceptionPaymentSummary
        {...props}
        submitAllowed={submitAllowed}
        noCollectionNow={noCollectionNow}
      />

      {deferred && (
        <div className="grid grid-cols-[auto_auto_1fr] items-center gap-x-4 rounded-lg border border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] px-3 py-1.5 text-[var(--sem-warn)]">
          <div>
            <div className="text-[9px] font-bold opacity-80">المدفوع الآن</div>
            <div className="text-base font-black tabular-nums" dir="ltr">
              0 د.ع
            </div>
          </div>
          <div>
            <div className="text-[9px] font-bold opacity-80">المتبقّي ذمّة</div>
            <div className="text-base font-black tabular-nums" dir="ltr">
              {fmt(expectedNow)} د.ع
            </div>
          </div>
          <div className="text-end text-[11px] font-extrabold">
            سيُسجَّل المبلغ ديناً على {deferredCustomerName || "العميل المرتبط"}{" "}
            · بلا إيصال قبض أو حركة درج
          </div>
        </div>
      )}

      {deliveryFeePayment && heldDelivery > 0 && method !== "CASH" && (
        <div className="flex flex-wrap items-center gap-2 border-y px-3 py-2 text-xs">
          <span>
            {splitTender?.active
              ? "أجرة التوصيل في عملية مستقلة:"
              : "البضاعة والأجرة في عملية واحدة:"}{" "}
            <strong dir="ltr">{deliveryFeePayment.capturedAmount} د.ع</strong> —
            بلا حركة نقد درج
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              deliveryFeePayment.pending || deliveryFeePayment.confirmed
            }
            onClick={deliveryFeePayment.confirm}
          >
            {deliveryFeePayment.confirmed
              ? "الدفع مؤكد"
              : "تأكيد نجاح الدفع لدى المزوّد"}
          </Button>
          {deliveryFeePayment.error && (
            <p role="alert" className="text-destructive">
              {deliveryFeePayment.error}
            </p>
          )}
        </div>
      )}
      {splitTender?.active && splitTender.problem(String(expectedNow)) && (
        <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
          {splitTender.problem(String(expectedNow))}
        </p>
      )}
      {/* صفّ الإجراءات: مبلغ مدفوع + رقائق سريعة | طريقة الدفع | عربون/كوبون | زرّا الإتمام.
          pe-28 يحجز حافّة الشريط اليسرى فارغةً — شارة مزامنة الأوفلاين (fixed bottom-3 left-3
          مشتركة بكل شاشات الكاشير) تطفو فوق تلك الزاوية بالضبط في أي شاشةٍ بشريطٍ سفليّ حافّة-لحافّة. */}
      {splitTender?.active && splitTender.problem(String(expectedNow)) && (
        <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
          {splitTender.problem(String(expectedNow))}
        </p>
      )}
      {/* صفّ الإجراءات: مبلغ مدفوع + رقائق سريعة | طريقة الدفع | عربون/كوبون | زرّا الإتمام */}
      <div className="flex flex-wrap items-center justify-between gap-3 pe-28">
        <ReceptionTenderControls
          {...props}
          displayPay={displayPay}
          setDisplayPay={setDisplayPay}
        />

        <ReceptionPaymentActions
          {...props}
          submitAllowed={submitAllowed}
          noCollectionNow={noCollectionNow}
        />
      </div>
    </div>
  );
}
