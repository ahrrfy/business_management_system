import { useMemo, useState } from "react";
import { AlertTriangle, Truck, UserPlus } from "lucide-react";
import { Link } from "wouter";
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
  /** مَن يقبض الأجرة (Slice B، ٢٩/٨/٢٦): يحدّد ما يدفعه الزبون للمندوب صراحةً في المُلخّص. */
  deliveryFeeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
  deliveryCost?: string | null;
}

export interface DispatchParty {
  id: number;
  name: string;
  partyType: "INDIVIDUAL" | "COMPANY";
  defaultFee: string;
  userId?: number | null;
  hasPortalAccess?: boolean;
  drivers?: Array<{ userId: number; name: string }>;
}

export interface DispatchConfirmArgs {
  partyId: number;
  fee: string;
  recipientName: string;
  recipientPhone: string;
  assignedUserId?: number;
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
  const [assignedUserId, setAssignedUserId] = useState("");
  const selectedParty = parties.find((p) => String(p.id) === partyId);

  useMemo(() => {
    if (order) {
      setPartyId("");
      // الأجرة المُثبَّتة على الطلب سلفاً (سعر المكتبة للعميل) تسبق سعر المندوب — يبقى قابلاً للتعديل
      // إن اتّفق الاثنان على غيره لهذه الرحلة تحديداً.
      const preset = Number(order.deliveryCost ?? 0);
      setFee(preset > 0 ? String(preset) : "0");
      setRecipientName(order.customerName?.trim() || "");
      setRecipientPhone(order.deliveryPhone?.trim() || order.customerPhone?.trim() || "");
      setAssignedUserId("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  if (!order) return null;
  const cod = Math.max(0, Number(order.salePrice) - Number(order.deposit ?? 0));
  const feeNum = Math.max(0, Number(fee) || 0);
  const feeCollection = order.deliveryFeeCollection ?? "COURIER";
  // «الكلي الذي سيدفعه العميل للمندوب» — تغيَّر بمَن قبض الأجرة (بلاغ المالك ٢٨/٨/٢٦):
  //   COURIER: المندوب يقبض COD + الأجرة معاً.
  //   COUNTER: الأجرة قُبضت أمانةً في الاستقبال ⇒ للمندوب COD فقط.
  //   SHOP: المكتبة تدفع للمندوب ⇒ للمندوب COD فقط.
  const customerPaysCourier = feeCollection === "COURIER" ? cod + feeNum : cod;
  const feeCollectionLabel =
    feeCollection === "COURIER" ? "المندوب يقبض الأجرة"
    : feeCollection === "COUNTER" ? "الأجرة قُبضت مسبقاً في الاستقبال"
    : "المكتبة تتحمّل الأجرة";

  const pickParty = (id: string) => {
    setPartyId(id);
    setAssignedUserId("");
    const p = parties.find((x) => String(x.id) === id);
    if (p) setFee(String(Number(p.defaultFee ?? 0)));
  };

  // النافذة نفسها هي حوار التأكيد (تعرض الجهة والمبالغ و«لا رجعة» صراحةً) ⇒ لا نفتح حوار تأكيد
  // ثانياً فوقها (نمط DeliveryHub الأصلي — راجع تعليقه التاريخي هناك).
  const submit = () => {
    if (!partyId) { notify.err("اختر جهة التوصيل"); return; }
    onConfirm({
      partyId: Number(partyId),
      fee: fee || "0",
      recipientName: recipientName.trim(),
      recipientPhone: recipientPhone.trim(),
      assignedUserId: assignedUserId ? Number(assignedUserId) : undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-lg font-extrabold">تسليم «{order.title}» لمندوب</h3>
        <p className="mb-4 text-xs text-muted-foreground">{order.orderNumber} — {order.customerName ?? "عميل نقدي"}</p>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-bold">جهة التوصيل</label>
            {/* Slice DFP1 (٣٠/٨/٢٦، P1 UX): قائمةٌ فارغة كانت تُظهر منسدلاً فارغاً بلا سياق ⇒ المستعمِل
                عالق يظنّ عطباً. الآن: بطاقةٌ ظاهرة تُخبره صراحةً «لا مناديب مُعرَّفون بعد» بزرّ مباشر
                لإضافة جهةٍ جديدة، بدل قائمة صامتة. */}
            {parties.length === 0 ? (
              <div className="flex flex-col items-start gap-2 rounded-md border border-[var(--sem-warn)]/50 bg-[var(--sem-warn-bg)] p-3 text-xs">
                <div className="flex items-center gap-1.5 font-bold text-[var(--sem-warn)]">
                  <Truck aria-hidden className="size-3.5" />
                  لا مناديب أو شركات توصيل مُعرَّفون بعد
                </div>
                <div className="text-muted-foreground">
                  أضِف مندوباً أو شركة توصيل أوّلاً من صفحة «جهات التوصيل» ثمّ عُدْ لتسليم هذا الطلب.
                </div>
                <Link href="/delivery/parties" onClick={onClose}>
                  <Button size="sm" variant="outline" className="mt-1">
                    <UserPlus aria-hidden className="size-3.5" /> فتح صفحة جهات التوصيل
                  </Button>
                </Link>
              </div>
            ) : (
              <AppSelect value={partyId} onValueChange={pickParty} placeholder="— اختر —" className="h-11">
                {parties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.partyType === "COMPANY" ? "شركة" : "مندوب"}){p.hasPortalAccess === false ? " — بلا حساب بوابة" : ""}
                  </option>
                ))}
              </AppSelect>
            )}
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
          {Number(order.deposit ?? 0) > 0 && <div className="flex justify-between"><span className="text-muted-foreground">العربون المقبوض</span><span dir="ltr" className="tabular-nums text-[var(--sem-pos)]">−{fmt(order.deposit ?? "0")} د.ع</span></div>}
          <div className="flex justify-between border-t pt-1"><span className="text-muted-foreground">مبلغ التحصيل (COD)</span><span dir="ltr" className="tabular-nums">{fmt(String(cod))} د.ع</span></div>
          {/* Slice B (٢٩/٨/٢٦): «إجمالي ما يدفعه الزبون للمندوب» = COD (+ الأجرة إن كان المندوب يقبضها).
             بلاغ المالك: «يجب أن يعلم الزبون بالمبلغ الكلي النهائي شاملاً التوصيل». يُقرأ للزبون قبل الإرسال. */}
          {feeNum > 0 && (
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">أجرة التوصيل — {feeCollectionLabel}</span><span dir="ltr" className="tabular-nums">{fmt(String(feeNum))} د.ع</span></div>
          )}
          <div className="flex justify-between border-t border-[var(--sem-info)] pt-2 mt-1 text-base font-black text-[var(--sem-info)]">
            <span>يدفعه العميل للمندوب</span>
            <span dir="ltr" className="tabular-nums">{fmt(String(customerPaysCourier))} د.ع</span>
          </div>
        </div>
        {selectedParty?.partyType === "COMPANY" && (selectedParty.drivers?.length ?? 0) > 0 && (
          <div className="mb-3">
            <label className="mb-1.5 block text-sm font-bold">السائق داخل الشركة</label>
            <AppSelect
              value={assignedUserId}
              onValueChange={setAssignedUserId}
              placeholder="طابور الشركة — يطالب به أول سائق"
              className="h-11"
            >
              <option value="">طابور الشركة — يطالب به أول سائق</option>
              {selectedParty.drivers?.map((driver) => (
                <option key={driver.userId} value={driver.userId}>{driver.name}</option>
              ))}
            </AppSelect>
          </div>
        )}
        {selectedParty?.hasPortalAccess === false && (
          <p className="mb-3 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2 text-xs font-medium text-[var(--sem-warn)]">
            هذه الجهة بلا حساب بوابة؛ سيُسجَّل الإسناد إدارياً لكنها لن ترى الطلب في «توصيلاتي» حتى تربط حساباً بها.
          </p>
        )}
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
