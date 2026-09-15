import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { XCircle, UserCheck, Bell } from "lucide-react";
import { CampaignAssigneeEditor } from "@/components/product-studio/CampaignAssigneeEditor";
import { backlogButtonSuffix } from "@/lib/productStudio/studioBoardLabels";

export function StudioCampaignsBoard({
  offline,
  campaignId,
}: {
  offline: boolean;
  campaignId: number;
}) {
  const [backlogCancelReason, setBacklogCancelReason] = useState("");
  const [tempPhotographerName, setTempPhotographerName] = useState("");
  const [issuedAccess, setIssuedAccess] = useState<{ name: string; username: string; code: string; expiresAt: string | Date } | null>(null);

  const utils = trpc.useUtils();
  const assignees = trpc.productStudio.assignees.useQuery(undefined, { enabled: !offline });
  
  const campaignPreview = trpc.productStudio.previewCampaignBacklog.useQuery(
    { campaignId },
    { enabled: !offline }
  );
  const campaignAnalytics = trpc.productStudio.campaignAnalytics.useQuery({ campaignId },
    { enabled: !offline }
  );
  const campaignBoard = trpc.productStudio.campaignBoard.useQuery({ campaignId },
    { enabled: !offline }
  );

  const createCampaignBacklog = trpc.productStudio.createCampaignBacklog.useMutation({
    onSuccess: async () => {
      notify.ok("بدأ توليد مهام الحملة");
      if (!offline) {
        await Promise.all([
          utils.productStudio.campaignBoard.invalidate(),
          utils.productStudio.previewCampaignBacklog.invalidate(),
        ]);
      }
    },
    onError: (error) => notify.err(error),
  });

  const sendDueNotifications = trpc.productStudio.sendDueNotifications.useMutation({
    onSuccess: async () => {
      notify.ok("تم إرسال تنبيهات المواعيد للمصوّرين");
    },
    onError: (error) => notify.err(error),
  });

  const cancelCampaignBacklog = trpc.productStudio.cancelCampaignBacklog.useMutation({
    onSuccess: async () => {
      notify.ok("تم إلغاء مهام الطابور غير المُسندة");
      setBacklogCancelReason("");
      if (!offline) {
        await Promise.all([
          utils.productStudio.campaignBoard.invalidate(),
          utils.productStudio.previewCampaignBacklog.invalidate(),
        ]);
      }
    },
    onError: (error) => notify.err(error),
  });

  const updateCampaignAssignees = trpc.productStudio.updateCampaignAssignees.useMutation({
    onSuccess: async () => {
      notify.ok("تم تحديث مصوري الحملة");
      if (!offline) await utils.productStudio.campaignBoard.invalidate();
    },
    onError: (error) => notify.err(error),
  });

  const grantStudioAccess = trpc.productStudio.grantStudioAccess.useMutation({
    onSuccess: async () => {
      notify.ok("تم منح الصلاحية");
      if (!offline) await utils.productStudio.assignees.invalidate();
    },
    onError: (error) => notify.err(error),
  });

  const createTemporaryPhotographer = trpc.productStudio.createTemporaryPhotographer.useMutation({
    onSuccess: async (data) => {
      notify.ok("تم إنشاء وصول مؤقت");
      setIssuedAccess(data);
      setTempPhotographerName("");
      if (!offline) await utils.productStudio.campaignBoard.invalidate();
    },
    onError: (error) => notify.err(error),
  });

  const revokeTemporaryPhotographers = trpc.productStudio.revokeTemporaryPhotographers.useMutation({
    onSuccess: async () => {
      notify.ok("تم إلغاء وصول جميع المصورين المؤقتين لهذه الحملة");
      if (!offline) await utils.productStudio.campaignBoard.invalidate();
    },
    onError: (error) => notify.err(error),
  });

  return (
    <div className="space-y-4 pt-4 border-t">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-wrap items-end gap-2">
          <Button
            variant="outline"
            className="min-h-11 flex-1"
            disabled={createCampaignBacklog.isPending || offline}
            onClick={() => createCampaignBacklog.mutate({ campaignId })}
          >
            توليد مهام الناقصة {backlogButtonSuffix({ campaignSelected: true, isError: campaignPreview.isError, isPending: campaignPreview.isPending, count: campaignPreview.data?.count, batchLimit: campaignPreview.data?.batchLimit })}
          </Button>
          <Button variant="outline" className="min-h-11" disabled={offline || sendDueNotifications.isPending} onClick={() => sendDueNotifications.mutate({ horizonHours: 24 })}>
            <Bell aria-hidden className="size-4" /> تنبيه المواعيد
          </Button>
        </div>
      </div>

      <div className="space-y-2 rounded-md border p-3">
        <Label>تراجع عن طابور خاطئ</Label>
        <p className="text-xs text-muted-foreground">للتراجع عن توليدٍ خاطئ. الإلغاء يحرر المنتجات غير المسندة لمهام جديدة.</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-52 flex-1">
            <Input value={backlogCancelReason} onChange={(event) => setBacklogCancelReason(event.target.value)} placeholder="سبب الإلغاء (٥ أحرف على الأقل)" maxLength={500} />
          </div>
          <Button
            type="button" variant="destructive" className="min-h-11" disabled={offline || cancelCampaignBacklog.isPending || backlogCancelReason.trim().length < 5}
            onClick={() => cancelCampaignBacklog.mutate({ campaignId, reason: backlogCancelReason })}
          >
            <XCircle aria-hidden className="size-4" /> إلغاء الطابور
          </Button>
        </div>
      </div>

      {campaignBoard.data && (
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">طابور الحملة</span>
            <span className="text-xs text-muted-foreground">التوجيه: {campaignBoard.data.requiredImages} صورة لكل منتج</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border bg-[var(--sem-pos-bg,transparent)] p-2">
              <div className="text-xs text-muted-foreground">منتجات اكتملت صورها</div>
              <div className="mt-0.5 text-lg font-bold">
                {campaignBoard.data.done}
                <span className="text-xs font-normal text-muted-foreground"> / {campaignBoard.data.totalProducts}</span>
              </div>
            </div>
            <div className="rounded-md border p-2">
              <div className="text-xs text-muted-foreground">منتجات متبقّية</div>
              <div className="mt-0.5 text-lg font-bold">{campaignBoard.data.remaining}</div>
            </div>
          </div>
          
          <div className="text-xs text-muted-foreground">المهام الجارية (وحدةُ مهمّة لا منتج)</div>
          <div className="grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-5">
            {[
              ["لم تُولَّد بعد", campaignBoard.data.breakdown.notGenerated],
              ["في الطابور", campaignBoard.data.breakdown.queued],
              ["قيد التصوير", campaignBoard.data.breakdown.inProgress],
              ["تنتظر اعتمادك", campaignBoard.data.breakdown.awaitingReview],
              ["تحتاج تصحيحاً", campaignBoard.data.breakdown.needsFix],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-md border p-2">
                <div className="text-muted-foreground">{label}</div>
                <div className="mt-0.5 font-bold">{value}</div>
              </div>
            ))}
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <Label>تعديل مصوّري الحملة</Label>
            <CampaignAssigneeEditor
              campaignBoard={campaignBoard.data}
              assignees={assignees.data ?? []}
              disabled={offline || updateCampaignAssignees.isPending}
              onSave={(assigneeIds) => updateCampaignAssignees.mutate({ campaignId, assigneeIds })}
              onGrant={(userId) => grantStudioAccess.mutate({ userId })}
              grantPending={grantStudioAccess.isPending}
            />
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <Label>مصوّر مؤقّت (بلا حساب دائم)</Label>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1">
                <Input value={tempPhotographerName} onChange={(event) => setTempPhotographerName(event.target.value)} placeholder="اسم المصوّر" maxLength={80} />
              </div>
              <Button
                type="button" className="min-h-11" disabled={offline || createTemporaryPhotographer.isPending || tempPhotographerName.trim().length < 3}
                onClick={() => createTemporaryPhotographer.mutate({ campaignId, name: tempPhotographerName })}
              >
                <UserCheck aria-hidden className="size-4" /> إنشاء وصول مؤقّت
              </Button>
              <Button
                type="button" variant="outline" className="min-h-11" disabled={offline || revokeTemporaryPhotographers.isPending}
                onClick={() => revokeTemporaryPhotographers.mutate({ campaignId })}
              >
                إغلاق الوصول المؤقّت
              </Button>
            </div>
            {issuedAccess && (
              <div role="alert" className="space-y-1 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm">
                <p className="font-medium">سلّم هذه البيانات لـ«{issuedAccess.name}» الآن — لن تظهر مرّةً أخرى.</p>
                <p>اسم الدخول: <span className="font-mono">{issuedAccess.username}</span></p>
                <p>الرمز: <span className="font-mono text-base">{issuedAccess.code}</span></p>
                <p className="text-xs text-muted-foreground">ينتهي: {new Date(issuedAccess.expiresAt).toLocaleString("ar-IQ-u-nu-latn")}</p>
                <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setIssuedAccess(null)}>أخفِ الرمز</Button>
              </div>
            )}
          </div>
        </div>
      )}

      {campaignAnalytics.data && (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {[
              ["الإجمالي", campaignAnalytics.data.total],
              ["الإنجاز", `${campaignAnalytics.data.completionPercent}%`],
              ["اعتماد أول مرة", campaignAnalytics.data.firstPassApprovalRate == null ? "—" : `${campaignAnalytics.data.firstPassApprovalRate}%`],
              ["وسيط الدورة", campaignAnalytics.data.medianCycleMinutes == null ? "—" : `${campaignAnalytics.data.medianCycleMinutes} د`],
              ["مرفوضة", campaignAnalytics.data.rejected],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="mt-0.5 text-base font-bold">{value}</div>
              </div>
            ))}
          </div>
          {campaignAnalytics.data.rejectionReasons.length > 0 && (
            <div className="rounded-md border p-3">
              <div className="text-sm font-medium">أسباب الرفض</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {campaignAnalytics.data.rejectionReasons.map((item: any) => (
                  <Badge key={item.reason} variant="warning">{item.reason} · {item.count}</Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
