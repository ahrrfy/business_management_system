import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
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
import { D } from "@/lib/money";
import { notify } from "@/lib/notify";
import {
  OBLIGATION_KIND_LABEL,
  payrollExpenseFromItems,
  REMITTANCE_STATUS_LABEL,
  shortHash,
  summarizeObligations,
  type PayrollObligationKind,
} from "@/lib/payrollAccrual";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Check, FilePlus2, Link2, RotateCcw, ShieldCheck, Wallet, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

type RunDetail = NonNullable<RouterOutputs["payroll"]["get"]>;
type Remittance = RouterOutputs["payroll"]["remittances"][number];
type StatutorySummary = RouterOutputs["payroll"]["statutoryObligationSummary"][number];
type PayrollEvent = RunDetail["accountingEvents"][number];
type PaymentMethod = "CASH" | "CARD" | "TRANSFER" | "WALLET";

const OBLIGATION_STATUS_LABEL: Record<string, string> = {
  OPEN: "مفتوح",
  PARTIAL: "مسدد جزئياً",
  SETTLED: "مسدد",
  REVERSED: "معكوس",
};

const BADGE: Record<string, string> = {
  OPEN: "badge-status-pending",
  PARTIAL: "badge-stock-low",
  SETTLED: "badge-status-active",
  REVERSED: "badge-status-cancelled",
  PENDING: "badge-status-pending",
  APPROVED: "badge-stock-low",
  PAID: "badge-status-active",
  REJECTED: "badge-status-cancelled",
};

