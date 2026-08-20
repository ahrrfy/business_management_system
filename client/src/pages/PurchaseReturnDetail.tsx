import { ErrorState, LoadingState } from "@/components/PageState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDateTime } from "@/lib/date";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { releaseReservedPrintWindow, reservePrintWindow } from "@/lib/printing/brand";
import { trpc } from "@/lib/trpc";
import { usePrintAudit } from "@/hooks/usePrintAudit";
import { ArrowRight, Printer } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, useParams } from "wouter";

export default function PurchaseReturnDetail() {
  const params = useParams<{ id?: string }>();
  const id = Number(params.id);
  const query = trpc.purchaseReturns.get.useQuery({ id }, { enabled: Number.isInteger(id) && id > 0 });
  const printAudit = usePrintAudit();
  const autoPrinted = useRef(false);

  async function printDocument(alreadyReserved = false) {
    const data = query.data;
    if (!data) return;
    if (!alreadyReserved && !reservePrintWindow()) return notify.err("تعذّر فتح نافذة الطباعة — تحقّق من مانع النوافذ المنبثقة");
    try {
      await printAudit.run({ documentType: "PURCHASE_RETURN", documentId: data.id, branchId: data.branchId, channel: "PDF", open: (audit) => printReportDoc({
      title: "مستند مرتجع شراء",
      docNum: data.returnNumber,
      docDate: fmtDateTime(data.createdAt),
      headerExtra: [
        { label: "المورد", value: data.supplierName },
        { label: "أمر الشراء", value: data.purchaseOrderNumber },
      ],
      meta: [{
        title: "بيانات التثبيت",
        fields: [
          { label: "المنفذ", value: data.createdByName },
          { label: "وقت التنظيم", value: fmtDateTime(data.createdAt) },
          { label: "طالب الطباعة", value: audit.actorName },
          { label: "وقت طلب الطباعة", value: fmtDateTime(audit.requestedAt) },
          { label: "التسوية", value: data.settlement === "CASH" ? "نقدي/ذمة بحسب الدفع المثبت" : "خصم من ذمة المورد" },
          { label: "الملاحظات", value: data.reason || "—" },
        ],
      }],
      columns: [
        { key: "product", label: "الصنف" },
        { key: "unit", label: "الوحدة" },
        { key: "quantity", label: "الكمية", align: "left" },
        { key: "unitPrice", label: "السعر", align: "left" },
        { key: "total", label: "الإجمالي", align: "left" },
      ],
      rows: data.items.map((item) => ({
        product: `${item.productNameSnapshot}${item.variantNameSnapshot ? ` — ${item.variantNameSnapshot}` : ""}`,
        unit: item.unitNameSnapshot || "—",
        quantity: item.quantity,
        unitPrice: fmt(item.unitPrice),
        total: fmt(item.lineTotal),
      })),
      summary: [
        { label: "الصافي", value: `${fmt(data.netAmount)} د.ع` },
        { label: "الضريبة", value: `${fmt(data.taxAmount)} د.ع` },
        { label: "المسترد نقداً", value: `${fmt(data.cashRefundAmount)} د.ع` },
        { label: "المخصوم من الذمة", value: `${fmt(data.creditOffsetAmount)} د.ع` },
        { label: "إجمالي المرتجع", value: `${fmt(data.totalAmount)} د.ع`, bold: true, large: true },
      ],
      }) });
    } catch (error) {
      releaseReservedPrintWindow();
      notify.err(error instanceof Error ? error.message : "تعذّر تسجيل طلب الطباعة");
    }
  }

  useEffect(() => {
    if (!query.data || autoPrinted.current || new URLSearchParams(window.location.search).get("print") !== "1") return;
    autoPrinted.current = true;
    void printDocument(true);
  }, [query.data]);

  if (query.isLoading) return <LoadingState />;
  if (query.isError || !query.data) return <ErrorState message={query.error?.message} onRetry={() => void query.refetch()} />;
  const data = query.data;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`مرتجع شراء ${data.returnNumber}`}
        actions={<div className="flex gap-2"><Button disabled={printAudit.pending} onClick={() => void printDocument()}><Printer className="size-4" /> طباعة</Button><Link href="/purchases?tab=returns"><Button variant="outline"><ArrowRight className="size-4" /> السجل</Button></Link></div>}
      />
      <Card>
        <CardHeader><CardTitle className="text-base">بيانات المستند</CardTitle></CardHeader>
        <CardContent className="grid gap-3 text-sm md:grid-cols-4">
          <div><span className="text-muted-foreground">المورد</span><div className="font-semibold">{data.supplierName}</div></div>
          <div><span className="text-muted-foreground">أمر الشراء</span><div dir="ltr" className="font-semibold">{data.purchaseOrderNumber}</div></div>
          <div><span className="text-muted-foreground">المنفذ</span><div className="font-semibold">{data.createdByName}</div></div>
          <div><span className="text-muted-foreground">وقت التنظيم</span><div dir="ltr" className="font-semibold">{fmtDateTime(data.createdAt)}</div></div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50"><tr><th className="p-2 text-right">الصنف</th><th className="p-2">الوحدة</th><th className="p-2">الكمية</th><th className="p-2">السعر</th><th className="p-2">الإجمالي</th></tr></thead>
            <tbody>{data.items.map((item) => <tr key={item.id} className="border-t"><td className="p-2 font-medium">{item.productNameSnapshot}{item.variantNameSnapshot ? ` — ${item.variantNameSnapshot}` : ""}</td><td className="p-2 text-center">{item.unitNameSnapshot || "—"}</td><td className="p-2 text-center tabular-nums" dir="ltr">{item.quantity}</td><td className="p-2 text-center tabular-nums" dir="ltr">{fmt(item.unitPrice)}</td><td className="p-2 text-center font-semibold tabular-nums" dir="ltr">{fmt(item.lineTotal)}</td></tr>)}</tbody>
          </table>
        </CardContent>
      </Card>
      <div className="grid gap-2 rounded-md border bg-card p-3 text-sm sm:grid-cols-3">
        <div>المسترد نقداً: <b dir="ltr">{fmt(data.cashRefundAmount)} د.ع</b></div>
        <div>المخصوم من الذمة: <b dir="ltr">{fmt(data.creditOffsetAmount)} د.ع</b></div>
        <div>الإجمالي: <b dir="ltr">{fmt(data.totalAmount)} د.ع</b></div>
      </div>
    </div>
  );
}
