// خدمة تقارير الإنتاج وأوامر الشغل (للقراءة فقط) — تُغذّي مركز التقارير. لا تخمين.
// المصدر: جداول الإنتاج productionOrders + أوامر الشغل workOrders (drizzle/schema.ts).
//
// ⚠️ أعمدة DB الخام (الوسيط الأول لـmysqlEnum/الحقل) — تحقّق من drizzle/schema.ts:
//  • productionOrders.status ⇒ العمود `productionStatus` (CONFIRMED/CANCELLED). أعمدة الكلفة الفعلية:
//    materialsCost (كلفة المدخلات/المواد)، laborCost (العمالة)، abnormalLoss (الهدر غير الطبيعي = WASTAGE)،
//    totalCost (إجمالي الكلفة المُمتصّة = قيمة المخرجات المنتجة). لا يوجد عمود totalOutputsCost منفصل ⇒
//    outputsCost = totalCost (قيمة المخرجات = الكلفة الكلّية المُوزَّعة عليها). باقي: docNumber/branchId/createdAt.
//  • workOrders.status ⇒ العمود `workOrderStatus` (RECEIVED/IN_PROGRESS/READY/DELIVERED/CANCELLED).
//    receptionChannel/salePrice/materialsCost/laborCost/branchId/customerId/createdAt/deliveredAt.
//  • التصفية الزمنية على DATE(createdAt) BETWEEN from AND to (createdAt عمود timestamp ⇒ DATE() يثبّت اليوم).
//  • كل الأموال عبر decimal.js + money/toDbMoney — ممنوع parseFloat/Number على المال.
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";

/** فكّ نتيجة mysql2 (الصفوف في الفهرس 0). */
function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

/* ============================ ١) تقرير الإنتاج (مستندات الإنتاج المؤكَّدة) ============================ */

export interface ProductionReportRow {
  id: number;
  docNumber: string | null;
  date: string; // YYYY-MM-DD
  branchName: string | null;
  inputsCost: string; // كلفة المدخلات/المواد (materialsCost)
  laborCost: string; // العمالة
  wasteCost: string; // الهدر غير الطبيعي (abnormalLoss)
  outputsCost: string; // قيمة المخرجات المنتجة (= totalCost)
  totalCost: string; // إجمالي الكلفة
}

export interface ProductionReportResult {
  rows: ProductionReportRow[];
  totals: {
    count: number;
    inputsCost: string;
    laborCost: string;
    wasteCost: string;
    outputsCost: string;
    totalCost: string;
  };
}

