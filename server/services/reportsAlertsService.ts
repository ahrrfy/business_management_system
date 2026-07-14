// مركز تنبيهات الإدارة (للقراءة فقط) — قلب كوكبِت «النظرة العامة».
//
// يحوّل التقارير من «عرض» إلى «قائمة متابعة»: كل تنبيه = خطر + رقم + مبلغ + وجهة فعل.
// aggregator واحد يجمع إشارات من جداول/خدمات موجودة في استدعاء واحد معزول بالفرع (أداء أفضل من
// عدّة استعلامات في الواجهة). التنبيهات الصفرية تُحذف، والقائمة تُرتَّب بالخطورة.
//
// ⚠️ أسماء أعمدة DB الخام: invoices.invoiceStatus · shifts.shiftStatus · workOrders.workOrderStatus.
// مرساة «اليوم» UTC_DATE() (نظير بقيّة التقارير). كل الأموال نصّاً decimal (§٥).
import { sql } from "drizzle-orm";
import { getDb } from "../db";
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

/** YYYY-MM-DD من مكوّنات محلية (نمط dateRange — لا toISOString كي لا ينزاح اليوم قرب منتصف الليل). */
function localYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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
}

const SEV_ORDER: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * يبني قائمة تنبيهات الإدارة المعزولة بالفرع. `isAdmin` يُفعّل تنبيه انحراف reconcile (admin فقط).
 * كل مصدر مستقلّ ⇒ يُشغَّل بالتوازي. أي مصدر يفشل لا يُسقط الكوكبِت (يُتجاوز بصمت).
 */
export async function getManagementAlerts(opts: {
  branchId?: number;
  isAdmin?: boolean;
}): Promise<ManagementAlertsResult> {
  const db = getDb();
  const generatedAt = new Date().toISOString();
  if (!db) return { alerts: [], generatedAt };
  const branchId = opts.branchId;
  const branchInv = branchId ? sql`AND i.branchId = ${branchId}` : sql``;
  const branchWo = branchId ? sql`AND wo.branchId = ${branchId}` : sql``;
  const branchShift = branchId ? sql`AND s.branchId = ${branchId}` : sql``;

  const alerts: AlertItem[] = [];
  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try { return await p; } catch { return fallback; }
  };

  // ── (أ) أعمار الذمم المدينة: شرائح 31-60 / 61-90 / +90 (عدد عملاء + مبلغ لكل شريحة) ──
  const arP = safe(
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
  const stockP = safe(getStockStatus({ branchId, onlyAlerts: true, limit: 1 }), { rows: [], totals: { outCount: 0, lowCount: 0 } });

  // ── (ج) التعرّض الائتماني: المتجاوزون للحدّ ──
  const creditP = safe(getCreditExposure({ branchId }), null);

  // ── (د) فروقات الصندوق: ورديات مُغلقة (آخر ٣٠ يوماً) بفرق غير صفري ──
  const shiftP = safe(
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

  // ── (هـ) أوامر شغل متأخرة (تجاوزت أجل التسليم ولم تُسلَّم) ──
  const woP = safe(
    db.execute(sql`
      SELECT COUNT(*) AS cnt
      FROM workOrders wo
      WHERE wo.workOrderStatus IN ('RECEIVED', 'IN_PROGRESS', 'READY')
        AND wo.dueDate IS NOT NULL AND wo.dueDate < UTC_DATE()
        ${branchWo}
    `),
    null,
  );

  // ── (و) ذمم الموردين الدائنة (لنا عليهم نقد مستحقّ) — رصيد موجب ──
  const apP = safe(
    db.execute(sql`
      SELECT COUNT(*) AS cnt, CAST(COALESCE(SUM(currentBalance), 0) AS CHAR) AS total
      FROM suppliers
      WHERE isActive = TRUE AND currentBalance > 0
    `),
    null,
  );

  // ── (ز) مخزون راكد بقيمة عالية (لا بيع منذ ٩٠ يوماً، رصيد موجب) ──
  const branchStk = branchId ? sql`AND bs.branchId = ${branchId}` : sql``;
  const branchSale = branchId ? sql`AND i.branchId = ${branchId}` : sql``;
  const deadP = safe(
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
    const today = new Date();
    const weekAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
    return safe(getAnomalyWatch({ from: localYmd(weekAgo), to: localYmd(today), branchId }), null);
  })();

  // ── (ح) انحراف أرصدة (reconcile) — admin فقط ──
  const reconP = opts.isAdmin
    ? safe(
        Promise.all([reconcileCustomerBalances(), reconcileSupplierBalances(), reconcileInventory(), reconcileLedgerProfit()]),
        null,
      )
    : Promise.resolve(null);

  const [arRes, stockRes, creditRes, shiftRes, woRes, apRes, deadRes, reconRes, anomalyRes] = await Promise.all([
    arP, stockP, creditP, shiftP, woP, apP, deadP, reconP, anomalyP,
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
  if (wo && Number(wo.cnt ?? 0) > 0) {
    alerts.push({ key: "wo-late", severity: "warning", title: "أوامر شغل تجاوزت أجل التسليم", count: Number(wo.cnt), amount: null, href: "/reports/work-orders", actionLabel: "أوامر الشغل" });
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
  return { alerts, generatedAt };
}
