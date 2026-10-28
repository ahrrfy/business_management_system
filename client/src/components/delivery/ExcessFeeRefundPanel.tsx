import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  ManagerApprovalDialog,
  type ManagerApprovalInput,
} from "@/components/reception/ManagerApprovalDialog";
import { fmt } from "@/lib/money";
import { preopenDocumentWindow } from "@/lib/printing/brand";
import { printDeliveryFeeRefundReceipt } from "@/lib/printing/cashierLifecycleReceipts";
import { paymentMethodCompact } from "@shared/terms";

export function ExcessFeeRefundPanel({
  branchId,
  onChanged,
}: {
  branchId: number;
  onChanged: () => Promise<unknown>;
}) {
  const [number, setNumber] = useState(""),
    [lookup, setLookup] = useState(""),
    [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID()),
    [receiptId, setReceiptId] = useState<number | null>(null);
  const [shiftId, setShiftId] = useState(""),
    [manager, setManager] = useState(false),
    [error, setError] = useState<string | null>(null);
  const preview = trpc.delivery.paymentRefunds.previewExcess.useQuery(
    { branchId, documentNumber: lookup },
    { enabled: lookup.length > 0, retry: false, refetchOnWindowFocus: false },
  );
  const detail = preview.data;
  const source = detail?.eligible ? detail : undefined;
  const open = trpc.treasury.getOpenShifts.useQuery(
    { branchId },
    { enabled: source?.receipt.method === "CASH" },
  );
  const request = trpc.delivery.paymentRefunds.requestExcess.useMutation();
  const selectedShift = shiftId
    ? Number(shiftId)
    : open.data?.length === 1
      ? open.data[0].shiftId
      : undefined;
  const needsApproval =
    source?.receipt.method === "CASH" &&
    (source.needsManagerApproval ||
      (selectedShift != null && selectedShift !== source.receipt.shiftId));
  async function submit(approval?: ManagerApprovalInput) {
    if (!source) return;
    setError(null);
    setManager(false);
    const win =
      source.receipt.method === "CASH"
        ? preopenDocumentWindow("width=420,height=760")
        : null;
    try {
      const result = await request.mutateAsync({
        branchId,
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        expectedReceiptId: source.receipt.id,
        expectedAmount: source.amount,
        reason,
        clientRequestId: requestId,
        refundShiftId: selectedShift,
        managerApproval: approval,
      });
      if (source.receipt.method === "CASH") {
        void printDeliveryFeeRefundReceipt(
          {
            refundNumber: `RFD-${result.receiptId}`,
            sourceRef: detail?.number ?? lookup,
            amount: source.amount,
            paymentMethod: source.receipt.method,
            reason,
          },
          { into: win },
        ).catch(() => {});
      }
      setReceiptId(result.receiptId);
      await onChanged();
    } catch (e) {
      try { win?.close(); } catch { /* ignore */ }
      setError(e instanceof Error ? e.message : "تعذّر رد الأجرة الزائدة");
    }
  }
  return (
    <div className="space-y-3 rounded border p-3">
      <h3 className="font-bold">رد أجرة زائدة قبل التجميع</h3>
      <p className="text-sm text-muted-foreground">
        امسح رقم الفاتورة أو أمر الشغل المطبوع. يرد هذا الإجراء أجرة التوصيل
        الأصلية كاملة، ويبقي البضاعة والمدفوع والمواد كما هي. احتفظ بأمانة واحدة
        مطابقة لأجرة الشحنة الجديدة.
      </p>
      <div className="flex gap-2">
        <Input
          aria-label="رقم مصدر الأجرة المطبوع أو الباركود"
          value={number}
          onChange={(e) => {
            setNumber(e.target.value);
            setReceiptId(null);
            setRequestId(crypto.randomUUID());
          }}
          placeholder="INV-… أو WO-…"
          dir="ltr"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setLookup(number.trim());
              setReceiptId(null);
              setError(null);
            }
          }}
        />
        <Button
          variant="outline"
          disabled={!number.trim() || preview.isFetching}
          onClick={() => {
            setLookup(number.trim());
            setReceiptId(null);
            setError(null);
          }}
        >
          معاينة المصدر
        </Button>
      </div>
      {detail && (
        <div className="flex flex-wrap justify-between gap-2 text-sm">
          <strong>
            {detail.sourceKind === "INVOICE" ? "فاتورة" : "أمر شغل"}{" "}
            {detail.number} — {detail.state}
          </strong>
          <Link
            className="text-primary underline"
            href={
              detail.sourceKind === "INVOICE"
                ? `/invoices/${detail.sourceId}`
                : `/work-orders/${detail.sourceId}`
            }
          >
            تفاصيل المصدر الأصلي
          </Link>
        </div>
      )}
      {detail?.eligible === false && (
        <p role="alert" className="text-destructive">
          {detail.blockReason}
        </p>
      )}
      {source && (
        <div className="space-y-2 rounded border p-3 text-sm">
          <p>
            إيصال القبض #{source.receipt.id} — {source.receipt.reference} —{" "}
            {fmt(source.amount)} د.ع —{" "}
            {paymentMethodCompact(source.receipt.method)}
          </p>
          <p className="text-muted-foreground">
            {source.receipt.method === "CASH"
              ? "النقد يخرج فعلياً من الدرج المختار بعد فحص رصيده وصلاحية الرد."
              : "يسجل طلب رد معلق على الوسيلة الأصلية. لا يمكن الإسناد قبل تنفيذ الاسترداد الخارجي واعتماده بمرجع المزوّد."}
          </p>
          {receiptId != null ? (
            <p role="status">
              سُجل إيصال الرد #{receiptId}.{" "}
              {source.receipt.method === "CASH"
                ? "اكتمل الرد النقدي."
                : "أكمل الاسترداد الخارجي من قائمة الإيصالات أدناه."}
            </p>
          ) : (
            <>
              {source.receipt.method === "CASH" && (
                <AppSelect
                  aria-label="درج رد الأجرة الزائدة"
                  value={selectedShift == null ? "" : String(selectedShift)}
                  onValueChange={(v) => {
                    setShiftId(v);
                    setRequestId(crypto.randomUUID());
                  }}
                >
                  <option value="">اختر درج الرد الفعلي</option>
                  {open.data?.map((s) => (
                    <option key={s.shiftId} value={String(s.shiftId)}>
                      {s.userName} — وردية #{s.shiftId}
                    </option>
                  ))}
                </AppSelect>
              )}
              <Input
                aria-label="سبب رد الأجرة الزائدة"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setRequestId(crypto.randomUUID());
                }}
                placeholder="سبب رد الأجرة قبل التجميع"
              />
              <Button
                disabled={
                  reason.trim().length < 3 ||
                  request.isPending ||
                  number.trim() !== lookup ||
                  (source.receipt.method === "CASH" && selectedShift == null)
                }
                onClick={() =>
                  needsApproval ? setManager(true) : void submit()
                }
              >
                {needsApproval
                  ? "اعتماد مدير مختلف ورد الأجرة"
                  : source.receipt.method === "CASH"
                    ? "تأكيد رد الأجرة نقداً"
                    : "طلب رد الأجرة على وسيلتها الأصلية"}
              </Button>
            </>
          )}
        </div>
      )}
      {(error || preview.error || open.error) && (
        <p role="alert" className="text-destructive">
          {error ?? preview.error?.message ?? open.error?.message}
        </p>
      )}
      {manager && (
        <ManagerApprovalDialog
          title="اعتماد رد أجرة زائدة"
          description="رد النقد عبر درج آخر أو بعد إغلاق درج القبض يحتاج مديراً مختلفاً عن منفذ الرد. يبقى مبلغ المصدر والبضاعة كما في المعاينة."
          onApprove={(approval) => void submit(approval)}
          onCancel={() => setManager(false)}
        />
      )}
    </div>
  );
}
