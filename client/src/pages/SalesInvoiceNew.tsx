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
import { Link, useLocation, useRoute } from "wouter";

import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { D, round2, toBase, fmt } from "@/lib/money";
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { copyInvoiceItems, hasInvoiceTransfer, takeInvoiceItems } from "@/lib/invoiceTransfer";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage } from "@shared/posPaymentPolicy";
import { PaymentReferenceField } from "@/components/pos/PaymentReferenceField";
import { getDeviceCode } from "@/lib/offline/outbox";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { releaseReservedPrintWindow, reservePrintWindow } from "@/lib/printing/brand";
import { AlertTriangle, Lock, FileWarning } from "lucide-react";
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
  ShortcutsBar,
  invoiceReducer,
  createInitialState,
  calcTotals,
  calcLineTotal,
  allocateLineTax,
  derivePaymentTerms,
  INVOICE_TYPES,
  PAYMENT_METHODS,
  type InvoiceActionKind,
  type InvoiceLine,
  type PaymentMethod,
  type PaymentTerm,
  type PriceTier,
} from "@/components/invoice";

const INVOICE_TYPE = "SALE" as const;

/** موافقة مدير لتجاوز حدّ الائتمان (بريد + كلمة مرور). */
type Approval = { email: string; password: string };

/** تنسيق تاريخ (بقيم UTC — التواريخ يومية مخزَّنة عند منتصف ليل UTC) إلى YYYY-MM-DD أو "". */
function toYmdUtc(v: unknown): string {
  const d = v instanceof Date ? v : v ? new Date(v as string) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export default function SalesInvoiceNew() {
  const [, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();

  const defaultBranchId = me.data?.branchId ?? 1;

  const [state, dispatch] = useReducer(
    invoiceReducer,
    undefined,
    () => createInitialState(INVOICE_TYPE, defaultBranchId)
  );

  // ── تصحيح الفاتورة (0168) — نفس شاشة البيع في وضع التصحيح (نمط المعيار: مسار + query + هيدرة مرّة) ──
  // كلّ ما يخصّ التصحيح محجوبٌ خلف isCorrection ⇒ تدفّق الإنشاء يبقى مطابقاً حرفاً بحرف حين لا تصحيح.
  const [corrMatch, corrParams] = useRoute("/invoices/:id/correct");
  const correctInvoiceId = corrMatch && corrParams?.id ? Number(corrParams.id) : null;
  const isCorrection = correctInvoiceId != null && correctInvoiceId > 0;
  const original = trpc.sales.get.useQuery({ invoiceId: correctInvoiceId ?? 0 }, { enabled: isCorrection });
  const correctionUnitIds = useMemo(
    () => Array.from(new Set((original.data?.items ?? []).map((item) => item.productUnitId ?? 0).filter((id) => id > 0))),
    [original.data?.items],
  );
  const correctionCatalog = trpc.catalog.byUnitIds.useQuery(
    { branchId: original.data?.branchId ?? defaultBranchId, tier: (original.data?.priceTier ?? "RETAIL") as PriceTier, productUnitIds: correctionUnitIds },
    { enabled: isCorrection && !!original.data && correctionUnitIds.length > 0, staleTime: 15_000 },
  );
  const originalPaid = useMemo(() => D(original.data?.paidAmount ?? "0"), [original.data?.paidAmount]);
  const [reason, setReason] = useState("");
  const [overpayHandling, setOverpayHandling] = useState<"CREDIT" | "CASH_REFUND">("CASH_REFUND");
  // درج ردّ الفائض — يُجلب مع وضع التصحيح فقط، ويُختار درج المنفّذ افتراضاً (نمط ReturnComposer).
  const [overpayShiftId, setOverpayShiftId] = useState<number | null>(null);
  const correctionShiftsQ = trpc.treasury.getOpenShifts.useQuery(
    { branchId: original.data?.branchId ?? defaultBranchId },
    { enabled: isCorrection && !!original.data, retry: false },
  );
  const correctionOpenShifts = useMemo(
    () => (correctionShiftsQ.data ?? []).map((s) => ({
      shiftId: s.shiftId,
      userName: s.userName,
      expectedCash: s.expectedCash,
      isMine: Number(s.userId) === Number(me.data?.id ?? -1),
    })),
    [correctionShiftsQ.data, me.data?.id],
  );
  // الافتراضي: درج المنفّذ نفسه إن كان مفتوحاً، وإلّا الوحيد المفتوح — فلا يقرّر الموظف ما لا يعرفه.
  useEffect(() => {
    if (overpayShiftId != null || correctionOpenShifts.length === 0) return;
    const mine = correctionOpenShifts.find((s) => s.isMine);
    setOverpayShiftId(mine ? mine.shiftId : correctionOpenShifts.length === 1 ? correctionOpenShifts[0].shiftId : null);
  }, [correctionOpenShifts, overpayShiftId]);
  const [collectNow, setCollectNow] = useState("");
  const correctionHydratedRef = useRef(false);
  // مُعرَّف هنا (لا لاحقاً) كي تتمكّن هيدرة التصحيح من تثبيته ⇒ لا تطمس تهيئةُ الضريبة الافتراضية ضريبةَ الأصل.
  const taxDefaultsAppliedRef = useRef(false);
  useEffect(() => {
    if (!isCorrection || correctionHydratedRef.current || !original.data) return;
    if (correctionUnitIds.length > 0 && !correctionCatalog.data) return;
    const d = original.data;
    const catalogByUnit = new Map((correctionCatalog.data ?? []).map((row) => [row.productUnitId, row]));
    if (d.customerId) dispatch({ type: "SET_ENTITY", id: d.customerId });
    if (d.priceTier) dispatch({ type: "SET_FIELD", field: "tier", value: d.priceTier as PriceTier });
    // شروط الدفع وطريقته من الأصل — لا تُترَك على افتراضيّ «نقدي». الشروط تُظهر حقل تاريخ
    // الاستحقاق للفاتورة الآجلة (كان يُرسَل مخفيّاً فلا يستطيع الموظّف تصحيحه)، والطريقة هي
    // التي يُقبَض بها «المُحصَّل الآن» فلا تُفترَض نقداً على فاتورةٍ قُبِضت بالبطاقة.
    dispatch({ type: "SET_FIELD", field: "paymentTerms", value: derivePaymentTerms(d) });
    if (d.paymentMethod && isPosPaymentMethodEnabled(d.paymentMethod as PaymentMethod)) {
      dispatch({ type: "SET_FIELD", field: "paymentMethod", value: d.paymentMethod as PaymentMethod });
    }
    // خصمٌ إجماليّ (كمبلغ صريح — الأصل يخزّنه مبلغاً لا نسبة).
    if (D(d.discountAmount ?? "0").gt(0)) {
      dispatch({ type: "SET_FIELD", field: "globalDiscountType", value: "amount" });
      dispatch({ type: "SET_FIELD", field: "globalDiscount", value: String(d.discountAmount) });
    }
    // ضريبةٌ على مستوى الفاتورة — نحمِلها من الأصل ونُثبّت الرايةَ كي لا تطمسها تهيئةُ الافتراضيات.
    if (D(d.taxRatePercent ?? "0").gt(0) || D(d.taxAmount ?? "0").gt(0)) {
      dispatch({ type: "SET_FIELD", field: "taxEnabled", value: true });
      dispatch({ type: "SET_FIELD", field: "taxRatePercent", value: String(d.taxRatePercent ?? "0") });
    } else {
      dispatch({ type: "SET_FIELD", field: "taxEnabled", value: false });
    }
    taxDefaultsAppliedRef.current = true; // منع useEffect الافتراضيات من إعادة الكتابة فوق ضريبة الأصل.
    // أجرة التوصيل / التوصيل المجّانيّ (إفصاح) — تُحمَل كما الأصل.
    if (d.deliveryFree) {
      dispatch({ type: "SET_FIELD", field: "shippingFree", value: true });
      if (D(d.deliveryWaivedAmount ?? "0").gt(0))
        dispatch({ type: "SET_FIELD", field: "shipping", value: String(d.deliveryWaivedAmount) });
    } else if (D(d.deliveryFee ?? "0").gt(0)) {
      dispatch({ type: "SET_FIELD", field: "shipping", value: String(d.deliveryFee) });
    }
    if (d.notes) dispatch({ type: "SET_FIELD", field: "notes", value: d.notes });
    const dueYmd = toYmdUtc(d.dueDate);
    if (dueYmd) dispatch({ type: "SET_FIELD", field: "dueDate", value: dueYmd });
    // نفس تحويل duplicateInvoice: بنود الفاتورة → InvoiceLine حرفياً (الكمية كاملةً — مصدر التصحيح).
    dispatch({
      type: "ADD_ITEMS",
      items: d.items.map((it): InvoiceLine => ({
        productId: it.productId ?? 0,
        variantId: it.variantId,
        productUnitId: it.productUnitId ?? 0,
        name: it.productName ?? "",
        sku: it.sku ?? "",
        barcode: null,
        unit: it.unitName ?? "",
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
      })),
    });
    correctionHydratedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCorrection, original.data, correctionCatalog.data, correctionUnitIds]);

  // بذرة «نسخ لفاتورة جديدة» (من قائمة الفواتير): sessionStorage تُقرأ مرة واحدة عند التركيب
  // ثم تُحذف فوراً (read-once) كي لا تُزرع مجدداً عند العودة للصفحة. الأسطر بشكل InvoiceLine حرفياً.
  useEffect(() => {
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
      if (seed.paymentTerms) dispatch({ type: "SET_FIELD", field: "paymentTerms", value: seed.paymentTerms });
      if (Array.isArray(seed.items) && seed.items.length) {
        dispatch({ type: "ADD_ITEMS", items: seed.items });
        dispatch({ type: "MARK_STOCK_STALE" });
      }
      notify.info("تم نسخ الفاتورة — راجِع الأسعار فهي منسوخة من الفاتورة الأصلية وقد تختلف عن الأسعار الحالية.");
    } catch {
      /* بذرة معطوبة — تجاهل */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // مزامنة فرع المستخدم مرة واحدة (إن وصل لاحقاً)؛ لا نطمس اختياره اليدوي بعدها.
  const syncedBranch = useRef(false);
  useEffect(() => {
    if (!syncedBranch.current && me.data?.branchId && state.branchId !== me.data.branchId) {
      dispatch({ type: "SET_FIELD", field: "branchId", value: me.data.branchId });
      syncedBranch.current = true;
    } else if (me.data) {
      syncedBranch.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data?.branchId]);

  // لقطة السطر المخزنية ليست مصدراً للحقيقة: النسخ/اللصق/تغيير الفرع ومسودة قديمة كلها قد تحمل
  // رقماً قديماً. نعيد قراءة الوحدات الموجودة فقط من الفرع الذي طبّقه الخادم، دورياً وعند التركيز.
  const stockUnitIds = useMemo(
    () => Array.from(new Set(state.items.map((item) => item.productUnitId))).slice(0, 500),
    [state.items],
  );
  const liveStockQ = trpc.catalog.stockByUnitIds.useQuery(
    { branchId: state.branchId, productUnitIds: stockUnitIds },
    {
      enabled: stockUnitIds.length > 0,
      staleTime: 0,
      refetchInterval: stockUnitIds.length > 0 ? 15_000 : false,
      refetchOnWindowFocus: true,
    },
  );

  useEffect(() => {
    dispatch({ type: "MARK_STOCK_STALE" });
  }, [state.branchId]);

  useEffect(() => {
    const snapshot = liveStockQ.data;
    if (!snapshot) return;
    // غير الأدمن قد يطلب فرعاً آخر من واجهة/مسودة قديمة، لكن الخادم يجبره على فرع حسابه.
    // نعكس الفرع الفعلي في الرأس بدلاً من إبقاء اسمٍ مضلّل فوق أرقام فرع آخر.
    if (snapshot.branchId !== state.branchId) {
      dispatch({ type: "SET_FIELD", field: "branchId", value: snapshot.branchId });
      return;
    }
    dispatch({
      type: "SET_STOCK_SNAPSHOTS",
      snapshotsByUnitId: Object.fromEntries(
        snapshot.rows.map((row) => [
          row.productUnitId,
          {
            stockBase: row.stockBase,
            stockBranchId: row.branchId,
            reservedBase: row.reservedBase,
            availableBase: row.availableBase,
            isService: row.isService,
          },
        ]),
      ),
    });
  }, [liveStockQ.data, state.branchId]);

  // تهيئة تفعيل/نسبة الضريبة من إعدادات النظام (مرّة واحدة فقط، فاتورة جديدة) — يبقى المستخدم
  // حرّاً بتبديلها يدوياً بعدها (لا نُعيد التهيئة عند كل جلب/إعادة رسم). المرجع مُعرَّف أعلاه.
  const taxSettingsQuery = trpc.system.getTaxSettings.useQuery();
  // «وضع الافتتاح» (ش٥ + توسعة ١٠/٨): هذه الشاشة تمرّ بقناة POS نفسها ⇒ يستفيد من السالب المشروط
  // بيعُها المسدَّد كاملاً نقداً/بطاقةً **وكذلك الآجل لعميلٍ محدَّد** (يُسجَّل ذمّةً) — لافتة توضيحية.
  const openingModeQuery = trpc.system.getOpeningMode.useQuery(undefined, { staleTime: 60_000 });
  useEffect(() => {
    if (!taxDefaultsAppliedRef.current && taxSettingsQuery.data) {
      dispatch({ type: "SET_FIELD", field: "taxEnabled", value: taxSettingsQuery.data.enabledByDefault });
      dispatch({ type: "SET_FIELD", field: "taxRatePercent", value: taxSettingsQuery.data.defaultTaxRatePercent });
      taxDefaultsAppliedRef.current = true;
    }
  }, [taxSettingsQuery.data]);

  // وردية مفتوحة للفرع (إن وُجدت) ⇒ تُسجَّل الدفعة النقدية في صندوق الوردية.
  const currentShift = trpc.shifts.current.useQuery(
    { branchId: state.branchId },
    { enabled: !!state.branchId }
  );

  // idempotency: مفتاح ثابت لكل محاولة إنشاء (يُجدَّد بعد كل حفظ ناجح / RESET).
  const [clientRequestId, setClientRequestId] = useState<string>(() => crypto.randomUUID());
  const printAfterSaveRef = useRef(false);
  const shareAfterSaveRef = useRef(false);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [pasteAvailable, setPasteAvailable] = useState(hasInvoiceTransfer);

  // حوار موافقة المدير (يُفتح عند خطأ تجاوز حدّ الائتمان).
  const [creditPrompt, setCreditPrompt] = useState<string | null>(null);
  const [mgrEmail, setMgrEmail] = useState("");
  const [mgrPwd, setMgrPwd] = useState("");

  // RBAC: المدير/الأدمن يرى التكلفة والهامش؛ الكاشير لا.
  const role = me.data?.role;
  const showCost = role === "manager" || role === "admin";

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
   * إثباتها أضعف. (مسار التصحيح يمرّ بـ`reissue` الذي يقبل مرجعاً نصّياً بعقده الخاصّ.)
   */
  const [paymentRef, setPaymentRef] = useState("");
  const [externalAttempt, setExternalAttempt] = useState<
    { attemptId: number | null; requestId: string; deviceId: string; fingerprint: string; confirmed: boolean } | null
  >(null);
  /** مبلغ الإثبات = ما يُرسَل فعلاً: `collectNow` في التصحيح، ومدفوع الفاتورة في الإنشاء. */
  const externalAmountD = isCorrection ? D(collectNow.trim() || "0") : D(computePaidStr());
  const externalAmount = round2(externalAmountD).toFixed(2);
  const externalNeeded = state.paymentMethod !== "CASH" && externalAmountD.gt(0);
  const externalFingerprint = `${state.branchId}|${state.paymentMethod}|${externalAmount}|${paymentRef.trim()}`;
  const externalConfirmed =
    !externalNeeded || (externalAttempt?.confirmed === true && externalAttempt.fingerprint === externalFingerprint);

  const initiateExternal = trpc.sales.initiateExternalPayment.useMutation();
  const confirmExternal = trpc.sales.confirmExternalPayment.useMutation();

  async function confirmExternalPayment() {
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
        });
        attemptId = initiated.attemptId;
        // تُحفَظ **قبل** التأكيد: لو سقط التأكيد، تُعاد المحاولة نفسها بدل توليد مفتاحٍ
        // جديد لمرجعٍ عالميّ الفرادة (فيُرفض تكراراً ويُحبَس القبض).
        setExternalAttempt({ attemptId, requestId, deviceId, fingerprint: externalFingerprint, confirmed: false });
      }
      await confirmExternal.mutateAsync({ branchId: Number(branchId), attemptId, deviceId });
      setExternalAttempt({ attemptId, requestId, deviceId, fingerprint: externalFingerprint, confirmed: true });
      notify.ok("تأكّد الدفع الخارجي", `ثُبّت المرجع ${reference} وأصبح جاهزاً للاستهلاك مرّةً واحدة.`);
    } catch (error) {
      notify.err(error instanceof Error ? error.message : "تعذّر تثبيت تأكيد الدفع الخارجي");
    }
  }

  /* ─── mutation ─────────────────────────────────────────────────── */
  const create = trpc.sales.create.useMutation({
    onSuccess: (r) => {
      utils.sales.list.invalidate();
      const id = (r as { invoiceId: number }).invoiceId;
      notify.ok("تم حفظ فاتورة البيع واعتمادها");
      // أعِد توليد المفتاح للفاتورة التالية + أغلق حوار الموافقة إن كان مفتوحاً.
      setClientRequestId(crypto.randomUUID());
      setCreditPrompt(null);
      setMgrEmail("");
      setMgrPwd("");
      const printAfterSave = printAfterSaveRef.current;
      const shareAfterSave = shareAfterSaveRef.current;
      printAfterSaveRef.current = false;
      shareAfterSaveRef.current = false;
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

  // تصحيح الفاتورة (0168): إعادة إصدارٍ مصحّحة عبر sales.reissue (عكس + repost خادميّ ذرّيّ).
  const reissue = trpc.sales.reissue.useMutation({
    onSuccess: (r) => {
      utils.sales.list.invalidate();
      notify.ok("تم تصحيح الفاتورة", `صدرت فاتورةٌ مصحّحة ${r.correctedInvoiceNumber}${Number(r.overpay) > 0 ? ` — فرقٌ زائد ${r.overpay} (${r.overpayHandled === "CREDIT" ? "رصيد دائن" : "استرداد نقديّ"})` : ""}`);
      setCreditPrompt(null); setMgrEmail(""); setMgrPwd("");
      navigate(`/invoices/${r.correctedInvoiceId}`);
    },
    onError: (e) => {
      if (e.message && (e.message.includes("حدّ الائتمان") || e.message.includes("بأقل من التكلفة") || e.message.includes("موافقة مدير"))) {
        setCreditPrompt(e.message);
        return;
      }
      notify.err(e);
    },
  });

  /**
   * المبلغ المدفوع نقداً وفق شروط الدفع:
   *  • نقداً (CASH): القيمة المُدخَلة، أو الإجمالي الكامل إن تُركت فارغة.
   *  • آجل (CREDIT): صفر — كامل المبلغ يُسجَّل ذمة.
   *  • أقساط (INSTALLMENT): الدفعة المقدّمة المُدخَلة فقط، وصفر إن تُركت فارغة (الباقي ذمة) —
   *    لا يُفترَض الدفع الكامل ضمناً (الخادم لا يدعم جدول أقساط؛ نعامله كآجل بدفعة مقدّمة اختيارية).
   */
  function computePaidStr(): string {
    if (state.paymentTerms === "CREDIT") return "0";
    const entered = state.paidAmount.trim();
    if (entered) return round2(D(entered)).toFixed(2);
    return state.paymentTerms === "INSTALLMENT" ? "0" : totals.grandTotal;
  }

  /** يبني payload البيع بأموال نصّية (decimal.js) — لا parseFloat. */
  function buildPayload(approval?: Approval) {
    const paidStr = computePaidStr();
    // إيصال دفع يُرسَل فقط إن كان هناك مبلغ مدفوع فعلاً (>0)؛ غير ذلك = ذمة كاملة.
    const hasPayment = D(paidStr).gt(0);

    return {
      branchId: state.branchId,
      shiftId: currentShift.data?.id ?? undefined,
      customerId: state.entityId ?? undefined,
      priceTier: state.tier,
      lines: state.items.map((l) => ({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        quantity: D(l.qty).toString(),
        // الهدية: نُعلن النيّة فقط ولا نُرسل سعراً/خصماً — الخادم يُصفّرهما بنفسه ويُرحّل التكلفة
        // قيدَ GIFT_OUT. إرسال سعرٍ هنا يفتح باب «هديةٍ بسعر» لو انحرفت الشاشة يوماً.
        ...(l.isGift
          ? { isGift: true as const }
          : {
              unitPriceOverride: round2(D(l.price)).toFixed(2),
              discountPercent: l.discountType === "percent" ? round2(D(l.discount || "0")).toFixed(2) : undefined,
              discountAmount: l.discountType === "amount" ? round2(D(l.discount || "0")).toFixed(2) : undefined,
            }),
      })),
      // أجرة التوصيل (0152) — ثلاث حالات صريحة لا اثنتان:
      //   مدفوع  ⇒ deliveryFee > 0 (إيرادُ شحنٍ يدخل الإجمالي)
      //   مجّانيّ ⇒ deliveryFree=true + القيمة المُتنازَل عنها (بلا إيراد ولا إجمالي)
      //   بلا توصيل ⇒ لا شيء يُرسَل إطلاقاً
      ...(state.shippingFree
        ? {
            deliveryFree: true as const,
            ...(D(state.shipping || "0").gt(0)
              ? { deliveryWaivedAmount: round2(D(state.shipping)).toFixed(2) }
              : {}),
          }
        : D(totals.shipping).gt(0)
          ? { deliveryFee: totals.shipping }
          : {}),
      // خصم إجمالي كمبلغ (calcTotals يحوّل النسبة إلى مبلغ). يُرسَل فقط إن كان موجباً.
      invoiceDiscount: D(totals.globalDiscAmt).gt(0) ? totals.globalDiscAmt : undefined,
      // العراق VAT=0% افتراضياً — الضريبة اختيارية على مستوى الفاتورة، تُطبَّق فقط عند تفعيلها
      // صراحةً من «تطبيق ضريبة» في ملخّص المبالغ (لعملاء/دوائر تتطلّب فاتورة ضريبية).
      taxRatePercent: state.taxEnabled ? round2(D(state.taxRatePercent || "0")).toFixed(2) : "0",
      payment: hasPayment
        ? {
            amount: paidStr,
            method: state.paymentMethod,
            ...(state.paymentMethod === "CASH"
              ? {}
              : { externalPaymentAttemptId: externalAttempt?.attemptId ?? undefined }),
          }
        : undefined,
      // يجب أن يطابق جهاز المحاولة المؤكَّدة، وإلا رُفض استهلاكها.
      ...(hasPayment && state.paymentMethod !== "CASH" && externalAttempt?.deviceId
        ? { deviceId: externalAttempt.deviceId }
        : {}),
      // تاريخ الاستحقاق للبيع الآجل/الأقساط فقط (يُحفظ على invoices.dueDate ⇒ أعمار الذمم
      // تُعمِّر من موعد الاستحقاق لا تاريخ الفاتورة). الحقل يظهر في الترويسة لهذين النوعين فقط.
      dueDate:
        (state.paymentTerms === "CREDIT" || state.paymentTerms === "INSTALLMENT") && state.dueDate
          ? state.dueDate
          : undefined,
      clientRequestId,
      notes: state.notes.trim() || undefined,
      ...(approval ? { managerApproval: approval } : {}),
    };
  }

  /** حمولة تصحيح الفاتورة (sales.reissue): تعيد استعمال أسطر buildPayload؛ المدفوع سابقاً محمولٌ
   *  خادمياً، فـadditionalPayment للنقص المُحصَّل الآن وoverpayHandling للفائض. */
  function buildCorrectionPayload(approval?: Approval) {
    const base = buildPayload(approval);
    const diff = D(totals.grandTotal).minus(originalPaid); // موجب=نقص يُحصَّل، سالب=فائض يُردّ/يُرصَّد
    const collect = D(collectNow.trim() || "0");
    // أجرة التوصيل تُحسَب هنا (لا من `base` الذي نوعُه اتحادٌ بسبب حقول التوصيل الشرطية).
    // إفصاح «التوصيل المجّانيّ» لا يُحمَل في تصحيح v1 (علَمٌ إفصاحيّ لا ماليّ).
    const deliveryFee =
      !state.shippingFree && D(totals.shipping).gt(0) ? totals.shipping : null;
    return {
      originalInvoiceId: correctInvoiceId!,
      customerId: base.customerId ?? null,
      priceTier: base.priceTier,
      lines: base.lines,
      invoiceDiscount: base.invoiceDiscount ?? null,
      deliveryFee,
      taxRatePercent: base.taxRatePercent,
      dueDate: state.dueDate || null,
      notes: base.notes ?? null,
      reason: reason.trim(),
      clientRequestId,
      ...(diff.gt(0) && collect.gt(0)
        ? {
            additionalPayment: {
              amount: round2(collect).toFixed(2),
              method: state.paymentMethod,
              ...(state.paymentMethod === "CASH" ? {} : { reference: paymentRef.trim() }),
            },
          }
        : {}),
      ...(diff.lt(0)
        ? {
            overpayHandling,
            // الدرج مورد فرعٍ لا مستخدم — يُمرَّر صراحةً كي لا يرفض الخادم عند تعدّد الأدراج.
            ...(overpayHandling === "CASH_REFUND" && overpayShiftId != null
              ? { overpayRefundShiftId: overpayShiftId }
              : {}),
          }
        : {}),
      ...(approval ? { managerApproval: approval } : {}),
    };
  }

  /** تحقّق التصحيح — رسالة عربية أو null. */
  function validateCorrection(): string | null {
    if (reason.trim().length < 3) return "اكتب سبب التصحيح (٣ أحرف على الأقل).";
    const diff = D(totals.grandTotal).minus(originalPaid);
    const collect = D(collectNow.trim() || "0");
    if (diff.gt(0)) {
      if (collect.gt(diff)) return `المُحصَّل الآن (${collect.toFixed(2)}) يتجاوز الفرق المستحقّ (${diff.toFixed(2)}).`;
      if (diff.minus(collect).gt(0) && !state.entityId) return "المتبقّي بعد المُحصَّل الآن ذمّة — اختر عميلاً أو حصّل الفرق كاملاً.";
    }
    if (diff.lt(0) && overpayHandling === "CREDIT" && !state.entityId) return "الرصيد الدائن يتطلّب عميلاً — اختر عميلاً أو اختر استرداداً نقدياً.";
    if (diff.lt(0) && overpayHandling === "CASH_REFUND") {
      if (correctionOpenShifts.length === 0) return "لا توجد وردية مفتوحة بالفرع لاسترداد الفائض نقداً — افتح وردية أو اختر رصيداً دائناً.";
      if (overpayShiftId == null) return "حدّد الدرج الذي سيخرج منه الفائض نقداً.";
    }
    return null;
  }

  /** تحقّق أعمالي قبل الإرسال. يُرجع رسالة عربية أو null إن صالح. */
  function validate(): string | null {
    if (!isPosPaymentMethodEnabled(state.paymentMethod)) return posPaymentRejectionMessage(state.paymentMethod);
    if (state.items.length === 0) return "أضف منتجاً واحداً على الأقل.";
    // قرار المالك (٦/٨/٢٦): «مجاني» يلزمه مقدار الأجرة — يُطبَع للزبون ويُحصى في التقارير.
    // الخادم يمنعه أيضاً؛ هذا الحارس ليوفّر على الموظّف رحلةَ ذهابٍ وإياب.
    if (state.shippingFree && !D(state.shipping || "0").gt(0)) {
      return "أدخِل قيمة أجرة التوصيل قبل جعله مجّانياً — تُطبَع للزبون وتُحصى في التقارير.";
    }
    for (const l of state.items) {
      if (!D(l.qty).gt(0)) return `الكمية في «${l.name}» يجب أن تكون موجبة.`;
      if (D(l.price).lt(0)) return `السعر في «${l.name}» غير صالح.`;
      const base = toBase(l.qty, l.conversionFactor);
      if (!base.isInteger())
        return `الكمية في «${l.name}» تنتج كسراً بالوحدة الأساس (${l.qty} × ${l.conversionFactor}).`;
    }
    // مبلغ آجل (ذمة) يتطلّب عميلاً مُحدَّداً — يشمل «أقساط» بدون دفعة مقدّمة كاملة.
    // في وضع التصحيح: الدفع محمولٌ خادمياً وتحقّقه في validateCorrection ⇒ نتخطّى منطق الدفع هنا.
    // لا يُفتَح الحفظ لدفعٍ غير نقديّ قبل تثبيت إثباته (محاولةٌ مؤكَّدة للإنشاء، مرجعٌ للتصحيح).
    if (externalNeeded) {
      if (isCorrection) {
        if (!paymentRef.trim()) return "أدخِل مرجع العملية للدفع غير النقديّ.";
      } else if (!externalConfirmed || externalAttempt?.attemptId == null) {
        return "ثبّت تأكيد الدفع غير النقديّ قبل حفظ الفاتورة.";
      }
    }
    if (!isCorrection) {
      const paid = D(computePaidStr());
      const remaining = D(totals.grandTotal).minus(paid);
      if (remaining.gt(0) && !state.entityId)
        return "هناك مبلغ آجل (ذمة) — اختر عميلاً لتسجيل الذمة عليه.";
      if (remaining.lt(0) && state.paymentMethod !== "CASH")
        return "الدفع غير النقدي لا يمكن أن يتجاوز إجمالي الفاتورة.";
    }
    if (D(totals.grandTotal).lt(0)) return "الإجمالي النهائي لا يمكن أن يكون سالباً.";
    // سياسة #14: لا نسبة ضريبة سالبة (الخادم يرفضها أيضاً — نمنعها هنا برسالة أوضح).
    if (state.taxEnabled && D(state.taxRatePercent || "0").lt(0))
      return "نسبة الضريبة لا يصحّ أن تكون سالبة.";
    return null;
  }

  function handleSubmit(approval?: Approval) {
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
        reissue.mutate(buildCorrectionPayload(approval));
      } else {
        create.mutate(buildPayload(approval));
      }
    } catch {
      releaseReservedPrintWindow();
      printAfterSaveRef.current = false;
      shareAfterSaveRef.current = false;
      notify.warn("قيمة مالية غير صالحة — صحّح حقول المبالغ قبل الحفظ.");
    }
  }

  function handleReset() {
    dispatch({ type: "RESET", invoiceType: INVOICE_TYPE });
    setClientRequestId(crypto.randomUUID());
    // RESET يُعيد taxEnabled/taxRatePercent للافتراضي المُدرَج في createInitialState (false/"0") —
    // نُعيد تفعيل تطبيق إعدادات الضريبة الفعلية على الفاتورة التالية في نفس الجلسة.
    taxDefaultsAppliedRef.current = false;
  }

  function handleApprove() {
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
        notify.info("لا مسوّدة لفاتورة البيع — استخدم «عرض سعر» للمسوّدات القابلة للتحويل.");
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
        dispatch({ type: "MARK_STOCK_STALE" });
        setPasteAvailable(false);
        notify.ok("تم لصق محتويات الفاتورة.");
        return;
      }
      case "return":
        navigate("/sales-returns/new");
        return;
    }
  }

  // حارس فقد البيانات (نمط ExpenseNew.tsx): بند واحد فأكثر أو عميل مُحدَّد أو ملاحظة مكتوبة تكفي
  // لاعتبار الفاتورة "قيد الإدخال" — يعترض تحديث/إغلاق التبويب فقط (beforeunload)، أما Esc/F12
  // الداخليان فيُحرَسان أدناه بتأكيدٍ صريح (وليس هذا الهوك، الذي لا يعترض تنقّل SPA الداخلي).
  const isDirty = useMemo(
    () => state.items.length > 0 || state.entityId != null || state.notes.trim() !== "",
    [state.items, state.entityId, state.notes],
  );
  useUnsavedGuard(isDirty);

  /* ─── اختصارات لوحة المفاتيح (F2/F4/F9/F12/Esc) ───────────────────── */
  const containerRef = useRef<HTMLDivElement>(null);
  const submitPending = isCorrection ? reissue.isPending : create.isPending;
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) =>
      !!el && (el as HTMLElement).matches?.("input, textarea, select, [contenteditable='true']");
    // هل حوار تأكيدٍ (ConfirmHost) مفتوح فعلاً؟ — يمنع إعادة إطلاق تأكيد «مسح/مغادرة» جديد أثناء
    // إغلاق تأكيدٍ سابق بنفس ضغطة Esc (نمط anyOverlayOpen في useSaveShortcuts.ts).
    const confirmDialogOpen = () =>
      typeof document !== "undefined" && !!document.querySelector('[role="alertdialog"][data-state="open"]');

    const onKey = (e: KeyboardEvent) => {
      // أثناء فتح حوار الموافقة: Esc يغلقه فقط.
      if (creditPrompt) {
        if (e.key === "Escape") closeApprovalPrompt();
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
        if (!submitPending) {
          releaseReservedPrintWindow();
          printAfterSaveRef.current = false;
          shareAfterSaveRef.current = false;
          handleSubmit();
        }
        return;
      }
      if (e.key === "F9") {
        e.preventDefault();
        if (!submitPending) {
          reservePrintWindow();
          printAfterSaveRef.current = true;
          shareAfterSaveRef.current = false;
          handleSubmit();
        }
        return;
      }
      if (e.key === "F12") {
        e.preventDefault();
        if (confirmDialogOpen()) return;
        if (!isDirty) { handleReset(); return; }
        void confirm({
          variant: "warning",
          title: "مسح الفاتورة الحالية",
          description: "توجد بيانات لم تُحفَظ في هذه الفاتورة (بنود/عميل/ملاحظات). المسح سيُفقدها نهائياً. متابعة؟",
          confirmText: "مسح",
        }).then((ok) => { if (ok) handleReset(); });
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
          confirmText: "مغادرة",
        }).then((ok) => { if (ok) navigate("/invoices"); });
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, bulkOpen, creditPrompt, create.isPending, isDirty]);

  const typeInfo = INVOICE_TYPES[INVOICE_TYPE];

  // بندٌ بسعر صفر **غير** موسومٍ هديةً = خطأ إدخال (سعر ناقص) يستحقّ التنبيه. أمّا الهدية فمجّانيّتها
  // مقصودة ومصنَّفة (تُرحَّل تكلفتها مصروفَ هدايا) ⇒ لا تُنذَر.
  const hasZeroPriceLine = useMemo(
    () => state.items.some((l) => !l.isGift && D(l.price).lte(0)),
    [state.items]
  );

  return (
    <div
      ref={containerRef}
      dir="rtl"
      // ٢٣/٨ (بلاغ فحص UX): وضع التصحيح كان يبدو كإنشاءٍ عاديّ عدا العنوان — في يومٍ مزدحم
      // قد يُحفَظ تصحيحٌ ظنّاً أنّه فاتورة جديدة (يُلغي الأصل!). حلقةٌ عنبريّة حول الجذر
      // تجعل الوضع لا يُخطئ للحظة.
      className={cn(
        "flex h-full flex-col gap-3",
        isCorrection && "rounded-lg ring-2 ring-[var(--sem-warn)]/40",
      )}
    >
      {isCorrection && (
        <div className="flex items-center gap-2 rounded-md border-2 border-[var(--sem-warn)]/60 bg-[var(--sem-warn-bg)] px-3 py-1.5 text-xs font-extrabold text-[var(--sem-warn)]">
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          <span>وضع تصحيح — سيُلغى الأصل ({original.data?.invoiceNumber ?? "…"}) ويُصدَر بديل بمرجعه.</span>
        </div>
      )}
      {/* شريط العنوان */}
      <PageHeader
        title={
          isCorrection
            ? `تصحيح الفاتورة${original.data?.invoiceNumber ? ` ${original.data.invoiceNumber}` : ""}`
            : `${typeInfo.label} متقدّمة`
        }
        icon={(() => { const TIcon = typeInfo.icon; return <TIcon aria-hidden className="size-6 text-primary" />; })()}
        actions={
          <div className="flex items-center gap-3 text-xs">
            <span className="hidden font-semibold text-muted-foreground sm:inline">
              الإجمالي:{" "}
              <span className="font-extrabold text-foreground" dir="ltr">{totals.grandTotal}</span> د.ع
            </span>
            <Link
              href="/invoices"
              className="rounded-md border bg-card px-3 py-1.5 text-sm font-semibold text-muted-foreground hover:bg-muted"
            >
              ← رجوع للفواتير
            </Link>
          </div>
        }
      />

      {/* رأس الفاتورة (بيانات المستند + العميل + الشروط المالية) */}
      <InvoiceHeader state={state} dispatch={dispatch} invoiceType={INVOICE_TYPE} />

      {openingModeQuery.data?.active === true && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
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

      {/* البنية الأساسية: جدول البنود + لوحة الإجماليات والإجراءات */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 xl:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <ProductTable
            items={state.items}
            dispatch={dispatch}
            branchId={state.branchId}
            tier={state.tier}
            invoiceType={INVOICE_TYPE}
            showCost={showCost}
            /* هدايا الفاتورة (0149): مفتاح «هدية» لكلّ سطر — يُصفّر قيمته في الفاتورة وتُرحَّل
               تكلفته مصروفَ هدايا في الدفتر (قيد GIFT_OUT) لا خسارةَ بيعٍ مبهمة. */
            allowGiftLines
            /* حصص ضريبة الفاتورة (توزيع تناسبي، عرض فقط) — تظهر كعمود حين taxEnabled=true. */
            taxShares={taxShares}
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

        <aside className="flex w-full shrink-0 flex-col gap-2 xl:w-80">
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
            showPayment={!isCorrection}
          />
          {/* بوّابة الإثبات: مرجعٌ + تأكيدٌ خادميّ قبل فتح الحفظ — مطابقة لبوّابة الكاشير.
              في التصحيح يكفي المرجع النصّي (عقد `sales.reissue` يحمله بنفسه). */}
          {externalNeeded && (
            <div className="rounded-xl border bg-card p-3">
              <PaymentReferenceField
                value={paymentRef}
                onChange={(v) => { setPaymentRef(v); setExternalAttempt(null); }}
                method={state.paymentMethod}
                confirmed={isCorrection ? paymentRef.trim().length > 0 : externalConfirmed}
                confirming={initiateExternal.isPending || confirmExternal.isPending}
                onConfirm={confirmExternalPayment}
                inputId="sales-invoice-payment-reference"
                colors={{
                  border: "var(--border)", muted: "var(--muted)", mutedFg: "var(--muted-foreground)",
                  fg: "var(--foreground)", amber: "var(--sem-warn)", success: "var(--sem-pos)",
                }}
              />
            </div>
          )}
          {isCorrection && (
            <CorrectionPanel
              original={original.data ?? null}
              originalPaid={originalPaid}
              grandTotal={totals.grandTotal}
              reason={reason}
              setReason={setReason}
              collectNow={collectNow}
              setCollectNow={setCollectNow}
              paymentMethod={state.paymentMethod}
              setPaymentMethod={(m) => dispatch({ type: "SET_FIELD", field: "paymentMethod", value: m })}
              overpayHandling={overpayHandling}
              setOverpayHandling={setOverpayHandling}
              hasCustomer={state.entityId != null}
              openShifts={correctionOpenShifts}
              overpayShiftId={overpayShiftId}
              setOverpayShiftId={setOverpayShiftId}
            />
          )}
          <ActionButtons
            invoiceType={INVOICE_TYPE}
            items={state.items}
            saving={isCorrection ? reissue.isPending : create.isPending}
            pasteAvailable={pasteAvailable}
            availableActions={isCorrection ? ["save", "print"] : undefined}
            primaryLabel={isCorrection ? "عكس الأصل وإصدار المصححة" : undefined}
            printLabel={isCorrection ? "إصدار وطباعة المصححة" : undefined}
            onAction={handleAction}
          />
          <TermsAndNotes state={state} dispatch={dispatch} />
        </aside>
      </div>

      <ShortcutsBar />

      {/* حوار موافقة المدير (تجاوز حدّ الائتمان / بيع بأقل من التكلفة) */}
      <Dialog open={!!creditPrompt} onOpenChange={(o) => { if (!o) closeApprovalPrompt(); }}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Lock aria-hidden className="size-5" />
              موافقة مدير مطلوبة
            </DialogTitle>
            <DialogDescription className="text-right">
              {creditPrompt ?? "تجاوز حدّ الائتمان — يلزم اعتماد مدير لإتمام البيع الآجل."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
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
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={closeApprovalPrompt}>
              إلغاء
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isCorrection ? reissue.isPending : create.isPending}
              onClick={handleApprove}
            >
              {(isCorrection ? reissue.isPending : create.isPending)
                ? "جارٍ الاعتماد…"
                : isCorrection
                  ? "اعتماد وإتمام التصحيح"
                  : "اعتماد وإتمام البيع"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** سطر ملخّصٍ صغير (وصف ⟷ قيمة) داخل لوحة التصحيح. */
function CorrRow({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={className ?? "font-semibold tabular-nums"} dir="ltr">{value}</span>
    </div>
  );
}

interface CorrectionPanelProps {
  original: { invoiceNumber?: string | null } | null;
  originalPaid: ReturnType<typeof D>;
  grandTotal: string;
  reason: string;
  setReason: (v: string) => void;
  collectNow: string;
  setCollectNow: (v: string) => void;
  /** طريقة قبض «المُحصَّل الآن» — هنا لا في TotalsPanel: لوحة الدفع مخفيّة في التصحيح. */
  paymentMethod: PaymentMethod;
  setPaymentMethod: (v: PaymentMethod) => void;
  overpayHandling: "CREDIT" | "CASH_REFUND";
  setOverpayHandling: (v: "CREDIT" | "CASH_REFUND") => void;
  hasCustomer: boolean;
  /** أدراج الفرع المفتوحة — الخادم يفرض اختياراً صريحاً حين تتعدّد. */
  openShifts: Array<{ shiftId: number; userName: string; expectedCash: string; isMine: boolean }>;
  overpayShiftId: number | null;
  setOverpayShiftId: (v: number | null) => void;
}

/**
 * لوحة تصحيح الفاتورة — تظهر فقط في وضع التصحيح (isCorrection). تعرض السبب الإلزاميّ، وفرق
 * المال بين المدفوع سابقاً وإجمالي التصحيح، وتفرّع حسب اتجاه الفرق:
 *   نقص (الإجمالي > المدفوع) ⇒ «المُحصَّل الآن» + تنبيه إن بقي جزءٌ ذمّةً بلا عميل.
 *   فائض (الإجمالي < المدفوع) ⇒ خيار «استرداد نقديّ» أو «رصيد دائن» (الأخير يلزمه عميل).
 * لا منطقَ ماليّ هنا — كلّه عرضٌ وتحقّقٌ عميليّ يُماثل validateCorrection؛ الخادم هو الحكم.
 */
function CorrectionPanel({
  original,
  originalPaid,
  grandTotal,
  reason,
  setReason,
  collectNow,
  setCollectNow,
  paymentMethod,
  setPaymentMethod,
  overpayHandling,
  setOverpayHandling,
  hasCustomer,
  openShifts,
  overpayShiftId,
  setOverpayShiftId,
}: CorrectionPanelProps) {
  const diff = D(grandTotal).minus(originalPaid); // موجب=نقص يُحصَّل، سالب=فائض يُردّ/يُرصَّد
  const isShort = diff.gt(0);
  const isOver = diff.lt(0);
  const collect = D(collectNow || "0");
  const remainingCredit = isShort ? diff.minus(collect) : D("0");

  return (
    <div dir="rtl" className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
      <div className="flex items-center gap-2 font-bold text-primary">
        <FileWarning aria-hidden className="size-4 shrink-0" />
        <span>تصحيح موثَّق{original?.invoiceNumber ? ` — ${original.invoiceNumber}` : ""}</span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        يُلغى الأصل بالكامل (عكسٌ دفتريّ) وتُصدَر فاتورةٌ جديدةٌ مربوطةٌ بالتعديلات، والأصل يُوسَم «مُصحَّحة».
      </p>

      <div className="space-y-1">
        <Label className="text-xs font-semibold">
          سبب التصحيح <span className="text-destructive">*</span>
        </Label>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="مثال: صُحِّحت الكمية بعد مراجعة الطلب"
          className="text-sm"
        />
      </div>

      <div className="space-y-1 rounded-md border bg-card p-2 text-xs">
        <CorrRow label="مدفوعٌ على الأصل" value={fmt(originalPaid.toString())} />
        <CorrRow label="إجمالي بعد التصحيح" value={fmt(grandTotal)} />
        <div className="my-1 h-px bg-border" />
        {diff.isZero() ? (
          <div className="font-semibold text-money-positive">لا فرق ماليّ — التصحيح متوازن.</div>
        ) : isShort ? (
          <CorrRow label="فرقٌ مستحقّ (نقص)" value={fmt(diff.toString())} className="font-bold tabular-nums text-money-negative" />
        ) : (
          <CorrRow label="فائضٌ للزبون" value={fmt(diff.abs().toString())} className="font-bold tabular-nums text-money-positive" />
        )}
      </div>

      {isShort && (
        <div className="space-y-1">
          <Label className="text-xs font-semibold">المُحصَّل الآن</Label>
          <MoneyInput value={collectNow} onChange={setCollectNow} placeholder="0" ariaLabel="المبلغ المُحصَّل الآن" />
          {/* الطرق تُشتقّ من السياسة المركزية (لا نصّ ثابت) — المعطَّلة لا تُعرَض أصلاً هنا
              لأنّ هذا منتقٍ مضغوط لا لوحة دفعٍ كاملة. */}
          {collect.gt(0) && (
            <div className="space-y-1 pt-1">
              <Label className="text-xs font-semibold">طريقة القبض</Label>
              <div className="flex flex-wrap gap-1.5">
                {PAYMENT_METHODS.filter((m) => isPosPaymentMethodEnabled(m.value)).map((m) => {
                  const MIcon = m.icon;
                  const active = paymentMethod === m.value;
                  return (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setPaymentMethod(m.value)}
                      aria-pressed={active}
                      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        active
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-input bg-card text-foreground hover:bg-muted"
                      }`}
                    >
                      <MIcon aria-hidden className="size-4" />
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {remainingCredit.gt(0) && (
            <p className={`text-xs ${hasCustomer ? "text-muted-foreground" : "text-destructive"}`}>
              {hasCustomer
                ? `المتبقّي ${fmt(remainingCredit.toString())} يُسجَّل ذمّةً على العميل.`
                : `المتبقّي ${fmt(remainingCredit.toString())} ذمّة — اختر عميلاً أو حصِّل الفرق كاملاً.`}
            </p>
          )}
        </div>
      )}

      {isOver && (
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold">معالجة الفائض</Label>
          <RadioGroup
            value={overpayHandling}
            onValueChange={(v) => setOverpayHandling(v as "CREDIT" | "CASH_REFUND")}
            className="gap-2"
          >
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <RadioGroupItem value="CASH_REFUND" /> استرداد نقديّ من الدرج
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <RadioGroupItem value="CREDIT" /> رصيدٌ دائنٌ للعميل
            </label>
          </RadioGroup>
          {overpayHandling === "CREDIT" && !hasCustomer && (
            <p className="text-xs text-destructive">الرصيد الدائن يتطلّب عميلاً — اختر عميلاً أو استرداداً نقدياً.</p>
          )}
          {/* الدرج مورد فرعٍ لا مستخدم: حين يتعدّد الدرج المفتوح يفرض الخادم اختياراً صريحاً
              (resolveBranchCashShiftTx). بلا هذا المنتقي كان الموظف يملأ كل شيء ثمّ يُرفض —
              نفس العلّة التي عولجت في شاشة المرتجعات. */}
          {overpayHandling === "CASH_REFUND" && (
            <div className="space-y-1">
              <Label className="text-xs font-semibold">من أيّ درج يخرج النقد؟</Label>
              {openShifts.length === 0 ? (
                <p className="text-xs text-destructive">
                  لا توجد وردية مفتوحة في هذا الفرع — افتح وردية أو اختر رصيداً دائناً.
                </p>
              ) : (
                <AppSelect
                  size="sm"
                  className="text-xs"
                  aria-label="درج استرداد الفائض"
                  value={overpayShiftId != null ? String(overpayShiftId) : ""}
                  onValueChange={(v: string) => setOverpayShiftId(v ? Number(v) : null)}
                  placeholder="اختر الدرج…"
                >
                  {openShifts.map((s) => (
                    <option key={s.shiftId} value={String(s.shiftId)}>
                      {s.isMine ? "درجي — " : ""}{s.userName} (نقد {fmt(s.expectedCash)})
                    </option>
                  ))}
                </AppSelect>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
