import { CopyInline } from "@/components/CopyButton";
import { DataTable } from "@/components/data-table/DataTable";
import { ListToolbar, RowActions, SelectionBar, useRowSelection } from "@/components/list";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PeriodFilter, type PeriodValue, type PresetKey } from "@/components/reports/PeriodFilter";
import { PageHeader } from "@/components/PageHeader";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatTableAsTSV } from "@/lib/copy/formatters";
import { fmtDate } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { D, fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printInvoiceA4 } from "@/lib/printing/printTemplates";
import { printReceipt } from "@/lib/printing/print";
import { invoiceToReceipt } from "@/lib/printing/invoiceReceipt";
import { allocateLineTax } from "@/components/invoice";
import { round2 } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { paymentMethodLabel, paymentMethodClass, POS_METHODS, type PaymentMethod } from "@/lib/paymentMethod";
import { invoiceStatusLabel, sourceTypeLabel, SOURCE_TYPE_AR } from "@/lib/labels";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { FileWarning, Truck, X } from "lucide-react";
import { InvoiceDispatchDialog } from "@/components/delivery/InvoiceDispatchDialog";
import { CancelDeliveryAssignmentDialog } from "@/components/delivery/CancelDeliveryAssignmentDialog";
import { buildInvoiceMessage } from "@/lib/whatsapp";
import { normalizeKnownSystemBarcode } from "@/lib/barcodeScannerInput";

type Row = RouterOutputs["sales"]["list"][number];

/** حجم صفحة القائمة — الخادم يُرقّم، والمعروض هو المُحمَّل. */
const PAGE_SIZE = 50;

const STATUS: Record<string, string> = {
  PENDING: "معلّقة", PARTIALLY_PAID: "مدفوعة جزئياً", PAID: "مدفوعة",
  CONFIRMED: "مؤكّدة", CANCELLED: "ملغاة", RETURNED: "مرتجعة", SUPERSEDED: "مستبدلة بفاتورة مصححة",
};
const STATUS_CLS: Record<string, string> = {
  PAID: "badge-status-active", PARTIALLY_PAID: "badge-stock-low",
  PENDING: "badge-status-cancelled", RETURNED: "badge-stock-out", CANCELLED: "badge-stock-out", SUPERSEDED: "badge-status-cancelled",
};
const BALANCE_FILTER = {
  DEPOSIT_DUE: "عربون — متبقّي للتحصيل",
  OUTSTANDING: "عليها مبلغ متبقٍ",
  UNPAID: "غير مدفوعة",
  SETTLED: "مسوّاة بالكامل",
} as const;
// فلتر التوصيل (٩/٨) — يطابق enum الخادم في salesListInput.delivery حرفياً.
const DELIVERY_FILTER = {
  OPEN: "توصيل — بيد المندوب (لم تُورَّد)",
  SETTLED: "توصيل — سُلِّمت وسُوِّيت",
  RETURNED: "توصيل — أُرجعت",
  ANY: "كل فواتير التوصيل",
  NONE: "بلا توصيل",
} as const;
// حالة الإرسالية كما تعود من الخادم — شارة عمود «التوصيل».
const CONSIGNMENT_STATUS: Record<string, { label: string; cls: string }> = {
  DISPATCHED: { label: "بالطريق", cls: "badge-stock-low" },
  PARTIAL: { label: "حُصِّل جزئياً", cls: "badge-stock-low" },
  DELIVERED: { label: "سُلِّمت", cls: "badge-status-active" },
  RETURNED: { label: "أُرجعت", cls: "badge-stock-out" },
  WRITTEN_OFF: { label: "شُطبت", cls: "badge-stock-out" },
  CANCELLED: { label: "أُلغي التوصيل", cls: "badge-stock-out" },
};

function isDepositDue(row: Pick<Row, "sourceType" | "total" | "paidAmount" | "returnedTotal" | "status">) {
  if (row.status === "CANCELLED" || row.status === "RETURNED") return false;
  if (row.sourceType !== "ORDER" && row.sourceType !== "WORKORDER") return false;
  return D(row.paidAmount).gt(0) && D(row.total).minus(D(row.paidAmount)).minus(D(row.returnedTotal ?? "0")).gt(0);
}

// تعريب التصدير موحّد عبر قاموس labels المركزي؛ CONFIRMED غائبة عنه (ملف مشترك لا يُعدَّل هنا)
// فتُستكمل محلياً كي لا يتسرّب الكود الخام للتصدير. عرض الشاشة يبقى على STATUS المحلي (أغنى صياغة).
const exportStatusLabel = (s: string) => (s === "CONFIRMED" ? "مؤكّدة" : invoiceStatusLabel(s));
// فاتورة بلا عميل مسجَّل = بيع نقدي مباشر — المصطلح المعتمد «عميل نقدي» (لا شرطة غامضة).
const custName = (n: string | null | undefined) => n ?? "عميل نقدي";
// خلية التوصيل للتصدير/النسخ: «بالطريق — فلان (CN-…/ORD-…)» أو فارغة لغير الموصَّلة.
// ١٠/٨: المفتاح consignmentStatus (موحَّد خادمياً) — يشمل طلبات المتجر المُسنَدة بلا إرسالية.
const deliveryCell = (r: Pick<Row, "consignmentStatus" | "deliveryPartyName" | "consignmentNumber">) =>
  r.consignmentStatus
    ? `${CONSIGNMENT_STATUS[r.consignmentStatus]?.label ?? r.consignmentStatus} — ${r.deliveryPartyName ?? ""}${r.consignmentNumber ? ` (${r.consignmentNumber})` : ""}`
    : "";
