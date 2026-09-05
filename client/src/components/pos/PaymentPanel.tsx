// لوحة الدفع في الكاشير: المبلغ/الكوبون/طرق الدفع/مرجع الإثبات/الاستحقاق — وتفوّض الإجماليّات والنمباد ومنطقة الفعل لأجزائها.
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import { useMediaQuery } from "@/hooks/useMobile";
import { useEffect, useState } from "react";
import { Check, X, AlertTriangle, Banknote, CreditCard, ChevronDown, ChevronUp, Send, Wallet, Calculator } from "lucide-react";
import { PaymentReferenceField } from "@/components/pos/PaymentReferenceField";
import { POS_EXTERNAL_PAYMENT_PROOF_HINT } from "@shared/posPaymentPolicy";
import { normalizeNumberInput } from "@shared/numberNormalize";
import { type PaymentMethod, type NumMode, QUICK_AMTS, fmt, type PosColors as C } from "./posShared";
import { PaymentTotals } from "./PaymentTotals";
import { Numpad } from "./Numpad";
import { PaymentActions } from "./PaymentActions";

export interface PaymentPanelProps {
  C: C;
  total: number; payInput: string;
  /** المجموع قبل خصم رأس الفاتورة (subtotal). = total إن كان الخصم صفراً. */
  subtotal: number;
  /** مبلغ خصم رأس الفاتورة المُحتسَب من النسبة، للعرض والتحقّق البصريّ. */
  invoiceDiscountAmount: number;
  /** نصّ نسبة خصم رأس الفاتورة (٠–١٥) — سلسلة كي تقبل حالة «فارغ = صفر». */
  invoiceDiscountPct: string;
  setInvoiceDiscountPct: (value: string) => void;
  invoiceDiscountType?: "percent" | "amount";
  invoiceDiscountValue?: string;
  onInvoiceDiscountChange?: (value: string, type: "percent" | "amount") => void;
  maxDiscountAmount?: number;
  /** false ⇒ الحقل غير مسموحٍ (مثلاً سلّة كرت رقميّ) — يُعطَّل بصرياً وتبطل قيمته الفعلية. */
  invoiceDiscountAllowed: boolean;
  /** السقفُ الفعّال المتبقّي بالنقاط المئوية (يُقصّ سلطةَ الكاشير حين توجد خصوماتُ سطرٍ مسبقة). */
  effectiveHeaderCapPct: number;
  /** فرقُ التقريب النقديّ الحاليّ (± د.ع) — يُعرض إفصاحاً حين لا يكون صفراً. */
  cashRoundingDelta: number;
  setPayInput: (updater: string | ((s: string) => string)) => void;
  paid: number; change: number; credit: number;
  isChange: boolean; isOwing: boolean;
  method: PaymentMethod; setMethod: (m: PaymentMethod) => void;
  paymentRef: string; setPaymentRef: (v: string) => void;
  externalPaymentConfirmed: boolean; externalPaymentPending: boolean; onConfirmExternalPayment: () => void;
  dueDate: string; setDueDate: (v: string) => void;
  numMode: NumMode; setNumMode: (m: NumMode) => void;
  numPress: (k: string) => void;
  onPay: () => void; onQuickPay: () => void;
  cartLen: number; selId: number | null;
  isPending: boolean; canPay: boolean; hasCustomer: boolean;
  saleError: string | null; onDismissError: () => void;
  stacked: boolean;
  couponInput: string; couponCode: string | null; couponLabel: string | null;
  setCouponInput: (value: string) => void; onApplyCoupon: () => void; onClearCoupon: () => void;
  couponPending: boolean;
}

