// قراءة المهام: قائمة مُرقَّمة (keyset) + تفاصيل مهمة + قائمة الموظفين القابلين للإسناد.
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { customers, taskEvents, tasks, users } from "../../../drizzle/schema";
import { paginateKeyset } from "../../lib/paginateKeyset";
import { escLike } from "../../lib/sqlLike";
import { requireDb } from "../tx";

export type TaskStatus = "NEW" | "IN_PROGRESS" | "WAITING_CUSTOMER" | "RESOLVED" | "CANCELLED";
export type TaskKindFilter = "SERVICE_REQUEST" | "SUPPORT" | "INQUIRY" | "FOLLOW_UP" | "INTERNAL";

const CLOSED_STATUSES: readonly TaskStatus[] = ["RESOLVED", "CANCELLED"];

/** عزل القراءة — نفس شكل ctx المحقون عبر branchScopedProcedure (scopedBranchId/scopedOwnerId). */
export interface TaskListCtx {
  /** null = كل الفروع (مدير/أدمن)؛ رقم = فرض فرع الموظف. */
  scopedBranchId: number | null;
  /** null = كل السجلات ضمن النطاق (مدير/أدمن)؛ رقم = فرض (assignedTo=هو ∪ createdBy=هو). */
  scopedOwnerId: number | null;
}

export interface ListTasksFilters {
  status?: TaskStatus;
  kind?: TaskKindFilter;
  assignedTo?: number;
  /** فرع صريح — يُستشار فقط حين scopedBranchId=null (مدير/أدمن). */
  branchId?: number | null;
  overdue?: boolean;
  q?: string;
  cursor?: number;
  limit?: number;
}

/** يحسب موعد الاستحقاق الفعلي: dueAt + إجمالي زمن الانتظار (المتراكم + الجاري إن كانت الحالة WAITING الآن).
 *  لا يُخزَّن — يُحسب عند القراءة (list/get) فقط. */
export function computeEffectiveDueAt(task: {
  dueAt: Date | string | null;
  waitingAccumMs: number | string | null;
  waitingSince: Date | string | null;
  taskStatus: string;
}): Date | null {
  if (!task.dueAt) return null;
  const due = task.dueAt instanceof Date ? task.dueAt : new Date(task.dueAt);
  let accumMs = Number(task.waitingAccumMs ?? 0);
  if (task.taskStatus === "WAITING_CUSTOMER" && task.waitingSince) {
    const since = task.waitingSince instanceof Date ? task.waitingSince : new Date(task.waitingSince);
    accumMs += Math.max(0, Date.now() - since.getTime());
  }
  return new Date(due.getTime() + accumMs);
}

/** مهمة متأخّرة = لها استحقاق فعليّ تجاوزته الآن، وحالتها ليست مغلقة (RESOLVED/CANCELLED). */
export function isTaskOverdue(task: {
  dueAt: Date | string | null;
  waitingAccumMs: number | string | null;
  waitingSince: Date | string | null;
  taskStatus: string;
}): boolean {
  if ((CLOSED_STATUSES as readonly string[]).includes(task.taskStatus)) return false;
  const eff = computeEffectiveDueAt(task);
  return eff != null && eff.getTime() < Date.now();
}

const LIST_COLUMNS = {
  id: tasks.id,
  taskNumber: tasks.taskNumber,
  branchId: tasks.branchId,
  taskKind: tasks.taskKind,
  taskStatus: tasks.taskStatus,
  priority: tasks.priority,
  title: tasks.title,
  customerId: tasks.customerId,
  customerName: customers.name,
  assignedTo: tasks.assignedTo,
  assigneeName: users.name,
  createdBy: tasks.createdBy,
  conversationId: tasks.conversationId,
  dueAt: tasks.dueAt,
  waitingSince: tasks.waitingSince,
  waitingAccumMs: tasks.waitingAccumMs,
  resolvedAt: tasks.resolvedAt,
  createdAt: tasks.createdAt,
} as const;

/** شرط SQL خام لفلتر overdue=true — يطابق computeEffectiveDueAt/isTaskOverdue أعلاه بحساب MySQL-side. */
function overdueSqlCond(): SQL {
  return sql`${tasks.dueAt} IS NOT NULL AND DATE_ADD(${tasks.dueAt}, INTERVAL (${tasks.waitingAccumMs} * 1000 + IF(${tasks.waitingSince} IS NOT NULL, TIMESTAMPDIFF(MICROSECOND, ${tasks.waitingSince}, NOW()), 0)) MICROSECOND) < NOW() AND ${tasks.taskStatus} NOT IN ('RESOLVED','CANCELLED')`;
}

