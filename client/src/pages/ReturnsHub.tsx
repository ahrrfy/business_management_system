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
  ArrowLeftRight,
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
import PurchaseReturns from "@/pages/PurchaseReturns";
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
import { cn } from "@/lib/utils";

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
  const [scannedItemBarcode, setScannedItemBarcode] = useState<string | null>(null);

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
          if (activeTab === "sales" && selectedInvoiceId) {
            setScannedItemBarcode(barcode);
            notify.info(`تم توجيه باركود الصنف إلى الفاتورة المحددة`);
          } else {
            setForensicQuery(barcode);
            setForensicMode("ITEM_BARCODE");
            switchTab("forensic");
            notify.info(`تم التعرف على باركود صنف — جاري التقصي الجنائي في الفواتير`);
          }
        }
      } else {
        if (activeTab === "sales" && selectedInvoiceId) {
          setScannedItemBarcode(barcode);
        } else {
          setForensicQuery(barcode);
          setForensicMode("ITEM_BARCODE");
          switchTab("forensic");
          notify.info(`رمز غير مباشر — تم تفعيل محرك التقصي الجنائي`);
        }
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
    <div className="space-y-4 pb-12">
      {/* الترويسة الرئيسية */}
      <PageHeader
        title="بوابة المرتجعات المركزية"
        backHref="/invoices"
        backLabel="المبيعات"
      />

      {/* شريط المسح الكوني للباركود والتنبيهات المدمجة */}
      <Card className="p-2.5 shadow-2xs">
        <CardContent className="p-0 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <form onSubmit={handleUniversalScan} className="flex-1 flex items-center gap-2">
            <div className="relative flex-1">
              <ScanLine className="absolute right-3 top-2.5 size-4 text-muted-foreground" aria-hidden />
              <Input
                value={universalBarcode}
                onChange={(e) => setUniversalBarcode(e.target.value)}
                placeholder="امسح أي باركود: فاتورة INV، صنف، طرد توصيل DLV، أمر مطبعة WO..."
                className="pr-9 h-9 font-mono text-xs"
                autoFocus
              />
            </div>
            <Button type="submit" size="sm" className="h-9 gap-1.5 shrink-0" disabled={isScanning || !universalBarcode.trim()}>
              {isScanning ? ACTION_LABELS.loading : "مسح وتوجيه"}
            </Button>
          </form>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setNoReceiptItem(null);
              setNoReceiptOpen(true);
            }}
            className="h-9 shrink-0 gap-1.5 border-dashed border-primary/50 bg-primary/5 text-primary hover:bg-primary/10 font-bold text-xs shadow-2xs"
          >
            <ArrowLeftRight className="size-3.5" aria-hidden />
            <span>سلة الإرجاع والاستبدال (بدون فاتورة)</span>
          </Button>

          {pendingCount > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => switchTab("sales")}
              className="h-9 shrink-0 gap-1.5 border-[var(--sem-warn)]/50 bg-[var(--sem-warn-bg)]/30 text-stock-low hover:bg-[var(--sem-warn-bg)]/50 font-bold text-xs"
            >
              <Clock className="size-3.5" aria-hidden />
              <span>{pendingCount} طلب بانتظار الاعتماد</span>
            </Button>
          )}
        </CardContent>
      </Card>

      {/* شريط التبويبات المقطعي الرشيق الموحد */}
      <div className="bg-muted/40 p-1 rounded-xl border flex flex-wrap lg:flex-nowrap gap-1 items-center text-xs font-semibold">
        <button
          type="button"
          onClick={() => switchTab("sales")}
          className={cn(
            "flex-1 min-w-[130px] flex items-center justify-center gap-2 py-2 px-3 rounded-lg transition-all text-xs font-bold",
            activeTab === "sales"
              ? "bg-background text-foreground shadow-2xs border"
              : "text-muted-foreground hover:text-foreground hover:bg-background/50"
          )}
        >
          <Receipt className="size-4 shrink-0" aria-hidden />
          <span>مرتجعات التجزئة</span>
          {pendingCount > 0 && (
            <Badge variant="destructive" className="mr-1 text-[10px] px-1.5 py-0">
              {pendingCount}
            </Badge>
          )}
        </button>

        <button
          type="button"
          onClick={() => switchTab("print")}
          className={cn(
            "flex-1 min-w-[130px] flex items-center justify-center gap-2 py-2 px-3 rounded-lg transition-all text-xs font-bold",
            activeTab === "print"
              ? "bg-background text-foreground shadow-2xs border"
              : "text-muted-foreground hover:text-foreground hover:bg-background/50"
          )}
        >
          <Printer className="size-4 shrink-0" aria-hidden />
          <span>المطبعة والاستنساخ</span>
        </button>

        <button
          type="button"
          onClick={() => switchTab("delivery")}
          className={cn(
            "flex-1 min-w-[130px] flex items-center justify-center gap-2 py-2 px-3 rounded-lg transition-all text-xs font-bold",
            activeTab === "delivery"
              ? "bg-background text-foreground shadow-2xs border"
              : "text-muted-foreground hover:text-foreground hover:bg-background/50"
          )}
        >
          <Truck className="size-4 shrink-0" aria-hidden />
          <span>التوصيل والاستقبال</span>
        </button>

        <button
          type="button"
          onClick={() => switchTab("purchases")}
          className={cn(
            "flex-1 min-w-[130px] flex items-center justify-center gap-2 py-2 px-3 rounded-lg transition-all text-xs font-bold",
            activeTab === "purchases"
              ? "bg-background text-foreground shadow-2xs border"
              : "text-muted-foreground hover:text-foreground hover:bg-background/50"
          )}
        >
          <Building2 className="size-4 shrink-0" aria-hidden />
          <span>مشتريات الموردين</span>
        </button>

        <button
          type="button"
          onClick={() => switchTab("forensic")}
          className={cn(
            "flex-1 min-w-[130px] flex items-center justify-center gap-2 py-2 px-3 rounded-lg transition-all text-xs font-bold",
            activeTab === "forensic"
              ? "bg-background text-stock-low shadow-2xs border border-[var(--sem-warn)]/40"
              : "text-muted-foreground hover:text-stock-low hover:bg-background/50"
          )}
        >
          <FileSearch className="size-4 shrink-0" aria-hidden />
          <span>التحري الجنائي (مفقودة)</span>
        </button>

        <button
          type="button"
          onClick={() => switchTab("ledger")}
          className={cn(
            "flex-1 min-w-[130px] flex items-center justify-center gap-2 py-2 px-3 rounded-lg transition-all text-xs font-bold",
            activeTab === "ledger"
              ? "bg-background text-foreground shadow-2xs border"
              : "text-muted-foreground hover:text-foreground hover:bg-background/50"
          )}
        >
          <BookOpen className="size-4 shrink-0" aria-hidden />
          <span>سجل القيود والتدقيق</span>
        </button>
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
              <CardContent className="p-4 pt-1">
                <DataTable
                  columns={salesInvoiceColumns}
                  data={salesInvoicesQuery.data?.rows ?? []}
                  loading={salesInvoicesQuery.isLoading}
                  searchable={true}
                  searchPlaceholder="بحث برقم الفاتورة أو اسم العميل..."
                  serverSearch={{
                    value: salesSearch,
                    onChange: setSalesSearch,
                  }}
                  pageSize={20}
                  embedded
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
                scannedBarcode={scannedItemBarcode}
                onBarcodeHandled={() => setScannedItemBarcode(null)}
                onDone={() => {
                  setSelectedInvoiceId(null);
                  setScannedItemBarcode(null);
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
          <div className="p-3 text-xs rounded-xl bg-primary/5 border border-primary/20 text-muted-foreground flex items-center gap-2.5">
            <ShieldCheck className="size-4 text-primary shrink-0" aria-hidden />
            <span>
              <strong>حوكمة مرتجعات أوامر الشغل:</strong> المواد الخام تُعاد للمخزن، وأجور التصميم والطباعة هدر إنتاجي يُوثق في أمر الشغل مباشرة مع إمكانية عكس التسليم أو إعادة التشغيل.
            </span>
          </div>

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
          <PurchaseReturns embedded />
        </div>
      )}

      {/* ═════════════════════════════════════════════════════════════════════ */}
      {/* ٥) محرك التحري الجنائي للفواتير المفقودة (Forensic Investigation Tab)  */}
      {/* ═════════════════════════════════════════════════════════════════════ */}
      {activeTab === "forensic" && (
        <div className="space-y-6">
          {/* شريط التوجيه الأمني */}
          <div className="p-3 text-xs rounded-xl border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)]/20 text-muted-foreground flex items-start gap-2.5">
            <ShieldAlert className="size-4 text-stock-low shrink-0 mt-0.5" aria-hidden />
            <div>
              <strong className="text-stock-low">محرك التقصي الجنائي وبروتوكول عدم الفاتورة:</strong> استخدم العدسات الأربع للعثور على الفاتورة الأصلية. في حال تعذر العثور التام: يُقفل الإرجاع على <strong>أدنى سعر بيع تاريخي</strong> مع <strong>منع صرف النقد كاش نهائياً</strong> والاستعاضة عنه برصيد متجر أو استبدال فوري بموافقة المدير.
            </div>
          </div>

          {/* محدد العدسة والبحث */}
          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 p-1 bg-muted/40 rounded-xl border">
                <button
                  type="button"
                  onClick={() => setForensicMode("ITEM_BARCODE")}
                  className={cn(
                    "flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-semibold transition-all",
                    forensicMode === "ITEM_BARCODE"
                      ? "bg-background text-primary shadow-2xs border"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <ScanLine className="size-3.5 shrink-0" aria-hidden />
                  <span>باركود الصنف</span>
                </button>
                <button
                  type="button"
                  onClick={() => setForensicMode("CARD_LAST4")}
                  className={cn(
                    "flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-semibold transition-all",
                    forensicMode === "CARD_LAST4"
                      ? "bg-background text-primary shadow-2xs border"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <CreditCard className="size-3.5 shrink-0" aria-hidden />
                  <span>البطاقة والدفع</span>
                </button>
                <button
                  type="button"
                  onClick={() => setForensicMode("CUSTOMER_PHONE")}
                  className={cn(
                    "flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-semibold transition-all",
                    forensicMode === "CUSTOMER_PHONE"
                      ? "bg-background text-primary shadow-2xs border"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <UserCheck className="size-3.5 shrink-0" aria-hidden />
                  <span>هاتف العميل</span>
                </button>
                <button
                  type="button"
                  onClick={() => setForensicMode("DATE_SHIFT")}
                  className={cn(
                    "flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-semibold transition-all",
                    forensicMode === "DATE_SHIFT"
                      ? "bg-background text-primary shadow-2xs border"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Clock className="size-3.5 shrink-0" aria-hidden />
                  <span>الوردية والتاريخ</span>
                </button>
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
                searchable={false}
                pageSize={20}
                emptyText={
                  debouncedForensicQuery.length >= 2
                    ? "لا توجد فواتير مطابقة لبيانات التحري في النطاق الزمني المحدد"
                    : "امسح باركود الصنف أو اكتب بيانات العميل/البطاقة لبدء التحري"
                }
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
