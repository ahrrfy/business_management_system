// مقاييس لوحة التحكم (بطاقات المخزون المنخفض والذمم المتأخّرة + برنامج اليوم).
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { getReminderQueue } from "../arRemindersService";

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
  opts: { branchId?: number | null } = {}
): Promise<DashboardMetricsResult> {
  const db = getDb();
  if (!db) {
    return {
      lowStockCount: 0,
      overdueAR: { count: 0, total: toDbMoney(money(0)) },
      salesPulse: { yesterday: toDbMoney(money(0)), avg7d: toDbMoney(money(0)), direction: "flat", changePct: 0 },
      morningBrief: { arRemindersDue: 0, promisedToday: 0, overdueWorkOrders: 0 },
    };
  }
  const branchId = opts.branchId ?? null;
  const branchFilterStock = branchId == null ? sql`` : sql`AND bs.branchId = ${branchId}`;
  const branchFilterInv = branchId == null ? sql`` : sql`AND i.branchId = ${branchId}`;
  const branchFilterWo = branchId == null ? sql`` : sql`AND wo.branchId = ${branchId}`;

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
  const arRow = Array.isArray(arData) ? arData[0] : null;

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
  try {
    const queue = await getReminderQueue({ branchId });
    arRemindersDue = queue.length;
    promisedToday = queue.filter((r) => r.isPromiseDue).length;
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

  // نبض المبيعات: مبيعات أمس (صافي = total − returnedTotal، غير الملغاة) مقابل معدّل آخر ٧ أيام
  // مكتملة (D-7..D-1، بلا اليوم الجاري غير المكتمل). العزل عبر الفرع. avg = مجموع النافذة ÷ ٧
  // (أيام بلا مبيعات تُخفّض المعدّل — تعريف «معدّل ٧ أيام» الحرفيّ). فشل الاستعلام لا يُسقط اللوحة.
  let salesPulse: DashboardMetricsResult["salesPulse"] = {
    yesterday: toDbMoney(money(0)), avg7d: toDbMoney(money(0)), direction: "flat", changePct: 0,
  };
  try {
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
    morningBrief: { arRemindersDue, promisedToday, overdueWorkOrders },
  };
}
