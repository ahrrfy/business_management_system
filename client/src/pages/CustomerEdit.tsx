import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { MoneyInput } from "@/components/form/MoneyInput";
import { FormError } from "@/components/form/FormError";
import { BarcodeDisplay } from "@/components/BarcodeDisplay";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { D, fmtAr as fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { whatsappLink, displayE164 } from "@/lib/intlPhone";
import { useSaveShortcuts } from "@/hooks/useSaveShortcuts";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";

/**
 * تعديل عميل — موحَّد على نمط شاشة الإضافة (CustomerNew v3).
 *
 * توحيد شكلي/تجريبي لا حذفي:
 *  - بطاقات بنفس تقسيم الإضافة + ٣ أرقام هاتف دولية (IntlPhoneInput) + واتساب صريح
 *    (يبقى حقلاً مستقلاً هنا لأن للعميل قيمة مخزّنة قد تخالف الرقم الرئيسي).
 *  - FormError موحّد + notify.ok/err + شريط أزرار سفلي ثابت + اختصارا Ctrl+S/Esc.
 *  - نوع العميل يقترح فئة السعر (ما لم تُلمَس الفئة يدوياً) — نظير الإضافة.
 *
 * ⚠️ دلالة سقف الائتمان الثلاثية (PR #125) محفوظة كما هي:
 *  - التحميل: null=بلا حدّ ⇒ "unlimited"، "0" ⇒ "none" (نقدي فقط)، >0 ⇒ "limit".
 *  - الحفظ: unlimited ⇒ null، none ⇒ "0"، limit ⇒ النص المُدخل. لا انقلاب صامت.
 *  - غير المدير: الحقل محجوب (get يحجب creditLimit أصلاً) ⇒ نرسل undefined
 *    فلا تُطمَس القيمة المخزّنة بقيمة محجوبة.
 *
 * تماثلها مع `CustomerNew` مقيسٌ نصّاً في `__tests__/customerFormParity.test.ts`: نفس الحقول،
 * ونفس صيغة عرض المال (`fmtAr`)، ونفس مسار المغادرة المحروس بتأكيد.
 *
 * تصحيح الرصيد الافتتاحي (٢٥/٧): بطاقةٌ للأدمن/المدير وحدهما تُعدّل قيد OPENING المرجعيّ وتُطبّق
 * الفارق على الرصيد الجاري (تصون النشاط اللاحق) — لتصحيح أخطاء الإدخال الأوّليّ. غير المرتفعين
 * لا يرون البطاقة ولا يرسلون الحقل (والخادم يُجرّده لهم احتياطاً).
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

/** فئة السعر المقترحة حسب نوع العميل (نظير شاشة الإضافة). */
function suggestedTier(t: CustomerType): PriceTier {
  if (t === "حكومي") return "GOVERNMENT";
  if (t === "تاجر") return "WHOLESALE";
  return "RETAIL";
}


export default function CustomerEdit() {
  const [, params] = useRoute<{ id: string }>("/customers/:id/edit");
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const customerId = Number(params?.id ?? 0);

  const detail = trpc.customers.get.useQuery({ customerId }, { enabled: customerId > 0 });
  const me = trpc.auth.me.useQuery();
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [phone2, setPhone2] = useState("");
  const [phone3, setPhone3] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [customerType, setCustomerType] = useState<CustomerType>("فرد");
  const [defaultPriceTier, setDefaultPriceTier] = useState<PriceTier>("RETAIL");
  const [tierTouched, setTierTouched] = useState(false);
  const [city, setCity] = useState("");
  const [district, setDistrict] = useState("");
  const [address, setAddress] = useState("");
  const [creditMode, setCreditMode] = useState<CreditMode>("none");
  const [creditLimit, setCreditLimit] = useState("");
  const [notes, setNotes] = useState("");
  // تصحيح الرصيد الافتتاحي (أدمن/مدير) — مبدئياً من قيد OPENING الحاليّ (openingBalance من get).
  const [openingAmount, setOpeningAmount] = useState("");
  const [openingDir, setOpeningDir] = useState<"OWED_TO_US" | "OWED_BY_US">("OWED_TO_US");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  // لقطة الحالة الأوّلية (بعد تحميل البيانات) — يقارَن بها الوضع الحاليّ لاكتشاف تعديلٍ حقيقيّ
  // (نمط EmployeeNew.tsx): null قبل التحميل ⇒ useUnsavedGuard لا يحذّر على شاشةٍ لم تُعدَّل بعد.
  const initialSnapshotRef = useRef<string | null>(null);

  function dirtySnapshot(): string {
    return JSON.stringify([
      name, phone, phone2, phone3, whatsapp, customerType, defaultPriceTier,
      city, district, address, creditMode, creditLimit, notes, openingAmount, openingDir,
    ]);
  }

  useEffect(() => {
    if (detail.data && !loaded) {
      const c = detail.data;
      setName(c.name ?? "");
      setPhone(c.phone ?? "");
      setPhone2(c.phone2 ?? "");
      setPhone3(c.phone3 ?? "");
      setWhatsapp(c.whatsapp ?? "");
      setCustomerType((c.customerType as CustomerType) ?? "فرد");
      setDefaultPriceTier((c.defaultPriceTier as PriceTier) ?? "RETAIL");
      setCity(c.city ?? "");
      setDistrict(c.district ?? "");
      setAddress(c.address ?? "");
      // دلالة سقف الائتمان: null=بلا حدّ، "0"=نقدي فقط، >0=سقف محدّد — نشتقّ الوضع للحفاظ عليها عند الحفظ.
      // ⛔ لا `Number()` على مبلغ: المقارنة بـDecimal (نفس نواة العرض والإرسال).
      if (c.creditLimit == null) { setCreditMode("unlimited"); setCreditLimit(""); }
      else if (D(c.creditLimit).isZero()) { setCreditMode("none"); setCreditLimit(""); }
      else { setCreditMode("limit"); setCreditLimit(String(c.creditLimit)); }
      setNotes(c.notes ?? "");
      // الرصيد الافتتاحي الموقَّع (من قيد OPENING): موجب = «لنا عليه»، سالب = «له علينا».
      const signedOpen = D((c as { openingBalance?: string }).openingBalance ?? 0);
      setOpeningAmount(signedOpen.isZero() ? "" : signedOpen.abs().toString());
      setOpeningDir(signedOpen.isNegative() ? "OWED_BY_US" : "OWED_TO_US");
      setLoaded(true);
    }
  }, [detail.data, loaded]);

  // اللقطة تُلتقَط بعد اكتمال setState أعلاه (تأثير منفصل تالٍ لتحديث الحالة فعلياً).
  useEffect(() => {
    if (loaded && initialSnapshotRef.current == null) {
      initialSnapshotRef.current = dirtySnapshot();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const isDirty = initialSnapshotRef.current != null && dirtySnapshot() !== initialSnapshotRef.current;

  const invalidate = () =>
    Promise.all([
      utils.customers.search.invalidate(),
      utils.customers.list.invalidate(),
      utils.customers.get.invalidate({ customerId }),
    ]);

  const update = trpc.customers.update.useMutation({
    onError: (e) => {
      setError(e.message);
      notify.err(e);
    },
    // ⛔ لا نضع onSuccess هنا: مراجعة Codex #978 P2 — TanStack Query يستبدل callbacks الطلبِ الجاري
    // بأحدث callbacks عند كل render، فقراءة `dirtySnapshot()` وقت وصول الاستجابة تلتقط تعديلاتٍ
    // أُضيفت **بعد** إرسال الطلب (مثال: عدّل «الملاحظات»، اضغط حفظ، عدّل «الهاتف» قبل الاستجابة
    // ⇒ baseline يصير «ملاحظات+هاتف» والخادم حفظ «ملاحظات» فقط ⇒ isDirty=false ⇒ يُفقد الهاتف
    // بلا تحذير). العلاجُ الآمن: التقاطُ اللقطة في اللحظة التي يُستدعى فيها `mutate` وتمريرُها عبر
    // `onSuccess` الخاصّ بذلك النداء (§ submit) — الإغلاقُ يُثبّت اللقطة على النداء لا على render.
  });

  const deactivate = trpc.customers.deactivate.useMutation({
    onSuccess: async () => {
      notify.ok("تمّ تعطيل العميل");
      await invalidate();
    },
    onError: (e) => {
      setError(e.message);
      notify.err(e);
    },
  });

  const activate = trpc.customers.activate.useMutation({
    onSuccess: async () => {
      notify.ok("تمّت إعادة تفعيل العميل");
      await invalidate();
    },
    onError: (e) => {
      setError(e.message);
      notify.err(e);
    },
  });

  /** تغيير النوع: يقترح فئة السعر ما لم يعدّلها المستخدم يدوياً (نظير شاشة الإضافة). */
  function onTypeChange(v: CustomerType) {
    setCustomerType(v);
    if (!tierTouched) setDefaultPriceTier(suggestedTier(v));
  }

  const tierMismatch = tierTouched && defaultPriceTier !== suggestedTier(customerType);

  function submit() {
    if (update.isPending) return; // يمنع الإرسال المزدوج (Ctrl+S/تكرار المفتاح).
    setError("");
    if (!name.trim()) {
      setError("اسم العميل مطلوب.");
      document.getElementById("name")?.focus(); // WCAG focus-management: التركيز لأوّل حقل خاطئ.
      return;
    }
    // سقف الائتمان الثلاثي (مدير/أدمن فقط — get يحجب القيمة لغيرهما فنرسل undefined كي لا تُطمَس).
    let creditLimitPayload: string | null | undefined;
    if (!isElevated) {
      creditLimitPayload = undefined;
    } else if (creditMode === "unlimited") {
      creditLimitPayload = null;
    } else if (creditMode === "limit") {
      const cc = creditLimit.trim();
      if (!cc || !/^\d+(\.\d{1,2})?$/.test(cc)) {
        setError("أدخل سقف ائتمان صحيحاً (مثال: 500000) أو اختر «نقدي فقط»/«بلا سقف».");
        document.getElementById("credit")?.focus();
        return;
      }
      creditLimitPayload = cc;
    } else {
      creditLimitPayload = "0"; // نقدي فقط.
    }
    // ⭐ التقاطُ لقطةِ **ما نُرسله الآن** — قبل استدعاء mutate — حتى تُصير baseline عند نجاح
    // *هذا* الطلب بالذات. تعديلٌ يُضاف بين الإرسال والاستجابة يظلّ dirty (مراجعة Codex #978 P2).
    const submittedSnapshot = dirtySnapshot();
    update.mutate(
      {
        customerId,
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
        // تصحيح الرصيد الافتتاحي — للمرتفعين فقط (undefined ⇒ الخادم لا يمسّ قيد OPENING). فارغ ⇒ "0"
        // يزيل القيد. القيمة غير المتغيّرة تصير فارقاً صفرياً بلا كتابة (لا مسّ بفترةٍ مُقفَلة).
        openingBalance: isElevated ? (openingAmount.trim() || "0") : undefined,
        openingBalanceDirection: isElevated ? openingDir : undefined,
        notes: notes.trim() || null,
      },
      {
        // per-call onSuccess: الإغلاقُ يُثبّت `submittedSnapshot` على هذا النداء بالذات، فلا
        // يُستبدَل بـcallback من render لاحق. `dirtySnapshot()` وقت الاستجابة كان يبتلع تعديلاتٍ
        // بين الإرسال والاستجابة فيُفقدها بلا تحذير عند المغادرة.
        onSuccess: async () => {
          notify.ok("تمّ حفظ التعديلات");
          await invalidate();
          // baseline = ما أُرسل فعلاً (لا ما يُعرَض الآن). فشلُ الحفظ يمرّ بـonError ⇒ لا نمسّ
          // baseline، فتبقى الحقول dirty ويظهر الحوار عند المغادرة.
          initialSnapshotRef.current = submittedSnapshot;
        },
      },
    );
  }

  /** Esc: رجوع مباشر إن لم يُعدَّل شيء، وإلا تأكيدٌ صريح قبل تجاهل التعديلات (بدل مغادرة صامتة). */
  async function handleCancel() {
    if (isDirty) {
      const ok = await confirm({
        variant: "warning",
        title: "تجاهل التعديلات؟",
        description: "لديك تعديلات غير محفوظة على بيانات هذا العميل. إن غادرت الآن ستُفقد.",
        confirmText: "تجاهل ومغادرة",
      });
      if (!ok) return;
    }
    navigate("/customers");
  }

  // اختصارات: Ctrl+S حفظ، Esc رجوع للقائمة (بتأكيدٍ إن كان هناك تعديل غير محفوظ).
  useSaveShortcuts({ onSave: submit, onCancel: () => void handleCancel(), enabled: !update.isPending });
  // حارس فقد البيانات عند تحديث/إغلاق التبويب/مغادرة خارجية.
  useUnsavedGuard(isDirty);

  const wa = whatsappLink(whatsapp || phone);

  if (!customerId) return <div className="p-6 text-center text-muted-foreground">معرّف عميل غير صالح.</div>;
  if (detail.isLoading) return <LoadingState message="جارٍ تحميل بيانات العميل…" />;
  if (!detail.data)
    return (
      <ErrorState
        message={<>العميل غير موجود. <Link className="text-primary underline" href="/customers">رجوع للقائمة</Link></>}
        onRetry={() => void detail.refetch()}
      />
    );

  const c = detail.data;
  const isActive = !!c.isActive;

  return (
    <div className="space-y-4">
      <PageHeader
        title="تعديل عميل"
        description="حدّث بيانات العميل وفئة سعره وسقف ائتمانه."
        actions={
          // زرّ لا رابط: يمرّ بنفس تأكيد Esc (handleCancel) — نقرة الفأرة لا تتجاوز تحذير فقد البيانات.
          // نتركه في `actions` (لا `backHref`) لأنّه يستدعي تأكيداً قبل الرجوع؛ backHref رابطٌ مباشر يتخطّى ذلك.
          <button type="button" onClick={() => void handleCancel()} className="text-sm text-muted-foreground hover:underline">
            رجوع للعملاء
          </button>
        }
      />

      <Card>
        <CardHeader><CardTitle className="text-base">بطاقة العميل</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div className="text-muted-foreground text-xs">المعرّف</div><div className="font-mono" dir="ltr">#{Number(c.id)}</div></div>
          {/* الحقلان المحجوبان لغير المدير (maskCustomerSensitive: creditLimit=null و currentBalance="0")
              يُعرضان «—» لا قيمةً مُختلَقة. كانت البطاقة تقرأ الحجب فتكتب «بلا حدّ» — أي تُعلن ائتماناً
              مفتوحاً لعميلٍ سقفُه «نقدي فقط»، و«0» رصيداً لمن عليه ملايين. نفس حارس شاشة العملاء. */}
          <div><div className="text-muted-foreground text-xs">الرصيد الحالي</div><div dir="ltr">{isElevated ? fmt(c.currentBalance) : "—"}</div></div>
          <div><div className="text-muted-foreground text-xs">سقف الائتمان</div><div dir="ltr">{isElevated && c.creditLimit == null ? "بلا حدّ" : isElevated ? fmt(c.creditLimit) : "—"}</div></div>
          <div>
            <div className="text-muted-foreground text-xs">الحالة</div>
            <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${isActive ? "badge-status-active" : "badge-stock-out"}`}>
              {isActive ? "مفعّل" : "معطّل"}
            </span>
          </div>
        </CardContent>
      </Card>

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
              ٣ أرقام بصيغة دولية لدعم واتساب. الرقم الأول هو الرئيسي.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="ph1">
                  الهاتف ١ <span className="text-[10px] text-primary mr-1">رئيسي</span>
                </Label>
                <IntlPhoneInput id="ph1" value={phone} onChange={setPhone} />
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
                  {creditMode === "none" && "لا يُباع لهذا العميل آجلاً حتى يُضبط سقف."}
                  {creditMode === "limit" && "أقصى دَين آجل مسموح — يُفحص تلقائياً عند كل بيع آجل."}
                  {creditMode === "unlimited" && "بيع آجل بلا حدّ مفروض — استعمله للعملاء الموثوقين فقط."}
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <Label>سقف الائتمان</Label>
                <p className="text-[12px] text-muted-foreground h-9 flex items-center">
                  يضبطه المدير — لا يتغيّر من هذه الشاشة.
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
          <Card className="lg:col-span-2 border-[var(--sem-info)]/40">
            <CardHeader>
              <CardTitle className="text-base">تصحيح الرصيد الافتتاحي</CardTitle>
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
                  <option value="OWED_BY_US">للعميل علينا (دفعة مقدّمة منه)</option>
                </AppSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="openAmt">المبلغ (د.ع)</Label>
                <MoneyInput id="openAmt" value={openingAmount} onChange={setOpeningAmount} placeholder="0" ariaLabel="مبلغ الرصيد الافتتاحي" />
              </div>
              <div className="md:col-span-2">
                <p className="text-[11px] text-[var(--sem-info)]">
                  يُصحّح قيد الرصيد الافتتاحي (لأخطاء الإدخال الأوّليّ) ويُطبّق الفارق على الرصيد الحالي
                  دون المساس بأي حركةٍ لاحقة. اتركه فارغاً لإزالة الرصيد الافتتاحي. لا يتغيّر شيء إن لم تُعدّله.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* بطاقة QR العميل — تُمسح في POS لتحديده تلقائياً */}
        {c.qrPayload && (
          <Card>
            <CardHeader><CardTitle className="text-base">بطاقة QR</CardTitle></CardHeader>
            <CardContent className="flex flex-col items-center gap-3 py-4">
              <BarcodeDisplay
                barcodeSet={{
                  barcode128: `CUST-${String(customerId).padStart(5, "0")}`,
                  qrPayload: c.qrPayload,
                  displayLabel: `${name}\nCUST-${String(customerId).padStart(5, "0")}`,
                }}
                size="md"
                showCode128={false}
              />
              <p className="text-xs text-muted-foreground text-center">امسح هذا الـ QR في نقطة البيع لتحديد العميل تلقائياً</p>
            </CardContent>
          </Card>
        )}
      </div>

      <FormError message={error} />
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t bg-background/95 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Button onClick={submit} disabled={update.isPending} title="Ctrl+S">
          {update.isPending ? ACTION_LABELS.saving : "حفظ التعديلات"}
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
        <Button variant="ghost" title="Esc" onClick={() => void handleCancel()}>رجوع</Button>
      </div>
    </div>
  );
}
