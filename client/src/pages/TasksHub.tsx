// نظام المهام الموحّد — واجهة T2.3 (S2 الأخيرة): تذكرة موحّدة لكل طلب خدمة/دعم/استفسار/متابعة
// بغضّ النظر عن قناة الورود (واتساب/إنستغرام/متجر/هاتف/حضوري) — الخادم جاهز بالكامل
// (server/routers/tasksRouter.ts + server/services/tasks/*)؛ هذا الملف يستهلكه فقط.
//
// ثلاثة تبويبات (نمط ARReminders.tsx — شريط أزرار يدوي + حالة داخلية، لا PageTabs لأنّ الثلاثة
// عروضٌ لنفس نطاق البيانات لا وحدات منفصلة):
//   لوحة (board)  — أعمدة كانبان حسب الحالة، بلا سحب-إفلات (نقلة الحالة من شاشة التفاصيل — YAGNI).
//   قائمة (list)  — DataTable بفلاتر + ترقيم keyset (hasMore/nextCursor) عبر useInfiniteQuery.
//   مهامي (mine)  — مهامي المفتوحة (assignedTo=أنا) مبسّطة.
//
// روابط عميقة من Dashboard.tsx: /tasks?tab=mine و/tasks?tab=list&overdue=1 — تُقرآن مرّة واحدة
// عند التركيب (نمط WorkOrderDetail.tsx لقراءة ?print=1)، ثم selectTab يحدّث الـURL (بديل نظيف).
import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import {
  AlertTriangle,
  LayoutGrid,
  ListFilter,
  Plus,
  User,
  UserRound,
} from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmtDateTime } from "@/lib/date";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Card, CardContent } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { ListToolbar } from "@/components/list";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import CustomerPicker from "@/components/CustomerPicker";
import { RowActions } from "@/components/list";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { buildOperationalContactMessage } from "@/lib/whatsapp";

export const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// أدوار الكتابة اليومية (claim/setWaiting/resume/resolve/addComment/create) — مرآة تامة لـ
// tasksWriteProcedure في server/trpc.ts. أدوار الإشراف (assign/reopen/cancel) — مرآة tasksManagerProcedure.
export const TASK_WRITE_ROLES = ["cashier", "manager", "sales_rep", "print_operator"] as const;
export const TASK_MANAGER_ROLES = ["manager"] as const;

export type TaskKind = "SERVICE_REQUEST" | "SUPPORT" | "INQUIRY" | "FOLLOW_UP" | "INTERNAL";
export type TaskPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type TaskStatus = "NEW" | "IN_PROGRESS" | "WAITING_CUSTOMER" | "RESOLVED" | "CANCELLED";
type TaskRow = RouterOutputs["tasks"]["list"]["rows"][number];

export const KIND_LABEL: Record<TaskKind, string> = {
  SERVICE_REQUEST: "طلب خدمة",
  SUPPORT: "دعم",
  INQUIRY: "استفسار",
  FOLLOW_UP: "متابعة",
  INTERNAL: "داخلية",
};

export const PRIORITY_META: Record<TaskPriority, { label: string; variant: "neutral" | "secondary" | "warning" | "danger" }> = {
  LOW: { label: "منخفضة", variant: "neutral" },
  NORMAL: { label: "عادية", variant: "secondary" },
  HIGH: { label: "عالية", variant: "warning" },
  URGENT: { label: "عاجلة", variant: "danger" },
};

export const STATUS_META: Record<TaskStatus, { label: string; variant: "info" | "warning" | "secondary" | "success" | "neutral" }> = {
  NEW: { label: "جديدة", variant: "info" },
  IN_PROGRESS: { label: "قيد التنفيذ", variant: "warning" },
  WAITING_CUSTOMER: { label: "بانتظار العميل", variant: "secondary" },
  RESOLVED: { label: "محلولة", variant: "success" },
  CANCELLED: { label: "ملغاة", variant: "neutral" },
};

const BOARD_STATUSES: TaskStatus[] = ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED"];

