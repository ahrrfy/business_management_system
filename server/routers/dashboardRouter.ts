import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  invoices,
  invoiceItems,
  products,
  customers,
  suppliers,
  purchaseOrders,
  employees,
  receipts,
  accountingEntries,
} from "../../drizzle/schema";
import { eq, sql, and, gte, lte, desc, count, sum } from "drizzle-orm";

export const dashboardRouter = router({
  /**
   * إحصائيات لوحة التحكم الرئيسية
   */
  stats: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // إجمالي المبيعات هذا الشهر
    const [monthlySales] = await db
      .select({ total: sql<string>`COALESCE(SUM(${invoices.total}), 0)` })
      .from(invoices)
      .where(
        gte(invoices.invoiceDate, startOfMonth)
      );

    // إجمالي المبيعات اليوم
    const [dailySales] = await db
      .select({ total: sql<string>`COALESCE(SUM(${invoices.total}), 0)` })
      .from(invoices)
      .where(
        gte(invoices.invoiceDate, startOfDay)
      );

    // عدد الفواتير اليوم
    const [dailyInvoiceCount] = await db
      .select({ count: count() })
      .from(invoices)
      .where(gte(invoices.invoiceDate, startOfDay));

    // عدد العملاء
    const [customerCount] = await db
      .select({ count: count() })
      .from(customers);

    // عدد المنتجات
    const [productCount] = await db
      .select({ count: count() })
      .from(products);

    // عدد الموردين
    const [supplierCount] = await db
      .select({ count: count() })
      .from(suppliers);

    // منتجات منخفضة المخزون
    const lowStockProducts = await db
      .select()
      .from(products)
      .where(sql`${products.quantityOnHand} <= ${products.minStock}`)
      .limit(10);

    // المقبوضات هذا الشهر (مرتبطة بالفواتير)
    const [monthlyReceipts] = await db
      .select({ total: sql<string>`COALESCE(SUM(${receipts.amount}), 0)` })
      .from(receipts)
      .where(
        gte(receipts.createdAt, startOfMonth)
      );

    // المدفوعات هذا الشهر (المشتريات)
    const [monthlyPayments] = await db
      .select({ total: sql<string>`COALESCE(SUM(${purchaseOrders.total}), 0)` })
      .from(purchaseOrders)
      .where(
        gte(purchaseOrders.orderDate, startOfMonth)
      );

    // عدد الموظفين
    const [employeeCount] = await db
      .select({ count: count() })
      .from(employees)
      .where(eq(employees.isActive, true));

    // آخر 5 فواتير
    const recentInvoices = await db
      .select()
      .from(invoices)
      .orderBy(desc(invoices.createdAt))
      .limit(5);

    return {
      monthlySales: parseFloat(monthlySales.total) || 0,
      dailySales: parseFloat(dailySales.total) || 0,
      dailyInvoiceCount: dailyInvoiceCount.count,
      customerCount: customerCount.count,
      productCount: productCount.count,
      supplierCount: supplierCount.count,
      lowStockProducts,
      monthlyReceipts: parseFloat(monthlyReceipts.total) || 0,
      monthlyPayments: parseFloat(monthlyPayments.total) || 0,
      monthlyProfit: (parseFloat(monthlyReceipts.total) || 0) - (parseFloat(monthlyPayments.total) || 0),
      employeeCount: employeeCount.count,
      recentInvoices,
    };
  }),

  /**
   * تقرير المبيعات الشهري
   */
  salesReport: protectedProcedure
    .input(
      z.object({
        startDate: z.string(),
        endDate: z.string(),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const start = new Date(input.startDate);
      const end = new Date(input.endDate);

      const salesData = await db.execute(
        sql`SELECT DATE(invoiceDate) as sale_date, SUM(total) as total_sales, COUNT(*) as invoice_count FROM invoices WHERE invoiceDate >= ${start} AND invoiceDate <= ${end} GROUP BY sale_date ORDER BY sale_date`
      );

      return (salesData[0] as unknown as any[]).map((row: any) => ({
        date: String(row.sale_date),
        total: String(row.total_sales || 0),
        count: Number(row.invoice_count || 0),
      }));
    }),

  /**
   * تقرير الأرباح والخسائر
   */
  profitLossReport: protectedProcedure
    .input(
      z.object({
        startDate: z.string(),
        endDate: z.string(),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const start = new Date(input.startDate);
      const end = new Date(input.endDate);

      // الإيرادات
      const [revenue] = await db
        .select({ total: sql<string>`COALESCE(SUM(${invoices.total}), 0)` })
        .from(invoices)
        .where(
          and(
            gte(invoices.invoiceDate, start),
            lte(invoices.invoiceDate, end)
          )
        );

      // المشتريات
      const [purchases] = await db
        .select({ total: sql<string>`COALESCE(SUM(${purchaseOrders.total}), 0)` })
        .from(purchaseOrders)
        .where(
          and(
            gte(purchaseOrders.orderDate, start),
            lte(purchaseOrders.orderDate, end)
          )
        );

      // المصروفات (نفس المشتريات)
      const totalExpensesVal = parseFloat(purchases.total) || 0;

      const totalRevenue = parseFloat(revenue.total) || 0;
      const totalPurchases = parseFloat(purchases.total) || 0;
      const totalExpenses = totalExpensesVal;
      const grossProfit = totalRevenue - totalPurchases;
      const netProfit = grossProfit - totalExpenses;

      return {
        revenue: totalRevenue,
        purchases: totalPurchases,
        expenses: totalExpenses,
        grossProfit,
        netProfit,
        profitMargin: totalRevenue > 0 ? ((netProfit / totalRevenue) * 100).toFixed(2) : "0",
      };
    }),

  /**
   * أفضل المنتجات مبيعاً
   */
  topProducts: protectedProcedure
    .input(z.object({ limit: z.number().default(10) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const topProducts = await db
        .select({
          productId: invoiceItems.productId,
          totalQuantity: sql<string>`SUM(${invoiceItems.quantity})`,
          totalRevenue: sql<string>`SUM(${invoiceItems.total})`,
        })
        .from(invoiceItems)
        .groupBy(invoiceItems.productId)
        .orderBy(desc(sql`SUM(${invoiceItems.quantity})`))
        .limit(input.limit);

      return topProducts;
    }),
});
