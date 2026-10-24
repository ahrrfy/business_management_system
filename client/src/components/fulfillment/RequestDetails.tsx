import { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
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
import {
  fulfillmentRequestStatusLabel,
  fulfillmentChargeCategoryLabel,
} from "@shared/fulfillment";

type Detail = RouterOutputs["delivery"]["fulfillment"]["requests"]["get"];
type Item = Detail["items"][number];
export function RequestDetails({
  detail,
  allowed,
  onChanged,
  onEdit,
}: {
  detail: Detail;
  allowed: (action: string) => boolean;
  onChanged: () => void;
  onEdit: () => void;
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
  useEffect(() => {
    setSelected(detail.remainingItems.filter((r) => r.ready).map((r) => r.id));
    setPartial(false);
    setKey(newClientRequestId());
  }, [request.id, request.version]);
  const success = () => {
    setKey(newClientRequestId());
    notify.ok("تم تحديث طلب التوصيل");
    onChanged();
  };
  const ready = trpc.delivery.fulfillment.requests.ready.useMutation({
    onSuccess: success,
    onError: (error) => {
      notify.err(error);
    },
  });
  const cancel = trpc.delivery.fulfillment.requests.cancel.useMutation({
    onSuccess: success,
    onError: (error) => {
      notify.err(error);
    },
  });
  const release = trpc.delivery.fulfillment.requests.release.useMutation({
    onSuccess: success,
    onError: (error) => {
      notify.err(error);
    },
  });
  const reassign = trpc.delivery.fulfillment.requests.reassign.useMutation({
    onSuccess: success,
    onError: (error) => {
      notify.err(error);
    },
  });
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
            disabled={!row.original.ready || !canRelease}
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
  return (
    <section dir="rtl" className="space-y-4 rounded border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">
          {request.requestNumber} ·{" "}
          {fulfillmentRequestStatusLabel[request.status]}
        </h3>
        <div className="flex gap-2">
          {editable && allowed("update") && (
            <Button variant="outline" onClick={onEdit}>
              تعديل
            </Button>
          )}
          {editable && allowed("ready") && (
            <SubmitButton
              type="button"
              variant="outline"
              pending={ready.isPending}
              onClick={() => ready.mutate(identity)}
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
      <a
        className="inline-block text-sm underline"
        href={`/delivery?tab=fulfillment&kind=charges&requestId=${request.id}&branchId=${request.branchId}`}
      >
        إدارة الأجور الإضافية والتحصيل لهذا الطلب
      </a>
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
          {detail.consignments.map((c) => (
            <div key={c.id} className="rounded border p-2">
              {c.consignmentNumber} · {c.parcelStatus} · تحصيل{" "}
              {fmtAr(c.codAmount)} · أجرة {fmtAr(c.deliveryFee)} ·{" "}
              {c.moneyStatus}
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
                    onClick={() =>
                      reassign.mutate({ ...identity, consignmentId: c.id })
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
      {canRelease && allowed("release") && (
        <div className="space-y-3 border-t pt-3">
          <h4 className="font-medium">الإرسال إلى الناقل</h4>
          <p className="text-sm text-muted-foreground">
            المتبقي {detail.remainingItems.length} مستنداً؛ المحدد{" "}
            {selected.length}. أجرة الدفعة الأولى {fmtAr(request.deliveryFee)}.
            غير الجاهز يؤخر الإرسال الكامل.
          </p>
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
          <SubmitButton
            type="button"
            pending={release.isPending}
            disabled={
              (!selected.length && detail.items.length > 0) ||
              (!partial && selected.length !== detail.remainingItems.length)
            }
            onClick={() =>
              release.mutate({
                ...identity,
                itemIds: selected.length ? selected : undefined,
                partialReleaseConfirmed: partial,
                futureFeeDecision: partial ? decision : undefined,
                externalTrackingRef: tracking || undefined,
                subsequentDeliveryFee:
                  request.status === "PARTIALLY_RELEASED" ? fee : undefined,
                subsequentFeeCollection:
                  request.status === "PARTIALLY_RELEASED" ? rail : undefined,
              })
            }
          >
            إرسال شحنة واحدة للبنود المحددة
          </SubmitButton>
        </div>
      )}
      {(editable ||
        (request.status === "PARTIALLY_RELEASED" &&
          detail.remainingItems.length > 0)) &&
        allowed("cancel") && (
          <div className="space-y-2 border-t pt-3">
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
              disabled={reason.trim().length < 3}
              onClick={() => cancel.mutate({ ...identity, reason })}
            >
              إلغاء التجهيز المتبقي
            </SubmitButton>
          </div>
        )}
    </section>
  );
}
