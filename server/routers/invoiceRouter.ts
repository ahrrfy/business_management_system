import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { invoiceService } from "../services/invoiceService";
import { TRPCError } from "@trpc/server";

/**
 * ====================================
 * API الفواتير والمبيعات
 * ====================================
 */

const CreateInvoiceSchema = z.object({
  customerId: z.number().min(1),
  sourceType: z.enum(["POS", "ONLINE", "ORDER"]),
  sourceId: z.string().optional(),
  items: z.array(
    z.object({
      productId: z.number().min(1),
      quantity: z.number().min(1),
      unitPrice: z.number().min(0),
      discountPercent: z.number().min(0).max(100).optional(),
    })
  ),
  taxPercent: z.number().min(0).max(100).optional(),
  discountAmount: z.number().min(0).optional(),
  paymentMethod: z.string().optional(),
  notes: z.string().optional(),
});

const ProcessPaymentSchema = z.object({
  invoiceId: z.number().min(1),
  amount: z.number().min(0.01),
  paymentMethod: z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]),
  referenceNumber: z.string().optional(),
  checkNumber: z.string().optional(),
  cardLastFour: z.string().optional(),
});

export const invoiceRouter = router({
  /**
   * إنشاء فاتورة جديدة
   */
  create: protectedProcedure
    .input(CreateInvoiceSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const result = await invoiceService.createInvoice({
          ...input,
          createdBy: ctx.user.id,
        });

        return {
          success: true,
          data: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message,
        });
      }
    }),

  /**
   * معالجة الدفع
   */
  processPayment: protectedProcedure
    .input(ProcessPaymentSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const result = await invoiceService.processPayment({
          ...input,
          createdBy: ctx.user.id,
        });

        return {
          success: true,
          data: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message,
        });
      }
    }),

  /**
   * الحصول على تفاصيل الفاتورة
   */
  getDetails: protectedProcedure
    .input(z.object({ invoiceId: z.number().min(1) }))
    .query(async ({ input }) => {
      try {
        const invoice = await invoiceService.getInvoiceDetails(input.invoiceId);

        return {
          success: true,
          data: invoice,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new TRPCError({
          code: "NOT_FOUND",
          message,
        });
      }
    }),

  /**
   * قائمة الفواتير
   */
  list: protectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
      })
    )
    .query(async ({ input }) => {
      try {
        const invoices = await invoiceService.listInvoices(
          input.limit || 50,
          input.offset || 0
        );

        return {
          success: true,
          data: invoices,
          count: invoices.length,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message,
        });
      }
    }),

  /**
   * إحصائيات اليوم
   */
  getDailyStats: protectedProcedure
    .input(z.object({ date: z.date().optional() }))
    .query(async ({ input }) => {
      try {
        const date = input.date || new Date();
        const stats = await invoiceService.getDailyStatistics(date);

        return {
          success: true,
          data: stats,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message,
        });
      }
    }),
});
