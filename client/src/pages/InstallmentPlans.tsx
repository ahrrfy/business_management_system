// بند 12أ (٧/٧): شاشة الأقساط والصكوك الآجلة — تبويب «الأقساط» في محور العملاء.
//
// الخطة = جدولة تحصيل فوق ذمّة العميل القائمة (لا قيد عند الإنشاء)؛ سداد كل قسط يُنشئ
// سند قبض حقيقياً بالمسار الموحَّد (قد يعلَّق على اعتماد مدير ثانٍ للمبالغ الكبيرة — Maker-Checker).
import { useMemo, useState } from "react";
import {
  AlarmClock,
  Ban,
  CalendarPlus,
  CheckCircle2,
  CircleDollarSign,
  Download,
  FileText,
  Landmark,
  Plus,
  RotateCcw,
  Undo2,
} from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { D, fmt } from "@/lib/money";
import { getDeviceCode } from "@/lib/offline/outbox";
import { POS_METHODS, type PosPaymentMethod } from "@/lib/paymentMethod";
import { fmtDateTime } from "@/lib/date";
import { ACTION_LABELS } from "@shared/actionLabels";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { exportRows } from "@/lib/export";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { MoneyInput } from "@/components/form/MoneyInput";
import { SmartCustomerInput, type SmartCustomerValue } from "@/components/form/SmartCustomerInput";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { RowActions } from "@/components/list";
import { buildOperationalContactMessage } from "@/lib/whatsapp";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type PlanRow = RouterOutputs["installments"]["list"]["rows"][number];
type PlanDetail = RouterOutputs["installments"]["get"];
type PlanLine = PlanDetail["lines"][number];
type DueRow = RouterOutputs["installments"]["dueSoon"][number];
type PendingExternalPayment =
  RouterOutputs["installments"]["pendingExternalPayments"][number];
type PayTarget = {
  lineId: number;
  branchId: number;
  seq: number;
  amount: string;
  kind: string;
  checkNumber: string | null;
  externalApproval?: PendingExternalPayment;
};

const EMPTY_CUSTOMER: SmartCustomerValue = { customerId: null, name: "", phone: null, isNew: false };

const PLAN_STATUS_AR: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: "نشطة", cls: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" },
  COMPLETED: { label: "مكتملة", cls: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]" },
  CANCELLED: { label: "ملغاة", cls: "bg-muted text-muted-foreground" },
};
const LINE_STATUS_AR: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "معلَّق", cls: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]" },
  PAID: { label: "مسدَّد", cls: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" },
  BOUNCED: { label: "صك مرتجع", cls: "bg-destructive/15 text-destructive" },
  CANCELLED: { label: "ملغى", cls: "bg-muted text-muted-foreground" },
};

