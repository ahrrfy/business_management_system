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
 *   • بنجاح الإنشاء ⇒ تُحفَظ مسودة وتعود لقائمة الاعتماد؛ لا استلام قبل اعتماد مستقل.
 *
 * الذرّية والأموال يتولاها الخادم (createPurchaseOrder ⇒ withTx + decimal.js). الواجهة هنا
 * لا تستخدم parseFloat/Number في الأموال (الجمعات داخل calcTotals + decimal.js).
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { ClipboardList, CheckCircle2, Send } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateFinancialQueries } from "@/lib/realtime/financialQueries";
import {
  PurchaseShippingCard,
  calcPurchaseLandedCost,
  safeMoney,
} from "@/components/purchases/PurchaseShippingCard";
import { printPurchaseOrderDoc } from "@/components/purchases/purchaseOrderPrint";
import {
  PurchaseSettlementPolicyCard,
  runImmediatePostWorkflow,
  runSubmitForApprovalWorkflow,
  usePurchaseCashSourceState,
} from "@/components/purchases/PurchaseCashSourceField";
import { ACTION_LABELS } from "@shared/actionLabels";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  isWithinPriceDecimals,
  priceDecimalsFor,
  priceDecimalsMessage,
} from "@shared/moneyPrecision";
import { variantDisplayName } from "@shared/variantDisplay";
import { D, fmtAr, formatQuantity, round2, toBase, toUnitPriceStr } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { MoneyInput } from "@/components/form/MoneyInput";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { canLifecycleOperation } from "@/lib/lifecycleOperationAccess";
import { useUnsavedGuard, bypassUnsavedGuard } from "@/hooks/useUnsavedGuard";
import {
  copyInvoiceItems,
  hasInvoiceTransfer,
  takeInvoiceItems,
} from "@/lib/invoiceTransfer";
import {
  ActionButtons,
  BulkPicker,
  INVOICE_TYPES,
  InvoiceHeader,
  ProductTable,
  ShortcutsBar,
  SupplierInvoiceMatch,
  TermsAndNotes,
  composeDocumentNotes,
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
} from "@/components/invoice";
import { derivePurchaseLinePriceFromRequisition } from "@/components/invoice/purchasePrice";
import { PageHeader } from "@/components/PageHeader";

const INVOICE_TYPE = "PURCHASE" as const;
const NEW_ACTIONS = ["save", "print", "duplicate", "paste"] as const;

export const __TEST_ONLY__ = {
  runSubmitForApprovalWorkflow,
  runImmediatePostWorkflow,
};

