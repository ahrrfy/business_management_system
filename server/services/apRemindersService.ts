// خدمة تذكيرات الذمم الدائنة (AP reminders) — مرآة arRemindersService.
//
// القرار السياسي (مرآة AR، المالك ٤/٧/٢٦):
//   • أوّل تذكير: بعد ٧ أيام من أقدم أمر شراء غير مسدَّد.
//   • حدّ أدنى للمبلغ: صفر (كل ذمّة دائنة > 0 مؤهّلة).
//   • جدولة: قائمة يومية، الموظف يراجع ويضغط «أرسل» يدوياً — لا cron.
//   • قناة: واتساب فقط (وا.me — بلا API خارجية) لتنسيق السداد/طلب كشف من المورد.
//   • منع تكرار: لا يظهر المورد في القائمة إن ذُكِّر في آخر ٧ أيام.
//
// الخدمة تعتمد getAPAging الموجودة (server/services/reports/apAging.ts) لحساب أعمار الذمم الدائنة
// وأقدم أمر شراء لكل مورد ⇒ لا نكرّر منطق التعمير. لا يمسّ الدفتر ولا الأموال — سجلّ فعلٍ يوميّ فقط.
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { apReminders, suppliers, purchaseOrders } from "../../drizzle/schema";
import { requireDb } from "./tx";
import { getAPAging } from "./reports/apAging";
import { money, toDbMoney } from "./money";

/** حدّ الأيام لأوّل تذكير (يوم من أقدم أمر شراء مستحقّ). قرار المالك (مرآة AR). */
export const REMINDER_MIN_DAYS_OVERDUE = 7;
/** نافذة منع التكرار (يوماً). لا يظهر المورد مجدداً إن ذُكِّر في آخر ٧ أيام. */
export const REMINDER_COOLDOWN_DAYS = 7;

