// مركز تنبيهات الإدارة (للقراءة فقط) — قلب كوكبِت «النظرة العامة».
//
// يحوّل التقارير من «عرض» إلى «قائمة متابعة»: كل تنبيه = خطر + رقم + مبلغ + وجهة فعل.
// aggregator واحد يجمع إشارات من جداول/خدمات موجودة في استدعاء واحد معزول بالفرع (أداء أفضل من
// عدّة استعلامات في الواجهة). التنبيهات الصفرية تُحذف، والقائمة تُرتَّب بالخطورة.
//
// ⚠️ أسماء أعمدة DB الخام: invoices.invoiceStatus · shifts.shiftStatus · workOrders.workOrderStatus
// · deliveryConsignments.consignmentStatus (خاصية Drizzle اسمها `status` — راجع [[raw-sql-column-names]]).
// مرساة «اليوم» UTC_DATE() (نظير بقيّة التقارير). كل الأموال نصّاً decimal (§٥).
import { sql } from "drizzle-orm";
import { DELIVERY_AGE_DANGER_HOURS } from "@shared/deliveryAging";
import { getDb } from "../db";
import { createTtlCache } from "../lib/ttlCache";
import { getCurrentCompanyId } from "../tenancy/context";
import { toDbMoney, money } from "./money";
import { getStockStatus } from "./reportsInventoryService";
import { getCreditExposure } from "./reportsCreditExposureService";
import {
  reconcileCustomerBalances,
  reconcileSupplierBalances,
  reconcileInventory,
  reconcileLedgerProfit,
} from "./reconcileService";
import { getAnomalyWatch } from "./reports/anomalyWatch";
import { getAPAging } from "./reports/apAging";
import { todayUtcDate, utcTodayStart } from "./businessDay";

function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

export type AlertSeverity = "critical" | "warning" | "info";

export interface AlertItem {
  /** مفتاح فريد للتنبيه (لـkey في React). */
  key: string;
  severity: AlertSeverity;
  /** نصّ التنبيه (يحوي السياق؛ الرقم/المبلغ يُعرَضان منفصلَين في الواجهة). */
  title: string;
  /** العدد المعنيّ (عملاء/أصناف/أوامر…). */
  count: number;
  /** مبلغ مرتبط (decimal نصّاً) أو null. */
  amount: string | null;
  /** وجهة الفعل (مسار داخلي). */
  href: string;
  /** نصّ زرّ الفعل. */
  actionLabel: string;
}

export interface ManagementAlertsResult {
  alerts: AlertItem[];
  generatedAt: string;
  sourceErrors: string[];
}

const SEV_ORDER: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * كاش قصير أحادي الرحلة (فحص الحمل ٣٠/٨/٢٦): الحساب أدناه يطلق ~30-40 استعلاماً شبه متزامن
 * (أثقل قارئ في النظام كلّه)، ومدخلاته (branchId، isAdmin) لا شيء شخصيّ فيها ⇒ مديران يفتحان
 * «النظرة العامة» معاً كانا يضاعفان الانفجار بلا أي فائدة. TTL 30 ثانية يوازن حداثة التنبيهات
 * (الواجهة أصلاً staleTime=60s) مع حماية مجمّع الاتصالات؛ والرحلة الواحدة تجمع المتزامنين.
 * المفتاح يتضمّن companyId درءاً لتسريبٍ بين الشركات إن فُعِّل تعدّدها يوماً.
 *
 * قرار مقصود (مراجعة عدائية ٣٠/٨): نتيجةٌ فيها sourceErrors **تُكيَّش أيضاً** — التدهور
 * معلَنٌ داخلها بصفّ تنبيهٍ حرِج ظاهرٍ للمدير، وعدمُ كيّشها كان سيعيد إطلاق انفجار الاستعلامات
 * الأربعين تحديداً لحظةَ العجز عنه (thundering herd على مصدرٍ فاشل).
 */
const MANAGEMENT_ALERTS_TTL_MS = 30_000;
const managementAlertsCache = createTtlCache<string, ManagementAlertsResult>({
  ttlMs: MANAGEMENT_ALERTS_TTL_MS,
  maxEntries: 40,
});

