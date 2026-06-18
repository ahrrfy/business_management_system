import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BarcodeDisplay } from "@/components/BarcodeDisplay";
import { fmtAr } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { printWorkOrder } from "@/lib/printing/printTemplates";
import { printWorkOrderReceipt } from "@/lib/printing/print";
import { Printer } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "wouter";

const STATUS_LABEL: Record<string, string> = {
  RECEIVED: "مُستلَم",
  IN_PROGRESS: "قيد التنفيذ",
  READY: "جاهز للتسليم",
  DELIVERED: "مُسلَّم",
  CANCELLED: "ملغى",
};

const METHODS: { v: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET"; label: string }[] = [
  { v: "CASH", label: "نقدي" },
  { v: "TRANSFER", label: "تحويل" },
  { v: "CARD", label: "بطاقة" },
  { v: "WALLET", label: "محفظة" },
];

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function WorkOrderDetail() {
  const params = useParams();
  const workOrderId = Number(params.id);
  const utils = trpc.useUtils();
  const wo = trpc.workOrders.get.useQuery({ workOrderId }, { enabled: Number.isFinite(workOrderId) });

  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<(typeof METHODS)[number]["v"]>("CASH");

  const refresh = async () => {
    await Promise.all([
      utils.workOrders.get.invalidate({ workOrderId }),
      utils.workOrders.list.invalidate(),
      utils.inventory.movements.invalidate(),
    ]);
  };

  const start = trpc.workOrders.start.useMutation({
    onSuccess: async () => { setDone("بدأ التنفيذ — تم خصم المواد من المخزون."); setError(""); await refresh(); },
    onError: (e) => setError(e.message),
  });
  const markReady = trpc.workOrders.markReady.useMutation({
    onSuccess: async () => { setDone("الأمر جاهز للتسليم."); setError(""); await refresh(); },
    onError: (e) => setError(e.message),
  });
  const deliver = trpc.workOrders.deliver.useMutation({
    onSuccess: async (r) => { setDone(`تم التسليم. فاتورة ${r.invoiceNumber} (${r.status}).`); setError(""); await refresh(); },
    onError: (e) => setError(e.message),
  });
  const cancel = trpc.workOrders.cancel.useMutation({
    onSuccess: async () => { setDone("تم إلغاء الأمر — أُعيدت المواد للمخزون إن وُجدت."); setError(""); await refresh(); },
    onError: (e) => setError(e.message),
  });

  if (wo.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (!wo.data) return <div className="p-10 text-center text-muted-foreground">أمر الشغل غير موجود.</div>;
  const data = wo.data;

  const fmt = fmtAr;

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">أمر شغل</h1>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => printWorkOrder({
            woNumber: data.orderNumber,
            woDate: data.createdAt ? String(data.createdAt).slice(0, 10) : undefined,
            dueDate: data.dueDate ? String(data.dueDate).slice(0, 10) : undefined,
            status: data.status,
            customerName: data.customerName,
            jobType: data.title,
            specs: data.customizationText,
            items: [{
              name: `${data.title} (${data.quantity} نسخة)`,
              unit: 'مهمة',
              quantity: 1,
              unitPrice: data.salePrice,
              total: data.salePrice,
            }],
            subtotal: data.salePrice,
            total: data.salePrice,
          })}>طباعة A4</Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => printWorkOrderReceipt({
              orderNumber: data.orderNumber,
              orderDate: data.createdAt ? String(data.createdAt).slice(0, 10) : undefined,
              dueDate: data.dueDate ? String(data.dueDate).slice(0, 10) : undefined,
              status: data.status,
              customerName: data.customerName ?? undefined,
              customerPhone: data.customerPhone ?? undefined,
              jobTitle: data.title,
              quantity: data.quantity ? `${data.quantity} نسخة` : undefined,
              specs: data.customizationText ?? undefined,
              total: data.salePrice,
            })}
          >
            <Printer className="h-3.5 w-3.5" />
            طباعة حرارية
          </Button>
          <Link href="/work-orders" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">{data.title}</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div className="text-muted-foreground text-xs">رقم الأمر</div><div className="font-mono" dir="ltr">{data.orderNumber}</div></div>
          <div><div className="text-muted-foreground text-xs">الحالة</div><div>{STATUS_LABEL[data.status] ?? data.status}</div></div>
          <div><div className="text-muted-foreground text-xs">العميل</div><div>{data.customerName ?? "عميل نقدي"}</div></div>
          <div><div className="text-muted-foreground text-xs">الكمية</div><div>{data.quantity}</div></div>
          <div><div className="text-muted-foreground text-xs">سعر البيع</div><div dir="ltr" className="tabular-nums">{fmt(data.salePrice)}</div></div>
          <div><div className="text-muted-foreground text-xs">كلفة المواد</div><div dir="ltr" className="tabular-nums">{fmt(data.materialsCost)}</div></div>
          <div><div className="text-muted-foreground text-xs">كلفة العمالة</div><div dir="ltr" className="tabular-nums">{fmt(data.laborCost)}</div></div>
          <div><div className="text-muted-foreground text-xs">الاستحقاق</div><div>{data.dueDate ? String(data.dueDate).slice(0, 10) : "—"}</div></div>
          {data.customizationText && (
            <div className="md:col-span-4"><div className="text-muted-foreground text-xs">التخصيص</div><div className="whitespace-pre-wrap">{data.customizationText}</div></div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">المواد</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">المادة</th>
                <th className="p-2">SKU</th>
                <th className="p-2 text-center">كمية (أساس)</th>
                <th className="p-2 text-left">كلفة الوحدة</th>
                <th className="p-2 text-left">كلفة السطر</th>
              </tr>
            </thead>
            <tbody>
              {data.materials.map((m) => (
                <tr key={m.id} className="border-t">
                  <td className="p-2">{m.productName}{m.variantName ? ` — ${m.variantName}` : ""}</td>
                  <td className="p-2 font-mono text-xs" dir="ltr">{m.sku}</td>
                  <td className="p-2 text-center">{m.baseQuantity}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(m.unitCost)}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(Number(m.unitCost) * m.baseQuantity)}</td>
                </tr>
              ))}
              {data.materials.length === 0 && (
                <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">لا مواد مرفقة (أمر طباعة/خدمة صرفة).</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {data.status === "READY" && (
        <Card>
          <CardHeader><CardTitle className="text-base">دفعة عند التسليم (اختياري)</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div className="space-y-1">
              <Label>المبلغ</Label>
              <Input dir="ltr" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder={`أقل من ${data.salePrice} = آجل`} />
            </div>
            <div className="space-y-1">
              <Label>طريقة الدفع</Label>
              <select className={selectCls} value={payMethod} onChange={(e) => setPayMethod(e.target.value as typeof payMethod)}>
                {METHODS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
              </select>
            </div>
          </CardContent>
        </Card>
      )}

      {/* باركود + QR تذكرة أمر الشغل */}
      {data.qrPayload && (
        <Card>
          <CardHeader><CardTitle className="text-base">باركود أمر الشغل</CardTitle></CardHeader>
          <CardContent className="flex justify-center py-4">
            <BarcodeDisplay
              barcodeSet={{
                barcode128: data.orderNumber,
                qrPayload: data.qrPayload,
                displayLabel: `أمر شغل: ${data.orderNumber}${data.customerName ? `\nالعميل: ${data.customerName}` : ""}`,
              }}
              size="md"
            />
          </CardContent>
        </Card>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-emerald-600">{done}</p>}

      <div className="flex gap-2 flex-wrap">
        {data.status === "RECEIVED" && (
          <Button onClick={() => start.mutate({ workOrderId })} disabled={start.isPending}>
            {start.isPending ? "جارٍ…" : "بدء التنفيذ (خصم المواد)"}
          </Button>
        )}
        {data.status === "IN_PROGRESS" && (
          <Button onClick={() => markReady.mutate({ workOrderId })} disabled={markReady.isPending}>
            {markReady.isPending ? "جارٍ…" : "وضع علامة جاهز"}
          </Button>
        )}
        {data.status === "READY" && (
          <Button
            onClick={() => deliver.mutate({
              workOrderId,
              payment: Number(payAmount) > 0 ? { amount: String(Number(payAmount)), method: payMethod } : undefined,
            })}
            disabled={deliver.isPending}
          >
            {deliver.isPending ? "جارٍ…" : "تسليم وإصدار فاتورة"}
          </Button>
        )}
        {(data.status === "RECEIVED" || data.status === "IN_PROGRESS" || data.status === "READY") && (
          <Button variant="outline" onClick={() => cancel.mutate({ workOrderId })} disabled={cancel.isPending}>
            {cancel.isPending ? "جارٍ…" : "إلغاء الأمر"}
          </Button>
        )}
        {data.status === "DELIVERED" && data.invoiceId && (
          <Link href={`/invoices`}><Button variant="outline">فتح الفاتورة #{data.invoiceId}</Button></Link>
        )}
      </div>
    </div>
  );
}
