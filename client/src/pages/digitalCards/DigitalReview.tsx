import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { D, fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { RowActions } from "@/components/list/RowActions";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { CheckCircle2, CircleAlert, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Reconciliation = RouterOutputs["digitalCards"]["wallets"]["reconciliations"][number];
type QueueRow = RouterOutputs["digitalCards"]["sales"]["needsReview"][number];
type ReviewDetails = RouterOutputs["digitalCards"]["sales"]["reviewDetails"];
type Decision = "CANCEL_NO_ISSUE" | "FINALIZE_SALE" | "WRITEOFF_LOSS";
type ItemOutcome = "ISSUED" | "NOT_ISSUED";

const selectCls = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm";

const DECISION_COPY: Record<Decision, { title: string; detail: string; effect: string }> = {
  CANCEL_NO_ISSUE: {
    title: "لم يصدر أي كرت",
    detail: "استخدمه بعد مطابقة تقرير جهاز المزوّد والتأكد أن العملية لم تُنفّذ.",
    effect: "عند الاعتماد يُلغى الطلب ويعود المبلغ المعلّق إلى الرصيد المتاح بلا خسارة.",
  },
  FINALIZE_SALE: {
    title: "صدر الكرت وقُبض المبلغ",
    detail: "استخدمه عندما تؤكد أن الكرت سُلّم وأن المبلغ استُلم، لكن الفاتورة لم تُنشأ.",
    effect: "عند الاعتماد تُنشأ الفاتورة ويُثبت البيع من الأسعار وطريقة الدفع المحفوظة.",
  },
  WRITEOFF_LOSS: {
    title: "صدر الكرت ولم يُقبض المبلغ",
    detail: "استخدمه عند صدور الكرت دون تحصيل ثمنه أو تعذر استرداده.",
    effect: "عند الاعتماد تُسجل خسارة واضحة وتُغلق المبالغ المعلقة؛ لا تُنشأ مبيعات وهمية.",
  },
};

const AUDIT_ACTION_LABEL: Record<string, string> = {
  "digitalCards.intent.prepared": "جهّز عملية البيع وحجز المبلغ",
  "digitalCards.intent.executionClaimed": "بدأ إصدار الكرت من جهاز المزوّد",
  "digitalCards.intent.execution": "سجّل نتيجة إصدار الكرت",
  "digitalCards.intent.needsReview": "نقل العملية للمعالجة بعد توقفها",
  "digitalCards.review.resolutionRequested": "طلب قرار معالجة",
  "digitalCards.review.resolutionApproved": "اعتمد القرار ونفّذه",
  "digitalCards.review.resolutionRejected": "رفض قرار المعالجة",
  "digitalCards.intent.finalized": "أنشأ الفاتورة وأكمل البيع",
  "digitalCards.intent.writeoffApproved": "أثبت الخسارة وأغلق العملية",
  "digitalCards.intent.cancelled": "ألغى العملية وحرر المبلغ",
};

function causeFor(row: QueueRow): { title: string; detail: string; next: string } {
  if (row.resolutionStatus === "PENDING") {
    return {
      title: "قرار المعالجة ينتظر مديراً آخر",
      detail: DECISION_COPY[row.resolutionDecision as Decision]?.title ?? "تم إرسال قرار للمعالجة",
      next: "مراجعة القرار واعتماده أو رفضه",
    };
  }
  if (Number(row.activeClaimCount) > 0) {
    return {
      title: "إصدار الكرت ما زال مفتوحاً",
      detail: "هناك نافذة إصدار نشطة ولم تنته مهلة تسجيل النتيجة بعد.",
      next: "انتظر انتهاء نافذة الإصدار أو عُد إلى شاشة الكاشير",
    };
  }
  if (Number(row.successCount) === Number(row.itemCount) && Number(row.itemCount) > 0) {
    return {
      title: "صدرت الكروت ولم تُنشأ الفاتورة",
      detail: "سُجل نجاح الإصدار، لكن البيع توقف قبل إنشاء الفاتورة والقبض.",
      next: "طابق تقرير الجهاز ثم أكمل البيع أو أثبت الخسارة",
    };
  }
  if (Number(row.openClaimCount) > 0) {
    return {
      title: "بدأ الإصدار ولم تُسجّل النتيجة",
      detail: "انتهت نافذة الإصدار قبل تسجيل هل نجحت العملية أم لم تصدر.",
      next: "طابق رقم العملية مع تقرير جهاز المزوّد ثم اختر النتيجة",
    };
  }
  if (Number(row.successCount) > 0) {
    return {
      title: "بعض الكروت صدرت وبعضها لم يكتمل",
      detail: "نتائج بنود العملية مختلفة، لذلك لم يسمح النظام بإنشاء فاتورة غير كاملة.",
      next: "راجع كل كرت وحدد ما صدر فعلاً",
    };
  }
  if (Number(row.unknownCount) > 0) {
    return {
      title: "نتيجة الإصدار غير معروفة",
      detail: "لم يتأكد النظام من نتيجة جهاز المزوّد، فأبقى المبلغ معلقاً حمايةً للمال.",
      next: "طابق تقرير الجهاز ثم حدد النتيجة الصحيحة",
    };
  }
  return {
    title: "لم يكتمل تسجيل البيع",
    detail: "لا توجد فاتورة نهائية لهذه العملية، ويجب حسم نتيجتها قبل تحرير المبلغ.",
    next: "افتح المعالجة وحدد ما حدث",
  };
}

export default function DigitalReview() {
  const utils = trpc.useUtils();
  const needsReview = trpc.digitalCards.sales.needsReview.useQuery();
  const variances = trpc.digitalCards.wallets.reconciliations.useQuery({ status: "VARIANCE_OPEN" });
  const [reviewing, setReviewing] = useState<QueueRow | null>(null);
  const [resolving, setResolving] = useState<Reconciliation | null>(null);

  const sweepMut = trpc.digitalCards.sales.expireStale.useMutation({
    onSuccess: (result) => {
      void utils.digitalCards.sales.needsReview.invalidate();
      void utils.digitalCards.wallets.list.invalidate();
      notify.ok(
        "اكتمل فحص العمليات القديمة",
        `أُلغي ${result.expired} طلب لم يبدأ إصداره، ونُقلت ${result.needsReview} عملية تحتاج قراراً إلى هذه الشاشة.`,
      );
    },
    onError: (error) => notify.err(error),
  });

  async function sweep() {
    if (!(await confirm({
      title: "فحص العمليات القديمة",
      description: "يفحص الطلبات التي انتهت مهلتها. ما لم يبدأ إصداره يُلغى ويُحرّر مبلغه، وما بدأ إصداره يبقى محمياً ويظهر هنا مع سبب واضح. لا ينشئ هذا الفحص فاتورة ولا يخصم رصيداً.",
      confirmText: "بدء الفحص",
    }))) return;
    sweepMut.mutate();
  }

  const queue = needsReview.data ?? [];
  const openVariances = variances.data ?? [];

  /** أعمدة طابور «مبيعات كروت لم تكتمل» — تُغلِق على `setReviewing`. */
  const queueColumns: ColumnDef<QueueRow, unknown>[] = [
    {
      id: "id",
      header: "رقم العملية",
      accessorFn: (row) => `#${row.id}`,
      meta: { kind: "code", width: "id" },
      cell: ({ row }) => <span className="font-bold">#{row.original.id}</span>,
    },
    {
      id: "branchName",
      header: "الفرع",
      accessorFn: (row) => row.branchName,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.branchName}</span>,
    },
    {
      id: "createdBy",
      header: "الموظف والوردية",
      accessorFn: (row) => row.createdByName || `حساب #${row.createdBy}`,
      meta: { width: "actor" },
      cell: ({ row }) => (
        <>
          <p className="font-medium">{row.original.createdByName || `حساب #${row.original.createdBy}`}</p>
          <p className="text-xs text-muted-foreground">
            {row.original.createdByUsername ? `@${row.original.createdByUsername} · ` : ""}وردية #{row.original.shiftId} ·{" "}
            {row.original.shiftStatus === "OPEN" ? "مفتوحة" : "مغلقة"}
          </p>
        </>
      ),
    },
    {
      id: "cause",
      header: "ما الذي حدث؟",
      accessorFn: (row) => causeFor(row).title,
      meta: { width: "wide", wrap: true },
      cell: ({ row }) => {
        const cause = causeFor(row.original);
        return (
          <>
            <p className="font-semibold">{cause.title}</p>
            <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{cause.detail}</p>
          </>
        );
      },
    },
    {
      id: "expectedTotal",
      header: "قيمة البيع",
      accessorFn: (row) => fmtAr(row.expectedTotal),
      meta: { kind: "money" },
      cell: ({ row }) => fmtAr(row.original.expectedTotal),
    },
    {
      id: "reservedAmount",
      header: "مبلغ معلّق",
      accessorFn: (row) => fmtAr(row.reservedAmount),
      meta: { kind: "money" },
      cell: ({ row }) => (
        <>
          <span className="font-bold">{fmtAr(row.original.reservedAmount)}</span>
          {/* dir="auto" لأنّ خليّة المال معزولة LTR — والجملة العربية تحتاج اتّجاهها. */}
          <p className="mt-1 text-xs text-muted-foreground" dir="auto">محمي ولا يعود للمتاح قبل اعتماد القرار</p>
        </>
      ),
    },
    {
      id: "createdAt",
      header: "بدأت في",
      accessorFn: (row) => fmtDateTime(row.createdAt),
      meta: { kind: "datetime" },
      cell: ({ row }) => <span className="text-muted-foreground">{fmtDateTime(row.original.createdAt)}</span>,
    },
    {
      id: "next",
      header: "المطلوب الآن",
      accessorFn: (row) => causeFor(row).next,
      meta: { wrap: true },
      cell: ({ row }) => <span className="block max-w-xs">{causeFor(row.original).next}</span>,
    },
    {
      id: "actions",
      header: "الإجراء",
      enableSorting: false,
      meta: { kind: "actions" },
      cell: ({ row }) => (
        <RowActions
          mode="inline"
          actions={[{
            key: "review",
            kind: "view",
            label: row.original.resolutionStatus === "PENDING" ? "مراجعة القرار" : "معالجة الآن",
            gate: { module: "digital_cards", level: "READ" },
            disabled: Number(row.original.activeClaimCount) > 0,
            disabledReason: "نافذة الإصدار ما زالت نشطة",
            onSelect: () => setReviewing(row.original),
          }]}
        />
      ),
    },
  ];

  /** أعمدة «اختلافات رصيد تحتاج تصحيحاً» — تُغلِق على `setResolving`. */
  const varianceColumns: ColumnDef<Reconciliation, unknown>[] = [
    {
      id: "walletName",
      header: "رصيد جهاز المزوّد",
      accessorFn: (row) => row.walletName,
      cell: ({ row }) => <span className="font-medium">{row.original.walletName}</span>,
    },
    {
      id: "branchName",
      header: "الفرع",
      accessorFn: (row) => row.branchName,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.branchName}</span>,
    },
    { id: "businessDate", header: "التاريخ", accessorFn: (row) => row.businessDate, meta: { kind: "date" }, cell: ({ row }) => row.original.businessDate },
    {
      id: "countedBy",
      header: "من سجّل الرصيد",
      accessorFn: (row) => row.countedByName || `حساب #${row.countedBy}`,
      meta: { width: "actor" },
      cell: ({ row }) => (
        <>
          <p className="font-medium">{row.original.countedByName || `حساب #${row.original.countedBy}`}</p>
          {row.original.countedByUsername && <p className="text-xs text-muted-foreground" dir="ltr">@{row.original.countedByUsername}</p>}
          <p className="text-xs text-muted-foreground" dir="ltr">{fmtDateTime(row.original.createdAt)}</p>
        </>
      ),
    },
    {
      id: "expectedBalance",
      header: "في النظام",
      accessorFn: (row) => fmtAr(row.expectedBalance),
      meta: { kind: "money" },
      cell: ({ row }) => fmtAr(row.original.expectedBalance),
    },
    {
      id: "actualBalance",
      header: "في جهاز المزوّد",
      accessorFn: (row) => fmtAr(row.actualBalance),
      meta: { kind: "money" },
      cell: ({ row }) => <span className="font-medium">{fmtAr(row.original.actualBalance)}</span>,
    },
    {
      id: "variance",
      header: "الاختلاف",
      accessorFn: (row) => fmtAr(D(row.variance).abs().toFixed(2)),
      meta: { kind: "money" },
      cell: ({ row }) => <span className="font-bold text-destructive">{fmtAr(D(row.original.variance).abs().toFixed(2))}</span>,
    },
    {
      id: "explanation",
      header: "التفسير",
      accessorFn: (row) => `جهاز المزوّد ${D(row.variance).gt(0) ? "أعلى" : "أقل"} من النظام بهذا المبلغ`,
      meta: { wrap: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          جهاز المزوّد {D(row.original.variance).gt(0) ? "أعلى" : "أقل"} من النظام بهذا المبلغ
        </span>
      ),
    },
    {
      id: "actions",
      header: "الإجراء",
      enableSorting: false,
      meta: { kind: "actions" },
      cell: ({ row }) => (
        <RowActions
          mode="inline"
          actions={[{
            key: "resolve-variance",
            kind: "correct",
            label: "معالجة الفرق",
            gate: { module: "digital_cards", level: "FULL" },
            onSelect: () => setResolving(row.original),
          }]}
        />
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="عمليات تحتاج معالجة"
        description="كل عملية هنا توقفت قبل اكتمال البيع. يعرض النظام ما حدث، ومن قام به، والخطوة الصحيحة. أي قرار مالي يحتاج طلب مدير واعتماد مدير آخر؛ مالك النظام مستثنى."
        actions={
          <Button size="sm" variant="outline" disabled={sweepMut.isPending} onClick={() => void sweep()}>
            <RefreshCw className="size-4" /> {sweepMut.isPending ? "جارٍ الفحص…" : "فحص العمليات القديمة"}
          </Button>
        }
      />

      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="flex gap-3 p-4 text-sm">
          <ShieldCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
          <div>
            <p className="font-semibold">الحماية المالية تعمل على مرحلتين</p>
            <p className="text-muted-foreground">المدير الأول يطابق تقرير جهاز المزوّد ويطلب القرار، ومدير آخر يعتمد. مالك النظام يستطيع اعتماد طلبه بصفته المرجع النهائي. لا يعود مبلغ ولا تُنشأ فاتورة ولا تُسجل خسارة بمجرد الطلب.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center gap-2 text-sm font-medium">
          <TriangleAlert aria-hidden className="size-4" />
          مبيعات كروت لم تكتمل ({queue.length})
        </CardHeader>
        <CardContent className="p-0">
          {/* مُضمَّن: البطاقة تحمل العنوان والعدّ؛ و`pageSize=Infinity` لازمٌ معه لأنّ شريط
              الحالة (وفيه الترقيم) مكتوم. الارتفاع كما كان في ScrollTableShell. */}
          <DataTable<QueueRow>
            embedded
            searchable={false}
            pageSize={Infinity}
            maxHeightClass="max-h-[calc(100dvh-15rem)]"
            data={queue}
            columns={queueColumns}
            loading={needsReview.isLoading}
            errorState={{ isError: needsReview.isError, message: needsReview.error?.message, onRetry: () => void needsReview.refetch() }}
            emptyText="لا توجد عمليات تحتاج معالجة — كل مبيعات الكروت مكتملة."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium">
          اختلافات رصيد تحتاج تصحيحاً ({openVariances.length})
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<Reconciliation>
            embedded
            searchable={false}
            pageSize={Infinity}
            maxHeightClass="max-h-[calc(100dvh-15rem)]"
            data={openVariances}
            columns={varianceColumns}
            loading={variances.isLoading}
            errorState={{ isError: variances.isError, message: variances.error?.message, onRetry: () => void variances.refetch() }}
            emptyText="لا توجد اختلافات مفتوحة — الأرصدة مطابقة."
          />
        </CardContent>
      </Card>

      <ReviewResolutionDialog row={reviewing} onClose={() => setReviewing(null)} />
      <ResolveVarianceDialog reconciliation={resolving} onClose={() => setResolving(null)} />
    </div>
  );
}

function ReviewResolutionDialog({ row, onClose }: { row: QueueRow | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const details = trpc.digitalCards.sales.reviewDetails.useQuery(
    { intentId: row?.id ?? 0 },
    { enabled: row != null },
  );
  const [decision, setDecision] = useState<Decision | "">("");
  const [reason, setReason] = useState("");
  const [verified, setVerified] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<number, ItemOutcome>>({});
  const [references, setReferences] = useState<Record<number, string>>({});
  const [rejectReason, setRejectReason] = useState("");

  useEffect(() => {
    setDecision("");
    setReason("");
    setVerified(false);
    setOutcomes({});
    setReferences({});
    setRejectReason("");
  }, [row?.id]);

  useEffect(() => {
    if (!details.data) return;
    setOutcomes(Object.fromEntries(details.data.items.map((item) => [
      Number(item.id),
      item.fulfillmentStatus === "SUCCESS" ? "ISSUED" : "NOT_ISSUED",
    ])));
    setReferences(Object.fromEntries(details.data.items.map((item) => [Number(item.id), item.providerReference ?? ""])));
  }, [details.data]);

  function refreshAndClose() {
    void utils.digitalCards.sales.needsReview.invalidate();
    void utils.digitalCards.sales.reviewDetails.invalidate();
    void utils.digitalCards.wallets.list.invalidate();
    void utils.digitalCards.dashboard.pendingExecutions.invalidate();
    onClose();
  }

  const requestMut = trpc.digitalCards.sales.requestReviewResolution.useMutation({
    onSuccess: () => {
      notify.ok("أُرسل قرار المعالجة", "لم يتغير أي مبلغ بعد. ينتظر القرار اعتماد مدير آخر.");
      refreshAndClose();
    },
    onError: (error) => notify.err(error),
  });
  const approveMut = trpc.digitalCards.sales.approveReviewResolution.useMutation({
    onSuccess: (result) => {
      const message = result.decision === "CANCEL_NO_ISSUE"
        ? "أُلغيت العملية وعاد المبلغ المعلّق إلى المتاح."
        : result.decision === "FINALIZE_SALE"
          ? `اكتمل البيع وأُنشئت الفاتورة رقم ${result.invoiceId}.`
          : `أُثبتت الخسارة بمبلغ ${fmtAr(result.loss ?? "0")} وأُغلقت العملية.`;
      notify.ok("اكتملت المعالجة", message);
      refreshAndClose();
    },
    onError: (error) => notify.err(error),
  });
  const rejectMut = trpc.digitalCards.sales.rejectReviewResolution.useMutation({
    onSuccess: () => {
      notify.ok("رُفض القرار", "لم يتغير أي مبلغ، ويمكن طلب قرار جديد بعد إعادة المطابقة.");
      refreshAndClose();
    },
    onError: (error) => notify.err(error),
  });

  const data = details.data;
  const pending = data?.resolution?.status === "PENDING";
  const ownRequest = pending
    && !me.data?.isOwner
    && Number(data?.resolution?.requestedBy) === Number(me.data?.id);

  function chooseDecision(next: Decision) {
    setDecision(next);
    if (!data) return;
    if (next === "CANCEL_NO_ISSUE") {
      setOutcomes(Object.fromEntries(data.items.map((item) => [Number(item.id), "NOT_ISSUED"])));
    } else if (next === "FINALIZE_SALE") {
      setOutcomes(Object.fromEntries(data.items.map((item) => [Number(item.id), "ISSUED"])));
    } else {
      setOutcomes(Object.fromEntries(data.items.map((item) => [
        Number(item.id), item.fulfillmentStatus === "SUCCESS" ? "ISSUED" : "NOT_ISSUED",
      ])));
    }
  }

  function submitRequest() {
    if (!data || !decision) return notify.err("اختر ما حدث للعملية");
    if (!verified) return notify.err("أكد أنك طابقت النتيجة مع تقرير جهاز المزوّد");
    if (reason.trim().length < 5) return notify.err("اكتب نتيجة المطابقة وسبب القرار بوضوح");
    const items = data.items.map((item) => ({
      intentItemId: Number(item.id),
      outcome: outcomes[Number(item.id)] ?? "NOT_ISSUED",
      providerReference: references[Number(item.id)]?.trim() || null,
    }));
    const missingReference = items.some((item) => item.outcome === "ISSUED" && !item.providerReference);
    if (missingReference) return notify.err("أدخل رقم العملية أو ID لكل كرت صدر");
    if (decision === "WRITEOFF_LOSS" && !items.some((item) => item.outcome === "ISSUED")) {
      return notify.err("حدد كرتاً صادراً واحداً على الأقل، أو اختر «لم يصدر أي كرت»");
    }
    requestMut.mutate({ intentId: data.intent.id, decision, reason: reason.trim(), items });
  }

  async function approve() {
    if (!data?.resolution) return;
    const copy = DECISION_COPY[data.resolution.decision as Decision];
    if (!(await confirm({
      variant: data.resolution.decision === "FINALIZE_SALE" ? "info" : "danger",
      title: `اعتماد: ${copy.title}`,
      description: `${copy.effect} هذا الإجراء موثق ولا يمكن التراجع عنه من هذه الشاشة. متابعة؟`,
      confirmText: "اعتماد وتنفيذ",
    }))) return;
    approveMut.mutate({ intentId: data.intent.id });
  }

  return (
    <Dialog open={row != null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>معالجة عملية الكروت #{row?.id}</DialogTitle>
          <DialogDescription>
            طابق النتيجة مع تقرير جهاز المزوّد. الحفظ هنا يرسل طلباً فقط، ولا يغيّر المال قبل اعتماد مدير آخر؛ مالك النظام مستثنى.
          </DialogDescription>
        </DialogHeader>

        {details.isLoading && <LoadingState />}
        {data && (
          <div className="max-h-[65vh] space-y-4 overflow-y-auto px-1">
            <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
              <div><span className="text-muted-foreground">قيمة البيع</span><p className="font-bold tabular-nums">{fmtAr(data.intent.expectedTotal)}</p></div>
              <div><span className="text-muted-foreground">طريقة الدفع المحفوظة</span><p className="font-medium">{data.intent.paymentMethod === "CASH" ? "نقداً" : "بطاقة/شبكة"}</p></div>
              <div><span className="text-muted-foreground">الفرع</span><p className="font-medium">{data.intent.branchName}</p></div>
              <div><span className="text-muted-foreground">الموظف والحساب</span><p className="font-medium">{data.intent.createdByName || `حساب #${data.intent.createdBy}`}</p><p className="text-xs" dir="ltr">{data.intent.createdByUsername ? `@${data.intent.createdByUsername}` : `#${data.intent.createdBy}`}</p></div>
              <div><span className="text-muted-foreground">الوردية</span><p className="font-medium">#{data.intent.shiftId} · {data.intent.shiftStatus === "OPEN" ? "مفتوحة" : "مغلقة"}</p><p className="text-xs text-muted-foreground">بدأت <span dir="ltr">{fmtDateTime(data.intent.shiftOpenedAt)}</span></p></div>
            </div>

            {pending ? (
              <PendingResolution
                data={data}
                ownRequest={ownRequest}
                rejectReason={rejectReason}
                setRejectReason={setRejectReason}
                approving={approveMut.isPending}
                rejecting={rejectMut.isPending}
                onApprove={() => void approve()}
                onReject={() => {
                  if (rejectReason.trim().length < 3) return notify.err("اكتب سبب رفض القرار");
                  rejectMut.mutate({ intentId: data.intent.id, reason: rejectReason.trim() });
                }}
              />
            ) : (
              <>
                <div className="space-y-2">
                  <p className="text-sm font-semibold">1. ما الذي أثبته تقرير جهاز المزوّد؟</p>
                  <div className="grid gap-2 md:grid-cols-3">
                    {(Object.keys(DECISION_COPY) as Decision[]).map((key) => {
                      const copy = DECISION_COPY[key];
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`rounded-lg border p-3 text-start transition-colors ${decision === key ? "border-primary bg-primary/10" : "hover:bg-muted/50"}`}
                          onClick={() => chooseDecision(key)}
                        >
                          <span className="font-semibold">{copy.title}</span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">{copy.detail}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {decision && (
                  <div className="space-y-2">
                    <p className="text-sm font-semibold">2. طابق كل كرت</p>
                    {data.items.map((item) => {
                      const id = Number(item.id);
                      const outcome = outcomes[id] ?? "NOT_ISSUED";
                      const fixed = decision !== "WRITEOFF_LOSS" || item.fulfillmentStatus === "SUCCESS";
                      return (
                        <div key={id} className="grid gap-3 rounded-lg border p-3 md:grid-cols-[1fr_150px_1fr] md:items-end">
                          <div>
                            <p className="font-medium">{item.offeringName}</p>
                            <p className="text-xs text-muted-foreground">{item.providerName} · {fmtAr(item.sellPrice)}</p>
                            <p className="mt-1 text-xs">
                              {Number(item.hasActiveClaim) > 0
                                ? "جلسة الإصدار ما زالت مفتوحة"
                                : Number(item.hasOpenClaim) > 0
                                  ? "بدأ الإصدار ولم تُسجّل النتيجة قبل انتهاء المهلة"
                                  : item.fulfillmentStatus === "SUCCESS"
                                    ? "مسجّل ككرت صادر"
                                    : item.fulfillmentStatus === "FAILED"
                                      ? "مسجّل ككرت لم يصدر"
                                      : "نتيجة الإصدار غير مسجّلة"}
                            </p>
                            {item.confirmedBy && (
                              <p className="text-xs text-muted-foreground">
                                سجّل النتيجة: {item.confirmedByName || `حساب #${item.confirmedBy}`}
                                {item.confirmedByUsername ? <span dir="ltr"> {`@${item.confirmedByUsername}`}</span> : null}
                              </p>
                            )}
                          </div>
                          <div>
                            <label className="mb-1 block text-xs text-muted-foreground">نتيجة الجهاز</label>
                            <select
                              className={selectCls}
                              value={outcome}
                              disabled={fixed}
                              onChange={(event) => setOutcomes((current) => ({ ...current, [id]: event.target.value as ItemOutcome }))}
                            >
                              <option value="ISSUED">صدر الكرت</option>
                              <option value="NOT_ISSUED">لم يصدر</option>
                            </select>
                          </div>
                          <div>
                            <label className="mb-1 block text-xs text-muted-foreground">رقم العملية أو ID الكرت {outcome === "ISSUED" ? "(إلزامي)" : ""}</label>
                            <Input
                              dir="ltr"
                              value={references[id] ?? ""}
                              disabled={outcome !== "ISSUED"}
                              onChange={(event) => setReferences((current) => ({ ...current, [id]: event.target.value }))}
                              placeholder="مثال: 78451296"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {decision && (
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1 block text-sm font-medium" htmlFor="digital-review-reason">3. نتيجة المطابقة وسبب القرار</label>
                      <Textarea
                        id="digital-review-reason"
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder="مثال: طابقت تقرير جهاز آسياسيل ليوم العملية ولم أجد رقم العملية…"
                        rows={3}
                      />
                    </div>
                    <label className="flex items-start gap-2 rounded-lg border p-3 text-sm">
                      <input type="checkbox" className="mt-1 size-4" checked={verified} onChange={(event) => setVerified(event.target.checked)} />
                      <span>أؤكد أنني راجعت تقرير جهاز المزوّد ورقم العملية، وأن النتيجة أعلاه مطابقة لما حدث فعلاً.</span>
                    </label>
                    <div className="rounded-lg bg-muted p-3 text-sm">
                      <strong>ما سيحدث بعد الاعتماد:</strong> {DECISION_COPY[decision].effect}
                    </div>
                  </div>
                )}

                <OperationTimeline data={data} />
              </>
            )}
            {pending && <OperationTimeline data={data} />}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>إغلاق</Button>
          {data && !pending && (
            <Button size="sm" disabled={requestMut.isPending || !decision} onClick={submitRequest}>
              {requestMut.isPending ? "جارٍ الإرسال…" : "إرسال لمدير آخر"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OperationTimeline({ data }: { data: ReviewDetails }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold">سجل من قام بالإجراءات</p>
      <div className="divide-y rounded-lg border">
        {data.timeline.map((event, index) => (
          <div key={`${event.action}-${index}`} className="grid gap-1 p-3 text-sm sm:grid-cols-[1fr_180px_160px]">
            <span className="font-medium">{AUDIT_ACTION_LABEL[event.action] ?? "تحديث مسجل على العملية"}</span>
            <span className="text-muted-foreground">{event.userName || (event.userId ? `حساب #${event.userId}` : "النظام")}</span>
            <span className="text-muted-foreground" dir="ltr">{fmtDateTime(event.createdAt)}</span>
          </div>
        ))}
        {data.timeline.length === 0 && <p className="p-3 text-sm text-muted-foreground">لا توجد أحداث مسجلة لهذه العملية.</p>}
      </div>
    </div>
  );
}

function PendingResolution({
  data, ownRequest, rejectReason, setRejectReason, approving, rejecting, onApprove, onReject,
}: {
  data: ReviewDetails;
  ownRequest: boolean;
  rejectReason: string;
  setRejectReason: (value: string) => void;
  approving: boolean;
  rejecting: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const resolution = data.resolution!;
  const copy = DECISION_COPY[resolution.decision as Decision];
  const requestItems = new Map(resolution.items.map((item) => [Number(item.intentItemId), item]));
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
        <div className="flex items-start gap-2">
          <CircleAlert className="mt-0.5 size-5 shrink-0 text-primary" />
          <div>
            <p className="font-semibold">القرار المطلوب: {copy.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{resolution.reason}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              طلبه {resolution.requestedByName || `حساب #${resolution.requestedBy}`}
              {resolution.requestedByUsername ? <span dir="ltr"> {`@${resolution.requestedByUsername}`}</span> : null}
              {" · "}<span dir="ltr">{fmtDateTime(resolution.requestedAt)}</span>
            </p>
            <p className="mt-2 text-sm"><strong>الأثر عند الاعتماد:</strong> {copy.effect}</p>
          </div>
        </div>
      </div>
      <div className="space-y-2">
        {data.items.map((item) => {
          const requested = requestItems.get(Number(item.id));
          return (
            <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
              <div><p className="font-medium">{item.offeringName}</p><p className="text-xs text-muted-foreground">{item.providerName}</p></div>
              <div className="text-end">
                <p className="font-semibold">{requested?.outcome === "ISSUED" ? "صدر الكرت" : "لم يصدر"}</p>
                {requested?.providerReference && <p className="font-mono text-xs" dir="ltr">{requested.providerReference}</p>}
              </div>
            </div>
          );
        })}
      </div>
      {ownRequest ? (
        <div className="rounded-lg border p-3 text-sm text-muted-foreground">أنت طلبت هذا القرار؛ يلزم مدير آخر لاعتماده أو رفضه.</div>
      ) : (
        <div className="space-y-2">
          <Textarea value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} placeholder="سبب الرفض عند عدم مطابقة التقرير…" rows={2} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={approving || rejecting} onClick={onApprove}>
              <CheckCircle2 className="size-4" /> {approving ? "جارٍ التنفيذ…" : "اعتماد وتنفيذ"}
            </Button>
            <Button size="sm" variant="destructive" disabled={approving || rejecting} onClick={onReject}>
              {rejecting ? "جارٍ الرفض…" : "رفض القرار"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ResolveVarianceDialog({
  reconciliation, onClose,
}: { reconciliation: Reconciliation | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const [reason, setReason] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const statement = trpc.digitalCards.wallets.statement.useQuery(
    { walletId: reconciliation?.walletId ?? 0 },
    { enabled: reconciliation != null },
  );

  useEffect(() => { setReason(""); setRejectReason(""); }, [reconciliation?.id]);

  const matching = useMemo(() => {
    if (!reconciliation) return [];
    const variance = D(reconciliation.variance);
    const direction = variance.gt(0) ? "IN" : "OUT";
    return (statement.data ?? []).filter((transaction) =>
      transaction.type === "ADJUSTMENT"
      && (transaction.status === "PENDING_APPROVAL" || transaction.status === "ACTIVE")
      && transaction.direction === direction
      && D(transaction.amount).eq(variance.abs())
      && new Date(transaction.createdAt).getTime() >= new Date(reconciliation.createdAt).getTime(),
    );
  }, [reconciliation, statement.data]);
  const active = matching.find((transaction) => transaction.status === "ACTIVE");
  const pending = matching.find((transaction) => transaction.status === "PENDING_APPROVAL");
  const ownPending = pending && !me.data?.isOwner && Number(pending.createdBy) === Number(me.data?.id);

  function invalidate() {
    void utils.digitalCards.wallets.statement.invalidate();
    void utils.digitalCards.wallets.reconciliations.invalidate();
    void utils.digitalCards.wallets.list.invalidate();
  }

  const requestMut = trpc.digitalCards.wallets.requestAdjustment.useMutation({
    onSuccess: () => { invalidate(); notify.ok("أُرسل طلب تصحيح الرصيد", "لا يتغير الرصيد حتى يعتمد مدير آخر الطلب."); },
    onError: (error) => notify.err(error),
  });
  const resolveMut = trpc.digitalCards.wallets.resolveVariance.useMutation({
    onSuccess: () => { invalidate(); notify.ok("أُغلقت المعالجة", "الرصيد المصحح مطابق لتقرير جهاز المزوّد."); onClose(); },
    onError: (error) => notify.err(error),
  });
  const approveResolveMut = trpc.digitalCards.wallets.approveAndResolveVariance.useMutation({
    onSuccess: () => { invalidate(); notify.ok("اعتمد التصحيح وأُغلق الفرق", "تم تحديث الرصيد وإغلاق الاختلاف في عملية واحدة."); onClose(); },
    onError: (error) => notify.err(error),
  });
  const rejectMut = trpc.digitalCards.wallets.rejectAdjustment.useMutation({
    onSuccess: () => { invalidate(); notify.ok("رُفض طلب التصحيح", "لم يتغير الرصيد ويمكن إنشاء طلب صحيح جديد."); },
    onError: (error) => notify.err(error),
  });

  function requestCorrection() {
    if (!reconciliation) return;
    if (reason.trim().length < 3) return notify.err("اكتب سبب اختلاف الرصيد بعد مراجعة تقرير الجهاز");
    const variance = D(reconciliation.variance);
    requestMut.mutate({
      walletId: Number(reconciliation.walletId),
      amount: variance.abs().toFixed(2),
      direction: variance.gt(0) ? "IN" : "OUT",
      reason: `تصحيح فرق رصيد ${reconciliation.businessDate}: ${reason.trim()}`,
      clientRequestId: crypto.randomUUID(),
    });
  }

  return (
    <Dialog open={reconciliation != null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>معالجة اختلاف الرصيد — {reconciliation?.walletName}</DialogTitle>
          <DialogDescription>
            النظام يجهز مبلغ واتجاه التصحيح تلقائياً. مدير يطلب التصحيح ومدير آخر يعتمده؛ مالك النظام مستثنى بصفته المرجع النهائي.
          </DialogDescription>
        </DialogHeader>
        {reconciliation && (
          <div className="space-y-4">
            <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-3">
              <div><span className="text-muted-foreground">في النظام</span><p className="font-bold tabular-nums">{fmtAr(reconciliation.expectedBalance)}</p></div>
              <div><span className="text-muted-foreground">في جهاز المزوّد</span><p className="font-bold tabular-nums">{fmtAr(reconciliation.actualBalance)}</p></div>
              <div><span className="text-muted-foreground">التصحيح المطلوب</span><p className="font-bold tabular-nums text-destructive">{D(reconciliation.variance).gt(0) ? "+" : "−"}{fmtAr(D(reconciliation.variance).abs().toFixed(2))}</p></div>
            </div>

            {statement.isLoading && <LoadingState />}
            {!statement.isLoading && !pending && !active && (
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="variance-reason">سبب الاختلاف بعد مراجعة تقرير الجهاز</label>
                <Textarea id="variance-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} placeholder="مثال: حركة شحن ظهرت في جهاز المزوّد ولم تكن مسجلة في النظام…" />
                <Button size="sm" disabled={requestMut.isPending} onClick={requestCorrection}>
                  {requestMut.isPending ? "جارٍ الإرسال…" : "إرسال طلب تصحيح"}
                </Button>
                <p className="text-xs text-muted-foreground">إرسال الطلب لا يغير الرصيد.</p>
              </div>
            )}

            {pending && (
              <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
                <p className="font-semibold">يوجد طلب تصحيح مطابق بمبلغ {fmtAr(pending.amount)}</p>
                <p className="text-muted-foreground">{pending.notes}</p>
                {ownPending ? (
                  <p className="font-medium">ينتظر اعتماد مدير آخر؛ لا يمكنك اعتماد طلبك بنفسك.</p>
                ) : (
                  <>
                    <p>سيُحدّث الاعتماد الرصيد ويغلق الاختلاف معاً. إذا لم يطابق التقرير فارفضه.</p>
                    <Textarea value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} rows={2} placeholder="سبب الرفض عند الحاجة…" />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={approveResolveMut.isPending || rejectMut.isPending}
                        onClick={() => approveResolveMut.mutate({ reconciliationId: Number(reconciliation.id), adjustmentTransactionId: Number(pending.id) })}
                      >
                        اعتماد التصحيح وإغلاق الفرق
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={approveResolveMut.isPending || rejectMut.isPending}
                        onClick={() => {
                          if (rejectReason.trim().length < 3) return notify.err("اكتب سبب رفض طلب التصحيح");
                          rejectMut.mutate({ transactionId: Number(pending.id), reason: rejectReason.trim() });
                        }}
                      >
                        رفض الطلب
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}

            {active && (
              <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
                <p className="flex items-center gap-2 font-semibold"><CheckCircle2 className="size-4" /> تم اعتماد تصحيح الرصيد</p>
                <p>تحقق النظام من تطابق المبلغ والاتجاه والمحفظة. أغلق المعالجة لربط التصحيح بهذا التقرير.</p>
                <Button
                  size="sm"
                  disabled={resolveMut.isPending}
                  onClick={() => resolveMut.mutate({ reconciliationId: Number(reconciliation.id), adjustmentTransactionId: Number(active.id) })}
                >
                  إغلاق المعالجة
                </Button>
              </div>
            )}
          </div>
        )}
        <DialogFooter><Button variant="outline" size="sm" onClick={onClose}>إغلاق</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
