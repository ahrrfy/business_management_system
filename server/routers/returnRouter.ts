import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { customers, invoiceItems, invoices, productUnits, productVariants, products } from "../../drizzle/schema";
import { getDb } from "../db";
import { logAudit } from "../services/auditService";
import { returnSale } from "../services/returnService";
import { managerProcedure, router } from "../trpc";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);

// المرتجعات تعكس مخزوناً ونقداً ⇒ مدير فأعلى.
export const returnRouter = router({
  create: managerProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        lines: z.array(z.object({ invoiceItemId: z.number().int().positive(), baseQuantity: z.number().int().positive() })).min(1),
        refund: z.object({ amount: z.string(), method }).optional(),
        restock: z.boolean().optional(),
        // idempotency: نفس المفتاح ⇒ مرتجع واحد (لا استرداد/إرجاع/خصم AR مزدوج عند النقر المزدوج/إعادة الشبكة).
        clientRequestId: z.string().min(1).max(80).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await returnSale(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
          await logAudit(ctx, { action: "return.create", entityType: "invoice", entityId: input.invoiceId, newValue: { lines: input.lines.length, refund: input.refund?.amount } });
          return res;
        } catch (e: any) {
          if (e?.code === "ER_DUP_ENTRY" && attempt < 2) continue; // سباق نفس المفتاح ⇒ أعد المحاولة فيُرى المرتجع الأول replay
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إتمام المرتجع" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إتمام المرتجع (تكرار)" });
    }),

  getInvoice: managerProcedure.input(z.object({ invoiceId: z.number().int().positive() })).query(async ({ input }) => {
    const db = getDb();
    if (!db) return null;
    const inv = (
      await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          status: invoices.status,
          branchId: invoices.branchId,
          customerId: invoices.customerId,
          customerName: customers.name,
          subtotal: invoices.subtotal,
          discountAmount: invoices.discountAmount,
          taxAmount: invoices.taxAmount,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customerId, customers.id))
        .where(eq(invoices.id, input.invoiceId))
        .limit(1)
    )[0];
    if (!inv) return null;

    const rows = await db
      .select({
        invoiceItemId: invoiceItems.id,
        productName: products.name,
        variantName: productVariants.variantName,
        color: productVariants.color,
        size: productVariants.size,
        sku: productVariants.sku,
        unitName: productUnits.unitName,
        baseQuantity: invoiceItems.baseQuantity,
        returnedBaseQuantity: invoiceItems.returnedBaseQuantity,
        unitPrice: invoiceItems.unitPrice,
        total: invoiceItems.total,
      })
      .from(invoiceItems)
      .innerJoin(productVariants, eq(invoiceItems.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(productUnits, eq(invoiceItems.productUnitId, productUnits.id))
      .where(eq(invoiceItems.invoiceId, input.invoiceId));

    const items = rows.map((r) => {
      const variantLabel =
        r.variantName ?? ([r.color, r.size].filter((v): v is string => !!v).join(" / ") || r.sku);
      const remaining = r.baseQuantity - r.returnedBaseQuantity;
      return {
        invoiceItemId: Number(r.invoiceItemId),
        productName: r.productName,
        variantLabel,
        unitName: r.unitName ?? "",
        baseQuantity: r.baseQuantity,
        returnedBaseQuantity: r.returnedBaseQuantity,
        remaining,
        unitPrice: r.unitPrice,
        total: r.total,
      };
    });

    return {
      id: Number(inv.id),
      invoiceNumber: inv.invoiceNumber,
      status: inv.status,
      branchId: Number(inv.branchId),
      customerId: inv.customerId === null ? null : Number(inv.customerId),
      customerName: inv.customerName ?? null,
      subtotal: inv.subtotal,
      discountAmount: inv.discountAmount,
      taxAmount: inv.taxAmount,
      total: inv.total,
      paidAmount: inv.paidAmount,
      items,
    };
  }),
});
