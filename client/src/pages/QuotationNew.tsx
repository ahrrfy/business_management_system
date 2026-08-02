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
import { Link, useLocation, useParams } from "wouter";
import { AlertTriangle } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { D } from "@/lib/money";
import { PageHeader } from "@/components/PageHeader";
import { copyInvoiceItems, hasInvoiceTransfer, takeInvoiceItems } from "@/lib/invoiceTransfer";
import { releaseReservedPrintWindow, reservePrintWindow } from "@/lib/printing/brand";

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
  INVOICE_TYPES,
  type InvoiceActionKind,
} from "@/components/invoice";

const INVOICE_TYPE = "QUOTATION" as const;

export default function QuotationNew() {
  const [, navigate] = useLocation();
  const params = useParams<{ id?: string }>();
  const editQuotationId = params.id ? Number(params.id) : null;
  const isEdit = Number.isInteger(editQuotationId) && Number(editQuotationId) > 0;
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const editQuery = trpc.quotations.get.useQuery(
    { quotationId: isEdit ? Number(editQuotationId) : 1 },
    { enabled: isEdit },
  );

  // مصدر الفرع الافتراضي (يأتي مع جلسة المستخدم). نُعيد تهيئة الحالة عند تحميله أول مرة.
  const defaultBranchId = me.data?.branchId ?? 1;

  const [state, dispatch] = useReducer(
    invoiceReducer,
    undefined,
    () => createInitialState(INVOICE_TYPE, defaultBranchId)
  );

  const taxDefaultsAppliedRef = useRef(false);
  const editHydratedRef = useRef(false);
  useEffect(() => {
    const quotation = editQuery.data;
    if (!isEdit || !quotation || editHydratedRef.current) return;
    if (quotation.status !== "DRAFT") {
      notify.warn("لا يمكن تعديل عرض السعر بعد إرساله — أنشئ نسخة جديدة.");
      navigate(`/quotations/${quotation.id}`);
      return;
    }
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
        notes: quotation.notes ?? "",
        globalDiscount: quotation.discountAmount ?? "0",
        globalDiscountType: "amount",
        taxEnabled: D(quotation.taxRatePercent ?? "0").gt(0),
        taxRatePercent: quotation.taxRatePercent ?? "0",
        items: quotation.items.map((item) => ({
          productId: Number(item.productId),
          variantId: Number(item.variantId),
          productUnitId: Number(item.productUnitId),
          name: [item.productName, item.variantName].filter(Boolean).join(" — "),
          sku: item.sku ?? "",
          barcode: item.barcode ?? null,
          unit: item.unitName ?? "",
          qty: Number(item.quantity),
          conversionFactor: item.conversionFactor ?? "1",
          stockBase: 0,
          price: item.unitPrice,
          // في المسودة المحفوظة نعرض التكلفة الحالية للمدير/الأدمن؛ الراوتر لا يرسلها للكاشير.
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

  // idempotency (F3): مفتاح ثابت لكل محاولة إنشاء يُرسَل ضمن الحمولة ⇒ النقر المزدوج/إعادة
  // الشبكة لا تُنشئ عرضين (الراوتر/الخدمة يُعيدان الأول). يُجدَّد بعد كل حفظ ناجح/تفريغ.
  const [clientRequestId, setClientRequestId] = useState<string>(() => crypto.randomUUID());

  const [bulkOpen, setBulkOpen] = useState(false);
  const [pasteAvailable, setPasteAvailable] = useState(() => !isEdit && hasInvoiceTransfer());
  const [savedQuotationId, setSavedQuotationId] = useState<number | null>(null);
  const printAfterSaveRef = useRef(false);
  const shareAfterSaveRef = useRef(false);

  // RBAC: عرض السعر سياق مبيعات — المدير/الأدمن يرى التكلفة والهامش، والكاشير لا يتلقاها من API.
  const showCost = me.data?.role === "manager" || me.data?.role === "admin";

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
      notify.ok("تم تحديث مسودة عرض السعر");
      const printAfterSave = printAfterSaveRef.current;
      const shareAfterSave = shareAfterSaveRef.current;
      printAfterSaveRef.current = false;
      shareAfterSaveRef.current = false;
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
      notes: state.notes?.trim() || undefined,
      clientRequestId,
      invoiceDiscount: D(totals.globalDiscAmt).gt(0) ? totals.globalDiscAmt : undefined,
      taxRatePercent: state.taxEnabled ? D(state.taxRatePercent || "0").toFixed(2) : undefined,
      lines: state.items.map((l) => ({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        quantity: D(l.qty).toString(),
        unitPriceOverride: D(l.price).toFixed(2),
        discountPercent: l.discountType === "percent" ? D(l.discount || "0").toFixed(2) : undefined,
        discountAmount: l.discountType === "amount" ? D(l.discount || "0").toFixed(2) : undefined,
      })),
    };
  }

  /** تحقّق أعمالي قبل الإرسال. يُرجع رسالة عربية أو null إن صالح. */
  function validate(): string | null {
    if (!state.entityId) return "اختر العميل أولاً.";
    if (state.items.length === 0) return "أضف منتجاً واحداً على الأقل.";
    for (const l of state.items) {
      if (!D(l.qty).gt(0)) return `الكمية في «${l.name}» يجب أن تكون موجبة.`;
      if (D(l.price).lt(0)) return `السعر في «${l.name}» غير صالح.`;
    }
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
        notify.ok("تم نسخ الأصناف وتفريغ عرض السعر. ستجد «لصق» في أي فاتورة تفتحها.");
        break;
      case "paste": {
        const items = takeInvoiceItems();
        if (!items) {
          setPasteAvailable(false);
          notify.warn("لا توجد محتويات صالحة للصقها.");
          break;
        }
        dispatch({ type: "ADD_ITEMS", items });
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
    () => state.items.some((l) => D(l.price).lte(0)),
    [state.items]
  );

  if (isEdit && editQuery.isLoading) {
    return <div className="p-10 text-center text-muted-foreground">جارٍ تحميل مسودة عرض السعر…</div>;
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
    <div className="flex h-full flex-col gap-3">
      {/* شريط العنوان */}
      <PageHeader
        icon={(() => { const TIcon = typeInfo.icon; return <TIcon aria-hidden className="size-5 text-primary" />; })()}
        title={isEdit ? `تعديل ${typeInfo.label}` : `${typeInfo.label} جديد`}
        actions={
          <Link
            href="/quotations"
            className="rounded-md border bg-card px-3 py-1.5 text-sm font-semibold text-muted-foreground hover:bg-muted"
          >
            ← رجوع للعروض
          </Link>
        }
      />

      {/* رأس الفاتورة (بيانات المستند + العميل + الشروط + «صالح حتى» يظهر تلقائياً للنوع QUOTATION) */}
      <InvoiceHeader state={state} dispatch={dispatch} invoiceType={INVOICE_TYPE} />

      {/* تنبيه ناعم لبنود بسعر صفر/سالب */}
      {hasZeroPriceLine && (
        <div className="badge-stock-low flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold">
          <AlertTriangle aria-hidden className="size-4" />
          هناك بنود بسعر غير صالح — صحّحها قبل الحفظ.
        </div>
      )}

      {/* البنية الأساسية: جدول البنود يساراً + لوحة الإجماليات والإجراءات يميناً */}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <ProductTable
            items={state.items}
            dispatch={dispatch}
            branchId={state.branchId}
            tier={state.tier}
            invoiceType={INVOICE_TYPE}
            showCost={showCost}
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

        <aside className="flex w-80 shrink-0 flex-col gap-2">
          <TotalsPanel items={state.items} state={state} dispatch={dispatch} showTaxToggle />
          <ActionButtons
            invoiceType={INVOICE_TYPE}
            items={state.items}
            saving={isSaving}
            pasteAvailable={!isEdit && pasteAvailable}
            onAction={handleAction}
          />
          <TermsAndNotes state={state} dispatch={dispatch} />
        </aside>
      </div>

      <ShortcutsBar />
    </div>
  );
}
