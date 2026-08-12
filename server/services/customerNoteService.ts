/**
 * customerNoteService.ts — ملاحظات متابعة العملاء (مكالمة/وعد بالدفع/متابعة تسليم).
 *
 * سجلّ عملٍ يومي حرّ لا علاقة له بالدفتر المالي (لا قيد محاسبي، لا مبلغ). كل ملاحظة تنتمي
 * لعميل واحد، تحمل نصاً + تاريخ متابعة اختياري + حالة إنجاز، وتُنسب لفرع/مستخدم المُنشئ.
 * `dueToday` تحترم نطاق المستخدم: المدير يرى فرعه، والمالك/الأدمن يريان الشركة كاملة.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { branches, customerNotes, customers, users } from "../../drizzle/schema";
import { extractInsertId } from "../lib/insertId";
import { baghdadToday, utcDayStart, utcNextDayStart } from "./businessDay";
import { companyBranchScope, type CompanyBranchScope } from "./companyBranchScope";
import { requireDb, withTx, type Actor } from "./tx";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX = 2000;

function normNote(note: string): string {
  const trimmed = note?.trim() ?? "";
  if (!trimmed) throw new TRPCError({ code: "BAD_REQUEST", message: "نص الملاحظة مطلوب" });
  if (trimmed.length > NOTE_MAX)
    throw new TRPCError({ code: "BAD_REQUEST", message: `نص الملاحظة طويل جداً (${NOTE_MAX} حرفاً كحد أقصى)` });
  return trimmed;
}

function normFollowUpDate(d: string | null | undefined): string | null {
  if (d == null || d === "") return null;
  if (!DATE_RE.test(d)) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ المتابعة غير صالح (الصيغة: YYYY-MM-DD)" });
  return d;
}

export interface CreateCustomerNoteInput {
  customerId: number;
  note: string;
  followUpDate?: string | null;
}

/** إنشاء ملاحظة متابعة جديدة — يتحقّق من وجود العميل أولاً. */
export async function createCustomerNote(input: CreateCustomerNoteInput, actor: Actor) {
  const authorityScope = companyBranchScope(actor);
  const targetBranchId = Number(actor.branchId);
  if (!Number.isInteger(targetBranchId) || targetBranchId <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد الفرع" });
  }
  if (authorityScope.branchId != null && authorityScope.branchId !== targetBranchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن الوصول إلى فرع آخر" });
  }
  return withTx(async (tx) => {
    const [branch] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.id, targetBranchId))
      .for("update")
      .limit(1);
    if (!branch) throw new TRPCError({ code: "BAD_REQUEST", message: "الفرع غير موجود" });
    const [creator] = await tx
      .select({ id: users.id, branchId: users.branchId })
      .from(users)
      .where(eq(users.id, actor.userId))
      .for("update")
      .limit(1);
    if (!creator) throw new TRPCError({ code: "FORBIDDEN", message: "المستخدم غير موجود" });
    if (authorityScope.branchId != null && Number(creator.branchId) !== targetBranchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "المستخدم غير مرتبط بهذا الفرع" });
    }
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .for("update")
      .limit(1);
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });

    const note = normNote(input.note);
    const followUpDate = normFollowUpDate(input.followUpDate);

    const res = await tx.insert(customerNotes).values({
      customerId: input.customerId,
      note,
      followUpDate,
      isResolved: false,
      createdBy: actor.userId,
      branchId: targetBranchId,
    });
    const id = extractInsertId(res);
    return { id, customerId: input.customerId };
  });
}

export interface ListCustomerNotesInput {
  customerId: number;
  includeResolved?: boolean;
  limit?: number;
}

export interface ListCustomerNotesPageInput extends ListCustomerNotesInput {
  offset?: number;
  q?: string;
  from?: string;
  to?: string;
}

function listCustomerNoteConditions(input: ListCustomerNotesPageInput, scope: CompanyBranchScope) {
  const conds = [eq(customerNotes.customerId, input.customerId)];
  if (scope.branchId != null) conds.push(eq(customerNotes.branchId, scope.branchId));
  if (!input.includeResolved) conds.push(eq(customerNotes.isResolved, false));
  const q = input.q?.trim();
  if (q) conds.push(sql<boolean>`LOCATE(${q}, ${customerNotes.note}) > 0`);
  if (input.from) conds.push(gte(customerNotes.createdAt, utcDayStart(input.from)));
  if (input.to) conds.push(lt(customerNotes.createdAt, utcNextDayStart(input.to)));
  return conds;
}

/** SQL-backed page; filters and total are evaluated before LIMIT/OFFSET. */
export async function listCustomerNotesPage(input: ListCustomerNotesPageInput, scope: CompanyBranchScope) {
  const db = requireDb();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);
  const where = and(...listCustomerNoteConditions(input, scope));
  const [rows, totals] = await Promise.all([
    db
      .select({
        id: customerNotes.id,
        customerId: customerNotes.customerId,
        note: customerNotes.note,
        followUpDate: customerNotes.followUpDate,
        isResolved: customerNotes.isResolved,
        createdBy: customerNotes.createdBy,
        createdByName: users.name,
        branchId: customerNotes.branchId,
        createdAt: customerNotes.createdAt,
        updatedAt: customerNotes.updatedAt,
      })
      .from(customerNotes)
      .leftJoin(users, eq(customerNotes.createdBy, users.id))
      .where(where)
      .orderBy(desc(customerNotes.id))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(customerNotes).where(where),
  ]);
  return { rows, total: Number(totals[0]?.total ?? 0) };
}

