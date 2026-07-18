import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BarcodeDisplay } from "@/components/BarcodeDisplay";
import { confirm } from "@/lib/confirm";
import { fmtAr } from "@/lib/money";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { printWorkOrder } from "@/lib/printing/printTemplates";
import { printWorkOrderReceipt } from "@/lib/printing/print";
import { printShippingLabel } from "@/lib/printing/shippingLabel";
import { notify } from "@/lib/notify";
import { openWhatsApp, buildWorkOrderStatusMessage } from "@/lib/whatsapp";
import { Printer, MessageCircle, Truck } from "lucide-react";
import { CopyInline } from "@/components/CopyButton";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatWorkOrderAsWhatsApp } from "@/lib/copy/formatters";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearch } from "wouter";

const STATUS_LABEL: Record<string, string> = {
  RECEIVED: "مُستلَم",
  IN_PROGRESS: "قيد التنفيذ",
  READY: "جاهز للتسليم",
  DELIVERED: "مُسلَّم",
  CANCELLED: "ملغى",
};
const STATUS_CLS: Record<string, string> = {
  RECEIVED: "bg-muted text-foreground/70",
  IN_PROGRESS: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
  READY: "bg-amber-100 text-amber-700",
  DELIVERED: "bg-emerald-100 text-emerald-700",
  CANCELLED: "bg-rose-100 text-rose-700",
};

const METHODS: { v: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET"; label: string }[] = [
  { v: "CASH", label: "نقدي" },
  { v: "TRANSFER", label: "تحويل" },
  { v: "CARD", label: "بطاقة" },
  { v: "WALLET", label: "محفظة" },
];

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** حقل وصفي: عنوان صغير + قيمة. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5 min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium truncate">{children}</div>
    </div>
  );
}

/** سطر في لوحة الملخّص المالي: تسمية يميناً + مبلغ يساراً (LTR، بلا اقتطاع). */
function SummaryRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={cn("text-muted-foreground", strong && "font-semibold text-foreground")}>{label}</span>
      <span dir="ltr" className={cn("tabular-nums", strong ? "text-lg font-bold" : "text-sm")}>{fmtAr(value)}</span>
    </div>
  );
}

