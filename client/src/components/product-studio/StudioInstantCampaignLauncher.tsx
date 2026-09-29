import { useState, useMemo, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Check, CheckCircle2, ChevronRight, Loader2, Sparkles, Users, Zap } from "lucide-react";

type Health = "HIGH_VALUE_NO_IMAGE" | "CONSIGNMENT_NO_IMAGE" | "HAS_IMAGE_NO_BARCODE" | "CORRUPTED_OR_UNPROCESSED_IMAGE" | "REDUNDANT_VARIANT_IMAGE" | "NO_IMAGES" | "BUNDLE_NO_IMAGE" | "SINGLE_IMAGE" | "PARENT_ONLY_HAS_VARIANTS" | "VARIANTS_INCOMPLETE" | "HEALTHY";

interface StudioInstantCampaignLauncherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultScope?: "HIGH_VALUE" | "CURRENT_FILTER" | "SELECTED_ROWS";
  selectedRowIds?: number[];
  activeFilterStates: Health[];
  counts?: Record<Health, number>;
  onSuccess?: (campaignId: number) => void;
}

export function StudioInstantCampaignLauncher({
  open,
  onOpenChange,
  defaultScope = "HIGH_VALUE",
  selectedRowIds = [],
  activeFilterStates,
  counts,
  onSuccess,
}: StudioInstantCampaignLauncherProps) {
  const utils = trpc.useUtils();
  const assigneesQuery = trpc.productStudio.assignees.useQuery(undefined, { enabled: open });

  const [scopeType, setScopeType] = useState<"HIGH_VALUE" | "CURRENT_FILTER" | "SELECTED_ROWS">(defaultScope);
  const [campaignName, setCampaignName] = useState("");
  const [selectedAssigneeIds, setSelectedAssigneeIds] = useState<number[]>([]);
  const [requiredImages, setRequiredImages] = useState("1");
  const [isLaunching, setIsLaunching] = useState(false);
  const [launchStep, setLaunchStep] = useState<"IDLE" | "FETCHING_IDS" | "CREATING" | "DRAINING" | "COMPLETED">("IDLE");
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressText, setProgressText] = useState("");
  const [createdCampaignId, setCreatedCampaignId] = useState<number | null>(null);

  // تحديث الاسم الافتراضي عند فتح النافذة
  useEffect(() => {
    if (open) {
      const today = new Intl.DateTimeFormat("en-CA").format(new Date());
      if (scopeType === "HIGH_VALUE") {
        setCampaignName(`حملة تصوير الفجوة ذات الأولوية - ${today}`);
      } else if (scopeType === "SELECTED_ROWS") {
        setCampaignName(`حملة تصوير المنتجات المختارة (${selectedRowIds.length}) - ${today}`);
      } else {
        setCampaignName(`حملة تصوير فجوات الاستوديو - ${today}`);
      }
      setLaunchStep("IDLE");
      setProgressPercent(0);
      setProgressText("");
      setCreatedCampaignId(null);
    }
  }, [open, scopeType, selectedRowIds.length]);

  // تحديد كل المصورين تلقائياً إذا لم يتم تحديد أحد
  useEffect(() => {
    if (open && assigneesQuery.data && selectedAssigneeIds.length === 0) {
      const available = assigneesQuery.data.filter((u) => u.canStudio).map((u) => u.id);
      if (available.length > 0) {
        setSelectedAssigneeIds(available);
      }
    }
  }, [open, assigneesQuery.data, selectedAssigneeIds.length]);

  const targetCount = useMemo(() => {
    if (scopeType === "SELECTED_ROWS") return selectedRowIds.length;
    if (scopeType === "HIGH_VALUE") return counts?.HIGH_VALUE_NO_IMAGE ?? 0;
    if (activeFilterStates.length > 0 && counts) {
      return activeFilterStates.reduce((acc, st) => acc + (counts[st] ?? 0), 0);
    }
    return counts?.NO_IMAGES ?? 0;
  }, [scopeType, selectedRowIds.length, counts, activeFilterStates]);

  const perPhotographerEstimate = useMemo(() => {
    if (selectedAssigneeIds.length === 0 || targetCount === 0) return 0;
    return Math.ceil(targetCount / selectedAssigneeIds.length);
  }, [targetCount, selectedAssigneeIds.length]);

  const createCampaign = trpc.productStudio.createCampaign.useMutation();
  const drainBacklog = trpc.productStudio.drainCampaignBacklog.useMutation();

  const handleLaunch = async () => {
    if (!campaignName.trim() || selectedAssigneeIds.length === 0 || targetCount === 0) {
      notify.err("يرجى التأكد من اسم الحملة واختيار مصور واحد على الأقل.");
      return;
    }

    setIsLaunching(true);
    try {
      let productIdsToInclude: number[] = [];

      if (scopeType === "SELECTED_ROWS") {
        productIdsToInclude = selectedRowIds;
      } else {
        setLaunchStep("FETCHING_IDS");
        setProgressText("جارٍ حصر معرفات كافة المنتجات المطابقة...");
        setProgressPercent(10);

        const statesToFetch = scopeType === "HIGH_VALUE" ? (["HIGH_VALUE_NO_IMAGE"] as Health[]) : activeFilterStates;
        const fetchedIds = await utils.client.productStudio.gapProductIds.query({
          states: statesToFetch,
        });

        productIdsToInclude = fetchedIds;
      }

      if (productIdsToInclude.length === 0) {
        notify.err("لم يتم العثور على منتجات مطابقة لهذا النطاق.");
        setIsLaunching(false);
        setLaunchStep("IDLE");
        return;
      }

      // إنشاء الحملة
      setLaunchStep("CREATING");
      setProgressText(`جارٍ إنشاء الحملة لنطاق ${productIdsToInclude.length} منتج...`);
      setProgressPercent(25);

      const campaignResult = await createCampaign.mutateAsync({
        name: campaignName.trim(),
        status: "ACTIVE",
        scopeKind: "PRODUCTS",
        scopeProductIds: productIdsToInclude,
        requiredImages: Math.max(1, Math.min(10, Number(requiredImages) || 1)),
        assigneeIds: selectedAssigneeIds,
      });

      const campaignId = Number(campaignResult.campaignId);
      setCreatedCampaignId(campaignId);

      // استنزاف وتوليد كامل طابور الحملة وتوزيعه بالتساوي
      setLaunchStep("DRAINING");
      setProgressText("جارٍ توليد وتوزيع كامل طابور المهام بالتساوي على المصورين...");
      setProgressPercent(60);

      const drainResult = await drainBacklog.mutateAsync({
        campaignId,
        autoDistribute: true,
      });

      setProgressPercent(100);
      setLaunchStep("COMPLETED");
      setProgressText(`اكتمل التوليد بنجاح! تم إنشاء وتوزيع ${drainResult.totalCreated} مهمة بالتساوي.`);

      await Promise.all([
        utils.productStudio.campaigns.invalidate(),
        utils.productStudio.tasks.invalidate(),
        utils.productStudio.imageHealthCounts.invalidate(),
        utils.productStudio.discoverImageGaps.invalidate(),
        utils.productStudio.dashboard.invalidate(),
      ]);

      notify.ok(`تم إطلاق الحملة وتوزيع ${drainResult.totalCreated} مهمة بالتساوي بنجاح!`);
      onSuccess?.(campaignId);
    } catch (err: any) {
      notify.err(err);
      setLaunchStep("IDLE");
    } finally {
      setIsLaunching(false);
    }
  };

  const photographers = assigneesQuery.data ?? [];

  return (
    <Dialog open={open} onOpenChange={(val) => !isLaunching && onOpenChange(val)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Zap className="size-5 text-primary" />
            إطلاق حملة تصوير فورية لكامل الفجوة
          </DialogTitle>
          <DialogDescription>
            بروتوكول التدخل السريع: تحويل منتجات الفجوة إلى حملة نشطة وتوزيعها بالتساوي على المصورين بضغطة زر واحدة.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* اختيار النطاق */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">نطاق الاستهداف الفوري</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              <button
                type="button"
                disabled={isLaunching || (counts?.HIGH_VALUE_NO_IMAGE ?? 0) === 0}
                onClick={() => setScopeType("HIGH_VALUE")}
                className={`flex flex-col items-start justify-between rounded-md border p-3 text-start transition-colors ${
                  scopeType === "HIGH_VALUE"
                    ? "border-primary bg-primary/10 ring-2 ring-primary"
                    : "hover:bg-muted/50 border-border"
                } ${isLaunching ? "opacity-60 cursor-not-allowed" : ""}`}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="text-xs font-bold">فجوة الأولوية الكاملة</span>
                  <Badge variant="danger" className="text-[10px]">
                    {counts?.HIGH_VALUE_NO_IMAGE ?? 0}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  كافة المنتجات المطلوبة التي تفتقر للصور
                </p>
              </button>

              <button
                type="button"
                disabled={isLaunching || activeFilterStates.length === 0}
                onClick={() => setScopeType("CURRENT_FILTER")}
                className={`flex flex-col items-start justify-between rounded-md border p-3 text-start transition-colors ${
                  scopeType === "CURRENT_FILTER"
                    ? "border-primary bg-primary/10 ring-2 ring-primary"
                    : "hover:bg-muted/50 border-border"
                } ${isLaunching ? "opacity-60 cursor-not-allowed" : ""}`}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="text-xs font-bold">الفلاتر المحددة حالياً</span>
                  <Badge variant="outline" className="text-[10px]">
                    {targetCount}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  بحسب حالات الفلتر المختارة في اللوحة
                </p>
              </button>

              <button
                type="button"
                disabled={isLaunching || selectedRowIds.length === 0}
                onClick={() => setScopeType("SELECTED_ROWS")}
                className={`flex flex-col items-start justify-between rounded-md border p-3 text-start transition-colors ${
                  scopeType === "SELECTED_ROWS"
                    ? "border-primary bg-primary/10 ring-2 ring-primary"
                    : "hover:bg-muted/50 border-border"
                } ${isLaunching || selectedRowIds.length === 0 ? "opacity-60 cursor-not-allowed" : ""}`}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="text-xs font-bold">المحددة في الجدول</span>
                  <Badge variant="secondary" className="text-[10px]">
                    {selectedRowIds.length}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  الصفوف التي تم تحديدها يدوياً
                </p>
              </button>
            </div>
          </div>

          {/* اسم الحملة وعدد الصور */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="instant-campaign-name">اسم الحملة</Label>
              <Input
                id="instant-campaign-name"
                disabled={isLaunching}
                value={campaignName}
                onChange={(e) => setCampaignName(e.target.value)}
                placeholder="اسم الحملة"
                maxLength={180}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="instant-campaign-required">الصور المطلوبة</Label>
              <Input
                id="instant-campaign-required"
                type="number"
                min={1}
                max={10}
                disabled={isLaunching}
                value={requiredImages}
                onChange={(e) => setRequiredImages(e.target.value)}
              />
            </div>
          </div>

          {/* اختيار المصورين والتوزيع العادل */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1.5 text-sm font-semibold">
                <Users className="size-4 text-muted-foreground" />
                توزيع المهام على المصورين بالتساوي
              </Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={isLaunching}
                onClick={() => {
                  const allIds = photographers.filter((p) => p.canStudio).map((p) => p.id);
                  if (selectedAssigneeIds.length === allIds.length) {
                    setSelectedAssigneeIds([]);
                  } else {
                    setSelectedAssigneeIds(allIds);
                  }
                }}
              >
                {selectedAssigneeIds.length === photographers.filter((p) => p.canStudio).length
                  ? "إلغاء تحديد الكل"
                  : "تحديد كافة المصورين"}
              </Button>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {photographers.map((user) => {
                const isSelected = selectedAssigneeIds.includes(user.id);
                return (
                  <button
                    key={user.id}
                    type="button"
                    disabled={isLaunching || !user.canStudio}
                    onClick={() => {
                      if (!user.canStudio) return;
                      setSelectedAssigneeIds((curr) =>
                        isSelected ? curr.filter((id) => id !== user.id) : [...curr, user.id]
                      );
                    }}
                    className={`flex items-center justify-between rounded-md border p-2.5 text-start transition-colors ${
                      isSelected
                        ? "border-primary bg-primary/10 text-primary font-medium"
                        : "hover:bg-muted/40 border-border"
                    } ${!user.canStudio ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className={`flex size-4 items-center justify-center rounded border ${
                          isSelected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
                        }`}
                      >
                        {isSelected && <Check className="size-3" />}
                      </div>
                      <span className="text-sm">{user.name}</span>
                    </div>
                    {isSelected && perPhotographerEstimate > 0 && (
                      <Badge variant="outline" className="text-[11px]">
                        ~{perPhotographerEstimate} مهمة
                      </Badge>
                    )}
                  </button>
                );
              })}
            </div>

            {selectedAssigneeIds.length > 0 && targetCount > 0 && (
              <div className="rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">
                سيتم إسناد <strong>{targetCount}</strong> منتجاً بالتساوي على{" "}
                <strong>{selectedAssigneeIds.length}</strong> مصورين (~
                <strong>{perPhotographerEstimate}</strong> منتج لكل مصور).
              </div>
            )}
          </div>

          {/* شريط التقدم أثناء الإطلاق */}
          {launchStep !== "IDLE" && (
            <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-primary">{progressText}</span>
                <span className="font-bold">{progressPercent}%</span>
              </div>
              <Progress value={progressPercent} className="h-2" />
            </div>
          )}

          {launchStep === "COMPLETED" && (
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-300">
              <CheckCircle2 className="size-5 shrink-0 text-emerald-600" />
              <span>
                اكتمل الإطلاق بنجاح! تم توزيع كافة المهام بالتساوي، وبإمكان المصورين البدء فوراً.
              </span>
            </div>
          )}
        </div>

        <DialogFooter className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            disabled={isLaunching}
            onClick={() => onOpenChange(false)}
          >
            {launchStep === "COMPLETED" ? "إغلاق" : "إلغاء"}
          </Button>

          {launchStep !== "COMPLETED" ? (
            <Button
              type="button"
              className="gap-2"
              disabled={
                isLaunching ||
                targetCount === 0 ||
                selectedAssigneeIds.length === 0 ||
                campaignName.trim().length < 3
              }
              onClick={handleLaunch}
            >
              {isLaunching ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  جارٍ الإطلاق والتوليد...
                </>
              ) : (
                <>
                  <Zap className="size-4" />
                  إطلاق الحملة وتوليد {targetCount} مهمة فوراً
                </>
              )}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => {
                onOpenChange(false);
                if (createdCampaignId) {
                  onSuccess?.(createdCampaignId);
                }
              }}
            >
              عرض الحملة في لوحة الإدارة
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
