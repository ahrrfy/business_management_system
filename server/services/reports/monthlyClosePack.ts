// بند 11 (٧/٧): حزمة الإقفال الشهري الموحّدة — صورة شهرية واحدة للمالك بنقرة بدل تجميع
// يدوي من ست شاشات. للقراءة فقط، تُغذّي شاشة «الإقفال الشهري» في محور الإقفال والرقابة.
//
// مبدأ التركيب: **إعادة استعمال خدمات التقارير القائمة** (مصدر حقيقة واحد لكل قسم — أي إصلاح
// دلالي فيها يسري هنا تلقائياً) والاستعلام المباشر فقط حيث لا خدمة مناسبة:
//  • ملخّص المبيعات: استعلام مباشر على invoices (عدّ/صافٍ/ضريبة/إجمالي/مرتجعات) — لا خدمة
//    تعيد هذا التركيب الشهري تحديداً.
//  • الربح الإجمالي: totals سجلّ المبيعات getSalesRegister (صيغة السطر المعتمدة: المُعاد للرف
//    يُحيَّد والتالف خسارة — نفس أرقام تبويب «تفصيلي» أمام المستخدم حرفياً).
//  • المشتريات: getPurchasesReport.totals · المصروفات: getExpensesReport · الخزينة:
//    getTreasurySummary · لقطة الذمم: getARAging/getAPAging (لقطة **حالية** لا تاريخية —
//    الأرصدة الجارية لا تُعاد بنائياً لتاريخ ماضٍ، ويُصرَّح بذلك في الواجهة).
//  • أوامر الشغل المُسلَّمة: عدّ مباشر على deliveredAt.
// كل الأموال decimal.js عبر money.ts وتُعاد نصوصاً (§٥ — ممنوع parseFloat).
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { getSalesRegister } from "../reportsSalesService";
import { getPurchasesReport } from "../reportsPurchasesService";
import { getExpensesReport, getTreasurySummary } from "../reportsTreasuryService";
import { getARAging } from "./arAging";
import { getAPAging } from "./apAging";

function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

export interface MonthlyClosePackInput {
  /** الشهر بصيغة YYYY-MM. */
  month: string;
  branchId?: number | null;
}

export interface MonthlyClosePackResult {
  month: string;
  period: { from: string; to: string };
  sales: {
    invoiceCount: number;
    subtotal: string;
    tax: string;
    total: string;
    returnedTotal: string;
    netAfterReturns: string;
  };
  profit: { revenue: string; cost: string; profit: string };
  purchases: { orderCount: number; total: string; paid: string; unpaid: string };
  expenses: { total: string; topCategories: Array<{ category: string; total: string }> };
  treasury: { totalIn: string; totalOut: string; net: string };
  /** لقطة الذمم **الحالية** وقت التوليد (لا يمكن إعادة بنائها تاريخياً لنهاية الشهر). */
  receivablesSnapshot: { arTotal: string; apTotal: string };
  workOrdersDelivered: number;
}

/** [أول الشهر، آخر يومه] — الخدمات المُعاد استعمالها تعالج الحدّ الأعلى بنفسها بـnextDay (sargable). */
function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

export async function getMonthlyClosePack(input: MonthlyClosePackInput): Promise<MonthlyClosePackResult> {
  const db = getDb();
  const { from, to } = monthRange(input.month);
  const branchId = input.branchId ?? undefined;
  const empty: MonthlyClosePackResult = {
    month: input.month,
    period: { from, to },
    sales: { invoiceCount: 0, subtotal: "0.00", tax: "0.00", total: "0.00", returnedTotal: "0.00", netAfterReturns: "0.00" },
    profit: { revenue: "0.00", cost: "0.00", profit: "0.00" },
    purchases: { orderCount: 0, total: "0.00", paid: "0.00", unpaid: "0.00" },
    expenses: { total: "0.00", topCategories: [] },
    treasury: { totalIn: "0.00", totalOut: "0.00", net: "0.00" },
    receivablesSnapshot: { arTotal: "0.00", apTotal: "0.00" },
    workOrdersDelivered: 0,
  };
  if (!db) return empty;

  const branchCond = branchId ? sql`AND branchId = ${branchId}` : sql``;
  const upper = `${nextDayStr(to)} 00:00:00`;
  const lower = `${from} 00:00:00`;

  // الأقسام مستقلة القراءة ⇒ توازٍ كامل (نمط getSessionContext بعد ملاحظة أداء ٣/٧).
  const [salesRow, register, purchases, expenses, treasury, arRows, apRows, woRow] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*) AS cnt,
        CAST(COALESCE(SUM(subtotal), 0) AS CHAR) AS subtotal,
        CAST(COALESCE(SUM(taxAmount), 0) AS CHAR) AS tax,
        CAST(COALESCE(SUM(total), 0) AS CHAR) AS total,
        CAST(COALESCE(SUM(returnedTotal), 0) AS CHAR) AS returned
      FROM invoices
      WHERE invoiceDate >= ${lower} AND invoiceDate < ${upper}
        AND invoiceStatus NOT IN ('CANCELLED')
        ${branchCond}
    `),
    getSalesRegister({ from, to, branchId, limit: 1 }),
    getPurchasesReport({ from, to, branchId }),
    getExpensesReport({ from, to, branchId }),
    getTreasurySummary({ from, to, branchId }),
    getARAging({ branchId }),
    getAPAging({ branchId }),
    db.execute(sql`
      SELECT COUNT(*) AS cnt FROM workOrders
      WHERE workOrderStatus = 'DELIVERED'
        AND deliveredAt >= ${lower} AND deliveredAt < ${upper}
        ${branchCond}
    `),
  ]);

  const s = rowsOf(salesRow)[0] ?? {};
  const total = money(s.total ?? 0);
  const returned = money(s.returned ?? 0);

  const arTotal = arRows.reduce((acc, r) => acc.add(money(r.currentBalance ?? 0)), money(0));
  const apTotal = apRows.reduce((acc, r) => acc.add(money(r.currentBalance ?? 0)), money(0));

  return {
    month: input.month,
    period: { from, to },
    sales: {
      invoiceCount: Number(s.cnt ?? 0),
      subtotal: toDbMoney(money(s.subtotal ?? 0)),
      tax: toDbMoney(money(s.tax ?? 0)),
      total: toDbMoney(total),
      returnedTotal: toDbMoney(returned),
      netAfterReturns: toDbMoney(total.sub(returned)),
    },
    profit: {
      revenue: register.totals.revenue,
      cost: register.totals.cost,
      profit: register.totals.profit,
    },
    purchases: {
      orderCount: purchases.totals.count,
      total: purchases.totals.total,
      paid: purchases.totals.paid,
      unpaid: purchases.totals.unpaid,
    },
    expenses: {
      total: expenses.total,
      topCategories: expenses.byCategory.slice(0, 5).map((c) => ({
        category: c.label,
        total: c.amount,
      })),
    },
    treasury: { totalIn: treasury.totalIn, totalOut: treasury.totalOut, net: treasury.net },
    receivablesSnapshot: { arTotal: toDbMoney(arTotal), apTotal: toDbMoney(apTotal) },
    workOrdersDelivered: Number((rowsOf(woRow)[0] ?? {}).cnt ?? 0),
  };
}

/** اليوم التالي YYYY-MM-DD (UTC) — نفس دلالة reportsSalesService.nextDayStr (نطاق sargable). */
function nextDayStr(ymd: string): string {
  return new Date(new Date(`${ymd}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}
