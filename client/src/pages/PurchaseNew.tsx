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
import { D, fmtAr, round2, toBase } from "@/lib/money";
import { MoneyInput } from "@/components/form/MoneyInput";
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

  // landed-cost: الإجماليّ يشمل الشحن/الكمرك (يُوزَّعان بنسبة القيمة). التوزيع بالقيمة = نسبة رفعٍ
  // موحّدة على كلّ تكلفة وحدة: capUnit = price × (subtotal + شحن + كمرك) / subtotal. للمعاينة فقط.
  const landed = useMemo(() => {
    const sum = round2(D(shippingCost).plus(D(customsCost)));
    const subtotalD = D(totals.subtotal);
    const grand = round2(D(totals.grandTotal).plus(sum));
    const uplift = subtotalD.gt(0) ? subtotalD.plus(sum).dividedBy(subtotalD) : D(1);
    return { sum, grand, uplift, hasLanded: sum.gt(0), hasBase: subtotalD.gt(0) };
  }, [shippingCost, customsCost, totals.subtotal, totals.grandTotal]);

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
    // landed-cost: التوزيع بنسبة القيمة يحتاج قيمة بضاعة موجبة (مرآة حارس الخادم).
    if (landed.hasLanded && !landed.hasBase) {
      return "أضِف أصنافاً بقيمة موجبة قبل إدخال تكلفة الشحن/الكمرك.";
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
      // landed-cost: الشحن/الكمرك (تُرسَل فقط إن كانت موجبة — الخادم يوزّعها بنسبة القيمة ويُرسمِلها).
      shippingCost: D(shippingCost).gt(0) ? round2(D(shippingCost)).toFixed(2) : undefined,
      customsCost: D(customsCost).gt(0) ? round2(D(customsCost)).toFixed(2) : undefined,
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
                  <div className="mb-1.5 font-bold text-foreground">التكلفة المُرسمَلة لكلّ وحدة (توزيع بنسبة القيمة)</div>
                  <ul className="space-y-1">
                    {state.items.map((l, i) => (
                      <li key={i} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-muted-foreground">{l.name}</span>
                        <span dir="ltr" className="shrink-0 font-bold tabular-nums">
                          {fmtAr(round2(D(l.price).times(landed.uplift)).toFixed(2))}
                          <span className="font-normal text-muted-foreground">{" "}(من {fmtAr(l.price)})</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-1.5 border-t pt-1.5 text-[11px] text-muted-foreground">
                    تُضاف إلى ذمّة المورّد وتظهر في تكلفة البضاعة — لا كمصروف مستقلّ.
                  </div>
                </div>
              )}
              {landed.hasLanded && !landed.hasBase && (
                <p className="text-[11px] font-semibold text-amber-600">
                  أضِف أصنافاً بقيمة موجبة لتوزيع الشحن/الكمرك عليها.
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
            showDiscount={false}
            showPayment={false}
            overrideGrandTotal={landed.grand.toFixed(2)}
          />
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
