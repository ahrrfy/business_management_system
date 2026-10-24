import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, Loader2, Zap } from "lucide-react";
import { useInstantCampaign } from "./discovery/useInstantCampaign";
import type {
  InstantCampaignProps,
  InstantCampaignScope,
} from "./discovery/instantCampaign";

export function StudioInstantCampaignLauncher(props: InstantCampaignProps) {
  const model = useInstantCampaign(props);
  const scopes: { value: InstantCampaignScope; title: string; hint: string }[] =
    [
      {
        value: "HIGH_VALUE",
        title: "منتجات الأولوية بلا صور",
        hint: "جميع المنتجات المصنفة ضمن فجوة الأولوية",
      },
      {
        value: "NO_IMAGES",
        title: "جميع المنتجات بلا صور",
        hint: "جميع المنتجات المصنفة بلا أي صور",
      },
      {
        value: "CURRENT_FILTER",
        title: "التصفية الحالية",
        hint: "الحالات والبحث والبكج والترتيب الظاهرة في اللوحة",
      },
      {
        value: "SELECTED_ROWS",
        title: "الصفوف المحددة",
        hint: `${props.selectedRowIds?.length ?? 0} منتج محدد يدوياً`,
      },
    ];
  return (
    <Dialog open={props.open} onOpenChange={model.onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap aria-hidden className="size-5" /> إطلاق حملة تصوير
          </DialogTitle>
          <DialogDescription>
            راجع نطاق المنتجات والمصورين قبل إنشاء الحملة وتجهيز المهام.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <fieldset disabled={model.locked} className="min-w-0 space-y-2">
            <legend className="mb-2 text-sm font-semibold">نطاق الحملة</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {scopes.map((scope) => (
                <button
                  key={scope.value}
                  type="button"
                  aria-pressed={model.scope === scope.value}
                  disabled={
                    model.locked ||
                    (scope.value === "SELECTED_ROWS" &&
                      !props.selectedRowIds?.length)
                  }
                  onClick={() => model.setScope(scope.value)}
                  className={`min-w-0 rounded-md border p-3 text-start ${model.scope === scope.value ? "border-primary bg-primary/5" : "border-border"}`}
                >
                  <span className="block text-sm font-semibold">
                    {scope.title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {scope.hint}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
          {!model.previewReady &&
            !model.preview.isError &&
            model.campaignId === null && (
              <p role="status" className="text-sm">
                جارٍ معاينة النطاق…
              </p>
            )}
          {model.preview.isError &&
            model.scope !== "SELECTED_ROWS" &&
            model.campaignId === null && (
              <div role="alert" className="text-sm text-destructive">
                تعذرت معاينة النطاق.{" "}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => model.preview.refetch()}
                >
                  إعادة المحاولة
                </Button>
              </div>
            )}
          <p role="status" className="text-sm">
            عدد المنتجات المطابقة:{" "}
            <strong>
              {model.previewReady || model.campaignId !== null
                ? model.targetCount
                : "…"}
            </strong>
          </p>
          {model.targetCount > 5000 && (
            <p role="alert" className="text-sm text-destructive">
              النطاق يتجاوز حد الحملة (5000 منتج). ضيّق التصفية قبل الإطلاق.
            </p>
          )}
          <fieldset disabled={model.locked} className="min-w-0 space-y-4">
            <legend className="sr-only">بيانات الحملة والمصورون</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="instant-campaign-name">اسم الحملة</Label>
                <Input
                  id="instant-campaign-name"
                  value={model.name}
                  onChange={(event) => model.setName(event.target.value)}
                  maxLength={180}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="instant-campaign-required">
                  الصور المطلوبة لكل منتج
                </Label>
                <Input
                  id="instant-campaign-required"
                  type="number"
                  min={1}
                  max={10}
                  step={1}
                  value={model.requiredImages}
                  onChange={(event) =>
                    model.setRequiredImages(event.target.value)
                  }
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold">المصورون</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={model.locked}
                onClick={() =>
                  model.setAssigneeIds(
                    model.assigneeIds.length === model.photographers.length
                      ? []
                      : model.photographers.map((user) => user.id),
                  )
                }
              >
                {model.assigneeIds.length === model.photographers.length
                  ? "إلغاء تحديد الكل"
                  : "تحديد الكل"}
              </Button>
            </div>
            {model.assignees.isError && (
              <p role="alert" className="text-sm text-destructive">
                تعذر تحميل المصورين.{" "}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => model.assignees.refetch()}
                >
                  إعادة المحاولة
                </Button>
              </p>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              {model.photographers.map((user) => (
                <button
                  type="button"
                  key={user.id}
                  disabled={model.locked}
                  aria-pressed={model.assigneeIds.includes(user.id)}
                  onClick={() =>
                    model.setAssigneeIds((current) =>
                      current.includes(user.id)
                        ? current.filter((id) => id !== user.id)
                        : [...current, user.id],
                    )
                  }
                  className="flex min-w-0 items-center gap-2 rounded-md border p-2 text-start text-sm"
                >
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-sm border">
                    {model.assigneeIds.includes(user.id) && (
                      <Check aria-hidden className="size-3" />
                    )}
                  </span>
                  <span className="break-words">{user.name}</span>
                </button>
              ))}
            </div>
            {model.assigneeIds.length === 0 && (
              <p className="text-sm text-muted-foreground">
                اختر مصوراً واحداً على الأقل.
              </p>
            )}
          </fieldset>
          {model.message && (
            <p role="status" className="rounded-md border p-3 text-sm">
              {model.message}
            </p>
          )}
          {model.error && (
            <p role="alert" className="text-sm text-destructive">
              {model.error}
            </p>
          )}
        </div>
        <DialogFooter className="flex-wrap gap-2 border-t pt-3">
          <Button
            type="button"
            variant="outline"
            disabled={model.busy}
            onClick={() => model.onOpenChange(false)}
          >
            إغلاق
          </Button>
          {!model.complete && (
            <Button
              type="button"
              className="h-auto min-h-10 whitespace-normal"
              disabled={!model.canLaunch}
              onClick={model.launch}
            >
              {model.busy && (
                <Loader2 aria-hidden className="size-4 animate-spin" />
              )}
              {model.campaignId !== null
                ? "استكمال الحملة المحفوظة"
                : `إطلاق حملة لـ ${model.previewReady ? model.targetCount : "…"} منتج`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
