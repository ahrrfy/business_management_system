import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";

/** الحقول التي يحتاجها الحوار فقط — DeliveryHub (delivery.readyForDispatch) وطابور الاستقبال
 *  (workOrders.list) كلاهما يُطابق هذا الشكل بنيوياً بلا تحويل. */
export interface DispatchableOrder {
  id: number;
  orderNumber: string;
  title: string;
  customerName?: string | null;
  customerPhone?: string | null;
  salePrice: string;
  deposit?: string | null;
  deliveryAddress?: string | null;
  deliveryPhone?: string | null;
}

export interface DispatchParty {
  id: number;
  name: string;
  partyType: "INDIVIDUAL" | "COMPANY";
  defaultFee: string;
}

export interface DispatchConfirmArgs {
  partyId: number;
  fee: string;
  recipientName: string;
  recipientPhone: string;
}

/**
 * حوار «تسليم لمندوب» — اِستقبال (تكامل التوصيل، ٤/٨): مُستخرَج من DeliveryHub.tsx ليُستعمَل أيضاً
 * من طابور استقبال أوامر الشغل (ReceptionOrderQueue) بلا ازدواج منطق.
 *
 * أُصلحت معه علّة موجودة: الحوار القديم كان يقبل partyId/fee فقط رغم أن مخطّط `delivery.dispatch`
 * والخدمة يقبلان recipientName/recipientPhone — فيصل المندوب بلا اسم/هاتف مستلم صريحين حتى لو
 * وُثِّقا عند إنشاء/تصنيف الأمر. الحقلان الآن قابلان للتحرير، ومُهيَّآن افتراضياً من بيانات الأمر
 * (اسم العميل + هاتف التوصيل الصريح أو هاتف العميل احتياطاً).
 */
export function DispatchDialog({ order, parties, pending, onClose, onConfirm }: {
  order: DispatchableOrder | null;
  parties: DispatchParty[];
  pending: boolean;
  onClose: () => void;
  onConfirm: (args: DispatchConfirmArgs) => void;
}) {
  const [partyId, setPartyId] = useState<string>("");
  const [fee, setFee] = useState<string>("0");
  const [recipientName, setRecipientName] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const selectedParty = parties.find((p) => String(p.id) === partyId);

  useMemo(() => {
    if (order) {
      setPartyId("");
      setFee("0");
      setRecipientName(order.customerName?.trim() || "");
      setRecipientPhone(order.deliveryPhone?.trim() || order.customerPhone?.trim() || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  if (!order) return null;
  const cod = Math.max(0, Number(order.salePrice) - Number(order.deposit ?? 0));

  const pickParty = (id: string) => {
    setPartyId(id);
    const p = parties.find((x) => String(x.id) === id);
    if (p) setFee(String(Number(p.defaultFee ?? 0)));
  };

  // النافذة نفسها هي حوار التأكيد (تعرض الجهة والمبالغ و«لا رجعة» صراحةً) ⇒ لا نفتح حوار تأكيد
  // ثانياً فوقها (نمط DeliveryHub الأصلي — راجع تعليقه التاريخي هناك).
  const submit = () => {
    if (!partyId) { notify.err("اختر جهة التوصيل"); return; }
    onConfirm({ partyId: Number(partyId), fee: fee || "0", recipientName: recipientName.trim(), recipientPhone: recipientPhone.trim() });
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-lg font-extrabold">تسليم «{order.title}» لمندوب</h3>
        <p className="mb-4 text-xs text-muted-foreground">{order.orderNumber} — {order.customerName ?? "عميل نقدي"}</p>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-bold">جهة التوصيل</label>
            <AppSelect value={partyId} onValueChange={pickParty} placeholder="— اختر —" className="h-11">
              {parties.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.partyType === "COMPANY" ? "شركة" : "مندوب"})</option>
              ))}
            </AppSelect>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-bold">أجرة التوصيل (د.ع)</label>
            <MoneyInput value={fee} onChange={setFee} className="h-11 text-end tabular-nums" ariaLabel="أجرة التوصيل" />
          </div>
        </div>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-bold">اسم المستلم</label>
            <Input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder="اسم من يستلم الطلب" className="h-11" />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-bold">هاتف المستلم</label>
            <IntlPhoneInput value={recipientPhone} onChange={setRecipientPhone} ariaLabel="هاتف المستلم" className="h-11" />
          </div>
        </div>
        <div className="mb-4 space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">سعر البيع</span><span dir="ltr" className="tabular-nums">{fmt(order.salePrice)} د.ع</span></div>
          {Number(order.deposit ?? 0) > 0 && <div className="flex justify-between"><span className="text-muted-foreground">العربون المقبوض</span><span dir="ltr" className="tabular-nums text-emerald-600">−{fmt(order.deposit ?? "0")} د.ع</span></div>}
          <div className="flex justify-between border-t pt-1 font-bold"><span>مبلغ التحصيل (COD)</span><span dir="ltr" className="tabular-nums">{fmt(String(cod))} د.ع</span></div>
        </div>
        <p className="mb-4 flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>ستُصدَر فاتورة وتُسجَّل {fmt(String(cod))} د.ع ذمّةً على «{selectedParty?.name ?? "المندوب"}». لا رجعة.</span>
        </p>
        <div className="flex gap-2.5">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={pending}>إلغاء</Button>
          <Button variant="destructive" className="flex-1" onClick={submit} disabled={pending || !partyId}>{pending ? "جارٍ…" : "تأكيد التسليم للمندوب"}</Button>
        </div>
      </div>
    </div>
  );
}