export async function getProductionReport(opts: {
  from: string;
  to: string;
  branchId?: number;
}): Promise<ProductionReportResult> {
  const db = getDb();
  const empty: ProductionReportResult = {
    rows: [],
    totals: { count: 0, inputsCost: "0", laborCost: "0", wasteCost: "0", outputsCost: "0", totalCost: "0" },
  };
  if (!db) return empty;

  const branchPo = opts.branchId ? sql`AND po.branchId = ${opts.branchId}` : sql``;

  // مستندات الإنتاج المؤكَّدة (CONFIRMED) ضمن النطاق. الأحدث أولاً.
  // outputsCost = po.totalCost (لا عمود منفصل لقيمة المخرجات؛ الكلفة الكلّية تُوزَّع كاملةً على المخرجات).
  const rawRows = rowsOf(
    await db.execute(sql`
      SELECT
        po.id AS id,
        po.docNumber AS docNumber,
        DATE_FORMAT(po.createdAt, '%Y-%m-%d') AS date,
        b.name AS branchName,
        CAST(COALESCE(po.materialsCost, 0) AS CHAR) AS inputsCost,
        CAST(COALESCE(po.laborCost, 0) AS CHAR) AS laborCost,
        CAST(COALESCE(po.abnormalLoss, 0) AS CHAR) AS wasteCost,
        CAST(COALESCE(po.totalCost, 0) AS CHAR) AS outputsCost,
        CAST(COALESCE(po.totalCost, 0) AS CHAR) AS totalCost
      FROM productionOrders po
      LEFT JOIN branches b ON b.id = po.branchId
      WHERE po.productionStatus = 'CONFIRMED'
        AND DATE(po.createdAt) >= ${opts.from} AND DATE(po.createdAt) <= ${opts.to}
        ${branchPo}
      ORDER BY po.createdAt DESC, po.id DESC
    `),
  );

  const rows: ProductionReportRow[] = rawRows.map((r) => ({
    id: Number(r.id),
    docNumber: r.docNumber ?? null,
    date: String(r.date ?? ""),
    branchName: r.branchName ?? null,
    inputsCost: toDbMoney(money(r.inputsCost ?? 0)),
    laborCost: toDbMoney(money(r.laborCost ?? 0)),
    wasteCost: toDbMoney(money(r.wasteCost ?? 0)),
    outputsCost: toDbMoney(money(r.outputsCost ?? 0)),
    totalCost: toDbMoney(money(r.totalCost ?? 0)),
  }));

  // الإجماليات بـdecimal (لا parseFloat) — تفادي انجراف 0.01 على آلاف المستندات.
  const totals = rows.reduce(
    (acc, r) => {
      acc.count += 1;
      acc.inputsCost = acc.inputsCost.add(money(r.inputsCost));
      acc.laborCost = acc.laborCost.add(money(r.laborCost));
      acc.wasteCost = acc.wasteCost.add(money(r.wasteCost));
      acc.outputsCost = acc.outputsCost.add(money(r.outputsCost));
      acc.totalCost = acc.totalCost.add(money(r.totalCost));
      return acc;
    },
    {
      count: 0,
      inputsCost: money(0),
      laborCost: money(0),
      wasteCost: money(0),
      outputsCost: money(0),
      totalCost: money(0),
    },
  );

  return {
    rows,
    totals: {
      count: totals.count,
      inputsCost: toDbMoney(totals.inputsCost),
      laborCost: toDbMoney(totals.laborCost),
      wasteCost: toDbMoney(totals.wasteCost),
      outputsCost: toDbMoney(totals.outputsCost),
      totalCost: toDbMoney(totals.totalCost),
    },
  };
}

/* ============================ ٢) تقرير أوامر الشغل (توزيع الحالات + ربحية المُسلَّم + القنوات) ============================ */

/** ترتيب وتسميات حالات أمر الشغل (عربيّة) — كل الحالات تُعرَض حتى الملغاة. */
const WO_STATUS_ORDER = ["RECEIVED", "IN_PROGRESS", "READY", "DELIVERED", "CANCELLED"] as const;
const WO_STATUS_LABEL: Record<string, string> = {
  RECEIVED: "مستلَم",
  IN_PROGRESS: "قيد التنفيذ",
  READY: "جاهز",
  DELIVERED: "مُسلَّم",
  CANCELLED: "ملغى",
};

/** ترتيب وتسميات قنوات الاستلام (عربيّة). */
const WO_CHANNEL_LABEL: Record<string, string> = {
  WALK_IN: "حضوري",
  WHATSAPP: "واتساب",
  INSTAGRAM: "إنستغرام",
  TIKTOK: "تيك توك",
  PHONE: "هاتف",
  OTHER: "أخرى",
};

export interface WorkOrderStatusRow {
  status: string;
  label: string;
  count: number;
}

export interface WorkOrderChannelRow {
  channel: string;
  label: string;
  count: number;
}

export interface WorkOrdersReportResult {
  statusDistribution: WorkOrderStatusRow[];
  byChannel: WorkOrderChannelRow[];
  delivered: {
    count: number;
    totalRevenue: string;
    totalMaterials: string;
    totalLabor: string;
    grossProfit: string;
  };
}