/** صفّ في قائمة تذكيرات اليوم (queue) — كل مورد مؤهَّل مع سياقه الكامل للمراجعة والإرسال. */
export interface APReminderQueueRow {
  supplierId: number;
  supplierName: string;
  phone: string | null;
  /** المبلغ في التذكير = min(متبقّي أوامر الشراء المتأخّرة، الرصيد الدائن الجاري) بدقّة decimal.
   *  الذمم الحاكمة = suppliers.currentBalance (§٥): تسديد/استرداد مستقلّ قد يخفّضها دون مسّ
   *  purchaseOrders.paidAmount ⇒ متبقّي الأوامر وحده قد يطالب بأكثر من الذمّة الجارية. */
  totalUnpaid: string;
  oldestPoDate: string;
  daysOverdue: number;
  /** آخر تذكير أُرسِل لهذا المورد (nullable — لم يُذكَّر من قبل). للسياق البصري. */
  lastReminderAt: string | null;
  lastReminderStatus: "SENT" | "SKIPPED" | null;
  /** تاريخ وعدنا بالسداد المُسجَّل في آخر تخطٍّ (YYYY-MM-DD، nullable). وجودُه ⇒ الظهور اليوم بسبب
   *  استحقاق وعدٍ لا انتهاء تبريد ⇒ الواجهة تُبرز شارة «موعود». */
  promisedDate: string | null;
  /** `true` حين الظهور اليوم بسبب تجاوز تاريخ وعد السداد (promisedDate ≤ اليوم) — يتخطّى التبريد. */
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

/** «اليوم» بصيغة YYYY-MM-DD مرساةً على UTC (يطابق منطق getAPAging الذي يستعمل UTC_DATE()). */
function todayUTC(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** قائمة اليوم المؤهَّلة: موردون بذمّة دائنة >0 وأقدم أمر شراء متأخّر ≥٧ أيام، لم يُذكَّروا آخر ٧ أيام.
 *  branchId=null ⇒ تجميع كل الفروع (قراءة الأدمن المجمَّعة)؛ التبريد/الوعد يُقرآن عندئذٍ من آخر تذكير
 *  للمورد في أي فرع. مرآة getReminderQueue في arRemindersService. */
export async function getReminderQueue(opts: { branchId: number | null }): Promise<APReminderQueueRow[]> {
  const db = requireDb();
  const aging = await getAPAging(opts.branchId != null ? { branchId: opts.branchId } : {});
  const today = todayUTC();

  // الموردون المؤهَّلون قبل فحص التبريد: ذمّة دائنة فعلية >0 + oldestPoDate يعطي ≥٧ أيام تأخّر.
  // getAPAging قد تُرجع موردين رصيدهم فقط من OPENING (unbucketed، بلا أمر شراء) ⇒ نتجاهلهم.
  // الذمم الحاكمة = suppliers.currentBalance (§٥): المبلغ = min(unpaidTotal, currentBalance) —
  // لا نطالب بأكثر من الذمّة الجارية، ونستبعد كل مورد currentBalance ≤ 0 (سُدِّد أو مدين لنا).
  const eligible = aging
    .filter(
      (r) => money(r.unpaidTotal).gt(0) && money(r.currentBalance).gt(0) && r.oldestPoDate,
    )
    .map((r) => {
      const unpaid = money(r.unpaidTotal);
      const balance = money(r.currentBalance);
      return {
        row: r,
        dueAmount: toDbMoney(unpaid.lt(balance) ? unpaid : balance),
        daysOverdue: daysBetween(r.oldestPoDate!, today),
      };
    })
    .filter((x) => x.daysOverdue >= REMINDER_MIN_DAYS_OVERDUE);

  if (eligible.length === 0) return [];

  // آخر تذكير لكل مورد مع تاريخ الوعد — subquery بأحدث id لكل supplierId (id = AUTO_INCREMENT ⇒
  // ترتيب زمني موثوق أدقّ من MAX(createdAt) مع تعادل الثانية). استعلام واحد لا N+1.
  const supplierIds = eligible.map((x) => x.row.supplierId);
  const lastRows = await db
    .select({
      supplierId: apReminders.supplierId,
      lastAt: apReminders.createdAt,
      lastStatus: apReminders.status,
      lastPromisedDate: apReminders.promisedDate,
    })
    .from(apReminders)
    .where(
      and(
        sql`${apReminders.supplierId} IN (${sql.join(supplierIds.map((id) => sql`${id}`), sql`, `)})`,
        ...(opts.branchId != null ? [eq(apReminders.branchId, opts.branchId)] : []),
        opts.branchId != null
          ? sql`${apReminders.id} = (
              SELECT MAX(inner_r.id) FROM ${apReminders} AS inner_r
              WHERE inner_r.supplierId = ${apReminders.supplierId}
                AND inner_r.branchId = ${apReminders.branchId}
            )`
          : sql`${apReminders.id} = (
              SELECT MAX(inner_r.id) FROM ${apReminders} AS inner_r
              WHERE inner_r.supplierId = ${apReminders.supplierId}
            )`,
      ),
    );

  const lastBySupplier = new Map<
    number,
    { at: Date; status: "SENT" | "SKIPPED"; promisedDate: string | null }
  >();
  for (const r of lastRows) {
    lastBySupplier.set(Number(r.supplierId), {
      at: new Date(r.lastAt),
      status: r.lastStatus,
      promisedDate: r.lastPromisedDate ?? null,
    });
  }

  // فحص التبريد + استثناء وعد السداد المستحقّ اليوم (مرآة AR): وعد المستقبل يُستبعَد، وعد ≤ اليوم
  // يتخطّى التبريد ويُعاد إظهاره (متابعة سداد)، وإلّا يُستبعَد من ذُكِّر داخل نافذة التبريد.
  const nowMs = Date.now();
  const cooldownMs = REMINDER_COOLDOWN_DAYS * 86_400_000;
  const queue: APReminderQueueRow[] = [];
  for (const { row, dueAmount, daysOverdue } of eligible) {
    const last = lastBySupplier.get(row.supplierId);
    const isPromiseDue = !!(last && last.promisedDate && last.promisedDate <= today);
    const isFuturePromise = !!(last && last.promisedDate && last.promisedDate > today);
    if (isFuturePromise) continue;
    if (!isPromiseDue && last && nowMs - last.at.getTime() < cooldownMs) continue;
    queue.push({
      supplierId: row.supplierId,
      supplierName: row.supplierName,
      phone: row.phone,
      totalUnpaid: dueAmount,
      oldestPoDate: row.oldestPoDate!,
      daysOverdue,
      lastReminderAt: last ? last.at.toISOString() : null,
      lastReminderStatus: last ? last.status : null,
      promisedDate: last?.promisedDate ?? null,
      isPromiseDue,
    });
  }

  // ترتيب: (١) الوعود المستحقّة أوّلاً (متابعة سداد ⇒ أهمّ) ثم (٢) الأقدم تأخّراً.
  queue.sort((a, b) => {
    if (a.isPromiseDue !== b.isPromiseDue) return a.isPromiseDue ? -1 : 1;
    return b.daysOverdue - a.daysOverdue;
  });
  return queue;
}

/** مدخل تسجيل تذكير أُرسِل — تُستدعى بعد أن يضغط المستخدم «أرسل واتساب» ويؤكّد الإرسال. */
export interface LogReminderInput {
  supplierId: number;
  totalUnpaidSnapshot: string;
  oldestPoDate: string; // YYYY-MM-DD
  daysOverdue: number;
  messageBody: string;
}

/** حماية IDOR: المورد «يخصّ الفرع» إن كان له أمر شراء ملتزَم (CONFIRMED/RECEIVED) في هذا الفرع. */
async function assertSupplierHasBranchPO(supplierId: number, branchId: number): Promise<void> {
  const db = requireDb();
  const rows = await db
    .select({ id: purchaseOrders.id })
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.supplierId, supplierId),
        eq(purchaseOrders.branchId, branchId),
        inArray(purchaseOrders.status, ["CONFIRMED", "RECEIVED"]),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new TRPCError({ code: "NOT_FOUND", message: "لا أوامر شراء لهذا المورد في فرعك — لا يجوز تسجيل تذكير عنه." });
  }
}

