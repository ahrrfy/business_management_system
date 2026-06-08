import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BarcodeDisplay } from "@/components/BarcodeDisplay";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";

const TYPE_OPTIONS = ["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"] as const;

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function fmt(s: string | number | null | undefined): string {
  if (s === null || s === undefined || s === "") return "—";
  return Number(s).toLocaleString("ar-IQ", { maximumFractionDigits: 2 });
}

export default function CustomerEdit() {
  const [, params] = useRoute<{ id: string }>("/customers/:id/edit");
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const customerId = Number(params?.id ?? 0);

  const detail = trpc.customers.get.useQuery({ customerId }, { enabled: customerId > 0 });

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
  const [done, setDone] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (detail.data && !loaded) {
      const c = detail.data;
      setName(c.name ?? "");
      setPhone(c.phone ?? "");
      setWhatsapp(c.whatsapp ?? "");
      setCustomerType((c.customerType as (typeof TYPE_OPTIONS)[number]) ?? "فرد");
      setDefaultPriceTier((c.defaultPriceTier as any) ?? "RETAIL");
      setCity(c.city ?? "");
      setDistrict(c.district ?? "");
      setAddress(c.address ?? "");
      setCreditLimit(c.creditLimit ? String(c.creditLimit) : "");
      setNotes(c.notes ?? "");
      setLoaded(true);
    }
  }, [detail.data, loaded]);

  const update = trpc.customers.update.useMutation({
    onSuccess: async () => {
      setDone("تمّ حفظ التعديلات بنجاح.");
      await Promise.all([
        utils.customers.search.invalidate(),
        utils.customers.list.invalidate(),
        utils.customers.get.invalidate({ customerId }),
      ]);
    },
    onError: (e) => setError(e.message),
  });

  const deactivate = trpc.customers.deactivate.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.customers.search.invalidate(),
        utils.customers.list.invalidate(),
        utils.customers.get.invalidate({ customerId }),
      ]);
    },
    onError: (e) => setError(e.message),
  });

  const activate = trpc.customers.activate.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.customers.search.invalidate(),
        utils.customers.list.invalidate(),
        utils.customers.get.invalidate({ customerId }),
      ]);
    },
    onError: (e) => setError(e.message),
  });

  function submit() {
    setError("");
    setDone("");
    if (!name.trim()) {
      setError("اسم العميل مطلوب.");
      return;
    }
    if (creditLimit.trim() && !/^\d+(\.\d{1,2})?$/.test(creditLimit.trim())) {
      setError("سقف الائتمان يجب أن يكون رقماً.");
      return;
    }
    update.mutate({
      customerId,
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

  if (!customerId) return <div className="p-6 text-center text-muted-foreground">معرّف عميل غير صالح.</div>;
  if (detail.isLoading) return <div className="p-6 text-center text-muted-foreground">جارٍ تحميل بيانات العميل…</div>;
  if (!detail.data) return <div className="p-6 text-center text-muted-foreground">العميل غير موجود. <Link className="text-primary underline" href="/customers">رجوع للقائمة</Link></div>;

  const c = detail.data;
  const isActive = !!c.isActive;

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">تعديل عميل</h1>
        <Link href="/customers" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">بطاقة العميل</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div className="text-muted-foreground text-xs">المعرّف</div><div className="font-mono" dir="ltr">#{Number(c.id)}</div></div>
          <div><div className="text-muted-foreground text-xs">الرصيد الحالي</div><div dir="ltr">{fmt(c.currentBalance)}</div></div>
          <div><div className="text-muted-foreground text-xs">سقف الائتمان</div><div dir="ltr">{fmt(c.creditLimit)}</div></div>
          <div>
            <div className="text-muted-foreground text-xs">الحالة</div>
            <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${isActive ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
              {isActive ? "مفعّل" : "معطّل"}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">البيانات الأساسية</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="name">اسم العميل *</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="type">النوع</Label>
            <select id="type" className={selectCls} value={customerType} onChange={(e) => setCustomerType(e.target.value as any)}>
              {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="phone">الهاتف</Label>
            <Input id="phone" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="whatsapp">واتساب</Label>
            <Input id="whatsapp" dir="ltr" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">العنوان</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="city">المدينة</Label>
            <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="district">المنطقة</Label>
            <Input id="district" value={district} onChange={(e) => setDistrict(e.target.value)} />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="address">العنوان التفصيلي</Label>
            <Input id="address" value={address} onChange={(e) => setAddress(e.target.value)} />
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
            <Input id="credit" dir="ltr" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="notes">ملاحظات</Label>
            <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {/* بطاقة QR العميل — تُمسح في POS لتحديده تلقائياً */}
      {detail.data?.qrPayload && (
        <Card>
          <CardHeader><CardTitle className="text-base">بطاقة العميل</CardTitle></CardHeader>
          <CardContent className="flex flex-col items-center gap-3 py-4">
            <BarcodeDisplay
              barcodeSet={{
                barcode128: `CUST-${String(customerId).padStart(5, "0")}`,
                qrPayload: detail.data.qrPayload,
                displayLabel: `${name}\nCUST-${String(customerId).padStart(5, "0")}`,
              }}
              size="md"
              showCode128={false}
            />
            <p className="text-xs text-muted-foreground text-center">امسح هذا الـ QR في نقطة البيع لتحديد العميل تلقائياً</p>
          </CardContent>
        </Card>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-emerald-600">{done}</p>}

      <div className="flex flex-wrap gap-2">
        <Button onClick={submit} disabled={update.isPending}>
          {update.isPending ? "جارٍ الحفظ…" : "حفظ التعديلات"}
        </Button>
        {isActive ? (
          <Button
            variant="outline"
            onClick={() => void (async () => {
              if (!(await confirm({
                variant: "danger",
                title: "تعطيل العميل",
                description: `سيُستثنى «${name || c.name}» من قوائم البيع. الفواتير المسوّاة تبقى. هل تتابع؟`,
                confirmText: "تعطيل",
              }))) return;
              deactivate.mutate({ customerId });
            })()}
            disabled={deactivate.isPending}
          >
            {deactivate.isPending ? "…" : "تعطيل العميل"}
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={() => activate.mutate({ customerId })}
            disabled={activate.isPending}
          >
            {activate.isPending ? "…" : "إعادة تفعيل"}
          </Button>
        )}
        <Link href="/customers"><Button variant="ghost">رجوع</Button></Link>
      </div>
    </div>
  );
}
