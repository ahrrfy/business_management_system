/**
 * PurchaseNew — صفحة إنشاء أمر شراء جديد بواجهة محرّر الفواتير الموحّدة.
 *
 * تعتمد على مكتبة `@/components/invoice` المشتركة (نفس عناصر فاتورة البيع/عرض السعر)
 * مع `invoiceType="PURCHASE"`:
 *   • المورد بدل العميل (EntityPicker يتبدّل تلقائياً عبر InvoiceHeader).
 *   • السعر القابل للتعديل في الجدول هو **سعر الشراء/التكلفة**؛ `costBase × convFactor` كبادئ
 *     (يفعّله ProductTable عند `isPurchase=true`).
 *   • `showCost = true` (مدير — له رؤية التكلفة والهامش).
 *   • «رقم أمر شراء مرجعي» اختياري (InvoiceHeader يظهره عند PURCHASE).
 *   • بنجاح الإنشاء ⇒ تنقّل لشاشة الاستلام `/purchases/:id/receive`.
 *
 * الذرّية والأموال يتولاها الخادم (createPurchaseOrder ⇒ withTx + decimal.js). الواجهة هنا
 * لا تستخدم parseFloat/Number في الأموال (الجمعات داخل calcTotals + decimal.js).
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { Landmark, Truck } from "lucide-react";
import { isWithinPriceDecimals, priceDecimalsMessage } from "@shared/moneyPrecision";
import { D, fmtAr, round2, toBase, toUnitPriceStr } from "@/lib/money";
import { MoneyInput } from "@/components/form/MoneyInput";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { copyInvoiceItems, hasInvoiceTransfer, takeInvoiceItems } from "@/lib/invoiceTransfer";
import {
  ActionButtons,
  BulkPicker,
  INVOICE_TYPES,
  InvoiceHeader,
  ProductTable,
  ShortcutsBar,
  SupplierInvoiceMatch,
  TermsAndNotes,
  TotalsPanel,
  calcTotals,
  createInitialState,
  deriveDocumentTotal,
  distributeToSubtotal,
  invoiceReducer,
  matchSupplierInvoice,
  subtotalForInvoiceTotal,
  type InvoiceActionKind,
} from "@/components/invoice";

const INVOICE_TYPE = "PURCHASE" as const;

/** يُحلّل مبلغاً نصّياً بأمان: MoneyInput قد يُصدر قيماً وسيطة مثل «.» أثناء كتابة كسر، وD() الخام
 *  يرمي حينها فيكسر الرسم (نظير safeD في calcTotals). القيم غير المكتملة ⇒ صفر حتى الحفظ/blur. */
function safeMoney(v: string) {
  try {
    return D(v);
  } catch {
    return D(0);
  }
}

