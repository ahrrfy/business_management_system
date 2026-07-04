/**
 * customerNoteService.ts — ملاحظات متابعة العملاء (مكالمة/وعد بالدفع/متابعة تسليم).
 *
 * سجلّ عملٍ يومي حرّ لا علاقة له بالدفتر المالي (لا قيد محاسبي، لا مبلغ). كل ملاحظة تنتمي
 * لعميل واحد، تحمل نصاً + تاريخ متابعة اختياري + حالة إنجاز، وتُنسب لفرع/مستخدم المُنشئ.
 * `dueToday` تجمع تذكيرات كل الفروع (لا عزل فرع هنا — المتابعة قرار مبيعات عابر للفروع).
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import { customerNotes, customers, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { extractInsertId } from "../lib/insertId";
import { withTx, type Actor } from "./tx";

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

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface CreateCustomerNoteInput {
  customerId: number;
  note: string;
  followUpDate?: string | null;
}

/** إنشاء ملاحظة متابعة جديدة — يتحقّق من وجود العميل أولاً. */
export async function createCustomerNote(input: CreateCustomerNoteInput, actor: Actor) {
  return withTx(async (tx) => {
    const customer = (
      await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1)
    )[0];
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });

    const note = normNote(input.note);
    const followUpDate = normFollowUpDate(input.followUpDate);

    const res = await tx.insert(customerNotes).values({
      customerId: input.customerId,
      note,
      followUpDate,
      isResolved: false,
      createdBy: actor.userId,
      branchId: actor.branchId,
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

/** قائمة ملاحظات عميل واحد — أحدث أولاً. */
export async function listCustomerNotes(input: ListCustomerNotesInput) {
  const db = getDb();
  if (!db) return [];
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);

  const conds = [eq(customerNotes.customerId, input.customerId)];
  if (!input.includeResolved) conds.push(eq(customerNotes.isResolved, false));

  const rows = await db
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
    .where(and(...conds))
    .orderBy(desc(customerNotes.id))
    .limit(limit);

  return rows;
}

/**
 * تذكيرات اليوم والمتأخرة — عبر كل العملاء/الفروع (رؤية إشرافية، مدير فأعلى فقط عبر الراوتر).
 * تُعيد الملاحظات غير المُنجَزة بتاريخ متابعة ≤ اليوم، الأقدم أولاً (الأكثر تأخّراً أولاً).
 */
export async function dueTodayCustomerNotes() {
  const db = getDb();
  if (!db) return [];
  const today = todayStr();

  const rows = await db
    .select({
      id: customerNotes.id,
      customerId: customerNotes.customerId,
      customerName: customers.name,
      note: customerNotes.note,
      followUpDate: customerNotes.followUpDate,
    })
    .from(customerNotes)
    .innerJoin(customers, eq(customerNotes.customerId, customers.id))
    .where(and(eq(customerNotes.isResolved, false), lte(customerNotes.followUpDate, today)))
    .orderBy(asc(customerNotes.followUpDate))
    .limit(200);

  return rows.map((r) => ({ ...r, customerName: r.customerName ?? "—" }));
}

export interface UpdateCustomerNoteInput {
  noteId: number;
  note?: string;
  followUpDate?: string | null;
}

/** تعديل نص/تاريخ متابعة ملاحظة قائمة. */
export async function updateCustomerNote(input: UpdateCustomerNoteInput, _actor: Actor) {
  return withTx(async (tx) => {
    const existing = (
      await tx.select().from(customerNotes).where(eq(customerNotes.id, input.noteId)).for("update").limit(1)
    )[0];
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "الملاحظة غير موجودة" });

    const patch: Record<string, unknown> = {};
    if (input.note !== undefined) patch.note = normNote(input.note);
    if (input.followUpDate !== undefined) patch.followUpDate = normFollowUpDate(input.followUpDate);

    if (Object.keys(patch).length === 0) return { id: input.noteId, changed: false };

    await tx.update(customerNotes).set(patch).where(eq(customerNotes.id, input.noteId));
    return { id: input.noteId, changed: true };
  });
}

/** تبديل حالة الإنجاز (فتح/إغلاق). */
export async function resolveCustomerNote(noteId: number, isResolved: boolean, _actor: Actor) {
  return withTx(async (tx) => {
    const existing = (
      await tx.select({ id: customerNotes.id }).from(customerNotes).where(eq(customerNotes.id, noteId)).for("update").limit(1)
    )[0];
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "الملاحظة غير موجودة" });

    await tx.update(customerNotes).set({ isResolved }).where(eq(customerNotes.id, noteId));
    return { id: noteId, isResolved };
  });
}

/** حذف نهائي لملاحظة (لا قيمة أرشيفية للاحتفاظ بها — على عكس العملاء/الموردين). */
export async function deleteCustomerNote(noteId: number, _actor: Actor) {
  return withTx(async (tx) => {
    const existing = (
      await tx.select({ id: customerNotes.id }).from(customerNotes).where(eq(customerNotes.id, noteId)).for("update").limit(1)
    )[0];
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "الملاحظة غير موجودة" });

    await tx.delete(customerNotes).where(eq(customerNotes.id, noteId));
    return { id: noteId };
  });
}