// إرساليةٌ بالطريق ⇒ طريقة الدفع الحقيقية «عند الاستلام» لا ما اختير للسلة لحظة التثبيت
// (بلاغ المالك ١٠/٨: فاتورة توصيلٍ لم يُقبض منها فلس كانت تعرض «نقدي» — المخزَّن هو طريقة
// قبض العربون/التحصيل اللاحق، والعرض يجب أن يصدُق عن المتبقّي بيد المندوب).
const codInTransit = (r: Pick<Row, "consignmentStatus">) =>
  r.consignmentStatus === "DISPATCHED" || r.consignmentStatus === "PARTIAL";
const paymentLabel = (r: Pick<Row, "consignmentStatus" | "paymentMethod" | "paidAmount">) =>
  codInTransit(r)
    ? (D(r.paidAmount).gt(0) ? `عند الاستلام (COD) — عربون ${paymentMethodLabel(r.paymentMethod)}` : "عند الاستلام (COD)")
    : paymentMethodLabel(r.paymentMethod);

/** فلتر عميل مدمج — بحث حيّ عبر customers.smartSearch (نمط CustomerPicker) مجرّداً من زرّ
 *  «+ عميل جديد» (سياق فلترة لا إدخال بيانات). الاسم المختار يُجلب بـcustomers.get — ضروري
 *  عند فتح رابط يحمل customerId من useUrlFilters (الـURL لا يحمل الاسم). */
