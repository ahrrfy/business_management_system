// مقاييس لوحة التحكم (بطاقات المخزون المنخفض والذمم المتأخّرة + برنامج اليوم).
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { getReminderQueue } from "../arRemindersService";

/** شرط SQL خام لمهمة متأخّرة — مرآة `overdueSqlCond` في `server/services/tasks/list.ts`
 *  (لا استيراد مباشر: تلك الدالة تستعمل أعمدة drizzle مكتوبة `tasks.dueAt`، وهذا الملف يبني
 *  استعلامات SQL خام بأسماء أعمدة حرفية `t.col` — نمط بقيّة هذا الملف). أي تعديل لتعريف
 *  «التأخّر» هناك يجب أن يُطبَّق هنا أيضاً.
 */
const TASK_OVERDUE_SQL_COND = sql`
  t.dueAt IS NOT NULL
  AND DATE_ADD(t.dueAt, INTERVAL (t.waitingAccumMs * 1000 + IF(t.waitingSince IS NOT NULL, TIMESTAMPDIFF(MICROSECOND, t.waitingSince, NOW()), 0)) MICROSECOND) < NOW()
  AND t.taskStatus NOT IN ('RESOLVED','CANCELLED')
`;

/**
 * عدد المهام المفتوحة (غير RESOLVED/CANCELLED) المُسنَدة لمستخدمٍ بعينه — استعلامٌ خفيف مستقلّ
 * (لا يمرّ بكامل `getDashboardMetrics`) لأنّ هذا الرقم شخصيٌّ بطبعه (يختلف لكل مستخدم) بخلاف
 * بقيّة حقول morningBrief المُخزَّنة مؤقّتاً في `morningPushScheduler.ts` عبر `metricsCache`
 * (تُحسب مرّة واحدة لكل قيمة includeOpeningBalance بغضّ النظر عن عدد المشتركين — تجنّباً لتكرار
 * N+1 الذي أُصلح ٥/٧؛ إضافة رقمٍ شخصيّ داخل تلك الدالة الثقيلة كانت ستُعيد فتح تلك العلّة).
 */