/** قائمة ملاحظات عميل واحد — أحدث أولاً. */
export async function listCustomerNotes(input: ListCustomerNotesInput, scope: CompanyBranchScope) {
  return (await listCustomerNotesPage(input, scope)).rows;
}

export interface DueTodayCustomerNotesPageInput {
  limit?: number;
  offset?: number;
  q?: string;
}

function dueTodayConditions(scope: CompanyBranchScope, today: string, q?: string) {
  const conds = [eq(customerNotes.isResolved, false), lte(customerNotes.followUpDate, today)];
  if (scope.branchId != null) conds.push(eq(customerNotes.branchId, scope.branchId));
  const query = q?.trim();
  if (query) conds.push(sql<boolean>`LOCATE(${query}, ${customerNotes.note}) > 0`);
  return conds;
}

function dueTodayRowsSelect() {
  return {
    id: customerNotes.id,
    customerId: customerNotes.customerId,
    customerName: customers.name,
    customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
    note: customerNotes.note,
    followUpDate: customerNotes.followUpDate,
    branchId: customerNotes.branchId,
    createdBy: customerNotes.createdBy,
  };
}

function normalizeDueTodayRows<T extends { customerName: string | null }>(rows: T[]) {
  return rows.map((row) => ({ ...row, customerName: row.customerName ?? "—" }));
}

/** Paginated CRM reminders contract. Baghdad civil date is the due-date boundary. */
export async function dueTodayCustomerNotesPage(
  input: DueTodayCustomerNotesPageInput,
  scope: CompanyBranchScope,
  now: Date = new Date(),
) {
  const db = requireDb();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  const where = and(...dueTodayConditions(scope, baghdadToday(now), input.q));
  const [rows, totals] = await Promise.all([
    db
      .select(dueTodayRowsSelect())
      .from(customerNotes)
      .innerJoin(customers, eq(customerNotes.customerId, customers.id))
      .where(where)
      .orderBy(asc(customerNotes.followUpDate), asc(customerNotes.id))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(customerNotes).where(where),
  ]);
  return { rows: normalizeDueTodayRows(rows), total: Number(totals[0]?.total ?? 0) };
}

/**
 * تذكيرات اليوم والمتأخرة — عبر العملاء ضمن نطاق الفرع، أو الشركة كاملة للأدمن/المالك.
 * تُعيد الملاحظات غير المُنجَزة بتاريخ متابعة ≤ اليوم، الأقدم أولاً (الأكثر تأخّراً أولاً).
 */
export async function dueTodayCustomerNotes(scope: CompanyBranchScope, now: Date = new Date()) {
  const db = requireDb();
  const today = baghdadToday(now);

  const rows = await db
    .select(dueTodayRowsSelect())
    .from(customerNotes)
    .innerJoin(customers, eq(customerNotes.customerId, customers.id))
    .where(and(...dueTodayConditions(scope, today)))
    .orderBy(asc(customerNotes.followUpDate), asc(customerNotes.id))
    .limit(200);

  return rows.map((r) => ({ ...r, customerName: r.customerName ?? "—" }));
}

export interface UpdateCustomerNoteInput {
  noteId: number;
  note?: string;
  followUpDate?: string | null;
}

/** تعديل نص/تاريخ متابعة ملاحظة قائمة. */
export async function updateCustomerNote(input: UpdateCustomerNoteInput, actor: Actor) {
  const scope = companyBranchScope(actor);
  return withTx(async (tx) => {
    const conds = [eq(customerNotes.id, input.noteId)];
    if (scope.branchId != null) conds.push(eq(customerNotes.branchId, scope.branchId));
    const existing = (
      await tx.select().from(customerNotes).where(and(...conds)).for("update").limit(1)
    )[0];
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "الملاحظة غير موجودة" });

    const patch: Record<string, unknown> = {};
    if (input.note !== undefined) patch.note = normNote(input.note);
    if (input.followUpDate !== undefined) patch.followUpDate = normFollowUpDate(input.followUpDate);

    if (Object.keys(patch).length === 0) return { id: input.noteId, changed: false };

    await tx.update(customerNotes).set(patch).where(and(...conds));
    return { id: input.noteId, changed: true };
  });
}

/** تبديل حالة الإنجاز (فتح/إغلاق). */
export async function resolveCustomerNote(noteId: number, isResolved: boolean, actor: Actor) {
  const scope = companyBranchScope(actor);
  return withTx(async (tx) => {
    const conds = [eq(customerNotes.id, noteId)];
    if (scope.branchId != null) conds.push(eq(customerNotes.branchId, scope.branchId));
    const existing = (
      await tx.select({ id: customerNotes.id }).from(customerNotes).where(and(...conds)).for("update").limit(1)
    )[0];
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "الملاحظة غير موجودة" });

    await tx.update(customerNotes).set({ isResolved }).where(and(...conds));
    return { id: noteId, isResolved };
  });
}

/** حذف نهائي لملاحظة (لا قيمة أرشيفية للاحتفاظ بها — على عكس العملاء/الموردين). */
export async function deleteCustomerNote(noteId: number, actor: Actor) {
  const scope = companyBranchScope(actor);
  return withTx(async (tx) => {
    const conds = [eq(customerNotes.id, noteId)];
    if (scope.branchId != null) conds.push(eq(customerNotes.branchId, scope.branchId));
    const existing = (
      await tx.select({ id: customerNotes.id }).from(customerNotes).where(and(...conds)).for("update").limit(1)
    )[0];
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "الملاحظة غير موجودة" });

    await tx.delete(customerNotes).where(and(...conds));
    return { id: noteId };
  });
}
