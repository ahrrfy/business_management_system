import { Calendar, DollarSign, Info, Palette, ShieldAlert, Tag, Truck, Users } from "lucide-react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/product/variantBits";
import { MoneyInput } from "@/components/form/MoneyInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { trpc } from "@/lib/trpc";
import type { PromotionDiscountType, PromotionFormData, PromotionScope } from "./promotionBuilderTypes";

interface PromotionBuilderFormProps {
  data: PromotionFormData;
  onChange: (updater: (prev: PromotionFormData) => PromotionFormData) => void;
  errors?: Record<string, string>;
}

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

  return (
    <div className="space-y-6">
      {/* 1. بيانات الحملة والبرنامج */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Tag className="size-4 text-primary" />
            <span>1. بيانات الحملة وبرنامج الكوبونات</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="اسم العرض والبرنامج" required hint={errors.name} className="md:col-span-2">
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

          <Field label="بادئة الكود (Prefix)" required hint={errors.codePrefix}>
            <Input
              value={data.codePrefix}
              onChange={(e) =>
                updateField("codePrefix", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12))
              }
              placeholder="VIP"
              dir="ltr"
              maxLength={12}
            />
          </Field>

          <Field label="كود تجريبي للمعاينة الحية">
            <Input
              value={data.sampleCode}
              onChange={(e) => updateField("sampleCode", e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))}
              placeholder="VIP-2026"
              dir="ltr"
            />
          </Field>

          <Field label="وصف الحملة (اختياري)" className="md:col-span-2">
            <Textarea
              value={data.description}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="تفاصيل داخلية لفريق المبيعات والتسويق..."
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
              <option value="PERCENT">نسبة مئوية (%) مع سقف مالي أقصى</option>
              <option value="AMOUNT">مبلغ مقطوع بالدينار العراقي (IQD)</option>
            </AppSelect>
          </Field>

          {data.type === "PERCENT" ? (
            <>
              <Field
                label="نسبة الخصم (%)"
                required
                hint={errors.discountPercent || "بين 0.01٪ و 100٪"}
              >
                <Input
                  type="number"
                  min="0.01"
                  max="100"
                  step="0.01"
                  value={data.discountPercent}
                  onChange={(e) => updateField("discountPercent", e.target.value)}
                  placeholder="15"
                />
              </Field>

              <Field
                label="سقف الخصم الأقصى (دينار عراقي)"
                required
                hint={errors.maxDiscountAmount || "إلزامي لعروض النسبة لمنع الخسائر غير المتوقعة في السلات الكبيرة"}
                className="md:col-span-2"
              >
                <MoneyInput
                  value={data.maxDiscountAmount}
                  onChange={(val) => updateField("maxDiscountAmount", val)}
                  placeholder="25,000"
                />
              </Field>
            </>
          ) : (
            <Field
              label="مبلغ الخصم بالدينار العراقي"
              required
              hint={errors.discountAmount || "مبلغ ثابت يُخصم من الفاتورة المؤهلة"}
            >
              <MoneyInput
                value={data.discountAmount}
                onChange={(val) => updateField("discountAmount", val)}
                placeholder="10,000"
              />
            </Field>
          )}

          <Field
            label="الحد الأدنى لقيمة الفاتورة (Min Order Spend)"
            hint={errors.minOrderSpend || "لا يمكن تفعيل الكوبون إذا كانت السلة أقل من هذا المبلغ"}
            className="md:col-span-2"
          >
            <MoneyInput
              value={data.minOrderSpend}
              onChange={(val) => updateField("minOrderSpend", val)}
              placeholder="50,000"
            />
          </Field>

          {/* ميزة التوصيل المجاني أو المخفض */}
          <div className="md:col-span-2 rounded-lg border bg-muted/20 p-3 space-y-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="free-shipping-check"
                checked={data.freeShipping}
                onCheckedChange={(checked) => updateField("freeShipping", checked === true)}
              />
              <label htmlFor="free-shipping-check" className="text-xs font-semibold cursor-pointer flex items-center gap-1.5">
                <Truck className="size-3.5 text-primary" />
                <span>تضمين توصيل مجاني للطلبات الإلكترونية مع هذا الكوبون</span>
              </label>
            </div>

            {data.freeShipping && (
              <Field label="مبلغ خصم الشحن الإضافي (إن وجد)" hint="اتركه صفراً لتوصيل مجاني بالكامل">
                <MoneyInput
                  value={data.shippingDiscountAmount}
                  onChange={(val) => updateField("shippingDiscountAmount", val)}
                  placeholder="0"
                />
              </Field>
            )}
          </div>

          {/* تذكير سياسة منع الجمع */}
          <div className="md:col-span-2 flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 p-2.5 text-xs text-amber-900 dark:text-amber-200">
            <Info className="size-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
            <div>
              <span className="font-bold">سياسة منع الجمع (Stacking Rules): </span>
              <span>يُمنع جمع الكوبون مع الأسعار التعاقدية أو العروض الترويجية المتزامنة تلقائياً.</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 3. النطاق والصلاحية وحدود الاستخدام */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Calendar className="size-4 text-primary" />
            <span>3. النطاق والحدود الزمنية والاستخدام</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="نطاق التطبيق">
            <AppSelect
              value={data.scope}
              onValueChange={(val) => updateField("scope", val as PromotionScope)}
              className="h-9 px-3"
            >
              <option value="ALL">كل المنتجات دون استثناء</option>
              <option value="CATEGORIES">فئات وأقسام محددة</option>
              <option value="PRODUCTS">منتجات محددة فقط</option>
            </AppSelect>
          </Field>

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

          <Field label="أقصى مرات استخدام للكوبون الواحد">
            <Input
              type="number"
              min={1}
              max={1000}
              value={data.perCouponLimit}
              disabled={data.isFirstOrderSelfService}
              onChange={(e) => updateField("perCouponLimit", Math.max(1, Number(e.target.value)))}
            />
          </Field>

          <Field label="أقصى استخدام لكل عميل">
            <Input
              type="number"
              min={1}
              max={1000}
              value={data.perCustomerLimit}
              disabled={data.isFirstOrderSelfService}
              onChange={(e) => updateField("perCustomerLimit", Math.max(1, Number(e.target.value)))}
            />
          </Field>

          <div className="md:col-span-2 flex items-start gap-2 rounded-lg border bg-muted/20 p-3">
            <Checkbox
              id="first-order-self"
              checked={data.isFirstOrderSelfService}
              onCheckedChange={(checked) => {
                const enabled = checked === true;
                onChange((prev) => ({
                  ...prev,
                  isFirstOrderSelfService: enabled,
                  perCouponLimit: enabled ? 1 : prev.perCouponLimit,
                  perCustomerLimit: enabled ? 1 : prev.perCustomerLimit,
                }));
              }}
            />
            <label htmlFor="first-order-self" className="text-xs cursor-pointer space-y-0.5">
              <span className="font-semibold block">كوبون الطلب الأول (إصدار ذاتي للعميل)</span>
              <span className="text-muted-foreground block">
                يطلبه العميل الموثق ذاتياً من تطبيق المتجر قبل أول طلب. يفرض استخداماً واحداً حصراً.
              </span>
            </label>
          </div>
        </CardContent>
      </Card>

      {/* 4. تتبع المؤثرين والمسوقين (R3 Affiliates) */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-sm font-bold flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Users className="size-4 text-primary" />
              <span>4. تتبع المؤثرين والمسوقين بالعمولة (R3 Affiliates)</span>
            </span>
            <span className="text-xs font-normal text-muted-foreground">اختياري</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="اسم المسوق / صانع المحتوى">
            <Input
              value={data.affiliateName}
              onChange={(e) => updateField("affiliateName", e.target.value)}
              placeholder="مثال: أحمد للتسويق الرقمي"
            />
          </Field>

          <Field
            label="نسبة عمولة المسوق (%)"
            hint={errors.affiliateCommissionRate || "من 0 إلى 100"}
          >
            <Input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={data.affiliateCommissionRate}
              onChange={(e) => updateField("affiliateCommissionRate", e.target.value)}
              placeholder="5.00"
            />
          </Field>

          <Field label="هاتف المسوق" className="md:col-span-2">
            <IntlPhoneInput
              value={data.affiliatePhone}
              onChange={(val) => updateField("affiliatePhone", val)}
              ariaLabel="هاتف المسوق"
              className="h-9"
            />
          </Field>
        </CardContent>
      </Card>

      {/* 5. تصميم البطاقة الفاخرة والهوية البصرية */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Palette className="size-4 text-primary" />
            <span>5. الهوية البصرية وتصميم البطاقة المطبوعة (54×84 مم)</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="عنوان البطاقة المطبوعة">
            <Input
              value={data.design.title}
              maxLength={80}
              onChange={(e) => updateDesign("title", e.target.value)}
              placeholder="هدية خاصة لك"
            />
          </Field>

          <Field label="لون الهوية المميز للبطاقة">
            <div className="flex items-center gap-2">
              <Input
                type="color"
                className="w-12 h-9 p-1 cursor-pointer"
                value={data.design.color}
                onChange={(e) => updateDesign("color", e.target.value)}
              />
              <Input
                dir="ltr"
                value={data.design.color}
                onChange={(e) => updateDesign("color", e.target.value)}
                placeholder="#0D6B52"
                className="font-mono text-xs"
              />
            </div>
          </Field>

          <Field label="عبارة فرعية توضيحية" className="md:col-span-2">
            <Input
              value={data.design.subtitle}
              maxLength={140}
              onChange={(e) => updateDesign("subtitle", e.target.value)}
              placeholder="خصم مميز لعملائنا الكرام"
            />
          </Field>

          <Field label="شروط استخدام مختصرة بالبطاقة" className="md:col-span-2">
            <Input
              value={data.design.terms}
              maxLength={500}
              onChange={(e) => updateDesign("terms", e.target.value)}
              placeholder="صالح لمرة واحدة ولا يُجمع مع أسعار تعاقدية أو عروض أخرى"
            />
          </Field>
        </CardContent>
      </Card>
    </div>
  );
}
