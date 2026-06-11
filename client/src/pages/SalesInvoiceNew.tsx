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
 *   • تجاوز حدّ الائتمان ⇒ حوار موافقة مدير (بريد+كلمة مرور) ثم إعادة الإرسال مع managerApproval.
 *   • `showCost` يتبع الدور (مدير/أدمن = يرى التكلفة والهامش، كاشير = لا).
 *
 * الذرّية والأموال يتولاها الخادم (createSale ⇒ withTx + decimal.js). الواجهة هنا
 * لا تستخدم parseFloat/Number على الأموال (الجمع داخل calcTotals + decimal.js).
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useLocation } from "wouter";

import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { D, round2, toBase } from "@/lib/money";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  INVOICE_TYPES,
  type InvoiceActionKind,
  type InvoiceLine,
  type PriceTier,
} from "@/components/invoice";

const INVOICE_TYPE = "SALE" as const;

/** موافقة مدير لتجاوز حدّ الائتمان (بريد + كلمة مرور). */
type Approval = { email: string; password: string };

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
        items?: InvoiceLine[];
      };
      if (seed.customerId) dispatch({ type: "SET_ENTITY", id: seed.customerId });
      if (seed.tier) dispatch({ type: "SET_FIELD", field: "tier", value: seed.tier });
      if (Array.isArray(seed.items) && seed.items.length) dispatch({ type: "ADD_ITEMS", items: seed.items });
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

  // وردية مفتوحة للفرع (إن وُجدت) ⇒ تُسجَّل الدفعة النقدية في صندوق الوردية.
  const currentShift = trpc.shifts.current.useQuery(
    { branchId: state.branchId },
    { enabled: !!state.branchId }
  );

  // idempotency: مفتاح ثابت لكل محاولة إنشاء (يُجدَّد بعد كل حفظ ناجح / RESET).
  const [clientRequestId, setClientRequestId] = useState<string>(() => crypto.randomUUID());

  const [bulkOpen, setBulkOpen] = useState(false);

  // حوار موافقة المدير (يُفتح عند خطأ تجاوز حدّ الائتمان).
  const [creditPrompt, setCreditPrompt] = useState<string | null>(null);
  const [mgrEmail, setMgrEmail] = useState("");
  const [mgrPwd, setMgrPwd] = useState("");

  // RBAC: المدير/الأدمن يرى التكلفة والهامش؛ الكاشير لا.
  const role = me.data?.role;
  const showCost = role === "manager" || role === "admin";

  const totals = useMemo(() => calcTotals(state.items, state), [state]);

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
      navigate(`/invoices/${id}`);
    },
    onError: (e) => {
      // تجاوز حدّ الائتمان ⇒ افتح حوار موافقة المدير بدل إظهار خطأ فقط.
      // نطابق العبارة المميِّزة الكاملة «حدّ الائتمان» (لا «الائتمان» وحدها) لتفادي
      // الإيجابيات الكاذبة من رسائل أعمال أخرى تذكر «سقف الائتمان» مثلاً.
      if (e.message && e.message.includes("حدّ الائتمان")) {
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
        unitPriceOverride: round2(D(l.price)).toFixed(2),
        discountPercent: l.discountType === "percent" ? round2(D(l.discount || "0")).toFixed(2) : undefined,
        discountAmount: l.discountType === "amount" ? round2(D(l.discount || "0")).toFixed(2) : undefined,
      })),
      // خصم إجمالي كمبلغ (calcTotals يحوّل النسبة إلى مبلغ). يُرسَل فقط إن كان موجباً.
      invoiceDiscount: D(totals.globalDiscAmt).gt(0) ? totals.globalDiscAmt : undefined,
      // العراق VAT=0% افتراضياً — لا ضريبة على مستوى الفاتورة (وعمود ضريبة السطر مخفيّ في شاشة البيع).
      taxRatePercent: "0",
      payment: hasPayment ? { amount: paidStr, method: state.paymentMethod } : undefined,
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

  /** تحقّق أعمالي قبل الإرسال. يُرجع رسالة عربية أو null إن صالح. */
  function validate(): string | null {
    if (state.items.length === 0) return "أضف صنفاً واحداً على الأقل.";
    for (const l of state.items) {
      if (!D(l.qty).gt(0)) return `الكمية في «${l.name}» يجب أن تكون موجبة.`;
      if (D(l.price).lt(0)) return `السعر في «${l.name}» غير صالح.`;
      const base = toBase(l.qty, l.conversionFactor);
      if (!base.isInteger())
        return `الكمية في «${l.name}» تنتج كسراً بالوحدة الأساس (${l.qty} × ${l.conversionFactor}).`;
    }
    // مبلغ آجل (ذمة) يتطلّب عميلاً مُحدَّداً — يشمل «أقساط» بدون دفعة مقدّمة كاملة.
    const paid = D(computePaidStr());
    const remaining = D(totals.grandTotal).minus(paid);
    if (remaining.gt(0) && !state.entityId)
      return "هناك مبلغ آجل (ذمة) — اختر عميلاً لتسجيل الذمة عليه.";
    if (D(totals.grandTotal).lt(0)) return "الإجمالي النهائي لا يمكن أن يكون سالباً.";
    return null;
  }

  function handleSubmit(approval?: Approval) {
    // قيمة مالية غير رقمية (في المدفوع/الخصم) تجعل decimal.js يرمي — نلتقطها برسالة واضحة بدل تعطّل صامت.
    let err: string | null;
    try {
      err = validate();
    } catch {
      notify.warn("قيمة مالية غير صالحة — صحّح حقول المبالغ قبل الحفظ.");
      return;
    }
    if (err) {
      notify.warn(err);
      return;
    }
    try {
      create.mutate(buildPayload(approval));
    } catch {
      notify.warn("قيمة مالية غير صالحة — صحّح حقول المبالغ قبل الحفظ.");
    }
  }

  function handleReset() {
    dispatch({ type: "RESET", invoiceType: INVOICE_TYPE });
    setClientRequestId(crypto.randomUUID());
  }

  function handleApprove() {
    if (!mgrEmail.trim() || !mgrPwd.trim()) {
      notify.warn("أدخل بريد المدير وكلمة المرور للاعتماد.");
      return;
    }
    handleSubmit({ email: mgrEmail.trim(), password: mgrPwd });
  }

  function handleAction(action: InvoiceActionKind) {
    switch (action) {
      case "save":
      case "print": // الطباعة تتم من صفحة الفاتورة بعد الحفظ (qr + قالب A4 معتمد).
        handleSubmit();
        return;
      case "draft":
        notify.info("لا مسودة لفاتورة البيع — استخدم «عرض سعر» للمسودات القابلة للتحويل.");
        return;
      case "send":
        notify.info("الإرسال عبر واتساب متاح من صفحة الفاتورة بعد الحفظ.");
        return;
      case "pdf":
        notify.info("صدِّر PDF من صفحة الفاتورة بعد الحفظ.");
        return;
      case "convert":
        notify.info("التحويل متاح من عرض السعر فقط.");
        return;
      case "duplicate":
        handleReset();
        notify.info("تم تجهيز فاتورة جديدة فارغة.");
        return;
      case "return":
        navigate("/sales-returns/new");
        return;
    }
  }

  /* ─── اختصارات لوحة المفاتيح (F2/F4/F9/F12/Esc) ───────────────────── */
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) =>
      !!el && (el as HTMLElement).matches?.("input, textarea, select, [contenteditable='true']");

    const onKey = (e: KeyboardEvent) => {
      // أثناء فتح حوار الموافقة: Esc يغلقه فقط.
      if (creditPrompt) {
        if (e.key === "Escape") setCreditPrompt(null);
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
        if (!create.isPending) handleSubmit();
        return;
      }
      if (e.key === "F9") {
        e.preventDefault();
        window.print();
        return;
      }
      if (e.key === "F12") {
        e.preventDefault();
        handleReset();
        return;
      }
      if (e.key === "Escape" && !isTypingTarget(e.target) && !bulkOpen) {
        e.preventDefault();
        navigate("/invoices");
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, bulkOpen, creditPrompt, create.isPending]);

  const typeInfo = INVOICE_TYPES[INVOICE_TYPE];

  const hasZeroPriceLine = useMemo(
    () => state.items.some((l) => D(l.price).lte(0)),
    [state.items]
  );

  return (
    <div ref={containerRef} dir="rtl" className="flex h-full flex-col gap-3">
      {/* شريط العنوان */}
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-xl font-extrabold">
          <span aria-hidden className="text-2xl">{typeInfo.icon}</span>
          {typeInfo.label} متقدّمة
        </h1>
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
      </div>

      {/* رأس الفاتورة (بيانات المستند + العميل + الشروط المالية) */}
      <InvoiceHeader state={state} dispatch={dispatch} invoiceType={INVOICE_TYPE} />

      {hasZeroPriceLine && (
        <div className="rounded-md border border-amber-300/40 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700">
          ⚠️ هناك بنود بسعر غير صالح — صحّحها قبل الحفظ.
        </div>
      )}

      {/* البنية الأساسية: جدول البنود + لوحة الإجماليات والإجراءات */}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <ProductTable
            items={state.items}
            dispatch={dispatch}
            branchId={state.branchId}
            tier={state.tier}
            invoiceType={INVOICE_TYPE}
            showCost={showCost}
            /* العراق VAT=0% والخادم لا يحفظ ضريبة السطر ⇒ نُخفي العمود لتفادي تفاوت معروض/محفوظ. */
            showTax={false}
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
          {/* الشحن/المصاريف الأخرى غير مدعومة في sales.create ⇒ نُخفيها لئلّا تُضخّم
              الإجمالي المعروض و«ادفع الكل» بمبلغ لا يُحفظ (خسارة مالية صامتة). */}
          <TotalsPanel
            items={state.items}
            state={state}
            dispatch={dispatch}
            showShipping={false}
            showOtherExpenses={false}
          />
          <ActionButtons
            invoiceType={INVOICE_TYPE}
            items={state.items}
            saving={create.isPending}
            onAction={handleAction}
          />
          <TermsAndNotes state={state} dispatch={dispatch} />
        </aside>
      </div>

      <ShortcutsBar />

      {/* حوار موافقة المدير لتجاوز حدّ الائتمان */}
      <Dialog open={!!creditPrompt} onOpenChange={(o) => { if (!o) setCreditPrompt(null); }}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-600">
              🔒 موافقة مدير مطلوبة
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
            <Button type="button" variant="outline" onClick={() => setCreditPrompt(null)}>
              إلغاء
            </Button>
            <Button
              type="button"
              className="bg-rose-600 text-white hover:bg-rose-700"
              disabled={create.isPending}
              onClick={handleApprove}
            >
              {create.isPending ? "جارٍ الاعتماد…" : "اعتماد وإتمام البيع"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
