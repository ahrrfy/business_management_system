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
import { protectedProcedure, router } from "../trpc";

export const reportsRouter = router({
  arAging: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input }) => getARAging({ branchId: input?.branchId })),

  customerStatement: protectedProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .query(async ({ input }) => getCustomerStatement(input.customerId)),

  /** Lightweight customer index for the statement picker. */
  customersIndex: protectedProcedure.query(async () => {
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

  apAging: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input }) => getAPAging({ branchId: input?.branchId })),

  supplierStatement: protectedProcedure
    .input(z.object({ supplierId: z.number().int().positive() }))
    .query(async ({ input }) => getSupplierStatement(input.supplierId)),

  /** Lightweight supplier index for the statement picker. */
  suppliersIndex: protectedProcedure.query(async () => {
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
});
