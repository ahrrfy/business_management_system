import { MoneyInput } from "@/components/form/MoneyInput";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { confirm } from "@/lib/confirm";
import { iqd } from "@/lib/hr/ui";
import { D, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { exportRows } from "@/lib/export";
import { toExcelMoney } from "@/lib/payrollAccrual";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Check, FileSpreadsheet, HandCoins, Printer, RotateCcw, ShieldCheck, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

type Advance = RouterOutputs["payroll"]["advancesList"][number];
type RepaymentRequest = RouterOutputs["payroll"]["advanceRepaymentRequests"][number];
type RepaymentLedger = RouterOutputs["payroll"]["advanceRepaymentLedger"][number];
type PaymentMethod = "CASH" | "CARD" | "TRANSFER" | "WALLET";

type EmployeeBalance = {
  employeeId: number;
  employeeName: string;
  branchId: number;
  branchName: string | null;
  employmentStatus: Advance["employmentStatus"];
  remaining: string;
};

function employeeBranchKey(employeeId: number, branchId: number): string {
  return `${employeeId}:${branchId}`;
}

const REQUEST_STATUS_LABEL: Record<string, string> = {
  PENDING: "بانتظار الاعتماد",
  APPROVED: "معتمد ومنفذ",
  REJECTED: "مرفوض",
};

const REQUEST_STATUS_CLS: Record<string, string> = {
  PENDING: "badge-status-pending",
  APPROVED: "badge-status-active",
  REJECTED: "badge-status-cancelled",
};

function baghdadTodayYmd(): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function requestKindLabel(kind: RepaymentRequest["requestKind"]): string {
  return kind === "REPAYMENT" ? "قبض سداد سلفة" : "إعادة سداد للموظف";
}

function paymentMethodLabel(method: RepaymentRequest["paymentMethod"]): string {
  return method === "CASH" ? "نقداً من الدرج" : method === "CARD" ? "بطاقة" : method === "TRANSFER" ? "تحويل مصرفي" : "محفظة دفع";
}

function repaymentPrint(request: RepaymentRequest, allocations: RepaymentLedger["allocations"]) {
  printReportDoc({
    title: requestKindLabel(request.requestKind),
    headerExtra: [
      { label: "رقم الطلب", value: `#${request.id}` },
      { label: "الحالة", value: REQUEST_STATUS_LABEL[request.status] ?? request.status },
      { label: "الموظف", value: request.employeeName || `موظف #${request.employeeId}` },
      { label: "تاريخ الحركة", value: String(request.transactionDate).slice(0, 10) },
    ],
    columns: [
      { key: "amount", label: "المبلغ", align: "left" },
      { key: "method", label: "الطريقة" },
      { key: "reference", label: "المرجع" },
      { key: "receipt", label: "الإيصال" },
      { key: "entry", label: "القيد" },
      { key: "allocation", label: "التخصيصات" },
      { key: "maker", label: "الصانع" },
      { key: "checker", label: "المعتمد" },
    ],
    rows: [{
      amount: `${iqd(request.amount)} د.ع`,
      method: paymentMethodLabel(request.paymentMethod),
      reference: request.referenceNumber ?? (request.cardLastFour ? `**** ${request.cardLastFour}` : "—"),
      receipt: request.receiptId ? `REC-${request.receiptId}` : "غير منفذ",
      entry: request.accountingEntryId ? `AE-${request.accountingEntryId}` : "غير منفذ",
      allocation: allocations.length ? allocations.map((row) => `ADV-${row.advanceId}:${row.direction}:${iqd(row.amount)} د.ع:REC-${row.receiptId}:AE-${row.accountingEntryId}`).join("، ") : "—",
      maker: `USER-${request.createdBy}`,
      checker: request.reviewedBy ? `USER-${request.reviewedBy}` : "—",
    }],
    summary: [
      { label: "وصف الدليل", value: request.evidenceNote },
      { label: "بصمة المصدر", value: request.sourceHash },
      { label: "بصمة الدليل", value: request.evidenceHash },
    ],
  });
}

export function EmployeeAdvanceRepaymentPanel() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const owner = me.data?.isOwner === true;
  const currentUserId = Number(me.data?.id ?? 0);
  const advancesQ = trpc.payroll.advancesList.useQuery({ status: "ACTIVE" });
  const requestsQ = trpc.payroll.advanceRepaymentRequests.useQuery();
  const ledgerQ = trpc.payroll.advanceRepaymentLedger.useQuery();
  const [dialog, setDialog] = useState<{ kind: "REPAYMENT" } | { kind: "RETURN"; request: RepaymentRequest } | null>(null);
  const [rejecting, setRejecting] = useState<RepaymentRequest | null>(null);

  const employeeBalances = useMemo(() => {
    const grouped = new Map<string, EmployeeBalance>();
    for (const advance of advancesQ.data ?? []) {
      if (!D(advance.remaining).gt(0)) continue;
      const employeeId = Number(advance.employeeId);
      const branchId = Number(advance.branchId);
      const scopeKey = employeeBranchKey(employeeId, branchId);
      const previous = grouped.get(scopeKey);
      const remaining = round2(D(previous?.remaining ?? 0).plus(D(advance.remaining))).toFixed(2);
      grouped.set(scopeKey, {
        employeeId,
        employeeName: advance.employeeName,
        branchId,
        branchName: advance.branchName,
        employmentStatus: advance.employmentStatus,
        remaining,
      });
    }
    return Array.from(grouped.values()).sort((a, b) =>
      a.employeeName.localeCompare(b.employeeName, "ar") || a.branchId - b.branchId,
    );
  }, [advancesQ.data]);

  const requests = requestsQ.data ?? [];
  const ledgerByRequest = useMemo(
    () => new Map((ledgerQ.data ?? []).map((row) => [Number(row.id), row.allocations])),
    [ledgerQ.data],
  );
  const requestById = useMemo(() => new Map(requests.map((row) => [Number(row.id), row])), [requests]);
  const activeReturnOf = useMemo(
    () => new Set(requests
      .filter((row) => row.requestKind === "RETURN" && row.originalRequestId != null && row.status !== "REJECTED")
      .map((row) => Number(row.originalRequestId))),
    [requests],
  );
  const pendingCount = requests.filter((row) => row.status === "PENDING").length;

  const refresh = async () => {
    await Promise.all([
      utils.payroll.advancesList.invalidate(),
      utils.payroll.advanceBalance.invalidate(),
      utils.payroll.advanceRepaymentRequests.invalidate(),
      utils.payroll.advanceRepaymentLedger.invalidate(),
    ]);
  };
  const approve = trpc.payroll.approveAdvanceRepayment.useMutation({
    onSuccess: async (result) => {
      notify.ok(result.replayed ? "الحركة منفذة سابقاً ولم تتكرر" : "تم الاعتماد وإنشاء الإيصال والقيد والتخصيصات");
      await refresh();
    },
    onError: (error) => notify.err(error),
  });

  function exportRepaymentLedger() {
    const exportData = requests.flatMap((request) => {
      const allocations = ledgerByRequest.get(Number(request.id)) ?? [];
      const rows = allocations.length ? allocations : [null];
      return rows.map((allocation) => ({
        requestId: Number(request.id),
        kind: requestKindLabel(request.requestKind),
        status: REQUEST_STATUS_LABEL[request.status] ?? request.status,
        employee: request.employeeName || `موظف #${request.employeeId}`,
        branchId: Number(request.branchId),
        transactionDate: String(request.transactionDate).slice(0, 10),
        requestAmount: toExcelMoney(request.amount),
        method: paymentMethodLabel(request.paymentMethod),
        reference: request.referenceNumber ?? (request.cardLastFour ? `**** ${request.cardLastFour}` : ""),
        receiptId: request.receiptId ? `REC-${request.receiptId}` : "",
        accountingEntryId: request.accountingEntryId ? `AE-${request.accountingEntryId}` : "",
        originalRequestId: request.originalRequestId ? Number(request.originalRequestId) : "",
        advanceId: allocation ? Number(allocation.advanceId) : "",
        allocationDirection: allocation?.direction ?? "",
        allocationAmount: allocation ? toExcelMoney(allocation.amount) : "",
        allocationReceiptId: allocation ? `REC-${allocation.receiptId}` : "",
        allocationEntryId: allocation ? `AE-${allocation.accountingEntryId}` : "",
        maker: `USER-${request.createdBy}`,
        checker: request.reviewedBy ? `USER-${request.reviewedBy}` : "",
        sourceHash: request.sourceHash,
        evidenceHash: request.evidenceHash,
      }));
    });
    exportRows(exportData, {
      filename: "سجل-سداد-سلف-الموظفين",
      columns: [
        { key: "requestId", header: "رقم الطلب" }, { key: "kind", header: "الحركة" }, { key: "status", header: "الحالة" },
        { key: "employee", header: "الموظف" }, { key: "branchId", header: "الفرع" }, { key: "transactionDate", header: "تاريخ الحركة" },
        { key: "requestAmount", header: "مبلغ الطلب", money: true }, { key: "method", header: "الطريقة" }, { key: "reference", header: "المرجع" },
        { key: "receiptId", header: "الإيصال" }, { key: "accountingEntryId", header: "القيد" }, { key: "originalRequestId", header: "الطلب الأصلي" },
        { key: "advanceId", header: "السلفة المخصصة" }, { key: "allocationDirection", header: "اتجاه التخصيص" },
        { key: "allocationAmount", header: "مبلغ التخصيص", money: true }, { key: "allocationReceiptId", header: "إيصال التخصيص" },
        { key: "allocationEntryId", header: "قيد التخصيص" }, { key: "maker", header: "الصانع" }, { key: "checker", header: "المعتمد" },
        { key: "sourceHash", header: "بصمة المصدر" }, { key: "evidenceHash", header: "بصمة الدليل" },
      ],
    });
  }

  return <Card>
    <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
      <div>
        <CardTitle className="flex items-center gap-2 text-base"><HandCoins className="size-4 text-primary" aria-hidden /> سداد السلف واسترداد السداد</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">طلب maker/checker موثق: الطلب المعلّق بلا أثر مالي؛ الاعتماد وحده ينشئ الإيصال والقيد ويحدث رصيد السلفة.</p>
      </div>
      <div className="flex items-center gap-2">
        {owner && <span className="rounded-md border px-3 py-1.5 text-xs">طابور المراجعة: <b dir="ltr">{pendingCount}</b></span>}
        <Button size="sm" variant="outline" onClick={exportRepaymentLedger} disabled={requests.length === 0}><FileSpreadsheet className="size-4" aria-hidden /> تصدير سجل الحركات</Button>
        {!owner && <Button size="sm" onClick={() => setDialog({ kind: "REPAYMENT" })} disabled={employeeBalances.length === 0}><HandCoins className="size-4" aria-hidden /> تسجيل قبض سداد</Button>}
      </div>
    </CardHeader>
    <CardContent className="space-y-3">
      {(advancesQ.isError || requestsQ.isError || ledgerQ.isError) && <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">تعذر تحميل أرصدة السلف أو سجل السداد ضمن نطاقك. أعد المحاولة أو تحقق من صلاحية الموارد البشرية.</p>}
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">موظفون برصيد قائم</div><div className="mt-1 text-lg font-bold" dir="ltr">{employeeBalances.length}</div></div>
        <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">إجمالي الرصيد ضمن النطاق</div><div className="mt-1 text-lg font-bold tabular-nums" dir="ltr">{iqd(employeeBalances.reduce((sum, row) => sum.plus(D(row.remaining)), D(0)).toFixed(2))} د.ع</div></div>
        <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">طلبات معلّقة بلا أثر</div><div className="mt-1 text-lg font-bold" dir="ltr">{pendingCount}</div></div>
      </div>
      <ScrollTableShell>
        <table className="w-full text-xs">
          <thead className="bg-muted/50"><tr>
            <th className="p-2 text-right">الحركة/الموظف</th><th className="p-2 text-right">المبلغ</th><th className="p-2 text-right">الدليل</th>
            <th className="p-2 text-right">المستند المالي</th><th className="p-2 text-right">الصانع/المعتمد</th><th className="p-2 text-center">الحالة</th><th className="p-2 text-left">الإجراء</th>
          </tr></thead>
          <tbody>
            {requests.map((request) => {
              const original = request.originalRequestId == null ? null : requestById.get(Number(request.originalRequestId)) ?? null;
              const originalActors = request.requestKind === "RETURN" ? [original?.createdBy, original?.reviewedBy] : [];
              const independent = owner && [request.createdBy, ...originalActors]
                .filter((actorId): actorId is number => actorId != null)
                .every((actorId) => currentUserId !== Number(actorId));
              const allocations = ledgerByRequest.get(Number(request.id)) ?? [];
              const canRequestReturn = !owner && request.requestKind === "REPAYMENT" && request.status === "APPROVED" && !activeReturnOf.has(Number(request.id));
              return <tr key={request.id} className="border-t align-top">
                <td className="p-2"><div className="font-medium">{requestKindLabel(request.requestKind)}</div><div>{request.employeeName || `موظف #${request.employeeId}`}</div><div className="text-muted-foreground">طلب #{request.id}{request.originalRequestId ? ` ← أصل #${request.originalRequestId}` : ""} · {String(request.transactionDate).slice(0, 10)}</div></td>
                <td className="p-2 font-bold tabular-nums" dir="ltr">{iqd(request.amount)} د.ع</td>
                <td className="p-2"><div>{paymentMethodLabel(request.paymentMethod)}</div><div dir="ltr">{request.referenceNumber ?? (request.cardLastFour ? `**** ${request.cardLastFour}` : "—")}</div><div className="max-w-56 text-muted-foreground">{request.evidenceNote}</div></td>
                <td className="p-2 font-mono text-[11px]" dir="ltr"><div>{request.receiptId ? `REC-${request.receiptId}` : "PENDING"}</div><div>{request.accountingEntryId ? `AE-${request.accountingEntryId}` : "NO-ENTRY"}</div>{allocations.length ? allocations.map((allocation) => <div key={allocation.id} className="mt-1 border-t pt-1">ADV-{allocation.advanceId} · {allocation.direction} · {iqd(allocation.amount)} IQD<br />REC-{allocation.receiptId} · AE-{allocation.accountingEntryId}</div>) : <div>NO-ALLOC</div>}</td>
                <td className="p-2 tabular-nums" dir="ltr"><div>USER-{request.createdBy}</div><div>{request.reviewedBy ? `USER-${request.reviewedBy}` : "—"}</div></td>
                <td className="p-2 text-center"><span className={`inline-flex rounded-full px-2 py-0.5 ${REQUEST_STATUS_CLS[request.status] ?? "bg-muted"}`}>{REQUEST_STATUS_LABEL[request.status] ?? request.status}</span>{request.rejectionReason && <div className="mt-1 max-w-48 text-destructive">{request.rejectionReason}</div>}</td>
                <td className="p-2"><div className="flex justify-end gap-1">
                  {owner && request.status === "PENDING" && <>
                    <Button size="sm" variant="outline" disabled={!independent || approve.isPending} title={!independent ? "يلزم مالك مستقل عن صانع الطلب" : undefined} onClick={async () => {
                      const incoming = request.requestKind === "REPAYMENT";
                      const ok = await confirm({ variant: incoming ? "warning" : "danger", title: `اعتماد ${requestKindLabel(request.requestKind)}`, description: `${incoming ? "سيُنشأ إيصال قبض ويُخفّض أصل سلفة الموظف" : "سيُنشأ سند صرف ويُعاد فتح أصل سلفة الموظف"} بمبلغ ${iqd(request.amount)} د.ع وفق الدليل المحفوظ. هذه حركة مالية فعلية وليست موافقة شكلية.`, confirmText: incoming ? "اعتماد القبض" : "اعتماد الإعادة والصرف" });
                      if (ok) approve.mutate({ id: Number(request.id) });
                    }}><Check className="size-3.5" aria-hidden /> اعتماد</Button>
                    <Button size="sm" variant="outline" className="text-destructive" disabled={!independent} onClick={() => setRejecting(request)}><X className="size-3.5" aria-hidden /> رفض</Button>
                  </>}
                  {canRequestReturn && <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "RETURN", request })}><RotateCcw className="size-3.5" aria-hidden /> طلب إعادة</Button>}
                  {request.status === "APPROVED" && <Button size="icon" variant="outline" title="طباعة مستند الحركة" onClick={() => repaymentPrint(request, allocations)}><Printer className="size-3.5" aria-hidden /><span className="sr-only">طباعة</span></Button>}
                </div></td>
              </tr>;
            })}
            {!requestsQ.isLoading && requests.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">لا طلبات سداد أو إعادة ضمن النطاق.</td></tr>}
          </tbody>
        </table>
      </ScrollTableShell>
      {owner
        ? <p className="flex items-center gap-1 text-xs text-muted-foreground"><ShieldCheck className="size-3.5" aria-hidden /> المالك يراجع الطلبات فقط هنا؛ إنشاء الطلب يترك لصانع فرعي كي لا ينشأ مسار اعتماد ذاتي مسدود.</p>
        : <p className="flex items-center gap-1 text-xs text-muted-foreground"><ShieldCheck className="size-3.5" aria-hidden /> ترى أرصدة وطلبات فرعك فقط. لا تعرض هذه اللوحة أجور الموظفين أو تفاصيل مسيّرات الرواتب.</p>}
    </CardContent>

    <RepaymentEvidenceDialog open={dialog != null} mode={dialog} employees={employeeBalances} onClose={() => setDialog(null)} onDone={refresh} />
    <RejectRepaymentDialog request={rejecting} onClose={() => setRejecting(null)} onDone={refresh} />
  </Card>;
}