export function KindBadge({ kind }: { kind: string }) {
  return <Badge variant="outline">{KIND_LABEL[kind as TaskKind] ?? kind}</Badge>;
}
export function PriorityBadge({ priority }: { priority: string }) {
  const m = PRIORITY_META[priority as TaskPriority] ?? { label: priority, variant: "neutral" as const };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}
export function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status as TaskStatus] ?? { label: status, variant: "neutral" as const };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}
export function OverdueBadge() {
  return (
    <Badge variant="danger" className="gap-1">
      <AlertTriangle aria-hidden className="size-3" />
      متأخرة
    </Badge>
  );
}

/* ═══════════ لوحة (كانبان) ═══════════ */

function BoardCard({ task, onClick }: { task: TaskRow; onClick: () => void }) {
  const partyName = task.customerName ?? task.supplierName ?? null;
  const partyPhone = task.customerPhone ?? task.supplierPhone ?? null;
  const contactMessage = buildOperationalContactMessage({
    partyName,
    entityLabel: "المهمة",
    reference: task.taskNumber,
    title: task.title,
    status: STATUS_META[task.taskStatus as TaskStatus]?.label ?? task.taskStatus,
    dueAt: task.effectiveDueAt,
    nextAction: task.taskStatus === "WAITING_CUSTOMER" ? "نحتاج ردّكم للمتابعة وإكمال الطلب." : null,
  });
  return (
    <div className="rounded-lg border bg-card p-3 hover:border-primary/50 hover:shadow-sm transition-colors">
      <button type="button" onClick={onClick} className="w-full space-y-2 text-right">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-mono text-muted-foreground truncate" dir="ltr">{task.taskNumber}</span>
          {task.isOverdue && <OverdueBadge />}
        </div>
        <div className="text-sm font-semibold line-clamp-2">{task.title}</div>
        <div className="flex flex-wrap items-center gap-1.5">
          <KindBadge kind={task.taskKind} />
          <PriorityBadge priority={task.priority} />
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground pt-1.5 border-t">
          <span className="inline-flex items-center gap-1 truncate">
            <User aria-hidden className="size-3 shrink-0" />
            {task.assigneeName ?? "بلا إسناد"}
          </span>
          {partyName && <span className="truncate">{partyName}</span>}
        </div>
      </button>
      {task.taskKind !== "INTERNAL" && (
        <div className="mt-2 flex justify-end border-t pt-2" onClick={(event) => event.stopPropagation()}>
          <WhatsAppShare
            phone={partyPhone}
            message={contactMessage}
            label={`واتساب ${partyName ?? "الطرف"}`}
            size="icon-sm"
            iconOnly
          />
        </div>
      )}
    </div>
  );
}

function BoardColumn({ status, onOpen }: { status: TaskStatus; onOpen: (id: number) => void }) {
  const limit = status === "RESOLVED" ? 20 : 50;
  const q = trpc.tasks.list.useQuery({ status, limit });
  const meta = STATUS_META[status];
  const rows = q.data?.rows ?? [];
  // اقتطاع صامت: العمود يجلب صفحة أولى فقط (limit ثابت) بلا ترقيم — العدد المعروض قد يكون
  // العمود كاملاً لا الإجمالي الحقيقي. hasMore من paginateKeyset (server/lib/paginateKeyset.ts)
  // يكشف ذلك بدقّة؛ fallback على length===limit إن غاب الحقل لأيّ سبب (توافق عكسي).
  const truncated = q.data ? (q.data.hasMore ?? rows.length === limit) : false;
  return (
    <div className="flex flex-col gap-2 min-w-[270px] flex-1">
      <div className="flex items-center gap-2 px-1">
        <span className="text-sm font-bold">{meta.label}</span>
        <Badge
          variant="neutral"
          className="tabular-nums"
          title={truncated ? "قد توجد مهام إضافية غير معروضة هنا — افتح تبويب «قائمة» لعرضها كاملة." : undefined}
        >
          {q.isLoading ? "…" : truncated ? `${rows.length}+` : rows.length}
        </Badge>
      </div>
      <div className="flex flex-col gap-2 rounded-lg bg-muted/30 p-2 min-h-[140px]">
        {q.isLoading && <LoadingState className="p-6" />}
        {q.isError && <ErrorState message="تعذّر تحميل العمود." onRetry={() => q.refetch()} className="p-6" />}
        {!q.isLoading && !q.isError && rows.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">لا مهام</p>
        )}
        {rows.map((t) => (
          <BoardCard key={t.id} task={t} onClick={() => onOpen(Number(t.id))} />
        ))}
        {!q.isLoading && !q.isError && truncated && (
          <p className="text-xs text-muted-foreground text-center py-1.5 border-t">
            معروض أوّل {rows.length} فقط — قد توجد مهام إضافية، افتح تبويب «قائمة» لعرضها كاملة.
          </p>
        )}
      </div>
    </div>
  );
}

