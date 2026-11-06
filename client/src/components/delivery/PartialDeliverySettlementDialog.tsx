import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { MoneyInput } from "@/components/form/MoneyInput";
import { invalidateFinancialQueries } from "@/lib/realtime/financialQueries";
import { fmt, D } from "@/lib/money";
import { shiftTypeLabel } from "@/lib/labels";
import { notify } from "@/lib/notify";

export default function PartialDeliverySettlementDialog({
  consignmentId,
  onClose,
  targetShiftId,
  onCompleted,
}: {
  consignmentId: number;
  onClose: () => void;
  targetShiftId?: number;
  onCompleted?: () => void;
}) {
  const preview = trpc.delivery.workflow.previewPartialOutcome.useQuery(
    { consignmentId },
    { staleTime: 0 },
  );
  const data = preview.data;
  const shifts = trpc.shifts.list.useQuery(
    { branchId: data?.branchId, status: "OPEN" },
    { enabled: data?.branchId != null },
  );
  const [amount, setAmount] = useState("");
  const [shiftId, setShiftId] = useState(() =>
    targetShiftId == null ? "" : String(targetShiftId),
  );
  const [evidence, setEvidence] = useState("");
  const [witnessed, setWitnessed] = useState(false);
  const request = useRef({ key: crypto.randomUUID(), fingerprint: "" });
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const settle = trpc.delivery.workflow.settlePartialOutcome.useMutation({
    onSuccess: async (result) => {
      notify.ok(
        data?.cashAlreadyRecorded
          ? `صححت عهدة البنود وربط التوريد ${result.remittanceNumber}`
          : `ثبتت التسوية والتوريد ${result.remittanceNumber}`,
      );
      await Promise.all([
        utils.delivery.invalidate(),
        invalidateFinancialQueries(queryClient, data?.branchId),
      ]);
      onCompleted?.();
      onClose();
    },
    onError: (error) => notify.err(error),
  });
  const received = amount || data?.goodsAmount || "0";
  const invalid =
    !data?.allowed ||
    !witnessed ||
    (!data.cashAlreadyRecorded && !shiftId) ||
    (targetShiftId != null && shiftId !== String(targetShiftId)) ||
    evidence.trim().length < 5 ||
    !D(received).gt(0) ||
    D(received).gt(D(data?.goodsAmount ?? 0));
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !settle.isPending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl" dir="rtl">
        <DialogHeader>
          <DialogTitle>استكمال تسوية تسليم جزئي</DialogTitle>
        </DialogHeader>
        {preview.isError && (
          <p role="alert" className="text-sm text-destructive">
            {preview.error.message}
          </p>
        )}
        {data && (
          <div className="space-y-4 text-sm">
            <p>
              الفاتورة <b>{data.invoiceNumber}</b> —{" "}
              {data.cashAlreadyRecorded
                ? "التوريد المسجل المرتبط"
                : "المبلغ المتاح للتوريد"}{" "}
              <b dir="ltr">{fmt(data.goodsAmount)} د.ع</b>
            </p>
            {data.cashAlreadyRecorded && (
              <p className="rounded border p-3">
                سيرتبط التصحيح بالتوريد {data.existingRemittanceNumber} وإيصاله
                السابق؛ لا يدخل نقد جديد للصندوق.
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded border p-3">
                <b>البنود المسلمة للعميل</b>
                {data.deliveredLines.map((line) => (
                  <p key={line.invoiceItemId}>
                    {line.name} × {line.baseQuantity}
                  </p>
                ))}
              </div>
              <div className="rounded border p-3">
                <b>المرتجع المسجل</b>
                {data.returnedLines.map((line) => (
                  <p key={line.invoiceItemId}>
                    {line.name} × {line.baseQuantity}
                  </p>
                ))}
              </div>
            </div>
            <p className="text-muted-foreground">
              أجرة التوصيل: {fmt(data.feeAmount)} د.ع
              {data.feeCollection === "COURIER"
                ? " — يقبضها المندوب من العميل وتبقى خارج نقد المكتبة."
                : " — تبقى وفق مستند الأجرة الأصلي."}
            </p>
            {!data.allowed && (
              <p role="alert" className="rounded border p-3 text-destructive">
                {data.blockedReason}
              </p>
            )}
            {data.allowed && (
              <div className="space-y-3">
                {!data.cashAlreadyRecorded && (
                  <label className="block space-y-1">
                    <span>الدرج الذي استلم النقد فعلياً</span>
                    <AppSelect
                      value={shiftId}
                      onValueChange={setShiftId}
                      disabled={settle.isPending || targetShiftId != null}
                      aria-label="درج استلام التوريد"
                    >
                      <option value="">حدد الدرج المستلم</option>
                      {shifts.data?.rows.map((shift) => (
                        <option key={shift.id} value={String(shift.id)}>
                          #{shift.id} — {shiftTypeLabel(shift.shiftType)}
                        </option>
                      ))}
                    </AppSelect>
                  </label>
                )}
                <label className="block space-y-1">
                  <span>النقد الذي سلمته الجهة للمكتبة</span>
                  <MoneyInput
                    ariaLabel="النقد المستلم فعلياً"
                    value={received}
                    onChange={setAmount}
                    disabled={settle.isPending || data.cashAlreadyRecorded}
                  />
                </label>
                <label className="block space-y-1">
                  <span>دليل تسليم الباقي وقبض العميل وتوريد المكتبة</span>
                  <Input
                    value={evidence}
                    onChange={(event) => setEvidence(event.target.value)}
                    maxLength={2000}
                    disabled={settle.isPending}
                  />
                </label>
                <label className="flex items-start gap-2">
                  <Checkbox
                    checked={witnessed}
                    onCheckedChange={(value) => setWitnessed(value === true)}
                    disabled={settle.isPending}
                  />
                  <span>
                    {data.cashAlreadyRecorded
                      ? "تحققت من البنود المسلمة والمرتجعة، ومن ارتباط التوريد والإيصال السابقين بهذه العملية."
                      : "تحققت من البنود المسلمة والمرتجعة، ومن النقد المستلم فعلياً وعدم تسجيله بإيصال آخر."}
                  </span>
                </label>
                <SubmitButton
                  type="button"
                  pending={settle.isPending}
                  disabled={invalid}
                  onClick={() => {
                    const payload = {
                      consignmentId,
                      expectedVersion: data.version,
                      targetShiftId: data.cashAlreadyRecorded
                        ? undefined
                        : (targetShiftId ?? Number(shiftId)),
                      cashReceivedAmount: D(received).toFixed(2),
                      evidence: evidence.trim(),
                    };
                    const fingerprint = JSON.stringify(payload);
                    if (
                      request.current.fingerprint &&
                      request.current.fingerprint !== fingerprint
                    )
                      request.current.key = crypto.randomUUID();
                    request.current.fingerprint = fingerprint;
                    settle.mutate({
                      ...payload,
                      clientRequestId: request.current.key,
                    });
                  }}
                >
                  {data.cashAlreadyRecorded
                    ? "تصحيح العهدة وربط التوريد السابق"
                    : "إثبات التسليم والقبض والتوريد"}
                </SubmitButton>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
