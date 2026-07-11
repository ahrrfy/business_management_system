/**
 * storeAdminRouter — الجهة الإدارية للمتجر الإلكتروني (متجر `/store` العلني منفصل).
 * الحالي: orders (تثبيت الطلبات + طباعة الملصق). لاحقاً: banners + settings (لوحة hPanel).
 *
 * الأدوار: قراءة الطلبات = storeReadProcedure (مقيّد فرعاً)؛ تغيير الحالة = storeFulfillProcedure
 * (مدير/كاشير/مندوب مبيعات). عزل الفرع في setStatus مشتقٌّ من دور الفاعل (مرتفع ⇒ بلا قيد).
 */
import { z } from "zod";
import { logAudit } from "../services/auditService";
import { router, storeFulfillProcedure, storeManagerProcedure, storeReadProcedure } from "../trpc";
import {
  getOnlineOrder,
  listOnlineOrders,
  onlineOrderStatusCounts,
  setOnlineOrderStatus,
} from "../services/storeAdmin/orderFulfillmentService";
import {
  createBanner,
  deleteBanner,
  listBanners,
  updateBanner,
} from "../services/storeAdmin/bannerService";
import { getStoreSettings, updateStoreSettings } from "../services/storeAdmin/storeSettingsService";

const statusEnum = z.enum(["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"]);

/** الفرع المُسنَد للفاعل (مرتفع admin/manager ⇒ null بلا قيد؛ غيره ⇒ فرعه). */
function actorScopedBranch(user: { role: string; branchId: number | null }): number | null {
  const elevated = user.role === "admin" || user.role === "manager";
  return elevated ? null : (user.branchId != null ? Number(user.branchId) : null);
}

const ordersRouter = router({
  /** قائمة طلبات المتجر (اختياري: فلترة حالة). */
  list: storeReadProcedure
    .input(z.object({ status: statusEnum.nullish(), limit: z.number().int().min(1).max(300).default(100) }))
    .query(({ input, ctx }) =>
      listOnlineOrders({ scopedBranchId: ctx.scopedBranchId, status: input.status ?? null, limit: input.limit })
    ),

  /** عدّاد لكل حالة (بطاقات الإحصاء). */
  counts: storeReadProcedure.query(({ ctx }) => onlineOrderStatusCounts(ctx.scopedBranchId)),

  /** تفاصيل طلب (للملصق/العرض). */
  detail: storeReadProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input, ctx }) => getOnlineOrder(input.id, ctx.scopedBranchId)),

  /** تثبيت/نقل حالة الطلب (بحارس انتقال + تدقيق). */
  setStatus: storeFulfillProcedure
    .input(z.object({ id: z.number().int().positive(), status: statusEnum }))
    .mutation(async ({ input, ctx }) => {
      const scopedBranchId = actorScopedBranch(ctx.user);
      const res = await setOnlineOrderStatus({ id: input.id, status: input.status, scopedBranchId }, ctx.user.id);
      await logAudit(ctx, {
        action: "store.order.setStatus",
        entityType: "onlineOrder",
        entityId: input.id,
        oldValue: { status: res.from },
        newValue: { status: res.to },
      });
      return res;
    }),
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صحيح");
const bannerInput = z.object({
  title: z.string().trim().min(1).max(255),
  subtitle: z.string().max(500).nullish(),
  imageUrl: z.string().max(3_000_000).nullish(), // data-URL مضغوط
  ctaLabel: z.string().max(120).nullish(),
  ctaUrl: z.string().max(500).nullish(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
  effectiveFrom: dateStr.nullish(),
  effectiveTo: dateStr.nullish(),
  branchId: z.number().int().positive().nullish(),
});

/** بنرات المتجر (إدارة — storeManagerProcedure). */
const bannersRouter = router({
  list: storeReadProcedure.query(() => listBanners()),
  create: storeManagerProcedure.input(bannerInput).mutation(async ({ input, ctx }) => {
    const r = await createBanner(input, ctx.user.id);
    await logAudit(ctx, { action: "store.banner.create", entityType: "storeBanner", entityId: r.id, newValue: { title: input.title } });
    return r;
  }),
  update: storeManagerProcedure
    .input(z.object({ id: z.number().int().positive() }).and(bannerInput.partial()))
    .mutation(async ({ input, ctx }) => {
      const { id, ...rest } = input;
      const r = await updateBanner(id, rest);
      await logAudit(ctx, { action: "store.banner.update", entityType: "storeBanner", entityId: id, newValue: rest });
      return r;
    }),
  remove: storeManagerProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const r = await deleteBanner(input.id);
    await logAudit(ctx, { action: "store.banner.delete", entityType: "storeBanner", entityId: input.id });
    return r;
  }),
});

/** إعدادات المتجر (قراءة عامة للمصرَّح، تعديل مديري). */
const settingsRouter = router({
  get: storeReadProcedure.query(() => getStoreSettings()),
  update: storeManagerProcedure
    .input(z.object({ isOpen: z.boolean().optional(), announcement: z.string().max(500).nullish(), whatsappNumber: z.string().max(20).nullish() }))
    .mutation(async ({ input, ctx }) => {
      const r = await updateStoreSettings(input, ctx.user.id);
      await logAudit(ctx, { action: "store.settings.update", entityType: "storeSettings", entityId: 1, newValue: r });
      return r;
    }),
});

export const storeAdminRouter = router({
  orders: ordersRouter,
  banners: bannersRouter,
  settings: settingsRouter,
});
