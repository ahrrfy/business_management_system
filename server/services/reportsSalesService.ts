// خدمة تقارير المبيعات (للقراءة فقط) — تُغذّي مركز التقارير (شريحة المبيعات).
// المصدر: جداول الفواتير invoices + بنودها invoiceItems (لا تخمين).
//
// ⚠️ نمط SQL الخام (يطابق reportsFinancialService): db.execute(sql`…`) + rowsOf لفكّ نتيجة mysql2،
//    CAST(col AS CHAR) لكل مبلغ ثم money()/toDbMoney للجمع (لا parseFloat/Number على المال — §٥)،
//    نطاق التاريخ قابل للفهرسة (sargable): invoiceDate >= from 00:00 AND < nextDay(to) 00:00 (S2 ٢٩/٦).
//    أسماء الأعمدة بأسماء DB: invoices.status ⇒ العمود invoiceStatus.
//
// تعريف الربح للسطر = الإجمالي − (الكمية الأساس بعد طرح المُعاد للمخزون) × تكلفة الوحدة،
//   حيث المطروح = returnedRestockedBaseQuantity (المُعاد للرفّ فقط) ⇒ التالف تبقى تكلفته خسارةً
//   مطابِقةً لدفتر P&L (لا تُحيَّد تكلفة المرتجع التالف).
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";
import { VOIDED_INVOICE_STATUSES } from "@shared/invoiceStatus";

/**
 * قائمة الحالات المُبطَلة كجملة SQL — مشتقّة من الثابت المشترك لا مكتوبةً يدوياً، كي تسري أيّ
 * حالةٍ تُضاف مستقبلاً على التقريرين معاً تلقائياً.
 *
 * **العلّة التي أغلقها هذا (١٧/٨):** كان الشرط `NOT IN ('CANCELLED')` وحدها، و`SUPERSEDED` تمرّ.
 * و`sale/correct.ts` يترك الأصل المُستبدَل بـ`total` كاملاً و`returnedTotal` **مُصفَّراً صراحةً**
 * ⇒ `revenue = SUM(total − returnedTotal)` يحتسب الأصل الميت **والبديلة** معاً، وتكلفته صفرٌ
 * لأنّ العكس أعاد كل الكميات للرفّ ⇒ **كلّ تصحيح فاتورة كان يضاعف المبيعات ويضيف ربحاً وهمياً
 * بقيمتها كاملة** في «المبيعات حسب البُعد» للعميل والفرع والكاشير، ويُظهرها ذمّةً وهمية.
 * (المسار الصحيح كان قائماً في `saleRouter.ts` بتعليقٍ يشرح المضاعفة — هذا الملف وحده تخلّف.)
 */
const VOIDED_STATUS_SQL = sql`(${sql.join(
  VOIDED_INVOICE_STATUSES.map((s) => sql`${s}`),
  sql`, `,
)})`;

/** فكّ نتيجة mysql2 (الصفوف في الفهرس 0). */
function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

/** اليوم التالي لتاريخ YYYY-MM-DD (UTC) — لحدّ نطاق علوي سليم [from، nextDay(to)) بلا حِيَل 23:59:59.
 *  مطابق reportsService.nextDayStr. ضروري لجعل فلتر التاريخ قابلاً للفهرسة (sargable). */
