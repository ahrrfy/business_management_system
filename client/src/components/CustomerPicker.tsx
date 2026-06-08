import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { D } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import Decimal from "decimal.js";
import { useState } from "react";

type Tier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";

const TIER_LABEL: Record<Tier, string> = { RETAIL: "مفرد", WHOLESALE: "جملة", GOVERNMENT: "حكومي" };

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export interface CustomerPickerProps {
  customerId: number | null;
  onCustomerChange: (id: number | null) => void;
  /** ذمة العميل الحالية (إن وجد) لعرضها كشارة بجوار اسمه. */
  balance?: string | null;
}

/** اختيار عميل من القائمة + إضافة سريعة. لا يفرض شيئاً عند غياب العميل (يعني عميل عابر). */
export default function CustomerPicker({ customerId, onCustomerChange, balance }: CustomerPickerProps) {
  const utils = trpc.useUtils();
  const customers = trpc.customers.list.useQuery();
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [tier, setTier] = useState<Tier>("RETAIL");
  const [err, setErr] = useState("");

  const create = trpc.customers.create.useMutation({
    onSuccess: async (r) => {
      await utils.customers.list.invalidate();
      onCustomerChange(r.id);
      setShowNew(false);
      setName("");
      setPhone("");
      setTier("RETAIL");
      setErr("");
    },
    onError: (e) => setErr(e.message),
  });

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label>العميل (اختياري — مطلوب للبيع الآجل)</Label>
        {customerId != null && balance != null && (
          <span
            className={`text-xs rounded-full px-2 py-0.5 ${
              // §٥: مقارنة Decimal لا Number (يتفادى دقّة float على 0.1+0.2 ≠ 0.3).
              D(balance).gt(0) ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
            }`}
            title="رصيد ذمة العميل"
          >
            ذمة: <span dir="ltr">{D(balance).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber().toLocaleString("ar-IQ", { maximumFractionDigits: 2 })}</span>
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <select
          className={selectCls + " flex-1"}
          value={customerId ?? ""}
          onChange={(e) => onCustomerChange(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">— عميل عابر —</option>
          {(customers.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({TIER_LABEL[c.defaultPriceTier as Tier]})
            </option>
          ))}
        </select>
        <Button type="button" variant="outline" size="sm" onClick={() => setShowNew((v) => !v)}>
          {showNew ? "إلغاء" : "+"}
        </Button>
      </div>
      {showNew && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 pt-2">
          <Input placeholder="اسم العميل *" value={name} onChange={(e) => setName(e.target.value)} />
          <Input dir="ltr" placeholder="الهاتف" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <select className={selectCls} value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
            <option value="RETAIL">مفرد</option>
            <option value="WHOLESALE">جملة</option>
            <option value="GOVERNMENT">حكومي</option>
          </select>
          <Button
            type="button"
            size="sm"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate({ name: name.trim(), phone: phone.trim() || undefined, defaultPriceTier: tier })}
          >
            {create.isPending ? "جارٍ…" : "حفظ العميل"}
          </Button>
          {err && <p className="md:col-span-4 text-xs text-destructive">{err}</p>}
        </div>
      )}
    </div>
  );
}
