// خدمة تذكيرات الذمم الآجلة (AR reminders) — مراجعة يدوية → إرسال واتساب يدوي.
//
// القرار السياسي (المالك، ٤/٧/٢٦):
//   • أوّل تذكير: بعد ٧ أيام من تجاوز dueDate (أو invoiceDate إن لم يكن هناك dueDate).
//   • حدّ أدنى للمبلغ: صفر (كل ذمّة > 0 مؤهّلة).
//   • جدولة: قائمة يومية، الموظف يراجع ويضغط «أرسل» يدوياً — لا cron.
//   • قناة: واتساب فقط (وا.me — بلا API خارجية).
//   • منع تكرار: لا يظهر عميل في القائمة إن أُرسِل له تذكير في آخر ٧ أيام.
//
// الخدمة تعتمد getARAging الموجودة (server/services/reports/arAging.ts) لحساب أعمار الذمم
// وأقدم فاتورة لكل عميل ⇒ لا نكرّر منطق التعمير.
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { arReminders, customers, invoices } from "../../drizzle/schema";
import { requireDb } from "./tx";
import { getARAging } from "./reports/arAging";
import { money } from "./money";

/** حدّ الأيام لأوّل تذكير (يوم من الاستحقاق). قرار المالك. */
export const REMINDER_MIN_DAYS_OVERDUE = 7;
/** نافذة منع التكرار (يوماً). لا يظهر العميل مجدداً إن ذُكِّر في آخر ٧ أيام. */
export const REMINDER_COOLDOWN_DAYS = 7;

/** صفّ في قائمة تذكيرات اليوم (queue) — كل عميل مؤهَّل مع سياقه الكامل للمراجعة والإرسال. */
export interface ReminderQueueRow {
  customerId: number;
  customerName: string;
  phone: string | null;
  totalUnpaid: string;
  oldestInvoiceDate: string;
  daysOverdue: number;
  /** آخر تذكير أُرسِل لهذا العميل (nullable — لم يُذكَّر من قبل). للسياق البصري. */
  lastReminderAt: string | null;
  /** حالة آخر تذكير (SENT/SKIPPED)، nullable إن لم يُذكَّر من قبل. */
  lastReminderStatus: "SENT" | "SKIPPED" | null;
  /**
   * تاريخ وعد الدفع المُسجَّل في آخر تخطٍّ (YYYY-MM-DD، nullable).
   * وجودُه ⇒ الظهور اليوم بسبب استحقاق وعدٍ لا بسبب انتهاء تبريد ⇒ الواجهة تُبرز شارة «موعود».
   */
  promisedDate: string | null;
  /**
   * `true` حين الظهور اليوم بسبب تجاوز تاريخ الوعد (promisedDate ≤ اليوم) — يتخطّى تبريد ٧ أيام.
   * يعطي الواجهة إشارة واضحة لترتيب هؤلاء أعلى القائمة (متابعة استحقاق وعد ⇒ أهمّ من عميل عادي).
   */
  isPromiseDue: boolean;
}

/** حساب أيام التأخّر بين تاريخين UTC نقيّاً (لا Date، لا مناطق زمنية). */
function daysBetween(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  const fromUTC = Date.UTC(fy, fm - 1, fd);
  const toUTC = Date.UTC(ty, tm - 1, td);
  return Math.floor((toUTC - fromUTC) / 86_400_000);
}

