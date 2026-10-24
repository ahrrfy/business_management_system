import React, { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { notify } from "@/lib/notify";
import { fmt } from "@/lib/money";
import { confirm } from "@/lib/confirm";
import type { WorkflowScanPreview } from "@shared/deliveryWorkflow";
import { workflowSourceBarcode } from "./navigation";
import {
  WorkflowCommercialReturn,
  useWorkflowCommercialReturnBusy,
} from "./WorkflowCommercialReturn";
import {
  clearWorkflowReturnSnapshot,
  definitiveWorkflowReturnRejection,
  persistWorkflowReturnSnapshot,
  readWorkflowReturnRecovery,
  type WorkflowReturnCommand,
  type WorkflowReturnRecovery,
  type WorkflowReturnScope,
  type WorkflowReturnSnapshot,
} from "./workflowReturnRecovery";

type Props = {
  branchId: number;
  shiftId?: number;
  preview: WorkflowScanPreview;
  onClear: () => void;
  onChanged: (preview: WorkflowScanPreview) => void;
  onAftercare: (context: {
    caseId?: number;
    executionId?: number;
    raw?: string;
  }) => void;
  onCollect?: (raw: string) => void;
  onWorkOrderReturn?: (source: { id: number; number: string }) => void;
};

export function WorkflowReturnSourceCard(props: Props) {
  const me = trpc.auth.me.useQuery();
  if (!me.data?.id)
    return (
      <Card className="mx-auto max-w-3xl p-3">
        <p className="text-sm text-muted-foreground">
          التحقق من جلسة الموظف قبل حركة العهدة
        </p>
      </Card>
    );
  return (
    <WorkflowReturnSourceCardContent
      key={`${me.data.id}:${props.branchId}:${props.preview.source.kind}:${props.preview.source.id}`}
      {...props}
      actorId={me.data.id}
    />
  );
}

function WorkflowReturnSourceCardContent({
  actorId,
  branchId,
  preview,
  onClear,
  onAftercare,
  onChanged,
  onCollect,
  onWorkOrderReturn,
}: Props & { actorId: number }) {
  const utils = trpc.useUtils();
  const scope: WorkflowReturnScope = {
    actorId,
    branchId,
    source: { kind: preview.source.kind, id: preview.source.id },
  };
  function readSaved(): WorkflowReturnRecovery {
    try {
      return readWorkflowReturnRecovery(window.localStorage, scope);
    } catch {
      return { state: "UNAVAILABLE" };
    }
  }
  const [recovery, setRecovery] = useState<WorkflowReturnRecovery>(readSaved);
  const initial = recovery.state === "SAVED" ? recovery.snapshot.command : null;
  const [reason, setReason] = useState(() =>
    initial?.action === "declare"
      ? initial.input.reason
      : (initial?.input.evidence ?? ""),
  );
  const [physical, setPhysical] = useState(initial?.action === "receive");
  const [receivedIds, setReceivedIds] = useState<number[]>(
    initial?.action === "receive"
      ? (initial.input.receivedConsignmentIds ?? [])
      : [],
  );
  const [submitting, setSubmitting] = useState(false);
  const [commercialRecoveryLocked, setCommercialRecoveryLocked] =
    useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const source = trpc.delivery.workflow.previewBySource.useQuery({
    source: scope.source,
    station: "return",
    branchId,
  });
  const current = source.data ?? preview;
  const declare = trpc.delivery.workflow.assignment.useMutation();
  const receive = trpc.delivery.workflow.receiveReturn.useMutation();
  const [receiptRights, setReceiptRights] = useState<{
    commercial: boolean;
    refund: boolean;
  } | null>(null);
  const commercialBusy = useWorkflowCommercialReturnBusy();
  const busy =
    submitting || declare.isPending || receive.isPending || commercialBusy;
  const saved = recovery.state === "SAVED" ? recovery.snapshot : null;
  const blocked =
    recovery.state === "INVALID" ||
    recovery.state === "UNAVAILABLE" ||
    recovery.state === "LEGACY";
  const receiptLocked = busy || saved != null || blocked;
  const locked = receiptLocked || commercialRecoveryLocked;
  const aftercare = current.relations.aftercareExecutionId != null;
  const groupedIds = current.group?.consignmentIds ?? [];
  const canDeclare = current.actions.find(
    (action) => action.action === "declareReturn",
  );
  const canReceive = current.actions.find(
    (action) => action.action === "return",
  );
  useEffect(() => {
    if (saved || busy || !current.returnState) return;
    const available = new Set(
      current.returnState.members
        .filter((member) => member.canReceive && !member.received)
        .map((member) => member.consignmentId),
    );
    const next = receivedIds.filter((id) => available.has(id));
    if (next.length !== receivedIds.length) {
      setReceivedIds(next);
      setPhysical(false);
    }
  }, [current.returnState, receivedIds, saved, busy]);
  function persist(snapshot: WorkflowReturnSnapshot) {
    try {
      return persistWorkflowReturnSnapshot(window.localStorage, snapshot);
    } catch {
      return false;
    }
  }
  function clear(snapshot: WorkflowReturnSnapshot) {
    try {
      return clearWorkflowReturnSnapshot(window.localStorage, snapshot);
    } catch {
      return false;
    }
  }
  async function refreshSettled(snapshot: WorkflowReturnSnapshot) {
    if (!mounted.current) return;
    try {
      const updated = await source.refetch();
      if (updated.error || !updated.data)
        throw updated.error ?? new Error("لم تصل الحالة الحالية");
      if (!mounted.current) return;
      onChanged(updated.data);
      if (clear(snapshot)) setRecovery({ state: "EMPTY" });
      else
        notify.warn(
          "نتيجة الإجراء محسومة؛ تعذر تنظيف نسخة الاسترداد. أعد تحديث الحالة قبل إجراء جديد.",
        );
    } catch {
      if (mounted.current)
        notify.warn(
          snapshot.phase === "COMMITTED"
            ? "الإجراء مثبت في الخادم؛ تعذر تحديث العرض فقط. أعد تحديث الحالة دون تنفيذ رد جديد."
            : "رفض الخادم الطلب السابق؛ تعذر تحديث الحالة الحالية. أعد التحديث قبل طلب جديد.",
        );
    }
  }

  async function execute(action: WorkflowReturnCommand["action"]) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    try {
      // A known local commit remains known even if writing its marker failed.
      if (saved && saved.phase !== "PENDING") {
        await refreshSettled(saved);
        return;
      }
      const restored = readSaved();
      if (
        restored.state === "INVALID" ||
        restored.state === "UNAVAILABLE" ||
        restored.state === "LEGACY"
      ) {
        setRecovery(restored);
        notify.warn(
          "تعذر التحقق من نسخة الاسترداد المحلية؛ لم يرسل إجراء جديد. راجع التخزين والطلب المحفوظ أولاً.",
        );
        return;
      }
      const recovering = restored.state === "SAVED" || saved != null;
      let snapshot: WorkflowReturnSnapshot;
      if (restored.state === "SAVED") {
        snapshot = restored.snapshot;
        setRecovery(restored);
        if (snapshot.phase !== "PENDING") {
          await refreshSettled(snapshot);
          return;
        }
      } else if (saved) {
        snapshot = saved;
        if (!persist(snapshot)) {
          notify.warn(
            "تعذر إعادة تثبيت نسخة الطلب الأصلي؛ لم ترسل محاولة جديدة.",
          );
          return;
        }
      } else {
        // Preflight and the confirmation happen before any mutation/pending command.
        if (reason.trim().length < (action === "receive" ? 5 : 3)) {
          notify.warn(
            action === "receive"
              ? "اكتب دليلاً واضحاً للاستلام والفحص من خمسة أحرف على الأقل"
              : "اكتب سبباً ودليلاً واضحاً من ثلاثة أحرف على الأقل",
          );
          return;
        }
        if (action === "declare" && !canDeclare?.allowed) {
          notify.warn(
            canDeclare?.reason ?? "الحالة الحالية لا تسمح بإعلان رجوع جديد",
          );
          return;
        }
        if (action === "receive" && (!physical || !canReceive?.allowed)) {
          notify.warn(
            canReceive?.reason ??
              "لا تسجل الاستلام قبل وصول الطرد وفحصه فعلياً",
          );
          return;
        }
        let receiptPreview = current;
        if (action === "receive") {
          try {
            receiptPreview =
              await utils.delivery.workflow.previewBySource.fetch({
                source: scope.source,
                station: "return",
                branchId,
              });
            const allowed = receiptPreview.actions.find(
              (action) => action.action === "return",
            );
            if (!allowed?.allowed) {
              notify.warn(
                allowed?.reason ??
                  "تغيّرت حالة الطرد؛ حدّث المصدر قبل إثبات الاستلام",
              );
              return;
            }
            const members = receiptPreview.group?.consignmentIds ?? [];
            if (
              members.length > 1 &&
              (!receivedIds.length ||
                receivedIds.some((id) => !members.includes(id)))
            ) {
              notify.warn(
                "حدد الإرساليات التي وصلت وفحصتها فعلياً؛ لا يفترض رجوع كامل الشحنة",
              );
              return;
            }
            if (
              members.length > 1 &&
              receivedIds.some(
                (id) =>
                  !receiptPreview.returnState?.members.some(
                    (member) =>
                      member.consignmentId === id &&
                      member.canReceive &&
                      !member.received,
                  ),
              )
            ) {
              notify.warn(
                "تغيّرت عهدة إرسالية محددة؛ حدّث الشحنة وحدد الطرود العائدة المتاحة التي لم يثبت استلامها بعد",
              );
              return;
            }
          } catch (error) {
            notify.err(
              error,
              "تعذرت معاينة إرسالية الرجوع؛ لم يرسل إجراء الاستلام",
            );
            return;
          }
        }
        if (!mounted.current) return;
        const ok = await confirm({
          title:
            action === "declare"
              ? "إعلان رجوع الطرد"
              : "إثبات الاستلام والفحص الفعلي",
          description: `${current.source.number}\n${reason.trim()}\n${action === "declare" ? "طلب الرجوع وحده لا يعيد مخزوناً ولا يرد مبلغاً." : "يثبت وصول العهدة وفحصها فقط؛ مرتجع البيع ورد المال وتسوية الأمانة إجراءات مستقلة تبقى مرتبطة بمصادرها."}`,
          confirmText: action === "declare" ? "إعلان الرجوع" : "تأكيد الاستلام",
        });
        if (!ok || !mounted.current) return;
        const clientRequestId = crypto.randomUUID();
        const command: WorkflowReturnCommand =
          action === "declare"
            ? {
                action,
                input: {
                  source: {
                    kind: current.source.kind,
                    id: current.source.id,
                    expectedVersion: current.source.version,
                  },
                  action: "declareReturn",
                  reason: reason.trim(),
                  branchId,
                  clientRequestId,
                },
              }
            : {
                action,
                input: {
                  source: {
                    kind: receiptPreview.source.kind,
                    id: receiptPreview.source.id,
                    expectedVersion: receiptPreview.source.version,
                  },
                  branchId,
                  evidence: reason.trim(),
                  inspected: true,
                  receivedConsignmentIds:
                    (receiptPreview.group?.consignmentIds.length ?? 0) > 1
                      ? receivedIds
                      : undefined,
                  clientRequestId,
                },
              };
        snapshot = {
          version: 2,
          scope,
          phase: "PENDING",
          savedAt: Date.now(),
          command,
        };
        if (!persist(snapshot)) {
          setRecovery(readSaved());
          notify.warn(
            "تعذر حفظ مفتاح الاسترداد بأمان؛ لم يرسل أي إجراء. فعّل التخزين المحلي ثم أعد المحاولة.",
          );
          return;
        }
        setRecovery({ state: "SAVED", snapshot });
      }
      // Only this catch classifies a mutation reply. Refresh/storage failures cannot undo success.
      try {
        if (snapshot.command.action === "declare")
          await declare.mutateAsync(snapshot.command.input);
        else {
          const result = await receive.mutateAsync(snapshot.command.input);
          if (mounted.current)
            setReceiptRights({
              commercial: result.commercialActionRequired,
              refund: result.refundActionRequired,
            });
        }
      } catch (error) {
        if (!recovering && definitiveWorkflowReturnRejection(error)) {
          const rejected = { ...snapshot, phase: "REJECTED" as const };
          persist(rejected);
          if (mounted.current)
            setRecovery(
              clear(rejected)
                ? { state: "EMPTY" }
                : { state: "SAVED", snapshot: rejected },
            );
          if (mounted.current)
            notify.err(
              error,
              "رفض الخادم الطلب السابق؛ راجع الشرط الموضح قبل المحاولة التالية",
            );
          if (mounted.current)
            void source
              .refetch()
              .then((updated) => {
                if (mounted.current && !updated.error && updated.data)
                  onChanged(updated.data);
              })
              .catch(() => {});
        } else if (mounted.current) {
          setRecovery({ state: "SAVED", snapshot });
          notify.err(
            error,
            "تعذر حسم النتيجة؛ بقي الطلب نفسه محفوظاً لاستعادته دون رد أو استلام مكرر",
          );
        }
        return;
      }
      const committed = { ...snapshot, phase: "COMMITTED" as const };
      persist(committed);
      if (mounted.current) {
        setRecovery({ state: "SAVED", snapshot: committed });
        notify.ok(
          snapshot.command.action === "declare"
            ? "سجل طلب الرجوع دون حركة مخزون"
            : "ثبت الاستلام والفحص الفعلي؛ حقوق البيع والأمانة ورد المال تبقى على مساراتها المرتبطة",
        );
      }
      void utils.delivery.invalidate().catch(() => {});
      void utils.workOrders.invalidate().catch(() => {});
      await refreshSettled(committed);
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  return (
    <Card className="mx-auto max-w-3xl gap-3 p-3">
      <h2 className="break-words font-semibold">
        الطرد المرتبط: {current.printSource.number}
      </h2>
      <p className="text-sm text-muted-foreground">
        {current.recipient.name} · تحصيل العميل {fmt(current.money.codAmount)}{" "}
        د.ع{aftercare ? " · معالجة على حساب المكتبة" : ""}
      </p>
      <label className="space-y-1 text-sm">
        سبب الرجوع والدليل
        <Input
          value={reason}
          disabled={locked}
          onChange={(event) => setReason(event.target.value)}
          maxLength={255}
        />
      </label>
      {groupedIds.length > 1 && (
        <div className="space-y-2 rounded border p-3">
          <p className="text-sm font-medium">
            حدد الإرساليات المستلمة والمفحوصة فعلياً من الشحنة
          </p>
          {groupedIds.map((id) => {
            const member = current.returnState?.members.find(
              (member) => member.consignmentId === id,
            );
            return (
              <label
                key={id}
                className="flex min-h-10 items-center gap-2 text-sm"
              >
                <Checkbox
                  checked={receivedIds.includes(id)}
                  disabled={
                    locked ||
                    !canReceive?.allowed ||
                    member?.received === true ||
                    member?.canReceive !== true
                  }
                  onCheckedChange={(value) =>
                    setReceivedIds((previous) =>
                      value === true
                        ? Array.from(new Set([...previous, id]))
                        : previous.filter((candidate) => candidate !== id),
                    )
                  }
                />
                {member?.consignmentNumber ?? `الإرسالية ${id}`} —{" "}
                {member?.received
                  ? "استلمت وفحصت"
                  : member?.canReceive
                    ? member.declared
                      ? "رجوع معلن؛ بانتظار الاستلام الفعلي"
                      : "عهدة قائمة؛ أثبت الاستلام والفحص عند وصولها"
                    : "غير متاحة للاستلام الحالي"}
                {member?.heldCustomerOwned
                  ? " — مملوكة للعميل بعهدة المكتبة"
                  : ""}
              </label>
            );
          })}
        </div>
      )}
      {blocked && (
        <p role="alert" className="text-sm text-destructive">
          {recovery.state === "LEGACY"
            ? "يوجد طلب رجوع قديم قد يشمل عكس بيع أو رد مال. راجع نتيجته الأصلية قبل إنشاء استلام عهدة مستقل؛ لا يعاد تفسيره كإجراء جديد."
            : "تعذر قراءة الطلب المحفوظ بأمان. لن يرسل رد أو استلام جديد قبل معالجة نسخة الاسترداد المحلية ومراجعة السجل."}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-muted-foreground">
          {saved.phase === "PENDING"
            ? "نتيجة المحاولة السابقة غير محسومة؛ الاستعادة تعيد نفس المصدر ونسخته والدليل والمفتاح المحفوظ."
            : saved.phase === "COMMITTED"
              ? "الإجراء مثبت؛ المطلوب تحديث العرض فقط، دون إرسال إجراء جديد."
              : "رفض الخادم الطلب السابق؛ حدّث الحالة الحالية قبل إجراء جديد."}
        </p>
      )}
      {!aftercare && (
        <p className="text-sm text-muted-foreground">
          استلام الطرد العائد لا يلغي البيع ولا يعيد مخزون المبيع المملوك ولا
          يرد مال العميل تلقائياً. راجع حق البيع والأمانة والرد على مستنداتها
          الأصلية.
        </p>
      )}
      {current.returnState && (
        <p className="text-sm text-muted-foreground">
          {current.returnState.nextStep}
        </p>
      )}
      {receiptRights && (receiptRights.commercial || receiptRights.refund) && (
        <p role="status" className="text-sm text-muted-foreground">
          {receiptRights.commercial ? "بقي إجراء تجاري مرتبط بالأصل. " : ""}
          {receiptRights.refund
            ? "بقي رد أو أمانة مالية يحتاج تنفيذاً فعلياً من مساره الأصلي."
            : ""}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {canDeclare?.allowed && (
          <SubmitButton
            type="button"
            variant="outline"
            pending={(submitting && !saved) || declare.isPending}
            disabled={locked}
            onClick={() => void execute("declare")}
          >
            إعلان رجوع الطرد
          </SubmitButton>
        )}
        {canReceive?.allowed && (
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <Checkbox
              checked={physical}
              disabled={locked}
              onCheckedChange={(value) => setPhysical(value === true)}
            />
            {groupedIds.length > 1
              ? "وصلت الإرساليات المحددة وفحصت عهدتها فعلياً"
              : "وصل الطرد وفحصت العهدة فعلياً"}
          </label>
        )}
        {canReceive?.allowed && (
          <SubmitButton
            type="button"
            pending={receive.isPending}
            disabled={
              locked ||
              !physical ||
              (groupedIds.length > 1 && !receivedIds.length)
            }
            onClick={() => void execute("receive")}
          >
            استلام وفحص العهدة
          </SubmitButton>
        )}
        {saved && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => void execute(saved.command.action)}
          >
            {saved.phase === "PENDING"
              ? "استعادة نتيجة المحاولة نفسها"
              : "تحديث نتيجة الإجراء المحسوم"}
          </Button>
        )}
        {blocked && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => setRecovery(readSaved())}
          >
            إعادة قراءة نسخة الاسترداد
          </Button>
        )}
      </div>
      {!canReceive?.allowed && (
        <p className="text-sm text-muted-foreground">
          {canReceive?.reason ?? "راجع حالة الإرسالية قبل الاستلام"}
        </p>
      )}
      {source.error && (
        <p role="alert" className="text-sm text-destructive">
          {source.error.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {(aftercare || current.relations.aftercareCaseId != null) && (
          <Button
            type="button"
            variant="outline"
            disabled={locked}
            onClick={() =>
              onAftercare({
                caseId: current.relations.aftercareCaseId,
                executionId: current.relations.aftercareExecutionId,
              })
            }
          >
            متابعة المعالجة والتسوية
          </Button>
        )}
        {current.relations.consignmentId && onCollect && (
          <Button
            type="button"
            variant="outline"
            disabled={locked}
            onClick={() => onCollect(workflowSourceBarcode(current.source))}
          >
            مراجعة التحصيل والأمانة
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={locked}
          onClick={onClear}
        >
          مسح طرد آخر
        </Button>
      </div>
      {!aftercare && (
        <WorkflowCommercialReturn
          actorId={actorId}
          branchId={branchId}
          preview={current}
          locked={receiptLocked}
          onRecoveryLockChange={setCommercialRecoveryLocked}
          onWorkOrderReturn={onWorkOrderReturn}
          onCollect={onCollect}
          onChanged={async () => {
            const updated = await source.refetch();
            if (updated.error || !updated.data)
              throw updated.error ?? new Error("تعذر تحديث المصدر الحالي");
            if (mounted.current) onChanged(updated.data);
          }}
        />
      )}
    </Card>
  );
}