function CustomerFilter({ customerId, onChange }: { customerId: number | null; onChange: (id: number | null) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // إغلاق عند نقرة خارج المركّب (نفس نمط CustomerPicker).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selected = trpc.customers.get.useQuery(
    { customerId: customerId ?? 0 },
    { enabled: customerId != null, staleTime: 60_000 },
  );
  const trimmed = q.trim();
  const enabled = trimmed.length >= 2 && customerId == null;
  const search = trpc.customers.smartSearch.useQuery({ q: trimmed, limit: 8 }, { enabled, staleTime: 30_000 });
  const suggestions = search.data ?? [];

  if (customerId != null) {
    return (
      <div className="flex h-9 items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 text-sm">
        <span className="truncate">{selected.data?.name ?? `#${customerId}`}</span>
        <button
          type="button"
          onClick={() => { onChange(null); setQ(""); }}
          className="shrink-0 text-muted-foreground hover:text-destructive"
          aria-label="مسح فلتر العميل"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <Input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="كل العملاء — ابحث بالاسم أو الهاتف"
        aria-label="فلتر العميل"
        aria-autocomplete="list"
        aria-expanded={open}
      />
      {open && enabled && (
        <div className="absolute top-full z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover shadow-md">
          {search.isLoading && <div className="px-3 py-2 text-sm text-muted-foreground">جارٍ البحث…</div>}
          {!search.isLoading && suggestions.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">لا نتائج — جرّب اسماً أو هاتفاً آخر.</div>
          )}
          {!search.isLoading && suggestions.length > 0 && (
            <ul className="py-1">
              {suggestions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => { onChange(s.id); setQ(""); setOpen(false); }}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-right hover:bg-accent"
                  >
                    <span className="truncate">{s.name}</span>
                    {s.phone && <span className="shrink-0 text-[11px] text-muted-foreground" dir="ltr">{s.phone}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function Invoices() {
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  // فلاتر خادمية (لا فلترة محلية تُخفي صفحات الخادم) محفوظة في querystring عبر useUrlFilters —
  // تعيش مع فتح التفاصيل والرجوع وتُشارَك رابطاً. كل القيم نصوص (تُحوَّل عند حدود الـAPI).
  const [f, setF, resetF] = useUrlFilters({
    from: "", to: "", preset: "",
    status: "", sourceType: "", balanceState: "",
    salespersonId: "", paymentMethod: "", branchId: "", customerId: "",
    delivery: "", deliveryPartyId: "",
    q: "",
  });
  // البحث خادميّ (رقم الفاتورة/اسم العميل): كان محلّياً على الصفحة المُحمَّلة وحدها ⇒ يقول
  // «لا نتائج» عن فاتورة موجودة خارج السقف. debounce ليكتب المستخدم بلا طلب لكل حرف.
  const qDebounced = useDebouncedValue(f.q.trim(), 300);

  // يصلح أيضاً رابطاً محفوظاً من قبل الإصلاح وفيه ÷آ{ بدلاً من INV.
  useEffect(() => {
    const normalized = normalizeKnownSystemBarcode(f.q);
    if (normalized !== f.q) setF({ q: normalized });
  }, [f.q, setF]);

  // الترقيم خادميّ: الصفحة المعروضة فقط تُحمَّل (كان يُحمَّل ٢٠٠ صفّاً دفعةً بلا وصول لما بعدها).
  const [page, setPage] = useState(0);

  // تَحديد مُتَعَدِّد لِلصُفوف (نَسخ/تَصدير المُحَدَّد فَقَط).
  const sel = useRowSelection<number>();

  // حالة تحضير تصدير «الكل» (جلب كامل النتائج المطابقة للفلتر، لا الصفحة المعروضة).
  const [exporting, setExporting] = useState(false);
  const [printingReceiptId, setPrintingReceiptId] = useState<number | null>(null);
  const [dispatchTarget, setDispatchTarget] = useState<Row | null>(null);
  const [cancelDeliveryTarget, setCancelDeliveryTarget] = useState<Row | null>(null);

  // الرقم الضريبي للشركة (إعدادات النظام) — يُطبع على A4 بجانب رقم العميل الضريبي إن وُجد.
  const taxSettings = trpc.system.getTaxSettings.useQuery();
  const me = trpc.auth.me.useQuery();
  const salespeople = trpc.sales.salespeople.useQuery();
  // جهات التوصيل — لفلتر «جهة التوصيل». تُجلب فقط حين يُفعَّل فلتر توصيل (لا طلب زائد لكل فتح
  // شاشة)، وretry:false لأن بعض الأدوار بلا صلاحية store:READ (يُخفى المنتقي بدل خطأ متكرر).
  const deliveryParties = trpc.delivery.listParties.useQuery({}, { enabled: !!f.delivery || !!f.deliveryPartyId, retry: false, staleTime: 60_000 });

  // فلتر الفرع وعموده — للمرتفعين العابرين للفروع فقط (الخادم يتجاهل branchId لغيرهم أصلاً:
  // scopedBranchId الحاكم مقدَّم في buildSalesListConds، فالإخفاء هنا عرضيّ لا أمنيّ).
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: isElevated });
  const branchNames = useMemo(
    () => new Map((branches.data ?? []).map((b) => [b.id, b.name])),
    [branches.data],
  );
  // عمود «الفرع» يظهر فقط حين يعرض الجدول أكثر من فرع فعلاً (الفلتر على «كل الفروع»).
  const showBranchCol = isElevated && !f.branchId;

  // بوّابة «+ فاتورة جديدة» — تطابق حارس المسار حرفياً (App.tsx:277 sales:FULL على admin/manager/cashier)
  // وتحترم `permissionsOverride` بكلا الاتجاهين: قالبٌ مسموحٌ مُنِح `sales=NONE` ⇒ يُخفى؛ ودورٌ آخر
  // مُنِح `sales:FULL` صراحةً ⇒ يظهر. الفحص الأمنيّ يبقى خادميّاً بأي حال (RequireRole + راوتر البيع).
  const canCreateSale = !!me.data?.role && moduleAccessAllowed(
    me.data.role as RoleKey,
    (me.data.permissionsOverride ?? undefined) as PermissionMap | undefined,
    "sales",
    "FULL",
    ["admin", "manager", "cashier"],
  );

  // مدخلات الفلترة المشتركة (بلا limit/offset) — للقائمة وللمجاميع وللتصدير الشامل ⇒ الثلاثة
  // ترى نفس المجموعة حتماً (لا تصدير يخالف ما على الشاشة).
  const filterInput = useMemo(
    () => ({
      from: f.from || undefined,
      to: f.to || undefined,
      status: (f.status || undefined) as Row["status"] | undefined,
      sourceType: (f.sourceType || undefined) as Row["sourceType"] | undefined,
      balanceState: (f.balanceState || undefined) as keyof typeof BALANCE_FILTER | undefined,
      salespersonId: f.salespersonId ? Number(f.salespersonId) : undefined,
      paymentMethod: (f.paymentMethod || undefined) as PaymentMethod | undefined,
      branchId: f.branchId ? Number(f.branchId) : undefined,
      customerId: f.customerId ? Number(f.customerId) : undefined,
      delivery: (f.delivery || undefined) as keyof typeof DELIVERY_FILTER | undefined,
      deliveryPartyId: f.deliveryPartyId ? Number(f.deliveryPartyId) : undefined,
      q: qDebounced || undefined,
    }),
    [f.from, f.to, f.status, f.sourceType, f.balanceState, f.salespersonId, f.paymentMethod, f.branchId, f.customerId, f.delivery, f.deliveryPartyId, qDebounced],
  );

  // عدّاد الفلاتر المفعّلة (بلا حقل البحث — اتفاقية ListToolbar) لزرّ «مسح الفلاتر».
  const activeFilterCount = [
    f.from || f.to, f.status, f.sourceType, f.balanceState,
    f.salespersonId, f.paymentMethod, f.customerId,
    f.delivery, f.deliveryPartyId,
    isElevated ? f.branchId : "",
  ].filter(Boolean).length;

  // منتقي الفترة السريع — «فارغ» = كل التواريخ (بخلاف التقارير لا نفرض شهراً افتراضياً هنا).
  const periodValue: PeriodValue = { from: f.from, to: f.to, preset: (f.preset || "custom") as PresetKey };

  // أي تغيير في الفلاتر/البحث يعيدنا للصفحة الأولى (وإلا بقي offset قديماً على مجموعة أصغر
  // فظهرت صفحة فارغة).
  useEffect(() => { setPage(0); }, [filterInput]);

  const rows = trpc.sales.list.useQuery({ ...filterInput, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const data = rows.data ?? [];

  // مجاميع كل النتائج المطابقة للفلتر (خادمياً، لا الصفحة المعروضة فقط) — نفس قيم فلتر list حتماً.
  // count منها = إجمالي الترقيم (نفس buildSalesListConds ⇒ مطابقة مضمونة بالبناء).
  const summary = trpc.sales.listSummary.useQuery(filterInput);
  const total = summary.data?.count;

  // طباعة A4 من القائمة: نجلب التفاصيل (sales.get) ثم نطبع بنفس قالب شاشة الفاتورة.
  async function printA4(invoiceId: number) {
    try {
      const d = await utils.sales.get.fetch({ invoiceId });
      if (!d) { notify.err("تعذّر جلب الفاتورة"); return; }
      // توزيع ضريبة الفاتورة تناسبياً على السطور لعمود «الضريبة» في A4 (نفس خوارزمية محرّر
      // الفاتورة والـInvoiceDetail: آخر سطر يمتصّ التقريب ⇒ Σ الحصص = d.taxAmount بلا انجراف).
      const afterDisc = round2(D(d.subtotal).minus(D(d.discountAmount ?? "0"))).toFixed(2);
      const shares = allocateLineTax(
        d.items.map((it) => ({ total: String(it.total) })),
        String(d.taxAmount ?? "0"),
        afterDisc,
      );
      await printInvoiceA4({
        invoiceNumber: d.invoiceNumber,
        invoiceDate: d.invoiceDate,
        customerName: d.customerName,
        salespersonName: d.salespersonName,
        companyTaxId: taxSettings.data?.taxRegistrationNumber ?? null,
        paymentMethod: paymentMethodLabel(d.paymentMethod),
        subtotal: d.subtotal,
        discountAmount: d.discountAmount,
        taxAmount: d.taxAmount,
        taxRate: Number(d.taxRatePercent ?? 0),
        total: d.total,
        paidAmount: d.paidAmount,
        items: d.items.map((it, i) => ({
          productName: it.productName ?? "",
          unitName: it.unitName,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          total: it.total,
          taxAmount: shares[i] ?? "0",
        })),
      });
    } catch (e) {
      notify.err(e);
    }
  }

  async function reprintThermal(invoiceId: number) {
    if (printingReceiptId != null) return;
    setPrintingReceiptId(invoiceId);
    try {
      const d = await utils.sales.get.fetch({ invoiceId });
      if (!d) {
        notify.err("تعذّر جلب الفاتورة");
        return;
      }
      const result = await printReceipt(invoiceToReceipt(d));
      if (result.via === "server") {
        notify.ok("تمت إعادة الطباعة", `أُرسلت الفاتورة ${d.invoiceNumber} إلى طابعة الكاشير`);
      } else if (result.via === "thermal") {
        notify.ok("تمت إعادة الطباعة الحرارية", `أُرسلت الفاتورة ${d.invoiceNumber} إلى الطابعة المربوطة`);
      } else {
        notify.warn("الطابعة المباشرة غير متاحة", "افتُتحت نافذة الطباعة الحرارية البديلة");
      }
    } catch (e) {
      notify.err(e);
    } finally {
      setPrintingReceiptId(null);
    }
  }

  // نسخ لفاتورة جديدة: نجلب التفاصيل ونزرعها في sessionStorage (تُقرأ مرة واحدة في /sales/new).
  // ننسخ الكمية الأصلية كاملة (الفاتورة الجديدة تعيد بيع السلّة — المرتجعات لا تنقصها)،
  // وشكل كل سطر يطابق InvoiceLine في محرّر الفواتير حرفياً.
  async function duplicateInvoice(invoiceId: number) {
    try {
      const d = await utils.sales.get.fetch({ invoiceId });
      if (!d) { notify.err("تعذّر جلب الفاتورة"); return; }
      sessionStorage.setItem(
        "invoice-seed",
        JSON.stringify({
          customerId: d.customerId,
          tier: d.priceTier,
          items: d.items.map((it) => ({
            productId: it.productId ?? 0,
            variantId: it.variantId,
            productUnitId: it.productUnitId,
            name: it.productName ?? "",
            sku: it.sku ?? "",
            barcode: null,
            unit: it.unitName ?? "",
            // qty رقم في InvoiceLine (كمية لا مال) — التحويل عبر Decimal ثم toNumber.
            qty: D(it.quantity).toNumber(),
            // استرجاع معامل التحويل من baseQuantity ÷ quantity (مخزون النظام بالوحدة الأساس).
            conversionFactor: D(it.quantity).gt(0) ? D(it.baseQuantity).div(D(it.quantity)).toString() : "1",
            stockBase: 0,
            price: it.unitPrice,
            costBase: "0",
            // خصم السطر المحفوظ مبلغٌ مطلق ⇒ يُنسخ كنوع "amount".
            discount: D(it.discountAmount ?? 0).gt(0) ? String(it.discountAmount) : "0",
            discountType: "amount",
            note: "",
          })),
        })
      );
      navigate("/sales/new");
    } catch (e) {
      notify.err(e);
    }
  }

  // تصدير «الكل»: sales.list سقفٌ صلب بلا offset حقيقي للتصدير ⇒ جلبٌ واحد كبير
  // بنفس فلاتر القائمة (بدون limit/offset الصفحة) ثم exportRows. لا يمسّ تصدير المُحَدَّد.
  async function exportAll() {
    setExporting(true);
    try {
      // كل الصفحات المطابقة للفلتر **والبحث** (لا الصفحة المعروضة ولا استعلام عملاق واحد):
      // نفس filterInput ⇒ المُصدَّر = ما تراه على الشاشة موسَّعاً، لا مجموعة أخرى.
      const allRows = await fetchAllPaged<Row>(
        (offset, limit) =>
          utils.sales.list.fetch({ ...filterInput, limit, offset }).then((r) => ({ rows: (r ?? []) as Row[] })),
        { pageSize: 500 },
      );
      exportRows(allRows, {
        filename: "المبيعات",
        columns: [
          { key: "invoiceNumber", header: "رقم الفاتورة" },
          { key: "invoiceDate", header: "التاريخ", map: (r) => fmtDate(r.invoiceDate) },
          { key: "customerName", header: "العميل", map: (r) => custName(r.customerName) },
          { key: "sourceType", header: "المصدر", map: (r) => sourceTypeLabel(r.sourceType) },
          { key: "consignmentStatus", header: "التوصيل", map: (r) => deliveryCell(r) },
          { key: "salespersonName", header: "موظف المبيعات", map: (r) => r.salespersonName ?? "" },
          { key: "shiftId", header: "رقم الوردية", map: (r) => r.shiftId ?? "" },
          { key: "deviceId", header: "محطة البيع", map: (r) => r.deviceId ?? "" },
          { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
          { key: "paidAmount", header: "المدفوع", map: (r) => Number(r.paidAmount) },
          { key: "paymentMethod", header: "طريقة الدفع", map: (r) => paymentLabel(r) },
          { key: "status", header: "الحالة", map: (r) => exportStatusLabel(r.status) },
        ],
      });
    } catch (e) {
      notify.err(e);
    } finally {
      setExporting(false);
    }
  }

  const columns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    { accessorKey: "invoiceNumber", header: "رقم الفاتورة", cell: (c) => <CopyInline value={c.getValue() as string} /> },
    { accessorKey: "invoiceDate", header: "التاريخ", cell: (c) => fmtDate(c.getValue() as string) },
    { accessorKey: "customerName", header: "العميل", cell: (c) => custName(c.getValue() as string | null) },
    // عمود «الفرع» — للمرتفعين حين الفلتر «كل الفروع» فقط (سطر واحد لكل فرع لا معنى لتمييزه).
    ...(showBranchCol
      ? [{
          id: "branch",
          header: "الفرع",
          cell: ({ row }) => branchNames.get(row.original.branchId) ?? `#${row.original.branchId}`,
        } as ColumnDef<Row, unknown>]
      : []),
    { accessorKey: "sourceType", header: "المصدر", cell: (c) => sourceTypeLabel(c.getValue() as string) },
    {
      id: "delivery",
      header: "التوصيل",
      cell: ({ row }) => {
        const r = row.original;
        if (!r.consignmentStatus) return <span className="text-muted-foreground">—</span>;
        const st = CONSIGNMENT_STATUS[r.consignmentStatus] ?? { label: r.consignmentStatus, cls: "bg-muted" };
        return (
          <div className="flex flex-col items-start gap-0.5">
            <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${st.cls}`}>
              توصيل — {st.label}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {r.deliveryPartyName ?? "—"}
              {r.consignmentNumber ? <span className="ms-1 font-mono" dir="ltr">{r.consignmentNumber}</span> : null}
            </span>
          </div>
        );
      },
    },
    { accessorKey: "salespersonName", header: "موظف المبيعات", cell: (c) => (c.getValue() as string) ?? "—" },
    {
      id: "shiftDevice",
      header: "الوردية / المحطة",
      cell: ({ row }) => (
        <span className="text-xs">
          {row.original.shiftId ? `#${row.original.shiftId}` : "—"}
          {row.original.deviceId ? <span className="block text-muted-foreground font-mono" dir="ltr">{row.original.deviceId}</span> : null}
        </span>
      ),
    },
    { accessorKey: "total", header: "الإجمالي", cell: (c) => <span className="tabular-nums" dir="ltr">{fmt(c.getValue() as string)}</span> },
    { accessorKey: "paidAmount", header: "المدفوع", cell: (c) => <span className="tabular-nums" dir="ltr">{fmt(c.getValue() as string)}</span> },
    {
      accessorKey: "paymentMethod", header: "طريقة الدفع",
      cell: (c) => {
        const r = c.row.original;
        // بالطريق مع المندوب ⇒ الحقيقة «عند الاستلام»؛ العربون المقبوض يُذكر بطريقته تحتها.
        if (codInTransit(r)) {
          return (
            <div className="flex flex-col items-start gap-0.5">
              <span className="inline-block rounded-full px-2 py-0.5 text-xs font-semibold badge-stock-low">عند الاستلام (COD)</span>
              {D(r.paidAmount).gt(0) && r.paymentMethod && (
                <span className="text-[11px] text-muted-foreground">عربون: {paymentMethodLabel(r.paymentMethod)}</span>
              )}
            </div>
          );
        }
        const m = r.paymentMethod;
        if (!m) return <span className="text-muted-foreground">—</span>;
        return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${paymentMethodClass(m)}`}>{paymentMethodLabel(m)}</span>;
      },
    },
    {
      accessorKey: "status", header: "الحالة",
      cell: (c) => {
        const s = c.getValue() as string;
        const depositDue = isDepositDue(c.row.original);
        return (
          <div className="flex flex-col items-start gap-1">
            <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[s] ?? "bg-muted"}`}>{STATUS[s] ?? s}</span>
            {depositDue && <span className="inline-block rounded-full px-2 py-0.5 text-[11px] font-bold badge-stock-low">عربون — يحتاج تحصيل الباقي</span>}
          </div>
        );
      },
    },
    {
      id: "action", header: "إجراء", enableSorting: false,
      cell: (c) => {
        const r = c.row.original;
        // مسوّاة = لا دفعات بعدها؛ غير قابلة للإرجاع = ملغاة/مرتجعة بالكامل.
        const settled = r.status === "PAID" || r.status === "CANCELLED" || r.status === "RETURNED" || r.status === "SUPERSEDED";
        const returnable = r.status !== "CANCELLED" && r.status !== "RETURNED" && r.status !== "SUPERSEDED";
        return (
          <RowActions
            mode="auto"
            contact={{
              phone: r.customerPhone,
              label: `واتساب ${custName(r.customerName)}`,
              message: buildInvoiceMessage({
                invoiceNumber: r.invoiceNumber,
                invoiceDate: r.invoiceDate ? String(r.invoiceDate) : null,
                customerName: r.customerName,
                total: r.total,
                paidAmount: r.paidAmount,
                status: r.status,
              }),
              disabledReason: "لا يوجد رقم واتساب مرتبط بهذه الفاتورة",
              gate: { module: "sales", level: "READ" },
            }}
            actions={[
              {
                key: "view",
                kind: "view",
                label: "عرض",
                href: `/invoices/${r.id}`,
                gate: { module: "sales", level: "READ" },
              },
              {
                key: "thermal-print",
                kind: "print",
                label: printingReceiptId === r.id ? "جارٍ إعادة الطباعة…" : "إعادة طباعة حرارية",
                onSelect: () => void reprintThermal(r.id),
                disabled: printingReceiptId != null,
                disabledReason: "توجد عملية طباعة قيد التنفيذ",
                gate: { module: "sales", level: "READ" },
              },
              {
                key: "print",
                kind: "print",
                label: "طباعة A4",
                onSelect: () => void printA4(r.id),
                gate: { module: "sales", level: "READ" },
              },
              {
                key: "correct",
                kind: "correct",
                icon: FileWarning,
                label: "تعديل / استبدال موثّق",
                href: `/invoices/${r.id}/correct`,
                hidden:
                  r.status === "CANCELLED" || r.status === "RETURNED" || r.status === "SUPERSEDED" ||
                  r.sourceType === "WORKORDER" || (!!r.consignmentStatus && r.consignmentStatus !== "CANCELLED") ||
                  !D(r.returnedTotal ?? "0").isZero() || !D(r.paidAmount ?? "0").isZero(),
                gate: { roles: ["manager"], module: "sales", level: "FULL" },
              },
              {
                key: "dispatch",
                kind: "transfer",
                icon: Truck,
                label: "إسناد للتوصيل",
                onSelect: () => setDispatchTarget(r),
                hidden:
                  (!!r.consignmentStatus && r.consignmentStatus !== "CANCELLED") ||
                  r.status === "CANCELLED" || r.status === "RETURNED" || r.status === "SUPERSEDED" ||
                  r.sourceType === "ONLINE" || r.sourceType === "WORKORDER",
                gate: { roles: ["manager", "cashier", "sales_rep"], module: "store", level: "FULL" },
              },
              {
                key: "cancel-delivery",
                kind: "cancel",
                label: "إلغاء إسناد التوصيل",
                onSelect: () => setCancelDeliveryTarget(r),
                variant: "destructive",
                hidden: r.consignmentId == null ||
                  (r.consignmentParcelStatus !== "ASSIGNED" && r.consignmentParcelStatus !== "FAILED"),
                gate: { roles: ["manager"], module: "store", level: "FULL" },
              },
              {
                key: "duplicate",
                kind: "duplicate",
                label: "نسخ لفاتورة جديدة",
                onSelect: () => void duplicateInvoice(r.id),
                gate: { roles: ["cashier", "manager"], module: "sales", level: "FULL" },
              },
              {
                key: "pay",
                kind: "pay",
                label: "تسديد دفعة",
                href: `/invoices/${r.id}`,
                hidden: settled,
                gate: { roles: ["cashier", "manager"], module: "sales", level: "FULL" },
              },
              {
                key: "return",
                kind: "reverse",
                label: "إرجاع",
                href: `/returns?invoiceId=${r.id}`,
                hidden: !returnable,
                gate: { roles: ["manager"], module: "sales", level: "FULL" },
              },
            ]}
          />
        );
      },
    },
  ], [printingReceiptId, showBranchCol, branchNames]);

  // الصُفوف المُحَدَّدة + تَجهيز نَصّ TSV ومُلَخَّص واتساب لِزِرّ «نَسخ المُحَدَّد كَـ».
  // الفِكرة: TSV لِلَّصق في Excel، ومُلَخَّص نَصّي مُكَثَّف لِواتساب الإدارة.
  const TSV_HEADERS = useMemo(
    () => ["رقم الفاتورة", "التاريخ", "العميل", "المصدر", "التوصيل", "موظف المبيعات", "الوردية", "محطة البيع", "الإجمالي", "المدفوع", "طريقة الدفع", "الحالة"],
    [],
  );
  const selectedRows = useMemo(() => data.filter((r) => sel.isSelected(r.id)), [data, sel]);
  const selectedTsv = useMemo(() => {
    if (!selectedRows.length) return "";
    const rows = selectedRows.map((r) => ({
      "رقم الفاتورة": r.invoiceNumber,
      "التاريخ": fmtDate(r.invoiceDate),
      "العميل": custName(r.customerName),
      "المصدر": sourceTypeLabel(r.sourceType),
      "التوصيل": deliveryCell(r),
      "موظف المبيعات": r.salespersonName ?? "",
      "الوردية": r.shiftId ?? "",
      "محطة البيع": r.deviceId ?? "",
      "الإجمالي": Number(r.total),
      "المدفوع": Number(r.paidAmount),
      "طريقة الدفع": paymentLabel(r),
      "الحالة": exportStatusLabel(r.status),
    }));
    return formatTableAsTSV(TSV_HEADERS, rows);
  }, [selectedRows, TSV_HEADERS]);
  const selectedWhatsApp = useMemo(() => {
    if (!selectedRows.length) return "";
    const lines: string[] = [];
    lines.push(`ملخّص الفواتير (${selectedRows.length.toLocaleString("ar-IQ-u-nu-latn")})`);
    let sumTotal = D(0);
    let sumPaid = D(0);
    for (const r of selectedRows) {
      const t = D(r.total);
      const p = D(r.paidAmount);
      sumTotal = sumTotal.plus(t);
      sumPaid = sumPaid.plus(p);
      const customer = custName(r.customerName);
      const st = exportStatusLabel(r.status);
      const salesperson = r.salespersonName ?? "—";
      lines.push(`• ${r.invoiceNumber} — ${customer} — ${salesperson} — ${fmt(r.total)} (${st})`);
    }
    lines.push("");
    lines.push(`الإجمالي: ${fmt(sumTotal.toString())}`);
    lines.push(`المسدَّد: ${fmt(sumPaid.toString())}`);
    lines.push(`المتبقي: ${fmt(sumTotal.minus(sumPaid).toString())}`);
    return lines.join("\n");
  }, [selectedRows]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="المبيعات"
        description="قائمة الفواتير المباعة — ابحث عن الفاتورة ثم أعد طباعتها على طابعة الكاشير الحرارية عند الحاجة."
      />

      <Card>
        <CardContent className="space-y-3 pt-6">
          {/* «مسح الفلاتر» + عدّاد الفلاتر المفعّلة — البحث يبقى في شريط الجدول (DataTable). */}
          <ListToolbar title="الفلاتر" activeFilterCount={activeFilterCount} onResetFilters={resetF} />
          <PeriodFilter
            value={periodValue}
            onChange={(v) => setF({ from: v.from, to: v.to, preset: v.preset === "custom" ? "" : v.preset })}
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor="inv-f-status" className="text-xs">الحالة</Label>
              {/* قيمة «ALL» الحارسة: Radix يرفض بند القيمة الفارغة، فتبقى الحالة "" في الـURL نظيفة. */}
              <AppSelect id="inv-f-status" value={f.status || "ALL"} onValueChange={(v) => setF({ status: v === "ALL" ? "" : v })}>
                <option value="ALL">— كل الحالات —</option>
                {Object.entries(STATUS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </AppSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="inv-f-method" className="text-xs">طريقة الدفع</Label>
              <AppSelect id="inv-f-method" value={f.paymentMethod || "ALL"} onValueChange={(v) => setF({ paymentMethod: v === "ALL" ? "" : v })}>
                <option value="ALL">— كل الطرق —</option>
                {POS_METHODS.map((m) => (
                  <option key={m.v} value={m.v}>{m.label}</option>
                ))}
              </AppSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="inv-f-salesperson" className="text-xs">موظف المبيعات</Label>
              <AppSelect id="inv-f-salesperson" value={f.salespersonId || "ALL"} onValueChange={(v) => setF({ salespersonId: v === "ALL" ? "" : v })}>
                <option value="ALL">— كل الموظفين —</option>
                {(salespeople.data ?? []).map((u) => u.id != null ? (
                  <option key={u.id} value={String(u.id)}>{u.name}</option>
                ) : null)}
              </AppSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="inv-f-source" className="text-xs">نوع العملية</Label>
              <AppSelect id="inv-f-source" value={f.sourceType || "ALL"} onValueChange={(v) => setF({ sourceType: v === "ALL" ? "" : v })}>
                <option value="ALL">— كل الأنواع —</option>
                {Object.entries(SOURCE_TYPE_AR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </AppSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="inv-f-balance" className="text-xs">حالة التحصيل</Label>
              <AppSelect id="inv-f-balance" value={f.balanceState || "ALL"} onValueChange={(v) => setF({ balanceState: v === "ALL" ? "" : v })}>
                <option value="ALL">— كل حالات التحصيل —</option>
                {Object.entries(BALANCE_FILTER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </AppSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="inv-f-delivery" className="text-xs">التوصيل</Label>
              <AppSelect id="inv-f-delivery" value={f.delivery || "ALL"} onValueChange={(v) => setF({ delivery: v === "ALL" ? "" : v })}>
                <option value="ALL">— الكل (مع وبلا توصيل) —</option>
                {Object.entries(DELIVERY_FILTER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </AppSelect>
            </div>
            {(f.delivery || f.deliveryPartyId) && !deliveryParties.isError && (
              <div className="space-y-1">
                <Label htmlFor="inv-f-delivery-party" className="text-xs">جهة التوصيل</Label>
                <AppSelect id="inv-f-delivery-party" value={f.deliveryPartyId || "ALL"} onValueChange={(v) => setF({ deliveryPartyId: v === "ALL" ? "" : v })}>
                  <option value="ALL">— كل الجهات —</option>
                  {(deliveryParties.data ?? []).map((p) => (
                    <option key={p.id} value={String(p.id)}>{p.name}</option>
                  ))}
                </AppSelect>
              </div>
            )}
            {isElevated && (
              <div className="space-y-1">
                <Label htmlFor="inv-f-branch" className="text-xs">الفرع</Label>
                <AppSelect id="inv-f-branch" value={f.branchId || "ALL"} onValueChange={(v) => setF({ branchId: v === "ALL" ? "" : v })}>
                  <option value="ALL">— كل الفروع —</option>
                  {(branches.data ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
                </AppSelect>
              </div>
            )}
            <div className="space-y-1 md:col-span-2">
              <Label className="text-xs">العميل</Label>
              <CustomerFilter
                customerId={f.customerId ? Number(f.customerId) : null}
                onChange={(id) => setF({ customerId: id != null ? String(id) : "" })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <DataTable
        columns={columns}
        data={data}
        searchPlaceholder="بحث برقم الفاتورة أو اسم العميل…"
        barcodeSearch
        loading={rows.isLoading}
        emptyText="لا فواتير مطابقة."
        selection={sel}
        getRowId={(r) => r.id}
        getRowClassName={(r) => isDepositDue(r) ? "bg-[var(--sem-warn-bg)] shadow-[inset_-3px_0_0_var(--sem-warn)]" : undefined}
        serverSearch={{ value: f.q, onChange: (v) => setF({ q: v }) }}
        serverPagination={{ page, onPageChange: setPage, pageSize: PAGE_SIZE, total }}
        toolbar={
          <>
            {/* «+ فاتورة جديدة» — مدخل مرئي لشاشة `/sales/new` (الفاتورة المتقدّمة: آجل/أقساط/خصم إجماليّ/ضريبة).
                يطابق حارس المسار حرفياً ([App.tsx:277](): RequireRole sales:FULL على admin/manager/cashier)
                عبر `moduleAccessAllowed` — فيحترم `permissionsOverride` بكلا الاتجاهين: قالبٌ مسموح لكن
                منحُه `sales=NONE` لا يعود يرى الزرّ (كان يقود لشاشة ممنوعة)، ودورٌ آخر مُنِح `sales:FULL`
                صراحةً يراه (مطابقٌ لما ينفّذه الخادم فعلاً — الفحص الأمنيّ الحقيقيّ خادميّ بأي حال). */}
            {canCreateSale && (
              <Button size="sm" onClick={() => navigate("/sales/new")}>
                + فاتورة جديدة
              </Button>
            )}
            {(me.data?.role === "admin" || me.data?.role === "manager") && (
              <Button variant="outline" size="sm" onClick={() => navigate("/reports/sales-by-dimension")}>
                تقرير الموظفين
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={!total || exporting}
              onClick={() => void exportAll()}>
              {exporting ? "جارٍ التحضير…" : "تصدير Excel"}
            </Button>
          </>
        }
      />

      {/* شَريط التَحديد المُتَعَدِّد — يَظهَر عِند تَحديد صَفّ واحِد فَأَكثَر. */}
      <SelectionBar
        count={sel.count}
        onClear={sel.clear}
        onExport={() => {
          if (!selectedRows.length) return;
          exportRows(selectedRows, {
            filename: "المبيعات-المُحَدَّدة",
            columns: [
              { key: "invoiceNumber", header: "رقم الفاتورة" },
              { key: "invoiceDate", header: "التاريخ", map: (r) => fmtDate(r.invoiceDate) },
              { key: "customerName", header: "العميل", map: (r) => custName(r.customerName) },
              { key: "sourceType", header: "المصدر", map: (r) => sourceTypeLabel(r.sourceType) },
              { key: "consignmentStatus", header: "التوصيل", map: (r) => deliveryCell(r) },
              { key: "salespersonName", header: "موظف المبيعات", map: (r) => r.salespersonName ?? "" },
              { key: "shiftId", header: "رقم الوردية", map: (r) => r.shiftId ?? "" },
              { key: "deviceId", header: "محطة البيع", map: (r) => r.deviceId ?? "" },
              { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
              { key: "paidAmount", header: "المدفوع", map: (r) => Number(r.paidAmount) },
              { key: "paymentMethod", header: "طريقة الدفع", map: (r) => paymentLabel(r) },
              { key: "status", header: "الحالة", map: (r) => exportStatusLabel(r.status) },
            ],
          });
        }}
      />
      {/* زِرّ «نَسخ المُحَدَّد كَـ» — يَظهَر بِجانب شَريط التَحديد بِنَفس الشَرط. */}
      {sel.count > 0 && (
        <div className="sticky bottom-16 z-20 mx-auto flex w-fit items-center justify-center">
          <CopyAsMenu
            label="نسخ المُحَدَّد"
            tsv={selectedTsv}
            whatsapp={selectedWhatsApp}
          />
        </div>
      )}

      {/* شريط المجاميع — لكل النتائج المطابقة للفلتر خادمياً (لا الصفحة المعروضة فقط). */}
      {summary.data && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-6 text-sm">
            <span>
              عدد الفواتير:{" "}
              <b className="tabular-nums" dir="ltr">{summary.data.count.toLocaleString("ar-IQ-u-nu-latn")}</b>
            </span>
            <span>
              الإجمالي:{" "}
              <b className="tabular-nums" dir="ltr">{fmt(summary.data.totalAmount)}</b>
            </span>
            <span>
              المسدَّد:{" "}
              <b className="tabular-nums text-money-positive" dir="ltr">{fmt(summary.data.paidAmount)}</b>
            </span>
            <span>
              المتبقي:{" "}
              <b className="tabular-nums text-[var(--stock-low)]" dir="ltr">{fmt(summary.data.dueAmount)}</b>
            </span>
            <span className="text-xs text-muted-foreground">المجاميع لكل النتائج المطابقة للفلتر</span>
          </CardContent>
        </Card>
      )}
      <InvoiceDispatchDialog
        open={dispatchTarget != null}
        onOpenChange={(open) => { if (!open) setDispatchTarget(null); }}
        invoice={dispatchTarget ? {
          id: dispatchTarget.id,
          invoiceNumber: dispatchTarget.invoiceNumber,
          total: dispatchTarget.total,
          paidAmount: dispatchTarget.paidAmount,
          returnedTotal: dispatchTarget.returnedTotal,
          customerName: dispatchTarget.customerName,
          customerPhone: dispatchTarget.customerPhone,
        } : null}
      />
      <CancelDeliveryAssignmentDialog
        open={cancelDeliveryTarget != null}
        onOpenChange={(open) => { if (!open) setCancelDeliveryTarget(null); }}
        consignment={cancelDeliveryTarget?.consignmentId ? {
          id: cancelDeliveryTarget.consignmentId,
          number: cancelDeliveryTarget.consignmentNumber ?? `#${cancelDeliveryTarget.consignmentId}`,
        } : null}
      />
    </div>
  );
}
