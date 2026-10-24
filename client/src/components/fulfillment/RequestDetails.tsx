import { useEffect, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { DataTable } from "@/components/data-table/DataTable";
import { LiveValue } from "@/components/financial/LiveValue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { Checkbox } from "@/components/ui/checkbox";
import { MoneyInput } from "@/components/form/MoneyInput";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { newClientRequestId } from "@/lib/countQueue";
import { confirm } from "@/lib/confirm";
import { deliveryDriverOptions, requiresDeliveryDriver } from "@/components/delivery/driverOptions";
import {
  fulfillmentRequestStatusLabel,
  fulfillmentChargeCategoryLabel,
} from "@shared/fulfillment";

type Detail = RouterOutputs["delivery"]["fulfillment"]["requests"]["get"];
type Item = Detail["items"][number];
type Inputs = RouterInputs["delivery"]["fulfillment"]["requests"];
type RequestAction = {
  [K in "ready" | "release" | "cancel" | "reassign"]: {
    kind: K;
    input: Inputs[K];
  };
}["ready" | "release" | "cancel" | "reassign"];
const definitiveErrors = new Set([
  "BAD_REQUEST",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
]);
export function RequestDetails({
  detail,
  actorId,
  embedded = false,
  allowed,
  onChanged,
  onEdit,
  onPrintConsignment,
}: {
  detail: Detail;
  actorId?: number;
  embedded?: boolean;
  allowed: (action: string) => boolean;
  onChanged: () => void;
  onEdit: () => void;
  onPrintConsignment?: (consignmentId: number) => void;
}) {
  const { request } = detail;
  const editable = ["DRAFT", "PREPARING", "READY"].includes(request.status);
  const canRelease = editable || request.status === "PARTIALLY_RELEASED";
  const [selected, setSelected] = useState<number[]>([]);
  const [partial, setPartial] = useState(false);
  const [decision, setDecision] = useState(request.futureFeeDecision ?? "");
  const [fee, setFee] = useState("");
  const [rail, setRail] = useState<"COURIER" | "COUNTER" | "SHOP">("COURIER");
  const [tracking, setTracking] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(newClientRequestId);
  const [driverId, setDriverId] = useState("");
  const [reassignPartyId, setReassignPartyId] = useState("");
  const [reassignDriverId, setReassignDriverId] = useState("");
  const [reassignTracking, setReassignTracking] = useState("");
  const [confirming, setConfirming] = useState(false);
  const mounted = useRef(true);
  const replayKey = actorId
    ? `fulfillment-request-action:v1:${actorId}:${request.branchId}:${request.id}`
    : null;
  const [pendingAction, setPendingAction] = useState<RequestAction | null>(
    () => {
      try {
        const saved = replayKey
          ? (JSON.parse(
              sessionStorage.getItem(replayKey) ?? "null",
            ) as RequestAction | null)
          : null;
        return saved &&
          ["ready", "release", "cancel", "reassign"].includes(saved.kind) &&
          saved.input?.id === request.id &&
          typeof saved.input.clientRequestId === "string"
          ? saved
          : null;
      } catch {
        return null;
      }
    },
  );
  const pendingRef = useRef(pendingAction);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const remember = (action: RequestAction | null) => {
    pendingRef.current = action;
    if (mounted.current) setPendingAction(action);
    try {
      if (replayKey) {
        if (action) sessionStorage.setItem(replayKey, JSON.stringify(action));
        else sessionStorage.removeItem(replayKey);
      }
    } catch {
      /* Native idempotency key remains stable in the mounted context. */
    }
  };
  const parties = trpc.delivery.listParties.useQuery({ activeOnly: true });
  const party = parties.data?.find((row) => row.id === request.partyId);
  const reassignParty = parties.data?.find(
    (row) => String(row.id) === reassignPartyId,
  );
  const drivers = deliveryDriverOptions(party, request.branchId);
  const reassignDrivers = deliveryDriverOptions(reassignParty, request.branchId);
  const needsDriver = requiresDeliveryDriver(party);
  const needsReassignDriver = requiresDeliveryDriver(reassignParty);
  useEffect(() => {
    if (pendingRef.current) return;
    setSelected(detail.remainingItems.filter((r) => r.ready).map((r) => r.id));
    setPartial(false);
    setKey(newClientRequestId());
  }, [request.id, request.version]);
  const success = () => {
    remember(null);
    if (!mounted.current) return;
    setKey(newClientRequestId());
    notify.ok("تم تحديث طلب التوصيل");
    onChanged();
  };
  const failure = (error: unknown) => {
    const code = (error as { data?: { code?: string } } | null)?.data?.code;
    if (code && definitiveErrors.has(code)) remember(null);
    if (mounted.current) notify.err(error);
  };
  const ready = trpc.delivery.fulfillment.requests.ready.useMutation({
    onSuccess: success,
    onError: failure,
  });
  const cancel = trpc.delivery.fulfillment.requests.cancel.useMutation({
    onSuccess: success,
    onError: failure,
  });
  const release = trpc.delivery.fulfillment.requests.release.useMutation({
    onSuccess: success,
    onError: failure,
  });
  const reassign = trpc.delivery.fulfillment.requests.reassign.useMutation({
    onSuccess: success,
    onError: failure,
  });
  const mutating =
    ready.isPending ||
    cancel.isPending ||
    release.isPending ||
    reassign.isPending;
  const busy = mutating || confirming || pendingAction != null;
  const run = (action: RequestAction) => {
    if (action.kind === "ready") ready.mutate(action.input);
    else if (action.kind === "release") release.mutate(action.input);
    else if (action.kind === "cancel") cancel.mutate(action.input);
    else reassign.mutate(action.input);
  };
  const start = (action: RequestAction) => {
    if (pendingRef.current) return;
    remember(action);
    run(action);
  };
  const identity = {
    id: request.id,
    expectedVersion: request.version,
    clientRequestId: key,
  };
  const columns: ColumnDef<Item, unknown>[] = [
    {
      id: "selection",
      header: "إرسال",
      cell: ({ row }) =>
        row.original.status === "RELEASED" ? (
          "مرسل"
        ) : row.original.status === "CANCELLED" ? (
          "ملغى"
        ) : (
          <Checkbox
            aria-label={`إرسال ${row.original.number}`}
            checked={selected.includes(row.original.id)}
            disabled={!row.original.ready || !canRelease || busy}
            onCheckedChange={(v) => {
              setSelected((s) =>
                v
                  ? [...s, row.original.id]
                  : s.filter((id) => id !== row.original.id),
              );
              setKey(newClientRequestId());
            }}
          />
        ),
    },
    {
      accessorKey: "number",
      header: "المستند",
      cell: ({ row }) => (
        <div>
          <a
            className="underline"
            href={
              row.original.invoiceId != null
                ? `/invoices/${row.original.invoiceId}`
                : `/work-orders/${row.original.workOrderId}`
            }
          >
            {row.original.number}
          </a>
          <div className="text-xs text-muted-foreground">
            {row.original.title}
          </div>
        </div>
      ),
    },
    {
      id: "physical",
      header: "التجهيز",
      cell: ({ row }) =>
        row.original.status === "RELEASED"
          ? "مرسل"
          : row.original.ready
            ? "جاهز"
            : "غير جاهز",
    },
    { accessorKey: "sourceStatus", header: "حالة المصدر" },
    {
      accessorKey: "total",
      header: "القيمة الحالية",
      cell: ({ row }) => fmtAr(row.original.total),
    },
    {
      accessorKey: "paidAmount",
      header: "المدفوع",
      cell: ({ row }) => fmtAr(row.original.paidAmount),
    },
    {
      accessorKey: "remainingAmount",
      header: "المتبقي",
      cell: ({ row }) => (
        <span>
          {fmtAr(row.original.remainingAmount)}
          {row.original.paymentMode === "CREDIT" ? " · ذمة معتمدة" : ""}
        </span>
      ),
    },
  ];
  const blockedReasons = [
    !request.partyId ? "حدد جهة التوصيل من تعديل الطلب قبل الإرسال" : null,
    parties.isPending ? "انتظر اكتمال بيانات جهة التوصيل" : null,
    parties.error?.message ?? null,
    request.partyId && !party && !parties.isPending && !parties.isError
      ? "جهة التوصيل غير نشطة أو غير متاحة؛ عدّلها قبل الإرسال"
      : null,
    detail.items.length > 0 && !selected.length
      ? "اختر مستندات جاهزة للإرسال"
      : null,
    !partial && selected.length !== detail.remainingItems.length
      ? "توجد بنود غير جاهزة أو غير محددة؛ أكمل التجهيز أو فعّل الإرسال الجزئي المسموح"
      : null,
    partial && decision.trim().length < 3
      ? "حدد قرار أجرة البنود المتبقية للإرسال الجزئي"
      : null,
    request.status === "PARTIALLY_RELEASED" && !/^\d+(\.\d{1,2})?$/.test(fee)
      ? "حدد أجرة الدفعة اللاحقة صراحةً"
      : null,
    needsDriver && !driverId ? "اختر الموظف المندوب صراحةً" : null,
    parties.isPending || parties.isError
      ? "قائمة الموظفين المندوبين لم تكتمل؛ أعد تحميلها"
      : null,
    detail.items.length === 0 &&
    !detail.charges.some((charge) => charge.status === "APPROVED")
      ? "اعتمد أجوراً حقيقية للطلب الخالي من مستندات البيع قبل إرساله"
      : null,
  ].filter((reason): reason is string => reason != null);
  return (
    <section dir="rtl" className="space-y-4 rounded border p-4">
      {pendingAction && (
        <div role="status" className="space-y-2 rounded border p-3 text-sm">
          <p>
            لم تحسم نتيجة الإجراء بعد. أعد طلب النتيجة نفسها قبل تعديل الطلب أو
            بدء إرسال آخر.
          </p>
          <Button
            variant="outline"
            disabled={mutating || confirming}
            onClick={() => run(pendingAction)}
          >
            استعادة نتيجة الإجراء نفسه
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">
          {request.requestNumber} ·{" "}
          {fulfillmentRequestStatusLabel[request.status]}
        </h3>
        <div className="flex gap-2">
          {editable && allowed("update") && (
            <Button variant="outline" disabled={busy} onClick={onEdit}>
              تعديل
            </Button>
          )}
          {editable && allowed("ready") && (
            <SubmitButton
              type="button"
              variant="outline"
              pending={ready.isPending}
              disabled={busy}
              onClick={() => start({ kind: "ready", input: identity })}
            >
              فحص الجاهزية
            </SubmitButton>
          )}
        </div>
      </div>
      <p className="text-sm">
        {request.recipientName} · <bdi>{request.recipientPhone}</bdi> ·{" "}
        {request.deliveryAddress}
      </p>
      {!embedded && (
        <a
          className="inline-block text-sm underline"
          href={`/delivery?tab=fulfillment&kind=charges&requestId=${request.id}&branchId=${request.branchId}`}
        >
          إدارة الأجور الإضافية والتحصيل لهذا الطلب
        </a>
      )}
      <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div className="rounded border p-3">
          قيمة المستندات:{" "}
          <LiveValue value={detail.totals.goods} identity={request.id}>
            {fmtAr(detail.totals.goods)}
          </LiveValue>
        </div>
        <div className="rounded border p-3">
          متبقي الفواتير (يشمل الذمم المعتمدة):{" "}
          <LiveValue
            value={detail.totals.invoiceRemaining}
            identity={request.id}
          >
            {fmtAr(detail.totals.invoiceRemaining)}
          </LiveValue>
        </div>
        <div className="rounded border p-3">
          أجور إضافية مستحقة:{" "}
          <LiveValue
            value={detail.totals.chargeRemaining}
            identity={request.id}
          >
            {fmtAr(detail.totals.chargeRemaining)}
          </LiveValue>
        </div>
      </div>
      <DataTable columns={columns} data={detail.items} searchable={false} />
      <p className="text-sm text-muted-foreground">
        متبقي الفواتير القابل للتحصيل بالتوصيل قبل إضافة الأجور:{" "}
        <LiveValue
          value={detail.totals.invoiceCodRemaining}
          identity={request.id}
        >
          {fmtAr(detail.totals.invoiceCodRemaining)}
        </LiveValue>
      </p>
      {!!detail.charges.length && (
        <div className="space-y-2 text-sm">
          <h4 className="font-medium">
            الأجور المرتبطة · مستقلة عن قيمة الفواتير
          </h4>
          {detail.charges.map((c) => (
            <div
              key={c.id}
              className="flex flex-wrap justify-between gap-2 rounded border p-2"
            >
              <span>
                {fulfillmentChargeCategoryLabel[c.category]} · {c.description}
              </span>
              <span>
                قيمة {fmtAr(c.amount)} · متبقٍ {fmtAr(c.remainingAmount)}
              </span>
            </div>
          ))}
        </div>
      )}
      {!!detail.consignments.length && (
        <div className="space-y-2 text-sm">
          <h4 className="font-medium">الشحنة والعهدة</h4>
          {allowed("reassign") &&
            detail.consignments.some(
              (c) =>
                c.parcelStatus === "CANCELLED" ||
                (c.sourceType === "FULFILLMENT_REQUEST" &&
                  c.parcelStatus === "RETURNED"),
            ) && (
              <fieldset
                disabled={busy}
                className="grid grid-cols-1 gap-3 rounded border p-3 sm:grid-cols-2"
              >
                <label className="space-y-1">
                  جهة إعادة الإسناد
                  <AppSelect
                    value={reassignPartyId}
                    onValueChange={(value) => {
                      setReassignPartyId(value);
                      setReassignDriverId("");
                      setReassignTracking("");
                      setKey(newClientRequestId());
                    }}
                  >
                    <option value="">اختر الجهة صراحةً</option>
                    {(parties.data ?? [])
                      .filter(
                        (row) =>
                          row.branchId == null ||
                          row.branchId === request.branchId,
                      )
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                  </AppSelect>
                </label>
                {needsReassignDriver && (
                  <label className="space-y-1">
                    الموظف المندوب
                    <AppSelect
                      value={reassignDriverId}
                      onValueChange={(value) => {
                        setReassignDriverId(value);
                        setKey(newClientRequestId());
                      }}
                    >
                      <option value="">اختر الموظف المندوب</option>
                      {reassignDrivers.map((row) => (
                        <option key={row.userId} value={row.userId}>
                          {row.name}
                        </option>
                      ))}
                    </AppSelect>
                  </label>
                )}
                {reassignParty?.partyType === "COMPANY" && (
                  <label className="space-y-1">
                    بوليصة الجهة المختارة
                    <Input
                      value={reassignTracking}
                      onChange={(event) => {
                        setReassignTracking(event.target.value);
                        setKey(newClientRequestId());
                      }}
                    />
                  </label>
                )}
                {parties.error && (
                  <p role="alert" className="text-destructive">
                    {parties.error.message}
                  </p>
                )}
              </fieldset>
            )}
          {detail.consignments.map((c) => (
            <div key={c.id} className="rounded border p-2">
              {c.consignmentNumber} · {c.parcelStatus} · تحصيل{" "}
              {fmtAr(c.codAmount)} · أجرة {fmtAr(c.deliveryFee)} ·{" "}
              {c.moneyStatus}
              {onPrintConsignment && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="ms-2"
                  disabled={busy}
                  onClick={() => onPrintConsignment(c.id)}
                >
                  طباعة البوليصة
                </Button>
              )}
              {(c.parcelStatus === "CANCELLED" ||
                (c.sourceType === "FULFILLMENT_REQUEST" &&
                  c.parcelStatus === "RETURNED")) &&
                allowed("reassign") &&
                (detail.items.length === 0 ||
                  detail.items.some((item) => item.consignmentId === c.id)) && (
                  <SubmitButton
                    className="ms-2"
                    type="button"
                    variant="outline"
                    pending={reassign.isPending}
                    disabled={
                      busy ||
                      !reassignParty ||
                      (needsReassignDriver && !reassignDriverId) ||
                      (reassignParty.partyType === "INDIVIDUAL" &&
                        (parties.isPending || parties.isError)) ||
                      (reassignParty.partyType === "COMPANY" &&
                        reassignParty.id !== c.partyId &&
                        !reassignTracking.trim())
                    }
                    onClick={() =>
                      start({
                        kind: "reassign",
                        input: {
                          ...identity,
                          consignmentId: c.id,
                          partyId: Number(reassignPartyId),
                          assignedUserId: reassignDriverId
                            ? Number(reassignDriverId)
                            : undefined,
                          externalTrackingRef:
                            reassignTracking.trim() || undefined,
                        },
                      })
                    }
                  >
                    إعادة إسناد الدفعة بنفس الأجرة والمستندات
                  </SubmitButton>
                )}
            </div>
          ))}
        </div>
      )}
      {request.futureFeeDecision && (
        <p className="rounded border p-3 text-sm">
          قرار أجرة البنود المتبقية: {request.futureFeeDecision}
        </p>
      )}
      {canRelease && !allowed("release") && (
        <p role="status" className="text-sm text-muted-foreground">
          حسابك لا يملك صلاحية إرسال هذا الطلب؛ اطلب تنفيذ الإرسال من الموظف
          المخوّل.
        </p>
      )}
      {canRelease && allowed("release") && (
        <fieldset disabled={busy} className="space-y-3 border-t pt-3">
          <h4 className="font-medium">الإرسال إلى الناقل</h4>
          <p className="text-sm text-muted-foreground">
            المتبقي {detail.remainingItems.length} مستنداً؛ المحدد{" "}
            {selected.length}. أجرة الدفعة الأولى {fmtAr(request.deliveryFee)}.
            غير الجاهز يؤخر الإرسال الكامل.
          </p>
          <p className="text-sm">جهة التوصيل: {party?.name ?? "غير محددة"}</p>
          {needsDriver && (
            <label className="block space-y-1 text-sm">
              الموظف المندوب
              <AppSelect
                value={driverId}
                onValueChange={(value) => {
                  setDriverId(value);
                  setKey(newClientRequestId());
                }}
              >
                <option value="">اختر الموظف المندوب</option>
                {drivers.map((row) => (
                  <option key={row.userId} value={row.userId}>
                    {row.name}
                  </option>
                ))}
              </AppSelect>
            </label>
          )}
          {parties.error && (
            <p role="alert" className="text-destructive">
              {parties.error.message}
            </p>
          )}
          <label className="block space-y-1 text-sm">
            رقم التتبع الخارجي للشركة
            <Input
              value={tracking}
              onChange={(e) => {
                setTracking(e.target.value);
                setKey(newClientRequestId());
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={partial}
              disabled={!request.partialReleaseAllowed}
              onCheckedChange={(v) => {
                setPartial(v === true);
                setKey(newClientRequestId());
              }}
            />
            تأكيد إرسال البنود المحددة فقط مع إبقاء البقية بالطلب
          </label>
          {(partial || request.status === "PARTIALLY_RELEASED") && (
            <label className="block space-y-1 text-sm">
              قرار أجرة الإرسال القادم
              <Textarea
                value={decision}
                onChange={(e) => {
                  setDecision(e.target.value);
                  setKey(newClientRequestId());
                }}
              />
            </label>
          )}
          {request.status === "PARTIALLY_RELEASED" && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                أجرة هذه الدفعة صراحةً
                <MoneyInput
                  value={fee}
                  onChange={(v) => {
                    setFee(v);
                    setKey(newClientRequestId());
                  }}
                />
              </label>
              <label className="space-y-1 text-sm">
                تحمل أجرة هذه الدفعة
                <AppSelect
                  value={rail}
                  onValueChange={(v) => {
                    setRail(v as typeof rail);
                    setKey(newClientRequestId());
                  }}
                >
                  <option value="COURIER">الناقل يقبضها من المستلم</option>
                  <option value="COUNTER">مقبوضة بإيصال حقيقي</option>
                  <option value="SHOP">على المكتبة</option>
                </AppSelect>
              </label>
            </div>
          )}
          {blockedReasons.length > 0 && (
            <ul
              role="status"
              className="list-inside list-disc text-sm text-muted-foreground"
            >
              {blockedReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          <SubmitButton
            type="button"
            pending={release.isPending}
            disabled={busy || blockedReasons.length > 0}
            onClick={async () => {
              setConfirming(true);
              const accepted = await confirm({
                title: "تأكيد إرسال دفعة الطلب",
                description: `${request.requestNumber} · ${selected.length || "أجور فقط"} · ${party?.name ?? ""} · أجرة ${fmtAr(request.status === "PARTIALLY_RELEASED" ? fee : request.deliveryFee)}`,
                confirmText: "إرسال الشحنة",
                variant: "info",
              });
              if (!mounted.current) return;
              setConfirming(false);
              if (accepted)
                start({
                  kind: "release",
                  input: {
                    ...identity,
                    itemIds: selected.length ? selected : undefined,
                    partialReleaseConfirmed: partial,
                    futureFeeDecision: partial ? decision : undefined,
                    externalTrackingRef: tracking || undefined,
                    assignedUserId: driverId ? Number(driverId) : undefined,
                    subsequentDeliveryFee:
                      request.status === "PARTIALLY_RELEASED" ? fee : undefined,
                    subsequentFeeCollection:
                      request.status === "PARTIALLY_RELEASED"
                        ? rail
                        : undefined,
                  },
                });
            }}
          >
            إرسال شحنة واحدة للبنود المحددة
          </SubmitButton>
        </fieldset>
      )}
      {(editable ||
        (request.status === "PARTIALLY_RELEASED" &&
          detail.remainingItems.length > 0)) &&
        allowed("cancel") && (
          <fieldset disabled={busy} className="space-y-2 border-t pt-3">
            <label className="block space-y-1 text-sm">
              سبب إلغاء البنود التي لم ترسل
              <Textarea
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setKey(newClientRequestId());
                }}
              />
            </label>
            <SubmitButton
              type="button"
              variant="destructive"
              pending={cancel.isPending}
              disabled={busy || reason.trim().length < 3}
              onClick={() =>
                start({ kind: "cancel", input: { ...identity, reason } })
              }
            >
              إلغاء التجهيز المتبقي
            </SubmitButton>
          </fieldset>
        )}
    </section>
  );
}
