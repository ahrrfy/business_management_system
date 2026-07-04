import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { MoneyInput } from "@/components/form/MoneyInput";
import { FormError } from "@/components/form/FormError";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { fmt } from "@/lib/money";
import { whatsappLink, displayE164 } from "@/lib/intlPhone";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/PageHeader";
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Star } from "lucide-react";

/**
 * إضافة مورّد — v3 add-screens (+ تحسينات الأولوية العليا ٤/٧).
 *
 * تصميم:
 *  - ٣ أرقام هاتف دولية (E.164). لا بريد إلكتروني. معاينة رقم الواتساب الفعلي.
 *  - تصنيف المورّد + مدّة التوريد + حد أدنى للطلب (MoneyInput).
 *  - تقييم بـ٥ نجوم تفاعلية (radiogroup لقارئ الشاشة).
 *  - بيانات بنكية (IBAN + اسم البنك) — اختياريّة.
 *  - اختصارات: Ctrl+S حفظ، Esc إلغاء. شريط أزرار ثابت أسفل الشاشة.
 */

const CATEGORIES = ["محلي", "إقليمي", "دولي"] as const;
const PAYMENT_TERMS = ["نقدي فوري", "آجل 15 يوم", "آجل 30 يوم", "آجل 60 يوم", "آجل 90 يوم"];

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function SupplierNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [phone2, setPhone2] = useState("");
  const [phone3, setPhone3] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [supplierCategory, setSupplierCategory] = useState<string>("محلي");
  const [productTypes, setProductTypes] = useState("");
  const [taxId, setTaxId] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("");
  const [minOrderAmount, setMinOrderAmount] = useState("");
  const [rating, setRating] = useState(0);
  const [iban, setIban] = useState("");
  const [bankName, setBankName] = useState("");
  const [openingAmount, setOpeningAmount] = useState("");
  const [openingDir, setOpeningDir] = useState<"OWED_TO_US" | "OWED_BY_US">("OWED_BY_US");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");

  const create = trpc.suppliers.create.useMutation({
    onSuccess: () => {
      notify.ok("تمّ حفظ المورّد");
      utils.suppliers.search.invalidate();
      utils.suppliers.list.invalidate();
      navigate("/suppliers");
    },
    onError: (e) => {
      setError(e.message);
      notify.err(e);
    },
  });

  function submit() {
    if (create.isPending) return; // يمنع الإرسال المزدوج عبر Ctrl+S/تكرار المفتاح (لا idempotency خادمية بعد).
    setError("");
    if (!name.trim()) {
      setError("اسم المورّد مطلوب.");
      return;
    }
    if (minOrderAmount.trim() && !/^\d+(\.\d{1,2})?$/.test(minOrderAmount.trim())) {
      setError("الحد الأدنى للطلب يجب أن يكون رقماً.");
      return;
    }
    const lead = leadTimeDays.trim() ? parseInt(leadTimeDays, 10) : null;
    if (leadTimeDays.trim() && (!Number.isFinite(lead!) || lead! < 0 || lead! > 365)) {
      setError("مدة التوريد بين 0 و365 يوماً.");
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
      taxId: taxId.trim() || null,
      productTypes: productTypes.trim() || null,
      paymentTerms: paymentTerms || null,
      supplierCategory: supplierCategory || null,
      leadTimeDays: lead,
      minOrderAmount: minOrderAmount.trim() || null,
      rating: rating > 0 ? rating : null,
      iban: iban.trim() || null,
      bankName: bankName.trim() || null,
      openingBalance: openingAmount.trim() || null,
      openingBalanceDirection: openingDir,
      notes: notes.trim() || null,
    });
  }

  // اختصارات: Ctrl+S حفظ، Esc إلغاء (نظير نموذج السند).
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
  }, [name, phone, phone2, phone3, address, city, supplierCategory, productTypes, taxId, paymentTerms, leadTimeDays, minOrderAmount, rating, iban, bankName, openingAmount, openingDir, notes]);

  const wa = whatsappLink(phone);

  return (
    <div className="space-y-4">
      <PageHeader
        title="إضافة مورّد"
        description="سجّل مورّداً جديداً ببياناته وشروط تعامله وتقييمه."
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
              autoFocus
              aria-required="true"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cat">تصنيف المورّد</Label>
            <select id="cat" className={selectCls} value={supplierCategory} onChange={(e) => setSupplierCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="taxId">الرقم الضريبي</Label>
            <Input id="taxId" dir="ltr" value={taxId} onChange={(e) => setTaxId(e.target.value)} placeholder="—" maxLength={50} />
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
              {PAYMENT_TERMS.map((t) => <option key={t} value={t}>{t}</option>)}
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
          <CardTitle className="text-base">البيانات البنكية (اختياري)</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="bank">اسم البنك</Label>
            <Input id="bank" value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="مثال: مصرف الرافدين" maxLength={120} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="iban">IBAN / رقم الحساب</Label>
            <Input id="iban" dir="ltr" value={iban} onChange={(e) => setIban(e.target.value)} placeholder="IQ00 ...." maxLength={64} />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="notes">ملاحظات</Label>
            <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="مندوب، أيام التوريد، تفضيلات…" />
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">الرصيد الافتتاحي (اختياري)</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="openDir">اتجاه الرصيد</Label>
            <select
              id="openDir"
              className={selectCls}
              value={openingDir}
              onChange={(e) => setOpeningDir(e.target.value as "OWED_TO_US" | "OWED_BY_US")}
            >
              <option value="OWED_BY_US">علينا للمورّد (مستحق له)</option>
              <option value="OWED_TO_US">لنا على المورّد (دفعة مقدّمة لنا)</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="openAmt">المبلغ (د.ع)</Label>
            <MoneyInput
              id="openAmt"
              value={openingAmount}
              onChange={setOpeningAmount}
              placeholder="0"
              ariaLabel="مبلغ الرصيد الافتتاحي"
            />
          </div>
          <div className="md:col-span-2">
            {openingAmount.trim() && Number(openingAmount) > 0 ? (
              <p className="text-[11px] text-amber-700">
                سيُسجَّل قيد رصيد افتتاحي:{" "}
                {openingDir === "OWED_BY_US"
                  ? `«علينا للمورّد» ${fmt(openingAmount)} د.ع (يبدأ رصيده مستحقاً له).`
                  : `«لنا على المورّد» ${fmt(openingAmount)} د.ع (يبدأ رصيده مديناً لنا — كدفعة مقدّمة).`}{" "}
                يظهر فوراً في كشف حساب المورّد والأعمار.
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                اتركه فارغاً إن لم يكن للمورّد رصيد سابق. يُنشئ قيد افتتاحي مرجعياً (لا يتكرّر).
              </p>
            )}
          </div>
        </CardContent>
      </Card>
      </div>

      <FormError message={error} />
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t bg-background/95 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Button onClick={submit} disabled={create.isPending} title="Ctrl+S">
          {create.isPending ? "جارٍ الحفظ…" : "حفظ المورّد"}
        </Button>
        <Link href="/suppliers"><Button variant="outline" title="Esc">إلغاء</Button></Link>
      </div>
    </div>
  );
}
