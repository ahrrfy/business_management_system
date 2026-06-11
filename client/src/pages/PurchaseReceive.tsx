import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";

const PO_STATUS: Record<string, string> = {
  DRAFT: "مسودّة",
  SENT: "مُرسَل",
  CONFIRMED: "مؤكّد",
  RECEIVED: "مُستلَم",
  CANCELLED: "ملغى",
};

const METHODS: { v: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET"; label: string }[] = [
  { v: "CASH", label: "نقد" },
  { v: "TRANSFER", label: "تحويل" },
  { v: "CHECK", label: "صك" },
  { v: "CARD", label: "بطاقة" },
  { v: "WALLET", label: "محفظة" },
];

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function PurchaseReceive() {
  const params = useParams();
  const purchaseOrderId = Number(params.id);
  const utils = trpc.useUtils();

  const po = trpc.purchases.get.useQuery({ purchaseOrderId }, { enabled: Number.isFinite(purchaseOrderId) });
  const [recv, setRecv] = useState<Record<number, string>>({});
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<(typeof METHODS)[number]["v"]>("CASH");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  // Default each line's receive input to its remaining quantity, once loaded.
  useEffect(() => {
    if (!po.data) return;
    const init: Record<number, string> = {};
    for (const it of po.data.items) {
      const remaining = it.baseQuantity - (it.receivedBaseQuantity ?? 0);
      init[Number(it.id)] = remaining > 0 ? String(remaining) : "0";
    }
    setRecv(init);
  }, [po.data]);

  // idempotency: مفتاح ثابت لكل استلام (يتجدّد بعد النجاح) ⇒ نقرة مزدوجة لا تُكرّر المخزون/AP.
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  const receive = trpc.purchases.receive.useMutation({
    onSuccess: async (r) => {
      setDone(r.fullyReceived ? "تم الاستلام الكامل." : "تم استلام جزئي.");
      await Promise.all([
        utils.purchases.get.invalidate({ purchaseOrderId }),
        utils.purchases.list.invalidate(),
      ]);
      setClientRequestId(crypto.randomUUID()); // مفتاح جديد للاستلام التالي (جزئي)
    },
    onError: (e) => setError(e.message),
  });

  if (po.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (!po.data) return <div className="p-10 text-center text-muted-foreground">أمر الشراء غير موجود.</div>;

  const data = po.data;
  const closed = data.status === "RECEIVED" || data.status === "CANCELLED";

  function submit() {
    setError("");
    setDone("");
    const lines = data.items
      .map((it) => ({ purchaseOrderItemId: Number(it.id), receivedBaseQuantity: Math.trunc(Number(recv[Number(it.id)] || 0)) }))
      .filter((l) => l.receivedBaseQuantity > 0);
    if (!lines.length) return setError("أدخل كمية استلام واحدة على الأقل.");
    for (const it of data.items) {
      const want = Math.trunc(Number(recv[Number(it.id)] || 0));
      const remaining = it.baseQuantity - (it.receivedBaseQuantity ?? 0);
      if (want > remaining) return setError(`الكمية المستلمة للصنف «${it.productName}» تتجاوز المتبقّي (${remaining}).`);
    }
    const payment = Number(payAmount) > 0 ? { amount: String(Number(payAmount)), method: payMethod } : undefined;
    receive.mutate({ purchaseOrderId, lines, payment, clientRequestId });
  }

  const fmt = (s: string | number) => Number(s).toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 2 });

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">استلام أمر شراء</h1>
        <Link href="/purchases" className="text-sm text-muted-foreground">← رجوع للمشتريات</Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">بيانات الأمر</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div className="text-muted-foreground text-xs">رقم الأمر</div><div className="font-mono" dir="ltr">{data.poNumber}</div></div>
          <div><div className="text-muted-foreground text-xs">المورد</div><div>{data.supplierName ?? "—"}</div></div>
          <div><div className="text-muted-foreground text-xs">الحالة</div><div>{PO_STATUS[data.status] ?? data.status}</div></div>
          <div><div className="text-muted-foreground text-xs">الإجمالي / المدفوع</div><div dir="ltr">{fmt(data.total)} / {fmt(data.paidAmount)}</div></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">الأصناف</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">الصنف</th>
                <th className="p-2">الوحدة</th>
                <th className="p-2 text-center">المطلوب (أساس)</th>
                <th className="p-2 text-center">مُستلَم سابقاً</th>
                <th className="p-2 text-center">المتبقّي</th>
                <th className="p-2 w-32 text-center">استلام الآن</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((it) => {
                const already = it.receivedBaseQuantity ?? 0;
                const remaining = it.baseQuantity - already;
                return (
                  <tr key={it.id} className="border-t">
                    <td className="p-2">{it.productName}{it.variantName ? ` — ${it.variantName}` : ""} <span className="text-xs text-muted-foreground font-mono" dir="ltr">{it.sku}</span></td>
                    <td className="p-2 text-muted-foreground">{it.unitName}</td>
                    <td className="p-2 text-center">{it.baseQuantity}</td>
                    <td className="p-2 text-center">{already}</td>
                    <td className="p-2 text-center">{remaining}</td>
                    <td className="p-2">
                      <Input
                        dir="ltr"
                        className="h-8 text-center"
                        value={recv[Number(it.id)] ?? ""}
                        disabled={closed || remaining <= 0}
                        onChange={(e) => setRecv((prev) => ({ ...prev, [Number(it.id)]: e.target.value }))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {!closed && (
        <Card>
          <CardHeader><CardTitle className="text-base">دفعة للمورد (اختياري)</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div className="space-y-1">
              <Label>المبلغ المدفوع الآن</Label>
              <Input dir="ltr" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="0" />
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

      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-emerald-600">{done}</p>}
      <div className="flex gap-2">
        {!closed && (
          <Button onClick={submit} disabled={receive.isPending}>{receive.isPending ? "جارٍ الاستلام…" : "تأكيد الاستلام"}</Button>
        )}
        <Link href="/purchases"><Button variant="outline">{closed ? "رجوع" : "إلغاء"}</Button></Link>
      </div>
    </div>
  );
}
