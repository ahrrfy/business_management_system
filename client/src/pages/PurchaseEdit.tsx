/**
 * PurchaseEdit — تعديل أمر شراء قائم **بنفس محرّر الإنشاء بالضبط**.
 *
 * هذه الشاشة توأمُ `PurchaseNew`: نفس `@/components/invoice` بـ`invoiceType="PURCHASE"`، ونفس
 * بطاقة الشحن/الكمرك، ونفس الاختصارات، ونفس التحقّق — فلا يتعلّم المستخدم واجهةً ثانية للتعديل.
 * الفرق الجوهريّ ثلاثة أشياء فقط:
 *   • الحالة الابتدائية تُبنى من `purchases.get` بدل سلّةٍ فارغة (بانتظار الجلب ⇒ هيكل تحميل).
 *   • الحفظ يستدعي `purchases.updateOrder` (استبدالٌ كامل للبنود) بدل `createOrder`.
 *   • الفرع غير قابل للتغيير (يحدّد ترقيم الأمر وعزله الأمنيّ) والحالة تبقى كما هي.
 *
 * الأهليّة يحسمها الخادم (لا استلام، لا دفعة، حالة غير نهائية) — والشاشة تعرض السبب بدل نموذجٍ
 * يقود إلى رفضٍ حتميّ بعد جهد إدخال.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { Landmark, Truck } from "lucide-react";
import {
  isWithinPriceDecimals,
  priceDecimalsFor,
  priceDecimalsMessage,
} from "@shared/moneyPrecision";
import { D, fmtAr, round2, toBase, toUnitPriceStr } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LoadingState, ErrorState } from "@/components/PageState";
import { EmptyState } from "@/components/EmptyState";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import {
  copyInvoiceItems,
  hasInvoiceTransfer,
  takeInvoiceItems,
} from "@/lib/invoiceTransfer";
import { printReportDoc } from "@/lib/printing/reportDoc";
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
  calcLineTotal,
  calcTotals,
  createInitialState,
  deriveDocumentTotal,
  distributeToSubtotal,
  invoiceReducer,
  matchSupplierInvoice,
  subtotalForInvoiceTotal,
  type InvoiceActionKind,
  type InvoiceLine,
  type InvoiceState,
} from "@/components/invoice";
import { PageHeader } from "@/components/PageHeader";

const INVOICE_TYPE = "PURCHASE" as const;

const PO_STATUS: Record<string, string> = {
  DRAFT: "مسوّدة",
  SENT: "مُرسَل",
  CONFIRMED: "مؤكّد",
  RECEIVED: "مُستلَم",
  CANCELLED: "ملغى",
};

/** إجراءات شاشة التعديل: بلا «مسوّدة» (الحالة لا تتغيّر بالتعديل) وبلا «مرتجع» (مساره مستقلّ). */
const EDIT_ACTIONS = ["save", "print", "duplicate", "paste"] as const;
/** F12 «تفريغ» مقصيّ عمداً: تفريغُ سلّة أمرٍ قائم إتلافٌ صامت لا اختصارُ إدخال. */
const EDIT_SHORTCUTS = [
  { key: "F2", label: "بحث" },
  { key: "F4", label: "حفظ" },
  { key: "F9", label: "طباعة" },
  { key: "Esc", label: "إلغاء" },
];

/** نظير safeMoney في PurchaseNew: MoneyInput يُصدر قيماً وسيطة («.») تكسر D() الخام أثناء الرسم. */
function safeMoney(v: string) {
  try {
    return D(v);
  } catch {
    return D(0);
  }
}

type PurchaseOrderData = NonNullable<RouterOutputs["purchases"]["get"]>;

/**
 * يبني حالة المحرّر من أمر الشراء المحفوظ.
 *
 * سعر السطر المعروض يتبع عملة الاتفاق: أمر الدولار أُدخِلت أسعاره بالدولار وحُوّلت خادمياً
 * بسعر التثبيت، فإعادةُ عرض السعر الدينارّي في محرّرٍ عملتُه USD كانت ستُضاعف التحويل عند
 * الحفظ (السعر × السعر). لذلك نعيد `usdUnitPrice` للأمر الدولاريّ و`unitPrice` للدينارّي.
 */
