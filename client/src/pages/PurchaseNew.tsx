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
import { D, round2, toBase } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import {
  ActionButtons,
  BulkPicker,
  INVOICE_TYPES,
  InvoiceHeader,
  ProductTable,
  ShortcutsBar,
  TermsAndNotes,
  TotalsPanel,
  calcTotals,
  createInitialState,
  invoiceReducer,
  type InvoiceActionKind,
} from "@/components/invoice";

const INVOICE_TYPE = "PURCHASE" as const;

export default function PurchaseNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

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

  /* ─── client-side idempotency token ────────────────────────────── */
  // معرّف العميل للطلب — جاهز للمستقبل (الراوتر الحالي لا يستهلكه؛ يُحفظ في memory للجلسة).
  const [clientRequestId] = useState(() => crypto.randomUUID());

  /* ─── bulk picker overlay ──────────────────────────────────────── */
  const [bulkOpen, setBulkOpen] = useState(false);

  /* ─── mutation ─────────────────────────────────────────────────── */
  const create = trpc.purchases.createOrder.useMutation({
    onSuccess: async (r) => {
      await utils.purchases.list.invalidate();
      notify.ok("تم إنشاء أمر الشراء — انتقال للاستلام");
      navigate(`/purchases/${r.purchaseOrderId}/receive`);
    },
    onError: (e) => notify.err(e),
  });

  /* ─── validation + submit ──────────────────────────────────────── */
  const totals = useMemo(() => calcTotals(state.items, state), [state]);

  function validate(): string | null {
    if (!state.entityId) return "اختر المورد قبل الحفظ.";
    if (!state.branchId) return "اختر الفرع.";
    if (state.items.length === 0) return "أضف منتجاً واحداً على الأقل.";
    for (const l of state.items) {
      const qty = D(l.qty);
      if (!qty.gt(0)) return `الكمية في «${l.name}» يجب أن تكون موجبة.`;
      const price = D(l.price);
      if (price.lt(0)) return `سعر الشراء في «${l.name}» غير صالح.`;
      const base = toBase(l.qty, l.conversionFactor);
      if (!base.isInteger())
        return `الكمية في «${l.name}» تنتج كسراً بالوحدة الأساس (${l.qty} × ${l.conversionFactor}).`;
    }
    // usd-po-reconcile: عند اختيار الدولار، مبلغ فاتورة المورد الفعلية إلزامي وموجب.
    if (state.currency === "USD" && !(D(state.usdTotal).gt(0))) {
      return "أدخل مبلغ فاتورة المورد بالدولار.";
    }
    return null;
  }

  function handleSubmit() {
    const err = validate();
    if (err) {
      notify.warn(err);
      return;
    }
    create.mutate({
      supplierId: state.entityId!,
      branchId: state.branchId,
      // الضريبة في العراق 0% افتراضياً — لا حقل ضريبة في الواجهة الجديدة، نعتمد الافتراضي.
      taxRatePercent: "0",
      status: "CONFIRMED",
      // IDEMPOTENCY (تدقيق ٢/٧): كان المفتاح يُولَّد ويُعلَّق في DOM مخفيّ فقط ولا يُرسَل ⇒ النقر
      // المزدوج يُنشئ أمرَي شراء. الآن نمرّره في الحمولة فيَحرس الخادم من الازدواج.
      clientRequestId,
      notes: state.notes.trim() || undefined,
      // usd-po-reconcile: مبلغ فاتورة المورد الفعلية بالدولار (إعلامي — لا يمسّ الإجمالي الديناري).
      agreedCurrency: state.currency,
      usdTotal: state.currency === "USD" ? round2(D(state.usdTotal)).toFixed(2) : undefined,
      items: state.items.map((l) => ({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        // الكمية بنفس الوحدة المختارة (الخادم يضرب × conversionFactor للحصول على base).
        quantity: D(l.qty).toString(),
        // سعر الشراء بالوحدة (price = costBase × convFactor عند الإضافة، قابل للتعديل).
        unitPrice: round2(D(l.price)).toFixed(2),
      })),
    });
  }

  function handleSaveDraft() {
    // الراوتر يدعم status=DRAFT لكنّ المتطلب الأساسي «CONFIRMED». نوحّد التحذير الآن.
    notify.info("حفظ المسوّدات سيُفعَّل لاحقاً — استخدم «حفظ واعتماد».");
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
      case "send":
      case "pdf":
      case "duplicate":
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkOpen, create.isPending, state]);

  /* ─── render ───────────────────────────────────────────────────── */
  const meta = INVOICE_TYPES[INVOICE_TYPE];

  return (
    <div ref={containerRef} dir="rtl" className="flex h-full flex-col gap-3">
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
              {totals.grandTotal}
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

      {/* Body: products on the right, totals/actions/terms on the left (RTL → aside on left) */}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <ProductTable
            items={state.items}
            dispatch={dispatch}
            branchId={state.branchId}
            tier={state.tier}
            invoiceType={INVOICE_TYPE}
            showCost={true}
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
            onAction={handleAction}
            saving={create.isPending}
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
