import { asc } from "drizzle-orm";
import { z } from "zod";
import { customers, suppliers } from "../../drizzle/schema";
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

  /** تدقيق التوافق المالي — للمشرف فقط. يكشف الانجراف الصامت في الأرصدة/المخزون/الدفتر. */
  reconcile: adminProcedure.query(async () => ({
    customers: await reconcileCustomerBalances(),
    inventory: await reconcileInventory(),
    ledger: await reconcileLedgerProfit(),
    runAt: new Date().toISOString(),
  })),
});