function BoardTab({ onOpen }: { onOpen: (id: number) => void }) {
  const [showCancelled, setShowCancelled] = useState(false);
  const statuses = showCancelled ? [...BOARD_STATUSES, "CANCELLED" as TaskStatus] : BOARD_STATUSES;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
          إظهار الملغاة
        </label>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {statuses.map((s) => (
          <BoardColumn key={s} status={s} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

/* ═══════════ جدول مشترك (قائمة/مهامي) ═══════════ */

function TaskTable({ rows, onOpen }: { rows: TaskRow[]; onOpen: (id: number) => void }) {
  return (
    <Card>
      <CardContent className="p-0">
        <ScrollTableShell bordered={false}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">الرقم</TableHead>
                <TableHead className="text-right">العنوان</TableHead>
                <TableHead className="text-center">النوع</TableHead>
                <TableHead className="text-center">الحالة</TableHead>
                <TableHead className="text-center">الأولوية</TableHead>
                <TableHead className="text-right">المسنَد إليه</TableHead>
                <TableHead className="text-right">الطرف</TableHead>
                <TableHead className="text-right">الهاتف</TableHead>
                <TableHead className="text-center">الاستحقاق الفعلي</TableHead>
                <TableHead className="text-center">متأخرة</TableHead>
                <TableHead className="text-center">إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">لا مهام.</TableCell>
                </TableRow>
              ) : (
                rows.map((t) => (
                  <TableRow key={t.id} className="cursor-pointer hover:bg-accent/40" onClick={() => onOpen(Number(t.id))}>
                    <TableCell className="font-mono text-xs" dir="ltr">{t.taskNumber}</TableCell>
                    <TableCell className="font-medium max-w-[280px] truncate">{t.title}</TableCell>
                    <TableCell className="text-center"><KindBadge kind={t.taskKind} /></TableCell>
                    <TableCell className="text-center"><StatusBadge status={t.taskStatus} /></TableCell>
                    <TableCell className="text-center"><PriorityBadge priority={t.priority} /></TableCell>
                    <TableCell className="whitespace-nowrap">{t.assigneeName ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">{t.customerName ?? t.supplierName ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground" dir="ltr">{t.customerPhone ?? t.supplierPhone ?? "—"}</TableCell>
                    <TableCell className="text-center text-xs text-muted-foreground whitespace-nowrap">
                      {t.effectiveDueAt ? fmtDateTime(t.effectiveDueAt) : "—"}
                    </TableCell>
                    <TableCell className="text-center">{t.isOverdue ? <OverdueBadge /> : "—"}</TableCell>
                    <TableCell className="text-center" onClick={(event) => event.stopPropagation()}>
                      <RowActions
                        mode="menu"
                        actions={[{
                          key: "view",
                          kind: "view",
                          label: "فتح المهمة",
                          onSelect: () => onOpen(Number(t.id)),
                          gate: { module: "tasks", level: "READ" },
                        }]}
                        contact={t.taskKind === "INTERNAL" ? undefined : {
                          phone: t.customerPhone ?? t.supplierPhone,
                          label: `واتساب ${t.customerName ?? t.supplierName ?? "الطرف"}`,
                          message: buildOperationalContactMessage({
                            partyName: t.customerName ?? t.supplierName,
                            entityLabel: "المهمة",
                            reference: t.taskNumber,
                            title: t.title,
                            status: STATUS_META[t.taskStatus as TaskStatus]?.label ?? t.taskStatus,
                            dueAt: t.effectiveDueAt,
                            nextAction: t.taskStatus === "WAITING_CUSTOMER" ? "نحتاج ردّكم للمتابعة وإكمال الطلب." : null,
                          }),
                          gate: { module: "tasks", level: "READ" },
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </ScrollTableShell>
      </CardContent>
    </Card>
  );
}

/* ═══════════ قائمة (فلاتر + ترقيم keyset) ═══════════ */

function ListTab({
  isElevated,
  branches,
  onOpen,
}: {
  isElevated: boolean;
  branches: { id: number; name: string }[];
  onOpen: (id: number) => void;
}) {
  const utils = trpc.useUtils();
  // فلاتر محفوظة في querystring (تعيش مع فتح التفاصيل والرجوع، وتُشارَك رابطاً) — نمط Invoices.tsx.
  // «overdue» يُقرأ ابتداءً من رابط Dashboard العميق /tasks?tab=list&overdue=1 تلقائياً (useUrlFilters
  // تقرأ الـURL الحالي عند التركيب) بلا حاجة لقراءة يدوية منفصلة كما كان سابقاً.
  const [f, setF, resetF] = useUrlFilters({
    status: "", kind: "", priority: "", assignedTo: "", branchId: "",
    overdue: "", from: "", to: "", q: "",
  });
  const [qDebounced, setQDebounced] = useState(f.q);
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(f.q), 300);
    return () => clearTimeout(t);
  }, [f.q]);

  const staff = trpc.tasks.assignableStaff.useQuery({ branchId: f.branchId ? Number(f.branchId) : undefined });

  // مدخلات الفلترة المشتركة (بلا cursor/limit) — للقائمة والتصدير الشامل معاً (نفس المجموعة حتماً).
  const filterInput = useMemo(
    () => ({
      status: (f.status || undefined) as TaskStatus | undefined,
      kind: (f.kind || undefined) as TaskKind | undefined,
      priority: (f.priority || undefined) as TaskPriority | undefined,
      assignedTo: f.assignedTo ? Number(f.assignedTo) : undefined,
      branchId: f.branchId ? Number(f.branchId) : undefined,
      overdue: f.overdue === "1" || undefined,
      from: f.from || undefined,
      to: f.to || undefined,
      q: qDebounced.trim() || undefined,
    }),
    [f.status, f.kind, f.priority, f.assignedTo, f.branchId, f.overdue, f.from, f.to, qDebounced],
  );

  const list = trpc.tasks.list.useInfiniteQuery(
    { ...filterInput, limit: 50 },
    { getNextPageParam: (last) => last.nextCursor },
  );
  const rows = useMemo(() => (list.data?.pages ?? []).flatMap((p) => p.rows), [list.data]);

  // عدّاد الفلاتر المفعّلة (بلا حقل البحث — اتفاقية ListToolbar) لزرّ «مسح الفلاتر».
  const activeFilterCount = [
    f.status, f.kind, f.priority, f.assignedTo, isElevated ? f.branchId : "", f.overdue, f.from || f.to,
  ].filter(Boolean).length;

  // تصدير «الكل»: القائمة مُرقَّمة keyset (صفحات ٥٠) ⇒ نمشي بالمؤشّر حتى نضب الصفحات، بنفس فلاتر
  // القائمة الحالية (نمط fetchAllPaged لكن بمؤشّر id لا offset — عقد tasks.list).
  async function fetchAllTasks(): Promise<TaskRow[]> {
    const out: TaskRow[] = [];
    let cursor: number | undefined;
    for (let i = 0; i < 400; i++) { // صمّام أمان: حتى ٨٠ ألف مهمّة
      const page = await utils.tasks.list.fetch({ ...filterInput, cursor, limit: 200 });
      out.push(...page.rows);
      if (!page.hasMore || page.nextCursor == null) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  return (
    <div className="space-y-3">
      <ListToolbar
        title="قائمة المهام"
        count={rows.length}
        loading={list.isLoading}
        search={{ value: f.q, onChange: (v) => setF({ q: v }), placeholder: "ابحث بالعنوان أو الرقم…" }}
        activeFilterCount={activeFilterCount}
        onResetFilters={resetF}
        onRefresh={() => void list.refetch()}
        refreshing={list.isFetching}
        exportSpec={{
          filename: "المهام",
          sheetName: "المهام",
          rows,
          formats: ["xlsx", "csv"],
          fetchAll: fetchAllTasks,
          columns: [
            { key: "taskNumber", header: "الرقم" },
            { key: "title", header: "العنوان" },
            { key: "taskKind", header: "النوع", map: (r) => KIND_LABEL[r.taskKind as TaskKind] ?? r.taskKind },
            { key: "taskStatus", header: "الحالة", map: (r) => STATUS_META[r.taskStatus as TaskStatus]?.label ?? r.taskStatus },
            { key: "priority", header: "الأولوية", map: (r) => PRIORITY_META[r.priority as TaskPriority]?.label ?? r.priority },
            { key: "assigneeName", header: "المسنَد إليه", map: (r) => r.assigneeName ?? "" },
            { key: "customerName", header: "العميل", map: (r) => r.customerName ?? "" },
            { key: "effectiveDueAt", header: "الاستحقاق الفعلي", map: (r) => (r.effectiveDueAt ? fmtDateTime(r.effectiveDueAt) : "") },
            { key: "isOverdue", header: "متأخرة", map: (r) => (r.isOverdue ? "نعم" : "لا") },
          ],
        }}
        filters={
          <>
            <AppSelect value={f.status} onValueChange={(v) => setF({ status: v })} className="h-9 w-auto min-w-[9rem]" aria-label="فلتر الحالة">
              <option value="">كل الحالات</option>
              {Object.entries(STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </AppSelect>
            <AppSelect value={f.kind} onValueChange={(v) => setF({ kind: v })} className="h-9 w-auto min-w-[9rem]" aria-label="فلتر النوع">
              <option value="">كل الأنواع</option>
              {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </AppSelect>
            <AppSelect value={f.priority} onValueChange={(v) => setF({ priority: v })} className="h-9 w-auto min-w-[9rem]" aria-label="فلتر الأولوية">
              <option value="">كل الأولويات</option>
              {Object.entries(PRIORITY_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </AppSelect>
            <AppSelect value={f.assignedTo} onValueChange={(v) => setF({ assignedTo: v })} className="h-9 w-auto min-w-[11rem]" aria-label="فلتر المسنَد إليه">
              <option value="">كل المسنَد إليهم</option>
              {(staff.data ?? []).map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
            </AppSelect>
            {isElevated && (
              <AppSelect value={f.branchId} onValueChange={(v) => setF({ branchId: v })} className="h-9 w-auto min-w-[9rem]" aria-label="فلتر الفرع">
                <option value="">كل الفروع</option>
                {branches.map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
              </AppSelect>
            )}
            <label className="inline-flex h-9 items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={f.overdue === "1"} onChange={(e) => setF({ overdue: e.target.checked ? "1" : "" })} />
              متأخرة فقط
            </label>
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">من</span>
              <Input
                type="date"
                value={f.from}
                onChange={(e) => setF({ from: e.target.value })}
                className="h-9 w-[9.5rem]"
                aria-label="من تاريخ الإنشاء"
                max={f.to || undefined}
              />
              <span className="text-xs text-muted-foreground">إلى</span>
              <Input
                type="date"
                value={f.to}
                onChange={(e) => setF({ to: e.target.value })}
                className="h-9 w-[9.5rem]"
                aria-label="إلى تاريخ الإنشاء"
                min={f.from || undefined}
              />
            </div>
          </>
        }
      />

      {list.isLoading && <LoadingState />}
      {list.isError && <ErrorState message="تعذّر تحميل المهام." onRetry={() => list.refetch()} />}
      {!list.isLoading && !list.isError && (
        <>
          <TaskTable rows={rows} onOpen={onOpen} />
          {list.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                {list.isFetchingNextPage ? "جارٍ التحميل…" : "تحميل المزيد"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ═══════════ مهامي (مبسّطة) ═══════════ */

function MineTab({ myId, onOpen }: { myId: number | undefined; onOpen: (id: number) => void }) {
  // «المفتوحة» = ليست RESOLVED/CANCELLED — الفلتر يقبل قيمة status واحدة فقط ⇒ ٣ استعلامات
  // متوازية (نمط أخفّ من list الكامل، ومطابق لتعليمات التكليف: «نفس عرض القائمة مبسطاً»).
  const qNew = trpc.tasks.list.useQuery({ assignedTo: myId, status: "NEW", limit: 50 }, { enabled: myId != null });
  const qProg = trpc.tasks.list.useQuery({ assignedTo: myId, status: "IN_PROGRESS", limit: 50 }, { enabled: myId != null });
  const qWait = trpc.tasks.list.useQuery({ assignedTo: myId, status: "WAITING_CUSTOMER", limit: 50 }, { enabled: myId != null });
  const isLoading = myId == null || qNew.isLoading || qProg.isLoading || qWait.isLoading;
  const isError = qNew.isError || qProg.isError || qWait.isError;
  const rows = useMemo(() => {
    const all = [...(qNew.data?.rows ?? []), ...(qProg.data?.rows ?? []), ...(qWait.data?.rows ?? [])];
    return all.sort((a, b) => Number(b.id) - Number(a.id));
  }, [qNew.data, qProg.data, qWait.data]);

  if (isLoading) return <LoadingState />;
  if (isError) {
    return (
      <ErrorState
        message="تعذّر تحميل مهامي."
        onRetry={() => { qNew.refetch(); qProg.refetch(); qWait.refetch(); }}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <UserRound className="size-10 text-muted-foreground" aria-hidden />
          <p className="text-lg font-semibold">لا مهام مفتوحة مُسنَدة إليك</p>
          <p className="text-sm text-muted-foreground">اسحب مهمة جديدة من تبويب «لوحة» أو «قائمة» لتبدأ العمل عليها.</p>
        </CardContent>
      </Card>
    );
  }
  return <TaskTable rows={rows} onOpen={onOpen} />;
}

/* ═══════════ مهمة جديدة ═══════════ */

function NewTaskDialog({
  isElevated,
  myBranchId,
  branches,
  onClose,
  onCreated,
}: {
  isElevated: boolean;
  myBranchId: number | null;
  branches: { id: number; name: string }[];
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const [branchId, setBranchId] = useState<string>(myBranchId != null ? String(myBranchId) : "");
  const [kind, setKind] = useState<TaskKind>("INQUIRY");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("NORMAL");
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [serviceTypeId, setServiceTypeId] = useState<string>("");

  // منتقي نوع الخدمة (S4/T4.1 — serviceTypes.list): اختيار نوع خدمة يُطبِّق نوعه/أولويته
  // الافتراضيَين تلقائياً (المستخدم قد يُعدّلهما لاحقاً يدوياً) — SLA الفعلي يُشتقّ خادمياً من
  // serviceTypeId المُرسَل، لا من هذين الحقلين المحليَّين.
  const serviceTypesQ = trpc.tasks.serviceTypes.list.useQuery();

  const create = trpc.tasks.create.useMutation({
    onSuccess: (r) => { notify.ok(`أُنشئت المهمة ${r.taskNumber}`); onCreated(r.taskId); },
    onError: (e) => notify.err(e),
  });

  function selectServiceType(id: string) {
    setServiceTypeId(id);
    const st = (serviceTypesQ.data ?? []).find((s) => String(s.id) === id);
    if (st) {
      setKind(st.defaultKind as TaskKind);
      setPriority(st.defaultPriority as TaskPriority);
    }
  }

  function submit() {
    if (!title.trim()) { notify.err("عنوان المهمة مطلوب"); return; }
    if (!branchId) { notify.err("اختر الفرع"); return; }
    create.mutate({
      branchId: Number(branchId),
      kind,
      title: title.trim(),
      description: description.trim() || null,
      priority,
      customerId,
      serviceTypeId: serviceTypeId ? Number(serviceTypeId) : null,
    });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>مهمة جديدة</DialogTitle>
          <DialogDescription>تذكرة موحّدة لطلب خدمة/دعم/استفسار/متابعة — تظهر فوراً في اللوحة والقائمة.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {isElevated && (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">الفرع<span className="text-destructive"> *</span></label>
              <select className={`${selectCls} w-full`} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">اختر الفرع</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">نوع الخدمة (اختياري)</label>
            <select className={`${selectCls} w-full`} value={serviceTypeId} onChange={(e) => selectServiceType(e.target.value)}>
              <option value="">بلا نوع خدمة محدَّد</option>
              {(serviceTypesQ.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.slaHours != null ? ` — SLA ${s.slaHours}س` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">النوع</label>
              <select className={`${selectCls} w-full`} value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
                {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">الأولوية</label>
              <select className={`${selectCls} w-full`} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
                {Object.entries(PRIORITY_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">العنوان<span className="text-destructive"> *</span></label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثال: طلب طباعة بطاقات دعوة" maxLength={200} autoFocus />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">الوصف (اختياري)</label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={4000} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">العميل (اختياري)</label>
            <CustomerPicker customerId={customerId} onCustomerChange={setCustomerId} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={submit} disabled={create.isPending || !title.trim() || !branchId}>
            {create.isPending ? "جارٍ…" : "إنشاء"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ═══════════ الصفحة ═══════════ */

export default function TasksHub() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const me = trpc.auth.me.useQuery();
  const role = (me.data?.role ?? "") as RoleKey;
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const isElevated = role === "admin" || role === "manager";
  const canWrite = !!role && moduleAccessAllowed(role, override, "tasks", "FULL", TASK_WRITE_ROLES);
  const myId = me.data?.id != null ? Number(me.data.id) : undefined;
  const myBranchId = me.data?.branchId != null ? Number(me.data.branchId) : null;

  const [initialTab] = useState<"board" | "list" | "mine">(() => {
    const t = new URLSearchParams(search).get("tab");
    return t === "list" || t === "mine" ? t : "board";
  });
  const [tab, setTab] = useState<"board" | "list" | "mine">(initialTab);
  function selectTab(t: "board" | "list" | "mine") {
    setTab(t);
    navigate(t === "board" ? "/tasks" : `/tasks?tab=${t}`, { replace: true });
  }
  function openTask(id: number) {
    navigate(`/tasks/${id}`);
  }

  const branches = trpc.branches.list.useQuery();
  const [showNew, setShowNew] = useState(false);

  const tabBtn = (v: typeof tab) =>
    v === tab
      ? "px-4 py-1.5 text-sm font-bold rounded-md bg-background shadow-sm inline-flex items-center gap-1.5"
      : "px-4 py-1.5 text-sm text-muted-foreground inline-flex items-center gap-1.5";

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="المهام والتذاكر"
        description="تذكرة موحّدة لكل طلب خدمة أو دعم أو استفسار — بغضّ النظر عن قناة الورود (واتساب/هاتف/حضوري)."
        actions={
          canWrite ? (
            <Button size="sm" onClick={() => setShowNew(true)}>
              <Plus aria-hidden className="size-4 me-1" /> مهمة جديدة
            </Button>
          ) : undefined
        }
      />

      <div className="flex gap-1 rounded-lg border p-1 bg-muted/30 w-fit">
        <button type="button" onClick={() => selectTab("board")} className={tabBtn("board")}>
          <LayoutGrid className="size-3.5" aria-hidden /> لوحة
        </button>
        <button type="button" onClick={() => selectTab("list")} className={tabBtn("list")}>
          <ListFilter className="size-3.5" aria-hidden /> قائمة
        </button>
        <button type="button" onClick={() => selectTab("mine")} className={tabBtn("mine")}>
          <User className="size-3.5" aria-hidden /> مهامي
        </button>
      </div>

      {tab === "board" && <BoardTab onOpen={openTask} />}
      {tab === "list" && <ListTab isElevated={isElevated} branches={branches.data ?? []} onOpen={openTask} />}
      {tab === "mine" && <MineTab myId={myId} onOpen={openTask} />}

      {showNew && (
        <NewTaskDialog
          isElevated={isElevated}
          myBranchId={myBranchId}
          branches={branches.data ?? []}
          onClose={() => setShowNew(false)}
          onCreated={(id) => { setShowNew(false); navigate(`/tasks/${id}`); }}
        />
      )}
    </div>
  );
}
