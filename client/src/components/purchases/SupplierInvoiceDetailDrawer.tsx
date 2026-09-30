import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LoadingState, ErrorState } from "@/components/PageState";
import { EmptyState } from "@/components/EmptyState";
import { fmtDate } from "@/lib/date";
import { fmt } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import {
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  RotateCcw,
  ShieldCheck,
  User,
  UserCheck,
} from "lucide-react";
import { Link } from "wouter";
import { CopyInline } from "@/components/CopyButton";
import { cn } from "@/lib/utils";

type SupplierInvoiceDetailOutput = NonNullable<RouterOutputs["supplierInvoiceApproval"]["get"]>;
type InvoiceLine = SupplierInvoiceDetailOutput["lines"][number];

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "مسودة",
  ON_HOLD: "محجوزة",
  MATCHED: "مطابقة — بانتظار الترحيل",
  POSTED: "مرحلة",
  REVERSED: "معكوسة",
};

const STATUS_CLASS: Record<string, string> = {
  DRAFT: "badge-status-pending",
  ON_HOLD: "badge-status-warning",
  MATCHED: "badge-status-info",
  POSTED: "badge-status-active",
  REVERSED: "badge-status-cancelled",
};

const SETTLEMENT_LABEL: Record<string, string> = {
  CASH: "نقدي",
  CREDIT: "آجل",
};

const SETTLEMENT_CLASS: Record<string, string> = {
  CASH: "badge-status-active",
  CREDIT: "badge-status-pending",
};

