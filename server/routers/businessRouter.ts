import { z } from "zod";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  suppliers,
  purchaseOrders,
  purchaseOrderItems,
  receipts,
  accountingEntries,
  employees,
  attendance,
  products,
} from "../../drizzle/schema";
import { eq, desc, sql, gte, like } from "drizzle-orm";

/**
 * ====================================
 * API الموردين
 * ====================================
 */
export const supplierRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        country: z.string().optional(),
        taxId: z.string().optional(),
        paymentTerms: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.insert(suppliers).values({
        name: input.name,
        email: input.email,
        phone: input.phone,
        address: input.address,
        city: input.city,
        country: input.country,
        taxId: input.taxId,
        paymentTerms: input.paymentTerms,
      });
      return { success: true };
    }),

  list: publicProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return await db.select().from(suppliers).limit(input.limit).offset(input.offset).orderBy(desc(suppliers.createdAt));
    }),

  search: publicProcedure
    .input(z.object({ query: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return await db.select().from(suppliers).where(like(suppliers.name, `%${input.query}%`)).limit(50);
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.delete(suppliers).where(eq(suppliers.id, input.id));
      return { success: true };
    }),
});

/**
 * ====================================
 * API المشتريات
 * ====================================
 */
export const purchaseRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        supplierId: z.number(),
        items: z.array(
          z.object({
            productId: z.number(),
            quantity: z.number().positive(),
            unitPrice: z.number().positive(),
          })
        ),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const subtotal = input.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
      const taxAmount = subtotal * 0.15; // 15% VAT
      const total = subtotal + taxAmount;
      const poNumber = `PO-${Date.now().toString(36).toUpperCase()}`;

      const [order] = await db.insert(purchaseOrders).values({
        poNumber,
        supplierId: input.supplierId,
        subtotal: subtotal.toString(),
        taxAmount: taxAmount.toString(),
        total: total.toString(),
        status: "DRAFT",
        createdBy: ctx.user.id,
        orderDate: new Date(),
      }).$returningId();

      for (const item of input.items) {
        await db.insert(purchaseOrderItems).values({
          purchaseOrderId: order.id,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice.toString(),
          total: (item.quantity * item.unitPrice).toString(),
        });
      }

      return { success: true, poNumber };
    }),

  list: publicProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return await db.select().from(purchaseOrders).limit(input.limit).offset(input.offset).orderBy(desc(purchaseOrders.createdAt));
    }),

  receive: protectedProcedure
    .input(z.object({ orderId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Update order status
      await db.update(purchaseOrders).set({ status: "RECEIVED" }).where(eq(purchaseOrders.id, input.orderId));

      // Update stock
      const items = await db.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.purchaseOrderId, input.orderId));
      for (const item of items) {
        await db.update(products).set({
          quantityOnHand: sql`${products.quantityOnHand} + ${item.quantity}`,
        }).where(eq(products.id, item.productId));
      }

      return { success: true };
    }),
});

/**
 * ====================================
 * API الحسابات والمالية
 * ====================================
 */
export const accountsRouter = router({
  // إضافة مقبوض جديد
  createReceipt: protectedProcedure
    .input(
      z.object({
        invoiceId: z.number(),
        amount: z.number().positive(),
        paymentMethod: z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]),
        referenceNumber: z.string().optional(),
        checkNumber: z.string().optional(),
        cardLastFour: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.insert(receipts).values({
        invoiceId: input.invoiceId,
        amount: input.amount.toString(),
        paymentMethod: input.paymentMethod,
        referenceNumber: input.referenceNumber || null,
        checkNumber: input.checkNumber || null,
        cardLastFour: input.cardLastFour || null,
        status: "COMPLETED",
        createdBy: ctx.user.id,
      });
      return { success: true };
    }),

  // إضافة قيد محاسبي
  createEntry: protectedProcedure
    .input(
      z.object({
        invoiceId: z.number().optional(),
        revenue: z.number().default(0),
        cost: z.number().default(0),
        profit: z.number().default(0),
        taxAmount: z.number().default(0),
        entryDate: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.insert(accountingEntries).values({
        revenue: input.revenue.toString(),
        cost: input.cost.toString(),
        profit: input.profit.toString(),
        taxAmount: input.taxAmount.toString(),
        entryDate: new Date(input.entryDate),
      });
      return { success: true };
    }),

  // ملخص مالي
  getSummary: publicProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { totalReceipts: 0, totalPayments: 0, netProfit: 0, totalRevenue: 0, totalCost: 0 };

    const [receiptTotal] = await db
      .select({ total: sql<string>`COALESCE(SUM(amount), 0)` })
      .from(receipts);

    const [accounting] = await db
      .select({
        revenue: sql<string>`COALESCE(SUM(revenue), 0)`,
        cost: sql<string>`COALESCE(SUM(cost), 0)`,
        profit: sql<string>`COALESCE(SUM(profit), 0)`,
      })
      .from(accountingEntries);

    const totalReceipts = parseFloat(receiptTotal?.total || "0");
    const totalRevenue = parseFloat(accounting?.revenue || "0");
    const totalCost = parseFloat(accounting?.cost || "0");
    const netProfit = parseFloat(accounting?.profit || "0");

    return {
      totalReceipts,
      totalPayments: totalCost,
      netProfit,
      totalRevenue,
      totalCost,
    };
  }),

  // قائمة المقبوضات
  listReceipts: publicProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return await db.select().from(receipts).limit(input.limit).offset(input.offset).orderBy(desc(receipts.createdAt));
    }),

  // قائمة القيود المحاسبية
  listEntries: publicProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return await db.select().from(accountingEntries).limit(input.limit).offset(input.offset).orderBy(desc(accountingEntries.createdAt));
    }),
});

