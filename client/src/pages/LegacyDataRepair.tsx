import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Link2,
  RefreshCw,
  ShieldCheck,
  Truck,
  UserRoundSearch,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import { notify } from "@/lib/notify";
import { formatIqd } from "@/lib/money";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";

type Report = RouterOutputs["deliveryLegacyRepair"]["report"];
type RepairInput = RouterInputs["deliveryLegacyRepair"]["repair"];
type RepairAction = RepairInput["action"];

type RepairDialogState = {
  action: RepairAction;
  targetId: number;
  title: string;
  description: string;
  expectedConfirmation: string;
  partyId?: string;
  deliveryFee?: string;
  gatewayUserId?: string;
  deliveredAt?: string;
  evidenceRef?: string;
  customerBalanceAction?: "" | "IDENTITY_ONLY" | "ADD_OUTSTANDING";
  confirmation: string;
  note: string;
};

function fmtMoney(value: string | number | null | undefined) {
  return formatIqd(value ?? "0");
}

function fmtDate(value: Date | string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("ar-IQ");
}

function CountCard({ label, count, tone = "neutral" }: { label: string; count: number; tone?: "neutral" | "warn" }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={tone === "warn" ? "text-2xl font-bold tabular-nums text-[var(--sem-warn)]" : "text-2xl font-bold tabular-nums"}>
          {count.toLocaleString("ar-IQ")}
        </div>
      </CardContent>
    </Card>
  );
}