function nextDayStr(ymd: string): string {
  return new Date(new Date(`${ymd}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

/* ============================ سجلّ المبيعات المفصّل (سطر-سطر) ============================ */

export interface SalesRegisterRow {
  id: number; // معرّف بند الفاتورة
  invoiceId: number;
  invoiceNumber: string;
  invoiceDate: string; // YYYY-MM-DD
  /**
   * إسناد الصفّ — دوران **متمايزان** لا يُخلطان (shared/uiContracts):
   *   • `customerName` = «المستفيد» — لمن وقع البيع.
   *   • `soldByName`   = «نفّذها»   — مَن أنشأ الفاتورة (`invoices.createdBy`).
   * كان السجلّ يعرض الأوّل وحده، فيُقرأ الصفّ بلا فاعل: تعرف لمن بِيع ولا تعرف مَن باع
   * (بلاغ المالك ١/٩/٢٦). و`createdBy` هو نفسه أساسُ نسب العمولة، فالعمودان متّسقان.
   */
  customerName: string | null;
  soldByName: string | null;
  productName: string;
  quantity: string;
  unitPrice: string;
  unitCost: string;
  total: string;
  profit: string;
}

export interface SalesRegisterResult {
  rows: SalesRegisterRow[];
  total: number; // عدد البنود الكلّي (قبل الترقيم)
  totals: { revenue: string; cost: string; profit: string; qty: string };
}

export async function getSalesRegister(opts: {
  from: string;
  to: string;
  branchId?: number;
  /** بحث نصّي حرّ — رقم الفاتورة/اسم العميل/اسم المنتج. */
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<SalesRegisterResult> {
  const db = getDb();
  if (!db) return { rows: [], total: 0, totals: { revenue: "0", cost: "0", profit: "0", qty: "0" } };

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const offset = Math.max(opts.offset ?? 0, 0);

  const branchCond = opts.branchId ? sql`AND i.branchId = ${opts.branchId}` : sql``;
  const q = opts.q?.trim();
  // EXISTS بدل الاعتماد على JOIN عملاء/منتجات — استعلام الإجماليات أدناه لا ينضمّ لهما، والبحث
  // يجب أن يعمل من customerId/variantId الخام على invoiceItems/invoices مباشرةً في كلا الاستعلامين.
  const qCond = q
    ? sql`AND (
        i.invoiceNumber LIKE ${`%${q}%`}
        OR EXISTS (SELECT 1 FROM customers c2 WHERE c2.id = i.customerId AND c2.name LIKE ${`%${q}%`})
        OR EXISTS (
          SELECT 1 FROM productVariants pv2 JOIN products p2 ON p2.id = pv2.productId
          WHERE pv2.id = ii.variantId AND p2.name LIKE ${`%${q}%`}
        )
      )`
    : sql``;
  // الفلتر المشترك: نطاق التاريخ + استبعاد المُبطَلة (ملغاة/مستبدلة) + الفرع + البحث (اختياريان).
  // المُرتجَعة تبقى عمداً: بيعٌ وقع ثمّ أُرجِع، صافيه صفرٌ عبر returnedTotal ويظهر في عمود «المرتجعات».
  // S2 (٢٩/٦/٢٦): نطاق قابل للفهرسة [from، nextDay(to)) بدل DATE(i.invoiceDate) (غير قابل للفهرسة كان
  // يفرض مسح كل الفواتير). يحتاج فهرساً مُغطّياً بترتيب (التاريخ ثم الحالة) — هجرة 0032. نفس نتيجة الحدّين الشاملين.
  const where = sql`
    i.invoiceDate >= ${`${opts.from} 00:00:00`} AND i.invoiceDate < ${`${nextDayStr(opts.to)} 00:00:00`}
    AND i.invoiceStatus NOT IN ${VOIDED_STATUS_SQL}
    ${branchCond}
    ${qCond}
  `;

  // الربح للسطر: ii.total − (ii.baseQuantity − ii.returnedRestockedBaseQuantity) × ii.unitCost
  // (التكلفة تطرح المُعاد للمخزون فقط؛ التالف يبقى خسارةً مطابِقةً للدفتر).
  const rows = rowsOf(
    await db.execute(sql`
      SELECT
        ii.id AS id,
        i.id AS invoiceId,
        i.invoiceNumber AS invoiceNumber,
        DATE_FORMAT(i.invoiceDate, '%Y-%m-%d') AS invoiceDate,
        c.name AS customerName,
        su.name AS soldByName,
        p.name AS productName,
        CAST(CASE WHEN ii.baseQuantity > 0
          THEN ii.quantity * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity
          ELSE ii.quantity END AS CHAR) AS quantity,
        CAST(ii.unitPrice AS CHAR) AS unitPrice,
        CAST(ii.unitCost AS CHAR) AS unitCost,
        CAST(CASE WHEN ii.baseQuantity > 0
          THEN ii.total * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity
          ELSE ii.total END AS CHAR) AS total,
        CAST((CASE WHEN ii.baseQuantity > 0
          THEN ii.total * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity
          ELSE ii.total END) - (ii.baseQuantity - ii.returnedRestockedBaseQuantity) * ii.unitCost AS CHAR) AS profit
      FROM invoiceItems ii
      JOIN invoices i ON i.id = ii.invoiceId
      JOIN productVariants pv ON pv.id = ii.variantId
      JOIN products p ON p.id = pv.productId
      LEFT JOIN customers c ON c.id = i.customerId
      LEFT JOIN users su ON su.id = i.createdBy
      LEFT JOIN branches b ON b.id = i.branchId
      WHERE ${where}
      ORDER BY i.invoiceDate DESC, ii.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
  ) as SalesRegisterRow[];

  // الإجماليات على كامل النطاق (لا الصفحة فقط) — العدد + الإيراد/التكلفة/الربح/الكمية.
  const totalsRow = rowsOf(
    await db.execute(sql`
      SELECT
        COUNT(*) AS cnt,
        CAST(COALESCE(SUM(CASE WHEN ii.baseQuantity > 0
          THEN ii.total * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity
          ELSE ii.total END), 0) AS CHAR) AS revenue,
        CAST(COALESCE(SUM((ii.baseQuantity - ii.returnedRestockedBaseQuantity) * ii.unitCost), 0) AS CHAR) AS cost,
        CAST(COALESCE(SUM((CASE WHEN ii.baseQuantity > 0
          THEN ii.total * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity
          ELSE ii.total END) - (ii.baseQuantity - ii.returnedRestockedBaseQuantity) * ii.unitCost), 0) AS CHAR) AS profit,
        CAST(COALESCE(SUM(CASE WHEN ii.baseQuantity > 0
          THEN ii.quantity * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity
          ELSE ii.quantity END), 0) AS CHAR) AS qty
      FROM invoiceItems ii
      JOIN invoices i ON i.id = ii.invoiceId
      WHERE ${where}
    `),
  )[0] ?? { cnt: 0, revenue: "0", cost: "0", profit: "0", qty: "0" };

  return {
    rows,
    total: Number(totalsRow.cnt ?? 0),
    totals: {
      revenue: toDbMoney(money(totalsRow.revenue ?? 0)),
      cost: toDbMoney(money(totalsRow.cost ?? 0)),
      profit: toDbMoney(money(totalsRow.profit ?? 0)),
      qty: String(totalsRow.qty ?? "0"),
    },
  };
}

/* ============================ المبيعات حسب بُعد (عميل/فرع/طريقة دفع/كاشير/صنف) ============================ */

export type SalesDimension = "customer" | "branch" | "paymentMethod" | "cashier" | "product";

export interface SalesByDimensionRow {
  key: string;
  label: string;
  invoices: number;
  revenue: string;
  /** الإجمالي قبل خصم الخصومات والمرتجعات. */
  grossSales: string;
  /** خصومات رأس الفاتورة. */
  discounts: string;
  /** القيمة المرتجعة. */
  returns: string;
  /** الصافي بعد الخصومات والمرتجعات (يساوي revenue للتوافق). */
  netSales: string;
  paid: string;
  unpaid: string;
  /** تكلفة المبيعات (SUM costTotal) — تحليل الربحية الحقيقي. */
  cost: string;
  /** الربح = الإيراد − التكلفة. */
  profit: string;
  /** هامش الربح % = الربح ÷ الإيراد × ١٠٠ (نصّ بمنزلتين). */
  marginPct: string;
}

export interface SalesByDimensionResult {
  rows: SalesByDimensionRow[];
  totals: {
    invoices: number;
    revenue: string;
    grossSales: string;
    discounts: string;
    returns: string;
    netSales: string;
    paid: string;
    unpaid: string;
    cost: string;
    profit: string;
    marginPct: string;
  };
}

/** هامش % decimal-safe (نصّ بمنزلتين)؛ "0.00" حين الإيراد صفر. */
function marginOf(profit: ReturnType<typeof money>, revenue: ReturnType<typeof money>): string {
  if (revenue.isZero()) return "0.00";
  return profit.div(revenue).times(100).toDecimalPlaces(2).toString();
}

export async function getSalesByDimension(opts: {
  from: string;
  to: string;
  branchId?: number;
  dimension: SalesDimension;
}): Promise<SalesByDimensionResult> {
  const db = getDb();
  if (!db) return { rows: [], totals: { invoices: 0, revenue: "0", grossSales: "0", discounts: "0", returns: "0", netSales: "0", paid: "0", unpaid: "0", cost: "0", profit: "0", marginPct: "0.00" } };

  // اختيار محور التجميع + التسمية + الانضمام المطلوب (إن وُجِد).
  // المفتاح key نصّي دائماً (للتمييز في الواجهة)؛ التسمية label معروضة (تتراجع للمفتاح عند NULL).
  let groupKey;
  let labelExpr;
  let joinClause = sql``;
  let groupLabel = true;
  switch (opts.dimension) {
    case "customer":
      groupKey = sql`i.customerId`;
      labelExpr = sql`COALESCE(c.name, 'عميل نقدي')`;
      joinClause = sql`LEFT JOIN customers c ON c.id = i.customerId`;
      break;
    case "branch":
      groupKey = sql`i.branchId`;
      labelExpr = sql`COALESCE(b.name, CAST(i.branchId AS CHAR))`;
      joinClause = sql`LEFT JOIN branches b ON b.id = i.branchId`;
      break;
    case "paymentMethod":
      groupKey = sql`i.paymentMethod`;
      labelExpr = sql`COALESCE(i.paymentMethod, 'غير محدّد')`;
      break;
    case "cashier":
      groupKey = sql`i.createdBy`;
      labelExpr = sql`COALESCE(MAX(i.salespersonNameSnapshot), MAX(u.name), 'غير معروف')`;
      joinClause = sql`LEFT JOIN users u ON u.id = i.createdBy`;
      groupLabel = false;
      break;
    default:
      groupKey = sql`i.customerId`;
      labelExpr = sql`COALESCE(c.name, 'عميل نقدي')`;
      joinClause = sql`LEFT JOIN customers c ON c.id = i.customerId`;
  }

  const branchCond = opts.branchId ? sql`AND i.branchId = ${opts.branchId}` : sql``;
  // S2 (٢٩/٦/٢٦): نطاق قابل للفهرسة [from، nextDay(to)) بدل DATE(i.invoiceDate) (غير قابل للفهرسة كان
  // يفرض مسح كل الفواتير). يحتاج فهرساً مُغطّياً بترتيب (التاريخ ثم الحالة) — هجرة 0032. نفس نتيجة الحدّين الشاملين.
  const where = sql`
    i.invoiceDate >= ${`${opts.from} 00:00:00`} AND i.invoiceDate < ${`${nextDayStr(opts.to)} 00:00:00`}
    AND i.invoiceStatus NOT IN ${VOIDED_STATUS_SQL}
    ${branchCond}
  `;

  // بند 9 (٧/٧): بُعد «الصنف» — تجميع على مستوى بنود الفواتير (لا الفواتير) بمسار مستقل:
  //  • revenue = Σ(ii.total)، cost بصيغة السطر نفسها المستعملة في سجلّ المبيعات أعلاه
  //    (المُعاد للرفّ يُحيَّد؛ التالف يبقى خسارة) ⇒ لا تناقض بين التقريرين على نفس البيانات.
  //  • paid/unpaid لا معنى لهما على مستوى الصنف (خاصيّة فاتورة) ⇒ صفران، والواجهة تخفيهما.
  //  • invoices = عدد الفواتير المميَّزة التي ظهر فيها الصنف.
  if (opts.dimension === "product") {
    const rows = rowsOf(
      await db.execute(sql`
        SELECT
          CAST(p.id AS CHAR) AS \`key\`,
          p.name AS label,
          COUNT(DISTINCT i.id) AS invoices,
          -- #reports-1 (تدقيق التثبيت): مرآة إصلاح getTopProducts — الإيراد يُصافى بالمرتجعات
          -- تناسبياً (guard على baseQuantity=0 للخدمات) ⇒ يتّسق مع تبويب المنتجات على نفس الشاشة.
          CAST(COALESCE(SUM(CASE WHEN ii.baseQuantity > 0
            THEN ii.total * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity
            ELSE ii.total END), 0) AS CHAR) AS revenue,
          CAST(COALESCE(SUM(CASE WHEN ii.baseQuantity > 0
            THEN ii.total * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity
            ELSE ii.total END), 0) AS CHAR) AS grossSales,
          CAST(0 AS CHAR) AS discounts,
          CAST(0 AS CHAR) AS returns,
          CAST(COALESCE(SUM(CASE WHEN ii.baseQuantity > 0
            THEN ii.total * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity
            ELSE ii.total END), 0) AS CHAR) AS netSales,
          CAST(0 AS CHAR) AS paid,
          CAST(0 AS CHAR) AS unpaid,
          CAST(COALESCE(SUM((ii.baseQuantity - ii.returnedRestockedBaseQuantity) * ii.unitCost), 0) AS CHAR) AS cost
        FROM invoiceItems ii
        JOIN invoices i ON i.id = ii.invoiceId
        JOIN productVariants pv ON pv.id = ii.variantId
        JOIN products p ON p.id = pv.productId
        WHERE ${where}
        GROUP BY p.id, p.name
        ORDER BY SUM(ii.total) DESC
      `),
    );
    return summarizeDimensionRows(rows);
  }

  // أبعاد العميل/الفرع/الكاشير تتبع لقطة الفاتورة، لكن تكلفة الفاتورة تُعاد بناؤها
  // من الكميات التي لم تُرجع إلى المخزون. هذا يحافظ على ظهور البيانات التاريخية
  // المستوردة قبل إنشاء دفتر القيود ويمنع إبقاء تكلفة البضاعة المرتجعة ضمن الربح.
  const rows = rowsOf(
    await db.execute(sql`
      SELECT
        CAST(COALESCE(${groupKey}, '') AS CHAR) AS \`key\`,
        ${labelExpr} AS label,
        COUNT(*) AS invoices,
        CAST(COALESCE(SUM(i.total - i.returnedTotal), 0) AS CHAR) AS revenue,
        CAST(COALESCE(SUM(i.total + i.discountAmount), 0) AS CHAR) AS grossSales,
        CAST(COALESCE(SUM(i.discountAmount), 0) AS CHAR) AS discounts,
        CAST(COALESCE(SUM(i.returnedTotal), 0) AS CHAR) AS returns,
        CAST(COALESCE(SUM(i.total - i.returnedTotal), 0) AS CHAR) AS netSales,
        CAST(COALESCE(SUM(i.paidAmount), 0) AS CHAR) AS paid,
        CAST(COALESCE(SUM(GREATEST(i.total - i.paidAmount - i.returnedTotal, 0)), 0) AS CHAR) AS unpaid,
        CAST(COALESCE(SUM(COALESCE(ic.cost, i.costTotal)), 0) AS CHAR) AS cost
      FROM invoices i
      LEFT JOIN (
        SELECT ii.invoiceId,
          SUM((ii.baseQuantity - ii.returnedRestockedBaseQuantity) * ii.unitCost) AS cost
        FROM invoiceItems ii
        GROUP BY ii.invoiceId
      ) ic ON ic.invoiceId = i.id
      ${joinClause}
      WHERE ${where}
      GROUP BY ${groupKey}${groupLabel ? sql`, label` : sql``}
      ORDER BY SUM(i.total - i.returnedTotal) DESC
    `),
  );
  return summarizeDimensionRows(rows);
}

/** تحويل صفوف SQL الخام لصفوف النتيجة + إجماليات decimal (مشترك بين مسار الفواتير ومسار الأصناف). */
function summarizeDimensionRows(rows: any[]): SalesByDimensionResult {

  let invCount = 0;
  let revenue = money(0);
  let grossSales = money(0);
  let discounts = money(0);
  let returns = money(0);
  let netSales = money(0);
  let paid = money(0);
  let unpaid = money(0);
  let cost = money(0);
  const out: SalesByDimensionRow[] = rows.map((r) => {
    const rev = money(r.revenue ?? 0);
    const gross = money(r.grossSales ?? r.revenue ?? 0);
    const disc = money(r.discounts ?? 0);
    const returned = money(r.returns ?? 0);
    const net = money(r.netSales ?? r.revenue ?? 0);
    const pd = money(r.paid ?? 0);
    const up = money(r.unpaid ?? 0);
    const cs = money(r.cost ?? 0);
    const profit = rev.sub(cs);
    const cnt = Number(r.invoices ?? 0);
    invCount += cnt;
    revenue = revenue.add(rev);
    grossSales = grossSales.add(gross);
    discounts = discounts.add(disc);
    returns = returns.add(returned);
    netSales = netSales.add(net);
    paid = paid.add(pd);
    unpaid = unpaid.add(up);
    cost = cost.add(cs);
    return {
      key: String(r.key ?? ""),
      label: String(r.label ?? "—"),
      invoices: cnt,
      revenue: toDbMoney(rev),
      grossSales: toDbMoney(gross),
      discounts: toDbMoney(disc),
      returns: toDbMoney(returned),
      netSales: toDbMoney(net),
      paid: toDbMoney(pd),
      unpaid: toDbMoney(up),
      cost: toDbMoney(cs),
      profit: toDbMoney(profit),
      marginPct: marginOf(profit, rev),
    };
  });

  const totalProfit = revenue.sub(cost);
  return {
    rows: out,
    totals: {
      invoices: invCount,
      revenue: toDbMoney(revenue),
      grossSales: toDbMoney(grossSales),
      discounts: toDbMoney(discounts),
      returns: toDbMoney(returns),
      netSales: toDbMoney(netSales),
      paid: toDbMoney(paid),
      unpaid: toDbMoney(unpaid),
      cost: toDbMoney(cost),
      profit: toDbMoney(totalProfit),
      marginPct: marginOf(totalProfit, revenue),
    },
  };
}
