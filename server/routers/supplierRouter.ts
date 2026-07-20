import { z } from "zod";
import { maskBankFields, maskSupplierSensitive } from "../lib/redact";
import { logAudit } from "../services/auditService";
import {
  activateSupplier,
  createSupplier,
  deactivateSupplier,
  findSimilarSuppliers,
  getSupplier,
  listSuppliers,
  updateSupplier,
} from "../services/supplierService";
import { protectedProcedure, router, suppliersManagerProcedure, suppliersReadProcedure } from "../trpc";

/**
 * الموردون — شريحة كاملة.
 * v3-add-screens: phone2/phone3 + supplierCategory + leadTimeDays + minOrderAmount + rating + iban + bankName.
 * البريد محتفظ به للتوافق فقط (لا يُعرض في النموذج). الواجهة لا ترسله ⇒ يبقى ما هو مخزّن.
 */
export const supplierRouter = router({
  /** قائمة بسيطة سريعة — لشاشة المشتريات والقوائم (مدير/أدمن فقط). */
  list: suppliersReadProcedure.query(async ({ ctx }) => {
    const { rows } = await listSuppliers({ includeInactive: false, limit: 500 });
    return rows.map((r) => maskSupplierSensitive(r, ctx.user.role));
  }),

  search: suppliersReadProcedure
    .input(
      z
        .object({
          q: z.string().optional(),
          includeInactive: z.boolean().default(false),
          // الفجوة ١٦: الحد الأعلى ٢٠٠٠ مطابقاً للخدمة (افتراضي ١٠٠).
          limit: z.number().int().positive().max(2000).default(100),
          offset: z.number().int().min(0).default(0),
          // بضاعة الأمانة: فلتر نوع الطرف (منتقي المودِعين + فلتر شاشة الموردين).
          kind: z.enum(["REGULAR", "CONSIGNOR"]).optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const res = await listSuppliers(input ?? {});
      return { ...res, rows: res.rows.map((r) => maskSupplierSensitive(r, ctx.user.role)) };
    }),

  get: suppliersReadProcedure
    .input(z.object({ supplierId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const row = await getSupplier(input.supplierId);
      return maskBankFields(maskSupplierSensitive(row, ctx.user.role), ctx.user.role);
    }),

  /** dup-detect (٢٠/٧): مرشّحو تكرار محتمَل لشاشة الإضافة — تحذير حيّ قبل الحفظ (لا حجب).
   *  مرآة customers.findSimilar (أغلبية كلمات على searchNorm + لاحقة هاتف + شمول المعطَّلين).
   *  لا يُعيد أرصدة/حقولاً بنكية ⇒ لا يحتاج حجباً. */
  findSimilar: suppliersReadProcedure
    .input(
      z.object({
        name: z.string().max(255).optional(),
        phones: z.array(z.string().max(25)).max(4).optional(),
      })
    )
    .query(({ input }) => findSimilarSuppliers(input)),

  create: suppliersManagerProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        phone: z.string().max(20).nullish(),
        phone2: z.string().max(20).nullish(),
        phone3: z.string().max(20).nullish(),
        email: z.string().max(320).nullish(),
        whatsapp: z.string().max(20).nullish(),
        address: z.string().nullish(),
        city: z.string().max(100).nullish(),
        taxId: z.string().max(50).nullish(),
        productTypes: z.string().nullish(),
        paymentTerms: z.string().max(100).nullish(),
        supplierCategory: z.string().max(40).nullish(),
        leadTimeDays: z.number().int().min(0).max(365).nullish(),
        minOrderAmount: z.string().nullish(),
        rating: z.number().int().min(0).max(5).nullish(),
        iban: z.string().max(64).nullish(),
        bankName: z.string().max(120).nullish(),
        notes: z.string().nullish(),
        // بضاعة الأمانة (٢٠/٧): نوع الطرف + حقول اتفاقية المودِع.
        supplierKind: z.enum(["REGULAR", "CONSIGNOR"]).optional(),
        settlementCycle: z.string().max(20).nullish(),
        abandonedAfterMonths: z.number().int().min(1).max(120).nullish(),
        autoSettleThreshold: z.string().max(20).nullish(),
        agreementNotes: z.string().nullish(),
        agreementAttachmentUrl: z.string().nullish(),
        // رصيد افتتاحي اختياري + اتجاه الدين (المورّد: موجب افتراضاً = «علينا له»).
        openingBalance: z.string().nullish(),
        openingBalanceDirection: z.enum(["OWED_TO_US", "OWED_BY_US"]).optional(),
        // مفتاح idempotency من النموذج (UUID لكل فتح) — إعادة الإرسال تعيد نفس المورّد (هجرة 0090).
        clientRequestId: z.string().min(8).max(64).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // AUTHZ-3 (تدقيق ١٧/٧): الرصيد الافتتاحي حقلٌ ماليّ للمدير — لا يَضبطه المخزن/المشتريات كتابةً
      // (suppliersManagerProcedure يسمح لهما بالعبور). نُجرّده (null ⇒ لا قيد افتتاحي) لغير المرتفعين،
      // مطابقةً لنمط customerRouter. الرصيد الافتتاحي «علينا له» يُنشئ ذمّة دائنة يجب أن يعتمدها المدير.
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      const safeInput = elevated ? input : { ...input, openingBalance: null };
      const r = await createSupplier(safeInput, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      // إعادة تشغيل idempotent = لا كتابة جديدة ⇒ لا نكرّر سجلّ التدقيق (نمط customerRouter).
      if (!r.idempotentReplay) {
        await logAudit(ctx, { action: "supplier.create", entityType: "supplier", entityId: r.supplierId, newValue: { name: input.name, openingBalanceSet: elevated && !!input.openingBalance } });
      }
      return r;
    }),

  update: suppliersManagerProcedure
    .input(
      z.object({
        supplierId: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        phone: z.string().max(20).nullish(),
        phone2: z.string().max(20).nullish(),
        phone3: z.string().max(20).nullish(),
        email: z.string().max(320).nullish(),
        whatsapp: z.string().max(20).nullish(),
        address: z.string().nullish(),
        city: z.string().max(100).nullish(),
        taxId: z.string().max(50).nullish(),
        productTypes: z.string().nullish(),
        paymentTerms: z.string().max(100).nullish(),
        supplierCategory: z.string().max(40).nullish(),
        leadTimeDays: z.number().int().min(0).max(365).nullish(),
        minOrderAmount: z.string().nullish(),
        rating: z.number().int().min(0).max(5).nullish(),
        iban: z.string().max(64).nullish(),
        bankName: z.string().max(120).nullish(),
        notes: z.string().nullish(),
        supplierKind: z.enum(["REGULAR", "CONSIGNOR"]).optional(),
        settlementCycle: z.string().max(20).nullish(),
        abandonedAfterMonths: z.number().int().min(1).max(120).nullish(),
        autoSettleThreshold: z.string().max(20).nullish(),
        agreementNotes: z.string().nullish(),
        agreementAttachmentUrl: z.string().nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const before = await getSupplier(input.supplierId);
      const res = await updateSupplier(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "supplier.update",
        entityType: "supplier",
        entityId: input.supplierId,
        oldValue: before ? {
          name: before.name, phone: before.phone, phone2: before.phone2, phone3: before.phone3,
          email: before.email, whatsapp: before.whatsapp, address: before.address, city: before.city,
          taxId: before.taxId, productTypes: before.productTypes, paymentTerms: before.paymentTerms,
          supplierCategory: before.supplierCategory, leadTimeDays: before.leadTimeDays,
          minOrderAmount: before.minOrderAmount, rating: before.rating,
          iban: before.iban, bankName: before.bankName, notes: before.notes,
        } : null,
        newValue: input,
      });
      return res;
    }),

  deactivate: suppliersManagerProcedure
    .input(z.object({ supplierId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await deactivateSupplier(input.supplierId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "supplier.deactivate", entityType: "supplier", entityId: input.supplierId });
      return res;
    }),

  activate: suppliersManagerProcedure
    .input(z.object({ supplierId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await activateSupplier(input.supplierId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "supplier.activate", entityType: "supplier", entityId: input.supplierId });
      return res;
    }),
});
