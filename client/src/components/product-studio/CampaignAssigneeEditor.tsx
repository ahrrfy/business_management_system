import { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import type { RouterOutputs } from "@/lib/trpc";

/**
 * محرّرُ فريق الحملة: يستقبل قائمة المصوّرين الحاليّة ولوحةَ الأشخاص، ويُقدّم بديلاً
 * سريعاً للمدير من إعادة إنشاء الحملة كلّها. يعرض حالة «مُنجزٌ الآن» لكل مصوّرٍ ضمن
 * الحملة ليقرّر المدير الإزالة عن علم، ويطالب بمنح صلاحية الاستوديو صراحةً لمن لا يملكها
 * قبل السماح باختياره — بلا اختيارٍ صامتٍ لموظفٍ يعجز عمليّاً عن استعمال الصلاحية.
 */
export function CampaignAssigneeEditor({
  campaignBoard,
  assignees,
  disabled,
  onSave,
  onGrant,
  grantPending,
}: {
  campaignBoard: RouterOutputs["productStudio"]["campaignBoard"] | undefined;
  assignees: RouterOutputs["productStudio"]["assignees"];
  disabled: boolean;
  onSave: (assigneeIds: number[]) => void;
  onGrant: (userId: number) => void;
  grantPending: boolean;
}) {
  const memberIds = useMemo(
    () => new Set((campaignBoard?.photographers ?? []).map((p) => Number(p.userId))),
    [campaignBoard],
  );
  const [pendingIds, setPendingIds] = useState<Set<number>>(memberIds);
  useEffect(() => setPendingIds(new Set(memberIds)), [memberIds]);
  const memberProgress = useMemo(
    () =>
      new Map(
        (campaignBoard?.photographers ?? []).map((p) => [
          Number(p.userId),
          { done: p.done, active: p.active },
        ]),
      ),
    [campaignBoard],
  );
  const dirty = useMemo(() => {
    if (pendingIds.size !== memberIds.size) return true;
    let differs = false;
    pendingIds.forEach((id) => {
      if (!memberIds.has(id)) differs = true;
    });
    return differs;
  }, [pendingIds, memberIds]);
  const toggle = (id: number) =>
    setPendingIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="space-y-2">
      <div className="grid gap-1.5 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
        {assignees.length === 0 && (
          <span className="col-span-full text-xs text-muted-foreground">
            لا موظفين متاحين في هذا الفرع.
          </span>
        )}
        {assignees.map((user) => {
          const picked = pendingIds.has(user.id);
          if (!user.canStudio) {
            return (
              <span
                key={user.id}
                className="flex flex-col items-stretch gap-1 rounded-md border border-dashed p-1.5 text-[11px] text-muted-foreground"
              >
                <span className="truncate text-center">{user.name}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 text-[10px]"
                  disabled={disabled || grantPending}
                  onClick={() => onGrant(user.id)}
                >
                  امنح الصلاحية
                </Button>
              </span>
            );
          }
          const progress = memberProgress.get(user.id);
          return (
            <Button
              key={user.id}
              type="button"
              size="sm"
              variant={picked ? "default" : "outline"}
              className="h-9 justify-center px-2 py-2 text-xs"
              disabled={disabled}
              onClick={() => toggle(user.id)}
              title={
                progress && (progress.done > 0 || progress.active > 0)
                  ? `${progress.done} منجَز · ${progress.active} قيد العمل`
                  : undefined
              }
            >
              <span className="truncate">{user.name}</span>
              {progress && (progress.done > 0 || progress.active > 0) && (
                <span className="ms-1 shrink-0 text-[10px] opacity-80">
                  · {progress.done}/{progress.done + progress.active}
                </span>
              )}
            </Button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          className="min-h-11"
          disabled={disabled || !dirty}
          onClick={() => onSave(Array.from(pendingIds))}
        >
          احفظ فريق الحملة
        </Button>
        {dirty && (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={disabled}
            onClick={() => setPendingIds(new Set(memberIds))}
          >
            إلغاء التعديل
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {pendingIds.size} مصوّرٍ في القائمة النهائيّة{dirty ? " · لم يُحفظ بعد" : ""}
        </span>
      </div>
    </div>
  );
}
