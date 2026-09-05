// سلّة الكاشير: الرأس (العميل/التفريغ) + جدول السطور بحارس المخزون الليّن + التذييل.
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import { variantDisplayName } from "@shared/variantDisplay";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useEffect, useRef } from "react";
import { ShoppingCart, X, AlertTriangle, CreditCard, PackagePlus } from "lucide-react";
import { digitalOfferingDescription, digitalOfferingTypeLabel } from "@shared/digitalSale";
import { type Tier, type NumMode, type CartItem, lineIdOf, fmt, effectivePrice, itemTotal, type PosColors as C } from "./posShared";
import { CartCustomerButton } from "./CartCustomerButton";
import { CartDeliveryPanel } from "./CartDeliveryPanel";
import type { DeliveryCustomerIdentity } from "./DeliveryCustomerSection";
import { emptyDeliveryDraft, type DeliveryDraft } from "./deliveryMode";

export interface CartPanelProps {
  C: C;
  branchId: number;
  branchName: string;
  cart: CartItem[]; total: number;
  selId: number | null; setSelId: (id: number | null) => void;
  changeQty: (id: number, qty: number) => void;
  removeRow: (id: number) => void;
  numMode: NumMode; setNumMode: (m: NumMode) => void;
  customerId: number | null;
  selectedCustomer:
    | RouterOutputs["customers"]["list"][number]
    | NonNullable<RouterOutputs["customers"]["get"]>
    | null;
  tierOverride: Tier | null; effectiveTier: Tier;
  setTierOvr: (v: Tier | null) => void;
  setCustId: (id: number | null) => void;
  showCustPicker: boolean; setShowCustPicker: (v: boolean) => void;
  onClear: () => void;
  /** «وضع الافتتاح» فعّال الآن (لافتة + وسم «غير مجرود» بدل «نافذ» المخيف). */
  openingActive: boolean;
  openingEndsYmd: string | null;
  /** ٢٣/٨ (Codex P2) — عدّاد إضافةٍ صريحٌ من الأب: يشغّل التمريرَ إلى السطر المُدرَج/المزاد
   *  فقط عند فعل الإضافة (لا عند حذف/تعديل كمّية/تبديل تبويب). */
  addTick: number;
  /** م١ PR-B — وضع «توصيل» للتبويب (null = بيعٌ عاديّ). */
  tabId: number;
  delivery: DeliveryDraft | null;
  onDeliveryChange: (next: DeliveryDraft | null) => void;
  onDeliveryIdentity: (identity: DeliveryCustomerIdentity) => void;
  deliveryDisabledReason: string | null;
  customerBalance: string | null;
}