export default function PurchaseNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const [pasteAvailable, setPasteAvailable] = useState(hasInvoiceTransfer);
  const searchParams = useMemo(
    () => new URLSearchParams(window.location.search),
    [],
  );
  const requisitionId = useMemo(() => {
    const raw = searchParams.get("requisitionId");
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : null;
  }, [searchParams]);
  const prefillKey = useMemo(() => searchParams.get("prefillKey"), [searchParams]);
  const isUnassignedMode = useMemo(() => searchParams.get("mode") === "unassigned_sourcing", [searchParams]);
  const autoReason = useMemo(() => searchParams.get("autoReason"), [searchParams]);

  const [prefillVariantIds] = useState<number[]>(() => {
    if (!prefillKey) {
      const rawItems = searchParams.get("items");
      if (rawItems) {
        return rawItems.split(",").map(Number).filter((id) => Number.isInteger(id) && id > 0);
      }
      return [];
    }
    try {
      const data = sessionStorage.getItem(prefillKey);
      if (data) {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          return parsed.map(Number).filter((id) => Number.isInteger(id) && id > 0);
        }
      }
    } catch {
      // ignore parse errors
    }
    return [];
  });

  /* ─── server data ──────────────────────────────────────────────── */
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const requisition = trpc.purchases.requisition.useQuery(
    { requisitionId: requisitionId ?? 1 },
    { enabled: requisitionId != null },
  );
  const requisitionUnitIds = useMemo(
    () =>
      Array.from(
        new Set(
          (requisition.data?.items ?? [])
            .map((item) => Number(item.productUnitId))
            .filter((id) => id > 0),
        ),
      ),
    [requisition.data?.items],
  );
  const requisitionCatalog = trpc.catalog.byUnitIds.useQuery(
    {
      branchId: Number(requisition.data?.branchId ?? me.data?.branchId ?? 0),
      tier: "RETAIL",
      productUnitIds: requisitionUnitIds,
    },
    { enabled: requisition.data != null && requisitionUnitIds.length > 0 },
  );
  // suppliers مُحمَّل داخل EntityPicker — لا نكرّر هنا، لكن نُدفئ الكاش للتجاوب.
  trpc.suppliers.list.useQuery();

  /* ─── editor state (reducer) ───────────────────────────────────── */
  const [state, dispatch] = useReducer(invoiceReducer, undefined, () => ({
    ...createInitialState(INVOICE_TYPE, me.data?.branchId ? Number(me.data.branchId) : 0),
  }));

  const requisitionHydratedRef = useRef(false);
  useEffect(() => {
    if (!requisitionId || requisitionHydratedRef.current || !requisition.data)
      return;
    if (requisitionUnitIds.length > 0 && !requisitionCatalog.data) return;
    if (!["APPROVED", "PARTIALLY_ORDERED"].includes(requisition.data.status)) {
      notify.warn(
        "لا يمكن تحويل طلب الشراء قبل اعتماده أو بعد إقفاله بالكامل.",
      );
      requisitionHydratedRef.current = true;
      return;
    }
    const catalogByUnit = new Map(
      (requisitionCatalog.data ?? []).map((row) => [
        Number(row.productUnitId),
        row,
      ]),
    );
    const lines = requisition.data.items.flatMap((item): InvoiceLine[] => {
      const availableBase =
        Number(item.approvedBaseQuantity) - Number(item.orderedBaseQuantity);
      const row = catalogByUnit.get(Number(item.productUnitId));
      if (!row || availableBase <= 0) return [];
      const conversionFactor = String(row.conversionFactor || "1");
      return [
        {
          productId: Number(row.productId),
          variantId: Number(row.variantId),
          productUnitId: Number(row.productUnitId),
          name: variantDisplayName({
            productName: row.productName,
            variantName: row.variantName,
            color: row.color,
            size: row.size,
            sku: row.sku,
          }),
          sku: row.sku ?? "",
          barcode: row.barcode ?? null,
          unit: row.unitName ?? "",
          qty: D(availableBase).dividedBy(D(conversionFactor)).toNumber(),
          conversionFactor,
          stockBase: row.stockBase ?? 0,
          stockBranchId: row.branchId,
          reservedBase: row.reservedBase ?? 0,
          availableBase: row.availableBase ?? 0,
          isService: row.isService ?? false,
          // Codex #980 (٤/٩/٢٦) — Finding 4: مسار الاستحضار من طلب شراء يتخطّى ProductSearchBar
          // و`BulkPicker`. `estimatedUnitPrice` القادم مُخزَّنٌ بالدينار (عمود `decimal(15,2)`
          // بلا عمود عملة على `purchaseRequisitionItems`) وقد يكون **مصاباً** بعطب PUR-UNIT-01
          // القديم (حُقن بـ`costPriceBase` بلا ضربٍ بالمعامل) ⇒ درزنٌ يصل هنا بسعرِ ١٥٠ لا
          // ١٨٠٠. المساعد المشتَرَك يكشف الإصابة (القادم ≤ تكلفة الأساس بينما المعامل > ١)
          // ويُعيد الحساب. الأمر يبدأ بالدينار (لا عمود عملة على `purchaseRequisitions`) —
          // تحويلُ العملة قرارُ المستخدم قبل الحفظ، والمحرّر يرفض الحفظَ الدولاريّ بلا
          // `agreedRate > 0`.
          price: derivePurchaseLinePriceFromRequisition(item.estimatedUnitPrice, row.costPriceBase, conversionFactor),
          costBase: row.costPriceBase ?? "0",
          discount: "0",
          discountType: "percent",
          note: item.justification,
        },
      ];
    });
    dispatch({
      type: "SET_FIELD",
      field: "branchId",
      value: Number(requisition.data.branchId),
    });
    const preferredSupplierIds = Array.from(
      new Set(
        requisition.data.items
          .map((item) => item.preferredSupplierId)
          .filter((id): id is number => id != null)
          .map(Number),
      ),
    );
    if (preferredSupplierIds.length === 1)
      dispatch({ type: "SET_ENTITY", id: preferredSupplierIds[0] });
    dispatch({
      type: "SET_FIELD",
      field: "notes",
      value: `تحويل من طلب الشراء ${requisition.data.requisitionNumber}: ${requisition.data.purpose}`,
    });
    if (lines.length) dispatch({ type: "ADD_ITEMS", items: lines });
    requisitionHydratedRef.current = true;
  }, [
    requisitionId,
    requisition.data,
    requisitionCatalog.data,
    requisitionUnitIds,
  ]);

  const purchaseBranchId = state.branchId || me.data?.branchId;
  const purchasableCatalog = trpc.catalog.forPurchase.useQuery(
    {
      branchId: purchaseBranchId as number,
      limit: 500,
    },
    { enabled: prefillVariantIds.length > 0 && Boolean(purchaseBranchId) },
  );

  const prefillHydratedRef = useRef(false);
  useEffect(() => {
    if (
      prefillHydratedRef.current ||
      prefillVariantIds.length === 0 ||
      !purchasableCatalog.data
    )
      return;
    const variantIdSet = new Set(prefillVariantIds);
    const matchedRows = new Map<
      number,
      (typeof purchasableCatalog.data)[number]
    >();
    for (const row of purchasableCatalog.data) {
      if (variantIdSet.has(Number(row.variantId))) {
        if (!matchedRows.has(Number(row.variantId)) || row.isBaseUnit) {
          matchedRows.set(Number(row.variantId), row);
        }
      }
    }
    const lines: InvoiceLine[] = Array.from(matchedRows.values()).map(
      (row) => ({
        productId: Number(row.productId),
        variantId: Number(row.variantId),
        productUnitId: Number(row.productUnitId),
        name: variantDisplayName({
          productName: row.productName,
          variantName: row.variantName,
          color: row.color,
          size: row.size,
          sku: row.sku,
        }),
        sku: row.sku ?? "",
        barcode: null,
        unit: row.unitName ?? "",
        qty: 1,
        conversionFactor: String(row.conversionFactor || "1"),
        stockBase: row.stockBase ?? 0,
        stockBranchId: state.branchId,
        reservedBase: 0,
        availableBase: row.stockBase ?? 0,
        isService: false,
        price: row.costPriceBase ?? "0",
        costBase: row.costPriceBase ?? "0",
        discount: "0",
        discountType: "percent",
        note: autoReason === "low_stock" ? "نواقص مخزون بحاجة لتأمين" : "",
      }),
    );

    if (lines.length > 0) {
      dispatch({ type: "ADD_ITEMS", items: lines });
      notify.ok(
        `تم إدراج ${lines.length} صنف من نواقص المخزون تلقائياً في مسودة الشراء`,
      );
      if (prefillKey) {
        try {
          sessionStorage.removeItem(prefillKey);
        } catch {}
      }
    }
    prefillHydratedRef.current = true;
  }, [
    prefillVariantIds,
    purchasableCatalog.data,
    state.branchId,
    autoReason,
    prefillKey,
  ]);

  // مزامنة الفرع مرة واحدة عند توفّر هويّة المستخدم (إن لم يكن المستخدم قد بدّل الفرع يدوياً).
  const branchInitRef = useRef(false);
  useEffect(() => {
    if (
      !branchInitRef.current &&
      me.data?.branchId &&
      state.branchId !== me.data.branchId
    ) {
      dispatch({
        type: "SET_FIELD",
        field: "branchId",
        value: me.data.branchId,
      });
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
      dispatch({
        type: "SET_FIELD",
        field: "taxEnabled",
        value: taxSettingsQuery.data.enabledByDefault,
      });
      dispatch({
        type: "SET_FIELD",
        field: "taxRatePercent",
        value: taxSettingsQuery.data.defaultTaxRatePercent,
      });
      taxDefaultsAppliedRef.current = true;
    }
  }, [taxSettingsQuery.data]);

  /* ─── client-side idempotency token ────────────────────────────── */
  // معرّف العميل للطلب — جاهز للمستقبل (الراوتر الحالي لا يستهلكه؛ يُحفظ في memory للجلسة).
  const [clientRequestId] = useState(() => crypto.randomUUID());

  /* ─── landed cost (شحن/كمرك) ────────────────────────────────────── */
  // تُسجَّل مصروف نقل عند الاستلام ولا تُضاف إلى ذمّة المورّد أو تكلفة الصنف. تُوزَّع
  // على الأصناف بنسبة القيمة للعرض فقط؛ المعاينة هنا بـdecimal.js والخادم يعيد الحساب مرجعياً.
  const [shippingCost, setShippingCost] = useState("");
  const [customsCost, setCustomsCost] = useState("");
  // Keep the declaration in the invoice state so F12/RESET cannot carry a
  // previous cash payment claim into the next purchase.
  const shippingFundingSource = state.shippingFundingSource;
  function setShippingFundingSource(value: "ACCRUAL" | "DRAWER") {
    dispatch({ type: "SET_FIELD", field: "shippingFundingSource", value });
  }

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
      // PUR-UNIT-01 (٤/٩/٢٦): التوزيع يُنتج **أسعار وحدة الصفّ** (distributeToSubtotal يبني
      // على `price × qty` = إجماليّ السطر بوحدة الصفّ). `costBase` يبقى مرجعُ الأساس بلا كتابة.
      // قبله: كنّا نطمس `costBase` بسعرِ الدرزن (١٨٠٠) فيصير مرجعُ الأساس مسمَّماً كذباً.
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

  // اسم المورّد للطباعة: الحالة تحمل المعرّف وحده (`entityId`) بينما ورقةُ أمر الشراء تُسلَّم
  // باسمٍ لا برقم. المدخل وstaleTime مطابقان لما يستعمله `EntityPicker` بالضبط ⇒ نفس مفتاح
  // الكاش الذي ملأه المنتقي لحظة الاختيار، فلا طلبَ شبكةٍ إضافيّ بسبب الطباعة.
  const supplierRow = trpc.suppliers.get.useQuery(
    { supplierId: state.entityId ?? 0 },
    { enabled: state.entityId != null, staleTime: 60_000 },
  );

  // حارس فقدان البيانات (نمط CustomerNew/ExpenseNew): dirty عند إدخال فعليّ فقط (مورّد/بنود/شحن/كمرك/ملاحظات)
  // — شاشة فارغة حديثة الفتح لا تُحسب إدخالاً كي لا يظهر تحذير كاذب.
  const isDirty =
    state.entityId != null ||
    state.items.length > 0 ||
    state.notes.trim() !== "" ||
    Boolean(state.terms?.trim()) ||
    state.poReference.trim() !== "" ||
    state.supplierInvoiceTotal.trim() !== "" ||
    state.globalDiscount.trim() !== "" ||
    shippingCost.trim() !== "" ||
    customsCost.trim() !== "";
  useUnsavedGuard(isDirty);

  /* ─── مصادر سداد الفاتورة النقدية + الطفرات ─────────────────────── */
  const cashSourceState = usePurchaseCashSourceState({
    branchId: state.branchId,
    enabled: state.paymentTerms === "CASH" && state.currency === "IQD",
    context: "create",
    isCreator: true,
  });
  const [workflowPending, setWorkflowPending] = useState(false);

  const create = trpc.purchases.createOrder.useMutation({
    onSuccess: async () => {
      await invalidateFinancialQueries(queryClient, state.branchId);
      notify.ok("حُفظ أمر الشراء مسودة — راجعه ثم أرسله للاعتماد من قائمة المشتريات");
      bypassUnsavedGuard();
      navigate("/purchases");
    },
    onError: (e) => notify.err(e),
  });
  const createAsyncMut = trpc.purchases.createOrder.useMutation();
  const confirmAsyncMut = trpc.purchases.confirmOrder.useMutation();
  const decideAsyncMut = trpc.purchases.decideControl.useMutation();

  const createRequisition = trpc.purchases.createRequisition.useMutation({
    onSuccess: async () => {
      await utils.purchases.requisitions.invalidate();
      notify.ok("تم حفظ طلب التأمين بنجاح وإسناده لمدير المشتريات للبحث والتفاوض مع الموردين في السوق");
      bypassUnsavedGuard();
      navigate("/purchases?tab=requisitions");
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

  // landed-cost: الإجماليّ يشمل الشحن/الكمرك (يُوزَّعان بنسبة القيمة). الشحن خارجه (مصروف نقلٍ لا ذمّة مورّد).
  const landed = useMemo(
    () =>
      calcPurchaseLandedCost({
        shippingCost,
        customsCost,
        docSubtotal: docTotals.subtotal,
        docGrossSubtotal: docTotals.grossSubtotal,
        currency: state.currency,
        agreedRate: state.agreedRate,
        items: state.items,
        taxEnabled: state.taxEnabled,
        taxRatePercent: state.taxRatePercent,
      }),
    [
      shippingCost,
      customsCost,
      docTotals.subtotal,
      docTotals.grossSubtotal,
      state.items,
      state.currency,
      state.agreedRate,
      state.taxEnabled,
      state.taxRatePercent,
    ],
  );

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
    if (!state.entityId)
      return "اختر المورد قبل حفظ أمر الشراء المباشر، أو احفظ كطلب تأمين بدون مورد.";
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
        return `الكمية في «${l.name}» تنتج كسراً بالوحدة الأساس (${formatQuantity(l.qty)} × ${l.conversionFactor}).`;
    }
    if (state.currency === "USD" && !safeMoney(state.agreedRate).gt(0)) {
      return "أدخل سعر الصرف المثبت للفاتورة.";
    }
    if (state.currency === "USD" && state.paymentTerms === "CASH") {
      return "فاتورة المورد الدولارية تُسدَّد من مسار الصيرفة؛ اختر «آجل» ثم سجّل التسديد الفعلي بعد الاستلام.";
    }
    if (cashSourceState.validationError) {
      return cashSourceState.validationError;
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

  function buildPayload() {
    return {
      supplierId: state.entityId!,
      branchId: state.branchId,
      taxRatePercent: state.taxEnabled
        ? round2(D(state.taxRatePercent || "0")).toFixed(2)
        : "0",
      settlementType:
        state.paymentTerms === "CASH" ? ("CASH" as const) : ("CREDIT" as const),
      ...(cashSourceState.payload ? { cashSource: cashSourceState.payload } : {}),
      clientRequestId,
      revisionReason: "إنشاء مسودة أمر شراء من شاشة المشتريات",
      requisitionAllocations: requisition.data
        ? requisition.data.items.flatMap((requested) => {
            const availableBase =
              Number(requested.approvedBaseQuantity) -
              Number(requested.orderedBaseQuantity);
            const lineIndex = state.items.findIndex(
              (line) =>
                line.variantId === Number(requested.variantId) &&
                line.productUnitId === Number(requested.productUnitId),
            );
            if (availableBase <= 0 || lineIndex < 0) return [];
            const lineBase = toBase(
              state.items[lineIndex].qty,
              state.items[lineIndex].conversionFactor,
            ).toNumber();
            const allocatedBaseQuantity = Math.min(availableBase, lineBase);
            if (
              !Number.isInteger(allocatedBaseQuantity) ||
              allocatedBaseQuantity <= 0
            )
              return [];
            return [
              {
                lineNo: lineIndex + 1,
                requisitionItemId: Number(requested.id),
                allocatedBaseQuantity,
              },
            ];
          })
        : undefined,
      notes: composeDocumentNotes({
        notes: state.notes,
        terms: state.terms,
        poReference: state.poReference,
      }),
      // USD: أسعار البنود نفسها بالدولار، والخادم يحوّلها إلى التكلفة الدينارية بسعر التثبيت.
      agreedCurrency: state.currency,
      agreedRate:
        state.currency === "USD"
          ? safeMoney(state.agreedRate).toFixed(4)
          : undefined,
      invoiceDiscount: invoiceDiscountAmount.gt(0)
        ? invoiceDiscountAmount.toFixed(2)
        : undefined,
      supplierInvoiceTotal: state.supplierInvoiceTotal.trim()
        ? round2(safeMoney(state.supplierInvoiceTotal)).toFixed(2)
        : undefined,
      shippingCost: safeMoney(shippingCost).gt(0)
        ? round2(safeMoney(shippingCost)).toFixed(2)
        : undefined,
      customsCost: safeMoney(customsCost).gt(0)
        ? round2(safeMoney(customsCost)).toFixed(2)
        : undefined,
      shippingFundingSource: landed.hasLanded ? shippingFundingSource : "ACCRUAL",
      items: state.items.map((l) => ({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        quantity: D(l.qty).toString(),
        unitPrice: toUnitPriceStr(l.price, state.currency),
      })),
    };
  }

  function handleSaveRequisition() {
    if (!canLifecycleOperation(me.data, "purchases.createRequisition", true)) return notify.err("إنشاء طلب تأمين غير مفوض لهذا الحساب.");
    if (createRequisition.isPending || workflowPending) return;
    if (state.items.length === 0) {
      notify.warn("أضف منتجاً واحداً على الأقل لطلب التأمين.");
      return;
    }
    for (const l of state.items) {
      const qty = D(l.qty);
      if (!qty.gt(0)) {
        notify.warn(`الكمية في «${l.name}» يجب أن تكون موجبة.`);
        return;
      }
    }

    createRequisition.mutate({
      branchId: state.branchId,
      purpose:
        state.notes.trim() ||
        (isUnassignedMode
          ? "تأمين نواقص من السوق العراقي (مفتوح بدون مورد)"
          : "طلب تأمين بضاعة ونواقص — تفاوض مع الموردين"),
      priority: "NORMAL",
      clientRequestId,
      items: state.items.map((l) => {
        const baseQty = Math.max(
          1,
          Math.round(toBase(l.qty, l.conversionFactor).toNumber()),
        );
        return {
          variantId: l.variantId,
          productUnitId: l.productUnitId > 0 ? l.productUnitId : null,
          requestedBaseQuantity: baseQty,
          estimatedUnitPrice: toUnitPriceStr(l.price, state.currency),
          preferredSupplierId: null,
          justification: (l.note || "تأمين احتياج السوق وتفاوض الموردين")
            .trim()
            .padEnd(3, "."),
        };
      }),
    });
  }

  const isAnySaving =
    create.isPending || createRequisition.isPending || workflowPending;

  function handleSubmit() {
    if (!canLifecycleOperation(me.data, "purchases.createOrder", true)) return notify.err("إنشاء أمر شراء غير مفوض لهذا الحساب.");
    if (isAnySaving) return;
    if (!state.entityId) {
      handleSaveRequisition();
      return;
    }
    const err = validate();
    if (err) {
      notify.warn(err);
      return;
    }
    create.mutate(buildPayload());
  }

  const invalidatePurchaseWorkflowQueries = () =>
    Promise.all([
      invalidateFinancialQueries(queryClient, state.branchId),
      utils.purchases.list.invalidate(),
      utils.purchases.pendingControls.invalidate(),
    ]);

  async function handleSaveAndSubmitForApproval() {
    if (
      !canLifecycleOperation(me.data, "purchases.createOrder", true) ||
      !canLifecycleOperation(me.data, "purchases.confirmOrder", true)
    ) {
      notify.err("ارسال فاتورة الشراء للاعتماد غير مفوض لهذا الحساب.");
      return;
    }
    if (isAnySaving || !state.entityId) return;
    const err = validate();
    if (err) {
      notify.warn(err);
      return;
    }
    await runSubmitForApprovalWorkflow({
      isCash: state.paymentTerms === "CASH",
      clientRequestId,
      createOrder: () => createAsyncMut.mutateAsync(buildPayload()),
      confirmOrder: (input) => confirmAsyncMut.mutateAsync(input),
      invalidateAll: invalidatePurchaseWorkflowQueries,
      onSuccessToast: (msg) => notify.ok(msg),
      onErrorToast: (e) => notify.err(e),
      onNavigate: navigate,
      setPending: setWorkflowPending,
    });
  }

  async function handleSaveAndPostImmediately() {
    if (
      me.data?.isOwner !== true ||
      !canLifecycleOperation(me.data, "purchases.createOrder", true) ||
      !canLifecycleOperation(me.data, "purchases.confirmOrder", true) ||
      !canLifecycleOperation(me.data, "purchases.decideControl", true)
    ) {
      notify.err("الاعتماد والترحيل الفوري متاح لحساب المالك المفوض فقط.");
      return;
    }
    if (isAnySaving || !state.entityId) return;
    const err = validate();
    if (err) {
      notify.warn(err);
      return;
    }
    const isCash = state.paymentTerms === "CASH";
    const sourceLabel = cashSourceState.sourceSummaryLabel;
    const displayTotal =
      state.currency === "USD"
        ? `${fmtAr(docTotals.total)} $`
        : `${fmtAr(landed.grand.toFixed(2))} د.ع`;
    const ok = await confirm({
      variant: "info",
      title: isCash
        ? "حفظ وترحيل وسداد الفاتورة النقدية فورا"
        : "حفظ وترحيل الفاتورة الاجلة فورا",
      description: isCash
        ? `سيتم استلام البضاعة في المخزون وترحيل فاتورة المورد وسداد مبلغ ${displayTotal} نقدا من (${sourceLabel}) في معاملة واحدة، وتصبح ذمة الفاتورة صفرا (0.00). هل تؤكد استلام البضاعة كاملة؟`
        : `سيتم استلام البضاعة في المخزون وترحيل فاتورة المورد بقيمة ${displayTotal} كذمة اجلة على المورد في معاملة واحدة. هل تؤكد استلام البضاعة كاملة؟`,
      confirmText: isCash ? "تأكيد الاستلام والسداد النقدي" : "تأكيد الاستلام والترحيل",
      cancelText: "تراجع",
    });
    if (!ok) return;

    await runImmediatePostWorkflow({
      isCash,
      clientRequestId,
      cashSource: cashSourceState.payload,
      createOrder: () => createAsyncMut.mutateAsync(buildPayload()),
      confirmOrder: (input) => confirmAsyncMut.mutateAsync(input),
      decideOrder: (input) =>
        decideAsyncMut.mutateAsync({
          ...input,
          confirmedFullReceipt: true,
          cashSource: cashSourceState.payload,
        }),
      invalidateAll: invalidatePurchaseWorkflowQueries,
      onSuccessToast: (msg) => notify.ok(msg),
      onWarnToast: (msg) => notify.warn(msg),
      onErrorToast: (e) => notify.err(e),
      onNavigate: navigate,
      setPending: setWorkflowPending,
    });
  }

  /**
   * طباعة مسوّدة أمر الشراء بمستند A4 بهوية النظام بدل `window.print()` الخام (نظير PurchaseEdit).
   *
   * الخام كان يطبع الصفحة كما هي: شريط التنقّل والقوائم وحقول الإدخال وشريط الاختصارات مع
   * البنود، وبلا رسالةٍ حين يحجب المتصفّح النافذة المنبثقة. `printReportDoc` يوحّد الثلاثة.
   *
   * فرقُ هذه الشاشة عن توأمها أنّ المستند **مسوّدة لم تُحفَظ**:
   *   • لا رقمَ أمرٍ ولا حالةً محفوظة. والرقم الظاهر في الرأس مولَّدٌ محلياً بعشوائيّة
   *     (`generateInvoiceNumber` في المُخفِّض) ولا تُرسله الحمولة أصلاً — الخادم يُرقّم عند
   *     الحفظ ⇒ طباعتُه تضع على ورقةٍ تُسلَّم رقماً لا يطابق أيّ سجلّ. لذلك `docNum: null`
   *     والحالة تُصرّح بأنّها مسوّدة.
   *   • اسم المورّد يُقرأ من `suppliers.get` لأنّ الحالة تحمل معرّفَه وحده، وقد لا يكون مختاراً
   *     بعد (مسوّدة تُراجَع قبل إسنادها) ⇒ شرطة لا اسمٌ مُلفَّق.
   *
   * المحتوى هو المعروض نفسه: أعمدة `ProductTable` في وضع الشراء (باركود · منتج · وحدة · سعر
   * الشراء · الكمية · الإجمالي · المعادل د.ع للأمر الدولاريّ)، ثمّ لوحة المبالغ، ثمّ تنويه
   * بطاقة الشحن/الكمرك بنفس شرط ظهوره على الشاشة. وعمود «المخزون» مُقصىً عمداً: رصيدٌ لحظيّ
   * يشيخ فور الطباعة ولا يخصّ مستند المورّد — طباعتُه تُثبّت رقماً يُقرأ التزاماً وهو ليس كذلك.
   */
  function printOrder() {
    const branchName =
      (branches.data ?? []).find((b) => b.id === state.branchId)?.name ?? "—";
    printPurchaseOrderDoc({
      title: "أمر شراء (مسوّدة)",
      docNum: null,
      statusLabel: "مسوّدة لم تُحفَظ بعد",
      docDate: state.date,
      branchName,
      currency: state.currency,
      agreedRate: state.agreedRate,
      paymentTerms: state.paymentTerms,
      shippingCost,
      customsCost,
      notes: state.notes,
      terms: state.terms,
      poReference: state.poReference,
      supplierName: supplierRow.data?.name ?? "—",
      items: state.items,
      docTotals: {
        grossSubtotal: docTotals.grossSubtotal,
        subtotal: docTotals.subtotal,
        discount: docTotals.discount,
        tax: docTotals.tax,
        total: docTotals.total,
      },
      landed,
      showBranch: true,
      taxRatePercent: state.taxRatePercent,
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
        dispatch({ type: "CLEAR_ITEMS" });
        setPasteAvailable(true);
        notify.ok(
          "تم نسخ المنتجات وتفريغ الفاتورة. ستجد «لصق» في أي فاتورة تفتحها.",
        );
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
          'input[aria-label="بحث المنتجات"]',
        );
        input?.focus();
        return;
      }
      // F4 ⇒ حفظ المسودة؛ الإرسال للاعتماد إجراء مستقل من قائمة المشتريات.
      if (e.key === "F4") {
        e.preventDefault();
        if (!create.isPending) handleSubmit();
        return;
      }
      // F9 ⇒ طباعة مستند أمر الشراء (لا الصفحة كما هي).
      if (e.key === "F9") {
        e.preventDefault();
        printOrder();
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
    // ولنفس السبب يلزم بيانا المورّد والفروع: كلاهما يصل **بعد** تبدّل الحالة (طلب شبكة يتلوّ
    // اختيار المورّد)، فبدونهما تطبع F9 «—» في اسم مورّدٍ مختارٍ فعلاً — وهو صمتٌ يُقرأ إسناداً
    // ناقصاً على ورقةٍ تُسلَّم.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bulkOpen,
    create.isPending,
    state,
    shippingCost,
    customsCost,
    shippingFundingSource,
    supplierRow.data,
    branches.data,
  ]);

  /* ─── render ───────────────────────────────────────────────────── */
  const meta = INVOICE_TYPES[INVOICE_TYPE];

  return (
    // تدفّق طبيعيّ (لا حبس بارتفاع الإطار): كان `h-full` يضغط المحرّرَ داخل ٧٢٠px فيبقى للجدول
    // صفّان فقط وتُقتَطع بطاقةُ الشحن/الإجراءات أسفل الشريط الجانبي. الآن تنمو الصفحة بمحتواها
    // ويُمرِّرها `<main overflow-auto>` — فيَظهر الجدولُ كبيراً وكلُّ حقول الشريط الجانبي كاملةً.
    <div ref={containerRef} dir="rtl" className="flex flex-col gap-2">
      {/* رأس صفحة موحّد + الإجمالي الديناميكيّ كإجراء (بجانب الأزرار) */}
      <PageHeader
        title={`${meta.label} جديد`}
        icon={(() => {
          const MIcon = meta.icon;
          return <MIcon aria-hidden className="size-5 text-primary" />;
        })()}
        backHref="/purchases"
        backLabel="رجوع للمشتريات"
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

      {requisitionId ? (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
          {requisition.isLoading
            ? "يُحمّل طلب الشراء المصدر…"
            : requisition.error
              ? `تعذّر تحميل طلب الشراء المصدر: ${requisition.error.message}`
              : `هذا الأمر محوّل من طلب الشراء ${requisition.data?.requisitionNumber ?? `#${requisitionId}`}. راجع المورد والأسعار والكميات قبل الحفظ.`}
        </div>
      ) : null}

      {/* Header card (document metadata + supplier + terms + PO reference) */}
      <InvoiceHeader
        state={state}
        dispatch={dispatch}
        invoiceType={INVOICE_TYPE}
      />

      {/* Body: products on the right, totals/actions/terms on the left (RTL → aside on left).
          يتراصّ عمودياً على الشاشات الضيّقة ويصير صفّاً على الواسعة؛ الشريط الجانبي بارتفاعه
          الطبيعيّ (items-start) فلا تُقتَطع بطاقةُ الشحن/الكمرك ولا الإجراءات. */}
      <div className="flex flex-col gap-2.5 lg:flex-row lg:items-start">
        {/* عمود المنتجات: ارتفاع سخيّ ثابت كي يعرض الجدولُ المشتركُ (بتمريره الداخليّ) صفوفاً
            كثيرة بدل صفّين — بديلاً عن الحبس السابق بارتفاع الإطار. */}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 h-[62vh] min-h-[380px] print:h-auto print:min-h-fit">
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
            // Codex #980: عملة الأمر وسعرُ تثبيته يمرَّان لتقدير سعر وحدة الصفّ بالدولار عند الإضافة الجماعية.
            purchaseCurrency={state.currency}
            purchaseAgreedRate={state.agreedRate}
          />
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-1.5 lg:w-80">
          <PurchaseShippingCard
            shippingCost={shippingCost}
            onShippingCostChange={setShippingCost}
            customsCost={customsCost}
            onCustomsCostChange={setCustomsCost}
            shippingFundingSource={shippingFundingSource}
            onShippingFundingSourceChange={setShippingFundingSource}
            landed={landed}
            items={state.items}
            subtotal={totals.subtotal}
            currency={state.currency}
            showDetailedDistribution
          />

          <PurchaseSettlementPolicyCard
            idPrefix="purchase-new"
            context="create"
            paymentTerms={state.paymentTerms}
            currency={state.currency}
            cashSourceState={cashSourceState}
          />
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
          {/* مطابقة فاتورة المورّد: الإجماليّ المشتقّ يُقارَن بعملة الأمر — الدولاريّ بإجماليه
              الدولاريّ (مستند المورّد) والدينارّي بإجماليه الدينارّي، مطابقةً لحارس الخادم. */}
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
          {state.currency === "USD" && landed.rate.gt(0) && (
            <section className="rounded-lg border bg-card px-3 py-2 text-xs">
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
              {/* التكلفة بالدينار = فاتورة المورد × سعر التثبيت. الشحن/الكمرك **ليسا** ضمنها
                  (مصروفُ نقلٍ مستقلٌّ لحظة الاستلام، قرار المالك ٥/٨) — لذا لا نقول «مع الشحن». */}
              <div className="mt-1 flex justify-between border-t pt-1.5 font-bold">
                <span>التكلفة بالدينار</span>
                <span dir="ltr">{fmtAr(landed.grand.toFixed(2))} د.ع</span>
              </div>
            </section>
          )}
          {!state.entityId && state.items.length > 0 && (
            <section className="rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/20 p-2.5 flex flex-col gap-1.5">
              <div className="text-xs font-semibold text-foreground">
                مسودة بدون مورد محدد (سوق مفتوح):
              </div>
              <Button
                type="button"
                className="w-full bg-[var(--sem-warn)] hover:bg-[var(--sem-warn)]/90 text-background font-semibold text-xs h-8 shadow-sm gap-1.5"
                disabled={!canLifecycleOperation(me.data, "purchases.createRequisition", true) || isAnySaving}
                onClick={handleSaveRequisition}
              >
                <ClipboardList className="size-4" />
                حفظ كطلب تأمين (إسناد للمدير للتفاوض)
              </Button>
            </section>
          )}
          <div className="sticky bottom-0 z-10 bg-background/95 backdrop-blur pt-1.5 border-t space-y-1.5">
            {Boolean(state.entityId) &&
              state.items.length > 0 &&
              canLifecycleOperation(me.data, "purchases.createOrder", true) &&
              canLifecycleOperation(me.data, "purchases.confirmOrder", true) && (
                <Card>
                  <CardContent className="p-2.5 flex flex-col gap-1.5">
                    {me.data?.isOwner === true &&
                    canLifecycleOperation(me.data, "purchases.decideControl", true) ? (
                      <Button
                        type="button"
                        className="w-full font-semibold h-9 gap-1.5"
                        disabled={isAnySaving}
                        onClick={() => void handleSaveAndPostImmediately()}
                      >
                        <CheckCircle2 aria-hidden className="size-4" />
                        {workflowPending
                          ? ACTION_LABELS.saving
                          : state.paymentTerms === "CASH"
                            ? "حفظ وترحيل وسداد الفاتورة فورا"
                            : "حفظ وترحيل الفاتورة فورا"}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        className="w-full font-semibold h-9 gap-1.5"
                        disabled={isAnySaving}
                        onClick={() => void handleSaveAndSubmitForApproval()}
                      >
                        <Send aria-hidden className="size-4" />
                        {workflowPending
                          ? ACTION_LABELS.saving
                          : "حفظ وارسال الفاتورة للاعتماد"}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              )}
            <ActionButtons
              invoiceType={INVOICE_TYPE}
              items={state.items}
              onAction={handleAction}
              saving={isAnySaving}
              pasteAvailable={pasteAvailable}
              availableActions={canLifecycleOperation(me.data, "purchases.createOrder", true) ? NEW_ACTIONS : NEW_ACTIONS.filter((action) => action !== "save")}
              primaryLabel="حفظ المسودة"
            />
          </div>
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
