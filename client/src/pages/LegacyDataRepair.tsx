import { useMemo, useState, type ReactNode } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
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
import { D, formatIqd } from "@/lib/money";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { RowActions } from "@/components/list/RowActions";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";

type Report = RouterOutputs["deliveryLegacyRepair"]["report"];
type ClosedWithoutConsignmentRow = Report["closedWithoutConsignment"][number];
type PrepaidWithoutProofRow = Report["prepaidClosedWithoutProof"][number];
type PartialOutstandingRow = Report["partialOutstanding"][number];
type PartyWithoutGatewayRow = Report["openPartiesWithoutGateway"][number];
type InvoiceMissingCustomerRow = Report["invoicesMissingCustomer"][number];
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
  feeSettlementAction?: "" | "EARN_ONLY" | "EARN_AND_DIRECT_PAID";
  proofDeliveryFee?: string;
  proofFeeCollection?: "COURIER" | "COUNTER" | "SHOP";
  customerBalanceAction?: "" | "IDENTITY_ONLY" | "ADD_OUTSTANDING";
  confirmation: string;
  note: string;
};

function fmtMoney(value: string | number | null | undefined) {
  return formatIqd(value ?? "0");
}

function fmtDate(value: Date | string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("ar-IQ-u-nu-latn");
}

