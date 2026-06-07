import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { customers, invoices, suppliers } from "../../drizzle/schema";
import { getDb } from "../db";
import {
  getAPAging,
  getARAging,
  getCustomerStatement,
  getSupplierStatement,
} from "../services/reportsService";
import {
  reconcileCustomerBalances,
  reconcileInventory,
  reconcileLedgerProfit,
} from "../services/reconcileService";
import { adminProcedure, managerProcedure, router } from "../trpc";

export const reportsRouter = router({
  arAging: managerProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input }) => getARAging({ branchId: input?.branchId })),

  customerStatement: managerProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .query(async ({ input }) => getCustomerStatement(input.customerId)),

  /** Lightweight customer index for the statement picker. */
  customersIndex: managerProcedure.query(async () => {
    const db = getDb();
    if (!db) return [];
    return db
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        currentBalance: customers.currentBalance,
      })
      .from(customers)
      .orderBy(asc(customers.name));
  }),

  apAging: managerProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input }) => getAPAging({ branchId: input?.branchId })),

  supplierStatement: managerProcedure
    .input(z.object({ supplierId: z.number().int().positive() }))
    .query(async ({ input }) => getSupplierStatement(input.supplierId)),

  /** Lightweight supplier index for the statement picker. */
  suppliersIndex: managerProcedure.query(async () => {
    const db = getDb();
    if (!db) return [];
    return db
      .select({
        id: suppliers.id,
        name: suppliers.name,
        phone: suppliers.phone,
        currentBalance: suppliers.currentBalance,
      })
      .from(suppliers)
      .orderBy(asc(suppliers.name));
  }),

  /**
   * تقرير المبيعات التفصيلي — نطاق زمني اختياري + فلاتر.
   * يُعيد قائمة الفواتير مع ملخّص الإجماليات في النهاية.
   */
  salesReport: managerProcedure
    .input(
      z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        branchId: z.number().int().positive().optional(),
        sourceTypes: z
          .array(z.enum(["POS", "ONLINE", "ORDER", "WORKORDER"]))
          .optional(),
        statuses: z
          .array(
            z.enum([
              "PENDING",
              "CONFIRMED",
              "PAID",
              "PARTIALLY_PAID",
              "CANCELLED",
              "RETURNED",
            ])
          )
          .optional(),
      })
    )
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return { rows: [], totals: { count: 0, total: "0", paid: "0", unpaid: "0" } };

      const conditions = [];
      if (input.from) {
        conditions.push(sql`${invoices.invoiceDate} >= ${new Date(input.from)}`);
      }
      if (input.to) {
        // نهاية اليوم
        const to = new Date(input.to);
        to.setHours(23, 59, 59, 999);
        conditions.push(sql`${invoices.invoiceDate} <= ${to}`);
      }
      if (input.branchId) {
        conditions.push(eq(invoices.branchId, input.branchId));
      }
      if (input.sourceTypes && input.sourceTypes.length > 0) {
        conditions.push(inArray(invoices.sourceType, input.sourceTypes));
      }
      if (input.statuses && input.statuses.length > 0) {
        conditions.push(inArray(invoices.status, input.statuses));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          invoiceDate: invoices.invoiceDate,
          sourceType: invoices.sourceType,
          status: invoices.status,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          costTotal: invoices.costTotal,
          customerName: customers.name,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customerId, customers.id))
        .where(where)
        .orderBy(desc(invoices.invoiceDate));

      const totals = rows.reduce(
        (acc, r) => {
          const total = parseFloat(String(r.total ?? 0));
          const paid = parseFloat(String(r.paidAmount ?? 0));
          acc.total += total;
          acc.paid += paid;
          acc.unpaid += Math.max(0, total - paid);
          acc.count += 1;
          return acc;
        },
        { count: 0, total: 0, paid: 0, unpaid: 0 }
      );

      return {
        rows,
        totals: {
          count: totals.count,
          total: totals.total.toFixed(2),
          paid: totals.paid.toFixed(2),
          unpaid: totals.unpaid.toFixed(2),
        },
      };
    }),

  /** تدقيق التوافق المالي — للمشرف فقط. يكشف الانجراف الصامت في الأرصدة/المخزون/الدفتر. */
  reconcile: adminProcedure.query(async () => ({
    customers: await reconcileCustomerBalances(),
    inventory: await reconcileInventory(),
    ledger: await reconcileLedgerProfit(),
    runAt: new Date().toISOString(),
  })),
});
