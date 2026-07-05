// نَموذج مُوحَّد لإنشاء سند قبض/صرف (vouchers-pro ٣٠/٦/٢٦).
// يَشمل: تَصنيف + اسم طَرف للسندات «أخرى» + Maker-Checker + مُرفق + بَصمة + تَحذير الازدواج
// + معاينة قَيد دفتر + اختصارات لوحة المفاتيح + حفظ+طباعة + استخدام CustomerPicker/SupplierPicker.
import CustomerPicker from "@/components/CustomerPicker";
import SupplierPicker from "@/components/voucher/SupplierPicker";
import { BalanceBadge } from "@/components/BalanceBadge";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/form/MoneyInput";
import { FormError } from "@/components/form/FormError";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { D, fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printVoucherReceipt, printVoucherA4 } from "@/lib/printing/voucherPrint";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, Building2, Info, Printer, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const METHODS = [
  { value: "CASH", label: "نقدي" },
  { value: "CARD", label: "بطاقة" },
  { value: "CHECK", label: "صكّ" },
  { value: "TRANSFER", label: "تحويل" },
  { value: "WALLET", label: "محفظة" },
] as const;
type MethodValue = typeof METHODS[number]["value"];

const METHOD_LABEL_MAP: Record<MethodValue, string> = {
  CASH: "نقدي", CARD: "بطاقة", CHECK: "صكّ", TRANSFER: "تحويل", WALLET: "محفظة",
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
  const [partyType, setPartyType] = useState<"CUSTOMER" | "SUPPLIER" | "OTHER">("OTHER");
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [description, setDescription] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [cardLastFour, setCardLastFour] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
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
  const thresholds = trpc.vouchers.thresholds.useQuery();
  // فئات السندات بحَسب اتجاه السند الحالي (IN/OUT) — تَستثني المُعطَّلة.
  const categories = trpc.voucherCategories.list.useQuery({ includeInactive: false });
  const categoryOptions = useMemo(() => {
    const list = categories.data ?? [];
    return list.filter((c) => c.direction === "BOTH" || c.direction === direction);
  }, [categories.data, direction]);

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
  const customerInvoices = trpc.sales.list.useQuery(
    { customerId: customerId ?? undefined, limit: 50 },
    { enabled: partyType === "CUSTOMER" && customerId != null, staleTime: 30_000, retry: false },
  );
  const outstandingInvoiceOptions = useMemo(() => {
    const rows = customerInvoices.data ?? [];
    return rows.filter((r) => r.status === "PENDING" || r.status === "CONFIRMED" || r.status === "PARTIALLY_PAID");
  }, [customerInvoices.data]);

  // وردية النقد + شارة الخزينة الإدارية.
  const openShift = trpc.shifts.current.useQuery({ branchId }, { enabled: !!branchId });
  const cashNeedsShift = method === "CASH" && !openShift.data && !openShift.isLoading;
  const hardBlock = cashNeedsShift && !isElevated;
  const treasuryNotice = cashNeedsShift && isElevated;

  // عَتَبة الاعتماد — للتَلميح في الواجهة قبل الإرسال.
  const amountNum = useMemo(() => {
    const v = Number(amount);
    return Number.isFinite(v) ? v : 0;
  }, [amount]);
  const approvalThreshold = thresholds.data?.approval ?? 1_000_000;
  const attachmentThreshold = thresholds.data?.attachment ?? 250_000;
  const needsApproval = amountNum > 0 && amountNum >= approvalThreshold;
  const needsAttachment = amountNum > 0 && amountNum >= attachmentThreshold;

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

  // تَحذير «المبلغ يَتجاوز الرصيد» (P1-7).
  const balanceWarn = useMemo(() => {
    if (amountNum <= 0) return null;
    if (partyType === "CUSTOMER" && customerData.data) {
      const b = Number(customerData.data.currentBalance ?? 0);
      if (direction === "IN" && amountNum > b) {
        return `يَتجاوز رصيد العميل المُتبقّي (${fmt(b)}) — سيُصبح للعميل رصيدٌ دائن (لنا عليه).`;
      }
    }
    if (partyType === "SUPPLIER" && supplierData.data) {
      const b = Number(supplierData.data.currentBalance ?? 0);
      if (direction === "OUT" && amountNum > b) {
        return `يَتجاوز رَصيد المورّد المُستحق (${fmt(b)}) — سيُصبح للمورّد رَصيد مَدين (نَحن دافعون زيادة).`;
      }
    }
    return null;
  }, [amountNum, partyType, customerData.data, supplierData.data, direction]);

  // idempotency: مفتاح ثابت لكل سند (الصفحة تنتقل بعد النجاح فيتجدّد) ⇒ نقرة مزدوجة لا تُنشئ سندين.
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const create = trpc.vouchers.create.useMutation({
    onSuccess: async (res) => {
      if (res.approvalStatus === "PENDING_APPROVAL") {
        notify.ok(`أُنشئ السند ${res.voucherNumber} ⏳ بانتظار اعتماد مدير ثانٍ (Maker-Checker).`);
      } else {
        notify.ok(`تَمّ إنشاء ${isReceipt ? "سند القبض" : "سند الصرف"} ${res.voucherNumber}`);
      }
      await utils.vouchers.list.invalidate();
      // طباعة فورية إن طُلبت
      if (pendingPrintRef) {
        await tryPrintAfterCreate(res.receiptId);
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
    if (method === "TRANSFER" && !referenceNumber.trim()) {
      return "الرقم المرجعي إلزامي لطريقة الدفع «تحويل».";
    }
    if (method === "CARD" && !/^\d{4}$/.test(cardLastFour.trim())) {
      return "آخر ٤ من البطاقة إلزامي لطريقة الدفع «بطاقة» (٤ أرقام).";
    }
    if (method === "CHECK" && !checkNumber.trim()) {
      return "رقم الصكّ إلزامي لطريقة الدفع «صكّ».";
    }
    if (needsAttachment && !attachmentUrl.trim()) {
      return `المُرفق إلزامي للمبالغ ≥ ${fmt(attachmentThreshold)} د.ع (إيصال/فاتورة/صورة المُستند).`;
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
      checkNumber: method === "CHECK" ? (checkNumber.trim() || null) : null,
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
    setPendingPrintRef(printAfter);
    create.mutate(buildPayload());
  }

  // اختصارات لوحة المفاتيح (P2-13): Ctrl+S = حفظ، Ctrl+Enter = حفظ+طباعة، Esc = إلغاء.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { navigate("/vouchers"); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        submit("thermal");
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        submit(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, method, partyType, customerId, supplierId, branchId, voucherCategoryId, attachmentUrl, invoiceId, voucherDate]);

  // مَعاينة قَيد الدفتر (P1-10) — صفّان بسيطان مَدين/دائن.
  const ledgerPreview = useMemo(() => {
    if (amountNum <= 0) return null;
    const a = fmt(amountNum);
    const branchName = (branches.data ?? []).find((b) => Number(b.id) === Number(branchId))?.name ?? "—";
    const cashBucketLabel = method === "CASH" ? (treasuryNotice ? "خزينة إدارية" : "درج كاشير") : "بنك/محفظة";
    if (direction === "IN") {
      const credit = partyType === "CUSTOMER" ? "ذمة عميل (تَنقص)"
        : partyType === "SUPPLIER" ? "ذمة مورّد (تَزيد)"
        : "إيرادات متفرّقة";
      return [
        { side: "مَدين", account: `صندوق ${branchName} — ${cashBucketLabel}`, amount: a },
        { side: "دائن", account: credit, amount: a },
      ];
    }
    const debit = partyType === "CUSTOMER" ? "ذمة عميل (تَزيد)"
      : partyType === "SUPPLIER" ? "ذمة مورّد (تَنقص)"
      : "مَصاريف متفرّقة";
    return [
      { side: "مَدين", account: debit, amount: a },
      { side: "دائن", account: `صندوق ${branchName} — ${cashBucketLabel}`, amount: a },
    ];
  }, [amountNum, branches.data, branchId, method, treasuryNotice, direction, partyType]);

  return (
    <div className="space-y-4">
      <PageHeader
        title={isReceipt ? "سند قبض جديد" : "سند صرف جديد"}
        description={isReceipt
          ? "إيرادات/تحصيلات مستقلّة بلا فاتورة (مثل: دفعة من عميل بلا تخصيص، إيرادات متفرّقة، استرداد من مورّد)."
          : "مصاريف/مدفوعات مستقلّة بلا فاتورة (مثل: راتب موظف، إيجار، صيانة، دفعة لمورّد)."}
        actions={
          <Link href="/vouchers">
            <Button variant="outline" size="sm">→ القائمة</Button>
          </Link>
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
              {(needsApproval || needsAttachment) && amountNum > 0 && (
                <div className="text-[11px] space-y-0.5 mt-1">
                  {needsApproval && (
                    <p className="text-orange-700 flex items-center gap-1">
                      <ShieldQuestion aria-hidden className="size-3" />
                      يَحتاج اعتماد مدير ثانٍ (Maker-Checker، عَتبة {fmt(approvalThreshold)} د.ع).
                    </p>
                  )}
                  {needsAttachment && (
                    <p className="text-amber-700 flex items-center gap-1">
                      <Info aria-hidden className="size-3" />
                      المُرفق إلزامي (عَتبة {fmt(attachmentThreshold)} د.ع).
                    </p>
                  )}
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
                {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>

            {(method === "TRANSFER" || method === "CARD" || method === "CHECK" || method === "WALLET") && (
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
            {method === "CHECK" && (
              <div className="space-y-1">
                <Label>رقم الصكّ *</Label>
                <Input value={checkNumber} onChange={(e) => setCheckNumber(e.target.value)} placeholder="رقم الصك على الورقة" dir="ltr" />
              </div>
            )}

            <div className="space-y-1 md:col-span-2">
              <Label>فئة السند {direction === "OUT" ? "(مصروف)" : "(إيراد)"}</Label>
              <select
                className={selectCls}
                value={voucherCategoryId === "" ? "" : String(voucherCategoryId)}
                onChange={(e) => setVoucherCategoryId(e.target.value === "" ? "" : Number(e.target.value))}
              >
                <option value="">— بلا فئة —</option>
                {categoryOptions.map((c) => (
                  <option key={Number(c.id)} value={Number(c.id)}>{c.name}</option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                موصى به — يُفتح بها تَقارير «مَصاريف حسب الفئة» و«إيرادات حسب الفئة».{" "}
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
                  onCustomerChange={(id) => { setCustomerId(id); setInvoiceId(null); }}
                  balance={customerData.data?.currentBalance}
                />
                {customerId != null && (
                  <div className="space-y-1">
                    <Label>ربط بفاتورة (اختياري)</Label>
                    <select
                      className={selectCls}
                      value={invoiceId ?? ""}
                      onChange={(e) => setInvoiceId(e.target.value === "" ? null : Number(e.target.value))}
                    >
                      <option value="">— بلا ربط —</option>
                      {outstandingInvoiceOptions.map((inv) => {
                        const remaining = D(inv.total).minus(D(inv.paidAmount)).toFixed(2);
                        return (
                          <option key={Number(inv.id)} value={Number(inv.id)}>
                            فاتورة #{inv.invoiceNumber} — متبقٍّ {fmt(remaining)} د.ع
                          </option>
                        );
                      })}
                    </select>
                    <p className="text-[11px] text-muted-foreground">
                      يَظهر هذا السند في سجلّ دفعات الفاتورة المُختارة (تتبّع تسديد دَين مُحدَّد).
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
                      {r.approvalStatus === "PENDING_APPROVAL" ? " ⏳" : ""}
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
                  هذا تَوضيح للقَيد المالي الذي سيُسجَّل تلقائياً عند الحفظ.
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
              <Label>
                مُرفَق السند {needsAttachment ? "*" : "(اختياري)"}
              </Label>
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
          <span>يُسجَّل في <strong>الخزينة الإدارية</strong> (بلا وردية كاشير) — يَظهر في تقرير «النقد خارج الوردية» مفصولاً عن تَسوية درج الكاشير.</span>
        </div>
      )}
      {needsApproval && amountNum > 0 && (
        <div className="rounded-md border border-orange-300 bg-orange-50 text-orange-900 text-sm p-3 flex items-start gap-2">
          <ShieldCheck aria-hidden className="size-4 shrink-0 mt-0.5" />
          <span>
            هذا المبلغ يَستلزم <strong>اعتماد مدير ثانٍ</strong> (Maker-Checker، عَتبة {fmt(approvalThreshold)} د.ع).
            سيُسجَّل بحالة «بانتظار الاعتماد» بلا أي تأثير مالي حتى يُعتمد. أنت كَمُنشِئ لا يُمكنك اعتماد سندك بنفسك (فَصل المهام).
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
          {create.isPending ? "جارٍ الحفظ…" : (isReceipt ? "حفظ سند القبض" : "حفظ سند الصرف")}
        </Button>
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
        <Link href="/vouchers">
          <Button variant="outline" disabled={create.isPending}>إلغاء (Esc)</Button>
        </Link>
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