function stateFromOrder(
  order: PurchaseOrderData,
  branchId: number,
): InvoiceState {
  const base = createInitialState(INVOICE_TYPE, branchId);
  const isUsd = order.agreedCurrency === "USD";
  const items: InvoiceLine[] = order.items.map((it) => {
    // السعر المُعاد تحميله هو **ما قبل الخصم** (`listUnitPrice`) متى وُجد: المحرّر يحمل الخصم
    // في حقلٍ مستقلّ ويُعيد توزيعه عند الحفظ، فتحميلُ السعر الصافي كان سيخصم مرّتين.
    // `null` = بلا خصم (أو أمرٌ سابقٌ للعمود) ⇒ الصافي هو الأصل نفسه.
    const unitPrice = isUsd
      ? (it.usdListUnitPrice ?? it.usdUnitPrice ?? "0")
      : (it.listUnitPrice ?? it.unitPrice ?? "0");
    return {
      productId: Number(it.productId ?? 0),
      variantId: Number(it.variantId),
      productUnitId: Number(it.productUnitId),
      name:
        [it.productName, it.variantName].filter(Boolean).join(" — ") || "صنف",
      sku: it.sku ?? "",
      barcode: it.barcode ?? null,
      unit: it.unitName ?? "",
      qty: Number(it.quantity ?? 0),
      conversionFactor: String(it.conversionFactor ?? "1"),
      // المخزون معلومةٌ عرضٍ في محرّر الشراء (لا حارس بيع) — لقطة الأمر لا تحمله، وإظهار صفرٍ
      // كاذب أسوأ من إخفائه، لكن ProductTable يعرض العمود دائماً في وضع الشراء ⇒ صفرٌ محايد.
      stockBase: 0,
      price: String(unitPrice),
      costBase: String(unitPrice),
      discount: "0",
      discountType: "percent",
      note: "",
    };
  });
  const taxRate = String(order.taxRatePercent ?? "0");
  return {
    ...base,
    // رقم الأمر الحقيقيّ بدل رقمٍ مولَّد — الحقل للقراءة فقط في الرأس.
    invoiceNumber: order.poNumber,
    entityId: order.supplierId == null ? null : Number(order.supplierId),
    branchId,
    currency: isUsd ? "USD" : "IQD",
    agreedRate: isUsd ? String(order.agreedRate ?? "") : "",
    // قيمة فاتورة المورّد: تُملأ من `usdTotal` للأمر الدولاريّ **فقط** — فهو بالعقد «مبلغ فاتورة
    // المورد الفعلية». الأمر الدينارّي لا يملك عموداً مقابلاً، وملؤه من `total` كان سيدّعي أنّ
    // ورقة المورّد تساوي مجموعَنا **بلا أن يكون أحدٌ طابقهما** — ادّعاءُ حقيقةٍ لا نعرفها. يبقى
    // فارغاً فيملؤه الموظّف من الورقة إن أراد تفعيل الضابط على هذا التعديل.
    supplierInvoiceTotal: isUsd ? String(order.usdTotal ?? "") : "",
    // خصم فاتورة المورّد بعملة الأمر — يعود مبلغاً (لا نسبةً) كي يُعاد توزيعه كما أُدخل بالضبط.
    globalDiscount: (() => {
      const stored = isUsd ? order.usdInvoiceDiscount : order.invoiceDiscount;
      return stored != null && Number(stored) > 0 ? String(stored) : "";
    })(),
    globalDiscountType: "amount",
    notes: order.notes ?? "",
    taxEnabled: Number(taxRate) > 0,
    taxRatePercent: taxRate,
    items,
  };
}

/** بصمة ما يُرسَل فعلاً في الحفظ — لا كامل الحالة (حقولٌ عرضية كالفئة لا تُحفَظ في أمر الشراء). */
function editorFingerprint(
  state: InvoiceState,
  shippingCost: string,
  customsCost: string,
  revisionReason: string,
): string {
  return JSON.stringify({
    entityId: state.entityId,
    currency: state.currency,
    agreedRate: state.agreedRate,
    supplierInvoiceTotal: state.supplierInvoiceTotal,
    globalDiscount: state.globalDiscount,
    globalDiscountType: state.globalDiscountType,
    notes: state.notes,
    taxEnabled: state.taxEnabled,
    taxRatePercent: state.taxRatePercent,
    shippingCost,
    customsCost,
    revisionReason,
    items: state.items.map((l) => [
      l.variantId,
      l.productUnitId,
      l.qty,
      l.price,
    ]),
  });
}

