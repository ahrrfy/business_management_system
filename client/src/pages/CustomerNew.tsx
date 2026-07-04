import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { MoneyInput } from "@/components/form/MoneyInput";
import { FormError } from "@/components/form/FormError";
import { PageHeader } from "@/components/PageHeader";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmt } from "@/lib/money";
import { whatsappLink, displayE164 } from "@/lib/intlPhone";
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";

/**
 * إضافة عميل — v3 add-screens (+ تحسينات الأولوية العليا ٤/٧).
 *
 * تصميم:
 *  - بطاقات بيضاء، grid عمودان، RTL، الخط Cairo (موروث). ترويسة PageHeader موحّدة.
 *  - ٣ أرقام هاتف دولية (E.164). لا بريد إلكتروني.
 *  - شارات حيّة: «الرئيسي» على أول رقم، تنويه واتساب.
 *  - نوع العميل يقترح فئة السعر تلقائياً (حكومي→حكومي، تاجر→جملة) قابلاً للتجاوز.
 *  - سقف الائتمان صريح بثلاثة أوضاع (نقدي فقط / سقف محدّد / بلا سقف)، محصور بالمدير.
 *  - اختصارات: Ctrl+S حفظ، Esc إلغاء. شريط أزرار ثابت أسفل الشاشة.
 *
 * العقد: ينادي `customers.create`. سقف الائتمان: "0"=نقدي فقط، null=بلا حدّ، رقم=سقف.
 * (الكاشير محجوب عن الحقل؛ الخادم يثبّته "0".) الواتساب = الهاتف الرئيسي تلقائياً.
 */

const TYPE_OPTIONS = ["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"] as const;
type CustomerType = (typeof TYPE_OPTIONS)[number];
type PriceTier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";
type CreditMode = "none" | "limit" | "unlimited";

const PRICE_OPTIONS: { v: PriceTier; l: string }[] = [
  { v: "RETAIL", l: "مفرد" },
  { v: "WHOLESALE", l: "جملة" },
  { v: "GOVERNMENT", l: "حكومي" },
];