/** تسجيل تذكير أُرسِل (status='SENT'). لا يمسّ الدفتر ولا الأموال ولا أوامر الشراء. */
export async function logReminderSent(
  input: LogReminderInput,
  actor: { userId: number; branchId: number },
): Promise<{ id: number }> {
  if (money(input.totalUnpaidSnapshot).lte(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الرصيد الدائن يجب أن يكون موجباً." });
  }
  if (input.daysOverdue < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "أيام التأخّر لا تصحّ أن تكون سالبة." });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.oldestPoDate)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ أقدم أمر شراء غير صالح." });
  }
  if (!input.messageBody.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "نص الرسالة فارغ." });
  }
  await assertSupplierHasBranchPO(input.supplierId, actor.branchId);

  const db = requireDb();
  const res = await db.insert(apReminders).values({
    supplierId: input.supplierId,
    branchId: actor.branchId,
    totalUnpaidSnapshot: money(input.totalUnpaidSnapshot).toFixed(2),
    oldestPoDate: input.oldestPoDate,
    daysOverdue: input.daysOverdue,
    messageBody: input.messageBody,
    status: "SENT",
    skipReason: null,
    createdBy: actor.userId,
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  return { id };
}

/** مدخل تسجيل تخطٍّ (قرار مؤقّت بعدم الإرسال — وعدنا بالسداد يوم كذا مثلاً). */
export interface SkipReminderInput {
  supplierId: number;
  totalUnpaidSnapshot: string;
  oldestPoDate: string;
  daysOverdue: number;
  skipReason: string;
  /** تاريخ وعدنا بالسداد الاختياري (YYYY-MM-DD، ≥ اليوم). إن مُلئ ⇒ المورد يعود لقائمة اليوم يوم الوعد
   *  متجاوزاً تبريد ٧ أيام. الترك فارغاً ⇒ تخطٍّ عاديّ (يخضع لتبريد ٧ أيام). */
  promisedDate?: string | null;
}

/** تسجيل تخطٍّ لتذكير مورد — يمنع ظهوره في القائمة اليومية بقية أيام التبريد. */
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.oldestPoDate)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ أقدم أمر شراء غير صالح." });
  }
  if (input.daysOverdue < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "أيام التأخّر لا تصحّ أن تكون سالبة." });
  }
  const promisedDate = input.promisedDate?.trim() || null;
  if (promisedDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(promisedDate)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ الوعد غير صالح." });
    }
    if (promisedDate < todayUTC()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ الوعد يجب ألّا يكون في الماضي." });
    }
  }
  await assertSupplierHasBranchPO(input.supplierId, actor.branchId);

  const db = requireDb();
  const res = await db.insert(apReminders).values({
    supplierId: input.supplierId,
    branchId: actor.branchId,
    totalUnpaidSnapshot: money(input.totalUnpaidSnapshot).toFixed(2),
    oldestPoDate: input.oldestPoDate,
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
export interface APReminderHistoryRow {
  id: number;
  supplierId: number;
  supplierName: string;
  totalUnpaidSnapshot: string;
  daysOverdue: number;
  status: "SENT" | "SKIPPED";
  skipReason: string | null;
  promisedDate: string | null;
  createdBy: number;
  createdAt: string;
}

/** سجلّ آخر ٣٠ يوماً من التذكيرات في الفرع (أو حدود مخصَّصة). للتدقيق والمتابعة.
 *  branchId=null ⇒ سجلّ كل الفروع (قراءة الأدمن المجمَّعة). */
export async function getReminderHistory(opts: {
  branchId: number | null;
  limit?: number;
}): Promise<APReminderHistoryRow[]> {
  const db = requireDb();
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

  const rows = await db
    .select({
      id: apReminders.id,
      supplierId: apReminders.supplierId,
      supplierName: suppliers.name,
      totalUnpaidSnapshot: apReminders.totalUnpaidSnapshot,
      daysOverdue: apReminders.daysOverdue,
      status: apReminders.status,
      skipReason: apReminders.skipReason,
      promisedDate: apReminders.promisedDate,
      createdBy: apReminders.createdBy,
      createdAt: apReminders.createdAt,
    })
    .from(apReminders)
    .innerJoin(suppliers, eq(suppliers.id, apReminders.supplierId))
    .where(
      and(
        ...(opts.branchId != null ? [eq(apReminders.branchId, opts.branchId)] : []),
        gte(apReminders.createdAt, thirtyDaysAgo),
      ),
    )
    // ترتيب ثابت حتى للتذكيرات في نفس الثانية (id فاصلٌ زمنيّاً مطابق لِـcreatedAt).
    .orderBy(desc(apReminders.createdAt), desc(apReminders.id))
    .limit(limit);

  return rows.map((r) => ({
    id: Number(r.id),
    supplierId: Number(r.supplierId),
    supplierName: r.supplierName,
    totalUnpaidSnapshot: r.totalUnpaidSnapshot,
    daysOverdue: r.daysOverdue,
    status: r.status,
    skipReason: r.skipReason,
    promisedDate: r.promisedDate ?? null,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  }));
}
