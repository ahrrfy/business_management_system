import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { trpc } from "@/lib/trpc";
import { whatsappLink, displayE164 } from "@/lib/intlPhone";
import { useState } from "react";
import { Link, useLocation } from "wouter";

/**
 * إضافة عميل — v3 add-screens.
 *
 * تصميم:
 *  - بطاقات بيضاء، grid عمودان، RTL، الخط Cairo (موروث).
 *  - ٣ أرقام هاتف دولية (E.164). لا بريد إلكتروني.
 *  - شارات حيّة: «الرئيسي» على أول رقم، تنويه واتساب.
 *  - تسعير وائتمان (سقف الائتمان، رصيد افتتاحي اختياري).
 *
 * العقد: ينادي `customers.create` بالحقول الجديدة (phone/phone2/phone3) + الموجودة.
 * الواتساب = الهاتف الرئيسي تلقائياً (كله بصيغة دولية موحّدة).
 */

const TYPE_OPTIONS = ["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"] as const;
const PRICE_OPTIONS = [
  { v: "RETAIL", l: "مفرد" },
  { v: "WHOLESALE", l: "جملة" },
  { v: "GOVERNMENT", l: "حكومي" },
] as const;

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function CustomerNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [phone2, setPhone2] = useState("");
  const [phone3, setPhone3] = useState("");
  const [customerType, setCustomerType] = useState<(typeof TYPE_OPTIONS)[number]>("فرد");
  const [defaultPriceTier, setDefaultPriceTier] =
    useState<"RETAIL" | "WHOLESALE" | "GOVERNMENT">("RETAIL");
  const [city, setCity] = useState("");
  const [district, setDistrict] = useState("");
  const [address, setAddress] = useState("");
  const [creditLimit, setCreditLimit] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");

  const create = trpc.customers.create.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.customers.search.invalidate(),
        utils.customers.list.invalidate(),
        utils.customers.smartSearch.invalidate(),
      ]);
      navigate("/customers");
    },
    onError: (e) => setError(e.message),
  });

  function submit() {
    setError("");
    if (!name.trim()) {
      setError("اسم العميل مطلوب.");
      return;
    }
    if (creditLimit.trim() && !/^\d+(\.\d{1,2})?$/.test(creditLimit.trim())) {
      setError("سقف الائتمان يجب أن يكون رقماً (مثال: 500000 أو 500.50).");
      return;
    }
    create.mutate({
      name: name.trim(),
      phone: phone.trim() || null,
      phone2: phone2.trim() || null,
      phone3: phone3.trim() || null,
      whatsapp: phone.trim() || null,
      address: address.trim() || null,
      city: city.trim() || null,
      district: district.trim() || null,
      customerType,
      defaultPriceTier,
      creditLimit: creditLimit.trim() || null,
      notes: notes.trim() || null,
    });
  }

  const wa = whatsappLink(phone);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">إضافة عميل</h1>
        <Link href="/customers" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 items-start">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">البيانات الأساسية</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="name">اسم العميل *</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: شركة الرفيع للتجارة" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="type">النوع</Label>
            <select
              id="type"
              className={selectCls}
              value={customerType}
              onChange={(e) => setCustomerType(e.target.value as any)}
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">أرقام الهاتف</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            ٣ أرقام بصيغة دولية لدعم واتساب. الرقم الأول هو الرئيسي ويُستعمل للواتساب افتراضياً.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="ph1">
                Phone 1 <span className="text-[10px] text-primary mr-1">رئيسي</span>
              </Label>
              <IntlPhoneInput id="ph1" value={phone} onChange={setPhone} />
              {wa && (
                <p className="text-[11px] text-muted-foreground">
                  واتساب:{" "}
                  <a href={wa} target="_blank" rel="noreferrer" className="text-primary underline" dir="ltr">
                    {displayE164(phone)}
                  </a>
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="ph2">Phone 2</Label>
              <IntlPhoneInput id="ph2" value={phone2} onChange={setPhone2} />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="ph3">Phone 3</Label>
              <IntlPhoneInput id="ph3" value={phone3} onChange={setPhone3} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">العنوان</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="city">المدينة</Label>
            <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="بغداد" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="district">المنطقة</Label>
            <Input id="district" value={district} onChange={(e) => setDistrict(e.target.value)} placeholder="كرادة" />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="address">العنوان التفصيلي</Label>
            <Textarea
              id="address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="شارع/بناية/علامة مميّزة"
              rows={2}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">التسعير والائتمان</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="tier">فئة السعر الافتراضية</Label>
            <select
              id="tier"
              className={selectCls}
              value={defaultPriceTier}
              onChange={(e) => setDefaultPriceTier(e.target.value as any)}
            >
              {PRICE_OPTIONS.map((o) => (
                <option key={o.v} value={o.v}>{o.l}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="credit">سقف الائتمان (د.ع)</Label>
            <Input id="credit" dir="ltr" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} placeholder="500000" />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="notes">ملاحظات</Label>
            <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="شروط دفع، تفضيلات…" rows={2} />
          </div>
        </CardContent>
      </Card>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={create.isPending}>
          {create.isPending ? "جارٍ الحفظ…" : "حفظ العميل"}
        </Button>
        <Link href="/customers">
          <Button variant="outline">إلغاء</Button>
        </Link>
      </div>
    </div>
  );
}