/** قائمة المهام — ترقيم keyset، عزل فرع/موظف، فلاتر حالة/نوع/إسناد/بحث/تأخّر. */
export async function listTasks(ctx: TaskListCtx, filters: ListTasksFilters = {}) {
  const db = requireDb();
  const conds: SQL[] = [];

  const effectiveBranchId = ctx.scopedBranchId ?? filters.branchId ?? null;
  if (effectiveBranchId != null) conds.push(eq(tasks.branchId, effectiveBranchId));

  if (ctx.scopedOwnerId != null) {
    conds.push(or(eq(tasks.assignedTo, ctx.scopedOwnerId), eq(tasks.createdBy, ctx.scopedOwnerId)) as SQL);
  }

  if (filters.status) conds.push(eq(tasks.taskStatus, filters.status));
  if (filters.kind) conds.push(eq(tasks.taskKind, filters.kind));
  if (filters.assignedTo != null) conds.push(eq(tasks.assignedTo, filters.assignedTo));
  if (filters.q?.trim()) {
    const pat = `%${escLike(filters.q.trim())}%`;
    conds.push(
      or(
        sql`${tasks.title} LIKE ${pat} ESCAPE '!'`,
        sql`${tasks.taskNumber} LIKE ${pat} ESCAPE '!'`,
      ) as SQL,
    );
  }
  if (filters.overdue) conds.push(overdueSqlCond());

  const page = await paginateKeyset({
    cursor: filters.cursor,
    limit: filters.limit,
    defaultLimit: 50,
    idCol: tasks.id,
    baseConds: conds,
    runQuery: (where, fetchLimit, fetchOffset) =>
      db
        .select(LIST_COLUMNS)
        .from(tasks)
        .leftJoin(customers, eq(tasks.customerId, customers.id))
        .leftJoin(users, eq(tasks.assignedTo, users.id))
        .where(where)
        .orderBy(desc(tasks.id))
        .limit(fetchLimit)
        .offset(fetchOffset),
  });

  return {
    ...page,
    rows: page.rows.map((r) => ({
      ...r,
      effectiveDueAt: computeEffectiveDueAt(r),
      isOverdue: isTaskOverdue(r),
    })),
  };
}

/** تفاصيل مهمة — الصفّ + الأحداث (زمنياً) + الروابط (linkedWorkOrderId/linkedInvoiceId/linkedQuotationId
 *  أعمدة مباشرة على الصفّ). عزل بفرع + نطاق موظف (نفس دلالة listTasks). */
export async function getTask(ctx: TaskListCtx, taskId: number) {
  const db = requireDb();
  const row = (
    await db
      .select({
        ...LIST_COLUMNS,
        description: tasks.description,
        supplierId: tasks.supplierId,
        linkedWorkOrderId: tasks.linkedWorkOrderId,
        linkedInvoiceId: tasks.linkedInvoiceId,
        linkedQuotationId: tasks.linkedQuotationId,
        serviceTypeId: tasks.serviceTypeId,
        sourceChannel: tasks.sourceChannel,
        firstResponseAt: tasks.firstResponseAt,
        resolutionNote: tasks.resolutionNote,
        reopenCount: tasks.reopenCount,
        csatScore: tasks.csatScore,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .leftJoin(customers, eq(tasks.customerId, customers.id))
      .leftJoin(users, eq(tasks.assignedTo, users.id))
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "المهمة غير موجودة" });
  if (ctx.scopedBranchId != null && Number(row.branchId) !== ctx.scopedBranchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "المهمة لا تخصّ فرعك" });
  }
  if (ctx.scopedOwnerId != null) {
    const isAssignee = row.assignedTo != null && Number(row.assignedTo) === ctx.scopedOwnerId;
    const isCreator = row.createdBy != null && Number(row.createdBy) === ctx.scopedOwnerId;
    if (!isAssignee && !isCreator) throw new TRPCError({ code: "FORBIDDEN", message: "هذه المهمة لا تخصّك" });
  }

  const events = await db
    .select({
      id: taskEvents.id,
      eventType: taskEvents.eventType,
      fromStatus: taskEvents.fromStatus,
      toStatus: taskEvents.toStatus,
      note: taskEvents.note,
      userId: taskEvents.userId,
      userName: users.name,
      createdAt: taskEvents.createdAt,
    })
    .from(taskEvents)
    .leftJoin(users, eq(taskEvents.userId, users.id))
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(asc(taskEvents.id));

  return { ...row, effectiveDueAt: computeEffectiveDueAt(row), isOverdue: isTaskOverdue(row), events };
}

/** الموظفون القابلون للإسناد في فرع مُعطى — نمط workOrders.assignableStaff، أدوار تنفيذ المهام. */
export async function assignableStaff(branchId: number) {
  const db = requireDb();
  return db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(
      and(
        eq(users.isActive, true),
        eq(users.branchId, branchId),
        inArray(users.role, ["cashier", "sales_rep", "print_operator", "warehouse", "manager"]),
      ),
    )
    .orderBy(asc(users.name));
}
