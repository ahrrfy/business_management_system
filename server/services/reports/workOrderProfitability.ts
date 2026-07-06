// تقرير ربحية أوامر الشغل (Job Costing) — للقراءة فقط، يُغذّي شاشة «ربحية أوامر الشغل».
//
// السؤال التجاري: أيّ أنواع الأعمال تربح فعلاً؟ زمن التنفيذ workSeconds مُسجَّل على كل أمر
// (يُحتسَب عند markWorkOrderReady بفارق DB clock) لكنه لم يكن مُستغَلاً في أي تقرير.
//
// **الدلالة المالية (مطابقة للدفتر — server/services/workOrder/deliver.ts):**
//  • الإيراد = صافٍ قبل الضريبة: عند التسليم تُنشأ فاتورة (sourceType=WORKORDER) بـ
//    subtotal=total=salePrice و taxAmount=0، وقيد SALE بـ revenue=salePrice. هنا نقرأ
//    (invoices.total − invoices.taxAmount) عبر workOrders.invoiceId — يُطابق salePrice
//    لفواتير أوامر الشغل الحالية ويبقى صحيحاً لو فُعِّلت ضريبة عليها مستقبلاً.
//    fallback: أمر DELIVERED بلا فاتورة مرتبطة (بيانات قديمة) ⇒ salePrice نفسه.
//  • تكلفة المواد = workOrders.materialsCost: لقطة محسوبة عند startWorkOrder من
//    workOrderMaterials (unitCost snapshot × baseQuantity مع حركات OUT) — نفس القيمة
//    التي تدخل invoice.costTotal وقيد SALE.cost (مع laborCost المسجَّلة).
//  • ساعات العمل = workSeconds / 3600 (منزلتان). NULL للأوامر السابقة للهجرة ⇒ تبقى NULL.
//  • كلفة العمل المحسوبة = الساعات × laborRatePerHour (معامل اختياري «ماذا-لو» يُدخله
//    المدير) — NULL إن غاب المعامل أو غاب workSeconds.
//  • الربح = الإيراد − المواد − كلفة العمل المحسوبة (إن وُجدت، وإلا تُطرح المواد فقط).
//    ملاحظة: laborCost **المسجَّلة** على الأمر (تقدير الاستقبال) تُعاد عموداً معلوماتياً
//    quotedLaborCost ولا تدخل معادلة الربح هنا — معادلة التقرير تقيس كلفة العمل بالزمن
//    الفعلي المُقاس، وهو مقصد التقرير (قرارُ تسعيرٍ بالبيانات لا بالتقدير).
//
// النطاق: أوامر DELIVERED فقط، والفلترة الزمنية على deliveredAt (نطاق sargable
// [from, to+يوم) بمنتصف ليل محلي — لا DATE() الماسح للجدول، اتفاقية حملة الأداء).
// كل الأموال decimal.js عبر money.ts (round2 HALF_UP) وتُعاد نصوصاً — ممنوع parseFloat.
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { localDayStart, localNextDayStart } from "../dateRange";
import { money, round2, toDbMoney } from "../money";

/** فكّ نتيجة mysql2 (الصفوف في الفهرس 0) — نمط reportsProductionService. */
function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

export interface WorkOrderProfitabilityInput {
  /** نطاق تاريخ التسليم YYYY-MM-DD (شامل الطرفين). */
  from: string;
  to: string;
  /** عزل الفرع — يُمرَّر من scopedBranchId في الراوتر (undefined/null = كل الفروع للأدمن). */
  branchId?: number | null;
  /** كلفة ساعة العمل (د.ع) — نصّ مالي اختياري؛ غيابه ⇒ laborCost=null ولا تُطرح من الربح. */
  laborRatePerHour?: string | null;
  limit?: number;
  offset?: number;
}

