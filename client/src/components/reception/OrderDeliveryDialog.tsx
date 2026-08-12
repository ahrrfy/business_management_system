// ش٦ — كتلة التوصيل على مستوى الطلب: طلبٌ هاتفيّ بخطوةٍ واحدة (سلة + توصيل + تثبيت) بدل
// ثلاث (تثبيت ← طابور الفواتير ← إسناد). تُملأ قبل التثبيت وتُنفَّذ **بعده** (dispatchInvoice
// على الفاتورة المُنشأة) — وفشل الإسناد بعد تثبيتٍ ناجح يُعلَن بوسمِ إعادة محاولةٍ لا يُبتلَع.
// «مقبوضة في الاستقبال» (COUNTER): الأجرة تدخل الدرج نقداً مع السلة (deliveryFeeHeld خادمياً)
// فيرتفع حظر V15 — لأنّ الأمانة قُبضت فعلاً قبل صرفها للمندوب.
import { useState } from "react";
import Decimal from "decimal.js";
import { Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { notify } from "@/lib/notify";
import type { DispatchParty } from "@/components/delivery/DispatchDialog";

const D = (v: string | number) => new Decimal(v || 0);
const round2 = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export interface OrderDeliveryValue {
  partyId: number;
  partyName: string;
  fee: string;
  feeCollection: "COURIER" | "COUNTER" | "SHOP";
  recipientName: string;
  recipientPhone: string;
  address: string;
}

export default function OrderDeliveryDialog({
  parties,
  initial,
  defaultRecipientName,
  defaultRecipientPhone,
  onSave,
  onClear,
  onClose,
}: {
  parties: DispatchParty[];
  initial: OrderDeliveryValue | null;
  defaultRecipientName?: string | null;
  defaultRecipientPhone?: string | null;
  onSave: (v: OrderDeliveryValue) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [partyId, setPartyId] = useState(initial ? String(initial.partyId) : "");
  const [fee, setFee] = useState(initial?.fee ?? "");
  const [feeCollection, setFeeCollection] = useState<"COURIER" | "COUNTER" | "SHOP">(initial?.feeCollection ?? "COURIER");
  const [name, setName] = useState(initial?.recipientName ?? defaultRecipientName ?? "");
  const [phone, setPhone] = useState(initial?.recipientPhone ?? defaultRecipientPhone ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-md space-y-3 rounded-2xl bg-card p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="inline-flex items-center gap-1.5 text-sm font-extrabold">
          <Truck aria-hidden className="size-4" /> توصيل الطلب
        </h3>
        <p className="text-[11px] text-muted-foreground">
          يُثبَّت الطلب أولاً ثم تُسنَد فاتورته للتوصيل تلقائياً — وإن تعذّر الإسناد يبقى الطلب سليماً
          وتُسنده من طابور الفواتير.
        </p>

        <div className="space-y-1">
          <Label className="text-[11px]">جهة التوصيل</Label>
          <AppSelect
            value={partyId}
            onValueChange={(v) => {
              setPartyId(v);
              const p = parties.find((x) => String(x.id) === v);
              if (p && !fee) setFee(p.defaultFee ?? "0");
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
            <AppSelect
              value={feeCollection}
              onValueChange={(v) => setFeeCollection(v as "COURIER" | "COUNTER" | "SHOP")}
              aria-label="من يقبض أجرة التوصيل"
            >
              <option value="COURIER">المندوب من الزبون</option>
              <option value="COUNTER">مقبوضة في الاستقبال الآن</option>
              <option value="SHOP">على المكتبة</option>
            </AppSelect>
          </div>
        </div>

        {feeCollection === "COUNTER" && (
          <p className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--sem-warn)]">
            تقبض الأجرة نقداً الآن مع الطلب — تدخل درجك أمانةً للمندوب وتُصرف له عند توريده.
          </p>
        )}

        <div className="flex gap-2">
          {initial && (
            <Button variant="ghost" className="text-destructive" onClick={() => { onClear(); onClose(); }}>
              إلغاء التوصيل
            </Button>
          )}
          <Button variant="outline" className="flex-1" onClick={onClose}>رجوع</Button>
          <Button
            className="flex-1"
            disabled={!partyId}
            onClick={() => {
              const p = parties.find((x) => String(x.id) === partyId);
              if (!p) { notify.err("اختر جهة التوصيل"); return; }
              if (feeCollection === "COUNTER" && !D(fee || 0).gt(0)) {
                notify.err("«مقبوضة في الاستقبال» تتطلّب مبلغ أجرةٍ أكبر من صفر");
                return;
              }
              onSave({
                partyId: Number(partyId),
                partyName: p.name,
                fee: round2(D(fee || 0)).toFixed(2),
                feeCollection,
                recipientName: name.trim(),
                recipientPhone: phone.trim(),
                address: address.trim(),
              });
              onClose();
            }}
          >
            حفظ التوصيل
          </Button>
        </div>
      </div>
    </div>
  );
}
