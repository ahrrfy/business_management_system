import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  customers,
  invoiceItems,
  invoices,
  productUnits,
  productVariants,
  products,
  receipts,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { users } from "../../drizzle/schema";
import { verifyPassword } from "../auth/password";
import { logAudit } from "../services/auditService";
import { createSale, processPayment } from "../services/saleService";
import { branchScopedProcedure, canSeeCost, cashierProcedure, router } from "../trpc";
import { invoiceBarcodeSet } from "../services/barcodeService";

/** يتحقّق من هوية مدير (بريد + كلمة مرور) لاعتماد تجاوز حدّ الائتمان. يعيد معرّف المدير. */
async function verifyManagerApproval(approval: { email: string; password: string }): Promise<number> {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const u = (await db.select().from(users).where(eq(users.email, approval.email.trim().toLowerCase())).limit(1))[0];
  const ok = u && u.isActive !== false && verifyPassword(approval.password, u.passwordHash) && (u.role === "manager" || u.role === "admin");
  if (!ok) throw new TRPCError({ code: "FORBIDDEN", message: "موافقة المدير غير صالحة (تأكّد من البريد وكلمة المرور وأنّ الحساب مدير)." });
  return Number(u.id);
}

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
const tier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);
const lineSchema = z.object({
  variantId: z.number().int().positive(),
  productUnitId: z.number().int().positive(),
  quantity: z.string(),
  unitPriceOverride: z.string().optional(),
  discountPercent: z.string().optional(),
  discountAmount: z.string().optional(),
});

