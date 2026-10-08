/**
 * CompanyProfile — شاشة إدارة هوية وبيانات المنشأة المؤسسية.
 *
 * تتيح لمدراء المنشأة استعراض وتحديث:
 * - الاسم القانوني واسم الشهرة/العلامة التجارية والاسم المختصر.
 * - الأرقام القانونية والتراخيص (السجل التجاري، الرقم الضريبي، إجازة الغرفة).
 * - عنوان المقر الرئيسي مع ملخص الفروع التشغيلية.
 * - أرقام هواتف الأقسام المختلفة (الحسابات، المبيعات، الطباعة، وخدمة العملاء).
 * - رابط شعار المنشأة مع معاينة حية لترويسة المستندات والطباعة.
 */
import { useEffect, useState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { useSaveShortcuts } from "@/hooks/useSaveShortcuts";
import { ACTION_LABELS } from "@shared/actionLabels";
import { setDynamicCompanyProfile } from "@/lib/printing/brand";
import {
  Building2,
  FileText,
  Phone,
  MapPin,
  Image as ImageIcon,
  Plus,
  Trash2,
  Save,
  CheckCircle2,
  ShieldCheck,
  ShieldAlert,
  GitBranch,
} from "lucide-react";

interface PhoneEntry {
  id: string;
  label: string;
  number: string;
}

export default function CompanyProfile() {
  const utils = trpc.useUtils();
  const formId = useId();

  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";

  const profileQuery = trpc.system.getCompanyProfile.useQuery();
  const branchesQuery = trpc.branches.list.useQuery();

  const [name, setName] = useState("");
  const [tradeName, setTradeName] = useState("");
  const [shortName, setShortName] = useState("");
  const [legalSubtitle, setLegalSubtitle] = useState("");
  const [commercialRegistry, setCommercialRegistry] = useState("");
  const [taxNumber, setTaxNumber] = useState("");
  const [chamberLicense, setChamberLicense] = useState("");
  const [address, setAddress] = useState("");
  const [footerText, setFooterText] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [phones, setPhones] = useState<PhoneEntry[]>([]);

  // مزامنة النموذج مع البيانات المسترجعة
  useEffect(() => {
    if (profileQuery.data) {
      const d = profileQuery.data;
      setName(d.name || "");
      setTradeName(d.tradeName || "");
      setShortName(d.shortName || "");
      setLegalSubtitle(d.legalSubtitle || "");
      setCommercialRegistry(d.commercialRegistry || "");
      setTaxNumber(d.taxNumber || "");
      setChamberLicense(d.chamberLicense || "");
      setAddress(d.address || "");
      setFooterText(d.footerText || "");
      setLogoUrl(d.logoUrl || "");

      const mappedPhones = (d.phones || []).map((p, idx) => ({
        id: `${idx}-${p.label}-${p.number}`,
        label: p.label,
        number: p.number,
      }));
      setPhones(mappedPhones);

      // تحديث السياق المباشر لطباعة المستندات
      setDynamicCompanyProfile({
        name: d.name,
        sub: d.tradeName || d.name,
        short: d.shortName || d.name,
        subtitle: d.legalSubtitle || "",
        footer: d.footerText || "",
        address: d.address || "",
        taxId: d.taxNumber || "",
        commercialRegistry: d.commercialRegistry || "",
        chamberLicense: d.chamberLicense || "",
        phones: d.phones.map((p) => ({ l: p.label, n: p.number })),
        logoUrl: d.logoUrl || null,
      });
    }
  }, [profileQuery.data]);

  const updateMutation = trpc.system.updateCompanyProfile.useMutation({
    onSuccess: async (res) => {
      notify.ok("تم حفظ بيانات هوية المنشأة بنجاح");
      const d = res.profile;
      setDynamicCompanyProfile({
        name: d.name,
        sub: d.tradeName || d.name,
        short: d.shortName || d.name,
        subtitle: d.legalSubtitle || "",
        footer: d.footerText || "",
        address: d.address || "",
        taxId: d.taxNumber || "",
        commercialRegistry: d.commercialRegistry || "",
        chamberLicense: d.chamberLicense || "",
        phones: d.phones.map((p) => ({ l: p.label, n: p.number })),
        logoUrl: d.logoUrl || null,
      });
      await utils.system.getCompanyProfile.invalidate();
    },
    onError: (err) => {
      notify.err(err.message || "تعذّر حفظ بيانات المنشأة");
    },
  });

  const handleSubmit = () => {
    if (!isAdmin) {
      notify.err("تعديل بيانات المنشأة محصور بمدير النظام (Admin)");
      return;
    }
    if (!name.trim()) {
      notify.err("اسم المنشأة الرسمي مطلوب");
      return;
    }

    const payloadPhones = phones
      .map((p) => ({ label: p.label.trim(), number: p.number.trim() }))
      .filter((p) => p.number.length > 0);

    updateMutation.mutate({
      name: name.trim(),
      tradeName: tradeName.trim() || null,
      shortName: shortName.trim() || null,
      legalSubtitle: legalSubtitle.trim() || null,
      commercialRegistry: commercialRegistry.trim() || null,
      taxNumber: taxNumber.trim() || null,
      chamberLicense: chamberLicense.trim() || null,
      address: address.trim() || null,
      phones: payloadPhones,
      logoUrl: logoUrl.trim() || null,
      footerText: footerText.trim() || null,
    });
  };

  useSaveShortcuts({
    onSave: handleSubmit,
    enabled: isAdmin && !updateMutation.isPending,
  });

  const addPhone = () => {
    setPhones((prev) => [
      ...prev,
      { id: `new-${Date.now()}`, label: "قسم جديد", number: "" },
    ]);
  };

  const updatePhone = (id: string, field: "label" | "number", value: string) => {
    setPhones((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item)),
    );
  };

  const removePhone = (id: string) => {
    setPhones((prev) => prev.filter((item) => item.id !== id));
  };

  if (profileQuery.isLoading) {
    return <LoadingState message="جارٍ تحميل بيانات المنشأة…" />;
  }

  if (profileQuery.isError) {
    return (
      <ErrorState
        message={profileQuery.error.message || "تعذّر تحميل بيانات المنشأة"}
        onRetry={() => { void profileQuery.refetch(); }}
      />
    );
  }

  return (
    <div dir="rtl" className="space-y-6 pb-12">
      <PageHeader
        title="بيانات المنشأة والهوية المؤسسية"
        description="إدارة الاسم الرسمي، التراخيص القانونية، العناوين، هواتف الأقسام، وشعار المنشأة المعتمد لمستندات الطباعة الرسمية"
        actions={
          isAdmin ? (
            <Button
              onClick={handleSubmit}
              disabled={updateMutation.isPending}
              className="gap-2"
            >
              <Save aria-hidden className="size-4" />
              {updateMutation.isPending ? ACTION_LABELS.saving : "حفظ التغييرات"}
            </Button>
          ) : undefined
        }
      />

      {!isAdmin && (
        <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground flex items-center gap-3">
          <ShieldAlert aria-hidden className="size-5 text-[var(--sem-warn)] shrink-0" />
          <span>
            أنت تستعرض بيانات المنشأة بصفة «مدير» (عرض فقط). تعديل الأرقام القانونية وهوية المنشأة يتطلب صلاحية مدير النظام الكاملة (Admin).
          </span>
        </div>
      )}

      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
        className="space-y-6"
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* العمود الأيمن والأوسط: استمارات البيانات */}
          <div className="lg:col-span-2 space-y-6">
            {/* بطاقة الهوية الرسمية والتجارية */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2 text-foreground font-semibold">
                  <Building2 aria-hidden className="size-5 text-primary" />
                  <CardTitle className="text-base">الهوية الرسمية والتجارية</CardTitle>
                </div>
                <CardDescription>
                  الاسم المعتمد في السجلات الحكومية واسم الشهرة المتداول للمتجر والمطبوعات
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="company-name" className="text-sm font-medium">
                    الاسم القانوني الرسمي <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="company-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={!isAdmin}
                    placeholder="شركة الرؤية العربية للتجارة العامة..."
                    required
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="company-trade-name" className="text-sm font-medium">
                      اسم الشهرة / العلامة التجارية
                    </Label>
                    <Input
                      id="company-trade-name"
                      value={tradeName}
                      onChange={(e) => setTradeName(e.target.value)}
                      disabled={!isAdmin}
                      placeholder="مكتبة العربية للطباعة والقرطاسية"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="company-short-name" className="text-sm font-medium">
                      الاسم المختصر
                    </Label>
                    <Input
                      id="company-short-name"
                      value={shortName}
                      onChange={(e) => setShortName(e.target.value)}
                      disabled={!isAdmin}
                      placeholder="مكتبة العربية"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="company-subtitle" className="text-sm font-medium">
                    السطر التعريفي / التوصيف الرسمي
                  </Label>
                  <Input
                    id="company-subtitle"
                    value={legalSubtitle}
                    onChange={(e) => setLegalSubtitle(e.target.value)}
                    disabled={!isAdmin}
                    placeholder="للطباعة والقرطاسية والتجهيزات المدرسية والمكتبية"
                  />
                </div>
              </CardContent>
            </Card>

            {/* بطاقة التراخيص والبيانات القانونية */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2 text-foreground font-semibold">
                  <FileText aria-hidden className="size-5 text-primary" />
                  <CardTitle className="text-base">الأرقام القانونية والتراخيص</CardTitle>
                </div>
                <CardDescription>
                  تظهر هذه الأرقام في ترويسات الفواتير الضريبية وسندات الصرف والقبض الرسمية
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="company-cr" className="text-sm font-medium">
                      رقم السجل التجاري
                    </Label>
                    <Input
                      id="company-cr"
                      value={commercialRegistry}
                      onChange={(e) => setCommercialRegistry(e.target.value)}
                      disabled={!isAdmin}
                      placeholder="45217"
                      dir="ltr"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="company-tax" className="text-sm font-medium">
                      الرقم الضريبي (TIN)
                    </Label>
                    <Input
                      id="company-tax"
                      value={taxNumber}
                      onChange={(e) => setTaxNumber(e.target.value)}
                      disabled={!isAdmin}
                      placeholder="700124589"
                      dir="ltr"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="company-chamber" className="text-sm font-medium">
                      إجازة الغرفة التجارية
                    </Label>
                    <Input
                      id="company-chamber"
                      value={chamberLicense}
                      onChange={(e) => setChamberLicense(e.target.value)}
                      disabled={!isAdmin}
                      placeholder="CCB-11298"
                      dir="ltr"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* بطاقة المقر والفروع */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2 text-foreground font-semibold">
                  <MapPin aria-hidden className="size-5 text-primary" />
                  <CardTitle className="text-base">المقر الرئيسي والفروع التشغيلية</CardTitle>
                </div>
                <CardDescription>
                  عنوان الإدارة المركزية المسجل مع ملخص الفروع المرتبطة بالنظام
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="company-address" className="text-sm font-medium">
                    عنوان المقر الرئيسي
                  </Label>
                  <Input
                    id="company-address"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    disabled={!isAdmin}
                    placeholder="بغداد — العامرية / شارع العمل الشعبي"
                  />
                </div>

                <div className="space-y-2 pt-2">
                  <Label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                    <GitBranch aria-hidden className="size-3.5" /> الفروع التشغيلية المعرفة في النظام:
                  </Label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {branchesQuery.data?.map((b) => (
                      <div
                        key={b.id}
                        className="flex items-center justify-between p-3 rounded-md border border-border bg-card text-sm"
                      >
                        <div className="space-y-0.5">
                          <span className="font-medium text-foreground">{b.name}</span>
                          <p className="text-xs text-muted-foreground">رمز الفرع: {b.code}</p>
                        </div>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            b.isActive
                              ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border border-[var(--sem-pos)]/30"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {b.isActive ? "نشط" : "معطّل"}
                        </span>
                      </div>
                    ))}
                    {(!branchesQuery.data || branchesQuery.data.length === 0) && (
                      <p className="text-xs text-muted-foreground">لا فروع مسجلة</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* بطاقة أرقام هواتف الأقسام والتواصل */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 text-foreground font-semibold">
                    <Phone aria-hidden className="size-5 text-primary" />
                    <CardTitle className="text-base">أرقام أقسام التواصل</CardTitle>
                  </div>
                  <CardDescription>
                    أرقام الهواتف والواتساب المعتمدة لطباعتها على إيصالات وفواتير الزبائن
                  </CardDescription>
                </div>
                {isAdmin && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addPhone}
                    className="gap-1.5 text-xs"
                  >
                    <Plus aria-hidden className="size-3.5" /> إضافة قسم
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                {phones.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    لا أرقام هواتف مضافة بعد.
                  </p>
                ) : (
                  phones.map((p, idx) => (
                    <div
                      key={p.id}
                      className="flex items-center gap-3 p-2.5 rounded-md border border-border bg-muted/20"
                    >
                      <div className="w-1/3">
                        <Label htmlFor={`dept-lbl-${idx}`} className="sr-only">
                          اسم القسم
                        </Label>
                        <Input
                          id={`dept-lbl-${idx}`}
                          value={p.label}
                          onChange={(e) => updatePhone(p.id, "label", e.target.value)}
                          disabled={!isAdmin}
                          placeholder="القسم (مثال: الحسابات)"
                          className="h-9 text-xs"
                        />
                      </div>
                      <div className="flex-1">
                        <Label htmlFor={`dept-num-${idx}`} className="sr-only">
                          رقم الهاتف
                        </Label>
                        <IntlPhoneInput
                          id={`dept-num-${idx}`}
                          value={p.number}
                          onChange={(val) => updatePhone(p.id, "number", val)}
                          disabled={!isAdmin}
                          ariaLabel={`هاتف ${p.label || "القسم"}`}
                          className="h-9 text-xs font-mono"
                        />
                      </div>
                      {isAdmin && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removePhone(p.id)}
                          className="size-9 text-destructive hover:bg-destructive/10 shrink-0"
                          aria-label={`حذف هاتف ${p.label}`}
                        >
                          <Trash2 aria-hidden className="size-4" />
                        </Button>
                      )}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>

          {/* العمود الأيسر: الشعار والمعاينة الحية */}
          <div className="space-y-6">
            {/* بطاقة الشعار والفوتر */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2 text-foreground font-semibold">
                  <ImageIcon aria-hidden className="size-5 text-primary" />
                  <CardTitle className="text-base">شعار المنشأة والتذييل</CardTitle>
                </div>
                <CardDescription>
                  رابط الشعار المعتمد ونصوص الشكر أسفل الفواتير
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="company-logo-url" className="text-sm font-medium">
                    رابط الشعار (Logo URL)
                  </Label>
                  <Input
                    id="company-logo-url"
                    value={logoUrl}
                    onChange={(e) => setLogoUrl(e.target.value)}
                    disabled={!isAdmin}
                    placeholder="/logo.png أو رابط صورة مباشر"
                    dir="ltr"
                  />
                  <p className="text-xs text-muted-foreground">
                    اتركه فارغاً لاعتماد الشعار الافتراضي للنظام (/logo.png).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="company-footer-text" className="text-sm font-medium">
                    عبارة تذييل المستندات
                  </Label>
                  <Input
                    id="company-footer-text"
                    value={footerText}
                    onChange={(e) => setFooterText(e.target.value)}
                    disabled={!isAdmin}
                    placeholder="شكراً لتعاملكم مع مكتبة العربية"
                  />
                </div>
              </CardContent>
            </Card>

            {/* بطاقة المعاينة البصرية الحية لترويسة المستندات */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2 text-foreground font-semibold">
                  <ShieldCheck aria-hidden className="size-5 text-[var(--sem-pos)]" />
                  <CardTitle className="text-base">معاينة ترويسة الطباعة الرسمية</CardTitle>
                </div>
                <CardDescription>
                  كيف ستظهر هوية المنشأة في أعلى الفواتير والتقارير الرسمية (A4)
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-lg border-2 border-border p-4 bg-white text-black space-y-3 font-sans shadow-sm select-none">
                  {/* الرأس: شعار + معلومات منشأة */}
                  <div className="flex items-start justify-between border-b-2 border-black pb-3">
                    <div className="space-y-1 text-right">
                      <p className="font-extrabold text-xs text-black leading-tight">
                        {name || "شركة الرؤية العربية للتجارة العامة"}
                      </p>
                      <p className="text-[11px] font-semibold text-[#0D6B52]">
                        {tradeName || "مكتبة العربية للطباعة والقرطاسية"}
                      </p>
                      <div className="text-[9.5px] text-[#4E5148] space-y-0.5 pt-1">
                        <p>السجل التجاري: <span dir="ltr" className="font-mono font-bold text-black">{commercialRegistry || "45217"}</span></p>
                        <p>الرقم الضريبي: <span dir="ltr" className="font-mono font-bold text-black">{taxNumber || "700124589"}</span></p>
                        <p>إجازة الغرفة: <span dir="ltr" className="font-mono font-bold text-black">{chamberLicense || "CCB-11298"}</span></p>
                      </div>
                    </div>

                    <div className="flex flex-col items-center">
                      <div className="size-16 rounded border border-gray-300 p-1 flex items-center justify-center bg-gray-50 overflow-hidden">
                        <img
                          src={logoUrl.trim() || "/logo.png"}
                          alt="معاينة شعار المنشأة"
                          className="max-h-full max-w-full object-contain"
                          onError={(e) => {
                            (e.target as HTMLImageElement).src = "/logo.png";
                          }}
                        />
                      </div>
                      <span className="text-[9px] text-gray-500 mt-1 font-bold">شعار معتمد</span>
                    </div>
                  </div>

                  {/* المقر والهواتف المصغرة */}
                  <div className="text-[9px] text-[#4E5148] flex items-center justify-between pt-1">
                    <span>{address || "بغداد — العامرية / شارع العمل الشعبي"}</span>
                    <span dir="ltr" className="font-mono">
                      {phones[0]?.number || "07883000017"}
                    </span>
                  </div>

                  <div className="text-center text-[9px] text-gray-500 pt-1 border-t border-dashed border-gray-300">
                    {footerText || "شكراً لتعاملكم معنا"}
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-2 text-xs text-[var(--sem-pos)] font-medium">
                  <CheckCircle2 aria-hidden className="size-4 shrink-0" />
                  <span>تنعكس هذه الهوية فوراً على كافة قوالب فواتير A4 وإيصالات الكاشير الحرارية.</span>
                </div>
              </CardContent>
            </Card>

            {/* إجراءات الحفظ السفلية */}
            {isAdmin && (
              <Card>
                <CardContent className="p-4 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    اختصار لوحة المفاتيح: <kbd className="px-1.5 py-0.5 bg-muted rounded border text-[11px]">Ctrl+S</kbd>
                  </span>
                  <Button
                    onClick={handleSubmit}
                    disabled={updateMutation.isPending}
                    className="gap-2"
                  >
                    <Save aria-hidden className="size-4" />
                    {updateMutation.isPending ? ACTION_LABELS.saving : "حفظ التغييرات"}
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
