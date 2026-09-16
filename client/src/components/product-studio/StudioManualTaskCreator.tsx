import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StudioProductPicker } from "@/components/product-studio/StudioProductPicker";
import { UserCheck } from "lucide-react";

export function StudioManualTaskCreator({
  offline,
  storageActionsDisabled,
}: {
  offline: boolean;
  storageActionsDisabled: boolean;
}) {
  const [productId, setProductId] = useState("");
  const [bulkProductIds, setBulkProductIds] = useState<number[]>([]);
  const [sourceChoice, setSourceChoice] = useState("new");
  const [assigneeId, setAssigneeId] = useState("");
  const [assignmentPriority, setAssignmentPriority] = useState<"LOW" | "NORMAL" | "HIGH" | "URGENT">("NORMAL");
  const [assignmentDueAt, setAssignmentDueAt] = useState("");

  const utils = trpc.useUtils();
  const assignees = trpc.productStudio.assignees.useQuery(undefined, { enabled: !offline });
  const productImages = trpc.productStudio.productImages.useQuery({ productId: Number(productId) }, { enabled: !offline && Boolean(productId) && bulkProductIds.length <= 1 });

  const assign = trpc.productStudio.assign.useMutation({
    onSuccess: async () => {
      notify.ok("أُسندت المهمة");
      setProductId("");
      setBulkProductIds([]);
      if (!offline) await utils.productStudio.invalidate();
    },
    onError: (error: any) => notify.err(error),
  });

  const bulkAssign = trpc.productStudio.bulkAssign.useMutation({
    onSuccess: async () => {
      notify.ok("أُسندت المهام دفعة واحدة");
      setProductId("");
      setBulkProductIds([]);
      if (!offline) await utils.productStudio.invalidate();
    },
    onError: (error: any) => notify.err(error),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">إسناد مهمة جديدة</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <div className="space-y-1.5">
          <Label htmlFor="studio-product-search">ابحث عن المنتج</Label>
          <StudioProductPicker
            canManage={true}
            value={Number(productId) || null}
            onPick={(product) => {
              setProductId(String(product.productId));
              setBulkProductIds((current) => (current.includes(product.productId) ? current : [...current, product.productId]));
              setSourceChoice("new");
            }}
          />
          {bulkProductIds.length > 0 && (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{bulkProductIds.length} منتج محدد</span>
              <Button
                type="button" variant="ghost" size="sm" className="min-h-11"
                onClick={() => {
                  setBulkProductIds([]);
                  setProductId("");
                }}
              >
                مسح التحديد
              </Button>
            </div>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="studio-source-image">نوع المهمة</Label>
          <AppSelect id="studio-source-image" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={sourceChoice} onValueChange={setSourceChoice} disabled={!productId || bulkProductIds.length > 1}>
            <option value="new">إضافة صورة جديدة</option>
            {(productImages.data ?? []).map((image, index) => (
              <option key={Number(image.id)} value={String(image.id)}>
                {image.isPrimary ? "استبدال الصورة الرئيسية" : `استبدال الصورة ${index + 1}`}
              </option>
            ))}
          </AppSelect>
          <p className="text-xs text-muted-foreground">الاستبدال يلتقط النسخة المنشورة خادمياً قبل بدء العمل.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="studio-assignee">الموظف المصرح</Label>
          <AppSelect id="studio-assignee" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={assigneeId} onValueChange={setAssigneeId} disabled={assignees.isError}>
            <option value="">اختر الموظف</option>
            {(assignees.data ?? []).map((user: any) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </AppSelect>
          <p className="text-xs text-muted-foreground">لكل منتج مهمة نشطة واحدة ومالك واحد؛ وزّع منتجات مختلفة على أكثر من موظف.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="studio-priority">الأولوية</Label>
          <AppSelect id="studio-priority" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={assignmentPriority} onValueChange={(value) => setAssignmentPriority(value as typeof assignmentPriority)}>
            <option value="LOW">منخفضة</option>
            <option value="NORMAL">عادية</option>
            <option value="HIGH">عالية</option>
            <option value="URGENT">عاجلة</option>
          </AppSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="studio-due-at">موعد الإنجاز</Label>
          <Input id="studio-due-at" type="datetime-local" value={assignmentDueAt} onChange={(event) => setAssignmentDueAt(event.target.value)} />
        </div>
        <div className="flex items-end">
          <Button
            className="w-full"
            disabled={offline || storageActionsDisabled || !productId || !assigneeId || assign.isPending || bulkAssign.isPending}
            onClick={() => {
              const dueAt = assignmentDueAt ? new Date(assignmentDueAt) : null;
              if (bulkProductIds.length > 1) {
                bulkAssign.mutate({
                  productIds: bulkProductIds,
                  assigneeId: Number(assigneeId),
                  priority: assignmentPriority,
                  dueAt,
                });
                return;
              }
              assign.mutate({
                productId: Number(productId),
                assigneeId: Number(assigneeId),
                sourceImageId: sourceChoice === "new" ? null : Number(sourceChoice),
                priority: assignmentPriority,
                dueAt,
              });
            }}
          >
            <UserCheck aria-hidden className="size-4" /> {assign.isPending || bulkAssign.isPending ? "جارٍ الإسناد" : bulkProductIds.length > 1 ? `إسناد ${bulkProductIds.length} مهام` : "إسناد المهمة"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
