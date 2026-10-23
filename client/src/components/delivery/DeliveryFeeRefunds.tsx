import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { DataTable } from "@/components/data-table/DataTable";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { paymentMethodCompact } from "@shared/terms";
import { ExcessFeeRefundPanel } from "./ExcessFeeRefundPanel";

type Row =
  RouterOutputs["delivery"]["paymentRefunds"]["list"]["pending"][number];
/** Real pending receipts and provider execution, including original fee owners removed from a shipment. */
export function DeliveryPaymentRefunds({ branchId }: { branchId: number }) {
  const me = trpc.auth.me.useQuery(),
    q = trpc.delivery.paymentRefunds.list.useQuery({ branchId });
  const request = trpc.delivery.paymentRefunds.request.useMutation(),
    approve = trpc.delivery.paymentRefunds.approve.useMutation();
  const approveWorkOrder =
    trpc.workOrders.approveCancellationRefund.useMutation();
  const [selected, setSelected] = useState(""),
    [reason, setReason] = useState(""),
    [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [references, setReferences] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const owner = me.data?.isOwner === true;
  async function requestRefund() {
    setError(null);
    try {
      await request.mutateAsync({
        branchId,
        consignmentId: Number(selected),
        reason,
        clientRequestId: requestId,
      });
      setRequestId(crypto.randomUUID());
      setReason("");
      await q.refetch();
      notify.ok("سُجل طلب رد أجرة التوصيل");
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر طلب رد الأجرة");
    }
  }
  async function execute(row: Row) {
    setError(null);
    try {
      if (row.workOrderId != null)
        await approveWorkOrder.mutateAsync({
          receiptId: row.id,
          confirmationReference: references[row.id] ?? "",
        });
      else
        await approve.mutateAsync({
          branchId,
          receiptId: row.id,
          providerReference: references[row.id] ?? "",
          clientRequestId: `refund-${row.id}`,
        });
      await q.refetch();
      notify.ok("ثُبت تنفيذ الاسترداد الخارجي");
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر اعتماد الاسترداد");
    }
  }
  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      { accessorKey: "id", header: "الإيصال" },
      { accessorKey: "invoiceId", header: "الفاتورة" },
      {
        id: "kind",
        header: "الغرض",
        cell: ({ row }) =>
          row.original.kind === "FEE" ? "أمانة الأجرة" : "البضاعة",
      },
      {
        accessorKey: "amount",
        header: "المبلغ",
        cell: ({ row }) => (
          <span dir="ltr">{fmt(row.original.amount)} د.ع</span>
        ),
      },
      {
        id: "method",
        header: "وسيلة الرد",
        cell: ({ row }) => paymentMethodCompact(row.original.method),
      },
      {
        id: "status",
        header: "حالة الصرف",
        cell: ({ row }) =>
          row.original.status === "COMPLETED"
            ? "منفذ"
            : "بانتظار التنفيذ الخارجي",
      },
      {
        id: "execute",
        header: "إثبات المزوّد",
        cell: ({ row }) =>
          row.original.status === "COMPLETED" ? (
            <span dir="ltr">{row.original.providerReference}</span>
          ) : owner ? (
            <div className="flex flex-wrap gap-2">
              <Input
                aria-label={`مرجع استرداد الإيصال ${row.original.id}`}
                value={references[row.original.id] ?? ""}
                onChange={(e) =>
                  setReferences((old) => ({
                    ...old,
                    [row.original.id]: e.target.value,
                  }))
                }
                placeholder="مرجع نجاح الاسترداد الفعلي"
                dir="ltr"
              />
              <Button
                size="sm"
                disabled={
                  approve.isPending ||
                  approveWorkOrder.isPending ||
                  (references[row.original.id] ?? "").trim().length < 3
                }
                onClick={() => void execute(row.original)}
              >
                اعتماد التنفيذ
              </Button>
            </div>
          ) : (
            "يعتمده المالك بعد نجاح الاسترداد"
          ),
      },
    ],
    [owner, references, approve.isPending, approveWorkOrder.isPending],
  );
  return (
    <section className="space-y-3" dir="rtl">
      <div className="rounded border p-3 text-sm">
        <h2 className="font-bold">رد مقبوضات التوصيل</h2>
        <p className="text-muted-foreground">
          أجور الأمانة منفصلة عن البضاعة. غير النقد يبقى طلباً معلقاً حتى تثبيت
          نجاح الاسترداد لدى المزوّد؛ لا يخرج نقد من الدرج.
        </p>
      </div>
      <ExcessFeeRefundPanel
        key={branchId}
        branchId={branchId}
        onChanged={() => q.refetch()}
      />
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <AppSelect
          aria-label="إرسالية رد أجرة التوصيل"
          value={selected}
          onValueChange={(value) => {
            setSelected(value);
            setRequestId(crypto.randomUUID());
          }}
        >
          <option value="">اختر الإرسالية المرتجعة</option>
          {q.data?.candidates.map((c) => (
            <option key={c.consignmentId} value={String(c.consignmentId)}>
              {c.consignmentNumber} — {c.invoiceNumber} — {fmt(c.fee)} د.ع
            </option>
          ))}
        </AppSelect>
        <Input
          aria-label="سبب رد الأجرة"
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setRequestId(crypto.randomUUID());
          }}
          placeholder="سبب رد أمانة الأجرة بعد رجوع البضاعة"
        />
        <Button
          variant="outline"
          disabled={!selected || reason.trim().length < 3 || request.isPending}
          onClick={() => void requestRefund()}
        >
          طلب رد الأجرة الأصلية
        </Button>
      </div>
      {(error || q.error) && (
        <p role="alert" className="text-destructive">
          {error ?? q.error?.message}
        </p>
      )}
      <DataTable
        columns={columns}
        data={q.data?.pending ?? []}
        loading={q.isLoading}
      />
      <p className="text-xs text-muted-foreground">
        تُعرض آخر 100 إيصال و100 إرسالية في الفرع. طلب الأجرة يعيد التحقق من
        جميع أعضاء الشحنة ولا يرد مبلغاً سُدد للناقل.
      </p>
    </section>
  );
}
