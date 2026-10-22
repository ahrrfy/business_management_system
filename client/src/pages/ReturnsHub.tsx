/**
 * ReturnsHub — بوابة المرتجعات الموحدة
 *
 * تتكون من منفذين رئيسيين متكاملين:
 *  ١) مرتجعات المبيعات (SalesReturnPortal): سلة الباركود، الفاتورة الاختيارية، العميل من CRM، رجوع للرف/تالف، ونقدي/بطاقة/رصيد
 *  ٢) مرتجعات الشراء (PurchaseReturnPortal): اختيار المورد ورصيده، الرقم المرجعي، سلة التكلفة، ومعادلة الذمة أو النقد
 * ربط ذري متكامل نقدياً ومخزنياً ومحاسبياً مع الطباعة الحرارية.
 */
import React, { useEffect, useMemo, useState, lazy, Suspense } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  Building2,
  Clock,
  History,
  Printer,
  RotateCcw,
  ShoppingCart,
} from "lucide-react";
import { ErrorState, LoadingState } from "@/components/PageState";
import { EmbeddedPageHeaderProvider, PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  printSalesReturnReceipt,
  printPurchaseReturnVoucher,
  type PrintSalesReturnData,
  type PrintPurchaseReturnData,
} from "@/components/returns/printThermalReturnReceipt";
import { SalesReturnPortal } from "@/components/returns/SalesReturnPortal";
import { PurchaseReturnPortal } from "@/components/returns/PurchaseReturnPortal";
import { ReturnComposer } from "@/components/returns/ReturnComposer";
import { useOperationPermission } from "@/hooks/useOperationPermission";
import { trpc } from "@/lib/trpc";

const SalesReturns = lazy(() => import("@/pages/SalesReturns"));
const PurchaseReturns = lazy(() => import("@/pages/PurchaseReturns"));

export type ReturnPortalMode = "sales" | "purchases";

interface RecentOp {
  id: string;
  type: "SALES" | "PURCHASE";
  docNumber: string;
  partyName: string;
  amount: string;
  method: string;
  date: string;
  itemsCount: number;
  rawSalesData?: PrintSalesReturnData;
  rawPurchaseData?: PrintPurchaseReturnData;
}

