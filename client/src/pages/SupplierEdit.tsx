import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";

function fmt(s: string | number | null | undefined): string {
  if (s === null || s === undefined || s === "") return "—";
  return Number(s).toLocaleString("ar-IQ", { maximumFractionDigits: 2 });
}

export default function SupplierEdit() {
  const [, params] = useRoute<{ id: string }>("/suppliers/:id/edit");
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const supplierId = Number(params?.id ?? 0);

  const detail = trpc.suppliers.get.useQuery({ supplierId }, { enabled: supplierId > 0 });

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [address, setAddress] = useState("");
  const [taxId, setTaxId] = useState("");
  const [productTypes, setProductTypes] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (detail.data && !loaded) {
      const s = detail.data;
      setName(s.name ?? "");
      setPhone(s.phone ?? "");
      setWhatsapp(s.whatsapp ?? "");
      setEmail(s.email ?? "");
      setCity(s.city ?? "");
      setAddress(s.address ?? "");
      setTaxId(s.taxId ?? "");
      setProductTypes(s.productTypes ?? "");
      setPaymentTerms(s.paymentTerms ?? "");
      setNotes(s.notes ?? "");
      setLoaded(true);
    }
  }, [detail.data, loaded]);

  const update = trpc.suppliers.update.useMutation({
    onSuccess: async () => {
      setDone("تمّ حفظ التعديلات بنجاح.");
      await Promise.all([utils.suppliers.search.invalidate(), utils.suppliers.list.invalidate(), utils.suppliers.get.invalidate({ supplierId })]);
    },
    onError: (e) => { setError(e.message); setDone(""); },
  });

  function submit() {
    setError("");
    setDone("");
    if (!name.trim()) return setError("اسم المورّد مطلوب.");
    update.mutate({
      supplierId,
      name: name.trim(),
      phone: phone.trim() || null,
      whatsapp: whatsapp.trim() || null,
      email: email.trim() || null,
      city: city.trim() || null,
      address: address.trim() || null,
      taxId: taxId.trim() || null,
      productTypes: productTypes.trim() || null,
      paymentTerms: paymentTerms.trim() || null,
      notes: notes.trim() || null,
    });
  }

  if (detail.isLoading) return <div className="p-6 text-muted-foreground">جارٍ التحميل…</div>;
  if (!detail.data) return <div className="p-6 text-muted-foreground">المورّد غير موجود. <Link href="/suppliers" className="text-primary">← القائمة</Link></div>;

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">تعديل مورّد</h1>
        <Link href="/suppliers" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>
      </div>
      <p className="text-sm text-muted-foreground">الرصيد الحالي: <span className="tabular-nums" dir="ltr">{fmt(detail.data.currentBalance)}</span> دينار</p>

      <Card>
        <CardHeader><CardTitle className="text-base">البيانات الأساسية</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1"><Label htmlFor="name">اسم المورّد *</Label><Input id="name" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="phone">الهاتف</Label><Input id="phone" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="whatsapp">واتساب</Label><Input id="whatsapp" dir="ltr" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="email">البريد الإلكتروني</Label><Input id="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">العنوان والنشاط</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1"><Label htmlFor="city">المدينة</Label><Input id="city" value={city} onChange={(e) => setCity(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="taxId">الرقم الضريبي</Label><Input id="taxId" dir="ltr" value={taxId} onChange={(e) => setTaxId(e.target.value)} /></div>
          <div className="space-y-1 md:col-span-2"><Label htmlFor="address">العنوان التفصيلي</Label><Input id="address" value={address} onChange={(e) => setAddress(e.target.value)} /></div>
          <div className="space-y-1 md:col-span-2"><Label htmlFor="ptypes">أنواع المنتجات المورَّدة</Label><Input id="ptypes" value={productTypes} onChange={(e) => setProductTypes(e.target.value)} /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">شروط التعامل</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1"><Label htmlFor="terms">شروط الدفع</Label><Input id="terms" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} /></div>
          <div className="space-y-1 md:col-span-2"><Label htmlFor="notes">ملاحظات</Label><Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-emerald-700">{done}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={update.isPending}>{update.isPending ? "جارٍ الحفظ…" : "حفظ التعديلات"}</Button>
        <Link href="/suppliers"><Button variant="outline">رجوع</Button></Link>
      </div>
    </div>
  );
}