function FindingSection({
  title,
  description,
  count,
  children,
}: {
  title: string;
  description: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="border-b py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          </div>
          <Badge variant={count ? "destructive" : "secondary"}>{count.toLocaleString("ar-IQ")}</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {count ? children : (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-[var(--sem-pos)]" aria-hidden />
            لا توجد صفوف ضمن هذه الحالة.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TableShell({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm">{children}</table></div>;
}

const headCell = "border-b bg-muted/40 px-3 py-2 text-start text-xs font-medium text-muted-foreground";
const cell = "border-b px-3 py-2 align-top";

export default function LegacyDataRepair() {
  const [dialog, setDialog] = useState<RepairDialogState | null>(null);
  const reportQ = trpc.deliveryLegacyRepair.report.useQuery({}, { staleTime: 30_000 });
  const utils = trpc.useUtils();
  const repairM = trpc.deliveryLegacyRepair.repair.useMutation({
    onSuccess: async () => {
      notify.ok("تم تسجيل القرار وتنفيذ الإصلاح");
      setDialog(null);
      await utils.deliveryLegacyRepair.report.invalidate();
    },
    onError: (error) => notify.err(error),
  });
  const data = reportQ.data;
  const total = useMemo(() => data ? (
    data.closedWithoutConsignment.length
    + data.prepaidClosedWithoutProof.length
    + data.partialOutstanding.length
    + data.openPartiesWithoutGateway.length
    + data.invoicesMissingCustomer.length
  ) : 0, [data]);

  function openDialog(seed: Omit<RepairDialogState, "confirmation" | "note">) {
    setDialog({ ...seed, confirmation: "", note: "" });
  }

  function submitRepair() {
    if (!dialog) return;
    const deliveredAt = dialog.deliveredAt
      ? new Date(dialog.deliveredAt).toISOString()
      : null;
    repairM.mutate({
      action: dialog.action,
      targetId: dialog.targetId,
      confirmation: dialog.confirmation,
      note: dialog.note,
      partyId: dialog.partyId ? Number(dialog.partyId) : null,
      deliveryFee: dialog.deliveryFee === undefined ? null : dialog.deliveryFee,
      gatewayUserId: dialog.gatewayUserId ? Number(dialog.gatewayUserId) : null,
      deliveredAt,
      evidenceRef: dialog.evidenceRef?.trim() || null,
      customerBalanceAction: dialog.customerBalanceAction || null,
    });
  }

  if (reportQ.isLoading) return <LoadingState />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="معالجة بيانات التوصيل القديمة"
        description="تقرير إداري قراءةً أولاً. لا يوجد إصلاح جماعي؛ كل صف يُراجع ويُؤكد ويُسجل في سجل التدقيق منفرداً."
        actions={(
          <Button variant="outline" onClick={() => void reportQ.refetch()} disabled={reportQ.isFetching}>
            <RefreshCw className={reportQ.isFetching ? "size-4 animate-spin" : "size-4"} aria-hidden />
            تحديث الفحص
          </Button>
        )}
      />

      <div className="flex items-start gap-3 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-[var(--sem-warn)]" aria-hidden />
        <div>
          <div className="font-semibold">قاعدة التشغيل</div>
          <p className="mt-1 text-muted-foreground">
            اختيار جهة التوصيل وإثبات وصول العميل قراران تشغيليان لا يستنتجهما النظام. ستكتب مرجع الصف حرفياً قبل التنفيذ، ويُحفظ السبب والفاعل والتغيير في سجل التدقيق داخل المعاملة نفسها.
          </p>
        </div>
      </div>

      {reportQ.error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          تعذر تحميل التقرير: {reportQ.error.message}
        </div>
      )}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <CountCard label="إجمالي الصفوف" count={total} tone={total ? "warn" : "neutral"} />
            <CountCard label="طلب بلا إرسالية" count={data.closedWithoutConsignment.length} />
            <CountCard label="مدفوع بلا إثبات" count={data.prepaidClosedWithoutProof.length} />
            <CountCard label="جزئي مفتوح" count={data.partialOutstanding.length} />
            <CountCard label="جهة بلا بوابة" count={data.openPartiesWithoutGateway.length} />
            <CountCard label="فاتورة بلا عميل" count={data.invoicesMissingCustomer.length} />
          </div>

          <FindingSection
            title="طلبات توصيل أُغلقت بلا إرسالية"
            description="الإصلاح ينشئ إرسالية مفتوحة على جهة تختارها أنت؛ لا يثبت وصول العميل."
            count={data.closedWithoutConsignment.length}
          >
            <TableShell>
              <thead><tr><th className={headCell}>الطلب</th><th className={headCell}>الفاتورة</th><th className={headCell}>المستلم/العنوان</th><th className={headCell}>أغلق في</th><th className={headCell}>الإجراء</th></tr></thead>
              <tbody>{data.closedWithoutConsignment.map((row) => (
                <tr key={row.id}>
                  <td className={cell}><div className="font-medium">{row.orderNumber}</div><div className="text-xs text-muted-foreground">فرع {row.branchId}</div></td>
                  <td className={cell}>{row.invoiceNumber ?? `#${row.invoiceId ?? "—"}`}</td>
                  <td className={cell}><div>{row.contactName ?? "—"}</div><div className="max-w-xs text-xs text-muted-foreground">{row.deliveryAddress ?? "بلا عنوان محفوظ"}</div></td>
                  <td className={cell}>{fmtDate(row.deliveredAt)}</td>
                  <td className={cell}>
                    <Button size="sm" onClick={() => openDialog({
                      action: "CREATE_MISSING_CONSIGNMENT",
                      targetId: row.id,
                      title: "إنشاء الإرسالية المفقودة",
                      description: "اختر الجهة والأجرة صراحةً. ستنشأ الإرسالية DISPATCHED بلا ختم تسليم.",
                      expectedConfirmation: row.orderNumber,
                      deliveryFee: String(row.deliveryCost ?? "0"),
                    })}>
                      <Truck className="size-4" aria-hidden />
                      معالجة
                    </Button>
                  </td>
                </tr>
              ))}</tbody>
            </TableShell>
          </FindingSection>

          <FindingSection
            title="إرساليات مدفوعة أُغلقت بلا إثبات تسليم"
            description="إما إدخال ختم ومرجع إثبات حقيقيين، أو إعادة الإرسالية إلى حالة قيد التوصيل."
            count={data.prepaidClosedWithoutProof.length}
          >
            <TableShell>
              <thead><tr><th className={headCell}>الإرسالية</th><th className={headCell}>الطلب</th><th className={headCell}>الجهة</th><th className={headCell}>الإرسال</th><th className={headCell}>الإجراء</th></tr></thead>
              <tbody>{data.prepaidClosedWithoutProof.map((row) => (
                <tr key={row.id}>
                  <td className={cell}><div className="font-medium">{row.consignmentNumber}</div><Badge variant="outline">COD = 0</Badge></td>
                  <td className={cell}>{row.orderNumber ?? `#${row.workOrderId ?? "—"}`}</td>
                  <td className={cell}>{row.partyName}</td>
                  <td className={cell}>{fmtDate(row.dispatchedAt)}</td>
                  <td className={`${cell} space-x-2 space-x-reverse`}>
                    <Button size="sm" onClick={() => openDialog({
                      action: "RECORD_PREPAID_DELIVERY_PROOF",
                      targetId: row.id,
                      title: "تسجيل إثبات التسليم",
                      description: "أدخل الوقت والمرجع من مستند/اتصال تشغيلي حقيقي. لا يملأ النظام أياً منهما.",
                      expectedConfirmation: row.consignmentNumber,
                      deliveredAt: "",
                      evidenceRef: "",
                    })}>
                      <ClipboardCheck className="size-4" aria-hidden />
                      إثبات التسليم
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openDialog({
                      action: "REOPEN_PREPAID_CONSIGNMENT",
                      targetId: row.id,
                      title: "إعادة فتح الإرسالية",
                      description: "يُعاد الصف إلى DISPATCHED ليظهر في العمل الميداني؛ لا يُسجل إثبات تسليم.",
                      expectedConfirmation: row.consignmentNumber,
                    })}>
                      إعادة فتح
                    </Button>
                  </td>
                </tr>
              ))}</tbody>
            </TableShell>
          </FindingSection>

          <FindingSection
            title="إرساليات PARTIAL برصيد مفتوح"
            description="هذه ليست تسوية تلقائية. يسجل الإجراء أن المسؤول راجع الرصيد وأبقاه مفتوحاً للتحصيل."
            count={data.partialOutstanding.length}
          >
            <TableShell>
              <thead><tr><th className={headCell}>الإرسالية</th><th className={headCell}>الجهة</th><th className={headCell}>المطلوب</th><th className={headCell}>المحصّل</th><th className={headCell}>المتبقي</th><th className={headCell}>المراجعة</th></tr></thead>
              <tbody>{data.partialOutstanding.map((row) => (
                <tr key={row.id}>
                  <td className={cell}>{row.consignmentNumber}</td>
                  <td className={cell}>{row.partyName}</td>
                  <td className={cell}>{fmtMoney(row.codAmount)}</td>
                  <td className={cell}>{fmtMoney(row.collectedAmount)}</td>
                  <td className={`${cell} font-medium text-[var(--sem-warn)]`}>{fmtMoney(row.remainingAmount)}</td>
                  <td className={cell}>{row.reviewedAt ? (
                    <Badge variant="secondary">رُوجعت {fmtDate(row.reviewedAt)}</Badge>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => openDialog({
                      action: "ACKNOWLEDGE_PARTIAL_OUTSTANDING",
                      targetId: row.id,
                      title: "تسجيل مراجعة الرصيد الجزئي",
                      description: "لن يتغير المبلغ أو الحالة؛ يُسجل قرار إبقاء المتبقي للتحصيل مرة واحدة.",
                      expectedConfirmation: row.consignmentNumber,
                    })}>تسجيل المراجعة</Button>
                  )}</td>
                </tr>
              ))}</tbody>
            </TableShell>
          </FindingSection>

          <FindingSection
            title="جهات عليها أعمال مفتوحة بلا حساب بوابة"
            description="اربط حساب مندوب صراحةً، أو سجل أنها جهة خارجية ستعمل بلا دخول للنظام."
            count={data.openPartiesWithoutGateway.length}
          >
            <TableShell>
              <thead><tr><th className={headCell}>الجهة</th><th className={headCell}>النوع</th><th className={headCell}>المفتوح</th><th className={headCell}>الأقدم</th><th className={headCell}>الإجراء</th></tr></thead>
              <tbody>{data.openPartiesWithoutGateway.map((row) => (
                <tr key={row.id}>
                  <td className={cell}><div className="font-medium">{row.name}</div><div className="text-xs text-muted-foreground">#{row.id}</div></td>
                  <td className={cell}>{row.partyType === "COMPANY" ? "شركة" : "مندوب فرد"}</td>
                  <td className={cell}>{row.openCount.toLocaleString("ar-IQ")}</td>
                  <td className={cell}>{fmtDate(row.oldestOpenAt)}</td>
                  <td className={`${cell} space-x-2 space-x-reverse`}>
                    <Button size="sm" onClick={() => openDialog({
                      action: "LINK_GATEWAY_ACCOUNT",
                      targetId: row.id,
                      title: "ربط حساب البوابة",
                      description: "اختر حساب مندوب نشطاً وغير مرتبط بجهة أخرى.",
                      expectedConfirmation: row.name,
                      gatewayUserId: "",
                    })}>
                      <Link2 className="size-4" aria-hidden />
                      ربط حساب
                    </Button>
                    {!row.reviewedAt && (
                      <Button variant="outline" size="sm" onClick={() => openDialog({
                        action: "CONFIRM_EXTERNAL_WITHOUT_GATEWAY",
                        targetId: row.id,
                        title: "اعتماد جهة خارجية بلا بوابة",
                        description: "يسجل القرار فقط؛ تبقى الجهة بلا حساب ويجب متابعة إرسالياتها إدارياً.",
                        expectedConfirmation: row.name,
                      })}>جهة خارجية</Button>
                    )}
                    {row.reviewedAt && <Badge variant="secondary">قرار مسجل</Badge>}
                  </td>
                </tr>
              ))}</tbody>
            </TableShell>
          </FindingSection>

          <FindingSection
            title="فواتير توصيل فقدت هوية العميل"
            description="يعيد customerId من أمر الشغل المعروف؛ أثر الذمة قرار صريح لأن السجل القديم لا يثبت إن كانت أضيفت سابقاً."
            count={data.invoicesMissingCustomer.length}
          >
            <TableShell>
              <thead><tr><th className={headCell}>الفاتورة</th><th className={headCell}>الطلب</th><th className={headCell}>العميل المصدر</th><th className={headCell}>الإجمالي</th><th className={headCell}>المدفوع</th><th className={headCell}>المتبقي</th><th className={headCell}>الإجراء</th></tr></thead>
              <tbody>{data.invoicesMissingCustomer.map((row) => (
                <tr key={row.id}>
                  <td className={cell}>{row.invoiceNumber}</td>
                  <td className={cell}>{row.orderNumber}</td>
                  <td className={cell}>
                    <div>{row.customerName}</div>
                    <div className="text-xs text-muted-foreground">#{row.customerId} · الذمة الحالية {fmtMoney(row.customerCurrentBalance)}</div>
                  </td>
                  <td className={cell}>{fmtMoney(row.total)}</td>
                  <td className={cell}>{fmtMoney(row.paidAmount)}</td>
                  <td className={`${cell} font-medium`}>{fmtMoney(row.outstandingAmount)}</td>
                  <td className={cell}>
                    <Button size="sm" onClick={() => openDialog({
                      action: "RESTORE_INVOICE_CUSTOMER",
                      targetId: row.id,
                      title: "استعادة هوية عميل الفاتورة",
                      description: `المصدر هو أمر الشغل ${row.orderNumber} وعميله المحفوظ ${row.customerName}. المتبقي المرصود ${fmtMoney(row.outstandingAmount)}؛ قرر بعد مراجعة الذمة إن كان سيُضاف.`,
                      expectedConfirmation: row.invoiceNumber,
                      customerBalanceAction: "",
                    })}>
                      <UserRoundSearch className="size-4" aria-hidden />
                      استعادة العميل
                    </Button>
                  </td>
                </tr>
              ))}</tbody>
            </TableShell>
          </FindingSection>
        </>
      )}

      <RepairDialog
        state={dialog}
        report={data}
        pending={repairM.isPending}
        onChange={setDialog}
        onSubmit={submitRepair}
      />
    </div>
  );
}

