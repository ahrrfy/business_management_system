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
import { LoadingState } from "@/components/PageState";
import { PageHeader } from "@/components/PageHeader";
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

  const urlParams = useMemo(() => new URLSearchParams(searchStr), [searchStr]);
  const portalParam = urlParams.get("portal") || urlParams.get("tab");
  const initialMode = (portalParam === "purchases" ? "purchases" : "sales") as ReturnPortalMode;
  const [portalMode, setPortalMode] = useState<ReturnPortalMode>(initialMode);
  const initialInvoice = urlParams.get("invoice") || undefined;
  const initialPo = urlParams.get("po") || undefined;

  const viewParam = urlParams.get("view");
  const [subTab, setSubTab] = useState<"create" | "history">(
    viewParam === "history" || viewParam === "ledger" ? "history" : "create"
  );

  const switchPortal = (mode: ReturnPortalMode) => {
    setPortalMode(mode);
    const p = new URLSearchParams(searchStr);
    p.set("portal", mode);
    setLocation(`/returns?${p.toString()}`);
  };

  const switchSubTab = (tab: "create" | "history") => {
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
    const dateStr = now.toLocaleDateString("ar-IQ", { year: "numeric", month: "long", day: "numeric" });
    const timeStr = now.toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" });

    setRecentOps((prev) => [
      {
        id: data.returnNumber,
        type: "SALES",
        docNumber: data.returnNumber,
        partyName: data.customerName,
        amount: data.totalAmount,
        method: data.method === "CASH" ? "نقدي" : data.method === "CARD" ? "بطاقة" : "رصيد متجر",
        date: `${dateStr} ${timeStr}`,
        itemsCount: data.items.reduce((sum, itm) => sum + itm.quantity, 0),
        rawSalesData: data,
      },
      ...prev.slice(0, 9),
    ]);
  };

  const handlePurchaseSuccess = (data: PrintPurchaseReturnData) => {
    const now = new Date();
    const dateStr = now.toLocaleDateString("ar-IQ", { year: "numeric", month: "long", day: "numeric" });
    const timeStr = now.toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" });

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

  return (
    <div className="space-y-3.5 pb-12">
      {/* الترويسة الرئيسية */}
      <PageHeader
        title="بوابة المرتجعات الموحدة"
        description="منظومة متكاملة لمرتجعات المبيعات ومشتريات الموردين بربط ذري فوري ومخزني ومحاسبي وطباعة حرارية"
        backHref="/"
        backLabel="الرئيسية"
      />

      {/* ═════════════════════════════════════════════════════════════════════ */}
      {/* المنفذان الرئيسيان: أزرار واضحة وهوية بصرية دالة ومميزة               */}
      {/* ═════════════════════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <button
          type="button"
          onClick={() => switchPortal("sales")}
          className={cn(
            "relative p-2.5 rounded-xl border-2 text-right transition-all flex items-center gap-3 text-start cursor-pointer shadow-xs",
            portalMode === "sales"
              ? "border-primary bg-primary/5 dark:bg-primary/10 shadow-xs ring-2 ring-primary/20"
              : "border-border hover:border-primary/40 bg-card hover:bg-muted/30 opacity-80 hover:opacity-100"
          )}
        >
          <div
            className={cn(
              "p-2 rounded-lg shrink-0 transition-colors",
              portalMode === "sales"
                ? "bg-primary text-primary-foreground shadow-xs"
                : "bg-muted text-muted-foreground"
            )}
          >
            <ShoppingCart className="size-5" aria-hidden />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-sm text-foreground">
                مرتجعات المبيعات (العملاء والتجزئة)
              </span>
              {portalMode === "sales" && (
                <Badge className="bg-primary text-primary-foreground text-[10px] px-1.5 py-0">
                  المنفذ النشط
                </Badge>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground truncate">
              مسح الباركود، الفاتورة، العميل، فرز السليم والتالف، والاسترداد المالي
            </p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => switchPortal("purchases")}
          className={cn(
            "relative p-2.5 rounded-xl border-2 text-right transition-all flex items-center gap-3 text-start cursor-pointer shadow-xs",
            portalMode === "purchases"
              ? "border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 shadow-xs ring-2 ring-blue-500/20"
              : "border-border hover:border-blue-300/80 bg-card hover:bg-muted/30 opacity-80 hover:opacity-100"
          )}
        >
          <div
            className={cn(
              "p-2 rounded-lg shrink-0 transition-colors",
              portalMode === "purchases"
                ? "bg-blue-600 text-white shadow-xs"
                : "bg-muted text-muted-foreground"
            )}
          >
            <Building2 className="size-5" aria-hidden />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-sm text-foreground">
                مرتجعات الشراء (الموردين والشركات)
              </span>
              {portalMode === "purchases" && (
                <Badge className="bg-blue-600 text-white hover:bg-blue-700 text-[10px] px-1.5 py-0">
                  المنفذ النشط
                </Badge>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground truncate">
              المورد وكشف الرصيد، سلة التكلفة بالباركود، ومعادلة الذمم أو النقد
            </p>
          </div>
        </button>
      </div>

      {/* ═════════════════════════════════════════════════════════════════════ */}
      {/* التبديل بين منفذ الإنشاء المباشر والسجل التاريخي الشامل               */}
      {/* ═════════════════════════════════════════════════════════════════════ */}
      <div className="flex items-center justify-between border-b pb-2 pt-1">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant={subTab === "create" ? "default" : "outline"}
            size="sm"
            onClick={() => switchSubTab("create")}
            className="text-xs h-8 gap-1.5"
          >
            <RotateCcw className="size-3.5" />
            <span>بوابة الإرجاع والتسوية الفورية</span>
          </Button>
          <Button
            type="button"
            variant={subTab === "history" ? "default" : "outline"}
            size="sm"
            onClick={() => switchSubTab("history")}
            className="text-xs h-8 gap-1.5"
          >
            <History className="size-3.5" />
            <span>
              {portalMode === "sales"
                ? "سجل وأرشيف مرتجعات المبيعات"
                : "سجل وأرشيف مرتجعات المشتريات"}
            </span>
          </Button>
        </div>
      </div>

      {/* ═════════════════════════════════════════════════════════════════════ */}
      {/* عرض المنفذ النشط أو السجل التاريخي                                   */}
      {/* ═════════════════════════════════════════════════════════════════════ */}
      {subTab === "create" ? (
        <>
          {portalMode === "sales" ? (
            <SalesReturnPortal
              initialInvoiceNo={initialInvoice}
              onReturnSuccess={handleSalesSuccess}
            />
          ) : (
            <PurchaseReturnPortal
              initialPoRef={initialPo}
              onReturnSuccess={handlePurchaseSuccess}
            />
          )}
        </>
      ) : (
        <Suspense fallback={<LoadingState />}>
          {portalMode === "sales" ? (
            <SalesReturns embedded />
          ) : (
            <PurchaseReturns embedded />
          )}
        </Suspense>
      )}

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
