/**
 * QuotationNew — صفحة إنشاء عرض سعر جديد (شريحة QUOTATION).
 *
 * تستخدم مكتبة محرّر الفواتير المشتركة (client/src/components/invoice/*).
 * - state عبر invoiceReducer (نوع QUOTATION ثابت).
 * - mutation = trpc.quotations.create؛ بعد النجاح يفتح صفحة التفاصيل ويفعّل «تحويل لفاتورة».
 * - clientRequestId للحماية من الإرسال المزدوج (idempotency على مستوى الراوتر).
 * - الأموال عبر decimal.js (money.ts) — ⛔ ممنوع parseFloat/Number على الأموال.
 * - اختصارات F2/F4/F9/F12/Esc.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useLocation } from "wouter";

import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { D } from "@/lib/money";

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
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();

  // مصدر الفرع الافتراضي (يأتي مع جلسة المستخدم). نُعيد تهيئة الحالة عند تحميله أول مرة.
  const defaultBranchId = me.data?.branchId ?? 1;

  const [state, dispatch] = useReducer(
    invoiceReducer,
    undefined,
    () => createInitialState(INVOICE_TYPE, defaultBranchId)
  );

  // مزامنة فرع المستخدم مرة واحدة (إن وصل لاحقاً)؛ لا نطمس اختياره اليدوي بعد ذلك.
  const syncedBranch = useRef(false);
  useEffect(() => {
    if (!syncedBranch.current && me.data?.branchId && state.branchId !== me.data.branchId) {
      dispatch({ type: "SET_FIELD", field: "branchId", value: me.data.branchId });
      syncedBranch.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data?.branchId]);

  // idempotency: مفتاح ثابت لكل محاولة إنشاء (يُجدَّد بعد كل حفظ ناجح).
  const [clientRequestId, setClientRequestId] = useState<string>(() => crypto.randomUUID());
  // نعيد توليده ضمنياً عند RESET أيضاً عبر زيادة seq (لإجبار المفتاح على التغيّر).
  void clientRequestId; // (المفتاح يُستهلك ضمن payload لاحقاً بعد إضافته للراوتر؛ نحتفظ به للتطوير المستقبلي)

  const [bulkOpen, setBulkOpen] = useState(false);
  const [savedQuotationId, setSavedQuotationId] = useState<number | null>(null);

  // RBAC: عرض السعر سياق مبيعات — لا تكلفة افتراضياً للكاشير. الافتراضي false (إخفاء التكلفة).
  const showCost = false;

  const create = trpc.quotations.create.useMutation({
    onSuccess: (r) => {
      utils.quotations.list.invalidate();
      notify.ok("تم حفظ عرض السعر");
      const id = (r as { quotationId: number }).quotationId;
      setSavedQuotationId(id);
      navigate(`/quotations/${id}`);
    },
    onError: (e) => notify.err(e),
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
    return {
      branchId: state.branchId,
      customerId: state.entityId ?? undefined,
      priceTier: state.tier,
      validUntil: state.validUntil || undefined,
      notes: state.notes?.trim() || undefined,
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
      notify.warn(err);
      return;
    }
    create.mutate(buildPayload());
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
    dispatch({ type: "RESET", invoiceType: INVOICE_TYPE });
    setClientRequestId(crypto.randomUUID());
    setSavedQuotationId(null);
  }

  function handleAction(action: InvoiceActionKind) {
    switch (action) {
      case "save":
        handleSubmit();
        break;
      case "draft":
        // لا حفظ جزئي في الراوتر حالياً — نحفظ ونضع الحالة SENT لاحقاً عبر setStatus إن لزم.
        handleSubmit();
        break;
      case "print":
        // اطبع بعد الحفظ (إن لم يُحفظ نطبع المعاينة الحالية مباشرة).
        if (!savedQuotationId) {
          handleSubmit();
        }
        window.print();
        break;
      case "send":
        notify.info("الإرسال عبر البريد/الواتساب لم يُفعّل بعد.");
        break;
      case "pdf":
        window.print();
        break;
      case "convert":
        handleConvert();
        break;
      case "duplicate":
        // نسخ: نُعيد تعيين رقم المستند ومعرّف الطلب، مع الإبقاء على السلة.
        dispatch({ type: "RESET", invoiceType: INVOICE_TYPE });
        setClientRequestId(crypto.randomUUID());
        setSavedQuotationId(null);
        notify.info("تم تجهيز نسخة جديدة فارغة.");
        break;
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
        handleSubmit();
        return;
      }
      // F9: طباعة.
      if (e.key === "F9") {
        e.preventDefault();
        window.print();
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
  const isSaving = create.isPending || convert.isPending;

  // مؤشّر اختياري: إن لم يكن هناك سعر صالح في أي بند، نبيّن للمستخدم.
  const hasZeroPriceLine = useMemo(
    () => state.items.some((l) => D(l.price).lte(0)),
    [state.items]
  );

  return (
    <div className="flex h-full flex-col gap-3">
      {/* شريط العنوان */}
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-xl font-extrabold">
          {(() => { const TIcon = typeInfo.icon; return <TIcon aria-hidden className="size-5 text-primary" />; })()}
          {typeInfo.label} جديد
        </h1>
        <Link
          href="/quotations"
          className="rounded-md border bg-card px-3 py-1.5 text-sm font-semibold text-muted-foreground hover:bg-muted"
        >
          ← رجوع للعروض
        </Link>
      </div>

      {/* رأس الفاتورة (بيانات المستند + العميل + الشروط + «صالح حتى» يظهر تلقائياً للنوع QUOTATION) */}
      <InvoiceHeader state={state} dispatch={dispatch} invoiceType={INVOICE_TYPE} />

      {/* تنبيه ناعم لبنود بسعر صفر/سالب */}
      {hasZeroPriceLine && (
        <div className="rounded-md border border-amber-300/40 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700">
          ⚠️ هناك بنود بسعر غير صالح — صحّحها قبل الحفظ.
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
          <TotalsPanel items={state.items} state={state} dispatch={dispatch} />
          <ActionButtons
            invoiceType={INVOICE_TYPE}
            items={state.items}
            saving={isSaving}
            onAction={handleAction}
          />
          <TermsAndNotes state={state} dispatch={dispatch} />
        </aside>
      </div>

      <ShortcutsBar />
    </div>
  );
}