function StatusBadge({ map, value }: { map: Record<string, { label: string; cls: string }>; value: string }) {
  const m = map[value] ?? { label: value, cls: "bg-muted text-muted-foreground" };
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${m.cls}`}>{m.label}</span>;
}

const todayYmd = () => new Date().toISOString().slice(0, 10);
const addDays = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/* ============================ الصفحة ============================ */

export default function InstallmentPlans() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: isAdmin });

  // فلاتر القائمة
  const [branchFilter, setBranchFilter] = useState<number | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<"" | "ACTIVE" | "COMPLETED" | "CANCELLED">("");
  const [customerFilter, setCustomerFilter] = useState<SmartCustomerValue>(EMPTY_CUSTOMER);
  // بحث برقم خطة/رقم صك + مدى تاريخ الإنشاء — installmentRouter.list يدعمهما فعلياً (بحثٌ محدود
  // بأوّل ٢٠٠ خطة مطابقة لبقية الفلاتر — راجع تعليق الراوتر).
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;
  // نافذة «المستحقّ قريباً» قابلة للضبط — الخادم يدعم حتى ٩٠ يوماً (installments.dueSoon).
  const [dueSoonDays, setDueSoonDays] = useState(7);

  const listInput = {
    branchId: isAdmin ? branchFilter : undefined,
    status: statusFilter || undefined,
    customerId: customerFilter.customerId ?? undefined,
    q: q.trim() || undefined,
    from: from || undefined,
    to: to || undefined,
    limit: LIMIT,
    offset,
  };
  const list = trpc.installments.list.useQuery(listInput, { staleTime: 15_000 });
  const due = trpc.installments.dueSoon.useQuery(
    { branchId: isAdmin ? branchFilter : undefined, days: dueSoonDays },
    { staleTime: 15_000 },
  );
  const pendingExternal =
    trpc.installments.pendingExternalPayments.useQuery(
      { branchId: isAdmin ? branchFilter : undefined, limit: 100 },
      { staleTime: 10_000 },
    );

  const [createOpen, setCreateOpen] = useState(false);
  const [detailPlanId, setDetailPlanId] = useState<number | null>(null);
  const [payTarget, setPayTarget] = useState<PayTarget | null>(null);

  async function invalidateAll() {
    await Promise.all([
      utils.installments.list.invalidate(),
      utils.installments.dueSoon.invalidate(),
      utils.installments.get.invalidate(),
      utils.installments.pendingExternalPayments.invalidate(),
    ]);
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="الأقساط"
        description="جدولة تحصيل ذمّة العميل بدفعات مجدولة — سداد كل قسط يُنشئ سند قبض حقيقياً موثقاً."
        actions={
          <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
            <Plus className="size-4" aria-hidden /> خطة أقساط جديدة
          </Button>
        }
      />

      {/* المستحقّ قريباً — طابور التحصيل */}
      <DueSoonSection
        rows={due.data ?? []}
        isLoading={due.isLoading}
        days={dueSoonDays}
        onDaysChange={setDueSoonDays}
        onPay={(r) => setPayTarget({ lineId: r.lineId, branchId: r.branchId, seq: r.seq, amount: r.amount, kind: r.kind, checkNumber: r.checkNumber })}
      />

      <PendingExternalPaymentsPanel
        rows={pendingExternal.data ?? []}
        isLoading={pendingExternal.isLoading}
        isError={pendingExternal.isError}
        onRetry={() => void pendingExternal.refetch()}
        onOpen={(row) =>
          setPayTarget({
            lineId: row.lineId,
            branchId: row.branchId,
            seq: row.lineSeq,
            amount: row.amount,
            kind: "CASH",
            checkNumber: null,
            externalApproval: row,
          })
        }
      />

      {/* فلاتر */}
      <div className="flex flex-wrap items-end gap-3">
        {isAdmin && (
          <div className="space-y-1">
            <Label className="text-xs">الفرع</Label>
            <AppSelect
              value={String(branchFilter ?? "")}
              onValueChange={(value) => { setBranchFilter(value ? Number(value) : undefined); setOffset(0); }}
              className="h-9 border-input px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">كل الفروع</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </AppSelect>
          </div>
        )}
        <div className="space-y-1">
          <Label className="text-xs">الحالة</Label>
          <AppSelect
            value={statusFilter}
            onValueChange={(value) => { setStatusFilter(value as typeof statusFilter); setOffset(0); }}
            className="h-9 border-input px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">كل الحالات</option>
            <option value="ACTIVE">نشطة</option>
            <option value="COMPLETED">مكتملة</option>
            <option value="CANCELLED">ملغاة</option>
          </AppSelect>
        </div>
        <div className="min-w-64 flex-1 max-w-sm space-y-1">
          <Label className="text-xs">العميل</Label>
          <SmartCustomerInput
            value={customerFilter}
            onChange={(v) => { setCustomerFilter(v); setOffset(0); }}
            placeholder="فلترة بعميل معيّن…"
          />
        </div>
        <div className="min-w-48 space-y-1">
          <Label className="text-xs">بحث (رقم خطة/رقم صك)</Label>
          <Input
            value={q}
            onChange={(e) => { setQ(e.target.value); setOffset(0); }}
            placeholder="مثال: 42 أو رقم الصك…"
            className="h-9"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">أُنشئت من</Label>
          <Input type="date" dir="ltr" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} className="h-9" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">أُنشئت إلى</Label>
          <Input type="date" dir="ltr" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} className="h-9" />
        </div>
        <Button variant="outline" size="sm" onClick={() => list.refetch()} className="gap-1.5">
          <RotateCcw className="size-3.5" aria-hidden /> تحديث
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() =>
            void fetchAllPaged<PlanRow>(
              (pageOffset, pageLimit) =>
                utils.installments.list
                  .fetch({ ...listInput, limit: pageLimit, offset: pageOffset })
                  .then((r) => ({ rows: r.rows, total: r.hasMore ? undefined : pageOffset + r.rows.length })),
              { pageSize: 200 },
            ).then((rows) =>
              exportRows(rows, {
                filename: "خطط-الأقساط",
                title: "خطط الأقساط",
                columns: [
                  { key: "id", header: "رقم الخطة" },
                  { key: "customerName", header: "العميل" },
                  { key: "totalAmount", header: "الإجمالي", money: true, map: (r) => Number(r.totalAmount) },
                  { key: "downPayment", header: "الدفعة الأولى", money: true, map: (r) => Number(r.downPayment) },
                  { key: "paidAmount", header: "المدفوع", money: true, map: (r) => Number(r.paidAmount) },
                  { key: "status", header: "الحالة", map: (r) => PLAN_STATUS_AR[r.status]?.label ?? r.status },
                  { key: "nextDueDate", header: "القسط القادم", map: (r) => r.nextDueDate ?? "" },
                  { key: "createdAt", header: "أُنشئت", map: (r) => (r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : "") },
                ],
              }),
            )
          }
        >
          <Download className="size-3.5" aria-hidden /> تصدير Excel
        </Button>
      </div>

      {/* جدول الخطط */}
      <PlansTable
        rows={list.data?.rows ?? []}
        hasMore={list.data?.hasMore ?? false}
        isLoading={list.isLoading}
        isError={list.isError}
        refetch={() => list.refetch()}
        onDetail={setDetailPlanId}
        offset={offset}
        limit={LIMIT}
        onPage={(next) => setOffset(next)}
      />

      {/* حوار الإنشاء */}
      <CreatePlanDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        isAdmin={isAdmin}
        branches={branches.data ?? []}
        myBranchId={me.data?.branchId != null ? Number(me.data.branchId) : null}
        onCreated={async () => { setCreateOpen(false); await invalidateAll(); }}
      />

      {/* حوار التفاصيل */}
      {detailPlanId != null && (
        <PlanDetailDialog
          planId={detailPlanId}
          onClose={() => setDetailPlanId(null)}
          onPay={(l, planBranchId) => setPayTarget({ lineId: l.id, branchId: planBranchId, seq: l.seq, amount: l.amount, kind: l.kind, checkNumber: l.checkNumber })}
          onChanged={invalidateAll}
        />
      )}

      {/* حوار السداد */}
      {payTarget != null && (
        <PayLineDialog
          target={payTarget}
          onClose={() => setPayTarget(null)}
          onDone={async () => { setPayTarget(null); await invalidateAll(); }}
        />
      )}
    </div>
  );
}

/* ============================ اعتماد التحصيل غير النقدي ============================ */

function PendingExternalPaymentsPanel({
  rows,
  isLoading,
  isError,
  onRetry,
  onOpen,
}: {
  rows: PendingExternalPayment[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onOpen: (row: PendingExternalPayment) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">اعتماد التحصيل غير النقدي</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <LoadingState className="rounded-md border p-4" />
        ) : isError ? (
          <ErrorState
            className="rounded-md border border-destructive/30 p-4"
            message="تعذّر تحميل طابور الاعتماد."
            onRetry={onRetry}
          />
        ) : rows.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            لا توجد محاولات غير نقدية بانتظار الاعتماد أو السداد.
          </div>
        ) : (
          rows.map((row) => (
            <div
              key={row.attemptId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="min-w-0 space-y-1 text-sm">
                <p className="font-medium">
                  القسط #{row.lineSeq} — {row.customerName} — {fmt(row.amount)} د.ع
                </p>
                <p className="text-xs text-muted-foreground" dir="auto">
                  {row.paymentMethod} · المرجع {row.reference} · أنشأها {row.createdByName}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant={row.canConfirm || row.canSettle ? "default" : "outline"}
                disabled={!row.canConfirm && !row.canSettle}
                onClick={() => onOpen(row)}
              >
                {row.canSettle
                  ? "إكمال السداد"
                  : row.canConfirm
                    ? "اعتماد ومتابعة"
                    : "بانتظار موظف مستقل"}
              </Button>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/* ============================ المستحقّ قريباً ============================ */

function DueSoonSection({
  rows,
  isLoading,
  days,
  onDaysChange,
  onPay,
}: {
  rows: DueRow[];
  isLoading: boolean;
  /** نافذة «المستحقّ قريباً» بالأيام — الخادم يقبل حتى ٩٠ (installments.dueSoon). */
  days: number;
  onDaysChange: (days: number) => void;
  onPay: (r: DueRow) => void;
}) {
  if (isLoading) return null;
  const overdue = rows.filter((r) => r.daysOverdue > 0).length;
  return (
    <Card className="border-[var(--sem-warn)]/40">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlarmClock className="size-4 text-[var(--sem-warn)]" aria-hidden />
            المستحقّ قريباً ({rows.length} قسطاً{overdue > 0 ? ` — منها ${overdue} متأخّر` : ""})
          </CardTitle>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            خلال
            <AppSelect
              value={String(days)}
              onValueChange={(v) => onDaysChange(Number(v))}
              className="h-7 w-24 text-xs"
              size="sm"
              aria-label="نافذة المستحقّ قريباً بالأيام"
            >
              <option value="3">٣ أيام</option>
              <option value="7">٧ أيام</option>
              <option value="14">١٤ يوماً</option>
              <option value="30">٣٠ يوماً</option>
              <option value="60">٦٠ يوماً</option>
              <option value="90">٩٠ يوماً</option>
            </AppSelect>
          </label>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground text-center">لا أقساط مستحقّة خلال {days} يوماً.</p>
        ) : (
        <ScrollTableShell bordered={false} maxHeightClass="max-h-64">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">العميل</TableHead>
                <TableHead className="text-center">القسط</TableHead>
                <TableHead className="text-center">الاستحقاق</TableHead>
                <TableHead className="text-center">التأخّر</TableHead>
                <TableHead className="text-left">المبلغ</TableHead>
                <TableHead className="text-center">النوع</TableHead>
                <TableHead className="text-center">إجراء</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.lineId} className={r.daysOverdue > 0 ? "bg-destructive/5" : ""}>
                  <TableCell className="font-medium">
                    {r.customerName}
                    {r.customerPhone && <span className="ms-2 text-xs text-muted-foreground" dir="ltr">{r.customerPhone}</span>}
                  </TableCell>
                  <TableCell className="text-center tabular-nums">{r.seq} — خطة #{r.planId}</TableCell>
                  <TableCell className="text-center text-xs tabular-nums" dir="ltr">{r.dueDate}</TableCell>
                  <TableCell className="text-center">
                    {r.daysOverdue > 0 ? (
                      <span className="inline-flex items-center rounded-md bg-destructive/15 px-2 py-0.5 text-xs font-bold text-destructive tabular-nums">
                        {r.daysOverdue} يوماً
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">في الموعد</span>
                    )}
                  </TableCell>
                  <TableCell className="text-left font-bold tabular-nums" dir="ltr">{fmt(r.amount)}</TableCell>
                  <TableCell className="text-center text-xs">
                    {r.kind === "CHECK" ? (
                      <span className="inline-flex items-center gap-1">
                        <Landmark className="size-3 text-muted-foreground" aria-hidden />
                        صك {r.checkNumber ?? ""}{r.bankName ? ` — ${r.bankName}` : ""}
                      </span>
                    ) : (
                      "نقدي"
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <RowActions
                      mode="inline"
                      contact={{
                        phone: r.customerPhone,
                        label: `واتساب ${r.customerName}`,
                        message: buildOperationalContactMessage({
                          entityLabel: "قسط",
                          reference: `${r.planId}-${r.seq}`,
                          partyName: r.customerName,
                          title: `القسط المستحق: ${fmt(r.amount)} د.ع`,
                          dueAt: r.dueDate,
                          status: r.daysOverdue > 0 ? `متأخر ${r.daysOverdue} يوماً` : "قريب الاستحقاق",
                          nextAction: "يرجى تأكيد موعد السداد.",
                        }),
                        gate: { module: "treasury", level: "READ" },
                      }}
                      actions={[{
                        key: "pay",
                        kind: "pay",
                        label: "سداد",
                        icon: CircleDollarSign,
                        onSelect: () => onPay(r),
                        gate: { roles: ["manager", "accountant"], module: "treasury", level: "FULL" },
                      }]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollTableShell>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================ جدول الخطط ============================ */

function PlansTable({
  rows,
  hasMore,
  isLoading,
  isError,
  refetch,
  onDetail,
  offset,
  limit,
  onPage,
}: {
  rows: PlanRow[];
  hasMore: boolean;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  onDetail: (planId: number) => void;
  offset: number;
  limit: number;
  onPage: (offset: number) => void;
}) {
  if (isLoading) return <LoadingState />;
  if (isError) return <ErrorState message="تعذّر تحميل الخطط." onRetry={refetch} />;
  if (rows.length === 0 && offset === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <CalendarPlus className="size-10 text-muted-foreground" aria-hidden />
          <p className="text-lg font-semibold">لا خطط أقساط بعد</p>
          <p className="text-sm text-muted-foreground">أنشئ خطة لجدولة تحصيل ذمّة عميل بدفعات نقدية مجدولة.</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-0">
        <ScrollTableShell bordered={false}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-center">#</TableHead>
                <TableHead className="text-right">العميل</TableHead>
                <TableHead className="text-left">الإجمالي</TableHead>
                <TableHead className="text-left">الدفعة الأولى</TableHead>
                <TableHead className="text-center">التقدّم</TableHead>
                <TableHead className="text-center">القسط القادم</TableHead>
                <TableHead className="text-center">الحالة</TableHead>
                <TableHead className="text-center">أُنشئت</TableHead>
                <TableHead className="text-center">تفاصيل</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p: PlanRow) => (
                <TableRow key={p.id}>
                  <TableCell className="text-center tabular-nums">{p.id}</TableCell>
                  <TableCell className="font-medium">
                    {p.customerName}
                    {p.invoiceId != null && (
                      <span className="ms-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        <FileText className="size-3" aria-hidden /> فاتورة #{p.invoiceId}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-left font-bold tabular-nums" dir="ltr">{fmt(p.totalAmount)}</TableCell>
                  <TableCell className="text-left tabular-nums" dir="ltr">{fmt(p.downPayment)}</TableCell>
                  <TableCell className="text-center">
                    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs tabular-nums">
                      <CheckCircle2 className={`size-3 ${p.paidLines === p.totalLines && p.totalLines > 0 ? "text-[var(--sem-pos)]" : "text-muted-foreground"}`} aria-hidden />
                      مدفوع {p.paidLines} من {p.totalLines}
                    </span>
                    {D(p.paidAmount).gt(0) && (
                      <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums" dir="ltr">{fmt(p.paidAmount)}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-center text-xs tabular-nums" dir="ltr">{p.nextDueDate ?? "—"}</TableCell>
                  <TableCell className="text-center"><StatusBadge map={PLAN_STATUS_AR} value={p.status} /></TableCell>
                  <TableCell className="text-center text-xs text-muted-foreground tabular-nums" dir="ltr">
                    {p.createdAt ? fmtDateTime(p.createdAt as unknown as string) : "—"}
                  </TableCell>
                  <TableCell className="text-center">
                    <RowActions
                      mode="inline"
                      contact={{
                        phone: p.customerPhone,
                        label: `واتساب ${p.customerName}`,
                        message: buildOperationalContactMessage({
                          entityLabel: "خطة أقساط",
                          reference: String(p.id),
                          partyName: p.customerName,
                          title: `إجمالي الخطة: ${fmt(p.totalAmount)} د.ع`,
                          dueAt: p.nextDueDate,
                          status: PLAN_STATUS_AR[p.status]?.label ?? p.status,
                          nextAction: p.nextDueDate ? "يرجى تأكيد موعد القسط القادم." : undefined,
                        }),
                        gate: { module: "treasury", level: "READ" },
                      }}
                      actions={[{
                        key: "detail",
                        kind: "view",
                        label: "عرض",
                        onSelect: () => onDetail(p.id),
                        gate: { module: "treasury", level: "READ" },
                      }]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollTableShell>
        <div className="flex items-center justify-between border-t p-2 text-xs text-muted-foreground">
          <span>عرض {rows.length} خطة (من {offset + 1})</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>
              السابق
            </Button>
            <Button size="sm" variant="outline" disabled={!hasMore} onClick={() => onPage(offset + limit)}>
              التالي
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ============================ حوار إنشاء خطة ============================ */

interface DraftLine {
  dueDate: string;
  amount: string;
}

function CreatePlanDialog({
  open,
  onClose,
  isAdmin,
  branches,
  myBranchId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
  branches: { id: number; name: string }[];
  myBranchId: number | null;
  onCreated: () => Promise<void> | void;
}) {
  const [customer, setCustomer] = useState<SmartCustomerValue>(EMPTY_CUSTOMER);
  const [branchId, setBranchId] = useState<number | null>(null);
  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const [total, setTotal] = useState("");
  const [count, setCount] = useState(3);
  const [firstDue, setFirstDue] = useState(addDays(todayYmd(), 30));
  const [intervalDays, setIntervalDays] = useState(30);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [createClientRequestId, setCreateClientRequestId] = useState(() => crypto.randomUUID());

  const effectiveBranch = isAdmin ? (branchId ?? branches[0]?.id ?? null) : myBranchId;
  const invoiceOptions = trpc.sales.list.useQuery(
    {
      customerId: customer.customerId ?? undefined,
      branchId: effectiveBranch ?? undefined,
      balanceState: "OUTSTANDING",
      limit: 100,
    },
    {
      enabled: customer.customerId != null && effectiveBranch != null,
      staleTime: 15_000,
    },
  );

  function invoiceOutstanding(inv: { total: string | null; paidAmount: string | null; returnedTotal: string | null }) {
    return D(inv.total ?? "0").minus(D(inv.paidAmount ?? "0")).minus(D(inv.returnedTotal ?? "0"));
  }

  const create = trpc.installments.create.useMutation({
    onSuccess: async (r) => {
      notify.ok(`أُنشئت خطة الأقساط #${r.planId}`);
      resetForm();
      await onCreated();
    },
    onError: (e) => notify.err(e.message || "تعذّر إنشاء الخطة"),
  });

  function resetForm() {
    setCustomer(EMPTY_CUSTOMER);
    setInvoiceId(null);
    setTotal("");
    setCount(3);
    setFirstDue(addDays(todayYmd(), 30));
    setIntervalDays(30);
    setNotes("");
    setLines([]);
    setCreateClientRequestId(crypto.randomUUID());
  }

  /** توليد أسطر متساوية: الإجمالي ÷ العدد، والسطر الأخير يمتصّ فرق التقريب ⇒ Σ مطابق دائماً. */
  function generateLines() {
    const n = Math.max(1, Math.min(60, Math.floor(count)));
    const remaining = D(total);
    if (remaining.lte(0)) {
      notify.err("إجمالي الخطة يجب أن يكون موجباً");
      return;
    }
    const per = remaining.div(n).toDecimalPlaces(2, 1 /* ROUND_DOWN */);
    const last = remaining.minus(per.times(n - 1)).toDecimalPlaces(2);
    const next: DraftLine[] = [];
    for (let i = 0; i < n; i++) {
      next.push({
        dueDate: addDays(firstDue, i * Math.max(1, intervalDays)),
        amount: (i === n - 1 ? last : per).toFixed(2),
      });
    }
    setLines(next);
  }

  function updateLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  const linesSum = useMemo(() => lines.reduce((acc, l) => acc.plus(D(l.amount || "0")), D(0)), [lines]);
  const scheduled = linesSum;
  const diff = D(total || "0").minus(scheduled);
  const sumMatches = total !== "" && lines.length > 0 && diff.isZero();
  const datesAscending = lines.every((l, i) => i === 0 || l.dueDate >= lines[i - 1].dueDate);
  const canSubmit =
    customer.customerId != null &&
    invoiceId != null &&
    effectiveBranch != null &&
    sumMatches &&
    datesAscending &&
    lines.every((l) => l.dueDate && D(l.amount || "0").gt(0)) &&
    !create.isPending;

  function submit() {
    if (!canSubmit || customer.customerId == null || effectiveBranch == null || invoiceId == null) return;
    create.mutate({
      clientRequestId: createClientRequestId,
      customerId: customer.customerId,
      invoiceId,
      branchId: effectiveBranch,
      totalAmount: D(total).toFixed(2),
      notes: notes.trim() || undefined,
      lines: lines.map((l) => ({
        dueDate: l.dueDate,
        amount: D(l.amount).toFixed(2),
      })),
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { resetForm(); onClose(); } }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>خطة أقساط جديدة</DialogTitle>
          <DialogDescription>
            جدولة تحصيل فوق ذمّة العميل القائمة — لا قيد محاسبي عند الإنشاء؛ كل سداد لاحق يُنشئ سند قبض حقيقياً.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label>العميل *</Label>
              <SmartCustomerInput
                value={customer}
                onChange={(next) => {
                  setCustomer(next);
                  setInvoiceId(null);
                  setTotal("");
                  setLines([]);
                }}
                placeholder="ابحث عن عميل قائم…"
              />
              {customer.isNew && (
                <p className="text-xs text-destructive">اختر عميلاً قائماً — خطة الأقساط تتطلب عميلاً مسجَّلاً.</p>
              )}
            </div>
            {isAdmin && (
              <div className="space-y-1">
                <Label>الفرع *</Label>
                <AppSelect
                  value={String(effectiveBranch ?? "")}
                  onValueChange={(value) => {
                    setBranchId(value ? Number(value) : null);
                    setInvoiceId(null);
                    setTotal("");
                    setLines([]);
                  }}
                  className="h-9 border-input px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </AppSelect>
              </div>
            )}
            <div className="space-y-1 sm:col-span-2">
              <Label>الفاتورة المستحقّة *</Label>
              <AppSelect
                value={invoiceId == null ? "" : String(invoiceId)}
                onValueChange={(value) => {
                  const nextId = value ? Number(value) : null;
                  setInvoiceId(nextId);
                  const selected = (invoiceOptions.data ?? []).find((inv) => Number(inv.id) === nextId);
                  setTotal(selected ? invoiceOutstanding(selected).toFixed(2) : "");
                  setLines([]);
                }}
                aria-label="الفاتورة المستحقة لخطة الأقساط"
                disabled={customer.customerId == null || invoiceOptions.isLoading}
              >
                <option value="">اختر فاتورة مستحقّة</option>
                {(invoiceOptions.data ?? []).map((inv) => {
                  const outstanding = invoiceOutstanding(inv);
                  return (
                    <option key={Number(inv.id)} value={String(inv.id)}>
                      فاتورة #{inv.invoiceNumber} — متبقٍّ {fmt(outstanding.toFixed(2))} د.ع
                    </option>
                  );
                })}
              </AppSelect>
              {invoiceOptions.isError && (
                <p className="text-xs text-destructive">تعذّر تحميل فواتير العميل؛ أعد المحاولة قبل إنشاء الخطة.</p>
              )}
              {customer.customerId != null && !invoiceOptions.isLoading && !invoiceOptions.isError && (invoiceOptions.data ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">لا توجد فاتورة حيّة بمبلغ متبقٍّ لهذا العميل في الفرع المحدد.</p>
              )}
            </div>
            <div className="space-y-1">
              <Label>إجمالي الخطة الحي (د.ع)</Label>
              <MoneyInput value={total} onChange={() => {}} ariaLabel="إجمالي الخطة الحي" readOnly />
              <p className="text-[11px] text-muted-foreground">مشتق من إجمالي الفاتورة ناقص المدفوع والمرتجع، ويُعاد التحقق منه عند الحفظ تحت القفل.</p>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                لدفعةٍ أولى: سجّلها <span className="font-medium">سندَ قبضٍ نقديٍّ</span> أولاً (لا دينار بلا سند)، ثم أنشئ الخطة على المتبقّي — الخطة تُجدوَل على الإجمالي أعلاه بالكامل.
              </p>
            </div>
          </div>

          {/* مولّد الأقساط */}
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-xs">عدد الأقساط</Label>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                  className="h-9 w-24"
                  dir="ltr"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">أول استحقاق</Label>
                <Input type="date" value={firstDue} min={todayYmd()} onChange={(e) => setFirstDue(e.target.value)} className="h-9 w-40" dir="ltr" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">الفاصل (أيام)</Label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={intervalDays}
                  onChange={(e) => setIntervalDays(Number(e.target.value))}
                  className="h-9 w-24"
                  dir="ltr"
                />
              </div>
              <Button type="button" variant="secondary" onClick={generateLines} disabled={!total || D(total).lte(0)} className="gap-1.5">
                <CalendarPlus className="size-4" aria-hidden /> توليد أسطر متساوية
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              تُولَّد أسطر متساوية قابلة للتحرير سطراً-سطراً (تاريخ/مبلغ) — السطر الأخير يمتصّ فرق التقريب.
            </p>
          </div>

          {/* محرّر الأسطر */}
          {lines.length > 0 && (
            <div className="space-y-2">
              <ScrollTableShell maxHeightClass="max-h-72">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-center">#</TableHead>
                      <TableHead className="text-center">الاستحقاق</TableHead>
                      <TableHead className="text-center">المبلغ</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((l, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-center tabular-nums">{i + 1}</TableCell>
                        <TableCell>
                          <Input type="date" value={l.dueDate} onChange={(e) => updateLine(i, { dueDate: e.target.value })} className="h-8 w-36" dir="ltr" />
                        </TableCell>
                        <TableCell>
                          <MoneyInput value={l.amount} onChange={(v) => updateLine(i, { amount: v })} className="h-8 w-32" ariaLabel={`مبلغ القسط ${i + 1}`} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollTableShell>

              {/* تحقّق حيّ للمجموع */}
              <div
                className={`rounded-md border p-2 text-sm tabular-nums ${sumMatches ? "border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : "border-destructive/40 bg-destructive/5 text-destructive"}`}
                role="status"
              >
                مجموع الأقساط <span dir="ltr">{fmt(scheduled.toFixed(2))}</span>
                {sumMatches ? (
                  <span className="ms-2 font-semibold">يطابق الإجمالي</span>
                ) : (
                  <span className="ms-2 font-semibold">لا يطابق الإجمالي <span dir="ltr">{fmt(total || "0")}</span> — الفرق <span dir="ltr">{fmt(diff.toFixed(2))}</span></span>
                )}
              </div>
              {!datesAscending && <p className="text-xs text-destructive">تواريخ الأقساط يجب أن تكون متصاعدة.</p>}
            </div>
          )}

          <div className="space-y-1">
            <Label>ملاحظات</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={1000} placeholder="اتفاق التقسيط، ضمانات، …" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { resetForm(); onClose(); }}>إلغاء</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {create.isPending ? ACTION_LABELS.saving : "إنشاء الخطة"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================ حوار تفاصيل الخطة ============================ */

function PlanDetailDialog({
  planId,
  onClose,
  onPay,
  onChanged,
}: {
  planId: number;
  onClose: () => void;
  onPay: (line: PlanLine, branchId: number) => void;
  onChanged: () => Promise<void> | void;
}) {
  const plan = trpc.installments.get.useQuery({ planId });
  const [bounceTarget, setBounceTarget] = useState<PlanLine | null>(null);
  const [bounceNote, setBounceNote] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelClientRequestId, setCancelClientRequestId] = useState(() => crypto.randomUUID());

  const bounce = trpc.installments.bounce.useMutation({
    onSuccess: async (res) => {
      notify.ok(res.reversed ? "سُجِّل ارتجاع الصك وعُكِس التحصيل (رُدَّ رصيد العميل)" : "سُجِّل ارتجاع الصك");
      setBounceTarget(null);
      setBounceNote("");
      await plan.refetch();
      await onChanged();
    },
    onError: (e) => notify.err(e.message || "تعذّر تسجيل الارتجاع"),
  });
  const cancel = trpc.installments.cancel.useMutation({
    onSuccess: async () => {
      notify.ok("أُلغيت الخطة");
      setCancelOpen(false);
      await plan.refetch();
      await onChanged();
    },
    onError: (e) => notify.err(e.message || "تعذّر إلغاء الخطة"),
  });

  const p = plan.data;
  const hasPaid = (p?.lines ?? []).some((l) => l.status === "PAID");

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>خطة الأقساط #{planId}</DialogTitle>
          {p && (
            <DialogDescription>
              {p.customerName} — الإجمالي <span dir="ltr" className="tabular-nums">{fmt(p.totalAmount)}</span> د.ع
              {D(p.downPayment).gt(0) && <> (دفعة أولى <span dir="ltr" className="tabular-nums">{fmt(p.downPayment)}</span>)</>}
              {p.invoiceId != null && <> — مرتبطة بالفاتورة #{p.invoiceId}</>}
            </DialogDescription>
          )}
        </DialogHeader>

        {plan.isLoading && <LoadingState />}
        {plan.isError && <ErrorState message="تعذّر تحميل الخطة." onRetry={() => plan.refetch()} />}

        {p && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge map={PLAN_STATUS_AR} value={p.status} />
              {p.notes && <span className="text-xs text-muted-foreground">{p.notes}</span>}
            </div>

            <ScrollTableShell maxHeightClass="max-h-80">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-center">#</TableHead>
                    <TableHead className="text-center">الاستحقاق</TableHead>
                    <TableHead className="text-left">المبلغ</TableHead>
                    <TableHead className="text-center">النوع</TableHead>
                    <TableHead className="text-center">الحالة</TableHead>
                    <TableHead className="text-right">ملاحظة/سند</TableHead>
                    <TableHead className="text-center">إجراءات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="text-center tabular-nums">{l.seq}</TableCell>
                      <TableCell className="text-center text-xs tabular-nums" dir="ltr">{l.dueDate}</TableCell>
                      <TableCell className="text-left font-semibold tabular-nums" dir="ltr">{fmt(l.amount)}</TableCell>
                      <TableCell className="text-center text-xs">
                        {l.kind === "CHECK" ? `صك ${l.checkNumber ?? ""}${l.bankName ? ` — ${l.bankName}` : ""}` : "نقدي"}
                      </TableCell>
                      <TableCell className="text-center"><StatusBadge map={LINE_STATUS_AR} value={l.status} /></TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {l.receiptId != null && <span className="tabular-nums">سند #{l.receiptId}</span>}
                        {l.receiptId != null && l.note ? " — " : ""}
                        {l.note ?? ""}
                      </TableCell>
                      <TableCell className="text-center whitespace-nowrap">
                        <RowActions
                          mode="inline"
                          contact={{
                            phone: p.customerPhone,
                            label: `واتساب ${p.customerName}`,
                            message: buildOperationalContactMessage({
                              entityLabel: "قسط",
                              reference: `${p.id}-${l.seq}`,
                              partyName: p.customerName,
                              title: `قيمة القسط: ${fmt(l.amount)} د.ع`,
                              dueAt: l.dueDate,
                              status: LINE_STATUS_AR[l.status]?.label ?? l.status,
                              nextAction: "يرجى تأكيد حالة السداد.",
                            }),
                            gate: { module: "treasury", level: "READ" },
                          }}
                          actions={[
                            {
                              key: "pay",
                              kind: "pay",
                              label: "سداد",
                              icon: CircleDollarSign,
                              hidden: p.status !== "ACTIVE" || (l.status !== "PENDING" && l.status !== "BOUNCED"),
                              onSelect: () => onPay(l, Number(p.branchId)),
                              gate: { roles: ["manager", "accountant"], module: "treasury", level: "FULL" },
                            },
                            {
                              key: "bounce",
                              kind: "reverse",
                              label: "ارتجاع",
                              icon: Undo2,
                              variant: "destructive",
                              hidden:
                                p.status === "CANCELLED"
                                || l.kind !== "CHECK"
                                || (l.status !== "PENDING" && !(l.status === "PAID" && l.receiptPaymentMethod === "CHECK")),
                              onSelect: () => setBounceTarget(l),
                              gate: { roles: ["manager", "accountant"], module: "treasury", level: "FULL" },
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollTableShell>

            {p.status === "ACTIVE" && (
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  className="gap-1 text-destructive"
                  disabled={hasPaid}
                  title={hasPaid ? "لا يمكن إلغاء خطة سُدِّد منها قسط" : undefined}
                  onClick={() => {
                    setCancelClientRequestId(crypto.randomUUID());
                    setCancelOpen(true);
                  }}
                >
                  <Ban className="size-4" aria-hidden /> إلغاء الخطة
                </Button>
              </div>
            )}
          </div>
        )}

        {/* حوار الارتجاع */}
        <Dialog open={bounceTarget != null} onOpenChange={(o) => { if (!o) { setBounceTarget(null); setBounceNote(""); } }}>
          <DialogContent className="z-[100] sm:max-w-md">
            <DialogHeader>
              <DialogTitle>ارتجاع صك — القسط رقم {bounceTarget?.seq}</DialogTitle>
              <DialogDescription>
                {bounceTarget?.status === "PAID"
                  ? "الصك مُحصَّل — سيُصدَر إيصال صرف معاكس (خزينة) ويُستعاد رصيد العميل بمقدار القسط، ثم يُوسم «صك مرتجع» قابلاً للسداد لاحقاً."
                  : "يُوسم القسط «صك مرتجع» بلا أي حركة مالية (الصك لم يُحصَّل أصلاً)، ويبقى قابلاً للسداد لاحقاً."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <Label>سبب الارتجاع</Label>
              <Textarea value={bounceNote} onChange={(e) => setBounceNote(e.target.value)} rows={2} maxLength={255} placeholder="مثال: رصيد غير كافٍ" />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setBounceTarget(null)}>تراجع</Button>
              <Button
                variant="destructive"
                disabled={bounce.isPending}
                onClick={() => bounceTarget && bounce.mutate({ lineId: bounceTarget.id, note: bounceNote.trim() || undefined })}
              >
                {bounce.isPending ? "جارٍ…" : "تسجيل الارتجاع"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* حوار الإلغاء */}
        <Dialog open={cancelOpen} onOpenChange={(o) => { if (!o) setCancelOpen(false); }}>
          <DialogContent className="z-[100] sm:max-w-md">
            <DialogHeader>
              <DialogTitle>إلغاء خطة الأقساط #{planId}</DialogTitle>
              <DialogDescription>تُلغى الخطة وكل أقساطها المعلَّقة — متاح فقط لخطة بلا أي قسط مسدَّد.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <Label>سبب الإلغاء</Label>
              <Textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={2} maxLength={500} placeholder="اختياري" />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCancelOpen(false)}>تراجع</Button>
              <Button
                variant="destructive"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate({
                  planId,
                  reason: cancelReason.trim() || undefined,
                  clientRequestId: cancelClientRequestId,
                })}
              >
                {cancel.isPending ? "جارٍ…" : "تأكيد الإلغاء"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

/* ============================ حوار السداد ============================ */

function PayLineDialog({
  target,
  onClose,
  onDone,
}: {
  target: PayTarget;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const approval = target.externalApproval;
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const [method, setMethod] = useState<PosPaymentMethod>(
    (approval?.paymentMethod as PosPaymentMethod | undefined) ?? "CASH",
  );
  const [reference, setReference] = useState(approval?.reference ?? "");
  const [cardLastFour, setCardLastFour] = useState("");
  const [note, setNote] = useState("");
  const [attachment, setAttachment] = useState<ImageItem[]>([]);
  const [externalAttempt, setExternalAttempt] = useState<{
    attemptId: number | null;
    requestId: string;
    deviceId: string;
    fingerprint: string;
    confirmed: boolean;
  } | null>(approval ? {
    attemptId: approval.attemptId,
    requestId: "",
    deviceId: approval.deviceId,
    fingerprint: `SALES_COLLECTION|${approval.branchId}|${approval.paymentMethod}|${D(approval.amount).toFixed(2)}|${approval.reference.trim()}`,
    confirmed: approval.state === "CONFIRMED",
  } : null);

  const normalizedAmount = D(target.amount).toFixed(2);
  const externalFingerprint = `SALES_COLLECTION|${target.branchId}|${method}|${normalizedAmount}|${reference.trim()}`;
  const externalConfirmed =
    method === "CASH" ||
    (externalAttempt?.confirmed === true &&
      externalAttempt.fingerprint === externalFingerprint);

  const initiateExternal = trpc.installments.initiateExternalPayment.useMutation();
  const confirmExternal = trpc.installments.confirmExternalPayment.useMutation();

  const pay = trpc.installments.pay.useMutation({
    onSuccess: async (r) => {
      if (r.status === "PENDING_APPROVAL") {
        notify.ok(
          `أُنشئ السند ${r.voucherNumber} بانتظار اعتماد مدير ثانٍ`,
          "القسط يبقى معلَّقاً حتى الاعتماد — بعد الاعتماد من شاشة السندات أعد «سداد» لوسمه مسدَّداً.",
        );
      } else {
        notify.ok(`سُدِّد القسط — سند قبض ${r.voucherNumber}`, r.planCompleted ? "اكتملت كل أقساط الخطة." : undefined);
      }
      await onDone();
    },
    onError: (e) => notify.err(e.message || "تعذّر السداد"),
  });

  async function confirmProviderPayment() {
    if (method === "CASH") return;
    const normalizedReference = reference.trim();
    if (!normalizedReference) {
      notify.err("مرجع العملية إلزامي قبل تأكيد الدفع الخارجي");
      return;
    }
    try {
      const prior =
        externalAttempt?.fingerprint === externalFingerprint
          ? externalAttempt
          : null;
      const deviceId = prior?.deviceId ?? (await getDeviceCode());
      const requestId = prior?.requestId ?? crypto.randomUUID();
      let attemptId = prior?.attemptId ?? null;
      if (attemptId == null) {
        // ثبّت requestId+device قبل النداء: إن انقطعت الشبكة بعد إنشاء المحاولة، تعيد
        // النقرة التالية نفس الطلب بدلاً من إنشاء مرجع متعارض لا يمكن استعادته.
        setExternalAttempt({
          attemptId: null,
          requestId,
          deviceId,
          fingerprint: externalFingerprint,
          confirmed: false,
        });
        const initiated = await initiateExternal.mutateAsync({
          branchId: target.branchId,
          lineId: target.lineId,
          method,
          amount: normalizedAmount,
          reference: normalizedReference,
          requestId,
          deviceId,
        });
        attemptId = initiated.attemptId;
        setExternalAttempt({
          attemptId,
          requestId,
          deviceId,
          fingerprint: externalFingerprint,
          confirmed: false,
        });
        notify.ok(
          "أُرسلت محاولة التحصيل للاعتماد",
          "يجب أن يؤكدها موظف خزينة مستقل ثم يُكمل السداد من طابور الاعتماد.",
        );
        await onDone();
        onClose();
        return;
      }
      if (!approval?.canConfirm) {
        notify.err("لا يحق لهذا المستخدم تأكيد المحاولة؛ يلزم موظف مستقل.");
        return;
      }
      await confirmExternal.mutateAsync({
        branchId: target.branchId,
        lineId: target.lineId,
        attemptId,
        deviceId,
      });
      setExternalAttempt({
        attemptId,
        requestId,
        deviceId,
        fingerprint: externalFingerprint,
        confirmed: true,
      });
      notify.ok("تأكّد الدفع الخارجي", "أصبح جاهزاً للاستهلاك مرة واحدة مع سند القسط.");
    } catch (error) {
      notify.err(error);
    }
  }

  const cardEvidenceValid = method !== "CARD" || /^\d{4}$/.test(cardLastFour);
  const canSubmit =
    externalConfirmed &&
    (method === "CASH" || approval?.canConfirm === true || approval?.canSettle === true) &&
    cardEvidenceValid &&
    !pay.isPending &&
    !initiateExternal.isPending &&
    !confirmExternal.isPending;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="z-[100] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>سداد القسط رقم {target.seq}</DialogTitle>
          <DialogDescription>
            المبلغ <span dir="ltr" className="font-bold tabular-nums">{fmt(target.amount)}</span> د.ع — يُنشأ سند قبض حقيقي يُحرّك ذمّة العميل والدفتر.
            {target.kind === "CHECK" && target.checkNumber && (
              <> — كان مجدولاً سابقاً بصك رقم <span dir="ltr">{target.checkNumber}</span>.</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>طريقة السداد</Label>
            <AppSelect
              value={method}
              disabled={approval != null || (externalConfirmed && method !== "CASH")}
              onValueChange={(value) => {
                setMethod(value as PosPaymentMethod);
                setExternalAttempt(null);
                setReference("");
                setCardLastFour("");
              }}
            >
              {POS_METHODS.map((option) => (
                <option key={option.v} value={option.v}>{option.label}</option>
              ))}
            </AppSelect>
          </div>
          {method !== "CASH" && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="space-y-1">
                <Label htmlFor="installment-payment-reference">مرجع العملية *</Label>
                <Input
                  id="installment-payment-reference"
                  dir="ltr"
                  value={reference}
                  disabled={approval != null || externalConfirmed || initiateExternal.isPending || confirmExternal.isPending}
                  onChange={(event) => {
                    setReference(event.target.value);
                    setExternalAttempt(null);
                  }}
                  maxLength={100}
                  placeholder="رقم إشعار الجهاز أو التحويل"
                />
              </div>
              {method === "CARD" && (
                <div className="space-y-1">
                  <Label htmlFor="installment-card-last-four">آخر ٤ من البطاقة *</Label>
                  <Input
                    id="installment-card-last-four"
                    dir="ltr"
                    inputMode="numeric"
                    value={cardLastFour}
                    onChange={(event) => setCardLastFour(event.target.value.replace(/\D/g, "").slice(0, 4))}
                    maxLength={4}
                    placeholder="1234"
                  />
                </div>
              )}
              <Button
                type="button"
                variant={externalConfirmed ? "outline" : "secondary"}
                className="w-full"
                disabled={
                  !reference.trim() ||
                  externalConfirmed ||
                  (approval != null && !approval.canConfirm) ||
                  initiateExternal.isPending ||
                  confirmExternal.isPending
                }
                onClick={() => void confirmProviderPayment()}
              >
                {initiateExternal.isPending || confirmExternal.isPending
                  ? "جارٍ تثبيت التأكيد…"
                  : externalConfirmed
                    ? "الدفع معتمد — أكمل السداد"
                    : approval?.canConfirm
                      ? "اعتماد الدفع كموظف مستقل"
                      : "إرسال لاعتماد موظف مستقل"}
              </Button>
              <p className="text-xs text-muted-foreground">
                المنشئ يرسل المحاولة فقط؛ موظف مستقل يؤكدها ويسددها مرة واحدة مع السند والقيد.
              </p>
            </div>
          )}
          {!cardEvidenceValid && (
            <p className="text-xs text-destructive">أدخل آخر ٤ أرقام صحيحة للبطاقة.</p>
          )}
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            السداد النقدي يدخل الخزينة، وغير النقد يرتبط بإثبات المزوّد ولا يدخل الدلو النقدي.
          </div>
          <div className="space-y-1">
            <Label>ملاحظة</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} placeholder="اختياري" />
          </div>
          <div className="space-y-1">
            <Label>مُرفَق السند (اختياري)</Label>
            <ImageUploader
              value={attachment}
              onChange={setAttachment}
              maxItems={1}
              maxSizeMB={2}
              singlePrimary={false}
              hint="صورة وصل التحصيل — تُضغط تلقائياً قبل الحفظ."
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button
            disabled={!canSubmit}
            onClick={() => {
              pay.mutate({
                lineId: target.lineId,
                clientRequestId,
                paymentMethod: method,
                referenceNumber: method === "CASH" ? undefined : reference.trim(),
                cardLastFour: method === "CARD" ? cardLastFour : undefined,
                externalPaymentAttemptId:
                  method === "CASH" ? undefined : externalAttempt?.attemptId,
                deviceId:
                  method === "CASH" ? undefined : externalAttempt?.deviceId,
                note: note.trim() || undefined,
                attachmentUrl: attachment[0]?.dataUrl || undefined,
              });
            }}
          >
            {pay.isPending ? "جارٍ السداد…" : "تأكيد السداد"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
