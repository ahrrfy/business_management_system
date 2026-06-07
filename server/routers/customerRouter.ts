import { z } from "zod";
import {
  activateCustomer,
  createCustomer,
  deactivateCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
} from "../services/customerService";
import { logAudit } from "../services/auditService";
import { customerBarcodeSet } from "../services/barcodeService";
import { managerProcedure, protectedProcedure, router } from "../trpc";

const priceTier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);
const customerType = z.enum(["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"]);

/**
 * العملاء — شريحة كاملة:
 * list (بحث+فلاتر+تقسيم صفحات) / get / create / update / deactivate / activate.
 * `list` تبقى متوافقة مع شاشات الكاشير والقوائم المنسدلة (تعرض المفعّلين فقط بحدّ 500).
 */
export const customerRouter = router({
  /** قائمة بسيطة سريعة — يحتاجها الكاشير وأوامر الشغل والبيع الآجل. */
  list: protectedProcedure.query(async () => {
    const { rows } = await listCustomers({ includeInactive: false, limit: 500 });
    return rows;
  }),

  /** قائمة كاملة مع بحث وفلاتر وتقسيم صفحات — لشاشة الإدارة. */
  search: protectedProcedure
    .input(
      z
        .object({
          q: z.string().optional(),
          customerType: customerType.optional(),
          priceTier: priceTier.optional(),
          includeInactive: z.boolean().default(false),
          limit: z.number().int().positive().max(500).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional()
    )
    .query(({ input }) => listCustomers(input ?? {})),

  get: protectedProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const c = await getCustomer(input.customerId);
      if (!c) return null;
      const qrPayload = customerBarcodeSet({ id: c.id, name: c.name }).qrPayload;
      return { ...c, qrPayload };
    }),

  create: managerProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        phone: z.string().max(20).nullish(),
        whatsapp: z.string().max(20).nullish(),
        address: z.string().nullish(),
        city: z.string().max(100).nullish(),
        district: z.string().max(100).nullish(),
        customerType: customerType.default("فرد"),
        defaultPriceTier: priceTier.default("RETAIL"),
        creditLimit: z.string().nullish(),
        notes: z.string().nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const r = await createCustomer(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "customer.create", entityType: "customer", entityId: r.customerId, newValue: { name: input.name } });
      // التوافق: المستهلكون القدامى يقرؤون `.id` (مثل WorkOrderNew)؛ نُبقي الكليهما.
      return { id: r.customerId, customerId: r.customerId };
    }),

  update: managerProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        phone: z.string().max(20).nullish(),
        whatsapp: z.string().max(20).nullish(),
        address: z.string().nullish(),
        city: z.string().max(100).nullish(),
        district: z.string().max(100).nullish(),
        customerType: customerType.optional(),
        defaultPriceTier: priceTier.optional(),
        creditLimit: z.string().nullish(),
        notes: z.string().nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await updateCustomer(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "customer.update", entityType: "customer", entityId: input.customerId });
      return res;
    }),

  deactivate: managerProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await deactivateCustomer(input.customerId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "customer.deactivate", entityType: "customer", entityId: input.customerId });
      return res;
    }),

  activate: managerProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await activateCustomer(input.customerId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "customer.activate", entityType: "customer", entityId: input.customerId });
      return res;
    }),
});
