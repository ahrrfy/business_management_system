/**
 * ReturnsHub — بوابة المرتجعات المركزية الشاملة والموحدة.
 *
 * تجمع وتوحد كافة مسارات المرتجعات:
 *  ١) مرتجعات مبيعات التجزئة (Retail POS)
 *  ٢) مرتجعات المطبعة والاستنساخ (Print & Copy Center)
 *  ٣) مرتجعات الاستقبال والتوصيل (Reception & Delivery)
 *  ٤) حوكمة مرتجعات الشراء والموردين (Purchases & Suppliers)
 *  ٥) محرك التحري والتقصي الجنائي للفواتير المفقودة (Lost Invoices Forensic Trace)
 *
 * مزودة بشريط المسح الكوني للباركود، ومؤشرات الأداء اللحظية، ومطابقة سكك الاسترداد.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  AlertTriangle,
  BookOpen,
  Building2,
  Clock,
  CreditCard,
  FileSearch,
  Package,
  Printer,
  Receipt,
  RotateCcw,
  ScanLine,
  Search,
  ShieldAlert,
  ShieldCheck,
  Truck,
  UserCheck,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ReturnComposer } from "@/components/returns/ReturnComposer";
import PurchaseReturnsGovernance from "@/pages/PurchaseReturnsGovernance";
import { ReturnConsignmentDialog, type ReturnConsignmentTarget } from "@/components/delivery/ReturnConsignmentDialog";
import { NoReceiptReturnDialog, type NoReceiptItem } from "@/components/returns/NoReceiptReturnDialog";
import { ReturnsLedgerView } from "@/components/returns/ReturnsLedgerView";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AppSelect } from "@/components/ui/AppSelect";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { CopyInline } from "@/components/CopyButton";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { invoiceStatusLabel, type InvoiceStatus } from "@shared/invoiceStatus";
import { ACTION_LABELS } from "@shared/actionLabels";

export type ReturnsTabKey = "sales" | "print" | "delivery" | "purchases" | "forensic" | "ledger";

type TracedRow = RouterOutputs["returns"]["forensicTrace"]["results"][number];
type InvoicePickRow = RouterOutputs["sales"]["listPage"]["rows"][number];

export default function ReturnsHub() {
  const [, setLocation] = useLocation();
  const searchStr = useSearch();
  const utils = trpc.useUtils();

  const urlParams = useMemo(() => new URLSearchParams(searchStr), [searchStr]);
  const activeTab = (urlParams.get("tab") as ReturnsTabKey) || "sales";
  const urlInvoiceId = urlParams.get("invoiceId") ? parseInt(urlParams.get("invoiceId")!, 10) : null;
  const approvingRequestId = urlParams.get("requestId") ? parseInt(urlParams.get("requestId")!, 10) : null;

  const [selectedInvoiceId, setSelectedInvoiceId] = useState<number | null>(urlInvoiceId);
  useEffect(() => {
    if (urlInvoiceId != null && urlInvoiceId !== selectedInvoiceId) {
      setSelectedInvoiceId(urlInvoiceId);
    }
  }, [urlInvoiceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // تبديل التبويب
  const switchTab = (tab: ReturnsTabKey) => {
    const p = new URLSearchParams(searchStr);
    p.set("tab", tab);
    setLocation(`/returns?${p.toString()}`);
  };

  // ═════════════════════════════════════════════════════════════════════════
  // شريط المسح الكوني (Universal Scan Bar)
  // ═════════════════════════════════════════════════════════════════════════
  const [universalBarcode, setUniversalBarcode] = useState("");
  const [isScanning, setIsScanning] = useState(false);

  const handleUniversalScan = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const barcode = universalBarcode.trim();
    if (!barcode) return;

    setIsScanning(true);
    try {
      const res = await utils.returns.universalScan.fetch({ barcode });
      if (res.recognized) {
        if (res.kind === "INVOICE" && res.id) {
          setSelectedInvoiceId(res.id);
          switchTab("sales");
          notify.ok(`تم التعرف على فاتورة بيع: #${res.number}`);
        } else if (res.kind === "WORK_ORDER" && res.id) {
          switchTab("print");
          notify.ok(`تم التعرف على أمر شغل مطبعة: #${res.number}`);
        } else if (res.kind === "DELIVERY" && res.id) {
          switchTab("delivery");
          notify.ok(`تم التعرف على طرد توصيل: #${res.number}`);
        } else if (res.kind === "PURCHASE_RETURN" && res.id) {
          switchTab("purchases");
          notify.ok(`تم التعرف على مرتجع مشتريات: #${res.number}`);
        } else if (res.kind === "PRODUCT") {
          setForensicQuery(barcode);
          setForensicMode("ITEM_BARCODE");
          switchTab("forensic");
          notify.info(`تم التعرف على باركود صنف — جاري التقصي الجنائي في الفواتير`);
        }
      } else {
        setForensicQuery(barcode);
        setForensicMode("ITEM_BARCODE");
        switchTab("forensic");
        notify.info(`رمز غير مباشر — تم تفعيل محرك التقصي الجنائي`);
      }
    } catch {
      notify.err("تعذّر مسح الباركود");
    } finally {
      setIsScanning(false);
      setUniversalBarcode("");
    }
  };

  // ═════════════════════════════════════════════════════════════════════════
  // محرك التقصي الجنائي (Forensic Trace Engine State)
  // ═════════════════════════════════════════════════════════════════════════
  const [forensicQuery, setForensicQuery] = useState("");
  const [forensicMode, setForensicMode] = useState<"ITEM_BARCODE" | "CARD_LAST4" | "CUSTOMER_PHONE" | "DATE_SHIFT">("ITEM_BARCODE");
  const [forensicDays, setForensicDays] = useState(30);
  const debouncedForensicQuery = useDebouncedValue(forensicQuery.trim(), 400);

  const forensicTraceQuery = trpc.returns.forensicTrace.useQuery(
    {
      query: debouncedForensicQuery,
      mode: forensicMode,
      days: forensicDays,
    },
    {
      enabled: activeTab === "forensic" && debouncedForensicQuery.length >= 2,
    }
  );

  // ═════════════════════════════════════════════════════════════════════════
  // استعلامات تبويب مبيعات التجزئة (Retail Sales)
  // ═════════════════════════════════════════════════════════════════════════
  const [salesSearch, setSalesSearch] = useState("");
  const debouncedSalesSearch = useDebouncedValue(salesSearch.trim(), 300);
  const [salesPage, setSalesPage] = useState(0);

  const salesInvoicesQuery = trpc.sales.listPage.useQuery(
    {
      limit: 20,
      offset: salesPage * 20,
      q: debouncedSalesSearch || undefined,
    },
    { enabled: activeTab === "sales" }
  );

  const pendingRequestsQuery = trpc.returns.requests.useQuery(
    { status: "PENDING_APPROVAL" },
    { enabled: activeTab === "sales" }
  );

  // طرود التوصيل الراجعة
  const [deliveryTarget, setDeliveryTarget] = useState<ReturnConsignmentTarget | null>(null);
  const [deliverySearch, setDeliverySearch] = useState("");
  const debouncedDeliverySearch = useDebouncedValue(deliverySearch.trim(), 300);

  const inTransitQuery = trpc.delivery.inTransit.useQuery(
    { limit: 50 },
    { enabled: activeTab === "delivery" }
  );

  const filteredConsignments = useMemo(() => {
    const list = inTransitQuery.data?.rows ?? [];
    if (!debouncedDeliverySearch) return list;
    const q = debouncedDeliverySearch.toLowerCase();
    return list.filter(
      (c) =>
        c.consignmentNumber.toLowerCase().includes(q) ||
        String(c.invoiceId).includes(q) ||
        (c.driverName && c.driverName.toLowerCase().includes(q)) ||
        (c.partyName && c.partyName.toLowerCase().includes(q))
    );
  }, [inTransitQuery.data?.rows, debouncedDeliverySearch]);

  const returnDeliveryMutation = trpc.delivery.returnConsignment.useMutation({
    onSuccess: () => {
      notify.ok("تم إرجاع الإرسالية بنجاح وإعادة البضاعة للمخزن");
      setDeliveryTarget(null);
      inTransitQuery.refetch();
    },
    onError: (err) => notify.err(err.message),
  });

  // أوامر الشغل للمطبعة
  const [printSearch, setPrintSearch] = useState("");
  const debouncedPrintSearch = useDebouncedValue(printSearch.trim(), 300);
  const workOrdersQuery = trpc.workOrders.list.useQuery(
    { q: debouncedPrintSearch || undefined, limit: 50 },
    { enabled: activeTab === "print" }
  );

  // حالة بروتوكول الإرجاع بدون فاتورة
  const [noReceiptOpen, setNoReceiptOpen] = useState(false);
  const [noReceiptItem, setNoReceiptItem] = useState<NoReceiptItem | null>(null);

  // ═════════════════════════════════════════════════════════════════════════
  // أعمدة جدول التقصي الجنائي
  // ═════════════════════════════════════════════════════════════════════════
  const forensicColumns: ColumnDef<TracedRow, unknown>[] = [
    {
      id: "invoiceNumber",
      header: "رقم الفاتورة",
      accessorFn: (r) => r.invoiceNumber,
      meta: { kind: "code" },
      cell: ({ row }) => <CopyInline value={row.original.invoiceNumber} />,
    },
    {
      id: "matchedItem",
      header: "الصنف المطابق",
      cell: ({ row }) => {
        const itm = row.original.matchedItem;
        if (!itm) return <span className="text-muted-foreground">—</span>;
        return (
          <div className="text-xs">
            <div className="font-bold">{itm.productName}</div>
            <div className="text-muted-foreground">
              الكمية: {itm.soldQuantity} | السعر: {fmt(itm.unitPrice)}
            </div>
          </div>
        );
      },
    },
    {
      id: "customer",
      header: "العميل",
      cell: ({ row }) => (
        <div className="text-xs">
          <div>{row.original.customerName || "زبون عابر"}</div>
          {row.original.customerPhone && (
            <div className="text-muted-foreground font-mono">{row.original.customerPhone}</div>
          )}
        </div>
      ),
    },
    {
      id: "total",
      header: "إجمالي الفاتورة",
      accessorFn: (r) => fmt(r.total),
      meta: { kind: "money" },
      cell: ({ row }) => fmt(row.original.total),
    },
    {
      id: "cashier",
      header: "الكاشير",
      accessorFn: (r) => r.cashierName || "—",
      cell: ({ row }) => row.original.cashierName || "—",
    },
    {
      id: "date",
      header: "التاريخ",
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString("ar-IQ"),
    },
    {
      id: "actions",
      header: "إجراء",
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setSelectedInvoiceId(row.original.invoiceId);
            switchTab("sales");
            notify.info(`تم اختيار الفاتورة #${row.original.invoiceNumber} للإرجاع`);
          }}
        >
          اختيار وإرجاع
        </Button>
      ),
    },
  ];

  // ═════════════════════════════════════════════════════════════════════════
  // أعمدة جدول اختيار الفاتورة العادية
  // ═════════════════════════════════════════════════════════════════════════
  const salesInvoiceColumns: ColumnDef<InvoicePickRow, unknown>[] = [
    {
      id: "invoiceNumber",
      header: "رقم الفاتورة",
      accessorFn: (r) => r.invoiceNumber,
      meta: { kind: "code" },
      cell: ({ row }) => <CopyInline value={row.original.invoiceNumber} />,
    },
    {
      id: "total",
      header: "الإجمالي",
      accessorFn: (r) => fmt(r.total),
      meta: { kind: "money" },
      cell: ({ row }) => fmt(row.original.total),
    },
    {
      id: "status",
      header: "الحالة",
      accessorFn: (r) => invoiceStatusLabel(r.status),
      meta: { kind: "status" },
      cell: ({ row }) => invoiceStatusLabel(row.original.status),
    },
    {
      id: "actions",
      header: "إجراء",
      cell: ({ row }) => {
        const id = Number(row.original.id);
        const isPicked = selectedInvoiceId === id;
        return (
          <Button
            size="sm"
            variant={isPicked ? "default" : "outline"}
            onClick={() => setSelectedInvoiceId(id)}
          >
            {isPicked ? "محددة" : "اختيار"}
          </Button>
        );
      },
    },
  ];

  const pendingCount = pendingRequestsQuery.data?.length ?? 0;

  return (
    <div className="space-y-6 pb-12">
      {/* الترويسة الرئيسية */}
      <PageHeader
        title="بوابة المرتجعات المركزية"
        backHref="/invoices"
        backLabel="المبيعات"
      />

      {/* شريط المسح الكوني الذكي والمؤشرات */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* حقل المسح الكوني للباركود */}
        <Card className="lg:col-span-8 border-primary/30 bg-card/60 shadow-sm">
          <CardContent className="p-4">
            <form onSubmit={handleUniversalScan} className="flex gap-2">
              <div className="relative flex-1">
                <ScanLine className="absolute right-3 top-3 size-4 text-muted-foreground" aria-hidden />
                <Input
                  value={universalBarcode}
                  onChange={(e) => setUniversalBarcode(e.target.value)}
                  placeholder="امسح أي باركود: فاتورة INV، صنف، طرد توصيل DLV، أمر مطبعة WO، مرتجع PR..."
                  className="pr-9 font-mono"
                  autoFocus
                />
              </div>
              <Button type="submit" disabled={isScanning || !universalBarcode.trim()}>
                {isScanning ? ACTION_LABELS.loading : "التقاط وتوجيه"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* المؤشرات اللحظية */}
        <div className="lg:col-span-4 grid grid-cols-2 gap-2">
          <Card className="p-3 bg-muted/30 flex flex-col justify-center items-center text-center">
            <div className="text-xs text-muted-foreground font-semibold">طلبات معلّقة للاعتماد</div>
            <div className="text-xl font-bold text-stock-low">{pendingCount}</div>
          </Card>
          <Card className="p-3 bg-muted/30 flex flex-col justify-center items-center text-center">
            <div className="text-xs text-muted-foreground font-semibold">المسار النشط</div>
            <div className="text-sm font-bold text-primary">
              {activeTab === "sales" && "مبيعات التجزئة"}
              {activeTab === "print" && "المطبعة والاستنساخ"}
              {activeTab === "delivery" && "التوصيل والاستقبال"}
              {activeTab === "purchases" && "المشتريات والموردين"}
              {activeTab === "forensic" && "التقصي الجنائي"}
              {activeTab === "ledger" && "سجل قيود المرتجعات"}
            </div>
          </Card>
        </div>
      </div>

      {/* شريط التبويبات السيادية الموحدة */}
      <div className="flex flex-wrap gap-2 border-b pb-3">
        <Button
          variant={activeTab === "sales" ? "default" : "outline"}
          onClick={() => switchTab("sales")}
          className="gap-2 font-bold"
        >
          <Receipt className="size-4" aria-hidden />
          مرتجعات التجزئة
          {pendingCount > 0 && (
            <Badge variant="destructive" className="mr-1 text-[10px] px-1.5 py-0">
              {pendingCount}
            </Badge>
          )}
        </Button>

        <Button
          variant={activeTab === "print" ? "default" : "outline"}
          onClick={() => switchTab("print")}
          className="gap-2 font-bold"
        >
          <Printer className="size-4" aria-hidden />
          المطبعة والاستنساخ
        </Button>

        <Button
          variant={activeTab === "delivery" ? "default" : "outline"}
          onClick={() => switchTab("delivery")}
          className="gap-2 font-bold"
        >
          <Truck className="size-4" aria-hidden />
          التوصيل والاستقبال
        </Button>

        <Button
          variant={activeTab === "purchases" ? "default" : "outline"}
          onClick={() => switchTab("purchases")}
          className="gap-2 font-bold"
        >
          <Building2 className="size-4" aria-hidden />
          مشتريات الموردين
        </Button>

        <Button
          variant={activeTab === "forensic" ? "default" : "outline"}
          onClick={() => switchTab("forensic")}
          className="gap-2 font-bold border-[var(--sem-warn)]/40 text-stock-low"
        >
          <FileSearch className="size-4" aria-hidden />
          التحري الجنائي (فواتير مفقودة)
        </Button>

        <Button
          variant={activeTab === "ledger" ? "default" : "outline"}
          onClick={() => switchTab("ledger")}
          className="gap-2 font-bold"
        >
          <BookOpen className="size-4" aria-hidden />
          سجل المرتجعات والتدقيق
        </Button>
      </div>

      {/* ═════════════════════════════════════════════════════════════════════ */}
      {/* ١) تبويب مبيعات التجزئة (Retail Sales Tab)                             */}
      {/* ═════════════════════════════════════════════════════════════════════ */}
      {activeTab === "sales" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* العمود الأيمن: منتقي الفواتير + الطلبات المعلقة */}
          <div className="lg:col-span-5 space-y-4">
            {/* بطاقة الطلبات المعلقة إن وجدت */}
            {pendingCount > 0 && (
              <Card className="border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/20">
                <CardHeader className="p-3 pb-2">
                  <CardTitle className="text-sm font-bold flex items-center gap-2 text-stock-low">
                    <Clock className="size-4" aria-hidden />
                    طلبات إرجاع بانتظار الاعتماد ({pendingCount})
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0 space-y-2">
                  {(pendingRequestsQuery.data ?? []).map((req) => (
                    <div
                      key={req.id}
                      className="p-2 border rounded-md text-xs flex justify-between items-center bg-card"
                    >
                      <div>
                        <div className="font-bold">فاتورة #{req.invoiceId}</div>
                        <div className="text-muted-foreground">{req.reason}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setSelectedInvoiceId(req.invoiceId);
                          const p = new URLSearchParams(searchStr);
                          p.set("invoiceId", String(req.invoiceId));
                          p.set("requestId", String(req.id));
                          setLocation(`/returns?${p.toString()}`);
                        }}
                      >
                        اعتماد
                      </Button>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* بطاقة البحث عن فاتورة */}
            <Card>
              <CardHeader className="p-4 pb-2">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Search className="size-4" aria-hidden />
                  اختيار فاتورة بيع
                </CardTitle>
                <CardDescription className="text-xs">
                  ابحث برقم الفاتورة أو اسم الزبون لتسجيل مرتجع جديد
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4 pt-2 space-y-3">
                <Input
                  value={salesSearch}
                  onChange={(e) => setSalesSearch(e.target.value)}
                  placeholder="بحث (رقم الفاتورة / اسم العميل)..."
                />

                <DataTable
                  columns={salesInvoiceColumns}
                  data={salesInvoicesQuery.data?.rows ?? []}
                  loading={salesInvoicesQuery.isLoading}
                />
              </CardContent>
            </Card>
          </div>

          {/* العمود الأيسر: محرر المرتجع المرجعي الموحد */}
          <div className="lg:col-span-7">
            {selectedInvoiceId ? (
              <ReturnComposer
                invoiceId={selectedInvoiceId}
                approvingRequestId={approvingRequestId}
                onDone={() => {
                  setSelectedInvoiceId(null);
                  utils.sales.listPage.invalidate();
                  utils.returns.requests.invalidate();
                }}
              />
            ) : (
              <Card className="h-64 flex flex-col items-center justify-center text-center p-6 border-dashed">
                <Receipt className="size-12 text-muted-foreground/40 mb-3" aria-hidden />
                <h3 className="font-bold text-sm">اختر فاتورة من القائمة</h3>
                <p className="text-xs text-muted-foreground max-w-sm mt-1">
                  اختر فاتورة بيع من القائمة الجانبية أو امسح الباركود لعرض بنودها ومطابقة سقف الاسترداد والدرج.
                </p>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* ═════════════════════════════════════════════════════════════════════ */}
      {/* ٢) تبويب المطبعة والاستنساخ (Print & Copy Center Tab)                  */}
      {/* ═════════════════════════════════════════════════════════════════════ */}
      {activeTab === "print" && (
        <div className="space-y-4">
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="p-4 text-xs space-y-2">
              <div className="font-bold text-sm flex items-center gap-2 text-primary">
                <ShieldCheck className="size-4" aria-hidden />
                حوكمة مرتجعات وأوامر الشغل الطباعية
              </div>
              <p className="text-muted-foreground">
                المواد الخام (أوراق غير مطبوعة، باجات، دروع فارغة) تُعاد للمخزن.
                أجور التصميم والطباعة والتجليد هدر إنتاجي يُسجل في أمر الشغل؛ ويمكن إعادة الطباعة (Rework)
                أو عكس تسليم الطلب من تفاصيل أمر الشغل مباشرةً.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Printer className="size-4" aria-hidden />
                أوامر الشغل والاستنساخ
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              <Input
                value={printSearch}
                onChange={(e) => setPrintSearch(e.target.value)}
                placeholder="ابحث برقم أمر الشغل (WO-XXXX) أو عنوان العمل..."
                className="max-w-md"
              />

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pt-2">
                {(workOrdersQuery.data ?? []).map((wo) => (
                  <Card key={wo.id} className="p-3 flex flex-col justify-between border">
                    <div>
                      <div className="flex justify-between items-start">
                        <span className="font-mono font-bold text-xs">#{wo.orderNumber}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {wo.status}
                        </Badge>
                      </div>
                      <div className="font-semibold text-sm mt-1">{wo.title}</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        السعر: {fmt(wo.salePrice)} | العربون: {fmt(wo.deposit ?? "0")}
                      </div>
                    </div>
                    <div className="mt-3 pt-2 border-t flex justify-end">
                      <Button size="sm" variant="outline" asChild>
                        <Link href={`/work-orders/${wo.id}`}>معاينة وعكس التسليم</Link>
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ═════════════════════════════════════════════════════════════════════ */}
      {/* ٣) تبويب التوصيل والاستقبال (Delivery & Reception Tab)                */}
      {/* ═════════════════════════════════════════════════════════════════════ */}
      {activeTab === "delivery" && (
        <div className="space-y-4">
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Truck className="size-4" aria-hidden />
                طرود التوصيل قيد التوصيل واستلام المرتجع
              </CardTitle>
              <CardDescription className="text-xs">
                استلام الطرود المرتجعة من المندوب وعكس عهدة الشحن وإعادة البضاعة للمخزن
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              <Input
                value={deliverySearch}
                onChange={(e) => setDeliverySearch(e.target.value)}
                placeholder="ابحث برقم الإرسالية (DLV-XXX) أو رقم الفاتورة أو اسم المندوب..."
                className="max-w-md"
              />

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {filteredConsignments.map((cnRow) => (
                  <Card key={cnRow.id} className="p-3 flex flex-col justify-between border">
                    <div>
                      <div className="flex justify-between items-start">
                        <span className="font-mono font-bold text-xs">#{cnRow.consignmentNumber}</span>
                        <Badge variant="secondary" className="text-[10px]">
                          {cnRow.parcelStatus ?? "قيد التوصيل"}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground mt-2">
                        فاتورة #{cnRow.invoiceId} | الأجرة: {fmt(cnRow.deliveryFee)}
                      </div>
                    </div>
                    <div className="mt-3 pt-2 border-t flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() =>
                          setDeliveryTarget({
                            consignmentId: cnRow.id,
                            label: `#${cnRow.consignmentNumber} - فاتورة #${cnRow.invoiceId}`,
                          })
                        }
                      >
                        تسجيل إرجاع الطرد
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </CardContent>
          </Card>

          {deliveryTarget && (
            <ReturnConsignmentDialog
              target={deliveryTarget}
              pending={returnDeliveryMutation.isPending}
              onClose={() => setDeliveryTarget(null)}
              onConfirm={({ consignmentId, refundShiftId }) => {
                returnDeliveryMutation.mutate({
                  consignmentId,
                  refundShiftId,
                  clientRequestId: crypto.randomUUID(),
                });
              }}
            />
          )}
        </div>
      )}

      {/* ═════════════════════════════════════════════════════════════════════ */}
      {/* ٤) تبويب مشتريات الموردين (Purchases & Suppliers Tab)                 */}
      {/* ═════════════════════════════════════════════════════════════════════ */}
      {activeTab === "purchases" && (
        <div className="space-y-4">
          <PurchaseReturnsGovernance />
        </div>
      )}

      {/* ═════════════════════════════════════════════════════════════════════ */}
      {/* ٥) محرك التحري الجنائي للفواتير المفقودة (Forensic Investigation Tab)  */}
      {/* ═════════════════════════════════════════════════════════════════════ */}
      {activeTab === "forensic" && (
        <div className="space-y-6">
          {/* بطاقة التوجيه الأمني */}
          <Card className="border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)]/20">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm font-bold flex items-center gap-2 text-stock-low">
                <ShieldAlert className="size-4" aria-hidden />
                محرك التقصي الجنائي وبروتوكول الإرجاع بدون فاتورة
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-1 text-xs space-y-2 text-muted-foreground">
              <p>
                استخدم العدسات الأربع للعثور على الفاتورة الأصلية. في حال تعذر العثور التام: يُقفل الإرجاع
                على <strong>أدنى سعر بيع تاريخي</strong> مع <strong>منع صرف النقد كاش نهائياً</strong>،
                ويُستعاض عنه بإصدار قسيمة رصيد متجر (Store Credit) أو استبدال فوري بموافقة المدير.
              </p>
            </CardContent>
          </Card>

          {/* محدد العدسة والبحث */}
          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2">
                <Button
                  type="button"
                  variant={forensicMode === "ITEM_BARCODE" ? "default" : "outline"}
                  onClick={() => setForensicMode("ITEM_BARCODE")}
                  className="text-xs justify-start gap-2"
                >
                  <ScanLine className="size-4" aria-hidden />
                  عدسة باركود الصنف
                </Button>
                <Button
                  type="button"
                  variant={forensicMode === "CARD_LAST4" ? "default" : "outline"}
                  onClick={() => setForensicMode("CARD_LAST4")}
                  className="text-xs justify-start gap-2"
                >
                  <CreditCard className="size-4" aria-hidden />
                  عدسة البطاقة والدفع
                </Button>
                <Button
                  type="button"
                  variant={forensicMode === "CUSTOMER_PHONE" ? "default" : "outline"}
                  onClick={() => setForensicMode("CUSTOMER_PHONE")}
                  className="text-xs justify-start gap-2"
                >
                  <UserCheck className="size-4" aria-hidden />
                  عدسة هاتف الزبون
                </Button>
                <Button
                  type="button"
                  variant={forensicMode === "DATE_SHIFT" ? "default" : "outline"}
                  onClick={() => setForensicMode("DATE_SHIFT")}
                  className="text-xs justify-start gap-2"
                >
                  <Clock className="size-4" aria-hidden />
                  عدسة الوردية والتاريخ
                </Button>
              </div>

              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute right-3 top-3 size-4 text-muted-foreground" aria-hidden />
                  <Input
                    value={forensicQuery}
                    onChange={(e) => setForensicQuery(e.target.value)}
                    placeholder={
                      forensicMode === "ITEM_BARCODE"
                        ? "امسح باركود الصنف أو اكتب اسمه..."
                        : forensicMode === "CARD_LAST4"
                        ? "اكتب آخر ٤ أرقام من البطاقة البنكية أو الرقم المرجعي..."
                        : forensicMode === "CUSTOMER_PHONE"
                        ? "اكتب رقم هاتف العميل أو اسمه..."
                        : "اكتب رقم الوردية أو التاريخ..."
                    }
                    className="pr-9"
                  />
                </div>
                <AppSelect
                  value={String(forensicDays)}
                  onValueChange={(v) => setForensicDays(Number(v))}
                >
                  <option value="7">آخر ٧ أيام</option>
                  <option value="15">آخر ١٥ يوماً</option>
                  <option value="30">آخر ٣٠ يوماً</option>
                  <option value="60">آخر ٦٠ يوماً</option>
                </AppSelect>
              </div>

              {/* أدنى سعر تاريخي محدد إذا كانت العدسة هي الصنف */}
              {forensicTraceQuery.data?.lowestHistoricalPrice && (
                <div className="p-3 bg-muted/40 rounded-lg flex flex-wrap gap-2 items-center justify-between text-xs">
                  <div>
                    <span className="text-muted-foreground">أدنى سعر بيع تاريخي للصنف (خلال ٦٠ يوماً): </span>
                    <span className="font-bold text-primary font-mono text-sm">
                      {fmt(forensicTraceQuery.data.lowestHistoricalPrice)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      سقف بروتوكول عدم الفاتورة
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      onClick={() => {
                        const firstRes = forensicTraceQuery.data?.results[0];
                        setNoReceiptItem({
                          productName: firstRes?.matchedItem?.productName || forensicQuery,
                          sku: null,
                          barcode: forensicQuery,
                          lowestHistoricalPrice: forensicTraceQuery.data?.lowestHistoricalPrice ?? "0",
                        });
                        setNoReceiptOpen(true);
                      }}
                      className="gap-1.5 text-xs"
                    >
                      <ShieldAlert className="size-3.5" aria-hidden />
                      بدء إرجاع بدون فاتورة (رصيد متجر)
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* جدول نتائج التحري الجنائي */}
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm font-bold flex items-center justify-between">
                <span>نتائج التحري والمطابقة ({forensicTraceQuery.data?.results.length ?? 0})</span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setNoReceiptItem({
                        productName: forensicQuery || "صنف مرتجع بدون فاتورة",
                        sku: null,
                        barcode: forensicQuery || null,
                        lowestHistoricalPrice: forensicTraceQuery.data?.lowestHistoricalPrice ?? "0",
                      });
                      setNoReceiptOpen(true);
                    }}
                    className="text-xs gap-1.5"
                  >
                    <ShieldAlert className="size-3.5" aria-hidden />
                    إرجاع استثنائي (بدون فاتورة)
                  </Button>
                  {forensicTraceQuery.isFetching && (
                    <span className="text-xs text-muted-foreground font-normal">
                      {ACTION_LABELS.loading}
                    </span>
                  )}
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              <DataTable
                columns={forensicColumns}
                data={forensicTraceQuery.data?.results ?? []}
                loading={forensicTraceQuery.isLoading}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {/* ═════════════════════════════════════════════════════════════════════ */}
      {/* ٦) تبويب سجل المرتجعات والتدقيق المحاسبي (Returns Ledger Tab)         */}
      {/* ═════════════════════════════════════════════════════════════════════ */}
      {activeTab === "ledger" && <ReturnsLedgerView />}

      {/* نافذة بروتوكول الإرجاع بدون فاتورة */}
      <NoReceiptReturnDialog
        open={noReceiptOpen}
        onOpenChange={setNoReceiptOpen}
        item={noReceiptItem}
      />
    </div>
  );
}
