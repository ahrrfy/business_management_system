import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StudioProductPicker } from "@/components/product-studio/StudioProductPicker";
import { Megaphone, PlayCircle, PauseCircle, CheckCircle2, XCircle, ChevronRight, Sparkles } from "lucide-react";
import { STUDIO_CAMPAIGN_STATUS_AR, STUDIO_CAMPAIGN_STATUS_VARIANT, STUDIO_CAMPAIGN_EDITABLE, type StudioCampaignStatus } from "@shared/studioCampaignStatus";
import { defaultStudioScope, STUDIO_EMPTY_HINTS, STUDIO_REJECTION_PRESETS, type StudioReviewImage } from "@/lib/productStudio/mobileStudioUi";

function studioDatetimeLocal(value: Date | string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function StudioCampaignsPanel({
  offline,
  branchId,
  selectedCampaignId,
  prefilledProductIds,
  prefilledCategoryId,
  onPrefillConsumed,
}: {
  offline: boolean;
  branchId?: number;
  selectedCampaignId: number | null;
  prefilledProductIds?: number[];
  prefilledCategoryId?: number | null;
  onPrefillConsumed?: () => void;
}) {
  const [campaignName, setCampaignName] = useState("");
  const [campaignBranchId, setCampaignBranchId] = useState("");
  const [campaignStartAt, setCampaignStartAt] = useState("");
  const [campaignDueAt, setCampaignDueAt] = useState("");
  const [campaignScope, setCampaignScope] = useState<"ALL" | "CATEGORY" | "CATEGORIES" | "PRODUCTS">("ALL");
  const [campaignCategoryId, setCampaignCategoryId] = useState("");
  const [campaignCategoryIds, setCampaignCategoryIds] = useState<number[]>([]);
  const [campaignProductIds, setCampaignProductIds] = useState<number[]>([]);
  const [campaignRequiredImages, setCampaignRequiredImages] = useState("1");
  const [campaignImagesPolicy, setCampaignImagesPolicy] = useState<"ONLY_MISSING" | "ANY_REGARDLESS">("ONLY_MISSING");
  const [campaignAssigneeIds, setCampaignAssigneeIds] = useState<number[]>([]);

  const [editCampaignName, setEditCampaignName] = useState("");
  const [editCampaignRequired, setEditCampaignRequired] = useState("1");
  const [editCampaignStartsAt, setEditCampaignStartsAt] = useState("");
  const [editCampaignDueAt, setEditCampaignDueAt] = useState("");
  const [campaignEditOpen, setCampaignEditOpen] = useState(false);
  const [backlogCancelReason, setBacklogCancelReason] = useState("");

  useEffect(() => {
    if (prefilledProductIds && prefilledProductIds.length > 0) {
      setCampaignScope("PRODUCTS");
      setCampaignProductIds(prefilledProductIds);
      onPrefillConsumed?.();
    } else if (prefilledCategoryId) {
      setCampaignScope("CATEGORY");
      setCampaignCategoryId(String(prefilledCategoryId));
      onPrefillConsumed?.();
    }
  }, [prefilledProductIds, prefilledCategoryId, onPrefillConsumed]);

  const utils = trpc.useUtils();
  const assignees = trpc.productStudio.assignees.useQuery(undefined, { enabled: !offline });
  const categoryOptions = trpc.catalog.categories.useQuery(undefined, { enabled: !offline && (campaignScope === "CATEGORY" || campaignScope === "CATEGORIES") });
  const campaigns = trpc.productStudio.campaigns.useQuery(undefined, { enabled: !offline });

  const selectedCampaign = selectedCampaignId 
    ? campaigns.data?.find((c) => Number(c.id) === selectedCampaignId) 
    : null;

  const createCampaignBacklog = trpc.productStudio.createCampaignBacklog.useMutation({
    onSuccess: async (data) => {
      notify.ok(`تم توليد ${data.createdCount} مهمّة في طابور الحملة (${data.remaining} متبقّية)`);
      if (!offline) {
        await Promise.all([
          utils.productStudio.campaigns.invalidate(),
          utils.productStudio.tasks.invalidate(),
          utils.productStudio.dashboard.invalidate(),
        ]);
      }
    },
    onError: (error: any) => notify.err(error),
  });

  const createCampaign = trpc.productStudio.createCampaign.useMutation({
    onSuccess: async (data) => {
      notify.ok("تم إنشاء الحملة بنجاح");
      setCampaignName("");
      setCampaignProductIds([]);
      setCampaignCategoryIds([]);
      if (data.status === "ACTIVE") {
        try {
          const backlog = await createCampaignBacklog.mutateAsync({ campaignId: Number(data.campaignId) });
          if (backlog.createdCount > 0) {
            notify.ok(`تم توليد ${backlog.createdCount} مهمة في طابور الحملة`);
          }
        } catch (e: any) {
          notify.err(e);
        }
      }
      if (!offline) {
        await Promise.all([
          utils.productStudio.campaigns.invalidate(),
          utils.productStudio.tasks.invalidate(),
          utils.productStudio.dashboard.invalidate(),
        ]);
      }
    },
    onError: (error: any) => notify.err(error),
  });

  const transitionCampaign = trpc.productStudio.transitionCampaign.useMutation({
    onSuccess: async (data, variables) => {
      notify.ok(`تغيّرت حالة الحملة إلى ${STUDIO_CAMPAIGN_STATUS_AR[variables.status as StudioCampaignStatus] ?? variables.status}`);
      if (variables.status === "ACTIVE") {
        try {
          const backlog = await createCampaignBacklog.mutateAsync({ campaignId: Number(variables.campaignId) });
          if (backlog.createdCount > 0) {
            notify.ok(`تم توليد ${backlog.createdCount} مهمة جديدة في الطابور`);
          }
        } catch {}
      }
      if (!offline) {
        await Promise.all([
          utils.productStudio.campaigns.invalidate(),
          utils.productStudio.tasks.invalidate(),
          utils.productStudio.dashboard.invalidate(),
        ]);
      }
    },
    onError: (error: any) => notify.err(error),
  });

  const updateCampaignDetails = trpc.productStudio.updateCampaignDetails.useMutation({
    onSuccess: async () => {
      notify.ok("حُدِّثت بيانات الحملة وجُدوِل المهام المتبقية");
      setCampaignEditOpen(false);
      if (!offline) await utils.productStudio.campaigns.invalidate();
    },
    onError: (error: any) => notify.err(error),
  });

  const grantStudioAccess = trpc.productStudio.grantStudioAccess.useMutation({
    onSuccess: async () => {
      notify.ok("تم منح الصلاحية بنجاح");
      if (!offline) await utils.productStudio.assignees.invalidate();
    },
    onError: (error: any) => notify.err(error),
  });

  return (
    <Card id="new-campaign">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Megaphone aria-hidden className="size-4" /> حملات اكتمال الصور
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* CREATE CAMPAIGN WIZARD */}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <div className="space-y-1.5 xl:col-span-2">
            <Label htmlFor="studio-campaign-name">اسم حملة جديدة</Label>
            <Input id="studio-campaign-name" value={campaignName} onChange={(event) => setCampaignName(event.target.value)} placeholder="مثال: اكتمال صور القرطاسية" maxLength={180} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="studio-campaign-branch">الفرع</Label>
            <AppSelect id="studio-campaign-branch" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={campaignBranchId || String(branchId ?? "")} onValueChange={setCampaignBranchId}>
              <option value="">اختر الفرع</option>
              {Array.from(new Set((assignees.data ?? []).map((user) => user.branchId).filter((value): value is number => value != null))).map((bid) => (
                <option key={bid} value={bid}>
                  فرع {bid}
                </option>
              ))}
            </AppSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="studio-campaign-start">بداية الحملة</Label>
            <Input id="studio-campaign-start" type="datetime-local" value={campaignStartAt} onChange={(event) => setCampaignStartAt(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="studio-campaign-due">موعد الحملة</Label>
            <Input id="studio-campaign-due" type="datetime-local" value={campaignDueAt} onChange={(event) => setCampaignDueAt(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="studio-campaign-scope">نطاق الحملة</Label>
            <AppSelect id="studio-campaign-scope" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={campaignScope} onValueChange={(value) => setCampaignScope(value as typeof campaignScope)}>
              <option value="ALL">كل المنتجات</option>
              <option value="CATEGORY">فئة واحدة (بشجرتها)</option>
              <option value="CATEGORIES">عدّة فئات (بأشجارها)</option>
              <option value="PRODUCTS">منتجات مختارة</option>
            </AppSelect>
          </div>
          
          {campaignScope === "CATEGORY" && (
            <div className="space-y-1.5">
              <Label htmlFor="studio-campaign-category">الفئة</Label>
              <AppSelect id="studio-campaign-category" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={campaignCategoryId} onValueChange={setCampaignCategoryId} disabled={categoryOptions.isError}>
                <option value="">اختر الفئة</option>
                {(categoryOptions.data ?? []).map((category: any) => (
                  <option key={Number(category.id)} value={Number(category.id)}>
                    {category.parentId ? "— " : ""}
                    {category.name}
                  </option>
                ))}
              </AppSelect>
              {categoryOptions.isError && <p className="text-xs text-destructive">تعذّر جلب الفئات.</p>}
            </div>
          )}
          
          {campaignScope === "CATEGORIES" && (
            <div className="space-y-1.5 md:col-span-2">
              <Label>الفئات (عدّة — كلٌّ بشجرتها)</Label>
              <div className="flex flex-wrap gap-2 rounded-md border p-2">
                {(categoryOptions.data ?? []).length === 0 && <span className="text-xs text-muted-foreground">لا فئات متاحة.</span>}
                {(categoryOptions.data ?? []).map((category: any) => {
                  const id = Number(category.id);
                  const picked = campaignCategoryIds.includes(id);
                  return (
                    <Button
                      key={id} type="button" size="sm"
                      variant={picked ? "default" : "outline"}
                      className="min-h-11"
                      onClick={() => setCampaignCategoryIds((current) => picked ? current.filter((x) => x !== id) : [...current, id])}
                    >
                      {category.parentId ? "— " : ""}
                      {category.name}
                    </Button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {campaignCategoryIds.length > 0 ? `${campaignCategoryIds.length} فئةً مُختارة — كلٌّ تشمل أحفادها` : "اختر فئةً واحدةً على الأقلّ"}
              </p>
            </div>
          )}
          
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="studio-campaign-policy">سياسة الصور</Label>
            <AppSelect id="studio-campaign-policy" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={campaignImagesPolicy} onValueChange={(value) => setCampaignImagesPolicy(value as typeof campaignImagesPolicy)}>
              <option value="ONLY_MISSING">الناقصة فقط (استبعاد المكتمل تلقائياً)</option>
              <option value="ANY_REGARDLESS">كل المنتجات (حتى المكتمل — لإضافة صور جديدة)</option>
            </AppSelect>
            <p className="text-xs text-muted-foreground">
              {campaignImagesPolicy === "ANY_REGARDLESS"
                ? "المنتجات التي بلغَت `صور مطلوبة` ستدخل الطابور أيضاً — استعمله لإضافة صورةٍ ثالثة لمنتجٍ بصورتين مثلاً."
                : "المنتجات التي بلغَت `صور مطلوبة` مستبعَدةٌ من الطابور — السلوك القياسيّ."}
            </p>
          </div>
          
          {campaignScope === "PRODUCTS" && (
            <div className="space-y-1.5">
              <Label>المنتجات المختارة</Label>
              <div className="space-y-2">
                <StudioProductPicker canManage value={null} onPick={(product) => setCampaignProductIds((current) => (current.includes(Number(product.productId)) ? current : [...current, Number(product.productId)]))} />
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
                  <span>{campaignProductIds.length > 0 ? `${campaignProductIds.length} منتجاً في نطاق الحملة` : "ابحث وأضِف منتجات النطاق"}</span>
                  {campaignProductIds.length > 0 && (
                    <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => setCampaignProductIds([])}>
                      مسح
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
          
          <div className="space-y-1.5">
            <Label htmlFor="studio-campaign-required">صور مطلوبة لكل منتج</Label>
            <Input id="studio-campaign-required" type="number" min={1} max={10} value={campaignRequiredImages} onChange={(event) => setCampaignRequiredImages(event.target.value)} />
            <p className="text-xs text-muted-foreground">التوجيه الإداريّ — يراه المصوّر ويبقى المنتج ناقصاً حتى يبلغه.</p>
          </div>
          
          <div className="space-y-1.5 xl:col-span-2">
            <Label>مصوّرو الحملة</Label>
            <div className="flex flex-wrap gap-2 rounded-md border p-2">
              {(assignees.data ?? []).length === 0 && <span className="text-xs text-muted-foreground">لا موظفين متاحين.</span>}
              {(assignees.data ?? []).map((user) => {
                const picked = campaignAssigneeIds.includes(user.id);
                if (!user.canStudio) {
                  return (
                    <span key={user.id} className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground">
                      {user.name}
                      <Button type="button" size="sm" variant="ghost" className="min-h-11 px-2 text-xs" disabled={offline || grantStudioAccess.isPending} onClick={() => grantStudioAccess.mutate({ userId: user.id })}>
                        امنح الصلاحية
                      </Button>
                    </span>
                  );
                }
                return (
                  <Button
                    key={user.id} type="button" size="sm"
                    variant={picked ? "default" : "outline"}
                    className="min-h-11"
                    onClick={() => setCampaignAssigneeIds((current) => (picked ? current.filter((id) => id !== user.id) : [...current, user.id]))}
                  >
                    {user.name}
                  </Button>
                );
              })}
            </div>
          </div>
          
          <div className="flex items-end">
            <Button
              className="min-h-11 w-full"
              disabled={offline || campaignName.trim().length < 3 || createCampaign.isPending || !(campaignBranchId || branchId) || (campaignScope === "CATEGORY" && !campaignCategoryId) || (campaignScope === "CATEGORIES" && campaignCategoryIds.length === 0) || (campaignScope === "PRODUCTS" && campaignProductIds.length === 0)}
              onClick={() =>
                createCampaign.mutate({
                  name: campaignName.trim(),
                  status: "ACTIVE",
                  branchId: Number(campaignBranchId || branchId),
                  startsAt: campaignStartAt ? new Date(campaignStartAt) : null,
                  dueAt: campaignDueAt ? new Date(campaignDueAt) : null,
                  scopeKind: campaignScope,
                  scopeCategoryId: campaignScope === "CATEGORY" ? Number(campaignCategoryId) : null,
                  scopeCategoryIds: campaignScope === "CATEGORIES" ? campaignCategoryIds : undefined,
                  scopeProductIds: campaignScope === "PRODUCTS" ? campaignProductIds : undefined,
                  requiredImages: Math.max(1, Math.min(10, Number(campaignRequiredImages) || 1)),
                  imagesPolicy: campaignImagesPolicy,
                  assigneeIds: campaignAssigneeIds,
                })
              }
            >
              إنشاء وتفعيل
            </Button>
          </div>
        </div>

        {/* SELECTED CAMPAIGN CONTROLS */}
        {selectedCampaign && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
              <span className="text-sm font-medium">الحالة:</span>
              <Badge variant={STUDIO_CAMPAIGN_STATUS_VARIANT[selectedCampaign.status as StudioCampaignStatus] ?? "neutral"}>
                {STUDIO_CAMPAIGN_STATUS_AR[selectedCampaign.status as StudioCampaignStatus] ?? selectedCampaign.status}
              </Badge>
              {selectedCampaign.status === "DRAFT" && (
                <Button
                  className="min-h-11"
                  disabled={offline || transitionCampaign.isPending}
                  onClick={() => transitionCampaign.mutate({
                    campaignId: Number(selectedCampaign.id),
                    status: "ACTIVE",
                    startsAt: campaignStartAt ? new Date(campaignStartAt) : null,
                    dueAt: campaignDueAt ? new Date(campaignDueAt) : selectedCampaign.dueAt,
                  })}
                >
                  <PlayCircle aria-hidden className="size-4" /> تفعيل الحملة
                </Button>
              )}
              {selectedCampaign.status === "ACTIVE" && (
                <Button
                  variant="outline" className="min-h-11"
                  disabled={offline || transitionCampaign.isPending}
                  onClick={() => transitionCampaign.mutate({ campaignId: Number(selectedCampaign.id), status: "PAUSED" })}
                  title="تجميد ذكيّ: تختفي عن مسار المصوّر لكن المهام المُسنَدة تبقى قابلةً للإتمام"
                >
                  <PauseCircle aria-hidden className="size-4" /> إيقاف مؤقّت
                </Button>
              )}
              {selectedCampaign.status === "PAUSED" && (
                <Button
                  className="min-h-11"
                  disabled={offline || transitionCampaign.isPending}
                  onClick={() => transitionCampaign.mutate({ campaignId: Number(selectedCampaign.id), status: "ACTIVE" })}
                >
                  <PlayCircle aria-hidden className="size-4" /> استئناف الحملة
                </Button>
              )}
              {(selectedCampaign.status === "ACTIVE" || selectedCampaign.status === "PAUSED") && (
                <Button
                  variant="outline" className="min-h-11"
                  disabled={offline || transitionCampaign.isPending}
                  onClick={() => transitionCampaign.mutate({ campaignId: Number(selectedCampaign.id), status: "COMPLETED" })}
                >
                  <CheckCircle2 aria-hidden className="size-4" /> إكمال الحملة
                </Button>
              )}
              {selectedCampaign.status === "ACTIVE" && (
                <Button
                  variant="outline" className="min-h-11"
                  disabled={offline || createCampaignBacklog.isPending}
                  onClick={() => createCampaignBacklog.mutate({ campaignId: Number(selectedCampaign.id) })}
                  title="مسح نطاق الحملة وتوليد مهام المنتجات الناقصة التي لم تدخل الطابور بعد"
                >
                  <Sparkles aria-hidden className="size-4" />
                  {createCampaignBacklog.isPending ? "جارٍ التوليد…" : "توليد / تحديث طابور الحملة"}
                </Button>
              )}
              {(selectedCampaign.status === "DRAFT" || selectedCampaign.status === "ACTIVE" || selectedCampaign.status === "PAUSED") && (
                <Button
                  variant="outline" className="min-h-11"
                  disabled={offline || transitionCampaign.isPending || backlogCancelReason.trim().length < 5}
                  title={backlogCancelReason.trim().length < 5 ? "اكتب سبب الإلغاء في الحقل أدناه أولاً" : undefined}
                  onClick={() => transitionCampaign.mutate({ campaignId: Number(selectedCampaign.id), status: "CANCELLED", reason: backlogCancelReason })}
                >
                  <XCircle aria-hidden className="size-4" /> إلغاء الحملة ومهام طابورها
                </Button>
              )}
              {STUDIO_CAMPAIGN_EDITABLE.has(selectedCampaign.status as StudioCampaignStatus) && (
                <Button
                  variant="outline" className="min-h-11"
                  onClick={() => {
                    setEditCampaignName(selectedCampaign.name);
                    setEditCampaignRequired(String(selectedCampaign.requiredImages ?? 1));
                    setEditCampaignStartsAt(studioDatetimeLocal(selectedCampaign.startsAt));
                    setEditCampaignDueAt(studioDatetimeLocal(selectedCampaign.dueAt));
                    setCampaignEditOpen((open) => !open);
                  }}
                >
                  {campaignEditOpen ? "إخفاء التعديل" : "تعديل بيانات الحملة"}
                </Button>
              )}
            </div>
            
            {campaignEditOpen && STUDIO_CAMPAIGN_EDITABLE.has(selectedCampaign.status as StudioCampaignStatus) && (
              <div className="grid gap-3 rounded-md border bg-muted/20 p-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="studio-edit-campaign-name">اسم الحملة</Label>
                  <Input id="studio-edit-campaign-name" value={editCampaignName} onChange={(event) => setEditCampaignName(event.target.value)} maxLength={180} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="studio-edit-campaign-required">عدد الصور المطلوبة لكل منتج</Label>
                  <Input id="studio-edit-campaign-required" type="number" min={1} max={10} value={editCampaignRequired} onChange={(event) => setEditCampaignRequired(event.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="studio-edit-campaign-start">بدء الحملة</Label>
                  <Input id="studio-edit-campaign-start" type="datetime-local" value={editCampaignStartsAt} onChange={(event) => setEditCampaignStartsAt(event.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="studio-edit-campaign-due">موعد الإنجاز</Label>
                  <Input id="studio-edit-campaign-due" type="datetime-local" value={editCampaignDueAt} onChange={(event) => setEditCampaignDueAt(event.target.value)} />
                </div>
                <div className="flex items-end pt-2 md:col-span-2">
                  <Button
                    className="min-h-11"
                    disabled={offline || updateCampaignDetails.isPending || editCampaignName.trim().length < 3 || Number(editCampaignRequired) < 1}
                    onClick={() => {
                      updateCampaignDetails.mutate({
                        campaignId: Number(selectedCampaign.id),
                        name: editCampaignName.trim(),
                        requiredImages: Number(editCampaignRequired),
                        startsAt: editCampaignStartsAt ? new Date(editCampaignStartsAt) : null,
                        dueAt: editCampaignDueAt ? new Date(editCampaignDueAt) : null,
                      });
                    }}
                  >
                    حفظ التعديلات
                  </Button>
                </div>
              </div>
            )}
            
            {(selectedCampaign.status === "DRAFT" || selectedCampaign.status === "ACTIVE" || selectedCampaign.status === "PAUSED") && (
              <div className="space-y-1.5 rounded-md border border-destructive/20 bg-destructive/5 p-3">
                <Label htmlFor="studio-cancel-reason" className="text-destructive">سبب الإلغاء (مطلوب قبل الضغط على زر الإلغاء أعلاه)</Label>
                <Input id="studio-cancel-reason" value={backlogCancelReason} onChange={(event) => setBacklogCancelReason(event.target.value)} placeholder="مثال: تغيرت المنتجات المستهدفة، أو خطأ في الفئة..." />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