export function CartPanel({ C, branchId, branchName, cart, total, selId, setSelId, changeQty, removeRow, numMode, setNumMode, customerId, selectedCustomer, tierOverride, effectiveTier, setTierOvr, setCustId, showCustPicker, setShowCustPicker, onClear, openingActive, openingEndsYmd, addTick, tabId, delivery, onDeliveryChange, onDeliveryIdentity, deliveryDisabledReason, customerBalance }: CartPanelProps) {
  const itemCount = cart.reduce((s, c) => s + c.qty, 0);

  // ٢٣/٨ — تمريرٌ تلقائيّ لآخر منتجٍ مُضاف (بلاغ المالك «لا يظهر المنتج المضاف حتى أنزل يدوياً»):
  // `addRow` يضبط selId على المنتج المُدرَج/المزاد كمّياً؛ نحرك السلّة كي يظهر ذلك السطر في مجال
  // الرؤية. المسح المتوالي أو النقر لا يجبر الكاشير على التمرير. `block: nearest` يمنع القفزات
  // العدوانيّة (إن كان السطر ظاهراً أصلاً لا يتحرّك). `behavior: smooth` يجعل الحركة ناعمةً
  // فيتتبّعها الكاشير بصرياً.
  //
  // ٢٣/٨ (Codex P2): الاعتماد على `selId + cart.length` يشغّل التمرير عند حذف صفٍّ آخر (يعيدنا
  // إلى السطر المحدَّد ولو كان بعيداً)، ولا يشغّله عند إعادة مسح السطر المحدَّد نفسه (لا selId
  // يتغيّر ولا الطول). العدّادُ الصريحُ `addTick` يعالج الحالتين: يزيد **فقط** عند فعل الإضافة.
  const selectedRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (selId == null) return;
    // rAF: التمرير بعد الرسم كي نضمن أنّ الصفَّ في DOM وارتفاعه محسوب.
    const raf = requestAnimationFrame(() => {
      selectedRowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addTick]);
  const TH: React.CSSProperties = { padding: "9px 10px", fontWeight: 700, fontSize: 12.5, color: C.mutedFg, textAlign: "center", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap", background: C.muted };
  const TD: React.CSSProperties = { padding: "10px 8px", textAlign: "center", fontSize: 14 };

  // حارس مخزون ليّن (إشارة بصرية فقط؛ الذرّية يفرضها الخادم في applyMovement). نجمع الطلب بالوحدة
  // الأساس لكل صنف (variant) عبر كل وحداته في السلّة، لأنّ رصيد الفرع (stockBase) واحدٌ للصنف
  // ويُشترَك بين وحداته (قطعة/درزن/كرتون). المقارنة بالمجموع لا بكل سطر ⇒ يُكتشف النقص حتى حين
  // يُباع الصنف نفسه بوحدات متعددة (١ درزن + ١ قطعة قد يتجاوزان المتاح رغم أنّ كلّ سطر وحده لا يتجاوزه).
  const demandByVariant = new Map<number, number>();
  for (const c of cart) {
    const f = Number(c.row.conversionFactor) || 1;
    demandByVariant.set(c.row.variantId, (demandByVariant.get(c.row.variantId) ?? 0) + c.qty * f);
  }
  const reservationVariantIds = Array.from(new Set(cart.filter((item) => !item.row.isService && !item.digital).map((item) => item.row.variantId)));
  const allocationsQ = trpc.reservations.activeAllocations.useQuery(
    { branchId, variantIds: reservationVariantIds },
    { enabled: reservationVariantIds.length > 0, staleTime: 15_000 },
  );
  const allocationsByVariant = new Map<number, NonNullable<typeof allocationsQ.data>>();
  for (const allocation of allocationsQ.data ?? []) {
    const list = allocationsByVariant.get(allocation.variantId) ?? [];
    list.push(allocation);
    allocationsByVariant.set(allocation.variantId, list);
  }
  const stockState = (c: CartItem) => {
    const convFactor  = Number(c.row.conversionFactor) || 1;
    // مُنتج خِدمي: لا مَخزون ⇒ لا نَفاد ولا نَقص (الخَادم يَتجاوز فَحص المَخزون أيضاً).
    if (c.row.isService) {
      return { isKnown: true, isOut: false, isShort: false, availInUnit: Number.POSITIVE_INFINITY };
    }
    // ⚠ عقدٌ محفوظ (Codex P1 على PR #733): عرضُ `stockBase` أوفلاين كـ«متاحٍ للبيع» **يكذب**
    // بشأن الحجوزات — لقطةُ الأوفلاين تحمل الرصيد الفعليّ بلا reservationStock. صنفٌ رصيدُه ١٠
    // وحجوزاتٌ نشطة ١٠ يظهر «متاح ١٠» ⇒ الكاشير يقبض ثمّ يفشل الترحيل عند العودة. `isKnown` لا
    // يوسَّع؛ إصلاحُ حقيقيّ لبلاغ الأوفلاين يستلزم إثراءَ لقطة `buildStockSnapshot` بالحجز.
    const isKnown = c.row.branchId === branchId && c.row.availableBase != null;
    if (!isKnown) return { isKnown: false, isOut: false, isShort: false, availInUnit: 0 };
    const availBase   = c.row.availableBase ?? c.row.stockBase ?? 0;
    const reqBase     = demandByVariant.get(c.row.variantId) ?? c.qty * convFactor; // إجمالي طلب الصنف
    const isOut       = availBase <= 0;                       // نافذ — لا رصيد
    const isShort     = !isOut && reqBase > availBase;        // الطلب يتجاوز المتاح
    const availInUnit = Math.floor(availBase / convFactor);  // المتاح بوحدة السطر
    // «يُباع بالطلب» (0318): الخادم يُعفيه من حارس النفاد إعفاءً دائماً (`applyMovement`)، فوسمُه
    // «نافذاً» يكذب على الكاشير ويحجب زرّاً يعمل. نُطفئ **الوسم وحده** ونُبقي `availInUnit`
    // صادقاً كما هو — رصيدُه السالب هو عدّاد «مُباعٌ لم يُورَّد»، وإخفاؤه خلف ∞ يطمس الفائدة.
    if (c.row.allowBackorder) return { isKnown: true, isOut: false, isShort: false, availInUnit };
    return { isKnown: true, isOut, isShort, availInUnit };
  };
  // ملخّص للشارة الدائمة في التذييل (كي لا يختفي التحذير حين ينزلق السطر المميَّز خارج الرؤية).
  let anyOut = false, flaggedCount = 0;
  for (const c of cart) {
    const s = stockState(c);
    if (s.isOut)        { anyOut = true; flaggedCount++; }
    else if (s.isShort) { flaggedCount++; }
  }

  // minHeight:0 لازمٌ في الوضع المكدَّس: min-height:auto الافتراضيّ يمنع الانكماش
  // دون ارتفاع المحتوى، فيفيض العمود ويُقصّ ما تحته.
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px", height: 46, background: C.muted, borderBottom: `1px solid ${C.border}`, flexShrink: 0, gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 800, fontSize: 14.5, color: C.fg, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ShoppingCart size={17} aria-hidden /> سلة المشتريات
          </span>
          {cart.length > 0 && (
            <span style={{ background: C.primary, color: C.primaryFg, borderRadius: 12, padding: "2px 9px", fontSize: 12, fontWeight: 700 }}>
              {cart.length} منتج · {itemCount} قطعة
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {/* Customer picker */}
          <CartCustomerButton
            C={C}
            customerId={customerId}
            selectedCustomer={selectedCustomer}
            tierOverride={tierOverride}
            effectiveTier={effectiveTier}
            setTierOvr={setTierOvr}
            setCustId={setCustId}
            showCustPicker={showCustPicker}
            setShowCustPicker={setShowCustPicker}
            delivery={delivery != null}
            onToggleDelivery={() => onDeliveryChange(delivery ? null : emptyDeliveryDraft())}
            deliveryDisabledReason={deliveryDisabledReason}
          />

          <span style={{ fontSize: 11.5, color: C.mutedFg }}>F2 · F4 · F12</span>
          {cart.length > 0 && (
            <button onClick={onClear}
              style={{ height: 34, padding: "0 10px", background: "none", border: `1px solid ${C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 12.5, color: C.danger, fontFamily: "inherit", fontWeight: 700 }}>
              تفريغ
            </button>
          )}
        </div>
      </div>

      {/* «وضع الافتتاح» — لافتة دائمة ما دامت النافذة فعّالة.
          حبر اللافتة `C.modeFg` (حبر الكهرمان في لوحة الكاشير) لا `C.amber`: الأخير سطحٌ
          متوسّط اللمعان في الوضعين فيهبط تباينُه على `C.amberSoft` دون ٤.٥:١، بينما
          `--pos-mode-fg` يُظلم فاتحاً ويُفتِح داكناً فيصمد في الحالتين. */}
      {openingActive && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", background: C.amberSoft, borderBottom: `1px solid ${C.border}`, fontSize: 12, fontWeight: 700, color: C.modeFg, flexShrink: 0 }}>
          <AlertTriangle aria-hidden size={13} />
          وضع الافتتاح فعّال{openingEndsYmd ? ` حتى نهاية يوم ${openingEndsYmd}` : ""} — المنتج غير المجرود يُباع حتى لو نفد رصيده (ينزل بالسالب حتى جرده الافتتاحي): نقداً/بطاقةً بسدادٍ كامل، أو آجلاً لعميلٍ محدَّد (يُسجَّل ذمّةً كاملة). البيع بلا عميلٍ محدَّد يبقى صارماً.
        </div>
      )}

      {/* سلّة الكاشير: شبكةُ تحرير (‎−/+‎ وحذفٌ لكل سطر) بتصميمٍ مخصّصٍ بأنماطٍ سطرية
          (لا Tailwind) لأنّ سطحَ الكاشير مضبوطٌ لشاشة اللمس وحجم الخطّ الكبير.
          `DataTable` أداةُ عرضٍ فلا تُطبَّق هنا. */}
      {/* م١ PR-B — وضع «توصيل»: العميل بالهاتف + حقول الطرد في نفس الشاشة فوق السلّة. */}
      {delivery && (
        <CartDeliveryPanel
          C={C}
          tabId={tabId}
          draft={delivery}
          onChange={onDeliveryChange}
          onIdentityChange={onDeliveryIdentity}
          customerBalance={customerBalance}
          disabledReason={deliveryDisabledReason}
        />
      )}

      <div style={{ flex: 1, overflowY: "auto", overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 540, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ position: "sticky", top: 0, zIndex: 2 }}>
              <th style={{ ...TH, width: 32 }}>#</th>
              <th style={{ ...TH, textAlign: "right" }}>المنتج</th>
              <th style={{ ...TH, width: 64 }}>الوحدة</th>
              <th style={{ ...TH, width: 110 }}>السعر</th>
              <th style={{ ...TH, width: 80 }}>المتاح للبيع</th>
              <th style={{ ...TH, width: 150 }}>الكمية</th>
              <th style={{ ...TH, width: 115 }}>الإجمالي</th>
              <th style={{ ...TH, width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {cart.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: "56px 0", textAlign: "center", color: C.mutedFg }}>
                  <div style={{ marginBottom: 10, display: "flex", justifyContent: "center", opacity: 0.55 }}>
                    <ShoppingCart size={42} strokeWidth={1.5} aria-hidden />
                  </div>
                  <div style={{ fontSize: 14.5, fontWeight: 600 }}>السلة فارغة</div>
                  <div style={{ fontSize: 12.5, marginTop: 6 }}>ابحث أو امسح الباركود لإضافة المنتجات</div>
                </td>
              </tr>
            )}
            {cart.map((c, i) => {
              const ep       = effectivePrice(c);
              const lineId   = lineIdOf(c);
              const selected = selId === lineId;
              // تمييز بصري + نصّ قبل محاولة الدفع (المنطق المُجمَّع للصنف في stockState أعلاه).
              const { isKnown, isOut, isShort, availInUnit } = stockState(c);
              const allocations = allocationsByVariant.get(c.row.variantId) ?? [];
              // «وضع الافتتاح»: الصنف غير المُفتتَح (openedAt فارغ) يُباع نقداً بالسالب — وسم كهرماني
              // مطمئن بدل «نافذ» الأحمر المخيف (الحارس الفعلي خادميّ؛ الآجل/غير النقدي سيُرفض هناك).
              const openingSellable = (isOut || isShort) && openingActive && c.row.openedAt == null && !c.row.isService;
              const rowBg  = selected ? C.primarySoft : openingSellable ? C.amberSoft : isOut ? C.dangerSoft : isShort ? C.amberSoft : "transparent";
              const accent = openingSellable ? C.amber : isOut ? C.danger : isShort ? C.amber : "transparent";
              return (
                <tr key={lineId}
                  ref={selected ? selectedRowRef : undefined}
                  onClick={() => { setSelId(lineId); setNumMode("QTY"); }}
                  style={{ borderBottom: `1px solid ${C.border}`, cursor: "pointer", background: rowBg, transition: "background .08s" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = selected ? C.primarySoft : isOut ? C.dangerSoft : isShort ? C.amberSoft : C.muted; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = rowBg; }}
                >
                  <td style={{ ...TD, color: C.mutedFg, fontWeight: 600, borderInlineStart: `4px solid ${accent}` }}>{i + 1}</td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 800, fontSize: 19, lineHeight: 1.35, color: C.fg }}>
                    {/* م٣: الاسم الموحّد يُظهر اللون/القياس أو اسم البديل — كان يعرض اسم المنتج وحده. */}
                    {variantDisplayName({ productName: c.row.productName, variantName: c.row.variantName, color: c.row.color, size: c.row.size })}
                    <span style={{ fontSize: 13, color: C.mutedFg, fontWeight: 500, marginRight: 5 }}>{c.row.sku}</span>
                    {!c.row.isService && !isKnown && (
                      <span style={{ fontSize: 11, color: C.mutedFg, fontWeight: 700, marginRight: 5 }}>
                        جارٍ التحقق من الرصيد
                      </span>
                    )}
                    {c.disc != null && c.disc > 0 && (
                      <span style={{ fontSize: 11, color: C.danger, fontWeight: 700, marginRight: 4 }}>−{c.disc}%</span>
                    )}
                    {c.digital && (
                      // §٨.٦: شارة السطر — «كرت رقمي»، أو «تعليمي — اسم الطالب» حين تُلتقط بياناته.
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: C.primaryFg, background: C.primary, fontWeight: 800, borderRadius: 6, padding: "2px 8px", marginRight: 6, whiteSpace: "nowrap" }}>
                        <CreditCard aria-hidden size={12} />
                        {digitalOfferingTypeLabel(c.digital.offeringType)}
                      </span>
                    )}
                    {!c.digital && !c.row.isService && isKnown && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", marginTop: 5, fontSize: 11.5, fontWeight: 700, color: C.mutedFg }}>
                        <span>{branchName}</span>
                        <span>فعلي {fmt(c.row.stockBase ?? 0)}</span>
                        <span style={{ color: (c.row.reservedBase ?? 0) > 0 ? C.amber : C.mutedFg }}>
                          محجوز {fmt(c.row.reservedBase ?? 0)}
                        </span>
                        <span>متاح للبيع {fmt(c.row.availableBase ?? c.row.stockBase ?? 0)}</span>
                      </div>
                    )}
                    {allocations.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
                        {allocations.map((allocation) => (
                          <span
                            key={allocation.reservationId}
                            style={{ border: `1px solid ${C.amber}`, background: C.amberSoft, color: C.modeFg, borderRadius: 5, padding: "2px 7px", fontSize: 11.5, fontWeight: 800 }}
                          >
                            حجز باسم {allocation.customerName} · {fmt(allocation.remainingBase)} وحدة أساس
                          </span>
                        ))}
                      </div>
                    )}
                    {c.digital && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", marginTop: 5, fontSize: 12.5, fontWeight: 800, color: C.fg }}>
                        <span dir="ltr">
                          {c.digital.providerName} · رقم عملية المزوّد: {c.digital.providerReference}
                        </span>
                        <span>{digitalOfferingDescription(c.digital)}</span>
                        {c.digital.student && <span>{c.digital.student.studentName} · <span dir="ltr">{c.digital.student.studentPhone}</span></span>}
                      </div>
                    )}
                    {openingSellable && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "#241900", background: C.amber, fontWeight: 800, borderRadius: 6, padding: "2px 8px", marginRight: 6, whiteSpace: "nowrap" }}>
                        <AlertTriangle aria-hidden size={12} /> غير مجرود — يُباع نقداً بالسالب
                      </span>
                    )}
                    {/* «يُباع بالطلب» (0318): الصنف مسموحٌ بيعه قبل توريده — نُصرّح بذلك بدل ترك
                        الكاشير يظنّ الرصيدَ الصفريّ/السالب عطباً. الرقم في العمود يبقى الحقيقة. */}
                    {c.row.allowBackorder && (c.row.availableBase ?? 0) <= 0 && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "#241900", background: C.amber, fontWeight: 800, borderRadius: 6, padding: "2px 8px", marginRight: 6, whiteSpace: "nowrap" }}>
                        <PackagePlus aria-hidden size={12} /> يُباع بالطلب — يُورَّد لاحقاً
                      </span>
                    )}
                    {!openingSellable && isOut && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "#fff", background: C.danger, fontWeight: 800, borderRadius: 6, padding: "2px 8px", marginRight: 6, whiteSpace: "nowrap" }}>
                        <AlertTriangle aria-hidden size={12} /> نافذ — لا مخزون
                      </span>
                    )}
                    {!openingSellable && isShort && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "#241900", background: C.amber, fontWeight: 800, borderRadius: 6, padding: "2px 8px", marginRight: 6, whiteSpace: "nowrap" }}>
                        <AlertTriangle aria-hidden size={12} />
                        {availInUnit === 0
                          ? "لا يكفي لوحدة كاملة"
                          : `المتاح ${fmt(availInUnit)} ${c.row.unitName} فقط`}
                      </span>
                    )}
                  </td>
                  <td style={{ ...TD, color: C.mutedFg, fontSize: 12.5 }}>{c.row.unitName}</td>
                  <td style={{ ...TD, direction: "ltr", color: C.mutedFg }}>
                    {c.disc != null && c.disc > 0
                      ? <>
                          <span style={{ textDecoration: "line-through", fontSize: 12, opacity: 0.6 }}>{fmt(Number(c.row.price ?? 0))}</span>
                          &nbsp;
                          <span style={{ color: C.danger, fontWeight: 700 }}>{fmt(ep)}</span>
                        </>
                      : fmt(ep)
                    }
                  </td>
                  {/* عمود المخزون: ∞ للخدمات، رقم بلون أحمر/أصفر/طبيعي حسب الحالة. */}
                  <td style={{ ...TD, direction: "ltr", fontWeight: 700, color: isOut ? C.danger : isShort ? C.amber : C.mutedFg }}>
                    {c.row.isService ? "∞" : isKnown ? fmt(availInUnit) : "…"}
                  </td>
                  <td style={{ ...TD, padding: "6px 6px" }}>
                    {c.digital ? (
                      // §٨.٦: كمّية الكرت الرقميّ ثابتة — لا أزرار زيادة/نقصان؛ الزيادة بإضافة بطاقة أخرى.
                      <div style={{ textAlign: "center", fontWeight: 800, fontSize: 15, direction: "ltr", color: C.mutedFg }} title="كل بطاقة سطر مستقل ضمن سلة المزوّد">1</div>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "center" }}>
                        <button onClick={(e) => { e.stopPropagation(); changeQty(lineId, c.qty - 1); }}
                          style={{ width: 44, height: 44, border: `1.5px solid ${C.border}`, borderRadius: 8, background: C.card, cursor: "pointer", fontSize: 22, color: C.fg, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                        <span style={{ minWidth: 40, textAlign: "center", fontWeight: 800, fontSize: 15, direction: "ltr", color: C.fg }}>{c.qty}</span>
                        <button onClick={(e) => { e.stopPropagation(); changeQty(lineId, c.qty + 1); }}
                          title={isOut || isShort ? "الزيادة تتجاوز المخزون المتاح" : undefined}
                          style={{ width: 44, height: 44, border: `1.5px solid ${isOut || isShort ? accent : C.border}`, borderRadius: 8, background: C.card, cursor: "pointer", fontSize: 22, color: isOut || isShort ? accent : C.fg, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                      </div>
                    )}
                  </td>
                  <td style={{ ...TD, direction: "ltr", fontWeight: 800, fontSize: 14.5, color: C.fg }}>{fmt(itemTotal(c))}</td>
                  <td style={{ ...TD, padding: "6px" }}>
                    <button onClick={(e) => { e.stopPropagation(); removeRow(lineId); }}
                      aria-label="حذف السطر"
                      style={{ width: 44, height: 44, background: "none", border: "none", cursor: "pointer", color: C.mutedFg, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><X aria-hidden size={18} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      {cart.length > 0 && (
        <div style={{ borderTop: `2px solid ${C.border}`, padding: "9px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", background: C.muted, flexShrink: 0, gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 13, color: C.mutedFg, whiteSpace: "nowrap" }}>{cart.length} منتج · {itemCount} قطعة</span>
            {flaggedCount > 0 && (
              // شارة دائمة تلخّص أصناف نقص المخزون كي لا يختفي التحذير حين ينزلق سطره خارج الرؤية.
              <span style={{ background: anyOut ? C.danger : C.amber, color: anyOut ? "#fff" : "#241900", borderRadius: 8, padding: "3px 10px", fontSize: 12, fontWeight: 800, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <AlertTriangle aria-hidden size={13} /> {flaggedCount} منتج ناقص المخزون
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
            <span style={{ fontSize: 13.5, color: C.mutedFg }}>المجموع:</span>
            <span style={{ fontSize: 28, fontWeight: 900, direction: "ltr", color: C.fg }}>{fmt(total)}</span>
            <span style={{ fontSize: 13, color: C.mutedFg }}>د.ع</span>
          </div>
        </div>
      )}
    </div>
  );
}