function Badge({ status, remittance = false }: { status: string; remittance?: boolean }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] ${BADGE[status] ?? "bg-muted text-muted-foreground"}`}>
      {remittance ? (REMITTANCE_STATUS_LABEL[status] ?? status) : (OBLIGATION_STATUS_LABEL[status] ?? status)}
    </span>
  );
}

/** يمنع javascript:/blob:/SVG المخزّن من التحول إلى رابط قابل للتنفيذ في شاشة المراجعة. */
export function safeRemittanceDocumentUrl(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (/^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return normalized;
  }
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function RemittanceDocumentLink({ value }: { value: string | null | undefined }) {
  const safeUrl = safeRemittanceDocumentUrl(value);
  if (!safeUrl) return <span className="text-muted-foreground">مستند غير صالح</span>;
  return <a className="inline-flex h-8 items-center rounded-md border px-2 text-primary" href={safeUrl} target="_blank" rel="noopener noreferrer" title="فتح المستند المؤيد"><Link2 className="size-3.5" aria-hidden /><span className="sr-only">فتح المستند</span></a>;
}

export function PayrollAccrualOperations({
  run,
  onChanged,
}: {
  run: RunDetail;
  onChanged: () => Promise<void> | void;
}) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchesQ = trpc.branches.list.useQuery();
  const obligationsQ = trpc.payroll.obligations.useQuery();
  const remittancesQ = trpc.payroll.remittances.useQuery();
  const [action, setAction] = useState<{
    type: "REJECT" | "PAY" | "RETURN" | "RETURN_SALARY";
    request?: Remittance;
    event?: PayrollEvent;
  } | null>(null);

  const branchName = useMemo(
    () => new Map((branchesQ.data ?? []).map((branch) => [Number(branch.id), branch.name])),
    [branchesQ.data],
  );
  const employeeName = useMemo(
    () => new Map(run.items.map((item) => [Number(item.employeeId), item.employeeName])),
    [run.items],
  );
  const summary = summarizeObligations(run.obligations, Number(run.revisionNo));
  const eventById = new Map(run.accountingEvents.map((event) => [Number(event.id), event]));
  const salaryPaymentLedger = [...run.employeePaymentSnapshots].sort((a, b) => Number(b.eventId) - Number(a.eventId));
  const currentObligations = run.obligations.filter((row) => Number(row.revisionNo) === Number(run.revisionNo));
  const globalOpen = (obligationsQ.data ?? []).filter((row) => row.status === "OPEN" || row.status === "PARTIAL");
  const statutoryOpen = globalOpen.filter((row) => row.kind === "INCOME_TAX" || row.kind === "SOCIAL_SECURITY");
  const statutoryByBranch = Array.from(new Set(statutoryOpen.map((row) => Number(row.branchIdSnapshot ?? 0)))).flatMap((branchId) =>
    summarizeObligations(statutoryOpen.filter((row) => Number(row.branchIdSnapshot ?? 0) === branchId))
      .filter((row) => (row.kind === "INCOME_TAX" || row.kind === "SOCIAL_SECURITY") && D(row.remaining).gt(0))
      .map((row) => ({ ...row, branchId })),
  );
  const owner = me.data?.isOwner === true;
  const currentUserId = Number(me.data?.id ?? 0);

  async function refreshAll() {
    await Promise.all([
      utils.payroll.get.invalidate({ id: Number(run.id) }),
      utils.payroll.list.invalidate(),
      utils.payroll.obligations.invalidate(),
      utils.payroll.remittances.invalidate(),
    ]);
    await onChanged();
  }

  const approveRemittance = trpc.payroll.approveRemittance.useMutation({
    onSuccess: async () => { notify.ok("تم اعتماد طلب التحويل بفصل مهام مستقل"); await refreshAll(); },
    onError: (error) => notify.err(error),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>الاستحقاق المحاسبي والتتبّع</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <AuditField label="تاريخ الاستحقاق" value={run.accrualDate ?? "غير معتمد بعد"} ltr />
            <AuditField label="المراجعة" value={`R${run.revisionNo}`} ltr />
            <AuditField label="بصمة السياسة القانونية" value={shortHash(run.legalPolicyHash)} title={run.legalPolicyHash ?? undefined} ltr />
            <AuditField label="بصمة لقطة الاعتماد" value={shortHash(run.approvalSnapshotHash)} title={run.approvalSnapshotHash ?? undefined} ltr />
          </div>
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-xs leading-6">
            تكلفة الفترة المعترف بها من بنود المسيّر: <strong dir="ltr" className="tabular-nums">{iqd(payrollExpenseFromItems(run.items))} د.ع</strong>.
            الاعتماد يثبت المصروف والالتزامات بلا نقد؛ الصرف والتحويلات اللاحقة تسوّي الالتزامات فقط.
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {summary.map((row) => (
              <div key={row.kind} className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">{OBLIGATION_KIND_LABEL[row.kind]}</div>
                <div className="mt-1 text-lg font-bold tabular-nums" dir="ltr">{iqd(row.remaining)} د.ع</div>
                <div className="mt-1 text-[11px] text-muted-foreground">الأصل {iqd(row.original)} · {row.openCount} مفتوح من {row.count}</div>
              </div>
            ))}
          </div>
          <ScrollTableShell>
            <table className="w-full text-xs">
              <thead className="bg-muted/50"><tr>
                <th className="p-2 text-right">الالتزام</th><th className="p-2 text-right">الموظف/الجهة</th>
                <th className="p-2 text-right">لقطة الفرع</th><th className="p-2 text-right">الأصل</th>
                <th className="p-2 text-right">المتبقي</th><th className="p-2 text-center">الحالة</th>
              </tr></thead>
              <tbody>
                {currentObligations.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="p-2">{OBLIGATION_KIND_LABEL[row.kind as PayrollObligationKind] ?? row.kind}</td>
                    <td className="p-2">{row.employeeId ? (employeeName.get(Number(row.employeeId)) ?? `موظف #${row.employeeId}`) : (row.authorityName ?? "جهة قانونية")}</td>
                    <td className="p-2">{row.branchIdSnapshot ? (branchName.get(Number(row.branchIdSnapshot)) ?? `فرع #${row.branchIdSnapshot}`) : "عام للشركة"}</td>
                    <td className="p-2 tabular-nums" dir="ltr">{iqd(row.originalAmount)}</td>
                    <td className="p-2 tabular-nums font-medium" dir="ltr">{iqd(row.remainingAmount)}</td>
                    <td className="p-2 text-center"><Badge status={row.status} /></td>
                  </tr>
                ))}
                {currentObligations.length === 0 && <tr><td colSpan={6} className="p-5 text-center text-muted-foreground">لا التزامات لهذه المراجعة قبل اعتماد المسيّر.</td></tr>}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {salaryPaymentLedger.length > 0 && (
        <Card>
          <CardHeader><CardTitle>سجل دفعات صافي الراتب ومستنداتها</CardTitle></CardHeader>
          <CardContent>
            <p className="mb-3 text-xs text-muted-foreground">الإعادة عملية مالية مستقلة بإيصال قبض وقيد معاكس؛ لا يُفترض رجوع المال بمجرد إعادة المسيّر.</p>
            <ScrollTableShell>
              <table className="w-full text-xs"><thead className="bg-muted/50"><tr>
                <th className="p-2 text-right">الحدث/المستند</th><th className="p-2 text-right">الموظف</th><th className="p-2 text-right">المبلغ</th><th className="p-2 text-right">الطريقة/المرجع</th><th className="p-2 text-right">تاريخ الدفع</th><th className="p-2 text-center">الحالة</th><th className="p-2 text-right">المنفذ</th><th className="p-2"></th>
              </tr></thead><tbody>
                {salaryPaymentLedger.map((payment) => {
                  const event = eventById.get(Number(payment.eventId));
                  return <tr key={payment.eventId} className="border-t">
                    <td className="p-2"><div className="tabular-nums" dir="ltr">EV-{payment.eventId}</div><div className="text-muted-foreground tabular-nums" dir="ltr">REC-{payment.receiptId}</div></td>
                    <td className="p-2">{payment.employeeId ? (employeeName.get(Number(payment.employeeId)) ?? `موظف #${payment.employeeId}`) : "—"}</td>
                    <td className="p-2 tabular-nums" dir="ltr">{iqd(payment.amount)} د.ع</td>
                    <td className="p-2"><div>{payment.paymentMethod}</div><div className="text-muted-foreground" dir="ltr">{payment.referenceNumber || "—"}</div></td>
                    <td className="p-2 tabular-nums" dir="ltr">{payment.paymentDate ? String(payment.paymentDate).slice(0, 10) : "—"}</td>
                    <td className="p-2 text-center"><Badge status={payment.active ? "SETTLED" : "REVERSED"} /></td>
                    <td className="p-2 tabular-nums" dir="ltr">USER-{event?.createdBy ?? "—"}</td>
                    <td className="p-2 text-left">{payment.active && event && <Button size="sm" variant="outline" title={currentUserId === Number(event.createdBy) ? "يلزم مالك مستقل عن منفذ الدفعة" : undefined} disabled={!owner || currentUserId === Number(event.createdBy)} onClick={() => setAction({ type: "RETURN_SALARY", event })}><RotateCcw className="size-3.5" /> إعادة الدفعة</Button>}</td>
                  </tr>;
                })}
              </tbody></table>
            </ScrollTableShell>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div><CardTitle>تحويل الضريبة والضمان</CardTitle><p className="mt-1 text-xs text-muted-foreground">طلب موثق يصنعه موظف، يعتمده مالك مستقل، ثم يُدفع ويُخصّص على أقدم الالتزامات.</p></div>
          <span className="rounded-md border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">إنشاء الطلب من موظف الفرع؛ المالك يراجع ويعتمد بفصل مهام.</span>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2 text-xs">
            {statutoryByBranch.map((row) => <span key={`${row.branchId}:${row.kind}`} className="rounded-md border px-2 py-1">{branchName.get(row.branchId) ?? `فرع #${row.branchId}`} · {OBLIGATION_KIND_LABEL[row.kind]}: <b dir="ltr">{iqd(row.remaining)} د.ع</b></span>)}
          </div>
          <ScrollTableShell>
            <table className="w-full text-xs"><thead className="bg-muted/50"><tr>
              <th className="p-2 text-right">النوع</th><th className="p-2 text-right">الجهة/المرجع</th><th className="p-2 text-right">الفرع</th>
              <th className="p-2 text-right">المبلغ</th><th className="p-2 text-center">الحالة</th><th className="p-2 text-left">الإجراء</th>
            </tr></thead><tbody>
              {(remittancesQ.data ?? []).map((request) => {
                const independent = owner && currentUserId !== Number(request.createdBy);
                const canReturn = owner && currentUserId !== Number(request.createdBy) && currentUserId !== Number(request.paidBy ?? 0);
                return <tr key={request.id} className="border-t">
                  <td className="p-2">{OBLIGATION_KIND_LABEL[request.kind]}</td>
                  <td className="p-2"><div>{request.authorityName}</div><div className="text-muted-foreground" dir="ltr">{request.referenceNumber}</div></td>
                  <td className="p-2">{branchName.get(Number(request.payingBranchId)) ?? `فرع #${request.payingBranchId}`}</td>
                  <td className="p-2 tabular-nums" dir="ltr">{iqd(request.requestedAmount)}</td>
                  <td className="p-2 text-center"><Badge status={request.status} remittance /></td>
                  <td className="p-2"><div className="flex justify-end gap-1">
                    <RemittanceDocumentLink value={request.supportingDocumentUrl} />
                    {request.status === "PENDING" && <>
                      <Button size="sm" variant="outline" disabled={!independent || approveRemittance.isPending} onClick={async () => {
                        if (!(await confirm({ variant: "warning", title: "اعتماد طلب التحويل", description: "يعتمد الطلب فقط؛ لا يخرج مال حتى تنفيذ الدفع.", confirmText: "اعتماد" }))) return;
                        approveRemittance.mutate({ id: Number(request.id) });
                      }}><Check className="size-3.5" /> اعتماد</Button>
                      <Button size="sm" variant="outline" className="text-destructive" disabled={!independent} onClick={() => setAction({ type: "REJECT", request })}><X className="size-3.5" /> رفض</Button>
                    </>}
                    {request.status === "APPROVED" && <Button size="sm" disabled={!independent} onClick={() => setAction({ type: "PAY", request })}><Wallet className="size-3.5" /> دفع</Button>}
                    {request.status === "PAID" && <Button size="sm" variant="outline" disabled={!canReturn} onClick={() => setAction({ type: "RETURN", request })}><RotateCcw className="size-3.5" /> إعادة</Button>}
                  </div></td>
                </tr>;
              })}
              {!remittancesQ.isLoading && (remittancesQ.data ?? []).length === 0 && <tr><td colSpan={6} className="p-5 text-center text-muted-foreground">لا طلبات تحويل قانونية.</td></tr>}
            </tbody></table>
          </ScrollTableShell>
          {!owner && <p className="flex items-center gap-1 text-xs text-muted-foreground"><ShieldCheck className="size-3.5" /> إنشاء الطلب متاح، أما الاعتماد والدفع والإعادة فمحصورة بمالك نشط مستقل.</p>}
        </CardContent>
      </Card>

      <PayrollFinancialActionDialog action={action} onClose={() => setAction(null)} onDone={refreshAll} />
    </div>
  );
}

