import {
  Calendar,
  CheckCircle2,
  DollarSign,
  Download,
  Info,
  Layers,
  Palette,
  Receipt,
  ShieldAlert,
  Sparkles,
  Tag,
  Ticket,
  Truck,
  UserCheck,
  Users,
  Zap,
} from "lucide-react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/product/variantBits";
import { MoneyInput } from "@/components/form/MoneyInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { trpc } from "@/lib/trpc";
import { DAYS_OF_WEEK, formatActiveDays, getBaghdadDayOfWeek } from "@shared/promotionScheduling";
import type {
  PromotionArchetype,
  PromotionDiscountType,
  PromotionFormData,
  PromotionScope,
} from "./promotionBuilderTypes";

interface PromotionBuilderFormProps {
  data: PromotionFormData;
  onChange: (updater: (prev: PromotionFormData) => PromotionFormData) => void;
  errors?: Record<string, string>;
}

const ARCHETYPES: Array<{
  id: PromotionArchetype;
  title: string;
  badge: string;
  description: string;
  icon: typeof Ticket;
}> = [
  {
    id: "COUPON_BATCH",
    title: "حملة كوبونات عامة وتوليد متعدد",
    badge: "توزيع وطباعة",
    description: "إصدار دفعات كوبونات متعددة وتصدير فوري لملف PDF بطاقات 54×84 مم للطباعة والتوزيع.",
    icon: Ticket,
  },
  {
    id: "AFFILIATE",
    title: "كوبون الشركاء والمؤثرين بالعمولة",
    badge: "تسويق بالعمولة",
    description: "كود مخصص باسم المسوق (مثل AHMED10) مع احتساب نسبة عمولة مئوية على المبيعات وتتبع الأداء.",
    icon: Users,
  },
  {
    id: "BOUNCE_BACK",
    title: "كوبون العودة التلقائي للكاشير",
    badge: "نقاط البيع POS",
    description: "يُطبع تلقائياً بأسفل إيصال الكاشير عند بلوغ الفاتورة حداً معيناً لتشجيع الزبون على العودة.",
    icon: Receipt,
  },
  {
    id: "FIRST_ORDER",
    title: "كوبون الترحيب للطلب الأول",
    badge: "عملاء جدد",
    description: "إصدار ذاتي للعميل الموثق فقط قبل إنشاء أول طلب متجر، مع قفل استخدام واحد حصري.",
    icon: UserCheck,
  },
  {
    id: "DIRECT_PROMO",
    title: "عرض خصم مباشر تلقائي",
    badge: "بدون كود كوبون",
    description: "تطبيق آلي ومباشر للخصم في الكاشير والمتجر عند استيفاء شروط السلة دون الحاجة لكود.",
    icon: Zap,
  },
];