function RepairDialog({
  state,
  report,
  pending,
  onChange,
  onSubmit,
}: {
  state: RepairDialogState | null;
  report: Report | undefined;
  pending: boolean;
  onChange: (next: RepairDialogState | null) => void;
  onSubmit: () => void;
}) {
  const patch = (value: Partial<RepairDialogState>) => state && onChange({ ...state, ...value });
  const confirmationMatches = Boolean(state && state.confirmation.trim() === state.expectedConfirmation.trim());
  const needsParty = state?.action === "CREATE_MISSING_CONSIGNMENT";
  const needsGateway = state?.action === "LINK_GATEWAY_ACCOUNT";
  const needsProof = state?.action === "RECORD_PREPAID_DELIVERY_PROOF";
  const needsCustomerBalanceDecision = state?.action === "RESTORE_INVOICE_CUSTOMER";
  const inputsReady = Boolean(
    state
    && state.note.trim().length >= 5
    && confirmationMatches
    && (!needsParty || (state.partyId && state.deliveryFee !== ""))
    && (!needsGateway || state.gatewayUserId)
    && (!needsProof || (state.deliveredAt && state.evidenceRef?.trim()))
    && (!needsCustomerBalanceDecision || state.customerBalanceAction),
  );

  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => !open && !pending && onChange(null)}>
      <DialogContent className="sm:max-w-xl">
        {state && (
          <>
            <DialogHeader>
              <DialogTitle>{state.title}</DialogTitle>
              <DialogDescription>{state.description}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {needsParty && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="legacy-party">جهة التوصيل المختارة</Label>
                    <select id="legacy-party" value={state.partyId ?? ""} onChange={(event) => patch({ partyId: event.target.value })} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                      <option value="">اختر الجهة…</option>
                      {(report?.options.parties ?? []).map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="legacy-fee">أجرة التوصيل المثبتة</Label>
                    <MoneyInput id="legacy-fee" value={state.deliveryFee ?? ""} onChange={(deliveryFee) => patch({ deliveryFee })} ariaLabel="أجرة التوصيل المثبتة" />
                  </div>
                </div>
              )}

              {needsGateway && (
                <div className="space-y-1.5">
                  <Label htmlFor="legacy-gateway">حساب المندوب</Label>
                  <select id="legacy-gateway" value={state.gatewayUserId ?? ""} onChange={(event) => patch({ gatewayUserId: event.target.value })} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                    <option value="">اختر حساباً نشطاً…</option>
                    {(report?.options.courierAccounts ?? []).map((account) => (
                      <option key={account.id} value={account.id} disabled={account.linkedPartyId != null}>
                        {account.name ?? account.username ?? `#${account.id}`}{account.linkedPartyId != null ? " — مرتبط" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {needsProof && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="legacy-delivered-at">وقت التسليم المثبت</Label>
                    <Input id="legacy-delivered-at" type="datetime-local" value={state.deliveredAt ?? ""} onChange={(event) => patch({ deliveredAt: event.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="legacy-evidence">مرجع الإثبات</Label>
                    <Input id="legacy-evidence" placeholder="رقم وصل، سجل اتصال، أو مستند" value={state.evidenceRef ?? ""} onChange={(event) => patch({ evidenceRef: event.target.value })} />
                  </div>
                </div>
              )}

              {needsCustomerBalanceDecision && (
                <div className="space-y-1.5">
                  <Label htmlFor="legacy-customer-balance">قرار ذمة العميل</Label>
                  <select
                    id="legacy-customer-balance"
                    value={state.customerBalanceAction ?? ""}
                    onChange={(event) => patch({ customerBalanceAction: event.target.value as RepairDialogState["customerBalanceAction"] })}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">اختر بعد مراجعة السجل…</option>
                    <option value="IDENTITY_ONLY">استعادة الهوية فقط — الذمة مسجلة مسبقاً</option>
                    <option value="ADD_OUTSTANDING">استعادة الهوية وإضافة المتبقي — الذمة غير مسجلة</option>
                  </select>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="legacy-note">سبب القرار ومصدره</Label>
                <Textarea id="legacy-note" rows={3} maxLength={500} placeholder="دوّن ما راجعته ولماذا هذا الإجراء صحيح…" value={state.note} onChange={(event) => patch({ note: event.target.value })} />
              </div>

              <div className="space-y-1.5 rounded-md border p-3">
                <div className="flex items-start gap-2 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--sem-warn)]" aria-hidden />
                  <p>للتأكيد اكتب المرجع التالي حرفياً: <strong dir="ltr">{state.expectedConfirmation}</strong></p>
                </div>
                <Input aria-label="تأكيد مرجع الصف" value={state.confirmation} onChange={(event) => patch({ confirmation: event.target.value })} autoComplete="off" />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onChange(null)} disabled={pending}>إلغاء</Button>
              <Button onClick={onSubmit} disabled={!inputsReady || pending}>
                {pending ? "جارٍ التنفيذ…" : "تأكيد وتنفيذ الإصلاح"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