export async function getManagementAlerts(opts: {
  branchId?: number;
  isAdmin?: boolean;
}): Promise<ManagementAlertsResult> {
  // الاختبارات تتحقّق من محتوى التنبيهات بعد كتاباتها مباشرةً — الكاش يعمى عنها.
  if (process.env.NODE_ENV === "test") return computeManagementAlerts(opts);
  const key = `${getCurrentCompanyId() ?? 0}:${opts.branchId ?? 0}:${opts.isAdmin === true}`;
  return managementAlertsCache.get(key, () => computeManagementAlerts(opts));
}

/**
 * يبني قائمة تنبيهات الإدارة المعزولة بالفرع. `isAdmin` يُفعّل تنبيه انحراف reconcile (admin فقط).
 * كل مصدر مستقلّ ⇒ يُشغَّل بالتوازي. أي مصدر يفشل لا يُسقط الكوكبِت (يُتجاوز بصمت).
 */
async function computeManagementAlerts(opts: {
  branchId?: number;
  isAdmin?: boolean;
}): Promise<ManagementAlertsResult> {
  const db = getDb();
  const generatedAt = new Date().toISOString();
  if (!db) return { alerts: [], generatedAt, sourceErrors: ["database"] };
  const branchId = opts.branchId;
  const branchInv = branchId ? sql`AND i.branchId = ${branchId}` : sql``;
  const branchWo = branchId ? sql`AND wo.branchId = ${branchId}` : sql``;
  const branchShift = branchId ? sql`AND s.branchId = ${branchId}` : sql``;

  const alerts: AlertItem[] = [];
  const sourceErrors: string[] = [];
  let sourceFailureCount = 0;
  const safe = async <T>(source: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch {
      sourceErrors.push(source);
      sourceFailureCount += 1;
      alerts.push({
        key: `report-source-failure-${sourceFailureCount}`,
        severity: "critical",
        title: "تعذّر التحقق من مصدر مالي — النتائج أدناه غير مكتملة",
        count: 1,
        amount: null,
        href: "/reports/tools",
        actionLabel: "فحص سلامة التقارير",
      });
      return fallback;
    }
  };

  // ── (أ) أعمار الذمم المدينة: شرائح 31-60 / 61-90 / +90 (عدد عملاء + مبلغ لكل شريحة) ──
  const arP = safe(
    "receivablesAging",
    db.execute(sql`
      SELECT
        CAST(COALESCE(SUM(CASE WHEN bucket = 'd31_60' THEN amt ELSE 0 END), 0) AS CHAR) AS a31,
        SUM(CASE WHEN bucket = 'd31_60' THEN 1 ELSE 0 END) AS c31,
        CAST(COALESCE(SUM(CASE WHEN bucket = 'd61_90' THEN amt ELSE 0 END), 0) AS CHAR) AS a61,
        SUM(CASE WHEN bucket = 'd61_90' THEN 1 ELSE 0 END) AS c61,
        CAST(COALESCE(SUM(CASE WHEN bucket = 'd91p' THEN amt ELSE 0 END), 0) AS CHAR) AS a91,
        SUM(CASE WHEN bucket = 'd91p' THEN 1 ELSE 0 END) AS c91
      FROM (
        SELECT i.customerId,
          CASE
            WHEN MAX(DATEDIFF(UTC_DATE(), DATE(COALESCE(i.dueDate, i.invoiceDate)))) > 90 THEN 'd91p'
            WHEN MAX(DATEDIFF(UTC_DATE(), DATE(COALESCE(i.dueDate, i.invoiceDate)))) BETWEEN 61 AND 90 THEN 'd61_90'
            WHEN MAX(DATEDIFF(UTC_DATE(), DATE(COALESCE(i.dueDate, i.invoiceDate)))) BETWEEN 31 AND 60 THEN 'd31_60'
            ELSE 'cur'
          END AS bucket,
          SUM(GREATEST(i.total - i.paidAmount - i.returnedTotal, 0)) AS amt
        FROM invoices i
        WHERE i.invoiceStatus IN ('PENDING', 'PARTIALLY_PAID')
          AND i.customerId IS NOT NULL
          ${branchInv}
        GROUP BY i.customerId
        HAVING amt > 0
      ) t
    `),
    null,
  );

  // ── (ب) المخزون: نفد / منخفض ──
  const stockP = safe("stockStatus", getStockStatus({ branchId, onlyAlerts: true, limit: 1 }), { rows: [], totals: { outCount: 0, lowCount: 0 } });

  // ── (ج) التعرّض الائتماني: المتجاوزون للحدّ ──
  const creditP = safe("creditExposure", getCreditExposure({ branchId }), null);

  // ── (د) فروقات الصندوق: ورديات مُغلقة (آخر ٣٠ يوماً) بفرق غير صفري ──
  const shiftP = safe(
    "shiftVariance",
    db.execute(sql`
      SELECT COUNT(*) AS cnt, CAST(COALESCE(SUM(ABS(s.variance)), 0) AS CHAR) AS total
      FROM shifts s
      WHERE s.shiftStatus = 'CLOSED'
        AND s.variance IS NOT NULL AND ABS(s.variance) > 0
        AND s.closedAt >= DATE_SUB(UTC_DATE(), INTERVAL 30 DAY)
        ${branchShift}
    `),
    null,
  );

  // ── (هـ) طوابير أوامر الشغل — أربعةُ أعطالٍ تشغيلية في استعلامٍ واحد ──
  //
  // ش٦ (١٩/٨): «متأخّرة» وحدها كانت تُقاس — وهي **آخرُ** ما يظهر. الطوابيرُ الثلاثة الجديدة
  // تُمسِك العطبَ **قبل** أن يصير تأخّراً، وكلٌّ منها كان أعمى تماماً:
  //   · **بلا منفّذ**: أمرٌ لم يسحبه أحد. لا شاشةَ تسأل عنه ⇒ يُكتشَف يوم يتأخّر.
  //   · **بانتظار موافقة العميل**: التنفيذ محجوزٌ بمهمّةٍ حاجزة (ش٢) — الانتظارُ مشروع، لكن
  //     نسيانَه ليس كذلك؛ والعدّاد يُجمّد SLA فلا يظهر في «متأخّرة» أبداً.
  //   · **لم يحضر أصحابها**: جاهزٌ منذ أسبوعٍ فأكثر. لحظةُ الجاهزية **مشتقّة**
  //     (`workStartedAt + workSeconds`) لا عمود — نفس اشتقاق فلتر `awaitingPickupDays`.
  // ٢٢/٨ — كذبُ «لم يحضر أصحابها»/«متأخّرة»: الأمر يبقى `READY` والطردُ خارجٌ مع مندوب فعلاً
  // (الإرسالية الحيّة هي الحقيقة — نفس استبعاد `listReadyForDispatch` في delivery/queries.ts):
  // كان التنبيه يأمر الموظّف «اتّصل بالعميل ليحضر» لطردٍ في الطريق إليه. الاستبعاد بالإرسالية
  // **الحيّة** وحدها (لا CANCELLED/RETURNED) كي يعود الملغى إسنادُه إلى التنبيه لا يختفي منه.
  const woLiveCn = sql`NOT EXISTS (
              SELECT 1 FROM deliveryConsignments dc
              WHERE dc.workOrderId = wo.id
                AND dc.consignmentStatus NOT IN ('CANCELLED','RETURNED')
            )`;
  const woP = safe(
    "workOrders",
    db.execute(sql`
      SELECT
        SUM(CASE WHEN wo.workOrderStatus IN ('RECEIVED','IN_PROGRESS','READY')
                  AND wo.dueDate IS NOT NULL AND wo.dueDate < UTC_DATE()
                  AND ${woLiveCn} THEN 1 ELSE 0 END) AS cnt,
        SUM(CASE WHEN wo.workOrderStatus IN ('RECEIVED','IN_PROGRESS')
                  AND wo.assignedTo IS NULL THEN 1 ELSE 0 END) AS unassigned,
        SUM(CASE WHEN wo.workOrderStatus IN ('RECEIVED','IN_PROGRESS') AND EXISTS (
              SELECT 1 FROM tasks t
              INNER JOIN serviceTypes st ON st.id = t.serviceTypeId
              WHERE t.linkedWorkOrderId = wo.id
                AND t.taskStatus IN ('NEW','IN_PROGRESS','WAITING_CUSTOMER')
                AND st.blocksExecution = 1
            ) THEN 1 ELSE 0 END) AS awaitingApproval,
        SUM(CASE WHEN wo.workOrderStatus = 'READY'
                  AND wo.workStartedAt IS NOT NULL AND wo.workSeconds IS NOT NULL
                  AND DATE_ADD(wo.workStartedAt, INTERVAL wo.workSeconds SECOND)
                      < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)
                  AND ${woLiveCn} THEN 1 ELSE 0 END) AS awaitingPickup
      FROM workOrders wo
      WHERE wo.workOrderStatus <> 'CANCELLED'
        ${branchWo}
    `),
    null,
  );

  // ── (ي) التوصيل — ثلاثُ إشاراتٍ كانت عمياء كلّياً (٢٢/٨: ٧٩/٨٤ طرداً جامداً ٩-١٣ يوماً
  //      ولا تنبيهَ واحداً). العتبة من `shared/deliveryAging` — نفسُ سلّم الشاشة والكنّاس. ──
  const branchCn = branchId ? sql`AND dc.branchId = ${branchId}` : sql``;
  // متعثّرة: حيّة، لم يُعلَن رجوعُها، وتجاوزت عتبة الخطر. التعرّض = المتبقّي الحيّ للإرسالية
  // (codAmount − collectedAmount − counterSettledAmount مقصوصاً عند صفر — سداد الكاونتر ليس بيد الجهة).
  const deliveryStuckP = safe(
    "deliveryStuck",
    db.execute(sql`
      SELECT COUNT(*) AS cnt,
        CAST(COALESCE(SUM(GREATEST(
          CAST(dc.codAmount AS DECIMAL(15,2))
          - CAST(dc.collectedAmount AS DECIMAL(15,2))
          - CAST(dc.counterSettledAmount AS DECIMAL(15,2)), 0)), 0) AS CHAR) AS total
      FROM deliveryConsignments dc
      WHERE dc.consignmentStatus = 'DISPATCHED'
        AND dc.returnDeclaredAt IS NULL
        AND TIMESTAMPDIFF(HOUR, dc.dispatchedAt, NOW()) >= ${DELIVERY_AGE_DANGER_HOURS}
        ${branchCn}
    `),
    null,
  );
  // مرتجعٌ مُعلَن لم يُستلَم: تعرّضه حُرِّر في الدفتر لحظة الإعلان (COD_RELEASED) لكنّ البضاعة
  // نفسها ما زالت خارج المخزون — نسيانُها خسارةُ بضاعةٍ صامتة لا خسارةَ نقد.
  const deliveryReturnPendingP = safe(
    "deliveryReturnPending",
    db.execute(sql`
      SELECT COUNT(*) AS cnt
      FROM deliveryConsignments dc
      WHERE dc.consignmentStatus = 'DISPATCHED'
        AND dc.returnDeclaredAt IS NOT NULL
        AND dc.returnDeclaredAt <= DATE_SUB(NOW(), INTERVAL 3 DAY)
        ${branchCn}
    `),
    null,
  );
  // أجور توصيل مستحقّة غير مدفوعة: رصيد دفتر التوصيل لكل جهة (FEE_EARNED − REFUNDED − PAID/OFFSET)
  // الموجب. أجرة COURIER تتصفّر لحظتها بقيد FEE_PAID المباشر ⇒ الرصيد الموجب هو ذممُ SHOP فعلياً
  // (نفس معادلة feeDue في delivery/queries.ts — تجميعٌ واحد لكل الجهات دفعةً). قيود قديمة بلا
  // branchId تسقط من منظور مدير الفرع عمداً (لا تُنسَب لفرعٍ لا تخصّه).
  const branchLed = branchId ? sql`AND l.branchId = ${branchId}` : sql``;
  const deliveryFeesDueP = safe(
    "deliveryFeesDue",
    db.execute(sql`
      SELECT COUNT(*) AS cnt, CAST(COALESCE(SUM(t.due), 0) AS CHAR) AS total
      FROM (
        SELECT l.partyId,
          SUM(CASE
            WHEN l.entryType = 'FEE_EARNED' THEN l.amount
            WHEN l.entryType IN ('FEE_PAID','FEE_OFFSET','FEE_REFUNDED') THEN -l.amount
            ELSE 0 END) AS due
        FROM deliveryLedgerEntries l
        WHERE l.entryType IN ('FEE_EARNED','FEE_PAID','FEE_OFFSET','FEE_REFUNDED')
          ${branchLed}
        GROUP BY l.partyId
        HAVING due > 0
      ) t
    `),
    null,
  );

  // ── (و) ذمم الموردين الدائنة (لنا عليهم نقد مستحقّ) — رصيد موجب ──
  const apP = safe(
    "supplierPayables",
    getAPAging({ branchId, limit: 10_000 }).then((rows) => {
      // Preserve the company-wide decision's canonical supplier balance while
      // using branch-attributable PO ledger balances for a scoped manager.
      // Supplier.currentBalance has no branch dimension and must never be
      // serialized into a branch-scoped alert.
      const amountOf = (row: (typeof rows)[number]) =>
        money(branchId == null ? row.currentBalance : row.unpaidTotal);
      const payable = rows.filter((row) => amountOf(row).gt(0));
      const total = payable.reduce((sum, row) => sum.plus(amountOf(row)), money(0));
      return [[{ cnt: payable.length, total: toDbMoney(total) }]];
    }),
    null,
  );

  // ── (ز) مخزون راكد بقيمة عالية (لا بيع منذ ٩٠ يوماً، رصيد موجب) ──
  const branchStk = branchId ? sql`AND bs.branchId = ${branchId}` : sql``;
  const branchSale = branchId ? sql`AND i.branchId = ${branchId}` : sql``;
  const deadP = safe(
    "deadStock",
    db.execute(sql`
      SELECT COUNT(*) AS cnt, CAST(COALESCE(SUM(t.val), 0) AS CHAR) AS total
      FROM (
        SELECT v.id, COALESCE(stk.qty, 0) * v.costPrice AS val
        FROM productVariants v
        LEFT JOIN (
          SELECT bs.variantId, SUM(bs.quantity) AS qty
          FROM branchStock bs WHERE 1 = 1 ${branchStk} GROUP BY bs.variantId
        ) stk ON stk.variantId = v.id
        LEFT JOIN (
          SELECT ii.variantId, MAX(i.invoiceDate) AS lastSale
          FROM invoiceItems ii
          JOIN invoices i ON i.id = ii.invoiceId AND i.invoiceStatus NOT IN ('CANCELLED', 'RETURNED') ${branchSale}
          GROUP BY ii.variantId
        ) sa ON sa.variantId = v.id
        WHERE v.isActive = TRUE AND COALESCE(stk.qty, 0) > 0
          AND (sa.lastSale IS NULL OR DATEDIFF(UTC_DATE(), DATE(sa.lastSale)) >= 90)
      ) t
      WHERE t.val > 0
    `),
    null,
  );

  // ── (ط) رقيب الشذوذ — مؤشرات آخر ٧ أيام (دون الكلفة/خصومات/مرتجعات/عجوزات/عكوس/تسلسل) ──
  const anomalyP = (() => {
    // نافذة آخر ٧ أيام بحدود UTC حتميّة (تدقيق ١٧/٧، #٧) — كان البناء بمكوّناتٍ محلية يَنزاح على غير TZ=UTC.
    const todayYmd = todayUtcDate();
    const weekAgoYmd = new Date(utcTodayStart().getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
    return safe("anomalyWatch", getAnomalyWatch({ from: weekAgoYmd, to: todayYmd, branchId }), null);
  })();

  // ── (ح) انحراف أرصدة (reconcile) — admin فقط ──
  const reconP = opts.isAdmin
    ? safe(
        "reconciliation",
        Promise.all([reconcileCustomerBalances(), reconcileSupplierBalances(), reconcileInventory(), reconcileLedgerProfit()]),
        null,
      )
    : Promise.resolve(null);

  const [arRes, stockRes, creditRes, shiftRes, woRes, apRes, deadRes, reconRes, anomalyRes, stuckRes, returnPendingRes, feesDueRes] = await Promise.all([
    arP, stockP, creditP, shiftP, woP, apP, deadP, reconP, anomalyP, deliveryStuckP, deliveryReturnPendingP, deliveryFeesDueP,
  ]);

  // (أ) أعمار الذمم — ثلاث شرائح، الأقدم أخطر.
  const ar = arRes ? rowsOf(arRes)[0] : null;
  if (ar) {
    const c91 = Number(ar.c91 ?? 0);
    if (c91 > 0) alerts.push({ key: "ar-90", severity: "critical", title: "عملاء متأخّرون أكثر من ٩٠ يوماً", count: c91, amount: toDbMoney(money(ar.a91 ?? 0)), href: "/reports/aging-hub", actionLabel: "أعمار الذمم" });
    const c61 = Number(ar.c61 ?? 0);
    if (c61 > 0) alerts.push({ key: "ar-60", severity: "warning", title: "عملاء متأخّرون ٦١–٩٠ يوماً", count: c61, amount: toDbMoney(money(ar.a61 ?? 0)), href: "/reports/aging-hub", actionLabel: "أعمار الذمم" });
    const c31 = Number(ar.c31 ?? 0);
    if (c31 > 0) alerts.push({ key: "ar-30", severity: "warning", title: "عملاء متأخّرون ٣١–٦٠ يوماً", count: c31, amount: toDbMoney(money(ar.a31 ?? 0)), href: "/reports/aging-hub", actionLabel: "أعمار الذمم" });
  }

  // (ج) التعرّض الائتماني — تجاوز الحدّ.
  if (creditRes && creditRes.summary.overLimitCount > 0) {
    alerts.push({
      key: "credit-overlimit",
      severity: "critical",
      title: "عملاء تجاوزوا حدّ الائتمان",
      count: creditRes.summary.overLimitCount,
      amount: creditRes.summary.overLimitAmount,
      href: "/reports/credit-exposure",
      actionLabel: "التعرّض الائتماني",
    });
  }

  // (ب) المخزون — نفد / منخفض.
  if (stockRes && stockRes.totals.outCount > 0) {
    alerts.push({ key: "stock-out", severity: "critical", title: "أصناف نفدت من المخزون", count: stockRes.totals.outCount, amount: null, href: "/reports/stock-status", actionLabel: "حالة المخزون" });
  }
  if (stockRes && stockRes.totals.lowCount > 0) {
    alerts.push({ key: "stock-low", severity: "warning", title: "أصناف شارفت على النفاد", count: stockRes.totals.lowCount, amount: null, href: "/reports/stock-status", actionLabel: "إعادة الطلب" });
  }

  // (د) فروقات الصندوق.
  const sh = shiftRes ? rowsOf(shiftRes)[0] : null;
  if (sh && Number(sh.cnt ?? 0) > 0) {
    alerts.push({ key: "shift-variance", severity: "warning", title: "فروقات صندوق غير مُسوّاة (آخر ٣٠ يوماً)", count: Number(sh.cnt), amount: toDbMoney(money(sh.total ?? 0)), href: "/shifts", actionLabel: "الورديات" });
  }

  // (هـ) أوامر شغل متأخرة.
  const wo = woRes ? rowsOf(woRes)[0] : null;
  if (wo) {
    const unassigned = Number(wo.unassigned ?? 0);
    if (unassigned > 0) {
      alerts.push({ key: "wo-unassigned", severity: "critical", title: "أوامر شغل بلا منفّذ", count: unassigned, amount: null, href: "/work-orders", actionLabel: "أسنِدها الآن" });
    }
    const awaitingApproval = Number(wo.awaitingApproval ?? 0);
    if (awaitingApproval > 0) {
      alerts.push({ key: "wo-awaiting-approval", severity: "warning", title: "أوامر محجوزة بانتظار موافقة العميل", count: awaitingApproval, amount: null, href: "/tasks", actionLabel: "تابع الموافقات" });
    }
    const awaitingPickup = Number(wo.awaitingPickup ?? 0);
    if (awaitingPickup > 0) {
      alerts.push({ key: "wo-awaiting-pickup", severity: "warning", title: "طلبات جاهزة لم يحضر أصحابها (أكثر من ٧ أيام)", count: awaitingPickup, amount: null, href: "/work-orders", actionLabel: "اتّصل بالعملاء" });
    }
  }
  if (wo && Number(wo.cnt ?? 0) > 0) {
    alerts.push({ key: "wo-late", severity: "warning", title: "أوامر شغل تجاوزت أجل التسليم", count: Number(wo.cnt), amount: null, href: "/reports/work-orders", actionLabel: "أوامر الشغل" });
  }

  // (ي) التوصيل — متعثّر / مرتجع منتظَر / أجور مستحقّة.
  const stuck = stuckRes ? rowsOf(stuckRes)[0] : null;
  if (stuck && Number(stuck.cnt ?? 0) > 0) {
    alerts.push({
      key: "delivery-stuck",
      severity: "critical",
      title: `طرود توصيل بلا حسم منذ أكثر من ${DELIVERY_AGE_DANGER_HOURS} ساعة — المبلغ تعرّضها المتبقّي`,
      count: Number(stuck.cnt),
      amount: toDbMoney(money(stuck.total ?? 0)),
      href: "/delivery?tab=transit",
      actionLabel: "قيد التوصيل",
    });
  }
  const retPending = returnPendingRes ? rowsOf(returnPendingRes)[0] : null;
  if (retPending && Number(retPending.cnt ?? 0) > 0) {
    alerts.push({
      key: "delivery-return-pending",
      severity: "warning",
      title: "مرتجعات توصيل مُعلَنة لم تُستلَم منذ أكثر من ٣ أيام",
      count: Number(retPending.cnt),
      amount: null,
      href: "/delivery?tab=transit",
      actionLabel: "استلام المرتجعات",
    });
  }
  const feesDue = feesDueRes ? rowsOf(feesDueRes)[0] : null;
  if (feesDue && Number(feesDue.cnt ?? 0) > 0) {
    alerts.push({
      key: "delivery-fees-due",
      severity: "info",
      title: "جهات توصيل لها أجور مستحقّة غير مدفوعة",
      count: Number(feesDue.cnt),
      amount: toDbMoney(money(feesDue.total ?? 0)),
      href: "/delivery?tab=settle",
      actionLabel: "تسوية المناديب",
    });
  }

  // (ز) مخزون راكد عالي القيمة.
  const dead = deadRes ? rowsOf(deadRes)[0] : null;
  if (dead && Number(dead.cnt ?? 0) > 0) {
    alerts.push({ key: "dead-stock", severity: "info", title: "أصناف راكدة (لا بيع +٩٠ يوماً) تجمّد رأس المال", count: Number(dead.cnt), amount: toDbMoney(money(dead.total ?? 0)), href: "/reports/inventory-ops", actionLabel: "المخزون الراكد" });
  }

  // (و) مستحقّات الموردين.
  const ap = apRes ? rowsOf(apRes)[0] : null;
  if (ap && Number(ap.cnt ?? 0) > 0) {
    alerts.push({ key: "ap-due", severity: "info", title: "موردون مستحقّون (دائنون لنا)", count: Number(ap.cnt), amount: toDbMoney(money(ap.total ?? 0)), href: "/ap-aging", actionLabel: "أعمار الموردين" });
  }

  // (ط) رقيب الشذوذ — عدّ المؤشرات النشطة؛ حرج عند عبثٍ بالتسلسل أو بيعٍ دون الكلفة.
  if (anomalyRes) {
    const k = anomalyRes.kpis;
    const indicators =
      (k.belowCostLines > 0 ? 1 : 0) +
      (k.flaggedDiscountCashiers > 0 ? 1 : 0) +
      (k.flaggedReturnSellers > 0 ? 1 : 0) +
      (k.flaggedShortageCashiers > 0 ? 1 : 0) +
      (k.reversedVouchers > 0 ? 1 : 0) +
      (k.sequenceGapDays > 0 ? 1 : 0);
    if (indicators > 0) {
      alerts.push({
        key: "anomaly-watch",
        severity: k.sequenceGapDays > 0 || k.belowCostLines > 0 ? "critical" : "warning",
        title: "مؤشرات شذوذ (آخر ٧ أيام): بيع دون الكلفة/خصومات/مرتجعات/عجوزات",
        count: indicators,
        amount: money(k.belowCostLoss).gt(0) ? k.belowCostLoss : null,
        href: "/reports/anomaly-watch",
        actionLabel: "رقيب الشذوذ",
      });
    }
  }

  // (ح) انحراف reconcile — admin فقط.
  if (reconRes) {
    const [cust, supp, inv, ledg] = reconRes;
    const driftCount = (cust?.length ?? 0) + (supp?.length ?? 0) + (inv?.length ?? 0) + (ledg?.length ?? 0);
    if (driftCount > 0) {
      alerts.push({ key: "reconcile-drift", severity: "info", title: "انحراف في الأرصدة/المخزون/الدفتر (تدقيق التوافق)", count: driftCount, amount: null, href: "/reconcile", actionLabel: "تدقيق التوافق" });
    }
  }

  alerts.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  return { alerts, generatedAt, sourceErrors };
}
