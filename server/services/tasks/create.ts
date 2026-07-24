// إنشاء مهمة (NEW) — تذكرة موحّدة لأي طلب خدمة/دعم/استفسار بغضّ النظر عن قناة الورود.
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { serviceTypes, taskEvents, tasks } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import type { Tx } from "../../db";
import { withTx } from "../tx";
import { nextTaskNumber } from "./helpers";

export type TaskKind = "SERVICE_REQUEST" | "SUPPORT" | "INQUIRY" | "FOLLOW_UP" | "INTERNAL";
export type TaskPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type TaskSourceChannel = "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "STORE" | "PHONE" | "WALK_IN" | "OTHER";

export interface CreateTaskInput {
  branchId: number;
  kind?: TaskKind;
  title: string;
  description?: string | null;
  priority?: TaskPriority | null;
  customerId?: number | null;
  supplierId?: number | null;
  conversationId?: number | null;
  linkedWorkOrderId?: number | null;
  linkedInvoiceId?: number | null;
  linkedQuotationId?: number | null;
  serviceTypeId?: number | null;
  sourceChannel?: TaskSourceChannel | null;
  assignedTo?: number | null;
  /** YYYY-MM-DD أو ISO — اختياري. غيابه (undefined) مع serviceTypeId ⇒ يُشتَقّ من slaHours. */
  dueAt?: string | Date | null;
  /**
   * رسالة الحدث النظاميّ عند الإنشاء (افتراضياً «أُنشئت المهمة») — يسمح لـautoCreate.ts بتخصيصها
   * («أُنشئت تلقائياً من محادثة») بلا إدراج حدثٍ ثانٍ مكرِّر.
   */
  creationNote?: string;
}

/** actor.userId = null ⇒ إنشاء نظاميّ (autoCreate — لا فاعل بشريّ وراء الإنشاء). */
export type CreateTaskActor = { userId: number | null; branchId: number; role?: string };

/**
 * ينشئ مهمة داخل withTx (أو داخل tx المُمرَّرة — نمط enqueueOutbox: `tx ? run(tx) : withTx(run)`،
 * يتيح لـautoCreate.ts استدعاءها من نفس معاملته دون فتح معاملة متداخلة). يولّد taskNumber، يُدرج
 * الصفّ بحالة NEW، ويسجّل حدث SYSTEM للإنشاء (+ حدث ASSIGN إضافي إن مُرّر assignedTo عند الإنشاء).
 */
export async function createTask(input: CreateTaskInput, actor: CreateTaskActor, tx?: Tx) {
  const run = async (t: Tx) => {
    if (!input.title?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "عنوان المهمة مطلوب" });

    // اشتقاق priority/dueAt من نوع الخدمة فقط حين لا يُمرَّرا صراحةً (undefined — لا null، الذي
    // يُعامَل كتفضيلٍ صريح للافتراضي العام). القراءة داخل نفس المعاملة (اتّساق ذرّي).
    const needsPriority = input.priority === undefined;
    const needsDueAt = input.dueAt === undefined;
    let priority: TaskPriority | null = input.priority ?? null;
    let dueAt: Date | null = input.dueAt !== undefined ? (input.dueAt ? new Date(input.dueAt) : null) : null;

    if (input.serviceTypeId != null && (needsPriority || needsDueAt)) {
      const st = (
        await t.select().from(serviceTypes).where(eq(serviceTypes.id, input.serviceTypeId)).limit(1)
      )[0];
      if (st) {
        if (needsPriority) priority = st.defaultPriority as TaskPriority;
        if (needsDueAt) {
          dueAt = st.slaHours != null ? new Date(Date.now() + st.slaHours * 3600_000) : null;
        }
      }
    }

    const taskNumber = await nextTaskNumber(t, input.branchId);
    const insRes = await t.insert(tasks).values({
      taskNumber,
      branchId: input.branchId,
      taskKind: input.kind ?? "INQUIRY",
      taskStatus: "NEW",
      priority: priority ?? "NORMAL",
      title: input.title.trim(),
      description: input.description?.trim() || null,
      customerId: input.customerId ?? null,
      supplierId: input.supplierId ?? null,
      conversationId: input.conversationId ?? null,
      linkedWorkOrderId: input.linkedWorkOrderId ?? null,
      linkedInvoiceId: input.linkedInvoiceId ?? null,
      linkedQuotationId: input.linkedQuotationId ?? null,
      serviceTypeId: input.serviceTypeId ?? null,
      sourceChannel: input.sourceChannel ?? null,
      assignedTo: input.assignedTo ?? null,
      createdBy: actor.userId ?? null,
      dueAt: dueAt ?? null,
    });
    const taskId = extractInsertId(insRes);

    await t.insert(taskEvents).values({
      taskId,
      eventType: "SYSTEM",
      toStatus: "NEW",
      note: input.creationNote ?? "أُنشئت المهمة",
      userId: actor.userId ?? null,
    });

    if (input.assignedTo != null) {
      await t.insert(taskEvents).values({
        taskId,
        eventType: "ASSIGN",
        note: null,
        userId: actor.userId ?? null,
      });
    }

    return { taskId, taskNumber };
  };
  return tx ? run(tx) : withTx(run);
}