export function PromotionBuilderForm({ data, onChange, errors = {} }: PromotionBuilderFormProps) {
  const campaignsQ = trpc.crm.campaigns.list.useQuery();

  function updateField<K extends keyof PromotionFormData>(field: K, value: PromotionFormData[K]) {
    onChange((prev) => ({ ...prev, [field]: value }));
  }

  function updateDesign<K extends keyof PromotionFormData["design"]>(key: K, value: PromotionFormData["design"][K]) {
    onChange((prev) => ({
      ...prev,
      design: { ...prev.design, [key]: value },
    }));
  }

  function selectArchetype(archetype: PromotionArchetype) {
    onChange((prev) => {
      let nextPrefix = prev.codePrefix;
      let nextSample = prev.sampleCode;
      let nextFirstOrder = false;
      let nextBounceBack = false;
      let nextBatchCount = prev.initialBatchCount;
      let nextExportPdf = prev.exportPdfOnCreate;

      if (archetype === "COUPON_BATCH") {
        nextPrefix = prev.codePrefix || "VIP";
        nextSample = `${nextPrefix}-2026`;
        nextBatchCount = prev.initialBatchCount > 0 ? prev.initialBatchCount : 20;
        nextExportPdf = true;
      } else if (archetype === "AFFILIATE") {
        nextPrefix = "PARTNER";
        nextSample = "PARTNER-10";
        nextBatchCount = 0;
        nextExportPdf = false;
      } else if (archetype === "BOUNCE_BACK") {
        nextBounceBack = true;
        nextPrefix = "NEXT";
        nextSample = "NEXT-7788";
        nextBatchCount = 0;
        nextExportPdf = false;
      } else if (archetype === "FIRST_ORDER") {
        nextFirstOrder = true;
        nextPrefix = "WELCOME";
        nextSample = "WELCOME-01";
        nextBatchCount = 0;
        nextExportPdf = false;
      } else if (archetype === "DIRECT_PROMO") {
        nextBatchCount = 0;
        nextExportPdf = false;
      }

      return {
        ...prev,
        archetype,
        codePrefix: nextPrefix,
        sampleCode: nextSample,
        isFirstOrderSelfService: nextFirstOrder,
        isAutoBounceBack: nextBounceBack,
        initialBatchCount: nextBatchCount,
        exportPdfOnCreate: nextExportPdf,
        perCouponLimit: nextFirstOrder ? 1 : prev.perCouponLimit,
        perCustomerLimit: nextFirstOrder ? 1 : prev.perCustomerLimit,
      };
    });
  }

  const isDirectPromo = data.archetype === "DIRECT_PROMO";
  const isCouponBatch = data.archetype === "COUPON_BATCH";
  const isAffiliate = data.archetype === "AFFILIATE";
  const isBounceBack = data.archetype === "BOUNCE_BACK";
  const isFirstOrder = data.archetype === "FIRST_ORDER";

  return (
    <div className="space-y-6">
      {/* 0. اختيار النمط الترويجي المعزول (Archetype Selector) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-bold text-foreground flex items-center gap-1.5">
            <Layers className="size-3.5 text-primary" />
            <span>اختر نوع الحملة والغرض الترويجي (النوع المعزول)</span>
          </label>
          <span className="text-[11px] text-muted-foreground">
            تخصيص الحقول والشاشات تلقائياً حسب نوع الحملة
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {ARCHETYPES.map((arch) => {
            const isSelected = data.archetype === arch.id;
            const Icon = arch.icon;
            return (
              <button
                key={arch.id}
                type="button"
                onClick={() => selectArchetype(arch.id)}
                className={`p-3 rounded-xl border text-right transition-all flex flex-col justify-between gap-2 ${
                  isSelected
                    ? "border-primary bg-primary/10 shadow-sm ring-1 ring-primary"
                    : "border-border/70 bg-card hover:bg-muted/40 hover:border-muted-foreground/30"
                }`}
              >
                <div className="flex items-start justify-between w-full">
                  <div className="flex items-center gap-2">
                    <div
                      className={`p-1.5 rounded-lg ${
                        isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                      }`}
                    >
                      <Icon className="size-4" />
                    </div>
                    <span className="text-xs font-bold text-foreground">{arch.title}</span>
                  </div>
                  <Badge variant={isSelected ? "default" : "outline"} className="text-[10px] shrink-0">
                    {arch.badge}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">
                  {arch.description}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* 1. بيانات الحملة الأساسية */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-sm font-bold flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Tag className="size-4 text-primary" />
              <span>1. بيانات العرض الترويجي</span>
            </span>
            <Badge variant="outline" className="text-[10px]">
              {ARCHETYPES.find((a) => a.id === data.archetype)?.title}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="اسم العرض والحملة" required hint={errors.name} className="md:col-span-2">
            <Input
              value={data.name}
              onChange={(e) => updateField("name", e.target.value)}
              placeholder="مثال: خصم الصيف الحصري للعملاء المميزين"
              dir="auto"
            />
          </Field>

          <Field label="الحملة المرتبطة (اختياري)">
            <AppSelect
              value={data.campaignId ? String(data.campaignId) : ""}
              onValueChange={(val) => updateField("campaignId", val ? Number(val) : null)}
              className="h-9 px-3"
            >
              <option value="">عرض مستقل (بلا حملة)</option>
              {(campaignsQ.data ?? []).map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </AppSelect>
          </Field>

          {!isDirectPromo && (
            <Field
              label={isAffiliate ? "رمز كوبون المسوق (الكود المباشر)" : "بادئة الكود (Prefix)"}
              required
              hint={errors.codePrefix || (isAffiliate ? "الكود الذي يشاركه المسوق مع متابعيه" : "البادئة التلقائية")}
            >
              <Input
                value={data.codePrefix}
                onChange={(e) =>
                  updateField("codePrefix", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12))
                }
                placeholder={isAffiliate ? "PARTNER10" : "VIP"}
                dir="ltr"
                maxLength={12}
              />
            </Field>
          )}

          {!isDirectPromo && (
            <Field label="رمز تجريبي للمعاينة الحية">
              <Input
                value={data.sampleCode}
                onChange={(e) => updateField("sampleCode", e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))}
                placeholder={isAffiliate ? "PARTNER10" : "VIP-2026"}
                dir="ltr"
              />
            </Field>
          )}

          <Field label="وصف الحملة الداخلي (اختياري)" className="md:col-span-2">
            <Textarea
              value={data.description}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="ملاحظات وتفاصيل داخلية لفريق المبيعات والمحاسبة..."
              rows={2}
            />
          </Field>
        </CardContent>
      </Card>

      {/* 2. الخصم المالي وصمامات الأمان المالية المانعة للخسائر */}
      <Card className="border shadow-sm border-primary/20">
        <CardHeader className="pb-3 border-b bg-primary/5">
          <CardTitle className="text-sm font-bold flex items-center justify-between">
            <span className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-primary" />
              <span>2. نوع الخصم وصمامات الأمان المالية (Safety Valves)</span>
            </span>
            <span className="text-xs font-normal text-muted-foreground flex items-center gap-1">
              <DollarSign className="size-3 text-primary" />
              <span>حماية صارمة ضد الخسائر</span>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="نوع الخصم" required>
            <AppSelect
              value={data.type}
              onValueChange={(val) => updateField("type", val as PromotionDiscountType)}
              className="h-9 px-3"
            >
              <option value="PERCENT">نسبة مئوية (%) مع سقف أقصى</option>
              <option value="AMOUNT">مبلغ مقطوع ثابت (د.ع)</option>
            </AppSelect>
          </Field>

          {data.type === "PERCENT" ? (
            <>
              <Field label="نسبة الخصم (%)" required hint={errors.discountPercent}>
                <Input
                  type="number"
                  min="0.1"
                  max="100"
                  step="0.1"
                  value={data.discountPercent}
                  onChange={(e) => updateField("discountPercent", e.target.value)}
                  placeholder="15"
                />
              </Field>

              <Field
                label="سقف الخصم الأقصى بالدينار (Cap)"
                required
                hint={errors.maxDiscountAmount || "صمام أمان إلزامي لمنع تجاوز الخصم هذا المبلغ"}
                className="md:col-span-2"
              >
                <MoneyInput
                  value={data.maxDiscountAmount}
                  onChange={(val) => updateField("maxDiscountAmount", val)}
                  placeholder="25000"
                />
              </Field>
            </>
          ) : (
            <Field label="مبلغ الخصم بالدينار (د.ع)" required hint={errors.discountAmount}>
              <MoneyInput
                value={data.discountAmount}
                onChange={(val) => updateField("discountAmount", val)}
                placeholder="10000"
              />
            </Field>
          )}

          <Field
            label="الحد الأدنى لقيمة الفاتورة لتفعيل الخصم"
            hint={errors.minOrderSpend || "اتركه 0 إذا كان الخصم متاحاً لأي قيمة مشتريات"}
            className="md:col-span-2"
          >
            <MoneyInput
              value={data.minOrderSpend}
              onChange={(val) => updateField("minOrderSpend", val)}
              placeholder="50000"
            />
          </Field>

          {/* مزايا التوصيل والشحن الإضافية */}
          <div className="md:col-span-2 flex items-start gap-2 rounded-lg border bg-muted/20 p-3">
            <Checkbox
              id="free-shipping"
              checked={data.freeShipping}
              onCheckedChange={(checked) => updateField("freeShipping", checked === true)}
            />
            <label htmlFor="free-shipping" className="text-xs cursor-pointer space-y-0.5">
              <span className="font-semibold block flex items-center gap-1.5">
                <Truck className="size-3.5 text-primary" />
                <span>توصيل مجاني مشمول مع هذا العرض</span>
              </span>
              <span className="text-muted-foreground block">
                تصفير أجور الشحن تلقائياً عند تطبيق العرض على الطلبات الإلكترونية
              </span>
            </label>
          </div>
        </CardContent>
      </Card>

      {/* 3. الإضافات والمميزات الخاصة بكل نوع معزول (Dedicated Feature Sections) */}

      {/* [أ] مميزات حملة الكوبونات العامة والتوليد المتعدد الفوري (COUPON_BATCH) */}
      {isCouponBatch && (
        <Card className="border shadow-sm border-primary/30 bg-primary/5">
          <CardHeader className="pb-3 border-b">
            <CardTitle className="text-sm font-bold flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Ticket className="size-4 text-primary" />
                <span>3. التوليد المتعدد والتصدير المباشر (Bulk Multi-Code Generation & PDF)</span>
              </span>
              <Badge variant="default" className="text-[10px]">
                إصدار فوري
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-foreground">
                  عدد الكوبونات للإصدار الفوري مع الحفظ
                </label>
                <span className="text-[11px] text-muted-foreground font-mono">
                  {data.initialBatchCount} كوبون جاهز للطباعة
                </span>
              </div>

              {/* أزرار اختيار الكمية السريعة */}
              <div className="flex flex-wrap gap-2">
                {[10, 25, 50, 100, 200, 500].map((count) => (
                  <Button
                    key={count}
                    type="button"
                    size="sm"
                    variant={data.initialBatchCount === count ? "default" : "outline"}
                    className="h-8 text-xs font-mono font-bold"
                    onClick={() => updateField("initialBatchCount", count)}
                  >
                    {count} كوبون
                  </Button>
                ))}
                <div className="w-28">
                  <Input
                    type="number"
                    min={0}
                    max={500}
                    value={data.initialBatchCount}
                    onChange={(e) => updateField("initialBatchCount", Math.max(0, Math.min(500, Number(e.target.value))))}
                    className="h-8 text-xs font-mono"
                    placeholder="مخصص..."
                  />
                </div>
              </div>
            </div>

            {/* إدخال قائمة أكواد مخصصة بديلة */}
            <Field
              label="أو: لصق قائمة أكواد مخصصة بالاسم (اختياري - كود بكل سطر)"
              hint="إذا أدخلت أكواداً هنا، فسيتم اعتمادها بدلاً من التوليد العشوائي"
            >
              <Textarea
                value={data.customCodesList}
                onChange={(e) => updateField("customCodesList", e.target.value)}
                placeholder={"SUMMER-01\nSUMMER-02\nSUMMER-03"}
                rows={3}
                dir="ltr"
                className="font-mono text-xs"
              />
            </Field>

            {/* خيار تصدير وتنزيل ملف PDF تلقائياً عند الحفظ */}
            <div className="flex items-start gap-2 rounded-lg border bg-background p-3">
              <Checkbox
                id="export-pdf-create"
                checked={data.exportPdfOnCreate}
                onCheckedChange={(checked) => updateField("exportPdfOnCreate", checked === true)}
              />
              <label htmlFor="export-pdf-create" className="text-xs cursor-pointer space-y-0.5">
                <span className="font-semibold block flex items-center gap-1.5 text-primary">
                  <Download className="size-3.5" />
                  <span>تصدير وتنزيل ملف PDF للبطاقات (54×84 مم) فور الحفظ مباشرة</span>
                </span>
                <span className="text-muted-foreground block">
                  يولّد ملف PDF عالي الدقة لكل كوبون بصفحة مستقلة جاهز للطباعة على مقصات البطاقات.
                </span>
              </label>
            </div>
          </CardContent>
        </Card>
      )}

      {/* [ب] مميزات كوبون الشركاء والمؤثرين بالعمولة (AFFILIATE) */}
      {isAffiliate && (
        <Card className="border shadow-sm border-blue-500/30 bg-blue-500/5">
          <CardHeader className="pb-3 border-b">
            <CardTitle className="text-sm font-bold flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Users className="size-4 text-blue-600 dark:text-blue-400" />
                <span>3. بيانات المسوق / الشريك الترويجي وحساب العمولات</span>
              </span>
              <Badge variant="outline" className="text-[10px] text-blue-600 border-blue-500/40">
                برنامج المؤثرين
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="اسم المسوق / صانع المحتوى" required hint={errors.affiliateName}>
              <Input
                value={data.affiliateName}
                onChange={(e) => updateField("affiliateName", e.target.value)}
                placeholder="مثال: أحمد للتسويق / قناة الرؤية التقنية"
              />
            </Field>

            <Field label="نسبة عمولة المسوق على المبيعات (%)" required hint={errors.affiliateCommissionRate || "نسبة مئوية من صافي المبيعات"}>
              <Input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={data.affiliateCommissionRate}
                onChange={(e) => updateField("affiliateCommissionRate", e.target.value)}
                placeholder="5.00"
              />
            </Field>

            <Field label="رقم هاتف المسوق للتواصل والتقارير" className="md:col-span-2">
              <IntlPhoneInput
                value={data.affiliatePhone}
                onChange={(val) => updateField("affiliatePhone", val)}
                placeholder="07700000000"
              />
            </Field>

            <div className="md:col-span-2 rounded-lg border bg-background p-3 text-xs text-muted-foreground space-y-1">
              <div className="font-semibold text-foreground">آلية العمل الذكية لكوبون الشريك:</div>
              <div>• يُصدر كود الكوبون المخصص باسم المسوق فوراً.</div>
              <div>• تُحتسب المبيعات والعمولات تلقائياً عند استخدام الكود في الكاشير أو المتجر الإلكتروني.</div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* [ج] مميزات كوبون العودة التلقائي للكاشير (BOUNCE_BACK) */}
      {isBounceBack && (
        <Card className="border shadow-sm border-amber-500/30 bg-amber-500/5">
          <CardHeader className="pb-3 border-b">
            <CardTitle className="text-sm font-bold flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Receipt className="size-4 text-amber-600 dark:text-amber-400" />
                <span>3. أتمتة إصدار كوبون العودة في الكاشير (POS Bounce-Back)</span>
              </span>
              <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-500/40">
                طباعة حرارية 80 مم
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field
              label="الحد الأدنى لقيمة الفاتورة لتفعيل الكوبون وطباعته (د.ع)"
              required
              hint={errors.autoBounceBackMinInvoice || "إذا بلغت الفاتورة هذا المبلغ، يصدر الكوبون تلقائياً"}
            >
              <MoneyInput
                value={data.autoBounceBackMinInvoice}
                onChange={(val) => updateField("autoBounceBackMinInvoice", val)}
                placeholder="50000"
              />
            </Field>

            <Field label="صلاحية كوبون العودة (بالأيام)">
              <Input
                type="number"
                min={1}
                max={365}
                value={data.bounceBackValidityDays}
                onChange={(e) => updateField("bounceBackValidityDays", Math.max(1, Number(e.target.value)))}
                placeholder="14"
              />
            </Field>

            <Field label="بادئة رمز العودة (Prefix)" required hint={errors.bounceBackPrefix}>
              <Input
                value={data.bounceBackPrefix}
                onChange={(e) =>
                  updateField("bounceBackPrefix", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12))
                }
                placeholder="NEXT"
                dir="ltr"
                maxLength={12}
              />
            </Field>

            <Field label="عنوان القسيمة في الإيصال الحراري" className="md:col-span-2">
              <Input
                value={data.bounceBackHeadline}
                onChange={(e) => updateField("bounceBackHeadline", e.target.value)}
                placeholder="قسيمة هدية لزيارتك القادمة — شكراً لتسوقك معنا"
              />
            </Field>

            <div className="md:col-span-2 rounded-lg border bg-background p-3 text-xs text-muted-foreground space-y-1">
              <div className="font-semibold text-foreground">فلسفة زيادة المبيعات عبر كاشيرات نقاط البيع:</div>
              <div>• يتعرف النظام على الفاتورة فور اعتماد الدفع في الكاشير.</div>
              <div>• إذا بلغت الفاتورة السقف المحدد، تُطبع قسيمة العودة تلقائياً في أسفل الإيصال مع باركود ورمز QR.</div>
              <div>• يتلقى موظف الكاشير تنبيهاً صوتياً وبصرياً لتذكير الزبون باستخدامها في زيارته القادمة.</div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* [د] مميزات كوبون الطلب الأول الترحيبي (FIRST_ORDER) */}
      {isFirstOrder && (
        <Card className="border shadow-sm border-purple-500/30 bg-purple-500/5">
          <CardHeader className="pb-3 border-b">
            <CardTitle className="text-sm font-bold flex items-center justify-between">
              <span className="flex items-center gap-2">
                <UserCheck className="size-4 text-purple-600 dark:text-purple-400" />
                <span>3. ضوابط كوبون الترحيب للطلب الأول (First-Order Welcome)</span>
              </span>
              <Badge variant="outline" className="text-[10px] text-purple-600 border-purple-500/40">
                استحقاق ذاتي
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-3">
            <div className="rounded-lg border bg-background p-3 text-xs text-muted-foreground space-y-2">
              <div className="font-bold text-foreground flex items-center gap-2">
                <CheckCircle2 className="size-4 text-purple-600" />
                <span>محمي بقفل تفعيل حصري لمنع ازدواجية العروض</span>
              </div>
              <div>• هذا الكوبون مخصص للعملاء الجدد في المتجر الإلكتروني.</div>
              <div>• يطلبه العميل الموثق ذاتياً قبل إنشاء أول طلب شراء له.</div>
              <div>• يفرض النظام تلقائياً حداً صارماً: استخدام واحد فقط لكل عميل وكوبون واحد فقط لكل عميل.</div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* [هـ] مميزات الخصم المباشر التلقائي (DIRECT_PROMO) */}
      {isDirectPromo && (
        <Card className="border shadow-sm border-emerald-500/30 bg-emerald-500/5">
          <CardHeader className="pb-3 border-b">
            <CardTitle className="text-sm font-bold flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Zap className="size-4 text-emerald-600 dark:text-emerald-400" />
                <span>3. خصائص التطبيق التلقائي المباشر (Direct Promotion)</span>
              </span>
              <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-500/40">
                تطبيق آلي
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-3">
            <div className="rounded-lg border bg-background p-3 text-xs text-muted-foreground space-y-1">
              <div className="font-bold text-foreground">بدون كود وبدون طباعة ورقية:</div>
              <div>• يُطبق هذا الخصم تلقائياً ومباشرة على فاتورة الزبون في الكاشير والمتجر فور استيفاء الشروط.</div>
              <div>• لا يتطلب من الكاشير أو العميل كتابة أو مسح أي كود.</div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 4. الصلاحية والجدولة الزمنية للأيام */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Calendar className="size-4 text-primary" />
            <span>4. الصلاحية وتحديد أيام الأسبوع</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="صالح من تاريخ" required hint={errors.validFrom}>
            <Input
              type="date"
              value={data.validFrom}
              onChange={(e) => updateField("validFrom", e.target.value)}
            />
          </Field>

          <Field label="صالح إلى تاريخ" hint={errors.validTo || "اتركه فارغاً لعرض مستمر"}>
            <Input
              type="date"
              value={data.validTo}
              onChange={(e) => updateField("validTo", e.target.value)}
            />
          </Field>

          {!isDirectPromo && !isFirstOrder && (
            <>
              <Field label="أقصى مرات استخدام للكوبون الواحد">
                <Input
                  type="number"
                  min={1}
                  max={1000}
                  value={data.perCouponLimit}
                  onChange={(e) => updateField("perCouponLimit", Math.max(1, Number(e.target.value)))}
                />
              </Field>

              <Field label="أقصى استخدام لكل عميل">
                <Input
                  type="number"
                  min={1}
                  max={1000}
                  value={data.perCustomerLimit}
                  onChange={(e) => updateField("perCustomerLimit", Math.max(1, Number(e.target.value)))}
                />
              </Field>
            </>
          )}

          {/* جدولة أيام الأسبوع المحددة */}
          <div className="md:col-span-2 rounded-lg border bg-muted/20 p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="text-xs font-bold block">أيام الأسبوع النشطة للعرض</span>
                <span className="text-xs text-muted-foreground block">
                  {formatActiveDays(data.activeDays)} — تحديد الأيام التي يُسمح فيها بتفعيل واستخدام هذا العرض
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs h-7"
                onClick={() => {
                  const allSelected = data.activeDays.length === 7;
                  updateField("activeDays", allSelected ? [getBaghdadDayOfWeek()] : [0, 1, 2, 3, 4, 5, 6]);
                }}
              >
                {data.activeDays.length === 7 ? "تخصيص أيام معينة" : "تفعيل طوال الأسبوع"}
              </Button>
            </div>

            <div className="grid grid-cols-4 sm:grid-cols-7 gap-2 pt-1">
              {DAYS_OF_WEEK.map((day) => {
                const isSelected = data.activeDays.includes(day.id);
                return (
                  <button
                    key={day.id}
                    type="button"
                    onClick={() => {
                      const current = [...data.activeDays];
                      if (isSelected) {
                        if (current.length > 1) {
                          updateField("activeDays", current.filter((id) => id !== day.id));
                        }
                      } else {
                        updateField("activeDays", [...current, day.id].sort((a, b) => a - b));
                      }
                    }}
                    className={`flex flex-col items-center justify-center p-2 rounded-md border text-xs font-bold transition-colors ${
                      isSelected
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    <span>{day.nameAr}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 5. تصميم وهوية البطاقة البصرية (للكوبونات فقط) */}
      {!isDirectPromo && (
        <Card className="border shadow-sm">
          <CardHeader className="pb-3 border-b">
            <CardTitle className="text-sm font-bold flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Palette className="size-4 text-primary" />
                <span>5. الهوية البصرية ونصوص البطاقة (54×84 مم)</span>
              </span>
              <span className="text-xs font-normal text-muted-foreground">تتحدث بالمعاينة فوراً</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="عنوان البطاقة البارز">
              <Input
                value={data.design.title}
                onChange={(e) => updateDesign("title", e.target.value)}
                placeholder="عرض ترويجي حصري"
                maxLength={80}
              />
            </Field>

            <Field label="لون الهوية المميز">
              <div className="flex items-center gap-2">
                <Input
                  type="color"
                  value={data.design.color}
                  onChange={(e) => updateDesign("color", e.target.value)}
                  className="w-12 h-9 p-1 cursor-pointer"
                />
                <Input
                  value={data.design.color}
                  onChange={(e) => updateDesign("color", e.target.value)}
                  dir="ltr"
                  className="font-mono text-xs"
                />
              </div>
            </Field>

            <Field label="العبارة التوضيحية الفرعية" className="md:col-span-2">
              <Input
                value={data.design.subtitle}
                onChange={(e) => updateDesign("subtitle", e.target.value)}
                placeholder="تسوق الآن واستفد من التوفير الفوري"
                maxLength={140}
              />
            </Field>

            <Field label="الشروط والأحكام المختصرة" className="md:col-span-2">
              <Input
                value={data.design.terms}
                onChange={(e) => updateDesign("terms", e.target.value)}
                placeholder="يُستخدم لمرة واحدة · لا يُجمع مع أسعار تعاقدية أخرى"
                maxLength={500}
              />
            </Field>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