export default function PurchaseEdit() {
  const params = useParams();
  const purchaseOrderId = Number(params.id);
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [pasteAvailable, setPasteAvailable] = useState(hasInvoiceTransfer);

  const po = trpc.purchases.get.useQuery(
    { purchaseOrderId },
    { enabled: Number.isFinite(purchaseOrderId) && purchaseOrderId > 0 },
  );
  trpc.suppliers.list.useQuery(); // تدفئة كاش EntityPicker (نفس PurchaseNew)

  const [state, dispatch] = useReducer(invoiceReducer, undefined, () =>
    createInitialState(INVOICE_TYPE, 1),
  );
  const [shippingCost, setShippingCost] = useState("");
  const [customsCost, setCustomsCost] = useState("");
  const [revisionReason, setRevisionReason] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  /** بصمة اللقطة المحفوظة — مقارنتها بالبصمة الحالية تُعطي «هل تغيّر شيء؟» بلا أعلامٍ متسلسلة. */
  const [baseline, setBaseline] = useState<string | null>(null);

  // تحميل الأمر في المحرّر **مرّةً واحدة**: إعادةُ الحقن عند كل إعادة جلبٍ (invalidate/refocus)
  // كانت ستطمس تعديلاً جارياً بلا إنذار.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current || !po.data) return;
    hydratedRef.current = true;
    const next = stateFromOrder(po.data, Number(po.data.branchId));
    const ship = D(po.data.shippingCost ?? 0).gt(0)
      ? String(po.data.shippingCost)
      : "";
    const customs = D(po.data.customsCost ?? 0).gt(0)
      ? String(po.data.customsCost)
      : "";
    dispatch({ type: "REPLACE_STATE", state: next });
    setShippingCost(ship);
    setCustomsCost(customs);
    setBaseline(editorFingerprint(next, ship, customs, ""));
  }, [po.data]);

  // حارس فقدان البيانات: نشِطٌ فقط بعد الحقن وعند اختلافٍ فعليّ عن اللقطة المحفوظة.
  const fingerprint = useMemo(
    () => editorFingerprint(state, shippingCost, customsCost, revisionReason),
    [state, shippingCost, customsCost, revisionReason],
  );
  useUnsavedGuard(baseline != null && baseline !== fingerprint);
  // البصمة لحظة نجاح الحفظ تُقرأ من ref لا من إغلاق الطفرة (قد يكون من رسمٍ أقدم).
  const fingerprintRef = useRef(fingerprint);
  fingerprintRef.current = fingerprint;

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
      notify.warn(
        "فاتورة المورّد أعلى من مجموع البنود — الخصم لا يُصلحها؛ راجع البنود الناقصة.",
      );
      return;
    }
    dispatch({
      type: "SET_FIELD",
      field: "globalDiscountType",
      value: "amount",
    });
    dispatch({
      type: "SET_FIELD",
      field: "globalDiscount",
      value: next.toFixed(2),
    });
    notify.ok(
      `سُجّل الفرق خصمَ فاتورةٍ بمقدار ${next.toFixed(2)} — يُوزَّع على البنود بنسبة قيمتها.`,
    );
  }

  const insightItems = useMemo(
    () =>
      Array.from(
        new Map(
          state.items.map((item) => [
            `${item.variantId}:${item.productUnitId}`,
            { variantId: item.variantId, productUnitId: item.productUnitId },
          ]),
        ).values(),
      ),
    [state.items],
  );
  const priceInsights = trpc.purchases.priceInsights.useQuery(
    {
      branchId: state.branchId,
      supplierId: state.entityId ?? undefined,
      items: insightItems,
    },
    { enabled: state.branchId > 0 && insightItems.length > 0 },
  );

  const update = trpc.purchases.updateOrder.useMutation({
    onSuccess: async (r) => {
      // اللقطة المحفوظة صارت هي الحالية ⇒ يهدأ حارس فقدان البيانات قبل التنقّل.
      setBaseline(fingerprintRef.current);
      await Promise.all([
        utils.purchases.get.invalidate({ purchaseOrderId }),
        utils.purchases.list.invalidate(),
      ]);
      notify.ok(`حُفظت تعديلات أمر الشراء ${r.poNumber}`);
      navigate(`/purchases/${purchaseOrderId}`);
    },
    onError: (e) => notify.err(e),
  });

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
      state.globalDiscountType === "percent"
        ? round2(gross.times(raw).dividedBy(100))
        : round2(raw);
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
    [
      state.items,
      state.taxEnabled,
      state.taxRatePercent,
      invoiceDiscountAmount,
    ],
  );

  // نفس معاينة PurchaseNew: الشحن/الكمرك **خارج** الإجمالي (مصروف نقلٍ لا ذمّة مورّد).
  const landed = useMemo(() => {
    const sum = round2(safeMoney(shippingCost).plus(safeMoney(customsCost)));
    // المجموع الفرعيّ بترتيب تقريب الخادم (سطراً سطراً) لا بجمعٍ غير مقرَّب — مصدرٌ واحد.
    const sourceSubtotal = D(docTotals.subtotal);
    const rate = state.currency === "USD" ? safeMoney(state.agreedRate) : D(1);
    // نفس ترتيب تقريب الخادم (سطراً سطراً ثمّ الجمع، والضريبة على المجموع الدينارّي) — انظر
    // التعليق المفصَّل في PurchaseNew: «المعروض = المحفوظ» شرطُ ألّا يدفع المالك ما لم يُحفَظ.
    // الخصم فاتوريّ: نطبّق نسبته على كلّ سطرٍ قبل الترجمة تماماً كما يفعل `allocateByValue`.
    const grossDoc = D(docTotals.grossSubtotal);
    const netRatio = grossDoc.gt(0)
      ? D(docTotals.subtotal).dividedBy(grossDoc)
      : D(1);
    const goodsIqd =
      state.currency === "USD"
        ? round2(
            state.items.reduce(
              (acc, l) =>
                acc.plus(
                  round2(
                    round2(
                      round2(safeMoney(l.price).times(D(l.qty || 0))).times(
                        netRatio,
                      ),
                    ).times(rate),
                  ),
                ),
              D(0),
            ),
          )
        : round2(sourceSubtotal.times(rate));
    const taxIqd = state.taxEnabled
      ? round2(
          goodsIqd.times(safeMoney(state.taxRatePercent || "0")).dividedBy(100),
        )
      : D(0);
    const grand = round2(goodsIqd.plus(taxIqd));
    return {
      sum,
      goodsIqd,
      taxIqd,
      grand,
      rate,
      hasLanded: sum.gt(0),
      hasBase: goodsIqd.gt(0),
    };
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

  // حكم المطابقة — مصدرٌ واحد للتحقّق وللوحة معاً (نظير PurchaseNew).
  const invoiceMatch = useMemo(
    () =>
      matchSupplierInvoice(
        state.currency === "USD" ? docTotals.total : landed.grand.toFixed(2),
        state.supplierInvoiceTotal,
        state.currency,
      ),
    [state.currency, state.supplierInvoiceTotal, docTotals.total, landed.grand],
  );

  /** يوزّع فرق المطابقة على أسعار البنود بنسبة القيمة — الأسعار الجديدة تظهر قبل الحفظ. */
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
      notify.warn(
        `وُزّع الفرق، وبقي ${res.residual} غير قابلٍ للتوزيع بدقّة العملة — عدّل سعر بندٍ يدوياً لإتمام المطابقة.`,
      );
    }
  }

  function validate(): string | null {
    if (revisionReason.trim().length < 3) {
      return "اكتب سبب المراجعة (3 محارف على الأقل) كي يظهر التغيير في سجل أمر الشراء.";
    }
    if (!state.entityId) return "اختر المورد قبل الحفظ.";
    if (state.items.length === 0) return "أضف منتجاً واحداً على الأقل.";
    for (const l of state.items) {
      const qty = D(l.qty);
      if (!qty.gt(0)) return `الكمية في «${l.name}» يجب أن تكون موجبة.`;
      const price = D(l.price);
      if (price.lt(0)) return `سعر الشراء في «${l.name}» غير صالح.`;
      // مرآة حارس الخادم: الدينار منزلتان والدولار أربع. يمسك ما جاء من لصقٍ أو من أمرٍ قديم.
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
    if (landed.hasLanded && !landed.hasBase) {
      return "أضِف منتجات بقيمة موجبة قبل إدخال تكلفة الشحن/الكمرك.";
    }
    if (invoiceMatch.verdict !== "UNSET" && invoiceMatch.verdict !== "MATCH") {
      return invoiceMatch.message;
    }
    return null;
  }

  function handleSubmit() {
    if (update.isPending) return;
    const err = validate();
    if (err) {
      notify.warn(err);
      return;
    }
    update.mutate({
      purchaseOrderId,
      expectedVersion: Number(po.data?.version),
      revisionReason: revisionReason.trim(),
      supplierId: state.entityId!,
      taxRatePercent: state.taxEnabled
        ? round2(D(state.taxRatePercent || "0")).toFixed(2)
        : "0",
      notes: state.notes.trim() || undefined,
      agreedCurrency: state.currency,
      // نظير createOrder: لا نُرسل usdTotal — الخادم يشتقّه من البنود بترتيب تقريبٍ محدَّد،
      // وإرسالُ إجماليٍّ مشتقٍّ من أسعارٍ كاملة الدقّة يُفشل حارسَ المطابقة بفرق تقريبٍ بحت.
      agreedRate:
        state.currency === "USD"
          ? safeMoney(state.agreedRate).toFixed(4)
          : undefined,
      // خصم فاتورة المورّد (0204): يُرسَل بعملة الأمر ويُوزّعه الخادم بنسبة القيمة.
      invoiceDiscount: invoiceDiscountAmount.gt(0)
        ? invoiceDiscountAmount.toFixed(2)
        : undefined,
      // مطابقة فاتورة المورّد (نظير الإنشاء): الخادم يرفض حفظ تعديلٍ يخالف قيمة المستند.
      supplierInvoiceTotal: state.supplierInvoiceTotal.trim()
        ? round2(safeMoney(state.supplierInvoiceTotal)).toFixed(2)
        : undefined,
      shippingCost: safeMoney(shippingCost).gt(0)
        ? round2(safeMoney(shippingCost)).toFixed(2)
        : undefined,
      customsCost: safeMoney(customsCost).gt(0)
        ? round2(safeMoney(customsCost)).toFixed(2)
        : undefined,
      items: state.items.map((l) => ({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        quantity: D(l.qty).toString(),
        // بدقّة عملة الأمر: كان `round2(...)` يقصّ أسعار الأمر الدولاريّ إلى منزلتين عند **كلّ
        // حفظ** ولو لم تُمَسّ — تعديلُ ملاحظةٍ كان يُنقص قيمة الفاتورة صامتاً (المحرّر يقرأ
        // `usdUnitPrice` بأربع منازل ثمّ يُعيدها اثنتَين).
        unitPrice: toUnitPriceStr(l.price, state.currency),
      })),
    });
  }

  /**
   * طباعة أمر الشراء بمستند A4 بهوية النظام بدل `window.print()` الخام.
   *
   * الخام كان يطبع الصفحة كما هي: أزرار الأدوات وحقول الإدخال وشريط الاختصارات مع البنود،
   * وبلا رسالةٍ حين يحجب المتصفّح النافذة المنبثقة. `printReportDoc` يوحّد الثلاثة.
   *
   * المحتوى **هو المعروض نفسه** لا أكثر: أعمدة `ProductTable` في وضع الشراء (باركود · منتج ·
   * وحدة · سعر الشراء · الكمية · الإجمالي · المعادل د.ع للأمر الدولاريّ)، ثمّ لوحة المبالغ،
   * ثمّ بطاقة الشحن/الكمرك وتنويهها بنفس شرط ظهورها على الشاشة.
   *
   * عمود «المخزون» وحده مُقصىً عمداً: `stateFromOrder` يضع `stockBase: 0` لكلّ سطر لأنّ لقطة
   * الأمر لا تحمل الرصيد (تعليقُه في مكانه) ⇒ طباعتُه تُثبِّت صفراً كاذباً في ورقةٍ تُسلَّم.
   */
  function printOrder() {
    const data = po.data;
    if (!data) return;
    if (state.items.length === 0) {
      notify.warn("لا توجد بنود لطباعتها.");
      return;
    }
    const usd = state.currency === "USD";
    const priceSym = usd ? "$" : "د.ع";
    const rate = safeMoney(state.agreedRate);
    // نفس شرط عمود «المعادل د.ع» في ProductTable — لا يظهر إلا حيث يظهر على الشاشة.
    const showIqdEquivalent = usd && rate.gt(0);

    // ⚠️ `fmtAr` يقصّ إلى منزلتين، وسعر الوحدة الدولاريّ أربع (§دقّة سعر الوحدة = دقّة العملة)
    // ⇒ تنسيقٌ يجمع الآلاف بأرقامٍ لاتينية مع الاحتفاظ بدقّة العملة. القيمة مقرَّبةٌ سلفاً
    // بـ`toUnitPriceStr` فالتحويل هنا عرضٌ محض لا حساب.
    // و`safeMoney` **إلزاميّ** لا احتياط: `InlineNumberInput` يمرّر «» و«.» أثناء الكتابة
    // (سطر 97 في ProductTable) ⇒ `D()` الخام يرمي، وطباعةٌ ترمي أثناء تحرير سعرٍ تُسقط
    // المحرّر وتُضيّع تعديلاً غير محفوظ — و`window.print()` التي نستبدلها لم تكن تفعل ذلك.
    const priceDp = priceDecimalsFor(state.currency);
    const fmtPrice = (v: string) =>
      Number(
        toUnitPriceStr(safeMoney(v).toString(), state.currency),
      ).toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: priceDp });

    const rows = state.items.map((l) => {
      const lineTotal = calcLineTotal(l);
      return {
        barcode: l.barcode ?? "—",
        name: l.name,
        unit: l.unit || "—",
        // السعر المعروض في الخليّة هو `costBase || price` بدقّة عملة الأمر (مرآة ProductTable).
        price: fmtPrice(l.costBase || l.price),
        qty: fmtAr(safeMoney(String(l.qty)).toString()),
        total: fmtAr(lineTotal),
        iqd: showIqdEquivalent
          ? fmtAr(round2(D(lineTotal).times(rate)).toFixed(2))
          : "",
      };
    });

    // ملخّص المبالغ = لوحة `TotalsPanel` المعروضة سطراً بسطر (بعملة الأمر)، يليها بطاقة
    // الدولار حين تظهر. شريط الإجمالي الأخضر في `docSummary` يكتب «د.ع» ثابتاً ⇒ آخر عنصرٍ
    // يجب أن يكون ديناريّاً دائماً: للأمر الدولاريّ هو «التكلفة بالدينار» من بطاقة الدولار.
    const summary = [
      { label: `المجموع الفرعي (${priceSym})`, value: fmtAr(totals.subtotal) },
      ...(invoiceDiscountAmount.gt(0)
        ? [
            {
              label: `خصم فاتورة المورّد (${priceSym})`,
              value: `− ${fmtAr(invoiceDiscountAmount.toFixed(2))}`,
            },
          ]
        : []),
      ...(D(totals.totalTax).gt(0)
        ? [
            {
              label: `الضريبة (${fmtAr(state.taxRatePercent || "0")}%) (${priceSym})`,
              value: fmtAr(totals.totalTax),
            },
          ]
        : []),
      ...(usd
        ? [
            { label: "الإجمالي النهائي ($)", value: `${fmtAr(docTotals.total)} $` },
            ...(rate.gt(0)
              ? [{ label: "سعر التثبيت", value: `${fmtAr(state.agreedRate)} د.ع/$` }]
              : []),
          ]
        : []),
      {
        label: usd ? "التكلفة بالدينار" : "الإجمالي النهائي",
        value: fmtAr(landed.grand.toFixed(2)),
        bold: true,
        large: true,
      },
    ];

    const orderFields = [
      { label: "رقم الأمر", value: state.invoiceNumber || "—" },
      { label: "الحالة", value: PO_STATUS[data.status] ?? data.status },
      { label: "العملة", value: usd ? "دولار أمريكي" : "دينار عراقي" },
      ...(usd && rate.gt(0)
        ? [{ label: "سعر التثبيت", value: `${fmtAr(state.agreedRate)} د.ع/$` }]
        : []),
      ...(safeMoney(shippingCost).gt(0)
        ? [{ label: "الشحن (خارج الإجمالي)", value: `${fmtAr(shippingCost)} د.ع` }]
        : []),
      ...(safeMoney(customsCost).gt(0)
        ? [{ label: "الكمرك (خارج الإجمالي)", value: `${fmtAr(customsCost)} د.ع` }]
        : []),
      ...(state.notes.trim()
        ? [{ label: "ملاحظات", value: state.notes.trim() }]
        : []),
      ...((state.terms ?? "").trim()
        ? [{ label: "الشروط والأحكام", value: (state.terms ?? "").trim() }]
        : []),
    ];

    printReportDoc({
      title: "أمر شراء",
      docNum: state.invoiceNumber || null,
      docDate: fmtDate(data.orderDate),
      // نفس تنويه بطاقة الشحن/الكمرك وبنفس شرط ظهوره على الشاشة بالضبط.
      note:
        landed.hasLanded && landed.hasBase
          ? "الشحن والكمرك لا يُضافان إلى ذمّة المورّد ولا إلى تكلفة الصنف — يُسجَّلان مصروف نقلٍ على الشركة لحظة الاستلام."
          : undefined,
      meta: [
        {
          title: "معلومات المورد",
          fields: [{ label: "الاسم", value: data.supplierName ?? "—" }],
        },
        { title: "تفاصيل الأمر", fields: orderFields },
      ],
      columns: [
        { key: "barcode", label: "الباركود", width: "24mm", align: "center" },
        { key: "name", label: "المنتج" },
        { key: "unit", label: "الوحدة", width: "16mm", align: "center" },
        {
          key: "price",
          label: `سعر الشراء ${priceSym}`,
          width: "24mm",
          align: "left",
        },
        { key: "qty", label: "الكمية", width: "16mm", align: "center" },
        {
          key: "total",
          label: `الإجمالي ${priceSym}`,
          width: "26mm",
          align: "left",
          bold: true,
        },
        ...(showIqdEquivalent
          ? [
              {
                key: "iqd",
                label: "المعادل د.ع",
                width: "26mm",
                align: "left" as const,
              },
            ]
          : []),
      ],
      rows,
      summary,
      orientation: showIqdEquivalent ? "landscape" : "portrait",
    });
  }

  function handleAction(kind: InvoiceActionKind) {
    switch (kind) {
      case "save":
        handleSubmit();
        return;
      case "print":
        printOrder();
        return;
      case "duplicate":
        if (!state.items.length) return notify.warn("لا توجد محتويات لنسخها.");
        copyInvoiceItems(state.items);
        setPasteAvailable(true);
        notify.ok("تم نسخ المنتجات. ستجد «لصق» في أي فاتورة تفتحها.");
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
      default:
        notify.info("هذا الإجراء غير متاح في شاشة التعديل.");
        return;
    }
  }

  /* ─── keyboard shortcuts (F2/F4/F9/Esc) — نفس محرّر الإنشاء عدا F12 (لا تفريغ لأمرٍ قائم) ── */
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        containerRef.current
          ?.querySelector<HTMLInputElement>('input[aria-label="بحث المنتجات"]')
          ?.focus();
        return;
      }
      if (e.key === "F4") {
        e.preventDefault();
        if (!update.isPending) handleSubmit();
        return;
      }
      if (e.key === "F9") {
        e.preventDefault();
        printOrder();
        return;
      }
      if (e.key === "Escape" && bulkOpen) setBulkOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkOpen, update.isPending, state, shippingCost, customsCost]);

  /* ─── حالات ما قبل المحرّر ──────────────────────────────────────── */
  if (!Number.isFinite(purchaseOrderId) || purchaseOrderId <= 0) {
    return <ErrorState message="رقم أمر شراء غير صالح." />;
  }
  if (po.isLoading) return <LoadingState />;
  if (po.error) {
    return po.error.data?.code === "FORBIDDEN" ? (
      <EmptyState
        title="لا تملك صلاحية تعديل المشتريات"
        description="تعديل أمر الشراء يتطلّب صلاحية المشتريات (كاملة) — اطلبها من المدير."
      />
    ) : (
      <ErrorState message={po.error.message} />
    );
  }
  if (!po.data) {
    return (
      <EmptyState
        title="أمر الشراء غير موجود"
        description="قد يكون محذوفاً أو يخصّ فرعاً آخر لا تملك الاطّلاع عليه."
      />
    );
  }

  const order = po.data;
  const received = order.items.some((it) => (it.receivedBaseQuantity ?? 0) > 0);
  const terminal = order.status === "RECEIVED" || order.status === "CANCELLED";
  const confirmed = order.status === "CONFIRMED";
  const submitted = order.status === "SENT";
  const paid = D(order.paidAmount ?? 0).gt(0) || D(order.paidUsd ?? 0).gt(0);
  // مرآةُ حرّاس الخادم: نُبيّن السبب قبل الإدخال بدل رفضٍ حتميّ بعد ملء النموذج.
  const blockedReason = submitted
    ? "أمر الشراء مُرسل للاعتماد. انتظر قرار المراجع؛ عند الرفض يعود مسودة قابلة للتعديل."
    : confirmed
      ? "أمر الشراء معتمد وغير قابل للتعديل — أنشئ أمراً جديداً، أو استعمل مرتجع شراء بعد الاستلام."
      : terminal
        ? `أمر الشراء ${PO_STATUS[order.status] ?? order.status} — لا يُعدَّل بعد ذلك. استعمل مرتجع شراء أو أنشئ أمراً جديداً.`
        : received
          ? "استُلمت بضاعة من هذا الأمر — التعديل بعد الاستلام يُغيّر مخزوناً وذمّةً مُرحَّلَين. استعمل مرتجع شراء."
          : paid
            ? "على هذا الأمر دفعة مسجَّلة للمورّد — لا يُعدَّل قبل تسوية الدفعة."
            : null;
  if (blockedReason) {
    return (
      <div className="space-y-4">
        <EmptyState
          title={`تعذّر تعديل أمر الشراء ${order.poNumber}`}
          description={blockedReason}
        />
        <div className="flex justify-center gap-2">
          <Link
            href={`/purchases/${purchaseOrderId}`}
            className="text-sm font-semibold text-primary hover:underline"
          >
            عرض تفاصيل الأمر
          </Link>
          <Link
            href="/purchases"
            className="text-sm font-semibold text-muted-foreground hover:text-foreground"
          >
            رجوع للمشتريات
          </Link>
        </div>
      </div>
    );
  }

  const meta = INVOICE_TYPES[INVOICE_TYPE];

  return (
    <div ref={containerRef} dir="rtl" className="flex flex-col gap-3">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span>تعديل {meta.label}</span>
            <span
              className="font-mono text-sm font-semibold text-muted-foreground"
              dir="ltr"
            >
              {order.poNumber}
            </span>
          </span>
        }
        icon={(() => {
          const MIcon = meta.icon;
          return <MIcon aria-hidden className="size-5 text-primary" />;
        })()}
        backHref={`/purchases/${purchaseOrderId}`}
        backLabel="رجوع للأمر"
        actions={
          <span className="hidden text-xs font-semibold text-muted-foreground sm:inline">
            الإجمالي:{" "}
            <span className="font-extrabold text-foreground" dir="ltr">
              {fmtAr(landed.grand.toFixed(2))}
            </span>{" "}
            د.ع
          </span>
        }
      />

      <InvoiceHeader
        state={state}
        dispatch={dispatch}
        invoiceType={INVOICE_TYPE}
        statusBadge={PO_STATUS[order.status] ?? order.status}
        lockBranch
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
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
            onNotify={(msg, kind) =>
              kind === "error" ? notify.err(msg) : notify.info(msg)
            }
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
          <section className="overflow-hidden rounded-xl border bg-card">
            <header className="flex items-center gap-2 border-b bg-muted px-4 py-2.5">
              <Truck aria-hidden className="size-5" />
              <span className="text-sm font-extrabold">
                تكلفة الشحن والكمرك
              </span>
              <span className="ms-auto text-[11px] font-semibold text-muted-foreground">
                اختياري
              </span>
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
                <div className="mt-1 rounded-lg border border-dashed bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
                  <strong>
                    لا تُضاف إلى ذمّة المورّد ولا إلى تكلفة الصنف.
                  </strong>{" "}
                  تُسجَّل مصروف نقلٍ على الشركة لحظة الاستلام (يظهر في المصروفات
                  والدفتر)، وتكلفة الصنف تبقى سعر المورّد وحده.
                </div>
              )}
              {landed.hasLanded && !landed.hasBase && (
                <p className="text-[11px] font-semibold text-[var(--sem-warn)]">
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
            overrideGrandTotal={
              state.currency === "USD"
                ? docTotals.total
                : landed.grand.toFixed(2)
            }
          />
          <SupplierInvoiceMatch
            derivedTotal={
              state.currency === "USD"
                ? docTotals.total
                : landed.grand.toFixed(2)
            }
            value={state.supplierInvoiceTotal}
            onChange={(v) =>
              dispatch({
                type: "SET_FIELD",
                field: "supplierInvoiceTotal",
                value: v,
              })
            }
            currency={state.currency}
            onDistribute={distributeInvoiceDifference}
            onApplyAsDiscount={applyDifferenceAsDiscount}
            canDistribute={D(totals.subtotal).gt(0)}
          />
          <section className="space-y-2 rounded-xl border bg-card px-4 py-3">
            <Label htmlFor="purchase-revision-reason">سبب المراجعة</Label>
            <Textarea
              id="purchase-revision-reason"
              value={revisionReason}
              maxLength={500}
              rows={3}
              placeholder="مثال: تعديل كمية البند الثاني وفق عرض المورد المحدّث"
              onChange={(event) => setRevisionReason(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              مطلوب ويُحفظ مع المراجعة الجديدة؛ الاعتماد اللاحق يطابق هذه النسخة
              تحديداً.
            </p>
          </section>
          {state.currency === "USD" && landed.rate.gt(0) && (
            <section className="rounded-xl border bg-card px-4 py-3 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>إجمالي فاتورة المورد (دولار)</span>
                <span dir="ltr" className="font-bold text-foreground">
                  {fmtAr(totals.grandTotal)} $
                </span>
              </div>
              <div className="mt-1 flex justify-between text-muted-foreground">
                <span>سعر التثبيت</span>
                <span dir="ltr" className="font-bold text-foreground">
                  {fmtAr(state.agreedRate)} د.ع/$
                </span>
              </div>
              <div className="mt-1 flex justify-between border-t pt-2 font-bold">
                <span>التكلفة بالدينار</span>
                <span dir="ltr">{fmtAr(landed.grand.toFixed(2))} د.ع</span>
              </div>
            </section>
          )}
          {/* بلا «مسوّدة»: التعديل لا يغيّر حالة الأمر (لها إجراؤها المستقلّ)، وزرٌّ يوهم
              بحفظِ مسوّدةٍ ثانية على أمرٍ قائم يخلق مساراً لا وجود له. */}
          <ActionButtons
            invoiceType={INVOICE_TYPE}
            items={state.items}
            onAction={handleAction}
            saving={update.isPending}
            pasteAvailable={pasteAvailable}
            availableActions={EDIT_ACTIONS}
            primaryLabel="حفظ التعديلات قبل الاعتماد"
            printLabel="طباعة"
          />
          <TermsAndNotes state={state} dispatch={dispatch} />
        </aside>
      </div>

      <ShortcutsBar shortcuts={EDIT_SHORTCUTS} />
    </div>
  );
}
