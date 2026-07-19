// بند 12أ (٧/٧): شاشة الأقساط والشيكات الآجلة — تبويب «الأقساط» في محور العملاء.
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
  FileText,
  Landmark,
  Plus,
  RotateCcw,
  Undo2,
} from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { D, fmt } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { MoneyInput } from "@/components/form/MoneyInput";
import { SmartCustomerInput, type SmartCustomerValue } from "@/components/form/SmartCustomerInput";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
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

const EMPTY_CUSTOMER: SmartCustomerValue = { customerId: null, name: "", phone: null, isNew: false };

const PLAN_STATUS_AR: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: "نشطة", cls: "bg-emerald-100 text-emerald-700" },
  COMPLETED: { label: "مكتملة", cls: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]" },
  CANCELLED: { label: "ملغاة", cls: "bg-muted text-muted-foreground" },
};
const LINE_STATUS_AR: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "معلَّق", cls: "bg-amber-500/15 text-amber-800" },
  PAID: { label: "مسدَّد", cls: "bg-emerald-100 text-emerald-700" },
  BOUNCED: { label: "شيك مرتجع", cls: "bg-destructive/15 text-destructive" },
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
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  const listInput = {
    branchId: isAdmin ? branchFilter : undefined,
    status: statusFilter || undefined,
    customerId: customerFilter.customerId ?? undefined,
    limit: LIMIT,
    offset,
  };
  const list = trpc.installments.list.useQuery(listInput, { staleTime: 15_000 });
  const due = trpc.installments.dueSoon.useQuery(
    { branchId: isAdmin ? branchFilter : undefined, days: 7 },
    { staleTime: 15_000 },
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [detailPlanId, setDetailPlanId] = useState<number | null>(null);
  const [payTarget, setPayTarget] = useState<{ lineId: number; seq: number; amount: string; kind: string; checkNumber: string | null } | null>(null);

  async function invalidateAll() {
    await Promise.all([utils.installments.list.invalidate(), utils.installments.dueSoon.invalidate(), utils.installments.get.invalidate()]);
  }

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="الأقساط والشيكات الآجلة"
        description="جدولة تحصيل ذمّة العميل بدفعات نقدية أو شيكات آجلة — سداد كل قسط يُنشئ سند قبض حقيقياً."
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
        onPay={(r) => setPayTarget({ lineId: r.lineId, seq: r.seq, amount: r.amount, kind: r.kind, checkNumber: r.checkNumber })}
      />

      {/* فلاتر */}
      <div className="flex flex-wrap items-end gap-3">
        {isAdmin && (
          <div className="space-y-1">
            <Label className="text-xs">الفرع</Label>
            <select
              value={String(branchFilter ?? "")}
              onChange={(e) => { setBranchFilter(e.target.value ? Number(e.target.value) : undefined); setOffset(0); }}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">كل الفروع</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="space-y-1">
          <Label className="text-xs">الحالة</Label>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value as typeof statusFilter); setOffset(0); }}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">كل الحالات</option>
            <option value="ACTIVE">نشطة</option>
            <option value="COMPLETED">مكتملة</option>
            <option value="CANCELLED">ملغاة</option>
          </select>
        </div>
        <div className="min-w-64 flex-1 max-w-sm space-y-1">
          <Label className="text-xs">العميل</Label>
          <SmartCustomerInput
            value={customerFilter}
            onChange={(v) => { setCustomerFilter(v); setOffset(0); }}
            placeholder="فلترة بعميل معيّن…"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => list.refetch()} className="gap-1.5">
          <RotateCcw className="size-3.5" aria-hidden /> تحديث
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
          onPay={(l) => setPayTarget({ lineId: l.id, seq: l.seq, amount: l.amount, kind: l.kind, checkNumber: l.checkNumber })}
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

/* ============================ المستحقّ قريباً ============================ */

