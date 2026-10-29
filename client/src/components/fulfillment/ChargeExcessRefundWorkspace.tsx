import React, { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { DataTable } from "@/components/data-table/DataTable";
import { AppSelect } from "@/components/ui/AppSelect";
import { MoneyInput } from "@/components/form/MoneyInput";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { confirm } from "@/lib/confirm";
import { fmt, moneyInput } from "@/lib/money";
import { lifecycleActionAllowed } from "@/lib/lifecycleActionPermission";
import { moduleAccessAllowed, type PermissionMap } from "@shared/permissions";
import { preopenDocumentWindow } from "@/lib/printing/print";
import { printOverageRefundReceipt } from "@/lib/printing/cashierLifecycleReceipts";

type Api = RouterInputs["delivery"]["fulfillment"]["charges"];
type Row =
  RouterOutputs["delivery"]["fulfillment"]["charges"]["listCourierExcess"]["rows"][number];
type Refund = Api["refundCourierExcess"];

/** Real CN excess sources; also usable when a request has no charge document. */
export type ChargeExcessRefundWorkspaceProps = {
  embedded?: boolean;
  branchId?: number;
};

export function ChargeExcessRefundWorkspace({
  embedded = false,
  branchId: selectedBranchId,
}: ChargeExcessRefundWorkspaceProps = {}) {
  const me = trpc.auth.me.useQuery();
  const [chosenBranch, setChosenBranch] = useState("");
  const branchValue = chosenBranch || me.data?.branchId;
  const branchId = embedded
    ? selectedBranchId
    : branchValue
      ? Number(branchValue)
      : undefined;
  return (
    <ChargeExcessRefundWorkspaceContent
      key={`${me.data?.id ?? "anonymous"}:${branchId ?? "unselected"}:${embedded}`}
      embedded={embedded}
      branchId={branchId}
      onBranchChange={setChosenBranch}
    />
  );
}

function ChargeExcessRefundWorkspaceContent({
  embedded,
  branchId,
  onBranchChange,
}: ChargeExcessRefundWorkspaceProps & {
  onBranchChange: (value: string) => void;
}) {
  const me = trpc.auth.me.useQuery(),
    branches = trpc.branches.list.useQuery(undefined, { enabled: !embedded }),
    utils = trpc.useUtils();
  const [search, setSearch] = useState(""),
    [debounced, setDebounced] = useState(""),
    [page, setPage] = useState(0);
  const [selected, setSelected] = useState<number | null>(null),
    [amount, setAmount] = useState(""),
    [reason, setReason] = useState("");
  const [bucket, setBucket] = useState<"DRAWER" | "TREASURY">("DRAWER"),
    [shift, setShift] = useState("");
  const [error, setError] = useState(""),
    [receiptId, setReceiptId] = useState<number | null>(null);
  const scope = `fulfillment-excess-refund:${me.data?.id ?? "anonymous"}:${branchId ?? "unselected"}`;
  const [pending, setPending] = useState<Refund | null>(() => {
    try {
      const saved = localStorage.getItem(scope);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(0);
    }, 220);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    setSelected(null);
    setAmount("");
    setReason("");
    setReceiptId(null);
    setError("");
    try {
      const saved = localStorage.getItem(scope);
      setPending(saved ? JSON.parse(saved) : null);
    } catch {
      setPending(null);
    }
  }, [scope]);
  const list = trpc.delivery.fulfillment.charges.listCourierExcess.useQuery(
    { branchId: branchId!, search: debounced, limit: 25, offset: page * 25 },
    { enabled: branchId !== undefined && branchId > 0 },
  );
  const options = trpc.delivery.fulfillment.charges.lookup.useQuery(
    { branchId: branchId! },
    { enabled: branchId !== undefined && branchId > 0 },
  );
  const refund =
    trpc.delivery.fulfillment.charges.refundCourierExcess.useMutation();
  const source = list.data?.rows.find(
    (r) => r.originalExcessEntryId === selected,
  );
  const canRefund = lifecycleActionAllowed(
    me.data,
    "delivery.fulfillment.charges.refundCourierExcess",
    !!me.data &&
      moduleAccessAllowed(
        me.data.role,
        me.data.permissionsOverride as PermissionMap | null,
        "store",
        "FULL",
        ["cashier", "manager"],
      ),
  );
  const disabled = refund.isPending || !!pending;
  async function execute(command: Refund, docWin?: Window | null) {
    const targetWin = docWin ?? preopenDocumentWindow();
    setError("");
    setReceiptId(null);
    setPending(command);
    localStorage.setItem(scope, JSON.stringify(command));
    try {
      const result = await refund.mutateAsync(command);
      void printOverageRefundReceipt(
        {
          refundNumber: `RCP-${result.receiptId}`,
          sourceRef:
            source?.consignmentNumber ??
            source?.requestNumber ??
            `REQ-${command.fulfillmentRequestId ?? ""}`,
          beneficiaryName: source?.customerName ?? null,
          beneficiaryRole: "CUSTOMER",
          amount: command.amount,
          paymentMethod: command.tender.method,
          cashierName: me.data?.name ?? null,
          notes: command.reason,
        },
        targetWin ? { into: targetWin } : undefined,
      );
      localStorage.removeItem(scope);
      setPending(null);
      setReceiptId(result.receiptId);
      setAmount("");
      setReason("");
      await Promise.all([
        utils.delivery.fulfillment.charges.invalidate(),
        utils.delivery.fulfillment.requests.invalidate(),
      ]);
    } catch (e) {
      try { targetWin?.close(); } catch { /* noop */ }
      setError(
        e instanceof Error
          ? e.message
          : "تعذر تثبيت الرد؛ أعد الطلب المحفوظ بنفس بياناته",
      );
    }
  }
  async function submit() {
    if (!branchId || !source || source.branchId !== branchId || pending) {
      setError("اختر الفرع وإثبات القبض الأصلي قبل الرد");
      return;
    }
    if (!canRefund) {
      setError("لا تملك صلاحية رد الأمانة");
      return;
    }
    if (
      moneyInput(amount).lte(0) ||
      moneyInput(amount).gt(source.remainingAmount)
    ) {
      setError("حدد مبلغاً موجباً ضمن الأمانة المتبقية");
      return;
    }
    if (
      !(await confirm({
        title: "رد أمانة قبض الناقل",
        description: `${source.customerName} / ${source.consignmentNumber} — ${fmt(amount)} د.ع من ${bucket === "DRAWER" ? "درج ورديتك" : "الخزينة"}`,
        variant: "warning",
      }))
    )
      return;
    await execute({
      fulfillmentRequestId: source.fulfillmentRequestId,
      expectedVersion: source.requestVersion,
      consignmentId: source.consignmentId,
      originalExcessEntryId: source.originalExcessEntryId,
      clientRequestId: crypto.randomUUID(),
      amount,
      reason,
      tender: {
        method: "CASH",
        cashBucket: bucket,
        shiftId: bucket === "DRAWER" && shift ? Number(shift) : null,
      },
    });
  }
  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        accessorKey: "customerName",
        header: "العميل / المستلم",
        cell: ({ row }) => (
          <span>
            {row.original.customerName}
            {row.original.customerId == null ? " — بلا حساب عميل" : ""}
          </span>
        ),
      },
      { accessorKey: "requestNumber", header: "الطلب" },
      { accessorKey: "consignmentNumber", header: "الإرسالية" },
      {
        id: "date",
        header: "تاريخ القبض الأصلي",
        cell: ({ row }) =>
          new Date(row.original.collectedAt).toLocaleDateString(
            "ar-IQ-u-nu-latn",
          ),
      },
      {
        id: "amount",
        header: "القبض الزائد",
        cell: ({ row }) => fmt(row.original.originalAmount),
      },
      {
        id: "remaining",
        header: "المتبقي القابل للرد",
        cell: ({ row }) => fmt(row.original.remainingAmount),
      },
      {
        id: "action",
        header: "الإجراء",
        cell: ({ row }) => (
          <Button
            type="button"
            variant="outline"
            disabled={
              disabled || moneyInput(row.original.remainingAmount).lte(0)
            }
            onClick={() => {
              setSelected(row.original.originalExcessEntryId);
              setAmount(row.original.remainingAmount);
              setError("");
              setReceiptId(null);
            }}
          >
            اختيار للرد
          </Button>
        ),
      },
    ],
    [disabled],
  );
  return (
    <section dir="rtl" className="space-y-3">
      <h3 className="text-base font-semibold">
        أمانات القبض الزائد لدى الناقل
      </h3>
      <p className="text-sm text-muted-foreground">
        يعرض القبض الفعلي الزائد على مطالبات الطلب، بما يشمل طلبات البضاعة بلا
        أجور إضافية. الرد يبرئ الأمانة من نقد المتجر المتاح؛ تظل العهدة على
        الناقل حتى يورّد النقد كاملاً.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        {!embedded && (
          <label className="grid gap-1 text-sm">
            <span>الفرع</span>
            <AppSelect
              value={String(branchId ?? "")}
              onValueChange={(v) => {
                onBranchChange(v);
              }}
              disabled={refund.isPending}
            >
              <option value="">اختر الفرع</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={String(b.id)}>
                  {b.name}
                </option>
              ))}
            </AppSelect>
          </label>
        )}
        <UnifiedSearchInput
          value={search}
          onChange={setSearch}
          placeholder="بحث بالعميل أو الهاتف أو الطلب أو الإرسالية"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => void list.refetch()}
          disabled={!branchId || refund.isPending}
        >
          تحديث الأمانات
        </Button>
      </div>
      <DataTable
        data={list.data?.rows ?? []}
        columns={columns}
        pageSize={25}
        bounded={false}
        viewKey="fulfillment-courier-excess-refunds"
      />
      <div className="flex items-center gap-3 text-sm">
        <Button
          type="button"
          variant="outline"
          disabled={page === 0 || refund.isPending}
          onClick={() => setPage((p) => p - 1)}
        >
          السابق
        </Button>
        <span>
          {list.data?.total ? page * 25 + 1 : 0}–
          {Math.min((page + 1) * 25, list.data?.total ?? 0)} من{" "}
          {list.data?.total ?? 0}
        </span>
        <Button
          type="button"
          variant="outline"
          disabled={
            (page + 1) * 25 >= (list.data?.total ?? 0) || refund.isPending
          }
          onClick={() => setPage((p) => p + 1)}
        >
          التالي
        </Button>
      </div>
      {source && (
        <form
          className="space-y-3 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="text-sm">
            {source.customerName}
            {source.customerId == null ? " — مستلم بلا حساب عميل" : ""} —{" "}
            {source.requestNumber} — {source.consignmentNumber} — المتبقي{" "}
            {fmt(source.remainingAmount)} د.ع
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="grid gap-1 text-sm">
              <span>مبلغ الرد الفعلي</span>
              <MoneyInput
                value={amount}
                onChange={setAmount}
                required
                disabled={disabled}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span>مصدر النقد</span>
              <AppSelect
                value={bucket}
                onValueChange={(v) => setBucket(v as typeof bucket)}
                disabled={disabled}
              >
                <option value="DRAWER">درج ورديتي</option>
                <option value="TREASURY">الخزينة — الصلاحية المعتمدة</option>
              </AppSelect>
            </label>
            {bucket === "DRAWER" && (
              <label className="grid gap-1 text-sm">
                <span>ورديتي المفتوحة</span>
                <AppSelect
                  value={shift}
                  onValueChange={setShift}
                  disabled={disabled}
                >
                  <option value="">اختر الوردية</option>
                  {options.data?.shifts.map((s) => (
                    <option key={s.id} value={String(s.id)}>
                      وردية {s.id} — {s.shiftType}
                    </option>
                  ))}
                </AppSelect>
              </label>
            )}
            <label className="grid gap-1 text-sm">
              <span>سبب الرد</span>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
                minLength={5}
                maxLength={2000}
                disabled={disabled}
              />
            </label>
          </div>
          <SubmitButton
            pending={refund.isPending}
            disabled={disabled || !canRefund || !branchId}
          >
            تثبيت الرد النقدي
          </SubmitButton>
        </form>
      )}
      {pending && (
        <div className="space-y-2 border p-3 text-sm">
          <p>
            يوجد طلب رد محفوظ لم يؤكد نجاحه. إعادة المحاولة تستعمل نفس المبلغ
            والمصدر والمفتاح.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={refund.isPending || !canRefund}
            onClick={() => void execute(pending)}
          >
            إعادة الطلب المحفوظ
          </Button>
        </div>
      )}
      {receiptId && (
        <p role="status" className="text-sm">
          تم تثبيت الرد.{" "}
          <a className="underline" href={`/vouchers/${receiptId}`}>
            عرض إيصال الرد {receiptId}
          </a>
        </p>
      )}
      {(error || list.error || options.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || list.error?.message || options.error?.message}
        </p>
      )}
    </section>
  );
}