export interface WorkOrderProfitabilityRow {
  id: number;
  orderNumber: string;
  title: string;
  customerName: string | null;
  branchName: string | null;
  /** تاريخ التسليم YYYY-MM-DD. */
  deliveredAt: string;
  invoiceId: number | null;
  invoiceNumber: string | null;
  /** الإيراد الصافي قبل الضريبة (invoice.total − invoice.taxAmount؛ fallback: salePrice). */
  revenue: string;
  /** تكلفة المواد (لقطة startWorkOrder من workOrderMaterials). */
  materialsCost: string;
  /** كلفة العمالة المسجَّلة على الأمر عند الاستلام (معلوماتي — لا تدخل ربح هذا التقرير). */
  quotedLaborCost: string;
  /** ساعات العمل الفعلية = workSeconds/3600 بمنزلتين؛ null إن لم يُقَس الزمن. */
  hours: string | null;
  /** كلفة العمل المحسوبة = hours × laborRatePerHour؛ null بلا معامل أو بلا زمن. */
  laborCost: string | null;
  /** الربح = revenue − materialsCost − (laborCost إن وُجدت). */
  profit: string;
  /** هامش الربح ٪ بمنزلتين؛ null عند إيراد صفري. */
  marginPct: string | null;
}

export interface WorkOrderProfitabilityResult {
  rows: WorkOrderProfitabilityRow[];
  /** عدد كل الأوامر المطابقة (للترقيم) — قد يفوق rows.length عند limit/offset. */
  totalCount: number;
  /** إجماليات **كامل النطاق المطابق** (لا الصفحة وحدها) = مجموع الصفوف بدقّة decimal. */
  totals: {
    count: number;
    revenue: string;
    materialsCost: string;
    quotedLaborCost: string;
    /** مجموع الساعات المُقاسة (الأوامر بلا workSeconds لا تُسهم). */
    hours: string;
    /** مجموع كلفة العمل المحسوبة؛ null إن لم يُمرَّر laborRatePerHour. */
    laborCost: string | null;
    profit: string;
    marginPct: string | null;
  };
}

/** سقف مسحٍ وقائي: أوامر الشغل قليلة الحجم (عشرات يومياً) — ٢٠ ألفاً تغطي سنواتٍ لنطاق واحد.
 *  الإجماليات تُحسب على المجموعة الممسوحة؛ لو بلغ النطاق السقف فالمطلوب تضييق المدى. */
const MAX_SCAN = 20_000;

const SECONDS_PER_HOUR = 3600;