function DueSoonSection({ rows, isLoading, onPay }: { rows: DueRow[]; isLoading: boolean; onPay: (r: DueRow) => void }) {
  if (isLoading) return null;
  if (rows.length === 0) return null;
  const overdue = rows.filter((r) => r.daysOverdue > 0).length;
  return (
    <Card className="border-amber-300/60">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlarmClock className="size-4 text-amber-600" aria-hidden />
          المستحقّ قريباً ({rows.length} قسطاً{overdue > 0 ? ` — منها ${overdue} متأخّر` : ""})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
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
                        شيك {r.checkNumber ?? ""}{r.bankName ? ` — ${r.bankName}` : ""}
                      </span>
                    ) : (
                      "نقدي"
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Button size="sm" variant="outline" className="gap-1" onClick={() => onPay(r)}>
                      <CircleDollarSign className="size-3.5" aria-hidden /> سداد
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollTableShell>
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
          <p className="text-sm text-muted-foreground">أنشئ خطة لجدولة تحصيل ذمّة عميل بدفعات نقدية أو شيكات آجلة.</p>
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
                      <CheckCircle2 className={`size-3 ${p.paidLines === p.totalLines && p.totalLines > 0 ? "text-emerald-600" : "text-muted-foreground"}`} aria-hidden />
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
                    <Button size="sm" variant="ghost" onClick={() => onDetail(p.id)}>عرض</Button>
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
  kind: "CASH" | "CHECK";
  checkNumber: string;
  bankName: string;
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
  const [total, setTotal] = useState("");
  const [down, setDown] = useState("");
  const [count, setCount] = useState(3);
  const [firstDue, setFirstDue] = useState(addDays(todayYmd(), 30));
  const [intervalDays, setIntervalDays] = useState(30);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);

  const effectiveBranch = isAdmin ? (branchId ?? branches[0]?.id ?? null) : myBranchId;

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
    setTotal("");
    setDown("");
    setCount(3);
    setFirstDue(addDays(todayYmd(), 30));
    setIntervalDays(30);
    setNotes("");
    setLines([]);
  }

  /** توليد أسطر متساوية: الباقي بعد الدفعة الأولى ÷ العدد، والسطر الأخير يمتصّ فرق التقريب ⇒ Σ مطابق دائماً. */
  function generateLines() {
    const n = Math.max(1, Math.min(60, Math.floor(count)));
    const remaining = D(total).minus(D(down || "0"));
    if (remaining.lte(0)) {
      notify.err("الإجمالي بعد الدفعة الأولى يجب أن يكون موجباً");
      return;
    }
    const per = remaining.div(n).toDecimalPlaces(2, 1 /* ROUND_DOWN */);
    const last = remaining.minus(per.times(n - 1)).toDecimalPlaces(2);
    const next: DraftLine[] = [];
    for (let i = 0; i < n; i++) {
      next.push({
        dueDate: addDays(firstDue, i * Math.max(1, intervalDays)),
        amount: (i === n - 1 ? last : per).toFixed(2),
        kind: "CASH",
        checkNumber: "",
        bankName: "",
      });
    }
    setLines(next);
  }

  function updateLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  const linesSum = useMemo(() => lines.reduce((acc, l) => acc.plus(D(l.amount || "0")), D(0)), [lines]);
  const scheduled = linesSum.plus(D(down || "0"));
  const diff = D(total || "0").minus(scheduled);
  const sumMatches = total !== "" && lines.length > 0 && diff.isZero();
  const datesAscending = lines.every((l, i) => i === 0 || l.dueDate >= lines[i - 1].dueDate);
  const checksValid = lines.every((l) => l.kind !== "CHECK" || l.checkNumber.trim() !== "");
  const canSubmit =
    customer.customerId != null &&
    effectiveBranch != null &&
    sumMatches &&
    datesAscending &&
    checksValid &&
    lines.every((l) => l.dueDate && D(l.amount || "0").gt(0)) &&
    !create.isPending;

  function submit() {
    if (!canSubmit || customer.customerId == null || effectiveBranch == null) return;
    create.mutate({
      customerId: customer.customerId,
      branchId: effectiveBranch,
      totalAmount: D(total).toFixed(2),
      downPayment: down ? D(down).toFixed(2) : undefined,
      notes: notes.trim() || undefined,
      lines: lines.map((l) => ({
        dueDate: l.dueDate,
        amount: D(l.amount).toFixed(2),
        kind: l.kind,
        checkNumber: l.kind === "CHECK" ? l.checkNumber.trim() : undefined,
        bankName: l.bankName.trim() || undefined,
      })),
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
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
              <SmartCustomerInput value={customer} onChange={setCustomer} placeholder="ابحث عن عميل قائم…" />
              {customer.isNew && (
                <p className="text-xs text-destructive">اختر عميلاً قائماً — خطة الأقساط تتطلب عميلاً مسجَّلاً.</p>
              )}
            </div>
            {isAdmin && (
              <div className="space-y-1">
                <Label>الفرع *</Label>
                <select
                  value={String(effectiveBranch ?? "")}
                  onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : null)}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-1">
              <Label>إجمالي الخطة (د.ع) *</Label>
              <MoneyInput value={total} onChange={setTotal} ariaLabel="إجمالي الخطة" />
            </div>
            <div className="space-y-1">
              <Label>الدفعة الأولى (د.ع)</Label>
              <MoneyInput value={down} onChange={setDown} ariaLabel="الدفعة الأولى" />
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
              تُولَّد أسطر متساوية قابلة للتحرير سطراً-سطراً (تاريخ/مبلغ/نقدي أو شيك) — السطر الأخير يمتصّ فرق التقريب.
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
                      <TableHead className="text-center">النوع</TableHead>
                      <TableHead className="text-center">رقم الشيك</TableHead>
                      <TableHead className="text-center">المصرف</TableHead>
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
                        <TableCell>
                          <select
                            value={l.kind}
                            onChange={(e) => updateLine(i, { kind: e.target.value as DraftLine["kind"] })}
                            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                          >
                            <option value="CASH">نقدي</option>
                            <option value="CHECK">شيك آجل</option>
                          </select>
                        </TableCell>
                        <TableCell>
                          <Input
                            value={l.checkNumber}
                            onChange={(e) => updateLine(i, { checkNumber: e.target.value })}
                            disabled={l.kind !== "CHECK"}
                            placeholder={l.kind === "CHECK" ? "إلزامي" : "—"}
                            className="h-8 w-28"
                            dir="ltr"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={l.bankName}
                            onChange={(e) => updateLine(i, { bankName: e.target.value })}
                            disabled={l.kind !== "CHECK"}
                            placeholder={l.kind === "CHECK" ? "اسم المصرف" : "—"}
                            className="h-8 w-32"
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollTableShell>

              {/* تحقّق حيّ للمجموع */}
              <div
                className={`rounded-md border p-2 text-sm tabular-nums ${sumMatches ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-destructive/40 bg-destructive/5 text-destructive"}`}
                role="status"
              >
                مجموع الأقساط <span dir="ltr">{fmt(linesSum.toFixed(2))}</span> + الدفعة الأولى{" "}
                <span dir="ltr">{fmt(down || "0")}</span> = <span dir="ltr">{fmt(scheduled.toFixed(2))}</span>
                {sumMatches ? (
                  <span className="ms-2 font-semibold">يطابق الإجمالي</span>
                ) : (
                  <span className="ms-2 font-semibold">لا يطابق الإجمالي <span dir="ltr">{fmt(total || "0")}</span> — الفرق <span dir="ltr">{fmt(diff.toFixed(2))}</span></span>
                )}
              </div>
              {!datesAscending && <p className="text-xs text-destructive">تواريخ الأقساط يجب أن تكون متصاعدة.</p>}
              {!checksValid && <p className="text-xs text-destructive">كل قسط شيك يحتاج رقم شيك.</p>}
            </div>
          )}

          <div className="space-y-1">
            <Label>ملاحظات</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={1000} placeholder="اتفاق التقسيط، ضمانات، …" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {create.isPending ? "جارٍ الحفظ…" : "إنشاء الخطة"}
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
  onPay: (line: PlanLine) => void;
  onChanged: () => Promise<void> | void;
}) {
  const plan = trpc.installments.get.useQuery({ planId });
  const [bounceTarget, setBounceTarget] = useState<PlanLine | null>(null);
  const [bounceNote, setBounceNote] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const bounce = trpc.installments.bounce.useMutation({
    onSuccess: async (res) => {
      notify.ok(res.reversed ? "سُجِّل ارتجاع الشيك وعُكِس التحصيل (رُدَّ رصيد العميل)" : "سُجِّل ارتجاع الشيك");
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
                        {l.kind === "CHECK" ? `شيك ${l.checkNumber ?? ""}${l.bankName ? ` — ${l.bankName}` : ""}` : "نقدي"}
                      </TableCell>
                      <TableCell className="text-center"><StatusBadge map={LINE_STATUS_AR} value={l.status} /></TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {l.receiptId != null && <span className="tabular-nums">سند #{l.receiptId}</span>}
                        {l.receiptId != null && l.note ? " — " : ""}
                        {l.note ?? ""}
                      </TableCell>
                      <TableCell className="text-center whitespace-nowrap">
                        {p.status === "ACTIVE" && (l.status === "PENDING" || l.status === "BOUNCED") && (
                          <Button size="sm" variant="outline" className="me-1 gap-1" onClick={() => onPay(l)}>
                            <CircleDollarSign className="size-3.5" aria-hidden /> سداد
                          </Button>
                        )}
                        {p.status !== "CANCELLED" && l.kind === "CHECK" && (l.status === "PENDING" || l.status === "PAID") && (
                          <Button size="sm" variant="ghost" className="gap-1 text-destructive" onClick={() => setBounceTarget(l)}>
                            <Undo2 className="size-3.5" aria-hidden /> ارتجاع
                          </Button>
                        )}
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
                  onClick={() => setCancelOpen(true)}
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
              <DialogTitle>ارتجاع شيك — القسط رقم {bounceTarget?.seq}</DialogTitle>
              <DialogDescription>
                {bounceTarget?.status === "PAID"
                  ? "الشيك مُحصَّل — سيُصدَر إيصال صرف معاكس (خزينة) ويُستعاد رصيد العميل بمقدار القسط، ثم يُوسم «شيك مرتجع» قابلاً للسداد لاحقاً."
                  : "يُوسم القسط «شيك مرتجع» بلا أي حركة مالية (الشيك لم يُحصَّل أصلاً)، ويبقى قابلاً للسداد لاحقاً."}
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
                onClick={() => cancel.mutate({ planId, reason: cancelReason.trim() || undefined })}
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
  target: { lineId: number; seq: number; amount: string; kind: string; checkNumber: string | null };
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [method, setMethod] = useState<"CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET">(
    target.kind === "CHECK" ? "CHECK" : "CASH",
  );
  const [note, setNote] = useState("");
  const [attachment, setAttachment] = useState<ImageItem[]>([]);
  const thresholds = trpc.vouchers.thresholds.useQuery(undefined, { staleTime: 300_000 });

  const needsAttachment = thresholds.data != null && D(target.amount).gte(thresholds.data.attachment);
  const needsApproval = thresholds.data != null && D(target.amount).gte(thresholds.data.approval);

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

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="z-[100] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>سداد القسط رقم {target.seq}</DialogTitle>
          <DialogDescription>
            المبلغ <span dir="ltr" className="font-bold tabular-nums">{fmt(target.amount)}</span> د.ع — يُنشأ سند قبض حقيقي يُحرّك ذمّة العميل والدفتر.
            {target.kind === "CHECK" && target.checkNumber && <> (شيك رقم <span dir="ltr">{target.checkNumber}</span>)</>}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>طريقة الدفع</Label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="CASH">نقدي</option>
              <option value="CHECK">شيك (تحصيل الشيك)</option>
              <option value="TRANSFER">تحويل</option>
              <option value="CARD">بطاقة</option>
              <option value="WALLET">محفظة</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>ملاحظة</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} placeholder="اختياري" />
          </div>
          <div className="space-y-1">
            <Label>مُرفَق السند {needsAttachment ? "*" : "(اختياري)"}</Label>
            <ImageUploader
              value={attachment}
              onChange={setAttachment}
              maxItems={1}
              maxSizeMB={2}
              singlePrimary={false}
              hint="صورة وصل التحصيل / الشيك — تُضغط تلقائياً قبل الحفظ."
            />
            {needsAttachment && attachment.length === 0 && (
              <p className="text-xs text-destructive">المُرفق إلزامي لهذا المبلغ (سياسة السندات).</p>
            )}
          </div>
          {needsApproval && (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
              المبلغ يبلغ عتبة الاعتماد — سيُسجَّل السند بانتظار اعتماد مدير ثانٍ (Maker-Checker) ويبقى القسط معلَّقاً حتى الاعتماد.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button
            disabled={pay.isPending || (needsAttachment && attachment.length === 0)}
            onClick={() =>
              pay.mutate({
                lineId: target.lineId,
                paymentMethod: method,
                note: note.trim() || undefined,
                attachmentUrl: attachment[0]?.dataUrl || undefined,
              })
            }
          >
            {pay.isPending ? "جارٍ السداد…" : "تأكيد السداد"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
