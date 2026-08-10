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
import { Link, useLocation } from "wouter";

import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { D, round2, toBase } from "@/lib/money";
import { copyInvoiceItems, hasInvoiceTransfer, takeInvoiceItems } from "@/lib/invoiceTransfer";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { releaseReservedPrintWindow, reservePrintWindow } from "@/lib/printing/brand";
import { AlertTriangle, Lock } from "lucide-react";
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

  // تهيئة تفعيل/نسبة الضريبة من إعدادات النظام (مرّة واحدة فقط، فاتورة جديدة) — يبقى المستخدم
  // حرّاً بتبديلها يدوياً بعدها (لا نُعيد التهيئة عند كل جلب/إعادة رسم).
  const taxDefaultsAppliedRef = useRef(false);
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
    const paid = D(computePaidStr());
    const remaining = D(totals.grandTotal).minus(paid);
    if (remaining.gt(0) && !state.entityId)
      return "هناك مبلغ آجل (ذمة) — اختر عميلاً لتسجيل الذمة عليه.";
    if (remaining.lt(0) && state.paymentMethod !== "CASH")
      return "الدفع غير النقدي لا يمكن أن يتجاوز إجمالي الفاتورة.";
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
      create.mutate(buildPayload(approval));
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
        if (!create.isPending) {
          releaseReservedPrintWindow();
          printAfterSaveRef.current = false;
          shareAfterSaveRef.current = false;
          handleSubmit();
        }
        return;
      }
      if (e.key === "F9") {
        e.preventDefault();
        if (!create.isPending) {
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
    <div ref={containerRef} dir="rtl" className="flex h-full flex-col gap-3">
      {/* شريط العنوان */}
      <PageHeader
        title={`${typeInfo.label} متقدّمة`}
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
      <div className="flex min-h-0 flex-1 gap-3">
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

        <aside className="flex w-80 shrink-0 flex-col gap-2">
          {/* أجرة التوصيل صارت مدعومة في sales.create (تُحفَظ في `invoices.deliveryFee` وتدخل
              قيد SALE إيراداً بلا تكلفة، ويعكسها المرتجع الكامل) ⇒ أُظهرت مع مفتاح «مجاني».
              «مصاريف أخرى» تبقى مخفيّة: الخادم لا يحفظها، وإظهارها يُضخّم الإجمالي المعروض
              و«ادفع الكل» بمبلغٍ لا يُحفَظ (خسارة مالية صامتة). */}
          <TotalsPanel
            shippingLabel="أجرة التوصيل"
            allowFreeShipping
            items={state.items}
            state={state}
            dispatch={dispatch}
            showShipping
            showOtherExpenses={false}
            showTaxToggle
          />
          <ActionButtons
            invoiceType={INVOICE_TYPE}
            items={state.items}
            saving={create.isPending}
            pasteAvailable={pasteAvailable}
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
