import React, { useEffect, useRef, useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { getMutationKey } from "@trpc/react-query";
import { trpc } from "@/lib/trpc";
import { ReturnComposer } from "@/components/returns/ReturnComposer";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";
import { workflowSourceBarcode } from "./navigation";
import { Input } from "@/components/ui/input";
import { operationDecision } from "@shared/operationPermissions";
import {
  ReturnConsignmentDialog,
  type ReturnConsignmentTarget,
} from "@/components/delivery/ReturnConsignmentDialog";
import {
  definitiveWorkflowReturnRejection,
  type WorkflowReturnScope,
} from "./workflowReturnRecovery";
import {
  clearWorkflowCommercial,
  chooseWorkflowCommercialRoute,
  persistWorkflowCommercial,
  readWorkflowCommercial,
  type WorkflowCommercialRecovery,
  type WorkflowCommercialSnapshot,
} from "./workflowCommercialReturnRecovery";
import type { WorkflowScanPreview } from "@shared/deliveryWorkflow";

export function useWorkflowCommercialReturnBusy() {
  const creating = useIsMutating({
    mutationKey: getMutationKey(trpc.returns.create),
  });
  const approving = useIsMutating({
    mutationKey: getMutationKey(trpc.returns.approveRequest),
  });
  const withdrawing = useIsMutating({
    mutationKey: getMutationKey(trpc.returns.withdrawRequest),
  });
  const withdrawingControl = useIsMutating({
    mutationKey: getMutationKey(trpc.salesControl.withdraw),
  });
  const returning = useIsMutating({
    mutationKey: getMutationKey(trpc.delivery.returnConsignment),
  });
  const returningByBarcode = useIsMutating({
    mutationKey: getMutationKey(trpc.delivery.returnByBarcode),
  });
  return (
    creating +
      approving +
      withdrawing +
      withdrawingControl +
      returning +
      returningByBarcode >
    0
  );
}

/** Native sale-return composer, restricted to actual physically received source invoices. */
export function WorkflowCommercialReturn({
  actorId,
  branchId,
  preview,
  locked,
  onChanged,
  onRecoveryLockChange,
  onCollect,
}: {
  actorId: number;
  branchId: number;
  preview: WorkflowScanPreview;
  locked: boolean;
  onChanged: () => Promise<void>;
  onRecoveryLockChange: (locked: boolean) => void;
  onWorkOrderReturn?: (source: { id: number; number: string }) => void;
  onCollect?: (raw: string) => void;
}) {
  const me = trpc.auth.me.useQuery();
  const currentActor = me.data?.id === actorId ? me.data : null;
  const nativeRoute = chooseWorkflowCommercialRoute(
    !!currentActor &&
      operationDecision(currentActor, "delivery.returnByBarcode").allowed,
    !!currentActor &&
      operationDecision(currentActor, "delivery.returnConsignment").allowed,
  );
  const scope: WorkflowReturnScope = {
    actorId,
    branchId,
    source: { kind: preview.source.kind, id: preview.source.id },
  };
  function readSaved(): WorkflowCommercialRecovery {
    try {
      return readWorkflowCommercial(window.localStorage, scope);
    } catch {
      return { state: "UNAVAILABLE" };
    }
  }
  const [recovery, setRecovery] =
    useState<WorkflowCommercialRecovery>(readSaved);
  const saved = recovery.state === "SAVED" ? recovery.snapshot : null;
  const blocked =
    recovery.state === "INVALID" || recovery.state === "UNAVAILABLE";
  const [working, setWorking] = useState(false);
  const [reason, setReason] = useState(saved?.input.returnReason ?? "");
  const [target, setTarget] = useState<
    | (ReturnConsignmentTarget & {
        memberIds: number[];
        wholeShipment: boolean;
      })
    | null
  >(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onRecoveryLockChange(saved != null || blocked || working);
    return () => onRecoveryLockChange(false);
  }, [saved, blocked, working, onRecoveryLockChange]);
  const allMembers = preview.relations.aftercareExecutionId
    ? []
    : (preview.returnState?.members ?? []);
  const members = allMembers.filter(
    (member) => member.received && member.commercialActionRequired,
  );
  const sourceOnlyRequest =
    preview.relations.fulfillmentRequestId != null &&
    allMembers.length > 0 &&
    allMembers.every(
      (member) => member.invoiceId == null && member.workOrderId == null,
    );
  const requestClosures =
    sourceOnlyRequest && allMembers.length === 1
      ? allMembers.filter(
          (member) => member.received && member.sourceClosureRequired,
        )
      : [];
  const invoices = members
    .filter(
      (member) =>
        member.invoiceId != null && member.invoiceSourceType !== "WORKORDER",
    )
    .filter(
      (member, index, rows) =>
        rows.findIndex((other) => other.invoiceId === member.invoiceId) ===
        index,
    );
  const workOrders = members.filter(
    (member) =>
      member.invoiceSourceType === "WORKORDER" &&
      member.workOrderId != null &&
      member.workOrderNumber,
  );
  const groupIds =
    preview.group?.consignmentIds ??
    allMembers.map((member) => member.consignmentId);
  const isGroup = groupIds.length > 1;
  const fullGroupAvailable =
    isGroup &&
    allMembers.every((member) => member.received) &&
    groupIds.length === allMembers.length &&
    groupIds.every((id) =>
      allMembers.some((member) => member.consignmentId === id),
    ) &&
    members.length > 0 &&
    preview.group?.leaderConsignmentId != null;
  const singletonReturn =
    !isGroup && allMembers.length === 1 ? members[0] : undefined;
  const [selected, setSelected] = useState("");
  const [opened, setOpened] = useState<number | null>(null);
  const selectedInvoice = invoices.find(
    (invoice) => invoice.invoiceId === Number(selected),
  );
  const eligibleOpened =
    opened != null && invoices.some((invoice) => invoice.invoiceId === opened);
  const invoice = trpc.returns.getInvoice.useQuery(
    { invoiceId: opened ?? 0 },
    { enabled: eligibleOpened },
  );
  const nativeReturn = trpc.delivery.returnConsignment.useMutation();
  const barcodeReturn = trpc.delivery.returnByBarcode.useMutation();
  const formLocked = locked || working || saved != null || blocked;
  const nativeLocked = formLocked || !nativeRoute;
  useEffect(() => {
    if (formLocked) return;
    if (
      opened != null &&
      !invoices.some((invoice) => invoice.invoiceId === opened)
    ) {
      setOpened(null);
      return;
    }
    if (opened != null) return;
    if (!invoices.some((invoice) => String(invoice.invoiceId) === selected))
      setSelected(invoices.length === 1 ? String(invoices[0].invoiceId) : "");
  }, [preview.returnState, selected, opened, formLocked]);
  function persist(snapshot: WorkflowCommercialSnapshot) {
    try {
      return persistWorkflowCommercial(window.localStorage, snapshot);
    } catch {
      return false;
    }
  }
  function clear(snapshot: WorkflowCommercialSnapshot) {
    try {
      return clearWorkflowCommercial(window.localStorage, snapshot);
    } catch {
      return false;
    }
  }
  async function refreshKnown(snapshot: WorkflowCommercialSnapshot) {
    if (!mounted.current) return;
    try {
      await onChanged();
      if (!mounted.current) return;
      if (clear(snapshot)) setRecovery({ state: "EMPTY" });
      else
        notify.warn(
          "المرتجع محسوم؛ تعذر تنظيف نسخة الاسترداد. أعد تحديث المصدر دون إنشاء طلب جديد.",
        );
    } catch {
      if (mounted.current)
        notify.warn(
          snapshot.phase === "COMMITTED"
            ? sourceOnlyRequest
              ? "إقفال إرسالية الطلب مثبت؛ تعذر تحديث العرض فقط. أعد تحديث المصدر نفسه."
              : "المرتجع التجاري مثبت؛ تعذر تحديث العرض فقط. أعد التحديث دون رد أو مرتجع جديد."
            : "رفض الخادم الطلب السابق؛ حدّث المصدر قبل إعداد طلب آخر.",
        );
    }
  }
  async function executeNative(
    snapshot: WorkflowCommercialSnapshot,
    replay: boolean,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    try {
      if (snapshot.phase !== "PENDING") {
        await refreshKnown(snapshot);
        return;
      }
      try {
        if (snapshot.version === 2 && snapshot.route === "BARCODE")
          await barcodeReturn.mutateAsync(snapshot.input);
        else await nativeReturn.mutateAsync(snapshot.input);
      } catch (error) {
        if (!replay && definitiveWorkflowReturnRejection(error)) {
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
              sourceOnlyRequest
                ? "رفض الخادم إقفال إرسالية الطلب؛ راجع المطالبات والشرط الموضح"
                : "رفض الخادم المرتجع التجاري؛ راجع الشرط الظاهر، ولم ينشأ طلب بديل تلقائياً",
            );
        } else if (mounted.current) {
          setRecovery({ state: "SAVED", snapshot });
          notify.err(
            error,
            sourceOnlyRequest
              ? "لم تحسم نتيجة إقفال إرسالية الطلب؛ استعد الحمولة والمفتاح المحفوظين نفسيهما"
              : "لم تحسم نتيجة المرتجع التجاري؛ استعد نفس الطلب والدرج والمفتاح دون رد ثانٍ",
          );
        }
        return;
      }
      const committed = { ...snapshot, phase: "COMMITTED" as const };
      persist(committed);
      if (mounted.current) {
        setRecovery({ state: "SAVED", snapshot: committed });
        notify.ok(
          sourceOnlyRequest
            ? "أغلقت إرسالية الطلب من مصدرها؛ مطالبات الأجور والتحصيل والأمانة تبقى على مستنداتها"
            : snapshot.memberIds.length > 1
              ? `نُفذ المرتجع التجاري للشحنة كاملة (${snapshot.memberIds.length} إرساليات)`
              : "نُفذ المرتجع التجاري من الإرسالية الأصلية",
        );
      }
      await refreshKnown(committed);
    } finally {
      inFlight.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  async function submitNative(args: {
    consignmentId: number;
    refundShiftId: number | undefined;
  }) {
    if (
      nativeLocked ||
      inFlight.current ||
      !target ||
      args.consignmentId !== target.consignmentId
    )
      return;
    if (reason.trim().length < 3) {
      notify.warn(
        sourceOnlyRequest
          ? "اكتب سبب إقفال إرسالية الطلب"
          : "اكتب سبب المرتجع التجاري قبل اعتماد عكس البيع ورد المال",
      );
      return;
    }
    if (
      target.memberIds.some(
        (id) =>
          !allMembers.some(
            (member) => member.consignmentId === id && member.received,
          ),
      ) ||
      (target.wholeShipment &&
        (target.memberIds.length !== allMembers.length ||
          !allMembers.every((member) => member.received)))
    ) {
      notify.warn(
        "تغيّرت عهدة الشحنة؛ يلزم إثبات استلام جميع طرود المرتجع التجاري المحدد فعلياً",
      );
      return;
    }
    const actualMember = allMembers.find(
      (member) => member.consignmentId === target.consignmentId,
    );
    if (
      !actualMember?.received ||
      !nativeRoute ||
      (isGroup && !target.wholeShipment)
    ) {
      notify.warn(
        "يلزم اختيار الإرسالية الأصلية المستلمة ونطاق الشحنة الكامل والصلاحية الحالية",
      );
      return;
    }
    const commonInput = {
      refundShiftId: args.refundShiftId,
      returnReason: reason.trim(),
      clientRequestId: crypto.randomUUID(),
    };
    const snapshot: WorkflowCommercialSnapshot =
      nativeRoute === "BARCODE"
        ? {
            version: 2,
            route: "BARCODE",
            scope,
            phase: "PENDING",
            memberIds: target.memberIds,
            consignmentId: actualMember.consignmentId,
            wholeShipment: target.wholeShipment,
            input: { ...commonInput, barcode: actualMember.consignmentNumber },
          }
        : {
            version: 2,
            route: "CONSIGNMENT",
            scope,
            phase: "PENDING",
            memberIds: target.memberIds,
            input: {
              ...commonInput,
              consignmentId: args.consignmentId,
              wholeShipment: target.wholeShipment,
            },
          };
    if (!persist(snapshot)) {
      setRecovery(readSaved());
      notify.warn(
        "تعذر حفظ طلب المرتجع ومفتاحه بأمان؛ لم يرسل أي رد أو عكس بيع",
      );
      return;
    }
    setRecovery({ state: "SAVED", snapshot });
    setTarget(null);
    await executeNative(snapshot, false);
  }
  if (
    !invoices.length &&
    !workOrders.length &&
    !requestClosures.length &&
    !singletonReturn &&
    !fullGroupAvailable &&
    !saved &&
    !blocked
  )
    return null;
  return (
    <div className="space-y-3 border-t pt-3">
      <p className="font-semibold">
        {sourceOnlyRequest
          ? "إقفال إرسالية الطلب بعد الاستلام الفعلي"
          : "مرتجع البيع ورد حق العميل بعد الاستلام الفعلي"}
      </p>
      <p className="text-sm text-muted-foreground">
        {sourceOnlyRequest
          ? "يُقفل مصدر التوصيل فقط. مطالبات الأجور والتحصيل والائتمان والأمانة مستقلة؛ لا ينشأ إيراد أو مرتجع بيع أو رد مال تلقائي عند هذا الإقفال."
          : "هذا إجراء تجاري مستقل يعكس البيع والمخزون والمال عبر مساره الأصلي. استلام الطرد وحده لم ينفذ أياً منها."}
      </p>
      {blocked && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            تعذر التحقق من الطلب التجاري المحفوظ؛ لا ينشأ مرتجع أو رد جديد قبل
            استعادة نسخته الصحيحة ومراجعة المستند.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={locked || working}
            onClick={() => setRecovery(readSaved())}
          >
            إعادة قراءة نسخة الاسترداد التجاري
          </Button>
        </div>
      )}
      {saved && (
        <div className="space-y-2 rounded border p-3">
          <p className="text-sm">
            {saved.phase === "PENDING"
              ? sourceOnlyRequest
                ? "يوجد طلب إقفال محفوظ لهذه الإرسالية. الاستعادة تعيد نفس الحمولة والمفتاح."
                : `يوجد مرتجع تجاري محفوظ لعدد ${saved.memberIds.length} من الإرساليات. الاستعادة تعيد نفس الحمولة والدرج والمفتاح.`
              : sourceOnlyRequest
                ? "نتيجة إقفال الإرسالية محسومة؛ المطلوب تحديث المصدر فقط."
                : "نتيجة المرتجع التجاري محسومة؛ المطلوب تحديث المصدر فقط."}
          </p>
          <Button
            type="button"
            disabled={locked || working}
            onClick={() => void executeNative(saved, true)}
          >
            {saved.phase === "PENDING"
              ? sourceOnlyRequest
                ? "استعادة نتيجة إقفال الإرسالية نفسها"
                : "استعادة نتيجة المرتجع التجاري نفسه"
              : "تحديث نتيجة إجراء المصدر المثبت"}
          </Button>
        </div>
      )}
      {(workOrders.length > 0 ||
        requestClosures.length > 0 ||
        singletonReturn ||
        fullGroupAvailable) && (
        <div className="space-y-2 rounded border p-3">
          <label className="space-y-1 text-sm">
            {sourceOnlyRequest
              ? "سبب إقفال إرسالية الطلب"
              : "سبب المرتجع التجاري الكامل"}
            <Input
              value={reason}
              maxLength={255}
              disabled={nativeLocked || opened != null}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {requestClosures.map((request) => (
            <Button
              key={request.consignmentId}
              type="button"
              variant="outline"
              disabled={
                nativeLocked || opened != null || reason.trim().length < 3
              }
              onClick={() =>
                setTarget({
                  consignmentId: request.consignmentId,
                  label: `إقفال إرسالية طلب ${preview.relations.fulfillmentRequestId} — ${request.consignmentNumber}`,
                  memberIds: [request.consignmentId],
                  wholeShipment: false,
                })
              }
            >
              إقفال إرسالية الطلب الأصلية — {request.consignmentNumber}
            </Button>
          ))}
          {sourceOnlyRequest && onCollect && (
            <Button
              type="button"
              variant="outline"
              disabled={formLocked}
              onClick={() => onCollect(workflowSourceBarcode(preview.source))}
            >
              مراجعة مطالبات الأجور والتحصيل ورد الأمانة في محطة التحصيل
            </Button>
          )}
          {fullGroupAvailable && (
            <Button
              type="button"
              variant="outline"
              disabled={
                nativeLocked || opened != null || reason.trim().length < 3
              }
              onClick={() =>
                setTarget({
                  consignmentId: members[0].consignmentId,
                  label: `مرتجع تجاري كامل للشحنة — ${allMembers.length} إرساليات: ${allMembers.map((member) => member.consignmentNumber).join("، ")}`,
                  memberIds: allMembers.map((member) => member.consignmentId),
                  wholeShipment: true,
                })
              }
            >
              عكس البيع ورد المال للشحنة كاملة — {allMembers.length} إرساليات
              مستلمة فعلياً
            </Button>
          )}
          {singletonReturn && (
            <Button
              type="button"
              variant="outline"
              disabled={
                nativeLocked || opened != null || reason.trim().length < 3
              }
              onClick={() =>
                setTarget({
                  consignmentId: singletonReturn.consignmentId,
                  label: `مرتجع تجاري كامل للإرسالية الأصلية ${singletonReturn.consignmentNumber}${singletonReturn.workOrderNumber ? ` — أمر الشغل ${singletonReturn.workOrderNumber}` : ""}`,
                  memberIds: [singletonReturn.consignmentId],
                  wholeShipment: false,
                })
              }
            >
              عكس البيع ورد المال للإرسالية كاملة —{" "}
              {singletonReturn.consignmentNumber}
            </Button>
          )}
          {!nativeRoute && (
            <p role="alert" className="text-sm text-destructive">
              يلزم منح إرجاع الإرسالية أو الإرجاع بالباركود لهذا الإجراء؛
              الاستلام الفعلي وحده لا يمنح صلاحية عكس البيع والمال.
            </p>
          )}
          {isGroup && !fullGroupAvailable && workOrders.length > 0 && (
            <p className="text-sm text-muted-foreground">
              المرتجع التجاري لأمر الشغل ضمن هذه الشحنة ينفذ على كامل الشحنة فقط
              بعد استلام وفحص جميع إرسالياتها. لا يعكس اختيار أمر واحد بقية
              الطرود غير المستلمة.
            </p>
          )}
        </div>
      )}
      {invoices.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 space-y-1 text-sm">
            الفاتورة المستلمة
            <AppSelect
              value={selected}
              disabled={formLocked || target != null || opened != null}
              onValueChange={setSelected}
            >
              <option value="">اختر الفاتورة</option>
              {invoices.map((source) => (
                <option key={source.invoiceId} value={String(source.invoiceId)}>
                  {source.invoiceNumber ?? `فاتورة ${source.invoiceId}`} —{" "}
                  {source.consignmentNumber}
                </option>
              ))}
            </AppSelect>
          </label>
          <Button
            type="button"
            variant="outline"
            disabled={
              formLocked || target != null || !selectedInvoice || opened != null
            }
            onClick={() => setOpened(selectedInvoice!.invoiceId)}
          >
            فتح المرتجع التجاري والرد الأصلي
          </Button>
        </div>
      )}
      {eligibleOpened && (
        <div className="space-y-3 rounded border p-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={formLocked}
            onClick={() => setOpened(null)}
          >
            إغلاق محرر المرتجع واختيار مستند آخر
          </Button>
          {invoice.error && (
            <p role="alert" className="text-sm text-destructive">
              {invoice.error.message}
            </p>
          )}
          {invoice.data && invoice.data.branchId !== branchId && (
            <p role="alert" className="text-sm text-destructive">
              فرع الفاتورة لا يطابق فرع المحطة المحدد؛ راجع المصدر وفرع العمل
              قبل الترحيل.
            </p>
          )}
          {invoice.data && invoice.data.branchId === branchId && (
            <fieldset disabled={formLocked} className="min-w-0">
              <ReturnComposer
                key={`${branchId}:${opened}`}
                invoiceId={opened!}
                initialMode="PARTIAL"
                onDone={() => {
                  notify.ok(
                    "نُفذ المرتجع التجاري من مستنده الأصلي؛ تحديث حالة العهدة والحقوق",
                  );
                  void onChanged().catch(() =>
                    notify.warn(
                      "المرتجع التجاري مثبت؛ تعذر تحديث عرض المحطة فقط. حدّث المصدر دون إنشاء مرتجع جديد.",
                    ),
                  );
                }}
              />
            </fieldset>
          )}
        </div>
      )}
      <ReturnConsignmentDialog
        target={target}
        pending={working}
        heading={sourceOnlyRequest ? "إقفال إرسالية الطلب الأصلية" : undefined}
        disclosure={
          sourceOnlyRequest
            ? "استلمت عهدة إرسالية الطلب وفحصتها فعلياً. ينفذ هذا الإجراء إقفال مصدر التوصيل وفق حالته الموثقة. لا يعكس بيعاً ولا يضيف مخزوناً مبيعاً ولا يرد مبالغ الأجور تلقائياً؛ تبقى مطالبات الأجور والائتمان والأمانة على مستنداتها، وتسوّى من محطة التحصيل بعمليات فعلية مرتبطة بمصادرها."
            : undefined
        }
        confirmText={
          sourceOnlyRequest ? "تأكيد إقفال مصدر الإرسالية" : undefined
        }
        onClose={() => {
          if (!working) setTarget(null);
        }}
        onConfirm={(args) => void submitNative(args)}
      />
    </div>
  );
}