/**
 * ====================================
 * API حركات المخزون
 * ====================================
 */
import { inventoryMovements } from "../../drizzle/schema";

export const inventoryRouter = router({
  // إضافة حركة مخزون
  createMovement: protectedProcedure
    .input(
      z.object({
        productId: z.number(),
        movementType: z.enum(["IN", "OUT", "ADJUST", "RETURN"]),
        quantity: z.number(),
        referenceType: z.string().optional(),
        referenceId: z.number().optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // إضافة حركة المخزون
      await db.insert(inventoryMovements).values({
        productId: input.productId,
        movementType: input.movementType,
        quantity: input.quantity,
        referenceType: input.referenceType || null,
        referenceId: input.referenceId || null,
        notes: input.notes || null,
        createdBy: ctx.user.id,
      });

      // تحديث الكمية في المنتج
      const quantityChange = input.movementType === "IN" || input.movementType === "RETURN"
        ? input.quantity
        : -input.quantity;

      await db.update(products).set({
        quantityOnHand: sql`${products.quantityOnHand} + ${quantityChange}`,
      }).where(eq(products.id, input.productId));

      return { success: true };
    }),

  // قائمة حركات المخزون
  listMovements: publicProcedure
    .input(
      z.object({
        productId: z.number().optional(),
        limit: z.number().default(50),
        offset: z.number().default(0),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      if (input.productId) {
        return await db.select().from(inventoryMovements).where(eq(inventoryMovements.productId, input.productId)).orderBy(desc(inventoryMovements.createdAt)).limit(input.limit).offset(input.offset);
      }

      return await db.select().from(inventoryMovements).orderBy(desc(inventoryMovements.createdAt)).limit(input.limit).offset(input.offset);
    }),

  // ملخص المخزون
  getSummary: publicProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { totalProducts: 0, lowStockCount: 0, totalValue: 0 };

    const [productCount] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(products)
      .where(eq(products.isActive, true));

    const [lowStock] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(products)
      .where(sql`${products.quantityOnHand} <= ${products.minStock} AND ${products.isActive} = true`);

    const [totalVal] = await db
      .select({ total: sql<string>`COALESCE(SUM(CAST(salePrice AS DECIMAL(15,2)) * quantityOnHand), 0)` })
      .from(products)
      .where(eq(products.isActive, true));

    return {
      totalProducts: productCount?.count || 0,
      lowStockCount: lowStock?.count || 0,
      totalValue: parseFloat(totalVal?.total || "0"),
    };
  }),
});

/**
 * ====================================
 * API الموارد البشرية
 * ====================================
 */
export const hrRouter = router({
  // إنشاء موظف
  createEmployee: protectedProcedure
    .input(
      z.object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        email: z.string().email(),
        phone: z.string().optional(),
        position: z.string().optional(),
        department: z.string().optional(),
        salary: z.number().positive(),
        hireDate: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db.insert(employees).values({
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        position: input.position,
        department: input.department,
        salary: input.salary.toString(),
        hireDate: input.hireDate ? new Date(input.hireDate) : new Date(),
        isActive: true,
      });

      return { success: true };
    }),

  // قائمة الموظفين
  listEmployees: publicProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return await db.select().from(employees).limit(input.limit).offset(input.offset).orderBy(desc(employees.createdAt));
    }),

  // حذف موظف (تعطيل)
  deleteEmployee: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.update(employees).set({ isActive: false }).where(eq(employees.id, input.id));
      return { success: true };
    }),

  // ملخص الموارد البشرية
  getSummary: publicProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { totalEmployees: 0, totalSalaries: 0, activeToday: 0 };

    const [empCount] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(employees)
      .where(eq(employees.isActive, true));

    const [salaryTotal] = await db
      .select({ total: sql<string>`COALESCE(SUM(salary), 0)` })
      .from(employees)
      .where(eq(employees.isActive, true));

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [attendanceCount] = await db
      .select({ count: sql<number>`COUNT(DISTINCT employeeId)` })
      .from(attendance)
      .where(gte(attendance.checkIn, today));

    return {
      totalEmployees: empCount?.count || 0,
      totalSalaries: parseFloat(salaryTotal?.total || "0"),
      activeToday: attendanceCount?.count || 0,
    };
  }),
});