function RepaymentEvidenceDialog({
  open,
  mode,
  employees,
  onClose,
  onDone,
}: {
  open: boolean;
  mode: { kind: "REPAYMENT" } | { kind: "RETURN"; request: RepaymentRequest } | null;
  employees: EmployeeBalance[];
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [employeeScopeKey, setEmployeeScopeKey] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("TRANSFER");
  const [reference, setReference] = useState("");
  const [lastFour, setLastFour] = useState("");
  const [transactionDate, setTransactionDate] = useState(baghdadTodayYmd());
  const [evidenceNote, setEvidenceNote] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const returning = mode?.kind === "RETURN";
  const selected = returning
    ? { employeeId: Number(mode.request.employeeId), employeeName: mode.request.employeeName, branchId: Number(mode.request.branchId), branchName: null, employmentStatus: null, remaining: mode.request.amount }
    : employees.find((row) => employeeBranchKey(row.employeeId, row.branchId) === employeeScopeKey);
  const effectiveAmount = returning ? mode.request.amount : amount;
  const shiftQ = trpc.shifts.current.useQuery(
    { branchId: selected?.branchId ?? 0 },
    { enabled: open && method === "CASH" && !!selected?.branchId },
  );
  const create = trpc.payroll.requestAdvanceRepayment.useMutation({
    onSuccess: async (result) => {
      notify.ok(result.replayed ? "الطلب محفوظ سابقاً ولم يتكرر" : "تم إنشاء طلب قبض السداد بلا أثر مالي حتى اعتماد مالك مستقل");
      requestId.current = crypto.randomUUID(); onClose(); await onDone();
    },
    onError: (error) => notify.err(error),
  });
  const createReturn = trpc.payroll.requestAdvanceRepaymentReturn.useMutation({
    onSuccess: async (result) => {
      notify.ok(result.replayed ? "طلب الإعادة محفوظ سابقاً ولم يتكرر" : "تم إنشاء طلب إعادة السداد بانتظار اعتماد وصرف مستقل");
      requestId.current = crypto.randomUUID(); onClose(); await onDone();
    },
    onError: (error) => notify.err(error),
  });
  const electronicReferenceValid = method === "CASH" || !!reference.trim();
  const cardValid = method !== "CARD" || /^\d{4}$/.test(lastFour);
  const cashValid = method !== "CASH" || !!shiftQ.data?.id;
  const amountValid = returning || (!!selected && D(effectiveAmount || 0).gt(0) && D(effectiveAmount || 0).lte(D(selected.remaining)));
  const valid = !!selected && amountValid && electronicReferenceValid && cardValid && cashValid && transactionDate <= baghdadTodayYmd() && evidenceNote.trim().length >= 10;
  const busy = create.isPending || createReturn.isPending;

  const evidence = {
    paymentMethod: method,
    cashBucket: method === "CASH" ? "DRAWER" as const : null,
    shiftId: method === "CASH" ? Number(shiftQ.data?.id) : null,
    referenceNumber: method === "CASH" ? null : reference.trim(),
    cardLastFour: method === "CARD" ? lastFour : null,
    transactionDate,
    evidenceNote: evidenceNote.trim(),
    clientRequestId: requestId.current,
  };

  return <Dialog open={open} onOpenChange={(value) => !value && onClose()}><DialogContent>
    <DialogHeader><DialogTitle>{returning ? "طلب إعادة سداد سابق للموظف" : "تسجيل طلب قبض سداد سلفة"}</DialogTitle></DialogHeader>
    <div className="space-y-3 py-1">
      {!returning && <div><Label htmlFor="advrep-employee">الموظف والفرع ورصيد السلف</Label><AppSelect id="advrep-employee" value={employeeScopeKey} onValueChange={setEmployeeScopeKey} className="w-full"><option value="">اختر موظفاً وفرعاً…</option>{employees.map((employee) => <option key={employeeBranchKey(employee.employeeId, employee.branchId)} value={employeeBranchKey(employee.employeeId, employee.branchId)}>{employee.employeeName} — {employee.branchName ?? `فرع #${employee.branchId}`} — {employee.employmentStatus === "terminated" ? "منتهي الخدمة" : "على رأس العمل"} — {iqd(employee.remaining)} د.ع</option>)}</AppSelect></div>}
      {returning && <div className="rounded-md border p-3 text-sm"><div className="font-medium">{mode.request.employeeName || `موظف #${mode.request.employeeId}`}</div><div className="text-muted-foreground">إعادة كاملة للطلب الأصلي #{mode.request.id} بمبلغ <b dir="ltr">{iqd(mode.request.amount)} د.ع</b>. لا تسمح اليومية بعكس جزئي مبهم.</div></div>}
      {!returning && <div><Label htmlFor="advrep-amount">المبلغ (د.ع)</Label><MoneyInput id="advrep-amount" value={amount} onChange={setAmount} decimals={2} placeholder="0" ariaLabel="مبلغ سداد السلفة" /><p className="mt-1 text-xs text-muted-foreground">الحد الأقصى: {iqd(selected?.remaining ?? 0)} د.ع.</p></div>}
      <div><Label htmlFor="advrep-method">طريقة الحركة</Label><AppSelect id="advrep-method" value={method} onValueChange={(value) => { setMethod(value as PaymentMethod); setReference(""); setLastFour(""); }} className="w-full"><option value="TRANSFER">تحويل مصرفي</option><option value="CARD">بطاقة</option><option value="WALLET">محفظة دفع</option><option value="CASH">نقداً من درج الوردية</option></AppSelect></div>
      {method !== "CASH" && <div><Label htmlFor="advrep-reference">مرجع التأكيد الخارجي (إلزامي)</Label><Input id="advrep-reference" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={100} dir="ltr" /></div>}
      {method === "CARD" && <div><Label htmlFor="advrep-card">آخر أربعة أرقام للبطاقة</Label><Input id="advrep-card" value={lastFour} onChange={(event) => setLastFour(event.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" maxLength={4} dir="ltr" placeholder="آخر 4 أرقام" /></div>}
      {method === "CASH" && <p className={`rounded-md border p-2 text-xs ${shiftQ.data?.id ? "text-money-positive" : "text-destructive"}`}>{shiftQ.isLoading ? "جارٍ التحقق من الوردية…" : shiftQ.data?.id ? `سترتبط الحركة بدرج ورديتك المفتوحة #${shiftQ.data.id}. يجب أن تبقى مفتوحة حتى اعتماد الطلب.` : "لا توجد وردية مفتوحة متاحة؛ اختر وسيلة غير نقدية أو افتح وردية موثقة."}</p>}
      <div><Label htmlFor="advrep-date">تاريخ الحركة الفعلي</Label><Input id="advrep-date" type="date" value={transactionDate} max={baghdadTodayYmd()} onChange={(event) => setTransactionDate(event.target.value)} dir="ltr" /></div>
      <div><Label htmlFor="advrep-note">وصف دليل الحركة (10 أحرف على الأقل)</Label><Input id="advrep-note" value={evidenceNote} onChange={(event) => setEvidenceNote(event.target.value)} minLength={10} maxLength={500} placeholder="مثال: إشعار تحويل مصرفي مطابق ومراجع" /></div>
      <p className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">الحفظ ينشئ طلباً صفري الأثر. عند اعتماد مالك مستقل فقط ينشأ الإيصال والقيد والتخصيص؛ وطلب الإعادة ينشئ سند صرف حقيقياً بعد تأكيد صريح.</p>
    </div>
    <DialogFooter><Button variant="outline" onClick={onClose}>إلغاء</Button><Button disabled={!valid || busy} onClick={() => {
      if (!selected || !mode) return;
      if (mode.kind === "RETURN") createReturn.mutate({ originalRequestId: Number(mode.request.id), ...evidence });
      else create.mutate({ employeeId: selected.employeeId, branchId: selected.branchId, amount: D(effectiveAmount).toFixed(2), ...evidence });
    }}>{busy ? "جارٍ الحفظ…" : returning ? "إنشاء طلب الإعادة" : "إنشاء طلب القبض"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function RejectRepaymentDialog({ request, onClose, onDone }: { request: RepaymentRequest | null; onClose: () => void; onDone: () => Promise<void> | void }) {
  const [reason, setReason] = useState("");
  const reject = trpc.payroll.rejectAdvanceRepayment.useMutation({
    onSuccess: async (result) => { notify.ok(result.replayed ? "الطلب مرفوض سابقاً بالسبب نفسه" : "تم رفض الطلب مع حفظ السبب"); setReason(""); onClose(); await onDone(); },
    onError: (error) => notify.err(error),
  });
  return <Dialog open={request != null} onOpenChange={(value) => !value && onClose()}><DialogContent>
    <DialogHeader><DialogTitle>رفض طلب سداد السلفة</DialogTitle></DialogHeader>
    <div><Label htmlFor="advrep-reject-reason">سبب الرفض (5 أحرف على الأقل)</Label><Input id="advrep-reject-reason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={255} /></div>
    <DialogFooter><Button variant="outline" onClick={onClose}>إلغاء</Button><Button variant="destructive" disabled={reason.trim().length < 5 || reject.isPending} onClick={() => request && reject.mutate({ id: Number(request.id), reason: reason.trim() })}>{reject.isPending ? "جارٍ الرفض…" : "رفض الطلب"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
