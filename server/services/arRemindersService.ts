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
import { accountingEntries, arReminders, customers, invoices } from "../../drizzle/schema";
import { requireDb } from "./tx";
import { getARAging } from "./reports/arAging";
import { money, toDbMoney } from "./money";
import { flowNotify } from "./whatsapp";

/** حدّ الأيام لأوّل تذكير (يوم من الاستحقاق). قرار المالك. */
export const REMINDER_MIN_DAYS_OVERDUE = 7;
/** نافذة منع التكرار (يوماً). لا يظهر العميل مجدداً إن ذُكِّر في آخر ٧ أيام. */
export const REMINDER_COOLDOWN_DAYS = 7;

/** صفّ في قائمة تذكيرات اليوم (queue) — كل عميل مؤهَّل مع سياقه الكامل للمراجعة والإرسال. */
export interface ReminderQueueRow {
  customerId: number;
  customerName: string;
  phone: string | null;
  /** المبلغ المُطالَب به في التذكير = min(متبقّي الفواتير المتأخّرة، الرصيد الجاري) بدقّة decimal.
   *  الذمم الحاكمة = customers.currentBalance (§٥): سند القبض المستقلّ يخفّضها دون مسّ
   *  invoices.paidAmount ⇒ متبقّي الفواتير وحده قد يطالب عميلاً سدّد «على الحساب». */
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
  /** `true` حين الصفّ مدينٌ برصيد افتتاحي/مُدوَّر فقط (بلا فاتورة نظام) — قرار المالك (٥/٧): يظهر في
   *  العرض المجمَّع (branchId=null) فقط، مؤرَّخاً من قيد OPENING، والمبلغ = كامل الرصيد الجاري. الواجهة تُبرزه بشارة. */
  isOpeningBalance: boolean;
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

/** قائمة اليوم المؤهَّلة للتذكير: عملاء بذمّة >0 وأقدم فاتورة متأخّرة ≥٧ أيام، لم يُذكَّروا آخر ٧ أيام.
 *  branchId=null ⇒ تجميع كل الفروع (لوحة المرتفعين/برنامج اليوم — مرآة getDashboardMetrics)؛
 *  التبريد/الوعد يُقرآن عندئذٍ من آخر تذكير للعميل في أي فرع. */
export async function getReminderQueue(opts: {
  branchId: number | null;
  /** `true` ⇒ **مدينو الرصيد الافتتاحي فقط** (بلا فواتير نظام)، مجمَّعين عبر الفروع. نطاق مستقلّ
   *  للأدمن في الشاشة، معزول عن طابور الفواتير الفرعيّ (يتجنّب حاصر «قراءة مجمَّعة + كتابة فرعيّة»). */
  openingOnly?: boolean;
}): Promise<ReminderQueueRow[]> {
  const db = requireDb();
  // نطاق «مدينو الافتتاحي فقط» يجمع بلا فلتر فرع دائماً (بلا انتماء فرعيّ أصلاً) — فلترة aging بفرع
  // هنا كانت ستُصنِّف خطأً عميلاً له فواتير في فرعٍ آخر كأنه «مدين افتتاحي بحت» (LEFT JOIN مقيَّد
  // يُخفي فواتيره الفعلية فتظهر unpaidTotal=0/oldestInvoiceDate=null زوراً لهذا الفرع فقط).
  const aging = await getARAging(
    opts.openingOnly || opts.branchId == null ? {} : { branchId: opts.branchId },
  );
  const today = todayUTC();

  // العملاء المؤهَّلون قبل فحص التبريد: ذمّة فعلية >0 + oldestInvoiceDate يعطي ≥REMINDER_MIN_DAYS_OVERDUE
  // يوماً من التأخّر. `getARAging` قد تُرجع عملاء رصيدهم فقط من OPENING (unbucketed) ⇒ نتجاهلهم
  // (لا فاتورة فعلية للتذكير بها). النتيجة عبارة عن قائمة صغيرة عادةً (عشرات) فالتصفية في الذاكرة كافية.
  //
  // مراجعة ٥/٧: متبقّي الفواتير (unpaidTotal) وحده لا يحكم المطالبة — سند القبض المستقلّ
  // («دفعة على الحساب») يخفّض customers.currentBalance دون أن يمسّ invoices.paidAmount، والرصيد
  // الافتتاحي الدائن (PR #125) يجعل currentBalance ≤ 0 رغم بقاء فواتير PENDING. الذمم الحاكمة =
  // currentBalance (§٥) ⇒ يُستبعَد كل عميل currentBalance ≤ 0 (سدّد أو دائن — لا مطالبة)، والمبلغ
  // المعروض/المُرسَل = min(unpaidTotal, currentBalance) — لا نطالب بأكثر من الذمّة الجارية.
  // مسار (أ) — الفواتير النظامية: عميل بذمّة جارية >0 وأقدم فاتورة مستحقّة متأخّرة ≥٧ أيام.
  // (يُتخطّى كلياً في نطاق «مدينو الافتتاحي فقط».)
  const invoiceEligible = opts.openingOnly
    ? []
    : aging
    .filter(
      (r) => money(r.unpaidTotal).gt(0) && money(r.currentBalance).gt(0) && r.oldestInvoiceDate,
    )
    .map((r) => {
      const unpaid = money(r.unpaidTotal);
      const balance = money(r.currentBalance);
      return {
        row: r,
        dueAmount: toDbMoney(unpaid.lt(balance) ? unpaid : balance),
        oldestInvoiceDate: r.oldestInvoiceDate!,
        daysOverdue: daysBetween(r.oldestInvoiceDate!, today),
        isOpeningBalance: false,
      };
    })
    .filter((x) => x.daysOverdue >= REMINDER_MIN_DAYS_OVERDUE);

  // مسار (ب) — مدينو الرصيد الافتتاحي/المُدوَّر فقط (بلا فاتورة نظام) — قرار المالك (٥/٧): يُدرَجون
  // **فقط عند طلب صريح `openingOnly`** (لا بمجرّد branchId=null) — نطاق مقصودٌ للأدمن حصراً عبر
  // الراوتر (arRemindersRouter.queue بـopeningScope). ⚠️ تحقّق عدائي (٥/٧) كشف أن الشرط السابق
  // (`branchId==null || openingOnly`) كان يُسرِّب هؤلاء المدينين إلى تجميع `dashboard.ts` العادي —
  // الذي يستدعي branchId=null لأي مدير مرتفع (لا الأدمن حصراً)، فيظهرون في «برنامج اليوم» لكل مدير
  // بلا علمه رغم أن الراوتر يمنعه صراحةً من رؤيتهم مباشرةً. الشرط الآن صريح لا يتفعّل صدفةً.
  let openingEligible: typeof invoiceEligible = [];
  if (opts.openingOnly) {
    const openingCandidates = aging.filter(
      (r) => !r.oldestInvoiceDate && money(r.currentBalance).gt(0),
    );
    if (openingCandidates.length) {
      const ids = openingCandidates.map((r) => r.customerId);
      const openRows = await db
        .select({
          customerId: accountingEntries.customerId,
          openedOn: sql<string>`DATE_FORMAT(MIN(${accountingEntries.entryDate}), '%Y-%m-%d')`,
        })
        .from(accountingEntries)
        .where(
          and(
            eq(accountingEntries.entryType, "OPENING"),
            sql`${accountingEntries.customerId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
          ),
        )
        .groupBy(accountingEntries.customerId);
      const openedOn = new Map<number, string>();
      for (const r of openRows) if (r.openedOn) openedOn.set(Number(r.customerId), r.openedOn);
      openingEligible = openingCandidates
        // نشترط قيد OPENING فعليّاً (تعريف «مدين افتتاحي») — رصيد موجب من مصدر آخر بلا OPENING يُستبعَد.
        .filter((r) => openedOn.has(r.customerId))
        .map((r) => {
          const openingDate = openedOn.get(r.customerId)!;
          return {
            row: r,
            dueAmount: toDbMoney(money(r.currentBalance)),
            oldestInvoiceDate: openingDate,
            daysOverdue: daysBetween(openingDate, today),
            isOpeningBalance: true,
          };
        })
        .filter((x) => x.daysOverdue >= REMINDER_MIN_DAYS_OVERDUE);
    }
  }

  const eligible = [...invoiceEligible, ...openingEligible];
  if (eligible.length === 0) return [];

  // آخر تذكير لكل عميل مع تاريخ الوعد (لكل عميل، ONLY latest row) — استعلام subquery داخلي
  // بأحدث id لكل customerId (id = AUTO_INCREMENT ⇒ ترتيب زمني موثوق أدقّ من MAX(createdAt)
  // مع تعادل الثانية)، ثم JOIN لجلب `promisedDate` من نفس الصفّ. استعلام واحد لا N+1.
  const customerIds = eligible.map((x) => x.row.customerId);
  // عند فرع محدَّد: آخر تذكير للعميل **في هذا الفرع** (التبريد فرعيّ — عميل مشترك بين فرعين قد
  // يُذكَّر من كليهما في نفس اليوم؛ سلوك سابق للتغيير، توحيده قرار متابعة). عند null (تجميع):
  // آخر تذكير له في **أي** فرع — تبريد/وعد موحَّدان عبر الفروع في القراءة المجمَّعة.
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
        ...(opts.branchId != null ? [eq(arReminders.branchId, opts.branchId)] : []),
        opts.branchId != null
          ? sql`${arReminders.id} = (
              SELECT MAX(inner_r.id) FROM ${arReminders} AS inner_r
              WHERE inner_r.customerId = ${arReminders.customerId}
                AND inner_r.branchId = ${arReminders.branchId}
            )`
          : sql`${arReminders.id} = (
              SELECT MAX(inner_r.id) FROM ${arReminders} AS inner_r
              WHERE inner_r.customerId = ${arReminders.customerId}
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
  for (const { row, dueAmount, oldestInvoiceDate, daysOverdue, isOpeningBalance } of eligible) {
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
      totalUnpaid: dueAmount,
      oldestInvoiceDate,
      daysOverdue,
      lastReminderAt: last ? last.at.toISOString() : null,
      lastReminderStatus: last ? last.status : null,
      promisedDate: last?.promisedDate ?? null,
      isPromiseDue,
      isOpeningBalance,
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
  /** مدين رصيد افتتاحي (بلا فاتورة فرعيّة) ⇒ يُتحقَّق بقيد OPENING بدل الفاتورة الفرعيّة. */
  isOpeningBalance?: boolean;
  /** وسيلة الإرسال: MANUAL (زرّ wa.me اليدوي القائم) أو API (T4.2، قالب Meta معتمَد عبر Cloud API).
   *  الترك بلا تمرير (undefined) يبقي السلوك القديم تماماً — يُخزَّن null (لا تغيير رجعي). */
  sentVia?: "MANUAL" | "API";
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

/** حماية IDOR لمدينِي الرصيد الافتتاحي (بلا فاتورة فرعيّة): نتحقّق من ذمّة جارية موجبة + قيد OPENING
 *  بدل فحص الفاتورة الفرعيّة (الذي يفشل حتماً لغيابها). يمنع تسجيل تذكير على عميل غير مدين افتتاحيّاً. */
async function assertOpeningBalanceDebtor(customerId: number): Promise<void> {
  const db = requireDb();
  const rows = await db
    .select({ id: accountingEntries.id })
    .from(accountingEntries)
    .innerJoin(customers, eq(customers.id, accountingEntries.customerId))
    .where(
      and(
        eq(accountingEntries.entryType, "OPENING"),
        eq(accountingEntries.customerId, customerId),
        sql`CAST(${customers.currentBalance} AS DECIMAL(15,2)) > 0`,
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new TRPCError({ code: "NOT_FOUND", message: "لا رصيد افتتاحيّ مستحقّ لهذا العميل — لا يجوز تسجيل تذكير عنه." });
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
  if (input.isOpeningBalance) {
    await assertOpeningBalanceDebtor(input.customerId);
  } else {
    await assertCustomerHasBranchInvoice(input.customerId, actor.branchId);
  }

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
    sentVia: input.sentVia ?? null,
    createdBy: actor.userId,
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  return { id };
}

// ── إرسال عبر Cloud API (T4.2 — خلف مفتاح flowArReminder، افتراضياً OFF) ───────────────────────

/** اسم الشركة كما يظهر في نصوص القوالب (نمط `CO.name` في `client/src/lib/printing/brand.ts` — لا
 *  يجوز استيراد ملف عميل من الخادم، فالنصّ مكرَّر هنا عمداً بنفس القيمة الحرفية). */
const COMPANY_NAME_AR = "شركة الرؤية العربية للتجارة العامة وتجارة القرطاسية";

/** "٥٠٬٠٠٠ د.ع" — نمط `barcodeService.ts` (توطين أرقام لاتينية بفواصل عربية + وحدة العملة). */
function formatIQD(amount: string): string {
  return money(amount).toNumber().toLocaleString("ar-IQ-u-nu-latn") + " د.ع";
}

export interface SendViaApiInput {
  customerId: number;
  totalUnpaidSnapshot: string;
  oldestInvoiceDate: string;
  daysOverdue: number;
  isOpeningBalance?: boolean;
}

export type SendViaApiResult = { sent: true; reminderId: number } | { sent: false; reason: string };

/**
 * إرسال تذكير عبر قالب Meta معتمَد (`payment_reminder`) بدل فتح wa.me يدوياً — يمرّ حصراً عبر
 * `flowNotify` (كل الحراس: killSwitch/المفتاح/التكامل/OPTED_OUT/اعتماد القالب). عند النجاح الفعلي
 * (صفّ outbox قُيِّد) يُسجَّل التذكير بـ`sentVia='API'`؛ أي تخطٍّ (مفتاح مطفأ/لا تكامل/…) **لا يسجّل
 * شيئاً** — الواجهة تُبلَّغ بالسبب فتقرّر (الرجوع لمسار wa.me اليدوي القائم يبقى متاحاً دون أي تغيير).
 */
export async function sendViaApi(
  input: SendViaApiInput,
  actor: { userId: number; branchId: number },
): Promise<SendViaApiResult> {
  const db = requireDb();
  const cust = (
    await db.select({ name: customers.name, phone: customers.phone }).from(customers).where(eq(customers.id, input.customerId)).limit(1)
  )[0];
  if (!cust) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود." });
  if (!cust.phone) return { sent: false, reason: "لا رقم هاتف مسجَّل لهذا العميل." };

  const result = await flowNotify({
    flowKey: "flowArReminder",
    branchId: actor.branchId,
    toPhoneE164: cust.phone,
    customerId: input.customerId,
    templateName: "payment_reminder",
    bodyParams: [cust.name, formatIQD(input.totalUnpaidSnapshot), COMPANY_NAME_AR],
    dedupeKey: `AR:${input.customerId}:${todayUTC().replace(/-/g, "")}`,
  });
  if (!("queued" in result)) {
    return { sent: false, reason: result.skipped };
  }

  const logged = await logReminderSent(
    {
      customerId: input.customerId,
      totalUnpaidSnapshot: input.totalUnpaidSnapshot,
      oldestInvoiceDate: input.oldestInvoiceDate,
      daysOverdue: input.daysOverdue,
      messageBody: `[API] payment_reminder — ${formatIQD(input.totalUnpaidSnapshot)}`,
      isOpeningBalance: input.isOpeningBalance,
      sentVia: "API",
    },
    actor,
  );
  return { sent: true, reminderId: logged.id };
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
  /** مدين رصيد افتتاحي (بلا فاتورة فرعيّة) ⇒ يُتحقَّق بقيد OPENING بدل الفاتورة الفرعيّة. */
  isOpeningBalance?: boolean;
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
  if (input.isOpeningBalance) {
    await assertOpeningBalanceDebtor(input.customerId);
  } else {
    await assertCustomerHasBranchInvoice(input.customerId, actor.branchId);
  }

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

/** سجلّ آخر ٣٠ يوماً من التذكيرات في الفرع (أو حدود مخصَّصة). للتدقيق والمتابعة.
 *  branchId=null ⇒ سجلّ كل الفروع (قراءة الأدمن المجمَّعة — مرآة getReminderQueue). */
export async function getReminderHistory(opts: {
  branchId: number | null;
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
    .where(
      and(
        ...(opts.branchId != null ? [eq(arReminders.branchId, opts.branchId)] : []),
        gte(arReminders.createdAt, thirtyDaysAgo),
      ),
    )
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