function CountCard({ label, count, tone = "neutral" }: { label: string; count: number; tone?: "neutral" | "warn" }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={tone === "warn" ? "text-2xl font-bold tabular-nums text-[var(--sem-warn)]" : "text-2xl font-bold tabular-nums"}>
          {count.toLocaleString("ar-IQ-u-nu-latn")}
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
          <Badge variant={count ? "destructive" : "secondary"}>{count.toLocaleString("ar-IQ-u-nu-latn")}</Badge>
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

/* جداولُ الأقسام مُضمَّنة في بطاقاتٍ تحمل عناوينها وعدَّها — شريطُ حالةٍ لكلٍّ منها ضجيجٌ لا معلومة. */
const FINDING_TABLE = { embedded: true, searchable: false, bounded: false, pageSize: Infinity } as const;

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
      feeSettlementAction: dialog.feeSettlementAction || null,
      customerBalanceAction: dialog.customerBalanceAction || null,
    });
  }

  /*
   * أعمدة الأقسام الخمسة. تُبنى في كل تصيير لأنّها تُغلِق على `openDialog` (حوارُ الإصلاح
   * الفرديّ) — وتجميدُها بمصفوفة تبعيّاتٍ ناقصة يُنتج إجراءات تعمل على حالةٍ قديمة.
   */
  const closedWithoutConsignmentColumns: ColumnDef<ClosedWithoutConsignmentRow, unknown>[] = [
    {
      id: "order",
      header: "الطلب",
      accessorFn: (r) => r.orderNumber,
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.orderNumber}</div>
          <div className="text-xs text-muted-foreground">فرع {row.original.branchId}</div>
        </div>
      ),
    },
    {
      id: "invoice",
      header: "الفاتورة",
      accessorFn: (r) => r.invoiceNumber ?? "#" + (r.invoiceId ?? "—"),
      meta: { kind: "code" },
      cell: ({ row }) => row.original.invoiceNumber ?? "#" + (row.original.invoiceId ?? "—"),
    },
    {
      id: "contact",
      header: "المستلم/العنوان",
      accessorFn: (r) => (r.contactName ?? "—") + " — " + (r.deliveryAddress ?? "بلا عنوان محفوظ"),
      meta: { width: "wide", wrap: true },
      cell: ({ row }) => (
        <div>
          <div>{row.original.contactName ?? "—"}</div>
          <div className="max-w-xs text-xs text-muted-foreground">{row.original.deliveryAddress ?? "بلا عنوان محفوظ"}</div>
        </div>
      ),
    },
    { id: "deliveredAt", header: "أغلق في", accessorFn: (r) => fmtDate(r.deliveredAt), meta: { kind: "date" }, cell: ({ row }) => fmtDate(row.original.deliveredAt) },
    {
      id: "actions",
      header: "الإجراء",
      meta: { kind: "actions" },
      enableSorting: false,
      cell: ({ row }) => (
        <RowActions mode="inline" actions={[{
          key: "create-missing-consignment",
          kind: "edit",
          label: "معالجة",
          icon: Truck,
          gate: { module: "reports", level: "FULL" },
          onSelect: () => openDialog({
            action: "CREATE_MISSING_CONSIGNMENT",
            targetId: row.original.id,
            title: "إنشاء الإرسالية المفقودة",
            description: "اختر الجهة والأجرة صراحةً. ستنشأ الإرسالية DISPATCHED بلا ختم تسليم.",
            expectedConfirmation: row.original.orderNumber,
            deliveryFee: String(row.original.deliveryCost ?? "0"),
          }),
        }]} />
      ),
    },
  ];

  const prepaidWithoutProofColumns: ColumnDef<PrepaidWithoutProofRow, unknown>[] = [
    {
      id: "consignment",
      header: "الإرسالية",
      accessorFn: (r) => r.consignmentNumber,
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.consignmentNumber}</div>
          <Badge variant="outline">COD = 0</Badge>
        </div>
      ),
    },
    {
      id: "order",
      header: "الطلب",
      accessorFn: (r) => r.orderNumber ?? "#" + (r.workOrderId ?? "—"),
      meta: { kind: "code" },
      cell: ({ row }) => row.original.orderNumber ?? "#" + (row.original.workOrderId ?? "—"),
    },
    { id: "party", header: "الجهة", accessorFn: (r) => r.partyName, cell: ({ row }) => row.original.partyName },
    { id: "dispatchedAt", header: "الإرسال", accessorFn: (r) => fmtDate(r.dispatchedAt), meta: { kind: "date" }, cell: ({ row }) => fmtDate(row.original.dispatchedAt) },
    {
      id: "actions",
      header: "الإجراء",
      meta: { kind: "actions" },
      enableSorting: false,
      cell: ({ row }) => (
        <RowActions mode="inline" actions={[
          {
            key: "record-proof",
            kind: "approve",
            label: "إثبات التسليم",
            icon: ClipboardCheck,
            gate: { module: "reports", level: "FULL" },
            onSelect: () => openDialog({
              action: "RECORD_PREPAID_DELIVERY_PROOF",
              targetId: row.original.id,
              title: "تسجيل إثبات التسليم",
              description: "أدخل الوقت والمرجع من مستند/اتصال تشغيلي حقيقي. لا يملأ النظام أياً منهما.",
              expectedConfirmation: row.original.consignmentNumber,
              deliveredAt: "",
              evidenceRef: "",
              feeSettlementAction: "",
              proofDeliveryFee: row.original.deliveryFee,
              proofFeeCollection: row.original.feeCollection,
            }),
          },
          ...(row.original.parcelStatus === "DELIVERED" ? [{
            key: "reopen",
            kind: "edit" as const,
            label: "إعادة فتح",
            icon: RefreshCw,
            gate: { module: "reports" as const, level: "FULL" as const },
            onSelect: () => openDialog({
              action: "REOPEN_PREPAID_CONSIGNMENT" as const,
              targetId: row.original.id,
              title: "إعادة فتح الإرسالية",
              description: "يُعاد الصف إلى DISPATCHED ليظهر في العمل الميداني؛ لا يُسجل إثبات تسليم.",
              expectedConfirmation: row.original.consignmentNumber,
            }),
          }] : []),
        ]} />
      ),
    },
  ];

  const partialOutstandingColumns: ColumnDef<PartialOutstandingRow, unknown>[] = [
    { id: "consignment", header: "الإرسالية", accessorFn: (r) => r.consignmentNumber, meta: { kind: "code" }, cell: ({ row }) => row.original.consignmentNumber },
    { id: "party", header: "الجهة", accessorFn: (r) => r.partyName, cell: ({ row }) => row.original.partyName },
    { id: "cod", header: "المطلوب", accessorFn: (r) => fmtMoney(r.codAmount), meta: { kind: "money" }, cell: ({ row }) => fmtMoney(row.original.codAmount) },
    { id: "collected", header: "المحصّل", accessorFn: (r) => fmtMoney(r.collectedAmount), meta: { kind: "money" }, cell: ({ row }) => fmtMoney(row.original.collectedAmount) },
    {
      id: "remaining",
      header: "المتبقي",
      accessorFn: (r) => fmtMoney(r.remainingAmount),
      meta: { kind: "money" },
      cell: ({ row }) => <span className="font-medium text-[var(--sem-warn)]">{fmtMoney(row.original.remainingAmount)}</span>,
    },
    {
      id: "review",
      header: "المراجعة",
      accessorFn: (r) =>
        r.remittanceTraceMissing ? "أثر التوريد مفقود — يلزم تحقيق مستقل" : r.reviewedAt ? "رُوجعت " + fmtDate(r.reviewedAt) : "بلا مراجعة",
      meta: { width: "wide", wrap: true },
      enableSorting: false,
      cell: ({ row }) =>
        row.original.remittanceTraceMissing ? (
          <Badge variant="destructive">أثر التوريد مفقود — يلزم تحقيق مستقل</Badge>
        ) : row.original.reviewedAt ? (
          <Badge variant="secondary">رُوجعت {fmtDate(row.original.reviewedAt)}</Badge>
        ) : (
          <RowActions mode="inline" actions={[{
            key: "acknowledge-partial",
            kind: "approve",
            label: "تسجيل المراجعة",
            icon: ClipboardCheck,
            gate: { module: "reports", level: "FULL" },
            onSelect: () => openDialog({
              action: "ACKNOWLEDGE_PARTIAL_OUTSTANDING",
              targetId: row.original.id,
              title: "تسجيل مراجعة الرصيد الجزئي",
              description: "لن يتغير المبلغ أو الحالة؛ يُسجل قرار إبقاء المتبقي للتحصيل مرة واحدة.",
              expectedConfirmation: row.original.consignmentNumber,
            }),
          }]} />
        ),
    },
  ];

  const partiesWithoutGatewayColumns: ColumnDef<PartyWithoutGatewayRow, unknown>[] = [
    {
      id: "party",
      header: "الجهة",
      accessorFn: (r) => r.name,
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.name}</div>
          <div className="text-xs text-muted-foreground">#{row.original.id}</div>
        </div>
      ),
    },
    {
      id: "partyType",
      header: "النوع",
      accessorFn: (r) => (r.partyType === "COMPANY" ? "شركة" : "مندوب فرد"),
      cell: ({ row }) => (row.original.partyType === "COMPANY" ? "شركة" : "مندوب فرد"),
    },
    {
      id: "openCount",
      header: "المفتوح",
      accessorFn: (r) => r.openCount,
      meta: { kind: "number" },
      cell: ({ row }) => row.original.openCount.toLocaleString("ar-IQ-u-nu-latn"),
    },
    { id: "oldest", header: "الأقدم", accessorFn: (r) => fmtDate(r.oldestOpenAt), meta: { kind: "date" }, cell: ({ row }) => fmtDate(row.original.oldestOpenAt) },
    {
      id: "actions",
      header: "الإجراء",
      meta: { kind: "actions" },
      enableSorting: false,
      cell: ({ row }) => (
        <div className="space-x-2 space-x-reverse">
          <RowActions mode="inline" actions={[
            {
              key: "link-gateway",
              kind: "edit",
              label: "ربط حساب",
              icon: Link2,
              gate: { module: "reports", level: "FULL" },
              onSelect: () => openDialog({
                action: "LINK_GATEWAY_ACCOUNT",
                targetId: row.original.id,
                title: "ربط حساب البوابة",
                description: "اختر حساب مندوب نشطاً وغير مرتبط بجهة أخرى.",
                expectedConfirmation: row.original.name,
                gatewayUserId: "",
              }),
            },
            ...(!row.original.reviewedAt ? [{
              key: "confirm-external",
              kind: "approve" as const,
              label: "جهة خارجية",
              icon: ShieldCheck,
              gate: { module: "reports" as const, level: "FULL" as const },
              onSelect: () => openDialog({
                action: "CONFIRM_EXTERNAL_WITHOUT_GATEWAY" as const,
                targetId: row.original.id,
                title: "اعتماد جهة خارجية بلا بوابة",
                description: "يسجل القرار فقط؛ تبقى الجهة بلا حساب ويجب متابعة إرسالياتها إدارياً.",
                expectedConfirmation: row.original.name,
              }),
            }] : []),
          ]} />
          {row.original.reviewedAt && <Badge variant="secondary">قرار مسجل</Badge>}
        </div>
      ),
    },
  ];

  const invoicesMissingCustomerColumns: ColumnDef<InvoiceMissingCustomerRow, unknown>[] = [
    { id: "invoice", header: "الفاتورة", accessorFn: (r) => r.invoiceNumber, meta: { kind: "code" }, cell: ({ row }) => row.original.invoiceNumber },
    { id: "order", header: "الطلب", accessorFn: (r) => r.orderNumber, meta: { kind: "code" }, cell: ({ row }) => row.original.orderNumber },
    {
      id: "customer",
      header: "العميل المصدر",
      accessorFn: (r) => r.customerName,
      meta: { width: "wide", wrap: true },
      cell: ({ row }) => (
        <div>
          <div>{row.original.customerName}</div>
          <div className="text-xs text-muted-foreground">
            #{row.original.customerId} · الذمة الحالية {fmtMoney(row.original.customerCurrentBalance)}
          </div>
        </div>
      ),
    },
    { id: "total", header: "الإجمالي", accessorFn: (r) => fmtMoney(r.total), meta: { kind: "money" }, cell: ({ row }) => fmtMoney(row.original.total) },
    { id: "paid", header: "المدفوع", accessorFn: (r) => fmtMoney(r.paidAmount), meta: { kind: "money" }, cell: ({ row }) => fmtMoney(row.original.paidAmount) },
    {
      id: "outstanding",
      header: "المتبقي",
      accessorFn: (r) => fmtMoney(r.outstandingAmount),
      meta: { kind: "money" },
      cell: ({ row }) => <span className="font-medium">{fmtMoney(row.original.outstandingAmount)}</span>,
    },
    {
      id: "actions",
      header: "الإجراء",
      meta: { kind: "actions" },
      enableSorting: false,
      cell: ({ row }) => (
        <RowActions mode="inline" actions={[{
          key: "restore-customer",
          kind: "correct",
          label: "استعادة العميل",
          icon: UserRoundSearch,
          gate: { module: "reports", level: "FULL" },
          onSelect: () => openDialog({
            action: "RESTORE_INVOICE_CUSTOMER",
            targetId: row.original.id,
            title: "استعادة هوية عميل الفاتورة",
            description: `المصدر هو أمر الشغل ${row.original.orderNumber} وعميله المحفوظ ${row.original.customerName}. المتبقي المرصود ${fmtMoney(row.original.outstandingAmount)}؛ قرر بعد مراجعة الذمة إن كان سيُضاف.`,
            expectedConfirmation: row.original.invoiceNumber,
            customerBalanceAction: "",
          }),
        }]} />
      ),
    },
  ];

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
            <DataTable<ClosedWithoutConsignmentRow>
              {...FINDING_TABLE}
              data={data.closedWithoutConsignment}
              columns={closedWithoutConsignmentColumns}
            />
          </FindingSection>

          <FindingSection
            title="إرساليات مدفوعة بلا إثبات تسليم"
            description="الإرسالية القديمة المغلقة يمكن إعادة فتحها؛ والإرسالية التي أنشأها الإصلاح تبقى مفتوحة حتى إدخال ختم ومرجع إثبات حقيقيين."
            count={data.prepaidClosedWithoutProof.length}
          >
            <DataTable<PrepaidWithoutProofRow>
              {...FINDING_TABLE}
              data={data.prepaidClosedWithoutProof}
              columns={prepaidWithoutProofColumns}
            />
          </FindingSection>

          <FindingSection
            title="إرساليات PARTIAL برصيد مفتوح"
            description="هذه ليست تسوية تلقائية. يسجل الإجراء أن المسؤول راجع الرصيد وأبقاه مفتوحاً للتحصيل."
            count={data.partialOutstanding.length}
          >
            <DataTable<PartialOutstandingRow>
              {...FINDING_TABLE}
              data={data.partialOutstanding}
              columns={partialOutstandingColumns}
            />
          </FindingSection>

          <FindingSection
            title="جهات عليها أعمال مفتوحة بلا حساب بوابة"
            description="اربط حساب مندوب صراحةً، أو سجل أنها جهة خارجية ستعمل بلا دخول للنظام."
            count={data.openPartiesWithoutGateway.length}
          >
            <DataTable<PartyWithoutGatewayRow>
              {...FINDING_TABLE}
              data={data.openPartiesWithoutGateway}
              columns={partiesWithoutGatewayColumns}
            />
          </FindingSection>

          <FindingSection
            title="فواتير توصيل فقدت هوية العميل"
            description="يعيد customerId من أمر الشغل المعروف؛ أثر الذمة قرار صريح لأن السجل القديم لا يثبت إن كانت أضيفت سابقاً."
            count={data.invoicesMissingCustomer.length}
          >
            <DataTable<InvoiceMissingCustomerRow>
              {...FINDING_TABLE}
              data={data.invoicesMissingCustomer}
              columns={invoicesMissingCustomerColumns}
            />
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
  const needsFeeDecision = needsProof && D(state?.proofDeliveryFee ?? "0").gt(0);
  const needsCustomerBalanceDecision = state?.action === "RESTORE_INVOICE_CUSTOMER";
  const inputsReady = Boolean(
    state
    && state.note.trim().length >= 5
    && confirmationMatches
    && (!needsParty || (state.partyId && state.deliveryFee !== ""))
    && (!needsGateway || state.gatewayUserId)
    && (!needsProof || (state.deliveredAt && state.evidenceRef?.trim()))
    && (!needsFeeDecision || state.feeSettlementAction)
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
                    <AppSelect id="legacy-party" value={state.partyId ?? ""} onValueChange={(next) => patch({ partyId: next })} className="h-10 border-input px-3 text-sm">
                      <option value="">اختر الجهة…</option>
                      {(report?.options.parties ?? []).map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}
                    </AppSelect>
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
                  <AppSelect id="legacy-gateway" value={state.gatewayUserId ?? ""} onValueChange={(next) => patch({ gatewayUserId: next })} className="h-10 border-input px-3 text-sm">
                    <option value="">اختر حساباً نشطاً…</option>
                    {(report?.options.courierAccounts ?? []).map((account) => (
                      <option key={account.id} value={account.id} disabled={account.linkedPartyId != null && account.linkedPartyId !== state.targetId}>
                        {account.name ?? account.username ?? `#${account.id}`}
                        {account.linkedPartyId === state.targetId ? " — عضوية سابقة" : account.linkedPartyId != null ? " — مرتبط" : ""}
                      </option>
                    ))}
                  </AppSelect>
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
                  {needsFeeDecision && (
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="legacy-fee-settlement">قرار أجرة التوصيل ({fmtMoney(state.proofDeliveryFee)})</Label>
                      <AppSelect
                        id="legacy-fee-settlement"
                        value={state.feeSettlementAction ?? ""}
                        onValueChange={(next) => patch({ feeSettlementAction: next as RepairDialogState["feeSettlementAction"] })}
                        className="h-10 border-input px-3 text-sm"
                      >
                        <option value="">اختر ما يثبته السجل فقط…</option>
                        <option value="EARN_ONLY">تثبيت استحقاق الأجرة فقط — الدفع/الصرف غير مثبت</option>
                        {state.proofFeeCollection === "COURIER" && (
                          <option value="EARN_AND_DIRECT_PAID">تثبيت الاستحقاق والقبض المباشر — المندوب قبضها من العميل</option>
                        )}
                      </AppSelect>
                    </div>
                  )}
                </div>
              )}

              {needsCustomerBalanceDecision && (
                <div className="space-y-1.5">
                  <Label htmlFor="legacy-customer-balance">قرار ذمة العميل</Label>
                  <AppSelect
                    id="legacy-customer-balance"
                    value={state.customerBalanceAction ?? ""}
                    onValueChange={(next) => patch({ customerBalanceAction: next as RepairDialogState["customerBalanceAction"] })}
                    className="h-10 border-input px-3 text-sm"
                  >
                    <option value="">اختر بعد مراجعة السجل…</option>
                    <option value="IDENTITY_ONLY">استعادة الهوية فقط — الذمة مسجلة مسبقاً</option>
                    <option value="ADD_OUTSTANDING">استعادة الهوية وإضافة المتبقي — الذمة غير مسجلة</option>
                  </AppSelect>
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