export async function getWorkOrdersReport(opts: {
  from: string;
  to: string;
  branchId?: number;
}): Promise<WorkOrdersReportResult> {
  const db = getDb();
  const empty: WorkOrdersReportResult = {
    statusDistribution: [],
    byChannel: [],
    delivered: { count: 0, totalRevenue: "0", totalMaterials: "0", totalLabor: "0", grossProfit: "0" },
  };
  if (!db) return empty;

  const branchWo = opts.branchId ? sql`AND wo.branchId = ${opts.branchId}` : sql``;

  // أ) توزيع الحالات — تجميع على كل الحالات (بما فيها الملغاة) ضمن النطاق.
  const statusRaw = rowsOf(
    await db.execute(sql`
      SELECT wo.workOrderStatus AS status, COUNT(*) AS cnt
      FROM workOrders wo
      WHERE DATE(wo.createdAt) >= ${opts.from} AND DATE(wo.createdAt) <= ${opts.to}
        ${branchWo}
      GROUP BY wo.workOrderStatus
    `),
  );
  const statusCounts = new Map<string, number>();
  for (const r of statusRaw) statusCounts.set(String(r.status), Number(r.cnt ?? 0));
  // نُظهر كل الحالات بالترتيب الثابت (صفر للحالات الغائبة) ⇒ جدول مستقرّ مكتمل.
  const statusDistribution: WorkOrderStatusRow[] = WO_STATUS_ORDER.map((s) => ({
    status: s,
    label: WO_STATUS_LABEL[s] ?? s,
    count: statusCounts.get(s) ?? 0,
  }));

  // ب) عدد الأوامر حسب قناة الاستلام (NULL ⇒ OTHER) ضمن النطاق — الأكثر أولاً.
  const channelRaw = rowsOf(
    await db.execute(sql`
      SELECT COALESCE(wo.receptionChannel, 'OTHER') AS channel, COUNT(*) AS cnt
      FROM workOrders wo
      WHERE DATE(wo.createdAt) >= ${opts.from} AND DATE(wo.createdAt) <= ${opts.to}
        ${branchWo}
      GROUP BY COALESCE(wo.receptionChannel, 'OTHER')
      ORDER BY COUNT(*) DESC
    `),
  );
  const byChannel: WorkOrderChannelRow[] = channelRaw.map((r) => ({
    channel: String(r.channel),
    label: WO_CHANNEL_LABEL[String(r.channel)] ?? String(r.channel),
    count: Number(r.cnt ?? 0),
  }));

  // ج) ربحية الأوامر المُسلَّمة (DELIVERED) فقط — إيراد البيع مقابل كلفتي المواد والعمالة.
  // grossProfit = SUM(salePrice) − SUM(materialsCost) − SUM(laborCost). بـdecimal لا parseFloat.
  const delRaw = rowsOf(
    await db.execute(sql`
      SELECT
        COUNT(*) AS cnt,
        CAST(COALESCE(SUM(wo.salePrice), 0) AS CHAR) AS totalRevenue,
        CAST(COALESCE(SUM(wo.materialsCost), 0) AS CHAR) AS totalMaterials,
        CAST(COALESCE(SUM(wo.laborCost), 0) AS CHAR) AS totalLabor
      FROM workOrders wo
      WHERE wo.workOrderStatus = 'DELIVERED'
        AND DATE(wo.createdAt) >= ${opts.from} AND DATE(wo.createdAt) <= ${opts.to}
        ${branchWo}
    `),
  )[0] ?? { cnt: 0, totalRevenue: "0", totalMaterials: "0", totalLabor: "0" };

  const totalRevenue = money(delRaw.totalRevenue ?? 0);
  const totalMaterials = money(delRaw.totalMaterials ?? 0);
  const totalLabor = money(delRaw.totalLabor ?? 0);
  const grossProfit = totalRevenue.sub(totalMaterials).sub(totalLabor);

  return {
    statusDistribution,
    byChannel,
    delivered: {
      count: Number(delRaw.cnt ?? 0),
      totalRevenue: toDbMoney(totalRevenue),
      totalMaterials: toDbMoney(totalMaterials),
      totalLabor: toDbMoney(totalLabor),
      grossProfit: toDbMoney(grossProfit),
    },
  };
}
