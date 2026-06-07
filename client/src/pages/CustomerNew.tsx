import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { Link, useLocation } from "wouter";

const TYPE_OPTIONS = ["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"] as const;

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function CustomerNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [customerType, setCustomerType] = useState<(typeof TYPE_OPTIONS)[number]>("فرد");
  const [defaultPriceTier, setDefaultPriceTier] = useState<"RETAIL" | "WHOLESALE" | "GOVERNMENT">("RETAIL");
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
      whatsapp: whatsapp.trim() || null,
      address: address.trim() || null,
      city: city.trim() || null,
      district: district.trim() || null,
      customerType,
      defaultPriceTier,
      creditLimit: creditLimit.trim() || null,
      notes: notes.trim() || null,
    });
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">إضافة عميل</h1>
        <Link href="/customers" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">البيانات الأساسية</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="name">اسم العميل *</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: شركة الرفيع للتجارة" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="type">النوع</Label>
            <select id="type" className={selectCls} value={customerType} onChange={(e) => setCustomerType(e.target.value as any)}>
              {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="phone">الهاتف</Label>
            <Input id="phone" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07701234567" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="whatsapp">واتساب</Label>
            <Input id="whatsapp" dir="ltr" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="07701234567" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">العنوان</CardTitle></CardHeader>
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
            <Input id="address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="شارع/بناية/علامة مميّزة" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">التسعير والائتمان</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="tier">فئة السعر الافتراضية</Label>
            <select id="tier" className={selectCls} value={defaultPriceTier} onChange={(e) => setDefaultPriceTier(e.target.value as any)}>
              <option value="RETAIL">مفرد</option>
              <option value="WHOLESALE">جملة</option>
              <option value="GOVERNMENT">حكومي</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="credit">سقف الائتمان (دينار)</Label>
            <Input id="credit" dir="ltr" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} placeholder="500000" />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="notes">ملاحظات</Label>
            <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="شروط دفع، تفضيلات…" />
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={create.isPending}>
          {create.isPending ? "جارٍ الحفظ…" : "حفظ العميل"}
        </Button>
        <Link href="/customers"><Button variant="outline">إلغاء</Button></Link>
      </div>
    </div>
  );
}
