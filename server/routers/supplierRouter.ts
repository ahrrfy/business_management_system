import { z } from "zod";
import { logAudit } from "../services/auditService";
import {
  activateSupplier,
  createSupplier,
  deactivateSupplier,
  getSupplier,
  listSuppliers,
  updateSupplier,
} from "../services/supplierService";
import { managerProcedure, protectedProcedure, router } from "../trpc";

/**
 * الموردون — شريحة كاملة: list/search/get (قراءة) + create/update/deactivate/activate (مدير).
 * `list` تبقى قائمة بسيطة (المفعّلون) لشاشة المشتريات والقوائم المنسدلة.
 */
export const supplierRouter = router({
  /** قائمة بسيطة سريعة — تحتاجها شاشة المشتريات. */
  list: protectedProcedure.query(async () => {
    const { rows } = await listSuppliers({ includeInactive: false, limit: 500 });
    return rows;
  }),

  /** قائمة كاملة مع بحث وتقسيم صفحات — لشاشة الإدارة. */
  search: protectedProcedure
    .input(
      z
        .object({
          q: z.string().optional(),
          includeInactive: z.boolean().default(false),
          limit: z.number().int().positive().max(500).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional()
    )
    .query(({ input }) => listSuppliers(input ?? {})),

  get: protectedProcedure
    .input(z.object({ supplierId: z.number().int().positive() }))
    .query(({ input }) => getSupplier(input.supplierId)),

  create: managerProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        phone: z.string().max(20).nullish(),
        email: z.string().max(320).nullish(),
        whatsapp: z.string().max(20).nullish(),
        address: z.string().nullish(),
        city: z.string().max(100).nullish(),
        taxId: z.string().max(50).nullish(),
        productTypes: z.string().nullish(),
        paymentTerms: z.string().max(100).nullish(),
        notes: z.string().nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const r = await createSupplier(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "supplier.create", entityType: "supplier", entityId: r.supplierId, newValue: { name: input.name } });
      return r;
    }),

  update: managerProcedure
    .input(
      z.object({
        supplierId: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        phone: z.string().max(20).nullish(),
        email: z.string().max(320).nullish(),
        whatsapp: z.string().max(20).nullish(),
        address: z.string().nullish(),
        city: z.string().max(100).nullish(),
        taxId: z.string().max(50).nullish(),
        productTypes: z.string().nullish(),
        paymentTerms: z.string().max(100).nullish(),
        notes: z.string().nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await updateSupplier(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "supplier.update", entityType: "supplier", entityId: input.supplierId });
      return res;
    }),

  deactivate: managerProcedure
    .input(z.object({ supplierId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await deactivateSupplier(input.supplierId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "supplier.deactivate", entityType: "supplier", entityId: input.supplierId });
      return res;
    }),

  activate: managerProcedure
    .input(z.object({ supplierId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await activateSupplier(input.supplierId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "supplier.activate", entityType: "supplier", entityId: input.supplierId });
      return res;
    }),
});