export default function PurchaseNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [pasteAvailable, setPasteAvailable] = useState(hasInvoiceTransfer);

  /* ─── server data ──────────────────────────────────────────────── */
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  // suppliers مُحمَّل داخل EntityPicker — لا نكرّر هنا، لكن نُدفئ الكاش للتجاوب.
  trpc.suppliers.list.useQuery();

  /* ─── editor state (reducer) ───────────────────────────────────── */
  const [state, dispatch] = useReducer(invoiceReducer, undefined, () => ({
    ...createInitialState(INVOICE_TYPE, me.data?.branchId ?? 1),
  }));

  // مزامنة الفرع مرة واحدة عند توفّر هويّة المستخدم (إن لم يكن المستخدم قد بدّل الفرع يدوياً).
  const branchInitRef = useRef(false);
  useEffect(() => {
    if (!branchInitRef.current && me.data?.branchId && state.branchId !== me.data.branchId) {
      dispatch({ type: "SET_FIELD", field: "branchId", value: me.data.branchId });
      branchInitRef.current = true;
    } else if (me.data) {
      branchInitRef.current = true;
    }
  }, [me.data, state.branchId]);

  // تهيئة تفعيل/نسبة الضريبة من إعدادات النظام (مرّة واحدة فقط، أمر شراء جديد) — يبقى المستخدم
  // حرّاً بتبديلها يدوياً بعدها (لا نُعيد التهيئة عند كل جلب/إعادة رسم).
  const taxDefaultsAppliedRef = useRef(false);
  const taxSettingsQuery = trpc.system.getTaxSettings.useQuery();
  useEffect(() => {
    if (!taxDefaultsAppliedRef.current && taxSettingsQuery.data) {
      dispatch({ type: "SET_FIELD", field: "taxEnabled", value: taxSettingsQuery.data.enabledByDefault });
      dispatch({ type: "SET_FIELD", field: "taxRatePercent", value: taxSettingsQuery.data.defaultTaxRatePercent });
      taxDefaultsAppliedRef.current = true;
    }
  }, [taxSettingsQuery.data]);

  /* ─── client-side idempotency token ────────────────────────────── */
  // معرّف العميل للطلب — جاهز للمستقبل (الراوتر الحالي لا يستهلكه؛ يُحفظ في memory للجلسة).
  const [clientRequestId] = useState(() => crypto.randomUUID());

  /* ─── landed cost (شحن/كمرك) ────────────────────────────────────── */
  // تُرسمَل في تكلفة المخزون (WAVG) عند الاستلام وتُضاف إلى ذمّة المورّد — لا مصروف P&L. تُوزَّع
  // على الأصناف بنسبة القيمة خادمياً؛ المعاينة هنا بـdecimal.js فقط (الخادم يُعيد الحساب مرجعياً).
  const [shippingCost, setShippingCost] = useState("");
  const [customsCost, setCustomsCost] = useState("");

  /* ─── bulk picker overlay ──────────────────────────────────────── */
  const [bulkOpen, setBulkOpen] = useState(false);

  /* ─── مطابقة فاتورة المورّد ─────────────────────────────────────── */
  // يوزّع فرق المطابقة على أسعار البنود بنسبة القيمة **بعد أن يراه الموظّف**: الأسعار الجديدة
  // تظهر في الجدول فوراً ولا يقع أيّ حفظٍ قبل مراجعتها — لا امتصاصَ خفيّ لفرقٍ ماليّ (§٥).
  function distributeInvoiceDifference() {
    // الهدف هو **المجموع قبل الخصم**: (إجمالي − خصم) × (١+ض) = قيمة الفاتورة ⇒ نحسب الصافي
    // اللازم ثمّ نُعيد إليه الخصم القائم، وإلّا وُزّع الفرق مرّتين (مرّةً بالأسعار ومرّةً بالخصم).
    const neededNet = subtotalForInvoiceTotal(
      state.supplierInvoiceTotal,
      state.taxEnabled ? state.taxRatePercent || "0" : "0",
    );
    const target = round2(D(neededNet).plus(invoiceDiscountAmount)).toFixed(2);
    const res = distributeToSubtotal(state.items, target, state.currency);
    if (!res.prices.length) {
      notify.warn(res.error ?? "تعذّر توزيع الفرق على البنود.");
      return;
    }
    res.prices.forEach((price, idx) => {
      dispatch({ type: "UPDATE_ITEM", idx, field: "costBase", value: price });
      dispatch({ type: "UPDATE_ITEM", idx, field: "price", value: price });
    });
    if (D(res.residual).isZero()) {
      notify.ok("وُزّع الفرق على أسعار البنود — راجع الأسعار الجديدة ثم احفظ.");
    } else {
      // إفصاحٌ لا ادّعاء: هدفٌ لا تبلغه أسعارٌ ضمن دقّة العملة (كمّياتٌ كبيرة) يُعلَن متبقّيه.
      notify.warn(
        `وُزّع الفرق، وبقي ${res.residual} غير قابلٍ للتوزيع بدقّة العملة — عدّل سعر بندٍ يدوياً لإتمام المطابقة.`,
      );
    }
  }

  /** يجعل فرقَ المطابقة **خصمَ فاتورةٍ** — المسار الطبيعيّ حين تكون ورقة المورّد أقلّ من بنودنا:
   *  d' = المجموع قبل الخصم − الصافي اللازم لبلوغ قيمة الفاتورة (يُراعي الضريبة بالضبط). */
  function applyDifferenceAsDiscount() {
    const neededNet = subtotalForInvoiceTotal(
      state.supplierInvoiceTotal,
      state.taxEnabled ? state.taxRatePercent || "0" : "0",
    );
    const gross = D(deriveDocumentTotal(state.items).grossSubtotal);
    const next = round2(gross.minus(D(neededNet)));
    if (next.isNegative()) {
      notify.warn("فاتورة المورّد أعلى من مجموع البنود — الخصم لا يُصلحها؛ راجع البنود الناقصة.");
      return;
    }
    dispatch({ type: "SET_FIELD", field: "globalDiscountType", value: "amount" });
    dispatch({ type: "SET_FIELD", field: "globalDiscount", value: next.toFixed(2) });
    notify.ok(`سُجّل الفرق خصمَ فاتورةٍ بمقدار ${next.toFixed(2)} — يُوزَّع على البنود بنسبة قيمتها.`);
  }

  const insightItems = useMemo(
    () => Array.from(new Map(state.items.map((item) => [
      `${item.variantId}:${item.productUnitId}`,
      { variantId: item.variantId, productUnitId: item.productUnitId },
    ])).values()),
    [state.items],
  );
  const priceInsights = trpc.purchases.priceInsights.useQuery(
    { branchId: state.branchId, supplierId: state.entityId ?? undefined, items: insightItems },
    { enabled: state.branchId > 0 && insightItems.length > 0 },
  );

  // حارس فقدان البيانات (نمط CustomerNew/ExpenseNew): dirty عند إدخال فعليّ فقط (مورّد/بنود/شحن/كمرك/ملاحظات)
  // — شاشة فارغة حديثة الفتح لا تُحسب إدخالاً كي لا يظهر تحذير كاذب.
  const isDirty =
    state.entityId != null ||
    state.items.length > 0 ||
    state.notes.trim() !== "" ||
    state.supplierInvoiceTotal.trim() !== "" ||
    state.globalDiscount.trim() !== "" ||
    shippingCost.trim() !== "" ||
    customsCost.trim() !== "";
  useUnsavedGuard(isDirty);

  /* ─── mutation ─────────────────────────────────────────────────── */
  // «حفظ مسوّدة» يميَّز عن «حفظ واعتماد» بالتوجيه بعد النجاح: المسوّدة تعود للقائمة (لا تُستلَم
  // إلا بعد اعتمادها من هناك)، والمعتمَد ينتقل مباشرةً لشاشة الاستلام.
  const savingDraftRef = useRef(false);
  const create = trpc.purchases.createOrder.useMutation({
    onSuccess: async (r) => {
      await utils.purchases.list.invalidate();
      if (savingDraftRef.current) {
        notify.ok("حُفظ أمر الشراء مسوّدة — اعتمده من قائمة المشتريات لاستلامه لاحقاً");
        navigate("/purchases");
      } else {
        notify.ok("تم إنشاء أمر الشراء — انتقال للاستلام");
        navigate(`/purchases/${r.purchaseOrderId}/receive`);
      }
    },
    onError: (e) => notify.err(e),
  });

  /* ─── validation + submit ──────────────────────────────────────── */
  const totals = useMemo(() => calcTotals(state.items, state), [state]);

  // إجماليّ المستند بعملته **بترتيب تقريب الخادم** (سطراً سطراً ثمّ الجمع) — لا
  // `totals.grandTotal` الذي يجمع غير المقرَّب فيقرّب مرّةً واحدة. الفرق فلسٌ حقيقيّ
  // بالدولار ذي الأربع منازل، وهو ما تُبنى عليه المطابقة والعرض معاً («المعروض = المحفوظ»).
  // خصم فاتورة المورّد (0204): يُدخَل مبلغاً أو نسبةً في لوحة المبالغ، ويُشتقّ المبلغُ من
  // **قيمة البضاعة بترتيب تقريب الخادم** كي يطابق ما يوزّعه `computePurchaseDocument` بالضبط.
  const invoiceDiscountAmount = useMemo(() => {
    const gross = D(deriveDocumentTotal(state.items).grossSubtotal);
    const raw = safeMoney(state.globalDiscount || "0");
    const amount =
      state.globalDiscountType === "percent" ? round2(gross.times(raw).dividedBy(100)) : round2(raw);
    if (amount.isNegative()) return D(0);
    return amount.gt(gross) ? gross : amount;
  }, [state.items, state.globalDiscount, state.globalDiscountType]);

  const docTotals = useMemo(
    () =>
      deriveDocumentTotal(
        state.items,
        state.taxEnabled ? state.taxRatePercent || "0" : "0",
        invoiceDiscountAmount.toFixed(2),
      ),
    [state.items, state.taxEnabled, state.taxRatePercent, invoiceDiscountAmount],
  );

  // landed-cost: الإجماليّ يشمل الشحن/الكمرك (يُوزَّعان بنسبة القيمة). التوزيع بالقيمة = نسبة رفعٍ
  // موحّدة على كلّ تكلفة وحدة: capUnit = price × (subtotal + شحن + كمرك) / subtotal. للمعاينة فقط.
  const landed = useMemo(() => {
    const sum = round2(safeMoney(shippingCost).plus(safeMoney(customsCost)));
    // المجموع الفرعيّ بترتيب تقريب الخادم (سطراً سطراً) لا بجمعٍ غير مقرَّب — مصدرٌ واحد.
    const sourceSubtotal = D(docTotals.subtotal);
    const rate = state.currency === "USD" ? safeMoney(state.agreedRate) : D(1);
    // «المعروض = المحفوظ» (درس فاتورة الشحن ٥/٨): الخادم يترجم **كلّ سطرٍ على حدة** ثمّ يجمع
    // (subtotal = Σ round2(سطر$ × السعر))، فترجمةُ المجموع مرّةً واحدة هنا كانت تُظهر إجمالياً
    // يخالف المحفوظ بدنانيرَ قليلة على الفواتير متعدّدة البنود. نُطابق ترتيبَ تقريبه حرفياً.
    // الخصم فاتوريّ: نطبّق نسبته على كلّ سطرٍ قبل الترجمة تماماً كما يفعل `allocateByValue`.
    const grossDoc = D(docTotals.grossSubtotal);
    const netRatio = grossDoc.gt(0) ? D(docTotals.subtotal).dividedBy(grossDoc) : D(1);
    const goodsIqd =
      state.currency === "USD"
        ? round2(
            state.items.reduce(
              (acc, l) =>
                acc.plus(
                  round2(round2(round2(safeMoney(l.price).times(D(l.qty || 0))).times(netRatio)).times(rate)),
                ),
              D(0),
            ),
          )
        : round2(sourceSubtotal.times(rate));
    // الضريبة الدينارية تُحسَب على **المجموع الفرعيّ الدينارّي** كما يفعل الخادم حرفياً، لا
    // بترجمة الضريبة الدولارية (ترتيبا تقريبٍ مختلفان ⇒ دينارٌ أو اثنان فرقاً في المعروض).
    const taxIqd = state.taxEnabled
      ? round2(goodsIqd.times(safeMoney(state.taxRatePercent || "0")).dividedBy(100))
      : D(0);
    // قرار المالك (٥/٨/٢٦): **الإجمالي = البضاعة + الضريبة فقط** — الشحن خارجه (مصروفُ شركةٍ لا
    // ذمّةُ مورّد). كان يُجمَع هنا فيعرض للمستخدم إجمالياً لا يحفظه الخادم (٧٠٠ بينما المحفوظ ٣٠٠)
    // ⇒ يدفع للمورّد أكثر مما عليه — الخطأ نفسه الذي حُذِّر منه في شاشة البيع.
    const grand = round2(goodsIqd.plus(taxIqd));
    // معامل الرفع صار ١ دائماً: حصّة الشحن تُعرَض للعِلم ولا تُضاف إلى تكلفة الوحدة (لم تعُد تُرسمَل).
    const uplift = D(1);
    return { sum, goodsIqd, taxIqd, grand, uplift, rate, hasLanded: sum.gt(0), hasBase: goodsIqd.gt(0) };
  }, [
    shippingCost,
    customsCost,
    docTotals.subtotal,
    docTotals.grossSubtotal,
    state.items,
    state.currency,
    state.agreedRate,
    state.taxEnabled,
    state.taxRatePercent,
  ]);

  // حكم المطابقة — يُحسَب مرّةً ويُستهلَك في التحقّق وفي اللوحة معاً (لا تعريفان ينجرفان).
  const invoiceMatch = useMemo(
    () =>
      matchSupplierInvoice(
        state.currency === "USD" ? docTotals.total : landed.grand.toFixed(2),
        state.supplierInvoiceTotal,
        state.currency,
      ),
    [state.currency, state.supplierInvoiceTotal, docTotals.total, landed.grand],
  );

  function validate(): string | null {
    if (!state.entityId) return "اختر المورد قبل الحفظ.";
    if (!state.branchId) return "اختر الفرع.";
    if (state.items.length === 0) return "أضف منتجاً واحداً على الأقل.";
    for (const l of state.items) {
      const qty = D(l.qty);
      if (!qty.gt(0)) return `الكمية في «${l.name}» يجب أن تكون موجبة.`;
      const price = D(l.price);
      if (price.lt(0)) return `سعر الشراء في «${l.name}» غير صالح.`;
      // دقّة السعر حسب العملة (مرآة حارس الخادم): الحقل يحدّ المنازل أثناء الكتابة، وهذا يمسك
      // ما دخل من لصقٍ أو من أمرٍ قديم — رسالةٌ صريحة بدل قصٍّ صامت أو رحلةِ ذهابٍ وإياب.
      if (!isWithinPriceDecimals(l.price, state.currency)) {
        return priceDecimalsMessage(state.currency, l.name, l.price);
      }
      const base = toBase(l.qty, l.conversionFactor);
      if (!base.isInteger())
        return `الكمية في «${l.name}» تنتج كسراً بالوحدة الأساس (${l.qty} × ${l.conversionFactor}).`;
    }
    if (state.currency === "USD" && !safeMoney(state.agreedRate).gt(0)) {
      return "أدخل سعر الصرف المثبت للفاتورة.";
    }
    // landed-cost: التوزيع بنسبة القيمة يحتاج قيمة بضاعة موجبة (مرآة حارس الخادم).
    if (landed.hasLanded && !landed.hasBase) {
      return "أضِف منتجات بقيمة موجبة قبل إدخال تكلفة الشحن/الكمرك.";
    }
    // مطابقة فاتورة المورّد (مرآة حارس الخادم): رسالةٌ بالأرقام على الشاشة توفّر رحلة ذهابٍ وإياب.
    if (invoiceMatch.verdict !== "UNSET" && invoiceMatch.verdict !== "MATCH") {
      return invoiceMatch.message;
    }
    return null;
  }

  // يبني حمولة الإنشاء المشتركة بين «حفظ واعتماد» (CONFIRMED) و«حفظ مسوّدة» (DRAFT) — الفرق
  // الوحيد هو status؛ كل الحقول الأخرى (المورّد/البنود/الشحن/الضريبة) واحدة في الحالتين.
  function buildPayload(status: "CONFIRMED" | "DRAFT") {
    return {
      supplierId: state.entityId!,
      branchId: state.branchId,
      taxRatePercent: state.taxEnabled ? round2(D(state.taxRatePercent || "0")).toFixed(2) : "0",
      status,
      // IDEMPOTENCY (تدقيق ٢/٧): كان المفتاح يُولَّد ويُعلَّق في DOM مخفيّ فقط ولا يُرسَل ⇒ النقر
      // المزدوج يُنشئ أمرَي شراء. الآن نمرّره في الحمولة فيَحرس الخادم من الازدواج.
      clientRequestId,
      notes: state.notes.trim() || undefined,
      // USD: أسعار البنود نفسها بالدولار، والخادم يحوّلها إلى التكلفة الدينارية بسعر التثبيت.
      agreedCurrency: state.currency,
      // ملاحظة (إصلاح رسالة «لا يطابق مجموع البنود»): لا نُرسل usdTotal. حين يوجد «سعر التثبيت»
      // (إلزاميّ للدولار في هذه الشاشة) يشتقّ الخادمُ إجماليَّ الدولار من البنود نفسها (usdGoods +
      // الضريبة) بترتيب تقريبٍ سطريٍّ محدَّد؛ وأسعار البنود تُرسَل بمنزلتين عشريّتين (nonNegMoneyString)
      // بينما كانت الواجهة تشتقّ usdTotal من أسعارٍ كاملة الدقّة (مثل 4.1666) ⇒ الإجماليان يختلفان
      // بفروق تقريبٍ بحتة فيرفض الحارسُ الحفظَ زوراً. المرجع الوحيد هو حساب الخادم من البنود.
      agreedRate: state.currency === "USD" ? safeMoney(state.agreedRate).toFixed(4) : undefined,
      // خصم فاتورة المورّد (0204): يُرسَل بعملة الأمر ويُوزّعه الخادم بنسبة القيمة.
      invoiceDiscount: invoiceDiscountAmount.gt(0) ? invoiceDiscountAmount.toFixed(2) : undefined,
      // مطابقة فاتورة المورّد: تُرسَل حين يملؤها الموظّف ⇒ الخادم يرفض حفظ أمرٍ يخالف مستنده.
      // فارغةٌ ⇒ لا مطابقة (السلوك التاريخيّ) — الحقل ضابطٌ اختياريّ لا شرطُ حفظ.
      supplierInvoiceTotal: state.supplierInvoiceTotal.trim()
        ? round2(safeMoney(state.supplierInvoiceTotal)).toFixed(2)
        : undefined,
      // landed-cost: الشحن/الكمرك (تُرسَل فقط إن كانت موجبة — الخادم يوزّعها بنسبة القيمة ويُرسمِلها).
      // safeMoney: قيمة وسيطة غير مكتملة («.») ⇒ صفر بدل رمي D() الخام أثناء الحفظ.
      shippingCost: safeMoney(shippingCost).gt(0) ? round2(safeMoney(shippingCost)).toFixed(2) : undefined,
      customsCost: safeMoney(customsCost).gt(0) ? round2(safeMoney(customsCost)).toFixed(2) : undefined,
      items: state.items.map((l) => ({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        // الكمية بنفس الوحدة المختارة (الخادم يضرب × conversionFactor للحصول على base).
        quantity: D(l.qty).toString(),
        // سعر الشراء بالوحدة **بعملة الأمر** (price = costBase × convFactor عند الإضافة، قابل
        // للتعديل). كان `round2(...).toFixed(2)` يقصّ سعر الدولار 3.4566 إلى 3.46 صامتاً رغم أنّ
        // العمود `usdUnitPrice` يحفظ ٤ منازل ⇒ فارقٌ في ذمّة المورّد بحجم الكمية.
        unitPrice: toUnitPriceStr(l.price, state.currency),
      })),
    };
  }

  function handleSubmit() {
    // ActionButtons (مشترك) لا يُعطِّل زرّ «مسوّدة» أثناء التحفّظ — حارس محلّي يمنع تضارب حفظَين
    // متزامنين (كلاهما يشترك clientRequestId ثابتاً؛ الخادم يمنع الازدواج، لكن قد يُربَك التوجيه بعد النجاح).
    if (create.isPending) return;
    const err = validate();
    if (err) {
      notify.warn(err);
      return;
    }
    savingDraftRef.current = false;
    create.mutate(buildPayload("CONFIRMED"));
  }

  // حفظ مسوّدة فعلي (كان زرّاً يوهم بإنذار «سيُفعَّل لاحقاً» بلا استدعاء — الراوتر يدعم
  // status=DRAFT فعلياً منذ createOrder، فقط لم تكن الواجهة تستدعيه): يحفظ نفس بيانات الأمر بحالة
  // «مسوّدة» بلا أثر مخزني/مالي فوري (createOrder لا يكتب شيئاً غير سطور الأمر)، قابلة للاستكمال
  // لاحقاً من قائمة المشتريات عبر «اعتماد الأمر» ثم استلامها كالمعتاد.
  function handleSaveDraft() {
    if (create.isPending) return;
    const err = validate();
    if (err) {
      notify.warn(err);
      return;
    }
    savingDraftRef.current = true;
    create.mutate(buildPayload("DRAFT"));
  }

  function handleAction(kind: InvoiceActionKind) {
    switch (kind) {
      case "save":
        handleSubmit();
        return;
      case "draft":
        handleSaveDraft();
        return;
      case "print":
        // اطبع المسوّدة الحالية (المتصفّح) — الطباعة المعتمدة من شاشة الاستلام.
        window.print();
        return;
      case "duplicate":
        if (!state.items.length) return notify.warn("لا توجد محتويات لنسخها.");
        copyInvoiceItems(state.items);
        dispatch({ type: "CLEAR_ITEMS" });
        setPasteAvailable(true);
        notify.ok("تم نسخ المنتجات وتفريغ الفاتورة. ستجد «لصق» في أي فاتورة تفتحها.");
        return;
      case "paste": {
        const items = takeInvoiceItems();
        if (!items) {
          setPasteAvailable(false);
          notify.warn("لا توجد محتويات صالحة للصقها.");
          return;
        }
        dispatch({ type: "ADD_ITEMS", items });
        setPasteAvailable(false);
        notify.ok("تم لصق محتويات الفاتورة.");
        return;
      }
      case "send":
      case "pdf":
      case "return":
        notify.info("هذا الإجراء سيُفعَّل لاحقاً.");
        return;
      default:
        return;
    }
  }

  /* ─── keyboard shortcuts (F2/F4/F9/F12/Esc) ────────────────────── */
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // F2 ⇒ تركيز شريط البحث داخل ProductTable
      if (e.key === "F2") {
        e.preventDefault();
        const input = containerRef.current?.querySelector<HTMLInputElement>(
          'input[aria-label="بحث المنتجات"]'
        );
        input?.focus();
        return;
      }
      // F4 ⇒ حفظ واعتماد
      if (e.key === "F4") {
        e.preventDefault();
        if (!create.isPending) handleSubmit();
        return;
      }
      // F9 ⇒ طباعة
      if (e.key === "F9") {
        e.preventDefault();
        window.print();
        return;
      }
      // F12 ⇒ تفريغ السلة وإعادة تهيئة (يحفظ الفرع)
      if (e.key === "F12") {
        e.preventDefault();
        dispatch({ type: "RESET", invoiceType: INVOICE_TYPE });
        // RESET يُعيد taxEnabled/taxRatePercent للافتراضي المُدرَج في createInitialState (false/"0")
        // — نُعيد تفعيل تطبيق إعدادات الضريبة الفعلية على أمر الشراء التالي في نفس الجلسة.
        taxDefaultsAppliedRef.current = false;
        // landed-cost حالة محلّية (خارج reducer) ⇒ نُصفّرها يدوياً مع تفريغ السلّة.
        setShippingCost("");
        setCustomsCost("");
        return;
      }
      // Esc ⇒ إغلاق Bulk Picker إن كان مفتوحاً
      if (e.key === "Escape") {
        if (bulkOpen) setBulkOpen(false);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // landed-cost: shippingCost/customsCost حالة محلّية خارج state ⇒ يجب إدراجها في التبعيّات وإلّا
    // قرأ حفظُ F4 قيمةً قديمة (الإغلاق مُلتقَط عند آخر تشغيل للـeffect) فيُسقط الشحن/الكمرك بصمت.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkOpen, create.isPending, state, shippingCost, customsCost]);

  /* ─── render ───────────────────────────────────────────────────── */
  const meta = INVOICE_TYPES[INVOICE_TYPE];

  return (
    // تدفّق طبيعيّ (لا حبس بارتفاع الإطار): كان `h-full` يضغط المحرّرَ داخل ٧٢٠px فيبقى للجدول
    // صفّان فقط وتُقتَطع بطاقةُ الشحن/الإجراءات أسفل الشريط الجانبي. الآن تنمو الصفحة بمحتواها
    // ويُمرِّرها `<main overflow-auto>` — فيَظهر الجدولُ كبيراً وكلُّ حقول الشريط الجانبي كاملةً.
    <div ref={containerRef} dir="rtl" className="flex flex-col gap-3">
      {/* Title bar */}
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-xl font-extrabold">
          {(() => { const MIcon = meta.icon; return <MIcon aria-hidden className="size-6 text-primary" />; })()}
          {meta.label} جديد
        </h1>
        <div className="flex items-center gap-3 text-xs">
          <span className="hidden font-semibold text-muted-foreground sm:inline">
            الإجمالي:{" "}
            <span className="font-extrabold text-foreground" dir="ltr">
              {landed.grand.toFixed(2)}
            </span>{" "}
            د.ع
          </span>
          <Link
            href="/purchases"
            className="text-sm font-semibold text-muted-foreground hover:text-foreground"
          >
            ← رجوع للمشتريات
          </Link>
        </div>
      </div>

      {/* Header card (document metadata + supplier + terms + PO reference) */}
      <InvoiceHeader state={state} dispatch={dispatch} invoiceType={INVOICE_TYPE} />

      {/* Body: products on the right, totals/actions/terms on the left (RTL → aside on left).
          يتراصّ عمودياً على الشاشات الضيّقة ويصير صفّاً على الواسعة؛ الشريط الجانبي بارتفاعه
          الطبيعيّ (items-start) فلا تُقتَطع بطاقةُ الشحن/الكمرك ولا الإجراءات. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        {/* عمود المنتجات: ارتفاع سخيّ ثابت كي يعرض الجدولُ المشتركُ (بتمريره الداخليّ) صفوفاً
            كثيرة بدل صفّين — بديلاً عن الحبس السابق بارتفاع الإطار. */}
        <div className="flex min-w-0 flex-1 flex-col gap-2 h-[60vh] min-h-[420px] print:h-auto print:min-h-fit">
          <ProductTable
            items={state.items}
            dispatch={dispatch}
            branchId={state.branchId}
            tier={state.tier}
            invoiceType={INVOICE_TYPE}
            showCost={true}
            purchaseCurrency={state.currency}
            purchaseRate={state.agreedRate}
            purchasePriceInsights={priceInsights.data}
            onOpenBulkPicker={() => setBulkOpen(true)}
            onNotify={(msg, kind) => (kind === "error" ? notify.err(msg) : notify.info(msg))}
          />
          <BulkPicker
            open={bulkOpen}
            onClose={() => setBulkOpen(false)}
            onAddItems={(items) => dispatch({ type: "ADD_ITEMS", items })}
            invoiceType={INVOICE_TYPE}
            branchId={state.branchId}
            tier={state.tier}
          />
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-2 lg:w-80">
          {/* landed-cost (تدقيق ١٧/٧، خطر #2 — الآن مُنفَّذ لا مُخفى): الشحن/الكمرك يُحفظان ويُرسمَلان
              في تكلفة المخزون (WAVG) عند الاستلام ويُضافان إلى ذمّة المورّد — لا مصروف P&L. باقي حقول
              المحرّر (خصم/مصاريف أخرى/دفع) تبقى مخفيّة لأنّ createOrder لا يحفظها؛ الدفع عند الاستلام. */}
          <section className="overflow-hidden rounded-xl border bg-card">
            <header className="flex items-center gap-2 border-b bg-muted px-4 py-2.5">
              <Truck aria-hidden className="size-5" />
              <span className="text-sm font-extrabold">تكلفة الشحن والكمرك</span>
            </header>
            <div className="space-y-2 px-4 py-3">
              <label className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                  <Truck aria-hidden className="size-4" /> الشحن
                </span>
                <MoneyInput
                  value={shippingCost}
                  onChange={setShippingCost}
                  ariaLabel="تكلفة الشحن"
                  className="h-8 w-32 text-center text-sm font-bold"
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                  <Landmark aria-hidden className="size-4" /> الكمرك
                </span>
                <MoneyInput
                  value={customsCost}
                  onChange={setCustomsCost}
                  ariaLabel="تكلفة الكمرك"
                  className="h-8 w-32 text-center text-sm font-bold"
                />
              </label>

              {landed.hasLanded && landed.hasBase && (
                <div className="mt-1 rounded-lg border border-dashed bg-muted/40 p-2.5 text-xs">
                  <div className="mb-1.5 font-bold text-foreground">توزيع الشحن على البنود بنسبة القيمة (للعِلم فقط)</div>
                  <ul className="space-y-1">
                    {state.items.map((l, i) => (
                      <li key={i} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-muted-foreground">{l.name}</span>
                        <span dir="ltr" className="shrink-0 font-bold tabular-nums">
                          {/* حصّة البند من مصروف الشحن (بنسبة قيمته) — معلومةٌ تحليلية، لا تُضاف
                              إلى سعره ولا إلى تكلفته. الأصلُ يُعرَض بجانبها للمقارنة. */}
                          {fmtAr(
                            round2(
                              D(totals.subtotal).gt(0)
                                ? landed.sum
                                    .times(D(l.price).times(D(l.qty || 0)))
                                    .dividedBy(D(totals.subtotal))
                                : D(0),
                            ).toFixed(2),
                          )}{" "}د.ع شحناً
                          <span className="font-normal text-muted-foreground">
                            {" "}(سعر الشراء {fmtAr(l.price)}{state.currency === "USD" ? "$" : " د.ع"})
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-1.5 border-t pt-1.5 text-[11px] text-muted-foreground">
                    <strong>لا تُضاف إلى ذمّة المورّد ولا إلى تكلفة الصنف.</strong> تُسجَّل مصروف نقلٍ
                    على الشركة لحظة الاستلام (يظهر في المصروفات والدفتر)، وتكلفة الصنف تبقى سعر المورّد وحده.
                  </div>
                </div>
              )}
              {landed.hasLanded && !landed.hasBase && (
                <p className="text-[11px] font-semibold text-amber-600">
                  أضِف منتجات بقيمة موجبة لتوزيع الشحن/الكمرك عليها.
                </p>
              )}
            </div>
          </section>

          <TotalsPanel
            items={state.items}
            state={state}
            dispatch={dispatch}
            showShipping={false}
            showOtherExpenses={false}
            showDiscount
            overrideDiscountAmount={invoiceDiscountAmount.toFixed(2)}
            showPayment={false}
            showTaxToggle
            overrideGrandTotal={state.currency === "USD" ? docTotals.total : landed.grand.toFixed(2)}
          />
          {/* مطابقة فاتورة المورّد: الإجماليّ المشتقّ يُقارَن بعملة الأمر — الدولاريّ بإجماليه
              الدولاريّ (مستند المورّد) والدينارّي بإجماليه الدينارّي، مطابقةً لحارس الخادم. */}
          <SupplierInvoiceMatch
            derivedTotal={state.currency === "USD" ? docTotals.total : landed.grand.toFixed(2)}
            value={state.supplierInvoiceTotal}
            onChange={(v) => dispatch({ type: "SET_FIELD", field: "supplierInvoiceTotal", value: v })}
            currency={state.currency}
            onDistribute={distributeInvoiceDifference}
            onApplyAsDiscount={applyDifferenceAsDiscount}
            canDistribute={D(totals.subtotal).gt(0)}
          />
          {state.currency === "USD" && landed.rate.gt(0) && (
            <section className="rounded-xl border bg-card px-4 py-3 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>إجمالي فاتورة المورد (دولار)</span>
                <span dir="ltr" className="font-bold text-foreground">{fmtAr(totals.grandTotal)} $</span>
              </div>
              <div className="mt-1 flex justify-between text-muted-foreground">
                <span>سعر التثبيت</span>
                <span dir="ltr" className="font-bold text-foreground">{fmtAr(state.agreedRate)} د.ع/$</span>
              </div>
              {/* التكلفة بالدينار = فاتورة المورد × سعر التثبيت. الشحن/الكمرك **ليسا** ضمنها
                  (مصروفُ نقلٍ مستقلٌّ لحظة الاستلام، قرار المالك ٥/٨) — لذا لا نقول «مع الشحن». */}
              <div className="mt-1 flex justify-between border-t pt-2 font-bold">
                <span>التكلفة بالدينار</span>
                <span dir="ltr">{fmtAr(landed.grand.toFixed(2))} د.ع</span>
              </div>
            </section>
          )}
          <ActionButtons
            invoiceType={INVOICE_TYPE}
            items={state.items}
            onAction={handleAction}
            saving={create.isPending}
            pasteAvailable={pasteAvailable}
          />
          <TermsAndNotes state={state} dispatch={dispatch} />
        </aside>
      </div>

      <ShortcutsBar />

      {/* idempotency token — مرئي للمطوّر فقط عبر data-attribute (يساعد التتبّع) */}
      <span data-client-request-id={clientRequestId} hidden aria-hidden />

      {/* Hint for branches still loading (rare) */}
      {!branches.data && (
        <p className="text-xs text-muted-foreground">جارٍ تحميل الفروع…</p>
      )}
    </div>
  );
}
