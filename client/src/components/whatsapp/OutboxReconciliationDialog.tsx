import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { ACTION_LABELS } from "@shared/actionLabels";

/** The reviewer records external evidence; opening this form never retries delivery. */
export function OutboxReconciliationAction({ outboxId }: { outboxId: number }) {
  const [open, setOpen] = useState(false);
  const me = trpc.auth.me.useQuery();
  if (me.data?.role !== "admin" && !me.data?.isOwner)
    return (
      <span className="text-xs text-muted-foreground">
        راجع المدير لتسوية النتيجة
      </span>
    );
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        مراجعة نتيجة الإرسال
      </Button>
      {open && (
        <OutboxReconciliationDialog
          outboxId={outboxId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function OutboxReconciliationDialog({
  outboxId,
  onClose,
}: {
  outboxId: number;
  onClose: () => void;
}) {
  const [outcome, setOutcome] = useState<"ACCEPTED" | "NOT_SENT">("ACCEPTED");
  const [wamid, setWamid] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const utils = trpc.useUtils();
  const save = trpc.conversations.retrySend.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.conversations.messages.invalidate(),
        utils.conversations.list.invalidate(),
        utils.broadcasts.get.invalidate(),
        utils.broadcasts.results.invalidate(),
      ]);
      notify.ok(
        outcome === "ACCEPTED"
          ? "ثُبّت قبول المزود دون إرسال جديد"
          : "أُعيدت الرسالة للطابور بعد تسجيل دليل عدم القبول",
      );
      onClose();
    },
    onError: (error) => notify.err(error),
  });
  const canSave =
    reason.trim().length >= 10 &&
    evidence.trim().length >= 10 &&
    (outcome === "NOT_SENT" || /^wamid\.\S+$/.test(wamid.trim())) &&
    !save.isPending;
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !save.isPending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>تسوية نتيجة إرسال غير محسومة</DialogTitle>
          <DialogDescription>
            راجع سجل المزود أولاً. تحفظ التسوية قرارك وسببه ودليله في سجل
            التدقيق.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span>نتيجة المراجعة</span>
            <AppSelect
              value={outcome}
              onValueChange={(value) => setOutcome(value as typeof outcome)}
            >
              <option value="ACCEPTED">ثبت قبول المزود للرسالة</option>
              <option value="NOT_SENT">ثبت أن المزود لم يقبل الرسالة</option>
            </AppSelect>
          </label>
          {outcome === "ACCEPTED" ? (
            <label className="block space-y-1 text-sm">
              <span>معرّف الرسالة من سجل المزود</span>
              <Input
                dir="ltr"
                value={wamid}
                onChange={(event) => setWamid(event.target.value)}
                maxLength={200}
                placeholder="wamid.…"
              />
            </label>
          ) : (
            <p className="text-sm text-[var(--sem-warn)]">
              هذا القرار يسمح بمحاولة إرسال جديدة. غياب الرد وحده لا يثبت عدم
              القبول.
            </p>
          )}
          <label className="block space-y-1 text-sm">
            <span>سبب القرار</span>
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              placeholder="اكتب سبب القرار بوضوح (10 أحرف على الأقل)"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>مرجع الدليل أو محضر المراجعة</span>
            <Textarea
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
              maxLength={1000}
              placeholder="مرجع سجل المزود وما أثبته (10 أحرف على الأقل)"
            />
          </label>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={save.isPending}
            onClick={onClose}
          >
            تراجع
          </Button>
          <Button
            type="button"
            disabled={!canSave}
            onClick={() =>
              save.mutate({
                outboxId,
                reconciliation: {
                  outcome,
                  reason,
                  evidence,
                  ...(outcome === "ACCEPTED" ? { wamid: wamid.trim() } : {}),
                },
              })
            }
          >
            {save.isPending
              ? ACTION_LABELS.saving
              : outcome === "ACCEPTED"
                ? "إثبات القبول"
                : "إقرار عدم القبول وإعادة الطابور"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