export function SupplierInvoiceDetailDrawer({
  supplierInvoiceId,
  open,
  onClose,
  onRequestReversal,
}: {
  supplierInvoiceId: number | null;
  open: boolean;
  onClose: () => void;
  onRequestReversal?: (invoice: SupplierInvoiceDetailOutput["invoice"]) => void;
}) {
  const [activeTab, setActiveTab] = useState<"items" | "governance">("items");

  const query = trpc.supplierInvoiceApproval.get.useQuery(
    { supplierInvoiceId: supplierInvoiceId ?? 0 },
    { enabled: !!supplierInvoiceId && open },
  );

  const data = query.data;
  const inv = data?.invoice;
  const lines = data?.lines ?? [];
  const matches = data?.matches ?? [];
  const approvals = data?.approvals ?? [];

  const currencySymbol = inv?.currency === "USD" ? "$" : "د.ع";

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent
        side="left"
        className="w-full sm:max-w-2xl overflow-y-auto p-4 sm:p-6"
        aria-describedby={undefined}
      >
        <SheetHeader className="border-b pb-4 mb-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <SheetTitle className="text-lg font-bold flex items-center gap-2">
                <FileText aria-hidden className="size-5 text-primary" />
                <span>فاتورة المورد:</span>
                <span className="font-mono" dir="ltr">{inv?.invoiceNumber ?? `#${supplierInvoiceId ?? ""}`}</span>
                {inv?.invoiceNumber && <CopyInline value={inv.invoiceNumber} />}
              </SheetTitle>
              {inv?.externalInvoiceNumber && (
                <div className="text-xs text-muted-foreground flex items-center gap-1 font-mono">
                  <span>رقم فاتورة المورد:</span>
                  <bdi dir="ltr">{inv.externalInvoiceNumber}</bdi>
                </div>
              )}
            </div>
            {inv?.status && (
              <span className={cn("px-2.5 py-1 text-xs rounded-md font-semibold w-fit", STATUS_CLASS[inv.status] ?? "bg-muted")}>
                {STATUS_LABEL[inv.status] ?? inv.status}
              </span>
            )}
          </div>
        </SheetHeader>

        {query.isLoading ? <LoadingState message="جارٍ تحميل تفاصيل الفاتورة…" /> : null}
        {query.error ? <ErrorState message={query.error.message} /> : null}
        {!query.isLoading && !query.error && !inv ? (
          <EmptyState title="الفاتورة غير موجودة" description="تعذّر العثور على بيانات الفاتورة المطلوبة." />
        ) : null}

        {inv && (
          <div className="space-y-5">
            {/* بطاقات البيانات الأساسية */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Card>
                <CardContent className="p-3.5 space-y-2 text-xs">
                  <div className="font-semibold text-sm flex items-center gap-1.5 text-foreground">
                    <Building2 aria-hidden className="size-4 text-primary shrink-0" />
                    <span className="truncate">{inv.supplierName}</span>
                  </div>
                  {inv.supplierPhone && (
                    <div className="text-muted-foreground font-mono" dir="ltr">
                      هاتف: {inv.supplierPhone}
                    </div>
                  )}
                  {inv.purchaseOrderNumber && (
                    <div className="flex items-center gap-1 pt-1 border-t">
                      <span className="text-muted-foreground">أمر الشراء المرتبط:</span>
                      <Link
                        href={`/purchases/${inv.purchaseOrderId ?? ""}`}
                        className="font-mono text-primary font-semibold hover:underline inline-flex items-center gap-1"
                      >
                        {inv.purchaseOrderNumber}
                        <ExternalLink aria-hidden className="size-3" />
                      </Link>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-3.5 space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">طريقة السداد:</span>
                    {inv.settlementType ? (
                      <span className={cn("px-2 py-0.5 rounded font-medium", SETTLEMENT_CLASS[inv.settlementType] ?? "bg-muted")}>
                        {SETTLEMENT_LABEL[inv.settlementType] ?? inv.settlementType}
                      </span>
                    ) : (
                      <span>—</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">تاريخ الفاتورة:</span>
                    <span className="font-mono">{fmtDate(inv.invoiceDate)}</span>
                  </div>
                  {inv.dueDate && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">تاريخ الاستحقاق:</span>
                      <span className="font-mono text-amber-600 dark:text-amber-400 font-medium">
                        {fmtDate(inv.dueDate)}
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* الموظفون المنفذون */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs bg-muted/30 p-3 rounded-lg border">
              <div className="flex items-center gap-2">
                <User aria-hidden className="size-4 text-muted-foreground shrink-0" />
                <div className="space-y-0.5">
                  <div className="text-muted-foreground">أنشأها:</div>
                  <div className="font-semibold text-foreground">{inv.createdByName ?? "—"}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <UserCheck aria-hidden className="size-4 text-muted-foreground shrink-0" />
                <div className="space-y-0.5">
                  <div className="text-muted-foreground">رحّلها:</div>
                  <div className="font-semibold text-foreground">
                    {inv.postedByName ?? (inv.status === "POSTED" ? "ترحيل آلي للنظام" : "لم تُرحّل بعد")}
                  </div>
                </div>
              </div>
            </div>

            {/* ملخص المبالغ والمالية */}
            <Card className="bg-muted/15 border">
              <CardContent className="p-3.5 space-y-2 text-xs">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>المجموع الفرعي (قبل الخصم):</span>
                  <span className="font-mono font-medium text-foreground">
                    {fmt(inv.subtotal ?? inv.totalAmount)} {currencySymbol}
                  </span>
                </div>
                {inv.discountAmount && Number(inv.discountAmount) > 0 ? (
                  <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
                    <span>الخصم الممنوح:</span>
                    <span className="font-mono font-medium">
                      -{fmt(inv.discountAmount)} {currencySymbol}
                    </span>
                  </div>
                ) : null}
                {inv.taxAmount && Number(inv.taxAmount) > 0 ? (
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>الضريبة:</span>
                    <span className="font-mono font-medium text-foreground">
                      +{fmt(inv.taxAmount)} {currencySymbol}
                    </span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between pt-2 border-t text-sm font-bold">
                  <span>إجمالي الفاتورة الصافي:</span>
                  <span className="font-mono text-primary text-base" dir="ltr">
                    {fmt(inv.totalAmount)} {currencySymbol}
                  </span>
                </div>
              </CardContent>
            </Card>

            {/* التبويبات للبنود وسجل الحوكمة */}
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "items" | "governance")} className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="items" className="flex items-center gap-1.5">
                  <FileText aria-hidden className="size-4" />
                  <span>بنود الفاتورة ({lines.length})</span>
                </TabsTrigger>
                <TabsTrigger value="governance" className="flex items-center gap-1.5">
                  <ShieldCheck aria-hidden className="size-4" />
                  <span>المطابقة والاعتمادات ({approvals.length + matches.length})</span>
                </TabsTrigger>
              </TabsList>

              <TabsContent value="items" className="space-y-3 pt-3">
                {lines.length === 0 ? (
                  <div className="text-center py-6 text-sm text-muted-foreground border rounded-md">
                    لا توجد بنود مسجلة في هذه الفاتورة.
                  </div>
                ) : (
                  <div className="rounded-md border overflow-x-auto">
                    <Table grid className="text-xs">
                      <TableHeader className="bg-muted/50 text-muted-foreground font-semibold">
                        <TableRow>
                          <TableHead className="p-2.5 text-center w-10">#</TableHead>
                          <TableHead className="p-2.5 text-start">الصنف / الوصف</TableHead>
                          <TableHead className="p-2.5 text-center">الكمية</TableHead>
                          <TableHead className="p-2.5 text-end">سعر الوحدة</TableHead>
                          <TableHead className="p-2.5 text-end">الإجمالي</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {lines.map((line, idx) => (
                          <TableRow key={line.id ?? idx} className="hover:bg-muted/20">
                            <TableCell className="p-2.5 text-center text-muted-foreground font-mono">{line.lineNo}</TableCell>
                            <TableCell className="p-2.5 font-medium">{line.description}</TableCell>
                            <TableCell className="p-2.5 text-center font-mono font-semibold">
                              {line.invoicedBaseQuantity}
                            </TableCell>
                            <TableCell className="p-2.5 text-end font-mono" dir="ltr">
                              {fmt(line.unitPriceIqd)} د.ع
                            </TableCell>
                            <TableCell className="p-2.5 text-end font-mono font-semibold" dir="ltr">
                              {fmt(line.totalAmount)} د.ع
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="governance" className="space-y-4 pt-3">
                <div className="space-y-3">
                  <div className="text-xs font-semibold text-muted-foreground">طلبات الاعتماد والعكس:</div>
                  {approvals.length === 0 ? (
                    <div className="text-xs text-muted-foreground p-3 border rounded-md bg-muted/20">
                      لم يُسجّل أي طلب عكس أو اعتماد إداري لهذه الفاتورة.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {approvals.map((req) => (
                        <div key={req.id} className="p-3 rounded-md border text-xs space-y-1.5 bg-muted/10">
                          <div className="flex items-center justify-between font-semibold">
                            <span>{req.kind === "REVERSE_INVOICE" ? "طلب عكس فاتورة مورد" : "طلب ترحيل فاتورة"}</span>
                            <span className={cn("px-2 py-0.5 rounded text-[11px]", req.status === "APPROVED" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : req.status === "REJECTED" ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300")}>
                              {req.status === "APPROVED" ? "معتمد" : req.status === "REJECTED" ? "مرفوض" : "بانتظار الاعتماد"}
                            </span>
                          </div>
                          <div className="text-muted-foreground">{req.reason}</div>
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1 border-t">
                            <span>بواسطة: {req.requestedByName ?? `#${req.requestedBy}`}</span>
                            <span dir="ltr">{fmtDate(req.requestedAt)}</span>
                          </div>
                          {req.reviewReason && (
                            <div className="text-[11px] text-muted-foreground">
                              قرار المراجع: {req.reviewReason} ({req.reviewedByName ?? `#${req.reviewedBy ?? ""}`})
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {matches.length > 0 && (
                    <div className="space-y-2 pt-2 border-t">
                      <div className="text-xs font-semibold text-muted-foreground">مسار المطابقة الثلاثية:</div>
                      {matches.map((m) => {
                        const isMatchOk = m.outcome === "EXACT" || m.outcome === "WITHIN_TOLERANCE";
                        const matchLabel =
                          m.outcome === "EXACT"
                            ? "مطابقة تامة"
                            : m.outcome === "WITHIN_TOLERANCE"
                              ? "ضمن هامش السماح"
                              : "محجوز للمراجعة";
                        return (
                          <div key={m.id} className="p-2.5 rounded-md border text-xs flex items-center justify-between bg-muted/10">
                            <div className="space-y-0.5">
                              <div className="font-semibold">دورة مطابقة #{m.runNo}</div>
                              <div className="text-muted-foreground font-mono text-[11px]">{fmtDate(m.performedAt)}</div>
                            </div>
                            <span
                              className={cn(
                                "px-2 py-0.5 rounded font-medium text-[11px]",
                                isMatchOk
                                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                                  : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
                              )}
                            >
                              {matchLabel}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>

            {/* الإجراءات السفلية */}
            <div className="flex items-center justify-between pt-4 border-t gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                إغلاق
              </Button>
              {inv.status === "POSTED" && onRequestReversal ? (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    onClose();
                    onRequestReversal(inv);
                  }}
                  className="gap-1.5"
                >
                  <RotateCcw aria-hidden className="size-4" />
                  طلب عكس الفاتورة
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