export async function getMyOpenTasksCount(userId: number): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS c
    FROM tasks t
    WHERE t.assignedTo = ${userId}
      AND t.taskStatus NOT IN ('RESOLVED','CANCELLED')
  `);
  const data = (rows as any)[0] ?? rows;
  return Number((Array.isArray(data) ? data[0]?.c : 0) ?? 0);
}

export interface DashboardMetricsResult {
  lowStockCount: number;
  overdueAR: { count: number; total: string };
  /** نبض المبيعات: مبيعات أمس مقابل معدّل آخر ٧ أيام + اتجاه (بطاقة شريط المقاييس، ٥/٧). */
  salesPulse: {
    /** مبيعات أمس (صافي = total − returnedTotal). */
    yesterday: string;
    /** معدّل المبيعات اليومي عبر آخر ٧ أيام مكتملة (المجموع ÷ ٧). */
    avg7d: string;
    /** اتجاه أمس مقابل المعدّل (نطاق ±٣٪ = flat لتفادي ضجيج الأرقام الصغيرة). */
    direction: "up" | "down" | "flat";
    /** نسبة التغيّر عن المعدّل (عدد صحيح، +/−؛ 0 حين لا مبيعات سابقة). */
    changePct: number;
  };
  /** برنامج اليوم — بطاقات فعل صباحية للمدير/الأدمن (٤/٧/٢٦). */
  morningBrief: {
    /** تذكيرات ذمم مستحقّة اليوم (≥٧ أيام + خارج تبريد ٧ أيام) — من `getReminderQueue`. */
    arRemindersDue: number;
    /** عملاء موعودون بالدفع اليوم (`isPromiseDue=true`) — يتصدّرون قائمة التذكيرات. */
    promisedToday: number;
    /** أوامر شغل متجاوزة `dueDate` وحالتها غير مُسلَّمة/ملغاة — تحتاج متابعة إنتاج. */
    overdueWorkOrders: number;
    /** مهامي المفتوحة (نظام المهام الموحّد S2) — مُسنَدة لمستخدم الطلب (`opts.userId`) وغير
     *  منتهية (لا RESOLVED/CANCELLED). صفرٌ حين لا `userId` (المستدعي لا يريد رقماً شخصياً). */
    myOpenTasks: number;
    /** مهام متأخّرة ضمن نطاق الفرع نفسه المُستعمَل لبقيّة هذه البطاقة (تشغيليّ — لا يتطلّب
     *  رؤية تقارير، بنفس منطق overdueWorkOrders). */
    overdueTasks: number;
  };
}

/**
 * مقاييس البطاقتين المعطّلتين في Dashboard.MetricsBar:
 *  - lowStockCount: متغيّرات تحت minStock (minStock>0) ضمن الفرع المُحدَّد (أو الكل إن null).
 *  - overdueAR: عدد ومجموع المتبقّي على فواتير PENDING/PARTIALLY_PAID أعمارها > ٣٠ يوماً.
 *  - morningBrief: ٣ بطاقات فعل صباحية (تذكيرات AR + وعود اليوم + أوامر شغل متأخّرة).
 * لا تطبّق صلاحيات/عزل فرع هنا — يقع ذلك على المستدعي (الراوتر) قبل تمرير `branchId`.
 */
export async function getDashboardMetrics(
  opts: {
    branchId?: number | null;
    /** أدرِج مدينِي الرصيد الافتتاحي (نطاق openingScope) في arRemindersDue/promisedToday — يقرّره
     *  المستدعي حسب دور المستخدم (أدمن حصراً؛ راجع reportsRouter.ts وmorningPushScheduler.ts). لا
     *  أثر إلا حين branchId=null أيضاً (هؤلاء المدينون بلا انتماء فرعيّ — عرض فرع محدَّد يبقى بلا تغيير). */
    includeOpeningBalance?: boolean;
    /** أدرِج الأرقام المالية (AR/إيراد): overdueAR + salesPulse + عدّادا برنامج اليوم AR
     *  (arRemindersDue/promisedToday). يقرّره المستدعي بـ`canViewReports` — أدوار reports=NONE
     *  (كاشير/مخزن/فنّي/مندوب) تتلقّى أصفاراً محايدة لا الأرقام الحقيقية (تدقيق ١٧/٧، تسريب
     *  dashboardMetrics). الافتراضي `true` للتوافق مع المستدعين المُتحقَّق منهم (المجدول/التنفيذيّة).
     *  lowStockCount وoverdueWorkOrders تشغيليّان ⇒ يُحسبان دائماً بلا تقييد. */
    includeFinancials?: boolean;
    /** مستخدم الطلب — يُستعمل حصراً لحساب `morningBrief.myOpenTasks` الشخصي. غيابه (المستدعيان
     *  الحاليّان اللذان لا يحملان هوية مستخدم واحدة ذات صلة: الراوتر الحيّ خارج نطاق هذا التكليف
     *  والمسار المُجمَّع) يُبقيه صفراً بلا كسر أي مستدعٍ قائم. */
    userId?: number | null;
  } = {}
): Promise<DashboardMetricsResult> {
  const includeFinancials = opts.includeFinancials ?? true;
  const db = getDb();
  if (!db) {
    return {
      lowStockCount: 0,
      overdueAR: { count: 0, total: toDbMoney(money(0)) },
      salesPulse: { yesterday: toDbMoney(money(0)), avg7d: toDbMoney(money(0)), direction: "flat", changePct: 0 },
      morningBrief: { arRemindersDue: 0, promisedToday: 0, overdueWorkOrders: 0, myOpenTasks: 0, overdueTasks: 0 },
    };
  }
  const branchId = opts.branchId ?? null;
  const branchFilterStock = branchId == null ? sql`` : sql`AND bs.branchId = ${branchId}`;
  const branchFilterInv = branchId == null ? sql`` : sql`AND i.branchId = ${branchId}`;
  const branchFilterWo = branchId == null ? sql`` : sql`AND wo.branchId = ${branchId}`;
  const branchFilterTasks = branchId == null ? sql`` : sql`AND t.branchId = ${branchId}`;

  const lowRows = await db.execute(sql`
    SELECT COUNT(*) AS c
    FROM branchStock bs
    INNER JOIN productVariants v ON v.id = bs.variantId
    WHERE v.minStock > 0
      AND bs.quantity <= v.minStock
      AND v.isActive = TRUE
      ${branchFilterStock}
  `);
  const lowData = (lowRows as any)[0] ?? lowRows;
  const lowStockCount = Number(
    (Array.isArray(lowData) ? lowData[0]?.c : 0) ?? 0
  );

  // overdueAR ماليّ ⇒ يُحسب فقط لمن يملك رؤية التقارير. غير المخوّل يتلقّى صفراً محايداً (لا الرقم
  // الحقيقي) — يُغلق تسريب الـendpoint لأدوار reports=NONE مع إبقاء اللوحة متاحة (lowStock).
  let arRow: { c?: number | string; t?: string } | null = null;
  if (includeFinancials) {
    const arRows = await db.execute(sql`
      SELECT
        COUNT(*) AS c,
        CAST(COALESCE(SUM(GREATEST(i.total - i.paidAmount - i.returnedTotal, 0)), 0) AS CHAR) AS t
      FROM invoices i
      WHERE i.invoiceStatus IN ('PENDING', 'PARTIALLY_PAID')
        -- S2 (٢٩/٦/٢٦): مطابق DATEDIFF(NOW(),invoiceDate)>30 تماماً (DATEDIFF يتجاهل الوقت، TZ=UTC) لكنه قابل للفهرسة.
        AND i.invoiceDate < DATE_SUB(UTC_DATE(), INTERVAL 30 DAY)
        ${branchFilterInv}
    `);
    const arData = (arRows as any)[0] ?? arRows;
    arRow = Array.isArray(arData) ? arData[0] : null;
  }

  // برنامج اليوم — تذكيرات AR وعدد الموعودين اليوم (يعيد استخدام getReminderQueue الذي يطبّق
  // منطق ≥٧ أيام + تبريد ٧ + وعد اليوم). العزل عبر الفرع (يمرَّر عبر opts.branchId).
  // حين branchId=null (مرتفع يرى الكل) ⇒ getReminderQueue تجمع كل الفروع — مثل بقية عدّادات
  // هذه الحمولة (lowStock/overdueAR/overdueWorkOrders). (مراجعة ٥/٧: كان `?? 1` يثبّت العدّادين
  // على الفرع ١ صامتاً فيناقض التعليق والشاشة المرتبطة.)
  //
  // ⚠️ getReminderQueue لا تُرجع الوعود المستقبلية (promisedDate > اليوم مُستبعَد) — الحقل
  // promisedToday يعدّ فقط الوعود المستحقّة اليوم (isPromiseDue=true).
  let arRemindersDue = 0;
  let promisedToday = 0;
  // عدّادا برنامج اليوم AR ماليّان (ذمم مستحقّة/موعودة) ⇒ محجوبان عن reports=NONE. الواجهة تُخفي
  // بانر برنامج اليوم أصلاً عن غير المدير، وهذا يُغلق تسريب الـAPI أيضاً (دفاع بالطبقتين).
  if (includeFinancials) try {
    const queue = await getReminderQueue({ branchId });
    arRemindersDue = queue.length;
    promisedToday = queue.filter((r) => r.isPromiseDue).length;
    // gap-audit ٥/٧ (HIGH): مدينو الرصيد الافتتاحي (قرار مالك PR #142 — أدرِجهم للمتابعة) كانوا
    // غائبين كلياً عن هذين العدّادين رغم أنهما القناتان اليوميّتان المصمَّمتان خصيصاً لهذا الغرض.
    // نضيفهم فقط حين المستدعي طلب ذلك صراحةً (includeOpeningBalance — الأدمن حصراً، مطابقةً لحصر
    // openingScope في الراوتر) وفي العرض المجمَّع فقط (لا انتماء فرعيّ لهؤلاء المدينين).
    if (opts.includeOpeningBalance && branchId == null) {
      const openingQueue = await getReminderQueue({ branchId: null, openingOnly: true });
      arRemindersDue += openingQueue.length;
      promisedToday += openingQueue.filter((r) => r.isPromiseDue).length;
    }
  } catch {
    // فشل استعلام queue لا يجب أن يُسقط لوحة التحكم — نُعيد أصفاراً وتظهر بقية البطاقات.
  }

  // أوامر شغل متأخّرة: dueDate < UTC_DATE() وحالة نشطة (لا DELIVERED/CANCELLED).
  // القيمة الافتراضية 0 حين لا مصفوفة (احتراز مبالغ فيه — الاستعلام دائماً يُرجع صفّاً).
  const woRows = await db.execute(sql`
    SELECT COUNT(*) AS c
    FROM workOrders wo
    WHERE wo.workOrderStatus NOT IN ('DELIVERED', 'CANCELLED')
      AND wo.dueDate IS NOT NULL
      AND wo.dueDate < UTC_DATE()
      ${branchFilterWo}
  `);
  const woData = (woRows as any)[0] ?? woRows;
  const overdueWorkOrders = Number(
    (Array.isArray(woData) ? woData[0]?.c : 0) ?? 0
  );

  // مهام متأخّرة (نظام المهام الموحّد S2) — تشغيليّ بنفس منزلة overdueWorkOrders (لا تقييد
  // reports)، ونفس نطاق الفرع (branchFilterTasks) المُستعمَل لبقيّة هذه البطاقة.
  const taskRows = await db.execute(sql`
    SELECT COUNT(*) AS c
    FROM tasks t
    WHERE ${TASK_OVERDUE_SQL_COND}
      ${branchFilterTasks}
  `);
  const taskData = (taskRows as any)[0] ?? taskRows;
  const overdueTasks = Number((Array.isArray(taskData) ? taskData[0]?.c : 0) ?? 0);
  const myOpenTasks = opts.userId != null ? await getMyOpenTasksCount(opts.userId) : 0;

  // نبض المبيعات: مبيعات أمس (صافي = total − returnedTotal، غير الملغاة) مقابل معدّل آخر ٧ أيام
  // مكتملة (D-7..D-1، بلا اليوم الجاري غير المكتمل). العزل عبر الفرع. avg = مجموع النافذة ÷ ٧
  // (أيام بلا مبيعات تُخفّض المعدّل — تعريف «معدّل ٧ أيام» الحرفيّ). فشل الاستعلام لا يُسقط اللوحة.
  // نبض المبيعات رقمُ إيرادٍ ⇒ محجوب عن reports=NONE. الأصفار الافتراضية تُبقي البطاقة مُخفاة على
  // الواجهة (hasBaseline=false حين avg7d=0) — مطابقةً لسلوك «لا مبيعات سابقة» القائم.
  let salesPulse: DashboardMetricsResult["salesPulse"] = {
    yesterday: toDbMoney(money(0)), avg7d: toDbMoney(money(0)), direction: "flat", changePct: 0,
  };
  if (includeFinancials) try {
    const spRows = await db.execute(sql`
      SELECT
        CAST(COALESCE(SUM(CASE WHEN i.invoiceDate >= DATE_SUB(UTC_DATE(), INTERVAL 1 DAY) AND i.invoiceDate < UTC_DATE() THEN i.total - i.returnedTotal ELSE 0 END), 0) AS CHAR) AS yday,
        CAST(COALESCE(SUM(i.total - i.returnedTotal), 0) AS CHAR) AS last7
      FROM invoices i
      WHERE i.invoiceStatus <> 'CANCELLED'
        AND i.invoiceDate >= DATE_SUB(UTC_DATE(), INTERVAL 7 DAY)
        AND i.invoiceDate < UTC_DATE()
        ${branchFilterInv}
    `);
    const spData = (spRows as any)[0] ?? spRows;
    const spRow = Array.isArray(spData) ? spData[0] : null;
    const yday = money(spRow?.yday ?? 0);
    const avg = money(spRow?.last7 ?? 0).div(7);
    let direction: "up" | "down" | "flat" = "flat";
    let changePct = 0;
    if (avg.gt(0)) {
      changePct = Math.round(yday.sub(avg).div(avg).times(100).toNumber());
      direction = changePct > 3 ? "up" : changePct < -3 ? "down" : "flat";
    }
    salesPulse = { yesterday: toDbMoney(yday), avg7d: toDbMoney(avg), direction, changePct };
  } catch {
    // فشل استعلام نبض المبيعات لا يجب أن يُسقط لوحة التحكم — نُبقي الأصفار الافتراضية.
  }

  return {
    lowStockCount,
    overdueAR: {
      count: Number(arRow?.c ?? 0),
      total: toDbMoney(money(arRow?.t ?? 0)),
    },
    salesPulse,
    morningBrief: { arRemindersDue, promisedToday, overdueWorkOrders, myOpenTasks, overdueTasks },
  };
}
