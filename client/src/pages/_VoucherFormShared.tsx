// نَموذج مُوحَّد لإنشاء سند قبض/صرف (vouchers-pro ٣٠/٦/٢٦).
// يَشمل: تَصنيف + اسم طَرف للسندات «أخرى» + Maker-Checker + مُرفق + بَصمة + تَحذير الازدواج
// + معاينة قَيد دفتر + اختصارات لوحة المفاتيح + حفظ+طباعة + استخدام CustomerPicker/SupplierPicker.
import CustomerPicker from "@/components/CustomerPicker";
import SupplierPicker from "@/components/voucher/SupplierPicker";
import { BalanceBadge } from "@/components/BalanceBadge";
import { PageHeader } from "@/components/PageHeader";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/form/MoneyInput";
import { FormError } from "@/components/form/FormError";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { confirm } from "@/lib/confirm";
import { D, fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printVoucherReceipt, printVoucherA4 } from "@/lib/printing/voucherPrint";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { BarcodeSearchCue, barcodeSearchInputClass } from "@/components/scan/BarcodeSearchCue";
import { cn } from "@/lib/utils";
import { isInboundPaymentMethodEnabled } from "@shared/inboundPaymentPolicy";
import { AlertTriangle, Building2, Hourglass, Info, Printer, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  voucherCashUiPolicy,
  voucherCreateActionLabel,
  voucherCreateSuccessMessage,
} from "@/components/vouchers/voucherUiPolicy";
import {
  isVoucherCategoryRoleCompatible,
  UNRESOLVED_DEFAULT_VOUCHER_CATEGORIES,
  voucherCategoryRoleLabel,
} from "@shared/voucherCategoryAccounting";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// قرار المالك (٢٢/٧): لا تعامل بالصكوك — CHECK محذوف من طرق الإنشاء (يبقى بالمخطط للسجلات التاريخية).
const METHODS = [
  { value: "CASH", label: "نقدي" },
  { value: "CARD", label: "بطاقة" },
  { value: "TRANSFER", label: "تحويل" },
  { value: "WALLET", label: "محفظة" },
] as const;
type MethodValue = typeof METHODS[number]["value"];

const METHOD_LABEL_MAP: Record<MethodValue, string> = {
  CASH: "نقدي", CARD: "بطاقة", TRANSFER: "تحويل", WALLET: "محفظة",
};

export interface VoucherFormProps {
  voucherType: "RECEIPT" | "PAYMENT";
}