/** «اليوم» بصيغة YYYY-MM-DD مرساةً على UTC (يطابق منطق getARAging الذي يستعمل UTC_DATE()). */
function todayUTC(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** قائمة اليوم المؤهَّلة للتذكير: عملاء بذمّة >0 وأقدم فاتورة متأخّرة ≥٧ أيام، لم يُذكَّروا آخر ٧ أيام. */
export async function getReminderQueue(opts: { branchId: number }): Promise<ReminderQueueRow[]> {
  const db = requireDb();
  const aging = await getARAging({ branchId: opts.branchId });
  const today = todayUTC();

  // العملاء المؤهَّلون قبل فحص التبريد: unpaidTotal > 0 + oldestInvoiceDate يعطي ≥REMINDER_MIN_DAYS_OVERDUE
  // يوماً من التأخّر. `getARAging` قد تُرجع عملاء رصيدهم فقط من OPENING (unbucketed) ⇒ نتجاهلهم
  // (لا فاتورة فعلية للتذكير بها). النتيجة عبارة عن قائمة صغيرة عادةً (عشرات) فالتصفية في الذاكرة كافية.
  const eligible = aging
    .filter((r) => money(r.unpaidTotal).gt(0) && r.oldestInvoiceDate)
    .map((r) => ({
      row: r,
      daysOverdue: daysBetween(r.oldestInvoiceDate!, today),
    }))
    .filter((x) => x.daysOverdue >= REMINDER_MIN_DAYS_OVERDUE);

  if (eligible.length === 0) return [];

  // آخر تذكير لكل عميل مع تاريخ الوعد (لكل عميل، ONLY latest row) — استعلام subquery داخلي
  // بأحدث id لكل customerId (id = AUTO_INCREMENT ⇒ ترتيب زمني موثوق أدقّ من MAX(createdAt)
  // مع تعادل الثانية)، ثم JOIN لجلب `promisedDate` من نفس الصفّ. استعلام واحد لا N+1.
  const customerIds = eligible.map((x) => x.row.customerId);
  const lastRows = await db
    .select({
      customerId: arReminders.customerId,
      lastAt: arReminders.createdAt,
      lastStatus: arReminders.status,
      lastPromisedDate: arReminders.promisedDate,
    })
    .from(arReminders)
    .where(
      and(
        sql`${arReminders.customerId} IN (${sql.join(customerIds.map((id) => sql`${id}`), sql`, `)})`,
        eq(arReminders.branchId, opts.branchId),
        sql`${arReminders.id} = (
          SELECT MAX(inner_r.id) FROM ${arReminders} AS inner_r
          WHERE inner_r.customerId = ${arReminders.customerId}
            AND inner_r.branchId = ${arReminders.branchId}
        )`,
      ),
    );

  const lastByCustomer = new Map<
    number,
    { at: Date; status: "SENT" | "SKIPPED"; promisedDate: string | null }
  >();
  for (const r of lastRows) {
    lastByCustomer.set(Number(r.customerId), {
      at: new Date(r.lastAt),
      status: r.lastStatus,
      promisedDate: r.lastPromisedDate ?? null,
    });
  }

  // فحص التبريد + استثناء الوعد المستحقّ اليوم:
  //  - تبريد ٧ أيام يمنع إغراق العميل (يستبعد من القائمة).
  //  - إن كان تخطٍّ سابق بتاريخ وعد ≤ اليوم ⇒ نتخطّى التبريد ونُعيد إظهاره (استحقاق متابعة).
  //  - وعد المستقبل (promisedDate > اليوم) لا يظهر بعد — نحترم قرار الموظف بتأجيل المتابعة.
  const nowMs = Date.now();
  const cooldownMs = REMINDER_COOLDOWN_DAYS * 86_400_000;
  const queue: ReminderQueueRow[] = [];
  for (const { row, daysOverdue } of eligible) {
    const last = lastByCustomer.get(row.customerId);
    const isPromiseDue = !!(last && last.promisedDate && last.promisedDate <= today);
    const isFuturePromise = !!(last && last.promisedDate && last.promisedDate > today);
    // وعد المستقبل ⇒ استبعاد فوري (متابعة مؤجَّلة بقرار موظف).
    if (isFuturePromise) continue;
    // ليس وعداً مستحقّاً + في نافذة التبريد ⇒ استبعاد اعتيادي.
    if (!isPromiseDue && last && nowMs - last.at.getTime() < cooldownMs) continue;
    queue.push({
      customerId: row.customerId,
      customerName: row.customerName,
      phone: row.phone,
      totalUnpaid: row.unpaidTotal,
      oldestInvoiceDate: row.oldestInvoiceDate!,
      daysOverdue,
      lastReminderAt: last ? last.at.toISOString() : null,
      lastReminderStatus: last ? last.status : null,
      promisedDate: last?.promisedDate ?? null,
      isPromiseDue,
    });
  }

  // ترتيب: (١) الوعود المستحقّة أوّلاً (متابعة استحقاق وعد ⇒ أهمّ) ثم (٢) الأقدم تأخّراً.
  queue.sort((a, b) => {
    if (a.isPromiseDue !== b.isPromiseDue) return a.isPromiseDue ? -1 : 1;
    return b.daysOverdue - a.daysOverdue;
  });
  return queue;
}

/** مدخل تسجيل تذكير أُرسِل — تُستدعى بعد أن يضغط المستخدم «أرسل واتساب» ويؤكّد الإرسال. */
export interface LogReminderInput {
  customerId: number;
  totalUnpaidSnapshot: string;
  oldestInvoiceDate: string; // YYYY-MM-DD
  daysOverdue: number;
  messageBody: string;
}

/** حماية IDOR: العميل «يخصّ الفرع» إن كانت له فاتورة (مؤكَّدة/غير ملغاة) في هذا الفرع.
 *  (العملاء ليس لهم branchId — يشتركون عبر الفروع، والعزل يتمّ عبر الفواتير.) */
async function assertCustomerHasBranchInvoice(customerId: number, branchId: number): Promise<void> {
  const db = requireDb();
  const rows = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.customerId, customerId),
        eq(invoices.branchId, branchId),
        inArray(invoices.status, ["PENDING", "PARTIALLY_PAID", "PAID", "CONFIRMED"]),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new TRPCError({ code: "NOT_FOUND", message: "لا فواتير لهذا العميل في فرعك — لا يجوز تسجيل تذكير عنه." });
  }
}