export default function ReturnsHub() {
  const [, setLocation] = useLocation();
  const searchStr = useSearch();
  const canExecuteSalesReturnCart = useOperationPermission(
    "returns.executeSalesReturnCart",
  ).allowed;
  const canInspectInvoiceForReturn = useOperationPermission(
    "returns.inspectInvoiceForReturn",
  ).allowed;
  const canGetOpenRefundDrawers = useOperationPermission(
    "returns.getOpenRefundDrawers",
  ).allowed;
  const canLookupItemForReturn = useOperationPermission(
    "returns.lookupItemForReturn",
  ).allowed;
  const canUniversalScan = useOperationPermission(
    "returns.universalScan",
  ).allowed;
  const canForensicTrace = useOperationPermission(
    "returns.forensicTrace",
  ).allowed;
  const canExecuteSalesReturn =
    canExecuteSalesReturnCart &&
    canInspectInvoiceForReturn &&
    canGetOpenRefundDrawers &&
    canLookupItemForReturn &&
    canUniversalScan &&
    canForensicTrace;
  const canExecutePurchaseReturnCart = useOperationPermission(
    "returns.executePurchaseReturnCart",
  ).allowed;
  const canListSuppliers = useOperationPermission("suppliers.list").allowed;
  const canExecutePurchaseReturn =
    canExecutePurchaseReturnCart &&
    canLookupItemForReturn &&
    canListSuppliers;
  const canListSalesReturns = useOperationPermission("returns.list").allowed;
  const canListPurchaseReturns =
    useOperationPermission("purchaseReturns.list").allowed && canListSuppliers;
  const canAccessSalesPortal =
    canExecuteSalesReturn || canListSalesReturns;
  const canAccessPurchasePortal =
    canExecutePurchaseReturn || canListPurchaseReturns;

  const urlParams = useMemo(() => new URLSearchParams(searchStr), [searchStr]);
  const requestIdParam = Number(urlParams.get("requestId"));
  const approvingRequestId =
    Number.isSafeInteger(requestIdParam) && requestIdParam > 0
      ? requestIdParam
      : null;
  const approvalRequest = trpc.returns.getRequest.useQuery(
    { requestId: approvingRequestId ?? 0 },
    { enabled: approvingRequestId != null },
  );
  const portalParam = urlParams.get("portal") || urlParams.get("tab");
  const initialMode = (
    (portalParam === "purchases" && canAccessPurchasePortal) ||
    (!canAccessSalesPortal && canAccessPurchasePortal)
      ? "purchases"
      : "sales"
  ) as ReturnPortalMode;
  const [portalMode, setPortalMode] = useState<ReturnPortalMode>(initialMode);
  const initialInvoice = urlParams.get("invoice") || undefined;
  const initialReturnMode =
    urlParams.get("mode") === "FULL"
      ? ("FULL" as const)
      : urlParams.get("mode") === "PARTIAL"
        ? ("PARTIAL" as const)
        : undefined;
  const initialPo = urlParams.get("po") || undefined;
  const canCreateActivePortal =
    portalMode === "purchases" ? canExecutePurchaseReturn : canExecuteSalesReturn;
  const canViewActiveHistory =
    portalMode === "purchases" ? canListPurchaseReturns : canListSalesReturns;

  const viewParam = urlParams.get("view");
  const [subTab, setSubTab] = useState<"create" | "history">(
    (initialMode === "purchases"
      ? !canExecutePurchaseReturn && canListPurchaseReturns
      : !canExecuteSalesReturn && canListSalesReturns)
      ? "history"
      : (viewParam === "history" || viewParam === "ledger") &&
          (initialMode === "purchases"
            ? canListPurchaseReturns
            : canListSalesReturns)
        ? "history"
        : "create"
  );

  useEffect(() => {
    if (!canAccessPurchasePortal && portalMode === "purchases") {
      setPortalMode("sales");
      return;
    }
    if (!canAccessSalesPortal && canAccessPurchasePortal && portalMode === "sales") {
      setPortalMode("purchases");
      return;
    }
    if (
      !canCreateActivePortal &&
      canViewActiveHistory &&
      subTab === "create"
    ) {
      setSubTab("history");
      return;
    }
    if (!canViewActiveHistory && subTab === "history") {
      setSubTab("create");
    }
  }, [
    canAccessPurchasePortal,
    canAccessSalesPortal,
    canCreateActivePortal,
    canViewActiveHistory,
    portalMode,
    subTab,
  ]);

  const switchPortal = (mode: ReturnPortalMode) => {
    if (mode === "purchases" && !canAccessPurchasePortal) return;
    if (mode === "sales" && !canAccessSalesPortal) return;
    const canListTarget =
      mode === "purchases" ? canListPurchaseReturns : canListSalesReturns;
    const canCreateTarget =
      mode === "purchases" ? canExecutePurchaseReturn : canExecuteSalesReturn;
    setPortalMode(mode);
    const p = new URLSearchParams(searchStr);
    p.set("portal", mode);
    if (!canCreateTarget && canListTarget) {
      setSubTab("history");
      p.set("view", "history");
    } else if (subTab === "history" && !canListTarget) {
      setSubTab("create");
      p.delete("view");
    }
    setLocation(`/returns?${p.toString()}`);
  };

  const switchSubTab = (tab: "create" | "history") => {
    if (tab === "create" && !canCreateActivePortal) return;
    if (tab === "history" && !canViewActiveHistory) return;
    setSubTab(tab);
    const p = new URLSearchParams(searchStr);
    if (tab === "history") {
      p.set("view", "history");
    } else {
      p.delete("view");
    }
    setLocation(`/returns?${p.toString()}`);
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "F2") return;
      e.preventDefault();
      const el = document.querySelector<HTMLInputElement>("input[data-product-search='1']");
      el?.focus();
      el?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ═════════════════════════════════════════════════════════════════════════
  // العمليات الأخيرة والطباعة (Recent Operations & Printing)
  // ═════════════════════════════════════════════════════════════════════════
  const [recentOps, setRecentOps] = useState<RecentOp[]>([]);

  const handleSalesSuccess = (data: PrintSalesReturnData) => {
    const now = new Date();
    const dateStr = now.toLocaleDateString("ar-IQ-u-nu-latn", { year: "numeric", month: "long", day: "numeric" });
    const timeStr = now.toLocaleTimeString("ar-IQ-u-nu-latn", { hour: "2-digit", minute: "2-digit" });

    setRecentOps((prev) => [
      {
        id: data.returnNumber,
        type: "SALES",
        docNumber: data.returnNumber,
        partyName: data.customerName,
        amount: data.totalAmount,
        method:
          data.noCashNoAccount
            ? "تخفيض المتبقي — بلا استرداد"
            : data.method === "CASH"
            ? "نقدي"
            : data.method === "CARD"
              ? "بطاقة"
              : data.method === "CREDIT_OFFSET"
                ? "معادلة ذمم"
                : "رصيد متجر",
        date: `${dateStr} ${timeStr}`,
        itemsCount: data.items.reduce((sum, itm) => sum + itm.quantity, 0),
        rawSalesData: data,
      },
      ...prev.slice(0, 9),
    ]);
  };

  const handlePurchaseSuccess = (data: PrintPurchaseReturnData) => {
    const now = new Date();
    const dateStr = now.toLocaleDateString("ar-IQ-u-nu-latn", { year: "numeric", month: "long", day: "numeric" });
    const timeStr = now.toLocaleTimeString("ar-IQ-u-nu-latn", { hour: "2-digit", minute: "2-digit" });

    setRecentOps((prev) => [
      {
        id: data.returnNumber,
        type: "PURCHASE",
        docNumber: data.returnNumber,
        partyName: data.supplierName,
        amount: data.totalAmount,
        method:
          data.method === "CREDIT_OFFSET"
            ? "معادلة ذمة"
            : data.method === "CASH_IN"
            ? "مردود نقدي"
            : "تحويل بنكي",
        date: `${dateStr} ${timeStr}`,
        itemsCount: data.items.reduce((sum, itm) => sum + itm.quantity, 0),
        rawPurchaseData: data,
      },
      ...prev.slice(0, 9),
    ]);
  };

  const handlePrintRecent = (op: RecentOp) => {
    if (op.type === "SALES" && op.rawSalesData) {
      void printSalesReturnReceipt(op.rawSalesData);
    } else if (op.type === "PURCHASE" && op.rawPurchaseData) {
      void printPurchaseReturnVoucher(op.rawPurchaseData);
    }
  };

  // رابط قرار المرتجع يحمل معرّف الطلب وحده. الفاتورة تُشتق من الطلب المخزّن، فلا يمكن
  // تبديل invoice في الرابط وعرض فاتورةٍ ثم اعتماد طلبٍ يعود إلى فاتورة أخرى.
  if (approvingRequestId != null) {
    if (approvalRequest.isLoading) {
      return <LoadingState message="جارٍ تحميل طلب المرتجع…" />;
    }
    if (approvalRequest.isError) {
      return (
        <ErrorState
          message={approvalRequest.error.message}
          onRetry={() => void approvalRequest.refetch()}
        />
      );
    }
    if (!approvalRequest.data) {
      return <ErrorState message="طلب المرتجع غير موجود أو لا تملك صلاحية مراجعته." />;
    }
    if (approvalRequest.data.status !== "PENDING_APPROVAL") {
      return (
        <ErrorState
          message={`حُسم طلب المرتجع مسبقاً وحالته الآن: ${approvalRequest.data.status}.`}
        />
      );
    }

    return (
      <div className="space-y-4 pb-12">
        <PageHeader
          title="اعتماد طلب مرتجع بيع"
          description="راجع البنود والأثر المالي ثم حدّد حالة البضاعة ومسار الاسترداد إن وُجد."
          backHref="/my-work"
          backLabel="طلباتي"
        />
        <ReturnComposer
          invoiceId={approvalRequest.data.invoiceId}
          approvingRequestId={approvingRequestId}
          onDone={() => setLocation("/my-work")}
          footer={
            <Button asChild variant="outline">
              <Link href="/my-work">رجوع بلا اعتماد</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-2.5 pb-8">
      {/* الترويسة الرئيسية */}
      <PageHeader
        title="بوابة المرتجعات الموحدة"
        description="منظومة متكاملة لمرتجعات المبيعات ومشتريات الموردين بربط ذري فوري ومخزني ومحاسبي وطباعة حرارية"
        backHref="/"
        backLabel="الرئيسية"
      />

      {/* شريط مدمج موحد للتبديل بين منفذَي المبيعات والمشتريات ووضع البوابة أو السجل */}
      <Card className="py-1.5 gap-0">
        <CardContent className="px-3 py-0 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {canAccessSalesPortal && (
              <button
                type="button"
                onClick={() => switchPortal("sales")}
                className={cn(
                  "inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-bold transition-colors cursor-pointer",
                  portalMode === "sales"
                    ? "border-primary bg-primary text-primary-foreground shadow-xs"
                    : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <ShoppingCart className="size-3.5" aria-hidden />
                <span>مرتجعات المبيعات (العملاء والتجزئة)</span>
              </button>
            )}
            {canAccessPurchasePortal && (
              <button
                type="button"
                onClick={() => switchPortal("purchases")}
                className={cn(
                  "inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-bold transition-colors cursor-pointer",
                  portalMode === "purchases"
                    ? "border-blue-600 bg-blue-600 text-white shadow-xs"
                    : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <Building2 className="size-3.5" aria-hidden />
                <span>مرتجعات الشراء (الموردين والشركات)</span>
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {canCreateActivePortal && (
              <Button
                type="button"
                variant={subTab === "create" ? "default" : "outline"}
                size="sm"
                onClick={() => switchSubTab("create")}
                className="text-xs h-7 gap-1.5"
              >
                <RotateCcw className="size-3.5" />
                <span>بوابة الإرجاع والتسوية الفورية</span>
              </Button>
            )}
            {canViewActiveHistory && (
              <Button
                type="button"
                variant={subTab === "history" ? "default" : "outline"}
                size="sm"
                onClick={() => switchSubTab("history")}
                className="text-xs h-7 gap-1.5"
              >
                <History className="size-3.5" />
                <span>
                  {portalMode === "sales"
                    ? "سجل وأرشيف مرتجعات المبيعات"
                    : "سجل وأرشيف مرتجعات المشتريات"}
                </span>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* عرض المنفذ النشط أو السجل التاريخي */}
      <EmbeddedPageHeaderProvider>
        {subTab === "create" && canCreateActivePortal ? (
          <>
            {portalMode === "sales" ? (
              <SalesReturnPortal
                initialInvoiceNo={initialInvoice}
                initialMode={initialReturnMode}
                onReturnSuccess={handleSalesSuccess}
              />
            ) : (
              <PurchaseReturnPortal
                initialPoRef={initialPo}
                onReturnSuccess={handlePurchaseSuccess}
              />
            )}
          </>
        ) : canViewActiveHistory ? (
          <Suspense fallback={<LoadingState />}>
            {portalMode === "sales" ? (
              <SalesReturns embedded />
            ) : (
              <PurchaseReturns embedded />
            )}
          </Suspense>
        ) : null}
      </EmbeddedPageHeaderProvider>

      {/* ═════════════════════════════════════════════════════════════════════ */}
      {/* قسم العمليات المنجزة حديثاً وإعادة الطباعة الحرارية                   */}
      {/* ═════════════════════════════════════════════════════════════════════ */}
      {subTab === "create" && recentOps.length > 0 && (
        <Card className="shadow-xs border-muted mt-6">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-bold flex items-center justify-between">
              <div className="flex items-center gap-2 text-foreground">
                <Clock className="size-4 text-muted-foreground" aria-hidden />
                <span>العمليات المنجزة في هذه الجلسة ({recentOps.length})</span>
              </div>
              <span className="text-[11px] text-muted-foreground font-normal">
                يمكنك إعادة طباعة أي إيصال أو سند بنقرة واحدة
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            <div className="border rounded-xl overflow-hidden">
              <Table className="w-full text-xs text-right">
                <TableHeader className="bg-muted/50 text-muted-foreground font-semibold border-b">
                  <TableRow>
                    <TableHead className="p-2.5 text-right">رقم السند</TableHead>
                    <TableHead className="p-2.5 text-right">النوع</TableHead>
                    <TableHead className="p-2.5 text-right">الطرف (العميل / المورد)</TableHead>
                    <TableHead className="p-2.5 text-right">طريقة التسوية</TableHead>
                    <TableHead className="p-2.5 text-right">المبلغ (د.ع)</TableHead>
                    <TableHead className="p-2.5 text-right">الأصناف</TableHead>
                    <TableHead className="p-2.5 text-right">التاريخ والوقت</TableHead>
                    <TableHead className="p-2.5 text-center">طباعة حرارية</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="divide-y divide-border">
                  {recentOps.map((op) => (
                    <TableRow key={op.id} className="hover:bg-muted/20">
                      <TableCell className="p-2.5 font-mono font-bold">{op.docNumber}</TableCell>
                      <TableCell className="p-2.5">
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] px-1.5 py-0.5",
                            op.type === "SALES"
                              ? "border-primary text-primary"
                              : "border-blue-500 text-blue-700 dark:text-blue-300"
                          )}
                        >
                          {op.type === "SALES" ? "مرتجع مبيعات" : "مرتجع مشتريات"}
                        </Badge>
                      </TableCell>
                      <TableCell className="p-2.5 font-semibold">{op.partyName}</TableCell>
                      <TableCell className="p-2.5">{op.method}</TableCell>
                      <TableCell className="p-2.5 font-mono font-bold text-foreground">{fmt(op.amount)}</TableCell>
                      <TableCell className="p-2.5 text-muted-foreground">{op.itemsCount} قطعة</TableCell>
                      <TableCell className="p-2.5 text-muted-foreground font-mono text-[11px]">{op.date}</TableCell>
                      <TableCell className="p-2.5 text-center">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handlePrintRecent(op)}
                          className="h-7 text-xs gap-1.5 px-2.5"
                        >
                          <Printer className="size-3.5" />
                          <span>طباعة</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
