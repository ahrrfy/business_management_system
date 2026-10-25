import { STORE_PUSH_CAMPAIGN_STATUS_LABELS } from "@shared/storePushCampaignTerms";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ErrorState } from "@/components/PageState";
import { useEffect, useRef, useState } from "react";
import {
  BellRing,
  CalendarClock,
  CheckCircle2,
  Megaphone,
  Send,
  XCircle,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/product/variantBits";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";

type FormState = {
  name: string;
  kind: "MARKETING";
  title: string;
  body: string;
  destination: string;
  throttlePerMinute: string;
};
const initial: FormState = {
  name: "",
  kind: "MARKETING",
  title: "",
  body: "",
  destination: "/",
  throttlePerMinute: "120",
};

export default function StorePushCampaignManager() {
  const utils = trpc.useUtils();
  const campaigns = trpc.storeAdmin.notifications.list.useQuery();
  const [scheduleTarget, setScheduleTarget] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [scheduledAt, setScheduledAt] = useState("");
  const [form, setForm] = useState<FormState>(initial);
  const refresh = () => utils.storeAdmin.notifications.list.invalidate();
  const create = trpc.storeAdmin.notifications.create.useMutation();
  const approve = trpc.storeAdmin.notifications.approve.useMutation();
  const schedule = trpc.storeAdmin.notifications.schedule.useMutation();
  const cancel = trpc.storeAdmin.notifications.cancel.useMutation();
  const operationLock = useRef(false);
  const mounted = useRef(true);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const actionsBlocked =
    working || campaigns.isLoading || campaigns.isFetching || campaigns.isError;
  async function run(operation: () => Promise<unknown>, done: () => void) {
    if (operationLock.current) return;
    operationLock.current = true;
    setWorking(true);
    try {
      await operation();
      if (mounted.current) done();
      try {
        await refresh();
      } catch {
        if (mounted.current)
          notify.err(
            "حُفظ التغيير، وتعذّر تحديث القائمة. حدّثها قبل متابعة العمل.",
          );
      }
    } catch (error) {
      if (mounted.current) notify.err(error);
    } finally {
      operationLock.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  const submit = () => {
    const throttle = Number(form.throttlePerMinute);
    if (
      form.name.trim().length < 2 ||
      form.title.trim().length < 2 ||
      form.body.trim().length < 2 ||
      !form.destination.trim() ||
      !Number.isInteger(throttle) ||
      throttle < 10 ||
      throttle > 240
    ) {
      notify.err(
        "أكمل الاسم والعنوان والنص بحرفين على الأقل، والوجهة، وحد الإرسال الصحيح بين 10 و240 في الدقيقة.",
      );
      return;
    }
    const payload = {
      ...form,
      name: form.name.trim(),
      title: form.title.trim(),
      body: form.body.trim(),
      destination: form.destination.trim(),
      throttlePerMinute: throttle,
    };
    void run(
      () => create.mutateAsync(payload),
      () => {
        setForm(initial);
        notify.ok("حُفظت الحملة كمسودة للمراجعة.");
      },
    );
  };
  const scheduleCampaign = () => {
    if (actionsBlocked || !scheduleTarget || !scheduledAt) return;
    const candidate = new Date(scheduledAt);
    if (
      !Number.isFinite(candidate.getTime()) ||
      candidate.getTime() <= Date.now()
    ) {
      notify.err("اختر موعداً صالحاً في المستقبل للحملة المحددة.");
      return;
    }
    const campaignId = scheduleTarget.id;
    void run(
      () =>
        schedule.mutateAsync({
          campaignId,
          scheduledAt: candidate.toISOString(),
        }),
      () => {
        setScheduleTarget(null);
        setScheduledAt("");
        notify.ok("تمت جدولة الحملة للإرسال المحدد.");
      },
    );
  };

  return (
    <div className="mx-auto min-w-0 max-w-7xl space-y-4 pb-8">
      <PageHeader
        title="إشعارات العملاء"
        description="حملات التطبيق تمر بمسودة ثم اعتماد ثم جدولة. لا تستهدف إلا الأجهزة التي وافق أصحابها، ولا تقبل روابط خارج التطبيق."
      />
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        <Card>
          <CardContent className="p-3">
            <div className="text-sm text-muted-foreground">كل الحملات</div>
            <div className="mt-1 text-3xl font-bold tabular-nums">
              {campaigns.isLoading || campaigns.isError
                ? "—"
                : (campaigns.data?.length ?? 0)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-sm text-muted-foreground">
              قيد الإرسال أو الجدولة
            </div>
            <div className="mt-1 text-3xl font-bold tabular-nums">
              {campaigns.isLoading || campaigns.isError
                ? "—"
                : (campaigns.data ?? []).filter(
                    (item) =>
                      item.status === "SCHEDULED" || item.status === "RUNNING",
                  ).length}
            </div>
          </CardContent>
        </Card>
        <Card className="col-span-2 lg:col-span-1">
          <CardContent className="flex items-center gap-3 p-3">
            <div className="rounded-xl bg-primary/10 p-3">
              <BellRing className="size-6 text-primary" />
            </div>
            <p className="text-sm text-muted-foreground">
              رسائل الطلب تشغيلية؛ أما التسويق فلا يصل إلا لمشترك اختار تلقيه.
            </p>
          </CardContent>
        </Card>
      </div>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,.95fr)_minmax(0,1.05fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">إنشاء مسودة حملة</CardTitle>
          </CardHeader>
          <CardContent>
            <fieldset disabled={working} className="grid min-w-0 gap-4">
              <Field label="اسم الحملة" required>
                <Input
                  maxLength={160}
                  value={form.name}
                  onChange={(event) =>
                    setForm({ ...form, name: event.target.value })
                  }
                  placeholder="عرض بداية الموسم"
                />
              </Field>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="النوع">
                  <p className="flex min-h-9 items-center text-sm">
                    تسويقية اختيارية
                  </p>
                </Field>
                <Field label="حد الإرسال/دقيقة">
                  <Input
                    dir="ltr"
                    inputMode="numeric"
                    value={form.throttlePerMinute}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        throttlePerMinute: event.target.value,
                      })
                    }
                  />
                </Field>
              </div>
              <Field label="عنوان الإشعار" required>
                <Input
                  value={form.title}
                  maxLength={80}
                  onChange={(event) =>
                    setForm({ ...form, title: event.target.value })
                  }
                />
              </Field>
              <Field label="نص الإشعار" required>
                <textarea
                  className="min-h-20 w-full rounded-md border bg-transparent p-3 text-sm"
                  maxLength={180}
                  value={form.body}
                  onChange={(event) =>
                    setForm({ ...form, body: event.target.value })
                  }
                />
              </Field>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="وجهة داخل التطبيق" required>
                  <Input
                    dir="ltr"
                    maxLength={180}
                    value={form.destination}
                    onChange={(event) =>
                      setForm({ ...form, destination: event.target.value })
                    }
                    placeholder="/product/123 أو /categories"
                  />
                </Field>
              </div>
              <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                الوجهات المقبولة هي: الصفحة الرئيسية، البحث، الفئات، السلة،
                الطلبات، أو صفحة منتج معرّفة. لا يمكن فتح رابط خارجي من أي
                إشعار.
              </div>
              <div className="flex justify-end">
                <Button
                  disabled={
                    working ||
                    !form.name.trim() ||
                    !form.title.trim() ||
                    !form.body.trim()
                  }
                  onClick={submit}
                >
                  <Megaphone className="size-4" />
                  {working ? ACTION_LABELS.saving : "حفظ كمسودة"}
                </Button>
              </div>
            </fieldset>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              سير الحملة ومؤشرات الأداء
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {campaigns.isLoading && (
              <p role="status" className="text-sm text-muted-foreground">
                {ACTION_LABELS.loading}
              </p>
            )}
            {campaigns.isError && (
              <ErrorState
                message={campaigns.error.message}
                onRetry={() => void campaigns.refetch()}
              />
            )}
            {(campaigns.data ?? []).map((campaign) => (
              <div key={campaign.id} className="min-w-0 rounded-xl border p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 basis-full break-words sm:basis-0 sm:flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <b className="break-words">{campaign.name}</b>
                      <Badge
                        variant={
                          campaign.status === "COMPLETED"
                            ? "secondary"
                            : "outline"
                        }
                      >
                        {STORE_PUSH_CAMPAIGN_STATUS_LABELS[campaign.status] ??
                          campaign.status}
                      </Badge>
                    </div>
                    <div className="mt-1 break-all text-xs text-muted-foreground">
                      {campaign.title} ·{" "}
                      <span dir="ltr">{campaign.destination}</span> ·{" "}
                      {campaign.kind === "MARKETING" ? "تسويقية" : "تشغيلية"}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {campaign.status === "DRAFT" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionsBlocked}
                        onClick={() => {
                          if (!actionsBlocked)
                            void run(
                              () =>
                                approve.mutateAsync({
                                  campaignId: campaign.id,
                                }),
                              () =>
                                notify.ok(
                                  "تم اعتماد الحملة. حدّد موعد الإرسال الآن.",
                                ),
                            );
                        }}
                      >
                        <CheckCircle2 className="size-4" />
                        اعتماد
                      </Button>
                    )}
                    {campaign.status === "APPROVED" && (
                      <Button
                        size="sm"
                        disabled={actionsBlocked}
                        onClick={() => {
                          if (actionsBlocked || operationLock.current) return;
                          setScheduledAt("");
                          setScheduleTarget({
                            id: campaign.id,
                            name: campaign.name,
                          });
                        }}
                      >
                        <CalendarClock className="size-4" />
                        جدولة
                      </Button>
                    )}
                    {["DRAFT", "APPROVED", "SCHEDULED"].includes(
                      campaign.status,
                    ) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={actionsBlocked}
                        onClick={() => {
                          if (!actionsBlocked)
                            void run(
                              () =>
                                cancel.mutateAsync({ campaignId: campaign.id }),
                              () => notify.ok("تم إلغاء الحملة قبل الإرسال."),
                            );
                        }}
                      >
                        <XCircle className="size-4" />
                        إلغاء
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
                  <Metric label="الجمهور" value={campaign.recipientCount} />
                  <Metric label="المرسل" value={campaign.sentCount} />
                  <Metric label="فُتح" value={campaign.openedCount} />
                  <Metric label="نُقر" value={campaign.clickedCount} />
                </div>
                {campaign.scheduledAt && (
                  <div className="mt-3 text-xs text-muted-foreground">
                    الموعد:{" "}
                    <span dir="ltr">
                      {new Date(campaign.scheduledAt).toLocaleString("en-US")}
                    </span>
                  </div>
                )}
              </div>
            ))}
            {!campaigns.isLoading &&
              !campaigns.isError &&
              !campaigns.data?.length && (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  <Send className="mx-auto mb-2 size-6" />
                  أنشئ مسودة، راجع محتواها، ثم اعتمدها وجدولها.
                </div>
              )}
          </CardContent>
        </Card>
      </div>
      <Dialog
        open={scheduleTarget != null}
        onOpenChange={(open) => {
          if (!open && !working) setScheduleTarget(null);
        }}
      >
        <DialogContent
          className="grid-cols-[minmax(0,1fr)]"
          showCloseButton={!working}
          onEscapeKeyDown={(event) => {
            if (working) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (working) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>جدولة الحملة: {scheduleTarget?.name}</DialogTitle>
            <DialogDescription>
              حدد موعد إرسال هذه الحملة بعد مراجعة محتواها واعتمادها.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1 text-sm">
            موعد إرسال الحملة
            <Input
              type="datetime-local"
              disabled={working}
              dir="ltr"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={working}
              onClick={() => setScheduleTarget(null)}
            >
              رجوع
            </Button>
            <Button
              disabled={working || !scheduledAt}
              onClick={scheduleCampaign}
            >
              {working ? ACTION_LABELS.saving : "تأكيد الجدولة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-muted/70 p-2">
      <div className="font-bold tabular-nums">
        {Number(value ?? 0).toLocaleString("en-US")}
      </div>
      <div className="mt-1 text-muted-foreground">{label}</div>
    </div>
  );
}
