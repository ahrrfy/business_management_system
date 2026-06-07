import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { Link, useLocation } from "wouter";

export default function SupplierNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

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

  const create = trpc.suppliers.create.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.suppliers.search.invalidate(), utils.suppliers.list.invalidate()]);
      navigate("/suppliers");
    },
    onError: (e) => setError(e.message),
  });

  function submit() {
    setError("");
    if (!name.trim()) return setError("اسم المورّد مطلوب.");
    create.mutate({
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

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">إضافة مورّد</h1>
        <Link href="/suppliers" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">البيانات الأساسية</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="name">اسم المورّد *</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: مكتبة الرشيد للورق" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="phone">الهاتف</Label>
            <Input id="phone" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07701234567" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="whatsapp">واتساب</Label>
            <Input id="whatsapp" dir="ltr" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="07701234567" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="email">البريد الإلكتروني</Label>
            <Input id="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="info@example.com" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">العنوان والنشاط</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="city">المدينة</Label>
            <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="بغداد" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="taxId">الرقم الضريبي (اختياري)</Label>
            <Input id="taxId" dir="ltr" value={taxId} onChange={(e) => setTaxId(e.target.value)} />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="address">العنوان التفصيلي</Label>
            <Input id="address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="شارع/بناية/علامة مميّزة" />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="ptypes">أنواع المنتجات المورَّدة</Label>
            <Input id="ptypes" value={productTypes} onChange={(e) => setProductTypes(e.target.value)} placeholder="ورق، أحبار، قرطاسية…" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">شروط التعامل</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="terms">شروط الدفع</Label>
            <Input id="terms" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="مثال: نقدي / آجل ٣٠ يوم" />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="notes">ملاحظات</Label>
            <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="تفضيلات، مندوب، أوقات التوريد…" />
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={create.isPending}>{create.isPending ? "جارٍ الحفظ…" : "حفظ المورّد"}</Button>
        <Link href="/suppliers"><Button variant="outline">إلغاء</Button></Link>
      </div>
    </div>
  );
}