export default function WorkOrderDetail() {
  const params = useParams();
  const workOrderId = Number(params.id);
  const utils = trpc.useUtils();
  const wo = trpc.workOrders.get.useQuery({ workOrderId }, { enabled: Number.isFinite(workOrderId) });
  const qs = useSearch();

  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<(typeof METHODS)[number]["v"]>("CASH");

  // ?print=1 من شاشة «حفظ وطباعة»: نطبع التذكرة الحرارية تلقائياً مرة واحدة بعد تحميل البيانات.
  const autoPrintedRef = useRef(false);
  useEffect(() => {
    if (autoPrintedRef.current) return;
    const wantPrint = new URLSearchParams(qs || "").get("print") === "1";
    if (!wantPrint || !wo.data) return;
    autoPrintedRef.current = true;
    void printWorkOrderReceipt({
      orderNumber: wo.data.orderNumber,
      orderDate: wo.data.createdAt ? String(wo.data.createdAt).slice(0, 10) : undefined,
      dueDate: wo.data.dueDate ? String(wo.data.dueDate).slice(0, 10) : undefined,
      status: wo.data.status,
      customerName: wo.data.customerName ?? undefined,
      customerPhone: wo.data.customerPhone ?? undefined,
      jobTitle: wo.data.title,
      quantity: wo.data.quantity ? `${wo.data.quantity} نسخة` : undefined,
      specs: wo.data.customizationText ?? undefined,
      total: wo.data.salePrice,
    });
  }, [qs, wo.data]);

  // تعبئة المتبقّي تلقائياً عند الجهوزية = سعر البيع − العربون المقبوض (لا طرح يدويّ).
  useEffect(() => {
    const d = wo.data;
    if (d && d.status === "READY") {
      const due = Math.max(0, Number(d.salePrice) - Number(d.deposit ?? 0));
      setPayAmount(due > 0 ? String(due) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wo.data?.status, wo.data?.salePrice, wo.data?.deposit]);

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
  if (!wo.data) return <div className="p-10 text-center text-muted-foreground">طلب الخدمة غير موجود.</div>;
  const data = wo.data;

  const fmt = fmtAr;

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">طلب خدمة</h1>
        <div className="flex items-center gap-3">
          <CopyAsMenu
            label="نَسخ التَفاصيل"
            plain={formatWorkOrderAsWhatsApp({
              number: data.orderNumber,
              date: data.createdAt,
              customer: data.customerName,
              description: data.customizationText,
              status: STATUS_LABEL[data.status] ?? data.status,
              items: [{ name: data.title, qty: data.quantity, unit: "نُسخة" }],
              total: data.salePrice,
              deliveryDate: data.dueDate,
            })}
            whatsapp={formatWorkOrderAsWhatsApp({
              number: data.orderNumber,
              date: data.createdAt,
              customer: data.customerName,
              description: data.customizationText,
              status: STATUS_LABEL[data.status] ?? data.status,
              items: [{ name: data.title, qty: data.quantity, unit: "نُسخة" }],
              total: data.salePrice,
              deliveryDate: data.dueDate,
            })}
          />
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={!data.customerPhone}
            title={data.customerPhone ? "فتح واتساب برسالة تحديث حالة جاهزة للعميل" : "لا رقم هاتف مسجَّل للعميل"}
            onClick={() => openWhatsApp(data.customerPhone, buildWorkOrderStatusMessage({
              orderNumber: data.orderNumber,
              title: data.title,
              status: data.status,
              customerName: data.customerName,
              quantity: data.quantity,
              dueDate: data.dueDate ? String(data.dueDate) : null,
              amountDue: String(Math.max(0, Number(data.salePrice) - Number(data.deposit ?? 0))),
            }))}
          >
            <MessageCircle className="h-3.5 w-3.5" />
            تحديث للعميل
          </Button>
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
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            title="ملصق شحن يُلصَق على الطرد (بالقياس المحفوظ — الافتراضي ٨٠×١٢٠مم)"
            onClick={async () => {
              const res = await printShippingLabel({
                orderNumber: data.orderNumber,
                customerName: data.customerName,
                customerPhone: data.customerPhone,
                governorate: null,
                addressText: data.deliveryAddress ?? null,
                total: String(Math.max(0, Number(data.salePrice) - Number(data.deposit ?? 0))),
                createdAt: data.createdAt,
                items: [{ productName: data.title, unitName: "", quantity: String(data.quantity) }],
              });
              if (!res.ok) notify.err("افسح مانع النوافذ المنبثقة لطباعة ملصق الشحن");
            }}
          >
            <Truck className="h-3.5 w-3.5" />
            ملصق شحن
          </Button>
          <Link href="/work-orders" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between gap-2">
            <span className="truncate">{data.title}</span>
            <span className={`text-xs rounded-full px-2.5 py-0.5 font-medium shrink-0 ${STATUS_CLS[data.status] ?? "bg-muted"}`}>
              {STATUS_LABEL[data.status] ?? data.status}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-5 md:grid-cols-3">
            <div className="md:col-span-2 grid grid-cols-2 gap-x-6 gap-y-4 text-sm content-start">
              <Field label="رقم الأمر"><CopyInline value={data.orderNumber} successMessage="تم نَسخ رَقم الأَمر" /></Field>
              <Field label="العميل">{data.customerName ?? "عميل نقدي"}</Field>
              <Field label="الكمية">{data.quantity}</Field>
              <Field label="الاستحقاق">{data.dueDate ? String(data.dueDate).slice(0, 10) : "—"}</Field>
            </div>

            <div className="rounded-lg border bg-muted/30 p-4 space-y-2.5 text-sm self-start">
              <SummaryRow label="سعر البيع" value={data.salePrice} strong />
              <SummaryRow label="كلفة المواد" value={data.materialsCost} />
              <SummaryRow label="كلفة العمالة" value={data.laborCost} />
            </div>
          </div>

          {data.customizationText && (
            <div className="rounded-md bg-muted/40 p-3 text-sm">
              <div className="text-xs text-muted-foreground mb-1">التخصيص</div>
              <div className="whitespace-pre-wrap">{data.customizationText}</div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">المواد</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium text-start">المادة</th>
                  <th className="px-3 py-2 font-medium text-start">SKU</th>
                  <th className="px-3 py-2 font-medium text-center">كمية (أساس)</th>
                  <th className="px-3 py-2 font-medium text-right">كلفة الوحدة</th>
                  <th className="px-3 py-2 font-medium text-right">كلفة السطر</th>
                </tr>
              </thead>
              <tbody>
                {data.materials.map((m) => (
                  <tr key={m.id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2">{m.productName}{m.variantName ? ` — ${m.variantName}` : ""}</td>
                    <td className="px-3 py-2 font-mono text-xs" dir="ltr">{m.sku}</td>
                    <td className="px-3 py-2 text-center tabular-nums" dir="ltr">{m.baseQuantity}</td>
                    <td className="px-3 py-2 text-right tabular-nums" dir="ltr">{fmt(m.unitCost)}</td>
                    <td className="px-3 py-2 text-right tabular-nums" dir="ltr">{fmt(Number(m.unitCost) * m.baseQuantity)}</td>
                  </tr>
                ))}
                {data.materials.length === 0 && (
                  <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">لا مواد مرفقة (أمر طباعة/خدمة صرفة).</td></tr>
                )}
              </tbody>
              {data.materials.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 bg-muted/40 font-semibold">
                    <td className="px-3 py-2" colSpan={4}>إجمالي كلفة المواد</td>
                    <td className="px-3 py-2 text-right tabular-nums" dir="ltr">
                      {fmt(data.materials.reduce((s, m) => s + Number(m.unitCost) * m.baseQuantity, 0))}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>

      {data.status === "READY" && (
        <Card>
          <CardHeader><CardTitle className="text-base">دفعة عند التسليم (اختياري)</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">سعر البيع</span><span dir="ltr" className="tabular-nums">{fmt(data.salePrice)} د.ع</span></div>
              {Number(data.deposit ?? 0) > 0 && <div className="flex justify-between"><span className="text-muted-foreground">العربون المقبوض</span><span dir="ltr" className="tabular-nums text-emerald-600">−{fmt(data.deposit)} د.ع</span></div>}
              <div className="flex justify-between border-t pt-1 font-bold"><span>الرصيد المستحق</span><span dir="ltr" className="tabular-nums">{fmt(String(Math.max(0, Number(data.salePrice) - Number(data.deposit ?? 0))))} د.ع</span></div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
              <div className="space-y-1">
                <Label>المبلغ المدفوع الآن (الافتراضي = المستحق)</Label>
                <Input dir="ltr" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="الرصيد المستحق" />
              </div>
              <div className="space-y-1">
                <Label>طريقة الدفع</Label>
                <select className={selectCls} value={payMethod} onChange={(e) => setPayMethod(e.target.value as typeof payMethod)}>
                  {METHODS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
                </select>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* باركود + QR تذكرة طلب الخدمة */}
      {data.qrPayload && (
        <Card>
          <CardHeader><CardTitle className="text-base">باركود طلب الخدمة</CardTitle></CardHeader>
          <CardContent className="flex justify-center py-4">
            <BarcodeDisplay
              barcodeSet={{
                barcode128: data.orderNumber,
                qrPayload: data.qrPayload,
                displayLabel: `طلب خدمة: ${data.orderNumber}${data.customerName ? `\nالعميل: ${data.customerName}` : ""}`,
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
          <Button
            onClick={async () => {
              if (!(await confirm({
                variant: "warning",
                title: "بدء تنفيذ طلب الخدمة",
                description: `سيبدأ تنفيذ أمر «${data.title}» (${data.orderNumber}) وتُخصم المواد من المخزون. هل تريد المتابعة؟`,
                confirmText: "بدء التنفيذ",
              }))) return;
              start.mutate({ workOrderId });
            }}
            disabled={start.isPending}
          >
            {start.isPending ? "جارٍ…" : "بدء التنفيذ (خصم المواد)"}
          </Button>
        )}
        {data.status === "IN_PROGRESS" && (
          <Button
            onClick={async () => {
              if (!(await confirm({
                variant: "info",
                title: "وضع علامة جاهز للتسليم",
                description: `سيُعلَّم أمر «${data.title}» (${data.orderNumber}) كجاهز للتسليم. هل تريد المتابعة؟`,
                confirmText: "وضع علامة جاهز",
              }))) return;
              markReady.mutate({ workOrderId });
            }}
            disabled={markReady.isPending}
          >
            {markReady.isPending ? "جارٍ…" : "وضع علامة جاهز"}
          </Button>
        )}
        {data.status === "READY" && (
          <Button
            onClick={async () => {
              const payNow = Number(payAmount) > 0;
              if (!(await confirm({
                variant: "danger",
                title: "تسليم طلب الخدمة وإصدار الفاتورة",
                description: `سيُسلَّم أمر «${data.title}» (${data.orderNumber}) وتُصدر فاتورة بقيمة ${fmt(data.salePrice)}${payNow ? ` مع دفعة ${fmt(String(Number(payAmount)))}` : " (آجل بالكامل)"}. لا يمكن التراجع. اكتب «تسليم» للتأكيد.`,
                confirmText: "تسليم وإصدار فاتورة",
                requireText: "تسليم",
              }))) return;
              deliver.mutate({
                workOrderId,
                payment: payNow ? { amount: String(Number(payAmount)), method: payMethod } : undefined,
              });
            }}
            disabled={deliver.isPending}
          >
            {deliver.isPending ? "جارٍ…" : "تسليم وإصدار فاتورة"}
          </Button>
        )}
        {(data.status === "RECEIVED" || data.status === "IN_PROGRESS" || data.status === "READY") && (
          <Button
            variant="outline"
            onClick={async () => {
              if (!(await confirm({
                variant: "warning",
                title: "إلغاء طلب الخدمة",
                description: `سيُلغى أمر «${data.title}» (${data.orderNumber})، وتُعاد المواد للمخزون إن كانت قد خُصمت. هل تريد المتابعة؟`,
                confirmText: "إلغاء الأمر",
              }))) return;
              cancel.mutate({ workOrderId });
            }}
            disabled={cancel.isPending}
          >
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
