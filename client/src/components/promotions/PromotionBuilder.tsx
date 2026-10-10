import { useState } from "react";
import { ArrowRight, Loader2, Save, Sparkles, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSaveShortcuts } from "@/hooks/useSaveShortcuts";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { PromotionBuilderForm } from "./PromotionBuilderForm";
import { LivePreviewPanel } from "./LivePreviewPanel";
import {
  INITIAL_PROMOTION_FORM_DATA,
  validatePromotionFormData,
  type PromotionFormData,
} from "./promotionBuilderTypes";

interface PromotionBuilderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function PromotionBuilder({ open, onOpenChange, onSuccess }: PromotionBuilderProps) {
  const utils = trpc.useUtils();
  const [formData, setFormData] = useState<PromotionFormData>(INITIAL_PROMOTION_FORM_DATA);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const createUnified = trpc.crm.coupons.createUnified.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.crm.coupons.programs.invalidate(),
        utils.salesPromotions.list.invalidate(),
        utils.crm.dashboard.invalidate(),
      ]);
      notify.ok("تم إنشاء العرض الترويجي وبرنامج الكوبونات بنجاح");
      onSuccess?.();
      onOpenChange(false);
      setFormData(INITIAL_PROMOTION_FORM_DATA);
      setErrors({});
    },
    onError: (err) => {
      notify.err(err.message || "فشل إنشاء العرض الترويجي");
    },
  });

  async function handleSave() {
    const validation = validatePromotionFormData(formData);
    if (!validation.valid) {
      setErrors(validation.errors);
      const firstError = Object.values(validation.errors)[0];
      notify.err(firstError || "يرجى مراجعة الحقول المطلوبة");
      return;
    }

    setErrors({});

    createUnified.mutate({
      name: formData.name.trim(),
      description: formData.description.trim() || undefined,
      codePrefix: formData.codePrefix.trim(),
      type: formData.type,
      discountPercent: formData.type === "PERCENT" ? formData.discountPercent : undefined,
      discountAmount: formData.type === "AMOUNT" ? formData.discountAmount : undefined,
      maxDiscountAmount: formData.type === "PERCENT" ? formData.maxDiscountAmount : undefined,
      minOrderSpend: formData.minOrderSpend || "0",
      freeShipping: formData.freeShipping,
      shippingDiscountAmount: formData.shippingDiscountAmount || "0",
      scope: formData.scope,
      targetCategoryIds: formData.targetCategoryIds.length > 0 ? formData.targetCategoryIds : undefined,
      targetProductIds: formData.targetProductIds.length > 0 ? formData.targetProductIds : undefined,
      validFrom: formData.validFrom,
      validTo: formData.validTo || null,
      perCouponLimit: formData.perCouponLimit,
      perCustomerLimit: formData.perCustomerLimit,
      isFirstOrderSelfService: formData.isFirstOrderSelfService,
      affiliateName: formData.affiliateName.trim() || undefined,
      affiliatePhone: formData.affiliatePhone.trim() || undefined,
      affiliateCommissionRate: formData.affiliateCommissionRate || "0.00",
      design: {
        title: formData.design.title.trim() || undefined,
        subtitle: formData.design.subtitle.trim() || undefined,
        terms: formData.design.terms.trim() || undefined,
        color: formData.design.color,
      },
      campaignId: formData.campaignId,
    });
  }

  // دعم اختصار لوحة المفاتيح Ctrl+S / Cmd+S للحفظ المباشر و Esc للإلغاء
  useSaveShortcuts({
    onSave: () => void handleSave(),
    onCancel: () => onOpenChange(false),
    enabled: open && !createUnified.isPending,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-6xl w-[95vw] max-h-[92vh] flex flex-col p-0 overflow-hidden">
        {/* شريط العنوان العلوي */}
        <DialogHeader className="p-4 sm:p-6 border-b shrink-0 bg-card">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <DialogTitle className="text-lg font-bold flex items-center gap-2">
                <Sparkles className="size-5 text-primary" />
                <span>المحرر المرئي الموحد للعروض والكوبونات (Unified Visual Builder)</span>
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                إنشاء العرض الترويجي المالي وبرنامج الكوبونات ذرياً في خطوة واحدة، مع المعاينة الحية وصمامات الأمان المالية.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* جسم المحرر: النموذج يميناً والمعاينة الحية يساراً */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
            {/* نموذج الإدخال */}
            <div className="xl:col-span-7">
              <PromotionBuilderForm
                data={formData}
                onChange={setFormData}
                errors={errors}
              />
            </div>

            {/* لوحة المعاينة التفاعلية الحية */}
            <div className="xl:col-span-5 xl:sticky xl:top-0">
              <LivePreviewPanel data={formData} />
            </div>
          </div>
        </div>

        {/* شريط الإجراءات السفلي */}
        <DialogFooter className="p-4 border-t bg-card shrink-0 flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground hidden sm:block">
            <span>اضغط </span>
            <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-muted border rounded">Ctrl+S</kbd>
            <span> للحفظ السريع</span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createUnified.isPending}
            >
              <X className="size-4" />
              <span>إلغاء</span>
            </Button>

            <Button
              type="button"
              onClick={() => void handleSave()}
              disabled={createUnified.isPending}
              className="gap-2 min-w-32"
            >
              {createUnified.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  <span>جارٍ الحفظ الذري…</span>
                </>
              ) : (
                <>
                  <Save className="size-4" />
                  <span>حفظ وإنشاء العرض</span>
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
