import { useMemo, useState } from "react";
import { Receipt, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { MoneyInput } from "@/components/form/MoneyInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/PageState";
import type { DispatchParty } from "@/components/delivery/DispatchDialog";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type Row = RouterOutputs["delivery"]["receptionQueue"][number];

/**
 * ٥/٨ — «كل فواتير الوردية»: الطابور كان مصدره جدول `workOrders` حصراً (ReceptionOrderQueue)،
 * فالفاتورة التي لا تحمل تخصيصاً — بيعٌ مباشر أو خدمة طباعة — لا تُنتج صفّاً فيه إطلاقاً، ولا
 * سبيل لإسنادها للتوصيل بعد إتمامها. هذه اللوحة تقرأ من `invoices` (ورديات الاستقبال) وتُظهر
 * حالة كلّ فاتورة تسليمياً، وتتيح سحبَ أيٍّ منها إلى التوصيل بمندوب أو شركة.
 *
 * محاسبياً: الإسناد لا يُنشئ فاتورةً ثانية ولا يمسّ قيد SALE الأصليّ (الإيراد اعتُرف به لحظة
 * البيع). ما يُنشَأ هو عهدة COD بالمتبقّي على الفاتورة فقط، وأجرة التوصيل تمريرٌ خارجها.
 */
export function ReceptionInvoiceQueue({
  branchId,
  parties,
  canFulfill,
}: {
  branchId: number;
  parties: DispatchParty[];
  canFulfill: boolean;
}) {
  const utils = trpc.useUtils();
  // ش٠: كان sinceDays:1 مثبَّتاً ⇒ فاتورة الأمس غير قابلة للوصول إطلاقاً من الطابور. أسبوعٌ
  // يغطّي الحالة اليومية الواقعية (زبونٌ يعود بعد يومين)؛ الطابور الكامل بفلاتر وترقيم في ش١.
  const q = trpc.delivery.receptionQueue.useQuery({ branchId, sinceDays: 7, limit: 200 });
  const [target, setTarget] = useState<Row | null>(null);

  const dispatchInvoice = trpc.delivery.dispatchInvoice.useMutation({
    onSuccess: (r) => {
      notify.ok("أُسنِدت للتوصيل", `إرسالية ${r.consignmentNumber} — تحصيل ${fmt(r.codAmount)} د.ع`);
      setTarget(null);
      void utils.delivery.receptionQueue.invalidate();
      void utils.workOrders.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const rows = q.data ?? [];

  return (
    <section className="rounded-xl border bg-card">
      <header className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="inline-flex items-center gap-2 text-sm font-extrabold">
          <Receipt aria-hidden className="size-4" /> كل فواتير الوردية
        </h2>
        <span className="text-[11px] text-muted-foreground">أيّ فاتورة قابلة للتحويل إلى توصيل</span>
      </header>

      {q.isLoading ? (
        <div className="p-6 text-center text-sm text-muted-foreground">جارٍ التحميل…</div>
      ) : rows.length === 0 ? (
        <EmptyState title="لا فواتير في هذه الوردية بعد." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-[11px] text-muted-foreground">
              <tr>
                <th className="p-2 text-start">الفاتورة</th>
                <th className="p-2 text-start">الزبون</th>
                <th className="p-2 text-start">الإجمالي</th>
                <th className="p-2 text-start">المتبقّي</th>
                <th className="p-2 text-start">الحالة</th>
                <th className="p-2 text-start">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const remaining = Number(r.total) - Number(r.paidAmount ?? 0);
                const who = r.customerName ?? r.contactName ?? "زبون نقدي";
                const phone = r.customerPhone ?? r.contactPhone ?? r.deliveryPhone ?? null;
                return (
                  <tr key={r.invoiceId} className="border-t">
                    <td className="p-2 font-bold tabular-nums" dir="ltr">{r.invoiceNumber}</td>
                    <td className="p-2">
                      <div className="font-semibold">{who}</div>
                      {phone && <div className="text-[11px] text-muted-foreground" dir="ltr">{phone}</div>}
                    </td>
                    <td className="p-2 tabular-nums" dir="ltr">{fmt(r.total)}</td>
                    <td className={cn("p-2 tabular-nums", remaining > 0 && "font-bold text-amber-700")} dir="ltr">
                      {fmt(remaining.toFixed(2))}
                    </td>
                    <td className="p-2">
                      {r.consignmentId ? (
                        <Badge variant="secondary" className="gap-1">
                          <Truck aria-hidden className="size-3" /> {r.partyName ?? "مندوب"} — {r.consignmentNumber}
                        </Badge>
                      ) : r.workOrderId && r.workOrderStatus !== "DELIVERED" ? (
                        <Badge variant="outline">قيد التنفيذ</Badge>
                      ) : (
                        <Badge variant="outline">سُلِّمت على الكاونتر</Badge>
                      )}
                    </td>
                    <td className="p-2">
                      {!r.consignmentId && canFulfill && (
                        <Button size="sm" variant="outline" className="h-7" onClick={() => setTarget(r)}>
                          <Truck aria-hidden className="size-3.5 me-1" /> إسناد للتوصيل
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {target && (
        <InvoiceDispatchDialog
          row={target}
          parties={parties}
          pending={dispatchInvoice.isPending}
          onClose={() => setTarget(null)}
          onConfirm={(args) =>
            dispatchInvoice.mutate({
              invoiceId: target.invoiceId,
              clientRequestId: crypto.randomUUID(),
              ...args,
            })
          }
        />
      )}
    </section>
  );
}

function InvoiceDispatchDialog({
  row,
  parties,
  pending,
  onClose,
  onConfirm,
}: {
  row: Row;
  parties: DispatchParty[];
  pending: boolean;
  onClose: () => void;
  onConfirm: (args: {
    partyId: number;
    deliveryFee: string;
    feeCollection: "COURIER" | "COUNTER" | "SHOP";
    recipientName?: string;
    recipientPhone?: string;
    deliveryAddress?: string;
  }) => void;
}) {
  const [partyId, setPartyId] = useState("");
  const [fee, setFee] = useState("0");
  // ش٠ (V15): COUNTER خارج مسار الفاتورة حتى ش٦ — النوع مُضيَّق عمداً ليمسك TypeScript أيّ إرجاعٍ سهويّ.
  const [feeCollection, setFeeCollection] = useState<"COURIER" | "SHOP">("COURIER");
  const [name, setName] = useState(row.customerName ?? row.contactName ?? "");
  const [phone, setPhone] = useState(row.customerPhone ?? row.contactPhone ?? row.deliveryPhone ?? "");
  const [address, setAddress] = useState(row.deliveryAddress ?? "");
  const remaining = useMemo(() => Number(row.total) - Number(row.paidAmount ?? 0), [row]);
  const party = parties.find((p) => String(p.id) === partyId);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" dir="rtl">
      <div className="w-full max-w-md space-y-3 rounded-2xl bg-card p-4 shadow-2xl">
        <h3 className="text-sm font-extrabold">إسناد الفاتورة {row.invoiceNumber} للتوصيل</h3>

        <div className="space-y-1">
          <Label className="text-[11px]">جهة التوصيل</Label>
          <AppSelect
            value={partyId}
            onValueChange={(v) => {
              setPartyId(v);
              const p = parties.find((x) => String(x.id) === v);
              if (p) setFee(p.defaultFee ?? "0");
            }}
            aria-label="جهة التوصيل"
            placeholder="اختر مندوباً أو شركة"
          >
            <option value="">اختر مندوباً أو شركة</option>
            {parties.map((p) => (
              <option key={p.id} value={String(p.id)}>{p.name}</option>
            ))}
          </AppSelect>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[11px]">اسم المستلم</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">هاتف المستلم</Label>
            <IntlPhoneInput value={phone} onChange={setPhone} ariaLabel="هاتف المستلم" className="text-xs" />
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-[11px]">عنوان التوصيل</Label>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} className="h-8 text-xs" />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[11px]">أجرة التوصيل</Label>
            <MoneyInput value={fee} onChange={setFee} ariaLabel="أجرة التوصيل" className="text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">مَن يقبضها؟</Label>
            {/* ش٠ (V15): «مقبوضة في الكاشير» أُزيلت من مسار الفاتورة — لا قبضَ وارد يسبق الإرسال
                هنا (بخلاف أمر الشغل الذي يقبضها لحظة الإنشاء)، فقبولها يُنتج صرفاً للمندوب بلا
                قبضٍ يقابله ⇒ عجزٌ يمنع إغلاق الوردية. الخادم يحظرها أيضاً؛ تعود في ش٦ مع القبض. */}
            <AppSelect
              value={feeCollection}
              onValueChange={(v) => setFeeCollection(v as "COURIER" | "SHOP")}
              aria-label="من يقبض أجرة التوصيل"
            >
              <option value="COURIER">المندوب من الزبون</option>
              <option value="SHOP">على المكتبة</option>
            </AppSelect>
          </div>
        </div>

        {/* شفافية محاسبية صريحة: الأجرة ليست جزءاً ممّا يحصّله المندوب لنا. */}
        <p className="rounded-md border bg-muted/40 p-2 text-[11px] text-muted-foreground">
          يحصّل المندوب <span className="font-bold tabular-nums" dir="ltr">{fmt(remaining.toFixed(2))}</span> د.ع
          لصالح المكتبة (المتبقّي على الفاتورة). أجرة التوصيل مبلغٌ مستقلّ لا يدخل الفاتورة ولا الإيراد
          {feeCollection === "SHOP" && " — وتتحمّلها المكتبة كمصروف"}.
        </p>

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>إلغاء</Button>
          <Button
            className="flex-1"
            disabled={!partyId || pending}
            onClick={() => {
              if (!party) {
                notify.err("اختر جهة التوصيل");
                return;
              }
              onConfirm({
                partyId: Number(partyId),
                deliveryFee: fee || "0",
                feeCollection,
                recipientName: name.trim() || undefined,
                recipientPhone: phone.trim() || undefined,
                deliveryAddress: address.trim() || undefined,
              });
            }}
          >
            {pending ? "جارٍ الإسناد…" : "إسناد وإرسال"}
          </Button>
        </div>
      </div>
    </div>
  );
}