/** تسجيل تذكير أُرسِل (status='SENT'). لا يمسّ الدفتر ولا الأموال ولا الفواتير. */
export async function logReminderSent(
  input: LogReminderInput,
  actor: { userId: number; branchId: number },
): Promise<{ id: number }> {
  if (money(input.totalUnpaidSnapshot).lte(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الرصيد الآجل يجب أن يكون موجباً." });
  }
  if (input.daysOverdue < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "أيام التأخّر لا تصحّ أن تكون سالبة." });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.oldestInvoiceDate)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ أقدم فاتورة غير صالح." });
  }
  if (!input.messageBody.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "نص الرسالة فارغ." });
  }
  await assertCustomerHasBranchInvoice(input.customerId, actor.branchId);

  const db = requireDb();
  const res = await db.insert(arReminders).values({
    customerId: input.customerId,
    branchId: actor.branchId,
    totalUnpaidSnapshot: money(input.totalUnpaidSnapshot).toFixed(2),
    oldestInvoiceDate: input.oldestInvoiceDate,
    daysOverdue: input.daysOverdue,
    messageBody: input.messageBody,
    status: "SENT",
    skipReason: null,
    createdBy: actor.userId,
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  return { id };
}

/** مدخل تسجيل تخطٍّ (المستخدم قرّر عدم إرسال — العميل وعد بالدفع مثلاً). */
export interface SkipReminderInput {
  customerId: number;
  totalUnpaidSnapshot: string;
  oldestInvoiceDate: string;
  daysOverdue: number;
  skipReason: string;
  /** تاريخ وعد الدفع الاختياري (YYYY-MM-DD، ≥ اليوم). إن مُلئ ⇒ العميل يعود لقائمة اليوم يوم الوعد
   *  متجاوزاً تبريد ٧ أيام. الترك فارغاً ⇒ تخطٍّ عاديّ (يخضع لتبريد ٧ أيام مثل باقي التذكيرات). */
  promisedDate?: string | null;
}

/** تسجيل تخطٍّ لتذكير عميل — يمنع ظهوره في القائمة اليومية بقية أيام التبريد. */
export async function logReminderSkipped(
  input: SkipReminderInput,
  actor: { userId: number; branchId: number },
): Promise<{ id: number }> {
  if (!input.skipReason.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سبب التخطّي مطلوب." });
  }
  if (input.skipReason.length > 255) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سبب التخطّي أطول من ٢٥٥ حرفاً." });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.oldestInvoiceDate)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ أقدم فاتورة غير صالح." });
  }
  if (input.daysOverdue < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "أيام التأخّر لا تصحّ أن تكون سالبة." });
  }
  const promisedDate = input.promisedDate?.trim() || null;
  if (promisedDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(promisedDate)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ الوعد غير صالح." });
    }
    // وعد في الماضي = لا معنى له (المتابعة يجب أن تكون مستقبلاً).
    if (promisedDate < todayUTC()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ الوعد يجب ألّا يكون في الماضي." });
    }
  }
  await assertCustomerHasBranchInvoice(input.customerId, actor.branchId);

  const db = requireDb();
  const res = await db.insert(arReminders).values({
    customerId: input.customerId,
    branchId: actor.branchId,
    totalUnpaidSnapshot: money(input.totalUnpaidSnapshot).toFixed(2),
    oldestInvoiceDate: input.oldestInvoiceDate,
    daysOverdue: input.daysOverdue,
    messageBody: "",
    status: "SKIPPED",
    skipReason: input.skipReason.trim(),
    promisedDate,
    createdBy: actor.userId,
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  return { id };
}

/** صفّ في سجلّ التذكيرات التاريخي — يظهر في تبويب السجلّ للمراجعة والتدقيق. */
export interface ReminderHistoryRow {
  id: number;
  customerId: number;
  customerName: string;
  totalUnpaidSnapshot: string;
  daysOverdue: number;
  status: "SENT" | "SKIPPED";
  skipReason: string | null;
  /** تاريخ الوعد المُسجَّل مع التخطّي (nullable — يظهر في السجلّ كسياق للمتابعة اللاحقة). */
  promisedDate: string | null;
  createdBy: number;
  createdAt: string;
}

/** سجلّ آخر ٣٠ يوماً من التذكيرات في الفرع (أو حدود مخصَّصة). للتدقيق والمتابعة. */
export async function getReminderHistory(opts: {
  branchId: number;
  limit?: number;
}): Promise<ReminderHistoryRow[]> {
  const db = requireDb();
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

  const rows = await db
    .select({
      id: arReminders.id,
      customerId: arReminders.customerId,
      customerName: customers.name,
      totalUnpaidSnapshot: arReminders.totalUnpaidSnapshot,
      daysOverdue: arReminders.daysOverdue,
      status: arReminders.status,
      skipReason: arReminders.skipReason,
      promisedDate: arReminders.promisedDate,
      createdBy: arReminders.createdBy,
      createdAt: arReminders.createdAt,
    })
    .from(arReminders)
    .innerJoin(customers, eq(customers.id, arReminders.customerId))
    .where(and(eq(arReminders.branchId, opts.branchId), gte(arReminders.createdAt, thirtyDaysAgo)))
    // ترتيب ثابت حتى للتذكيرات في نفس الثانية (TIMESTAMP دقّة ثانية على MySQL 5.7 الافتراضية):
    // id فاصلٌ زمنيّاً مطابق لِـcreatedAt (AUTO_INCREMENT) ⇒ الأحدث دائماً على القمّة.
    .orderBy(desc(arReminders.createdAt), desc(arReminders.id))
    .limit(limit);

  return rows.map((r) => ({
    id: Number(r.id),
    customerId: Number(r.customerId),
    customerName: r.customerName,
    totalUnpaidSnapshot: r.totalUnpaidSnapshot,
    daysOverdue: r.daysOverdue,
    status: r.status,
    skipReason: r.skipReason,
    promisedDate: r.promisedDate ?? null,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  }));
}