function AuditField({ label, value, title, ltr = false }: { label: string; value: string; title?: string; ltr?: boolean }) {
  return <div className="rounded-md border p-2"><div className="text-muted-foreground">{label}</div><div className="mt-1 font-medium tabular-nums" dir={ltr ? "ltr" : undefined} title={title}>{value}</div></div>;
}

/** لوحة صانع طلب التحويل: فرعية النطاق ولا تقرأ أي مسيّر أو راتب موظف. */
export function PayrollRemittanceRequestPanel() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchesQ = trpc.branches.list.useQuery();
  const statutorySummaryQ = trpc.payroll.statutoryObligationSummary.useQuery();
  const remittancesQ = trpc.payroll.remittances.useQuery();
  const [createOpen, setCreateOpen] = useState(false);
  const owner = me.data?.isOwner === true;
  const branchName = useMemo(
    () => new Map((branchesQ.data ?? []).map((branch) => [Number(branch.id), branch.name])),
    [branchesQ.data],
  );
  const statutoryOpen = statutorySummaryQ.data ?? [];
  const selectableBranches = owner || me.data?.role === "admin"
    ? (branchesQ.data ?? [])
    : (branchesQ.data ?? []).filter((branch) => Number(branch.id) === Number(me.data?.branchId));
  const refresh = async () => {
    await Promise.all([utils.payroll.statutoryObligationSummary.invalidate(), utils.payroll.remittances.invalidate()]);
  };

  return <Card>
    <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
      <div>
        <CardTitle>طلبات تحويل الضريبة والضمان</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">تظهر التزامات فرعك القانونية فقط. إنشاء الطلب لا يخرج نقداً؛ ينتظر اعتماد مالك مستقل.</p>
      </div>
      {!owner && <Button size="sm" onClick={() => setCreateOpen(true)} disabled={statutorySummaryQ.isLoading || statutoryOpen.length === 0}><FilePlus2 className="size-4" /> إنشاء طلب تحويل</Button>}
    </CardHeader>
    <CardContent className="space-y-3">
      {(statutorySummaryQ.isError || remittancesQ.isError) && <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">تعذر تحميل الالتزامات أو الطلبات. تحقق من صلاحية الموارد البشرية وأعد المحاولة.</p>}
      <ScrollTableShell>
        <table className="w-full text-xs"><thead className="bg-muted/50"><tr>
          <th className="p-2 text-right">النوع</th><th className="p-2 text-right">الجهة/المرجع</th><th className="p-2 text-right">الفرع</th><th className="p-2 text-right">المبلغ</th><th className="p-2 text-center">الحالة</th><th className="p-2 text-center">المستند</th>
        </tr></thead><tbody>
          {(remittancesQ.data ?? []).map((request) => <tr key={request.id} className="border-t">
            <td className="p-2">{OBLIGATION_KIND_LABEL[request.kind]}</td>
            <td className="p-2"><div>{request.authorityName}</div><div className="text-muted-foreground" dir="ltr">{request.referenceNumber}</div></td>
            <td className="p-2">{branchName.get(Number(request.payingBranchId)) ?? `فرع #${request.payingBranchId}`}</td>
            <td className="p-2 tabular-nums" dir="ltr">{iqd(request.requestedAmount)} د.ع</td>
            <td className="p-2 text-center"><Badge status={request.status} remittance /></td>
            <td className="p-2 text-center"><RemittanceDocumentLink value={request.supportingDocumentUrl} /></td>
          </tr>)}
          {!remittancesQ.isLoading && (remittancesQ.data ?? []).length === 0 && <tr><td colSpan={6} className="p-5 text-center text-muted-foreground">لا طلبات تحويل لفرعك.</td></tr>}
        </tbody></table>
      </ScrollTableShell>
      {!owner && statutoryOpen.length === 0 && !statutorySummaryQ.isLoading && <p className="text-xs text-muted-foreground">لا التزام ضريبة أو ضمان مفتوح يمكن إنشاء طلب تحويل له حالياً.</p>}
    </CardContent>
    <CreateRemittanceDialog open={createOpen} onClose={() => setCreateOpen(false)} branches={selectableBranches} obligations={statutoryOpen} onDone={refresh} />
  </Card>;
}

