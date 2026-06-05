import { z } from "zod";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { productService } from "../services/productService";
import { customerService } from "../services/customerService";

/**
 * ====================================
 * API المنتجات والعملاء
 * ====================================
 */

export const productRouter = router({
  /**
   * إنشاء منتج جديد
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1, "اسم المنتج مطلوب"),
        sku: z.string().min(1, "رقم المنتج مطلوب"),
        description: z.string().optional(),
        categoryId: z.number().optional(),
        costPrice: z.number().positive("السعر يجب أن يكون موجب"),
        salePrice: z.number().positive("السعر يجب أن يكون موجب"),
        wholesalePrice: z.number().optional(),
        quantityOnHand: z.number().nonnegative(),
        minStock: z.number().nonnegative(),
        maxStock: z.number().nonnegative(),
        reorderPoint: z.number().nonnegative(),
      })
    )
    .mutation(async ({ input }) => {
      return await productService.createProduct(input);
    }),

  /**
   * تحديث منتج
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().optional(),
        description: z.string().optional(),
        salePrice: z.number().optional(),
        costPrice: z.number().optional(),
        wholesalePrice: z.number().optional(),
        minStock: z.number().optional(),
        maxStock: z.number().optional(),
        reorderPoint: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      return await productService.updateProduct(input);
    }),

  /**
   * الحصول على تفاصيل المنتج
   */
  getDetails: publicProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      return await productService.getProduct(input.id);
    }),

  /**
   * البحث عن المنتجات
   */
  search: publicProcedure
    .input(
      z.object({
        query: z.string(),
        limit: z.number().optional().default(50),
      })
    )
    .query(async ({ input }) => {
      return await productService.searchProducts(input.query, input.limit);
    }),

  /**
   * قائمة المنتجات
   */
  list: publicProcedure
    .input(
      z.object({
        limit: z.number().optional().default(50),
        offset: z.number().optional().default(0),
      })
    )
    .query(async ({ input }) => {
      return await productService.listProducts(input.limit, input.offset);
    }),

  /**
   * المنتجات المنخفضة المخزون
   */
  getLowStock: publicProcedure.query(async () => {
    return await productService.getLowStockProducts();
  }),

  /**
   * حساب قيمة المخزون
   */
  getInventoryValue: publicProcedure.query(async () => {
    return await productService.getInventoryValue();
  }),

  /**
   * حذف منتج
   */
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      return await productService.deleteProduct(input.id);
    }),
});

export const customerRouter = router({
  /**
   * إنشاء عميل جديد
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1, "اسم العميل مطلوب"),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        country: z.string().optional(),
        taxId: z.string().optional(),
        creditLimit: z.number().optional(),
        customerType: z.enum(["INDIVIDUAL", "BUSINESS"]).optional(),
      })
    )
    .mutation(async ({ input }) => {
      return await customerService.createCustomer(input);
    }),

  /**
   * تحديث عميل
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        country: z.string().optional(),
        taxId: z.string().optional(),
        creditLimit: z.number().optional(),
        customerType: z.enum(["INDIVIDUAL", "BUSINESS"]).optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      return await customerService.updateCustomer(input);
    }),

  /**
   * الحصول على تفاصيل العميل
   */
  getDetails: publicProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      return await customerService.getCustomer(input.id);
    }),

  /**
   * البحث عن العملاء
   */
  search: publicProcedure
    .input(
      z.object({
        query: z.string(),
        limit: z.number().optional().default(50),
      })
    )
    .query(async ({ input }) => {
      return await customerService.searchCustomers(input.query, input.limit);
    }),

  /**
   * قائمة العملاء
   */
  list: publicProcedure
    .input(
      z.object({
        limit: z.number().optional().default(50),
        offset: z.number().optional().default(0),
      })
    )
    .query(async ({ input }) => {
      return await customerService.listCustomers(input.limit, input.offset);
    }),

  /**
   * حذف عميل
   */
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      return await customerService.deleteCustomer(input.id);
    }),

  /**
   * تحديث رصيد العميل
   */
  updateBalance: protectedProcedure
    .input(
      z.object({
        customerId: z.number(),
        amount: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      return await customerService.updateCustomerBalance(
        input.customerId,
        input.amount
      );
    }),
});