export const saleRouter = router({
  create: cashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive().optional(),
        customerId: z.number().int().positive().optional(),
        priceTier: tier.optional(),
        sourceType: z.enum(["POS", "ONLINE", "ORDER", "WORKORDER"]).default("POS"),
        lines: z.array(lineSchema).min(1),
        invoiceDiscount: z.string().optional(),
        taxRatePercent: z.string().optional(),
        payment: z.object({ amount: z.string(), method }).optional(),
        clientRequestId: z.string().optional(),
        notes: z.string().optional(),
        // موافقة مدير لتجاوز حدّ الائتمان (بريد+كلمة مرور، تُتحقَّق خادمياً).
        managerApproval: z.object({ email: z.string().min(1), password: z.string().min(1) }).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: غير المدير يُجبَر على فرعه (لا يُصدَّق branchId القادم من العميل — منع IDOR).
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      const effectiveBranchId = elevated ? input.branchId : (ctx.user.branchId ?? input.branchId);
      const actor = { userId: ctx.user.id, branchId: effectiveBranchId };
      let approvedBy: number | null = null;
      const { managerApproval, ...saleInput } = input;
      if (managerApproval) approvedBy = await verifyManagerApproval(managerApproval);
      const effectiveInput = { ...saleInput, branchId: effectiveBranchId, creditApproved: approvedBy != null };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createSale(effectiveInput, actor);
          await logAudit(ctx, { action: "sale.create", entityType: "invoice", entityId: (res as { invoiceId?: number })?.invoiceId, newValue: { lines: input.lines.length, creditApprovedBy: approvedBy } });
          if (approvedBy != null) await logAudit(ctx, { action: "sale.creditOverride", entityType: "invoice", entityId: (res as { invoiceId?: number })?.invoiceId, newValue: { approvedByManagerId: approvedBy } });
          return res;
        } catch (e: any) {
          if (e?.code === "ER_DUP_ENTRY" && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إتمام البيع" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر توليد رقم فاتورة فريد" });
    }),

  pay: cashierProcedure
    .input(z.object({ invoiceId: z.number().int().positive(), amount: z.string(), method, shiftId: z.number().int().positive().optional() }))
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: غير المدير يُرفض دفعه على فاتورة فرع آخر (منع IDOR).
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      const enforceBranchId = elevated ? null : (ctx.user.branchId ?? -1);
      const res = await processPayment({ ...input, enforceBranchId }, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "sale.pay", entityType: "invoice", entityId: input.invoiceId, newValue: { amount: input.amount, method: input.method } });
      return res;
    }),

  // عزل الفرع: غير المدير يرى فواتير فرعه فقط (منع IDOR).
  list: branchScopedProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }).optional())
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      return db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          sourceType: invoices.sourceType,
          invoiceDate: invoices.invoiceDate,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          status: invoices.status,
          customerName: customers.name,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customerId, customers.id))
        .where(ctx.scopedBranchId ? eq(invoices.branchId, ctx.scopedBranchId) : undefined)
        .orderBy(desc(invoices.id))
        .limit(input?.limit ?? 50)
        .offset(input?.offset ?? 0);
    }),

  get: branchScopedProcedure.input(z.object({ invoiceId: z.number().int().positive() })).query(async ({ input, ctx }) => {
    const db = getDb();
    if (!db) return null;
    const inv = (
      await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          sourceType: invoices.sourceType,
          branchId: invoices.branchId,
          customerId: invoices.customerId,
          customerName: customers.name,
          customerBalance: customers.currentBalance,
          priceTier: invoices.priceTier,
          invoiceDate: invoices.invoiceDate,
          dueDate: invoices.dueDate,
          subtotal: invoices.subtotal,
          taxAmount: invoices.taxAmount,
          discountAmount: invoices.discountAmount,
          total: invoices.total,
          costTotal: invoices.costTotal,
          paidAmount: invoices.paidAmount,
          status: invoices.status,
          paymentMethod: invoices.paymentMethod,
          notes: invoices.notes,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customerId, customers.id))
        .where(eq(invoices.id, input.invoiceId))
        .limit(1)
    )[0];
    if (!inv) return null;
    // عزل الفرع: لا تكشف وجود فاتورة فرع آخر لغير المدير.
    if (ctx.scopedBranchId && inv.branchId !== ctx.scopedBranchId) return null;
    const items = await db
      .select({
        id: invoiceItems.id,
        variantId: invoiceItems.variantId,
        productUnitId: invoiceItems.productUnitId,
        quantity: invoiceItems.quantity,
        baseQuantity: invoiceItems.baseQuantity,
        returnedBaseQuantity: invoiceItems.returnedBaseQuantity,
        unitPrice: invoiceItems.unitPrice,
        unitCost: invoiceItems.unitCost,
        discountAmount: invoiceItems.discountAmount,
        total: invoiceItems.total,
        productName: products.name,
        sku: productVariants.sku,
        variantName: productVariants.variantName,
        unitName: productUnits.unitName,
      })
      .from(invoiceItems)
      .leftJoin(productVariants, eq(invoiceItems.variantId, productVariants.id))
      .leftJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(productUnits, eq(invoiceItems.productUnitId, productUnits.id))
      .where(eq(invoiceItems.invoiceId, input.invoiceId));
    const payments = await db
      .select({
        id: receipts.id,
        direction: receipts.direction,
        amount: receipts.amount,
        paymentMethod: receipts.paymentMethod,
        status: receipts.status,
        createdAt: receipts.createdAt,
      })
      .from(receipts)
      .where(eq(receipts.invoiceId, input.invoiceId))
      .orderBy(asc(receipts.id));

    // توليد qrPayload موقَّعة بـ HMAC من الخادم — الواجهة تعرضها فقط
    const qrPayload = invoiceBarcodeSet({
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: String(inv.invoiceDate),
      total: inv.total,
      branchId: inv.branchId,
    }).qrPayload;

    // حجب التكلفة عن غير المدير (منع كشف هامش الربح).
    if (!canSeeCost(ctx.user.role)) {
      const { costTotal: _c, ...invNoCost } = inv;
      const itemsNoCost = items.map(({ unitCost: _u, ...rest }) => rest);
      return { ...invNoCost, items: itemsNoCost, payments, qrPayload };
    }
    return { ...inv, items, payments, qrPayload };
  }),
});
