import { z } from "zod";
import {
  activateCustomer,
  createCustomer,
  deactivateCustomer,
  getCustomer,
  listCustomers,
  smartSearchCustomers,
  updateCustomer,
} from "../services/customerService";
import { logAudit } from "../services/auditService";
import { customerBarcodeSet } from "../services/barcodeService";
import { cashierProcedure, managerProcedure, protectedProcedure, router } from "../trpc";

const priceTier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);
const customerType = z.enum(["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"]);

/**
 * العملاء — شريحة كاملة:
 * list (بحث+فلاتر+تقسيم صفحات) / get / create / update / deactivate / activate / smartSearch.
 * `list` تبقى متوافقة مع شاشات الكاشير والقوائم المنسدلة (تعرض المفعّلين فقط بحدّ 500).
 *
 * v3-add-screens:
 *  - create: نقلناها لـ cashierProcedure لأن الكاشير قد يُنشئ زبوناً جديداً أثناء أمر شغل/بيع.
 *  - phone2/phone3 مضافان في input.
 *  - smartSearch: بحث مع إحصاءات (عدد طلبات/آخر طلب) لمكوّن `SmartCustomerInput`.
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

  /** بحث ذكي بإحصاءات — لإدخال أمر شغل سريع. */
  smartSearch: protectedProcedure
    .input(z.object({
      q: z.string().min(1).max(120),
      limit: z.number().int().min(1).max(20).optional(),
    }))
    .query(({ input }) => smartSearchCustomers(input)),

  get: protectedProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const c = await getCustomer(input.customerId);
      if (!c) return null;
      const qrPayload = customerBarcodeSet({ id: c.id, name: c.name }).qrPayload;
      return { ...c, qrPayload };
    }),

  create: cashierProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        phone: z.string().max(20).nullish(),
        phone2: z.string().max(20).nullish(),
        phone3: z.string().max(20).nullish(),
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
        phone2: z.string().max(20).nullish(),
        phone3: z.string().max(20).nullish(),
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
      // §٧ audit oldValue: نلتقط لقطة قبل التحديث لمسار تدقيق فروقات حقيقي.
      const before = await getCustomer(input.customerId);
      const res = await updateCustomer(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "customer.update",
        entityType: "customer",
        entityId: input.customerId,
        oldValue: before ? {
          name: before.name, phone: before.phone, phone2: before.phone2, phone3: before.phone3, whatsapp: before.whatsapp,
          address: before.address, city: before.city, district: before.district,
          customerType: before.customerType, defaultPriceTier: before.defaultPriceTier,
          creditLimit: before.creditLimit, notes: before.notes,
        } : null,
        newValue: {
          name: input.name, phone: input.phone, phone2: input.phone2, phone3: input.phone3, whatsapp: input.whatsapp,
          address: input.address, city: input.city, district: input.district,
          customerType: input.customerType, defaultPriceTier: input.defaultPriceTier,
          creditLimit: input.creditLimit, notes: input.notes,
        },
      });
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
