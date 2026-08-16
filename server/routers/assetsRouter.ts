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
import { companyBranchScope } from "../services/companyBranchScope";
import { money } from "../services/money";
import type { Actor } from "../services/tx";
import type { AuthUser } from "../context";
import { protectedProcedure, requireModule, router } from "../trpc";
import { isDupEntry } from "@shared/errorMap.ar";
import {
  approveAccrualCorrection,
  listAccrualCorrections,
  rejectAccrualCorrection,
  requestAccrualCorrection,
} from "../services/accounting/accrualCorrection";

const assetRead = protectedProcedure.use(requireModule("assets", "READ"));
const assetWrite = protectedProcedure.use(requireModule("assets", "FULL"));

const categoryEnum = z.enum(ASSET_CATEGORY_KEYS);
const statusEnum = z.enum(ASSET_STATUS_KEYS);
const methodEnum = z.enum(DEPRECIATION_METHOD_KEYS);
// مبلغ مالي: رقم موجب بمنزلتين عشريتين كحدّ أقصى (يصدّ NaN/السالب/الفواصل قبل بلوغ القاعدة).
const moneyStr = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "قيمة مالية غير صالحة (رقم موجب بمنزلتين كحدّ أقصى)");
const moneyStrOpt = moneyStr.optional();

function actorOf(user: AuthUser): Actor {
  const scope = companyBranchScope(user);
  return {
    userId: user.id,
    branchId: scope.branchId ?? 0,
    role: user.role,
    isOwner: user.isOwner === true,
  };
}

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
    .query(({ input, ctx }) => svc.listAssets(input, companyBranchScope(ctx.user))),

  get: assetRead.input(z.object({ id: z.number().int().positive() })).query(async ({ input, ctx }) => {
    const asset = await svc.getAsset(input.id, companyBranchScope(ctx.user));
    if (!asset) throw new TRPCError({ code: "NOT_FOUND", message: "الأصل غير موجود" });
    return asset;
  }),

  dashboard: assetRead.query(({ ctx }) => svc.dashboard(companyBranchScope(ctx.user))),
  custodyReport: assetRead.query(({ ctx }) => svc.custodyReport(companyBranchScope(ctx.user))),
  disposalLog: assetRead.query(({ ctx }) => svc.disposalLog(companyBranchScope(ctx.user))),
  formOptions: assetRead.query(({ ctx }) => svc.formOptions(companyBranchScope(ctx.user))),

  requestSupplierSettlement: assetWrite
    .input(z.object({ assetId: z.number().int().positive(), clientRequestId: z.string().trim().min(8).max(64) }))
    .mutation(({ input, ctx }) => svc.requestSupplierAssetSettlement(input, actorOf(ctx.user))),

  acquisitionCorrections: assetRead
    .input(z.object({ assetId: z.number().int().positive(), obligationId: z.number().int().positive() }))
    .query(({ input, ctx }) =>
      listAccrualCorrections(input.obligationId, actorOf(ctx.user), input.assetId),
    ),

  requestAcquisitionCorrection: assetWrite
    .input(
      z.object({
        assetId: z.number().int().positive(),
        obligationId: z.number().int().positive(),
        reason: z.string().trim().min(3).max(2000),
        externalEvidenceReference: z.string().trim().min(1).max(191),
        attachmentUrl: z.string().trim().min(1).max(8_000_000),
        refundPaymentMethod: z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]).nullish(),
        refundCashBucket: z.enum(["DRAWER", "TREASURY"]).nullish(),
        refundReferenceNumber: z.string().trim().max(100).nullish(),
        refundCardLastFour: z.string().trim().regex(/^\d{4}$/).nullish(),
        clientRequestId: z.string().trim().min(8).max(64),
      }),
    )
    .mutation(({ input, ctx }) =>
      requestAccrualCorrection(
        { ...input, expectedAssetId: input.assetId },
        actorOf(ctx.user),
      ),
    ),

  approveAcquisitionCorrection: assetWrite
    .input(z.object({ assetId: z.number().int().positive(), correctionRequestId: z.number().int().positive() }))
    .mutation(({ input, ctx }) =>
      approveAccrualCorrection(
        input.correctionRequestId,
        actorOf(ctx.user),
        new Date(),
        input.assetId,
      ),
    ),

  rejectAcquisitionCorrection: assetWrite
    .input(
      z.object({
        assetId: z.number().int().positive(),
        correctionRequestId: z.number().int().positive(),
        reason: z.string().trim().min(3).max(255),
      }),
    )
    .mutation(({ input, ctx }) =>
      rejectAccrualCorrection(
        input.correctionRequestId,
        input.reason,
        actorOf(ctx.user),
        new Date(),
        input.assetId,
      ),
    ),

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
        acquisitionBeneficiaryName: z.string().trim().min(2).max(200).optional(),
        acquisitionEvidenceReference: z.string().trim().min(1).max(191),
        clientRequestId: z.string().trim().min(8).max(64),
      }).refine(
        (d) => {
          const re = /^\d+(\.\d{1,2})?$/;
          if (!re.test(d.purchaseValue) || (d.salvageValue && !re.test(d.salvageValue))) return true; // الحقول تتكفّل بخطأ الصيغة
          return money(d.salvageValue ?? "0").lte(money(d.purchaseValue));
        },
        { message: "القيمة التخريدية يجب ألا تتجاوز قيمة الشراء", path: ["salvageValue"] },
      ).refine(
        (d) => {
          const re = /^\d+(\.\d{1,2})?$/;
          if (!re.test(d.purchaseValue)) return true; // الصيغة تتكفّل بخطأ الشكل
          return money(d.purchaseValue).gt(0);
        },
        { message: "قيمة الشراء يجب أن تكون أكبر من صفر", path: ["purchaseValue"] },
      ),
    )
    .mutation(async ({ input, ctx }) => {
      // قيد UNIQUE على code هو الحارس النهائي لترقيم AST تحت FOR UPDATE ⇒ أعد المحاولة على التضارب.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const a = await svc.createAsset(input, actorOf(ctx.user));
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
      const res = await svc.postMonthlyDepreciation(input.year, input.month, actorOf(ctx.user));
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
      const a = await svc.updateAsset(id, patch, actorOf(ctx.user));
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
      const a = await svc.handoverCustody(input.assetId, input.employeeId, input.note, actorOf(ctx.user));
      await logAudit(ctx, { action: "asset.handover", entityType: "fixedAsset", entityId: input.assetId, newValue: { employeeId: input.employeeId } });
      return a;
    }),

  returnCustody: assetWrite
    .input(z.object({ assetId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const asset = await svc.returnCustody(input.assetId, actorOf(ctx.user));
      await logAudit(ctx, {
        action: "asset.custody.return",
        entityType: "fixedAsset",
        entityId: input.assetId,
      });
      return asset;
    }),

  addMaintenance: assetWrite
    .input(
      z.object({
        assetId: z.number().int().positive(),
        type: z.string().trim().min(1, "نوع الصيانة مطلوب"),
        vendor: z.string().trim().optional(),
        vendorSupplierId: z.number().int().positive().optional(),
        cost: moneyStrOpt,
        evidenceReference: z.string().trim().max(191).optional(),
        clientRequestId: z.string().trim().min(8).max(64),
        note: z.string().trim().optional(),
        maintDate: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const a = await svc.addMaintenance(input.assetId, input, actorOf(ctx.user));
      await logAudit(ctx, { action: "asset.maintenance", entityType: "fixedAsset", entityId: input.assetId, newValue: { type: input.type, cost: input.cost ?? "0" } });
      return a;
    }),

  returnFromMaintenance: assetWrite
    .input(z.object({ assetId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const a = await svc.returnFromMaintenance(input.assetId, actorOf(ctx.user));
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
      const a = await svc.disposeAsset(input.assetId, input, actorOf(ctx.user));
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
      const doc = await svc.addAssetDocument(input.assetId, { title: input.title, dataUrl: input.dataUrl }, actorOf(ctx.user));
      await logAudit(ctx, { action: "asset.document.add", entityType: "fixedAsset", entityId: input.assetId, newValue: { title: input.title } });
      return doc;
    }),

  deleteDocument: assetWrite
    .input(z.object({ docId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await svc.deleteAssetDocument(input.docId, actorOf(ctx.user));
      await logAudit(ctx, { action: "asset.document.delete", entityType: "fixedAsset", entityId: res.assetId, oldValue: { docId: input.docId } });
      return res;
    }),
});
