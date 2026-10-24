import { fmtAr } from "@/lib/money";
import { useSplitTender } from "@/components/payments/useSplitTender";
import { SplitTenderButton } from "@/components/payments/SplitTenderButton";
/**
 * SalesInvoiceNew — صفحة فاتورة بيع متقدّمة (شريحة SALE) بواجهة محرّر الفواتير الموحّدة.
 *
 * تكمل المجموعة الموجودة (PurchaseNew / QuotationNew / SalesReturnNew / PurchaseReturnNew)
 * بإضافة شاشة البيع المتقدّمة المفقودة — مستقلّة عن كاشير `/pos`، موجَّهة للفواتير الرسمية
 * (عملاء/شركات/دوائر، بيع نقدي أو آجل، خصومات سطرية وإجمالية).
 *
 * تعتمد على مكتبة `@/components/invoice` المشتركة مع `invoiceType="SALE"`:
 *   • العميل اختياري للبيع النقدي، وإلزامي عند وجود مبلغ آجل (ذمة).
 *   • الدفع يختفي عند اختيار «آجل (ذمة)» في الترويسة (TotalsPanel).
 *   • فئة السعر (مفرد/جملة/حكومي) تُحلّ خادمياً (override أو من العميل).
 *   • خصم سطري (% أو مبلغ) + خصم إجمالي (% أو مبلغ، يُحوَّل لمبلغ قبل الإرسال) مدعومان في `sales.create`.
 *   • idempotency عبر `clientRequestId` (الراوتر يعيد المحاولة على ER_DUP_ENTRY).
 *   • تجاوز حدّ الائتمان أو بيع بأقل من التكلفة ⇒ حوار موافقة مدير (بريد+كلمة مرور) ثم إعادة الإرسال مع managerApproval.
 *   • `showCost` يتبع الدور (مدير/أدمن = يرى التكلفة والهامش، كاشير = لا).
 *
 * الذرّية والأموال يتولاها الخادم (createSale ⇒ withTx + decimal.js). الواجهة هنا
 * لا تستخدم parseFloat/Number على الأموال (الجمع داخل calcTotals + decimal.js).
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateFinancialQueries } from "@/lib/realtime/financialQueries";
import { Link, useLocation, useRoute, useSearch } from "wouter";

import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { D, round2, toBase, fmt, formatQuantity, moneyInput } from "@/lib/money";
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { copyInvoiceItems, hasInvoiceTransfer, takeInvoiceItems,
} from "@/lib/invoiceTransfer";
import { useUnsavedGuard, bypassUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage,
} from "@shared/posPaymentPolicy";
import { PaymentReferenceField } from "@/components/pos/PaymentReferenceField";
import { getDeviceCode } from "@/lib/offline/outbox";
import {
  isCompleteNonNegativeMoneyInput,
  shouldSendUnitPriceOverride,
} from "@/lib/quotationPayload";
import { variantDisplayName } from "@shared/variantDisplay";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { releaseReservedPrintWindow, reservePrintWindow,
} from "@/lib/printing/brand";
import { DigitalCardsPickerDialog, type DigitalBasketCapture } from "@/components/pos/DigitalCardsPickerDialog";
import { DigitalFulfillmentDialog } from "@/components/pos/DigitalFulfillmentDialog";
import { captureDigitalInvoiceBasketItems, resolveDigitalInvoiceSettlement, toDigitalPrepareLine, toDigitalPrepareRegularLine, validateDigitalInvoiceCheckout } from "@/components/pos/digitalBasket";
import { AlertTriangle, Lock, CreditCard } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  InvoiceHeader,
  ProductTable,
  BulkPicker,
  TotalsPanel,
  ActionButtons,
  TermsAndNotes,
  composeDocumentNotes,
  splitDocumentNotes,
  ShortcutsBar,
  invoiceReducer,
  useInvoiceLiveStockSync,
  createInitialState,
  calcTotals,
  calcLineTotal,
  allocateLineTax,
  derivePaymentTerms,
  INVOICE_TYPES,
  type InvoiceActionKind,
  type InvoiceLine,
  type PaymentMethod,
  type PaymentTerm,
  type PriceTier,
} from "@/components/invoice";
import { createPricingIntentEpoch } from "@/components/invoice/productSearchResolution"; import { ACTION_LABELS } from "@shared/actionLabels";
import { SalesCorrectionPanel, resolvePriorReceipt, isPendingCodCorrection, correctionOutstandingBlockReason, type PriorReceiptMode } from "@/components/invoice/SalesCorrectionPanel";
import { salesRepresentativeOptions } from "@/components/invoice/salesRepresentatives";
import { salesOperationAllowed, salesCostVisible, salesCorrectionKinds, salesEditorActions, salesDigitalAllowed, salesExternalPaymentAllowed, salesEditorShortcuts } from "@/lib/salesOperationAccess";

const INVOICE_TYPE = "SALE" as const;

/** موافقة مدير لتجاوز حدّ الائتمان (بريد + كلمة مرور). */
type Approval = { email: string; password: string };

/** تنسيق تاريخ (بقيم UTC — التواريخ يومية مخزَّنة عند منتصف ليل UTC) إلى YYYY-MM-DD أو "". */
function toYmdUtc(v: unknown): string {
  const d = v instanceof Date ? v : v ? new Date(v as string) : null; if (!d || Number.isNaN(d.getTime())) return ""; return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; }