/** فئة السعر المقترحة حسب نوع العميل. */
function suggestedTier(t: CustomerType): PriceTier {
  if (t === "حكومي") return "GOVERNMENT";
  if (t === "تاجر") return "WHOLESALE";
  return "RETAIL";
}

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function CustomerNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const me = trpc.auth.me.useQuery();
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [phone2, setPhone2] = useState("");
  const [phone3, setPhone3] = useState("");
  const [customerType, setCustomerType] = useState<CustomerType>("فرد");
  const [defaultPriceTier, setDefaultPriceTier] = useState<PriceTier>("RETAIL");
  const [tierTouched, setTierTouched] = useState(false);
  const [city, setCity] = useState("");
  const [district, setDistrict] = useState("");
  const [address, setAddress] = useState("");
  const [creditMode, setCreditMode] = useState<CreditMode>("none");
  const [creditLimit, setCreditLimit] = useState("");
  const [openingAmount, setOpeningAmount] = useState("");
  const [openingDir, setOpeningDir] = useState<"OWED_TO_US" | "OWED_BY_US">("OWED_TO_US");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");

  const create = trpc.customers.create.useMutation({
    onSuccess: async () => {
      notify.ok("تمّ حفظ العميل");
      await Promise.all([
        utils.customers.search.invalidate(),
        utils.customers.list.invalidate(),
        utils.customers.smartSearch.invalidate(),
      ]);
      navigate("/customers");
    },
    onError: (e) => {
      setError(e.message);
      notify.err(e);
    },
  });

  /** تغيير النوع: يقترح فئة السعر ما لم يعدّلها المستخدم يدوياً. */
  function onTypeChange(v: CustomerType) {
    setCustomerType(v);
    if (!tierTouched) setDefaultPriceTier(suggestedTier(v));
  }

  const tierMismatch =
    tierTouched && defaultPriceTier !== suggestedTier(customerType);

  function submit() {
    setError("");
    if (!name.trim()) {
      setError("اسم العميل مطلوب.");
      return;
    }
    // سقف الائتمان (للمدير فقط؛ الكاشير محجوب والخادم يثبّته "0").
    let creditLimitPayload: string | null | undefined;
    if (!isElevated) {
      creditLimitPayload = undefined;
    } else if (creditMode === "unlimited") {
      creditLimitPayload = null;
    } else if (creditMode === "limit") {
      const c = creditLimit.trim();
      if (!c || !/^\d+(\.\d{1,2})?$/.test(c)) {
        setError("أدخل سقف ائتمان صحيحاً (مثال: 500000) أو اختر «نقدي فقط»/«بلا سقف».");
        return;
      }
      creditLimitPayload = c;
    } else {
      creditLimitPayload = "0"; // نقدي فقط.
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
      creditLimit: creditLimitPayload,
      // رصيد افتتاحي (مدير فقط؛ الخادم يُجرّده للكاشير). المبلغ غير سالب + الاتجاه.
      openingBalance: isElevated ? (openingAmount.trim() || null) : null,
      openingBalanceDirection: openingDir,
      notes: notes.trim() || null,
    });
  }

  // اختصارات: Ctrl+S حفظ، Esc إلغاء (نظير نموذج السند).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        navigate("/customers");
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
  }, [name, phone, phone2, phone3, customerType, defaultPriceTier, city, district, address, creditMode, creditLimit, openingAmount, openingDir, notes, isElevated]);

  const wa = whatsappLink(phone);

  return (
    <div className="space-y-4">
      <PageHeader
        title="إضافة عميل"
        description="سجّل عميلاً جديداً ببياناته وفئة سعره وسقف ائتمانه."
        actions={<Link href="/customers" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>}
      />

      <div className="grid gap-4 lg:grid-cols-2 items-start">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">البيانات الأساسية</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="name">اسم العميل <span className="text-destructive">*</span></Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثال: شركة الرفيع للتجارة"
              maxLength={255}
              autoFocus
              aria-required="true"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="type">النوع</Label>
            <select
              id="type"
              className={selectCls}
              value={customerType}
              onChange={(e) => onTypeChange(e.target.value as CustomerType)}
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

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">العنوان</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="space-y-1">
            <Label htmlFor="city">المدينة</Label>
            <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="بغداد" maxLength={100} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="district">المنطقة</Label>
            <Input id="district" value={district} onChange={(e) => setDistrict(e.target.value)} placeholder="كرادة" maxLength={100} />
          </div>
          <div className="space-y-1 md:col-span-2 lg:col-span-3">
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

      <Card className="lg:col-span-2">
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
              onChange={(e) => {
                setTierTouched(true);
                setDefaultPriceTier(e.target.value as PriceTier);
              }}
            >
              {PRICE_OPTIONS.map((o) => (
                <option key={o.v} value={o.v}>{o.l}</option>
              ))}
            </select>
            {tierMismatch && (
              <p className="text-[11px] text-amber-700">
                النوع «{customerType}» يُسعَّر عادةً «{PRICE_OPTIONS.find((o) => o.v === suggestedTier(customerType))?.l}».
                هذه الفئة تُطبَّق تلقائياً في الكاشير.
              </p>
            )}
          </div>

          {isElevated ? (
            <div className="space-y-1">
              <Label htmlFor="creditMode">سقف الائتمان (البيع الآجل)</Label>
              <select
                id="creditMode"
                className={selectCls}
                value={creditMode}
                onChange={(e) => setCreditMode(e.target.value as CreditMode)}
              >
                <option value="none">نقدي فقط (بلا بيع آجل)</option>
                <option value="limit">سقف محدّد…</option>
                <option value="unlimited">بلا سقف (بيع آجل مسموح دائماً)</option>
              </select>
              {creditMode === "limit" && (
                <MoneyInput
                  id="credit"
                  value={creditLimit}
                  onChange={setCreditLimit}
                  placeholder="500000"
                  ariaLabel="سقف الائتمان بالدينار"
                />
              )}
              <p className="text-[11px] text-muted-foreground">
                {creditMode === "none" && "لا يُباع لهذا العميل آجلاً حتى يُضبط سقف — الأنسب للعميل الجديد."}
                {creditMode === "limit" && "أقصى دَين آجل مسموح — يُفحص تلقائياً عند كل بيع آجل."}
                {creditMode === "unlimited" && "بيع آجل بلا حدّ مفروض — استعمله للعملاء الموثوقين فقط."}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              <Label>سقف الائتمان</Label>
              <p className="text-[12px] text-muted-foreground h-9 flex items-center">
                يضبطه المدير لاحقاً — العميل الجديد نقدي فقط افتراضياً.
              </p>
            </div>
          )}

          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="notes">ملاحظات</Label>
            <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="شروط دفع، تفضيلات…" rows={2} />
          </div>
        </CardContent>
      </Card>

      {isElevated && (
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
                <option value="OWED_TO_US">لنا على العميل (مدين لنا)</option>
                <option value="OWED_BY_US">للعميل علينا (رصيد دائن / دفعة مقدّمة)</option>
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
                  {openingDir === "OWED_TO_US"
                    ? `«لنا على العميل» ${fmt(openingAmount)} د.ع (يبدأ رصيده مديناً لنا).`
                    : `«للعميل علينا» ${fmt(openingAmount)} د.ع (يبدأ رصيده دائناً — كدفعة مقدّمة).`}{" "}
                  يظهر فوراً في كشف حساب العميل والأعمار.
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  اتركه فارغاً إن لم يكن للعميل رصيد سابق. يُنشئ قيد افتتاحي مرجعياً (لا يتكرّر).
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      </div>

      <FormError message={error} />
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t bg-background/95 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Button onClick={submit} disabled={create.isPending} title="Ctrl+S">
          {create.isPending ? "جارٍ الحفظ…" : "حفظ العميل"}
        </Button>
        <Link href="/customers">
          <Button variant="outline" title="Esc">إلغاء</Button>
        </Link>
      </div>
    </div>
  );
}