export function PaymentPanel({ C, total, subtotal, invoiceDiscountAmount, invoiceDiscountPct, setInvoiceDiscountPct, invoiceDiscountAllowed, effectiveHeaderCapPct, cashRoundingDelta, payInput, setPayInput, paid, change, credit, isChange, isOwing, method, setMethod, paymentRef, setPaymentRef, externalPaymentConfirmed, externalPaymentPending, onConfirmExternalPayment, dueDate, setDueDate, numMode, setNumMode, numPress, onPay, onQuickPay, cartLen, isPending, canPay, hasCustomer, saleError, onDismissError, stacked, couponInput, couponCode, couponLabel, setCouponInput, onApplyCoupon, onClearCoupon, couponPending, invoiceDiscountType, invoiceDiscountValue, onInvoiceDiscountChange, maxDiscountAmount }: PaymentPanelProps) {

  // ── الاحتواء الديناميكي: تركيبٌ متكيّف قبل المقياس ───────────────────────────
  // شاشات الكاشير الفيزيائية صغيرة، والمطلوب وضوحٌ وكِبَرٌ لا انكماش. لذلك عند ضيق
  // الارتفاع **يُحذف الثانويّ** (رقائق المبالغ، الكوبون، سطور التلميح) ويُعاد تركيب
  // طرق الدفع صفّاً واحداً — بدل تصغير الأساسيّ. الحدّ الأدنى للمفتاح 44px (هدف
  // اللمس المعياريّ) فلا ينزل تحته مهما ضاقت المساحة، والتمرير يبقى شبكة أمانٍ
  // أخيرة لا تُبلَغ في مدى التشغيل الفعليّ.
  const dense = useMediaQuery("(max-height: 820px)");
  const ultra = useMediaQuery("(max-height: 660px)");
  // ٢٣/٨ (Codex P1 v2): حقلُ المبلغ يفصل «العرض» (raw ما يكتبه الكاشير) عن «القيمة الملتزمة»
  // (`payInput` المطبَّعة). عقد التطبيع من `shared/numberNormalize` هو المرجع — `1,5` ⇒ `1.5`،
  // `1,234` ⇒ `1234`، `1،5` كذلك. الحالات الوسطى الملتبسة تبقى في العرض ولا تُلتزم كي لا تتحطّم
  // `D()` عليها. الأزرارُ السريعة/`+/-` تكتب على `payInput` مباشرةً؛ نُزامن العرضَ حينها.
  const [displayPay, setDisplayPay] = useState(payInput);
  useEffect(() => {
    try {
      const norm = normalizeNumberInput(displayPay).normalized;
      if (norm !== payInput) setDisplayPay(payInput);
    } catch { setDisplayPay(payInput); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payInput]);
  const [couponOpen, setCouponOpen] = useState(false);
  // الكوبون يظهر دائماً وهو مُطبَّق (لا يُخفى خصمٌ سارٍ)، أو عند طلبه صراحةً.
  const showCoupon = !!couponCode || couponOpen;
  // ٢٣/٨ — طيّ لوحة الأرقام: الشاشات القصيرة (dense) كانت تُخفي طرقَ الدفع تحت التمرير لأنّ
  // اللوحةَ داخل منطقة تمرير مشتركة. الطيّ يُعيد ~٢٠٠px عمودياً فتظهر الأزرارُ كلّها بلا تمرير.
  // الافتراضي: مطويّة على dense، مفتوحة على الشاشات الطويلة. القرارُ محفوظٌ في localStorage
  // فيبقى تفضيلُ الكاشير بين الجلسات. حقلُ المبلغ يقبل الكتابةَ المباشرة بلوحة المفاتيح (بلا حاجة
  // إلى النمباد أصلاً على أجهزة الديسك)، والأزرارُ الثلاثة (كمية/%/مبلغ) تُبقي اللمس ممكناً
  // بفتح اللوحة تلقائياً عند اختيار وضعِ كميةٍ أو خصم.
  const [numpadOpen, setNumpadOpen] = useState<boolean>(() => {
    try {
      const stored = typeof window !== "undefined" ? window.localStorage.getItem("pos.numpadOpen") : null;
      if (stored === "1") return true;
      if (stored === "0") return false;
    } catch { /* localStorage may be blocked */ }
    return !dense;
  });
  const persistNumpad = (open: boolean) => {
    setNumpadOpen(open);
    try { window.localStorage.setItem("pos.numpadOpen", open ? "1" : "0"); } catch { /* ignore */ }
  };
  // فتحٌ تلقائيّ عند اختيار وضع «الكمية» أو «%»: بلا نمباد لا سبيل لتعديلهما هنا (مجهود لمس)،
  // فيُفتح تلقائياً كي لا يعمى الكاشير عن مدخلٍ لا يراه. وضعُ «المبلغ» يبقى قابلاً للطيّ لأنّ
  // الحقل نفسه صار `<input>` يقبل الكتابة المباشرة.
  const setNumModeAndReveal = (m: NumMode) => {
    setNumMode(m);
    if ((m === "QTY" || m === "DISC") && !numpadOpen) persistNumpad(true);
  };
  const showQuickPay = !hasCustomer && !isOwing;
  // حشوة الكتل الداخلية تضيق في أضيق مستوى — آخر ما يُقتطع بعد حذف الثانويّ،
  // ولا يمسّ مقاسات الأزرار نفسها (تبقى ≥44px).
  const blockPad = ultra ? "2px 11px 0" : "4px 11px 3px";

  // `cqh` تقيس ارتفاع اللوحة الفعليّ (لا الشاشة) ⇒ تتبع الزوم والدقّة والنافذة
  // بآليّةٍ واحدة. مكدَّساً يحدّد المحتوى ارتفاع اللوحة و`contain:size` الذي
  // يستلزمه container-type كان يطويها ⇒ نقيس هناك بالشاشة.
  const HU = stacked ? "vh" : "cqh";
  const fluid = (min: number, ratio: number, max: number) => `clamp(${min}px, ${ratio}${HU}, ${max}px)`;

  const payMethodStyle = (active: boolean, disabled = false): React.CSSProperties => ({
    flex: 1, display: "flex", flexDirection: "row" as const, alignItems: "center", justifyContent: "center",
    gap: 4, height: fluid(32, 4.4, 38), fontSize: dense ? 12 : 12.5, fontWeight: 800,
    border: `2px solid ${active ? C.primary : C.border}`,
    borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit",
    background: active ? C.primary : C.card, color: active ? C.primaryFg : C.fg,
    transition: "background .1s, color .1s, border-color .1s, box-shadow .1s", userSelect: "none" as const,
    boxShadow: active ? `0 2px 8px color-mix(in oklch, ${C.primary} 28%, transparent)` : "none",
    opacity: disabled ? 0.55 : 1,
  });

  const modeLabel = numMode === "QTY"  ? "الكمية — المنتج المحدد"
    : numMode === "DISC" ? "خصم % على المنتج"
    : "المبلغ المستلم";

  return (
    <div style={{
      width: stacked ? "100%" : 420, maxWidth: "100%",
      // مكدَّساً: تشارك المساحة وتنكمش. كانت flexShrink:0 بارتفاعها الطبيعيّ ⇒ تفيض فتُقصّ.
      ...(stacked ? { flex: "1 1 auto" } : { flexShrink: 0 }),
      minHeight: 0,
      display: "flex", flexDirection: "column",
      containerType: stacked ? undefined : "size",
      background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden",
    }}>

      {/* خطأ بيع حرِج ثابت (بديل toast العابر) — يبقى ظاهراً حتى محاولة جديدة/إغلاق يدوي */}
      {saleError && (
        <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "8px 12px", background: C.dangerSoft, borderBottom: `1px solid ${C.danger}`, color: C.danger, fontSize: 12.5, fontWeight: 700, flexShrink: 0 }}>
          <AlertTriangle aria-hidden size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ flex: 1, lineHeight: 1.4 }}>{saleError}</span>
          <button onClick={onDismissError} aria-label="إغلاق التنبيه" style={{ background: "none", border: "none", cursor: "pointer", color: C.danger, lineHeight: 1, padding: 0, display: "inline-flex", flexShrink: 0 }}><X aria-hidden size={15} /></button>
        </div>
      )}

      {/* Total */}
      <PaymentTotals
        C={C} ultra={ultra} fluid={fluid}
        total={total} subtotal={subtotal}
        invoiceDiscountAmount={invoiceDiscountAmount}
        invoiceDiscountPct={invoiceDiscountPct} setInvoiceDiscountPct={setInvoiceDiscountPct}
        invoiceDiscountAllowed={invoiceDiscountAllowed}
        effectiveHeaderCapPct={effectiveHeaderCapPct}
        cashRoundingDelta={cashRoundingDelta}
        invoiceDiscountType={invoiceDiscountType}
        invoiceDiscountValue={invoiceDiscountValue}
        onInvoiceDiscountChange={onInvoiceDiscountChange}
        maxDiscountAmount={maxDiscountAmount}
      />

      {/* منطقة الإدخال — الوحيدة القابلة للتمرير. شبكة الأمان: مهما ضاق الارتفاع
          (زوم/دقّة/تكبير خطّ النظام) تُمرَّر هذه وحدها، ويبقى الإجمالي فوقها وأزرار
          الدفع تحتها ظاهرَين دائماً. بلا هذا كان الفائض يُقصّ بصمت بلا شريط تمرير. */}
      {/* منطقة الإدخال — أزرار الدفع والمبلغ والنمباد مصفوفة بذكاء لتفادي أي تمرير */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", scrollbarWidth: "thin" }}>

      {/* طريقة الدفع — ٤ أزرار متساوية في صفٍّ واحد بأعلى اللوحة لسرعة الاختيار */}
      <div style={{ padding: "4px 11px 2px", flexShrink: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 5 }}>
          <button type="button" style={payMethodStyle(method === "CASH")}     onClick={() => setMethod("CASH")}>
            <Banknote aria-hidden size={16} />نقدي
          </button>
          <button type="button" style={payMethodStyle(method === "CARD")}     onClick={() => setMethod("CARD")}>
            <CreditCard aria-hidden size={16} />بطاقة
          </button>
          <button type="button" style={payMethodStyle(method === "TRANSFER")} onClick={() => setMethod("TRANSFER")}>
            <Send aria-hidden size={16} />تحويل
          </button>
          <button type="button" style={payMethodStyle(method === "WALLET")}   onClick={() => setMethod("WALLET")}>
            <Wallet aria-hidden size={16} />محفظة
          </button>
        </div>
        {method !== "CASH" && (
          <div id="pos-external-payment-proof" role="status" style={{ marginTop: 4, display: "flex", alignItems: "flex-start", gap: 5, color: C.mutedFg, fontSize: 11, fontWeight: 700, lineHeight: 1.4 }}>
            <AlertTriangle aria-hidden size={13} style={{ marginTop: 1, flexShrink: 0 }} />
            <span>{POS_EXTERNAL_PAYMENT_PROOF_HINT}</span>
          </div>
        )}
      </div>

      {/* Amount display — حقل إدخال المبلغ وزر طي النمباد */}
      <div style={{ padding: "2px 11px 0", flexShrink: 0 }}>
        <div style={{ background: C.muted, border: `1.5px solid ${C.border}`, borderRadius: 8, padding: "2px 8px 2px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, minHeight: fluid(ultra ? 32 : 36, 4.8, 42) }}>
          <span style={{ fontSize: 12, color: C.mutedFg, flexShrink: 0 }}>{modeLabel}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, justifyContent: "flex-end" }}>
            {numMode === "PAY" ? (
              <input
                type="text"
                inputMode="decimal"
                value={displayPay}
                onChange={(e) => {
                  const src = e.target.value;
                  setDisplayPay(src);
                  if (src === "") { setPayInput(""); return; }
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
                placeholder="0"
                aria-label="المبلغ المستلم من الزبون"
                style={{
                  flex: 1, minWidth: 0, maxWidth: 180,
                  border: "none", outline: "none", background: "transparent",
                  fontSize: fluid(18, 2.6, 22), fontWeight: 900, direction: "ltr",
                  textAlign: "left", fontFamily: "inherit",
                  color: payInput ? (isOwing ? C.amber : C.primary) : C.fg,
                }}
              />
            ) : (
              <span style={{ fontSize: fluid(18, 2.6, 22), fontWeight: 900, direction: "ltr", marginRight: 6, color: C.mutedFg }}>—</span>
            )}
            <button
              type="button"
              onClick={() => persistNumpad(!numpadOpen)}
              aria-label={numpadOpen ? "إخفاء لوحة الأرقام" : "إظهار لوحة الأرقام"}
              title={numpadOpen ? "إخفاء لوحة الأرقام لتوسيع طرق الدفع" : "إظهار لوحة الأرقام للكاشير اللمسيّ"}
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 3,
                height: 26, padding: "0 6px",
                border: `1.5px solid ${numpadOpen ? C.primary : C.border}`,
                borderRadius: 6,
                background: numpadOpen ? C.primary : C.card,
                color: numpadOpen ? C.primaryFg : C.mutedFg,
                fontFamily: "inherit", fontSize: 11, fontWeight: 800, cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <Calculator aria-hidden size={12} />
              {numpadOpen ? <ChevronUp aria-hidden size={12} /> : <ChevronDown aria-hidden size={12} />}
            </button>
          </div>
        </div>
      </div>

      {/* Quick amounts — رقائق المبالغ السريعة للنقد فقط */}
      {numMode === "PAY" && method === "CASH" && !dense && (
        <div style={{ padding: "2px 11px 0", display: "flex", gap: 3, flexWrap: "wrap", flexShrink: 0 }}>
          {QUICK_AMTS.map((a) => (
            <button key={a} type="button" onClick={() => setPayInput(String(a))}
              style={{ height: fluid(24, 3.8, 30), padding: "0 8px", background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer", fontSize: 11.5, fontWeight: 700, color: C.fg, fontFamily: "inherit" }}>
              {fmt(a)}
            </button>
          ))}
          {cartLen > 0 && (
            <button type="button" onClick={() => setPayInput(String(total))}
              style={{ height: fluid(24, 3.8, 30), padding: "0 8px", background: C.card, border: `1px solid ${C.primary}`, borderRadius: 6, cursor: "pointer", fontSize: 11.5, fontWeight: 700, color: C.primary, fontFamily: "inherit" }}>
              = الكل
            </button>
          )}
        </div>
      )}

      {/* Numpad */}
      <Numpad
        C={C} fluid={fluid} blockPad={blockPad} ultra={ultra}
        numMode={numMode} numpadOpen={numpadOpen}
        setNumModeAndReveal={setNumModeAndReveal} numPress={numPress}
      />

      {/* مرجع ومحاولة الدفع غير النقدي — لا يُفتح الإتمام قبل CONFIRMED خادمية */}
      <PaymentReferenceField
        value={paymentRef}
        onChange={setPaymentRef}
        method={method}
        confirmed={externalPaymentConfirmed}
        confirming={externalPaymentPending}
        onConfirm={onConfirmExternalPayment}
        inputId="pos-payment-reference"
        colors={{ border: C.border, muted: C.muted, mutedFg: C.mutedFg, fg: C.fg, amber: C.amber, success: C.success }}
        style={{ padding: blockPad, flexShrink: 0 }}
      />

      {/* تاريخ استحقاق الآجل (اختياري) — يظهر مع دفعة جزئية فقط */}
      {isOwing && (
        <div style={{ padding: blockPad, flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <label htmlFor="pos-due-date" style={{ fontSize: 11.5, color: C.mutedFg, fontWeight: 700, whiteSpace: "nowrap" }}>
            تاريخ استحقاق الآجل (اختياري)
          </label>
          <input
            id="pos-due-date"
            type="date"
            dir="ltr"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            style={{ flex: 1, minWidth: 0, height: 32, border: `1.5px solid ${C.border}`, borderRadius: 7, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, padding: "0 8px", outline: "none", boxSizing: "border-box" }}
          />
        </div>
      )}

      {/* كوبون CRM — مطوي اختياري لتوفير المساحة إلا عند طلبه أو تفعيله */}
      <div style={{ padding: "2px 11px 2px", flexShrink: 0 }}>
        {!showCoupon ? (
          <button
            type="button"
            onClick={() => setCouponOpen(true)}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: "2px 0", cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: C.primary }}
          >
            <ChevronDown aria-hidden size={12} /> هل لديك كوبون خصم؟
          </button>
        ) : (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
              <span style={{ fontSize: 11, color: C.mutedFg, fontWeight: 700 }}>كوبون خصم</span>
              {!couponCode && (
                <button type="button" onClick={() => setCouponOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: C.mutedFg, fontSize: 11, fontFamily: "inherit" }}>إغلاق</button>
              )}
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <input
                value={couponInput}
                onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === "Enter") onApplyCoupon(); }}
                placeholder="رمز الكوبون"
                disabled={!cartLen || couponPending}
                style={{ minWidth: 0, flex: 1, height: 28, border: `1.5px solid ${couponCode ? C.success : C.border}`, borderRadius: 6, background: C.muted, color: C.fg, padding: "0 8px", fontFamily: "inherit", fontSize: 11.5, fontWeight: 800, direction: "ltr" }}
              />
              {couponCode ? (
                <button type="button" onClick={onClearCoupon} style={{ height: 28, padding: "0 8px", border: `1px solid ${C.danger}`, borderRadius: 6, background: C.dangerSoft, color: C.danger, fontFamily: "inherit", fontSize: 11.5, fontWeight: 800, cursor: "pointer" }}>إزالة</button>
              ) : (
                <button type="button" disabled={!cartLen || !couponInput.trim() || couponPending} onClick={onApplyCoupon} style={{ height: 28, padding: "0 10px", border: 0, borderRadius: 6, background: C.primary, color: C.primaryFg, fontFamily: "inherit", fontSize: 11.5, fontWeight: 800, cursor: "pointer" }}>{couponPending ? "…" : "تطبيق"}</button>
              )}
            </div>
            {couponCode && (
              <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: C.success, fontWeight: 800, marginTop: 2 }}>
                <Check size={12} aria-hidden="true" />
                <span>{couponLabel ?? couponCode}</span>
              </div>
            )}
          </div>
        )}
      </div>

      </div>{/* ← نهاية منطقة الإدخال القابلة للتمرير */}

      {/* منطقة الفعل — خارج التمرير ولا تنكمش أبداً: الباقي/المتبقي + زرّا الدفع.
          هذه هي الضمانة الصلبة بأنّ زرّ الدفع لا يختفي مهما بلغ الزوم. */}
      <PaymentActions
        C={C} dense={dense} ultra={ultra} fluid={fluid}
        total={total} cartLen={cartLen} payInput={payInput}
        isChange={isChange} isOwing={isOwing} change={change} credit={credit}
        showQuickPay={showQuickPay}
        canPay={canPay} isPending={isPending} hasCustomer={hasCustomer}
        method={method} externalPaymentConfirmed={externalPaymentConfirmed}
        onPay={onPay} onQuickPay={onQuickPay}
      />{/* ← نهاية منطقة الفعل */}
    </div>
  );
}
