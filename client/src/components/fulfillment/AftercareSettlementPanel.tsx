import React, { useRef, useState } from "react";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { useOperationPermission } from "@/hooks/useOperationPermission";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { D, fmt } from "@/lib/money";
import { paymentMethodCompact } from "@shared/terms";
import { confirm } from "@/lib/confirm";
import { preopenDocumentWindow } from "@/lib/printing/brand";
import { printOverageRefundReceipt } from "@/lib/printing/cashierLifecycleReceipts";
import { useWorkflowDocumentPrinter } from "@/hooks/useWorkflowDocumentPrinter";
import { WorkflowPrintActions } from "@/components/delivery/workflow/WorkflowPrintActions";

type Api = RouterInputs["delivery"]["fulfillment"]["aftercare"];
type Detail = RouterOutputs["delivery"]["fulfillment"]["aftercare"]["get"];
type Right = Api["settlementPreview"]["sourceRights"][number];

export function AftercareSettlementPanel({
  data,
  onChange,
}: {
  data: Detail;
  onChange: () => Promise<void>;
}) {
  const me = trpc.auth.me.useQuery();
  const workflowPrinter = useWorkflowDocumentPrinter(data.case.branchId);
  const canRequest = useOperationPermission(
    "delivery.fulfillment.aftercare.settlementRequest",
  ).allowed;
  const canApprove = useOperationPermission(
    "delivery.fulfillment.aftercare.approveSettlement",
  ).allowed;
  const canPost = useOperationPermission(
    "delivery.fulfillment.aftercare.settlementPost",
  ).allowed;
  const canWithdraw = useOperationPermission(
    "delivery.fulfillment.aftercare.settlementWithdraw",
  ).allowed;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [held, setHeld] = useState(false);
  const [values, setValues] = useState<
    Record<number, { usable: string; consumed: string; damaged: string }>
  >({});
  const [rights, setRights] = useState<Record<number, Partial<Right>>>({});
  const keys = useRef(new Map<string, string>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const request =
    trpc.delivery.fulfillment.aftercare.settlementRequest.useMutation();
  const approve =
    trpc.delivery.fulfillment.aftercare.approveSettlement.useMutation();
  const post = trpc.delivery.fulfillment.aftercare.settlementPost.useMutation();
  const withdraw =
    trpc.delivery.fulfillment.aftercare.settlementWithdraw.useMutation();
  const all = data.executions.flatMap((execution) =>
    execution.lines.map((line) => ({ ...line, execution })),
  );
  const reused = new Set(
    all.flatMap((line) =>
      line.reusedFromLineId ? [line.reusedFromLineId] : [],
    ),
  );
  const end = (line: (typeof all)[number]): (typeof all)[number] => {
    const next = all.find(
      (candidate) => candidate.reusedFromLineId === line.id,
    );
    return next ? end(next) : line;
  };
  const lines = all.filter((line) => {
    if (line.kind === "OUTPUT")
      return (
        !reused.has(line.id) &&
        line.deliveredBaseQuantity < line.fulfilledBaseQuantity
      );
    const output = all.find(
      (candidate) =>
        candidate.executionId === line.executionId &&
        candidate.aftercareLineId === line.aftercareLineId &&
        candidate.kind === "OUTPUT",
    );
    return output && end(output).deliveredBaseQuantity === 0;
  });
  const originalHeld = data.lines.filter(
    (line) =>
      line.disposition === "MISSING_HELD" &&
      line.deliveredBaseQuantity < line.baseQuantity,
  );
  const payload: Api["settlementPreview"] = {
    id: data.case.id,
    expectedVersion: data.case.version,
    reason,
    evidence,
    physicalHeldConfirmed: held,
    decisions: lines.map((line) => {
      const disposition = data.lines.find(
        (parent) => parent.id === line.aftercareLineId,
      )?.disposition;
      const automaticUsable =
        line.kind === "OUTPUT" && disposition !== "REPRINT"
          ? line.baseQuantity - line.deliveredBaseQuantity
          : 0;
      const value = values[line.id] ?? {
        usable: String(automaticUsable),
        consumed: String(
          line.baseQuantity - line.deliveredBaseQuantity - automaticUsable,
        ),
        damaged: "0",
      };
      return {
        executionLineId: line.id,
        usableBaseQuantity: Number(value.usable),
        consumedBaseQuantity: Number(value.consumed),
        damagedBaseQuantity: Number(value.damaged),
        evidence,
      };
    }),
    sourceRights: originalHeld.map((line) => ({
      invoiceItemId: line.originalInvoiceItemId!,
      originalBundleComponentId: line.originalBundleComponentId,
      componentVariantId: line.componentVariantId!,
      baseQuantity: line.baseQuantity - line.deliveredBaseQuantity,
      originalMovementId: line.originalMovementId!,
      usableBaseQuantity: line.baseQuantity - line.deliveredBaseQuantity,
      damagedBaseQuantity: 0,
      commercialAmount: "",
      originalIssueValue: "",
      costEvidence: "",
      costEvidenceReference: "",
      ...rights[line.id],
    })),
  };
  const preview =
    trpc.delivery.fulfillment.aftercare.settlementPreview.useQuery(payload, {
      enabled: false,
      retry: false,
    });
  async function execute<T extends object, R = unknown>(
    operation: string,
    value: T,
    mutate: (input: T & { clientRequestId: string }) => Promise<R>,
  ): Promise<R | undefined> {
    const fingerprint = `${operation}:${JSON.stringify(value)}`;
    const key = keys.current.get(fingerprint) ?? crypto.randomUUID();
    keys.current.set(fingerprint, key);
    setPending(true);
    setError("");
    try {
      const out = await mutate({ ...value, clientRequestId: key });
      keys.current.delete(fingerprint);
      await onChange();
      return out;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "تعذرت التسوية؛ راجع المستند والأدلة ثم أعد المحاولة",
      );
    } finally {
      setPending(false);
    }
  }
  const settlement = data.settlement;
  if (
    !settlement &&
    (!canRequest ||
      data.lines.every(
        (line) => line.deliveredBaseQuantity === line.baseQuantity,
      ))
  )
    return null;
  return (
    <div className="space-y-3 border-t pt-3">
      <p className="font-medium">تسوية إيقاف التجهيز</p>
      <p className="text-sm text-muted-foreground">
        تُسجل الكمية المسوّاة منفصلة عن المسلّمة. الصالح وحده يعود بقيمة صرفه
        الأصلية؛ التالف والمستهلك لا يعودان للمخزون ولا يُحمّلان مصروفاً ثانياً.
      </p>
      {settlement ? (
        <>
          <p className="text-sm">
            تسوية {settlement.id} —{" "}
            {settlement.status === "REQUESTED"
              ? "بانتظار مراجع مستقل"
              : settlement.status === "APPROVED"
                ? "معتمدة وتنتظر الترحيل الفعلي"
                : "رحّلت الكميات؛ راجع حقوق الأصل قبل الإقفال"}
          </p>
          <p className="whitespace-pre-wrap text-sm">
            {settlement.reason} — {settlement.evidence}
          </p>
          {settlement.restoredValue != null && (
            <p className="text-sm">
              قيمة المخزون الصالح: {fmt(settlement.restoredValue)}
            </p>
          )}
          {settlement.status === "POSTED" && (
            <WorkflowPrintActions
              branchId={data.case.branchId}
              settlementId={settlement.id}
              mode="aftercare"
            />
          )}
          <div className="flex flex-wrap gap-2">
            {settlement.status === "REQUESTED" &&
              canApprove &&
              settlement.createdBy !== me.data?.id && (
                <SubmitButton
                  type="button"
                  pending={pending}
                  onClick={() =>
                    void execute(
                      "approveSettlement",
                      {
                        id: settlement.id,
                        expectedVersion: settlement.version,
                      },
                      approve.mutateAsync,
                    )
                  }
                >
                  اعتماد مراجعة الكميات والحقوق
                </SubmitButton>
              )}
            {settlement.status === "APPROVED" &&
              canPost &&
              settlement.createdBy !== me.data?.id && (
                <SubmitButton
                  type="button"
                  pending={pending}
                  onClick={async () => {
                    const settleWin = preopenDocumentWindow("width=420,height=760");
                    const out = await execute(
                      "settlementPost",
                      {
                        id: settlement.id,
                        expectedVersion: settlement.version,
                      },
                      post.mutateAsync,
                    );
                    if (out) {
                      void workflowPrinter.printAftercareSettlement(
                        settlement.id,
                        settleWin,
                        data.case.branchId,
                      );
                    } else {
                      try { settleWin?.close(); } catch { /* ignore */ }
                    }
                  }}
                >
                  ترحيل الاستلام والتسوية الفعليين
                </SubmitButton>
              )}
          </div>
          {settlement.status !== "POSTED" &&
            canWithdraw &&
            (settlement.createdBy === me.data?.id ||
              settlement.approvedBy === me.data?.id) && (
              <div className="space-y-2">
                <Label>
                  سبب سحب التسوية للتصحيح
                  <Textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </Label>
                <SubmitButton
                  type="button"
                  variant="outline"
                  pending={pending}
                  disabled={reason.trim().length < 3}
                  onClick={() =>
                    void execute(
                      "settlementWithdraw",
                      {
                        id: settlement.id,
                        expectedVersion: settlement.version,
                        reason,
                      },
                      withdraw.mutateAsync,
                    )
                  }
                >
                  سحب قبل الترحيل مع حفظ الدليل
                </SubmitButton>
              </div>
            )}
          {settlement.createdBy === me.data?.id &&
            settlement.status !== "POSTED" && (
              <p className="text-sm text-muted-foreground">
                يلزم موظف آخر لمراجعة التسوية وترحيلها.
              </p>
            )}
          {settlement.status === "POSTED" &&
            settlement.sourceRights.length > 0 && (
              <AftercareOriginalRights
                settlementId={settlement.id}
                onChange={onChange}
              />
            )}
        </>
      ) : (
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(!open)}
          >
            تسوية حالة متوقفة
          </Button>
          {open && (
            <>
              <Label>
                سبب الإيقاف
                <Textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Label>
              <Label>
                محضر الاستلام والفحص وموافقة معالجة الحقوق
                <Textarea
                  value={evidence}
                  onChange={(event) => setEvidence(event.target.value)}
                />
              </Label>
              <Label className="flex items-center gap-2">
                <Checkbox
                  checked={held}
                  onCheckedChange={(value) => setHeld(value === true)}
                />
                فحصت العهدة فعلياً وحددت الصالح والمستهلك والتالف؛ لا توجد عهدة
                لدى الناقل
              </Label>
              {lines.map((line, index) => {
                const decision = payload.decisions[index];
                const value = values[line.id] ?? {
                  usable: String(decision.usableBaseQuantity),
                  consumed: String(decision.consumedBaseQuantity),
                  damaged: String(decision.damagedBaseQuantity),
                };
                return (
                  <div key={line.id} className="space-y-2 rounded border p-3">
                    <p className="text-sm">
                      دفعة {line.executionId} — {line.productName} —{" "}
                      {line.kind === "MATERIAL" ? "خامة أصلية" : "مخرج"} —
                      الكمية {line.baseQuantity - line.deliveredBaseQuantity}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Label>
                        صالح مفحوص
                        <MoneyInput
                          decimals={0}
                          value={value.usable}
                          onChange={(usable) =>
                            setValues((previous) => ({
                              ...previous,
                              [line.id]: { ...value, usable },
                            }))
                          }
                        />
                      </Label>
                      <Label>
                        مستهلك
                        <MoneyInput
                          decimals={0}
                          value={value.consumed}
                          onChange={(consumed) =>
                            setValues((previous) => ({
                              ...previous,
                              [line.id]: { ...value, consumed },
                            }))
                          }
                        />
                      </Label>
                      <Label>
                        تالف
                        <MoneyInput
                          decimals={0}
                          value={value.damaged}
                          onChange={(damaged) =>
                            setValues((previous) => ({
                              ...previous,
                              [line.id]: { ...value, damaged },
                            }))
                          }
                        />
                      </Label>
                    </div>
                  </div>
                );
              })}
              {originalHeld.map((line, index) => {
                const right = payload.sourceRights[index];
                const update = (patch: Partial<Right>) =>
                  setRights((previous) => ({
                    ...previous,
                    [line.id]: { ...previous[line.id], ...patch },
                  }));
                return (
                  <div key={line.id} className="space-y-2 rounded border p-3">
                    <p className="font-medium">
                      حق المبيع الأصلي — {line.productName} ×{" "}
                      {right.baseQuantity}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      القطعة مملوكة للعميل. يلزم مرتجع حق مرتبط بهذا المكوّن
                      ورافد الرد الأصلي بعد اعتماد هذه التسوية. لا تعتمد تكلفة
                      اليوم أو تقديراً؛ أرفق مستند التكلفة التاريخي.
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Label>
                        كمية أصل صالحة
                        <MoneyInput
                          decimals={0}
                          value={String(right.usableBaseQuantity)}
                          onChange={(value) =>
                            update({ usableBaseQuantity: Number(value) })
                          }
                        />
                      </Label>
                      <Label>
                        كمية أصل تالفة
                        <MoneyInput
                          decimals={0}
                          value={String(right.damagedBaseQuantity)}
                          onChange={(value) =>
                            update({ damagedBaseQuantity: Number(value) })
                          }
                        />
                      </Label>
                      <Label>
                        قيمة حق العميل من مستند البيع
                        <MoneyInput
                          value={right.commercialAmount}
                          onChange={(commercialAmount) =>
                            update({ commercialAmount })
                          }
                        />
                      </Label>
                      <Label>
                        قيمة الصرف الأصلية الموثقة
                        <MoneyInput
                          value={right.originalIssueValue}
                          onChange={(originalIssueValue) =>
                            update({ originalIssueValue })
                          }
                        />
                      </Label>
                    </div>
                    <Label>
                      مرجع مستند التكلفة التاريخية
                      <Input
                        value={right.costEvidenceReference}
                        onChange={(event) =>
                          update({ costEvidenceReference: event.target.value })
                        }
                      />
                    </Label>
                    <Label>
                      دليل ربط القيمة التاريخية بالمكوّن والحركة
                      <Textarea
                        value={right.costEvidence}
                        onChange={(event) =>
                          update({ costEvidence: event.target.value })
                        }
                      />
                    </Label>
                  </div>
                );
              })}
              <Button
                type="button"
                variant="outline"
                disabled={
                  !held ||
                  reason.trim().length < 3 ||
                  evidence.trim().length < 3 ||
                  preview.isFetching
                }
                onClick={() => void preview.refetch()}
              >
                معاينة الأثر قبل طلب المراجعة
              </Button>
              {preview.error && (
                <p role="alert" className="text-sm text-destructive">
                  {preview.error.message}
                </p>
              )}
              {preview.data && (
                <div className="space-y-2 rounded border p-3">
                  <p className="text-sm">
                    المعاينة تحسم {preview.data.lines.length} سطراً، وتبقي{" "}
                    {preview.data.sourceRights.length} حقاً مرتبطاً بالأصل إلى
                    حين تنفيذ مرتجعه ورد مبلغه فعلياً.
                    {preview.data.restoredValue != null
                      ? ` قيمة الصالح ${fmt(preview.data.restoredValue)}.`
                      : ""}
                  </p>
                  <SubmitButton
                    type="button"
                    pending={pending}
                    onClick={() =>
                      void execute(
                        "settlementRequest",
                        { ...payload, previewHash: preview.data!.previewHash },
                        request.mutateAsync,
                      )
                    }
                  >
                    طلب اعتماد مستقل لهذه المعاينة
                  </SubmitButton>
                </div>
              )}
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function AftercareOriginalRights({
  settlementId,
  onChange,
}: {
  settlementId: number;
  onChange: () => Promise<void>;
}) {
  const me = trpc.auth.me.useQuery();
  const query = trpc.delivery.fulfillment.aftercare.rightsPreview.useQuery({
    settlementId,
  });
  const post = trpc.delivery.fulfillment.aftercare.rightsPost.useMutation();
  const confirmRefund =
    trpc.delivery.fulfillment.aftercare.rightsConfirmRefund.useMutation();
  const approveRefund = trpc.vouchers.approve.useMutation();
  const canPost = useOperationPermission(
    "delivery.fulfillment.aftercare.rightsPost",
  ).allowed;
  const canConfirmRefund = useOperationPermission(
    "delivery.fulfillment.aftercare.rightsConfirmRefund",
  ).allowed;
  const [rightIndex, setRightIndex] = useState("");
  const [drafts, setDrafts] = useState<
    Record<
      string,
      {
        amount: string;
        reference: string;
        shiftId: string;
        pendingExternal: boolean;
      }
    >
  >({});
  const [proofs, setProofs] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const keys = useRef(new Map<string, string>());
  const selected = query.data?.rights.find(
    (right) => right.rightIndex === Number(rightIndex),
  );
  const rails =
    query.data?.originalRefundMethods.filter(
      (rail) => rail.method !== "CHECK",
    ) ?? [];
  const change = (method: string, patch: Partial<(typeof drafts)[string]>) =>
    setDrafts((previous) => ({
      ...previous,
      [method]: {
        ...(previous[method] ?? {
          amount: "",
          reference: "",
          shiftId: "",
          pendingExternal: false,
        }),
        ...patch,
      },
    }));
  async function refresh() {
    await query.refetch();
    await onChange();
  }
  return (
    <div className="space-y-3 rounded border p-3">
      <p className="font-medium">
        تنفيذ مرتجع حق الأصل ورد المبلغ على روافده الأصلية
      </p>
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error.message}
        </p>
      )}
      {query.data?.rights.map((right) => (
        <div key={right.rightIndex} className="space-y-2 border-b pb-2">
          <p className="text-sm">
            حق الصنف {right.componentVariantId} × {right.baseQuantity} —{" "}
            {fmt(right.commercialAmount)} —{" "}
            {right.executed ? "نُفذ مرتجع الحق" : "بانتظار تنفيذ الحق"}
          </p>
          {right.refunds.map((refund) => (
            <div
              key={refund.receiptId}
              className="space-y-2 rounded border p-2"
            >
              <p className="text-sm">
                سند {refund.voucherNumber ?? refund.receiptId} —{" "}
                {paymentMethodCompact(refund.method)} — {fmt(refund.amount)} —{" "}
                {refund.status === "COMPLETED" ? "رد منفذ" : "الرد لم ينفذ بعد"}
              </p>
              {refund.status === "PENDING" && (
                <>
                  {refund.method !== "CASH" && (
                    <Label>
                      مرجع الرد الفعلي على الرافد الأصلي
                      <Input
                        value={proofs[refund.receiptId] ?? ""}
                        onChange={(event) =>
                          setProofs((previous) => ({
                            ...previous,
                            [refund.receiptId]: event.target.value,
                          }))
                        }
                      />
                    </Label>
                  )}
                  {canConfirmRefund && refund.method !== "CASH" && (
                    <SubmitButton
                      type="button"
                      variant="outline"
                      pending={confirmRefund.isPending}
                      disabled={
                        (proofs[refund.receiptId] ?? "").trim().length < 3
                      }
                      onClick={async () => {
                        const payload = {
                          receiptId: refund.receiptId,
                          reference: proofs[refund.receiptId],
                        };
                        const fingerprint = JSON.stringify(payload);
                        const key =
                          keys.current.get(fingerprint) ?? crypto.randomUUID();
                        keys.current.set(fingerprint, key);
                        const rfdWin = preopenDocumentWindow("width=420,height=760");
                        try {
                          await confirmRefund.mutateAsync({
                            ...payload,
                            clientRequestId: key,
                          });
                          keys.current.delete(fingerprint);
                          void printOverageRefundReceipt(
                            {
                              refundNumber: refund.voucherNumber ?? `RFD-${refund.receiptId}`,
                              sourceRef: `تسوية معالجة #${settlementId}`,
                              beneficiaryRole: "CUSTOMER",
                              amount: refund.amount,
                              paymentMethod: refund.method,
                              cashierName: me.data?.name ?? null,
                              notes: `إثبات رد على الرافد الأصلي — مرجع: ${payload.reference}`,
                            },
                            { into: rfdWin },
                          ).catch(() => {});
                          await refresh();
                        } catch (cause) {
                          try { rfdWin?.close(); } catch { /* ignore */ }
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : "تعذر إثبات الرد الفعلي",
                          );
                        }
                      }}
                    >
                      تثبيت الرد المنفذ من إثباته
                    </SubmitButton>
                  )}
                  {refund.method === "CASH" && me.data?.isOwner && (
                    <SubmitButton
                      type="button"
                      variant="outline"
                      pending={approveRefund.isPending}
                      onClick={async () => {
                        if (
                          !(await confirm({
                            title: "تنفيذ سند الرد الأصلي",
                            description:
                              "تحقق من خروج المبلغ فعلياً من مصدره المعتمد قبل إثبات الصرف؛ لا يغلق حق العميل بمجرد الموافقة.",
                            variant: "warning",
                          }))
                        )
                          return;
                        const rfdWin = preopenDocumentWindow("width=420,height=760");
                        try {
                          await approveRefund.mutateAsync({
                            receiptId: refund.receiptId,
                          });
                          void printOverageRefundReceipt(
                            {
                              refundNumber: refund.voucherNumber ?? `RFD-${refund.receiptId}`,
                              sourceRef: `تسوية معالجة #${settlementId}`,
                              beneficiaryRole: "CUSTOMER",
                              amount: refund.amount,
                              paymentMethod: refund.method,
                              cashierName: me.data?.name ?? null,
                              notes: "تنفيذ سند رد حق الأصل",
                            },
                            { into: rfdWin },
                          ).catch(() => {});
                          await refresh();
                        } catch (cause) {
                          try { rfdWin?.close(); } catch { /* ignore */ }
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : "تعذر تنفيذ سند الرد",
                          );
                        }
                      }}
                    >
                      تنفيذ سند الرد من المحطة
                    </SubmitButton>
                  )}
                  {!canConfirmRefund && (
                    <p className="text-sm text-muted-foreground">
                      ينتظر إثبات الرد من موظف مخول. تبقى الحالة مفتوحة حتى الرد
                      الفعلي.
                    </p>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void refresh()}
      >
        تحديث حقوق الأصل وسندات الرد
      </Button>
      {canPost && (
        <>
          <Label>
            الحق المعتمد
            <AppSelect
              value={rightIndex}
              onValueChange={(value) => {
                setRightIndex(value);
                setDrafts({});
              }}
            >
              <option value="">اختر الحق</option>
              {query.data?.rights
                .filter((right) => !right.executed)
                .map((right) => (
                  <option
                    key={right.rightIndex}
                    value={String(right.rightIndex)}
                  >
                    الصنف {right.componentVariantId} × {right.baseQuantity} —{" "}
                    {fmt(right.commercialAmount)}
                  </option>
                ))}
            </AppSelect>
          </Label>
          {rightIndex !== "" && selected && (
            <>
              <p className="text-sm">
                الرد المطلوب حالياً من الخادم:{" "}
                {fmt(selected.requiredRefundAmount)}. وزعه على روافد القبض
                الأصلية أدناه؛ لا ينشأ مرتجع ثانٍ عند تأخر التنفيذ الخارجي.
              </p>
              {rails.map((rail) => {
                const draft = drafts[rail.method] ?? {
                  amount: "",
                  reference: "",
                  shiftId: "",
                  pendingExternal: false,
                };
                return (
                  <div
                    key={rail.method}
                    className="space-y-2 rounded border p-2"
                  >
                    <p className="font-medium">
                      {paymentMethodCompact(rail.method)} — المتاح من الأصل{" "}
                      {fmt(rail.amount)}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Label>
                        المبلغ من هذا الرافد
                        <MoneyInput
                          value={draft.amount}
                          onChange={(amount) => change(rail.method, { amount })}
                        />
                      </Label>
                      {rail.method === "CASH" ? (
                        <Label>
                          رقم الدرج المفتوح عند الحاجة
                          <MoneyInput
                            decimals={0}
                            value={draft.shiftId}
                            onChange={(shiftId) =>
                              change(rail.method, { shiftId })
                            }
                          />
                        </Label>
                      ) : (
                        <Label>
                          مرجع الرد الفعلي
                          <Input
                            value={draft.reference}
                            onChange={(event) =>
                              change(rail.method, {
                                reference: event.target.value,
                              })
                            }
                          />
                        </Label>
                      )}
                    </div>
                    {rail.method !== "CASH" && (
                      <Label className="flex items-center gap-2">
                        <Checkbox
                          checked={draft.pendingExternal}
                          onCheckedChange={(value) =>
                            change(rail.method, {
                              pendingExternal: value === true,
                            })
                          }
                        />
                        الرد الخارجي لم يُنفذ بعد؛ إبقاء سند الرد معلّقاً وحق
                        العميل مفتوحاً
                      </Label>
                    )}
                  </div>
                );
              })}
              <SubmitButton
                type="button"
                pending={post.isPending}
                onClick={async () => {
                  setError("");
                  const refunds = rails.flatMap((rail) => {
                    const draft = drafts[rail.method];
                    return draft?.amount && D(draft.amount).gt(0)
                      ? [
                          {
                            amount: draft.amount,
                            method: rail.method,
                            shiftId: draft.shiftId
                              ? Number(draft.shiftId)
                              : undefined,
                            reference: draft.reference || undefined,
                            pendingExternal: draft.pendingExternal,
                          },
                        ]
                      : [];
                  });
                  const payload = {
                    settlementId,
                    rightIndex: Number(rightIndex),
                    refunds: refunds.length ? refunds : undefined,
                  };
                  const fingerprint = JSON.stringify(payload);
                  const key =
                    keys.current.get(fingerprint) ?? crypto.randomUUID();
                  keys.current.set(fingerprint, key);
                  const rfdWin = refunds.length
                    ? preopenDocumentWindow("width=420,height=760")
                    : null;
                  try {
                    await post.mutateAsync({
                      ...payload,
                      clientRequestId: key,
                    });
                    keys.current.delete(fingerprint);
                    if (refunds.length) {
                      const totalRefunded = refunds
                        .reduce((acc, r) => acc.plus(D(r.amount)), D(0))
                        .toFixed(2);
                      void printOverageRefundReceipt(
                        {
                          sourceRef: `تسوية معالجة #${settlementId} — حق #${rightIndex}`,
                          beneficiaryRole: "CUSTOMER",
                          amount: totalRefunded,
                          paymentMethod:
                            refunds.length === 1 ? refunds[0].method : "متعدد",
                          cashierName: me.data?.name ?? null,
                          notes: "تنفيذ مرتجع حق الأصل وتثبيت روافد الرد",
                        },
                        { into: rfdWin },
                      ).catch(() => {});
                    }
                    await refresh();
                  } catch (cause) {
                    try { rfdWin?.close(); } catch { /* ignore */ }
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "تعذر تنفيذ حق الأصل؛ راجع الأدلة والسندات",
                    );
                  }
                }}
              >
                تنفيذ الحق وتثبيت روافد الرد مرة واحدة
              </SubmitButton>
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
