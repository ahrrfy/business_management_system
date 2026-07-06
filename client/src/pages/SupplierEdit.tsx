import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { MoneyInput } from "@/components/form/MoneyInput";
import { FormError } from "@/components/form/FormError";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { fmtAr as fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { whatsappLink, displayE164 } from "@/lib/intlPhone";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { Star } from "lucide-react";

/**
 * تعديل مورّد — موحَّد على نمط شاشة الإضافة (SupplierNew v3).
 *
 * توحيد شكلي/تجريبي لا حذفي:
 *  - بطاقات بنفس تقسيم الإضافة: أساسية / هواتف / عنوان ونشاط / شروط وتقييم / بنكية.
 *  - ٣ أرقام هاتف دولية (IntlPhoneInput) + واتساب صريح (قيمة مخزّنة مستقلة).
 *  - تصنيف المورّد + مدّة التوريد + حدّ أدنى للطلب (MoneyInput) + تقييم ٥ نجوم —
 *    كانت حقولاً مدعومة خادمياً (suppliers.update) بلا واجهة تعديل.
 *  - البريد الإلكتروني حقل قائم بقيم مخزّنة ⇒ يبقى قابلاً للتعديل (لا حذف).
 *  - FormError موحّد + notify.ok/err + شريط أزرار سفلي ثابت + اختصارا Ctrl+S/Esc.
 *
 * البيانات البنكية محجوبة خادمياً لغير المدير/الأدمن (maskBankFields) ⇒ البطاقة
 * تظهر للمدير فقط، وغيره يرسل undefined كي لا تُطمَس القيم المخزّنة بقيم محجوبة.
 *
 * لا حقول رصيد افتتاحي هنا — الرصيد الافتتاحي خاصية إنشاء فقط (قيد OPENING لا يتكرّر).
 */

const CATEGORIES = ["محلي", "إقليمي", "دولي"] as const;
const PAYMENT_TERMS = ["نقدي فوري", "آجل 15 يوم", "آجل 30 يوم", "آجل 60 يوم", "آجل 90 يوم"];

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function SupplierEdit() {
  const [, params] = useRoute<{ id: string }>("/suppliers/:id/edit");
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const supplierId = Number(params?.id ?? 0);

  const detail = trpc.suppliers.get.useQuery({ supplierId }, { enabled: supplierId > 0 });
  const me = trpc.auth.me.useQuery();
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [phone2, setPhone2] = useState("");
  const [phone3, setPhone3] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [address, setAddress] = useState("");
  const [taxId, setTaxId] = useState("");
  const [productTypes, setProductTypes] = useState("");
  const [supplierCategory, setSupplierCategory] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("");
  const [minOrderAmount, setMinOrderAmount] = useState("");
  const [rating, setRating] = useState(0);
  const [iban, setIban] = useState("");
  const [bankName, setBankName] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (detail.data && !loaded) {
      const s = detail.data;
      setName(s.name ?? "");
      setPhone(s.phone ?? "");
      setPhone2(s.phone2 ?? "");
      setPhone3(s.phone3 ?? "");
      setWhatsapp(s.whatsapp ?? "");
      setEmail(s.email ?? "");
      setCity(s.city ?? "");
      setAddress(s.address ?? "");
      setTaxId(s.taxId ?? "");
      setProductTypes(s.productTypes ?? "");
      setSupplierCategory(s.supplierCategory ?? "");
      setPaymentTerms(s.paymentTerms ?? "");
      setLeadTimeDays(s.leadTimeDays != null ? String(s.leadTimeDays) : "");
      setMinOrderAmount(s.minOrderAmount != null ? String(s.minOrderAmount) : "");
      setRating(s.rating ?? 0);
      setIban(s.iban ?? "");
      setBankName(s.bankName ?? "");
      setNotes(s.notes ?? "");
      setLoaded(true);
    }
  }, [detail.data, loaded]);

  const update = trpc.suppliers.update.useMutation({
    onSuccess: async () => {
      notify.ok("تمّ حفظ التعديلات");
      await Promise.all([
        utils.suppliers.search.invalidate(),
        utils.suppliers.list.invalidate(),
        utils.suppliers.get.invalidate({ supplierId }),
      ]);
    },
    onError: (e) => {
      setError(e.message);
      notify.err(e);
    },
  });

  function submit() {
    if (update.isPending) return; // يمنع الإرسال المزدوج (Ctrl+S/تكرار المفتاح).
    setError("");
    if (!name.trim()) {
      setError("اسم المورّد مطلوب.");
      document.getElementById("name")?.focus(); // WCAG focus-management: التركيز لأوّل حقل خاطئ.
      return;
    }
    if (minOrderAmount.trim() && !/^\d+(\.\d{1,2})?$/.test(minOrderAmount.trim())) {
      setError("الحد الأدنى للطلب يجب أن يكون رقماً.");
      document.getElementById("moq")?.focus();
      return;
    }
    const lead = leadTimeDays.trim() ? parseInt(leadTimeDays, 10) : null;
    if (leadTimeDays.trim() && (!Number.isFinite(lead!) || lead! < 0 || lead! > 365)) {
      setError("مدة التوريد بين 0 و365 يوماً.");
      document.getElementById("lead")?.focus();
      return;
    }
    update.mutate({
      supplierId,
      name: name.trim(),
      phone: phone.trim() || null,
      phone2: phone2.trim() || null,
      phone3: phone3.trim() || null,
      whatsapp: whatsapp.trim() || null,
      email: email.trim() || null,
      address: address.trim() || null,
      city: city.trim() || null,
      taxId: taxId.trim() || null,
      productTypes: productTypes.trim() || null,
      paymentTerms: paymentTerms.trim() || null,
      supplierCategory: supplierCategory || null,
      leadTimeDays: lead,
      minOrderAmount: minOrderAmount.trim() || null,
      rating: rating > 0 ? rating : null,
      // البيانات البنكية محجوبة عن غير المدير في get ⇒ لا نرسلها كي لا تُطمَس القيم المخزّنة.
      iban: isElevated ? (iban.trim() || null) : undefined,
      bankName: isElevated ? (bankName.trim() || null) : undefined,
      notes: notes.trim() || null,
    });
  }

  // اختصارات: Ctrl+S حفظ، Esc رجوع للقائمة (نظير شاشة الإضافة).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        navigate("/suppliers");
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, phone, phone2, phone3, whatsapp, email, address, city, taxId, productTypes, supplierCategory, paymentTerms, leadTimeDays, minOrderAmount, rating, iban, bankName, notes, isElevated]);

  const wa = whatsappLink(whatsapp || phone);
  // قيمة مخزّنة خارج الخيارات القياسية تبقى ظاهرة وقابلة للاختيار (لا فقد بيانات صامت).
  const termOptions = paymentTerms && !PAYMENT_TERMS.includes(paymentTerms)
    ? [paymentTerms, ...PAYMENT_TERMS]
    : PAYMENT_TERMS;
  const categoryOptions: string[] = supplierCategory && !(CATEGORIES as readonly string[]).includes(supplierCategory)
    ? [supplierCategory, ...CATEGORIES]
    : [...CATEGORIES];

  if (!supplierId) return <div className="p-6 text-center text-muted-foreground">معرّف مورّد غير صالح.</div>;
  if (detail.isLoading) return <LoadingState message="جارٍ تحميل بيانات المورّد…" />;
  if (!detail.data)
    return (
      <ErrorState
        message={<>المورّد غير موجود. <Link className="text-primary underline" href="/suppliers">رجوع للقائمة</Link></>}
        onRetry={() => void detail.refetch()}
      />
    );

  return (
    <div className="space-y-4">
      <PageHeader
        title="تعديل مورّد"
        description={<>الرصيد الحالي: <span className="tabular-nums" dir="ltr">{fmt(detail.data.currentBalance)}</span> دينار</>}
        actions={<Link href="/suppliers" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>}
      />

      <div className="grid gap-4 lg:grid-cols-2 items-start">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">البيانات الأساسية</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="name">اسم المورّد <span className="text-destructive">*</span></Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثال: مكتبة الرشيد للورق"
                maxLength={255}
                aria-required="true"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cat">تصنيف المورّد</Label>
              <select id="cat" className={selectCls} value={supplierCategory} onChange={(e) => setSupplierCategory(e.target.value)}>
                <option value="">—</option>
                {categoryOptions.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="taxId">الرقم الضريبي</Label>
              <Input id="taxId" dir="ltr" value={taxId} onChange={(e) => setTaxId(e.target.value)} placeholder="—" maxLength={50} />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="email">البريد الإلكتروني</Label>
              <Input id="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="—" maxLength={320} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">أرقام الهاتف</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              3 أرقام بصيغة دولية لدعم واتساب. الأول هو الرئيسي.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="ph1">Phone 1 <span className="text-[10px] text-primary mr-1">رئيسي</span></Label>
                <IntlPhoneInput id="ph1" value={phone} onChange={setPhone} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ph2">Phone 2</Label>
                <IntlPhoneInput id="ph2" value={phone2} onChange={setPhone2} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ph3">Phone 3</Label>
                <IntlPhoneInput id="ph3" value={phone3} onChange={setPhone3} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="whatsapp">واتساب</Label>
                <IntlPhoneInput id="whatsapp" value={whatsapp} onChange={setWhatsapp} />
                {wa && (
                  <p className="text-[11px] text-muted-foreground">
                    واتساب:{" "}
                    <a href={wa} target="_blank" rel="noreferrer" className="text-primary underline" dir="ltr">
                      {displayE164(whatsapp || phone)}
                    </a>
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">العنوان والنشاط</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label htmlFor="city">المدينة</Label>
              <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="بغداد" maxLength={100} />
            </div>
            <div className="space-y-1 lg:col-span-2">
              <Label htmlFor="prods">أنواع المنتجات</Label>
              <Input id="prods" value={productTypes} onChange={(e) => setProductTypes(e.target.value)} placeholder="مثال: ورق، أحبار، أدوات قرطاسية" />
            </div>
            <div className="space-y-1 md:col-span-2 lg:col-span-3">
              <Label htmlFor="address">العنوان التفصيلي</Label>
              <Textarea id="address" value={address} onChange={(e) => setAddress(e.target.value)} rows={2} placeholder="شارع/بناية/علامة" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">شروط التعامل والتقييم</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="terms">شروط الدفع</Label>
              <select id="terms" className={selectCls} value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)}>
                <option value="">—</option>
                {termOptions.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lead">مدة التوريد (يوم)</Label>
              <Input id="lead" dir="ltr" inputMode="numeric" maxLength={3} value={leadTimeDays}
                onChange={(e) => setLeadTimeDays(e.target.value.replace(/\D/g, ""))} placeholder="7" />
              <p className="text-[11px] text-muted-foreground">بين 0 و365 يوماً.</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="moq">الحد الأدنى للطلب (د.ع)</Label>
              <MoneyInput id="moq" value={minOrderAmount} onChange={setMinOrderAmount} placeholder="100000" ariaLabel="الحد الأدنى للطلب بالدينار" />
            </div>
            <div className="space-y-1">
              <Label>تقييم المورّد</Label>
              <div className="flex items-center gap-1.5 h-9" role="radiogroup" aria-label="تقييم المورّد">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={n === rating}
                    onClick={() => setRating(rating === n ? 0 : n)}
                    aria-label={`${n} نجوم`}
                    className={cn(
                      "transition-colors",
                      n <= rating ? "text-amber-500" : "text-muted-foreground/40 hover:text-muted-foreground"
                    )}
                  >
                    <Star aria-hidden className={cn("size-5", n <= rating && "fill-current")} />
                  </button>
                ))}
                {rating > 0 && (
                  <span className="text-xs text-muted-foreground ml-2" dir="ltr">{rating} / 5</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{isElevated ? "البيانات البنكية (اختياري)" : "ملاحظات"}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {isElevated && (
              <>
                <div className="space-y-1">
                  <Label htmlFor="bank">اسم البنك</Label>
                  <Input id="bank" value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="مثال: مصرف الرافدين" maxLength={120} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="iban">IBAN / رقم الحساب</Label>
                  <Input id="iban" dir="ltr" value={iban} onChange={(e) => setIban(e.target.value)} placeholder="IQ00 ...." maxLength={64} />
                </div>
              </>
            )}
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="notes">ملاحظات</Label>
              <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="مندوب، أيام التوريد، تفضيلات…" />
            </div>
          </CardContent>
        </Card>
      </div>

      <FormError message={error} />
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t bg-background/95 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Button onClick={submit} disabled={update.isPending} title="Ctrl+S">
          {update.isPending ? "جارٍ الحفظ…" : "حفظ التعديلات"}
        </Button>
        <Link href="/suppliers"><Button variant="outline" title="Esc">رجوع</Button></Link>
      </div>
    </div>
  );
}
