/**
 * QuotationNew — صفحة إنشاء عرض سعر جديد (شريحة QUOTATION).
 *
 * تستخدم مكتبة محرّر الفواتير المشتركة (client/src/components/invoice/*).
 * - state عبر invoiceReducer (نوع QUOTATION ثابت).
 * - mutation = trpc.quotations.create؛ بعد النجاح يفتح صفحة التفاصيل ويفعّل «تحويل لفاتورة».
 * - clientRequestId للحماية من الإرسال المزدوج (idempotency على مستوى الراوتر).
 * - الأموال عبر decimal.js (money.ts) — ممنوع parseFloat/Number على الأموال.
 * - اختصارات F2/F4/F9/F12/Esc.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { AlertTriangle } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { D, formatQuantity, moneyInput } from "@/lib/money";
import { salesOperationAllowed } from "@/lib/salesOperationAccess";
import { PageHeader } from "@/components/PageHeader";
import { OrderCustomizationAssets } from "@/components/store/OrderCustomizationAssets";
import { copyInvoiceItems, hasInvoiceTransfer, takeInvoiceItems } from "@/lib/invoiceTransfer";
import { releaseReservedPrintWindow, reservePrintWindow } from "@/lib/printing/brand";
import { useSaveShortcuts } from "@/hooks/useSaveShortcuts";
import { useUnsavedGuard, bypassUnsavedGuard } from "@/hooks/useUnsavedGuard";
import {
  buildQuotationLinePayload,
  isCompleteNonNegativeMoneyInput,
} from "@/lib/quotationPayload";
import { variantDisplayName } from "@shared/variantDisplay";

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
  INVOICE_TYPES,
  type InvoiceActionKind,
} from "@/components/invoice";
import { createPricingIntentEpoch } from "@/components/invoice/productSearchResolution";
import { canSeeCost } from "@shared/permissions";

const INVOICE_TYPE = "QUOTATION" as const;

export default function QuotationNew() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = useParams<{ id?: string }>();
  const editQuotationId = params.id ? Number(params.id) : null;
  const isEdit = Number.isInteger(editQuotationId) && Number(editQuotationId) > 0;
  const sourceQuoteRequestId = useMemo(() => {
    const value = Number(new URLSearchParams(search).get("storeQuoteRequestId"));
    return Number.isInteger(value) && value > 0 ? value : null;
  }, [search]);
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const editQuery = trpc.quotations.get.useQuery(
    { quotationId: isEdit ? Number(editQuotationId) : 1 },
    { enabled: isEdit },
  );
  const sourceQuoteRequest = trpc.storeAdmin.quoteRequests.prepareOfficialQuotation.useQuery(
    { requestId: sourceQuoteRequestId ?? 1 },
    { enabled: !isEdit && sourceQuoteRequestId != null },
  );

  // مصدر الفرع الافتراضي (يأتي مع جلسة المستخدم). نُعيد تهيئة الحالة عند تحميله أول مرة.
  const defaultBranchId = me.data?.branchId ?? 1;

  const [state, dispatch] = useReducer(
    invoiceReducer,
    undefined,
    () => createInitialState(INVOICE_TYPE, defaultBranchId)
  );
  const pricingIntentEpochRef = useRef(createPricingIntentEpoch());

  const taxDefaultsAppliedRef = useRef(false);
  const editHydratedRef = useRef(false);
  const sourceHydratedRequestIdRef = useRef<number | null>(null);
  useEffect(() => {
    const quotation = editQuery.data;
    if (!isEdit || !quotation || editHydratedRef.current) return;
    if (quotation.status !== "DRAFT") {
      notify.warn("لا يمكن تعديل عرض السعر بعد إرساله — أنشئ نسخة جديدة.");
      navigate(`/quotations/${quotation.id}`);
      return;
    }
    const parsedNotes = splitDocumentNotes(quotation.notes);
    dispatch({
      type: "REPLACE_STATE",
      state: {
        ...createInitialState(INVOICE_TYPE, Number(quotation.branchId)),
        invoiceNumber: quotation.quoteNumber,
        date: quotation.quoteDate ? String(quotation.quoteDate).slice(0, 10) : "",
        entityId: quotation.customerId ? Number(quotation.customerId) : null,
        branchId: Number(quotation.branchId),
        tier: quotation.priceTier,
        validUntil: quotation.validUntil ? String(quotation.validUntil).slice(0, 10) : "",
        notes: parsedNotes.notes,
        terms: parsedNotes.terms,
        globalDiscount: quotation.discountAmount ?? "0",
        globalDiscountType: "amount",
        taxEnabled: D(quotation.taxRatePercent ?? "0").gt(0),
        taxRatePercent: quotation.taxRatePercent ?? "0",
        items: quotation.items.map((item) => ({
          productId: Number(item.productId),
          variantId: Number(item.variantId),
          productUnitId: Number(item.productUnitId),
          name: variantDisplayName({ ...item, productName: item.productName ?? "" }),
          variantName: item.variantName,
          color: item.color,
          size: item.size,
          colorHex: item.colorHex,
          variantKind: item.variantKind,
          sku: item.sku ?? "",
          barcode: item.barcode ?? null,
          unit: item.unitName ?? "",
          qty: Number(item.quantity),
          conversionFactor: item.conversionFactor ?? "1",
          stockBase: 0,
          price: item.unitPrice,
          referencePrice: item.referenceUnitPrice,
          priceSource: item.priceSource,
          costBase: item.costBase ?? "0",
          discount: item.discountAmount ?? "0",
          discountType: "amount",
          note: "",
        })),
      },
    });
    editHydratedRef.current = true;
    taxDefaultsAppliedRef.current = true;
  }, [editQuery.data, isEdit, navigate]);

  // طلب المتجر ليس تسعيراً. نملأ فقط العميل وبنود الكتالوج الحية وسعره الحالي القابل للتعديل؛
  // البنود التي تغيّرت/أوقفت منذ الطلب تبقى في السياق النصّي ليتعامل معها الموظف يدوياً.
  useEffect(() => {
    const request = sourceQuoteRequest.data;
    if (isEdit || !sourceQuoteRequestId || !request || sourceHydratedRequestIdRef.current === request.id) return;
    const currentLines = request.items.filter(
      (item) => item.isCurrentCatalogLine && item.productId && item.variantId && item.productUnitId,
    );
    const staleLines = request.items.filter((item) => !item.isCurrentCatalogLine);
    const sourceContext = [
      `طلب متجر مصدر: ${request.requestNumber}`,
      request.companyName ? `الجهة: ${request.companyName}` : null,
      request.governorate ? `المحافظة: ${request.governorate}` : null,
      `وصف العميل: ${request.customerNote}`,
      staleLines.length
        ? `بنود تحتاج مراجعة يدوية لأنها لم تعد متاحة بالكتالوج: ${staleLines.map((item) => `${item.productName} × ${formatQuantity(item.quantity)} ${item.unitName}`).join("، ")}`
        : null,
    ].filter(Boolean).join("\n");
    dispatch({
      type: "REPLACE_STATE",
      state: {
        ...createInitialState(INVOICE_TYPE, request.branchId),
        entityId: request.customerId,
        branchId: request.branchId,
        tier: request.customerPriceTier,
        notes: sourceContext,
        items: currentLines.map((item) => ({
          productId: Number(item.productId),
          variantId: Number(item.variantId),
          productUnitId: Number(item.productUnitId),
          name: variantDisplayName({ productName: item.productName, variantName: item.currentVariantName ?? item.variantLabel }),
          sku: item.sku ?? "",
          barcode: null,
          unit: item.currentUnitName ?? item.unitName,
          qty: item.quantity,
          conversionFactor: item.conversionFactor ?? "1",
          stockBase: 0,
          price: item.suggestedUnitPrice ?? "0",
          // لا يوجد exact-tier ⇒ صفرٌ مرئي فقط، لا override تلقائي. إن لم يعدّله الموظف
          // يرفض الخادم الحفظ لغياب سعر الفئة؛ وإذا عدّله يصبح الفرق تجاوزاً صريحاً.
          referencePrice: item.suggestedUnitPrice ?? "0",
          priceSource: item.suggestedPriceSource ?? "TIER",
          costBase: "0",
          discount: "0",
          discountType: "amount",
          note: "",
        })),
      },
    });
    sourceHydratedRequestIdRef.current = request.id;
    taxDefaultsAppliedRef.current = true;
  }, [isEdit, sourceQuoteRequest.data, sourceQuoteRequestId]);

  // مزامنة فرع المستخدم مرة واحدة (إن وصل لاحقاً)؛ لا نطمس اختياره اليدوي بعد ذلك.
  const syncedBranch = useRef(false);
  useEffect(() => {
    if (!syncedBranch.current && me.data?.branchId && state.branchId !== me.data.branchId) {
      dispatch({ type: "SET_FIELD", field: "branchId", value: me.data.branchId });
      syncedBranch.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data?.branchId]);

  // إعدادات الضريبة الافتراضية تُطبّق مرة واحدة على العرض الجديد، ثم يبقى القرار
  // بيد المستخدم ولا نطمس اختياره عند إعادة جلب الإعدادات.
  const taxSettingsQuery = trpc.system.getTaxSettings.useQuery();
  useEffect(() => {
    if (!isEdit && !taxDefaultsAppliedRef.current && taxSettingsQuery.data) {
      dispatch({ type: "SET_FIELD", field: "taxEnabled", value: taxSettingsQuery.data.enabledByDefault });
      dispatch({ type: "SET_FIELD", field: "taxRatePercent", value: taxSettingsQuery.data.defaultTaxRatePercent });
      taxDefaultsAppliedRef.current = true;
    }
  }, [isEdit, taxSettingsQuery.data]);

  // مزامنة أرصدة المخزون الحيّة للوحدات المضافة أو المحمّلة من مسودة/طلب متجر (بما في ذلك ما يتجاوز 500 وحدة عبر دفعات)
  useInvoiceLiveStockSync({
    items: state.items,
    branchId: state.branchId,
    enabled: salesOperationAllowed(me.data, "catalog.stockByUnitIds", true),
    dispatch,
  });

  const totals = useMemo(() => calcTotals(state.items, state), [state.items, state]);
  const taxShares = useMemo(
    () =>
      state.taxEnabled && D(totals.totalTax).gt(0)
        ? allocateLineTax(
            state.items.map((item) => ({ total: calcLineTotal(item) })),
            totals.totalTax,
            totals.afterDiscount,
          )
        : null,
    [state.taxEnabled, state.items, totals.totalTax, totals.afterDiscount],
  );

  // idempotency (F3): مفتاح ثابت لكل محاولة إنشاء يُرسَل ضمن الحمولة ⇒ النقر المزدوج/إعادة
  // الشبكة لا تُنشئ عرضين (الراوتر/الخدمة يُعيدان الأول). يُجدَّد بعد كل حفظ ناجح/تفريغ.
  const [clientRequestId, setClientRequestId] = useState<string>(() => crypto.randomUUID());

  const [bulkOpen, setBulkOpen] = useState(false);
  const [pasteAvailable, setPasteAvailable] = useState(() => !isEdit && hasInvoiceTransfer());
  const [savedQuotationId, setSavedQuotationId] = useState<number | null>(null);
  const printAfterSaveRef = useRef(false);
  const shareAfterSaveRef = useRef(false);

  // التكلفة حساسة — نفس دالة الخادم/الشاشات الأخرى (canSeeCost، لا مقارنة دور خام) كي لا تنحرف
  // شاشةٌ عن أخرى في تعريف «مَن يرى التكلفة» (نمط SalesReport.tsx). الراوتر يعيد null لبقية الأدوار.
  const showCost = me.data ? canSeeCost(me.data.role) : true;

  const create = trpc.quotations.create.useMutation({
    onSuccess: (r) => {
      utils.quotations.list.invalidate();
      notify.ok("تم حفظ عرض السعر");
      const id = (r as { quotationId: number }).quotationId;
      setSavedQuotationId(id);
      const printAfterSave = printAfterSaveRef.current;
      const shareAfterSave = shareAfterSaveRef.current;
      printAfterSaveRef.current = false;
      shareAfterSaveRef.current = false;
      bypassUnsavedGuard();
      navigate(`/quotations/${id}${printAfterSave ? "?print=1" : shareAfterSave ? "?share=1" : ""}`);
    },
    onError: (e) => {
      releaseReservedPrintWindow();
      printAfterSaveRef.current = false;
      shareAfterSaveRef.current = false;
      notify.err(e);
    },
  });

  const update = trpc.quotations.update.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        utils.quotations.list.invalidate(),
        utils.quotations.get.invalidate({ quotationId: result.quotationId }),
      ]);
      notify.ok("تم تحديث مسوّدة عرض السعر");
      const printAfterSave = printAfterSaveRef.current;
      const shareAfterSave = shareAfterSaveRef.current;
      printAfterSaveRef.current = false;
      shareAfterSaveRef.current = false;
      bypassUnsavedGuard();
      navigate(`/quotations/${result.quotationId}${printAfterSave ? "?print=1" : shareAfterSave ? "?share=1" : ""}`);
    },
    onError: (e) => {
      releaseReservedPrintWindow();
      printAfterSaveRef.current = false;
      shareAfterSaveRef.current = false;
      notify.err(e);
    },
  });

  const convert = trpc.quotations.convert.useMutation({
    onSuccess: (r) => {
      utils.sales.list.invalidate();
      utils.quotations.list.invalidate();
      notify.ok("تم تحويل العرض إلى فاتورة بيع");
      const invoiceId = (r as { invoiceId: number }).invoiceId;
      bypassUnsavedGuard();
      navigate(`/invoices/${invoiceId}`);
    },
    onError: (e) => notify.err(e),
  });

  /** يبني payload عرض السعر بأموال نصّية (decimal.js) — لا parseFloat. */
  function buildPayload() {
    // #10 (تدقيق التثبيت): كانت الأزرار تُظهر «الخصم الكلّي/الضريبة» في TotalsPanel ويتحقّق منها
    // calcTotals، لكن buildPayload يُسقطها صامتاً ⇒ الإجمالي المطبوع/المحوَّل > الإجمالي المعروض
    // للعميل. الخادم يقبلهما (quotationRouter.create). ملاحظة: shipping/otherExpenses يبقيان
    // معروضَين فقط (لا أعمدة مماثلة في مخطّط الفاتورة) — نطاق منفصل يحتاج تغيير مخطّط.
    const totals = calcTotals(state.items, state);
    return {
      branchId: state.branchId,
      customerId: state.entityId ?? undefined,
      priceTier: state.tier,
      validUntil: state.validUntil || undefined,
      notes: composeDocumentNotes({ notes: state.notes, terms: state.terms }),
      storefrontQuoteRequestId: sourceQuoteRequestId ?? undefined,
      clientRequestId,
      invoiceDiscount: D(totals.globalDiscAmt).gt(0) ? totals.globalDiscAmt : undefined,
      taxRatePercent: state.taxEnabled ? moneyInput(state.taxRatePercent).toFixed(2) : undefined,
      lines: state.items.map(buildQuotationLinePayload),
    };
  }

  /** تحقّق أعمالي قبل الإرسال. يُرجع رسالة عربية أو null إن صالح. */
  function validate(): string | null {
    if (!state.entityId) return "اختر العميل أولاً.";
    if (state.items.length === 0) return "أضف منتجاً واحداً على الأقل.";
    for (const l of state.items) {
      if (!moneyInput(l.qty).gt(0)) return `الكمية في «${l.name}» يجب أن تكون موجبة.`;
      if (!isCompleteNonNegativeMoneyInput(l.price, { allowEmpty: false }))
        return `السعر في «${l.name}» غير صالح.`;
      if (!isCompleteNonNegativeMoneyInput(l.discount, { allowEmpty: true }))
        return `الخصم في «${l.name}» غير صالح.`;
    }
    if (!isCompleteNonNegativeMoneyInput(state.globalDiscount, { allowEmpty: true }))
      return "الخصم الإجمالي غير صالح.";
    if (
      state.taxEnabled &&
      !isCompleteNonNegativeMoneyInput(state.taxRatePercent, { allowEmpty: true })
    )
      return "نسبة الضريبة غير صالحة.";
    const totals = calcTotals(state.items, state);
    if (D(totals.grandTotal).lt(0)) return "الإجمالي النهائي لا يمكن أن يكون سالباً.";
    return null;
  }

  function handleSubmit() {
    const err = validate();
    if (err) {
      releaseReservedPrintWindow();
      printAfterSaveRef.current = false;
      shareAfterSaveRef.current = false;
      notify.warn(err);
      return;
    }
    const payload = buildPayload();
    if (isEdit) {
      const { branchId: _branchId, clientRequestId: _clientRequestId, ...editable } = payload;
      update.mutate({ quotationId: Number(editQuotationId), ...editable });
    } else {
      create.mutate(payload);
    }
  }

  async function handleConvert() {
    if (!savedQuotationId) {
      notify.warn("احفظ عرض السعر أولاً ثم اضغط «تحويل لفاتورة».");
      return;
    }
    if (
      !(await confirm({
        variant: "danger",
        title: "تحويل العرض إلى فاتورة",
        description: `سيُحوَّل عرض السعر رقم ${savedQuotationId} إلى فاتورة بيع نهائية تؤثر على المخزون والذمم. لا يمكن التراجع. هل تريد المتابعة؟`,
        confirmText: "تحويل",
      }))
    )
      return;
    convert.mutate({ quotationId: savedQuotationId });
  }

  function handleReset() {
    if (isEdit) {
      editHydratedRef.current = false;
      void editQuery.refetch();
      return;
    }
    dispatch({ type: "RESET", invoiceType: INVOICE_TYPE });
    setClientRequestId(crypto.randomUUID());
    setSavedQuotationId(null);
  }

  function handleAction(action: InvoiceActionKind) {
    switch (action) {
      case "save":
        releaseReservedPrintWindow();
        printAfterSaveRef.current = false;
        shareAfterSaveRef.current = false;
        handleSubmit();
        break;
      case "draft":
        releaseReservedPrintWindow();
        printAfterSaveRef.current = false;
        shareAfterSaveRef.current = false;
        // لا حفظ جزئي في الراوتر حالياً — نحفظ ونضع الحالة SENT لاحقاً عبر setStatus إن لزم.
        handleSubmit();
        break;
      case "print":
        reservePrintWindow();
        printAfterSaveRef.current = true;
        shareAfterSaveRef.current = false;
        handleSubmit();
        break;
      case "send":
        releaseReservedPrintWindow();
        printAfterSaveRef.current = false;
        shareAfterSaveRef.current = true;
        handleSubmit();
        break;
      case "pdf":
        // قالب A4 المعتمد يتيح اختيار "Save as PDF" من حوار الطباعة.
        reservePrintWindow();
        printAfterSaveRef.current = true;
        shareAfterSaveRef.current = false;
        handleSubmit();
        break;
      case "convert":
        handleConvert();
        break;
      case "duplicate":
        if (!state.items.length) return notify.warn("لا توجد محتويات لنسخها.");
        copyInvoiceItems(state.items);
        dispatch({ type: "CLEAR_ITEMS" });
        setPasteAvailable(true);
        notify.ok("تم نسخ المنتجات وتفريغ عرض السعر. ستجد «لصق» في أي فاتورة تفتحها.");
        break;
      case "paste": {
        const items = takeInvoiceItems();
        if (!items) {
          setPasteAvailable(false);
          notify.warn("لا توجد محتويات صالحة للصقها.");
          break;
        }
        dispatch({ type: "ADD_ITEMS", items });
        dispatch({ type: "MARK_STOCK_STALE" });
        setPasteAvailable(false);
        notify.ok("تم لصق محتويات الفاتورة.");
        break;
      }
      case "return":
        notify.info("المرتجع غير متاح من عرض السعر.");
        break;
    }
  }

  /* اختصارات لوحة المفاتيح. */
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) =>
      !!el && (el as HTMLElement).matches?.("input, textarea, select, [contenteditable='true']");

    const onKey = (e: KeyboardEvent) => {
      // F2: التركيز على بحث المنتجات (يقع داخل ProductTable).
      if (e.key === "F2") {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>("input[aria-label='بحث المنتجات']");
        input?.focus();
        return;
      }
      // F4: حفظ.
      if (e.key === "F4") {
        e.preventDefault();
        releaseReservedPrintWindow();
        printAfterSaveRef.current = false;
        shareAfterSaveRef.current = false;
        handleSubmit();
        return;
      }
      // F9: طباعة.
      if (e.key === "F9") {
        e.preventDefault();
        reservePrintWindow();
        printAfterSaveRef.current = true;
        shareAfterSaveRef.current = false;
        handleSubmit();
        return;
      }
      // F12: تفريغ كامل وإعادة تهيئة.
      if (e.key === "F12") {
        e.preventDefault();
        handleReset();
        return;
      }
      // Esc: عند عدم الكتابة، أرجع إلى قائمة العروض.
      if (e.key === "Escape" && !isTypingTarget(e.target) && !bulkOpen) {
        e.preventDefault();
        navigate("/quotations");
        return;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // عمداً نعيد التسجيل عند تغيّر السلة/الحالة لضمان التقاط أحدث closure.
  }, [state, bulkOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const typeInfo = INVOICE_TYPES[INVOICE_TYPE];
  const isSaving = create.isPending || update.isPending || convert.isPending;

  // مؤشّر اختياري: إن لم يكن هناك سعر صالح في أي بند، نبيّن للمستخدم.
  const hasZeroPriceLine = useMemo(
    () =>
      state.items.some(
        (l) => !isCompleteNonNegativeMoneyInput(l.price, { allowEmpty: false }) || moneyInput(l.price).lte(0),
      ),
    [state.items]
  );

  // اختصار Ctrl+S للحفظ (نمط ExpenseNew.tsx — Esc متروك عمداً، النموذج مكتظّ بقوائم اختيار أصلية
  // يُغلقها Esc أصلاً) — نفس مسار زرّ «حفظ» (case "save" في handleAction) حرفياً: يلغي أي نافذة
  // طباعة محجوزة سابقاً قبل حفظٍ عادي. + حارس فقد البيانات عند وجود إدخال فعليّ فقط.
  useSaveShortcuts({
    onSave: () => {
      releaseReservedPrintWindow();
      printAfterSaveRef.current = false;
      shareAfterSaveRef.current = false;
      handleSubmit();
    },
    enabled: !isSaving,
  });
  useUnsavedGuard(state.items.length > 0 || state.entityId != null || state.notes.trim() !== "" || Boolean(state.terms?.trim()));

  if (isEdit && editQuery.isLoading) {
    return <div className="p-10 text-center text-muted-foreground">جارٍ تحميل مسوّدة عرض السعر…</div>;
  }
  if (!isEdit && sourceQuoteRequestId != null && sourceQuoteRequest.isLoading) {
    return <div className="p-10 text-center text-muted-foreground">جارٍ تجهيز طلب عرض السعر للمراجعة…</div>;
  }
  if (!isEdit && sourceQuoteRequestId != null && sourceQuoteRequest.isError) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-10 text-center">
        <AlertTriangle aria-hidden className="size-8 text-destructive" />
        <p className="font-semibold text-foreground">تعذّر تجهيز العرض الرسمي من طلب المتجر.</p>
        <p className="max-w-lg text-sm text-muted-foreground">تأكد أن الطلب تمت مراجعته وتسجيل التواصل معه، ثم أعد المحاولة من طابور المتجر.</p>
        <Link className="rounded-md border bg-card px-4 py-2 text-sm font-semibold hover:bg-muted" href="/store?tab=quote-requests">العودة إلى طلبات عروض الأسعار</Link>
      </div>
    );
  }
  if (isEdit && editQuery.isError) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-10 text-center">
        <AlertTriangle aria-hidden className="size-8 text-destructive" />
        <p className="font-semibold text-foreground">تعذر تحميل عرض السعر.</p>
        <p className="max-w-lg text-sm text-muted-foreground">
          حدث خطأ أثناء جلب بيانات العرض. أعد المحاولة، وإن استمر الخطأ تواصل مع مسؤول النظام.
        </p>
        <button
          type="button"
          className="rounded-md border bg-card px-4 py-2 text-sm font-semibold hover:bg-muted"
          onClick={() => void editQuery.refetch()}
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }
  if (isEdit && !editQuery.data) {
    return <div className="p-10 text-center text-muted-foreground">عرض السعر غير موجود.</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      {/* شريط العنوان */}
      <PageHeader
        icon={(() => { const TIcon = typeInfo.icon; return <TIcon aria-hidden className="size-5 text-primary" />; })()}
        title={isEdit ? `تعديل ${typeInfo.label}` : `${typeInfo.label} جديد`}
        backHref="/quotations"
        backLabel="رجوع للعروض"
        actions={
          <span className="hidden text-xs font-semibold text-muted-foreground sm:inline">
            الإجمالي:{" "}
            <span className="font-extrabold text-foreground" dir="ltr">{totals.grandTotal}</span>{" "}
            د.ع
          </span>
        }
      />

      {!isEdit && sourceQuoteRequest.data && (
        <div className="space-y-2 rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-xs leading-5 text-foreground">
          <div>
            <span className="font-semibold">عرض رسمي من الطلب {sourceQuoteRequest.data.requestNumber}.</span>{" "}
            راجع الأسعار والكميات والتوفر قبل الحفظ؛ لا يحجز هذا العرض مخزوناً ولا يصدر فاتورة.
          </div>
          {sourceQuoteRequest.data.customizationAttachments &&
            sourceQuoteRequest.data.customizationAttachments.length > 0 && (
              <div className="space-y-1.5 border-t border-primary/20 pt-1.5">
                <div className="font-semibold">مرفقات التخصيص المرفوعة من العميل:</div>
                {sourceQuoteRequest.data.customizationAttachments.map((att, idx) => (
                  <div key={`${att.productUnitId}-${idx}`} className="space-y-0.5">
                    <div>
                      {att.productName}
                      {att.variantLabel ? ` — ${att.variantLabel}` : ""} · {formatQuantity(att.quantity)} {att.unitName}
                      {att.summary ? ` (${att.summary})` : ""}
                    </div>
                    <OrderCustomizationAssets
                      previewAssetUrl={att.previewAssetUrl}
                      logoAssetUrl={att.logoAssetUrl}
                      productName={att.productName}
                      compact
                    />
                  </div>
                ))}
              </div>
            )}
        </div>
      )}

      {/* رأس الفاتورة (بيانات المستند + العميل + الشروط + «صالح حتى» يظهر تلقائياً للنوع QUOTATION) */}
      <InvoiceHeader
        state={state}
        dispatch={dispatch}
        invoiceType={INVOICE_TYPE}
        pricingIntentEpoch={pricingIntentEpochRef.current}
      />

      {/* تنبيه ناعم لبنود بسعر صفر/سالب */}
      {hasZeroPriceLine && (
        <div className="badge-stock-low flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold">
          <AlertTriangle aria-hidden className="size-4" />
          هناك بنود بسعر غير صالح — صحّحها قبل الحفظ.
        </div>
      )}

      {/* البنية الأساسية: جدول البنود + لوحة الإجماليات والإجراءات — تدفّق طبيعي بلا حبس ارتفاع */}
      <div className="flex flex-col gap-2.5 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-2 h-[62vh] min-h-[380px] print:h-auto print:min-h-fit">
          <ProductTable
            items={state.items}
            dispatch={dispatch}
            branchId={state.branchId}
            tier={state.tier}
            customerId={state.entityId}
            pricingIntentEpoch={pricingIntentEpochRef.current}
            invoiceType={INVOICE_TYPE}
            showCost={showCost}
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
            customerId={state.entityId}
          />
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-1.5 xl:w-72">
          <TotalsPanel
            items={state.items}
            state={state}
            dispatch={dispatch}
            showTaxToggle
            showShipping={false}
            showOtherExpenses={false}
            showPayment={false}
          />
          <div className="sticky bottom-0 z-10 bg-background/95 backdrop-blur pt-1.5 border-t">
            <ActionButtons
              invoiceType={INVOICE_TYPE}
              items={state.items}
              saving={isSaving}
              pasteAvailable={!isEdit && pasteAvailable}
              onAction={handleAction}
            />
          </div>
          <TermsAndNotes state={state} dispatch={dispatch} />
        </aside>
      </div>

      <ShortcutsBar />
    </div>
  );
}