function todayYmd(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function VoucherFormShared({ voucherType }: VoucherFormProps) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const utils = trpc.useUtils();
  const isReceipt = voucherType === "RECEIPT";
  const direction: "IN" | "OUT" = isReceipt ? "IN" : "OUT";

  const me = trpc.auth.me.useQuery();
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";

  // الفرع: افتراضي = فرع الموظف لا 1 (P2-12).
  const [branchId, setBranchId] = useState<number>(1);
  useEffect(() => {
    if (me.data?.branchId != null) setBranchId(Number(me.data.branchId));
  }, [me.data?.branchId]);

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<MethodValue>("CASH");
  useEffect(() => {
    // fail-closed على المجهول فقط: أيّ طريقةٍ خارج سياسة القبض تعود نقداً.
    if (!isInboundPaymentMethodEnabled(method)) {
      setMethod("CASH");
      setReferenceNumber("");
      setCardLastFour("");
    }
  }, [method]);
  const seededCustomerId = isReceipt ? Number(new URLSearchParams(search).get("customerId")) || null : null;
  const [partyType, setPartyType] = useState<"CUSTOMER" | "SUPPLIER" | "OTHER">(seededCustomerId ? "CUSTOMER" : "OTHER");
  const [customerId, setCustomerId] = useState<number | null>(seededCustomerId);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [description, setDescription] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [cardLastFour, setCardLastFour] = useState("");
  // vouchers-pro:
  const [voucherCategoryId, setVoucherCategoryId] = useState<number | "">("");
  const [counterpartyName, setCounterpartyName] = useState("");
  const [voucherDate, setVoucherDate] = useState<string>(todayYmd());
  const [attachmentImages, setAttachmentImages] = useState<ImageItem[]>([]);
  const attachmentUrl = attachmentImages[0]?.dataUrl ?? "";
  const [internalNote, setInternalNote] = useState("");
  // attachment-upload (٥/٧): ربط سند العميل بفاتورة بيع مُحدَّدة (اختياري).
  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const [err, setErr] = useState("");

  const branches = trpc.branches.list.useQuery();
  // فئات السندات بحَسب اتجاه السند الحالي (IN/OUT) — تَستثني المُعطَّلة.
  const categories = trpc.voucherCategories.list.useQuery({ includeInactive: false });
  const categoryOptions = useMemo(() => {
    const list = categories.data ?? [];
    return list.filter((c) => c.direction === "BOTH" || c.direction === direction);
  }, [categories.data, direction]);
  const selectedCategory = categoryOptions.find(
    (category) => Number(category.id) === Number(voucherCategoryId),
  );
  const selectedCategoryReady =
    selectedCategory != null &&
    isVoucherCategoryRoleCompatible(selectedCategory.direction, selectedCategory.postingRole);

  // عميل/مورّد المُختار (لمعاينة الرَصيد).
  const customerData = trpc.customers.get.useQuery(
    { customerId: customerId ?? 0 },
    { enabled: customerId != null && partyType === "CUSTOMER", staleTime: 60_000 },
  );
  const supplierData = trpc.suppliers.get.useQuery(
    { supplierId: supplierId ?? 0 },
    { enabled: supplierId != null && partyType === "SUPPLIER", staleTime: 60_000 },
  );

  // attachment-upload (٥/٧): فواتير العميل المُختار — لربط سند القبض/الصرف بفاتورة مُحدَّدة (اختياري).
  // fail-soft: خطأ الاستعلام (مَثلاً دورٌ مخصّص بلا صلاحية sales) لا يُعطّل حفظ السند — فقط يُخفي المُنتقي.
  // البحث خادميّ (q + balanceState=OUTSTANDING أي المتبقّي > 0 وغير الملغاة/المرتجعة) — كان «آخر ٥٠»
  // فقط فلا تُوجَد فاتورة أقدم وهي مستحقّة.
  const [invoiceQ, setInvoiceQ] = useState("");
  const invoiceBarcodeInput = useBarcodeInput((code) => setInvoiceQ(code));
  const debouncedInvoiceQ = useDebouncedValue(invoiceQ.trim(), 250);
  const customerInvoices = trpc.sales.list.useQuery(
    {
      customerId: customerId ?? undefined,
      q: debouncedInvoiceQ || undefined,
      balanceState: "OUTSTANDING",
      limit: 50,
    },
    { enabled: partyType === "CUSTOMER" && customerId != null, staleTime: 30_000, retry: false },
  );
  const outstandingInvoiceOptions = customerInvoices.data ?? [];
  // تثبيت الفاتورة المُختارة إن ضيّق البحث القائمة بعد اختيارها — كي لا يفرغ المُنتقي صامتاً.
  const [selectedInvoiceLabel, setSelectedInvoiceLabel] = useState("");
  const selectedInList = invoiceId != null && outstandingInvoiceOptions.some((inv) => Number(inv.id) === invoiceId);
  /** المتبقّي = الإجمالي − المدفوع − المُرتجَع (درس PR #286 — تجاهل المُرتجَع يُظهر متبقّياً وهمياً). */
  function invoiceRemaining(inv: { total: string | null; paidAmount: string | null; returnedTotal: string | null }): string {
    return D(inv.total ?? 0).minus(D(inv.paidAmount ?? 0)).minus(D(inv.returnedTotal ?? 0)).toFixed(2);
  }

  // وردية النقد + شارة الخزينة الإدارية.
  // OUT لا يمس درج المُنشئ أصلاً؛ مصدر التنفيذ النقدي الثابت هو خزينة المالك.
  const openShift = trpc.shifts.current.useQuery({ branchId }, { enabled: isReceipt && !!branchId });
  const { hardBlock, treasuryNotice } = voucherCashUiPolicy({
    direction,
    paymentMethod: method,
    hasOpenShift: openShift.data != null,
    shiftLoading: openShift.isLoading,
    isElevated,
  });

  // كل OUT طلبٌ بلا أثر حتى ينفّذ مالكٌ آخر «اعتماد وصرف» خادمياً؛ IN يبقى فورياً.
  const amountNum = useMemo(() => {
    const v = Number(amount);
    return Number.isFinite(v) ? v : 0;
  }, [amount]);
  const awaitsOwnerDisbursement = direction === "OUT" && amountNum > 0;
  // لا عَتبة مُرفق: المُرفق اختياريّ دائماً (٣١/٧، قرار المالك).

  // السندات الأخيرة لنفس الطَرف (تَحذير الازدواج).
  const partyKeyForRecent = useMemo(() => {
    if (partyType === "CUSTOMER" && customerId) return { partyId: customerId, name: null };
    if (partyType === "SUPPLIER" && supplierId) return { partyId: supplierId, name: null };
    if (partyType === "OTHER" && counterpartyName.trim().length >= 3) return { partyId: null, name: counterpartyName.trim() };
    return null;
  }, [partyType, customerId, supplierId, counterpartyName]);

  const recent = trpc.vouchers.recentForParty.useQuery(
    {
      partyType,
      partyId: partyKeyForRecent?.partyId ?? null,
      counterpartyName: partyKeyForRecent?.name ?? null,
      windowDays: 7,
      limit: 5,
    },
    { enabled: !!partyKeyForRecent, staleTime: 30_000 },
  );

  // تَحذير «المبلغ يَتجاوز الرصيد» (P1-7). الاتجاهات وفق BalanceBadge:
  //   عميل: موجب = «لنا عليه» (AR)، سالب = «له علينا» (دفع/دُفع له زيادة).
  //   مورّد: موجب = «له علينا» (AP)، سالب = «لنا عليه» (دفعنا له زيادة).
  const balanceWarn = useMemo(() => {
    if (amountNum <= 0) return null;
    if (partyType === "CUSTOMER" && customerData.data) {
      const b = Number(customerData.data.currentBalance ?? 0);
      if (direction === "IN" && amountNum > b) {
        return `يَتجاوز رصيد العميل المُتبقّي (${fmt(b)}) — سيُصبح للعميل رصيدٌ دائن (له علينا).`;
      }
    }
    if (partyType === "SUPPLIER" && supplierData.data) {
      const b = Number(supplierData.data.currentBalance ?? 0);
      if (direction === "OUT" && amountNum > b) {
        return `يَتجاوز رَصيد المورّد المُستحق (له علينا ${fmt(b)}) — سيُصبح المورّد مديناً (لنا عليه: دفعنا زيادة).`;
      }
    }
    return null;
  }, [amountNum, partyType, customerData.data, supplierData.data, direction]);

  // idempotency: مفتاح ثابت لكل سند (الصفحة تنتقل بعد النجاح فيتجدّد) ⇒ نقرة مزدوجة لا تُنشئ سندين.
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const create = trpc.vouchers.create.useMutation({
    onSuccess: async (res) => {
      notify.ok(voucherCreateSuccessMessage({
        direction,
        voucherNumber: res.voucherNumber,
        approvalStatus: res.approvalStatus,
      }));
      await Promise.all([utils.vouchers.list.invalidate(), utils.vouchers.aggregate.invalidate()]);
      // OUT لا يطبع وثيقة رسمية عند إنشاء الطلب. IN يطبع بعد نجاحه الفوري فقط.
      if (isReceipt && pendingPrintRef && res.approvalStatus === "APPROVED") {
        await tryPrintAfterCreate(res.receiptId);
      } else if (pendingPrintRef && res.approvalStatus !== "APPROVED") {
        notify.err("حُفظ الطلب بلا أثر مالي؛ تتاح الطباعة الرسمية بعد الاعتماد والتنفيذ.");
      }
      navigate("/vouchers");
    },
    onError: (e) => setErr(e.message),
  });

  // الحَفظ + الطَباعة الفورية — نَحفظ مرجع طلب الطباعة.
  const [pendingPrintRef, setPendingPrintRef] = useState<"thermal" | "a4" | null>(null);
  async function tryPrintAfterCreate(receiptId: number) {
    try {
      const v = await utils.vouchers.get.fetch({ receiptId });
      if (!v) return;
      const branchName = (branches.data ?? []).find((b) => Number(b.id) === Number(v.branchId))?.name;
      const partyName = v.partyName ?? (v.partyType === "OTHER" ? (v.counterpartyName ?? "—") : "—");
      const payload = {
        voucherNumber: v.voucherNumber ?? "",
        direction: v.direction as "IN" | "OUT",
        voucherDate: String(v.voucherDate ?? todayYmd()).slice(0, 10),
        createdAt: String(v.createdAt),
        branchName: branchName ?? null,
        amount: fmt(v.amount),
        paymentMethod: v.paymentMethod,
        paymentMethodLabel: METHOD_LABEL_MAP[v.paymentMethod as MethodValue] ?? v.paymentMethod,
        referenceNumber: v.referenceNumber,
        checkNumber: v.checkNumber,
        cardLastFour: v.cardLastFour,
        partyTypeLabel: v.partyType === "CUSTOMER" ? "عميل" : v.partyType === "SUPPLIER" ? "مورّد" : "أخرى",
        partyName,
        partyBalance: null,
        categoryName: v.categoryName,
        description: v.description ?? "",
        counterpartyName: v.counterpartyName,
        approvalStatus: v.approvalStatus as "APPROVED" | "PENDING_APPROVAL" | "REJECTED",
        approvedByName: v.approvedByName,
        approvedAt: v.approvedAt ? String(v.approvedAt) : null,
        createdByName: v.createdByName,
        cashBucket: v.cashBucket as "DRAWER" | "TREASURY" | null,
        signatureHash: v.signatureHash,
        attachmentUrl: v.attachmentUrl,
        relatedInvoiceNumber: v.invoiceNumber ?? null,
      };
      if (pendingPrintRef === "a4") await printVoucherA4(payload);
      else await printVoucherReceipt(payload);
    } catch (e) {
      console.warn("[voucher] فشلت الطباعة الفورية:", e);
      notify.err("تَمّ الحفظ، لكن الطباعة فشلت. أعِد الطباعة من قائمة السندات.");
    } finally {
      setPendingPrintRef(null);
    }
  }

  const submitColor = isReceipt ? "bg-emerald-600 hover:bg-emerald-700" : "bg-rose-600 hover:bg-rose-700";

  function validate(): string {
    if (!amount.trim() || !/^\d+(\.\d{1,2})?$/.test(amount.trim()) || Number(amount) <= 0) {
      return "المبلغ مطلوب (موجب، منزلتان عشريتان).";
    }
    if (!description.trim()) return "وصف السند مطلوب.";
    if (partyType === "CUSTOMER" && !customerId) return "اختر العميل المرتبط بالسند.";
    if (partyType === "SUPPLIER" && !supplierId) return "اختر المورّد المرتبط بالسند.";
    if (partyType === "OTHER" && voucherCategoryId === "") {
      return "فئة محاسبية معيّنة إلزامية لسندات «أخرى».";
    }
    if (partyType === "OTHER" && !selectedCategoryReady) {
      return "الفئة المختارة بلا حساب مقابل صالح؛ عيّن الحساب من إدارة الفئات أولاً.";
    }
    if (method === "TRANSFER" && !referenceNumber.trim()) {
      return "الرقم المرجعي إلزامي لطريقة الدفع «تحويل».";
    }
    if (method === "CARD" && !/^\d{4}$/.test(cardLastFour.trim())) {
      return "آخر ٤ من البطاقة إلزامي لطريقة الدفع «بطاقة» (٤ أرقام).";
    }
    return "";
  }

  function buildPayload() {
    const partyId = partyType === "CUSTOMER" ? customerId
      : partyType === "SUPPLIER" ? supplierId
      : null;
    return {
      voucherType,
      branchId,
      amount: amount.trim(),
      paymentMethod: method,
      partyType,
      partyId,
      description: description.trim(),
      referenceNumber: referenceNumber.trim() || null,
      // لا صكوك في الإنشاء (قرار المالك) — الحقل يبقى بالعقد للسجلات التاريخية فقط.
      checkNumber: null,
      cardLastFour: method === "CARD" ? (cardLastFour.trim() || null) : null,
      voucherCategoryId: voucherCategoryId === "" ? null : Number(voucherCategoryId),
      counterpartyName: counterpartyName.trim() || null,
      voucherDate,
      attachmentUrl: attachmentUrl.trim() || null,
      internalNote: internalNote.trim() || null,
      invoiceId: partyType === "CUSTOMER" ? invoiceId : null,
      clientRequestId,
    };
  }

  function submit(printAfter: "thermal" | "a4" | null = null) {
    setErr("");
    const v = validate();
    if (v) { setErr(v); return; }
    // حارس تجربة مستخدم فقط: سند الصرف المعلّق لا يطلب طباعة رسمية.
    setPendingPrintRef(isReceipt ? printAfter : null);
    create.mutate(buildPayload());
  }

  // حارس فقدان البيانات (نمط ExpenseNew): dirty عند إدخال فعليّ فقط — العميل المُمرَّر من URL
  // (seededCustomerId) لا يُحسب إدخالاً كي لا يظهر تحذير كاذب فور فتح الشاشة.
  const isDirty =
    amount.trim() !== "" ||
    description.trim() !== "" ||
    counterpartyName.trim() !== "" ||
    internalNote.trim() !== "" ||
    referenceNumber.trim() !== "" ||
    attachmentImages.length > 0 ||
    supplierId != null ||
    (customerId != null && customerId !== seededCustomerId);
  useUnsavedGuard(isDirty);

  // Esc/زر الإلغاء: تأكيد قبل مغادرة نموذج غير محفوظ (كان Esc يُغادر فوراً فيمسح المُدخلات).
  const leaveBusyRef = useRef(false);
  async function requestCancel() {
    if (create.isPending) return;
    if (!isDirty) { navigate("/vouchers"); return; }
    // Esc داخل حوار التأكيد نفسه يصل لهذا المعالج أيضاً — الحارس يمنع فتح حوارٍ ثانٍ.
    if (leaveBusyRef.current) return;
    leaveBusyRef.current = true;
    try {
      const ok = await confirm({
        variant: "warning",
        title: "مغادرة السند",
        description: "توجد بيانات غير محفوظة في النموذج — ستُفقد عند المغادرة. هل تتابع؟",
        confirmText: "مغادرة",
        cancelText: "بقاء",
      });
      if (ok) navigate("/vouchers");
    } finally {
      leaveBusyRef.current = false;
    }
  }

  // اختصارات لوحة المفاتيح (P2-13): Ctrl+S = حفظ، Ctrl+Enter = حفظ+طباعة، Esc = إلغاء (بتأكيد).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { void requestCancel(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        submit(isReceipt ? "thermal" : null);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        submit(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, method, partyType, customerId, supplierId, branchId, voucherCategoryId, attachmentUrl, invoiceId, voucherDate, isDirty, description, counterpartyName, internalNote, referenceNumber, attachmentImages]);

  // مَعاينة قَيد الدفتر (P1-10) — صفّان بسيطان مَدين/دائن.
  const ledgerPreview = useMemo(() => {
    if (amountNum <= 0) return null;
    const a = fmt(amountNum);
    const branchName = (branches.data ?? []).find((b) => Number(b.id) === Number(branchId))?.name ?? "—";
    const cashBucketLabel = method === "CASH" ? (treasuryNotice ? "خزينة إدارية" : "درج كاشير") : "بنك/محفظة";
    if (direction === "IN") {
      const credit = partyType === "CUSTOMER" ? "ذمة عميل (تَنقص)"
        : partyType === "SUPPLIER" ? "ذمة مورّد (تَزيد)"
        : selectedCategoryReady
          ? voucherCategoryRoleLabel(selectedCategory?.postingRole)
          : "اختر فئة محاسبية مهيأة";
      return [
        { side: "مَدين", account: `صندوق ${branchName} — ${cashBucketLabel}`, amount: a },
        { side: "دائن", account: credit, amount: a },
      ];
    }
    const debit = partyType === "CUSTOMER" ? "ذمة عميل (تَزيد)"
      : partyType === "SUPPLIER" ? "ذمة مورّد (تَنقص)"
      : selectedCategoryReady
        ? voucherCategoryRoleLabel(selectedCategory?.postingRole)
        : "اختر فئة محاسبية مهيأة";
    return [
      { side: "مَدين", account: debit, amount: a },
      { side: "دائن", account: `صندوق ${branchName} — ${cashBucketLabel}`, amount: a },
    ];
  }, [amountNum, branches.data, branchId, method, treasuryNotice, direction, partyType, selectedCategory, selectedCategoryReady]);

  return (
    <div className="space-y-4">
      <PageHeader
        title={isReceipt ? "سند قبض جديد" : "سند صرف جديد"}
        description={isReceipt
          ? "إيرادات/تحصيلات مستقلّة بلا فاتورة (مثل: دفعة من عميل بلا تخصيص، إيرادات متفرّقة، استرداد من مورّد)."
          : "طلب صرف مستقلّ بلا أثر مالي عند الإرسال؛ ينفّذه مالك آخر لاحقاً عبر «اعتماد وصرف» بعد التحقق من الرصيد."}
        actions={
          <Button variant="outline" size="sm" onClick={() => void requestCancel()}>
            → القائمة
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2 items-start">
        {/* البَيانات الرئيسية */}
        <Card>
          <CardHeader><CardTitle className="text-base">البيانات الرئيسية</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>الفرع *</Label>
              <select className={selectCls} value={branchId} onChange={(e) => setBranchId(Number(e.target.value))}>
                {(branches.data ?? []).map((b) => (
                  <option key={Number(b.id)} value={Number(b.id)}>{b.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>المبلغ * (IQD)</Label>
              <MoneyInput
                value={amount}
                onChange={setAmount}
                placeholder="50000"
                ariaLabel="مبلغ السند بالدينار"
                className="text-right"
              />
              {awaitsOwnerDisbursement && (
                <div className="text-[11px] space-y-0.5 mt-1">
                  <p className="text-[var(--sem-warn)] flex items-center gap-1">
                    <ShieldQuestion aria-hidden className="size-3" />
                    سيبقى طلباً بلا أثر حتى يعتمد ويصرفه حساب مالك آخر.
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-1">
              <Label>تاريخ السند *</Label>
              <Input type="date" dir="ltr" value={voucherDate} onChange={(e) => setVoucherDate(e.target.value)} />
              <p className="text-[11px] text-muted-foreground">
                التاريخ الفعلي للمُعاملة (قد يَختلف عن تاريخ الإدخال — مَثلاً دَفع إيجار مايو في ٥ يونيو).
              </p>
            </div>
            <div className="space-y-1">
              <Label>طريقة الدفع *</Label>
              <select className={selectCls} value={method} onChange={(e) => setMethod(e.target.value as MethodValue)}>
                {METHODS.map((m) => (
                  <option key={m.value} value={m.value} disabled={!isInboundPaymentMethodEnabled(m.value)}>{m.label}</option>
                ))}
              </select>
            </div>

            {(method === "TRANSFER" || method === "CARD" || method === "WALLET") && (
              <div className="space-y-1">
                <Label>
                  الرقم المرجعي {method === "TRANSFER" ? "*" : "(اختياري)"}
                </Label>
                <Input
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  placeholder="رقم العملية/التحويل"
                  dir="ltr"
                />
              </div>
            )}
            {method === "CARD" && (
              <div className="space-y-1">
                <Label>آخر ٤ من البطاقة *</Label>
                <Input
                  value={cardLastFour}
                  onChange={(e) => setCardLastFour(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  placeholder="1234"
                  maxLength={4}
                  dir="ltr"
                  className="tabular-nums text-center"
                />
              </div>
            )}
            <div className="space-y-1 md:col-span-2">
              <Label>
                فئة السند {direction === "OUT" ? "(مصروف)" : "(إيراد)"}
                {partyType === "OTHER" ? " *" : ""}
              </Label>
              <select
                className={selectCls}
                value={voucherCategoryId === "" ? "" : String(voucherCategoryId)}
                onChange={(e) => setVoucherCategoryId(e.target.value === "" ? "" : Number(e.target.value))}
              >
                <option value="">— اختر الفئة المحاسبية —</option>
                {categoryOptions.map((c) => (
                  <option
                    key={Number(c.id)}
                    value={Number(c.id)}
                    disabled={!isVoucherCategoryRoleCompatible(c.direction, c.postingRole)}
                  >
                    {c.name}
                    {!isVoucherCategoryRoleCompatible(c.direction, c.postingRole)
                      ? (UNRESOLVED_DEFAULT_VOUCHER_CATEGORIES as readonly string[]).includes(c.name)
                        ? " — تحتاج مساراً تخصصياً"
                        : " — غير مهيأة محاسبياً"
                      : ` — ${voucherCategoryRoleLabel(c.postingRole)}`}
                  </option>
                ))}
              </select>
              <p className={cn(
                "text-[11px]",
                partyType === "OTHER" && !selectedCategoryReady
                  ? "text-amber-800 font-medium"
                  : "text-muted-foreground",
              )}>
                {partyType === "OTHER"
                  ? "إلزامية: تحدد الحساب المقابل الذي سيظهر في دفتر الأستاذ. "
                  : "اختيارية للتقارير؛ الذمة هي الحساب المقابل محاسبياً. "}
                <Link href="/voucher-categories" className="underline">إدارة الفئات</Link>
              </p>
            </div>
          </CardContent>
        </Card>

        {/* الطرف المُقابل */}
        <Card>
          <CardHeader><CardTitle className="text-base">الطرف المقابل</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 gap-3">
            <div className="space-y-1">
              <Label>نوع الطرف *</Label>
              <select
                className={selectCls}
                value={partyType}
                onChange={(e) => {
                  const v = e.target.value as typeof partyType;
                  setPartyType(v);
                  setCustomerId(null);
                  setSupplierId(null);
                  setInvoiceId(null);
                }}
              >
                <option value="OTHER">أخرى (راتب/إيجار/إيرادات متفرّقة…)</option>
                <option value="CUSTOMER">عميل</option>
                <option value="SUPPLIER">مورّد</option>
              </select>
              <p className="text-xs text-muted-foreground">
                {partyType === "OTHER" && "لا تأثير على الذمم — تأثير على الصندوق/الدفتر فقط."}
                {partyType === "CUSTOMER" && (isReceipt ? "AR (ما يدين به العميل) ينقص بقيمة السند." : "AR يَزيد (المتجر يَدفع للعميل، مثل استرداد).")}
                {partyType === "SUPPLIER" && (isReceipt ? "AP (ما ندين به للمورّد) يَزيد (استلام نقد من المورّد)." : "AP يَنقص (دفعة للمورّد).")}
              </p>
            </div>

            {partyType === "CUSTOMER" && (
              <>
                <CustomerPicker
                  customerId={customerId}
                  onCustomerChange={(id) => {
                    setCustomerId(id);
                    setInvoiceId(null);
                    setInvoiceQ("");
                    setSelectedInvoiceLabel("");
                  }}
                  balance={customerData.data?.currentBalance}
                />
                {customerId != null && (
                  <div className="space-y-1">
                    <Label>ربط بفاتورة (اختياري)</Label>
                    <div className="relative">
                      <Input
                        type="search"
                        value={invoiceQ}
                        onChange={(e) => setInvoiceQ(e.target.value)}
                        onKeyDown={(e) => invoiceBarcodeInput.handleKeyDown(e, setInvoiceQ)}
                        placeholder="ابحث برقم الفاتورة… (كل الفواتير المستحقّة، لا آخر ٥٠ فقط)"
                        className={barcodeSearchInputClass}
                      />
                      <BarcodeSearchCue />
                    </div>
                    <AppSelect
                      value={invoiceId != null ? String(invoiceId) : "0"}
                      onValueChange={(v) => {
                        const id = v === "0" ? null : Number(v);
                        setInvoiceId(id);
                        if (id != null) {
                          const inv = outstandingInvoiceOptions.find((o) => Number(o.id) === id);
                          if (inv) {
                            setSelectedInvoiceLabel(`فاتورة #${inv.invoiceNumber} — متبقٍّ ${fmt(invoiceRemaining(inv))} د.ع`);
                          }
                        } else {
                          setSelectedInvoiceLabel("");
                        }
                      }}
                      aria-label="ربط السند بفاتورة"
                    >
                      <option value="0">— بلا ربط —</option>
                      {/* الفاتورة المُختارة تبقى ظاهرة حتى لو ضيّق البحث القائمة عنها. */}
                      {invoiceId != null && !selectedInList && (
                        <option value={String(invoiceId)}>{selectedInvoiceLabel || `فاتورة مُختارة #${invoiceId}`}</option>
                      )}
                      {outstandingInvoiceOptions.map((inv) => (
                        <option key={Number(inv.id)} value={String(inv.id)}>
                          فاتورة #{inv.invoiceNumber} — متبقٍّ {fmt(invoiceRemaining(inv))} د.ع
                        </option>
                      ))}
                    </AppSelect>
                    <p className="text-[11px] text-muted-foreground">
                      {customerInvoices.isFetching
                        ? "جارٍ جلب الفواتير المستحقّة…"
                        : "يَظهر هذا السند في سجلّ دفعات الفاتورة المُختارة (تتبّع تسديد دَين مُحدَّد). المتبقّي = الإجمالي − المدفوع − المُرتجَع."}
                    </p>
                  </div>
                )}
              </>
            )}
            {partyType === "SUPPLIER" && (
              <SupplierPicker supplierId={supplierId} onSupplierChange={setSupplierId} />
            )}
            {partyType === "OTHER" && (
              <div className="space-y-1">
                <Label>اسم المُستفيد / الدافع</Label>
                <Input
                  value={counterpartyName}
                  onChange={(e) => setCounterpartyName(e.target.value)}
                  placeholder={isReceipt ? "مَثلاً: شركة الإعلان — تَحصيل" : "مَثلاً: الموظف أحمد محمد / مالك العقار"}
                />
                <p className="text-[11px] text-muted-foreground">
                  مَوصى به — يُمكّن تَقرير «كل ما دُفع/قُبض من فلان» (مفيد للرواتب والإيجارات المُكرَّرة).
                </p>
              </div>
            )}

            {balanceWarn && (
              <div className="rounded-md border border-amber-300 bg-amber-50 text-amber-900 text-xs p-2 flex items-start gap-2">
                <AlertTriangle aria-hidden className="size-4 shrink-0 mt-0.5" />
                <span>{balanceWarn}</span>
              </div>
            )}

            {/* تَحذير الازدواج */}
            {(recent.data ?? []).length > 0 && (
              <div className="rounded-md border bg-muted/30 p-2 text-[12px] space-y-1">
                <div className="font-bold text-foreground flex items-center gap-1">
                  <Info aria-hidden className="size-3.5" />
                  آخر سندات لنفس الطَرف (٧ أيام):
                </div>
                {(recent.data ?? []).map((r) => (
                  <div key={Number(r.id)} className="flex items-center justify-between gap-2 text-muted-foreground">
                    <span className="truncate">
                      {r.voucherNumber} — {r.direction === "IN" ? "قبض" : "صرف"}
                      {r.approvalStatus === "PENDING_APPROVAL" ? <Hourglass aria-hidden className="inline size-3 ms-1" /> : null}
                    </span>
                    <span className="tabular-nums shrink-0" dir="ltr">{fmt(r.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* الوَصف + مَعاينة القَيد */}
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">الوصف والقَيد</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>وَصف السند *</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={isReceipt ? "مثال: تحصيل مبلغ من تاجر بدون فاتورة محدّدة" : "مثال: راتب الموظف أحمد لشهر يونيو"}
                rows={3}
              />
            </div>
            {ledgerPreview && (
              <div className="space-y-1">
                <Label>مَعاينة قَيد الدفتر</Label>
                <div className="rounded-md border bg-muted/20 overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-muted">
                      <tr>
                        <th className="p-1.5 text-right">المُحَدِّد</th>
                        <th className="p-1.5 text-right">الحساب</th>
                        <th className="p-1.5 text-left">المبلغ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledgerPreview.map((row, i) => (
                        <tr key={i} className="border-t">
                          <td className="p-1.5 font-bold">{row.side}</td>
                          <td className="p-1.5">{row.account}</td>
                          <td className="p-1.5 text-left tabular-nums" dir="ltr">{row.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {isReceipt
                    ? "هذا تَوضيح للقَيد المالي الذي سيُسجَّل تلقائياً عند الحفظ."
                    : "هذه معاينة فقط؛ لا يُسجَّل القيد إلا عند تنفيذ «اعتماد وصرف» بنجاح."}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* المُرفق + المُلاحظة الداخلية */}
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">المُرفقات والمُلاحظات الداخلية</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>مُرفَق السند (اختياري)</Label>
              <ImageUploader
                value={attachmentImages}
                onChange={setAttachmentImages}
                maxItems={1}
                maxSizeMB={2}
                singlePrimary={false}
                hint="صورة الإيصال الأصلي / فاتورة الإيجار / كَشف البنك — تُضغط تلقائياً قبل الحفظ."
              />
            </div>
            <div className="space-y-1">
              <Label>مُلاحظة داخلية (لا تُطبع)</Label>
              <Textarea
                value={internalNote}
                onChange={(e) => setInternalNote(e.target.value)}
                placeholder="مَثلاً: الإيصال الأصلي بحوزة المُحاسب"
                rows={2}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* تَنبيهات النَظام */}
      <FormError message={err} />
      {hardBlock && (
        <div className="rounded-md border badge-stock-low text-sm p-3 flex items-start gap-2">
          <AlertTriangle aria-hidden className="size-4 shrink-0 mt-0.5" />
          <span>لا توجد وردية مفتوحة في هذا الفرع. السندات النقدية للكاشير تَمسّ صندوق الوردية —
          {" "}<Link href="/shifts" className="underline">افتح وردية</Link> أوّلاً، أو غيِّر طريقة الدفع لغير نقدية.</span>
        </div>
      )}
      {treasuryNotice && (
        <div className="rounded-md border badge-status-pending text-sm p-3 flex items-start gap-2">
          <Building2 aria-hidden className="size-4 shrink-0 mt-0.5" />
          <span>
            {isReceipt ? (
              <>يُسجَّل في <strong>الخزينة الإدارية</strong> (بلا وردية كاشير) — يَظهر في تقرير «النقد خارج الوردية» مفصولاً عن تَسوية درج الكاشير.</>
            ) : (
              <>المصدر المتوقع للطلب هو <strong>الخزينة الإدارية</strong>. لن يتغير رصيدها عند الإرسال؛ يتحقق الخادم منه عند «اعتماد وصرف».</>
            )}
          </span>
        </div>
      )}
      {awaitsOwnerDisbursement && (
        <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] text-sm p-3 flex items-start gap-2">
          <ShieldCheck aria-hidden className="size-4 shrink-0 mt-0.5" />
          <span>
            سيُرسل <strong>طلب صرف</strong> بحالة «بانتظار الاعتماد والصرف» بلا إيصال أو قيد أو تغيير ذمة.
            ينفّذه حساب مالك نشط غير مُنشئ الطلب، ويعيد الخادم التحقق من الرصيد والصلاحية عند التنفيذ.
          </span>
        </div>
      )}

      {/* الأزرار */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => submit(null)}
          disabled={create.isPending || hardBlock}
          className={submitColor}
          title={hardBlock ? "افتح وردية قبل سند نقدي للكاشير" : "Ctrl+S"}
        >
          {voucherCreateActionLabel(direction, create.isPending)}
        </Button>
        {isReceipt && (
          <>
            <Button
              variant="outline"
              onClick={() => submit("thermal")}
              disabled={create.isPending || hardBlock}
              title="Ctrl+Enter"
            >
              <Printer aria-hidden className="size-4 ms-1" />
              حفظ + طباعة حرارية
            </Button>
            <Button
              variant="outline"
              onClick={() => submit("a4")}
              disabled={create.isPending || hardBlock}
            >
              <Printer aria-hidden className="size-4 ms-1" />
              حفظ + طباعة A4
            </Button>
          </>
        )}
        <Button variant="outline" disabled={create.isPending} onClick={() => void requestCancel()}>
          إلغاء (Esc)
        </Button>
        {customerData.data && partyType === "CUSTOMER" && (
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
            رصيد العميل قبل السند:
            <BalanceBadge amount={customerData.data.currentBalance} entityType="customer" showZero />
          </span>
        )}
        {supplierData.data && partyType === "SUPPLIER" && (
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
            رصيد المورّد قبل السند:
            <BalanceBadge amount={supplierData.data.currentBalance} entityType="supplier" showZero />
          </span>
        )}
      </div>
    </div>
  );
}
