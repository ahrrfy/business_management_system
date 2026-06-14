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
import { protectedProcedure, requireModule, router } from "../trpc";

const assetRead = protectedProcedure.use(requireModule("assets", "READ"));
const assetWrite = protectedProcedure.use(requireModule("assets", "FULL"));

const categoryEnum = z.enum(ASSET_CATEGORY_KEYS);
const statusEnum = z.enum(ASSET_STATUS_KEYS);
const methodEnum = z.enum(DEPRECIATION_METHOD_KEYS);
const moneyStr = z.string().trim().min(1);

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
        salvageValue: z.string().trim().optional(),
        usefulLifeYears: z.number().int().positive().max(100),
        depreciationMethod: methodEnum.default("sl"),
        condition: z.string().trim().optional(),
        warrantyEnd: z.string().optional(),
        linkedDeviceId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const a = await svc.createAsset(input);
      await logAudit(ctx, {
        action: "asset.create",
        entityType: "fixedAsset",
        entityId: a?.id,
        newValue: { code: a?.code, name: input.name, category: input.category, purchaseValue: input.purchaseValue },
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
        cost: z.string().trim().optional(),
        note: z.string().trim().optional(),
        maintDate: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const a = await svc.addMaintenance(input.assetId, input);
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
        value: z.string().trim().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.kind === "disposed" && !input.value) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "أدخل قيمة العائد عند الاستبعاد ببيع/خردة (صفر إن بلا عائد)." });
      }
      const a = await svc.disposeAsset(input.assetId, input);
      await logAudit(ctx, { action: "asset.dispose", entityType: "fixedAsset", entityId: input.assetId, newValue: { kind: input.kind, value: input.value ?? null } });
      return a;
    }),
});