export async function workOrderProfitability(
  input: WorkOrderProfitabilityInput,
): Promise<WorkOrderProfitabilityResult> {
  const limit = Math.max(1, Math.min(input.limit ?? 500, 2000));
  const offset = Math.max(0, input.offset ?? 0);
  const empty: WorkOrderProfitabilityResult = {
    rows: [],
    totalCount: 0,
    totals: {
      count: 0,
      revenue: "0.00",
      materialsCost: "0.00",
      quotedLaborCost: "0.00",
      hours: "0.00",
      laborCost: input.laborRatePerHour ? "0.00" : null,
      profit: "0.00",
      marginPct: null,
    },
  };
  const db = getDb();
  if (!db) return empty;

  const rate = input.laborRatePerHour != null && input.laborRatePerHour !== ""
    ? round2(money(input.laborRatePerHour))
    : null;

  // عمود enum الخام اسمه workOrderStatus (الوسيط الأول لـmysqlEnum) لا status — فخّ موثَّق.
  const branchCond = input.branchId ? sql`AND wo.branchId = ${input.branchId}` : sql``;
  const raw = rowsOf(
    await db.execute(sql`
      SELECT
        wo.id AS id,
        wo.orderNumber AS orderNumber,
        wo.title AS title,
        c.name AS customerName,
        b.name AS branchName,
        DATE_FORMAT(wo.deliveredAt, '%Y-%m-%d') AS deliveredDate,
        wo.invoiceId AS invoiceId,
        inv.invoiceNumber AS invoiceNumber,
        CAST(COALESCE(wo.salePrice, 0) AS CHAR) AS salePrice,
        CAST(inv.total AS CHAR) AS invTotal,
        CAST(inv.taxAmount AS CHAR) AS invTax,
        CAST(COALESCE(wo.materialsCost, 0) AS CHAR) AS materialsCost,
        CAST(COALESCE(wo.laborCost, 0) AS CHAR) AS quotedLaborCost,
        wo.workSeconds AS workSeconds
      FROM workOrders wo
      LEFT JOIN customers c ON c.id = wo.customerId
      LEFT JOIN branches b ON b.id = wo.branchId
      LEFT JOIN invoices inv ON inv.id = wo.invoiceId
      WHERE wo.workOrderStatus = 'DELIVERED'
        AND wo.deliveredAt >= ${localDayStart(input.from)}
        AND wo.deliveredAt < ${localNextDayStart(input.to)}
        ${branchCond}
      ORDER BY wo.deliveredAt DESC, wo.id DESC
      LIMIT ${MAX_SCAN}
    `),
  );

  const allRows: WorkOrderProfitabilityRow[] = raw.map((r) => {
    // الإيراد الصافي قبل الضريبة — من الفاتورة المرتبطة إن وُجدت (total − taxAmount)،
    // وإلا salePrice (أوامر قديمة سُلِّمت قبل ربط الفاتورة).
    const revenue = r.invTotal != null
      ? round2(money(r.invTotal).minus(money(r.invTax ?? 0)))
      : round2(money(r.salePrice ?? 0));
    const materials = round2(money(r.materialsCost ?? 0));
    const quotedLabor = round2(money(r.quotedLaborCost ?? 0));

    const seconds = r.workSeconds == null ? null : Number(r.workSeconds);
    const hoursD = seconds == null ? null : round2(new Decimal(seconds).div(SECONDS_PER_HOUR));
    const laborD = rate != null && seconds != null
      ? round2(rate.times(new Decimal(seconds).div(SECONDS_PER_HOUR)))
      : null;

    const profit = round2(revenue.minus(materials).minus(laborD ?? new Decimal(0)));
    const marginPct = revenue.gt(0) ? round2(profit.div(revenue).times(100)).toFixed(2) : null;

    return {
      id: Number(r.id),
      orderNumber: String(r.orderNumber ?? ""),
      title: String(r.title ?? ""),
      customerName: r.customerName ?? null,
      branchName: r.branchName ?? null,
      deliveredAt: String(r.deliveredDate ?? ""),
      invoiceId: r.invoiceId == null ? null : Number(r.invoiceId),
      invoiceNumber: r.invoiceNumber ?? null,
      revenue: toDbMoney(revenue),
      materialsCost: toDbMoney(materials),
      quotedLaborCost: toDbMoney(quotedLabor),
      hours: hoursD == null ? null : hoursD.toFixed(2),
      laborCost: laborD == null ? null : toDbMoney(laborD),
      profit: toDbMoney(profit),
      marginPct,
    };
  });

  // الإجماليات = مجموع الصفوف نفسها (بعد تقريب كل صف) بدقّة decimal — لا SUM() SQL منفصل
  // كي لا ينحرف صف الإجماليات سنتاً عن مجموع ما يراه المستخدم فعلاً.
  const totalsAcc = allRows.reduce(
    (acc, r) => {
      acc.revenue = acc.revenue.plus(money(r.revenue));
      acc.materials = acc.materials.plus(money(r.materialsCost));
      acc.quotedLabor = acc.quotedLabor.plus(money(r.quotedLaborCost));
      if (r.hours != null) acc.hours = acc.hours.plus(money(r.hours));
      if (r.laborCost != null) acc.labor = acc.labor.plus(money(r.laborCost));
      acc.profit = acc.profit.plus(money(r.profit));
      return acc;
    },
    {
      revenue: new Decimal(0),
      materials: new Decimal(0),
      quotedLabor: new Decimal(0),
      hours: new Decimal(0),
      labor: new Decimal(0),
      profit: new Decimal(0),
    },
  );
  const totalMargin = totalsAcc.revenue.gt(0)
    ? round2(totalsAcc.profit.div(totalsAcc.revenue).times(100)).toFixed(2)
    : null;

  return {
    rows: allRows.slice(offset, offset + limit),
    totalCount: allRows.length,
    totals: {
      count: allRows.length,
      revenue: toDbMoney(totalsAcc.revenue),
      materialsCost: toDbMoney(totalsAcc.materials),
      quotedLaborCost: toDbMoney(totalsAcc.quotedLabor),
      hours: totalsAcc.hours.toFixed(2),
      laborCost: rate != null ? toDbMoney(totalsAcc.labor) : null,
      profit: toDbMoney(totalsAcc.profit),
      marginPct: totalMargin,
    },
  };
}
