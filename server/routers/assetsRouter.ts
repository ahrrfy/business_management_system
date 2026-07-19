/* ============================================================================
 * موجّه tRPC للأصول الثابتة — server/routers/assetsRouter.ts
 * القراءة بصلاحية assets/READ، والكتابة بـ assets/FULL (requireModule). كل كتابة تُدقَّق (audit).
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  ASSET_CATEGORY_KEYS,
  ASSET_STATUS_KEYS,
  DEPRECIATION_METHOD_KEYS,
} from "@shared/assets";
import { logAudit } from "../services/auditService";
import * as svc from "../services/assetsService";
import { money } from "../services/money";
import { protectedProcedure, requireModule, router } from "../trpc";
import { isDupEntry } from "@shared/errorMap.ar";

const assetRead = protectedProcedure.use(requireModule("assets", "READ"));
const assetWrite = protectedProcedure.use(requireModule("assets", "FULL"));

const categoryEnum = z.enum(ASSET_CATEGORY_KEYS);
const statusEnum = z.enum(ASSET_STATUS_KEYS);
const methodEnum = z.enum(DEPRECIATION_METHOD_KEYS);
// مبلغ مالي: رقم موجب بمنزلتين عشريتين كحدّ أقصى (يصدّ NaN/السالب/الفواصل قبل بلوغ القاعدة).
const moneyStr = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "قيمة مالية غير صالحة (رقم موجب بمنزلتين كحدّ أقصى)");
const moneyStrOpt = moneyStr.optional();

export const assetsRouter = router({
  list: assetRead
    .input(
      z
        .object({
          category: categoryEnum.optional(),
          branchId: z.number().int().positive().optional(),
          status: statusEnum.optional(),
          includeDisposed: z.boolean().optional(),
        })
        .optional(),
    )
    .query(({ input }) => svc.listAssets(input)),

  get: assetRead.input(z.object({ id: z.number().int().positive() })).query(({ input }) => svc.getAsset(input.id)),

  dashboard: assetRead.query(() => svc.dashboard()),
  custodyReport: assetRead.query(() => svc.custodyReport()),
  disposalLog: assetRead.query(() => svc.disposalLog()),
  formOptions: assetRead.query(() => svc.formOptions()),

  create: assetWrite
    .input(
      z.object({
        name: z.string().trim().min(1, "اسم الأصل مطلوب"),
        category: categoryEnum,
        brand: z.string().trim().optional(),
        serial: z.string().trim().optional(),
        branchId: z.number().int().positive().optional(),
        location: z.string().trim().optional(),
        custodianId: z.number().int().positive().nullish(),
        supplierId: z.number().int().positive().optional(),
        purchaseDate: z.string().min(1), // YYYY-MM-DD
        purchaseValue: moneyStr,
        salvageValue: moneyStrOpt,
        usefulLifeYears: z.number().int().positive().max(100),
        depreciationMethod: methodEnum.default("sl"),
        condition: z.string().trim().optional(),
        warrantyEnd: z.string().optional(),
        linkedDeviceId: z.number().int().positive().optional(),
      }).refine(
        (d) => {
          const re = /^\d+(\.\d{1,2})?$/;
          if (!re.test(d.purchaseValue) || (d.salvageValue && !re.test(d.salvageValue))) return true; // الحقول تتكفّل بخطأ الصيغة
          return money(d.salvageValue ?? "0").lte(money(d.purchaseValue));
        },
        { message: "القيمة التخريدية يجب ألا تتجاوز قيمة الشراء", path: ["salvageValue"] },
      ),
    )
    .mutation(async ({ input, ctx }) => {
      // قيد UNIQUE على code هو الحارس النهائي لترقيم AST تحت FOR UPDATE ⇒ أعد المحاولة على التضارب.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const a = await svc.createAsset(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0, role: ctx.user.role });
          await logAudit(ctx, {
            action: "asset.create",
            entityType: "fixedAsset",
            entityId: a?.id,
            newValue: { code: a?.code, name: input.name, category: input.category, purchaseValue: input.purchaseValue },
          });
          return a;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue;
          throw e;
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إنشاء الأصل" });
    }),

  // FI-02: ترحيل إهلاك شهر (تشغيل يدويّ أو عبر مهمة دورية) — assets/FULL + تدقيق. idempotent.
  postDepreciation: assetWrite
    .input(z.object({ year: z.number().int().min(2000).max(2200), month: z.number().int().min(1).max(12) }))
    .mutation(async ({ input, ctx }) => {
      const res = await svc.postMonthlyDepreciation(input.year, input.month, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 0,
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "asset.depreciation.post",
        entityType: "fixedAsset",
        newValue: { period: res.period, assetsPosted: res.assetsPosted, totalDepreciation: res.totalDepreciation },
      });
      return res;
    }),

  update: assetWrite
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1, "اسم الأصل مطلوب"),
        category: categoryEnum,
        brand: z.string().trim().optional(),
        serial: z.string().trim().optional(),
        branchId: z.number().int().positive().optional(),
        location: z.string().trim().optional(),
        supplierId: z.number().int().positive().optional(),
        purchaseDate: z.string().min(1),
        purchaseValue: moneyStr,
        salvageValue: moneyStrOpt,
        usefulLifeYears: z.number().int().positive().max(100),
        depreciationMethod: methodEnum.default("sl"),
        condition: z.string().trim().optional(),
        warrantyEnd: z.string().optional(),
      }).refine(
        (d) => {
          const re = /^\d+(\.\d{1,2})?$/;
          if (!re.test(d.purchaseValue) || (d.salvageValue && !re.test(d.salvageValue))) return true;
          return money(d.salvageValue ?? "0").lte(money(d.purchaseValue));
        },
        { message: "القيمة التخريدية يجب ألا تتجاوز قيمة الشراء", path: ["salvageValue"] },
      ),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...patch } = input;
      const a = await svc.updateAsset(id, patch, { userId: ctx.user.id, branchId: Number(ctx.user.branchId ?? 0), role: ctx.user.role });
      await logAudit(ctx, {
        action: "asset.update",
        entityType: "fixedAsset",
        entityId: id,
        newValue: { name: input.name, category: input.category, purchaseValue: input.purchaseValue },
      });
      return a;
    }),

  handover: assetWrite
    .input(
      z.object({
        assetId: z.number().int().positive(),
        employeeId: z.number().int().positive(),
        note: z.string().trim().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const a = await svc.handoverCustody(input.assetId, input.employeeId, input.note);
      await logAudit(ctx, { action: "asset.handover", entityType: "fixedAsset", entityId: input.assetId, newValue: { employeeId: input.employeeId } });
      return a;
    }),

  addMaintenance: assetWrite
    .input(
      z.object({
        assetId: z.number().int().positive(),
        type: z.string().trim().min(1, "نوع الصيانة مطلوب"),
        vendor: z.string().trim().optional(),
        cost: moneyStrOpt,
        note: z.string().trim().optional(),
        maintDate: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const a = await svc.addMaintenance(input.assetId, input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "asset.maintenance", entityType: "fixedAsset", entityId: input.assetId, newValue: { type: input.type, cost: input.cost ?? "0" } });
      return a;
    }),

  returnFromMaintenance: assetWrite
    .input(z.object({ assetId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const a = await svc.returnFromMaintenance(input.assetId);
      await logAudit(ctx, { action: "asset.return", entityType: "fixedAsset", entityId: input.assetId });
      return a;
    }),

  dispose: assetWrite
    .input(
      z.object({
        assetId: z.number().int().positive(),
        kind: z.enum(["retired", "disposed"]),
        date: z.string().min(1),
        reason: z.string().trim().optional(),
        value: moneyStrOpt,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.kind === "disposed" && !input.value) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "أدخل قيمة العائد عند الاستبعاد ببيع/خردة (صفر إن بلا عائد)." });
      }
      const a = await svc.disposeAsset(input.assetId, input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0, role: ctx.user.role });
      await logAudit(ctx, { action: "asset.dispose", entityType: "fixedAsset", entityId: input.assetId, newValue: { kind: input.kind, value: input.value ?? null } });
      return a;
    }),

  // مستندات الأصل: رفع صورة (data URL مضغوطة، حدّ الجسم ٣mb في server/index.ts) وحذفها. القراءة
  // عبر assets.get (a.docs). كلٌّ assetWrite (assets/FULL) + تدقيق.
  addDocument: assetWrite
    .input(
      z.object({
        assetId: z.number().int().positive(),
        title: z.string().trim().min(1, "عنوان المستند مطلوب").max(255),
        dataUrl: z.string().min(1).max(3_500_000),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const doc = await svc.addAssetDocument(input.assetId, { title: input.title, dataUrl: input.dataUrl });
      await logAudit(ctx, { action: "asset.document.add", entityType: "fixedAsset", entityId: input.assetId, newValue: { title: input.title } });
      return doc;
    }),

  deleteDocument: assetWrite
    .input(z.object({ docId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await svc.deleteAssetDocument(input.docId);
      await logAudit(ctx, { action: "asset.document.delete", entityType: "fixedAsset", entityId: res.assetId, oldValue: { docId: input.docId } });
      return res;
    }),
});