function CreateRemittanceDialog({
  open,
  onClose,
  branches,
  obligations,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  branches: RouterOutputs["branches"]["list"];
  obligations: StatutorySummary[];
  onDone: () => Promise<void> | void;
}) {
  const me = trpc.auth.me.useQuery(undefined, { enabled: open });
  const [kind, setKind] = useState<"INCOME_TAX" | "SOCIAL_SECURITY">("INCOME_TAX");
  const [branchId, setBranchId] = useState("");
  const [amount, setAmount] = useState("");
  const [authority, setAuthority] = useState("");
  const [reference, setReference] = useState("");
  const [documents, setDocuments] = useState<ImageItem[]>([]);
  const requestId = useRef(crypto.randomUUID());
  const create = trpc.payroll.createRemittance.useMutation({
    onSuccess: async (result) => {
      notify.ok(result.replayed ? "الطلب موجود مسبقاً ولم يتكرر" : "تم إنشاء طلب التحويل بانتظار اعتماد مستقل");
      requestId.current = crypto.randomUUID();
      setAmount(""); setAuthority(""); setReference(""); setDocuments([]);
      onClose(); await onDone();
    },
    onError: (error) => notify.err(error),
  });
  const selectedBranch = branchId || String(me.data?.branchId ?? branches[0]?.id ?? "");
  const available = obligations.find((row) =>
    row.kind === kind && Number(row.branchIdSnapshot) === Number(selectedBranch)
  )?.remainingAmount ?? "0";
  const valid = !!selectedBranch && D(amount || 0).gt(0) && D(amount || 0).lte(D(available)) && !!authority.trim() && !!reference.trim() && !!documents[0]?.dataUrl;

  return <Dialog open={open} onOpenChange={(value) => !value && onClose()}><DialogContent>
    <DialogHeader><DialogTitle>طلب تحويل استقطاعات قانونية</DialogTitle></DialogHeader>
    <div className="space-y-3 py-1">
      <div><Label htmlFor="remit-kind">نوع الالتزام</Label><AppSelect id="remit-kind" value={kind} onValueChange={(value) => setKind(value as typeof kind)} className="w-full"><option value="INCOME_TAX">ضريبة الدخل</option><option value="SOCIAL_SECURITY">الضمان الاجتماعي</option></AppSelect><p className="mt-1 text-xs text-muted-foreground">المتاح للتخصيص: {iqd(available)} د.ع</p></div>
      <div><Label htmlFor="remit-branch">فرع الدفع</Label><AppSelect id="remit-branch" value={selectedBranch} onValueChange={setBranchId} className="w-full">{branches.map((branch) => <option key={branch.id} value={String(branch.id)}>{branch.name}</option>)}</AppSelect></div>
      <div><Label htmlFor="remit-amount">المبلغ (د.ع)</Label><MoneyInput id="remit-amount" value={amount} onChange={setAmount} decimals={2} placeholder="0" ariaLabel="مبلغ التحويل" /></div>
      <div><Label htmlFor="remit-authority">الجهة المستلمة</Label><Input id="remit-authority" value={authority} onChange={(event) => setAuthority(event.target.value)} maxLength={200} placeholder="الجهة الضريبية أو دائرة الضمان" /></div>
      <div><Label htmlFor="remit-ref">رقم الكتاب/المطالبة</Label><Input id="remit-ref" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={100} dir="ltr" /></div>
      <div><Label>المستند المؤيد (إلزامي)</Label><ImageUploader value={documents} onChange={setDocuments} maxItems={1} maxSizeMB={2} singlePrimary={false} hint="صورة كتاب الجهة أو المطالبة الرسمية." /></div>
      <p className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">إنشاء الطلب لا يخرج نقداً. يلزم مالك مستقل للاعتماد ثم الدفع.</p>
    </div>
    <DialogFooter><Button variant="outline" onClick={onClose}>إلغاء</Button><Button disabled={!valid || create.isPending} onClick={() => create.mutate({ kind, payingBranchId: Number(selectedBranch), amount: D(amount).toFixed(2), authorityName: authority.trim(), referenceNumber: reference.trim(), supportingDocumentUrl: documents[0]!.dataUrl!, clientRequestId: requestId.current })}>{create.isPending ? "جارٍ الإنشاء…" : "إنشاء الطلب"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function PayrollFinancialActionDialog({
  action,
  onClose,
  onDone,
}: {
  action: { type: "REJECT" | "PAY" | "RETURN" | "RETURN_SALARY"; request?: Remittance; event?: PayrollEvent } | null;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [reason, setReason] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [date, setDate] = useState("");
  const [reference, setReference] = useState("");
  const done = async (message: string) => { notify.ok(message); setReason(""); setReference(""); setDate(""); onClose(); await onDone(); };
  const rejected = trpc.payroll.rejectRemittance.useMutation({ onSuccess: () => done("تم رفض الطلب مع حفظ السبب"), onError: (error) => notify.err(error) });
  const paid = trpc.payroll.payRemittance.useMutation({ onSuccess: () => done("تم دفع التحويل وتخصيصه على الالتزامات"), onError: (error) => notify.err(error) });
  const returned = trpc.payroll.returnRemittance.useMutation({ onSuccess: () => done("تمت إعادة التحويل وإعادة فتح الالتزامات"), onError: (error) => notify.err(error) });
  const salaryReturned = trpc.payroll.returnSalaryPayment.useMutation({ onSuccess: () => done("تم إثبات إعادة دفعة الراتب بإيصال قبض وقيد معاكس"), onError: (error) => notify.err(error) });
  const busy = rejected.isPending || paid.isPending || returned.isPending || salaryReturned.isPending;
  const nonCash = method !== "CASH";
  const requiresReason = action?.type === "REJECT" || action?.type === "RETURN" || action?.type === "RETURN_SALARY";
  const valid = !requiresReason || reason.trim().length >= 5;
  const paymentValid = action?.type !== "PAY" || !nonCash || (method === "CARD" ? /^\d{4}$/.test(reference.trim()) : !!reference.trim());
  const title = action?.type === "REJECT" ? "رفض طلب التحويل" : action?.type === "PAY" ? "دفع طلب التحويل" : action?.type === "RETURN" ? "إعادة تحويل مدفوع" : "إعادة دفعة راتب";

  return <Dialog open={!!action} onOpenChange={(value) => !value && onClose()}><DialogContent>
    <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
    <div className="space-y-3 py-1">
      {requiresReason && <div><Label htmlFor="payroll-action-reason">السبب (إلزامي، 5 أحرف على الأقل)</Label><Input id="payroll-action-reason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={255} /></div>}
      {action?.type === "PAY" && <div><Label htmlFor="payroll-remit-method">طريقة الدفع</Label><AppSelect id="payroll-remit-method" value={method} onValueChange={(value) => setMethod(value as PaymentMethod)} className="w-full"><option value="CASH">نقداً</option><option value="TRANSFER">تحويل مصرفي</option><option value="CARD">بطاقة/حساب مصرفي</option><option value="WALLET">محفظة دفع</option></AppSelect></div>}
      {action?.type !== "REJECT" && <div><Label htmlFor="payroll-action-date">تاريخ الحركة الفعلي</Label><Input id="payroll-action-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} dir="ltr" /><p className="mt-1 text-xs text-muted-foreground">فارغ = تاريخ بغداد اليوم.</p></div>}
      {action?.type !== "REJECT" && <div><Label htmlFor="payroll-action-ref">{action?.type === "PAY" && method === "CARD" ? "آخر أربعة أرقام للبطاقة (إلزامي)" : `مرجع الحركة ${action?.type === "PAY" && nonCash ? "(إلزامي)" : "(اختياري)"}`}</Label><Input id="payroll-action-ref" value={reference} onChange={(event) => setReference(action?.type === "PAY" && method === "CARD" ? event.target.value.replace(/\D/g, "").slice(0, 4) : event.target.value)} inputMode={action?.type === "PAY" && method === "CARD" ? "numeric" : undefined} maxLength={action?.type === "PAY" && method === "CARD" ? 4 : 100} dir="ltr" placeholder={action?.type === "PAY" && method === "CARD" ? "آخر 4 أرقام" : undefined} /></div>}
      <p className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">الخادم يعيد التحقق من الملكية وفصل الصانع عن المعتمد/الدافع داخل المعاملة الذرية.</p>
    </div>
    <DialogFooter><Button variant="outline" onClick={onClose}>إلغاء</Button><Button disabled={!valid || !paymentValid || busy} onClick={() => {
      if (!action) return;
      if (action.type === "REJECT" && action.request) rejected.mutate({ id: Number(action.request.id), reason: reason.trim() });
      if (action.type === "PAY" && action.request) paid.mutate({ requestId: Number(action.request.id), paymentMethod: method, paymentDate: date || null, referenceNumber: reference.trim() || null });
      if (action.type === "RETURN" && action.request) returned.mutate({ requestId: Number(action.request.id), reason: reason.trim(), returnedAt: date || null, referenceNumber: reference.trim() || null });
      if (action.type === "RETURN_SALARY" && action.event) salaryReturned.mutate({ accountingEventId: Number(action.event.id), reason: reason.trim(), returnedAt: date || null, referenceNumber: reference.trim() || null });
    }}>{busy ? "جارٍ التنفيذ…" : "تنفيذ"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
