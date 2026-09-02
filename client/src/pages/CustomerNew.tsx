import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
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
import { confirm } from "@/lib/confirm";
// `fmtAr` لا `fmt`: هي صيغة العرض في شاشتَي العملاء الأخريَين (القائمة وبطاقة التعديل)، فالرصيد
// الواحد يُقرأ متطابقاً أينما ظهر. و`fmt` تحشو منزلتَين دائماً (500,000.00) وهو ضجيجٌ على دينارٍ
// لا فئة فيه أصغر من ٢٥٠. كلتاهما لاتينية الأرقام؛ الفارق كان في الحشو لا في الترقيم.
import { fmtAr as fmt, moneyInput } from "@/lib/money";
import { whatsappLink, displayE164 } from "@/lib/intlPhone";
import { TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useSaveShortcuts } from "@/hooks/useSaveShortcuts";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";

/**
 * إضافة عميل — v3 add-screens (+ تحسينات الأولوية العليا ٤/٧).
 *
 * تصميم:
 *  - بطاقات بيضاء، grid عمودان، RTL، الخط Cairo (موروث). ترويسة PageHeader موحّدة.
 *  - ٣ أرقام هاتف دولية (E.164) + حقل واتساب مستقلّ. لا بريد إلكتروني.
 *  - شارات حيّة: «الرئيسي» على أول رقم، تنويه واتساب.
 *  - نوع العميل يقترح فئة السعر تلقائياً (حكومي→حكومي، تاجر→جملة) قابلاً للتجاوز.
 *  - سقف الائتمان صريح بثلاثة أوضاع (نقدي فقط / سقف محدّد / بلا سقف)، محصور بالمدير.
 *  - اختصارات: Ctrl+S حفظ، Esc إلغاء. شريط أزرار ثابت أسفل الشاشة.
 *
 * العقد: ينادي `customers.create`. سقف الائتمان: "0"=نقدي فقط، null=بلا حدّ، رقم=سقف.
 * (الكاشير محجوب عن الحقل؛ الخادم يثبّته "0".) الواتساب يتبع الهاتف الرئيسي حتى يُلمَس الحقل.
 *
 * تماثلها مع `CustomerEdit` مقيسٌ نصّاً في `__tests__/customerFormParity.test.ts`: نفس الحقول،
 * ونفس صيغة عرض المال، ونفس مسار المغادرة المحروس بتأكيد. الفوارق الباقية مقصودة ومبرَّرة هناك.
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

export default function CustomerNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const me = trpc.auth.me.useQuery();
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [phone2, setPhone2] = useState("");
  const [phone3, setPhone3] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  // الواتساب كان يُرسَل ضمنياً = الهاتف الرئيسي بلا حقلٍ يعرضه، بينما شاشة التعديل تعرضه حقلاً
  // مستقلاً ⇒ رقمٌ يظهر عند التعديل ولم يره أحدٌ عند الإنشاء. صار ظاهراً هنا **متتبِّعاً** للهاتف
  // الرئيسي حتى يُلمَس، فالحمولة لمن لم يلمسه هي حمولة الأمس نفسها.
  const [whatsappTouched, setWhatsappTouched] = useState(false);
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

  /** لقطة الحقول القابلة للتحرير — نفس القائمة وترتيبها في `CustomerEdit` (تماثلٌ مقيس). */
  function dirtySnapshot(): string {
    return JSON.stringify([
      name, phone, phone2, phone3, whatsapp, customerType, defaultPriceTier,
      city, district, address, creditMode, creditLimit, notes, openingAmount, openingDir,
    ]);
  }
  // لقطة البداية تُلتقَط عند أول تصيير: شاشة الإضافة لا تنتظر خادماً، فالحالة الابتدائية هي
  // مرجعُها الصحيح (نظير لقطة الخادم في التعديل) ⇒ لا تحذير كاذب على شاشةٍ لم تُلمَس.
  const initialSnapshotRef = useRef<string | null>(null);
  if (initialSnapshotRef.current == null) initialSnapshotRef.current = dirtySnapshot();
  const isDirty = dirtySnapshot() !== initialSnapshotRef.current;

  // dup-detect (٦/٧): مفتاح idempotency — UUID واحد لكل فتح للنموذج. إعادة الإرسال بنفس المفتاح
  // (نقر مزدوج/انقطاع شبكة وإعادة محاولة) تعيد العميل نفسه من الخادم بدل إنشاء صفٍّ مكرّر.
  const clientRequestId = useMemo(() => crypto.randomUUID(), []);

  // dup-detect: تحذير تكرار حيّ — استعلام مرشّحين مشابهين (اسم مطبَّع/لاحقة هاتف) بتأخير كتابة.
  const [dupInput, setDupInput] = useState<{ name?: string; phones?: string[] }>({});
  useEffect(() => {
    const t = setTimeout(() => {
      const nm = name.trim();
      const phones = [phone, phone2, phone3]
        .map((p) => p.trim())
        .filter((p) => p.replace(/\D/g, "").length >= 7);
      setDupInput({
        name: nm.length >= 3 ? nm : undefined,
        phones: phones.length ? phones : undefined,
      });
    }, 400);
    return () => clearTimeout(t);
  }, [name, phone, phone2, phone3]);
  const dupEnabled = !!(dupInput.name || dupInput.phones?.length);
  const similar = trpc.customers.findSimilar.useQuery(dupInput, {
    enabled: dupEnabled,
    placeholderData: (prev) => prev,
  });
  const dupMatches = dupEnabled ? (similar.data ?? []) : [];

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

  /** الهاتف الرئيسي يقود رقم الواتساب ما لم يُدخِل المستخدم رقماً مختلفاً صراحةً. */
  function onPhoneChange(v: string) {
    setPhone(v);
    if (!whatsappTouched) setWhatsapp(v);
  }

  /** تغيير النوع: يقترح فئة السعر ما لم يعدّلها المستخدم يدوياً. */
  function onTypeChange(v: CustomerType) {
    setCustomerType(v);
    if (!tierTouched) setDefaultPriceTier(suggestedTier(v));
  }

  const tierMismatch =
    tierTouched && defaultPriceTier !== suggestedTier(customerType);

  function submit() {
    if (create.isPending) return; // حاجز واجهة أول؛ والحاجز البنيوي clientRequestId خادمياً (هجرة 0051).
    setError("");
    if (!name.trim()) {
      setError("اسم العميل مطلوب.");
      document.getElementById("name")?.focus(); // WCAG focus-management: انقل التركيز لأوّل حقل خاطئ.
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
        document.getElementById("credit")?.focus();
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
      whatsapp: whatsapp.trim() || null,
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
      clientRequestId,
    });
  }

  /** Esc/إلغاء: مغادرة مباشرة إن لم يُدخَل شيء، وإلا تأكيدٌ صريح (نظير `CustomerEdit`).
   *  المغادرة داخل SPA لا تُطلق `beforeunload`، فحارس التبويب وحده كان يترك نموذجاً معبَّأً
   *  يضيع بضغطة Esc واحدة بلا سؤال. */
  async function handleCancel() {
    if (isDirty) {
      const ok = await confirm({
        variant: "warning",
        title: "تجاهل البيانات المدخلة؟",
        description: "لديك بيانات عميل غير محفوظة. إن غادرت الآن ستضيع.",
        confirmText: "تجاهل ومغادرة",
      });
      if (!ok) return;
    }
    navigate("/customers");
  }

  // اختصارات: Ctrl+S حفظ، Esc إلغاء (بتأكيدٍ إن كان النموذج معبَّأً) — نظير نموذج السند.
  useSaveShortcuts({
    onSave: submit,
    onCancel: () => void handleCancel(),
    enabled: !create.isPending,
  });
  // حارس فقد البيانات عند تحديث/إغلاق التبويب/مغادرة خارجية.
  useUnsavedGuard(isDirty);

  const wa = whatsappLink(whatsapp || phone);

  return (
    <div className="space-y-4">
      <PageHeader
        title="إضافة عميل"
        description="سجّل عميلاً جديداً ببياناته وفئة سعره وسقف ائتمانه."
        actions={
          // زرّ لا رابط: يمرّ بنفس تأكيد Esc (handleCancel) — نقرة الفأرة لا تتجاوز تحذير فقد البيانات.
          // نتركه في `actions` (لا `backHref`) لأنّه يستدعي تأكيداً قبل الرجوع؛ backHref رابطٌ مباشر يتخطّاه.
          <button type="button" onClick={() => void handleCancel()} className="text-sm text-muted-foreground hover:underline">
            رجوع للقائمة
          </button>
        }
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
            <AppSelect
              id="type"
              className="h-9"
              value={customerType}
              onValueChange={(value) => onTypeChange(value as CustomerType)}
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </AppSelect>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">أرقام الهاتف</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            ٣ أرقام بصيغة دولية لدعم واتساب. الرقم الأول هو الرئيسي، ورقم الواتساب يتبعه ما لم تدخل غيره.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="ph1">
                الهاتف ١ <span className="text-[10px] text-primary mr-1">رئيسي</span>
              </Label>
              <IntlPhoneInput id="ph1" value={phone} onChange={onPhoneChange} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ph2">الهاتف ٢</Label>
              <IntlPhoneInput id="ph2" value={phone2} onChange={setPhone2} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ph3">الهاتف ٣</Label>
              <IntlPhoneInput id="ph3" value={phone3} onChange={setPhone3} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="whatsapp">واتساب</Label>
              <IntlPhoneInput
                id="whatsapp"
                value={whatsapp}
                onChange={(v) => {
                  setWhatsappTouched(true);
                  setWhatsapp(v);
                }}
              />
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

      {dupMatches.length > 0 && (
        <Card className="lg:col-span-2 border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/60" role="status" aria-live="polite">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-[var(--sem-warn)]">
              <TriangleAlert aria-hidden className="size-4" />
              عملاء مشابهون موجودون — تأكّد أنك لا تكرّر عميلاً قائماً
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {dupMatches.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-medium">{m.name}</span>
                {m.phone && (
                  <span dir="ltr" className="text-muted-foreground">{displayE164(m.phone)}</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {m.customerType}
                  {m.city ? ` — ${m.city}` : ""}
                </span>
                <span className="rounded border border-[var(--sem-warn)]/40 px-1.5 py-0.5 text-[10px] text-[var(--sem-warn)]">
                  {m.matchedOn === "phone" ? "تطابق هاتف" : m.matchedOn === "both" ? "تطابق اسم وهاتف" : "تشابه اسم"}
                </span>
                {!m.isActive && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">معطَّل</span>
                )}
                <Link href={`/customers/${m.id}/edit`} className="text-xs text-primary underline">
                  فتح البطاقة
                </Link>
              </div>
            ))}
            <p className="text-[11px] text-[var(--sem-warn)]">
              التحذير لا يمنع الحفظ — إن كان هو العميل نفسه فافتح بطاقته بدل إنشائه من جديد.
            </p>
          </CardContent>
        </Card>
      )}

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
            <AppSelect
              id="tier"
              className="h-9"
              value={defaultPriceTier}
              onValueChange={(value) => {
                setTierTouched(true);
                setDefaultPriceTier(value as PriceTier);
              }}
            >
              {PRICE_OPTIONS.map((o) => (
                <option key={o.v} value={o.v}>{o.l}</option>
              ))}
            </AppSelect>
            {tierMismatch && (
              <p className="text-[11px] text-[var(--sem-warn)]">
                النوع «{customerType}» يُسعَّر عادةً «{PRICE_OPTIONS.find((o) => o.v === suggestedTier(customerType))?.l}».
                هذه الفئة تُطبَّق تلقائياً في الكاشير.
              </p>
            )}
          </div>

          {isElevated ? (
            <div className="space-y-1">
              <Label htmlFor="creditMode">سقف الائتمان (البيع الآجل)</Label>
              <AppSelect
                id="creditMode"
                className="h-9"
                value={creditMode}
                onValueChange={(value) => setCreditMode(value as CreditMode)}
              >
                <option value="none">نقدي فقط (بلا بيع آجل)</option>
                <option value="limit">سقف محدّد…</option>
                <option value="unlimited">بلا سقف (بيع آجل مسموح دائماً)</option>
              </AppSelect>
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
              <AppSelect
                id="openDir"
                className="h-9"
                value={openingDir}
                onValueChange={(value) => setOpeningDir(value as "OWED_TO_US" | "OWED_BY_US")}
              >
                <option value="OWED_TO_US">لنا على العميل (مدين لنا)</option>
                <option value="OWED_BY_US">للعميل علينا (رصيد دائن / دفعة مقدّمة)</option>
              </AppSelect>
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
              {/* ممنوع `Number()` على مبلغ. و`D()` **ترمي** على مُدخَلٍ جزئيٍّ مشروع («.» عند كتابة
                  «.5») والرميُ هنا **داخل التصيير** ⇒ شاشةٌ بيضاء؛ فالقراءة بـ`moneyInput`. */}
              {moneyInput(openingAmount).greaterThan(0) ? (
                <p className="text-[11px] text-[var(--sem-warn)]">
                  سيُسجَّل قيد رصيد افتتاحي:{" "}
                  {openingDir === "OWED_TO_US"
                    ? `«لنا على العميل» ${fmt(moneyInput(openingAmount).toFixed(2))} د.ع (يبدأ رصيده مديناً لنا).`
                    : `«للعميل علينا» ${fmt(moneyInput(openingAmount).toFixed(2))} د.ع (يبدأ رصيده دائناً — كدفعة مقدّمة).`}{" "}
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
        <Button variant="outline" title="Esc" onClick={() => void handleCancel()}>إلغاء</Button>
      </div>
    </div>
  );
}