export default function SalesInvoice() {
  const [, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const defaultBranchId = me.data?.branchId ? Number(me.data.branchId) : 0;
  const employeesQ = trpc.employees.list.useQuery({ status: "active", limit: 200 }, { enabled: salesOperationAllowed(me.data, "employees.list", true) });
  const salesReps = useMemo(() => salesRepresentativeOptions(employeesQ.data?.rows ?? []), [employeesQ.data?.rows]);

  const [state, dispatch] = useReducer(
    invoiceReducer,
    undefined,
    () => createInitialState(INVOICE_TYPE, defaultBranchId),
  ); const pricingIntentEpochRef = useRef(createPricingIntentEpoch());

  // ── تصحيح الفاتورة (0168) — نفس شاشة البيع في وضع التصحيح (نمط المعيار: مسار + query + هيدرة مرّة) ──
  // كلّ ما يخصّ التصحيح محجوبٌ خلف isCorrection ⇒ تدفّق الإنشاء يبقى مطابقاً حرفاً بحرف حين لا تصحيح.
  const [corrMatch, corrParams] = useRoute("/invoices/:id/correct");
  const correctInvoiceId = corrMatch && corrParams?.id ? Number(corrParams.id) : null;
  const isCorrection = correctInvoiceId != null && correctInvoiceId > 0;
  const correctionFromReception = new URLSearchParams(useSearch()).get("from") === "reception-edit";
  const original = trpc.sales.get.useQuery({ invoiceId: correctInvoiceId ?? 0 }, { enabled: isCorrection && salesOperationAllowed(me.data, "sales.get", true) },
  );
  const correctionUnitIds = useMemo(
    () => Array.from(new Set((original.data?.items ?? []).map((item) => item.productUnitId ?? 0).filter((id) => id > 0),
        ),
      ),
    [original.data?.items],
  );
  const correctionCatalog = trpc.catalog.byUnitIds.useQuery(
    { branchId: original.data?.branchId ?? defaultBranchId, tier: (original.data?.priceTier ?? "RETAIL") as PriceTier, productUnitIds: correctionUnitIds,
    },
    { enabled: isCorrection && !!original.data && correctionUnitIds.length > 0 && salesOperationAllowed(me.data, "catalog.byUnitIds", true), staleTime: 15_000,
    },
  );
  const originalPaid = useMemo(() => D(original.data?.paidAmount ?? "0"), [original.data?.paidAmount],
  );
  const [reason, setReason] = useState("");
  const [correctionKind, setCorrectionKind] = useState<"REISSUE" | "EXCHANGE">("REISSUE");
  const allowedKinds = salesCorrectionKinds(me.data);
  const availableActions = salesEditorActions(me.data, isCorrection, correctionKind, state.items.some((line) => line.digital != null));
  const canUseDigital = salesDigitalAllowed(me.data);
  useEffect(() => { if (!allowedKinds.includes(correctionKind) && allowedKinds[0]) setCorrectionKind(allowedKinds[0]); }, [allowedKinds.join("|"), correctionKind]);
  const [overpayHandling, setOverpayHandling] = useState<"CREDIT" | "CASH_REFUND">("CASH_REFUND");
  const [collectNow, setCollectNow] = useState("");
  // التسوية تُستنتَج من كان/أصبح: الأصل نقديّ صار آجلاً ⇒ المقبوض لم يُستلم؛ والمفتاح يصحّح الاستنتاج.
  const [receiptMode, setReceiptMode] = useState<PriorReceiptMode>("AUTO");
  const originalTerms = useMemo(() => (original.data ? derivePaymentTerms(original.data) : "CASH"), [original.data]);
  const ownerExecutes = me.data?.isOwner === true;
  const pendingCodCorrection = isPendingCodCorrection(original.data);
  const priorReceipt = resolvePriorReceipt({ recordedPaid: originalPaid.toFixed(2), originalTerms, targetTerms: state.paymentTerms, mode: receiptMode });
  const receivedPrior = D(priorReceipt.amount ?? "0");
  const customerChanged = isCorrection && !!original.data && (original.data.customerId ?? null) !== (state.entityId ?? null);
  const correctionHydratedRef = useRef(false);
  // مُعرَّف هنا (لا لاحقاً) كي تتمكّن هيدرة التصحيح من تثبيته ⇒ لا تطمس تهيئةُ الضريبة الافتراضية ضريبةَ الأصل.
  const taxDefaultsAppliedRef = useRef(false);
  useEffect(() => {
    if (!isCorrection || correctionHydratedRef.current || !original.data) return;
    if (correctionUnitIds.length > 0 && !correctionCatalog.data) return;
    const d = original.data;
    const catalogByUnit = new Map((correctionCatalog.data ?? []).map((row) => [row.productUnitId, row]),
    );
    if (d.customerId) dispatch({ type: "SET_ENTITY", id: d.customerId });
    if (d.priceTier) dispatch({ type: "SET_FIELD", field: "tier", value: d.priceTier as PriceTier,
      });
    // شروط الدفع وطريقته من الأصل — لا تُترَك على افتراضيّ «نقدي». الشروط تُظهر حقل تاريخ
    // الاستحقاق للفاتورة الآجلة (كان يُرسَل مخفيّاً فلا يستطيع الموظّف تصحيحه)، والطريقة هي
    // التي يُقترَح بها قبض الفرق عند الاعتماد فلا تُفترَض نقداً على فاتورةٍ قُبِضت بالبطاقة.
    dispatch({ type: "SET_FIELD", field: "paymentTerms", value: derivePaymentTerms(d),
    });
    if (d.paymentMethod && isPosPaymentMethodEnabled(d.paymentMethod as PaymentMethod)) {
      dispatch({ type: "SET_FIELD", field: "paymentMethod", value: d.paymentMethod as PaymentMethod,
      });
    }
    // خصمٌ إجماليّ (كمبلغ صريح — الأصل يخزّنه مبلغاً لا نسبة).
    if (D(d.discountAmount ?? "0").gt(0)) {
      dispatch({ type: "SET_FIELD", field: "globalDiscountType", value: "amount",
      });
      dispatch({ type: "SET_FIELD", field: "globalDiscount", value: String(d.discountAmount),
      });
    }
    // ضريبةٌ على مستوى الفاتورة — نحمِلها من الأصل ونُثبّت الرايةَ كي لا تطمسها تهيئةُ الافتراضيات.
    if (D(d.taxRatePercent ?? "0").gt(0) || D(d.taxAmount ?? "0").gt(0)) {
      dispatch({ type: "SET_FIELD", field: "taxEnabled", value: true });
      dispatch({ type: "SET_FIELD", field: "taxRatePercent", value: String(d.taxRatePercent ?? "0"),
      });
    } else {
      dispatch({ type: "SET_FIELD", field: "taxEnabled", value: false });
    }
    taxDefaultsAppliedRef.current = true; // منع useEffect الافتراضيات من إعادة الكتابة فوق ضريبة الأصل.
    // أجرة التوصيل / التوصيل المجّانيّ (إفصاح) — تُحمَل كما الأصل.
    if (d.deliveryFree) {
      dispatch({ type: "SET_FIELD", field: "shippingFree", value: true });
      if (D(d.deliveryWaivedAmount ?? "0").gt(0))
        dispatch({ type: "SET_FIELD", field: "shipping", value: String(d.deliveryWaivedAmount),
        });
    } else if (D(d.deliveryFee ?? "0").gt(0)) {
      dispatch({ type: "SET_FIELD", field: "shipping", value: String(d.deliveryFee),
      });
    }
    if (d.notes) {
      const parsedNotes = splitDocumentNotes(d.notes);
      dispatch({ type: "SET_FIELD", field: "notes", value: parsedNotes.notes });
      if (parsedNotes.terms) dispatch({ type: "SET_FIELD", field: "terms", value: parsedNotes.terms });
    }
    const dueYmd = toYmdUtc(d.dueDate);
    if (dueYmd) dispatch({ type: "SET_FIELD", field: "dueDate", value: dueYmd });
    // نفس تحويل duplicateInvoice: بنود الفاتورة → InvoiceLine حرفياً (الكمية كاملةً — مصدر التصحيح).
    dispatch({
      type: "ADD_ITEMS",
      items: d.items.map((it): InvoiceLine => ({
        productId: it.productId ?? 0, variantId: it.variantId, productUnitId: it.productUnitId ?? 0,
        name: variantDisplayName({ ...it, productName: it.productName ?? "" }),
        variantName: it.variantName, color: it.color, size: it.size, colorHex: it.colorHex, variantKind: it.variantKind,
        sku: it.sku ?? "", barcode: null, unit: it.unitName ?? "",
        qty: D(it.quantity).toNumber(),
        conversionFactor: D(it.quantity).gt(0) ? D(it.baseQuantity).div(D(it.quantity)).toString() : "1",
        stockBase: catalogByUnit.get(it.productUnitId ?? 0)?.stockBase ?? 0,
        stockBranchId: catalogByUnit.get(it.productUnitId ?? 0)?.branchId,
        reservedBase: catalogByUnit.get(it.productUnitId ?? 0)?.reservedBase ?? 0,
        availableBase: catalogByUnit.get(it.productUnitId ?? 0)?.availableBase ?? 0,
        isService: catalogByUnit.get(it.productUnitId ?? 0)?.isService ?? false,
        price: it.unitPrice,
        costBase: catalogByUnit.get(it.productUnitId ?? 0)?.costPriceBase ?? "0",
        discount: D(it.discountAmount ?? 0).gt(0) ? String(it.discountAmount) : "0",
        discountType: "amount",
        note: "",
        ...(it.isGift ? { isGift: true as const } : {}),
      }),
      ),
    });
    correctionHydratedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCorrection, original.data, correctionCatalog.data, correctionUnitIds]);

  // بذرة «نسخ لفاتورة جديدة» (من قائمة الفواتير): sessionStorage تُقرأ مرة واحدة عند التركيب
  // ثم تُحذف فوراً (read-once) كي لا تُزرع مجدداً عند العودة للصفحة. الأسطر بشكل InvoiceLine حرفياً.
  useEffect(() => {
    // وضع التصحيح له مصدر حقيقة واحد هو الفاتورة المقفلة من الخادم. امسح أي بذرة نسخ
    // متبقية كي لا تُدمج ADD_ITEMS معها فتضاعف الكمية أو تطمس العميل/الشروط بصمت.
    if (isCorrection) {
      sessionStorage.removeItem("invoice-seed");
      return;
    }
    const raw = sessionStorage.getItem("invoice-seed");
    if (!raw) return;
    sessionStorage.removeItem("invoice-seed");
    try {
      const seed = JSON.parse(raw) as {
        customerId?: number | null;
        tier?: PriceTier;
        paymentTerms?: PaymentTerm;
        items?: InvoiceLine[];
      };
      if (seed.customerId) dispatch({ type: "SET_ENTITY", id: seed.customerId });
      if (seed.tier) dispatch({ type: "SET_FIELD", field: "tier", value: seed.tier });
      // شروط الدفع من الأصل: بدونها تبقى الشاشة على «نقدي» الافتراضيّ، فيصير نسخُ فاتورةٍ
      // آجلة بيعاً «مسدَّداً بالكامل نقداً» عند الحفظ (computePaidStr) — قبضٌ لم يقع.
      if (seed.paymentTerms) dispatch({ type: "SET_FIELD", field: "paymentTerms", value: seed.paymentTerms,
        });
      if (Array.isArray(seed.items) && seed.items.length) {
        dispatch({ type: "ADD_ITEMS", items: seed.items });
        dispatch({ type: "MARK_STOCK_STALE" });
      }
      notify.info("تم نسخ الفاتورة — راجِع الأسعار فهي منسوخة من الفاتورة الأصلية وقد تختلف عن الأسعار الحالية.",
      );
    } catch {
      /* بذرة معطوبة — تجاهل */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCorrection]);

  // مزامنة فرع المستخدم مرة واحدة (إن وصل لاحقاً)؛ لا نطمس اختياره اليدوي بعدها.
  const syncedBranch = useRef(false);
  useEffect(() => {
    if (!syncedBranch.current && me.data?.branchId && state.branchId !== me.data.branchId) {
      dispatch({ type: "SET_FIELD", field: "branchId", value: me.data.branchId,
      });
      syncedBranch.current = true;
    } else if (me.data) {
      syncedBranch.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data?.branchId]);

  // لقطة السطر المخزنية ليست مصدراً للحقيقة: النسخ/اللصق/تغيير الفرع ومسودة قديمة كلها قد تحمل
  // رقماً قديماً. نعيد قراءة الوحدات الموجودة فقط من الفرع الذي طبّقه الخادم، دورياً وعند التركيز.
  useInvoiceLiveStockSync({
    items: state.items,
    branchId: state.branchId,
    enabled: salesOperationAllowed(me.data, "catalog.stockByUnitIds", true),
    dispatch,
  });

  // تهيئة تفعيل/نسبة الضريبة من إعدادات النظام (مرّة واحدة فقط، فاتورة جديدة) — يبقى المستخدم
  // حرّاً بتبديلها يدوياً بعدها (لا نُعيد التهيئة عند كل جلب/إعادة رسم). المرجع مُعرَّف أعلاه.
  const taxSettingsQuery = trpc.system.getTaxSettings.useQuery();
  // «وضع الافتتاح» (ش٥ + توسعة ١٠/٨): هذه الشاشة تمرّ بقناة POS نفسها ⇒ يستفيد من السالب المشروط
  // بيعُها المسدَّد كاملاً نقداً/بطاقةً **وكذلك الآجل لعميلٍ محدَّد** (يُسجَّل ذمّةً) — لافتة توضيحية.
  const openingModeQuery = trpc.system.getOpeningMode.useQuery(undefined, { staleTime: 60_000,
  });
  useEffect(() => {
    if (!taxDefaultsAppliedRef.current && taxSettingsQuery.data) {
      dispatch({ type: "SET_FIELD", field: "taxEnabled", value: taxSettingsQuery.data.enabledByDefault,
      });
      dispatch({ type: "SET_FIELD", field: "taxRatePercent", value: taxSettingsQuery.data.defaultTaxRatePercent,
      });
      taxDefaultsAppliedRef.current = true;
    }
  }, [taxSettingsQuery.data]);

  // وردية مفتوحة للفرع (إن وُجدت) ⇒ تُسجَّل الدفعة النقدية في صندوق الوردية.
  const currentShift = trpc.shifts.current.useQuery(
    { branchId: state.branchId },
    // التصحيح لا يكتب مالاً قبل الاعتماد؛ درج التنفيذ يختاره المراجع في شاشة الاعتماد.
    { enabled: !!state.branchId && !isCorrection && salesOperationAllowed(me.data, "shifts.current", true) },
  );

  // idempotency: مفتاح ثابت لكل محاولة إنشاء (يُجدَّد بعد كل حفظ ناجح / RESET).
  const [clientRequestId, setClientRequestId] = useState<string>(() => crypto.randomUUID(),
  );
  const printAfterSaveRef = useRef(false);
  const shareAfterSaveRef = useRef(false);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [cardsOpen, setCardsOpen] = useState(false);
  const [pasteAvailable, setPasteAvailable] = useState(hasInvoiceTransfer);

  // حوار موافقة المدير (يُفتح عند خطأ تجاوز حدّ الائتمان).
  const [creditPrompt, setCreditPrompt] = useState<string | null>(null);
  const [mgrEmail, setMgrEmail] = useState("");
  const [mgrPwd, setMgrPwd] = useState("");

  // RBAC: المدير/الأدمن يرى التكلفة والهامش؛ الكاشير لا.
  const showCost = salesCostVisible(me.data);

  const totals = useMemo(() => calcTotals(state.items, state), [state]);
  /**
   * حصص ضريبة الفاتورة الموزَّعة تناسبياً على السطور (عرض فقط، سنت حصريّ = totals.totalTax
   * بالضبط بفضل خوارزمية «آخر سطر يمتصّ التقريب»). تُمرَّر إلى `ProductTable` كعمود «حصة
   * الضريبة» وإلى `printInvoiceA4` كحقل `taxAmount` لكل بند — نفس القيم في الشاشة والطباعة.
   */
  const taxShares = useMemo(
    () =>
      state.taxEnabled
        ? allocateLineTax(
            state.items.map((item) => ({ total: calcLineTotal(item) })),
            totals.totalTax,
            totals.afterDiscount,
          )
        : null,
    [state.taxEnabled, state.items, totals.totalTax, totals.afterDiscount],
  );

  /* ─── إثبات الدفع غير النقديّ ────────────────────────────────────
   * نفس بوّابة الكاشير حرفاً بحرف: محاولةٌ خادمية INITIATED ⇒ CONFIRMED تُستهلَك مرّةً
   * واحدة مع الفاتورة. هذه الشاشة بيعٌ على الكاونتر كالكاشير، فلا يجوز أن يكون معيار
   * إثباتها أضعف. ومسار التصحيح يستهلك المحاولة نفسها بقناة SALES_COLLECTION.
   */
  const [paymentRef, setPaymentRef] = useState("");
  const [externalAttempt, setExternalAttempt] = useState<
    {
      attemptId: number | null;
      requestId: string;
      deviceId: string;
      fingerprint: string;
      confirmed: boolean;
    } | null
  >(null);
  /** إثبات الدفع الخارجي هنا للبيع الجديد فقط؛ فرق التصحيح يُنفّذه المراجع عند الاعتماد. */
  const hasDigitalItems = state.items.some((line) => line.digital != null);
  const splitTender = useSplitTender({ branchId: state.branchId, ownerId: me.data?.id, sessionKey: `${isCorrection ? `correction-${correctInvoiceId}` : "new"}:${clientRequestId}`, channel: "POS", canConfirm: salesExternalPaymentAllowed(me.data, false) && salesExternalPaymentAllowed(me.data, true), disabled: isCorrection || hasDigitalItems });
  const externalAmountD = D(computePaidStr()); const externalAmount = round2(externalAmountD).toFixed(2);
  // لا نبدأ قبضاً خارجياً لفاتورة رقمية قبل وجود نيّة وحجز ذريين؛ الخادم يفرض
  // السياسة نفسها. الفواتير العادية غير النقدية تبقى على مسار الإثبات الحالي.
  const externalNeeded = !splitTender.active && !isCorrection && !hasDigitalItems && state.paymentMethod !== "CASH" && externalAmountD.gt(0);
  const externalChannel = "POS" as const;
  const externalFingerprint = `${externalChannel}|${state.branchId}|${state.paymentMethod}|${externalAmount}|${paymentRef.trim()}`;
  const externalConfirmed =
    !externalNeeded || (externalAttempt?.confirmed === true && externalAttempt.fingerprint === externalFingerprint);
  const canConfirmExternal = salesExternalPaymentAllowed(me.data, externalAttempt?.attemptId != null && externalAttempt.fingerprint === externalFingerprint);

  const initiateExternal = trpc.sales.initiateExternalPayment.useMutation();
  const confirmExternal = trpc.sales.confirmExternalPayment.useMutation();

  async function confirmExternalPayment() {
    if (!canConfirmExternal) return notify.warn("تأكيد الدفع الخارجي غير مفوّض لحسابك.");
    if (hasDigitalItems) return notify.err("الدفع بالبطاقة لفاتورة تحتوي كروتاً رقمية موقوف مؤقتاً؛ لم يبدأ النظام أي عملية قبض خارجية.");
    const reference = paymentRef.trim();
    if (!reference) return notify.err("أدخل مرجع العملية أولاً.");
    if (!externalAmountD.gt(0)) return notify.err("أدخل مبلغ الدفعة قبل تأكيد العملية الخارجية.");
    // فرع **الفاتورة** لا فرع المستخدم: المحاولة والفاتورة يجب أن يتّفقا وإلا رُفض الاستهلاك.
    const branchId = state.branchId;
    if (!branchId) return notify.err("حدّد فرع الفاتورة قبل تأكيد الدفع الخارجي.");
    try {
      // إعادة استعمال المحاولة السابقة مشروطةٌ ببقاء بصمتها؛ وإلا فمعرّف طلبٍ جديد —
      // فالمفتاح نفسه ببياناتٍ مختلفة يُردّ بتعارضٍ حتميّ.
      const prior = externalAttempt?.fingerprint === externalFingerprint ? externalAttempt : null;
      const deviceId = prior?.deviceId ?? (await getDeviceCode());
      const requestId = prior?.requestId ?? crypto.randomUUID();
      let attemptId = prior?.attemptId ?? null;
      if (attemptId == null) {
        const initiated = await initiateExternal.mutateAsync({
          branchId: Number(branchId),
          method: state.paymentMethod as "CARD" | "TRANSFER" | "WALLET",
          amount: externalAmount,
          reference,
          requestId,
          deviceId,
          channel: externalChannel,
        });
        attemptId = initiated.attemptId;
        // تُحفَظ **قبل** التأكيد: لو سقط التأكيد، تُعاد المحاولة نفسها بدل توليد مفتاحٍ
        // جديد لمرجعٍ عالميّ الفرادة (فيُرفض تكراراً ويُحبَس القبض).
        setExternalAttempt({ attemptId, requestId, deviceId, fingerprint: externalFingerprint, confirmed: false,
        });
      }
      await confirmExternal.mutateAsync({ branchId: Number(branchId), attemptId, deviceId, channel: externalChannel });
      setExternalAttempt({ attemptId, requestId, deviceId, fingerprint: externalFingerprint, confirmed: true });
      notify.ok("تأكّد الدفع الخارجي", `ثُبّت المرجع ${reference} وأصبح جاهزاً للاستهلاك مرّةً واحدة.`);
    } catch (error) {
      notify.err(error instanceof Error ? error.message : "تعذّر تثبيت تأكيد الدفع الخارجي");
    }
  }

  /* ─── Digital Fulfillment ─────────────────────────────────────── */
  const [digitalIntentId, setDigitalIntentId] = useState<number | null>(null);
  const [digitalFinalizeError, setDigitalFinalizeError] = useState<string | null>(null);
  
  const prepareIntent = trpc.digitalCards.sales.prepare.useMutation({
    onSuccess: (res) => {
      setDigitalIntentId(res.intentId); setCreditPrompt(null); setMgrEmail(""); setMgrPwd("");
    },
    onError: (e) => {
      if (e.message && (e.message.includes("حدّ الائتمان") || e.message.includes("بأقل من التكلفة") || e.message.includes("موافقة مدير") || e.message.includes("اعتماد مدير"))) {
        setCreditPrompt(e.message); return;
      }
      releaseReservedPrintWindow(); printAfterSaveRef.current = false; shareAfterSaveRef.current = false; notify.err(e);
    },
  });

  const finalizeSale = trpc.digitalCards.sales.finalize.useMutation({
    onSuccess: (r) => {
      utils.sales.list.invalidate();
      const id = (r as { invoiceId: number }).invoiceId;
      notify.ok("تم حفظ فاتورة البيع والكروت الرقمية واعتمادها");
      setDigitalIntentId(null);
      setDigitalFinalizeError(null);
      setClientRequestId(crypto.randomUUID()); setCreditPrompt(null); setMgrEmail(""); setMgrPwd("");
      const printAfterSave = printAfterSaveRef.current; const shareAfterSave = shareAfterSaveRef.current;
      printAfterSaveRef.current = false; shareAfterSaveRef.current = false;
      bypassUnsavedGuard();
      navigate(`/invoices/${id}${printAfterSave ? "?print=1" : shareAfterSave ? "?share=1" : ""}`);
    },
    onError: (e) => setDigitalFinalizeError(e.message),
  });

  /* ─── mutation ─────────────────────────────────────────────────── */
  const create = trpc.sales.create.useMutation({
    onSuccess: (r) => {
      utils.sales.list.invalidate();
      const id = (r as { invoiceId: number }).invoiceId;
      splitTender.reset(true);
      notify.ok("تم حفظ فاتورة البيع واعتمادها");
      // أعِد توليد المفتاح للفاتورة التالية + أغلق حوار الموافقة إن كان مفتوحاً.
      setClientRequestId(crypto.randomUUID()); setCreditPrompt(null); setMgrEmail(""); setMgrPwd("");
      const printAfterSave = printAfterSaveRef.current; const shareAfterSave = shareAfterSaveRef.current;
      printAfterSaveRef.current = false; shareAfterSaveRef.current = false;
      bypassUnsavedGuard();
      navigate(`/invoices/${id}${printAfterSave ? "?print=1" : shareAfterSave ? "?share=1" : ""}`);
    },
    onError: (e) => {
      // تجاوز حدّ الائتمان أو بيع بأقل من التكلفة ⇒ افتح حوار موافقة المدير بدل إظهار خطأ فقط.
      // نطابق العبارتين المميِّزتين الكاملتين «حدّ الائتمان» و«بأقل من التكلفة» (لا «الائتمان»
      // وحدها) لتفادي الإيجابيات الكاذبة من رسائل أعمال أخرى تذكر «سقف الائتمان» مثلاً.
      // نفس الحوار يحلّ الخطأين: الخادم يشتقّ من managerApproval المتحقَّق منه سلطتَي
      // creditApproved وpriceOverrideApproved معاً (saleRouter.create).
      // H6 (٢٧/٧): بوّابة الخصم اليدويّ فوق التكلفة ترمي «...يتطلب موافقة مدير» ⇒ نضيف العبارة الجامعة.
      if (e.message && (e.message.includes("حدّ الائتمان") || e.message.includes("بأقل من التكلفة") || e.message.includes("موافقة مدير"))) {
        setCreditPrompt(e.message);
        return;
      }
      releaseReservedPrintWindow();
      printAfterSaveRef.current = false;
      shareAfterSaveRef.current = false;
      notify.err(e);
    },
  });

  // إعادة الإصدار تبدأ بطلب صفر الأثر؛ مراجعٌ مستقل ينفّذ العكس+الإصدار ذرّياً من طابور التحكم.
  // المالك النشط استثناء: الخادم ينفّذ طلبه فوراً (status=APPROVED) ⇒ ننتقل للفاتورة البديلة.
  async function finishOwnerCorrection(resultInvoiceId: number | null | undefined): Promise<boolean> {
    if (resultInvoiceId == null || !(Number(resultInvoiceId) > 0)) return false;
    await invalidateFinancialQueries(queryClient, original.data?.branchId);
    notify.ok("نُفّذ التصحيح", "عُكس الأصل وصدرت الفاتورة البديلة وسوّيت الأموال في معاملة واحدة.");
    setCreditPrompt(null); setMgrEmail(""); setMgrPwd("");
    bypassUnsavedGuard();
    navigate(`/invoices/${Number(resultInvoiceId)}`);
    return true;
  }
  const reissue = trpc.sales.reissue.useMutation({
    onSuccess: async (r) => {
      if (r.status === "APPROVED" && await finishOwnerCorrection(r.resultInvoiceId)) return;
      utils.salesControl.list.invalidate();
      notify.ok(
        "أُرسل طلب إعادة الإصدار",
        `الطلب #${r.requestId} بانتظار مراجع مستقل — لم تتغيّر الفاتورة أو المخزون أو المال بعد.`,
      );
      setCreditPrompt(null); setMgrEmail(""); setMgrPwd("");
      bypassUnsavedGuard();
      navigate(correctionFromReception ? "/reception/workflow?section=edit" : `/invoices/${correctInvoiceId}`);
    },
    onError: handleCorrectionError,
  });
  const exchange = trpc.salesControl.requestExchange.useMutation({
    onSuccess: async (result) => {
      if (result.status === "APPROVED" && await finishOwnerCorrection("resultInvoiceId" in result ? (result.resultInvoiceId as number | null) : null)) return;
      utils.salesControl.list.invalidate();
      notify.ok(
        "أُرسل طلب الاستبدال",
        `الطلب #${result.id} بانتظار مراجع مستقل — العكس والبديل وتسوية الفرق ستنفّذ ذرّياً عند الاعتماد.`,
      );
      setCreditPrompt(null); setMgrEmail(""); setMgrPwd("");
      bypassUnsavedGuard();
      navigate(correctionFromReception ? "/reception/workflow?section=edit" : `/invoices/${correctInvoiceId}`);
    },
    onError: handleCorrectionError,
  });

  function handleCorrectionError(error: { message?: string }) {
    if (error.message && (error.message.includes("حدّ الائتمان") || error.message.includes("بأقل من التكلفة") || error.message.includes("موافقة مدير"))) {
      setCreditPrompt(error.message);
      return;
    }
    notify.err(error);
  }

  /**
   * المبلغ المدفوع نقداً وفق شروط الدفع:
   *  • نقداً (CASH): القيمة المُدخَلة، أو الإجمالي الكامل إن تُركت فارغة.
   *  • آجل (CREDIT): صفر — كامل المبلغ يُسجَّل ذمة.
   *  • أقساط (INSTALLMENT): الدفعة المقدّمة المُدخَلة فقط، وصفر إن تُركت فارغة (الباقي ذمة) —
   *    لا يُفترَض الدفع الكامل ضمناً (الخادم لا يدعم جدول أقساط؛ نعامله كآجل بدفعة مقدّمة اختيارية).
   */
  function computePaidStr(): string {
    if (splitTender.active) return splitTender.tendered;
    if (state.paymentTerms === "CREDIT") return "0";
    const entered = state.paidAmount.trim();
    if (entered) return round2(moneyInput(entered)).toFixed(2);
    return state.paymentTerms === "INSTALLMENT" ? "0" : totals.grandTotal;
  }

  /** يبني payload البيع بأموال نصّية (decimal.js) — لا parseFloat. */
  function buildPayload(approval?: Approval) {
    const paidStr = computePaidStr();
    // إيصال دفع يُرسَل فقط إن كان هناك مبلغ مدفوع فعلاً (>0)؛ غير ذلك = ذمة كاملة.
    const hasPayment = D(paidStr).gt(0);

    return {
      branchId: state.branchId,
      salesRepId: state.salesRepId ? Number(state.salesRepId) : undefined,
      shiftId: currentShift.data?.id ?? undefined,
      customerId: state.entityId ?? undefined,
      priceTier: state.tier,
      lines: state.items.map((l) => ({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        quantity: moneyInput(l.qty).toString(),
        ...(l.digital ? { internalLineToken: l.digital.lineKey } : {}),
        // الهدية: نُعلن النيّة فقط ولا نُرسل سعراً/خصماً — الخادم يُصفّرهما بنفسه ويُرحّل التكلفة
        // قيدَ GIFT_OUT. إرسال سعرٍ هنا يفتح باب «هديةٍ بسعر» لو انحرفت الشاشة يوماً.
        ...(l.isGift
          ? { isGift: true as const }
          : {
              ...(shouldSendUnitPriceOverride(l) ? { unitPriceOverride: round2(moneyInput(l.price)).toFixed(2) } : {}),
              discountPercent: l.discountType === "percent" ? round2(moneyInput(l.discount || "0")).toFixed(2) : undefined,
              discountAmount: l.discountType === "amount" ? round2(moneyInput(l.discount || "0")).toFixed(2) : undefined,
            }),
      })),
      // أجرة التوصيل (0152) — ثلاث حالات صريحة لا اثنتان:
      //   مدفوع  ⇒ deliveryFee > 0 (إيرادُ شحنٍ يدخل الإجمالي)
      //   مجّانيّ ⇒ deliveryFree=true + القيمة المُتنازَل عنها (بلا إيراد ولا إجمالي)
      //   بلا توصيل ⇒ لا شيء يُرسَل إطلاقاً
      ...(state.shippingFree
        ? {
            deliveryFree: true as const,
            ...(moneyInput(state.shipping).gt(0)
              ? { deliveryWaivedAmount: round2(moneyInput(state.shipping)).toFixed(2) }
              : {}),
          }
        : D(totals.shipping).gt(0)
          ? { deliveryFee: totals.shipping }
          : {}),
      // خصم إجمالي كمبلغ (calcTotals يحوّل النسبة إلى مبلغ). يُرسَل فقط إن كان موجباً.
      invoiceDiscount: D(totals.globalDiscAmt).gt(0) ? totals.globalDiscAmt : undefined,
      // العراق VAT=0% افتراضياً — الضريبة اختيارية على مستوى الفاتورة، تُطبَّق فقط عند تفعيلها
      // صراحةً من «تطبيق ضريبة» في ملخّص المبالغ (لعملاء/دوائر تتطلّب فاتورة ضريبية).
      taxRatePercent: state.taxEnabled ? round2(moneyInput(state.taxRatePercent)).toFixed(2) : "0",
      payments: splitTender.active ? splitTender.parts.map(part => ({ amount: part.amount, method: part.method, ...(part.method !== "CASH" ? { externalPaymentAttemptId: part.proof?.attemptId ?? undefined } : {}) })) : undefined,
      payment: !splitTender.active && hasPayment
        ? {
            amount: paidStr,
            method: state.paymentMethod,
            ...(state.paymentMethod === "CASH"
              ? {}
              : { externalPaymentAttemptId: externalAttempt?.attemptId ?? undefined }),
          }
        : undefined,
      ...(splitTender.active ? { deviceId: splitTender.parts.find(part => part.method !== "CASH")?.proof?.deviceId } : {}),
      // يجب أن يطابق جهاز المحاولة المؤكَّدة، وإلا رُفض استهلاكها.
      ...(!splitTender.active && hasPayment && state.paymentMethod !== "CASH" && externalAttempt?.deviceId
        ? { deviceId: externalAttempt.deviceId }
        : {}),
      // تاريخ الاستحقاق للبيع الآجل/الأقساط فقط (يُحفظ على invoices.dueDate ⇒ أعمار الذمم
      // تُعمِّر من موعد الاستحقاق لا تاريخ الفاتورة). الحقل يظهر في الترويسة لهذين النوعين فقط.
      dueDate:
        (state.paymentTerms === "CREDIT" || state.paymentTerms === "INSTALLMENT") && state.dueDate
          ? state.dueDate
          : undefined,
      clientRequestId,
      notes: composeDocumentNotes({ notes: state.notes, terms: state.terms }),
      ...(approval ? { managerApproval: approval } : {}),
    };
  }

  /** حمولة طلب التصحيح: مبلغ/طريقة الفرق اقتراح؛ الدرج وإثبات المزوّد يحددهما المراجع. */
  function buildCorrectionPayload(approval?: Approval) {
    const base = buildPayload(approval);
    const diff = D(totals.grandTotal).minus(receivedPrior); // موجب=نقص يُحصَّل، سالب=فائض يُردّ/يُرصَّد
    if (diff.gt(0) && !isCompleteNonNegativeMoneyInput(collectNow, { allowEmpty: true })) {
      throw new Error("INVALID_CORRECTION_COLLECTION_AMOUNT");
    }
    const collect = diff.gt(0) ? moneyInput(collectNow) : D(0);
    // أجرة التوصيل وإفصاح التنازل يُحمَلان كما في عقد الإنشاء؛ المجاني لا يدخل الإجمالي.
    const deliveryFee =
      !state.shippingFree && D(totals.shipping).gt(0) ? totals.shipping : null;
    return {
      originalInvoiceId: correctInvoiceId!,
      customerId: base.customerId ?? null,
      salesRepId: base.salesRepId,
      contactName: original.data?.contactName ?? null,
      contactPhone: original.data?.contactPhone ?? null,
      priceTier: base.priceTier,
      lines: base.lines,
      invoiceDiscount: base.invoiceDiscount ?? null,
      deliveryFee,
      deliveryFree: state.shippingFree,
      deliveryWaivedAmount: state.shippingFree && moneyInput(state.shipping).gt(0)
        ? round2(moneyInput(state.shipping)).toFixed(2)
        : null,
      taxRatePercent: base.taxRatePercent,
      dueDate: state.dueDate || null,
      notes: base.notes ?? null,
      reason: reason.trim(),
      clientRequestId,
      // المستلَم فعلاً من المقبوض المسجَّل (مستنتَج من كان/أصبح) — الخادم يعكس الباقي ويحمل المستلَم.
      ...(priorReceipt.amount != null ? { priorPaymentReceivedAmount: priorReceipt.amount } : {}),
      ...(diff.gt(0) && collect.gt(0)
        ? {
            additionalPayment: {
              amount: round2(collect).toFixed(2),
              method: state.paymentMethod,
            },
          }
        : {}),
      ...(diff.lt(0)
        ? {
            overpayHandling,
          }
        : {}),
      ...(approval ? { managerApproval: approval } : {}),
    };
  }

  /** تحقّق التصحيح — رسالة عربية أو null. */
  function validateCorrection(): string | null {
    if (reason.trim().length < 3) return "اكتب سبب التصحيح (٣ أحرف على الأقل).";
    const diff = D(totals.grandTotal).minus(receivedPrior);
    if (diff.gt(0)) {
      if (!isCompleteNonNegativeMoneyInput(collectNow, { allowEmpty: true })) {
        return "مبلغ القبض مع التعديل غير صالح.";
      }
      const collect = moneyInput(collectNow);
      if (collect.gt(diff)) return `التحصيل المقترح (${collect.toFixed(2)}) يتجاوز الفرق المستحقّ (${diff.toFixed(2)}).`;
      const outstandingError = correctionOutstandingBlockReason(diff.minus(collect).toFixed(2), state.entityId != null, pendingCodCorrection);
      if (outstandingError) return outstandingError;
    }
    if (diff.lt(0) && overpayHandling === "CREDIT" && !state.entityId) return "الرصيد الدائن يتطلّب عميلاً — اختر عميلاً أو اختر استرداداً نقدياً.";
    return null;
  }

  /** تحقّق أعمالي قبل الإرسال. يُرجع رسالة عربية أو null إن صالح. */
  function validate(): string | null {
    if (!availableActions.includes("save")) return "حفظ هذه العملية غير مفوّض لحسابك.";
    if (splitTender.active) {
      if (isCorrection || hasDigitalItems || state.paymentTerms === "CREDIT") return "تقسيم الدفع متاح لفاتورة بيع جديدة غير رقمية؛ الآجل الكامل لا يتضمن قبضاً الآن.";
      const problem = splitTender.problem(totals.grandTotal); if (problem) return problem;
    }
    if (hasDigitalItems && !canUseDigital) return "دورة بيع الكروت الرقمية غير مفوّضة بالكامل لحسابك.";
    if (!isPosPaymentMethodEnabled(state.paymentMethod)) return posPaymentRejectionMessage(state.paymentMethod);
    if (!state.branchId) return "اختر الفرع.";
    if (state.items.length === 0) return "أضف منتجاً واحداً على الأقل.";
    if (!isCompleteNonNegativeMoneyInput(state.globalDiscount, { allowEmpty: true }))
      return "الخصم الإجمالي غير صالح.";
    if (!isCompleteNonNegativeMoneyInput(state.shipping, { allowEmpty: true }))
      return "أجرة التوصيل غير صالحة.";
    if (!splitTender.active && !isCompleteNonNegativeMoneyInput(state.paidAmount, { allowEmpty: true }))
      return "المبلغ المدفوع غير صالح.";
    const digitalError = validateDigitalInvoiceCheckout(state.items, {
      isCorrection, hasOpenShift: !!currentShift.data,
      paymentTerms: state.paymentTerms, paymentMethod: state.paymentMethod,
      paidTotal: computePaidStr(), grandTotal: totals.grandTotal,
      globalDiscount: totals.globalDiscAmt, shippingFree: state.shippingFree,
      shipping: totals.shipping, taxEnabled: state.taxEnabled, totalTax: totals.totalTax,
    });
    if (digitalError) return digitalError;
    // قرار المالك (٦/٨/٢٦): «مجاني» يلزمه مقدار الأجرة — يُطبَع للزبون ويُحصى في التقارير.
    // الخادم يمنعه أيضاً؛ هذا الحارس ليوفّر على الموظّف رحلةَ ذهابٍ وإياب.
    if (state.shippingFree && !moneyInput(state.shipping).gt(0)) {
      return "أدخِل قيمة أجرة التوصيل قبل جعله مجّانياً — تُطبَع للزبون وتُحصى في التقارير.";
    }
    for (const l of state.items) {
      if (!moneyInput(l.qty).gt(0)) return `الكمية في «${l.name}» يجب أن تكون موجبة.`;
      if (l.digital && !moneyInput(l.qty).eq(1)) return `كل كرت رقمي في «${l.name}» يجب أن يبقى سطراً مستقلاً بكمية واحدة.`;
      if (!l.isGift) {
        if (!isCompleteNonNegativeMoneyInput(l.price, { allowEmpty: false }))
          return `السعر في «${l.name}» غير صالح.`;
        if (!isCompleteNonNegativeMoneyInput(l.discount, { allowEmpty: true }))
          return `الخصم في «${l.name}» غير صالح.`;
      }
      const base = toBase(l.qty, l.conversionFactor);
      if (!base.isInteger())
        return `الكمية في «${l.name}» تنتج كسراً بالوحدة الأساس (${formatQuantity(l.qty)} × ${l.conversionFactor}).`;
    }
    // مبلغ آجل (ذمة) يتطلّب عميلاً مُحدَّداً — يشمل «أقساط» بدون دفعة مقدّمة كاملة.
    // في وضع التصحيح: الدفع مقترح فقط ويُثبت عند الاعتماد؛ بوابة الإثبات أدناه للبيع الجديد.
    if (externalNeeded) {
      if (!externalConfirmed || externalAttempt?.attemptId == null) {
        return "ثبّت تأكيد الدفع غير النقديّ قبل حفظ الفاتورة.";
      }
    }
    if (!isCorrection) {
      const paid = D(computePaidStr());
      const remaining = D(totals.grandTotal).minus(paid);
      if (remaining.gt(0) && !state.entityId)
        return "هناك مبلغ آجل (ذمة) — اختر عميلاً لتسجيل الذمة عليه.";
      if (!splitTender.active && remaining.lt(0) && state.paymentMethod !== "CASH")
        return "الدفع غير النقدي لا يمكن أن يتجاوز إجمالي الفاتورة.";
    }
    if (D(totals.grandTotal).lt(0)) return "الإجمالي النهائي لا يمكن أن يكون سالباً.";
    // سياسة #14: لا نسبة ضريبة سالبة (الخادم يرفضها أيضاً — نمنعها هنا برسالة أوضح).
    if (
      state.taxEnabled &&
      (!isCompleteNonNegativeMoneyInput(state.taxRatePercent, { allowEmpty: true }) ||
        moneyInput(state.taxRatePercent).lt(0))
    )
      return "نسبة الضريبة لا يصحّ أن تكون سالبة.";
    return null;
  }

  function startDigitalFulfillment(approval?: Approval) {
    if (!currentShift.data) return notify.warn("يلزم فتح وردية في فرع الفاتورة قبل بيع الكروت والاشتراكات.");
    const regular = state.items.filter((c) => !c.digital);
    const digitalLines = state.items.filter((c) => c.digital);
    if (!digitalLines.length) return; const settlement = resolveDigitalInvoiceSettlement({ paymentTerms: state.paymentTerms, paymentMethod: state.paymentMethod, paidTotal: computePaidStr() });
    const payload = buildPayload(approval); const { managerApproval, ...sourcePayload } = payload;
    prepareIntent.mutate({
      branchId: Number(state.branchId), shiftId: currentShift.data.id, clientRequestId,
      paymentMethod: settlement.paymentMethod,
      externalPaymentAttemptId: settlement.paymentMethod === "CARD" ? externalAttempt?.attemptId ?? undefined : undefined,
      externalPaymentDeviceId: settlement.paymentMethod === "CARD" ? externalAttempt?.deviceId ?? undefined : undefined,
      cartFingerprint: clientRequestId, customerId: state.entityId ?? undefined, priceTier: state.tier,
      dueDate: state.paymentTerms === "CREDIT" && state.dueDate ? state.dueDate : undefined, notes: composeDocumentNotes({ notes: state.notes, terms: state.terms }), sourceType: "INVOICE",
      sourcePayload, regularLines: regular.map(toDigitalPrepareRegularLine), lines: digitalLines.map((c) => toDigitalPrepareLine(c.digital!)), ...(managerApproval ? { managerApproval } : {}),
    });
  }

  function addDigitalBasket(basket: DigitalBasketCapture) {
    try {
      const items: InvoiceLine[] = captureDigitalInvoiceBasketItems(basket);
      dispatch({ type: "ADD_ITEMS", items }); setCardsOpen(false);
    } catch (error) {
      notify.err(error);
    }
  }

  function finalizeDigitalIntent(id: number) {
    if (!salesOperationAllowed(me.data, "digitalCards.sales.finalize", true)) return notify.warn("إتمام الفاتورة الرقمية غير مفوّض لحسابك.");
    const settlement = resolveDigitalInvoiceSettlement({ paymentTerms: state.paymentTerms, paymentMethod: state.paymentMethod, paidTotal: computePaidStr() }); if (finalizeSale.isPending) return; finalizeSale.mutate({
      intentId: id, clientRequestId, paymentAmount: settlement.paymentAmount,
      paymentMethod: settlement.paymentMethod,
      customerId: state.entityId ?? undefined,
    });
  }

  function handleSubmit(approval?: Approval, requestReview = false) {
    // قيمة مالية غير رقمية (في المدفوع/الخصم) تجعل decimal.js يرمي — نلتقطها برسالة واضحة بدل تعطّل صامت.
    let err: string | null;
    try {
      err = validate();
    } catch {
      releaseReservedPrintWindow();
      printAfterSaveRef.current = false;
      shareAfterSaveRef.current = false;
      notify.warn("قيمة مالية غير صالحة — صحّح حقول المبالغ قبل الحفظ.");
      return;
    }
    if (err) {
      releaseReservedPrintWindow();
      printAfterSaveRef.current = false;
      shareAfterSaveRef.current = false;
      notify.warn(err);
      return;
    }
    try {
      if (isCorrection) {
        const cErr = validateCorrection();
        if (cErr) { notify.warn(cErr); return; }
        const correction = buildCorrectionPayload(approval);
        if (correctionKind === "EXCHANGE") {
          const {
            originalInvoiceId,
            reason: exchangeReason,
            clientRequestId: requestKey,
            managerApproval: _managerApproval,
            ...payload
          } = correction;
          exchange.mutate({
            requestKey,
            invoiceId: originalInvoiceId,
            reason: exchangeReason,
            requestReview,
            payload,
          });
        } else {
          reissue.mutate({ ...correction, requestReview });
        }
      } else {
        if (state.items.some((c) => !!c.digital)) {
          startDigitalFulfillment(approval);
        } else {
          create.mutate(buildPayload(approval));
        }
      }
    } catch {
      releaseReservedPrintWindow();
      printAfterSaveRef.current = false;
      shareAfterSaveRef.current = false;
      notify.warn("قيمة مالية غير صالحة — صحّح حقول المبالغ قبل الحفظ.");
    }
  }

  function handleReset() {
    splitTender.reset();
    dispatch({ type: "RESET", invoiceType: INVOICE_TYPE });
    setClientRequestId(crypto.randomUUID());
    // RESET يُعيد taxEnabled/taxRatePercent للافتراضي المُدرَج في createInitialState (false/"0") —
    // نُعيد تفعيل تطبيق إعدادات الضريبة الفعلية على الفاتورة التالية في نفس الجلسة.
    taxDefaultsAppliedRef.current = false;
  }

  function handleApprove() {
    if (isCorrection) {
      // The failed direct transaction rolled back; the same intent/key now requests review only.
      handleSubmit(undefined, true);
      return;
    }
    if (!mgrEmail.trim() || !mgrPwd.trim()) {
      notify.warn("أدخل بريد المدير وكلمة المرور للاعتماد.");
      return;
    }
    handleSubmit({ email: mgrEmail.trim(), password: mgrPwd });
  }

  function closeApprovalPrompt() {
    setCreditPrompt(null);
    if (printAfterSaveRef.current) {
      releaseReservedPrintWindow();
      printAfterSaveRef.current = false;
    }
    shareAfterSaveRef.current = false;
  }

  function handleAction(action: InvoiceActionKind) {
    if (!availableActions.includes(action)) return notify.warn("هذه العملية غير مفوّضة لحسابك.");
    switch (action) {
      case "save":
        releaseReservedPrintWindow();
        printAfterSaveRef.current = false;
        shareAfterSaveRef.current = false;
        handleSubmit();
        return;
      case "print":
        reservePrintWindow();
        printAfterSaveRef.current = true;
        shareAfterSaveRef.current = false;
        handleSubmit();
        return;
      case "draft":
        notify.info("لا مسوّدة لفاتورة البيع — استخدم «عرض سعر» للمسوّدات القابلة للتحويل.",
        );
        return;
      case "send":
        releaseReservedPrintWindow();
        printAfterSaveRef.current = false;
        shareAfterSaveRef.current = true;
        handleSubmit();
        return;
      case "pdf":
        // Use the same approved A4 document template as "save and print".
        // The browser's print dialog can then save that isolated document as
        // PDF; the invoice editor page itself is never printed.
        reservePrintWindow();
        printAfterSaveRef.current = true;
        shareAfterSaveRef.current = false;
        handleSubmit();
        return;
      case "convert":
        notify.info("التحويل متاح من عرض السعر فقط.");
        return;
      case "duplicate":
        if (state.items.length === 0) {
          notify.warn("لا توجد محتويات لنسخها.");
          return;
        }
        // حافظة داخلية مؤقتة لنقل السلة بين محررات المستندات. لا نستخدم حافظة ويندوز
        // لأنها لا تحفظ البنية والأسعار والخصومات، ولأن sessionStorage يبقي البيانات
        // داخل جلسة النظام الحالية فقط.
        copyInvoiceItems(state.items);
        dispatch({ type: "CLEAR_ITEMS" });
        setPasteAvailable(true);
        notify.ok("تم نسخ المنتجات وتفريغ الفاتورة. ستجد «لصق» في أي فاتورة تفتحها.",
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
        dispatch({ type: "MARK_STOCK_STALE" });
        setPasteAvailable(false);
        notify.ok("تم لصق محتويات الفاتورة.");
        return;
      }
      case "return":
        navigate("/returns?tab=sales");
        return;
    }
  }

  // حارس فقد البيانات (نمط ExpenseNew.tsx): بند واحد فأكثر أو عميل مُحدَّد أو ملاحظة مكتوبة تكفي
  // لاعتبار الفاتورة "قيد الإدخال" — يعترض تحديث/إغلاق التبويب فقط (beforeunload)، أما Esc/F12
  // الداخليان فيُحرَسان أدناه بتأكيدٍ صريح (وليس هذا الهوك، الذي لا يعترض تنقّل SPA الداخلي).
  const isDirty = useMemo(
    () => state.items.length > 0 || state.entityId != null || state.notes.trim() !== "" || Boolean(state.terms?.trim()),
    [state.items, state.entityId, state.notes, state.terms],
  );
  useUnsavedGuard(isDirty);

  /* ─── اختصارات لوحة المفاتيح (F2/F4/F9/F12/Esc) ───────────────────── */
  const containerRef = useRef<HTMLDivElement>(null);
  const submitPending = isCorrection ? reissue.isPending || exchange.isPending : create.isPending || prepareIntent.isPending || finalizeSale.isPending;
  const shortcutHandlersRef = useRef({ handleSubmit, handleReset, closeApprovalPrompt });
  shortcutHandlersRef.current = { handleSubmit, handleReset, closeApprovalPrompt };
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) =>
      !!el && (el as HTMLElement).matches?.("input, textarea, select, [contenteditable='true']",
      );
    // هل حوار تأكيدٍ (ConfirmHost) مفتوح فعلاً؟ — يمنع إعادة إطلاق تأكيد «مسح/مغادرة» جديد أثناء
    // إغلاق تأكيدٍ سابق بنفس ضغطة Esc (نمط anyOverlayOpen في useSaveShortcuts.ts).
    const confirmDialogOpen = () =>
      typeof document !== "undefined" && !!document.querySelector('[role="alertdialog"][data-state="open"]');

    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[data-split-tender-editor][data-state="open"]')) return;
      // أثناء فتح حوار الموافقة: Esc يغلقه فقط.
      if (creditPrompt) {
        if (e.key === "Escape") shortcutHandlersRef.current.closeApprovalPrompt();
        return;
      }
      if (e.key === "F2") {
        e.preventDefault();
        containerRef.current
          ?.querySelector<HTMLInputElement>("input[aria-label='بحث المنتجات']")
          ?.focus();
        return;
      }
      if (e.key === "F4") {
        e.preventDefault();
        if (!submitPending && availableActions.includes("save")) {
          releaseReservedPrintWindow();
          printAfterSaveRef.current = false;
          shareAfterSaveRef.current = false;
          shortcutHandlersRef.current.handleSubmit();
        }
        return;
      }
      if (e.key === "F9") {
        e.preventDefault();
        if (isCorrection) {
          notify.info("طباعة التصحيح متاحة بعد اعتماد الطلب وإصدار الفاتورة البديلة.");
          return;
        }
        if (!submitPending && availableActions.includes("print")) {
          reservePrintWindow();
          printAfterSaveRef.current = true;
          shareAfterSaveRef.current = false;
          shortcutHandlersRef.current.handleSubmit();
        }
        return;
      }
      if (e.key === "F12") {
        e.preventDefault();
        if (confirmDialogOpen()) return;
        if (!isDirty) { shortcutHandlersRef.current.handleReset(); return; }
        void confirm({
          variant: "warning",
          title: "مسح الفاتورة الحالية",
          description: "توجد بيانات لم تُحفَظ في هذه الفاتورة (بنود/عميل/ملاحظات). المسح سيُفقدها نهائياً. متابعة؟",
          confirmText: "مسح",
        }).then((ok) => { if (ok) shortcutHandlersRef.current.handleReset(); });
        return;
      }
      if (e.key === "Escape" && !isTypingTarget(e.target) && !bulkOpen) {
        e.preventDefault();
        if (confirmDialogOpen()) return;
        if (!isDirty) { navigate("/invoices"); return; }
        void confirm({
          variant: "warning",
          title: "مغادرة الفاتورة الحالية",
          description: "توجد بيانات لم تُحفَظ في هذه الفاتورة (بنود/عميل/ملاحظات). المغادرة ستُفقدها. متابعة؟",
        }).then((ok) => {
          if (ok) {
            bypassUnsavedGuard();
            navigate("/invoices");
          }
        });
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, bulkOpen, creditPrompt, submitPending, isDirty, me.data, correctionKind, externalAttempt]);

  const typeInfo = INVOICE_TYPES[INVOICE_TYPE];

  // بندٌ بسعر صفر **غير** موسومٍ هديةً = خطأ إدخال (سعر ناقص) يستحقّ التنبيه. أمّا الهدية فمجّانيّتها
  // مقصودة ومصنَّفة (تُرحَّل تكلفتها مصروفَ هدايا) ⇒ لا تُنذَر.
  const hasZeroPriceLine = useMemo(
    () =>
      state.items.some(
        (l) =>
          !l.isGift &&
          (!isCompleteNonNegativeMoneyInput(l.price, { allowEmpty: false }) || moneyInput(l.price).lte(0)),
      ),
    [state.items],
  );

  if (me.isLoading) return null;
  if (me.data && (isCorrection ? !salesOperationAllowed(me.data, "sales.get", true) || allowedKinds.length === 0 : !salesOperationAllowed(me.data, "sales.create", true) && !canUseDigital)) return <div className="rounded-lg border p-5 text-sm text-muted-foreground">هذه العملية غير مفوّضة لحسابك؛ راجع مسؤول الصلاحيات.</div>;
  if (isCorrection && correctionUnitIds.length > 0 && !salesOperationAllowed(me.data, "catalog.byUnitIds", true)) return <div className="rounded-lg border p-5 text-sm text-muted-foreground">يلزم تفويض قراءة أصناف الفاتورة وأسعارها الحالية لإكمال التصحيح.</div>;
  if (isCorrection && original.isLoading) {
    return <div className="p-10 text-center text-muted-foreground">جارٍ تحميل الفاتورة الأصلية…</div>;
  }
  if (isCorrection && (original.isError || !original.data)) {
    return (
      <div className="m-auto max-w-lg space-y-3 rounded-lg border border-destructive/40 p-5 text-center">
        <div className="font-bold text-destructive">تعذّر تحميل الفاتورة الأصلية للتعديل.</div>
        <Button variant="outline" onClick={() => void original.refetch()}>إعادة المحاولة</Button>
      </div>
    );
  }
  if (isCorrection && correctionUnitIds.length > 0 && correctionCatalog.isError) {
    return (
      <div className="m-auto max-w-lg space-y-3 rounded-lg border border-destructive/40 p-5 text-center">
        <div className="font-bold text-destructive">تعذّر تحميل أصناف الفاتورة وأسعارها الحالية.</div>
        <Button variant="outline" onClick={() => void correctionCatalog.refetch()}>إعادة تحميل الأصناف</Button>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      dir="rtl"
      // ٢٣/٨ (بلاغ فحص UX): وضع التصحيح كان يبدو كإنشاءٍ عاديّ عدا العنوان — في يومٍ مزدحم
      // قد يُحفَظ تصحيحٌ ظنّاً أنّه فاتورة جديدة (يُلغي الأصل!). حلقةٌ عنبريّة حول الجذر
      // تجعل الوضع لا يُخطئ للحظة.
      className={cn(
        "flex flex-col gap-2",
        isCorrection && "rounded-lg ring-2 ring-[var(--sem-warn)]/40",
      )}
    >
      {isCorrection && (
        <div className="flex items-center gap-2 rounded-md border-2 border-[var(--sem-warn)]/60 bg-[var(--sem-warn-bg)] px-3 py-1.5 text-xs font-extrabold text-[var(--sem-warn)]">
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          <span>وضع تصحيح — سيُعكس الأصل ({original.data?.invoiceNumber ?? "…"}) ويُصدَر بديل مرتبط به عند التنفيذ حسب صلاحيتك وسقف الاسترداد.</span>
        </div>
      )}
      {/* شريط العنوان */}
      <PageHeader
        title={
          isCorrection
            ? `تصحيح الفاتورة${original.data?.invoiceNumber ? ` ${original.data.invoiceNumber}` : ""}`
            : `${typeInfo.label} متقدّمة`
        }
        icon={(() => { const TIcon = typeInfo.icon; return <TIcon aria-hidden className="size-5 text-primary" />; })()}
        backHref="/invoices"
        backLabel="رجوع للفواتير"
        actions={
          <span className="hidden text-xs font-semibold text-muted-foreground sm:inline">
            الإجمالي:{" "}
            <span className="font-extrabold text-foreground" dir="ltr">{totals.grandTotal}</span>{" "}
            د.ع
          </span>
        }
      />

      {/* رأس الفاتورة (بيانات المستند + العميل + الشروط المالية) */}
      <InvoiceHeader state={state} dispatch={dispatch} invoiceType={INVOICE_TYPE} pricingIntentEpoch={pricingIntentEpochRef.current} salesReps={salesReps} />

      {openingModeQuery.data?.active === true && (
        <div className="flex items-center gap-2 rounded-md border border-[var(--sem-warn)]/50 bg-[var(--sem-warn-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--sem-warn)]">
          <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
          <span>
            وضع الافتتاح فعّال حتى نهاية يوم {openingModeQuery.data.endsAtYmd} — منتجٌ غير مجرود افتتاحياً يُسجَّل ولو نفد
            رصيده (ينزل بالسالب): بسدادٍ كامل نقداً/بطاقةً، أو آجلاً لعميلٍ محدَّد (يُسجَّل ذمّةً كاملة). البيع بلا عميلٍ يبقى صارماً.
          </span>
        </div>
      )}

      {hasZeroPriceLine && (
        <div className="badge-stock-low flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold">
          <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
          <span>هناك بنود بسعر غير صالح — صحّحها قبل الحفظ.</span>
        </div>
      )}

      {/* البنية الأساسية: جدول البنود + لوحة الإجماليات والإجراءات — تدفّق طبيعي بلا حبس ارتفاع */}
      <div className="flex flex-col gap-2.5 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-2 h-[62vh] min-h-[380px] print:h-auto print:min-h-fit">
          <ProductTable
            items={state.items}
            dispatch={dispatch}
            branchId={state.branchId}
            tier={state.tier} customerId={state.entityId} excludeInvoiceId={isCorrection ? correctInvoiceId : null} pricingIntentEpoch={pricingIntentEpochRef.current}
            invoiceType={INVOICE_TYPE}
            showCost={showCost}
            /* هدايا الفاتورة (0149): مفتاح «هدية» لكلّ سطر — يُصفّر قيمته في الفاتورة وتُرحَّل
               تكلفته مصروفَ هدايا في الدفتر (قيد GIFT_OUT) لا خسارةَ بيعٍ مبهمة. */
            allowGiftLines
            /* حصص ضريبة الفاتورة (توزيع تناسبي، عرض فقط) — تظهر كعمود حين taxEnabled=true. */
            taxShares={taxShares}
            onOpenBulkPicker={() => setBulkOpen(true)}
            onOpenDigitalCardsPicker={isCorrection || !canUseDigital ? undefined : () => setCardsOpen(true)}
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
            tier={state.tier} customerId={state.entityId}
          />
          
          <DigitalCardsPickerDialog
            open={cardsOpen} branchId={state.branchId} offline={false}
            onClose={() => setCardsOpen(false)} onPickBasket={addDigitalBasket}
            existingCardCount={state.items.filter((item) => item.digital).length}
            existingReferences={state.items.flatMap((item) => item.digital ? [{ providerId: item.digital.providerId, providerReference: item.digital.providerReference }] : [])}
          />
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-1.5 xl:w-72">
          {/* أجرة التوصيل صارت مدعومة في sales.create (تُحفَظ في `invoices.deliveryFee` وتدخل
              قيد SALE إيراداً بلا تكلفة، ويعكسها المرتجع الكامل) ⇒ أُظهرت مع مفتاح «مجاني».
              «مصاريف أخرى» تبقى مخفيّة: الخادم لا يحفظها، وإظهارها يُضخّم الإجمالي المعروض
              و«ادفع الكل» بمبلغٍ لا يُحفَظ (خسارة مالية صامتة). */}
          {/* في التصحيح تُخفى لوحة الدفع: `buildCorrectionPayload` يتجاهل `base.payment` كلياً،
              فحقلا «المدفوع» و«الكل» كانا يقبلان مبلغاً يُهمَل صامتاً (الموظّف يكتب ما قبضه
              فوق لوحة التصحيح مباشرةً فلا يُسجَّل إيصالٌ ولا يُخصَم من الذمّة). المسار الوحيد
              للمال هنا هو «المُحصَّل الآن»، وطريقتُه صارت بجواره في CorrectionPanel. */}
          <TotalsPanel
            shippingLabel="أجرة التوصيل"
            allowFreeShipping
            items={state.items}
            state={state}
            dispatch={dispatch}
            showShipping
            showOtherExpenses={false}
            showTaxToggle
            showPayment={!isCorrection && !splitTender.active}
          />
          {!isCorrection && <div className="space-y-2 rounded-md border p-3"><SplitTenderButton draft={splitTender} due={totals.grandTotal} disabled={!splitTender.active && (hasDigitalItems || state.paymentTerms === "CREDIT" || state.items.length === 0)} reason={hasDigitalItems ? "الكروت الرقمية تتبع مسار تسديد مستقل." : state.paymentTerms === "CREDIT" ? "الآجل الكامل بلا دفعة الآن." : null}/>{splitTender.active && <p className="text-sm">المقبوض: {fmtAr(splitTender.tendered)} د.ع · المتبقي: {fmtAr(splitTender.totals(totals.grandTotal).remaining.toFixed(2))} د.ع{splitTender.totals(totals.grandTotal).change.gt(0) && ` · الفكة: ${fmtAr(splitTender.totals(totals.grandTotal).change.toFixed(2))} د.ع`}</p>}</div>}
          {/* بوّابة الإثبات: مرجعٌ + تأكيدٌ خادميّ قبل فتح الحفظ — مطابقة لكل قبض مبيعات. */}
          {externalNeeded && (
            <Card className="p-3">
              {canConfirmExternal ? <PaymentReferenceField
                value={paymentRef}
                onChange={(v) => { setPaymentRef(v); setExternalAttempt(null); }}
                method={state.paymentMethod}
                confirmed={externalConfirmed}
                confirming={initiateExternal.isPending || confirmExternal.isPending}
                onConfirm={confirmExternalPayment}
                inputId="sales-invoice-payment-reference"
                colors={{
                  border: "var(--border)", muted: "var(--muted)", mutedFg: "var(--muted-foreground)",
                  fg: "var(--foreground)", amber: "var(--sem-warn)", success: "var(--sem-pos)",
                }}
              /> : <p className="text-sm text-muted-foreground">تأكيد الدفع الخارجي غير مفوّض لحسابك؛ راجع المسؤول لتفويض بدء العملية وتأكيدها.</p>}
            </Card>
          )}
          {isCorrection && (
            <SalesCorrectionPanel
              original={original.data ?? null}
              recordedPaid={originalPaid}
              receivedPrior={receivedPrior}
              receiptMode={receiptMode}
              setReceiptMode={setReceiptMode}
              inferredNotReceived={priorReceipt.inferredNotReceived}
              customerChanged={customerChanged}
              originalTerms={originalTerms}
              targetTerms={state.paymentTerms}
              ownerExecutes={ownerExecutes}
              grandTotal={totals.grandTotal}
              reason={reason}
              setReason={setReason}
              correctionKind={correctionKind}
              allowedKinds={allowedKinds}
              setCorrectionKind={setCorrectionKind}
              collectNow={collectNow}
              setCollectNow={setCollectNow}
              paymentMethod={state.paymentMethod}
              setPaymentMethod={(m) => dispatch({ type: "SET_FIELD", field: "paymentMethod", value: m,
                })}
              overpayHandling={overpayHandling}
              setOverpayHandling={setOverpayHandling}
              hasCustomer={state.entityId != null}
              pendingCod={pendingCodCorrection}
            />
          )}
          <div className="sticky bottom-0 z-10 bg-background/95 backdrop-blur pt-1.5 border-t">
            <ActionButtons
              invoiceType={INVOICE_TYPE}
              items={state.items}
              saving={submitPending}
              pasteAvailable={pasteAvailable}
              availableActions={availableActions}
              primaryLabel={isCorrection ? "حفظ التعديل" : undefined}
              onAction={handleAction}
            />
          </div>
          <TermsAndNotes state={state} dispatch={dispatch} />
        </aside>
      </div>

      <ShortcutsBar shortcuts={salesEditorShortcuts(availableActions, isCorrection)} />

      {/* حوار موافقة المدير (تجاوز حدّ الائتمان / بيع بأقل من التكلفة) */}
      <Dialog open={!!creditPrompt} onOpenChange={(o) => { if (!o) closeApprovalPrompt(); }}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Lock aria-hidden className="size-5" />
              {isCorrection ? "مراجعة مستقلة مطلوبة" : "موافقة مدير مطلوبة"}
            </DialogTitle>
            <DialogDescription className="text-right">
              {isCorrection
                ? `${creditPrompt ?? "التعديل يحتاج مراجعة"} أرسل الطلب إلى مراجع مستقل؛ لا يتغيّر المال أو المخزون حتى اعتماده.`
                : creditPrompt ?? "تجاوز حدّ الائتمان — يلزم اعتماد مدير لإتمام البيع الآجل."}
            </DialogDescription>
          </DialogHeader>
          {!isCorrection && <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">بريد المدير</Label>
              <Input
                dir="ltr"
                type="email"
                value={mgrEmail}
                onChange={(e) => setMgrEmail(e.target.value)}
                placeholder="manager@alroya.local"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">كلمة المرور</Label>
              <Input
                dir="ltr"
                type="password"
                value={mgrPwd}
                onChange={(e) => setMgrPwd(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleApprove(); }}
                placeholder="••••••••"
              />
            </div>
          </div>}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={closeApprovalPrompt}>
              إلغاء
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isCorrection ? reissue.isPending || exchange.isPending : create.isPending}
              onClick={handleApprove}
            >
              {(isCorrection ? reissue.isPending || exchange.isPending : create.isPending)
                ? isCorrection ? ACTION_LABELS.sending : ACTION_LABELS.approving
                : isCorrection
                  ? "إرسال إلى مراجع مستقل"
                  : "اعتماد وإتمام البيع"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DigitalFulfillmentDialog intentId={digitalIntentId} finalizing={finalizeSale.isPending} finalizeError={digitalFinalizeError}
        onClose={() => { setDigitalIntentId(null); setDigitalFinalizeError(null); }}
        onAllExecuted={finalizeDigitalIntent}
      />
    </div>
  );
}
