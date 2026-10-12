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
import { appErrorMessage } from "@shared/errors";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  accountingEntries,
  arReminders,
  branches,
  customers,
  invoices,
} from "../../drizzle/schema";
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
  /**
   * معرّف الفرع المسند للذمّة (null للمدينين بالرصيد الافتتاحي المجمَّع على مستوى الشركة).
   * يضمن دقة نسبة التذكير لفرعه وتفادي خطأ «لا فرع مسند».
   */
  branchId: number | null;
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
  /** `true` ⇒ شمول مديني الرصيد الافتتاحي مع فواتير النظام في العرض الموحَّد الشامل. */
  includeOpening?: boolean;
  /** حل فروع الفواتير في العرض المجمّع (افتراضياً: مفعّل عند includeOpening فقط لتفادي إثقال لوحة التحكم) */
  resolveBranchIds?: boolean;
}): Promise<ReminderQueueRow[]> {
  const db = requireDb();
  // نطاق «مدينو الافتتاحي فقط» أو العرض الموحَّد يجمع بلا فلتر فرع دائماً (بلا انتماء فرعيّ أصلاً)
  const aging = await getARAging(
    opts.openingOnly || opts.includeOpening || opts.branchId == null
      ? {}
      : { branchId: opts.branchId },
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
  // جلب قيود OPENING الموجبة إن طُلب الرصيد الافتتاحي (سواء openingOnly أو includeOpening)
  const openedOnMap = new Map<number, string>();
  const openBranchMap = new Map<number, number | null>();

  if (opts.openingOnly || opts.includeOpening) {
    const candidateIds = aging
      .filter((r) => money(r.currentBalance).gt(0))
      .map((r) => r.customerId);
    if (candidateIds.length > 0) {
      const openRows = await db
        .select({
          customerId: accountingEntries.customerId,
          openedOn: sql<string>`DATE_FORMAT(MIN(${accountingEntries.entryDate}), '%Y-%m-%d')`,
          branchId: sql<number | null>`MIN(${accountingEntries.branchId})`,
        })
        .from(accountingEntries)
        .where(
          and(
            eq(accountingEntries.entryType, "OPENING"),
            sql`${accountingEntries.customerId} IN (${sql.join(
              candidateIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        )
        .groupBy(accountingEntries.customerId)
        // ب-١ (١٦/٨): التصحيح صار قيد فرقٍ إلحاقيّاً ⇒ **وجود صفّ** لم يعد يعني «مدين افتتاحيّ»:
        // رصيدٌ افتتاحيّ صُحِّح إلى صفرٍ (أو انقلب دائناً) يُبقي صفّيه في الجدول. المعيار الصحيح
        // هو مجموع القيود موجباً — وإلّا طُولب عميلٌ بمبلغٍ سبق أن أُلغي.
        .having(
          sql`COALESCE(SUM(CAST(${accountingEntries.amount} AS DECIMAL(15,2))), 0) > 0`,
        );

      for (const r of openRows) {
        if (r.openedOn) openedOnMap.set(Number(r.customerId), r.openedOn);
        if (r.branchId != null)
          openBranchMap.set(Number(r.customerId), Number(r.branchId));
      }
    }
  }

  type EligibleItem = {
    row: (typeof aging)[0];
    dueAmount: string;
    oldestInvoiceDate: string;
    daysOverdue: number;
    isOpeningBalance: boolean;
    branchId: number | null;
  };

  const eligible: EligibleItem[] = [];

  for (const r of aging) {
    const balance = money(r.currentBalance);
    // §٥: الذمم الحاكمة = currentBalance — لا مطالبة لمن رصيده صفراً أو دائناً
    if (balance.lte(0)) continue;

    const hasInvoice = Boolean(
      r.oldestInvoiceDate && money(r.unpaidTotal).gt(0),
    );
    const openedOn = openedOnMap.get(r.customerId);
    const hasOpening = Boolean(openedOn);
    // تدقيق مراجعة كودكس: ثبوت الرصيد الافتتاحي المتبقي فعلياً من واقع unbucketed > 0
    // فوجود قيد تاريخي لا يعني بقاء الدين إن كانت هناك مقاصات أو دفعات لاحقة غطته
    const hasOutstandingOpening =
      hasOpening && Boolean(openedOn) && money(r.unbucketed).gt(0);

    if (opts.openingOnly) {
      // نطاق «الافتتاحي فقط»: عملاء بلا فاتورة نظام ولديهم رصيد افتتاحي مستحق
      if (!hasInvoice && hasOutstandingOpening && openedOn) {
        const days = daysBetween(openedOn, today);
        if (days >= REMINDER_MIN_DAYS_OVERDUE) {
          eligible.push({
            row: r,
            dueAmount: toDbMoney(balance),
            oldestInvoiceDate: openedOn,
            daysOverdue: days,
            isOpeningBalance: true,
            branchId: openBranchMap.get(r.customerId) ?? null,
          });
        }
      }
      continue;
    }

    if (opts.includeOpening) {
      // العرض الشامل المدمج (كل الفروع): فواتير + رصيد افتتاحي + عميل هجين
      if (hasInvoice && hasOutstandingOpening && openedOn && r.oldestInvoiceDate) {
        // عميل هجين: لديه فواتير ورصيد افتتاحي متبقٍّ فعلياً (unbucketed > 0)
        // تاريخ التأخر الأقدم بينهما لمنع الحجب
        const effectiveOldestDate =
          openedOn < r.oldestInvoiceDate ? openedOn : r.oldestInvoiceDate;
        const days = daysBetween(effectiveOldestDate, today);
        if (days >= REMINDER_MIN_DAYS_OVERDUE) {
          eligible.push({
            row: r,
            dueAmount: toDbMoney(balance), // كامل الذمة الجارية الحاكمة
            oldestInvoiceDate: effectiveOldestDate,
            daysOverdue: days,
            isOpeningBalance: false, // لديه فواتير نظام فيعامل بفرع فواتيره
            branchId: opts.branchId ?? null,
          });
        }
      } else if (hasInvoice && r.oldestInvoiceDate) {
        // عميل فواتير بحت (أو عميل كان لديه رصيد افتتاحي وسُدّد بالكامل وبقيت الفواتير فقط)
        const unpaid = money(r.unpaidTotal);
        const days = daysBetween(r.oldestInvoiceDate, today);
        if (days >= REMINDER_MIN_DAYS_OVERDUE) {
          eligible.push({
            row: r,
            dueAmount: toDbMoney(unpaid.lt(balance) ? unpaid : balance),
            oldestInvoiceDate: r.oldestInvoiceDate,
            daysOverdue: days,
            isOpeningBalance: false,
            branchId: opts.branchId ?? null,
          });
        }
      } else if (hasOutstandingOpening && openedOn) {
        // عميل رصيد افتتاحي بحت (أو فواتيره سُدّدت وبقي رصيد افتتاحي مستحق)
        const days = daysBetween(openedOn, today);
        if (days >= REMINDER_MIN_DAYS_OVERDUE) {
          eligible.push({
            row: r,
            dueAmount: toDbMoney(balance),
            oldestInvoiceDate: openedOn,
            daysOverdue: days,
            isOpeningBalance: true,
            branchId: openBranchMap.get(r.customerId) ?? null,
          });
        }
      }
    } else {
      // العرض العادي (فرع محدد أو استدعاء بلا includeOpening)
      if (hasInvoice && r.oldestInvoiceDate) {
        const unpaid = money(r.unpaidTotal);
        const days = daysBetween(r.oldestInvoiceDate, today);
        if (days >= REMINDER_MIN_DAYS_OVERDUE) {
          eligible.push({
            row: r,
            dueAmount: toDbMoney(unpaid.lt(balance) ? unpaid : balance),
            oldestInvoiceDate: r.oldestInvoiceDate,
            daysOverdue: days,
            isOpeningBalance: false,
            branchId: opts.branchId ?? null,
          });
        }
      }
    }
  }

  // حل فروع الفواتير في العرض المجمّع (branchId == null) للعملاء غير الافتتاحيين
  // يتم فقط عند includeOpening أو طلب صريح لتفادي أي عبء إضافي على لوحة التحكم
  const shouldResolveBranches =
    opts.resolveBranchIds ?? Boolean(opts.includeOpening);
  if (shouldResolveBranches && opts.branchId == null) {
    const invCustIds = eligible
      .filter((x) => !x.isOpeningBalance)
      .map((x) => x.row.customerId);
    if (invCustIds.length > 0) {
      const oldestInvBranches = await db
        .select({
          customerId: invoices.customerId,
          branchId: invoices.branchId,
        })
        .from(invoices)
        .where(
          and(
            sql`${invoices.customerId} IN (${sql.join(
              invCustIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
            inArray(invoices.status, ["PENDING", "PARTIALLY_PAID"]),
          ),
        )
        .orderBy(
          asc(sql`COALESCE(${invoices.dueDate}, ${invoices.invoiceDate})`),
        );
      const branchSetByCustomer = new Map<number, Set<number>>();
      const singleBranchByCustomer = new Map<number, number>();
      for (const r of oldestInvBranches) {
        if (r.customerId && r.branchId) {
          let s = branchSetByCustomer.get(r.customerId);
          if (!s) {
            s = new Set();
            branchSetByCustomer.set(r.customerId, s);
          }
          s.add(r.branchId);
          if (!singleBranchByCustomer.has(r.customerId)) {
            singleBranchByCustomer.set(r.customerId, r.branchId);
          }
        }
      }
      for (const item of eligible) {
        if (!item.isOpeningBalance) {
          const branches = branchSetByCustomer.get(item.row.customerId);
          // إذا كانت فواتير العميل محصورة في فرع واحد فقط، يُسند لهذا الفرع
          // أما إذا تعددت فروعه، فيبقى null صراحةً للحفاظ على النطاق الشامل المجمّع
          if (branches && branches.size === 1) {
            item.branchId = singleBranchByCustomer.get(item.row.customerId) ?? null;
          } else {
            item.branchId = null;
          }
        }
      }
    }
  }

  if (eligible.length === 0) return [];

  // آخر تذكير لكل عميل مع تاريخ الوعد (لكل عميل، ONLY latest row) — استعلام subquery داخلي
  // بأحدث id لكل customerId (id = AUTO_INCREMENT ⇒ ترتيب زمني موثوق أدقّ من MAX(createdAt)
  // مع تعادل الثانية)، ثم JOIN لجلب `promisedDate` من نفس الصفّ. استعلام واحد لا N+1.
  const customerIds = eligible.map((x) => x.row.customerId);
  // قراءة آخر تذكير لكل عميل:
  // - عند تحديد فرع معين: نأخذ آخر تذكير مسجل لهذا الفرع أو أي تذكير شامل لكافة الفروع [ALL_BRANCHES]
  //   لمنع تكرار الاتصال بالعميل إن كانت الإدارة العامة قد ذكرته، مع صون استقلالية تذكير فروع أخرى لم تُذكر بعد.
  // - عند العرض الشامل المجمّع: نأخذ آخر تذكير للعميل في أي فرع.
  const lastRows = await db
    .select({
      id: arReminders.id,
      customerId: arReminders.customerId,
      branchId: arReminders.branchId,
      messageBody: arReminders.messageBody,
      skipReason: arReminders.skipReason,
      lastAt: arReminders.createdAt,
      lastStatus: arReminders.status,
      lastPromisedDate: arReminders.promisedDate,
    })
    .from(arReminders)
    .where(
      and(
        sql`${arReminders.customerId} IN (${sql.join(
          customerIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
        sql`${arReminders.id} = (
          SELECT MAX(inner_r.id) FROM ${arReminders} AS inner_r
          WHERE inner_r.customerId = ${arReminders.customerId}
            ${
              opts.branchId != null
                ? sql`AND (inner_r.branchId = ${opts.branchId} OR inner_r.messageBody LIKE '[ALL_BRANCHES]%' OR inner_r.skipReason LIKE '[ALL_BRANCHES]%')`
                : sql``
            }
        )`,
      ),
    );

  const lastByCustomer = new Map<
    number,
    {
      at: Date;
      status: "SENT" | "SKIPPED";
      promisedDate: string | null;
      isAllBranches: boolean;
      branchId: number;
    }
  >();
  for (const r of lastRows) {
    const isAllBranches =
      Boolean(r.messageBody?.startsWith("[ALL_BRANCHES]")) ||
      Boolean(r.skipReason?.startsWith("[ALL_BRANCHES]"));
    lastByCustomer.set(Number(r.customerId), {
      at: new Date(r.lastAt),
      status: r.lastStatus,
      promisedDate: r.lastPromisedDate ?? null,
      isAllBranches,
      branchId: Number(r.branchId),
    });
  }

  // فحص التبريد + استثناء الوعد المستحقّ اليوم:
  //  - تبريد ٧ أيام يمنع إغراق العميل (يستبعد من القائمة).
  //  - إن كان تخطٍّ سابق بتاريخ وعد ≤ اليوم ⇒ نتخطّى التبريد ونُعيد إظهاره (استحقاق متابعة).
  //  - وعد المستقبل (promisedDate > اليوم) لا يظهر بعد — نحترم قرار الموظف بتأجيل المتابعة.
  const nowMs = Date.now();
  const cooldownMs = REMINDER_COOLDOWN_DAYS * 86_400_000;
  const queue: ReminderQueueRow[] = [];
  for (const {
    row,
    dueAmount,
    oldestInvoiceDate,
    daysOverdue,
    isOpeningBalance,
    branchId,
  } of eligible) {
    const last = lastByCustomer.get(row.customerId);
    const isPromiseDue = !!(
      last &&
      last.promisedDate &&
      last.promisedDate <= today
    );
    const isFuturePromise = !!(
      last &&
      last.promisedDate &&
      last.promisedDate > today
    );
    // وعد المستقبل ⇒ استبعاد فوري (متابعة مؤجَّلة بقرار موظف).
    if (isFuturePromise) continue;
    // ليس وعداً مستحقّاً + في نافذة التبريد:
    if (!isPromiseDue && last && nowMs - last.at.getTime() < cooldownMs) {
      // تدقيق مراجعة كودكس: في العرض الشامل المجمّع (opts.branchId == null):
      // إذا كان التذكير السابق محلياً بفرع واحد فقط (ليس [ALL_BRANCHES])،
      // والعميل لديه فواتير في فروع أخرى (branchId === null)، فالذمة الإجمالية لم تُغطَّ بالكامل
      const isCustomerMultiBranch = branchId === null && !isOpeningBalance;
      if (opts.branchId == null && !last.isAllBranches && isCustomerMultiBranch) {
        // لا يُحجب عن الطابور الإداري الشامل
      } else {
        continue;
      }
    }
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
      branchId,
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
  /** نطاق شامل لكل الفروع (للإدارة العامة حصراً) ⇒ يوثق كـ[ALL_BRANCHES] ويحمي التبريد عبر الفروع. */
  isAllBranches?: boolean;
  /** وسيلة الإرسال: MANUAL (زرّ wa.me اليدوي القائم) أو API (T4.2، قالب Meta معتمَد عبر Cloud API).
   *  الترك بلا تمرير (undefined) يبقي السلوك القديم تماماً — يُخزَّن null (لا تغيير رجعي). */
  sentVia?: "MANUAL" | "API";
}

/** حماية IDOR: العميل «يخصّ الفرع» إن كانت له فاتورة (مؤكَّدة/غير ملغاة) في هذا الفرع.
 *  (العملاء ليس لهم branchId — يشتركون عبر الفروع، والعزل يتمّ عبر الفواتير.) */
async function assertCustomerHasBranchInvoice(
  customerId: number,
  branchId: number,
): Promise<void> {
  const db = requireDb();
  const rows = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.customerId, customerId),
        eq(invoices.branchId, branchId),
        inArray(invoices.status, [
          "PENDING",
          "PARTIALLY_PAID",
          "PAID",
          "CONFIRMED",
        ]),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "لا فواتير لهذا العميل في فرعك — لا يجوز تسجيل تذكير عنه.",
    });
  }
}

/** حماية IDOR لمدينِي الرصيد الافتتاحي (بلا فاتورة فرعيّة): نتحقّق من ذمّة جارية موجبة + قيد OPENING
 *  بدل فحص الفاتورة الفرعيّة (الذي يفشل حتماً لغيابها). يمنع تسجيل تذكير على عميل غير مدين افتتاحيّاً. */
async function assertOpeningBalanceDebtor(customerId: number): Promise<void> {
  const db = requireDb();
  // ب-١ (١٦/٨): **مجموع** قيود OPENING موجباً لا مجرّد وجود صفّ — التصحيح إلحاقيّ، فصفوف
  // رصيدٍ أُلغي تبقى قائمةً ولا يجوز أن تفتح باب تسجيل تذكيرٍ عليه.
  const rows = await db
    .select({
      total: sql<string>`COALESCE(SUM(CAST(${accountingEntries.amount} AS DECIMAL(15,2))), 0)`,
    })
    .from(accountingEntries)
    .innerJoin(customers, eq(customers.id, accountingEntries.customerId))
    .where(
      and(
        eq(accountingEntries.entryType, "OPENING"),
        eq(accountingEntries.customerId, customerId),
        sql`CAST(${customers.currentBalance} AS DECIMAL(15,2)) > 0`,
      ),
    );
  if (!money(rows[0]?.total ?? "0").gt(0)) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "لا رصيد افتتاحيّ مستحقّ لهذا العميل — لا يجوز تسجيل تذكير عنه.",
    });
  }
}

/** حماية العميل على مستوى الشركة (تذكير كل الفروع / مدين متعدد الفروع أو افتتاحي) */
async function assertCustomerBelongsToCompany(customerId: number): Promise<void> {
  const db = requireDb();
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.id, customerId),
        sql`CAST(${customers.currentBalance} AS DECIMAL(15,2)) > 0`,
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "العميل غير مؤهل لتسجيل تذكير عام",
        why: "العميل غير موجود أو ليس لديه رصيد مدين مستحق في سجلات الشركة.",
        doThis: "تأكد من اختيار عميل ذي ذمة مالية موجبة في النظام.",
      }),
    });
  }
}

/** تسجيل تذكير أُرسِل (status='SENT'). لا يمسّ الدفتر ولا الأموال ولا الفواتير. */
export async function logReminderSent(
  input: LogReminderInput,
  actor: { userId: number; branchId: number },
): Promise<{ id: number }> {
  if (money(input.totalUnpaidSnapshot).lte(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "الرصيد الآجل يجب أن يكون موجباً.",
    });
  }
  if (input.daysOverdue < 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "أيام التأخّر لا تصحّ أن تكون سالبة.",
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.oldestInvoiceDate)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "تاريخ أقدم فاتورة غير صالح.",
    });
  }
  if (!input.messageBody.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "نص الرسالة فارغ." });
  }
  if (input.isAllBranches) {
    await assertCustomerBelongsToCompany(input.customerId);
  } else if (input.isOpeningBalance) {
    await assertOpeningBalanceDebtor(input.customerId);
  } else {
    await assertCustomerHasBranchInvoice(input.customerId, actor.branchId);
  }

  const finalMessageBody =
    input.isAllBranches && !input.messageBody.startsWith("[ALL_BRANCHES]")
      ? `[ALL_BRANCHES] ${input.messageBody}`
      : input.messageBody;

  const db = requireDb();
  const res = await db.insert(arReminders).values({
    customerId: input.customerId,
    branchId: actor.branchId,
    totalUnpaidSnapshot: money(input.totalUnpaidSnapshot).toFixed(2),
    oldestInvoiceDate: input.oldestInvoiceDate,
    daysOverdue: input.daysOverdue,
    messageBody: finalMessageBody,
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
  isAllBranches?: boolean;
}

export type SendViaApiResult =
  | { sent: true; reminderId: number }
  | { sent: false; reason: string };

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
    await db
      .select({ name: customers.name, phone: customers.phone })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1)
  )[0];
  if (!cust)
    throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود." });
  if (!cust.phone)
    return { sent: false, reason: "لا رقم هاتف مسجَّل لهذا العميل." };

  const result = await flowNotify({
    flowKey: "flowArReminder",
    branchId: actor.branchId,
    toPhoneE164: cust.phone,
    customerId: input.customerId,
    templateName: "payment_reminder",
    bodyParams: [
      cust.name,
      formatIQD(input.totalUnpaidSnapshot),
      COMPANY_NAME_AR,
    ],
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
      isAllBranches: input.isAllBranches,
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
  /** نطاق شامل لكل الفروع (للإدارة العامة حصراً) ⇒ يوثق كـ[ALL_BRANCHES] ويحمي التبريد عبر الفروع. */
  isAllBranches?: boolean;
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
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب التخطّي أطول من ٢٥٥ حرفاً.",
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.oldestInvoiceDate)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "تاريخ أقدم فاتورة غير صالح.",
    });
  }
  if (input.daysOverdue < 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "أيام التأخّر لا تصحّ أن تكون سالبة.",
    });
  }
  const promisedDate = input.promisedDate?.trim() || null;
  if (promisedDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(promisedDate)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "تاريخ الوعد غير صالح.",
      });
    }
    // وعد في الماضي = لا معنى له (المتابعة يجب أن تكون مستقبلاً).
    if (promisedDate < todayUTC()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "تاريخ الوعد يجب ألّا يكون في الماضي.",
      });
    }
  }
  if (input.isAllBranches) {
    await assertCustomerBelongsToCompany(input.customerId);
  } else if (input.isOpeningBalance) {
    await assertOpeningBalanceDebtor(input.customerId);
  } else {
    await assertCustomerHasBranchInvoice(input.customerId, actor.branchId);
  }

  const finalSkipReason =
    input.isAllBranches && !input.skipReason.startsWith("[ALL_BRANCHES]")
      ? `[ALL_BRANCHES] ${input.skipReason.trim()}`
      : input.skipReason.trim();

  const db = requireDb();
  const res = await db.insert(arReminders).values({
    customerId: input.customerId,
    branchId: actor.branchId,
    totalUnpaidSnapshot: money(input.totalUnpaidSnapshot).toFixed(2),
    oldestInvoiceDate: input.oldestInvoiceDate,
    daysOverdue: input.daysOverdue,
    messageBody: "",
    status: "SKIPPED",
    skipReason: finalSkipReason,
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
  branchId: number;
  branchName: string | null;
  /** تذكير مسجل بنطاق شامل لكافة الفروع */
  isAllBranches: boolean;
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
      branchId: arReminders.branchId,
      branchName: branches.name,
      messageBody: arReminders.messageBody,
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
    .leftJoin(branches, eq(branches.id, arReminders.branchId))
    .where(
      and(
        ...(opts.branchId != null
          ? [
              // في سجل فرع معين: استبعاد التذكيرات العامة المجمعة [ALL_BRANCHES]
              // كي لا تتشوه أرقام وسجلات الفرع المحلي بذمم فروع أخرى
              eq(arReminders.branchId, opts.branchId),
              sql`NOT (${arReminders.messageBody} LIKE '[ALL_BRANCHES]%' OR ${arReminders.skipReason} LIKE '[ALL_BRANCHES]%')`,
            ]
          : []),
        gte(arReminders.createdAt, thirtyDaysAgo),
      ),
    )
    // ترتيب ثابت حتى للتذكيرات في نفس الثانية (TIMESTAMP دقّة ثانية على MySQL 5.7 الافتراضية):
    // id فاصلٌ زمنيّاً مطابق لِـcreatedAt (AUTO_INCREMENT) ⇒ الأحدث دائماً على القمّة.
    .orderBy(desc(arReminders.createdAt), desc(arReminders.id))
    .limit(limit);

  return rows.map((r) => {
    const isAllBranches =
      Boolean(r.messageBody?.startsWith("[ALL_BRANCHES]")) ||
      Boolean(r.skipReason?.startsWith("[ALL_BRANCHES]"));
    const cleanSkipReason = r.skipReason?.replace(/^\[ALL_BRANCHES\]\s*/, "") ?? null;
    return {
      id: Number(r.id),
      customerId: Number(r.customerId),
      customerName: r.customerName,
      branchId: Number(r.branchId),
      branchName: r.branchName ?? null,
      isAllBranches,
      totalUnpaidSnapshot: r.totalUnpaidSnapshot,
      daysOverdue: r.daysOverdue,
      status: r.status,
      skipReason: cleanSkipReason,
      promisedDate: r.promisedDate ?? null,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    };
  });
}
